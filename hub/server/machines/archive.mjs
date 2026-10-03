// Session archive (docs/plans/2026-10-02-deck-archive.md, Definitions):
// - Archived: `sessions.archived_at` is not null. `archived_by` is `'owner'` or `'auto'`.
// - Unreviewed changes: `json_array_length(sessions.changed_files) > 0`.
// - Finished: `sessions.alive = 0` and no open request for the session.
// - Auto-archive candidate: finished, not archived, no unreviewed changes, and
//   `coalesce(ended_at, state_since) <= now - autoArchiveAfter hours`. `autoArchiveAfter` null means never.
// - Needs the owner: the session has at least one row in `requests` with `state = 'open'`.
// Every function is synchronous over the store and meant to run inside a projector `commit`.

const HOUR = 3_600_000
const NEEDS_OWNER = "EXISTS (SELECT 1 FROM requests r WHERE r.session_id = sessions.id AND r.state = 'open')"
const FINISHED_UNARCHIVED_REVIEWED = `alive = 0 AND NOT ${NEEDS_OWNER} AND archived_at IS NULL AND json_array_length(changed_files) = 0`

/**
 * Archive one session.
 * @param {object} store deck store
 * @param {string} id session id
 * @param {{ by: 'owner'|'auto', at: number }} options who archived it and when (ms)
 * @returns {{ ok: true, changed: boolean } | { ok: false, code: 'not_found'|'needs_you' }}
 */
export function archiveSession(store, id, { by, at }) {
  const row = store.get(`SELECT archived_at, ${NEEDS_OWNER} AS needs FROM sessions WHERE id = ?`, id)
  if (!row) return { ok: false, code: 'not_found' }
  if (row.needs) return { ok: false, code: 'needs_you' }
  if (row.archived_at !== null) return { ok: true, changed: false }
  store.run('UPDATE sessions SET archived_at = ?, archived_by = ? WHERE id = ?', at, by, id)
  return { ok: true, changed: true }
}

/**
 * Clear the archive of one session.
 * @param {object} store deck store
 * @param {string} id session id
 * @returns {{ ok: true, changed: boolean }}
 */
export function unarchiveSession(store, id) {
  const result = store.run('UPDATE sessions SET archived_at = NULL, archived_by = NULL WHERE id = ? AND archived_at IS NOT NULL', id)
  return { ok: true, changed: Number(result.changes) > 0 }
}

/**
 * Archive, by the owner, every session that is finished, not archived and has no unreviewed changes.
 * @param {object} store deck store
 * @param {{ at: number }} options archive time (ms)
 * @returns {string[]} the archived ids
 */
export function archiveFinished(store, { at }) {
  const ids = store.all(`SELECT id FROM sessions WHERE ${FINISHED_UNARCHIVED_REVIEWED} ORDER BY id`).map(row => row.id)
  for (const id of ids) store.run("UPDATE sessions SET archived_at = ?, archived_by = 'owner' WHERE id = ?", at, id)
  return ids
}

/**
 * The auto-archive candidates at `at` for a delay of `afterHours`; none when `afterHours` is null.
 * @param {object} store deck store
 * @param {{ at: number, afterHours: number|null }} options
 * @returns {string[]} session ids
 */
export function autoArchiveCandidates(store, { at, afterHours }) {
  if (afterHours === null || afterHours === undefined) return []
  return store.all(`SELECT id FROM sessions WHERE ${FINISHED_UNARCHIVED_REVIEWED} AND coalesce(ended_at, state_since) <= ? ORDER BY id`, at - afterHours * HOUR).map(row => row.id)
}

/**
 * Clear the archive of every archived session that needs the owner.
 * @param {object} store deck store
 * @returns {string[]} the unarchived ids
 */
export function unarchiveNeedingOwner(store) {
  const ids = store.all(`SELECT id FROM sessions WHERE archived_at IS NOT NULL AND ${NEEDS_OWNER} ORDER BY id`).map(row => row.id)
  for (const id of ids) store.run('UPDATE sessions SET archived_at = NULL, archived_by = NULL WHERE id = ?', id)
  return ids
}
