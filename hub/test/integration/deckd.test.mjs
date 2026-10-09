import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { stat, mkdir, chmod, mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { cmdShim } from '../helpers/fake-bin.mjs'
import { posixTest } from '../helpers/platform.mjs'
import { endpoint, endpointSecret, deckDir } from '../../platform/index.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { encode, createLineDecoder } from '../../deckd/protocol.mjs'
import { PtyHost, RESIZE_MIN_INTERVAL_MS } from '../../deckd/pty-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const mainPath = path.resolve(here, '..', '..', 'deckd', 'main.mjs')
const stubScript = path.join(here, 'stubs', 'claude')
const QUEUE_CAP = 16 * 1024
const onWindows = process.platform === 'win32'

/** CSI sequences (`ESC [ ... final`) and OSC strings (`ESC ] ... BEL or ST`), one after another, at the start of a string. */
const LEADING_ESCAPES = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+/

/**
 * Raw PTY output as the assertions read it. On Windows ConPTY starts the
 * stream with mode and repaint sequences (the VM run showed
 * `ESC[?9001h ESC[?1004h ...` before READY), so those leading escapes are
 * dropped there. Elsewhere the bytes are returned unchanged.
 * @param {string} s
 * @returns {string}
 */
function rawStart (s) {
  return onWindows ? s.replace(LEADING_ESCAPES, '') : s
}

/** CSI sequences and OSC strings anywhere in a string. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * Raw PTY output with every escape sequence dropped, on Windows only: on the
 * Windows 11 VM the count below found 199 of 200 written lines in ConPTY's
 * output, presumably one behind a repaint sequence (inferred; the bytes were
 * not inspected). Elsewhere the bytes are returned unchanged.
 * @param {string} s
 * @returns {string}
 */
function plainText (s) {
  return onWindows ? s.replace(ESCAPES, '') : s
}

/**
 * A directory holding a `claude` deckd can run that runs the stub. POSIX: the
 * stubs directory itself, whose `claude` is a node script with a shebang.
 * Windows: a temp directory with an npm cmd-shim `claude.cmd` and an entry
 * module beside it that imports the stub, because the shim addresses a script
 * relative to its own directory.
 * @returns {Promise<{ dir: string, claude: string, cleanup: () => Promise<void> }>}
 */
async function stubLauncher () {
  if (!onWindows) return { dir: path.dirname(stubScript), claude: stubScript, cleanup: async () => {} }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-stub-'))
  await writeFile(path.join(dir, 'stub-entry.mjs'), `await import(${JSON.stringify(pathToFileURL(stubScript).href)})\n`)
  const claude = path.join(dir, 'claude.cmd')
  await writeFile(claude, cmdShim('stub-entry.mjs'))
  return { dir, claude, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

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
  // When deckd goes away, answer every pending and later request with
  // `closed` instead of leaving the test waiting on it forever.
  const closedAnswer = { ok: false, error: { code: 'closed', message: 'deckd connection closed' } }
  socket.on('close', () => {
    for (const resolve of pending.values()) resolve(closedAnswer)
    pending.clear()
  })
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
      if (socket.destroyed) return Promise.resolve(closedAnswer)
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
/** @type {Awaited<ReturnType<typeof stubLauncher>>} */
let stub
/** @type {import('node:child_process').ChildProcess} */
let deckd
/** @type {string} */
let socketPath
/** @type {Awaited<ReturnType<typeof connect>>} */
let c
let deckdStderr = ''
/** Set by a test that stops deckd on purpose, and by after(). */
let stoppingDeckd = false
/** @type {string | null} */
let deckdDied = null

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

/**
 * Poll the `screen` op until `pred(lines)` holds, so a test waits on deckd's
 * screen model instead of on streamed output it may have attached too late for.
 * @param {string} id
 * @param {(lines: string[]) => boolean} pred
 * @returns {Promise<string[]>}
 */
async function waitScreen (id, pred, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const res = await c.request('screen', { ptyId: id, scrollback: 0 })
    if (res.ok && pred(res.lines)) return res.lines
    if (Date.now() > end) throw new Error(`timed out waiting on the screen of ${id}: ${JSON.stringify(res.lines ?? res)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Spawn the stub through deckd and wait until it has printed READY.
 * @param {Record<string, string>} [env]
 * @param {string[]} [argv]
 * @returns {Promise<string>} the ptyId
 */
async function spawnReady (env = {}, argv = ['claude']) {
  const res = await c.request('spawn', { cwd: rt.dir, argv, env, cols: 120, rows: 24, origin: 'launched' })
  assert.equal(res.ok, true, JSON.stringify(res))
  await waitScreen(res.ptyId, (lines) => lines[0] === 'READY')
  return res.ptyId
}

before(async () => {
  rt = await makeRuntimeDir()
  stub = await stubLauncher()
  if (!onWindows) {
    // A socket dir left behind with a looser mode must be tightened to 0700.
    await mkdir(deckDir(rt.dir), { mode: 0o755 })
    await chmod(deckDir(rt.dir), 0o755)
  }
  deckd = spawn(process.execPath, [mainPath], {
    env: {
      ...rt.env,
      PATH: [stub.dir, rt.env.PATH].join(path.delimiter),
      DECKD_OUTPUT_QUEUE_CAP: String(QUEUE_CAP),
      // no login-shell probe: the test never runs the owner's profile
      DECKD_LOGIN_ENV: 'inherit'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deckd did not start: ${deckdStderr}`)), 5000)
    deckd.stderr?.on('data', (d) => {
      deckdStderr += d
      if (deckdStderr.includes('deckd listening on')) {
        clearTimeout(timer)
        resolve(undefined)
      }
    })
    deckd.once('exit', (code) => reject(new Error(`deckd exited ${code}: ${deckdStderr}`)))
  })
  // On win32 the pipe name hashes the deckd key, which deckd writes when it starts listening, so it is computed now.
  socketPath = endpoint(rt.dir, 'deckd')
  // A deckd that dies mid-file takes every later test down with it; print
  // why at once, and fail every test that ends after it (afterEach below).
  deckd.on('exit', (code, signal) => {
    if (stoppingDeckd) return
    deckdDied = `deckd exited unexpectedly (code ${code}, signal ${signal}); its stderr:\n${deckdStderr}`
    process.stderr.write(deckdDied + '\n')
  })
  c = await connect(socketPath)
})

