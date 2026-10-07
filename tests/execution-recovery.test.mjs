import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { git, discover } from '../scripts/workflow-lifecycle.mjs'
import { strictExecutionIdentity } from '../scripts/completion-obligations.mjs'
import { retainExecutionArtifact } from '../scripts/execution-artifacts.mjs'
import { executionDirectory } from '../scripts/execution-journal.mjs'

import * as recovery from '../scripts/execution-recovery.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const retention = { maxArtifactBytes: 1024, maxRunBytes: 4096, maxAgeMs: 86400000 }
async function fixture(t, { effect, complete = true, legacy = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root)
  git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'file'), 'one')
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const common = discover(root).common, runId = 'r1', commit = git(['rev-parse', 'HEAD'], root)
  const inputs = { commit, ...Object.fromEntries(['plan', 'manifest', 'context', 'environment', 'verifier'].map(k => [k, hash(k)])) }
  const branches = { 'refs/heads/main': commit }
  const { reference } = await retainExecutionArtifact({ common, runId, kind: 'stdout', bytes: Buffer.from('observed output'), retention })
  const base = { version: 2, runId, executionId: 'execution-1', task: 'T1', step: 'command', attempt: 'attempt-1',
    at: Date.now(), inputs, identity: strictExecutionIdentity(inputs), branches, checkout: 'worker-1', artifacts: [], effect: null, resolution: null }
  const records = [{ ...base, id: 'start', kind: 'step-started' }]
  if (effect) records.push({ ...base, id: 'effect', kind: 'effect-started', at: base.at + 1, effect })
  if (complete) records.push({ ...base, id: 'end', kind: 'step-completed', at: base.at + 2, artifacts: [reference] })
  if (legacy) for (const record of records) {
    record.version = 1; record.inputs = { ...record.inputs }; delete record.inputs.context; delete record.identity
    for (const key of ['executionId', 'task', 'checkout', 'artifacts', 'resolution']) delete record[key]
  }
  const dir = await executionDirectory(common, runId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const record of records) await writeFile(path.join(dir, hash(record.id) + '.json'), JSON.stringify(record) + '\n', { mode: 0o600 })
  const request = { common, runId, inputs, branches, retention, checkouts: { 'worker-1': root } }
  return { root, request, records, reference, artifactFile: path.join(common, 'fleetmates-artifacts', hash(runId), hash(JSON.stringify(reference)) + '.bin') }
}
const attempt = async request => (await recovery.reconcileExecutionAttempt(request)).attempts[0]

test('actual retained artifact changes and disappearance refuse reuse', async t => {
  const f = await fixture(t)
  await writeFile(f.artifactFile, 'altered output')
  assert.equal((await attempt(f.request)).state, 'missing-artifact')
  assert.equal((await attempt(f.request)).reuse, false)
  await rm(f.artifactFile)
  assert.equal((await attempt(f.request)).state, 'missing-artifact')
})
test('all strict inputs and actual Git ref changes refuse reuse', async t => {
  const f = await fixture(t)
  for (const key of Object.keys(f.request.inputs)) {
    const value = key === 'commit' ? 'b'.repeat(40) : hash('changed-' + key)
    assert.equal((await attempt({ ...f.request, inputs: { ...f.request.inputs, [key]: value } })).state, 'stale')
  }
  await writeFile(path.join(f.root, 'file'), 'two'); git(['add', '.'], f.root); git(['commit', '-m', 'changed'], f.root)
  assert.equal((await attempt(f.request)).state, 'branch-changed')
  const current = git(['rev-parse', 'HEAD'], f.root)
  assert.equal((await attempt({ ...f.request, branches: { 'refs/heads/main': current } })).state, 'branch-changed')
})
test('strict retained observations require current checkout and never claim completion', async t => {
  const f = await fixture(t)
  const report = await recovery.reconcileExecutionAttempt(f.request)
  assert.equal(report.attempts[0].state, 'ready')
  assert.equal(report.attempts[0].reuse, true)
  assert.equal(report.verifiedComplete, false)
  assert.equal(report.attempts[0].requiresCurrentGates, true)
  assert.equal((await attempt({ ...f.request, checkouts: {} })).state, 'checkout-unavailable')
  assert.equal((await attempt({ ...f.request, checkouts: { 'worker-1': path.join(f.root, 'absent') } })).reuse, false)
})
test('legacy journal observations never become strict reusable proof', async t => {
  const f = await fixture(t, { legacy: true })
  assert.equal((await attempt(f.request)).state, 'historical-observation')
  assert.equal((await attempt(f.request)).reuse, false)
})
test('unknown PR, Vault and publication outcomes prohibit retries even with stale inputs', async t => {
  for (const kind of ['pr', 'vault', 'publication']) {
    const f = await fixture(t, { effect: { id: 'effect-1', kind, reference: kind === 'pr' ? 'example/project#12' : null } })
    const result = await attempt(f.request)
    assert.equal(result.state, 'unknown-effect')
    assert.equal(result.retryAllowed, false)
    assert.equal((await attempt({ ...f.request, inputs: { ...f.request.inputs, context: hash('other') } })).retryAllowed, false)
  }
})

