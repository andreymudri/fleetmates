import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, chmod, lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from '../scripts/cli.mjs'
import * as cli from '../scripts/cli.mjs'
import { codexAdapter, buildSpawnArgv, buildResumeArgv } from '../scripts/harnesses/codex.mjs'
import { cursorAdapter } from '../scripts/harnesses/cursor.mjs'
import { getAdapter } from '../scripts/harnesses/index.mjs'
import { defaultExec } from '../scripts/gate-runner.mjs'
import { createGit, defaultGitExec } from '../scripts/git.mjs'

const recipe = { version: 1, toolchains: [], lockfiles: [], setup: [], baseline: [{ name: 'baseline', run: 'node -e "process.exit(0)"', timeoutMs: 5000 }], required: [], dependencies: 'clean-checkout' }
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const policy = { version: 1, roles: { implementer: { read: true, write: true, execute: true, network: false, sharedRefs: false, publication: false } } }

test('actual native console version probes retain stdout and stderr like synchronous writes', { skip: process.platform !== 'linux' }, async t => {
  const { createVerificationExecutor } = await import('../scripts/harnesses/codex.mjs')
  const { resolveRoleCapabilities } = await import('../scripts/role-capabilities.mjs')
  const { captureEnvironment } = await import('../scripts/environment-preflight.mjs')
  const worker = await mkdtemp(path.join(tmpdir(), 'fm-native-output-'))
  let executor
  try {
    const enforcement = resolveRoleCapabilities({ policy, role: 'implementer', harness: 'codex', sandboxMode: 'files', network: false }).enforcement
    const env = { ...process.env, PATH: process.env.FLEETMATES_REAL_CODEX ? path.dirname(process.env.FLEETMATES_REAL_CODEX) + path.delimiter + process.env.PATH : process.env.PATH }
    try { executor = await createVerificationExecutor({ sandbox: { cwd: worker, meta: { mode: 'files' } }, enforcement, env }) }
    catch (error) { t.skip(`Native restriction preflight unavailable: ${error.message}`); return }
    const asynchronous = await executor.exec(process.execPath, worker, { argv: ['-e', "console.log('v1');console.error('stderr')"] })
    const synchronous = await executor.exec(process.execPath, worker, { argv: ['-e', "require('fs').writeSync(1,'v1\\n');require('fs').writeSync(2,'stderr\\n')"] })
    assert.equal(asynchronous.code, 0)
    assert.equal(synchronous.output, 'v1\nstderr\n')
    assert.equal(asynchronous.output, synchronous.output)
    const pipes = await executor.exec(process.execPath, worker, { argv: ['-e', "const fs=require('fs');fs.writeSync(1,JSON.stringify([fs.fstatSync(1).isFIFO(),fs.fstatSync(2).isFIFO()]))"] })
    assert.equal(pipes.output, '[true,true]')
    const nonzero = await executor.exec(process.execPath, worker, { argv: ['-e', "console.log('ordinary exit');process.exitCode=9"] })
    assert.equal(nonzero.code, 9)
    assert.equal(nonzero.output, 'ordinary exit\n')
    assert.equal(nonzero.completed, true)
    const signal = await executor.exec(process.execPath, worker, { argv: ['-e', "process.kill(process.pid,'SIGTERM')"] })
    assert.equal(signal.code, 143)
    assert.equal(signal.signal, 'SIGTERM')
    assert.equal(signal.completed, true)
    const launch = await executor.exec('/fm-missing-command', worker, { argv: [] })
    assert.notEqual(launch.code, 0)
    assert.equal(launch.completed, false)
    assert.equal(launch.launchError, 'ENOENT')
    const limited = await executor.exec(process.execPath, worker, { argv: ['-e', "console.log('x'.repeat(100))"], maxOutputBytes: 16 })
    assert.equal(limited.outputLimited, true)
    assert.ok(Buffer.byteLength(limited.output) <= 16)
    const timedOut = await executor.exec(process.execPath, worker, { argv: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 200 })
    assert.equal(timedOut.timedOut, true)
    assert.notEqual(timedOut.code, 0)
    const bytes = JSON.stringify({ ...recipe, toolchains: [{ name: 'console-version', command: process.execPath, argv: ['-e', "console.log('v1')"], expected: 'v1' }], baseline: [{ name: 'baseline', run: 'true', timeoutMs: 5000 }] })
    const git = { fileModeAtCommit: async () => '100644', fileSizeAtCommit: async () => Buffer.byteLength(bytes), fileAtCommit: async () => bytes }
    const report = await captureEnvironment({ git, commit: 'a'.repeat(40), recipePath: 'recipe.json', cwd: worker, execute: true, exec: executor.exec })
    assert.equal(report.ready, true)
    assert.equal(report.toolchains[0].version, 'v1')
    assert.equal(executor.evidence.observed, true)
  } finally { await executor?.close(); await rm(worker, { recursive: true, force: true }) }
})
async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-prereq-'))
  const gitRun = args => defaultGitExec(args, root)
  try {
    await gitRun(['init', '--initial-branch=main'])
    await gitRun(['config', 'user.name', 'Fixture'])
    await gitRun(['config', 'user.email', 'fixture@example.invalid'])
    await writeFile(path.join(root, 'recipe.json'), JSON.stringify(recipe))
    await writeFile(path.join(root, 'policy.json'), JSON.stringify(policy))
    await gitRun(['add', '.'])
    await gitRun(['commit', '-m', 'test: fixture'])
    const git = createGit({ cwd: root })
    await fn({ root, git, gitRun, commit: await git.headSha() })
  } finally { await rm(root, { recursive: true, force: true }) }
}
async function command(root, args) {
  const output = []
  const code = await runCli([...args, '--root', root], { out: s => output.push(s), err: s => output.push(s) })
  return { code, output: output.join('\n') }
}

test('environment-check requires executed baseline and rejects supplied readiness', async () => fixture(async ({ root, commit }) => {
  const input = path.join(root, 'input.json')
  await writeFile(input, JSON.stringify({ commit, recipePath: 'recipe.json' }))
  let result = await command(root, ['environment-check', '--file', input])
  assert.equal(result.code, 4)
  assert.equal(JSON.parse(result.output).baseline.status, 'not-executed')
  result = await command(root, ['environment-check', '--file', input, '--execute'])
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.output).baseline.status, 'pass')
  await writeFile(input, JSON.stringify({ commit, recipePath: 'recipe.json', ready: true }))
  assert.equal((await command(root, ['environment-check', '--file', input, '--execute'])).code, 2)
}))

test('environment-check uses committed recipe independently of local substitutions', async () => fixture(async ({ root, commit }) => {
  await writeFile(path.join(root, 'recipe.json'), '{}')
  const input = path.join(root, 'input.json')
  await writeFile(input, JSON.stringify({ commit, recipePath: 'recipe.json' }))
  assert.equal((await command(root, ['environment-check', '--file', input, '--execute'])).code, 0)
}))

