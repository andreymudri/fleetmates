// deckd client: one connection to deckd's endpoint (a Unix socket, or a named
// pipe on win32) speaking the JSON-lines protocol of docs/deck/05-api.md
// section 5. Used by `fm` and the web server.
import net from 'node:net'
import path from 'node:path'
import { lstat as fsLstat } from 'node:fs/promises'
import { encode, createLineDecoder, PROTO } from './protocol.mjs'
import { endpoint, endpointSecret, deckDir } from '../platform/index.mjs'

/**
 * On POSIX, refuse to connect through a directory another local user could
 * have prepared: with XDG_RUNTIME_DIR unset the base is the shared
 * `/tmp/fleetmates-deck-<uid>`, and whoever creates it first would receive
 * the hello and every keystroke. The runtime dir and its deck dir (or, when
 * the endpoint fell back to a short /tmp path, only that path's dir) are
 * lstat'ed, and each must be a real directory (not a symlink), owned by `uid`
 * (when not null), with no group or world permission bit. Otherwise rejects
 * with code `not_private` and a message naming the dir. A dir that does not
 * exist rejects with the lstat error (ENOENT), as an unreachable deckd does.
 * Nothing is checked on win32, whose endpoint is a named pipe.
 * @param {string} runtimeDir
 * @param {{ platform?: string, uid?: number | null, lstat?: (p: string) => Promise<import('node:fs').Stats> }} [opts]
 */
export async function checkEndpointDirs (runtimeDir, { platform = process.platform, uid = process.getuid?.() ?? null, lstat = fsLstat } = {}) {
  if (platform === 'win32') return
  const socket = endpoint(runtimeDir, 'deckd', { platform })
  const deck = deckDir(runtimeDir, { platform })
  // The same rule as the hook and fm: the base and its deck dir for
  // `<base>/fleetmates-deck/deckd.sock`; only the socket's own dir for the
  // short /tmp fallback a too-long path gets.
  const dirs = socket === path.posix.join(deck, 'deckd.sock') ? [runtimeDir, deck] : [path.posix.dirname(socket)]
  for (const dir of dirs) {
    const st = await lstat(dir)
    let problem = null
    if (st.isSymbolicLink()) problem = 'is a symlink'
    else if (!st.isDirectory()) problem = 'is not a directory'
    else if (uid !== null && st.uid !== uid) problem = `is owned by uid ${st.uid}, not by this user`
    else if ((st.mode & 0o077) !== 0) problem = `has mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}, which allows group or world access`
    if (problem) {
      throw Object.assign(new Error(`deckd endpoint dir ${dir} is not private: it ${problem}`), { code: 'not_private' })
    }
  }
}

/**
 * An error answered by deckd (`ok: false`), or a request cut off by the
 * connection closing (`code: 'closed'`).
 */
