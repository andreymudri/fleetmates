// The CLI surface of the CI reliability feature (docs/specs/2026-11-02-ci-reliability-design.md):
// `platform-sim`, `flaky`, `ci-wait`, the `portability` lens in `review-dispatch` and
// `collect-reviews`, the `CI:` section of `doctor`, and the `ci` config block. No test here calls
// the real `gh` or the network: `ci-wait` reads check runs through an injected `io.ciExec`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli, windowsCommandArgv, quarantineWritable, judgeWorkflowRuns, shimmedExec } from '../scripts/cli.mjs'
import { QUARANTINE_FILE } from '../scripts/flaky.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(here, '..', 'scripts', 'cli.mjs')
const REALPATH_PROBE = path.join(here, 'fixtures', 'platform-sim', 'realpath-probe.mjs')
const FAILS_N_TIMES = path.join(here, 'fixtures', 'flaky', 'fails-n-times.mjs')

const PLAN = `### Task 1: A

**Files:**
- Create: \`a.mjs\`
`

const WINDOWS_WORKFLOW = `name: test
on:
  push:
  pull_request:
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: node cli.mjs flaky -- npm test
`

const LINUX_WORKFLOW = `name: test
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`

// A workflow that triggers every advice line ciAdvice has: pull_request only, one OS, no flaky step.
const WEAK_WORKFLOW = `name: test
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// The suite may itself run inside GitHub Actions; those variables reach the CLI only when a test
// sets them.
function cleanEnv(extra = {}) {
  const env = { ...process.env }
  delete env.GITHUB_ACTIONS
  delete env.GITHUB_STEP_SUMMARY
  return { ...env, ...extra }
}

async function tempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function repo(t) {
  const root = await tempDir(t, 'fm-cirel-')
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  await writeFile(path.join(root, 'plan.md'), PLAN, 'utf8')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n', 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'initial'])
  git(root, ['checkout', '--quiet', '-b', 'run-branch'])
  const lines = []
  const io = { out: (text) => lines.push(text), err: (text) => lines.push(text) }
  return { root, lines, io }
}

async function writeWorkflow(root, text, name = 'test.yml') {
  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true })
  await writeFile(path.join(root, '.github', 'workflows', name), text, 'utf8')
}

function cli(args, { cwd, env = cleanEnv() } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 })
}

// ---------------------------------------------------------------------------------------------
// platform-sim

test('platform-sim runs the command under the simulator, prints one applied line and keeps its exit code', async (t) => {
  const root = await tempDir(t, 'fm-cirel-sim-')
  const realTmp = await realpath(tmpdir())
  // Plain, the probe passes: the failure below is the simulator's doing.
  const plain = spawnSync(process.execPath, [REALPATH_PROBE], { env: cleanEnv({ TMPDIR: realTmp, TMP: realTmp, TEMP: realTmp }), encoding: 'utf8' })
  assert.equal(plain.status, 0, plain.stdout + plain.stderr)

  const r = cli(['platform-sim', '--root', root, '--', process.execPath, REALPATH_PROBE], { cwd: root })
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  const applied = r.stdout.split('\n').filter((line) => line.startsWith('platform-sim: applied '))
  assert.equal(applied.length, 1, r.stdout)
  assert.match(applied[0], /symlinked-tmpdir/)
  assert.match(applied[0], /autocrlf/)
})

test('platform-sim exits with the command\'s own code', async (t) => {
  const root = await tempDir(t, 'fm-cirel-sim-')
  const r = cli(['platform-sim', '--root', root, '--', process.execPath, '-e', 'process.exit(7)'], { cwd: root })
  assert.equal(r.status, 7, r.stdout + r.stderr)
})

test('platform-sim and flaky refuse with exit 2 when no command follows --', async (t) => {
  const root = await tempDir(t, 'fm-cirel-sim-')
  for (const command of ['platform-sim', 'flaky']) {
    const r = cli([command, '--root', root], { cwd: root })
    assert.equal(r.status, 2, `${command}: ${r.stdout}${r.stderr}`)
    assert.match(r.stdout, new RegExp(`${command} needs a command after --`))
    const empty = cli([command, '--root', root, '--'], { cwd: root })
    assert.equal(empty.status, 2, `${command} --: ${empty.stdout}${empty.stderr}`)
  }
})

// A Windows `.cmd` shim (npm, npx) does not run unshelled; it is routed through cmd.exe. Decided
// with an injected platform and file lookup, so it is pinned on every host.
test('windowsCommandArgv routes a .cmd shim through cmd.exe on win32 only', () => {
  const env = { Path: 'C:\\tools;C:\\node', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
  const files = new Set(['c:\\node\\npm.cmd', 'c:\\node\\node.exe'])
  // Case-insensitive, as a Windows file system is: PATHEXT spells `.CMD`.
  const exists = (p) => files.has(p.toLowerCase())
  assert.deepEqual(
    windowsCommandArgv(['npm', 'test'], { platform: 'win32', env, exists }),
    ['C:\\Windows\\system32\\cmd.exe', '/d', '/c', 'npm', 'test'],
  )
  assert.deepEqual(
    windowsCommandArgv(['npm.cmd', '--prefix', 'hub', 'test'], { platform: 'win32', env, exists }),
    ['C:\\Windows\\system32\\cmd.exe', '/d', '/c', 'npm.cmd', '--prefix', 'hub', 'test'],
  )
  // An .exe runs unshelled, and so does anything off win32.
  assert.deepEqual(windowsCommandArgv(['node', 'x.mjs'], { platform: 'win32', env, exists }), ['node', 'x.mjs'])
  assert.deepEqual(windowsCommandArgv(['npm', 'test'], { platform: 'linux', env, exists }), ['npm', 'test'])
  // A name that resolves to nothing is left for the spawn to report.
  assert.deepEqual(windowsCommandArgv(['nope', 'x'], { platform: 'win32', env, exists }), ['nope', 'x'])
  // cmd.exe would read these characters itself, so they are refused rather than quoted by guess.
  assert.throws(() => windowsCommandArgv(['npm', 'test', 'a&b'], { platform: 'win32', env, exists }), /cmd\.exe/)
  assert.throws(() => windowsCommandArgv(['npm', 'run', '"x"'], { platform: 'win32', env, exists }), /cmd\.exe/)
})

// Every character cmd.exe reads itself, one row each, so dropping any one from the rule fails.
test('windowsCommandArgv refuses each cmd.exe metacharacter in a shim argument', () => {
  const env = { PATH: 'C:\\node', PATHEXT: '.CMD' }
  const exists = (p) => p.toLowerCase() === 'c:\\node\\npm.cmd'
  for (const ch of ['"', '&', '|', '<', '>', '^', '%', '!', '\r', '\n']) {
    assert.throws(() => windowsCommandArgv(['npm', 'test', `a${ch}b`], { platform: 'win32', env, exists }), /cmd\.exe/, JSON.stringify(ch))
  }
  // A plain argument with a space passes: node quotes it and cmd.exe keeps the quotes.
  assert.deepEqual(windowsCommandArgv(['npm', 'run', 'a b'], { platform: 'win32', env, exists }), ['cmd.exe', '/d', '/c', 'npm', 'run', 'a b'])
})

test('windowsCommandArgv refuses a shim whose own path holds whitespace', () => {
  assert.throws(
    () => windowsCommandArgv(['C:\\Program Files\\nodejs\\npm.cmd', 'test'], { platform: 'win32', env: {}, exists: () => false }),
    /cmd\.exe/,
  )
})

// flaky's filtered retry joins test names with `|` and may quote them, which cmd.exe cannot carry.
// When the first attempt's argv went through, a refused retry reruns that whole command instead.
test('shimmedExec reruns the whole command when a filtered retry cannot pass through cmd.exe', async () => {
  const env = { PATH: 'C:\\node', PATHEXT: '.CMD', ComSpec: 'cmd.exe' }
  const exists = (p) => p.toLowerCase() === 'c:\\node\\npm.cmd'
  const spawned = []
  const notes = []
  const exec = shimmedExec({ platform: 'win32', exists, run: async (argv) => { spawned.push(argv); return { code: 0 } }, onFallback: (text) => notes.push(text) })
  await exec(['npm', 'test'], { cwd: '.', env })
  await exec(['npm', 'test', '--', '--test-name-pattern', '^(a|b)$'], { cwd: '.', env })
  assert.deepEqual(spawned, [['cmd.exe', '/d', '/c', 'npm', 'test'], ['cmd.exe', '/d', '/c', 'npm', 'test']])
  assert.equal(notes.length, 1)
  // A first argv cmd.exe cannot carry is still refused: there is no earlier command to fall back to.
  const fresh = shimmedExec({ platform: 'win32', exists, run: async () => ({ code: 0 }) })
  await assert.rejects(fresh(['npm', 'test', 'a|b'], { cwd: '.', env }), /cmd\.exe/)
  // Off win32 nothing is rewritten.
  const posix = []
  const plain = shimmedExec({ platform: 'linux', exists, run: async (argv) => { posix.push(argv); return { code: 0 } } })
  await plain(['npm', 'test', 'a|b'], { cwd: '.', env })
  assert.deepEqual(posix, [['npm', 'test', 'a|b']])
})

test('a command that wraps nothing still refuses a stray --', async (t) => {
  const { root, io, lines } = await repo(t)
  lines.length = 0
  assert.equal(await runCli(['doctor', '--run', 'r1', '--plan', 'plan.md', '--root', root, '--', 'foo'], io), 2)
  assert.match(lines.join('\n'), /doctor does not take --/)
})

// ---------------------------------------------------------------------------------------------
// flaky

async function flakySetup(t, fails) {
  const root = await tempDir(t, 'fm-cirel-flaky-')
  const counter = path.join(root, 'counter')
  const report = path.join(root, 'report.xml')
  const env = cleanEnv({ FLAKY_COUNTER: counter, FLAKY_FAILS: String(fails), FLAKY_REPORT: report })
  const runs = async () => Number.parseInt(await readFile(counter, 'utf8').catch(() => '0'), 10)
  return { root, report, env, runs }
}

test('flaky exits 0 on one failure and names the test from the report', async (t) => {
  const { root, report, env, runs } = await flakySetup(t, 1)
  const r = cli(['flaky', '--root', root, '--report', report, '--', process.execPath, FAILS_N_TIMES], { cwd: root, env })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^flaky: fixture::t1$/m)
  assert.equal(await runs(), 2)
})

test('flaky exits with the original code when the retry fails too', async (t) => {
  const { root, report, env, runs } = await flakySetup(t, 2)
  const r = cli(['flaky', '--root', root, '--report', report, '--', process.execPath, FAILS_N_TIMES], { cwd: root, env })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout, /^flaky: fixture::t1$/m)
  assert.equal(await runs(), 2)
})

test('flaky exits 2 on a malformed quarantine file and runs nothing', async (t) => {
  const { root, report, env, runs } = await flakySetup(t, 0)
  await writeFile(path.join(root, QUARANTINE_FILE), '{"v": 1, "tests": [', 'utf8')
  const r = cli(['flaky', '--root', root, '--report', report, '--', process.execPath, FAILS_N_TIMES], { cwd: root, env })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stdout, /fleetmates\.flaky\.json/)
  assert.equal(await runs(), 0, 'the command must not run on a malformed store')
})

test('quarantineWritable: the main worktree top level and CI only', async (t) => {
  const root = await tempDir(t, 'fm-cirel-wt-')
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  await writeFile(path.join(root, 'a'), 'a\n')
  await mkdir(path.join(root, 'sub'))
  await writeFile(path.join(root, 'sub', 'b'), 'b\n')
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'i'])
  const linked = path.join(await tempDir(t, 'fm-cirel-linked-'), 'wt')
  git(root, ['worktree', 'add', '--quiet', '-b', 'side', linked])
  const outside = await tempDir(t, 'fm-cirel-nogit-')

  const local = cleanEnv()
  assert.equal(await quarantineWritable(root, local), true, 'main worktree top level')
  assert.equal(await quarantineWritable(linked, local), false, 'a linked (teammate) worktree')
  assert.equal(await quarantineWritable(path.join(root, 'sub'), local), false, 'below the top level')
  assert.equal(await quarantineWritable(outside, local), false, 'outside any repository')
  assert.equal(await quarantineWritable(linked, cleanEnv({ GITHUB_ACTIONS: 'true' })), true, 'in CI')
  assert.equal(await quarantineWritable(linked, cleanEnv({ GITHUB_ACTIONS: 'false' })), false)

  // End to end: a flake in the main worktree is recorded; the same flake in a teammate's is not.
  for (const [dir, written] of [[root, true], [linked, false]]) {
    const counter = path.join(outside, `counter-${written}`)
    const report = path.join(outside, `report-${written}.xml`)
    const env = cleanEnv({ FLAKY_COUNTER: counter, FLAKY_FAILS: '1', FLAKY_REPORT: report })
    const r = cli(['flaky', '--root', dir, '--report', report, '--', process.execPath, FAILS_N_TIMES], { cwd: dir, env })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(existsSync(path.join(dir, QUARANTINE_FILE)), written, dir)
  }
  const store = JSON.parse(await readFile(path.join(root, QUARANTINE_FILE), 'utf8'))
  assert.deepEqual(Object.keys(store.tests), ['fixture::t1'])
})

// ---------------------------------------------------------------------------------------------
// review-dispatch and collect-reviews: the portability lens

async function reviewRepo(t, workflow) {
  const ctx = await repo(t)
  const { root, io } = ctx
  assert.equal(await runCli(['init-run', path.join(root, 'plan.md'), '--run', 'r1', '--root', root], io), 0)
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({
    lens: ['correctness'],
    phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer', blockOn: ['high'] }] } },
  }), 'utf8')
  if (workflow) await writeWorkflow(root, workflow)
  git(root, ['checkout', '--quiet', '-b', 'fleetmates/r1/T1'])
  await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
  git(root, ['add', 'a.mjs'])
  git(root, ['commit', '--quiet', '-m', 'T1 work'])
  git(root, ['checkout', '--quiet', 'run-branch'])
  return ctx
}

async function dispatchedLenses(ctx) {
  ctx.lines.length = 0
  const code = await runCli(['review-dispatch', '--run', 'r1', '--phase', '1', '--root', ctx.root], ctx.io)
  assert.equal(code, 0, ctx.lines.join('\n'))
  return JSON.parse(ctx.lines.join('\n')).reviewers.map((r) => r.findingsPath.match(/1-([a-z]+)\.json$/)[1])
}

test('review-dispatch adds a portability reviewer when the CI matrix includes Windows', async (t) => {
  const ctx = await reviewRepo(t, WINDOWS_WORKFLOW)
  assert.deepEqual(await dispatchedLenses(ctx), ['correctness', 'portability'])
})

test('review-dispatch adds no portability reviewer for a Linux-only CI', async (t) => {
  const ctx = await reviewRepo(t, LINUX_WORKFLOW)
  assert.deepEqual(await dispatchedLenses(ctx), ['correctness'])
})

// An explicit empty lens list is not topped up with `portability`: a phase that dispatches no
// review must not dispatch one because the CI runs on Windows.
test('review-dispatch keeps an explicit empty lens list empty under a Windows CI', async (t) => {
  const ctx = await reviewRepo(t, WINDOWS_WORKFLOW)
  await writeFile(path.join(ctx.root, 'fleetmates.gate.json'), JSON.stringify({
    lens: ['correctness'],
    phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer', lens: [], blockOn: ['high'] }] } },
  }), 'utf8')
  ctx.lines.length = 0
  await runCli(['review-dispatch', '--run', 'r1', '--phase', '1', '--root', ctx.root], ctx.io)
  assert.doesNotMatch(ctx.lines.join('\n'), /portability/)
})

// The lens review-dispatch added is one collect-reviews expects: otherwise its findings file is
// "ignored" and the round passes without the portability review.
test('collect-reviews expects the portability lens review-dispatch added', async (t) => {
  const ctx = await reviewRepo(t, WINDOWS_WORKFLOW)
  ctx.lines.length = 0
  assert.equal(await runCli(['collect-reviews', '--run', 'r1', '--phase', '1', '--root', ctx.root], ctx.io), 4)
  assert.match(ctx.lines.join('\n'), /no findings file for lens\(es\): correctness, portability/)
})

// ---------------------------------------------------------------------------------------------
// doctor

async function doctorOutput(ctx) {
  ctx.lines.length = 0
  await runCli(['init-run', path.join(ctx.root, 'plan.md'), '--run', 'r1', '--root', ctx.root], ctx.io)
  ctx.lines.length = 0
  await runCli(['doctor', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', ctx.root], ctx.io)
  return ctx.lines.join('\n')
}

test('doctor prints each ciAdvice warning under a CI: heading', async (t) => {
  const ctx = await repo(t)
  await writeWorkflow(ctx.root, WEAK_WORKFLOW)
  const out = await doctorOutput(ctx)
  const lines = out.split('\n')
  const heading = lines.indexOf('CI:')
  assert.ok(heading >= 0, out)
  const advice = lines.slice(heading + 1).filter((l) => l.startsWith('  '))
  assert.equal(advice.length, 3, out)
  assert.match(advice.join('\n'), /push to any branch/)
  assert.match(advice.join('\n'), /single OS \(linux\)/)
  assert.match(advice.join('\n'), /flaky detector/)
})

test('doctor prints nothing CI-related when there is no .github/workflows', async (t) => {
  const ctx = await repo(t)
  const out = await doctorOutput(ctx)
  assert.doesNotMatch(out, /^CI:/m)
  assert.doesNotMatch(out, /workflow/i)
})

test('doctor suggests releasing a quarantined test after a long pass streak', async (t) => {
  const ctx = await repo(t)
  const entry = (passStreak) => ({ firstSeen: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-01T00:00:00.000Z', flakes: 1, passStreak })
  await writeFile(path.join(ctx.root, QUARANTINE_FILE), JSON.stringify({ v: 1, tests: { 'a::b::steady': entry(20), 'a::b::shaky': entry(19) } }), 'utf8')
  const out = await doctorOutput(ctx)
  assert.match(out, /a::b::steady passed 20 times in a row/)
  assert.doesNotMatch(out, /shaky/)
})

// ---------------------------------------------------------------------------------------------
// ci-wait: judges the GitHub Actions workflow runs of the tip commit (spec section 4)

function workflowRun(id, name, sha, status, conclusion = null, { attempt = 1, event = 'push' } = {}) {
  return { id, run_attempt: attempt, name, event, head_sha: sha, status, conclusion, html_url: `https://github.com/o/r/actions/runs/${id}` + (attempt > 1 ? `/attempts/${attempt}` : '') }
}

