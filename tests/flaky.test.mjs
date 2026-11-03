import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir, symlink, mkdir, realpath } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  QUARANTINE_FILE, RELEASE_STREAK, QUARANTINE_MAX_BYTES, FlakyConfigError, readQuarantine, writeQuarantine, retryArgv, runFlaky,
} from '../scripts/flaky.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/flaky/fails-n-times.mjs', import.meta.url))
const ARGV = [process.execPath, FIXTURE]
const COMMAND_ID = ARGV.join(' ')
const NOW = Date.parse('2026-11-02T10:00:00.000Z')

// The suite itself may run inside GitHub Actions; these variables must reach the detector only
// when a test sets them.
function cleanEnv(extra = {}) {
  const env = { ...process.env }
  delete env.GITHUB_ACTIONS
  delete env.GITHUB_STEP_SUMMARY
  return { ...env, ...extra }
}

async function setup(t, { fails, report = false }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flaky-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const counter = path.join(root, 'counter')
  const reportPath = report ? path.join(root, 'report.xml') : null
  const env = cleanEnv({ FLAKY_COUNTER: counter, FLAKY_FAILS: String(fails), ...(reportPath ? { FLAKY_REPORT: reportPath } : {}) })
  const out = []
  const write = (text) => { out.push(text) }
  const runs = async () => Number.parseInt(await readFile(counter, 'utf8').catch(() => '0'), 10)
  return { root, counter, reportPath, env, out, write, runs }
}

async function quarantineOf(root) {
  return JSON.parse(await readFile(path.join(root, QUARANTINE_FILE), 'utf8'))
}

async function hasQuarantine(root) {
  return (await readdir(root)).includes(QUARANTINE_FILE)
}

test('constants match the plan', () => {
  assert.equal(QUARANTINE_FILE, 'fleetmates.flaky.json')
  assert.equal(RELEASE_STREAK, 20)
})

test('fails 0 times: exit 0, no retry, quarantine untouched', async (t) => {
  const s = await setup(t, { fails: 0 })
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.equal(r.retried, 'none')
  assert.deepEqual(r.flaky, [])
  assert.equal(await s.runs(), 1)
  assert.equal(await hasQuarantine(s.root), false)
})

test('fails once without a report: exit 0, the whole command is flaky and quarantined', async (t) => {
  const s = await setup(t, { fails: 1 })
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.equal(r.retried, 'whole')
  assert.deepEqual(r.flaky, [COMMAND_ID])
  assert.equal(await s.runs(), 2)
  const iso = new Date(NOW).toISOString()
  assert.deepEqual(await quarantineOf(s.root), { v: 1, tests: { [COMMAND_ID]: { firstSeen: iso, lastSeen: iso, flakes: 1, passStreak: 0 } } })
  assert.match(s.out.join(''), /^flaky: /m)
})

test('fails once with a report: exit 0, t1 is flaky and quarantined', async (t) => {
  const s = await setup(t, { fails: 1, report: true })
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.deepEqual(r.flaky, ['fixture::t1'])
  const iso = new Date(NOW).toISOString()
  assert.deepEqual(await quarantineOf(s.root), { v: 1, tests: { 'fixture::t1': { firstSeen: iso, lastSeen: iso, flakes: 1, passStreak: 0 } } })
  assert.match(s.out.join(''), /^flaky: fixture::t1$/m)
})

test('a filtered retry is used when the runner is known and the report names the failures', async (t) => {
  const s = await setup(t, { fails: 1, report: true })
  const seen = []
  // Records each argv, then runs the fixture regardless: the fixture ignores its arguments.
  const exec = (argv, { cwd, env }) => {
    seen.push(argv)
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [FIXTURE], { cwd, env, stdio: 'ignore' })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code }))
    })
  }
  const argv = ['node', '--test', 'tests/a.test.mjs']
  const r = await runFlaky(argv, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.equal(r.retried, 'filtered')
  assert.deepEqual(seen, [argv, ['node', '--test', '--test-name-pattern=t1', 'tests/a.test.mjs']])
})

test('fails twice: the original exit code and no quarantine change', async (t) => {
  const s = await setup(t, { fails: 2, report: true })
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.equal(r.code, 1)
  assert.deepEqual(r.flaky, [])
  assert.equal(await s.runs(), 2)
  assert.equal(await hasQuarantine(s.root), false)
})

