import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceIdentity, summarizeAcceptance, reviewerMetrics } from '../scripts/workflow-evidence.mjs'
const inputs = { commit: 'sha', plan: 'plan-hash', manifest: 'manifest-hash', environment: 'node24', verifier: 'v1' }
const requirements = [{ id: 'build', kind: 'deterministic' }, { id: 'interaction', kind: 'human' }]
const proof = (requirement, kind, status = 'pass') => ({ requirement, kind, status, identity: evidenceIdentity(inputs), log: 'logs/check.txt' })
test('acceptance completion requires current evidence for every criterion and the declared evidence kind', () => {
  const complete = [proof('build', 'deterministic'), proof('interaction', 'human')]
  assert.equal(summarizeAcceptance({ inputs, requirements, evidence: complete }).complete, true)
  const partial = summarizeAcceptance({ inputs, requirements, evidence: complete.slice(0, 1) })
  assert.equal(partial.complete, false); assert.equal(partial.obligations[1].status, 'human-required')
  assert.equal(summarizeAcceptance({ inputs, requirements, evidence: [proof('build', 'judgment'), proof('interaction', 'human')] }).complete, false)
  assert.equal(summarizeAcceptance({ inputs, requirements, evidence: [...complete, proof('build', 'deterministic', 'fail')] }).complete, false)
  for (const key of Object.keys(inputs)) {
    const stale = summarizeAcceptance({ inputs: { ...inputs, [key]: 'changed' }, requirements, evidence: complete })
    assert.equal(stale.complete, false); assert.equal(stale.obligations[0].stale, 1)
  }
  assert.throws(() => summarizeAcceptance({ inputs, requirements: [], evidence: [] }), /required/)
})
test('review calibration keeps unresolved findings out of precision and recall unknown without independent labels', () => {
  const findings = [ { id: '1', outcome: 'confirmed', defect: 'bug' }, { id: '2', outcome: 'refuted' },
    { id: '3', outcome: 'unreproduced' }, { id: '4', outcome: 'accepted' }, { id: '5', outcome: 'duplicate' } ]
  assert.equal(reviewerMetrics(findings).precision, 0.5)
  assert.equal(reviewerMetrics(findings).recall, null)
  assert.equal(reviewerMetrics(findings, ['bug', 'other']).recall, 0.5)
  assert.equal(reviewerMetrics([]).precision, null)
  assert.throws(() => reviewerMetrics([findings[0], findings[0]]), /duplicate/)
})

test('workflow CLI emits bounded context and returns unresolved acceptance separately from success', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { runCli } = await import('../scripts/cli.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'input.json'), output = []
  const io = { out: value => output.push(value) }
  await writeFile(file, JSON.stringify({ inputs, requirements, evidence: [proof('build', 'deterministic')] }))
  assert.equal(await runCli(['workflow-report', '--file', file, '--root', root], io), 4)
  assert.equal(JSON.parse(output.at(-1)).acceptance.obligations[1].status, 'human-required')
  assert.equal(JSON.parse(output.at(-1)).review, null, 'missing reviewer outcomes are unknown, not an observed empty review')
  await writeFile(file, JSON.stringify({ inputs, requirements, evidence: [proof('build', 'deterministic'), proof('interaction', 'human')] }))
  assert.equal(await runCli(['workflow-report', '--file', file, '--root', root], io), 0)
  await writeFile(file, JSON.stringify({ task: 'T1', role: 'reviewer', commit: 'a'.repeat(40), items: [{ id: 'rule', text: '\u009b\u202e data', source: 'guidance.md', startLine: 1, endLine: 1, reason: 'global', mandatory: true }] }))
  assert.equal(await runCli(['context-bundle', '--file', file, '--root', root], io), 0)
  assert.equal(JSON.parse(output.at(-1)).role, 'reviewer')
  assert.ok(output.at(-1).includes('\\u009b') && !output.at(-1).includes('\u009b'), 'structured context output must preserve JSON without terminal control bytes')
})
