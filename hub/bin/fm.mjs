#!/usr/bin/env node
// fm: terminal client of deckd (docs/deck/05-api.md section 5).
//   fm claude [args...]   spawn `claude args...` in deckd and attach this terminal to it
//   fm attach <ptyId>     attach this terminal to a PTY deckd already runs
// M0 has only these two; `fm ls`, the detach escape and the plain-claude
// fallback when deckd is down come in M2.
import os from 'node:os'
import { connectDeckd } from '../deckd/client.mjs'

const REPLAY_LINES = 5000
const USAGE = 'usage: fm claude [args...] | fm attach <ptyId>'

/**
 * Print a message to stderr and exit.
 * @param {number} code
 * @param {string} message
 * @returns {never}
 */
function die (code, message) {
  process.stderr.write(message + '\n')
  process.exit(code)
}

/**
 * Shell-style exit status for a PTY exit record: the code, or 128 plus the
 * signal number when a signal ended the child.
 * @param {{ code: number, signal: string | null }} exit
 * @returns {number}
 */
function exitStatus ({ code, signal }) {
  if (signal) {
    const num = os.constants.signals[/** @type {NodeJS.Signals} */ (signal)]
    if (num) return 128 + num
  }
  return Number.isInteger(code) ? code : 1
}

/** @returns {{ cols: number, rows: number } | undefined} */
function termSize () {
  if (!process.stdout.isTTY) return undefined
  const [cols, rows] = process.stdout.getWindowSize()
  return cols > 0 && rows > 0 ? { cols, rows } : undefined
}

/**
 * Leave raw mode, if this process entered it, before anything more is
 * printed. Node also resets the tty mode when the process exits: the
 * restore test in fm.test.mjs still passes with this call removed.
 */
function restoreTerminal () {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false)
}

/**
 * Run `fm claude` or `fm attach`.
 * @param {string[]} argv arguments after `fm`
 */
async function main (argv) {
  const [cmd, ...rest] = argv
  if (cmd !== 'claude' && !(cmd === 'attach' && rest.length === 1)) die(1, USAGE)

  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (!runtimeDir) die(2, 'deckd is not running (XDG_RUNTIME_DIR is not set)')
  const name = process.env.TERM_PROGRAM || process.env.TERM
  /** @type {{ kind: 'terminal', name?: string }} */
  const source = name ? { kind: 'terminal', name } : { kind: 'terminal' }

  let client
  try {
    client = await connectDeckd({ runtimeDir, kind: 'terminal', name })
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTDIR') die(2, 'deckd is not running')
    die(1, `fm: ${/** @type {Error} */ (err).message}`)
  }
  const deckd = client

  let finished = false
  /**
   * Restore the terminal, flush stdout, and exit.
   * @param {number} code
   * @param {string} [message]
   */
  const finish = (code, message) => {
    if (finished) return
    finished = true
    restoreTerminal()
    if (message) process.stderr.write(message + '\n')
    deckd.close()
    process.stdout.write('', () => process.exit(code))
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true)

  /** @type {string | null} */
  let ptyId = cmd === 'attach' ? rest[0] : null
  /** Exit records seen so far, by ptyId. @type {Map<string, { code: number, signal: string | null }>} */
  const exits = new Map()
  let replayed = false
  /** Output events that arrived before the replay was written, with their arrival seq. @type {{ n: number, buf: Buffer }[]} */
  let held = []

  deckd.on('output', (ev, n) => {
    if (ev.ptyId !== ptyId) return
    const buf = Buffer.from(ev.data, 'base64')
    if (replayed) process.stdout.write(buf)
    else held.push({ n, buf })
  })
  deckd.on('exit', (ev) => {
    exits.set(ev.ptyId, { code: ev.code, signal: ev.signal })
    // Before the replay is out, main() finishes once it has written it.
    if (ev.ptyId === ptyId && replayed) finish(exitStatus(ev))
  })
  deckd.on('close', () => finish(1, 'fm: lost the connection to deckd'))

  try {
    if (cmd === 'claude') {
      const res = await deckd.request('spawn', {
        cwd: process.cwd(),
        argv: ['claude', ...rest],
        env: process.env,
        ...termSize(),
        origin: 'wrapped'
      })
      ptyId = res.ptyId
      // `exit` is broadcast to every client, attached or not, and is kept
      // in `exits` even when it arrives before ptyId is known here.
    }
    const id = /** @type {string} */ (ptyId)

    process.stdin.on('data', (chunk) => {
      deckd.request('write', { ptyId: id, data: chunk.toString('base64'), source }).catch(() => {})
    })
    process.on('SIGWINCH', () => {
      const size = termSize()
      if (size) deckd.request('resize', { ptyId: id, ...size, source }).catch(() => {})
    })

    // Attach, then ask for the replay in the same breath. deckd pushes each
    // output chunk into its ring before sending it as an `output` event, and
    // builds the `screen` answer from the ring in one step, so every output
    // event that arrived before the `screen` response is already in the
    // replay; the ones after it are not. That is decided by arrival order
    // (`seq`), since the response promise settles after events decoded from
    // the same read.
    const attached = deckd.request('attach', { ptyId: id, stream: true })
    const screen = deckd.request('screen', { ptyId: id, scrollback: REPLAY_LINES })
    // deckd sizes the PTY to a source only from sizes that source reported
    // with `resize`; the size in `spawn` is not one. Report it now, so typing
    // here moves the PTY to this terminal's size (SM-O12).
    const size = termSize()
    if (size) deckd.request('resize', { ptyId: id, ...size, source }).catch(() => {})
    await attached
    const snap = await screen
    const cut = /** @type {number} */ (deckd.seqOf(snap))
    process.stdout.write(Buffer.from(snap.scrollback, 'base64'))
    for (const { n, buf } of held) if (n > cut) process.stdout.write(buf)
    held = []
    replayed = true
  } catch (err) {
    const early = ptyId ? exits.get(ptyId) : undefined
    if (early) return finish(exitStatus(early))
    const e = /** @type {Error & { code?: string }} */ (err)
    return finish(1, `fm: ${e.message}`)
  }
  const early = exits.get(/** @type {string} */ (ptyId))
  if (early) finish(exitStatus(early))
}

main(process.argv.slice(2)).catch((err) => {
  restoreTerminal()
  die(1, `fm: ${err.message}`)
})
