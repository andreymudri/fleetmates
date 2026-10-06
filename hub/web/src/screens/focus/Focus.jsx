import React, { useEffect, useRef, useState } from 'react'
import { ArchiveToast, CARD_COPY, archiveFlow, isArchived, useArchiveToast } from '../../components/SessionCard.jsx'
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx'
import { CrewAvatar, poseFor } from '../../components/CrewAvatar.jsx'
import { DiffView } from '../../components/DiffView.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { PromptBar, promptKeyBody } from '../../components/PromptBar.jsx'
import { MetaLine, StatusPill, compactDuration, pillParams, shown, stateLabel, titleText, translate } from '../../components/StatusPill.jsx'
import { TerminalView } from '../../components/TerminalView.jsx'
import { Citation } from '../../components/Citation.jsx'
import { NoteChip } from '../../components/NoteChip.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { answerRequest, fetchDiff, fetchScrollback, fetchSessionMemory, nudgeSession, relaunchSession, stopSession } from '../../state/actions.js'
import { parseNeedsFilter } from '../../state/deck-store.js'
import { ObserveOverlays, teamCards, useMinuteNow } from '../home/Home.jsx'
import { deckApi, openOverlay, repoFor, tierOf } from '../drawer/NeedsYouDrawer.jsx'
import { orderSessions } from '../palette/Palette.jsx'
import { LedgerTimeline } from '../../components/FleetProgress.mjs'

/**
 * English copy for Focus (docs/deck/screens/focus.md section 9): the M1 read-only layout (MS-O1), the M2
 * terminal, header and actions, and the M3 PromptBar and Changes diff. Keys the copy deck does not name carry
 * their source in a comment.
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
  'focus.prompt.note': 'Same prompt as the terminal, same keys',
  // The copy deck's `focus.prompt.answerInTerminal` text; that key keeps the M1 observed-bar wording above.
  'focus.prompt.parseFailed': 'Answer in the terminal',
  'focus.prompt.guardTyping': 'You are typing in the terminal. Answer there, or try again in a second.',
  // The drawer's "Sent · checking…" (needs-you-drawer.md section 9); the Focus copy deck has no verifying line.
  'focus.prompt.sent': 'Sent · checking…',
  'focus.prompt.didNotLand': 'Your answer did not reach {repo}. The prompt is still open in its terminal.',
  'focus.prompt.tryAgain': 'Try again',
  'focus.question.reply': 'Reply',
  // No copy deck names the Focus reply field's placeholder; the drawer's (needs-you-drawer.md section 9).
  'focus.question.replyPlaceholder': 'Reply to {repo}',
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
  'focus.changes.diffCaption': '{path} · unified (panel is narrow)',
  'focus.changes.diffError': 'Could not read the diff: {message}',
  // focus.md 5.3 "Retry"; the same text as `focus.terminal.retry`.
  'focus.changes.retry': 'Retry',
  // components.md 40 DiffView states.
  'focus.changes.binary': 'Binary file, {size}. Open in editor.',
  'focus.changes.fileEmpty': 'No changes in this file.',
  // M3 plan Task 15 asks for a note when the diff is truncated; no copy deck names it yet.
  'focus.changes.truncated': 'Diff truncated: too large to show in full.',
  'focus.changes.loading': 'Loading the diff',
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
  'focus.notFound.title': 'This session is not on the deck.',
  'focus.header.archive': 'Archive',
  'focus.header.unarchive': 'Unarchive',
  'focus.archived.banner': 'Archived. Unarchive to bring it back to Home.',
  'focus.archived.unarchive': 'Unarchive'
})

const NEEDS = new Set(['needs_approval', 'asked_you'])
export const TABS = ['changes', 'facts', 'memory']
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

/**
 * Read one changed file's diff for the Changes tab (`GET /api/sessions/:id/diff?path=`).
 * @param {{ get: Function }} api
 * @param {string} id
 * @param {string} path repo-relative
 * @returns {Promise<{ path: string, baseline: string | null, diff: string, binary: boolean, truncated: boolean, size?: number }>}
 */
