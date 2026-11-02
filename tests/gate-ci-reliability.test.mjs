// Gate wiring for the CI reliability features (docs/plans/2026-11-02-ci-reliability.md, Task 5):
// the `platformSim` and `flaky` flags of a `command` check, the quarantine file in the protected
// set, and the `portability` review lens.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommandCheck, runChecks, defaultExec, shellCommand, simAttemptArgv } from '../scripts/gate-runner.mjs'
import { protectedPaths, reviewLenses } from '../scripts/gate-config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const realpathProbe = path.join(here, 'fixtures', 'platform-sim', 'realpath-probe.mjs')
const failsNTimes = path.join(here, 'fixtures', 'flaky', 'fails-n-times.mjs')
const WIN = process.platform === 'win32'

// A private, canonical temp dir for the whole file: the plain realpath probe needs os.tmpdir()
// not to be reached through a link (macOS /var -> /private/var), and the scratch-dir test needs a
// directory no other test file writes simulator scratch into. Checks inherit process.env.
const privateTmp = mkdtempSync(path.join(realpathSync(tmpdir()), 'fm-gate-ci-'))
const savedEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
for (const key of Object.keys(savedEnv)) process.env[key] = privateTmp
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(privateTmp, { recursive: true, force: true })
})

// cmd.exe reads only double quotes. /bin/sh expands $( ) inside double quotes, so a POSIX temp
// path (the hostile-TMPDIR sweep plants one) goes in single quotes.
const q = (p) => (WIN ? `"${p}"` : `'${p.replaceAll("'", "'\\''")}'`)
const nodeRun = (script) => `${q(process.execPath)} ${q(script)}`

