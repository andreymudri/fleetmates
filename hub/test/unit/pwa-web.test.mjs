import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { runnerImport } from 'vite'
import { fileURLToPath } from 'node:url'
import { TOKEN_KEY, captureToken, forgetToken, tokenIsDurable, wsUrl } from '../../web/src/state/api.js'
import { UNLOCK_COMMAND, UNLOCK_PATH, exchangePassphrase, pairable, refusal, waitMessage } from '../../web/src/state/unlock.js'
import { messages as en } from '../../web/src/i18n/en.js'

const web = fileURLToPath(new URL('../../web/', import.meta.url))
const hub = fileURLToPath(new URL('../../', import.meta.url))
const memoryStorage = () => {
  const map = new Map()
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }
}
const fakeLocation = href => {
  const url = new URL(href)
  return { hash: url.hash, pathname: url.pathname, search: url.search, host: url.host, hostname: url.hostname, protocol: url.protocol }
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
  // Signing out forgets both copies; the deck token itself is untouched, so another paired phone keeps working.
  assert.equal(tokenIsDurable(durable), true)
  forgetToken({ storage: session, durable })
  assert.equal(tokenIsDurable(durable), false)
  assert.equal(session.getItem(TOKEN_KEY), null)
  assert.equal(tokenIsDurable(null), false)
})

test('only a page that could pair shows Unlock and keeps the token past its tab', async () => {
  for (const href of ['http://127.0.0.1:47800/', 'http://localhost:47800/s/x']) assert.equal(pairable(fakeLocation(href)), false, href)
  assert.equal(pairable(fakeLocation('https://machine.tail1234.ts.net/')), true)
  const main = await readFile(`${web}src/main.jsx`, 'utf8')
  // A local tab without a token belongs on the shell's own authentication failure, not on a passphrase prompt,
  // and a local deck does not turn a tab-lifetime token into a stored one.
  assert.match(main, /const remote = pairable\(window\.location\)/)
  assert.match(main, /token \|\| !remote\n?\s*\? <Shell/)
  assert.match(main, /const durable = remote \|\| window\.matchMedia\?\.\('\(display-mode: standalone\)'\)\?\.matches \? window\.localStorage : null/)
  // The worker is for the tunnel: isSecureContext is true on loopback too, and a local deck has no use for one.
  assert.match(main, /window\.location\.protocol === 'https:'/)
  const settings = await readFile(`${web}src/screens/settings/Settings.jsx`, 'utf8')
  assert.match(settings, /settings\.conn\.signOut/, 'Settings offers a way to forget the key this device kept')
})

