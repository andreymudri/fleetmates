// Platform differences for the deck in one place: runtime paths, IPC endpoints, private files,
// process trees and commands. Every function takes its platform inputs as options defaulting to the
// live process, so tests can pin linux, darwin and win32 on any host. Imports only node: modules.
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENDPOINT_NAMES = new Set(['deckd', 'hooks'])
const MAX_SOCKET_BYTES = 100
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
const currentUid = () => process.getuid?.() ?? null
const octal = mode => (mode & 0o777).toString(8).padStart(4, '0')

/**
 * The directory the deck's runtime dir lives under.
 * @param {{ env?: Record<string, string | undefined>, platform?: string, uid?: number | null, home?: string }} [opts]
 * @returns {string}
 */
export function runtimeBase ({ env = process.env, platform = process.platform, uid = currentUid(), home = env.HOME || os.homedir() } = {}) {
  if (typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR !== '') return env.XDG_RUNTIME_DIR
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Caches', 'fleetmates-deck')
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'fleetmates-deck', 'run')
  return `/tmp/fleetmates-deck-${uid}`
}

/**
 * @param {string} base
 * @param {{ platform?: string }} [opts]
 * @returns {string}
 */
export function deckDir (base, { platform = process.platform } = {}) {
  return (platform === 'win32' ? path.win32 : path.posix).join(base, 'fleetmates-deck')
}

/**
 * The deckd or hooks endpoint: a Unix socket on POSIX, a named pipe on win32.
 * @param {string} base
 * @param {'deckd' | 'hooks'} name
 * @param {{ platform?: string, uid?: number | null }} [opts]
 * @returns {string}
 */
