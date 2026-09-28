import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encode, createLineDecoder, PROTO, OUTPUT_QUEUE_CAP } from '../../deckd/protocol.mjs'
import { Ring } from '../../deckd/ring.mjs'

/**
 * Build a decoder that records what it produced.
 * @returns {{ feed: (chunk: Buffer | string) => void, messages: unknown[], errors: unknown[] }}
 */
function recorder () {
  /** @type {unknown[]} */
  const messages = []
  /** @type {unknown[]} */
  const errors = []
  const feed = createLineDecoder((m) => messages.push(m), (e) => errors.push(e))
  return { feed, messages, errors }
}

test('constants match 05-api.md section 5', () => {
  assert.equal(PROTO, 1)
  assert.equal(OUTPUT_QUEUE_CAP, 8 * 1024 * 1024)
})

test('encode writes one JSON line', () => {
  assert.equal(encode({ id: 1, op: 'ping' }), '{"id":1,"op":"ping"}\n')
})

test('decoder joins a message split across chunks', () => {
  const r = recorder()
  const line = encode({ id: 7, op: 'hello', proto: 1 })
  r.feed(Buffer.from(line.slice(0, 5)))
  assert.deepEqual(r.messages, [])
  r.feed(Buffer.from(line.slice(5, 12)))
  r.feed(Buffer.from(line.slice(12)))
  assert.deepEqual(r.messages, [{ id: 7, op: 'hello', proto: 1 }])
  assert.deepEqual(r.errors, [])
})

test('decoder joins a multi-byte character split across chunks', () => {
  const r = recorder()
  const bytes = Buffer.from(encode({ name: 'ção' }))
  const cut = bytes.indexOf(0xa7)
  r.feed(bytes.subarray(0, cut))
  r.feed(bytes.subarray(cut))
  assert.deepEqual(r.messages, [{ name: 'ção' }])
})

test('decoder handles several lines in one chunk and skips empty lines', () => {
  const r = recorder()
  r.feed(encode({ a: 1 }) + '\n' + encode({ b: 2 }) + encode({ c: 3 }).slice(0, 4))
  assert.deepEqual(r.messages, [{ a: 1 }, { b: 2 }])
  r.feed(encode({ c: 3 }).slice(4))
  assert.deepEqual(r.messages, [{ a: 1 }, { b: 2 }, { c: 3 }])
})

test('decoder reports bad JSON and keeps decoding', () => {
  const r = recorder()
  r.feed('{not json\n' + encode({ ok: true }))
  assert.deepEqual(r.errors, [{ code: 'bad_json' }])
  assert.deepEqual(r.messages, [{ ok: true }])
  r.feed('[]]\n' + encode({ again: 1 }))
  assert.equal(r.errors.length, 2)
  assert.deepEqual(r.messages, [{ ok: true }, { again: 1 }])
})

// `screen { scrollback: N }` returns Ring.tail(N).
test('screen scrollback: Ring.tail returns the last N lines from a line boundary', () => {
  const r = new Ring()
  r.push(Buffer.from('a\nb\nc\n'))
  assert.equal(r.tail(2).toString(), 'b\nc\n')
  assert.equal(r.tail(3).toString(), 'a\nb\nc\n')
  assert.equal(r.tail(99).toString(), 'a\nb\nc\n')
  assert.equal(r.tail(0).toString(), '')
  r.push(Buffer.from('d'))
  assert.equal(r.tail(2).toString(), 'c\nd')
})

test('screen scrollback: Ring.tail drops a first line cut short by the byte cap', () => {
  const cut = new Ring({ maxBytes: 9 })
  cut.push(Buffer.from('first\nsecond\n'))
  assert.equal(cut.snapshot().toString(), 't\nsecond\n')
  assert.equal(cut.tail(99).toString(), 'second\n')
  // a byte trim that lands right after a newline keeps the first line
  const clean = new Ring({ maxBytes: 7 })
  clean.push(Buffer.from('first\n'))
  clean.push(Buffer.from('second\n'))
  assert.equal(clean.snapshot().toString(), 'second\n')
  assert.equal(clean.tail(99).toString(), 'second\n')
  clean.push(Buffer.from('xy'))
  assert.equal(clean.snapshot().toString(), 'cond\nxy')
  assert.equal(clean.tail(99).toString(), 'xy')
})
