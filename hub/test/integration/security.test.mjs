import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createDeckServer, startDeckServer } from '../../server/main.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { posixTest } from '../helpers/platform.mjs'
// Windows cannot remove a directory while a file in it is still open; retry for a while after the server closed.
const rmDir = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
const token = 'a'.repeat(43)
async function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'))
  // The token path the server derives from this env: ~/.local/state/... on linux, %LOCALAPPDATA% or its HOME fallback on win32.
  const tokenFile = setupPaths({ HOME: dir }).token
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(tokenFile, token, { mode: 0o600 })
  const deck = await startDeckServer({ env: { HOME: dir }, port: 0, notifications: false, connectDeckd: async () => { throw Error('offline') }, tokenPollMs: 20, helloTimeoutMs: 30, ...options })
  t.after(async () => { await deck.close()
    rmDir(dir) })
  const port = deck.address().port
  const request = (route, headers = {}, method = 'GET', body = '') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method,
      // A header given as null is not sent at all; an empty string is sent as an empty value.
      headers: Object.fromEntries(Object.entries({ Authorization: `Bearer ${token}`, Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, ...headers }).filter(([, value]) => value !== null)) }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: !data ? null : res.headers['content-type']?.startsWith('application/json') ? JSON.parse(data) : data }))
    })
    req.on('error', reject)
    req.end(body)
  })
  const ws = (headers = {}, protocols = ['deck.v1', `deck.auth.${token}`]) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, protocols, { headers: { Origin: `http://127.0.0.1:${port}`, ...headers } })
    client.on('error', () => {})
    t.after(() => client.terminate())
    return client
  }
  return { deck, dir, tokenFile, port, request, ws }
}
for (const [name, headers, status, code] of [
  ['bearer', { Authorization: 'Bearer wrong' }, 401, 'unauthorized'],
  ['query token', { Authorization: '' }, 401, 'unauthorized'],
  ['host', { Host: 'attacker.test:47800' }, 403, 'forbidden_host'],
  ['localhost redirect', { Host: 'localhost:PORT' }, 421, 'forbidden_host'],
  ['origin', { Origin: 'https://attacker.test' }, 403, 'forbidden_origin'],
  ['different port', { Origin: 'http://127.0.0.1:1' }, 403, 'forbidden_origin'],
  ['fetch site', { 'Sec-Fetch-Site': 'cross-site' }, 403, 'forbidden_origin']
]) test(`HTTP rejects ${name} on every API path including unknown routes`, async t => {
  const h = await harness(t)
  const actual = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, value.replace('PORT', h.port)]))
  for (const route of ['/api/health', '/api/missing', `/api/version?token=${token}`]) {
    const response = await h.request(route, actual)
    assert.equal(response.status, status)
    assert.equal(response.data.error.code, code)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['access-control-allow-origin'], undefined)
  }
})
test('the localhost 421 points at the canonical origin with a Location header', async t => {
  const h = await harness(t)
  for (const route of ['/api/health', '/']) {
    const response = await h.request(route, { Host: `localhost:${h.port}` })
    assert.equal(response.status, 421)
    assert.equal(response.headers.location, `http://127.0.0.1:${h.port}/`)
  }
})
/** A harness whose built SPA is a temporary index.html, so a request that passes the checks gets a 200 page. */
async function withSpa(t) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-web-'))
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  t.after(() => fs.rmSync(staticDir, { recursive: true, force: true }))
  return harness(t, { staticDir })
}
test('a foreign Origin is refused on non-API paths too, while the same page loads without one', async t => {
  const h = await withSpa(t)
  assert.equal((await h.request('/', { Origin: null })).status, 200)
  for (const [route, method] of [['/', 'GET'], ['/settings', 'OPTIONS']]) {
    const response = await h.request(route, { Origin: 'http://evil.example' }, method)
    assert.equal(response.status, 403, `${method} ${route}`)
    assert.equal(response.data.error.code, 'forbidden_origin')
  }
})
test('OPTIONS on a non-API path is not_found with a same-origin or no Origin', async t => {
  const h = await withSpa(t)
  for (const origin of [`http://127.0.0.1:${h.port}`, null]) {
    const response = await h.request('/', { Origin: origin }, 'OPTIONS')
    assert.equal(response.status, 404, `Origin ${origin ?? 'absent'}`)
    assert.equal(response.data.error.code, 'not_found')
  }
})
test('writes reject missing Origin and preflights; GET and HEAD require no Origin and HEAD has no body', async t => {
  const h = await harness(t)
  assert.equal((await h.request('/api/prefs', { Origin: '' }, 'PATCH', '{}')).status, 403)
  assert.equal((await h.request('/api/prefs', {}, 'OPTIONS')).status, 403)
  assert.equal((await h.request('/api/version', { Origin: '' })).status, 200)
  const head = await h.request('/api/version', { Origin: '' }, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.data, null)
})
test('JSON body type, schema and 256 KiB streamed limit are enforced before writes', async t => {
  const h = await harness(t)
  assert.equal((await h.request('/api/prefs', { 'Content-Type': 'text/plain' }, 'PATCH', '{}')).status, 415)
  for (const body of ['{', '[]', 'null', '{"textSize":99}', '{"unknown":true}', '{"constructor":"x"}', '{"__proto__":"x"}']) {
    assert.equal((await h.request('/api/prefs', { 'Content-Type': 'application/json' }, 'PATCH', body)).status, 422)
  }
  const streamed = await h.request('/api/prefs', { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, 'PATCH', '{"scanRoot":"' + 'x'.repeat(1024 * 1024) + '"}')
  assert.equal(streamed.status, 413)
  assert.notEqual(streamed.headers.connection, 'close', 'the upload must drain before closing its socket')
  const body = JSON.stringify({ scanRoot: 'x'.repeat(300_000) })
  const declared = await h.request('/api/prefs', { 'Content-Type': 'application/json' }, 'PATCH', body)
  assert.equal(declared.status, 413)
  assert.notEqual(declared.headers.connection, 'close', 'a declared oversized upload also drains')
  const fits = JSON.stringify({ scanRoot: 'x'.repeat(200_000) })
  assert.equal((await h.request('/api/prefs', { 'Content-Type': 'application/json' }, 'PATCH', fits)).status, 200)
})
for (const [name, headers, protocols, status] of [
  ['token', {}, ['deck.v1', 'deck.auth.wrong'], 401],
  ['protocol', {}, [`deck.auth.${token}`], 401],
  ['Origin', { Origin: '' }, undefined, 403],
  ['cross origin', { Origin: 'https://attacker.test' }, undefined, 403],
  ['Host', { Host: 'attacker.test' }, undefined, 403],
  ['fetch site', { 'Sec-Fetch-Site': 'cross-site' }, undefined, 403]
]) test(`WebSocket upgrade rejects ${name}`, async t => {
  const h = await harness(t)
  const client = h.ws(headers, protocols)
  const [, response] = await Promise.race([once(client, 'unexpected-response'), once(client, 'open').then(() => [null, { statusCode: 101, headers: {} }])]).catch(() => [null, { statusCode: 101, headers: {} }])
  assert.equal(response.statusCode, status)
  assert.equal(response.headers['cache-control'], 'no-store')
  response.resume()
})
test('token rotation closes existing sockets and invalidates old HTTP tokens', async t => {
  const h = await harness(t)
  const ws = h.ws()
  await once(ws, 'open')
  const closing = once(ws, 'close')
  const fresh = 'b'.repeat(43)
  fs.writeFileSync(h.tokenFile + '.new', fresh, { mode: 0o600 })
  fs.renameSync(h.tokenFile + '.new', h.tokenFile)
  const [code] = await closing
  assert.equal(code, 4401)
  assert.equal((await h.request('/api/version')).status, 401)
  assert.equal((await h.request('/api/version', { Authorization: `Bearer ${fresh}` })).status, 200)
})
test('bad, missing and incompatible WebSocket hello messages close with specified codes', async t => {
  const h = await harness(t)
  for (const [message, expected] of [[null, 4400], ['{', 4400], [{ t: 'hello', apiVersion: 2, epoch: null, lastSeq: 0 }, 4410], [{ t: 'hello', apiVersion: 1, epoch: null, lastSeq: -1 }, 4400]]) {
    const ws = h.ws()
    await once(ws, 'open')
    const closing = once(ws, 'close')
    if (message !== null) ws.send(typeof message === 'string' ? message : JSON.stringify(message))
    assert.equal((await closing)[0], expected)
  }
})
test('server refuses a non-loopback bind', async t => {
  const h = await harness(t)
  await assert.rejects(async () => {
    const candidate = await createDeckServer({ host: '0.0.0.0', env: { HOME: h.dir }, port: 0, notifications: false, connectDeckd: async () => { throw Error('offline') } })
    await candidate.close()
  }, /loopback/)
})
posixTest('server refuses non-loopback binds and unsafe token files', { reason: 'a 0644 mode is what makes the token unsafe, and NTFS has no mode bits' }, async t => {
  const h = await harness(t)
  await assert.rejects(async () => {
    const candidate = await createDeckServer({ host: '0.0.0.0', env: { HOME: h.dir }, port: 0, notifications: false, connectDeckd: async () => { throw Error('offline') } })
    await candidate.close()
  }, /loopback/)
  fs.chmodSync(h.tokenFile, 0o644)
  await assert.rejects(async () => {
    const candidate = await startDeckServer({ env: { HOME: h.dir }, port: 0, notifications: false })
    await candidate.close()
  }, /private|0600/)
})
test('server refuses a token path that is a symlink to a private token file', async t => {
  const h = await harness(t)
  const target = path.join(h.dir, 'elsewhere-token')
  fs.writeFileSync(target, 'b'.repeat(43), { mode: 0o600 })
  fs.rmSync(h.tokenFile)
  try { fs.symlinkSync(target, h.tokenFile) } catch (error) {
    // Windows lets only an administrator or Developer Mode create a symlink.
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('creating a symlink needs Developer Mode or an administrator on Windows')
    throw error
  }
  await assert.rejects(async () => {
    const candidate = await startDeckServer({ env: { HOME: h.dir }, port: 0, notifications: false, connectDeckd: async () => { throw Error('offline') } })
    await candidate.close()
  }, /private 0600 file/)
})
test('a binary frame sent before hello closes the socket with 4400', async t => {
  const h = await harness(t, { helloTimeoutMs: 5000 })
  const ws = h.ws()
  await once(ws, 'open')
  const closing = once(ws, 'close')
  ws.send(Buffer.from([2, 3, 0x61, 0x62, 0x63, 0x78]))
  const [code, reason] = await closing
  assert.equal(code, 4400)
  // 'Bad hello' is the frame's refusal; the hello timeout would close with 'Missing hello'.
  assert.equal(reason.toString(), 'Bad hello')
})
test('a term.attach from a socket opened with a wrong token is never processed: the upgrade is 401', async t => {
  // A connected deckd link that records every request, so a processed attach would show up as one.
  const requests = []
  const deckdClient = { proto: 2, deckdVersion: '9.9.9', bootId: 'boot', on: () => () => {}, seqOf: () => undefined, close() {},
    request: async op => { requests.push(op)
      return op === 'list' ? { ptys: [] } : op === 'exits' ? { exits: [] } : {} } }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-home-'))
  const runtimeDir = path.join(home, 'run')
  fs.mkdirSync(runtimeDir, { mode: 0o700 })
  const tokenFile = setupPaths({ HOME: home, XDG_RUNTIME_DIR: runtimeDir }).token
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(tokenFile, token, { mode: 0o600 })
  t.after(() => rmDir(home))
  const h = await harness(t, { env: { HOME: home, XDG_RUNTIME_DIR: runtimeDir }, connectDeckd: async () => deckdClient, helloTimeoutMs: 5000 })
  assert.equal(h.deck.link.connected, true)
  const client = h.ws({}, ['deck.v1', 'deck.auth.wrong'])
  const opened = once(client, 'open').then(() => {
    client.send(JSON.stringify({ t: 'hello', apiVersion: 1, epoch: null, lastSeq: 0 }))
    client.send(JSON.stringify({ t: 'term.attach', sessionId: 'abc', cols: 80, rows: 24 }))
    return { statusCode: 101, resume() {} }
  })
  const response = await Promise.race([once(client, 'unexpected-response').then(([, res]) => res), opened])
  response.resume()
  assert.equal(response.statusCode, 401)
  // The same message on a socket with the right token does reach the bridge, which answers it.
  const good = h.ws()
  await once(good, 'open')
  const replies = []
  good.on('message', data => replies.push(JSON.parse(data.toString())))
  const closed = once(good, 'close').then(([code]) => { throw Error(`socket closed ${code}`) })
  const next = () => Promise.race([once(good, 'message'), closed])
  good.send(JSON.stringify({ t: 'hello', apiVersion: 1, epoch: null, lastSeq: 0 }))
  while (!replies.some(m => m.t === 'snapshot')) await next()
  good.send(JSON.stringify({ t: 'term.attach', sessionId: 'abc', cols: 80, rows: 24 }))
  while (!replies.some(m => m.t === 'term.error')) await next()
  assert.equal(replies.find(m => m.t === 'term.error').error.code, 'not_found')
  assert.deepEqual(requests.filter(op => op !== 'list' && op !== 'exits'), [])
})
