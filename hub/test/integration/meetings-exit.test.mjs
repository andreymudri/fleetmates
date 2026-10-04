// M4 Task 16, exit criterion 2 (docs/deck/12-milestones.md section 6): a meeting recorded through the API reaches
// a WebSocket client as it happens, a slow stop holds `stopping` through the polls that say scribed is no longer
// recording, the post-processing states arrive in order with the note path last, a subscription scribed ends is
// gap-filled from `transcript.jsonl`, and the past meetings stay listed while scribed is gone. createDeckServer runs
// in this process over a temporary HOME with the meetings5 tree and the fake scribed in a makeRuntimeDir()
// directory. Every host binary is a logging shim first on this process's PATH and on the server's PATH; the server
// gets no notifier, an injected runCommand and an injected opener, so it starts no child process.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { startDeckServer } from '../../server/main.mjs'
import { startFakeScribed } from '../fakes/fake-scribed.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { meetings5, writeMeetingsTree } from '../helpers/meetings-tree.mjs'

const token = 'x'.repeat(43)
const HOST_BINARIES = ['systemd-run', 'systemctl', 'scribed', 'scribe', 'postmeet', 'xdg-open', 'notify-send', 'makoctl', 'pw-play']

const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mexit-bin-'))
const shimLog = path.join(shimDir, 'argv.jsonl')
for (const name of HOST_BINARIES) {
  fs.writeFileSync(path.join(shimDir, name), `#!${process.execPath}
import fs from 'node:fs'
fs.appendFileSync(${JSON.stringify(shimLog)}, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + '\\n')
`, { mode: 0o700 })
}
process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
process.on('exit', () => fs.rmSync(shimDir, { recursive: true, force: true }))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, ms = 5000, what = 'condition') {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    assert.ok(Date.now() < until, `timed out waiting for ${what}`)
    await sleep(25)
  }
}

/** A transcript event of the fake for meeting `id`. */
const event = (id, t0, text) => ({ t0, t1: t0 + 4, source: 'room', text, lang: 'pt', asr_model: 'medium-int8', session_id: id })

/** Append `events` to `<sessionDir>/<id>/transcript.jsonl` as scribed writes it, creating the directory. */
function appendLive(h, id, events) {
  const dir = path.join(h.tree.sessionDir, id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.appendFileSync(path.join(dir, 'transcript.jsonl'), events.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 })
}

