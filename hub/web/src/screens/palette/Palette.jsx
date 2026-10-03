import React, { useEffect, useRef, useState } from 'react'
import { CARD_COPY, isArchived } from '../../components/SessionCard.jsx'
import { CrewAvatar, poseFor } from '../../components/CrewAvatar.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { StatusPill, compactDuration, pillParams, shown, titleText, translate } from '../../components/StatusPill.jsx'
import { archiveSession } from '../../state/actions.js'
import { matchRoute } from '../../state/deck-store.js'
import { closeOverlay, deckApi, leaveOverlay, repoFor, tierOf, trapTab } from '../drawer/NeedsYouDrawer.jsx'

/** English copy for the palette (docs/deck/screens/palette.md section 9): M1 plus the M2 launch actions. */
export const PALETTE_COPY = Object.freeze({
  'palette.input.label': 'Search, ask or run',
  'palette.group.needs': 'Needs you',
  'palette.group.sessions': 'Sessions',
  'palette.group.actions': 'Actions',
  'palette.needs.title': '{repo} · {summary}',
  'palette.needs.waiting': 'waiting {duration}',
  'palette.needs.answerInTerminal': 'Answer in your terminal',
  'palette.session.title': '{repo} · {detail}',
  'palette.action.markReviewed': 'Mark {repo} · {task} reviewed',
  'palette.action.launchIn': 'Launch a ship in {repo}',
  'palette.action.launchIn.sub': 'Recent harbor',
  'palette.action.launch': 'Launch a ship',
  'palette.action.archive': 'Archive session',
  'palette.command.unknown': 'No command named "{name}". Try research or launch.',
  'palette.group.showAll': 'Show all {n} {group}',
  'palette.group.showAll.needs': 'requests',
  'palette.group.showAll.sessions': 'sessions',
  'palette.group.showAll.actions': 'actions',
  'palette.footer.move': 'Up, Down or Alt J, Alt K move',
  'palette.footer.run': 'Enter run',
  'palette.footer.close': 'Esc close'
})

/** Rows a group shows before "Show all" (palette.md section 5). */
export const GROUP_MAX = 5
/** Recent harbors the empty query offers as launch rows (palette.md 4.1). */
export const RECENT_HARBORS = 3
/** Command names `>` knows (palette.md 4.2); `research` arrives in M6 and lists nothing before then. */
export const COMMANDS = Object.freeze(['launch', 'research'])

const URGENCY = { needs_approval: 0, asked_you: 1, crashed: 2, starting: 3, running: 3, done: 4, stale: 5, idle: 6, reviewed: 7, ended: 8 }
const NEEDS = new Set(['needs_approval', 'asked_you'])

/**
 * Sessions in urgency order (home.md 7.3): the server `order` first, then the local rank for any id the
 * order does not list yet (needs by oldest open request, else newest `stateSince`).
 * @param {object[]} sessions
 * @param {string[]} [order]
 * @param {object[]} [requests]
 * @returns {object[]}
 */
export function orderSessions(sessions, order = [], requests = []) {
  const position = new Map((order ?? []).map((id, index) => [id, index]))
  const oldest = new Map()
  for (const request of requests ?? []) {
    if ((request.state ?? 'open') !== 'open') continue
    oldest.set(request.sessionId, Math.min(oldest.get(request.sessionId) ?? Infinity, request.createdAt ?? Infinity))
  }
  return [...(sessions ?? [])].sort((a, b) => {
    const placed = (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity)
    if (placed) return placed
    const rank = (URGENCY[a.state] ?? 9) - (URGENCY[b.state] ?? 9)
    if (rank) return rank
    const age = NEEDS.has(a.state) ? (oldest.get(a.id) ?? Infinity) - (oldest.get(b.id) ?? Infinity) : (b.stateSince ?? 0) - (a.stateSince ?? 0)
    return age || String(a.id).localeCompare(String(b.id))
  })
}

/**
 * Case- and accent-insensitive form of a string (PAL-O2).
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Whether the query matches the fields: a substring of their joined text, or every query word is the
 * prefix of some word in them. An empty query matches everything.
 * @param {string} query
 * @param {unknown[]} fields
 * @returns {boolean}
 */
export function matchesQuery(query, fields) {
  const q = normalizeText(query).trim()
  if (!q) return true
  const text = fields.filter(field => field !== null && field !== undefined && field !== '').map(normalizeText).join(' ')
  if (text.includes(q)) return true
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return q.split(/\s+/).every(part => words.some(word => word.startsWith(part)))
}

