// Exit criterion 5 of M0: a browser session survives the web server dying.
// deckd and the spike server run as separate processes with the fake claude
// first on PATH; the spike server is killed with SIGKILL and a new one
// reattaches to the same PTY.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { encode, createLineDecoder } from '../../deckd/protocol.mjs'
import { startSpikeServer } from '../../spike/server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hubDir = path.resolve(here, '..', '..')
const deckdMain = path.join(hubDir, 'deckd', 'main.mjs')
const spikeMain = path.join(hubDir, 'spike', 'server.mjs')
const echoScript = path.join(hubDir, 'test', 'fixtures', 'scripts', 'echo.json')
const DEADLINE = 10000

/** @type {Awaited<ReturnType<typeof makeRuntimeDir>>} */
let rt
/** @type {Awaited<ReturnType<typeof fakeBin>>} */
let fake
/** @type {import('node:child_process').ChildProcess} */
let deckd
/** @type {Set<import('node:child_process').ChildProcess>} */
const spikes = new Set()

/**
 * Start a child and resolve once its stderr matches `ready`.
 * @param {string} script
 * @param {NodeJS.ProcessEnv} env
 * @param {RegExp} ready
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, match: RegExpMatchArray }>}
 */
function startChild (script, env, ready) {
  const proc = spawn(process.execPath, [script], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} did not start: ${stderr}`)), DEADLINE)
    proc.stderr?.on('data', (d) => {
      stderr += d
      const match = stderr.match(ready)
      if (match) {
        clearTimeout(timer)
        resolve({ proc, match })
      }
    })
    proc.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${script} exited ${code}: ${stderr}`))
    })
  })
}

/**
 * Start a spike server process on a free port.
 * @param {NodeJS.ProcessEnv} [extra]
 */
async function startSpike (extra = {}) {
  const { proc, match } = await startChild(spikeMain, { ...rt.env, SPIKE_PORT: '0', ...extra }, /spike listening on http:\/\/(\S+):(\d+)\//)
  spikes.add(proc)
  return { proc, host: match[1], port: Number(match[2]) }
}

/**
 * Run the spike server and collect its exit code and stderr.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
function runSpikeToExit (env) {
  const proc = spawn(process.execPath, [spikeMain], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  spikes.add(proc)
  let stderr = ''
  proc.stderr?.on('data', (d) => { stderr += d })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`spike did not exit: ${stderr}`))
    }, DEADLINE)
    proc.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

/**
 * A direct deckd client for assertions: request/response by id.
 * @param {string} socketPath
 */
async function deckdClient (socketPath) {
  const socket = net.connect(socketPath)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  let nextId = 1
  /** @type {Map<number, (msg: any) => void>} */
  const pending = new Map()
  socket.on('data', createLineDecoder((msg) => {
    const resolve = msg.id !== undefined ? pending.get(msg.id) : undefined
    if (resolve) {
      pending.delete(msg.id)
      resolve(msg)
    }
  }, () => {}))
  /**
   * @param {string} op
   * @param {object} [fields]
   * @returns {Promise<any>}
   */
  const request = (op, fields = {}) => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    socket.write(encode({ id, op, ...fields }))
  })
  const hello = await request('hello', { proto: 1, client: { kind: 'terminal', name: 'test', pid: process.pid } })
  assert.equal(hello.ok, true)
  return { request, close: () => socket.destroy() }
}

/**
 * A browser stand-in: collects spike messages and the terminal bytes it got.
 * @param {number} port
 * @param {string} query
 */
