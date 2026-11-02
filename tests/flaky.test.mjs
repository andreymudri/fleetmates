import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  QUARANTINE_FILE, RELEASE_STREAK, FlakyConfigError, readQuarantine, retryArgv, runFlaky,
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
  assert.deepEqual(r.flaky, ['t1'])
  const iso = new Date(NOW).toISOString()
  assert.deepEqual(await quarantineOf(s.root), { v: 1, tests: { t1: { firstSeen: iso, lastSeen: iso, flakes: 1, passStreak: 0 } } })
  assert.match(s.out.join(''), /^flaky: t1$/m)
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

test('an unreadable report falls back to a whole-command retry', async (t) => {
  const s = await setup(t, { fails: 1 })
  const reportPath = path.join(s.root, 'broken.xml')
  await writeFile(reportPath, '<!DOCTYPE x><testsuites/>')
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: reportPath, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.equal(r.retried, 'whole')
  assert.deepEqual(r.flaky, [COMMAND_ID])
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
  const before = { v: 1, tests: { t1: { firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-01T00:00:00.000Z', flakes: 3, passStreak: 4 } } }
  await writeFile(path.join(s.root, QUARANTINE_FILE), JSON.stringify(before))
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  assert.deepEqual(r.quarantinedFailures, ['t1'])
  assert.deepEqual(r.flaky, [])
  assert.match(s.out.join(''), /^flaky: quarantined test failed: t1$/m)
})

test('a quarantined test that passes: passStreak + 1, flakes unchanged', async (t) => {
  const s = await setup(t, { fails: 0, report: true })
  const before = { v: 1, tests: { t1: { firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-01T00:00:00.000Z', flakes: 3, passStreak: 4 } } }
  await writeFile(path.join(s.root, QUARANTINE_FILE), JSON.stringify(before))
  const r = await runFlaky(ARGV, { root: s.root, cwd: s.root, env: s.env, report: s.reportPath, write: s.write, now: () => NOW })
  assert.equal(r.code, 0)
  const after = await quarantineOf(s.root)
  assert.equal(after.tests.t1.passStreak, 5)
  assert.equal(after.tests.t1.flakes, 3)
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
  assert.match(s.out.join(''), /^::warning title=flaky::t1 passed on retry$/m)
  const md = await readFile(summary, 'utf8')
  assert.ok(md.startsWith('earlier\n'), 'the summary is appended to, not replaced')
  assert.match(md, /^\| Test \| Result \|$/m)
  assert.match(md, /^\| t1 \| flaky \|$/m)
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
  assert.deepEqual(r.flaky, ['t1'])
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
