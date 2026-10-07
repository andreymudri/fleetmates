import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { executeWorkflowProfile, resumeWorkflowProfile, validateWorkflowExpansion } from '../scripts/workflow-controller.mjs'
import { expandWorkflowProfile } from '../scripts/workflow-profile.mjs'
import { createHash } from 'node:crypto'
import { defaultExec } from '../scripts/gate-runner.mjs'
import { retainExecutionArtifact } from '../scripts/execution-artifacts.mjs'

// The child CLI is a real Node process started through the bounded executor. It stands in for the
// installed fleetmates CLI: it records every invocation, writes only the artifacts the real
// commands write, at the paths they write them, and follows their exit contracts: gate exits 1 on
// FAIL after printing its verdict block, and finish exits 4 while an agent check has no supplied result.
const FAKE_CLI = String.raw`
import { appendFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const args = process.argv.slice(2), command = args[0]
const flag = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1] }
const root = flag('root'), run = flag('run'), mode = process.env.FAKE_MODE ?? ''
const bin = path.dirname(process.env.FAKE_LOG)
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command, args, script: process.argv[1], cwd: process.cwd() }) + '\n')
const git = (a, options = {}) => execFileSync('git', a, { cwd: root, encoding: 'utf8', ...options }).trim()
const dir = path.join(root, '.fleetmates', run ?? 'none'), tasks = JSON.parse(process.env.FAKE_TASKS)
const once = name => { const file = path.join(bin, name); if (existsSync(file)) return false; writeFileSync(file, ''); return true }
const tips = phase => Object.fromEntries(tasks.filter(t => t.phase === phase).map(t => ['fleetmates/' + run + '/' + t.id, git(['rev-parse', 'refs/heads/fleetmates/' + run + '/' + t.id])]))
const commit = (parent, file, content, message) => {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(bin, 'index-' + process.pid) }
  git(['read-tree', parent], { env })
  git(['update-index', '--add', '--cacheinfo', '100644,' + git(['hash-object', '-w', '--stdin'], { input: content }) + ',' + file], { env })
  const sha = git(['commit-tree', git(['write-tree'], { env }), '-p', parent, '-m', message])
  rmSync(env.GIT_INDEX_FILE, { force: true })
  return sha
}
if (command === 'init-run') {
  if (!mode.includes('no-plan')) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ runId: run, runBranch: process.env.FAKE_RUN_BRANCH, planPath: args[1],
      tasks: tasks.map(t => ({ id: t.id, phase: t.phase, files: [t.file] })) }))
  }
  console.log('phase 1: T1')
} else if (command === 'preview-check') {
  if (mode.includes('move-base')) {
    const base = git(['rev-parse', 'refs/heads/main'])
    git(['update-ref', 'refs/heads/main', commit(base, 'plan.md', 'changed plan\n', 'docs: change plan')])
  }
  if (mode.includes('touch-cli')) appendFileSync(process.argv[1], '\n// changed installed verifier\n')
  if (mode.includes('suspend')) git(['update-ref', 'refs/fleetmates/r1/suspended', 'HEAD'])
  if (mode.includes('flood')) process.stdout.write('x'.repeat(5 * 1024 * 1024))
  if (mode.includes('big-output')) console.log('y'.repeat(4000))
  console.error('preview ok on stderr')
  console.log('preview ok')
} else if (command === 'dispatch') {
  if (mode.includes('hang-dispatch')) { writeFileSync(path.join(bin, 'hang.pid'), String(process.pid)); setInterval(() => {}, 1000) }
  else {
    const phase = Number(flag('phase')), runTip = git(['rev-parse', 'refs/heads/' + process.env.FAKE_RUN_BRANCH])
    mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    for (const t of tasks.filter(t => t.phase === phase)) {
      const branch = 'fleetmates/' + run + '/' + t.id
      let tip = mode.includes('empty-branch') ? runTip : commit(runTip, t.file, t.id + '\n', 'feat: ' + t.id)
      if (mode.includes('extra-file')) tip = commit(tip, 'undeclared.txt', 'outside\n', 'feat: outside the declared set')
      git(['update-ref', 'refs/heads/' + branch, tip])
      if (!mode.includes('no-result')) writeFileSync(path.join(dir, 'sessions', t.id + '.result.json'),
        JSON.stringify({ status: 'done', branch: mode.includes('wrong-branch') ? 'fleetmates/' + run + '/other' : branch, filesChanged: [t.file], summary: 'fixture', blockers: [] }))
    }
    console.log('dispatched')
  }
} else if (command === 'dispatch-reviews') {
  if (mode.includes('reviews-exit-2')) { console.log('unsupported flag spelling'); process.exit(2) }
  const phase = Number(flag('phase'))
  if (mode.includes('move-tip')) for (const t of tasks.filter(t => t.phase === phase)) {
    const ref = 'refs/heads/fleetmates/' + run + '/' + t.id, tip = git(['rev-parse', ref])
    git(['update-ref', ref, commit(tip, t.file, 'moved\n', 'feat: moved after implementation')])
  }
  const branchShas = tips(phase)
  mkdirSync(path.join(dir, 'reviews'), { recursive: true })
  const names = Object.keys(branchShas).sort()
  writeFileSync(path.join(dir, 'reviews', phase + '-correctness.json'), JSON.stringify({ stamp: { phase: String(phase), lens: 'correctness',
    branches: names.map(n => n + '@' + (mode.includes('stale-review') ? '0'.repeat(40) : branchShas[n])) }, findings: [] }))
  console.log('reviews dispatched')
} else if (command === 'collect-reviews') {
  const phase = flag('phase'), file = path.join(dir, 'reviews', 'results-' + phase + '.json')
  const document = JSON.stringify({ results: [{ name: 'review', kind: 'agent', status: mode.includes('review-blocks') ? 'fail' : 'pass', findings: [] }] }, null, 2)
  const line = target => console.log('results written to ' + target + ' — pass that path to gate --results')
  console.log(document)
  if (mode.includes('decoy-path')) {
    const decoy = path.join(bin, 'decoy.json')
    writeFileSync(decoy, document + '\n')
    writeFileSync(file, document + '\n')
    line(decoy)
  } else if (mode.includes('file-without-line')) writeFileSync(file, document + '\n')
  else if (!mode.includes('stdout-only')) {
    writeFileSync(file, document + '\n')
    line(file)
    if (mode.includes('double-line')) line(file)
  }
} else if (command === 'gate') {
  if (mode.includes('gate-infra-once') && once('gate-infra')) { console.log('cannot verify'); process.exit(4) }
  if (mode.includes('gate-fails')) {
    console.log('gate: running 1 command check')
    console.log(JSON.stringify({ verdict: 'FAIL', failed: ['behavior'], phase: Number(flag('phase')), results: [{ name: 'behavior', kind: 'command', status: 'fail' }] }, null, 2))
    process.exit(1)
  }
  console.log('PASS')
} else if (command === 'fix') {
  const verdict = JSON.parse(readFileSync(flag('verdict'), 'utf8'))
  writeFileSync(path.join(bin, 'verdict-seen.json'), JSON.stringify(verdict))
  console.log(JSON.stringify(mode.includes('fix-escalate') ? { decision: 'escalate', tasks: [], reason: 'budget-exhausted', taskId: 'T1' }
    : { decision: 'retry', tasks: [{ taskId: 'T1', tier: 'mid', round: 1, checks: verdict.results.filter(r => r.status === 'fail').map(r => r.name) }], reason: null }, null, 2))
} else if (command === 'finish') {
  const supplied = flag('results') ? JSON.parse(readFileSync(flag('results'), 'utf8')) : null
  const pending = [...new Set(tasks.map(t => t.phase))].filter(phase => !supplied?.phases?.[String(phase)]?.results?.some(r => r.name === 'review' && r.status === 'pass'))
  if (pending.length) { console.log('pending: review'); process.exit(4) }
  console.log('finished')
} else process.exit(2)
`
const FAKE_CODEX = String.raw`
if (process.env.FAKE_AUTH === 'none') console.log('Not logged in')
else console.log('Logged in using ChatGPT')
`

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const node = JSON.stringify(process.execPath)
const policy = { version: 1, roles: {
  implementer: { read: true, write: true, execute: true, network: false, sharedRefs: false, publication: false },
  reviewer: { read: true, write: false, execute: true, network: false, sharedRefs: false, publication: false },
  integrator: { read: true, write: true, execute: true, network: false, sharedRefs: true, publication: false } } }
