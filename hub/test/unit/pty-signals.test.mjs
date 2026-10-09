import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
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
 * Its `_agent` has the node-pty 1.1.0 Windows agent's shape (pty id 7). Pushed onto `events`: the
 * process's own kill() as `['pty.kill', ...args]`, the agent's native kill as
 * `['native.kill', id, useConptyDll]` and the conout worker's dispose as `['conout.dispose']`.
 * @param {any[]} calls
 * @param {any[][]} [events]
 */
function fakePtySpawn (calls, events = []) {
  return (/** @type {string} */ file, /** @type {any} */ args, /** @type {any} */ opts) => {
    calls.push({ file, args, opts })
    return {
      pid: 4242,
      onData () {},
      onExit () {},
      write () {},
      resize () {},
      kill (/** @type {any[]} */ ...a) { events.push(['pty.kill', ...a]) },
      _agent: {
        _pty: 7,
        _useConptyDll: false,
        _inSocket: { readable: true },
        _outSocket: { readable: true },
        _ptyNative: { kill (/** @type {any[]} */ ...a) { events.push(['native.kill', ...a]) } },
        _conoutSocketWorker: { dispose () { events.push(['conout.dispose']) } }
      }
    }
  }
}

const hooks = { onOutput () {}, onExit () {} }

/** An `exists` under which every .exe or .com file exists and nothing else does. */
const exeExists = (/** @type {string} */ p) => /\.(exe|com)$/i.test(p)

/** The claude.exe the win32 kill and console tests run; it passes the PE check. */
const CLAUDE_EXE = 'C:\\bin\\claude.exe'

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
    // every .exe or .com exists, so what runs passes the PE check: claude found on PATH, the name
    // itself, or cmd.exe for the .cmd that is not an npm shim
    const host = spawnWith([argv0], { platform: 'win32', env: { PATH: 'C:\\bin' }, ptySpawn: fakePtySpawn(calls), exists: exeExists, readFile: () => '' })
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
    exists: (/** @type {string} */ p) => p === 'C:\\npm\\claude.cmd' || p === 'C:\\node\\node.exe',
    readFile: (/** @type {string} */ p) => { assert.equal(p, 'C:\\npm\\claude.cmd'); return shim },
    // the node the shim is run with; on a Linux host process.execPath has no .exe
    nodePath: 'C:\\node\\node.exe',
    ptySpawn: fakePtySpawn(calls)
  })
  try {
    assert.equal(calls.length, 1)
    assert.equal(calls[0].file, 'C:\\node\\node.exe')
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
    exists: (/** @type {string} */ p) => p === 'C:\\Windows\\system32\\cmd.exe',
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
    const host = spawnWith([CLAUDE_EXE], {
      platform: 'win32',
      exists: exeExists,
      ptySpawn: fakePtySpawn([], order),
      spawnSync: (/** @type {any[]} */ ...args) => { order.push(args) },
      kill: () => { throw new Error('process.kill must not be called on win32') }
    })
    try {
      host.kill(signal, 60000)
      // the console is closed natively, never through node-pty's kill(), whose console-list
      // agent fails on the dead shell and later kills its pid
      assert.deepEqual(order, [
        ['taskkill', ['/PID', '4242', '/T', '/F'], { windowsHide: true, stdio: 'ignore' }],
        ['native.kill', 7, false],
        ['conout.dispose']
      ], signal)
    } finally {
      host.dispose()
    }
    // dispose after kill does not close the pseudoconsole a second time
    assert.equal(order.filter((o) => o[0] === 'native.kill').length, 1, signal)
  }
})

test('on win32 dispose closes a pseudoconsole that is still open, once, without node-pty kill()', () => {
  /** @type {any[][]} */
  const events = []
  /** @type {any} */
  let proc
  const host = spawnWith([CLAUDE_EXE], {
    platform: 'win32',
    exists: exeExists,
    ptySpawn: (/** @type {any[]} */ ...a) => { proc = fakePtySpawn([], events)(...a); return proc }
  })
  host.dispose()
  host.dispose()
  assert.deepEqual(events, [['native.kill', 7, false], ['conout.dispose']])
  assert.equal(proc._agent._inSocket.readable, false)
  assert.equal(proc._agent._outSocket.readable, false)
})

