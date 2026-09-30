import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import http from 'node:http'
import { once } from 'node:events'
import { createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { startDeckServer } from '../../server/main.mjs'
const token = 'a'.repeat(43)
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))
async function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'))
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  fs.writeFileSync(path.join(staticDir, 'app.js'), 'export const deck = true')
  const opts = { env, port: 0, staticDir, notifications: false, connectDeckd: async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }), ...options }
  let deck = await startDeckServer(opts)
  const request = async (route, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${deck.address().port}${route}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${deck.address().port}`, 'Content-Type': 'application/json', ...init.headers }
    })
    return { status: response.status, headers: response.headers, data: await response.json() }
  }
  const send = (event, at, extra = {}) => {
    deck.ingest.receive(JSON.stringify({ v: 1, hookTs: at, ptyId: null, claudePid: null, pidChain: [], truncated: false,
      hook: { ...fixture, cwd: dir, hook_event_name: event, ...extra } }))
    deck.ingest.flush()
  }
  t.after(async () => { await deck.close()
    fs.rmSync(dir, { recursive: true, force: true }) })
  return { get deck() { return deck }, dir, env, state, request, send, opts,
    async restart() { await deck.close()
      deck = await startDeckServer(opts) } }
}
function socket(h, hello = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.deck.address().port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { origin: `http://127.0.0.1:${h.deck.address().port}` })
  const messages = []
  ws.on('message', raw => messages.push(JSON.parse(raw)))
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', apiVersion: 1, lastSeq: 0, epoch: null, ...hello })))
  return { ws, messages }
}
async function waitFor(fn) {
  const until = Date.now() + 4000
  while (!fn()) { assert.ok(Date.now() < until, 'timed out')
    await new Promise(resolve => setTimeout(resolve, 10)) }
}
test('static assets, history fallback, identity proof and security headers', async t => {
  const h = await harness(t)
  const base = `http://127.0.0.1:${h.deck.address().port}`
  for (const route of ['/', '/s/example', '/runs/work/subrun']) {
    const response = await fetch(base + route)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '<h1>Test deck</h1>')
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
    assert.equal(response.headers.get('content-security-policy').split(';').map(value => value.trim()).find(value => value.startsWith('script-src')), "script-src 'self'")
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  }
  assert.equal(await (await fetch(base + '/app.js')).text(), 'export const deck = true')
  const nonce = 'b'.repeat(32)
  const proof = await (await fetch(`${base}/.well-known/fleetmates-deck/identity?nonce=${nonce}`)).json()
  assert.deepEqual(proof, { nonce, mac: createHmac('sha256', token).update(`fleetmates-deck-open:${h.deck.address().port}:${nonce}`).digest('hex') })
  assert.equal((await h.request('/api/missing')).status, 404)
})
test('canonical session and request reads, filters, steps, review, dismiss and history', async t => {
  const h = await harness(t)
  h.send('SessionStart', 1000)
  h.send('PermissionRequest', 2000, { tool_name: 'Bash', tool_input: { command: 'pwd' } })
  const session = h.deck.projector.snapshot().sessions[0]
  const listed = (await h.request('/api/sessions?state=needs_approval&active=1')).data.sessions
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, session.id)
  assert.equal((await h.request('/api/sessions?state=done')).data.sessions.length, 0)
  const detail = (await h.request(`/api/sessions/${session.id}`)).data
  assert.equal(detail.session.claudeSessionId, fixture.session_id)
  assert.equal(detail.requests.length, 1)
  assert.equal((await h.request('/api/requests')).data.requests.length, 1)
  assert.equal((await h.request('/api/requests?sessionId=missing')).data.requests.length, 0)
  assert.equal((await h.request(`/api/sessions/${session.id}/mark-reviewed`, { method: 'POST' })).status, 409)
  h.deck.store.run('INSERT INTO session_steps(session_id,seq,at,tool_name,line,status,task_id) VALUES(?,?,?,?,?,?,?)', session.id, 1, 2000, 'Bash', 'pwd', 'ok', 'T1')
  assert.equal((await h.request(`/api/sessions/${session.id}/steps?taskId=T1&limit=1`)).data.steps[0].toolName, 'Bash')
  assert.equal((await h.request(`/api/sessions/${session.id}/steps?taskId=T2`)).data.steps.length, 0)
  h.deck.store.run('UPDATE sessions SET state=? WHERE id=?', 'done', session.id)
  assert.equal((await h.request(`/api/sessions/${session.id}/mark-reviewed`, { method: 'POST' })).data.session.state, 'reviewed')
  h.deck.projector.signal(session.id, { type: 'pid_gone' }, 5000)
  assert.equal((await h.request(`/api/sessions/${session.id}/dismiss`, { method: 'POST' })).data.session.state, 'ended')
  const history = (await h.request('/api/history')).data.summaries
  assert.equal(history[0].sessionId, session.id)
  assert.equal(history[0].outcome, 'lost')
  assert.equal((await h.request('/api/sessions?limit=invalid')).status, 422)
  assert.equal((await h.request('/api/sessions?repoKey=missing')).status, 404)
  assert.equal((await h.request('/api/requests/id/answer', { method: 'POST', body: '{}' })).status, 404)
})
test('preferences persist with config split, precedence and atomic validation', async t => {
  const h = await harness(t)
  assert.equal((await h.request('/api/prefs')).data.sources.textSize, 'default')
  assert.equal((await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ textSize: 16, lang: 'pt' }) })).data.prefs.textSize, 16)
  assert.equal(fs.statSync(path.join(h.dir, '.config/fleetmates/deck/config.json')).mode & 0o777, 0o600)
  assert.equal((await h.request('/api/prefs', { method: 'PATCH', body: '{"textSize":14,"extra":true}' })).status, 422)
  assert.equal((await h.request('/api/prefs')).data.prefs.textSize, 16)
  await h.restart()
  const prefs = (await h.request('/api/prefs')).data
  assert.equal(prefs.prefs.textSize, 16)
  assert.equal(prefs.sources.textSize, 'db')
  assert.equal(prefs.sources.lang, 'config')
  h.opts.env.DECK_LANG = 'en'
  await h.restart()
  assert.equal((await h.request('/api/prefs')).data.sources.lang, 'env')
  assert.equal((await h.request('/api/prefs', { method: 'PATCH', body: '{"lang":"pt"}' })).status, 409)
})
test('setup, health, notification and dependency routes use injected services', async t => {
  const calls = []
  let hooks = false
  const h = await harness(t, { services: {
    checks: async () => [{ id: 'hooks', state: hooks ? 'ok' : 'failed', blocking: true }],
    installHooks: async () => { hooks = true
      return { check: { id: 'hooks', state: 'ok' }, backupPath: null } },
    startDependency: async dep => { calls.push(dep)
      return { dep, state: 'ok' } },
    retryDependency: async dep => ({ dep, state: 'checking' }),
    notify: async () => { calls.push('notify')
      return { ok: true, via: 'notify-send' } },
    disk: async cwd => ({ cwd, mounts: [] }),
    rescan: async () => ({ found: 0 })
  } })
  assert.equal((await h.request('/api/version')).data.apiVersion, 1)
  assert.equal((await h.request('/api/setup/complete', { method: 'POST' })).status, 409)
  const check = await h.request('/api/setup/checks')
  assert.equal(check.data.checks[0].state, 'checking')
  assert.equal((await h.request('/api/setup/hooks', { method: 'POST' })).data.check.state, 'ok')
  assert.equal((await h.request('/api/setup/complete', { method: 'POST' })).data.firstRunCompletedAt > 0, true)
  assert.equal((await h.request('/api/deps/deckd/start', { method: 'POST' })).status, 202)
  assert.equal((await h.request('/api/deps/vault-mcp/retry', { method: 'POST' })).status, 202)
  assert.equal((await h.request('/api/deps/unknown/start', { method: 'POST' })).status, 404)
  assert.equal((await h.request('/api/notify/test', { method: 'POST' })).data.via, 'notify-send')
  assert.deepEqual(calls, ['deckd', 'notify'])
  assert.equal((await h.request('/api/health')).data.deps.find(dep => dep.dep === 'deckd').state, 'down')
  assert.equal((await h.request('/api/repos/rescan', { method: 'POST' })).status, 202)
  h.send('SessionStart', 1000)
  assert.equal((await h.request(`/api/sessions/${h.deck.projector.snapshot().sessions[0].id}/disk`)).data.cwd, h.dir)
})
test('run reader resolves encoded repo keys, repoId alias and nested run ids read-only', async t => {
  const run = { repoId: '/repo', runId: '2026/subrun', leadSessionId: null, tasks: [{ state: 'working' }] }
  const h = await harness(t, { runReader: { list: async () => [run], close() {} } })
  h.deck.store.run('INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES(?,?,?,?,?)', '/repo', 'work/api', 0, 'seed', 1)
  assert.equal((await h.request('/api/repos')).data.repos[0].repoKey, 'work/api')
  assert.deepEqual((await h.request('/api/runs?repoKey=work%2Fapi&active=1')).data.runs, [run])
  assert.deepEqual((await h.request('/api/runs/work%2Fapi/2026%2Fsubrun')).data.run, run)
  assert.deepEqual((await h.request('/api/runs/old/2026%2Fsubrun?repoId=%2Frepo')).data.run, run)
  assert.equal((await h.request('/api/runs/work%2Fapi/missing')).status, 404)
})
test('WebSocket snapshot, durable replay, window expiry, epoch mismatch and heartbeat', async t => {
  let clock = 1000
  const h = await harness(t, { now: () => clock, heartbeatMs: 20 })
  h.send('SessionStart', 1000)
  const first = socket(h)
  t.after(() => first.ws.terminate())
  await waitFor(() => first.messages.some(message => message.t === 'snapshot'))
  assert.equal(first.ws.protocol, 'deck.v1')
  const snap = first.messages.find(message => message.t === 'snapshot')
  assert.equal(snap.data.sessions.length, 1)
  for (const key of ['counts', 'order', 'recap', 'repos', 'runs', 'health', 'prefs', 'setup']) assert.ok(key in snap.data, key)
  h.send('PermissionRequest', 2000, { tool_name: 'Bash', tool_input: { command: 'pwd' } })
  await waitFor(() => first.messages.some(message => message.t === 'request.opened'))
  const second = socket(h, { lastSeq: snap.seq, epoch: snap.epoch })
  t.after(() => second.ws.terminate())
  await waitFor(() => second.messages.some(message => message.t === 'replay.end'))
  assert.ok(second.messages.some(message => message.t === 'request.opened' && message.seq > snap.seq))
  assert.equal(second.messages.some(message => message.t === 'snapshot'), false)
  await waitFor(() => second.messages.some(message => message.t === 'hb'))
  for (const hello of [{ lastSeq: snap.seq, epoch: 'other' }, { lastSeq: snap.seq, epoch: snap.epoch, expired: true }]) {
    if (hello.expired) clock = 1_000_000
    const client = socket(h, hello)
    t.after(() => client.ws.terminate())
    await waitFor(() => client.messages.some(message => message.t === 'snapshot'))
  }
})
test('spool, live hook socket and SQLite survive restart while deckd is offline', async t => {
  const h = await harness(t)
  const sock = net.connect(path.join(h.env.XDG_RUNTIME_DIR, 'fleetmates-deck/hooks.sock'))
  await once(sock, 'connect')
  sock.end(JSON.stringify({ v: 1, hookTs: 1000, ptyId: null, claudePid: null, pidChain: [], truncated: false, hook: { ...fixture, cwd: h.dir } }) + '\n')
  await once(sock, 'close')
  await waitFor(() => h.deck.projector.snapshot().sessions.length === 1)
  h.send('SessionEnd', 2000, { reason: 'prompt_input_exit' })
  const oldEpoch = h.deck.epoch
  fs.mkdirSync(path.join(h.state, 'spool'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(h.state, 'spool/hooks-20260930-1790000000000-abcdefabcdef.jsonl'), JSON.stringify({ v: 1, hookTs: 3000, ptyId: null, claudePid: null, pidChain: [], truncated: false, hook: { ...fixture, cwd: h.dir, session_id: 'other-session' } }) + '\n', { mode: 0o600 })
  await h.restart()
  assert.equal(h.deck.epoch, oldEpoch)
  assert.equal((await h.request('/api/history')).data.summaries.length, 1)
  assert.equal((await h.request('/api/sessions')).data.sessions.length, 2)
})
test('deckd reconnect reconciles exits without losing persisted history', async t => {
  const listeners = new Map()
  let available = false
  let closed = false
  const client = { request: async op => op === 'list' ? { ptys: [] } : op === 'exits' ? { exits: [{ ptyId: 'pty_fake', code: 0, signal: null, at: 3000 }] } : {},
    on(ev, fn) { listeners.set(ev, fn)
      return () => listeners.delete(ev) }, close() { closed = true } }
  const h = await harness(t, { reconnectMs: 20, connectDeckd: async () => { if (!available) throw Error('offline')
    return client } })
  h.send('SessionStart', 1000)
  const id = h.deck.projector.snapshot().sessions[0].id
  h.deck.store.run('UPDATE sessions SET origin=?,pty_id=? WHERE id=?', 'wrapped', 'pty_fake', id)
  available = true
  await waitFor(() => h.deck.projector.snapshot().sessions[0].state === 'ended')
  assert.equal((await h.request('/api/history')).data.summaries[0].sessionId, id)
  available = false
  listeners.get('close')?.()
  await waitFor(() => closed)
  assert.equal((await h.request('/api/history')).status, 200)
})
test('live deckd PTYs are restored and spawned events retain one canonical session', async t => {
  const listeners = new Map()
  const pty = { ptyId: 'pty_live', cwd: '/tmp', origin: 'wrapped', startedAt: 1000, pid: 123, argv: ['claude'] }
  const client = { request: async op => op === 'list' ? { ptys: [pty] } : op === 'exits' ? { exits: [] } : {},
    on(ev, fn) { listeners.set(ev, fn)
      return () => listeners.delete(ev) }, close() {} }
  const h = await harness(t, { connectDeckd: async () => client })
  const restored = (await h.request('/api/sessions')).data.sessions
  assert.equal(restored.length, 1)
  assert.equal(restored[0].ptyId, pty.ptyId)
  listeners.get('spawned')?.(pty)
  assert.equal((await h.request('/api/sessions')).data.sessions.length, 1)
  listeners.get('input')?.({ ptyId: pty.ptyId, at: 2000, source: { kind: 'terminal', name: 'fake-terminal' } })
  assert.equal((await h.request(`/api/sessions/${restored[0].id}`)).data.session.lastInputName, 'fake-terminal')
})
test('default repo rescan updates run discovery without mutating fixture runs', async t => {
  const h = await harness(t)
  const root = path.join(h.dir, 'repos')
  const repo = path.join(root, 'repo')
  const runDir = path.join(repo, '.fleetmates/nested/run')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  const plan = JSON.stringify({ runId: 'nested/run', tasks: [], totalPhases: 1 })
  const status = JSON.stringify({ tasks: [] })
  fs.writeFileSync(path.join(runDir, 'plan.json'), plan)
  fs.writeFileSync(path.join(runDir, 'status.json'), status)
  await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ scanRoot: root }) })
  assert.equal((await h.request('/api/repos/rescan', { method: 'POST' })).data.found, 1)
  const runs = (await h.request('/api/runs')).data.runs
  assert.equal(runs.length, 1)
  assert.equal(runs[0].runId, 'nested/run')
  assert.equal(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'), plan)
  assert.equal(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'), status)
})
test('snapshot queues events committed during an asynchronous run read', async t => {
  let release
  let waiting = false
  const h = await harness(t, { runReader: { list: () => new Promise(resolve => { waiting = true
    release = () => resolve([]) }), close() {} } })
  const client = socket(h)
  t.after(() => client.ws.terminate())
  await waitFor(() => waiting)
  h.send('SessionStart', 1000)
  release()
  await waitFor(() => client.messages.some(message => message.t === 'session.upserted'))
  const snapIndex = client.messages.findIndex(message => message.t === 'snapshot')
  const updateIndex = client.messages.findIndex(message => message.t === 'session.upserted')
  assert.ok(snapIndex >= 0 && updateIndex > snapIndex)
  assert.ok(client.messages[updateIndex].seq > client.messages[snapIndex].seq)
})
test('replay falls back to snapshot beyond 5000 events and across retained sequence gaps', async t => {
  const h = await harness(t, { now: () => 1000 })
  for (let i = 0; i < 5002; i++) h.deck.store.appendEvent({ at: 1000, type: 'counts', data: {} })
  for (const seq of [1, 5000]) {
    if (seq === 5000) h.deck.store.run('DELETE FROM events WHERE seq=?', 5001)
    const client = socket(h, { lastSeq: seq, epoch: h.deck.epoch })
    t.after(() => client.ws.terminate())
    await waitFor(() => client.messages.some(message => message.t === 'snapshot'))
    assert.equal(client.messages.some(message => message.t === 'replay.begin'), false)
  }
})
test('committed event subscription supports injected notification consumers and isolates their failures', async t => {
  const h = await harness(t)
  const events = []
  const off = h.deck.subscribe(event => {
    if (event.seq !== undefined) assert.ok(h.deck.store.get('SELECT seq FROM events WHERE seq=?', event.seq))
    events.push(event)
  })
  const broken = h.deck.subscribe(() => { throw Error('fake consumer failure') })
  h.send('SessionStart', 1000)
  h.send('PermissionRequest', 2000, { tool_name: 'Bash', tool_input: { command: 'pwd' } })
  assert.ok(events.some(event => event.type === 'request.opened'))
  assert.equal((await h.request('/api/requests')).data.requests.length, 1)
  off()
  broken()
  const count = events.length
  h.send('SessionEnd', 3000, { reason: 'prompt_input_exit' })
  assert.equal(events.length, count)
})
test('built relative SPA assets resolve from nested history routes', async t => {
  const h = await harness(t)
  fs.writeFileSync(path.join(h.dir, 'web/index.html'), '<script type="module" src="./app.js"></script><link rel="stylesheet" href="./app.css">')
  fs.writeFileSync(path.join(h.dir, 'web/app.css'), 'body { color: black }')
  const base = `http://127.0.0.1:${h.deck.address().port}`
  const html = await (await fetch(base + '/runs/work/nested/run')).text()
  assert.match(html, /src="\/app.js"/)
  assert.match(html, /href="\/app.css"/)
  assert.match((await fetch(base + '/app.js')).headers.get('content-type'), /javascript/)
})
test('default server process delivers T7 popups, suppresses recording bells and resumes normal bells', { timeout: 15_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'))
  const runtime = path.join(dir, 'r')
  const state = path.join(dir, '.local/state/fleetmates/deck')
  const bin = path.join(dir, 'bin')
  for (const target of [runtime, state, bin]) fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const log = path.join(dir, 'commands.jsonl')
  for (const name of ['notify-send', 'pw-play', 'makoctl', 'systemctl', 'claude']) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
import fs from 'node:fs'
import path from 'node:path'
for await (const chunk of process.stdin) {}
fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify({ command: path.basename(process.argv[1]), args: process.argv.slice(2) }) + '\\n')
process.stdout.write('42\\n')
`, { mode: 0o700 })
  let recording = true
  let probes = 0
  const scribed = net.createServer(sock => {
    sock.on('data', raw => {
      assert.deepEqual(JSON.parse(raw), { cmd: 'status' })
      probes++
      sock.end(JSON.stringify({ type: 'status', recording, session_id: null, tag: null, elapsed_s: 0, routed_apps: [] }) + '\n')
    })
  })
  await new Promise(resolve => scribed.listen(path.join(runtime, 'turbidassist.sock'), resolve))
  const reservation = http.createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const child = spawn(process.execPath, [new URL('../../server/main.mjs', import.meta.url).pathname], {
    env: { HOME: dir, XDG_RUNTIME_DIR: runtime, DECK_PORT: String(port), PATH: bin, SHIM_LOG: log }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let diagnostics = ''
  child.stdout.on('data', chunk => { diagnostics += chunk })
  child.stderr.on('data', chunk => { diagnostics += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closing = once(child, 'close')
      child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000)
      await closing
      clearTimeout(timeout)
    }
    await new Promise(resolve => scribed.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const headers = { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }
  let ready = false
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`, { headers })).ok } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(ready, true, diagnostics)
  const commands = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const send = async id => {
    const socket = net.connect(path.join(runtime, 'fleetmates-deck/hooks.sock'))
    await once(socket, 'connect')
    const at = Date.now() - 3100
    const envelope = event => ({ v: 1, hookTs: at, ptyId: null, claudePid: null, pidChain: [], truncated: false, hook: { ...fixture, cwd: dir, session_id: id, hook_event_name: event, ...(event === 'PermissionRequest' ? { tool_name: 'Bash', tool_input: { command: 'pwd' } } : {}) } })
    socket.end(['SessionStart', 'PermissionRequest'].map(event => JSON.stringify(envelope(event))).join('\n') + '\n')
    await once(socket, 'close')
  }
  await send('recording-session')
  await waitFor(() => commands().some(row => row.command === 'notify-send'))
  assert.ok(probes > 0)
  assert.equal(commands().filter(row => row.command === 'pw-play').length, 0)
  recording = false
  const count = probes
  await waitFor(() => probes > count)
  await send('normal-session')
  await waitFor(() => commands().some(row => row.command === 'pw-play'))
  assert.equal(commands().filter(row => row.command === 'notify-send').length, 2)
  assert.equal(commands().filter(row => row.command === 'pw-play').length, 1)
  const ping = await fetch(`http://127.0.0.1:${port}/api/notify/test`, { method: 'POST', headers, body: '{}' })
  assert.equal(ping.status, 200)
  assert.equal(commands().filter(row => row.command === 'notify-send').length, 3)
  assert.equal(diagnostics.includes(token), false)
  assert.equal(diagnostics.includes('recording-session'), false)
})
