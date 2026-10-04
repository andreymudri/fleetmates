// Writes to open `requests` rows that come from the screen, a tiers change or the confirm counter,
// each followed by a `request.updated` event (docs/deck/05-api.md section 4). Task 16 wires these to
// the deckd link and the tiers store.
import { requestView } from '../machines/projector.mjs'
import { parseCommand } from './shell.mjs'
import { activeTiers } from './tiers.mjs'
import { matchPrompt } from './screen-match.mjs'

/** The Destructive confirm label when the count or the template is missing (D-72). */
export const FALLBACK_CONFIRM_LABEL = 'I checked what this command will change'

const TIER_RANK = { safe: 0, caution: 1, destructive: 2 }
/** @param {string | null | undefined} tier */
const rank = (tier) => TIER_RANK[/** @type {keyof typeof TIER_RANK} */ (tier)] ?? -1

/**
 * @typedef {{ run: Function, get: Function, all: Function, appendEvent: Function, tx: Function }} Store
 */

/** @param {Store} store @param {string} sessionId */
const openRequests = (store, sessionId) => store.all("SELECT * FROM requests WHERE session_id = ? AND state = 'open' ORDER BY created_at, id", sessionId)

/**
 * Record which open request of a session the screen shows (state-machines 2.3 `screenMatch`): the
 * matched request becomes `on_screen` and keeps the prompt's options, the others become `queued`
 * while a prompt is on screen, and every one is `unknown` when `prompt` is null or undefined (no
 * prompt readable, or no screen model). One transaction; one `request.updated` per changed row.
 * @param {Store} store
 * @param {string} sessionId
 * @param {import('../screen/prompt.mjs').Prompt | null | undefined} prompt
 * @param {number} at event time
 * @returns {string[]} ids of the rows that changed
 */
export function applyScreen (store, sessionId, prompt, at) {
  return store.tx(() => {
    const rows = openRequests(store, sessionId)
    const cwd = store.get('SELECT cwd FROM sessions WHERE id = ?', sessionId)?.cwd ?? null
    const { onScreen, queued } = matchPrompt(prompt, rows, { cwd })
    const changed = []
    for (const row of rows) {
      const screenMatch = row.id === onScreen ? 'on_screen' : queued.includes(row.id) ? 'queued' : 'unknown'
      const options = row.id === onScreen && prompt ? JSON.stringify(prompt.options.map(({ key, label }) => ({ key, label }))) : row.options
      if (screenMatch === row.screen_match && options === row.options) continue
      store.run('UPDATE requests SET screen_match = ?, options = ? WHERE id = ?', screenMatch, options, row.id)
      store.appendEvent({ at, type: 'request.updated', entityId: row.id, data: requestView(store.get('SELECT * FROM requests WHERE id = ?', row.id)) })
      changed.push(row.id)
    }
    return changed
  })
}

/**
 * Recompute the open permission requests after a tiers change and write a tier only when it is
 * higher than the stored one (07-approvals 3.2 step 6). A raised request takes the new reasons and
 * rule candidate (null unless Safe, so a raised request never keeps a Safe rule).
 * @param {Store} store
 * @param {(row: object) => { tier: string, reasons: object[], ruleCandidate?: string | null }} classifyFn
 * @param {number} at event time
 * @returns {string[]} ids of the rows raised
 */
export function raiseTiers (store, classifyFn, at) {
  return store.tx(() => {
    const changed = []
    for (const row of store.all("SELECT * FROM requests WHERE state = 'open' AND kind = 'permission' ORDER BY created_at, id")) {
      const next = classifyFn(row)
      if (!next || rank(next.tier) <= rank(row.tier)) continue
      store.run('UPDATE requests SET tier = ?, reasons = ?, rule_pattern = ? WHERE id = ?', next.tier, JSON.stringify(next.reasons ?? []), next.tier === 'safe' ? next.ruleCandidate ?? null : null, row.id)
      store.appendEvent({ at, type: 'request.updated', entityId: row.id, data: requestView(store.get('SELECT * FROM requests WHERE id = ?', row.id)) })
      changed.push(row.id)
    }
    return changed
  })
}

