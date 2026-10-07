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
import { readExecutionEvents } from '../scripts/execution-journal.mjs'
import { resolveExecutionEffect } from '../scripts/execution-recovery.mjs'

// The child CLI is a real Node process started through the bounded executor. It stands in for the
// installed fleetmates CLI: it records every invocation, writes only the artifacts the real
// commands write, at the paths they write them, and follows their exit contracts: gate exits 1 on
// FAIL after printing its verdict block, and finish exits 4 while an agent check has no supplied result.
// It also implements the CLI contracts the audit plan assigns to T5 exactly as written there: gate
// exits 5 when only derive/run-state failed, dispatch takes `--execution <abs>` and
// `--fix-round --task <id>...`, and record-fix-round keeps its interface.
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
  // T5 contract: --execution names an absolute JSON file { version: 1, runId, attemptPrefix, journalRoot };
  // a relative path, a missing file or an unknown task exits 2 before anything is dispatched.
  const execution = flag('execution')
  if (execution !== undefined) {
    let contract = null
    try { contract = path.isAbsolute(execution) ? JSON.parse(readFileSync(execution, 'utf8')) : null } catch { contract = null }
    if (!contract || Object.keys(contract).sort().join() !== 'attemptPrefix,journalRoot,runId,version' || contract.version !== 1 || contract.runId !== run
        || typeof contract.attemptPrefix !== 'string' || typeof contract.journalRoot !== 'string' || !path.isAbsolute(contract.journalRoot)) { console.log('invalid --execution'); process.exit(2) }
    appendFileSync(path.join(bin, 'executions.jsonl'), JSON.stringify({ path: execution, contract }) + '\n')
  }
  const phase = Number(flag('phase')), fixRound = args.includes('--fix-round')
  const named = args.flatMap((arg, i) => arg === '--task' ? [args[i + 1]] : [])
  const phaseTasks = tasks.filter(t => t.phase === phase)
  if (fixRound && (!named.length || named.some(id => !phaseTasks.some(t => t.id === id)))) { console.log('unknown task'); process.exit(2) }
  if (mode.includes('hang-dispatch')) { writeFileSync(path.join(bin, 'hang.pid'), String(process.pid)); setInterval(() => {}, 1000) }
  else {
    const runTip = git(['rev-parse', 'refs/heads/' + process.env.FAKE_RUN_BRANCH])
    mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    // --fix-round dispatches only the named tasks, on top of their current tips, even over a done result.
    for (const t of fixRound ? phaseTasks.filter(t => named.includes(t.id)) : phaseTasks) {
      const branch = 'fleetmates/' + run + '/' + t.id
      let tip
      if (fixRound) tip = commit(mode.includes('fix-resets') ? runTip : git(['rev-parse', 'refs/heads/' + branch]), t.file, t.id + ' fixed\n', 'fix: ' + t.id)
      else tip = mode.includes('empty-branch') ? runTip : commit(runTip, t.file, t.id + '\n', 'feat: ' + t.id)
      if (mode.includes('extra-file')) tip = commit(tip, 'undeclared.txt', 'outside\n', 'feat: outside the declared set')
      git(['update-ref', 'refs/heads/' + branch, tip])
      if (!mode.includes('no-result')) writeFileSync(path.join(dir, 'sessions', t.id + '.result.json'),
        JSON.stringify({ status: 'done', branch: mode.includes('wrong-branch') ? 'fleetmates/' + run + '/other' : branch, filesChanged: [t.file], summary: 'fixture', blockers: [] }))
    }
    if (mode.includes('hang-after-dispatch') && !fixRound) { writeFileSync(path.join(bin, 'hang.pid'), String(process.pid)); setInterval(() => {}, 1000) }
    else console.log('dispatched')
  }
} else if (command === 'record-fix-round') {
  const phase = Number(flag('phase')), task = flag('task'), file = path.join(bin, 'rounds.json')
  if (!tasks.some(t => t.id === task && t.phase === phase)) { console.log('no task ' + task + ' in phase ' + phase); process.exit(1) }
  const rounds = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  rounds[task] = (rounds[task] ?? 0) + 1
  writeFileSync(file, JSON.stringify(rounds))
  console.log(task + ' phase ' + phase + ' round ' + rounds[task])
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
  // T5 contract: exit 5 when the only failed entries are derive and/or run-state.
  if (mode.includes('gate-state')) {
    console.log(JSON.stringify({ verdict: 'FAIL', failed: ['run-state'], error: 'could not read run state' }, null, 2))
    process.exit(5)
  }
  const unfixed = mode.includes('gate-until-fixed')
    && tasks.filter(t => t.phase === Number(flag('phase')) && (process.env.FAKE_RETRY ?? t.id).split(',').includes(t.id)).some(t => !git(['show', 'refs/heads/fleetmates/' + run + '/' + t.id + ':' + t.file]).includes('fixed'))
  if (mode.includes('gate-fails') || unfixed) {
    console.log('gate: running 1 command check')
    console.log(JSON.stringify({ verdict: 'FAIL', failed: ['behavior'], phase: Number(flag('phase')), results: [{ name: 'behavior', kind: 'command', status: 'fail' }] }, null, 2))
    process.exit(1)
  }
  console.log('PASS')
} else if (command === 'fix') {
  const verdict = JSON.parse(readFileSync(flag('verdict'), 'utf8'))
  writeFileSync(path.join(bin, 'verdict-seen.json'), JSON.stringify(verdict))
  // The budget rule of decideFix: a task whose recorded rounds reach the manifest fixRounds escalates.
  const file = path.join(bin, 'rounds.json'), rounds = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const budget = JSON.parse(readFileSync(path.join(root, 'fleetmates.gate.json'), 'utf8')).phases.default.fixRounds
  const retried = tasks.filter(t => t.phase === Number(flag('phase')) && (process.env.FAKE_RETRY ?? t.id).split(',').includes(t.id))
  const over = retried.find(t => (rounds[t.id] ?? 0) >= budget)
  console.log(JSON.stringify(mode.includes('fix-escalate') ? { decision: 'escalate', tasks: [], reason: 'process-violation', check: 'fileset' }
    : over ? { decision: 'escalate', tasks: [], reason: 'budget-exhausted', taskId: over.id }
    : { decision: 'retry', tasks: retried.map(t => ({ taskId: t.id, tier: 'mid', round: (rounds[t.id] ?? 0) + 1, checks: verdict.results.filter(r => r.status === 'fail').map(r => r.name) })), reason: null }, null, 2))
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
  const executor = async (command, cwd, options = {}) => {
    calls.push({ command, argv: options.argv ?? null })
    await env.hook?.(command, options)
    const fixtureEnv = { FAKE_LOG: log, FAKE_MODE: env.mode, FAKE_AUTH: env.auth, FAKE_TASKS: JSON.stringify(tasks), FAKE_RUN_BRANCH: 'fleetmates/run/r1',
      ...(env.retry ? { FAKE_RETRY: env.retry } : {}) }
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
    assert.deepEqual(seen.find(e => e.command === 'dispatch').args.slice(-8, -4), ['--environment', 'env.json', '--role-policy', 'roles.json'])
    assert.equal(seen.find(e => e.command === 'dispatch').args.at(-4), '--execution')
    assert.deepEqual(seen.find(e => e.command === 'dispatch-reviews').args.slice(-6, -2), ['--environment', 'env.json', '--role-policy', 'roles.json'])
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

const firstPass = ['init-run', 'preview-check', 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate']
const repairRound = ['fix', 'record-fix-round', 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate']

test('gate exit 5 is an infrastructure stop and never reaches the fix decision; exit 1 is a code failure', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'gate-state'
  const report = await fixture.run()
  assert.deepEqual(commands(await fixture.invocations()), firstPass)
  assert.equal(report.state, 'blocked')
  assert.deepEqual(report.blockers.map(b => [b.category, b.step, b.reason]), [['infrastructure', 'gate-1', 'exit 5']])
  assert.equal(report.repair, undefined)

  const failing = await project(t)
  failing.env.mode = 'gate-fails fix-escalate'
  const code = await failing.run()
  assert.deepEqual(code.blockers.map(b => [b.category, b.step]), [['code', 'gate-1']])
})

test('a retry decision records each round, redispatches only the named tasks with --fix-round and reruns review, collect and gate to a pass', async t => {
  const fixture = await project(t, { tasks: [{ id: 'T1', phase: 1, file: 'a.txt' }, { id: 'T2', phase: 1, file: 'b.txt' }] })
  fixture.env.mode = 'gate-until-fixed'
  fixture.env.retry = 'T1'
  const report = await fixture.run()
  const seen = await fixture.invocations()
  assert.deepEqual(commands(seen), [...firstPass, ...repairRound])
  assert.deepEqual(seen.find(e => e.command === 'record-fix-round').args, ['record-fix-round', '--run', 'r1', '--phase', '1', '--task', 'T1', '--root', fixture.root])
  const repair = seen.filter(e => e.command === 'dispatch')[1].args
  assert.deepEqual(repair.slice(0, 5), ['dispatch', '--run', 'r1', '--phase', '1'])
  assert.deepEqual(repair.slice(repair.indexOf('--fix-round'), repair.indexOf('--fix-round') + 3), ['--fix-round', '--task', 'T1'])
  assert.equal(repair.filter(arg => arg === '--task').length, 1, 'only the task the fix decision named is redispatched')
  assert.equal(report.state, 'human-required', report.blockers.map(b => b.reason).join('; '))
  assert.deepEqual(report.blockers, [])
  assert.deepEqual(report.repair.rounds, [{ phase: 1, round: 1, tasks: ['T1'] }])
  for (const id of ['repair-1.r1', 'review-1.r1', 'collect-1.r1', 'gate-1.r1', 'integrate-1.r1']) {
    assert.equal(report.steps.find(step => step.id === id)?.status, 'completed', id)
  }
  assert.equal(git(fixture.root, 'show', 'refs/heads/fleetmates/run/r1:a.txt'), 'T1 fixed')
  assert.equal(git(fixture.root, 'show', 'refs/heads/fleetmates/run/r1:b.txt'), 'T2')
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.bin, 'rounds.json'), 'utf8')), { T1: 1 })
})