async function browser (port, query) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`)
  /** @type {any[]} */
  const msgs = []
  /** @type {Set<() => void>} */
  const waiters = new Set()
  ws.on('message', (raw) => {
    msgs.push(JSON.parse(raw.toString()))
    for (const w of waiters) w()
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return {
    msgs,
    /** Bytes of the replay followed by live output, as text. */
    text () {
      return msgs.filter((m) => m.t === 'replay' || m.t === 'out')
        .map((m) => Buffer.from(m.data, 'base64').toString('utf8')).join('')
    },
    /** @param {string} data */
    type (data) { ws.send(JSON.stringify({ t: 'in', data })) },
    /**
     * Resolve with the first message matching `pred`, already received or not.
     * @param {(m: any) => boolean} pred
     * @param {string} what
     * @returns {Promise<any>}
     */
    waitMsg (pred, what) {
      return this.until(() => msgs.find(pred), what)
    },
    /**
     * Resolve once `fn` returns a truthy value, checked on every message.
     * @template T
     * @param {() => T} fn
     * @param {string} what
     * @returns {Promise<T>}
     */
    until (fn, what) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const v = fn()
          if (!v) return
          waiters.delete(check)
          clearTimeout(timer)
          resolve(v)
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`timed out waiting for ${what}; got ${JSON.stringify(msgs.map((m) => m.t))} text ${JSON.stringify(this.text())}`))
        }, DEADLINE)
        waiters.add(check)
        check()
      })
    },
    close () { ws.terminate() }
  }
}

/**
 * Wait for a child process to exit.
 * @param {import('node:child_process').ChildProcess} proc
 */
function exited (proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => proc.once('exit', resolve))
}

before(async () => {
  rt = await makeRuntimeDir()
  fake = await fakeBin({ script: echoScript })
  const { proc } = await startChild(deckdMain, { ...fake.env, XDG_RUNTIME_DIR: rt.dir, HOME: rt.dir }, /deckd listening on/)
  deckd = proc
})

after(async () => {
  for (const p of spikes) {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
    await exited(p)
  }
  if (deckd && deckd.exitCode === null) {
    deckd.kill('SIGTERM')
    await exited(deckd)
  }
  await fake?.cleanup()
  await rt?.cleanup()
})

test('the spike server refuses any host but 127.0.0.1', async () => {
  const { code, stderr } = await runSpikeToExit({ ...rt.env, SPIKE_PORT: '0', SPIKE_HOST: '0.0.0.0' })
  assert.notEqual(code, 0)
  assert.match(stderr, /127\.0\.0\.1 only, refusing host 0\.0\.0\.0/)
})

test('the spike server listens on 127.0.0.1 only', async () => {
  const spike = await startSpike()
  try {
    assert.equal(spike.host, '127.0.0.1')
    // Every non-loopback IPv4 address of this machine must refuse the port.
    const others = Object.values(os.networkInterfaces()).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => /** @type {os.NetworkInterfaceInfo} */ (a).address)
    for (const addr of others) {
      const refused = await new Promise((resolve) => {
        const s = net.connect(spike.port, addr)
        s.once('connect', () => { s.destroy(); resolve(false) })
        s.once('error', () => resolve(true))
      })
      assert.equal(refused, true, `port ${spike.port} answered on ${addr}`)
    }
    // Pinned without relying on the machine having another interface:
    // the loopback name localhost over IPv6 (::1) is not bound either.
    const v6refused = await new Promise((resolve) => {
      const s = net.connect(spike.port, '::1')
      s.once('connect', () => { s.destroy(); resolve(false) })
      s.once('error', () => resolve(true))
    })
    assert.equal(v6refused, true, `port ${spike.port} answered on ::1`)
  } finally {
    spike.proc.kill('SIGKILL')
    await exited(spike.proc)
  }
})

test('the spike server serves the page, main.js and the xterm files, and nothing else', async () => {
  const spike = await startSpike()
  try {
    const base = `http://127.0.0.1:${spike.port}`
    const page = await fetch(`${base}/?pty=x`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<script src="\/main\.js"><\/script>/)
    for (const p of ['/main.js', '/xterm/xterm.js', '/xterm/xterm.css', '/xterm/addon-fit.js']) {
      const res = await fetch(base + p)
      assert.equal(res.status, 200, p)
      assert.ok((await res.arrayBuffer()).byteLength > 0, p)
    }
    for (const p of ['/server.mjs', '/../package.json', '/node_modules/ws/package.json']) {
      const res = await fetch(base + p)
      assert.equal(res.status, 404, p)
      await res.arrayBuffer()
    }
  } finally {
    spike.proc.kill('SIGKILL')
    await exited(spike.proc)
  }
})

