import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runtimeBase, deckDir, endpoint, isPipe, ensurePrivateDir, privateFileProblem, killTree,
  resolveCommand, quoteCmdArg, commandSpawn, openUrlArgv, isClaudeProgram, unwrapNodeShim,
} from '../../platform/index.mjs'
import * as platformModule from '../../platform/index.mjs'

const moduleFile = fileURLToPath(new URL('../../platform/index.mjs', import.meta.url))

test('the platform module imports only node: modules and exports exactly the documented names', async () => {
  const source = await readFile(moduleFile, 'utf8')
  const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1])
  assert.ok(specifiers.length > 0)
  for (const s of specifiers) assert.match(s, /^node:/, `${s} is not a node: module`)
  assert.deepEqual(Object.keys(platformModule).sort(), [
    'commandSpawn', 'deckDir', 'endpoint', 'ensurePrivateDir', 'isClaudeProgram', 'isPipe', 'killTree',
    'openUrlArgv', 'privateFileProblem', 'quoteCmdArg', 'resolveCommand', 'runtimeBase', 'unwrapNodeShim',
  ])
})

test('runtimeBase prefers a non-empty XDG_RUNTIME_DIR on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(runtimeBase({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, platform, uid: 1000, home: '/home/you' }), '/run/user/1000', platform)
  }
})