test('a repair round that does not build on the reviewed task tip stops before review', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'gate-fails fix-resets'
  const report = await fixture.run()
  assert.deepEqual(commands(await fixture.invocations()), [...firstPass, 'fix', 'record-fix-round', 'dispatch'])
  assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [['changed-input', 'repair-1.r1']])
  assert.match(report.blockers[0].reason, /did not advance from the reviewed tip/)
})

test('escalation and exhausted repair budgets stop failed with the existing reasons', async t => {
  const escalated = await project(t)
  escalated.env.mode = 'gate-fails fix-escalate'
  const stopped = await escalated.run()
  const seen = await escalated.invocations()
  assert.deepEqual(commands(seen), [...firstPass, 'fix'])
  assert.deepEqual(seen.at(-1).args.slice(0, 7), ['fix', '--run', 'r1', '--phase', '1', '--verdict', path.join(escalated.root, '.fleetmates/r1/profile-verdict-1.json')])
  assert.deepEqual(JSON.parse(await readFile(path.join(escalated.bin, 'verdict-seen.json'), 'utf8')).results, [{ name: 'behavior', kind: 'command', status: 'fail' }],
    'the verdict block printed by gate exit 1 reached fix')
  assert.equal(stopped.state, 'failed')
  assert.deepEqual(stopped.blockers.map(b => [b.category, b.step, b.reason]), [['code', 'gate-1', 'fix-escalated: process-violation']])
  assert.equal(stopped.repair.decision.decision, 'escalate')

  // The fix budget (manifest fixRounds 1) allows one round; the second failure escalates.
  const exhausted = await project(t)
  exhausted.env.mode = 'gate-fails'
  const spent = await exhausted.run()
  assert.deepEqual(commands(await exhausted.invocations()), [...firstPass, ...repairRound, 'fix'])
  assert.equal(spent.state, 'failed')
  assert.deepEqual(spent.blockers.map(b => [b.category, b.step, b.reason]), [['code', 'gate-1.r1', 'fix-escalated: budget-exhausted']])

  // The request bound is the other half of the minimum: maxRepairRounds 0 delivers no round at all,
  // and maxRepairRounds 1 under a fix budget of 3 stops after one round although fix would retry.
  const none = await project(t, { fixRounds: 3 })
  none.env.mode = 'gate-fails'
  const zero = await none.run({ request: { ...none.request, limits: { ...none.request.limits, maxRepairRounds: 0 } } })
  assert.deepEqual(commands(await none.invocations()), [...firstPass, 'fix'])
  assert.deepEqual(zero.blockers.map(b => [b.category, b.step]), [['code', 'gate-1']])
  assert.match(zero.blockers[0].reason, /^budget-exhausted: maxRepairRounds 0/)
  assert.equal(zero.state, 'failed')
  const one = await project(t, { fixRounds: 3 })
  one.env.mode = 'gate-fails'
  const limited = await one.run({ request: { ...one.request, limits: { ...one.request.limits, maxRepairRounds: 1 } } })
  assert.deepEqual(commands(await one.invocations()), [...firstPass, ...repairRound, 'fix'])
  assert.deepEqual(limited.blockers.map(b => [b.category, b.step]), [['code', 'gate-1.r1']])
  assert.match(limited.blockers[0].reason, /^budget-exhausted: maxRepairRounds 1/)
  assert.equal(limited.repair.decision.decision, 'retry')
  // Rounds recorded before this execution count too: a decision whose round exceeds the bound stops.
  const earlier = await project(t, { fixRounds: 3 })
  earlier.env.mode = 'gate-fails'
  await writeFile(path.join(earlier.bin, 'rounds.json'), JSON.stringify({ T1: 1 }))
  const spentBefore = await earlier.run({ request: { ...earlier.request, limits: { ...earlier.request.limits, maxRepairRounds: 1 } } })
  assert.deepEqual(commands(await earlier.invocations()), [...firstPass, 'fix'])
  assert.deepEqual(spentBefore.blockers.map(b => [b.category, b.step]), [['code', 'gate-1']])
  assert.match(spentBefore.blockers[0].reason, /^budget-exhausted: maxRepairRounds 1, fix budget 1, 0 round/)

  // A retry that names no task of the failing phase is not dispatched at all.
  const unnamed = await project(t)
  unnamed.env.mode = 'gate-fails'
  unnamed.env.retry = 'T9'
  const nobody = await unnamed.run()
  assert.deepEqual(commands(await unnamed.invocations()), [...firstPass, 'fix'])
  assert.deepEqual(nobody.blockers.map(b => [b.category, b.step]), [['infrastructure', 'fix-1']])
  assert.match(nobody.blockers[0].reason, /names no valid task/)

  // A rejected host gate is a code failure too: it gets the same round, and nothing merges.
  const hostGate = await project(t, { required: ['missing.txt'] })
  const rejected = await hostGate.run()
  assert.deepEqual(commands(await hostGate.invocations()), [...firstPass, ...repairRound, 'fix'])
  assert.deepEqual(rejected.blockers.map(b => [b.category, b.step, b.reason]), [['code', 'integrate-1.r1', 'fix-escalated: budget-exhausted']])
  assert.ok(JSON.parse(await readFile(path.join(hostGate.bin, 'verdict-seen.json'), 'utf8')).results.some(r => r.name === 'behavior' && r.status === 'fail'))
  assert.equal(git(hostGate.root, 'rev-parse', 'refs/heads/fleetmates/run/r1'), git(hostGate.root, 'rev-parse', 'refs/heads/main'), 'a rejected host gate merges nothing')
})