const retention = { maxArtifactBytes: 1024 * 1024, maxRunBytes: 64 * 1024 * 1024, maxAgeMs: 86400000 }
const factory = async () => ({ exec: defaultExec, close: async () => {} })

async function project(t, { tasks = [{ id: 'T1', phase: 1, file: 'a.txt' }], rolePolicy = policy, fixRounds = 1, required = [tasks[0].file] } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'wfc-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'repo'), bin = path.join(base, 'bin')
  await mkdir(root); await mkdir(bin)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid')
  await writeFile(path.join(root, 'plan.md'), tasks.map(task => `### Task ${task.id.slice(1)}: task ${task.id}\n\n${task.phase > 1 ? `**Depends:** T${task.phase - 1}\n` : ''}**Files:**\n- Create: \`${task.file}\`\n`).join('\n'))
  const check = `${node} -e "process.exit(${JSON.stringify(required).replaceAll('"', "'")}.every(f=>require('fs').existsSync(f))?0:1)"`
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { fixRounds, checks: [
    { name: 'behavior', kind: 'command', run: check }, { name: 'review', kind: 'agent', lens: ['correctness'], blockOn: ['high'] }] } } }))
  await writeFile(path.join(root, 'env.json'), JSON.stringify({ version: 1, toolchains: [{ name: 'node', command: process.execPath, argv: ['--version'], expected: 'v' }],
    lockfiles: [], setup: [], baseline: [{ name: 'runtime', run: `${node} -e 0`, timeoutMs: 20000 }], required: [], dependencies: 'clean-checkout' }))
  await writeFile(path.join(root, 'roles.json'), JSON.stringify(rolePolicy))
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: anchor')
  git(root, 'checkout', '-b', 'fleetmates/run/r1')
  const cliPath = path.join(bin, 'cli.mjs'), codex = path.join(bin, 'codex.mjs'), log = path.join(bin, 'invocations.jsonl')
  await writeFile(cliPath, FAKE_CLI); await writeFile(codex, FAKE_CODEX)
  const calls = []
  const env = { mode: '', auth: 'ok' }
  const executor = (command, cwd, options = {}) => {
    calls.push({ command, argv: options.argv ?? null })
    env.hook?.(command, options)
    const fixtureEnv = { FAKE_LOG: log, FAKE_MODE: env.mode, FAKE_AUTH: env.auth, FAKE_TASKS: JSON.stringify(tasks), FAKE_RUN_BRANCH: 'fleetmates/run/r1' }
    if (command === 'codex') return defaultExec(process.execPath, cwd, { ...options, argv: [codex, ...options.argv], env: fixtureEnv })
    return defaultExec(command, cwd, { ...options, env: { ...options.env, ...fixtureEnv } })
  }
  const invocations = async () => existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const request = { version: 1, profile: 'bug-fix', runId: 'r1', planPath: 'plan.md', baseBranch: 'main', runBranch: 'fleetmates/run/r1',
    harness: 'codex', sandboxMode: 'clone', parameters: {}, limits: { maxWallMs: 600000, maxAttempts: 40, maxRepairRounds: 2, stepTimeoutMs: 60000 } }
  const run = overrides => executeWorkflowProfile({ root, cliPath, request, environment: 'env.json', rolePolicy: 'roles.json', retention, executor,
    verificationFactory: factory, ...overrides })
  const resume = overrides => resumeWorkflowProfile({ root, cliPath, runId: 'r1', executor, verificationFactory: factory, ...overrides })
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return { root, base, bin, common, cliPath, log, calls, env, executor, invocations, request, run, resume, tasks }
}
const commands = list => list.map(entry => entry.command)