// A fake clock and gh: `snapshots(sha, call)` answers each poll with the workflow runs; sleep
// advances the clock. `total` overrides total_count.
function ciIo(ctx, snapshots, { total } = {}) {
  let clock = 1_000_000
  const calls = []
  return {
    calls,
    io: {
      ...ctx.io,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      ciExec: async (argv, opts) => {
        calls.push({ argv, cwd: opts?.cwd })
        const sha = /head_sha=([0-9a-f]+)/.exec(argv[2])?.[1]
        const runs = snapshots(sha, calls.length)
        return { code: 0, stdout: JSON.stringify({ total_count: total ?? runs.length, workflow_runs: runs }), stderr: '' }
      },
    },
  }
}

// The workflow is COMMITTED: ci-wait reads whether workflows exist from the tip commit's tree.
async function ciRepo(t, { workflow = LINUX_WORKFLOW } = {}) {
  const ctx = await repo(t)
  if (workflow) {
    await writeWorkflow(ctx.root, workflow)
    git(ctx.root, ['add', '.github'])
    git(ctx.root, ['commit', '--quiet', '-m', 'ci'])
  }
  const sha = git(ctx.root, ['rev-parse', 'run-branch']).trim()
  return { ...ctx, sha }
}

async function ciWait(ctx, io, extra = []) {
  ctx.lines.length = 0
  return runCli(['ci-wait', '--branch', 'run-branch', ...extra, '--root', ctx.root], io)
}

