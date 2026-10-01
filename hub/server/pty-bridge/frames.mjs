// Binary frames of the WebSocket terminal channel (docs/deck/05-api.md section 3.5), server side. The browser
// side is hub/web/src/state/terminal.js; both write byte 0 the kind, byte 1 the session id length, the ASCII
// session id, then the raw PTY bytes.

/** Frame kinds: 1 output (server to browser), 2 input (browser to server), 3 snapshot (server to browser). */
export const FRAME_KIND = Object.freeze({ output: 1, input: 2, snapshot: 3 })

/** Largest input payload the server writes to deckd, in bytes. */
export const MAX_INPUT_BYTES = 64 * 1024

// Characters only: the length rules (1 to 64) are the explicit checks below.
const ID_CHARS = /^[A-Za-z0-9_-]*$/

/**
 * Encode one frame.
 * @param {number} kind one of {@link FRAME_KIND}
 * @param {string} sessionId 1 to 64 characters from `[A-Za-z0-9_-]`
 * @param {Buffer | Uint8Array} payload raw bytes
 * @returns {Buffer}
 */
export function encodeFrame(kind, sessionId, payload) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 64 || !ID_CHARS.test(sessionId)) throw new TypeError('invalid session id')
  return Buffer.concat([Buffer.from([kind, sessionId.length]), Buffer.from(sessionId, 'ascii'), payload])
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data) && data.every(part => Buffer.isBuffer(part))) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return null
}

/**
 * Decode one frame. Returns null for a frame shorter than 2 bytes, an id length of 0 or over 64, a truncated
 * id, or an id outside `[A-Za-z0-9_-]`. The payload is a view into the frame.
 * @param {Buffer | ArrayBuffer | Uint8Array | Buffer[]} data a ws message
 * @returns {{ kind: number, sessionId: string, payload: Buffer } | null}
 */
export function decodeFrame(data) {
  const frame = toBuffer(data)
  if (!frame || frame.length < 2) return null
  const length = frame[1]
  if (length === 0 || length > 64 || frame.length < 2 + length) return null
  const sessionId = frame.subarray(2, 2 + length).toString('latin1')
  if (!ID_CHARS.test(sessionId)) return null
  return { kind: frame[0], sessionId, payload: frame.subarray(2 + length) }
}
