// One PTY owned by deckd: the node-pty process, its scrollback ring, its
// headless screen model, attached clients and the last input source.
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { Ring } from './ring.mjs'
import { ScreenModel } from './screen-model.mjs'
import { dropSessionVars } from './login-env.mjs'
import { isClaudeProgram, killTree, resolveCommand, commandSpawn } from '../platform/index.mjs'

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

/**
 * Signal the process group, POSIX only: killTree's POSIX branch whatever the
 * host. The group first; macOS can refuse a dying group while its owned PID
 * is still signalable, so EPERM falls back to the PID.
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 * @param {typeof process.kill} [kill]
 */
export function signalProcessGroup (pid, signal, kill = process.kill) {
  killTree(pid, signal, { platform: 'linux', kill })
}

/**
 * What PtyHost takes from its surroundings, each defaulting to the live one,
 * so a test can pin the platform and stand in for node-pty and the kill
 * calls: `ptySpawn` is node-pty's `spawn`; `exists` and `readFile` serve
 * resolveCommand and commandSpawn; `kill` and `spawnSync` serve killTree.
 * @typedef {{ platform?: string, ptySpawn?: (file: string, args: string[] | string, opts: object) => any, exists?: (p: string) => boolean, readFile?: (p: string, enc: string) => string, kill?: typeof process.kill, spawnSync?: Function }} PtyDeps
 */

