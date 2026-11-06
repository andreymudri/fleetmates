import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { expandWorkflowProfile, profileTaskResultAccepted, PROFILE_LIMITS } from '../scripts/workflow-profile.mjs'
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
test('repair-round and wall-time bounds are pinned at both edges: n accepted, n+1 refused', () => {
  assert.deepEqual(PROFILE_LIMITS, { maxRepairRounds: [0, 10], maxWallMinutes: [1, 1440] })
  for (const [key, accepted, refused] of [['maxRepairRounds', 10, 11], ['maxRepairRounds', 0, -1], ['maxWallMinutes', 1440, 1441], ['maxWallMinutes', 1, 0]]) {
    assert.equal(expandWorkflowProfile({ ...input, [key]: accepted }).ready, true, `${key} ${accepted}`)
    assert.throws(() => expandWorkflowProfile({ ...input, [key]: refused }), /Invalid workflow profile parameters/, `${key} ${refused}`)
  }
  const profile = expandWorkflowProfile({ ...input, maxRepairRounds: 10 })
  assert.equal(profile.phaseContracts[0].repair.maxRounds, 1, 'the manifest fix budget still caps the request bound')
  assert.equal(expandWorkflowProfile({ ...input, maxRepairRounds: 0 }).phaseContracts[0].repair.maxRounds, 0)
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
test('host-bounded expansion replaces generative integration, names the collect-reviews results path and carries required contracts', () => {
  const legacy = expandWorkflowProfile(input)
  assert.equal(legacy.steps.find(s => s.id === 'integrate-1').argv[2], 'dispatch-integrator')
  const profile = expandWorkflowProfile({ ...input, integration: 'host-bounded', contracts: { environment: 'env.json', rolePolicy: 'roles.json' } })
  const integrate = profile.steps.find(s => s.id === 'integrate-1')
  assert.equal(integrate.kind, 'host-integration'); assert.equal(integrate.mode, 'host-bounded'); assert.equal(integrate.argv, undefined)
  for (const id of ['implement-1', 'review-1']) assert.deepEqual(profile.steps.find(s => s.id === id).argv.slice(-4), ['--environment', 'env.json', '--role-policy', 'roles.json'])
  const collect = profile.steps.find(s => s.id === 'collect-1'), gate = profile.steps.find(s => s.id === 'gate-1')
  assert.equal(collect.resultsPath, '.fleetmates/r1/reviews/results-1.json'); assert.equal(collect.resultsFrom, 'success-write-line')
  assert.equal(collect.stdoutArtifact, undefined)
  assert.deepEqual(gate.argv.slice(-2), ['--results', collect.resultsPath])
  assert.deepEqual(profile.steps.find(s => s.id === 'finish').argv.slice(-2), ['--results', '.fleetmates/r1/reviews/finish-results.json'], 'finish needs the collected reviews or it leaves the agent check pending')
  assert.ok(!legacy.steps.find(s => s.id === 'finish').argv.includes('--results'))
  assert.notEqual(profile.profileHash, legacy.profileHash)
  assert.throws(() => expandWorkflowProfile({ ...input, integration: 'generative' }), /integration mode/)
  for (const contracts of [{ environment: '/abs/env.json', rolePolicy: 'roles.json' }, { environment: 'env.json' }, { environment: '../env.json', rolePolicy: 'roles.json' }, { environment: 'env.json', rolePolicy: '--exec' }]) {
    assert.throws(() => expandWorkflowProfile({ ...input, contracts }), /contracts/)
  }
})

// Review scope (docs/specs/2026-11-06-cost-cuts-design.md, section 2, Workflow path).
const twoPhasePlan = markdown + '\n### Task 2: Next\n\n**Depends:** T1\n**Files:**\n- Modify: `src/next.mjs`\n'
const withManifest = (manifest, plan = twoPhasePlan) => {
  const text = JSON.stringify(manifest)
  return { ...input, markdown: plan, manifestText: text, inputs: { ...input.inputs, plan: hash(plan), manifest: hash(text) } }
}
const reviewCheck = scope => ({ name: 'review', kind: 'agent', blockOn: ['high'], ...(scope ? { scope } : {}) })
const scoped = scope => ({ phases: { default: { fixRounds: 1, checks: [{ name: 'test', kind: 'command', run: 'npm test' }, reviewCheck(scope)] } } })
const hostBounded = { integration: 'host-bounded', contracts: { environment: 'env.json', rolePolicy: 'roles.json' } }
test('a phase-scoped review keeps the per-phase steps byte-for-byte, in both integration modes', () => {
  // Captured from the expansion before run-scoped review existed: any change to a phase-scoped
  // profile, down to one step input, changes these hashes.
  assert.equal(expandWorkflowProfile(withManifest(scoped('phase'))).profileHash, 'a7aac79342573306a3105b11cf05c6b8f263412f3c2f4004c93e84d168c92578')
  assert.equal(expandWorkflowProfile({ ...withManifest(scoped('phase')), ...hostBounded }).profileHash, 'c36a0089fe004c3c0ca64f1ee0f9370b8695983035999d643672fd47c70c533f')
})
test('a run-scoped review drops the per-phase review steps and emits review-run and collect-run before acceptance and finish', () => {
  const profile = expandWorkflowProfile({ ...withManifest(scoped('run')), ...hostBounded })
  assert.equal(profile.ready, true, profile.blocked.join('; '))
  assert.deepEqual(profile.steps.map(s => s.id), ['prepare', 'baseline', 'implement-1', 'gate-1', 'integrate-1', 'implement-2', 'gate-2', 'integrate-2',
    'review-run', 'collect-run', 'acceptance', 'finish'])
  assert.deepEqual(profile.phaseContracts.map(c => c.checks.map(check => check.kind)), [['command', 'fileset', 'ownership'], ['command', 'fileset', 'ownership']])
  for (const phase of [1, 2]) {
    const gate = profile.steps.find(s => s.id === `gate-${phase}`)
    assert.ok(!gate.argv.includes('--results'), 'a phase gate with no review reads no review results')
    assert.deepEqual(gate.inputs, [`task-results-${phase}`])
    assert.deepEqual(profile.steps.find(s => s.id === `integrate-${phase}`).inputs, [`gate-verdict-${phase}`])
  }
  const review = profile.steps.find(s => s.id === 'review-run'), collect = profile.steps.find(s => s.id === 'collect-run')
  assert.deepEqual(review.argv, ['node', 'scripts/cli.mjs', 'dispatch-reviews', '--run', 'r1', '--phase', 'run', '--harness', 'codex',
    '--plan', 'plan.md', '--base', 'feat/deck', '--environment', 'env.json', '--role-policy', 'roles.json'])
  assert.deepEqual(review.inputs, ['integrated-refs-2'])
  assert.equal(review.kind, 'agent')
  assert.deepEqual(collect.argv, ['node', 'scripts/cli.mjs', 'collect-reviews', '--run', 'r1', '--phase', 'run'])
  assert.equal(collect.resultsPath, '.fleetmates/r1/reviews/results-run.json')
  assert.equal(collect.resultsFrom, 'success-write-line')
  assert.deepEqual(collect.outputs, ['review-results-run'])
  const finish = profile.steps.find(s => s.id === 'finish')
  assert.deepEqual(finish.argv.slice(-2), ['--results', '.fleetmates/r1/reviews/finish-results.json'])
  assert.ok(finish.inputs.includes('review-results-run'))
  assert.deepEqual(profile.runContract.checks.map(c => [c.kind, c.name]), [['command', 'test'], ['agent', 'review'], ['fileset-run', 'fileset-run']])
  assert.equal(profile.runContract.repair.maxRounds, 1, 'the manifest fix budget caps the run repair rounds')
  assert.equal(expandWorkflowProfile({ ...withManifest({ phases: { default: { fixRounds: 5, checks: [reviewCheck('run')] } } }), maxRepairRounds: 10 }).runContract.repair.maxRounds, 2,
    'the run fix route is capped at two rounds whatever the budgets say')
  // Legacy integration has no controller to merge result documents: finish reads the run review's file directly.
  const legacy = expandWorkflowProfile(withManifest(scoped('run')))
  assert.deepEqual(legacy.steps.find(s => s.id === 'finish').argv.slice(-2), ['--results', '.fleetmates/r1/reviews/results-run.json'])
  assert.equal(expandWorkflowProfile(withManifest(scoped('phase'))).runContract, undefined, 'a phase-scoped profile carries no run contract')
})
test('the profile requires a mandatory review for the run or for every phase, and keeps phase-scoped steps beside a run review', () => {
  const optionalRun = { phases: { default: { checks: [{ ...reviewCheck('run'), optional: true }] } } }
  const blocked = expandWorkflowProfile(withManifest(optionalRun))
  assert.equal(blocked.ready, false)
  assert.deepEqual(blocked.blocked, ['the run requires a tracked mandatory review check, or every phase one'])
  // Phase 2 alone carries a phase-scoped review and the run has none: phase 1 has no review at all.
  const partial = { phases: { default: { checks: [{ name: 'test', kind: 'command', run: 'npm test' }] }, 2: { checks: [reviewCheck('phase')] } } }
  assert.deepEqual(expandWorkflowProfile(withManifest(partial)).blocked, ['phase 1 requires a tracked mandatory review check'])
  // With a run-scoped review in the default block, phase 2 keeps its own steps and phase 1 needs none.
  const mixed = { phases: { default: { checks: [{ name: 'test', kind: 'command', run: 'npm test' }, reviewCheck('run')] }, 2: { checks: [{ ...reviewCheck('phase'), name: 'phase-review' }] } } }
  const profile = expandWorkflowProfile({ ...withManifest(mixed), ...hostBounded })
  assert.equal(profile.ready, true, profile.blocked.join('; '))
  assert.deepEqual(profile.steps.map(s => s.id), ['prepare', 'baseline', 'implement-1', 'gate-1', 'integrate-1', 'implement-2', 'review-2', 'collect-2', 'gate-2', 'integrate-2',
    'review-run', 'collect-run', 'acceptance', 'finish'])
  assert.deepEqual(profile.steps.find(s => s.id === 'gate-2').argv.slice(-2), ['--results', '.fleetmates/r1/reviews/results-2.json'])
})