test('a missing named artifact prevents the next command from being spawned', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'no-result'
  const report = await fixture.run()
  assert.deepEqual(commands(await fixture.invocations()), ['init-run', 'preview-check', 'dispatch'])
  assert.equal(report.state, 'blocked')
  assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [['missing-artifact', 'implement-1']])
  assert.equal(report.verifiedComplete, false)

  const noPlan = await project(t)
  noPlan.env.mode = 'no-plan'
  const second = await noPlan.run()
  assert.deepEqual(commands(await noPlan.invocations()), ['init-run'])
  assert.deepEqual(second.blockers.map(b => [b.category, b.step]), [['missing-artifact', 'prepare']])
})

test('an unverified capability prevents the first spawn and supplied capability strings are refused', async t => {
  const fixture = await project(t)
  fixture.env.auth = 'none'
  const report = await fixture.run()
  assert.equal(report.state, 'blocked')
  assert.equal(report.blockers[0].category, 'capability')
  assert.deepEqual(await fixture.invocations(), [])
  assert.deepEqual(fixture.calls.map(call => call.command), ['codex'], 'only the read-only probe ran; no recipe or CLI command started')
  fixture.env.auth = 'ok'
  fixture.calls.length = 0
  await assert.rejects(fixture.run({ request: { ...fixture.request, capabilities: { harness: 'available' } } }), /request/)
  assert.deepEqual(fixture.calls, [])
})

