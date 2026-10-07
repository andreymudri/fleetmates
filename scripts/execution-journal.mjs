import { constants } from 'node:fs'
import { mkdir, open, realpath, link, unlink, opendir, lstat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { evidenceIdentity } from './workflow-evidence.mjs'
import { strictExecutionIdentity } from './completion-obligations.mjs'
import { markerRef } from './workflow-lifecycle.mjs'
import { RETENTION_LIMITS, withStorageLock, reconcileTemporaries } from './execution-artifacts.mjs'
const digest = value => createHash('sha256').update(value).digest('hex')
const LIMIT = 1024 * 1024, RECORD_LIMIT = 8192
const plain = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
const kinds = ['step-started', 'step-completed', 'step-failed', 'effect-started', 'effect-completed', 'effect-failed', 'effect-unknown']
export function executionEvent(raw) {
  if (raw?.version === 2) return strictEvent(raw)
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
const label = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = value => value && [Object.prototype, null].includes(Object.getPrototypeOf(value))
function fields(value, allowed) {
  if (!object(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new Error('Invalid strict execution fields')
}
export function executionBranches(branches) {
  fields(branches, Object.keys(branches ?? {}))
  if (Object.keys(branches).length > 100 || Object.entries(branches).some(([ref, tip]) =>
    !ref.startsWith('refs/heads/') || ref.length > 255 || /[\p{C}\s~^:?*\[\\]/u.test(ref)
    || ref.includes('..') || ref.includes('@{') || ref.includes('//')
    || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) || !sha(tip))) throw new Error('Invalid execution branch observations')
  return Object.fromEntries(Object.entries(branches).sort(([a], [b]) => a.localeCompare(b)))
}
// Strict external effect kinds and the outcomes a local operator may record for each. An
// agent-dispatch resolved `not-started` permits redispatch; `completed` permits reuse after validation.
export const EFFECT_RESOLUTIONS = Object.freeze({
  pr: Object.freeze(['completed', 'failed', 'unknown']),
  vault: Object.freeze(['completed', 'failed', 'unknown']),
  publication: Object.freeze(['completed', 'failed', 'unknown']),
  'agent-dispatch': Object.freeze(['not-started', 'completed'])
})
const strictEffectKind = kind => typeof kind === 'string' && Object.hasOwn(EFFECT_RESOLUTIONS, kind)
export function authorizedPrReference(value) {
  return typeof value === 'string' && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}#[1-9][0-9]{0,8}$/.test(value)
}
function strictEvent(raw) {
  fields(raw, ['version', 'id', 'runId', 'executionId', 'task', 'step', 'attempt', 'kind', 'at', 'inputs', 'identity', 'branches', 'checkout', 'artifacts', 'effect', 'resolution'])
  if (!['id', 'executionId', 'task', 'step', 'attempt', 'checkout'].every(key => label(raw[key]))
      || ![...kinds, 'effect-resolved'].includes(raw.kind) || !Number.isSafeInteger(raw.at) || raw.at < 0) throw new Error('Invalid strict execution event')
  markerRef(raw.runId, 'suspended')
  const identity = strictExecutionIdentity(raw.inputs)
  if (raw.identity !== undefined && raw.identity !== identity) throw new Error('Strict execution identity mismatch')
  const branches = executionBranches(raw.branches)
  if (!Object.keys(branches).length) throw new Error('Strict execution needs branch observations')
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length > 32) throw new Error('Invalid artifact references')
  const artifacts = raw.artifacts.map(reference => {
    fields(reference, ['version', 'runId', 'kind', 'sha256', 'byteLength'])
    if (Object.keys(reference).length !== 5 || reference.version !== 1 || reference.runId !== raw.runId
        || !/^[a-z][a-z0-9._-]{0,63}$/.test(reference.kind) || !hash(reference.sha256)
        || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0 || reference.byteLength > RETENTION_LIMITS.maxArtifactBytes) throw new Error('Invalid artifact identity')
    return { version: 1, runId: reference.runId, kind: reference.kind, sha256: reference.sha256, byteLength: reference.byteLength }
  })
  if (raw.kind === 'step-completed' && !artifacts.length) throw new Error('Completed step needs retained artifact references')
  let effect = null, resolution = null
  if (raw.kind.startsWith('effect-')) {
    fields(raw.effect, ['id', 'kind', 'reference'])
    if (!label(raw.effect.id) || !strictEffectKind(raw.effect.kind)
        || raw.effect.reference !== null && !(raw.effect.kind === 'pr' && authorizedPrReference(raw.effect.reference))) throw new Error('Invalid strict external effect')
    effect = { id: raw.effect.id, kind: raw.effect.kind, reference: raw.effect.reference }
  } else if (raw.effect != null) throw new Error('Step event cannot declare an external effect')
  if (raw.kind === 'effect-resolved') {
    fields(raw.resolution, ['outcome', 'reason', 'trust', 'authenticatedAuthorization'])
    if (!EFFECT_RESOLUTIONS[effect.kind].includes(raw.resolution.outcome) || !label(raw.resolution.reason)
        || raw.resolution.trust !== 'local-operator-observation' || raw.resolution.authenticatedAuthorization !== false) throw new Error('Invalid local effect resolution')
    resolution = { outcome: raw.resolution.outcome, reason: raw.resolution.reason, trust: 'local-operator-observation', authenticatedAuthorization: false }
  } else if (raw.resolution != null) throw new Error('Unexpected effect resolution')
  return { version: 2, id: raw.id, runId: raw.runId, executionId: raw.executionId, task: raw.task, step: raw.step, attempt: raw.attempt,
    kind: raw.kind, at: raw.at, inputs: { ...raw.inputs }, identity, branches, checkout: raw.checkout, artifacts, effect, resolution }
}
export function strictExecutionAttempts(events) {
  const groups = new Map(), effectIds = new Set(), attemptIds = new Map(), ids = new Set()
  for (const raw of events) {
    const event = executionEvent(raw)
    if (ids.has(event.id)) throw new Error('Duplicate execution event id')
    ids.add(event.id)
    if (event.version !== 2) continue
    const key = JSON.stringify([event.executionId, event.task, event.step, event.attempt])
    const attemptKey = JSON.stringify([event.executionId, event.attempt])
    if (attemptIds.has(attemptKey) && attemptIds.get(attemptKey) !== key) throw new Error('Duplicate execution attempt')
    attemptIds.set(attemptKey, key)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(event)
  }
  return [...groups.values()].map(records => {
    records.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    const starts = records.filter(e => e.kind === 'step-started'), ends = records.filter(e => ['step-completed', 'step-failed'].includes(e.kind))
    if (starts.length !== 1 || ends.length > 1) throw new Error('Execution attempt requires one start and at most one outcome')
    const start = starts[0], end = ends[0] ?? null
    if (records.some(e => e.identity !== start.identity || e.checkout !== start.checkout || e.runId !== start.runId)) throw new Error('Execution attempt identity mismatch')
    if (records.some(e => e.at < start.at || end && e.kind !== 'effect-resolved' && e.at > end.at)) throw new Error('Execution attempt requires ordered start and outcomes')
    const effects = new Map()
    for (const event of records.filter(e => e.effect)) {
      if (!effects.has(event.effect.id)) effects.set(event.effect.id, [])
      effects.get(event.effect.id).push(event)
    }
    const outcomes = [...effects.values()].map(history => {
      const effectStarts = history.filter(e => e.kind === 'effect-started'), effectEnds = history.filter(e => ['effect-completed', 'effect-failed', 'effect-unknown'].includes(e.kind))
      if (effectStarts.length !== 1 || effectEnds.length > 1 || effectIds.has(history[0].effect.id)) throw new Error('External effect history is ambiguous')
      const first = effectStarts[0]
      effectIds.add(first.effect.id)
      if (history.some(e => e.at < first.at || JSON.stringify(e.effect) !== JSON.stringify(first.effect))) throw new Error('External effect history requires ordered matching identity')
      const resolutions = history.filter(e => e.kind === 'effect-resolved')
      if (resolutions.some((e, i) => e.at <= (i ? resolutions[i - 1].at : Math.max(first.at, effectEnds[0]?.at ?? 0)))) throw new Error('Effect resolution must be ordered after the effect')
      return { start: first, end: effectEnds[0] ?? null, resolution: resolutions.at(-1) ?? null }
    })
    return { start, end, records, effects: outcomes }
  })
}
const JOURNAL_POLICY = { maxEvents: 1000, maxBytes: LIMIT, maxAgeMs: 365 * 86400000 }
function journalPolicy(raw = JOURNAL_POLICY) {
  fields(raw, Object.keys(JOURNAL_POLICY))
  if (Object.keys(raw).length !== 3 || Object.entries(JOURNAL_POLICY).some(([key, upper]) => !Number.isSafeInteger(raw[key]) || raw[key] <= 0 || raw[key] > upper)) throw new Error('Invalid execution journal retention budget')
  return { ...raw }
}
export async function runAfterExecutionStart({ common, event, retention, action }) {
  if (!['step-started', 'effect-started'].includes(event?.kind) || event.version !== 2 || typeof action !== 'function') throw new Error('Required strict execution start and action')
  await appendExecutionEvent(common, event, { retention, requireFreshStart: true })
  return action()
}
export async function executionDirectory(common, runId) {
  markerRef(runId, 'suspended')
  return path.join(await realpath(common), 'fleetmates-execution', digest(runId))
}
async function readRecord(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > RECORD_LIMIT || await realpath(file) !== file) throw new Error('Unsafe execution record')
    const buffer = Buffer.alloc(RECORD_LIMIT + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > RECORD_LIMIT) throw new Error('Execution record exceeds budget')
    const text = new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    if (!text.endsWith('\n')) throw new Error('Incomplete execution record')
    return { event: executionEvent(JSON.parse(text)), bytes: bytesRead }
  } finally { await handle.close() }
}
async function privateExecutionDirectories(directory, allowMissing = false) {
  for (const dir of [path.dirname(directory), directory]) {
    let info
    try { info = await lstat(dir) }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return false; throw error }
    if (!info.isDirectory() || info.mode & 0o077 || await realpath(dir) !== dir) throw new Error('Unsafe execution directory')
  }
  return true
}
export async function readExecutionEvents(common, runId) {
  const directory = await executionDirectory(common, runId)
  if (!await privateExecutionDirectories(directory, true)) return []
  const dir = await opendir(directory)
  const events = [], ids = new Set()
  let bytes = 0
  for await (const entry of dir) {
    if (entry.name === '.lock') continue
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error('Incomplete execution journal storage')
    const { event, bytes: size } = await readRecord(path.join(directory, entry.name))
    bytes += size
    if (bytes > LIMIT || events.length >= 1000) throw new Error('Execution journal exceeds budget')
    if (event.runId !== runId || entry.name !== digest(event.id) + '.json' || ids.has(event.id)) throw new Error('Execution record identity mismatch')
    ids.add(event.id); events.push(event)
  }
  await privateExecutionDirectories(directory)
  return events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
function historicalEffectsBlockStrictAction(records, event) {
  const report = reconcileExecution(records, { inputs: event.inputs, branches: event.branches })
  const groups = new Map()
  for (const record of records) {
    const key = JSON.stringify([record.step, record.attempt, record.identity])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }
  for (const history of groups.values()) {
    const start = history.find(record => record.kind === 'step-started')
    const end = history.find(record => ['step-completed', 'step-failed'].includes(record.kind))
    if (history.some(record => record.at < start.at || end && record.at > end.at)) throw new Error('Historical execution requires ordered start and outcomes')
    const starts = new Map(history.filter(record => record.kind === 'effect-started')
      .map(record => [JSON.stringify([record.effect.kind, record.effect.id]), record]))
    if (history.some(record => record.effect && JSON.stringify(record.effect) !==
      JSON.stringify(starts.get(JSON.stringify([record.effect.kind, record.effect.id])).effect))) throw new Error('Historical effect requires matching identity')
  }
  return report.attempts.some(attempt => attempt.effects.some(effect => effect.state !== 'failed-observation'))
}
export async function appendExecutionEvent(common, raw, { retention, now = Date.now(), requireFreshStart = false } = {}) {
  const event = executionEvent(raw), text = JSON.stringify(event) + '\n', policy = journalPolicy(retention)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid journal time')
  if (Buffer.byteLength(text) > RECORD_LIMIT) throw new Error('Execution record exceeds budget')
  const directory = await executionDirectory(common, event.runId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await privateExecutionDirectories(directory)
  // The returned event carries the reconciliation report as a non-enumerable `reconciled`, so the
  // persisted and printed record keeps its exact shape.
  const result = value => Object.defineProperty(value, 'reconciled', { value: reconciled, enumerable: false })
  let reconciled
  return withStorageLock(directory, 'Execution journal busy; required start not persisted', async found => {
    reconciled = found
    await reconcileTemporaries(directory, reconciled)
    const existing = await readExecutionEvents(common, event.runId)
    const duplicate = existing.find(e => e.id === event.id)
    if (duplicate) {
      if (requireFreshStart) throw new Error('Execution start already persisted; reconcile before action')
      if (JSON.stringify(duplicate) !== JSON.stringify(event)) throw new Error('Execution event ID already records different data')
      return result(duplicate)
    }
    if (existing.length >= policy.maxEvents || existing.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)) + 1, 0) + Buffer.byteLength(text) > policy.maxBytes) throw new Error('Execution journal exceeds budget')
    if (event.version === 2 && [...existing, event].some(e => now - e.at > policy.maxAgeMs)) throw new Error('Execution journal retention exceeded; unresolved evidence is retained')
    const historical = existing.filter(record => record.version === 1)
    if (event.version === 2 && ['step-started', 'effect-started'].includes(event.kind) && historical.length
        && historicalEffectsBlockStrictAction(historical, event)) {
      throw new Error('Historical external effect outcome refuses strict action')
    }
    const previous = strictExecutionAttempts(existing)
    if (event.version === 2 && event.kind === 'effect-started' && previous.some(group =>
      group.end && group.start.executionId === event.executionId && group.start.task === event.task
      && group.start.step === event.step && group.start.attempt === event.attempt)) {
      throw new Error('Execution attempt already ended; new external effect refused')
    }
    if (event.version === 2 && ['step-started', 'effect-started'].includes(event.kind) && previous.some(group =>
      group.start.executionId === event.executionId && group.start.task === event.task && group.start.step === event.step
      && (event.kind === 'step-started' || group.start.attempt !== event.attempt)
      && group.effects.some(effect => effect.resolution ? !['failed', 'not-started'].includes(effect.resolution.resolution.outcome) : effect.end?.kind !== 'effect-failed'))) {
      throw new Error('External effect outcome refuses non-idempotent retry')
    }
    strictExecutionAttempts([...existing, event])
    const file = path.join(directory, digest(event.id) + '.json'), temporary = path.join(directory, '.' + randomUUID() + '.tmp')
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
      await link(temporary, file)
    } finally { await unlink(temporary).catch(() => {}) }
    const dirHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await dirHandle.sync() } finally { await dirHandle.close() }
    return result(event)
  })
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
