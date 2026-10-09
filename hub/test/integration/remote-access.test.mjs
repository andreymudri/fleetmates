import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { startDeckServer } from '../../server/main.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { hashPassphrase, writeRemotePass } from '../../server/http/remote-pass.mjs'

const token = 'a'.repeat(43)
const PUBLIC = 'https://machine.tail1234.ts.net'
const HOST = 'machine.tail1234.ts.net'
const PASSPHRASE = 'correct horse battery'

/**
 * A deck behind a tunnel: `publicOrigin` opted in, a built-shell stand-in with an index.html, and the remote
 * access passphrase already set, as `fleetmates-deck remote-pass` would have set it.
 */
async function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-'))
  // The state path the server derives from this env: ~/.local/state/... on linux, %LOCALAPPDATA% or its HOME
  // fallback on win32.
  const state = path.dirname(setupPaths({ HOME: dir }).token)
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  if (options.passphrase !== false) writeRemotePass(path.join(state, 'remote-pass.json'), await hashPassphrase(PASSPHRASE))
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-web-'))
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  fs.writeFileSync(path.join(staticDir, 'manifest.webmanifest'), '{"name":"fleetmates deck"}')
  fs.writeFileSync(path.join(staticDir, 'sw.js'), '// worker\n')
  const deck = await startDeckServer({ env: { HOME: dir }, port: 0, notifications: false, staticDir, tokenPollMs: 20,
    connectDeckd: async () => { throw Error('offline') }, remoteAccess: { sleep: () => Promise.resolve() },
    ...(options.publicOrigin === null ? {} : { publicOrigin: options.publicOrigin ?? PUBLIC }) })
  // Windows cannot remove a directory while a file in it is still open; retry for a while after the server closed.
  const rmDir = target => fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  t.after(async () => { await deck.close()
    rmDir(dir)
    rmDir(staticDir) })
  const port = deck.address().port
  const request = (route, headers = {}, method = 'GET', body = '') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method,
      headers: Object.fromEntries(Object.entries({ Host: HOST, Origin: PUBLIC, ...headers }).filter(([, value]) => value !== null)) }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: !data ? null : res.headers['content-type']?.startsWith('application/json') ? JSON.parse(data) : data }))
    })
    req.on('error', reject)
    req.end(body)
  })
  const pair = passphrase => request('/.well-known/fleetmates-deck/pair', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ passphrase }))
  return { deck, dir, port, request, pair }
}

test('with a public origin the deck answers its own host, the loopback one, and no mixed pair', async t => {
  const h = await harness(t)
  const bearer = { Authorization: `Bearer ${token}` }
  assert.equal((await h.request('/api/version', bearer)).status, 200)
  assert.equal((await h.request('/api/version', { ...bearer, Host: `127.0.0.1:${h.port}`, Origin: `http://127.0.0.1:${h.port}` })).status, 200)
  for (const [name, headers] of [
    ['a tunnel Host with a loopback Origin', { Origin: `http://127.0.0.1:${h.port}` }],
    ['a loopback Host with a tunnel Origin', { Host: `127.0.0.1:${h.port}` }],
    ['a neighbouring host', { Host: 'machine.tail1234.ts.net.evil.test', Origin: 'https://machine.tail1234.ts.net.evil.test' }]
  ]) {
    const response = await h.request('/api/version', { ...bearer, ...headers })
    assert.equal(response.status, 403, name)
  }
  // The policy names the tunnel, its socket and the worker.
  const csp = (await h.request('/', { Origin: null })).headers['content-security-policy']
  assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ https:\/\/machine\.tail1234\.ts\.net wss:\/\/machine\.tail1234\.ts\.net;/)
  assert.match(csp, /worker-src 'self';/)
})