test('authorized fixture-backed PR query uses fixed read-only argv and returns only whitelisted fields', async t => {
  const f = await fixture(t, { effect: { id: 'effect-1', kind: 'pr', reference: 'example/project#12' } })
  let calls = 0
  const effectQueries = { authorizedPrReferences: ['example/project#12'], queryPr: async request => {
    calls++
    assert.deepEqual(request, { file: 'gh', args: ['pr', 'view', '12', '--repo', 'example/project', '--json', 'number,state,headRefOid'], timeoutMs: 5000, maxBuffer: 4096 })
    return { stdout: JSON.stringify({ number: 12, state: 'OPEN', headRefOid: f.request.inputs.commit, body: 'private-body', token: 'private-token' }), stderr: 'private-stderr' }
  } }
  const report = await recovery.reconcileExecutionAttempt({ ...f.request, effectQueries })
  assert.equal(calls, 1)
  assert.equal(report.attempts[0].state, 'ready')
  assert.deepEqual(report.attempts[0].effects[0].observation, { number: 12, state: 'OPEN', headRefOid: f.request.inputs.commit })
  assert.equal(report.attempts[0].effects[0].retryAllowed, false)
  assert.equal(report.attempts[0].effects[0].authenticatedAuthorization, false)
  assert.equal(JSON.stringify(report).includes('private-'), false)
  assert.equal(JSON.stringify(report).includes(f.root), false)
})
test('unauthorized and unsupported queries never run, and malformed or failed PR queries remain unknown', async t => {
  for (const kind of ['pr', 'vault', 'publication']) {
    const f = await fixture(t, { effect: { id: 'effect-1', kind, reference: kind === 'pr' ? 'example/project#12' : null } })
    let called = false
    const result = await attempt({ ...f.request, effectQueries: { authorizedPrReferences: [], queryPr: async () => { called = true } } })
    assert.equal(called, false)
    assert.equal(result.state, 'unknown-effect')
  }
  const f = await fixture(t, { effect: { id: 'effect-1', kind: 'pr', reference: 'example/project#12' } })
  const valid = { number: 12, state: 'OPEN', headRefOid: f.request.inputs.commit }
  for (const result of [ { stdout: 'not-json' }, { stdout: 'x'.repeat(4097) }, { stdout: JSON.stringify({ ...valid, body: 'x'.repeat(4096) }) }, { stdout: JSON.stringify({ ...valid, number: 13 }) },
    { stdout: JSON.stringify({ ...valid, state: 'CREATED' }) }, { stdout: JSON.stringify({ ...valid, headRefOid: 'branch' }) },
    { stdout: JSON.stringify(valid), code: 1 } ]) {
    const observed = await attempt({ ...f.request, effectQueries: { authorizedPrReferences: ['example/project#12'], queryPr: async () => result } })
    assert.equal(observed.state, 'unknown-effect')
    assert.equal(observed.retryAllowed, false)
  }
  const observed = await attempt({ ...f.request, effectQueries: { authorizedPrReferences: ['example/project#12'], queryPr: async () => { throw new Error('private-failure') } } })
  assert.equal(observed.state, 'unknown-effect')
  await assert.rejects(recovery.reconcileExecutionAttempt({ ...f.request, effectQueries: { authorizedPrReferences: ['https://invalid/pr/12'] } }), /queries/)
  await assert.rejects(recovery.reconcileExecutionAttempt({ ...f.request, effectQueries: { authorizedPrReferences: [], command: 'unsafe' } }), /queries/)
})
test('local operator resolution persists bounded observations without authenticating authorization or creating effects', async t => {
  const f = await fixture(t, { effect: { id: 'effect-1', kind: 'vault', reference: null } })
  const request = { common: f.request.common, runId: 'r1', effectId: 'effect-1', reason: 'operator-inspected' }
  const unknown = await recovery.resolveExecutionEffect({ ...request, resolution: 'unknown' })
  assert.equal(unknown.authenticatedAuthorization, false)
  assert.equal((await attempt(f.request)).retryAllowed, false)
  const resolved = await recovery.resolveExecutionEffect({ ...request, resolution: 'completed' })
  assert.equal(resolved.trust, 'local-operator-observation')
  const observed = await attempt(f.request)
  assert.equal(observed.state, 'ready')
  assert.equal(observed.effects[0].source, 'local-operator-observation')
  assert.equal(observed.effects[0].retryAllowed, false)
  assert.equal(observed.effects[0].authenticatedAuthorization, false)
  await recovery.resolveExecutionEffect({ ...request, resolution: 'failed' })
  assert.equal((await attempt(f.request)).effects[0].outcome, 'failed')
  await assert.rejects(recovery.resolveExecutionEffect({ ...request, resolution: 'completed', reason: 'free form secret' }), /bounded/)
  await assert.rejects(recovery.resolveExecutionEffect({ ...request, resolution: 'authorized' }), /bounded/)
  await assert.rejects(recovery.resolveExecutionEffect({ ...request, effectId: 'missing', resolution: 'completed' }), /one strict/)
})
test('interrupted current steps can retry, but unknown and completed effects cannot be repeated', async t => {
  const plain = await fixture(t, { complete: false })
  assert.equal((await attempt(plain.request)).retryAllowed, true)
  for (const outcome of ['unknown', 'completed', 'failed']) {
    const f = await fixture(t, { complete: false, effect: { id: 'effect-1', kind: 'publication', reference: null } })
    await recovery.resolveExecutionEffect({ common: f.request.common, runId: 'r1', effectId: 'effect-1', resolution: outcome, reason: 'observed' })
    assert.equal((await attempt(f.request)).retryAllowed, outcome === 'failed')
  }
})
test('artifact identity and run binding cannot be substituted in persisted records', async t => {
  const f = await fixture(t)
  const end = f.records.at(-1), dir = await executionDirectory(f.request.common, 'r1'), file = path.join(dir, hash(end.id) + '.json')
  await writeFile(file, JSON.stringify({ ...end, artifacts: [{ ...f.reference, sha256: hash('other-content') }] }) + '\n')
  assert.equal((await attempt(f.request)).reuse, false)
  await writeFile(file, JSON.stringify({ ...end, artifacts: [{ ...f.reference, runId: 'other-run' }] }) + '\n')
  await assert.rejects(attempt(f.request), /artifact identity/)
})

