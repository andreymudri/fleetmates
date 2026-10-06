import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { encode, createLineDecoder, PROTO, OUTPUT_QUEUE_CAP, MAX_LINE } from '../../deckd/protocol.mjs'
import { Ring } from '../../deckd/ring.mjs'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'

const stub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'integration', 'stubs', 'claude')

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
  assert.equal(PROTO, 2)
  assert.equal(OUTPUT_QUEUE_CAP, 8 * 1024 * 1024)
  assert.equal(MAX_LINE, 1024 * 1024)
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

test('decoder with maxLine discards an over-long line once and keeps decoding', () => {
  /** @type {unknown[]} */
  const messages = []
  /** @type {unknown[]} */
  const errors = []
  const feed = createLineDecoder((m) => messages.push(m), (e) => errors.push(e), { maxLine: 16 })
  // split across chunks, no newline yet: reported once, as soon as it is too long
  feed('x'.repeat(10))
  feed('x'.repeat(10))
  assert.deepEqual(errors, [{ code: 'line_too_long' }])
  feed('y'.repeat(100))
  feed('zz\n' + encode({ a: 1 }))
  assert.deepEqual(errors, [{ code: 'line_too_long' }])
  assert.deepEqual(messages, [{ a: 1 }])
  // a whole over-long line inside one chunk
  feed(JSON.stringify({ long: 'w'.repeat(20) }) + '\n' + encode({ b: 2 }))
  assert.deepEqual(errors, [{ code: 'line_too_long' }, { code: 'line_too_long' }])
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }])
  // exactly maxLine bytes is still read
  const exact = JSON.stringify({ c: 'v'.repeat(8) })
  assert.equal(exact.length, 16)
  feed(exact + '\n')
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }, { c: 'v'.repeat(8) }])
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

