import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { strictExecutionSupport, STRICT_EXECUTION_UNSUPPORTED } from '../scripts/execution-platform.mjs'
import { runCli } from '../scripts/cli.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'scripts', 'cli.mjs')
const helper = path.join(here, 'strict-platform.mjs')
const REASON = 'strict execution needs POSIX no-follow, nonblocking reads and private file modes; it is not supported on Windows'
const numeric = { O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 }

test('strict execution is supported on linux and darwin when both flags are numeric', () => {
  assert.deepEqual(strictExecutionSupport({ platform: 'linux', constants: numeric }), { supported: true, reason: null })
  assert.deepEqual(strictExecutionSupport({ platform: 'darwin', constants: numeric }), { supported: true, reason: null })
})

test('strict execution is unsupported on win32 even when both flags are numeric', () => {
  assert.deepEqual(strictExecutionSupport({ platform: 'win32', constants: numeric }), { supported: false, reason: REASON })
})

test('strict execution is unsupported when either flag is undefined', () => {
  assert.deepEqual(strictExecutionSupport({ platform: 'linux', constants: { O_NONBLOCK: 0x800 } }), { supported: false, reason: REASON })
  assert.deepEqual(strictExecutionSupport({ platform: 'linux', constants: { O_NOFOLLOW: 0x20000 } }), { supported: false, reason: REASON })
})

test('the refusal reason is the one fixed sentence', () => {
  assert.equal(STRICT_EXECUTION_UNSUPPORTED, REASON)
})

test('the defaults read the running process', () => {
  const expected = process.platform === 'win32' ? { supported: false, reason: REASON } : { supported: true, reason: null }
  assert.deepEqual(strictExecutionSupport(), expected)
})

test('strictTest skips with the reason under FLEETMATES_TEST_STRICT_UNSUPPORTED=1', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'strict-skip-'))
  try {
    const file = path.join(dir, 'one.test.mjs')
    writeFileSync(file, `import { strictTest } from ${JSON.stringify(pathToFileURL(helper).href)}\nstrictTest('only', () => {})\n`)
    // NODE_TEST_CONTEXT is dropped so the child prints its own TAP instead of reporting to this runner.
    const { NODE_TEST_CONTEXT, ...parentEnv } = process.env
    const run = (env) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', cwd: dir, env: { ...parentEnv, ...env } })
    const skipped = run({ FLEETMATES_TEST_STRICT_UNSUPPORTED: '1' })
    assert.equal(skipped.status, 0, skipped.stderr)
    assert.match(skipped.stdout, /^# skipped 1$/m)
    assert.ok(skipped.stdout.includes(`# SKIP ${REASON}`), skipped.stdout)
    if (process.platform !== 'win32') {
      const ran = run({ FLEETMATES_TEST_STRICT_UNSUPPORTED: '' })
      assert.equal(ran.status, 0, ran.stderr)
      assert.match(ran.stdout, /^# skipped 0$/m)
      assert.match(ran.stdout, /^# pass 1$/m)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const unsupported = { supported: false, reason: REASON }
const absRoot = path.resolve(tmpdir(), 'strict-platform-root')
const absFile = path.resolve(tmpdir(), 'strict-platform-input.json')
const GATED = [
  ['workflow-execute', '--file', absFile, '--root', absRoot],
  ['workflow-resume', '--run', 'r1', '--root', absRoot],
  ['workflow-status', '--run', 'r1', '--root', absRoot],
  ['workflow-resolve', '--file', absFile, '--root', absRoot],
  ['workflow-accept', '--file', absFile, '--root', absRoot],
  ['workflow-prune', '--run', 'r1', '--root', absRoot],
  ['execution-record', '--file', absFile, '--root', absRoot],
  ['execution-status', '--run', 'r1', '--file', absFile, '--root', absRoot],
  ['dispatch', '--run', 'r1', '--phase', '1', '--root', absRoot, '--execution', absFile],
]

test('the CLI refuses every strict command with exit 2 and the reason as one JSON line when unsupported', async () => {
  for (const argv of GATED) {
    const lines = []
    const code = await runCli(argv, { out: (l) => lines.push(String(l)), err: (l) => lines.push(String(l)), strictSupport: unsupported })
    assert.equal(code, 2, argv[0])
    assert.deepEqual(lines, [JSON.stringify({ error: REASON })], argv[0])
  }
})

test('the CLI leaves dispatch without --execution and other commands alone when unsupported', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'strict-other-'))
  try {
    for (const argv of [['dispatch', '--run', 'r1', '--phase', '1', '--root', dir], ['status', '--run', 'r1', '--root', dir]]) {
      const lines = []
      await runCli(argv, { out: (l) => lines.push(String(l)), err: (l) => lines.push(String(l)), strictSupport: unsupported })
      assert.ok(lines.length > 0 && !lines.join('\n').includes(REASON), argv[0])
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('on a POSIX host workflow-status and execution-status do not print the reason', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'strict-posix-'))
  try {
    const input = path.join(dir, 'input.json')
    writeFileSync(input, '{}')
    for (const argv of [['workflow-status', '--run', 'r1', '--root', dir], ['execution-status', '--run', 'r1', '--file', input, '--root', dir]]) {
      const r = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', cwd: dir })
      assert.ok(!(r.stdout + r.stderr).includes(REASON), argv[0])
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('on Windows each strict command exits 2 with the reason', { skip: process.platform !== 'win32' }, () => {
  for (const argv of GATED) {
    const r = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8' })
    assert.equal(r.status, 2, argv[0])
    assert.equal(r.stdout.trim(), JSON.stringify({ error: REASON }), argv[0])
  }
})
