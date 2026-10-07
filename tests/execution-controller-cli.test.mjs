import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath, symlink, chmod, access } from 'node:fs/promises'
import { existsSync, readFileSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { runCli, workflowCommand, integratorMergeSubject } from '../scripts/cli.mjs'
import { defaultExec } from '../scripts/gate-runner.mjs'
import { readExecutionEvents, appendExecutionEvent } from '../scripts/execution-journal.mjs'
import { executeWorkflowProfile } from '../scripts/workflow-controller.mjs'
import { getAdapter } from '../scripts/harnesses/index.mjs'

// The CLI surface for bounded workflow execution: workflow-execute, workflow-resume,
// workflow-status and workflow-resolve. Executed runs go through the exported `workflowCommand`
// with a substituted host (a fake installed CLI and a recording executor), because the trusted
// host of `runCli` is the real installed CLI, whose `dispatch` would start a real harness.
// Every `runCli` call below either refuses before the controller is reached or reads only.

const CLI_FILE = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))
const GATE_RUNNER_FILE = fileURLToPath(new URL('../scripts/gate-runner.mjs', import.meta.url))

// Stands in for the installed fleetmates CLI: records each invocation, writes only what the real
// commands write, where they write it, and follows their exit contracts. `gate-derive` prints the
// document the real gate prints when it cannot derive run state, and exits 5 as the real one does
// (pinned against the real gate in tests/cli.test.mjs).
const FAKE_CLI = String.raw`
import { appendFileSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
const args = process.argv.slice(2), command = args[0]
const flag = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1] }
const root = flag('root'), run = flag('run'), mode = process.env.FAKE_MODE ?? ''
const bin = path.dirname(process.env.FAKE_LOG)
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command, args }) + '\n')
const git = (a, options = {}) => execFileSync('git', a, { cwd: root, encoding: 'utf8', ...options }).trim()
const dir = path.join(root, '.fleetmates', run ?? 'none'), tasks = JSON.parse(process.env.FAKE_TASKS)
const commit = (parent, file, content, message) => {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(bin, 'index-' + process.pid) }
  git(['read-tree', parent], { env })
  git(['update-index', '--add', '--cacheinfo', '100644,' + git(['hash-object', '-w', '--stdin'], { input: content }) + ',' + file], { env })
  const sha = git(['commit-tree', git(['write-tree'], { env }), '-p', parent, '-m', message])
  rmSync(env.GIT_INDEX_FILE, { force: true })
  return sha
}
const tips = phase => Object.fromEntries(tasks.filter(t => t.phase === phase).map(t => ['fleetmates/' + run + '/' + t.id, git(['rev-parse', 'refs/heads/fleetmates/' + run + '/' + t.id])]))
if (command === 'init-run') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ runId: run, runBranch: process.env.FAKE_RUN_BRANCH, planPath: args[1],
    tasks: tasks.map(t => ({ id: t.id, phase: t.phase, files: [t.file] })) }))
  console.log('phase 1: T1')
} else if (command === 'preview-check') {
  console.log('preview ok')
} else if (command === 'dispatch') {
  if (mode.includes('hang-dispatch')) { writeFileSync(path.join(bin, 'hang.pid'), String(process.pid)); setInterval(() => {}, 1000) }
  else {
    const phase = Number(flag('phase')), runTip = git(['rev-parse', 'refs/heads/' + process.env.FAKE_RUN_BRANCH])
    // --fix-round --task <id>... redispatches only the named tasks, on top of their current tips.
    const fixRound = args.includes('--fix-round'), named = args.flatMap((arg, i) => arg === '--task' ? [args[i + 1]] : [])
    mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    for (const t of tasks.filter(t => t.phase === phase && (!fixRound || named.includes(t.id)))) {
      const branch = 'fleetmates/' + run + '/' + t.id
      const parent = fixRound ? git(['rev-parse', 'refs/heads/' + branch]) : runTip
      git(['update-ref', 'refs/heads/' + branch, commit(parent, t.file, t.id + (fixRound ? ' fixed' : '') + '\n', (fixRound ? 'fix: ' : 'feat: ') + t.id)])
      writeFileSync(path.join(dir, 'sessions', t.id + '.result.json'),
        JSON.stringify({ status: 'done', branch, filesChanged: [t.file], summary: 'fixture', blockers: [] }))
    }
    console.log('dispatched')
  }
} else if (command === 'dispatch-reviews') {
  const phase = Number(flag('phase')), branchShas = tips(phase)
  mkdirSync(path.join(dir, 'reviews'), { recursive: true })
  const names = Object.keys(branchShas).sort()
  writeFileSync(path.join(dir, 'reviews', phase + '-correctness.json'), JSON.stringify({ stamp: { phase: String(phase), lens: 'correctness',
    branches: names.map(n => n + '@' + branchShas[n]) }, findings: [] }))
  console.log('reviews dispatched')
} else if (command === 'collect-reviews') {
  const file = path.join(dir, 'reviews', 'results-' + flag('phase') + '.json')
  writeFileSync(file, JSON.stringify({ results: [{ name: 'review', kind: 'agent', status: 'pass', findings: [] }] }, null, 2) + '\n')
  console.log('results written to ' + file + ' — pass that path to gate --results')
} else if (command === 'gate') {
  // The audit plan's gate contract: a FAIL whose only failed entries are derive and/or run-state exits 5.
  if (mode.includes('gate-run-state')) {
    console.log(JSON.stringify({ verdict: 'FAIL', failed: ['run-state'], phase: Number(flag('phase')), error: 'could not read run state: Unexpected token',
      results: [{ name: 'behavior', kind: 'command', status: 'pass' }] }, null, 2))
    process.exit(5)
  }
  if (mode.includes('gate-derive')) {
    console.log(JSON.stringify({ verdict: 'FAIL', failed: ['derive'], error: 'plan.md is not present at the anchor commit' }, null, 2))
    process.exit(5)
  }
  if (mode.includes('gate-fails')) {
    console.log(JSON.stringify({ verdict: 'FAIL', failed: ['behavior'], phase: Number(flag('phase')), results: [{ name: 'behavior', kind: 'command', status: 'fail' }] }, null, 2))
    process.exit(1)
  }
  console.log('PASS')
} else if (command === 'fix') {
  const verdict = JSON.parse(readFileSync(flag('verdict'), 'utf8'))
  console.log(JSON.stringify({ decision: 'retry', tasks: [{ taskId: 'T1', tier: 'mid', round: 1, checks: verdict.results.filter(r => r.status === 'fail').map(r => r.name) }], reason: null }, null, 2))
} else if (command === 'record-fix-round') {
  console.log(flag('task') + ' phase ' + flag('phase') + ' round 1')
} else if (command === 'finish') {
  console.log('PASS')
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
const limits = { maxWallMs: 600000, maxAttempts: 40, maxRepairRounds: 2, stepTimeoutMs: 60000 }
const factory = async () => ({ exec: defaultExec, close: async () => {} })
const tasks = [{ id: 'T1', phase: 1, file: 'a.txt' }]

// A fixture executor: `codex` runs the fake probe binary, everything else runs as asked with the
// fake CLI's environment. Exported shape-for-shape by the process-loss child script below.
function fixtureExec({ codex, log, env }) {
  return (command, cwd, options = {}) => {
    const fixtureEnv = { FAKE_LOG: log, FAKE_MODE: env.mode, FAKE_AUTH: env.auth, FAKE_TASKS: JSON.stringify(tasks), FAKE_RUN_BRANCH: 'fleetmates/run/r1' }
    if (command === 'codex') return defaultExec(process.execPath, cwd, { ...options, argv: [codex, ...options.argv], env: fixtureEnv })
    return defaultExec(command, cwd, { ...options, env: { ...options.env, ...fixtureEnv } })
  }
}

async function project(t, { rolePolicy = policy } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'wfx-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'repo'), bin = path.join(base, 'bin')
  await mkdir(root); await mkdir(bin)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid')
  await writeFile(path.join(root, 'plan.md'), '### Task 1: task T1\n\n**Files:**\n- Create: `a.txt`\n')
  const check = `${node} -e "process.exit(require('fs').existsSync('a.txt')?0:1)"`
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ skips: [{ file: 'tests/slow.test.mjs', reason: 'fixture standing skip' }],
    phases: { default: { fixRounds: 1, checks: [
      { name: 'behavior', kind: 'command', run: check }, { name: 'review', kind: 'agent', lens: ['correctness'], blockOn: ['high'] }] } } }))
  await writeFile(path.join(root, 'env.json'), JSON.stringify({ version: 1, toolchains: [{ name: 'node', command: process.execPath, argv: ['--version'], expected: 'v' }],
    lockfiles: [], setup: [], baseline: [{ name: 'runtime', run: `${node} -e 0`, timeoutMs: 20000 }], required: [], dependencies: 'clean-checkout' }))
  await writeFile(path.join(root, 'roles.json'), JSON.stringify(rolePolicy))
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: anchor')
  git(root, 'checkout', '-b', 'fleetmates/run/r1')
  const cliPath = path.join(bin, 'cli.mjs'), codex = path.join(bin, 'codex.mjs'), log = path.join(bin, 'invocations.jsonl')
  await writeFile(cliPath, FAKE_CLI); await writeFile(codex, FAKE_CODEX)
  const env = { mode: '', auth: 'ok' }
  const calls = []
  const exec = fixtureExec({ codex, log, env })
  const host = { cliPath, verificationFactory: factory, exec: (command, cwd, options = {}) => { calls.push({ command, argv: options.argv ?? null }); return exec(command, cwd, options) } }
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const request = (overrides = {}) => ({ version: 1, profile: 'bug-fix', runId: 'r1', planPath: 'plan.md', baseBranch: 'main',
    baseCommit: git(root, 'rev-parse', 'refs/heads/main'), runBranch: 'fleetmates/run/r1', harness: 'codex', sandboxMode: 'clone',
    parameters: {}, limits, environment: 'env.json', rolePolicy: 'roles.json', retention, model: 'gpt-fixture', effort: 'high', ...overrides })
  const requestFile = async (value) => {
    const file = path.join(base, `request-${randomUUID()}.json`)
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
    return file
  }
  const io = () => { const lines = []; return { lines, out: s => lines.push(s), err: s => lines.push(s) } }
  const command = async (name, flags) => {
    const sink = io()
    const code = await workflowCommand(name, { root, ...flags }, sink, host)
    return { code, output: sink.lines.join('\n') }
  }
  const cli = async (argv) => {
    const sink = io()
    const code = await runCli([...argv, '--root', root], sink)
    return { code, output: sink.lines.join('\n') }
  }
  const invocations = async () => existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const events = () => readExecutionEvents(common, 'r1')
  return { base, root, bin, cliPath, codex, log, env, calls, host, common, request, requestFile, command, cli, invocations, events }
}
const json = output => JSON.parse(output.slice(output.indexOf('{')))
const commands = list => list.map(entry => entry.command)

// A PATH holding nothing but git: every `runCli` call that could reach the controller runs under
// it, so even a broken refusal cannot start a real harness from this suite.
async function gitOnlyPath(t) {
  let found = null
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue
    try { await access(path.join(dir, 'git'), constants.X_OK); found = await realpath(path.join(dir, 'git')); break } catch { /* next */ }
  }
  assert.ok(found, 'git must be on PATH for this suite')
  const dir = await mkdtemp(path.join(tmpdir(), 'wfx-path-'))
  await symlink(found, path.join(dir, 'git'))
  const saved = process.env.PATH
  process.env.PATH = dir
  t.after(async () => { process.env.PATH = saved; await rm(dir, { recursive: true, force: true }) })
}

test('workflow commands refuse a missing or relative project root before reading anything', async t => {
  const fixture = await project(t)
  await gitOnlyPath(t)
  for (const argv of [['workflow-execute', '--file', 'request.json'], ['workflow-resume', '--run', 'r1'], ['workflow-status', '--run', 'r1'], ['workflow-resolve', '--file', 'resolution.json']]) {
    const sink = { lines: [], out(s) { this.lines.push(s) }, err(s) { this.lines.push(s) } }
    assert.equal(await runCli([...argv, '--root', 'relative/repo'], sink), 2, argv[0])
    assert.match(sink.lines.join('\n'), /absolute --root/)
    assert.equal(await runCli(argv, sink), 2, `${argv[0]} without --root`)
  }
  assert.deepEqual(await fixture.events(), [])
  // Refused before the legacy-name migration reads the root: a relative root that happens to
  // resolve against cwd to a directory holding legacy state is left exactly as it was.
  const cwd = process.cwd()
  t.after(() => process.chdir(cwd))
  process.chdir(fixture.base)
  await mkdir(path.join(fixture.base, 'rel', '.teammates', 'r9'), { recursive: true })
  const sink = { lines: [], out(s) { this.lines.push(s) }, err(s) { this.lines.push(s) } }
  assert.equal(await runCli(['workflow-status', '--run', 'r1', '--root', 'rel'], sink), 2)
  assert.equal(existsSync(path.join(fixture.base, 'rel', '.teammates', 'r9')), true, 'legacy state was migrated through a relative root')
  assert.equal(existsSync(path.join(fixture.base, 'rel', '.fleetmates')), false)
})

test('malformed workflow-execute requests exit 2 with no journal and no executor call', async t => {
  const fixture = await project(t)
  const variants = {
    'unknown key': fixture.request({ notes: 'x' }),
    'arbitrary argv': fixture.request({ argv: ['node', 'evil.mjs'] }),
    'supplied installed CLI path': fixture.request({ cliPath: '/fixture/cli.mjs' }),
    'unsupported effect adapter': fixture.request({ effects: ['vault'] }),
    'unsupported version': fixture.request({ version: 2 }),
    'missing model': (({ model, ...rest }) => rest)(fixture.request()),
    'missing effort': (({ effort, ...rest }) => rest)(fixture.request()),
    'model read as a flag': fixture.request({ model: '--dangerously-bypass-approvals-and-sandbox' }),
    'unsupported effort': fixture.request({ effort: 'turbo' }),
    'cursor with an explicit effort': fixture.request({ harness: 'cursor', sandboxMode: 'files' }),
    'reserved dispatch parameter': fixture.request({ parameters: { dispatch: { model: 'other' } } }),
    'base identity that is not a commit': fixture.request({ baseCommit: 'main' }),
    'array body': [fixture.request()],
  }
  for (const [name, value] of Object.entries(variants)) {
    const result = await fixture.command('workflow-execute', { file: await fixture.requestFile(value) })
    assert.equal(result.code, 2, `${name}: ${result.output}`)
    assert.ok(json(result.output).error, name)
  }
  const unreadable = await fixture.command('workflow-execute', { file: await fixture.requestFile('{not json') })
  assert.equal(unreadable.code, 2)
  assert.deepEqual(fixture.calls, [], 'no executor call for any malformed request')
  assert.deepEqual(await fixture.events(), [], 'no journal for any malformed request')
  assert.equal(existsSync(path.join(fixture.root, '.fleetmates', 'r1')), false)
})

test('a valid request runs the fixed profile and adds explicit model and effort only to dispatches', async t => {
  const fixture = await project(t)
  const result = await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request()) })
  assert.equal(result.code, 4, 'acceptance evidence is still missing, so the run is unresolved')
  const report = json(result.output)
  assert.equal(report.state, 'human-required')
  assert.equal(report.verifiedComplete, false)
  assert.deepEqual(report.host.dispatch, { model: 'gpt-fixture', effort: 'high' })
  const seen = await fixture.invocations()
  assert.deepEqual(commands(seen), ['init-run', 'preview-check', 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate'])
  for (const entry of seen) {
    const selected = entry.args.includes('--model')
    assert.equal(selected, ['dispatch', 'dispatch-reviews'].includes(entry.command), `${entry.command} model selection`)
    if (selected) {
      assert.equal(entry.args[entry.args.indexOf('--model') + 1], 'gpt-fixture')
      assert.equal(entry.args[entry.args.indexOf('--effort') + 1], 'high')
    }
    assert.deepEqual(entry.args.slice(-2), ['--root', fixture.root], 'the explicit absolute root stays last')
  }
  // Actual receipts: completed steps reference retained artifacts, and the task was merged by a
  // host-bounded no-ff merge on the run branch.
  assert.ok(report.steps.filter(step => step.status === 'completed').every(step => step.artifacts.length > 0))
  assert.equal(report.steps.find(step => step.id === 'integrate-1').mode, 'host-bounded')
  const taskTip = git(fixture.root, 'rev-parse', 'refs/heads/fleetmates/r1/T1')
  assert.equal(git(fixture.root, 'rev-parse', 'refs/heads/fleetmates/run/r1^2'), taskTip)
  assert.ok((await fixture.events()).length > 0)
})

test('workflow-status reconciles the journal read-only and never claims completion', async t => {
  const fixture = await project(t)
  await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request()) })
  await gitOnlyPath(t)
  const before = { events: (await fixture.events()).length, refs: git(fixture.root, 'for-each-ref', '--format=%(refname) %(objectname)') }
  const result = await fixture.cli(['workflow-status', '--run', 'r1'])
  const status = json(result.output)
  assert.equal(status.verifiedComplete, false)
  assert.equal(status.completion, 'not-established-by-status')
  assert.ok(status.attempts.some(a => a.step === 'implement-1'))
  // The retained request is listed but is an input record, never an unresolved step.
  assert.ok(status.attempts.some(a => a.step === 'request' && !a.reuse), JSON.stringify(status.attempts.map(a => [a.step, a.state])))
  assert.equal(status.unresolvedAttempts, status.attempts.filter(a => a.step !== 'request' && !a.reuse && a.state !== 'superseded').length)
  assert.ok(status.attempts.every(a => typeof a.state === 'string'))
  assert.deepEqual(status.standingSkips, [{ file: 'tests/slow.test.mjs', reason: 'fixture standing skip' }])
  assert.ok(status.limitations.some(line => /callback/i.test(line)), 'callback limitations are reported')
  // A normally finished run: the integration moved the run branch every earlier step recorded, to
  // the after-ref its receipt names, so those steps are superseded rather than branch-changed,
  // nothing is unresolved and status exits 0.
  assert.ok(status.attempts.some(a => a.state === 'superseded'), JSON.stringify(status.attempts.map(a => [a.step, a.state])))
  assert.ok(!status.attempts.some(a => a.state === 'branch-changed'), JSON.stringify(status.attempts.map(a => [a.step, a.state])))
  assert.equal(status.unresolvedAttempts, 0)
  assert.equal(status.state, 'reconciled')
  assert.equal(result.code, 0, result.output)
  assert.equal((await fixture.events()).length, before.events, 'status appended nothing')
  assert.equal(git(fixture.root, 'for-each-ref', '--format=%(refname) %(objectname)'), before.refs, 'status moved no ref')
  const absent = await fixture.cli(['workflow-status', '--run', 'other'])
  assert.equal(absent.code, 4)
  assert.equal(json(absent.output).state, 'absent')
})

test('workflow-status exits 0 for a reconciled journal and still never claims completion', async t => {
  const fixture = await project(t)
  await gitOnlyPath(t)
  const { retainExecutionArtifact } = await import('../scripts/execution-artifacts.mjs')
  const tip = git(fixture.root, 'rev-parse', 'HEAD')
  const sha = (n) => n.repeat(64)
  const inputs = { commit: tip, plan: sha('1'), manifest: sha('2'), context: sha('3'), environment: sha('4'), verifier: sha('5') }
  const { reference } = await retainExecutionArtifact({ common: fixture.common, runId: 'r1', kind: 'step-outcome', bytes: Buffer.from('{}'), retention })
  const base = { version: 2, runId: 'r1', executionId: 'wf-fixture', task: 'profile', step: 'prepare', attempt: 'prepare.1', inputs,
    branches: { 'refs/heads/fleetmates/run/r1': tip }, checkout: 'root' }
  const at = Date.now()
  await appendExecutionEvent(fixture.common, { ...base, id: randomUUID(), kind: 'step-started', at, artifacts: [] }, { requireFreshStart: true })
  await appendExecutionEvent(fixture.common, { ...base, id: randomUUID(), kind: 'step-completed', at: at + 1, artifacts: [reference] })
  const result = await fixture.cli(['workflow-status', '--run', 'r1'])
  assert.equal(result.code, 0, result.output)
  const status = json(result.output)
  assert.equal(status.state, 'reconciled')
  assert.deepEqual(status.attempts.map(a => [a.step, a.state, a.ended, a.outcome]), [['prepare', 'ready', true, 'completed']])
  assert.equal(status.verifiedComplete, false)
  // The same journal with the run branch moved is no longer reconciled.
  git(fixture.root, 'commit', '-q', '--allow-empty', '-m', 'test: move the run branch')
  assert.equal((await fixture.cli(['workflow-status', '--run', 'r1'])).code, 4)
})

test('workflow-accept retains evidence for the integrated tree only, and workflow-resume passes it so finish runs', async t => {
  const fixture = await project(t)
  const first = json((await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request()) })).output)
  assert.equal(first.state, 'human-required')
  const tree = first.acceptance.tree
  assert.equal(tree, git(fixture.root, 'rev-parse', 'refs/heads/fleetmates/run/r1^{tree}'))
  const criteria = first.acceptance.required.map(criterion => ({ criterion, status: 'pass', note: 'observed by the fixture' }))
  const accept = async value => fixture.cli(['workflow-accept', '--file', await fixture.requestFile(value)])
  const before = (await fixture.events()).length
  const variants = {
    'a tree that is not the integrated run-branch tree': { version: 1, runId: 'r1', tree: git(fixture.root, 'rev-parse', 'refs/heads/main^{tree}'), criteria },
    'an unsupported version': { version: 2, runId: 'r1', tree, criteria },
    'an unknown field': { version: 1, runId: 'r1', tree, criteria, extra: true },
    'a status that is neither pass nor fail': { version: 1, runId: 'r1', tree, criteria: [{ ...criteria[0], status: 'maybe' }] },
    'a criterion named twice': { version: 1, runId: 'r1', tree, criteria: [criteria[0], criteria[0]] },
    'a run with no journal': { version: 1, runId: 'other', tree, criteria },
  }
  for (const [name, value] of Object.entries(variants)) {
    const refused = await accept(value)
    assert.equal(refused.code, 2, `${name}: ${refused.output}`)
    assert.ok(json(refused.output).error, name)
  }
  const relative = await fixture.cli(['workflow-accept', '--file', 'acceptance.json'])
  assert.equal(relative.code, 2, relative.output)
  assert.equal((await fixture.events()).length, before, 'no refused acceptance was recorded')

  const accepted = await accept({ version: 1, runId: 'r1', tree, criteria })
  assert.equal(accepted.code, 0, accepted.output)
  const answer = json(accepted.output)
  assert.deepEqual(answer.retained.map(entry => [entry.criterion, entry.reference.kind]), criteria.map(c => [c.criterion, 'acceptance-evidence']))
  const { readExecutionArtifact } = await import('../scripts/execution-artifacts.mjs')
  const evidence = JSON.parse(await readExecutionArtifact({ common: fixture.common, runId: 'r1', reference: answer.retained[0].reference, retention }))
  assert.deepEqual(evidence, { version: 1, criterion: criteria[0].criterion, tree, status: 'pass' })

  const resumed = await fixture.command('workflow-resume', { run: 'r1' })
  const report = json(resumed.output)
  assert.deepEqual(report.acceptance.missing, [], 'the retained evidence reached the controller')
  assert.equal(commands(await fixture.invocations()).at(-1), 'finish')
  assert.equal(report.obligations.verifiedComplete, true)
  // This suite injects its verification fixture, which the controller never counts as completion;
  // only native verification can make the report verified-complete and the exit 0.
  assert.equal(report.verification, 'injected-unit-fixture')
  assert.equal(report.state, 'unresolved')
  assert.equal(resumed.code, 4)

  // A commit on the run branch after its integration keeps the same tree, but the branch is no
  // longer at the tip its last integration recorded: refused, nothing recorded.
  git(fixture.root, 'commit', '-q', '--allow-empty', '-m', 'test: move the run branch past its integration')
  assert.equal(git(fixture.root, 'rev-parse', 'refs/heads/fleetmates/run/r1^{tree}'), tree)
  const after = (await fixture.events()).length
  const moved = await accept({ version: 1, runId: 'r1', tree, criteria })
  assert.equal(moved.code, 2, moved.output)
  assert.match(json(moved.output).error, /last completed integration/)
  assert.equal((await fixture.events()).length, after)
})

test('workflow-prune keeps every artifact the journal references and removes non-live content past its bounds', async t => {
  const fixture = await project(t)
  await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request()) })
  await gitOnlyPath(t)
  const { retainExecutionArtifact, readExecutionArtifact } = await import('../scripts/execution-artifacts.mjs')
  const aged = await retainExecutionArtifact({ common: fixture.common, runId: 'r1', kind: 'step-outcome', bytes: Buffer.from('{"aged":true}'), retention,
    now: Date.now() - retention.maxAgeMs - 60_000 })
  const fresh = await retainExecutionArtifact({ common: fixture.common, runId: 'r1', kind: 'step-outcome', bytes: Buffer.from('{"fresh":true}'), retention })
  const referenced = (await fixture.events()).flatMap(e => e.artifacts ?? [])
  assert.ok(referenced.length > 0)
  const result = await fixture.cli(['workflow-prune', '--run', 'r1'])
  assert.equal(result.code, 0, result.output)
  const pruned = json(result.output)
  assert.equal(pruned.removed.length, 1, result.output)
  assert.ok(pruned.kept.length > 0)
  assert.equal(pruned.liveReferences, new Set(referenced.map(r => JSON.stringify(r))).size)
  for (const reference of referenced) await readExecutionArtifact({ common: fixture.common, runId: 'r1', reference, retention })
  await assert.rejects(readExecutionArtifact({ common: fixture.common, runId: 'r1', reference: aged.reference, retention }))
  // Non-live but inside every bound: kept, so a later step can still retain beside it.
  await readExecutionArtifact({ common: fixture.common, runId: 'r1', reference: fresh.reference, retention })
  assert.equal(await runCli(['workflow-prune', '--run', 'r1', '--root', 'relative'], { out: () => {}, err: () => {} }), 2)
})

test('the run-id and request numeric bounds accept n and refuse n+1', async t => {
  const fixture = await project(t)
  // Written out rather than imported, so a moved bound in the code turns this red instead of moving
  // the expectation with it.
  const retentionUpper = { maxArtifactBytes: 16 * 1024 * 1024, maxRunBytes: 256 * 1024 * 1024, maxAgeMs: 365 * 24 * 60 * 60 * 1000 }
  for (const command of ['workflow-status', 'workflow-prune']) {
    const accepted = await fixture.command(command, { run: 'a'.repeat(80) })
    assert.notEqual(accepted.code, 2, `${command} with an 80-character run id: ${accepted.output}`)
    const refused = await fixture.command(command, { run: 'a'.repeat(81) })
    assert.equal(refused.code, 2, `${command} with an 81-character run id`)
    assert.match(json(refused.output).error, /run identity/)
  }
  const upper = { maxWallMs: 1440 * 60_000, maxAttempts: 500, maxRepairRounds: 10, stepTimeoutMs: 21_600_000 }
  for (const [key, bound] of Object.entries(retentionUpper)) {
    const refused = await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request({ retention: { ...retention, [key]: bound + 1 } })) })
    assert.equal(refused.code, 2, `retention.${key} ${bound + 1}: ${refused.output}`)
  }
  for (const [key, bound] of Object.entries(upper)) {
    const refused = await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request({ limits: { ...limits, [key]: bound + 1 } })) })
    assert.equal(refused.code, 2, `limits.${key} ${bound + 1}: ${refused.output}`)
  }
  assert.deepEqual(fixture.calls, [], 'no n+1 request reached the executor')
  assert.deepEqual(await fixture.events(), [])
  const accepted = await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request({ retention: { ...retentionUpper }, limits: upper })) })
  assert.equal(accepted.code, 4, accepted.output)
  assert.equal(json(accepted.output).state, 'human-required', 'every bound at n runs the profile')
})

test('a gate that cannot derive run state is reported as blocked infrastructure, not a code repair', async t => {
  // Both state failures are gate exit 5, which the controller itself classifies as infrastructure:
  // no fix decision, no repair round, and nothing for the host to reclassify.
  const fixture = await project(t)
  fixture.env.mode = 'gate-derive'
  const result = await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request()) })
  assert.equal(result.code, 4)
  const report = json(result.output)
  assert.equal(report.state, 'blocked')
  assert.deepEqual(report.blockers.map(b => [b.category, b.step, b.reason]), [['infrastructure', 'gate-1', 'exit 5']])
  assert.equal(report.host.reclassified, undefined)
  assert.ok(!commands(await fixture.invocations()).some(c => c === 'fix' || c === 'record-fix-round'), 'no repair decision for a state failure')

  const unreadable = await project(t)
  unreadable.env.mode = 'gate-run-state'
  const second = json((await unreadable.command('workflow-execute', { file: await unreadable.requestFile(unreadable.request()) })).output)
  assert.equal(second.state, 'blocked')
  assert.deepEqual(second.blockers.map(b => [b.category, b.step, b.reason]), [['infrastructure', 'gate-1', 'exit 5']])
  assert.equal(second.host.reclassified, undefined)
  assert.ok(!commands(await unreadable.invocations()).some(c => c === 'fix' || c === 'record-fix-round'), 'no repair decision for a state failure')
})

test('a failing gate gets one repair round within its budget, then stops failed with no merge', async t => {
  const fixture = await project(t)
  fixture.env.mode = 'gate-fails'
  const runTip = git(fixture.root, 'rev-parse', 'refs/heads/fleetmates/run/r1')
  const result = await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request()) })
  assert.equal(result.code, 4)
  const report = json(result.output)
  assert.equal(report.state, 'failed')
  assert.equal(report.repair.decision.decision, 'retry')
  // The manifest fixRounds 1 under maxRepairRounds 2 allows one round: record, fix-round dispatch, review, collect, gate.
  assert.deepEqual(commands(await fixture.invocations()).slice(-7), ['fix', 'record-fix-round', 'dispatch', 'dispatch-reviews', 'collect-reviews', 'gate', 'fix'])
  assert.deepEqual(report.repair.rounds, [{ phase: 1, round: 1, tasks: ['T1'] }])
  assert.deepEqual(report.blockers.map(b => [b.category, b.step]), [['code', 'gate-1.r1']])
  assert.match(report.blockers[0].reason, /^budget-exhausted/)
  assert.equal(report.host.repairRounds.max, 2)
  assert.equal(report.host.repairRounds.delivered, 1, 'the host reports the rounds the controller delivered')
  assert.ok(!report.host.limitations.some(line => /no command delivers a repair round/.test(line)), 'the stale repair limitation is gone')
  assert.equal(git(fixture.root, 'rev-parse', 'refs/heads/fleetmates/run/r1'), runTip, 'no merge after a failing gate')
  assert.equal(report.host.reclassified, undefined)
})

test('a moved base or a changed committed role policy refuses before any spawn', async t => {
  const fixture = await project(t)
  await gitOnlyPath(t)
  const moved = await fixture.cli(['workflow-execute', '--file', await fixture.requestFile(fixture.request({ baseCommit: 'a'.repeat(40) }))])
  assert.equal(moved.code, 4, moved.output)
  assert.equal(json(moved.output).blockers[0].category, 'changed-input')
  assert.deepEqual(await fixture.events(), [])

  const ran = await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request()) })
  assert.equal(ran.code, 4)
  const spawned = (await fixture.invocations()).length
  git(fixture.root, 'checkout', '-q', 'main')
  await writeFile(path.join(fixture.root, 'roles.json'), JSON.stringify({ ...policy, roles: { ...policy.roles, reviewer: { ...policy.roles.reviewer, write: true } } }))
  git(fixture.root, 'commit', '-qam', 'test: widen the reviewer')
  git(fixture.root, 'checkout', '-q', 'fleetmates/run/r1')
  fixture.calls.length = 0
  const resumed = await fixture.command('workflow-resume', { run: 'r1' })
  assert.equal(resumed.code, 4, resumed.output)
  assert.equal(json(resumed.output).blockers.at(-1).category, 'policy')
  assert.equal((await fixture.invocations()).length, spawned, 'no CLI step ran after the contract changed')
  assert.deepEqual(fixture.calls, [], 'no probe or command ran after the contract changed')
})

test('process loss leaves an interrupted dispatch that status reports and resume refuses to redispatch', { skip: process.platform === 'win32' }, async t => {
  const fixture = await project(t)
  const child = path.join(fixture.bin, 'loss.mjs')
  await writeFile(child, `
