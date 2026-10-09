// M4 Task 11: the meeting routes of 05-api 2.11, the meeting scope of POST /api/ask, the open kinds, the hook guard
// and "Start scribed", against createDeckServer with a temporary HOME holding the meetings5 tree, the fake scribed
// in a makeRuntimeDir() directory and shims first on PATH. No real scribed, systemd-run or xdg-open runs: the
// opener and the systemd-run runner are injected, and the injected runner executes a shim by absolute path.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { startDeckServer } from '../../server/main.mjs'
import { startFakeScribed } from '../fakes/fake-scribed.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { meetings5, writeMeetingsTree } from '../helpers/meetings-tree.mjs'

// Meetings and scribed run on Linux only (docs/deck/16-platforms.md section 1). FLEETMATES_TEST_FORCE_WINDOWS=1
// shows the skip on Linux, as it does for posixTest.
const LINUX_ONLY = (process.platform !== 'linux' || process.env.FLEETMATES_TEST_FORCE_WINDOWS === '1') && 'meetings and scribed are Linux only (16-platforms section 1)'

const run = promisify(execFile)
const token = 'm'.repeat(43)
const hookFixture = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))
const HOST_BINARIES = ['systemd-run', 'systemctl', 'scribed', 'scribe', 'postmeet', 'xdg-open', 'notify-send', 'makoctl', 'pw-play']

// Every host binary a mutation could reach is a logging shim first on this process's PATH as well as on the
// server's environment.
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapi-bin-'))
const shimLog = path.join(shimDir, 'argv.jsonl')
for (const name of HOST_BINARIES) {
  fs.writeFileSync(path.join(shimDir, name), `#!${process.execPath}
import fs from 'node:fs'
fs.appendFileSync(${JSON.stringify(shimLog)}, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2), token: Object.keys(process.env).some(key => /TOKEN/i.test(key)) }) + '\\n')
`, { mode: 0o700 })
}
process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
process.on('exit', () => fs.rmSync(shimDir, { recursive: true, force: true }))
const shimCalls = () => fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    assert.ok(Date.now() < until, 'timed out')
    await sleep(20)
  }
}

/**
 * A deck server over a temporary HOME with the meetings5 tree (config at the MEET-O11 default path), the fake
 * scribed (unless `scribed: false`) and the injected opener and systemd-run runner.
 */
