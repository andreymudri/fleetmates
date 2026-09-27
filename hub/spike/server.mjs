// Spike only; deleted at M1.
//
// A web page bridged to deckd: node:http + ws on 127.0.0.1, one long-lived
// deckd connection as `kind: 'server'`, fanned out to browser WebSockets.
// Run as `node hub/spike/server.mjs` with XDG_RUNTIME_DIR pointing at the
// runtime dir deckd uses. SPIKE_PORT picks the port (default 47899, 0 for
// any free port); SPIKE_HOST, when set, must be 127.0.0.1.
//
// The deckd client lives in this file, not in hub/deckd/client.mjs: that
// client belongs to another task and did not exist when the spike was built.
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { encode, createLineDecoder, PROTO } from '../deckd/protocol.mjs'
import { socketPaths } from '../deckd/main.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hubDir = path.resolve(here, '..')
const LOOPBACK = '127.0.0.1'
const DEFAULT_PORT = 47899
const REPLAY_LINES = 5000

/** Fixed map of served files: nothing outside it is reachable. */
const STATIC = new Map([
  ['/', { file: path.join(here, 'index.html'), type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: path.join(here, 'index.html'), type: 'text/html; charset=utf-8' }],
  ['/main.js', { file: path.join(here, 'main.js'), type: 'text/javascript; charset=utf-8' }],
  ['/xterm/xterm.js', { file: path.join(hubDir, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), type: 'text/javascript; charset=utf-8' }],
  ['/xterm/xterm.css', { file: path.join(hubDir, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), type: 'text/css; charset=utf-8' }],
  ['/xterm/addon-fit.js', { file: path.join(hubDir, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), type: 'text/javascript; charset=utf-8' }]
])

/**
 * Connect to deckd and say hello as a server client. Requests resolve with
 * the response carrying the same id; messages without a known id are events.
 * `onReply`, when given, runs synchronously as the response is decoded,
 * before any later message in the same read is handled.
 * @param {{ socketPath: string, onEvent: (ev: any) => void, onClose: () => void }} opts
 * @returns {Promise<{ request: (op: string, fields?: object, onReply?: (msg: any) => void) => Promise<any>, close: () => void }>}
 */
export async function connectDeckd ({ socketPath, onEvent, onClose }) {
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
    } else if (msg.ev) {
      onEvent(msg)
    }
  }, () => {}))
  socket.on('error', () => {})
  socket.on('close', () => {
    for (const resolve of pending.values()) resolve({ ok: false, error: { code: 'closed', message: 'deckd connection closed' } })
    pending.clear()
    onClose()
  })
  /**
   * @param {string} op
   * @param {object} [fields]
   * @param {(msg: any) => void} [onReply]
   * @returns {Promise<any>}
   */
  const request = (op, fields = {}, onReply) => new Promise((resolve) => {
    if (socket.destroyed) {
      resolve({ ok: false, error: { code: 'closed', message: 'deckd connection closed' } })
      return
    }
    const id = nextId++
    pending.set(id, (msg) => {
      if (onReply) onReply(msg)
      resolve(msg)
    })
    socket.write(encode({ id, op, ...fields }))
  })
  const hello = await request('hello', { proto: PROTO, client: { kind: 'server', name: 'spike', pid: process.pid } })
  if (!hello.ok) {
    socket.destroy()
    throw new Error(`deckd hello failed: ${hello.error?.message}`)
  }
  return { request, close: () => socket.destroy() }
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {object} msg
 */
