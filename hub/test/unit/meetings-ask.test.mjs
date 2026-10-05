import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMeetingAsk } from '../../server/meetings/ask.mjs'
import { createScribedClient } from '../../server/adapters/scribed.mjs'
import { startFakeScribed } from '../fakes/fake-scribed.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'

const MEETING = '2026-10-04T10-00-00'
const QUESTION_SENTINEL = 'PERGUNTA-SENTINELA-7731'
const ANSWER_SENTINEL = 'RESPOSTA-SENTINELA-4419'

/**
 * A fake scribed recording `MEETING`, a real client on its socket and a meeting ask whose events and log
 * entries are collected.
 * @param {Parameters<typeof startFakeScribed>[0] extends infer O ? Omit<O, 'dir'> : never} fakeOpts
 * @param {(ctx: any) => Promise<void>} fn
 * @param {{ view?: object, store?: object }} [extra]
 */
async function withAsk (fakeOpts, fn, extra = {}) {
  const rt = await makeRuntimeDir()
  const fake = await startFakeScribed({ dir: rt.dir, ...fakeOpts })
  fake.setStatus({ recording: true, session_id: MEETING, tag: 'acme', startedAt: Date.now() })
  const client = createScribedClient({ socketPath: fake.socketPath })
  const view = { state: 'recording', meetingId: MEETING, ...extra.view }
  /** @type {any[]} */
  const events = []
  /** @type {any[]} */
  const logs = []
  let n = 0
  const ask = createMeetingAsk({
    client,
    recorder: { view: () => view },
    publish: (event) => events.push(event),
    now: () => 1000,
    newId: () => `id-${++n}`,
    log: (entry) => logs.push(entry),
    // Not a parameter of createMeetingAsk: main.mjs has a store at hand, and this one fails the test if used.
    ...(extra.store ? { store: extra.store } : {})
  })
  try {
    await fn({ fake, ask, events, logs, view })
  } finally {
    ask.close()
    await fake.stop()
    await rt.cleanup()
  }
}

/**
 * Wait until `pred()` holds, polling every 5 ms, failing after `ms`.
 * @param {() => boolean} pred
 * @param {number} [ms]
 */
