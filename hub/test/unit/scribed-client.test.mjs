import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createScribedClient,
  transcriptLine,
  decodeEvent,
  ProtocolError,
  ScribedError,
  ScribedUnavailable,
  ScribedTimeout
} from '../../server/adapters/scribed.mjs'
import { startFakeScribed } from '../fakes/fake-scribed.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'

const MiB = 1024 * 1024

/**
 * Run `fn` with a fake scribed in a fresh runtime dir, then stop both.
 * @param {Parameters<typeof startFakeScribed>[0] extends infer O ? Omit<O, 'dir'> : never} opts
 * @param {(fake: Awaited<ReturnType<typeof startFakeScribed>>) => Promise<void>} fn
 */
async function withFake (opts, fn) {
  const rt = await makeRuntimeDir()
  const fake = await startFakeScribed({ dir: rt.dir, ...opts })
  try {
    await fn(fake)
  } finally {
    await fake.stop()
    await rt.cleanup()
  }
}

/**
 * A raw `status` line padded with an ignored key to exactly `size` bytes,
 * newline excluded.
 * @param {number} size
 * @returns {string}
 */
function paddedStatusLine (size) {
  const head = '{"type":"status","recording":false,"session_id":null,"tag":null,"elapsed_s":0,"routed_apps":[],"pad":"'
  const tail = '"}'
  return head + 'x'.repeat(size - head.length - tail.length) + tail
}

/**
 * @param {() => boolean} cond
 * @param {number} [ms]
 */
async function waitFor (cond, ms = 2000) {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('an ã split between two writes decodes whole', async () => {
  await withFake({}, async (fake) => {
    const line = Buffer.from(JSON.stringify({ type: 'tail', text: 'sessão' }) + '\n', 'utf8')
    const at = line.indexOf(Buffer.from('ã', 'utf8')) + 1
    fake.on('tail', () => ({ events: [line], splitAt: [at] }))
    const client = createScribedClient({ socketPath: fake.socketPath })
    assert.equal(await client.tail(5), 'sessão')
  })
})

test('a line of exactly 1 MiB is accepted and one byte more is a ProtocolError that closes the connection', async () => {
  await withFake({}, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    fake.on('status', () => paddedStatusLine(MiB) + '\n')
    const ok = await client.status()
    assert.equal(ok.recording, false)

    fake.on('status', () => paddedStatusLine(MiB + 1) + '\n')
    await assert.rejects(client.status(), ProtocolError)
    const last = fake.connections.at(-1)
    await waitFor(() => last?.closed === true)
  })
})

test('a 2 MiB tail answer is accepted', async () => {
  await withFake({}, async (fake) => {
    const text = 'x'.repeat(2 * MiB)
    fake.on('tail', () => ({ type: 'tail', text }))
    const client = createScribedClient({ socketPath: fake.socketPath })
    assert.equal((await client.tail(600)).length, 2 * MiB)
  })
})

test('start sends exactly one start line with only the tag', async () => {
  await withFake({}, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    const res = await client.start('client-a')
    assert.match(res.session_id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/)
    assert.deepEqual(fake.received.map((r) => r.raw + '\n'), ['{"cmd":"start","tag":"client-a"}\n'])
  })
})

test('an unanswered start rejects ScribedTimeout after timeouts.start', async () => {
  await withFake({}, async (fake) => {
    fake.on('start', () => null)
    const client = createScribedClient({ socketPath: fake.socketPath, timeouts: { start: 50 } })
    await assert.rejects(client.start('client-a'), ScribedTimeout)
  })
})

test('a stop answered after 300 ms resolves even with a 50 ms status timeout', async () => {
  await withFake({ stopDelayMs: 300 }, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath, timeouts: { status: 50 } })
    await client.start('pessoal')
    const t = Date.now()
    const res = await client.stop()
    assert.ok(Date.now() - t >= 250)
    assert.match(res.session_id, /^\d{4}-/)
  })
})

