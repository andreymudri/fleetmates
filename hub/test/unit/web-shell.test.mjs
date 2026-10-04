import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build, runnerImport } from 'vite'
import { chromium } from 'playwright-core'
import { captureToken, createApiClient, createConnection, wsProtocols, backoffMs, TOKEN_KEY } from '../../web/src/state/api.js'
import {
  createDeckStore, reduce, initialState, matchRoute, resolveRoute, keyAction, documentTitle, badgeText,
  selectLanguage, createAnnouncer, bannerFor, isRoute, parseNeedsFilter, needsFilterParam, readDensity, writeDensity,
  visibleSessions, archivedCount
} from '../../web/src/state/deck-store.js'
import { messages as en, format } from '../../web/src/i18n/en.js'
import * as pt from '../../web/src/i18n/pt.js'

const hub = fileURLToPath(new URL('../..', import.meta.url))

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    map
  }
}

function fakeLocation(href) {
  const url = new URL(href)
  return { get hash() { return url.hash }, get pathname() { return url.pathname }, get search() { return url.search }, get host() { return url.host }, url }
}

function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = next++
      timers.set(id, { fn, at: now + ms })
      return id },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = until
    },
    pending: () => timers.size
  }
}

function fakeSockets() {
  const created = []
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url
      this.protocols = protocols
      this.sent = []
      this.readyState = 0
      created.push(this)
    }
    send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data) }
    close(code = 1000) { if (this.readyState === 3) return
      this.readyState = 3
      this.onclose?.({ code }) }
    open() { this.readyState = 1
      this.onopen?.({}) }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    receiveBinary(data) { this.onmessage?.({ data }) }
    drop(code = 1006) { this.readyState = 3
      this.onclose?.({ code }) }
  }
  return { FakeWebSocket, created }
}

const session = (id, state = 'running', extra = {}) => ({ id, repoId: `/home/you/dev/${id}`, state, ...extra })
const counts = (needYouSessions = 0) => ({ needYouSessions, running: 0, toReview: 0, openRequests: needYouSessions, requestSessions: needYouSessions, oldestRequestAt: null, perRun: [] })
const snapshotMessage = (seq, extra = {}) => ({
  t: 'snapshot', seq, epoch: 'e1', data: {
    sessions: [], requests: [], runs: [], repos: [], counts: counts(0), order: [], recap: { reviewed: 0 }, ruleOffers: [], research: [],
    recorder: { state: 'idle' }, health: [], prefs: { lang: 'en', firstRunCompletedAt: 1 }, setup: { firstRunCompletedAt: 1 }, ...extra
  }
})

test('the URL fragment token moves into sessionStorage and the fragment is dropped', () => {
  const storage = memoryStorage()
  const location = fakeLocation('http://127.0.0.1:47800/memory?view=list#token=abc&to=/settings/notifications')
  const calls = []
  const history = { replaceState: (...args) => calls.push(args) }
  const result = captureToken({ location, history, storage })
  assert.deepEqual(result, { token: 'abc', to: '/settings/notifications' })
  assert.equal(storage.getItem(TOKEN_KEY), 'abc')
  assert.deepEqual(calls, [[null, '', '/memory?view=list']])

  const again = captureToken({ location: fakeLocation('http://127.0.0.1:47800/'), history: { replaceState: () => assert.fail('no fragment, no rewrite') }, storage })
  assert.deepEqual(again, { token: 'abc', to: null })

  const rejected = captureToken({ location: fakeLocation('http://127.0.0.1:47800/#token=def&to=//evil.example/'), history, storage })
  assert.deepEqual(rejected, { token: 'def', to: null })
  for (const to of ['//s/x', '//memory/note/x', '//runs/evil.example/x']) {
    assert.notEqual(matchRoute(to).name, 'notFound', `${to} matches a route, so only the // guard rejects it`)
    assert.equal(isRoute(to), false, `${to} is protocol-relative and resolves to another origin`)
    const hostile = captureToken({ location: fakeLocation(`http://127.0.0.1:47800/#token=ghi&to=${to}`), history, storage })
    assert.deepEqual(hostile, { token: 'ghi', to: null })
  }
  assert.deepEqual(captureToken({ location: fakeLocation('http://127.0.0.1:47800/#to=/memory'), history, storage: memoryStorage() }), { token: null, to: null })
})

test('REST calls carry the bearer token and API version, and 401 reports an invalid token', async () => {
  const seen = []
  let failures = 0
  const responses = [
    { status: 200, body: { apiVersion: 1 } },
    { status: 200, body: { prefs: {} } },
    { status: 401, body: { error: { code: 'unauthorized', message: 'unauthorized', retryable: false } } }
  ]
  const client = createApiClient({
    token: 'abc',
    fetch: async (url, init) => { seen.push({ url, init })
      const next = responses.shift()
      return { status: next.status, ok: next.status < 300, json: async () => next.body } },
    onFatal: code => { failures++
      assert.equal(code, 'token_invalid') }
  })
  assert.deepEqual(await client.get('/api/version'), { apiVersion: 1 })
  assert.deepEqual(await client.patch('/api/prefs', { bell: false }), { prefs: {} })
  await assert.rejects(client.get('/api/health'), error => error.code === 'unauthorized' && error.status === 401)
  assert.equal(failures, 1)
  for (const call of seen) {
    assert.equal(call.init.headers.Authorization, 'Bearer abc')
    assert.equal(call.init.headers['X-Deck-Api'], '1')
    assert.equal(call.init.cache, 'no-store')
  }
  assert.equal(seen[1].init.method, 'PATCH')
  assert.equal(seen[1].init.headers['Content-Type'], 'application/json')
  assert.equal(seen[1].init.body, '{"bell":false}')
  assert.equal(seen[0].init.headers['Content-Type'], undefined)
  assert.deepEqual(wsProtocols('abc'), ['deck.v1', 'deck.auth.abc'])
})

test('the REST client refuses any path outside /api/ and never sends the token there', async () => {
  const seen = []
  const client = createApiClient({ token: 'abc', fetch: async (url, init) => { seen.push([url, init.headers.Authorization])
    return { status: 200, ok: true, json: async () => ({ data: {} }) } } })
  for (const bad of ['https://evil.example/x', '//evil.example/api/x', '/not-api/thing', '/apix/y', 'api/version']) {
    await assert.rejects(client.get(bad), error => error.code === 'bad_path', bad)
    await assert.rejects(client.post(bad, {}), error => error.code === 'bad_path', bad)
  }
  assert.deepEqual(seen, [], 'fetch never ran for a non-API path')
  await client.get('/api/version')
  assert.deepEqual(seen, [['/api/version', 'Bearer abc']])
})

test('reconnect sends lastSeq and epoch, backs off with jitter, and Retry now keeps the attempt count', async () => {
  const clock = fakeClock()
  const { FakeWebSocket, created } = fakeSockets()
  const store = createDeckStore()
  const connection = createConnection({
    token: 'abc', url: 'ws://127.0.0.1:47800/api/ws', WebSocket: FakeWebSocket, store, storage: memoryStorage(),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5,
    probe: async () => null, reload: () => assert.fail('no reload')
  })
  connection.start()
  assert.equal(created.length, 1)
  assert.deepEqual(created[0].protocols, ['deck.v1', 'deck.auth.abc'])
  assert.equal(store.getState().connection.state, 'connecting')
  created[0].open()
  assert.deepEqual(created[0].sent, [{ t: 'hello', lastSeq: 0, epoch: null, apiVersion: 1, build: 'm4' }])
  assert.equal(store.getState().connection.state, 'resyncing')
  created[0].receive({ t: 'welcome', apiVersion: 1, epoch: 'e1', serverTime: 0, headSeq: 5 })
  created[0].receive(snapshotMessage(5))
  assert.equal(store.getState().connection.state, 'live')
  created[0].receive({ t: 'counts', seq: 6, at: 10, data: counts(2) })
  assert.equal(store.getState().data.counts.needYouSessions, 2)

  created[0].drop(1006)
  await Promise.resolve()
  assert.deepEqual(store.getState().connection, { state: 'reconnecting', attempt: 1, nextAt: 1000 })
  clock.advance(999)
  assert.equal(created.length, 1)
  clock.advance(1)
  assert.equal(created.length, 2)
  created[1].drop(1006)
  await Promise.resolve()
  assert.equal(store.getState().connection.attempt, 2)
  connection.retryNow()
  assert.equal(created.length, 3)
  created[2].drop(1006)
  await Promise.resolve()
  assert.equal(store.getState().connection.attempt, 3, 'Retry now never resets the attempt counter')
  assert.equal(store.getState().connection.nextAt - clock.now(), 4000)
  connection.visible()
  assert.equal(created.length, 4, 'a visible tab skips the remaining wait')
  created[3].open()
  assert.deepEqual(created[3].sent[0], { t: 'hello', lastSeq: 6, epoch: 'e1', apiVersion: 1, build: 'm4' })
  assert.equal(store.getState().data.counts.needYouSessions, 2, 'the last state stays while resyncing')

  assert.equal(backoffMs(1, () => 0), 800)
  assert.equal(backoffMs(1, () => 1), 1200)
  assert.equal(backoffMs(9, () => 0.5), 30_000)
})

