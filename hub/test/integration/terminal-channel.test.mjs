// The WebSocket terminal channel (docs/deck/05-api.md section 3.5) end to end through the deck server.
// Most tests drive the server's deckd link with a scripted deckd connection (`scripted()` below), so the
// order of deckd events against responses is exact; the input tests that need a real PTY use a real deckd
// started in this process with an injected login environment and the fake claude, so no login shell runs.
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { startDeckServer } from '../../server/main.mjs'
import { createPtyBridge } from '../../server/pty-bridge/bridge.mjs'
import { encodeFrame, decodeFrame, FRAME_KIND } from '../../server/pty-bridge/frames.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'

const token = 'a'.repeat(43)
const startFixture = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))
let dir

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tch-')) })
after(() => fs.rmSync(dir, { recursive: true, force: true }))

/**
 * A scripted deckd connection for the server's link. Every message gets an arrival sequence number when it
 * is delivered, as deckd/client.mjs does. Requests answer at once unless their op is in `manual`; a manual
 * request is answered by calling its `reply`.
 */
function scripted({ manual = [] } = {}) {
  let seq = 0
  const seqs = new WeakMap()
  const requests = []
  const changed = new Set()
  const held = new Set(manual)
  const scrollback = new Map()
  /** ptyId -> the PTY as `list` reports it */
  const live = new Map()
  let listeners = new Map()
  let client = null
  const answers = {
    list: () => ({ ptys: [...live.values()] }),
    exits: () => ({ exits: [] }),
    attach: () => ({ cols: 100, rows: 30 }),
    screen: fields => ({ rev: 1, cols: 100, rows: 30, cursor: { x: 0, y: 0 }, lines: [], scrollback: Buffer.from(scrollback.get(fields.ptyId) ?? '').toString('base64') }),
    write: () => ({ at: Date.now() }),
    resize: fields => ({ cols: fields.cols, rows: fields.rows }),
    ping: () => ({ at: Date.now() })
  }
  const notify = () => { for (const fn of [...changed]) fn() }
  function emit(ev, msg) {
    const n = ++seq
    for (const fn of [...listeners.get(ev) ?? []]) fn(msg, n)
    notify()
  }
  const fake = {
    requests,
    scrollback,
    live,
    connect: async () => {
      listeners = new Map()
      client = {
        proto: 2, deckdVersion: '9.9.9', bootId: 'boot',
        request(op, fields = {}) {
          return new Promise(resolve => {
            const entry = { op, fields, answered: false, reply(extra = {}) {
              const msg = { ok: true, ...answers[op]?.(fields) ?? {}, ...extra }
              seqs.set(msg, ++seq)
              entry.answered = true
              resolve(msg)
            } }
            requests.push(entry)
            if (!held.has(op)) entry.reply()
            notify()
          })
        },
        on(ev, fn) {
          let set = listeners.get(ev)
          if (!set) listeners.set(ev, set = new Set())
          set.add(fn)
          return () => { set.delete(fn) }
        },
        seqOf: msg => seqs.get(msg),
        close() { if (client === this) { client = null
          emit('close', {}) } }
      }
      return client
    },
    emit,
    /** Resolve once `fn()` is truthy, re-checked after every request and event. */
    until(fn, what) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const value = fn()
          if (value) { changed.delete(check)
            clearTimeout(timer)
            resolve(value) }
        }
        const timer = setTimeout(() => { changed.delete(check)
          reject(Error(`timed out waiting for ${what}`)) }, 10_000)
        changed.add(check)
        check()
      })
    },
    drop() { client?.close() }
  }
  return fake
}

