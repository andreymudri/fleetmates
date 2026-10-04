import { messages as en, format } from '../i18n/en.js'
import * as ptCatalog from '../i18n/pt.js'

const NEEDS_STATES = new Set(['needs_approval', 'asked_you'])

// Archived: the session row carries a non-null `archivedAt`.
const isArchived = row => row?.archivedAt != null

/** @returns {Record<string, any>} the empty data a snapshot replaces */
function emptyData() {
  return {
    sessions: [], requests: [], runs: [], repos: [], counts: null, order: [], recap: null, ruleOffers: [], rules: [], rulesRev: 0, research: [],
    recorder: { state: 'idle' }, health: [], prefs: {}, sources: {}, setup: { firstRunCompletedAt: null },
    inputSources: {}, tails: {},
    meetings: {}, meetingPins: {}, live: null, meetingAsk: {}, askThreads: {}, askPending: {}
  }
}

// Meeting state the browser builds itself (REST reads, durable meeting events, ephemeral streams). A snapshot
// carries none of it, so a snapshot keeps it. None of it is ever written to browser storage (08-security 4.12).
const MEETING_KEYS = ['meetings', 'meetingPins', 'live', 'meetingAsk', 'askThreads', 'askPending']

/** The most live transcript lines the store keeps for the meeting being recorded; older lines are dropped. */
export const LIVE_LINE_CAP = 10000
// Ask streams whose thread the browser has not matched to a meeting yet (the stream can beat the POST answer).
const ASK_PENDING_CAP = 16

// Merge a meeting row by id. `meeting.updated` carries no title (06-storage 10.1), so a known title is kept.
function mergeMeeting(meetings, row) {
  if (typeof row?.id !== 'string' || !row.id) return meetings
  const previous = meetings[row.id]
  const merged = { ...previous, ...row }
  if (row.title == null && previous?.title != null) merged.title = previous.title
  return { ...meetings, [row.id]: merged }
}

// The live transcript after a meeting.status or a snapshot: kept only while the recorder is on the same meeting.
function liveFor(live, recorder) {
  return live && recorder?.meetingId === live.meetingId ? live : null
}

// Append lines, or with `divider` a number, a "{n} lines recovered" divider at the current end.
function appendLive(data, meetingId, lines, divider) {
  const current = data.live?.meetingId === meetingId ? data.live : { meetingId, lines: [], recovered: [] }
  let next = lines.length ? current.lines.concat(lines) : current.lines
  let recovered = divider === null ? current.recovered : [...current.recovered, { at: next.length, count: divider }]
  const drop = next.length - LIVE_LINE_CAP
  if (drop > 0) {
    next = next.slice(drop)
    recovered = recovered.map(item => ({ ...item, at: item.at - drop })).filter(item => item.at >= 0)
  }
  return { ...data, live: { meetingId, lines: next, recovered } }
}

// One ask answer as it streams: deltas append, `ask.done` replaces the text, `ask.error` keeps the error.
function askStep(record, type, data) {
  const base = record ?? { threadId: data.threadId, messageId: data.messageId ?? null, text: '', state: 'streaming', message: null, error: null }
  if (type === 'ask.delta') return { ...base, text: base.text + String(data.text ?? '') }
  if (type === 'ask.done') return { ...base, state: 'done', message: data.message ?? null, text: String(data.message?.text ?? base.text) }
  return { ...base, state: 'error', error: data.error ?? null }
}

function applyAsk(state, message) {
  const data = message.data
  const threadId = data?.threadId
  if (typeof threadId !== 'string' || !threadId) return state
  const d = state.data
  const meetingId = d.askThreads[threadId]
  if (meetingId !== undefined) {
    const record = d.meetingAsk[meetingId]
    if (record?.threadId !== threadId) return state
    return { ...state, data: { ...d, meetingAsk: { ...d.meetingAsk, [meetingId]: askStep(record, message.t, data) } } }
  }
  const pending = { ...d.askPending, [threadId]: askStep(d.askPending[threadId], message.t, data) }
  const keys = Object.keys(pending)
  for (const key of keys.slice(0, Math.max(0, keys.length - ASK_PENDING_CAP))) delete pending[key]
  return { ...state, data: { ...d, askPending: pending } }
}

