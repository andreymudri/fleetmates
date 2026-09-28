/** Read the Home, Rail and drawer counts from one database projection. */
export function projectCounts(store) {
  const sessions = store.all('SELECT id, state, run_repo_id, run_id FROM sessions WHERE state <> ?', 'ended')
  const requests = store.all('SELECT session_id, created_at FROM requests WHERE state = ?', 'open')
  const requestSessions = new Set(requests.map(row => row.session_id))
  const counts = { needYouSessions: 0, running: 0, toReview: 0, openRequests: requests.length, requestSessions: requestSessions.size, oldestRequestAt: requests.length ? Math.min(...requests.map(row => row.created_at)) : null, perRun: [] }
  const runs = new Map()
  const chips = new Map()
  for (const row of sessions) {
    const chipKey = row.run_id ? JSON.stringify([row.run_repo_id, row.run_id]) : row.id
    const priority = requestSessions.has(row.id) ? 3 : row.state === 'starting' || row.state === 'running' ? 2 : row.state === 'done' ? 1 : 0
    chips.set(chipKey, Math.max(chips.get(chipKey) ?? 0, priority))
    if (!row.run_id) continue
    const key = JSON.stringify([row.run_repo_id, row.run_id])
    const run = runs.get(key) ?? { repoId: row.run_repo_id, runId: row.run_id, needYou: 0, total: 0 }
    run.total++
    if (requestSessions.has(row.id)) run.needYou++
    runs.set(key, run)
  }
  for (const priority of chips.values()) {
    if (priority === 3) counts.needYouSessions++
    else if (priority === 2) counts.running++
    else if (priority === 1) counts.toReview++
  }
  counts.perRun = [...runs.values()]
  return counts
}

const urgency = ['needs_approval', 'asked_you', 'crashed', 'running', 'starting', 'done', 'stale', 'idle', 'reviewed', 'ended']

/** Derive grid, quiet row and Rail order from persisted session states. */
export function projectHome(sessions) {
  const ordered = [...sessions].sort((a, b) => urgency.indexOf(a.state) - urgency.indexOf(b.state) || b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id))
  const quiet = ordered.filter(row => ['stale', 'idle', 'reviewed'].includes(row.state))
  return { order: ordered.filter(row => row.state !== 'ended').map(row => row.id), grid: ordered.filter(row => !['stale', 'idle', 'reviewed', 'ended'].includes(row.state)), quiet, rail: ordered.filter(row => row.state !== 'ended') }
}
