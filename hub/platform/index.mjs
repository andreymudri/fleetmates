// Platform differences for the deck in one place: runtime paths, IPC endpoints, private files,
// process trees and commands. Every function takes its platform inputs as options defaulting to the
// live process, so tests can pin linux, darwin and win32 on any host. Imports only node: modules.
import childProcess from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
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
 * The directory the deck's runtime dir lives under. A set XDG_RUNTIME_DIR wins on win32 as well (tests
 * set it); the win32 endpoint keys then live wherever it points rather than under %LOCALAPPDATA%, and
 * nothing here checks who can read that directory.
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

// win32 endpoint keys: one per endpoint, `<deckDir(base)>\endpoint-<name>.key`, holding 32 random bytes
// as 64 lowercase hex digits. `endpoint-<name>.lock` names the process that serves the endpoint: it is
// taken before the key is written and, for a listening server, held until that server closes.
const SECRET_RE = /^[0-9a-f]{64}$/
const LOCK_ATTEMPTS = 10
const logLine = line => { process.stderr.write(`deck: ${line}\n`) }

/** Whether process `pid` exists (EPERM: it exists, owned by someone else). */
function defaultAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// PowerShell writes a redirected stdout in the console's code page unless told otherwise; every query
// the deck runs through it starts with this, so its output is UTF-8.
export const POWERSHELL_UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
// A CIM datetime as Win32_Process.CreationDate prints it: local date and time, microseconds, and the
// offset from UTC in minutes (yyyymmddHHMMSS.mmmmmm+UUU).
const DMTF_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/
// How far apart a lock's recorded start and its pid's creation time may be for the pid to be its holder.
const START_TOLERANCE_MS = 2000

/** When this process started, in ms since the epoch: now less its uptime. */
const ownStart = () => Math.round(Date.now() - process.uptime() * 1000)

/**
 * When process `pid` was created, in ms since the epoch: this process's own from ownStart; another's
 * from Win32_Process.CreationDate through Windows PowerShell's Get-WmiObject, which prints the raw CIM
 * datetime with its own UTC offset, converted here without any local time zone. `undefined` when no
 * such process; null when the query fails or prints anything that is not such a datetime. `pid` is a
 * positive integer (checked by the caller) before it enters the query.
 * @param {number} pid
 * @param {{ spawnSync?: typeof childProcess.spawnSync }} [opts]
 * @returns {number | undefined | null}
 */
function defaultCreationTime (pid, { spawnSync = childProcess.spawnSync } = {}) {
  if (pid === process.pid) return ownStart()
  const result = spawnSync('powershell', ['-NoProfile', '-Command',
    `${POWERSHELL_UTF8}$p=Get-WmiObject Win32_Process -Filter 'ProcessId=${pid}';if($p){$p.CreationDate}`],
  { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.error || result.status !== 0) return null
  const out = String(result.stdout ?? '').trim()
  if (out === '') return undefined
  const m = DMTF_RE.exec(out)
  if (!m) return null
  const [y, mo, d, h, mi, s, us, sign, offset] = m.slice(1)
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) + Math.floor(Number(us) / 1000)
  return local - (sign === '-' ? -1 : 1) * Number(offset) * 60000
}

function checkName (name) {
  if (!ENDPOINT_NAMES.has(name)) throw new Error(`unknown endpoint name ${JSON.stringify(name)}; expected deckd or hooks`)
}

/** The key and lock files of endpoint `name` under `base`. */
function keyPaths (base, name) {
  const dir = deckDir(base, { platform: 'win32' })
  return { dir, key: path.win32.join(dir, `endpoint-${name}.key`), lock: path.win32.join(dir, `endpoint-${name}.lock`) }
}

/** The text of `file`, opened with openNoFollowSync's win32 rules, so a symbolic link is refused with ELOOP. */
function readNoFollow (file, fsImpl) {
  const fd = openNoFollowSync(file, fs.constants.O_RDONLY, { platform: 'win32', fs: fsImpl })
  try {
    return String(fsImpl.readFileSync(fd, 'utf8'))
  } finally {
    fsImpl.closeSync(fd)
  }
}

/**
 * Read a key file.
 * @returns {{ secret: string } | { missing: true } | { bad: string }}
 */
