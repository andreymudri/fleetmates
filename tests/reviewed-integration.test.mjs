import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod, cp, access, realpath, symlink, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { executeReviewedPhaseGate as executeActualGate, integrateReviewedPhase as integrateActualPhase,
  executeReviewedPhaseGateFixture, integrateReviewedPhaseFixture as integrateReviewedPhase,
  boundedIntegrationGit } from '../scripts/reviewed-integration.mjs'
import { defaultExec } from '../scripts/gate-runner.mjs'
import { createVerificationExecutor } from '../scripts/harnesses/codex.mjs'
import { resolveRoleCapabilities } from '../scripts/role-capabilities.mjs'

function fixtureShell(command, platform = process.platform) {
  if (platform !== 'win32' || !command.startsWith('export FLEETMATES_REPORT_DIR=')) return command
  const end = command.indexOf(';\n')
  const value = command.slice('export FLEETMATES_REPORT_DIR='.length, end).slice(1, -1).replaceAll("'\\''", "'")
  return `set "FLEETMATES_REPORT_DIR=${value}" && ${command.slice(end + 2)}`
}
const fixtureExec = (command, cwd, options) => defaultExec(fixtureShell(command), cwd, options)
const injectedExecutor = async () => ({ exec: fixtureExec, close: async () => {} })
const executeReviewedPhaseGate = input => executeReviewedPhaseGateFixture(input, injectedExecutor)

async function runtimeOnPath({ env = process.env, root = process.cwd() }) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue
    const outside = file => { const rel = path.relative(root, file); return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) }
    if (!outside(dir)) continue
    try {
      const executable = await realpath(path.join(dir, 'codex'))
      await access(executable, constants.X_OK)
      if (outside(executable)) return true
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error
    }
  }
  return false
}

async function knownNativeUnavailable(options = {}, inspect = runtimeOnPath) {
  if ((options.platform ?? process.platform) !== 'linux') return 'Required non-model verification platform is unsupported'
  if (!await inspect(options)) return 'Required native verification runtime is unavailable'
  return null
}

async function nativeAvailable(t, input) {
  const reason = await knownNativeUnavailable({ root: input.root })
  if (!reason) return true
  await assert.rejects(executeActualGate({ ...input, baseBranch: 'main', planPath: 'plan.md' }), error => {
    assert.match(error.message, /gate rejected/)
    assert.equal(error.results.find(result => result.kind === 'command').output, `check threw: ${reason}`)
    assert.equal(error.verification.observedNative, false)
    assert.equal(error.verification.observed, null)
    return true
  })
  assert.equal(git(input.root, 'rev-parse', input.branch), input.expectedRunTip)
  t.diagnostic(`Required native authority unavailable before execution: ${reason}; no native success observed`)
  return false
}

async function observeFixtureCreation(create, unavailableCodes) {
  try {
    await create()
    return { available: true }
  } catch (error) {
    if (!unavailableCodes.includes(error.code)) throw error
    return { available: false, reason: error.code }
  }
}

