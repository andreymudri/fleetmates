import { dedupeKey } from '../ingest/validate.mjs'
import { projectCounts, projectHome } from './counts.mjs'
import { applyRequestHook, expireRequests } from './request.mjs'
import { applySessionHook, resolveSession } from './session.mjs'

const ranks = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'PermissionDenied', 'PostToolUseFailure', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd']

function sessionView(row) {
  return { id: row.id, claudeSessionId: row.claude_session_id, origin: row.origin, repoId: row.repo_id, cwd: row.cwd, task: row.task, state: row.state, stateSince: row.state_since, lastActivityAt: row.last_activity_at, alive: !!row.alive, joinedMidLife: !!row.joined_mid_life, changedFiles: JSON.parse(row.changed_files) }
}
function requestView(row) {
  return { id: row.id, sessionId: row.session_id, kind: row.kind, tier: row.tier, state: row.state, answer: row.answer ? JSON.parse(row.answer) : null, expiredReason: row.expired_reason, createdAt: row.created_at, summary: row.summary }
}

/** Persist ordered hook batches and publish only sequences from committed transactions. */
export function createProjector({ store, now = Date.now, publish = () => {} }) {
  function snapshot() {
    const sessions = store.all('SELECT * FROM sessions ORDER BY started_at, id').map(sessionView)
    return { seq: Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq), sessions, requests: store.all('SELECT * FROM requests ORDER BY created_at, id').map(requestView), counts: projectCounts(store), home: projectHome(sessions) }
  }
  function commit(fn) {
    const before = Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq)
    store.tx(fn)
    const events = store.all('SELECT seq, at, type, entity_id, data FROM events WHERE seq > ? ORDER BY seq', before).map(row => ({ seq: Number(row.seq), at: row.at, type: row.type, entityId: row.entity_id, data: JSON.parse(row.data) }))
    for (const event of events) publish(event)
    return events
  }
  function closeRequests(sessionId, reason, at) {
    const open = store.all('SELECT id FROM requests WHERE session_id = ? AND state = ?', sessionId, 'open')
    expireRequests(store, sessionId, reason)
    for (const request of open) {
      const row = store.get('SELECT * FROM requests WHERE id = ?', request.id)
      store.appendEvent({ at, type: 'request.closed', entityId: row.id, data: requestView(row) })
    }
  }
  return {
    snapshot,
    applyHooks(batch) {
      return commit(() => {
        for (const envelope of [...batch].sort((a, b) => a.hookTs - b.hookTs || ranks.indexOf(a.hook.hook_event_name) - ranks.indexOf(b.hook.hook_event_name))) {
          const hook = envelope.hook
          const key = envelope.dedupeKey ?? dedupeKey(envelope)
          if (store.get('SELECT id FROM hook_events WHERE dedupe_key = ?', key)) continue
          let session = resolveSession(store, envelope)
          if (!session && hook.hook_event_name === 'SessionEnd') continue
          const late = !!session && envelope.hookTs < session.since_ts
          const beforeRequests = session ? new Map(store.all('SELECT id, state FROM requests WHERE session_id = ?', session.id).map(row => [row.id, row.state])) : new Map()
          if (!late && session) applyRequestHook(store, session, envelope)
          if (!late) {
            session = applySessionHook(store, envelope, session, false)
            if (session && !store.get('SELECT id FROM hook_events WHERE dedupe_key = ?', key) && !store.get('SELECT id FROM requests WHERE session_id = ? AND created_at = ? AND state = ?', session.id, envelope.hookTs, 'open')) {
              // A newly discovered request needs the session row before its foreign key can be inserted.
              applyRequestHook(store, session, envelope)
              session = applySessionHook(store, envelope, session, true)
            }
          }
          store.run('INSERT INTO hook_events(dedupe_key,session_id,claude_session_id,event,hook_ts,received_at,via,pty_id,claude_pid,applied,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)', key, session?.id ?? null, hook.session_id, hook.hook_event_name, envelope.hookTs, envelope.receivedAt ?? now(), envelope.via ?? 'socket', envelope.ptyId ?? null, envelope.claudePid ?? null, late ? 0 : 1, JSON.stringify(hook))
          if (session && !late) {
            for (const row of store.all('SELECT * FROM requests WHERE session_id = ?', session.id)) {
              if (!beforeRequests.has(row.id)) store.appendEvent({ at: envelope.hookTs, type: 'request.opened', entityId: row.id, data: requestView(row) })
              else if (beforeRequests.get(row.id) === 'open' && row.state !== 'open') store.appendEvent({ at: envelope.hookTs, type: 'request.closed', entityId: row.id, data: requestView(row) })
            }
          }
          if (session && !late) store.appendEvent({ at: envelope.hookTs, type: 'session.upserted', entityId: session.id, data: sessionView(session) })
        }
        store.appendEvent({ at: now(), type: 'counts', data: projectCounts(store) })
      })
    },
    tick(at = now()) {
      return commit(() => {
        for (const row of store.all('SELECT * FROM sessions WHERE origin = ? AND alive = 1 AND end_reason IN (?, ?) AND ? - state_since >= ?', 'observed', 'clear', 'resume', at, 5000)) {
          expireRequests(store, row.id, 'process_ended')
          store.run('UPDATE sessions SET state = ?, alive = 0, ended_at = ?, since_ts = ? WHERE id = ?', JSON.parse(row.changed_files).length ? 'done' : 'ended', at, at, row.id)
          store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id)) })
        }
        for (const row of store.all('SELECT * FROM sessions WHERE state = ? AND ? - last_activity_at >= ?', 'running', at, 1_200_000)) {
          store.run('UPDATE sessions SET state = ?, state_since = last_activity_at, since_ts = ? WHERE id = ?', 'stale', at, row.id)
          store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id)) })
        }
        for (const row of store.all('SELECT * FROM sessions WHERE origin = ? AND alive = 1 AND process_key IS NULL AND ? - last_activity_at >= ?', 'observed', at, 86_400_000)) {
          closeRequests(row.id, 'process_ended', at)
          store.run('UPDATE sessions SET state = ?, alive = 0, ended_at = ?, since_ts = ? WHERE id = ?', 'ended', at, at, row.id)
          store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id)) })
        }
        store.appendEvent({ at, type: 'counts', data: projectCounts(store) })
      })
    },
    signal(sessionId, signal, at = now()) {
      return commit(() => {
        const row = store.get('SELECT * FROM sessions WHERE id = ?', sessionId)
        if (!row) return
        if (signal.type === 'pid_gone' && row.origin === 'observed' && row.alive) {
          closeRequests(row.id, 'process_ended', at)
          store.run('UPDATE sessions SET state=?,alive=0,crash_kind=?,since_ts=? WHERE id=?', 'crashed', 'lost', at, row.id)
        } else if (signal.type === 'exit' && row.alive) {
          closeRequests(row.id, 'process_ended', at)
          const crashed = signal.code !== 0 && !row.user_stop_requested && !row.end_announced
          store.run('UPDATE sessions SET state=?,alive=0,ended_at=?,exit_code=?,crash_kind=?,since_ts=? WHERE id=?', crashed ? 'crashed' : JSON.parse(row.changed_files).length ? 'done' : 'ended', at, signal.code ?? null, crashed ? 'exit' : null, at, row.id)
        } else if (signal.type === 'review' && row.state === 'done') {
          store.run('UPDATE sessions SET state=?,reviewed_at=?,state_since=?,since_ts=? WHERE id=?', row.alive ? 'reviewed' : 'ended', at, at, at, row.id)
        }
        store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id)) })
        store.appendEvent({ at, type: 'counts', data: projectCounts(store) })
      })
    }
  }
}