import { workflowCommand } from ${JSON.stringify(pathToFileURL(CLI_FILE).href)}
import { defaultExec } from ${JSON.stringify(pathToFileURL(GATE_RUNNER_FILE).href)}
const cfg = JSON.parse(process.env.LOSS_CONFIG)
const exec = (command, cwd, options = {}) => {
  const env = { FAKE_LOG: cfg.log, FAKE_MODE: 'hang-dispatch', FAKE_AUTH: 'ok', FAKE_TASKS: JSON.stringify(cfg.tasks), FAKE_RUN_BRANCH: 'fleetmates/run/r1' }
  if (command === 'codex') return defaultExec(process.execPath, cwd, { ...options, argv: [cfg.codex, ...options.argv], env })
  return defaultExec(command, cwd, { ...options, env: { ...options.env, ...env } })
}
await workflowCommand('workflow-execute', { file: cfg.file, root: cfg.root }, { out: () => {}, err: () => {} },
  { cliPath: cfg.cliPath, exec, verificationFactory: async () => ({ exec: defaultExec, close: async () => {} }) })
`)
  const config = { log: fixture.log, codex: fixture.codex, cliPath: fixture.cliPath, root: fixture.root, tasks, file: await fixture.requestFile(fixture.request()) }
  const proc = spawn(process.execPath, [child], { env: { ...process.env, LOSS_CONFIG: JSON.stringify(config) }, stdio: 'ignore' })
  const pidFile = path.join(fixture.bin, 'hang.pid')
  // A safety net if an assertion stops the test early: both processes are known by pid here,
  // independent of the order in which the temporary directory is removed.
  let hangPid = null
  t.after(() => {
    for (const pid of [hangPid && -hangPid, proc.exitCode === null && proc.signalCode === null ? proc.pid : null]) {
      if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
  })
  for (let i = 0; i < 400 && !existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(existsSync(pidFile), 'the dispatch step started')
  hangPid = Number(readFileSync(pidFile, 'utf8'))
  const exited = once(proc, 'exit')
  proc.kill('SIGKILL')
  await exited
  process.kill(-hangPid, 'SIGKILL')

  const status = await fixture.cli(['workflow-status', '--run', 'r1'])
  assert.equal(status.code, 4)
  const dispatch = json(status.output).attempts.find(a => a.step === 'implement-1')
  assert.equal(dispatch.ended, false, 'the lost dispatch has no recorded outcome')
  const before = commands(await fixture.invocations()).filter(name => name === 'dispatch').length
  fixture.env.mode = ''
  const resumed = await fixture.command('workflow-resume', { run: 'r1' })
  assert.equal(resumed.code, 4, resumed.output)
  assert.deepEqual(json(resumed.output).blockers.map(b => [b.category, b.step]), [['unknown-effect', 'implement-1']])
  assert.equal(commands(await fixture.invocations()).filter(name => name === 'dispatch').length, before, 'no blind redispatch')

  // The operator resolves the interrupted agent-dispatch effect through workflow-resolve: a reason
  // that is not one token is refused with a message saying so, and `not-started` is recorded.
  const effect = dispatch.effects.find(e => e.kind === 'agent-dispatch')
  assert.ok(effect, JSON.stringify(dispatch.effects))
  const resolution = { version: 1, runId: 'r1', effectId: effect.id, outcome: 'not-started', reason: 'operator checked' }
  const refused = await fixture.cli(['workflow-resolve', '--file', await fixture.requestFile(resolution)])
  assert.equal(refused.code, 2, refused.output)
  assert.match(json(refused.output).error, /reason must be one token/)
  const recorded = await fixture.cli(['workflow-resolve', '--file', await fixture.requestFile({ ...resolution, reason: 'operator-checked' })])
  assert.equal(recorded.code, 0, recorded.output)
  const resolved = json((await fixture.cli(['workflow-status', '--run', 'r1'])).output).attempts.find(a => a.step === 'implement-1').effects[0]
  assert.deepEqual([resolved.kind, resolved.outcome, resolved.source], ['agent-dispatch', 'not-started', 'local-operator-observation'])
  // Resolved not-started, the dispatch runs again on resume.
  await fixture.command('workflow-resume', { run: 'r1' })
  assert.equal(commands(await fixture.invocations()).filter(name => name === 'dispatch').length, before + 1, 'redispatched after the resolution')
})

test('resume refuses a retained request that carries no explicit model and effort', async t => {
  const fixture = await project(t)
  fixture.env.auth = 'none'
  const { model, effort, baseCommit, environment, rolePolicy, retention: kept, ...request } = fixture.request()
  const direct = await executeWorkflowProfile({ root: fixture.root, cliPath: fixture.cliPath, request, environment, rolePolicy, retention: kept,
    executor: fixture.host.exec, verificationFactory: factory })
  assert.equal(direct.state, 'blocked')
  fixture.calls.length = 0
  const resumed = await fixture.command('workflow-resume', { run: 'r1' })
  assert.equal(resumed.code, 2, resumed.output)
  assert.match(json(resumed.output).error, /model and effort/)
  assert.deepEqual(fixture.calls, [], 'no unrestricted legacy fallback')
})

test('workflow-resolve records a bounded local observation, performs no effect and refuses malformed input', async t => {
  const fixture = await project(t)
  await gitOnlyPath(t)
  const sha = (n) => n.repeat(64)
  const inputs = { commit: git(fixture.root, 'rev-parse', 'refs/heads/main'), plan: sha('1'), manifest: sha('2'), context: sha('3'), environment: sha('4'), verifier: sha('5') }
  const base = { version: 2, runId: 'r1', executionId: 'wf-fixture', task: 'profile', step: 'publish', attempt: 'publish.1', inputs,
    branches: { 'refs/heads/main': inputs.commit }, checkout: 'root', artifacts: [] }
  const at = Date.now()
  await appendExecutionEvent(fixture.common, { ...base, id: randomUUID(), kind: 'step-started', at }, { requireFreshStart: true })
  await appendExecutionEvent(fixture.common, { ...base, id: randomUUID(), kind: 'effect-started', at: at + 1, effect: { id: 'pr-1', kind: 'pr', reference: null } })
  const resolution = { version: 1, runId: 'r1', effectId: 'pr-1', outcome: 'completed', reason: 'checked-by-operator' }
  for (const bad of [{ ...resolution, extra: true }, { ...resolution, outcome: 'done' }, { ...resolution, reason: 'has spaces' }, { ...resolution, version: 2 }, { ...resolution, effectId: 'pr-2' }]) {
    const refused = await fixture.cli(['workflow-resolve', '--file', await fixture.requestFile(bad)])
    assert.equal(refused.code, 2, JSON.stringify(bad))
  }
  assert.equal((await fixture.events()).length, 2, 'no refused resolution was recorded')
  const recorded = await fixture.cli(['workflow-resolve', '--file', await fixture.requestFile(resolution)])
  assert.equal(recorded.code, 0, recorded.output)
  const answer = json(recorded.output)
  assert.equal(answer.trust, 'local-operator-observation')
  assert.equal(answer.authenticatedAuthorization, false)
  assert.equal(answer.externalEffect, 'none-performed')
  assert.equal((await fixture.events()).length, 3)
  const status = json((await fixture.cli(['workflow-status', '--run', 'r1'])).output)
  const effect = status.attempts.find(a => a.step === 'publish').effects[0]
  assert.equal(effect.outcome, 'completed')
  assert.equal(effect.source, 'local-operator-observation')
  assert.equal(effect.authenticatedAuthorization, false)
})

test('doctor reports execution recovery states and callback limitations', async t => {
  const fixture = await project(t)
  await fixture.command('workflow-execute', { file: await fixture.requestFile(fixture.request({ })) })
  await gitOnlyPath(t)
  const result = await fixture.cli(['doctor', '--run', 'r1', '--plan', 'plan.md', '--base', 'main'])
  const line = result.output.split('\n').find(l => l.startsWith('{"execution"'))
  assert.ok(line, result.output)
  const summary = JSON.parse(line).execution
  assert.ok(summary.attempts > 0)
  assert.equal(typeof summary.states, 'object')
  assert.equal(summary.verifiedComplete, false)
  assert.ok(summary.limitations.some(l => /callback/i.test(l)))
  // The same doctor call without the journal: identical exit code and identical other lines.
  const { rename } = await import('node:fs/promises')
  await rename(path.join(fixture.common, 'fleetmates-execution'), path.join(fixture.common, 'fleetmates-execution.aside'))
  const without = await fixture.cli(['doctor', '--run', 'r1', '--plan', 'plan.md', '--base', 'main'])
  assert.equal(without.code, result.code)
  assert.equal(without.output, result.output.split('\n').filter(l => l !== line).join('\n'))
})

// ---- dispatch selection, message outcomes, integrator subjects ----

async function dispatchRepo(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wfx-dispatch-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid')
  await writeFile(path.join(root, 'plan.md'), '### Task 1: fixture\n\n**Files:**\n- Create: `fixture.mjs`\n')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: dispatch plan')
  git(root, 'checkout', '-b', 'run')
  const run = async (argv) => {
    const lines = []
    const code = await runCli([...argv, '--root', root], { out: s => lines.push(s), err: s => lines.push(s) })
    return { code, output: lines.join('\n') }
  }
  assert.equal((await run(['init-run', 'plan.md', '--run', 'r1'])).code, 0)
  return { root, run }
}
function stubAdapter(t, name, overrides) {
  const adapter = getAdapter(name)
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, adapter[key]]))
  Object.assign(adapter, overrides)
  t.after(() => Object.assign(adapter, originals))
  return adapter
}

test('dispatch passes an explicit model and effort to the adapter, and cursor refuses an explicit effort', { skip: process.platform === 'win32' }, async t => {
  const { root, run } = await dispatchRepo(t)
  const spawned = []
  const fakeChild = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20)'], { stdio: 'ignore' })
  stubAdapter(t, 'codex', {
    probe: async () => ({ ok: true }), readResult: async () => null, readUsage: async () => null,
    makeSandbox: async () => ({ cwd: root, meta: { mode: 'clone', gitdir: '/fixture/git' } }),
    spawn: async args => { spawned.push({ model: args.model, effort: args.effort }); return { child: fakeChild(), sessionId: Promise.resolve('s1'), flushed: Promise.resolve() } },
  })
  const result = await run(['dispatch', '--run', 'r1', '--phase', '1', '--base', 'main', '--harness', 'codex', '--model', 'gpt-fixture', '--effort', 'high'])
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(spawned, [{ model: 'gpt-fixture', effort: 'high' }])

  let cursorProbed = false
  // Every cursor entry point is stubbed to refuse, so a broken refusal can never start cursor-agent.
  const never = async () => { throw new Error('cursor must not be reached') }
  stubAdapter(t, 'cursor', { probe: async () => { cursorProbed = true; return { ok: true } }, makeSandbox: never, spawn: never, resume: never })
  for (const argv of [['dispatch', '--run', 'r1', '--phase', '1'], ['dispatch-reviews', '--run', 'r1', '--phase', 'default']]) {
    const refused = await run([...argv, '--harness', 'cursor', '--model', 'auto', '--effort', 'high'])
    assert.equal(refused.code, 2, refused.output)
    assert.match(refused.output, /effort/)
  }
  for (const bad of [['--model', '-x'], ['--effort', 'turbo'], ['--model'], ['--effort']]) {
    const refused = await run(['dispatch', '--run', 'r1', '--phase', '1', '--harness', 'codex', ...bad])
    assert.equal(refused.code, 2, `${bad.join(' ')}: ${refused.output}`)
  }
  assert.equal(cursorProbed, false, 'refused before any harness probe')
  assert.equal(spawned.length, 1, 'refused before any spawn')
})

// Two phase-1 tasks, each with a task branch carrying its work and a recorded done result whose
// sandbox was already removed: the state a fix round starts from.
async function fixRoundRepo(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wfx-fix-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid')
  await writeFile(path.join(root, 'plan.md'), '### Task 1: first\n\n**Files:**\n- Create: `a.mjs`\n\n### Task 2: second\n\n**Files:**\n- Create: `b.mjs`\n')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'test: fix-round plan')
  git(root, 'checkout', '-b', 'run')
  const run = async (argv) => {
    const lines = []
    const code = await runCli([...argv, '--root', root], { out: s => lines.push(s), err: s => lines.push(s) })
    return { code, output: lines.join('\n') }
  }
  assert.equal((await run(['init-run', 'plan.md', '--run', 'r1'])).code, 0)
  const sessions = path.join(root, '.fleetmates', 'r1', 'sessions')
  await mkdir(sessions, { recursive: true })
  for (const [id, file] of [['T1', 'a.mjs'], ['T2', 'b.mjs']]) {
    git(root, 'checkout', '-q', '-b', `fleetmates/r1/${id}`, 'run')
    await writeFile(path.join(root, file), `export const id = '${id}'\n`)
    git(root, 'add', file); git(root, 'commit', '-q', '-m', `feat: ${id}`)
    await writeFile(path.join(sessions, `${id}.json`), JSON.stringify({ taskId: id, state: 'done', sandboxRemoved: true,
      result: { status: 'done', branch: `fleetmates/r1/${id}`, filesChanged: [file], summary: 'fixture', blockers: [] } }))
  }
  git(root, 'checkout', '-q', 'run')
  return { root, run }
}
function recordingCodex(t, root) {
  const seen = { probed: 0, spawned: [] }
  const fakeChild = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20)'], { stdio: 'ignore' })
  stubAdapter(t, 'codex', {
    probe: async () => { seen.probed++; return { ok: true } }, readResult: async () => null, readUsage: async () => null,
    makeSandbox: async () => ({ cwd: root, meta: { mode: 'clone', gitdir: '/fixture/git' } }),
    spawn: async args => { seen.spawned.push({ task: path.basename(args.resultPath, '.result.json'), prompt: args.prompt }); return { child: fakeChild(), sessionId: Promise.resolve('s1'), flushed: Promise.resolve() } },
    // A fix round over a recorded session resumes it: recorded as a dispatch too, never the real binary.
    resume: async args => { seen.spawned.push({ task: path.basename(args.resultPath, '.result.json'), prompt: args.message, resumed: true }); return { child: fakeChild(), sessionId: Promise.resolve('s1'), flushed: Promise.resolve() } },
  })
  return seen
}

test('dispatch --fix-round redispatches only the named tasks with the fix-round brief, even with a done result recorded', { skip: process.platform === 'win32' }, async t => {
  const { root, run } = await fixRoundRepo(t)
  await gitOnlyPath(t)
  const seen = recordingCodex(t, root)
  const plain = await run(['dispatch', '--run', 'r1', '--phase', '1', '--harness', 'codex'])
  assert.equal(plain.code, 0, plain.output)
  assert.deepEqual(seen.spawned, [], 'a plain dispatch never respawns a task whose done result is recorded')
  const tips = ['T1', 'T2'].map(id => git(root, 'rev-parse', `refs/heads/fleetmates/r1/${id}`))
  const fixed = await run(['dispatch', '--run', 'r1', '--phase', '1', '--harness', 'codex', '--fix-round', '--task', 'T1'])
  assert.equal(fixed.code, 0, fixed.output)
  assert.deepEqual(seen.spawned.map(s => s.task), ['T1'])
  assert.match(seen.spawned[0].prompt, /FIX ROUND/)
  assert.doesNotMatch(seen.spawned[0].prompt, /checkout -B fleetmates\/r1\/T1/)
  assert.deepEqual(['T1', 'T2'].map(id => git(root, 'rev-parse', `refs/heads/fleetmates/r1/${id}`)), tips, 'no task branch was reset')
  seen.spawned.length = 0
  const both = await run(['dispatch', '--run', 'r1', '--phase', '1', '--harness', 'codex', '--fix-round', '--task', 'T1', '--task', 'T2'])
  assert.equal(both.code, 0, both.output)
  assert.deepEqual(seen.spawned.map(s => s.task).sort(), ['T1', 'T2'], 'a repeated --task names every task')
})

test('dispatch refuses an unusable --fix-round or --execution with exit 2 before any probe or spawn', { skip: process.platform === 'win32' }, async t => {
  const { root, run } = await fixRoundRepo(t)
  await gitOnlyPath(t)
  const seen = recordingCodex(t, root)
  const missing = path.join(root, 'no-such-execution.json')
  const variants = {
    'an unknown task': ['--fix-round', '--task', 'T9'],
    'a known and an unknown task': ['--fix-round', '--task', 'T1', '--task', 'T9'],
    '--task without --fix-round': ['--task', 'T1'],
    '--fix-round without --task': ['--fix-round'],
    'a relative execution path': ['--execution', 'execution.json'],
    'a missing execution file': ['--execution', missing],
    'a bare --execution': ['--execution'],
  }
  // The relative path names a readable file from the cwd, so only the absolute-path guard refuses it.
  await writeFile(path.join(root, 'execution.json'), '{}')
  const cwd = process.cwd()
  t.after(() => process.chdir(cwd))
  process.chdir(root)
  for (const [name, extra] of Object.entries(variants)) {
    const refused = await run(['dispatch', '--run', 'r1', '--phase', '1', '--harness', 'codex', ...extra])
    assert.equal(refused.code, 2, `${name}: ${refused.output}`)
  }
  const malformed = path.join(root, 'malformed.json')
  await writeFile(malformed, '{not json')
  assert.equal((await run(['dispatch', '--run', 'r1', '--phase', '1', '--harness', 'codex', '--execution', malformed])).code, 2)
  assert.equal(seen.probed, 0, 'refused before the harness probe')
  assert.deepEqual(seen.spawned, [])
})

// The driver's strict execution reads the contract's `inputs.commit` and refuses a run branch that is
// not at it before any sandbox or spawn; the legacy path (no contract) spawns. So a contract naming
// another commit is observable as that refusal, which only the contract file can have caused.
test('dispatch --execution hands the contract file to the driver unchanged as its required execution', { skip: process.platform === 'win32' }, async t => {
  const { root, run } = await dispatchRepo(t)
  await gitOnlyPath(t)
  const seen = recordingCodex(t, root)
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const sha = n => n.repeat(64)
  const contract = { version: 1, common, runId: 'r1', executionId: 'cli-fixture-p1',
    inputs: { commit: 'a'.repeat(40), plan: sha('1'), manifest: sha('2'), context: sha('3'), environment: sha('4'), verifier: sha('5') },
    retention, maxAttempts: 2, deadlineAt: Date.now() + 600_000 }
  const file = path.join(root, '.fleetmates', 'r1', 'execution.json')
  await writeFile(file, JSON.stringify(contract))
  const result = await run(['dispatch', '--run', 'r1', '--phase', '1', '--harness', 'codex', '--execution', file])
  assert.equal(result.code, 0, result.output)
  const record = JSON.parse(await readFile(path.join(root, '.fleetmates', 'r1', 'sessions', 'T1.json'), 'utf8'))
  assert.equal(record.exitReason, 'Required source commit changed', JSON.stringify(record))
  assert.deepEqual(seen.spawned, [], 'strict execution refused before any spawn')
  assert.deepEqual(await readExecutionEvents(common, 'r1'), [])
})

async function messageRepo(t, { result = undefined } = {}) {
  const { root, run } = await dispatchRepo(t)
  const sessions = path.join(root, '.fleetmates', 'r1', 'sessions')
  await mkdir(sessions, { recursive: true })
  await writeFile(path.join(sessions, 'T1.json'), JSON.stringify({ taskId: 'T1', sessionId: 'sid', sandbox: { cwd: root, meta: { mode: 'full' } } }))
  if (result !== undefined) await writeFile(path.join(sessions, 'T1.result.json'), JSON.stringify(result))
  return { root, run, resultPath: path.join(sessions, 'T1.result.json') }
}
const done = { status: 'done', branch: 'fleetmates/r1/T1', filesChanged: ['fixture.mjs'], summary: 'fixture', blockers: [] }
const messageArgv = ['message', '--run', 'r1', '--task', 'T1', '--text', 'continue', '--harness', 'codex']
const outcomeOf = output => JSON.parse(output.split('\n').find(line => line.startsWith('{')))

test('message reports a timeout and a failed process as unresolved, never as resumed', { skip: process.platform === 'win32' }, async t => {
  const { run } = await messageRepo(t, { result: done })
  // A child that never exits: the handler's own timeout must end the wait, and it must say so.
  const hung = new EventEmitter()
  hung.exitCode = null; hung.signalCode = null; hung.kill = () => true
  // Whatever happens below, the hung child ends with the test, so no wait outlives it.
  t.after(() => hung.emit('exit'))
  let resumed = false
  stubAdapter(t, 'codex', { resume: async () => { resumed = true; return { child: hung, sessionId: Promise.resolve('sid'), flushed: Promise.resolve() } } })
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const pending = run(messageArgv)
  let settled = null
  pending.then(value => { settled = value })
  // Wall-clock bounded (Date is not mocked): first until the handler reaches the resume, then
  // ticking the mocked clock past the handler's timeout until it answers.
  const deadline = Date.now() + 30_000
  while (!resumed && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.ok(resumed, 'message never reached the resume')
  while (settled === null && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve))
    mock.timers.tick(31 * 60_000)
  }
  mock.timers.reset()
  assert.ok(settled, 'message never returned after its timeout')
  assert.equal(settled.code, 4, settled.output)
  assert.equal(outcomeOf(settled.output).exit, 'timeout')
  assert.equal(outcomeOf(settled.output).completion, 'unverified')

  stubAdapter(t, 'codex', { resume: async () => ({ child: spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' }), sessionId: Promise.resolve('sid'), flushed: Promise.resolve() }) })
  const failed = await run(messageArgv)
  assert.equal(failed.code, 4, failed.output)
  assert.equal(outcomeOf(failed.output).exitCode, 7)
  assert.equal(outcomeOf(failed.output).result, 'unchanged-result', 'the old result is not a new structured result')
})

test('message exits 0 only for a new valid result, names the outcome, and states completion is unverified', { skip: process.platform === 'win32' }, async t => {
  const { run, resultPath } = await messageRepo(t, { result: done })
  let write = null
  stubAdapter(t, 'codex', { resume: async args => {
    assert.equal(args.resultPath, resultPath)
    const script = write === null ? 'setTimeout(() => {}, 20)' : typeof write === 'object' ? write.script
      : `require('fs').writeFileSync(${JSON.stringify(resultPath)}, ${JSON.stringify(write)})`
    return { child: spawn(process.execPath, ['-e', script], { stdio: 'ignore' }), sessionId: Promise.resolve('sid'), flushed: Promise.resolve() }
  } })
  // A clean exit that left the old result in place produced no new result: unresolved, exit 4.
  const unchanged = await run(messageArgv)
  assert.equal(unchanged.code, 4, unchanged.output)
  assert.equal(outcomeOf(unchanged.output).result, 'unchanged-result')
  assert.equal(outcomeOf(unchanged.output).completion, 'unverified')
  write = JSON.stringify({ ...done, summary: 'second turn' })
  const fresh = await run(messageArgv)
  assert.equal(fresh.code, 0, fresh.output)
  assert.equal(outcomeOf(fresh.output).result, 'new-result')
  assert.equal(outcomeOf(fresh.output).status, 'done')
  assert.equal(outcomeOf(fresh.output).completion, 'unverified')
  write = '{"status": "done"'
  const invalid = await run(messageArgv)
  assert.equal(outcomeOf(invalid.output).result, 'invalid-result')
  assert.equal(invalid.code, 4)
  // Read bounded and without following a link: an oversized or linked result is not a result.
  write = { script: `require('fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ...${JSON.stringify(done)}, summary: 'x'.repeat(1024 * 1024) }))` }
  assert.equal(outcomeOf((await run(messageArgv)).output).result, 'invalid-result')
  write = null
  const target = `${resultPath}.target`
  await writeFile(target, JSON.stringify({ ...done, summary: 'linked' }))
  await rm(resultPath, { force: true })
  await symlink(target, resultPath)
  assert.equal(outcomeOf((await run(messageArgv)).output).result, 'invalid-result')
})

