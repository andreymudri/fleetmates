import fs from 'node:fs'
import path from 'node:path'

/** Observation events installed by setup. */
export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'CwdChanged', 'PreCompact', 'PostCompact']

const lifecycleEvents = ['WorktreeCreate', 'WorktreeRemove']

function shellWords(command) {
  const words = []
  let word = ''
  let quote = null
  let started = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      if (char === quote) quote = null
      else if (quote === '"' && char === '\\') {
        if (++i === command.length) return null
        word += command[i]
      } else if (quote === '"' && (char === '$' || char === '`')) return null
      else word += char
    } else if (char === "'" || char === '"') { quote = char; started = true }
    else if (char === '\\') {
      if (++i === command.length) return null
      word += command[i]
      started = true
    } else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false }
    } else if (/[;&|<>`$()]/.test(char)) return null
    else { word += char; started = true }
  }
  if (quote) return null
  if (started) words.push(word)
  return words
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`

/**
 * The hook command `init` and the web server both install: each word single-quoted, which survives
 * spaces, quotes and `$` in either path (a double-quoted `$` would expand).
 */
export function deckHookCommand(execPath, hookPath) {
  return `${shellQuote(execPath)} ${shellQuote(hookPath)}`
}

/**
 * Whether two hook commands run the same argv, whatever their quoting: an install written by an
 * older build (`"<node>" "<hook>"` from the web server) matches the canonical single-quoted form.
 */
function sameCommand(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a === b) return true
  const x = shellWords(a)
  const y = shellWords(b)
  return !!x && !!y && x.length === y.length && x.every((word, i) => word === y[i])
}

/** Check whether a command names a deck hook script. */
export function isDeckHook(command, installedCommand) {
  if (typeof command !== 'string' || /[\r\n]/.test(command)) return false
  const words = shellWords(command)
  if (words?.length !== 2) return false
  const [node, script] = words
  const knownNode = node === process.execPath || ['node', 'nodejs'].includes(node) || (path.isAbsolute(node) && ['node', 'nodejs'].includes(path.basename(node)))
  return (knownNode || sameCommand(command, installedCommand)) && path.isAbsolute(script) && /\/(?:hub|fleetmates-deck)\/hook\/deck-hook\.mjs$/.test(script)
}

/** Merge or remove deck hooks without moving unrelated groups. */
export function transformHooks(settings, command, remove = false) {
  const result = structuredClone(settings)
  if (!result.hooks || typeof result.hooks !== 'object' || Array.isArray(result.hooks)) result.hooks = {}
  for (const event of [...HOOK_EVENTS, ...lifecycleEvents]) {
    const install = !remove && HOOK_EVENTS.includes(event)
    if (!install && !Array.isArray(result.hooks[event])) continue
    const groups = Array.isArray(result.hooks[event]) ? result.hooks[event] : []
    let found = false
    const next = []
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) { next.push(group); continue }
      const hooks = []
      let touched = false
      for (const hook of group.hooks) {
        if (hook?.type === 'command' && isDeckHook(hook.command, command)) {
          touched = true
          if (install && !found && group.matcher === '*') {
            hooks.push({ type: 'command', command, async: true, timeout: 5 })
            found = true
          }
        } else hooks.push(hook)
      }
      if (!touched || hooks.length) next.push({ ...group, hooks })
    }
    if (install && !found) next.push({ matcher: '*', hooks: [{ type: 'command', command, async: true, timeout: 5 }] })
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
  if (lifecycleEvents.some(event => Array.isArray(settings.hooks?.[event]) && settings.hooks[event].some(group => Array.isArray(group?.hooks) && group.hooks.some(hook => hook?.type === 'command' && isDeckHook(hook.command, command))))) return false
  return HOOK_EVENTS.every(event => Array.isArray(settings.hooks?.[event]) && settings.hooks[event].some(group => group.matcher === '*' && group.hooks?.some(hook => sameCommand(hook?.command, command) && hook.async === true)))
}

/**
 * The `hooks` health row's state, with the rules of the doctor hooks check: the settings file lists `command`
 * for every observation event, and the hook script is a readable regular file. An unreadable or invalid
 * settings file counts as hooks missing.
 * @param {{ settings: string, hook: string }} paths
 * @param {string} command the installed hook command (`deckHookCommand`)
 * @returns {{ state: 'ok' | 'down', reason: null | 'hooks_missing' | 'hook_script_missing' }}
 */
export function checkHooks(paths, command) {
  let configured = false
  try { configured = hooksInstalled(readSettings(paths.settings).value, command) } catch {}
  if (!configured) return { state: 'down', reason: 'hooks_missing' }
  try {
    if (!fs.statSync(paths.hook).isFile()) return { state: 'down', reason: 'hook_script_missing' }
    fs.accessSync(paths.hook, fs.constants.R_OK)
  } catch { return { state: 'down', reason: 'hook_script_missing' } }
  return { state: 'ok', reason: null }
}