export function endpoint (base, name, { platform = process.platform, uid = currentUid() } = {}) {
  if (!ENDPOINT_NAMES.has(name)) throw new Error(`unknown endpoint name ${JSON.stringify(name)}; expected deckd or hooks`)
  if (platform === 'win32') {
    const h = createHash('sha256').update(path.win32.resolve(base).toLowerCase()).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\fleetmates-deck-${h}-${name}`
  }
  const sock = path.posix.join(deckDir(base, { platform }), `${name}.sock`)
  if (Buffer.byteLength(sock) > MAX_SOCKET_BYTES) return `/tmp/fleetmates-deck-${uid}/${name}.sock`
  return sock
}

/**
 * @param {string} endpointPath
 * @returns {boolean}
 */
export function isPipe (endpointPath) {
  return endpointPath.startsWith('\\\\.\\pipe\\') || endpointPath.startsWith('\\\\?\\pipe\\')
}

/**
 * Create `dir` (0700) and, on POSIX, refuse it when another user owns it or it has any group or
 * world permission bit.
 * @param {string} dir
 * @param {{ platform?: string, uid?: number | null }} [opts]
 */
export async function ensurePrivateDir (dir, { platform = process.platform, uid = currentUid() } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (platform === 'win32') return
  const st = await stat(dir)
  if (uid !== null && uid !== undefined && st.uid !== uid) {
    throw new Error(`runtime dir ${dir} is owned by uid ${st.uid}, not by this user`)
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`runtime dir ${dir} has mode ${octal(st.mode)}; it must allow no group or world access (0700)`)
}

/**
 * Why a file that should be private is not, or null.
 * @param {{ uid: number, mode: number }} st
 * @param {{ platform?: string, uid?: number | null, mode?: number }} [opts]
 * @returns {string | null}
 */
export function privateFileProblem (st, { platform = process.platform, uid = currentUid(), mode = 0o600 } = {}) {
  if (platform === 'win32') return null
  if (uid !== null && uid !== undefined && st.uid !== uid) return `owned by uid ${st.uid}, not by this user`
  if ((st.mode & 0o777) !== mode) return `has mode ${octal(st.mode)}; it must be ${octal(mode)}`
  return null
}

/**
 * Signal a process and its descendants. POSIX signals the group first; macOS can refuse a dying
 * group while its owned PID is still signalable, so EPERM falls back to the PID. win32 runs
 * `taskkill /T /F` whatever the signal.
 * @param {number} pid
 * @param {NodeJS.Signals} [signal]
 * @param {{ platform?: string, kill?: typeof process.kill, spawnSync?: typeof childProcess.spawnSync }} [opts]
 */
export function killTree (pid, signal = 'SIGTERM', { platform = process.platform, kill = process.kill, spawnSync = childProcess.spawnSync } = {}) {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    kill(-pid, signal)
  } catch (err) {
    if (err.code === 'ESRCH') return
    if (err.code !== 'EPERM') throw err
    try {
      kill(pid, signal)
    } catch (pidError) {
      if (pidError.code !== 'ESRCH') throw pidError
    }
  }
}

/** The value of `key` in an env object, matched case-insensitively as Windows does. */
function envValue (env, key) {
  if (env[key] !== undefined) return env[key]
  const found = Object.keys(env).find(k => k.toUpperCase() === key)
  return found === undefined ? undefined : env[found]
}

/**
 * Resolve a bare command name to a file on win32 by searching PATH with PATHEXT.
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, platform?: string, exists?: (p: string) => boolean }} [opts]
 * @returns {string}
 */
export function resolveCommand (name, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return name
  if (/[\\/]/.test(name) || path.win32.extname(name) !== '') return name
  const dirs = (envValue(env, 'PATH') || '').split(';').filter(Boolean)
  const exts = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').filter(Boolean).map(ext => ext.toLowerCase())
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.win32.join(dir, name + ext)
      if (exists(candidate)) return candidate
    }
  }
  return name
}

/**
 * Quote one argument for `cmd.exe /d /s /c`, as cross-spawn does: escape double quotes and the
 * backslashes before them and at the end (CommandLineToArgvW), quote, then caret-escape cmd metacharacters.
 * @param {string} arg
 * @returns {string}
 */
export function quoteCmdArg (arg) {
  let s = String(arg)
  s = s.replace(/(\\*)"/g, '$1$1\\"')
  s = s.replace(/(\\*)$/, '$1$1')
  s = `"${s}"`
  return s.replace(/([()%!^"<>&|])/g, '^$1')
}

/**
 * Escape the command (first token) of a `cmd.exe /d /s /c` line, as cross-spawn's escapeCommand does:
 * caret-escape every cmd metacharacter, the space included, and do not quote it. A quoted command
 * would make cmd.exe take `"C:\Program` as the program.
 * @param {string} file
 * @returns {string}
 */
export function escapeCmdCommand (file) {
  return String(file).replace(/([()\][%!^"`<>&|;, *?])/g, '^$1')
}

// The invocation line of an npm cmd-shim, matched per line (m flag, CRLF tolerated by \s*$).
// Node: `"%_prog%"` or a quoted `%dp0%\node.exe`, then exactly one quoted %dp0% script, then `%*`,
// optionally after the shim's `endLocal & ... & ` prefix. No interpreter flags, nothing after `%*`.
const SHIM_NODE_LINE = /(?:^|&)[ \t]*"(%_prog%|(?:%dp0%|%~dp0)\\node\.exe)"[ \t]+"(?:%dp0%|%~dp0)\\([^"\r\n]+\.(?:js|cjs|mjs))"[ \t]+%\*\s*$/im
// Exe: a line that is only a quoted %dp0% exe followed by `%*`.
const SHIM_EXE_LINE = /^[ \t]*"(?:%dp0%|%~dp0)\\([^"\r\n]+\.exe)"[ \t]+%\*\s*$/im
const SHIM_PROG = /SET "_prog=([^"\r\n]*)"/gi
const NODE_PROG = /^(?:node|(?:%dp0%|%~dp0)\\node\.exe)$/i

/**
 * What an npm cmd-shim `.cmd` runs, resolved against the shim's directory.
 * `{ kind: 'node', script }` when the invocation line runs node (`"%_prog%"` where every
 * `SET "_prog=..."` names node, or a quoted `%dp0%\node.exe`) on exactly one quoted .js, .cjs or .mjs
 * script followed by `%*`. Otherwise `{ kind: 'exe', file }` when a line is only a quoted
 * `%dp0%\...exe` followed by `%*`. Null for anything else: shims for other interpreters (sh,
 * python), node with interpreter flags, extra arguments, or a file that cannot be read.
 * @param {string} file
 * @param {{ readFile?: (p: string, enc: string) => string }} [opts]
 * @returns {{ kind: 'node', script: string } | { kind: 'exe', file: string } | null}
 */
