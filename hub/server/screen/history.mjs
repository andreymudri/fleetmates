// The rendered history of an ended session (docs/deck/06-storage.md `session_scrollback`): stored text
// written into a headless terminal and serialized, so it replays as rows at any browser size. The terminal
// runs in a worker thread (this same file, loaded with `workerData[WORKER_MARK]`), so a costly render never
// blocks the server's event loop; a render past its time limit ends the worker and answers a plain-text
// fallback. Every scan the main thread runs over stored text is a single hand-written pass.
import { Worker, isMainThread, parentPort, resourceLimits, workerData } from 'node:worker_threads'

/** The size a stored row without one (a legacy row or a raw tail) is rendered at. */
export const DEFAULT_RENDER_SIZE = Object.freeze({ cols: 120, rows: 40 })
/** Most UTF-8 bytes of stored text one render feeds the terminal: the newest, cut at a line start. */
export const RENDER_INPUT_CAP = 256 * 1024
/** Most UTF-8 bytes of serialized output a render answers: the newest whole lines. */
export const RENDER_OUTPUT_CAP = 4 * 1024 * 1024
/** Time a render may take in the worker before the worker is ended and the fallback is answered. */
export const RENDER_TIMEOUT_MS = 2000
/** Time a new worker may take to load the terminal before it is ended and the fallback is answered. */
export const RENDER_STARTUP_MS = 10_000
/** Most scrollback rows a render keeps, and most lines a fallback keeps. */
export const RENDER_SCROLLBACK_MAX = 5000
/** Heap limit of the render worker, so a render that grows without bound ends the worker, not the server. */
const WORKER_HEAP_MB = 512

const WORKER_MARK = 'deckHistoryWorker'
/** What addon-serialize 0.14.0 writes before the alternate screen's rows (as in deckd's ScreenModel). */
const ALT_SWITCH = '\x1b[?1049h\x1b[H'

const ESC = 0x1b
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const isDigit = code => code >= 0x30 && code <= 0x39

/**
 * A history size clamped to 20..500 columns and 5..200 rows, or null when either is not a finite number.
 * @param {{ cols?: unknown, rows?: unknown } | undefined | null} size
 * @returns {{ cols: number, rows: number } | null}
 */
export function historySize(size) {
  const { cols, rows } = size ?? {}
  if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isFinite(cols) || !Number.isFinite(rows)) return null
  return { cols: clamp(Math.floor(cols), 20, 500), rows: clamp(Math.floor(rows), 5, 200) }
}

/**
 * The size header `session_scrollback.text` starts with when it holds a serialized history of that size.
 * @param {{ cols: number, rows: number }} size an already clamped size (`historySize`)
 * @returns {string}
 */
export function sizeHeader({ cols, rows }) {
  return `\x1b[8;${rows};${cols}t`
}

/**
 * The digits of 1 to 4 characters at `at` in `text`, followed by `end`, or null.
 * @param {string} text
 * @param {number} at
 * @param {number} end the character code that must follow
 * @returns {{ value: number, next: number } | null}
 */
function headerNumber(text, at, end) {
  let next = at
  while (next < text.length && next - at < 4 && isDigit(text.charCodeAt(next))) next++
  if (next === at || text.charCodeAt(next) !== end) return null
  return { value: Number(text.slice(at, next)), next: next + 1 }
}

/**
 * Split a stored `session_scrollback.text` into its text and the size its header (XTWINOPS "resize to
 * rows x cols", `CSI 8 ; rows ; cols t`) names; a row with no header (a raw tail, or a row written before
 * sizes were stored) has size null.
 * @param {string} stored
 * @returns {{ text: string, size: { cols: number, rows: number } | null }}
 */
export function readStoredHistory(stored) {
  if (!stored.startsWith('\x1b[8;')) return { text: stored, size: null }
  const rows = headerNumber(stored, 4, 0x3b)
  const cols = rows && headerNumber(stored, rows.next, 0x74)
  if (!cols) return { text: stored, size: null }
  return { text: stored.slice(cols.next), size: historySize({ cols: cols.value, rows: rows.value }) }
}

/** C0 controls xterm executes inside a CSI without leaving it (all but CAN, SUB and ESC), and DEL, which it ignores. */
const inCsi = code => (code <= 0x1f && code !== 0x18 && code !== 0x1a && code !== ESC) || code === 0x7f