for (const cmd of ['dispatch', 'dispatch-reviews', 'dispatch-integrator']) {
  test(`${cmd} refuses untracked, unsafe and changed contracts before spawn`, async () => fixture(async ({ root }) => {
    const args = [cmd, '--run', 'r1', ...(cmd === 'dispatch' ? ['--phase', '1'] : [])]
    await writeFile(path.join(root, 'untracked.json'), JSON.stringify(recipe))
    for (const file of ['missing.json', 'untracked.json', '../recipe.json', '/recipe.json']) {
      const result = await command(root, [...args, '--environment', file])
      assert.equal(result.code, 2)
      assert.match(result.output, /contract|source|path/i)
    }
    await writeFile(path.join(root, 'recipe.json'), '{}')
    const result = await command(root, [...args, '--environment', 'recipe.json'])
    assert.equal(result.code, 2)
    assert.match(result.output, /changed/i)
  }))
}

test('required dispatch preparation blocks setup, render, Vault and sharedRefs without adapter effects', async () => fixture(async ({ root, gitRun }) => {
  assert.equal(typeof cli.prepareDispatchPrerequisites, 'function')
  const calls = []
  const adapter = { name: 'codex', defaultSandbox: 'clone', makeSandbox: async () => calls.push('sandbox'), spawn: async () => calls.push('spawn'), resume: async () => calls.push('resume'), collect: async () => calls.push('collect') }
  for (const change of [{ setup: [{ name: 'setup', run: 'node -e "process.exit(9)"', timeoutMs: 5000 }] }, { required: ['render'] }, { required: ['vault'] }]) {
    await writeFile(path.join(root, 'recipe.json'), JSON.stringify({ ...recipe, ...change }))
    await gitRun(['add', '.'])
    await gitRun(['commit', '-m', 'test: recipe'])
    const result = await cli.prepareDispatchPrerequisites({ root, flags: { environment: 'recipe.json' }, adapter, role: 'implementer', sandboxMode: 'clone', network: false, env: { CHROMIUM_PATH: 'missing-fixture-browser' }, exec: (command, cwd, options) => command === 'codex' ? Promise.resolve({ code: 0, output: 'Logged in\n' }) : defaultExec(command, cwd, options) })
    assert.equal(result.code, 4)
    assert.equal(result.report.ready, false)
  }
  await writeFile(path.join(root, 'policy.json'), JSON.stringify({ version: 1, roles: { implementer: { ...policy.roles.implementer, sharedRefs: true } } }))
  await gitRun(['add', '.'])
  await gitRun(['commit', '-m', 'test: policy'])
  const result = await cli.prepareDispatchPrerequisites({ root, flags: { 'role-policy': 'policy.json' }, adapter, role: 'implementer', sandboxMode: 'clone', network: false })
  assert.equal(result.code, 4)
  assert.match(JSON.stringify(result.report), /sharedRefs/)
  assert.deepEqual(calls, [])
}))

test('required dispatch wrapper propagates enforcement and rechecks contracts before every adapter effect', async () => fixture(async ({ root, gitRun }) => {
  assert.equal(typeof cli.prepareDispatchPrerequisites, 'function')
  const calls = []
  const sandbox = { cwd: root, meta: { mode: 'clone', gitdir: '/fixture/git' } }
  const fakeGit = () => {}
  const adapter = { name: 'codex', makeSandbox: async (git, options) => { assert.equal(git, fakeGit); assert.equal(options.mode, 'clone'); return sandbox }, ...Object.fromEntries(['spawn', 'resume', 'collect'].map(name => [name, async args => { calls.push([name, args.enforcement]); return {} }])) }
  const result = await cli.prepareDispatchPrerequisites({ root, flags: { 'role-policy': 'policy.json' }, adapter, role: 'implementer', sandboxMode: 'clone', network: false, exec: async () => ({ code: 0, output: 'Logged in\n' }) })
  assert.equal(result.code, 0)
  await result.adapter.makeSandbox(fakeGit, { mode: 'clone', runBranch: 'main' })
  await result.adapter.spawn({ sandbox })
  await result.adapter.resume({ sandbox })
  assert.equal(calls.length, 2)
  for (const [, enforcement] of calls) assert.equal(enforcement?.sandbox, 'workspace-write')
  await writeFile(path.join(root, 'policy.json'), '{}')
  for (const name of ['makeSandbox', 'spawn', 'resume', 'collect']) {
    const args = name === 'makeSandbox' ? [fakeGit, { mode: 'clone', runBranch: 'main' }] : name === 'collect' ? [fakeGit, { sandbox }] : [{ sandbox }]
    await assert.rejects(result.adapter[name](...args), /changed/)
  }
  assert.equal(calls.length, 2)
  await writeFile(path.join(root, 'policy.json'), JSON.stringify(policy))
  await gitRun(['commit', '--allow-empty', '-m', 'test: changed head'])
  await assert.rejects(result.adapter.spawn({ sandbox }), /changed/)
}))

test('dispatch checks declared lockfile substitutions before executing setup', async () => fixture(async ({ root, gitRun }) => {
  await writeFile(path.join(root, 'lock.json'), '{}')
  await writeFile(path.join(root, 'recipe.json'), JSON.stringify({ ...recipe, lockfiles: ['lock.json'] }))
  await gitRun(['add', '.'])
  await gitRun(['commit', '-m', 'test: lockfile'])
  await writeFile(path.join(root, 'lock.json'), '{"changed":true}')
  const calls = []
  await assert.rejects(cli.prepareDispatchPrerequisites({ root, flags: { environment: 'recipe.json' }, adapter: { name: 'codex' }, role: 'implementer', sandboxMode: 'clone', network: false,
    exec: async (...args) => { calls.push(args); return defaultExec(...args) } }), /changed/)
  assert.deepEqual(calls, [])
}))

test('required dispatch refuses symlink substitutions and unavailable authentication', async () => fixture(async ({ root }) => {
  const options = { root, flags: { 'role-policy': 'policy.json' }, adapter: { name: 'codex' }, role: 'implementer', sandboxMode: 'clone', network: false }
  const report = await cli.prepareDispatchPrerequisites({ ...options, exec: async () => ({ code: 1, output: 'Not logged in' }) })
  assert.equal(report.code, 4)
  assert.equal(report.report.capabilities.ready, false)
  await rm(path.join(root, 'policy.json'))
  await symlink('recipe.json', path.join(root, 'policy.json'))
  await assert.rejects(cli.prepareDispatchPrerequisites(options), /changed/)
}))

