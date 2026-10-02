import React, { useEffect, useRef, useState } from 'react'
import { CARD_COPY } from '../../components/SessionCard.jsx'
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx'
import { CrewAvatar, poseFor } from '../../components/CrewAvatar.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { MetaLine, StatusPill, compactDuration, pillParams, shown, stateLabel, titleText, translate } from '../../components/StatusPill.jsx'
import { TerminalView } from '../../components/TerminalView.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { fetchScrollback, nudgeSession, relaunchSession, stopSession } from '../../state/actions.js'
import { parseNeedsFilter } from '../../state/deck-store.js'
import { ObserveOverlays, teamCards, useMinuteNow } from '../home/Home.jsx'
import { deckApi, openOverlay, repoFor, tierOf } from '../drawer/NeedsYouDrawer.jsx'
import { orderSessions } from '../palette/Palette.jsx'

/**
 * English copy for Focus (docs/deck/screens/focus.md section 9): the M1 read-only layout (MS-O1) and the M2
 * terminal, header and actions. Keys the copy deck does not name carry their source in a comment.
 */
export const FOCUS_COPY = Object.freeze({
  'focus.list.back': 'All ships',
  'focus.list.label': 'Sessions',
  'focus.list.launch': 'Launch a ship',
  // The team row label of focus.md 4.1 ("2 of 4 need you"); same text as `team.pill` and `home.card.team.pill`.
  'focus.list.team': '{needs} of {total} need you',
  'focus.header.waiting': '{state} · {duration}',
  'focus.header.lastTyped.terminal': 'Last typed from: terminal ({client})',
  'focus.header.lastTyped.browser': 'Last typed from: browser',
  'focus.header.typing.terminal': 'Typing in terminal ({client})',
  'focus.header.typing.browser': 'Typing in browser',
  'focus.header.collision': 'Both typing: last keystroke wins',
  'focus.header.inputTooltip': 'Both the terminal and the browser can type; last keystroke wins',
  'focus.header.detached': 'terminal detached',
  'focus.header.leaveHint': 'Alt Esc to leave the terminal',
  'focus.header.openRun': 'Open run',
  'focus.header.markReviewed': 'Mark reviewed',
  'focus.header.reviewFailed': 'Could not mark this session reviewed.',
  'focus.header.hidePanel': 'Hide panel',
  'focus.header.showPanel': 'Show panel',
  'focus.header.stop': 'Stop…',
  'focus.stop.title': 'Stop {repo} · {task}?',
  'focus.stop.body': 'The process gets SIGTERM, then SIGKILL after 5 s. Uncommitted changes stay in the working tree.',
  'focus.stop.confirm': 'Stop session',
  'focus.stop.cancel': 'Cancel',
  // focus.md 5.4, "Stop failed".
  'focus.stop.failed': 'Could not stop {repo}: {message}',
  'focus.observed.banner': 'Observed session: started as plain claude, read-only here.',
  'focus.prompt.answerInTerminal': 'Answer in your terminal',
  'focus.prompt.deckdDown': 'deckd is reconnecting',
  'focus.stale.line': 'Adrift since {time}: no activity since then.',
  'focus.stale.nudge': 'Nudge (send Enter)',
  // focus.md 4.3 crash banner actions; the lines are failures-and-loading.md 4.1 (lost, and "anything else").
  'focus.crash.relaunch': 'Relaunch',
  'focus.crash.dismiss': 'Dismiss',
  'focus.crash.lost': 'The deck lost track of this process. It may have been closed outside the deck.',
  'focus.crash.exit': 'The session exited with code {code}.',
  // state-machines.md row 7 (`T.StartTimeout`).
  'focus.starting.hint': 'No signal from hooks yet. Is fleetmates deck init done?',
  'focus.paste.title': 'Paste {size} into {repo}?',
  // No copy deck names the paste and link dialog bodies or buttons; 08-security 4.6 asks only that the real URL shows.
  'focus.paste.body': 'The text goes to the terminal as one paste.',
  'focus.paste.confirm': 'Paste',
  'focus.link.title': 'Open this link from the terminal?',
  'focus.link.confirm': 'Open link',
  'focus.joinedLate': 'Joined mid-voyage: changes before {time} are not counted.',
  'focus.log.label': 'Activity',
  'focus.log.empty': 'No activity recorded yet.',
  'focus.log.loading': 'Loading activity',
  'focus.tabs.label': 'Details',
  'focus.tabs.changes': 'Changes',
  'focus.tabs.facts': 'Facts',
  'focus.changes.label': 'Changed files',
  // FOC-O3 default: no diff in M2 (Task 9).
  'focus.changes.caption': 'Diffs arrive with approvals.',
  'focus.facts.origin': 'Started from',
  'focus.facts.origin.wrapped': 'fm claude in a terminal',
  'focus.facts.origin.launched': 'the deck',
  'focus.facts.origin.observed': 'plain claude (observed)',
  'focus.facts.started': 'Started',
  'focus.facts.duration': 'Running for',
  'focus.facts.claudeSession': 'Claude session',
  'focus.facts.aliases': '{n, plural, one {# earlier conversation} other {# earlier conversations}}',
  'focus.facts.branch': 'Branch',
  'focus.facts.cwd': 'Working directory',
  'focus.facts.toolCalls': 'Tool calls',
  'focus.facts.subagents': 'Subagents working',
  // FOC-O3 lists "last input from"; the copy deck has no label for it yet.
  'focus.facts.lastInput': 'Last input from',
  'focus.facts.transcript': 'Transcript',
  'focus.facts.baseline': 'Changes measured since',
  'focus.notFound.title': 'This session is not on the deck.'
})

