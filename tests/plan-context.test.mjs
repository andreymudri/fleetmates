import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPlanContracts } from '../scripts/plan-context.mjs'
const markdown = '### Task 1: Interface\n\n**Files:**\n- Create: `src/api.mjs`\n\nReturn an empty body on 204.\n\n### Task 2: Consumer\n\n**Depends:** T1\n**Files:**\n- Create: `src/client.mjs`\n\n**Acceptance:**\nDo not parse JSON on 204.\n\n```md\n### Task 9: not a real task\n## ignored heading\n```\n\n### Task 3: Unrelated\n\n**Files:**\n- Create: `other.mjs`\n'
test('anchored acceptance and explicit dependencies preserve whole contracts and exact provenance', () => {
  const items = selectPlanContracts(markdown, 'plan.md', { id: 'T2', deps: ['T3'] })
  assert.deepEqual(items.map(i => i.id), ['plan-contract-T2', 'plan-contract-T1'])
  assert.ok(items.every(i => i.mandatory))
  assert.match(items[0].text, /Do not parse JSON on 204/)
  assert.match(items[0].text, /not a real task/)
  assert.ok(!items[0].text.includes('Task 3'))
  for (const item of items) assert.equal(item.text, markdown.split('\n').slice(item.startLine - 1, item.endLine).join('\n'))
  assert.match(items[1].text, /Return an empty body on 204/)
})
test('phase roles select member contracts, reject missing declared dependencies and retain legacy behavior', () => {
  const items = selectPlanContracts(markdown, 'plan.md', { id: 'phase-1', members: ['T1', 'T2'] })
  assert.equal(items.length, 2)
  assert.deepEqual(selectPlanContracts(markdown, 'plan.md', { id: 'T3' }), [])
  assert.throws(() => selectPlanContracts(markdown.replace('**Depends:** T1', '**Depends:** T99'), 'plan.md', { id: 'T2' }), /absent/)
  assert.throws(() => selectPlanContracts(markdown, 'plan.md', { id: 'phase', members: ['T2', 'T2'] }), /members/)
})
test('all roles receive mandatory anchored contracts without a learning file and refuse overflow', async () => {
  const { learningBundle } = await import('../scripts/learning-context.mjs')
  const git = { fileModeAtCommit: async (_sha, file) => file.endsWith('plan.md') ? '100644' : null,
    fileSizeAtCommit: async () => Buffer.byteLength(markdown), fileAtCommit: async () => markdown }
  for (const role of ['implementer', 'reviewer', 'integrator']) {
    const task = role === 'implementer' ? { id: 'T2', files: [] } : { id: 'phase-2', members: ['T2'], files: [] }
    const options = { git, commit: 'a'.repeat(40), planPath: 'plan.md', role, task }
    const bundle = await learningBundle(options)
    assert.equal(bundle.role, role)
    assert.equal(bundle.selected.length, 2)
    assert.equal(bundle.selected[1].source, 'plan.md')
    await assert.rejects(learningBundle({ ...options, maxBytes: 1 }), /Mandatory/)
    await assert.rejects(learningBundle({ ...options, planPath: '../plan.md' }), /repository-relative/)
    await assert.rejects(learningBundle({ ...options, git: { ...git, fileModeAtCommit: async () => '120000' } }), /regular/)
  }
})
test('real brief and workflow read acceptance and dependencies from the anchor after later plan edits', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { git } = await import('../scripts/workflow-lifecycle.mjs')
  const { writeState } = await import('../scripts/state.mjs')
  const { runCli } = await import('../scripts/cli.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root)
  git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'plan.md'), markdown)
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  git(['switch', '-c', 'run'], root)
  await writeState(root, 'r1', 'plan', { runBranch: 'run', planPath: 'plan.md', tasks: [{ id: 'T2', title: 'Consumer', phase: 1, files: ['src/client.mjs'], deps: [], brief: 'Modified cached brief', tier: 'mid' }] })
  await writeFile(path.join(root, 'plan.md'), markdown.replace('Do not parse JSON on 204.', 'Changed later acceptance.'))
  git(['add', '.'], root); git(['commit', '-m', 'later edit'], root)
  const output = [], io = { out: v => output.push(v), err: v => output.push(v) }
  for (const args of [['brief', '--task', 'T2'], ['workflow', '--phase', '1']]) {
    assert.equal(await runCli([...args, '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root], io), 0)
    assert.match(output.at(-1), /Do not parse JSON on 204/)
    assert.match(output.at(-1), /Return an empty body on 204/)
    assert.ok(!output.at(-1).includes('Changed later acceptance'))
  }
})
test('review dispatch resolves anchored contracts on an explicit feature base instead of the default branch', async t => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { git } = await import('../scripts/workflow-lifecycle.mjs')
  const { writeState } = await import('../scripts/state.mjs')
  const { runCli } = await import('../scripts/cli.mjs')
  const { assignPhases } = await import('../scripts/phases.mjs')
  const { parsePlan } = await import('../scripts/plan-parser.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-review-base-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root); git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'README.md'), 'baseline')
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  git(['switch', '-c', 'feat/deck'], root)
  await writeFile(path.join(root, 'plan.md'), markdown)
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer', blockOn: ['high'], lens: ['correctness'] }] } } }))
  git(['add', '.'], root); git(['commit', '-m', 'feature plan'], root)
  git(['switch', '-c', 'run'], root)
  git(['switch', '-c', 'fleetmates/r1/T2'], root)
  await mkdir(path.join(root, 'src')); await writeFile(path.join(root, 'src/client.mjs'), 'export const client = 1')
  git(['add', '.'], root); git(['commit', '-m', 'implementation'], root); git(['switch', 'run'], root)
  await writeState(root, 'r1', 'plan', { runBranch: 'run', planPath: 'plan.md', tasks: assignPhases(parsePlan(markdown)) })
  const output = [], io = { out: v => output.push(v), err: v => output.push(v) }
  assert.equal(await runCli(['review-dispatch', '--run', 'r1', '--phase', '2', '--plan', 'plan.md', '--base', 'feat/deck', '--root', root], io), 0, output.join('\n'))
  const prompt = JSON.parse(output.at(-1)).reviewers[0].prompt
  assert.match(prompt, /Do not parse JSON on 204/)
  assert.match(prompt, /Return an empty body on 204/)
  assert.equal(await runCli(['dispatch-reviews', '--run', 'r1', '--phase', '2', '--harness', 'codex', '--plan', 'plan.md', '--base', 'missing-feature-base', '--root', root], io), 4)
  assert.match(output.at(-1), /not a local branch/)
})