test('ci-wait exits 0 when every workflow run on the tip succeeded, asking for the tip\'s runs', async (t) => {
  const ctx = await ciRepo(t)
  const { io, calls } = ciIo(ctx, (sha) => [workflowRun(10, 'test', sha, 'completed', 'success'), workflowRun(11, 'deck', sha, 'completed', 'success')])
  assert.equal(await ciWait(ctx, io), 0, ctx.lines.join('\n'))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].argv, ['gh', 'api', `repos/{owner}/{repo}/actions/runs?head_sha=${ctx.sha}&per_page=100`])
  assert.equal(calls[0].cwd, ctx.root)
})

// The reviewer's repro: run 10 failed and run 11 passed under one workflow name (the push and the
// pull_request runs of one workflow). Grouping by name hid the failure.
test('ci-wait exits 1 when the push run of a workflow fails beside its passing pull_request run', async (t) => {
  const ctx = await ciRepo(t)
  const { io } = ciIo(ctx, (sha) => [
    workflowRun(10, 'test', sha, 'completed', 'failure', { event: 'push' }),
    workflowRun(11, 'test', sha, 'completed', 'success', { event: 'pull_request' }),
  ])
  assert.equal(await ciWait(ctx, io), 1, ctx.lines.join('\n'))
  assert.match(ctx.lines.join('\n'), /test.*failure.*https:\/\/github\.com\/o\/r\/actions\/runs\/10\b/)
})