test('ask delivers deltas in order and resolves on ask_done', async () => {
  await withFake({ askDeltas: ['um ', 'dois ', 'três'] }, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    await client.start('pessoal')
    /** @type {string[]} */
    const deltas = []
    await client.ask('qual o erro?', { onDelta: (t) => deltas.push(t) })
    assert.deepEqual(deltas, ['um ', 'dois ', 'três'])
    assert.equal(fake.received.at(-1)?.raw, '{"cmd":"ask","question":"qual o erro?"}')
  })
})

test('ask with a single fallback delta works', async () => {
  await withFake({ askDeltas: ['resposta inteira'] }, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    await client.start('pessoal')
    /** @type {string[]} */
    const deltas = []
    await client.ask('q', { onDelta: (t) => deltas.push(t) })
    assert.deepEqual(deltas, ['resposta inteira'])
  })
})

test('an error after two deltas rejects ask with the message verbatim', async () => {
  await withFake({ askDeltas: ['a', 'b'], askError: 'ask falhou: x' }, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    await client.start('pessoal')
    /** @type {string[]} */
    const deltas = []
    await assert.rejects(client.ask('q', { onDelta: (t) => deltas.push(t) }), (err) => {
      assert.ok(err instanceof ScribedError)
      assert.equal(err.message, 'ask falhou: x')
      assert.equal(err.cmd, 'ask')
      return true
    })
    assert.deepEqual(deltas, ['a', 'b'])
  })
})

test('aborting an ask stops the deltas and closes its connection', async () => {
  await withFake({}, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    await client.start('pessoal')
    fake.on('ask', () => ({ events: [{ type: 'ask_delta', text: 'a' }, { type: 'ask_delta', text: 'b' }, { type: 'ask_done' }], splitAt: [32], chunkDelayMs: 200 }))
    const ac = new AbortController()
    /** @type {string[]} */
    const deltas = []
    const p = client.ask('q', { signal: ac.signal, onDelta: (t) => { deltas.push(t); ac.abort() } })
    await assert.rejects(p, { name: 'AbortError' })
    const conn = fake.connections.at(-1)
    await waitFor(() => conn?.closed === true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(deltas, ['a'])
  })
})

test('the known scribed error messages surface verbatim', async () => {
  await withFake({ tags: ['pessoal', 'client-a'] }, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    /**
     * @param {Promise<unknown>} p
     * @param {string} cmd
     * @param {string} message
     */
    const verbatim = (p, cmd, message) => assert.rejects(p, (err) => {
      assert.ok(err instanceof ScribedError)
      assert.equal(err.cmd, cmd)
      assert.equal(err.message, message)
      return true
    })
    await verbatim(client.stop(), 'stop', 'não há sessão ativa')
    await verbatim(client.start('client-z'), 'start',
      "tag desconhecida: 'client-z' \u2014 as configuradas em synthesis.tag_policies são ['pessoal', 'client-a']")
    await client.start('client-a')
    await verbatim(client.start('client-a'), 'start', 'sessão já ativa; pare a atual antes')
    const teardown = 'a sessão anterior ainda está encerrando (stop em andamento); tente de novo em instantes'
    fake.on('start', () => ({ type: 'error', cmd: 'start', message: teardown }))
    await verbatim(client.start('client-a'), 'start', teardown)
  })
})

test('an ok for another cmd is a ProtocolError', async () => {
  await withFake({}, async (fake) => {
    fake.on('stop', () => ({ type: 'ok', cmd: 'start', session_id: 's1' }))
    const client = createScribedClient({ socketPath: fake.socketPath })
    await assert.rejects(client.stop(), ProtocolError)
  })
})

test('a known event type that is not the awaited answer is a ProtocolError', async () => {
  await withFake({}, async (fake) => {
    fake.on('status', () => ({ type: 'tail', text: '' }))
    const client = createScribedClient({ socketPath: fake.socketPath })
    await assert.rejects(client.status(), ProtocolError)
  })
})

