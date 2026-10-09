/** Path of the token-free passphrase exchange (08-security 4.2, remote access). Never cached: it carries the token. */
export const UNLOCK_PATH = '/.well-known/fleetmates-deck/pair'
/** The command the Unlock screen tells the owner to run on the machine that runs the deck. */
export const UNLOCK_COMMAND = 'fleetmates-deck remote-pass'
/** A verify that answers sooner than this shows no busy state, so a fast tailnet does not flash (design 3.1). */
export const BUSY_AFTER_MS = 600
/** A verify still unanswered after this is treated as unreachable (design 3.1). */
export const TIMEOUT_MS = 8000
/** How long the success line shows before the deck opens (design 3.2). */
export const SUCCESS_MS = 450

/**
 * Whether this page could ever pair: remote access is an opt-in tunnel, so a tab on IPv4 loopback is a local deck
 * whose token comes from `fleetmates-deck open`, not from a passphrase. Such a tab without a token belongs on the
 * shell's own authentication failure, not on a screen asking for a passphrase that does not exist.
 * @param {{ hostname: string }} location
 * @returns {boolean}
 */
export function pairable(location) {
  return !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname)
}

/**
 * Trade the remote access passphrase for the deck token. The reply carries the deck's own token, so the request is
 * `no-store` and the caller stores the token itself, never a URL and never a cookie.
 *
 * `retryAfterS` comes from the `Retry-After` header alone and is null when the deck did not send one: the screen
 * shows a countdown only for a number the server gave it (design 3.3).
 * @param {{ fetch: typeof fetch, passphrase: string, timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function }} options
 * @returns {Promise<{ ok: true, token: string } | { ok: false, reason: 'wrong' | 'rate_limited' | 'unset' | 'offline', retryAfterS: number | null }>}
 */
export async function exchangePassphrase({ fetch, passphrase, timeoutMs = TIMEOUT_MS, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(UNLOCK_PATH, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase })
    })
  } catch { return { ok: false, reason: 'offline', retryAfterS: null } } finally { clearTimeout(timer) }
  let payload = null
  try { payload = await response.json() } catch {}
  if (response.ok && typeof payload?.token === 'string') return { ok: true, token: payload.token }
  const seconds = Number(response.headers?.get?.('Retry-After'))
  return { ok: false, reason: refusal(response.status, payload?.error?.code), retryAfterS: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null }
}

/**
 * Which of the four refusals a response is. A deck without a passphrase and a deck without remote access turned on
 * are both `unset`: in each case there is nothing for the phone to type until someone acts on the machine.
 * @param {number} status
 * @param {string | undefined} code
 * @returns {'wrong' | 'rate_limited' | 'unset' | 'offline'}
 */
export function refusal(status, code) {
  if (status === 429 || code === 'too_many_attempts') return 'rate_limited'
  if (status === 404) return 'unset'
  if (status === 401 || status === 403) return 'wrong'
  return 'offline'
}

/**
 * The waiting message for a countdown, in seconds below a minute and in whole minutes above it (design 3.3).
 * @param {number} seconds
 * @returns {{ key: string, params: { n: number } }}
 */
export function waitMessage(seconds) {
  return seconds < 60 ? { key: 'unlock.wait.seconds', params: { n: seconds } } : { key: 'unlock.wait.minutes', params: { n: Math.ceil(seconds / 60) } }
}
