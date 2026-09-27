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
    /** False once a byte trim has cut the oldest retained line. */
    this.startsAtLine = true
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

  /**
   * The newest `n` lines, starting at a line boundary. A trailing newline
   * ends the last line; an unterminated tail counts as a line. With fewer
   * than `n` lines retained it returns them all, minus a first line that a
   * byte trim cut short.
   * @param {number} n
   * @returns {Buffer}
   */
  tail (n) {
    const buf = this.snapshot()
    if (n <= 0 || buf.length === 0) return Buffer.alloc(0)
    let pos = buf[buf.length - 1] === 0x0a ? buf.length - 1 : buf.length
    for (let k = 0; k < n; k++) {
      pos = pos === 0 ? -1 : buf.lastIndexOf(0x0a, pos - 1)
      if (pos === -1) break
    }
    if (pos !== -1) return buf.subarray(pos + 1)
    if (this.startsAtLine) return buf
    const nl = buf.indexOf(0x0a)
    return nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1)
  }

  #trimBytes () {
    while (this.bytes > this.maxBytes) {
      const first = this.chunks[0]
      const excess = this.bytes - this.maxBytes
      if (first.buf.length <= excess) {
        this.chunks.shift()
        this.bytes -= first.buf.length
        this.lines -= first.nl
        this.startsAtLine = first.buf[first.buf.length - 1] === 0x0a
      } else {
        this.startsAtLine = first.buf[excess - 1] === 0x0a
        const rest = first.buf.subarray(excess)
        const nl = countNewlines(rest)
        this.lines -= first.nl - nl
        this.bytes -= excess
        this.chunks[0] = { buf: rest, nl }
      }
    }
  }

  #trimLines () {
    // this trim always cuts right after a newline
    if (this.lines > this.maxLines) this.startsAtLine = true
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
