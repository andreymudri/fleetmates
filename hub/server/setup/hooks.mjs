import fs from 'node:fs'
import path from 'node:path'

/** Events observed by the deck hook. */
export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'CwdChanged', 'PreCompact', 'PostCompact', 'WorktreeCreate', 'WorktreeRemove']

/** Check whether a command names a deck hook script. */
export function isDeckHook(command) {
  return typeof command === 'string' && /(?:^|[/\\])deck-hook\.mjs(?:[\s'" ]|$)/.test(command) && command.includes('fleetmates-deck')
}

/** Merge or remove deck hooks without moving unrelated groups. */
export function transformHooks(settings, command, remove = false) {
  const result = structuredClone(settings)
  if (!result.hooks || typeof result.hooks !== 'object' || Array.isArray(result.hooks)) result.hooks = {}
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(result.hooks[event]) ? result.hooks[event] : []
    let found = false
    const next = []
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) { next.push(group); continue }
      const hooks = []
      for (const hook of group.hooks) {
        if (isDeckHook(hook?.command)) {
          if (!remove && !found && group.matcher === '*') {
            hooks.push({ type: 'command', command, async: true, timeout: 5 })
            found = true
          }
        } else hooks.push(hook)
      }
      if (hooks.length || (!remove && group.hooks.length === 0)) next.push({ ...group, hooks })
    }
    if (!remove && !found) next.push({ matcher: '*', hooks: [{ type: 'command', command, async: true, timeout: 5 }] })
    if (next.length) result.hooks[event] = next
    else delete result.hooks[event]
  }
  if (remove && Object.keys(result.hooks).length === 0) delete result.hooks
  return result
}

/** Read Claude Code settings before any setup write. */
export function readSettings(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settings must be a JSON object')
    return { raw, value, mode: fs.statSync(file).mode & 0o777 }
  } catch (error) {
    if (error.code === 'ENOENT') return { raw: null, value: {}, mode: 0o600 }
    throw error
  }
}

/** Back up and atomically write settings only when the JSON changes. */
export function writeSettings(file, current, next) {
  if (JSON.stringify(current.value) === JSON.stringify(next)) return null
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  let backup = null
  if (current.raw !== null) {
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
    backup = `${file}.deck-backup-${timestamp}`
    let suffix = 0
    while (fs.existsSync(backup)) backup = `${file}.deck-backup-${timestamp}-${++suffix}`
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(backup, current.mode)
  }
  const temp = `${file}.deck-${process.pid}-${Date.now()}.tmp`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: current.mode, flag: 'wx' })
    fs.chmodSync(temp, current.mode)
    fs.renameSync(temp, file)
    JSON.parse(fs.readFileSync(file, 'utf8'))
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
  return backup
}

/** Check that every subscribed event has the installed command. */
export function hooksInstalled(settings, command) {
  return HOOK_EVENTS.every(event => Array.isArray(settings.hooks?.[event]) && settings.hooks[event].some(group => group.matcher === '*' && group.hooks?.some(hook => hook.command === command && hook.async === true)))
}
