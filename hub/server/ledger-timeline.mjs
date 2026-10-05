import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fleetmatesScriptsDir } from './adapters/fleetmates.mjs'
const { projectEvent } = await import(pathToFileURL(path.join(fleetmatesScriptsDir(), 'event-ledger.mjs')).href)

export function initializeLedgerTimeline(store) {
  store.run(`CREATE TABLE IF NOT EXISTS fleet_ledger_events (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
    at INTEGER NOT NULL, observed_at INTEGER NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
  ) STRICT`)
  store.run('CREATE INDEX IF NOT EXISTS fleet_ledger_run ON fleet_ledger_events(repo_id,run_id,at)')
}

export function syncLedgerTimeline(store, run, observedAt) {
  if (!run?.ledger?.events?.length) return 0
  return store.tx(() => {
    let added = 0
    for (const source of run.ledger.events.slice(-1000)) {
      if (!/^T\d{1,127}$/.test(source.task) || !Number.isSafeInteger(source.index) || source.index < 0) continue
      const event = projectEvent(source)
      const data = JSON.stringify(event)
      const id = createHash('sha256').update(JSON.stringify([run.repoId, run.runId, source.task, source.index, event])).digest('hex')
      if (event.at < observedAt - 30 * 86400000 || event.at > observedAt + 86400000) continue
      added += Number(store.run('INSERT OR IGNORE INTO fleet_ledger_events(id,repo_id,run_id,task_id,at,observed_at,sequence,data) VALUES(?,?,?,?,?,?,?,?)', id, run.repoId, run.runId, source.task, event.at, observedAt, source.index, data).changes)
    }
    return added
  })
}

export function sessionTimeline(store, session, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid timeline limit')
  const ref = session?.runRef
  if (!ref) return []
  return store.all(`SELECT id,task_id,at,observed_at,sequence,data FROM fleet_ledger_events WHERE repo_id=? AND run_id=?${ref.taskId ? ' AND task_id=?' : ''} ORDER BY at DESC,task_id DESC,sequence DESC,id DESC LIMIT ?`, ref.repoId, ref.runId, ...(ref.taskId ? [ref.taskId] : []), limit)
    .reverse().map(row => ({ id: row.id, task: row.task_id, observedAt: row.observed_at, ...projectEvent(JSON.parse(row.data)) }))
}
