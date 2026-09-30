import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { startDeckServer, reconnectDelay } from '../../server/main.mjs'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector } from '../../server/machines/projector.mjs'

const token = 'a'.repeat(43)
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))

async function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1s-'))
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const deck = await startDeckServer({ env, port: 0, staticDir, notifications: false,
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }), ...options })
  t.after(async () => { await deck.close()
    fs.rmSync(dir, { recursive: true, force: true }) })
  const request = async route => {
    const base = `http://127.0.0.1:${deck.address().port}`
    const response = await fetch(base + route, { headers: { Authorization: `Bearer ${token}`, Origin: base } })
    return { status: response.status, data: await response.json() }
  }
  const send = (event, at, extra = {}) => {
    deck.ingest.receive(JSON.stringify({ v: 1, hookTs: at, ptyId: null, claudePid: null, pidChain: [], truncated: false,
      hook: { ...fixture, cwd: dir, hook_event_name: event, ...extra } }))
    deck.ingest.flush()
  }
  return { deck, dir, request, send }
}

async function waitFor(fn, ms = 4000) {
  const until = Date.now() + ms
  while (!fn()) { assert.ok(Date.now() < until, 'timed out')
    await new Promise(resolve => setTimeout(resolve, 10)) }
}

function initRepo(dir) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  execFileSync('git', ['init', '-q', dir], { env, timeout: 2000, stdio: 'ignore' })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const healthRows = deck => deck.store.all('SELECT at,data FROM events WHERE type=? ORDER BY seq', 'health.changed').map(row => ({ at: row.at, data: JSON.parse(row.data) }))

function fakeDeckd(reply = {}) {
  const listeners = new Map()
  const client = {
    request: async op => op === 'list' ? { ptys: reply.ptys ?? [] } : op === 'exits' ? { exits: reply.exits ?? [] } : {},
    on(event, fn) { listeners.set(event, fn)
      return () => listeners.delete(event) },
    close() {}
  }
  return { client, listeners }
}

test('while deckd stays unreachable each attempt publishes its own health.changed with a growing delay and a stable since', async t => {
  const attempts = []
  let available = false
  const { client, listeners } = fakeDeckd()
  const h = await harness(t, { reconnectMs: 20, random: () => 0.5, connectDeckd: async () => {
    attempts.push(Date.now())
    if (!available) throw Error('fake offline')
    return client
  } })
  await sleep(700)
  // A fixed 20 ms retry makes about 35 attempts in 700 ms; doubling from 20 ms makes about 6.
  assert.ok(attempts.length <= 8, `expected backoff, saw ${attempts.length} connect attempts`)
  const gaps = attempts.slice(1).map((at, i) => at - attempts[i])
  assert.ok(gaps.at(-1) >= 80, `the delay grows between attempts: ${gaps.join(', ')}`)
  const down = healthRows(h.deck)
  assert.ok(down.length >= 4, `one event per failed attempt, saw ${down.length}`)
  assert.deepEqual(down.map(row => row.data.attempt), down.map((_, i) => i + 1), 'the attempt advances by one per event')
  // random 0.5 is zero jitter, so each delay is exactly 20 ms * min(2^(attempt-1), 30).
  assert.deepEqual(down.map(row => row.data.nextProbeAt - row.at), down.map((_, i) => 20 * Math.min(2 ** i, 30)))
  assert.ok(down.every(row => row.data.state === 'down'))
  assert.equal(new Set(down.map(row => row.data.since)).size, 1, 'since stays put while the state stays down')
  const row = (await h.request('/api/health')).data.deps.find(entry => entry.dep === 'deckd')
  assert.equal(row.state, 'down')
  assert.equal(row.since, down[0].data.since, 'the snapshot keeps the since of the first failure')
  assert.equal(row.attempt, attempts.length, 'the snapshot still reports the current attempt')
  assert.ok(row.nextProbeAt >= attempts.at(-1), 'and when the next attempt is due')

  available = true
  await waitFor(() => healthRows(h.deck).at(-1).data.state === 'ok')
  assert.equal(healthRows(h.deck).at(-1).data.attempt, 0, 'a successful connect resets the attempt count')
  available = false
  const before = healthRows(h.deck).length
  listeners.get('close')?.()
  const dropped = healthRows(h.deck)[before]
  assert.equal(dropped.data.state, 'down')
  assert.equal(dropped.data.attempt, 1, 'a live link that drops reports attempt 1')
  assert.equal(dropped.data.nextProbeAt - dropped.at, 20, 'and the first retry is one unit away')
})

