// The deck's vault-mcp client (D-134): a small hand-written MCP client over the child's stdio,
// newline-delimited JSON-RPC 2.0 (`initialize`, `notifications/initialized`, `tools/list`,
// `tools/call`, `ping`), with the dependency health machine of
// docs/deck/interaction/state-machines.md 5.2 and 5.3 and the capability detection of
// docs/deck/10-memory-and-research.md 1.4. One long-lived child; restarts back off 2, 4, 8 ... 60 s.
// Logs carry event names, ids, sizes, durations, exit codes and error codes only, never tool
// arguments or answers.

import { spawn as nodeSpawn } from 'node:child_process'

/** The protocol version the client offers in `initialize`. */
export const PROTOCOL_VERSION = '2025-06-18'
/** The protocol versions the client accepts in the server's answer. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05'])
/** Longest stdout line accepted before the child is killed as `protocol_error`. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024
/** Size of the stderr ring whose tail becomes the health reason. */
export const STDERR_RING_BYTES = 2000
/** A probe or call slower than this counts as slow (state-machines 5.3). */
export const SLOW_MS = 5000
/** Ping period while `ok` or `degraded`. */
export const PING_EVERY_MS = 30000
/** Default timeout of a tool call. */
export const DEFAULT_CALL_TIMEOUT_MS = 10000

const CAPABILITY_ORDER = ['graph', 'structured', 'preview']

/** An error with a deck error code: `vault_unavailable`, `vault_timeout`, `protocol_error` or `vault_rpc_error`. */
export class VaultClientError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor (code, message) {
    super(message)
    this.name = 'VaultClientError'
    this.code = code
  }
}

/**
 * Restart delay after the given number of consecutive failures: 2, 4, 8 ... capped at 60 s.
 * @param {number} attempt 1 for the first failure
 * @returns {number} milliseconds
 */
export function backoffMs (attempt) {
  return Math.min(2000 * 2 ** (Math.max(attempt, 1) - 1), 60000)
}

/**
 * Capabilities from a `tools/list` answer: `graph` when `vault_graph` is listed, `structured` when
 * any tool has an `outputSchema`, `preview` when `vault_learn`'s input schema has `preview`.
 * @param {Array<Record<string, any>>} tools
 * @returns {string[]}
 */
export function capabilitiesOf (tools) {
  const found = new Set()
  for (const tool of tools) {
    if (tool?.name === 'vault_graph') found.add('graph')
    if (tool?.outputSchema) found.add('structured')
    if (tool?.name === 'vault_learn' && tool.inputSchema?.properties?.preview) found.add('preview')
  }
  return CAPABILITY_ORDER.filter(c => found.has(c))
}

/**
 * @typedef {{
 *   dep: 'vault-mcp', state: 'unknown' | 'checking' | 'ok' | 'degraded' | 'down', reason: string | null,
 *   since: number, nextProbeAt: number | null, attempt: number, version: string | null, capabilities: string[]
 * }} VaultHealth
 */

/**
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void }} Timers
 */

/**
 * Create the vault-mcp client. Nothing is spawned until `start()`.
 * @param {{
 *   command: string[],
 *   env?: Record<string, string | undefined>,
 *   spawn?: typeof nodeSpawn,
 *   now?: () => number,
 *   timers?: Timers,
 *   log?: (entry: Record<string, unknown>) => void,
 *   slowMs?: number,
 *   handshakeTimeoutMs?: number,
 *   probeTimeoutMs?: number,
 *   clientVersion?: string
 * }} options `command` is the `vaultCommand` argv; `env` is passed to the child as is (the caller
 *   builds it: `VAULT_PATH`, `VAULT_LANG`, never `VAULT_AUTO_PUSH` unless the caller adds it)
 * @returns {{
 *   start: () => Promise<VaultHealth>,
 *   call: (name: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }) =>
 *     Promise<{ text: string, structured: Record<string, unknown> | null, isError: boolean }>,
 *   probe: () => Promise<VaultHealth>,
 *   retry: () => Promise<VaultHealth>,
 *   close: () => Promise<void>,
 *   onHealth: (fn: (h: VaultHealth) => void) => () => void,
 *   health: () => VaultHealth,
 *   pid: () => number | null
 * }}
 */