function readEndpointKey (file, fsImpl) {
  let text
  try {
    text = readNoFollow(file, fsImpl)
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true }
    return { bad: `unreadable (${err.code ?? err.message})` }
  }
  return SECRET_RE.test(text) ? { secret: text } : { bad: 'malformed' }
}

/**
 * Write `text` to a new file named after `file` with a random suffix, created exclusively by
 * openNoFollowSync with its win32 rules (a symbolic link already at that name is refused).
 * @returns {string} the new file
 */
function writeTemp (file, text, fsImpl, random) {
  const temp = `${file}.${random(6).toString('hex')}.tmp`
  const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants
  const fd = openNoFollowSync(temp, O_WRONLY | O_CREAT | O_EXCL, { platform: 'win32', fs: fsImpl, mode: 0o600 })
  try {
    fsImpl.writeSync(fd, text)
  } finally {
    fsImpl.closeSync(fd)
  }
  return temp
}

/** Put `secret` at `file` by renaming a complete temp file over it. */
function publishKey (file, secret, fsImpl, random) {
  const temp = writeTemp(file, secret, fsImpl, random)
  try {
    fsImpl.renameSync(temp, file)
  } finally {
    try { fsImpl.unlinkSync(temp) } catch {}
  }
}

/**
 * Whether the holder a lock records is a live deck server: its pid is alive and was created within
 * START_TOLERANCE_MS of the start the lock recorded, so a pid Windows reused for a later process does
 * not hold the lock, whatever its command line. The creation time is asked for only when the pid is
 * alive. One that cannot be read counts as a deck, so a failing query refuses a start rather than
 * letting a second server run: a lock then stays held while both that pid lives and the query fails,
 * and the error names the lock file. Not excluded: a pid reused by a process created within the
 * tolerance of the holder's start, which needs the holder to die within about that long of starting.
 */
function holderIsDeck (record, { alive, creationTime }) {
  if (!record || typeof record !== 'object' || !Number.isInteger(record.pid) || record.pid <= 0 || !Number.isFinite(record.started)) return false
  if (!alive(record.pid)) return false
  const created = creationTime(record.pid)
  if (created === null) return true
  return typeof created === 'number' && Math.abs(created - record.started) <= START_TOLERANCE_MS
}

/**
 * Take the start lock of endpoint `name`: a file recording this pid and its start time, linked into place so
 * it appears whole or not at all. A lock whose holder is a live deck server (holderIsDeck) refuses
 * with EADDRINUSE and `holder`. Any other lock is stale and is moved aside with a rename, which moves
 * one file: of two starters that judged the same stale lock, the one that finds it moved a different
 * file (another starter's fresh lock) links that file back and starts over, so neither deletes the
 * other's lock. A third starter linking its own lock in the instant that file is away is not
 * excluded. Returns the release function, which removes the lock only while it is still this one,
 * and `previous`, the record of the stale lock it took over (null when there was none).
 * @returns {{ release: () => void, previous: any }}
 */
function takeLock (lock, name, { fsImpl, random, alive, creationTime }) {
  const record = JSON.stringify({ pid: process.pid, started: ownStart() })
  let previous = null
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const temp = writeTemp(lock, record, fsImpl, random)
    let linked = false
    try {
      fsImpl.linkSync(temp, lock)
      linked = true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    } finally {
      try { fsImpl.unlinkSync(temp) } catch {}
    }
    if (linked) {
      const mine = fsImpl.lstatSync(lock, { bigint: true })
      const release = () => {
        try {
          const now = fsImpl.lstatSync(lock, { bigint: true })
          if (now.ino === mine.ino && now.dev === mine.dev) fsImpl.unlinkSync(lock)
        } catch {}
      }
      return { release, previous }
    }
    let seen
    let holder = null
    try {
      seen = fsImpl.lstatSync(lock, { bigint: true })
      holder = JSON.parse(readNoFollow(lock, fsImpl))
    } catch (err) {
      if (err.code === 'ENOENT' && !seen) continue
    }
    if (holderIsDeck(holder, { alive, creationTime })) {
      throw Object.assign(new Error(`another ${name} server holds ${lock} (pid ${holder.pid})`), { code: 'EADDRINUSE', holder: holder.pid })
    }
    const aside = `${lock}.${random(6).toString('hex')}.stale`
    try {
      fsImpl.renameSync(lock, aside)
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }
    const moved = fsImpl.lstatSync(aside, { bigint: true })
    if (seen && moved.ino === seen.ino && moved.dev === seen.dev) previous = holder
    else {
      try { fsImpl.linkSync(aside, lock) } catch {}
    }
    fsImpl.unlinkSync(aside)
  }
  throw new Error(`could not take the endpoint lock ${lock}`)
}

