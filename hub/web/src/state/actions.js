/**
 * REST helpers for the M2 session, crew and run actions and the M3 answer, rule and diff calls
 * (docs/deck/05-api.md sections 2.3, 2.4, 2.5, 2.6 and 2.8).
 * Each takes the client from `createApiClient`, encodes every path segment with `encodeURIComponent`,
 * and returns the API's body or throws its `ApiError` unchanged.
 */

const seg = value => encodeURIComponent(String(value))
const session = (id, action) => `/api/sessions/${seg(id)}/${action}`

/**
 * Launch a session (`POST /api/sessions`).
 * @param {{ post: Function }} api
 * @param {{ repoKey?: string, task: string, mode?: 'plain' | 'fleetmates' }} body
 * @returns {Promise<{ session: object, warning?: { kind: 'repo_busy', sessionIds: string[] } }>}
 */
export function launchSession(api, body) {
  return api.post('/api/sessions', body)
}

/**
 * Stop a session: SIGTERM, then SIGKILL after 5 s.
 * @param {{ post: Function }} api
 * @param {string} id
 * @returns {Promise<{ session: object }>}
 */
export function stopSession(api, id) {
  return api.post(session(id, 'stop'))
}

/**
 * Send Enter to a stale or idle session.
 * @param {{ post: Function }} api
 * @param {string} id
 * @returns {Promise<{ session: object }>}
 */
export function nudgeSession(api, id) {
  return api.post(session(id, 'nudge'))
}

/**
 * Relaunch a crashed session in place.
 * @param {{ post: Function }} api
 * @param {string} id
 * @returns {Promise<{ session: object }>}
 */
export function relaunchSession(api, id) {
  return api.post(session(id, 'relaunch'))
}

/**
 * Read a session's scrollback; `lines` is left to the server default when omitted.
 * @param {{ get: Function }} api
 * @param {string} id
 * @param {number} [lines]
 * @returns {Promise<{ text: string, source: 'deckd' | 'stored', truncated: boolean }>}
 */
export function fetchScrollback(api, id, lines) {
  const query = lines === undefined ? '' : `?lines=${seg(lines)}`
  return api.get(`${session(id, 'scrollback')}${query}`)
}

/**
 * Change a repo's crew seed, slot or hat.
 * @param {{ patch: Function }} api
 * @param {string} repoKey
 * @param {{ seed?: string, slot?: number, hat?: 'none' | 'cap' | 'bandana' }} patch
 * @returns {Promise<{ repo: object }>}
 */
export function patchCrew(api, repoKey, patch) {
  return api.patch(`/api/repos/${seg(repoKey)}/crew`, patch)
}

/**
 * Read a run's plan markdown. A nested run id is one encoded segment.
 * @param {{ get: Function }} api
 * @param {string} repoKey
 * @param {string} runId
 * @returns {Promise<{ path: string, markdown: string, truncated: boolean }>}
 */
export function fetchRunPlan(api, repoKey, runId) {
  return api.get(`/api/runs/${seg(repoKey)}/${seg(runId)}/plan`)
}

/**
 * Ask the server to open a run's plan in the desktop's editor (`POST /api/open`, kind `runPlan`).
 * @param {{ post: Function }} api
 * @param {string} repoId
 * @param {string} runId
 * @returns {Promise<unknown>}
 */
export function openRunPlan(api, repoId, runId) {
  return api.post('/api/open', { kind: 'runPlan', ref: { repoId, runId } })
}

/**
 * Answer one request (`POST /api/requests/:id/answer`). The server enforces the tier rules.
 * @param {{ post: Function }} api
 * @param {string} id
 * @param {{ choice: 'allow' | 'allow_always' | 'deny' | 'option' | 'reply', optionKey?: string, text?: string, confirm?: boolean }} body
 * @returns {Promise<{ request: object }>}
 */
export function answerRequest(api, id, body) {
  return api.post(`/api/requests/${seg(id)}/answer`, body)
}

/**
 * Allow several Safe permission requests once (`POST /api/requests/answer-batch`).
 * @param {{ post: Function }} api
 * @param {string[]} ids
 * @returns {Promise<{ results: { id: string, ok: boolean, error?: object }[] }>}
 */
export function answerBatch(api, ids) {
  return api.post('/api/requests/answer-batch', { ids, choice: 'allow' })
}

/**
 * Tell Claude what to do instead after a deck Deny (`POST /api/requests/:id/followup`).
 * @param {{ post: Function }} api
 * @param {string} id
 * @param {string} text
 * @returns {Promise<unknown>}
 */
export function sendFollowup(api, id, text) {
  return api.post(`/api/requests/${seg(id)}/followup`, { text })
}

/**
 * Read the approval rules, for every repo or for one.
 * @param {{ get: Function }} api
 * @param {string} [repoKey]
 * @returns {Promise<{ threshold: number | null, tiersError?: object | null, repos: object[] }>}
 */
export function fetchRules(api, repoKey) {
  const query = repoKey === undefined ? '' : `?repoKey=${seg(repoKey)}`
  return api.get(`/api/rules${query}`)
}

/**
 * Add an allow rule to a repo's settings file (`POST /api/rules`).
 * @param {{ post: Function }} api
 * @param {{ repoKey: string, pattern: string, source: 'suggested' | 'manual' }} rule
 * @returns {Promise<{ rule: object }>}
 */
export function addRule(api, { repoKey, pattern, source }) {
  return api.post('/api/rules', { repoKey, pattern, source })
}

/**
 * Revoke a rule (`DELETE /api/rules/:repoKey/:pattern`); the pattern is one encoded segment.
 * @param {{ del: Function }} api
 * @param {string} repoKey
 * @param {string} pattern
 * @returns {Promise<{ removed: boolean, reason?: 'already_removed' }>}
 */
export function revokeRule(api, repoKey, pattern) {
  return api.del(`/api/rules/${seg(repoKey)}/${seg(pattern)}`)
}

/**
 * Dismiss a rule suggestion (`POST /api/rules/suggestions/dismiss`).
 * @param {{ post: Function }} api
 * @param {{ repoKey: string, pattern: string }} offer
 * @returns {Promise<unknown>}
 */
export function dismissRuleOffer(api, { repoKey, pattern }) {
  return api.post('/api/rules/suggestions/dismiss', { repoKey, pattern })
}

/**
 * Read one changed file's diff against the review baseline (`GET /api/sessions/:id/diff?path=`).
 * @param {{ get: Function }} api
 * @param {string} sessionId
 * @param {string} path repo-relative
 * @returns {Promise<{ path: string, baseline: string, diff: string, binary: boolean, truncated: boolean }>}
 */
export function fetchDiff(api, sessionId, path) {
  return api.get(`${session(sessionId, 'diff')}?path=${seg(path)}`)
}