test('two independent profiles execute fixed CLI fragments with absolute entrypoint, validated outputs and host-bounded integration', async t => {
  const twoPhases = [{ id: 'T1', phase: 1, file: 'a.txt' }, { id: 'T2', phase: 2, file: 'b.txt' }]
  for (const [profile, tasks] of [['bug-fix', undefined], ['feature', twoPhases]]) {
    const fixture = await project(t, tasks ? { tasks } : {})
    const phases = [...new Set(fixture.tasks.map(task => task.phase))]
    const report = await fixture.run({ request: { ...fixture.request, profile } })
    const seen = await fixture.invocations()
    assert.deepEqual(commands(seen), ['init-run', 'preview-check', ...phases.flatMap(() => ['dispatch', 'dispatch-reviews', 'collect-reviews', 'gate'])])
    for (const entry of seen) {
      assert.equal(entry.script, fixture.cliPath)
      assert.deepEqual(entry.args.slice(-2), ['--root', fixture.root])
      assert.equal(entry.cwd, fixture.root)
    }
    assert.deepEqual(seen.find(e => e.command === 'dispatch').args.slice(-6, -2), ['--environment', 'env.json', '--role-policy', 'roles.json'])
    assert.deepEqual(seen.filter(e => e.command === 'gate').map(e => e.args.slice(-4, -2)),
      phases.map(phase => ['--results', path.join(fixture.root, `.fleetmates/r1/reviews/results-${phase}.json`)]))
    assert.equal(report.state, 'human-required', 'acceptance evidence is mandatory and never skipped')
    assert.equal(report.verifiedComplete, false)
    assert.equal(report.publication, 'absent')
    let tip = git(fixture.root, 'rev-parse', 'refs/heads/fleetmates/run/r1')
    for (const task of [...fixture.tasks].reverse()) {
      const [, first, second] = git(fixture.root, 'rev-list', '--parents', '-n', '1', tip).split(' ')
      assert.equal(second, git(fixture.root, 'rev-parse', `refs/heads/fleetmates/r1/${task.id}`), `${task.id} was merged by its own no-ff merge`)
      tip = first
    }
    assert.equal(tip, git(fixture.root, 'rev-parse', 'refs/heads/main'))
    for (const phase of phases) {
      const integration = report.steps.find(step => step.id === `integrate-${phase}`)
      assert.equal(integration.status, 'completed')
      assert.equal(integration.mode, 'host-bounded')
    }
    assert.ok(report.steps.every(step => step.status !== 'completed' || step.artifacts.length > 0))

    const final = git(fixture.root, 'rev-parse', 'refs/heads/fleetmates/run/r1^{tree}')
    assert.equal(report.acceptance.tree, final)
    const common = git(fixture.root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const acceptance = []
    for (const criterion of report.acceptance.required) {
      const bytes = Buffer.from(JSON.stringify({ version: 1, criterion, tree: final, status: 'pass', source: 'test-fixture-observation' }))
      acceptance.push({ criterion, reference: (await retainExecutionArtifact({ common, runId: 'r1', kind: 'acceptance-evidence', bytes, retention })).reference })
    }
    const done = await fixture.resume({ acceptance })
    assert.deepEqual(commands(await fixture.invocations()).slice(seen.length), [...phases.flatMap(() => ['collect-reviews', 'gate']), 'finish'],
      'observed task and review outputs are reused; mandatory verdicts rerun')
    const finishArgs = (await fixture.invocations()).at(-1).args
    const suppliedPath = path.join(fixture.root, '.fleetmates/r1/reviews/finish-results.json')
    assert.deepEqual(finishArgs.slice(-4, -2), ['--results', suppliedPath])
    assert.deepEqual(Object.keys(JSON.parse(await readFile(suppliedPath, 'utf8')).phases), phases.map(String))
    assert.equal(done.obligations.verifiedComplete, true)
    assert.equal(done.verification, 'injected-unit-fixture')
    assert.equal(done.verifiedComplete, false, 'an injected verification fixture is not completion evidence')
    assert.equal(done.state, 'unresolved')
  }
})

test('collect-reviews results come from the exact success write line, never stdout JSON or another path', async t => {
  for (const mode of ['stdout-only', 'decoy-path', 'file-without-line']) {
    const fixture = await project(t)
    fixture.env.mode = mode
    const report = await fixture.run()
    assert.deepEqual(commands(await fixture.invocations()), ['init-run', 'preview-check', 'dispatch', 'dispatch-reviews', 'collect-reviews'])
    assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [['missing-artifact', 'collect-1']])
  }
  const stale = await project(t)
  stale.env.mode = 'stale-review'
  const report = await stale.run()
  assert.deepEqual(commands(await stale.invocations()), ['init-run', 'preview-check', 'dispatch', 'dispatch-reviews'])
  assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [['missing-artifact', 'review-1']])
})