test('a quarantined test that fails twice: exit 0 with a quarantined warning', async (t) => {
  const s = await setup(t, { fails: 2, report: true })
  const before = { v: 1, tests: { 'fixture::t1': { firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-01T00:00:00.000Z', flakes: 3, passStreak: 4 } } }
  await writeFile(path.join(s.root, QUARANTINE_FILE), JSON.stringify(before))
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.deepEqual(r.quarantinedFailures, ['fixture::t1'])
  assert.deepEqual(r.flaky, [])
  assert.match(s.out.join(''), /^flaky: quarantined test failed: fixture::t1$/m)
})

test('a quarantined test that passes: passStreak + 1, flakes unchanged', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  const before = { v: 1, tests: { 'fixture::t1': { firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-01T00:00:00.000Z', flakes: 3, passStreak: 4 } } }
  await writeFile(path.join(s.root, QUARANTINE_FILE), JSON.stringify(before))
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  const after = await quarantineOf(s.root)
  assert.equal(after.tests['fixture::t1'].passStreak, 5)
  assert.equal(after.tests['fixture::t1'].flakes, 3)
})

test('a malformed quarantine file throws FlakyConfigError naming the file, and no command runs', async (t) => {
  for (const content of ['{ not json', JSON.stringify({ v: 2, tests: {} }), JSON.stringify({ v: 1, tests: { t1: { flakes: 'x' } } })]) {
    const s = await setup(t, { fails: 0 })
    await writeFile(path.join(s.root, QUARANTINE_FILE), content)
    await assert.rejects(readQuarantine(s.root), (err) => err instanceof FlakyConfigError && err.message.includes(QUARANTINE_FILE))
    await assert.rejects(
      runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, write: s.write }),
      (err) => err instanceof FlakyConfigError && err.message.includes(QUARANTINE_FILE),
    )
    assert.equal(await s.runs(), 0)
  }
})

test('readQuarantine returns an empty store when the file is absent', async (t) => {
  const s = await setup(t, { fails: 0 })
  assert.deepEqual(await readQuarantine(s.root), { v: 1, tests: {} })
})

test('GITHUB_ACTIONS=true: a ::warning line per flaky test and a step summary table', async (t) => {
  const s = await setup(t, { fails: 1, report: true })
  const summary = path.join(s.root, 'summary.md')
  await writeFile(summary, 'earlier\n')
  const env = { ...s.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.match(s.out.join(''), /^::warning title=flaky::fixture::t1 passed on retry$/m)
  const md = await readFile(summary, 'utf8')
  assert.ok(md.startsWith('earlier\n'), 'the summary is appended to, not replaced')
  assert.match(md, /^\| Test \| Result \|$/m)
  assert.match(md, /^\| fixture::t1 \| flaky \|$/m)
})

test('without GITHUB_ACTIONS no ::warning line is printed', async (t) => {
  const s = await setup(t, { fails: 1, report: true })
  await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.doesNotMatch(s.out.join(''), /::warning/)
})

test('canWrite: false reports the flake but never writes the quarantine file', async (t) => {
  const s = await setup(t, { fails: 1, report: true })
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, canWrite: false, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.deepEqual(r.flaky, ['fixture::t1'])
  assert.equal(await hasQuarantine(s.root), false)
})

test('the quarantine write leaves no temp file behind', async (t) => {
  const s = await setup(t, { fails: 1, report: true })
  await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.deepEqual((await readdir(s.root)).sort(), ['counter', QUARANTINE_FILE, 'report.xml'].sort())
})

test('retryArgv: one filter flag per known runner, null for an unknown one', () => {
  assert.deepEqual(retryArgv(['node', '--test', 'a.test.mjs'], ['t1', 'a.b']),
    ['node', '--test', '--test-name-pattern=t1', '--test-name-pattern=a\\.b', 'a.test.mjs'])
  assert.deepEqual(retryArgv(['npx', 'vitest', 'run'], ['t1', 't(2)']), ['npx', 'vitest', 'run', '-t', 't1|t\\(2\\)'])
  assert.deepEqual(retryArgv(['npx', 'jest'], ['t1']), ['npx', 'jest', '-t', 't1'])
  assert.deepEqual(retryArgv(['python', '-m', 'pytest', 'tests'], ['test_a', 'test_b[1-2]']),
    ['python', '-m', 'pytest', 'tests', '-k', 'test_a or test_b'])
  assert.ok(!retryArgv(['pytest'], ['test_a']).includes('--deselect'))
  assert.equal(retryArgv(['make', 'test'], ['t1']), null)
  assert.equal(retryArgv(['node', 'script.mjs'], ['t1']), null, 'plain node without --test is not node:test')
  assert.equal(retryArgv(['npx', 'jest'], []), null)
  assert.equal(retryArgv(['pytest'], ['has space']), null, 'a name -k cannot express falls back to a whole rerun')
})

// --- Fix round 1 -------------------------------------------------------------------------------

// `cases` is [name, 'pass'|'fail'|'skip'][]; names are written into the XML as given, so a test
// can spell a control byte as a numeric character reference.
// An optional third element sets the testcase's `file` attribute; an optional fourth replaces the
// classname `c`, and `null` there leaves the classname out.
function junit(cases) {
  const body = cases.map(([name, state, file, classname = 'c']) => {
    const attrs = `name="${name}"${classname === null ? '' : ` classname="${classname}"`}${file ? ` file="${file}"` : ''}`
    return state === 'pass'
      ? `<testcase ${attrs}/>`
      : `<testcase ${attrs}>${state === 'fail' ? '<failure message="x"/>' : '<skipped/>'}</testcase>`
  }).join('')
  return `<?xml version="1.0"?>\n<testsuites><testsuite name="s">${body}</testsuite></testsuites>\n`
}

// An exec that plays one scripted step per attempt: writes `xml` to the report when given, then
// resolves `code`. `seen` records each argv and whether the report existed when the attempt began.
function scripted(steps, reportPath) {
  const seen = []
  let i = 0
  const exec = async (argv) => {
    const existed = await readFile(reportPath).then(() => true, () => false)
    seen.push({ argv, existed })
    const step = steps[i++]
    if (!step) throw new Error('more attempts than scripted')
    if (step.xml != null) await writeFile(reportPath, step.xml)
    return { code: step.code }
  }
  return { exec, seen }
}

const NODE_ARGV = ['node', '--test', 'tests/a.test.mjs']
const OLD = '2026-10-01T00:00:00.000Z'
const entry = (over = {}) => ({ firstSeen: OLD, lastSeen: OLD, flakes: 3, passStreak: 4, ...over })
async function seed(root, tests) {
  await writeFile(path.join(root, QUARANTINE_FILE), JSON.stringify({ v: 1, tests }))
}

test('without a report, a recorded whole-command entry never excuses a second failure', async (t) => {
  const s = await setup(t, { fails: 2 })
  await seed(s.root, { [COMMAND_ID]: entry() })
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, write: s.write, now: () => NOW })
  assert.equal(r.code, 1)
  assert.deepEqual(r.quarantinedFailures, [])
  assert.equal(await s.runs(), 2)
})

test('a retry that exits non-zero while its report names no failed test keeps the original code', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'c::t1': entry() })
  const { exec } = scripted([{ code: 3, xml: junit([['t1', 'fail']]) }, { code: 1, xml: junit([['t1', 'pass']]) }], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 3)
  assert.deepEqual(r.quarantinedFailures, [])
})