async function probeReportFixture(kind, { platform = process.platform, env = process.env,
  fifoCreate = (file, env) => execFileSync('mkfifo', [file], { env, stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  if (platform === 'win32' && kind !== 'link') return { available: false, reason: 'unsupported-platform' }
  const root = await mkdtemp(path.join(tmpdir(), 'ri-probe-'))
  const file = path.join(root, 'entry')
  try {
    const target = path.join(root, 'target')
    if (kind === 'link') await writeFile(target, 'dummy')
    const capability = await observeFixtureCreation(async () => {
      if (kind === 'link') {
        await symlink(target, file, 'file')
      } else if (kind === 'special') {
        await fifoCreate(file, env)
      } else {
        // Relative to its directory: a long TMPDIR exceeds the ~108-byte Unix socket path limit.
        execFileSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path.basename(file))},()=>process.exit(0))`], { cwd: path.dirname(file), env, stdio: ['ignore', 'pipe', 'pipe'] })
      }
    }, kind === 'link' ? ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'] : kind === 'special' ? ['ENOENT'] : [])
    if (!capability.available) return capability
    const info = await lstat(file)
    assert.equal(kind === 'link' ? info.isSymbolicLink() : kind === 'special' ? info.isFIFO() : info.isSocket(), true)
    return capability
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('native availability classifies only missing runtime or unsupported platform before execution', async () => {
  for (const platform of ['darwin', 'win32']) {
    assert.equal(await knownNativeUnavailable({ platform }, async () => assert.fail('unsupported platform must not inspect runtime')), 'Required non-model verification platform is unsupported')
  }
  assert.equal(await knownNativeUnavailable({ platform: 'linux' }, async () => false), 'Required native verification runtime is unavailable')
  assert.equal(await knownNativeUnavailable({ platform: 'linux' }, async () => true), null)
  await assert.rejects(knownNativeUnavailable({ platform: 'linux' }, async () => { throw new Error('arbitrary restriction failure') }), /arbitrary restriction failure/)
})

test('injected unavailable platform and empty PATH refuse required native authority without execution', async t => {
  const { root } = await fixture(t)
  const enforcement = resolveRoleCapabilities({ policy: { version: 1, roles: { implementer: {
    read: true, write: true, execute: true, network: false, sharedRefs: false, publication: false
  } } }, role: 'implementer', harness: 'codex', sandboxMode: 'clone', network: false }).enforcement
  const options = { root, sandbox: { cwd: root, meta: { mode: 'clone', gitdir: path.join(root, '.git'), enforcement } }, enforcement,
    run: async () => assert.fail('unavailable authority must not execute') }
  for (const platform of ['darwin', 'win32']) {
    await assert.rejects(createVerificationExecutor({ ...options, platform }), { message: 'Required non-model verification platform is unsupported' })
  }
  assert.equal(await knownNativeUnavailable({ root, platform: 'linux', env: { PATH: '' } }), 'Required native verification runtime is unavailable')
  await assert.rejects(createVerificationExecutor({ ...options, platform: 'linux', env: { PATH: '' } }), { message: 'Required native verification runtime is unavailable' })
  t.diagnostic('Injected platform/environment observations; no macOS or Windows native execution validated')
})

test('fixture shell binding adapts the private report environment for injected Windows commands', () => {
  const command = "export FLEETMATES_REPORT_DIR='C:/fixture reports';\nnode -e 0"
  assert.equal(fixtureShell(command, 'win32'), 'set "FLEETMATES_REPORT_DIR=C:/fixture reports" && node -e 0')
  assert.equal(fixtureShell(command, 'linux'), command)
  assert.equal(fixtureShell('node -e 0', 'win32'), 'node -e 0')
  assert.equal(fixtureShell("export FLEETMATES_REPORT_DIR='/fixture/it'\\''s';\nnode -e 0", 'win32'), 'set "FLEETMATES_REPORT_DIR=/fixture/it\'s" && node -e 0')
})

test('native test branch matches independently classified availability', async t => {
  const { input } = await fixture(t)
  const reason = await knownNativeUnavailable({ root: input.root })
  assert.equal(await nativeAvailable(t, input), reason === null)
})

test('fixture creation classifies known absence without swallowing arbitrary errors', async () => {
  assert.deepEqual(await observeFixtureCreation(async () => {}, ['EPERM']), { available: true })
  let unavailable
  await assert.doesNotReject(async () => { unavailable = await observeFixtureCreation(async () => { throw Object.assign(new Error('permission fixture'), { code: 'EPERM' }) }, ['EPERM']) })
  assert.deepEqual(unavailable, { available: false, reason: 'EPERM' })
  await assert.rejects(observeFixtureCreation(async () => { throw Object.assign(new Error('unexpected fixture failure'), { code: 'EIO' }) }, ['EPERM']), { code: 'EIO' })
})

test('empty tool PATH reports FIFO fixture absence while unsupported platform probes do not execute', async () => {
  let result
  await assert.doesNotReject(async () => { result = await probeReportFixture('special', { platform: 'linux', env: { ...process.env, PATH: '' } }) })
  assert.deepEqual(result, { available: false, reason: 'ENOENT' })
  for (const kind of ['special', 'socket']) {
    assert.deepEqual(await probeReportFixture(kind, { platform: 'win32' }), { available: false, reason: 'unsupported-platform' })
  }
})

test('an injected successful FIFO creator with missing output is an error, not unavailable authority', async () => {
  await assert.rejects(probeReportFixture('special', { platform: 'linux', fifoCreate: async () => {} }), { code: 'ENOENT' })
})

const policy = { version: 1, roles: { integrator: { read: true, write: true, execute: true,
  sharedRefs: true, network: false, publication: false } } }
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const nodeCommand = program => `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(program).toString('base64')}','base64').toString())"`
async function fixture(t, { review = false, command = nodeCommand('const fs=require("fs");if(!fs.existsSync("a.txt")||!fs.existsSync("b.txt"))process.exit(1)'), files = ['a.txt', 'b.txt'], report } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ri-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  if (typeof command === 'function') command = command(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Example')
  git(root, 'config', 'user.email', 'example@example.invalid')
  await writeFile(path.join(root, 'plan.md'), files.map((file, i) => `### Task ${i + 1}: task\n\n**Files:**\n- Create: \`${file}\`\n`).join('\n'))
  const checks = [{ name: 'behavior', kind: 'command', run: command }]
  if (report) checks[0].report = report
  if (review) checks.push({ name: 'review', kind: 'agent', agent: 'tm-reviewer' })
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks } } }))
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'test: anchor')
  const anchor = git(root, 'rev-parse', 'HEAD')
  git(root, 'branch', 'fleetmates/run/r1', anchor)
  const taskTips = {}
  for (const [id, file] of [['T1', files[0]], ['T2', files[1]]]) {
    git(root, 'checkout', '-b', `fleetmates/r1/${id}`, anchor)
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), id)
    git(root, 'add', file)
    git(root, 'commit', '-m', `test: ${id}`)
    taskTips[id] = git(root, 'rev-parse', 'HEAD')
  }
  git(root, 'checkout', 'main')
  const input = { root, runId: 'r1', phase: 1, branch: 'fleetmates/run/r1', expectedRunTip: anchor,
    taskTips, policy }
  const gate = overrides => executeReviewedPhaseGate({ ...input, baseBranch: 'main', planPath: 'plan.md', ...overrides })
  return { root, anchor, input, gate }
}