async function until (pred, ms = 3000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Answer events written one line at a time, `gap` ms apart. */
function spaced (/** @type {object[]} */ lines, gap = 20) {
  const sizes = lines.map((l) => Buffer.byteLength(JSON.stringify(l) + '\n'))
  const splitAt = sizes.slice(0, -1).map((_, i) => sizes.slice(0, i + 1).reduce((a, b) => a + b, 0))
  return { events: lines, splitAt, chunkDelayMs: gap }
}

test('ask returns the transient thread at once, publishes deltas in order, then ask.done with the joined text', async () => {
  await withAsk({}, async ({ fake, ask, events }) => {
    fake.on('ask', () => spaced([
      { type: 'ask_delta', text: 'Esse ' },
      { type: 'ask_delta', text: 'erro ' },
      { type: 'ask_delta', text: 'é de lock.' },
      { type: 'ask_done' }
    ]))
    const result = ask.ask(MEETING, 'Qual erro?')
    assert.deepEqual(result, {
      thread: { id: 'id-1', title: 'Qual erro?', scope: `meeting:${MEETING}`, createdAt: 1000, persisted: false },
      userMessage: { id: 'id-2', role: 'user', text: 'Qual erro?', persisted: false },
      assistantMessageId: 'id-3'
    })
    await until(() => events.some((e) => e.type === 'ask.done'))
    assert.deepEqual(events.map((e) => e.type), ['ask.delta', 'ask.delta', 'ask.delta', 'ask.done'])
    assert.deepEqual(events.slice(0, 3).map((e) => e.data), [
      { threadId: 'id-1', messageId: 'id-3', text: 'Esse ', ephemeral: true },
      { threadId: 'id-1', messageId: 'id-3', text: 'erro ', ephemeral: true },
      { threadId: 'id-1', messageId: 'id-3', text: 'é de lock.', ephemeral: true }
    ])
    assert.deepEqual(events[3].data, {
      threadId: 'id-1',
      message: { id: 'id-3', role: 'assistant', text: 'Esse erro é de lock.', citations: [], persisted: false },
      ephemeral: true
    })
    assert.ok(events.every((e) => e.seq === undefined))
    assert.deepEqual(fake.received.map((r) => r.parsed), [{ cmd: 'ask', question: 'Qual erro?' }])
  })
})

test('an error after deltas publishes ask.error with scribed\'s message verbatim', async () => {
  const message = 'claude -p falhou: tempo esgotado após 120 s'
  await withAsk({ askDeltas: ['parcial '], askError: message }, async ({ ask, events }) => {
    ask.ask(MEETING, 'Pergunta?')
    await until(() => events.some((e) => e.type === 'ask.error'))
    assert.deepEqual(events.map((e) => e.type), ['ask.delta', 'ask.error'])
    assert.deepEqual(events[1].data, {
      threadId: 'id-1',
      messageId: 'id-3',
      error: { code: 'scribed_refused', message: 'scribed_refused', retryable: false, details: { text: message } },
      ephemeral: true
    })
  })
})

test('a second ask for the meeting while the first is in flight is ask_in_progress', async () => {
  await withAsk({}, async ({ fake, ask, events }) => {
    fake.on('ask', () => ({ delayMs: 200, events: [{ type: 'ask_delta', text: 'ok' }, { type: 'ask_done' }] }))
    ask.ask(MEETING, 'Primeira?')
    assert.throws(() => ask.ask(MEETING, 'Segunda?'), (err) => err.status === 409 && err.code === 'ask_in_progress')
    await until(() => events.some((e) => e.type === 'ask.done'))
    assert.equal(ask.ask(MEETING, 'Terceira?').assistantMessageId, 'id-6')
    await until(() => events.filter((e) => e.type === 'ask.done').length === 2)
  })
})

test('an ask for a meeting that is not recording is not_recording and sends nothing', async () => {
  await withAsk({}, async ({ fake, ask, view }) => {
    assert.throws(() => ask.ask('2026-10-03T09-00-00', 'Pergunta?'), (err) => err.status === 409 && err.code === 'not_recording')
    view.state = 'stopping'
    assert.throws(() => ask.ask(MEETING, 'Pergunta?'), (err) => err.status === 409 && err.code === 'not_recording')
    await sleep(30)
    assert.deepEqual(fake.received, [])
  })
})

test('scribed unreachable is scribed_unavailable, before the ask or as ask.error after it', async () => {
  await withAsk({}, async ({ fake, ask, events, view }) => {
    view.state = 'unavailable'
    assert.throws(() => ask.ask(MEETING, 'Pergunta?'), (err) => err.status === 503 && err.code === 'scribed_unavailable')
    view.state = 'recording'
    await fake.stop()
    ask.ask(MEETING, 'Pergunta?')
    await until(() => events.some((e) => e.type === 'ask.error'))
    assert.deepEqual(events.map((e) => [e.type, e.data.error.code, e.data.error.retryable]), [['ask.error', 'scribed_unavailable', true]])
  })
})

test('after stop no further delta is published while the fake keeps sending', async () => {
  await withAsk({}, async ({ fake, ask, events }) => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ type: 'ask_delta', text: `d${i} ` }))
    fake.on('ask', () => spaced([...lines, { type: 'ask_done' }], 25))
    const { assistantMessageId } = ask.ask(MEETING, 'Pergunta?')
    await until(() => events.length >= 2)
    ask.stop(assistantMessageId)
    const seen = events.length
    await sleep(400)
    assert.equal(events.length, seen)
    assert.ok(seen < 20)
    assert.throws(() => ask.stop(assistantMessageId), (err) => err.status === 409 && err.code === 'invalid_state')
    assert.throws(() => ask.stop('nope'), (err) => err.status === 404 && err.code === 'not_found')
  })
})

test('nothing reaches the store: a store whose appendEvent throws is never called', async () => {
  let calls = 0
  const store = { appendEvent () { calls++; throw new Error('ask events must not be stored') } }
  await withAsk({}, async ({ ask, events }) => {
    ask.ask(MEETING, 'Pergunta?')
    await until(() => events.some((e) => e.type === 'ask.done'))
    assert.equal(calls, 0)
    assert.ok(events.every((e) => e.data.ephemeral === true))
  }, { store })
})

test('log calls hold ids and lengths, never the question or the answer', async () => {
  await withAsk({ askDeltas: [`a ${ANSWER_SENTINEL}`] }, async ({ ask, events, logs }) => {
    ask.ask(MEETING, `q ${QUESTION_SENTINEL}`)
    await until(() => events.some((e) => e.type === 'ask.done'))
    assert.ok(logs.length >= 2)
    const text = JSON.stringify(logs)
    assert.ok(!text.includes(QUESTION_SENTINEL), 'question leaked into the log')
    assert.ok(!text.includes(ANSWER_SENTINEL), 'answer leaked into the log')
    assert.ok(logs.some((l) => l.event === 'ask.done' && l.length === `a ${ANSWER_SENTINEL}`.length))
  })
})

test('history returns scribed history asks as { t, question, answer } for the recording meeting only', async () => {
  await withAsk({}, async ({ fake, ask }) => {
    fake.setStatus({ asks: [{ t: 12.5, question: 'Quem?', answer: 'A equipe.', context_minutes: 5 }] })
    assert.deepEqual(await ask.history(MEETING), [{ t: 12.5, question: 'Quem?', answer: 'A equipe.' }])
    const sent = fake.received.length
    assert.deepEqual(await ask.history('2026-10-03T09-00-00'), [])
    assert.equal(fake.received.length, sent)
  })
})