export class PtyHost {
  /**
   * Spawn `claude` in a new PTY. Refuses with code `spawn_refused` any argv[0]
   * that isClaudeProgram rejects for the platform: basename `claude`, and on
   * win32 also `claude.exe` or `claude.cmd` in any case. The child's
   * environment is `{ ...baseEnv, ...env }` (baseEnv defaults to this
   * process's environment without TERM and Claude Code's session variables),
   * then `FLEETMATES_DECK_PTY=<ptyId>` and `TERM=xterm-256color`.
   * @param {{ cwd?: string, argv: string[], env?: Record<string, string>, baseEnv?: Record<string, string>, cols?: number, rows?: number, origin?: string }} req
   * @param {{ onOutput: (host: PtyHost, data: Buffer) => void, onExit: (host: PtyHost, exit: { code: number, signal: string | null, at: number }) => void }} hooks
   * @param {PtyDeps} [deps]
   * @returns {PtyHost}
   */
  static spawn (req, hooks, deps = {}) {
    const argv = req.argv
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || !argv.every((a) => typeof a === 'string')) {
      throw new DeckdError('bad_request', 'argv must be a non-empty array of strings')
    }
    if (!isClaudeProgram(argv[0], { platform: deps.platform ?? process.platform })) {
      throw new DeckdError('spawn_refused', `deckd only spawns claude, not ${argv[0]}`)
    }
    return new PtyHost(req, hooks, deps)
  }

  /**
   * On win32 argv[0] is resolved on the child's PATH with resolveCommand, and
   * commandSpawn decides what runs it: an npm cmd-shim runs its target
   * directly, any other `.cmd` or `.bat` runs through ComSpec, its command
   * line handed to node-pty as one string so it is not quoted again. An
   * argument cmd.exe cannot pass to a batch file is refused with
   * `bad_request`. On POSIX argv runs as given.
   * @param {{ cwd?: string, argv: string[], env?: Record<string, string>, baseEnv?: Record<string, string>, cols?: number, rows?: number, origin?: string }} req
   * @param {{ onOutput: (host: PtyHost, data: Buffer) => void, onExit: (host: PtyHost, exit: { code: number, signal: string | null, at: number }) => void }} hooks
   * @param {PtyDeps} [deps]
   */
  constructor (req, hooks, { platform = process.platform, ptySpawn = nodePty.spawn, exists, readFile, kill, spawnSync } = {}) {
    this.platform = platform
    /** Set once node-pty's kill() has closed the win32 pseudoconsole. */
    this.pseudoconsoleClosed = false
    /** For killTree; undefined keeps its defaults. */
    this.killDeps = { platform, kill, spawnSync }
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
    /** Time of the last input per source kind. @type {Record<'browser' | 'deck' | 'terminal', number | null>} */
    this.lastInputAtBy = { browser: null, deck: null, terminal: null }
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
    /**
     * Set by kill(), and when a resize finds the PTY fd closed: the PTY is
     * going away, so no resize reaches it any more. @type {boolean}
     */
    this.closing = false
    /** Attached connections and whether each wants `output`. @type {Map<object, { client: ClientInfo, stream: boolean }>} */
    this.clients = new Map()
    /** Connections with `watchScreen` on. @type {Set<object>} */
    this.watchers = new Set()
    /** @type {(() => void) | null} */
    this.unwatchScreen = null

    const env = { ...(req.baseEnv ?? dropSessionVars(process.env)), ...(req.env ?? {}), FLEETMATES_DECK_PTY: this.ptyId, TERM: 'xterm-256color' }
    /** @type {{ file: string, args: string[], options: Record<string, boolean> }} */
    let cmd
    try {
      const file = resolveCommand(req.argv[0], { env, platform, exists })
      cmd = commandSpawn(file, req.argv.slice(1), { platform, env, readFile })
    } catch (err) {
      this.screen.dispose()
      const e = /** @type {Error & { code?: string }} */ (err)
      throw new DeckdError(e.code === 'unsafe_cmd_arg' ? 'bad_request' : 'spawn_failed', e.message)
    }
    try {
      this.proc = ptySpawn(cmd.file, cmd.options.windowsVerbatimArguments ? cmd.args.join(' ') : cmd.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env,
        // raw bytes in onData, so a character split across reads stays intact in the ring
        encoding: null,
        ...(cmd.options.windowsHide ? { windowsHide: true } : {})
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
      // node-pty on win32 can report the exit with no code when the
      // pseudoconsole was closed before the process exit was seen; null then.
      this.exited = { code: typeof exitCode === 'number' ? exitCode : null, signal: signalName(signal), at: Date.now() }
      hooks.onExit(this, this.exited)
    })
  }

  /**
   * Send input bytes and stamp their source. A non-deck source also becomes
   * the source the PTY size follows.
   *
   * With a `guard` (a deck write only; the caller checks the source), the
   * bytes are sent only when the screen model is still at `guard.rev` with
   * nothing left unparsed, else DeckdError `screen_changed`, and when no
   * `terminal` or `browser` input came in the last `guard.quietMs`
   * milliseconds, else DeckdError `typing_in_terminal` (D-84). The checks
   * and the write run in one synchronous step.
   * @param {Buffer} data
   * @param {InputSource} source
   * @param {{ rev: number, quietMs: number }} [guard]
   * @returns {number} the input timestamp
   */
  write (data, source, guard) {
    if (guard) {
      if (this.screen.rev !== guard.rev || this.screen.pending()) {
        throw new DeckdError('screen_changed', 'the screen changed since the given rev')
      }
      const now = Date.now()
      for (const t of [this.lastInputAtBy.terminal, this.lastInputAtBy.browser]) {
        if (t !== null && now - t < guard.quietMs) {
          throw new DeckdError('typing_in_terminal', `input arrived within the last ${guard.quietMs} ms`)
        }
      }
    }
    const at = Date.now()
    this.proc.write(data)
    this.lastInputFrom = source.name === undefined ? { kind: source.kind } : { kind: source.kind, name: source.name }
    this.lastInputAt = at
    this.lastInputAtBy[source.kind] = at
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
    if (!target || this.exited || this.closing) return
    if (target.cols === this.cols && target.rows === this.rows) return
    // This runs from a timer, where a throw would end deckd and every
    // session in it. node-pty's resize throws `ioctl(2) failed, EBADF` on a
    // closed fd, and the phase 3 review caught that between node-pty closing
    // the fd of an exited child and onExit marking it exited.
    try {
      this.proc.resize(target.cols, target.rows)
    } catch (err) {
      this.closing = true
      console.error(`deckd: resize of ${this.ptyId} failed, no more resizes for it: ${/** @type {Error} */ (err).message}`)
      return
    }
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
    // A PTY being killed takes no more resizes: a deferred one could fire
    // after its fd is closed.
    this.closing = true
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = null
    this.resizeTarget = null
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
    // POSIX: node-pty makes the child a session leader, so its pid is its
    // process group id. win32: taskkill /T /F on the tree, whatever the signal.
    killTree(this.pid, signal, this.killDeps)
    this.#closePseudoconsole()
  }

  /**
   * win32 only, at most once: node-pty's own kill(), which closes the
   * pseudoconsole. On a Windows 11 VM a tree killed by taskkill alone left
   * `conhost.exe --headless` running, no exit event came, and the process
   * holding the PTY never exited. That kill() is what fixes it is read from
   * node-pty 1.1.0's lib/windowsPtyAgent.js (it calls the native kill that
   * closes the console), not run on Windows here.
   */
  #closePseudoconsole () {
    if (this.platform !== 'win32' || this.pseudoconsoleClosed) return
    this.pseudoconsoleClosed = true
    try {
      this.proc.kill()
    } catch (err) {
      console.error(`deckd: closing the pseudoconsole of ${this.ptyId} failed: ${/** @type {Error} */ (err).message}`)
    }
  }

  /** Clear the timers and the screen model; on win32 also close the pseudoconsole if still open. */
  dispose () {
    if (this.killTimer) clearTimeout(this.killTimer)
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.#closePseudoconsole()
    this.screen.dispose()
  }
}