test('reconnectDelay caps at 30 units with jitter and stays inside the setTimeout range', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 40].map(attempt => reconnectDelay(attempt, 1000, () => 0.5)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  assert.equal(reconnectDelay(6, 1000, () => 0), 24000, 'jitter floor is -20%')
  assert.equal(reconnectDelay(6, 1000, () => 0.999999), 36000, 'jitter ceiling is +20%')
  assert.equal(reconnectDelay(0, 1000, () => 0.5), 1000, 'attempt 0 waits one unit')
  for (const attempt of [1024, 5000, Number.MAX_SAFE_INTEGER]) assert.equal(reconnectDelay(attempt, 1000, () => 0.5), 30000, `attempt ${attempt} does not overflow`)
  assert.equal(reconnectDelay(10, 1e9, () => 0.5), 2 ** 31 - 1, 'a huge base is clamped to the setTimeout limit')
})

test('the deckd reconnect backoff stops growing at the cap and stays in the jitter band', async t => {
  const attempts = []
  const h = await harness(t, { reconnectMs: 2, connectDeckd: async () => {
    attempts.push(Date.now())
    throw Error('fake offline')
  } })
  // 2 ms units reach the 60 ms cap at attempt 6, after 2+4+8+16+32 = 62 ms of waiting at most.
  await waitFor(() => healthRows(h.deck).length >= 12)
  const delays = healthRows(h.deck).map(row => row.data.nextProbeAt - row.at)
  const capped = delays.slice(5)
  assert.ok(capped.every(delay => delay >= 48 && delay <= 72), `after attempt 5 every delay is 60 ms ±20%: ${delays.join(', ')}`)
  const gaps = attempts.slice(6).map((at, i) => at - attempts[i + 5])
  assert.ok(gaps.every(gap => gap >= 47), `the measured gaps stop shrinking below the jitter floor: ${gaps.join(', ')}`)
})

test('Retry now while deckd stays down ends the event log on the true down state, with the attempt advanced', async t => {
  const h = await harness(t, { reconnectMs: 20, random: () => 0.5, connectDeckd: async () => { throw Error('fake offline') } })
  await sleep(200)
  const base = `http://127.0.0.1:${h.deck.address().port}`
  const response = await fetch(`${base}/api/deps/deckd/retry`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: base } })
  assert.equal(response.status, 202)
  const { dep } = await response.json()
  assert.equal(dep.state, 'checking')
  const attemptAtRetry = dep.attempt
  assert.ok(attemptAtRetry >= 1, 'Retry now does not reset the attempt counter')
  await sleep(1500)
  const rows = healthRows(h.deck)
  const checking = rows.findIndex(row => row.data.state === 'checking')
  assert.ok(checking >= 0, 'the API published the checking row')
  const failed = rows[checking + 1]
  assert.equal(failed.data.state, 'down')
  assert.equal(failed.data.attempt, attemptAtRetry + 1, 'the failed retry is published as the next attempt')
  // With zero jitter, attempts land near 0, 20, 60 and 140 ms and the next waits 160 ms, so near 200 ms the
  // pending backoff is about 100 ms away and a failure within 60 ms of the checking row is the retry's own probe.
  assert.ok(failed.at - rows[checking].at < 60, `Retry now probes at once, not at the next backoff: ${failed.at - rows[checking].at} ms`)
  // A backoff attempt can land between the two reads, so re-read until they describe the same attempt.
  let health, last
  for (let read = 0; read === 0 || read < 5 && health.attempt !== last.attempt; read++) {
    health = (await h.request('/api/health')).data.deps.find(entry => entry.dep === 'deckd')
    last = healthRows(h.deck).at(-1).data
  }
  assert.equal(health.state, 'down')
  assert.equal(last.state, 'down', 'the last published deckd state is the true one')
  assert.equal(last.attempt, health.attempt)
})