test('a retry that exits non-zero with no report at all keeps the original code', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'c::t1': entry() })
  const { exec } = scripted([{ code: 3, xml: junit([['t1', 'fail']]) }, { code: 1 }], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 3)
})

test('a quarantined failure is not excused when the first attempt failed outside any test', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'c::t1': entry() })
  const { exec } = scripted([{ code: 3 }, { code: 1, xml: junit([['t1', 'fail']]) }], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.retried, 'whole')
  assert.equal(r.code, 3)
  assert.deepEqual(r.quarantinedFailures, [])
})

test('a test that recovers is flaky even when a quarantined test failed twice in the same run', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'c::t1': entry() })
  const { exec, seen } = scripted([
    { code: 1, xml: junit([['t1', 'fail'], ['t2', 'fail']]) },
    { code: 1, xml: junit([['t1', 'fail'], ['t2', 'pass']]) },
  ], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.equal(r.retried, 'filtered')
  assert.equal(seen.length, 2)
  assert.deepEqual(r.quarantinedFailures, ['c::t1'])
  assert.deepEqual(r.flaky, ['c::t2'])
  const after = await quarantineOf(s.root)
  assert.equal(after.tests['c::t2'].flakes, 1)
  assert.match(s.out.join(''), /^flaky: c::t2$/m)
})

