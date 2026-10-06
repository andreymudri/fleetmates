import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, chmod } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from '../scripts/cli.mjs'
import * as cli from '../scripts/cli.mjs'
import { getAdapter } from '../scripts/harnesses/index.mjs'
import { defaultExec } from '../scripts/gate-runner.mjs'
import { createGit, defaultGitExec } from '../scripts/git.mjs'

const recipe = { version: 1, toolchains: [], lockfiles: [], setup: [], baseline: [{ name: 'baseline', run: 'node -e "process.exit(0)"', timeoutMs: 5000 }], required: [], dependencies: 'clean-checkout' }
const policy = { version: 1, roles: { implementer: { read: true, write: true, execute: true, network: false, sharedRefs: false, publication: false } } }
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
