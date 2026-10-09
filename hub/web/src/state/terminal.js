/**
 * Client side of the WebSocket terminal channel (docs/deck/05-api.md section 3.5): the binary frame
 * layout, a per-tab terminal client over `createConnection`, and the paste guards of state-machines 3.5.
 */

/** Binary frame kinds: byte 0 of every terminal frame. */
export const FRAME_KIND = Object.freeze({ output: 1, input: 2, snapshot: 3 })

/** Most tail subscriptions one socket may hold (05-api 3.5, `sub.tails`). */
export const MAX_TAILS = 50

/** Paste size above which the SPA asks first (state-machines 3.5), in UTF-8 bytes. */
export const PASTE_CONFIRM_BYTES = 4096

const ID = /^[A-Za-z0-9_-]{1,64}$/
const encoder = new TextEncoder()

function toBytes(data) {
  if (typeof data === 'string') return encoder.encode(data)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new TypeError('terminal data must be a string or bytes')
}

/**
 * Encode one terminal frame: byte 0 the kind, byte 1 the session id length, the ASCII id, then the payload.
 * @param {number} kind one of {@link FRAME_KIND}
 * @param {string} sessionId 1 to 64 characters from `[A-Za-z0-9_-]`
 * @param {string | Uint8Array | ArrayBuffer} payload a string is sent as UTF-8
 * @returns {Uint8Array}
 */
export function encodeFrame(kind, sessionId, payload) {
  if (typeof sessionId !== 'string' || !ID.test(sessionId)) throw new TypeError('invalid session id')
  const body = toBytes(payload)
  const frame = new Uint8Array(2 + sessionId.length + body.length)
  frame[0] = kind
  frame[1] = sessionId.length
  for (let i = 0; i < sessionId.length; i++) frame[2 + i] = sessionId.charCodeAt(i)
  frame.set(body, 2 + sessionId.length)
  return frame
}

/**
 * Encode browser keystrokes or a paste for one session as an input frame (kind 2).
 * @param {string} sessionId
 * @param {string | Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function encodeInput(sessionId, bytes) {
  return encodeFrame(FRAME_KIND.input, sessionId, bytes)
}

/**
 * Decode a binary frame. Returns null for a frame shorter than 2 bytes, an id length of 0 or over 64,
 * a truncated id, or an id outside `[A-Za-z0-9_-]`. The payload is a view into the frame.
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {{ kind: number, sessionId: string, payload: Uint8Array } | null}
 */
export function decodeServerFrame(buffer) {
  let frame
  try { frame = toBytes(buffer) } catch { return null }
  if (frame.length < 2) return null
  const length = frame[1]
  if (length === 0 || length > 64 || frame.length < 2 + length) return null
  const sessionId = String.fromCharCode(...frame.subarray(2, 2 + length))
  if (!ID.test(sessionId)) return null
  return { kind: frame[0], sessionId, payload: frame.subarray(2 + length) }
}

/**
 * @typedef {object} TerminalHandlers
 * @property {(message: { sessionId: string, ptyId: string, cols: number, rows: number }) => void} [onAttached]
 * @property {(bytes: Uint8Array) => void} [onSnapshot] the screen plus scrollback; reset the terminal first
 * @property {(bytes: Uint8Array) => void} [onOutput]
 * @property {(message: { sessionId: string, code: number | null, signal: string | null }) => void} [onExit]
 * @property {(error: { code: string, message?: string }) => void} [onError]
 */

/**
 * The terminal client for one tab. Every `attach` sends `term.attach`; the client sends it again for every
 * attached session when the connection returns to `live` and after a `term.error output_dropped`, so the
 * server resends the screen. `subscribeTails` is sent again on `live` too.
 * @param {{ onTerm: Function, onBinary: Function, onLive: Function, send: (message: object) => boolean, sendBinary: (bytes: Uint8Array) => boolean }} connection
 * @returns {{
 *   attach: (sessionId: string, size: { cols: number, rows: number }, handlers?: TerminalHandlers) => { write: (data: string | Uint8Array) => boolean, resize: (cols: number, rows: number) => boolean, detach: () => void },
 *   subscribeTails: (ids: string[]) => boolean,
 *   close: () => void
 * }}
 */
export function createTerminalClient(connection) {
  const attached = new Map()
  let tails = null
  const sendAttach = (sessionId, entry) => connection.send({ t: 'term.attach', sessionId, cols: entry.cols, rows: entry.rows })
  const off = [
    connection.onTerm(message => {
      const entry = attached.get(message?.sessionId)
      if (!entry) return
      if (message.t === 'term.attached') entry.handlers.onAttached?.(message)
      else if (message.t === 'term.exit') entry.handlers.onExit?.(message)
      else if (message.t === 'term.error') {
        if (message.error?.code === 'output_dropped') sendAttach(message.sessionId, entry)
        else entry.handlers.onError?.(message.error ?? { code: 'internal' })
      }
    }),
    connection.onBinary(data => {
      const frame = decodeServerFrame(data)
      const entry = frame && attached.get(frame.sessionId)
      if (!entry) return
      if (frame.kind === FRAME_KIND.snapshot) entry.handlers.onSnapshot?.(frame.payload)
      else if (frame.kind === FRAME_KIND.output) entry.handlers.onOutput?.(frame.payload)
    }),
    connection.onLive(() => {
      for (const [sessionId, entry] of attached) sendAttach(sessionId, entry)
      if (tails) connection.send({ t: 'sub.tails', sessionIds: tails })
    })
  ]
  return {
    attach(sessionId, { cols, rows }, handlers = {}) {
      const entry = { cols, rows, handlers }
      attached.set(sessionId, entry)
      sendAttach(sessionId, entry)
      const current = () => attached.get(sessionId) === entry
      return {
        write(data) {
          if (!current()) return false
          return connection.sendBinary(encodeInput(sessionId, data))
        },
        resize(nextCols, nextRows) {
          if (!current()) return false
          entry.cols = nextCols
          entry.rows = nextRows
          return connection.send({ t: 'term.resize', sessionId, cols: nextCols, rows: nextRows })
        },
        detach() {
          if (!current()) return
          attached.delete(sessionId)
          connection.send({ t: 'term.detach', sessionId })
        }
      }
    },
    subscribeTails(ids) {
      tails = [...ids].filter(id => typeof id === 'string').slice(0, MAX_TAILS)
      return connection.send({ t: 'sub.tails', sessionIds: tails })
    },
    close() {
      for (const unsubscribe of off) unsubscribe()
      attached.clear()
      tails = null
    }
  }
}