const NEEDS = new Set(['needs_approval', 'asked_you'])
const TABS = ['changes', 'facts']
const OUTAGE = new Set(['down', 'reconnecting'])
const ENDED = new Set(['ended', 'crashed'])
const START_HINT_MS = 30_000
const COLLISION_CHIP_MS = 3000
const PANEL_KEY = 'deck.focus.panel'
const NARROW = '(max-width: 1280px)'
const href = id => `/s/${encodeURIComponent(id)}`
const seg = value => encodeURIComponent(String(value))

function clock(at, lang) {
  return Number.isFinite(at) ? new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at) : ''
}

/**
 * Mark a `done` session reviewed (05-api.md, `POST /api/sessions/:id/mark-reviewed`, `U.MarkReviewed`).
 * The screen changes no state itself; the new pill comes from the server's events.
 * @param {{ post: (path: string, body?: object) => Promise<any> }} api
 * @param {string} id
 * @returns {Promise<any>}
 */
export function markReviewed(api, id) {
  return api.post(`/api/sessions/${seg(id)}/mark-reviewed`)
}

/**
 * Dismiss a crashed session (05-api.md, `POST /api/sessions/:id/dismiss`, `U.Dismiss`, row 47).
 * @param {{ post: (path: string) => Promise<any> }} api
 * @param {string} id
 * @returns {Promise<any>}
 */
export function dismissSession(api, id) {
  return api.post(`/api/sessions/${seg(id)}/dismiss`)
}

/**
 * Read the last 1,000 lines an ended or crashed PTY session left (`GET /api/sessions/:id/scrollback`).
 * @param {{ get: Function }} api
 * @param {string} id
 * @returns {Promise<{ text: string, source: 'deckd' | 'stored', truncated: boolean }>}
 */
export function loadScrollback(api, id) {
  return fetchScrollback(api, id, 1000)
}

/**
 * The Focus session actions, kept out of the component so the order of effects is testable: opening the Stop
 * dialog only sets `{ confirming: true }`; confirming posts the stop and a failure pushes the error toast
 * "Could not stop {repo}: {message}" (focus.md 5.4). Nudge, Relaunch and Dismiss post at once.
 * @param {{ api: { post: Function }, id: string, set: (patch: object) => void, toast: (toast: { tone: string, title: string }) => void, repo: string, t?: Function }} options
 * @returns {{ openStop: () => void, cancelStop: () => void, confirmStop: () => Promise<void>, nudge: () => Promise<void>, relaunch: () => Promise<void>, dismiss: () => Promise<void> }}
 */
export function focusActions({ api, id, set, toast, repo, t }) {
  const quietly = run => run().then(() => {}, () => {})
  return {
    openStop: () => set({ confirming: true }),
    cancelStop: () => set({ confirming: false }),
    async confirmStop() {
      set({ confirming: false })
      try {
        await stopSession(api, id)
      } catch (error) {
        toast({ tone: 'error', title: translate(t, FOCUS_COPY, 'focus.stop.failed', { repo, message: error?.message ?? error?.code ?? 'failed' }) })
      }
    },
    nudge: () => quietly(() => nudgeSession(api, id)),
    relaunch: () => quietly(() => relaunchSession(api, id)),
    dismiss: () => quietly(() => dismissSession(api, id))
  }
}

/**
 * Open the Needs-you drawer for a D-69 deep link: `?needs=task:<runId>:<taskId>` or `?needs=run:<runId>`.
 * Other `needs=` kinds and searches without one do nothing.
 * @param {string} search
 * @param {(overlay: 'drawer', detail: { filter: object }) => void} open
 * @returns {object | null} the filter it opened with
 */
export function openNeedsFilter(search, open) {
  const filter = parseNeedsFilter(search)
  if (!filter || (filter.kind !== 'task' && filter.kind !== 'run')) return null
  open('drawer', { filter })
  return filter
}

/**
 * Whether a keydown is `Alt I`, the details panel key (keyboard.md 2), matched on `event.code`.
 * @param {{ code: string, altKey: boolean, shiftKey: boolean, ctrlKey: boolean, metaKey: boolean }} event
 * @returns {boolean}
 */
export function isPanelKey(event) {
  return !!event?.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyI'
}

/**
 * Whether the details panel is shown, from `localStorage` `deck.focus.panel` (`open` by default; a storage
 * that throws reads as open).
 * @param {Storage | undefined} storage
 * @returns {boolean}
 */
export function readPanel(storage) {
  try {
    return storage?.getItem(PANEL_KEY) !== 'hidden'
  } catch {
    return true
  }
}

/**
 * Remember whether the details panel is shown; storage errors are ignored.
 * @param {Storage | undefined} storage
 * @param {boolean} open
 */
