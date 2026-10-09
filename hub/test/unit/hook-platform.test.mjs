// The hook and its settings entry on linux, darwin and win32 (docs/deck/16-platforms.md). The hook is
// copied alone by init, so it carries its own copy of the endpoint rule; these tests pin it to the
// platform module's, and pin the win32 form of the hook command in Claude Code settings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endpoint, runtimeBase } from '../../platform/index.mjs'
import { ancestry, endpointDirProblem, hookEndpoint, makeEnvelope, spoolDir } from '../../hook/deck-hook.mjs'
import { validateEnvelope } from '../../server/ingest/validate.mjs'
import { deckHookCommand, hooksInstalled, HOOK_EVENTS, isDeckHook, transformHooks } from '../../server/setup/hooks.mjs'

const parityCases = [
  ['linux, XDG set', 'linux', { XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/you' }],
  ['linux, XDG unset', 'linux', { HOME: '/home/you' }],
  ['linux, XDG empty', 'linux', { XDG_RUNTIME_DIR: '', HOME: '/home/you' }],
  ['linux, a base too long for a socket path', 'linux', { XDG_RUNTIME_DIR: '/run/user/1000/' + 'x'.repeat(120), HOME: '/home/you' }],
  ['darwin, XDG unset', 'darwin', { HOME: '/Users/you' }],
  ['darwin, XDG set', 'darwin', { XDG_RUNTIME_DIR: '/Users/you/rt', HOME: '/Users/you' }],
  ['win32, LOCALAPPDATA', 'win32', { LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local', HOME: 'C:\\Users\\you' }],
  ['win32, HOME only', 'win32', { HOME: 'C:\\Users\\You' }],
  ['win32, XDG set', 'win32', { XDG_RUNTIME_DIR: 'D:\\Run\\Deck', HOME: 'C:\\Users\\you' }],
]

for (const [name, platform, env] of parityCases) {
  test(`hookEndpoint matches the platform module's hooks endpoint: ${name}`, () => {
    assert.equal(hookEndpoint(env, platform), endpoint(runtimeBase({ env, platform }), 'hooks', { platform }))
  })
}

test('hookEndpoint on win32 is a named pipe that ignores the case of the base', () => {
  const upper = hookEndpoint({ LOCALAPPDATA: 'C:\\USERS\\YOU\\APPDATA\\LOCAL' }, 'win32')
  const lower = hookEndpoint({ LOCALAPPDATA: 'c:\\users\\you\\appdata\\local' }, 'win32')
  assert.match(upper, /^\\\\\.\\pipe\\fleetmates-deck-[0-9a-f]{16}-hooks$/)
  assert.equal(upper, lower)
})

test('ancestry on win32 reports no claude pid and reads neither /proc nor ps', () => {
  const calls = []
  const readFile = (...args) => { calls.push(['readFile', ...args]); throw new Error('no /proc') }
  const execFile = (...args) => { calls.push(['execFile', ...args]); throw new Error('no ps') }
  assert.deepEqual(ancestry({ platform: 'win32', readFile, execFile }), { pidChain: [process.pid], claudePid: null })
  assert.deepEqual(calls, [])
  // The same injected functions are used off win32, so the empty call list above is the win32 branch.
  ancestry({ platform: 'linux', readFile, execFile })
  assert.ok(calls.length > 0, 'linux reads /proc or runs ps')
})

test('a win32 envelope validates with a null claudePid', () => {
  const hook = { session_id: 's', transcript_path: 'C:\\Users\\you\\t.jsonl', cwd: 'C:\\Users\\you\\dev\\x', hook_event_name: 'Stop', stop_hook_active: false }
  const envelope = makeEnvelope(hook, { hookTs: 1, ptyId: null, platform: 'win32' })
  assert.equal(envelope.claudePid, null)
  assert.deepEqual(envelope.pidChain, [process.pid])
  assert.equal(validateEnvelope(JSON.stringify(envelope)).ok, true)
})

// The expected values are setupPaths(env, { platform }).spool from hub/server/setup/paths.mjs as
// task T6 defines it, written out literally because that module is not on this branch.
const spoolCases = [
  ['linux, XDG_STATE_HOME unset', 'linux', { HOME: '/home/you' }, '/home/you/.local/state/fleetmates/deck/spool'],
  ['linux, XDG_STATE_HOME set', 'linux', { HOME: '/home/you', XDG_STATE_HOME: '/home/you/st' }, '/home/you/st/fleetmates/deck/spool'],
  ['darwin, XDG_STATE_HOME unset', 'darwin', { HOME: '/Users/you' }, '/Users/you/.local/state/fleetmates/deck/spool'],
  ['win32, LOCALAPPDATA', 'win32', { HOME: 'C:\\Users\\you', LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local' }, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\state\\spool'],
  ['win32, USERPROFILE only', 'win32', { USERPROFILE: 'C:\\Users\\you' }, 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\state\\spool'],
  ['win32, XDG_STATE_HOME set', 'win32', { LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local', XDG_STATE_HOME: 'D:\\state' }, 'D:\\state\\fleetmates\\deck\\spool'],
]

for (const [name, platform, env, expected] of spoolCases) {
  test(`spoolDir is where setupPaths puts the spool: ${name}`, () => {
    assert.equal(spoolDir(env, platform), expected)
  })
}

const winNode = 'C:\\Program Files\\nodejs\\node.exe'
const winHook = 'C:\\Users\\you\\AppData\\Local\\fleetmates\\deck\\share\\hook\\deck-hook.mjs'

test('deckHookCommand keeps the single-quoted form on linux and darwin', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.equal(deckHookCommand('/usr/bin/node', "/home/you/it's/fleetmates-deck/hook/deck-hook.mjs", { platform }),
      "'/usr/bin/node' '/home/you/it'\\''s/fleetmates-deck/hook/deck-hook.mjs'")
  }
  assert.equal(deckHookCommand('/usr/bin/node', '/home/you/hub/hook/deck-hook.mjs'),
    deckHookCommand('/usr/bin/node', '/home/you/hub/hook/deck-hook.mjs', { platform: process.platform }), 'the platform defaults to the host')
})

test('deckHookCommand on win32 double-quotes forward-slash paths', () => {
  assert.equal(deckHookCommand(winNode, winHook, { platform: 'win32' }),
    '"C:/Program Files/nodejs/node.exe" "C:/Users/you/AppData/Local/fleetmates/deck/share/hook/deck-hook.mjs"')
})

test('deckHookCommand on win32 refuses a path holding a double quote, %, backtick or $', () => {
  for (const bad of ['"', '%', '`', '$']) {
    assert.throws(() => deckHookCommand(`C:\\no${bad}de\\node.exe`, winHook, { platform: 'win32' }), /cannot/, `node path with ${bad}`)
    assert.throws(() => deckHookCommand(winNode, `C:\\Users\\you${bad}\\hub\\hook\\deck-hook.mjs`, { platform: 'win32' }), /cannot/, `hook path with ${bad}`)
  }
})

test('isDeckHook recognises a win32 hook entry, with either separator', () => {
  const command = deckHookCommand(winNode, winHook, { platform: 'win32' })
  assert.equal(isDeckHook(command), true, 'the forward-slash form init writes')
  assert.equal(isDeckHook("'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\you\\dev\\hub\\hook\\deck-hook.mjs'"), true, 'backslash separators')
  assert.equal(isDeckHook('"C:/Program Files/nodejs/node.exe" "C:/Users/you/dev/fleetmates-deck/hook/deck-hook.mjs"'), true)
  assert.equal(isDeckHook('"C:/Program Files/nodejs/node.exe" "C:/Users/you/dev/other/hook/deck-hook.mjs"'), false, 'another script')
  assert.equal(isDeckHook('"C:/tools/python.exe" "C:/Users/you/dev/hub/hook/deck-hook.mjs"'), false, 'another interpreter')
  assert.equal(isDeckHook('"node.exe" "hub/hook/deck-hook.mjs"'), false, 'a relative script')
})

test('a second transformHooks run with the win32 command adds nothing, and remove takes it out', () => {
  const command = deckHookCommand(winNode, winHook, { platform: 'win32' })
  const once = transformHooks({}, command)
  assert.equal(hooksInstalled(once, command), true)
  assert.deepEqual(transformHooks(once, command), once)
  for (const event of HOOK_EVENTS) assert.equal(once.hooks[event].length, 1, event)
  assert.deepEqual(transformHooks(once, command, true), {})
})

/**
 * A stand-in for an lstat result.
 * @param {{ dir?: boolean, uid?: number, mode?: number }} [opts]
 */
const fakeStat = ({ dir = true, uid = 1000, mode = 0o40700 } = {}) => ({ isDirectory: () => dir, uid, mode })

/**
 * An lstat that answers from `stats` by path and records each path it was asked for.
 * @param {Record<string, ReturnType<typeof fakeStat> | undefined>} stats
 */
function fakeLstat (stats) {
  const asked = []
  const lstat = (p) => {
    asked.push(p)
    if (!stats[p]) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return stats[p]
  }
  return { lstat, asked }
}

test('endpointDirProblem accepts a private deck dir and base, checking both', () => {
  const { lstat, asked } = fakeLstat({ '/run/user/1000/fleetmates-deck': fakeStat(), '/run/user/1000': fakeStat() })
  assert.equal(endpointDirProblem('/run/user/1000/fleetmates-deck/hooks.sock', { platform: 'linux', uid: 1000, lstat }), null)
  assert.deepEqual(asked, ['/run/user/1000/fleetmates-deck', '/run/user/1000'])
})

test('endpointDirProblem refuses a squatted runtime dir: another owner, group or world bits, a symlink, or missing', () => {
  const sock = '/tmp/fleetmates-deck-1000/fleetmates-deck/deckd.sock'
  const deck = '/tmp/fleetmates-deck-1000/fleetmates-deck'
  const base = '/tmp/fleetmates-deck-1000'
  const cases = [
    ['base owned by another uid', { [deck]: fakeStat(), [base]: fakeStat({ uid: 1001 }) }, /owned by uid 1001/],
    ['deck dir owned by another uid', { [deck]: fakeStat({ uid: 0 }), [base]: fakeStat() }, /owned by uid 0/],
    ['a 0777 base', { [deck]: fakeStat(), [base]: fakeStat({ mode: 0o40777 }) }, /mode 0777/],
    ['a group-readable deck dir', { [deck]: fakeStat({ mode: 0o40750 }), [base]: fakeStat() }, /mode 0750/],
    ['a symlinked deck dir', { [deck]: fakeStat({ dir: false, mode: 0o120777 }), [base]: fakeStat() }, /not a directory/],
    ['a missing deck dir', { [base]: fakeStat() }, /ENOENT/],
  ]
  for (const [name, stats, reason] of cases) {
    const { lstat } = fakeLstat(stats)
    assert.match(endpointDirProblem(sock, { platform: 'linux', uid: 1000, lstat }) ?? 'null', reason, name)
    assert.match(endpointDirProblem(sock, { platform: 'darwin', uid: 1000, lstat }) ?? 'null', reason, `${name} on darwin`)
  }
})

test('endpointDirProblem checks only the fallback dir for a too-long socket path, and nothing on win32', () => {
  const { lstat, asked } = fakeLstat({ '/tmp/fleetmates-deck-1000': fakeStat() })
  assert.equal(endpointDirProblem('/tmp/fleetmates-deck-1000/hooks.sock', { platform: 'linux', uid: 1000, lstat }), null)
  assert.deepEqual(asked, ['/tmp/fleetmates-deck-1000'], 'not /tmp itself')
  const win = fakeLstat({})
  assert.equal(endpointDirProblem('\\\\.\\pipe\\fleetmates-deck-0123456789abcdef-hooks', { platform: 'win32', uid: null, lstat: win.lstat }), null)
  assert.deepEqual(win.asked, [])
})