test('expired attempt retention refuses reuse and redispatch while preserving live evidence', async t => {
  const f = await fixture(t), dir = await executionDirectory(f.request.common, 'r1')
  for (const record of f.records) {
    await writeFile(path.join(dir, hash(record.id) + '.json'), JSON.stringify({ ...record, at: record.at - 2000 }) + '\n')
  }
  const report = await recovery.reconcileExecutionAttempt({ ...f.request, retention: { ...retention, maxAgeMs: 1000 } })
  assert.equal(report.attempts[0].state, 'retention-exceeded')
  assert.equal(report.attempts[0].retryAllowed, false)
  assert.deepEqual(report.liveReferences, [f.reference])
  const { readExecutionArtifact } = await import('../scripts/execution-artifacts.mjs')
  assert.deepEqual(await readExecutionArtifact({ ...f.request, reference: f.reference }), Buffer.from('observed output'))
  await assert.rejects(recovery.reconcileExecutionAttempt({ ...f.request, retention: undefined }), /retention/)
})
test('a checkout on another branch cannot substitute for the observed worker checkout', async t => {
  const f = await fixture(t)
  git(['checkout', '-b', 'unrelated'], f.root)
  assert.equal((await attempt(f.request)).state, 'checkout-unavailable')
  assert.equal((await attempt(f.request)).reuse, false)
})
test('PR responses for another source or incomplete executor outcomes stay unknown', async t => {
  const f = await fixture(t, { effect: { id: 'effect-1', kind: 'pr', reference: 'example/project#12' } })
  const valid = { number: 12, state: 'OPEN', headRefOid: f.request.inputs.commit }
  for (const result of [{ stdout: JSON.stringify({ ...valid, headRefOid: 'c'.repeat(40) }) },
    { stdout: JSON.stringify(valid), exitCode: 1 }, { stdout: JSON.stringify(valid), signal: 'SIGTERM' },
    { stdout: JSON.stringify(valid), truncated: true }]) {
    const resultAttempt = await attempt({ ...f.request, effectQueries: { authorizedPrReferences: ['example/project#12'], queryPr: async () => result } })
    assert.equal(resultAttempt.state, 'unknown-effect')
  }
})