// Register the answer of POST /api/ask for a `meeting:<id>` thread; a stream that arrived first is folded in.
function startMeetingAsk(state, action) {
  const thread = action.thread
  const scope = typeof thread?.scope === 'string' ? thread.scope : ''
  if (!scope.startsWith('meeting:') || typeof thread.id !== 'string' || !thread.id) return state
  const meetingId = scope.slice('meeting:'.length)
  const d = state.data
  const pending = d.askPending[thread.id]
  const askPending = { ...d.askPending }
  delete askPending[thread.id]
  const record = {
    threadId: thread.id, messageId: action.assistantMessageId ?? pending?.messageId ?? null, question: action.userMessage?.text ?? null,
    text: pending?.text ?? '', state: pending?.state ?? 'streaming', message: pending?.message ?? null, error: pending?.error ?? null
  }
  return { ...state, data: { ...d, meetingAsk: { ...d.meetingAsk, [meetingId]: record }, askThreads: { ...d.askThreads, [thread.id]: meetingId }, askPending } }
}

/**
 * The store before any server contact: no snapshot, so no counts.
 * @returns {Record<string, any>}
 */
export function initialState() {
  return {
    connection: { state: 'connecting', attempt: 0, nextAt: null },
    loaded: false,
    syncing: false,
    replaying: false,
    buffer: [],
    epoch: null,
    seq: 0,
    deckdOutage: false,
    lastEventAt: null,
    data: emptyData(),
    view: { path: '/', overlay: null },
    episodes: {},
    toasts: [],
    announcements: [],
    nextId: 1,
    navigateTo: null
  }
}

/**
 * Pick the chrome catalog. Portuguese is used only once its catalog is approved (Q19);
 * until then `lang: 'pt'` falls back to English and reports the fallback so the shell shows a notice.
 * @param {{ lang?: string }} [prefs]
 * @param {{ approved: boolean, messages: Record<string, string> }} [pt]
 * @returns {{ lang: 'en' | 'pt', messages: Record<string, string>, fallback: 'pt' | null }}
 */
export function selectLanguage(prefs = {}, pt = ptCatalog) {
  if (prefs?.lang === 'pt') {
    if (pt.approved) return { lang: 'pt', messages: { ...en, ...pt.messages }, fallback: null }
    return { lang: 'en', messages: en, fallback: 'pt' }
  }
  return { lang: 'en', messages: en, fallback: null }
}

function translator(state) {
  const { lang, messages } = selectLanguage(state.data.prefs)
  return (key, params) => format(messages[key] ?? en[key] ?? key, params, lang)
}

function repoName(state, repoId) {
  const repo = state.data.repos.find(row => row.id === repoId)
  if (repo) return repo.name
  return String(repoId ?? '').split('/').filter(Boolean).at(-1) ?? ''
}

function upsert(list, row, same = item => item.id === row.id) {
  const index = list.findIndex(same)
  if (index === -1) return [...list, row]
  const next = list.slice()
  next[index] = row
  return next
}

// Rules and rule offers are keyed by repo and pattern: the same pattern in two repos is two rows.
const sameRule = data => row => row.repoId === data.repoId && row.pattern === data.pattern

function addToast(state, toast) {
  return { ...state, toasts: [...state.toasts, { id: state.nextId, ...toast }], nextId: state.nextId + 1 }
}

function announce(state, item) {
  return { ...state, announcements: [...state.announcements, { id: state.nextId, ...item }], nextId: state.nextId + 1 }
}