export function writePanel(storage, open) {
  try { storage?.setItem(PANEL_KEY, open ? 'open' : 'hidden') } catch {}
}

function deckdOf(state) {
  const row = (state.data.health ?? []).find(item => item.dep === 'deckd')
  const down = !!row && (OUTAGE.has(row.state) || row.state === 'checking' && !!state.deckdOutage)
  return { down, up: row ? row.state === 'up' : true }
}

const isPty = session => session.origin !== 'observed'
const isLive = session => isPty(session) && !!session.alive && !!session.ptyId && !ENDED.has(session.state)

function inputLabel(session, source, t) {
  const client = name => ({ client: shown(name ?? '') })
  const terminal = (key, name) => translate(t, FOCUS_COPY, key, client(name)).replace(' ()', '')
  if (source?.state === 'terminal_active') return terminal('focus.header.typing.terminal', source.name)
  if (source?.state === 'browser_active') return translate(t, FOCUS_COPY, 'focus.header.typing.browser')
  const from = source?.from ?? session.lastInputFrom
  const name = source?.from ? source.name : session.lastInputName
  if (from === 'terminal') return terminal('focus.header.lastTyped.terminal', name)
  if (from === 'browser') return translate(t, FOCUS_COPY, 'focus.header.lastTyped.browser')
  return null
}

