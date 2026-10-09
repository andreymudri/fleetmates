// deckd: owns every deck PTY and serves them over a Unix socket, or a named
// pipe on win32 (docs/deck/05-api.md section 5). Run as `node hub/deckd/main.mjs`.
//
// On POSIX authentication is the file mode alone: the directory is 0700 and
// the socket 0600. 05-api.md also asks for an SO_PEERCRED uid check, but Node
// cannot read SO_PEERCRED without a native addon, so deckd does not do it.
// A named pipe has no file mode, so none of the mode steps run for one.
import net from 'node:net'
import path from 'node:path'
import { mkdir, chmod, unlink, lstat, stat, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { encode, createLineDecoder, PROTO, OUTPUT_QUEUE_CAP, MAX_LINE } from './protocol.mjs'
import { PtyHost, DeckdError } from './pty-host.mjs'
import { captureLoginEnv, dropSessionVars, changedNames } from './login-env.mjs'
import { capHistory } from './screen-model.mjs'
import { checkEndpointDirs } from './client.mjs'
import { runtimeBase, deckDir, endpoint, listenEndpoint, ensurePrivateDir } from '../platform/index.mjs'

/** How long `exits` keeps an exit record. */
const EXIT_RETENTION_MS = 24 * 60 * 60 * 1000
/** Lines and bytes of output an exit record keeps as its `tail`; `history.data` shares the byte cap. */
const EXIT_TAIL_LINES = 1000
const EXIT_TAIL_BYTES = 256 * 1024
/** Most names the hello answer lists in `loginEnvNames`. */
const LOGIN_ENV_NAMES_MAX = 200
const SOURCE_KINDS = new Set(['browser', 'deck', 'terminal'])
/** Optional features a proto 2 hello announces (docs/deck/05-api.md section 5). */
const FEATURES = ['guardedWrite']
/** Largest `guard.quietMs` a guarded write accepts. */
const GUARD_QUIET_MAX_MS = 5000

/**
 * @typedef {{ socket: net.Socket, client: { kind: string, name?: string, pid?: number } | null, proto: number, dropped: Map<string, number> }} Conn
 * @typedef {{ ptyId: string, code: number, signal: string | null, at: number, tail: string, history?: import('./screen-model.mjs').History }} ExitRecord
 */

/**
 * The deck directory and deckd's endpoint for a runtime dir: `socketPath` is
 * a Unix socket path on POSIX and a named pipe on win32, whose name hashes
 * `secret` (by default the deckd key under the runtime dir, read now).
 * @param {string} runtimeDir
 * @param {{ platform?: string, secret?: string | null }} [opts]
 * @returns {{ dir: string, socketPath: string }}
 */
export function socketPaths (runtimeDir, { platform = process.platform, secret } = {}) {
  return { dir: deckDir(runtimeDir, { platform }), socketPath: endpoint(runtimeDir, 'deckd', { platform, secret }) }
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
 * Validate a write `guard`: absent, or `{ rev, quietMs }` with an integer
 * `rev` and an integer `quietMs` from 0 to GUARD_QUIET_MAX_MS, on a write
 * whose source is `deck`.
 * @param {any} guard
 * @param {{ kind: string }} source
 * @returns {{ rev: number, quietMs: number } | undefined}
 */
function checkGuard (guard, source) {
  if (guard === undefined) return undefined
  if (!guard || typeof guard !== 'object' || Array.isArray(guard) || !Number.isInteger(guard.rev) ||
      !Number.isInteger(guard.quietMs) || guard.quietMs < 0 || guard.quietMs > GUARD_QUIET_MAX_MS) {
    throw new DeckdError('bad_request', `guard must be { rev: integer, quietMs: integer from 0 to ${GUARD_QUIET_MAX_MS} }`)
  }
  if (source.kind !== 'deck') throw new DeckdError('bad_request', 'only a deck source may send a guarded write')
  return { rev: guard.rev, quietMs: guard.quietMs }
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
 * The PTY's serialized history at exit, `data` cut to `maxBytes` by
 * dropping whole leading lines. Undefined when serializing fails, so the exit
 * is still recorded.
 * @param {PtyHost} host
 * @param {number} maxBytes
 * @returns {Promise<import('./screen-model.mjs').History | undefined>}
 */
async function exitHistory (host, maxBytes) {
  try {
    await host.screen.flush()
    const history = host.screen.history()
    return { ...history, data: capHistory(history.data, maxBytes) }
  } catch (err) {
    console.error('deckd: could not serialize the history of', host.ptyId, /** @type {Error} */ (err).message)
    return undefined
  }
}

/**
 * Start deckd listening on `endpoint(runtimeDir, 'deckd')`: on POSIX
 * `$runtimeDir/fleetmates-deck/deckd.sock` (or the short /tmp path when that
 * is too long for a socket), on win32 a named pipe started by listenEndpoint:
 * deckd refuses to start while another live deckd holds the deckd start lock,
 * and otherwise listens under a new key, which it then writes to the deck dir;
 * closing removes that key.
 * The runtime dir is created when missing and, on POSIX, refused when another
 * user owns it or it has any group or world permission bit
 * (docs/deck/08-security.md 4.3); the socket's directory is made 0700 and
 * checked the same way.
 * `loginEnv` is the environment `launched` sessions start from; when absent
 * it is this process's environment without Claude Code's session variables,
 * so a caller that passes none never runs a shell.
 * `historyCap` is the byte cap of an exit record's `history.data`
 * (EXIT_TAIL_BYTES unless a test sets it).
 * `platform` (default the live one) picks the endpoint kind and how PTYs are
 * spawned and killed; a test pins it.
 * @param {{ runtimeDir: string, outputQueueCap?: number, version?: string, loginEnv?: Record<string, string>, historyCap?: number, platform?: string }} opts
 * @returns {Promise<{ socketPath: string, bootId: string, close: () => Promise<void> }>}
 */
export async function startDeckd ({ runtimeDir, outputQueueCap = OUTPUT_QUEUE_CAP, version = '0.0.0', loginEnv = dropSessionVars(process.env), historyCap = EXIT_TAIL_BYTES, platform = process.platform }) {
  await ensurePrivateDir(runtimeDir, { platform })
  const loginEnvNames = changedNames(loginEnv, process.env).slice(0, LOGIN_ENV_NAMES_MAX)
  const dir = deckDir(runtimeDir, { platform })
  const pipe = platform === 'win32'
  // win32: the pipe is named when it starts listening, below.
  let socketPath = pipe ? '' : socketPaths(runtimeDir, { platform }).socketPath
  if (pipe) {
    await ensurePrivateDir(dir, { platform })
  } else {
    // The deck dir, and the socket's own dir when the endpoint fell back to
    // a short /tmp path; a dir left behind with a looser mode is tightened.
    for (const d of new Set([dir, path.dirname(socketPath)])) {
      await mkdir(d, { recursive: true, mode: 0o700 })
      await chmod(d, 0o700)
      await ensurePrivateDir(d, { platform })
    }
    // ensurePrivateDir follows symlinks; the clients' rule does not. Refuse
    // here what every client would refuse, such as a symlinked deck dir.
    await checkEndpointDirs(runtimeDir, { platform })
    await clearStaleSocket(socketPath)
  }

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
        ? { proto: conn.proto, deckdVersion: version, bootId, loginEnvNames, features: FEATURES }
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
          const history = await exitHistory(h, historyCap)
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
      }, { platform })
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
      const guard = checkGuard(req.guard, source)
      const data = Buffer.from(req.data, 'base64')
      const at = host.write(data, source, guard)
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
      // On win32 every signal becomes killTree's taskkill /T /F (PtyHost.kill).
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

  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve(undefined)
    })
  })
  if (pipe) {
    // A pipe vanishes with its server, so there is nothing stale to clear.
    socketPath = await listenEndpoint(runtimeDir, 'deckd', server, { platform }).catch((err) => {
      if (err.code === 'EADDRINUSE') throw new Error(err.path ? `another deckd is listening on ${err.path}` : err.message)
      throw err
    })
  } else {
    const oldMask = process.umask(0o177)
    try {
      await listen()
    } finally {
      process.umask(oldMask)
    }
    await chmod(socketPath, 0o600)
  }

  const close = async () => {
    const pending = [...ptys.values()].map((host) => new Promise((resolve) => {
      host.proc.onExit(() => resolve(undefined))
      host.kill('SIGTERM', 2000)
    }))
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 3000).unref())])
    for (const c of conns) c.socket.destroy()
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    if (!pipe) await unlink(socketPath).catch(() => {})
  }

  return { socketPath, bootId, close }
}

async function main () {
  // XDG_RUNTIME_DIR when set, else the platform's fallback base.
  const runtimeDir = runtimeBase()
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
  else if (failed === 'windows') console.error('deckd: no login shell to ask on Windows, using the service environment')
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
