// Setup fixes from the M1 dogfood install: init waits for the deckd socket before its checks,
// a newer Claude Code is a warning rather than a failure, and `open` launches the default web
// browser instead of whatever handles text/html. Every wait, clock and spawn is injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctor } from '../../server/setup/doctor.mjs'
import { initChecks, waitForSocket } from '../../server/setup/wait.mjs'
import { openInBrowser } from '../../server/setup/browser.mjs'
import { HOOK_EVENTS, deckHookCommand, hooksInstalled, transformHooks } from '../../server/setup/hooks.mjs'
import { spawnSync } from 'node:child_process'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const tested = JSON.parse(readFileSync(path.join(hub, 'package.json'), 'utf8')).fleetmatesDeck.testedClaudeCode

/** A virtual clock: `sleep` advances it instead of waiting. */
function clock() {
  let t = 1000
  const slept = []
  return { now: () => t, sleep: async ms => { slept.push(ms); t += ms }, slept }
}

test('waitForSocket polls until the socket accepts, on an injected clock', async () => {
  const c = clock()
  const attempts = []
  const ok = await waitForSocket('/run/deckd.sock', { now: c.now, sleep: c.sleep, connect: async file => { attempts.push(file); return attempts.length === 4 } })
  assert.equal(ok, true)
  assert.deepEqual(attempts, Array(4).fill('/run/deckd.sock'))
  assert.deepEqual(c.slept, [100, 100, 100])
})

test('waitForSocket gives up after 3 seconds of virtual time', async () => {
  const c = clock()
  let attempts = 0
  const ok = await waitForSocket('/run/deckd.sock', { now: c.now, sleep: c.sleep, connect: async () => { attempts++; return false } })
  assert.equal(ok, false)
  assert.equal(c.slept.reduce((a, b) => a + b, 0), 3000)
  assert.equal(attempts, 31)
})

test('initChecks waits for an active deckd socket before running the checks', async () => {
  const paths = { runtime: '/run/user/1000/fleetmates-deck' }
  const order = []
  const checks = [{ id: 'deckd', state: 'ok' }]
  const result = await initChecks(paths, 'cmd', {
    run: (file, argv) => { order.push(`${file} ${argv.join(' ')}`); return { status: 0 } },
    wait: async file => { order.push(`wait ${file}`); await new Promise(resolve => setImmediate(resolve)); order.push('waited'); return true },
    check: async (p, command) => { order.push(`doctor ${command}`); return checks }
  })
  assert.equal(result, checks)
  assert.deepEqual(order, ['systemctl --user is-active fleetmates-deckd.service', 'wait /run/user/1000/fleetmates-deck/deckd.sock', 'waited', 'doctor cmd'])
})

test('initChecks does not wait when deckd is not active or there is no runtime dir', async () => {
  for (const [paths, status] of [[{ runtime: '/run/x' }, 3], [{ runtime: null }, 0]]) {
    const order = []
    await initChecks(paths, 'cmd', {
      run: () => ({ status }),
      wait: async () => { order.push('wait'); return true },
      check: async () => { order.push('doctor'); return [] }
    })
    assert.deepEqual(order, ['doctor'])
  }
})