test('resume continues in the recorded repair round: its record and dispatch are reused and only the verdicts rerun', async t => {
  const fixture = await project(t, { fixRounds: 3 })
  fixture.env.mode = 'gate-fails'
  const limits = { ...fixture.request.limits, maxRepairRounds: 1 }
  const first = await fixture.run({ request: { ...fixture.request, limits } })
  assert.deepEqual(first.blockers.map(b => [b.category, b.step]), [['code', 'gate-1.r1']])
  const seen = (await fixture.invocations()).length
  fixture.env.mode = 'gate-until-fixed'
  const resumed = await fixture.resume()
  assert.deepEqual(commands(await fixture.invocations()).slice(seen), ['collect-reviews', 'gate'], 'no second record-fix-round and no second dispatch')
  assert.equal(resumed.state, 'human-required', resumed.blockers.map(b => b.reason).join('; '))
  assert.deepEqual(resumed.steps.filter(step => step.status === 'reused').map(step => step.id),
    ['prepare', 'baseline', 'record-1.r1.T1', 'repair-1.r1', 'review-1.r1'])
  assert.deepEqual(resumed.steps.filter(step => step.status === 'completed').map(step => step.id), ['collect-1.r1', 'gate-1.r1', 'integrate-1.r1'])
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.bin, 'rounds.json'), 'utf8')), { T1: 1 })
  assert.equal(git(fixture.root, 'show', 'refs/heads/fleetmates/run/r1:a.txt'), 'T1 fixed')
})