test('a quarantined test that fails resets its passStreak to 0', async (t) => {
  const s = await setup(t, { fails: 2, report: true })
  await seed(s.root, { 'fixture::t1': entry({ passStreak: 7 }) })
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  const after = await quarantineOf(s.root)
  assert.equal(after.tests['fixture::t1'].passStreak, 0)
  assert.equal(after.tests['fixture::t1'].flakes, 3)
})

test('the report file is removed before each attempt, so a stale report cannot pick the retried tests', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await writeFile(s.reportPath, junit([['t9', 'fail']]))
  const { exec, seen } = scripted([{ code: 1 }, { code: 0 }], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.deepEqual(seen.map((x) => x.existed), [false, false])
  assert.equal(r.retried, 'whole')
  assert.deepEqual(r.flaky, [NODE_ARGV.join(' ')])
})

test('a report readReport refuses is not read for names: whole-command retry', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  // The scan alone would find t1 failed; readReport refuses the DOCTYPE, so nothing is trusted.
  const doctype = `<!DOCTYPE x>${junit([['t1', 'fail']]).replace('<?xml version="1.0"?>\n', '')}`
  const { exec } = scripted([{ code: 1, xml: doctype }, { code: 0, xml: doctype }], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.equal(r.retried, 'whole')
  assert.deepEqual(r.flaky, [NODE_ARGV.join(' ')])
})

test('a symlinked report is not followed: whole-command retry', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  const real = path.join(s.root, 'real.xml')
  let n = 0
  const exec = async () => {
    await writeFile(real, junit([['t1', 'fail']]))
    await rm(s.reportPath, { force: true })
    await symlink(real, s.reportPath)
    return { code: n++ === 0 ? 1 : 0 }
  }
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.retried, 'whole')
  assert.deepEqual(r.flaky, [NODE_ARGV.join(' ')])
})

test('<skipped> is neither a pass nor a failure', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'c::t1': entry() })
  // A passing run where the quarantined t1 is skipped: its streak does not move.
  const pass = scripted([{ code: 0, xml: junit([['t1', 'skip'], ['t2', 'pass']]) }], s.reportPath)
  await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec: pass.exec, write: s.write, now: () => NOW })
  assert.equal((await quarantineOf(s.root)).tests['c::t1'].passStreak, 4)
  // A failing run where t1 is skipped and t2 failed: only t2 is retried.
  const fail = scripted([{ code: 1, xml: junit([['t1', 'skip'], ['t2', 'fail']]) }, { code: 0, xml: junit([['t2', 'pass']]) }], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec: fail.exec, write: s.write, now: () => NOW })
  assert.deepEqual(fail.seen[1].argv, ['node', '--test', '--test-name-pattern=t2', 'tests/a.test.mjs'])
  assert.deepEqual(r.flaky, ['c::t2'])
})

// Every code point below U+0020 except the line feed that ends a line, DEL, and the C1 range.
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/

function assertOneLineEach(text, prefix, count) {
  assert.doesNotMatch(text, RAW_CONTROL)
  const lines = text.split('\n').filter((l) => l.startsWith(prefix))
  assert.equal(lines.length, count, `${count} ${prefix} line(s) in ${JSON.stringify(text)}`)
}

test('a report test name with ESC, CR, LF and % reaches stdout, ::warning and the summary neutralised', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  const summary = path.join(s.root, 'summary.md')
  const env = { ...s.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }
  const evil = 't&#27;[2K&#13;fake&#10;::error::x%0A|y'
  const { exec } = scripted([{ code: 1, xml: junit([[evil, 'fail']]) }, { code: 0, xml: junit([[evil, 'pass']]) }], s.reportPath)
  const r = await runFlaky(['make', 'test'], { root: s.root, cwd: s.root, env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.flaky.length, 1)
  assert.ok(r.flaky[0].includes('\u001b'), 'the fixture really put an ESC in the name')
  const out = s.out.join('')
  // Every line the detector printed starts with one of its own prefixes.
  for (const line of out.split('\n').filter(Boolean)) assert.match(line, /^(flaky: |::warning title=flaky::)/, line)
  assertOneLineEach(out, 'flaky: ', 1)
  assertOneLineEach(out, '::warning', 1)
  // A literal `%0A` in a name must not decode to a newline in the annotation.
  assert.match(out.split('\n').find((l) => l.startsWith('::warning')), /%250A/)
  const md = await readFile(summary, 'utf8')
  assert.doesNotMatch(md, RAW_CONTROL)
  const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'))
  assert.equal(rows.length, 2, 'the header and one row')
  assert.match(rows[1], / \| flaky \|$/)
  assert.equal(rows[1].split(/(?<!\\)\|/).length, 4, 'a pipe in the name is escaped, so the row keeps two cells')
})