test('a PTY survives the spike server being SIGKILLed and a new server reattaches with a replay', async () => {
  const direct = await deckdClient(path.join(rt.dir, 'fleetmates-deck', 'deckd.sock'))
  try {
    const first = await startSpike()
    const b1 = await browser(first.port, new URLSearchParams({ spawn: '1', cwd: rt.dir }).toString())
    const { ptyId } = await b1.waitMsg((m) => m.t === 'pty', 'the pty message')
    assert.match(ptyId, /^pty_[0-9a-f]{8}$/)
    await b1.waitMsg((m) => m.t === 'replay', 'the first replay')
    b1.type('abc')
    await b1.until(() => b1.text().includes('abc'), 'abc echoed')
    const status = await b1.waitMsg((m) => m.t === 'status', 'the lastInputFrom status')
    assert.deepEqual(status.lastInputFrom, { kind: 'browser' })

    first.proc.kill('SIGKILL')
    await exited(first.proc)
    b1.close()

    const list = await direct.request('list')
    assert.equal(list.ok, true)
    const pty = list.ptys.find((/** @type {any} */ p) => p.ptyId === ptyId)
    assert.ok(pty, `pty ${ptyId} is gone after the spike server died: ${JSON.stringify(list.ptys)}`)
    assert.equal(process.kill(pty.pid, 0), true)

    const second = await startSpike()
    const b2 = await browser(second.port, new URLSearchParams({ pty: ptyId }).toString())
    const replay = await b2.waitMsg((m) => m.t === 'replay', 'the reattach replay')
    assert.match(Buffer.from(replay.data, 'base64').toString('utf8'), /abc/)
    const hello = await b2.waitMsg((m) => m.t === 'pty', 'the pty message after reattach')
    assert.deepEqual(hello.lastInputFrom, { kind: 'browser' })
    b2.type('def')
    await b2.until(() => b2.text().includes('abcdef'), 'def echoed after abc')
    b2.close()
  } finally {
    direct.close()
  }
})

test('output deckd sends before the screen response is not forwarded twice', async () => {
  // A scripted deckd: while answering `screen` it first emits output X, which
  // the replay already holds, then the response, then output Y.
  const own = await makeRuntimeDir()
  await mkdir(path.join(own.dir, 'fleetmates-deck'), { mode: 0o700 })
  const b64 = (/** @type {string} */ s) => Buffer.from(s).toString('base64')
  const fakeDeckd = net.createServer((socket) => {
    socket.on('data', createLineDecoder((req) => {
      const reply = (/** @type {object} */ fields) => socket.write(encode({ id: req.id, ok: true, ...fields }))
      if (req.op === 'hello') reply({ proto: 1, deckdVersion: 'fake', bootId: '0' })
      else if (req.op === 'attach') reply({ cols: 80, rows: 24 })
      else if (req.op === 'list') reply({ ptys: [] })
      else if (req.op === 'screen') {
        socket.write(encode({ ev: 'output', ptyId: 'pty_00000000', data: b64('X') }))
        reply({ rev: 1, cols: 80, rows: 24, cursor: { x: 1, y: 0 }, lines: ['X'], scrollback: b64('X') })
        socket.write(encode({ ev: 'output', ptyId: 'pty_00000000', data: b64('Y') }))
      }
    }, () => {}))
    socket.on('error', () => {})
  })
  await new Promise((resolve) => fakeDeckd.listen(path.join(own.dir, 'fleetmates-deck', 'deckd.sock'), () => resolve(undefined)))
  const spike = await startSpikeServer({ runtimeDir: own.dir, port: 0 })
  try {
    const b = await browser(spike.port, 'pty=pty_00000000')
    await b.until(() => b.text().includes('Y'), 'output Y')
    assert.equal(b.text(), 'XY')
    b.close()
  } finally {
    await spike.close()
    await new Promise((resolve) => fakeDeckd.close(() => resolve(undefined)))
    await own.cleanup()
  }
})
