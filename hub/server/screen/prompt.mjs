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
 * @typedef {{ kind: 'permission' | 'question' | 'trust', question: string, options: PromptOption[], title: string | null, body: string | null, truncated: boolean }} Prompt
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
 * The gutter the 2.1.285 `permission-bash-long` frame draws left of each row
 * of a Bash command that wraps (`│ node --test`); the short command of
 * `permission-2` has none.
 */
const GUTTER = /^│ ?/
/**
 * A row cut with an ellipsis. No captured frame shows a cut command (the
 * long command of `permission-bash-long` wraps whole), so this marker is an
 * assumption, chosen because it only widens matching to a prefix, which the
 * F12 rule in approvals/screen-match.mjs then guards.
 */
const CUT = /…$/

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
  const asked = question(trimmed, top, first)
  return { kind: kindOf(trimmed, top, first, options), question: asked.text, options, ...content(trimmed, top, asked.row) }
}

/**
 * The box's title and body (state-machines 2.3 `screenMatch`). The title is
 * the first non-empty row inside the box ("Bash command", "Edit file",
 * "Create file", "Fetch", "☐ Choice" in the 2.1.285 frames). The body is
 * every row between the title and the question paragraph, one visible row
 * per line joined with `\n`, trimmed, with the wrap gutter removed and a
 * separator row kept as an empty line. Wrapped rows are not re-joined: in
 * `permission-bash-long` one break falls on a space and the next one inside
 * a word, so the row text alone cannot tell which a break was. When the
 * question paragraph starts on the first row inside the box, the box has no
 * title the parser can place: `title` and `body` are null.
 * @param {string[]} trimmed
 * @param {number} top
 * @param {number} questionRow first row of the question paragraph
 * @returns {{ title: string | null, body: string | null, truncated: boolean }}
 */
function content (trimmed, top, questionRow) {
  let titleRow = top + 1
  while (titleRow < questionRow && trimmed[titleRow] === '') titleRow++
  if (titleRow >= questionRow) return { title: null, body: null, truncated: false }
  const rows = trimmed.slice(titleRow + 1, questionRow)
    .map((l) => SEPARATOR.test(l) ? '' : l.replace(GUTTER, '').trim())
  while (rows.length > 0 && rows[0] === '') rows.shift()
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  return { title: trimmed[titleRow], body: rows.join('\n'), truncated: rows.some((l) => CUT.test(l)) }
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
 * else the nearest paragraph. Wrapped rows are joined with one space. `row`
 * is the paragraph's first row (`first` when there is no paragraph).
 * @param {string[]} trimmed
 * @param {number} top
 * @param {number} first row of the first option
 * @returns {{ text: string, row: number }}
 */
function question (trimmed, top, first) {
  /** @type {{ text: string, row: number }[]} */
  const paragraphs = []
  /** @type {string[]} */
  let cur = []
  /** @param {number} row */
  const flush = (row) => {
    if (cur.length > 0) paragraphs.push({ text: cur.reverse().join(' '), row })
    cur = []
  }
  for (let r = first - 1; r > top; r--) {
    const l = trimmed[r]
    if (l === '' || SEPARATOR.test(l)) flush(r + 1)
    else cur.push(l)
  }
  flush(top + 1)
  return paragraphs.find((p) => p.text.includes('?')) ?? paragraphs[0] ?? { text: '', row: first }
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