function applyEvent(state, message, live) {
  const { t: type, data } = message
  let next = { ...state, seq: message.seq ?? state.seq, lastEventAt: message.at ?? state.lastEventAt }
  const d = next.data
  const t = translator(next)
  switch (type) {
    case 'session.upserted': {
      const previous = d.sessions.find(row => row.id === data.id)
      next.data = { ...d, sessions: upsert(d.sessions, data) }
      // The server publishes no order.changed when a session only leaves the order, so drop it here.
      // An archived session leaves the order the same way.
      if ((data.state === 'ended' || isArchived(data)) && d.order.includes(data.id)) next.data.order = d.order.filter(id => id !== data.id)
      // An unarchived session rejoins at the end until the server's order.changed places it.
      else if (isArchived(previous) && !isArchived(data) && data.state !== 'ended' && !d.order.includes(data.id)) next.data.order = [...d.order, data.id]
      if (!NEEDS_STATES.has(data.state) && next.episodes[data.id]) {
        const episodes = { ...next.episodes }
        delete episodes[data.id]
        next.episodes = episodes
      }
      if (live && data.state === 'crashed' && previous?.state !== 'crashed') {
        const params = { repo: repoName(next, data.repoId), code: data.exitCode ?? data.exitSignal ?? '' }
        next = addToast(next, { tone: 'error', sessionId: data.id, title: t('shell.toast.crash.title', params) })
        next = announce(next, { kind: 'crash', text: t('shell.announce.crash', params) })
      }
      return next
    }
    case 'session.removed':
      next.data = { ...d, sessions: d.sessions.filter(row => row.id !== data.id) }
      return next
    case 'request.opened': {
      next.data = { ...d, requests: upsert(d.requests, data) }
      if (!live) return next
      const session = d.sessions.find(row => row.id === data.sessionId)
      const question = data.kind === 'question'
      const params = { repo: repoName(next, session?.repoId), summary: data.summary ?? '' }
      const hidden = next.view.overlay === 'drawer' || next.view.path === `/s/${data.sessionId}`
      if (!next.episodes[data.sessionId]) {
        next.episodes = { ...next.episodes, [data.sessionId]: true }
        if (!hidden) next = addToast(next, { tone: 'needs', sessionId: data.sessionId, requestId: data.id, title: t(question ? 'shell.toast.question.title' : 'shell.toast.needs.title', params) })
      }
      return announce(next, { kind: 'request', text: t(question ? 'shell.announce.question' : 'shell.announce.request', params) })
    }
    case 'request.updated':
      next.data = { ...d, requests: upsert(d.requests, data) }
      return next
    case 'request.closed':
      next.data = { ...d, requests: d.requests.filter(row => row.id !== data.id) }
      next.toasts = next.toasts.filter(toast => toast.requestId !== data.id)
      return next
    case 'counts':
      next.data = { ...d, counts: data }
      return next
    case 'order.changed':
      next.data = { ...d, order: data.order }
      return next
    case 'run.updated':
      next.data = { ...d, runs: upsert(d.runs, data, row => row.repoId === data.repoId && row.runId === data.runId) }
      return next
    case 'repo.upserted':
      next.data = { ...d, repos: upsert(d.repos, data) }
      return next
    case 'meeting.status': {
      const was = d.recorder?.state === 'recording'
      next.data = { ...d, recorder: data, live: liveFor(d.live, data) }
      const is = data?.state === 'recording'
      if (live && was !== is) next = announce(next, { kind: 'recording', text: t(is ? 'shell.announce.recStart' : 'shell.announce.recStop') })
      return next
    }
    case 'meeting.updated':
      next.data = { ...d, meetings: mergeMeeting(d.meetings, data) }
      return next
    case 'meeting.pin.added': {
      const id = data?.meetingId
      if (typeof id !== 'string' || !id) return next
      const pin = { ...data }
      delete pin.meetingId
      const pins = upsert(d.meetingPins[id] ?? [], pin).sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
      next.data = { ...d, meetingPins: { ...d.meetingPins, [id]: pins } }
      return next
    }
    case 'meeting.pin.removed': {
      const id = data?.meetingId
      if (typeof id !== 'string' || !id) return next
      next.data = { ...d, meetingPins: { ...d.meetingPins, [id]: (d.meetingPins[id] ?? []).filter(pin => pin.id !== data.id) } }
      return next
    }
    case 'health.changed':
      next.data = { ...d, health: upsert(d.health, data, row => row.dep === data.dep) }
      if (data.dep === 'deckd') next.deckdOutage = outageAfter(next.deckdOutage, data)
      return next
    case 'recap':
      next.data = { ...d, recap: data }
      return next
    case 'rule.offered':
      next.data = { ...d, ruleOffers: upsert(d.ruleOffers, data, sameRule(data)) }
      return next
    case 'rule.withdrawn':
      next.data = { ...d, ruleOffers: d.ruleOffers.filter(row => !sameRule(data)(row)) }
      return next
    case 'rule.upserted':
      next.data = { ...d, rules: upsert(d.rules, data, sameRule(data)), rulesRev: d.rulesRev + 1 }
      return next
    case 'rule.removed':
      next.data = { ...d, rules: d.rules.filter(row => !sameRule(data)(row)), rulesRev: d.rulesRev + 1 }
      return next
    case 'prefs.changed':
      next.data = { ...d, prefs: data.prefs, sources: data.sources ?? d.sources, setup: { ...d.setup, firstRunCompletedAt: data.prefs?.firstRunCompletedAt ?? d.setup.firstRunCompletedAt } }
      return next
    default:
      return next
  }
}