/**
 * The secret the win32 endpoint `name` hashes, read from `<deckDir(base)>\endpoint-<name>.key`. Null off
 * win32, and on win32 null when the key is missing, is not exactly 64 lowercase hex digits, or is a
 * symbolic link. Clients call this on every connect. With `create: true` (test fixtures that stand in
 * for a server use it) a valid key is returned as it is; otherwise the start lock is taken, the key read
 * again under it (another creator may have written one since), a missing or bad one written (a bad one
 * logged), and the lock released. While a live deck server holds the lock that refuses with EADDRINUSE.
 * The deck itself starts its endpoints with `listenEndpoint`, which writes a new key every time. With
 * `liveHolder: true` (connectDeckd) a key whose lock names a pid that is not alive counts as missing: what
 * a crashed server leaves. A key without a lock is still returned (test fixtures write one).
 * @param {string} base
 * @param {{ platform?: string, name?: 'deckd' | 'hooks', create?: boolean, fs?: any, log?: (line: string) => void,
 *   random?: (n: number) => Buffer, alive?: (pid: number) => boolean, creationTime?: (pid: number) => number | undefined | null, spawnSync?: typeof childProcess.spawnSync,
 *   liveHolder?: boolean }} [opts]
 * @returns {string | null}
 */
export function endpointSecret (base, { platform = process.platform, name, create = false, liveHolder = false, fs: fsImpl = fs, log = logLine,
  random = randomBytes, alive = defaultAlive, spawnSync = childProcess.spawnSync, creationTime = pid => defaultCreationTime(pid, { spawnSync }) } = {}) {
  if (platform !== 'win32') return null
  checkName(name)
  const { dir, key, lock } = keyPaths(base, name)
  const found = readEndpointKey(key, fsImpl)
  if ('secret' in found && liveHolder) {
    let holder = null
    try {
      holder = JSON.parse(readNoFollow(lock, fsImpl))
    } catch {}
    if (Number.isInteger(holder?.pid) && holder.pid > 0 && !alive(holder.pid)) return null
  }
  if ('secret' in found) return found.secret
  if (!create) return null
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { release } = takeLock(lock, name, { fsImpl, random, alive, creationTime })
  try {
    const now = readEndpointKey(key, fsImpl)
    if ('secret' in now) return now.secret
    if ('bad' in now) log(`endpoint key ${key} is ${now.bad}; writing a new one`)
    publishKey(key, random(32).toString('hex'), fsImpl, random)
    const again = readEndpointKey(key, fsImpl)
    if ('secret' in again) return again.secret
    throw new Error(`endpoint key ${key} is ${'missing' in again ? 'missing' : again.bad} after writing it`)
  } finally {
    release()
  }
}

