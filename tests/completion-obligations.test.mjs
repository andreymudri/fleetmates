import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { strictExecutionIdentity, summarizeCompletionObligations } from '../scripts/completion-obligations.mjs'
import { git } from '../scripts/workflow-lifecycle.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const sha = 'a'.repeat(40), tree = 'b'.repeat(40)
const inputs = { commit: sha, ...Object.fromEntries(['plan', 'manifest', 'context', 'environment', 'verifier'].map(k => [k, hash(k)])) }
const reference = { version: 1, runId: 'run', kind: 'command-log', sha256: hash('actual output'), byteLength: 13 }
function fixture() {
  const requirements = ['implementation', 'command', 'review', 'acceptance', 'integration'].map(kind => ({
    id: kind, kind, mandatory: true, scope: kind === 'command' || kind === 'review' || kind === 'acceptance' ? 'final' : 'step',
    inputs, tree, refs: { 'refs/heads/run': sha },
  }))
  const receipts = requirements.map(r => ({ version: 2, id: `receipt-${r.id}`, requirement: r.id, kind: r.kind,
    requestIdentity: strictExecutionIdentity(inputs), identity: strictExecutionIdentity(r.inputs), tree: r.tree,
    refs: r.refs, status: 'pass', executionBacked: true, artifact: reference }))
  return { inputs, requirements, receipts, branches: { 'refs/heads/run': sha },
    artifactObservations: [{ reference, verified: true }], lifecycle: { runId: 'run', state: 'running' } }
}
const report = request => summarizeCompletionObligations(request)

for (const kind of ['implementation', 'command', 'review', 'acceptance', 'integration']) {
  test(`missing mandatory ${kind} category is enumerated as unresolved`, () => {
    const request = fixture()
    const result = report({ ...request, requirements: request.requirements.filter(r => r.kind !== kind),
      receipts: request.receipts.filter(r => r.kind !== kind) })
    assert.equal(result.verifiedComplete, false)
    assert.equal(result.state, 'unresolved')
    const missing = result.obligations.filter(o => o.kind === kind && o.mandatory)
    assert.equal(missing.length, 1)
    assert.equal(missing[0].status, 'unresolved')
    assert.deepEqual(missing[0].receipts, [])
    for (const requirement of request.requirements.filter(r => r.kind !== kind)) {
      assert.equal(result.obligations.find(o => o.id === requirement.id).status, 'pass')
    }
  })

  test(`optional ${kind} category cannot substitute for its mandatory obligation`, () => {
    const request = fixture()
    const result = report({ ...request, requirements: request.requirements.map(r => r.kind === kind ? { ...r, mandatory: false } : r) })
    assert.equal(result.verifiedComplete, false)
    assert.equal(result.state, 'unresolved')
    assert.equal(result.obligations.find(o => o.id === kind).status, 'pass')
    assert.ok(result.obligations.some(o => o.kind === kind && o.mandatory && o.status === 'unresolved'))
  })
}

test('strict identity rejects legacy and malformed inputs and binds context', () => {
  for (const key of Object.keys(inputs)) {
    assert.notEqual(strictExecutionIdentity(inputs), strictExecutionIdentity({ ...inputs, [key]: key === 'commit' ? 'c'.repeat(40) : hash('changed') }), key)
    const missing = { ...inputs }; delete missing[key]
    assert.throws(() => strictExecutionIdentity(missing), /input/i)
    assert.throws(() => strictExecutionIdentity({ ...inputs, [key]: 'not-a-hash' }), /input/i)
  }
  assert.throws(() => strictExecutionIdentity({ ...inputs, unexpected: true }), /input/i)
})

