// The web server's one long-lived connection to deckd (docs/deck/05-api.md section 5,
// docs/deck/interaction/state-machines.md 4.2): connect with backoff, reconcile PTYs and exit records, the
// heartbeat, the deckd health row, and the PTY signals the server derives from deckd events (spawned rows,
// exit capture, input source, screen idle and counted output).
import { randomUUID } from 'node:crypto'
import { DeckdRequestError } from '../../deckd/client.mjs'
import { PROTO } from '../../deckd/protocol.mjs'
import { workingRoot } from '../machines/session.mjs'
import { parseScreen } from '../screen/index.mjs'
import { ensureRepo } from '../adapters/repos.mjs'
import { apiError } from '../http/router.mjs'
import { createIdleTracker, isCountedOutput } from './screen-signals.mjs'

/** deckd events the link forwards to `on` subscribers. */
const FORWARDED = ['output', 'exit', 'screen', 'input', 'client', 'dropped', 'spawned']
/** Counted output writes `last_activity_at` at most this often per session (state-machines 1.10). */
export const OUTPUT_ACTIVITY_MS = 5000
/** The heartbeat interval (state-machines 4.2). */
const PING_MS = 5000

/**
 * Delay before deckd reconnect attempt `attempt + 1`: min(2^(attempt-1), 30) units of `baseMs` with
 * ±20% jitter (failures-and-loading 3.3, state-machines 4.2), bounded for setTimeout.
 * @param {number} attempt failed attempts so far, 1 or more
 * @param {number} baseMs one backoff unit, 1000 in production
 * @param {() => number} [random] source in [0, 1) for the jitter
 * @returns {number} milliseconds, at most 2^31-1
 */
export function reconnectDelay(attempt, baseMs, random = Math.random) {
  const steps = Math.min(2 ** Math.min(Math.max(0, attempt - 1), 5), 30)
  const jitter = 0.8 + 0.4 * random()
  return Math.max(0, Math.min(Math.round(baseMs * steps * jitter), 2 ** 31 - 1))
}

/**
 * @typedef {{ ptyId: string, sessionId: string | null, parsed: import('../screen/index.mjs').ParsedScreen, rev: number, lines: string[] }} ParsedEvent
 * @typedef {{ ptyId: string, sessionId: string | null }} IdleEvent
 * @typedef {{ dep: 'deckd', state: string, reason: string | null, since: number, nextProbeAt: number | null, attempt: number, deckdVersion?: string }} DeckdHealth
 * @typedef {object} DeckdLink
 * @property {boolean} connected true once a connection finished its handshake and reconciliation, until it drops
 * @property {number} proto protocol version agreed with deckd, 0 while down
 * @property {string[]} features optional features deckd announced in `hello` (such as `guardedWrite`), empty while down
 * @property {(ptyId: string, data: string | Uint8Array, guard: { rev: number, quietMs: number }) => Promise<{ at: number }>} writeGuarded
 *   a deck-source `write` with deckd's guard (05-api 5.2, D-84). Rejects `deckd_unavailable` while down,
 *   `deckd_outdated` when deckd does not announce `guardedWrite`, and `screen_changed` or `typing_in_terminal`
 *   (409, the latter `retryable`) when deckd refuses the guard
 * @property {(op: string, fields?: object) => Promise<any>} request one deckd request, bounded by `timeoutMs`;
 *   rejects with code `deckd_unavailable` (status 503) while down, with deckd's error code when deckd refuses it
 * @property {(ev: 'output' | 'exit' | 'screen' | 'input' | 'client' | 'dropped' | 'spawned' | 'up' | 'down', fn: (msg: any, seq?: number) => void) => () => void} on
 *   subscribe to a deckd event (kept across reconnects) or to `up` and `down` (called with the deckd health
 *   row); returns the unsubscribe function
 * @property {(msg: object) => number | undefined} seqOf arrival sequence number of a message from the current connection
 * @property {(fn: (event: ParsedEvent) => void) => () => void} onParsed every `screen` event, parsed
 * @property {(fn: (event: IdleEvent) => void) => () => void} onIdle a PTY's screen became idle (SM-O6 debounce)
 * @property {() => DeckdHealth} health the deckd health row
 * @property {() => DeckdHealth} retry "Retry now": probe on a later macrotask; returns the `checking` row to publish
 * @property {() => Promise<void>} start first connect and the heartbeat; main.mjs awaits it before listening
 * @property {() => void} close stop reconnecting and drop the connection
 */

