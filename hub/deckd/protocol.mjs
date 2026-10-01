// Wire format between deckd and its clients: one UTF-8 JSON object per line,
// byte payloads as base64 (docs/deck/05-api.md section 5.1).

/** Highest deckd protocol version this build speaks. */
export const PROTO = 2

/** Longest request line deckd reads; a longer one is discarded (08-security 4.3). */
export const MAX_LINE = 1024 * 1024

/** Per-client output queue cap in bytes before deckd drops output and sends `dropped`. */
export const OUTPUT_QUEUE_CAP = 8 * 1024 * 1024

/**
 * Encode one message as a JSON line.
 * @param {unknown} obj
 * @returns {string}
 */
export function encode (obj) {
  return JSON.stringify(obj) + '\n'
}

/**
 * Create a decoder for a byte stream of JSON lines. Chunks may split a line,
 * or a multi-byte character, anywhere. A line that is not JSON is reported
 * through `onError({ code: 'bad_json' })` and skipped; decoding goes on. A
 * line longer than `maxLine` bytes is discarded up to its newline and
 * reported once through `onError({ code: 'line_too_long' })`, without
 * buffering more than `maxLine` bytes of it.
 * @param {(msg: any) => void} onMessage
 * @param {(err: { code: string }) => void} onError
 * @param {{ maxLine?: number }} [opts]
 * @returns {(chunk: Buffer | string) => void}
 */
export function createLineDecoder (onMessage, onError, { maxLine = Infinity } = {}) {
  /** @type {Buffer} */
  let pending = Buffer.alloc(0)
  /** True while the rest of an over-long line is being thrown away. */
  let discarding = false
  return (chunk) => {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (discarding) {
      const nl = buf.indexOf(0x0a)
      if (nl === -1) return
      discarding = false
      buf = buf.subarray(nl + 1)
    }
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf])
    let start = 0
    let nl
    while ((nl = pending.indexOf(0x0a, start)) !== -1) {
      const len = nl - start
      const line = len > maxLine ? '' : pending.toString('utf8', start, nl)
      start = nl + 1
      if (len > maxLine) {
        onError({ code: 'line_too_long' })
        continue
      }
      if (line.trim() === '') continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        onError({ code: 'bad_json' })
        continue
      }
      onMessage(msg)
    }
    pending = start === 0 ? pending : pending.subarray(start)
    if (pending.length > maxLine) {
      pending = Buffer.alloc(0)
      discarding = true
      onError({ code: 'line_too_long' })
    }
  }
}
