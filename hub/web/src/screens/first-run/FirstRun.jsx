import React, { useEffect, useReducer, useRef, useState } from 'react'
import { CrewAvatar, poseFor } from '../../components/CrewAvatar.jsx'
import { shown, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { deckApi, repoFor } from '../drawer/NeedsYouDrawer.jsx'

/** English copy for First run (docs/deck/screens/first-run.md section 9); `firstRun.name.*` names a check in the timeout line. */
export const FIRST_RUN_COPY = Object.freeze({
  'firstRun.title': 'Welcome aboard the deck',
  'firstRun.subtitle': 'Six checks before the first voyage. Optional ones can wait.',
  'firstRun.cc.ok': 'Claude Code {version} compatible',
  'firstRun.cc.ok.sub': 'Matches the pinned hook payload fixtures for this deck release',
  'firstRun.cc.warn': 'Claude Code {version} is newer than this deck was tested with',
  'firstRun.cc.warn.sub': 'Hooks may differ; sessions can show wrong states.',
  'firstRun.cc.missing': 'Claude Code was not found',
  'firstRun.cc.drift': '{n, plural, one {# hook payload did not match the pinned fixtures} other {# hook payloads did not match the pinned fixtures}}',
  'firstRun.hooks.ok': 'Observation hooks installed',
  'firstRun.hooks.ok.sub': 'Every Claude Code session on this machine reports to the deck.',
  'firstRun.hooks.bad': 'Observation hooks not installed',
  'firstRun.hooks.bad.sub': 'Needed to see sessions you start in a terminal. Adds hooks to ~/.claude/settings.json next to fleetmates.',
  'firstRun.hooks.fix': 'Install hooks',
  'firstRun.deckd.ok': 'deckd running',
  'firstRun.deckd.ok.sub': 'systemd --user · pid {pid} · up {duration}',
  'firstRun.deckd.bad': 'deckd is not running',
  'firstRun.deckd.bad.sub': 'Sessions can be watched but not launched or answered.',
  'firstRun.deckd.fix': 'Start deckd',
  'firstRun.vault.ok': 'vault-mcp reachable',
  'firstRun.vault.ok.sub': 'VAULT_PATH={path} · {n} notes indexed',
  'firstRun.vault.bad': 'vault-mcp did not start',
  'firstRun.vault.fix': 'Fix in Settings',
  'firstRun.scribed.ok': 'scribed reachable',
  'firstRun.scribed.warn': 'scribed socket not found (optional)',
  'firstRun.scribed.warn.sub': 'Meetings will work once TurbidAssist is running.',
  'firstRun.scribed.fix': 'Start scribed',
  'firstRun.notify.todo': 'Notifications',
  'firstRun.notify.todo.sub': 'Sends one test popup with the ship\'s bell through mako.',
  'firstRun.notify.ok': 'Test popup sent through mako',
  'firstRun.notify.bad': 'notify-send failed: {stderr}',
  'firstRun.notify.fix': 'Send test ping',
  'firstRun.optional': '(optional)',
  'firstRun.timeout': '{check} did not answer in 10 s.',
  'firstRun.showError': 'Show full error',
  'firstRun.status.ok': 'Passed',
  'firstRun.status.bad': 'Failed',
  'firstRun.status.warn': 'Warning',
  'firstRun.status.todo': 'Not checked',
  'firstRun.status.checking': 'Checking',
  'firstRun.summary': '{ok} of {n} checks passed',
  'firstRun.footer': 'Re-run anytime from Settings, Connections',
  'firstRun.checkAgain': 'Check again',
  'firstRun.setSail': 'Set sail',
  'firstRun.setSail.blocked': 'Set sail (needs hooks)',
  'firstRun.setSail.error': 'Could not set sail: {error}',
  'firstRun.done': 'Done',
  'firstRun.name.claude': 'Claude Code',
  'firstRun.name.hooks': 'Observation hooks',
  'firstRun.name.deckd': 'deckd',
  'firstRun.name.vault': 'vault-mcp',
  'firstRun.name.scribed': 'scribed',
  'firstRun.name.notify': 'Notifications'
})

/** The six checks in display order (state-machines 10.2). */
export const CHECK_IDS = Object.freeze(['claude', 'hooks', 'deckd', 'vault', 'scribed', 'notify'])
/** A check still `checking` after this long fails with the timeout line. */
export const CHECK_TIMEOUT_MS = 10_000
/** Error text longer than this, or over four lines, gets the "Show full error" disclosure. */
export const ERROR_CLAMP_CHARS = 240

const FIX = { hooks: 'firstRun.hooks.fix', deckd: 'firstRun.deckd.fix', vault: 'firstRun.vault.fix', scribed: 'firstRun.scribed.fix', notify: 'firstRun.notify.fix' }
const OPTIONAL = new Set(['claude', 'scribed'])

/**
 * A tiny event feed for the ephemeral `setup.check` WebSocket messages, which carry no `seq`
 * and so never reach the deck store (docs/deck/05-api.md section 3.4).
 * @returns {{ push: (check: object) => void, subscribe: (listener: (check: object) => void) => () => void }}
 */
export function createSetupFeed() {
  const listeners = new Set()
  return {
    push(check) { for (const listener of listeners) listener(check) },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/**
 * Wrap a deck store so `setup.check` messages also reach `feed`; every action still goes to the store.
 * @param {{ dispatch: (action: object) => void }} store
 * @param {ReturnType<typeof createSetupFeed>} feed
 * @returns {object} the same store surface with a tapping `dispatch`
 */
export function tapSetupChecks(store, feed) {
  return {
    ...store,
    dispatch(action) {
      if (action?.type === 'message' && action.message?.t === 'setup.check' && action.message.data) feed.push(action.message.data)
      store.dispatch(action)
    }
  }
}

/** @returns {object[]} the six checks as the page opens: automatic ones `checking`, notifications `pending` */
export function initialChecks() {
  return CHECK_IDS.map(id => ({ id, state: id === 'notify' ? 'pending' : 'checking', blocking: id === 'hooks', detail: null, error: null }))
}

/**
 * Pure checklist machine (state-machines 10.3).
 * Actions: `run` (automatic checks to `checking`), `result` (one SetupCheck), `timeout` (still-checking rows fail),
 * `fix` (one row to `checking`), `fixFailed` (one row back to `failed` with the error text).
 * @param {object[]} checks
 * @param {{ type: string, check?: object, id?: string, error?: string }} action
 * @returns {object[]}
 */
export function reduceChecks(checks, action) {
  const patch = (id, change) => checks.map(row => row.id === id ? { ...row, ...change } : row)
  switch (action.type) {
    case 'run':
      return checks.map(row => row.id === 'notify' && row.state !== 'checking' ? row : { ...row, state: 'checking', error: null, timedOut: false })
    case 'result': {
      const incoming = action.check
      const current = checks.find(row => row.id === incoming?.id)
      if (!current) return checks
      if (incoming.id === 'notify' && incoming.state === 'pending' && ['ok', 'failed'].includes(current.state)) return checks
      return patch(incoming.id, { ...incoming, blocking: incoming.id === 'hooks', timedOut: false })
    }
    case 'timeout':
      return checks.map(row => row.state === 'checking' ? { ...row, state: 'failed', error: null, timedOut: true } : row)
    case 'fix':
      return patch(action.id, { state: 'checking', error: null, timedOut: false })
    case 'fixFailed':
      return patch(action.id, { state: 'failed', error: action.error ?? null, timedOut: false })
    default:
      return checks
  }
}

/**
 * The Set sail gate (Decided): enabled iff the hooks check is `ok`. No other check blocks.
 * @param {object[]} checks
 * @returns {boolean}
 */
export function canSetSail(checks) {
  return checks.some(row => row.id === 'hooks' && row.state === 'ok')
}

/**
 * Whether every check has an answer (none still `checking`).
 * @param {object[]} checks
 * @returns {boolean}
 */
export function settled(checks) {
  return checks.every(row => row.state !== 'checking')
}

/**
 * The polite summary after a full run: "{ok} of {n} checks passed".
 * @param {object[]} checks
 * @param {Function} [t]
 * @returns {string}
 */
export function summaryText(checks, t) {
  return translate(t, FIRST_RUN_COPY, 'firstRun.summary', { ok: checks.filter(row => row.state === 'ok').length, n: checks.length })
}

function versionOf(check) {
  return check.version ?? /(\d+\.\d+\.\d+)/.exec(String(check.detail ?? ''))?.[1] ?? null
}

/**
 * Display model for one check row: tone, title, subtitle, whether the subtitle is command output, and the fix action.
 * Server strings (version, detail, error, pid, path) are passed through `shown` before they reach copy.
 * @param {object} check a SetupCheck
 * @param {Function} [t]
 * @returns {{ id: string, tone: 'ok'|'bad'|'warn'|'todo'|'checking', title: string, sub: string | null, mono: boolean, optional: boolean, action: string | null }}
 */
export function rowView(check, t) {
  const tr = (key, params) => translate(t, FIRST_RUN_COPY, key, params)
  const { id, state } = check
  const optional = OPTIONAL.has(id)
  const failed = state === 'failed' || state === 'optional_skipped'
  const error = check.error ? shown(check.error) : null
  const view = { id, tone: 'todo', title: tr(`firstRun.name.${id}`), sub: null, mono: false, optional: id === 'scribed', action: null }
  if (state === 'checking') return { ...view, tone: 'checking' }
  if (check.timedOut) return { ...view, tone: optional ? 'warn' : 'bad', sub: tr('firstRun.timeout', { check: tr(`firstRun.name.${id}`) }), action: FIX[id] ?? null }
  if (id === 'claude') {
    const version = versionOf(check)
    const drift = Number(check.drift) > 0 ? tr('firstRun.cc.drift', { n: Number(check.drift) }) : null
    if (state === 'ok') return { ...view, tone: drift ? 'warn' : 'ok', title: tr('firstRun.cc.ok', { version: shown(version) }), sub: drift ?? tr('firstRun.cc.ok.sub') }
    if (!version) return { ...view, tone: 'warn', title: tr('firstRun.cc.missing'), sub: error ?? (check.detail ? shown(check.detail) : null), mono: !!error }
    return { ...view, tone: 'warn', title: tr('firstRun.cc.warn', { version: shown(version) }), sub: error ?? drift ?? tr('firstRun.cc.warn.sub'), mono: !!error }
  }
  if (id === 'hooks') {
    if (state === 'ok') return { ...view, tone: 'ok', title: tr('firstRun.hooks.ok'), sub: tr('firstRun.hooks.ok.sub') }
    return { ...view, tone: 'bad', title: tr('firstRun.hooks.bad'), sub: error ?? tr('firstRun.hooks.bad.sub'), mono: !!error, action: FIX.hooks }
  }
  if (id === 'deckd') {
    if (state === 'ok') return { ...view, tone: 'ok', title: tr('firstRun.deckd.ok'), sub: check.pid ? tr('firstRun.deckd.ok.sub', { pid: shown(check.pid), duration: shown(check.uptime ?? '') }) : null }
    return { ...view, tone: 'bad', title: tr('firstRun.deckd.bad'), sub: error ?? tr('firstRun.deckd.bad.sub'), mono: !!error, action: FIX.deckd }
  }
  if (id === 'vault') {
    if (state === 'ok') return { ...view, tone: 'ok', title: tr('firstRun.vault.ok'), sub: check.path ? tr('firstRun.vault.ok.sub', { path: shown(check.path), n: Number(check.notes ?? 0) }) : null }
    if (state === 'failed') return { ...view, tone: 'bad', title: tr('firstRun.vault.bad'), sub: error ?? (check.detail ? shown(check.detail) : null), mono: true, action: FIX.vault }
    return { ...view, tone: 'todo', sub: check.detail ? shown(check.detail) : null, action: FIX.vault }
  }
  if (id === 'scribed') {
    if (state === 'ok') return { ...view, tone: 'ok', title: tr('firstRun.scribed.ok'), optional: false }
    if (failed) return { ...view, tone: 'warn', title: tr('firstRun.scribed.warn'), sub: error ?? tr('firstRun.scribed.warn.sub'), mono: !!error, optional: false, action: FIX.scribed }
    return { ...view, action: FIX.scribed }
  }
  if (id === 'notify') {
    if (state === 'ok') return { ...view, tone: 'ok', title: tr('firstRun.notify.ok') }
    if (state === 'failed') return { ...view, tone: 'bad', title: tr('firstRun.notify.bad', { stderr: error ?? shown(check.detail ?? '') }), action: FIX.notify }
    return { ...view, tone: 'todo', title: tr('firstRun.notify.todo'), sub: tr('firstRun.notify.todo.sub'), action: FIX.notify }
  }
  return { ...view, sub: check.detail ? shown(check.detail) : null }
}

function errorText(error) {
  const details = error?.details ?? {}
  if (details.stderr) return String(details.stderr)
  if (details.exitCode !== undefined && details.exitCode !== null) return `exit ${details.exitCode}`
  return String(error?.message ?? error?.code ?? 'failed')
}

/**
 * Run one row's fix (state-machines 10.3 `U.Fix` and `U.SendTestPing`) through the authenticated api.
 * "Fix in Settings" is a route, not a request.
 * @param {string} id check id
 * @param {{ api: { get: Function, post: Function }, dispatch: (action: object) => void, navigate: (to: string) => void, rerun: () => Promise<void> }} env
 * @returns {Promise<void>}
 */
export async function runFix(id, { api, dispatch, navigate, rerun }) {
  if (id === 'vault') {
    navigate('/settings/connections#vault')
    return
  }
  dispatch({ type: 'fix', id })
  try {
    if (id === 'hooks') {
      const data = await api.post('/api/setup/hooks')
      if (data?.check) dispatch({ type: 'result', check: data.check })
      await rerun()
    } else if (id === 'deckd' || id === 'scribed') {
      await api.post(`/api/deps/${id}/start`)
      await rerun()
    } else if (id === 'notify') {
      await api.post('/api/notify/test')
      dispatch({ type: 'result', check: { id: 'notify', state: 'ok', blocking: false, detail: null, error: null } })
    }
  } catch (error) {
    dispatch({ type: 'fixFailed', id, error: errorText(error) })
  }
}

const GLYPH = { ok: '✓', bad: '✕', warn: '!', todo: '?', checking: '◌' }
const STATUS_KEY = { ok: 'firstRun.status.ok', bad: 'firstRun.status.bad', warn: 'firstRun.status.warn', todo: 'firstRun.status.todo', checking: 'firstRun.status.checking' }

function long(text) {
  return text.length > ERROR_CLAMP_CHARS || text.split('\n').length > 4
}

/**
 * One ChecklistRow: status circle with its sr word, title, subtitle (mono for command output) and the fix action.
 * @param {{ view: ReturnType<typeof rowView>, t?: Function, busy?: boolean, onAction: (id: string) => void, navigate: (to: string) => void, actionRef?: Function }} props
 */
export function ChecklistRow({ view, t, busy = false, onAction, navigate, actionRef }) {
  const tr = key => translate(t, FIRST_RUN_COPY, key)
  const sub = view.sub
  const primary = view.id === 'hooks'
  let action = null
  if (view.action && view.tone !== 'ok' && view.tone !== 'checking') {
    const label = tr(view.action)
    if (view.id === 'vault') {
      const href = '/settings/connections#vault'
      action = <a ref={actionRef} className="button button--secondary check-action" href={href} onClick={linkHandler(navigate, href)}>{label}</a>
    } else {
      action = (
        <button ref={actionRef} type="button" className={`button ${primary ? 'button--primary' : 'button--secondary'} check-action`}
          aria-busy={busy ? 'true' : undefined} onClick={() => { if (!busy) onAction(view.id) }}>
          {busy ? <span className="check-spinner motion-spin" aria-hidden="true">◌</span> : null}{label}
        </button>
      )
    }
  }
  return (
    <li className={`check-row check-row--${view.tone}`} data-check={view.id}>
      <span className={`check-status check-status--${view.tone}`}>
        <span aria-hidden="true">{GLYPH[view.tone]}</span>
        <span className="sr-only">{tr(STATUS_KEY[view.tone])}</span>
      </span>
      <div className="check-text">
        <p className="check-title"><bdi>{titleText(view.title)}</bdi>{view.optional ? <span className="check-optional"> {tr('firstRun.optional')}</span> : null}</p>
        {sub ? (view.mono ? <pre className="check-sub check-sub--mono">{sub}</pre> : <p className="check-sub"><bdi>{titleText(sub)}</bdi></p>) : null}
        {sub && view.mono && long(sub) ? <details className="check-more"><summary>{tr('firstRun.showError')}</summary><pre className="check-sub--mono">{sub}</pre></details> : null}
      </div>
      {action ? <div className="check-actions">{action}</div> : null}
    </li>
  )
}

/**
 * The checklist, pure: hero (welcome mode), six rows, footer with "Check again" and "Set sail" or "Done".
 * In `welcome` mode the gate applies: blocked Set sail keeps its reason in the label and stays focusable (`aria-disabled`).
 * @param {{ checks: object[], mode?: 'welcome'|'rerun'|'done', t?: Function, navigate: (to: string) => void, busy?: Record<string, boolean>, crew?: object[], onAction: (id: string) => void, onCheckAgain: () => void, onSetSail: () => void, onDone: () => void, announcement?: string, sailError?: string | null, refs?: { action?: Function, sail?: Function } }} props
 */
export function ChecklistView({ checks, mode = 'welcome', t, navigate, busy = {}, crew = [], onAction, onCheckAgain, onSetSail, onDone, announcement = '', sailError = null, refs = {} }) {
  const tr = (key, params) => translate(t, FIRST_RUN_COPY, key, params)
  const open = canSetSail(checks)
  const firstBlocking = checks.find(row => row.blocking && row.state === 'failed')?.id
  const rows = checks.map(check => rowView(check, t))
  const list = (
    <ul className="checklist">
      {rows.map(view => <ChecklistRow key={view.id} view={view} t={t} busy={!!busy[view.id]} onAction={onAction} navigate={navigate}
        actionRef={view.id === firstBlocking ? refs.action : undefined} />)}
    </ul>
  )
  const finish = mode === 'welcome'
    ? <button ref={refs.sail} type="button" className="button button--primary button--xl first-run-sail" aria-disabled={open ? undefined : 'true'}
        onClick={() => { if (open) onSetSail() }}>{tr(open ? 'firstRun.setSail' : 'firstRun.setSail.blocked')}</button>
    : <button ref={refs.sail} type="button" className="button button--primary button--xl first-run-sail" onClick={onDone}>{tr('firstRun.done')}</button>
  const footer = (
    <div className="first-run-footer">
      {mode === 'rerun' ? null : <p className="first-run-note">{tr('firstRun.footer')}</p>}
      <div className="first-run-buttons">
        <button type="button" className="button button--secondary button--xl" onClick={onCheckAgain}>{tr('firstRun.checkAgain')}</button>
        {finish}
      </div>
      {sailError ? <p className="first-run-error" role="status"><bdi>{tr('firstRun.setSail.error', { error: shown(sailError) })}</bdi></p> : null}
    </div>
  )
  const live = <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
  if (mode === 'rerun') return <section className="checklist-inline" aria-label={tr('firstRun.title')}>{list}{footer}{live}</section>
  return (
    <section className="first-run">
      <div className="first-run-hero">
        {crew.length ? <div className="first-run-crew" aria-hidden="true">{crew.map(member => <CrewAvatar key={member.seed} seed={member.seed} slot={member.slot} pose={member.pose} size="lg" />)}</div> : null}
        <h1 className="first-run-title">{tr('firstRun.title')}</h1>
        <p className="first-run-subtitle">{tr('firstRun.subtitle')}</p>
      </div>
      {list}
      {footer}
      {live}
    </section>
  )
}

/**
 * Hero crew: the first three repos with poses needs, running, done (first-run.md section 4).
 * @param {object[]} repos
 * @returns {{ seed: string, slot?: number, pose: string }[]}
 */
export function heroCrew(repos = []) {
  const poses = [poseFor('needs_approval'), poseFor('running'), poseFor('done')]
  return repos.slice(0, 3).map((row, index) => {
    const repo = repoFor(repos, row.id)
    return { seed: repo.crewSeed, slot: repo.crewSlot, pose: poses[index] }
  })
}

/**
 * The live checklist: runs every check on open and on "Check again", listens to `setup.check` on `feed`,
 * times out rows after {@link CHECK_TIMEOUT_MS}, runs fixes and announces the summary after each full run.
 * Browser wiring; {@link ChecklistView}, {@link reduceChecks} and {@link runFix} carry the tested behavior.
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, api?: object, feed?: ReturnType<typeof createSetupFeed>, mode?: 'welcome'|'rerun', onDone?: () => void }} props
 */
export function Checklist({ state, t, navigate, api, feed, mode = 'welcome', onDone }) {
  const client = api ?? deckApi()
  const [checks, dispatch] = useReducer(reduceChecks, undefined, initialChecks)
  const [busy, setBusy] = useState({})
  const [announcement, setAnnouncement] = useState('')
  const [sailing, setSailing] = useState(false)
  const [sailError, setSailError] = useState(null)
  const [run, setRun] = useState(0)
  const awaiting = useRef(false)
  const focused = useRef(false)
  const actionEl = useRef(null)
  const sailEl = useRef(null)
  const completed = !!state.data.setup?.firstRunCompletedAt

  useEffect(() => feed?.subscribe(check => dispatch({ type: 'result', check })), [feed])
  useEffect(() => {
    if (!run) return undefined
    const timer = setTimeout(() => dispatch({ type: 'timeout' }), CHECK_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [run])
  const rerun = async () => {
    dispatch({ type: 'run' })
    awaiting.current = true
    setRun(n => n + 1)
    try {
      const data = await client.get('/api/setup/checks')
      for (const check of data?.checks ?? []) if (check.state !== 'checking') dispatch({ type: 'result', check })
    } catch (error) {
      for (const id of CHECK_IDS) if (id !== 'notify') dispatch({ type: 'fixFailed', id, error: errorText(error) })
    }
  }
  useEffect(() => { void rerun() }, [])
  const done = settled(checks)
  useEffect(() => {
    if (!done || !awaiting.current) return
    awaiting.current = false
    setAnnouncement(summaryText(checks, t))
    if (focused.current) return
    focused.current = true
    ;(actionEl.current ?? sailEl.current)?.focus()
  }, [done])
  useEffect(() => { if (sailing && completed) navigate('/') }, [sailing, completed, navigate])

  const onAction = id => {
    setBusy(map => ({ ...map, [id]: true }))
    runFix(id, { api: client, dispatch, navigate, rerun }).finally(() => setBusy(map => ({ ...map, [id]: false })))
  }
  const onSetSail = () => {
    setSailError(null)
    client.post('/api/setup/complete').then(() => setSailing(true)).catch(error => setSailError(error?.code ?? 'failed'))
  }
  return (
    <ChecklistView checks={checks} mode={mode === 'welcome' && completed ? 'done' : mode} t={t} navigate={navigate} busy={busy}
      crew={heroCrew(state.data.repos)} onAction={onAction} onCheckAgain={() => { void rerun() }} onSetSail={onSetSail}
      onDone={onDone ?? (() => navigate('/'))} announcement={announcement} sailError={sailError} refs={{ action: actionEl, sail: sailEl }} />
  )
}

/**
 * The `/welcome` route screen for the shell's `screens` map.
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, api?: object, feed?: ReturnType<typeof createSetupFeed> }} props
 */
export function FirstRun(props) {
  return <Checklist {...props} mode="welcome" />
}