test('history: proto 2 gets it on the exit record and on screen with history: true; proto 1 gets neither', async () => {
  const rt = await makeRuntimeDir()
  const deckd = await startDeckd({ runtimeDir: rt.dir, loginEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: rt.dir } })
  const c2 = await connectDeckd({ runtimeDir: rt.dir, kind: 'server', name: 'history2', proto: 2 })
  const c1 = await connectDeckd({ runtimeDir: rt.dir, kind: 'server', name: 'history1', proto: 1 })
  try {
    const since = Date.now() - 1
    const { ptyId } = await c2.request('spawn', { cwd: rt.dir, argv: [stub], env: {}, cols: 90, rows: 20, origin: 'launched' })
    const end = Date.now() + 15000
    while (!(await c2.request('screen', { ptyId, scrollback: 0 })).lines.includes('READY')) {
      if (Date.now() > end) throw new Error('stub never printed READY')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await c2.request('write', { ptyId, data: Buffer.from('\x1b[31mredline\x1b[0m\r\n').toString('base64'), source: { kind: 'deck' } })
    const end2 = Date.now() + 15000
    for (;;) {
      const res = await c2.request('screen', { ptyId, scrollback: 0, history: true })
      assert.equal(Object.hasOwn(res, 'history'), true)
      if (res.history.data.includes('redline')) {
        assert.equal(res.history.cols, 90)
        assert.equal(res.history.rows, 20)
        assert.match(res.history.data, /\x1b\[(?:[0-9;]*;)?31(?:;[0-9;]*)?mredline/)
        break
      }
      if (Date.now() > end2) throw new Error(`no redline in history: ${JSON.stringify(res.history)}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // without history: true, proto 2 gets no history field
    assert.equal(Object.hasOwn(await c2.request('screen', { ptyId, scrollback: 0 }), 'history'), false)
    // proto 1 never gets it
    assert.equal(Object.hasOwn(await c1.request('screen', { ptyId, scrollback: 0, history: true }), 'history'), false)

    const exited = new Promise((resolve) => {
      const off = c2.on('exit', (/** @type {any} */ m) => { if (m.ptyId === ptyId) { off(); resolve(m) } })
    })
    await c2.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 })
    await exited
    const rec2 = (await c2.request('exits', { since })).exits.find((/** @type {any} */ e) => e.ptyId === ptyId)
    assert.equal(rec2.history.cols, 90)
    assert.equal(rec2.history.rows, 20)
    assert.match(rec2.history.data, /redline/)
    assert.equal(typeof rec2.tail, 'string')
    const rec1 = (await c1.request('exits', { since })).exits.find((/** @type {any} */ e) => e.ptyId === ptyId)
    assert.equal(Object.hasOwn(rec1, 'history'), false)
    assert.equal(Object.hasOwn(rec1, 'tail'), false)
  } finally {
    c1.close()
    c2.close()
    await deckd.close()
    await rt.cleanup()
  }
})

/**
 * Run `script` as a one-shot `claude` under a fresh in-process deckd and
 * return the proto 2 exit record of its PTY. `FLAG` in `script` becomes the
 * path of a file the child can create. With `stall`, this process blocks its
 * event loop, which it shares with deckd, from the spawn until that file
 * exists and 50 ms more: the child's last output and its exit then reach
 * deckd together.
 * @param {string} script body of a node program
 * @param {{ historyCap?: number, stall?: boolean }} [opts]
 * @returns {Promise<any>}
 */
async function exitRecordOf (script, { stall = false, ...deckdOpts } = {}) {
  const rt = await makeRuntimeDir()
  const bin = path.join(rt.dir, 'bin')
  await mkdir(bin, { mode: 0o700 })
  const claude = path.join(bin, 'claude')
  const flag = path.join(rt.dir, 'flag')
  await writeFile(claude, `#!/usr/bin/env node\n${script.replace('FLAG', JSON.stringify(flag))}\n`, { mode: 0o700 })
  const deckd = await startDeckd({ runtimeDir: rt.dir, loginEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: rt.dir }, ...deckdOpts })
  const c = await connectDeckd({ runtimeDir: rt.dir, kind: 'server', name: 'history-exit', proto: 2 })
  try {
    const since = Date.now() - 1
    /** @type {any[]} */
    const seen = []
    /** @type {(m: any) => void} */
    let onExit = (m) => { seen.push(m) }
    const off = c.on('exit', (/** @type {any} */ m) => onExit(m))
    const { ptyId } = await c.request('spawn', { cwd: rt.dir, argv: [claude], env: {}, cols: 80, rows: 10, origin: 'launched' })
    if (stall) {
      const end = Date.now() + 15000
      while (!existsSync(flag) && Date.now() < end) { /* block */ }
      const settle = Date.now() + 50
      while (Date.now() < settle) { /* block */ }
    }
    await new Promise((resolve) => {
      if (seen.some((m) => m.ptyId === ptyId)) return resolve(undefined)
      onExit = (m) => { if (m.ptyId === ptyId) resolve(undefined) }
    })
    off()
    return (await c.request('exits', { since })).exits.find((/** @type {any} */ e) => e.ptyId === ptyId)
  } finally {
    c.close()
    await deckd.close()
    await rt.cleanup()
  }
}

test('history: the exit record carries output written just before the child exits', async () => {
  // The child prints the marker and exits at once; nothing waits for the
  // marker before the exit. The stall makes deckd receive both together.
  const script = "process.stdout.write('\\x1b[33mLAST-WORDS-7f3a\\x1b[0m\\r\\n'); require('node:fs').writeFileSync(FLAG, ''); process.exit(0)"
  const rec = await exitRecordOf(script, { stall: true })
  assert.equal(rec.code, 0)
  assert.match(rec.history.data, /LAST-WORDS-7f3a/, JSON.stringify(rec.history.data.slice(-200)))
})

test('history: the exit record caps history.data at the byte cap, starting right after a CRLF', async () => {
  const cap = 3000
  const script = "let s = ''; for (let i = 0; i < 300; i++) s += `\\x1b[3${i % 8}mrow ${i} çé\\x1b[0m\\r\\n`; process.stdout.write(s, () => process.exit(0))"
  const rec = await exitRecordOf(script, { historyCap: cap })
  const data = rec.history.data
  assert.ok(data.length > 0)
  assert.ok(Buffer.byteLength(data) <= cap, `history.data is ${Buffer.byteLength(data)} bytes`)
  // the newest rows stay, the oldest are dropped
  assert.match(data, /row 299 çé/)
  assert.doesNotMatch(data, /row 0 /)
  // a whole serialized line: its colour, then the row text up to the CRLF
  assert.match(data, /^\x1b\[3\dmrow \d+ çé\r\n/, JSON.stringify(data.slice(0, 40)))
})
