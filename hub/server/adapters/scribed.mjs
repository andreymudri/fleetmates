// Client for TurbidAssist's scribed daemon, written against
// docs/deck/reference/vault-turbid-contract.md sections 2.2 to 2.5 and 2.14
// and docs/deck/11-meetings.md 3.1 to 3.4. encodeCommand and decodeEvent
// cover the whole closed message list so the fixtures in
// test/fixtures/scribed/ can be checked line by line. Error messages mirror
// realtime/scribe/protocol.py at TurbidAssist d4ffb9d, except the JSON parse
// error, whose tail is the JavaScript parser's own text. The standalone
// `status` and `subscribe` are the M1 calls; createScribedClient is the full
// client (one connection per request, its own connection per subscription).

import net from 'node:net'
import path from 'node:path'

export const SOCKET_NAME = 'turbidassist.sock'
export const DEFAULT_TIMEOUT_MS = 5000

/** @type {Record<string, string>} cmd name to the Python class name */
const COMMAND_CLASSES = {
  start: 'StartCmd',
  stop: 'StopCmd',
  status: 'StatusCmd',
  tail: 'TailCmd',
  ask: 'AskCmd',
  subscribe: 'SubscribeCmd',
  history: 'HistoryCmd'
}
const COMMANDS = Object.keys(COMMAND_CLASSES).sort()

/** @type {Record<string, string>} event type to the Python class name */
const EVENT_CLASSES = {
  ok: 'Ok',
  error: 'Error',
  status: 'Status',
  tail: 'Tail',
  transcript: 'Transcript',
  ask_delta: 'AskDelta',
  ask_done: 'AskDone',
  history: 'HistoryResult'
}
const EVENTS = Object.keys(EVENT_CLASSES).sort()

/** Error thrown for a line or command that is not a valid protocol message. */
export class ProtocolError extends Error {
  /**
   * @param {string} message
   * @param {string} [code] `unknown_type` for an event type outside the closed list
   */
  constructor (message, code) {
    super(message)
    this.name = 'ProtocolError'
    if (code !== undefined) this.code = code
  }
}

/** Error raised when the daemon answers with an `error` event. */
export class ScribedError extends Error {
  /**
   * @param {string} cmd
   * @param {string} message
   */
  constructor (cmd, message) {
    super(message)
    this.name = 'ScribedError'
    this.cmd = cmd
  }
}

/** The socket could not be reached, or it closed before answering. */
export class ScribedUnavailable extends Error {
  /**
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor (message, cause) {
    super(message, { cause })
    this.name = 'ScribedUnavailable'
  }
}

/** The daemon did not answer in time. */
export class ScribedTimeout extends Error {
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'ScribedTimeout'
  }
}

/**
 * Python's type(value).__name__ for a JSON value.
 * @param {unknown} value
 * @returns {string}
 */
function pyType (value) {
  if (value === null) return 'NoneType'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'string') return 'str'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  if (Array.isArray(value)) return 'list'
  return 'dict'
}

/**
 * Close enough to Python's repr() for the names that appear in error messages.
 * @param {unknown} value
 * @returns {string}
 */