test('CLI blocked setup and Vault contracts never reach adapter probe, sandbox, spawn or collect', async () => fixture(async ({ root, gitRun }) => {
  await writeFile(path.join(root, 'plan.md'), '### Task 1: fixture\n\n**Files:**\n- Create: `fixture.mjs`\n')
  await gitRun(['add', '.'])
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
  await gitRun(['add', '.gitignore'])
  await gitRun(['commit', '-m', 'test: blocked dispatch plan'])
  await gitRun(['checkout', '-b', 'run'])
  assert.equal((await command(root, ['init-run', 'plan.md', '--run', 'r1'])).code, 0)
  const adapter = getAdapter('codex')
  const methods = ['probe', 'makeSandbox', 'spawn', 'resume', 'collect']
  const originals = Object.fromEntries(methods.map(method => [method, adapter[method]]))
  const calls = []
  for (const method of methods) adapter[method] = async () => { calls.push(method); throw new Error('unexpected adapter effect') }
  try {
    for (const change of [{ setup: [{ name: 'setup', run: 'node -e "process.exit(9)"', timeoutMs: 5000 }] }, { required: ['vault'] }]) {
      await writeFile(path.join(root, 'recipe.json'), JSON.stringify({ ...recipe, ...change }))
      await gitRun(['add', '.'])
      await gitRun(['commit', '-m', 'test: blocked recipe'])
      for (const name of ['dispatch', 'dispatch-reviews', 'dispatch-integrator']) {
        const result = await command(root, [name, '--run', 'r1', ...(name === 'dispatch' ? ['--phase', '1'] : []), '--environment', 'recipe.json'])
        assert.equal(result.code, 4)
        assert.equal(JSON.parse(result.output).ready, false)
      }
    }
    assert.deepEqual(calls, [])
  } finally { for (const method of methods) adapter[method] = originals[method] }
}))

test('CLI dispatch propagates required policy through driver spawn and recorded-session resume', { skip: process.platform === 'win32' }, async () => fixture(async ({ root, gitRun }) => {
  await writeFile(path.join(root, 'plan.md'), '### Task 1: fixture\n\n**Files:**\n- Create: `fixture.mjs`\n')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\ncodex\n')
  await gitRun(['add', '.'])
  await gitRun(['commit', '-m', 'test: dispatch plan'])
  await gitRun(['checkout', '-b', 'run'])
  assert.equal((await command(root, ['init-run', 'plan.md', '--run', 'r1'])).code, 0)
  await writeFile(path.join(root, 'codex'), '#!/usr/bin/env node\nconsole.log("Logged in")\n')
  await chmod(path.join(root, 'codex'), 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${root}${path.delimiter}${previousPath}`
  const adapter = getAdapter('codex')
  const overrides = {
    probe: async () => ({ ok: true }),
    makeSandbox: async (git, options) => { assert.equal(typeof git, 'function'); assert.equal(options.runBranch, 'run'); return { cwd: root, meta: { mode: 'clone', gitdir: '/fixture/git' } } },
    readResult: async () => null,
    readUsage: async () => null,
  }
  const calls = []
  for (const name of ['spawn', 'resume']) overrides[name] = async args => {
    calls.push([name, args.enforcement])
    return { child: spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { stdio: 'ignore' }), sessionId: Promise.resolve('fixture-session'), flushed: Promise.resolve() }
  }
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, adapter[key]]))
  Object.assign(adapter, overrides)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await command(root, ['dispatch', '--run', 'r1', '--phase', '1', '--base', 'main', '--role-policy', 'policy.json'])
      assert.equal(result.code, 0, result.output)
    }
    assert.deepEqual(calls.map(([name]) => name), ['spawn', 'resume'])
    for (const [, enforcement] of calls) assert.equal(enforcement?.sandbox, 'workspace-write')
  } finally { Object.assign(adapter, originals); process.env.PATH = previousPath }
}))

async function withBoundSession(preexisting, fn) {
  return fixture(async ({ root, gitRun }) => {
    await writeFile(path.join(root, 'recipe.json'), JSON.stringify({ ...recipe, lockfiles: ['lock.json'] }))
    await writeFile(path.join(root, 'lock.json'), '{}')
    await writeFile(path.join(root, 'plan.md'), '### Task 1: fixture\n\n**Files:**\n- Create: `fixture.mjs`\n')
    await writeFile(path.join(root, '.gitignore'), '.fleetmates/\ncodex\nfleetmates.local.json\n')
    await writeFile(path.join(root, 'policy.json'), JSON.stringify({ version: 1, roles: { implementer: { ...policy.roles.implementer, write: false } } }))
    await gitRun(['add', '.'])
    await gitRun(['commit', '-m', 'test: bound session'])
    await gitRun(['checkout', '-b', 'run'])
    assert.equal((await command(root, ['init-run', 'plan.md', '--run', 'r1'])).code, 0)
    await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify({ harnesses: { codex: { sandbox: 'clone' } } }))
    await writeFile(path.join(root, 'codex'), '#!/usr/bin/env node\nconsole.log("Logged in")\n')
    await chmod(path.join(root, 'codex'), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${root}${path.delimiter}${previousPath}`
    const file = path.join(root, '.fleetmates', 'r1', 'sessions', 'T1.json')
    const sandbox = { cwd: root, meta: { mode: 'clone', gitdir: path.join(root, '.git') } }
    if (preexisting) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ taskId: 'T1', sessionId: 'fixture-session', sandbox, state: 'orphaned' }))
    }
    const calls = []
    const adapter = getAdapter('codex')
    const overrides = { probe: async () => ({ ok: true }), makeSandbox: async () => sandbox, readResult: async () => null, readUsage: async () => null }
    for (const method of ['spawn', 'resume']) overrides[method] = async args => {
      calls.push({ method, argv: (method === 'spawn' ? buildSpawnArgv : buildResumeArgv)(args) })
      return { child: spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { stdio: 'ignore' }), sessionId: Promise.resolve('fixture-session'), flushed: Promise.resolve() }
    }
    const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, adapter[key]]))
    Object.assign(adapter, overrides)
    const dispatch = extra => command(root, ['dispatch', '--run', 'r1', '--phase', '1', '--base', 'main', ...extra])
    const message = () => command(root, ['message', '--run', 'r1', '--task', 'T1', '--text', 'continue', '--harness', 'codex'])
    try {
      const result = await dispatch(['--role-policy', 'policy.json'])
      assert.equal(result.code, 0, result.output)
      await fn({ root, gitRun, file, calls, dispatch, message })
    } finally { Object.assign(adapter, originals); process.env.PATH = previousPath }
  })
}

