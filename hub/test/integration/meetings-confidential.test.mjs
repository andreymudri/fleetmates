// M4 Task 16, exit criterion 3 (docs/deck/12-milestones.md section 6; 06-storage 10.1, 08-security 4.12): a meeting
// recorded, pinned, asked, searched and read through the API, then post-processed, and a hook spooled from inside
// session_dir, leave no meeting text behind. The server runs as a child process (`node hub/server/main.mjs` by
// absolute path) over a temporary HOME with the meetings5 tree; its stdout and stderr are its logs. The fake scribed
// runs in this process, in a makeRuntimeDir() directory. The child's environment is built from nothing: HOME,
// XDG_RUNTIME_DIR, DECK_PORT, SHIM_LOG and a PATH holding only the logging shims, so no session bus, display or
// token of this process reaches it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { startFakeScribed } from '../fakes/fake-scribed.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { meetings5, writeMeetingsTree } from '../helpers/meetings-tree.mjs'

const token = 'c'.repeat(43)
const serverMain = fileURLToPath(new URL('../../server/main.mjs', import.meta.url))
const deckHook = fileURLToPath(new URL('../../hook/deck-hook.mjs', import.meta.url))
const hookFixture = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))
const HOST_BINARIES = ['systemd-run', 'systemctl', 'scribed', 'scribe', 'postmeet', 'xdg-open', 'notify-send', 'makoctl', 'pw-play', 'claude']

const SENTINEL = Object.freeze({
  pinA: 'SENTINEL-T16-PIN-A',
  pinB: 'SENTINEL-T16-PIN-B',
  line: 'SENTINEL-T16-LINE',
  late: 'SENTINEL-T16-LATE',
  ask: 'SENTINEL-T16-ASK',
  answer: 'SENTINEL-T16-ANSWER',
  log: 'SENTINEL-T16-LOG',
  note: 'SENTINEL-T16-NOTE',
  title: 'SENTINEL-T16-TITLE',
  hook: 'SENTINEL-T16-HOOK'
})

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

/** Logging shims for every host binary in `dir`; each appends its name and argv to `log`. */
function writeShims(dir, log) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const name of HOST_BINARIES) {
    fs.writeFileSync(path.join(dir, name), `#!${process.execPath}
import fs from 'node:fs'
for await (const chunk of process.stdin) {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + '\\n')
process.stdout.write('42\\n')
`, { mode: 0o700 })
  }
}

async function freePort() {
  const reservation = http.createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const { port } = reservation.address()
  await new Promise(resolve => reservation.close(resolve))
  return port
}

/** Every regular file under `dir`, recursively. */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name))
}

/**
 * One temporary HOME with the meetings5 tree, the fake scribed and a child-process server that can be stopped and
 * started again over the same HOME.
 */
