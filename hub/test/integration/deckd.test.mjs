import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { encode, createLineDecoder } from '../../deckd/protocol.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const mainPath = path.resolve(here, '..', '..', 'deckd', 'main.mjs')
const stubDir = path.join(here, 'stubs')
const QUEUE_CAP = 16 * 1024

/**
 * A deckd client for tests: request/response by id, events collected in order.
 * @param {string} socketPath
 */
async function connect (socketPath) {
  const socket = net.connect(socketPath)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  let nextId = 1
  /** @type {Map<number, (msg: any) => void>} */
  const pending = new Map()
  /** @type {any[]} */
  const events = []
  /** @type {Set<() => void>} */
  const waiters = new Set()
  socket.on('data', createLineDecoder((msg) => {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = /** @type {(msg: any) => void} */ (pending.get(msg.id))
      pending.delete(msg.id)
      resolve(msg)
    } else {
      events.push(msg)
      for (const w of waiters) w()
    }
  }, () => {}))
  return {
    socket,
    events,
    /**
     * @param {string} op
     * @param {object} [fields]
     * @returns {Promise<any>}
     */
    request (op, fields = {}) {
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, resolve)
        socket.write(encode({ id, op, ...fields }))
      })
    },
    /**
     * Resolve with the first event matching `pred`, already received or not.
     * @param {(ev: any) => boolean} pred
     * @param {number} [timeoutMs]
     * @returns {Promise<any>}
     */
    waitFor (pred, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = events.find(pred)
          if (!found) return false
          waiters.delete(check)
          clearTimeout(timer)
          resolve(found)
          return true
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.ev))}`))
        }, timeoutMs)
        waiters.add(check)
        check()
      })
    },
    /**
     * Decoded output bytes received so far for one PTY.
     * @param {string} ptyId
     * @returns {string}
     */
    output (ptyId) {
      return events.filter((e) => e.ev === 'output' && e.ptyId === ptyId)
        .map((e) => Buffer.from(e.data, 'base64').toString('utf8')).join('')
    },
    close () { socket.destroy() }
  }
}

/** @type {Awaited<ReturnType<typeof makeRuntimeDir>>} */
let rt
/** @type {import('node:child_process').ChildProcess} */
let deckd
/** @type {string} */
let socketPath
/** @type {Awaited<ReturnType<typeof connect>>} */
let c

/**
 * Poll until `fn` returns true.
 * @param {() => boolean} fn
 * @param {string} what
 */
async function until (fn, what, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

before(async () => {
  rt = await makeRuntimeDir()
  socketPath = path.join(rt.dir, 'fleetmates-deck', 'deckd.sock')
  deckd = spawn(process.execPath, [mainPath], {
    env: {
      ...rt.env,
      PATH: [stubDir, rt.env.PATH].join(path.delimiter),
      DECKD_OUTPUT_QUEUE_CAP: String(QUEUE_CAP)
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deckd did not start: ${stderr}`)), 5000)
    deckd.stderr?.on('data', (d) => {
      stderr += d
      if (stderr.includes('deckd listening on')) {
        clearTimeout(timer)
        resolve(undefined)
      }
    })
    deckd.once('exit', (code) => reject(new Error(`deckd exited ${code}: ${stderr}`)))
  })
  c = await connect(socketPath)
})

after(async () => {
  c?.close()
  if (deckd && deckd.exitCode === null) {
    const exited = new Promise((resolve) => deckd.once('exit', resolve))
    deckd.kill('SIGTERM')
    await exited
  }
  await rt?.cleanup()
})

/** @type {string} */
let ptyId

test('socket is 0600 inside a 0700 dir', async () => {
  assert.equal((await stat(path.dirname(socketPath))).mode & 0o777, 0o700)
  const st = await stat(socketPath)
  assert.ok(st.isSocket())
  assert.equal(st.mode & 0o777, 0o600)
})

test('ops before hello are refused', async () => {
  const other = await connect(socketPath)
  try {
    const res = await other.request('list')
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'hello_required')
  } finally {
    other.close()
  }
})

test('hello answers proto 1 and a bootId', async () => {
  const res = await c.request('hello', { proto: 1, client: { kind: 'server', name: 'test', pid: process.pid } })
  assert.equal(res.ok, true)
  assert.equal(res.proto, 1)
  assert.match(res.bootId, /^[0-9a-f]{16}$/)
  assert.equal(typeof res.deckdVersion, 'string')
})

