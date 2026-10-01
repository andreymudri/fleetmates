// The server side of the terminal frame layout (docs/deck/05-api.md section 3.5): byte 0 the kind, byte 1
// the session id length, the ASCII id, then the raw payload, and every frame decodeFrame refuses.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeFrame, decodeFrame, FRAME_KIND, MAX_INPUT_BYTES } from '../../server/pty-bridge/frames.mjs'
import { encodeFrame as encodeClientFrame, decodeServerFrame } from '../../web/src/state/terminal.js'

const id = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('encodeFrame writes kind, id length, the ASCII id and the raw payload', () => {
  const frame = encodeFrame(FRAME_KIND.output, id, Buffer.from([0x1b, 0x5b, 0x41, 0xff]))
  assert.ok(Buffer.isBuffer(frame))
  assert.equal(frame[0], 1)
  assert.equal(frame[1], id.length)
  assert.equal(frame.subarray(2, 2 + id.length).toString('ascii'), id)
  assert.deepEqual([...frame.subarray(2 + id.length)], [0x1b, 0x5b, 0x41, 0xff])
  assert.deepEqual(FRAME_KIND, { output: 1, input: 2, snapshot: 3 })
  assert.equal(MAX_INPUT_BYTES, 64 * 1024)
})

test('server and browser frames are byte for byte the same layout in both directions', () => {
  const fromServer = encodeFrame(FRAME_KIND.snapshot, id, Buffer.from('héllo'))
  const read = decodeServerFrame(new Uint8Array(fromServer))
  assert.equal(read.kind, 3)
  assert.equal(read.sessionId, id)
  assert.equal(Buffer.from(read.payload).toString('utf8'), 'héllo')
  const fromBrowser = encodeClientFrame(FRAME_KIND.input, id, 'ls\r')
  const decoded = decodeFrame(Buffer.from(fromBrowser))
  assert.deepEqual({ kind: decoded.kind, sessionId: decoded.sessionId, payload: decoded.payload.toString('utf8') }, { kind: 2, sessionId: id, payload: 'ls\r' })
})

test('decodeFrame accepts an empty payload and a 64-character id', () => {
  const long = 'a'.repeat(64)
  const frame = decodeFrame(Buffer.concat([Buffer.from([2, 64]), Buffer.from(long)]))
  assert.equal(frame.sessionId, long)
  assert.equal(frame.payload.length, 0)
})

test('decodeFrame refuses every malformed frame with null', () => {
  const head = (kind, n) => Buffer.from([kind, n])
  const cases = [
    ['an empty frame', Buffer.alloc(0)],
    ['a one-byte frame', Buffer.from([2])],
    ['an id length of 0', Buffer.concat([head(2, 0), Buffer.from('payload')])],
    ['an id length over 64', Buffer.concat([head(2, 65), Buffer.from('a'.repeat(65))])],
    ['a truncated id', Buffer.concat([head(2, 10), Buffer.from('abc')])],
    ['an id with a slash', Buffer.concat([head(2, 3), Buffer.from('a/b')])],
    ['an id with a space', Buffer.concat([head(2, 3), Buffer.from('a b')])],
    ['an id with a dot', Buffer.concat([head(2, 3), Buffer.from('..x')])],
    ['an id with a non-ASCII byte', Buffer.concat([head(2, 2), Buffer.from([0x61, 0xe9])])],
    ['an id with a NUL', Buffer.concat([head(2, 2), Buffer.from([0x61, 0x00])])]
  ]
  for (const [name, frame] of cases) assert.equal(decodeFrame(frame), null, name)
  assert.equal(decodeFrame('not bytes'), null, 'a string')
  assert.equal(decodeFrame(null), null, 'null')
})

test('decodeFrame accepts ArrayBuffer, Uint8Array and an array of Buffer fragments', () => {
  const frame = encodeFrame(FRAME_KIND.input, 'abc', Buffer.from('xy'))
  const view = new Uint8Array(frame)
  for (const input of [view, view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength), [frame.subarray(0, 3), frame.subarray(3)]]) {
    const decoded = decodeFrame(input)
    assert.equal(decoded.sessionId, 'abc')
    assert.equal(decoded.payload.toString('utf8'), 'xy')
  }
})

test('encodeFrame refuses an id the decoder would refuse', () => {
  for (const bad of ['', 'a'.repeat(65), 'a/b', 7]) assert.throws(() => encodeFrame(FRAME_KIND.output, bad, Buffer.alloc(0)), TypeError)
})
