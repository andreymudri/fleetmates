// The server's deckd link against a real deckd (started in this process with an injected login environment,
// so no login shell runs) and the fake claude: spawned rows, screen idle, exit capture, proto 1 and the input
// source write rule. Hooks are fed straight into the server's ingestor with the PTY's id, as deck-hook would.
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { startDeckServer } from '../../server/main.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { createProjector, PROMPT_GONE_REASON } from '../../server/machines/projector.mjs'
import { openDeckDb } from '../../server/db/index.mjs'
import { createDeckdLink } from '../../server/pty/link.mjs'
import { readStoredHistory } from '../../server/screen/history.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { runtimeBase } from '../../platform/index.mjs'

const token = 'a'.repeat(43)
const hooks = new URL('../fixtures/hooks/2.1.282/', import.meta.url)
const startFixture = JSON.parse(fs.readFileSync(new URL('SessionStart.startup.json', hooks)))
const editFixture = JSON.parse(fs.readFileSync(new URL('PreToolUse.Edit.json', hooks)))

let rt
let deckd
let bin
let dir
let term
let scripts = 0

before(async () => {
  rt = await makeRuntimeDir()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlk-'))
  bin = await fakeBin({ version: '2.1.282' })
  deckd = await startDeckd({ runtimeDir: rt.dir, version: '9.9.9', loginEnv: { PATH: bin.env.PATH, HOME: dir } })
  term = await connectDeckd({ runtimeDir: rt.dir, kind: 'terminal', name: 'test-terminal' })
})

