import { readFileSync, mkdirSync, openSync, writeSync, closeSync, statSync, existsSync, chmodSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const maxInput = 2 * 1024 * 1024
const maxLine = 1024 * 1024
const maxString = 64 * 1024
const maxSpool = 32 * 1024 * 1024

function ancestry() {
  const pidChain = [process.pid]
  let claudePid = null
  let pid = process.ppid
  while (pid > 1 && pidChain.length < 8) {
    pidChain.push(pid)
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const name = status.match(/^Name:\s*(.*)$/m)?.[1]
      if (name === 'claude' && claudePid === null) claudePid = pid
      if (claudePid !== null && name !== 'claude') break
      pid = Number(status.match(/^PPid:\s*(\d+)$/m)?.[1] ?? 0)
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

/** Build the versioned envelope without reshaping fields outside tool_input. */
export function makeEnvelope(hook, { hookTs = Date.now(), ptyId = process.env.FLEETMATES_DECK_PTY ?? null } = {}) {
  const state = { truncated: false }
  const copy = { ...hook }
  if (copy.tool_input !== undefined) copy.tool_input = truncateInput(copy.tool_input, state)
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
  const file = path.join(dir, `hooks-${day}.jsonl`)
  if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxSpool) return
  const fd = openSync(file, 'a', 0o600)
  try { chmodSync(file, 0o600); writeSync(fd, line) } finally { closeSync(fd) }
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
