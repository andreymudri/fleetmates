// Screen parsers for the web server (docs/deck/05-api.md 5.4): turn deckd's
// `screen` rows into prompt, idle and status-region facts.
import { isIdle } from './idle.mjs'
import { parsePrompt } from './prompt.mjs'
import { statusRows } from './status-region.mjs'

/**
 * @typedef {import('./prompt.mjs').Prompt} Prompt
 * @typedef {{ prompt: Prompt | null, idle: boolean, statusRows: number[] }} ParsedScreen
 */

/**
 * Parse one rendered screen.
 * @param {string[]} lines visible rows as plain text (ScreenModel#lines)
 * @param {{ x: number, y: number }} cursor cursor inside the visible screen
 * @returns {ParsedScreen}
 */
export function parseScreen (lines, cursor) {
  const prompt = parsePrompt(lines)
  return {
    prompt,
    idle: prompt === null && isIdle(lines, cursor),
    statusRows: statusRows(lines, cursor, prompt !== null)
  }
}
