import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createGit } from '../scripts/git.mjs'
import { defaultExec } from '../scripts/gate-runner.mjs'

import { validateEnvironmentRecipe, captureEnvironment } from '../scripts/environment-preflight.mjs'
const recipe = () => ({ version: 1,
  toolchains: [{ name: 'node', command: process.execPath, argv: ['--version'], expected: `v${process.versions.node.split('.')[0]}.` }],
  lockfiles: ['lock.json'], setup: [{ name: 'setup', run: 'node setup.mjs', timeoutMs: 2000 }],
  baseline: [{ name: 'test', run: 'node baseline.mjs', timeoutMs: 2000 }],
  required: ['harness'], dependencies: 'clean-checkout' })
const hashPattern = /^[a-f0-9]{64}$/
function gitCommand(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
async function fixture(t, value = recipe(), files = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'fm-env-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  gitCommand(cwd, ['init', '-q', '-b', 'main'])
  gitCommand(cwd, ['config', 'user.name', 'Test'])
  gitCommand(cwd, ['config', 'user.email', 'test@example.invalid'])
  for (const [name, content] of Object.entries({ 'recipe.json': JSON.stringify(value), 'lock.json': '{}\n',
    'setup.mjs': "import { writeFileSync } from 'node:fs'; writeFileSync('prepared', 'yes'); console.log('setup');\n",
    'baseline.mjs': "import { readFileSync } from 'node:fs'; if (readFileSync('prepared', 'utf8') !== 'yes') process.exit(1); console.log('baseline');\n", ...files })) {
    await writeFile(path.join(cwd, name), content)
  }
  const commit = () => { gitCommand(cwd, ['add', '.']); gitCommand(cwd, ['commit', '-qm', 'test: fixture']); return gitCommand(cwd, ['rev-parse', 'HEAD']) }
  const anchor = commit()
  const capture = async (options = {}) => {
    const report = await captureEnvironment({ git: createGit({ cwd }), commit: anchor, recipePath: 'recipe.json', cwd, ...options })
    for (const group of [report.setup, report.baseline]) for (const check of group?.checks ?? []) {
      if (check.log?.path) t.after(() => rm(path.dirname(check.log.path), { recursive: true, force: true }))
    }
    return report
  }
  return { cwd, anchor, commit, capture }
}

test('recipe validation rejects malformed and unbounded nested contracts', () => {
  assert.deepEqual(validateEnvironmentRecipe(recipe()), recipe())
  const invalid = [null, [], { ...recipe(), version: 2 }, { ...recipe(), network: true },
    { ...recipe(), dependencies: 'hermetic' }, { ...recipe(), required: ['unknown'] },
    { ...recipe(), baseline: [] }, { ...recipe(), setup: Array.from({ length: 21 }, (_, i) => ({ ...recipe().setup[0], name: `setup-${i}` })) },
    { ...recipe(), lockfiles: ['../lock'] }, { ...recipe(), lockfiles: ['a\\b'] },
    { ...recipe(), toolchains: [{ ...recipe().toolchains[0], argv: [1] }] },
    { ...recipe(), toolchains: [{ ...recipe().toolchains[0], expected: '' }] },
    { ...recipe(), setup: [{ ...recipe().setup[0], timeoutMs: 0 }] },
    { ...recipe(), setup: [{ ...recipe().setup[0], timeoutMs: 3600001 }] },
    { ...recipe(), setup: [{ ...recipe().setup[0], run: 'x'.repeat(8193) }] },
    { ...recipe(), setup: [{ ...recipe().setup[0], optional: true }] },
    { ...recipe(), required: ['harness', 'harness'] }, { ...recipe(), lockfiles: ['lock.json', 'lock.json'] },
    { ...recipe(), toolchains: Array.from({ length: 21 }, (_, i) => ({ ...recipe().toolchains[0], name: `tool-${i}` })) },
    { ...recipe(), lockfiles: Array.from({ length: 21 }, (_, i) => `lock-${i}`) },
    { ...recipe(), baseline: Array.from({ length: 21 }, (_, i) => ({ ...recipe().baseline[0], name: `test-${i}` })) },
    { ...recipe(), toolchains: [{ ...recipe().toolchains[0], argv: Array(21).fill('x') }] },
    { ...recipe(), toolchains: [{ ...recipe().toolchains[0], command: 'node\u0000' }] },
    { ...recipe(), toolchains: [{ ...recipe().toolchains[0], argv: ['x'.repeat(2049)] }] },
    { ...recipe(), toolchains: [{ ...recipe().toolchains[0], expected: 'x'.repeat(257) }] },
    { ...recipe(), toolchains: [{ ...recipe().toolchains[0], extra: true }] },
    { ...recipe(), setup: [{ ...recipe().setup[0], name: '' }] },
    { ...recipe(), toolchains: [{ ...recipe().toolchains[0], argv: ['\u0000'] }] },
    { ...recipe(), toolchains: [recipe().toolchains[0], recipe().toolchains[0]] },
    { ...recipe(), setup: [recipe().setup[0], recipe().setup[0]] },
    { ...recipe(), baseline: [recipe().baseline[0], recipe().baseline[0]] }]
  for (const value of invalid) assert.throws(() => validateEnvironmentRecipe(value), /Invalid/, JSON.stringify(value))
})

test('not-executed capture is not ready and invokes no executor', async t => {
  const f = await fixture(t)
  const report = await f.capture({ exec: async () => { assert.fail('not-executed invoked a command') } })
  assert.equal(report.ready, false)
  assert.equal(report.baseline.status, 'not-executed')
  assert.equal(report.toolchains[0].state, 'not-executed')
  assert.equal(report.sources.commit, f.anchor)
  assert.match(report.identity, hashPattern)
})

test('actual clean Node fixture executes setup before baseline and retains complete logs and durations', async t => {
  const f = await fixture(t)
  const report = await f.capture({ execute: true })
  assert.equal(report.ready, true)
  assert.equal(report.baseline.status, 'pass')
  assert.equal(report.setup.status, 'pass')
  assert.equal(report.toolchains[0].version, `v${process.versions.node}`)
  assert.equal(report.platform.os, process.platform)
  assert.equal(report.platform.arch, process.arch)
  assert.equal(report.dependencies.layout, 'clean-checkout')
  assert.ok(Number.isFinite(report.durationMs), 'capture duration must be finite')
  assert.ok(report.durationMs >= 0)
  for (const [name, group] of [['setup', report.setup], ['baseline', report.baseline]]) {
    assert.ok(Number.isFinite(group.durationMs), `${name} duration must be finite`)
    assert.ok(group.durationMs >= 0)
    assert.equal(group.checks.length, 1)
    for (const check of group.checks) {
      assert.equal(check.log.complete, true)
      assert.ok(Number.isFinite(check.durationMs), `${name}/${check.name} command duration must be finite`)
      assert.ok(check.durationMs >= 0)
      assert.match(await readFile(check.log.path, 'utf8'), /setup|baseline/)
    }
  }
})

test('explicit unknown clock preserves null durations after successful actual execution', async t => {
  const f = await fixture(t)
  const report = await f.capture({ execute: true, now: () => NaN })
  assert.equal(report.ready, true)
  assert.equal(report.durationMs, null)
  for (const group of [report.setup, report.baseline]) {
    assert.equal(group.status, 'pass')
    assert.equal(group.durationMs, null)
    assert.equal(group.checks.length, 1)
    for (const check of group.checks) assert.equal(check.durationMs, null)
  }
})

test('anchored recipes ignore working substitutions and change with committed lockfile and recipe bytes', async t => {
  const f = await fixture(t)
  const original = await f.capture()
  await writeFile(path.join(f.cwd, 'recipe.json'), 'not JSON')
  await writeFile(path.join(f.cwd, 'lock.json'), 'uncommitted')
  assert.equal((await f.capture()).identity, original.identity)
  await writeFile(path.join(f.cwd, 'recipe.json'), JSON.stringify(recipe()))
  let commit = f.commit()
  const changedLock = await f.capture({ commit })
  assert.notEqual(changedLock.sources.lockfiles[0].sha256, original.sources.lockfiles[0].sha256)
  assert.notEqual(changedLock.identity, original.identity)
  await writeFile(path.join(f.cwd, 'recipe.json'), JSON.stringify({ ...recipe(), required: ['ci'] }))
  commit = f.commit()
  const changedRecipe = await f.capture({ commit })
  assert.notEqual(changedRecipe.sources.recipe.sha256, changedLock.sources.recipe.sha256)
  assert.notEqual(changedRecipe.identity, changedLock.identity)
  await rm(path.join(f.cwd, 'lock.json'))
  if (process.platform !== 'win32') await symlink('setup.mjs', path.join(f.cwd, 'lock.json'))
  else await writeFile(path.join(f.cwd, 'lock.json'), 'different lockfile')
  f.commit()
  await assert.doesNotReject(async () => {
    assert.equal((await f.capture()).identity, original.identity)
  })
})

test('unsafe paths, missing blobs, symlink anchors and oversized blobs refuse before execution', async t => {
  const f = await fixture(t)
  const exec = async () => assert.fail('invalid source executed')
  for (const recipePath of ['../recipe.json', '/recipe.json', 'a\\b', ':recipe.json', '*.json', 'missing.json', '.', 'a//b', 'a/../b']) {
    await assert.rejects(f.capture({ recipePath, execute: true, exec }), /Invalid|regular/)
  }
  for (const commit of ['HEAD', '-x', 'a'.repeat(39)]) await assert.rejects(f.capture({ commit, exec }), /Invalid/)
  if (process.platform !== 'win32') await symlink('recipe.json', path.join(f.cwd, 'linked.json'))
  await writeFile(path.join(f.cwd, 'large.json'), ' '.repeat(512 * 1024 + 1))
  const commit = f.commit()
  if (process.platform !== 'win32') await assert.rejects(f.capture({ commit, recipePath: 'linked.json', execute: true, exec }), /regular/)
  await assert.rejects(f.capture({ commit, recipePath: 'large.json', execute: true, exec }), /size/)
})

test('declared lockfiles must be present bounded regular anchored blobs', async t => {
  for (const mode of ['missing', 'link', 'large']) {
    if (mode === 'link' && process.platform === 'win32') continue
    const f = await fixture(t, { ...recipe(), lockfiles: ['declared.lock'] })
    if (mode === 'link') await symlink('lock.json', path.join(f.cwd, 'declared.lock'))
    if (mode === 'large') await writeFile(path.join(f.cwd, 'declared.lock'), 'x'.repeat(512 * 1024 + 1))
    const commit = mode === 'missing' ? f.anchor : f.commit()
    await assert.rejects(f.capture({ commit, execute: true, exec: async () => assert.fail('bad lock executed') }), /regular|size/)
  }
})

test('malformed committed recipe refuses before probing tools', async t => {
  const f = await fixture(t, { ...recipe(), publication: true })
  await assert.rejects(f.capture({ execute: true, exec: async () => assert.fail('malformed recipe executed') }), /Invalid/)
  const syntax = await fixture(t, recipe(), { 'recipe.json': '{' })
  await assert.rejects(syntax.capture({ execute: true, exec: async () => assert.fail('invalid JSON executed') }), /Invalid.*JSON/)
})

test('missing and incompatible actual tools block setup and baseline', async t => {
  for (const tool of [{ ...recipe().toolchains[0], command: 'fleetmates-missing-executable' },
    { ...recipe().toolchains[0], expected: 'v0.' }]) {
    const f = await fixture(t, { ...recipe(), toolchains: [tool] })
    const calls = []
    const report = await f.capture({ execute: true, exec: async (cmd, cwd, options) => {
      calls.push(options.argv); return defaultExec(cmd, cwd, options)
    } })
    assert.equal(report.ready, false)
    assert.equal(report.toolchains[0].state, 'unavailable')
    assert.equal(report.setup.status, 'blocked')
    assert.equal(report.baseline.status, 'blocked')
    assert.deepEqual(calls, [['--version']])
  }
})

test('tool probes use finite argv-only limits and incomplete probes block', async t => {
  const f = await fixture(t)
  for (const failure of ['timedOut', 'outputLimited', 'nonzero', 'empty']) {
    const calls = []
    const report = await f.capture({ execute: true, exec: async (_cmd, _cwd, options) => {
      calls.push(options)
      return { code: failure === 'nonzero' ? 1 : 0, output: failure === 'empty' ? '' : `v${process.versions.node}`, [failure]: true }
    } })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].argv, ['--version'])
    assert.equal(calls[0].timeoutMs, 5000)
    assert.equal(calls[0].graceMs, 250)
    assert.equal(calls[0].maxOutputBytes, 65536)
    assert.equal(calls[0].maxCaptureBytes, 65536)
    assert.equal(report.ready, false)
    assert.equal(report.toolchains[0].state, 'unavailable')
    assert.equal(report.baseline.status, 'blocked')
  }
})