test('message reports an exhausted capture bound as unresolved', { skip: process.platform === 'win32' }, async t => {
  const { run } = await messageRepo(t, { result: done })
  stubAdapter(t, 'codex', { resume: async () => ({ child: spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }), sessionId: Promise.resolve('sid'),
    flushed: Promise.resolve(), outputLimited: true }) })
  const limited = await run(messageArgv)
  assert.equal(limited.code, 4, limited.output)
  assert.equal(outcomeOf(limited.output).outputLimited, true)
  assert.match(limited.output, /resume unresolved for T1/)
})

test('message exits 4 for a failed process even when it wrote a new result', { skip: process.platform === 'win32' }, async t => {
  const { run, resultPath } = await messageRepo(t, { result: done })
  const script = `require('fs').writeFileSync(${JSON.stringify(resultPath)}, ${JSON.stringify(JSON.stringify({ ...done, summary: 'then failed' }))}); process.exit(1)`
  stubAdapter(t, 'codex', { resume: async () => ({ child: spawn(process.execPath, ['-e', script], { stdio: 'ignore' }), sessionId: Promise.resolve('sid'), flushed: Promise.resolve() }) })
  const failed = await run(messageArgv)
  assert.equal(outcomeOf(failed.output).result, 'new-result')
  assert.equal(outcomeOf(failed.output).exitCode, 1)
  assert.equal(failed.code, 4, failed.output)
  // Node reports a spawn failure as a negative exit code (-2 for ENOENT). A child object in that
  // state beside a new result file is still no resumed turn: exit 4.
  stubAdapter(t, 'codex', { resume: async () => {
    await writeFile(resultPath, JSON.stringify({ ...done, summary: 'beside a spawn failure' }))
    return { child: Object.assign(new EventEmitter(), { exitCode: -2, signalCode: null }), sessionId: Promise.resolve('sid'), flushed: Promise.resolve() }
  } })
  const unspawned = await run(messageArgv)
  assert.equal(outcomeOf(unspawned.output).result, 'new-result')
  assert.equal(outcomeOf(unspawned.output).exitCode, -2)
  assert.equal(unspawned.code, 4, unspawned.output)
})