test('runtimeBase falls back per platform when XDG_RUNTIME_DIR is missing or empty', () => {
  assert.equal(runtimeBase({ env: {}, platform: 'linux', uid: 1000, home: '/home/you' }), '/tmp/fleetmates-deck-1000')
  assert.equal(runtimeBase({ env: { XDG_RUNTIME_DIR: '' }, platform: 'linux', uid: 1000, home: '/home/you' }), '/tmp/fleetmates-deck-1000')
  assert.equal(runtimeBase({ env: {}, platform: 'darwin', uid: 501, home: '/Users/you' }), '/Users/you/Library/Caches/fleetmates-deck')
  assert.equal(runtimeBase({ env: { LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local' }, platform: 'win32', uid: null, home: 'C:\\Users\\you' }),
    'C:\\Users\\you\\AppData\\Local\\fleetmates-deck\\run')
  assert.equal(runtimeBase({ env: {}, platform: 'win32', uid: null, home: 'C:\\Users\\you' }),
    'C:\\Users\\you\\AppData\\Local\\fleetmates-deck\\run')
})

test('deckDir joins with the platform path flavour', () => {
  assert.equal(deckDir('/run/user/1000', { platform: 'linux' }), '/run/user/1000/fleetmates-deck')
  assert.equal(deckDir('/Users/you/Library/Caches/fleetmates-deck', { platform: 'darwin' }), '/Users/you/Library/Caches/fleetmates-deck/fleetmates-deck')
  assert.equal(deckDir('C:\\Users\\you\\AppData\\Local\\fleetmates-deck\\run', { platform: 'win32' }), 'C:\\Users\\you\\AppData\\Local\\fleetmates-deck\\run\\fleetmates-deck')
})

test('endpoint on POSIX is a socket under deckDir, with a /tmp fallback past 100 bytes', () => {
  assert.equal(endpoint('/run/user/1000', 'deckd', { platform: 'linux', uid: 1000 }), '/run/user/1000/fleetmates-deck/deckd.sock')
  assert.equal(endpoint('/Users/you/Library/Caches/fleetmates-deck', 'hooks', { platform: 'darwin', uid: 501 }),
    '/Users/you/Library/Caches/fleetmates-deck/fleetmates-deck/hooks.sock')
  const long = '/run/' + 'x'.repeat(90)
  assert.equal(endpoint(long, 'deckd', { platform: 'linux', uid: 1000 }), '/tmp/fleetmates-deck-1000/deckd.sock')
  assert.equal(endpoint(long, 'hooks', { platform: 'darwin', uid: 501 }), '/tmp/fleetmates-deck-501/hooks.sock')
  // Exactly 100 bytes stays; 101 falls back. '/fleetmates-deck/deckd.sock' is 27 bytes.
  const at100 = '/' + 'y'.repeat(72)
  assert.equal(Buffer.byteLength(endpoint(at100, 'deckd', { platform: 'linux', uid: 7 })), 100)
  assert.equal(endpoint('/' + 'y'.repeat(73), 'deckd', { platform: 'linux', uid: 7 }), '/tmp/fleetmates-deck-7/deckd.sock')
})

test('endpoint on win32 is a named pipe hashed from the case-folded base', () => {
  const a = endpoint('C:\\Users\\you\\AppData\\Local\\fleetmates-deck\\run', 'deckd', { platform: 'win32', uid: null })
  assert.match(a, /^\\\\\.\\pipe\\fleetmates-deck-[0-9a-f]{16}-deckd$/)
  const upper = endpoint('C:\\USERS\\YOU\\AppData\\Local\\fleetmates-deck\\run', 'deckd', { platform: 'win32', uid: null })
  assert.equal(upper, a, 'same base, different case, same pipe')
  const other = endpoint('D:\\elsewhere', 'deckd', { platform: 'win32', uid: null })
  assert.notEqual(other, a)
  const hooks = endpoint('C:\\Users\\you\\AppData\\Local\\fleetmates-deck\\run', 'hooks', { platform: 'win32', uid: null })
  assert.equal(hooks, a.replace(/-deckd$/, '-hooks'))
})

test('endpoint refuses an unknown name on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.throws(() => endpoint('/run/user/1000', 'other', { platform, uid: 1000 }), /other/)
  }
})

test('isPipe recognises both pipe prefixes and nothing else', () => {
  assert.equal(isPipe('\\\\.\\pipe\\fleetmates-deck-0123456789abcdef-deckd'), true)
  assert.equal(isPipe('\\\\?\\pipe\\fleetmates-deck-0123456789abcdef-deckd'), true)
  assert.equal(isPipe('/run/user/1000/fleetmates-deck/deckd.sock'), false)
  assert.equal(isPipe('C:\\pipe\\x'), false)
})

test('ensurePrivateDir creates a 0700 dir, rejects 0755 on linux and accepts it on win32', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'deck-platform-'))
  try {
    const uid = process.getuid()
    const fresh = path.join(base, 'a', 'b')
    await ensurePrivateDir(fresh, { platform: 'linux', uid })
    assert.equal((await stat(fresh)).mode & 0o777, 0o700)
    await chmod(fresh, 0o755)
    await assert.rejects(ensurePrivateDir(fresh, { platform: 'linux', uid }),
      { message: `runtime dir ${fresh} has mode 0755; it must allow no group or world access (0700)` })
    await assert.rejects(ensurePrivateDir(fresh, { platform: 'darwin', uid }), /mode 0755/)
    await ensurePrivateDir(fresh, { platform: 'win32', uid: null })
    await chmod(fresh, 0o700)
    await assert.rejects(ensurePrivateDir(fresh, { platform: 'linux', uid: uid + 1 }),
      { message: `runtime dir ${fresh} is owned by uid ${uid}, not by this user` })
    await ensurePrivateDir(fresh, { platform: 'linux', uid: null })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('privateFileProblem reports wrong uid and wrong mode on POSIX, nothing on win32', () => {
  assert.equal(privateFileProblem({ uid: 1000, mode: 0o100600 }, { platform: 'linux', uid: 1000 }), null)
  assert.match(privateFileProblem({ uid: 1001, mode: 0o100600 }, { platform: 'linux', uid: 1000 }), /uid 1001/)
  assert.match(privateFileProblem({ uid: 1000, mode: 0o100644 }, { platform: 'darwin', uid: 1000 }), /0644/)
  assert.match(privateFileProblem({ uid: 1000, mode: 0o100400 }, { platform: 'linux', uid: 1000 }), /0400/)
  assert.equal(privateFileProblem({ uid: 1000, mode: 0o100400 }, { platform: 'linux', uid: 1000, mode: 0o400 }), null)
  assert.equal(privateFileProblem({ uid: 1001, mode: 0o100600 }, { platform: 'linux', uid: null }), null)
  assert.equal(privateFileProblem({ uid: 0, mode: 0o100666 }, { platform: 'win32', uid: null }), null)
  for (const line of [privateFileProblem({ uid: 1001, mode: 0o100644 }, { platform: 'linux', uid: 1000 })]) assert.doesNotMatch(line, /\n/)
})

test('killTree on win32 runs taskkill /T /F with windowsHide and never calls kill', () => {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const calls = []
    const kill = () => { throw new Error('kill must not be called on win32') }
    const result = killTree(4321, signal, { platform: 'win32', kill, spawnSync: (...a) => { calls.push(a); return { status: 0 } } })
    assert.equal(result, undefined)
    assert.deepEqual(calls, [['taskkill', ['/PID', '4321', '/T', '/F'], { windowsHide: true, stdio: 'ignore' }]])
  }
})