for (const preexisting of [false, true]) {
  test(`required ${preexisting ? 'pre-existing' : 'new'} session persists enforcement through message and flagless dispatch`, { skip: process.platform === 'win32' }, async () => withBoundSession(preexisting, async ({ file, calls, message, dispatch }) => {
    const record = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(record.sandbox.meta.enforcement?.sandbox, 'read-only')
    assert.equal(record.sandbox.meta.prerequisites?.version, 1)
    assert.deepEqual(record.prerequisites, record.sandbox.meta.prerequisites)
    assert.equal((await message()).code, 0)
    assert.equal((await dispatch([])).code, 0)
    assert.equal(calls.length, 3)
    for (const { method, argv } of calls) {
      const flag = method === 'spawn' ? '-s' : '-c'
      const value = method === 'spawn' ? 'read-only' : 'sandbox_mode="read-only"'
      assert.ok(argv.some((arg, index) => arg === flag && argv[index + 1] === value), JSON.stringify(argv))
      assert.ok(!argv.includes('--add-dir'))
      assert.ok(!argv.some(arg => arg.startsWith('sandbox_workspace_write.writable_roots=')))
      assert.ok(argv.some((arg, index) => arg === '-c' && argv[index + 1] === 'sandbox_workspace_write.network_access=false'))
    }
  }))
}

test('required session cannot drop its policy on environment-only redispatch', { skip: process.platform === 'win32' }, async () => withBoundSession(true, async ({ calls, dispatch }) => {
  await dispatch(['--environment', 'recipe.json'])
  assert.equal(calls.length, 1)
}))

test('required flagless redispatch refuses changed committed policy before adapter resume', { skip: process.platform === 'win32' }, async () => withBoundSession(true, async ({ root, calls, dispatch }) => {
  await writeFile(path.join(root, 'policy.json'), '{}')
  await dispatch([])
  assert.equal(calls.length, 1)
}))

const continuationChanges = {
  'missing all sandbox prerequisites': record => { delete record.sandbox.meta.prerequisites; delete record.sandbox.meta.enforcement },
  'missing enforcement': record => { delete record.sandbox.meta.enforcement },
  'unsupported enforcement': record => { record.sandbox.meta.enforcement.kind = 'legacy' },
  'changed enforcement': record => { record.sandbox.meta.enforcement.write = true },
  'missing binding': record => { delete record.sandbox.meta.prerequisites },
  'unsupported binding': record => { record.sandbox.meta.prerequisites.version = 99 },
  'wrong harness': record => { record.sandbox.meta.prerequisites.harness = 'cursor' },
  'unsupported policy source': record => { record.sandbox.meta.prerequisites.rolePolicy = 'recipe.json' },
  'unsupported environment source': record => { record.sandbox.meta.prerequisites.environment = 'policy.json' },
  'missing committed source': record => { record.sandbox.meta.prerequisites.rolePolicy = 'missing.json' },
  'unsafe bound source': record => { record.sandbox.meta.prerequisites.rolePolicy = '../policy.json' },
  'undeclared bound role': record => { record.sandbox.meta.prerequisites.role = 'reviewer' },
  'changed sandbox': record => { record.sandbox.meta.mode = 'full' },
  'changed policy source': async (record, root) => writeFile(path.join(root, 'policy.json'), '{}'),
  'missing policy source': async (record, root) => rm(path.join(root, 'policy.json')),
  'changed lockfile source': async (record, root) => writeFile(path.join(root, 'lock.json'), '{"changed":true}'),
  'missing lockfile source': async (record, root) => rm(path.join(root, 'lock.json')),
  'changed environment source': async (record, root) => writeFile(path.join(root, 'recipe.json'), '{}'),
  'missing environment source': async (record, root) => rm(path.join(root, 'recipe.json')),
  'changed source commit': async (record, root, gitRun) => gitRun(['commit', '--allow-empty', '-m', 'test: changed source commit']),
}
for (const [name, change] of Object.entries(continuationChanges)) {
  test(`required message refuses ${name} before process effects`, { skip: process.platform === 'win32' }, async () => withBoundSession(true, async ({ root, gitRun, file, calls, message }) => {
    const record = JSON.parse(await readFile(file, 'utf8'))
    record.sandbox.meta.prerequisites.environment = 'recipe.json'
    record.prerequisites = record.sandbox.meta.prerequisites
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', detached: process.platform !== 'win32' })
    try {
      record.pid = live.pid
      await change(record, root, gitRun)
      if (!['missing all sandbox prerequisites', 'missing binding'].includes(name)) record.prerequisites = record.sandbox.meta.prerequisites
      await writeFile(file, JSON.stringify(record))
      const result = await message()
      assert.equal(result.code, 4, result.output)
      assert.equal(calls.length, 1)
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(live.signalCode, null)
      assert.equal(live.exitCode, null)
    } finally { if (live.exitCode === null && live.signalCode === null) { live.kill(); await new Promise(resolve => live.once('close', resolve)) } }
  }))
}

