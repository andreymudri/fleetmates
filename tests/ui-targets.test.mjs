import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan } from '../scripts/plan-parser.mjs'
import { readUiTargets } from '../scripts/ui-targets.mjs'
const plan = '### Task 1: Settings\n\n**Files:**\n- Create: `src/settings.mjs`\n\nui: design/settings.html, design/settings.md\n'
test('UI declarations retain exact target paths and reject traversal, unsafe types and duplicates', () => {
  assert.deepEqual(parsePlan(plan)[0].ui, ['design/settings.html', 'design/settings.md'])
  assert.equal(parsePlan(plan.replace('ui: design/settings.html, design/settings.md', '```md\nui: ../ignored.md\n```'))[0].ui, undefined)
  for (const declaration of ['../target.md', '/tmp/target.md', 'design/target.png', 'design/target.md, design/target.md', '', 'design/x\u202e.md']) assert.throws(() => parsePlan(plan.replace('design/settings.html, design/settings.md', declaration)), /UI targets/)
})
test('visual targets are read at the specified anchor as mandatory bounded content', async () => {
  const reads = [], commit = 'a'.repeat(40)
  const git = { fileModeAtCommit: async () => '100644', fileSizeAtCommit: async () => 30, fileAtCommit: async (sha, file) => { reads.push([sha, file]); return 'Target\nKeyboard navigation' } }
  const tasks = parsePlan(plan)
  const items = await readUiTargets({ git, commit, tasks: [...tasks, ...tasks] })
  assert.equal(items.length, 2)
  assert.ok(items.every(item => item.mandatory && item.startLine === 1 && item.endLine === 2))
  assert.ok(reads.every(([sha]) => sha === commit))
  await assert.rejects(readUiTargets({ git: { ...git, fileModeAtCommit: async () => null }, commit, tasks }), /committed regular/)
  await assert.rejects(readUiTargets({ git: { ...git, fileModeAtCommit: async () => '120000' }, commit, tasks }), /committed regular/)
  await assert.rejects(readUiTargets({ git: { ...git, fileSizeAtCommit: async () => 600000 }, commit, tasks }), /512 KiB/)
})
test('init refuses missing target before run state and briefs preserve committed target after later edits', async t => {
  const { mkdtemp, writeFile, mkdir, rm, access } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { git } = await import('../scripts/workflow-lifecycle.mjs')
  const { runCli } = await import('../scripts/cli.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-ui-target-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root)
  git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'plan.md'), plan)
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const output = [], io = { out: value => output.push(value), err: value => output.push(value) }
  const init = ['init-run', 'plan.md', '--run', 'r1', '--root', root]
  assert.equal(await runCli(init, io), 2)
  assert.match(output.at(-1), /committed regular/)
  await assert.rejects(access(path.join(root, '.fleetmates/r1/plan.json')))
  await mkdir(path.join(root, 'design'))
  await writeFile(path.join(root, 'design/settings.html'), '<button>Save</button>')
  await writeFile(path.join(root, 'design/settings.md'), 'Keyboard activation required.')
  git(['add', '.'], root); git(['commit', '-m', 'targets'], root)
  git(['switch', '-c', 'run'], root)
  assert.equal(await runCli(init, io), 0, output.join('\n'))
  await writeFile(path.join(root, 'design/settings.md'), 'Changed later target')
  git(['add', 'design/settings.md'], root); git(['commit', '-m', 'later target'], root)
  assert.equal(await runCli(['brief', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--base', 'main', '--root', root], io), 0)
  assert.match(output.at(-1), /Keyboard activation required/)
  assert.ok(!output.at(-1).includes('Changed later target'))
})
test('UI review method requires rendered and behavioral evidence and marks unavailable verification explicitly', async () => {
  const { generateReviewDispatch } = await import('../scripts/review-gen.mjs')
  const spec = generateReviewDispatch({ runId: 'r1', phaseName: '1', checkName: 'review', lenses: ['ui'], blockOn: ['high'], runBranch: 'refs/heads/run', branches: ['refs/heads/fleetmates/r1/T1'], findingsDir: '.fleetmates/r1/reviews', scratchRoot: '/tmp' })
  const prompt = spec.reviewers[0].prompt
  assert.match(prompt, /keyboard navigation and accessible labels/)
  assert.match(prompt, /rendered output at the declared viewport\/theme\/state/)
  assert.match(prompt, /return unableToVerify naming the missing evidence/)
  assert.match(prompt, /Do not invent a renderer/)
})
