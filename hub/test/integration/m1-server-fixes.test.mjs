import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startDeckServer } from '../../server/main.mjs'

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const healthEvents = deck => deck.store.all('SELECT data FROM events WHERE type=? ORDER BY seq', 'health.changed').map(row => JSON.parse(row.data))

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

test('while deckd stays unreachable the server backs off and appends health.changed only on transitions', async t => {
  const attempts = []
  let available = false
  const { client, listeners } = fakeDeckd()
  const h = await harness(t, { reconnectMs: 20, connectDeckd: async () => {
    attempts.push(Date.now())
    if (!available) throw Error('fake offline')
    return client
  } })
  await sleep(700)
  // A fixed 20 ms retry makes about 35 attempts in 700 ms; doubling from 20 ms makes about 6.
  assert.ok(attempts.length <= 8, `expected backoff, saw ${attempts.length} connect attempts`)
  const gaps = attempts.slice(1).map((at, i) => at - attempts[i])
  assert.ok(gaps.at(-1) >= 80, `the delay grows between attempts: ${gaps.join(', ')}`)
  const down = healthEvents(h.deck)
  assert.equal(down.length, 1, 'repeated failures while already down append no further health.changed events')
  assert.equal(down[0].state, 'down')
  const row = (await h.request('/api/health')).data.deps.find(entry => entry.dep === 'deckd')
  assert.equal(row.state, 'down')
  assert.equal(row.attempt, attempts.length, 'the snapshot still reports the current attempt')
  assert.ok(row.nextProbeAt >= attempts.at(-1), 'and when the next attempt is due')

  available = true
  await waitFor(() => healthEvents(h.deck).length === 2)
  assert.equal(healthEvents(h.deck)[1].state, 'ok')
  assert.equal(healthEvents(h.deck)[1].attempt, 0, 'a successful connect resets the attempt count')
  available = false
  const before = attempts.length
  listeners.get('close')?.()
  await waitFor(() => attempts.length >= before + 1)
  await sleep(100)
  const after = healthEvents(h.deck)
  assert.equal(after.length, 3, 'ok to down is one transition')
  assert.equal(after[2].state, 'down')
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