const PASTE_END = '\u001b[201~'
// Every C0 control except tab (0x09) and newline (0x0a).
const C0 = /[\u0000-\u0008\u000b-\u001f]/g

/**
 * Clean pasted text before xterm wraps it in bracketed paste: remove every `ESC[201~` (until none is
 * left, so a marker rebuilt by a removal goes too) and every C0 control except tab and newline.
 * @param {string} text
 * @returns {string}
 */
export function sanitizePaste(text) {
  let clean = String(text ?? '')
  while (clean.includes(PASTE_END)) clean = clean.split(PASTE_END).join('')
  return clean.replace(C0, '')
}

/**
 * Whether a paste is above 4 KB counted in UTF-8 bytes.
 * @param {string} text
 * @returns {boolean}
 */
export function pasteNeedsConfirm(text) {
  return encoder.encode(String(text ?? '')).length > PASTE_CONFIRM_BYTES
}

/**
 * Paste size for the confirm copy ("Paste {size} into {repo}?"), rounded to whole KB.
 * @param {string} text
 * @returns {string}
 */
export function pasteSizeText(text) {
  return `${Math.round(encoder.encode(String(text ?? '')).length / 1024)} KB`
}

// The phone key bar and its sticky Ctrl (design mobile-focus-mockup). The logic lives here, as a pure
// transition, so it is tested as behaviour rather than as the shape of the component that calls it.

/** Characters that have a control code, tested before any case conversion (see {@link controlOf}). */
const CONTROL_KEYS = /^[a-zA-Z@[\\\]^_]$/
/** The arrow sequences, and what the same arrow is with Ctrl held. */
const CTRL_ARROWS = Object.freeze({ '\x1b[A': '\x1b[1;5A', '\x1b[B': '\x1b[1;5B', '\x1b[C': '\x1b[1;5C', '\x1b[D': '\x1b[1;5D' })

/**
 * The control code one keystroke becomes while the sticky Ctrl is held.
 *
 * The class is tested on the character itself, never on its upper case form: `'ß'.toUpperCase()` is `'SS'`, so
 * converting first and then taking code unit 0 turned `ß` into Ctrl+S, the XOFF that freezes a terminal, and
 * `ı` into Tab. Anything without a control code (an accent, a digit, an emoji, a multi-character paste or an
 * escape sequence) passes through unchanged, so holding Ctrl never alters a key it cannot modify.
 * @param {string} input one keystroke as xterm reports it
 * @returns {string}
 */
export function controlOf(input) {
  if (typeof input !== 'string' || input.length !== 1) return input
  if (CONTROL_KEYS.test(input)) return String.fromCharCode(input.toUpperCase().charCodeAt(0) - 64)
  if (input === ' ') return '\x00'
  if (input === '/') return '\x1f'
  if (input === '?') return '\x7f'
  return input
}

/**
 * One keystroke through the sticky modifier, from the phone keyboard or from the key bar alike: what to send,
 * and the modifier afterwards. Any keystroke consumes an armed Ctrl, including one the modifier cannot change,
 * so a bar key can never leave it armed for a later letter the user did not mean to modify.
 * @param {string} input
 * @param {boolean} [ctrl] whether the sticky Ctrl is armed
 * @returns {{ send: string, ctrl: boolean }}
 */
export function keystroke(input, ctrl = false) {
  if (!ctrl) return { send: input, ctrl: false }
  return { send: CTRL_ARROWS[input] ?? controlOf(input), ctrl: false }
}

/**
 * The key bar's keys, in the order the design puts them (mobile-focus-mockup). The `ctrl` entry sends nothing of
 * its own: it arms the modifier the next keystroke consumes.
 */
export const KEY_BAR = Object.freeze([
  { id: 'esc', label: 'Esc', send: '\x1b' },
  { id: 'tab', label: 'Tab', send: '\t' },
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'up', label: '\u2191', send: '\x1b[A' },
  { id: 'down', label: '\u2193', send: '\x1b[B' },
  { id: 'left', label: '\u2190', send: '\x1b[D' },
  { id: 'right', label: '\u2192', send: '\x1b[C' },
  { id: 'slash', label: '/', send: '/' },
  { id: 'pipe', label: '|', send: '|' },
  { id: 'tilde', label: '~', send: '~' }
])