async function harness(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mconf-'))
  const tree = await writeMeetingsTree(home, meetings5)
  const rt = await makeRuntimeDir()
  const fake = await startFakeScribed({ dir: rt.dir, askDeltas: ['O prazo ', `é quarta ${SENTINEL.answer}.`] })
  const state = path.join(home, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const shimDir = path.join(home, 'bin')
  const shimLog = path.join(home, 'shim-argv.jsonl')
  writeShims(shimDir, shimLog)
  const env = { HOME: home, XDG_RUNTIME_DIR: rt.dir, PATH: shimDir, SHIM_LOG: shimLog }
  const logs = []
  let child = null
  let port = null
  const h = {
    home, tree, rt, fake, state, env, shimDir, shimLog, logs,
    get port() { return port },
    async start() {
      port = await freePort()
      const out = []
      logs.push(out)
      child = spawn(process.execPath, [serverMain], { env: { ...env, DECK_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', chunk => out.push(chunk))
      child.stderr.on('data', chunk => out.push(chunk))
      let ready = false
      for (let i = 0; i < 200 && !ready; i++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`, { headers: h.headers() })).ok } catch {}
        if (!ready) await sleep(25)
      }
      assert.equal(ready, true, Buffer.concat(out).toString('utf8'))
    },
    async stop() {
      if (!child) return
      const current = child
      child = null
      if (current.exitCode === null && current.signalCode === null) {
        const closing = once(current, 'close')
        current.kill('SIGTERM')
        const timeout = setTimeout(() => current.kill('SIGKILL'), 3000)
        await closing
        clearTimeout(timeout)
      }
    },
    headers: () => ({ Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${port}` }),
    async request(route, { method = 'GET', body } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method, headers: { ...h.headers(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      const text = await response.text()
      return { status: response.status, data: text ? JSON.parse(text) : null }
    },
    async socket() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { origin: `http://127.0.0.1:${port}` })
      const messages = []
      ws.on('message', raw => messages.push(JSON.parse(raw)))
      await new Promise((resolve, reject) => {
        ws.once('error', reject)
        ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', apiVersion: 1, lastSeq: 0, epoch: null }))
          resolve() })
      })
      await waitFor(() => messages.some(message => message.t === 'snapshot'), 5000, 'snapshot')
      return { ws, messages }
    },
    /** The captured stdout and stderr of every server run so far. */
    logBytes: () => Buffer.concat(logs.flat())
  }
  t.after(async () => {
    await h.stop()
    await fake.stop()
    await rt.cleanup()
    fs.rmSync(home, { recursive: true, force: true })
  })
  return h
}

/** Which of `sentinels` each of `sources` ({ name: bytes }) holds. */
function hits(sources, sentinels) {
  const found = []
  for (const [name, bytes] of Object.entries(sources)) {
    for (const sentinel of sentinels) if (bytes.includes(sentinel)) found.push(`${sentinel} in ${name}`)
  }
  return found
}

/** The bytes of deck.db and deck.db-wal as they are now, without opening the database. */
function dbBytes(h, label) {
  const db = path.join(h.state, 'deck.db')
  const out = {}
  for (const name of [db, `${db}-wal`]) out[`${path.basename(name)} (${label})`] = fs.existsSync(name) ? fs.readFileSync(name) : Buffer.alloc(0)
  return out
}

/**
 * Record a `tag` meeting with the sentinels in its transcript, pin twice, ask once, search, read the transcript and
 * the log, stop, let the post watch see synthesized, spool a hook from inside session_dir, and let a restarted
 * server drain it. Returns the scanned sources and the pin labels the API answered.
 */
async function recordAndScan(t, tag) {
  const h = await harness(t)
  const childPath = execFileSync('/bin/sh', ['-c', 'command -v systemd-run; command -v notify-send; command -v pw-play'], { env: h.env, encoding: 'utf8' })
  assert.deepEqual(childPath.trim().split('\n'), ['systemd-run', 'notify-send', 'pw-play'].map(name => path.join(h.shimDir, name)))
  await h.start()
  const { messages } = await h.socket()

  const started = await h.request('/api/meetings/start', { method: 'POST', body: { tag } })
  assert.equal(started.status, 202, JSON.stringify(started.data))
  const id = started.data.recorder.meetingId
  assert.equal(started.data.recorder.confidential, tag === 'client-a')
  const dir = path.join(h.tree.sessionDir, id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  await waitFor(() => h.fake.connections.some(conn => conn.subscribed && !conn.closed), 5000, 'subscription')
  const events = [[10, `primeira fala ${SENTINEL.pinA}`], [20, `segunda fala ${SENTINEL.pinB}`], [30, `terceira fala ${SENTINEL.line}`]]
    .map(([t0, text]) => ({ t0, t1: t0 + 4, source: 'room', text, lang: 'pt', asr_model: 'medium-int8', session_id: id }))
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), events.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'postmeet.log'), `postmeet run ${id}\nlinha do log ${SENTINEL.log}\n`, { mode: 0o600 })
  for (const row of events) h.fake.pushTranscript(row)
  await waitFor(() => messages.filter(message => message.t === 'meeting.transcript').length === 3, 5000, 'meeting.transcript')
  assert.ok(JSON.stringify(messages).includes(SENTINEL.line), 'the transcript events carry the sentinels')

  const first = await h.request(`/api/meetings/${id}/pins`, { method: 'POST', body: { t: 10 } })
  const second = await h.request(`/api/meetings/${id}/pins`, { method: 'POST', body: { t: 20 } })
  assert.deepEqual([first.status, second.status], [201, 201])
  // The labels the API answered are checked after the scan, so a stored label shows up as its byte hits first.
  const labels = [first.data.pin.label, second.data.pin.label]
  const expectedLabels = tag === 'client-a' ? [null, null] : [events[0].text, events[1].text]

  const asked = await h.request('/api/ask', { method: 'POST', body: { text: `qual o prazo ${SENTINEL.ask}?`, scope: `meeting:${id}` } })
  assert.equal(asked.status, 202, JSON.stringify(asked.data))
  const done = await waitFor(() => messages.find(message => message.t === 'ask.done'), 5000, 'ask.done')
  assert.match(done.data.message.text, new RegExp(SENTINEL.answer))
  assert.ok(h.fake.received.some(entry => entry.parsed?.cmd === 'ask' && JSON.stringify(entry.parsed).includes(SENTINEL.ask)))

  const search = await h.request(`/api/meetings/search?q=${SENTINEL.line}`)
  assert.equal(search.status, 200)
  assert.deepEqual(search.data.hits.map(hit => hit.meetingId), [id])
  const transcript = await h.request(`/api/meetings/${id}/transcript`)
  assert.equal(transcript.status, 200)
  assert.equal(transcript.data.lines.length, 3)
  const log = await h.request(`/api/meetings/${id}/log`)
  assert.equal(log.status, 200)
  assert.match(log.data.text, new RegExp(SENTINEL.log))

  assert.equal((await h.request('/api/meetings/stop', { method: 'POST' })).status, 202)
  await waitFor(async () => (await h.request('/api/meetings')).data.recorder.state === 'idle', 5000, 'idle')
  const date = id.slice(0, 10)
  const title = tag === 'client-a' ? `revisao ${SENTINEL.title}` : 'revisao semanal'
  fs.writeFileSync(path.join(h.tree.vaultPath, 'Meetings', `${date} ${tag} \u2014 ${title}.md`),
    `---\ntags: [meeting, ${tag}]\ndate: ${date}\nsession_id: ${id}\n---\n\n# ${title}\n\n## Resumo\nResumo ${SENTINEL.note}.\n\n## Action items\n- [ ] revisar ${SENTINEL.note}\n`, { mode: 0o600 })
  const late = { t0: 40, t1: 44, speaker: 'Você', text: `fala do lote ${SENTINEL.late}` }
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify([...events.map(row => ({ t0: row.t0, t1: row.t1, speaker: 'SPEAKER_00', text: row.text })), late]), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ session_id: id, tag, state: 'synthesized' }) + '\n', { mode: 0o600 })
  const listed = await waitFor(async () => {
    const list = await h.request('/api/meetings')
    const row = list.data.meetings.find(meeting => meeting.id === id)
    return row?.state === 'synthesized' ? row : null
  }, 15_000, 'synthesized')
  assert.equal(listed.title, title)
  assert.equal(listed.confidential, tag === 'client-a')
  assert.equal((await h.request(`/api/meetings/${id}/transcript`)).data.lines.at(-1).text, late.text)

  // The meeting's own bytes, before the server stops and before any checkpoint.
  const sources = { ...dbBytes(h, 'after the meeting') }

  // A hook from a process inside session_dir, spooled while the hook socket is down, then drained by the next
  // server start; a SessionStart from outside session_dir in the same spool shows the drain ran.
  await h.stop()
  const hook = (cwd, sessionId, event, extra = {}) => execFileSync(process.execPath, [deckHook], {
    env: h.env, input: JSON.stringify({ ...hookFixture, cwd, session_id: sessionId, hook_event_name: event, ...extra })
  })
  hook(dir, 'inside-session-dir', 'SessionStart')
  hook(dir, 'inside-session-dir', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: `grep ${SENTINEL.hook} transcript.jsonl` } })
  hook(h.home, 'outside-session-dir', 'SessionStart')
  const spool = path.join(h.state, 'spool')
  const spooled = filesUnder(spool)
  assert.equal(spooled.length, 3, 'the deck-hook spooled each envelope')
  assert.ok(spooled.some(file => fs.readFileSync(file).includes(SENTINEL.hook)), 'the spool held the hook sentinel before the drain')
  await h.start()
  assert.deepEqual(filesUnder(spool), [], 'the server drained the spool')
  const drained = (await h.request('/api/sessions')).data.sessions.map(session => session.claudeSessionId)

  Object.assign(sources, dbBytes(h, 'after the drain'))
  for (const file of filesUnder(spool)) sources[`spool ${path.basename(file)}`] = fs.readFileSync(file)
  await h.stop()
  Object.assign(sources, dbBytes(h, 'after the server stopped'))
  sources['server logs'] = h.logBytes()
  sources['notify argv'] = fs.existsSync(h.shimLog) ? fs.readFileSync(h.shimLog) : Buffer.alloc(0)
  // The API answers are checked after the byte scan, so a leak shows up as its hits first.
  const answers = () => {
    assert.deepEqual(labels, expectedLabels)
    assert.deepEqual(drained, ['outside-session-dir'], 'only the hook from outside session_dir made a session')
  }
  return { sources, answers }
}

test('client-a: a recorded, pinned, asked, searched, read and synthesized meeting and a spooled hook leave zero sentinel hits', { timeout: 60_000 }, async t => {
  const { sources, answers } = await recordAndScan(t, 'client-a')
  assert.deepEqual(hits(sources, Object.values(SENTINEL)), [])
  answers()
})

test('pessoal: the same leaves zero sentinel hits except the pin labels in deck.db', { timeout: 60_000 }, async t => {
  const { sources, answers } = await recordAndScan(t, 'pessoal')
  const pins = [SENTINEL.pinA, SENTINEL.pinB]
  const found = hits(sources, Object.values(SENTINEL))
  assert.deepEqual(found.filter(hit => !pins.some(pin => hit.startsWith(`${pin} in deck.db`))), [])
  for (const pin of pins) assert.ok(found.some(hit => hit.startsWith(`${pin} in deck.db`)), `${pin} is stored as a pin label`)
  answers()
})
