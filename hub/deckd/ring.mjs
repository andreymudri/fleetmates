// Scrollback ring for one PTY: keeps the newest raw output bytes, capped at
// 5,000 lines or 2 MiB, whichever is smaller (docs/deck/03-architecture.md 2.1).
// "Lines" counts newline bytes: at most `maxLines` complete lines are kept,
// plus the unterminated tail.

export const RING_MAX_LINES = 5000
export const RING_MAX_BYTES = 2 * 1024 * 1024

/**
 * Count newline bytes in a buffer.
 * @param {Buffer} buf
 * @returns {number}
 */
function countNewlines (buf) {
  let n = 0
  let i = -1
  while ((i = buf.indexOf(0x0a, i + 1)) !== -1) n++
  return n
}

export class Ring {
  /**
   * @param {{ maxLines?: number, maxBytes?: number }} [opts]
   */
  constructor ({ maxLines = RING_MAX_LINES, maxBytes = RING_MAX_BYTES } = {}) {
    this.maxLines = maxLines
    this.maxBytes = maxBytes
    /** @type {{ buf: Buffer, nl: number }[]} */
    this.chunks = []
    this.bytes = 0
    this.lines = 0
  }

  /**
   * Append output bytes, dropping the oldest bytes past either cap.
   * @param {Buffer} buf
   */
  push (buf) {
    if (buf.length === 0) return
    const copy = Buffer.from(buf)
    const nl = countNewlines(copy)
    this.chunks.push({ buf: copy, nl })
    this.bytes += copy.length
    this.lines += nl
    this.#trimBytes()
    this.#trimLines()
  }

  /**
   * The retained bytes, oldest first.
   * @returns {Buffer}
   */
  snapshot () {
    return Buffer.concat(this.chunks.map((c) => c.buf), this.bytes)
  }

  #trimBytes () {
    while (this.bytes > this.maxBytes) {
      const first = this.chunks[0]
      const excess = this.bytes - this.maxBytes
      if (first.buf.length <= excess) {
        this.chunks.shift()
        this.bytes -= first.buf.length
        this.lines -= first.nl
      } else {
        const rest = first.buf.subarray(excess)
        const nl = countNewlines(rest)
        this.lines -= first.nl - nl
        this.bytes -= excess
        this.chunks[0] = { buf: rest, nl }
      }
    }
  }

  #trimLines () {
    while (this.lines > this.maxLines) {
      const first = this.chunks[0]
      const need = this.lines - this.maxLines
      if (first.nl <= need) {
        this.chunks.shift()
        this.bytes -= first.buf.length
        this.lines -= first.nl
      } else {
        let i = -1
        for (let k = 0; k < need; k++) i = first.buf.indexOf(0x0a, i + 1)
        const rest = first.buf.subarray(i + 1)
        this.bytes -= i + 1
        this.lines -= need
        this.chunks[0] = { buf: rest, nl: first.nl - need }
      }
    }
  }
}