test('killTree on POSIX signals the group, falls back to the pid on EPERM, ignores ESRCH, throws others', () => {
  const error = code => Object.assign(new Error(code), { code })
  const spawnSync = () => { throw new Error('spawnSync must not be called on POSIX') }
  for (const platform of ['linux', 'darwin']) {
    const calls = []
    killTree(123, undefined, { platform, spawnSync, kill: (pid, signal) => calls.push([pid, signal]) })
    assert.deepEqual(calls.splice(0), [[-123, 'SIGTERM']])
    killTree(123, 'SIGKILL', { platform, spawnSync, kill: (pid, signal) => { calls.push([pid, signal]); if (pid < 0) throw error('EPERM') } })
    assert.deepEqual(calls.splice(0), [[-123, 'SIGKILL'], [123, 'SIGKILL']])
    killTree(123, 'SIGTERM', { platform, spawnSync, kill: pid => { calls.push(pid); throw error('ESRCH') } })
    assert.deepEqual(calls.splice(0), [-123])
    killTree(123, 'SIGTERM', { platform, spawnSync, kill: pid => { throw error(pid < 0 ? 'EPERM' : 'ESRCH') } })
    assert.throws(() => killTree(123, 'SIGTERM', { platform, spawnSync, kill: () => { throw error('EACCES') } }), { code: 'EACCES' })
    assert.throws(() => killTree(123, 'SIGTERM', { platform, spawnSync, kill: () => { throw error('EPERM') } }), { code: 'EPERM' })
  }
})

test('resolveCommand leaves POSIX names alone and searches PATH x PATHEXT on win32', () => {
  assert.equal(resolveCommand('claude', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => true }), 'claude')
  assert.equal(resolveCommand('claude', { platform: 'darwin', env: { PATH: '/usr/bin' }, exists: () => true }), 'claude')

  const dir = 'C:\\Users\\you\\AppData\\Roaming\\npm'
  const files = new Set([path.win32.join(dir, 'claude.cmd').toLowerCase()])
  const exists = p => files.has(p.toLowerCase())
  const env = { PATH: `C:\\Windows\\System32;;${dir}` }
  assert.equal(resolveCommand('claude', { platform: 'win32', env, exists }), path.win32.join(dir, 'claude.cmd'))

  // .EXE before .CMD when PATHEXT says so, in the same directory.
  files.add(path.win32.join(dir, 'claude.exe').toLowerCase())
  assert.equal(resolveCommand('claude', { platform: 'win32', env: { ...env, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, exists }), path.win32.join(dir, 'claude.exe'))
  assert.equal(resolveCommand('claude', { platform: 'win32', env: { ...env, PATHEXT: '.CMD;.EXE' }, exists }), path.win32.join(dir, 'claude.cmd'))
  // The default PATHEXT puts .EXE before .CMD.
  assert.equal(resolveCommand('claude', { platform: 'win32', env, exists }), path.win32.join(dir, 'claude.exe'))

  // A name with a separator or an extension is returned as is; nothing found returns the name.
  const never = () => { throw new Error('exists must not be called') }
  assert.equal(resolveCommand('C:\\tools\\claude', { platform: 'win32', env, exists: never }), 'C:\\tools\\claude')
  assert.equal(resolveCommand('bin/claude', { platform: 'win32', env, exists: never }), 'bin/claude')
  assert.equal(resolveCommand('claude.exe', { platform: 'win32', env, exists: never }), 'claude.exe')
  assert.equal(resolveCommand('missing', { platform: 'win32', env, exists: () => false }), 'missing')
})

