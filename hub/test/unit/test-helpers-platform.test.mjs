import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import pty from 'node-pty'
import { fakeBin } from '../helpers/fake-bin.mjs'

const execFileP = promisify(execFile)
const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const helperUrl = pathToFileURL(path.join(hubDir, 'test', 'helpers', 'platform.mjs')).href
const fakeClaude = path.join(hubDir, 'test', 'fake-claude', 'fake-claude.mjs')
const scriptsDir = path.join(hubDir, 'test', 'fixtures', 'scripts')
const FORCE = 'FLEETMATES_TEST_FORCE_WINDOWS'
// Expectations without the force flag depend on the host: on a Windows host posixTest skips anyway.
const hostWindows = process.platform === 'win32'

/**
 * Assert a child run without the force flag: one pass off Windows, one skip on a Windows host.
 * @param {string} tap
 */
function assertUnforced (tap) {
  assert.equal(summary(tap, 'pass'), hostWindows ? 0 : 1)
  assert.equal(summary(tap, 'skipped'), hostWindows ? 1 : 0)
  assert.equal(summary(tap, 'fail'), 0)
  assert.match(tap, new RegExp(`isWindows=${hostWindows}`))
}

/**
 * Run `node --test` on a one-test file that uses `posixTest` (or `posixIt`) and return its TAP output.
 * @param {{ force: boolean, call: string }} opts
 * @returns {Promise<string>}
 */
async function runChild ({ force, call }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-posix-test-'))
  try {
    const file = path.join(dir, 'one.test.mjs')
    await writeFile(file, [
      `import { posixTest, posixIt, isWindows } from ${JSON.stringify(helperUrl)}`,
      'void posixTest; void posixIt',
      'console.log("isWindows=" + isWindows)',
      call,
      ''
    ].join('\n'))
    const env = { ...process.env }
    delete env[FORCE]
    delete env.NODE_TEST_CONTEXT
    if (force) env[FORCE] = '1'
    const { stdout } = await execFileP(process.execPath, ['--test', '--test-reporter=tap', file], { env })
    return stdout
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * @param {string} tap
 * @param {string} name
 */
function summary (tap, name) {
  const m = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(tap)
  return m ? Number(m[1]) : NaN
}

test('posixTest runs its test without the force flag on a POSIX host (and skips on a Windows host)', async () => {
  const tap = await runChild({ force: false, call: 'posixTest("one", () => {})' })
  assertUnforced(tap)
  if (!hostWindows) assert.doesNotMatch(tap, /# SKIP/)
})

test('posixTest skips with the default POSIX only message under FLEETMATES_TEST_FORCE_WINDOWS=1', async () => {
  const tap = await runChild({ force: true, call: 'posixTest("one", () => { throw new Error("ran") })' })
  assert.equal(summary(tap, 'skipped'), 1)
  assert.equal(summary(tap, 'pass'), 0)
  assert.equal(summary(tap, 'fail'), 0)
  assert.match(tap, /^ok 1 - one # SKIP POSIX only: file modes, symlinks or Unix sockets$/m)
})

test('posixTest takes the reason from opts and isWindows follows the force flag', async () => {
  const tap = await runChild({ force: true, call: 'posixTest("one", { reason: "needs chmod" }, () => { throw new Error("ran") })' })
  assert.equal(summary(tap, 'skipped'), 1)
  assert.match(tap, /^ok 1 - one # SKIP POSIX only: needs chmod$/m)
  assert.match(tap, /isWindows=true/)
  const off = await runChild({ force: false, call: 'posixTest("one", { reason: "needs chmod" }, () => {})' })
  assertUnforced(off)
})

test('posixIt has the same contract inside describe', async () => {
  const call = 'import { describe } from "node:test"\ndescribe("group", () => { posixIt("one", () => { throw new Error("ran") }) })'
  const on = await runChild({ force: true, call })
  assert.equal(summary(on, 'skipped'), 1)
  assert.match(on, /ok 1 - one # SKIP POSIX only: file modes, symlinks or Unix sockets$/m)
  const off = await runChild({ force: false, call: call.replace('throw new Error("ran")', '') })
  assertUnforced(off)
})

test('fakeBin writes claude.cmd with CRLF under FLEETMATES_TEST_FORCE_WINDOWS=1', async () => {
  const before = process.env[FORCE]
  process.env[FORCE] = '1'
  let bin
  try {
    bin = await fakeBin({})
  } finally {
    if (before === undefined) delete process.env[FORCE]
    else process.env[FORCE] = before
  }
  try {
    assert.equal(bin.claudePath, path.join(bin.binDir, 'claude.cmd'))
    const text = await readFile(bin.claudePath, 'utf8')
    assert.equal(text, `@"${process.execPath}" "${fakeClaude}" %*\r\n`)
  } finally {
    await bin.cleanup()
  }
})

test('fakeBin writes the unchanged POSIX shell wrapper without the force flag', async () => {
  const before = process.env[FORCE]
  delete process.env[FORCE]
  let bin
  try {
    // A Windows host writes claude.cmd by default, so there the POSIX branch is asked for by platform.
    bin = await fakeBin(hostWindows ? { platform: 'linux' } : {})
  } finally {
    if (before !== undefined) process.env[FORCE] = before
  }
  try {
    assert.equal(bin.claudePath, path.join(bin.binDir, 'claude'))
    const text = await readFile(bin.claudePath, 'utf8')
    assert.equal(text, `#!/bin/sh\nexec '${process.execPath}' '${fakeClaude}' "$@"\n`)
  } finally {
    await bin.cleanup()
  }
})

// On Linux one pty resize raises both SIGWINCH and a process.stdout 'resize' event in the fake (seen
// with the dedup removed: two entries). Which of the two a Windows host raises is unverified here; one
// entry is expected either way.
test('the fake claude logs exactly one resize for one pty resize, though SIGWINCH and stdout resize both fire on Linux', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-fake-resize1-'))
  const log = path.join(dir, 'log.jsonl')
  const bin = await fakeBin({ script: path.join(scriptsDir, 'resize.json'), log })
  // node and the script directly, not the claude wrapper: spawning `claude` failed with node-pty's
  // 'File not found' on a Windows host (reported from a Windows VM run, not reproduced here).
  const p = pty.spawn(process.execPath, [fakeClaude], { env: /** @type {Record<string, string>} */ (bin.env), cwd: dir, cols: 80, rows: 24, name: 'xterm-256color' })
  /** @type {Promise<unknown>} */
  const exited = new Promise(resolve => p.onExit(resolve))
  const read = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l))
  try {
    const start = Date.now()
    while (!(await read()).some(e => e.ready)) {
      if (Date.now() - start > 5000) throw new Error('fake claude never became ready')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    p.resize(100, 30)
    const until = Date.now() + 5000
    while (!(await read()).some(e => e.resize) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
    // Give a second report, if one is coming, time to land.
    await new Promise(resolve => setTimeout(resolve, 500))
    const resizes = (await read()).filter(e => e.resize)
    assert.deepEqual(resizes.map(e => e.resize), [{ cols: 100, rows: 30 }])
  } finally {
    p.kill()
    await exited
    await bin.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})
