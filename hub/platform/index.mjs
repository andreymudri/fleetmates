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

// The variables Windows programs expect from the system environment. child_process adds them on its
// own; node-pty passes the env as given.
const WINDOWS_BASE_VARS = ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'ComSpec', 'PATHEXT']

/**
 * The environment to hand a Windows child. POSIX: `env` itself. win32: a new object with one key per
 * case-insensitive name (a later key in `env` replaces an earlier one, so `Path` then `PATH` keeps
 * `PATH`), plus each Windows base variable `env` lacks, looked up case-insensitively in `base`.
 * @param {Record<string, string | undefined>} env
 * @param {{ base?: Record<string, string | undefined>, platform?: string }} [opts]
 * @returns {Record<string, string | undefined>}
 */
export function windowsChildEnv (env, { base = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return env
  /** @type {Record<string, string | undefined>} */
  const out = {}
  /** @type {Map<string, string>} */
  const keyOf = new Map()
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    const previous = keyOf.get(upper)
    if (previous !== undefined) delete out[previous]
    keyOf.set(upper, key)
    out[key] = value
  }
  for (const name of WINDOWS_BASE_VARS) {
    if (keyOf.has(name.toUpperCase())) continue
    const value = envValue(base, name.toUpperCase())
    if (value !== undefined) out[name] = value
  }
  return out
}

/**
 * The error a no-follow open throws for a symbolic link, or for a name that changed under it.
 * @param {string} file
 */
function loopError (file) {
  return Object.assign(new Error(`ELOOP: refusing to open ${file}: it is a symbolic link or changed while being opened`), {
    code: 'ELOOP', syscall: 'open', path: file,
  })
}

/** Whether two bigint stats name the same file. */
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

/**
 * The flags a win32 no-follow open passes to open: `O_TRUNC` waits for the check (ftruncate after
 * it), and a name lstat did not find is created exclusively, so a symlink planted in between fails
 * the open instead of being followed.
 * @param {number} flags
 * @param {boolean} missing
 */
function win32OpenFlags (flags, missing) {
  const { O_EXCL = 0, O_TRUNC = 0 } = fs.constants
  return missing ? (flags & ~O_TRUNC) | O_EXCL : flags & ~O_TRUNC
}

/**
 * Open `file` without following a symbolic link at its last component, returning an fd. POSIX adds
 * `O_NOFOLLOW`. win32 has no `O_NOFOLLOW`: it lstats the name and refuses a symbolic link with
 * ELOOP, opens, then fstats the fd and refuses (closing it) when its dev and ino differ from the
 * lstat. On win32 `O_TRUNC` is applied with ftruncate after that check, and a name missing under
 * `O_CREAT` is created with `O_EXCL` and lstat after the open.
 * @param {string} file
 * @param {number} [flags]
 * @param {{ platform?: string, fs?: any, mode?: number }} [opts]
 * @returns {number}
 */
export function openNoFollowSync (file, flags = fs.constants.O_RDONLY, { platform = process.platform, fs: fsImpl = fs, mode } = {}) {
  if (platform !== 'win32') return fsImpl.openSync(file, flags | fs.constants.O_NOFOLLOW, mode)
  let before = null
  try {
    before = fsImpl.lstatSync(file, { bigint: true })
  } catch (err) {
    if (err.code !== 'ENOENT' || !(flags & (fs.constants.O_CREAT ?? 0))) throw err
  }
  if (before?.isSymbolicLink()) throw loopError(file)
  const fd = fsImpl.openSync(file, win32OpenFlags(flags, before === null), mode)
  try {
    const seen = before ?? fsImpl.lstatSync(file, { bigint: true })
    if (seen.isSymbolicLink() || !sameFile(seen, fsImpl.fstatSync(fd, { bigint: true }))) throw loopError(file)
    if (before !== null && (flags & (fs.constants.O_TRUNC ?? 0))) fsImpl.ftruncateSync(fd, 0)
  } catch (err) {
    fsImpl.closeSync(fd)
    throw err
  }
  return fd
}

/**
 * `openNoFollowSync` returning a `FileHandle`; an injected `fs` supplies `fs.promises`.
 * @param {string} file
 * @param {number} [flags]
 * @param {{ platform?: string, fs?: any, mode?: number }} [opts]
 * @returns {Promise<import('node:fs/promises').FileHandle>}
 */
export async function openNoFollow (file, flags = fs.constants.O_RDONLY, { platform = process.platform, fs: fsImpl = fs, mode } = {}) {
  const fsp = fsImpl.promises
  if (platform !== 'win32') return fsp.open(file, flags | fs.constants.O_NOFOLLOW, mode)
  let before = null
  try {
    before = await fsp.lstat(file, { bigint: true })
  } catch (err) {
    if (err.code !== 'ENOENT' || !(flags & (fs.constants.O_CREAT ?? 0))) throw err
  }
  if (before?.isSymbolicLink()) throw loopError(file)
  const handle = await fsp.open(file, win32OpenFlags(flags, before === null), mode)
  try {
    const seen = before ?? await fsp.lstat(file, { bigint: true })
    if (seen.isSymbolicLink() || !sameFile(seen, await handle.stat({ bigint: true }))) throw loopError(file)
    if (before !== null && (flags & (fs.constants.O_TRUNC ?? 0))) await handle.truncate(0)
  } catch (err) {
    await handle.close()
    throw err
  }
  return handle
}

const INPUT_MODE_SEQUENCES = ['\x1b[?9001h', '\x1b[?9001l']
const INPUT_MODE_RE = /\x1b\[\?9001[hl]/g

/**
 * The length of the longest tail of `s` that is a proper prefix of a win32-input-mode sequence.
 * @param {string} s
 * @returns {number}
 */
function inputModePrefixLength (s) {
  for (let n = Math.min(s.length, INPUT_MODE_SEQUENCES[0].length - 1); n > 0; n--) {
    const tail = s.slice(-n)
    if (INPUT_MODE_SEQUENCES.some(seq => seq.startsWith(tail))) return n
  }
  return 0
}

/**
 * A stateful filter for one output stream. win32: removes every `ESC[?9001h` and `ESC[?9001l`
 * (ConPTY's win32-input-mode switch), holding back an incomplete prefix at the end of a chunk and
 * emitting it with the next chunk when it turns out not to be one. POSIX: the identity.
 * @param {{ platform?: string }} [opts]
 * @returns {(chunk: string) => string}
 */
export function createInputModeFilter ({ platform = process.platform } = {}) {
  if (platform !== 'win32') return chunk => chunk
  let carry = ''
  return chunk => {
    let s = carry + chunk
    // Removing one sequence can join its neighbours into another; repeat until none is left.
    for (let prev = ''; prev !== s;) {
      prev = s
      s = s.replace(INPUT_MODE_RE, '')
    }
    const held = inputModePrefixLength(s)
    carry = s.slice(s.length - held)
    return s.slice(0, s.length - held)
  }
}