/**
 * Known repos, newest first by `lastSessionAt`, else by their newest session's start in the snapshot; archived
 * repos and repos with neither are left out.
 * @param {object[]} repos
 * @param {object[]} sessions
 * @returns {object[]}
 */
export function recentRepos(repos = [], sessions = []) {
  const started = new Map()
  for (const row of sessions ?? []) {
    if (Number.isFinite(row.startedAt)) started.set(row.repoId, Math.max(started.get(row.repoId) ?? -Infinity, row.startedAt))
  }
  const at = repo => Number.isFinite(repo.lastSessionAt) ? repo.lastSessionAt : started.get(repo.id) ?? null
  return (repos ?? []).filter(repo => !repo.archivedAt && at(repo) !== null)
    .sort((a, b) => at(b) - at(a) || String(a.name).localeCompare(String(b.name)))
}

const repoKeyOf = repo => repo.repoKey ?? repo.name
const byName = (a, b) => String(a.name).localeCompare(String(b.name))

function launchRow(repo, t, sub = false) {
  if (!repo) return { kind: 'launch', group: 'actions', key: 'launch', repoKey: null, title: translate(t, PALETTE_COPY, 'palette.action.launch') }
  const repoKey = repoKeyOf(repo)
  const row = { kind: 'launch', group: 'actions', key: `launch-${repoKey}`, repoKey, repo: repoFor([repo], repo.id),
    title: translate(t, PALETTE_COPY, 'palette.action.launchIn', { repo: shown(repo.name) }) }
  if (sub) row.subtitle = translate(t, PALETTE_COPY, 'palette.action.launchIn.sub')
  return row
}

/**
 * Command mode (`>`, palette.md 4.2): `launch <repo>` lists a launch row per matching repo, the exact name
 * first; a prefix of a command name counts as that command; `research` lists nothing until M6; any other name
 * gives the "No command named" message.
 * @param {string} text the query after `>`
 * @param {object[]} repos
 * @param {Function} [t]
 * @returns {{ rows: object[], message: string | null }}
 */
export function commandRows(text, repos, t) {
  const [name = '', ...rest] = String(text).trim().split(/\s+/)
  const lower = normalizeText(name)
  if (!lower) return { rows: [], message: null }
  const command = COMMANDS.find(word => word.startsWith(lower))
  if (!command) return { rows: [], message: translate(t, PALETTE_COPY, 'palette.command.unknown', { name: shown(name) }) }
  if (command !== 'launch') return { rows: [], message: null }
  const arg = rest.join(' ')
  const exact = repo => normalizeText(repo.name) === normalizeText(arg) ? 0 : 1
  const found = (repos ?? []).filter(repo => !repo.archivedAt && matchesQuery(arg, [repo.name]))
  return { rows: found.sort((a, b) => exact(a) - exact(b) || byName(a, b)).map(repo => launchRow(repo, t)), message: null }
}

function finish(entries, expanded, t, message = null) {
  const groups = []
  const rows = []
  for (const [id, all] of entries) {
    if (!all.length) continue
    const open = expanded.includes(id)
    const visible = open ? all : all.slice(0, GROUP_MAX)
    const more = visible.length < all.length
      ? { kind: 'showAll', group: id, key: `more-${id}`, title: translate(t, PALETTE_COPY, 'palette.group.showAll', { n: all.length, group: translate(t, PALETTE_COPY, `palette.group.showAll.${id}`) }) }
      : null
    groups.push({ id, label: translate(t, PALETTE_COPY, `palette.group.${id}`), rows: visible, total: all.length, more })
    rows.push(...visible, ...(more ? [more] : []))
  }
  rows.forEach((row, index) => { row.index = index })
  return { groups, rows, active: rows.length ? 0 : -1, message }
}

/**
 * The palette result model for a query: the Needs you, Sessions and Actions groups in that order, each capped
 * at {@link GROUP_MAX} unless expanded, and the flat list of selectable rows. Archived sessions are left out.
 * Actions open with "Archive session" while `state.view.path` is the Focus route of a session that is not
 * archived. Then (palette.md 4.1): on an
 * empty query "Launch a ship" and "Launch a ship in {repo}" for the {@link RECENT_HARBORS} most recent repos;
 * with a query, a launch row per matching repo; then "Mark reviewed" for matching done sessions. A query
 * starting with `>` is command mode ({@link commandRows}); `message` carries its unknown-command line.
 * @param {object} state deck store state
 * @param {{ query?: string, now?: number, expanded?: string[], t?: (key: string, params?: object) => string }} [options]
 * @returns {{ groups: { id: string, label: string, rows: object[], total: number, more: object | null }[], rows: object[], active: number, message: string | null }}
 */