async function harness(t, { variants = [], scribed = true, fake = {}, execFile: injectedExec, runtime = true, processRuntime = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mapi-'))
  const tree = await writeMeetingsTree(home, meetings5, { variants })
  const rt = await makeRuntimeDir()
  let scribedFake = scribed ? await startFakeScribed({ dir: rt.dir, ...fake }) : null
  const state = path.join(home, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(home, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>deck</h1>')
  const opened = []
  const commands = []
  const h = {
    home, tree, rt, opened, commands, state,
    get fake() { return scribedFake },
    async startFake(options = {}) { scribedFake = await startFakeScribed({ dir: rt.dir, ...options }) }
  }
  // `processRuntime` points this process's XDG_RUNTIME_DIR at the fake's directory while the server runs.
  const savedRuntime = process.env.XDG_RUNTIME_DIR
  if (processRuntime) process.env.XDG_RUNTIME_DIR = rt.dir
  const deck = await startDeckServer({
    env: { HOME: home, ...(runtime ? { XDG_RUNTIME_DIR: rt.dir } : {}), PATH: process.env.PATH, SHELL: '/bin/sh', DECK_TOKEN: 'not-for-children' },
    port: 0, staticDir, notifications: false, runPollMs: 3_600_000, configDebounceMs: 20,
    connectDeckd: async () => { throw Error('fake offline') },
    runCommand: (file, args) => { commands.push([file, args])
      return { status: 0, stdout: '', stderr: '' } },
    services: { open: async target => { opened.push(target) } },
    ...(injectedExec ? { scribedExecFile: (file, args, options) => injectedExec(h, file, args, options) } : {})
  })
  h.deck = deck
  t.after(async () => {
    await deck.close()
    if (processRuntime) {
      if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = savedRuntime
    }
    await scribedFake?.stop()
    await rt.cleanup()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${deck.address().port}`
  h.request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(base + route, {
      method, headers: { Authorization: `Bearer ${token}`, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    return { status: response.status, data: text ? JSON.parse(text) : null }
  }
  h.socket = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${deck.address().port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { origin: base })
    const messages = []
    ws.on('message', raw => messages.push(JSON.parse(raw)))
    const ready = new Promise(resolve => ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', apiVersion: 1, lastSeq: 0, epoch: null }))
      resolve() }))
    t.after(() => ws.close())
    return { ws, messages, ready }
  }
  h.start = async tag => {
    const started = await h.request('/api/meetings/start', { method: 'POST', body: { tag } })
    assert.equal(started.status, 202, JSON.stringify(started.data))
    return started.data.recorder
  }
  return h
}

test('the shims are what a test resolves for every host binary', { skip: LINUX_ONLY }, () => {
  for (const name of HOST_BINARIES) {
    assert.equal(execFileSync('/bin/sh', ['-c', `command -v ${name}`], { env: process.env, encoding: 'utf8' }).trim(), path.join(shimDir, name))
  }
})

test('POST /api/meetings/start { tag: client-a } reaches the fake as that command, answers 202 recording, and the row is confidential', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t)
  const recorder = await h.start('client-a')
  assert.equal(recorder.state, 'recording')
  assert.equal(recorder.confidential, true)
  const starts = h.fake.received.filter(entry => entry.parsed?.cmd === 'start')
  assert.deepEqual(starts.map(entry => entry.raw), ['{"cmd":"start","tag":"client-a"}'])
  const detail = await h.request(`/api/meetings/${recorder.meetingId}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.data.meeting.tag, 'client-a')
  assert.equal(detail.data.meeting.confidential, true)
})

test('an unknown tag is 422 unknown_tag and scribed receives no start', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t)
  const response = await h.request('/api/meetings/start', { method: 'POST', body: { tag: 'not-a-tag' } })
  assert.equal(response.status, 422)
  assert.equal(response.data.error.code, 'unknown_tag')
  assert.equal(h.fake.received.some(entry => entry.parsed?.cmd === 'start'), false)
})

test('scribed refusing a start is 409 scribed_refused with its message verbatim in details.text', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t)
  h.fake.on('start', () => ({ type: 'error', cmd: 'start', message: 'sessão já ativa; pare a atual antes' }))
  const response = await h.request('/api/meetings/start', { method: 'POST', body: { tag: 'pessoal' } })
  assert.equal(response.status, 409)
  assert.equal(response.data.error.code, 'scribed_refused')
  assert.equal(response.data.error.retryable, false)
  assert.deepEqual(response.data.error.details, { text: 'sessão já ativa; pare a atual antes' })
})

test('POST /api/meetings/stop answers 202 stopping within 200 ms while scribed takes 2 s to stop', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { fake: { stopDelayMs: 2000 } })
  await h.start('pessoal')
  const started = Date.now()
  const response = await h.request('/api/meetings/stop', { method: 'POST' })
  const took = Date.now() - started
  assert.equal(response.status, 202)
  assert.equal(response.data.recorder.state, 'stopping')
  assert.ok(took < 200, `stop answered in ${took} ms`)
  const again = await h.request('/api/meetings/stop', { method: 'POST' })
  assert.equal(again.status, 409)
  assert.equal(again.data.error.code, 'not_recording')
})