test('heartbeat silence reconnects; token, origin and outdated closes stop retrying', async () => {
  const clock = fakeClock()
  const { FakeWebSocket, created } = fakeSockets()
  const storage = memoryStorage()
  let reloads = 0
  let probeResult = null
  const make = () => {
    const store = createDeckStore()
    const connection = createConnection({
      token: 'abc', url: 'ws://x/api/ws', WebSocket: FakeWebSocket, store, storage, setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5, probe: async () => probeResult, reload: () => { reloads++ }
    })
    connection.start()
    return { store, connection, socket: created.at(-1) }
  }
  const live = make()
  live.socket.open()
  live.socket.receive(snapshotMessage(1))
  clock.advance(29_999)
  assert.equal(live.store.getState().connection.state, 'live')
  clock.advance(1)
  await Promise.resolve()
  assert.equal(live.store.getState().connection.state, 'reconnecting')
  assert.equal(live.socket.readyState, 3)
  live.connection.close()

  const beating = make()
  beating.socket.open()
  beating.socket.receive(snapshotMessage(1))
  clock.advance(20_000)
  beating.socket.receive({ t: 'hb', serverTime: 20_000 })
  clock.advance(10_000)
  assert.equal(beating.store.getState().connection.state, 'live', 'every message re-arms the 30 s watchdog')
  assert.equal(beating.socket.readyState, 1)
  clock.advance(20_000)
  await Promise.resolve()
  assert.equal(beating.store.getState().connection.state, 'reconnecting', '30 s after the last hb the socket is dropped')
  beating.connection.close()

  for (const [code, state] of [[4401, 'token_invalid'], [4403, 'origin_rejected']]) {
    const { store } = make()
    const count = created.length
    created.at(-1).open()
    created.at(-1).drop(code)
    await Promise.resolve()
    assert.equal(store.getState().connection.state, state)
    clock.advance(120_000)
    assert.equal(created.length, count, `${state} never retries`)
  }

  probeResult = 'token_invalid'
  const refused = make()
  refused.socket.drop(1006)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(refused.store.getState().connection.state, 'token_invalid', 'an upgrade refused with 401 is a stale token')
  probeResult = null

  const probes = []
  const api = createApiClient({ token: 'abc', fetch: async (url, init) => { probes.push([url, init.headers.Authorization])
    return { status: 403, ok: false, json: async () => ({ error: { code: 'forbidden_origin', message: 'forbidden', retryable: false } }) } } })
  const originStore = createDeckStore()
  const origin = createConnection({
    token: 'abc', url: 'ws://x/api/ws', WebSocket: FakeWebSocket, store: originStore, storage, setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5, probe: api.probe, reload: () => assert.fail('no reload')
  })
  const pendingBefore = clock.pending()
  origin.start()
  const originCount = created.length
  created.at(-1).drop(1006)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(probes, [['/api/version', 'Bearer abc']])
  assert.equal(originStore.getState().connection.state, 'origin_rejected', 'an upgrade refused with 403 is a rejected origin')
  assert.equal(clock.pending(), pendingBefore, 'no retry timer is armed')
  clock.advance(120_000)
  assert.equal(created.length, originCount, 'origin_rejected never retries')

  const outdated = make()
  outdated.socket.open()
  outdated.socket.drop(4410)
  await Promise.resolve()
  assert.equal(reloads, 1)
  assert.equal(storage.getItem('fleetmates-deck.reloaded.m4'), '1')
  const second = make()
  second.socket.open()
  second.socket.drop(4410)
  await Promise.resolve()
  assert.equal(reloads, 1)
  assert.equal(second.store.getState().connection.state, 'client_outdated')
})

test('the connection routes term.* messages and binary frames to terminal listeners, never to the store', async () => {
  const clock = fakeClock()
  const { FakeWebSocket, created } = fakeSockets()
  const store = createDeckStore()
  const dispatched = []
  const dispatch = store.dispatch
  store.dispatch = action => { dispatched.push(action)
    dispatch(action) }
  const connection = createConnection({
    token: 'abc', url: 'ws://x/api/ws', WebSocket: FakeWebSocket, store, storage: memoryStorage(),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5,
    probe: async () => null, reload: () => assert.fail('no reload')
  })
  const terms = []
  const frames = []
  let lives = 0
  connection.onTerm(message => terms.push(message))
  const offBinary = connection.onBinary(data => frames.push(data))
  connection.onLive(() => { lives++ })
  connection.start()
  assert.equal(created[0].binaryType, 'arraybuffer')
  assert.equal(connection.send({ t: 'term.attach', sessionId: 's1', cols: 80, rows: 24 }), false, 'nothing is sent before the socket is live')
  assert.equal(connection.sendBinary(new Uint8Array([2, 1, 97, 120])), false)
  created[0].open()
  assert.equal(connection.send({ t: 'sub.tails', sessionIds: [] }), false, 'resyncing is not live')
  created[0].receive(snapshotMessage(1))
  assert.equal(lives, 1)
  assert.equal(connection.send({ t: 'term.attach', sessionId: 's1', cols: 80, rows: 24 }), true)
  const input = new Uint8Array([2, 2, 115, 49, 120])
  assert.equal(connection.sendBinary(input), true)
  assert.deepEqual(created[0].sent.slice(1), [{ t: 'term.attach', sessionId: 's1', cols: 80, rows: 24 }, input])

  dispatched.length = 0
  created[0].receive({ t: 'term.attached', sessionId: 's1', ptyId: 'p1', cols: 80, rows: 24 })
  created[0].receive({ t: 'term.error', sessionId: 's1', error: { code: 'no_pty' } })
  const output = new Uint8Array([1, 2, 115, 49, 104, 105]).buffer
  created[0].receiveBinary(output)
  assert.deepEqual(terms.map(message => message.t), ['term.attached', 'term.error'])
  assert.deepEqual(frames, [output])
  assert.deepEqual(dispatched, [], 'term.* messages and binary frames never reach the store')
  created[0].receive({ t: 'counts', seq: 2, at: 2, data: counts(1) })
  assert.equal(store.getState().data.counts.needYouSessions, 1, 'other messages still reach the store')
  clock.advance(29_000)
  created[0].receiveBinary(output)
  clock.advance(29_000)
  assert.equal(store.getState().connection.state, 'live', 'a binary frame re-arms the heartbeat watchdog')
  offBinary()
  created[0].receiveBinary(output)
  assert.equal(frames.length, 2, 'an unsubscribed listener hears nothing')

  created[0].drop(1006)
  await Promise.resolve()
  assert.equal(connection.send({ t: 'term.detach', sessionId: 's1' }), false, 'nothing is sent while reconnecting')
  clock.advance(1000)
  created[1].open()
  assert.equal(lives, 1)
  created[1].receive({ t: 'replay.begin', from: 2, to: 2 })
  created[1].receive({ t: 'replay.end', seq: 2 })
  assert.equal(lives, 2, 'onLive fires on every return to live')
  created[1].receive({ t: 'replay.end', seq: 2 })
  assert.equal(lives, 2, 'a second live signal while already live does not fire again')
  connection.close()
})

