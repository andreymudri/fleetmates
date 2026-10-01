import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CARD_COPY } from '../../components/SessionCard.jsx'
import { CrewAvatar } from '../../components/CrewAvatar.jsx'
import { pillParams, shown, stateLabel, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { launchSession } from '../../state/actions.js'
import { isRoute, matchRoute } from '../../state/deck-store.js'
import { deckApi, repoFor, trapTab } from '../drawer/NeedsYouDrawer.jsx'
import { matchesQuery, moveActive } from '../palette/Palette.jsx'

/** English copy for the New session form (docs/deck/screens/new-session.md section 9). */
export const NEW_SESSION_COPY = Object.freeze({
  'newSession.title': 'Launch a ship',
  'newSession.subtitle': 'Pick a repo and say what to do. The session starts in its own terminal and shows up on the Sessions grid.',
  'newSession.repo': 'Repo',
  'newSession.repo.placeholder': 'Search repos in {root}',
  'newSession.repo.recent': 'Recent harbors',
  'newSession.repo.active': '{n} active',
  'newSession.repo.active.a11y': '{n, plural, one {# active session} other {# active sessions}}',
  'newSession.repo.error': 'Pick a repo.',
  'newSession.repo.empty': 'No git repos found in {root}.',
  'newSession.repo.changeRoot': 'Change the repos folder',
  'newSession.repo.noMatch': 'No repo matches "{q}".',
  'newSession.repo.rootMissing': 'The repos folder {root} does not exist.',
  'newSession.fixInSettings': 'Fix in Settings',
  'newSession.conflict': '{repo} already has an active session: {sessions}. Two plain sessions share one working tree, so their changes mix.',
  'newSession.conflict.session': '{repo} · {task} ({state})',
  'newSession.conflict.more': 'and {n} more',
  'newSession.conflict.fleetmates': 'Run as a fleetmates job',
  'newSession.conflict.open': 'Open {repo} · {task}',
  'newSession.task': 'Task',
  'newSession.task.hint': 'optional',
  'newSession.task.placeholder': 'What should Claude do? Leave empty to start at the prompt.',
  'newSession.footer': 'Runs claude in {path} · you can type in the terminal or here',
  'newSession.cancel': 'Cancel',
  'newSession.launch': 'Launch a ship',
  'newSession.deckdDown': 'deckd is reconnecting. Launching needs deckd.',
  'newSession.noHooks': 'Observation hooks are not installed, so the deck will only see this session through its terminal.',
  'newSession.spawnError': 'Could not start claude in {repo}: {message}.'
})

/** sessionStorage key of the cancelled form's draft. */
export const DRAFT_KEY = 'deck.newSession'
/** How long a cancelled draft is restored, in ms (new-session.md section 6). */
export const DRAFT_TTL_MS = 10 * 60_000
/** Repos in the "Recent harbors" group. */
export const RECENT_MAX = 5

const SETTINGS_CONNECTIONS = '/settings/connections'
const ids = {
  title: 'new-session-title', subtitle: 'new-session-subtitle', repo: 'new-session-repo', list: 'new-session-list',
  repoError: 'new-session-repo-error', task: 'new-session-task', reason: 'new-session-launch-reason'
}
const optionId = index => `new-session-opt-${index}`
const focusHref = id => `/s/${encodeURIComponent(id)}`
const keyOf = repo => repo.repoKey ?? repo.name

/**
 * A home-relative display of an absolute path: `/home/<user>` or `/Users/<user>` becomes `~`.
 * @param {unknown} value
 * @returns {string}
 */
export function tildePath(value) {
  return String(value ?? '').replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')
}

/**
 * The other live plain sessions in a repo (D-68): role `solo`, alive and not `ended`, in store order.
 * @param {object[]} sessions
 * @param {string} repoId
 * @returns {object[]}
 */
export function conflictSessions(sessions, repoId) {
  return (sessions ?? []).filter(row => row.repoId === repoId && row.role === 'solo' && row.alive !== false && row.state !== 'ended')
}

/**
 * The repo combobox options: on an empty query the {@link RECENT_MAX} repos with the newest `lastSessionAt`
 * under "Recent harbors", then the rest alphabetically; with a query, the repos whose name, `~` path or branch
 * match it (`matchesQuery`: substring or word prefix), alphabetically. Archived repos are left out.
 * @param {object} state deck store state
 * @param {string} query
 * @param {Function} [t]
 * @returns {{ groups: { id: 'recent' | 'all', label: string | null, rows: object[] }[], rows: object[] }}
 */
export function repoOptions(state, query, t) {
  const repos = (state.data?.repos ?? []).filter(repo => !repo.archivedAt)
  const sessions = state.data?.sessions ?? []
  const alpha = (a, b) => String(a.name).localeCompare(String(b.name))
  const row = repo => ({ key: repo.id, repo, path: tildePath(repo.id), active: conflictSessions(sessions, repo.id).length })
  const groups = []
  if (!String(query ?? '').trim()) {
    const recent = repos.filter(repo => Number.isFinite(repo.lastSessionAt))
      .sort((a, b) => b.lastSessionAt - a.lastSessionAt || alpha(a, b)).slice(0, RECENT_MAX)
    const rest = repos.filter(repo => !recent.includes(repo)).sort(alpha)
    if (recent.length) groups.push({ id: 'recent', label: translate(t, NEW_SESSION_COPY, 'newSession.repo.recent'), rows: recent.map(row) })
    if (rest.length) groups.push({ id: 'all', label: null, rows: rest.map(row) })
  } else {
    const found = repos.filter(repo => matchesQuery(query, [repo.name, tildePath(repo.id), repo.branch])).sort(alpha)
    if (found.length) groups.push({ id: 'all', label: null, rows: found.map(row) })
  }
  const rows = groups.flatMap(group => group.rows)
  rows.forEach((item, index) => { item.index = index })
  return { groups, rows }
}

function findRepo(state, repoKey) {
  if (!repoKey) return null
  return (state.data?.repos ?? []).find(repo => !repo.archivedAt && keyOf(repo) === repoKey) ?? null
}

/**
 * Read the cancelled form's draft; null when there is none, it is unreadable, or its `savedAt` is missing or
 * older than {@link DRAFT_TTL_MS}.
 * @param {Storage | undefined} storage
 * @param {number} now
 * @returns {{ repo: string | null, task: string, savedAt: number } | null}
 */
export function readDraft(storage, now) {
  try {
    const draft = JSON.parse(storage?.getItem(DRAFT_KEY) ?? 'null')
    if (!draft || !Number.isFinite(draft.savedAt)) return null
    const age = now - draft.savedAt
    if (age < 0 || age > DRAFT_TTL_MS) return null
    return { repo: typeof draft.repo === 'string' ? draft.repo : null, task: typeof draft.task === 'string' ? draft.task : '', savedAt: draft.savedAt }
  } catch {
    return null
  }
}

/**
 * Keep the form's repo and task in sessionStorage `deck.newSession` with the time they were saved.
 * @param {Storage | undefined} storage
 * @param {{ repo: string | null, task: string }} draft
 * @param {number} now
 */
export function writeDraft(storage, { repo, task }, now) {
  try { storage?.setItem(DRAFT_KEY, JSON.stringify({ repo: repo ?? null, task: task ?? '', savedAt: now })) } catch {}
}

/**
 * Drop the saved draft.
 * @param {Storage | undefined} storage
 */
export function clearDraft(storage) {
  try { storage?.removeItem(DRAFT_KEY) } catch {}
}

/**
 * The form's first state: `?repo=` preselects a known repo and `?task=` prefills Task; without either, a draft
 * from {@link readDraft} is restored. Focus starts on Task when a repo is selected, else on Repo.
 * @param {{ search?: string, state: object, draft?: { repo: string | null, task: string } | null }} options
 * @returns {{ query: string, repoKey: string | null, task: string, focus: 'repo' | 'task', open: boolean, active: number, submitting: boolean, error: null, fieldError: null, rootMissing: boolean }}
 */
export function initialForm({ search = '', state, draft = null }) {
  let params
  try { params = new URLSearchParams(String(search ?? '')) } catch { params = new URLSearchParams() }
  const fromQuery = params.has('repo') || params.has('task')
  const wanted = fromQuery ? params.get('repo') : draft?.repo ?? null
  const task = fromQuery ? params.get('task') ?? '' : draft?.task ?? ''
  const repo = findRepo(state, wanted)
  return {
    query: repo ? repo.name : wanted ?? '', repoKey: repo ? keyOf(repo) : null, task, focus: repo ? 'task' : 'repo', open: !repo,
    active: -1, submitting: false, error: null, fieldError: null, rootMissing: false
  }
}

/**
 * Keys the dialog handles itself: `Alt Enter` submits (Enter alone is a new line in Task), Esc cancels.
 * @param {{ key: string, altKey: boolean, ctrlKey: boolean, metaKey: boolean }} event
 * @returns {{ type: 'submit' } | { type: 'cancel' } | null}
 */
export function formKey(event) {
  if (event.ctrlKey || event.metaKey) return null
  if (event.key === 'Escape' && !event.altKey) return { type: 'cancel' }
  if (event.key === 'Enter' && event.altKey) return { type: 'submit' }
  return null
}

/**
 * The route the form returns to on close: `history.state.from` when it names a known route other than `/new`,
 * else Home.
 * @param {{ from?: unknown } | null | undefined} historyState
 * @returns {string}
 */
export function returnRoute(historyState) {
  const from = historyState?.from
  return isRoute(from) && matchRoute(from).name !== 'new' ? from : '/'
}

function launchMessage(error) {
  const stderr = typeof error?.details?.stderr === 'string' ? error.details.stderr.trim() : ''
  return (stderr || String(error?.message ?? error?.code ?? 'failed')).replace(/[.\s]+$/, '')
}

/**
 * Launch from the form (`POST /api/sessions`, `U.Launch`): no repo is a field error and posts nothing; a
 * `fleetmates` job needs a task. A plain launch posts `{ repoKey, task }`, a job adds `mode: 'fleetmates'`.
 * On 201 the draft is cleared and the route is replaced with the new session's Focus (NEW-O5); any error is
 * returned with its code and message (`details.stderr` for `spawn_failed`).
 * @param {{ api: { post: Function }, repoKey: string | null, task: string, mode?: 'plain' | 'fleetmates', navigate: (to: string, options?: { replace?: boolean }) => void, storage?: Storage }} options
 * @returns {Promise<{ ok: true, id: string } | { fieldError: 'repo' | 'task' } | { error: { code: string, message: string } }>}
 */
export async function submitLaunch({ api, repoKey, task, mode = 'plain', navigate, storage }) {
  if (!repoKey) return { fieldError: 'repo' }
  const text = String(task ?? '')
  if (mode === 'fleetmates' && !text.trim()) return { fieldError: 'task' }
  const body = mode === 'fleetmates' ? { repoKey, task: text, mode } : { repoKey, task: text }
  let data
  try {
    data = await launchSession(api, body)
  } catch (error) {
    return { error: { code: String(error?.code ?? 'internal'), message: launchMessage(error) } }
  }
  const id = data?.session?.id
  clearDraft(storage)
  navigate(focusHref(id), { replace: true })
  return { ok: true, id }
}

/**
 * Whether the scan root is missing: a rescan that fails with `settings_io_failed` (the server cannot read the
 * root). Any other answer, success included, reads as present.
 * @param {{ post: Function }} api
 * @returns {Promise<boolean>}
 */
export function probeScanRoot(api) {
  return api.post('/api/repos/rescan').then(() => false, error => error?.code === 'settings_io_failed')
}

/** Whether the snapshot's `hooks` health row says the observation hooks are not usable. */
function hooksMissing(state) {
  const row = (state.data?.health ?? []).find(item => item.dep === 'hooks')
  return !!row && row.state !== 'ok'
}

function Option({ row, active, t, onPick, onHover }) {
  const tr = (key, params) => translate(t, NEW_SESSION_COPY, key, params)
  const { repo } = row
  const name = shown(repo.name)
  const path = shown(row.path)
  const label = [name, path, row.active ? tr('newSession.repo.active.a11y', { n: row.active }) : null].filter(Boolean).join(', ')
  return (
    <li id={optionId(row.index)} role="option" aria-selected={row.index === active ? 'true' : 'false'} aria-label={label} className="launch-option"
      onMouseDown={event => event.preventDefault()} onClick={() => onPick?.(row)} onMouseMove={() => onHover?.(row.index)}>
      <CrewAvatar seed={repo.crew?.seed ?? repo.name} slot={repo.crew?.slot ?? undefined} hat={repo.crew?.hat ?? 'none'} pose="none" size="sm" />
      <span className="launch-option-text">
        <span className="launch-option-name"><bdi>{name}</bdi></span>
        <span className="launch-option-path">{repo.branch ? `${path} · ${shown(repo.branch)}` : path}</span>
      </span>
      {row.active ? <span className="launch-option-active">{tr('newSession.repo.active', { n: row.active })}</span> : null}
    </li>
  )
}

function RepoList({ state, form, model, root, t, onPick, onHover, onLink }) {
  const tr = (key, params) => translate(t, NEW_SESSION_COPY, key, params)
  if (!state.loaded) {
    return (
      <ul className="launch-list" id={ids.list} role="listbox" aria-label={tr('newSession.repo')} aria-busy="true">
        {[0, 1, 2, 3].map(index => <li key={index} className="launch-option launch-option--skeleton" aria-hidden="true"><span className="skeleton-line" /></li>)}
      </ul>
    )
  }
  const known = (state.data?.repos ?? []).some(repo => !repo.archivedAt)
  if (!known) {
    if (form.rootMissing) return null
    return (
      <p className="launch-list-empty">
        {tr('newSession.repo.empty', { root })}{' '}
        <a href={SETTINGS_CONNECTIONS} onClick={linkHandler(onLink, SETTINGS_CONNECTIONS)}>{tr('newSession.repo.changeRoot')}</a>
      </p>
    )
  }
  if (!model.rows.length) return <p className="launch-list-empty">{tr('newSession.repo.noMatch', { q: shown(form.query) })}</p>
  return (
    <ul className="launch-list" id={ids.list} role="listbox" aria-label={tr('newSession.repo')}>
      {model.groups.map(group => group.label ? (
        <li key={group.id} role="presentation" className="launch-group">
          <p className="eyebrow launch-group-title" id={`new-session-group-${group.id}`}>{group.label}</p>
          <ul role="group" aria-labelledby={`new-session-group-${group.id}`} className="launch-group-rows">
            {group.rows.map(row => <Option key={row.key} row={row} active={form.active} t={t} onPick={onPick} onHover={onHover} />)}
          </ul>
        </li>
      ) : group.rows.map(row => <Option key={row.key} row={row} active={form.active} t={t} onPick={onPick} onHover={onHover} />))}
    </ul>
  )
}

function Conflict({ repo, others, now, t, busy, onFleetmates, onOpenSession }) {
  const tr = (key, params) => translate(t, NEW_SESSION_COPY, key, params)
  const name = shown(repo.name)
  const untitled = translate(t, CARD_COPY, 'home.card.untitled')
  const label = row => tr('newSession.conflict.session', { repo: name, task: titleText(row.task || untitled), state: stateLabel(row.state, pillParams(row, now), t) })
  const named = others.slice(0, 2).map(label).join(', ')
  const rest = others.length - 2
  const sessions = rest > 0 ? `${named} ${tr('newSession.conflict.more', { n: rest })}` : named
  const first = others[0]
  return (
    <div className="launch-banner launch-banner--hint" role="status">
      <p className="launch-banner-text"><bdi>{tr('newSession.conflict', { repo: name, sessions })}</bdi></p>
      <div className="launch-banner-actions">
        <button type="button" className="button button--teal-outline button--sm" disabled={busy} onClick={() => onFleetmates?.()}>{tr('newSession.conflict.fleetmates')}</button>
        <a className="launch-banner-link" href={focusHref(first.id)} onClick={linkHandler(() => onOpenSession?.(first.id), focusHref(first.id))}>
          <bdi>{tr('newSession.conflict.open', { repo: name, task: titleText(first.task || untitled) })}</bdi>
        </a>
      </div>
    </div>
  )
}

/**
 * The New session dialog, pure (new-session.md sections 3 to 5): title and subtitle, the spawn error and scan
 * root banners, the hooks hint, the Repo combobox with its listbox, the same-repo banner (D-68), Task, and
 * the footer with Cancel and Launch. All repo names, paths and tasks are rendered as text.
 * @param {{
 *   state: object, form: ReturnType<typeof initialForm> & { error?: { code: string, message: string } | null, fieldError?: 'repo' | 'task' | null },
 *   t?: Function, now?: number, panelRef?: object, errorRef?: object, repoRef?: object, taskRef?: object,
 *   onQuery?: (value: string) => void, onComboKey?: Function, onPick?: (row: object) => void, onHover?: (index: number) => void,
 *   onTask?: (value: string) => void, onSubmit?: () => void, onFleetmates?: () => void, onCancel?: () => void,
 *   onOpenSession?: (id: string) => void, onLink?: (to: string) => void, onKeyDown?: Function
 * }} props
 */
export function NewSessionView({
  state, form, t, now = Date.now(), panelRef, errorRef, repoRef, taskRef, onQuery = () => {}, onComboKey, onPick, onHover, onTask = () => {},
  onSubmit, onFleetmates, onCancel, onOpenSession, onLink = () => {}, onKeyDown
}) {
  const tr = (key, params) => translate(t, NEW_SESSION_COPY, key, params)
  const root = shown(state.data?.prefs?.scanRoot ?? '~/dev')
  const model = repoOptions(state, form.query, t)
  const selected = findRepo(state, form.repoKey)
  const others = selected ? conflictSessions(state.data?.sessions, selected.id) : []
  const deckdDown = !!state.deckdOutage
  const busy = !!form.submitting
  const expanded = !!form.open && state.loaded && model.rows.length > 0
  const errorRepo = shown(selected?.name ?? repoFor(state.data?.repos, form.repoKey).name ?? form.repoKey ?? '')
  return (
    <div className="launch-scrim" onClick={event => { if (event.target === event.currentTarget) onCancel?.() }}>
      <div className="launch-dialog" role="dialog" aria-modal="true" aria-labelledby={ids.title} aria-describedby={ids.subtitle} ref={panelRef} onKeyDown={onKeyDown}>
        <header className="launch-header">
          <h2 className="launch-title" id={ids.title}>{tr('newSession.title')}</h2>
          <p className="launch-subtitle" id={ids.subtitle}>{tr('newSession.subtitle')}</p>
        </header>
        <div className="launch-body">
          {form.error ? (
            <div className="launch-banner launch-banner--error" role="alert" tabIndex={-1} ref={errorRef}>
              <p className="launch-banner-text"><bdi>{tr('newSession.spawnError', { repo: errorRepo, message: shown(form.error.message) })}</bdi></p>
            </div>
          ) : null}
          {form.rootMissing ? (
            <div className="launch-banner launch-banner--error" role="alert">
              <p className="launch-banner-text">{tr('newSession.repo.rootMissing', { root })}</p>
              <a className="launch-banner-link" href={SETTINGS_CONNECTIONS} onClick={linkHandler(onLink, SETTINGS_CONNECTIONS)}>{tr('newSession.fixInSettings')}</a>
            </div>
          ) : null}
          {hooksMissing(state) ? <div className="launch-banner launch-banner--hint" role="note"><p className="launch-banner-text">{tr('newSession.noHooks')}</p></div> : null}
          <div className="launch-field">
            <label className="launch-label" htmlFor={ids.repo}>{tr('newSession.repo')}</label>
            <input className="launch-input" id={ids.repo} type="text" role="combobox" data-initial-focus={form.focus === 'repo' ? 'true' : undefined}
              aria-expanded={expanded ? 'true' : 'false'} aria-controls={ids.list} aria-autocomplete="list"
              aria-activedescendant={expanded && form.active >= 0 ? optionId(form.active) : undefined}
              aria-invalid={form.fieldError === 'repo' ? 'true' : undefined} aria-describedby={form.fieldError === 'repo' ? ids.repoError : undefined}
              aria-required="true" autoComplete="off" spellCheck="false" placeholder={tr('newSession.repo.placeholder', { root })}
              value={form.query} readOnly={busy} ref={repoRef} onChange={event => onQuery(event.target.value)} onKeyDown={onComboKey} />
            {form.fieldError === 'repo' ? <p className="launch-field-error" id={ids.repoError}>{tr('newSession.repo.error')}</p> : null}
            {form.open || !state.loaded ? <RepoList state={state} form={form} model={model} root={root} t={t} onPick={onPick} onHover={onHover} onLink={onLink} /> : null}
          </div>
          {selected && others.length ? <Conflict repo={selected} others={others} now={now} t={t} busy={busy || deckdDown} onFleetmates={onFleetmates} onOpenSession={onOpenSession} /> : null}
          <div className="launch-field">
            <label className="launch-label" htmlFor={ids.task}>{tr('newSession.task')} <span className="launch-hint">{tr('newSession.task.hint')}</span></label>
            <textarea className="launch-textarea" id={ids.task} rows={4} data-initial-focus={form.focus === 'task' ? 'true' : undefined}
              placeholder={tr('newSession.task.placeholder')} value={form.task} readOnly={busy} ref={taskRef} onChange={event => onTask(event.target.value)} />
          </div>
        </div>
        <footer className="launch-footer">
          <p className="launch-note"><bdi>{tr('newSession.footer', { path: selected ? shown(tildePath(selected.id)) : root })}</bdi></p>
          <div className="launch-actions">
            <button type="button" className="button button--secondary button--lg" onClick={() => onCancel?.()}>{tr('newSession.cancel')}</button>
            <button type="button" className="button button--primary button--lg launch-submit" disabled={deckdDown} aria-busy={busy ? 'true' : undefined}
              aria-describedby={deckdDown ? ids.reason : undefined} onClick={() => { if (!busy) onSubmit?.() }}>
              {tr('newSession.launch')} <kbd className="kbd kbd--on-primary" aria-hidden="true">Alt Enter</kbd>
            </button>
          </div>
          {deckdDown ? <p className="launch-reason" id={ids.reason}>{tr('newSession.deckdDown')}</p> : null}
        </footer>
      </div>
    </div>
  )
}

/**
 * The `/new` route screen: {@link NewSessionView} over the route it was opened from (`history.state.from`, else
 * Home), rendered inert beneath it when `screens` has that route. Holds the form state, the combobox keys,
 * `Alt Enter` and Esc, and the initial focus; Esc and Cancel keep a draft for {@link DRAFT_TTL_MS}. Browser
 * wiring; the pure view and the exported functions carry the tested behaviour.
 * @param {{ search?: string, state: object, t?: Function, navigate: (to: string, options?: { replace?: boolean }) => void, api?: object,
 *   screens?: Record<string, Function>, storage?: Storage, history?: History }} props
 */
export function NewSession({ search = globalThis.location?.search ?? '', state, t, navigate, api, screens, storage = globalThis.sessionStorage, history = globalThis.history }) {
  const client = api ?? deckApi()
  const [form, setForm] = useState(() => initialForm({ search, state, draft: readDraft(storage, Date.now()) }))
  const update = patch => setForm(current => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }))
  const panel = useRef(null)
  const errorRef = useRef(null)
  const repoRef = useRef(null)
  const taskRef = useRef(null)
  const from = useMemo(() => returnRoute(history?.state), [history])
  const model = repoOptions(state, form.query, t)
  const known = (state.data?.repos ?? []).some(repo => !repo.archivedAt)

  useEffect(() => {
    const opener = globalThis.document?.activeElement
    panel.current?.querySelector('[data-initial-focus="true"]')?.focus()
    return () => opener?.focus?.()
  }, [])
  useEffect(() => { if (form.error) errorRef.current?.focus() }, [form.error])
  useEffect(() => {
    if (!state.loaded || known) return undefined
    let live = true
    probeScanRoot(client).then(missing => { if (live) update({ rootMissing: missing }) })
    return () => { live = false }
  }, [state.loaded, known])

  const close = () => {
    if (history?.state?.from) history.back()
    else navigate(from, { replace: true })
  }
  const cancel = () => {
    writeDraft(storage, { repo: form.repoKey ?? (form.query || null), task: form.task }, Date.now())
    close()
  }
  const pick = row => {
    update({ repoKey: keyOf(row.repo), query: row.repo.name, open: false, active: -1, fieldError: null })
    taskRef.current?.focus()
  }
  const submit = (mode = 'plain') => {
    if (form.submitting || state.deckdOutage) return
    update({ submitting: true, error: null, fieldError: null })
    submitLaunch({ api: client, repoKey: form.repoKey, task: form.task, mode, navigate, storage }).then(result => {
      if (result.ok) return
      update({ submitting: false, error: result.error ?? null, fieldError: result.fieldError ?? null })
      if (result.fieldError === 'repo') repoRef.current?.focus()
      if (result.fieldError === 'task') taskRef.current?.focus()
    })
  }
  const onComboKey = event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      update(current => ({ open: true, active: moveActive(current.open ? current.active : -1, event.key === 'ArrowDown' ? 1 : -1, model.rows.length) }))
    } else if (event.key === 'Enter' && form.open && model.rows[form.active]) {
      event.preventDefault()
      pick(model.rows[form.active])
    }
  }
  const onKeyDown = event => {
    const action = formKey(event)
    if (!action) return trapTab(event, panel.current)
    event.preventDefault()
    event.stopPropagation()
    if (action.type === 'submit') submit()
    else cancel()
  }
  const Background = screens?.[matchRoute(from).name]
  return (
    <>
      {Background ? <div className="launch-background" inert aria-hidden="true"><Background route={matchRoute(from)} search="" state={state} t={t} navigate={navigate} /></div> : null}
      <NewSessionView state={state} form={form} t={t} panelRef={panel} errorRef={errorRef} repoRef={repoRef} taskRef={taskRef}
        onQuery={value => update(current => {
          const selected = findRepo(state, current.repoKey)
          return { query: value, open: true, active: 0, fieldError: null, repoKey: selected && selected.name === value ? current.repoKey : null }
        })}
        onComboKey={onComboKey} onPick={pick} onHover={index => update({ active: index })} onTask={value => update({ task: value })}
        onSubmit={() => submit()} onFleetmates={() => submit('fleetmates')} onCancel={cancel}
        onOpenSession={id => navigate(focusHref(id), { replace: true })} onLink={to => navigate(to)} onKeyDown={onKeyDown} />
    </>
  )
}
