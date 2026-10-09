#!/usr/bin/env node
// fm: terminal client of deckd (docs/deck/05-api.md section 5,
// docs/deck/03-architecture.md section 2.4, docs/deck/13-operations.md section 7).
//   fm claude [args...]     spawn `claude args...` in deckd and attach this terminal to it;
//                           with deckd down, run plain `claude args...` instead (D-67)
//   fm attach <id|repo>     attach this terminal to a PTY deckd already runs
//   fm ls                   list the PTYs deckd runs
// While attached, Ctrl ] then d detaches and leaves the PTY running.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectDeckd } from '../deckd/client.mjs'
import { endpointDirProblem } from '../hook/deck-hook.mjs'
import { commandSpawn, createInputModeFilter, endpoint, resolveCommand, runtimeBase } from '../platform/index.mjs'

const REPLAY_LINES = 5000
const USAGE = 'usage: fm claude [args...] | fm attach <ptyId|repo> | fm ls'
const FALLBACK = 'deckd is not running, starting plain claude; this session will be observed only'
/** Ctrl ]: starts the detach escape. */
const ESCAPE = 0x1d
/** Clear the screen and home the cursor, before a repaint. */
const CLEAR = '\x1b[2J\x1b[H'

/**
 * The parts of `process` fm uses, so a test can run `main` in its own process: the standard
 * streams, the environment, the working directory, exit and signal listeners.
 * @typedef {{ stdin: any, stdout: any, stderr: { write: (s: string) => unknown }, env: NodeJS.ProcessEnv, cwd: () => string, exit: (code: number) => unknown, on: (event: string, fn: () => void) => unknown }} Proc
 */

/**
 * Print a message to stderr and exit.
 * @param {number} code
 * @param {string} message
 * @param {Proc} [proc]
 * @returns {never}
 */
function die (code, message, proc = process) {
  proc.stderr.write(message + '\n')
  return /** @type {never} */ (proc.exit(code))
}

/**
 * Shell-style exit status: the code, or 128 plus the signal number when a
 * signal ended the child.
 * @param {{ code: number | null, signal: string | null }} exit
 * @returns {number}
 */
function exitStatus ({ code, signal }) {
  if (signal) {
    const num = os.constants.signals[/** @type {NodeJS.Signals} */ (signal)]
    if (num) return 128 + num
  }
  return Number.isInteger(code) ? /** @type {number} */ (code) : 1
}

/**
 * @param {Proc} [proc]
 * @returns {{ cols: number, rows: number } | undefined}
 */
function termSize (proc = process) {
  if (!proc.stdout.isTTY) return undefined
  const [cols, rows] = proc.stdout.getWindowSize()
  return cols > 0 && rows > 0 ? { cols, rows } : undefined
}

/**
 * Leave raw mode, if this process entered it, before anything more is
 * printed. Node also resets the tty mode when the process exits: the
 * restore test in fm.test.mjs still passes with this call removed.
 * @param {Proc} [proc]
 */
function restoreTerminal (proc = process) {
  if (proc.stdin.isTTY && proc.stdin.isRaw) proc.stdin.setRawMode(false)
}

/**
 * Whether a connect error means no deckd listens.
 * @param {unknown} err
 */
function deckdDown (err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err).code
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTDIR'
}

/**
 * The signals fm passes on to a plain claude child: SIGHUP, SIGTERM and SIGINT, without SIGHUP on win32.
 * @param {string} platform
 * @returns {NodeJS.Signals[]}
 */
export function forwardedSignals (platform = process.platform) {
  return platform === 'win32' ? ['SIGTERM', 'SIGINT'] : ['SIGHUP', 'SIGTERM', 'SIGINT']
}

/**
 * Listen for SIGHUP on `proc`, off win32 only. Returns whether a listener was added.
 * @param {() => void} handler
 * @param {{ platform?: string, proc?: { on: (event: string, fn: () => void) => unknown } }} [opts]
 * @returns {boolean}
 */
export function onHangup (handler, { platform = process.platform, proc = process } = {}) {
  if (platform === 'win32') return false
  proc.on('SIGHUP', handler)
  return true
}