test('setup nonzero, actual timeout and incomplete storage block baseline', async t => {
  for (const mode of ['exit', 'timeout', 'storage']) {
    const value = recipe()
    if (mode === 'timeout') value.setup[0].timeoutMs = 30
    const f = await fixture(t, value, { 'setup.mjs': mode === 'exit' ? 'process.exit(7)' : mode === 'timeout' ? 'setInterval(() => {}, 1000)' : "console.log('setup')" })
    let baselineCalls = 0
    if (mode === 'storage') t.mock.method(fs, 'writeSync', () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }) })
    const report = await f.capture({ execute: true, exec: async (cmd, cwd, options) => {
      if (cmd === 'node baseline.mjs') baselineCalls++
      return defaultExec(cmd, cwd, options)
    } })
    t.mock.restoreAll()
    assert.equal(report.ready, false)
    assert.equal(report.setup.status, 'fail')
    assert.equal(report.baseline.status, 'blocked')
    assert.equal(baselineCalls, 0)
    if (mode === 'exit') assert.equal(report.setup.checks[0].exitCode, 7)
    else assert.equal(report.setup.checks[0].log.complete, false)
  }
})

test('log creation failure blocks commands and preserves unknown durations', async t => {
  const f = await fixture(t)
  const originalOpen = fs.openSync
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).endsWith('output.log')) {
      t.after(() => rm(path.dirname(file), { recursive: true, force: true }))
      throw Object.assign(new Error('storage unavailable'), { code: 'EACCES' })
    }
    return originalOpen(file, ...args)
  })
  let checks = 0
  const report = await f.capture({ execute: true, now: () => NaN, exec: async (cmd, cwd, options) => {
    if (!options.argv) checks++
    return defaultExec(cmd, cwd, options)
  } })
  t.mock.restoreAll()
  assert.equal(report.ready, false)
  assert.equal(report.setup.status, 'fail')
  assert.equal(report.baseline.status, 'blocked')
  assert.equal(checks, 0)
  assert.equal(report.setup.checks[0].status, 'fail')
  assert.equal(report.setup.durationMs, null)
  assert.equal(report.setup.checks[0].durationMs, null)
})

