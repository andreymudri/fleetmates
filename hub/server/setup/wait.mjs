import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { doctor } from './doctor.mjs'

/** Resolve true once a Unix socket accepts a connection, false on any error or after `timeout` ms. */
function connectOnce(file, timeout = 500) {
  return new Promise(resolve => {
    const socket = net.createConnection(file)
    const done = ok => { clearTimeout(timer); socket.destroy(); resolve(ok) }
    const timer = setTimeout(() => done(false), timeout)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Poll a Unix socket until it accepts a connection, for at most `timeoutMs` (default 3 s).
 * `now`, `sleep` and `connect` are injectable so tests run on a virtual clock.
 * @returns {Promise<boolean>} whether the socket accepted a connection before the deadline
 */
export async function waitForSocket(file, { timeoutMs = 3000, intervalMs = 100, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), connect = connectOnce } = {}) {
  const deadline = now() + timeoutMs
  for (;;) {
    if (await connect(file)) return true
    const left = deadline - now()
    if (left <= 0) return false
    await sleep(Math.min(intervalMs, left))
  }
}

const probe = (file, argv) => spawnSync(file, argv, { encoding: 'utf8', timeout: 2000 })

/**
 * The checks `init` prints after it starts the units. deckd is `Type=simple`, so systemd calls it
 * active before it listens: wait (bounded) for its socket first, so a fresh install does not report
 * "deckd unavailable" for a daemon that is a moment from ready. A deckd that never listens still
 * fails the check, as before.
 */
export async function initChecks(paths, command, { run = probe, wait = waitForSocket, check = doctor } = {}) {
  if (paths.runtime && run('systemctl', ['--user', 'is-active', 'fleetmates-deckd.service']).status === 0) await wait(path.join(paths.runtime, 'deckd.sock'))
  return check(paths, command)
}
