import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
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

function embeddedCommands(command) {
  const found = []
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\\' && quote !== "'" && i + 1 < command.length) { i++; continue }
    if (char === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; continue }
    if (quote === "'") continue
    if (char === '"') { quote = quote === '"' ? null : '"'; continue }
    if (char === '`') {
      const start = i + 1
      let end = start
      while (end < command.length && command[end] !== '`') {
        if (command[end] === '\\') end++
        end++
      }
      if (end < command.length) { found.push(command.slice(start, end)); i = end }
    } else if (char === '$' && command[i + 1] === '(') {
      const start = i + 2
      let depth = 1
      let end = start
      for (; end < command.length; end++) {
        if (command[end] === '(') depth++
        if (command[end] === ')' && --depth === 0) break
      }
      if (depth === 0) { found.push(command.slice(start, end)); i = end }
    }
  }
  return found
}

function skipWrapperOptions(words, index, wrapper) {
  let offset = index + 1
  const takesValue = wrapper === 'env'
    ? ['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-a', '--argv0']
    : ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type']
  while (offset < words.length) {
    const word = words[offset].value
    if (word === '--') return offset + 1
    if (wrapper === 'env' && /^[A-Za-z_]\w*=/.test(word)) { offset++; continue }
    if (takesValue.includes(word)) { offset += 2; continue }
    if (/^--[a-z][a-z-]*=/.test(word) || wrapper === 'env' && /^-[uCSa].+/.test(word) || wrapper !== 'env' && /^-[ughCpDrt].+/.test(word)) { offset++; continue }
    if (word.startsWith('-') && word !== '-') { offset++; continue }
    break
  }
  return offset
}