/** A deck server whose deckd connection is `connectDeckd`; a scripted deckd gets its own private runtime dir. */
async function server(t, connectDeckd, runtimeDir) {
  if (runtimeDir === undefined) {
    runtimeDir = fs.mkdtempSync(path.join(dir, 'rt-'))
    fs.chmodSync(runtimeDir, 0o700)
  }
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const state = path.join(home, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const deck = await startDeckServer({ env: { HOME: home, XDG_RUNTIME_DIR: runtimeDir }, port: 0, notifications: false, connectDeckd,
    reconnectMs: 3_600_000, runPollMs: 3_600_000, runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  t.after(() => deck.close())
  return deck
}

/** A ready WebSocket client: hello sent and the snapshot received. */
async function client(t, deck) {
  const port = deck.address().port
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { headers: { Origin: `http://127.0.0.1:${port}` } })
  ws.on('error', () => {})
  t.after(() => ws.terminate())
  const json = []
  const frames = []
  const changed = new Set()
  let closed = null
  ws.on('message', (data, binary) => {
    if (binary) frames.push(decodeFrame(data))
    else json.push(JSON.parse(data.toString()))
    for (const fn of [...changed]) fn()
  })
  ws.on('close', code => { closed = code
    for (const fn of [...changed]) fn() })
  const until = (fn, what) => new Promise((resolve, reject) => {
    const check = () => {
      const value = fn()
      if (value) { changed.delete(check)
        clearTimeout(timer)
        resolve(value) }
    }
    const timer = setTimeout(() => { changed.delete(check)
      reject(Error(`timed out waiting for ${what}`)) }, 10_000)
    changed.add(check)
    check()
  })
  await once(ws, 'open')
  ws.send(JSON.stringify({ t: 'hello', apiVersion: 1, epoch: null, lastSeq: 0 }))
  await until(() => json.some(m => m.t === 'snapshot'), 'the snapshot')
  return {
    ws, json, frames, until,
    get closed() { return closed },
    send: message => ws.send(JSON.stringify(message)),
    input: (sessionId, text) => ws.send(encodeFrame(FRAME_KIND.input, sessionId, Buffer.from(text))),
    termError: (sessionId, code) => until(() => json.find(m => m.t === 'term.error' && m.sessionId === sessionId && m.error?.code === code), `term.error ${code}`),
    /** term.attach and wait for its snapshot frame. */
    async attach(sessionId, cols = 90, rows = 25) {
      const before = frames.filter(f => f.kind === FRAME_KIND.snapshot && f.sessionId === sessionId).length
      ws.send(JSON.stringify({ t: 'term.attach', sessionId, cols, rows }))
      await until(() => frames.filter(f => f.kind === FRAME_KIND.snapshot && f.sessionId === sessionId).length > before, `the snapshot of ${sessionId}`)
    }
  }
}

let ptys = 0
/** A wrapped PTY announced by the scripted deckd; resolves to its session row. */
async function spawned(fake, deck) {
  const ptyId = `pty-${++ptys}`
  const cwd = fs.mkdtempSync(path.join(dir, 'repo-'))
  const pty = { ptyId, pid: 1000 + ptys, origin: 'wrapped', cwd, argv: ['claude'], startedAt: Date.now() }
  fake.live.set(ptyId, { ...pty, cols: 100, rows: 30, clients: [], lastInputFrom: null, lastInputAt: null })
  fake.emit('spawned', pty)
  const row = deck.projector.snapshot().sessions.find(session => session.ptyId === ptyId)
  assert.ok(row, 'the link created the session row')
  return row
}

const outputs = (c, sessionId) => Buffer.concat(c.frames.filter(f => f.kind === FRAME_KIND.output && f.sessionId === sessionId).map(f => f.payload)).toString()
const snapshots = (c, sessionId) => c.frames.filter(f => f.kind === FRAME_KIND.snapshot && f.sessionId === sessionId).map(f => f.payload.toString())

test('the attach seam: output that arrived before the screen response is in the snapshot only, later output streams once', async t => {
  const fake = scripted({ manual: ['screen'] })
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const c = await client(t, deck)
  c.send({ t: 'term.attach', sessionId: row.id, cols: 90, rows: 25 })
  const screen = await fake.until(() => fake.requests.find(r => r.op === 'screen' && !r.answered), 'the screen request')
  assert.ok(fake.requests.some(r => r.op === 'attach' && r.fields.ptyId === row.ptyId && r.fields.stream === true), 'attached to deckd with stream')
  assert.equal(screen.fields.scrollback, 1000)
  // `before` arrives while the screen request is in flight, so deckd's scrollback already holds it.
  fake.emit('output', { ptyId: row.ptyId, data: Buffer.from('before|').toString('base64') })
  fake.scrollback.set(row.ptyId, 'history|before|')
  screen.reply()
  fake.emit('output', { ptyId: row.ptyId, data: Buffer.from('after|').toString('base64') })
  await c.until(() => outputs(c, row.id).includes('after|'), 'the streamed output')
  const attached = c.json.find(m => m.t === 'term.attached')
  assert.deepEqual({ sessionId: attached.sessionId, ptyId: attached.ptyId, cols: attached.cols, rows: attached.rows }, { sessionId: row.id, ptyId: row.ptyId, cols: 100, rows: 30 })
  assert.deepEqual(snapshots(c, row.id), ['history|before|'])
  assert.equal(outputs(c, row.id), 'after|', 'nothing lost or doubled at the seam')
  const order = c.json.indexOf(attached)
  assert.ok(order >= 0)
  const resize = await fake.until(() => fake.requests.find(r => r.op === 'resize'), 'the browser resize')
  assert.deepEqual(resize.fields, { ptyId: row.ptyId, cols: 90, rows: 25, source: { kind: 'browser' } })
})

test('an observed session gets no_pty, an unknown one not_found, and the socket stays open', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const cwd = fs.mkdtempSync(path.join(dir, 'obs-'))
  deck.ingest.receive(JSON.stringify({ v: 1, hookTs: Date.now(), ptyId: null, claudePid: 4242, pidChain: [], truncated: false,
    hook: { ...startFixture, session_id: 'claude-observed', cwd, hook_event_name: 'SessionStart' } }))
  deck.ingest.flush()
  const observed = deck.projector.snapshot().sessions.find(row => row.origin === 'observed')
  assert.ok(observed, 'an observed session exists')
  const c = await client(t, deck)
  c.send({ t: 'term.attach', sessionId: observed.id, cols: 80, rows: 24 })
  await c.termError(observed.id, 'no_pty')
  c.send({ t: 'term.attach', sessionId: 'no-such-session', cols: 80, rows: 24 })
  await c.termError('no-such-session', 'not_found')
  assert.equal(fake.requests.filter(r => r.op === 'attach' || r.op === 'screen').length, 0)
  assert.equal(c.closed, null)
})

test('a 65 KiB input frame is payload_too_large and never written', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const c = await client(t, deck)
  await c.attach(row.id)
  c.input(row.id, 'x'.repeat(65 * 1024))
  await c.termError(row.id, 'payload_too_large')
  c.input(row.id, 'y'.repeat(64 * 1024))
  const write = await fake.until(() => fake.requests.find(r => r.op === 'write'), 'the 64 KiB write')
  assert.equal(Buffer.from(write.fields.data, 'base64').toString(), 'y'.repeat(64 * 1024))
  assert.equal(fake.requests.filter(r => r.op === 'write').length, 1)
})

