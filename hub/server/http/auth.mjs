import { readFileSync, lstatSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { privateFileProblem } from '../../platform/index.mjs'
/**
 * Read a private, owner-owned base64url token without following symlinks. On POSIX the file must be owned by `uid`
 * and have mode 0600; on win32 it has no mode to check, and the owner's profile ACLs are what keep it private.
 * @param {string} file
 * @param {{ platform?: string, uid?: number | null }} [opts]
 */
export function readToken(file, { platform = process.platform, uid = process.getuid?.() ?? null } = {}) {
  const info = lstatSync(file)
  if (!info.isFile() || privateFileProblem(info, { platform, uid })) throw Error('deck token must be a private 0600 file')
  const token = readFileSync(file, 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error('invalid deck token')
  return token
}
/** Compare token carriers without exposing their content. */
export function sameToken(candidate, token) {
  const left = Buffer.from(candidate ?? '')
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}
/**
 * Parse the opt-in public origin (`--public-origin`, `DECK_PUBLIC_ORIGIN`, `config.json` `publicOrigin`). It is one
 * exact HTTPS origin, never a wildcard and never a pattern: the deck accepts that origin and loopback, nothing else.
 * An empty value means the deck stays loopback only, which is the default.
 * @param {unknown} value
 * @returns {{ origin: string, host: string, ws: string } | null}
 */
export function parsePublicOrigin(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw Error('public origin must be one https:// origin')
  if (value.includes('*')) throw Error('public origin must be one exact origin, never a wildcard')
  let url
  try { url = new URL(value) } catch { throw Error('public origin must be one https:// origin') }
  if (url.protocol !== 'https:') throw Error('public origin must use https://')
  if (!url.hostname) throw Error('public origin must name a host')
  // A loopback public origin would shadow the deck's own checks for every local tab rather than open a tunnel.
  if (['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'].includes(url.hostname)) throw Error('public origin must not be a loopback host')
  if (url.username || url.password) throw Error('public origin must carry no credentials')
  if (!['', '/'].includes(url.pathname) || url.search || url.hash) throw Error('public origin must have no path, query or fragment')
  return { origin: url.origin, host: url.host, ws: `wss://${url.host}` }
}
/**
 * The origin this request arrived through: the public one when its `Host` names it, else IPv4 loopback.
 * Host and Origin are always checked as that one pair, so a public Host with a loopback Origin is refused.
 * @param {{ headers: Record<string, string | undefined> }} req
 * @param {number} port
 * @param {{ origin: string, host: string } | null} [publicOrigin]
 * @returns {string}
 */
export function requestOrigin(req, port, publicOrigin = null) {
  return publicOrigin && req.headers.host === publicOrigin.host ? publicOrigin.origin : `http://127.0.0.1:${port}`
}
/**
 * Check canonical Host, browser Origin, fetch metadata and token before routing. `api` turns on the browser checks
 * every `/api` request gets: an Origin on writes, `sec-fetch-site`, no preflight. `requireToken` is separate from
 * it, so the passphrase exchange, which is the one surface with no token to present, still gets all of them.
 */
export function authorize(req, { port, token, upgrade = false, api = true, requireToken = api, publicOrigin = null }) {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && !(publicOrigin && host === publicOrigin.host)) return { status: host === `localhost:${port}` ? 421 : 403, code: 'forbidden_host' }
  const origin = req.headers.origin
  if ((upgrade || api && !['GET', 'HEAD'].includes(req.method) || origin) && origin !== requestOrigin(req, port, publicOrigin)) return { status: 403, code: 'forbidden_origin' }
  if (api && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return { status: 403, code: 'forbidden_origin' }
  if (api && req.method === 'OPTIONS') return { status: 403, code: 'forbidden_origin' }
  if (requireToken) {
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
    const carrier = upgrade ? protocols.find(value => value.startsWith('deck.auth.'))?.slice(10) : /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!sameToken(carrier, token) || upgrade && !protocols.includes('deck.v1')) return { status: 401, code: 'unauthorized' }
  }
  return null
}
/**
 * Set the common browser isolation headers and API cache policy. With a public origin the policy also allows that
 * origin and its `wss://` form in `connect-src`, and names `worker-src 'self'` for the service worker the installed
 * PWA registers rather than leaving it to each engine's reading of `default-src 'none'`. The worker is registered
 * over HTTPS only (web/src/main.jsx), so a loopback deck never needs this and its headers do not change.
 */
export function securityHeaders(port, api = false, publicOrigin = null) {
  return {
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:${port}${publicOrigin ? ` ${publicOrigin.origin} ${publicOrigin.ws}` : ''}; media-src 'self'; manifest-src 'self'; ${publicOrigin ? "worker-src 'self'; " : ''}frame-ancestors 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=()',
    ...(api ? { 'Cache-Control': 'no-store' } : {})
  }
}