function InputIndicator({ session, source, collision, t }) {
  const text = inputLabel(session, source, t)
  const chip = translate(t, FOCUS_COPY, 'focus.header.collision')
  return (
    <>
      {collision ? <span className="focus-collision">{chip}</span> : null}
      {text || source?.detached ? (
        <span className="focus-input" title={translate(t, FOCUS_COPY, 'focus.header.inputTooltip')}>
          <span className="focus-input-text">{text}{text && source?.detached ? ' · ' : ''}{source?.detached ? translate(t, FOCUS_COPY, 'focus.header.detached') : ''}</span>
        </span>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">{collision ? chip : ''}</span>
    </>
  )
}

function SessionList({ state, sessionId, now, t, navigate }) {
  const live = orderSessions(state.data.sessions.filter(row => row.state !== 'ended'), state.data.order, state.data.requests)
  const teams = teamCards(state.data.runs ?? [], state.data.sessions, state.data.requests ?? [])
  return (
    <aside className="focus-list" aria-label={translate(t, FOCUS_COPY, 'focus.list.label')}>
      <a className="focus-back" href="/" onClick={linkHandler(navigate, '/')}>{translate(t, FOCUS_COPY, 'focus.list.back')} <kbd className="kbd" aria-hidden="true">Alt Esc</kbd></a>
      <ul className="focus-list-rows">
        {live.map((row, index) => {
          const repo = repoFor(state.data.repos, row.repoId)
          const team = row.role === 'lead' ? teams.find(card => card.lead?.id === row.id) : null
          const label = team?.needs ? translate(t, FOCUS_COPY, 'focus.list.team', { needs: team.needs, total: team.total }) : undefined
          const name = `${shown(repo.name)}, ${label ?? stateLabel(row.state, pillParams(row, now), t)}`
          return (
            <li key={row.id}>
              <a className="focus-list-row" href={href(row.id)} aria-label={name} title={name} aria-current={row.id === sessionId ? 'page' : undefined} onClick={linkHandler(navigate, href(row.id))}>
                <CrewAvatar seed={repo.crewSeed} slot={repo.crewSlot} pose={poseFor(row.state)} hat={repo.hat} size="sm" />
                <span className="focus-list-text">
                  <span className="focus-list-title">{shown(repo.name)}</span>
                  <StatusPill state={team?.needs ? team.state : row.state} label={label} params={pillParams(row, now)} role={row.role} variant="text" t={t} />
                </span>
                {index < 9 ? <kbd className="kbd" aria-hidden="true">{`Alt ${index + 1}`}</kbd> : null}
              </a>
            </li>
          )
        })}
      </ul>
      <a className="focus-launch button button--ghost button--xs" href="/new" onClick={linkHandler(navigate, '/new')}>
        <span className="focus-launch-text">{translate(t, FOCUS_COPY, 'focus.list.launch')}</span> <kbd className="kbd" aria-hidden="true">Alt N</kbd>
      </a>
    </aside>
  )
}

function RequestBar({ request, t }) {
  const tier = tierOf(request)
  const question = tier === 'question'
  return (
    <div className={`focus-request focus-request--${tier}`} role="group" aria-label={question ? titleText(request.summary) : shown(request.summary)}>
      <span className={`tier-badge tier-badge--${tier}`}>{translate(t, CARD_COPY, `tier.${tier}`)}</span>
      {question
        ? <p className="focus-request-summary"><bdi>{titleText(request.summary)}</bdi></p>
        : <code className="focus-request-summary">{shown(request.summary)}</code>}
      <span className="request-terminal">{translate(t, FOCUS_COPY, 'focus.prompt.answerInTerminal')}</span>
    </div>
  )
}

function ActivityLog({ steps, t, lang }) {
  const label = translate(t, FOCUS_COPY, 'focus.log.label')
  if (!steps) {
    return (
      <section className="focus-log" aria-label={label} aria-busy="true">
        <span className="sr-only">{translate(t, FOCUS_COPY, 'focus.log.loading')}</span>
        {[0, 1, 2].map(index => <div key={index} className="focus-log-skeleton motion-shimmer" aria-hidden="true" />)}
      </section>
    )
  }
  const ordered = [...steps].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return (
    <section className="focus-log" aria-label={label}>
      {ordered.length ? (
        <ol className="focus-steps">
          {ordered.map(step => (
            <li key={step.seq} className={`focus-step focus-step--${step.status === 'failed' ? 'error' : step.status === 'running' ? 'waiting' : 'tool'}`}>
              <span className="focus-step-time">{clock(step.at, lang)}</span>
              <span className="focus-step-text">{shown(step.line)}</span>
              {step.adds ? <span className="diff-add">{` +${step.adds}`}</span> : null}
              {step.dels ? <span className="diff-del">{` −${step.dels}`}</span> : null}
            </li>
          ))}
        </ol>
      ) : <p className="focus-log-empty">{translate(t, FOCUS_COPY, 'focus.log.empty')}</p>}
    </section>
  )
}

function Facts({ session, now, t, lang }) {
  const origin = ['wrapped', 'launched', 'observed'].includes(session.origin) ? translate(t, FOCUS_COPY, `focus.facts.origin.${session.origin}`) : shown(session.origin)
  const aliases = Array.isArray(session.sessionAliases) ? session.sessionAliases.length : 0
  const claude = session.claudeSessionId
    ? `${shown(session.claudeSessionId)}${aliases ? ` · ${translate(t, FOCUS_COPY, 'focus.facts.aliases', { n: aliases })}` : ''}`
    : null
  const lastInput = session.lastInputFrom === 'terminal'
    ? (session.lastInputName ? `terminal (${shown(session.lastInputName)})` : 'terminal')
    : session.lastInputFrom === 'browser' ? 'browser' : null
  const baseline = typeof session.reviewBaseline === 'string' && session.reviewBaseline ? shown(session.reviewBaseline) : null
  const rows = [
    ['focus.facts.origin', origin],
    ['focus.facts.started', Number.isFinite(session.startedAt) ? clock(session.startedAt, lang) : null],
    ['focus.facts.duration', Number.isFinite(session.startedAt) ? compactDuration((session.endedAt ?? now) - session.startedAt) : null],
    ['focus.facts.claudeSession', claude],
    ['focus.facts.branch', session.branch ? shown(session.branch) : null],
    ['focus.facts.cwd', session.cwd ? shown(session.cwd) : null],
    ['focus.facts.toolCalls', Number.isFinite(session.toolCalls) ? String(session.toolCalls) : null],
    ['focus.facts.subagents', session.subagentsActive ? String(session.subagentsActive) : null],
    ['focus.facts.lastInput', lastInput],
    ['focus.facts.transcript', session.transcriptPath ? shown(session.transcriptPath) : null],
    ['focus.facts.baseline', baseline ? baseline.slice(0, 12) : null]
  ].filter(([, value]) => value !== null && value !== '')
  return (
    <dl className="focus-facts">
      {rows.map(([key, value]) => (
        <React.Fragment key={key}>
          <dt>{translate(t, FOCUS_COPY, key)}</dt>
          {key === 'focus.facts.baseline' ? <dd title={baseline}>{value}</dd> : <dd>{value}</dd>}
        </React.Fragment>
      ))}
    </dl>
  )
}

function FileList({ files, selectedFile, onSelectFile, t }) {
  const selected = files.some(file => file.path === selectedFile) ? selectedFile : files[0]?.path
  const index = files.findIndex(file => file.path === selected)
  const onKeyDown = event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const next = files[Math.min(files.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    if (next) onSelectFile?.(next.path)
  }
  return (
    <>
      <ul className="focus-files" role="listbox" tabIndex={0} aria-label={translate(t, FOCUS_COPY, 'focus.changes.label')}
        aria-activedescendant={index >= 0 ? `focus-file-${index}` : undefined} onKeyDown={onKeyDown}>
        {files.map((file, at) => (
          <li key={file.path} id={`focus-file-${at}`} className="focus-file" role="option" aria-selected={at === index ? 'true' : 'false'}
            onClick={() => onSelectFile?.(file.path)}>
            <span className="focus-file-path">{shown(file.path)}</span>
            {file.adds ? <span className="diff-add">{` +${file.adds}`}</span> : null}
            {file.dels ? <span className="diff-del">{` −${file.dels}`}</span> : null}
          </li>
        ))}
      </ul>
      <p className="focus-diff-caption">{translate(t, FOCUS_COPY, 'focus.changes.caption')}</p>
    </>
  )
}

function Details({ session, tab, onTab, now, t, lang, selectedFile, onSelectFile }) {
  const files = session.changedFiles ?? []
  const labels = {
    changes: `${translate(t, FOCUS_COPY, 'focus.tabs.changes')}${files.length ? ` ${files.length}` : ''}`,
    facts: translate(t, FOCUS_COPY, 'focus.tabs.facts')
  }
  const onKeyDown = event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    onTab(TABS[(TABS.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length])
  }
  return (
    <aside className="focus-details" id="focus-details" aria-label={translate(t, FOCUS_COPY, 'focus.tabs.label')}>
      <div className="focus-tabs" role="tablist" aria-label={translate(t, FOCUS_COPY, 'focus.tabs.label')} onKeyDown={onKeyDown}>
        {TABS.map(id => (
          <button key={id} type="button" className="focus-tab" role="tab" id={`focus-tab-${id}`} aria-selected={tab === id ? 'true' : 'false'} aria-controls="focus-panel"
            tabIndex={tab === id ? 0 : -1} onClick={() => onTab(id)}>{labels[id]}</button>
        ))}
      </div>
      <div className="focus-panel" role="tabpanel" id="focus-panel" aria-labelledby={`focus-tab-${tab}`}>
        {tab === 'facts' ? <Facts session={session} now={now} t={t} lang={lang} /> : files.length
          ? <FileList files={files} selectedFile={selectedFile} onSelectFile={onSelectFile} t={t} />
          : <EmptyState kind="focusChanges" t={t} />}
      </div>
    </aside>
  )
}

function CrashBanner({ session, t, deckdDown, reasonId, onRelaunch, onDismiss }) {
  const line = session.crashKind === 'lost' || (session.exitCode == null && !session.exitSignal)
    ? translate(t, FOCUS_COPY, 'focus.crash.lost')
    : Number.isFinite(session.exitCode) ? translate(t, FOCUS_COPY, 'focus.crash.exit', { code: session.exitCode }) : null
  return (
    <div className="focus-banner focus-banner--error">
      <StatusPill state="crashed" params={pillParams(session, 0)} t={t} />
      {line ? <span className="focus-banner-text">{line}</span> : null}
      <span className="focus-banner-actions">
        <button type="button" className="button button--primary button--xs" disabled={deckdDown} aria-describedby={deckdDown ? reasonId : undefined} onClick={onRelaunch}>
          {translate(t, FOCUS_COPY, 'focus.crash.relaunch')}
        </button>
        <button type="button" className="button button--ghost button--xs" onClick={onDismiss}>{translate(t, FOCUS_COPY, 'focus.crash.dismiss')}</button>
      </span>
    </div>
  )
}

/**
 * Focus (focus.md): session list, header, and either the live terminal (PTY sessions, M2) or the M1 read-only
 * layout (observed sessions: activity log from hook steps, "Answer in your terminal" bars, no terminal, no Stop or
 * Nudge). A live PTY session gets TerminalView with the screen's terminal `client`, focused on open; an ended or
 * crashed one gets a read-only TerminalView filled from `scrollback`. A PTY session's header carries the input
 * indicator, the collision chip, the leave hint, Hide panel and Stop… (an observed one keeps the M1 header); while deckd is down the terminal input and Stop are
 * disabled with the reason "deckd is reconnecting". The details panel lists changed files as a listbox and the
 * Facts rows of FOC-O3. Pure: no hooks, so tests can walk it (TerminalView and ConfirmDialog hold the hooks).
 * @param {{
 *   state: object, sessionId: string, t?: Function, now?: number, lang?: string, navigate: (to: string) => void,
 *   steps: object[] | null, tab: 'changes'|'facts', onTab: (tab: string) => void, onMarkReviewed?: () => void,
 *   reviewing?: boolean, reviewError?: string | null, client?: object | null, scrollback?: string | null,
 *   terminalFocused?: boolean, onTerminalFocus?: (focused: boolean) => void, collision?: boolean,
 *   panelOpen?: boolean, drawerOpen?: boolean, onTogglePanel?: () => void, confirming?: boolean,
 *   onStop?: () => void, onConfirmStop?: () => void, onCancelStop?: () => void, onNudge?: () => void,
 *   onRelaunch?: () => void, onDismiss?: () => void, stopError?: string | null,
 *   selectedFile?: string | null, onSelectFile?: (path: string) => void,
 *   confirmLink?: (url: string) => boolean, confirmPaste?: (size: string) => boolean | Promise<boolean>
 * }} props
 */
export function FocusView({
  state, sessionId, t, now = Date.now(), lang = 'en', navigate, steps, tab, onTab, onMarkReviewed, reviewing = false, reviewError = null,
  client = null, scrollback = null, terminalFocused = false, onTerminalFocus, collision, panelOpen = true, drawerOpen = false, onTogglePanel,
  confirming = false, onStop, onConfirmStop, onCancelStop, onNudge, onRelaunch, onDismiss, stopError = null, selectedFile = null, onSelectFile,
  confirmLink, confirmPaste
}) {
  const session = state.data.sessions.find(row => row.id === sessionId)
  if (!session) {
    return (
      <section className="focus focus--missing">
        <h1 className="page-title">{translate(t, FOCUS_COPY, 'focus.notFound.title')}</h1>
        <a className="button button--ghost" href="/" onClick={linkHandler(navigate, '/')}>{translate(t, FOCUS_COPY, 'focus.list.back')}</a>
      </section>
    )
  }
  const repo = repoFor(state.data.repos, session.repoId)
  const open = (state.data.requests ?? []).filter(row => row.sessionId === session.id && (row.state ?? 'open') === 'open')
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const waiting = NEEDS.has(session.state) && open.length
    ? translate(t, FOCUS_COPY, 'focus.header.waiting', { state: stateLabel(session.state, {}, t), duration: compactDuration(now - (open[0].createdAt ?? now)) })
    : undefined
  const task = session.task || translate(t, CARD_COPY, 'home.card.untitled')
  const title = titleText(task)
  const runHref = session.role === 'lead' && session.runRef ? `/runs/${encodeURIComponent(repo.name)}/${encodeURIComponent(session.runRef.runId)}` : null
  const pty = isPty(session)
  const live = isLive(session)
  const deckd = deckdOf(state)
  const source = state.data.inputSources?.[session.id] ?? null
  const chip = collision ?? source?.state === 'collision'
  const reasonId = `focus-deckd-reason-${session.id}`
  const panelLabel = translate(t, FOCUS_COPY, panelOpen ? 'focus.header.hidePanel' : 'focus.header.showPanel')
  const starting = session.state === 'starting' && Number.isFinite(session.stateSince) && now - session.stateSince > START_HINT_MS
  const classes = ['focus', panelOpen ? null : 'focus--panel-hidden', drawerOpen ? 'focus--drawer-open' : null].filter(Boolean).join(' ')
  const terminalLabel = `${shown(repo.name)} · ${task}`
  return (
    <div className={classes}>
      <SessionList state={state} sessionId={session.id} now={now} t={t} navigate={navigate} />
      <section className="focus-main" aria-labelledby="focus-title">
        <header className="focus-header">
          <CrewAvatar seed={repo.crewSeed} slot={repo.crewSlot} pose={poseFor(session.state)} hat={repo.hat} size="md" />
          <div className="focus-heading">
            <h1 className="focus-title" id="focus-title" title={title}><bdi>{title}</bdi></h1>
            <MetaLine className="focus-subtitle" items={[shown(repo.name), session.branch ? shown(session.branch) : null, session.cwd ? shown(session.cwd) : null]} />
          </div>
          <StatusPill state={session.state} label={waiting} params={pillParams(session, now)} role={session.role} t={t} />
          {pty ? <InputIndicator session={session} source={source} collision={chip} t={t} /> : null}
          {pty && terminalFocused ? <span className="focus-leave-hint">{translate(t, FOCUS_COPY, 'focus.header.leaveHint')}</span> : null}
          <div className="focus-actions">
            {runHref ? <a className="button button--ghost button--xs" href={runHref} onClick={linkHandler(navigate, runHref)}>{translate(t, FOCUS_COPY, 'focus.header.openRun')}</a> : null}
            {session.state === 'done'
              ? <button type="button" className="button button--purple button--xs" disabled={reviewing} onClick={onMarkReviewed}>{translate(t, FOCUS_COPY, 'focus.header.markReviewed')}</button>
              : null}
            {pty ? (
              <button type="button" className="button button--secondary button--xs" aria-pressed={panelOpen ? 'false' : 'true'} aria-controls="focus-details" onClick={onTogglePanel}>
                {panelLabel}<kbd className="kbd" aria-hidden="true">Alt I</kbd>
              </button>
            ) : null}
            {live
              ? <button type="button" className="button button--danger button--xs" disabled={deckd.down} aria-describedby={deckd.down ? reasonId : undefined} onClick={onStop}>{translate(t, FOCUS_COPY, 'focus.header.stop')}</button>
              : null}
          </div>
        </header>
        {pty && deckd.down ? <p className="focus-reason" id={reasonId}>{translate(t, FOCUS_COPY, 'focus.prompt.deckdDown')}</p> : null}
        {reviewError ? <p className="focus-error" role="alert">{translate(t, FOCUS_COPY, 'focus.header.reviewFailed')}</p> : null}
        {stopError ? <p className="focus-error" role="alert">{stopError}</p> : null}
        {session.origin === 'observed' ? <p className="focus-banner focus-banner--info">{translate(t, FOCUS_COPY, 'focus.observed.banner')}</p> : null}
        {session.state === 'stale' ? (
          <p className="focus-banner focus-banner--hint">
            {translate(t, FOCUS_COPY, 'focus.stale.line', { time: clock(session.lastActivityAt ?? session.stateSince, lang) })}
            {live ? (
              <> <button type="button" className="button button--amber-outline button--xs" disabled={deckd.down} aria-describedby={deckd.down ? reasonId : undefined} onClick={onNudge}>
                {translate(t, FOCUS_COPY, 'focus.stale.nudge')}
              </button></>
            ) : null}
          </p>
        ) : null}
        {pty && session.state === 'crashed' ? <CrashBanner session={session} t={t} deckdDown={deckd.down} reasonId={reasonId} onRelaunch={onRelaunch} onDismiss={onDismiss} /> : null}
        {starting ? <p className="focus-banner focus-banner--hint">{translate(t, FOCUS_COPY, 'focus.starting.hint')}</p> : null}
        {session.joinedMidLife ? <p className="focus-banner focus-banner--info">{translate(t, FOCUS_COPY, 'focus.joinedLate', { time: clock(session.startedAt, lang) })}</p> : null}
        {!pty ? <ActivityLog steps={steps} t={t} lang={lang} /> : live ? (
          <div className="focus-terminal">
            <TerminalView key={`live:${session.id}`} sessionId={session.id} label={terminalLabel} readOnly={deckd.down} deckdUp={deckd.up}
              screenReaderMode={!!state.data.prefs?.terminalScreenReader} client={client} autoFocus onFocusChange={onTerminalFocus}
              confirmLink={confirmLink ?? (() => false)} confirmPaste={confirmPaste} t={t} />
          </div>
        ) : (
          <div className="focus-terminal">
            <TerminalView key={`history:${session.id}:${scrollback === null ? 'wait' : 'ready'}`} sessionId={session.id} label={terminalLabel} readOnly
              screenReaderMode={!!state.data.prefs?.terminalScreenReader} client={null} initialText={scrollback ?? ''} confirmLink={confirmLink ?? (() => false)} t={t} />
          </div>
        )}
        {open.map(request => <RequestBar key={request.id} request={request} t={t} />)}
      </section>
      <Details session={session} tab={tab} onTab={onTab} now={now} t={t} lang={lang} selectedFile={selectedFile} onSelectFile={onSelectFile} />
      {confirming ? (
        <ConfirmDialog title={translate(t, FOCUS_COPY, 'focus.stop.title', { repo: shown(repo.name), task })} body={translate(t, FOCUS_COPY, 'focus.stop.body')}
          confirmLabel={translate(t, FOCUS_COPY, 'focus.stop.confirm')} cancelLabel={translate(t, FOCUS_COPY, 'focus.stop.cancel')} tone="danger"
          onConfirm={onConfirmStop} onCancel={onCancelStop} t={t} />
      ) : null}
    </div>
  )
}

const narrow = () => !!globalThis.matchMedia?.(NARROW).matches

/**
 * The Focus route screen for the shell's `screens` map. Loads hook steps (observed sessions) or the scrollback
 * of an ended PTY session, keeps the tab, file selection, panel (`deck.focus.panel`, `Alt I` through a window
 * capture-phase listener; at 1280 px and below it opens the details as an overlay drawer), the collision chip
 * for 3 s, the Stop dialog and the link and paste dialogs, and opens the Needs-you drawer once for a D-69
 * `?needs=` link. `client` is the terminal client (Task 14 wires it); `dispatch` takes the store's `toast.push`.
 * This browser wiring is not exercised by the unit tests; {@link FocusView} and the exported helpers are.
 * @param {{ route: { params: { sessionId: string } }, state: object, t?: Function, navigate: (to: string) => void, api?: object,
 *   search?: string, client?: object | null, dispatch?: (action: object) => void,
 *   onOverlay?: (overlay: 'drawer', detail: object) => void }} props
 */
export function Focus({ route, state, t, navigate, api, search = globalThis.location?.search ?? '', client = null, dispatch,
  onOverlay = (overlay, detail) => openOverlay(overlay, globalThis.window, detail) }) {
  const id = route.params.sessionId
  const minute = useMinuteNow()
  const [tick, setTick] = useState(0)
  const http = api ?? deckApi()
  const session = state.data.sessions.find(row => row.id === id)
  const [steps, setSteps] = useState(null)
  const params = new URLSearchParams(search)
  const wanted = params.get('tab') === 'facts' ? 'facts' : 'changes'
  const [tab, setTab] = useState(wanted)
  const [selectedFile, setSelectedFile] = useState(() => params.get('file'))
  const [reviewing, setReviewing] = useState(false)
  const [reviewError, setReviewError] = useState(null)
  const [stopError, setStopError] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [scrollback, setScrollback] = useState(null)
  const [terminalFocused, setTerminalFocused] = useState(false)
  const [collision, setCollision] = useState(false)
  const [panelOpen, setPanelOpen] = useState(() => readPanel(globalThis.localStorage))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [linkAsk, setLinkAsk] = useState(null)
  const [pasteAsk, setPasteAsk] = useState(null)
  const needsOpened = useRef(false)
  const known = !!session
  const observed = known && !isPty(session)
  const history = known && isPty(session) && !isLive(session)
  const activity = session?.lastActivityAt
  const sourceState = state.data.inputSources?.[id]?.state
  const sourceFrom = state.data.inputSources?.[id]?.from
  const repoName = session ? repoFor(state.data.repos, session.repoId).name : ''
  const now = Math.max(minute, tick)

  useEffect(() => { setSteps(null) }, [id])
  // A followed link such as `?tab=changes` selects its tab even when this Focus instance stays mounted.
  useEffect(() => { setTab(wanted) }, [wanted, search])
  useEffect(() => {
    if (!observed) return undefined
    let current = true
    http.get(`/api/sessions/${seg(id)}/steps`).then(data => { if (current) setSteps(data?.steps ?? []) }).catch(() => { if (current) setSteps([]) })
    return () => { current = false }
  }, [http, id, observed, activity])
  useEffect(() => {
    if (!history) return undefined
    let current = true
    setScrollback(null)
    loadScrollback(http, id).then(data => { if (current) setScrollback(data?.text ?? '') }).catch(() => { if (current) setScrollback('') })
    return () => { current = false }
  }, [http, id, history])
  // D-69: a `?needs=` link opens the drawer once, on mount.
  useEffect(() => {
    if (needsOpened.current) return
    needsOpened.current = true
    openNeedsFilter(search, onOverlay)
  }, [])
  // The collision chip shows for 3 s from the moment the input machine reports a collision, even when the
  // machine settles first: leaving 'collision' does not cancel the timer that hides it. During a sustained collision
  // the machine re-emits 'collision' with a flipped `from` on each crossing, and each one re-arms the 3 s.
  const chipTimer = useRef(null)
  useEffect(() => {
    if (sourceState !== 'collision') return
    setCollision(true)
    clearTimeout(chipTimer.current)
    chipTimer.current = setTimeout(() => setCollision(false), COLLISION_CHIP_MS)
  }, [sourceState, sourceFrom, id])
  // Switching sessions (or leaving Focus) drops the chip and its timer; this cleanup runs before the effect above.
  useEffect(() => () => {
    clearTimeout(chipTimer.current)
    chipTimer.current = null
    setCollision(false)
  }, [id])
  // The "No signal from hooks yet" hint appears 30 s into `starting`, not at the next minute tick.
  const startAt = session?.state === 'starting' ? session.stateSince : null
  useEffect(() => {
    if (!Number.isFinite(startAt)) return undefined
    const timer = setTimeout(() => setTick(Date.now()), Math.max(0, startAt + START_HINT_MS + 1 - Date.now()))
    return () => clearTimeout(timer)
  }, [startAt])
  const togglePanel = () => {
    if (narrow()) { setDrawerOpen(value => !value)
      return }
    setPanelOpen(value => {
      writePanel(globalThis.localStorage, !value)
      return !value
    })
  }
  const toggleRef = useRef(togglePanel)
  toggleRef.current = togglePanel
  // The shell only reports Alt I; Focus owns the panel, so it listens in the capture phase like the shell.
  useEffect(() => {
    const onKey = event => { if (isPanelKey(event)) toggleRef.current() }
    globalThis.window?.addEventListener('keydown', onKey, true)
    return () => globalThis.window?.removeEventListener('keydown', onKey, true)
  }, [])

  const toast = item => {
    if (dispatch) dispatch({ type: 'toast.push', ...item })
    else setStopError(item.title)
  }
  const actions = focusActions({ api: http, id, set: patch => setConfirming(patch.confirming), toast, repo: repoName, t })
  const onMarkReviewed = () => {
    setReviewing(true)
    setReviewError(null)
    markReviewed(http, id).catch(error => setReviewError(error?.code ?? 'failed')).finally(() => setReviewing(false))
  }
  const confirmLink = url => { setLinkAsk(url)
    return false }
  const confirmPaste = size => new Promise(resolve => setPasteAsk({ size, resolve }))
  const answerPaste = ok => { pasteAsk?.resolve(ok)
    setPasteAsk(null) }
  return (
    <>
      <FocusView state={state} sessionId={id} t={t} now={now} navigate={navigate} steps={steps} tab={tab} onTab={setTab}
        onMarkReviewed={onMarkReviewed} reviewing={reviewing} reviewError={reviewError} client={client} scrollback={scrollback}
        terminalFocused={terminalFocused} onTerminalFocus={setTerminalFocused} collision={collision} panelOpen={panelOpen} drawerOpen={drawerOpen}
        onTogglePanel={togglePanel} confirming={confirming} onStop={() => { setStopError(null)
          actions.openStop() }} onConfirmStop={actions.confirmStop} onCancelStop={actions.cancelStop}
        onNudge={actions.nudge} onRelaunch={actions.relaunch} onDismiss={actions.dismiss} stopError={stopError}
        selectedFile={selectedFile} onSelectFile={setSelectedFile} confirmLink={confirmLink} confirmPaste={confirmPaste} />
      {linkAsk ? (
        <ConfirmDialog title={translate(t, FOCUS_COPY, 'focus.link.title')} body={linkAsk} confirmLabel={translate(t, FOCUS_COPY, 'focus.link.confirm')}
          cancelLabel={translate(t, FOCUS_COPY, 'focus.stop.cancel')} onCancel={() => setLinkAsk(null)}
          onConfirm={() => { globalThis.open?.(linkAsk, '_blank', 'noopener,noreferrer')
            setLinkAsk(null) }} t={t} />
      ) : null}
      {pasteAsk ? (
        <ConfirmDialog title={translate(t, FOCUS_COPY, 'focus.paste.title', { size: pasteAsk.size, repo: shown(repoName) })} body={translate(t, FOCUS_COPY, 'focus.paste.body')}
          confirmLabel={translate(t, FOCUS_COPY, 'focus.paste.confirm')} cancelLabel={translate(t, FOCUS_COPY, 'focus.stop.cancel')}
          onCancel={() => answerPaste(false)} onConfirm={() => answerPaste(true)} t={t} />
      ) : null}
      <ObserveOverlays state={state} t={t} navigate={navigate} api={api} />
    </>
  )
}