async function outsideCheckout(t, root) {
  const outside = await mkdtemp(path.join(tmpdir(), 'ri-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  for (const file of ['plan.md', 'fleetmates.gate.json']) await writeFile(path.join(outside, file), await readFile(path.join(root, file)))
  return outside
}

test('actual native receipt refuses core.worktree redirection before checkout or merge', async t => {
  const { root, input } = await fixture(t)
  if (!await nativeAvailable(t, input)) return
  const gateReceipt = await executeActualGate({ ...input, baseBranch: 'main', planPath: 'plan.md' })
  assert.equal(gateReceipt.verification.observedNative, true)
  const outside = await outsideCheckout(t, root)
  git(root, 'config', 'core.worktree', outside)
  let failure, result, operations = 0
  try {
    result = await integrateActualPhase({ ...input, gateReceipt, git: async (args, cwd, env) => {
      if (args.includes('checkout') || args.includes('merge')) operations++
      return boundedIntegrationGit(args, cwd, env)
    } })
  } catch (error) { failure = error }
  t.diagnostic(JSON.stringify({ kind: 'actual-native-gate-and-Git-root-redirection', observedNative: true,
    integratedComplete: result?.complete ?? false, checkoutOrMergeOperations: operations,
    outsideTaskPresent: await access(path.join(outside, 'a.txt')).then(() => true, () => false),
    suppliedRootTaskPresent: await access(path.join(root, 'a.txt')).then(() => true, () => false) }))
  assert.ok(failure, 'redirected worktree must be refused')
  assert.match(failure.message, /worktree|configuration/)
  assert.equal(failure.receipt.complete, false)
  assert.equal(failure.receipt.merges.length, 0)
  assert.equal(operations, 0)
  assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
  for (const dir of [root, outside]) for (const file of ['a.txt', 'b.txt']) await assert.rejects(readFile(path.join(dir, file)), { code: 'ENOENT' })
})

test('an already redirected core.worktree and a supplied subdirectory cannot authorize a gate', async t => {
  for (const kind of ['redirect', 'subdirectory']) await t.test(kind, async t => {
    const { root, input } = await fixture(t)
    if (kind === 'redirect') git(root, 'config', 'core.worktree', await outsideCheckout(t, root))
    else { input.root = path.join(root, 'subdirectory'); await mkdir(input.root) }
    let mutations = 0
    await assert.rejects(executeReviewedPhaseGate({ ...input, baseBranch: 'main', planPath: 'plan.md', git: async (args, cwd, env) => {
      if (args.includes('merge') || args.includes('checkout') || (args.includes('worktree') && args.includes('add'))) mutations++
      return boundedIntegrationGit(args, cwd, env)
    } }), /worktree|configuration/)
    assert.equal(mutations, 0)
    assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
  })
})

test('failed or malformed Git worktree observations cannot authorize project verification', async t => {
  for (const kind of ['root-exit', 'root-signal', 'root-missing', 'dirs-exit', 'dirs-signal', 'dirs-shape', 'config-exit', 'config-signal']) await t.test(kind, async t => {
    const { root, input } = await fixture(t)
    let projects = 0, mutations = 0
    await assert.rejects(executeReviewedPhaseGateFixture({ ...input, baseBranch: 'main', planPath: 'plan.md', git: async (args, cwd, env) => {
      if (args.includes('merge') || args.includes('checkout') || (args.includes('worktree') && args.includes('add'))) mutations++
      const result = await boundedIntegrationGit(args, cwd, env)
      const observation = args.includes('--show-toplevel') ? 'root' : args.includes('--absolute-git-dir') ? 'dirs'
        : args.includes('--get-all') && args.includes('core.worktree') ? 'config' : null
      if (kind.startsWith(`${observation}-`)) {
        if (kind.endsWith('-exit')) return { ...result, code: 2 }
        if (kind.endsWith('-signal')) return { ...result, signal: 'SIGTERM' }
        if (kind === 'root-missing') return { ...result, stdout: path.join(root, 'missing') + '\n' }
        if (kind === 'dirs-shape') return { ...result, stdout: result.stdout + root + '\n' }
      }
      return result
    } }, async () => { projects++; return injectedExecutor() }), /worktree/)
    assert.equal(projects, 0)
    assert.equal(mutations, 0)
  })
})

test('core.worktree identity changes after a gate fail even when its effective root is unchanged', async t => {
  const { root, input, gate } = await fixture(t)
  const gateReceipt = await gate()
  git(root, 'config', 'core.worktree', root)
  let mutations = 0
  await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt, git: async (args, cwd, env) => {
    if (args.includes('merge') || args.includes('checkout')) mutations++
    return boundedIntegrationGit(args, cwd, env)
  } }), /identity|worktree|configuration/)
  assert.equal(mutations, 0)
  assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
})

test('worktree configuration is rechecked between checkout and each merge', async t => {
  const { root, input, gate } = await fixture(t)
  const gateReceipt = await gate()
  let merges = 0
  await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt, git: async (args, cwd, env) => {
    const result = await boundedIntegrationGit(args, cwd, env)
    if (args.includes('checkout')) git(root, 'config', 'core.worktree', root)
    if (args.includes('merge')) merges++
    return result
  } }), error => {
    assert.match(error.message, /worktree|configuration|identity/)
    assert.equal(error.receipt.merges.length, 0)
    return true
  })
  assert.equal(merges, 0)
  assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
})

test('pinned Git writes stay in the authorized root and retain partial progress after a host-seam config change', async t => {
  const { root, input, gate } = await fixture(t)
  const gateReceipt = await gate()
  const outside = await outsideCheckout(t, root)
  let merges = 0, failure
  await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt, git: async (args, cwd, env) => {
    if (args.includes('merge') && ++merges === 1) git(root, 'config', 'core.worktree', outside)
    return boundedIntegrationGit(args, cwd, env)
  } }), error => { failure = error; return true })
  assert.match(failure.message, /worktree|configuration/)
  assert.equal(failure.receipt.complete, false)
  assert.equal(failure.receipt.state, 'partial')
  assert.equal(failure.receipt.merges.length, 1)
  assert.equal(merges, 1)
  assert.equal(failure.receipt.after, git(root, 'rev-parse', input.branch))
  for (const file of ['a.txt', 'b.txt']) await assert.rejects(readFile(path.join(outside, file)), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'T1')
  await assert.rejects(readFile(path.join(root, 'b.txt')), { code: 'ENOENT' })
  t.diagnostic('Injected trusted host Git seam; actual local Git writes and partial receipt observed, fixture receipt is not native authorization')
})