function destructiveSegment(words, depth) {
  if (depth > 4 || !words.length) return false
  let index = 0
  while (index < words.length) {
    const word = words[index].value
    if (word === 'command') {
      index++
      while (words[index]?.value === '--' || /^-[pVv]+$/.test(words[index]?.value ?? '')) {
        if (/[Vv]/.test(words[index].value)) return false
        if (words[index++].value === '--') break
      }
      continue
    }
    if (['env', 'sudo', 'doas'].includes(word)) { index = skipWrapperOptions(words, index, word); continue }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ['builtin', 'time', 'nice', 'nohup'].includes(word)) { index++; continue }
    if (word === 'timeout') { index += 2; continue }
    if (word === 'stdbuf') { index++; while (words[index]?.value.startsWith('-')) index++; continue }
    if (['uv', 'poetry'].includes(word) && words[index + 1]?.value === 'run' || word === 'pnpm' && words[index + 1]?.value === 'exec' || word === 'npx' && words[index + 1]?.value === '--no-install') { index += 2; continue }
    break
  }
  const command = path.posix.basename(words[index]?.value ?? '')
  const args = words.slice(index + 1).map(word => word.value)
  let gitArgs = args
  if (command === 'git') {
    let offset = 0
    while (offset < args.length) {
      if (['-C', '-c', '--git-dir', '--work-tree', '--config-env', '--namespace'].includes(args[offset])) { offset += 2; continue }
      if (/^(?:--git-dir|--work-tree|--config-env|--namespace)=/.test(args[offset])) { offset++; continue }
      break
    }
    gitArgs = args.slice(offset)
  }
  if (['rm', 'shred', 'dd', 'wipefs', 'truncate', 'shutdown', 'reboot'].includes(command) || command.startsWith('mkfs')) return true
  if (command === 'find' && (args.includes('-delete') || ['-exec', '-execdir', '-ok'].some(flag => {
    const at = args.indexOf(flag)
    return at >= 0 && destructiveSegment(words.slice(index + at + 2), depth + 1)
  }))) return true
  if (command === 'xargs') {
    const valueOptions = ['-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '--replace', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars']
    let offset = index + 1
    while (words[offset]?.value.startsWith('-') && words[offset].value !== '-') {
      if (words[offset].value === '--') { offset++; break }
      offset += valueOptions.includes(words[offset].value) ? 2 : 1
    }
    if (destructiveSegment(words.slice(offset), depth + 1)) return true
  }
  if (command === 'rsync' && args.some(arg => arg.startsWith('--delete'))) return true
  if (command === 'git' && gitArgs[0] === 'push' && gitArgs.slice(1).some(arg => ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete'].includes(arg) || /^--(?:force-with-lease|force-if-includes|force|mirror|delete)=/.test(arg) || /^-[A-Za-z]*[fd]/.test(arg) || arg.startsWith('+') || arg.startsWith(':'))) return true
  if (command === 'git' && gitArgs[0] === 'clean' && gitArgs.slice(1).some(arg => arg === '--force' || /^-[A-Za-z]*f/.test(arg))) return true
  if (command === 'git' && gitArgs[0] === 'reset' && gitArgs.some(arg => ['--hard', '--keep', '--merge'].includes(arg))) return true
  if (command === 'git' && gitArgs[0] === 'config') {
    const options = gitArgs.slice(1)
    if (options.some(arg => ['--unset', '--unset-all', '--remove-section', '--rename-section', '--add', '--replace-all', '--edit'].includes(arg))) return true
    if (!options.some(arg => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch'].includes(arg)) && options.filter(arg => !arg.startsWith('-')).length >= 2) return true
  }
  if (['sh', 'bash', 'zsh'].includes(command)) {
    const at = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
    if (at >= 0 && words[index + at + 2]?.quoted && destructiveShell(args[at + 1], depth + 1)) return true
  }
  if (command === 'eval' && words[index + 1]?.quoted && destructiveShell(args[0], depth + 1)) return true
  return false
}

function destructiveShell(command, depth = 0) {
  if (typeof command !== 'string' || depth > 4) return false
  if (/\bcd\s+(?:[^\s;]*\/)?\.git(?:\/[^\s;]*)?\s*(?:&&|;|\n)[^;\n]*(?:>|\btee\b|\bsed\s+-i\b|\bcp\b|\bmv\b)/.test(command)) return true
  if (/\b(?:curl|wget)\b[^|\n]*\|\s*(?:(?:\/[\w.-]+)*\/?(?:env|command|sudo|doas)\s+(?:(?:-[\w-]+|[A-Za-z_]\w*=\S+)\s+)*)*(?:\/[\w.-]+)*\/?(?:sh|bash|zsh|python|node|perl)\b/.test(command) || /\b(?:\/[\w.-]+)*\/?(?:sh|bash|zsh|python|node|perl)\s+<\(\s*(?:curl|wget)\b/.test(command)) return true
  if (embeddedCommands(command).some(inner => destructiveShell(inner, depth + 1))) return true
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

function containsDirectory(text, directory) {
  return !!directory && path.isAbsolute(directory) && (text.includes(`${path.normalize(directory)}/`) || text.includes(`${path.normalize(directory)}"`))
}

function namesDeckControl(input) {
  const text = JSON.stringify(input ?? {})
  const configuredState = process.env.XDG_STATE_HOME
  const deckState = configuredState && path.isAbsolute(configuredState) ? path.join(configuredState, 'fleetmates', 'deck') : null
  const configuredConfig = process.env.XDG_CONFIG_HOME
  const deckConfig = configuredConfig && path.isAbsolute(configuredConfig) ? path.join(configuredConfig, 'fleetmates', 'deck') : null
  const configuredRuntime = process.env.XDG_RUNTIME_DIR
  const deckRuntime = configuredRuntime && path.isAbsolute(configuredRuntime) ? path.join(configuredRuntime, 'fleetmates-deck') : null
  const deckPort = process.env.DECK_PORT ?? '47800'
  return containsDirectory(text, deckState) || containsDirectory(text, deckConfig) || containsDirectory(text, deckRuntime)
    || /(?:\.local\/state|\.config)\/fleetmates\/deck(?:\/|\b)/.test(text)
    || /(?:\$XDG_RUNTIME_DIR|\/run\/user\/\d+)\/fleetmates-deck(?:\/|\b)/.test(text)
    || /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?\/api(?:\/|\b)/i.test(text)
    || (text.includes(`:${deckPort}`) && /(?:127\.0\.0\.1|localhost|\[::1\]):\d+\b/i.test(text))
    || /systemctl\s+--user\s+[^"']*fleetmates-deck/.test(text)
}

function canonicalExistingPath(location) {
  let current = path.resolve(location)
  const missing = []
  for (;;) {
    try { return path.join(realpathSync(current), ...missing.reverse()) }
    catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(location)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function namesRelativeDeckControl(hook) {
  const namesControl = (value, shell = false) => {
    if (typeof value !== 'string' || !value) return false
    const state = process.env.XDG_STATE_HOME
    const expanded = shell && state && path.isAbsolute(state) ? value.replace(/^\$(?:XDG_STATE_HOME|\{XDG_STATE_HOME\})(?=\/)/, state) : value
    if (/[$*?`]/.test(expanded)) return false
    if (path.isAbsolute(expanded)) return namesDeckControl({ path: canonicalExistingPath(expanded) })
    return path.isAbsolute(hook.cwd ?? '') && namesDeckControl({ path: canonicalExistingPath(path.resolve(hook.cwd, expanded)) })
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(hook.tool_name)) {
    return namesControl(hook.tool_input?.file_path ?? hook.tool_input?.notebook_path)
  }
  if (hook.tool_name !== 'Bash' || typeof hook.tool_input?.command !== 'string') return false
  const tokens = shellTokens(hook.tool_input.command)
  let segment = []
  const accessesControl = words => {
    let index = 0
    while (words[index]) {
      const wrapper = path.posix.basename(words[index].value)
      if (['env', 'sudo', 'doas'].includes(wrapper)) { index = skipWrapperOptions(words, index, wrapper); continue }
      if (/^[A-Za-z_]\w*=/.test(words[index].value) || ['command', 'builtin'].includes(wrapper)) { index++; continue }
      break
    }
    const command = path.posix.basename(words[index]?.value ?? '')
    if (['echo', 'printf'].includes(command) && !words.some(word => ['>', '>>', '<', '<<'].includes(word.value))) return false
    return words.slice(index + 1).some(word => !word.value.startsWith('-') && namesControl(word.value, true))
  }
  for (const token of tokens) {
    if (token.separator) {
      if (accessesControl(segment)) return true
      segment = []
    } else segment.push(token)
  }
  return accessesControl(segment)
}

function sensitiveWrite(hook, repoRoot) {
  const tool = hook.tool_name
  const fileTool = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)
  if (!fileTool && tool !== 'Bash') return false
  const raw = fileTool ? hook.tool_input?.file_path ?? hook.tool_input?.notebook_path ?? '' : hook.tool_input?.command ?? ''
  if (typeof raw !== 'string') return false
  const location = fileTool ? canonicalExistingPath(path.resolve(hook.cwd ?? repoRoot ?? '', raw)) : null
  const normalized = (location ?? raw).replaceAll('\\', '/')
  if (/(?:^|[^A-Za-z0-9_.-])\.git\//.test(normalized)) return true
  if (/(?:^|\/)\.claude\/(?:settings[^/]*\.json|hooks\/)/.test(normalized)) return true
  if (/(?:^|\/)\.mcp\.json(?:\b|$)/.test(normalized)) return true
  if (!fileTool || path.posix.basename(normalized) !== 'CLAUDE.md') return false
  if (!repoRoot) return true
  const root = canonicalExistingPath(path.resolve(repoRoot))
  return location !== path.join(root, 'CLAUDE.md') && !location.startsWith(`${root}${path.sep}`)
}

/** Classify a permission conservatively; unknown commands remain Caution. */
export function permissionTier(hook, { repoRoot } = {}) {
  if (namesDeckControl(hook.tool_input) || namesRelativeDeckControl(hook) || sensitiveWrite(hook, repoRoot)) return 'destructive'
  const mcpTool = /^mcp__.+?__(.+)$/.exec(hook.tool_name ?? '')?.[1]
  if (mcpTool && /delete|remove|drop|destroy|purge|truncate|wipe|reset/i.test(mcpTool)) return 'destructive'
  if (hook.tool_name === 'Bash' && destructiveShell(hook.tool_input?.command)) return 'destructive'
  return 'caution'
}

function notificationToolName(message) {
  return typeof message === 'string' ? message.match(/\bAllow\s+(Bash|Write|Edit|Read|MultiEdit|NotebookEdit|Glob|Grep|WebFetch|WebSearch|Task|Skill)\b/i)?.[1] ?? null : null
}

function notificationMatchesTool(message, toolName, input) {
  const named = notificationToolName(message)
  if (named && (!toolName || named.toLowerCase() !== toolName.toLowerCase())) return false
  const target = typeof message === 'string' ? message.match(/\bAllow\s+[A-Za-z]\w*\s+to\s+(.+)\?$/i)?.[1]?.trim().replace(/^['"`]|['"`]$/g, '') : null
  if (!target) return true
  return target === (input?.file_path ?? input?.notebook_path ?? input?.path)
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
    const toolName = source === 'notification' ? notificationToolName(hook.message) : hook.tool_name ?? null
    if (source === 'notification') {
      const recent = store.all('SELECT source, summary, tool_name, detail FROM requests WHERE session_id = ? AND kind = ? AND state = ? AND created_at BETWEEN ? AND ?', session.id, 'permission', 'open', at - 2000, at + 2000).some(row => row.source === 'notification' ? row.summary === (hook.message ?? 'Needs your answer') : row.source === 'permission_request' && notificationMatchesTool(hook.message, row.tool_name, JSON.parse(row.detail)))
      if (recent) return false
    }
    const summary = source === 'notification' ? hook.message ?? 'Needs your answer' : toolName ? `${toolName}: ${JSON.stringify(hook.tool_input ?? {}).slice(0, 160)}` : hook.message ?? 'Needs your answer'
    if (source === 'permission_request') {
      const fallback = store.all('SELECT id, summary FROM requests WHERE session_id = ? AND kind = ? AND state = ? AND source = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC', session.id, 'permission', 'open', 'notification', at - 2000, at + 2000).find(row => notificationMatchesTool(row.summary, toolName, hook.tool_input))
      if (fallback) {
        store.run('UPDATE requests SET source = ?, tool_name = ?, summary = ?, detail = ?, match_key = ?, tier = ? WHERE id = ?', source, hook.tool_name, summary, JSON.stringify(hook.tool_input ?? {}), key, permissionTier(hook, { repoRoot: session.repo_id }), fallback.id)
        return true
      }
    }
    store.run('INSERT INTO requests(id, session_id, kind, tier, tool_name, summary, detail, options, state, source, match_key, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', randomUUID(), session.id, kind, kind === 'permission' ? permissionTier(hook, { repoRoot: session.repo_id }) : null, toolName, summary, JSON.stringify(hook.tool_input ?? {}), JSON.stringify(hook.tool_input?.questions?.[0]?.options ?? []), 'open', source, key, at)
    return true
  }
  if (['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) {
    const row = store.get('SELECT id FROM requests WHERE session_id = ? AND state = ? AND match_key = ? ORDER BY created_at LIMIT 1', session.id, 'open', key)
      ?? store.all('SELECT id, summary FROM requests WHERE session_id = ? AND kind = ? AND state = ? AND source = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC', session.id, 'permission', 'open', 'notification', at - 2000, at).find(candidate => notificationToolName(candidate.summary) && notificationMatchesTool(candidate.summary, hook.tool_name, hook.tool_input))
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
