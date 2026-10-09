import { spawnSync } from 'node:child_process'
import { connectOnce, deckService, doctor } from './doctor.mjs'

/**
 * Poll an endpoint (a Unix socket or a named pipe) until it accepts a connection, for at most `timeoutMs` (default 3 s).
 * `now`, `sleep` and `connect` are injectable so tests run on a virtual clock.
 * @returns {Promise<boolean>} whether the endpoint accepted a connection before the deadline
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

const probe = (file, argv, options = {}) => spawnSync(file, argv, { encoding: 'utf8', timeout: 2000, ...options })

/**
 * The checks `init` prints after it starts the services. A service manager can call deckd active before it listens
 * (systemd `Type=simple`): when the adapter's `isActive('deckd')` is true, wait (bounded) for the deckd endpoint
 * first, so a fresh install does not report "deckd unavailable" for a daemon that is a moment from ready. A deckd
 * that never listens still fails the check, as before.
 */
export async function initChecks(paths, command, { run = probe, wait = waitForSocket, check = doctor, platform = process.platform, env = process.env, service } = {}) {
  const manager = deckService(paths, { platform, run, service, env })
  if (paths.endpoints?.deckd && await manager.isActive('deckd')) await wait(paths.endpoints.deckd)
  return check(paths, command, { run, platform, env, service: manager })
}