export function loadDiff(api, id, path) {
  return fetchDiff(api, id, path)
}

/**
 * The open request the PromptBar mirrors: the one the server matched to the prompt on the PTY screen
 * (`screenMatch: 'on_screen'`), or null.
 * @param {object[]} open the session's open requests
 * @returns {object | null}
 */
export function onScreenRequest(open) {
  return open.find(request => request.screenMatch === 'on_screen') ?? null
}

/**
 * The file the Changes tab shows: the selected path while it is still among the changed files, else the first.
 * @param {{ path: string }[]} files
 * @param {string | null} selected
 * @returns {string | null}
 */
export function shownFile(files, selected) {
  return files.some(file => file.path === selected) ? selected : files[0]?.path ?? null
}

const promptLabels = t => ({
  note: translate(t, FOCUS_COPY, 'focus.prompt.note'),
  answerInTheTerminal: translate(t, FOCUS_COPY, 'focus.prompt.parseFailed'),
  deckdDown: translate(t, FOCUS_COPY, 'focus.prompt.deckdDown'),
  guardTyping: translate(t, FOCUS_COPY, 'focus.prompt.guardTyping'),
  sent: translate(t, FOCUS_COPY, 'focus.prompt.sent'),
  didNotLand: FOCUS_COPY['focus.prompt.didNotLand'],
  tryAgain: translate(t, FOCUS_COPY, 'focus.prompt.tryAgain'),
  replyLabel: translate(t, FOCUS_COPY, 'focus.question.reply'),
  replyPlaceholder: FOCUS_COPY['focus.question.replyPlaceholder'],
  reply: translate(t, FOCUS_COPY, 'focus.question.reply')
})

const diffLabels = t => ({
  caption: FOCUS_COPY['focus.changes.diffCaption'],
  error: FOCUS_COPY['focus.changes.diffError'],
  retry: translate(t, FOCUS_COPY, 'focus.changes.retry'),
  binary: FOCUS_COPY['focus.changes.binary'],
  truncated: translate(t, FOCUS_COPY, 'focus.changes.truncated'),
  empty: translate(t, FOCUS_COPY, 'focus.changes.fileEmpty'),
  loading: translate(t, FOCUS_COPY, 'focus.changes.loading')
})

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
  const live = orderSessions(state.data.sessions.filter(row => row.state !== 'ended' && !isArchived(row)), state.data.order, state.data.requests)
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

function FileList({ files, selectedFile, onSelectFile, diff, onRetryDiff, t }) {
  const selected = shownFile(files, selectedFile)
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
      {selected ? <DiffView path={selected} state={diff?.path === selected ? diff : { status: 'loading' }} onRetry={onRetryDiff} labels={diffLabels(t)} /> : null}
    </>
  )
}

