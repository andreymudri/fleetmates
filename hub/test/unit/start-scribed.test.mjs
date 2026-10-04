// "Start scribed" (OPS-O1, Task 9 of docs/plans/2026-10-04-deck-m4.md). Every call goes to a `systemd-run`
// shim first on a temporary PATH; the real systemd-run must never run. The temporary PATH is set both in the
// `env` passed to startScribed and in process.env for the duration of each test, so a mutation that passes
// process.env through still reaches the shim. The shim logs its argv and its environment keys and, when asked,
// replays the shell part of its argv without `-l`, with a temporary HOME and a fake `scribed` first on PATH.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startScribed } from '../../server/meetings/start-scribed.mjs'

const DECIDED = ['--user', '--collect', '--unit=turbidassist-scribed', '--property=KillMode=process']

/**
 * Put a `systemd-run` shim first on a temporary PATH, in the returned `env` and in process.env until the test ends.
 * @param {import('node:test').TestContext} t
 * @param {{ exitCode?: number, stderr?: string, runShell?: boolean }} [opts]
 */
async function shim (t, { exitCode = 0, stderr = '', runShell = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-t9-'))
  const savedPath = process.env.PATH
  const PATH = `${dir}${path.delimiter}${savedPath}`
  process.env.PATH = PATH
  t.after(async () => {
    process.env.PATH = savedPath
    await rm(dir, { recursive: true, force: true })
  })
  const log = path.join(dir, 'calls.jsonl')
  const home = path.join(dir, 'home')
  const script = path.join(dir, 'shim.mjs')
  await writeFile(script, `
import { appendFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, envKeys: Object.keys(process.env) }) + '\\n')
process.stderr.write(${JSON.stringify(stderr)})
if (${exitCode} === 0 && ${runShell}) {
  const at = argv.indexOf('--property=KillMode=process')
  mkdirSync(${JSON.stringify(home)}, { recursive: true })
  const env = { PATH: ${JSON.stringify(`${dir}:/usr/bin:/bin`)}, HOME: ${JSON.stringify(home)} }
  if (at >= 0) spawnSync(argv[at + 1], argv.slice(at + 2).filter((arg) => arg !== '-l'), { env, timeout: 5000 })
}
process.exit(${exitCode})
`)
  await writeFile(path.join(dir, 'systemd-run'), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 })
  await writeFile(path.join(dir, 'scribed'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const env = { PATH, HOME: home, SHELL: '/bin/sh' }
  const calls = async () => {
    try {
      return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  return { dir, env, calls }
}

/** A probe that fails `misses` times, then answers. */
function probeAfter (misses) {
  let n = 0
  const probe = async () => {
    n += 1
    if (n <= misses) throw Object.assign(new Error('scribed_unavailable'), { code: 'scribed_unavailable' })
    return { recording: false }
  }
  return { probe, count: () => n }
}

test('the default command runs exactly the decided systemd-run argv, then returns started once the probe answers', async (t) => {
  const s = await shim(t)
  const { probe } = probeAfter(2)
  const result = await startScribed({ env: s.env, probe, intervalMs: 1 })
  assert.equal(result, 'started')
  const calls = await s.calls()
  assert.equal(calls.length, 1, 'the shim logged exactly one call')
  assert.deepEqual(calls[0].argv, [...DECIDED, '/bin/sh', '-l', '-c', 'exec scribed'])
})

test('the shell falls back to os.userInfo().shell when env has no SHELL', async (t) => {
  const s = await shim(t)
  const env = { ...s.env }
  delete env.SHELL
  await startScribed({ env, probe: probeAfter(1).probe, intervalMs: 1 })
  const [call] = await s.calls()
  assert.equal(call.argv[DECIDED.length], os.userInfo().shell || '/bin/sh')
})

test('a custom scribedCommand arrives as one argv element after exec "$0" and never reaches a shell parser', async (t) => {
  const s = await shim(t, { runShell: true })
  const pwned = path.join(s.dir, 'pwned')
  const command = `scribed --x; touch ${pwned}`
  await startScribed({ scribedCommand: command, env: s.env, probe: probeAfter(1).probe, intervalMs: 1 })
  const calls = await s.calls()
  assert.equal(calls.length, 1, 'the shim logged the call')
  assert.deepEqual(calls[0].argv, [...DECIDED, '/bin/sh', '-l', '-c', 'exec "$0"', command])
  // A backstop only: under the concatenation mutation the replayed shell execs the fake scribed before `;`,
  // so the touch would not run either. The argv assertion above is what catches that mutation.
  await assert.rejects(access(pwned), { code: 'ENOENT' }, 'the injected touch must not run')
})

test('a probe that answers spawns nothing and returns running', async (t) => {
  const s = await shim(t)
  const { probe, count } = probeAfter(0)
  assert.equal(await startScribed({ env: s.env, probe, intervalMs: 1 }), 'running')
  assert.equal(count(), 1)
  assert.deepEqual(await s.calls(), [])
})

test('a non-zero systemd-run exit throws dependency_start_failed with its exit code and stderr', async (t) => {
  const stderr = 'Failed to start transient service unit: Unit turbidassist-scribed.service already exists.\n'
  const s = await shim(t, { exitCode: 1, stderr })
  const { probe, count } = probeAfter(1000)
  await assert.rejects(startScribed({ env: s.env, probe, intervalMs: 1, timeoutMs: 50 }), (error) => {
    assert.equal(error.code, 'dependency_start_failed')
    assert.equal(error.status, 502)
    assert.equal(error.details.exitCode, 1)
    assert.equal(error.details.stderr, stderr)
    return true
  })
  assert.equal((await s.calls()).length, 1, 'the shim logged the call')
  assert.equal(count(), 1, 'no probing after a failed spawn')
})

test('stderr keeps only its last 2 KiB and is redacted', async (t) => {
  const stderr = `${'x'.repeat(4096)}\ntoken=abc123secret Unit turbidassist-scribed.service already exists.\n`
  const s = await shim(t, { exitCode: 1, stderr })
  await assert.rejects(startScribed({ env: s.env, probe: probeAfter(1000).probe, intervalMs: 1 }), (error) => {
    assert.ok(Buffer.byteLength(error.details.stderr) <= 2048)
    assert.ok(error.details.stderr.endsWith('token=*** Unit turbidassist-scribed.service already exists.\n'))
    assert.ok(!error.details.stderr.includes('abc123secret'))
    return true
  })
})

test('a probe that never answers within an injected 300 ms throws dependency_start_failed with reason no_socket', async (t) => {
  const s = await shim(t)
  let clock = 0
  const now = () => clock
  const sleep = async (ms) => { clock += ms }
  const { probe, count } = probeAfter(Infinity)
  await assert.rejects(startScribed({ env: s.env, probe, timeoutMs: 300, intervalMs: 100, now, sleep }), (error) => {
    assert.equal(error.code, 'dependency_start_failed')
    assert.deepEqual(error.details, { reason: 'no_socket' })
    return true
  })
  assert.equal((await s.calls()).length, 1, 'the shim logged the call')
  assert.equal(clock, 300)
  assert.equal(count(), 4, 'one probe before the spawn, then one every 100 ms up to 300 ms')
})

test('the systemd-run environment carries no deck token variable', async (t) => {
  const s = await shim(t)
  const saved = process.env.FLEETMATES_DECK_TOKEN
  process.env.FLEETMATES_DECK_TOKEN = 'deck-token-sentinel'
  t.after(() => {
    if (saved === undefined) delete process.env.FLEETMATES_DECK_TOKEN
    else process.env.FLEETMATES_DECK_TOKEN = saved
  })
  await startScribed({ env: { ...s.env, OTHER_TOKEN: 'x' }, probe: probeAfter(1).probe, intervalMs: 1 })
  const calls = await s.calls()
  assert.equal(calls.length, 1, 'the shim logged the call')
  assert.ok(calls[0].envKeys.includes('PATH'))
  assert.deepEqual(calls[0].envKeys.filter((key) => /TOKEN/i.test(key)), [])
})
