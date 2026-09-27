// The bottom status region of a Claude Code screen: the spinner line, the
// token counter and the input box. Changes there are not activity
// (docs/deck/interaction/state-machines.md 1.10).

/** An active spinner row: a spinner glyph, a verb, and the `…` of work in progress. */
const SPINNER = /^[·✢✳✶✻✽*] \S.*…/
/** A full-width horizontal rule (the input box edges). */
const RULE = /^─{10,}$/
/** Right-aligned status text (the effort indicator above the input box). */
const RIGHT_ALIGNED = /^ {20,}\S/

/**
 * Row of the input box: the cursor row when it starts with `❯`, else -1.
 * @param {string[]} lines
 * @param {{ x: number, y: number }} cursor
 * @returns {number}
 */
export function inputRow (lines, cursor) {
  const y = cursor?.y ?? -1
  return y >= 0 && /^❯/.test(lines[y] ?? '') ? y : -1
}

/**
 * Row of the active spinner above `before`, or -1.
 * @param {string[]} lines
 * @param {number} before
 * @returns {number}
 */
export function spinnerRow (lines, before) {
  for (let r = Math.min(before, lines.length) - 1; r >= 0; r--) {
    if (SPINNER.test(lines[r])) return r
  }
  return -1
}

/**
 * Indices of the rows in the status region: from the active spinner (or,
 * without one, from the input box's top edge and any right-aligned status
 * row directly above it) to the last row. Empty while a prompt box replaces
 * the input box.
 * @param {string[]} lines
 * @param {{ x: number, y: number }} cursor
 * @param {boolean} promptVisible
 * @returns {number[]}
 */
export function statusRows (lines, cursor, promptVisible) {
  if (promptVisible) return []
  const input = inputRow(lines, cursor)
  const spinner = spinnerRow(lines, input === -1 ? lines.length : input)
  let start = spinner
  if (start === -1 && input !== -1) {
    start = input > 0 && RULE.test(lines[input - 1]) ? input - 1 : input
    while (start > 0 && RIGHT_ALIGNED.test(lines[start - 1])) start--
  }
  if (start === -1) return []
  const out = []
  for (let r = start; r < lines.length; r++) out.push(r)
  return out
}
