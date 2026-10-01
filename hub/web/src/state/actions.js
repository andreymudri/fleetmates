/**
 * REST helpers for the M2 session, crew and run actions (docs/deck/05-api.md sections 2.3, 2.6 and 2.8).
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
