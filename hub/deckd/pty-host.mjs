// One PTY owned by deckd: the node-pty process, its scrollback ring, its
// headless screen model, attached clients and the last input source.
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { Ring } from './ring.mjs'
import { ScreenModel } from './screen-model.mjs'

const require = createRequire(import.meta.url)
/** @type {typeof import('node-pty')} */
const nodePty = require('node-pty')

/** Minimum gap between two applied resizes (SM-O12 default, state-machines 3.5). */
export const RESIZE_MIN_INTERVAL_MS = 1000

/**
 * @typedef {{ kind: 'browser' | 'deck' | 'terminal', name?: string }} InputSource
 * @typedef {{ kind: string, name?: string }} ClientInfo
 */

export class DeckdError extends Error {
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
 * Signal number to name, or null for 0.
 * @param {number | undefined} n
 * @returns {string | null}
 */
function signalName (n) {
  if (!n) return null
  for (const [name, num] of Object.entries(os.constants.signals)) if (num === n) return name
  return String(n)
}

/**
 * Key that identifies an input source for the resize rule.
 * @param {InputSource | ClientInfo | undefined} source
 * @returns {string}
 */
export function sourceKey (source) {
  return `${source?.kind ?? ''}:${source?.name ?? ''}`
}

/**
 * Make a new ptyId: `pty_` + 8 hex chars.
 * @returns {string}
 */
export function newPtyId () {
  return 'pty_' + randomBytes(4).toString('hex')
}

export class PtyHost {
  /**
   * Spawn `claude` in a new PTY. Refuses any argv[0] whose basename is not
   * `claude` with code `spawn_refused`.
   * @param {{ cwd?: string, argv: string[], env?: Record<string, string>, cols?: number, rows?: number, origin?: string }} req
   * @param {{ onOutput: (host: PtyHost, data: Buffer) => void, onExit: (host: PtyHost, exit: { code: number, signal: string | null, at: number }) => void }} hooks
   * @returns {PtyHost}
   */
  static spawn (req, hooks) {
    const argv = req.argv
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || !argv.every((a) => typeof a === 'string')) {
      throw new DeckdError('bad_request', 'argv must be a non-empty array of strings')
    }
    if (path.basename(argv[0]) !== 'claude') {
      throw new DeckdError('spawn_refused', `deckd only spawns claude, not ${argv[0]}`)
    }
    return new PtyHost(req, hooks)
  }

  /**
   * @param {{ cwd?: string, argv: string[], env?: Record<string, string>, cols?: number, rows?: number, origin?: string }} req
   * @param {{ onOutput: (host: PtyHost, data: Buffer) => void, onExit: (host: PtyHost, exit: { code: number, signal: string | null, at: number }) => void }} hooks
   */
  constructor (req, hooks) {
    this.ptyId = newPtyId()
    this.cwd = req.cwd ?? os.homedir()
    this.argv = req.argv
    this.origin = req.origin ?? 'launched'
    this.cols = req.cols ?? 80
    this.rows = req.rows ?? 24
    this.startedAt = Date.now()
    /** @type {InputSource | null} */
    this.lastInputFrom = null
    /** @type {number | null} */
    this.lastInputAt = null
    /** @type {{ code: number, signal: string | null, at: number } | null} */
    this.exited = null
    this.ring = new Ring()
    this.screen = new ScreenModel({ cols: this.cols, rows: this.rows })
    /** Sizes last reported by each source, keyed by sourceKey. @type {Map<string, { cols: number, rows: number }>} */
    this.sizes = new Map()
    /** Source whose size the PTY follows: the most recent non-deck input. @type {string | null} */
    this.sizeOwner = null
    this.lastResizeAt = 0
    /** @type {NodeJS.Timeout | null} */
    this.resizeTimer = null
    /** @type {{ cols: number, rows: number } | null} */
    this.resizeTarget = null
    /** @type {NodeJS.Timeout | null} */
    this.killTimer = null
    /** Attached connections and whether each wants `output`. @type {Map<object, { client: ClientInfo, stream: boolean }>} */
    this.clients = new Map()
    /** Connections with `watchScreen` on. @type {Set<object>} */
    this.watchers = new Set()
    /** @type {(() => void) | null} */
    this.unwatchScreen = null

    const env = { ...process.env, ...(req.env ?? {}), FLEETMATES_DECK_PTY: this.ptyId }
    try {
      this.proc = nodePty.spawn(req.argv[0], req.argv.slice(1), {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env,
        // raw bytes in onData, so a character split across reads stays intact in the ring
        encoding: null
      })
    } catch (err) {
      this.screen.dispose()
      throw new DeckdError('spawn_failed', /** @type {Error} */ (err).message)
    }
    this.pid = this.proc.pid
    this.proc.onData((/** @type {Buffer | string} */ d) => {
      const buf = typeof d === 'string' ? Buffer.from(d, 'utf8') : d
      this.ring.push(buf)
      this.screen.write(buf)
      hooks.onOutput(this, buf)
    })
    this.proc.onExit(({ exitCode, signal }) => {
      if (this.killTimer) clearTimeout(this.killTimer)
      if (this.resizeTimer) clearTimeout(this.resizeTimer)
      this.exited = { code: exitCode, signal: signalName(signal), at: Date.now() }
      hooks.onExit(this, this.exited)
    })
  }

