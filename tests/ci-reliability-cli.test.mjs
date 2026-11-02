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
import { runCli, windowsCommandArgv, quarantineWritable, judgeCheckRuns } from '../scripts/cli.mjs'
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
// ci-wait

const APP = { slug: 'github-actions' }
function checkRun(id, name, sha, status, conclusion = null) {
  return { id, name, head_sha: sha, status, conclusion, app: APP, html_url: `https://github.com/o/r/actions/runs/9/job/${id}` }
}

// A fake clock and gh: `snapshots(sha, call)` answers each poll; sleep advances the clock.
function ciIo(ctx, snapshots) {
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
        const sha = /commits\/([0-9a-f]+)\/check-runs/.exec(argv[2])?.[1]
        const runs = snapshots(sha, calls.length)
        return { code: 0, stdout: JSON.stringify({ total_count: runs.length, check_runs: runs }), stderr: '' }
      },
    },
  }
}

async function ciRepo(t, { workflow = LINUX_WORKFLOW } = {}) {
  const ctx = await repo(t)
  if (workflow) await writeWorkflow(ctx.root, workflow)
  const sha = git(ctx.root, ['rev-parse', 'run-branch']).trim()
  return { ...ctx, sha }
}

test('ci-wait exits 0 when every check run on the tip passed', async (t) => {
  const ctx = await ciRepo(t)
  const { io, calls } = ciIo(ctx, (sha) => [checkRun(1, 'test (ubuntu)', sha, 'completed', 'success'), checkRun(2, 'lint', sha, 'completed', 'success')])
  const code = await runCli(['ci-wait', '--branch', 'run-branch', '--root', ctx.root], io)
  assert.equal(code, 0, ctx.lines.join('\n'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].argv[0], 'gh')
  assert.equal(calls[0].argv[1], 'api')
  assert.ok(calls[0].argv[2].startsWith(`repos/{owner}/{repo}/commits/${ctx.sha}/check-runs`), calls[0].argv[2])
  assert.equal(calls[0].cwd, ctx.root)
})

test('ci-wait exits 1 on a failed check and prints its job URL', async (t) => {
  const ctx = await ciRepo(t)
  const { io } = ciIo(ctx, (sha) => [checkRun(1, 'test (ubuntu)', sha, 'completed', 'success'), checkRun(2, 'test (windows)', sha, 'completed', 'failure'), checkRun(3, 'slow', sha, 'in_progress')])
  const code = await runCli(['ci-wait', '--branch', 'run-branch', '--root', ctx.root], io)
  assert.equal(code, 1, ctx.lines.join('\n'))
  assert.match(ctx.lines.join('\n'), /test \(windows\).*https:\/\/github\.com\/o\/r\/actions\/runs\/9\/job\/2/)
})

test('ci-wait polls a pending check until it passes', async (t) => {
  const ctx = await ciRepo(t)
  const { io, calls } = ciIo(ctx, (sha, call) => [checkRun(1, 'test', sha, call < 3 ? 'in_progress' : 'completed', call < 3 ? null : 'success')])
  assert.equal(await runCli(['ci-wait', '--branch', 'run-branch', '--minutes', '5', '--root', ctx.root], io), 0, ctx.lines.join('\n'))
  assert.equal(calls.length, 3)
})

test('ci-wait exits 3 when a check is still pending past --minutes', async (t) => {
  const ctx = await ciRepo(t)
  const { io, calls } = ciIo(ctx, (sha) => [checkRun(1, 'test', sha, 'completed', 'success'), checkRun(2, 'slow', sha, 'queued')])
  const code = await runCli(['ci-wait', '--branch', 'run-branch', '--minutes', '1', '--root', ctx.root], io)
  assert.equal(code, 3, ctx.lines.join('\n'))
  assert.match(ctx.lines.join('\n'), /slow/)
  // Every 30 s over one minute: at 0, 30 and 60 s.
  assert.equal(calls.length, 3)
})

test('ci-wait treats a tip with no check runs yet as pending, not passed', async (t) => {
  const ctx = await ciRepo(t)
  const { io } = ciIo(ctx, () => [])
  assert.equal(await runCli(['ci-wait', '--branch', 'run-branch', '--minutes', '1', '--root', ctx.root], io), 3, ctx.lines.join('\n'))
})

test('ci-wait reads its window from ci.waitMinutes when --minutes is absent', async (t) => {
  const ctx = await ciRepo(t)
  assert.equal(await runCli(['config', 'set', 'ci.waitMinutes', '2', '--root', ctx.root], ctx.io), 0)
  const { io, calls } = ciIo(ctx, (sha) => [checkRun(1, 'slow', sha, 'queued')])
  assert.equal(await runCli(['ci-wait', '--branch', 'run-branch', '--root', ctx.root], io), 3, ctx.lines.join('\n'))
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
  assert.equal(await runCli(['ci-wait', '--branch', 'run-branch', '--root', ctx.root], io), 4)
  assert.match(ctx.lines.join('\n'), /`gh`/)
})

test('ci-wait exits 4 when gh cannot read the check runs', async (t) => {
  const ctx = await ciRepo(t)
  const io = { ...ctx.io, now: () => 0, sleep: async () => {}, ciExec: async () => ({ code: 1, stdout: '', stderr: 'gh auth login required\n' }) }
  assert.equal(await runCli(['ci-wait', '--branch', 'run-branch', '--root', ctx.root], io), 4)
  assert.match(ctx.lines.join('\n'), /could not be read/)
})

test('ci-wait skips with exit 0 when the project has no CI workflows, and never calls gh', async (t) => {
  const ctx = await ciRepo(t, { workflow: null })
  const { io, calls } = ciIo(ctx, () => { throw new Error('gh must not be called') })
  assert.equal(await runCli(['ci-wait', '--branch', 'run-branch', '--root', ctx.root], io), 0)
  assert.match(ctx.lines.join('\n'), /no CI workflows: skipped/)
  assert.equal(calls.length, 0)
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

test('judgeCheckRuns ignores check runs on another commit', () => {
  const sha = 'a'.repeat(40)
  const other = 'b'.repeat(40)
  const runs = [checkRun(1, 'test', sha, 'completed', 'success'), checkRun(2, 'test', other, 'completed', 'failure')]
  assert.equal(judgeCheckRuns(sha, { total_count: 2, check_runs: runs }).state, 'pass')
  // A check that ran only on another commit is not required of this one.
  const elsewhere = [checkRun(1, 'test', sha, 'completed', 'success'), checkRun(2, 'lint', other, 'completed', 'failure')]
  assert.equal(judgeCheckRuns(sha, { total_count: 2, check_runs: elsewhere }).state, 'pass')
  assert.equal(judgeCheckRuns(sha, { total_count: 1, check_runs: [checkRun(3, 'x', other, 'completed', 'success')] }).state, 'pending')
  assert.equal(judgeCheckRuns(sha, { nope: true }).state, 'unreadable')
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
