// Observation only. Git-derived enforcement remains the authority for completion.
// No command, output, title or handoff prose is retained or rendered to the lead.
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

export const MAX_LEDGER_BYTES = 1024 * 1024
export const MAX_STALL_BLOCKS = 3
const KINDS = new Set(['task-started', 'command-run', 'gate-result', 'handoff', 'stop-requested', 'stall-block', 'hook-fired', 'watchdog'])
const RESULTS = new Set(['pass', 'fail', 'unknown', 'done', 'blocked', 'running'])
const HOOKS = new Set(['SessionStart', 'PreCompact', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop', 'Stop'])
const WATCH_ACTIONS = new Set(['resume', 'respawn', 'orphan', 'unmeasured'])
export const fingerprint = (text) => createHash('sha256').update(String(text)).digest('hex')

export function projectEvent(value) {
  if (!value || !KINDS.has(value.kind) || !Number.isSafeInteger(value.at) || value.at < 0) throw new Error('invalid ledger event')
  const event = { v: 1, at: value.at, kind: value.kind }
  if (RESULTS.has(value.result)) event.result = value.result
  if (/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')) event.fingerprint = value.fingerprint
  if (HOOKS.has(value.hook)) event.hook = value.hook
  if (event.kind === 'watchdog' && WATCH_ACTIONS.has(value.action)) event.action = value.action
  return event
}

export function ledgerPath(root, runId, taskId) {
  if (typeof runId !== 'string' || !runId || runId.split(/[\\/]/).some(p => !p || p === '.' || p === '..' || p === '.fleetmates' || p === 'fleetmates')) throw new Error('invalid ledger run')
  if (typeof taskId !== 'string' || !taskId) throw new Error('invalid ledger task')
  const target = path.resolve(root, '.fleetmates', runId, 'ledger', `${fingerprint(taskId)}.jsonl`)
  if (!target.startsWith(path.resolve(root, '.fleetmates') + path.sep)) throw new Error('ledger escapes root')
  return target
}

// A link is refused only below the state directory, the part a teammate can plant. Above it the
// path is the user's: macOS reaches the temp dir through /var -> /private/var and Windows through
// 8.3 names like RUNNER~1, so comparing the whole path to its realpath refused every ledger there.
//
// The anchor is the parent of the OUTERMOST `.fleetmates`, never the nearest: a run id is
// teammate-influenced (the location record that names it is teammate-written), and a nearest
// match let a run id of `x/fleetmates` move the anchor below a link the teammate planted at
// `.fleetmates/x`, sending the ledger outside the repository. Hook receipts live under the config
// dir's `fleetmates/` and contain no `.fleetmates`, so they anchor on that. With neither, the
// whole path must be its own realpath, as before.
function stateAnchor(p) {
  let outer = null
  let nearestPlain = null
  for (let cur = p; ; cur = path.dirname(cur)) {
    const base = path.basename(cur)
    if (base === '.fleetmates') outer = path.dirname(cur)
    if (base === 'fleetmates' && nearestPlain === null) nearestPlain = path.dirname(cur)
    if (path.dirname(cur) === cur) break
  }
  return outer ?? nearestPlain
}

async function expected(p) {
  const anchor = stateAnchor(p)
  return anchor === null ? p : path.join(await realpath(anchor), path.relative(anchor, p))
}

async function safeParent(file, create = false) {
  const parent = path.dirname(path.resolve(file))
  if (create) await mkdir(parent, { recursive: true })
  if (await realpath(parent) !== await expected(parent)) throw new Error('ledger parent is a link')
}

// Hook receipts are written for as long as the plugin is installed, so their file fills. A full
// receipt file is set aside as one previous generation and a new one is started; a run ledger is
// never rotated, because its bound is what stops a teammate from growing it.
export const rotatedPath = (file) => `${file}.1`

export async function appendEvent(file, value, { rotate = false } = {}) {
  const line = JSON.stringify(projectEvent(value)) + '\n'
  await safeParent(file, true)
  for (let attempt = 0; ; attempt += 1) {
    let full
    const h = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600)
    try {
      const stat = await h.stat()
      if (!stat.isFile() || await realpath(file) !== await expected(path.resolve(file))) throw new Error('ledger is unsafe or full')
      if (stat.size + Buffer.byteLength(line) <= MAX_LEDGER_BYTES) { await h.write(line); return }
      if (!rotate || attempt > 0) throw new Error('ledger is unsafe or full')
      full = stat.ino
    } finally { await h.close() }
    // Another hook may have rotated between the check and here: move the file only if it is
    // still the full one, so a fresh file never replaces the previous generation.
    const current = await lstat(file).catch(() => null)
    if (current?.ino === full) await rename(file, rotatedPath(file))
  }
}

export async function readEvents(file) {
  let h
  try {
    await safeParent(file)
    h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await h.stat()
    if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES || await realpath(file) !== await expected(path.resolve(file))) throw new Error('ledger is unsafe or full')
    const buffer = Buffer.alloc(MAX_LEDGER_BYTES + 1)
    const { bytesRead } = await h.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_LEDGER_BYTES) throw new Error('ledger is full')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    if (text && !text.endsWith('\n')) throw new Error('incomplete ledger')
    return text.split('\n').filter(Boolean).map(line => projectEvent(JSON.parse(line)))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  } finally { await h?.close() }
}

export function ledgerSummary(events) {
  // A watchdog event records supervision, not teammate progress: it is neither counted nor a stop.
  const counts = Object.fromEntries([...KINDS].filter(kind => kind !== 'watchdog').map(kind => [kind, 0]))
  let gate = 'unknown', handoff = 'running', blocks = 0, stops = 0
  const successes = new Set()
  for (const raw of events) {
    const event = projectEvent(raw)
    if (event.kind === 'watchdog') continue
    counts[event.kind] += 1
    if (event.kind === 'gate-result') gate = event.result ?? 'unknown'
    if (event.kind === 'handoff') handoff = event.result ?? 'unknown'
    if (event.kind === 'stop-requested') stops += 1
    if (event.kind === 'stall-block') blocks += 1
    if (event.kind === 'command-run' && event.result === 'pass' && event.fingerprint && !successes.has(event.fingerprint)) {
      successes.add(event.fingerprint); stops = 0; blocks = 0
    }
    if (event.kind === 'gate-result' && event.result === 'pass') { stops = 0; blocks = 0 }
  }
  return { v: 1, counts, gate, handoff, stopsWithoutProgress: stops, stallBlocks: blocks,
    stalled: stops >= 2 && gate !== 'pass', next: gate === 'pass' ? 'handoff' : stops >= 2 ? 'inspect-stall' : 'verify' }
}

export function stallDecision(events, stopHookActive = false) {
  const summary = ledgerSummary(events)
  return { ...summary, block: summary.stalled && !stopHookActive && summary.stallBlocks < MAX_STALL_BLOCKS }
}
