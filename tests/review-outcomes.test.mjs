import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceIdentity } from '../scripts/workflow-evidence.mjs'
import { summarizeReviewOutcomes } from '../scripts/review-outcomes.mjs'
const inputs = { commit: 'commit', plan: 'plan', manifest: 'manifest', environment: 'environment', verifier: 'verifier' }
const finding = (id, outcome = 'confirmed', extra = {}) => ({ id, outcome, identity: evidenceIdentity(inputs), rationale: 'Observed in reproducer',
  provenance: { lens: 'correctness', category: 'behavior', model: 'test-model', source: 'reviews/report.json' }, evidence: ['logs/reproduction.txt'], defect: 'bug', ...extra })
test('cross-lens duplicates retain provenance and never inflate confirmed precision or recall', () => {
  const report = summarizeReviewOutcomes({ inputs, labeledDefects: ['bug', 'other'], findings: [finding('a'), finding('b', 'duplicate', { duplicateOf: 'a', provenance: { lens: 'security', category: 'behavior', model: 'other-model', source: 'reviews/second.json' } }), finding('c', 'refuted')] })
  assert.equal(report.groups.length, 2)
  assert.equal(report.groups[0].observations.length, 2)
  assert.equal(report.groups[0].observations[1].provenance.lens, 'security')
  assert.equal(report.metrics.precision, 0.5)
  assert.equal(report.metrics.recall, 0.5)
  assert.equal(report.breakdown.lens.find(v => v.value === 'security').precision, null)
  assert.equal(report.breakdown.model.length, 2)
  assert.equal(report.mode, 'reporting')
})
test('stale outcomes cannot approve current inputs and empty judgments remain unknown', () => {
  for (const key of Object.keys(inputs)) {
    const report = summarizeReviewOutcomes({ inputs: { ...inputs, [key]: 'changed' }, findings: [finding('a')] })
    assert.deepEqual(report.stale, ['a'])
    assert.equal(report.groups.length, 0)
    assert.equal(report.metrics.precision, null)
  }
  assert.equal(summarizeReviewOutcomes({ inputs, findings: [finding('a', 'unreproduced'), finding('b', 'accepted')] }).metrics.precision, null)
})
test('deduplication refuses cycles, missing targets, cross-input links and unsupported outcome claims', () => {
  const summarize = findings => summarizeReviewOutcomes({ inputs, findings })
  assert.throws(() => summarize([finding('a', 'duplicate', { duplicateOf: 'b' }), finding('b', 'duplicate', { duplicateOf: 'a' })]), /cycle/)
  assert.throws(() => summarize([finding('a', 'duplicate', { duplicateOf: 'missing' })]), /target/)
  assert.throws(() => summarize([finding('a', 'duplicate', { duplicateOf: 'b' }), finding('b', 'confirmed', { identity: 'old' })]), /different inputs/)
  for (const patch of [{ evidence: [] }, { rationale: '' }, { provenance: {} }, { outcome: 'fixed' }]) assert.throws(() => summarize([finding('a', 'confirmed', patch)]), /requires/)
  assert.throws(() => summarize([finding('a'), finding('a')]), /unique/)
  assert.throws(() => summarize([finding('a', 'confirmed', { duplicateOf: 'b' })]), /Only duplicate/)
})
test('workflow report uses current acceptance identity for review outcomes and rejects malformed duplicates', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { runCli } = await import('../scripts/cli.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-outcomes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'input.json'), output = []
  const payload = { inputs, requirements: [{ id: 'human', kind: 'human' }], evidence: [], reviewOutcomes: { inputs: { ...inputs, commit: 'forged' }, findings: [finding('a')] } }
  await writeFile(file, JSON.stringify(payload))
  assert.equal(await runCli(['workflow-report', '--file', file, '--root', root], { out: v => output.push(v) }), 4)
  assert.equal(JSON.parse(output.at(-1)).reviewOutcomes.identity, evidenceIdentity(inputs))
  assert.equal(JSON.parse(output.at(-1)).reviewOutcomes.metrics.counts.confirmed, 1)
  payload.reviewOutcomes.findings = [finding('a', 'duplicate', { duplicateOf: 'missing' })]
  await writeFile(file, JSON.stringify(payload))
  assert.equal(await runCli(['workflow-report', '--file', file, '--root', root], { out: v => output.push(v) }), 2)
})