test('two pins 1 s apart give 201 then 200 with the same pin, labelled from the ring; a confidential pin has a null label', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t)
  const recorder = await h.start('pessoal')
  const id = recorder.meetingId
  await waitFor(() => h.fake.connections.some(conn => conn.subscribed && !conn.closed))
  h.fake.pushTranscript({ t0: 10, t1: 12, source: 'mic', text: 'primeira linha fixada', lang: 'pt', asr_model: 'medium-int8', session_id: id })
  await waitFor(async () => (await h.request(`/api/meetings/${id}/transcript`)).data.lines?.length === 1)
  const first = await h.request(`/api/meetings/${id}/pins`, { method: 'POST', body: { t: 10 } })
  assert.equal(first.status, 201)
  assert.equal(first.data.pin.label, 'primeira linha fixada')
  const second = await h.request(`/api/meetings/${id}/pins`, { method: 'POST', body: { t: 11 } })
  assert.equal(second.status, 200)
  assert.equal(second.data.pin.id, first.data.pin.id)
  assert.equal((await h.request(`/api/meetings/${id}/pins/${first.data.pin.id}`, { method: 'DELETE' })).status, 204)
  assert.equal((await h.request(`/api/meetings/${id}/pins/${first.data.pin.id}`, { method: 'DELETE' })).status, 404)
  const notRecording = await h.request(`/api/meetings/${h.tree.ids.planning}/pins`, { method: 'POST' })
  assert.equal(notRecording.status, 409)
  assert.equal(notRecording.data.error.code, 'not_recording')

  await h.request('/api/meetings/stop', { method: 'POST' })
  await waitFor(async () => (await h.request('/api/meetings')).data.recorder.state === 'idle')
  const secret = await h.start('client-a')
  await waitFor(() => h.fake.connections.some(conn => conn.subscribed && !conn.closed))
  h.fake.pushTranscript({ t0: 4, t1: 6, source: 'room', text: 'linha confidencial', lang: 'pt', asr_model: 'medium-int8', session_id: secret.meetingId })
  await waitFor(async () => (await h.request(`/api/meetings/${secret.meetingId}/transcript`)).data.lines?.length === 1)
  const pinned = await h.request(`/api/meetings/${secret.meetingId}/pins`, { method: 'POST', body: { t: 4 } })
  assert.equal(pinned.status, 201)
  assert.equal(pinned.data.pin.label, null)
})

test('the transcript route reads the file again on every call', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t)
  const id = h.tree.ids.planning
  const first = await h.request(`/api/meetings/${id}/transcript`)
  assert.equal(first.status, 200)
  assert.equal(first.data.source, 'batch')
  assert.equal(first.data.lines.length, 2)
  const file = path.join(h.tree.sessionDir, id, 'transcript.json')
  const lines = JSON.parse(fs.readFileSync(file, 'utf8'))
  lines.push({ t0: 20, t1: 24, speaker: 'Você', text: 'Uma linha nova no arquivo.' })
  fs.writeFileSync(file, JSON.stringify(lines))
  const second = await h.request(`/api/meetings/${id}/transcript`)
  assert.equal(second.data.lines.length, 3)
  assert.equal(second.data.lines.at(-1).text, 'Uma linha nova no arquivo.')
  assert.equal((await h.request('/api/meetings/2020-01-01T00-00-00/transcript')).status, 404)
})

test('search: q=a is 422; a confidential sentinel is found, a file change is seen, and deck.db holds no sentinel', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { variants: ['confidential'] })
  const short = await h.request('/api/meetings/search?q=a')
  assert.equal(short.status, 422)
  assert.equal(short.data.error.code, 'validation_failed')
  const id = h.tree.ids.confidential
  const found = await h.request('/api/meetings/search?q=SENTINEL-9')
  assert.equal(found.status, 200)
  assert.deepEqual(found.data.hits.map(hit => hit.meetingId), [id])
  assert.match(found.data.hits[0].snippet, /SENTINEL-9/)
  const file = path.join(h.tree.sessionDir, id, 'transcript.json')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('SENTINEL-9', 'SENTINEL-13'))
  assert.deepEqual((await h.request('/api/meetings/search?q=SENTINEL-9')).data.hits, [])
  assert.deepEqual((await h.request('/api/meetings/search?q=SENTINEL-13')).data.hits.map(hit => hit.meetingId), [id])
  assert.equal((await h.request(`/api/meetings/${id}`)).data.meeting.confidential, true)
  const db = path.join(h.state, 'deck.db')
  for (const name of [db, `${db}-wal`]) {
    const bytes = fs.existsSync(name) ? fs.readFileSync(name) : Buffer.alloc(0)
    for (const sentinel of [...h.tree.sentinels.confidential, 'SENTINEL-13']) assert.equal(bytes.includes(sentinel), false, `${path.basename(name)} holds ${sentinel}`)
  }
})