export function paletteModel(state, { query = '', now = Date.now(), expanded = [], t } = {}) {
  const { sessions = [], requests = [], repos = [], order = [] } = state.data
  const typed = String(query ?? '').trimStart()
  if (typed.startsWith('>')) {
    const command = commandRows(typed.slice(1), repos, t)
    return finish([['actions', command.rows]], expanded, t, command.message)
  }
  const live = orderSessions(sessions.filter(row => row.state !== 'ended' && !isArchived(row)), order, requests)
  const position = new Map(live.map((row, index) => [row.id, index + 1]))
  const byId = new Map(sessions.map(row => [row.id, row]))
  const untitled = translate(t, CARD_COPY, 'home.card.untitled')

  const needs = requests.filter(row => (row.state ?? 'open') === 'open')
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)))
    .flatMap(request => {
      const session = byId.get(request.sessionId)
      const repo = repoFor(repos, session?.repoId)
      if (!matchesQuery(query, [repo.name, request.summary, request.toolName, session?.task, session?.branch])) return []
      const tier = tierOf(request)
      const summary = tier === 'question' ? titleText(request.summary) : shown(request.summary)
      const subtitle = [translate(t, CARD_COPY, `tier.${tier}`), request.toolName ? shown(request.toolName) : null,
        translate(t, PALETTE_COPY, 'palette.needs.waiting', { duration: compactDuration(now - (request.createdAt ?? now)) }),
        translate(t, PALETTE_COPY, 'palette.needs.answerInTerminal')].filter(Boolean).join(' · ')
      return [{ kind: 'needs', group: 'needs', key: `needs-${request.id}`, requestId: request.id, sessionId: request.sessionId, tier, repo, session,
        title: translate(t, PALETTE_COPY, 'palette.needs.title', { repo: shown(repo.name), summary }), subtitle }]
    })

  const sessionRows = live.flatMap(session => {
    const repo = repoFor(repos, session.repoId)
    if (!matchesQuery(query, [repo.name, session.task, session.branch])) return []
    const detail = session.branch ? shown(session.branch) : titleText(session.task || untitled)
    const index = position.get(session.id)
    return [{ kind: 'session', group: 'sessions', key: `session-${session.id}`, sessionId: session.id, session, repo,
      title: translate(t, PALETTE_COPY, 'palette.session.title', { repo: shown(repo.name), detail }), kbd: index <= 9 ? `Alt ${index}` : undefined }]
  })

  const launches = typed.trim()
    ? (repos ?? []).filter(repo => !repo.archivedAt && matchesQuery(query, [repo.name])).sort(byName).map(repo => launchRow(repo, t))
    : [launchRow(null, t), ...recentRepos(repos, sessions).slice(0, RECENT_HARBORS).map(repo => launchRow(repo, t, true))]
  const reviews = live.filter(session => session.state === 'done').flatMap(session => {
    const repo = repoFor(repos, session.repoId)
    if (!matchesQuery(query, [repo.name, session.task, session.branch])) return []
    return [{ kind: 'review', group: 'actions', key: `review-${session.id}`, sessionId: session.id, session, repo,
      title: translate(t, PALETTE_COPY, 'palette.action.markReviewed', { repo: shown(repo.name), task: titleText(session.task || untitled) }) }]
  })

  // "Archive session" acts on the session Focus shows, while it is not archived.
  const route = matchRoute(state.view?.path ?? '/')
  const focused = route.name === 'focus' ? byId.get(route.params.sessionId) : null
  const archiveTitle = translate(t, PALETTE_COPY, 'palette.action.archive')
  const archives = focused && !isArchived(focused) && matchesQuery(query, [archiveTitle, repoFor(repos, focused.repoId).name, focused.task])
    ? [{ kind: 'archive', group: 'actions', key: `archive-${focused.id}`, sessionId: focused.id, session: focused, repo: repoFor(repos, focused.repoId), title: archiveTitle }]
    : []

  return finish([['needs', needs], ['sessions', sessionRows], ['actions', [...archives, ...launches, ...reviews]]], expanded, t)
}

/**
 * Keys the open palette handles itself (keyboard.md 3). Plain letters are typing and return null.
 * @param {{ code: string, key: string, altKey: boolean, ctrlKey: boolean, metaKey: boolean }} event
 * @returns {{ type: 'move', delta: 1 | -1 } | { type: 'run', terminal: boolean } | { type: 'close' } | null}
 */
