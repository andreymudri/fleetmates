// deckd's login-environment probe (OPS-O2 as amended on 2026-10-01). Every
// test hands captureLoginEnv a fake shell script, so the owner's real
// `$SHELL -l -i` never runs here.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { captureLoginEnv, dropSessionVars, changedNames, CLAUDE_SESSION_VARS } from '../../deckd/login-env.mjs'

// captureLoginEnv defaults `shell` to $SHELL. Point it at nothing, so a call
// that forgets to pass a fake shell falls back instead of running the
// owner's real profile.
process.env.SHELL = path.join(os.tmpdir(), 'deck-no-shell-in-tests')

/** @type {string} */
let dir

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'deck-login-env-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * Write an executable fake shell.
 * @param {string} name
 * @param {string} body shell script body, after the shebang
 * @returns {Promise<string>} its path
 */
async function fakeShell (name, body) {
  const file = path.join(dir, name)
  await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  return file
}

test('CLAUDE_SESSION_VARS is exactly the per-session list the owner chose', () => {
  assert.deepEqual([...CLAUDE_SESSION_VARS].sort(), [
    'CLAUDECODE',
    'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_ENV_FILE',
    'CLAUDE_PID',
    'CLAUDE_PROJECT_DIR'
  ])
  assert.ok(Object.isFrozen(CLAUDE_SESSION_VARS))
})

test('captureLoginEnv keeps profile CLAUDE_CODE_* names and drops the session ones and TERM', async () => {
  const argvLog = path.join(dir, 'argv.log')
  // Records its argv, then runs the probe's command with an environment of
  // its own, as a login shell would after reading a profile.
  const shell = await fakeShell('sh-ok', [
    `printf '%s\\n' "$@" > '${argvLog}'`,
    `exec env -i CLAUDE_CODE_FOO=1 CLAUDE_CODE_EXECPATH=/home/you/bin/x CLAUDE_CODE_SESSION_ID=abc CLAUDECODE=1 TERM=dumb PATH=/home/you/bin:/usr/bin "MULTI=$(printf 'a=b\\nc')" /bin/sh -c "$4"`
  ].join('\n'))
  const env = await captureLoginEnv({ shell, baseEnv: { FROM_BASE: '1' } })
  assert.equal(env.CLAUDE_CODE_FOO, '1')
  assert.equal(env.CLAUDE_CODE_EXECPATH, '/home/you/bin/x')
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined)
  assert.equal(env.CLAUDECODE, undefined)
  assert.equal(env.TERM, undefined)
  assert.equal(env.PATH, '/home/you/bin:/usr/bin')
  // a value may hold `=` and newlines; only NUL separates entries
  assert.equal(env.MULTI, 'a=b\nc')
  // the probe's output replaces the base environment, it is not merged into it
  assert.equal(env.FROM_BASE, undefined)
  const argv = (await readFile(argvLog, 'utf8')).split('\n')
  assert.deepEqual(argv.slice(0, 3), ['-l', '-i', '-c'])
  // a NUL-terminated marker first, then the environment
  assert.match(argv[3], /^printf '%s\\0' __FLEETMATES_DECK_ENV_[0-9a-f]{16}__; env -0$/)
})

test('captureLoginEnv keeps every variable when the profile prints a banner first', async () => {
  // Prints a banner with no newline, runs whatever the probe asked for
  // before `env -0`, then an `env -0` whose first variable follows the banner.
  const shell = await fakeShell('sh-banner', [
    "printf 'Welcome back'",
    'eval "${4%env -0}"',
    'exec env -i FIRST_VAR=1 SECOND_VAR=2 env -0'
  ].join('\n'))
  const env = await captureLoginEnv({ shell, baseEnv: { FROM_BASE: '1' } })
  assert.equal(env.FIRST_VAR, '1')
  assert.equal(env.SECOND_VAR, '2')
  assert.equal(env.FROM_BASE, undefined)
})