const OUTAGE = new Set(['down', 'reconnecting'])

// Whether deckd is in an outage after this health row: a `checking` probe (Retry now, Start) keeps the
// outage it started from, any other state settles it.
function outageAfter(outage, row) {
  if (!row) return outage
  return row.state === 'checking' ? outage : OUTAGE.has(row.state)
}

function flush(state) {
  let next = { ...state, buffer: [] }
  for (const message of state.buffer.slice().sort((a, b) => a.seq - b.seq)) {
    if (message.seq > next.seq) next = applyEvent(next, message, true)
  }
  return next
}

// Ephemeral events (05-api 3.4, 3.5) carry no seq: they apply at once, are never buffered and never move `seq`.
function applyEphemeral(state, message) {
  const data = message.data
  const id = data?.sessionId
  if (typeof id !== 'string' || !id) return state
  if (message.t === 'input.source') {
    return { ...state, data: { ...state.data, inputSources: { ...state.data.inputSources, [id]: data } } }
  }
  if (!Array.isArray(data.lines)) return state
  return { ...state, data: { ...state.data, tails: { ...state.data.tails, [id]: data.lines } } }
}

// Ephemeral meeting streams (05-api 3.4): kept only for the meeting the recorder is on, never buffered.
function applyMeetingStream(state, message) {
  const data = message.data
  const id = data?.meetingId
  if (typeof id !== 'string' || !id || state.data.recorder?.meetingId !== id) return state
  if (message.t === 'meeting.transcript') return data.line && typeof data.line === 'object' ? { ...state, data: appendLive(state.data, id, [data.line], null) } : state
  const count = Number(data.count)
  return { ...state, data: appendLive(state.data, id, [], Number.isFinite(count) && count > 0 ? count : 0) }
}

function receive(state, message) {
  switch (message.t) {
    case 'welcome':
    case 'hb':
      return state
    case 'snapshot': {
      const data = { ...emptyData(), ...message.data }
      data.sources = message.data.sources ?? state.data.sources
      // Ephemeral terminal state is not part of the snapshot; keep what the socket already delivered.
      data.inputSources = state.data.inputSources ?? {}
      data.tails = state.data.tails ?? {}
      // The snapshot carries no rules revision; keep counting from the last one so it never repeats.
      data.rulesRev = state.data.rulesRev ?? 0
      for (const key of MEETING_KEYS) data[key] = state.data[key] ?? emptyData()[key]
      data.live = liveFor(data.live, data.recorder)
      const episodes = Object.fromEntries(data.sessions.filter(row => NEEDS_STATES.has(row.state)).map(row => [row.id, true]))
      const open = new Set(data.requests.map(row => row.id))
      const toasts = state.toasts.filter(toast => toast.requestId === undefined || open.has(toast.requestId))
      const deckdOutage = outageAfter(state.deckdOutage, data.health?.find(row => row.dep === 'deckd'))
      return flush({ ...state, loaded: true, syncing: false, replaying: false, epoch: message.epoch, seq: message.seq, data, episodes, toasts, deckdOutage })
    }
    case 'replay.begin':
      return { ...state, replaying: true }
    case 'replay.end':
      return flush({ ...state, replaying: false, syncing: false, seq: Math.max(state.seq, message.seq ?? 0) })
    case 'ui.navigate':
      return matchRoute(String(message.data?.path ?? '')).name === 'notFound' ? state : { ...state, navigateTo: message.data.path }
    case 'input.source':
    case 'screen.tail':
      return applyEphemeral(state, message)
    case 'meeting.transcript':
    case 'meeting.recovered':
      return applyMeetingStream(state, message)
    case 'ask.delta':
    case 'ask.done':
    case 'ask.error':
      return applyAsk(state, message)
    default:
      if (message.seq === undefined) return state
      if (!state.loaded || state.syncing && !state.replaying) return { ...state, buffer: [...state.buffer, message] }
      if (message.seq <= state.seq) return state
      return applyEvent(state, message, !state.syncing)
  }
}

/**
 * The sessions Home, Focus and the palette show: every session that is not archived.
 * @param {Record<string, any>} state
 * @returns {Array<Record<string, any>>}
 */
