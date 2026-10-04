// In-process fake of TurbidAssist's scribed daemon for server tests. It
// listens on `<dir>/turbidassist.sock` and answers the commands of
// docs/deck/reference/vault-turbid-contract.md 2.3 to 2.5 with the daemon's
// default behaviour; `on(cmd, handler)` replaces the answer for one command.
// It never starts a process: it runs inside the test process.

import net from 'node:net'
import path from 'node:path'
import { rm } from 'node:fs/promises'

const SOCKET_NAME = 'turbidassist.sock'

/**
 * Python's repr() of a list of strings, as scribed prints it in messages.
 * @param {string[]} names
 * @returns {string}
 */
function pyList (names) {
  return `[${names.map((n) => `'${n.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')}]`
}

/**
 * A session id in scribed's `YYYY-MM-DDTHH-MM-SS` shape, local time.
 * @param {Date} [d]
 * @returns {string}
 */
function sessionIdFor (d = new Date()) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

/**
 * @typedef {Record<string, unknown> | string | Uint8Array} FakeLine
 *   an object is written as one JSON line (raw UTF-8); a string or bytes are
 *   written as given, with no newline added
 */

/**
 * @typedef {{
 *   events?: FakeLine[],
 *   splitAt?: number[],
 *   chunkDelayMs?: number,
 *   delayMs?: number,
 *   end?: boolean
 * }} FakeAnswer
 *   `splitAt` cuts the concatenated bytes at those offsets and writes each
 *   piece separately, `chunkDelayMs` (default 20) apart; `delayMs` waits before
 *   the first write; `end` closes the connection after the last one
 */

/**
 * @typedef {(cmd: Record<string, any>, conn: { id: number }) =>
 *   FakeAnswer | FakeLine | FakeLine[] | null | undefined |
 *   Promise<FakeAnswer | FakeLine | FakeLine[] | null | undefined>} FakeHandler
 *   null or undefined answers nothing, so the client waits
 */

/**
 * Start a fake scribed on `<dir>/turbidassist.sock`.
 * @param {{
 *   dir: string,
 *   tags?: string[],
 *   stopDelayMs?: number,
 *   tailText?: string,
 *   askDeltas?: string[],
 *   askError?: string | null
 * }} opts
 * @returns {Promise<{
 *   socketPath: string,
 *   received: Array<{ conn: number, raw: string, parsed: any }>,
 *   connections: Array<{ id: number, closed: boolean, subscribed: boolean }>,
 *   state: Record<string, any>,
 *   setStatus: (patch: Record<string, unknown>) => void,
 *   on: (cmd: string, handler: FakeHandler | null) => void,
 *   pushTranscript: (event: Record<string, unknown>) => void,
 *   endSubscribers: () => void,
 *   write: (bytes: string | Uint8Array) => void,
 *   stop: () => Promise<void>
 * }>}
 */
export async function startFakeScribed ({
  dir,
  tags = ['pessoal', 'client-a', 'client-b'],
  stopDelayMs = 0,
  tailText = '',
  askDeltas = ['Esse erro ', 'é de lock.'],
  askError = null
}) {
  const socketPath = path.join(dir, SOCKET_NAME)
  /** @type {Array<{ conn: number, raw: string, parsed: any }>} */
  const received = []
  /** @type {Array<{ id: number, closed: boolean, subscribed: boolean }>} */
  const connections = []
  /** @type {Map<number, net.Socket>} */
  const sockets = new Map()
  /** @type {Map<string, FakeHandler>} */
  const handlers = new Map()
  const state = {
    recording: false,
    session_id: /** @type {string | null} */ (null),
    tag: /** @type {string | null} */ (null),
    elapsed_s: /** @type {number | null} */ (null),
    routed_apps: /** @type {string[]} */ ([]),
    startedAt: 0,
    /** @type {Array<Record<string, unknown>>} */
    asks: []
  }

  const statusEvent = () => ({
    type: 'status',
    recording: state.recording,
    session_id: state.session_id,
    tag: state.tag,
    elapsed_s: state.elapsed_s ?? (state.recording ? Math.round((Date.now() - state.startedAt) / 100) / 10 : 0),
    routed_apps: [...state.routed_apps]
  })

  /** @type {Record<string, FakeHandler>} */
  const defaults = {
    start: (cmd) => {
      if (typeof cmd.tag !== 'string') return { type: 'error', cmd: '?', message: "start: chave 'tag' ausente" }
      if (state.recording) return { type: 'error', cmd: 'start', message: 'sessão já ativa; pare a atual antes' }
      if (!tags.includes(cmd.tag)) {
        return {
          type: 'error',
          cmd: 'start',
          message: `tag desconhecida: '${cmd.tag}' \u2014 as configuradas em synthesis.tag_policies são ${pyList(tags)}`
        }
      }
      Object.assign(state, {
        recording: true, session_id: sessionIdFor(), tag: cmd.tag, elapsed_s: null, startedAt: Date.now(), asks: []
      })
      return { type: 'ok', cmd: 'start', session_id: state.session_id }
    },
    stop: () => {
      if (!state.recording) return { type: 'error', cmd: 'stop', message: 'não há sessão ativa' }
      const id = state.session_id
      Object.assign(state, { recording: false, session_id: null, tag: null, elapsed_s: null, routed_apps: [], asks: [] })
      return { delayMs: stopDelayMs, events: [{ type: 'ok', cmd: 'stop', session_id: id }] }
    },
    status: () => statusEvent(),
    tail: () => ({ type: 'tail', text: state.recording ? tailText : '' }),
    history: () => ({ type: 'history', asks: state.recording ? [...state.asks] : [] }),
    ask: () => {
      if (!state.recording) return { type: 'error', cmd: 'ask', message: 'não há sessão ativa; dê `start` antes de perguntar' }
      /** @type {FakeLine[]} */
      const events = askDeltas.map((text) => ({ type: 'ask_delta', text }))
      events.push(askError === null ? { type: 'ask_done' } : { type: 'error', cmd: 'ask', message: askError })
      return { events }
    },
    subscribe: () => statusEvent()
  }

  /**
   * @param {FakeAnswer | FakeLine | FakeLine[] | null | undefined} result
   * @returns {FakeAnswer | null}
   */
  function normalize (result) {
    if (result === null || result === undefined) return null
    if (Array.isArray(result) || typeof result === 'string' || result instanceof Uint8Array) {
      return { events: Array.isArray(result) ? result : [result] }
    }
    if (typeof result === 'object' && 'type' in result) return { events: [result] }
    return /** @type {FakeAnswer} */ (result)
  }

  /**
   * @param {FakeLine} line
   * @returns {Buffer}
   */
  function bytesOf (line) {
    if (typeof line === 'string') return Buffer.from(line, 'utf8')
    if (line instanceof Uint8Array) return Buffer.from(line)
    return Buffer.from(JSON.stringify(line) + '\n', 'utf8')
  }

  const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * @param {net.Socket} socket
   * @param {FakeAnswer} answer
   */
  async function send (socket, answer) {
    if (answer.delayMs) await sleep(answer.delayMs)
    const all = Buffer.concat((answer.events ?? []).map(bytesOf))
    const cuts = [...(answer.splitAt ?? []), all.length].filter((n) => n > 0 && n <= all.length).sort((a, b) => a - b)
    let from = 0
    for (const [i, cut] of cuts.entries()) {
      if (cut <= from) continue
      if (i > 0) await sleep(answer.chunkDelayMs ?? 20)
      if (socket.destroyed) return
      socket.write(all.subarray(from, cut))
      from = cut
    }
    if (answer.end) socket.end()
  }

  let nextId = 1
  const server = net.createServer((socket) => {
    const conn = { id: nextId++, closed: false, subscribed: false }
    connections.push(conn)
    sockets.set(conn.id, socket)
    socket.on('error', () => {})
    socket.on('close', () => {
      conn.closed = true
      sockets.delete(conn.id)
    })
    let pending = Buffer.alloc(0)
    let queue = Promise.resolve()
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      let nl
      while ((nl = pending.indexOf(0x0a)) !== -1) {
        const raw = pending.subarray(0, nl).toString('utf8')
        pending = pending.subarray(nl + 1)
        if (conn.subscribed) continue
        let parsed = null
        try {
          parsed = JSON.parse(raw)
        } catch {}
        received.push({ conn: conn.id, raw, parsed })
        // Commands on one connection are answered one at a time, in order.
        queue = queue.then(async () => {
          if (socket.destroyed) return
          if (parsed === null || typeof parsed !== 'object' || typeof parsed.cmd !== 'string') {
            await send(socket, { events: [{ type: 'error', cmd: '?', message: 'linha não é um comando válido' }] })
            return
          }
          const handler = handlers.get(parsed.cmd) ?? defaults[parsed.cmd]
          if (!handler) {
            await send(socket, { events: [{ type: 'error', cmd: '?', message: `cmd desconhecido: '${parsed.cmd}'` }] })
            return
          }
          if (parsed.cmd === 'subscribe') conn.subscribed = true
          const answer = normalize(await handler(parsed, { id: conn.id }))
          if (answer) await send(socket, answer)
        }).catch(() => {})
      }
    })
  })

  await rm(socketPath, { force: true })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve(undefined))
  })

  const subscribers = () => connections.filter((c) => c.subscribed && !c.closed)
    .map((c) => sockets.get(c.id)).filter((s) => s !== undefined)

  return {
    socketPath,
    received,
    connections,
    state,
    /** Merge `patch` into the daemon state; `elapsed_s` set here stays fixed. */
    setStatus (patch) {
      Object.assign(state, patch)
    },
    /** Replace the answer to `cmd`; `null` restores the default. */
    on (cmd, handler) {
      if (handler === null) handlers.delete(cmd)
      else handlers.set(cmd, handler)
    },
    /** Send `{"type":"transcript","event":event}` to every open subscription. */
    pushTranscript (event) {
      const line = bytesOf({ type: 'transcript', event })
      for (const s of subscribers()) s.write(line)
    },
    /** End every open subscription from the daemon side (EOF). */
    endSubscribers () {
      for (const s of subscribers()) s.end()
    },
    /** Write raw bytes to every open connection. */
    write (bytes) {
      const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes)
      for (const s of sockets.values()) s.write(buf)
    },
    /** Close every connection, stop listening and remove the socket. */
    async stop () {
      for (const s of sockets.values()) s.destroy()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
      await rm(socketPath, { force: true })
    }
  }
}
