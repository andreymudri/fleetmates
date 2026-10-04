import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createScribedClient } from '../../server/adapters/scribed.mjs'
import { openDeckDb } from '../../server/db/index.mjs'
import { createRecorder, parseTailText } from '../../server/meetings/recorder.mjs'
import { getMeeting } from '../../server/meetings/store.mjs'
import { startFakeScribed } from '../fakes/fake-scribed.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'

// Timers the test advances by hand. Socket I/O stays real, so each step waits for its outcome with `waitFor`.
function fakeClock (start = Date.parse('2026-10-04T13:00:00Z')) {
  let t = start
  let seq = 0
  const pending = new Map()
  const delays = []
  return {
    now: () => t,
    delays,
    timers: {
      setTimeout (fn, ms) {
        const handle = { id: ++seq }
        pending.set(handle, { at: t + ms, fn })
        delays.push(ms)
        return handle
      },
      clearTimeout (handle) { pending.delete(handle) }
    },
    advance (ms) {
      const target = t + ms
      while (true) {
        let next = null
        for (const entry of pending) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry
        if (!next) break
        pending.delete(next[0])
        t = Math.max(t, next[1].at)
        next[1].fn()
      }
      t = target
    }
  }
}

async function waitFor (cond, what = 'condition', ms = 4000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))

const TAGS = [
  { tag: 'pessoal', confidential: false, isDefault: true },
  { tag: 'client-a', confidential: true, isDefault: false },
  { tag: 'client-b', confidential: false, isDefault: false }
]

async function setup (t, { fake: fakeOpts = {}, timeouts = {}, startFake = true } = {}) {
  const rt = await makeRuntimeDir()
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-rec-'))
  const sessionDir = path.join(root, 'meetings')
  await mkdir(sessionDir, { recursive: true, mode: 0o700 })
  const store = openDeckDb(path.join(root, 'private', 'deck.db'))
  const appended = []
  const append = store.appendEvent
  store.appendEvent = event => {
    appended.push(event.type)
    return append.call(store, event)
  }
  const fake = startFake ? await startFakeScribed({ dir: rt.dir, ...fakeOpts }) : null
  const client = createScribedClient({ socketPath: path.join(rt.dir, 'turbidassist.sock'), timeouts })
  const clock = fakeClock()
  const published = []
  const logs = []
  const stopped = []
  const config = { ok: true, path: null, sessionDir, vaultPath: null, meetingsFolder: null, defaultTag: 'pessoal', tags: TAGS, batchModel: null, askVaultMcp: false }
  const recorder = createRecorder({
    client,
    store,
    config: () => config,
    prefs: () => ({ quietInMeetings: true }),
    publish: event => published.push(event),
    onStopped: id => stopped.push(id),
    now: clock.now,
    timers: clock.timers,
    log: entry => logs.push(entry)
  })
  t.after(async () => {
    recorder.close()
    await fake?.stop()
    store.close()
    await rm(root, { recursive: true, force: true })
    await rt.cleanup()
  })
  const statusCount = () => fake.received.filter(r => r.parsed?.cmd === 'status').length
  return {
    fake,
    store,
    clock,
    recorder,
    published,
    appended,
    logs,
    stopped,
    sessionDir,
    statusCount,
    of: type => published.filter(e => e.type === type),
    /** Run the first poll and wait for `idle`. */
    async ready () {
      clock.advance(0)
      await waitFor(() => recorder.view().state === 'idle', 'idle')
    },
    /** Fire the next poll and wait until scribed has answered it and the recorder has applied it. */
    async poll () {
      const before = statusCount()
      clock.advance(2000)
      await waitFor(() => statusCount() > before, 'a status poll')
      await tick(30)
    },
    subscribed: () => fake.connections.some(c => c.subscribed && !c.closed)
  }
}

const otherId = '2026-10-04T09-59-30'
const live = (id, t0, t1, text, source = 'mic') => ({ t0, t1, source, text, lang: 'pt', asr_model: 'medium-int8', session_id: id })

test('row 5: start creates the meeting row and opens the subscription', async t => {
  const h = await setup(t)
  await h.ready()
  assert.equal(h.subscribed(), false)
  const view = await h.recorder.start('pessoal')
  assert.equal(view.state, 'recording')
  const id = h.fake.state.session_id
  assert.equal(view.meetingId, id)
  const row = getMeeting(h.store, id)
  assert.equal(row.state, 'recording')
  assert.equal(row.confidential, false)
  assert.equal(row.startedAt, h.clock.now())
  await waitFor(h.subscribed, 'a subscription')
})

