import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector } from '../../server/machines/projector.mjs'
import net from 'node:net'

async function moduleAt(name) {
  try { return await import(`../../server/${name}.mjs`) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return {}
  }
}

test('command adapter uses popup replacement and a bell shim without shell expansion or private diagnostics', async () => {
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
    const adapter = createNotifier({ notifyCommand: shim, soundCommand: shim, dismissCommand: shim, env })
    const text = '<private> $(touch forbidden)'
    assert.deepEqual(await adapter.popup({ title: '-session', body: text, replaceId: 41, urgency: 'low' }), { ok: true, id: 42 })
    assert.deepEqual(await adapter.bell(), { ok: true })
    assert.deepEqual(await adapter.dismiss(42), { ok: true })
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(calls[0].args, ['--app-name=fleetmates deck', '--print-id', '--urgency=low', '--replace-id=41', '--', '-session', '&lt;private&gt; $(touch forbidden)'])
    assert.deepEqual(calls[1].args, ['--raw', '--format=s16', '--rate=48000', '--channels=1', '-'])
    assert.ok(calls[1].bytes > 1000)
    assert.deepEqual(calls[2].args, ['dismiss', '-n', '42'])
    const failed = createNotifier({ notifyCommand: shim, env: { ...env, SHIM_FAIL: '1' } })
    assert.deepEqual(await failed.popup({ title: 'test', body: text }), { ok: false, error: { code: 'notify_failed', exitCode: 7 } })
    assert.equal(JSON.stringify(await failed.testPing()).includes('private'), false)
    const absent = createNotifier({ notifyCommand: path.join(dir, 'missing'), env })
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
    async popup(value) { calls.push({ type: 'popup', ...value }); return fail ? { ok: false, error: { code: 'notify_failed', exitCode: 1 } } : { ok: true, id: calls.length } },
    async bell() { calls.push({ type: 'bell' }); return { ok: true } },
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
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }) }
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

test('scribed polls the M0 client every two seconds and unavailable status leaves recording quiet mode', async () => {
  const { createScribedStatus } = await moduleAt('adapters/scribed-status')
  assert.equal(typeof createScribedStatus, 'function')
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-sc-'))
  const socketPath = path.join(dir, 'scribed.sock')
  let recording = true
  let count = 0
  let at = 1000
  const changes = []
  const server = net.createServer(socket => {
    socket.on('data', line => {
      assert.deepEqual(JSON.parse(line.toString()), { cmd: 'status' })
      count++
      socket.end(JSON.stringify({ type: 'status', recording, session_id: null, tag: null, elapsed_s: 0, routed_apps: [] }) + '\n')
    })
  })
  await new Promise(resolve => server.listen(socketPath, resolve))
  const poller = createScribedStatus({ socketPath, now: () => at, onChange: value => changes.push(value) })
  try {
    assert.equal(poller.isRecording(), false)
    assert.equal((await poller.poll()).recording, true)
    assert.equal(poller.isRecording(), true)
    assert.equal(count, 1)
    at = 2999
    recording = false
    await poller.poll()
    assert.equal(count, 1)
    assert.equal(poller.isRecording(), true)
    at = 3000
    await Promise.all([poller.poll(), poller.poll()])
    assert.equal(count, 2)
    assert.equal(poller.isRecording(), false)
    recording = true
    at = 5000
    await poller.poll()
    assert.equal(poller.isRecording(), true)
    await new Promise(resolve => server.close(resolve))
    at = 7000
    assert.equal((await poller.poll()).state, 'down')
    assert.equal(poller.isRecording(), false)
    assert.equal(JSON.stringify(changes).includes(socketPath), false)
  } finally {
    poller.stop()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
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

test('scribed injected timers schedule polling and stop discards an in-flight result', async () => {
  const { createScribedStatus } = await moduleAt('adapters/scribed-status')
  assert.equal(typeof createScribedStatus, 'function')
  let at = 1000
  let calls = 0
  let release
  const jobs = []
  const cleared = []
  const changes = []
  const poller = createScribedStatus({
    now: () => at,
    status: async () => {
      calls++
      if (calls === 2) await new Promise(resolve => { release = resolve })
      return { type: 'status', recording: calls === 1 }
    },
    onChange: value => changes.push(value),
    setTimer: (fn, delay) => { const job = { fn, delay }; jobs.push(job); return job },
    clearTimer: job => cleared.push(job)
  })
  try {
    await poller.start()
    await poller.start()
    assert.equal(calls, 1)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].delay, 2000)
    at = 3000
    jobs[0].fn()
    const pending = poller.poll()
    assert.equal(calls, 2)
    poller.stop()
    release()
    await pending
    assert.equal(changes.length, 1)
    assert.equal(poller.isRecording(), true)
    assert.deepEqual(cleared, [jobs[0]])
    assert.equal(jobs.length, 1)
    at = 5000
    await poller.start()
    assert.equal(poller.isRecording(), false)
    assert.equal(jobs.length, 2)
  } finally { poller.stop() }
})
