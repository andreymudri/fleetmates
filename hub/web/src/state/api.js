import { isRoute } from './deck-store.js'

/** sessionStorage key that holds this tab's deck token. */
export const TOKEN_KEY = 'fleetmates-deck.token'
/** API version this build speaks (docs/deck/05-api.md section 8). */
export const API_VERSION = 1
/** Build id sent in `hello` and used to remember a client_outdated reload. */
export const BUILD = 'm1'

/**
 * Move `#token=<t>` from the URL fragment into sessionStorage and drop the fragment with
 * `history.replaceState`, so the token never stays in the address bar or history.
 * A fragment `to=<route>` is returned only when it names a known SPA route.
 * @param {{ location: { hash: string, pathname: string, search: string }, history: { replaceState: Function }, storage: Storage }} env
 * @returns {{ token: string | null, to: string | null }}
 */
export function captureToken({ location, history, storage }) {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''))
  const fragment = params.get('token')
  if (!fragment) return { token: storage.getItem(TOKEN_KEY), to: null }
  storage.setItem(TOKEN_KEY, fragment)
  history.replaceState(null, '', location.pathname + location.search)
  const to = params.get('to')
  return { token: fragment, to: to && isRoute(to) ? to : null }
}

/**
 * WebSocket subprotocols: the version marker plus the raw token (05-api.md section 1).
 * @param {string} token
 * @returns {string[]}
 */
export function wsProtocols(token) {
  return ['deck.v1', `deck.auth.${token}`]
}

/**
 * The deck WebSocket URL for the page's own host.
 * @param {{ host: string }} location
 * @returns {string}
 */
export function wsUrl(location) {
  return `ws://${location.host}/api/ws`
}

/**
 * Reconnect delay: `min(2^(attempt-1), 30)` seconds with plus or minus 20 percent jitter (state-machines 4.1).
 * @param {number} attempt
 * @param {() => number} [random]
 * @returns {number} milliseconds
 */
export function backoffMs(attempt, random = Math.random) {
  const base = Math.min(2 ** (attempt - 1), 30) * 1000
  return Math.round(base * (1 + (random() * 2 - 1) * 0.2))
}

/**
 * REST client for same-origin `/api/*` paths. Any other path, including an absolute URL,
 * is refused before `fetch` runs, so the bearer token is never sent anywhere else.
 * @param {{ token: string, fetch: typeof fetch, onFatal?: (state: string) => void }} options
 * @returns {{ get: (path: string) => Promise<any>, patch: (path: string, body: object) => Promise<any>, post: (path: string, body?: object) => Promise<any>, probe: () => Promise<string | null> }}
 */
export function createApiClient({ token, fetch, onFatal = () => {} }) {
  function init(method, body) {
    const headers = { Authorization: `Bearer ${token}`, 'X-Deck-Api': String(API_VERSION) }
    const options = { method, headers, cache: 'no-store', credentials: 'same-origin' }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
    return options
  }
  async function request(method, path, body) {
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw Object.assign(new Error('Not a deck API path'), { status: 0, code: 'bad_path', retryable: false, details: {} })
    const response = await fetch(path, init(method, body))
    let payload = null
    try { payload = await response.json() } catch {}
    if (!response.ok) {
      const error = payload?.error ?? { code: 'internal', message: 'Request failed', retryable: false }
      if (response.status === 401) onFatal('token_invalid')
      else if (response.status === 403 && error.code === 'forbidden_origin') onFatal('origin_rejected')
      else if (error.details?.reason === 'client_outdated') onFatal('client_outdated')
      throw Object.assign(new Error(error.message ?? error.code), { status: response.status, code: error.code, retryable: !!error.retryable, details: error.details ?? {} })
    }
    return payload
  }
  return {
    get: path => request('GET', path),
    patch: (path, body) => request('PATCH', path, body),
    post: (path, body) => request('POST', path, body),
    /** Tell a refused WebSocket upgrade (401 or 403) apart from a server that is down. */
    async probe() {
      try {
        const response = await fetch('/api/version', init('GET'))
        if (response.status === 401) return 'token_invalid'
        if (response.status === 403) return 'origin_rejected'
      } catch {}
      return null
    }
  }
}

