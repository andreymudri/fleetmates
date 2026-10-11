import { WebSocketServer, WebSocket } from 'ws'
import { authorize, securityHeaders } from '../http/auth.mjs'
import { createPtyBridge } from '../pty-bridge/bridge.mjs'
/** Client message types the PTY bridge handles after hello (05-api 3.5). */
const TERMINAL_TYPES = new Set(['term.attach', 'term.detach', 'term.resize', 'sub.tails'])
/** Client message types accepted and ignored for now (05-api 3.6). */
const IGNORED_TYPES = new Set(['ui.focus', 'bell.played'])
/**
 * Attach authenticated snapshot/replay sockets to an HTTP server. With a deckd `link`, ready sockets also
 * carry the terminal channel through the PTY bridge.
 */
export function createWsHub({ server, store, epoch, snapshot, getToken, getPort, getPublicOrigin = () => null, link = null, now = Date.now,
  heartbeatMs = 15_000, helloTimeoutMs = 5000 }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: () => 'deck.v1' })
  const states = new Map()
  const headSeq = () => Number(store.get('SELECT COALESCE(MAX(seq),0) AS seq FROM events').seq)
  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'Slow consumer')
      return }
    ws.send(JSON.stringify(message))
  }
  function reject(socket, status, code) {
    const body = JSON.stringify({ error: { code, message: code, retryable: false } })
    const headers = { ...securityHeaders(getPort(), true, getPublicOrigin()), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' }
    socket.end(`HTTP/1.1 ${status} Rejected\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n${body}`)
  }
  function upgrade(req, socket, head) {
    const failure = authorize(req, { port: getPort(), token: getToken(), upgrade: true, publicOrigin: getPublicOrigin() })
    if (failure) { reject(socket, failure.status, failure.code)
      return }
    if (req.url !== '/api/ws') { reject(socket, 404, 'not_found')
      return }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  }
  const onUpgrade = (req, socket, head) => {
    try { upgrade(req, socket, head) } catch { reject(socket, 401, 'unauthorized') }
  }
  server.on('upgrade', onUpgrade)
  wss.on('headers', headers => {
    for (const [key, value] of Object.entries(securityHeaders(getPort(), true, getPublicOrigin()))) headers.push(`${key}: ${value}`)
  })
  let hub
  const bridge = link ? createPtyBridge({ link, store, now, publish: event => hub.publish(event) }) : null
  const invalid = ws => send(ws, { t: 'error', at: now(), data: { code: 'validation_failed', message: 'validation_failed', retryable: false } })
  // After hello: JSON control messages and binary terminal frames. A bad message is answered, never fatal.
  function dispatch(ws, raw, binary) {
    if (binary) return bridge ? bridge.binary(ws, raw) : invalid(ws)
    let message
    try { message = JSON.parse(raw.toString()) } catch { return invalid(ws) }
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') return invalid(ws)
    if (IGNORED_TYPES.has(message.t)) return
    if (bridge && TERMINAL_TYPES.has(message.t)) return void Promise.resolve(bridge.message(ws, message)).catch(() => {})
    invalid(ws)
  }
  wss.on('connection', ws => {
    const state = { ready: false, syncing: false, pending: [], seq: 0 }
    states.set(ws, state)
    const timeout = setTimeout(() => ws.close(4400, 'Missing hello'), helloTimeoutMs)
    ws.on('error', () => {})
    ws.once('close', () => { clearTimeout(timeout)
      states.delete(ws)
      bridge?.close(ws) })
    ws.on('message', async (raw, binary) => {
      if (state.ready) {
        try { dispatch(ws, raw, binary) } catch { invalid(ws) }
        return
      }
      try {
        const hello = JSON.parse(raw.toString())
        if (binary || state.syncing || state.ready || hello.t !== 'hello' || !Number.isSafeInteger(hello.lastSeq) || hello.lastSeq < 0 || !(hello.epoch === null || typeof hello.epoch === 'string')) { ws.close(4400, 'Bad hello')
          return }
        clearTimeout(timeout)
        if (hello.apiVersion !== 1) { ws.close(4410, 'client_outdated')
          return }
        state.syncing = true
        const head = headSeq()
        send(ws, { t: 'welcome', apiVersion: 1, epoch, serverTime: now(), headSeq: head })
        const rows = store.all('SELECT seq,at,type,data FROM events WHERE at>=? ORDER BY seq DESC LIMIT 5000', now() - 600_000).reverse()
        const replay = hello.epoch === epoch && hello.lastSeq > 0 && hello.lastSeq <= head && rows.length && hello.lastSeq >= Number(rows[0].seq) - 1 && Number(rows.at(-1).seq) === head
        if (replay) {
          const tail = rows.filter(row => Number(row.seq) > hello.lastSeq)
          if (tail.length && Number(tail[0].seq) !== hello.lastSeq + 1 || tail.some((row, index) => index && Number(row.seq) !== Number(tail[index - 1].seq) + 1)) {
            const current = await snapshot()
            state.seq = current.seq
            send(ws, { t: 'snapshot', epoch, ...current })
          } else {
            send(ws, { t: 'replay.begin', from: hello.lastSeq, to: head })
            for (const row of tail) send(ws, { t: row.type, seq: Number(row.seq), at: row.at, data: JSON.parse(row.data) })
            state.seq = head
            send(ws, { t: 'replay.end', seq: head })
          }
        } else {
          const current = await snapshot()
          state.seq = current.seq
          send(ws, { t: 'snapshot', epoch, ...current })
        }
        for (const message of state.pending) if (message.seq === undefined || message.seq > state.seq) { send(ws, message)
          if (message.seq !== undefined) state.seq = message.seq }
        state.pending = []
        state.syncing = false
        state.ready = true
      } catch { ws.close(4400, 'Bad hello') }
    })
  })
  const heartbeat = setInterval(() => {
    for (const [ws, state] of states) if (state.ready) send(ws, { t: 'hb', seq: headSeq(), at: now() })
  }, heartbeatMs)
  heartbeat.unref()
  hub = {
    /** Fan out committed durable events and unsequenced progress. */
    publish(event) {
      const message = { t: event.type ?? event.t, at: event.at ?? now(), data: event.data, ...(event.seq === undefined ? {} : { seq: Number(event.seq) }) }
      for (const [ws, state] of states) {
        if (state.syncing) {
          state.pending.push(message)
          if (state.pending.length > 5000) ws.close(1013, 'Slow consumer')
        } else if (state.ready && (message.seq === undefined || message.seq > state.seq)) { send(ws, message)
          if (message.seq !== undefined) state.seq = message.seq }
      }
    },
    /** Invalidate sockets authenticated before token rotation. */
    rotate() { for (const ws of states.keys()) ws.close(4401, 'token_invalid') },
    /** Stop heartbeats and close all sockets before the HTTP listener. */
    async close() {
      clearInterval(heartbeat)
      bridge?.dispose()
      server.off('upgrade', onUpgrade)
      for (const ws of states.keys()) ws.close(1001, 'Server shutting down')
      const timeout = setTimeout(() => { for (const ws of states.keys()) ws.terminate() }, 100)
      await new Promise(resolve => wss.close(resolve))
      clearTimeout(timeout)
    }
  }
  return hub
}
