/** Path of the token-free passphrase exchange (08-security 4.2, remote access). Never cached: it carries the token. */
export const PAIR_PATH = '/.well-known/fleetmates-deck/pair'

/**
 * Trade the remote access passphrase for the deck token. The reply is the deck's own token, so the response is
 * requested with `cache: 'no-store'` and the caller stores it, never a URL or a cookie.
 * @param {{ fetch: typeof fetch, passphrase: string }} options
 * @returns {Promise<{ ok: true, token: string } | { ok: false, code: string, retryAfterMs: number | null }>}
 */
export async function exchangePassphrase({ fetch, passphrase }) {
  let response
  try {
    response = await fetch(PAIR_PATH, {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase })
    })
  } catch { return { ok: false, code: 'offline', retryAfterMs: null } }
  let payload = null
  try { payload = await response.json() } catch {}
  if (response.ok && typeof payload?.token === 'string') return { ok: true, token: payload.token }
  return { ok: false, code: payload?.error?.code ?? 'internal', retryAfterMs: payload?.error?.details?.retryAfterMs ?? null }
}

/**
 * The message for a refused exchange. `unauthorized` never says whether the passphrase was close to right.
 * @param {string} code
 * @param {number | null} [retryAfterMs]
 * @returns {string}
 */
export function pairingMessage(code, retryAfterMs = null) {
  if (code === 'unauthorized') return 'That passphrase does not match. Try again.'
  if (code === 'too_many_attempts') return `Too many attempts. Wait ${Math.ceil((retryAfterMs ?? 0) / 60000)} minute(s) and try again.`
  if (code === 'not_found' || code === 'pairing_unavailable') return 'This deck has no remote access passphrase set. Run `fleetmates-deck remote-pass` on the machine that runs it.'
  if (code === 'offline') return 'The deck did not answer. Check that you are on the tailnet.'
  return 'Pairing failed. Try again.'
}