async function withReadOnlyReviewer(fn) {
  return fixture(async ({ root, gitRun, git }) => {
    await writeFile(path.join(root, 'plan.md'), '### Task 1: fixture\n\n**Files:**\n- Create: `fixture.mjs`\n')
    await writeFile(path.join(root, '.gitignore'), '.fleetmates/\ncodex\n')
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer', lens: ['correctness'], blockOn: ['high'] }] } } }))
    await writeFile(path.join(root, 'policy.json'), JSON.stringify({ version: 1, roles: { reviewer: { ...policy.roles.implementer, write: false } } }))
    await gitRun(['add', '.'])
    await gitRun(['commit', '-m', 'test: review plan'])
    await gitRun(['checkout', '-b', 'run'])
    assert.equal((await command(root, ['init-run', 'plan.md', '--run', 'r1'])).code, 0)
    await gitRun(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'fixture.mjs'), 'export const fixture = true\n')
    await gitRun(['add', 'fixture.mjs'])
    await gitRun(['commit', '-m', 'test: task change'])
    const taskSha = await git.headSha()
    await gitRun(['checkout', 'run'])
    await writeFile(path.join(root, 'codex'), '#!/usr/bin/env node\nconsole.log("Logged in")\n')
    await chmod(path.join(root, 'codex'), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${root}${path.delimiter}${previousPath}`
    const adapter = getAdapter('codex')
    const originals = { probe: adapter.probe, spawn: adapter.spawn }
    const findings = path.join(root, '.fleetmates', 'r1', 'reviews', 'default-correctness.json')
    const state = { stale: false, noOutput: false, envelope: {}, outputs: [], receipt: null }
    adapter.probe = async () => ({ ok: true })
    adapter.spawn = async args => {
      assert.equal(args.enforcement?.sandbox, 'read-only')
      assert.ok(args.prompt.includes('do not write a findings file or mutate refs'))
      const stamp = JSON.parse(args.prompt.match(/^\s*(\{"phase".*\})$/m)[1])
      assert.ok(stamp.branches.some(value => value.includes(taskSha)))
      state.outputs.push(args.resultPath)
      state.receipt = { stamp: state.stale ? { ...stamp, branches: [] } : stamp, findings: [] }
      const result = { status: 'done', branch: '', filesChanged: [], summary: JSON.stringify(state.receipt), blockers: [], ...state.envelope }
      const script = state.noOutput ? 'setTimeout(() => {}, 50)' : 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])'
      const child = spawn(process.execPath, ['-e', script, args.resultPath, JSON.stringify(result)], { stdio: 'ignore' })
      return { child, sessionId: Promise.resolve('fixture-review'), flushed: Promise.resolve() }
    }
    try {
      const args = ['dispatch-reviews', '--run', 'r1', '--base', 'main', '--role-policy', 'policy.json']
      await fn({ root, state, findings, dispatch: () => command(root, args) })
    } finally { Object.assign(adapter, originals); process.env.PATH = previousPath }
  })
}

const REVIEW_SKIP = process.platform === 'win32'
test('required read-only reviewers return findings for host capture with current stamps', { skip: REVIEW_SKIP }, async () => withReadOnlyReviewer(async ({ root, state, findings, dispatch }) => {
  const sentinel = path.join(root, 'capture-sentinel')
  await writeFile(sentinel, 'preserved\n')
  await mkdir(path.dirname(findings), { recursive: true })
  await symlink(sentinel, findings)
  const result = await dispatch()
  assert.equal(result.code, 0, result.output)
  const captured = await readFile(findings, 'utf8').catch(() => null)
  assert.notEqual(captured, null)
  assert.equal(captured, `${JSON.stringify(state.receipt)}\n`)
  assert.equal(await readFile(sentinel, 'utf8'), 'preserved\n')
  await rm(findings)
  state.stale = true
  assert.equal((await dispatch()).code, 4)
  await assert.rejects(readFile(findings), { code: 'ENOENT' })
}))

test('required review capture refuses old same-stamp output on repeated silent invocations', { skip: REVIEW_SKIP }, async () => withReadOnlyReviewer(async ({ state, findings, dispatch }) => {
  for (let round = 0; round < 2; round++) {
    state.noOutput = false
    assert.equal((await dispatch()).code, 0)
    const previousOutput = state.outputs.at(-1)
    const previousReceipt = await readFile(previousOutput, 'utf8')
    await rm(findings)
    state.noOutput = true
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await dispatch()).code, 4, 'A child without current output must not complete a review')
      await assert.rejects(readFile(findings), { code: 'ENOENT' })
    }
    assert.equal(await readFile(previousOutput, 'utf8'), previousReceipt)
  }
}))

for (const [name, envelope] of [
  ['nonempty blockers', { blockers: ['unable to verify candidate'] }],
  ['nonempty branch', { branch: 'fleetmates/r1/T1' }],
  ['blocked status', { status: 'blocked' }],
  ['failed status', { status: 'failed' }],
  ['changed files', { filesChanged: ['fixture.mjs'] }],
]) {
  test(`required review capture rejects ${name} in a current-stamp envelope`, { skip: REVIEW_SKIP }, async () => withReadOnlyReviewer(async ({ state, findings, dispatch }) => {
    state.envelope = envelope
    assert.equal((await dispatch()).code, 4)
    await assert.rejects(readFile(findings), { code: 'ENOENT' })
  }))
}


const dependencySetup = 'node -e "require(\'fs\').mkdirSync(\'.deps\',{recursive:true});require(\'fs\').writeFileSync(\'.deps/ready\',\'ready\')"'
const dependencyBaseline = 'node -e "process.exit(require(\'fs\').existsSync(\'.deps/ready\')?0:9)"'
const workerModes = [[codexAdapter, 'clone'], [codexAdapter, 'files'], [cursorAdapter, 'files']]
async function withWorker(adapter, mode, change, fn) {
  return fixture(async ({ root, git, gitRun }) => {
    await writeFile(path.join(root, '.gitignore'), '.deps/\n.fleetmates/\n')
    const cache = await mkdtemp(path.join(tmpdir(), 'fm-worker-cache-'))
    if (typeof change === 'function') change = change({ root, cache })
    const workerRecipe = { ...recipe, setup: [{ name: 'deps', run: dependencySetup, timeoutMs: 5000 }], baseline: [{ name: 'deps-ready', run: dependencyBaseline, timeoutMs: 5000 }], ...change }
    if (workerRecipe.dependencies === 'linked') {
      const shared = path.join(cache, 'shared-deps')
      await mkdir(shared)
      await writeFile(path.join(shared, 'ready'), 'ready')
      workerRecipe.setup[0].run = `node -e ${shellQuote(`require('fs').symlinkSync(${JSON.stringify(shared)}, '.deps', 'dir')`)}`
    }
    await writeFile(path.join(root, 'recipe.json'), JSON.stringify(workerRecipe))
    await gitRun(['add', '.'])
    await gitRun(['commit', '-m', 'test: worker environment'])
    const authExec = (command, cwd, options) => ['codex', 'cursor-agent'].includes(command) ? Promise.resolve({ code: 0, output: 'Logged in' }) : defaultExec(command, cwd, options)
    const calls = []
    const wrapped = { ...adapter, spawn: async () => calls.push('spawn'), resume: async () => calls.push('resume') }
    let sandbox
    try {
      const prepared = await cli.prepareDispatchPrerequisites({ root, flags: { environment: 'recipe.json' }, adapter: wrapped, role: 'implementer', sandboxMode: mode, network: false, exec: authExec })
      assert.equal(prepared.code, 0)
      const options = { runRepo: root, runBranch: 'main', runId: 'worker', taskId: 'T1', mode, env: { XDG_CACHE_HOME: cache } }
      const gitExec = (args, opts) => defaultGitExec(args, { cwd: root, ...opts })
      const make = async () => { sandbox = await prepared.adapter.makeSandbox(gitExec, options); return sandbox }
      await fn({ root, git, gitRun, prepared, make, options, gitExec, calls, workerRecipe })
    } finally {
      if (sandbox) await adapter.cleanup({ sandbox })
      await rm(cache, { recursive: true, force: true })
    }
  })
}
for (const [adapter, mode] of workerModes) {
  test(`${adapter.name} ${mode} prepares ignored dependencies in the actual fresh worker`, async () => withWorker(adapter, mode, {}, async ({ root, prepared, make }) => {
    const sandbox = await make()
    assert.equal(prepared.report.environment.baseline.status, 'pass')
    assert.deepEqual(prepared.report.environment.enforcement, { kind: 'legacy', verified: false })
    assert.deepEqual(sandbox.meta.workerEnvironment.enforcement, { kind: 'legacy', verified: false })
    assert.equal((await defaultExec(dependencyBaseline, sandbox.cwd, { timeoutMs: 5000 })).code, 0)
    assert.notEqual(sandbox.cwd, root)
    assert.ok(sandbox.meta.workerEnvironment)
    assert.equal(sandbox.meta.workerEnvironment.ready, true)
    assert.equal(sandbox.meta.workerEnvironment.cwd, sandbox.cwd)
    assert.deepEqual(sandbox.meta.workerEnvironment.sources, prepared.report.environment.sources)
    assert.equal(sandbox.meta.workerEnvironment.dependencies.layout, 'clean-checkout')
    await prepared.adapter.spawn({ sandbox })
    assert.equal(sandbox.meta.workerEnvironment.preparation.setup.status, 'pass')
    assert.deepEqual(sandbox.meta.workerEnvironment.preparation.sources, prepared.report.environment.sources)
  }))
  for (const stage of ['setup', 'baseline']) {
    test(`${adapter.name} ${mode} refuses a failed actual worker ${stage} before model effects`, async () => withWorker(adapter, mode, { [stage]: [{ name: stage, run: (stage === 'setup' ? dependencySetup + ' && ' : '') + 'node -e "process.exit(require(\'fs\').existsSync(\'.git\')?0:9)"', timeoutMs: 5000 }] }, async ({ make, calls }) => {
      await assert.rejects(make(), /worker environment/i)
      assert.deepEqual(calls, [])
    }))
  }
}
for (const [adapter, mode] of workerModes) {
test(`${adapter.name} ${mode} worker resume independently checks dependencies without repeating setup or overwriting task work`, async () => withWorker(adapter, mode, {}, async ({ prepared, make, calls }) => {
  const sandbox = await make()
  await mkdir(path.join(sandbox.cwd, '.deps'), { recursive: true })
  await writeFile(path.join(sandbox.cwd, '.deps', 'ready'), 'task edit')
  await prepared.adapter.resume({ sandbox })
  assert.equal(await readFile(path.join(sandbox.cwd, '.deps', 'ready'), 'utf8'), 'task edit')
  await rm(path.join(sandbox.cwd, '.deps', 'ready'))
  await assert.rejects(prepared.adapter.resume({ sandbox }), /worker environment/i)
  assert.deepEqual(calls, ['resume'])
}))
}
test('worker contract substitution refuses setup and model effects before running changed content', async () => withWorker(codexAdapter, 'files', {}, async ({ prepared, make, calls }) => {
  const sandbox = await make()
  await writeFile(path.join(sandbox.cwd, 'recipe.json'), '{}')
  await rm(path.join(sandbox.cwd, '.deps', 'ready'), { force: true })
  await assert.rejects(prepared.adapter.resume({ sandbox }), /changed/i)
  assert.deepEqual(calls, [])
  await assert.rejects(readFile(path.join(sandbox.cwd, '.deps', 'ready')))
}))
test('linked worker receipt retains its reproducibility limitation', { skip: process.platform === 'win32' }, async () => withWorker(codexAdapter, 'files', { dependencies: 'linked' }, async ({ prepared, make }) => {
  const sandbox = await make()
  assert.equal((await lstat(path.join(sandbox.cwd, '.deps'))).isSymbolicLink(), true)
  assert.equal(sandbox.meta.workerEnvironment?.dependencies.layout, 'linked')
  assert.equal(sandbox.meta.workerEnvironment.dependencies.reproducible, false)
  assert.ok(sandbox.meta.workerEnvironment.dependencies.limitations.length)
  await prepared.adapter.resume({ sandbox })
  assert.equal(sandbox.meta.workerEnvironment.dependencies.reproducible, false)
}))


for (const [adapter, mode] of workerModes) {
test(`${adapter.name} ${mode} pre-existing worker resume verifies its own dependencies without rerunning setup`, async () => withWorker(adapter, mode, {}, async ({ prepared, options, gitExec, calls }) => {
  const sandbox = await adapter.makeSandbox(gitExec, options)
  try {
    await mkdir(path.join(sandbox.cwd, '.deps'))
    await writeFile(path.join(sandbox.cwd, '.deps', 'ready'), 'existing task work')
    await prepared.adapter.resume({ sandbox })
    assert.equal(await readFile(path.join(sandbox.cwd, '.deps', 'ready'), 'utf8'), 'existing task work')
    assert.equal(sandbox.meta.workerEnvironment.workspace, 'existing')
    assert.equal(sandbox.meta.workerEnvironment.setup.status, 'not-rerun')
    assert.equal(sandbox.meta.workerEnvironment.dependencies.reproducible, false)
    assert.deepEqual(sandbox.meta.workerEnvironment.sources, prepared.report.environment.sources)
    await rm(path.join(sandbox.cwd, '.deps', 'ready'))
    await assert.rejects(prepared.adapter.resume({ sandbox }), /worker environment/i)
    assert.deepEqual(calls, ['resume'])
  } finally { await adapter.cleanup({ sandbox }) }
}))

}
test('CLI message persists actual worker receipts and refuses a broken worker baseline', async () => withWorker(codexAdapter, 'clone', {}, async ({ root, make }) => {
  const sandbox = await make()
  const file = path.join(root, '.fleetmates', 'worker', 'sessions', 'T1.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ taskId: 'T1', sessionId: 'fixture', sandbox, prerequisites: sandbox.meta.prerequisites }))
  await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify({ harnesses: { codex: { sandbox: 'clone' } } }))
  const adapter = getAdapter('codex')
  const original = adapter.resume
  const calls = []
  adapter.resume = async args => {
    calls.push(buildResumeArgv(args))
    return { child: spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { stdio: 'ignore' }), sessionId: Promise.resolve('fixture'), flushed: Promise.resolve() }
  }
  const message = () => command(root, ['message', '--run', 'worker', '--task', 'T1', '--text', 'continue', '--harness', 'codex'])
  try {
    await writeFile(path.join(sandbox.cwd, '.deps', 'ready'), 'task edit')
    assert.equal((await message()).code, 0)
    const stored = JSON.parse(await readFile(file, 'utf8')).sandbox.meta.workerEnvironment
    assert.equal(stored.cwd, sandbox.cwd)
    assert.equal(stored.baseline.status, 'pass')
    assert.equal(stored.setup.status, 'not-rerun')
    assert.equal(await readFile(path.join(sandbox.cwd, '.deps', 'ready'), 'utf8'), 'task edit')
    await rm(path.join(sandbox.cwd, '.deps', 'ready'))
    assert.equal((await message()).code, 4)
    assert.equal(calls.length, 1)
    const failed = JSON.parse(await readFile(file, 'utf8')).sandbox.meta.workerEnvironment
    assert.equal(failed.ready, false)
    assert.equal(failed.baseline.status, 'fail')
  } finally { adapter.resume = original }
}))

test('existing worker toolchain is observed again before resume', async () => withWorker(codexAdapter, 'files', { toolchains: [{ name: 'fixture', command: 'node', argv: ['-e', "console.log(require('fs').existsSync('.deps/bad-version')?'v2':'v1')"], expected: 'v1' }] }, async ({ prepared, make, calls }) => {
  const sandbox = await make()
  await writeFile(path.join(sandbox.cwd, '.deps', 'bad-version'), 'changed')
  await assert.rejects(prepared.adapter.resume({ sandbox }), /worker environment/i)
  assert.deepEqual(calls, [])
  assert.equal(sandbox.meta.workerEnvironment.toolchains[0].state, 'unavailable')
  assert.equal(sandbox.meta.workerEnvironment.baseline.status, 'blocked')
}))

test('fresh worker source substitution is refused before setup execution', async () => {
  const adapter = { ...codexAdapter, makeSandbox: async (...args) => {
    const sandbox = await codexAdapter.makeSandbox(...args)
    await writeFile(path.join(sandbox.cwd, 'recipe.json'), '{}')
    return sandbox
  } }
  await withWorker(adapter, 'clone', {}, async ({ root, make, calls }) => {
    await assert.rejects(make(), /changed/i)
    assert.deepEqual(calls, [])
    await assert.rejects(readFile(path.join(root, '.fleetmates', 'worker', 'clones', 'T1', '.deps', 'ready')))
  })
})


for (const [adapter, mode] of workerModes) {
  test(`${adapter.name} ${mode} environment preparation refuses to recreate an existing task workspace`, async () => withWorker(adapter, mode, {}, async ({ prepared, options, gitExec }) => {
    const sandbox = await adapter.makeSandbox(gitExec, options)
    try {
      await mkdir(path.join(sandbox.cwd, '.deps'))
      await writeFile(path.join(sandbox.cwd, '.deps', 'ready'), 'task work')
      await assert.rejects(prepared.adapter.makeSandbox(gitExec, options))
      assert.equal(await readFile(path.join(sandbox.cwd, '.deps', 'ready'), 'utf8'), 'task work')
    } finally { await adapter.cleanup({ sandbox }) }
  }))
}


test('worker receipt observes linked dependencies even when the recipe declares clean checkout', { skip: process.platform === 'win32' }, async () => withWorker(codexAdapter, 'files', ({ cache }) => ({ setup: [{ name: 'linked-deps', timeoutMs: 5000,
  run: `node -e ${shellQuote(`const fs=require('fs');fs.mkdirSync(${JSON.stringify(cache + '/external')},{recursive:true});fs.writeFileSync(${JSON.stringify(cache + '/external/ready')},'ready');fs.symlinkSync(${JSON.stringify(cache + '/external')},'.deps','dir')`)}` }] }), async ({ make }) => {
  const sandbox = await make()
  assert.equal((await lstat(path.join(sandbox.cwd, '.deps'))).isSymbolicLink(), true)
  assert.equal(sandbox.meta.workerEnvironment.dependencies.layout, 'linked')
  assert.equal(sandbox.meta.workerEnvironment.dependencies.declaredLayout, 'clean-checkout')
  assert.equal(sandbox.meta.workerEnvironment.dependencies.reproducible, false)
  assert.ok(sandbox.meta.workerEnvironment.dependencies.limitations.length)
}))


test('worker link inspection has a finite bound and reports an unverified layout', async () => withWorker(codexAdapter, 'files', { setup: [{ name: 'many-deps', timeoutMs: 5000,
  run: dependencySetup + ' && node -e "const fs=require(\'fs\');for(let i=0;i<4100;i++)fs.writeFileSync(\'.deps/entry-\'+i,\'fixture\')"' }] }, async ({ make }) => {
  const sandbox = await make()
  assert.equal(sandbox.meta.workerEnvironment.dependencies.layout, 'unverified')
  assert.equal(sandbox.meta.workerEnvironment.dependencies.reproducible, false)
  assert.ok(sandbox.meta.workerEnvironment.dependencies.limitations.length)
  assert.equal(sandbox.meta.workerEnvironment.baseline.status, 'pass')
}))

for (const mode of ['files', 'clone']) test(`required ${mode} worker verification refuses unsupported runtime or confines a changed dummy script`, async () => fixture(async ({ root, gitRun }) => {
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n.deps/\n')
  await writeFile(path.join(root, 'baseline.mjs'), `import fs from 'node:fs';process.exit(fs.existsSync('.deps/ready') ? 0 : 9)\n`)
  await writeFile(path.join(root, 'recipe.json'), JSON.stringify({ ...recipe, setup: [{ name: 'deps', run: dependencySetup, timeoutMs: 5000 }], toolchains: [{ name: 'node', command: process.execPath, argv: ['--version'], expected: process.version }], baseline: [{ name: 'dummy', run: 'node baseline.mjs', timeoutMs: 5000 }] }))
  await gitRun(['add', '.']); await gitRun(['commit', '-m', 'test: confined verification'])
  const calls = []
  const prepared = await cli.prepareDispatchPrerequisites({ root, flags: { environment: 'recipe.json', 'role-policy': 'policy.json' }, adapter: { ...codexAdapter, resume: async () => calls.push('resume') }, role: 'implementer', sandboxMode: mode, network: false,
    exec: (command, cwd, options) => command === 'codex' ? Promise.resolve({ code: 0, output: 'Logged in' }) : defaultExec(command, cwd, options) })
  const outside = path.join(root, 'outside-marker')
  if (prepared.code !== 0) {
    assert.equal(prepared.code, 4)
    assert.equal(prepared.report.ready, false)
  } else {
    const sandbox = await prepared.adapter.makeSandbox((args, opts) => defaultGitExec(args, { cwd: root, ...opts }), { runRepo: root, runBranch: 'main', runId: 'confined', taskId: 'T1', mode })
    await mkdir(path.join(sandbox.cwd, '.codex'))
    await writeFile(path.join(sandbox.cwd, '.codex/config.toml'), 'sandbox_mode="danger-full-access"\n')
    await writeFile(path.join(sandbox.cwd, 'baseline.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(outside)}, 'dummy');\n`)
    await assert.rejects(prepared.adapter.resume({ sandbox }), /worker environment|verification/i)
    assert.equal(sandbox.meta.workerEnvironment.enforcement.observed, true)
    assert.equal(sandbox.meta.workerEnvironment.toolchains[0].state, 'available')
    assert.equal(await readFile(path.join(sandbox.cwd, '.deps/ready'), 'utf8'), 'ready')
  }
  await assert.rejects(readFile(outside), { code: 'ENOENT' })
  assert.deepEqual(calls, [])
}))