test('resume reconciles retained attempts: observed outputs are reused while stale mandatory verdicts rerun', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'gate-infra-once'
  const first = await fixture.run()
  assert.equal(first.state, 'blocked')
  assert.deepEqual(first.blockers.map(b => [b.category, b.step]), [['infrastructure', 'gate-1']])
  const second = await fixture.resume()
  assert.deepEqual(commands(await fixture.invocations()), ['init-run', 'preview-check', 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate', 'collect-reviews', 'gate'])
  assert.equal(second.state, 'human-required')
  assert.deepEqual(second.steps.filter(step => step.status === 'reused').map(step => step.id), ['prepare', 'baseline', 'implement-1', 'review-1'])
})

test('a timed-out agent step is an unknown effect and resume refuses to redispatch it', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'hang-dispatch'
  const started = Date.now()
  const report = await fixture.run({ request: { ...fixture.request, limits: { ...fixture.request.limits, stepTimeoutMs: 1000 } } })
  assert.ok(Date.now() - started < 30000)
  assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [['unknown-effect', 'implement-1']])
  fixture.env.mode = ''
  const resumed = await fixture.resume()
  assert.deepEqual(commands(await fixture.invocations()), ['init-run', 'preview-check', 'dispatch'])
  assert.deepEqual(resumed.blockers.map(b => [b.category, b.step]), [['unknown-effect', 'implement-1']])
})

test('a committed input that changes between steps blocks before the next spawn', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'move-base'
  const report = await fixture.run()
  assert.deepEqual(commands(await fixture.invocations()), ['init-run', 'preview-check'])
  assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [['changed-input', 'implement-1']])
})

test('code failures go to the existing fix decision and stop without a fake re-dispatch; budgets stop before spawning', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'gate-fails'
  const report = await fixture.run()
  const seen = await fixture.invocations()
  assert.deepEqual(commands(seen), ['init-run', 'preview-check', 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate', 'fix'])
  assert.deepEqual(seen.at(-1).args.slice(0, 7), ['fix', '--run', 'r1', '--phase', '1', '--verdict', path.join(fixture.root, '.fleetmates/r1/profile-verdict-1.json')])
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.bin, 'verdict-seen.json'), 'utf8')).results, [{ name: 'behavior', kind: 'command', status: 'fail' }],
    'the verdict block printed by gate exit 1 reached fix')
  assert.equal(report.state, 'failed')
  assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [['code', 'gate-1']])
  assert.match(report.blockers[0].reason, /^repair-round-required/)
  assert.equal(report.repair.decision.decision, 'retry')

  const escalated = await project(t)
  escalated.env.mode = 'gate-fails fix-escalate'
  const exhausted = await escalated.run()
  assert.deepEqual(exhausted.blockers.map(b => [b.category, b.step, b.reason]), [['code', 'gate-1', 'fix-escalated: budget-exhausted']])

  const hostGate = await project(t, { required: ['missing.txt'] })
  const rejected = await hostGate.run()
  assert.deepEqual(commands(await hostGate.invocations()), ['init-run', 'preview-check', 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate', 'fix'])
  assert.deepEqual(rejected.blockers.map(b => [b.category, b.step]), [['code', 'integrate-1']])
  assert.ok(JSON.parse(await readFile(path.join(hostGate.bin, 'verdict-seen.json'), 'utf8')).results.some(r => r.name === 'behavior' && r.status === 'fail'))
  assert.equal(git(hostGate.root, 'rev-parse', 'refs/heads/fleetmates/run/r1'), git(hostGate.root, 'rev-parse', 'refs/heads/main'), 'a rejected host gate merges nothing')

  const attempts = await project(t)
  const limited = await attempts.run({ request: { ...attempts.request, limits: { ...attempts.request.limits, maxAttempts: 2 } } })
  assert.deepEqual(commands(await attempts.invocations()), ['init-run', 'preview-check'])
  assert.deepEqual(limited.blockers.map(b => [b.category, b.step]), [['budget', 'implement-1']])

  const wall = await project(t)
  let clock = Date.now()
  const timed = await wall.run({ now: () => (clock += 60000), request: { ...wall.request, limits: { ...wall.request.limits, maxWallMs: 1800000 } } })
  assert.equal(timed.blockers[0].category, 'budget')
  assert.match(timed.blockers[0].reason, /wall-time/)
  assert.ok(commands(await wall.invocations()).length < 6)
})

