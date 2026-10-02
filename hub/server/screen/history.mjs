// The rendered history of an ended session (docs/deck/06-storage.md `session_scrollback`): stored text
// written into a headless terminal and serialized, so it replays as rows at any browser size.
import xtermHeadless from '@xterm/headless'
import addonSerialize from '@xterm/addon-serialize'
import { capHistory } from '../../deckd/screen-model.mjs'

const { Terminal } = xtermHeadless
const { SerializeAddon } = addonSerialize

/** The size a stored row without one (a legacy row or a raw tail) is rendered at. */
export const DEFAULT_RENDER_SIZE = Object.freeze({ cols: 120, rows: 40 })
/** Most UTF-8 bytes of stored text one render feeds the terminal: the newest, cut at a line start. */
export const RENDER_INPUT_CAP = 256 * 1024
/** Time after which a render starts no further write step; it then stops and reports truncated. */
export const RENDER_BUDGET_MS = 500
/** Characters written per step; the render yields to the event loop between steps. */
export const RENDER_PIECE = 2048
/** Most scrollback rows a render keeps. */
export const RENDER_SCROLLBACK_MAX = 5000

/** What addon-serialize 0.14.0 writes before the alternate screen's rows (as in deckd's ScreenModel). */
const ALT_SWITCH = '\x1b[?1049h\x1b[H'
/** The size header of a stored history: XTWINOPS "resize to rows x cols" (`CSI 8 ; rows ; cols t`). */
const SIZE_HEADER = /^\x1b\[8;(\d{1,4});(\d{1,4})t/

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

/**
 * A history size clamped to 20..500 columns and 5..200 rows, or null when either is not a finite number.
 * @param {{ cols?: unknown, rows?: unknown } | undefined | null} size
 * @returns {{ cols: number, rows: number } | null}
 */
export function historySize(size) {
  const { cols, rows } = size ?? {}
  if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isFinite(cols) || !Number.isFinite(rows)) return null
  return { cols: clamp(Math.floor(cols), 20, 500), rows: clamp(Math.floor(rows), 5, 200) }
}

/**
 * The size header `session_scrollback.text` starts with when it holds a serialized history of that size.
 * @param {{ cols: number, rows: number }} size an already clamped size (`historySize`)
 * @returns {string}
 */
export function sizeHeader({ cols, rows }) {
  return `\x1b[8;${rows};${cols}t`
}

/**
 * Split a stored `session_scrollback.text` into its text and the size its header names; a row with no header
 * (a raw tail, or a row written before sizes were stored) has size null.
 * @param {string} stored
 * @returns {{ text: string, size: { cols: number, rows: number } | null }}
 */
export function readStoredHistory(stored) {
  const header = SIZE_HEADER.exec(stored)
  if (!header) return { text: stored, size: null }
  return { text: stored.slice(header[0].length), size: historySize({ cols: Number(header[2]), rows: Number(header[1]) }) }
}

/**
 * Clamp the count of the CSI sequences whose cost grows with their count (IL, DL, SU, SD to `rows`; ICH,
 * DCH, ECH to `cols`; REP to `cols * rows`), so a crafted count costs at most a screenful. Every other
 * sequence passes through unchanged.
 * @param {string} text
 * @param {number} cols
 * @param {number} rows
 * @returns {string}
 */
export function boundCounts(text, cols, rows) {
  return text.replace(/(\x1b\[|\x9b)(\d+)([LMST@PXb])/g, (match, csi, count, final) => {
    const most = 'LMST'.includes(final) ? rows : final === 'b' ? cols * rows : cols
    return Number(count) > most ? `${csi}${most}${final}` : match
  })
}

/**
 * The newest at most `RENDER_INPUT_CAP` bytes of `text`, cut at a line start when one is in reach.
 * @param {string} text
 * @returns {string}
 */
function newestInput(text) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= RENDER_INPUT_CAP) return text
  return capHistory(text, RENDER_INPUT_CAP) || buf.subarray(buf.length - RENDER_INPUT_CAP).toString('utf8')
}

/**
 * The scrollback and the screen, serialized without modes and without an alternate-buffer switch, the way
 * deckd's `ScreenModel.history()` does it.
 * @param {import('@xterm/headless').Terminal} term
 * @param {InstanceType<typeof SerializeAddon>} serializer
 * @param {number} scrollback
 * @returns {string}
 */
function serialize(term, serializer, scrollback) {
  const opts = { excludeModes: true, excludeAltBuffer: true }
  if (term.buffer.active.type !== 'alternate') return serializer.serialize({ ...opts, scrollback })
  const full = serializer.serialize({ excludeModes: true, scrollback })
  const at = full.indexOf(ALT_SWITCH)
  const alt = at === -1 ? '' : full.slice(at + ALT_SWITCH.length)
  const len = term.buffer.normal.length
  const normal = serializer.serialize({ ...opts, range: { start: Math.max(0, len - scrollback - term.rows), end: len - 1 } })
  return `${normal}\x1b[0m\r\n${alt}`
}

/**
 * Write `text` into a headless terminal of the given size (clamped as `historySize` does) and return its
 * serialized scrollback and screen, with colours and attributes, no terminal modes and no alternate-buffer
 * switch. Only the newest `RENDER_INPUT_CAP` bytes are written, with crafted counts bounded
 * (`boundCounts`), in `RENDER_PIECE` steps that yield to the event loop, starting no step after `budgetMs`. The
 * scrollback is sized from the input, up to `RENDER_SCROLLBACK_MAX` rows. `truncated` is true when input
 * was left out: cut to the input cap, stopped by the budget, or pushed out of a full scrollback.
 * @param {string} text
 * @param {{ cols?: number, rows?: number, budgetMs?: number }} [options]
 * @returns {Promise<{ data: string, truncated: boolean }>}
 */
export async function renderHistory(text, { cols = DEFAULT_RENDER_SIZE.cols, rows = DEFAULT_RENDER_SIZE.rows, budgetMs = RENDER_BUDGET_MS } = {}) {
  const size = historySize({ cols, rows }) ?? DEFAULT_RENDER_SIZE
  const fed = newestInput(text)
  let truncated = fed !== text
  const input = boundCounts(fed, size.cols, size.rows)
  let newlines = 0
  for (let at = input.indexOf('\n'); at !== -1; at = input.indexOf('\n', at + 1)) newlines++
  const scrollback = Math.min(RENDER_SCROLLBACK_MAX, newlines + Math.ceil(input.length / size.cols) + 1)
  const term = new Terminal({ cols: size.cols, rows: size.rows, scrollback, allowProposedApi: true })
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)
  try {
    const deadline = Date.now() + budgetMs
    for (let at = 0; at < input.length;) {
      if (Date.now() >= deadline) {
        truncated = true
        break
      }
      let end = Math.min(at + RENDER_PIECE, input.length)
      // Keep a surrogate pair in one piece.
      if (end < input.length && /[\ud800-\udbff]/.test(input[end - 1])) end--
      const piece = input.slice(at, end)
      await new Promise(resolve => term.write(piece, () => resolve(undefined)))
      at = end
    }
    if (term.buffer.normal.length >= scrollback + size.rows) truncated = true
    return { data: serialize(term, serializer, scrollback), truncated }
  } finally {
    term.dispose()
  }
}
