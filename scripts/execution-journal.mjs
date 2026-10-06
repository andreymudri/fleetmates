import { constants } from 'node:fs'
import { mkdir, open, realpath, link, unlink, opendir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { evidenceIdentity } from './workflow-evidence.mjs'
import { markerRef } from './workflow-lifecycle.mjs'
const digest = value => createHash('sha256').update(value).digest('hex')
const LIMIT = 1024 * 1024, RECORD_LIMIT = 8192
const plain = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
const kinds = ['step-started', 'step-completed', 'step-failed', 'effect-started', 'effect-completed', 'effect-failed', 'effect-unknown']
export function executionEvent(raw) {
  if (!raw || raw.version !== undefined && raw.version !== 1 || !plain(raw.id) || !plain(raw.step) || !plain(raw.attempt) || !kinds.includes(raw.kind)
      || !Number.isSafeInteger(raw.at) || raw.at < 0) throw new Error('Invalid execution event')
  markerRef(raw.runId, 'suspended') // Shared run identity validation; creates no ref.
  const inputs = Object.fromEntries(['commit', 'plan', 'manifest', 'environment', 'verifier'].map(k => [k, raw.inputs?.[k]]))
  const identity = evidenceIdentity(inputs)
  if (!/^[a-f0-9]{40,64}$/.test(inputs.commit)) throw new Error('Execution event requires exact commit identity')
  const branches = raw.branches ?? {}
  if (!branches || typeof branches !== 'object' || Array.isArray(branches) || Object.keys(branches).length > 100
      || Object.entries(branches).some(([ref, sha]) => !plain(ref) || !ref.startsWith('refs/heads/') || !/^[a-f0-9]{40,64}$/.test(sha))) throw new Error('Invalid execution branch observations')
  let effect = null
  if (raw.kind.startsWith('effect-')) {
    if (!raw.effect || !plain(raw.effect.id) || !['pr', 'vault', 'publication'].includes(raw.effect.kind)
        || raw.effect.reference != null && !plain(raw.effect.reference)) throw new Error('Invalid external effect identity')
    effect = { id: raw.effect.id, kind: raw.effect.kind, reference: raw.effect.reference ?? null }
  } else if (raw.effect != null) throw new Error('Step event cannot declare an external effect')
  // Whitelist metadata: never persist prompts, commands, credentials or output bodies.
  return { version: 1, id: raw.id, runId: raw.runId, step: raw.step, attempt: raw.attempt, kind: raw.kind, at: raw.at, inputs, identity, branches: Object.fromEntries(Object.entries(branches).sort(([a], [b]) => a.localeCompare(b))), effect }
}
export async function executionDirectory(common, runId) {
  markerRef(runId, 'suspended')
  return path.join(await realpath(common), 'fleetmates-execution', digest(runId))
}
async function readRecord(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > RECORD_LIMIT || await realpath(file) !== file) throw new Error('Unsafe execution record')
    const buffer = Buffer.alloc(RECORD_LIMIT + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > RECORD_LIMIT) throw new Error('Execution record exceeds budget')
    const text = new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    if (!text.endsWith('\n')) throw new Error('Incomplete execution record')
    return { event: executionEvent(JSON.parse(text)), bytes: bytesRead }
  } finally { await handle.close() }
}
export async function readExecutionEvents(common, runId) {
  const directory = await executionDirectory(common, runId)
  let dir
  try { dir = await opendir(directory) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  if (await realpath(directory) !== directory) { await dir.close(); throw new Error('Execution directory is a link') }
  const events = [], ids = new Set()
  let bytes = 0
  for await (const entry of dir) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
    const { event, bytes: size } = await readRecord(path.join(directory, entry.name))
    bytes += size
    if (bytes > LIMIT || events.length >= 1000) throw new Error('Execution journal exceeds budget')
    if (event.runId !== runId || entry.name !== digest(event.id) + '.json' || ids.has(event.id)) throw new Error('Execution record identity mismatch')
    ids.add(event.id); events.push(event)
  }
  return events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
export async function appendExecutionEvent(common, raw) {
  const event = executionEvent(raw), text = JSON.stringify(event) + '\n'
  if (Buffer.byteLength(text) > RECORD_LIMIT) throw new Error('Execution record exceeds budget')
  const directory = await executionDirectory(common, event.runId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await realpath(directory) !== directory) throw new Error('Execution directory is a link')
  const existing = await readExecutionEvents(common, event.runId)
  if (existing.length >= 1000 || existing.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)) + 1, 0) + Buffer.byteLength(text) > LIMIT) throw new Error('Execution journal exceeds budget')
  const file = path.join(directory, digest(event.id) + '.json'), temporary = path.join(directory, '.' + randomUUID() + '.tmp')
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
  try {
    try { await link(temporary, file) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (JSON.stringify((await readRecord(file)).event) !== JSON.stringify(event)) throw new Error('Execution event ID already records different data')
    }
  } finally { await unlink(temporary).catch(() => {}) }
  return event
}
export function reconcileExecution(events, { inputs, branches = {} }) {
  const identity = evidenceIdentity(inputs), groups = new Map()
  for (const raw of events) {
    const event = executionEvent(raw)
    const key = JSON.stringify([event.step, event.attempt, event.identity])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(event)
  }
  const attempts = [...groups.values()].map(records => {
    const starts = records.filter(e => e.kind === 'step-started'), ends = records.filter(e => ['step-completed', 'step-failed'].includes(e.kind))
    if (starts.length !== 1 || ends.length > 1 || ends.some(e => e.at < starts[0].at)) throw new Error('Execution attempt requires one start and at most one ordered outcome')
    const effects = new Map()
    for (const event of records.filter(e => e.effect)) {
      const key = JSON.stringify([event.effect.kind, event.effect.id])
      if (!effects.has(key)) effects.set(key, [])
      effects.get(key).push(event)
    }
    const outcomes = [...effects.values()].map(records => {
      const starts = records.filter(e => e.kind === 'effect-started'), ends = records.filter(e => e.kind !== 'effect-started')
      if (starts.length !== 1 || ends.length > 1 || ends.some(e => e.at < starts[0].at)) throw new Error('External effect history is ambiguous')
      return { ...starts[0].effect, state: !ends.length || ends[0].kind === 'effect-unknown' ? 'unknown-outcome' : ends[0].kind === 'effect-completed' ? 'completed-observation' : 'failed-observation' }
    })
    const current = starts[0].identity === identity
    const observations = { ...starts[0].branches, ...(ends[0]?.branches ?? {}) }
    const changedBranches = Object.keys(observations).filter(ref => branches[ref] !== observations[ref])
    const unknownEffects = outcomes.some(effect => effect.state === 'unknown-outcome')
    const state = !current ? 'stale' : changedBranches.length ? 'branch-changed' : unknownEffects ? 'unknown-effect' : !ends.length ? 'interrupted' : ends[0].kind === 'step-completed' ? 'completed-observation' : 'failed-observation'
    return { step: starts[0].step, attempt: starts[0].attempt, state, effects: outcomes, changedBranches,
      action: state === 'completed-observation' ? 'recompute-current-gates-before-reuse' : 'reconcile-before-retry', requiresCurrentGates: true }
  })
  return { version: 1, mode: 'observations', identity, attempts, verifiedComplete: false,
    unresolved: attempts.some(a => a.state !== 'completed-observation'), trust: 'History records observations, not execution proof, authorization or delivery completion. No external effect is repeated.' }
}