export function FocusMemory({ memory, down, navigate }) {
  return <section aria-label="Related memory"><h3>Related memory</h3>
    {down ? <p>Memory is unavailable: vault-mcp is not answering.</p> : !memory ? <p aria-busy="true">Searching your vault…</p> : memory.related?.length ? memory.related.slice(0, 3).map((hit, i) => <Citation key={i} {...hit} variant="callout" navigate={navigate} />) : <p>Nothing in your vault matches this task yet.</p>}
    <h3>Read</h3>{memory?.read?.map((note, i) => <NoteChip key={i} {...note} navigate={navigate} />)}
    <h3>Learned</h3>{memory?.learned?.map((note, i) => <NoteChip key={i} {...note} variant="learned" navigate={navigate} />)}
  </section>
}
function Details({ session, tab, onTab, now, t, lang, selectedFile, onSelectFile, diff, onRetryDiff, memory, memoryDown, navigate }) {
  const files = session.changedFiles ?? []
  const labels = {
    changes: `${translate(t, FOCUS_COPY, 'focus.tabs.changes')}${files.length ? ` ${files.length}` : ''}`,
    facts: translate(t, FOCUS_COPY, 'focus.tabs.facts'),
    memory: `Memory${memory?.related?.length ? ` ${memory.related.length}` : ''}`
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
        {tab === 'memory' ? <FocusMemory memory={memory} down={memoryDown} navigate={navigate} /> : tab === 'facts' ? <Facts session={session} now={now} t={t} lang={lang} /> : files.length
          ? <FileList files={files} selectedFile={selectedFile} onSelectFile={onSelectFile} diff={diff} onRetryDiff={onRetryDiff} t={t} />
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
 * disabled with the reason "deckd is reconnecting". A PTY session's on-screen request gets the PromptBar (its
 * other open requests keep the "Answer in your terminal" bar). The details panel lists changed files as a
 * listbox with the selected file's DiffView under it, and the Facts rows of FOC-O3. The header offers "Archive"
 * when `onArchive` is given, or "Unarchive" (`onUnarchive`) for an archived session, which also gets the banner
 * "Archived. Unarchive to bring it back to Home." with Unarchive, a read-only terminal, no PromptBar (its open
 * requests keep the "Answer in your terminal" bar), and no Stop or Nudge even while it is live. The session
 * list skips archived sessions. `fallback` is a session row to show when the store does not hold `sessionId`
 * (an older archived session). Pure: no hooks, so tests can walk it (TerminalView, ConfirmDialog and
 * PromptReply hold the hooks).
 * @param {{
 *   state: object, sessionId: string, t?: Function, now?: number, lang?: string, navigate: (to: string) => void,
 *   steps: object[] | null, tab: 'changes'|'facts', onTab: (tab: string) => void, onMarkReviewed?: () => void,
 *   reviewing?: boolean, reviewError?: string | null, client?: object | null, scrollback?: string | null,
 *   terminalFocused?: boolean, onTerminalFocus?: (focused: boolean) => void, collision?: boolean,
 *   panelOpen?: boolean, drawerOpen?: boolean, onTogglePanel?: () => void, confirming?: boolean,
 *   onStop?: () => void, onConfirmStop?: () => void, onCancelStop?: () => void, onNudge?: () => void,
 *   onRelaunch?: () => void, onDismiss?: () => void, stopError?: string | null,
 *   selectedFile?: string | null, onSelectFile?: (path: string) => void,
 *   confirmLink?: (url: string) => boolean, confirmPaste?: (size: string) => boolean | Promise<boolean>,
 *   diff?: { path: string, status: 'loading' | 'error' | 'ready', data?: object, message?: string } | null, onRetryDiff?: () => void,
 *   answer?: { requestId: string, busy: object | null, guard: 'typing' | 'refused' | null } | null, confirmed?: boolean,
 *   onConfirm?: (checked: boolean) => void, onAnswer?: (request: object, body: object) => void,
 *   onArchive?: () => void, onUnarchive?: () => void, fallback?: object | null
 * }} props
 */
export function FocusView({
  state, sessionId, t, now = Date.now(), lang = 'en', navigate, steps, tab, onTab, onMarkReviewed, reviewing = false, reviewError = null,
  client = null, scrollback = null, terminalFocused = false, onTerminalFocus, collision, panelOpen = true, drawerOpen = false, onTogglePanel,
  confirming = false, onStop, onConfirmStop, onCancelStop, onNudge, onRelaunch, onDismiss, stopError = null, selectedFile = null, onSelectFile,
  confirmLink, confirmPaste, diff = null, onRetryDiff, answer = null, confirmed = false, onConfirm, onAnswer = () => {},
  onArchive, onUnarchive, fallback = null, memory = null, timeline = null
}) {
  const session = state.data.sessions.find(row => row.id === sessionId) ?? (fallback?.id === sessionId ? fallback : undefined)
  if (!session) {
    return (
      <section className="focus-screen focus--missing">
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
  const archived = isArchived(session)
  // Stop and Nudge act on a live session that is not archived; an archived one is read-only here.
  const controls = live && !archived
  const deckd = deckdOf(state)
  const source = state.data.inputSources?.[session.id] ?? null
  const chip = collision ?? source?.state === 'collision'
  const reasonId = `focus-deckd-reason-${session.id}`
  const panelLabel = translate(t, FOCUS_COPY, panelOpen ? 'focus.header.hidePanel' : 'focus.header.showPanel')
  const starting = session.state === 'starting' && Number.isFinite(session.stateSince) && now - session.stateSince > START_HINT_MS
  const classes = ['focus-screen', panelOpen ? null : 'focus--panel-hidden', drawerOpen ? 'focus--drawer-open' : null].filter(Boolean).join(' ')
  const terminalLabel = `${shown(repo.name)} · ${task}`
  const prompt = onScreenRequest(open)
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
            {archived && onUnarchive
              ? <button type="button" className="button button--secondary button--xs" onClick={onUnarchive}>{translate(t, FOCUS_COPY, 'focus.header.unarchive')}</button>
              : null}
            {!archived && onArchive
              ? <button type="button" className="button button--ghost button--xs" onClick={onArchive}>{translate(t, FOCUS_COPY, 'focus.header.archive')}</button>
              : null}
            {controls
              ? <button type="button" className="button button--danger button--xs" disabled={deckd.down} aria-describedby={deckd.down ? reasonId : undefined} onClick={onStop}>{translate(t, FOCUS_COPY, 'focus.header.stop')}</button>
              : null}
          </div>
        </header>
        {pty && deckd.down ? <p className="focus-reason" id={reasonId}>{translate(t, FOCUS_COPY, 'focus.prompt.deckdDown')}</p> : null}
        {reviewError ? <p className="focus-error" role="alert">{translate(t, FOCUS_COPY, 'focus.header.reviewFailed')}</p> : null}
        {stopError ? <p className="focus-error" role="alert">{stopError}</p> : null}
        {archived ? (
          <p className="focus-banner focus-banner--archived">
            <span className="focus-banner-text">{translate(t, FOCUS_COPY, 'focus.archived.banner')}</span>
            {onUnarchive ? <>{' '}<button type="button" className="button button--secondary button--xs" onClick={onUnarchive}>{translate(t, FOCUS_COPY, 'focus.archived.unarchive')}</button></> : null}
          </p>
        ) : null}
        {session.origin === 'observed' ? <p className="focus-banner focus-banner--info">{translate(t, FOCUS_COPY, 'focus.observed.banner')}</p> : null}
        {session.state === 'stale' ? (
          <p className="focus-banner focus-banner--hint">
            {translate(t, FOCUS_COPY, 'focus.stale.line', { time: clock(session.lastActivityAt ?? session.stateSince, lang) })}
            {controls ? (
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
            <TerminalView key={`live:${session.id}`} sessionId={session.id} label={terminalLabel} readOnly={deckd.down || archived} deckdUp={deckd.up}
              screenReaderMode={!!state.data.prefs?.terminalScreenReader} client={client} autoFocus onFocusChange={onTerminalFocus}
              confirmLink={confirmLink ?? (() => false)} confirmPaste={confirmPaste} t={t} />
          </div>
        ) : (
          <div className="focus-terminal">
            <TerminalView key={`history:${session.id}:${scrollback === null ? 'wait' : 'ready'}`} sessionId={session.id} label={terminalLabel} readOnly
              screenReaderMode={!!state.data.prefs?.terminalScreenReader} client={null} initialText={scrollback ?? ''} confirmLink={confirmLink ?? (() => false)} t={t} />
          </div>
        )}
        {open.map(request => pty && !archived && request === prompt ? (
          <PromptBar key={request.id} request={request} session={session} deckd={deckd} labels={promptLabels(t)} confirmed={confirmed} onConfirm={onConfirm} lang={lang}
            onAnswer={body => onAnswer(request, body)} busy={answer?.requestId === request.id ? answer.busy : null} guard={answer?.requestId === request.id ? answer.guard : null}
            badge={<span className={`tier-badge tier-badge--${tierOf(request)}`}>{translate(t, CARD_COPY, `tier.${tierOf(request)}`)}</span>} />
        ) : <RequestBar key={request.id} request={request} t={t} />)}
      </section>
      <Details session={session} tab={tab} onTab={onTab} now={now} t={t} lang={lang} selectedFile={selectedFile} onSelectFile={onSelectFile} diff={diff} onRetryDiff={onRetryDiff} memory={memory} memoryDown={['down', 'unknown'].includes(state.memory?.vault.state)} navigate={navigate} />
      {session.runRef ? <LedgerTimeline timeline={timeline} lang={lang} /> : null}
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
 * `?needs=` link. It loads the selected changed file's diff (again when the file's counts change, or on
 * Retry), posts PromptBar answers, keeps the Destructive checkbox per request and summary, and turns `1`, `2`
 * and `3` typed outside the terminal into answers through {@link promptKeyBody}, except on an archived session.
 * `client` is the terminal client (Task 14 wires it); `dispatch` takes the store's `toast.push`.
 * Archive and Unarchive run through `archiveFlow` with their own Undo toast, also for the palette's "Archive session".
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
  const stored = state.data.sessions.find(row => row.id === id)
  // An archived session older than the snapshot's window is not in the store; the Archived list's Open link
  // still reaches it, so Focus reads the row itself (`GET /api/sessions/:id`).
  const [fallback, setFallback] = useState(null)
  useEffect(() => {
    if (stored) return undefined
    let current = true
    http.get(`/api/sessions/${seg(id)}`).then(data => { if (current && data?.session) setFallback(data.session) }, () => {})
    return () => { current = false }
  }, [http, id, !!stored])
  const session = stored ?? (fallback?.id === id ? fallback : undefined)
  const [archiveToast, showArchiveToast] = useArchiveToast()
  const flow = archiveFlow({ api: http, show: showArchiveToast, t })
  const [steps, setSteps] = useState(null)
  const [timeline, setTimeline] = useState(null)
  const timelineRun = state.data.runs?.find(run => run.repoId === session?.runRef?.repoId && run.runId === session?.runRef?.runId)
  useEffect(() => {
    let active = true; setTimeline(null)
    if (session?.runRef) http.get(`/api/sessions/${seg(id)}/timeline`).then(data => { if (active) setTimeline(data) }, () => { if (active) setTimeline({ events: [], unavailable: ['ledger'] }) })
    return () => { active = false }
  }, [id, http, session?.runRef?.runId, timelineRun])
  const params = new URLSearchParams(search)
  const wanted = TABS.includes(params.get('tab')) ? params.get('tab') : 'changes'
  const [tab, setTab] = useState(wanted)
  const [memory, setMemory] = useState(null)
  useEffect(() => {
    let active = true; setMemory(null)
    if (id && http && tab === 'memory') fetchSessionMemory(http, id).then(result => { if (active) setMemory(result) }, () => { if (active) setMemory({ related: [], read: [], learned: [] }) })
    return () => { active = false }
  }, [id, http, tab, session?.task, session?.learnedToday])
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
  const [diff, setDiff] = useState(null)
  const [diffRetry, setDiffRetry] = useState(0)
  const [answer, setAnswer] = useState(null)
  const [confirm, setConfirm] = useState({ key: null, checked: false })
  const files = session?.changedFiles ?? []
  const diffPath = shownFile(files, selectedFile)
  const diffFile = files.find(file => file.path === diffPath)
  const diffRev = diffFile ? `${diffFile.adds ?? 0}:${diffFile.dels ?? 0}` : ''
  // An archived session is read-only here, so its on-screen request takes no answer keys (the server unarchives
  // a session that needs the owner, so the answer controls return as soon as it does).
  const prompt = known && isPty(session) && !isArchived(session)
    ? onScreenRequest((state.data.requests ?? []).filter(row => row.sessionId === id && (row.state ?? 'open') === 'open').sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)))
    : null
  // The Destructive checkbox resets when the request or its summary changes (state-machines 2.5).
  const confirmKey = prompt ? `${prompt.id}\n${prompt.summary ?? ''}` : null
  const confirmed = confirm.key === confirmKey && confirm.checked

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
  // The selected file's diff; a refresh of the same file keeps the shown diff until the new one arrives.
  useEffect(() => {
    if (!diffPath || tab !== 'changes') return undefined
    let current = true
    setDiff(prev => prev?.path === diffPath && prev.status === 'ready' ? prev : { path: diffPath, status: 'loading' })
    loadDiff(http, id, diffPath)
      .then(data => { if (current) setDiff({ path: diffPath, status: 'ready', data }) })
      .catch(error => { if (current) setDiff({ path: diffPath, status: 'error', message: error?.message ?? error?.code ?? 'failed' }) })
    return () => { current = false }
  }, [http, id, diffPath, diffRev, tab, diffRetry])
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
  const onAnswer = (request, body) => {
    setAnswer({ requestId: request.id, busy: body, guard: null })
    answerRequest(http, request.id, body).catch(error => setAnswer(prev => prev?.requestId === request.id
      ? { ...prev, guard: error?.code === 'typing_in_terminal' ? 'typing' : 'refused' }
      : prev))
  }
  const onKeyAnswer = event => {
    if (state.view?.overlay || confirming || linkAsk || pasteAsk) return
    const body = promptKeyBody(event, { request: prompt, terminalFocused, deckdDown: deckdOf(state).down })
    if (!body) return
    event.preventDefault()
    onAnswer(prompt, body)
  }
  const keyRef = useRef(onKeyAnswer)
  keyRef.current = onKeyAnswer
  useEffect(() => {
    const onKey = event => keyRef.current(event)
    globalThis.window?.addEventListener('keydown', onKey)
    return () => globalThis.window?.removeEventListener('keydown', onKey)
  }, [])
  const confirmLink = url => { setLinkAsk(url)
    return false }
  const confirmPaste = size => new Promise(resolve => setPasteAsk({ size, resolve }))
  const answerPaste = ok => { pasteAsk?.resolve(ok)
    setPasteAsk(null) }
  return (
    <>
      <FocusView state={state} sessionId={id} t={t} now={now} navigate={navigate} steps={steps} tab={tab} onTab={setTab} memory={memory} timeline={timeline}
        onMarkReviewed={onMarkReviewed} reviewing={reviewing} reviewError={reviewError} client={client} scrollback={scrollback}
        terminalFocused={terminalFocused} onTerminalFocus={setTerminalFocused} collision={collision} panelOpen={panelOpen} drawerOpen={drawerOpen}
        onTogglePanel={togglePanel} confirming={confirming} onStop={() => { setStopError(null)
          actions.openStop() }} onConfirmStop={actions.confirmStop} onCancelStop={actions.cancelStop}
        onNudge={actions.nudge} onRelaunch={actions.relaunch} onDismiss={actions.dismiss} stopError={stopError}
        selectedFile={selectedFile} onSelectFile={setSelectedFile} confirmLink={confirmLink} confirmPaste={confirmPaste}
        diff={diff} onRetryDiff={() => { setDiff(prev => prev && { path: prev.path, status: 'loading' })
          setDiffRetry(value => value + 1) }}
        answer={answer} confirmed={confirmed} onConfirm={checked => setConfirm({ key: confirmKey, checked })} onAnswer={onAnswer}
        onArchive={() => flow.archive(id)} onUnarchive={() => flow.unarchive(id)} fallback={session === stored ? null : session} />
      <ArchiveToast toast={archiveToast} t={t} onUndo={flow.undo} onDismiss={() => showArchiveToast(null)} />
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
      <ObserveOverlays state={state} t={t} navigate={navigate} api={api} onArchive={flow.archive}
        onToast={dispatch ? item => dispatch({ type: 'toast.push', ...item }) : undefined} />
    </>
  )
}