test('legitimate linked worktrees and separate Git directories integrate in their effective canonical root', async t => {
  for (const kind of ['linked', 'separate']) await t.test(kind, async t => {
    const { root, input } = await fixture(t)
    const extra = await mkdtemp(path.join(tmpdir(), 'ri-layout-'))
    t.after(() => rm(extra, { recursive: true, force: true }))
    if (kind === 'linked') {
      git(root, 'config', 'core.worktree', root)
      input.root = path.join(extra, 'linked')
      git(root, 'worktree', 'add', '--detach', input.root, input.expectedRunTip)
    } else {
      const gitdir = path.join(extra, 'gitdir')
      git(root, 'init', '--separate-git-dir', gitdir)
      git(root, 'config', 'core.worktree', path.relative(gitdir, root))
    }
    let receipt
    await assert.doesNotReject(async () => {
      const gateReceipt = await executeReviewedPhaseGate({ ...input, baseBranch: 'main', planPath: 'plan.md' })
      receipt = await integrateReviewedPhase({ ...input, gateReceipt })
    })
    assert.equal(receipt.complete, true)
    assert.equal(await realpath(git(input.root, 'rev-parse', '--show-toplevel')), await realpath(input.root))
    for (const [file, content] of [['a.txt', 'T1'], ['b.txt', 'T2']]) assert.equal(await readFile(path.join(input.root, file), 'utf8'), content)
    if (kind === 'linked') for (const file of ['a.txt', 'b.txt']) await assert.rejects(readFile(path.join(root, file)), { code: 'ENOENT' })
  })
})

test('exact reviewed merges retain author, ancestors and unrelated refs', async t => {
  const { root, anchor, input, gate } = await fixture(t)
  git(root, 'tag', 'fleetmates/r1/T1', anchor)
  const gateReceipt = await gate()
  let receipt
  await assert.doesNotReject(async () => { receipt = await integrateReviewedPhase({ ...input, gateReceipt }) })
  assert.equal(receipt.mode, 'host-bounded')
  assert.equal(receipt.complete, true)
  assert.deepEqual(receipt.verification, gateReceipt.verification)
  assert.equal(receipt.verification.kind, 'injected-unit-fixture')
  assert.equal(receipt.verification.observedNative, false)
  assert.equal(receipt.merges.length, 2)
  for (const tip of Object.values(input.taskTips)) git(root, 'merge-base', '--is-ancestor', tip, receipt.after)
  assert.equal(git(root, 'rev-parse', 'main'), anchor)
  assert.equal(git(root, 'rev-parse', 'refs/tags/fleetmates/r1/T1'), anchor)
  for (const [id, tip] of Object.entries(input.taskTips)) assert.equal(git(root, 'rev-parse', `refs/heads/fleetmates/r1/${id}`), tip)
  assert.equal(git(root, 'show', '-s', '--format=%an <%ae>', receipt.after), 'Example <example@example.invalid>')
  assert.equal(git(root, 'rev-parse', `${receipt.after}^{tree}`), gateReceipt.testedTree)
  await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt }), /executed gate/)
})

test('JSON PASS records and missing authority never authorize a merge', async t => {
  const { root, anchor, input, gate } = await fixture(t)
  for (const gateReceipt of [{ verdict: 'PASS' }, JSON.parse(JSON.stringify(await gate()))]) {
    await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt }), /executed gate/)
  }
  for (const key of Object.keys(policy.roles.integrator)) {
    const changed = structuredClone(policy)
    changed.roles.integrator[key] = !changed.roles.integrator[key]
    await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt: await gate(), policy: changed }), /authority/)
  }
  await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt: await gate(), policy: undefined }), /authority/)
  assert.equal(git(root, 'rev-parse', input.branch), anchor)
})

test('current gate identity rejects changed refs, dirty state, supplied identities and unsupported config', async t => {
  for (const kind of ['task', 'run', 'dirty', 'tips', 'branch', 'phase', 'runId', 'driver', 'plan', 'manifest']) {
    await t.test(kind, async t => {
      const { root, anchor, input, gate } = await fixture(t)
      const gateReceipt = await gate()
      const changed = { ...input, gateReceipt }
      if (kind === 'task') {
        git(root, 'checkout', 'fleetmates/r1/T1')
        await writeFile(path.join(root, 'a.txt'), 'changed')
        git(root, 'commit', '-am', 'test: move task')
        git(root, 'checkout', 'main')
      }
      if (kind === 'run' || kind === 'plan' || kind === 'manifest') {
        git(root, 'checkout', input.branch)
        if (kind !== 'run') await writeFile(path.join(root, kind === 'plan' ? 'plan.md' : 'fleetmates.gate.json'), 'changed')
        git(root, 'add', '.')
        git(root, 'commit', '--allow-empty', '-m', 'test: move run')
      }
      if (kind === 'dirty') await writeFile(path.join(root, 'untracked'), 'dirty')
      if (kind === 'tips') changed.taskTips = { ...input.taskTips, T1: anchor }
      if (kind === 'branch') changed.branch = 'main'
      if (kind === 'phase') changed.phase = 2
      if (kind === 'runId') changed.runId = 'r2'
      if (kind === 'driver') git(root, 'config', 'merge.custom.driver', 'false')
      await assert.rejects(integrateReviewedPhase(changed), /identity|moved|dirty|configuration/)
      assert.equal(git(root, 'rev-parse', 'main'), anchor)
    })
  }
})

