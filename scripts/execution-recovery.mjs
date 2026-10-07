import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { strictExecutionIdentity } from './completion-obligations.mjs'
import { readExecutionArtifact } from './execution-artifacts.mjs'
import { readExecutionEvents, appendExecutionEvent, strictExecutionAttempts, executionBranches, authorizedPrReference, reconcileExecution } from './execution-journal.mjs'
import { git, discover } from './workflow-lifecycle.mjs'

const execute = promisify(execFile)
const TRUST = ['Local journal and same-UID observations are not authenticated external authorization.',
  'Current inputs and query authorization must be independently supplied by the trusted controller.',
  'Recovery observations require fresh completion gates; fsync does not guarantee power-loss recovery.']
const QUERY_LIMIT = 4096, QUERY_TIMEOUT = 5000, MAX_QUERIES = 20
async function queryPr(effect, queries, commit) {
  if (effect.kind !== 'pr' || !authorizedPrReference(effect.reference) || !queries?.authorizedPrReferences?.includes(effect.reference)) return null
  const [repository, number] = effect.reference.split('#')
  const args = ['pr', 'view', number, '--repo', repository, '--json', 'number,state,headRefOid']
  try {
    const operation = (queries.queryPr ?? ((request) => execute('gh', request.args, {
      timeout: request.timeoutMs, maxBuffer: request.maxBuffer, encoding: 'utf8',
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' }
    })))({ file: 'gh', args, timeoutMs: QUERY_TIMEOUT, maxBuffer: QUERY_LIMIT })
    let timer
    let result
    try {
      result = await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Query deadline')), QUERY_TIMEOUT) })])
    } finally { clearTimeout(timer) }
    if (typeof result?.stdout !== 'string' || Buffer.byteLength(result.stdout) > QUERY_LIMIT || result.code != null && result.code !== 0
        || result.exitCode != null && result.exitCode !== 0 || result.signal != null || result.truncated === true) return null
    const value = JSON.parse(result.stdout)
    if (value.number !== Number(number) || !['OPEN', 'CLOSED', 'MERGED'].includes(value.state)
        || typeof value.headRefOid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.headRefOid) || value.headRefOid !== commit) return null
    return { number: value.number, state: value.state, headRefOid: value.headRefOid }
  } catch { return null }
}
function queryContract(queries) {
  if (queries === undefined) return
  if (!queries || typeof queries !== 'object' || Array.isArray(queries)
      || Object.keys(queries).some(k => !['authorizedPrReferences', 'queryPr'].includes(k))
      || !Array.isArray(queries.authorizedPrReferences) || queries.authorizedPrReferences.length > MAX_QUERIES
      || queries.authorizedPrReferences.some(ref => !authorizedPrReference(ref))
      || queries.queryPr !== undefined && typeof queries.queryPr !== 'function') throw new Error('Invalid bounded authorized effect queries')
}
async function checkoutAvailable(common, checkouts, id, branches) {
  const root = checkouts[id]
  if (typeof root !== 'string' || !root.startsWith('/')) return false
  try {
    if (await realpath(discover(root).common) !== common) return false
    const ref = git(['symbolic-ref', '--quiet', 'HEAD'], root)
    if (!Object.hasOwn(branches, ref) || git(['rev-parse', '--verify', 'HEAD'], root) !== branches[ref]) return false
    return git(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'status', '--porcelain', '--untracked-files=no'], root) === ''
  } catch { return false }
}
function recordedBranches(records) {
  const expected = {}, conflicts = new Set(), concurrent = new Map()
  const rank = event => event.kind === 'step-started' ? 0 : event.kind === 'effect-started' ? 1
    : event.kind.startsWith('effect-') ? 2 : 3
  const before = (a, b) => a.kind === 'step-started' || ['step-completed', 'step-failed'].includes(b.kind)
    || a.kind === 'effect-started' && a.effect.id === b.effect?.id
  const observations = records.filter(event => event.kind !== 'effect-resolved')
    .sort((a, b) => a.at - b.at || rank(a) - rank(b) || a.id.localeCompare(b.id))
  for (const event of observations) {
    for (const [ref, tip] of Object.entries(event.branches)) {
      const previous = concurrent.get(ref) ?? []
      const sameTime = previous.filter(other => other.at === event.at)
      if (sameTime.some(other => other.branches[ref] !== tip && !before(other, event) && !before(event, other))) conflicts.add(ref)
      concurrent.set(ref, [...sameTime, event])
      expected[ref] = tip
    }
  }
  return { expected, conflicts: [...conflicts].sort() }
}
export async function reconcileExecutionAttempt({ common, runId, inputs, branches, retention, checkouts = {}, effectQueries }) {
  const identity = strictExecutionIdentity(inputs), currentBranches = executionBranches(branches)
  if (!checkouts || typeof checkouts !== 'object' || Array.isArray(checkouts) || Object.keys(checkouts).length > 1000) throw new Error('Invalid bounded checkout observations')
  const bounds = { maxArtifactBytes: 16 * 1024 * 1024, maxRunBytes: 256 * 1024 * 1024, maxAgeMs: 365 * 86400000 }
  if (!retention || Object.keys(retention).length !== 3 || Object.entries(bounds).some(([key, upper]) =>
    !Number.isSafeInteger(retention[key]) || retention[key] <= 0 || retention[key] > upper)) throw new Error('Invalid recovery retention contract')
  queryContract(effectQueries)
  const canonical = await realpath(common), events = await readExecutionEvents(canonical, runId)
  const groups = strictExecutionAttempts(events), attempts = [], liveReferences = new Map()
  const observedBranches = {}
  for (const ref of new Set([...Object.keys(currentBranches), ...groups.flatMap(g => g.records.flatMap(e => Object.keys(e.branches)))])) {
    try { observedBranches[ref] = git(['--git-dir=' + canonical, 'show-ref', '--verify', '--hash', ref], canonical) }
    catch { observedBranches[ref] = null }
  }
  let queriesUsed = 0
  for (const group of groups) {
    const { start, end, records } = group
    const { expected: expectedBranches, conflicts: conflictingBranches } = recordedBranches(records)
    const changedBranches = Object.keys(expectedBranches).filter(ref => conflictingBranches.includes(ref)
      || expectedBranches[ref] !== currentBranches[ref] || expectedBranches[ref] !== observedBranches[ref])
    const artifacts = [], missingArtifacts = []
    for (const reference of records.flatMap(e => e.artifacts)) {
      const key = JSON.stringify(reference)
      liveReferences.set(key, reference)
      try {
        await readExecutionArtifact({ common: canonical, runId, reference, retention })
        artifacts.push({ reference, verified: true })
      } catch { missingArtifacts.push(reference) }
    }
    const effects = []
    for (const effect of group.effects) {
      let outcome = effect.end?.kind === 'effect-completed' ? 'completed' : effect.end?.kind === 'effect-failed' ? 'failed' : 'unknown'
      let source = 'journal-observation', observation = null
      if (effect.resolution) {
        outcome = effect.resolution.resolution.outcome
        source = 'local-operator-observation'
      } else if (outcome === 'unknown' && queriesUsed < MAX_QUERIES && effect.start.effect.kind === 'pr'
          && effectQueries?.authorizedPrReferences.includes(effect.start.effect.reference)) {
        queriesUsed++
        observation = await queryPr(effect.start.effect, effectQueries, effect.start.inputs.commit)
        if (observation) { outcome = 'completed'; source = 'read-only-query' }
      }
      effects.push({ ...effect.start.effect, outcome, source, observation, retryAllowed: outcome === 'failed', authenticatedAuthorization: false })
    }
    const available = await checkoutAvailable(canonical, checkouts, start.checkout, expectedBranches)
    const unknownEffects = effects.some(e => e.outcome === 'unknown')
    const state = Date.now() - start.at > retention.maxAgeMs ? 'retention-exceeded' : start.identity !== identity ? 'stale' : changedBranches.length ? 'branch-changed'
      : missingArtifacts.length ? 'missing-artifact' : !available ? 'checkout-unavailable'
      : unknownEffects ? 'unknown-effect' : effects.some(e => e.outcome === 'failed') ? 'failed-observation' : !end ? 'interrupted' : end.kind === 'step-failed' ? 'failed-observation' : 'ready'
    attempts.push({ executionId: start.executionId, task: start.task, step: start.step, attempt: start.attempt, state,
      reuse: state === 'ready', retryAllowed: ['interrupted', 'failed-observation'].includes(state) && effects.every(e => e.retryAllowed),
      requiresCurrentGates: true, changedBranches, conflictingBranches, artifacts, missingArtifacts, effects })
  }
  const historical = events.filter(e => e.version === 1)
  if (historical.length) {
    const report = reconcileExecution(historical, { inputs, branches: currentBranches })
    attempts.push(...report.attempts.map(a => ({ ...a, state: 'historical-observation', historicalState: a.state, reuse: false, retryAllowed: false })))
  }
  return { version: 2, identity, attempts, verifiedComplete: false, unresolved: attempts.some(a => !a.reuse),
    liveReferences: [...liveReferences.values()], queriesUsed, trust: TRUST }
}
export async function resolveExecutionEffect({ common, runId, effectId, resolution, reason }) {
  if (!['completed', 'failed', 'unknown'].includes(resolution) || typeof reason !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reason)) throw new Error('Invalid bounded local operator resolution')
  const events = await readExecutionEvents(common, runId), groups = strictExecutionAttempts(events)
  const effects = groups.flatMap(group => group.effects).filter(effect => effect.start.effect.id === effectId)
  if (effects.length !== 1) throw new Error('Resolution needs one strict recorded external effect')
  const effect = effects[0]
  const at = Math.max(Date.now(), ...events.map(e => e.at + 1))
  const event = await appendExecutionEvent(common, { ...effect.start, id: randomUUID(), kind: 'effect-resolved', at,
    artifacts: [], resolution: { outcome: resolution, reason, trust: 'local-operator-observation', authenticatedAuthorization: false } })
  return { event, trust: 'local-operator-observation', authenticatedAuthorization: false }
}
