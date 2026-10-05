const chipPriority = { crashed: 4, stale: 3, starting: 2, running: 2, done: 1 }

/** Read the Home, Rail and drawer counts from one database projection. */
export function projectCounts(store) {
  // Archived sessions (`archived_at` not null) and their requests count only in `archived`.
  const sessions = store.all('SELECT id, state, run_repo_id, run_id FROM sessions WHERE state <> ? AND archived_at IS NULL', 'ended')
  const requests = store.all('SELECT r.session_id, r.created_at FROM requests r JOIN sessions s ON s.id = r.session_id WHERE r.state = ? AND s.archived_at IS NULL', 'open')
  const requestSessions = new Set(requests.map(row => row.session_id))
  const counts = { needYouSessions: 0, running: 0, toReview: 0, openRequests: requests.length, requestSessions: requestSessions.size, oldestRequestAt: requests.length ? Math.min(...requests.map(row => row.created_at)) : null, perRun: [], archived: store.get('SELECT count(*) AS n FROM sessions WHERE archived_at IS NOT NULL').n }
  const runs = new Map()
  const chips = new Map()
  for (const row of sessions) {
    const chipKey = row.run_id ? JSON.stringify([row.run_repo_id, row.run_id]) : row.id
    const priority = requestSessions.has(row.id) ? 5 : chipPriority[row.state] ?? 0
    chips.set(chipKey, Math.max(chips.get(chipKey) ?? 0, priority))
    if (!row.run_id) continue
    const key = JSON.stringify([row.run_repo_id, row.run_id])
    const run = runs.get(key) ?? { repoId: row.run_repo_id, runId: row.run_id, needYou: 0, total: 0 }
    run.total++
    if (requestSessions.has(row.id)) run.needYou++
    runs.set(key, run)
  }
  for (const priority of chips.values()) {
    if (priority === 5) counts.needYouSessions++
    else if (priority === 2) counts.running++
    else if (priority === 1) counts.toReview++
  }
  counts.perRun = [...runs.values()]
  return counts
}

const urgency = { needs_approval: 0, asked_you: 1, crashed: 2, starting: 3, running: 3, done: 4, stale: 5, idle: 6, reviewed: 7, ended: 8 }

/** Derive grid, quiet row and Rail order from persisted session states; archived sessions are left out. */
export function projectHome(allSessions, requests = []) {
  const sessions = allSessions.filter(row => row.archivedAt == null)
  const oldestRequest = new Map()
  for (const request of requests) {
    if (request.state !== 'open') continue
    oldestRequest.set(request.sessionId, Math.min(oldestRequest.get(request.sessionId) ?? Infinity, request.createdAt))
  }
  const ordered = [...sessions].sort((a, b) => {
    const rank = urgency[a.state] - urgency[b.state]
    if (rank) return rank
    const age = ['needs_approval', 'asked_you'].includes(a.state)
      ? (oldestRequest.get(a.id) ?? Infinity) - (oldestRequest.get(b.id) ?? Infinity)
      : b.stateSince - a.stateSince
    return age || a.id.localeCompare(b.id)
  })
  const quiet = ordered.filter(row => ['stale', 'idle', 'reviewed'].includes(row.state))
  return { order: ordered.filter(row => row.state !== 'ended').map(row => row.id), grid: ordered.filter(row => !['stale', 'idle', 'reviewed', 'ended'].includes(row.state)), quiet, rail: ordered.filter(row => row.state !== 'ended') }
}
