import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { git } from '../scripts/workflow-lifecycle.mjs'
import { runChecks } from '../scripts/gate-runner.mjs'
import { createGit } from '../scripts/git.mjs'
import { runTestChangePolicy } from '../scripts/test-change-policy.mjs'

test('Git test-change policy rejects untested source and missing branches and accepts documented exceptions without claiming coverage', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-test-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root)
  git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'source.mjs'), 'export const value = 1\n')
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const anchorSha = git(['rev-parse', 'HEAD'], root)
  git(['switch', '-c', 'fleetmates/r1/T1'], root)
  await writeFile(path.join(root, 'source.mjs'), 'export const value = 2\n')
  git(['add', '.'], root); git(['commit', '-m', 'change'], root)
  const ctx = { git: createGit({ cwd: root }), runId: 'r1', anchorSha, currentPhase: 1, tasks: [{ id: 'T1', phase: 1 }] }
  const check = { name: 'test-policy', kind: 'tdd' }
  const failed = await runTestChangePolicy(check, ctx)
  assert.equal(failed.status, 'fail'); assert.equal(failed.findings[0].file, 'source.mjs')
  const allowed = await runTestChangePolicy({ ...check, exceptions: [{ path: 'source.mjs', reason: 'existing regression covers behavior', evidence: 'logs/regression.txt' }] }, ctx)
  assert.equal(allowed.status, 'pass'); assert.equal(allowed.temporalTdd, 'unverified'); assert.equal(allowed.declaredExceptions.length, 1)
  assert.equal((await runTestChangePolicy({ ...check, exceptions: [{ path: 'source.mjs', reason: 'just because' }] }, ctx)).status, 'fail')
  assert.equal((await runTestChangePolicy(check, { ...ctx, tasks: [{ id: 'T2', phase: 1 }] })).findings[0].kind, 'missing-task-branch')
  await writeFile(path.join(root, 'source.test.mjs'), 'test placeholder\n')
  git(['add', '.'], root); git(['commit', '-m', 'test change'], root)
  const changed = await runTestChangePolicy(check, ctx)
  assert.equal(changed.status, 'pass'); assert.equal(changed.coverage, 'not-established-by-test-diff')
  assert.equal((await runTestChangePolicy({ ...check, tests: { match: [] } }, ctx)).status, 'fail')
})

test('earlier phase test edits cannot satisfy an untested later task before or after integration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-test-scope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'run'], root)
  git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'source.mjs'), 'export const value = 1\n')
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const anchorSha = git(['rev-parse', 'HEAD'], root)
  git(['switch', '-c', 'fleetmates/r1/T1'], root)
  await writeFile(path.join(root, 'source.test.mjs'), 'earlier test\n')
  git(['add', '.'], root); git(['commit', '-m', 'earlier task'], root)
  git(['switch', 'run'], root); git(['merge', '--no-ff', 'fleetmates/r1/T1', '-m', 'phase one'], root)
  git(['switch', '-c', 'fleetmates/r1/T2'], root)
  await writeFile(path.join(root, 'source.mjs'), 'export const value = 2\n')
  git(['add', '.'], root); git(['commit', '-m', 'later task'], root)
  git(['switch', 'run'], root)
  const ctx = { git: createGit({ cwd: root }), runId: 'r1', anchorSha, runSha: git(['rev-parse', 'HEAD'], root), currentPhase: 2, tasks: [{ id: 'T2', phase: 2 }] }
  const check = { name: 'policy', kind: 'tdd' }
  assert.equal((await runTestChangePolicy(check, ctx)).status, 'fail')
  git(['merge', '--no-ff', 'fleetmates/r1/T2', '-m', 'phase two'], root)
  const integrated = { ...ctx, cwd: root, runBranch: 'run', runSha: git(['rev-parse', 'HEAD'], root) }
  assert.equal((await runTestChangePolicy(check, integrated)).status, 'fail')
  const results = await runChecks([check], integrated)
  assert.equal(results.find(r => r.kind === 'tdd').status, 'fail', 'manifest tdd kind must use the computed runner')
})