test('a WebSocket upgrade through the tunnel is accepted, and a mixed pair is not', async t => {
  const h = await harness(t)
  const open = headers => {
    const client = new WebSocket(`ws://127.0.0.1:${h.port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { headers: { Host: HOST, Origin: PUBLIC, ...headers } })
    client.on('error', () => {})
    t.after(() => client.terminate())
    return client
  }
  const good = open({})
  await once(good, 'open')
  const [, response] = await once(open({ Origin: `http://127.0.0.1:${h.port}` }), 'unexpected-response')
  assert.equal(response.statusCode, 403)
  response.resume()
})

test('the passphrase exchange returns the deck token, and refuses a wrong one and a flood', async t => {
  const h = await harness(t)
  const ok = await h.pair(PASSPHRASE)
  assert.equal(ok.status, 200)
  assert.equal(ok.data.token, token)
  assert.equal(ok.headers['cache-control'], 'no-store')
  const wrong = await h.pair('not the passphrase')
  assert.equal(wrong.status, 401)
  assert.equal(wrong.data.error.code, 'unauthorized')
  assert.equal(wrong.headers['retry-after'], undefined, 'a wrong passphrase carries no wait')
  // A burst, not a loop: the window check and the counter sat on either side of an await, so concurrent posts
  // used to read an empty counter and all reach scrypt. Most of these must be refused without any work.
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => h.pair(`not the passphrase ${i}`)))
  const refused = burst.filter(response => response.status === 429)
  assert.ok(refused.length >= 30, `the burst is bounded, ${refused.length} of 40 refused outright`)
  assert.match(refused[0].headers['retry-after'], /^\d+$/, 'the Unlock screen counts down from this header')
  assert.ok(Number(refused[0].headers['retry-after']) >= 1, 'a wait of zero seconds would have the screen retry at once')
  assert.equal(burst.filter(response => response.status === 200).length, 0)
  // The owner is never locked out by someone else's guesses.
  const right = await h.pair(PASSPHRASE)
  assert.equal(right.status, 200)
  assert.equal(right.data.token, token)
  // The exchange is still a same-origin surface: a foreign Origin never reaches it.
  assert.equal((await h.request('/.well-known/fleetmates-deck/pair', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, 'POST', '{}')).status, 403)
  assert.equal((await h.request('/.well-known/fleetmates-deck/pair')).status, 404, 'GET is not the exchange')
  // The exchange carries no token, so it gets the other API checks instead: a POST with no Origin at all, and a
  // cross-site fetch metadata header, are both refused.
  assert.equal((await h.request('/.well-known/fleetmates-deck/pair', { 'Content-Type': 'application/json', Origin: null }, 'POST', '{}')).status, 403)
  assert.equal((await h.request('/.well-known/fleetmates-deck/pair', { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, 'POST', '{}')).status, 403)
  assert.equal((await h.request('/.well-known/fleetmates-deck/pair', { 'Content-Type': 'application/json' }, 'OPTIONS')).status, 403, 'no preflight')
})

test('without a public origin nothing changes: no exchange, no worker-src, no tunnel host', async t => {
  const h = await harness(t, { publicOrigin: null })
  const loopback = { Host: `127.0.0.1:${h.port}`, Origin: `http://127.0.0.1:${h.port}` }
  assert.equal((await h.request('/api/version', { ...loopback, Authorization: `Bearer ${token}` })).status, 200)
  assert.equal((await h.request('/api/version', { Authorization: `Bearer ${token}` })).status, 403, 'the tunnel host is a foreign host again')
  const page = await h.request('/', { ...loopback, Origin: null })
  assert.doesNotMatch(page.headers['content-security-policy'], /worker-src|tail1234/)
  // A real JSON 404, not the SPA fallback: a 200 with an index.html body would read to the client as a deck that
  // cannot be reached, and a desktop tab without a token would be told to check its tailnet.
  const pair = await h.request('/.well-known/fleetmates-deck/pair', { ...loopback, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ passphrase: PASSPHRASE }))
  assert.equal(pair.status, 404, 'the exchange does not exist without the opt-in')
  assert.equal(pair.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(pair.data.error.code, 'pairing_unavailable')
})

test('the exchange is unavailable when no passphrase was ever set', async t => {
  const h = await harness(t, { passphrase: false })
  const response = await h.pair(PASSPHRASE)
  assert.equal(response.status, 404)
  assert.equal(response.data.error.code, 'pairing_unavailable')
})

test('the shell paths are served with their own types, and a missing one is a real 404', async t => {
  const h = await harness(t)
  const manifest = await h.request('/manifest.webmanifest', { Origin: null })
  assert.equal(manifest.status, 200)
  assert.equal(manifest.headers['content-type'], 'application/manifest+json')
  assert.equal((await h.request('/sw.js', { Origin: null })).headers['content-type'], 'text/javascript')
  // An unknown SPA route still gets the shell, but a missing worker, manifest or icon must not.
  assert.equal((await h.request('/settings/notifications', { Origin: null })).status, 200)
  for (const route of ['/icons/icon-192.png', '/icons/missing.png', '/service-worker.js']) {
    const response = await h.request(route, { Origin: null })
    assert.equal(response.status, route === '/service-worker.js' ? 200 : 404, route)
  }
})

test('a public origin that is a wildcard or plaintext stops the server from starting', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-bad-'))
  const state = path.dirname(setupPaths({ HOME: dir }).token)
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  for (const [value, reason] of [['https://*.ts.net', /wildcard/], ['http://machine.tail1234.ts.net', /https/], ['https://machine.tail1234.ts.net/deck', /path, query or fragment/]]) {
    await assert.rejects(async () => {
      const deck = await startDeckServer({ env: { HOME: dir }, port: 0, notifications: false, publicOrigin: value, connectDeckd: async () => { throw Error('offline') } })
      await deck.close()
    }, reason, value)
  }
})

test('the public origin resolves as the port does: options, then the environment, then config.json', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-env-'))
  const paths = setupPaths({ HOME: dir })
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(paths.token, token, { mode: 0o600 })
  fs.mkdirSync(paths.config, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(paths.config, 'config.json'), JSON.stringify({ publicOrigin: 'https://from-config.ts.net' }), { mode: 0o600 })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const start = async env => {
    const deck = await startDeckServer({ env: { HOME: dir, ...env }, port: 0, notifications: false, connectDeckd: async () => { throw Error('offline') } })
    t.after(() => deck.close())
    const port = deck.address().port
    const ask = host => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/version', headers: { Host: host, Authorization: `Bearer ${token}` } }, res => { res.resume()
        resolve(res.statusCode) })
      req.on('error', reject)
      req.end()
    })
    return { ask, port }
  }
  const fromConfig = await start({})
  assert.equal(await fromConfig.ask('from-config.ts.net'), 200, 'config.json alone opens the origin')
  const fromEnv = await start({ DECK_PUBLIC_ORIGIN: 'https://from-env.ts.net' })
  assert.equal(await fromEnv.ask('from-env.ts.net'), 200)
  assert.equal(await fromEnv.ask('from-config.ts.net'), 403, 'the environment wins over config.json, as DECK_PORT does')
  // A set but empty variable is not an absent one: it turns remote access off without editing config.json.
  const off = await start({ DECK_PUBLIC_ORIGIN: '' })
  assert.equal(await off.ask('from-config.ts.net'), 403)
  assert.equal(await off.ask(`127.0.0.1:${off.port}`), 200)
})