/**
 * Listen `server` on the win32 pipe of endpoint `name` under a new key, and return the pipe.
 *
 * Single instance: the start lock (takeLock), in the private deck dir, held for the server's
 * lifetime. While a live deck server holds it this rejects with code EADDRINUSE (`path` is the pipe
 * of the current key when there is one). Whatever answers on an old pipe name is not asked: the key
 * is always replaced, so clients leave an old name, squatted or not, at the next start.
 *
 * Order: listen on the pipe of a new random secret, then write that secret to the key file. A client
 * reads the key before it connects, so the pipe a key names is already this server's when the key
 * appears. When the key cannot be written the server is closed, the lock released and the error
 * rethrown. When the server closes, the key is removed if it is still this server's, then the lock
 * released, so clients find no key and treat the server as not running. On Windows the deck's own
 * `stop` ends the server with `taskkill /F`, which skips that close, so the service manager removes the
 * key and lock itself after the kill (dropEndpoint).
 *
 * Narrowed, not closed: a server ended any other way (a crash, logoff, a reboot, a kill outside `stop`)
 * leaves its key and lock behind. The hook and connectDeckd (so fm and the web server's deckd link)
 * treat a key whose lock names a pid that is not alive as missing, so they do not dial the dead
 * server's name. What remains: once Windows gives that pid to another process, they dial it again until
 * the next start replaces the key, and another local user who saw the name in `\\.\pipe\` and created
 * it receives what they send: hook envelopes with their tool input, fm's hello and then keystrokes. Other
 * readers of the key (setupPaths, the doctor's probe) do not check the lock.
 * @param {string} base
 * @param {'deckd' | 'hooks'} name
 * @param {import('node:net').Server} server
 * @param {{ platform?: string, fs?: any, log?: (line: string) => void, random?: (n: number) => Buffer,
 *   alive?: (pid: number) => boolean, creationTime?: (pid: number) => number | undefined | null, spawnSync?: typeof childProcess.spawnSync }} [opts]
 * @returns {Promise<string>}
 */
export async function listenEndpoint (base, name, server, { platform = process.platform, fs: fsImpl = fs, log = logLine,
  random = randomBytes, alive = defaultAlive, spawnSync = childProcess.spawnSync, creationTime = pid => defaultCreationTime(pid, { spawnSync }) } = {}) {
  if (platform !== 'win32') throw new Error('listenEndpoint names win32 pipes only')
  checkName(name)
  const { dir, key, lock } = keyPaths(base, name)
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let release
  try {
    release = takeLock(lock, name, { fsImpl, random, alive, creationTime }).release
  } catch (err) {
    const current = readEndpointKey(key, fsImpl)
    if (err.code === 'EADDRINUSE' && 'secret' in current) {
      err.path = endpoint(base, name, { platform, secret: current.secret })
      err.message = `another ${name} is listening on ${err.path} (pid ${err.holder})`
    }
    throw err
  }
  const secret = random(32).toString('hex')
  const pipe = endpoint(base, name, { platform, secret })
  try {
    const current = readEndpointKey(key, fsImpl)
    if ('bad' in current) log(`endpoint key ${key} is ${current.bad}; writing a new one`)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipe, () => { server.off('error', reject); resolve(undefined) })
    })
    try {
      publishKey(key, secret, fsImpl, random)
    } catch (err) {
      await new Promise(resolve => server.close(() => resolve(undefined)))
      throw err
    }
  } catch (err) {
    release()
    throw err
  }
  server.once('close', () => {
    try {
      if (readEndpointKey(key, fsImpl).secret === secret) fsImpl.unlinkSync(key)
    } catch {}
    release()
  })
  return pipe
}

/**
 * After the server of endpoint `name` was ended without closing (the service manager's `taskkill /F`),
 * remove its key and lock, so clients stop dialing its pipe name. Only when the lock is that server's:
 * a lock that is missing or records another pid is left alone with the key. Otherwise the lock is taken
 * over (takeLock, so a start racing this sees a live holder and refuses), the key removed if the lock
 * taken over still recorded `pid`, and the lock released. Returns whether the key was removed. Off win32
 * nothing is done. Throws EADDRINUSE while the holder still counts as a live deck server (holderIsDeck).
 * @param {string} base
 * @param {'deckd' | 'hooks'} name
 * @param {number} pid
 * @param {{ platform?: string, fs?: any, random?: (n: number) => Buffer, alive?: (pid: number) => boolean,
 *   creationTime?: (pid: number) => number | undefined | null, spawnSync?: typeof childProcess.spawnSync }} [opts]
 * @returns {boolean}
 */