/**
 * D-67: run plain `claude args...` in this terminal, without deckd. The
 * child gets this environment minus FLEETMATES_DECK_PTY; SIGHUP (off win32),
 * SIGTERM and SIGINT sent to fm are passed on to it, and fm exits with its
 * status. On win32 `claude` is looked up on PATH with PATHEXT and a `.cmd`
 * runs through commandSpawn.
 * @param {string[]} args
 * @param {string} platform
 * @param {{ proc?: Proc, spawn?: typeof spawn }} [deps]
 */
function plainClaude (args, platform, { proc = process, spawn: spawnChild = spawn } = {}) {
  proc.stderr.write(FALLBACK + '\n')
  const env = { ...proc.env }
  delete env.FLEETMATES_DECK_PTY
  let run
  try {
    run = commandSpawn(resolveCommand('claude', { env, platform }), args, { platform, env })
  } catch (err) {
    return die(1, `fm: ${/** @type {Error} */ (err).message}`, proc)
  }
  const child = spawnChild(run.file, run.args, { stdio: 'inherit', env, ...run.options })
  for (const sig of forwardedSignals(platform)) {
    proc.on(sig, () => { child.kill(sig) })
  }
  child.once('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') die(127, 'fm: claude not found on PATH', proc)
    else die(1, `fm: ${err.message}`, proc)
  })
  child.once('exit', (code, signal) => proc.exit(exitStatus({ code, signal })))
}

/**
 * Whether `dir` holds a repository marker: a `.git` directory with a `HEAD`
 * file or symlink (dangling or not), or a `.git` file that starts with `gitdir:`. An empty `.git`
 * directory, such as one a sandbox mounts, is not one.
 * @param {string} dir
 * @returns {boolean}
 */
function hasGitMarker (dir) {
  const marker = path.join(dir, '.git')
  try {
    const stat = fs.statSync(marker)
    if (stat.isDirectory()) {
      // HEAD may be a symlink, dangling while its branch is unborn.
      const head = fs.lstatSync(path.join(marker, 'HEAD'))
      return head.isFile() || head.isSymbolicLink()
    }
    return stat.isFile() && stat.size <= 4096 && fs.readFileSync(marker, 'utf8').startsWith('gitdir:')
  } catch { return false }
}

/**
 * What `fm ls` shows as a PTY's repo: the basename of the nearest ancestor
 * of `cwd` (itself included) that holds a repository marker (see
 * `hasGitMarker`), else `cwd` with the home directory shown as `~`. The
 * home prefix ends at a `/` or a `\`, whichever separator the paths use.
 * @param {string} cwd
 * @param {string} home
 * @returns {string}
 */
function repoOf (cwd, home) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (hasGitMarker(dir)) return path.basename(dir)
    if (path.dirname(dir) === dir) break
  }
  if (!home) return cwd
  const trimmed = home.replace(/[\\/]$/, '')
  if (cwd === home || cwd === trimmed || (cwd.startsWith(trimmed) && /[\\/]/.test(cwd.charAt(trimmed.length)))) return '~' + cwd.slice(trimmed.length)
  return cwd
}

/**
 * Local time as `YYYY-MM-DD HH:MM:SS`.
 * @param {number} ms
 */
