import { createHash, randomUUID } from 'node:crypto'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

/** Match a tool outcome with the request that opened it. */
export function matchKey(hook) {
  return createHash('sha1').update(JSON.stringify([hook.tool_name, canonical(hook.tool_input ?? {})])).digest('hex')
}

/** Open, answer and expire observe-only requests inside the caller's transaction. */
export function applyRequestHook(store, session, envelope) {
  const hook = envelope.hook
  const event = hook.hook_event_name
  const at = envelope.hookTs
  const key = matchKey(hook)
  let kind = null
  let source = null
  if (event === 'PermissionRequest') { kind = 'permission'; source = 'permission_request' }
  if (event === 'PreToolUse' && hook.tool_name === 'AskUserQuestion') { kind = 'question'; source = 'ask_user_question' }
  if (event === 'Notification' && hook.notification_type === 'permission_prompt') { kind = 'permission'; source = 'notification' }
  if (event === 'Notification' && hook.notification_type === 'elicitation_dialog') { kind = 'question'; source = 'elicitation' }
  if (kind) {
    if (source === 'notification') {
      const recent = store.get('SELECT id FROM requests WHERE session_id = ? AND kind = ? AND state = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 1', session.id, 'permission', 'open', at - 2000, at + 2000)
      if (recent) return false
    }
    const existing = store.get('SELECT id FROM requests WHERE session_id = ? AND state = ? AND match_key = ? ORDER BY created_at LIMIT 1', session.id, 'open', key)
    if (existing) return false
    const summary = hook.tool_name ? `${hook.tool_name}: ${JSON.stringify(hook.tool_input ?? {}).slice(0, 160)}` : hook.message ?? 'Needs your answer'
    store.run('INSERT INTO requests(id, session_id, kind, tier, tool_name, summary, detail, options, state, source, match_key, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', randomUUID(), session.id, kind, kind === 'permission' ? 'caution' : null, hook.tool_name ?? null, summary, JSON.stringify(hook.tool_input ?? {}), JSON.stringify(hook.tool_input?.questions?.[0]?.options ?? []), 'open', source, key, at)
    return true
  }
  if (['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) {
    const row = store.get('SELECT id FROM requests WHERE session_id = ? AND state = ? AND match_key = ? ORDER BY created_at LIMIT 1', session.id, 'open', key)
    if (!row) return false
    store.run('UPDATE requests SET state = ?, answer = ?, answered_at = ? WHERE id = ?', 'answered', JSON.stringify({ via: 'terminal', choice: event === 'PermissionDenied' ? 'deny' : 'allow' }), at, row.id)
    return true
  }
  if (event === 'UserPromptSubmit') {
    store.run('UPDATE requests SET state = ?, answer = ?, answered_at = ? WHERE session_id = ? AND state = ?', 'answered', JSON.stringify({ via: 'terminal', choice: 'deny' }), at, session.id, 'open')
    return true
  }
  if (event === 'Notification' && hook.notification_type === 'idle_prompt') return expireRequests(store, session.id, 'interrupted')
  return false
}

/** Expire every open request for a session. */
export function expireRequests(store, sessionId, reason) {
  return store.run('UPDATE requests SET state = ?, expired_reason = ? WHERE session_id = ? AND state = ?', 'expired', reason, sessionId, 'open').changes > 0
}
