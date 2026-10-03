// Permission, question and trust prompt boxes on a rendered Claude Code
// screen (docs/deck/04-integrations.md 2.3). Written against the 2.1.282
// frames in hub/test/fixtures/screens/2.1.282/ and checked against the
// 2.1.285 frames in hub/test/fixtures/screens/2.1.285/.
//
// Known limit: a box whose top edge has scrolled off the screen parses as
// no prompt (`null`). Whether real Claude Code ever draws such a box is
// unverified.
//
// PTY screen text is untrusted data (docs/deck/08-security.md:95), so a row
// the agent printed must not make parsing slow. No pattern here has nested
// or adjacent unbounded quantifiers that can match the same characters, and
// each row is matched a fixed number of times. The tests "a hostile screen
// parses in linear time" and "long near-miss rows for every screen pattern
// parse fast" in hub/test/unit/screen-parsers.test.mjs pin this with long
// rows that almost match each pattern and fail on their last characters.
import { inputRow } from './status-region.mjs'

/**
 * @typedef {{ key: string | null, label: string }} PromptOption
 * @typedef {{ kind: 'permission' | 'question' | 'trust', question: string, options: PromptOption[] }} Prompt
 */

/** Top edge of a prompt box (and of the input box): a full row of `─`. */
const BOX_TOP = /^─{10,}$/
/** A numbered option on a trimmed row: optional `❯` cursor, the digit as printed, the label. */
const NUMBERED = /^(❯ *)?(\d+)\. +(\S.*)$/
/** The selected row of an unnumbered option list (the trust dialog), on a trimmed row. */
const SELECTED = /^❯ +(\S.*)$/
/** Every complete 2.1.282 prompt box ends with a hint row naming Esc. */
const FOOTER = /Esc to cancel/
/**
 * A deny option labelled with its Esc shortcut, "No, and tell Claude what to
 * do differently (esc)". The 2.1.285 WebFetch frame ends on this option, the
 * last of its box, with no footer row below it; it is the only captured frame
 * whose box carries no footer. That the `(esc)` option is always the last
 * one is an assumption read from the captured and hand-written boxes, not
 * something Claude Code documents.
 */
const ESC_OPTION = /\(esc\)$/
/** A row that separates paragraphs inside a box. */
const SEPARATOR = /^[─╌]+$/
/** The tab header of an AskUserQuestion box. */
const QUESTION_TAB = /[☐☒]/

/**
 * Find the prompt box on screen. Returns `null` when there is none, or when
 * its end is not visible (a box cut off at the bottom is never returned as
 * a partial option list), or when the cursor sits in an input box below
 * that end (a real prompt box replaces the input box, so a box above a live
 * input box is transcript text). The end is the footer row below the
 * options, or else the last option itself when its label ends in `(esc)`
 * (ESC_OPTION): a box drawn only part way down, before that option, still
 * parses as `null`.
 * @param {string[]} lines rendered rows
 * @param {{ x: number, y: number }} [cursor]
 * @returns {Prompt | null}
 */
export function parsePrompt (lines, cursor) {
  const trimmed = lines.map((l) => l.trim())
  const found = numberedOptions(lines, trimmed) ?? unnumberedOptions(lines, trimmed)
  if (!found) return null
  const { rows, options } = found
  const first = rows[0]
  const last = rows[rows.length - 1]
  let end = last + 1
  while (end < trimmed.length && !FOOTER.test(trimmed[end])) end++
  if (end === trimmed.length) {
    if (!ESC_OPTION.test(options[options.length - 1].label)) return null
    end = last
  }
  if (cursor && inputRow(lines, cursor) > end) return null
  // The box top is the nearest `─` rule above the FIRST option, so a rule
  // inside the box (AskUserQuestion draws one above "Chat about this") is
  // never mistaken for it.
  let top = first - 1
  while (top >= 0 && !BOX_TOP.test(trimmed[top])) top--
  if (top === -1) return null
  return { kind: kindOf(trimmed, top, first, options), question: question(trimmed, top, first), options }
}

