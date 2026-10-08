import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, realpath } from 'node:fs/promises'
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
async function fixture(t, { effect, complete = true, legacy = false, fileContent = 'one', trackedSymlink = false, prepare } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root)
  git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'file'), fileContent)
  if (trackedSymlink) {
    const { symlink } = await import('node:fs/promises')
    await symlink('file', path.join(root, 'link'))
  }
  if (prepare) await prepare(root)
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

async function effectRefFixture(t, { transition = false, sameTime = false, conflict = false, stepTransition = false } = {}) {
  const { appendExecutionEvent } = await import('../scripts/execution-journal.mjs')
  const f = await fixture(t, { complete: false }), start = f.records[0]
  const ref = 'refs/heads/effect-source', original = f.request.inputs.commit
  git(['branch', 'effect-source'], f.root)
  const external = { id: 'effect-1', kind: 'pr', reference: 'example/project#12' }
  const branches = { ...start.branches, [ref]: original }
  await appendExecutionEvent(f.request.common, { ...start, id: 'effect-start', kind: 'effect-started',
    at: start.at + (sameTime ? 0 : 1), branches, effect: external })
  let tip = original
  if (transition || conflict) {
    git(['checkout', 'effect-source'], f.root)
    await writeFile(path.join(f.root, 'file'), 'effect source changed')
    git(['add', '.'], f.root); git(['commit', '-m', 'effect source changed'], f.root)
    tip = git(['rev-parse', 'HEAD'], f.root)
    git(['checkout', 'main'], f.root)
  }
  await appendExecutionEvent(f.request.common, { ...start, id: 'effect-end', kind: 'effect-completed',
    at: start.at + (sameTime ? 0 : 2), branches: { ...branches, [ref]: conflict ? original : tip }, effect: external, artifacts: [f.reference] })
  if (conflict) {
    const other = { ...external, id: 'effect-2' }
    await appendExecutionEvent(f.request.common, { ...start, id: 'other-start', kind: 'effect-started',
      at: start.at + 1, branches, effect: other })
    await appendExecutionEvent(f.request.common, { ...start, id: 'other-end', kind: 'effect-completed',
      at: start.at + 2, branches: { ...branches, [ref]: tip }, effect: other, artifacts: [f.reference] })
  }
  let finalMain = original
  if (stepTransition) {
    await writeFile(path.join(f.root, 'file'), 'recorded step result')
    git(['add', '.'], f.root); git(['commit', '-m', 'recorded step result'], f.root)
    finalMain = git(['rev-parse', 'HEAD'], f.root)
  }
  await appendExecutionEvent(f.request.common, { ...start, id: 'end', kind: 'step-completed',
    at: start.at + (sameTime ? 0 : 3), branches: { 'refs/heads/main': finalMain }, artifacts: [f.reference] })
  return { ...f, ref, tip, request: { ...f.request, branches: { ...branches, [ref]: tip, 'refs/heads/main': finalMain } } }
}
test('deleted effect-only Git refs block reuse and remain visible as changed refs', async t => {
  const f = await effectRefFixture(t)
  assert.equal((await attempt(f.request)).reuse, true)
  git(['branch', '-D', 'effect-source'], f.root)
  const result = await attempt(f.request)
  assert.equal(result.state, 'branch-changed')
  assert.equal(result.reuse, false)
  assert.deepEqual(result.changedBranches, [f.ref])
})
test('moved effect-only Git refs block reuse even when caller observations follow the movement', async t => {
  const f = await effectRefFixture(t)
  git(['checkout', 'effect-source'], f.root)
  await writeFile(path.join(f.root, 'file'), 'unrecorded movement')
  git(['add', '.'], f.root); git(['commit', '-m', 'unrecorded movement'], f.root)
  const moved = git(['rev-parse', 'HEAD'], f.root)
  git(['checkout', 'main'], f.root)
  for (const branches of [f.request.branches, { ...f.request.branches, [f.ref]: moved }]) {
    const result = await attempt({ ...f.request, branches })
    assert.equal(result.state, 'branch-changed')
    assert.equal(result.reuse, false)
    assert.deepEqual(result.changedBranches, [f.ref])
  }
})
test('unordered conflicting effect ref observations block reuse instead of choosing an event id', async t => {
  const f = await effectRefFixture(t, { conflict: true })
  const result = await attempt(f.request)
  assert.equal(result.state, 'branch-changed')
  assert.equal(result.reuse, false)
  assert.deepEqual(result.changedBranches, [f.ref])
  assert.deepEqual(result.conflictingBranches, [f.ref])
})
test('recorded effect ref transitions and causal same-time outcomes retain their latest observed tips', async t => {
  for (const options of [{ transition: true }, { transition: true, sameTime: true }, { stepTransition: true }]) {
    const f = await effectRefFixture(t, options)
    assert.equal((await attempt(f.request)).state, 'ready')
    await recovery.resolveExecutionEffect({ common: f.request.common, runId: 'r1', effectId: 'effect-1', resolution: 'completed', reason: 'inspected' })
    const result = await attempt(f.request)
    assert.equal(result.reuse, true)
    assert.deepEqual(result.changedBranches, [])
  }
})
test('dirty tracked checkout content blocks reuse of otherwise current evidence', async t => {
  const f = await fixture(t)
  assert.equal((await attempt(f.request)).reuse, true)
  await writeFile(path.join(f.root, 'file'), 'uncommitted replacement')
  assert.equal(git(['status', '--porcelain'], f.root), 'M file')
  const result = await attempt(f.request)
  assert.equal(result.state, 'checkout-unavailable')
  assert.equal(result.reuse, false)
})

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test('tracked checkout bytes are verified despite ' + flag, async t => {
    const { readFile } = await import('node:fs/promises')
    const f = await fixture(t)
    git(['update-index', flag, 'file'], f.root)
    const indexFile = path.join(f.request.common, 'index')
    const before = await readFile(indexFile), refs = git(['show-ref'], f.root)
    const clean = await attempt(f.request)
    assert.equal(clean.state, 'ready')
    assert.equal(clean.reuse, true)
    assert.deepEqual(await readFile(indexFile), before)
    assert.equal(git(['show-ref'], f.root), refs)
    await writeFile(path.join(f.root, 'file'), 'different executable inputs')
    assert.equal(git(['status', '--porcelain', '--untracked-files=no'], f.root), '')
    const changed = await attempt(f.request)
    assert.equal(changed.state, 'checkout-unavailable')
    assert.equal(changed.reuse, false)
    assert.deepEqual(await readFile(indexFile), before)
    assert.equal(git(['show-ref'], f.root), refs)
  })
}