test('actual command failure, out-of-scope ownership and missing reviews fail closed', async t => {
  const failed = await fixture(t, { command: 'exit 1' })
  await assert.rejects(failed.gate(), /gate rejected/)
  const scoped = await fixture(t)
  git(scoped.root, 'checkout', 'fleetmates/r1/T1')
  await writeFile(path.join(scoped.root, 'outside.txt'), 'outside')
  git(scoped.root, 'add', '.')
  git(scoped.root, 'commit', '-m', 'test: outside')
  git(scoped.root, 'checkout', 'main')
  scoped.input.taskTips.T1 = git(scoped.root, 'rev-parse', 'fleetmates/r1/T1')
  await assert.rejects(scoped.gate(), /gate rejected|ownership/)
  const reviewed = await fixture(t, { review: true })
  await assert.rejects(reviewed.gate(), /gate rejected/)
  let calls = 0
  const gateReceipt = await reviewed.gate({ reviewCheck: async (check, observed) => {
    calls++
    assert.equal(check.name, 'review')
    assert.equal(await readFile(path.join(observed.root, 'a.txt'), 'utf8'), 'T1')
    assert.equal(await readFile(path.join(observed.root, 'b.txt'), 'utf8'), 'T2')
    assert.match(observed.testedTree, /^[a-f0-9]{40}$/)
    return { status: 'pass' }
  } })
  assert.equal(calls, 1)
  assert.equal((await integrateReviewedPhase({ ...reviewed.input, gateReceipt })).complete, true)
})

test('hostile hooks, fsmonitor and signing are suppressed in gate and integration', async t => {
  const { root, input, gate } = await fixture(t)
  const hooks = path.join(root, '.git', 'hostile-hooks')
  const marker = path.join(root, '.git', 'hook-ran')
  await mkdir(hooks)
  for (const name of ['post-checkout', 'pre-merge-commit', 'post-merge', 'prepare-commit-msg']) {
    await writeFile(path.join(hooks, name), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
    await chmod(path.join(hooks, name), 0o755)
  }
  git(root, 'config', 'core.hooksPath', hooks)
  git(root, 'config', 'core.fsmonitor', path.join(hooks, 'post-checkout'))
  git(root, 'config', 'commit.gpgSign', 'true')
  git(root, 'config', 'gpg.program', path.join(hooks, 'post-checkout'))
  let receipt
  await assert.doesNotReject(async () => { receipt = await integrateReviewedPhase({ ...input, gateReceipt: await gate() }) })
  assert.equal(receipt.complete, true)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('verifier changes and expired executed evidence refuse integration', async t => {
  const { root, input } = await fixture(t)
  const installed = path.join(root, '.git', 'verifier')
  await cp(fileURLToPath(new URL('../scripts', import.meta.url)), installed, { recursive: true })
  const module = await import(pathToFileURL(path.join(installed, 'reviewed-integration.mjs')))
  const gateInput = { ...input, baseBranch: 'main', planPath: 'plan.md' }
  const gateReceipt = await module.executeReviewedPhaseGateFixture(gateInput, injectedExecutor)
  await writeFile(path.join(installed, 'gate-config.mjs'), '\n', { flag: 'a' })
  await assert.rejects(module.integrateReviewedPhaseFixture({ ...input, gateReceipt }), /identity moved/)
  const fresh = await executeReviewedPhaseGate(gateInput)
  const now = Date.now
  Date.now = () => now() + 300_001
  try { await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt: fresh }), /identity mismatch/) }
  finally { Date.now = now }
  assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
})

test('unsupported configured command execution is rejected before checkout', async t => {
  for (const key of ['filter.custom.smudge', 'filter.custom.process', 'diff.external',
    'diff.custom.textconv', 'branch.fleetmates/run/r1.mergeOptions', 'core.alternateRefsCommand']) {
    const { root, input, gate } = await fixture(t)
    const gateReceipt = await gate()
    git(root, 'config', key, 'false')
    await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt }), /configuration/)
    assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
  }
})

// The filter section `git lfs install` writes, verbatim.
const lfsFilter = '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n'

async function withGlobalConfig(t, text, body) {
  const home = await mkdtemp(path.join(tmpdir(), 'ri-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(path.join(home, 'xdg'))
  await writeFile(path.join(home, '.gitconfig'), text)
  const planted = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') }
  const saved = Object.fromEntries(Object.keys(planted).map(key => [key, process.env[key]]))
  Object.assign(process.env, planted)
  try { await body() } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('the standard git-lfs filter is accepted from global configuration only', async t => {
  await withGlobalConfig(t, lfsFilter, async () => {
    const { input, gate } = await fixture(t)
    const receipt = await integrateReviewedPhase({ ...input, gateReceipt: await gate() })
    assert.notEqual(receipt.after, input.expectedRunTip)
  })
  {
    const { root, input, gate } = await fixture(t)
    const gateReceipt = await gate()
    for (const [key, value] of [['clean', 'git-lfs clean -- %f'], ['smudge', 'git-lfs smudge -- %f'], ['process', 'git-lfs filter-process']]) {
      git(root, 'config', `filter.lfs.${key}`, value)
    }
    await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt }), /configuration/)
    assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
  }
  for (const text of [lfsFilter.replace('git-lfs smudge -- %f', 'sh -c true'),
    lfsFilter.replace('[filter "lfs"]', '[filter "LFS"]'),
    '[filter "custom"]\n\tsmudge = git-lfs smudge -- %f\n']) {
    const { root, input, gate } = await fixture(t)
    const gateReceipt = await gate()
    await withGlobalConfig(t, text, async () => {
      await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt }), /configuration/)
    })
    assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
  }
})