export function unwrapCmdShim (file, { readFile = fs.readFileSync } = {}) {
  let text
  try {
    text = String(readFile(file, 'utf8'))
  } catch {
    return null
  }
  const dir = path.win32.dirname(file)
  const node = SHIM_NODE_LINE.exec(text)
  if (node) {
    const progs = [...text.matchAll(SHIM_PROG)].map(m => m[1])
    const runsNode = node[1].toLowerCase() !== '%_prog%' || (progs.length > 0 && progs.every(p => NODE_PROG.test(p)))
    if (runsNode) return { kind: 'node', script: path.win32.resolve(dir, node[2]) }
  }
  const exe = SHIM_EXE_LINE.exec(text)
  if (exe) return { kind: 'exe', file: path.win32.resolve(dir, exe[1]) }
  return null
}

// cmd.exe re-parses a batch file's %* after the caret escapes are gone, so these cannot be passed
// to a .cmd or .bat safely (CVE-2024-27980); a line feed also truncates the argument.
const UNSAFE_CMD_CHARS = /["\r\n%]/

/**
 * The file, argv and spawn options to run `file` with `args`. On win32 an npm cmd-shim `.cmd` runs
 * its JS entry with node, or its native .exe target, directly; any other `.cmd` or `.bat` runs through
 * cmd.exe (command escaped by escapeCmdCommand, arguments quoted by quoteCmdArg) and refuses an
 * argument containing `"`, CR, LF or `%` with code `unsafe_cmd_arg`.
 * @param {string} file
 * @param {string[]} args
 * @param {{ platform?: string, env?: Record<string, string | undefined>, nodePath?: string, readFile?: (p: string, enc: string) => string }} [opts]
 * @returns {{ file: string, args: string[], options: Record<string, boolean> }}
 */
export function commandSpawn (file, args, { platform = process.platform, env = process.env, nodePath, readFile = fs.readFileSync } = {}) {
  if (platform !== 'win32') return { file, args, options: {} }
  if (/\.cmd$/i.test(file)) {
    const shim = unwrapCmdShim(file, { readFile })
    if (shim?.kind === 'node') return { file: nodePath ?? process.execPath, args: [shim.script, ...args], options: { windowsHide: true } }
    if (shim?.kind === 'exe') return { file: shim.file, args, options: { windowsHide: true } }
  }
  if (/\.(cmd|bat)$/i.test(file)) {
    const bad = args.findIndex(arg => UNSAFE_CMD_CHARS.test(String(arg)))
    if (bad !== -1) {
      throw Object.assign(new Error(`argument ${bad} contains a double quote, CR, LF or % that cmd.exe cannot pass safely to a .cmd or .bat file`), { code: 'unsafe_cmd_arg' })
    }
    return {
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', '"' + [escapeCmdCommand(file), ...args.map(arg => quoteCmdArg(arg))].join(' ') + '"'],
      options: { windowsVerbatimArguments: true, windowsHide: true },
    }
  }
  return { file, args, options: { windowsHide: true } }
}

/**
 * The argv that opens `url` in the default browser. On win32 callers pass `windowsVerbatimArguments: true`.
 * @param {string} url
 * @param {{ platform?: string }} [opts]
 * @returns {string[]}
 */
export function openUrlArgv (url, { platform = process.platform } = {}) {
  if (platform === 'darwin') return ['open', url]
  if (platform === 'win32') return ['cmd.exe', '/d', '/s', '/c', 'start', '""', quoteCmdArg(url)]
  return ['xdg-open', url]
}

/**
 * Whether `file` names the claude program.
 * @param {string} file
 * @param {{ platform?: string }} [opts]
 * @returns {boolean}
 */
export function isClaudeProgram (file, { platform = process.platform } = {}) {
  if (platform === 'win32') return ['claude', 'claude.exe', 'claude.cmd'].includes(path.win32.basename(file).toLowerCase())
  return path.posix.basename(file) === 'claude'
}