/**
 * Create the deckd link. Nothing connects until `start()`.
 * @param {{ env: Record<string, string | undefined>, connectDeckd: Function, reconnectMs?: number, random?: () => number,
 *   now?: () => number, store: object, projector: object, publish: (event: object) => void, timeoutMs?: number }} options
 * @returns {DeckdLink}
 */
export function createDeckdLink({ env, connectDeckd, reconnectMs = 1000, random = Math.random, now = Date.now, store, projector, publish, timeoutMs = 2000 }) {
  let client = null
  let ready = false
  let stopped = false
  let connecting = false
  let generation = 0
  let reconnect
  let ping = null
  const offs = []
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  const parsedFns = new Set()
  const idleFns = new Set()
  /** session id -> when counted output last wrote last_activity_at */
  const outputAt = new Map()
  /** @type {DeckdHealth} */
  const healthState = { dep: 'deckd', state: 'down', reason: 'deckd_unavailable', since: now(), nextProbeAt: null, attempt: 0 }
  const tracker = createIdleTracker({ now })
  tracker.onIdle(({ ptyId }) => idle(ptyId))

  const protoOf = candidate => candidate?.proto ?? PROTO
  const health = () => ({ ...healthState })
  const call = (fns, value) => {
    for (const fn of [...fns]) {
      try { fn(value) } catch {}
    }
  }
  const emit = (ev, msg, seq) => {
    for (const fn of [...listeners.get(ev) ?? []]) {
      try { fn(msg, seq) } catch {}
    }
  }
  const bounded = async promise => {
    let timeout
    try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(Error('deckd timed out'), { code: 'timeout' })), timeoutMs) })]) }
    finally { clearTimeout(timeout) }
  }
  // One health.changed per connect outcome, so the banner's attempt and countdown advance (failures-and-loading 3.3).
  const stateEvent = (at = now()) => {
    publish({ seq: Number(store.appendEvent({ at, type: 'health.changed', data: health() })), at, type: 'health.changed', data: health() })
  }
  function publishSession(id) {
    const at = now()
    const projection = projector.snapshot()
    for (const [type, data] of [['session.upserted', projection.sessions.find(row => row.id === id)], ['counts', projection.counts]]) {
      publish({ seq: Number(store.appendEvent({ at, type, entityId: id, data })), at, type, data })
    }
  }
  const liveSession = ptyId => store.get('SELECT * FROM sessions WHERE pty_id=? AND alive=1', ptyId)
  // deckd input sources are { kind, name? } (05-api 5.2 `write`); a session records terminal or browser, and
  // keystrokes the deck generated (kind deck) count as browser (state-machines 3.2 I.DeckKeys).
  const inputSource = source => source && typeof source === 'object'
    ? { from: source.kind === 'terminal' ? 'terminal' : 'browser', name: typeof source.name === 'string' ? source.name : null }
    : { from: null, name: null }

  // A PTY with no live session gets a `starting` row. `joined` is 1 for a PTY found by `list` at reconcile
  // (the server was away when it started) and 0 for a live `spawned` of origin wrapped (row 2).
  function createPtySession(pty, joined) {
    if (liveSession(pty.ptyId)) return
    const repoId = workingRoot(pty.cwd)
    ensureRepo(store, repoId, now)
    const id = randomUUID()
    const at = pty.startedAt ?? now()
    // `list` reports lastInputFrom as deckd's source object, or null before any input.
    const input = inputSource(pty.lastInputFrom)
    store.run('INSERT INTO sessions(id,origin,pty_id,process_key,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,joined_mid_life,started_at,last_input_from,last_input_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, pty.origin ?? 'wrapped', pty.ptyId, pty.ptyId, repoId, pty.cwd, 'starting', at, at, at, 1, joined, at, input.from, input.name)
    publishSession(id)
  }
  // Only a change of who typed last is written and published, not every keystroke.
  function applyInput(input) {
    const row = liveSession(input.ptyId)
    if (!row) return
    const { from, name } = inputSource(input.source ?? {})
    if (row.last_input_from === from && row.last_input_name === name) return
    store.run('UPDATE sessions SET last_input_from=?,last_input_name=? WHERE id=?', from, name, row.id)
    publishSession(row.id)
  }
  // `record` is the proto 2 exit record (05-api 5.2 `exits`): its raw `tail` and serialized `history` go to the
  // projector, which stores the history when there is one (06-storage `session_scrollback`).
  function applyExit(exit, record) {
    const row = liveSession(exit.ptyId)
    if (!row) return
    outputAt.delete(row.id)
    const tail = record?.tail
    const history = record?.history
    projector.signal(row.id, { type: 'exit', code: exit.code, signal: exit.signal, ...(typeof tail === 'string' ? { tail } : {}),
      ...(typeof history?.data === 'string' ? { history } : {}) }, exit.at ?? now())
  }
  // A live exit: with proto 2, read the exit record's tail and history (05-api 5.2 `exits`) before ending the session.
  async function liveExit(exit) {
    tracker.forget(exit.ptyId)
    const current = client
    let record
    if (current && protoOf(current) >= 2) {
      try {
        const found = await bounded(current.request('exits', { since: exit.at ?? 0 }))
        record = (found.exits ?? []).find(item => item.ptyId === exit.ptyId && item.at === exit.at)
      } catch {}
    }
    if (!stopped) applyExit(exit, record)
  }
  function watch(current, ptyId) {
    Promise.resolve().then(() => bounded(current.request('watchScreen', { ptyId, on: true }))).catch(() => {})
  }
  function screen(msg) {
    if (!Array.isArray(msg.lines) || !msg.lines.every(line => typeof line === 'string')) return
    const parsed = parseScreen(msg.lines, msg.cursor ?? { x: 0, y: -1 })
    const row = liveSession(msg.ptyId)
    call(parsedFns, { ptyId: msg.ptyId, sessionId: row?.id ?? null, parsed, rev: msg.rev, lines: msg.lines })
    if (row && isCountedOutput(msg.changedRows, parsed.statusRows)) {
      const at = now()
      const last = outputAt.get(row.id)
      if (row.state === 'stale' || last === undefined || at - last >= OUTPUT_ACTIVITY_MS) {
        outputAt.set(row.id, at)
        projector.signal(row.id, { type: 'output' }, at)
      }
    }
    tracker.screen(msg.ptyId, parsed.idle)
  }
  function idle(ptyId) {
    if (stopped) return
    const row = liveSession(ptyId)
    if (row && ['wrapped', 'launched'].includes(row.origin)) projector.signal(row.id, { type: 'screen_idle' }, now())
    call(idleFns, { ptyId, sessionId: row?.id ?? null })
  }
  function handle(current, ev, msg, seq) {
    if (stopped || client !== current) return
    if (!msg || typeof msg.ptyId !== 'string') return emit(ev, msg, seq)
    try {
      if (ev === 'spawned') {
        // Row 2: `fm claude` spawned through deckd. A `launched` spawn is the launch flow's own row.
        if (msg.origin === 'wrapped') createPtySession(msg, 0)
        watch(current, msg.ptyId)
      } else if (ev === 'exit') void liveExit(msg)
      else if (ev === 'input') applyInput(msg)
      else if (ev === 'screen') screen(msg)
    } catch {}
    emit(ev, msg, seq)
  }

  function retry() {
    setImmediate(() => {
      if (stopped) return
      if (client || !env.XDG_RUNTIME_DIR) return stateEvent()
      clearTimeout(reconnect)
      void connect()
    })
    return { ...healthState, state: 'checking', reason: null, nextProbeAt: now() }
  }
  function disconnect(reason = 'deckd_unavailable') {
    generation++
    for (const off of offs.splice(0)) off()
    const previous = client
    const wasReady = ready
    client = null
    ready = false
    previous?.close()
    tracker.close()
    const at = now()
    if (healthState.state !== 'down' || healthState.reason !== reason) healthState.since = at
    healthState.state = 'down'
    healthState.reason = reason
    delete healthState.deckdVersion
    // Each disconnect or failed connect is one attempt: a live link that drops reports attempt 1.
    healthState.attempt++
    const delay = reconnectDelay(healthState.attempt, reconnectMs, random)
    healthState.nextProbeAt = stopped ? null : at + delay
    if (!stopped) { stateEvent(at)
      clearTimeout(reconnect)
      reconnect = setTimeout(() => { void connect() }, delay)
      reconnect.unref() }
    if (wasReady) emit('down', health())
  }
  async function connect() {
    if (stopped || connecting || client || !env.XDG_RUNTIME_DIR) return
    connecting = true
    const turn = generation
    let candidate
    try {
      candidate = await bounded(Promise.resolve().then(() => connectDeckd({ runtimeDir: env.XDG_RUNTIME_DIR, kind: 'server', proto: PROTO })).then(next => {
        if (stopped || turn !== generation) { next.close()
          throw Error('stale connection') }
        return next
      }))
      if (stopped || turn !== generation) { candidate.close()
        return }
      client = candidate
      offs.push(candidate.on('close', () => disconnect()))
      for (const ev of FORWARDED) offs.push(candidate.on(ev, (msg, seq) => handle(candidate, ev, msg, seq)))
      const proto = protoOf(candidate)
      const [live, ended] = await Promise.all([bounded(candidate.request('list')), bounded(candidate.request('exits', { since: 0 }))])
      if (stopped || client !== candidate) return
      // Reconciliation rule 5: restore live PTYs, apply exit records (with their tails and histories), then end as lost
      // every PTY session deckd neither runs nor remembers.
      for (const pty of live.ptys ?? []) createPtySession(pty, 1)
      for (const exit of ended.exits ?? []) { tracker.forget(exit.ptyId)
        applyExit(exit, proto >= 2 ? exit : undefined) }
      const ids = new Set((live.ptys ?? []).map(pty => pty.ptyId))
      for (const row of store.all('SELECT id,pty_id FROM sessions WHERE alive=1 AND origin<>?', 'observed')) if (!ids.has(row.pty_id)) projector.signal(row.id, { type: 'lost' }, now())
      for (const pty of live.ptys ?? []) watch(candidate, pty.ptyId)
      // 05-api 5.5: an older deckd still works, without exit tails; Settings, Connections names it.
      healthState.state = 'ok'
      healthState.reason = proto < PROTO ? 'deckd_outdated' : null
      if (typeof candidate.deckdVersion === 'string' && candidate.deckdVersion) healthState.deckdVersion = candidate.deckdVersion
      healthState.since = now()
      healthState.attempt = 0
      healthState.nextProbeAt = null
      ready = true
      stateEvent()
      emit('up', health())
    } catch (error) {
      // A drop during the handshake already ran disconnect() from the close listener (it bumps the
      // generation); counting this failure again would report two attempts for one drop. A hello deckd
      // refused (it answered, but not with a protocol both sides speak) is deckd_incompatible.
      const refused = !client && error instanceof DeckdRequestError && error.code !== 'closed'
      if (!stopped && turn === generation) disconnect(refused ? 'deckd_incompatible' : 'deckd_unavailable')
      candidate?.close()
    } finally { connecting = false }
  }

  return {
    get connected() { return ready && client !== null },
    get proto() { return ready && client ? protoOf(client) : 0 },
    get features() { return ready && client && Array.isArray(client.features) ? [...client.features] : [] },
    async writeGuarded(ptyId, data, guard) {
      if (!ready || !client) throw apiError(503, 'deckd_unavailable')
      if (!Array.isArray(client.features) || !client.features.includes('guardedWrite')) throw apiError(503, 'deckd_outdated')
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
      try {
        return await bounded(client.request('write', { ptyId, data: bytes.toString('base64'), source: { kind: 'deck' }, guard: { rev: guard.rev, quietMs: guard.quietMs } }))
      } catch (error) {
        if (error?.code === 'screen_changed') throw apiError(409, 'screen_changed')
        if (error?.code === 'typing_in_terminal') throw Object.assign(apiError(409, 'typing_in_terminal'), { retryable: true })
        if (error?.code === 'closed' || error?.code === 'timeout') throw apiError(503, 'deckd_unavailable')
        throw error
      }
    },
    request(op, fields = {}) {
      if (!ready || !client) return Promise.reject(apiError(503, 'deckd_unavailable'))
      return bounded(client.request(op, fields))
    },
    on(ev, fn) {
      let set = listeners.get(ev)
      if (!set) listeners.set(ev, set = new Set())
      set.add(fn)
      return () => { set.delete(fn) }
    },
    seqOf(msg) { return client?.seqOf?.(msg) },
    onParsed(fn) { parsedFns.add(fn)
      return () => { parsedFns.delete(fn) } },
    onIdle(fn) { idleFns.add(fn)
      return () => { idleFns.delete(fn) } },
    health,
    retry,
    async start() {
      await connect()
      if (stopped || ping) return
      ping = setInterval(() => {
        const current = client
        if (current && ready) bounded(current.request('ping')).catch(() => { if (client === current) disconnect() })
      }, PING_MS)
      ping.unref()
    },
    close() {
      if (stopped) return
      stopped = true
      generation++
      clearTimeout(reconnect)
      if (ping) clearInterval(ping)
      for (const off of offs.splice(0)) off()
      client?.close()
      client = null
      ready = false
      tracker.close()
    }
  }
}