/**
 * The last run of rows numbered 1, 2, ... n on screen, one of them carrying
 * the `❯` cursor. Rows between options (descriptions, rules) are skipped.
 * A number that does not continue the run ends it: a gap (1, 2, 4) leaves
 * no run, so the screen is not a prompt rather than a list that drops or
 * invents an option. Only rows whose number starts in the same column as
 * the number on the last `❯` row count, so an indented description that
 * starts with "1. " is not an option.
 * @param {string[]} lines
 * @param {string[]} trimmed
 * @returns {{ rows: number[], options: PromptOption[] } | null}
 */
function numberedOptions (lines, trimmed) {
  /** @type {{ row: number, n: number, selected: boolean, label: string, col: number }[]} */
  const numbered = []
  for (let r = 0; r < trimmed.length; r++) {
    const m = NUMBERED.exec(trimmed[r])
    if (!m) continue
    const col = lines[r].length - lines[r].trimStart().length + (m[1]?.length ?? 0)
    numbered.push({ row: r, n: Number(m[2]), selected: Boolean(m[1]), label: m[3], col })
  }
  const cursorRow = numbered.findLast((o) => o.selected)
  if (!cursorRow) return null
  /** @type {typeof numbered} */
  let run = []
  for (const opt of numbered) {
    if (opt.col !== cursorRow.col) continue
    if (opt.n === 1) run = [opt]
    else if (run.length > 0 && opt.n === run[run.length - 1].n + 1) run.push(opt)
    else run = []
  }
  if (run.length === 0 || !run.some((o) => o.selected)) return null
  return {
    rows: run.map((o) => o.row),
    options: run.map((o) => ({ key: String(o.n), label: o.label }))
  }
}

/**
 * Options without digits (the trust dialog): the last `❯` row and the rows
 * around it whose text starts at the same column. `key` is `null`: none is
 * printed. A row that looks numbered ("N. label") is never one of these.
 * @param {string[]} lines
 * @param {string[]} trimmed
 * @returns {{ rows: number[], options: PromptOption[] } | null}
 */
function unnumberedOptions (lines, trimmed) {
  let sel = trimmed.length - 1
  while (sel >= 0 && !SELECTED.test(trimmed[sel])) sel--
  if (sel === -1) return null
  const col = /** @type {RegExpExecArray} */ (/^\s*❯\s+/.exec(lines[sel]))[0].length
  /** @param {number} r */
  const sibling = (r) => trimmed[r] !== '' && !trimmed[r].startsWith('❯') && lines[r].search(/\S/) === col
  let first = sel
  while (first - 1 >= 0 && sibling(first - 1)) first--
  let last = sel
  while (last + 1 < lines.length && sibling(last + 1)) last++
  const rows = []
  const options = []
  for (let r = first; r <= last; r++) {
    const label = r === sel ? /** @type {RegExpExecArray} */ (SELECTED.exec(trimmed[r]))[1] : trimmed[r]
    if (NUMBERED.test(label)) return null
    rows.push(r)
    options.push({ key: null, label })
  }
  return { rows, options }
}

/**
 * The nearest paragraph above the options that asks something (holds a `?`),
 * else the nearest paragraph. Wrapped rows are joined with one space.
 * @param {string[]} trimmed
 * @param {number} top
 * @param {number} first row of the first option
 * @returns {string}
 */
function question (trimmed, top, first) {
  /** @type {string[]} */
  const paragraphs = []
  /** @type {string[]} */
  let cur = []
  const flush = () => {
    if (cur.length > 0) paragraphs.push(cur.reverse().join(' '))
    cur = []
  }
  for (let r = first - 1; r > top; r--) {
    const l = trimmed[r]
    if (l === '' || SEPARATOR.test(l)) flush()
    else cur.push(l)
  }
  flush()
  return paragraphs.find((p) => p.includes('?')) ?? paragraphs[0] ?? ''
}

/**
 * @param {string[]} trimmed
 * @param {number} top
 * @param {number} first
 * @param {PromptOption[]} options
 * @returns {Prompt['kind']}
 */
function kindOf (trimmed, top, first, options) {
  if (options.some((o) => /^Yes, I trust/.test(o.label))) return 'trust'
  if (trimmed.slice(top + 1, first).some((l) => QUESTION_TAB.test(l))) return 'question'
  return 'permission'
}