test('every mandatory receipt binds exact anchored and step inputs, tree, refs and artifact reads', () => {
  const request = fixture()
  assert.equal(report(request).verifiedComplete, true)
  for (const key of Object.keys(inputs)) {
    const changed = { ...inputs, [key]: key === 'commit' ? 'c'.repeat(40) : hash('changed') }
    assert.equal(report({ ...request, inputs: changed }).verifiedComplete, false, `request ${key}`)
    assert.equal(report({ ...request, requirements: request.requirements.map(r => ({ ...r, inputs: changed })) }).verifiedComplete, false, `step ${key}`)
  }
  for (const r of request.requirements) {
    assert.equal(report({ ...request, receipts: request.receipts.filter(e => e.requirement !== r.id) }).verifiedComplete, false, r.id)
  }
  assert.equal(report({ ...request, requirements: request.requirements.map(r => ({ ...r, tree: 'd'.repeat(40) })) }).verifiedComplete, false)
  assert.equal(report({ ...request, branches: { 'refs/heads/run': 'd'.repeat(40) } }).verifiedComplete, false)
  assert.equal(report({ ...request, branches: {} }).verifiedComplete, false)
  assert.equal(report({ ...request, artifactObservations: [] }).verifiedComplete, false)
  assert.equal(report({ ...request, artifactObservations: [{ reference: { ...reference, runId: 'other' }, verified: true }] }).verifiedComplete, false)
  assert.equal(report({ ...request, artifactObservations: [{ reference, verified: false }] }).verifiedComplete, false)
})

test('conflicting, skipped, legacy and model observations cannot establish strict completion', () => {
  const request = fixture(), receipt = request.receipts[0]
  for (const status of ['fail', 'unresolved', 'skipped', 'unverified', 'done', 'interrupted', 'blocked']) {
    const result = report({ ...request, receipts: [...request.receipts, { ...receipt, id: 'conflict', status }] })
    assert.equal(result.verifiedComplete, false, status)
    assert.equal(result.obligations[0].status, status === 'fail' ? 'fail' : 'unresolved', status)
  }
  for (const replacement of [{ version: 1 }, { executionBacked: false }, { kind: 'command' },
    { artifact: { ...reference, sha256: hash('changed') } }, { artifact: { ...reference, byteLength: 12 } },
    { artifact: { ...reference, version: 2 } }, { artifact: { ...reference, extra: true } },
    { refs: {} }, { refs: { 'refs/heads/run': 'c'.repeat(40) } },
    { refs: { ...receipt.refs, 'refs/heads/unexpected': sha } }, { tree: sha }]) {
    assert.equal(report({ ...request, receipts: [{ ...receipt, ...replacement }, ...request.receipts.slice(1)] }).verifiedComplete, false)
  }
  assert.throws(() => report({ ...request, receipts: [...request.receipts, receipt] }), /duplicate/i)
  assert.throws(() => report({ ...request, requirements: [...request.requirements, request.requirements[0]] }), /duplicate/i)
  assert.throws(() => report({ ...request, requirements: [{ ...request.requirements[0], mandatory: 'yes' }] }), /requirement/i)
  assert.throws(() => report({ ...request, receipts: Array(1001).fill(receipt) }), /bound/i)
  assert.throws(() => report({ ...request, requirements: [{ ...request.requirements[0], refs: {} }] }), /refs/i)
  assert.throws(() => report({ ...request, branches: { '../invalid': sha } }), /refs/i)
  assert.throws(() => report({ ...request, requirements: [{ ...request.requirements[0], scope: 'other' }] }), /requirement/i)
  assert.throws(() => report({ ...request, artifactObservations: [{ reference, verified: true, body: 'x'.repeat(1024 * 1024) }] }), /byte bound/i)
  assert.throws(() => report({ ...request, lifecycle: { runId: 'run', state: 'verified-complete' } }), /lifecycle/i)
  assert.equal(report({ ...request, requirements: request.requirements.filter(r => r.scope !== 'final') }).verifiedComplete, false)
})

