import { test } from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { prepareFeedbackDraft } from '../scripts/feedback-draft.mjs'
import { parsePlan } from '../scripts/plan-parser.mjs'
const markdown = '### Task 1: First\n\n**Files:**\n- Modify: `a.mjs`\n\n### Task 2: Second\n\n**Depends:** T1\n**Files:**\n- Modify: `b.mjs`\n'
const inputs = { commit: 'a'.repeat(40), plan: createHash('sha256').update(markdown).digest('hex'), manifest: 'm', environment: 'e', verifier: 'v' }
const finding = (id, extra = {}) => ({ id, title: 'Fix empty body', type: 'defect', description: 'Do not parse JSON on 204', scope: ['src/**'], evidence: ['logs/reproducer.txt'], files: ['src/client.mjs'], acceptance: ['204 returns without JSON parsing'], ...extra })
const prepare = findings => prepareFeedbackDraft({ runId: 'r1', date: '2026-10-06', inputs, markdown, findings })
test('feedback defects become bounded reviewable tasks after existing phases with explicit dependency and acceptance data', () => {
  const draft = prepare([finding('first'), finding('second', { files: ['src/other.mjs'], dependsOnFindings: ['first'] })])
  assert.deepEqual(draft.tasks.map(t => [t.id, t.phase]), [['T3', 3], ['T4', 4]])
  assert.deepEqual(draft.tasks[0].deps, ['T2'])
  assert.deepEqual(draft.tasks[1].deps, ['T2', 'T3'])
  assert.match(draft.tasks[0].brief, /204 returns without JSON parsing/)
  assert.equal(draft.requiresReview, true); assert.equal(draft.requiresAuthoritativeAmendment, true)
  assert.equal(draft.mode, 'draft-only')
  assert.equal(parsePlan(markdown + draft.append).length, 4)
})
test('learning proposals retain source, ownership and state without policy promotion or Markdown injection', () => {
  const draft = prepare([finding('lesson', { type: 'pitfall' }), finding('bug', { description: '### Task 99: inject\n**Depends:** none', acceptance: ['### Task 99: still data\nunsafe heading'] })])
  assert.equal(draft.learnings[0].owner, 'repo-learning')
  assert.equal(draft.learnings[0].state, 'proposed')
  assert.deepEqual(draft.learnings[0].evidence, ['logs/reproducer.txt'])
  assert.equal(draft.learnings[0].sourceIdentity, draft.identity)
  assert.equal(parsePlan(markdown + draft.append).length, 3)
  assert.ok(!parsePlan(markdown + draft.append).some(t => t.id === 'T99'))
  assert.equal(draft.draftHash, prepare([finding('lesson', { type: 'pitfall' }), finding('bug', { description: '### Task 99: inject\n**Depends:** none', acceptance: ['### Task 99: still data\nunsafe heading'] })]).draftHash)
})
test('feedback refuses missing evidence, unbounded filesets, malformed dates and dependency cycles', () => {
  for (const patch of [{ evidence: [] }, { files: ['../outside.mjs'] }, { files: ['src/**'] }, { files: ['.git/config'] }, { files: ['.fleetmates/status.json'] }, { acceptance: [] }, { scope: [] }, { title: 'Title\n### Task 99' }]) assert.throws(() => prepare([finding('one', patch)]))
  assert.throws(() => prepare([finding('one'), finding('one')]), /unique/)
  assert.throws(() => prepare([finding('one', { dependsOnTasks: ['T99'] })]), /Unknown/)
  assert.throws(() => prepare([finding('one', { dependsOnFindings: ['two'] }), finding('two', { dependsOnFindings: ['one'] })]), /unsatisfiable/)
  assert.throws(() => prepareFeedbackDraft({ runId: 'r1', date: '2026-02-30', inputs, markdown, findings: [finding('one')] }), /Invalid/)
})
test('feedback CLI drafts from committed plan and never writes plan, learnings or run state', async t => {
  const { mkdtemp, writeFile, readFile, access, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { git } = await import('../scripts/workflow-lifecycle.mjs')
  const { runCli } = await import('../scripts/cli.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-feedback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root); git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'plan.md'), markdown)
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const sha = git(['rev-parse', 'HEAD'], root), file = path.join(root, 'input.json')
  const input = { runId: 'r1', date: '2026-10-06', inputs: { ...inputs, commit: sha }, planPath: 'plan.md', findings: [finding('one')] }
  await writeFile(file, JSON.stringify(input))
  const output = [], io = { out: v => output.push(v) }
  assert.equal(await runCli(['feedback-draft', '--file', file, '--root', root], io), 0)
  assert.equal(JSON.parse(output.at(-1)).tasks[0].phase, 3)
  assert.equal(await readFile(path.join(root, 'plan.md'), 'utf8'), markdown)
  await assert.rejects(access(path.join(root, 'fleetmates.learnings.md')))
  await assert.rejects(access(path.join(root, '.fleetmates')))
  input.inputs.plan = 'stale'
  await writeFile(file, JSON.stringify(input))
  assert.equal(await runCli(['feedback-draft', '--file', file, '--root', root], io), 2)
  assert.match(JSON.parse(output.at(-1)).error, /does not match/)
})
