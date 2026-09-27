// deckd client: one connection to deckd.sock speaking the JSON-lines
// protocol of docs/deck/05-api.md section 5. Used by `fm` and the spike server.
import net from 'node:net'
import path from 'node:path'
import { encode, createLineDecoder, PROTO } from './protocol.mjs'

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
 * ENOENT or ECONNREFUSED when no deckd listens), or with a
 * DeckdRequestError when deckd refuses the hello.
 *
 * Every inbound message gets a sequence number in arrival order, readable
 * with `seqOf(msg)` for responses and passed as the second argument to event
 * listeners. Event listeners run synchronously as each line is decoded,
 * while a request's promise settles a microtask later, so a caller that must
 * order an event against a response compares sequence numbers.
 * @param {{ runtimeDir: string, kind: 'server' | 'terminal', name?: string }} opts
 */
export async function connectDeckd ({ runtimeDir, kind, name }) {
  // Same path as main.mjs socketPaths(); not imported from there, because
  // main.mjs loads node-pty, which a client has no use for.
  const socketPath = path.join(runtimeDir, 'fleetmates-deck', 'deckd.sock')
  const socket = net.connect(socketPath)
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
    await client.request('hello', { proto: PROTO, client: name === undefined ? { kind, pid: process.pid } : { kind, name, pid: process.pid } })
  } catch (err) {
    socket.destroy()
    throw err
  }
  return client
}