test('ci-wait exits 1 when one of two workflows with same-named jobs fails', async (t) => {
  const ctx = await ciRepo(t)
  const { io } = ciIo(ctx, (sha) => [
    workflowRun(20, 'test', sha, 'completed', 'success'),
    workflowRun(21, 'deck', sha, 'completed', 'timed_out'),
  ])
  assert.equal(await ciWait(ctx, io), 1, ctx.lines.join('\n'))
  assert.match(ctx.lines.join('\n'), /deck.*timed_out.*runs\/21/)
})

test('ci-wait fails every non-success conclusion of a completed run', async (t) => {
  const ctx = await ciRepo(t)
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']) {
    const { io } = ciIo(ctx, (sha) => [workflowRun(30, 'test', sha, 'completed', conclusion)])
    assert.equal(await ciWait(ctx, io), 1, `${conclusion}: ${ctx.lines.join('\n')}`)
  }
})

test('ci-wait counts the latest attempt of a re-run', async (t) => {
  const ctx = await ciRepo(t)
  const passed = ciIo(ctx, (sha) => [
    workflowRun(40, 'test', sha, 'completed', 'failure', { attempt: 1 }),
    workflowRun(40, 'test', sha, 'completed', 'success', { attempt: 2 }),
  ])
  assert.equal(await ciWait(ctx, passed.io), 0, ctx.lines.join('\n'))
  // And the other way round, listed in the opposite order: the newer attempt failed.
  const failed = ciIo(ctx, (sha) => [
    workflowRun(40, 'test', sha, 'completed', 'failure', { attempt: 2 }),
    workflowRun(40, 'test', sha, 'completed', 'success', { attempt: 1 }),
  ])
  assert.equal(await ciWait(ctx, failed.io), 1, ctx.lines.join('\n'))
})