test('checkout verification does not execute configured clean filters or accept normalized changed bytes', async t => {
  const { access } = await import('node:fs/promises')
  const f = await fixture(t)
  await writeFile(path.join(f.request.common, 'info', 'attributes'), 'file filter=hide\n')
  await writeFile(path.join(f.root, 'filter.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('filter-ran', 'executed'); process.stdout.write('one'); process.stdin.resume()")
  git(['config', 'filter.hide.clean', 'node filter.mjs'], f.root)
  git(['config', 'filter.hide.required', 'true'], f.root)
  await writeFile(path.join(f.root, 'file'), 'two')
  const { utimes } = await import('node:fs/promises')
  await utimes(path.join(f.root, 'file'), new Date(Date.now() + 2000), new Date(Date.now() + 2000))
  const result = await attempt(f.request)
  await assert.rejects(access(path.join(f.root, 'filter-ran')), { code: 'ENOENT' })
  assert.equal(result.state, 'checkout-unavailable')
  assert.equal(result.reuse, false)
})
test('checkout verification rejects changed bytes hidden by text normalization', async t => {
  const f = await fixture(t, { fileContent: 'one\n' })
  await writeFile(path.join(f.request.common, 'info', 'attributes'), 'file text\n')
  git(['update-index', '--assume-unchanged', 'file'], f.root)
  await writeFile(path.join(f.root, 'file'), 'one\r\n')
  git(['config', 'core.autocrlf', 'true'], f.root)
  const result = await attempt(f.request)
  assert.equal(result.reuse, false)
})

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test('linked checkout bytes ignore ' + flag + ' while preserving its own index and refs', async t => {
    const { readFile } = await import('node:fs/promises')
    const f = await fixture(t), linked = path.join(f.root, 'linked')
    git(['checkout', '-b', 'holding'], f.root)
    git(['worktree', 'add', linked, 'main'], f.root)
    git(['update-index', flag, 'file'], linked)
    const indexFile = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], linked)
    const index = await readFile(indexFile), refs = git(['show-ref'], f.root)
    const request = { ...f.request, checkouts: { 'worker-1': linked } }
    assert.equal((await attempt(request)).reuse, true)
    assert.deepEqual(await readFile(indexFile), index)
    await writeFile(path.join(linked, 'file'), 'different linked inputs')
    assert.equal(git(['status', '--porcelain', '--untracked-files=no'], linked), '')
    assert.equal((await attempt(request)).state, 'checkout-unavailable')
    assert.deepEqual(await readFile(indexFile), index)
    assert.equal(git(['show-ref'], f.root), refs)
  })
}
test('tracked symlinks are checked as link bytes and cannot be replaced by regular files', async t => {
  const { unlink } = await import('node:fs/promises')
  const f = await fixture(t, { trackedSymlink: true })
  git(['config', 'core.symlinks', 'false'], f.root)
  assert.equal((await attempt(f.request)).reuse, true)
  await unlink(path.join(f.root, 'link'))
  await writeFile(path.join(f.root, 'link'), 'file')
  assert.equal((await attempt(f.request)).state, 'checkout-unavailable')
})
test('a staged change cannot be hidden by restoring the tracked working bytes', async t => {
  const { readFile } = await import('node:fs/promises')
  const f = await fixture(t)
  await writeFile(path.join(f.root, 'file'), 'staged replacement')
  git(['add', 'file'], f.root)
  await writeFile(path.join(f.root, 'file'), 'one')
  const index = await readFile(path.join(f.request.common, 'index'))
  const result = await attempt(f.request)
  assert.equal(result.state, 'checkout-unavailable')
  assert.equal(result.reuse, false)
  assert.deepEqual(await readFile(path.join(f.request.common, 'index')), index)
})

