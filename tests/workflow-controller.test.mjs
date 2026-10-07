import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { executeWorkflowProfile, resumeWorkflowProfile, validateWorkflowExpansion } from '../scripts/workflow-controller.mjs'
import { expandWorkflowProfile } from '../scripts/workflow-profile.mjs'
import { createHash } from 'node:crypto'
import { defaultExec } from '../scripts/gate-runner.mjs'
import { retainExecutionArtifact } from '../scripts/execution-artifacts.mjs'

// The child CLI is a real Node process started through the bounded executor. It stands in for the
// installed fleetmates CLI: it records every invocation, and writes only the artifacts the real
// commands write, at the paths they write them, so the controller's dependency checks see files.
const FAKE_CLI = String.raw`
import { appendFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const args = process.argv.slice(2), command = args[0]
const flag = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1] }
const root = flag('root'), run = flag('run'), mode = process.env.FAKE_MODE ?? ''
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command, args, script: process.argv[1], cwd: process.cwd() }) + '\n')
const git = (a, options = {}) => execFileSync('git', a, { cwd: root, encoding: 'utf8', ...options }).trim()
const dir = path.join(root, '.fleetmates', run ?? 'none'), tasks = JSON.parse(process.env.FAKE_TASKS)
const once = name => { const file = path.join(path.dirname(process.env.FAKE_LOG), name); if (existsSync(file)) return false; writeFileSync(file, ''); return true }
const tips = phase => Object.fromEntries(tasks.filter(t => t.phase === phase).map(t => ['fleetmates/' + run + '/' + t.id, git(['rev-parse', 'refs/heads/fleetmates/' + run + '/' + t.id])]))
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
    const index = path.join(path.dirname(process.env.FAKE_LOG), 'move-index')
    git(['read-tree', base], { env: { ...process.env, GIT_INDEX_FILE: index } })
    const blob = git(['hash-object', '-w', '--stdin'], { input: 'changed plan\n' })
    git(['update-index', '--add', '--cacheinfo', '100644,' + blob + ',plan.md'], { env: { ...process.env, GIT_INDEX_FILE: index } })
    const tree = git(['write-tree'], { env: { ...process.env, GIT_INDEX_FILE: index } })
    git(['update-ref', 'refs/heads/main', git(['commit-tree', tree, '-p', base, '-m', 'docs: change plan'])])
  }
  console.error('preview ok on stderr')
  console.log('preview ok')
} else if (command === 'dispatch') {
  if (mode.includes('hang-dispatch')) setInterval(() => {}, 1000)
  else {
    const phase = Number(flag('phase')), runTip = git(['rev-parse', 'refs/heads/' + process.env.FAKE_RUN_BRANCH])
    mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    for (const t of tasks.filter(t => t.phase === phase)) {
      const branch = 'fleetmates/' + run + '/' + t.id, index = path.join(path.dirname(process.env.FAKE_LOG), 'index-' + t.id)
      const env = { ...process.env, GIT_INDEX_FILE: index }
      git(['read-tree', runTip], { env })
      git(['update-index', '--add', '--cacheinfo', '100644,' + git(['hash-object', '-w', '--stdin'], { input: t.id + '\n' }) + ',' + t.file], { env })
      git(['update-ref', 'refs/heads/' + branch, git(['commit-tree', git(['write-tree'], { env }), '-p', runTip, '-m', 'feat: ' + t.id])])
      rmSync(index, { force: true })
      if (!mode.includes('no-result')) writeFileSync(path.join(dir, 'sessions', t.id + '.result.json'),
        JSON.stringify({ status: 'done', branch, filesChanged: [t.file], summary: 'fixture', blockers: [] }))
    }
    console.log('dispatched')
  }
} else if (command === 'dispatch-reviews') {
  const phase = Number(flag('phase')), branchShas = tips(phase)
  mkdirSync(path.join(dir, 'reviews'), { recursive: true })
  const names = Object.keys(branchShas).sort()
  writeFileSync(path.join(dir, 'reviews', phase + '-correctness.json'), JSON.stringify({ stamp: { phase: String(phase), lens: 'correctness',
    branches: names.map(n => n + '@' + (mode.includes('stale-review') ? '0'.repeat(40) : branchShas[n])) }, findings: [] }))
  console.log('reviews dispatched')
} else if (command === 'collect-reviews') {
  const phase = flag('phase'), file = path.join(dir, 'reviews', 'results-' + phase + '.json')
  const document = JSON.stringify({ results: [{ name: 'review', kind: 'agent', status: mode.includes('review-blocks') ? 'fail' : 'pass', findings: [] }] }, null, 2)
  console.log(document)
  if (mode.includes('decoy-path')) {
    const decoy = path.join(path.dirname(process.env.FAKE_LOG), 'decoy.json')
    writeFileSync(decoy, document + '\n')
    writeFileSync(file, document + '\n')
    console.log('results written to ' + decoy + ' — pass that path to gate --results')
  } else if (mode.includes('file-without-line')) writeFileSync(file, document + '\n')
  else if (!mode.includes('stdout-only')) {
    writeFileSync(file, document + '\n')
    console.log('results written to ' + file + ' — pass that path to gate --results')
  }
} else if (command === 'gate') {
  if (mode.includes('gate-infra-once') && once('gate-infra')) { console.log('cannot verify'); process.exit(4) }
  if (mode.includes('gate-fails')) { console.log('FAIL'); process.exit(3) }
  console.log('PASS')
} else if (command === 'finish') console.log('finished')
else process.exit(2)
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
  return { root, base, cliPath, log, calls, env, executor, invocations, request, run, resume, tasks }
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

test('code failures consume the existing repair budget and then fail; budgets stop before spawning', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'gate-fails'
  const report = await fixture.run()
  assert.deepEqual(commands(await fixture.invocations()), ['init-run', 'preview-check',
    'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate', 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate'])
  assert.equal(report.state, 'failed')
  assert.deepEqual(report.blockers.map(b => [b.category, b.step, b.reason]), [['code', 'gate-1', 'repair-budget-exhausted']])
  assert.equal(report.repairs['1'], 1)

  const hostGate = await project(t, { required: ['missing.txt'] })
  const rejected = await hostGate.run()
  assert.deepEqual(commands(await hostGate.invocations()), ['init-run', 'preview-check',
    'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate', 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate'])
  assert.deepEqual(rejected.blockers.map(b => [b.category, b.step, b.reason]), [['code', 'integrate-1', 'repair-budget-exhausted']])
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
})