export function dropEndpoint (base, name, pid, { platform = process.platform, fs: fsImpl = fs, random = randomBytes, alive = defaultAlive,
  spawnSync = childProcess.spawnSync, creationTime = pid => defaultCreationTime(pid, { spawnSync }) } = {}) {
  if (platform !== 'win32') return false
  checkName(name)
  const { key, lock } = keyPaths(base, name)
  let named = null
  try {
    named = JSON.parse(readNoFollow(lock, fsImpl))
  } catch {}
  if (named?.pid !== pid) return false
  const { release, previous } = takeLock(lock, name, { fsImpl, random, alive, creationTime })
  try {
    if (previous?.pid !== pid) return false
    try {
      fsImpl.unlinkSync(key)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    return true
  } finally {
    release()
  }
}

/**
 * The deckd or hooks endpoint: a Unix socket on POSIX, a named pipe on win32. The pipe name hashes
 * the case-folded base and `secret`, which defaults to the key read now by `endpointSecret(base, { name })`;
 * on win32 a missing secret throws with code ENOENT, and one that is not 64 lowercase hex digits throws.
 * POSIX takes no secret.
 * @param {string} base
 * @param {'deckd' | 'hooks'} name
 * @param {{ platform?: string, uid?: number | null, secret?: string | null }} [opts]
 * @returns {string}
 */
export function endpoint (base, name, { platform = process.platform, uid = currentUid(), secret } = {}) {
  if (!ENDPOINT_NAMES.has(name)) throw new Error(`unknown endpoint name ${JSON.stringify(name)}; expected deckd or hooks`)
  if (platform === 'win32') {
    const key = secret === undefined ? endpointSecret(base, { platform, name }) : secret
    if (key === null) {
      throw Object.assign(new Error(`no ${name} endpoint key under ${deckDir(base, { platform })}: its server writes one when it starts listening`), { code: 'ENOENT' })
    }
    if (typeof key !== 'string' || !SECRET_RE.test(key)) throw new Error('the endpoint secret must be 64 lowercase hex digits')
    const h = createHash('sha256').update(path.win32.resolve(base).toLowerCase() + '\0' + key).digest('hex').slice(0, 16)
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

// How many times a win32 no-follow open re-runs lstat, open and fstat when the name appears or
// disappears between the lstat and the open.
const WIN32_OPEN_ATTEMPTS = 3

/**
 * The flags a win32 no-follow open passes to open. `O_TRUNC` waits for the check (ftruncate after
 * it). A name lstat found is opened without `O_CREAT`, so a swap to a dangling symlink cannot create
 * the link's target; a name lstat did not find is created with `O_CREAT | O_EXCL`, so a symlink
 * planted in between fails the open instead of being followed.
 * @param {number} flags
 * @param {boolean} missing
 */
function win32OpenFlags (flags, missing) {
  const { O_CREAT = 0, O_EXCL = 0, O_TRUNC = 0 } = fs.constants
  return missing ? (flags & ~O_TRUNC) | O_CREAT | O_EXCL : flags & ~(O_TRUNC | O_CREAT | O_EXCL)
}

/**
 * Whether a win32 open error means the name changed between lstat and open, so the sequence is
 * worth re-running: EEXIST after a missing name, ENOENT after a found one. Only under the caller's
 * `O_CREAT` without `O_EXCL`; otherwise the error is the answer POSIX would give.
 * @param {NodeJS.ErrnoException} err
 * @param {number} flags
 * @param {boolean} missing
 */
function win32Retryable (err, flags, missing) {
  const { O_CREAT = 0, O_EXCL = 0 } = fs.constants
  if (!(flags & O_CREAT) || (flags & O_EXCL)) return false
  return err.code === (missing ? 'EEXIST' : 'ENOENT')
}

/**
 * Whether `target` is the empty regular file this call's fd refers to. A win32 open with
 * `O_CREAT | O_EXCL` follows a dangling symlink planted after the lstat and creates its target
 * (reported from the orchestrator's Windows 11 VM run; Linux fails EEXIST instead). After refusing,
 * the open removes that target only when this holds, so nothing whose identity differs from the fd
 * is unlinked.
 * @param {any} target lstat of the resolved name
 * @param {any} opened fstat of the fd
 * @returns {boolean}
 */
function isOwnEmptyFile (target, opened) {
  return target.isFile() && sameFile(target, opened) && target.size === 0n
}

/**
 * Refuse what a win32 no-follow open's first lstat found: ELOOP for a symbolic link, and EEXIST for
 * an existing name under the caller's `O_CREAT | O_EXCL` (the open itself runs without `O_CREAT`
 * for a found name, so it would not report that). `before` is null for a missing name.
 * @param {string} file
 * @param {number} flags
 * @param {any} before
 */
function win32CheckBefore (file, flags, before) {
  const { O_CREAT = 0, O_EXCL = 0 } = fs.constants
  if (before?.isSymbolicLink()) throw loopError(file)
  if (before && (flags & O_CREAT) && (flags & O_EXCL)) {
    throw Object.assign(new Error(`EEXIST: file already exists, open '${file}'`), { code: 'EEXIST', syscall: 'open', path: file })
  }
}

/**
 * Open `file` without following a symbolic link at its last component, returning an fd. POSIX adds
 * `O_NOFOLLOW`. win32 has no `O_NOFOLLOW`: it lstats the name and refuses a symbolic link with
 * ELOOP, opens, then fstats the fd and refuses (closing it) when its dev and ino differ from the
 * lstat. On win32 `O_TRUNC` is applied with ftruncate after that check, a found name is opened
 * without `O_CREAT`, a missing name under `O_CREAT` is created with `O_EXCL` and lstat after the
 * open, and a name that appeared or vanished in between re-runs the sequence (at most 3 attempts).
 * When that exclusive create is refused after the open, the file it created through a planted
 * symlink is unlinked, but only if it is still the fd's own empty regular file (`isOwnEmptyFile`).
 * @param {string} file
 * @param {number} [flags]
 * @param {{ platform?: string, fs?: any, mode?: number }} [opts]
 * @returns {number}
 */
export function openNoFollowSync (file, flags = fs.constants.O_RDONLY, { platform = process.platform, fs: fsImpl = fs, mode } = {}) {
  if (platform !== 'win32') return fsImpl.openSync(file, flags | fs.constants.O_NOFOLLOW, mode)
  let last
  for (let attempt = 0; attempt < WIN32_OPEN_ATTEMPTS; attempt++) {
    let before = null
    try {
      before = fsImpl.lstatSync(file, { bigint: true })
    } catch (err) {
      if (err.code !== 'ENOENT' || !(flags & (fs.constants.O_CREAT ?? 0))) throw err
    }
    win32CheckBefore(file, flags, before)
    let fd
    try {
      fd = fsImpl.openSync(file, win32OpenFlags(flags, before === null), mode)
    } catch (err) {
      if (!win32Retryable(err, flags, before === null)) throw err
      last = err
      continue
    }
    try {
      const opened = fsImpl.fstatSync(fd, { bigint: true })
      const seen = before ?? fsImpl.lstatSync(file, { bigint: true })
      if (seen.isSymbolicLink() || !sameFile(seen, opened)) {
        if (before === null) {
          try {
            const target = fsImpl.realpathSync(file)
            if (isOwnEmptyFile(fsImpl.lstatSync(target, { bigint: true }), opened)) fsImpl.unlinkSync(target)
          } catch {}
        }
        throw loopError(file)
      }
      if (before !== null && (flags & (fs.constants.O_TRUNC ?? 0))) fsImpl.ftruncateSync(fd, 0)
    } catch (err) {
      fsImpl.closeSync(fd)
      throw err
    }
    return fd
  }
  throw last
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
  let last
  for (let attempt = 0; attempt < WIN32_OPEN_ATTEMPTS; attempt++) {
    let before = null
    try {
      before = await fsp.lstat(file, { bigint: true })
    } catch (err) {
      if (err.code !== 'ENOENT' || !(flags & (fs.constants.O_CREAT ?? 0))) throw err
    }
    win32CheckBefore(file, flags, before)
    let handle
    try {
      handle = await fsp.open(file, win32OpenFlags(flags, before === null), mode)
    } catch (err) {
      if (!win32Retryable(err, flags, before === null)) throw err
      last = err
      continue
    }
    try {
      const opened = await handle.stat({ bigint: true })
      const seen = before ?? await fsp.lstat(file, { bigint: true })
      if (seen.isSymbolicLink() || !sameFile(seen, opened)) {
        if (before === null) {
          try {
            const target = await fsp.realpath(file)
            if (isOwnEmptyFile(await fsp.lstat(target, { bigint: true }), opened)) await fsp.unlink(target)
          } catch {}
        }
        throw loopError(file)
      }
      if (before !== null && (flags & (fs.constants.O_TRUNC ?? 0))) await handle.truncate(0)
    } catch (err) {
      await handle.close()
      throw err
    }
    return handle
  }
  throw last
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
