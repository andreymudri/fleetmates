import { createHash } from 'node:crypto'

const maxLine = 1024 * 1024
const knownEvents = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'CwdChanged', 'PreCompact', 'PostCompact', 'WorktreeCreate', 'WorktreeRemove'])
const toolEvents = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])

function safeDepth(value) {
  const stack = [[value, 0]]
  let visited = 0
  while (stack.length) {
    const [item, depth] = stack.pop()
    if (++visited > 20_000 || depth > 64) return false
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) stack.push([child, depth + 1])
    }
  }
  return true
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

/** Validate one hook envelope against the fields used by the deck. */
export function validateEnvelope(raw) {
  if (Buffer.byteLength(raw) > maxLine) return { ok: false, reason: 'too_large' }
  let value
  try { value = JSON.parse(raw) } catch { return { ok: false, reason: 'invalid_json' } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid_envelope' }
  if (value.v !== 1) return { ok: false, reason: 'unsupported_version' }
  if (!Number.isSafeInteger(value.hookTs) || value.hookTs < 0) return { ok: false, reason: 'invalid_hookTs' }
  if (value.ptyId !== null && typeof value.ptyId !== 'string') return { ok: false, reason: 'invalid_ptyId' }
  if (value.claudePid !== null && (!Number.isInteger(value.claudePid) || value.claudePid <= 0)) return { ok: false, reason: 'invalid_claudePid' }
  if (!Array.isArray(value.pidChain) || value.pidChain.length > 8 || value.pidChain.some(pid => !Number.isInteger(pid) || pid <= 0)) return { ok: false, reason: 'invalid_pidChain' }
  if (typeof value.truncated !== 'boolean') return { ok: false, reason: 'invalid_truncated' }
  const hook = value.hook
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return { ok: false, reason: 'missing_field:hook' }
  if (!safeDepth(hook)) return { ok: false, reason: 'too_deep' }
  for (const key of ['session_id', 'transcript_path', 'cwd', 'hook_event_name']) {
    if (typeof hook[key] !== 'string' || !hook[key]) return { ok: false, reason: `invalid_${key}` }
  }
  const event = hook.hook_event_name
  if (!knownEvents.has(event)) return { ok: false, reason: 'unknown_event' }
  if (hook.permission_mode !== undefined && typeof hook.permission_mode !== 'string') return { ok: false, reason: 'invalid_permission_mode' }
  const requiredString = event === 'SessionStart' ? 'source' : event === 'SessionEnd' ? 'reason' : event === 'UserPromptSubmit' ? 'prompt' : event === 'Notification' ? 'notification_type' : null
  if (requiredString && typeof hook[requiredString] !== 'string') return { ok: false, reason: `invalid_${requiredString}` }
  if (toolEvents.has(event) && (typeof hook.tool_name !== 'string' || !hook.tool_name || (hook.tool_input === undefined && !value.truncated) || (hook.tool_input !== undefined && (typeof hook.tool_input !== 'object' || hook.tool_input === null || Array.isArray(hook.tool_input))))) return { ok: false, reason: 'invalid_tool_input' }
  if (['Stop', 'SubagentStop'].includes(event) && typeof hook.stop_hook_active !== 'boolean') return { ok: false, reason: 'invalid_stop_hook_active' }
  if (event === 'Notification' && typeof hook.message !== 'string') return { ok: false, reason: 'invalid_message' }
  return { ok: true, value }
}

/** Stable identity for deduplication across socket delivery and spool replay. */
export function dedupeKey(envelope) {
  const hook = envelope.hook
  return createHash('sha1').update(JSON.stringify([hook.session_id, hook.hook_event_name, envelope.hookTs, createHash('sha1').update(JSON.stringify(canonical(hook))).digest('hex')])).digest('hex')
}
