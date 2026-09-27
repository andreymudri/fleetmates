// deckd: owns every deck PTY and serves them over a Unix socket
// (docs/deck/05-api.md section 5). Run as `node hub/deckd/main.mjs`.
//
// Authentication is the file mode alone: the directory is 0700 and the
// socket 0600. 05-api.md also asks for an SO_PEERCRED uid check, but Node
// cannot read SO_PEERCRED without a native addon, so deckd does not do it.
import net from 'node:net'
import path from 'node:path'
import { mkdir, chmod, unlink, lstat, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { encode, createLineDecoder, PROTO, OUTPUT_QUEUE_CAP } from './protocol.mjs'
import { PtyHost, DeckdError } from './pty-host.mjs'

/** How long `exits` keeps an exit record. */
const EXIT_RETENTION_MS = 24 * 60 * 60 * 1000
const SOURCE_KINDS = new Set(['browser', 'deck', 'terminal'])

/**
 * @typedef {{ socket: net.Socket, client: { kind: string, name?: string, pid?: number } | null, dropped: Map<string, number> }} Conn
 */

/**
 * Socket directory and path for a runtime dir.
 * @param {string} runtimeDir
 * @returns {{ dir: string, socketPath: string }}
 */
export function socketPaths (runtimeDir) {
  const dir = path.join(runtimeDir, 'fleetmates-deck')
  return { dir, socketPath: path.join(dir, 'deckd.sock') }
}

/**
 * Remove a socket file left behind by a dead deckd. Refuses when something
 * still answers on it, or when the path is not a socket.
 * @param {string} socketPath
 */
async function clearStaleSocket (socketPath) {
  let st
  try {
    st = await lstat(socketPath)
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw err
  }
  if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`)
  const alive = await new Promise((resolve) => {
    const s = net.connect(socketPath)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
  if (alive) throw new Error(`another deckd is listening on ${socketPath}`)
  await unlink(socketPath)
}

/**
 * Validate an input or resize source.
 * @param {any} source
 * @returns {{ kind: 'browser' | 'deck' | 'terminal', name?: string }}
 */
function checkSource (source) {
  if (!source || !SOURCE_KINDS.has(source.kind) || (source.name !== undefined && typeof source.name !== 'string')) {
    throw new DeckdError('bad_request', 'source.kind must be browser, deck or terminal')
  }
  return source.name === undefined ? { kind: source.kind } : { kind: source.kind, name: source.name }
}

/**
 * @param {any} n
 * @param {string} field
 * @returns {number}
 */
function checkDim (n, field) {
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new DeckdError('bad_request', `${field} must be an integer from 1 to 1000`)
  return n
}

/**
 * Start deckd listening on `$runtimeDir/fleetmates-deck/deckd.sock`.
 * @param {{ runtimeDir: string, outputQueueCap?: number, version?: string }} opts
 * @returns {Promise<{ socketPath: string, bootId: string, close: () => Promise<void> }>}
 */
export async function startDeckd ({ runtimeDir, outputQueueCap = OUTPUT_QUEUE_CAP, version = '0.0.0' }) {
  const { dir, socketPath } = socketPaths(runtimeDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  await clearStaleSocket(socketPath)

  const bootId = randomBytes(8).toString('hex')
  /** @type {Map<string, PtyHost>} */
  const ptys = new Map()
  /** @type {{ ptyId: string, code: number, signal: string | null, at: number }[]} */
  let exits = []
  /** @type {Set<Conn>} */
  const conns = new Set()

  /**
   * @param {Conn} conn
   * @param {object} msg
   */
  const send = (conn, msg) => {
    if (!conn.socket.destroyed) conn.socket.write(encode(msg))
  }
  /** @param {object} msg */
  const broadcast = (msg) => {
    const line = encode(msg)
    for (const c of conns) if (c.client && !c.socket.destroyed) c.socket.write(line)
  }
  /**
   * Queue output for one client, or drop it when the client's queue is over
   * the cap. The first drop of an episode is reported at once. The episode
   * ends in the write callback of that `dropped` event, so only after the
   * backlog queued before it has been written (the callback can come later
   * than the client reads the event); bytes dropped meanwhile are reported
   * in a second `dropped`, and output flows again. The socket's 'drain'
   * event is not used: it fires only after a write returned false, and with
   * a cap below the socket's highWaterMark the cap is reached first, so
   * the episode never ended.
   * @param {Conn} conn
   * @param {string} ptyId
   * @param {Buffer} data
   */
  const sendOutput = (conn, ptyId, data) => {
    if (conn.socket.destroyed) return
    const line = encode({ ev: 'output', ptyId, data: data.toString('base64') })
    const already = conn.dropped.get(ptyId)
    if (already === undefined && conn.socket.writableLength + line.length <= outputQueueCap) {
      conn.socket.write(line)
      return
    }
    if (already === undefined) {
      conn.dropped.set(ptyId, 0)
      conn.socket.write(encode({ ev: 'dropped', ptyId, bytes: data.length }), (err) => {
        const more = conn.dropped.get(ptyId)
        conn.dropped.delete(ptyId)
        if (!err && more) send(conn, { ev: 'dropped', ptyId, bytes: more })
      })
    } else {
      conn.dropped.set(ptyId, already + data.length)
    }
  }

  /**
   * Public view of a client: kind and name, never the pid.
   * @param {{ kind: string, name?: string }} client
   */
  const publicClient = (client) => client.name === undefined ? { kind: client.kind } : { kind: client.kind, name: client.name }

  /** @param {PtyHost} host */
  const hostInfo = (host) => ({
    ptyId: host.ptyId,
    pid: host.pid,
    origin: host.origin,
    cwd: host.cwd,
    argv: host.argv,
    cols: host.cols,
    rows: host.rows,
    startedAt: host.startedAt,
    clients: [...host.clients.values()].map(({ client }) => publicClient(client)),
    lastInputFrom: host.lastInputFrom,
    lastInputAt: host.lastInputAt
  })

  /**
   * @param {any} ptyId
   * @returns {PtyHost}
   */
  const getHost = (ptyId) => {
    const host = typeof ptyId === 'string' ? ptys.get(ptyId) : undefined
    if (!host) throw new DeckdError('not_found', `no pty ${ptyId}`)
    return host
  }

  /**
   * @param {Conn} conn
   * @param {PtyHost} host
   */
  const detach = (conn, host) => {
    unwatch(conn, host)
    const entry = host.clients.get(conn)
    if (!entry) return
    host.clients.delete(conn)
    conn.dropped.delete(host.ptyId)
    broadcast({ ev: 'client', ptyId: host.ptyId, change: 'detached', client: publicClient(entry.client) })
  }

  /**
   * @param {Conn} conn
   * @param {PtyHost} host
   */
  const unwatch = (conn, host) => {
    host.watchers.delete(conn)
    if (host.watchers.size === 0 && host.unwatchScreen) {
      host.unwatchScreen()
      host.unwatchScreen = null
    }
  }

  /** @type {Record<string, (conn: Conn, req: any) => object | Promise<object>>} */
  const ops = {
    hello: (conn, req) => {
      if (!Number.isInteger(req.proto) || req.proto < 1) throw new DeckdError('unsupported_proto', `deckd speaks proto ${PROTO}`)
      const c = req.client ?? {}
      if (c.kind !== 'server' && c.kind !== 'terminal') throw new DeckdError('bad_request', 'client.kind must be server or terminal')
      conn.client = { kind: c.kind }
      if (typeof c.name === 'string') conn.client.name = c.name
      if (Number.isInteger(c.pid)) conn.client.pid = c.pid
      return { proto: Math.min(req.proto, PROTO), deckdVersion: version, bootId }
    },
    spawn: (_conn, req) => {
      const host = PtyHost.spawn({
        cwd: typeof req.cwd === 'string' ? req.cwd : undefined,
        argv: req.argv,
        env: req.env && typeof req.env === 'object' ? req.env : undefined,
        cols: req.cols === undefined ? undefined : checkDim(req.cols, 'cols'),
        rows: req.rows === undefined ? undefined : checkDim(req.rows, 'rows'),
        origin: req.origin === 'wrapped' ? 'wrapped' : 'launched'
      }, {
        onOutput: (h, data) => {
          for (const [conn, { stream }] of h.clients) if (stream) sendOutput(conn, h.ptyId, data)
        },
        onExit: (h, exit) => {
          const rec = { ptyId: h.ptyId, ...exit }
          const cutoff = Date.now() - EXIT_RETENTION_MS
          exits = exits.filter((e) => e.at >= cutoff)
          exits.push(rec)
          ptys.delete(h.ptyId)
          // Cancel a throttled screen event still pending, so no `screen`
          // for this PTY follows its `exit`.
          if (h.unwatchScreen) h.unwatchScreen()
          h.unwatchScreen = null
          h.watchers.clear()
          h.dispose()
          broadcast({ ev: 'exit', ...rec })
        }
      })
      ptys.set(host.ptyId, host)
      broadcast({ ev: 'spawned', ptyId: host.ptyId, pid: host.pid, origin: host.origin, cwd: host.cwd, argv: host.argv, startedAt: host.startedAt })
      return { ptyId: host.ptyId, pid: host.pid, startedAt: host.startedAt }
    },
    list: () => ({ ptys: [...ptys.values()].map(hostInfo) }),
    exits: (_conn, req) => {
      const since = Number.isFinite(req.since) ? req.since : 0
      const cutoff = Date.now() - EXIT_RETENTION_MS
      exits = exits.filter((e) => e.at >= cutoff)
      return { exits: exits.filter((e) => e.at >= since) }
    },
    attach: (conn, req) => {
      const host = getHost(req.ptyId)
      const fresh = !host.clients.has(conn)
      const client = /** @type {NonNullable<Conn['client']>} */ (conn.client)
      host.clients.set(conn, { client, stream: req.stream !== false })
      if (fresh) broadcast({ ev: 'client', ptyId: host.ptyId, change: 'attached', client: publicClient(client) })
      return { cols: host.cols, rows: host.rows }
    },
    detach: (conn, req) => {
      detach(conn, getHost(req.ptyId))
      return {}
    },
    screen: async (_conn, req) => {
      const host = getHost(req.ptyId)
      await host.screen.flush()
      // `scrollback` is a line count: the newest N lines of raw output.
      const n = Number.isInteger(req.scrollback) && req.scrollback > 0 ? req.scrollback : 0
      return {
        rev: host.screen.rev,
        cols: host.cols,
        rows: host.rows,
        cursor: host.screen.cursor(),
        lines: host.screen.lines(),
        scrollback: host.ring.tail(n).toString('base64')
      }
    },
    watchScreen: (conn, req) => {
      const host = getHost(req.ptyId)
      if (req.on === false) {
        unwatch(conn, host)
        return {}
      }
      host.watchers.add(conn)
      if (!host.unwatchScreen) {
        host.unwatchScreen = host.screen.watch((ev) => {
          for (const c of host.watchers) send(c, { ev: 'screen', ptyId: host.ptyId, ...ev })
        })
      }
      return {}
    },
    write: (_conn, req) => {
      const host = getHost(req.ptyId)
      const source = checkSource(req.source)
      if (typeof req.data !== 'string') throw new DeckdError('bad_request', 'data must be base64')
      const data = Buffer.from(req.data, 'base64')
      const at = host.write(data, source)
      broadcast({ ev: 'input', ptyId: host.ptyId, source, at, bytes: data.length })
      return { at }
    },
    resize: (_conn, req) => {
      const host = getHost(req.ptyId)
      return host.requestResize(checkDim(req.cols, 'cols'), checkDim(req.rows, 'rows'), checkSource(req.source))
    },
    kill: (_conn, req) => {
      const host = getHost(req.ptyId)
      const signal = req.signal ?? 'SIGTERM'
      if (signal !== 'SIGTERM' && signal !== 'SIGKILL' && signal !== 'SIGINT' && signal !== 'SIGHUP') {
        throw new DeckdError('bad_request', 'signal must be SIGTERM, SIGKILL, SIGINT or SIGHUP')
      }
      const graceMs = Number.isInteger(req.graceMs) && req.graceMs >= 0 ? req.graceMs : 5000
      host.kill(signal, graceMs)
      return {}
    },
    ping: () => ({ at: Date.now() })
  }

  /**
   * @param {Conn} conn
   * @param {any} req
   */
  const handle = async (conn, req) => {
    const id = req && typeof req === 'object' ? req.id : undefined
    try {
      if (!req || typeof req !== 'object' || Array.isArray(req)) throw new DeckdError('bad_request', 'message must be a JSON object')
      const op = ops[req.op]
      if (!op || !Object.hasOwn(ops, req.op)) throw new DeckdError('unknown_op', `unknown op ${req.op}`)
      if (req.op !== 'hello' && !conn.client) throw new DeckdError('hello_required', 'send hello first')
      const result = await op(conn, req)
      send(conn, { id, ok: true, ...result })
    } catch (err) {
      const code = err instanceof DeckdError ? err.code : 'internal'
      if (code === 'internal') console.error('deckd: internal error', err)
      send(conn, { id, ok: false, error: { code, message: /** @type {Error} */ (err).message } })
    }
  }

  const server = net.createServer((socket) => {
    /** @type {Conn} */
    const conn = { socket, client: null, dropped: new Map() }
    conns.add(conn)
    const decode = createLineDecoder(
      (msg) => { handle(conn, msg) },
      (e) => send(conn, { ok: false, error: { code: e.code, message: 'line is not JSON' } })
    )
    socket.on('data', decode)
    socket.on('error', () => {})
    socket.on('close', () => {
      conns.delete(conn)
      for (const host of ptys.values()) detach(conn, host)
    })
  })

  const oldMask = process.umask(0o177)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve(undefined)
      })
    })
  } finally {
    process.umask(oldMask)
  }
  await chmod(socketPath, 0o600)

  const close = async () => {
    const pending = [...ptys.values()].map((host) => new Promise((resolve) => {
      host.proc.onExit(() => resolve(undefined))
      host.kill('SIGTERM', 2000)
    }))
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 3000).unref())])
    for (const c of conns) c.socket.destroy()
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await unlink(socketPath).catch(() => {})
  }

  return { socketPath, bootId, close }
}

async function main () {
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (!runtimeDir) {
    console.error('deckd: XDG_RUNTIME_DIR is not set')
    process.exit(1)
  }
  const cap = Number(process.env.DECKD_OUTPUT_QUEUE_CAP)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const deckd = await startDeckd({
    runtimeDir,
    outputQueueCap: Number.isInteger(cap) && cap > 0 ? cap : OUTPUT_QUEUE_CAP,
    version: pkg.version
  })
  console.error(`deckd listening on ${deckd.socketPath}`)
  let closing = false
  const stop = () => {
    if (closing) return
    closing = true
    deckd.close().then(() => process.exit(0), (err) => {
      console.error('deckd: shutdown failed', err)
      process.exit(1)
    })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(`deckd: ${err.message}`)
    process.exit(1)
  })
}