test('input.source and screen.tail are ephemeral store state and never move the durable sequence', () => {
  let state = reduce(initialState(), { type: 'message', message: snapshotMessage(5) })
  state = reduce(state, { type: 'message', message: { t: 'input.source', data: { sessionId: 's1', state: 'terminal_active', from: 'terminal', name: 'kitty', detached: false } } })
  state = reduce(state, { type: 'message', message: { t: 'screen.tail', data: { sessionId: 's1', lines: ['$ cargo test', 'ok'] } } })
  assert.deepEqual(state.data.inputSources.s1, { sessionId: 's1', state: 'terminal_active', from: 'terminal', name: 'kitty', detached: false })
  assert.deepEqual(state.data.tails.s1, ['$ cargo test', 'ok'])
  assert.equal(state.seq, 5)
  state = reduce(state, { type: 'message', message: { t: 'input.source', data: { sessionId: 's1', state: 'collision', from: 'browser', name: null, detached: false } } })
  assert.equal(state.data.inputSources.s1.state, 'collision')
  state = reduce(state, { type: 'message', message: { t: 'screen.tail', data: { sessionId: 's1', lines: 'not a list' } } })
  assert.deepEqual(state.data.tails.s1, ['$ cargo test', 'ok'], 'a malformed tail is ignored')
  state = reduce(state, { type: 'message', message: { t: 'input.source', data: { state: 'quiet' } } })
  assert.deepEqual(Object.keys(state.data.inputSources), ['s1'], 'an input.source without a session id is ignored')
  state = reduce(state, { type: 'resync' })
  state = reduce(state, { type: 'message', message: { t: 'screen.tail', data: { sessionId: 's2', lines: ['busy'] } } })
  assert.deepEqual(state.data.tails.s2, ['busy'], 'ephemeral events apply even while resyncing')
  assert.deepEqual(state.buffer, [], 'ephemeral events are never buffered as durable events')
  state = reduce(state, { type: 'message', message: snapshotMessage(7) })
  assert.equal(state.seq, 7)
  assert.equal(state.data.inputSources.s1.state, 'collision', 'a snapshot keeps the ephemeral state')
  assert.deepEqual(state.data.tails.s2, ['busy'])
  assert.deepEqual(initialState().data.inputSources, {})
  assert.deepEqual(initialState().data.tails, {})
})

test('toast.push adds a toast with the next id', () => {
  let state = initialState()
  state = reduce(state, { type: 'toast.push', tone: 'error', title: 'Could not stop rustot', body: 'deckd is reconnecting' })
  state = reduce(state, { type: 'toast.push', tone: 'info', title: 'Marked reviewed' })
  assert.deepEqual(state.toasts, [
    { id: 1, tone: 'error', title: 'Could not stop rustot', body: 'deckd is reconnecting' },
    { id: 2, tone: 'info', title: 'Marked reviewed', body: null }
  ])
  assert.equal(state.nextId, 3)
})

test('the needs filter parses from and builds back to the ?needs= parameter', () => {
  assert.deepEqual(parseNeedsFilter('?needs=request:r1'), { kind: 'request', id: 'r1' })
  assert.deepEqual(parseNeedsFilter('?needs=run:2026%2Fsubstop'), { kind: 'run', runId: '2026/substop' })
  assert.deepEqual(parseNeedsFilter('?needs=task:r1:T2'), { kind: 'task', runId: 'r1', taskId: 'T2' })
  assert.deepEqual(parseNeedsFilter('?x=1&needs=task:2026:sub:T12'), { kind: 'task', runId: '2026:sub', taskId: 'T12' }, 'the task id is after the last colon')
  for (const bad of ['', '?needs=', '?needs=task:r1', '?needs=task::T2', '?needs=task:r1:', '?needs=request:', '?needs=other:x', '?other=1', null, undefined]) {
    assert.equal(parseNeedsFilter(bad), null, String(bad))
  }
  for (const filter of [{ kind: 'request', id: 'r1' }, { kind: 'run', runId: '2026/substop' }, { kind: 'task', runId: '2026:sub', taskId: 'T12' }]) {
    const param = needsFilterParam(filter)
    assert.match(param, /^needs=/)
    assert.deepEqual(parseNeedsFilter(`?${param}`), filter)
  }
  assert.equal(needsFilterParam({ kind: 'task', runId: 'r1', taskId: 'T2' }), 'needs=task%3Ar1%3AT2')
  assert.equal(needsFilterParam(null), '')
})

test('density reads and writes deck.density with comfortable as the default and survives a throwing storage', () => {
  const storage = memoryStorage()
  assert.equal(readDensity(storage), 'comfortable')
  writeDensity(storage, 'compact')
  assert.equal(storage.getItem('deck.density'), 'compact')
  assert.equal(readDensity(storage), 'compact')
  storage.setItem('deck.density', 'dense')
  assert.equal(readDensity(storage), 'comfortable', 'an unknown value reads as the default')
  writeDensity(storage, 'sideways')
  assert.equal(storage.getItem('deck.density'), 'dense', 'an unknown value is not written')
  const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(readDensity(throwing), 'comfortable')
  assert.doesNotThrow(() => writeDensity(throwing, 'compact'))
  assert.equal(readDensity(undefined), 'comfortable')
})

test('store buffers events during resync, swaps the snapshot atomically and drops stale sequence numbers', () => {
  let stale = reduce(initialState(), { type: 'resync' })
  stale = reduce(stale, { type: 'message', message: { t: 'counts', seq: 4, at: 40, data: counts(4) } })
  stale = reduce(stale, { type: 'message', message: snapshotMessage(5, { counts: counts(5) }) })
  assert.equal(stale.data.counts.needYouSessions, 5, 'a buffered event older than the snapshot is dropped')
  assert.equal(stale.seq, 5, 'the sequence never moves backward')

  let state = reduce(initialState(), { type: 'resync' })
  state = reduce(state, { type: 'message', message: { t: 'welcome', epoch: 'e1', headSeq: 4 } })
  state = reduce(state, { type: 'message', message: { t: 'counts', seq: 6, at: 60, data: counts(6) } })
  state = reduce(state, { type: 'message', message: { t: 'counts', seq: 4, at: 40, data: counts(4) } })
  assert.equal(state.loaded, false)
  assert.equal(state.data.counts, null, 'no counts before the snapshot')
  state = reduce(state, { type: 'message', message: snapshotMessage(5, { counts: counts(5), sessions: [session('a')] }) })
  assert.equal(state.loaded, true)
  assert.equal(state.seq, 6)
  assert.equal(state.data.counts.needYouSessions, 6, 'buffered event newer than the snapshot applied after it')
  state = reduce(state, { type: 'message', message: { t: 'counts', seq: 6, at: 61, data: counts(9) } })
  assert.equal(state.data.counts.needYouSessions, 6, 'a replayed duplicate is ignored')

  state = reduce(state, { type: 'resync' })
  state = reduce(state, { type: 'message', message: { t: 'welcome', epoch: 'e1', headSeq: 8 } })
  assert.deepEqual(state.data.sessions.map(row => row.id), ['a'], 'old UI stays until replay or snapshot')
  state = reduce(state, { type: 'message', message: { t: 'replay.begin', from: 6, to: 8 } })
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 7, at: 70, data: session('b', 'needs_approval') } })
  state = reduce(state, { type: 'message', message: { t: 'request.opened', seq: 8, at: 80, data: { id: 'rb', sessionId: 'b', kind: 'permission', summary: 'ls' } } })
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 9, at: 90, data: session('a', 'done') } })
  state = reduce(state, { type: 'message', message: { t: 'replay.end', seq: 9 } })
  assert.equal(state.syncing, false)
  assert.equal(state.seq, 9)
  assert.equal(state.lastEventAt, 90)
  assert.deepEqual(state.data.sessions.map(row => [row.id, row.state]), [['a', 'done'], ['b', 'needs_approval']])
  assert.deepEqual(state.data.requests.map(row => row.id), ['rb'], 'the replayed request is applied')
  assert.deepEqual(state.toasts, [], 'replayed requests do not raise toasts')
  assert.deepEqual(state.announcements, [], 'replayed requests are not announced')

  state = reduce(state, { type: 'resync' })
  state = reduce(state, { type: 'message', message: snapshotMessage(2, { sessions: [session('z')] }) })
  assert.equal(state.seq, 2, 'a new epoch snapshot restarts the sequence')
  assert.deepEqual(state.data.sessions.map(row => row.id), ['z'])
})

