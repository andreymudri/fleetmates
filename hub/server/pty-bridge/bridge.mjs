// The PTY bridge: the server half of the WebSocket terminal channel (docs/deck/05-api.md section 3.5). It
// attaches to deckd once per PTY over the server's deckd link and fans output out to every attached tab,
// writes browser input to deckd behind the checks of the browser trust boundary, sends compact-card tails
// (`screen.tail`) and runs the shared input machine of each PTY (state-machines section 3).
import { createInputMachine } from '../machines/input.mjs'
import { decodeFrame, encodeFrame, FRAME_KIND, MAX_INPUT_BYTES } from './frames.mjs'

/** A tab's output is dropped while its socket has more than this many bytes buffered. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
/** Scrollback lines requested for an attach snapshot. */
export const SNAPSHOT_SCROLLBACK = 1000
/** At most one `screen.tail` per session in this many milliseconds. */
export const TAIL_INTERVAL_MS = 1000
/** Rows a `screen.tail` carries. */
export const TAIL_LINES = 8
/** Most session ids one socket may subscribe to with `sub.tails`. */
export const MAX_TAILS = 50

const ID = /^[A-Za-z0-9_-]{1,64}$/
const OPEN = 1
const isSize = value => Number.isInteger(value) && value >= 1 && value <= 1000
const apiError = code => ({ code, message: code, retryable: code === 'deckd_unavailable' })
// A deckd refusal of a known PTY means it is gone; a link that is down or timed out is deckd_unavailable.
const failureCode = error => error?.code === 'not_found' ? 'no_pty' : error?.code === 'deckd_unavailable' || error?.code === 'timeout' || error?.code === 'closed' ? 'deckd_unavailable' : 'internal'

/**
 * The last {@link TAIL_LINES} non-empty rows above the status region of a parsed screen.
 * @param {string[]} lines visible rows as plain text
 * @param {number[]} statusRows rows of the status region (screen/status-region.mjs)
 * @returns {string[]}
 */
export function tailLines(lines, statusRows) {
  const end = statusRows.length ? Math.min(...statusRows) : lines.length
  return lines.slice(0, end).map(line => line.trimEnd()).filter(line => line.trim()).slice(-TAIL_LINES)
}

/**
 * @typedef {{ readyState: number, bufferedAmount: number, send: (data: string | Buffer) => void }} TabSocket
 * @typedef {{ ws: TabSocket, sessionId: string, ptyId: string, cols: number, rows: number, buffer: { seq: number, msg: any }[] | null,
 *   syncs: number, dropping: boolean, attached: boolean }} Tab
 */

/**
 * Create the PTY bridge over the server's deckd link.
 * @param {{ link: import('../pty/link.mjs').DeckdLink, store: object, publish: (event: object) => void, now?: () => number,
 *   setTimeout?: Function, clearTimeout?: Function }} options `publish` fans an unsequenced event out to every ready socket
 * @returns {{ message: (ws: TabSocket, msg: any) => Promise<void> | void, binary: (ws: TabSocket, data: any) => void,
 *   close: (ws: TabSocket) => void, dispose: () => void }}
 */