test('row 6: a refused start leaves idle with lastError.message verbatim', async t => {
  const message = 'a sessão anterior ainda está encerrando; tente de novo em instantes'
  const h = await setup(t)
  h.fake.on('start', () => ({ type: 'error', cmd: 'start', message }))
  await h.ready()
  await assert.rejects(h.recorder.start('pessoal'), err => err.code === 'scribed_refused' && err.details.text === message)
  const view = h.recorder.view()
  assert.equal(view.state, 'idle')
  assert.equal(view.lastError.message, message)
  assert.equal(view.lastError.cmd, 'start')
  assert.equal(h.of('meeting.status').at(-1).data.lastError.message, message)
})

test('row 7: a start timeout gives idle, then a poll with recording true gives recording', async t => {
  const h = await setup(t, { timeouts: { start: 150 } })
  h.fake.on('start', () => null)
  await h.ready()
  const view = await h.recorder.start('pessoal')
  assert.equal(view.state, 'idle')
  h.fake.setStatus({ recording: true, session_id: otherId, tag: 'pessoal', elapsed_s: 4 })
  await h.poll()
  assert.equal(h.recorder.view().state, 'recording')
  assert.equal(h.recorder.view().meetingId, otherId)
})

test('row 13: while the stop is in flight a poll with recording false is ignored', async t => {
  const h = await setup(t, { fake: { stopDelayMs: 700 } })
  await h.ready()
  await h.recorder.start('pessoal')
  const id = h.recorder.view().meetingId
  assert.equal(h.recorder.stop().state, 'stopping')
  assert.equal(getMeeting(h.store, id).state, 'stopping')
  await waitFor(() => h.fake.state.recording === false, 'scribed to receive the stop')
  await h.poll()
  assert.equal(h.recorder.view().state, 'stopping')
  assert.deepEqual(h.stopped, [])
  await waitFor(() => h.recorder.view().state === 'idle', 'the stop answer')
  assert.equal(getMeeting(h.store, id).state, 'recorded')
  assert.deepEqual(h.stopped, [id])
})

test('slow becomes true after 60 s of stop', async t => {
  const h = await setup(t)
  h.fake.on('stop', () => null)
  await h.ready()
  await h.recorder.start('pessoal')
  h.recorder.stop()
  assert.equal(h.recorder.view().slow, false)
  h.clock.advance(59000)
  assert.equal(h.recorder.view().slow, false)
  h.clock.advance(1000)
  assert.equal(h.recorder.view().slow, true)
  assert.equal(h.of('meeting.status').at(-1).data.slow, true)
})

test('row 11: another client\'s start gives recording and quiet within one poll', async t => {
  const h = await setup(t)
  await h.ready()
  h.fake.setStatus({ recording: true, session_id: otherId, tag: 'client-a', elapsed_s: 30, routed_apps: ['Zoom'] })
  await h.poll()
  const view = h.recorder.view()
  assert.equal(view.state, 'recording')
  assert.equal(view.quiet, true)
  assert.equal(h.recorder.isRecording(), true)
  assert.equal(view.startedAt, h.clock.now() - 30000)
  const row = getMeeting(h.store, otherId)
  assert.equal(row.state, 'recording')
  assert.equal(row.confidential, true)
  assert.deepEqual(row.apps, ['Zoom'])
  await waitFor(h.subscribed, 'a subscription')
})

test('row 12: another client\'s stop sets the row stopping and calls onStopped', async t => {
  const h = await setup(t)
  await h.ready()
  h.fake.setStatus({ recording: true, session_id: otherId, tag: 'pessoal', elapsed_s: 30 })
  await h.poll()
  assert.equal(h.recorder.isRecording(), true)
  h.fake.setStatus({ recording: false, session_id: null, tag: null, elapsed_s: 0 })
  await h.poll()
  assert.equal(h.recorder.view().state, 'idle')
  assert.equal(h.recorder.view().quiet, false)
  assert.equal(getMeeting(h.store, otherId).state, 'stopping')
  assert.deepEqual(h.stopped, [otherId])
})

test('row 14: a changed session_id closes the old meeting and joins the new one', async t => {
  const next = '2026-10-04T10-05-00'
  const h = await setup(t)
  await h.ready()
  h.fake.setStatus({ recording: true, session_id: otherId, tag: 'pessoal', elapsed_s: 30 })
  await h.poll()
  h.fake.setStatus({ recording: true, session_id: next, tag: 'client-b', elapsed_s: 2 })
  await h.poll()
  assert.equal(h.recorder.view().state, 'recording')
  assert.equal(h.recorder.view().meetingId, next)
  assert.equal(h.recorder.view().tag, 'client-b')
  assert.equal(getMeeting(h.store, otherId).state, 'stopping')
  assert.equal(getMeeting(h.store, next).state, 'recording')
  assert.deepEqual(h.stopped, [otherId])
})