test('failure retains the first merge and observed second conflict for reconciliation', async t => {
  const { root, input, gate } = await fixture(t)
  const gateReceipt = await gate()
  let merge = 0
  const executor = async (args, cwd, env) => {
    if (args.includes('merge') && ++merge === 2) {
      const index = await boundedIntegrationGit(['rev-parse', '--git-path', 'index'], root, env)
      assert.equal(index.code, 0)
      const blob = git(root, 'rev-parse', `${input.taskTips.T1}:a.txt`)
      execFileSync('git', ['update-index', '--index-info'], { cwd: root,
        input: `0 ${'0'.repeat(40)}\ta.txt\n100644 ${blob} 1\ta.txt\n100644 ${blob} 2\ta.txt\n100644 ${blob} 3\ta.txt\n` })
      return { code: 1, signal: null, stdout: '', stderr: 'injected conflict' }
    }
    return boundedIntegrationGit(args, cwd, env)
  }
  await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt, git: executor }), error => {
    assert.equal(error.receipt.complete, false)
    assert.equal(error.receipt.state, 'partial')
    assert.equal(error.receipt.merges.length, 1)
    assert.equal(error.receipt.merges[0].tip, input.taskTips.T1)
    assert.equal(error.receipt.after, git(root, 'rev-parse', input.branch))
    assert.equal(error.receipt.pending.task, 'T2')
    assert.deepEqual(error.receipt.conflicts, ['a.txt'])
    git(root, 'merge-base', '--is-ancestor', input.taskTips.T1, error.receipt.after)
    assert.notEqual(error.receipt.after, input.expectedRunTip)
    return true
  })
})

test('rechecks all task tips before the next merge and after the last merge', async t => {
  for (const afterMerge of [1, 2]) {
    const { root, input, gate } = await fixture(t)
    const gateReceipt = await gate()
    let count = 0
    const executor = async (args, cwd, env) => {
      const result = await boundedIntegrationGit(args, cwd, env)
      if (args.includes('merge') && ++count === afterMerge) {
        const fresh = git(root, 'commit-tree', `${input.taskTips.T1}^{tree}`, '-p', input.taskTips.T1, '-m', 'test: concurrent task change')
        git(root, 'update-ref', 'refs/heads/fleetmates/r1/T1', fresh, input.taskTips.T1)
      }
      return result
    }
    await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt, git: executor }), error => {
      assert.match(error.message, /tip moved/)
      assert.equal(error.receipt.complete, false)
      assert.equal(error.receipt.merges.length, afterMerge)
      assert.equal(error.receipt.after, git(root, 'rev-parse', input.branch))
      return true
    })
  }
})

test('a real directory/file merge conflict never produces executed gate authorization', async t => {
  const { root, input, gate } = await fixture(t, { command: 'node -e 0', files: ['folder', 'folder/b.txt'] })
  await assert.rejects(gate(), /gate rejected merge conflict/)
  assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
  assert.equal(git(root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1)
})

test('the base branch cannot be used as the integration destination', async t => {
  const { gate } = await fixture(t)
  await assert.rejects(gate({ branch: 'main' }), /base.*branch/)
})

test('failed post-merge observation preserves an explicit unknown effect', async t => {
  const { root, input, gate } = await fixture(t)
  const gateReceipt = await gate()
  let merged = false
  const executor = async (args, cwd, env) => {
    if (merged) return { code: 1, signal: 'SIGTERM', stdout: '', stderr: '' }
    const result = await boundedIntegrationGit(args, cwd, env)
    if (args.includes('merge')) merged = true
    return result
  }
  await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt, git: executor }), error => {
    assert.equal(error.receipt.state, 'unknown-effect')
    assert.equal(error.receipt.complete, false)
    assert.equal(error.receipt.merges.length, 0)
    assert.equal(error.receipt.pending.task, 'T1')
    assert.equal(error.receipt.after, null)
    assert.notEqual(git(root, 'rev-parse', input.branch), input.expectedRunTip)
    return true
  })
})

test('integration uses configured author even with inherited Git author overrides', async t => {
  const { root, input, gate } = await fixture(t)
  const old = process.env.GIT_AUTHOR_NAME
  process.env.GIT_AUTHOR_NAME = 'Untrusted override'
  try {
    const receipt = await integrateReviewedPhase({ ...input, gateReceipt: await gate() })
    assert.equal(git(root, 'show', '-s', '--format=%an', receipt.after), 'Example')
  } finally {
    if (old === undefined) delete process.env.GIT_AUTHOR_NAME
    else process.env.GIT_AUTHOR_NAME = old
  }
})

test('integration falls back to the host gitconfig identity, never the inherited environment identity', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'ri-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(path.join(home, 'xdg'))
  await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = Host Placeholder\n\temail = host@example.invalid\n')
  const planted = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'),
    GIT_AUTHOR_NAME: 'Env Placeholder', GIT_AUTHOR_EMAIL: 'env@example.invalid',
    GIT_COMMITTER_NAME: 'Env Placeholder', GIT_COMMITTER_EMAIL: 'env@example.invalid' }
  const saved = Object.fromEntries(Object.keys(planted).map(key => [key, process.env[key]]))
  Object.assign(process.env, planted)
  try {
    const identity = (root, rev) => git(root, 'show', '-s', '--format=%an <%ae>|%cn <%ce>', rev)
    {
      const { root, input, gate } = await fixture(t)
      git(root, 'config', '--unset', 'user.name')
      git(root, 'config', '--unset', 'user.email')
      const receipt = await integrateReviewedPhase({ ...input, gateReceipt: await gate() })
      for (const merge of receipt.merges) {
        assert.equal(identity(root, merge.after), 'Host Placeholder <host@example.invalid>|Host Placeholder <host@example.invalid>')
      }
    }
    {
      const { root, input, gate } = await fixture(t)
      const receipt = await integrateReviewedPhase({ ...input, gateReceipt: await gate() })
      for (const merge of receipt.merges) {
        assert.equal(identity(root, merge.after), 'Example <example@example.invalid>|Example <example@example.invalid>')
      }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('hidden index edits added after gating are refused', async t => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const { root, input, gate } = await fixture(t)
    const gateReceipt = await gate()
    git(root, 'update-index', flag, 'plan.md')
    await writeFile(path.join(root, 'plan.md'), 'hidden dirty plan')
    assert.equal(git(root, 'status', '--porcelain'), '')
    await assert.rejects(integrateReviewedPhase({ ...input, gateReceipt }), /index configuration/)
    assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
  }
})