test('quoteCmdArg quotes for cmd.exe the way cross-spawn does', () => {
  assert.equal(quoteCmdArg('a b'), '^"a b^"')
  assert.equal(quoteCmdArg('a"b'), '^"a\\^"b^"')
  assert.equal(quoteCmdArg('a&b'), '^"a^&b^"')
  assert.equal(quoteCmdArg('100%'), '^"100^%^"')
  assert.equal(quoteCmdArg('a\\'), '^"a\\\\^"')
  assert.equal(quoteCmdArg('a\\b'), '^"a\\b^"')
  // Backslashes before a double quote are doubled, then the quote is escaped (CommandLineToArgvW).
  assert.equal(quoteCmdArg('a\\"b'), '^"a\\\\\\^"b^"')
  assert.equal(quoteCmdArg('a\\\\"b'), '^"a\\\\\\\\\\^"b^"')
  assert.equal(quoteCmdArg('(x)!^<y>|z'), '^"^(x^)^!^^^<y^>^|z^"')
})

const noShim = () => '@echo off\r\nC:\\tools\\real.exe %*\r\n'

test('commandSpawn wraps .cmd and .bat in cmd.exe on win32 and passes everything else through', () => {
  const cmd = commandSpawn('C:\\npm\\claude.cmd', ['--resume', 'a&b'], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, readFile: noShim })
  assert.deepEqual(cmd, {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', '"^"C:\\npm\\claude.cmd^" ^"--resume^" ^"a^&b^""'],
    options: { windowsVerbatimArguments: true, windowsHide: true },
  })
  assert.equal(commandSpawn('X.BAT', [], { platform: 'win32', env: {}, readFile: noShim }).file, 'cmd.exe')
  assert.deepEqual(commandSpawn('C:\\bin\\claude.exe', ['a b'], { platform: 'win32', env: {} }),
    { file: 'C:\\bin\\claude.exe', args: ['a b'], options: { windowsHide: true } })
  assert.deepEqual(commandSpawn('/usr/bin/claude', ['a b'], { platform: 'linux' }), { file: '/usr/bin/claude', args: ['a b'], options: {} })
  assert.deepEqual(commandSpawn('run.cmd', ['x'], { platform: 'darwin' }), { file: 'run.cmd', args: ['x'], options: {} })
})

test('openUrlArgv per platform', () => {
  const url = 'http://127.0.0.1:7420/?a=1&b=2'
  assert.deepEqual(openUrlArgv(url, { platform: 'linux' }), ['xdg-open', url])
  assert.deepEqual(openUrlArgv(url, { platform: 'darwin' }), ['open', url])
  assert.deepEqual(openUrlArgv(url, { platform: 'win32' }), ['cmd.exe', '/d', '/s', '/c', 'start', '""', '^"http://127.0.0.1:7420/?a=1^&b=2^"'])
})

test('isClaudeProgram accepts claude, and on win32 also claude.exe and claude.cmd in any case', () => {
  assert.equal(isClaudeProgram('/usr/local/bin/claude', { platform: 'linux' }), true)
  assert.equal(isClaudeProgram('claude', { platform: 'darwin' }), true)
  assert.equal(isClaudeProgram('/usr/bin/claude.exe', { platform: 'linux' }), false)
  assert.equal(isClaudeProgram('/usr/bin/Claude', { platform: 'linux' }), false)
  assert.equal(isClaudeProgram('/usr/bin/bash', { platform: 'linux' }), false)
  for (const file of ['C:\\npm\\claude.cmd', 'C:\\bin\\CLAUDE.EXE', 'claude', 'C:/bin/Claude.Exe']) {
    assert.equal(isClaudeProgram(file, { platform: 'win32' }), true, file)
  }
  assert.equal(isClaudeProgram('C:\\bin\\claude.bat', { platform: 'win32' }), false)
  assert.equal(isClaudeProgram('C:\\bin\\notclaude.exe', { platform: 'win32' }), false)
})