function wsSend (ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

/**
 * Start the spike server. Binds 127.0.0.1 only and refuses any other host.
 * @param {{ runtimeDir: string, host?: string, port?: number, onDeckdClose?: () => void }} opts
 * @returns {Promise<{ port: number, address: string, close: () => Promise<void> }>}
 */
export async function startSpikeServer ({ runtimeDir, host = LOOPBACK, port = DEFAULT_PORT, onDeckdClose = () => {} }) {
  if (host !== LOOPBACK) throw new Error(`spike binds ${LOOPBACK} only, refusing host ${host}`)

  /**
   * Per PTY: the browsers watching it and whether their replay has been
   * sent. Output that arrives while a browser waits for its replay is
   * dropped for that browser, not queued: the replay already holds it.
   * @type {Map<string, Set<{ ws: import('ws').WebSocket, live: boolean }>>}
   */
  const viewers = new Map()
  /** @type {Set<string>} */
  const attached = new Set()

  /** @param {any} ev */
  const onEvent = (ev) => {
    const set = viewers.get(ev.ptyId)
    if (!set) return
    for (const v of set) {
      if (ev.ev === 'output' && v.live) wsSend(v.ws, { t: 'out', data: ev.data })
      else if (ev.ev === 'input') wsSend(v.ws, { t: 'status', lastInputFrom: ev.source })
      else if (ev.ev === 'exit') wsSend(v.ws, { t: 'exit', code: ev.code, signal: ev.signal })
      else if (ev.ev === 'dropped' && v.live) replay(ev.ptyId, v)
    }
  }

  const deckd = await connectDeckd({ socketPath: socketPaths(runtimeDir).socketPath, onEvent, onClose: onDeckdClose })

  /**
   * Send a `screen` replay, then let live output through. Output events
   * decoded before the screen response are not forwarded (deckd sent them
   * before reading the ring, so the replay holds them); events after it are,
   * including ones in the same socket read as the response.
   * @param {string} ptyId
   * @param {{ ws: import('ws').WebSocket, live: boolean }} v
   */
  const replay = async (ptyId, v) => {
    v.live = false
    await deckd.request('screen', { ptyId, scrollback: REPLAY_LINES }, (res) => {
      if (!res.ok) {
        wsSend(v.ws, { t: 'error', message: res.error.message })
        return
      }
      wsSend(v.ws, { t: 'replay', data: res.scrollback })
      v.live = true
    })
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {URLSearchParams} q
   */
  const onConnection = async (ws, q) => {
    let ptyId = q.get('pty')
    if (!ptyId && q.get('spawn') === '1') {
      const cwd = q.get('cwd') ?? ''
      const isDir = path.isAbsolute(cwd) && await stat(cwd).then((st) => st.isDirectory(), () => false)
      if (!isDir) {
        wsSend(ws, { t: 'error', message: 'spawn needs cwd to be an absolute path of an existing directory' })
        ws.close()
        return
      }
      const cols = Number(q.get('cols')) || 120
      const rows = Number(q.get('rows')) || 30
      const res = await deckd.request('spawn', { cwd, argv: ['claude'], env: {}, cols, rows, origin: 'launched' })
      if (!res.ok) {
        wsSend(ws, { t: 'error', message: res.error.message })
        ws.close()
        return
      }
      ptyId = res.ptyId
    }
    if (!ptyId) {
      wsSend(ws, { t: 'error', message: 'use ?pty=<id> or ?spawn=1&cwd=<path>' })
      ws.close()
      return
    }
    const id = ptyId
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.t === 'in' && typeof msg.data === 'string') {
        deckd.request('write', { ptyId: id, data: Buffer.from(msg.data, 'utf8').toString('base64'), source: { kind: 'browser' } })
      } else if (msg.t === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        deckd.request('resize', { ptyId: id, cols: msg.cols, rows: msg.rows, source: { kind: 'browser' } })
      }
    })
    if (!attached.has(id)) {
      const res = await deckd.request('attach', { ptyId: id, stream: true })
      if (!res.ok) {
        wsSend(ws, { t: 'error', message: res.error.message })
        ws.close()
        return
      }
      attached.add(id)
    }
    const v = { ws, live: false }
    let set = viewers.get(id)
    if (!set) viewers.set(id, (set = new Set()))
    set.add(v)
    ws.on('close', () => { set.delete(v) })
    const list = await deckd.request('list')
    const info = list.ok ? list.ptys.find((/** @type {any} */ p) => p.ptyId === id) : undefined
    wsSend(ws, { t: 'pty', ptyId: id, lastInputFrom: info?.lastInputFrom ?? null })
    await replay(id, v)
  }

  // Any web page can make a browser open ws:// or http:// to loopback, and a
  // DNS-rebound name can reach 127.0.0.1 too. Only requests whose Host is
  // exactly 127.0.0.1:<port> are served, and a WebSocket upgrade must also
  // carry Origin http://127.0.0.1:<port>, the page this server serves.
  let boundPort = -1
  const hostOk = (/** @type {string | undefined} */ h) => h === `${LOOPBACK}:${boundPort}`
  const originOk = (/** @type {string | undefined} */ o) => o === `http://${LOOPBACK}:${boundPort}`

  const server = http.createServer(async (req, res) => {
    if (!hostOk(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host\n')
      return
    }
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`)
    const entry = STATIC.get(url.pathname)
    if (!entry || req.method !== 'GET') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n')
      return
    }
    try {
      const body = await readFile(entry.file)
      res.writeHead(200, { 'content-type': entry.type }).end(body)
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('cannot read file\n')
    }
  })
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info) => hostOk(info.req.headers.host) && originOk(info.req.headers.origin)
  })
  wss.on('connection', (ws, req) => {
    const q = new URL(req.url ?? '/ws', `http://${LOOPBACK}`).searchParams
    onConnection(ws, q).catch((err) => {
      wsSend(ws, { t: 'error', message: err.message })
      ws.close()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject)
      resolve(undefined)
    })
  })
  const addr = /** @type {net.AddressInfo} */ (server.address())
  boundPort = addr.port

  const close = async () => {
    for (const ws of wss.clients) ws.terminate()
    await new Promise((resolve) => wss.close(() => resolve(undefined)))
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    deckd.close()
  }
  return { port: addr.port, address: addr.address, close }
}

async function main () {
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (!runtimeDir) {
    console.error('spike: XDG_RUNTIME_DIR is not set')
    process.exit(1)
  }
  const rawPort = process.env.SPIKE_PORT
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`spike: bad SPIKE_PORT ${rawPort}`)
    process.exit(1)
  }
  const spike = await startSpikeServer({
    runtimeDir,
    host: process.env.SPIKE_HOST || LOOPBACK,
    port,
    onDeckdClose: () => {
      console.error('spike: deckd connection closed')
      process.exit(1)
    }
  })
  console.error(`spike listening on http://${spike.address}:${spike.port}/`)
  const stop = () => { spike.close().then(() => process.exit(0), () => process.exit(1)) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(`spike: ${err.message}`)
    process.exit(1)
  })
}