/**
 * Fill the Destructive confirm label of a request (07-approvals 8, D-72): when exactly one of its
 * reasons is a Destructive tiers entry, that entry's `confirm` template, with `{n}` replaced by the
 * count `countFor` gives for the shell segment the entry matched, taken in that segment's directory.
 * When two or more reasons are Destructive entries (with or without a template), the template is
 * missing, the segment's directory is unknown (after `cd sub`), the count is not a whole number, or
 * `countFor` throws, the label is FALLBACK_CONFIRM_LABEL. Writes `confirm_label`
 * and appends `request.updated`. Resolves null for a request that is missing or not Destructive.
 * @param {Store} store
 * @param {string} requestId
 * @param {{ countFor: (kind: string, argv: string[], root: string) => Promise<number | null>, tiers?: { entries: object[] }, at?: number }} deps
 * @returns {Promise<string | null>}
 */
export async function fillConfirmLabel (store, requestId, { countFor, tiers = activeTiers(), at = Date.now() }) {
  const row = store.get('SELECT * FROM requests WHERE id = ?', requestId)
  if (!row || row.tier !== 'destructive') return null
  const session = store.get('SELECT cwd, repo_id FROM sessions WHERE id = ?', row.session_id)
  const label = await confirmLabel(row, session?.cwd ?? session?.repo_id ?? null, { countFor, tiers })
  store.tx(() => {
    store.run('UPDATE requests SET confirm_label = ? WHERE id = ?', label, requestId)
    store.appendEvent({ at, type: 'request.updated', entityId: requestId, data: requestView(store.get('SELECT * FROM requests WHERE id = ?', requestId)) })
  })
  return label
}

/**
 * @param {any} row
 * @param {string | null} cwd
 * @param {{ countFor: Function, tiers: { entries: object[] } }} deps
 * @returns {Promise<string>}
 */
async function confirmLabel (row, cwd, { countFor, tiers }) {
  /** @type {{ entryId: string, segment: string }[]} */
  let reasons
  try { reasons = JSON.parse(row.reasons) } catch { reasons = [] }
  const entries = new Map((tiers?.entries ?? []).map((/** @type {any} */ entry) => [entry.id, entry]))
  const destructive = (Array.isArray(reasons) ? reasons : []).map((reason) => ({ reason, entry: entries.get(reason?.entryId) }))
    .filter(({ entry }) => entry?.tier === 'destructive')
  // One label cannot speak for two Destructive segments (`rm a && rm b c d`, `rm a; git push --force`).
  if (destructive.length !== 1) return FALLBACK_CONFIRM_LABEL
  const [hit] = destructive
  if (typeof hit.entry.confirm !== 'string') return FALLBACK_CONFIRM_LABEL
  const template = hit.entry.confirm
  if (!template.includes('{n}')) return template
  if (typeof hit.entry.count !== 'string' || typeof cwd !== 'string') return FALLBACK_CONFIRM_LABEL
  let command
  try { command = JSON.parse(row.detail)?.command } catch { return FALLBACK_CONFIRM_LABEL }
  const parsed = parseCommand(command, { cwd })
  const segment = parsed.ok ? parsed.segments.find((/** @type {any} */ s) => s.words.join(' ') === hit.reason.segment) : null
  if (!segment) return FALLBACK_CONFIRM_LABEL
  let count
  // The parser sets a segment's `cwd` to null when it cannot tell where it runs (after `cd sub`), so
  // the count is never taken at the session directory instead.
  if (typeof segment.cwd !== 'string' || !segment.cwd) return FALLBACK_CONFIRM_LABEL
  try { count = await countFor(hit.entry.count, segment.words, segment.cwd) } catch { return FALLBACK_CONFIRM_LABEL }
  return Number.isInteger(count) && count >= 0 ? template.replace('{n}', String(count)) : FALLBACK_CONFIRM_LABEL
}