test('execution output is bounded and baseline failures cannot be ready', async t => {
  for (const mode of ['output', 'exit']) {
    const f = await fixture(t, recipe(), { 'baseline.mjs': mode === 'output' ? "process.stdout.write('x'.repeat(100000))" : 'process.exit(9)' })
    const report = await f.capture({ execute: true })
    assert.equal(report.setup.status, 'pass')
    assert.equal(report.baseline.status, 'fail')
    assert.equal(report.ready, false)
    if (mode === 'output') assert.equal(report.baseline.checks[0].log.complete, false)
    else assert.equal(report.baseline.checks[0].exitCode, 9)
  }
})

test('linked dependencies disclose reproduction limits', async t => {
  const f = await fixture(t, { ...recipe(), dependencies: 'linked' })
  if (process.platform !== 'win32') await symlink('.', path.join(f.cwd, 'node_modules'))
  const report = await f.capture({ execute: true })
  assert.equal(report.ready, true)
  assert.equal(report.dependencies.layout, 'linked')
  assert.equal(report.dependencies.reproducible, false)
  assert.ok(report.dependencies.limitations.length > 0)
})

test('identity ignores time logs and raw output but binds tool versions platform and outcomes', async t => {
  const f = await fixture(t)
  let tick = 0
  const fakeExec = version => async (_cmd, _cwd, options) => ({ code: 0, output: options.argv ? version : `output-${tick++}` })
  const first = await f.capture({ execute: true, now: () => tick++, exec: fakeExec(`v${process.versions.node}`) })
  tick = 1000
  const second = await f.capture({ execute: true, now: () => { tick += 17; return tick }, exec: fakeExec(`v${process.versions.node}`) })
  assert.notEqual(first.startedAt, second.startedAt)
  assert.notEqual(first.durationMs, second.durationMs)
  assert.notEqual(first.setup.checks[0].log.path, second.setup.checks[0].log.path)
  assert.equal(first.identity, second.identity)
  const version = await f.capture({ execute: true, exec: fakeExec(`v${process.versions.node}-changed`) })
  assert.notEqual(first.identity, version.identity)
  assert.notEqual(first.identity, (await f.capture()).identity)
  const failed = await f.capture({ execute: true, exec: async (_cmd, _cwd, options) => ({ code: options.argv ? 0 : 1, output: options.argv ? `v${process.versions.node}` : '' }) })
  assert.notEqual(first.identity, failed.identity)
  t.mock.property(process, 'arch', 'fixture-arch')
  const platform = await f.capture({ execute: true, exec: fakeExec(`v${process.versions.node}`) })
  assert.notEqual(first.identity, platform.identity)
})