test('a client-sent output or snapshot frame is refused with validation_failed', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const c = await client(t, deck)
  await c.attach(row.id)
  c.ws.send(encodeFrame(FRAME_KIND.output, row.id, Buffer.from('forged')))
  await c.termError(row.id, 'validation_failed')
  c.ws.send(encodeFrame(FRAME_KIND.snapshot, row.id, Buffer.from('forged')))
  await c.until(() => c.json.filter(m => m.t === 'term.error' && m.error.code === 'validation_failed').length === 2, 'the second refusal')
  c.ws.send(Buffer.from([2, 0]))
  await c.until(() => c.json.some(m => m.t === 'error' && m.data?.code === 'validation_failed'), 'the malformed frame error')
  assert.equal(fake.requests.filter(r => r.op === 'write').length, 0)
  assert.equal(c.closed, null)
})

test('an unknown message type or invalid JSON gets an error and the socket stays open', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const c = await client(t, deck)
  c.send({ t: 'term.nope' })
  await c.until(() => c.json.filter(m => m.t === 'error').length === 1, 'the first error')
  c.ws.send('{not json')
  await c.until(() => c.json.filter(m => m.t === 'error').length === 2, 'the second error')
  c.send({ t: 'ui.focus', visible: true, focused: true, route: '/' })
  c.send({ t: 'bell.played', sessionId: 'x' })
  c.send({ t: 42 })
  await c.until(() => c.json.filter(m => m.t === 'error').length === 3, 'the third error')
  for (const error of c.json.filter(m => m.t === 'error')) assert.equal(error.data.code, 'validation_failed')
  assert.equal(c.closed, null)
  assert.equal(c.ws.readyState, WebSocket.OPEN)
})