test('ci-wait exits 3 when a run is still in progress beside a passing one past --minutes', async (t) => {
  const ctx = await ciRepo(t)
  const { io, calls } = ciIo(ctx, (sha) => [workflowRun(50, 'test', sha, 'completed', 'success'), workflowRun(51, 'deck', sha, 'in_progress')])
  assert.equal(await ciWait(ctx, io, ['--minutes', '1']), 3, ctx.lines.join('\n'))
  assert.match(ctx.lines.join('\n'), /deck.*runs\/51/)
  // Every 30 s over one minute: at 0, 30 and 60 s.
  assert.equal(calls.length, 3)
})

test('ci-wait treats queued and waiting runs as pending', async (t) => {
  const ctx = await ciRepo(t)
  for (const status of ['queued', 'waiting', 'requested', 'pending']) {
    const { io } = ciIo(ctx, (sha) => [workflowRun(52, 'test', sha, status)])
    assert.equal(await ciWait(ctx, io, ['--minutes', '1']), 3, `${status}: ${ctx.lines.join('\n')}`)
  }
})

test('ci-wait polls an in-progress run until it passes', async (t) => {
  const ctx = await ciRepo(t)
  const { io, calls } = ciIo(ctx, (sha, call) => [workflowRun(60, 'test', sha, call < 3 ? 'in_progress' : 'completed', call < 3 ? null : 'success')])
  assert.equal(await ciWait(ctx, io, ['--minutes', '5']), 0, ctx.lines.join('\n'))
  assert.equal(calls.length, 3)
})

