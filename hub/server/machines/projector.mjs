import { dedupeKey } from '../ingest/validate.mjs'
import { projectCounts, projectHome } from './counts.mjs'
import { applyRequestHook, expireRequests, resumedActivityEvents } from './request.mjs'
import { applySessionHook, captureReviewBaseline, persistSessionSummary, resolveSession } from './session.mjs'

const ranks = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'PermissionDenied', 'PostToolUseFailure', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd']
const rank = event => {
  const index = ranks.indexOf(event)
  return index < 0 ? 1 : index === 0 ? 0 : index + 1
}

function sessionView(row) {
  return { id: row.id, claudeSessionId: row.claude_session_id, origin: row.origin, repoId: row.repo_id, cwd: row.cwd, task: row.task, state: row.state, stateSince: row.state_since, lastActivityAt: row.last_activity_at, alive: !!row.alive, joinedMidLife: !!row.joined_mid_life, changedFiles: JSON.parse(row.changed_files), crashKind: row.crash_kind, exitCode: row.exit_code, exitSignal: row.exit_signal }
}
function requestView(row) {
  return { id: row.id, sessionId: row.session_id, kind: row.kind, tier: row.tier, state: row.state, answer: row.answer ? JSON.parse(row.answer) : null, expiredReason: row.expired_reason, createdAt: row.created_at, summary: row.summary }
}