test('row 2: scribed gone mid-recording gives unavailable, lost and isRecording false', async t => {
  const h = await setup(t)
  await h.ready()
  await h.recorder.start('pessoal')
  assert.equal(h.recorder.isRecording(), true)
  await h.fake.stop()
  h.clock.advance(2000)
  await waitFor(() => h.recorder.health().state === 'down', 'health down')
  const view = h.recorder.view()
  assert.equal(view.state, 'unavailable')
  assert.equal(view.lost, true)
  assert.equal(view.quiet, false)
  assert.equal(h.recorder.isRecording(), false)
  assert.equal(h.of('health.changed').at(-1).data.state, 'down')
})

test('row 15: a transcript event of another session is dropped', async t => {
  const h = await setup(t)
  await h.ready()
  await h.recorder.start('pessoal')
  const id = h.recorder.view().meetingId
  await waitFor(h.subscribed, 'a subscription')
  h.fake.pushTranscript(live('2026-01-01T00-00-00', 1, 2, 'de outra sessão'))
  h.fake.pushTranscript(live(id, 3, 4, 'desta sessão', 'room'))
  await waitFor(() => h.of('meeting.transcript').length > 0, 'a transcript event')
  await tick(30)
  const lines = h.of('meeting.transcript')
  assert.equal(lines.length, 1)
  assert.deepEqual(lines[0].data, { meetingId: id, line: { t0: 3, t1: 4, speaker: 'Sala', text: 'desta sessão' }, ephemeral: true })
  assert.deepEqual(h.recorder.ring(id), [{ t0: 3, t1: 4, speaker: 'Sala', text: 'desta sessão' }])
})

async function recordWithOneLine (h, tag, text) {
  await h.ready()
  await h.recorder.start(tag)
  const id = h.recorder.view().meetingId
  await waitFor(h.subscribed, 'a subscription')
  const first = live(id, 0, 5, text)
  h.fake.pushTranscript(first)
  await waitFor(() => h.of('meeting.transcript').length === 1, 'the first line')
  const dir = path.join(h.sessionDir, id)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return { id, dir, first }
}

test('row 16: after the subscription ends, the reconnect publishes the 3 missed lines and meeting.recovered 3', async t => {
  const h = await setup(t)
  const { id, dir, first } = await recordWithOneLine(h, 'pessoal', 'antes')
  await writeFile(path.join(dir, 'transcript.jsonl'), JSON.stringify(first) + '\n', { mode: 0o600 })
  h.fake.endSubscribers()
  await waitFor(() => h.logs.some(e => e.event === 'recorder.subscribe_closed'), 'the subscription to close')
  const missed = [live(id, 5, 6, 'um'), live(id, 6, 7, 'dois', 'room'), live(id, 7, 8, 'três')]
  await appendFile(path.join(dir, 'transcript.jsonl'), missed.map(e => JSON.stringify(e)).join('\n') + '\n')
  h.clock.advance(2000)
  await waitFor(() => h.of('meeting.recovered').length === 1, 'meeting.recovered')
  assert.deepEqual(h.of('meeting.transcript').slice(1).map(e => e.data.line.text), ['um', 'dois', 'três'])
  assert.deepEqual(h.of('meeting.recovered')[0].data, { meetingId: id, count: 3, ephemeral: true })
  assert.equal(h.recorder.ring(id).length, 4)
})

test('row 16: when transcript.jsonl cannot be read, tail fills the gap with the minutes rounded up', async t => {
  const h = await setup(t, { fake: { tailText: '[00:04] Você: antes\n[00:06] Você: um\n[01:02] Sala: dois\n' } })
  const { id, dir } = await recordWithOneLine(h, 'pessoal', 'antes')
  const outside = path.join(h.sessionDir, 'outside.jsonl')
  await writeFile(outside, '', { mode: 0o600 })
  await symlink(outside, path.join(dir, 'transcript.jsonl'))
  h.fake.endSubscribers()
  await waitFor(() => h.logs.some(e => e.event === 'recorder.subscribe_closed'), 'the subscription to close')
  h.clock.advance(2000)
  await waitFor(() => h.of('meeting.recovered').length === 1, 'meeting.recovered')
  const tail = h.fake.received.filter(r => r.parsed?.cmd === 'tail')
  assert.deepEqual(tail.map(r => r.parsed), [{ cmd: 'tail', minutes: 1 }])
  assert.deepEqual(h.of('meeting.transcript').slice(1).map(e => e.data.line), [
    { t0: 6, t1: 62, speaker: 'Você', text: 'um' },
    { t0: 62, t1: 62, speaker: 'Sala', text: 'dois' }
  ])
  assert.equal(h.of('meeting.recovered')[0].data.count, 2)
})

test('parseTailText reads total minutes and skips other lines', () => {
  assert.deepEqual(parseTailText('[62:05] Sala: oi\nlixo\n[00:61] Você: x\n[62:07] Você: tudo: bem\n'), [
    { t0: 3725, t1: 3727, speaker: 'Sala', text: 'oi' },
    { t0: 3727, t1: 3727, speaker: 'Você', text: 'tudo: bem' }
  ])
})

