// Exit criterion 5 of M0: a browser session survives the web server dying.
// deckd and the spike server run as separate processes with the fake claude
// first on PATH; the spike server is killed with SIGKILL and a new one
// reattaches to the same PTY.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
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
 * Start a child (cwd: hub/) and resolve once its stdout or stderr matches `ready`.
 * @param {string} script
 * @param {NodeJS.ProcessEnv} env
 * @param {RegExp} ready
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, match: RegExpMatchArray }>}
 */
function startChild (script, env, ready) {
  const proc = spawn(process.execPath, [script], { env, cwd: hubDir, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let stderr = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} did not start: ${stderr}`)), DEADLINE)
    const check = () => {
      const match = out.match(ready) ?? stderr.match(ready)
      if (match) {
        clearTimeout(timer)
        resolve({ proc, match })
      }
    }
    proc.stdout?.on('data', (d) => { out += d; check() })
    proc.stderr?.on('data', (d) => { stderr += d; check() })
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
  const { proc, match } = await startChild(spikeMain, { ...rt.env, SPIKE_PORT: '0', ...extra }, /^http:\/\/(\S+):(\d+)\/#token=([A-Za-z0-9_-]{43})\n/m)
  spikes.add(proc)
  return { proc, host: match[1], port: Number(match[2]), token: match[3] }
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
 * Try a WebSocket upgrade and report the HTTP status of a refusal, or 101.
 * @param {number} port
 * @param {string} query
 * @param {{ origin?: string, host?: string, protocols?: string[] }} headers
 * @returns {Promise<number>}
 */
function upgradeStatus (port, query, { origin, host, protocols = [] }) {
  /** @type {Record<string, string>} */
  const extra = {}
  if (host !== undefined) extra.host = host
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, protocols, origin === undefined ? { headers: extra } : { origin, headers: extra })
  return new Promise((resolve, reject) => {
    ws.once('open', () => { ws.terminate(); resolve(101) })
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode ?? 0) })
    ws.once('error', (err) => reject(err))
  })
}

/**
 * GET a path with an explicit Host header.
 * @param {number} port
 * @param {string} p
 * @param {string} host
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders }>}
 */
function httpGet (port, p, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0, headers: res.headers })
    })
    req.once('error', reject)
  })
}

/**
 * A browser stand-in: collects spike messages and the terminal bytes it got.
 * It sends the Origin and token subprotocol the spike page itself would send.
 * @param {{ port: number, token: string }} spike
 * @param {string} query
 */
async function browser ({ port, token }, query) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, [token], { origin: `http://127.0.0.1:${port}` })
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
    const b1 = await browser(first, new URLSearchParams({ spawn: '1', cwd: rt.dir }).toString())
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
    const b2 = await browser(second, new URLSearchParams({ pty: ptyId }).toString())
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


/**
 * A scripted deckd on its own runtime dir, with a spike server in this
 * process connected to it. `onScreen(n, reply, emit)` answers the n-th
 * `screen` request (1-based).
 * @param {(n: number, reply: (fields: object) => void, emit: (ev: object) => void) => void} onScreen
 */
async function scriptedDeckd (onScreen) {
  const own = await makeRuntimeDir()
  await mkdir(path.join(own.dir, 'fleetmates-deck'), { mode: 0o700 })
  let screens = 0
  const fakeDeckd = net.createServer((socket) => {
    socket.on('data', createLineDecoder((req) => {
      const reply = (/** @type {object} */ fields) => socket.write(encode({ id: req.id, ok: true, ...fields }))
      const emit = (/** @type {object} */ ev) => socket.write(encode(ev))
      if (req.op === 'hello') reply({ proto: 1, deckdVersion: 'fake', bootId: '0' })
      else if (req.op === 'attach') reply({ cols: 80, rows: 24 })
      else if (req.op === 'list') reply({ ptys: [] })
      else if (req.op === 'screen') onScreen(++screens, reply, emit)
    }, () => {}))
    socket.on('error', () => {})
  })
  await new Promise((resolve) => fakeDeckd.listen(path.join(own.dir, 'fleetmates-deck', 'deckd.sock'), () => resolve(undefined)))
  const spike = await startSpikeServer({ runtimeDir: own.dir, port: 0 })
  return {
    spike,
    async close () {
      await spike.close()
      await new Promise((resolve) => fakeDeckd.close(() => resolve(undefined)))
      await own.cleanup()
    }
  }
}

const b64 = (/** @type {string} */ s) => Buffer.from(s).toString('base64')
const screenReply = (/** @type {string} */ s) => ({ rev: 1, cols: 80, rows: 24, cursor: { x: 0, y: 0 }, lines: [s], scrollback: b64(s) })

test('output deckd sends before the screen response is not forwarded twice', async () => {
  // While answering `screen`, deckd first emits output X, which the replay
  // already holds, then the response, then output Y.
  const d = await scriptedDeckd((_n, reply, emit) => {
    emit({ ev: 'output', ptyId: 'pty_00000000', data: b64('X') })
    reply(screenReply('X'))
    emit({ ev: 'output', ptyId: 'pty_00000000', data: b64('Y') })
  })
  try {
    const b = await browser(d.spike, 'pty=pty_00000000')
    await b.until(() => b.text().includes('Y'), 'output Y')
    assert.equal(b.text(), 'XY')
    b.close()
  } finally {
    await d.close()
  }
})

test('after a dropped event a live viewer gets a fresh replay', async () => {
  const d = await scriptedDeckd((n, reply, emit) => {
    reply(screenReply(n === 1 ? 'first' : 'second'))
    if (n === 1) emit({ ev: 'dropped', ptyId: 'pty_00000000', bytes: 10 })
  })
  try {
    const b = await browser(d.spike, 'pty=pty_00000000')
    const replays = await b.until(() => {
      const r = b.msgs.filter((m) => m.t === 'replay')
      return r.length === 2 ? r : undefined
    }, 'a second replay')
    assert.deepEqual(replays.map((m) => Buffer.from(m.data, 'base64').toString()), ['first', 'second'])
    b.close()
  } finally {
    await d.close()
  }
})

/**
 * The ptyIds deckd knows about.
 * @param {Awaited<ReturnType<typeof deckdClient>>} direct
 * @returns {Promise<string[]>}
 */
async function ptyIds (direct) {
  const res = await direct.request('list')
  assert.equal(res.ok, true)
  return res.ptys.map((/** @type {any} */ p) => p.ptyId)
}

test('the spike server refuses foreign or missing Origin and foreign Host, and spawns nothing', async () => {
  const direct = await deckdClient(path.join(rt.dir, 'fleetmates-deck', 'deckd.sock'))
  const spike = await startSpike()
  try {
    const before = await ptyIds(direct)
    const port = spike.port
    const good = `http://127.0.0.1:${port}`
    const protocols = [spike.token]
    const q = new URLSearchParams({ spawn: '1', cwd: rt.dir }).toString()
    assert.equal(await upgradeStatus(port, q, { origin: 'https://evil.example', protocols }), 401, 'foreign Origin')
    assert.equal(await upgradeStatus(port, q, { protocols }), 401, 'missing Origin')
    assert.equal(await upgradeStatus(port, q, { origin: `http://localhost:${port}`, protocols }), 401, 'localhost Origin')
    assert.equal(await upgradeStatus(port, q, { origin: good, host: `evil.example:${port}`, protocols }), 401, 'evil Host on WS')
    assert.equal(await upgradeStatus(port, q, { origin: good, host: `localhost:${port}`, protocols }), 401, 'localhost Host on WS')
    assert.equal((await httpGet(port, '/', `evil.example:${port}`)).status, 403, 'evil Host on HTTP')
    assert.equal((await httpGet(port, '/', `localhost:${port}`)).status, 403, 'localhost Host on HTTP')
    assert.equal((await httpGet(port, '/', `127.0.0.1:${port}`)).status, 200, 'own Host on HTTP')
    assert.deepEqual(await ptyIds(direct), before, 'a refused upgrade spawned a PTY')
    // The correct Host, Origin and token are accepted.
    const b = await browser(spike, new URLSearchParams({ pty: 'pty_ffffffff' }).toString())
    await b.waitMsg((m) => m.t === 'error', 'the not-found error from an accepted upgrade')
    b.close()
  } finally {
    direct.close()
    spike.proc.kill('SIGKILL')
    await exited(spike.proc)
  }
})

test('a /ws upgrade without the exact per-launch token is refused and spawns nothing', async () => {
  const direct = await deckdClient(path.join(rt.dir, 'fleetmates-deck', 'deckd.sock'))
  const spike = await startSpike()
  try {
    const before = await ptyIds(direct)
    const port = spike.port
    const origin = `http://127.0.0.1:${port}`
    const q = new URLSearchParams({ spawn: '1', cwd: rt.dir }).toString()
    const flipped = (spike.token[0] === 'A' ? 'B' : 'A') + spike.token.slice(1)
    assert.equal(await upgradeStatus(port, q, { origin }), 401, 'no token')
    assert.equal(await upgradeStatus(port, q, { origin, protocols: [flipped] }), 401, 'token with one character changed')
    assert.equal(await upgradeStatus(port, q, { origin, protocols: [spike.token.slice(0, -1)] }), 401, 'token prefix')
    assert.equal(await upgradeStatus(port, q, { origin, protocols: ['x' + spike.token] }), 401, 'token with a prefix')
    assert.deepEqual(await ptyIds(direct), before, 'a refused upgrade spawned a PTY')
    assert.equal(await upgradeStatus(port, 'pty=pty_ffffffff', { origin, protocols: [spike.token] }), 101, 'the right token')
  } finally {
    direct.close()
    spike.proc.kill('SIGKILL')
    await exited(spike.proc)
  }
})

test('every HTTP response forbids framing and inline script', async () => {
  const spike = await startSpike()
  try {
    const port = spike.port
    const cases = [
      ['/?spawn=1&cwd=/var', `127.0.0.1:${port}`, 200],
      ['/main.js', `127.0.0.1:${port}`, 200],
      ['/nope', `127.0.0.1:${port}`, 404],
      ['/', `evil.example:${port}`, 403]
    ]
    for (const [p, host, status] of cases) {
      const res = await httpGet(port, String(p), String(host))
      assert.equal(res.status, status, `${p} ${host}`)
      assert.equal(res.headers['x-frame-options'], 'DENY', `${p} ${host}`)
      const csp = String(res.headers['content-security-policy'])
      assert.match(csp, /frame-ancestors 'none'/, `${p} ${host}`)
      assert.match(csp, /default-src 'self'/, `${p} ${host}`)
      assert.match(csp, /script-src 'self'(;|$)/, `${p} ${host}`)
    }
  } finally {
    spike.proc.kill('SIGKILL')
    await exited(spike.proc)
  }
})

test('loading the page with ?spawn=1 spawns nothing until Start is clicked', async () => {
  const direct = await deckdClient(path.join(rt.dir, 'fleetmates-deck', 'deckd.sock'))
  const spike = await startSpike()
  try {
    const before = await ptyIds(direct)
    const page = await httpGet(spike.port, `/?spawn=1&cwd=${encodeURIComponent(rt.dir)}`, `127.0.0.1:${spike.port}`)
    assert.equal(page.status, 200)
    assert.deepEqual(await ptyIds(direct), before, 'loading the page spawned a PTY')
  } finally {
    direct.close()
    spike.proc.kill('SIGKILL')
    await exited(spike.proc)
  }
  // The page script itself, run against stub DOM and WebSocket globals.
  const source = await readFile(path.join(hubDir, 'spike', 'main.js'), 'utf8')
  /**
   * @param {string} search
   */
  const runPage = (search) => {
    /** @type {{ url: string, protocols: string[] }[]} */
    const sockets = []
    /** @type {Record<string, any>} */
    const els = {}
    const el = () => {
      /** @type {Record<string, () => void>} */
      const handlers = {}
      return { textContent: '', hidden: true, handlers, addEventListener (/** @type {string} */ t, /** @type {() => void} */ fn) { handlers[t] = fn } }
    }
    for (const id of ['term', 'status', 'start']) els[id] = el()
    const store = new Map()
    /** @type {string[]} */
    const replaced = []
    const ctx = {
      URLSearchParams,
      atob,
      location: { hash: '#token=TKN', search, pathname: '/', host: '127.0.0.1:1' },
      history: { replaceState: (/** @type {any} */ _s, /** @type {any} */ _t, /** @type {string} */ u) => { replaced.push(u) } },
      sessionStorage: { setItem: (/** @type {string} */ k, /** @type {string} */ v) => store.set(k, v), getItem: (/** @type {string} */ k) => store.get(k) ?? null },
      document: { getElementById: (/** @type {string} */ id) => els[id] },
      window: { addEventListener () {} },
      Terminal: class { cols = 80; rows = 24; loadAddon () {} open () {} reset () {} write () {} onData () {} },
      FitAddon: { FitAddon: class { fit () {} } },
      WebSocket: Object.assign(class {
        /** @param {string} url @param {string[]} protocols */
        constructor (url, protocols) { sockets.push({ url, protocols }) }
        addEventListener () {}
      }, { OPEN: 1 })
    }
    vm.runInNewContext(source, ctx)
    return { sockets, els, replaced, store }
  }
  const spawnPage = runPage(`?spawn=1&cwd=${encodeURIComponent('/some/dir')}`)
  assert.equal(spawnPage.sockets.length, 0, 'the page opened a WebSocket on load with ?spawn=1')
  assert.equal(spawnPage.els.start.hidden, false)
  assert.equal(spawnPage.els.start.textContent, 'Start claude in /some/dir')
  assert.equal(spawnPage.store.get('spikeToken'), 'TKN')
  assert.deepEqual([...spawnPage.replaced], ['/?spawn=1&cwd=%2Fsome%2Fdir'], 'the token was not removed from the address bar')
  spawnPage.els.start.handlers.click()
  assert.equal(spawnPage.sockets.length, 1)
  assert.match(spawnPage.sockets[0].url, /^ws:\/\/127\.0\.0\.1:1\/ws\?spawn=1&cwd=%2Fsome%2Fdir&cols=80&rows=24$/)
  assert.deepEqual([...spawnPage.sockets[0].protocols], ['TKN'])
  const attachPage = runPage('?pty=pty_00000001')
  assert.equal(attachPage.sockets.length, 1, 'a ?pty= page connects on load')
  assert.deepEqual([...attachPage.sockets[0].protocols], ['TKN'])
})

test('spawn refuses a cwd that is relative, missing or not a directory', async () => {
  const direct = await deckdClient(path.join(rt.dir, 'fleetmates-deck', 'deckd.sock'))
  const spike = await startSpike()
  try {
    const before = await ptyIds(direct)
    // The spike process runs with cwd hub/, where '.', 'spike' and
    // 'test/fixtures' are existing relative directories.
    for (const cwd of ['', '.', 'spike', 'test/fixtures', 'relative/dir', path.join(rt.dir, 'nope'), echoScript]) {
      const b = await browser(spike, new URLSearchParams({ spawn: '1', cwd }).toString())
      const err = await b.waitMsg((m) => m.t === 'error', `the refusal for cwd ${JSON.stringify(cwd)}`)
      assert.match(err.message, /absolute path of an existing directory/)
      b.close()
    }
    assert.deepEqual(await ptyIds(direct), before, 'a refused spawn created a PTY')
  } finally {
    direct.close()
    spike.proc.kill('SIGKILL')
    await exited(spike.proc)
  }
})