test('EOF before an answer and a missing socket reject ScribedUnavailable', async () => {
  await withFake({}, async (fake) => {
    fake.on('history', () => ({ events: [], end: true }))
    const client = createScribedClient({ socketPath: fake.socketPath })
    await assert.rejects(client.history(), ScribedUnavailable)
  })
  const rt = await makeRuntimeDir()
  try {
    const client = createScribedClient({ socketPath: `${rt.dir}/turbidassist.sock` })
    await assert.rejects(client.status(), ScribedUnavailable)
  } finally {
    await rt.cleanup()
  }
})

test('two concurrent asks use two connections', async () => {
  await withFake({}, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    await client.start('pessoal')
    fake.on('ask', (cmd) => ({ delayMs: 100, events: [{ type: 'ask_delta', text: cmd.question }, { type: 'ask_done' }] }))
    /** @type {string[]} */
    const one = []
    /** @type {string[]} */
    const two = []
    await Promise.all([
      client.ask('primeira', { onDelta: (t) => one.push(t) }),
      client.ask('segunda', { onDelta: (t) => two.push(t) })
    ])
    assert.deepEqual([one, two], [['primeira'], ['segunda']])
    const asks = fake.received.filter((r) => r.parsed?.cmd === 'ask')
    assert.equal(asks.length, 2)
    assert.notEqual(asks[0].conn, asks[1].conn)
    const perConn = new Map()
    for (const r of fake.received) perConn.set(r.conn, (perConn.get(r.conn) ?? 0) + 1)
    assert.ok([...perConn.values()].every((n) => n === 1), 'never two commands on one connection')
  })
})

test('an unset XDG_RUNTIME_DIR rejects ScribedUnavailable', async () => {
  const saved = process.env.XDG_RUNTIME_DIR
  delete process.env.XDG_RUNTIME_DIR
  try {
    const client = createScribedClient({})
    await assert.rejects(client.status(), ScribedUnavailable)
    /** @type {Error | null | undefined} */
    let closed
    client.subscribe({ onStatus: () => {}, onTranscript: () => {}, onClose: (err) => { closed = err } })
    await waitFor(() => closed !== undefined)
    assert.ok(closed instanceof ScribedUnavailable)
  } finally {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = saved
  }
})

test('transcriptLine maps a transcript event and refuses a boolean t0', () => {
  const ev = { t0: 12.4, t1: 15.1, source: 'mic', text: 'vou subir o fix', lang: 'pt', asr_model: 'medium-int8', session_id: '2026-09-08T14-00-12' }
  assert.deepEqual(transcriptLine(ev), {
    t0: 12.4, t1: 15.1, speaker: 'Você', text: 'vou subir o fix', sessionId: '2026-09-08T14-00-12', lang: 'pt', asrModel: 'medium-int8'
  })
  assert.equal(transcriptLine({ ...ev, source: 'room' })?.speaker, 'Sala')
  assert.equal(transcriptLine({ ...ev, t0: true }), null)
  assert.equal(transcriptLine({ ...ev, t1: '15' }), null)
  assert.equal(transcriptLine({ ...ev, source: 'phone' }), null)
  assert.equal(transcriptLine({ ...ev, text: 7 }), null)
})

test('an unknown event type before the status answer is skipped and counted', async () => {
  await withFake({}, async (fake) => {
    /** @type {Array<Record<string, unknown>>} */
    const logs = []
    fake.on('status', () => ['{"type":"pin","t":1}\n', { type: 'status', recording: false, session_id: null, tag: null, elapsed_s: 0, routed_apps: [] }])
    const client = createScribedClient({ socketPath: fake.socketPath, log: (e) => logs.push(e) })
    const st = await client.status()
    assert.equal(st.type, 'status')
    assert.equal(client.stats().unknownTypes, 1)
    assert.deepEqual(logs.filter((l) => l.event === 'scribed.unknown_type'), [{ event: 'scribed.unknown_type', cmd: 'status', bytes: 20 }])
  })
})

