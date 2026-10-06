import { test } from 'node:test'
import path from 'node:path'
import assert from 'node:assert/strict'
import { selectLearnings, learningBundle } from '../scripts/learning-context.mjs'
const markdown = '# Human guidance\n\n## 2026-10-06 run: r1\nGlobal invariant.\n\n## 2026-10-06 run: r2 scope: src/**\nRelevant detail.\n\n## 2026-10-06 run: r3 scope: other/**\nUnrelated detail.\n'
test('human learning selection preserves global and legacy guidance and selects task-related entries with line provenance', () => {
  const selected = selectLearnings(markdown, ['src/index.mjs'])
  assert.equal(selected.length, 3)
  assert.deepEqual(selected.map(e => e.mandatory), [true, true, false])
  assert.equal(selected[2].startLine, 6)
  assert.ok(selected[2].text.includes('Relevant detail'))
  assert.ok(selected.every(e => !e.text.includes('Unrelated detail')))
  assert.equal(selectLearnings('Free-form human rule', []).at(0).mandatory, true)
})
test('learning bundles use bounded tracked content and reject required overflow and nonregular files', async () => {
  const commit = 'a'.repeat(40), task = { id: 'T1', files: ['src/index.mjs'] }
  let readCommit
  const git = { fileModeAtCommit: async () => '100644', fileSizeAtCommit: async () => Buffer.byteLength(markdown), fileAtCommit: async sha => { readCommit = sha; return markdown } }
  const bundle = await learningBundle({ git, commit, task })
  const { composeBrief } = await import('../scripts/brief.mjs')
  assert.throws(() => composeBrief({ task: { ...task, branch: 'fleetmates/r1/T2' }, contextBundle: { ...bundle, task: 'T2' } }), /belong/)
  assert.equal(readCommit, commit); assert.equal(bundle.commit, commit)
  assert.equal(bundle.vault, 'unavailable')
  await assert.rejects(learningBundle({ git, commit, task, maxBytes: 1 }), /Mandatory context/)
  await assert.rejects(learningBundle({ git: { ...git, fileModeAtCommit: async () => '120000' }, commit, task }), /regular/)
  assert.equal(await learningBundle({ git: { ...git, fileModeAtCommit: async () => null }, commit, task }), null)
})

test('real brief and generated workflow carry anchored advisory learning data and preserve constraints after a local edit', async t => {
  const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { git } = await import('../scripts/workflow-lifecycle.mjs')
  const { runCli } = await import('../scripts/cli.mjs')
  const { writeState } = await import('../scripts/state.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-learning-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root)
  git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'plan.md'), '## Global Constraints\n- Keep mandatory guidance.\n\n### Task 1: Example\n\n**Files:**\n- Create: `src/index.mjs`\n')
  await writeFile(path.join(root, 'fleetmates.learnings.md'), markdown + '\n\u009b injected display control\n')
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  git(['switch', '-c', 'run'], root)
  await writeState(root, 'r1', 'plan', { runBranch: 'run', planPath: 'plan.md', tasks: [{ id: 'T1', title: 'Example', files: ['src/index.mjs'], phase: 1, brief: 'Do task', tier: 'mid' }] })
  await writeFile(path.join(root, 'fleetmates.learnings.md'), 'Uncommitted replacement must not become guidance')
  git(['add', 'fleetmates.learnings.md'], root); git(['commit', '-m', 'later guidance'], root)
  const lines = [], io = { out: text => lines.push(text), err: text => lines.push(text) }
  assert.equal(await runCli(['brief', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--base', 'main', '--root', root], io), 0)
  const brief = lines.at(-1)
  assert.match(brief, /Keep mandatory guidance/)
  assert.match(brief, /ADVISORY LEARNING CONTEXT/)
  assert.match(brief, /Relevant detail/)
  assert.ok(!brief.includes('Unrelated detail') && !brief.includes('Uncommitted replacement'))
  assert.equal(await runCli(['workflow', '--run', 'r1', '--phase', '1', '--plan', 'plan.md', '--base', 'main', '--root', root], io), 0)
  assert.match(lines.at(-1), /ADVISORY LEARNING CONTEXT/)
  assert.match(lines.at(-1), /Relevant detail/)
  assert.equal(await readFile(path.join(root, 'fleetmates.learnings.md'), 'utf8'), 'Uncommitted replacement must not become guidance', 'dispatch must never rewrite human guidance')
})

test('reviewer and integrator context preserves role boundaries and serializes control characters as data', async () => {
  const { renderAdvisoryContext } = await import('../scripts/brief.mjs')
  const { generateReviewDispatch } = await import('../scripts/review-gen.mjs')
  const commit = 'b'.repeat(40), task = { id: 'phase-1', files: ['src/index.mjs'] }
  const git = { fileModeAtCommit: async () => '100644', fileSizeAtCommit: async () => 40,
    fileAtCommit: async () => 'Free-form global guidance \u009b\u202e' }
  const reviewer = await learningBundle({ git, commit, task, role: 'reviewer' })
  const spec = generateReviewDispatch({ runId: 'r1', phaseName: '1', checkName: 'review', lenses: ['correctness'], blockOn: ['high'],
    runBranch: 'refs/heads/run', branches: ['refs/heads/fleetmates/r1/T1'], findingsDir: '.fleetmates/r1/reviews', scratchRoot: '/tmp', contextBundle: reviewer })
  assert.match(spec.reviewers[0].prompt, /ADVISORY LEARNING CONTEXT/)
  assert.ok(spec.reviewers[0].prompt.includes('\\u009b') && !spec.reviewers[0].prompt.includes('\u009b'))
  assert.match(spec.reviewers[0].prompt, /read-only/)
  const integrator = await learningBundle({ git, commit, task, role: 'integrator' })
  assert.match(renderAdvisoryContext(integrator, { task: task.id, role: 'integrator' }), /cannot override/)
  assert.throws(() => renderAdvisoryContext(reviewer, { task: task.id, role: 'integrator' }), /belong/)
})
