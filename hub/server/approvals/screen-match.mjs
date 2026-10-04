// Which open request the prompt on screen belongs to (docs/deck/interaction/state-machines.md 2.3
// `screenMatch`, tier review F12) and whether the deck may offer option 2 (D-77, D-95). Pure: the
// prompt comes from hub/server/screen/prompt.mjs, the requests are `requests` rows of one session.
import path from 'node:path'

/**
 * @typedef {import('../screen/prompt.mjs').Prompt} Prompt
 * @typedef {{ id: string, kind: string, tier?: string | null, tool_name?: string | null, toolName?: string | null, detail?: string | object, rule_pattern?: string | null, rulePattern?: string | null }} OpenRequest
 * @typedef {{ match: boolean, rows: number | null, prefixes: number[] }} Fit
 */

const TIER_RANK = { safe: 0, caution: 1, destructive: 2 }
/** Box titles the 2.1.285 frames print, per tool. A tool without a captured title matches nothing. */
const FILE_TITLES = Object.freeze({ Edit: 'Edit file', Write: 'Create file' })
/** Option 2 as the captured 2.1.285 WebFetch frame words it (D-95); any other wording gives false. */
const ALLOW_ALWAYS = /^Yes, and don't ask again for (.+)$/
const CUT = '…'

/** @param {OpenRequest} request */
function input (request) {
  const detail = request.detail
  if (typeof detail === 'string') {
    try { return JSON.parse(detail) ?? {} } catch { return {} }
  }
  return detail && typeof detail === 'object' ? detail : {}
}

/** @param {OpenRequest} request */
const toolOf = (request) => request.tool_name ?? request.toolName ?? null
/** @param {OpenRequest} request */
const rank = (request) => TIER_RANK[/** @type {keyof typeof TIER_RANK} */ (request.tier)] ?? -1

/**
 * The visible text equals `actual`, or, when the prompt is truncated and the visible text ends in
 * the cut marker, `actual` starts with what is shown before it.
 * @param {string} visible
 * @param {string} actual
 * @param {boolean} truncated
 */
function same (visible, actual, truncated) {
  if (visible === actual) return true
  return truncated && visible.endsWith(CUT) && actual.startsWith(visible.slice(0, -CUT.length))
}

/**
 * How a Bash command fits the first body paragraph of a "Bash command" box: the command rows,
 * then the description rows. The box wraps a long command over several rows and the row text does
 * not show whether a break fell on a space (prompt.mjs `content`), so at each row boundary one
 * whitespace character of the command may be skipped. `rows` is the number of rows the command
 * fills when it fits whole (or up to a cut row), and `prefixes` lists every row count after which
 * the rows shown so far are a strict prefix of the command.
 * @param {string[]} paragraph
 * @param {string} command
 * @param {string} description
 * @param {boolean} truncated
 * @returns {Fit}
 */
function fitBash (paragraph, command, description, truncated) {
  const text = command.trim()
  /** @type {number[]} */
  const prefixes = []
  const rest = (/** @type {number} */ k) => paragraph.slice(k).join(' ') === description
  let pos = 0
  for (let i = 0; i < paragraph.length && text; i++) {
    const shown = paragraph[i]
    if (truncated && shown.endsWith(CUT) && text.startsWith(shown.slice(0, -CUT.length), pos)) {
      prefixes.push(i + 1)
      return { match: rest(i + 1), rows: i + 1, prefixes }
    }
    if (!text.startsWith(shown, pos)) break
    pos += shown.length
    if (pos === text.length) return { match: rest(i + 1), rows: i + 1, prefixes }
    prefixes.push(i + 1)
    if (/\s/.test(text[pos])) pos++
  }
  return { match: false, rows: null, prefixes }
}

/**
 * @param {Prompt} prompt
 * @param {OpenRequest} request
 * @param {string | null} cwd
 * @returns {Fit}
 */