test('doctor reports a newer Claude Code as a non-blocking warning and keeps missing or older as failed', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deck-cc-'))
  try {
    const paths = { settings: path.join(dir, 'settings.json'), hook: path.join(dir, 'hook.mjs'), runtime: null }
    const claudeFor = async reply => (await doctor(paths, 'cmd', { run: file => file === 'claude' ? reply : { status: 3, stdout: '' } })).find(row => row.id === 'claude')
    const [major, minor, patch] = tested.split('.').map(Number)
    const newer = await claudeFor({ status: 0, stdout: `${major}.${minor}.${patch + 3} (Claude Code)\n` })
    assert.deepEqual(newer, { id: 'claude', state: 'warn', blocking: false, detail: `Claude Code ${major}.${minor}.${patch + 3} is newer than this deck was tested with (${tested})` })
    const newerMinor = await claudeFor({ status: 0, stdout: `${major}.${minor}.${patch + 1000} (Claude Code)\n` })
    assert.equal(newerMinor.state, 'warn', 'versions compare numerically, not as strings')
    assert.equal((await claudeFor({ status: 0, stdout: `${tested} (Claude Code)\n` })).state, 'ok')
    const older = await claudeFor({ status: 0, stdout: `${major}.${minor}.${patch - 1} (Claude Code)\n` })
    assert.equal(older.state, 'failed')
    assert.equal(older.detail, `Claude Code ${major}.${minor}.${patch - 1}; tested ${tested}`)
    const missing = await claudeFor({ status: 127, stdout: '' })
    assert.equal(missing.state, 'failed')
    assert.equal(missing.blocking, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/** A recording spawner: `results` maps a program name to its success, or to a list consumed per call. */
function spawner(results, stdout = {}) {
  const calls = []
  return {
    calls,
    query: async (file, argv, env) => { calls.push({ kind: 'query', file, argv, env }); return stdout[file] ?? { status: 1, stdout: '' } },
    start: async (file, argv, env) => { calls.push({ kind: 'start', file, argv, env }); return results[file] ?? false }
  }
}

test('open honours $BROWSER first, with %s substitution, and passes only the file path', async () => {
  const file = '/home/you/.local/state/fleetmates/deck/open.html'
  const s = spawner({ firefox: true })
  assert.equal(await openInBrowser(file, { env: { BROWSER: 'firefox --new-window' }, ...s }), true)
  assert.deepEqual(s.calls.map(call => [call.file, call.argv]), [['firefox', ['--new-window', file]]])
  const t = spawner({ chromium: true })
  assert.equal(await openInBrowser(file, { env: { BROWSER: 'nobrowser:chromium --app=%s' }, ...t }), true)
  assert.deepEqual(t.calls.map(call => [call.file, call.argv]), [['nobrowser', [file]], ['chromium', [`--app=${file}`]]])
})

test('open launches the default web browser entry before falling back to xdg-open', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'deck-browser-'))
  try {
    const apps = path.join(root, 'share/applications')
    mkdirSync(apps, { recursive: true })
    writeFileSync(path.join(apps, 'chromium.desktop'), '[Desktop Entry]\n')
    const file = path.join(root, 'open.html')
    const env = { BROWSER: '', XDG_DATA_HOME: path.join(root, 'share'), XDG_DATA_DIRS: path.join(root, 'none') }
    const answer = { 'xdg-settings': { status: 0, stdout: 'chromium.desktop\n' } }

    const viaGtk = spawner({ 'gtk-launch': true }, answer)
    assert.equal(await openInBrowser(file, { env, ...viaGtk }), true)
    assert.deepEqual(viaGtk.calls.map(call => [call.kind, call.file, call.argv]), [
      ['query', 'xdg-settings', ['get', 'default-web-browser']],
      ['start', 'gtk-launch', ['chromium.desktop', file]]
    ])
    assert.equal('BROWSER' in viaGtk.calls[0].env, false, 'xdg-settings answers from $BROWSER unless it is unset')

    const viaGio = spawner({ gio: true }, answer)
    assert.equal(await openInBrowser(file, { env, ...viaGio }), true)
    assert.deepEqual(viaGio.calls.slice(1).map(call => [call.file, call.argv]), [
      ['gtk-launch', ['chromium.desktop', file]],
      ['gio', ['launch', path.join(apps, 'chromium.desktop'), file]]
    ])

    const none = spawner({}, answer)
    assert.equal(await openInBrowser(file, { env, ...none }), false)
    assert.deepEqual(none.calls.slice(1).map(call => call.file), ['gtk-launch', 'gio', 'xdg-open'])
    assert.deepEqual(none.calls.at(-1).argv, [file])

    for (const reply of [{ status: 0, stdout: '../../evil.desktop\n' }, { status: 0, stdout: '\n' }, { status: 1, stdout: 'chromium.desktop\n' }]) {
      const odd = spawner({ 'xdg-open': true }, { 'xdg-settings': reply })
      assert.equal(await openInBrowser(file, { env, ...odd }), true)
      assert.deepEqual(odd.calls.map(call => call.file), ['xdg-settings', 'xdg-open'])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// The CLI wrote `'<node>' '<hook>'` and the web server `"<node>" "<hook>"`, and hooksInstalled compared
// strings, so each one reported the other's install as missing.
const nodeBin = '/opt/my node/bin/node'
const hookFile = "/home/you/it's $here/.local/share/fleetmates-deck/hook/deck-hook.mjs"
const plainHook = '/home/you/.local/share/fleetmates-deck/hook/deck-hook.mjs'
const singleForm = (a, b) => [a, b].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
const doubleForm = (a, b) => `${JSON.stringify(a)} ${JSON.stringify(b)}`
// Independent of isDeckHook, the code under test: any command naming the hook script.
const deckHooks = settings => Object.fromEntries(Object.entries(settings.hooks).map(([event, groups]) => [event, groups.flatMap(group => group.hooks).filter(hook => String(hook.command).includes('deck-hook.mjs')).map(hook => hook.command)]))

test('deckHookCommand round-trips a path with a space, a single quote and a dollar sign through sh', () => {
  const command = deckHookCommand(nodeBin, hookFile)
  const result = spawnSync('sh', ['-c', `printf '%s\\n' ${command}`], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.deepEqual(result.stdout.split('\n').slice(0, -1), [nodeBin, hookFile])
  assert.equal(hooksInstalled(transformHooks({}, command), command), true)
})

test('hooks installed in either quoting count as installed for the other', () => {
  const cli = singleForm(nodeBin, plainHook)
  const server = doubleForm(nodeBin, plainHook)
  assert.equal(hooksInstalled(transformHooks({}, cli), server), true, 'server check sees an init install')
  assert.equal(hooksInstalled(transformHooks({}, server), cli), true, 'init check sees a server install')
  assert.equal(hooksInstalled(transformHooks({}, cli), doubleForm('/usr/bin/node', plainHook)), false, 'a different node is still a different command')
  assert.equal(hooksInstalled(transformHooks({}, `'${nodeBin}'`), cli), false, 'a prefix of the command is not the command')
})

test('mixed-quoting settings end with exactly one canonical deck hook per event', () => {
  // A node binary not named node or nodejs, so only the installed command identifies the hook.
  const node = '/opt/my node/bin/node24'
  const canonical = deckHookCommand(node, plainHook)
  const mixed = transformHooks({}, singleForm(node, plainHook))
  for (const [i, event] of HOOK_EVENTS.entries()) {
    if (i % 2) mixed.hooks[event][0].hooks[0].command = doubleForm(node, plainHook)
    if (i % 3 === 0) mixed.hooks[event][0].hooks.push({ type: 'command', command: doubleForm(node, plainHook), async: true, timeout: 5 })
  }
  const merged = transformHooks(mixed, canonical)
  assert.deepEqual(deckHooks(merged), Object.fromEntries(HOOK_EVENTS.map(event => [event, [canonical]])))
  assert.equal(hooksInstalled(merged, canonical), true)
})

test('the CLI and the web server build the hook command with deckHookCommand', () => {
  const strip = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const file of ['bin/fleetmates-deck.mjs', 'server/main.mjs']) {
    const source = strip(readFileSync(path.join(hub, file), 'utf8'))
    assert.match(source, /deckHookCommand\(process\.execPath, paths\.hook\)/, file)
    assert.doesNotMatch(source, /JSON\.stringify\(process\.execPath\)|shellQuote\(process\.execPath\)/, file)
  }
})