export function visibleSessions(state) {
  return state.data.sessions.filter(row => !isArchived(row))
}

/**
 * How many sessions are archived, from the server's `counts.archived`; zero before counts arrive.
 * @param {Record<string, any>} state
 * @returns {number}
 */
export function archivedCount(state) {
  return state.data.counts?.archived ?? 0
}

/**
 * Pure reducer for server messages and shell actions. Meeting actions: `meetings.fetched` `{ meetings }` merges
 * REST list rows (with their titles) into `data.meetings`; `meeting.ask` `{ thread, userMessage,
 * assistantMessageId }` (the POST /api/ask answer) ties a `meeting:<id>` thread to `data.meetingAsk[id]`.
 * @param {Record<string, any>} state
 * @param {{ type: string, [key: string]: any }} action
 * @returns {Record<string, any>}
 */
export function reduce(state, action) {
  switch (action.type) {
    case 'message':
      return receive(state, action.message)
    case 'resync':
      return { ...state, syncing: true, replaying: false, buffer: [] }
    case 'connection':
      return { ...state, connection: { state: action.state, attempt: action.attempt ?? 0, nextAt: action.nextAt ?? null } }
    case 'view':
      return { ...state, view: { path: action.path, overlay: action.overlay ?? null } }
    case 'toast.push':
      return addToast(state, { tone: action.tone, title: action.title, body: action.body ?? null })
    case 'toast.dismiss':
      return { ...state, toasts: state.toasts.filter(toast => toast.id !== action.id) }
    case 'announce.taken':
      return { ...state, announcements: state.announcements.filter(item => !action.ids.includes(item.id)) }
    case 'navigated':
      return { ...state, navigateTo: null }
    case 'meetings.fetched':
      return { ...state, data: { ...state.data, meetings: (action.meetings ?? []).reduce(mergeMeeting, state.data.meetings) } }
    case 'meeting.ask':
      return startMeetingAsk(state, action)
    default:
      return state
  }
}

/**
 * Create the browser store. React reads it through `useSyncExternalStore`.
 * @param {Record<string, any>} [initial]
 * @returns {{ getState: () => Record<string, any>, subscribe: (listener: () => void) => () => void, dispatch: (action: object) => void }}
 */
export function createDeckStore(initial = initialState()) {
  let state = initial
  const listeners = new Set()
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispatch(action) {
      const next = reduce(state, action)
      if (next === state) return
      state = next
      for (const listener of listeners) listener()
    }
  }
}

/**
 * Match an SPA path against the route table in docs/deck/screens/rail-and-shell.md section 2.
 * @param {string} pathname
 * @returns {{ name: string, params: Record<string, string> }}
 */
export function matchRoute(pathname) {
  let parts
  try {
    parts = String(pathname).split('?')[0].split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return { name: 'notFound', params: {} }
  }
  const [head, second, ...rest] = parts
  const route = (name, params = {}) => ({ name, params })
  if (parts.length === 0) return route('home')
  if (head === 'new' && parts.length === 1) return route('new')
  if (head === 's' && parts.length === 2) return route('focus', { sessionId: second })
  if (head === 'runs' && parts.length >= 3) return route('team', { repoKey: second, runId: rest.join('/') })
  if (head === 'memory' && parts.length === 1) return route('memory')
  if (head === 'memory' && second === 'note' && rest.length) return route('memoryNote', { path: rest.join('/') })
  if (head === 'research' && parts.length === 2) return second === 'new' ? route('researchNew') : route('research', { id: second })
  if (head === 'meetings' && parts.length === 1) return route('meetings')
  if (head === 'meetings' && parts.length === 2) return second === 'live' ? route('meetingLive') : route('meeting', { id: second })
  if (head === 'settings' && parts.length === 1) return route('settingsIndex')
  if (head === 'settings' && parts.length === 2) return second === 'crew' ? route('crew') : route('settings', { section: second })
  if (head === 'welcome' && parts.length === 1) return route('welcome')
  return route('notFound')
}

/**
 * Whether a string is a same-origin SPA path that names a known route (used for the fragment `to`).
 * @param {string} value
 * @returns {boolean}
 */
export function isRoute(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && matchRoute(value).name !== 'notFound'
}

/**
 * The redirect a path needs given the store, or null.
 * @param {string} pathname
 * @param {Record<string, any>} state
 * @returns {string | null}
 */
