import { randomUUID } from 'node:crypto'
import { expireRequests } from './request.mjs'

function repo(store, cwd, at) {
  const id = cwd || '/unknown'
  store.run('INSERT OR IGNORE INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', id, id, 0, 1, id, at)
  return id
}

/** Resolve a hook by PTY, process, current conversation, aliases, then end/start path fallback. */
export function resolveSession(store, envelope) {
  const hook = envelope.hook
  const pty = envelope.ptyId
  if (pty) {
    const found = store.get('SELECT * FROM sessions WHERE pty_id = ? AND alive = 1', pty)
    if (found) return found
  }
  if (envelope.claudePid) {
    const found = store.get('SELECT * FROM sessions WHERE process_key = ? AND alive = 1', String(envelope.claudePid))
    if (found) return found
  }
  const direct = store.get('SELECT * FROM sessions WHERE claude_session_id = ? ORDER BY started_at DESC LIMIT 1', hook.session_id)
  if (direct) return direct
  const alias = store.get('SELECT s.* FROM sessions s JOIN session_aliases a ON a.session_id = s.id WHERE a.claude_session_id = ? LIMIT 1', hook.session_id)
  if (alias) return alias
  if (hook.hook_event_name === 'SessionStart' && ['clear', 'resume', 'fork'].includes(hook.source)) {
    const dirname = hook.transcript_path?.slice(0, hook.transcript_path.lastIndexOf('/'))
    const rows = store.all('SELECT * FROM sessions WHERE cwd = ? AND alive = 1 AND end_reason IN (?, ?) ORDER BY state_since DESC', hook.cwd, 'clear', 'resume')
    return rows.find(row => row.transcript_path?.slice(0, row.transcript_path.lastIndexOf('/')) === dirname && envelope.hookTs - row.state_since <= 5000) ?? null
  }
  return null
}

/** Apply an observed hook to a session inside the caller's transaction. */
export function applySessionHook(store, envelope, existing, requestChanged) {
  const hook = envelope.hook
  const event = hook.hook_event_name
  const at = envelope.hookTs
  if (!existing) {
    if (event === 'SessionEnd') return null
    const id = randomUUID()
    const initial = event === 'PermissionRequest' || hook.notification_type === 'permission_prompt' ? 'needs_approval' : event === 'PreToolUse' && hook.tool_name === 'AskUserQuestion' || hook.notification_type === 'elicitation_dialog' ? 'asked_you' : event === 'Stop' || hook.notification_type === 'idle_prompt' ? 'idle' : 'running'
    const origin = envelope.ptyId ? 'wrapped' : 'observed'
    store.run('INSERT INTO sessions(id,claude_session_id,origin,pty_id,process_key,repo_id,cwd,task,state,state_since,since_ts,last_activity_at,alive,joined_mid_life,started_at,transcript_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, hook.session_id, origin, envelope.ptyId, envelope.ptyId ?? (envelope.claudePid ? String(envelope.claudePid) : null), repo(store, hook.cwd, at), hook.cwd, 'Untitled', initial, at, at, at, 1, 1, at, hook.transcript_path)
    return store.get('SELECT * FROM sessions WHERE id = ?', id)
  }
  if (at < existing.since_ts) return existing
  let state = existing.state
  let alive = existing.alive
  let activity = existing.activity
  let subagents = existing.subagents_active
  let endReason = existing.end_reason
  let endAnnounced = existing.end_announced
  let endedAt = existing.ended_at
  let claudeId = existing.claude_session_id
  let task = existing.task
  let cwd = existing.cwd
  let repoId = existing.repo_id
  if (event === 'SessionStart') {
    if (hook.session_id !== claudeId) {
      store.run('INSERT OR IGNORE INTO session_aliases(claude_session_id,session_id,replaced_at,source) VALUES(?,?,?,?)', claudeId, existing.id, at, hook.source === 'compact' ? 'compact' : ['clear', 'resume', 'fork'].includes(hook.source) ? hook.source : 'heuristic')
      claudeId = hook.session_id
      if (hook.source !== 'compact') expireRequests(store, existing.id, 'session_replaced')
    }
    if (hook.source === 'clear' || hook.source === 'resume' || hook.source === 'fork') { state = 'idle'; subagents = 0; endReason = null }
    if (hook.source === 'compact') activity = null
  } else if (event === 'UserPromptSubmit') {
    state = 'running'
    if (task === 'Untitled') task = hook.prompt?.split('\n')[0].slice(0, 120) || task
  } else if (event === 'PermissionRequest' || event === 'Notification' && hook.notification_type === 'permission_prompt') state = 'needs_approval'
  else if (event === 'PreToolUse' && hook.tool_name === 'AskUserQuestion' || event === 'Notification' && hook.notification_type === 'elicitation_dialog') state = 'asked_you'
  else if (event === 'SubagentStart') subagents++
  else if (event === 'SubagentStop') subagents = Math.max(0, subagents - 1)
  else if (event === 'PreCompact') activity = 'compacting'
  else if (event === 'PostCompact') activity = null
  else if (event === 'CwdChanged') { cwd = hook.cwd; repoId = repo(store, cwd, at) }
  else if (event === 'Stop' && !subagents && !['needs_approval', 'asked_you'].includes(state)) state = JSON.parse(existing.changed_files).length ? 'done' : 'idle'
  else if (event === 'Notification' && hook.notification_type === 'idle_prompt' && state === 'running') state = 'idle'
  else if (event === 'SessionEnd') {
    endReason = hook.reason
    if (['clear', 'resume'].includes(hook.reason)) store.run('UPDATE sessions SET state_since = ? WHERE id = ?', at, existing.id)
    else if (existing.origin !== 'observed') endAnnounced = 1
    if (!['clear', 'resume'].includes(hook.reason) && existing.origin === 'observed') { state = JSON.parse(existing.changed_files).length ? 'done' : 'ended'; alive = 0; endedAt = at; expireRequests(store, existing.id, 'process_ended') }
  } else if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event) && !requestChanged && !['needs_approval', 'asked_you'].includes(state)) state = 'running'
  const open = store.all('SELECT kind FROM requests WHERE session_id = ? AND state = ?', existing.id, 'open')
  if (open.some(row => row.kind === 'permission')) state = 'needs_approval'
  else if (open.some(row => row.kind === 'question')) state = 'asked_you'
  else if (['needs_approval', 'asked_you'].includes(state)) state = event === 'Notification' && hook.notification_type === 'idle_prompt' ? 'idle' : 'running'
  const since = state !== existing.state ? at : existing.since_ts
  store.run('UPDATE sessions SET claude_session_id=?,state=?,state_since=?,since_ts=?,last_activity_at=?,alive=?,activity=?,subagents_active=?,end_reason=?,end_announced=?,ended_at=?,task=?,transcript_path=?,cwd=?,repo_id=?,review_baseline=? WHERE id=?', claudeId, state, state !== existing.state ? at : existing.state_since, since, Math.max(at, existing.last_activity_at), alive, activity, subagents, endReason, endAnnounced, endedAt, task, hook.transcript_path ?? existing.transcript_path, cwd, repoId, repoId === existing.repo_id ? existing.review_baseline : null, existing.id)
  return store.get('SELECT * FROM sessions WHERE id = ?', existing.id)
}