test('a subscription skips an unknown event type and keeps delivering transcripts', async () => {
  await withFake({}, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    /** @type {Array<Record<string, any>>} */
    const statuses = []
    /** @type {Array<Record<string, any>>} */
    const lines = []
    /** @type {Error | null | undefined} */
    let closed
    const sub = client.subscribe({
      onStatus: (s) => statuses.push(s),
      onTranscript: (e) => lines.push(e),
      onClose: (err) => { closed = err }
    })
    await waitFor(() => statuses.length === 1)
    assert.equal(statuses[0].recording, false)
    fake.write('{"type":"pin","t":1}\n')
    const ev = { t0: 1, t1: 2, source: 'room', text: 'oi', lang: 'pt', asr_model: 'm', session_id: 's1' }
    fake.pushTranscript(ev)
    await waitFor(() => lines.length === 1)
    assert.deepEqual(lines[0], ev)
    assert.equal(closed, undefined)
    assert.equal(client.stats().unknownTypes, 1)
    fake.endSubscribers()
    await waitFor(() => closed !== undefined)
    assert.equal(closed, null)
    sub.close()
  })
})

test('a bad line ends a subscription with a ProtocolError, once', async () => {
  await withFake({}, async (fake) => {
    const client = createScribedClient({ socketPath: fake.socketPath })
    /** @type {Array<Error | null>} */
    const closes = []
    let statuses = 0
    client.subscribe({ onStatus: () => { statuses++ }, onTranscript: () => {}, onClose: (err) => closes.push(err) })
    await waitFor(() => statuses === 1)
    fake.write('não é json\n')
    await waitFor(() => closes.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(closes.length, 1)
    assert.ok(closes[0] instanceof ProtocolError)
  })
})

test('the log receives event, cmd and bytes only, never text', async () => {
  await withFake({ askDeltas: ['segredo da reunião'] }, async (fake) => {
    /** @type {Array<Record<string, unknown>>} */
    const logs = []
    const client = createScribedClient({ socketPath: fake.socketPath, log: (e) => logs.push(e), timeouts: { status: 100 } })
    await client.start('pessoal')
    await client.ask('pergunta secreta', { onDelta: () => {} })
    fake.on('status', () => '{"type":"bogus","text":"segredo"}\n')
    await assert.rejects(client.status(), ScribedTimeout)
    fake.on('status', () => '{"type":"status","recording":"segredo"}\n')
    await assert.rejects(client.status(), ProtocolError)
    assert.ok(logs.some((l) => l.event === 'scribed.unknown_type'))
    assert.ok(logs.some((l) => l.event === 'scribed.protocol_error'))
    for (const entry of logs) {
      assert.ok(Object.keys(entry).every((k) => ['event', 'cmd', 'bytes'].includes(k)), JSON.stringify(Object.keys(entry)))
    }
    assert.ok(!JSON.stringify(logs).includes('segredo') && !JSON.stringify(logs).includes('secreta'))
  })
})

test('decodeEvent keeps the optional status keys stopping and protocol when type-correct', () => {
  const base = '"type":"status","recording":true,"session_id":"s1","tag":"pessoal","elapsed_s":1,"routed_apps":[]'
  assert.deepEqual(decodeEvent(`{${base},"stopping":true,"protocol":2}`).stopping, true)
  assert.equal(decodeEvent(`{${base},"stopping":true,"protocol":2}`).protocol, 2)
  const plain = decodeEvent(`{${base}}`)
  assert.ok(!('stopping' in plain) && !('protocol' in plain))
  const wrong = decodeEvent(`{${base},"stopping":"yes","protocol":true}`)
  assert.ok(!('stopping' in wrong) && !('protocol' in wrong))
})

test('decodeEvent marks an unknown type with code unknown_type and keeps the protocol.py message', () => {
  assert.throws(() => decodeEvent('{"type":"pin","t":1}'), (err) => {
    assert.ok(err instanceof ProtocolError)
    assert.equal(/** @type {ProtocolError} */ (err).code, 'unknown_type')
    assert.match(err.message, /^type desconhecido: 'pin' \(conhecidos: \[/)
    return true
  })
})