export function resolveRoute(pathname, state) {
  const { name } = matchRoute(pathname)
  if (name === 'settingsIndex') return '/settings/rules'
  if (!state.loaded) return null
  if (name === 'home' && !state.data.setup?.firstRunCompletedAt) return '/welcome'
  if (name === 'meetingLive' && state.data.recorder?.state !== 'recording') return '/meetings'
  return null
}

const SECTIONS = { Digit1: '/', Digit2: '/memory', Digit3: '/meetings', Digit4: '/settings/rules' }
const GLOBAL_CODES = new Set(['KeyK', 'KeyN', 'KeyU', 'KeyI', 'Escape'])

/**
 * Whether a keydown is in the keyboard.md section 2 global set (Alt K, Alt N, Alt U, Alt I, Alt Esc,
 * Alt 1 to 9, Alt Shift 1 to 4), matched on `event.code`. A focused terminal hands these to the shell and
 * sends every other key, including Alt P, Alt B and Tab, to the PTY.
 * @param {{ code: string, altKey: boolean, shiftKey: boolean, ctrlKey: boolean, metaKey: boolean }} event
 * @returns {boolean}
 */
export function isGlobalChord(event) {
  if (!event?.altKey || event.ctrlKey || event.metaKey) return false
  if (event.shiftKey) return Object.hasOwn(SECTIONS, event.code)
  return GLOBAL_CODES.has(event.code) || /^Digit[1-9]$/.test(event.code)
}

/**
 * Map a keydown to a global shell action (keyboard.md, rail-and-shell.md section 6). Matches `event.code`.
 * Alt P is `{ type: 'pin' }` only while the recorder is `recording` and the target is not inside `.terminal-view`.
 * @param {{ code: string, altKey: boolean, shiftKey: boolean, ctrlKey: boolean, metaKey: boolean, target?: { closest?: Function } | null }} event
 * @param {Record<string, any>} state
 * @returns {{ type: 'navigate', to: string } | { type: 'overlay', overlay: string } | { type: 'details' } | { type: 'pin' } | null}
 */
export function keyAction(event, state) {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.shiftKey) return SECTIONS[event.code] ? { type: 'navigate', to: SECTIONS[event.code] } : null
  const digit = /^Digit([1-9])$/.exec(event.code)
  if (digit) {
    const archived = new Set(state.data.sessions.filter(isArchived).map(row => row.id))
    const id = state.data.order.filter(item => !archived.has(item))[Number(digit[1]) - 1]
    return id ? { type: 'navigate', to: `/s/${encodeURIComponent(id)}` } : null
  }
  if (event.code === 'Escape') return { type: 'navigate', to: '/' }
  if (event.code === 'KeyK') return { type: 'overlay', overlay: 'palette' }
  if (event.code === 'KeyU') return { type: 'overlay', overlay: 'drawer' }
  if (event.code === 'KeyN') return { type: 'navigate', to: '/new' }
  if (event.code === 'KeyI') return { type: 'details' }
  if (event.code === 'KeyP') return state.data.recorder?.state === 'recording' && !insideTerminal(event.target) ? { type: 'pin' } : null
  return null
}

// Alt P is not a global chord: a focused terminal sends it to the PTY (keyboard.md section 1).
function insideTerminal(target) {
  return typeof target?.closest === 'function' && target.closest('.terminal-view') != null
}

/**
 * Document title with the needs-you prefix (rail-and-shell.md section 4.5).
 * @param {string} page
 * @param {{ needYouSessions: number } | null} counts
 * @param {(key: string, params?: object) => string} t
 * @returns {string}
 */
export function documentTitle(page, counts, t) {
  const n = counts?.needYouSessions ?? 0
  return n > 0 ? t('shell.title.needs', { n, page }) : t('shell.title', { page })
}

/**
 * Rail badge text: hidden at zero, "99+" above 99.
 * @param {number} n
 * @param {(key: string) => string} t
 * @returns {string | null}
 */
export function badgeText(n, t) {
  if (!n || n <= 0) return null
  return n > 99 ? t('shell.rail.badgeMax') : String(n)
}

/**
 * The one connection banner to show; server link lost wins over deckd lost. A deckd probe in flight
 * (`checking`, after Retry now) keeps the deckd banner while the outage it started from lasts.
 * @param {Record<string, any>} state
 * @param {number} now
 * @returns {{ kind: 'server' | 'deckd', attempt: number, seconds: number } | null}
 */