test('rule events fill and empty ruleOffers and rules keyed by repo and pattern, and bump rulesRev', () => {
  const offer = (repoId, pattern, count = 5) => ({ repoId, pattern, count, threshold: 5 })
  const rule = (repoId, pattern, extra = {}) => ({ repoId, pattern, source: 'suggested', approvalsBefore: 5, createdAt: 1, tier: 'safe', ...extra })
  const event = (t, seq, data) => ({ type: 'message', message: { t, seq, at: seq, data } })
  let state = reduce(initialState(), { type: 'resync' })
  state = reduce(state, { type: 'message', message: snapshotMessage(1, { ruleOffers: [offer('/home/you/dev/a', 'Bash(cargo test)')] }) })
  assert.deepEqual(state.data.ruleOffers, [offer('/home/you/dev/a', 'Bash(cargo test)')], 'offers come from the snapshot')
  assert.deepEqual(state.data.rules, [])
  const rev = state.data.rulesRev

  state = reduce(state, event('rule.offered', 2, offer('/home/you/dev/b', 'Bash(cargo test)')))
  state = reduce(state, event('rule.offered', 3, offer('/home/you/dev/a', 'Bash(cargo test)', 6)))
  assert.deepEqual(state.data.ruleOffers, [offer('/home/you/dev/a', 'Bash(cargo test)', 6), offer('/home/you/dev/b', 'Bash(cargo test)')], 'the same pattern in another repo is its own offer')
  state = reduce(state, event('rule.withdrawn', 4, { repoId: '/home/you/dev/a', pattern: 'Bash(cargo test)' }))
  assert.deepEqual(state.data.ruleOffers, [offer('/home/you/dev/b', 'Bash(cargo test)')], 'withdrawing one repo keeps the other')
  state = reduce(state, event('rule.withdrawn', 5, { repoId: '/home/you/dev/b', pattern: 'Bash(cargo test)' }))
  assert.deepEqual(state.data.ruleOffers, [])
  assert.equal(state.data.rulesRev, rev, 'offers do not bump the rules revision')

  state = reduce(state, event('rule.upserted', 6, rule('/home/you/dev/a', 'Bash(ls)')))
  state = reduce(state, event('rule.upserted', 7, rule('/home/you/dev/b', 'Bash(ls)')))
  state = reduce(state, event('rule.upserted', 8, rule('/home/you/dev/a', 'Bash(ls)', { source: 'manual', createdAt: null })))
  assert.deepEqual(state.data.rules, [rule('/home/you/dev/a', 'Bash(ls)', { source: 'manual', createdAt: null }), rule('/home/you/dev/b', 'Bash(ls)')])
  assert.equal(state.data.rulesRev, rev + 3, 'every rule change bumps rulesRev so Settings refetches')
  state = reduce(state, event('rule.removed', 9, { repoId: '/home/you/dev/a', pattern: 'Bash(ls)' }))
  assert.deepEqual(state.data.rules, [rule('/home/you/dev/b', 'Bash(ls)')], 'removing one repo keeps the other')
  state = reduce(state, event('rule.removed', 10, { repoId: '/home/you/dev/b', pattern: 'Bash(ls)' }))
  assert.deepEqual(state.data.rules, [])
  assert.equal(state.data.rulesRev, rev + 5)
})

test('request.updated replaces the request with its delivery, screen match, options, allowAlways and confirm label', () => {
  let state = reduce(initialState(), { type: 'resync' })
  const request = { id: 'r1', sessionId: 's1', kind: 'permission', tier: 'destructive', summary: 'rm -rf build', delivery: 'idle', screenMatch: 'unknown', options: [], allowAlways: false, confirmLabel: null }
  state = reduce(state, { type: 'message', message: snapshotMessage(1, { requests: [request] }) })
  const updated = { ...request, delivery: 'verifying', screenMatch: 'on_screen', options: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }], allowAlways: true, confirmLabel: 'Delete build and 3 files' }
  state = reduce(state, { type: 'message', message: { t: 'request.updated', seq: 2, at: 2, data: updated } })
  assert.equal(state.data.requests.length, 1)
  const [row] = state.data.requests
  assert.equal(row.delivery, 'verifying')
  assert.equal(row.screenMatch, 'on_screen')
  assert.deepEqual(row.options, [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }])
  assert.equal(row.allowAlways, true)
  assert.equal(row.confirmLabel, 'Delete build and 3 files')
})

test('an archived upsert leaves order, visible sessions and the Alt digit keys; an unarchive brings it back', () => {
  let state = reduce(reduce(initialState(), { type: 'resync' }), { type: 'message', message: snapshotMessage(1, {
    sessions: [session('s1'), session('s2'), session('s3')], order: ['s1', 's2', 's3']
  }) })
  assert.equal(archivedCount(state), 0, 'counts without archived read as zero')
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 2, at: 20, data: session('s2', 'running', { archivedAt: 1000, archivedBy: 'owner' }) } })
  const row = state.data.sessions.find(item => item.id === 's2')
  assert.equal(row.archivedAt, 1000)
  assert.equal(row.archivedBy, 'owner')
  assert.deepEqual(state.data.order, ['s1', 's3'])
  assert.deepEqual(visibleSessions(state).map(item => item.id), ['s1', 's3'])
  const key = code => ({ code, altKey: true, shiftKey: false, ctrlKey: false, metaKey: false })
  assert.deepEqual(keyAction(key('Digit2'), state), { type: 'navigate', to: '/s/s3' })

  // An order that still names an archived id (a snapshot or order.changed raced the archive) skips it on Alt digits.
  const raced = { ...state, data: { ...state.data, order: ['s2', 's1', 's3'] } }
  assert.deepEqual(keyAction(key('Digit1'), raced), { type: 'navigate', to: '/s/s1' })

  state = reduce(state, { type: 'message', message: { t: 'counts', seq: 3, at: 30, data: { ...counts(0), archived: 1 } } })
  assert.equal(archivedCount(state), 1)

  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 4, at: 40, data: session('s2', 'running', { archivedAt: null, archivedBy: null }) } })
  assert.deepEqual(state.data.order, ['s1', 's3', 's2'])
  assert.deepEqual(visibleSessions(state).map(item => item.id), ['s1', 's2', 's3'])
  assert.equal(state.data.sessions.find(item => item.id === 's2').archivedAt, null)
})

