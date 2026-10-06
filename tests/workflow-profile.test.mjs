import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { expandWorkflowProfile, profileTaskResultAccepted } from '../scripts/workflow-profile.mjs'
const markdown = '### Task 1: First\n\n**Files:**\n- Modify: `src/first.mjs`\n\n**Acceptance:**\nRegression covered.\n'
const manifestText = JSON.stringify({ phases: { default: { fixRounds: 1, checks: [{ name: 'test', kind: 'command', run: 'npm test' }, { name: 'review', kind: 'agent', blockOn: ['high'] }] } } })
const hash = value => createHash('sha256').update(value).digest('hex')
const input = { profile: 'bug-fix', runId: 'r1', planPath: 'plan.md', baseBranch: 'feat/deck', harness: 'codex', inputs: { commit: 'a'.repeat(40), plan: hash(markdown), manifest: hash(manifestText), environment: 'e', verifier: 'v' }, markdown, manifestText, capabilities: { harness: 'available' } }
test('reusable workflow expansion preserves mandatory checks, actual CLI steps and tracked repair limits', () => {
  const profile = expandWorkflowProfile({ ...input, maxRepairRounds: 5 })
  assert.equal(profile.ready, true); assert.equal(profile.executable, false)
  assert.deepEqual(profile.phaseContracts[0].checks.map(c => c.kind), ['command', 'agent', 'fileset', 'ownership'])
  assert.equal(profile.phaseContracts[0].repair.maxRounds, 1)
  assert.ok(profile.steps.find(s => s.id === 'review-1').argv.includes('feat/deck'))
  assert.ok(profile.steps.some(s => s.id === 'gate-1'))
  assert.ok(!profile.steps.some(s => /push|merge|deploy/.test(s.argv?.[2] ?? '')))
  assert.equal(profile.profileHash, expandWorkflowProfile({ ...input, maxRepairRounds: 5 }).profileHash)
  const twoPhasePlan = markdown + '\n### Task 2: Next\n\n**Depends:** T1\n**Files:**\n- Modify: `src/next.mjs`\n'
  const two = expandWorkflowProfile({ ...input, markdown: twoPhasePlan, inputs: { ...input.inputs, plan: hash(twoPhasePlan) } })
  assert.ok(two.steps.find(s => s.id === 'implement-2').inputs.includes('integrated-refs-1'))
})
test('profile-specific missing prerequisites are explicit and cannot silently skip required UI or Vault steps', () => {
  assert.equal(expandWorkflowProfile({ ...input, profile: 'ui' }).ready, false)
  assert.equal(expandWorkflowProfile({ ...input, profile: 'ui', capabilities: { harness: 'available', render: 'available' } }).ready, true)
  assert.equal(expandWorkflowProfile({ ...input, profile: 'research', parameters: { requiresVault: true } }).ready, false)
  assert.equal(expandWorkflowProfile({ ...input, profile: 'research' }).ready, true)
  assert.equal(expandWorkflowProfile({ ...input, profile: 'feature' }).ready, true)
  assert.throws(() => expandWorkflowProfile({ ...input, profile: 'migration' }), /compatibility/)
  assert.equal(expandWorkflowProfile({ ...input, profile: 'migration', parameters: { compatibility: 'Keep old schema readable', rollback: 'Restore previous reader' } }).ready, true)
})
test('malformed profiles, stale tracked inputs and unstructured done results fail before dispatch', () => {
  assert.throws(() => expandWorkflowProfile({ ...input, maxRepairRounds: 100 }), /Invalid/)
  assert.throws(() => expandWorkflowProfile({ ...input, markdown: markdown + 'later change' }), /identities/)
  assert.throws(() => expandWorkflowProfile({ ...input, profile: 'custom-shell' }), /Invalid/)
  assert.equal(profileTaskResultAccepted('done'), false)
  assert.equal(profileTaskResultAccepted({ status: 'done', branch: 'refs/heads/task', filesChanged: [], summary: 'candidate', blockers: [] }), true)
  assert.equal(profileTaskResultAccepted({ status: 'done' }), false)
  assert.equal(profileTaskResultAccepted({ status: 'done', branch: 'refs/heads/task', filesChanged: [], summary: 'candidate', blockers: ['unresolved acceptance'] }), false)
  assert.throws(() => expandWorkflowProfile({ ...input, runId: 'r'.repeat(256) }), /Invalid/)
})
test('workflow profile CLI reads exact committed plan and policy and executes no profile side effects', async t => {
  const { mkdtemp, writeFile, access, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { git } = await import('../scripts/workflow-lifecycle.mjs')
  const { runCli } = await import('../scripts/cli.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-workflow-profile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root); git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'plan.md'), markdown)
  await writeFile(path.join(root, 'fleetmates.gate.json'), manifestText)
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const file = path.join(root, 'input.json'), output = []
  const payload = { ...input, baseBranch: 'main', inputs: { ...input.inputs, commit: git(['rev-parse', 'HEAD'], root) } }
  delete payload.markdown; delete payload.manifestText
  await writeFile(file, JSON.stringify(payload))
  const io = { out: value => output.push(value) }
  assert.equal(await runCli(['workflow-profile', '--file', file, '--root', root], io), 0)
  assert.equal(JSON.parse(output.at(-1)).mode, 'dry-run')
  await assert.rejects(access(path.join(root, '.fleetmates')))
  payload.inputs.manifest = 'stale'
  await writeFile(file, JSON.stringify(payload))
  assert.equal(await runCli(['workflow-profile', '--file', file, '--root', root], io), 2)
  assert.match(JSON.parse(output.at(-1)).error, /identities/)
})
