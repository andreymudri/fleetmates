import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeCi, collectGitHubCi } from '../scripts/ci-evidence.mjs'
const inputs = { commit: 'a'.repeat(40), plan: 'p', manifest: 'm', environment: 'e', verifier: 'v' }
const required = [{ name: 'test', app: 'github-actions', task: 'T1' }]
const check = (id, conclusion = 'success', extra = {}) => ({ id, name: 'test', app: { slug: 'github-actions' }, head_sha: inputs.commit, status: 'completed', conclusion, html_url: 'https://github.com/example/project/actions/runs/1', ...extra })
const report = checks => summarizeCi({ inputs, required, snapshot: { total_count: checks.length, check_runs: checks } })
test('CI requires exact tested commit and newest explicit app attempt; skipped and partial snapshots never pass', () => {
  assert.equal(report([check(1)]).complete, true)
  assert.equal(report([check(1), check(2, null, { status: 'in_progress' })]).complete, false)
  assert.equal(report([check(1, 'failure'), check(2)]).complete, true)
  assert.equal(report([check(1, 'success', { head_sha: 'b'.repeat(40) })]).complete, false)
  assert.equal(report([check(1, 'success', { app: { slug: 'other' } })]).complete, false)
  for (const conclusion of ['skipped', 'neutral', 'cancelled', null]) assert.equal(report([check(1, conclusion)]).obligations[0].status, 'unresolved')
  assert.equal(report([check(1, 'timed_out')]).obligations[0].status, 'fail')
  assert.equal(summarizeCi({ inputs, required, snapshot: { total_count: 101, check_runs: [check(1)] } }).complete, false)
  assert.deepEqual(report([check(1), check(2)]).obligations[0].previousAttempts, [1])
})
test('CI contract refuses ambiguous required identities and preserves declared non-code input identity', () => {
  assert.throws(() => summarizeCi({ inputs, required: [], snapshot: { total_count: 0, check_runs: [] } }), /Invalid/)
  assert.throws(() => summarizeCi({ inputs, required: [...required, ...required], snapshot: { total_count: 0, check_runs: [] } }), /Duplicate/)
  assert.throws(() => report([check(1), check(1)]), /attempt identity/)
  assert.throws(() => report([check(-1)]), /attempt identity/)
  const first = report([check(1)])
  for (const key of ['plan', 'manifest', 'environment', 'verifier']) assert.notEqual(summarizeCi({ inputs: { ...inputs, [key]: 'changed' }, required, snapshot: { total_count: 1, check_runs: [check(1)] } }).identity, first.identity)
})
test('GitHub collector is bounded and read-only, refuses moved inputs and reports unavailable capabilities', async () => {
  let calls = 0, options
  const git = { headBranch: async () => ({ ok: true, ref: 'refs/heads/run' }), resolveRef: async () => inputs.commit }
  const exec = async (command, args, opts) => { calls++; options = opts; assert.equal(command, 'gh'); assert.deepEqual(args, ['api', `repos/example/project/commits/${inputs.commit}/check-runs?per_page=100`]); return { stdout: JSON.stringify({ total_count: 1, check_runs: [check(1)] }) } }
  const result = await collectGitHubCi({ git, repository: 'example/project', inputs, required, exec })
  assert.equal(result.complete, true)
  assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 1024 * 1024)
  await assert.rejects(collectGitHubCi({ git, repository: 'example/project', inputs: { ...inputs, commit: 'b'.repeat(40) }, required, exec }), /does not match/)
  assert.equal(calls, 1)
  let reads = 0
  await assert.rejects(collectGitHubCi({ git: { ...git, resolveRef: async () => ++reads === 1 ? inputs.commit : 'b'.repeat(40) }, repository: 'example/project', inputs, required, exec }), /changed/)
  await assert.rejects(collectGitHubCi({ git, repository: 'example/project', inputs, required, exec: async () => { throw new Error('private token'); } }), /metadata unavailable/)
})
test('ci-status CLI queries exact current Git SHA and separates pending checks from success', { skip: process.platform === 'win32' }, async t => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { git } = await import('../scripts/workflow-lifecycle.mjs')
  const { runCli } = await import('../scripts/cli.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'fm-ci-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(['init', '-b', 'main'], root); git(['config', 'user.name', 'Test'], root); git(['config', 'user.email', 'test@example.com'], root)
  await writeFile(path.join(root, 'file.txt'), 'baseline')
  git(['add', '.'], root); git(['commit', '-m', 'baseline'], root)
  const sha = git(['rev-parse', 'HEAD'], root)
  const bin = path.join(root, 'bin'); await mkdir(bin)
  const fake = path.join(bin, 'gh')
  const originalPath = process.env.PATH
  process.env.PATH = bin + path.delimiter + originalPath
  t.after(() => { process.env.PATH = originalPath })
  const file = path.join(root, 'input.json')
  await writeFile(file, JSON.stringify({ repository: 'example/project', inputs: { ...inputs, commit: sha }, required }))
  const output = [], io = { out: v => output.push(v) }
  const snapshot = { total_count: 1, check_runs: [check(1, 'success', { head_sha: sha })] }
  const fixture = () => writeFile(fake, '#!/usr/bin/env node\nconsole.log(' + JSON.stringify(JSON.stringify(snapshot)) + ')\n', { mode: 0o755 })
  await fixture()
  assert.equal(await runCli(['ci-status', '--file', file, '--root', root], io), 0)
  assert.equal(JSON.parse(output.at(-1)).commit, sha)
  assert.equal(JSON.parse(output.at(-1)).inputVerification.environment, 'declared-only')
  snapshot.check_runs[0].status = 'in_progress'
  await fixture()
  assert.equal(await runCli(['ci-status', '--file', file, '--root', root], io), 4)
  assert.equal(await runCli(['ci-status', '--root', root], io), 2)
})