// A throw in a top-level after() did not fail the run (node 26.7.0), so the
// check runs after each test instead.
afterEach(() => {
  if (deckdDied) throw new Error(deckdDied)
})

after(async () => {
  c?.close()
  stoppingDeckd = true
  if (deckd && deckd.exitCode === null) {
    const exited = new Promise((resolve) => deckd.once('exit', resolve))
    deckd.kill('SIGTERM')
    await exited
  }
  await rt?.cleanup()
  await stub?.cleanup()
})

/** @type {string} */
let ptyId

posixTest('socket is 0600 inside a 0700 dir, even when the dir existed at 0755', async () => {
  assert.equal(path.dirname(socketPath), deckDir(rt.dir))
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

test('spawn of anything whose basename is not claude fails with spawn_refused', async () => {
  for (const argv0 of ['bash', 'notclaude', '/some/dir/xclaude', 'claude/sh']) {
    const res = await c.request('spawn', { cwd: rt.dir, argv: [argv0], env: {}, cols: 80, rows: 24, origin: 'launched' })
    assert.equal(res.ok, false, argv0)
    assert.equal(res.error.code, 'spawn_refused', argv0)
  }
})

test('attach streams output and a terminal write reaches the stub', async () => {
  const att = await c.request('attach', { ptyId, stream: true })
  assert.equal(att.ok, true)
  assert.deepEqual([att.cols, att.rows], [80, 24])
  const attached = await c.waitFor((e) => e.ev === 'client' && e.ptyId === ptyId && e.change === 'attached')
  // kind and name only: the client's pid is not broadcast
  assert.deepEqual(attached.client, { kind: 'server', name: 'test' })
  // attach does not replay earlier output, so READY is read from the screen model
  await waitScreen(ptyId, (lines) => lines[0] === 'READY')
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
  const scrollback = rawStart(Buffer.from(res.scrollback, 'base64').toString())
  assert.ok(scrollback.startsWith('READY'), JSON.stringify(scrollback.slice(0, 40)))
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

posixTest('a client that stops reading receives dropped after the cap, then output again', {
  reason: 'on a Windows 11 VM the 2 MiB keystroke flood did not reach the ConPTY screen within 30 s'
}, async () => {
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
    // The flood went on after the first drop, so a second `dropped` reports
    // the bytes dropped while the backlog was flushed.
    const more = await slow.waitFor((e) => e.ev === 'dropped' && e.ptyId === ptyId && e !== dropped, 10000)
    assert.ok(more.bytes > 0)
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

test('an absolute path whose basename is claude is accepted', async () => {
  // POSIX: the stub itself; Windows: its absolute claude.cmd shim.
  const id = await spawnReady({}, [stub.claude])
  await c.request('kill', { ptyId: id, signal: 'SIGTERM', graceMs: 2000 })
  const ev = await c.waitFor((e) => e.ev === 'exit' && e.ptyId === id)
  // A signal reaches the process group only on POSIX; win32 kill is taskkill /F.
  if (!onWindows) assert.equal(ev.signal, 'SIGTERM')
})

posixTest('kill escalates to SIGKILL after graceMs when SIGTERM is ignored', { reason: 'win32 kill is taskkill /F whatever the signal' }, async () => {
  const id = await spawnReady({ STUB_IGNORE_SIGTERM: '1' })
  const t0 = Date.now()
  await c.request('kill', { ptyId: id, signal: 'SIGTERM', graceMs: 300 })
  const ev = await c.waitFor((e) => e.ev === 'exit' && e.ptyId === id, 5000)
  assert.equal(ev.signal, 'SIGKILL')
  assert.ok(ev.at - t0 >= 250, `exit after ${ev.at - t0} ms`)
})

test('screen scrollback returns the last N lines of the ring', async () => {
  const id = await spawnReady()
  let text = ''
  for (let i = 0; i < 200; i++) text += 'L' + String(i).padStart(3, '0') + 'y'.repeat(96) + '\n'
  assert.equal(text.length, 200 * 101)
  await c.request('write', { ptyId: id, data: Buffer.from(text).toString('base64'), source: { kind: 'browser' } })
  await waitScreen(id, (lines) => lines.some((l) => l.startsWith('L199')))
  // more lines than N, and far more bytes than N
  const tail = Buffer.from((await c.request('screen', { ptyId: id, scrollback: 50 })).scrollback, 'base64').toString()
  const rows = tail.split('\n')
  assert.equal(rows.pop(), '')
  assert.equal(rows.length, 50)
  assert.match(rows[0], /^L150y/)
  assert.match(rows[49], /^L199y/)
  // N larger than the ring: everything, from the first byte
  const all = Buffer.from((await c.request('screen', { ptyId: id, scrollback: 5000 })).scrollback, 'base64').toString()
  assert.ok(rawStart(all).startsWith('READY\r'), JSON.stringify(all.slice(0, 40)))
  assert.equal(plainText(all).split('\n').filter((l) => /^L\d{3}y/.test(l)).length, 200)
  await c.request('kill', { ptyId: id, signal: 'SIGKILL', graceMs: 0 })
  await c.waitFor((e) => e.ev === 'exit' && e.ptyId === id)
})

test('no screen event for a PTY follows its exit event', async () => {
  const id = await spawnReady()
  await c.request('watchScreen', { ptyId: id, on: true })
  await c.request('write', { ptyId: id, data: Buffer.from('\nrow-A').toString('base64'), source: { kind: 'browser' } })
  await c.waitFor((e) => e.ev === 'screen' && e.ptyId === id && e.lines.includes('row-A'))
  // A second change inside the 250 ms throttle window, then exit before it is sent.
  await c.request('write', { ptyId: id, data: Buffer.from('\r\nrow-B').toString('base64'), source: { kind: 'browser' } })
  await waitScreen(id, (lines) => lines.includes('row-B'))
  await c.request('kill', { ptyId: id, signal: 'SIGKILL', graceMs: 0 })
  const exit = await c.waitFor((e) => e.ev === 'exit' && e.ptyId === id)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const after = c.events.slice(c.events.indexOf(exit) + 1).filter((e) => e.ev === 'screen' && e.ptyId === id)
  assert.deepEqual(after, [])
})

test('a resize deferred by the once-per-second rule, then kill: deckd stays up and reports the exit', async () => {
  const id = await spawnReady()
  await c.request('write', { ptyId: id, data: Buffer.from('x').toString('base64'), source: { kind: 'browser', name: 'r' } })
  await c.request('resize', { ptyId: id, cols: 100, rows: 30, source: { kind: 'browser', name: 'r' } })
  // Inside the interval: this one waits on the resize timer.
  const deferred = await c.request('resize', { ptyId: id, cols: 110, rows: 33, source: { kind: 'browser', name: 'r' } })
  assert.deepEqual([deferred.cols, deferred.rows], [100, 30])
  await c.request('kill', { ptyId: id, signal: 'SIGKILL', graceMs: 0 })
  await c.waitFor((e) => e.ev === 'exit' && e.ptyId === id)
  // Past the moment the deferred resize was due.
  await new Promise((resolve) => setTimeout(resolve, RESIZE_MIN_INTERVAL_MS + 200))
  assert.equal((await c.request('ping')).ok, true)
  assert.equal(deckd.exitCode, null)
  assert.equal(deckdDied, null)
})

/**
 * Spawn the stub in this process through PtyHost and wait for READY.
 * @param {Record<string, string>} [env]
 */
async function localHost (env = {}) {
  /** @type {(v: { code: number, signal: string | null }) => void} */
  let onExit = () => {}
  /** @type {Promise<{ code: number, signal: string | null }>} */
  const exited = new Promise((resolve) => { onExit = resolve })
  const host = PtyHost.spawn({ cwd: rt.dir, argv: [stub.claude], env, cols: 80, rows: 24 }, {
    onOutput: () => {},
    onExit: (_h, exit) => onExit(exit)
  })
  await until(() => host.ring.snapshot().toString().includes('READY'), 'READY from the local stub')
  return { host, exited }
}

test('a deferred resize whose PTY fd is already closed does not throw out of its timer', async () => {
  // The crash seen under load: the timer fires after node-pty closed the fd
  // but before onExit marked the PTY exited, and resize throws EBADF. That
  // window cannot be hit on demand, so proc.resize is replaced with one that
  // throws what node-pty throws there.
  const { host, exited } = await localHost()
  try {
    host.requestResize(100, 30, { kind: 'browser' })
    host.requestResize(110, 33, { kind: 'browser' })
    assert.ok(host.resizeTimer, 'the second resize is deferred')
    let calls = 0
    host.proc.resize = () => {
      calls++
      throw new Error('ioctl(2) failed, EBADF')
    }
    await until(() => calls > 0, 'the deferred resize to run', RESIZE_MIN_INTERVAL_MS + 5000)
    await new Promise((resolve) => setImmediate(resolve))
    // The size did not change, and no later resize reaches the dead fd.
    assert.deepEqual([host.cols, host.rows], [100, 30])
    host.lastResizeAt = 0
    host.requestResize(120, 40, { kind: 'browser' })
    assert.equal(calls, 1)
  } finally {
    host.kill('SIGKILL', 0)
    await exited
    host.dispose()
  }
})

test('kill cancels a deferred resize and ignores later ones', async () => {
  // SIGTERM is ignored by the stub, so the PTY stays alive after kill and
  // only the kill itself can have cancelled the timer.
  const { host, exited } = await localHost({ STUB_IGNORE_SIGTERM: '1' })
  try {
    host.requestResize(100, 30, { kind: 'browser' })
    host.requestResize(110, 33, { kind: 'browser' })
    assert.ok(host.resizeTimer, 'the second resize is deferred')
    let calls = 0
    host.proc.resize = () => { calls++ }
    host.kill('SIGTERM', 60000)
    assert.equal(host.resizeTimer, null)
    host.lastResizeAt = 0
    host.requestResize(120, 40, { kind: 'browser' })
    assert.equal(calls, 0)
    assert.deepEqual([host.cols, host.rows], [100, 30])
  } finally {
    host.kill('SIGKILL', 0)
    await exited
    host.dispose()
  }
})

posixTest('SIGTERM stops deckd cleanly and kills its PTYs', { reason: 'SIGTERM to deckd, and a socket file removed on close' }, async () => {
  const res = await c.request('spawn', { cwd: rt.dir, argv: ['claude'], env: {}, cols: 80, rows: 24, origin: 'launched' })
  assert.equal(res.ok, true)
  const exited = new Promise((resolve) => deckd.once('exit', (code) => resolve(code)))
  stoppingDeckd = true
  deckd.kill('SIGTERM')
  assert.equal(await exited, 0)
  assert.throws(() => process.kill(res.pid, 0), { code: 'ESRCH' })
  await assert.rejects(stat(socketPath), { code: 'ENOENT' })
})

test('deckd writes the deckd key on win32 and listens on the pipe hashed from it; on POSIX it writes none', () => {
  const keyFile = (onWindows ? path.win32 : path.posix).join(deckDir(rt.dir), 'endpoint-deckd.key')
  if (onWindows) {
    const secret = readFileSync(keyFile, 'utf8')
    assert.match(secret, /^[0-9a-f]{64}$/)
    assert.equal(socketPath, endpoint(rt.dir, 'deckd', { secret }))
  } else {
    assert.equal(existsSync(keyFile), false)
    assert.equal(socketPath, path.join(deckDir(rt.dir), 'deckd.sock'))
  }
  assert.ok(deckdStderr.includes(`deckd listening on ${socketPath}`), deckdStderr)
})

test('with platform win32 deckd writes a new key at every start, a client reads the key at every connect, and without a key a client finds no deckd', async () => {
  // win32 is injected. Off Windows the pipe name and the relative base's win32 paths are files and
  // dirs in a temp dir made the working directory for this test only.
  const cwd = process.cwd()
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'deckd-key-'))
  process.chdir(scratch)
  /** @type {Awaited<ReturnType<typeof startDeckd>> | undefined} */
  let first
  try {
    first = await startDeckd({ runtimeDir: 'base', platform: 'win32', loginEnv: {} })
    const secret = endpointSecret('base', { platform: 'win32', name: 'deckd' })
    assert.match(secret ?? '', /^[0-9a-f]{64}$/)
    assert.equal(first.socketPath, endpoint('base', 'deckd', { platform: 'win32', secret }))
    await assert.rejects(startDeckd({ runtimeDir: 'base', platform: 'win32', loginEnv: {} }), { message: `another deckd is listening on ${first.socketPath}` })
    const client = await connectDeckd({ runtimeDir: 'base', platform: 'win32', kind: 'server', name: 'key' })
    try {
      assert.equal(client.bootId, first.bootId)
    } finally {
      client.close()
    }
    const firstPipe = first.socketPath
    await first.close()
    // A clean close removes the key: a client finds no deckd rather than dialing the dead pipe's name.
    await assert.rejects(connectDeckd({ runtimeDir: 'base', platform: 'win32', kind: 'server' }), { code: 'ENOENT', message: /^deckd is not running: no endpoint key in / })
    first = await startDeckd({ runtimeDir: 'base', platform: 'win32', loginEnv: {} })
    const fresh = endpointSecret('base', { platform: 'win32', name: 'deckd' })
    assert.notEqual(fresh, secret, 'a restart writes a new key')
    assert.notEqual(first.socketPath, firstPipe)
    assert.equal(first.socketPath, endpoint('base', 'deckd', { platform: 'win32', secret: fresh }))
    const again = await connectDeckd({ runtimeDir: 'base', platform: 'win32', kind: 'server', name: 'key' })
    try {
      assert.equal(again.bootId, first.bootId, 'the client read the new key')
    } finally {
      again.close()
    }
    await assert.rejects(connectDeckd({ runtimeDir: 'nokey', platform: 'win32', kind: 'server' }), { code: 'ENOENT', message: /^deckd is not running: no endpoint key in / })
  } finally {
    await first?.close()
    process.chdir(cwd)
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