test('read-only queries have a finite total count and a finite per-query deadline', { timeout: 15000 }, async t => {
  const f = await fixture(t, { effect: { id: 'effect-1', kind: 'pr', reference: 'example/project#12' } })
  const directory = await executionDirectory(f.request.common, 'r1'), start = f.records[0]
  for (let i = 2; i <= 21; i++) {
    const record = { ...f.records[1], id: 'effect-' + i, effect: { ...f.records[1].effect, id: 'effect-' + i }, at: start.at + i }
    await writeFile(path.join(directory, hash(record.id) + '.json'), JSON.stringify(record) + '\n', { mode: 0o600 })
  }
  const end = { ...f.records.at(-1), at: start.at + 22 }
  await writeFile(path.join(directory, hash(end.id) + '.json'), JSON.stringify(end) + '\n')
  let calls = 0
  const report = await recovery.reconcileExecutionAttempt({ ...f.request, effectQueries: { authorizedPrReferences: ['example/project#12'],
    queryPr: async () => { calls++; return { stdout: JSON.stringify({ number: 12, state: 'OPEN', headRefOid: f.request.inputs.commit }) } } } })
  assert.equal(calls, 20)
  assert.equal(report.queriesUsed, 20)
  assert.equal(report.attempts[0].state, 'unknown-effect')
  await assert.rejects(recovery.reconcileExecutionAttempt({ ...f.request, effectQueries: { authorizedPrReferences: Array(21).fill('example/project#12') } }), /queries/)
  const deadline = await fixture(t, { effect: { id: 'effect-1', kind: 'pr', reference: 'example/project#12' } })
  const began = Date.now()
  const observed = await attempt({ ...deadline.request, effectQueries: { authorizedPrReferences: ['example/project#12'], queryPr: () => new Promise(() => {}) } })
  assert.equal(observed.state, 'unknown-effect')
  assert.ok(Date.now() - began < 10000)
})

test('a failed external effect cannot be reused as a successful step observation', async t => {
  const f = await fixture(t, { effect: { id: 'effect-1', kind: 'publication', reference: null } })
  await recovery.resolveExecutionEffect({ common: f.request.common, runId: 'r1', effectId: 'effect-1', resolution: 'failed', reason: 'observed' })
  const observed = await attempt(f.request)
  assert.equal(observed.state, 'failed-observation')
  assert.equal(observed.reuse, false)
  assert.equal(observed.retryAllowed, true)
})

test('abrupt disappearance after a strict persisted effect start leaves a non-retryable unknown outcome', { timeout: 15000 }, async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const f = await fixture(t, { complete: false }), start = f.records[0]
  const event = { ...start, id: 'effect', kind: 'effect-started', at: start.at + 1, effect: { id: 'effect-1', kind: 'vault', reference: null } }
  const module = new URL('../scripts/execution-journal.mjs', import.meta.url).href
  const source = `import { runAfterExecutionStart } from ${JSON.stringify(module)}; await runAfterExecutionStart({ common: ${JSON.stringify(f.request.common)}, event: ${JSON.stringify(event)}, action: () => console.log('persisted') }); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const exit = once(child, 'exit')
  await Promise.race([once(child.stdout, 'data'), exit.then(() => { throw new Error('Recorder exited before persistence') })])
  child.kill('SIGKILL'); await exit
  const observed = await attempt(f.request)
  assert.equal(observed.state, 'unknown-effect')
  assert.equal(observed.retryAllowed, false)
})