test('term.resize forwards browser sizes 1 to 1000 for an attached session only', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const c = await client(t, deck)
  c.send({ t: 'term.resize', sessionId: row.id, cols: 50, rows: 20 })
  await c.termError(row.id, 'not_attached')
  await c.attach(row.id)
  await fake.until(() => fake.requests.some(r => r.op === 'resize'), 'the attach resize')
  for (const [cols, rows] of [[0, 10], [1001, 10], [10, 1.5], ['10', 10]]) c.send({ t: 'term.resize', sessionId: row.id, cols, rows })
  await c.until(() => c.json.filter(m => m.t === 'term.error' && m.error.code === 'validation_failed').length === 4, 'four refusals')
  c.send({ t: 'term.resize', sessionId: row.id, cols: 1000, rows: 1 })
  const resize = await fake.until(() => fake.requests.find(r => r.op === 'resize' && r.fields.cols === 1000), 'the forwarded resize')
  assert.deepEqual(resize.fields.source, { kind: 'browser' })
  assert.equal(fake.requests.filter(r => r.op === 'resize').length, 2)
})

test('sub.tails sends at most one screen.tail per second per session, to subscribers only', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const subscriber = await client(t, deck)
  const other = await client(t, deck)
  subscriber.send({ t: 'sub.tails', sessionIds: [row.id] })
  other.send({ t: 'sub.tails', sessionIds: [] })
  subscriber.send({ t: 'sub.tails', sessionIds: Array(51).fill(row.id) })
  subscriber.send({ t: 'sub.tails', sessionIds: [7] })
  await subscriber.until(() => subscriber.json.filter(m => m.t === 'error').length === 2, 'the refused tail sets')
  const rows = ['', 'line 1', 'line 2', '   ', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', '', '✻ Thinking… (3s · esc to interrupt)', '', '❯ ', '']
  for (let i = 0; i < 5; i++) fake.emit('screen', { ptyId: row.ptyId, rev: i + 1, lines: rows.map(line => line === 'line 9' ? `line 9 rev ${i}` : line), cursor: { x: 2, y: 14 }, changedRows: [10] })
  // A barrier: the error answers a message sent after the five screens, so every tail they produce is in.
  subscriber.send({ t: 'barrier' })
  await subscriber.until(() => subscriber.json.filter(m => m.t === 'error').length === 3, 'the barrier')
  const tails = subscriber.json.filter(m => m.t === 'screen.tail')
  assert.equal(tails.length, 1, 'five screens inside one second give one tail')
  assert.equal(tails[0].data.sessionId, row.id)
  assert.equal(tails[0].seq, undefined)
  assert.deepEqual(tails[0].data.lines, ['line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9 rev 0'])
  other.send({ t: 'barrier' })
  await other.until(() => other.json.some(m => m.t === 'error'), 'the other barrier')
  assert.equal(other.json.filter(m => m.t === 'screen.tail').length, 0)
})