test('the unlock exchange posts the passphrase and tells the four refusals apart', async () => {
  const calls = []
  const reply = (status, body, headers = {}) => (path, init) => { calls.push([path, init.method, init.cache, JSON.parse(init.body)])
    return Promise.resolve({ ok: status === 200, status, headers: { get: name => headers[name] ?? null }, json: async () => body }) }
  assert.deepEqual(await exchangePassphrase({ fetch: reply(200, { token: 'a'.repeat(43) }), passphrase: 'correct horse battery' }), { ok: true, token: 'a'.repeat(43) })
  assert.deepEqual(calls, [[UNLOCK_PATH, 'POST', 'no-store', { passphrase: 'correct horse battery' }]])
  assert.deepEqual(await exchangePassphrase({ fetch: reply(401, { error: { code: 'unauthorized' } }), passphrase: 'x' }), { ok: false, reason: 'wrong', retryAfterS: null })
  assert.deepEqual(await exchangePassphrase({ fetch: reply(404, { error: { code: 'pairing_unavailable' } }), passphrase: 'x' }), { ok: false, reason: 'unset', retryAfterS: null })
  // The countdown comes from Retry-After alone: without the header the screen must not invent a number.
  assert.deepEqual(await exchangePassphrase({ fetch: reply(429, { error: { code: 'too_many_attempts' } }, { 'Retry-After': '120' }), passphrase: 'x' }),
    { ok: false, reason: 'rate_limited', retryAfterS: 120 })
  assert.deepEqual(await exchangePassphrase({ fetch: reply(429, { error: { code: 'too_many_attempts' } }), passphrase: 'x' }), { ok: false, reason: 'rate_limited', retryAfterS: null })
  assert.deepEqual(await exchangePassphrase({ fetch: () => Promise.reject(Error('offline')), passphrase: 'x' }), { ok: false, reason: 'offline', retryAfterS: null })
  // A request that never answers is abandoned at the timeout and reads as unreachable.
  const hung = await exchangePassphrase({ fetch: (path, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted')))),
    passphrase: 'x', timeoutMs: 5, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
  assert.deepEqual(hung, { ok: false, reason: 'offline', retryAfterS: null })
  assert.equal(refusal(500, 'internal'), 'offline')
  assert.deepEqual(waitMessage(59), { key: 'unlock.wait.seconds', params: { n: 59 } })
  assert.deepEqual(waitMessage(61), { key: 'unlock.wait.minutes', params: { n: 2 } })
})

test('the unlock copy is English only and names the command the deck really ships', async () => {
  const unlock = Object.keys(en).filter(key => key.startsWith('unlock.'))
  for (const key of ['unlock.title', 'unlock.subtitle', 'unlock.field.label', 'unlock.submit', 'unlock.success', 'unlock.error.wrong',
    'unlock.error.offline', 'unlock.wait.seconds', 'unlock.wait.minutes', 'unlock.unset.title', 'unlock.unset.body']) {
    assert.ok(unlock.includes(key), `${key} is in the English catalog`)
  }
  assert.equal(UNLOCK_COMMAND, 'fleetmates-deck remote-pass')
  const pt = await readFile(`${web}src/i18n/pt.js`, 'utf8')
  assert.doesNotMatch(pt, /unlock\./, 'the Portuguese catalog is unapproved and stays empty')
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

test('the manifest, the icons and the shell colours are the design ones, and every icon it names exists', async () => {
  const manifest = JSON.parse(await readFile(`${web}public/manifest.webmanifest`, 'utf8'))
  const tokens = await readFile(`${web}src/styles/tokens.css`, 'utf8')
  // theme_color is the Rail and terminal background, background_color is what body paints, so the splash does
  // not flash a different colour than the first frame.
  assert.match(tokens, new RegExp(`--color-ink-950: ${manifest.theme_color};`))
  assert.match(tokens, new RegExp(`--color-ink-900: ${manifest.background_color};`))
  const html = await readFile(`${web}index.html`, 'utf8')
  assert.match(html, new RegExp(`<meta name="theme-color" content="${manifest.theme_color}"`))
  const present = new Set(await readdir(`${web}public/icons`))
  for (const icon of manifest.icons) assert.ok(present.has(path.basename(icon.src)), `${icon.src} is built`)
  for (const href of html.match(/href="\/icons\/[^"]+"/g) ?? []) assert.ok(present.has(path.basename(href.slice(6, -1))), href)
  assert.ok(manifest.icons.some(icon => icon.purpose === 'monochrome'))
})

test('the phone layout is one media block that lifts the 1280px floor and clears the bottom bar', async () => {
  const tokens = await readFile(`${web}src/styles/tokens.css`, 'utf8')
  assert.match(tokens, /--breakpoint-mobile: 768px;/, 'the breakpoint is a token, generated from tokens.json')
  const mobile = await readFile(`${web}src/styles/mobile.css`, 'utf8')
  assert.equal((mobile.match(/@media/g) ?? []).length, 1, 'one block, one place to delete')
  assert.match(mobile, /@media \(max-width: 767px\)/)
  for (const rule of [/\.shell \{[^}]*min-width: 0/, /\.shell \{[^}]*height: 100dvh/, /\.rail \{[^}]*order: 2/,
    /\.home-grid,\s*\n\s*\.quiet-row \{[^}]*grid-template-columns: minmax\(0, 1fr\)/, /\.focus-list \{ display: none; \}/,
    /\.button--xs \{[^}]*min-height: var\(--size-control-hero\)/, /\.toast-stack \{[^}]*--layout-mobile-bar[^}]*env\(safe-area-inset-bottom\)/,
    /\.archive-toast \{[^}]*--layout-mobile-bar/]) assert.match(mobile, rule, String(rule))
  // The desktop sheet keeps its floor: the adaptation is additive and deleting mobile.css restores it.
  const shell = await readFile(`${web}src/styles/shell.css`, 'utf8')
  assert.match(shell, /min-width: var\(--breakpoint-laptop\)/)
  assert.match(shell, /\.rail-label \{ display: none; \}/, 'the bottom-bar label is hidden on a desktop')
  const rail = await readFile(`${web}src/shell/Rail.jsx`, 'utf8')
  assert.match(rail, /className="rail-label" aria-hidden="true">\{item\.section\}/, 'icon-only links would be unlabelled without hover')
})

test('a phone viewport never sends a terminal resize, because the PTY is the one on the machine', async () => {
  const { module } = await runnerImport(path.join(hub, 'web/src/components/TerminalView.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  const media = matches => query => ({ matches: query === '(max-width: 767px)' && matches })
  assert.equal(module.phoneViewport({ matchMedia: media(true) }), true)
  assert.equal(module.phoneViewport({ matchMedia: media(false) }), false)
  assert.equal(module.phoneViewport({}), false, 'no matchMedia is not a phone')
  const source = await readFile(`${web}src/components/TerminalView.jsx`, 'utf8')
  // The local fit still runs; only the message to the server is withheld.
  assert.match(source, /const phone = phoneViewport\(scope\)/)
  assert.match(source, /try \{ fit\.fit\(\) \} catch \{\}\n\s*if \(!phone\) handle\?\.resize\(term\.cols, term\.rows\)/)
})