test('ci-wait treats a tip with no workflow run yet as pending, not passed', async (t) => {
  const ctx = await ciRepo(t)
  const { io } = ciIo(ctx, () => [])
  assert.equal(await ciWait(ctx, io, ['--minutes', '1']), 3, ctx.lines.join('\n'))
})

test('ci-wait refuses with exit 4 when the tip has more workflow runs than one page holds', async (t) => {
  const ctx = await ciRepo(t)
  // A full, consistent response of 101 passing runs: refused for its size alone.
  const { io } = ciIo(ctx, (sha) => Array.from({ length: 101 }, (_, i) => workflowRun(100 + i, 'test', sha, 'completed', 'success')))
  assert.equal(await ciWait(ctx, io), 4, ctx.lines.join('\n'))
  assert.match(ctx.lines.join('\n'), /101/)
})

test('ci-wait reads its window from ci.waitMinutes when --minutes is absent', async (t) => {
  const ctx = await ciRepo(t)
  assert.equal(await runCli(['config', 'set', 'ci.waitMinutes', '2', '--root', ctx.root], ctx.io), 0)
  const { io, calls } = ciIo(ctx, (sha) => [workflowRun(80, 'test', sha, 'queued')])
  assert.equal(await ciWait(ctx, io), 3, ctx.lines.join('\n'))
  assert.equal(calls.length, 5)
})