test('exit, dropped and a deckd outage reach the attached tabs', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const second = await spawned(fake, deck)
  const c = await client(t, deck)
  await c.attach(row.id)
  await c.attach(second.id)
  fake.scrollback.set(row.ptyId, 'fresh screen')
  fake.emit('dropped', { ptyId: row.ptyId, bytes: 10 })
  await c.until(() => snapshots(c, row.id).length === 2, 'the fresh snapshot')
  assert.equal(snapshots(c, row.id)[1], 'fresh screen')
  fake.live.delete(row.ptyId)
  fake.emit('exit', { ptyId: row.ptyId, code: 3, signal: null, at: Date.now() })
  const exit = await c.until(() => c.json.find(m => m.t === 'term.exit'), 'term.exit')
  assert.deepEqual({ sessionId: exit.sessionId, code: exit.code, signal: exit.signal }, { sessionId: row.id, code: 3, signal: null })
  fake.drop()
  await c.termError(second.id, 'deckd_unavailable')
  c.send({ t: 'term.attach', sessionId: second.id, cols: 80, rows: 24 })
  await c.until(() => c.json.filter(m => m.t === 'term.error' && m.sessionId === second.id && m.error.code === 'deckd_unavailable').length === 2, 'attach refused while down')
  c.input(second.id, 'lost')
  await c.until(() => c.json.filter(m => m.t === 'term.error' && m.sessionId === second.id && m.error.code === 'deckd_unavailable').length === 3, 'input refused while down')
  assert.equal(fake.requests.filter(r => r.op === 'write').length, 0, 'input is dropped, never queued')
  // deckd is back: the tab still attached on the server side gets a fresh snapshot without a new term.attach.
  fake.scrollback.set(second.ptyId, 'after the outage')
  deck.link.retry()
  await c.until(() => snapshots(c, second.id).length === 2, 'the snapshot after the outage')
  assert.equal(snapshots(c, second.id)[1], 'after the outage')
  assert.equal(fake.requests.filter(r => r.op === 'write').length, 0)
  c.input(second.id, 'back')
  const write = await fake.until(() => fake.requests.find(r => r.op === 'write'), 'the write after the outage')
  assert.equal(Buffer.from(write.fields.data, 'base64').toString(), 'back')
})

/** Record the order of every JSON type and frame for `sessionId` on a client, as `t` or `frame:<kind>`. */
function order(c, sessionId) {
  const seen = []
  c.ws.on('message', (data, binary) => {
    if (binary) { const frame = decodeFrame(data)
      if (frame?.sessionId === sessionId) seen.push(`frame:${frame.kind}`)
      return }
    const msg = JSON.parse(data.toString())
    if (msg.sessionId === sessionId) seen.push(msg.t === 'term.error' ? `term.error:${msg.error.code}` : msg.t)
  })
  return seen
}

test('after a deckd outage an attached tab gets term.attached again before its fresh snapshot, and the browser resize', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const c = await client(t, deck)
  const seen = order(c, row.id)
  await c.attach(row.id, 90, 25)
  await fake.until(() => fake.requests.some(r => r.op === 'resize'), 'the attach resize')
  fake.drop()
  await c.termError(row.id, 'deckd_unavailable')
  fake.scrollback.set(row.ptyId, 'after the outage')
  deck.link.retry()
  await c.until(() => snapshots(c, row.id).length === 2, 'the snapshot after the outage')
  const resizes = await fake.until(() => { const found = fake.requests.filter(r => r.op === 'resize')
    return found.length === 2 && found }, 'the resize after the outage')
  assert.deepEqual(resizes[1].fields, { ptyId: row.ptyId, cols: 90, rows: 25, source: { kind: 'browser' } })
  const snapshot = `frame:${FRAME_KIND.snapshot}`
  assert.deepEqual(seen, ['term.attached', snapshot, 'term.error:deckd_unavailable', 'term.attached', snapshot])
  const attached = c.json.filter(m => m.t === 'term.attached' && m.sessionId === row.id).at(-1)
  assert.deepEqual({ ptyId: attached.ptyId, cols: attached.cols, rows: attached.rows }, { ptyId: row.ptyId, cols: 100, rows: 30 })
})