test('captureLoginEnv answers when the shell exits, though a background job still holds stdout', async () => {
  const pidFile = path.join(dir, 'sleeper.pid')
  const shell = await fakeShell('sh-bg', [
    `sleep 30 & echo $! > '${pidFile}'`,
    'env -i A_VAR=1 /bin/sh -c "$4"',
    'exit 0'
  ].join('\n'))
  /** @type {string[]} */
  const fallbacks = []
  const t0 = Date.now()
  try {
    const env = await captureLoginEnv({ shell, timeoutMs: 5000, baseEnv: { FROM_BASE: '1' }, onFallback: (r) => fallbacks.push(r) })
    assert.equal(env.A_VAR, '1')
    assert.deepEqual(fallbacks, [])
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`)
  } finally {
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
    if (pid) try { process.kill(pid, 'SIGKILL') } catch {}
  }
})

test('captureLoginEnv reports why it fell back', async () => {
  const base = { FROM_BASE: '1' }
  /** @param {string} shell */
  const reason = async (shell, timeoutMs = 5000) => {
    /** @type {string[]} */
    const got = []
    await captureLoginEnv({ shell, timeoutMs, baseEnv: base, onFallback: (r) => got.push(r) })
    return got
  }
  assert.deepEqual(await reason(await fakeShell('sh-r-exit', 'exit 3')), ['exit'])
  assert.deepEqual(await reason(await fakeShell('sh-r-slow', 'sleep 5'), 200), ['timeout'])
  assert.deepEqual(await reason(await fakeShell('sh-r-nomark', "printf 'A=1\\0'")), ['no_output'])
  assert.deepEqual(await reason(path.join(dir, 'no-such-shell')), ['spawn_error'])
  assert.deepEqual(await reason(''), ['no_shell'])
})

test('captureLoginEnv falls back to the base environment, with the same drops, on exit 1', async () => {
  const shell = await fakeShell('sh-fail', 'env -i FROM_SHELL=1 /bin/sh -c "$4"; exit 1')
  const env = await captureLoginEnv({ shell, baseEnv: { FROM_BASE: '1', TERM: 'xterm', CLAUDECODE: '1', CLAUDE_CODE_USE_BEDROCK: '1' } })
  assert.deepEqual(env, { FROM_BASE: '1', CLAUDE_CODE_USE_BEDROCK: '1' })
})

test('captureLoginEnv falls back when the shell runs past the timeout', async () => {
  const shell = await fakeShell('sh-slow', "sleep 5; printf 'FROM_SHELL=1\\0'")
  const t0 = Date.now()
  const env = await captureLoginEnv({ shell, timeoutMs: 200, baseEnv: { FROM_BASE: '1' } })
  assert.deepEqual(env, { FROM_BASE: '1' })
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`)
})

test('captureLoginEnv falls back on a missing shell, an empty shell name and empty output', async () => {
  const base = { FROM_BASE: '1' }
  assert.deepEqual(await captureLoginEnv({ shell: path.join(dir, 'no-such-shell'), baseEnv: base }), base)
  assert.deepEqual(await captureLoginEnv({ shell: '', baseEnv: base }), base)
  const empty = await fakeShell('sh-empty', 'exit 0')
  assert.deepEqual(await captureLoginEnv({ shell: empty, baseEnv: base }), base)
})

test('dropSessionVars removes TERM and the list, returns a copy', () => {
  const src = { TERM: 'xterm', CLAUDE_PID: '1', CLAUDE_PROJECT_DIR: '/home/you/p', CLAUDE_CODE_EXECPATH: '/x', HOME: '/home/you' }
  assert.deepEqual(dropSessionVars(src), { CLAUDE_CODE_EXECPATH: '/x', HOME: '/home/you' })
  assert.equal(src.TERM, 'xterm')
})

test('changedNames returns sorted names that are new or differ, never values', () => {
  const names = changedNames({ PATH: '/a:/b', HOME: '/home/you', NEW_ONE: 'secret-value', A_NEW: 'x' }, { PATH: '/b', HOME: '/home/you', GONE: '1' })
  assert.deepEqual(names, ['A_NEW', 'NEW_ONE', 'PATH'])
  assert.ok(!JSON.stringify(names).includes('secret-value'))
})