test('an archived session that receives a request leaves the archive and its request appears', () => {
  let state = reduce(reduce(initialState(), { type: 'resync' }), { type: 'message', message: snapshotMessage(1, {
    sessions: [session('s1'), session('s2', 'running', { archivedAt: 1000, archivedBy: 'owner' })], order: ['s1'], counts: { ...counts(0), archived: 1 }
  }) })
  assert.deepEqual(visibleSessions(state).map(item => item.id), ['s1'], 'the archived session starts hidden')
  // The server unarchives a session that needs the owner in the same commit as the request, then sends both events.
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 2, at: 20, data: session('s2', 'needs_approval', { archivedAt: null, archivedBy: null }) } })
  state = reduce(state, { type: 'message', message: { t: 'request.opened', seq: 3, at: 30, data: { id: 'r1', sessionId: 's2', kind: 'permission', tier: 'caution', summary: 'cargo test', state: 'open' } } })
  assert.deepEqual(visibleSessions(state).map(item => item.id), ['s1', 's2'], 'the session is visible again')
  assert.deepEqual(state.data.order, ['s1', 's2'], 'the session rejoins the order')
  assert.equal(state.data.sessions.find(item => item.id === 's2').archivedAt, null)
  assert.deepEqual(state.data.requests.filter(row => row.sessionId === 's2').map(row => row.id), ['r1'], 'its request is open in the store')
})

const FOCUS_NOW = 1_800_000_000_000
const focusRow = (extra = {}) => ({
  id: 's1', repoId: '/home/you/dev/rustot', origin: 'wrapped', ptyId: 'pty-s1', alive: true, task: 'Port the damage formula', branch: 'combat-tick',
  state: 'needs_approval', stateSince: FOCUS_NOW - 60_000, lastActivityAt: FOCUS_NOW, startedAt: FOCUS_NOW - 600_000, changedFiles: [], cwd: '/home/you/dev/rustot',
  toolCalls: 0, sessionAliases: [], lastInputFrom: null, lastInputName: null, ...extra
})
const focusRequest = { id: 'r1', sessionId: 's1', kind: 'permission', tier: 'safe', summary: 'cargo test', state: 'open', createdAt: FOCUS_NOW - 60_000,
  delivery: 'idle', screenMatch: 'on_screen', options: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }], allowAlways: false, confirmLabel: null }

test('Focus on an archived live PTY session shows the request as an "Answer in your terminal" bar, not the PromptBar', async () => {
  const { module: Focus } = await runnerImport(path.join(hub, 'web/src/screens/focus/Focus.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  const render = row => renderToStaticMarkup(Focus.FocusView({
    now: FOCUS_NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, sessionId: 's1', onUnarchive: () => {},
    client: { attach: () => ({ write: () => true, resize: () => true, detach() {} }) },
    state: {
      loaded: true, deckdOutage: false, connection: { state: 'live', attempt: 0, nextAt: null }, view: { path: '/', overlay: null },
      data: { sessions: [row], requests: [focusRequest], runs: [], order: ['s1'], health: [], prefs: {}, inputSources: {}, tails: {},
        repos: [{ id: '/home/you/dev/rustot', name: 'rustot', crew: { slot: 0, seed: 'rustot', hat: 'none' } }], counts: null, recap: null, setup: { firstRunCompletedAt: 1 } }
    }
  }))
  const live = render(focusRow())
  assert.match(live, /prompt-bar/, 'control: the same session unarchived gets the PromptBar')
  const archived = render(focusRow({ archivedAt: FOCUS_NOW - 1000, archivedBy: 'owner' }))
  assert.doesNotMatch(archived, /prompt-bar/, 'no PromptBar while archived')
  assert.match(archived, /class="focus-request focus-request--safe"[^>]*>.*<span class="request-terminal">Answer in your terminal/, 'the request keeps the terminal bar')
  assert.match(archived, /focus-banner--archived/)
})

// The real Focus route with a stub terminal client and an API double that records every call in `window.calls`.
// `window.h.archive(at)` sets s1's `archivedAt`.
const ARCHIVED_FOCUS_HARNESS = `import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Focus } from '@hub/web/src/screens/focus/Focus.jsx'

const h = window.h = {}
const calls = window.calls = []
const client = { attach: () => ({ write: () => true, resize: () => true, detach() {} }) }
const api = {
  get: async to => { calls.push(['GET', to])
    return { path: 'src/a.rs', baseline: 'abc', binary: false, truncated: false, diff: '@@ -1 +1 @@\\n-old\\n+new\\n' } },
  post: async (to, body) => { calls.push(['POST', to, body])
    return { request: {} } }
}
const base = ${JSON.stringify(focusRow({ changedFiles: [{ path: 'src/a.rs', adds: 1, dels: 1 }] }))}
const request = ${JSON.stringify(focusRequest)}
function App() {
  const [archivedAt, setArchivedAt] = useState(1000)
  h.archive = setArchivedAt
  const row = { ...base, stateSince: Date.now(), lastActivityAt: Date.now(), startedAt: Date.now(), archivedAt, archivedBy: archivedAt == null ? null : 'owner' }
  const state = {
    loaded: true, deckdOutage: false, connection: { state: 'live', attempt: 0, nextAt: null }, view: { path: '/', overlay: null },
    data: { sessions: [row], requests: [request], runs: [], order: ['s1'], health: [], prefs: {}, tails: {}, inputSources: {},
      repos: [{ id: '/home/you/dev/rustot', name: 'rustot', crew: { slot: 0, seed: 'rustot', hat: 'none' } }], counts: null, recap: null,
      setup: { firstRunCompletedAt: 1 } }
  }
  return <><span id="mark">{archivedAt == null ? 'live' : 'archived'}</span><Focus route={{ params: { sessionId: 's1' } }} state={state} navigate={() => {}} api={api}
    search="" client={client} dispatch={() => {}} onOverlay={() => {}} /></>
}
createRoot(document.getElementById('root')).render(<App />)
`

test('in Chromium the Focus route ignores the 1 answer key on an archived session and takes it once the session is unarchived', async t => {
  const executablePath = await findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the Focus browser test')
  const dir = await mkdtemp(path.join(tmpdir(), 'focusarc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><div id="root" style="width:1600px;height:900px"></div><script type="module" src="./entry.jsx"></script></body></html>')
  await writeFile(path.join(dir, 'entry.jsx'), ARCHIVED_FOCUS_HARNESS)
  const out = path.join(dir, 'dist')
  await build({
    root: dir, base: './', configFile: false, logLevel: 'silent',
    resolve: { alias: { '@hub': hub, react: path.join(hub, 'node_modules/react'), 'react-dom': path.join(hub, 'node_modules/react-dom') } },
    build: { outDir: out, emptyOutDir: true }
  })
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://x').pathname
    try {
      const body = await readFile(path.join(out, name === '/' ? 'index.html' : path.normalize(name)))
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }).end(body)
    } catch { res.writeHead(404).end() }
  }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => server.close())
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => document.getElementById('mark')?.textContent === 'archived', null, { timeout: 10_000 })
  const posts = () => page.evaluate(() => window.calls.filter(call => call[0] === 'POST'))
  // The digit answers only with the terminal unfocused, so focus the changed-files listbox first.
  await page.focus('[role="listbox"]')
  await page.waitForFunction(() => !document.activeElement?.closest('.terminal-view'), null, { timeout: 5000 })
  await page.keyboard.press('1')
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)))
  assert.deepEqual(await posts(), [], 'no answer while the session is archived')

  // Control: the same request and focus, once the session is unarchived, takes the key.
  await page.evaluate(() => window.h.archive(null))
  await page.waitForFunction(() => document.getElementById('mark')?.textContent === 'live' && !!document.querySelector('.prompt-bar'), null, { timeout: 5000 })
  await page.focus('[role="listbox"]')
  await page.waitForFunction(() => !document.activeElement?.closest('.terminal-view'), null, { timeout: 5000 })
  await page.keyboard.press('1')
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'POST'), null, { timeout: 5000 })
  assert.deepEqual(await posts(), [['POST', '/api/requests/r1/answer', { choice: 'allow' }]])
  assert.deepEqual(errors, [])
})