test('a dropped event during the first sync still gives the tab one term.attached, one resize and an exact seam', async t => {
  const fake = scripted({ manual: ['screen'] })
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const c = await client(t, deck)
  const seen = order(c, row.id)
  c.send({ t: 'term.attach', sessionId: row.id, cols: 90, rows: 25 })
  const first = await fake.until(() => fake.requests.find(r => r.op === 'screen' && !r.answered), 'the first screen request')
  fake.emit('output', { ptyId: row.ptyId, data: Buffer.from('one|').toString('base64') })
  fake.emit('dropped', { ptyId: row.ptyId, bytes: 10 })
  const second = await fake.until(() => fake.requests.find(r => r.op === 'screen' && !r.answered && r !== first), 'the second screen request')
  fake.emit('output', { ptyId: row.ptyId, data: Buffer.from('two|').toString('base64') })
  fake.scrollback.set(row.ptyId, 'history|one|')
  first.reply()
  fake.scrollback.set(row.ptyId, 'history|one|two|')
  second.reply()
  fake.emit('output', { ptyId: row.ptyId, data: Buffer.from('three|').toString('base64') })
  await c.until(() => outputs(c, row.id).includes('three|'), 'the streamed output')
  await fake.until(() => fake.requests.some(r => r.op === 'resize'), 'the browser resize')
  // A barrier: the error answers a message sent after everything above, so no late term.attached is missed.
  c.send({ t: 'barrier' })
  await c.until(() => c.json.some(m => m.t === 'error'), 'the barrier')
  assert.deepEqual(seen, ['term.attached', `frame:${FRAME_KIND.snapshot}`, `frame:${FRAME_KIND.output}`])
  assert.deepEqual(snapshots(c, row.id), ['history|one|two|'])
  assert.equal(outputs(c, row.id), 'three|', 'nothing lost or doubled at the seam')
  const resizes = fake.requests.filter(r => r.op === 'resize')
  assert.equal(resizes.length, 1)
  assert.deepEqual(resizes[0].fields, { ptyId: row.ptyId, cols: 90, rows: 25, source: { kind: 'browser' } })
})

test('a dropped event after the first sync sends a fresh snapshot but no second term.attached and no second resize', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const c = await client(t, deck)
  const seen = order(c, row.id)
  await c.attach(row.id, 90, 25)
  await fake.until(() => fake.requests.some(r => r.op === 'resize'), 'the attach resize')
  fake.scrollback.set(row.ptyId, 'after the drop')
  fake.emit('dropped', { ptyId: row.ptyId, bytes: 10 })
  await c.until(() => snapshots(c, row.id).length === 2, 'the second snapshot')
  // A barrier: the error answers a message sent after the second sync, so a late term.attached or resize is in.
  c.send({ t: 'barrier' })
  await c.until(() => c.json.some(m => m.t === 'error'), 'the barrier')
  assert.equal(snapshots(c, row.id)[1], 'after the drop')
  assert.equal(c.json.filter(m => m.t === 'term.attached' && m.sessionId === row.id).length, 1, 'exactly one term.attached')
  assert.equal(fake.requests.filter(r => r.op === 'resize').length, 1, 'exactly one browser resize')
  const snapshot = `frame:${FRAME_KIND.snapshot}`
  assert.deepEqual(seen, ['term.attached', snapshot, snapshot])
})