  /**
   * Send input bytes and stamp their source. A non-deck source also becomes
   * the source the PTY size follows.
   * @param {Buffer} data
   * @param {InputSource} source
   * @returns {number} the input timestamp
   */
  write (data, source) {
    const at = Date.now()
    this.proc.write(data)
    this.lastInputFrom = source.name === undefined ? { kind: source.kind } : { kind: source.kind, name: source.name }
    this.lastInputAt = at
    // `deck` keystrokes are generated by the web server, not typed in a
    // window, so they do not move the size owner.
    if (source.kind !== 'deck') {
      const key = sourceKey(source)
      if (key !== this.sizeOwner) {
        this.sizeOwner = key
        const size = this.sizes.get(key)
        if (size) this.#applySize(size.cols, size.rows)
      }
    }
    return at
  }

  /**
   * Record the size a client wants. It is applied when that client is the
   * most recent input source (or nobody has typed yet), at most once per
   * RESIZE_MIN_INTERVAL_MS; a resize inside the interval is applied when
   * the interval ends.
   * @param {number} cols
   * @param {number} rows
   * @param {InputSource | ClientInfo} source
   * @returns {{ cols: number, rows: number }} the PTY size now
   */
  requestResize (cols, rows, source) {
    const key = sourceKey(source)
    this.sizes.set(key, { cols, rows })
    if (this.sizeOwner === null || this.sizeOwner === key) this.#applySize(cols, rows)
    return { cols: this.cols, rows: this.rows }
  }

  /**
   * @param {number} cols
   * @param {number} rows
   */
  #applySize (cols, rows) {
    if (this.exited) return
    this.resizeTarget = { cols, rows }
    if (this.resizeTimer) return
    const wait = this.lastResizeAt + RESIZE_MIN_INTERVAL_MS - Date.now()
    if (wait <= 0) {
      this.#doResize()
    } else {
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null
        this.#doResize()
      }, wait)
      this.resizeTimer.unref()
    }
  }

  #doResize () {
    const target = this.resizeTarget
    this.resizeTarget = null
    if (!target || this.exited) return
    if (target.cols === this.cols && target.rows === this.rows) return
    this.proc.resize(target.cols, target.rows)
    this.screen.resize(target.cols, target.rows)
    this.cols = target.cols
    this.rows = target.rows
    this.lastResizeAt = Date.now()
  }

  /**
   * Signal the process group, then SIGKILL it after `graceMs` if it is still running.
   * @param {NodeJS.Signals} [signal]
   * @param {number} [graceMs]
   */
  kill (signal = 'SIGTERM', graceMs = 5000) {
    if (this.exited) return
    this.#signalGroup(signal)
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = setTimeout(() => this.#signalGroup('SIGKILL'), graceMs)
    this.killTimer.unref()
  }

  /**
   * @param {NodeJS.Signals} signal
   */
  #signalGroup (signal) {
    if (this.exited) return
    try {
      // node-pty makes the child a session leader, so its pid is its process group id.
      process.kill(-this.pid, signal)
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err
    }
  }

  dispose () {
    if (this.killTimer) clearTimeout(this.killTimer)
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.screen.dispose()
  }
}