// The body npm's cmd-shim writes for a package bin (CRLF line endings).
const CMD_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', '',
].join('\r\n')

test('unwrapNodeShim finds the JS entry of an npm cmd-shim written to disk, and null otherwise', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'deck-shim-'))
  try {
    const shim = path.join(base, 'claude.cmd')
    await writeFile(shim, CMD_SHIM)
    const file = 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd'
    const readShim = p => { assert.equal(p, file); return readFileSync(shim, 'utf8') }
    assert.equal(unwrapNodeShim(file, { readFile: readShim }), 'C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js')
    // %~dp0, upper case, .mjs and .cjs, and a parent-relative path.
    assert.equal(unwrapNodeShim('C:\\a\\b\\x.cmd', { readFile: () => '@"%~DP0\\..\\lib\\X.MJS" %*' }), 'C:\\a\\lib\\X.MJS')
    assert.equal(unwrapNodeShim('C:\\a\\x.cmd', { readFile: () => 'node "%dp0%\\bin\\x.cjs" %*' }), 'C:\\a\\bin\\x.cjs')
    assert.equal(unwrapNodeShim('C:\\a\\x.cmd', { readFile: () => 'C:\\tools\\real.exe %*' }), null)
    assert.equal(unwrapNodeShim('C:\\a\\x.cmd', { readFile: () => '"%dp0%\\node.exe" %*' }), null)
    assert.equal(unwrapNodeShim('C:\\a\\x.cmd', { readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } }), null)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('commandSpawn runs an npm cmd-shim .cmd through node directly, with no cmd.exe', () => {
  const file = 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd'
  const js = 'C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
  const args = ['x"&echo INJECTED>%TEMP%\\pwn.txt&"y', 'a\nb']
  assert.deepEqual(commandSpawn(file, args, { platform: 'win32', env: {}, readFile: () => CMD_SHIM, nodePath: 'C:\\node\\node.exe' }),
    { file: 'C:\\node\\node.exe', args: [js, ...args], options: { windowsHide: true } })
  assert.equal(commandSpawn(file, [], { platform: 'win32', env: {}, readFile: () => CMD_SHIM }).file, process.execPath)
})

test('commandSpawn refuses ", CR, LF and % in an argument to a .cmd or .bat it cannot unwrap, naming only the index', () => {
  for (const file of ['C:\\tools\\run.cmd', 'C:\\tools\\RUN.BAT']) {
    for (const bad of ['x"&echo INJECTED&"y', 'a\rb', 'a\nb', '100%']) {
      assert.throws(() => commandSpawn(file, ['ok', bad], { platform: 'win32', env: {}, readFile: noShim }), err => {
        assert.equal(err.code, 'unsafe_cmd_arg')
        assert.match(err.message, /argument 1\b/)
        assert.ok(!err.message.includes(bad), 'the message does not echo the argument')
        return true
      }, `${file} ${JSON.stringify(bad)}`)
    }
    assert.equal(commandSpawn(file, ['a^b', 'a!b', 'a&b'], { platform: 'win32', env: {}, readFile: noShim }).args.length, 4)
  }
  // POSIX and a win32 .exe pass the same arguments through untouched.
  assert.deepEqual(commandSpawn('/usr/bin/run.cmd', ['100%'], { platform: 'linux' }).args, ['100%'])
  assert.deepEqual(commandSpawn('C:\\bin\\x.exe', ['a"b%'], { platform: 'win32', env: {} }).args, ['a"b%'])
})