test('terminal clients attached before the server starts are counted: one leaving is not detached, the last one is', async t => {
  const fake = scripted()
  const ptyId = `pty-${++ptys}`
  const cwd = fs.mkdtempSync(path.join(dir, 'repo-'))
  fake.live.set(ptyId, { ptyId, pid: 1000 + ptys, origin: 'wrapped', cwd, argv: ['claude'], startedAt: Date.now(), cols: 100, rows: 30,
    clients: [{ kind: 'terminal', name: 'kitty' }, { kind: 'terminal', name: 'foot' }, { kind: 'server' }], lastInputFrom: null, lastInputAt: null })
  const deck = await server(t, fake.connect)
  await fake.until(() => fake.requests.filter(r => r.op === 'list').length >= 2, 'the list the bridge seeds from')
  // The client's hello round trip is the barrier that lets the seed's list response be handled first.
  const c = await client(t, deck)
  const row = deck.projector.snapshot().sessions.find(session => session.ptyId === ptyId)
  assert.ok(row, 'the link adopted the live PTY')
  const sources = () => c.json.filter(m => m.t === 'input.source' && m.data.sessionId === row.id).map(m => m.data)
  fake.emit('client', { ptyId, change: 'detached', client: { kind: 'terminal', name: 'kitty' } })
  c.send({ t: 'barrier' })
  await c.until(() => c.json.some(m => m.t === 'error'), 'the barrier')
  assert.deepEqual(sources(), [], 'foot is still attached, so nothing changed')
  fake.emit('client', { ptyId, change: 'detached', client: { kind: 'terminal', name: 'foot' } })
  const detached = await c.until(() => sources().find(view => view.detached), 'detached')
  assert.equal(detached.detached, true)
  assert.equal(sources().length, 1)
})

test('the bridge detaches from deckd when the last tab detaches and keeps the link watching the screen', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const a = await client(t, deck)
  const b = await client(t, deck)
  await a.attach(row.id)
  await b.attach(row.id)
  assert.equal(fake.requests.filter(r => r.op === 'attach').length, 1, 'one deckd attach per PTY')
  fake.emit('output', { ptyId: row.ptyId, data: Buffer.from('fan').toString('base64') })
  await a.until(() => outputs(a, row.id) === 'fan', 'output on tab a')
  await b.until(() => outputs(b, row.id) === 'fan', 'output on tab b')
  a.send({ t: 'term.detach', sessionId: row.id })
  b.send({ t: 'barrier' })
  await b.until(() => b.json.some(m => m.t === 'error'), 'the barrier')
  assert.equal(fake.requests.filter(r => r.op === 'detach').length, 0)
  b.ws.close()
  const detach = await fake.until(() => fake.requests.find(r => r.op === 'detach'), 'the deckd detach')
  assert.equal(detach.fields.ptyId, row.ptyId)
  await fake.until(() => fake.requests.filter(r => r.op === 'watchScreen' && r.fields.ptyId === row.ptyId).length === 2, 'watchScreen again')
})

test('output for a tab over 4 MiB of backlog is dropped with one output_dropped per episode, ended by the next attach', async t => {
  const fake = scripted()
  const deck = await server(t, fake.connect)
  const row = await spawned(fake, deck)
  const bridge = createPtyBridge({ link: deck.link, store: deck.store, publish: () => {} })
  t.after(() => bridge.dispose())
  const sent = []
  const ws = { readyState: 1, bufferedAmount: 0, send: data => sent.push(data) }
  bridge.message(ws, { t: 'term.attach', sessionId: row.id, cols: 80, rows: 24 })
  const isFrame = data => Buffer.isBuffer(data)
  await fake.until(() => sent.some(data => isFrame(data) && data[0] === FRAME_KIND.snapshot) && fake.requests.some(r => r.op === 'resize'), 'the fake tab snapshot')
  const data = text => ({ ptyId: row.ptyId, data: Buffer.from(text).toString('base64') })
  ws.bufferedAmount = 4 * 1024 * 1024 + 1
  fake.emit('output', data('one'))
  fake.emit('output', data('two'))
  ws.bufferedAmount = 0
  fake.emit('output', data('three'))
  const errors = () => sent.filter(d => !isFrame(d)).map(d => JSON.parse(d)).filter(m => m.t === 'term.error')
  assert.deepEqual(errors().map(m => m.error.code), ['output_dropped'])
  assert.deepEqual(sent.filter(d => isFrame(d) && d[0] === FRAME_KIND.output).map(d => decodeFrame(d).payload.toString()), [], 'the episode lasts until the next attach')
  bridge.message(ws, { t: 'term.attach', sessionId: row.id, cols: 80, rows: 24 })
  await fake.until(() => sent.filter(d => isFrame(d) && d[0] === FRAME_KIND.snapshot).length === 2, 'the re-attach snapshot')
  fake.emit('output', data('four'))
  assert.deepEqual(sent.filter(d => isFrame(d) && d[0] === FRAME_KIND.output).map(d => decodeFrame(d).payload.toString()), ['four'])
  ws.bufferedAmount = 4 * 1024 * 1024 + 1
  fake.emit('output', data('five'))
  assert.deepEqual(errors().map(m => m.error.code), ['output_dropped', 'output_dropped'], 'a new episode reports again')
})

