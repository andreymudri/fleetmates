// Bounded public-source reachability. HEAD only; no downloads, cookies, auth or executable text.
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'

export const MAX_SOURCE_URLS = 20
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    const c = Number(address.split('.')[2])
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) && !(a === 203 && b === 0 && c === 113)
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase()
    // Public unicast only. Reject mapped/compatible IPv4, link-local, loopback and unique-local.
    return /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:') && !value.startsWith('2002:') && !value.startsWith('2001:0000:') && !value.startsWith('2001:0:')
  }
  return false
}

export function sourceUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('invalid source URL') }
  if (typeof value !== 'string' || value.length > 2000 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !['', '80', '443'].includes(url.port)) throw new Error('invalid source URL')
  url.hash = ''
  return url
}

function head(url, address, signal) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'HEAD', signal, timeout: 4000,
      // Pin the validated DNS answer for this connection; keep the URL host for Host and TLS SNI.
      lookup: (_host, options, callback) => options?.all
        ? callback(null, [{ address: address.address, family: address.family }]) : callback(null, address.address, address.family),
      headers: { 'User-Agent': 'fleetmates-deck-source-preflight/1', Accept: '*/*' },
    }, response => { response.resume(); resolve({ status: response.statusCode, location: response.headers.location ?? null }) })
    request.once('timeout', () => request.destroy(new Error('source timeout')))
    request.once('error', reject)
    request.end()
  })
}

export async function probeSource(value, { lookup = dnsLookup, request = head, timeoutMs = 5000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    let url = sourceUrl(value)
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted()
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return { state: 'blocked', status: null }
      const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
        lookup(host, { all: true, verbatim: true }), new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('source timeout')), { once: true })),
      ])
      if (!answers.length || answers.some(answer => !publicAddress(answer.address))) return { state: 'blocked', status: null }
      const response = await request(url, answers[0], signal)
      if ([301, 302, 303, 307, 308].includes(response.status) && response.location) { url = sourceUrl(new URL(response.location, url).href); continue }
      return { state: response.status >= 200 && response.status < 400 ? 'reachable' : 'unreachable', status: response.status }
    }
    return { state: 'unreachable', status: null }
  } catch { return { state: 'unreachable', status: null } }
}

export async function sourcePreflight(urls, { probe = probeSource, now = Date.now } = {}) {
  if (!Array.isArray(urls) || urls.length > MAX_SOURCE_URLS) throw new Error('invalid source list')
  const unique = [...new Set(urls.map(value => sourceUrl(value).href))]
  const sources = new Array(unique.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (next < unique.length) {
      const index = next++, url = unique[index], llmsUrl = new URL('/llms.txt', url).href
      const llms = await probe(llmsUrl)
      const page = await probe(url)
      sources[index] = { url, llmsUrl, llms, page }
    }
  }))
  return { v: 1, at: now(), state: sources.length ? 'checked' : 'no-seed-sources', sources }
}

export function sourceScore(source, now = Date.now()) {
  const published = typeof source.publishedAt === 'string' ? Date.parse(source.publishedAt) : NaN
  const days = Number.isFinite(published) && published <= now ? (now - published) / 86400000 : null
  const recency = days === null ? 0 : 2 ** (-days / 180)
  const engagement = Number.isSafeInteger(source.engagement) && source.engagement >= 0 ? Math.min(1, Math.log10(1 + source.engagement) / 4) : 0
  return { score: Math.round((0.7 * recency + 0.3 * engagement) * 100), recencyKnown: days !== null, engagementKnown: Number.isSafeInteger(source.engagement) && source.engagement >= 0 }
}
export function rankSources(sources, now = Date.now()) {
  return sources.map(source => ({ ...source, ranking: sourceScore(source, now) })).sort((a, b) => b.ranking.score - a.ranking.score || String(a.id).localeCompare(String(b.id)))
}
