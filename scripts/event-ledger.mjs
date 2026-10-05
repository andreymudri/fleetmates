// Observation only. Git-derived enforcement remains the authority for completion.
// No command, output, title or handoff prose is retained or rendered to the lead.
import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

export const MAX_LEDGER_BYTES = 1024 * 1024
export const MAX_STALL_BLOCKS = 3
const KINDS = new Set(['task-started', 'command-run', 'gate-result', 'handoff', 'stop-requested', 'stall-block', 'hook-fired'])
const RESULTS = new Set(['pass', 'fail', 'unknown', 'done', 'blocked', 'running'])
const HOOKS = new Set(['SessionStart', 'PreCompact', 'PostToolUse', 'SubagentStop'])
export const fingerprint = (text) => createHash('sha256').update(String(text)).digest('hex')

export function projectEvent(value) {
  if (!value || !KINDS.has(value.kind) || !Number.isSafeInteger(value.at) || value.at < 0) throw new Error('invalid ledger event')
  const event = { v: 1, at: value.at, kind: value.kind }
  if (RESULTS.has(value.result)) event.result = value.result
  if (/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')) event.fingerprint = value.fingerprint
  if (HOOKS.has(value.hook)) event.hook = value.hook
  return event
}

export function ledgerPath(root, runId, taskId) {
  if (typeof runId !== 'string' || !runId || runId.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Error('invalid ledger run')
  if (typeof taskId !== 'string' || !taskId) throw new Error('invalid ledger task')
  const target = path.resolve(root, '.fleetmates', runId, 'ledger', `${fingerprint(taskId)}.jsonl`)
  if (!target.startsWith(path.resolve(root, '.fleetmates') + path.sep)) throw new Error('ledger escapes root')
  return target
}

async function safeParent(file, create = false) {
  const parent = path.dirname(path.resolve(file))
  if (create) await mkdir(parent, { recursive: true })
  if (await realpath(parent) !== parent) throw new Error('ledger parent is a link')
}

export async function appendEvent(file, value) {
  const line = JSON.stringify(projectEvent(value)) + '\n'
  await safeParent(file, true)
  const h = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600)
  try {
    const stat = await h.stat()
    if (!stat.isFile() || stat.size + Buffer.byteLength(line) > MAX_LEDGER_BYTES || await realpath(file) !== path.resolve(file)) throw new Error('ledger is unsafe or full')
    await h.write(line)
  } finally { await h.close() }
}

export async function readEvents(file) {
  let h
  try {
    await safeParent(file)
    h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await h.stat()
    if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES || await realpath(file) !== path.resolve(file)) throw new Error('ledger is unsafe or full')
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
  const counts = Object.fromEntries([...KINDS].map(kind => [kind, 0]))
  let gate = 'unknown', handoff = 'running', blocks = 0, stops = 0
  const successes = new Set()
  for (const raw of events) {
    const event = projectEvent(raw)
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