test('open postmeetLog of a log symlinked out of session_dir is 403 path_not_allowed and opens nothing', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t)
  const id = h.tree.ids.planning
  const ok = await h.request('/api/open', { method: 'POST', body: { kind: 'postmeetLog', ref: id } })
  assert.equal(ok.status, 202)
  assert.deepEqual(h.opened, [fs.realpathSync.native(path.join(h.tree.sessionDir, id, 'postmeet.log'))])
  const outside = path.join(h.home, 'outside.log')
  fs.writeFileSync(outside, 'not a meeting log\n')
  const log = path.join(h.tree.sessionDir, id, 'postmeet.log')
  fs.rmSync(log)
  fs.symlinkSync(outside, log)
  const refused = await h.request('/api/open', { method: 'POST', body: { kind: 'postmeetLog', ref: id } })
  assert.equal(refused.status, 403)
  assert.equal(refused.data.error.code, 'path_not_allowed')
  assert.equal(h.opened.length, 1)
  const note = await h.request('/api/open', { method: 'POST', body: { kind: 'meetingNote', ref: id } })
  assert.equal(note.status, 202)
  assert.equal(h.opened[1], `obsidian://open?vault=vault&file=${encodeURIComponent(h.tree.notes.planning)}`)
})

test('a hook envelope whose cwd is inside session_dir creates no session, one outside does', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t)
  const send = (cwd, sessionId) => {
    h.deck.ingest.receive(JSON.stringify({ v: 1, hookTs: Date.now(), ptyId: null, claudePid: null, pidChain: [], truncated: false,
      hook: { ...hookFixture, cwd, session_id: sessionId, hook_event_name: 'SessionStart' } }))
    h.deck.ingest.flush()
  }
  send(path.join(h.tree.sessionDir, h.tree.ids.planning), 'inside-session-dir')
  assert.equal(h.deck.projector.snapshot().sessions.length, 0)
  assert.equal(h.deck.meetingHookDrops(), 1)
  send(h.home, 'outside-session-dir')
  assert.equal(h.deck.projector.snapshot().sessions.length, 1)
  assert.equal(h.deck.meetingHookDrops(), 1)
})

test('a meeting ask streams ask.delta and ask.done without seq, and no ask event can reach the events table', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { fake: { askDeltas: ['Quarta', '-feira.'] } })
  const recorder = await h.start('pessoal')
  const { messages, ready } = h.socket()
  await ready
  await waitFor(() => messages.some(message => message.t === 'snapshot'))
  const asked = await h.request('/api/ask', { method: 'POST', body: { text: 'qual o prazo?', scope: `meeting:${recorder.meetingId}` } })
  assert.equal(asked.status, 202)
  assert.equal(asked.data.thread.persisted, false)
  const done = await waitFor(() => messages.find(message => message.t === 'ask.done'))
  const deltas = messages.filter(message => message.t === 'ask.delta')
  assert.deepEqual(deltas.map(message => message.data.text), ['Quarta', '-feira.'])
  assert.equal(done.data.message.text, 'Quarta-feira.')
  for (const message of [...deltas, done]) assert.equal(Object.hasOwn(message, 'seq'), false)
  assert.equal(h.deck.store.get("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'ask.%'").n, 0)
  for (const type of ['ask.delta', 'ask.done', 'ask.error', 'meeting.recovered', 'error']) {
    assert.throws(() => h.deck.store.appendEvent({ type, data: {} }), TypeError, type)
  }
  const vault = await h.request('/api/ask', { method: 'POST', body: { text: 'oi', scope: 'vault' } })
  assert.equal(vault.status, 503)
  assert.equal(vault.data.error.code, 'vault_unavailable')
})

