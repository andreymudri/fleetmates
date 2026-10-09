import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { startDeckServer } from '../../server/main.mjs'
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
  const state = path.join(dir, '.local/state/fleetmates/deck')
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
  t.after(async () => { await deck.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(staticDir, { recursive: true, force: true }) })
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
  for (let i = 0; i < 9; i++) await h.pair('not the passphrase')
  const flooded = await h.pair(PASSPHRASE)
  assert.equal(flooded.status, 429)
  assert.equal(flooded.data.error.code, 'too_many_attempts')
  // The Unlock screen counts down from this header and never invents a number when it is absent.
  assert.match(flooded.headers['retry-after'], /^\d+$/)
  assert.equal(wrong.headers['retry-after'], undefined, 'a wrong passphrase carries no wait')
  // The exchange is still a same-origin surface: a foreign Origin never reaches it.
  assert.equal((await h.request('/.well-known/fleetmates-deck/pair', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, 'POST', '{}')).status, 403)
  assert.equal((await h.request('/.well-known/fleetmates-deck/pair')).status, 404, 'GET is not the exchange')
})

test('without a public origin nothing changes: no exchange, no worker-src, no tunnel host', async t => {
  const h = await harness(t, { publicOrigin: null })
  const loopback = { Host: `127.0.0.1:${h.port}`, Origin: `http://127.0.0.1:${h.port}` }
  assert.equal((await h.request('/api/version', { ...loopback, Authorization: `Bearer ${token}` })).status, 200)
  assert.equal((await h.request('/api/version', { Authorization: `Bearer ${token}` })).status, 403, 'the tunnel host is a foreign host again')
  const page = await h.request('/', { ...loopback, Origin: null })
  assert.doesNotMatch(page.headers['content-security-policy'], /worker-src|tail1234/)
  const pair = await h.request('/.well-known/fleetmates-deck/pair', { ...loopback, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ passphrase: PASSPHRASE }))
  assert.equal(pair.status, 404, 'the exchange does not exist without the opt-in')
  assert.equal(pair.data.error.code, 'not_found')
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
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [value, reason] of [['https://*.ts.net', /wildcard/], ['http://machine.tail1234.ts.net', /https/], ['https://machine.tail1234.ts.net/deck', /path, query or fragment/]]) {
    await assert.rejects(async () => {
      const deck = await startDeckServer({ env: { HOME: dir }, port: 0, notifications: false, publicOrigin: value, connectDeckd: async () => { throw Error('offline') } })
      await deck.close()
    }, reason, value)
  }
})