test('bad JSON is answered with bad_json and the connection stays open', async () => {
  c.socket.write('{nope\n')
  const ev = await c.waitFor((e) => e.ok === false && e.error?.code === 'bad_json')
  assert.equal(ev.id, undefined)
  const res = await c.request('ping')
  assert.equal(res.ok, true)
  assert.equal(typeof res.at, 'number')
})

test('spawn of claude returns a ptyId and a spawned event', async () => {
  const res = await c.request('spawn', { cwd: rt.dir, argv: ['claude'], env: {}, cols: 80, rows: 24, origin: 'launched' })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.match(res.ptyId, /^pty_[0-9a-f]{8}$/)
  assert.equal(typeof res.pid, 'number')
  ptyId = res.ptyId
  const ev = await c.waitFor((e) => e.ev === 'spawned' && e.ptyId === ptyId)
  assert.equal(ev.pid, res.pid)
  assert.deepEqual(ev.argv, ['claude'])
  assert.equal(ev.origin, 'launched')
})

test('spawn of anything but claude fails with spawn_refused', async () => {
  const res = await c.request('spawn', { cwd: rt.dir, argv: ['bash'], env: {}, cols: 80, rows: 24, origin: 'launched' })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'spawn_refused')
})

test('attach streams output and a terminal write reaches the stub', async () => {
  const att = await c.request('attach', { ptyId, stream: true })
  assert.equal(att.ok, true)
  assert.deepEqual([att.cols, att.rows], [80, 24])
  await c.waitFor((e) => e.ev === 'client' && e.ptyId === ptyId && e.change === 'attached')
  await until(() => c.output(ptyId).includes('READY'), 'READY in output')
  const res = await c.request('write', { ptyId, data: Buffer.from('hi-kitty').toString('base64'), source: { kind: 'terminal', name: 'kitty' } })
  assert.equal(res.ok, true)
  await until(() => c.output(ptyId).includes('hi-kitty'), 'echo in output')
  const input = await c.waitFor((e) => e.ev === 'input' && e.ptyId === ptyId)
  assert.deepEqual(input.source, { kind: 'terminal', name: 'kitty' })
  assert.equal(input.bytes, 8)
  assert.equal(input.data, undefined)
  const list = await c.request('list')
  const pty = list.ptys.find((/** @type {any} */ p) => p.ptyId === ptyId)
  assert.equal(pty.lastInputFrom.kind, 'terminal')
  assert.equal(pty.lastInputFrom.name, 'kitty')
  assert.deepEqual(pty.clients, [{ kind: 'server', name: 'test' }])
})

test('a browser write flips lastInputFrom to browser', async () => {
  await c.request('write', { ptyId, data: Buffer.from('hi-web').toString('base64'), source: { kind: 'browser', name: 'chromium' } })
  await until(() => c.output(ptyId).includes('hi-web'), 'browser echo in output')
  const list = await c.request('list')
  const pty = list.ptys.find((/** @type {any} */ p) => p.ptyId === ptyId)
  assert.equal(pty.lastInputFrom.kind, 'browser')
})

test('screen returns the READY row', async () => {
  const res = await c.request('screen', { ptyId, scrollback: 4096 })
  assert.equal(res.ok, true)
  assert.equal(res.lines.length, 24)
  assert.equal(res.lines[0], 'READY')
  assert.equal(res.cols, 80)
  assert.ok(Buffer.from(res.scrollback, 'base64').toString().startsWith('READY'))
})

test('watchScreen sends a screen event when rows change', async () => {
  await c.request('watchScreen', { ptyId, on: true })
  await c.request('write', { ptyId, data: Buffer.from('\r\nrow-two').toString('base64'), source: { kind: 'browser', name: 'chromium' } })
  const ev = await c.waitFor((e) => e.ev === 'screen' && e.ptyId === ptyId && e.lines.includes('row-two'))
  assert.ok(ev.changedRows.includes(ev.lines.indexOf('row-two')))
  await c.request('watchScreen', { ptyId, on: false })
})