test('with no scribed socket GET /api/meetings still lists the five past meetings, recorder unavailable', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { scribed: false })
  const list = await h.request('/api/meetings')
  assert.equal(list.status, 200)
  assert.equal(list.data.recorder.state, 'unavailable')
  assert.deepEqual(list.data.meetings.map(row => row.id), h.tree.ids.meetings)
  assert.equal(list.data.configError, null)
  assert.deepEqual(list.data.tags.map(tag => tag.tag), ['pessoal', 'client-a', 'client-b'])
  const weekly = list.data.meetings.find(row => row.id === h.tree.ids.weekly)
  assert.equal(weekly.title, 'weekly sync')
  assert.equal(weekly.confidential, true)
  assert.equal(weekly.actionItemCount, 3)
  const scribed = (await h.request('/api/health')).data.deps.find(dep => dep.dep === 'scribed')
  assert.equal(scribed.state, 'down')
  const start = await h.request('/api/meetings/start', { method: 'POST', body: { tag: 'pessoal' } })
  assert.equal(start.status, 503)
  assert.equal(start.data.error.code, 'scribed_unavailable')
  assert.equal(start.data.error.retryable, true)
})

test('POST /api/deps/scribed/start runs the systemd-run shim with the decided argv and no token in its environment', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, {
    scribed: false,
    execFile: async (h, file, args, options) => {
      // The server names the binary; the shim runs by absolute path, and scribed comes up as the real unit would.
      assert.equal(file, 'systemd-run')
      await run(path.join(shimDir, file), args, { env: { ...options.env, PATH: process.env.PATH }, timeout: options.timeout })
      await h.startFake()
    }
  })
  const before = shimCalls().length
  const response = await h.request('/api/deps/scribed/start', { method: 'POST' })
  assert.equal(response.status, 202, JSON.stringify(response.data))
  assert.equal(response.data.dep.state, 'ok')
  const calls = shimCalls().slice(before)
  assert.deepEqual(calls, [{ command: 'systemd-run', args: ['--user', '--collect', '--unit=turbidassist-scribed', '--property=KillMode=process', '/bin/sh', '-l', '-c', 'exec scribed'], token: false }])
  assert.deepEqual(h.commands, [])
})

/** Send one hook envelope of `event` from `cwd` through the ingestor. */
function sendHook(h, cwd, sessionId, event, extra = {}) {
  h.deck.ingest.receive(JSON.stringify({ v: 1, hookTs: Date.now(), ptyId: null, claudePid: null, pidChain: [], truncated: false,
    hook: { ...hookFixture, cwd, session_id: sessionId, hook_event_name: event, ...extra } }))
  h.deck.ingest.flush()
}

test('the hook guard keeps the last good session_dir when config.yaml stops reading, so a prompt from inside it is never stored', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { scribed: false })
  const inside = path.join(h.tree.sessionDir, h.tree.ids.planning)
  sendHook(h, inside, 'guard-before', 'SessionStart')
  assert.equal(h.deck.projector.snapshot().sessions.length, 0)
  fs.writeFileSync(h.tree.configPath, 'session_dir: ~/meetings\n\tbroken: tab\n')
  await waitFor(async () => (await h.request('/api/meetings')).data.configError !== null)
  sendHook(h, inside, 'guard-after', 'SessionStart')
  sendHook(h, inside, 'guard-after', 'UserPromptSubmit', { prompt: 'SENTINEL-T11-PROMPT' })
  assert.equal(h.deck.projector.snapshot().sessions.length, 0)
  assert.equal(h.deck.meetingHookDrops(), 3)
  const db = path.join(h.state, 'deck.db')
  for (const name of [db, `${db}-wal`]) {
    const bytes = fs.existsSync(name) ? fs.readFileSync(name) : Buffer.alloc(0)
    assert.equal(bytes.includes('SENTINEL-T11-PROMPT'), false, path.basename(name))
  }
})