function fit (prompt, request, cwd) {
  const none = { match: false, rows: null, prefixes: [] }
  const tool = toolOf(request)
  const args = input(request)
  if (prompt.kind === 'question') {
    if (request.kind !== 'question' || tool !== 'AskUserQuestion') return none
    const asked = args.questions?.[0]?.question
    const flat = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim()
    return { ...none, match: typeof asked === 'string' && flat(asked) === flat(prompt.question) }
  }
  if (prompt.kind !== 'permission' || request.kind !== 'permission' || prompt.body === null || prompt.title === null) return none
  const body = prompt.body.split('\n')
  if (tool === 'Bash') {
    if (prompt.title !== 'Bash command' || typeof args.command !== 'string') return none
    const end = body.indexOf('')
    const paragraph = end === -1 ? body : body.slice(0, end)
    const description = typeof args.description === 'string' ? args.description.trim() : ''
    return fitBash(paragraph, args.command, description, prompt.truncated)
  }
  if (tool && Object.hasOwn(FILE_TITLES, tool)) {
    const file = args.file_path
    if (prompt.title !== FILE_TITLES[/** @type {keyof typeof FILE_TITLES} */ (tool)] || typeof file !== 'string' || !file) return none
    if (!prompt.question.endsWith(` ${path.basename(file)}?`)) return none
    const shown = body[0] ?? ''
    if (!shown) return { ...none, match: true }
    // The box prints the path relative to the session's directory (`notes.txt` for
    // /home/you/fixture-repo/notes.txt). Without that directory any whole-component suffix counts.
    const candidates = cwd
      ? [file, path.relative(cwd, file)]
      : file.split('/').map((_, i, parts) => parts.slice(i).join('/')).filter(Boolean)
    return { ...none, match: candidates.some((candidate) => same(shown, candidate, prompt.truncated)) }
  }
  if (tool === 'WebFetch') {
    if (prompt.title !== 'Fetch' || typeof args.url !== 'string') return none
    const shown = body.find((l) => l.startsWith('url: '))?.slice('url: '.length)
    const href = normalUrl(args.url)
    if (shown === undefined || href === null) return none
    return { ...none, match: same(normalUrl(shown) ?? shown, href, prompt.truncated) || same(shown, href, prompt.truncated) }
  }
  return none
}

/** @param {string} url */
function normalUrl (url) {
  try { return new URL(url).href } catch { return null }
}

/**
 * Which open request of one session the prompt on screen belongs to. A request matches when its kind
 * fits the prompt kind and title and its command, path or URL equals the visible text (or starts with
 * it, when the prompt is truncated); a question matches the same question text. `onScreen` is set
 * only when exactly one request matches and no open request with a higher tier matches the visible
 * prefix (F12): otherwise every match is queued and `ambiguous` is true. While a prompt is on screen,
 * every request that is not `onScreen` is `queued`. A null or undefined `prompt` (no readable prompt,
 * or no screen model) queues nothing, so callers mark every request `unknown`.
 * @param {Prompt | null | undefined} prompt
 * @param {OpenRequest[]} openRequests the session's open requests, oldest first
 * @param {{ cwd?: string | null }} [options] the session's directory, which file boxes print paths relative to
 * @returns {{ onScreen: string | null, queued: string[], ambiguous: boolean }}
 */
export function matchPrompt (prompt, openRequests, { cwd = null } = {}) {
  if (!prompt) return { onScreen: null, queued: [], ambiguous: false }
  const fits = openRequests.map((request) => ({ request, fit: fit(prompt, request, cwd) }))
  const matched = fits.filter((f) => f.fit.match)
  const ids = openRequests.map((r) => r.id)
  if (matched.length === 0) return { onScreen: null, queued: ids, ambiguous: false }
  const [only] = matched
  const blocked = matched.length > 1 || fits.some((f) => f.request !== only.request && rank(f.request) > rank(only.request) &&
    only.fit.rows !== null && f.fit.prefixes.includes(only.fit.rows))
  if (blocked) return { onScreen: null, queued: ids, ambiguous: true }
  return { onScreen: only.request.id, queued: ids.filter((id) => id !== only.request.id), ambiguous: false }
}

/**
 * One rule pattern in a comparable form under the 07-approvals 7.1 equivalence: a `Bash(...)`
 * wrapper is dropped and a trailing `:*` reads as ` *`.
 * @param {string} pattern
 */
function bashRule (pattern) {
  const inner = /^Bash\((.*)\)$/.exec(pattern.trim())?.[1] ?? pattern.trim()
  return inner.endsWith(':*') ? `${inner.slice(0, -2)} *` : inner
}

/**
 * Whether the deck may offer option 2 for this request (D-77, D-95): only a Bash permission request
 * whose tier is Safe, whose parsed option 2 label is exactly `Yes, and don't ask again for <pattern>`,
 * and whose `<pattern>` equals the request's rule candidate (`rule_pattern`) under the 7.1
 * equivalence. Never for file tools, WebFetch or questions.
 * @param {OpenRequest} request
 * @param {{ options?: { key: string | null, label: string }[] } | null | undefined} prompt
 * @returns {boolean}
 */
export function allowAlwaysFor (request, prompt) {
  if (request?.kind !== 'permission' || toolOf(request) !== 'Bash' || request.tier !== 'safe') return false
  const rule = request.rule_pattern ?? request.rulePattern
  if (typeof rule !== 'string' || !rule) return false
  const label = prompt?.options?.find((o) => o?.key === '2')?.label
  const pattern = typeof label === 'string' ? ALLOW_ALWAYS.exec(label)?.[1] : undefined
  return pattern !== undefined && bashRule(pattern) === bashRule(rule)
}