test('checkout verification enforces the individual tracked byte bound', async t => {
  const f = await fixture(t, { fileContent: Buffer.alloc(16 * 1024 * 1024 + 1) })
  assert.equal((await attempt(f.request)).state, 'checkout-unavailable')
})
test('checkout verification enforces the aggregate tracked byte bound', async t => {
  const { link } = await import('node:fs/promises')
  const f = await fixture(t, { fileContent: Buffer.alloc(16 * 1024 * 1024), prepare: async root => {
    for (let i = 0; i < 16; i++) await link(path.join(root, 'file'), path.join(root, 'copy-' + i))
  } })
  assert.equal((await attempt(f.request)).state, 'checkout-unavailable')
})
test('checkout verification enforces the tracked entry count bound', async t => {
  const f = await fixture(t, { prepare: async root => {
    for (let i = 0; i < 4096; i += 64) {
      await Promise.all(Array.from({ length: 64 }, (_, j) => writeFile(path.join(root, 'entry-' + (i + j)), '')))
    }
  } })
  assert.equal((await attempt(f.request)).state, 'checkout-unavailable')
})
test('checkout verification uses the supplied checkout despite core.worktree redirection', async t => {
  const f = await fixture(t), decoy = path.join(f.root, 'decoy')
  await mkdir(decoy); await writeFile(path.join(decoy, 'file'), 'one')
  git(['config', 'core.worktree', decoy], f.root)
  await writeFile(path.join(f.root, 'file'), 'different actual checkout')
  assert.equal((await attempt(f.request)).state, 'checkout-unavailable')
})
test('checkout verification refuses unsupported gitlink evidence', async t => {
  const f = await fixture(t)
  git(['update-index', '--add', '--cacheinfo', '160000', f.request.inputs.commit, 'nested'], f.root)
  git(['commit', '-m', 'gitlink observation'], f.root)
  const tip = git(['rev-parse', 'HEAD'], f.root), end = f.records.at(-1)
  const updated = { ...end, branches: { 'refs/heads/main': tip } }
  const dir = await executionDirectory(f.request.common, 'r1')
  await writeFile(path.join(dir, hash(end.id) + '.json'), JSON.stringify(updated) + '\n')
  assert.equal((await attempt({ ...f.request, branches: updated.branches })).state, 'checkout-unavailable')
})