export function paletteKey(event) {
  if (event.ctrlKey || event.metaKey) return null
  if (event.key === 'Escape') return { type: 'close' }
  if (event.key === 'ArrowDown') return { type: 'move', delta: 1 }
  if (event.key === 'ArrowUp') return { type: 'move', delta: -1 }
  if (event.altKey && event.code === 'KeyJ') return { type: 'move', delta: 1 }
  if (event.altKey && event.code === 'KeyK') return { type: 'move', delta: -1 }
  if (event.key === 'Enter') return { type: 'run', terminal: event.altKey }
  return null
}

/**
 * Move the highlight across all groups, wrapping at both ends.
 * @param {number} active
 * @param {number} delta
 * @param {number} count
 * @returns {number}
 */
export function moveActive(active, delta, count) {
  if (!count) return -1
  if (active < 0) return delta > 0 ? 0 : count - 1
  return ((active + delta) % count + count) % count
}

/**
 * Go to the new-session form and record where it was opened from as `history.state.from`, which the form
 * returns to on close (new-session.md). `env` is the window; without one only `navigate` runs.
 * @param {(to: string) => void} navigate
 * @param {string} [to] `/new`, or `/new?repo=<repoKey>`
 * @param {{ location: { pathname: string, search: string }, history: { replaceState: Function } } | undefined} [env]
 */
export function openLaunch(navigate, to = '/new', env = globalThis.window) {
  const from = env?.location ? env.location.pathname + env.location.search : null
  navigate(to)
  if (from && env.history) env.history.replaceState({ from }, '', env.location.pathname + env.location.search)
}

/**
 * Run a palette row. Session and Needs rows jump to Focus (answers arrive in M3); a launch row opens the
 * new-session form through {@link openLaunch}, with `?repo=<repoKey>` when it names a repo; a review action
 * marks the session reviewed; "Archive session" calls `archive` with the session id, then closes; "Show all"
 * expands its group.
 * @param {object} row
 * @param {{ navigate: (to: string) => void, leave: () => void, onClose: () => void, expand: (group: string) => void, api: { post: Function }, win?: object, archive?: (id: string) => Promise<unknown> }} env
 */
export async function runRow(row, { navigate, leave, onClose, expand, api, win, archive = id => archiveSession(api, id) }) {
  if (row.kind === 'session' || row.kind === 'needs') {
    leave()
    navigate(`/s/${encodeURIComponent(row.sessionId)}`)
  } else if (row.kind === 'launch') {
    leave()
    openLaunch(navigate, row.repoKey ? `/new?repo=${encodeURIComponent(row.repoKey)}` : '/new', win)
  } else if (row.kind === 'review') {
    await api.post(`/api/sessions/${encodeURIComponent(row.sessionId)}/mark-reviewed`)
    onClose()
  } else if (row.kind === 'archive') {
    await archive(row.sessionId)
    onClose()
  } else if (row.kind === 'showAll') expand(row.group)
}

function Option({ row, active, now, t, onRow, onHover }) {
  const selected = row.index === active
  const common = { id: `palette-opt-${row.index}`, role: 'option', 'aria-selected': selected ? 'true' : 'false', onClick: () => onRow?.(row), onMouseMove: () => onHover?.(row.index) }
  if (row.kind === 'showAll') {
    return <li className="palette-row palette-row--more" {...common}><span className="palette-row-title">{row.title}</span></li>
  }
  const pose = row.kind === 'needs' ? 'needs' : poseFor(row.session?.state ?? 'none')
  return (
    <li className={`palette-row palette-row--${row.kind}`} {...common}>
      {row.repo
        ? <CrewAvatar seed={row.repo.crewSeed} slot={row.repo.crewSlot} pose={row.kind === 'launch' ? 'idle' : pose} hat={row.repo.hat} size="sm" />
        : <span className="palette-glyph" aria-hidden="true">+</span>}
      <span className="palette-row-text">
        <span className="palette-row-title">{row.title}</span>
        {row.subtitle && (row.kind === 'needs' || row.kind === 'launch') ? <span className="palette-row-sub">{row.subtitle}</span> : null}
        {row.kind === 'session' ? <span className="palette-row-sub"><StatusPill state={row.session.state} params={pillParams(row.session, now)} role={row.session.role} variant="text" t={t} /></span> : null}
      </span>
      {row.kbd ? <kbd className="kbd" aria-hidden="true">{row.kbd}</kbd> : null}
    </li>
  )
}