// Real deckd with the fake claude: input that never reaches the PTY, and the browser source set by the server.
let rt
let deckd
let bin
let term
let scripts = 0

async function realPty(t) {
  rt ??= await makeRuntimeDir()
  bin ??= await fakeBin({ version: '2.1.282' })
  deckd ??= await startDeckd({ runtimeDir: rt.dir, version: '9.9.9', loginEnv: { PATH: bin.env.PATH, HOME: dir } })
  term ??= await connectDeckd({ runtimeDir: rt.dir, kind: 'terminal', name: 'observer' })
  const script = path.join(dir, `script-${++scripts}.json`)
  const log = path.join(dir, `log-${scripts}.jsonl`)
  // `ready>` is printed after the fake put its terminal in raw mode, so no input is echoed by the tty itself.
  fs.writeFileSync(script, JSON.stringify({ sessionId: 'auto', steps: [{ print: 'ready>' }, { echo: {} }] }))
  const cwd = fs.mkdtempSync(path.join(dir, 'real-'))
  const deck = await server(t, connectDeckd, rt.dir)
  let off
  const ready = new Promise(resolve => { off = deck.link.onParsed(event => { if (event.lines.some(line => line.includes('ready>'))) resolve(event.ptyId) }) })
  t.after(() => off())
  const { ptyId } = await term.request('spawn', { cwd, argv: ['claude'], cols: 100, rows: 30, origin: 'wrapped',
    env: { PATH: bin.env.PATH, HOME: dir, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_VERSION: '2.1.282', FAKE_CLAUDE_LOG: log } })
  t.after(() => term.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 }).catch(() => {}))
  const end = Date.now() + 10_000
  let row
  while (!(row = deck.projector.snapshot().sessions.find(session => session.ptyId === ptyId))) {
    assert.ok(Date.now() < end, 'timed out waiting for the spawned row')
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(await ready, ptyId)
  const c = await client(t, deck)
  const inputs = []
  t.after(term.on('input', msg => { if (msg.ptyId === ptyId) inputs.push(msg) }))
  return { deck, row, c, log, inputs }
}

after(async () => {
  term?.close()
  await deckd?.close()
  await bin?.cleanup()
  await rt?.cleanup()
})

test('an input frame for a session the socket has not attached is not_attached and the PTY gets nothing', async t => {
  const { row, c, log, inputs } = await realPty(t)
  c.input(row.id, 'sneaky')
  await c.termError(row.id, 'not_attached')
  // The same socket then attaches and types: only that input reaches the fake.
  await c.attach(row.id)
  c.input(row.id, 'typed')
  await c.until(() => outputs(c, row.id).includes('typed'), 'the echo')
  const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => 'input' in entry).map(entry => entry.input).join('')
  assert.equal(logged, 'typed')
  assert.equal(inputs.length, 1)
})

test('an input frame is written with source browser even when its payload imitates JSON', async t => {
  const { row, c, log, inputs } = await realPty(t)
  await c.attach(row.id)
  const payload = '","source":{"kind":"terminal","name":"kitty"},"x":"'
  c.input(row.id, payload)
  await c.until(() => outputs(c, row.id).includes(payload), 'the echo')
  assert.equal(inputs.length, 1)
  assert.deepEqual(inputs[0].source, { kind: 'browser' })
  assert.equal(inputs[0].bytes, Buffer.byteLength(payload))
  assert.ok(fs.readFileSync(log, 'utf8').includes(JSON.stringify(payload).slice(1, -1)))
})
