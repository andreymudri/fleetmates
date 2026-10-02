// deckd: owns every deck PTY and serves them over a Unix socket
// (docs/deck/05-api.md section 5). Run as `node hub/deckd/main.mjs`.
//
// Authentication is the file mode alone: the directory is 0700 and the
// socket 0600. 05-api.md also asks for an SO_PEERCRED uid check, but Node
// cannot read SO_PEERCRED without a native addon, so deckd does not do it.
import net from 'node:net'
import path from 'node:path'
import { mkdir, chmod, unlink, lstat, stat, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { encode, createLineDecoder, PROTO, OUTPUT_QUEUE_CAP, MAX_LINE } from './protocol.mjs'
import { PtyHost, DeckdError } from './pty-host.mjs'
import { captureLoginEnv, dropSessionVars, changedNames } from './login-env.mjs'
import { capHistory } from './screen-model.mjs'

/** How long `exits` keeps an exit record. */
const EXIT_RETENTION_MS = 24 * 60 * 60 * 1000
/** Lines and bytes of output an exit record keeps as its `tail`; `history.data` shares the byte cap. */
const EXIT_TAIL_LINES = 1000
const EXIT_TAIL_BYTES = 256 * 1024
/** Most names the hello answer lists in `loginEnvNames`. */
const LOGIN_ENV_NAMES_MAX = 200
const SOURCE_KINDS = new Set(['browser', 'deck', 'terminal'])

/**
 * @typedef {{ socket: net.Socket, client: { kind: string, name?: string, pid?: number } | null, proto: number, dropped: Map<string, number> }} Conn
 * @typedef {{ ptyId: string, code: number, signal: string | null, at: number, tail: string, history?: import('./screen-model.mjs').History }} ExitRecord
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
 * Validate a spawn `env`: absent, or a plain object of string values.
 * @param {any} env
 * @returns {Record<string, string>}
 */
function checkEnv (env) {
  if (env === undefined) return {}
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.getPrototypeOf(env) !== Object.prototype ||
      !Object.values(env).every((v) => typeof v === 'string')) {
    throw new DeckdError('bad_request', 'env must be an object of string values')
  }
  return env
}

/**
 * Validate a spawn `cwd`: absent, or an absolute path to an existing directory.
 * @param {any} cwd
 * @returns {Promise<string | undefined>}
 */
async function checkCwd (cwd) {
  if (cwd === undefined) return undefined
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new DeckdError('bad_request', 'cwd must be an absolute path')
  const st = await stat(cwd).catch(() => null)
  if (!st || !st.isDirectory()) throw new DeckdError('bad_request', 'cwd must be an existing directory')
  return cwd
}

/**
 * Refuse a runtime dir that another user owns or that has any group or
 * world permission bit (docs/deck/08-security.md 4.3).
 * @param {string} runtimeDir
 */
async function checkRuntimeDir (runtimeDir) {
  const st = await stat(runtimeDir)
  const mode = (st.mode & 0o777).toString(8).padStart(4, '0')
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`runtime dir ${runtimeDir} is owned by uid ${st.uid}, not by this user`)
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`runtime dir ${runtimeDir} has mode ${mode}; it must allow no group or world access (0700)`)
}

/**
 * The newest EXIT_TAIL_LINES lines of a ring, cut to its last
 * EXIT_TAIL_BYTES from a line start, base64.
 * @param {PtyHost} host
 * @returns {string}
 */
function exitTail (host) {
  let tail = host.ring.tail(EXIT_TAIL_LINES)
  if (tail.length > EXIT_TAIL_BYTES) {
    tail = tail.subarray(tail.length - EXIT_TAIL_BYTES)
    const nl = tail.indexOf(0x0a)
    if (nl !== -1 && nl + 1 < tail.length) tail = tail.subarray(nl + 1)
  }
  return tail.toString('base64')
}

/**
 * The PTY's serialized history at exit, `data` cut to EXIT_TAIL_BYTES by
 * dropping whole leading lines. Undefined when serializing fails, so the exit
 * is still recorded.
 * @param {PtyHost} host
 * @returns {Promise<import('./screen-model.mjs').History | undefined>}
 */
async function exitHistory (host) {
  try {
    await host.screen.flush()
    const history = host.screen.history()
    return { ...history, data: capHistory(history.data, EXIT_TAIL_BYTES) }
  } catch (err) {
    console.error('deckd: could not serialize the history of', host.ptyId, /** @type {Error} */ (err).message)
    return undefined
  }
}

/**
 * Start deckd listening on `$runtimeDir/fleetmates-deck/deckd.sock`.
 * `loginEnv` is the environment `launched` sessions start from; when absent
 * it is this process's environment without Claude Code's session variables,
 * so a caller that passes none never runs a shell.
 * @param {{ runtimeDir: string, outputQueueCap?: number, version?: string, loginEnv?: Record<string, string> }} opts
 * @returns {Promise<{ socketPath: string, bootId: string, close: () => Promise<void> }>}
 */
