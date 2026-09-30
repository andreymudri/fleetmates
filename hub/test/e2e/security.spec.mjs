// M1 security suite against the running deck (docs/deck/09-testing.md section 11.1, 08-security.md
// section 4): DNS rebinding, drive-by pages, tokens on every route, binding, file modes, hook socket
// abuse, deckd exposure, untrusted text in the built app, approval bypass and static path traversal.
// hub/test/integration/security.test.mjs covers the per-header HTTP and WebSocket rejections in
// isolation; this suite drives the whole deck, a foreign page in Chromium, `init`, real deckd and the
// real hooks socket.
//
// Not part of `npm --prefix hub test`. Run with:
//   mkdir -p /tmp/hx/e2e && TMPDIR=/tmp/hx/e2e node --test hub/test/e2e/security.spec.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { TOKEN, buildWeb, envelopeFor, hub, launchBrowser, openDeck, startDeck, ui, until } from './observe.spec.mjs'

let web
let browser
before(async () => {
  web = await buildWeb()
  browser = await launchBrowser()
})
after(async () => {
  await browser?.close()
  await web?.cleanup()
})

/**
 * One raw HTTP/1.1 exchange, so Host, Origin and the request target reach the server exactly as written.
 * @param {number} port
 * @param {string} head request line and headers, CRLF separated, without the final blank line
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
 */
function raw(port, head) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.setEncoding('latin1')
    socket.on('data', chunk => { data += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      const [top, ...rest] = data.split('\r\n\r\n')
      const [statusLine, ...lines] = top.split('\r\n')
      const headers = Object.fromEntries(lines.map(line => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]))
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body: rest.join('\r\n\r\n') })
    })
    socket.write(`${head}\r\nConnection: close\r\n\r\n`)
  })
}

function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * Every (method, path) the REST router answers, read from `hub/server/http/api.mjs` with comments
 * stripped: `route === '...'` literals under their method block and the `s[1] === '...'` parameter shapes.
 * @returns {Promise<{ method: string, path: string }[]>}
 */
