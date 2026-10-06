import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeVerifierProfile } from '../scripts/verifier-profile.mjs'
import { runCommandCheck, defaultExec } from '../scripts/gate-runner.mjs'
test('Node profile preserves enforcement and required omissions without executing package scripts', () => {
  const pkg = { scripts: { build: 'throw', test: 'node --test', typecheck: 'tsc --noEmit' } }
  const profile = nodeVerifierProfile({ package: pkg, platform: 'linux', required: ['test', 'typecheck'] })
  assert.equal(profile.ready, true)
  assert.deepEqual(profile.phases.default.checks.map(c => c.name), ['typecheck', 'test', 'build', 'fileset', 'ownership', 'review'])
  assert.deepEqual(profile.acceptance.map(c => c.id), ['test', 'typecheck'])
  assert.equal(profile.phases.default.checks.find(c => c.name === 'test').report.format, 'junit')
  assert.equal(nodeVerifierProfile({ package: { scripts: { build: 'npm run build' } } }).ready, false)
  assert.deepEqual(nodeVerifierProfile({ package: {} }).missing, ['test'])
  assert.equal(nodeVerifierProfile({ package: pkg, platform: 'win32' }).phases.default.checks.find(c => c.name === 'test').run, 'npm run test')
  assert.throws(() => nodeVerifierProfile({ package: { scripts: { test: '' } } }), /Invalid test/)
  assert.throws(() => nodeVerifierProfile({ package: pkg, required: ['deploy'] }), /Invalid/)
  assert.equal(profile.identity, nodeVerifierProfile({ package: { scripts: { typecheck: 'tsc --noEmit', test: 'node --test', build: 'throw' } }, platform: 'linux', required: ['test', 'typecheck'] }).identity)
  assert.notEqual(profile.identity, nodeVerifierProfile({ package: pkg, platform: 'darwin', required: ['test', 'typecheck'] }).identity)
})
test('command outcomes distinguish timeout from unknown failure without guessing from stderr', async () => {
  const check = { name: 'test', kind: 'command', run: 'unused' }
  const run = result => runCommandCheck(check, { exec: async () => result })
  assert.equal((await run({ code: 0, output: 'ok' })).outcome.category, 'success')
  const failed = await run({ code: 1, output: 'infrastructure outage assertion failed ENOENT flaky' })
  assert.equal(failed.status, 'fail')
  assert.equal(failed.outcome.category, 'unclassified')
  assert.equal(failed.outcome.repair, 'inspect-evidence-before-code-changes')
  assert.equal((await run({ code: 1, output: 'time limit', timedOut: true })).outcome.category, 'timeout')
  assert.equal((await run({ code: 0, output: 'interrupted', timedOut: true })).status, 'fail')
})
test('actual timed out commands expose structured timeout instead of a false successful check', { skip: process.platform === 'win32' }, async () => {
  const result = await defaultExec('node -e "setTimeout(() => {}, 10000)"', process.cwd(), { timeoutMs: 150, graceMs: 50 })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.code, 0)
})
test('workflow report emits a reviewable verifier profile without satisfying human acceptance', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { runCli } = await import('../scripts/cli.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-profile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'input.json'), output = []
  const input = { inputs: { commit: 'c', plan: 'p', manifest: 'm', environment: 'e', verifier: 'v' }, requirements: [{ id: 'human', kind: 'human' }], evidence: [], verifierProfile: { package: { scripts: { test: 'node --test' } }, platform: 'linux' } }
  await writeFile(file, JSON.stringify(input))
  assert.equal(await runCli(['workflow-report', '--file', file, '--root', root], { out: v => output.push(v) }), 4)
  assert.equal(JSON.parse(output.at(-1)).verifierProfile.action, 'review-and-track-manifest')
  assert.equal(JSON.parse(output.at(-1)).acceptance.complete, false)
  input.verifierProfile.required = ['invalid']
  await writeFile(file, JSON.stringify(input))
  assert.equal(await runCli(['workflow-report', '--file', file, '--root', root], { out: v => output.push(v) }), 2)
})