test('resize follows the last input source only', async () => {
  const notOwner = await c.request('resize', { ptyId, cols: 90, rows: 20, source: { kind: 'terminal', name: 'kitty' } })
  assert.deepEqual([notOwner.cols, notOwner.rows], [80, 24])
  const owner = await c.request('resize', { ptyId, cols: 100, rows: 30, source: { kind: 'browser', name: 'chromium' } })
  assert.deepEqual([owner.cols, owner.rows], [100, 30])
  await until(() => c.output(ptyId).includes('SIZE 100x30'), 'SIZE 100x30 from the stub')
  assert.ok(!c.output(ptyId).includes('SIZE 90x20'))
})

test('a client that stops reading receives dropped after the cap, then output again', async () => {
  // The main client stops streaming so that only `slow` is subject to the cap
  // here; the test then waits on deckd's own screen model, never on how fast
  // this process reads.
  await c.request('attach', { ptyId, stream: false })
  const slow = await connect(socketPath)
  try {
    await slow.request('hello', { proto: 1, client: { kind: 'terminal', name: 'slow' } })
    await slow.request('attach', { ptyId, stream: true })
    slow.socket.pause()
    // 2 MiB of echo: far more than the kernel socket buffer plus the cap.
    const chunk = Buffer.alloc(32 * 1024, 'x').toString('base64')
    for (let i = 0; i < 64; i++) {
      await c.request('write', { ptyId, data: chunk, source: { kind: 'browser', name: 'chromium' } })
    }
    await c.request('write', { ptyId, data: Buffer.from('END-FLOOD').toString('base64'), source: { kind: 'browser', name: 'chromium' } })
    // Output reaches every client before the screen model parses it, so once
    // the marker is on screen deckd has already queued or dropped the flood for `slow`.
    const deadline = Date.now() + 30000
    while (!(await c.request('screen', { ptyId, scrollback: 0 })).lines.some((/** @type {string} */ l) => l.includes('END-FLOOD'))) {
      if (Date.now() > deadline) throw new Error('END-FLOOD never reached the screen model')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    slow.socket.resume()
    const dropped = await slow.waitFor((e) => e.ev === 'dropped' && e.ptyId === ptyId, 10000)
    assert.ok(dropped.bytes > 0)
    // Once the backlog is flushed the client gets output again. Output echoed
    // before deckd has seen that flush is still dropped (and counted in a
    // later `dropped`), so keep typing a marker until one arrives.
    const deadline2 = Date.now() + 10000
    while (!slow.output(ptyId).includes('AFTER-DROP')) {
      if (Date.now() > deadline2) throw new Error('output never reached the client again after the drop')
      await c.request('write', { ptyId, data: Buffer.from('AFTER-DROP').toString('base64'), source: { kind: 'browser', name: 'chromium' } })
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } finally {
    slow.close()
  }
})

test('kill produces an exit event and exits { since } returns it', async () => {
  const since = Date.now() - 1
  const res = await c.request('kill', { ptyId, signal: 'SIGTERM', graceMs: 2000 })
  assert.equal(res.ok, true)
  const ev = await c.waitFor((e) => e.ev === 'exit' && e.ptyId === ptyId)
  assert.equal(typeof ev.at, 'number')
  const exits = await c.request('exits', { since })
  assert.deepEqual(exits.exits.map((/** @type {any} */ e) => e.ptyId), [ptyId])
  assert.deepEqual(exits.exits[0], { ptyId, code: ev.code, signal: ev.signal, at: ev.at })
  const later = await c.request('exits', { since: ev.at + 1 })
  assert.deepEqual(later.exits, [])
  const list = await c.request('list')
  assert.deepEqual(list.ptys, [])
})

test('SIGTERM stops deckd cleanly and kills its PTYs', async () => {
  const res = await c.request('spawn', { cwd: rt.dir, argv: ['claude'], env: {}, cols: 80, rows: 24, origin: 'launched' })
  assert.equal(res.ok, true)
  const exited = new Promise((resolve) => deckd.once('exit', (code) => resolve(code)))
  deckd.kill('SIGTERM')
  assert.equal(await exited, 0)
  assert.throws(() => process.kill(res.pid, 0), { code: 'ESRCH' })
  await assert.rejects(stat(socketPath), { code: 'ENOENT' })
})