test('linked setup reaches layout assertions under apostrophe TMPDIR', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "fm-quote'"))
  try {
    const result = await defaultExec('/usr/bin/env', process.cwd(), { argv: ['-u', 'NODE_TEST_CONTEXT', process.execPath, '--test', '--test-name-pattern=linked worker receipt|worker receipt observes linked', path.join(process.cwd(), 'tests/execution-prerequisites.test.mjs')], env: { TMPDIR: temp, NODE_TEST_CONTEXT: '' }, timeoutMs: 30000, maxOutputBytes: 64 * 1024 })
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /pass 2/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})


test('flagless Cursor redispatch preserves a completed contribution after disposable checkout cleanup', async () => fixture(async ({ root, gitRun }) => {
  await writeFile(path.join(root, 'plan.md'), '### Task 1: fixture\n\n**Files:**\n- Create: `fixture.mjs`\n')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\nfleetmates.local.json\n')
  await gitRun(['add', '.']); await gitRun(['commit', '-m', 'test: completed contribution'])
  await gitRun(['checkout', '-b', 'run'])
  assert.equal((await command(root, ['init-run', 'plan.md', '--run', 'r1'])).code, 0)
  await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify({ harnesses: { cursor: { sandbox: 'files' } } }))
  const cache = await mkdtemp(path.join(tmpdir(), 'fm-completed-'))
  const adapter = getAdapter('cursor'), originals = { probe: adapter.probe, spawn: adapter.spawn, resume: adapter.resume }
  let effects = 0
  Object.assign(adapter, { probe: async () => ({ ok: true }), spawn: async () => { effects++; throw new Error('unexpected model spawn') }, resume: async () => { effects++; throw new Error('unexpected model resume') } })
  try {
    const prepared = await cli.prepareDispatchPrerequisites({ root, flags: { environment: 'recipe.json' }, adapter, role: 'implementer', sandboxMode: 'files', network: false, exec: async (cmd, cwd, opts) => cmd === 'cursor-agent' ? { code: 0, output: 'Logged in' } : defaultExec(cmd, cwd, opts) })
    assert.equal(prepared.code, 0)
    const git = (args, opts) => defaultGitExec(args, { cwd: root, ...opts })
    const sandbox = await prepared.adapter.makeSandbox(git, { runRepo: root, runBranch: 'run', runId: 'r1', taskId: 'T1', mode: 'files', env: { XDG_CACHE_HOME: cache } })
    await writeFile(path.join(sandbox.cwd, 'fixture.mjs'), 'export const fixture = true\n')
    const branch = 'fleetmates/r1/T1'
    await prepared.adapter.collect(git, { runRepo: root, sandbox, branch })
    const contribution = (await gitRun(['rev-parse', branch])).stdout.trim()
    await adapter.cleanup({ sandbox })
    const file = path.join(root, '.fleetmates/r1/sessions/T1.json')
    await mkdir(path.dirname(file), { recursive: true })
    const record = { taskId: 'T1', state: 'done', sandboxRemoved: true, sandbox, prerequisites: sandbox.meta.prerequisites,
      result: { status: 'done', branch, filesChanged: ['fixture.mjs'], summary: 'fixture', blockers: [] } }
    await writeFile(file, JSON.stringify(record))
    const statusFile = path.join(root, '.fleetmates/r1/status.json')
    const completedStatus = JSON.parse(await readFile(statusFile, 'utf8'))
    completedStatus.tasks[0].state = 'done'
    await writeFile(statusFile, JSON.stringify(completedStatus, null, 2) + '\n')
    const before = await readFile(statusFile, 'utf8')
    for (let i = 0; i < 2; i++) {
      const dispatched = await command(root, ['dispatch', '--run', 'r1', '--phase', '1', '--base', 'main', '--harness', 'cursor'])
      assert.equal(dispatched.code, 0, dispatched.output)
    }
    assert.equal(effects, 0)
    assert.equal((await gitRun(['rev-parse', branch])).stdout.trim(), contribution)
    assert.equal(await readFile(path.join(root, '.fleetmates/r1/status.json'), 'utf8'), before)
    await assert.rejects(lstat(sandbox.cwd), { code: 'ENOENT' })
    for (const change of [
      value => { value.result.blockers = ['unable to verify'] },
      value => { value.result.branch = 'run' },
      value => { value.result.filesChanged = [7] },
      value => { value.state = 'orphaned' },
    ]) {
      const invalid = structuredClone(record)
      change(invalid)
      await writeFile(file, JSON.stringify(invalid))
      assert.equal((await command(root, ['dispatch', '--run', 'r1', '--phase', '1', '--base', 'main', '--harness', 'cursor'])).code, 4)
      assert.equal(effects, 0)
    }
  } finally { Object.assign(adapter, originals); await rm(cache, { recursive: true, force: true }) }
}))