function pyRepr (value) {
  if (value === undefined || value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') {
    if (value.includes("'") && !value.includes('"')) return `"${value}"`
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  return JSON.stringify(value)
}

/**
 * @param {string[]} names
 * @returns {string}
 */
function pyList (names) {
  return `[${names.map((n) => pyRepr(n)).join(', ')}]`
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a required key, checked like protocol.py `_get`.
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {'number' | 'string' | 'boolean' | 'list' | 'dict'} kind
 * @param {string} what
 * @returns {any}
 */
function get (raw, key, kind, what) {
  if (!Object.hasOwn(raw, key)) throw new ProtocolError(`${what}: chave ${pyRepr(key)} ausente`)
  const value = raw[key]
  if (kind === 'number') {
    if (typeof value !== 'number') throw new ProtocolError(`${what}.${key}: esperado número, veio ${pyType(value)}`)
    return value
  }
  const ok = kind === 'list'
    ? Array.isArray(value)
    : kind === 'dict' ? isObject(value) : typeof value === kind
  if (!ok) throw new ProtocolError(`${what}.${key}: tipo inválido ${pyType(value)}`)
  return value
}

/**
 * Optional key: missing or null reads as null.
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {'string'} kind
 * @param {string} what
 * @returns {any}
 */
function opt (raw, key, kind, what) {
  if (raw[key] === undefined || raw[key] === null) return null
  return get(raw, key, kind, what)
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} what
 * @returns {string[]}
 */
function strList (raw, key, what) {
  const value = get(raw, key, 'list', what)
  if (!value.every((/** @type {unknown} */ v) => typeof v === 'string')) {
    throw new ProtocolError(`${what}.${key}: esperado lista de strings`)
  }
  return [...value]
}

/**
 * @param {unknown} raw
 * @returns {{ t: number, question: string, answer: string, context_minutes: number }}
 */
function askRecord (raw) {
  if (!isObject(raw)) throw new ProtocolError(`AskRecord: esperado objeto, veio ${pyType(raw)}`)
  return {
    t: get(raw, 't', 'number', 'AskRecord'),
    question: get(raw, 'question', 'string', 'AskRecord'),
    answer: get(raw, 'answer', 'string', 'AskRecord'),
    context_minutes: get(raw, 'context_minutes', 'number', 'AskRecord')
  }
}

/**
 * Validate a command object and return it with only its own keys, in wire order.
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function commandFrom (raw) {
  if (!isObject(raw)) throw new ProtocolError(`esperado objeto JSON, veio ${pyType(raw)}`)
  if (!('cmd' in raw)) {
    if ('type' in raw) {
      const ev = eventFrom(raw)
      throw new ProtocolError(`esperado Command, veio ${EVENT_CLASSES[/** @type {string} */ (ev.type)]}`)
    }
    throw new ProtocolError("mensagem sem discriminador: falta 'cmd' ou 'type'")
  }
  const name = raw.cmd
  if (typeof name !== 'string' || !Object.hasOwn(COMMAND_CLASSES, name)) {
    throw new ProtocolError(`cmd desconhecido: ${pyRepr(name)} (conhecidos: ${pyList(COMMANDS)})`)
  }
  switch (name) {
    case 'start': return { cmd: name, tag: get(raw, 'tag', 'string', 'start') }
    case 'tail': return { cmd: name, minutes: get(raw, 'minutes', 'number', 'tail') }
    case 'ask': return { cmd: name, question: get(raw, 'question', 'string', 'ask') }
    default: return { cmd: name }
  }
}

/**
 * Validate an event object and return it with only its own keys, in wire order.
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
function eventFrom (raw) {
  const name = raw.type
  if (typeof name !== 'string' || !Object.hasOwn(EVENT_CLASSES, name)) {
    throw new ProtocolError(`type desconhecido: ${pyRepr(name)} (conhecidos: ${pyList(EVENTS)})`,
      typeof name === 'string' ? 'unknown_type' : undefined)
  }
  switch (name) {
    case 'ok': {
      /** @type {Record<string, unknown>} */
      const out = { type: name, cmd: get(raw, 'cmd', 'string', 'ok') }
      const sessionId = opt(raw, 'session_id', 'string', 'ok')
      if (sessionId !== null) out.session_id = sessionId
      return out
    }
    case 'error':
      return { type: name, cmd: get(raw, 'cmd', 'string', 'error'), message: get(raw, 'message', 'string', 'error') }
    case 'status': {
      /** @type {Record<string, unknown>} */
      const out = {
        type: name,
        recording: get(raw, 'recording', 'boolean', 'status'),
        session_id: opt(raw, 'session_id', 'string', 'status'),
        tag: opt(raw, 'tag', 'string', 'status'),
        elapsed_s: get(raw, 'elapsed_s', 'number', 'status'),
        routed_apps: strList(raw, 'routed_apps', 'status')
      }
      // Optional keys a later scribed may add; kept only when type-correct.
      if (typeof raw.stopping === 'boolean') out.stopping = raw.stopping
      if (typeof raw.protocol === 'number') out.protocol = raw.protocol
      return out
    }
    case 'tail':
      return { type: name, text: get(raw, 'text', 'string', 'tail') }
    case 'transcript':
      return { type: name, event: { ...get(raw, 'event', 'dict', 'transcript') } }
    case 'ask_delta':
      return { type: name, text: get(raw, 'text', 'string', 'ask_delta') }
    case 'history':
      return { type: name, asks: get(raw, 'asks', 'list', 'history').map(askRecord) }
    default:
      return { type: name }
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Serialize one command as a JSON line. Accents stay raw UTF-8 (JSON.stringify
 * does not escape non-ASCII), like the daemon's `ensure_ascii=False`.
 * @param {{ cmd: string, [key: string]: unknown }} cmd
 * @returns {string} the line, terminated by `\n`
 * @throws {ProtocolError} unknown `cmd` or a missing or wrong-typed field
 */
export function encodeCommand (cmd) {
  return JSON.stringify(commandFrom(cmd)) + '\n'
}

/**
 * Parse one daemon line into an event object. Unknown keys are dropped, an
 * unknown `type` throws, number fields reject booleans.
 * @param {string | Uint8Array} line
 * @returns {Record<string, any> & { type: string }}
 * @throws {ProtocolError}
 */
export function decodeEvent (line) {
  let text
  if (typeof line === 'string') {
    text = line
  } else {
    try {
      text = utf8.decode(line)
    } catch (err) {
      throw new ProtocolError(`linha não é UTF-8 válido: ${/** @type {Error} */ (err).message}`)
    }
  }
  text = text.trim()
  if (!text) throw new ProtocolError('linha vazia')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ProtocolError(`linha não é JSON válido: ${/** @type {Error} */ (err).message}`)
  }
  if (!isObject(raw)) throw new ProtocolError(`esperado objeto JSON, veio ${pyType(raw)}`)
  if (!('type' in raw)) {
    if ('cmd' in raw) {
      const cmd = commandFrom(raw)
      throw new ProtocolError(`esperado Event, veio ${COMMAND_CLASSES[/** @type {string} */ (cmd.cmd)]}`)
    }
    throw new ProtocolError("mensagem sem discriminador: falta 'cmd' ou 'type'")
  }
  return /** @type {any} */ (eventFrom(raw))
}

/**
 * `$XDG_RUNTIME_DIR/turbidassist.sock`. There is no fallback: the socket
 * carries the live transcript with no peer authentication.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultSocketPath (env = process.env) {
  const dir = env.XDG_RUNTIME_DIR
  if (!dir) throw new Error(`XDG_RUNTIME_DIR is not set; refusing to guess where ${SOCKET_NAME} lives`)
  return path.join(dir, SOCKET_NAME)
}

/**
 * Split a byte stream on `\n` and hand each complete line over as bytes, so a
 * multibyte character cut across chunks is decoded whole.
 * @param {(line: Buffer) => void} onLine
 * @returns {(chunk: Buffer) => void}
 */
function lineSplitter (onLine) {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let nl
    while ((nl = pending.indexOf(0x0a)) !== -1) {
      const line = pending.subarray(0, nl)
      pending = pending.subarray(nl + 1)
      if (line.length) onLine(line)
    }
  }
}

/**
 * Ask the daemon for its status on a fresh connection.
 * @param {{ socketPath?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<Record<string, any>>} the decoded `status` event
 * @throws {ScribedError | ScribedUnavailable | ScribedTimeout | ProtocolError}
 */
export async function status ({ socketPath = defaultSocketPath(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = net.createConnection({ path: socketPath })
    /**
     * @param {Error | null} err
     * @param {any} [value]
     */
    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new ScribedTimeout(`status: no answer from ${socketPath} in ${timeoutMs} ms`)), timeoutMs)
    socket.on('connect', () => socket.write(encodeCommand({ cmd: 'status' })))
    socket.on('data', lineSplitter((line) => {
      try {
        const evt = decodeEvent(line)
        if (evt.type === 'error') finish(new ScribedError(evt.cmd, evt.message))
        else if (evt.type !== 'status') finish(new ProtocolError(`status: unexpected event type ${evt.type}`))
        else finish(null, evt)
      } catch (err) {
        finish(/** @type {Error} */ (err))
      }
    }))
    socket.on('error', (err) => finish(new ScribedUnavailable(`status: cannot reach ${socketPath}: ${err.message}`, err)))
    socket.on('close', () => finish(new ScribedUnavailable(`status: ${socketPath} closed before answering`)))
  })
}

/**
 * Open a long-lived `subscribe` connection. The daemon sends one `status`
 * then `transcript` events; each decoded event goes to `onEvent` in order.
 * `onClose` runs once: with `null` when the daemon ends the stream or
 * `close()` is called, with the error otherwise (connect failure, bad line).
 * @param {{
 *   socketPath?: string,
 *   onEvent: (event: Record<string, any>) => void,
 *   onClose?: (err: Error | null) => void
 * }} opts
 * @returns {{ close: () => void }}
 */
export function subscribe ({ socketPath = defaultSocketPath(), onEvent, onClose = () => {} }) {
  let closed = false
  const socket = net.createConnection({ path: socketPath })
  /** @param {Error | null} err */
  const finish = (err) => {
    if (closed) return
    closed = true
    socket.destroy()
    onClose(err)
  }
  socket.on('connect', () => socket.write(encodeCommand({ cmd: 'subscribe' })))
  socket.on('data', lineSplitter((line) => {
    if (closed) return
    let evt
    try {
      evt = decodeEvent(line)
    } catch (err) {
      finish(/** @type {Error} */ (err))
      return
    }
    onEvent(evt)
  }))
  socket.on('error', (err) => finish(new ScribedUnavailable(`subscribe: ${socketPath}: ${err.message}`, err)))
  socket.on('close', () => finish(null))
  return { close: () => finish(null) }
}

/** Longest line a connection accepts, newline excluded. */
export const MAX_LINE_BYTES = 1024 * 1024
/** Longest line accepted on a connection waiting for a `tail` answer. */
export const MAX_TAIL_LINE_BYTES = 16 * 1024 * 1024

/** Read timeouts in ms per command (11-meetings 3.3); `stop` is a ceiling. */
export const CLIENT_TIMEOUTS = Object.freeze({
  status: 5000,
  tail: 5000,
  history: 5000,
  start: 20000,
  stop: 180000,
  ask: 130000
})

/**
 * Split a byte stream on `\n` and hand each complete line over as bytes, so a
 * multibyte character cut across chunks is decoded whole. A line longer than
 * `maxBytes` (newline excluded) calls `onOverflow` once and stops the reader.
 * Chunks are kept in a list, so a long line is copied once, not per chunk.
 * @param {number} maxBytes
 * @param {(line: Buffer) => void} onLine
 * @param {(bytes: number) => void} onOverflow
 * @returns {(chunk: Buffer) => void}
 */
function cappedLines (maxBytes, onLine, onOverflow) {
  /** @type {Buffer[]} */
  let parts = []
  let size = 0
  let dead = false
  /** @param {number} bytes */
  const overflow = (bytes) => {
    dead = true
    parts = []
    onOverflow(bytes)
  }
  return (chunk) => {
    let from = 0
    while (!dead) {
      const nl = chunk.indexOf(0x0a, from)
      if (nl === -1) {
        const rest = chunk.subarray(from)
        size += rest.length
        if (size > maxBytes) overflow(size)
        else if (rest.length) parts.push(rest)
        return
      }
      const piece = chunk.subarray(from, nl)
      const length = size + piece.length
      if (length > maxBytes) {
        overflow(length)
        return
      }
      const line = parts.length ? Buffer.concat([...parts, piece], length) : piece
      parts = []
      size = 0
      from = nl + 1
      if (line.length) onLine(line)
    }
  }
}

/**
 * True when every byte is ASCII whitespace (the daemon strips lines).
 * @param {Buffer} line
 * @returns {boolean}
 */
function isBlank (line) {
  for (const b of line) {
    if (b !== 0x20 && b !== 0x09 && b !== 0x0d && b !== 0x0b && b !== 0x0c) return false
  }
  return true
}

/**
 * @param {AbortSignal} signal
 * @returns {unknown}
 */
function abortReason (signal) {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function strOrNull (value) {
  return typeof value === 'string' ? value : null
}

/**
 * Map a `transcript` event body to a display line. `mic` is the owner
 * ("Você"), `room` everyone else ("Sala").
 * @param {unknown} event the `event` object of a `transcript` message
 * @returns {{ t0: number, t1: number, speaker: 'Você' | 'Sala', text: string,
 *   sessionId: string | null, lang: string | null, asrModel: string | null } | null}
 *   null when `t0` or `t1` is not a number (booleans refused), `source` is not
 *   `mic` or `room`, or `text` is not a string
 */
export function transcriptLine (event) {
  if (!isObject(event)) return null
  const { t0, t1, source, text } = event
  if (typeof t0 !== 'number' || typeof t1 !== 'number') return null
  if (source !== 'mic' && source !== 'room') return null
  if (typeof text !== 'string') return null
  return {
    t0,
    t1,
    speaker: source === 'mic' ? 'Você' : 'Sala',
    text,
    sessionId: strOrNull(event.session_id),
    lang: strOrNull(event.lang),
    asrModel: strOrNull(event.asr_model)
  }
}

/**
 * @typedef {{ event: string, cmd?: string, bytes?: number }} ScribedLogEntry
 *   what the client logs: event names, the command and byte counts, never text
 */

/**
 * The full scribed client (11-meetings 3.1 to 3.3). Every request opens its
 * own connection and closes it after the answer; `subscribe` has its own
 * long-lived connection. Nothing is retried here.
 * @param {{
 *   socketPath?: string,
 *   log?: (entry: ScribedLogEntry) => void,
 *   timeouts?: Partial<Record<keyof typeof CLIENT_TIMEOUTS, number>>
 * }} [opts] `socketPath` defaults to `defaultSocketPath()`, resolved per call
 */
export function createScribedClient ({ socketPath, log = () => {}, timeouts = {} } = {}) {
  const limits = { ...CLIENT_TIMEOUTS, ...timeouts }
  const counters = { unknownTypes: 0 }

  /** @returns {string} */
  const resolvePath = () => socketPath ?? defaultSocketPath()

  /**
   * Line handler shared by every connection: decode, skip unknown types.
   * @param {string} cmd
   * @param {(evt: Record<string, any>) => void} onEvent
   * @param {(err: Error) => void} onError
   * @returns {(line: Buffer) => void}
   */
  function decoder (cmd, onEvent, onError) {
    return (line) => {
      if (isBlank(line)) return
      let evt
      try {
        evt = decodeEvent(line)
      } catch (err) {
        if (err instanceof ProtocolError && err.code === 'unknown_type') {
          counters.unknownTypes++
          log({ event: 'scribed.unknown_type', cmd, bytes: line.length })
          return
        }
        log({ event: 'scribed.protocol_error', cmd, bytes: line.length })
        onError(/** @type {Error} */ (err))
        return
      }
      onEvent(evt)
    }
  }

  /**
   * Send one command on a fresh connection and read events until `onEvent`
   * calls `finish`.
   * @param {Record<string, unknown> & { cmd: string }} command
   * @param {{
   *   timeoutMs: number,
   *   maxLine?: number,
   *   signal?: AbortSignal,
   *   onEvent: (evt: Record<string, any>, finish: (err: unknown, value?: any) => void) => void
   * }} opts
   * @returns {Promise<any>}
   */
  function exchange (command, { timeoutMs, maxLine = MAX_LINE_BYTES, signal, onEvent }) {
    const cmd = command.cmd
    return new Promise((resolve, reject) => {
      let target
      try {
        target = resolvePath()
      } catch (err) {
        reject(new ScribedUnavailable(`${cmd}: ${/** @type {Error} */ (err).message}`, err))
        return
      }
      const line = encodeCommand(command)
      if (signal?.aborted) {
        reject(abortReason(signal))
        return
      }
      let settled = false
      const socket = net.createConnection({ path: target })
      /**
       * @param {unknown} err
       * @param {any} [value]
       */
      const finish = (err, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        socket.destroy()
        if (err) reject(err)
        else resolve(value)
      }
      const onAbort = () => finish(abortReason(/** @type {AbortSignal} */ (signal)))
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        log({ event: 'scribed.timeout', cmd })
        finish(new ScribedTimeout(`${cmd}: no answer from scribed in ${timeoutMs} ms`))
      }, timeoutMs)
      socket.on('connect', () => {
        socket.write(line)
        log({ event: 'scribed.request', cmd, bytes: Buffer.byteLength(line) })
      })
      socket.on('data', cappedLines(maxLine, decoder(cmd, (evt) => {
        if (settled) return
        try {
          onEvent(evt, finish)
        } catch (err) {
          finish(err)
        }
      }, finish), (bytes) => {
        log({ event: 'scribed.line_too_long', cmd, bytes })
        finish(new ProtocolError(`${cmd}: line longer than ${maxLine} bytes`))
      }))
      socket.on('error', (err) => {
        finish(new ScribedUnavailable(`${cmd}: cannot reach scribed: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? err.message}`, err))
      })
      socket.on('close', () => finish(new ScribedUnavailable(`${cmd}: scribed closed the connection before answering`)))
    })
  }

  /**
   * One request, one answer of `type` (for `ok`, its `cmd` must match).
   * @param {Record<string, unknown> & { cmd: string }} command
   * @param {string} type
   * @param {number} [maxLine]
   * @returns {Promise<Record<string, any>>}
   */
  function request (command, type, maxLine) {
    const cmd = command.cmd
    return exchange(command, {
      timeoutMs: limits[/** @type {keyof typeof CLIENT_TIMEOUTS} */ (cmd)],
      maxLine,
      onEvent: (evt, finish) => {
        if (evt.type === 'error') finish(new ScribedError(evt.cmd, evt.message))
        else if (evt.type !== type) finish(new ProtocolError(`${cmd}: unexpected event type ${evt.type}`))
        else if (type === 'ok' && evt.cmd !== cmd) finish(new ProtocolError(`${cmd}: ok answers ${evt.cmd}`))
        else finish(null, evt)
      }
    })
  }

  return {
    /**
     * @returns {Promise<Record<string, any>>} the decoded `status` event
     */
    status: () => request({ cmd: 'status' }, 'status'),

    /**
     * @param {string} tag
     * @returns {Promise<{ session_id: string | null }>}
     */
    start: async (tag) => {
      const evt = await request({ cmd: 'start', tag }, 'ok')
      return { session_id: evt.session_id ?? null }
    },

    /** @returns {Promise<{ session_id: string | null }>} */
    stop: async () => {
      const evt = await request({ cmd: 'stop' }, 'ok')
      return { session_id: evt.session_id ?? null }
    },

    /**
     * @param {number} minutes
     * @returns {Promise<string>} the plain `tail` text, `''` when idle
     */
    tail: async (minutes) => (await request({ cmd: 'tail', minutes }, 'tail', MAX_TAIL_LINE_BYTES)).text,

    /** @returns {Promise<{ asks: Array<{ t: number, question: string, answer: string, context_minutes: number }> }>} */
    history: async () => ({ asks: (await request({ cmd: 'history' }, 'history')).asks }),

    /**
     * Stream an answer: `onDelta` gets each `ask_delta` text in order; resolves
     * on `ask_done`, rejects `ScribedError` on `error`. Aborting `signal`
     * stops the deltas, closes the connection (scribed has no cancel) and
     * rejects with the abort reason.
     * @param {string} question
     * @param {{ onDelta?: (text: string) => void, signal?: AbortSignal }} [opts]
     * @returns {Promise<void>}
     */
    ask: (question, { onDelta = () => {}, signal } = {}) => exchange({ cmd: 'ask', question }, {
      timeoutMs: limits.ask,
      signal,
      onEvent: (evt, finish) => {
        if (evt.type === 'ask_delta') onDelta(evt.text)
        else if (evt.type === 'ask_done') finish(null)
        else if (evt.type === 'error') finish(new ScribedError(evt.cmd, evt.message))
        else finish(new ProtocolError(`ask: unexpected event type ${evt.type}`))
      }
    }),

    /**
     * Open a subscription on its own connection: `onStatus` for each `status`
     * (scribed sends one, first), `onTranscript` with each transcript event
     * body, and `onClose(err | null)` once: null on EOF or `close()`.
     * @param {{
     *   onStatus?: (status: Record<string, any>) => void,
     *   onTranscript?: (event: Record<string, any>) => void,
     *   onClose?: (err: Error | null) => void
     * }} [opts]
     * @returns {{ close: () => void }}
     */
    subscribe: ({ onStatus = () => {}, onTranscript = () => {}, onClose = () => {} } = {}) => {
      let closed = false
      /** @type {net.Socket | null} */
      let socket = null
      /** @param {unknown} err */
      const finish = (err) => {
        if (closed) return
        closed = true
        socket?.destroy()
        onClose(/** @type {Error | null} */ (err))
      }
      let target
      try {
        target = resolvePath()
      } catch (err) {
        const wrapped = new ScribedUnavailable(`subscribe: ${/** @type {Error} */ (err).message}`, err)
        queueMicrotask(() => finish(wrapped))
        return { close: () => finish(null) }
      }
      const sock = net.createConnection({ path: target })
      socket = sock
      sock.on('connect', () => sock.write(encodeCommand({ cmd: 'subscribe' })))
      sock.on('data', cappedLines(MAX_LINE_BYTES, decoder('subscribe', (evt) => {
        if (closed) return
        try {
          if (evt.type === 'status') onStatus(evt)
          else if (evt.type === 'transcript') onTranscript(evt.event)
          else if (evt.type === 'error') finish(new ScribedError(evt.cmd, evt.message))
          else finish(new ProtocolError(`subscribe: unexpected event type ${evt.type}`))
        } catch (err) {
          finish(err)
        }
      }, finish), (bytes) => {
        log({ event: 'scribed.line_too_long', cmd: 'subscribe', bytes })
        finish(new ProtocolError(`subscribe: line longer than ${MAX_LINE_BYTES} bytes`))
      }))
      sock.on('error', (err) => {
        finish(new ScribedUnavailable(`subscribe: cannot reach scribed: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? err.message}`, err))
      })
      sock.on('close', () => finish(null))
      return { close: () => finish(null) }
    },

    /** @returns {{ unknownTypes: number }} lines skipped for an unknown event type */
    stats: () => ({ ...counters })
  }
}