async function harness(t, { fake = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mexit-'))
  const tree = await writeMeetingsTree(home, meetings5)
  const rt = await makeRuntimeDir()
  const scribed = await startFakeScribed({ dir: rt.dir, ...fake })
  const state = path.join(home, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(home, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>deck</h1>')
  const deck = await startDeckServer({
    env: { HOME: home, XDG_RUNTIME_DIR: rt.dir, PATH: process.env.PATH, SHELL: '/bin/sh' },
    port: 0, staticDir, notifications: false, runPollMs: 3_600_000, configDebounceMs: 20,
    connectDeckd: async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
    services: { open: async () => {} }
  })
  t.after(async () => {
    await deck.close()
    await scribed.stop()
    await rt.cleanup()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${deck.address().port}`
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(base + route, {
      method, headers: { Authorization: `Bearer ${token}`, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    return { status: response.status, data: text ? JSON.parse(text) : null }
  }
  const socket = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${deck.address().port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { origin: base })
    const messages = []
    ws.on('message', raw => messages.push({ ...JSON.parse(raw), receivedAt: Date.now() }))
    await new Promise((resolve, reject) => {
      ws.once('error', reject)
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', apiVersion: 1, lastSeq: 0, epoch: null }))
        resolve() })
    })
    t.after(() => ws.close())
    await waitFor(() => messages.some(message => message.t === 'snapshot'), 5000, 'snapshot')
    return messages
  }
  const start = async tag => {
    const started = await request('/api/meetings/start', { method: 'POST', body: { tag } })
    assert.equal(started.status, 202, JSON.stringify(started.data))
    assert.equal(started.data.recorder.state, 'recording')
    const id = started.data.recorder.meetingId
    fs.mkdirSync(path.join(tree.sessionDir, id), { recursive: true, mode: 0o700 })
    await waitFor(() => scribed.connections.some(conn => conn.subscribed && !conn.closed), 5000, 'subscription')
    return id
  }
  return { home, tree, rt, state, fake: scribed, deck, request, socket, start }
}

test('the shims are what a test resolves for every host binary', () => {
  for (const name of HOST_BINARIES) {
    assert.equal(execFileSync('/bin/sh', ['-c', `command -v ${name}`], { env: process.env, encoding: 'utf8' }).trim(), path.join(shimDir, name))
  }
})

test('a recording through the API streams meeting.transcript, a stop answered after 30 s stays stopping, and recorded, transcribed, synthesized arrive in order with the note path last', { timeout: 60_000 }, async t => {
  const h = await harness(t, { fake: { stopDelayMs: 30_000 } })
  const messages = await h.socket()
  const id = await h.start('pessoal')
  h.fake.pushTranscript(event(id, 10, 'primeira linha ao vivo'))
  h.fake.pushTranscript(event(id, 14, 'segunda linha ao vivo'))
  const lines = await waitFor(() => {
    const got = messages.filter(message => message.t === 'meeting.transcript')
    return got.length === 2 ? got : null
  }, 5000, 'meeting.transcript')
  assert.deepEqual(lines.map(message => [message.data.meetingId, message.data.line.text, message.data.ephemeral]),
    [[id, 'primeira linha ao vivo', true], [id, 'segunda linha ao vivo', true]])
  assert.equal(lines.some(message => Object.hasOwn(message, 'seq')), false)

  // Row 13: the fake drops its recording at once and answers the stop 30 s later; every poll in between says
  // `recording: false`, and the recorder stays `stopping` until the answer.
  const stopped = await h.request('/api/meetings/stop', { method: 'POST' })
  assert.equal(stopped.status, 202)
  assert.equal(stopped.data.recorder.state, 'stopping')
  const stopAt = Date.now()
  const pollsBefore = h.fake.received.filter(entry => entry.parsed?.cmd === 'status').length
  while (Date.now() - stopAt < 26_000) {
    const list = await h.request('/api/meetings')
    assert.equal(list.data.recorder.state, 'stopping', `${Date.now() - stopAt} ms after the stop`)
    assert.equal(list.data.recorder.meetingId, id)
    await sleep(1000)
  }
  const pollsBetween = h.fake.received.filter(entry => entry.parsed?.cmd === 'status').length - pollsBefore
  assert.ok(pollsBetween >= 5, `only ${pollsBetween} polls while stopping`)
  assert.equal(h.fake.state.recording, false)
  const idle = await waitFor(async () => {
    const list = await h.request('/api/meetings')
    return list.data.recorder.state === 'idle' ? list : null
  }, 10_000, 'idle after the stop answer')
  assert.ok(Date.now() - stopAt >= 29_000, 'idle before the stop answer')
  assert.equal(idle.data.recorder.meetingId, null)
  const updates = () => messages.filter(message => message.t === 'meeting.updated' && message.data.id === id)
  // The stop's answer is what moves the row to recorded, never a poll before it.
  const recordedAt = updates().find(message => message.data.state === 'recorded')?.receivedAt
  assert.ok(recordedAt && recordedAt - stopAt >= 29_000, 'recorded before the stop answer')

  // Post-processing: each session.json state is reported, in order; the note path arrives with synthesized.
  const dir = path.join(h.tree.sessionDir, id)
  const manifest = state => fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ session_id: id, tag: 'pessoal', state }) + '\n', { mode: 0o600 })
  const date = id.slice(0, 10)
  const note = path.join('Meetings', `${date} pessoal \u2014 revisao do exit.md`)
  for (const state of ['recorded', 'transcribed', 'synthesized']) {
    if (state === 'synthesized') {
      fs.writeFileSync(path.join(h.tree.vaultPath, note), `---\ntags: [meeting, pessoal]\ndate: ${date}\nsession_id: ${id}\n---\n\n# revisao do exit\n\n## Resumo\nUm resumo.\n`, { mode: 0o600 })
    }
    const seen = updates().length
    manifest(state)
    await waitFor(() => updates().slice(seen).some(message => message.data.state === state), 15_000, `meeting.updated ${state}`)
  }
  // Until session.json exists the watch reads the row as stopping, so this run reports recording, stopping,
  // recorded, stopping, recorded, transcribed, synthesized. The stop order in vault-turbid-contract.md has scribed
  // write the manifest before it answers the stop; the second stopping comes from this test writing it afterwards.
  const states = updates().map(message => message.data.state).filter((state, i, all) => state !== all[i - 1])
  assert.deepEqual(states.slice(-3), ['recorded', 'transcribed', 'synthesized'])
  assert.equal(updates().at(-1).data.notePath, note)
  assert.equal(updates().slice(0, -1).some(message => message.data.notePath), false)
})

test('subscribers ended mid-recording: lines appended to transcript.jsonl reach the client with meeting.recovered', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const messages = await h.socket()
  const id = await h.start('pessoal')
  const before = [event(id, 2, 'antes da queda um'), event(id, 6, 'antes da queda dois')]
  appendLive(h, id, before)
  for (const row of before) h.fake.pushTranscript(row)
  await waitFor(() => messages.filter(message => message.t === 'meeting.transcript').length === 2, 5000, 'lines before the gap')
  const subscriptions = h.fake.connections.filter(conn => conn.subscribed).length
  h.fake.endSubscribers()
  appendLive(h, id, [event(id, 10, 'durante a queda um'), event(id, 14, 'durante a queda dois')])
  const recovered = await waitFor(() => messages.find(message => message.t === 'meeting.recovered'), 10_000, 'meeting.recovered')
  assert.deepEqual(recovered.data, { meetingId: id, count: 2, ephemeral: true })
  assert.equal(Object.hasOwn(recovered, 'seq'), false)
  assert.ok(h.fake.connections.filter(conn => conn.subscribed).length > subscriptions, 'no new subscription')
  assert.deepEqual(messages.filter(message => message.t === 'meeting.transcript').map(message => message.data.line.text),
    ['antes da queda um', 'antes da queda dois', 'durante a queda um', 'durante a queda dois'])
  const transcript = await h.request(`/api/meetings/${id}/transcript`)
  assert.equal(transcript.data.source, 'live')
  assert.equal(transcript.data.lines.length, 4)
})

test('with the fake stopped and its socket removed, GET /api/meetings still lists every past meeting and the recorder is unavailable', { timeout: 20_000 }, async t => {
  const h = await harness(t)
  const id = await h.start('pessoal')
  assert.equal((await h.request('/api/meetings/stop', { method: 'POST' })).status, 202)
  await waitFor(async () => (await h.request('/api/meetings')).data.recorder.state === 'idle', 5000, 'idle')
  await h.fake.stop()
  assert.equal(fs.existsSync(h.fake.socketPath), false)
  const list = await waitFor(async () => {
    const got = await h.request('/api/meetings')
    return got.data.recorder.state === 'unavailable' ? got : null
  }, 5000, 'unavailable')
  assert.equal(list.status, 200)
  assert.deepEqual(list.data.meetings.map(row => row.id).sort(), [...h.tree.ids.meetings, id].sort())
  assert.equal(list.data.configError, null)
  assert.equal((await h.request('/api/health')).data.deps.find(dep => dep.dep === 'scribed').state, 'down')
  const past = await h.request(`/api/meetings/${h.tree.ids.planning}`)
  assert.equal(past.status, 200)
  assert.equal(past.data.meeting.state, 'synthesized')
})