/**
 * Browser to server WebSocket machine (state-machines 4.1): hello with lastSeq and epoch, snapshot or
 * replay, 30 s heartbeat watchdog, jittered backoff, and terminal states that never retry.
 * @param {object} options
 * @param {string | null} options.token
 * @param {string} options.url
 * @param {typeof WebSocket} options.WebSocket
 * @param {ReturnType<import('./deck-store.js').createDeckStore>} options.store
 * @param {Storage} options.storage
 * @param {() => Promise<string | null>} options.probe
 * @param {() => void} options.reload
 * @returns {{ start: () => void, retryNow: () => void, visible: () => void, close: () => void }}
 */
export function createConnection({
  token, url, WebSocket, store, storage, probe, reload, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
  now = Date.now, random = Math.random, heartbeatMs = 30_000
}) {
  let socket = null
  let attempt = 0
  let timer = null
  let watchdog = null
  let stopped = false
  const set = (state, nextAt = null) => store.dispatch({ type: 'connection', state, attempt, nextAt })
  const disarm = () => {
    if (watchdog !== null) clearTimeout(watchdog)
    watchdog = null
  }
  function arm() {
    disarm()
    watchdog = setTimeout(() => {
      const ws = socket
      if (!ws) return
      socket = null
      watchdog = null
      try { ws.close() } catch {}
      closed(1006, true)
    }, heartbeatMs)
  }
  function schedule() {
    attempt++
    const delay = backoffMs(attempt, random)
    set('reconnecting', now() + delay)
    timer = setTimeout(() => { timer = null
      connect() }, delay)
  }
  function outdated() {
    const key = `fleetmates-deck.reloaded.${BUILD}`
    if (storage.getItem(key)) { set('client_outdated')
      return }
    storage.setItem(key, '1')
    reload()
  }
  function closed(code, opened) {
    if (stopped) return
    if (code === 4401) set('token_invalid')
    else if (code === 4403) set('origin_rejected')
    else if (code === 4410) outdated()
    else if (!opened) probe().then(result => {
      if (stopped) return
      if (result) set(result)
      else schedule()
    })
    else schedule()
  }
  function connect() {
    if (stopped) return
    if (timer !== null) clearTimeout(timer)
    timer = null
    set('connecting')
    let opened = false
    const ws = new WebSocket(url, wsProtocols(token))
    socket = ws
    ws.onopen = () => {
      if (socket !== ws) return
      opened = true
      store.dispatch({ type: 'resync' })
      const { seq, epoch } = store.getState()
      ws.send(JSON.stringify({ t: 'hello', lastSeq: seq, epoch, apiVersion: API_VERSION, build: BUILD }))
      set('resyncing')
      arm()
    }
    ws.onmessage = event => {
      if (socket !== ws) return
      arm()
      let message
      try { message = JSON.parse(event.data) } catch { return }
      store.dispatch({ type: 'message', message })
      if (message.t === 'snapshot' || message.t === 'replay.end') {
        attempt = 0
        set('live')
      }
    }
    ws.onerror = () => {}
    ws.onclose = event => {
      if (socket !== ws) return
      socket = null
      disarm()
      closed(event.code, opened)
    }
  }
  return {
    start() {
      if (!token) { set('token_invalid')
        return }
      connect()
    },
    retryNow() {
      if (socket || store.getState().connection.state !== 'reconnecting') return
      connect()
    },
    visible() {
      if (store.getState().connection.state === 'reconnecting') this.retryNow()
    },
    close() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      disarm()
      const ws = socket
      socket = null
      ws?.close(1000)
    }
  }
}