test('needs toasts appear once per episode and never with the drawer open or the session in Focus', () => {
  const opened = (seq, id, sessionId, kind = 'permission') => ({ type: 'message', message: { t: 'request.opened', seq, at: seq, data: { id, sessionId, kind, summary: 'cargo test --release combat::' } } })
  let state = reduce(reduce(initialState(), { type: 'resync' }), { type: 'message', message: snapshotMessage(1, {
    repos: [{ id: '/home/you/dev/rustot', name: 'rustot' }], sessions: [{ id: 's1', repoId: '/home/you/dev/rustot', state: 'running' }, { id: 's2', repoId: '/home/you/dev/rustot', state: 'running' }, { id: 's3', repoId: '/home/you/dev/rustot', state: 'running' }]
  }) })
  state = reduce(state, opened(2, 'r1', 's1'))
  state = reduce(state, opened(3, 'r2', 's1'))
  assert.deepEqual(state.toasts.map(toast => [toast.tone, toast.title]), [['needs', format(en['shell.toast.needs.title'], { repo: 'rustot' })]])
  assert.equal(state.toasts[0].title, 'rustot needs approval')
  assert.deepEqual(state.announcements.map(item => item.text), ['rustot needs approval: cargo test --release combat::', 'rustot needs approval: cargo test --release combat::'])
  state = reduce(state, { type: 'toast.dismiss', id: state.toasts[0].id })
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 4, at: 4, data: { id: 's1', repoId: '/home/you/dev/rustot', state: 'running' } } })
  state = reduce(state, opened(5, 'r3', 's1', 'question'))
  assert.deepEqual(state.toasts.map(toast => toast.title), ['rustot asked you'], 'a new episode toasts again')
  state = reduce(state, { type: 'view', path: '/', overlay: 'drawer' })
  state = reduce(state, opened(6, 'r4', 's2'))
  state = reduce(state, { type: 'view', path: '/s/s2', overlay: null })
  state = reduce(state, opened(7, 'r5', 's2'))
  assert.equal(state.toasts.length, 1)
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 8, at: 8, data: { id: 's2', repoId: '/home/you/dev/rustot', state: 'crashed', exitCode: 1 } } })
  assert.deepEqual(state.toasts.map(toast => [toast.tone, toast.title]), [['needs', 'rustot asked you'], ['error', 'rustot crashed, exit 1']])
  state = reduce(state, { type: 'view', path: '/s/s3', overlay: null })
  state = reduce(state, opened(9, 'r6', 's3'))
  assert.equal(state.episodes.s3, true, 'the episode starts even while hidden')
  assert.deepEqual(state.toasts.map(toast => toast.tone), ['needs', 'error'], 'a new request for the session in Focus raises no toast')
})

test('a snapshot rebuilds needs episodes and drops toasts for requests that closed while away', () => {
  const S = { id: 'S', repoId: '/home/you/dev/rustot', state: 'running' }
  const repos = [{ id: '/home/you/dev/rustot', name: 'rustot' }]
  let state = reduce(reduce(initialState(), { type: 'resync' }), { type: 'message', message: snapshotMessage(1, { repos, sessions: [S] }) })
  state = reduce(state, { type: 'message', message: { t: 'request.opened', seq: 2, at: 2, data: { id: 'R1', sessionId: 'S', kind: 'permission', summary: 'x' } } })
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 3, at: 3, data: { ...S, state: 'needs_approval' } } })
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 4, at: 4, data: { id: 'C', repoId: '/home/you/dev/rustot', state: 'crashed', exitCode: 2 } } })
  assert.deepEqual(state.toasts.map(toast => toast.requestId ?? toast.tone), ['R1', 'error'])
  assert.deepEqual(state.episodes, { S: true })

  state = reduce(state, { type: 'resync' })
  state = reduce(state, { type: 'message', message: { t: 'welcome', epoch: 'e2', headSeq: 10 } })
  const snapshot = snapshotMessage(10, { repos, sessions: [S, { id: 'Q', repoId: '/home/you/dev/rustot', state: 'asked_you' }], requests: [{ id: 'RQ', sessionId: 'Q', kind: 'question' }] })
  state = reduce(state, { type: 'message', message: { ...snapshot, epoch: 'e2' } })
  assert.deepEqual(state.episodes, { Q: true }, 'episodes come from snapshot sessions in a needs state')
  assert.deepEqual(state.toasts.map(toast => toast.requestId ?? toast.tone), ['error'], 'the closed R1 toast is gone; toasts without a request stay')

  state = reduce(state, { type: 'message', message: { t: 'request.opened', seq: 11, at: 11, data: { id: 'R2', sessionId: 'S', kind: 'permission', summary: 'y' } } })
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 12, at: 12, data: { ...S, state: 'needs_approval' } } })
  assert.deepEqual(state.toasts.map(toast => toast.requestId ?? toast.tone), ['error', 'R2'], 'the new episode toasts')
  state = reduce(state, { type: 'message', message: { t: 'request.opened', seq: 13, at: 13, data: { id: 'RQ2', sessionId: 'Q', kind: 'question', summary: 'z' } } })
  assert.deepEqual(state.toasts.map(toast => toast.requestId ?? toast.tone), ['error', 'R2'], 'Q was already waiting in the snapshot, so its episode does not toast again')
})

test('the live region announces at most once per 2s and merges bursts', () => {
  const clock = fakeClock()
  const spoken = []
  const announcer = createAnnouncer({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, emit: text => spoken.push(text), t: (key, params) => format(en[key], params) })
  announcer.push({ kind: 'request', text: 'rustot needs approval: cargo test --release combat::' })
  clock.advance(2000)
  assert.deepEqual(spoken, ['rustot needs approval: cargo test --release combat::'])
  announcer.push({ kind: 'request', text: 'one' })
  clock.advance(500)
  announcer.push({ kind: 'request', text: 'two' })
  clock.advance(500)
  announcer.push({ kind: 'request', text: 'three' })
  clock.advance(1000)
  assert.deepEqual(spoken, ['rustot needs approval: cargo test --release combat::', '3 new requests'])
})

test('routes, redirects, keyboard layer, title and badge follow the shell spec', () => {
  assert.deepEqual(matchRoute('/runs/fleetmates/2026/substop'), { name: 'team', params: { repoKey: 'fleetmates', runId: '2026/substop' } })
  assert.deepEqual(matchRoute('/s/abc'), { name: 'focus', params: { sessionId: 'abc' } })
  assert.deepEqual(matchRoute('/memory/note/02-wiki/a.md'), { name: 'memoryNote', params: { path: '02-wiki/a.md' } })
  assert.deepEqual(matchRoute('/meetings/live'), { name: 'meetingLive', params: {} })
  assert.deepEqual(matchRoute('/settings/crew'), { name: 'crew', params: {} })
  assert.deepEqual(matchRoute('/settings/notifications'), { name: 'settings', params: { section: 'notifications' } })
  assert.equal(matchRoute('/nowhere').name, 'notFound')
  assert.equal(matchRoute('/runs/fleetmates').name, 'notFound')

  const loaded = reduce(reduce(initialState(), { type: 'resync' }), { type: 'message', message: snapshotMessage(1, { order: ['s1', 's2', 's3'] }) })
  assert.equal(resolveRoute('/settings', loaded), '/settings/rules')
  assert.equal(resolveRoute('/', loaded), null)
  assert.equal(resolveRoute('/meetings/live', loaded), '/meetings')
  const fresh = reduce(reduce(initialState(), { type: 'resync' }), { type: 'message', message: snapshotMessage(1, { setup: { firstRunCompletedAt: null } }) })
  assert.equal(resolveRoute('/', fresh), '/welcome')
  assert.equal(resolveRoute('/', initialState()), null, 'no redirect before the snapshot says so')

  const key = (code, extra = {}) => ({ code, altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, ...extra })
  assert.deepEqual(keyAction(key('Digit2', { shiftKey: true }), loaded), { type: 'navigate', to: '/memory' })
  assert.deepEqual(keyAction(key('Digit4', { shiftKey: true }), loaded), { type: 'navigate', to: '/settings/rules' })
  assert.deepEqual(keyAction(key('Digit2'), loaded), { type: 'navigate', to: '/s/s2' })
  assert.equal(keyAction(key('Digit9'), loaded), null)
  assert.deepEqual(keyAction(key('Escape'), loaded), { type: 'navigate', to: '/' })
  assert.deepEqual(keyAction(key('KeyU'), loaded), { type: 'overlay', overlay: 'drawer' })
  assert.deepEqual(keyAction(key('KeyK'), loaded), { type: 'overlay', overlay: 'palette' })
  assert.equal(keyAction(key('Digit2', { ctrlKey: true }), loaded), null)
  assert.equal(keyAction(key('Digit2', { altKey: false }), loaded), null)

  const t = (k, params) => format(en[k], params)
  assert.equal(documentTitle('Sessions', counts(130), t), '(130) Sessions · fleetmates deck')
  assert.equal(documentTitle('Sessions', counts(0), t), 'Sessions · fleetmates deck')
  assert.equal(documentTitle('Sessions', null, t), 'Sessions · fleetmates deck')
  assert.equal(badgeText(130, t), '99+')
  assert.equal(badgeText(99, t), '99')
  assert.equal(badgeText(0, t), null)
  assert.equal(format(en['shell.rail.sessions.needs'], { n: 1 }), 'Sessions, 1 needs you')
  assert.equal(format(en['shell.rail.sessions.needs'], { n: 3 }), 'Sessions, 3 need you')

  const lost = { ...loaded, connection: { state: 'reconnecting', attempt: 3, nextAt: 4000 } }
  assert.deepEqual(bannerFor({ ...lost, data: { ...lost.data, health: [{ dep: 'deckd', state: 'down', attempt: 2, nextProbeAt: 3000 }] } }, 0), { kind: 'server', attempt: 3, seconds: 4 })
  assert.deepEqual(bannerFor({ ...loaded, data: { ...loaded.data, health: [{ dep: 'deckd', state: 'down', attempt: 2, nextProbeAt: 3000 }] } }, 1000), { kind: 'deckd', attempt: 2, seconds: 2 })
  assert.equal(bannerFor(loaded, 0), null)
})

