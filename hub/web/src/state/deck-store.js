import { messages as en, format } from '../i18n/en.js'
import * as ptCatalog from '../i18n/pt.js'

const NEEDS_STATES = new Set(['needs_approval', 'asked_you'])

/** @returns {Record<string, any>} the empty data a snapshot replaces */
function emptyData() {
  return {
    sessions: [], requests: [], runs: [], repos: [], counts: null, order: [], recap: null, ruleOffers: [], research: [],
    recorder: { state: 'idle' }, health: [], prefs: {}, sources: {}, setup: { firstRunCompletedAt: null }
  }
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
      next.data = { ...d, recorder: data }
      const is = data?.state === 'recording'
      if (live && was !== is) next = announce(next, { kind: 'recording', text: t(is ? 'shell.announce.recStart' : 'shell.announce.recStop') })
      return next
    }
    case 'health.changed':
      next.data = { ...d, health: upsert(d.health, data, row => row.dep === data.dep) }
      return next
    case 'recap':
      next.data = { ...d, recap: data }
      return next
    case 'prefs.changed':
      next.data = { ...d, prefs: data.prefs, sources: data.sources ?? d.sources, setup: { ...d.setup, firstRunCompletedAt: data.prefs?.firstRunCompletedAt ?? d.setup.firstRunCompletedAt } }
      return next
    default:
      return next
  }
}

function flush(state) {
  let next = { ...state, buffer: [] }
  for (const message of state.buffer.slice().sort((a, b) => a.seq - b.seq)) {
    if (message.seq > next.seq) next = applyEvent(next, message, true)
  }
  return next
}

function receive(state, message) {
  switch (message.t) {
    case 'welcome':
    case 'hb':
      return state
    case 'snapshot': {
      const data = { ...emptyData(), ...message.data }
      data.sources = message.data.sources ?? state.data.sources
      const episodes = Object.fromEntries(data.sessions.filter(row => NEEDS_STATES.has(row.state)).map(row => [row.id, true]))
      const open = new Set(data.requests.map(row => row.id))
      const toasts = state.toasts.filter(toast => toast.requestId === undefined || open.has(toast.requestId))
      return flush({ ...state, loaded: true, syncing: false, replaying: false, epoch: message.epoch, seq: message.seq, data, episodes, toasts })
    }
    case 'replay.begin':
      return { ...state, replaying: true }
    case 'replay.end':
      return flush({ ...state, replaying: false, syncing: false, seq: Math.max(state.seq, message.seq ?? 0) })
    case 'ui.navigate':
      return matchRoute(String(message.data?.path ?? '')).name === 'notFound' ? state : { ...state, navigateTo: message.data.path }
    default:
      if (message.seq === undefined) return state
      if (!state.loaded || state.syncing && !state.replaying) return { ...state, buffer: [...state.buffer, message] }
      if (message.seq <= state.seq) return state
      return applyEvent(state, message, !state.syncing)
  }
}

/**
 * Pure reducer for server messages and shell actions.
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
    case 'toast.dismiss':
      return { ...state, toasts: state.toasts.filter(toast => toast.id !== action.id) }
    case 'announce.taken':
      return { ...state, announcements: state.announcements.filter(item => !action.ids.includes(item.id)) }
    case 'navigated':
      return { ...state, navigateTo: null }
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

/**
 * Map a keydown to a global shell action (keyboard.md, rail-and-shell.md section 6). Matches `event.code`.
 * @param {{ code: string, altKey: boolean, shiftKey: boolean, ctrlKey: boolean, metaKey: boolean }} event
 * @param {Record<string, any>} state
 * @returns {{ type: 'navigate', to: string } | { type: 'overlay', overlay: string } | { type: 'details' } | null}
 */
export function keyAction(event, state) {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.shiftKey) return SECTIONS[event.code] ? { type: 'navigate', to: SECTIONS[event.code] } : null
  const digit = /^Digit([1-9])$/.exec(event.code)
  if (digit) {
    const id = state.data.order[Number(digit[1]) - 1]
    return id ? { type: 'navigate', to: `/s/${encodeURIComponent(id)}` } : null
  }
  if (event.code === 'Escape') return { type: 'navigate', to: '/' }
  if (event.code === 'KeyK') return { type: 'overlay', overlay: 'palette' }
  if (event.code === 'KeyU') return { type: 'overlay', overlay: 'drawer' }
  if (event.code === 'KeyN') return { type: 'navigate', to: '/new' }
  if (event.code === 'KeyI') return { type: 'details' }
  return null
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
 * The one connection banner to show; server link lost wins over deckd lost.
 * @param {Record<string, any>} state
 * @param {number} now
 * @returns {{ kind: 'server' | 'deckd', attempt: number, seconds: number } | null}
 */
export function bannerFor(state, now) {
  const seconds = at => at ? Math.max(0, Math.round((at - now) / 1000)) : 0
  const { connection } = state
  if (connection.state === 'reconnecting') return { kind: 'server', attempt: connection.attempt, seconds: seconds(connection.nextAt) }
  const deckd = state.data.health.find(row => row.dep === 'deckd')
  if (state.loaded && deckd && ['down', 'reconnecting'].includes(deckd.state)) return { kind: 'deckd', attempt: deckd.attempt ?? 0, seconds: seconds(deckd.nextProbeAt) }
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