export async function startDeckd ({ runtimeDir, outputQueueCap = OUTPUT_QUEUE_CAP, version = '0.0.0', loginEnv = dropSessionVars(process.env) }) {
  await checkRuntimeDir(runtimeDir)
  const loginEnvNames = changedNames(loginEnv, process.env).slice(0, LOGIN_ENV_NAMES_MAX)
  const { dir, socketPath } = socketPaths(runtimeDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  await clearStaleSocket(socketPath)

  const bootId = randomBytes(8).toString('hex')
  /** @type {Map<string, PtyHost>} */
  const ptys = new Map()
  /** @type {ExitRecord[]} */
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
      conn.proto = Math.min(req.proto, PROTO)
      return conn.proto >= 2
        ? { proto: conn.proto, deckdVersion: version, bootId, loginEnvNames }
        : { proto: conn.proto, deckdVersion: version, bootId }
    },
    spawn: async (_conn, req) => {
      const env = checkEnv(req.env)
      const cwd = await checkCwd(req.cwd)
      const origin = req.origin === 'wrapped' ? 'wrapped' : 'launched'
      const host = PtyHost.spawn({
        cwd,
        argv: req.argv,
        // `wrapped`: the terminal's own environment as fm sent it;
        // `launched`: the login environment, then what the caller added.
        baseEnv: origin === 'wrapped' ? {} : loginEnv,
        env,
        cols: req.cols === undefined ? undefined : checkDim(req.cols, 'cols'),
        rows: req.rows === undefined ? undefined : checkDim(req.rows, 'rows'),
        origin
      }, {
        onOutput: (h, data) => {
          for (const [conn, { stream }] of h.clients) if (stream) sendOutput(conn, h.ptyId, data)
        },
        onExit: async (h, exit) => {
          const event = { ptyId: h.ptyId, ...exit }
          // The record (with `history`, read once the screen model has parsed
          // every byte) is stored before the `exit` event goes out, so a
          // client that asks `exits` on that event finds it.
          const history = await exitHistory(h)
          const rec = { ...event, tail: exitTail(h), ...(history ? { history } : {}) }
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
          broadcast({ ev: 'exit', ...event })
        }
      })
      ptys.set(host.ptyId, host)
      broadcast({ ev: 'spawned', ptyId: host.ptyId, pid: host.pid, origin: host.origin, cwd: host.cwd, argv: host.argv, startedAt: host.startedAt })
      return { ptyId: host.ptyId, pid: host.pid, startedAt: host.startedAt }
    },
    list: () => ({ ptys: [...ptys.values()].map(hostInfo) }),
    exits: (conn, req) => {
      const since = Number.isFinite(req.since) ? req.since : 0
      const cutoff = Date.now() - EXIT_RETENTION_MS
      exits = exits.filter((e) => e.at >= cutoff)
      const found = exits.filter((e) => e.at >= since)
      // `tail` and `history` are proto 2 fields.
      return { exits: conn.proto >= 2 ? found : found.map(({ tail, history, ...e }) => e) }
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
    screen: async (conn, req) => {
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
        scrollback: host.ring.tail(n).toString('base64'),
        // `history` is a proto 2 field, sent only when asked for.
        ...(req.history === true && conn.proto >= 2 ? { history: host.screen.history() } : {})
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
    const conn = { socket, client: null, proto: 0, dropped: new Map() }
    conns.add(conn)
    const decode = createLineDecoder(
      (msg) => { handle(conn, msg) },
      (e) => send(conn, { ok: false, error: { code: e.code, message: e.code === 'line_too_long' ? `line is longer than ${MAX_LINE} bytes` : 'line is not JSON' } }),
      { maxLine: MAX_LINE }
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
  // DECKD_LOGIN_ENV=inherit skips the login-shell probe; nothing else does.
  // Every test and perf harness that starts this file sets it.
  const skipProbe = process.env.DECKD_LOGIN_ENV === 'inherit'
  /** @type {string | null} */
  let failed = null
  const loginEnv = skipProbe
    ? dropSessionVars(process.env)
    : await captureLoginEnv({ onFallback: (reason) => { failed = reason } })
  const added = changedNames(loginEnv, process.env)
  if (skipProbe) console.error('deckd: login environment probe skipped (DECKD_LOGIN_ENV=inherit), using the service environment')
  else if (failed) console.error(`deckd: login environment probe failed (${failed}), using the service environment`)
  else console.error(`deckd: login environment adds ${added.length} names${added.length ? ': ' + added.join(', ') : ''}`)
  const deckd = await startDeckd({
    runtimeDir,
    outputQueueCap: Number.isInteger(cap) && cap > 0 ? cap : OUTPUT_QUEUE_CAP,
    version: pkg.version,
    loginEnv
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