async function implementationPrFixture(t, { later = false, ambiguous = false, equalTips = false } = {}) {
  const f = await fixture(t, { complete: false })
  const { appendExecutionEvent, readExecutionEvents } = await import('../scripts/execution-journal.mjs')
  const start = f.records[0], anchored = f.request.inputs.commit
  await writeFile(path.join(f.root, 'file'), 'implementation')
  git(['add', 'file'], f.root); git(['commit', '-m', 'implementation'], f.root)
  const source = git(['rev-parse', 'HEAD'], f.root)
  const branches = { 'refs/heads/main': source }
  if (ambiguous) {
    git(['branch', 'other-source', equalTips ? source : anchored], f.root)
    branches['refs/heads/other-source'] = equalTips ? source : anchored
  }
  await appendExecutionEvent(f.request.common, { ...start, id: 'pr-start', kind: 'effect-started', at: start.at + 1,
    branches, effect: { id: 'pr-1', kind: 'pr', reference: 'example/project#12' } })
  if (later) {
    await writeFile(path.join(f.root, 'file'), 'later change')
    git(['add', 'file'], f.root); git(['commit', '-m', 'later change'], f.root)
  }
  const current = git(['rev-parse', 'HEAD'], f.root)
  await appendExecutionEvent(f.request.common, { ...start, id: 'end', kind: 'step-completed', at: start.at + 2,
    branches: { 'refs/heads/main': current }, artifacts: [f.reference] })
  const records = await readExecutionEvents(f.request.common, 'r1')
  assert.ok(records.every(record => record.inputs.commit === anchored && record.identity === start.identity))
  return { ...f, anchored, source, current, request: { ...f.request, branches: { ...branches, 'refs/heads/main': current } } }
}
const simulatedPr = headRefOid => ({ authorizedPrReferences: ['example/project#12'],
  queryPr: async () => ({ stdout: JSON.stringify({ number: 12, state: 'OPEN', headRefOid }) }) })
test('PR query matches the recorded implementation source while preserving anchored inputs', async t => {
  const f = await implementationPrFixture(t)
  assert.notEqual(f.anchored, f.source)
  const observed = await attempt({ ...f.request, effectQueries: simulatedPr(f.source) })
  assert.equal(observed.state, 'ready')
  assert.equal(observed.reuse, true)
  assert.equal(observed.effects[0].observation.headRefOid, f.source)
  assert.equal(observed.effects[0].retryAllowed, false)
})
test('obsolete anchored PR head cannot substitute for the recorded implementation source', async t => {
  const f = await implementationPrFixture(t)
  const observed = await attempt({ ...f.request, effectQueries: simulatedPr(f.anchored) })
  assert.equal(observed.state, 'unknown-effect')
  assert.equal(observed.reuse, false)
  assert.equal(observed.retryAllowed, false)
  assert.equal(observed.effects[0].observation, null)
})
test('PR source snapshot belongs to effect start rather than a later end ref', async t => {
  const f = await implementationPrFixture(t, { later: true })
  assert.notEqual(f.source, f.current)
  assert.equal((await attempt({ ...f.request, effectQueries: simulatedPr(f.source) })).reuse, true)
  assert.equal((await attempt({ ...f.request, effectQueries: simulatedPr(f.current) })).state, 'unknown-effect')
})
for (const equalTips of [false, true]) {
  test('multiple effect-start refs remain unresolved with ' + (equalTips ? 'equal' : 'different') + ' tips', async t => {
    const f = await implementationPrFixture(t, { ambiguous: true, equalTips })
    let calls = 0
    const report = await recovery.reconcileExecutionAttempt({ ...f.request, effectQueries: {
      authorizedPrReferences: ['example/project#12'], queryPr: async () => {
        calls++; return { stdout: JSON.stringify({ number: 12, state: 'OPEN', headRefOid: f.anchored }) }
      } } })
    assert.equal(calls, 0)
    assert.equal(report.queriesUsed, 0)
    assert.equal(report.attempts[0].state, 'unknown-effect')
    assert.equal(report.attempts[0].reuse, false)
    assert.equal(report.attempts[0].retryAllowed, false)
  })
}
for (const scope of ['parent', 'run']) {
  test('recovery rejects deleted unknown-effect evidence in writable ' + scope + ' storage', async t => {
    const { chmod, unlink } = await import('node:fs/promises')
    const f = await fixture(t, { effect: { id: 'effect-1', kind: 'publication', reference: null } })
    assert.equal((await attempt(f.request)).state, 'unknown-effect')
    const directory = await executionDirectory(f.request.common, 'r1')
    await chmod(scope === 'parent' ? path.dirname(directory) : directory, 0o777)
    await unlink(path.join(directory, hash('effect') + '.json'))
    await assert.rejects(recovery.reconcileExecutionAttempt(f.request), /Unsafe execution directory/)
  })
  test('operator resolution rejects writable ' + scope + ' journal storage before trusting history', async t => {
    const { chmod, readdir } = await import('node:fs/promises')
    const f = await fixture(t, { effect: { id: 'effect-1', kind: 'publication', reference: null } })
    const directory = await executionDirectory(f.request.common, 'r1'), before = await readdir(directory)
    await chmod(scope === 'parent' ? path.dirname(directory) : directory, 0o777)
    await assert.rejects(recovery.resolveExecutionEffect({ common: f.request.common, runId: 'r1', effectId: 'missing',
      resolution: 'completed', reason: 'inspected' }), /Unsafe execution directory/)
    assert.deepEqual(await readdir(directory), before)
  })
}
test('missing effect source snapshot is rejected before a PR query', async t => {
  const f = await implementationPrFixture(t)
  const { readExecutionEvents } = await import('../scripts/execution-journal.mjs')
  const record = (await readExecutionEvents(f.request.common, 'r1')).find(e => e.id === 'pr-start')
  const directory = await executionDirectory(f.request.common, 'r1')
  await writeFile(path.join(directory, hash(record.id) + '.json'), JSON.stringify({ ...record, branches: {} }) + '\n')
  let calls = 0
  await assert.rejects(recovery.reconcileExecutionAttempt({ ...f.request, effectQueries: {
    authorizedPrReferences: ['example/project#12'], queryPr: async () => { calls++ }
  } }), /branch observations/)
  assert.equal(calls, 0)
})