test('an argv with ESC, CR, LF and % reaches stdout, ::warning and the summary neutralised', async (t) => {
  const s = await setup(t, { fails: 1 })
  const summary = path.join(s.root, 'summary.md')
  const env = { ...s.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }
  const argv = [...ARGV, 'a\u001b[2K\rb\n::error::c%0A|d']
  const r = await runFlaky(argv, { root: s.root, cwd: s.root, env, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  const out = s.out.join('')
  for (const line of out.split('\n').filter(Boolean)) assert.match(line, /^(flaky: |::warning title=flaky::)/, line)
  assertOneLineEach(out, 'flaky: ', 1)
  assertOneLineEach(out, '::warning', 1)
  const md = await readFile(summary, 'utf8')
  assert.doesNotMatch(md, RAW_CONTROL)
  assert.equal(md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---')).length, 2)
})

test('readQuarantine refuses a symlink, a directory, a FIFO and an oversized file', { timeout: 10000 }, async (t) => {
  const s = await setup(t, { fails: 0 })
  const file = path.join(s.root, QUARANTINE_FILE)
  const refuses = (why) => assert.rejects(readQuarantine(s.root), (err) => err instanceof FlakyConfigError && err.message.includes(QUARANTINE_FILE), why)

  const target = path.join(s.root, 'elsewhere.json')
  await writeFile(target, JSON.stringify({ v: 1, tests: {} }))
  await symlink(target, file)
  await refuses('symlink')
  await rm(file)

  await mkdir(file)
  await refuses('directory')
  await rm(file, { recursive: true })

  if (process.platform !== 'win32') {
    assert.equal(spawnSync('mkfifo', [file]).status, 0)
    await refuses('a FIFO without a writer must be refused without blocking')
    await rm(file)
  }

  assert.equal(QUARANTINE_MAX_BYTES, 1024 * 1024)
  await writeFile(file, `{"v":1,"tests":{}}${' '.repeat(QUARANTINE_MAX_BYTES)}`)
  await refuses('oversized')
  await writeFile(file, `{"v":1,"tests":{}}${' '.repeat(100)}`)
  assert.deepEqual(await readQuarantine(s.root), { v: 1, tests: {} })
})

test('writeQuarantine writes a temp file in the same directory, then renames it over the store', async (t) => {
  const s = await setup(t, { fails: 0 })
  const file = path.join(s.root, QUARANTINE_FILE)
  const old = JSON.stringify({ v: 1, tests: { t0: entry() } })
  await writeFile(file, old)
  const next = { v: 1, tests: { t1: entry({ flakes: 1 }) } }
  // A crash between the write and the rename leaves the old store byte-for-byte intact and no
  // half-written store anywhere.
  await assert.rejects(writeQuarantine(s.root, next, {
    rename: async (from) => {
      assert.equal(path.dirname(from), s.root)
      assert.notEqual(from, file)
      assert.deepEqual(JSON.parse(await readFile(from, 'utf8')), next, 'the temp file holds the complete new store')
      assert.equal(await readFile(file, 'utf8'), old, 'the store is untouched until the rename')
      throw new Error('crash')
    },
  }), /crash/)
  assert.equal(await readFile(file, 'utf8'), old)
  assert.deepEqual(await readdir(s.root), [QUARANTINE_FILE])
  await writeQuarantine(s.root, next)
  assert.deepEqual(await readQuarantine(s.root), next)
  assert.deepEqual(await readdir(s.root), [QUARANTINE_FILE])
})

// --- Fix round 2 -------------------------------------------------------------------------------

test('a non-quarantined failure missing from the retry report is not excused', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'c::t1': entry() })
  const { exec } = scripted([
    { code: 1, xml: junit([['t1', 'fail'], ['t2', 'fail']]) },
    { code: 1, xml: junit([['t1', 'fail']]) },
  ], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.retried, 'filtered')
  assert.equal(r.code, 1)
  assert.deepEqual(r.quarantinedFailures, [])
  assert.doesNotMatch(s.out.join(''), /overridden/)
})