/**
 * Where the CSI introduced at `at` has its parameters: after `ESC`, any controls xterm executes there, and
 * `[`; or after the C1 introducer `0x9b`. -1 when no CSI starts at `at`.
 * @param {string} text
 * @param {number} at
 * @returns {number}
 */
function csiBody(text, at) {
  const code = text.charCodeAt(at)
  if (code === 0x9b) return at + 1
  if (code !== ESC) return -1
  let next = at + 1
  while (next < text.length && inCsi(text.charCodeAt(next))) next++
  return text.charCodeAt(next) === 0x5b ? next + 1 : -1
}

/**
 * Clamp the first parameter of the CSI sequences whose cost grows with it, so a crafted count costs at most
 * a screenful: IL, DL, SU and SD to `rows`; ICH, DCH, ECH, CHT and CBT to `cols`; REP to `cols * rows`, a
 * screenful of repeats (it wraps). Only sequences with no prefix and no intermediate are touched. Further
 * parameters and subparameters, which xterm ignores for these, are kept. Controls inside the sequence are
 * moved in front of it, where xterm executes them anyway. Every other sequence passes through unchanged.
 * One pass: each character is read at most twice. When a REP count is reduced, `seen.rep` is set true, since
 * the repeats left out are lost from the history.
 * @param {string} text
 * @param {number} cols
 * @param {number} rows
 * @param {{ rep: boolean }} [seen]
 * @returns {string}
 */
export function boundCounts(text, cols, rows, seen) {
  let out = ''
  let copied = 0
  for (let at = 0; at < text.length;) {
    const body = csiBody(text, at)
    if (body === -1) {
      at++
      continue
    }
    let end = body
    let params = ''
    let controls = ''
    for (; end < text.length; end++) {
      const code = text.charCodeAt(end)
      if (isDigit(code) || code === 0x3b || code === 0x3a) params += text[end]
      else if (inCsi(code)) {
        if (code !== 0x7f) controls += text[end]
      } else break
    }
    const final = text[end]
    if (final === undefined || !'@ILMPSTXZb'.includes(final)) {
      // Nothing between `at` and `end` can start another CSI (no ESC, no 0x9b), so the scan resumes at `end`.
      at = Math.max(end, at + 1)
      continue
    }
    let digits = 0
    while (digits < params.length && isDigit(params.charCodeAt(digits))) digits++
    const most = 'LMST'.includes(final) ? rows : final === 'b' ? cols * rows : cols
    if (Number(params.slice(0, digits)) > most) {
      if (final === 'b' && seen) seen.rep = true
      // The controls between ESC and `[` are not kept in `controls`; collect them too.
      let lead = ''
      if (text.charCodeAt(at) === ESC) for (let i = at + 1; i < body - 1; i++) if (text.charCodeAt(i) !== 0x7f) lead += text[i]
      out += text.slice(copied, at) + lead + controls + `\x1b[${most}${params.slice(digits)}${final}`
      copied = end + 1
    }
    at = end + 1
  }
  return copied === 0 ? text : out + text.slice(copied)
}

/** String introducers after ESC: DCS `P`, SOS `X`, OSC `]`, PM `^`, APC `_`. */
const ESC_STRINGS = 'PX]^_'
/** C1 string introducers: DCS, SOS, OSC, PM, APC. */
const isC1String = code => code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f

/**
 * Where the escape sequence that starts at `at` ends (the index after it), for an ESC or a C1 control at
 * `at`; `at + 1` for anything else. A CSI ends at its final byte, or before an ESC, CAN, SUB or a character
 * that cannot belong to it. A string (OSC, DCS, SOS, PM, APC) ends after BEL, ST (`ESC \` or `0x9c`), or
 * before CAN, SUB or another ESC; an unterminated one runs to the end. Other ESC sequences end after their
 * intermediates and final. Reads each character once.
 * @param {string} text
 * @param {number} at
 * @returns {number}
 */
export function sequenceEnd(text, at) {
  const first = text.charCodeAt(at)
  let next = at + 1
  let kind
  if (first === 0x9b) kind = 'csi'
  else if (isC1String(first)) kind = 'string'
  else if (first !== ESC) return next
  else {
    while (next < text.length && inCsi(text.charCodeAt(next))) next++
    if (next >= text.length) return next
    const code = text.charCodeAt(next)
    if (code === 0x5b) kind = 'csi'
    else if (ESC_STRINGS.includes(text[next])) kind = 'string'
    else {
      while (next < text.length && text.charCodeAt(next) >= 0x20 && text.charCodeAt(next) <= 0x2f) next++
      const final = text.charCodeAt(next)
      return final >= 0x30 && final <= 0x7e ? next + 1 : next
    }
    next++
  }
  if (kind === 'csi') {
    for (; next < text.length; next++) {
      const code = text.charCodeAt(next)
      if (code >= 0x40 && code <= 0x7e) return next + 1
      if (!(code >= 0x20 && code <= 0x3f) && !inCsi(code)) return next
    }
    return next
  }
  for (; next < text.length; next++) {
    const code = text.charCodeAt(next)
    if (code === 0x07 || code === 0x9c) return next + 1
    if (code === 0x18 || code === 0x1a) return next
    if (code === ESC) return text.charCodeAt(next + 1) === 0x5c ? next + 2 : next
  }
  return next
}

