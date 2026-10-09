import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signalProcessGroup, PtyHost } from '../../deckd/pty-host.mjs'

test('PTY signals prefer the group, fall back to the owned PID on EPERM, and retain other errors', () => {
  const calls = []
  const error = code => Object.assign(new Error(code), { code })
  signalProcessGroup(123, 'SIGTERM', (pid, signal) => calls.push([pid, signal]))
  assert.deepEqual(calls.splice(0), [[-123, 'SIGTERM']])
  signalProcessGroup(123, 'SIGKILL', (pid, signal) => {
    calls.push([pid, signal])
    if (pid < 0) throw error('EPERM')
  })
  assert.deepEqual(calls.splice(0), [[-123, 'SIGKILL'], [123, 'SIGKILL']])
  signalProcessGroup(123, 'SIGTERM', pid => {
    calls.push(pid)
    throw error('ESRCH')
  })
  assert.deepEqual(calls.splice(0), [-123])
  signalProcessGroup(123, 'SIGTERM', pid => { throw error(pid < 0 ? 'EPERM' : 'ESRCH') })
  assert.throws(() => signalProcessGroup(123, 'SIGTERM', () => { throw error('EACCES') }), { code: 'EACCES' })
  assert.throws(() => signalProcessGroup(123, 'SIGTERM', () => { throw error('EPERM') }), { code: 'EPERM' })
})

/**
 * A stand-in for node-pty's spawn that records its arguments and returns a process that never runs.
 * Each call of the process's own kill() is pushed onto `ptyKills` with its arguments.
 * @param {any[]} calls
 * @param {any[][]} [ptyKills]
 */
function fakePtySpawn (calls, ptyKills = []) {
  return (/** @type {string} */ file, /** @type {any} */ args, /** @type {any} */ opts) => {
    calls.push({ file, args, opts })
    return { pid: 4242, onData () {}, onExit () {}, write () {}, resize () {}, kill (/** @type {any[]} */ ...a) { ptyKills.push(a) } }
  }
}

const hooks = { onOutput () {}, onExit () {} }

/**
 * Spawn through PtyHost with a fake pty; returns the host (the caller disposes it) or throws.
 * @param {string[]} argv
 * @param {Record<string, any>} deps
 */
function spawnWith (argv, { env = {}, ...deps }) {
  return PtyHost.spawn({ argv, cwd: '/home/you', baseEnv: {}, env }, hooks, deps)
}

test('PtyHost refuses a program that isClaudeProgram rejects for the injected platform', () => {
  /** @type {any[]} */
  const calls = []
  for (const argv0 of ['claude.cmd', 'claude.exe', 'bash', 'claude.bat', '/some/dir/xclaude']) {
    assert.throws(() => spawnWith([argv0], { platform: 'linux', ptySpawn: fakePtySpawn(calls) }), { code: 'spawn_refused' }, argv0)
  }
  for (const argv0 of ['claude.bat', 'notclaude.exe', 'C:\\bin\\claude.ps1', 'bash.exe']) {
    assert.throws(() => spawnWith([argv0], { platform: 'win32', ptySpawn: fakePtySpawn(calls) }), { code: 'spawn_refused' }, argv0)
  }
  assert.deepEqual(calls, [])
})

test('on win32 PtyHost accepts claude, claude.exe and claude.cmd in any case', () => {
  for (const argv0 of ['claude', 'claude.exe', 'C:\\Users\\you\\AppData\\Roaming\\npm\\Claude.CMD', 'CLAUDE.EXE']) {
    /** @type {any[]} */
    const calls = []
    const host = spawnWith([argv0], { platform: 'win32', ptySpawn: fakePtySpawn(calls), exists: () => false, readFile: () => '' })
    try {
      assert.equal(calls.length, 1, argv0)
    } finally {
      host.dispose()
    }
  }
})

