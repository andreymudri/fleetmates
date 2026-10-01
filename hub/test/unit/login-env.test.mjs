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
  const shell = await fakeShell('sh-ok', [
    `printf '%s\\n' "$@" > '${argvLog}'`,
    "printf 'CLAUDE_CODE_FOO=1\\0CLAUDE_CODE_EXECPATH=/home/you/bin/x\\0CLAUDE_CODE_SESSION_ID=abc\\0CLAUDECODE=1\\0TERM=dumb\\0PATH=/home/you/bin:/usr/bin\\0MULTI=a=b\\nc\\0'"
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
  assert.deepEqual((await readFile(argvLog, 'utf8')).split('\n').slice(0, 4), ['-l', '-i', '-c', 'env -0'])
})

test('captureLoginEnv falls back to the base environment, with the same drops, on exit 1', async () => {
  const shell = await fakeShell('sh-fail', "printf 'FROM_SHELL=1\\0'; exit 1")
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