test('red unless every test still failing is quarantined: one quarantined failure does not excuse another', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'c::t1': entry() })
  const { exec } = scripted([
    { code: 4, xml: junit([['t1', 'fail'], ['t2', 'fail']]) },
    { code: 1, xml: junit([['t1', 'fail'], ['t2', 'fail']]) },
  ], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 4)
  assert.deepEqual(r.quarantinedFailures, [])
})

test('tests are identified by file plus name: a quarantined test never excuses a same-named test in another file', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'a.test.mjs::c::works': entry() })
  const report = (state) => junit([['works', 'pass', 'a.test.mjs'], ['works', state, 'b.test.mjs']])
  const { exec, seen } = scripted([{ code: 1, xml: report('fail') }, { code: 1, xml: report('fail') }], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 1)
  assert.deepEqual(r.quarantinedFailures, [])
  // Runners filter by name, so the rerun names the bare test name, not the id.
  assert.deepEqual(seen[1].argv, ['node', '--test', '--test-name-pattern=works', 'tests/a.test.mjs'])
})

test('an absolute file attribute under cwd becomes a relative id; the same test quarantined is excused', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'tests/b.test.mjs::c::works': entry() })
  const abs = path.join(s.root, 'tests', 'b.test.mjs').replaceAll('\\', '/')
  const report = junit([['works', 'fail', abs]])
  const { exec } = scripted([{ code: 1, xml: report }, { code: 1, xml: report }], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.deepEqual(r.quarantinedFailures, ['tests/b.test.mjs::c::works'])
})

test('a > inside a quoted file attribute does not end the testcase tag', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'tests/a>b.test.mjs::c::works': entry() })
  const report = junit([['works', 'fail', 'tests/a>b.test.mjs']])
  const { exec } = scripted([{ code: 1, xml: report }, { code: 1, xml: report }], s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.deepEqual(r.quarantinedFailures, ['tests/a>b.test.mjs::c::works'])
})

test('an excused run prints one line saying the exit code was overridden, and a ::warning under GitHub', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'c::t1': entry(), 'c::t2': entry() })
  const steps = () => [
    { code: 5, xml: junit([['t1', 'fail'], ['t2', 'fail']]) },
    { code: 1, xml: junit([['t1', 'fail'], ['t2', 'fail']]) },
  ]
  const plain = scripted(steps(), s.reportPath)
  const r = await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec: plain.exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  const lines = s.out.join('').split('\n').filter((l) => l.includes('overridden'))
  assert.deepEqual(lines, ['flaky: exit code 5 overridden: every remaining failure is a quarantined test (c::t1, c::t2)'])

  s.out.length = 0
  const gh = scripted(steps(), s.reportPath)
  const env = { ...s.env, GITHUB_ACTIONS: 'true' }
  await runFlaky(NODE_ARGV, { root: s.root, cwd: s.root, env, report: s.reportPath, exec: gh.exec, write: s.write, now: () => NOW })
  const warnings = s.out.join('').split('\n').filter((l) => l.startsWith('::warning') && l.includes('overridden'))
  assert.deepEqual(warnings, ['::warning title=flaky::exit code 5 overridden: every remaining failure is a quarantined test (c::t1, c::t2)'])
})

test('a quarantined failure with ESC, CR, LF, % and | in its name reaches stdout, ::warning and the summary neutralised', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  const summary = path.join(s.root, 'summary.md')
  const env = { ...s.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }
  const evil = 't&#27;[2K&#13;fake&#10;::error::x%0A|y'
  const decoded = 't\u001b[2K\rfake\n::error::x%0A|y'
  await seed(s.root, { [`c::${decoded}`]: entry() })
  const report = junit([[evil, 'fail']])
  const { exec } = scripted([{ code: 1, xml: report }, { code: 1, xml: report }], s.reportPath)
  const r = await runFlaky(['make', 'test'], { root: s.root, cwd: s.root, env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.deepEqual(r.quarantinedFailures, [`c::${decoded}`])
  const out = s.out.join('')
  for (const line of out.split('\n').filter(Boolean)) assert.match(line, /^(flaky: |::warning title=flaky::)/, line)
  assertOneLineEach(out, 'flaky: quarantined test failed: ', 1)
  assertOneLineEach(out, 'flaky: exit code 1 overridden: ', 1)
  assertOneLineEach(out, '::warning', 2)
  for (const line of out.split('\n').filter((l) => l.startsWith('::warning'))) assert.match(line, /%250A/)
  const md = await readFile(summary, 'utf8')
  assert.doesNotMatch(md, RAW_CONTROL)
  const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'))
  assert.equal(rows.length, 2, 'the header and one row')
  assert.match(rows[1], / \| quarantined, failed \|$/)
  assert.equal(rows[1].split(/(?<!\\)\|/).length, 4, 'a pipe in the name is escaped, so the row keeps two cells')
})

test('a test that fails only on the whole retry is not excused by a quarantined one failing beside it', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'c::t1': entry() })
  // `make test` is not a runner retryArgv can filter, so the retry is the whole command and t2,
  // which passed on the first attempt, can fail on the retry.
  const { exec } = scripted([
    { code: 2, xml: junit([['t1', 'fail'], ['t2', 'pass']]) },
    { code: 1, xml: junit([['t1', 'fail'], ['t2', 'fail']]) },
  ], s.reportPath)
  const r = await runFlaky(['make', 'test'], { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.retried, 'whole')
  assert.equal(r.code, 2)
  assert.deepEqual(r.quarantinedFailures, [])
})

