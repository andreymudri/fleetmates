// deckd's login environment (OPS-O2, docs/deck/spikes/m0.md section 3.5, as
// amended by the owner on 2026-10-01). A systemd user service starts with a
// thin environment, so deckd asks the owner's login shell for the one a
// terminal would have, once, and hands it to the sessions it launches.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

/**
 * Claude Code's own per-session variables. A deckd started from inside a
 * Claude Code session would otherwise pass them to every session it
 * launches, which would then believe it is a child of that session.
 * Sources: the M0 report section 3.5 names `CLAUDECODE` and the
 * `CLAUDE_CODE_*` family; the exact list is the owner's decision of
 * 2026-10-01 (docs/plans/2026-10-01-deck-m2.md, Task 1), which names the
 * per-session variables Claude Code 2.1.282 sets in its child environment.
 * That list was not re-checked against a live Claude Code here. Every other
 * `CLAUDE_CODE_*` name, such as `CLAUDE_CODE_EXECPATH` or `CLAUDE_CODE_USE_BEDROCK`, is
 * configuration a profile sets on purpose and is kept. Checked by
 * hub/test/unit/login-env.test.mjs, not discovered at runtime.
 * @type {readonly string[]}
 */
export const CLAUDE_SESSION_VARS = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_ENV_FILE'
])

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A copy of `env` without `TERM` (deckd sets its own) and without
 * CLAUDE_SESSION_VARS. Values that are not strings are left out.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function dropSessionVars (env) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || name === 'TERM' || CLAUDE_SESSION_VARS.includes(name)) continue
    out[name] = value
  }
  return out
}

/**
 * Parse `env -0` output: NUL-separated `NAME=value` entries, where a value
 * may hold `=` and newlines. An entry whose name is not a variable name is
 * skipped.
 * @param {Buffer} out
 * @returns {Record<string, string>}
 */
function parseEnv0 (out) {
  /** @type {Record<string, string>} */
  const env = {}
  for (const entry of out.toString('utf8').split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const name = entry.slice(0, eq)
    if (NAME.test(name)) env[name] = entry.slice(eq + 1)
  }
  return env
}

/** How long to keep reading after the shell exited while something it started still holds stdout. */
const EXIT_DRAIN_MS = 100

/**
 * @typedef {'no_shell' | 'spawn_error' | 'exit' | 'timeout' | 'no_output' | 'windows'} FallbackReason
 */

/**
 * Run `[shell, '-l', '-i', '-c', "printf '%s\0' <marker>; env -0"]` with
 * stdin from /dev/null, stderr ignored and a timeout, and return the
 * environment printed after the random marker, minus dropSessionVars. The
 * marker keeps anything a profile prints before `env` (a banner, a motd) out
 * of the first variable. The answer comes when the shell exits, not when its
 * stdout closes, so a background job a profile starts cannot hold the probe
 * open. Falls back to `baseEnv` (same drops) on a missing shell, a non-zero
 * exit, the timeout, or output without the marker or any variable, and
 * reports which through `onFallback`. On the timeout the shell's whole
 * process group is killed with SIGKILL, because an interactive shell may
 * ignore SIGTERM. On win32 there is no login shell to ask: nothing is
 * spawned, and the answer is the `windows` fallback.
 * @param {{ platform?: string, shell?: string, timeoutMs?: number, baseEnv?: Record<string, string | undefined>, onFallback?: (reason: FallbackReason) => void }} [opts]
 * @returns {Promise<Record<string, string>>}
 */
export function captureLoginEnv ({ platform = process.platform, shell = process.env.SHELL, timeoutMs = 5000, baseEnv = process.env, onFallback = () => {} } = {}) {
  /** @param {FallbackReason} reason */
  const fallback = (reason) => {
    onFallback(reason)
    return dropSessionVars(baseEnv)
  }
  if (platform === 'win32') return Promise.resolve(fallback('windows'))
  if (typeof shell !== 'string' || shell === '') return Promise.resolve(fallback('no_shell'))
  const marker = `__FLEETMATES_DECK_ENV_${randomBytes(8).toString('hex')}__`
  return new Promise((resolve) => {
    let done = false
    /** @type {NodeJS.Timeout | null} */
    let drainTimer = null
    /** @param {() => Record<string, string>} make */
    const finish = (make) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      child.stdout?.destroy()
      resolve(make())
    }
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(shell, ['-l', '-i', '-c', `printf '%s\\0' ${marker}; env -0`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: dropSessionVars(baseEnv),
        detached: true
      })
    } catch {
      resolve(fallback('spawn_error'))
      return
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {}
      finish(() => fallback('timeout'))
    }, timeoutMs)
    /** @type {Buffer[]} */
    const chunks = []
    let exited = false
    let ended = false
    const parse = () => finish(() => {
      const out = Buffer.concat(chunks)
      const at = out.indexOf(marker + '\0')
      const env = at === -1 ? {} : parseEnv0(out.subarray(at + marker.length + 1))
      return Object.keys(env).length === 0 ? fallback('no_output') : dropSessionVars(env)
    })
    child.stdout?.on('data', (d) => chunks.push(d))
    child.stdout?.on('end', () => {
      ended = true
      if (exited) parse()
    })
    child.on('error', () => finish(() => fallback('spawn_error')))
    child.on('exit', (code) => {
      if (code !== 0) return finish(() => fallback('exit'))
      exited = true
      if (ended) parse()
      else drainTimer = setTimeout(parse, EXIT_DRAIN_MS)
    })
  })
}

/**
 * Sorted names that `loginEnv` has and `baseEnv` lacks or holds a different
 * value for. Names only, never values.
 * @param {Record<string, string | undefined>} loginEnv
 * @param {Record<string, string | undefined>} baseEnv
 * @returns {string[]}
 */
export function changedNames (loginEnv, baseEnv) {
  return Object.keys(loginEnv).filter((name) => baseEnv[name] !== loginEnv[name]).sort()
}