test('malformed requests, unsafe entrypoints and unsupported role authority refuse before any executor call', async t => {
  const fixture = await project(t)
  const refusals = [
    { request: { ...fixture.request, version: 2 } },
    { request: { ...fixture.request, argv: ['sh', '-c', 'true'] } },
    { request: { ...fixture.request, limits: { ...fixture.request.limits, maxWallMs: 0 } } },
    { request: { ...fixture.request, profile: 'custom-shell' } },
    { cliPath: 'cli.mjs' },
    { cliPath: path.join(fixture.base, 'bin', 'codex.mjs') },
    { root: 'repo' },
    { environment: '../env.json' },
  ]
  for (const overrides of refusals) await assert.rejects(fixture.run(overrides))
  assert.deepEqual(fixture.calls, [])
  assert.deepEqual(await fixture.invocations(), [])

  const widened = await project(t, { rolePolicy: { ...policy, roles: { ...policy.roles, implementer: { ...policy.roles.implementer, publication: true } } } })
  const report = await widened.run()
  assert.equal(report.state, 'blocked')
  assert.equal(report.blockers[0].category, 'policy')
  assert.deepEqual(widened.calls, [])
})

test('expansion validation accepts only the fixed CLI fragment set bound to the controller inputs', () => {
  const sha = value => createHash('sha256').update(value).digest('hex')
  const markdown = '### Task 1: First\n\n**Files:**\n- Create: `a.txt`\n'
  const manifestText = JSON.stringify({ phases: { default: { checks: [{ name: 'review', kind: 'agent', lens: ['correctness'] }] } } })
  const inputs = { commit: 'a'.repeat(40), plan: sha(markdown), manifest: sha(manifestText), context: 'c'.repeat(64), environment: 'e'.repeat(64), verifier: 'f'.repeat(64) }
  const request = { runId: 'r1' }
  const expanded = expandWorkflowProfile({ profile: 'bug-fix', runId: 'r1', planPath: 'plan.md', baseBranch: 'main', harness: 'codex', inputs, markdown, manifestText,
    capabilities: { harness: 'available' }, integration: 'host-bounded', contracts: { environment: 'env.json', rolePolicy: 'roles.json' } })
  assert.deepEqual(validateWorkflowExpansion(expanded, { inputs, request }), [1])
  const rehash = value => { const { profileHash, ...rest } = value; return { ...rest, profileHash: sha(JSON.stringify(rest)) } }
  const tamper = change => { const copy = structuredClone(expanded); change(copy); return rehash(copy) }
  const refusals = [
    tamper(p => { p.steps.find(s => s.id === 'implement-1').argv[2] = 'dispatch-integrator' }),
    tamper(p => { p.steps.find(s => s.id === 'implement-1').argv[2] = 'finish' }),
    tamper(p => { p.steps.find(s => s.id === 'gate-1').argv.push('--root', '/elsewhere') }),
    tamper(p => { p.steps.find(s => s.id === 'baseline').argv = ['sh', '-c', 'curl example.invalid'] }),
    tamper(p => { p.steps.find(s => s.id === 'review-1').argv[4] = 'other-run' }),
    tamper(p => { Object.assign(p.steps.find(s => s.id === 'integrate-1'), { kind: 'agent', argv: ['node', 'scripts/cli.mjs', 'dispatch-integrator', '--run', 'r1'] }) }),
    tamper(p => { p.steps.find(s => s.id === 'collect-1').resultsPath = '.fleetmates/r1/elsewhere.json' }),
    tamper(p => { p.steps.splice(p.steps.findIndex(s => s.id === 'acceptance'), 1) }),
    tamper(p => { p.integration = 'legacy' }),
    { ...expanded, steps: expanded.steps.slice(1) },
  ]
  for (const [index, value] of refusals.entries()) assert.throws(() => validateWorkflowExpansion(value, { inputs, request }), undefined, `refusal ${index}`)
  assert.throws(() => validateWorkflowExpansion(expanded, { inputs: { ...inputs, plan: 'b'.repeat(64) }, request }), /identity/)
  assert.throws(() => validateWorkflowExpansion(tamper(p => { p.steps.find(s => s.id === 'finish').argv.splice(-2, 2) }), { inputs, request }), /finish/)
  assert.throws(() => validateWorkflowExpansion(tamper(p => { p.steps.find(s => s.id === 'gate-1').argv.splice(-1, 1, '.fleetmates/r1/reviews/other.json') }), { inputs, request }), /gate must read/)
})

