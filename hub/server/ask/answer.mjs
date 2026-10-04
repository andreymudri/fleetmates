// The Ask answer contract (D-131, D-141; 10-memory 2.3): the model ends its answer with one fenced block tagged
// `deck-answer`; the deck strips it from the shown text, checks its types and keeps only the citations it can
// validate against this ask's tool results or the deck's own vault listing. Pure functions: nothing here reads
// the vault, the line bound comes from a `vault_get_note` result the caller fetched through vault-mcp.

/** Pages past this many characters are not fetched; any line of such a note counts as in range (D-141). */
export const MAX_BOUND_CHARS = 200_000

/** vault-mcp prints at most this many frontmatter keys and this many characters per value (contract 1.6). */
const MAX_FRONTMATTER_KEYS = 32
const MAX_FRONTMATTER_VALUE = 512

/**
 * @typedef {{ path: string, line: number, viaGraph: boolean }} Citation
 * @typedef {{ citations: Citation[], isMiss: boolean, generalKnowledge: string|null, searched: string[] }} AnswerBlock
 */

/** An opening fence line tagged `deck-answer`, at the start of a line. */
const OPEN_RE = /^```deck-answer[ \t]*$/gm
/** A closing fence line. */
const CLOSE_RE = /^```[ \t]*$/m

/**
 * Check the parsed block's types. Unknown keys are ignored; a missing `generalKnowledge` reads null, a missing
 * `searched` reads [], a missing `viaGraph` reads false; `citations` and `isMiss` are required.
 * @param {unknown} raw
 * @returns {AnswerBlock | null}
 */
function checkBlock (raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const b = /** @type {Record<string, unknown>} */ (raw)
  if (!Array.isArray(b.citations) || typeof b.isMiss !== 'boolean') return null
  const gk = b.generalKnowledge === undefined ? null : b.generalKnowledge
  if (gk !== null && typeof gk !== 'string') return null
  const searched = b.searched === undefined ? [] : b.searched
  if (!Array.isArray(searched) || !searched.every(s => typeof s === 'string')) return null
  /** @type {Citation[]} */
  const citations = []
  for (const c of b.citations) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null
    const { path, line, viaGraph = false } = /** @type {Record<string, unknown>} */ (c)
    if (typeof path !== 'string' || !path || typeof line !== 'number' || typeof viaGraph !== 'boolean') return null
    citations.push({ path, line, viaGraph })
  }
  return { citations, isMiss: b.isMiss, generalKnowledge: gk, searched: [...searched] }
}

/**
 * Split an answer into the text to show and its `deck-answer` block. The last fenced block tagged
 * `deck-answer` and everything after it are stripped from `text`; a block that does not parse or has a wrong
 * type gives `block: null` (the answer is then shown as "Citations unavailable for this answer").
 * Fences with any other tag, `json` included, are left in the text.
 * @param {string} text the full answer as the model wrote it
 * @returns {{ text: string, block: AnswerBlock | null }}
 */
export function parseAnswer (text) {
  let open = -1
  let openEnd = -1
  for (const m of text.matchAll(OPEN_RE)) {
    open = m.index
    openEnd = m.index + m[0].length
  }
  if (open < 0) return { text, block: null }
  const shown = text.slice(0, open).trimEnd()
  const rest = text.slice(openEnd)
  const close = CLOSE_RE.exec(rest)
  if (!close) return { text: shown, block: null }
  let raw
  try {
    raw = JSON.parse(rest.slice(0, close.index))
  } catch {
    return { text: shown, block: null }
  }
  return { text: shown, block: checkBlock(raw) }
}

/**
 * Keep a citation when its path was returned by one of this ask's tool results or is in the deck's latest
 * `vault_list`/`vault_graph` answer, and `lineBound(path)` gives `n` with `1 <= line <= n` (an integer line),
 * or `Infinity` (D-141). A bound that throws or is not a number drops the citation.
 * @param {Citation[]} citations
 * @param {{
 *   toolPaths: Iterable<string>,
 *   knownPaths: Iterable<string>,
 *   lineBound: (path: string) => number | Promise<number>
 * }} opts
 * @returns {Promise<{ kept: Citation[], dropped: Citation[] }>}
 */
export async function validateCitations (citations, { toolPaths, knownPaths, lineBound }) {
  const paths = new Set([...toolPaths, ...knownPaths])
  /** @type {Map<string, Promise<number|null>>} */
  const bounds = new Map()
  const boundOf = (/** @type {string} */ p) => {
    let b = bounds.get(p)
    if (!b) {
      b = Promise.resolve().then(() => lineBound(p)).then(n => (typeof n === 'number' && !Number.isNaN(n) ? n : null), () => null)
      bounds.set(p, b)
    }
    return b
  }
  /** @type {Citation[]} */
  const kept = []
  /** @type {Citation[]} */
  const dropped = []
  for (const c of citations) {
    let ok = paths.has(c.path) && Number.isInteger(c.line) && c.line >= 1
    if (ok) {
      const n = await boundOf(c.path)
      ok = n !== null && c.line <= n
    }
    ;(ok ? kept : dropped).push(c)
  }
  return { kept, dropped }
}

/**
 * Lines a frontmatter value takes beyond its key line: one per list item. An array counts its items; a
 * string holding commas counts its comma-separated parts (how a list may come back as text), which can only
 * over-count; an escaped `\n` (vault-mcp prints a newline as the two characters) adds one line each.
 * @param {unknown} value
 * @returns {number}
 */
function extraLines (value) {
  if (Array.isArray(value)) return value.length
  if (typeof value !== 'string') return 0
  const s = value.trim().replace(/^\[(.*)\]$/s, '$1')
  const items = s.includes(',') ? s.split(',').length : 0
  const breaks = value.split('\\n').length - 1
  return items + breaks
}

/**
 * The D-141 line bound of a note from a vault-text `parseNote` result: body lines, plus 2 for the
 * frontmatter fences, plus one line per frontmatter key and one per list item. It is an upper bound and
 * never smaller than the file's line count for the frontmatter shapes counted here. A note cut short
 * (`truncated`), longer than 200,000 characters, or with a frontmatter vault-mcp may have elided (32 keys,
 * a 512-character value) gives `Infinity`.
 * @param {{ frontmatter?: Record<string, unknown> | [string, unknown][] | null, body?: string, truncated?: boolean, total?: number }} note
 * @returns {number}
 */
export function noteLineBound (note) {
  if (!note || note.truncated) return Infinity
  if (typeof note.total === 'number' && note.total > MAX_BOUND_CHARS) return Infinity
  const fm = note.frontmatter
  const entries = !fm ? [] : Array.isArray(fm) ? fm : Object.entries(fm)
  if (entries.length >= MAX_FRONTMATTER_KEYS) return Infinity
  let lines = String(note.body ?? '').split('\n').length + 2
  for (const [, value] of entries) {
    if (typeof value === 'string' && value.length >= MAX_FRONTMATTER_VALUE) return Infinity
    lines += 1 + extraLines(value)
  }
  return lines
}