after(async () => {
  term?.close()
  await deckd?.close()
  await bin?.cleanup()
  await rt?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A deck server on its own state dir, linked to the shared deckd; `runtimeDir` is its XDG_RUNTIME_DIR. */
async function server(t, { runtimeDir = rt.dir, ...options } = {}) {
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const env = { HOME: home, XDG_RUNTIME_DIR: runtimeDir }
  // Where the server reads its state for this env on this platform.
  const { state } = setupPaths(env)
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(home, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const deck = await startDeckServer({ env, port: 0, staticDir, notifications: false,
    runPollMs: 3_600_000, runCommand: () => ({ status: 0, stdout: '', stderr: '' }), ...options })
  t.after(() => deck.close())
  const published = []
  t.after(deck.subscribe(event => published.push(event)))
  return { deck, home, published }
}

/** Spawn the fake claude through deckd as `fm claude` would, running `steps`. */
async function spawnFake(steps, origin = 'wrapped') {
  const script = path.join(dir, `script-${++scripts}.json`)
  fs.writeFileSync(script, JSON.stringify({ sessionId: 'auto', steps }))
  const cwd = fs.mkdtempSync(path.join(dir, 'repo-'))
  const reply = await term.request('spawn', { cwd, argv: ['claude'], cols: 120, rows: 40, origin,
    env: { PATH: bin.env.PATH, HOME: dir, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_VERSION: '2.1.282' } })
  return { ptyId: reply.ptyId, cwd }
}

/** Feed one hook envelope for the PTY into the server, stamped now. */
function hook(deck, ptyId, cwd, event, fields = {}) {
  deck.ingest.receive(JSON.stringify({ v: 1, hookTs: Date.now(), ptyId, claudePid: null, pidChain: [], truncated: false,
    hook: { ...startFixture, session_id: `claude-${ptyId}`, cwd, hook_event_name: event, ...fields } }))
  deck.ingest.flush()
}

async function until(fn, what) {
  const end = Date.now() + 10_000
  for (;;) {
    const value = fn()
    if (value) return value
    assert.ok(Date.now() < end, `timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const sessionOf = (deck, ptyId) => deck.projector.snapshot().sessions.find(row => row.ptyId === ptyId)

test('without XDG_RUNTIME_DIR the link connects, and retries, under the runtimeBase fallback of its platform', async t => {
  const home = fs.mkdtempSync(path.join(dir, 'nox-'))
  const store = openDeckDb(path.join(home, 'deck.db'))
  const projector = createProjector({ store })
  t.after(() => store.close())
  for (const platform of ['darwin', 'linux', 'win32']) {
    const env = { HOME: home }
    const dirs = []
    const link = createDeckdLink({ env, platform, reconnectMs: 60_000, connectDeckd: async options => { dirs.push(options.runtimeDir)
      throw Error('fake offline') }, store, projector, publish: () => {} })
    await link.start()
    assert.equal(link.health().state, 'down')
    link.retry()
    await until(() => dirs.length === 2, 'the retry probe')
    link.close()
    assert.deepEqual(dirs, [runtimeBase({ env, platform }), runtimeBase({ env, platform })], platform)
  }
  assert.equal(runtimeBase({ env: { HOME: home }, platform: 'darwin' }), path.posix.join(home, 'Library', 'Caches', 'fleetmates-deck'))
})
const write = (deck, ptyId, text, kind = 'deck') => deck.link.request('write', { ptyId, data: Buffer.from(text).toString('base64'), source: { kind } })

test('a wrapped spawn becomes one starting row that did not join mid-life', async t => {
  const { deck } = await server(t)
  const { ptyId } = await spawnFake([{ echo: {} }])
  const row = await until(() => sessionOf(deck, ptyId), 'the spawned row')
  assert.equal(row.state, 'starting')
  assert.equal(row.origin, 'wrapped')
  assert.equal(row.joinedMidLife, false)
  assert.equal(deck.projector.snapshot().sessions.filter(session => session.ptyId === ptyId).length, 1)
})

test('a PTY found only by list at reconcile, after it took input, becomes a joined row with that input source', async t => {
  const { ptyId } = await spawnFake([{ echo: {} }])
  await term.request('write', { ptyId, data: Buffer.from('hi').toString('base64'), source: { kind: 'terminal', name: 'kitty' } })
  const { deck } = await server(t)
  assert.equal(deck.link.health().state, 'ok', 'reconciliation finished')
  const row = sessionOf(deck, ptyId)
  assert.equal(row.joinedMidLife, true)
  assert.equal(row.state, 'starting')
  assert.equal(row.lastInputFrom, 'terminal')
  assert.equal(row.lastInputName, 'kitty')
})

test('a launched spawned event creates no row', async t => {
  const { deck } = await server(t)
  const seen = new Promise(resolve => { const off = deck.link.on('spawned', msg => { off()
    resolve(msg) }) })
  const { ptyId } = await spawnFake([{ echo: {} }], 'launched')
  const msg = await seen
  assert.equal(msg.ptyId, ptyId)
  assert.equal(msg.origin, 'launched')
  assert.equal(sessionOf(deck, ptyId), undefined, 'the launch flow inserts launched rows, not the link')
})

test('the fake reaching idle-input after spinner moves a running PTY session to idle with no Stop hook', async t => {
  const { deck } = await server(t)
  const idles = []
  t.after(deck.link.onIdle(event => idles.push(event)))
  const { ptyId, cwd } = await spawnFake([{ frame: 'spinner' }, { expectInput: { match: 'go', timeoutMs: 10_000 } }, { frame: 'idle-input' }, { hang: true }])
  await until(() => sessionOf(deck, ptyId), 'the spawned row')
  hook(deck, ptyId, cwd, 'SessionStart')
  hook(deck, ptyId, cwd, 'UserPromptSubmit', { prompt: 'fix the flaky test' })
  assert.equal(sessionOf(deck, ptyId).state, 'running')
  await write(deck, ptyId, 'go')
  const session = await until(() => sessionOf(deck, ptyId).state === 'idle' && sessionOf(deck, ptyId), 'screen idle')
  assert.equal(session.stateSince >= session.startedAt, true)
  assert.ok(idles.some(event => event.ptyId === ptyId && event.sessionId === session.id), 'onIdle names the PTY and its session')
})

test('a permission-edit frame followed by idle-input with no hook expires the open request', async t => {
  const { deck, published } = await server(t)
  const { ptyId, cwd } = await spawnFake([{ frame: 'permission-edit' }, { expectInput: { match: 'go', timeoutMs: 10_000 } }, { frame: 'idle-input' }, { hang: true }])
  await until(() => sessionOf(deck, ptyId), 'the spawned row')
  hook(deck, ptyId, cwd, 'SessionStart')
  hook(deck, ptyId, cwd, 'UserPromptSubmit', { prompt: 'edit the file' })
  hook(deck, ptyId, cwd, 'PermissionRequest', { tool_name: 'Edit', tool_input: editFixture.tool_input })
  const session = sessionOf(deck, ptyId)
  assert.equal(session.state, 'needs_approval')
  const [request] = deck.projector.snapshot().requests.filter(row => row.sessionId === session.id)
  assert.equal(request.state, 'open')
  await write(deck, ptyId, 'go')
  await until(() => sessionOf(deck, ptyId).state === 'idle', 'the session to go idle')
  const closed = deck.projector.snapshot().requests.find(row => row.id === request.id)
  assert.equal(closed.state, 'expired')
  assert.equal(closed.expiredReason, PROMPT_GONE_REASON)
  assert.deepEqual(published.filter(event => event.type === 'request.closed').map(event => event.data.id), [request.id])
})

test('a process exiting 1 stores its last output as the session scrollback and ends crashed', async t => {
  const { deck } = await server(t)
  const { ptyId } = await spawnFake([{ expectInput: { match: 'go', timeoutMs: 10_000 } }, { print: 'final words before the crash\r\n' }, { exit: { code: 1 } }])
  const row = await until(() => sessionOf(deck, ptyId), 'the spawned row')
  await write(deck, ptyId, 'go')
  const ended = await until(() => sessionOf(deck, ptyId).state === 'crashed' && sessionOf(deck, ptyId), 'the crash')
  assert.equal(ended.exitCode, 1)
  assert.equal(ended.crashKind, 'exit')
  const stored = deck.store.get('SELECT text,truncated FROM session_scrollback WHERE session_id=?', row.id)
  assert.ok(stored, 'a session_scrollback row was written')
  assert.match(stored.text, /final words before the crash/)
  assert.equal(stored.truncated, 0)
})

test('an exit from a proto 2 deckd reaches the projector with the history of its exit record, which is stored', async t => {
  const { deck } = await server(t)
  const exits = []
  const signal = deck.projector.signal
  deck.projector.signal = (id, sig, at) => {
    if (sig.type === 'exit') exits.push(sig)
    return signal.call(deck.projector, id, sig, at)
  }
  t.after(() => { deck.projector.signal = signal })
  const { ptyId } = await spawnFake([{ expectInput: { match: 'go', timeoutMs: 10_000 } }, { print: 'history before the crash\r\n' }, { exit: { code: 1 } }])
  const row = await until(() => sessionOf(deck, ptyId), 'the spawned row')
  await write(deck, ptyId, 'go')
  await until(() => sessionOf(deck, ptyId).state === 'crashed', 'the crash')
  assert.equal(exits.length, 1)
  assert.equal(typeof exits[0].history?.data, 'string', 'the exit signal carries history.data')
  assert.match(exits[0].history.data, /history before the crash/)
  assert.equal(typeof exits[0].tail, 'string', 'the raw tail still goes along')
  const stored = deck.store.get('SELECT text FROM session_scrollback WHERE session_id=?', row.id)
  assert.deepEqual(readStoredHistory(stored.text), { text: exits[0].history.data, size: { cols: 120, rows: 40 } })
})

test('an exit record with history applied at reconcile, for a session that ended while the server was away, stores the history', async t => {
  const home = fs.mkdtempSync(path.join(dir, 'rec-'))
  const store = openDeckDb(path.join(home, 'deck.db'))
  const projector = createProjector({ store })
  t.after(() => store.close())
  const fake = replies => ({ proto: 2, deckdVersion: '9.9.9', request: async op => replies[op] ?? {}, on: () => () => {}, close() {} })
  const startedAt = Date.now()
  const first = createDeckdLink({ env: { XDG_RUNTIME_DIR: home }, connectDeckd: async () => fake({ list: { ptys: [{ ptyId: 'pty_rec', cwd: home, origin: 'wrapped', startedAt }] }, exits: { exits: [] } }), store, projector, publish: () => {} })
  await first.start()
  first.close()
  const id = store.get('SELECT id FROM sessions WHERE pty_id=?', 'pty_rec').id
  const history = { data: 'serialized \x1b[1mhistory\x1b[0m\r\nlast row', cols: 160, rows: 48 }
  const tail = Buffer.from('raw tail bytes\r\n').toString('base64')
  const second = createDeckdLink({ env: { XDG_RUNTIME_DIR: home }, connectDeckd: async () => fake({ list: { ptys: [] },
    exits: { exits: [{ ptyId: 'pty_rec', code: 0, signal: null, at: startedAt + 1, tail, history }] } }), store, projector, publish: () => {} })
  t.after(() => second.close())
  await second.start()
  const stored = store.get('SELECT text,truncated FROM session_scrollback WHERE session_id=?', id)
  assert.ok(stored, 'the reconciled exit wrote a session_scrollback row')
  assert.deepEqual(readStoredHistory(stored.text), { text: history.data, size: { cols: 160, rows: 48 } }, 'the history is stored, not the raw tail')
  assert.equal(store.get('SELECT alive FROM sessions WHERE id=?', id).alive, 0)
})

test('a deckd that answers proto 1 is ok with reason deckd_outdated and its version, and stores no exit tail', async t => {
  const runtime = fs.mkdtempSync(path.join(dir, 'rt-'))
  fs.chmodSync(runtime, 0o700)
  // Its own runtime dir holds its hook socket; the link still reaches the shared deckd, asking for proto 1.
  const { deck } = await server(t, { runtimeDir: runtime, connectDeckd: options => connectDeckd({ ...options, runtimeDir: rt.dir, proto: 1 }) })
  const row = deck.link.health()
  assert.equal(row.state, 'ok')
  assert.equal(row.reason, 'deckd_outdated')
  assert.equal(row.deckdVersion, '9.9.9')
  assert.equal(deck.link.proto, 1)
  const listed = (await (await fetch(`http://127.0.0.1:${deck.address().port}/api/health`, { headers: { Authorization: `Bearer ${token}` } })).json()).deps[0]
  assert.equal(listed.reason, 'deckd_outdated')
  const { ptyId } = await spawnFake([{ expectInput: { match: 'go', timeoutMs: 10_000 } }, { print: 'old deckd output\r\n' }, { exit: { code: 1 } }])
  const session = await until(() => sessionOf(deck, ptyId), 'the spawned row')
  await write(deck, ptyId, 'go')
  await until(() => sessionOf(deck, ptyId).state === 'crashed', 'the crash')
  assert.equal(deck.store.get('SELECT 1 AS n FROM session_scrollback WHERE session_id=?', session.id), undefined)
})

test('counted screen output writes last activity at most once per 5 s without publishing, and wakes a stale session at once', async t => {
  const home = fs.mkdtempSync(path.join(dir, 'out-'))
  const store = openDeckDb(path.join(home, 'deck.db'))
  let clock = 10_000
  const published = []
  const projector = createProjector({ store, now: () => clock, publish: event => published.push(event) })
  const listeners = new Map()
  const client = { proto: 2, deckdVersion: '9.9.9',
    request: async op => op === 'list' ? { ptys: [{ ptyId: 'pty_out', cwd: home, origin: 'wrapped', startedAt: 1000 }] } : op === 'exits' ? { exits: [] } : {},
    on(ev, fn) { listeners.set(ev, fn)
      return () => listeners.delete(ev) },
    close() {} }
  const link = createDeckdLink({ env: { XDG_RUNTIME_DIR: home }, connectDeckd: async () => client, now: () => clock, store, projector, publish: event => published.push(event) })
  t.after(() => { link.close()
    store.close() })
  await link.start()
  const id = store.get('SELECT id FROM sessions WHERE pty_id=?', 'pty_out').id
  store.run('UPDATE sessions SET state=?,last_activity_at=? WHERE id=?', 'running', 1000, id)
  const lines = Array.from({ length: 40 }, (_, row) => row === 2 ? 'a line of tool output' : '')
  const screen = at => { clock = at
    listeners.get('screen')({ ptyId: 'pty_out', rev: at, lines, cursor: { x: 0, y: 39 }, changedRows: [2] }) }
  const activity = () => store.get('SELECT last_activity_at AS at FROM sessions WHERE id=?', id).at
  const before = published.length
  screen(10_000)
  assert.equal(activity(), 10_000)
  screen(12_000)
  assert.equal(activity(), 10_000, 'within 5 s of the last write nothing is written')
  screen(15_000)
  assert.equal(activity(), 15_000)
  assert.deepEqual(published.slice(before).filter(event => event.type === 'session.upserted'), [], 'output alone publishes nothing')
  store.run('UPDATE sessions SET state=? WHERE id=?', 'stale', id)
  screen(15_500)
  assert.equal(store.get('SELECT state FROM sessions WHERE id=?', id).state, 'running', 'a stale session is not throttled')
  assert.equal(published.slice(before).filter(event => event.type === 'session.upserted').length, 1)
})

test('a hello deckd refuses is down with reason deckd_incompatible', async t => {
  const runtime = fs.mkdtempSync(path.join(dir, 'rt-'))
  fs.chmodSync(runtime, 0o700)
  const { deck } = await server(t, { runtimeDir: runtime, reconnectMs: 60_000, connectDeckd: options => connectDeckd({ ...options, runtimeDir: rt.dir, proto: 0 }) })
  const row = deck.link.health()
  assert.equal(row.state, 'down')
  assert.equal(row.reason, 'deckd_incompatible')
  assert.equal(deck.link.connected, false)
  await assert.rejects(deck.link.request('list'), { code: 'deckd_unavailable' })
})

test('50 browser writes publish one session.upserted for the input source', async t => {
  const { deck, published } = await server(t)
  const { ptyId } = await spawnFake([{ echo: {} }])
  const row = await until(() => sessionOf(deck, ptyId), 'the spawned row')
  let inputs = 0
  t.after(deck.link.on('input', msg => { if (msg.ptyId === ptyId) inputs++ }))
  const before = published.length
  for (let i = 0; i < 50; i++) await write(deck, ptyId, 'x', 'browser')
  await until(() => inputs === 50, 'the 50 input events')
  const upserts = published.slice(before).filter(event => event.type === 'session.upserted' && event.data.id === row.id)
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].data.lastInputFrom, 'browser')
  assert.equal(sessionOf(deck, ptyId).lastInputFrom, 'browser')
})