test('DECK_LANG=pt falls back to English with a notice until the Portuguese voice is approved', () => {
  assert.equal(pt.approved, false)
  for (const key of Object.keys(pt.messages)) assert.ok(Object.hasOwn(en, key), `pt key ${key} missing from en`)
  for (const [key, value] of Object.entries(en)) {
    assert.doesNotMatch(value, /[\u2013\u2014]/, `${key} has a dash character`)
    assert.doesNotMatch(value, /Alt\+/, `${key} spells a key with a plus`)
  }
  assert.deepEqual(selectLanguage({ lang: 'pt' }), { lang: 'en', messages: en, fallback: 'pt' })
  assert.deepEqual(selectLanguage({ lang: 'en' }), { lang: 'en', messages: en, fallback: null })
  assert.deepEqual(selectLanguage({}), { lang: 'en', messages: en, fallback: null })
  const approved = { approved: true, messages: { 'shell.skip': 'Pular para o conteúdo' } }
  assert.equal(selectLanguage({ lang: 'pt' }, approved).lang, 'pt')
  assert.equal(selectLanguage({ lang: 'pt' }, approved).messages['shell.skip'], 'Pular para o conteúdo')
  assert.equal(selectLanguage({ lang: 'pt' }, approved).messages['shell.rail.label'], en['shell.rail.label'], 'missing pt keys fall back per key')
})

