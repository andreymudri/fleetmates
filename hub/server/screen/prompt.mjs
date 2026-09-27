// Permission, question and trust prompt boxes on a rendered Claude Code
// screen (docs/deck/04-integrations.md 2.3). Written against the 2.1.282
// frames in hub/test/fixtures/screens/2.1.282/.

/**
 * @typedef {{ key: string | null, label: string }} PromptOption
 * @typedef {{ kind: 'permission' | 'question' | 'trust', question: string, options: PromptOption[] }} Prompt
 */

/** Top edge of a prompt box (and of the input box): a full row of `─`. */
const BOX_TOP = /^─{10,}$/
/** A numbered option: optional `❯` cursor, the digit as printed, the label. */
const NUMBERED = /^\s*(❯\s*)?(\d+)\.\s+(\S.*?)\s*$/
/** The selected row of an unnumbered option list (the trust dialog). */
const SELECTED = /^(\s*❯\s+)(\S.*?)\s*$/
/** Every complete 2.1.282 prompt box ends with a hint row naming Esc. */
const FOOTER = /Esc to cancel/
/** A row that separates paragraphs inside a box. */
const SEPARATOR = /^[─╌]+$/
/** The tab header of an AskUserQuestion box. */
const QUESTION_TAB = /[☐☒]/

/**
 * Find the prompt box on screen. Returns `null` when there is none, or when
 * its footer is not visible (a box cut off at the bottom is never returned
 * as a partial option list).
 * @param {string[]} lines rendered rows, trailing blanks trimmed
 * @returns {Prompt | null}
 */
export function parsePrompt (lines) {
  for (let top = lines.length - 1; top >= 0; top--) {
    if (!BOX_TOP.test(lines[top])) continue
    const prompt = parseBox(lines, top)
    if (prompt) return prompt
  }
  return null
}

/**
 * @param {string[]} lines
 * @param {number} top row of the box's top edge
 * @returns {Prompt | null}
 */
function parseBox (lines, top) {
  const found = numberedOptions(lines, top) ?? unnumberedOptions(lines, top)
  if (!found) return null
  const { rows, options } = found
  const last = rows[rows.length - 1]
  if (!lines.slice(last + 1).some((l) => FOOTER.test(l))) return null
  const first = rows[0]
  return { kind: kindOf(lines, top, first, options), question: question(lines, top, first), options }
}

/**
 * The last run of rows numbered 1, 2, ... n below `top`, one of them carrying
 * the `❯` cursor. Rows between options (descriptions, rules) are skipped.
 * @param {string[]} lines
 * @param {number} top
 * @returns {{ rows: number[], options: PromptOption[] } | null}
 */
function numberedOptions (lines, top) {
  /** @type {{ row: number, n: number, selected: boolean, label: string }[]} */
  let run = []
  for (let r = top + 1; r < lines.length; r++) {
    const m = NUMBERED.exec(lines[r])
    if (!m) continue
    const opt = { row: r, n: Number(m[2]), selected: Boolean(m[1]), label: m[3] }
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
 * Options without digits (the trust dialog): the `❯` row and the rows around
 * it whose text starts at the same column. `key` is `null`: none is printed.
 * @param {string[]} lines
 * @param {number} top
 * @returns {{ rows: number[], options: PromptOption[] } | null}
 */
function unnumberedOptions (lines, top) {
  let sel = -1
  for (let r = top + 1; r < lines.length; r++) {
    if (SELECTED.test(lines[r])) { sel = r; break }
  }
  if (sel === -1) return null
  const col = /** @type {RegExpExecArray} */ (SELECTED.exec(lines[sel]))[1].length
  /** @param {string} l */
  const sibling = (l) => l.trim() !== '' && l.search(/\S/) === col
  let first = sel
  while (first - 1 > top && sibling(lines[first - 1])) first--
  let last = sel
  while (last + 1 < lines.length && sibling(lines[last + 1])) last++
  const rows = []
  const options = []
  for (let r = first; r <= last; r++) {
    rows.push(r)
    options.push({ key: null, label: r === sel ? /** @type {RegExpExecArray} */ (SELECTED.exec(lines[r]))[2] : lines[r].trim() })
  }
  return { rows, options }
}

/**
 * The nearest paragraph above the options that asks something (holds a `?`),
 * else the nearest paragraph. Wrapped rows are joined with one space.
 * @param {string[]} lines
 * @param {number} top
 * @param {number} first row of the first option
 * @returns {string}
 */
function question (lines, top, first) {
  /** @type {string[]} */
  const paragraphs = []
  /** @type {string[]} */
  let cur = []
  const flush = () => {
    if (cur.length > 0) paragraphs.push(cur.reverse().join(' '))
    cur = []
  }
  for (let r = first - 1; r > top; r--) {
    const l = lines[r].trim()
    if (l === '' || SEPARATOR.test(l)) flush()
    else cur.push(l)
  }
  flush()
  return paragraphs.find((p) => p.includes('?')) ?? paragraphs[0] ?? ''
}

/**
 * @param {string[]} lines
 * @param {number} top
 * @param {number} first
 * @param {PromptOption[]} options
 * @returns {Prompt['kind']}
 */
function kindOf (lines, top, first, options) {
  if (options.some((o) => /^Yes, I trust/.test(o.label))) return 'trust'
  if (lines.slice(top + 1, first).some((l) => QUESTION_TAB.test(l))) return 'question'
  return 'permission'
}