async function advance(root, label) {
  await writeFile(path.join(root, 'file'), label)
  git(['add', '.'], root); git(['commit', '-q', '-m', label], root)
  return git(['rev-parse', 'HEAD'], root)
}
test('an attempt whose only mismatch is a ref advanced to or past an expected advance is superseded, not unresolved', async t => {
  const f = await fixture(t)
  const integrated = await advance(f.root, 'integrated'), later = await advance(f.root, 'later')
  const current = { ...f.request, branches: { 'refs/heads/main': later } }
  const main = to => [{ ref: 'refs/heads/main', to }]
  assert.equal((await attempt(current)).state, 'branch-changed')
  for (const to of [later, integrated]) {
    const report = await recovery.reconcileExecutionAttempt({ ...current, expectedAdvances: main(to) })
    assert.equal(report.attempts[0].state, 'superseded')
    assert.equal(report.attempts[0].reuse, false)
    assert.equal(report.attempts[0].retryAllowed, false)
    assert.deepEqual(report.attempts[0].changedBranches, ['refs/heads/main'])
    assert.equal(report.unresolved, false)
  }
  git(['checkout', '-q', '-b', 'side', f.request.inputs.commit], f.root)
  const side = await advance(f.root, 'side')
  git(['checkout', '-q', 'main'], f.root)
  const sideways = await recovery.reconcileExecutionAttempt({ ...current, expectedAdvances: main(side) })
  assert.equal(sideways.attempts[0].state, 'branch-changed')
  assert.equal(sideways.unresolved, true)
  assert.equal((await attempt({ ...current, expectedAdvances: [{ ref: 'refs/heads/side', to: side }] })).state, 'branch-changed')
  assert.equal((await attempt({ ...f.request, branches: { 'refs/heads/main': integrated }, expectedAdvances: main(integrated) })).state, 'branch-changed')
  await rm(f.artifactFile)
  assert.equal((await attempt({ ...current, expectedAdvances: main(integrated) })).state, 'missing-artifact')
  for (const expectedAdvances of ['refs/heads/main', [{ ref: 'main', to: later }], [{ ref: 'refs/heads/main', to: 'abc' }],
    [{ ref: 'refs/heads/main', to: later, extra: 1 }], Array(101).fill({ ref: 'refs/heads/main', to: later })]) {
    await assert.rejects(recovery.reconcileExecutionAttempt({ ...current, expectedAdvances }), /expected advances/)
  }
})
test('an interrupted agent dispatch resolved not-started may be redispatched and one resolved completed may not', async t => {
  for (const [outcome, retry] of [['not-started', true], ['completed', false]]) {
    const f = await fixture(t, { complete: false, effect: { id: 'dispatch-1', kind: 'agent-dispatch', reference: null } })
    const request = { common: f.request.common, runId: 'r1', effectId: 'dispatch-1', reason: 'operator-inspected' }
    const before = await attempt(f.request)
    assert.equal(before.state, 'unknown-effect')
    assert.equal(before.retryAllowed, false)
    for (const resolution of ['failed', 'unknown', 'bogus']) await assert.rejects(recovery.resolveExecutionEffect({ ...request, resolution }), /bounded local operator resolution/)
    const resolved = await recovery.resolveExecutionEffect({ ...request, resolution: outcome })
    assert.equal(resolved.event.resolution.outcome, outcome)
    const after = await attempt(f.request)
    assert.equal(after.effects[0].outcome, outcome)
    assert.equal(after.state, 'interrupted')
    assert.equal(after.retryAllowed, retry)
  }
  const vault = await fixture(t, { complete: false, effect: { id: 'effect-1', kind: 'vault', reference: null } })
  await assert.rejects(recovery.resolveExecutionEffect({ common: vault.request.common, runId: 'r1', effectId: 'effect-1', resolution: 'not-started', reason: 'inspected' }), /bounded local operator resolution/)
  const shell = await fixture(t, { complete: false, effect: { id: 'effect-1', kind: 'agent-dispatch', reference: null } })
  const dir = await executionDirectory(shell.request.common, 'r1'), planted = shell.records.find(record => record.id === 'effect')
  await writeFile(path.join(dir, hash(planted.id) + '.json'), JSON.stringify({ ...planted, effect: { ...planted.effect, kind: 'shell' } }) + '\n')
  await assert.rejects(recovery.resolveExecutionEffect({ common: shell.request.common, runId: 'r1', effectId: 'effect-1', resolution: 'not-started', reason: 'inspected' }), /effect/)
})
test('recovery exposes reconcileExecution and bounds retention by RETENTION_LIMITS', async t => {
  const { RETENTION_LIMITS } = await import('../scripts/execution-artifacts.mjs')
  assert.equal(recovery.reconcileExecution, recovery.reconcileExecutionAttempt)
  const f = await fixture(t)
  assert.equal((await attempt({ ...f.request, retention: { ...RETENTION_LIMITS } })).state, 'ready')
  for (const key of Object.keys(RETENTION_LIMITS)) {
    await assert.rejects(recovery.reconcileExecutionAttempt({ ...f.request, retention: { ...RETENTION_LIMITS, [key]: RETENTION_LIMITS[key] + 1 } }), /retention/)
  }
})