/**
 * `text` with every escape sequence (`sequenceEnd`) and every control character except CR and LF removed,
 * C1 controls and DEL included. One pass.
 * @param {string} text
 * @returns {string}
 */
export function stripControls(text) {
  let out = ''
  let copied = 0
  for (let at = 0; at < text.length;) {
    const code = text.charCodeAt(at)
    const control = code === 0x7f || (code >= 0x80 && code <= 0x9f) || (code < 0x20 && code !== 0x0a && code !== 0x0d)
    if (!control) {
      at++
      continue
    }
    out += text.slice(copied, at)
    at = code === ESC || (code >= 0x80 && code <= 0x9f) ? Math.max(at + 1, sequenceEnd(text, at)) : at + 1
    copied = at
  }
  return copied === 0 ? text : out + text.slice(copied)
}

/**
 * The plain text a render answers when the terminal could not render `text`: escape sequences and controls
 * removed (`stripControls`), each line reduced to what follows its last lone CR, lines joined by CRLF, the
 * newest `RENDER_SCROLLBACK_MAX` lines kept. Always truncated.
 * @param {string} text
 * @returns {{ data: string, truncated: true }}
 */
export function fallbackHistory(text) {
  const lines = stripControls(text).split('\n')
  const kept = lines.slice(-RENDER_SCROLLBACK_MAX).map(line => {
    const body = line.endsWith('\r') ? line.slice(0, -1) : line
    return body.slice(body.lastIndexOf('\r') + 1)
  })
  return { data: kept.join('\r\n'), truncated: true }
}

/** True for an ESC or a C1 control, where `sequenceEnd` may find a sequence. */
const introduces = code => code === ESC || (code >= 0x80 && code <= 0x9f)

/**
 * The newest at most `RENDER_INPUT_CAP` bytes of `text`, cut at a line start (after a CRLF) when one is in
 * reach. Otherwise the cut lands on a character boundary and, when it falls inside an escape sequence,
 * moves to the end of that sequence, so no partial sequence is fed as text.
 * @param {string} text
 * @returns {string}
 */
export function newestInput(text) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= RENDER_INPUT_CAP) return text
  const from = buf.length - RENDER_INPUT_CAP
  const crlf = buf.indexOf('\r\n', Math.max(0, from - 2))
  if (crlf !== -1) return buf.subarray(crlf + 2).toString('utf8')
  let byte = from
  while (byte < buf.length && (buf[byte] & 0xc0) === 0x80) byte++
  let cut = text.length - buf.subarray(byte).toString('utf8').length
  let last = cut - 1
  while (last >= 0 && !introduces(text.charCodeAt(last))) last--
  if (last >= 0) cut = Math.max(cut, sequenceEnd(text, last))
  return text.slice(cut)
}

/**
 * The newest whole lines of `data` within `RENDER_OUTPUT_CAP` UTF-8 bytes.
 * @param {string} data
 * @returns {{ data: string, truncated: boolean }}
 */
export function capOutput(data) {
  const buf = Buffer.from(data, 'utf8')
  if (buf.length <= RENDER_OUTPUT_CAP) return { data, truncated: false }
  const crlf = buf.indexOf('\r\n', buf.length - RENDER_OUTPUT_CAP - 2)
  return { data: crlf === -1 ? '' : buf.subarray(crlf + 2).toString('utf8'), truncated: true }
}

/**
 * Start a render worker: this file in a worker thread, with an empty environment, no inherited exec
 * arguments and a bounded heap. It posts `{ ready: true }` once the terminal is loaded, then answers each
 * `{ id, text, cols, rows }` with `{ id, data, truncated }` or `{ id, error: true }`, and `{ probe: 'env' }`
 * with `{ probe: 'env', envNames, execArgv, resourceLimits }` (names only, never values), for tests.
 * @returns {Worker}
 */
