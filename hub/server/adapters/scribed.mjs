// Minimal client for TurbidAssist's scribed daemon, written against
// docs/deck/reference/vault-turbid-contract.md sections 2.2 to 2.5 and 2.14.
// Only `status` and `subscribe` have client calls; encodeCommand and
// decodeEvent cover the whole closed message list so the fixtures in
// test/fixtures/scribed/ can be checked line by line. Error messages mirror
// realtime/scribe/protocol.py at TurbidAssist d4ffb9d, except the JSON parse
// error, whose tail is the JavaScript parser's own text.

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
  /** @param {string} message */
  constructor (message) {
    super(message)
    this.name = 'ProtocolError'
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
    throw new ProtocolError(`type desconhecido: ${pyRepr(name)} (conhecidos: ${pyList(EVENTS)})`)
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
    case 'status':
      return {
        type: name,
        recording: get(raw, 'recording', 'boolean', 'status'),
        session_id: opt(raw, 'session_id', 'string', 'status'),
        tag: opt(raw, 'tag', 'string', 'status'),
        elapsed_s: get(raw, 'elapsed_s', 'number', 'status'),
        routed_apps: strList(raw, 'routed_apps', 'status')
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