export class DeckdRequestError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor (code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Connect to deckd and say `hello`. Rejects with the socket error (`code`
 * ENOENT or ECONNREFUSED when no deckd listens), with code ENOENT on win32
 * when there is no endpoint key to read, with code `not_private`
 * when checkEndpointDirs refuses the directories (POSIX; checked before
 * connecting), or with a DeckdRequestError when deckd refuses the hello.
 *
 * Every inbound message gets a sequence number in arrival order, readable
 * with `seqOf(msg)` for responses and passed as the second argument to event
 * listeners. Event listeners run synchronously as each line is decoded,
 * while a request's promise settles a microtask later, so a caller that must
 * order an event against a response compares sequence numbers.
 *
 * `proto` is the version asked for in `hello` (default PROTO); the version
 * deckd agreed to, its version, its bootId and the features it announced are
 * then `client.proto`, `client.deckdVersion`, `client.bootId` and
 * `client.features`.
 *
 * `platform` (default the live one) picks the endpoint kind; `uid` (default
 * this process's) is the owner checkEndpointDirs requires. A test pins both.
 * @param {{ runtimeDir: string, kind: 'server' | 'terminal', name?: string, proto?: number, platform?: string, uid?: number | null }} opts
 */
export async function connectDeckd ({ runtimeDir, kind, name, proto = PROTO, platform = process.platform, uid = process.getuid?.() ?? null }) {
  await checkEndpointDirs(runtimeDir, { platform, uid })
  // win32: the pipe name hashes the deckd key, which deckd writes anew each
  // time it starts listening, so it is read on every connect; a client never
  // writes it, and without one there is no deckd to reach.
  const secret = endpointSecret(runtimeDir, { platform, name: 'deckd' })
  if (platform === 'win32' && secret === null) {
    throw Object.assign(new Error(`deckd is not running: no endpoint key in ${deckDir(runtimeDir, { platform })}`), { code: 'ENOENT' })
  }
  // The endpoint main.mjs listens on, from the platform module rather than
  // from main.mjs, because main.mjs loads node-pty, which a client has no use for.
  const socket = net.connect(endpoint(runtimeDir, 'deckd', { platform, secret: secret ?? undefined }))
  await new Promise((resolve, reject) => {
    socket.once('connect', () => { socket.off('error', reject); resolve(undefined) })
    socket.once('error', reject)
  })

  let nextId = 1
  let seq = 0
  let closed = false
  /** @type {Map<number, { resolve: (msg: any) => void, reject: (err: Error) => void }>} */
  const pending = new Map()
  /** @type {Map<string, Set<(msg: any, seq: number) => void>>} */
  const listeners = new Map()
  /** @type {WeakMap<object, number>} */
  const seqs = new WeakMap()

  /**
   * @param {string} ev
   * @param {any} msg
   * @param {number} n
   */
  const emit = (ev, msg, n) => {
    for (const fn of listeners.get(ev) ?? []) fn(msg, n)
  }

  socket.on('data', createLineDecoder((msg) => {
    const n = ++seq
    if (msg && typeof msg === 'object') seqs.set(msg, n)
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const p = /** @type {{ resolve: (msg: any) => void, reject: (err: Error) => void }} */ (pending.get(msg.id))
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg)
      else p.reject(new DeckdRequestError(msg.error?.code ?? 'internal', msg.error?.message ?? 'deckd refused the request'))
    } else if (msg && typeof msg.ev === 'string') {
      emit(msg.ev, msg, n)
    }
  }, () => {}))
  socket.on('error', () => {})
  socket.on('close', () => {
    closed = true
    for (const p of pending.values()) p.reject(new DeckdRequestError('closed', 'deckd connection closed'))
    pending.clear()
    emit('close', {}, ++seq)
  })

  const client = {
    /** Protocol version agreed in `hello`. @type {number} */
    proto: 0,
    /** deckd's version from `hello`. @type {string} */
    deckdVersion: '',
    /** deckd's boot id from `hello`. @type {string} */
    bootId: '',
    /**
     * Optional features deckd announced in `hello`, such as `guardedWrite`;
     * an empty array when the answer has none (an M2 deckd, or proto 1).
     * @type {string[]}
     */
    features: /** @type {string[]} */ ([]),
    /**
     * Send one request; resolves with the `ok: true` response, rejects with a
     * DeckdRequestError carrying deckd's error `code`.
     * @param {string} op
     * @param {object} [fields]
     * @returns {Promise<any>}
     */
    request (op, fields = {}) {
      if (closed) return Promise.reject(new DeckdRequestError('closed', 'deckd connection closed'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.write(encode({ ...fields, id, op }))
      })
    },
    /**
     * Subscribe to an event (`output`, `exit`, ...) or to `close`. Returns
     * the unsubscribe function.
     * @param {string} ev
     * @param {(msg: any, seq: number) => void} fn
     * @returns {() => void}
     */
    on (ev, fn) {
      let set = listeners.get(ev)
      if (!set) listeners.set(ev, set = new Set())
      set.add(fn)
      return () => { set.delete(fn) }
    },
    /**
     * Arrival sequence number of a message this client received.
     * @param {object} msg
     * @returns {number | undefined}
     */
    seqOf (msg) {
      return seqs.get(msg)
    },
    close () {
      socket.destroy()
    }
  }

  try {
    const hello = await client.request('hello', { proto, client: name === undefined ? { kind, pid: process.pid } : { kind, name, pid: process.pid } })
    client.proto = hello.proto
    client.deckdVersion = hello.deckdVersion
    client.bootId = hello.bootId
    client.features = Array.isArray(hello.features) ? hello.features.filter((f) => typeof f === 'string') : []
  } catch (err) {
    socket.destroy()
    throw err
  }
  return client
}