export function bannerFor(state, now) {
  const seconds = at => at ? Math.max(0, Math.round((at - now) / 1000)) : 0
  const { connection } = state
  if (connection.state === 'reconnecting') return { kind: 'server', attempt: connection.attempt, seconds: seconds(connection.nextAt) }
  const deckd = state.data.health.find(row => row.dep === 'deckd')
  if (state.loaded && deckd && (OUTAGE.has(deckd.state) || deckd.state === 'checking' && state.deckdOutage)) return { kind: 'deckd', attempt: deckd.attempt ?? 0, seconds: seconds(deckd.nextProbeAt) }
  return null
}

/**
 * Batch live-region announcements: one polite message per 2 s window; several requests merge into
 * "{n} new requests" (rail-and-shell.md section 7).
 * @param {{ setTimeout: Function, clearTimeout: Function, emit: (text: string) => void, t: (key: string, params?: object) => string, windowMs?: number }} options
 * @returns {{ push: (item: { kind: string, text: string }) => void, close: () => void }}
 */
export function createAnnouncer({ setTimeout, clearTimeout, emit, t, windowMs = 2000 }) {
  let queue = []
  let timer = null
  function flushQueue() {
    timer = null
    const items = queue
    queue = []
    const requests = items.filter(item => item.kind === 'request')
    const parts = items.filter(item => item.kind !== 'request').map(item => item.text)
    if (requests.length === 1) parts.unshift(requests[0].text)
    else if (requests.length > 1) parts.unshift(t('shell.announce.burst', { n: requests.length }))
    if (parts.length) emit(parts.join(' '))
  }
  return {
    push(item) {
      queue.push(item)
      if (timer === null) timer = setTimeout(flushQueue, windowMs)
    },
    close() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      queue = []
    }
  }
}

const NEEDS_KINDS = new Set(['request', 'run', 'task'])

/**
 * Read the Needs-you drawer filter from a location search (`?needs=request:<id>`, `?needs=run:<runId>`,
 * `?needs=task:<runId>:<taskId>`; the task id is after the last colon, so a run id may hold colons).
 * @param {string | null | undefined} search
 * @returns {{ kind: 'request', id: string } | { kind: 'run', runId: string } | { kind: 'task', runId: string, taskId: string } | null}
 */
export function parseNeedsFilter(search) {
  let value
  try { value = new URLSearchParams(String(search ?? '')).get('needs') } catch { return null }
  if (!value) return null
  const colon = value.indexOf(':')
  if (colon === -1) return null
  const kind = value.slice(0, colon)
  const rest = value.slice(colon + 1)
  if (!NEEDS_KINDS.has(kind) || !rest) return null
  if (kind === 'request') return { kind, id: rest }
  if (kind === 'run') return { kind, runId: rest }
  const last = rest.lastIndexOf(':')
  const runId = rest.slice(0, last)
  const taskId = rest.slice(last + 1)
  if (last === -1 || !runId || !taskId) return null
  return { kind, runId, taskId }
}

/**
 * Build the `needs=` query parameter for a filter from {@link parseNeedsFilter}; empty for none.
 * @param {{ kind: string, id?: string, runId?: string, taskId?: string } | null} filter
 * @returns {string}
 */
export function needsFilterParam(filter) {
  if (!filter) return ''
  const value = filter.kind === 'request' ? `request:${filter.id}` : filter.kind === 'run' ? `run:${filter.runId}` : `task:${filter.runId}:${filter.taskId}`
  return new URLSearchParams({ needs: value }).toString()
}

const DENSITY_KEY = 'deck.density'
const DENSITIES = new Set(['comfortable', 'compact'])

/**
 * Home card density from `localStorage` `deck.density`: `comfortable` (default) or `compact`.
 * A storage that throws (private mode, quota) reads as the default.
 * @param {Storage | undefined} storage
 * @returns {'comfortable' | 'compact'}
 */
export function readDensity(storage) {
  try {
    const value = storage?.getItem(DENSITY_KEY)
    return DENSITIES.has(value) ? value : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

/**
 * Remember the Home card density; unknown values and storage errors are ignored.
 * @param {Storage | undefined} storage
 * @param {'comfortable' | 'compact'} value
 */
export function writeDensity(storage, value) {
  if (!DENSITIES.has(value)) return
  try { storage?.setItem(DENSITY_KEY, value) } catch {}
}
