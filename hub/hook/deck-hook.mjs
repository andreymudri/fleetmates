import { constants, readFileSync, lstatSync, mkdirSync, openSync, writeSync, closeSync, fstatSync, fchmodSync, readdirSync, renameSync, existsSync, unlinkSync, chmodSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const maxInput = 2 * 1024 * 1024
const maxLine = 1024 * 1024
const maxString = 64 * 1024
const maxSpool = 32 * 1024 * 1024
// Read once at start from the package.json one directory above this script; null when it cannot be read.
const deckHookVersion = (() => {
  try {
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    return typeof version === 'string' ? version : null
  } catch { return null }
})()
const hookFields =new Set(['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'permission_mode', 'source', 'reason', 'tool_name', 'tool_input', 'notification_type', 'stop_hook_active', 'message', 'prompt'])

function tooDeep(value) {
  const stack = [[value, 0]]
  while (stack.length) {
    const [item, depth] = stack.pop()
    if (depth > 64) return true
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) stack.push([child, depth + 1])
    }
  }
  return false
}

/**
 * The hook's own pid, its ancestors up to the first claude process, and that claude's pid. On win32
 * there is no /proc and no ps, so it reports only its own pid and a null claude pid, without reading
 * or spawning anything. readFile and execFile are injectable for tests.
 */
export function ancestry({ platform = process.platform, readFile = readFileSync, execFile = execFileSync } = {}) {
  const pidChain = [process.pid]
  let claudePid = null
  if (platform === 'win32') return { pidChain, claudePid }
  let pid = process.ppid
  while (pid > 1 && pidChain.length < 8) {
    pidChain.push(pid)
    try {
      let parentPid
      let command
      try {
        const status = readFile(`/proc/${pid}/status`, 'utf8')
        parentPid = Number(status.match(/^PPid:\s*(\d+)$/m)?.[1] ?? 0)
        command = readFile(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      } catch {
        const row = execFile('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'command='], { encoding: 'utf8', timeout: 80, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        const match = row.match(/^(\d+)\s+(.+)$/)
        if (!match) break
        parentPid = Number(match[1])
        command = match[2].split(/\s+/)
      }
      const name = path.basename(command[0] ?? '')
      const isClaude = name === 'claude' || (name === 'node' && command.slice(1).some((arg) => path.basename(arg) === 'claude'))
      if (isClaude && claudePid === null) claudePid = pid
      if (claudePid !== null && !isClaude) break
      pid = parentPid
    } catch { break }
  }
  return { pidChain, claudePid }
}

/**
 * The hooks endpoint the deck server listens on. A copy of `endpoint(runtimeBase({ env, platform }),
 * 'hooks', { platform })` from hub/platform/index.mjs, because this file is copied alone by init and
 * imports only node: modules; hook-platform.test.mjs pins the two together.
 */
export function hookEndpoint(env = process.env, platform = process.platform) {
  const uid = process.getuid?.() ?? null
  const home = env.HOME || os.homedir()
  let base
  if (typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR !== '') base = env.XDG_RUNTIME_DIR
  else if (platform === 'darwin') base = path.posix.join(home, 'Library', 'Caches', 'fleetmates-deck')
  else if (platform === 'win32') base = path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'fleetmates-deck', 'run')
  else base = `/tmp/fleetmates-deck-${uid}`
  if (platform === 'win32') {
    const h = createHash('sha256').update(path.win32.resolve(base).toLowerCase()).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\fleetmates-deck-${h}-hooks`
  }
  const sock = path.posix.join(base, 'fleetmates-deck', 'hooks.sock')
  return Buffer.byteLength(sock) > 100 ? `/tmp/fleetmates-deck-${uid}/hooks.sock` : sock
}

function truncateInput(value, state) {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value)
    if (bytes <= maxString) return value
    state.truncated = true
    const kept = Buffer.from(value).subarray(0, maxString).toString('utf8')
    return `${kept}…[truncated ${bytes - maxString} bytes]`
  }
  if (Array.isArray(value)) return value.map(item => truncateInput(item, state))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateInput(item, state)]))
  return value
}

/** Build the versioned envelope with only fields needed for deck state. */
export function makeEnvelope(hook, { hookTs = Date.now(), ptyId = process.env.FLEETMATES_DECK_PTY ?? null, platform = process.platform } = {}) {
  const state = { truncated: false }
  const copy = Object.fromEntries(Object.entries(hook).filter(([key]) => hookFields.has(key)))
  if (copy.tool_input !== undefined && !tooDeep(copy.tool_input)) copy.tool_input = truncateInput(copy.tool_input, state)
  const envelope = { v: 1, deckHookVersion, hookTs, ptyId, ...ancestry({ platform }), truncated: state.truncated, hook: copy }
  if (Buffer.byteLength(JSON.stringify(envelope)) > maxLine) {
    delete copy.tool_input
    envelope.truncated = true
  }
  return envelope
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    process.stdin.on('data', chunk => {
      size += chunk.length
      if (size > maxInput) { process.stdin.destroy(); reject(Error('hook input too large')); return }
      chunks.push(chunk)
    })
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

/**
 * Why the directories holding a POSIX endpoint are not private to this user, or null. Checks the
 * endpoint's directory and, when that is the `fleetmates-deck` dir of a base, the base too: each
 * must be a real directory (lstat, so a symlink fails), owned by `uid`, with no group or world bits.
 * A missing directory is a reason too. win32 pipes have no directory: always null there. fm uses
 * this before connecting to deckd, and the hook before sending, so neither talks to a socket another
 * local user planted, for example in a pre-created /tmp/fleetmates-deck-<uid>.
 * @param {string} endpointPath
 * @param {{ platform?: string, uid?: number | null, lstat?: (p: string) => import('node:fs').Stats }} [opts]
 * @returns {string | null}
 */
export function endpointDirProblem(endpointPath, { platform = process.platform, uid = process.getuid?.() ?? null, lstat = lstatSync } = {}) {
  if (platform === 'win32') return null
  const dir = path.posix.dirname(endpointPath)
  const dirs = path.posix.basename(dir) === 'fleetmates-deck' ? [dir, path.posix.dirname(dir)] : [dir]
  for (const item of dirs) {
    let info
    try { info = lstat(item) } catch (error) { return `runtime dir ${item} cannot be read (${error.code ?? error.message})` }
    if (!info.isDirectory()) return `runtime dir ${item} is not a directory`
    if (uid !== null && uid !== undefined && info.uid !== uid) return `runtime dir ${item} is owned by uid ${info.uid}, not by this user`
    if ((info.mode & 0o077) !== 0) return `runtime dir ${item} has mode ${(info.mode & 0o777).toString(8).padStart(4, '0')}; it is not private`
  }
  return null
}

function sendSocket(line, endpointPath) {
  return new Promise((resolve, reject) => {
    const problem = endpointDirProblem(endpointPath)
    if (problem) { reject(Error(`runtime dir not private: ${problem}`)); return }
    const socket = connect(endpointPath)
    socket.setTimeout(100, () => socket.destroy(Error('socket timeout')))
    socket.once('error', reject)
    socket.once('connect', () => socket.end(line, () => resolve()))
  })
}

/**
 * The private spool directory, the `spool` of setupPaths(env, { platform }) in
 * hub/server/setup/paths.mjs, computed here because this file is copied alone. linux and darwin:
 * <XDG_STATE_HOME or ~/.local/state>/fleetmates/deck/spool. win32: <XDG_STATE_HOME>\fleetmates\deck\spool
 * when XDG_STATE_HOME is set, else <LOCALAPPDATA>\fleetmates\deck\state\spool.
 */
export function spoolDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const p = path.win32
    const home = env.HOME || env.USERPROFILE || os.homedir()
    const state = env.XDG_STATE_HOME
      ? p.join(env.XDG_STATE_HOME, 'fleetmates', 'deck')
      : p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'fleetmates', 'deck', 'state')
    return p.join(state, 'spool')
  }
  const stateHome = env.XDG_STATE_HOME || path.posix.join(env.HOME || os.homedir(), '.local', 'state')
  return path.posix.join(stateHome, 'fleetmates', 'deck', 'spool')
}

function spool(line, env, hookTs) {
  const dir = spoolDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const day = new Date(hookTs).toISOString().slice(0, 10).replaceAll('-', '')
  const bytes = readdirSync(dir).filter(name => name.startsWith('hooks-')).reduce((total, name) => {
    const file = path.join(dir, name)
    let fd
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
      const info = fstatSync(fd)
      if (!info.isFile()) return total
      fchmodSync(fd, 0o600)
      return total + info.size
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') return total
      throw error
    } finally { if (fd !== undefined) closeSync(fd) }
  }, 0)
  if (bytes + Buffer.byteLength(line) > maxSpool) return
  const file = path.join(dir, `hooks-${day}-${String(hookTs).padStart(13, '0')}-${randomBytes(6).toString('hex')}.jsonl`)
  const temporary = `${file}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeSync(fd, line)
    closeSync(fd)
    fd = null
    renameSync(temporary, file)
  } finally {
    if (fd !== null && fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** Send one stdin hook payload within the hook budget, falling back to private spool. */
export async function main() {
  try {
    if (process.env.FLEETMATES_DECK_ROLE === 'ask') return
    const hookTs = Date.now()
    const hook = JSON.parse(await readStdin())
    const envelope = makeEnvelope(hook, { hookTs })
    const line = JSON.stringify(envelope) + '\n'
    if (Buffer.byteLength(line) > maxLine) return
    try { await sendSocket(line, hookEndpoint(process.env)) } catch { spool(line, process.env, hookTs) }
  } catch { /* Hooks must never change Claude Code's result. */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const budget = setTimeout(() => process.exit(0), 200)
  await main()
  clearTimeout(budget)
  process.exit(0)
}