test('required host preflight confines project setup before authentication or model effects', async () => fixture(async ({ root, gitRun }) => {
  const outside = path.join(path.dirname(root), path.basename(root) + '-dummy-outside')
  await writeFile(path.join(root, 'setup.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(outside)},'dummy');\n`)
  await writeFile(path.join(root, 'recipe.json'), JSON.stringify({ ...recipe, setup: [{ name: 'dummy', run: 'node setup.mjs', timeoutMs: 5000 }] }))
  await gitRun(['add', '.']); await gitRun(['commit', '-m', 'test: confined host setup'])
  let authentication = 0
  try {
    const prepared = await cli.prepareDispatchPrerequisites({ root, flags: { environment: 'recipe.json', 'role-policy': 'policy.json' }, adapter: codexAdapter, role: 'implementer', sandboxMode: 'files', network: false,
      exec: async (command, cwd, options) => { if (command === 'codex') { authentication++; return { code: 0, output: 'Logged in' } } return defaultExec(command, cwd, options) } })
    assert.equal(prepared.code, 4)
    assert.equal(prepared.report.environment.ready, false)
    assert.equal(prepared.report.environment.enforcement.kind, 'required')
    assert.equal(authentication, 0)
    await assert.rejects(readFile(outside), { code: 'ENOENT' })
  } finally { await rm(outside, { force: true }) }
}))

for (const missing of [false, true]) {
  test(`required message refuses ${missing ? 'missing' : 'unavailable'} native verifier without retaining an old ready receipt`, async () => withBoundSession(true, async ({ file, calls, message }) => {
    const record = JSON.parse(await readFile(file, 'utf8'))
    record.sandbox.meta.prerequisites.environment = 'recipe.json'
    record.prerequisites = record.sandbox.meta.prerequisites
    record.sandbox.meta.workerEnvironment = { ready: true, identity: 'old-receipt' }
    await writeFile(file, JSON.stringify(record))
    const adapter = getAdapter('codex'), original = adapter.createVerificationExecutor
    let attempts = 0
    adapter.createVerificationExecutor = async () => {
      attempts++
      if (missing) return undefined
      throw new Error('Required native verification runtime is unavailable')
    }
    try {
      const result = await message()
      assert.equal(result.code, 4, result.output)
      assert.equal(attempts, 1)
      assert.equal(calls.length, 1)
      const updated = JSON.parse(await readFile(file, 'utf8')).sandbox.meta.workerEnvironment
      assert.equal(updated.ready, false)
      assert.notEqual(updated.identity, 'old-receipt')
      assert.equal(updated.baseline.status, 'not-executed')
      assert.deepEqual(updated.enforcement, { kind: 'required', verified: false })
    } finally { adapter.createVerificationExecutor = original }
  }))
}
