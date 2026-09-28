// The empty input box: the session is waiting for a prompt
// (docs/deck/04-integrations.md 2.3).
import { inputRow, spinnerRow } from './status-region.mjs'

/**
 * True when the input box under the cursor is empty and no spinner runs.
 * @param {string[]} lines
 * @param {{ x: number, y: number }} cursor
 * @returns {boolean}
 */
export function isIdle (lines, cursor) {
  const input = inputRow(lines, cursor)
  if (input === -1) return false
  if (!/^❯\s*$/.test(lines[input])) return false
  return spinnerRow(lines, input) === -1
}
