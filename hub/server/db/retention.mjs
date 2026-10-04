import { REQUEST_AUDIT_KINDS } from '../approvals/audit.mjs'

const thirtyDays = 30 * 24 * 60 * 60 * 1000
const expiredSessions = "state = 'ended' AND ended_at < ? AND NOT EXISTS (SELECT 1 FROM requests WHERE requests.session_id = sessions.id AND requests.state = 'open')"

/** Prune expired detail atomically while retaining summaries, active requests, rule events and tiers audit rows. */
export function runRetention(store, { now = Date.now() } = {}) {
  const cutoff = now - thirtyDays
  const removed = store.tx(() => {
    const sessions = store.all(`SELECT id FROM sessions WHERE ${expiredSessions}`, cutoff)
    store.run(`DELETE FROM sessions WHERE ${expiredSessions}`, cutoff)
    store.run('DELETE FROM hook_events WHERE received_at < ?', cutoff)
    store.run('DELETE FROM events WHERE at < ?', cutoff)
    store.run('DELETE FROM rejected_events WHERE received_at < ?', cutoff)
    store.run('DELETE FROM session_scrollback WHERE captured_at < ?', cutoff)
    store.run("DELETE FROM requests WHERE state <> 'open' AND created_at < ?", cutoff)
    // 07-approvals 11 (APR-O8 default): request audit rows for 30 days; tiers events are kept.
    store.run(`DELETE FROM approval_audit WHERE at < ? AND kind IN (${REQUEST_AUDIT_KINDS.map(() => '?').join(',')})`, cutoff, ...REQUEST_AUDIT_KINDS)
    store.run("INSERT INTO meta(key,value) VALUES('last_retention_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(now))
    for (const { id } of sessions) store.run("INSERT INTO events(at,type,entity_id,data) VALUES(?,'session.removed',?,'{}')", now, id)
    return sessions.length
  })
  store.db.exec('PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);')
  return { removed, cutoff }
}