export function spawnHistoryWorker() {
  return new Worker(new URL(import.meta.url), {
    workerData: { [WORKER_MARK]: true },
    env: {},
    execArgv: [],
    stdout: false,
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB }
  })
}

/**
 * A renderer that owns one lazily started worker and sends it one render at a time. A render that takes
 * longer than `timeoutMs`, a worker that is not ready within `startupMs`, fails to start, errors or exits,
 * and a worker that reports an error each end that worker (`terminate()`) and answer `fallbackHistory`; the
 * next render starts a fresh worker. The worker is unreferenced, so an idle renderer never keeps the
 * process alive. Only the newest `RENDER_INPUT_CAP` bytes (`newestInput`) are sent.
 * @param {{ timeoutMs?: number, startupMs?: number, spawn?: () => Worker }} [options]
 */
export function createHistoryRenderer({ timeoutMs = RENDER_TIMEOUT_MS, startupMs = RENDER_STARTUP_MS, spawn = spawnHistoryWorker } = {}) {
  /** @type {Worker | null} */
  let worker = null
  /** @type {Promise<void> | null} */
  let ready = null
  let seq = 0
  let queue = Promise.resolve()

  const drop = w => {
    if (worker === w) {
      worker = null
      ready = null
    }
    w.terminate().catch(() => {})
  }

  function start() {
    const w = spawn()
    w.unref()
    worker = w
    ready = new Promise((resolve, reject) => {
      const settle = error => {
        clearTimeout(timer)
        w.off('message', onMessage)
        w.off('error', settle)
        w.off('exit', settle)
        if (error === undefined) resolve()
        else reject(error instanceof Error ? error : new Error('render worker exited'))
      }
      const onMessage = message => {
        if (message?.ready) settle(undefined)
      }
      const timer = setTimeout(() => settle(new Error('render worker did not start')), startupMs)
      w.on('message', onMessage)
      w.on('error', settle)
      w.on('exit', settle)
    })
    ready.catch(() => {})
  }

  async function renderInWorker(text, size, limit) {
    if (!worker) start()
    const w = /** @type {Worker} */ (worker)
    try { await ready } catch (error) {
      drop(w)
      throw error
    }
    return new Promise((resolve, reject) => {
      const id = ++seq
      const cleanup = () => {
        clearTimeout(timer)
        w.off('message', onMessage)
        w.off('error', fail)
        w.off('exit', fail)
      }
      const fail = error => {
        cleanup()
        drop(w)
        reject(error instanceof Error ? error : new Error('render worker exited'))
      }
      const onMessage = message => {
        if (message?.id !== id) return
        if (message.error) return fail(new Error('render failed in the worker'))
        cleanup()
        resolve({ data: message.data, truncated: message.truncated })
      }
      const timer = setTimeout(() => fail(new Error('render timed out')), limit)
      w.on('message', onMessage)
      w.on('error', fail)
      w.on('exit', fail)
      w.postMessage({ id, text, cols: size.cols, rows: size.rows })
    })
  }

  return {
    /**
     * Render `text` at `cols` x `rows` (clamped as `historySize` does) in the worker.
     * @param {string} text
     * @param {{ cols?: number, rows?: number, timeoutMs?: number }} [options]
     * @returns {Promise<{ data: string, truncated: boolean }>}
     */
    render(text, { cols = DEFAULT_RENDER_SIZE.cols, rows = DEFAULT_RENDER_SIZE.rows, timeoutMs: limit = timeoutMs } = {}) {
      const size = historySize({ cols, rows }) ?? DEFAULT_RENDER_SIZE
      const fed = newestInput(text)
      const cut = fed !== text
      const job = queue.then(() => renderInWorker(fed, size, limit)).then(
        out => ({ data: out.data, truncated: out.truncated || cut }),
        () => fallbackHistory(fed)
      )
      queue = job.then(() => {}, () => {})
      return job
    },
    /** End the worker, if one runs. */
    close() {
      if (worker) drop(worker)
    }
  }
}

/** @type {ReturnType<typeof createHistoryRenderer> | null} */
let shared = null