test('ci-wait exits 4 naming gh when gh is missing', async (t) => {
  const ctx = await ciRepo(t)
  const io = {
    ...ctx.io,
    now: () => 0,
    sleep: async () => {},
    ciExec: async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) },
  }
  assert.equal(await ciWait(ctx, io), 4)
  assert.match(ctx.lines.join('\n'), /`gh` is not installed or not on PATH/)
})

test('ci-wait exits 4 when gh cannot read the workflow runs', async (t) => {
  const ctx = await ciRepo(t)
  const io = { ...ctx.io, now: () => 0, sleep: async () => {}, ciExec: async () => ({ code: 1, stdout: '', stderr: 'gh auth login required\n' }) }
  assert.equal(await ciWait(ctx, io), 4)
  assert.match(ctx.lines.join('\n'), /could not be read/)
})

test('ci-wait skips with exit 0 when the project has no CI workflows, and never calls gh', async (t) => {
  const ctx = await ciRepo(t, { workflow: null })
  const { io, calls } = ciIo(ctx, () => { throw new Error('gh must not be called') })
  assert.equal(await ciWait(ctx, io), 0)
  assert.match(ctx.lines.join('\n'), /no CI workflows: skipped/)
  assert.equal(calls.length, 0)
})

// Whether there is CI to wait for is a property of the pushed commit, not of the working tree.
test('ci-wait reads whether workflows exist from the tip commit\'s tree, not the working tree', async (t) => {
  // Uncommitted workflow: the tip has none, so there is nothing to wait for.
  const uncommitted = await ciRepo(t, { workflow: null })
  await writeWorkflow(uncommitted.root, LINUX_WORKFLOW)
  const first = ciIo(uncommitted, () => { throw new Error('gh must not be called') })
  assert.equal(await ciWait(uncommitted, first.io), 0, uncommitted.lines.join('\n'))
  assert.match(uncommitted.lines.join('\n'), /no CI workflows: skipped/)
  assert.equal(first.calls.length, 0)

  // Committed on the tip, deleted from the working tree: the tip's CI is still read.
  const committed = await ciRepo(t)
  await rm(path.join(committed.root, '.github'), { recursive: true, force: true })
  const second = ciIo(committed, (sha) => [workflowRun(90, 'test', sha, 'completed', 'success')])
  assert.equal(await ciWait(committed, second.io), 0, committed.lines.join('\n'))
  assert.equal(second.calls.length, 1)
})

