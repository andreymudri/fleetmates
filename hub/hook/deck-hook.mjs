import { constants, readFileSync, mkdirSync, openSync, writeSync, closeSync, fstatSync, fchmodSync, readdirSync, renameSync, existsSync, unlinkSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const maxInput = 2 * 1024 * 1024
const maxLine = 1024 * 1024
const maxString = 64 * 1024
const maxSpool = 32 * 1024 * 1024
const hookFields = new Set(['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'permission_mode', 'source', 'reason', 'tool_name', 'tool_input', 'notification_type', 'stop_hook_active', 'message', 'prompt'])

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

function ancestry() {
  const pidChain = [process.pid]
  let claudePid = null
  let pid = process.ppid
  while (pid > 1 && pidChain.length < 8) {
    pidChain.push(pid)
    try {
      let parentPid
      let command
      try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8')
        parentPid = Number(status.match(/^PPid:\s*(\d+)$/m)?.[1] ?? 0)
        command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      } catch {
        const row = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'command='], { encoding: 'utf8', timeout: 80, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
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
export function makeEnvelope(hook, { hookTs = Date.now(), ptyId = process.env.FLEETMATES_DECK_PTY ?? null } = {}) {
  const state = { truncated: false }
  const copy = Object.fromEntries(Object.entries(hook).filter(([key]) => hookFields.has(key)))
  if (copy.tool_input !== undefined && !tooDeep(copy.tool_input)) copy.tool_input = truncateInput(copy.tool_input, state)
  const envelope = { v: 1, deckHookVersion: '0.1.0', hookTs, ptyId, ...ancestry(), truncated: state.truncated, hook: copy }
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

function sendSocket(line, runtimeDir) {
  return new Promise((resolve, reject) => {
    if (!runtimeDir) { reject(Error('runtime directory unavailable')); return }
    const socket = connect(path.join(runtimeDir, 'fleetmates-deck', 'hooks.sock'))
    socket.setTimeout(100, () => socket.destroy(Error('socket timeout')))
    socket.once('error', reject)
    socket.once('connect', () => socket.end(line, () => resolve()))
  })
}

function spool(line, env, hookTs) {
  const stateHome = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state')
  const dir = path.join(stateHome, 'fleetmates', 'deck', 'spool')
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
    try { await sendSocket(line, process.env.XDG_RUNTIME_DIR) } catch { spool(line, process.env, hookTs) }
  } catch { /* Hooks must never change Claude Code's result. */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const budget = setTimeout(() => process.exit(0), 200)
  await main()
  clearTimeout(budget)
  process.exit(0)
}
