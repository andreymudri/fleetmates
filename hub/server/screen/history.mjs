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
/** Most characters written per step; the render yields to the event loop between steps. */
export const RENDER_PIECE = 2048
/** Estimated cell operations (`stepCost`) after which a step ends early, so a step of costly sequences stays short. */
export const RENDER_STEP_COST = 250_000
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

/** C0 controls xterm executes inside a CSI without leaving it (all but CAN, SUB and ESC), and DEL, which it ignores. */
const IN_CSI = '\\x00-\\x17\\x19\\x1c-\\x1f\\x7f'
/**
 * A CSI with no prefix and no intermediate whose final is one of the handlers that loop on their first
 * parameter in @xterm/headless 6.0.0: ICH `@`, CHT `I`, IL `L`, DL `M`, DCH `P`, SU `S`, SD `T`, ECH `X`,
 * CBT `Z`, REP `b`. Introduced by `ESC [` (with any controls between the two) or C1 `0x9b`.
 */
const COUNTED = new RegExp(`(\\x1b[${IN_CSI}]*\\[|\\x9b)([0-9;:${IN_CSI}]*)([@ILMPSTXZb])`, 'g')

/**
 * Clamp the first parameter of the CSI sequences whose cost grows with it (IL, DL, SU, SD to `rows`; ICH,
 * DCH, ECH, CHT, CBT and REP to `cols`), so a crafted count costs at most a screenful. Further parameters
 * and subparameters, which xterm ignores for these, are kept. Controls inside the sequence are moved in
 * front of it, where xterm executes them anyway. Every other sequence passes through unchanged.
 * @param {string} text
 * @param {number} cols
 * @param {number} rows
 * @returns {string}
 */
export function boundCounts(text, cols, rows) {
  return text.replace(COUNTED, (match, intro, body, final) => {
    const params = body.replace(/[^0-9;:]/g, '')
    const count = /^\d*/.exec(params)[0]
    const most = 'LMST'.includes(final) ? rows : cols
    if (!(Number(count) > most)) return match
    const controls = (intro + body).replace(/[\x1b\x9b[0-9;:\x7f]/g, '')
    return `${controls}\x1b[${most}${params.slice(count.length)}${final}`
  })
}

/**
 * Sequences whose cost grows with the screen: any CSI (its prefix, parameters, intermediates and final
 * captured), and the ESC sequences DECALN (`ESC # 8`) and RIS (`ESC c`).
 */
const COSTLY = new RegExp(`(?:\\x1b[${IN_CSI}]*\\[|\\x9b)([${IN_CSI}]*[<=>?]?)([0-9;:${IN_CSI}]*)([\\x20-\\x2f${IN_CSI}]*)([\\x40-\\x7e])|\\x1b[${IN_CSI}]*(?:#[${IN_CSI}]*8|c)`, 'g')

/**
 * The estimated cell operations of one `COSTLY` match on a `cols` x `rows` screen, after `boundCounts`:
 * a line insert, delete or scroll costs a line of cells and a shift of the screen per counted line; a
 * character insert, delete, erase, tab or repeat costs a line; an erase in display, a column or margin
 * shift, a private mode change (the alternate screen), DECALN and RIS cost a screenful. Others cost nothing.
 * @param {RegExpExecArray} match
 * @param {number} cols
 * @param {number} rows
 * @returns {number}
 */
function sequenceCost([sequence, prefix, params, inter, final], cols, rows) {
  if (final === undefined) return cols * rows
  const controls = new RegExp(`[${IN_CSI}]`, 'g')
  const mark = prefix.replace(controls, '')
  const plain = !mark && !inter.replace(controls, '')
  if (plain && 'LMST'.includes(final)) return Math.min(Number(/^\d*/.exec(params.replace(/[^0-9;:]/g, ''))[0]) || 1, rows) * (cols + rows)
  if (plain && '@IPXZb'.includes(final)) return cols
  if (final === 'J' || /[ '][@A}~]$/.test(sequence) || (mark === '?' && 'hl'.includes(final))) return cols * rows
  return 0
}

/**
 * Where each write step ends: after at most `RENDER_PIECE` characters, or sooner, right after the sequence
 * that brings the step's estimated cost (`sequenceCost`) to `RENDER_STEP_COST`. A step never ends inside a
 * surrogate pair.
 * @param {string} input
 * @param {number} cols
 * @param {number} rows
 * @returns {number[]} increasing end offsets, the last one `input.length`
 */
export function stepEnds(input, cols, rows) {
  const costly = []
  for (const match of input.matchAll(COSTLY)) {
    const cost = sequenceCost(match, cols, rows)
    if (cost) costly.push({ end: match.index + match[0].length, cost })
  }
  const ends = []
  let next = 0
  for (let at = 0; at < input.length;) {
    let end = Math.min(at + RENDER_PIECE, input.length)
    let cost = 0
    for (; next < costly.length && costly[next].end <= end; next++) {
      cost += costly[next].cost
      if (cost >= RENDER_STEP_COST) {
        end = costly[next++].end
        break
      }
    }
    if (end < input.length && end - at > 1 && /[\ud800-\udbff]/.test(input[end - 1])) end--
    ends.push(end)
    at = end
  }
  return ends
}

/**
 * Make REP (`CSI Ps b`) on `term` a no-op when the character it repeats is a cluster so long that the
 * repeat would print more than `4 * cols` code units; xterm copies the whole cluster once per count.
 * @param {import('@xterm/headless').Terminal} term
 * @param {number} cols
 */
function guardRepeat(term, cols) {
  term.parser.registerCsiHandler({ final: 'b' }, params => {
    const count = typeof params[0] === 'number' && params[0] > 0 ? params[0] : 1
    const buffer = term.buffer.active
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    let cell = line?.getCell(buffer.cursorX - 1)
    if (cell && cell.getWidth() === 0) cell = line?.getCell(buffer.cursorX - 2)
    return (cell?.getChars().length ?? 0) * count > 4 * cols
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
 * (`boundCounts`) and long-cluster repeats dropped (`guardRepeat`), in steps (`stepEnds`) that yield to the
 * event loop, starting no step after `budgetMs`. The
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
  guardRepeat(term, size.cols)
  try {
    const deadline = Date.now() + budgetMs
    let at = 0
    for (const end of stepEnds(input, size.cols, size.rows)) {
      if (Date.now() >= deadline) {
        truncated = true
        break
      }
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