export function createPtyBridge({ link, store, publish, now = Date.now, setTimeout: arm = setTimeout, clearTimeout: disarm = clearTimeout }) {
  /** @type {Map<TabSocket, { tabs: Map<string, Tab>, tails: Set<string> }>} */
  const sockets = new Map()
  /** @type {Map<string, { tabs: Set<Tab>, ready: Promise<any> }>} ptyId -> the tabs attached to it */
  const ptys = new Map()
  /** ptyId -> the last deckd attach or detach for it, so they reach deckd in order */
  const chains = new Map()
  /** @type {Map<string, ReturnType<typeof createInputMachine>>} */
  const machines = new Map()
  /** @type {Map<string, { at: number, timer: any, lines: string[] | null }>} sessionId -> tail throttle */
  const tails = new Map()

  const socketOf = ws => {
    let entry = sockets.get(ws)
    if (!entry) sockets.set(ws, entry = { tabs: new Map(), tails: new Set() })
    return entry
  }
  const send = (ws, message) => { if (ws.readyState === OPEN) ws.send(JSON.stringify({ ...message, at: now() })) }
  const termError = (ws, sessionId, code) => send(ws, { t: 'term.error', sessionId, error: apiError(code) })
  const invalid = ws => send(ws, { t: 'error', data: apiError('validation_failed') })
  const sendFrame = (ws, kind, sessionId, bytes) => { if (ws.readyState === OPEN) ws.send(encodeFrame(kind, sessionId, bytes)) }
  const current = tab => sockets.get(tab.ws)?.tabs.get(tab.sessionId) === tab
  const rowOf = sessionId => store.get('SELECT id,origin,pty_id,alive FROM sessions WHERE id=?', sessionId)
  const hasPty = row => !!row && row.origin !== 'observed' && !!row.alive && typeof row.pty_id === 'string' && row.pty_id !== ''
  const liveSession = ptyId => store.get('SELECT id,last_input_from,last_input_name FROM sessions WHERE pty_id=? AND alive=1', ptyId)

  function serial(ptyId, fn) {
    const run = (chains.get(ptyId) ?? Promise.resolve()).catch(() => {}).then(fn)
    chains.set(ptyId, run)
    const clean = () => { if (chains.get(ptyId) === run) chains.delete(ptyId) }
    run.then(clean, clean)
    return run
  }
  function ptyOf(ptyId) {
    let pty = ptys.get(ptyId)
    if (!pty) {
      pty = { tabs: new Set(), ready: serial(ptyId, () => link.request('attach', { ptyId, stream: true })) }
      pty.ready.catch(() => {})
      ptys.set(ptyId, pty)
    }
    return pty
  }
  function removeTab(tab) {
    const socket = sockets.get(tab.ws)
    if (socket?.tabs.get(tab.sessionId) === tab) socket.tabs.delete(tab.sessionId)
    const pty = ptys.get(tab.ptyId)
    if (!pty || !pty.tabs.delete(tab) || pty.tabs.size) return
    ptys.delete(tab.ptyId)
    if (!link.connected) return
    // deckd's detach also turns off this connection's screen watch, which the link needs for parsing.
    serial(tab.ptyId, () => link.request('detach', { ptyId: tab.ptyId }).then(() => link.request('watchScreen', { ptyId: tab.ptyId, on: true }))).catch(() => {})
  }
  function deliver(tab, bytes) {
    const { ws } = tab
    if (ws.readyState !== OPEN || tab.dropping) return
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      tab.dropping = true
      termError(ws, tab.sessionId, 'output_dropped')
      return
    }
    sendFrame(ws, FRAME_KIND.output, tab.sessionId, bytes)
  }
  // Snapshot then stream: only output events whose arrival number (`link.seqOf`) is after the screen
  // response's are streamed; the ones before it are expected in the response's scrollback. The sync that
  // completes first after a term.attach or a deckd outage sends term.attached before its snapshot and the
  // browser resize after it; a sync superseded by a later one (a `dropped` event) sends nothing.
  async function sync(tab) {
    const turn = ++tab.syncs
    tab.buffer = []
    let screen
    try { screen = await link.request('screen', { ptyId: tab.ptyId, scrollback: SNAPSHOT_SCROLLBACK }) } catch (error) {
      if (!current(tab) || tab.syncs !== turn) return
      removeTab(tab)
      return termError(tab.ws, tab.sessionId, failureCode(error))
    }
    if (!current(tab) || tab.syncs !== turn) return
    const seam = link.seqOf(screen) ?? 0
    const first = !tab.attached
    tab.attached = true
    if (first) send(tab.ws, { t: 'term.attached', sessionId: tab.sessionId, ptyId: tab.ptyId, cols: screen.cols, rows: screen.rows })
    sendFrame(tab.ws, FRAME_KIND.snapshot, tab.sessionId, Buffer.from(typeof screen.scrollback === 'string' ? screen.scrollback : '', 'base64'))
    const later = tab.buffer.filter(entry => entry.seq > seam)
    tab.buffer = null
    for (const entry of later) deliver(tab, Buffer.from(entry.msg.data, 'base64'))
    if (first) link.request('resize', { ptyId: tab.ptyId, cols: tab.cols, rows: tab.rows, source: { kind: 'browser' } }).catch(() => {})
  }

  async function attach(ws, msg) {
    const { sessionId, cols, rows } = msg
    if (typeof sessionId !== 'string' || !ID.test(sessionId) || !isSize(cols) || !isSize(rows)) return termError(ws, typeof sessionId === 'string' ? sessionId : null, 'validation_failed')
    const row = rowOf(sessionId)
    if (!row) return termError(ws, sessionId, 'not_found')
    if (!hasPty(row)) return termError(ws, sessionId, 'no_pty')
    if (!link.connected) return termError(ws, sessionId, 'deckd_unavailable')
    const socket = socketOf(ws)
    const previous = socket.tabs.get(sessionId)
    /** @type {Tab} */
    const tab = { ws, sessionId, ptyId: row.pty_id, cols, rows, buffer: [], syncs: 0, dropping: false, attached: false }
    socket.tabs.set(sessionId, tab)
    const pty = ptyOf(tab.ptyId)
    pty.tabs.add(tab)
    if (previous) removeTab(previous)
    try { await pty.ready } catch (error) {
      if (!current(tab)) return
      removeTab(tab)
      if (ptys.get(tab.ptyId) === pty) ptys.delete(tab.ptyId)
      return termError(ws, sessionId, failureCode(error))
    }
    if (current(tab)) await sync(tab)
  }
  function resize(ws, msg) {
    const { sessionId, cols, rows } = msg
    if (typeof sessionId !== 'string' || !isSize(cols) || !isSize(rows)) return termError(ws, typeof sessionId === 'string' ? sessionId : null, 'validation_failed')
    const tab = sockets.get(ws)?.tabs.get(sessionId)
    if (!tab) return termError(ws, sessionId, 'not_attached')
    tab.cols = cols
    tab.rows = rows
    link.request('resize', { ptyId: tab.ptyId, cols, rows, source: { kind: 'browser' } }).catch(error => termError(ws, sessionId, failureCode(error)))
  }
  function subscribe(ws, msg) {
    const ids = msg.sessionIds
    if (!Array.isArray(ids) || ids.length > MAX_TAILS || !ids.every(id => typeof id === 'string')) return invalid(ws)
    socketOf(ws).tails = new Set(ids)
  }

  function sendTail(sessionId, lines) {
    for (const [ws, socket] of sockets) if (socket.tails.has(sessionId)) send(ws, { t: 'screen.tail', data: { sessionId, lines } })
  }
  function parsed(event) {
    const { sessionId } = event
    if (!sessionId || ![...sockets.values()].some(socket => socket.tails.has(sessionId))) return
    const lines = tailLines(event.lines, event.parsed.statusRows)
    const at = now()
    let tail = tails.get(sessionId)
    if (!tail) tails.set(sessionId, tail = { at: -Infinity, timer: null, lines: null })
    if (!tail.timer && at - tail.at >= TAIL_INTERVAL_MS) {
      tail.at = at
      return sendTail(sessionId, lines)
    }
    tail.lines = lines
    if (tail.timer) return
    tail.timer = arm(() => {
      tail.timer = null
      tail.at = now()
      sendTail(sessionId, tail.lines)
    }, Math.max(0, tail.at + TAIL_INTERVAL_MS - at))
    tail.timer?.unref?.()
  }

  function machineOf(ptyId) {
    let machine = machines.get(ptyId)
    if (!machine) {
      const row = liveSession(ptyId)
      machine = createInputMachine({ now, setTimeout: (fn, ms) => { const timer = arm(fn, ms)
        timer?.unref?.()
        return timer }, clearTimeout: disarm, from: row?.last_input_from ?? null, name: row?.last_input_name ?? null,
      emit: view => {
        const session = liveSession(ptyId)
        if (session) publish({ t: 'input.source', data: { sessionId: session.id, ...view } })
      } })
      machines.set(ptyId, machine)
    }
    return machine
  }
  function forget(ptyId) {
    machines.get(ptyId)?.close()
    machines.delete(ptyId)
  }

  const offs = [
    link.on('output', (msg, seq) => {
      const pty = ptys.get(msg?.ptyId)
      if (!pty || typeof msg.data !== 'string') return
      let bytes
      for (const tab of pty.tabs) {
        if (tab.buffer) tab.buffer.push({ seq, msg })
        else deliver(tab, bytes ??= Buffer.from(msg.data, 'base64'))
      }
    }),
    link.on('dropped', msg => {
      for (const tab of ptys.get(msg?.ptyId)?.tabs ?? []) void sync(tab)
    }),
    link.on('exit', msg => {
      const pty = ptys.get(msg?.ptyId)
      forget(msg?.ptyId)
      if (!pty) return
      ptys.delete(msg.ptyId)
      for (const tab of pty.tabs) {
        const socket = sockets.get(tab.ws)
        if (socket?.tabs.get(tab.sessionId) === tab) socket.tabs.delete(tab.sessionId)
        send(tab.ws, { t: 'term.exit', sessionId: tab.sessionId, code: msg.code ?? null, signal: msg.signal ?? null })
      }
    }),
    // A deckd outage ends every deckd attach. Tabs stay attached on this side, so their input is refused as
    // deckd_unavailable, and are attached again with term.attached, a fresh snapshot and the browser resize
    // when the link is back.
    link.on('down', () => {
      ptys.clear()
      chains.clear()
      for (const [ws, socket] of sockets) {
        for (const tab of socket.tabs.values()) {
          tab.syncs++
          tab.buffer = null
          tab.attached = false
          termError(ws, tab.sessionId, 'deckd_unavailable')
        }
      }
    }),
    link.on('up', () => {
      for (const socket of sockets.values()) {
        for (const tab of [...socket.tabs.values()]) {
          const row = rowOf(tab.sessionId)
          if (!hasPty(row) || row.pty_id !== tab.ptyId) {
            socket.tabs.delete(tab.sessionId)
            termError(tab.ws, tab.sessionId, 'no_pty')
            continue
          }
          const pty = ptyOf(tab.ptyId)
          pty.tabs.add(tab)
          tab.buffer = []
          pty.ready.then(() => { if (current(tab)) return sync(tab) }, error => {
            if (!current(tab)) return
            removeTab(tab)
            termError(tab.ws, tab.sessionId, failureCode(error))
          })
        }
      }
      // Seed each PTY's count of terminal clients attached before this link came up. Without it, the first of
      // two such terminals to detach would report `detached` while the other is still attached.
      link.request('list').then(list => {
        for (const pty of list.ptys ?? []) machineOf(pty.ptyId).terminals((pty.clients ?? []).filter(client => client?.kind === 'terminal').length)
      }).catch(() => {})
    }),
    link.on('input', msg => { if (typeof msg?.ptyId === 'string') machineOf(msg.ptyId).input(msg.source) }),
    link.on('client', msg => { if (typeof msg?.ptyId === 'string') machineOf(msg.ptyId).client(msg.change, msg.client) }),
    link.onParsed(parsed)
  ]

  return {
    /** Handle one parsed JSON message of a terminal type from a ready socket. */
    message(ws, msg) {
      if (msg.t === 'term.attach') return attach(ws, msg)
      if (msg.t === 'term.detach') {
        const tab = typeof msg.sessionId === 'string' ? sockets.get(ws)?.tabs.get(msg.sessionId) : undefined
        if (tab) removeTab(tab)
        return
      }
      if (msg.t === 'term.resize') return resize(ws, msg)
      if (msg.t === 'sub.tails') return subscribe(ws, msg)
      invalid(ws)
    },
    /** Handle one binary frame from a ready socket: browser input, checked in the order of 05-api 3.5. */
    binary(ws, data) {
      const frame = decodeFrame(data)
      if (!frame) return invalid(ws)
      const { kind, sessionId, payload } = frame
      if (kind !== FRAME_KIND.input) return termError(ws, sessionId, 'validation_failed')
      if (payload.length > MAX_INPUT_BYTES) return termError(ws, sessionId, 'payload_too_large')
      const tab = sockets.get(ws)?.tabs.get(sessionId)
      if (!tab) return termError(ws, sessionId, 'not_attached')
      const row = rowOf(sessionId)
      if (!hasPty(row) || row.pty_id !== tab.ptyId) return termError(ws, sessionId, 'no_pty')
      if (!link.connected) return termError(ws, sessionId, 'deckd_unavailable')
      // The source is the server's to set; the bytes are never logged or stored.
      link.request('write', { ptyId: tab.ptyId, data: payload.toString('base64'), source: { kind: 'browser' } })
        .catch(error => termError(ws, sessionId, failureCode(error)))
    },
    /** A socket closed: drop its tabs and its tail subscription. */
    close(ws) {
      const socket = sockets.get(ws)
      if (!socket) return
      for (const tab of [...socket.tabs.values()]) removeTab(tab)
      sockets.delete(ws)
    },
    /** Stop listening to the link and clear every timer. */
    dispose() {
      for (const off of offs.splice(0)) off()
      for (const tail of tails.values()) if (tail.timer) disarm(tail.timer)
      tails.clear()
      for (const machine of machines.values()) machine.close()
      machines.clear()
      sockets.clear()
      ptys.clear()
    }
  }
}
