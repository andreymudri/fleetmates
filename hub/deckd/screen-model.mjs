// Headless terminal model of one PTY: what is on screen right now, as plain
// text rows, for the web server's screen parsers (docs/deck/05-api.md 5.4),
// and its serialized history for replay at any size (5.2).
import xtermHeadless from '@xterm/headless'
import addonSerialize from '@xterm/addon-serialize'

const { Terminal } = xtermHeadless
const { SerializeAddon } = addonSerialize

/** Scrollback lines the model keeps and `history()` serializes. */
export const HISTORY_LINES = 1000

/** Minimum gap between two `screen` emissions to one watcher: at most 4 per second. */
export const SCREEN_THROTTLE_MS = 250

/** What addon-serialize 0.14.0 writes before the alternate screen's rows. */
const ALT_SWITCH = '\x1b[?1049h\x1b[H'

/**
 * @typedef {{ rev: number, lines: string[], cursor: { x: number, y: number }, changedRows: number[] }} ScreenEvent
 * @typedef {{ data: string, cols: number, rows: number }} History
 */

/**
 * Cut serialized history to at most `maxBytes` UTF-8 bytes by dropping whole
 * leading lines: the result starts right after a `\r\n` of `data`, so it never
 * starts inside an escape sequence or a multi-byte character. Returns '' when
 * no line boundary leaves a short enough rest.
 * @param {string} data
 * @param {number} maxBytes
 * @returns {string}
 */
export function capHistory (data, maxBytes) {
  const buf = Buffer.from(data, 'utf8')
  if (buf.length <= maxBytes) return data
  const crlf = buf.indexOf('\r\n', Math.max(0, buf.length - maxBytes - 2))
  if (crlf === -1) return ''
  return buf.subarray(crlf + 2).toString('utf8')
}

export class ScreenModel {
  /**
   * @param {{ cols: number, rows: number }} size
   */
  constructor ({ cols, rows }) {
    this.term = new Terminal({ cols, rows, scrollback: HISTORY_LINES, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer)
    this.rev = 0
    /** @type {Set<() => void>} */
    this.listeners = new Set()
    /** Unsubscribe functions of active watches. @type {Set<() => void>} */
    this.watches = new Set()
  }

  get cols () { return this.term.cols }
  get rows () { return this.term.rows }

  /**
   * Feed PTY output. `rev` increments once the bytes are parsed.
   * @param {Buffer | Uint8Array | string} buf
   */
  write (buf) {
    this.term.write(typeof buf === 'string' ? buf : new Uint8Array(buf), () => this.#changed())
  }

  /**
   * Wait until every byte written so far is parsed.
   * @returns {Promise<void>}
   */
  flush () {
    return new Promise((resolve) => this.term.write('', () => resolve()))
  }

  /**
   * @param {number} cols
   * @param {number} rows
   */
  resize (cols, rows) {
    if (cols === this.term.cols && rows === this.term.rows) return
    this.term.resize(cols, rows)
    this.#changed()
  }

  /**
   * Visible rows as plain text, trailing blanks trimmed.
   * @returns {string[]}
   */
  lines () {
    const buf = this.term.buffer.active
    /** @type {string[]} */
    const out = []
    for (let y = 0; y < this.term.rows; y++) {
      out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
    }
    return out
  }

  /**
   * The scrollback and the screen, serialized with colours and attributes,
   * and the model's size now. Call after `flush()` to include every byte.
   * `data` carries no terminal modes (mouse tracking, bracketed paste, focus
   * reporting, application cursor keys) and never switches to the alternate
   * buffer: on the alternate screen it is the normal buffer's scrollback and
   * screen, then the alternate screen's rows, all for the normal buffer.
   * @returns {History}
   */
  history () {
    return { data: this.#serialize(), cols: this.term.cols, rows: this.term.rows }
  }

  /** @returns {string} */
  #serialize () {
    const opts = { excludeModes: true, excludeAltBuffer: true }
    if (this.term.buffer.active.type !== 'alternate') {
      return this.serializer.serialize({ ...opts, scrollback: HISTORY_LINES })
    }
    // The addon writes the alternate screen after ALT_SWITCH; take its rows
    // from there, and the normal buffer by range, which leaves out the
    // normal buffer's cursor restore so the alternate rows follow its last row.
    const full = this.serializer.serialize({ excludeModes: true, scrollback: HISTORY_LINES })
    const at = full.indexOf(ALT_SWITCH)
    const alt = at === -1 ? '' : full.slice(at + ALT_SWITCH.length)
    const len = this.term.buffer.normal.length
    const normal = this.serializer.serialize({
      ...opts,
      range: { start: Math.max(0, len - HISTORY_LINES - this.term.rows), end: len - 1 }
    })
    return `${normal}\x1b[0m\r\n${alt}`
  }

  /**
   * Cursor position inside the visible screen.
   * @returns {{ x: number, y: number }}
   */
  cursor () {
    const buf = this.term.buffer.active
    return { x: buf.cursorX, y: buf.cursorY }
  }

  /**
   * Call `onScreen` when visible rows change, at most once per
   * SCREEN_THROTTLE_MS, never when only the cursor moved.
   * @param {(ev: ScreenEvent) => void} onScreen
   * @returns {() => void} unsubscribe
   */
  watch (onScreen) {
    let last = this.lines()
    let lastEmit = 0
    /** @type {NodeJS.Timeout | null} */
    let timer = null
    const check = () => {
      timer = null
      const now = this.lines()
      /** @type {number[]} */
      const changedRows = []
      for (let i = 0; i < Math.max(now.length, last.length); i++) {
        if (now[i] !== last[i]) changedRows.push(i)
      }
      if (changedRows.length === 0) return
      last = now
      lastEmit = Date.now()
      onScreen({ rev: this.rev, lines: now, cursor: this.cursor(), changedRows })
    }
    const listener = () => {
      if (timer) return
      const delay = Math.max(0, lastEmit + SCREEN_THROTTLE_MS - Date.now())
      timer = setTimeout(check, delay)
      timer.unref()
    }
    this.listeners.add(listener)
    const unsubscribe = () => {
      this.listeners.delete(listener)
      this.watches.delete(unsubscribe)
      if (timer) clearTimeout(timer)
      timer = null
    }
    this.watches.add(unsubscribe)
    return unsubscribe
  }

  dispose () {
    for (const unsubscribe of [...this.watches]) unsubscribe()
    this.listeners.clear()
    this.term.dispose()
  }

  #changed () {
    this.rev++
    for (const l of this.listeners) l()
  }
}
