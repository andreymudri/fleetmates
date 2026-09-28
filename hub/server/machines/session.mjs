import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { expireRequests } from './request.mjs'

function repo(store, cwd, at) {
  let id = cwd || '/unknown'
  let current
  try { current = realpathSync(id) } catch { current = null }
  for (let depth = 0; current && depth < 32; depth++) {
    const marker = path.join(current, '.git')
    try {
      const stat = statSync(marker)
      if (stat.isDirectory() || stat.isFile() && stat.size <= 4096 && readFileSync(marker, 'utf8').startsWith('gitdir:')) { id = current; break }
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  store.run('INSERT OR IGNORE INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', id, id, 0, 1, id, at)
  return id
}

function editedPath(hook) {
  if (hook.hook_event_name !== 'PostToolUse' || !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(hook.tool_name)) return null
  const file = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path
  if (typeof file !== 'string' || !file) return null
  return path.resolve(hook.cwd, file)
}

function sameKnownProcess(row, envelope) {
  if (envelope.ptyId && row.pty_id && envelope.ptyId !== row.pty_id) return false
  if (envelope.claudePid && !row.pty_id && row.process_key && String(envelope.claudePid) !== row.process_key) return false
  return true
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
  const direct = store.get('SELECT * FROM sessions WHERE claude_session_id = ? AND alive = 1 ORDER BY started_at DESC LIMIT 1', hook.session_id)
  if (direct && sameKnownProcess(direct, envelope)) return direct
  const alias = store.get('SELECT s.* FROM sessions s JOIN session_aliases a ON a.session_id = s.id WHERE a.claude_session_id = ? AND s.alive = 1 LIMIT 1', hook.session_id)
  if (alias && sameKnownProcess(alias, envelope)) return alias
  if (hook.hook_event_name === 'SessionStart' && hook.source === 'resume') {
    const ended = store.get('SELECT * FROM sessions WHERE claude_session_id = ? AND alive = 0 ORDER BY ended_at DESC LIMIT 1', hook.session_id)
      ?? store.get('SELECT s.* FROM sessions s JOIN session_aliases a ON a.session_id = s.id WHERE a.claude_session_id = ? AND s.alive = 0 ORDER BY s.ended_at DESC LIMIT 1', hook.session_id)
    if (ended) return ended
  }
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
    const initial = event === 'SessionStart' || event === 'Stop' || hook.notification_type === 'idle_prompt' ? 'idle' : event === 'PermissionRequest' || hook.notification_type === 'permission_prompt' ? 'needs_approval' : event === 'PreToolUse' && hook.tool_name === 'AskUserQuestion' || hook.notification_type === 'elicitation_dialog' ? 'asked_you' : 'running'
    const origin = envelope.ptyId ? 'wrapped' : 'observed'
    const edited = editedPath(hook)
    const task = event === 'UserPromptSubmit' ? hook.prompt?.split('\n')[0].slice(0, 120) || 'Untitled' : 'Untitled'
    store.run('INSERT INTO sessions(id,claude_session_id,origin,pty_id,process_key,repo_id,cwd,task,state,state_since,since_ts,last_activity_at,alive,joined_mid_life,started_at,transcript_path,subagents_active,activity,changed_files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, hook.session_id, origin, envelope.ptyId, envelope.ptyId ?? (envelope.claudePid ? String(envelope.claudePid) : null), repo(store, hook.cwd, at), hook.cwd, task, initial, at, at, at, 1, event === 'SessionStart' ? 0 : 1, at, hook.transcript_path, event === 'SubagentStart' ? 1 : 0, event === 'PreCompact' ? 'compacting' : null, JSON.stringify(edited ? [{ path: edited, adds: null, dels: null }] : []))
    return store.get('SELECT * FROM sessions WHERE id = ?', id)
  }
  if (at < existing.since_ts) return existing
  let state = existing.state
  let stateSince = existing.state_since
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
  let processKey = existing.process_key
  let ptyId = existing.pty_id
  const changedFiles = JSON.parse(existing.changed_files)
  const edited = editedPath(hook)
  if (edited && !changedFiles.some(file => file.path === edited)) changedFiles.push({ path: edited, adds: null, dels: null })
  if (event === 'SessionStart') {
    if (!alive && hook.source === 'resume') {
      alive = 1
      endedAt = null
      endAnnounced = 0
      processKey = envelope.ptyId ?? (envelope.claudePid ? String(envelope.claudePid) : null)
      ptyId = envelope.ptyId ?? null
    }
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
  else if (event === 'SubagentStart') { subagents++; if (!['needs_approval', 'asked_you'].includes(state)) state = 'running' }
  else if (event === 'SubagentStop') subagents = Math.max(0, subagents - 1)
  else if (event === 'PreCompact') activity = 'compacting'
  else if (event === 'PostCompact') activity = null
  else if (event === 'CwdChanged') { cwd = hook.cwd; repoId = repo(store, cwd, at) }
  else if (event === 'Stop' && !subagents && !['needs_approval', 'asked_you'].includes(state)) state = changedFiles.length ? 'done' : 'idle'
  else if (event === 'Notification' && hook.notification_type === 'idle_prompt' && state === 'running') state = 'idle'
  else if (event === 'SessionEnd') {
    endReason = hook.reason
    if (['clear', 'resume'].includes(hook.reason)) stateSince = at
    else if (existing.origin !== 'observed') endAnnounced = 1
    if (!['clear', 'resume'].includes(hook.reason) && existing.origin === 'observed') { state = changedFiles.length ? 'done' : 'ended'; alive = 0; endedAt = at; expireRequests(store, existing.id, 'process_ended') }
  } else if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event) && !requestChanged && !['needs_approval', 'asked_you'].includes(state)) state = 'running'
  const open = store.all('SELECT kind FROM requests WHERE session_id = ? AND state = ?', existing.id, 'open')
  if (open.some(row => row.kind === 'permission')) state = 'needs_approval'
  else if (open.some(row => row.kind === 'question')) state = 'asked_you'
  else if (['needs_approval', 'asked_you'].includes(state)) state = event === 'Notification' && hook.notification_type === 'idle_prompt' ? 'idle' : 'running'
  const since = state !== existing.state ? at : existing.since_ts
  store.run('UPDATE sessions SET claude_session_id=?,state=?,state_since=?,since_ts=?,last_activity_at=?,alive=?,activity=?,subagents_active=?,end_reason=?,end_announced=?,ended_at=?,task=?,transcript_path=?,cwd=?,repo_id=?,review_baseline=?,process_key=?,pty_id=?,changed_files=? WHERE id=?', claudeId, state, state !== existing.state ? at : stateSince, since, Math.max(at, existing.last_activity_at), alive, activity, subagents, endReason, endAnnounced, endedAt, task, hook.transcript_path ?? existing.transcript_path, cwd, repoId, repoId === existing.repo_id ? existing.review_baseline : null, processKey, ptyId, JSON.stringify(changedFiles), existing.id)
  return store.get('SELECT * FROM sessions WHERE id = ?', existing.id)
}