const upTo = { prepare: ['init-run'], baseline: ['init-run', 'preview-check'], implement: ['init-run', 'preview-check', 'dispatch'],
  review: ['init-run', 'preview-check', 'dispatch', 'dispatch-reviews'], collect: ['init-run', 'preview-check', 'dispatch', 'dispatch-reviews', 'collect-reviews'] }
test('each output, input and exit-contract guard stops the run before the next command is spawned', async t => {
  const cases = [
    ['extra-file', 'implement', 'missing-artifact', 'implement-1', /outside its declared set/],
    ['wrong-branch', 'implement', 'missing-artifact', 'implement-1', /not done/],
    ['empty-branch', 'implement', 'missing-artifact', 'implement-1', /missing or empty/],
    ['move-tip', 'review', 'missing-artifact', 'review-1', /moved/],
    ['reviews-exit-2', 'review', 'policy', 'review-1', /exit 2/],
    ['double-line', 'collect', 'missing-artifact', 'collect-1', /success line/],
    ['touch-cli', 'baseline', 'changed-input', 'implement-1', /verifier/],
    ['flood', 'baseline', 'infrastructure', 'baseline', /output limit/],
  ]
  for (const [mode, last, category, step, reason] of cases) {
    const fixture = await project(t)
    fixture.env.mode = mode
    const report = await fixture.run()
    assert.deepEqual(commands(await fixture.invocations()), upTo[last], mode)
    assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [[category, step]], mode)
    assert.match(report.blockers[0].reason, reason, mode)
  }
  const suspended = await project(t)
  suspended.env.mode = 'suspend'
  const paused = await suspended.run()
  assert.deepEqual(commands(await suspended.invocations()), upTo.baseline)
  assert.equal(paused.state, 'suspended')
  assert.deepEqual(paused.blockers.map(b => [b.category, b.step]), [['lifecycle', 'implement-1']])

  const altered = await project(t)
  altered.env.hook = (command, options) => {
    if (options.argv?.[1] === 'gate') writeFileSync(path.join(altered.root, '.fleetmates/r1/reviews/results-1.json'), '{"results":[]}\n')
  }
  const changedInput = await altered.run()
  assert.deepEqual(commands(await altered.invocations()), [...upTo.collect, 'gate'])
  assert.deepEqual(changedInput.blockers.map(b => [b.category, b.step]), [['missing-artifact', 'gate-1']])
  assert.match(changedInput.blockers[0].reason, /review input changed/)

  const small = await project(t)
  small.env.mode = 'big-output'
  const unretained = await small.run({ retention: { ...retention, maxArtifactBytes: 2048 } })
  assert.deepEqual(commands(await small.invocations()), upTo.baseline)
  assert.deepEqual(unretained.blockers.map(b => [b.category, b.step]), [['infrastructure', 'baseline']])
  assert.match(unretained.blockers[0].reason, /not retained/)
})

test('a start that cannot be persisted fails closed before the action, and a journal is never restarted fresh', async t => {
  const fixture = await project(t)
  const lock = path.join(fixture.common, 'fleetmates-execution', createHash('sha256').update('r1').digest('hex'), '.lock')
  fixture.env.hook = command => { if (command === 'codex') mkdirSync(lock) }
  const report = await fixture.run()
  assert.deepEqual(await fixture.invocations(), [])
  assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [['infrastructure', 'prepare']])
  assert.match(report.blockers[0].reason, /start not persisted/)
  await rm(lock, { recursive: true })
  fixture.env.hook = null
  await assert.rejects(fixture.run(), /resume/)
  assert.deepEqual(await fixture.invocations(), [])
})

test('resume counts prior attempts and prior wall time against the run budgets', async t => {
  const attempts = await project(t)
  attempts.env.mode = 'gate-infra-once'
  const first = await attempts.run({ request: { ...attempts.request, limits: { ...attempts.request.limits, maxAttempts: 6 } } })
  assert.deepEqual(first.blockers.map(b => [b.category, b.step]), [['infrastructure', 'gate-1']])
  const second = await attempts.resume()
  assert.deepEqual(commands(await attempts.invocations()), [...upTo.collect, 'gate'], 'no attempt is left for the resumed run')
  assert.deepEqual(second.blockers.map(b => [b.category, b.step, b.reason]), [['budget', 'collect-1', 'attempt-budget-exhausted']])

  const wall = await project(t)
  wall.env.mode = 'gate-infra-once'
  let offset = 0
  const now = () => Date.now() + offset
  wall.env.hook = command => { if (command === process.execPath) offset += 300000 }
  const limits = { ...wall.request.limits, maxWallMs: 2400000 }
  const blocked = await wall.run({ now, request: { ...wall.request, limits } })
  assert.deepEqual(blocked.blockers.map(b => [b.category, b.step]), [['infrastructure', 'gate-1']])
  assert.ok(blocked.wallMs.used >= 1800000)
  const resumed = await wall.resume({ now })
  assert.deepEqual(resumed.blockers.map(b => [b.category, b.reason]), [['budget', 'wall-time-budget-exhausted']])
  assert.ok(resumed.wallMs.used >= 2400000 - 1000, 'the recorded 30 minutes count toward the 40-minute total')
})