test('actual required verification denies outside-preview writes and private loopback access', async t => {
  let connections = 0
  const server = createServer(socket => { connections++; socket.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  let marker
  const { input } = await fixture(t, { command: root => {
    marker = root + '-outside-marker'
    const program = `const fs=require('fs'),net=require('net');try{fs.writeFileSync(${JSON.stringify(marker)},'dummy')}catch{}const s=net.connect({port:${server.address().port},host:'127.0.0.1'});s.on('connect',()=>s.end());s.on('error',()=>process.exit(2));`
    return nodeCommand(program)
  } })
  t.after(() => rm(marker, { force: true }))
  if (!await nativeAvailable(t, input)) return
  let verification
  await assert.rejects(executeActualGate({ ...input, baseBranch: 'main', planPath: 'plan.md' }), error => {
    assert.match(error.message, /verification|gate rejected/)
    verification = error.verification
    assert.equal(verification.kind, 'native-required')
    assert.equal(verification.observedNative, true)
    return true
  })
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  assert.equal(connections, 0)
  t.diagnostic(JSON.stringify({ kind: 'actual-native-denial-or-safe-refusal', observedNative: verification.observedNative,
    outsidePreviewMarkerCreated: false, privateLoopbackConnections: connections }))
})

test('injected unit receipts cannot authorize production integration or be forged as native JSON', async t => {
  const { input, gate } = await fixture(t)
  const gateReceipt = await gate()
  assert.equal(gateReceipt.verification.observedNative, false)
  await assert.rejects(integrateActualPhase({ ...input, gateReceipt }), /matching verification authority/)
  await assert.rejects(integrateActualPhase({ ...input, gateReceipt: {
    ...JSON.parse(JSON.stringify(gateReceipt)), verification: { kind: 'native-required', observedNative: true }
  } }), /executed gate/)
})

test('positive report inventories execute exactly one current and one baseline command', async t => {
  const program = `const fs=require("fs");fs.writeFileSync(process.env.FLEETMATES_REPORT_DIR+"/suite.xml",'<testsuite name="suite"><testcase file="test.mjs" name="kept"/></testsuite>');`
  const { input } = await fixture(t, { command: nodeCommand(program), report: { dir: true } })
  const calls = []
  let gateReceipt
  await assert.doesNotReject(async () => { gateReceipt = await executeReviewedPhaseGateFixture({ ...input, baseBranch: 'main', planPath: 'plan.md' },
    async ({ sandbox }) => ({ exec: async (command, cwd, options) => {
      assert.equal(cwd, sandbox.cwd)
      calls.push({ cwd, hasTask: await readFile(path.join(cwd, 'a.txt')).then(() => true, () => false) })
      return fixtureExec(command, cwd, options)
    }, close: async () => {} })) })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.hasTask), [true, false])
  assert.notEqual(calls[0].cwd, calls[1].cwd)
  assert.equal(gateReceipt.results.find(result => result.kind === 'inventory').status, 'pass')
  assert.equal(gateReceipt.results.find(result => result.kind === 'fileset').status, 'pass')
  assert.equal(gateReceipt.results.find(result => result.kind === 'ownership').status, 'pass')
  assert.equal((await integrateReviewedPhase({ ...input, gateReceipt })).complete, true)
})

test('actual native positive gate integrates only after observed restrictions, otherwise reports unavailable authority', async t => {
  const { root, input } = await fixture(t, { command: 'node -e 0' })
  if (!await nativeAvailable(t, input)) return
  let gateReceipt
  await assert.doesNotReject(async () => { gateReceipt = await executeActualGate({ ...input, baseBranch: 'main', planPath: 'plan.md' }) })
  assert.equal(gateReceipt.verification.kind, 'native-required')
  assert.equal(gateReceipt.verification.observedNative, true)
  assert.equal((await integrateActualPhase({ ...input, gateReceipt })).complete, true)
  t.diagnostic('Actual native positive gate and exact integration observed')
})

test('a required computed inventory rejects an unapproved dropped case', async t => {
  const program = `const fs=require("fs");const cases=fs.existsSync("a.txt")?["kept"]:["kept","deleted"];fs.writeFileSync(process.env.FLEETMATES_REPORT_DIR+"/suite.xml",'<testsuite name="suite">'+cases.map(name=>'<testcase file="test.mjs" name="'+name+'"/>').join("")+"</testsuite>");`
  const { gate, input } = await fixture(t, { command: nodeCommand(program), report: { dir: true } })
  const rejectedDrop = error => {
    assert.match(error.message, /gate rejected/)
    assert.equal(error.results.find(result => result.kind === 'inventory').status, 'fail')
    assert.match(error.results.find(result => result.kind === 'inventory').output, /drop:.*deleted/)
    return true
  }
  await assert.rejects(gate(), rejectedDrop)
  if (await nativeAvailable(t, input)) await assert.rejects(executeActualGate({ ...input, baseBranch: 'main', planPath: 'plan.md' }), rejectedDrop)
})

test('actual native private report transfer preserves passing baseline inventory and exact integration', async t => {
  const program = `const fs=require("fs");fs.writeFileSync(process.env.FLEETMATES_REPORT_DIR+"/suite.xml",'<testsuite name="suite"><testcase file="test.mjs" name="kept"/></testsuite>');`
  const { input } = await fixture(t, { command: nodeCommand(program), report: { dir: true } })
  if (!await nativeAvailable(t, input)) return
  let gateReceipt
  await assert.doesNotReject(async () => { gateReceipt = await executeActualGate({ ...input, baseBranch: 'main', planPath: 'plan.md' }) })
  assert.equal(gateReceipt.verification.observedNative, true)
  assert.equal(gateReceipt.results.find(result => result.kind === 'inventory').status, 'pass')
  assert.equal((await integrateActualPhase({ ...input, gateReceipt })).complete, true)
})

