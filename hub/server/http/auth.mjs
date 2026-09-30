import { readFileSync, lstatSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
/** Read a private, owner-owned base64url token without following symlinks. */
export function readToken(file) {
  const info = lstatSync(file)
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) throw Error('deck token must be a private 0600 file')
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
/** Check canonical Host, browser Origin, fetch metadata and token before routing. */
export function authorize(req, { port, token, upgrade = false, api = true }) {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}`) return { status: host === `localhost:${port}` ? 421 : 403, code: 'forbidden_host' }
  const origin = req.headers.origin
  if ((upgrade || api && !['GET', 'HEAD'].includes(req.method) || origin) && origin !== `http://127.0.0.1:${port}`) return { status: 403, code: 'forbidden_origin' }
  if (api && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return { status: 403, code: 'forbidden_origin' }
  if (api && req.method === 'OPTIONS') return { status: 403, code: 'forbidden_origin' }
  if (api) {
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
    const carrier = upgrade ? protocols.find(value => value.startsWith('deck.auth.'))?.slice(10) : /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!sameToken(carrier, token) || upgrade && !protocols.includes('deck.v1')) return { status: 401, code: 'unauthorized' }
  }
  return null
}
/** Set the common browser isolation headers and API cache policy. */
export function securityHeaders(port, api = false) {
  return {
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:${port}; media-src 'self'; manifest-src 'self'; frame-ancestors 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=()',
    ...(api ? { 'Cache-Control': 'no-store' } : {})
  }
}