test('on win32 a node-pty without the 1.1.0 agent shape is left open and never killed through kill()', (t) => {
  /** @type {any[][]} */
  const events = []
  const errors = t.mock.method(console, 'error', () => {})
  const host = spawnWith([CLAUDE_EXE], {
    platform: 'win32',
    exists: exeExists,
    ptySpawn: (/** @type {any[]} */ ...a) => { const p = fakePtySpawn([], events)(...a); delete p._agent; return p }
  })
  host.dispose()
  assert.deepEqual(events, [])
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /cannot close the pseudoconsole/)
})

test('on linux kill signals the process group through the injected kill and never touches the console', () => {
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

/**
 * A recording `prepare` dep: pushes `'prepare'` onto `order`, then throws `error` if given.
 * @param {any[]} order
 * @param {Error} [error]
 */
function recordingPrepare (order, error) {
  return () => {
    order.push('prepare')
    if (error) throw error
    return 1
  }
}

/** A ptySpawn that pushes `'ptySpawn'` onto `order` before returning a fake process. @param {any[]} order */
function orderedPtySpawn (order) {
  const spawn = fakePtySpawn([])
  return (/** @type {[string, any, any]} */ ...a) => { order.push('ptySpawn'); return spawn(...a) }
}

test('on darwin PtyHost makes the spawn helper executable before the first node-pty spawn, once across hosts', () => {
  /** @type {any[]} */
  const order = []
  const deps = { platform: 'darwin', ptySpawn: orderedPtySpawn(order), prepare: recordingPrepare(order) }
  spawnWith(['claude'], deps).dispose()
  spawnWith(['claude'], deps).dispose()
  assert.deepEqual(order, ['prepare', 'ptySpawn', 'ptySpawn'])
})

test('on darwin a spawn helper that cannot be prepared fails the spawn with spawn_failed and node-pty is not called', () => {
  /** @type {any[]} */
  const order = []
  const prepare = recordingPrepare(order, new Error('node-pty macOS spawn helper is missing; reinstall dependencies'))
  assert.throws(() => spawnWith(['claude'], { platform: 'darwin', ptySpawn: orderedPtySpawn(order), prepare }),
    (/** @type {any} */ err) => err.code === 'spawn_failed' && /reinstall/.test(err.message) && /spawn helper is missing/.test(err.message))
  assert.deepEqual(order, ['prepare'])
})

test('off darwin PtyHost never prepares the spawn helper', () => {
  for (const [platform, argv0] of [['linux', 'claude'], ['win32', CLAUDE_EXE]]) {
    /** @type {any[]} */
    const order = []
    spawnWith([argv0], { platform, exists: exeExists, ptySpawn: orderedPtySpawn(order), prepare: recordingPrepare(order) }).dispose()
    assert.deepEqual(order, ['ptySpawn'], platform)
  }
})

/**
 * A ptySpawn returning a fake node-pty 1.1.0 win32 process: the process itself and its agent's
 * input socket are EventEmitters, so an 'error' emitted on either with no listener throws.
 * @param {{ proc?: any }} out receives the process
 * @param {any[][]} events as for fakePtySpawn
 */
function emitterPtySpawn (out, events) {
  return (/** @type {[string, any, any]} */ ...a) => {
    const proc = Object.assign(new EventEmitter(), fakePtySpawn([], events)(...a))
    proc._agent._inSocket = Object.assign(new EventEmitter(), { readable: true })
    out.proc = proc
    return proc
  }
}

/**
 * Run `fn` on a later turn of the event loop and resolve a turn after it, returning every
 * uncaughtException seen meanwhile.
 * @param {() => void} fn
 * @returns {Promise<Error[]>}
 */
async function uncaughtDuring (fn) {
  /** @type {Error[]} */
  const seen = []
  const onUncaught = (/** @type {Error} */ err) => { seen.push(err) }
  process.on('uncaughtException', onUncaught)
  try {
    await new Promise((resolve) => setImmediate(() => { setImmediate(resolve); fn() }))
  } finally {
    process.off('uncaughtException', onUncaught)
  }
  return seen
}

/**
 * Spawn a fake win32 claude.exe whose process and input socket are EventEmitters.
 * @param {any[][]} events receives the taskkill calls and the console close
 */
function win32EmitterHost (events) {
  /** @type {{ proc?: any }} */
  const out = {}
  const host = spawnWith([CLAUDE_EXE], {
    platform: 'win32',
    exists: exeExists,
    ptySpawn: emitterPtySpawn(out, events),
    spawnSync: (/** @type {any[]} */ ...args) => { events.push(args) }
  })
  return { host, proc: out.proc }
}

const ENDED_ON_WIN32 = [
  ['taskkill', ['/PID', '4242', '/T', '/F'], { windowsHide: true, stdio: 'ignore' }],
  ['native.kill', 7, false],
  ['conout.dispose']
]

test('on win32 a write EAGAIN on the input socket is logged with the ptyId and ends the PTY, never an uncaughtException', async (t) => {
  /** @type {any[][]} */
  const events = []
  const errors = t.mock.method(console, 'error', () => {})
  const { host, proc } = win32EmitterHost(events)
  try {
    const eagain = Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN', syscall: 'write' })
    assert.deepEqual(await uncaughtDuring(() => proc._agent._inSocket.emit('error', eagain)), [])
    const logged = errors.mock.calls.map((c) => String(c.arguments[0]))
    assert.ok(logged.some((m) => m.includes(host.ptyId) && m.includes('write EAGAIN')), logged.join('\n'))
    // ended as a crash: taskkill on the tree, the pseudoconsole closed, and the reason kept
    assert.deepEqual(events, ENDED_ON_WIN32)
    assert.match(String(host.inputFailed), /write EAGAIN/)
    // a second error on the destroyed socket does not end it again
    proc._agent._inSocket.emit('error', eagain)
    assert.deepEqual(events, ENDED_ON_WIN32)
  } finally {
    host.dispose()
  }
})

test('on win32 a terminal error other than EIO is logged and ends the PTY; EIO, a normal end, does neither', async (t) => {
  for (const [code, ends] of /** @type {[string, boolean][]} */ ([['EPIPE', true], ['EIO', false]])) {
    /** @type {any[][]} */
    const events = []
    const errors = t.mock.method(console, 'error', () => {})
    const { host, proc } = win32EmitterHost(events)
    try {
      assert.deepEqual(await uncaughtDuring(() => proc.emit('error', Object.assign(new Error(`read ${code}`), { code }))), [], code)
      assert.deepEqual(events, ends ? ENDED_ON_WIN32 : [], code)
      assert.equal(errors.mock.calls.some((c) => String(c.arguments[0]).includes(host.ptyId)), ends, code)
    } finally {
      host.dispose()
      errors.mock.restore()
    }
  }
})

test('on win32 a process without the 1.1.0 input socket or an on() still spawns', () => {
  const host = spawnWith([CLAUDE_EXE], {
    platform: 'win32',
    exists: exeExists,
    ptySpawn: (/** @type {[string, any, any]} */ ...a) => { const p = fakePtySpawn([])(...a); delete p._agent._inSocket; return p }
  })
  host.dispose()
})

test('on linux PtyHost adds no error listener to the process', () => {
  /** @type {{ proc?: any }} */
  const out = {}
  const host = spawnWith(['claude'], { platform: 'linux', ptySpawn: emitterPtySpawn(out, []) })
  try {
    assert.equal(out.proc.listenerCount('error'), 0)
    assert.equal(out.proc._agent._inSocket.listenerCount('error'), 0)
  } finally {
    host.dispose()
  }
})