function localTime (ms) {
  const d = new Date(ms)
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Print deckd's PTYs: one row each, columns PTY, REPO, PID, STARTED, CLIENTS.
 * @param {any[]} ptys deckd `list` entries
 * @param {string} home
 * @param {Proc} [proc]
 */
function printList (ptys, home, proc = process) {
  if (ptys.length === 0) {
    proc.stdout.write('No sessions in deckd.\n')
    return
  }
  const rows = [['PTY', 'REPO', 'PID', 'STARTED', 'CLIENTS']]
  for (const p of ptys) {
    const clients = (p.clients ?? []).map((/** @type {{ kind: string, name?: string }} */ c) => c.name === undefined ? c.kind : `${c.kind}:${c.name}`)
    rows.push([String(p.ptyId), repoOf(String(p.cwd), home), String(p.pid), localTime(p.startedAt), clients.length ? clients.join(', ') : '-'])
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  for (const r of rows) proc.stdout.write(r.map((cell, i) => i === r.length - 1 ? cell : cell.padEnd(widths[i])).join('  ') + '\n')
}

/**
 * Run `fm claude`, `fm attach` or `fm ls`. `platform` picks the signals fm handles and whether
 * session output is filtered; the connection to deckd itself is made the way this host makes it.
 * `proc` stands in for `process`, and `spawn` for child_process's, which runs a plain claude
 * without deckd. Everything written to stdout from the session, replay and stream, passes through
 * a createInputModeFilter, a fresh one for each replay, so on win32 a replayed win32-input-mode
 * request (`ESC [ ? 9001 h`) does not reach the outer console. In the Windows VM run that request
 * switched the console to sending key records, and fm never saw the Ctrl ] d that detaches.
 * @param {string[]} argv arguments after `fm`
 * @param {{ platform?: string, proc?: Proc, spawn?: typeof spawn }} [opts]
 */
export async function main (argv, { platform = process.platform, proc = process, spawn: spawnChild = spawn } = {}) {
  const [cmd, ...rest] = argv
  if (cmd !== 'claude' && !(cmd === 'attach' && rest.length === 1) && !(cmd === 'ls' && rest.length === 0)) return die(1, USAGE, proc)

  // XDG_RUNTIME_DIR when set, else the platform's fallback base.
  const runtimeDir = runtimeBase({ platform, env: proc.env })
  const name = proc.env.TERM_PROGRAM || proc.env.TERM
  /** @type {{ kind: 'terminal', name?: string }} */
  const source = name ? { kind: 'terminal', name } : { kind: 'terminal' }

  // On POSIX, deckd's socket counts only inside directories private to this user; anything else
  // (another user's pre-created /tmp/fleetmates-deck-<uid>, a symlink, a 0777 dir) is treated as
  // no deckd. A missing dir is just no deckd, without a message. A win32 pipe has no directory to
  // check, and its name needs the endpoint key, which connectDeckd reads (no key: no deckd).
  const problem = platform === 'win32' ? null : endpointDirProblem(endpoint(runtimeDir, 'deckd', { platform }), { platform })
  if (problem) {
    if (!problem.includes('(ENOENT)')) proc.stderr.write(`fm: not connecting to deckd: ${problem}\n`)
    if (cmd === 'claude') return plainClaude(rest, platform, { proc, spawn: spawnChild })
    return die(2, 'deckd is not running', proc)
  }

  let client
  try {
    client = await connectDeckd({ runtimeDir, kind: 'terminal', name })
  } catch (err) {
    if (deckdDown(err)) {
      if (cmd === 'claude') return plainClaude(rest, platform, { proc, spawn: spawnChild })
      return die(2, 'deckd is not running', proc)
    }
    return die(1, `fm: ${/** @type {Error} */ (err).message}`, proc)
  }
  const deckd = client

  if (cmd === 'ls') {
    const res = await deckd.request('list')
    deckd.close()
    printList(res.ptys ?? [], proc.env.HOME || os.homedir(), proc)
    return
  }

  let finished = false
  /**
   * Restore the terminal, flush stdout, and exit.
   * @param {number} code
   * @param {string} [message]
   */
  const finish = (code, message) => {
    if (finished) return
    finished = true
    restoreTerminal(proc)
    if (message) proc.stderr.write(message + '\n')
    deckd.close()
    proc.stdout.write('', () => proc.exit(code))
  }

  /** One input-mode filter for the platform; each replay starts a new one. */
  const newFilter = () => createInputModeFilter({ platform })
  let filter = newFilter()
  /**
   * Write session output to stdout through the input-mode filter.
   * @param {Buffer} buf
   */
  const show = (buf) => {
    // latin1 maps each byte to one char and back, so the bytes around a removed sequence stay as they were
    const kept = filter(buf.toString('latin1'))
    if (kept) proc.stdout.write(Buffer.from(kept, 'latin1'))
  }

  /** @type {string | null} */
  let ptyId = null
  /** Exit records seen so far, by ptyId. @type {Map<string, { code: number, signal: string | null }>} */
  const exits = new Map()
  let replayed = false
  /** Output events that arrived before the replay was written, with their arrival seq. @type {{ n: number, buf: Buffer }[]} */
  let held = []
  let repainting = false
  let repaintAgain = false

  /**
   * Ask for the newest output and write it, then the output events that
   * arrived after the answer. deckd pushes each output chunk into its ring
   * before sending it as an `output` event, and builds the `screen` answer
   * from the ring in one step, so every output event that arrived before
   * the `screen` response is already in it; the ones after it are not.
   * That is decided by arrival order (`seq`), since the response promise
   * settles after events decoded from the same read.
   * @param {Promise<any>} screen the pending `screen` request
   * @param {string} [prefix] written before the scrollback
   */
  const replay = async (screen, prefix = '') => {
    const snap = await screen
    const cut = /** @type {number} */ (deckd.seqOf(snap))
    // The replay restarts the stream, so a sequence prefix held back before it is dropped.
    filter = newFilter()
    proc.stdout.write(prefix)
    show(Buffer.from(snap.scrollback, 'base64'))
    for (const { n, buf } of held) if (n > cut) show(buf)
    held = []
    replayed = true
  }

  /**
   * Repaint after deckd dropped output for this client: clear the screen and
   * replay again with the same seam rule. A `dropped` during a repaint
   * queues one more.
   */
  const repaint = async () => {
    if (repainting) {
      repaintAgain = true
      return
    }
    repainting = true
    try {
      do {
        repaintAgain = false
        replayed = false
        await replay(deckd.request('screen', { ptyId, scrollback: REPLAY_LINES }), CLEAR)
      } while (repaintAgain)
    } catch {
      // The PTY is gone or the connection closed; the exit and close
      // handlers below end fm.
    } finally {
      repainting = false
      replayed = true
    }
    const gone = ptyId ? exits.get(ptyId) : undefined
    if (gone) finish(exitStatus(gone))
  }

  deckd.on('output', (ev, n) => {
    if (ptyId === null || ev.ptyId !== ptyId) return
    const buf = Buffer.from(ev.data, 'base64')
    if (replayed) show(buf)
    else held.push({ n, buf })
  })
  deckd.on('dropped', (ev) => {
    if (ptyId !== null && ev.ptyId === ptyId && (replayed || repainting)) repaint()
  })
  deckd.on('exit', (ev) => {
    exits.set(ev.ptyId, { code: ev.code, signal: ev.signal })
    // Before the replay is out, it is checked once the replay is written.
    if (ev.ptyId === ptyId && replayed && !repainting) finish(exitStatus(ev))
  })
  deckd.on('close', () => finish(1, 'fm: lost the connection to deckd'))

  /**
   * Leave the PTY running: say `detach`, then exit 0.
   * @param {string} [message]
   */
  const detach = async (message) => {
    if (finished || ptyId === null) return
    await deckd.request('detach', { ptyId }).catch(() => {})
    finish(0, message)
  }

  /** A SIGHUP arrived: the terminal closed, so fm leaves the PTY running. */
  let hungUp = false
  /** The PTY fm sent `attach` for and has no answer for yet. @type {string | null} */
  let attaching = null
  /** The `detach` sent for a SIGHUP while `attaching`. @type {Promise<unknown> | null} */
  let hangupDetach = null
  let attachedOk = false

  /**
   * Attach, then ask for the replay in the same breath; replay() explains
   * the seam. deckd sizes the PTY to a source only from sizes that source
   * reported with `resize`; the size in `spawn` is not one. Report it now,
   * so typing here moves the PTY to this terminal's size (SM-O12). After a
   * SIGHUP, `detach` follows at once, behind `attach` on the same
   * connection.
   * @param {string} id
   */
  const attachTo = (id) => {
    const attached = deckd.request('attach', { ptyId: id, stream: true })
    const screen = deckd.request('screen', { ptyId: id, scrollback: REPLAY_LINES })
    screen.catch(() => {})
    const size = termSize(proc)
    if (size) deckd.request('resize', { ptyId: id, ...size, source }).catch(() => {})
    attaching = id
    hangupDetach = hungUp ? deckd.request('detach', { ptyId: id }).catch(() => {}) : null
    return { attached, screen }
  }

  // The terminal closed: detach without printing. deckd lists this client
  // as soon as it handles `attach`, so a SIGHUP from before `spawn` or
  // `attach` is sent is remembered, and becomes a `detach` once fm has
  // sent `attach` for a PTY id. Registered off win32 only.
  onHangup(() => {
    hungUp = true
    if (attachedOk) detach()
    else if (attaching !== null && hangupDetach === null) hangupDetach = deckd.request('detach', { ptyId: attaching }).catch(() => {})
  }, { platform, proc })

  if (proc.stdin.isTTY) proc.stdin.setRawMode(true)

  try {
    if (cmd === 'claude') {
      const res = await deckd.request('spawn', {
        cwd: proc.cwd(),
        argv: ['claude', ...rest],
        env: proc.env,
        ...termSize(proc),
        origin: 'wrapped'
      })
      ptyId = res.ptyId
      // `exit` is broadcast to every client, attached or not, and is kept
      // in `exits` even when it arrives before ptyId is known here.
    } else {
      ptyId = rest[0]
    }
    let pending = attachTo(/** @type {string} */ (ptyId))
    try {
      await pending.attached
    } catch (err) {
      // `fm attach <repo>`: the argument is not a live ptyId.
      if (cmd !== 'attach' || /** @type {{ code?: string }} */ (err).code !== 'not_found') throw err
      ptyId = await resolveRepo(deckd, rest[0], proc)
      pending = attachTo(ptyId)
      await pending.attached
    }
    attaching = null
    if (hungUp) {
      await hangupDetach
      return finish(0)
    }
    attachedOk = true
    const id = /** @type {string} */ (ptyId)

    let escaped = false
    proc.stdin.on('data', (/** @type {Buffer} */ chunk) => {
      /** @type {Buffer} */
      let out = chunk
      if (proc.stdin.isTTY) {
        /** @type {number[]} */
        const bytes = []
        for (const b of chunk) {
          if (escaped) {
            escaped = false
            if (b === 0x64) { // `d`
              if (bytes.length) deckd.request('write', { ptyId: id, data: Buffer.from(bytes).toString('base64'), source }).catch(() => {})
              detach(`fm: detached from ${id}; reattach with fm attach ${id}`)
              return
            }
            bytes.push(ESCAPE)
            if (b !== ESCAPE) bytes.push(b)
          } else if (b === ESCAPE) {
            escaped = true
          } else {
            bytes.push(b)
          }
        }
        if (bytes.length === 0) return
        out = Buffer.from(bytes)
      }
      deckd.request('write', { ptyId: id, data: out.toString('base64'), source }).catch(() => {})
    })
    proc.stdout.on('resize', () => {
      const size = termSize(proc)
      if (size) deckd.request('resize', { ptyId: id, ...size, source }).catch(() => {})
    })
    await replay(pending.screen)
  } catch (err) {
    const early = ptyId ? exits.get(ptyId) : undefined
    if (early) return finish(exitStatus(early))
    const e = /** @type {Error & { code?: string }} */ (err)
    return finish(1, `fm: ${e.message}`)
  }
  const early = exits.get(/** @type {string} */ (ptyId))
  if (early) finish(exitStatus(early))
}

/**
 * The one PTY whose repo, as `fm ls` shows it, is `arg`. Exits 1 when no
 * PTY or several match.
 * @param {Awaited<ReturnType<typeof connectDeckd>>} deckd
 * @param {string} arg
 * @param {Proc} [proc]
 * @returns {Promise<string>}
 */
async function resolveRepo (deckd, arg, proc = process) {
  const { ptys = [] } = await deckd.request('list')
  const home = proc.env.HOME || os.homedir()
  const matches = ptys.filter((/** @type {any} */ p) => repoOf(String(p.cwd), home) === arg).map((/** @type {any} */ p) => String(p.ptyId))
  if (matches.length === 1) return matches[0]
  restoreTerminal(proc)
  deckd.close()
  if (matches.length === 0) return die(1, `fm: no session for ${arg}`, proc)
  return die(1, `fm: ${matches.length} sessions for ${arg}: ${matches.join(', ')}`, proc)
}

/**
 * Whether this file is the program node was started with, also through a symlink such as npm's
 * `node_modules/.bin/fm`. False when a test imports it for its exports.
 */
function invokedDirectly () {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch { return false }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((err) => {
    restoreTerminal()
    die(1, `fm: ${err.message}`)
  })
}