async function scratch(t, prefix = 'case-') {
  const dir = await mkdtemp(path.join(privateTmp, prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// FLAKY_* are read by fails-n-times.mjs from the environment the check inherits.
function flakyEnv(t, vars) {
  for (const [key, value] of Object.entries(vars)) process.env[key] = value
  t.after(() => { for (const key of Object.keys(vars)) delete process.env[key] })
}

// The helper's git reads no host config: an empty global file and no system file, so a host's
// commit signing or hooks path cannot fail the setup.
const emptyGitConfig = path.join(privateTmp, 'empty-gitconfig')
writeFileSync(emptyGitConfig, '')
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

async function repo(t) {
  const dir = await scratch(t, 'repo-')
  git(dir, 'init', '-q')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

test('platformSim: the realpath probe fails under the simulator and passes without the flag', { skip: WIN && 'the symlinked temp dir is skipped on Windows' }, async (t) => {
  const cwd = await scratch(t)
  const plain = await runCommandCheck({ name: 'probe', kind: 'command', run: nodeRun(realpathProbe) }, { cwd })
  assert.equal(plain.status, 'pass', plain.output)
  const simulated = await runCommandCheck({ name: 'probe', kind: 'command', run: nodeRun(realpathProbe), platformSim: true }, { cwd })
  assert.equal(simulated.status, 'fail')
  assert.match(simulated.output, /os\.tmpdir\(\) is not canonical/)
  assert.match(simulated.output, /platform-sim: applied .*symlinked-tmpdir/)
})

test('flaky: one failure passes and the result names the flaky test from the report', async (t) => {
  const parent = await scratch(t)
  const cwd = path.join(parent, 'tree')
  await mkdir(cwd)
  flakyEnv(t, { FLAKY_COUNTER: path.join(parent, 'count'), FLAKY_FAILS: '1', FLAKY_REPORT: path.join(cwd, 'report.xml') })
  const check = { name: 'test', kind: 'command', run: nodeRun(failsNTimes), flaky: true, report: { format: 'junit', path: 'report.xml' } }
  // The in-tree report form runs only in a tree the gate owns, so this is a preview run.
  const result = await runCommandCheck(check, { cwd, previewDir: cwd })
  assert.equal(result.status, 'pass', result.output)
  assert.deepEqual(result.flaky, ['fixture::t1'])
  assert.deepEqual(result.quarantinedFailures, [])
  assert.match(result.output, /flaky: fixture::t1/)
  assert.equal(await readFile(path.join(parent, 'count'), 'utf8'), '2')
})

test('flaky: without a report, one failure passes and names the whole command', async (t) => {
  const cwd = await scratch(t)
  flakyEnv(t, { FLAKY_COUNTER: path.join(cwd, 'count'), FLAKY_FAILS: '1' })
  const result = await runCommandCheck({ name: 'test', kind: 'command', run: nodeRun(failsNTimes), flaky: true }, { cwd })
  assert.equal(result.status, 'pass', result.output)
  assert.equal(result.flaky.length, 1)
  assert.ok(result.flaky[0].includes('fails-n-times.mjs'), result.flaky[0])
  // Not a git worktree, so there is no tracked quarantine to write.
  assert.equal(existsSync(path.join(cwd, 'fleetmates.flaky.json')), false)
})

test('flaky: two failures fail the check with the original exit code', async (t) => {
  const cwd = await scratch(t)
  flakyEnv(t, { FLAKY_COUNTER: path.join(cwd, 'count'), FLAKY_FAILS: '2' })
  const result = await runCommandCheck({ name: 'test', kind: 'command', run: nodeRun(failsNTimes), flaky: true }, { cwd })
  assert.equal(result.status, 'fail')
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.flaky, [])
  assert.equal(await readFile(path.join(cwd, 'count'), 'utf8'), '2')
})

test('without the flaky flag one failure fails the check and nothing is retried', async (t) => {
  const cwd = await scratch(t)
  flakyEnv(t, { FLAKY_COUNTER: path.join(cwd, 'count'), FLAKY_FAILS: '1' })
  const result = await runCommandCheck({ name: 'test', kind: 'command', run: nodeRun(failsNTimes) }, { cwd })
  assert.equal(result.status, 'fail')
  assert.equal(result.flaky, undefined)
  assert.equal(await readFile(path.join(cwd, 'count'), 'utf8'), '1')
})

test('platformSim and flaky compose: the retry also runs under the simulator', { skip: WIN && 'the symlinked temp dir is skipped on Windows' }, async (t) => {
  const cwd = await scratch(t)
  // A plain retry would pass the realpath probe and turn the check green as a flake.
  const result = await runCommandCheck({ name: 'probe', kind: 'command', run: nodeRun(realpathProbe), platformSim: true, flaky: true }, { cwd })
  assert.equal(result.status, 'fail', result.output)
  assert.deepEqual(result.flaky, [])
  assert.equal(result.output.match(/platform-sim: applied/g)?.length, 2, result.output)
})

test('platformSim and flaky compose: a one-off failure under the simulator is a flake', async (t) => {
  const cwd = await scratch(t)
  flakyEnv(t, { FLAKY_COUNTER: path.join(cwd, 'count'), FLAKY_FAILS: '1' })
  const result = await runCommandCheck({ name: 'test', kind: 'command', run: nodeRun(failsNTimes), platformSim: true, flaky: true }, { cwd })
  assert.equal(result.status, 'pass', result.output)
  assert.equal(result.flaky.length, 1)
  // A pass reports only the detector's lines; the retained log holds both attempts.
  const log = await readFile(result.log.path, 'utf8')
  assert.equal(log.match(/platform-sim: applied/g)?.length, 2, log)
  assert.match(log, /flaky: /)
})

test('flaky: the check timeout bounds both attempts together', async (t) => {
  const cwd = await scratch(t)
  const slow = path.join(cwd, 'slow-fail.mjs')
  await writeFile(slow, 'setTimeout(() => process.exit(1), 1000)\n')
  // Each attempt fits the bound on its own; the two together do not.
  const result = await runCommandCheck({ name: 'test', kind: 'command', run: nodeRun(slow), flaky: true, timeoutMs: 1600 }, { cwd })
  assert.equal(result.status, 'fail')
  assert.match(result.output, /timed out/)
})

test('flaky: an attempt that timed out is not retried', async (t) => {
  const cwd = await scratch(t)
  const hang = path.join(cwd, 'hang.mjs')
  await writeFile(hang, 'setInterval(() => {}, 1000)\n')
  let spawned = 0
  const exec = (...args) => { spawned += 1; return defaultExec(...args) }
  const result = await runCommandCheck({ name: 'hang', kind: 'command', run: nodeRun(hang), flaky: true, timeoutMs: 1000 }, { cwd, exec })
  assert.equal(result.status, 'fail')
  assert.match(result.output, /timed out/)
  assert.equal(spawned, 1)
})

test('platformSim: a timed-out check leaves no simulator scratch directory behind', { skip: WIN && 'process groups and SIGTERM are POSIX' }, async (t) => {
  const cwd = await scratch(t)
  const hang = path.join(cwd, 'hang.mjs')
  await writeFile(hang, 'setInterval(() => {}, 1000)\n')
  const result = await runCommandCheck({ name: 'hang', kind: 'command', run: nodeRun(hang), platformSim: true, timeoutMs: 1500 }, { cwd })
  assert.equal(result.status, 'fail')
  assert.match(result.output, /timed out/)
  assert.deepEqual(readdirSync(privateTmp).filter((n) => n.startsWith('fm-platform-sim-')), [])
})

test('the quarantine is written from the main worktree outside a preview', async (t) => {
  const cwd = await repo(t)
  flakyEnv(t, { FLAKY_COUNTER: path.join(cwd, '..', `${path.basename(cwd)}.count`), FLAKY_FAILS: '1' })
  const result = await runCommandCheck({ name: 'test', kind: 'command', run: nodeRun(failsNTimes), flaky: true }, { cwd })
  assert.equal(result.status, 'pass', result.output)
  const store = JSON.parse(await readFile(path.join(cwd, 'fleetmates.flaky.json'), 'utf8'))
  assert.deepEqual(Object.keys(store.tests), result.flaky)
})

test('a quarantined test that fails twice is excused and reported', async (t) => {
  const cwd = await repo(t)
  const seen = '2026-01-01T00:00:00.000Z'
  const store = { v: 1, tests: { 'fixture::t1': { firstSeen: seen, lastSeen: seen, flakes: 1, passStreak: 0 } } }
  await writeFile(path.join(cwd, 'fleetmates.flaky.json'), `${JSON.stringify(store, null, 2)}\n`)
  flakyEnv(t, { FLAKY_COUNTER: path.join(cwd, '..', `${path.basename(cwd)}.count`), FLAKY_FAILS: '2', FLAKY_REPORT: path.join(cwd, 'report.xml') })
  const check = { name: 'test', kind: 'command', run: nodeRun(failsNTimes), flaky: true, report: { format: 'junit', path: 'report.xml' } }
  // The in-tree report form runs only in a tree the gate owns, so the main worktree stands in as one.
  const result = await runCommandCheck(check, { cwd, previewDir: cwd })
  assert.equal(result.status, 'pass', result.output)
  assert.deepEqual(result.quarantinedFailures, ['fixture::t1'])
  assert.deepEqual(result.flaky, [])
  assert.match(result.output, /flaky: quarantined test failed: fixture::t1/)
  assert.match(result.output, /flaky: exit code 1 overridden/)
})

test('the quarantine is not written inside a preview', async (t) => {
  const cwd = await repo(t)
  flakyEnv(t, { FLAKY_COUNTER: path.join(cwd, '..', `${path.basename(cwd)}.count`), FLAKY_FAILS: '1' })
  const result = await runCommandCheck({ name: 'test', kind: 'command', run: nodeRun(failsNTimes), flaky: true }, { cwd, previewDir: cwd })
  assert.equal(result.status, 'pass', result.output)
  assert.equal(existsSync(path.join(cwd, 'fleetmates.flaky.json')), false)
})

test('the quarantine is not written from a linked worktree', async (t) => {
  const main = await repo(t)
  const linked = path.join(path.dirname(main), `${path.basename(main)}-wt`)
  git(main, 'worktree', 'add', '-q', '--detach', linked)
  t.after(() => rm(linked, { recursive: true, force: true }))
  flakyEnv(t, { FLAKY_COUNTER: path.join(linked, 'count'), FLAKY_FAILS: '1' })
  const result = await runCommandCheck({ name: 'test', kind: 'command', run: nodeRun(failsNTimes), flaky: true }, { cwd: linked })
  assert.equal(result.status, 'pass', result.output)
  assert.equal(existsSync(path.join(linked, 'fleetmates.flaky.json')), false)
})

for (const flag of ['platformSim', 'flaky']) {
  test(`a non-boolean ${flag} is refused with the check name`, async (t) => {
    const cwd = await scratch(t)
    const marker = path.join(cwd, 'ran')
    const check = { name: `bad-${flag}`, kind: 'command', run: `${q(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], '')" ${q(marker)}`, [flag]: 'yes' }
    const [result] = await runChecks([check], { cwd })
    assert.equal(result.name, `bad-${flag}`)
    assert.equal(result.status, 'fail')
    assert.match(result.output, new RegExp(`^${flag} must be true or false.*\\(entry #0`))
    assert.equal(existsSync(marker), false, 'the command must not run')
    await assert.rejects(runCommandCheck(check, { cwd }), new RegExp(flag))
  })
}

test('protectedPaths includes the quarantine file', () => {
  assert.ok(protectedPaths({}).includes('fleetmates.flaky.json'))
})

const manifest = (lens) => ({
  phases: { default: { checks: [{ name: 'review', kind: 'agent', ...(lens ? { lens } : {}) }] } },
})

test('reviewLenses adds portability when the CI covers macOS or Windows', () => {
  for (const os of ['macos', 'windows']) {
    const lenses = reviewLenses(manifest(['correctness']), 'p1', { oses: new Set(['linux', os]) })
    assert.deepEqual(lenses, ['correctness', 'portability'])
  }
})

test('reviewLenses leaves a Linux-only CI alone', () => {
  assert.deepEqual(reviewLenses(manifest(['correctness']), 'p1', { oses: new Set(['linux']) }), ['correctness'])
  assert.deepEqual(reviewLenses(manifest(['correctness']), 'p1', { present: false, oses: new Set() }), ['correctness'])
  assert.deepEqual(reviewLenses(manifest(['correctness']), 'p1', undefined), ['correctness'])
})

test('reviewLenses keeps a listed portability lens and never duplicates it', () => {
  assert.deepEqual(reviewLenses(manifest(['portability', 'tests']), 'p1', { oses: new Set(['linux']) }), ['portability', 'tests'])
  assert.deepEqual(reviewLenses(manifest(['portability', 'tests']), 'p1', { oses: new Set(['windows']) }), ['portability', 'tests'])
})

test('reviewLenses starts from the default lens list when the review check names none', () => {
  assert.deepEqual(reviewLenses(manifest(), 'p1', { oses: new Set(['macos']) }), ['correctness', 'security', 'tests', 'portability'])
})

test('shellCommand runs win32 checks verbatim through cmd.exe, the way node\'s shell option does', () => {
  const run = 'node -e "process.exit(0)"'
  assert.deepEqual(shellCommand(run, { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' }), {
    file: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', '"node -e "process.exit(0)""'],
    windowsVerbatimArguments: true,
  })
  assert.equal(shellCommand(run, { platform: 'win32', comspec: '' }).file, 'cmd.exe')
  assert.deepEqual(shellCommand(run, { platform: 'linux' }), { file: '/bin/sh', args: ['-c', run], windowsVerbatimArguments: false })
})

test('platformSim: a run holding double quotes passes on this host', async (t) => {
  const cwd = await scratch(t)
  const result = await runCommandCheck({ name: 'quoted', kind: 'command', run: `${q(process.execPath)} -e "process.exit(0)"`, platformSim: true }, { cwd })
  assert.equal(result.status, 'pass', result.output)
})

// The verbatim path is the one win32 takes. The flag means nothing to a POSIX spawn, so on this host
// it runs /bin/sh and shows that path still applies the simulator's environment and cleans up.
test('platformSim: the verbatim spawn path runs under the simulator and removes its scratch', { skip: WIN && 'drives /bin/sh' }, async (t) => {
  const cwd = await scratch(t)
  const spec = { file: '/bin/sh', args: ['-c', nodeRun(realpathProbe)], windowsVerbatimArguments: true }
  const r = await defaultExec(process.execPath, cwd, { argv: simAttemptArgv(spec), timeoutMs: 60_000 })
  assert.equal(r.code, 1, r.output)
  assert.match(r.output, /os\.tmpdir\(\) is not canonical/)
  assert.match(r.output, /platform-sim: applied .*symlinked-tmpdir.*; skipped umask-077 \(not applied to a verbatim shell command\)/)
  assert.deepEqual(readdirSync(privateTmp).filter((n) => n.startsWith('fm-platform-sim-')), [])
})