test('while scribed is down the probe backs off 2, 4, 8 s', async t => {
  const h = await setup(t, { startFake: false })
  h.clock.advance(0)
  await waitFor(() => h.recorder.health().attempt === 1, 'attempt 1')
  h.clock.advance(2000)
  await waitFor(() => h.recorder.health().attempt === 2, 'attempt 2')
  h.clock.advance(4000)
  await waitFor(() => h.recorder.health().attempt === 3, 'attempt 3')
  await waitFor(() => h.clock.delays.length === 4, 'the fourth timer')
  assert.deepEqual(h.clock.delays, [0, 2000, 4000, 8000])
  assert.equal(h.recorder.health().state, 'down')
  assert.equal(h.recorder.health().nextProbeAt, h.clock.now() + 8000)
  assert.equal(h.of('health.changed').length, 1)
  assert.equal(h.recorder.view().state, 'unavailable')
})

test('a status timeout makes the health degraded, and two answers make it ok again', async t => {
  const h = await setup(t, { timeouts: { status: 100 } })
  await h.ready()
  assert.equal(h.recorder.health().state, 'ok')
  h.fake.on('status', () => null)
  h.clock.advance(2000)
  await waitFor(() => h.recorder.health().state === 'degraded', 'degraded')
  h.fake.on('status', null)
  await h.poll()
  assert.equal(h.recorder.health().state, 'degraded')
  await h.poll()
  assert.equal(h.recorder.health().state, 'ok')
  assert.deepEqual(h.of('health.changed').map(e => e.data.state), ['ok', 'degraded', 'ok'])
})

test('ten polls that change only elapsed_s append no meeting.status', async t => {
  const h = await setup(t)
  await h.ready()
  await h.recorder.start('pessoal')
  await h.poll()
  const before = h.appended.filter(type => type === 'meeting.status').length
  for (let i = 1; i <= 10; i++) {
    h.fake.setStatus({ elapsed_s: i * 2 })
    await h.poll()
    assert.equal(h.recorder.view().elapsedS, i * 2)
  }
  assert.equal(h.appended.filter(type => type === 'meeting.status').length, before)
})

test('meeting.transcript never reaches store.appendEvent and carries no seq', async t => {
  const h = await setup(t)
  await h.ready()
  await h.recorder.start('pessoal')
  const id = h.recorder.view().meetingId
  await waitFor(h.subscribed, 'a subscription')
  h.fake.pushTranscript(live(id, 1, 2, 'olá'))
  await waitFor(() => h.of('meeting.transcript').length === 1, 'a transcript event')
  assert.equal(h.appended.includes('meeting.transcript'), false)
  assert.equal(h.of('meeting.transcript')[0].seq, undefined)
  assert.equal(h.of('meeting.transcript')[0].data.ephemeral, true)
})

test('the log calls of a confidential meeting hold no transcript text', async t => {
  const sentinel = 'SENTINEL-confidencial-7f3a'
  const h = await setup(t)
  const { id, dir, first } = await recordWithOneLine(h, 'client-a', `${sentinel} ao vivo`)
  assert.equal(h.recorder.view().confidential, true)
  await writeFile(path.join(dir, 'transcript.jsonl'), JSON.stringify(first) + '\n', { mode: 0o600 })
  h.fake.endSubscribers()
  await waitFor(() => h.logs.some(e => e.event === 'recorder.subscribe_closed'), 'the subscription to close')
  await appendFile(path.join(dir, 'transcript.jsonl'), JSON.stringify(live(id, 5, 6, `${sentinel} perdida`)) + '\n')
  h.clock.advance(2000)
  await waitFor(() => h.of('meeting.recovered').length === 1, 'meeting.recovered')
  h.fake.pushTranscript(live('2026-01-01T00-00-00', 9, 10, `${sentinel} de outra`))
  h.fake.pushTranscript(live(id, 9, 10, `${sentinel} depois`))
  await waitFor(() => h.of('meeting.transcript').length === 3, 'the last line')
  assert.ok(h.logs.some(e => e.event === 'recorder.gap_filled'))
  assert.ok(h.logs.some(e => e.event === 'recorder.transcript_dropped'))
  assert.equal(JSON.stringify(h.logs).includes(sentinel), false)
})

test('an unknown tag throws unknown_tag and sends nothing to scribed', async t => {
  const h = await setup(t)
  await h.ready()
  await assert.rejects(h.recorder.start('acme'), err => err.code === 'unknown_tag' && err.status === 422)
  assert.equal(h.fake.received.some(r => r.parsed?.cmd === 'start'), false)
  assert.equal(h.recorder.view().state, 'idle')
})