// --- Re-review findings ------------------------------------------------------------------------

test('ids include the classname: a quarantined `A > works` never excuses `B > works` in the same file', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'a.test.mjs::A::works': entry() })
  const report = junit([['works', 'pass', 'a.test.mjs', 'A'], ['works', 'fail', 'a.test.mjs', 'B']])
  const { exec } = scripted([{ code: 1, xml: report }, { code: 1, xml: report }], s.reportPath)
  const r = await runFlaky(['make', 'test'], { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 1)
  assert.deepEqual(r.quarantinedFailures, [])

  // The other way round: `A > works` itself failing twice is the quarantined test, under that id.
  const own = junit([['works', 'fail', 'a.test.mjs', 'A'], ['works', 'pass', 'a.test.mjs', 'B']])
  const again = scripted([{ code: 1, xml: own }, { code: 1, xml: own }], s.reportPath)
  const r2 = await runFlaky(['make', 'test'], { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec: again.exec, write: s.write, now: () => NOW })
  assert.equal(r2.code, 0)
  assert.deepEqual(r2.quarantinedFailures, ['a.test.mjs::A::works'])
})

test('id fallbacks: <file>::<name> with no classname, <classname>::<name> with no file', async (t) => {
  for (const [file, classname, key] of [['a.test.mjs', null, 'a.test.mjs::works'], [undefined, 'Suite', 'Suite::works']]) {
    const s = await setup(t, { fails: 0, report: true })
    await seed(s.root, { [key]: entry() })
    const report = junit([['works', 'fail', file, classname]])
    const { exec } = scripted([{ code: 1, xml: report }, { code: 1, xml: report }], s.reportPath)
    const r = await runFlaky(['make', 'test'], { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
    assert.equal(r.code, 0, key)
    assert.deepEqual(r.quarantinedFailures, [key])
  }
})

test('a relative `file` is normalised: ./tests/b.test.mjs matches the store entry tests/b.test.mjs', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  await seed(s.root, { 'tests/b.test.mjs::c::works': entry() })
  const report = junit([['works', 'fail', './tests/b.test.mjs']])
  const { exec } = scripted([{ code: 1, xml: report }, { code: 1, xml: report }], s.reportPath)
  const r = await runFlaky(['make', 'test'], { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.deepEqual(r.quarantinedFailures, ['tests/b.test.mjs::c::works'])
})

test('cwd reached through a symlink: a report naming files by the real path still matches the store', { skip: process.platform === 'win32' && 'symlinks need a privilege on Windows' }, async (t) => {
  const s = await setup(t, { fails: 0 })
  const real = path.join(s.root, 'real')
  const link = path.join(s.root, 'link')
  await mkdir(real)
  await symlink(real, link)
  const reportPath = path.join(link, 'report.xml')
  await seed(link, { 'tests/b.test.mjs::c::works': entry() })
  const abs = path.join(await realpath(real), 'tests', 'b.test.mjs').replaceAll('\\', '/')
  const report = junit([['works', 'fail', abs]])
  const { exec } = scripted([{ code: 1, xml: report }, { code: 1, xml: report }], reportPath)
  const r = await runFlaky(['make', 'test'], { root: link, cwd: link, env: s.env, report: reportPath, exec, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.deepEqual(r.quarantinedFailures, ['tests/b.test.mjs::c::works'])
})