export function createVaultClient ({
  command,
  env,
  spawn = nodeSpawn,
  now = Date.now,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  log = () => {},
  slowMs = SLOW_MS,
  handshakeTimeoutMs = 10000,
  probeTimeoutMs = 10000,
  clientVersion = 'dev'
}) {
  if (!Array.isArray(command) || command.length === 0) throw new TypeError('command must be a non-empty argv array')

  /** @type {VaultHealth['state']} */
  let state = 'unknown'
  /** @type {string | null} */
  let reason = null
  let since = now()
  /** @type {number | null} */
  let nextProbeAt = null
  let attempt = 0
  /** @type {string | null} */
  let version = null
  /** @type {string[]} */
  let capabilities = []
  let toolSchemas = new Map()
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let gen = 0
  let nextId = 1
  let closed = false
  let slowStreak = 0
  let fastStreak = 0
  let restartTimer = null
  let pingTimer = null
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, method: string, timer: any }>} */
  const pending = new Map()
  /** @type {Set<(h: VaultHealth) => void>} */
  const listeners = new Set()
  /** @type {Array<(h: VaultHealth) => void>} */
  let waiters = []
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const live = new Set()
  /** @type {Array<() => void>} */
  let drained = []

  /** @returns {VaultHealth} */
  function health () {
    return { dep: 'vault-mcp', state, reason, since, nextProbeAt, attempt, version, capabilities: [...capabilities] }
  }

  /**
   * @param {VaultHealth['state']} next
   * @param {string | null} why
   */
  function setState (next, why) {
    if (next !== state) since = now()
    state = next
    reason = why
    const h = health()
    for (const fn of listeners) {
      try { fn(h) } catch { /* a listener's failure is its own */ }
    }
    if (next === 'ok' || next === 'degraded' || next === 'down') {
      const ws = waiters
      waiters = []
      for (const w of ws) w(h)
    }
  }

  function clearPing () {
    if (pingTimer !== null) { timers.clearTimeout(pingTimer); pingTimer = null }
  }

  function schedulePing () {
    clearPing()
    if (closed || (state !== 'ok' && state !== 'degraded')) return
    nextProbeAt = now() + PING_EVERY_MS
    pingTimer = timers.setTimeout(() => { pingTimer = null; probe() }, PING_EVERY_MS)
  }

  /** @param {VaultClientError} err */
  function rejectAll (err) {
    for (const [id, entry] of pending) {
      pending.delete(id)
      if (entry.timer !== null) timers.clearTimeout(entry.timer)
      entry.reject(err)
    }
  }

  /**
   * Detach the current child, reject what it owed and kill it.
   * @param {VaultClientError} err
   */
  function abandon (err) {
    const proc = child
    child = null
    gen++
    clearPing()
    rejectAll(err)
    if (proc) {
      try { proc.stdin?.end() } catch { /* already closed */ }
      try { proc.kill('SIGTERM') } catch { /* already gone */ }
    }
  }

  /** @param {string} why */
  function goDown (why) {
    attempt++
    const delay = backoffMs(attempt)
    nextProbeAt = now() + delay
    log({ event: 'vault.down', attempt, delayMs: delay })
    setState('down', why)
    if (closed) return
    if (restartTimer !== null) timers.clearTimeout(restartTimer)
    restartTimer = timers.setTimeout(() => { restartTimer = null; begin() }, delay)
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  function request (method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = child
      if (!proc) { reject(new VaultClientError('vault_unavailable', 'vault-mcp is not running')); return }
      const id = nextId++
      const entry = { resolve, reject, method, timer: null }
      entry.timer = timers.setTimeout(() => {
        if (!pending.delete(id)) return
        log({ event: 'vault.timeout', method, id, timeoutMs })
        reject(new VaultClientError('vault_timeout', `${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      pending.set(id, entry)
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  function notify (method, params) {
    child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`)
  }

  /** @param {string} line */
  function handleLine (line) {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch {
      log({ event: 'vault.bad_line', bytes: Buffer.byteLength(line) })
      return
    }
    if (msg === null || typeof msg !== 'object') return
    if (typeof msg.method === 'string') {
      if (msg.id === undefined) return
      const answer = msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }
      child?.stdin?.write(`${JSON.stringify(answer)}\n`)
      return
    }
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (entry.timer !== null) timers.clearTimeout(entry.timer)
    if (msg.error) {
      const text = typeof msg.error.message === 'string' ? msg.error.message : 'error'
      entry.reject(new VaultClientError('vault_rpc_error', text))
    } else {
      entry.resolve(msg.result)
    }
  }

  /**
   * Spawn the child and wire its streams. Returns false when spawning threw.
   * @returns {boolean}
   */
  function spawnChild () {
    const myGen = ++gen
    let proc
    try {
      proc = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env })
    } catch (err) {
      goDown(`spawn failed: ${/** @type {any} */ (err)?.code ?? /** @type {any} */ (err)?.message}`)
      return false
    }
    child = proc
    live.add(proc)
    let ring = Buffer.alloc(0)
    /** @type {Buffer[]} */
    let parts = []
    let partsLen = 0
    const decoder = new TextDecoder('utf-8')
    let gone = false

    /** @param {string} why */
    const lost = (why) => {
      if (gone) return
      gone = true
      if (myGen !== gen) return
      child = null
      gen++
      clearPing()
      rejectAll(new VaultClientError('vault_unavailable', 'vault-mcp restarted'))
      goDown(why)
    }
    const tail = () => {
      const lines = ring.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean)
      return lines.length ? lines[lines.length - 1] : ''
    }

    proc.stdin?.on('error', () => {})
    proc.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
      ring = Buffer.concat([ring, chunk])
      if (ring.length > STDERR_RING_BYTES) ring = ring.subarray(ring.length - STDERR_RING_BYTES)
    })
    proc.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      let start = 0
      while (myGen === gen) {
        const nl = chunk.indexOf(10, start)
        const piece = chunk.subarray(start, nl === -1 ? chunk.length : nl)
        if (partsLen + piece.length > MAX_LINE_BYTES) {
          log({ event: 'vault.line_too_long', bytes: partsLen + piece.length })
          rejectAll(new VaultClientError('protocol_error', 'vault-mcp sent a line over 16 MiB'))
          abandon(new VaultClientError('protocol_error', 'vault-mcp sent a line over 16 MiB'))
          goDown('protocol_error: a stdout line over 16 MiB')
          return
        }
        if (nl === -1) {
          if (piece.length) { parts.push(piece); partsLen += piece.length }
          return
        }
        const line = partsLen ? Buffer.concat([...parts, piece]) : piece
        parts = []
        partsLen = 0
        start = nl + 1
        handleLine(decoder.decode(line))
      }
    })
    proc.on('error', (err) => {
      lost(`spawn failed: ${/** @type {any} */ (err).code ?? err.message}`)
    })
    proc.on('close', (code, signal) => {
      live.delete(proc)
      if (!live.size) { const ds = drained; drained = []; for (const d of ds) d() }
      const t = tail()
      log({ event: 'vault.exit', code, signal })
      lost(`spawn exited ${code ?? signal}${t ? `: ${t}` : ''}`)
    })
    return true
  }

  async function handshake () {
    const myGen = gen
    const t0 = now()
    try {
      const init = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'fleetmates-deck', version: clientVersion }
      }, handshakeTimeoutMs)
      if (myGen !== gen) return
      const answered = init?.protocolVersion
      if (!PROTOCOL_VERSIONS.includes(answered)) {
        throw new VaultClientError('protocol_error', `unsupported protocol version: ${answered}`)
      }
      notify('notifications/initialized')
      /** @type {Array<Record<string, any>>} */
      const tools = []
      let cursor
      do {
        const page = await request('tools/list', cursor ? { cursor } : {}, handshakeTimeoutMs)
        if (myGen !== gen) return
        tools.push(...(Array.isArray(page?.tools) ? page.tools : []))
        cursor = typeof page?.nextCursor === 'string' ? page.nextCursor : undefined
      } while (cursor)
      version = typeof init?.serverInfo?.version === 'string' ? init.serverInfo.version : null
      toolSchemas = new Map(tools.map(tool => [tool.name, tool.inputSchema]))
      capabilities = capabilitiesOf(tools)
      attempt = 0
      slowStreak = 0
      fastStreak = 0
      const took = now() - t0
      log({ event: 'vault.ready', tools: tools.length, durationMs: took })
      setState(took > slowMs ? 'degraded' : 'ok', took > slowMs ? 'slow start' : null)
      schedulePing()
    } catch (err) {
      if (myGen !== gen) return
      const e = /** @type {VaultClientError} */ (err)
      abandon(new VaultClientError('vault_unavailable', 'vault-mcp restarted'))
      goDown(e.code === 'protocol_error' ? e.message : `initialize failed: ${e.message}`)
    }
  }

  function begin () {
    if (closed) return
    if (restartTimer !== null) { timers.clearTimeout(restartTimer); restartTimer = null }
    nextProbeAt = null
    setState('checking', null)
    if (spawnChild()) handshake()
  }

  /** @returns {Promise<VaultHealth>} */
  function settle () {
    if (state === 'ok' || state === 'degraded' || state === 'down') return Promise.resolve(health())
    return new Promise(resolve => waiters.push(resolve))
  }

  /** @param {number} took */
  function observe (took) {
    if (took > slowMs) {
      slowStreak++
      fastStreak = 0
      if (slowStreak >= 2 && state === 'ok') setState('degraded', 'slow answers')
    } else {
      fastStreak++
      slowStreak = 0
      if (fastStreak >= 2 && state === 'degraded') setState('ok', null)
    }
  }

  /** @returns {Promise<VaultHealth>} */
  async function probe () {
    if (closed || !child) return health()
    const myGen = gen
    const t0 = now()
    try {
      await request('ping', {}, probeTimeoutMs)
    } catch (err) {
      if (myGen !== gen) return health()
      abandon(new VaultClientError('vault_unavailable', 'vault-mcp restarted'))
      goDown(`ping failed: ${/** @type {Error} */ (err).message}`)
      return health()
    }
    if (myGen !== gen) return health()
    const took = now() - t0
    if (state === 'checking') {
      slowStreak = 0
      fastStreak = 0
      setState(took > slowMs ? 'degraded' : 'ok', took > slowMs ? 'slow answers' : null)
    } else {
      observe(took)
    }
    schedulePing()
    return health()
  }

  return {
    toolSchema: name => { const schema = toolSchemas.get(name); return schema ? structuredClone(schema) : null },
    health,
    probe,
    pid: () => child?.pid ?? null,

    start () {
      if (closed) return Promise.reject(new VaultClientError('vault_unavailable', 'vault-mcp client is closed'))
      if (state === 'unknown') begin()
      return settle()
    },

    async call (name, args = {}, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
      if (state !== 'ok' && state !== 'degraded') {
        throw new VaultClientError('vault_unavailable', `vault-mcp is ${state}`)
      }
      const myGen = gen
      const t0 = now()
      let result
      try {
        result = await request('tools/call', { name, arguments: args }, timeoutMs)
      } catch (err) {
        const e = /** @type {VaultClientError} */ (err)
        if (e.code === 'vault_timeout' && myGen === gen && (state === 'ok' || state === 'degraded')) {
          clearPing()
          setState('checking', `${name} timed out`)
          probe()
        }
        throw err
      }
      const took = now() - t0
      if (myGen === gen) observe(took)
      const content = Array.isArray(result?.content) ? result.content : []
      const text = content.filter((/** @type {any} */ c) => c?.type === 'text' && typeof c.text === 'string')
        .map((/** @type {any} */ c) => c.text).join('\n')
      const structured = result?.structuredContent && typeof result.structuredContent === 'object'
        ? result.structuredContent
        : null
      const isError = result?.isError === true
      log({ event: 'vault.call', tool: name, durationMs: took, bytes: Buffer.byteLength(text), isError })
      return { text, structured, isError }
    },

    retry () {
      if (closed) return Promise.resolve(health())
      clearPing()
      if (child) abandon(new VaultClientError('vault_unavailable', 'vault-mcp restarted'))
      begin()
      return settle()
    },

    onHealth (fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },

    close () {
      closed = true
      if (restartTimer !== null) { timers.clearTimeout(restartTimer); restartTimer = null }
      clearPing()
      listeners.clear()
      abandon(new VaultClientError('vault_unavailable', 'vault-mcp client is closed'))
      const ws = waiters
      waiters = []
      for (const w of ws) w(health())
      if (!live.size) return Promise.resolve()
      const kill = timers.setTimeout(() => { for (const p of live) { try { p.kill('SIGKILL') } catch {} } }, 2000)
      return new Promise(resolve => {
        drained.push(() => { timers.clearTimeout(kill); resolve() })
      })
    }
  }
}