/**
 * The palette dialog (combobox pattern, palette.md section 8). Pure: state lives in {@link Palette}.
 * @param {{ model: ReturnType<typeof paletteModel>, query: string, active: number, now?: number, t?: Function, onQuery?: (q: string) => void, onKeyDown?: Function, onRow?: (row: object) => void, onHover?: (index: number) => void, onClose?: () => void, inputRef?: object, panelRef?: object }} props
 */
export function PaletteView({ model, query, active, now = Date.now(), t, onQuery, onKeyDown, onRow, onHover, onClose, inputRef, panelRef }) {
  const label = translate(t, PALETTE_COPY, 'palette.input.label')
  return (
    <div className="palette-scrim" onClick={event => { if (event.target === event.currentTarget) onClose?.() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={label} ref={panelRef} onKeyDown={onKeyDown}>
        <input className="palette-input" type="text" role="combobox" aria-expanded={model.rows.length ? 'true' : 'false'} aria-controls="palette-list"
          aria-activedescendant={active >= 0 ? `palette-opt-${active}` : undefined} aria-autocomplete="list" aria-label={label} placeholder={label}
          autoComplete="off" spellCheck="false" value={query} onChange={event => onQuery?.(event.target.value)} ref={inputRef} />
        <ul className="palette-list" id="palette-list" role="listbox" aria-label={label}>
          {model.groups.map(group => (
            <li key={group.id} role="presentation" className={`palette-group palette-group--${group.id}`}>
              <p className="eyebrow palette-group-title" id={`palette-group-${group.id}`}>{group.label}</p>
              <ul role="group" aria-labelledby={`palette-group-${group.id}`}>
                {group.rows.map(row => <Option key={row.key} row={row} active={active} now={now} t={t} onRow={onRow} onHover={onHover} />)}
                {group.more ? <Option row={group.more} active={active} now={now} t={t} onRow={onRow} onHover={onHover} /> : null}
              </ul>
            </li>
          ))}
        </ul>
        {model.rows.length ? null : model.message ? <p className="palette-message" role="status">{model.message}</p> : <EmptyState kind="palette" t={t} />}
        <p className="palette-footer">{['palette.footer.move', 'palette.footer.run', 'palette.footer.close'].map(key => translate(t, PALETTE_COPY, key)).join(' · ')}</p>
      </div>
    </div>
  )
}

/**
 * The palette overlay: holds the query, highlight and expanded groups and wires {@link paletteKey},
 * {@link moveActive} and {@link runRow} to the input, with focus moved to the input on open and back to
 * the opener on close. `onArchive` runs "Archive session" (the screen under the palette shows its toast); without
 * it the row posts the archive directly. This browser wiring is not exercised by the unit tests; the functions it calls are.
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, api?: { post: Function }, onClose?: () => void, onLeave?: () => void, onArchive?: (id: string) => Promise<unknown> }} props
 */
export function Palette({ state, t, navigate, api, onClose = () => closeOverlay(), onLeave = () => leaveOverlay(), onArchive }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState([])
  const input = useRef(null)
  const panel = useRef(null)
  const now = Date.now()
  useEffect(() => {
    const opener = globalThis.document?.activeElement
    input.current?.focus()
    return () => opener?.focus?.()
  }, [])
  const model = paletteModel(state, { query, now, expanded, t })
  const current = Math.min(active, model.rows.length - 1)
  const env = { navigate, leave: onLeave, onClose, expand: group => setExpanded(list => [...list, group]), api: api ?? deckApi() }
  if (onArchive) env.archive = onArchive
  const run = row => { runRow(row, env).catch(() => {}) }
  useEffect(() => {
    globalThis.document?.getElementById(`palette-opt-${current}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [current])
  const onKeyDown = event => {
    const action = paletteKey(event)
    if (!action) return trapTab(event, panel.current)
    event.preventDefault()
    event.stopPropagation()
    if (action.type === 'close') onClose()
    else if (action.type === 'move') setActive(moveActive(current, action.delta, model.rows.length))
    else if (action.type === 'run' && model.rows[current]) run(model.rows[current])
  }
  return (
    <PaletteView model={model} query={query} active={current} now={now} t={t} inputRef={input} panelRef={panel} onKeyDown={onKeyDown} onClose={onClose}
      onQuery={value => { setQuery(value)
        setActive(0) }} onRow={run} onHover={setActive} />
  )
}