async function loadShell() {
  const { module } = await runnerImport(path.join(hub, 'web/src/shell/App.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

test('the shell renders zero, loading, populated, fallback-language and fatal states', async () => {
  const { App } = await loadShell()
  const render = (state, pathname = '/') => {
    const store = createDeckStore(state)
    return renderToStaticMarkup(createElement(App, { store, path: pathname, navigate: () => {}, onRetry: () => {} }))
  }
  const loading = render(initialState())
  assert.match(loading, /<a[^>]*class="sr-only-focusable[^"]*"[^>]*href="#main"[^>]*>Skip to main content<\/a>/)
  assert.match(loading, /<nav aria-label="Deck sections"/)
  assert.doesNotMatch(loading, /rail-badge/, 'no badge before the snapshot')
  assert.match(loading, /<main[^>]*id="main"[^>]*aria-busy="true"/)
  assert.match(loading, /Loading sessions/)
  assert.match(loading, /<h1 class="sr-only">Sessions<\/h1>/, 'the loading page has a level-one heading')
  assert.equal((loading.match(/class="skeleton-card/g) ?? []).length, 6)
  assert.match(loading, /role="status"/)

  const zero = reduce(reduce(initialState(), { type: 'resync' }), { type: 'message', message: snapshotMessage(1) })
  const zeroHtml = render({ ...zero, connection: { state: 'live', attempt: 0, nextAt: null } })
  assert.doesNotMatch(zeroHtml, /rail-badge/)
  assert.doesNotMatch(zeroHtml, /aria-busy="true"/)
  assert.match(zeroHtml, /<a[^>]*aria-current="page"[^>]*aria-label="Sessions"|<a[^>]*aria-label="Sessions"[^>]*aria-current="page"/)

  const busy = { ...zero, data: { ...zero.data, counts: counts(3) } }
  const busyHtml = render(busy)
  assert.match(busyHtml, /aria-label="Sessions, 3 need you"/)
  assert.match(busyHtml, /<span class="rail-badge" aria-hidden="true">3<\/span>/)
  const memoryHtml = render(busy, '/memory')
  assert.match(memoryHtml, /<a[^>]*aria-current="page"[^>]*aria-label="Memory"|<a[^>]*aria-label="Memory"[^>]*aria-current="page"/)
  assert.match(render(busy, '/nowhere'), /This page is not on the deck\./)

  const ptHtml = render({ ...zero, data: { ...zero.data, prefs: { lang: 'pt' } } })
  assert.match(ptHtml, new RegExp(en['shell.lang.fallback'].replace(/[.()]/g, '\\$&')))
  assert.doesNotMatch(zeroHtml, new RegExp(en['shell.lang.fallback'].replace(/[.()]/g, '\\$&')))

  const lost = render({ ...busy, connection: { state: 'reconnecting', attempt: 3, nextAt: Date.now() + 4000 }, lastEventAt: Date.UTC(2026, 8, 30, 18, 42) })
  assert.match(lost, /Lost the deck server\. Your ships are unaffected, reconnecting… \(attempt 3, next in [34]s\)/)
  assert.match(lost, /Retry now/)
  assert.match(lost, /shell--stale/)
  assert.doesNotMatch(lost, /skeleton-card/, 'a cached snapshot beats a skeleton')

  const many = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, tone: 'error', title: `toast ${i + 1}` }))
  const stackHtml = render({ ...busy, toasts: many })
  assert.equal((stackHtml.match(/<li class="toast /g) ?? []).length, 3, 'at most three toasts show')
  assert.match(stackHtml, /<p class="toast-more">\+2 more<\/p>/)
  assert.doesNotMatch(stackHtml, /toast 2</, 'the oldest toasts are the ones folded away')
  assert.match(stackHtml, /toast 3<[\s\S]*toast 4<[\s\S]*toast 5</, 'newest last')

  const fatal = render({ ...initialState(), connection: { state: 'token_invalid', attempt: 0, nextAt: null } })
  assert.match(fatal, /This tab&#x27;s key no longer matches the deck\./)
  assert.doesNotMatch(fatal, /<nav/)
  const outdated = render({ ...initialState(), connection: { state: 'client_outdated', attempt: 0, nextAt: null } })
  assert.match(outdated, /The deck was updated\. Reload/)
  assert.match(outdated, /<button[^>]*>Reload<\/button>/)
})

test('applyAppearance sets the text size as --text-base and reduced motion as data-motion on the root, and clears them', async () => {
  const { applyAppearance } = await loadShell()
  const props = new Map()
  const attrs = new Map()
  const root = {
    style: { setProperty: (key, value) => props.set(key, value), removeProperty: key => props.delete(key) },
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: key => attrs.delete(key)
  }
  applyAppearance(root, { textSize: 16, motion: 'reduce' })
  assert.equal(props.get('--text-base'), '16px')
  assert.equal(attrs.get('data-motion'), 'reduce')
  applyAppearance(root, { textSize: 13, motion: 'system' })
  assert.equal(props.get('--text-base'), '13px')
  assert.equal(attrs.has('data-motion'), false, 'system motion leaves the attribute off')
  applyAppearance(root, { textSize: 'huge' })
  assert.equal(props.has('--text-base'), false, 'an unknown size falls back to the stylesheet')
  applyAppearance(root, undefined)
  assert.equal(props.size + attrs.size, 0)
})

async function findChromium() {
  for (const candidate of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (!candidate) continue
    try { await access(candidate)
      return candidate } catch {}
  }
  return null
}

test('in Chromium the deck drops the fragment, authenticates the socket and shows a stale token without retrying', async t => {
  const executablePath = await findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the shell browser test')
  const { startDeckServer } = await import('../../server/main.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'shell-'))
  const token = 'a'.repeat(43)
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  await mkdir(state, { recursive: true, mode: 0o700 })
  await writeFile(path.join(state, 'token'), token, { mode: 0o600 })
  const out = path.join(dir, 'web')
  execFileSync('npm', ['run', 'build', '--', '--outDir', out], { cwd: hub, stdio: 'pipe' })
  const deck = await startDeckServer({ env, port: 0, staticDir: out, notifications: false, connectDeckd: async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }) })
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(async () => { await browser.close()
    await deck.close()
    await rm(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${deck.address().port}`
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const upgrades = []
  page.on('websocket', ws => upgrades.push(ws.url()))
  await page.goto(`${base}/memory#token=${token}`)
  await page.waitForSelector('nav[aria-label="Deck sections"] a[aria-current="page"][aria-label="Memory"]', { timeout: 5000 })
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') !== 'true', null, { timeout: 5000 })
  assert.equal(page.url(), `${base}/memory`)
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), TOKEN_KEY), token)
  assert.equal(upgrades.length, 1)
  assert.equal(await page.title(), 'Memory · fleetmates deck')
  await page.keyboard.press('Alt+Shift+Digit4')
  await page.waitForFunction(() => location.pathname === '/settings/rules', null, { timeout: 5000 })
  // Computed styles too, so the stylesheet is pinned to read --text-base and data-motion, not only the root to carry them.
  const appearance = () => page.evaluate(() => {
    const root = document.documentElement
    const probe = document.createElement('div')
    probe.className = 'motion-breathe'
    probe.style.transition = 'opacity var(--motion-duration-fast) linear'
    const drawer = document.createElement('div')
    drawer.className = 'drawer'
    document.body.append(probe, drawer)
    const result = {
      size: root.style.getPropertyValue('--text-base'), motion: root.getAttribute('data-motion'), body: getComputedStyle(document.body).fontSize,
      loop: getComputedStyle(probe).animationName, fade: getComputedStyle(probe).transitionDuration, drawer: getComputedStyle(drawer).animationName
    }
    probe.remove()
    drawer.remove()
    return result
  })
  // The reduced-motion stills: each loop's animation, the static rings and the scroll behaviour of a probe and of
  // the root, both set to smooth inline while they are read.
  const stills = () => page.evaluate(() => {
    const make = className => {
      const node = document.createElement('div')
      node.className = className
      node.style.scrollBehavior = 'smooth'
      document.body.append(node)
      return node
    }
    const nodes = {
      pulse: make('motion-pulse'), recPulse: make('motion-rec-pulse'), caret: make('motion-caret'), shimmer: make('motion-shimmer'),
      arrive: make('motion-arrive'), card: make('session-card motion-pulse')
    }
    const root = document.documentElement
    const rootScroll = root.style.scrollBehavior
    root.style.scrollBehavior = 'smooth'
    const style = name => getComputedStyle(nodes[name])
    const result = {
      pulse: style('pulse').animationName, recPulse: style('recPulse').animationName, caret: style('caret').animationName,
      shimmer: style('shimmer').animationName, arrive: style('arrive').animationName,
      pulseShadow: style('pulse').boxShadow, arriveShadow: style('arrive').boxShadow, cardShadow: style('card').boxShadow,
      scroll: style('pulse').scrollBehavior, rootScroll: getComputedStyle(root).scrollBehavior
    }
    for (const node of Object.values(nodes)) node.remove()
    root.style.scrollBehavior = rootScroll
    return result
  })
  const full = { loop: 'deck-breathe', fade: '0.1s', drawer: 'deck-drawer-in' }
  const reduced = { loop: 'none', fade: '0s', drawer: 'deck-fade-in' }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  assert.deepEqual(await appearance(), { size: '14px', motion: null, body: '14px', ...full }, 'the default appearance')
  const moving = await stills()
  assert.deepEqual([moving.pulse, moving.recPulse, moving.caret, moving.shimmer, moving.arrive, moving.scroll, moving.rootScroll],
    ['deck-pulse', 'deck-rec-pulse', 'deck-caret', 'deck-shimmer', 'deck-arrive', 'smooth', 'smooth'], 'with motion allowed the loops run')
  // A preference change arrives as prefs.changed over the socket; the shell re-applies it to the document root.
  // Motion and text size change in separate requests, so each one alone must reach the root.
  const patch = body => page.evaluate(async ([key, json]) => (await fetch('/api/prefs', { method: 'PATCH', headers: {
    Authorization: `Bearer ${sessionStorage.getItem(key)}`, 'X-Deck-Api': '1', 'Content-Type': 'application/json'
  }, body: json })).status, [TOKEN_KEY, JSON.stringify(body)])
  assert.equal(await patch({ motion: 'reduce' }), 200)
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'reduce', null, { timeout: 5000 })
  assert.deepEqual(await appearance(), { size: '14px', motion: 'reduce', body: '14px', ...reduced }, 'Always reduce motion alone')
  // Every loop of the reduced-motion list stops, the static replacements show, smooth scrolling turns off, and a
  // later sheet's `.session-card.motion-pulse` inset ring still wins (the `:where()` specificity in tokens.css).
  assert.deepEqual(await stills(), {
    pulse: 'none', recPulse: 'none', caret: 'none', shimmer: 'none', arrive: 'none',
    pulseShadow: 'rgb(122, 96, 54) 0px 0px 0px 1px', arriveShadow: 'rgba(230, 233, 247, 0.35) 0px 0px 0px 3px',
    cardShadow: 'rgb(122, 96, 54) 0px 0px 0px 1px inset', scroll: 'auto', rootScroll: 'auto'
  }, 'Always reduce motion stills every loop')
  assert.equal(await patch({ textSize: 16 }), 200)
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--text-base') === '16px', null, { timeout: 5000 })
  assert.deepEqual(await appearance(), { size: '16px', motion: 'reduce', body: '16px', ...reduced }, 'text size alone')
  // Motion back to system: without data-motion the OS preference governs.
  assert.equal(await patch({ motion: 'system' }), 200)
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-motion'), null, { timeout: 5000 })
  assert.deepEqual(await appearance(), { size: '16px', motion: null, body: '16px', ...full }, 'system motion, no OS preference')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // The media query redefines deck-drawer-in as a fade, so the drawer keeps its animation name there.
  assert.deepEqual(await appearance(), { size: '16px', motion: null, body: '16px', ...reduced, drawer: 'deck-drawer-in' }, 'system motion follows the OS preference')
  assert.deepEqual(errors, [])

  const stale = await browser.newPage()
  const staleUpgrades = []
  stale.on('websocket', ws => staleUpgrades.push(ws.url()))
  await stale.goto(`${base}/#token=${'b'.repeat(43)}`)
  await stale.waitForSelector('text=This tab\'s key no longer matches the deck.', { timeout: 5000 })
  assert.equal(stale.url(), `${base}/`)
  await stale.waitForTimeout(1500)
  assert.equal(staleUpgrades.length, 1, 'a stale token is never retried')
  assert.equal(await stale.locator('nav').count(), 0)
})