// Cursor writes its answer into the stream file, never into <task>.result.json, so message reads
// the outcome through the adapter's readResult with the stream path.
test('message counts a cursor result written into the stream file as a new result', { skip: process.platform === 'win32' }, async t => {
  const { run, resultPath } = await messageRepo(t)
  await gitOnlyPath(t)
  const streamPath = resultPath.replace(/\.result\.json$/, '.stream.jsonl')
  const turn = (summary) => [{ type: 'user' }, { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ ...done, summary }) }] } },
    { type: 'result', is_error: false, result: JSON.stringify({ ...done, summary }) }].map(line => JSON.stringify(line)).join('\n') + '\n'
  await writeFile(streamPath, turn('first turn'))
  let append = null
  const never = async () => { throw new Error('cursor must not be spawned') }
  stubAdapter(t, 'cursor', { makeSandbox: never, spawn: never, resume: async args => {
    assert.equal(args.streamPath, streamPath)
    const script = append === null ? '0' : `require('fs').appendFileSync(${JSON.stringify(streamPath)}, ${JSON.stringify(append)})`
    return { child: spawn(process.execPath, ['-e', script], { stdio: 'ignore' }), sessionId: Promise.resolve('sid'), flushed: Promise.resolve() }
  } })
  const argv = ['message', '--run', 'r1', '--task', 'T1', '--text', 'continue', '--harness', 'cursor']
  const same = await run(argv)
  assert.equal(outcomeOf(same.output).result, 'unchanged-result', same.output)
  assert.equal(same.code, 4)
  append = turn('second turn')
  const fresh = await run(argv)
  assert.equal(outcomeOf(fresh.output).result, 'new-result', fresh.output)
  assert.equal(outcomeOf(fresh.output).status, 'done')
  assert.equal(fresh.code, 0, fresh.output)
})

