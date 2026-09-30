import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import { chromium } from 'playwright-core'
import { captureToken, createApiClient, createConnection, wsProtocols, backoffMs, TOKEN_KEY } from '../../web/src/state/api.js'
import {
  createDeckStore, reduce, initialState, matchRoute, resolveRoute, keyAction, documentTitle, badgeText,
  selectLanguage, createAnnouncer, bannerFor, isRoute
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
    send(data) { this.sent.push(JSON.parse(data)) }
    close(code = 1000) { if (this.readyState === 3) return
      this.readyState = 3
      this.onclose?.({ code }) }
    open() { this.readyState = 1
      this.onopen?.({}) }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
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
  assert.deepEqual(created[0].sent, [{ t: 'hello', lastSeq: 0, epoch: null, apiVersion: 1, build: 'm1' }])
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
  assert.deepEqual(created[3].sent[0], { t: 'hello', lastSeq: 6, epoch: 'e1', apiVersion: 1, build: 'm1' })
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
  assert.equal(storage.getItem('fleetmates-deck.reloaded.m1'), '1')
  const second = make()
  second.socket.open()
  second.socket.drop(4410)
  await Promise.resolve()
  assert.equal(reloads, 1)
  assert.equal(second.store.getState().connection.state, 'client_outdated')
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