/**
 * Write `text` into a headless terminal of the given size (clamped as `historySize` does) and return its
 * serialized scrollback and screen, with colours and attributes, no terminal modes and no alternate-buffer
 * switch. The terminal runs in the shared render worker (`createHistoryRenderer`); after `timeoutMs`
 * (default `RENDER_TIMEOUT_MS`) the worker is ended and the answer is `fallbackHistory`. Only the newest
 * `RENDER_INPUT_CAP` bytes are written, with crafted counts bounded (`boundCounts`) and long-cluster
 * repeats dropped, into a scrollback sized from the input (at most `RENDER_SCROLLBACK_MAX` rows); the
 * output keeps its newest `RENDER_OUTPUT_CAP` bytes. `truncated` is true when input or output was left out,
 * repeats a clamped REP count left out included.
 * @param {string} text
 * @param {{ cols?: number, rows?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ data: string, truncated: boolean }>}
 */
export function renderHistory(text, options) {
  shared ??= createHistoryRenderer()
  return shared.render(text, options)
}

// ---------------------------------------------------------------------------------------------------------
// The worker side. Nothing below runs on the main thread.

/**
 * Make REP (`CSI Ps b`) on `term` a no-op when it would print more than `16 * cols * rows` code units: the
 * repeated character is a long cluster, and xterm copies the whole cluster once per count. A wide
 * character's cluster sits in the cell before its trailing half.
 * @param {import('@xterm/headless').Terminal} term
 * @param {number} cols
 * @param {number} rows
 */
function guardRepeat(term, cols, rows) {
  term.parser.registerCsiHandler({ final: 'b' }, params => {
    const count = typeof params[0] === 'number' && params[0] > 0 ? params[0] : 1
    const buffer = term.buffer.active
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    let cell = line?.getCell(buffer.cursorX - 1)
    if (cell && cell.getWidth() === 0) cell = line?.getCell(buffer.cursorX - 2)
    return (cell?.getChars().length ?? 0) * count > 16 * cols * rows
  })
}

/**
 * The scrollback and the screen, serialized without modes and without an alternate-buffer switch, the way
 * deckd's `ScreenModel.history()` does it.
 * @param {import('@xterm/headless').Terminal} term
 * @param {{ serialize: Function }} serializer
 * @param {number} scrollback
 * @returns {string}
 */
function serialize(term, serializer, scrollback) {
  const opts = { excludeModes: true, excludeAltBuffer: true }
  if (term.buffer.active.type !== 'alternate') return serializer.serialize({ ...opts, scrollback })
  const full = serializer.serialize({ excludeModes: true, scrollback })
  const at = full.indexOf(ALT_SWITCH)
  const alt = at === -1 ? '' : full.slice(at + ALT_SWITCH.length)
  const len = term.buffer.normal.length
  const normal = serializer.serialize({ ...opts, range: { start: Math.max(0, len - scrollback - term.rows), end: len - 1 } })
  return `${normal}\x1b[0m\r\n${alt}`
}

/**
 * Render `text` in this thread. Only the worker calls it.
 * @param {{ Terminal: any, SerializeAddon: any }} xterm
 * @param {string} text
 * @param {{ cols: number, rows: number }} size
 * @returns {Promise<{ data: string, truncated: boolean }>}
 */
async function renderHere({ Terminal, SerializeAddon }, text, { cols, rows }) {
  const seen = { rep: false }
  const input = boundCounts(text, cols, rows, seen)
  let newlines = 0
  for (let at = input.indexOf('\n'); at !== -1; at = input.indexOf('\n', at + 1)) newlines++
  const scrollback = Math.min(RENDER_SCROLLBACK_MAX, newlines + Math.ceil(input.length / cols) + 1)
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true, logLevel: 'off' })
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)
  guardRepeat(term, cols, rows)
  try {
    await new Promise(resolve => term.write(input, () => resolve(undefined)))
    const full = term.buffer.normal.length >= scrollback + rows
    const out = capOutput(serialize(term, serializer, scrollback))
    return { data: out.data, truncated: out.truncated || full || seen.rep }
  } finally {
    term.dispose()
  }
}

async function runWorker() {
  const { Terminal } = (await import('@xterm/headless')).default
  const { SerializeAddon } = (await import('@xterm/addon-serialize')).default
  const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort)
  port.on('message', async ({ id, text, cols, rows, probe }) => {
    if (probe === 'env') {
      port.postMessage({ probe, envNames: Object.keys(process.env), execArgv: process.execArgv, resourceLimits })
      return
    }
    try {
      port.postMessage({ id, ...(await renderHere({ Terminal, SerializeAddon }, text, { cols, rows })) })
    } catch {
      port.postMessage({ id, error: true })
    }
  })
  port.postMessage({ ready: true })
}

if (!isMainThread && workerData?.[WORKER_MARK]) runWorker()