test('the isolated legacy integrator assignment carries per-task subjects from the anchored plan titles', { skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wfx-int-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const gitRun = (...args) => git(root, ...args)
  gitRun('init', '-b', 'main'); gitRun('config', 'user.name', 'Example'); gitRun('config', 'user.email', 'example@example.invalid')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
  await writeFile(path.join(root, 'plan.md'), '### Task 1: add the parser\n\n**Files:**\n- Create: `a.txt`\n\n### Task 2: wire the cli\n\n**Files:**\n- Create: `b.txt`\n')
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({
    agents: { integrator: { tier: 'mid', effort: 'high' } },
    harnesses: { codex: { sandbox: 'full', network: false, tierModels: { mid: 'fixture-model' } } },
    phases: { default: { checks: [{ name: 'fileset', kind: 'fileset' }, { name: 'ownership', kind: 'ownership' }] } },
  }))
  gitRun('add', '.'); gitRun('commit', '-m', 'test: integrator fixture')
  const anchor = gitRun('rev-parse', 'HEAD')
  for (const [id, file] of [['T1', 'a.txt'], ['T2', 'b.txt']]) {
    gitRun('checkout', '-q', '-b', `fleetmates/r1/${id}`, anchor)
    await writeFile(path.join(root, file), id)
    gitRun('add', file); gitRun('commit', '-m', `test: ${id}`)
  }
  gitRun('checkout', '-q', '-b', 'run/r1', anchor)
  const run = async argv => { const lines = []; const code = await runCli([...argv, '--root', root], { out: s => lines.push(s), err: s => lines.push(s) }); return { code, output: lines.join('\n') } }
  assert.equal((await run(['init-run', 'plan.md', '--run', 'r1'])).code, 0)
  const gated = await run(['gate', '--run', 'r1', '--plan', 'plan.md', '--base', 'main'])
  assert.equal(gated.code, 0, gated.output)
  gitRun('checkout', '-q', '--detach')
  let prompt = null
  stubAdapter(t, 'codex', { probe: async () => ({ ok: true }), spawn: async options => { prompt = options.prompt; throw new Error('fixture stops after the assignment') } })
  const result = await run(['dispatch-integrator', '--isolated-legacy', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--phase', '1'])
  assert.equal(result.code, 4, result.output)
  assert.ok(prompt, result.output)
  const assignment = JSON.parse(prompt.slice(prompt.indexOf('{', prompt.indexOf('Concrete assignment')), prompt.indexOf('\n', prompt.indexOf('Concrete assignment') + 60)))
  assert.deepEqual(assignment.tasks.map(task => task.mergeSubject), ['merge: integrate T1 add the parser', 'merge: integrate T2 wire the cli'])
})

test('integrator merge subjects name the task and its plan title rather than a fixed run', () => {
  assert.equal(integratorMergeSubject({ id: 'T3', title: 'add the parser' }), 'merge: integrate T3 add the parser')
  assert.equal(integratorMergeSubject({ id: 'T4' }), 'merge: integrate T4')
  const hostile = integratorMergeSubject({ id: 'T5', title: 'x"; rm -rf $HOME `id`\nsecond line' })
  assert.doesNotMatch(hostile, /["`$\n;]/)
  assert.ok(hostile.startsWith('merge: integrate T5 '))
  assert.ok(integratorMergeSubject({ id: 'T6', title: 'y'.repeat(300) }).length <= 72)
  for (const subject of [integratorMergeSubject({ id: 'T1', title: 'anything' })]) assert.doesNotMatch(subject, /execution recovery/)
})