// Open item 13: attempt-1 ends step-failed, then each later attempt is planted after it with its own
// start and, unless `end` is null, its outcome. `failedEffect` gives attempt-1 a failed external effect.
async function retried(t, later, { failedEffect = false } = {}) {
  const f = await fixture(t, { complete: false, effect: failedEffect ? { id: 'effect-1', kind: 'publication', reference: null } : undefined })
  const base = f.records[0], dir = await executionDirectory(f.request.common, 'r1')
  const records = []
  if (failedEffect) records.push({ ...f.records[1], id: 'effect-end', kind: 'effect-failed' })
  records.push({ ...base, id: 'fail-1', kind: 'step-failed', at: base.at + 2 })
  later.forEach(({ end, ...fields }, i) => {
    const retry = { ...base, attempt: `attempt-${i + 2}`, at: base.at + 10 * (i + 1), ...fields }
    records.push({ ...retry, id: `start-${i + 2}`, kind: 'step-started' })
    if (end) records.push({ ...retry, id: `end-${i + 2}`, kind: end, at: retry.at + 1, artifacts: end === 'step-completed' ? [f.reference] : [] })
  })
  for (const record of records) await writeFile(path.join(dir, hash(record.id) + '.json'), JSON.stringify(record) + '\n', { mode: 0o600 })
  const report = await recovery.reconcileExecutionAttempt(f.request)
  return { report, failed: report.attempts.find(a => a.attempt === 'attempt-1') }
}
test('a failed attempt followed by a completed attempt of the same execution, task and step is superseded', async t => {
  const { report, failed } = await retried(t, [{ end: 'step-completed' }])
  assert.equal(failed.state, 'superseded')
  assert.equal(failed.reuse, false)
  assert.equal(failed.retryAllowed, false)
  assert.equal(report.attempts.find(a => a.attempt === 'attempt-2').state, 'ready')
  assert.equal(report.unresolved, false)
  const twice = await retried(t, [{ end: 'step-failed' }, { end: 'step-completed' }])
  assert.deepEqual(twice.report.attempts.map(a => [a.attempt, a.state]).sort(),
    [['attempt-1', 'superseded'], ['attempt-2', 'superseded'], ['attempt-3', 'ready']])
  assert.equal(twice.report.unresolved, false)
})
for (const [label, later] of [
  ['no later attempt', []],
  ['a later attempt that only started', [{ end: null }]],
  ['a later attempt that failed again', [{ end: 'step-failed' }]],
  ['a later completed attempt under another executionId', [{ end: 'step-completed', executionId: 'execution-2' }]],
  ['a later completed attempt of another task', [{ end: 'step-completed', task: 'T2' }]],
  ['a later completed attempt of another step', [{ end: 'step-completed', step: 'other' }]],
]) {
  test(`a failed attempt with ${label} stays failed-observation and unresolved`, async t => {
    const { report, failed } = await retried(t, later)
    assert.equal(failed.state, 'failed-observation')
    assert.equal(failed.retryAllowed, true)
    assert.equal(report.unresolved, true)
  })
}
test('an earlier completed attempt does not supersede a later failed attempt', async t => {
  const { report, failed } = await retried(t, [{ end: 'step-completed', at: Date.now() - 1000 }])
  assert.equal(failed.state, 'failed-observation')
  assert.equal(report.unresolved, true)
})
test('a failed attempt whose external effect failed is not superseded by a completed retry', async t => {
  const { report, failed } = await retried(t, [{ end: 'step-completed' }], { failedEffect: true })
  assert.equal(failed.effects[0].outcome, 'failed')
  assert.equal(failed.state, 'failed-observation')
  assert.equal(report.unresolved, true)
})
// Modelled on the T5 driver fixture in tests/workflow-controller.test.mjs with outcomes
// ['step-failed', 'step-completed']: two `verification` attempts of one executionId and task, each a
// start plus its outcome with a retained driver-verification artifact. The checkout is the root so
// the completed attempt is current without an integration advance.
test('workflow-status reconciles a run whose driver verification failed and then completed', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recovery-cli-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-q', '-b', 'main'], root)
  await writeFile(path.join(root, 'file'), 'one'); git(['add', '.'], root)
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'baseline'], root)
  const common = discover(root).common, commit = git(['rev-parse', 'HEAD'], root)
  const inputs = { commit, ...Object.fromEntries(['plan', 'manifest', 'context', 'environment', 'verifier'].map(k => [k, hash(k)])) }
  const { appendExecutionEvent } = await import('../scripts/execution-journal.mjs')
  const { runCli } = await import('../scripts/cli.mjs')
  const status = async () => {
    const lines = []
    const code = await runCli(['workflow-status', '--run', 'r1', '--root', root], { out: line => lines.push(line), err: () => {} })
    return { code, report: JSON.parse(lines.join('\n')) }
  }
  let clock = Date.now()
  for (const kind of ['step-failed', 'step-completed']) {
    const base = { version: 2, runId: 'r1', executionId: 'execution-1', task: 'T1', step: 'verification', attempt: `attempt-${kind}`,
      inputs, identity: strictExecutionIdentity(inputs), branches: { 'refs/heads/main': commit }, checkout: 'root', artifacts: [], effect: null, resolution: null }
    await appendExecutionEvent(common, { ...base, id: `start-${kind}`, kind: 'step-started', at: clock++ }, { requireFreshStart: true })
    const bytes = Buffer.from(JSON.stringify({ version: 1, code: kind === 'step-completed' ? 0 : 3, scope: 'enforcement-only', attempt: base.attempt }))
    const { reference } = await retainExecutionArtifact({ common, runId: 'r1', kind: 'driver-verification', bytes, retention })
    await appendExecutionEvent(common, { ...base, id: `end-${kind}`, kind, at: clock++, artifacts: [reference] })
    if (kind === 'step-failed') assert.equal((await status()).code, 4, 'a lone failed verification is unresolved')
  }
  const { code, report } = await status()
  assert.equal(code, 0, JSON.stringify(report))
  assert.equal(report.state, 'reconciled')
  assert.deepEqual(report.attempts.map(a => [a.attempt, a.state]).sort(), [['attempt-step-completed', 'ready'], ['attempt-step-failed', 'superseded']])
})