/** Persist ordered hook batches and publish only sequences from committed transactions. */
export function createProjector({ store, now = Date.now, publish = () => {} }) {
  function snapshot() {
    const sessions = store.all('SELECT * FROM sessions ORDER BY started_at, id').map(sessionView)
    const requests = store.all('SELECT * FROM requests ORDER BY created_at, id').map(requestView)
    return { seq: Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq), sessions, requests, counts: projectCounts(store), home: projectHome(sessions, requests) }
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
        for (const envelope of [...batch].sort((a, b) => a.hookTs - b.hookTs || rank(a.hook.hook_event_name) - rank(b.hook.hook_event_name))) {
          const hook = envelope.hook
          const key = envelope.dedupeKey ?? dedupeKey(envelope)
          if (store.get('SELECT id FROM hook_events WHERE dedupe_key = ?', key)) continue
          let session = resolveSession(store, envelope)
          if (!session && hook.hook_event_name === 'SessionEnd') continue
          const late = !!session && (envelope.hookTs < session.since_ts || !session.alive && !(hook.hook_event_name === 'SessionStart' && hook.source === 'resume'))
          const beforeRequests = session ? new Map(store.all('SELECT * FROM requests WHERE session_id = ?', session.id).map(row => [row.id, requestView(row)])) : new Map()
          let requestChanged = false
          if (late && session.alive && [...resumedActivityEvents, 'PermissionDenied'].includes(hook.hook_event_name)) {
            requestChanged = applyRequestHook(store, session, envelope, { late: true })
            if (requestChanged && ['needs_approval', 'asked_you'].includes(session.state)) {
              const open = store.all('SELECT kind FROM requests WHERE session_id = ? AND state = ?', session.id, 'open')
              const state = open.some(row => row.kind === 'permission') ? 'needs_approval' : open.length ? 'asked_you' : 'running'
              store.run('UPDATE sessions SET state = ? WHERE id = ?', state, session.id)
              session = store.get('SELECT * FROM sessions WHERE id = ?', session.id)
            }
          }
          if (!late) {
            const known = !!session
            if (!known) session = applySessionHook(store, envelope, null, false)
            if (session) {
              requestChanged = applyRequestHook(store, session, envelope)
              if (known) session = applySessionHook(store, envelope, session, requestChanged)
            }
          }
          store.run('INSERT INTO hook_events(dedupe_key,session_id,claude_session_id,event,hook_ts,received_at,via,pty_id,claude_pid,applied,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)', key, session?.id ?? null, hook.session_id, hook.hook_event_name, envelope.hookTs, envelope.receivedAt ?? now(), envelope.via ?? 'socket', envelope.ptyId ?? null, envelope.claudePid ?? null, late ? 0 : 1, JSON.stringify(hook))
          if (session && (!late || requestChanged)) {
            for (const row of store.all('SELECT * FROM requests WHERE session_id = ?', session.id)) {
              if (!beforeRequests.has(row.id)) store.appendEvent({ at: envelope.hookTs, type: 'request.opened', entityId: row.id, data: requestView(row) })
              else if (beforeRequests.get(row.id).state === 'open' && row.state !== 'open') store.appendEvent({ at: envelope.hookTs, type: 'request.closed', entityId: row.id, data: requestView(row) })
              else if (JSON.stringify(beforeRequests.get(row.id)) !== JSON.stringify(requestView(row))) store.appendEvent({ at: envelope.hookTs, type: 'request.updated', entityId: row.id, data: requestView(row) })
            }
          }
          if (session) persistSessionSummary(store, session)
          if (session && (!late || requestChanged)) store.appendEvent({ at: envelope.hookTs, type: 'session.upserted', entityId: session.id, data: sessionView(session) })
        }
        store.appendEvent({ at: now(), type: 'counts', data: projectCounts(store) })
      })
    },
    tick(at = now()) {
      return commit(() => {
        for (const row of store.all('SELECT * FROM sessions WHERE origin = ? AND alive = 1 AND end_reason IN (?, ?) AND ? - state_since >= ?', 'observed', 'clear', 'resume', at, 5000)) {
          closeRequests(row.id, 'process_ended', at)
          const state = JSON.parse(row.changed_files).length ? 'done' : 'ended'
          store.run('UPDATE sessions SET state = ?, state_since = ?, alive = 0, ended_at = ?, since_ts = ? WHERE id = ?', state, state === row.state ? row.state_since : at, at, at, row.id)
          persistSessionSummary(store, store.get('SELECT * FROM sessions WHERE id = ?', row.id))
          store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id)) })
        }
        for (const row of store.all('SELECT * FROM sessions WHERE state = ? AND (activity IS NULL OR activity <> ?) AND ? - last_activity_at >= ?', 'running', 'compacting', at, 1_200_000)) {
          store.run('UPDATE sessions SET state = ?, state_since = last_activity_at, since_ts = ? WHERE id = ?', 'stale', at, row.id)
          store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id)) })
        }
        for (const row of store.all('SELECT * FROM sessions WHERE origin = ? AND alive = 1 AND process_key IS NULL AND ? - last_activity_at >= ?', 'observed', at, 86_400_000)) {
          closeRequests(row.id, 'process_ended', at)
          store.run('UPDATE sessions SET state = ?, state_since = ?, alive = 0, ended_at = ?, since_ts = ? WHERE id = ?', 'ended', row.state === 'ended' ? row.state_since : at, at, at, row.id)
          persistSessionSummary(store, store.get('SELECT * FROM sessions WHERE id = ?', row.id))
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
          store.run('UPDATE sessions SET state=?,state_since=?,alive=0,crash_kind=?,ended_at=?,since_ts=? WHERE id=?', 'crashed', row.state === 'crashed' ? row.state_since : at, 'lost', at, at, row.id)
        } else if (signal.type === 'exit' && row.alive) {
          closeRequests(row.id, 'process_ended', at)
          const exitSignal = signal.signal && signal.signal !== '0' ? String(signal.signal) : null
          const crashed = (signal.code !== 0 || exitSignal !== null) && !row.user_stop_requested && !row.end_announced
          const state = crashed ? 'crashed' : JSON.parse(row.changed_files).length ? 'done' : 'ended'
          store.run('UPDATE sessions SET state=?,state_since=?,alive=0,ended_at=?,exit_code=?,exit_signal=?,crash_kind=?,since_ts=? WHERE id=?', state, state === row.state ? row.state_since : at, at, signal.code ?? null, exitSignal, crashed ? exitSignal ? 'signal' : 'exit' : null, at, row.id)
        } else if (signal.type === 'review' && row.state === 'done') {
          const baseline = captureReviewBaseline(row.repo_id, row.review_baseline)
          if (!baseline && row.review_baseline) return
          store.run('UPDATE sessions SET state=?,reviewed_at=?,state_since=?,since_ts=?,changed_files=?,review_baseline=? WHERE id=?', row.alive ? 'reviewed' : 'ended', at, at, at, '[]', baseline ?? row.review_baseline, row.id)
        }
        persistSessionSummary(store, store.get('SELECT * FROM sessions WHERE id = ?', row.id))
        store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id)) })
        store.appendEvent({ at, type: 'counts', data: projectCounts(store) })
      })
    }
  }
}
