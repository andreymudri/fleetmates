import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { TOKEN_KEY, captureToken, wsUrl } from '../../web/src/state/api.js'
import { PAIR_PATH, exchangePassphrase, pairingMessage } from '../../web/src/state/pairing.js'

const web = fileURLToPath(new URL('../../web/', import.meta.url))
const memoryStorage = () => {
  const map = new Map()
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }
}
const fakeLocation = href => {
  const url = new URL(href)
  return { hash: url.hash, pathname: url.pathname, search: url.search, host: url.host, protocol: url.protocol }
}

test('the socket scheme follows the page, so an HTTPS tunnel upgrades with wss', () => {
  assert.equal(wsUrl(fakeLocation('http://127.0.0.1:47800/')), 'ws://127.0.0.1:47800/api/ws')
  assert.equal(wsUrl(fakeLocation('https://machine.tail1234.ts.net/s/abc')), 'wss://machine.tail1234.ts.net/api/ws')
})

test('the token is kept durably for an installed PWA while an open tab keeps its own', () => {
  const session = memoryStorage()
  const durable = memoryStorage()
  const history = { replaceState: () => {} }
  captureToken({ location: fakeLocation('http://127.0.0.1:47800/#token=abc'), history, storage: session, durable })
  assert.equal(session.getItem(TOKEN_KEY), 'abc')
  assert.equal(durable.getItem(TOKEN_KEY), 'abc', 'a launch from the home screen has no fragment and a fresh session store')
  // A fresh tab of the installed app: nothing in sessionStorage, the durable copy carries it.
  assert.deepEqual(captureToken({ location: fakeLocation('http://127.0.0.1:47800/'), history, storage: memoryStorage(), durable }), { token: 'abc', to: null })
  // The tab's own token still wins over the durable one, so a tab opened with a fresher token is not downgraded.
  const other = memoryStorage()
  other.setItem(TOKEN_KEY, 'tab')
  assert.deepEqual(captureToken({ location: fakeLocation('http://127.0.0.1:47800/'), history, storage: other, durable }), { token: 'tab', to: null })
  // Without a durable store the behaviour is the old one exactly.
  assert.deepEqual(captureToken({ location: fakeLocation('http://127.0.0.1:47800/'), history, storage: memoryStorage() }), { token: null, to: null })
})

test('the pairing exchange posts the passphrase and reports each refusal', async () => {
  const calls = []
  const reply = (status, body) => (path, init) => { calls.push([path, init.method, init.cache, JSON.parse(init.body)])
    return Promise.resolve({ ok: status === 200, status, json: async () => body }) }
  assert.deepEqual(await exchangePassphrase({ fetch: reply(200, { token: 'a'.repeat(43) }), passphrase: 'correct horse battery' }), { ok: true, token: 'a'.repeat(43) })
  assert.deepEqual(calls, [[PAIR_PATH, 'POST', 'no-store', { passphrase: 'correct horse battery' }]])
  assert.deepEqual(await exchangePassphrase({ fetch: reply(401, { error: { code: 'unauthorized' } }), passphrase: 'x' }), { ok: false, code: 'unauthorized', retryAfterMs: null })
  assert.deepEqual(await exchangePassphrase({ fetch: reply(429, { error: { code: 'too_many_attempts', details: { retryAfterMs: 120000 } } }), passphrase: 'x' }),
    { ok: false, code: 'too_many_attempts', retryAfterMs: 120000 })
  assert.deepEqual(await exchangePassphrase({ fetch: () => Promise.reject(Error('offline')), passphrase: 'x' }), { ok: false, code: 'offline', retryAfterMs: null })
  assert.match(pairingMessage('unauthorized'), /does not match/)
  assert.match(pairingMessage('too_many_attempts', 120000), /2 minute/)
  assert.match(pairingMessage('pairing_unavailable'), /remote-pass/)
})

test('the shell declares the manifest and the iOS meta tags, and the worker caches the shell only', async () => {
  const html = await readFile(`${web}index.html`, 'utf8')
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover"/)
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/)
  for (const name of ['apple-mobile-web-app-capable', 'apple-mobile-web-app-status-bar-style']) assert.match(html, new RegExp(`<meta name="${name}"`), name)
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\//)
  const manifest = JSON.parse(await readFile(`${web}public/manifest.webmanifest`, 'utf8'))
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'), 'a maskable icon, or Android crops the square one')
  const worker = await readFile(`${web}public/sw.js`, 'utf8')
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\) \|\| url\.pathname\.startsWith\('\/\.well-known\/'\)\) return false/, 'the token paths never reach the cache')
  assert.match(worker, /request\.method !== 'GET'/)
  assert.doesNotMatch(worker, /cache\.put\(event\.request, copy\)[\s\S]{0,40}api/, 'nothing under /api is ever written to the cache')
  const shell = await readFile(`${web}src/styles/shell.css`, 'utf8')
  assert.match(shell, /@media \(display-mode: standalone\)[\s\S]*env\(safe-area-inset-top\)/)
})