test('budgets stop before spawning', async t => {
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
    // The controller appends --execution, --fix-round and --task itself; a committed fragment cannot
    // carry them, and no other flag outside a command's fixed set is accepted.
    tamper(p => { p.steps.find(s => s.id === 'implement-1').argv.push('--execution', '/elsewhere/contract.json') }),
    tamper(p => { p.steps.find(s => s.id === 'implement-1').argv.push('--fix-round') }),
    tamper(p => { p.steps.find(s => s.id === 'implement-1').argv.push('--task', 'T1') }),
    tamper(p => { p.steps.find(s => s.id === 'review-1').argv.push('--execution', '/elsewhere/contract.json') }),
    tamper(p => { p.steps.find(s => s.id === 'gate-1').argv.push('--yes') }),
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

test('resume refuses stale acceptance evidence, reruns every deterministic step after the installed verifier changes and revalidates completed dispatches', async t => {
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
  // A changed verifier identity invalidates every prior deterministic observation, so those rerun.
  // The two dispatches recorded completed agent-dispatch effects, which the journal will not start
  // again under the same step: their outputs are revalidated against the current tree and reused.
  assert.deepEqual(commands(await changed.invocations()), [...upTo.collect, 'gate', 'init-run', 'preview-check', 'collect-reviews', 'gate'])
  assert.deepEqual(rerun.steps.filter(step => step.status === 'reused').map(step => [step.id, step.revalidated]), [['implement-1', 'completed'], ['review-1', 'completed']])
  assert.equal(rerun.state, 'human-required', rerun.blockers.map(b => b.reason).join('; '))
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

// Starts the controller in its own process with the fake CLI in `mode`, waits until the dispatch
// child is hanging, then kills the controller and that child: the dispatch has no recorded outcome.
async function killDuringDispatch(fixture, mode) {
  const { spawn } = await import('node:child_process')
  const runner = path.join(fixture.bin, 'runner.mjs')
  await writeFile(runner, `
import { executeWorkflowProfile } from ${JSON.stringify(new URL('../scripts/workflow-controller.mjs', import.meta.url).href)}
import { defaultExec } from ${JSON.stringify(new URL('../scripts/gate-runner.mjs', import.meta.url).href)}
const env = { FAKE_LOG: ${JSON.stringify(fixture.log)}, FAKE_MODE: ${JSON.stringify(mode)}, FAKE_AUTH: 'ok', FAKE_TASKS: ${JSON.stringify(JSON.stringify(fixture.tasks))}, FAKE_RUN_BRANCH: 'fleetmates/run/r1' }
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
  await rm(pidFile)
  const events = await readExecutionEvents(fixture.common, 'r1')
  const effect = events.find(e => e.step === 'implement-1' && e.kind === 'effect-started')
  assert.ok(effect, 'the agent-dispatch effect start was persisted before the dispatch was spawned')
  assert.ok(!events.some(e => e.step === 'implement-1' && ['effect-completed', 'effect-failed', 'effect-unknown', 'step-completed', 'step-failed'].includes(e.kind)))
  return effect.effect.id
}

test('agent steps are journaled as agent-dispatch effects: the start persists before the spawn and the outcome after', async t => {
  const fixture = await project(t)
  const atSpawn = []
  fixture.env.hook = async (command, options) => {
    if (!['dispatch', 'dispatch-reviews'].includes(options.argv?.[1])) return
    const effects = (await readExecutionEvents(fixture.common, 'r1')).filter(e => e.effect)
    atSpawn.push(effects.map(e => [e.step, e.kind, e.effect.kind]).at(-1))
  }
  const report = await fixture.run()
  assert.equal(report.state, 'human-required')
  assert.deepEqual(atSpawn, [['implement-1', 'effect-started', 'agent-dispatch'], ['review-1', 'effect-started', 'agent-dispatch']])
  const events = await readExecutionEvents(fixture.common, 'r1')
  for (const step of ['implement-1', 'review-1']) {
    assert.deepEqual(events.filter(e => e.step === step).map(e => e.kind), ['step-started', 'effect-started', 'effect-completed', 'step-completed'], step)
  }
  for (const step of ['prepare', 'baseline', 'collect-1', 'gate-1', 'integrate-1']) assert.ok(events.filter(e => e.step === step).every(e => !e.effect), step)
})

test('every dispatch argv ends with --execution naming the contract file the controller wrote; no other command gets it', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'gate-until-fixed'
  const report = await fixture.run()
  assert.equal(report.state, 'human-required', report.blockers.map(b => b.reason).join('; '))
  const seen = await fixture.invocations()
  const dispatches = seen.filter(e => e.command === 'dispatch')
  assert.equal(dispatches.length, 2)
  const prefixes = []
  for (const entry of dispatches) {
    assert.equal(entry.args.filter(arg => arg === '--execution').length, 1)
    assert.deepEqual(entry.args.slice(-4, -3), ['--execution'])
    const file = entry.args.at(-3)
    assert.ok(path.isAbsolute(file) && file.startsWith(path.join(fixture.root, '.fleetmates', 'r1') + path.sep), file)
    const contract = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(Object.keys(contract).sort(), ['attemptPrefix', 'journalRoot', 'runId', 'version'])
    assert.equal(contract.version, 1); assert.equal(contract.runId, 'r1')
    assert.equal(contract.journalRoot, await realpath(fixture.common))
    prefixes.push(contract.attemptPrefix)
  }
  assert.deepEqual(prefixes, ['implement-1.1', 'repair-1.r1.1'])
  assert.ok(seen.filter(e => e.command !== 'dispatch').every(e => !e.args.includes('--execution')))
})

test('an interrupted agent dispatch resolved not-started is redispatched on resume', async t => {
  const fixture = await project(t)
  const effectId = await killDuringDispatch(fixture, 'hang-dispatch')
  await resolveExecutionEffect({ common: fixture.common, runId: 'r1', effectId, resolution: 'not-started', reason: 'operator-saw-no-session' })
  const resumed = await fixture.resume()
  assert.deepEqual(commands(await fixture.invocations()), [...upTo.implement, 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate'])
  assert.equal(resumed.state, 'human-required', resumed.blockers.map(b => b.reason).join('; '))
  assert.equal(resumed.steps.find(step => step.id === 'implement-1').status, 'completed')
})

test('an interrupted agent dispatch resolved completed is validated and reused, and refused when its outputs do not validate', async t => {
  const fixture = await project(t)
  const effectId = await killDuringDispatch(fixture, 'hang-after-dispatch')
  await resolveExecutionEffect({ common: fixture.common, runId: 'r1', effectId, resolution: 'completed', reason: 'operator-saw-results' })
  const resumed = await fixture.resume()
  assert.deepEqual(commands(await fixture.invocations()), [...upTo.implement, 'dispatch-reviews', 'collect-reviews', 'gate'], 'the completed dispatch is not started again')
  assert.equal(resumed.state, 'human-required', resumed.blockers.map(b => b.reason).join('; '))
  const reused = resumed.steps.find(step => step.id === 'implement-1')
  assert.equal(reused.status, 'reused')
  assert.ok(reused.artifacts.some(a => a.kind === 'task-result'))
  assert.ok((await readExecutionEvents(fixture.common, 'r1')).some(e => e.step === 'implement-1' && e.kind === 'step-completed'), 'the interrupted attempt is closed with its validated outputs')

  const empty = await project(t)
  const noWork = await killDuringDispatch(empty, 'hang-dispatch')
  await resolveExecutionEffect({ common: empty.common, runId: 'r1', effectId: noWork, resolution: 'completed', reason: 'operator-mistake' })
  const refused = await empty.resume()
  assert.deepEqual(commands(await empty.invocations()), upTo.implement)
  assert.deepEqual(refused.blockers.map(b => [b.category, b.step]), [['missing-artifact', 'implement-1']])
  assert.match(refused.blockers[0].reason, /resolved completed/)
})

test('a run suspended or abandoned before completion is reported in that state and never as complete', async t => {
  for (const marker of ['suspended', 'abandoned']) {
    const fixture = await project(t)
    const report = await fixture.run()
    assert.equal(report.state, 'human-required')
    const acceptance = []
    for (const criterion of report.acceptance.required) {
      const bytes = Buffer.from(JSON.stringify({ version: 1, criterion, tree: report.acceptance.tree, status: 'pass' }))
      acceptance.push({ criterion, reference: (await retainExecutionArtifact({ common: fixture.common, runId: 'r1', kind: 'acceptance-evidence', bytes, retention })).reference })
    }
    fixture.env.hook = (command, options) => { if (options.argv?.[1] === 'finish') git(fixture.root, 'update-ref', `refs/fleetmates/r1/${marker}`, 'HEAD') }
    const done = await fixture.resume({ acceptance })
    assert.equal(commands(await fixture.invocations()).at(-1), 'finish')
    assert.equal(done.state, marker)
    assert.equal(done.verifiedComplete, false)
    assert.equal(done.obligations.verifiedComplete, false, `a ${marker} lifecycle never verifies the obligations`)
    assert.equal(done.obligations.state, marker)
  }
})

test('request bounds are pinned at both edges: n is accepted and n+1 is refused before any executor call', async t => {
  const fixture = await project(t)
  fixture.env.auth = 'none'
  let n = 0
  const attempt = request => fixture.run({ request: { ...fixture.request, runId: `b${n++}`, ...request } })
  const limits = fixture.request.limits
  const pad = bytes => ({ pad: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify({ pad: '' }))) })
  const edges = [
    ['maxAttempts', { limits: { ...limits, maxAttempts: 500 } }, { limits: { ...limits, maxAttempts: 501 } }],
    ['maxAttempts low', { limits: { ...limits, maxAttempts: 1 } }, { limits: { ...limits, maxAttempts: 0 } }],
    ['maxWallMs', { limits: { ...limits, maxWallMs: 86_400_000 } }, { limits: { ...limits, maxWallMs: 86_400_001 } }],
    ['maxWallMs low', { limits: { ...limits, maxWallMs: 1000 } }, { limits: { ...limits, maxWallMs: 999 } }],
    ['stepTimeoutMs', { limits: { ...limits, stepTimeoutMs: 21_600_000 } }, { limits: { ...limits, stepTimeoutMs: 21_600_001 } }],
    ['stepTimeoutMs low', { limits: { ...limits, stepTimeoutMs: 1000 } }, { limits: { ...limits, stepTimeoutMs: 999 } }],
    ['maxRepairRounds', { limits: { ...limits, maxRepairRounds: 10 } }, { limits: { ...limits, maxRepairRounds: 11 } }],
    ['maxRepairRounds low', { limits: { ...limits, maxRepairRounds: 0 } }, { limits: { ...limits, maxRepairRounds: -1 } }],
    ['parameters', { parameters: pad(4096) }, { parameters: pad(4097) }],
  ]
  for (const [label, accepted, refused] of edges) {
    fixture.calls.length = 0
    await assert.rejects(attempt(refused), /Invalid workflow request/, label)
    assert.deepEqual(fixture.calls, [], label)
    const report = await attempt(accepted)
    assert.deepEqual(report.blockers.map(b => b.category), ['capability'], label)
  }
  assert.equal(Buffer.byteLength(JSON.stringify(pad(4096))), 4096)
})