test('a hook whose cwd is a symlink outside session_dir pointing into it is dropped', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { scribed: false })
  const link = path.join(h.home, 'looks-outside')
  fs.symlinkSync(path.join(h.tree.sessionDir, h.tree.ids.planning), link)
  sendHook(h, link, 'via-symlink', 'SessionStart')
  assert.equal(h.deck.projector.snapshot().sessions.length, 0)
  assert.equal(h.deck.meetingHookDrops(), 1)
})

test('without XDG_RUNTIME_DIR in its env the server never reaches the socket of the process environment', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { runtime: false, processRuntime: true })
  assert.equal(process.env.XDG_RUNTIME_DIR, h.rt.dir)
  await sleep(300)
  const list = await h.request('/api/meetings')
  assert.equal(list.data.recorder.state, 'unavailable')
  const start = await h.request('/api/meetings/start', { method: 'POST', body: { tag: 'pessoal' } })
  assert.equal(start.status, 503)
  assert.deepEqual(h.fake.received, [])
})

test('a turbidassistConfig pref change is located and read again: GET /api/meetings shows the new tags and configPath', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { scribed: false })
  const first = await h.request('/api/meetings')
  assert.equal(first.data.configPath, h.tree.configPath)
  assert.deepEqual(first.data.tags.map(tag => tag.tag), ['pessoal', 'client-a', 'client-b'])
  const second = path.join(h.home, 'other', 'config.yaml')
  fs.mkdirSync(path.dirname(second), { mode: 0o700 })
  fs.writeFileSync(second, meetings5.config.replace('    client-b:\n', '    acme:\n'))
  const patched = await h.request('/api/prefs', { method: 'PATCH', body: { turbidassistConfig: second } })
  assert.equal(patched.status, 200)
  const after = await waitFor(async () => {
    const list = await h.request('/api/meetings')
    return list.data.configPath === second ? list : null
  }, 2000)
  assert.deepEqual(after.data.tags.map(tag => tag.tag), ['pessoal', 'client-a', 'acme'])
})

test('meeting detail sends the distinct speaker names', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { scribed: false })
  const detail = await h.request(`/api/meetings/${h.tree.ids.planning}`)
  assert.deepEqual(detail.data.speakers, ['Você', 'SPEAKER_00'])
})

test('open meetingNote refuses a stored note path that is not .md, and the log route bounds lines at 1000', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t, { scribed: false })
  const id = h.tree.ids.planning
  fs.writeFileSync(path.join(h.tree.vaultPath, 'Meetings', 'planning.txt'), 'plain text\n')
  h.deck.store.run('UPDATE meetings SET note_path=? WHERE id=?', 'Meetings/planning.txt', id)
  const refused = await h.request('/api/open', { method: 'POST', body: { kind: 'meetingNote', ref: id } })
  assert.equal(refused.status, 403)
  assert.equal(refused.data.error.code, 'path_not_allowed')
  assert.deepEqual(h.opened, [])
  assert.equal((await h.request(`/api/meetings/${id}/log?lines=1000`)).status, 200)
  const over = await h.request(`/api/meetings/${id}/log?lines=1001`)
  assert.equal(over.status, 422)
  assert.equal(over.data.error.code, 'validation_failed')
})

test('the recorder view in the API is confidential once the stored row is, even when the recorder still says otherwise', { skip: LINUX_ONLY }, async t => {
  const h = await harness(t)
  const recorder = await h.start('pessoal')
  assert.equal(recorder.confidential, false)
  h.deck.store.run('UPDATE meetings SET confidential=1 WHERE id=?', recorder.meetingId)
  assert.equal(h.deck.recorder.view().confidential, false)
  assert.equal((await h.request('/api/meetings')).data.recorder.confidential, true)
})