test('ci-wait refuses a branch that does not exist and a bad --minutes with exit 2', async (t) => {
  const ctx = await ciRepo(t)
  const { io, calls } = ciIo(ctx, () => { throw new Error('gh must not be called') })
  assert.equal(await runCli(['ci-wait', '--branch', 'no-such-branch', '--root', ctx.root], io), 2)
  for (const bad of ['0', '721', '1.5', 'x']) {
    assert.equal(await runCli(['ci-wait', '--branch', 'run-branch', '--minutes', bad, '--root', ctx.root], io), 2, bad)
  }
  assert.equal(calls.length, 0)
})

test('judgeWorkflowRuns ignores runs on another commit and refuses an unreadable response', () => {
  const sha = 'a'.repeat(40)
  const other = 'b'.repeat(40)
  const snap = (runs) => ({ total_count: runs.length, workflow_runs: runs })
  assert.equal(judgeWorkflowRuns(sha, snap([workflowRun(1, 'test', sha, 'completed', 'success'), workflowRun(2, 'test', other, 'completed', 'failure')])).state, 'pass')
  assert.equal(judgeWorkflowRuns(sha, snap([workflowRun(3, 'x', other, 'completed', 'success')])).state, 'pending')
  assert.equal(judgeWorkflowRuns(sha, { nope: true }).state, 'unreadable')
  assert.equal(judgeWorkflowRuns(sha, { total_count: 2, workflow_runs: [workflowRun(1, 'test', sha, 'completed', 'success')] }).state, 'unreadable')
})

// ---------------------------------------------------------------------------------------------
// config

test('config accepts ci.push auto and ci.waitMinutes 30, and refuses ci.push yes', async (t) => {
  const { root, io, lines } = await repo(t)
  assert.equal(await runCli(['config', 'set', 'ci.push', 'auto', '--root', root], io), 0, lines.join('\n'))
  assert.equal(await runCli(['config', 'set', 'ci.waitMinutes', '30', '--root', root], io), 0, lines.join('\n'))
  lines.length = 0
  assert.equal(await runCli(['config', 'get', 'ci.push', '--root', root], io), 0)
  assert.equal(await runCli(['config', 'get', 'ci.waitMinutes', '--root', root], io), 0)
  assert.deepEqual(lines, ['auto', '30'])
  for (const [key, value] of [['ci.push', 'yes'], ['ci.waitMinutes', '0'], ['ci.waitMinutes', '721'], ['ci.waitMinutes', '1.5'], ['ci.bogus', '1']]) {
    lines.length = 0
    assert.equal(await runCli(['config', 'set', key, value, '--root', root], io), 2, `${key} ${value}`)
  }
  // The local layer takes the block too, and a malformed one is refused by every reader.
  assert.equal(await runCli(['config', 'set', 'ci.push', 'ask', '--local', '--root', root], io), 0)
  await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify({ ci: { push: 'sometimes' } }), 'utf8')
  assert.equal(await runCli(['config', 'get', 'ci.push', '--root', root], io), 2)
})

test('config defaults ci.push to ask and ci.waitMinutes to 60', async (t) => {
  const { root, io, lines } = await repo(t)
  lines.length = 0
  assert.equal(await runCli(['config', 'get', 'ci.push', '--root', root], io), 0)
  assert.equal(await runCli(['config', 'get', 'ci.waitMinutes', '--root', root], io), 0)
  assert.deepEqual(lines, ['ask', '60'])
})