test('private report transfer rejects symbolic, special, oversized and excessive report entries', async t => {
  for (const [kind, body, expected] of [
    ['link', 'fs.writeFileSync(dir+"/target","dummy");fs.symlinkSync(dir+"/target",dir+"/report.xml","file")', /symbolic link/],
    ['special', 'require("child_process").execFileSync("mkfifo",[dir+"/report.xml"])', /regular file/],
    ['socket', 'process.chdir(dir);require("net").createServer().listen("report.xml",()=>process.exit(0))', /regular file/],
    ['bytes', 'const fd=fs.openSync(dir+"/report.xml","w");fs.ftruncateSync(fd,50*1024*1024+1);fs.closeSync(fd)', /byte bound/],
    ['count', 'for(let i=0;i<1001;i++)fs.writeFileSync(dir+"/"+i+".xml",\'<testsuite name="suite"><testcase file="test.mjs" name="kept"/></testsuite>\')', /count exceeded/],
    ['depth', 'let nested=dir;for(let i=0;i<9;i++){nested+="/d";fs.mkdirSync(nested)}fs.writeFileSync(nested+"/report.xml",\'<testsuite name="suite"><testcase file="test.mjs" name="kept"/></testsuite>\')', /directory is unsafe/]
  ]) {
    await t.test(kind, async t => {
      if (['link', 'special', 'socket'].includes(kind)) {
        const capability = await probeReportFixture(kind)
        if (!capability.available) {
          t.diagnostic(`Fixture creation unavailable: ${kind} (${capability.reason}); denial not observed for this fixture`)
          t.skip(`fixture creation unavailable: ${capability.reason}`)
          return
        }
      }
      const program = 'const fs=require("fs"),dir=process.env.FLEETMATES_REPORT_DIR;' + body
      const { gate } = await fixture(t, { command: nodeCommand(program), report: { dir: true } })
      await assert.rejects(gate(), expected)
      if (['link', 'special', 'socket'].includes(kind)) t.diagnostic(`Observed report denial with created ${kind} fixture`)
    })
  }
})

test('injected producer fixtures cannot substitute malformed restriction evidence', async t => {
  const { root, input } = await fixture(t, { command: 'node -e 0' })
  const installed = path.join(root, '.git', 'injected-producer')
  await cp(fileURLToPath(new URL('../scripts', import.meta.url)), installed, { recursive: true })
  const marker = path.join(root, '.git', 'unverified-command')
  for (const [index, change] of [
    { observed: false }, { observed: 'true' }, { kind: 'legacy' }, { runtime: 'invented' }, { network: true },
    { sharedRefs: true }, { publication: true }, { write: false }
  ].entries()) {
    const nativeSource = path.join(installed, 'harnesses', `codex-${index}.mjs`)
    const evidence = { kind: 'required', runtime: 'codex-sandbox', observed: true,
      write: true, network: false, sharedRefs: false, publication: false, ...change }
    await writeFile(nativeSource, `import {writeFile} from 'node:fs/promises';\nexport async function createVerificationExecutor(){return{evidence:${JSON.stringify(evidence)},close:async()=>{},exec:async()=>{await writeFile(${JSON.stringify(marker)},'dummy');return{code:0,output:''}}}}\n`)
    const copiedModule = path.join(installed, `reviewed-integration-${index}.mjs`)
    const source = await readFile(fileURLToPath(new URL('../scripts/reviewed-integration.mjs', import.meta.url)), 'utf8')
    await writeFile(copiedModule, source.replace("from './harnesses/codex.mjs'", `from './harnesses/codex-${index}.mjs'`))
    const module = await import(pathToFileURL(copiedModule))
    await assert.rejects(module.executeReviewedPhaseGate({ ...input, baseBranch: 'main', planPath: 'plan.md' }), /restrictions were not independently observed/)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
  }
})

test('a skipped computed inventory cannot authorize even an injected unit receipt', async t => {
  const program = `const fs=require("fs");fs.writeFileSync(process.env.FLEETMATES_REPORT_DIR+"/suite.xml",'<testsuite name="suite"><testcase file="test.mjs" name="kept"/></testsuite>');`
  const { root, input } = await fixture(t, { command: nodeCommand(program), report: { dir: true } })
  const installed = path.join(root, '.git', 'injected-inventory')
  await cp(fileURLToPath(new URL('../scripts', import.meta.url)), installed, { recursive: true })
  await writeFile(path.join(installed, 'injected-runner.mjs'), `export {deriveContext,aggregateVerdict} from './gate-runner.mjs';import {runChecks as actual} from './gate-runner.mjs';export async function runChecks(...args){const results=await actual(...args);results.find(result=>result.kind==='inventory').status='skip';return results}\n`)
  const source = await readFile(fileURLToPath(new URL('../scripts/reviewed-integration.mjs', import.meta.url)), 'utf8')
  const target = path.join(installed, 'skip-inventory.mjs')
  await writeFile(target, source.replace("from './gate-runner.mjs'", "from './injected-runner.mjs'"))
  const module = await import(pathToFileURL(target))
  await assert.rejects(module.executeReviewedPhaseGateFixture({ ...input, baseBranch: 'main', planPath: 'plan.md' }, injectedExecutor), error => {
    assert.match(error.message, /gate rejected/)
    assert.equal(error.results.find(result => result.kind === 'inventory').status, 'skip')
    return true
  })
  assert.equal(git(root, 'rev-parse', input.branch), input.expectedRunTip)
})