async function routerTable() {
  const source = (await readFile(path.join(hub, 'server/http/api.mjs'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1')
  const body = source.slice(source.indexOf('async function route('))
  const blocks = [['GET', body.indexOf("if (method === 'GET')")], ['PATCH', body.indexOf("if (method === 'PATCH'")], ['POST', body.indexOf("if (method === 'POST')")]].sort((a, b) => a[1] - b[1])
  const methodAt = index => blocks.filter(([, start]) => start >= 0 && start <= index).at(-1)?.[0]
  const routes = []
  for (const match of body.matchAll(/route === '([^']+)'/g)) routes.push({ method: methodAt(match.index), path: `/api/${match[1]}` })
  for (const match of body.matchAll(/s\[1\] === '(\w+)' && s\.length === (\d)(?: && (?:s\[3\] === '([\w-]+)'|\['([^\]]+)'\]\.includes\(s\[3\]\)))?/g)) {
    const [, resource, length, one, many] = match
    const tails = Number(length) === 3 ? [''] : one ? [one] : many ? many.split(/'\s*,\s*'/).map(item => item.replace(/'/g, '')) : ['x']
    for (const tail of tails) routes.push({ method: methodAt(match.index), path: `/api/${resource}/x${Number(length) === 4 ? `/${tail}` : ''}` })
  }
  return routes
}

test('DNS rebinding: foreign, suffixed, missing and IPv6 Host headers are refused; 127.0.0.1 passes and localhost is redirected', async t => {
  const h = await startDeck(t, { web: web.dir })
  const auth = `Authorization: Bearer ${TOKEN}`
  for (const target of ['/api/version', '/']) {
    for (const host of [`evil.example:${h.port}`, `127.0.0.1.nip.io:${h.port}`, `[::1]:${h.port}`, `127.0.0.1:${h.port + 1}`]) {
      const response = await raw(h.port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${auth}`)
      assert.equal(response.status, 403, `${target} with Host ${host}`)
      assert.doesNotMatch(response.body, /apiVersion|<script/, 'a refused request carries no deck content')
    }
    const missing = await raw(h.port, `GET ${target} HTTP/1.0\r\n${auth}`)
    assert.equal(missing.status, 403, `${target} without Host`)
    const redirect = await raw(h.port, `GET ${target} HTTP/1.1\r\nHost: localhost:${h.port}\r\n${auth}`)
    assert.equal(redirect.status, 421, `${target} with Host localhost`)
    assert.equal(redirect.headers.location, `http://127.0.0.1:${h.port}/`)
    const good = await raw(h.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\n${auth}`)
    assert.equal(good.status, 200, `${target} with the canonical Host`)
  }
})

test('drive-by page: a foreign origin in Chromium can neither write with a stolen token nor open the WebSocket', async t => {
  const h = await startDeck(t, { web: web.dir })
  const evil = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><title>evil</title><p>evil</p>')
  })
  await new Promise(resolve => evil.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => evil.close(resolve)))
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${evil.address().port}/`)
  const before = (await request(h.port, '/api/prefs', { headers: { Authorization: `Bearer ${TOKEN}` } })).body
  const outcome = await page.evaluate(async ({ base, token }) => {
    const write = await fetch(`${base}/api/prefs`, { method: 'PATCH', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ bell: false }) }).then(() => 'sent', error => String(error))
    const simple = await fetch(`${base}/api/repos/rescan`, { method: 'POST', mode: 'no-cors' }).then(() => 'sent', error => String(error))
    const socket = await new Promise(resolve => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws`, ['deck.v1', `deck.auth.${token}`])
      ws.onopen = () => resolve('open')
      ws.onclose = event => resolve(`close ${event.code}`)
    })
    return { write, simple, socket }
  }, { base: h.base, token: TOKEN })
  assert.notEqual(outcome.socket, 'open', 'the foreign page never gets a WebSocket')
  const afterPrefs = (await request(h.port, '/api/prefs', { headers: { Authorization: `Bearer ${TOKEN}` } })).body
  assert.equal(afterPrefs, before, 'the foreign page changed no preference')
  for (const origin of ['http://evil.example', 'null']) {
    const response = await request(h.port, '/api/prefs', { method: 'PATCH', headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin, 'Content-Type': 'application/json' }, body: '{"bell":false}' })
    assert.equal(response.status, 403, `PATCH with Origin ${origin} and a valid token`)
    assert.equal(JSON.parse(response.body).error.code, 'forbidden_origin')
  }
  for (const origin of ['http://evil.example', 'null', undefined]) {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/ws`, ['deck.v1', `deck.auth.${TOKEN}`], { headers: origin === undefined ? {} : { Origin: origin } })
    ws.on('error', () => {})
    const [, response] = await once(ws, 'unexpected-response')
    assert.equal(response.statusCode, 403, `WebSocket upgrade with Origin ${origin ?? '(none)'}`)
    response.resume()
  }
})

test('tokens: every route in the router table answers 401 without the token and with a wrong one, and the WebSocket refuses both', async t => {
  const h = await startDeck(t, { web: web.dir })
  const routes = await routerTable()
  assert.ok(routes.length >= 20, `the router table was read from api.mjs: ${routes.length} routes`)
  t.diagnostic(`routes: ${routes.map(route => `${route.method} ${route.path}`).join(', ')}`)
  const origin = `http://127.0.0.1:${h.port}`
  for (const route of routes) {
    for (const [name, authorization] of [['no token', undefined], ['wrong token', `Bearer ${'b'.repeat(43)}`], ['token in the query', undefined]]) {
      const target = name === 'token in the query' ? `${route.path}?token=${TOKEN}` : route.path
      const headers = { Origin: origin, ...(authorization ? { Authorization: authorization } : {}), ...(route.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) }
      const response = await request(h.port, target, { method: route.method, headers, body: route.method === 'GET' ? undefined : '{}' })
      assert.equal(response.status, 401, `${route.method} ${target} with ${name}`)
      assert.deepEqual(Object.keys(JSON.parse(response.body).error).sort(), ['code', 'message', 'retryable'], 'the refusal carries only the code')
    }
    const authorized = await request(h.port, route.path, { method: route.method, headers: { Origin: origin, Authorization: `Bearer ${TOKEN}`, ...(route.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) }, body: route.method === 'GET' ? undefined : '{}' })
    assert.notEqual(authorized.status, 401, `${route.method} ${route.path} is a real route that the right token reaches`)
  }
  for (const protocols of [['deck.v1'], ['deck.v1', `deck.auth.${'b'.repeat(43)}`]]) {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/ws`, protocols, { headers: { Origin: origin } })
    ws.on('error', () => {})
    const [, response] = await once(ws, 'unexpected-response')
    assert.equal(response.statusCode, 401)
    response.resume()
  }
})

test('binding: the deck listens on 127.0.0.1 only and refuses any other address', async t => {
  const h = await startDeck(t, { web: web.dir })
  assert.equal(h.deck.address().address, '127.0.0.1')
  const { createDeckServer } = await import('../../server/main.mjs')
  for (const host of ['0.0.0.0', '::', '::1', 'localhost']) {
    await assert.rejects(createDeckServer({ host, env: h.env, port: 0, notifications: false, connectDeckd: async () => { throw Error('offline') } }), /loopback/, host)
  }
})

test('file modes: after init and a first run the token, config, state, runtime directories and both sockets are private', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-modes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  await mkdir(bin)
  for (const name of ['systemctl', 'claude', 'notify-send', 'xdg-open']) {
    await writeFile(path.join(bin, name), `#!/bin/sh\nif [ '${name}' = claude ]; then echo '${ui.claudeCodeVersion} (Claude Code)'; fi\nif [ '${name}' = systemctl ] && [ "$2" = is-active ]; then exit 3; fi\nexit 0\n`, { mode: 0o700 })
  }
  const env = { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), XDG_DATA_HOME: path.join(root, 'data'), XDG_RUNTIME_DIR: path.join(root, 'run') }
  await mkdir(path.join(env.HOME, '.claude'), { recursive: true })
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const init = spawnSync(process.execPath, [path.join(hub, 'bin/fleetmates-deck.mjs'), 'init'], { env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000 })
  assert.equal(init.status, 0, init.stderr)
  const deckd = spawn(process.execPath, [path.join(hub, 'deckd/main.mjs')], { env: { ...env, PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe'] })
  t.after(() => { if (deckd.exitCode === null) deckd.kill('SIGTERM') })
  await until(async () => stat(path.join(env.XDG_RUNTIME_DIR, 'fleetmates-deck/deckd.sock')).then(() => true, () => false), { message: 'deckd socket' })
  const { startDeckServer } = await import('../../server/main.mjs')
  const deck = await startDeckServer({ env, port: 0, staticDir: web.dir, notifications: false })
  t.after(() => deck.close())
  const port = deck.address().port
  const patch = await request(port, '/api/prefs', { method: 'PATCH', headers: { Authorization: `Bearer ${(await readFile(path.join(env.XDG_STATE_HOME, 'fleetmates/deck/token'), 'utf8')).trim()}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body: '{"scanRoot":"~/code"}' })
  assert.equal(patch.status, 200)
  const mode = async file => ((await stat(file)).mode & 0o777).toString(8)
  const expected = {
    [path.join(env.XDG_STATE_HOME, 'fleetmates/deck/token')]: '600',
    [path.join(env.XDG_CONFIG_HOME, 'fleetmates/deck/config.json')]: '600',
    [path.join(env.XDG_CONFIG_HOME, 'fleetmates/deck')]: '700',
    [path.join(env.XDG_STATE_HOME, 'fleetmates/deck')]: '700',
    [path.join(env.XDG_STATE_HOME, 'fleetmates/deck/spool')]: '700',
    [path.join(env.XDG_DATA_HOME, 'fleetmates-deck')]: '700',
    [path.join(env.XDG_DATA_HOME, 'fleetmates-deck/hook/deck-hook.mjs')]: '600',
    [path.join(env.XDG_RUNTIME_DIR, 'fleetmates-deck')]: '700',
    [path.join(env.XDG_RUNTIME_DIR, 'fleetmates-deck/hooks.sock')]: '600',
    [path.join(env.XDG_RUNTIME_DIR, 'fleetmates-deck/deckd.sock')]: '600'
  }
  const actual = {}
  for (const file of Object.keys(expected)) actual[file] = await mode(file)
  assert.deepEqual(actual, expected)
})

test('hook socket abuse: non-JSON, a 5 MiB line, invalid UTF-8 and 10,000 connections leave the server up and ingest nothing', async t => {
  const h = await startDeck(t, { web: web.dir })
  const write = data => new Promise((resolve, reject) => {
    const socket = net.connect(h.hooksSocket)
    socket.on('error', error => error.code === 'EPIPE' || error.code === 'ECONNRESET' ? resolve() : reject(error))
    socket.once('connect', () => socket.end(data, resolve))
    socket.on('close', resolve)
  })
  await write('not json\n{"v":1\n[]\n')
  await write(Buffer.concat([Buffer.from('{"v":1,"hook":"'), Buffer.alloc(5 * 1024 * 1024, 0x61), Buffer.from('"}\n')]))
  await write(Buffer.from([0x7b, 0xff, 0xfe, 0xc3, 0x28, 0x7d, 0x0a]))
  for (let batch = 0; batch < 50; batch++) {
    await Promise.all(Array.from({ length: 200 }, () => new Promise(resolve => {
      const socket = net.connect(h.hooksSocket)
      socket.on('error', resolve)
      socket.once('connect', () => socket.end(resolve))
    })))
  }
  assert.equal(h.deck.store.get('SELECT COUNT(*) AS n FROM hook_events').n, 0, 'nothing was ingested')
  assert.equal(h.deck.store.get('SELECT COUNT(*) AS n FROM sessions').n, 0)
  const rejected = h.deck.store.all('SELECT reason, LENGTH(raw) AS size FROM rejected_events')
  assert.ok(rejected.length >= 4, `the bad input is recorded as rejected: ${JSON.stringify(rejected.map(row => row.reason))}`)
  assert.ok(rejected.every(row => row.size === 0), 'no rejected hook content is stored')
  assert.equal((await request(h.port, '/api/version', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200, 'the server is still up')
  await h.hook('survivor', { e: 'SessionStart' })
  assert.equal(h.deck.store.get('SELECT COUNT(*) AS n FROM sessions').n, 1, 'a valid hook after the abuse still lands')
})

test('deckd exposure: deckd has no TCP socket, only its Unix socket', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-deckd-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'r'), { mode: 0o700 })
  const deckd = spawn(process.execPath, [path.join(hub, 'deckd/main.mjs')], { env: { PATH: process.env.PATH, HOME: root, XDG_RUNTIME_DIR: path.join(root, 'r') }, stdio: ['ignore', 'ignore', 'pipe'] })
  t.after(() => { if (deckd.exitCode === null) deckd.kill('SIGTERM') })
  await until(async () => stat(path.join(root, 'r/fleetmates-deck/deckd.sock')).then(() => true, () => false), { message: 'deckd socket' })
  const inodes = new Set()
  for (const fd of await readdir(`/proc/${deckd.pid}/fd`)) {
    const target = await readlink(`/proc/${deckd.pid}/fd/${fd}`).catch(() => '')
    const match = /^socket:\[(\d+)\]$/.exec(target)
    if (match) inodes.add(match[1])
  }
  assert.ok(inodes.size > 0, 'deckd holds at least its listening socket')
  const tcp = []
  for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
    const text = await readFile(`/proc/${deckd.pid}/net/${table}`, 'utf8').catch(() => '')
    for (const line of text.trim().split('\n').slice(1)) {
      const inode = line.trim().split(/\s+/)[9]
      if (inodes.has(inode)) tcp.push(`${table}: ${line.trim()}`)
    }
  }
  assert.deepEqual(tcp, [], 'none of deckd\'s sockets is an IP socket')
  const unix = await readFile(`/proc/${deckd.pid}/net/unix`, 'utf8')
  assert.ok(unix.split('\n').some(line => line.trim().endsWith('deckd.sock') && inodes.has(line.trim().split(/\s+/)[6])), 'its listener is the Unix socket')
})

test('untrusted text: qa 1.7 payloads in every text field render literally on Home, drawer, palette and Focus', async t => {
  const h = await startDeck(t, { web: web.dir })
  const now = Date.now()
  const envelopes = []
  ui.xss.forEach((payload, index) => {
    const session = { key: `x${index}`, fixture: 'xss', repo: `repo-${index}-${payload.replace(/\//g, '')}` }
    envelopes.push(
      envelopeFor(session, { e: 'SessionStart', ago: 600 }, now),
      envelopeFor(session, { e: 'UserPromptSubmit', ago: 500, prompt: payload }, now),
      envelopeFor(session, { e: index % 2 ? 'PreToolUse' : 'PermissionRequest', ago: 100 + index, tool_name: index % 2 ? 'AskUserQuestion' : 'Bash',
        tool_input: index % 2 ? { questions: [{ question: payload, header: payload, options: [{ label: payload, description: payload }], multiSelect: false }] } : { command: payload, description: payload } }, now))
  })
  await h.send(envelopes)
  const ids = h.deck.store.all("SELECT id FROM sessions WHERE claude_session_id LIKE 'fx-xss-%'").map(row => row.id)
  assert.equal(ids.length, ui.xss.length)
  const page = await openDeck(browser, h)
  const scripts = await page.$$eval('script', rows => rows.map(row => row.outerHTML))
  const check = async where => {
    const found = await page.evaluate(() => ({
      img: document.querySelectorAll('img').length,
      scripts: [...document.querySelectorAll('script')].map(row => row.outerHTML),
      javascript: document.querySelectorAll('a[href^="javascript:" i], [href^="javascript:" i]').length,
      handlers: [...document.querySelectorAll('*')].filter(el => [...el.attributes].some(attr => /^on/i.test(attr.name))).length,
      text: document.body.innerText,
      hidden: /[\u001b\u0007‮]/.test(document.body.textContent)
    }))
    assert.equal(found.img, 0, `${where}: no img element`)
    assert.deepEqual(found.scripts, scripts, `${where}: no new script element`)
    assert.equal(found.javascript, 0, `${where}: no javascript: link`)
    assert.equal(found.handlers, 0, `${where}: no inline event handler attribute`)
    assert.equal(found.hidden, false, `${where}: escape, bell and bidi controls never reach the DOM text raw`)
    return found.text
  }
  const home = await check('Home')
  for (const payload of ['<img src=x onerror=alert(1)>', '<script>alert(2)</script>']) assert.ok(home.includes(payload), `Home shows ${payload} literally`)
  assert.ok(home.includes('evil<U+202E>txt.exe'), 'the bidi override is a visible token')
  await page.keyboard.press('Alt+KeyU')
  await page.waitForSelector('.drawer')
  assert.ok((await check('drawer')).includes('<img src=x onerror=alert(1)>'))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Alt+KeyK')
  await page.waitForSelector('.palette-input')
  assert.ok((await check('palette')).includes('<a href="javascript:alert(3)">click</a>'))
  await page.keyboard.press('Escape')
  for (const id of ids) {
    await page.goto(`${h.base}/s/${id}?tab=facts`)
    await page.waitForSelector('#focus-title')
    await page.waitForSelector('.focus-steps, .focus-log-empty')
    await check(`Focus ${h.deck.store.get('SELECT task FROM sessions WHERE id=?', id).task}`)
  }
  assert.deepEqual(page.dialogs, [], 'no dialog opened')
  assert.deepEqual(page.errors, [])
  assert.equal(new URL(page.url()).origin, h.base, 'no navigation away')
})

test('approval bypass: M1 has no answering route, and no key in the drawer or palette sends a write', async t => {
  const h = await startDeck(t, { web: web.dir })
  await h.load('busy')
  const request = h.deck.store.get('SELECT id FROM requests WHERE state=? LIMIT 1', 'open').id
  // M1 POST routes take no body (422 before routing); without one the answer route does not exist (404).
  for (const [body, status] of [[undefined, 404], ['{"choice":"allow"}', 422], ['{"choice":"allow","confirm":true}', 422]]) {
    const response = await globalThis.fetch(`${h.base}/api/requests/${request}/answer`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: h.base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body })
    assert.equal(response.status, status, `answer with body ${body}`)
  }
  const page = await openDeck(browser, h)
  const writes = []
  page.on('request', row => { if (row.method() !== 'GET') writes.push(`${row.method()} ${row.url()}`) })
  await page.keyboard.press('Alt+KeyU')
  await page.waitForSelector('.drawer')
  for (const key of ['Alt+KeyA', 'Alt+Shift+KeyA', 'Space', 'Digit1', 'Enter']) await page.keyboard.press(key)
  await page.keyboard.press('Alt+KeyK')
  await page.waitForSelector('.palette-input')
  for (const key of ['Alt+Enter', 'Enter']) await page.keyboard.press(key)
  await page.waitForTimeout(300)
  assert.deepEqual(writes, [], 'no write from the drawer or palette keys')
  assert.equal(h.deck.store.get('SELECT state FROM requests WHERE id=?', request).state, 'open')
})

test('static files: traversal and encoded variants never serve a file outside the web root', async t => {
  const h = await startDeck(t, { web: web.dir })
  const secret = path.join(h.dir, 'outside-secret.txt')
  await writeFile(secret, 'SECRET-OUTSIDE-ROOT', { mode: 0o600 })
  const index = await readFile(path.join(web.dir, 'index.html'), 'utf8')
  const rel = path.relative(web.dir, secret)
  const targets = ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/..%5c..%5cetc%5cpasswd',
    `/${rel}`, `/${rel.split('/').map(part => part === '..' ? '%2e%2e' : part).join('/')}`, `/${encodeURIComponent(rel)}`]
  const statuses = {}
  for (const target of targets) {
    const response = await raw(h.port, `GET ${target} HTTP/1.0\r\nHost: 127.0.0.1:${h.port}`)
    statuses[target] = response.status
    assert.doesNotMatch(response.body, /root:x?:0:0|SECRET-OUTSIDE-ROOT/, `${target} leaks nothing`)
    // 09-testing 11.1 names 404; the SPA fallback answers client routes with index.html, which is not a leak.
    assert.ok(response.status === 404 || response.status === 200 && response.body.replace(/(src|href)="\//g, '$1="./') === index, `${target}: 404 or the SPA index (${response.status})`)
  }
  assert.ok(Object.values(statuses).includes(404), `at least the escaping variants answer 404: ${JSON.stringify(statuses)}`)
  const linked = path.join(web.dir, 'leak.txt')
  await symlink(secret, linked)
  t.after(() => rm(linked, { force: true }))
  const viaLink = await raw(h.port, `GET /leak.txt HTTP/1.0\r\nHost: 127.0.0.1:${h.port}`)
  assert.doesNotMatch(viaLink.body, /SECRET-OUTSIDE-ROOT/, 'a symlink out of the root is not followed')
  const page = await request(h.port, '/')
  assert.match(page.headers['content-security-policy'], /script-src 'self'/)
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal(page.headers['x-frame-options'], 'DENY')
})
