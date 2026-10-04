/**
 * REST helpers for the M2 session, crew and run actions, the M3 answer, rule and diff calls and the M4
 * meeting calls (docs/deck/05-api.md sections 2.3, 2.4, 2.5, 2.6, 2.8, 2.9 and 2.11).
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
 * Revoke a rule (`DELETE /api/rules/:repoKey/:pattern`); the pattern is one encoded segment. With
 * `{ undo: true }` (the Undo of the rule-added toast) the call adds `?undo=1`, so the server records the
 * removal as an `undo` rather than a `revoke`.
 * @param {{ del: Function }} api
 * @param {string} repoKey
 * @param {string} pattern
 * @param {{ undo?: boolean }} [options]
 * @returns {Promise<{ removed: boolean, reason?: 'already_removed' }>}
 */
export function revokeRule(api, repoKey, pattern, { undo = false } = {}) {
  return api.del(`/api/rules/${seg(repoKey)}/${seg(pattern)}${undo === true ? '?undo=1' : ''}`)
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

/**
 * Archive a session (`POST /api/sessions/:id/archive`); the server refuses one that needs the owner
 * with a 409 `needs_you` `ApiError`.
 * @param {{ post: Function }} api
 * @param {string} id
 * @returns {Promise<{ session: object }>}
 */
export function archiveSession(api, id) {
  return api.post(session(id, 'archive'))
}

/**
 * Unarchive a session (`POST /api/sessions/:id/unarchive`).
 * @param {{ post: Function }} api
 * @param {string} id
 * @returns {Promise<{ session: object }>}
 */
export function unarchiveSession(api, id) {
  return api.post(session(id, 'unarchive'))
}

/**
 * Archive every finished session without unreviewed changes (`POST /api/sessions/archive-finished`).
 * @param {{ post: Function }} api
 * @returns {Promise<{ ids: string[] }>}
 */
export function archiveFinished(api) {
  return api.post('/api/sessions/archive-finished')
}

/**
 * Read a page of archived sessions (`GET /api/sessions?archived=1`), newest archive first.
 * @param {{ get: Function }} api
 * @param {{ before?: string, limit?: number }} [page]
 * @returns {Promise<unknown>}
 */
export function fetchArchived(api, { before, limit } = {}) {
  const query = new URLSearchParams({ archived: '1' })
  if (before !== undefined) query.set('before', String(before))
  if (limit !== undefined) query.set('limit', String(limit))
  return api.get(`/api/sessions?${query}`)
}

// M4 meetings (05-api 2.11, the meeting scope of 2.9, and the scribed dependency routes).
const meeting = (id, rest = '') => `/api/meetings/${seg(id)}${rest}`

/**
 * Read a page of meetings with the recorder, the config tags and any config error (`GET /api/meetings`).
 * @param {{ get: Function }} api
 * @param {{ before?: string | number, limit?: number }} [page]
 * @returns {Promise<{ meetings: object[], recorder: object, tags: object[], configError?: object | null }>}
 */
export function fetchMeetings(api, { before, limit } = {}) {
  const query = new URLSearchParams()
  if (before !== undefined) query.set('before', String(before))
  if (limit !== undefined) query.set('limit', String(limit))
  const text = query.toString()
  return api.get(`/api/meetings${text ? `?${text}` : ''}`)
}

/**
 * Read one meeting with its note, pins, speakers and model (`GET /api/meetings/:id`).
 * @param {{ get: Function }} api
 * @param {string} id
 * @returns {Promise<{ meeting: object, note: object | null, pins: object[], speakers?: number, model?: string | null }>}
 */
export function fetchMeeting(api, id) {
  return api.get(meeting(id))
}

/**
 * Read a meeting's transcript (`GET /api/meetings/:id/transcript`).
 * @param {{ get: Function }} api
 * @param {string} id
 * @returns {Promise<{ source: 'batch' | 'live', lines: { t0: number, t1: number, speaker: string, text: string }[] }>}
 */
export function fetchMeetingTranscript(api, id) {
  return api.get(meeting(id, '/transcript'))
}

/**
 * Read the tail of a meeting's `postmeet.log`; `lines` is left to the server default when omitted.
 * @param {{ get: Function }} api
 * @param {string} id
 * @param {number} [lines]
 * @returns {Promise<{ text: string }>}
 */
export function fetchMeetingLog(api, id, lines) {
  const query = lines === undefined ? '' : `?lines=${seg(lines)}`
  return api.get(meeting(id, `/log${query}`))
}

/**
 * Search the meeting transcripts (`GET /api/meetings/search?q=`).
 * @param {{ get: Function }} api
 * @param {string} q
 * @returns {Promise<{ hits: { meetingId: string, t0: number, speaker: string, snippet: string, ranges: [number, number][] }[], meetingCount: number, partial?: boolean }>}
 */
export function searchMeetings(api, q) {
  return api.get(`/api/meetings/search?q=${seg(q)}`)
}

/**
 * Start recording with a config tag (`POST /api/meetings/start`).
 * @param {{ post: Function }} api
 * @param {string} tag
 * @returns {Promise<{ recorder: object }>}
 */
export function startMeeting(api, tag) {
  return api.post('/api/meetings/start', { tag })
}

/**
 * Stop the current recording (`POST /api/meetings/stop`).
 * @param {{ post: Function }} api
 * @returns {Promise<{ recorder: object }>}
 */
export function stopMeeting(api) {
  return api.post('/api/meetings/stop')
}

/**
 * Pin a moment of the meeting being recorded (`POST /api/meetings/:id/pins`); without `t` the request has
 * no body and the server picks the moment.
 * @param {{ post: Function }} api
 * @param {string} id
 * @param {{ t?: number }} [moment]
 * @returns {Promise<{ pin: object }>}
 */
export function pinMoment(api, id, { t } = {}) {
  return t === undefined ? api.post(meeting(id, '/pins')) : api.post(meeting(id, '/pins'), { t })
}

/**
 * Remove a pin (`DELETE /api/meetings/:id/pins/:pinId`).
 * @param {{ del: Function }} api
 * @param {string} id
 * @param {string} pinId
 * @returns {Promise<unknown>}
 */
export function unpinMoment(api, id, pinId) {
  return api.del(meeting(id, `/pins/${seg(pinId)}`))
}

/**
 * Dismiss a meeting's action item (`POST /api/meetings/:id/items/:key/dismiss`); the key is one encoded segment.
 * @param {{ post: Function }} api
 * @param {string} id
 * @param {string} key
 * @returns {Promise<unknown>}
 */
export function dismissItem(api, id, key) {
  return api.post(meeting(id, `/items/${seg(key)}/dismiss`))
}

/**
 * Undo an action item dismissal (`DELETE /api/meetings/:id/items/:key/dismiss`).
 * @param {{ del: Function }} api
 * @param {string} id
 * @param {string} key
 * @returns {Promise<unknown>}
 */
export function undismissItem(api, id, key) {
  return api.del(meeting(id, `/items/${seg(key)}/dismiss`))
}

/**
 * Ask about a meeting (`POST /api/ask` with `{ text, scope: 'meeting:<id>' }`).
 * @param {{ post: Function }} api
 * @param {string} id
 * @param {string} text
 * @returns {Promise<{ thread: object, userMessage: object, assistantMessageId: string }>}
 */
export function askMeeting(api, id, text) {
  return api.post('/api/ask', { text, scope: `meeting:${id}` })
}

/**
 * Start scribed, the degraded card's "Start scribed" (`POST /api/deps/scribed/start`).
 * @param {{ post: Function }} api
 * @returns {Promise<unknown>}
 */
export function startScribed(api) {
  return api.post('/api/deps/scribed/start')
}

/**
 * Probe scribed now, the degraded card's "Retry" (`POST /api/deps/scribed/retry`).
 * @param {{ post: Function }} api
 * @returns {Promise<unknown>}
 */
export function retryScribed(api) {
  return api.post('/api/deps/scribed/retry')
}