test('Retry now while deckd is connected republishes ok after the checking row', async t => {
  const { client } = fakeDeckd()
  const h = await harness(t, { reconnectMs: 20, connectDeckd: async () => client })
  await waitFor(() => healthRows(h.deck).at(-1)?.data.state === 'ok')
  const base = `http://127.0.0.1:${h.deck.address().port}`
  assert.equal((await fetch(`${base}/api/deps/deckd/retry`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: base } })).status, 202)
  await waitFor(() => healthRows(h.deck).at(-1).data.state !== 'checking')
  assert.equal(healthRows(h.deck).at(-1).data.state, 'ok')
})

test('reconciliation ends a PTY session deckd no longer knows as crashed with kind lost', async t => {
  let available = false
  const { client } = fakeDeckd({ ptys: [], exits: [] })
  const h = await harness(t, { reconnectMs: 20, connectDeckd: async () => {
    if (!available) throw Error('fake offline')
    return client
  } })
  h.send('SessionStart', 1000)
  const id = h.deck.projector.snapshot().sessions[0].id
  h.deck.store.run('UPDATE sessions SET origin=?,pty_id=? WHERE id=?', 'wrapped', 'pty_gone', id)
  available = true
  await waitFor(() => h.deck.projector.snapshot().sessions.find(row => row.id === id).state === 'crashed')
  const session = (await h.request(`/api/sessions/${id}`)).data.session
  assert.equal(session.state, 'crashed')
  assert.equal(session.crashKind, 'lost')
  assert.equal(session.exitCode, null)
  assert.equal(session.exitSignal, null)
  const summary = (await h.request('/api/history')).data.summaries.find(row => row.sessionId === id)
  assert.equal(summary.outcome, 'lost')
})

test('reconciliation closes the lost session\'s open requests as process_ended and publishes each closure', async t => {
  let available = false
  const { client } = fakeDeckd({ ptys: [], exits: [] })
  const h = await harness(t, { reconnectMs: 20, connectDeckd: async () => {
    if (!available) throw Error('fake offline')
    return client
  } })
  h.send('SessionStart', 1000)
  h.send('PermissionRequest', 2000, { tool_name: 'Bash', tool_input: { command: 'pwd' } })
  const id = h.deck.projector.snapshot().sessions[0].id
  const [open] = h.deck.projector.snapshot().requests
  assert.equal(open.state, 'open')
  h.deck.store.run('UPDATE sessions SET origin=?,pty_id=? WHERE id=?', 'wrapped', 'pty_gone', id)
  const published = []
  t.after(h.deck.subscribe(event => published.push(event)))
  available = true
  await waitFor(() => h.deck.projector.snapshot().sessions.find(row => row.id === id).state === 'crashed')
  const request = h.deck.projector.snapshot().requests.find(row => row.id === open.id)
  assert.equal(request.state, 'expired')
  assert.equal(request.expiredReason, 'process_ended')
  const closed = published.filter(event => event.type === 'request.closed')
  assert.deepEqual(closed.map(event => event.data.id), [open.id], 'the closure reaches subscribers')
  assert.equal(closed[0].data.expiredReason, 'process_ended')
})

test('a lost PTY session records the files it changed since its baseline', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1l-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  t.after(() => { store.close()
    fs.rmSync(dir, { recursive: true, force: true }) })
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  const projector = createProjector({ store, now: () => 1000 })
  projector.applyHooks([{ v: 1, hook: { ...fixture, cwd: repo, hook_event_name: 'SessionStart' }, hookTs: 1000, ptyId: 'pty_gone', claudePid: 42, pidChain: [42], truncated: false, receivedAt: 1000, via: 'socket' }])
  const id = projector.snapshot().sessions[0].id
  store.run('UPDATE sessions SET origin=? WHERE id=?', 'wrapped', id)
  const file = path.join(repo, 'written-outside-hooks.txt')
  fs.writeFileSync(file, 'x\n')
  projector.signal(id, { type: 'lost' }, 2000)
  const session = projector.snapshot().sessions.find(row => row.id === id)
  assert.equal(session.crashKind, 'lost')
  assert.deepEqual(session.changedFiles.map(row => row.path), [fs.realpathSync(file)])
})