test('lifecycle distinguishes blockers, failures, interruption and explicit stops even with passing receipts', () => {
  const request = fixture()
  assert.equal(report(request).state, 'verified-complete')
  for (const state of ['blocked', 'failed', 'suspended', 'abandoned', 'interrupted', 'unknown-effect']) {
    const result = report({ ...request, lifecycle: { runId: 'run', state } })
    assert.equal(result.verifiedComplete, false, state)
    assert.equal(result.state, state === 'interrupted' || state === 'unknown-effect' ? 'unresolved' : state)
  }
  assert.equal(report({ ...request, receipts: request.receipts.map(r => ({ ...r, artifact: { ...reference, runId: 'other' } })),
    artifactObservations: [{ reference: { ...reference, runId: 'other' }, verified: true }] }).verifiedComplete, false)
})

test('mandatory final checks cannot verify different expected integrated trees', () => {
  for (const [commit, testedTree] of [['c'.repeat(40), tree], [sha, 'd'.repeat(40)]]) {
    const request = fixture(), oldInputs = { ...inputs, commit }
    request.branches['refs/heads/task'] = oldInputs.commit
    const oldReview = { ...request.requirements.find(r => r.id === 'review'), inputs: oldInputs,
      tree: testedTree, refs: { 'refs/heads/task': oldInputs.commit } }
    request.requirements = request.requirements.map(r => r.id === 'review' ? oldReview : r)
    request.receipts = request.receipts.map(r => r.requirement === 'review' ? { ...r,
      identity: strictExecutionIdentity(oldInputs), tree: oldReview.tree, refs: oldReview.refs } : r)
    assert.equal(report(request).verifiedComplete, false)
  }
})

test('actual Git integration preserves unchanged task observations but needs fresh final tree checks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fm-completion-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'run'], root)
  git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'code'), 'baseline'); git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const anchor = git(['rev-parse', 'HEAD'], root)
  git(['switch', '-c', 'task'], root)
  await writeFile(path.join(root, 'code'), 'implemented'); git(['commit', '-am', 'implementation'], root)
  const taskTip = git(['rev-parse', 'HEAD'], root), taskTree = git(['rev-parse', 'HEAD^{tree}'], root)
  git(['switch', 'run'], root)
  const request = fixture(); request.inputs = { ...inputs, commit: anchor }
  const requestIdentity = strictExecutionIdentity(request.inputs)
  request.requirements = request.requirements.map(r => ({ ...r, inputs: { ...inputs, commit: r.scope === 'step' ? taskTip : anchor },
    tree: r.scope === 'step' ? taskTree : git(['rev-parse', 'HEAD^{tree}'], root),
    refs: { [r.scope === 'step' ? 'refs/heads/task' : 'refs/heads/run']: r.scope === 'step' ? taskTip : anchor } }))
  request.branches = { 'refs/heads/task': taskTip, 'refs/heads/run': anchor }
  request.receipts = request.requirements.map(r => ({ ...request.receipts.find(e => e.requirement === r.id),
    requestIdentity, identity: strictExecutionIdentity(r.inputs), tree: r.tree, refs: r.refs }))
  assert.equal(report(request).verifiedComplete, true)
  git(['merge', '--no-ff', 'task', '-m', 'integrate'], root)
  const finalTip = git(['rev-parse', 'HEAD'], root), finalTree = git(['rev-parse', 'HEAD^{tree}'], root)
  request.branches['refs/heads/run'] = finalTip
  request.requirements = request.requirements.map(r => r.scope === 'step' ? r : { ...r,
    inputs: { ...r.inputs, commit: finalTip }, tree: finalTree, refs: { 'refs/heads/run': finalTip } })
  const stale = report(request)
  assert.equal(stale.verifiedComplete, false)
  assert.equal(stale.obligations.find(o => o.id === 'implementation').status, 'pass')
  assert.equal(stale.obligations.find(o => o.id === 'command').status, 'unresolved')
  for (const r of request.requirements.filter(r => r.scope === 'final')) {
    request.receipts.push({ ...request.receipts.find(e => e.requirement === r.id), id: `fresh-${r.id}`,
      identity: strictExecutionIdentity(r.inputs), tree: r.tree, refs: r.refs })
  }
  assert.equal(report(request).verifiedComplete, true)
  assert.equal(report(request).stale, 3)
})
