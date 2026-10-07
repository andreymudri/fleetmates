import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, mkdtemp, rm, open, lstat, readlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
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
const CHECKOUT_LIMITS = { files: 4096, fileBytes: 16 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 }
async function trackedBytesMatch(root, entries) {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK || entries.length > CHECKOUT_LIMITS.files) return false
  let total = 0
  for (const entry of entries) {
    const match = /^(100644|100755|120000) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/.exec(entry)
    if (!match) return false
    const [, mode, expected, name] = match
    if (path.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) return false
    const file = path.join(root, name)
    if (await realpath(path.dirname(file)) !== path.dirname(file)) return false
    const before = await lstat(file)
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > CHECKOUT_LIMITS.fileBytes
        || (total += before.size) > CHECKOUT_LIMITS.totalBytes) return false
    let bytes
    if (mode === '120000') {
      if (!before.isSymbolicLink()) return false
      bytes = await readlink(file, { encoding: 'buffer' })
    } else {
      if (!before.isFile() || Boolean(before.mode & 0o100) !== (mode === '100755')) return false
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return false
        const buffer = Buffer.alloc(before.size + 1)
        let offset = 0
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
          if (!bytesRead) break
          offset += bytesRead
        }
        if (offset !== before.size) return false
        bytes = buffer.subarray(0, offset)
      } finally { await handle.close() }
    }
    const after = await lstat(file)
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.mode !== before.mode) return false
    const actual = createHash(expected.length === 40 ? 'sha1' : 'sha256').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
    if (actual !== expected) return false
  }
  return true
}
async function checkoutAvailable(common, checkouts, id, branches) {
  const supplied = checkouts[id]
  if (typeof supplied !== 'string' || !path.isAbsolute(supplied)) return false
  let temporary
  try {
    const root = await realpath(supplied)
    if (await realpath(discover(root).common) !== common) return false
    const gitDir = git(['rev-parse', '--absolute-git-dir'], root)
    const args = ['--git-dir=' + gitDir, '--work-tree=' + root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.sparseCheckout=false', '-c', 'core.sparseCheckoutCone=false', '-c', 'index.sparse=false', '-c', 'core.splitIndex=false', '-c', 'core.ignorestat=false']
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    const options = { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8', env: { ...env, GIT_OPTIONAL_LOCKS: '0' } }
    const run = async (argv, settings = options) => (await execute('git', [...args, ...argv], settings)).stdout.trim()
    const ref = await run(['symbolic-ref', '--quiet', 'HEAD'])
    if (!Object.hasOwn(branches, ref) || await run(['rev-parse', '--verify', 'HEAD']) !== branches[ref]) return false
    const index = await run(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    await run(['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv', branches[ref], '--'],
      { ...options, env: { ...options.env, GIT_INDEX_FILE: index } })
    temporary = await mkdtemp(path.join(tmpdir(), 'recovery-index-'))
    const privateOptions = { ...options, env: { ...options.env, GIT_INDEX_FILE: path.join(temporary, 'index') } }
    await run(['read-tree', branches[ref]], privateOptions)
    const result = await execute('git', [...args, 'ls-files', '--stage', '-z'], { ...privateOptions, encoding: 'buffer' })
    const text = new TextDecoder('utf8', { fatal: true }).decode(result.stdout)
    if ((text && !text.endsWith('\0')) || !await trackedBytesMatch(root, text ? text.slice(0, -1).split('\0') : [])) return false
    return await run(['rev-parse', '--verify', 'HEAD']) === branches[ref] && await run(['symbolic-ref', '--quiet', 'HEAD']) === ref
  } catch { return false }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
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