test('resume refuses stale acceptance evidence and reruns everything after the installed verifier changes', async t => {
  const fixture = await project(t)
  const report = await fixture.run()
  assert.equal(report.state, 'human-required')
  const acceptance = []
  for (const criterion of report.acceptance.required) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, criterion, tree: git(fixture.root, 'rev-parse', 'refs/heads/main^{tree}'), status: 'pass' }))
    acceptance.push({ criterion, reference: (await retainExecutionArtifact({ common: fixture.common, runId: 'r1', kind: 'acceptance-evidence', bytes, retention })).reference })
  }
  const stale = await fixture.resume({ acceptance })
  assert.equal(stale.state, 'human-required')
  assert.deepEqual(stale.acceptance.missing, report.acceptance.required, 'evidence for another tree satisfies nothing')
  assert.ok(!commands(await fixture.invocations()).includes('finish'))

  const changed = await project(t)
  changed.env.mode = 'gate-infra-once'
  await changed.run()
  await writeFile(changed.cliPath, (await readFile(changed.cliPath, 'utf8')) + '\n// upgraded installed CLI\n')
  const rerun = await changed.resume()
  assert.deepEqual(commands(await changed.invocations()), [...upTo.collect, 'gate', ...upTo.collect, 'gate'], 'a changed verifier identity invalidates every prior observation')
  assert.deepEqual(rerun.steps.filter(step => step.status === 'reused'), [])
})

test('a controller killed during an agent step leaves an outcome-less attempt that resume will not redispatch', async t => {
  const fixture = await project(t)
  const { spawn } = await import('node:child_process')
  const runner = path.join(fixture.bin, 'runner.mjs')
  await writeFile(runner, `
import { executeWorkflowProfile } from ${JSON.stringify(new URL('../scripts/workflow-controller.mjs', import.meta.url).href)}
import { defaultExec } from ${JSON.stringify(new URL('../scripts/gate-runner.mjs', import.meta.url).href)}
const env = { FAKE_LOG: ${JSON.stringify(fixture.log)}, FAKE_MODE: 'hang-dispatch', FAKE_AUTH: 'ok', FAKE_TASKS: ${JSON.stringify(JSON.stringify(fixture.tasks))}, FAKE_RUN_BRANCH: 'fleetmates/run/r1' }
const executor = (command, cwd, options = {}) => command === 'codex'
  ? defaultExec(process.execPath, cwd, { ...options, argv: [${JSON.stringify(path.join(fixture.bin, 'codex.mjs'))}, ...options.argv], env })
  : defaultExec(command, cwd, { ...options, env: { ...options.env, ...env } })
await executeWorkflowProfile({ root: ${JSON.stringify(fixture.root)}, cliPath: ${JSON.stringify(fixture.cliPath)}, request: ${JSON.stringify(fixture.request)},
  environment: 'env.json', rolePolicy: 'roles.json', retention: ${JSON.stringify(retention)}, executor, verificationFactory: async () => ({ exec: defaultExec, close: async () => {} }) })
`)
  const child = spawn(process.execPath, [runner], { stdio: 'ignore' })
  const pidFile = path.join(fixture.bin, 'hang.pid')
  const deadline = Date.now() + 30000
  while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  const hung = Number(await readFile(pidFile, 'utf8'))
  child.kill('SIGKILL')
  await new Promise(resolve => child.once('exit', resolve))
  try { process.kill(-hung, 'SIGKILL') } catch { process.kill(hung, 'SIGKILL') }
  const resumed = await fixture.resume()
  assert.deepEqual(commands(await fixture.invocations()), upTo.implement, 'the interrupted dispatch is not started again')
  assert.deepEqual(resumed.blockers.map(b => [b.category, b.step]), [['unknown-effect', 'implement-1']])
  assert.match(resumed.blockers[0].reason, /no recorded outcome/)
})
