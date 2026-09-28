import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

/** Match a tool outcome with the request that opened it. */
export function matchKey(hook) {
  return createHash('sha1').update(JSON.stringify([hook.tool_name, canonical(hook.tool_input ?? {})])).digest('hex')
}

function shellTokens(command) {
  const tokens = []
  let value = ''
  let quoted = false
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      if (char === quote) { quote = null; quoted = true }
      else if (char === '\\' && quote === '"' && i + 1 < command.length) value += command[++i]
      else value += char
    } else if (char === "'" || char === '"') { quote = char; quoted = true }
    else if (char === '\\' && i + 1 < command.length) value += command[++i]
    else if (/\s/.test(char) || ';|&()'.includes(char)) {
      if (value) tokens.push({ value, quoted })
      value = ''
      quoted = false
      if (';|&()'.includes(char) || char === '\n') tokens.push({ value: char, separator: true })
    } else value += char
  }
  if (value) tokens.push({ value, quoted })
  return tokens
}

function destructiveSegment(words, depth) {
  if (depth > 4 || !words.length) return false
  let index = 0
  while (index < words.length) {
    const word = words[index].value
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ['env', 'command', 'builtin', 'time', 'nice', 'nohup', 'sudo', 'doas'].includes(word)) { index++; continue }
    if (word === 'timeout') { index += 2; continue }
    if (word === 'stdbuf') { index++; while (words[index]?.value.startsWith('-')) index++; continue }
    if (['uv', 'poetry'].includes(word) && words[index + 1]?.value === 'run' || word === 'pnpm' && words[index + 1]?.value === 'exec' || word === 'npx' && words[index + 1]?.value === '--no-install') { index += 2; continue }
    break
  }
  const command = path.posix.basename(words[index]?.value ?? '')
  const args = words.slice(index + 1).map(word => word.value)
  if (['rm', 'shred', 'dd', 'wipefs', 'truncate', 'shutdown', 'reboot'].includes(command) || command.startsWith('mkfs')) return true
  if (command === 'find' && (args.includes('-delete') || ['-exec', '-execdir', '-ok'].some(flag => {
    const at = args.indexOf(flag)
    return at >= 0 && destructiveSegment(words.slice(index + at + 2), depth + 1)
  }))) return true
  if (command === 'xargs' && destructiveSegment(words.slice(index + 1), depth + 1)) return true
  if (command === 'rsync' && args.some(arg => arg.startsWith('--delete'))) return true
  if (command === 'git' && args[0] === 'push' && args.slice(1).some(arg => ['-f', '-d', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete'].includes(arg) || arg.startsWith('+') || arg.startsWith(':'))) return true
  if (command === 'git' && args[0] === 'reset' && args.some(arg => ['--hard', '--keep', '--merge'].includes(arg))) return true
  if (['sh', 'bash', 'zsh'].includes(command)) {
    const at = args.indexOf('-c')
    if (at >= 0 && words[index + at + 2]?.quoted && destructiveShell(args[at + 1], depth + 1)) return true
  }
  if (command === 'eval' && words[index + 1]?.quoted && destructiveShell(args[0], depth + 1)) return true
  return false
}

function destructiveShell(command, depth = 0) {
  if (typeof command !== 'string' || depth > 4) return false
  const tokens = shellTokens(command)
  let segment = []
  for (const token of tokens) {
    if (token.separator) {
      if (destructiveSegment(segment, depth)) return true
      segment = []
    } else segment.push(token)
  }
  return destructiveSegment(segment, depth)
}

/** Classify a permission conservatively; unknown commands remain Caution. */
export function permissionTier(hook) {
  if (hook.tool_name === 'Bash' && destructiveShell(hook.tool_input?.command)) return 'destructive'
  return 'caution'
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
    if (source === 'permission_request') {
      const fallback = store.get('SELECT id FROM requests WHERE session_id = ? AND kind = ? AND state = ? AND source = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 1', session.id, 'permission', 'open', 'notification', at - 2000, at + 2000)
      if (fallback) {
        store.run('UPDATE requests SET source = ?, tool_name = ?, summary = ?, detail = ?, match_key = ?, tier = ? WHERE id = ?', source, hook.tool_name, summary, JSON.stringify(hook.tool_input ?? {}), key, permissionTier(hook), fallback.id)
        return true
      }
    }
    store.run('INSERT INTO requests(id, session_id, kind, tier, tool_name, summary, detail, options, state, source, match_key, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', randomUUID(), session.id, kind, kind === 'permission' ? permissionTier(hook) : null, hook.tool_name ?? null, summary, JSON.stringify(hook.tool_input ?? {}), JSON.stringify(hook.tool_input?.questions?.[0]?.options ?? []), 'open', source, key, at)
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