test('on win32 PtyHost resolves claude on PATH, unwraps an npm cmd-shim and passes windowsHide', () => {
  /** @type {any[]} */
  const calls = []
  const shim = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*', ''
  ].join('\r\n')
  const host = spawnWith(['claude', '--resume', 'a b'], {
    platform: 'win32',
    env: { Path: 'C:\\nothing;C:\\npm', PATHEXT: '.EXE;.CMD' },
    exists: (/** @type {string} */ p) => p === 'C:\\npm\\claude.cmd',
    readFile: (/** @type {string} */ p) => { assert.equal(p, 'C:\\npm\\claude.cmd'); return shim },
    ptySpawn: fakePtySpawn(calls)
  })
  try {
    assert.equal(calls.length, 1)
    assert.equal(calls[0].file, process.execPath)
    assert.deepEqual(calls[0].args, ['C:\\npm\\node_modules\\pkg\\cli.js', '--resume', 'a b'])
    assert.equal(calls[0].opts.windowsHide, true)
    // the argv the deck reports is still the one it was asked for
    assert.deepEqual(host.argv, ['claude', '--resume', 'a b'])
  } finally {
    host.dispose()
  }
})

test('on win32 a claude.cmd that is not an npm shim runs through ComSpec with one verbatim command line', () => {
  /** @type {any[]} */
  const calls = []
  const host = spawnWith(['C:\\tools\\claude.cmd', 'a b', 'x&y'], {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    readFile: () => '@echo off\r\nnode "%~dp0\\x.js" --flag %*\r\n',
    ptySpawn: fakePtySpawn(calls)
  })
  try {
    assert.equal(calls[0].file, 'C:\\Windows\\system32\\cmd.exe')
    // a string, which node-pty takes as a command line and does not quote again
    assert.equal(calls[0].args, '/d /s /c "C:\\tools\\claude.cmd ^"a b^" ^"x^&y^""')
    assert.equal(calls[0].opts.windowsHide, true)
  } finally {
    host.dispose()
  }
})

test('on win32 an argument cmd.exe cannot pass safely to a batch claude is refused with bad_request', () => {
  /** @type {any[]} */
  const calls = []
  assert.throws(() => spawnWith(['C:\\tools\\claude.cmd', '-p', 'say "hi"'], {
    platform: 'win32',
    readFile: () => '@echo off\r\n',
    ptySpawn: fakePtySpawn(calls)
  }), (/** @type {any} */ err) => err.code === 'bad_request' && /double quote/.test(err.message))
  assert.deepEqual(calls, [])
})

test('on win32 kill runs taskkill on the tree for SIGTERM, SIGINT and SIGHUP, then closes the pseudoconsole, and never signals a group', () => {
  for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])) {
    /** @type {any[]} */
    const order = []
    const host = spawnWith(['claude'], {
      platform: 'win32',
      exists: () => false,
      ptySpawn: (/** @type {any[]} */ ...a) => {
        const proc = fakePtySpawn([])(...a)
        proc.kill = (/** @type {any[]} */ ...k) => { order.push(['pty.kill', ...k]) }
        return proc
      },
      spawnSync: (/** @type {any[]} */ ...args) => { order.push(args) },
      kill: () => { throw new Error('process.kill must not be called on win32') }
    })
    try {
      host.kill(signal, 60000)
      // node-pty's kill() with no signal: on Windows it throws for any signal
      assert.deepEqual(order, [['taskkill', ['/PID', '4242', '/T', '/F'], { windowsHide: true, stdio: 'ignore' }], ['pty.kill']], signal)
    } finally {
      host.dispose()
    }
    // dispose after kill does not close the pseudoconsole a second time
    assert.equal(order.filter((o) => o[0] === 'pty.kill').length, 1, signal)
  }
})

test('on win32 dispose closes a pseudoconsole that is still open, once', () => {
  /** @type {any[][]} */
  const ptyKills = []
  const host = spawnWith(['claude'], { platform: 'win32', exists: () => false, ptySpawn: fakePtySpawn([], ptyKills) })
  host.dispose()
  host.dispose()
  assert.deepEqual(ptyKills, [[]])
})

test('on linux kill signals the process group through the injected kill and never calls the pty kill', () => {
  /** @type {any[]} */
  const kills = []
  /** @type {any[][]} */
  const ptyKills = []
  const host = spawnWith(['claude'], {
    platform: 'linux',
    ptySpawn: fakePtySpawn([], ptyKills),
    spawnSync: () => { throw new Error('spawnSync must not be called on linux') },
    kill: (/** @type {number} */ pid, /** @type {string} */ signal) => { kills.push([pid, signal]) }
  })
  try {
    host.kill('SIGINT', 60000)
    assert.deepEqual(kills, [[-4242, 'SIGINT']])
  } finally {
    host.dispose()
  }
  assert.deepEqual(ptyKills, [])
})
