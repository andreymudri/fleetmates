import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import fs, { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runtimeBase, deckDir, endpoint, isPipe, ensurePrivateDir, privateFileProblem, killTree,
  resolveCommand, quoteCmdArg, escapeCmdCommand, commandSpawn, openUrlArgv, isClaudeProgram, unwrapCmdShim,
  windowsChildEnv, openNoFollowSync, openNoFollow, createInputModeFilter,
} from '../../platform/index.mjs'
import * as platformModule from '../../platform/index.mjs'

const moduleFile = fileURLToPath(new URL('../../platform/index.mjs', import.meta.url))

test('the platform module imports only node: modules and exports exactly the documented names', async () => {
  const source = await readFile(moduleFile, 'utf8')
  const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1])
  assert.ok(specifiers.length > 0)
  for (const s of specifiers) assert.match(s, /^node:/, `${s} is not a node: module`)
  assert.deepEqual(Object.keys(platformModule).sort(), [
    'commandSpawn', 'createInputModeFilter', 'deckDir', 'endpoint', 'ensurePrivateDir', 'escapeCmdCommand', 'isClaudeProgram',
    'isPipe', 'killTree', 'openNoFollow', 'openNoFollowSync', 'openUrlArgv', 'privateFileProblem', 'quoteCmdArg', 'resolveCommand',
    'runtimeBase', 'unwrapCmdShim', 'windowsChildEnv',
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

test('every path is built with the injected platform flavour, never the host path module', async () => {
  // win32 normalises forward slashes to backslashes; posix leaves both kinds alone. Both hold on any host.
  assert.equal(runtimeBase({ env: { LOCALAPPDATA: 'C:/Users/you/AppData/Local' }, platform: 'win32', uid: null, home: 'C:/Users/you' }),
    'C:\\Users\\you\\AppData\\Local\\fleetmates-deck\\run')
  assert.equal(runtimeBase({ env: {}, platform: 'win32', uid: null, home: 'C:/Users/you' }), 'C:\\Users\\you\\AppData\\Local\\fleetmates-deck\\run')
  assert.equal(runtimeBase({ env: {}, platform: 'darwin', uid: 501, home: '/Users/you' }), '/Users/you/Library/Caches/fleetmates-deck')
  assert.equal(runtimeBase({ env: {}, platform: 'darwin', uid: 501, home: '/Users/you\\x' }), '/Users/you\\x/Library/Caches/fleetmates-deck')
  assert.equal(deckDir('C:/Users/you/run', { platform: 'win32' }), 'C:\\Users\\you\\run\\fleetmates-deck')
  assert.equal(deckDir('/Users/you/run', { platform: 'darwin' }), '/Users/you/run/fleetmates-deck')
  assert.equal(deckDir('/home/you\\run', { platform: 'linux' }), '/home/you\\run/fleetmates-deck')
  assert.equal(endpoint('/Users/you/run', 'hooks', { platform: 'darwin', uid: 501 }), '/Users/you/run/fleetmates-deck/hooks.sock')
  assert.equal(endpoint('C:/Users/you/run', 'deckd', { platform: 'win32', uid: null }), endpoint('C:\\Users\\you\\run', 'deckd', { platform: 'win32', uid: null }))
  assert.equal(resolveCommand('claude', { platform: 'win32', env: { PATH: 'C:/npm' }, exists: p => p === 'C:\\npm\\claude.cmd' }), 'C:\\npm\\claude.cmd')
  assert.deepEqual(unwrapCmdShim('C:/npm/claude.cmd', { readFile: () => '"%dp0%\\bin\\claude.exe" %*' }), { kind: 'exe', file: 'C:\\npm\\bin\\claude.exe' })
  assert.equal(isClaudeProgram('/usr/bin\\claude', { platform: 'linux' }), false)
  // The host flavour is the same as posix on Linux, so pin the source as well: with comments
  // stripped, no call goes through the bare `path` module.
  const code = (await readFile(moduleFile, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const bare = [...code.matchAll(/\bpath\.(?!(?:posix|win32)\b)\w+/g)].map(m => m[0])
  assert.deepEqual(bare, [], 'every path call names path.posix or path.win32')
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

// This half needs real POSIX modes and uids, so it cannot run on a Windows host.
const posixHostOnly = { skip: process.platform === 'win32' && 'needs POSIX file modes and process.getuid on the host' }

test('ensurePrivateDir creates a 0700 dir, rejects 0755 on linux and accepts it on win32', posixHostOnly, async () => {
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

test('ensurePrivateDir with platform win32 only creates the dir, and accepts an existing one, on any host', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'deck-platform-'))
  try {
    const fresh = path.join(base, 'a', 'b')
    await ensurePrivateDir(fresh, { platform: 'win32', uid: null })
    assert.ok((await stat(fresh)).isDirectory())
    await chmod(fresh, 0o755)
    await ensurePrivateDir(fresh, { platform: 'win32', uid: null })
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
  // Keys spelled as a copied Windows env spells them (`{ ...process.env }` loses the case-insensitive lookup).
  assert.equal(resolveCommand('claude', { platform: 'win32', env: { Path: dir, PathExt: '.CMD' }, exists }), path.win32.join(dir, 'claude.cmd'))
  assert.equal(resolveCommand('claude', { platform: 'win32', env: { Path: dir, PathExt: '.BAT' }, exists }), 'claude')

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

test('escapeCmdCommand caret-escapes every cmd.exe metacharacter in a command path, as cross-spawn does', () => {
  assert.equal(escapeCmdCommand('C:\\Program Files\\x\\tool.cmd'), 'C:\\Program^ Files\\x\\tool.cmd')
  assert.equal(escapeCmdCommand('()[]%!^"`<>&|;, *?'), '^(^)^[^]^%^!^^^"^`^<^>^&^|^;^,^ ^*^?')
  assert.equal(escapeCmdCommand('C:\\npm\\claude.cmd'), 'C:\\npm\\claude.cmd')
})

test('commandSpawn wraps .cmd and .bat in cmd.exe on win32 and passes everything else through', () => {
  const cmd = commandSpawn('C:\\npm\\claude.cmd', ['--resume', 'a&b'], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, readFile: noShim })
  assert.deepEqual(cmd, {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', '"C:\\npm\\claude.cmd ^"--resume^" ^"a^&b^""'],
    options: { windowsVerbatimArguments: true, windowsHide: true },
  })
  assert.equal(commandSpawn('X.BAT', [], { platform: 'win32', env: {}, readFile: noShim }).file, 'cmd.exe')
  // The command is caret-escaped, not quoted: cmd.exe would take a quoted "C:\Program as the program.
  assert.deepEqual(commandSpawn('C:\\Program Files\\x\\tool.cmd', ['pack', '--dry-run'], { platform: 'win32', env: {}, readFile: noShim }).args,
    ['/d', '/s', '/c', '"C:\\Program^ Files\\x\\tool.cmd ^"pack^" ^"--dry-run^""'])
  assert.deepEqual(commandSpawn('C:\\Program Files (x86)\\x\\tool.bat', [], { platform: 'win32', env: {}, readFile: noShim }).args,
    ['/d', '/s', '/c', '"C:\\Program^ Files^ ^(x86^)\\x\\tool.bat"'])
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

// The body npm's cmd-shim writes for a native bin, as `npm i -g @anthropic-ai/claude-code@2.1.285`
// installs it at %APPDATA%\npm\claude.cmd (CRLF line endings).
const EXE_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*', '',
].join('\r\n')

// npm's cmd-shim body for a bin run by `prog` (node, sh, python), ending in `invocation` (CRLF).
const shimBody = (prog, invocation) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  `IF EXIST "%dp0%\\${prog}.exe" (`, `  SET "_prog=%dp0%\\${prog}.exe"`, ') ELSE (', `  SET "_prog=${prog}"`, `  SET PATHEXT=%PATHEXT:;.JS;=;%`, ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ${invocation}`, '',
].join('\r\n')

test('unwrapCmdShim finds the node script or native exe an npm cmd-shim written to disk targets, and null otherwise', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'deck-shim-'))
  try {
    const file = 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd'
    const fromDisk = async body => {
      const shim = path.join(base, 'claude.cmd')
      await writeFile(shim, body)
      return p => { assert.equal(p, file); return readFileSync(shim, 'utf8') }
    }
    assert.deepEqual(unwrapCmdShim(file, { readFile: await fromDisk(CMD_SHIM) }),
      { kind: 'node', script: 'C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' })
    assert.deepEqual(unwrapCmdShim(file, { readFile: await fromDisk(EXE_SHIM) }),
      { kind: 'exe', file: 'C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe' })
    // %~dp0, upper case, .mjs, .cjs and .EXE, a parent-relative path, and node named as %dp0%\node.exe.
    assert.deepEqual(unwrapCmdShim('C:\\a\\b\\x.cmd', { readFile: () => shimBody('node', '"%_prog%" "%~DP0\\..\\lib\\X.MJS" %*') }), { kind: 'node', script: 'C:\\a\\lib\\X.MJS' })
    assert.deepEqual(unwrapCmdShim('C:\\a\\x.cmd', { readFile: () => '"%dp0%\\node.exe" "%dp0%\\bin\\x.cjs" %*' }), { kind: 'node', script: 'C:\\a\\bin\\x.cjs' })
    assert.deepEqual(unwrapCmdShim('C:\\a\\b\\x.cmd', { readFile: () => '"%~dp0\\..\\bin\\X.EXE" %*' }), { kind: 'exe', file: 'C:\\a\\bin\\X.EXE' })
    // A body with both a node invocation and a direct exe invocation is a node shim.
    assert.deepEqual(unwrapCmdShim('C:\\a\\x.cmd', { readFile: () => '"%dp0%\\tool.exe" %*\r\n' + shimBody('node', '"%_prog%" "%dp0%\\later.js" %*') }),
      { kind: 'node', script: 'C:\\a\\later.js' })
    // Shims for other interpreters name their interpreter as an exe; unwrapping would drop the script.
    assert.equal(unwrapCmdShim(file, { readFile: () => shimBody('sh', '"%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\run.sh" %*') }), null)
    assert.equal(unwrapCmdShim(file, { readFile: () => shimBody('python', '"%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\run.py" %*') }), null)
    assert.equal(unwrapCmdShim(file, { readFile: () => shimBody('sh', '"%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\run.js" %*') }), null)
    // "%_prog%" is node only when every SET "_prog=..." names node, and at least one does.
    assert.equal(unwrapCmdShim(file, { readFile: () => shimBody('node', '"%_prog%"  "%dp0%\\cli.js" %*').replace('SET "_prog=node"', 'SET "_prog=sh"') }), null)
    assert.equal(unwrapCmdShim(file, { readFile: () => '"%_prog%"  "%dp0%\\cli.js" %*' }), null)
    // A node shim with interpreter flags, or anything else on the invocation line, is not unwrapped.
    assert.equal(unwrapCmdShim(file, { readFile: () => shimBody('node', '"%_prog%" --max-old-space-size=4096 "%dp0%\\node_modules\\pkg\\cli.js" %*') }), null)
    assert.equal(unwrapCmdShim(file, { readFile: () => shimBody('node', '"%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" --extra %*') }), null)
    assert.equal(unwrapCmdShim(file, { readFile: () => shimBody('node', '"%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js"') }), null)
    assert.equal(unwrapCmdShim('C:\\a\\x.cmd', { readFile: () => '"%dp0%\\tool.exe" --flag %*' }), null)
    assert.equal(unwrapCmdShim('C:\\a\\x.cmd', { readFile: () => '"%dp0%\\tool.exe" %* & echo more' }), null)
    assert.equal(unwrapCmdShim('C:\\a\\x.cmd', { readFile: () => 'IF EXIST "%dp0%\\tool.exe" %*' }), null)
    // Not a shim: a target outside %dp0%, an unquoted target, or an unreadable file.
    assert.equal(unwrapCmdShim('C:\\a\\x.cmd', { readFile: () => 'C:\\tools\\real.exe %*' }), null)
    assert.equal(unwrapCmdShim('C:\\a\\x.cmd', { readFile: () => '%dp0%\\real.exe %*' }), null)
    assert.equal(unwrapCmdShim('C:\\a\\x.cmd', { readFile: () => '"%dp0%\\run.bat" %*' }), null)
    assert.equal(unwrapCmdShim('C:\\a\\x.cmd', { readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } }), null)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('commandSpawn runs an npm cmd-shim .cmd through node or its native exe directly, with no cmd.exe', () => {
  const file = 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd'
  const js = 'C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
  const exe = 'C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  const args = ['x"&echo INJECTED>%TEMP%\\pwn.txt&"y', 'a\nb', '{"k":"v w"}']
  assert.deepEqual(commandSpawn(file, args, { platform: 'win32', env: {}, readFile: () => CMD_SHIM, nodePath: 'C:\\node\\node.exe' }),
    { file: 'C:\\node\\node.exe', args: [js, ...args], options: { windowsHide: true } })
  assert.equal(commandSpawn(file, [], { platform: 'win32', env: {}, readFile: () => CMD_SHIM }).file, process.execPath)
  assert.deepEqual(commandSpawn(file, args, { platform: 'win32', env: {}, readFile: () => EXE_SHIM, nodePath: 'C:\\node\\node.exe' }),
    { file: exe, args, options: { windowsHide: true } })
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

test('windowsChildEnv returns the same env object on POSIX', () => {
  const env = { Path: 'a', PATH: 'b' }
  for (const platform of ['linux', 'darwin']) assert.equal(windowsChildEnv(env, { base: { SystemRoot: 'C:\\Windows' }, platform }), env)
})

test('windowsChildEnv on win32 keeps one key per case-insensitive name, env winning over base', () => {
  const env = { Path: 'C:\\old', FOO: '1', PATH: 'C:\\fake-bin;C:\\old', SystemRoot: 'D:\\Win' }
  const base = { PATH: 'C:\\base', SYSTEMROOT: 'C:\\Windows', SystemDrive: 'C:', Other: 'not copied' }
  const out = windowsChildEnv(env, { base, platform: 'win32' })
  assert.notEqual(out, env)
  assert.deepEqual(Object.keys(out).filter(k => /^path$/i.test(k)), ['PATH'])
  assert.equal(out.PATH, 'C:\\fake-bin;C:\\old')
  // A present SystemRoot is kept, a missing SystemDrive is filled from base, other base keys are not copied.
  assert.deepEqual(Object.keys(out).filter(k => /^systemroot$/i.test(k)), ['SystemRoot'])
  assert.equal(out.SystemRoot, 'D:\\Win')
  assert.equal(out.SystemDrive, 'C:')
  assert.equal(out.Other, undefined)
  assert.equal(out.FOO, '1')
  // env is not modified.
  assert.deepEqual(Object.keys(env), ['Path', 'FOO', 'PATH', 'SystemRoot'])
})

test('windowsChildEnv on win32 fills every Windows base variable from base, case-insensitively, when env has none', () => {
  const names = ['SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
    'USERDOMAIN', 'LOGONSERVER', 'ComSpec', 'PATHEXT']
  const base = Object.fromEntries(names.map(n => [n.toLowerCase(), `v-${n}`]))
  const out = windowsChildEnv({ PATH: 'C:\\bin' }, { base, platform: 'win32' })
  for (const n of names) assert.equal(out[n], `v-${n}`, n)
  assert.deepEqual(Object.keys(out).sort(), ['PATH', ...names].sort())
  assert.equal(windowsChildEnv({}, { base: { SystemRoot: 'C:\\Windows' }, platform: 'win32' }).SystemRoot, 'C:\\Windows')
  // Nothing in base leaves the key absent rather than undefined.
  assert.deepEqual(windowsChildEnv({ A: 'x' }, { base: {}, platform: 'win32' }), { A: 'x' })
})

/**
 * A temp dir holding a regular file `real` and a symlink `link` to it. `symlinkOk` is false when the
 * host refuses to create a symlink (a Windows account without the privilege).
 */
async function linkFixture () {
  const dir = await mkdtemp(path.join(tmpdir(), 'deck-nofollow-'))
  const real = path.join(dir, 'real')
  const link = path.join(dir, 'link')
  await writeFile(real, 'secret')
  let symlinkOk = true
  try {
    await symlink(real, link)
  } catch (err) {
    if (err.code !== 'EPERM') throw err
    symlinkOk = false
  }
  return { dir, real, link, symlinkOk, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5 }) }
}

/** A copy of a Stats object with some fields overridden. */
const restat = (st, over) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, over)

/** An fs whose lstat calls see every file as a symbolic link; everything else is the real fs. */
function lyingLstatFs () {
  return {
    ...fs,
    lstatSync: (p, o) => restat(fs.lstatSync(p, o), { isSymbolicLink: () => true }),
    promises: { ...fs.promises, lstat: async (p, o) => restat(await fs.promises.lstat(p, o), { isSymbolicLink: () => true }) },
  }
}

/** An fs whose fstat reports another inode than lstat, as when the name was swapped between the two. */
function swappedInodeFs (/** @type {string[]} */ closed = []) {
  const bump = st => restat(st, { ino: st.ino + 1n })
  return {
    ...fs,
    fstatSync: (fd, o) => bump(fs.fstatSync(fd, o)),
    closeSync: fd => { closed.push('sync'); fs.closeSync(fd) },
    promises: {
      ...fs.promises,
      open: async (...a) => {
        const h = await fs.promises.open(...a)
        const realStat = h.stat.bind(h)
        const realClose = h.close.bind(h)
        h.stat = async o => bump(await realStat(o))
        h.close = async () => { closed.push('handle'); return realClose() }
        return h
      },
    },
  }
}

test('openNoFollowSync and openNoFollow open a regular file on the host platform', async () => {
  const fx = await linkFixture()
  try {
    const fd = openNoFollowSync(fx.real)
    try {
      assert.equal(fs.readFileSync(fd, 'utf8'), 'secret')
    } finally {
      fs.closeSync(fd)
    }
    const h = await openNoFollow(fx.real, fs.constants.O_RDONLY)
    try {
      assert.equal(await h.readFile('utf8'), 'secret')
    } finally {
      await h.close()
    }
  } finally {
    await fx.cleanup()
  }
})

test('openNoFollowSync and openNoFollow refuse a real symlink with ELOOP on the host platform', async t => {
  const fx = await linkFixture()
  try {
    if (!fx.symlinkOk) return t.skip('this account cannot create symlinks')
    assert.throws(() => openNoFollowSync(fx.link), { code: 'ELOOP' })
    await assert.rejects(openNoFollow(fx.link, fs.constants.O_RDONLY), { code: 'ELOOP' })
  } finally {
    await fx.cleanup()
  }
})

test('openNoFollowSync and openNoFollow on win32 refuse a real symlink through lstat', async t => {
  const fx = await linkFixture()
  try {
    if (!fx.symlinkOk) return t.skip('this account cannot create symlinks')
    assert.throws(() => openNoFollowSync(fx.link, fs.constants.O_RDONLY, { platform: 'win32' }), { code: 'ELOOP' })
    await assert.rejects(openNoFollow(fx.link, fs.constants.O_RDONLY, { platform: 'win32' }), { code: 'ELOOP' })
  } finally {
    await fx.cleanup()
  }
})

test('openNoFollowSync and openNoFollow on win32 refuse when lstat reports a symbolic link', async () => {
  const fx = await linkFixture()
  try {
    const injected = lyingLstatFs()
    assert.throws(() => openNoFollowSync(fx.real, fs.constants.O_RDONLY, { platform: 'win32', fs: injected }), { code: 'ELOOP' })
    await assert.rejects(openNoFollow(fx.real, fs.constants.O_RDONLY, { platform: 'win32', fs: injected }), { code: 'ELOOP' })
    // The same file through the real fs opens.
    fs.closeSync(openNoFollowSync(fx.real, fs.constants.O_RDONLY, { platform: 'win32' }))
    await (await openNoFollow(fx.real, fs.constants.O_RDONLY, { platform: 'win32' })).close()
  } finally {
    await fx.cleanup()
  }
})

test('openNoFollowSync and openNoFollow on win32 refuse and close when the opened file is not the one lstat saw', async () => {
  const fx = await linkFixture()
  try {
    /** @type {string[]} */
    const closed = []
    const injected = swappedInodeFs(closed)
    assert.throws(() => openNoFollowSync(fx.real, fs.constants.O_RDONLY, { platform: 'win32', fs: injected }), { code: 'ELOOP' })
    assert.deepEqual(closed, ['sync'], 'the fd opened before the check is closed')
    await assert.rejects(openNoFollow(fx.real, fs.constants.O_RDONLY, { platform: 'win32', fs: injected }), { code: 'ELOOP' })
    assert.deepEqual(closed, ['sync', 'handle'], 'the handle opened before the check is closed')
  } finally {
    await fx.cleanup()
  }
})

test('openNoFollowSync and openNoFollow on win32 create a missing file under O_CREAT and truncate only after the check', async () => {
  const fx = await linkFixture()
  try {
    const { O_WRONLY, O_CREAT, O_TRUNC } = fs.constants
    const fresh = path.join(fx.dir, 'fresh')
    fs.closeSync(openNoFollowSync(fresh, O_WRONLY | O_CREAT | O_TRUNC, { platform: 'win32', mode: 0o600 }))
    assert.equal(fs.readFileSync(fresh, 'utf8'), '')
    fs.closeSync(openNoFollowSync(fx.real, O_WRONLY | O_CREAT | O_TRUNC, { platform: 'win32' }))
    assert.equal(fs.readFileSync(fx.real, 'utf8'), '', 'O_TRUNC is honoured')
    await writeFile(fx.real, 'secret')
    // A refused open under O_TRUNC leaves the file it opened untouched.
    assert.throws(() => openNoFollowSync(fx.real, O_WRONLY | O_TRUNC, { platform: 'win32', fs: swappedInodeFs() }), { code: 'ELOOP' })
    await assert.rejects(openNoFollow(fx.real, O_WRONLY | O_TRUNC, { platform: 'win32', fs: swappedInodeFs() }), { code: 'ELOOP' })
    assert.equal(fs.readFileSync(fx.real, 'utf8'), 'secret')
    const fresh2 = path.join(fx.dir, 'fresh2')
    await (await openNoFollow(fresh2, O_WRONLY | O_CREAT | O_TRUNC, { platform: 'win32' })).close()
    assert.equal(fs.readFileSync(fresh2, 'utf8'), '')
    await (await openNoFollow(fx.real, O_WRONLY | O_TRUNC, { platform: 'win32' })).close()
    assert.equal(fs.readFileSync(fx.real, 'utf8'), '', 'O_TRUNC is honoured by openNoFollow')
  } finally {
    await fx.cleanup()
  }
})

test('openNoFollowSync and openNoFollow rethrow ENOENT without O_CREAT on win32', async () => {
  const missing = path.join(tmpdir(), `deck-nofollow-missing-${process.pid}`)
  assert.throws(() => openNoFollowSync(missing, fs.constants.O_RDONLY, { platform: 'win32' }), { code: 'ENOENT' })
  await assert.rejects(openNoFollow(missing, fs.constants.O_RDONLY, { platform: 'win32' }), { code: 'ENOENT' })
})

/**
 * The real fs, except that the first lstat (sync or promise) runs `race` right after the real lstat
 * and before its result or error is returned: the name changes between lstat and open.
 * @param {(p: string) => void} race
 */
function racingFs (race) {
  let raced = false
  const once = p => { if (!raced) { raced = true; race(p) } }
  return {
    ...fs,
    lstatSync: (p, o) => { try { return fs.lstatSync(p, o) } finally { once(p) } },
    promises: { ...fs.promises, lstat: async (p, o) => { try { return await fs.promises.lstat(p, o) } finally { once(p) } } },
  }
}

const OPEN_FNS = [
  ['openNoFollowSync', async (file, flags, opts) => fs.closeSync(openNoFollowSync(file, flags, opts))],
  ['openNoFollow', async (file, flags, opts) => (await openNoFollow(file, flags, opts)).close()],
]

test('a symlink planted on win32 between an lstat that found nothing and the open is refused, and its target is not created', async t => {
  const fx = await linkFixture()
  try {
    if (!fx.symlinkOk) return t.skip('this account cannot create symlinks')
    const { O_WRONLY, O_CREAT, O_TRUNC } = fs.constants
    for (const [name, open] of OPEN_FNS) {
      const file = path.join(fx.dir, `out-${name}`)
      const victim = path.join(fx.dir, `victim-${name}`)
      const injected = racingFs(p => fs.symlinkSync(victim, p))
      await assert.rejects(open(file, O_WRONLY | O_CREAT | O_TRUNC, { platform: 'win32', fs: injected }), { code: 'ELOOP' }, name)
      assert.equal(fs.existsSync(victim), false, `${name}: the symlink target is not created`)
    }
  } finally {
    await fx.cleanup()
  }
})

test('a regular file swapped on win32 for a dangling symlink between lstat and open is refused, and its target is not created', async t => {
  const fx = await linkFixture()
  try {
    if (!fx.symlinkOk) return t.skip('this account cannot create symlinks')
    const { O_WRONLY, O_CREAT, O_TRUNC } = fs.constants
    for (const [name, open] of OPEN_FNS) {
      const file = path.join(fx.dir, `out-${name}`)
      const victim = path.join(fx.dir, `victim-${name}`)
      fs.writeFileSync(file, 'old')
      const injected = racingFs(p => { fs.unlinkSync(p); fs.symlinkSync(victim, p) })
      await assert.rejects(open(file, O_WRONLY | O_CREAT | O_TRUNC, { platform: 'win32', fs: injected }), { code: 'ELOOP' }, name)
      assert.equal(fs.existsSync(victim), false, `${name}: the symlink target is not created`)
    }
  } finally {
    await fx.cleanup()
  }
})

test('a name created on win32 between an lstat that found nothing and the open is opened under O_CREAT, and refused under O_EXCL', async () => {
  const fx = await linkFixture()
  try {
    const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants
    for (const [name, open] of OPEN_FNS) {
      const file = path.join(fx.dir, `new-${name}`)
      await open(file, O_WRONLY | O_CREAT, { platform: 'win32', fs: racingFs(p => fs.writeFileSync(p, 'other')) })
      assert.equal(fs.readFileSync(file, 'utf8'), 'other', name)
      const excl = path.join(fx.dir, `excl-${name}`)
      await assert.rejects(open(excl, O_WRONLY | O_CREAT | O_EXCL, { platform: 'win32', fs: racingFs(p => fs.writeFileSync(p, 'other')) }),
        { code: 'EEXIST' }, name)
      // The caller's O_EXCL on a name lstat finds is EEXIST too, as on POSIX.
      await assert.rejects(open(fx.real, O_WRONLY | O_CREAT | O_EXCL, { platform: 'win32' }), { code: 'EEXIST' }, name)
      assert.equal(fs.readFileSync(fx.real, 'utf8'), 'secret')
    }
  } finally {
    await fx.cleanup()
  }
})

test('a win32 no-follow open gives up after 3 attempts when the name keeps changing, with the last error', async () => {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const eexist = () => Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
  let opens = 0
  const flaky = {
    ...fs,
    lstatSync: () => { throw enoent() },
    openSync: () => { opens++; throw eexist() },
    promises: { ...fs.promises, lstat: async () => { throw enoent() }, open: async () => { opens++; throw eexist() } },
  }
  const { O_WRONLY, O_CREAT } = fs.constants
  assert.throws(() => openNoFollowSync('C:\\x\\flaky', O_WRONLY | O_CREAT, { platform: 'win32', fs: flaky }), { code: 'EEXIST' })
  assert.equal(opens, 3)
  await assert.rejects(openNoFollow('C:\\x\\flaky', O_WRONLY | O_CREAT, { platform: 'win32', fs: flaky }), { code: 'EEXIST' })
  assert.equal(opens, 6)
  // The caller's own O_EXCL makes EEXIST the answer: no retry.
  assert.throws(() => openNoFollowSync('C:\\x\\flaky', O_WRONLY | O_CREAT | fs.constants.O_EXCL, { platform: 'win32', fs: flaky }), { code: 'EEXIST' })
  assert.equal(opens, 7)
  await assert.rejects(openNoFollow('C:\\x\\flaky', O_WRONLY | O_CREAT | fs.constants.O_EXCL, { platform: 'win32', fs: flaky }), { code: 'EEXIST' })
  assert.equal(opens, 8)
})

const MODE_ON = '\x1b[?9001h'
const MODE_OFF = '\x1b[?9001l'

test('createInputModeFilter on win32 removes ESC[?9001h and ESC[?9001l', () => {
  const filter = createInputModeFilter({ platform: 'win32' })
  assert.equal(filter(`${MODE_ON}a${MODE_OFF}b${MODE_ON}${MODE_ON}c`), 'abc')
  assert.equal(filter('plain'), 'plain')
  // Removing the inner sequence joins its neighbours into another one, which goes too.
  assert.equal(filter('a\x1b[?9001\x1b[?9001hhb'), 'ab')
})

test('createInputModeFilter on win32 removes a sequence split at every offset across two chunks', () => {
  for (const seq of [MODE_ON, MODE_OFF]) {
    for (let i = 0; i <= seq.length; i++) {
      const filter = createInputModeFilter({ platform: 'win32' })
      const first = filter('x' + seq.slice(0, i))
      assert.equal(first, 'x', `offset ${i}: the incomplete prefix is held back`)
      assert.equal(first + filter(seq.slice(i) + 'y'), 'xy', `offset ${i}`)
    }
  }
})

test('createInputModeFilter on win32 leaves ESC[?900h and other CSI alone, also when split', () => {
  for (const other of ['\x1b[?900h', '\x1b[?2004h', '\x1b[?9002h', '\x1b[?90011h', '\x1b[31m', '\x1b[?9001x', '\x1b\x1b[?9001']) {
    assert.equal(createInputModeFilter({ platform: 'win32' })(other + 'z'), other + 'z')
    for (let i = 0; i <= other.length; i++) {
      const filter = createInputModeFilter({ platform: 'win32' })
      assert.equal(filter(other.slice(0, i)) + filter(other.slice(i) + 'z'), other + 'z', `${JSON.stringify(other)} at ${i}`)
    }
  }
})

test('createInputModeFilter on POSIX returns every chunk unchanged', () => {
  for (const platform of ['linux', 'darwin']) {
    const filter = createInputModeFilter({ platform })
    assert.equal(filter(`a${MODE_ON}b`), `a${MODE_ON}b`)
    assert.equal(filter('\x1b[?90'), '\x1b[?90')
  }
})
