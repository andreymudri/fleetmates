import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector } from '../../server/machines/projector.mjs'
import { createNotifier } from '../../server/adapters/notify.mjs'
import { posixTest } from '../helpers/platform.mjs'

async function moduleAt(name) {
  try { return await import(`../../server/${name}.mjs`) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return {}
  }
}

posixTest('command adapter uses popup replacement and a bell shim without shell expansion or private diagnostics', { reason: 'runs a #! shim script' }, async () => {
  const { createNotifier } = await moduleAt('adapters/notify')
  assert.equal(typeof createNotifier, 'function')
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-notify-'))
  const log = path.join(dir, 'commands.jsonl')
  const shim = path.join(dir, 'shim.mjs')
  writeFileSync(shim, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
appendFileSync(process.env.SHIM_LOG, JSON.stringify({ args: process.argv.slice(2), bytes: Buffer.concat(chunks).length }) + '\\n')
if (process.env.SHIM_FAIL) { process.stderr.write('private request text'); process.exit(7) }
process.stdout.write('42\\n')
`, { mode: 0o700 })
  try {
    const env = { PATH: process.env.PATH, HOME: dir, XDG_RUNTIME_DIR: dir, SHIM_LOG: log }
    const adapter = createNotifier({ platform: 'linux', notifyCommand: shim, soundCommand: shim, dismissCommand: shim, env })
    const text = '<private> $(touch forbidden)'
    assert.deepEqual(await adapter.popup({ title: '-session', body: text, replaceId: 41, urgency: 'low' }), { ok: true, id: 42 })
    assert.deepEqual(await adapter.bell(), { ok: true })
    assert.deepEqual(await adapter.dismiss(42), { ok: true })
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(calls[0].args, ['--app-name=fleetmates deck', '--print-id', '--urgency=low', '--replace-id=41', '--', '-session', '&lt;private&gt; $(touch forbidden)'])
    assert.deepEqual(calls[1].args, ['--raw', '--format=s16', '--rate=48000', '--channels=1', '-'])
    assert.ok(calls[1].bytes > 1000)
    assert.deepEqual(calls[2].args, ['dismiss', '-n', '42'])
    const failed = createNotifier({ platform: 'linux', notifyCommand: shim, env: { ...env, SHIM_FAIL: '1' } })
    assert.deepEqual(await failed.popup({ title: 'test', body: text }), { ok: false, error: { code: 'notify_failed', exitCode: 7 } })
    assert.equal(JSON.stringify(await failed.testPing()).includes('private'), false)
    const absent = createNotifier({ platform: 'linux', notifyCommand: path.join(dir, 'missing'), env })
    assert.equal((await absent.testPing()).error.code, 'notify_failed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

async function harness() {
  const { createNotificationMachine } = await moduleAt('machines/notification')
  assert.equal(typeof createNotificationMachine, 'function')
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-notify-db-'))
  const file = path.join(dir, 'deck.db')
  let store = openDeckDb(file)
  let at = 1000
  let recording = false
  let fail = false
  const calls = []
  const publications = []
  const notifier = {
    // `fail` is false, true (a failed notify-send) or the exact result object popups and bells answer with.
    async popup(value) { calls.push({ type: 'popup', ...value }); return fail === true ? { ok: false, error: { code: 'notify_failed', exitCode: 1 } } : fail || { ok: true, id: calls.length } },
    async bell() { calls.push({ type: 'bell' }); return typeof fail === 'object' ? fail : { ok: true } },
    async dismiss(id) { calls.push({ type: 'dismiss', id }); return { ok: true } },
    async testPing() { calls.push({ type: 'ping' }); return { ok: !fail } }
  }
  const options = () => ({ store, notifier, now: () => at, recording: () => recording, publish: event => publications.push(event) })
  let machine = createNotificationMachine(options())
  let projector = createProjector({ store, now: () => at })
  const hook = JSON.parse(readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url), 'utf8'))
  function send(event, extra = {}) {
    projector.applyHooks([{ v: 1, hook: { ...hook, cwd: dir, session_id: 'synthetic-session', hook_event_name: event, ...extra }, hookTs: at, receivedAt: at, claudePid: 42, ptyId: null, via: 'socket' }])
  }
  send('SessionStart', { source: 'startup' })
  const sessionId = projector.snapshot().sessions[0].id
  return {
    get store() { return store }, get machine() { return machine }, get projector() { return projector },
    calls, publications, sessionId, send,
    setTime(value) { at = value }, setRecording(value) { recording = value }, setFail(value) { fail = value },
    async tick(value = at) { at = value; return machine.tick() },
    open(command = 'pwd') { send('PermissionRequest', { tool_name: 'Bash', tool_input: { command } }); return projector.snapshot().requests.at(-1).id },
    close(command = 'pwd') { send('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: { success: true } }) },
    restart() { store.close(); store = openDeckDb(file); machine = createNotificationMachine(options()); projector = createProjector({ store, now: () => at }) },
    // The machine and the store are closed first. Windows can still refuse the removal for a while afterwards (EPERM),
    // so it retries for up to five seconds.
    cleanup() { machine.close(); store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }) }
  }
}

test('requests wait for grace, coalesce, ring once per episode and remind exactly once across replay and restart', async () => {
  const h = await harness()
  try {
    const first = h.open()
    h.setTime(1100)
    const second = h.open('ls')
    await h.tick(3999)
    assert.deepEqual(h.calls, [])
    await h.tick(4100)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    assert.match(h.calls[0].title, /2 requests/)
    assert.match(h.calls[0].body, /Answer in your terminal/)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 1)
    assert.equal(h.store.get('SELECT notified_at FROM requests WHERE id=?', first).notified_at, 4100)
    assert.equal(h.store.all('SELECT * FROM notification_history').length, 2)
    h.restart()
    h.setTime(1100)
    h.open('ls')
    await h.tick(604099)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    await h.tick(604100)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 2)
    assert.equal(h.calls.filter(row => row.type === 'popup')[1].replaceId, 1)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 1)
    assert.equal(h.store.get('SELECT renotified_at FROM requests WHERE id=?', second).renotified_at, 604100)
    h.restart()
    await h.tick(1_204100)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 2)
    assert.deepEqual(h.store.all('SELECT kind,COUNT(*) AS n FROM notification_history GROUP BY kind').map(row => ({ ...row })), [{ kind: 'renotify', n: 2 }, { kind: 'request', n: 2 }])
    h.setTime(1_204101)
    h.close()
    h.close('ls')
    await h.tick()
    assert.ok(h.calls.some(row => row.type === 'dismiss'))
    h.setTime(1_204102)
    h.open('whoami')
    await h.tick(1_207102)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 2)
  } finally { h.cleanup() }
})

test('recording keeps popups, suppresses bells without delayed chimes and preferences survive restart', async () => {
  const h = await harness()
  try {
    h.setRecording(true)
    h.open()
    await h.tick(4000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 0)
    h.restart()
    h.setRecording(false)
    await h.tick(4001)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 0)
    h.close()
    await h.tick()
    h.machine.setPreferences({ quietInMeetings: false, renotifyAfter: null })
    h.restart()
    assert.equal(h.machine.getPreferences().quietInMeetings, false)
    h.setRecording(true)
    h.setTime(5000)
    h.open('ls')
    await h.tick(8000)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 1)
    await h.tick(1_208000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 2)
    h.machine.setPreferences({ bell: false, renotifyAfter: 5 })
    await h.tick(1_208001)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 3)
    h.close('ls')
    await h.tick()
    h.setTime(1_209000)
    h.open('date')
    await h.tick(1_212000)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 1)
    assert.throws(() => h.machine.setPreferences({ renotifyAfter: 1 }), /invalid notification preference/)
    assert.throws(() => h.machine.setPreferences({ bell: 'yes' }), /invalid notification preference/)
    assert.throws(() => h.machine.setPreferences({ extra: true }), /invalid notification preference/)
    assert.equal(h.publications.some(row => row.type === 'prefs.changed'), true)
  } finally { h.cleanup() }
})

test('done waits five seconds, crash is popup-only, stale is silent and terminal notifications dedupe after restart', async () => {
  const h = await harness()
  try {
    h.send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'changed.txt' }, tool_response: { success: true } })
    h.setTime(2000)
    h.send('Stop')
    assert.equal(h.projector.snapshot().sessions[0].state, 'done')
    await h.tick(6999)
    assert.deepEqual(h.calls, [])
    await h.tick(7000)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].urgency, 'low')
    assert.match(h.calls[0].title, /made port/)
    assert.match(h.calls[0].body, /1 files changed/)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 0)
    h.restart()
    await h.tick(7001)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    h.projector.signal(h.sessionId, { type: 'review' }, 7002)
    await h.tick(7002)
    assert.equal(h.calls.filter(row => row.type === 'dismiss').length, 1)
    h.setTime(8000)
    h.send('UserPromptSubmit', { prompt: 'continue' })
    h.setTime(9000)
    h.send('Stop')
    await h.tick(14000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    h.setTime(15000)
    h.send('UserPromptSubmit', { prompt: 'work' })
    h.projector.tick(1_215000)
    await h.tick(1_215000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    h.projector.signal(h.sessionId, { type: 'pid_gone' }, 1_215001)
    await h.tick(1_215001)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 2)
    assert.match(h.calls.at(-1).title, /crashed/)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 0)
    h.restart()
    await h.tick(1_215002)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 2)
    assert.deepEqual(h.store.all('SELECT kind FROM notification_history ORDER BY id').map(row => row.kind), ['done', 'crash'])
  } finally { h.cleanup() }
})

test('closed grace requests stay silent, delivery failure retries privately and concurrent ticks send one ping and popup', async () => {
  const h = await harness()
  try {
    assert.equal(typeof h.machine.testPing, 'function')
    h.open()
    h.setTime(2000)
    h.close()
    await h.tick(4000)
    assert.deepEqual(h.calls, [])
    h.setTime(5000)
    const id = h.open('ls')
    h.setFail(true)
    await h.tick(8000)
    assert.equal(h.store.all('SELECT * FROM notification_history').length, 0)
    assert.equal(h.store.get('SELECT notified_at FROM requests WHERE id=?', id).notified_at, null)
    assert.deepEqual(h.publications.at(-1), { type: 'notify.failed', data: { code: 'notify_failed' } })
    h.setFail(false)
    await Promise.all([h.tick(8001), h.tick(8001), h.tick(8001)])
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 2)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 1)
    assert.equal(h.store.all('SELECT * FROM notification_history').length, 1)
    assert.deepEqual(await h.machine.testPing(), { ok: true })
    assert.equal(h.calls.at(-1).type, 'ping')
    assert.equal(h.store.all('SELECT * FROM notification_history').length, 1)
    assert.equal(h.publications.some(row => JSON.stringify(row).includes('ls')), false)
  } finally { h.cleanup() }
})

test('an unsupported popup is recorded as skipped without notify.failed and is not retried; any other ok:false stays notify.failed', async () => {
  const h = await harness()
  try {
    const unsupported = { ok: false, reason: 'unsupported on win32' }
    h.setFail(unsupported)
    const id = h.open()
    await h.tick(4000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    assert.equal(h.publications.some(row => row.type === 'notify.failed'), false)
    // The claim stays, so the next ticks and a restart do not ask the notifier again.
    assert.deepEqual(h.store.all('SELECT kind,request_id FROM notification_history').map(row => ({ ...row })), [{ kind: 'request', request_id: id }])
    assert.equal(h.store.get('SELECT notified_at FROM requests WHERE id=?', id).notified_at, null)
    await h.tick(5000)
    h.restart()
    await h.tick(700000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    h.close()
    h.projector.signal(h.sessionId, { type: 'pid_gone' }, 700001)
    await h.tick(700001)
    assert.match(h.calls.filter(row => row.type === 'popup').at(-1).title, /crashed/)
    assert.equal(h.publications.some(row => row.type === 'notify.failed'), false)
    assert.equal(h.store.all("SELECT * FROM notification_history WHERE kind='crash'").length, 1)
    await h.tick(700002)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 2)

    const other = await harness()
    try {
      other.setFail({ ok: false, reason: 'popup daemon gone' })
      other.open()
      await other.tick(4000)
      assert.deepEqual(other.publications.at(-1), { type: 'notify.failed', data: { code: 'notify_failed' } })
      assert.equal(other.store.all('SELECT * FROM notification_history').length, 0)
      other.close()
      other.projector.signal(other.sessionId, { type: 'pid_gone' }, 4001)
      other.publications.length = 0
      await other.tick(4001)
      assert.match(other.calls.at(-1).title, /crashed/)
      assert.deepEqual(other.publications.filter(row => row.type === 'notify.failed'), [{ type: 'notify.failed', data: { code: 'notify_failed' } }])
      assert.equal(other.store.all("SELECT * FROM notification_history WHERE kind='crash'").length, 0)
    } finally { other.cleanup() }
  } finally { h.cleanup() }
})

test('overlapping requests keep one bell episode when every previously notified request closes between ticks', async () => {
  const h = await harness()
  try {
    h.open()
    await h.tick(4000)
    h.setTime(5000)
    h.open('ls')
    h.setTime(6000)
    h.close()
    h.restart()
    await h.tick(8000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 2)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 1)
    h.setTime(9000)
    h.close('ls')
    h.setTime(10000)
    h.open('date')
    h.restart()
    await h.tick(13000)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 2)
  } finally { h.cleanup() }
})

test('requests inside the first grace window share a popup as soon as that window ends', async () => {
  const h = await harness()
  try {
    h.open()
    h.setTime(2000)
    h.open('ls')
    await h.tick(4000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    assert.match(h.calls[0].title, /2 requests/)
    h.setTime(10000)
    h.open('date')
    h.setTime(14000)
    h.open('whoami')
    await h.tick(17000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 3)
    assert.equal(h.calls.filter(row => row.type === 'bell').length, 1)
  } finally { h.cleanup() }
})

test('terminal popup preferences can change live and never change test ping history', async () => {
  const h = await harness()
  try {
    h.machine.setPreferences({ notifyDone: false, notifyCrash: false })
    h.send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'changed.txt' }, tool_response: { success: true } })
    h.setTime(2000)
    h.send('Stop')
    await h.tick(7000)
    assert.deepEqual(h.calls, [])
    h.machine.setPreferences({ notifyDone: true })
    await h.tick(7001)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    h.projector.signal(h.sessionId, { type: 'pid_gone' }, 8000)
    await h.tick(8000)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 1)
    h.machine.setPreferences({ notifyCrash: true })
    await h.tick(8001)
    assert.equal(h.calls.filter(row => row.type === 'popup').length, 2)
    h.setFail(true)
    assert.deepEqual(await h.machine.testPing(), { ok: false })
    assert.equal(h.store.all('SELECT * FROM notification_history').length, 2)
  } finally { h.cleanup() }
})

/** A runner that records each command and answers ok with an id on stdout. */
function recordingRun() {
  const calls = []
  const run = async (command, args, options) => {
    calls.push({ command, args, input: options.input ?? null })
    return { ok: true, exitCode: 0, stdout: '42\n' }
  }
  return { calls, run }
}

test('linux keeps notify-send, pw-play and makoctl as the default commands', async () => {
  const { calls, run } = recordingRun()
  const notifier = createNotifier({ platform: 'linux', env: {}, run })
  assert.deepEqual(await notifier.popup({ title: 't', body: 'b' }), { ok: true, id: 42 })
  assert.deepEqual(await notifier.bell(), { ok: true })
  assert.deepEqual(await notifier.dismiss(42), { ok: true })
  assert.deepEqual(calls.map(call => call.command), ['notify-send', 'pw-play', 'makoctl'])
})

test('darwin shows a popup with osascript, title and body as separate -e strings with AppleScript escaping, and rings afplay Glass', async () => {
  const { calls, run } = recordingRun()
  const notifier = createNotifier({ platform: 'darwin', env: {}, run })
  const title = 'say "hi" \\ $(touch forbidden)'
  const body = 'line one\n"two" & <three>'
  let acted = false
  assert.deepEqual(await notifier.popup({ title, body, replaceId: 9, actions: ['allow', 'open'], onAction: () => { acted = true } }), { ok: true, id: null })
  assert.deepEqual(calls[0], { command: 'osascript', input: null, args: [
    '-e', 'set deckTitle to "say \\"hi\\" \\\\ $(touch forbidden)"',
    '-e', 'set deckBody to "line one\\n\\"two\\" & <three>"',
    '-e', 'display notification deckBody with title deckTitle'
  ] })
  assert.equal(acted, false)
  assert.deepEqual(await notifier.bell(), { ok: true })
  assert.deepEqual(calls[1], { command: 'afplay', args: ['/System/Library/Sounds/Glass.aiff'], input: null })
  assert.deepEqual(await notifier.dismiss(9), { ok: true })
  assert.deepEqual(await notifier.testPing(), { ok: true, id: null })
  assert.deepEqual(calls.map(call => call.command), ['osascript', 'afplay', 'osascript'])
})

test('darwin reports a failed osascript as notify_failed', async () => {
  const notifier = createNotifier({ platform: 'darwin', env: {}, run: async () => ({ ok: false, exitCode: 1 }) })
  assert.deepEqual(await notifier.popup({ title: 't', body: 'b' }), { ok: false, error: { code: 'notify_failed', exitCode: 1 } })
})

test('win32 popups and bells resolve unsupported on win32 without running anything', async () => {
  const { calls, run } = recordingRun()
  const notifier = createNotifier({ platform: 'win32', env: {}, run })
  assert.deepEqual(await notifier.popup({ title: 't', body: 'b', actions: ['open'] }), { ok: false, reason: 'unsupported on win32' })
  assert.deepEqual(await notifier.bell(), { ok: false, reason: 'unsupported on win32' })
  assert.deepEqual(await notifier.testPing(), { ok: false, reason: 'unsupported on win32' })
  assert.deepEqual(await notifier.dismiss(3), { ok: true })
  notifier.close()
  assert.deepEqual(calls, [])
})
