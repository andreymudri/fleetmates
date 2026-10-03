// Session archive over HTTP and the WebSocket (docs/plans/2026-10-02-deck-archive.md, Task 2; docs/deck/05-api.md
// section 2.3): the archive, unarchive and archive-finished routes, the `archived` query of GET /api/sessions, the
// `autoArchiveAfter` pref and the auto-archive sweep timer, against the real server with deckd offline.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { startDeckServer } from '../../server/main.mjs'

const token = 'a'.repeat(43)
const HOUR = 3_600_000
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))

async function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'))
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const opts = { env, port: 0, staticDir, notifications: false, connectDeckd: async () => { throw Error('fake offline') }, runPollMs: 3_600_000,
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }), ...options }
  let deck = await startDeckServer(opts)
  const origin = () => `http://127.0.0.1:${deck.address().port}`
  const request = async (route, init = {}) => {
    const response = await fetch(origin() + route, {
      ...init, headers: { Authorization: `Bearer ${token}`, Origin: origin(), 'Content-Type': 'application/json', ...init.headers }
    })
    return { status: response.status, data: await response.json() }
  }
  const send = (event, at, extra = {}) => {
    deck.ingest.receive(JSON.stringify({ v: 1, hookTs: at, ptyId: null, claudePid: null, pidChain: [], truncated: false,
      hook: { ...fixture, cwd: dir, hook_event_name: event, ...extra } }))
    deck.ingest.flush()
  }
  t.after(async () => { await deck.close()
    fs.rmSync(dir, { recursive: true, force: true }) })
  return { get deck() { return deck }, dir, env, request, send, origin,
    async restart(extra = {}) { await deck.close()
      deck = await startDeckServer({ ...opts, ...extra }) } }
}

/** Insert one session row directly, as session-actions.test.mjs does; `open` adds an open permission request. */
function row(deck, id, fields = {}) {
  deck.store.run("INSERT OR IGNORE INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES('/r','r',0,1,'r',0)")
  const values = { state: 'ended', alive: 0, started_at: 1000, ended_at: null, changed_files: '[]', open: false, ...fields }
  deck.store.run('INSERT INTO sessions(id,origin,pty_id,process_key,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at,ended_at,changed_files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, 'wrapped', null, null, '/r', '/r', values.state, values.ended_at ?? values.started_at, values.started_at, values.started_at, values.alive, values.started_at, values.ended_at, values.changed_files)
  if (values.open) deck.store.run("INSERT INTO requests(id,session_id,kind,tier,summary,state,source,match_key,created_at) VALUES(?,?,'permission','safe','ok','open','permission_request',?,?)", `r-${id}`, id, `m-${id}`, values.started_at)
}

async function waitFor(fn, what = 'condition') {
  const until = Date.now() + 4000
  while (!fn()) { assert.ok(Date.now() < until, `timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10)) }
}

const archived = (deck, id) => deck.store.get('SELECT archived_at, archived_by FROM sessions WHERE id=?', id)

test('archive by the owner, then archived=1 lists it, archived=0 does not, and unarchive brings it back', async t => {
  const h = await harness(t)
  row(h.deck, 'old', { started_at: 1000 })
  row(h.deck, 'new', { started_at: 2000 })
  row(h.deck, 'kept', { started_at: 3000 })
  const first = await h.request('/api/sessions/old/archive', { method: 'POST' })
  assert.equal(first.status, 200)
  assert.equal(first.data.session.id, 'old')
  assert.equal(first.data.session.archivedBy, 'owner')
  assert.equal(typeof first.data.session.archivedAt, 'number')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await h.request('/api/sessions/new/archive', { method: 'POST' })).status, 200)
  // Archiving twice is a no-op that still answers the session.
  const again = await h.request('/api/sessions/old/archive', { method: 'POST' })
  assert.equal(again.status, 200)
  assert.equal(again.data.session.archivedAt, first.data.session.archivedAt)

  const only = (await h.request('/api/sessions?archived=1')).data
  assert.deepEqual(only.sessions.map(session => session.id), ['new', 'old'], 'newest archivedAt first')
  assert.equal(only.nextBefore, null)
  const page = (await h.request('/api/sessions?archived=1&limit=1')).data
  assert.deepEqual(page.sessions.map(session => session.id), ['new'])
  assert.equal(page.nextBefore, page.sessions[0].archivedAt)
  const next = (await h.request(`/api/sessions?archived=1&limit=1&before=${page.nextBefore}`)).data
  assert.deepEqual(next.sessions.map(session => session.id), ['old'])
  assert.deepEqual((await h.request('/api/sessions?archived=0')).data.sessions.map(session => session.id), ['kept'])
  assert.deepEqual((await h.request('/api/sessions')).data.sessions.map(session => session.id), ['kept', 'new', 'old'], 'no parameter: as before')
  assert.equal((await h.request('/api/sessions?archived=yes')).status, 422)

  const back = await h.request('/api/sessions/old/unarchive', { method: 'POST' })
  assert.equal(back.status, 200)
  assert.equal(back.data.session.archivedAt, null)
  assert.equal(back.data.session.archivedBy, null)
  assert.deepEqual((await h.request('/api/sessions?archived=1')).data.sessions.map(session => session.id), ['new'])
  assert.equal((await h.request('/api/sessions/old/unarchive', { method: 'POST' })).status, 200, 'unarchive of a session that is not archived')
})

test('archive and unarchive of an unknown session are 404, and archive of a session needing the owner is 409 needs_you', async t => {
  const h = await harness(t)
  for (const action of ['archive', 'unarchive']) {
    const missing = await h.request(`/api/sessions/missing/${action}`, { method: 'POST' })
    assert.equal(missing.status, 404, action)
    assert.equal(missing.data.error.code, 'not_found', action)
  }
  h.send('SessionStart', 1000)
  h.send('PermissionRequest', 2000, { tool_name: 'Bash', tool_input: { command: 'pwd' } })
  const id = h.deck.projector.snapshot().sessions[0].id
  const refused = await h.request(`/api/sessions/${id}/archive`, { method: 'POST' })
  assert.equal(refused.status, 409)
  assert.equal(refused.data.error.code, 'needs_you')
  assert.equal(archived(h.deck, id).archived_at, null)
  assert.equal((await h.request(`/api/sessions/${id}/archive`, { method: 'POST', body: '{"by":"auto"}' })).status, 422, 'the routes take no body')
})

test('archive-finished archives only finished sessions without unreviewed changes and returns their ids', async t => {
  const h = await harness(t)
  row(h.deck, 'ended', { state: 'ended', ended_at: 2000 })
  row(h.deck, 'crashed', { state: 'crashed' })
  row(h.deck, 'reviewed', { state: 'reviewed' })
  row(h.deck, 'live', { state: 'running', alive: 1 })
  row(h.deck, 'changed', { state: 'done', changed_files: '[{"path":"a.txt","adds":1,"dels":0}]' })
  row(h.deck, 'asking', { state: 'ended', open: true })
  const swept = await h.request('/api/sessions/archive-finished', { method: 'POST' })
  assert.equal(swept.status, 200)
  assert.deepEqual([...swept.data.ids].sort(), ['crashed', 'ended', 'reviewed'])
  for (const id of ['crashed', 'ended', 'reviewed']) assert.equal(archived(h.deck, id).archived_by, 'owner', id)
  for (const id of ['live', 'changed', 'asking']) assert.equal(archived(h.deck, id).archived_at, null, id)
  assert.deepEqual((await h.request('/api/sessions/archive-finished', { method: 'POST' })).data.ids, [], 'nothing left to archive')
})

test('every new route refuses a request without the token with 401', async t => {
  const h = await harness(t)
  row(h.deck, 'one')
  for (const [route, method] of [['/api/sessions/one/archive', 'POST'], ['/api/sessions/one/unarchive', 'POST'], ['/api/sessions/archive-finished', 'POST'], ['/api/sessions?archived=1', 'GET']]) {
    const response = await fetch(h.origin() + route, { method, headers: { Origin: h.origin() } })
    assert.equal(response.status, 401, route)
  }
  assert.equal(archived(h.deck, 'one').archived_at, null)
})

test('autoArchiveAfter defaults to 24 in the DB prefs and accepts only 6, 12, 24, 72, 168 or null', async t => {
  const h = await harness(t)
  const prefs = (await h.request('/api/prefs')).data
  assert.equal(prefs.prefs.autoArchiveAfter, 24)
  assert.equal(prefs.sources.autoArchiveAfter, 'default')
  for (const value of [7, 0, '24', 24.5, false]) assert.equal((await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ autoArchiveAfter: value }) })).status, 422, String(value))
  for (const value of [6, 12, 24, 72, null, 168]) {
    const set = await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ autoArchiveAfter: value }) })
    assert.equal(set.status, 200, String(value))
    assert.equal(set.data.prefs.autoArchiveAfter, value)
    assert.equal(set.data.sources.autoArchiveAfter, 'db')
  }
  assert.equal(JSON.parse(h.deck.store.get('SELECT value FROM prefs WHERE key=?', 'autoArchiveAfter').value), 168)
  assert.equal(fs.existsSync(path.join(h.dir, '.config/fleetmates/deck/config.json')), false, 'not a config file key')
})

// An injected clock far from the real one: the rows' ages are measured against it, not against Date.now().
const BASE = 1_900_000_000_000
const clock = () => { const started = Date.now()
  return () => BASE + (Date.now() - started) }

test('the sweep timer archives a finished session ended 7 hours ago as auto, and not one ended 5 hours ago', async t => {
  const h = await harness(t, { now: clock(), archiveSweepMs: 50 })
  assert.equal((await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ autoArchiveAfter: 6 }) })).status, 200)
  row(h.deck, 'seven', { ended_at: BASE - 7 * HOUR, started_at: BASE - 8 * HOUR })
  row(h.deck, 'five', { ended_at: BASE - 5 * HOUR, started_at: BASE - 6 * HOUR })
  await waitFor(() => archived(h.deck, 'seven').archived_at !== null, 'the sweep')
  assert.equal(archived(h.deck, 'seven').archived_by, 'auto')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(archived(h.deck, 'five').archived_at, null)
})

test('the sweep runs once at start with the stored autoArchiveAfter', async t => {
  const h = await harness(t, { now: clock(), archiveSweepMs: 3_600_000 })
  assert.equal((await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ autoArchiveAfter: 6 }) })).status, 200)
  row(h.deck, 'seven', { ended_at: BASE - 7 * HOUR, started_at: BASE - 8 * HOUR })
  row(h.deck, 'changed', { ended_at: BASE - 7 * HOUR, started_at: BASE - 8 * HOUR, changed_files: '[{"path":"a.txt","adds":1,"dels":0}]' })
  assert.equal(archived(h.deck, 'seven').archived_at, null)
  await h.restart()
  assert.equal(archived(h.deck, 'seven').archived_by, 'auto', 'archived before the server answers')
  assert.equal(archived(h.deck, 'changed').archived_at, null, 'unreviewed changes are never auto-archived')
})

test('a prefs.changed for autoArchiveAfter sweeps at once, and null (Never) archives nothing', async t => {
  const h = await harness(t, { now: clock(), archiveSweepMs: 3_600_000 })
  assert.equal((await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ autoArchiveAfter: null }) })).status, 200)
  row(h.deck, 'thirty', { ended_at: BASE - 30 * HOUR, started_at: BASE - 31 * HOUR })
  row(h.deck, 'seven', { ended_at: BASE - 7 * HOUR, started_at: BASE - 8 * HOUR })
  assert.equal((await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ textSize: 16 }) })).status, 200)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(archived(h.deck, 'thirty').archived_at, null, 'Never: no sweep archives')
  assert.equal((await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ autoArchiveAfter: 24 }) })).status, 200)
  await waitFor(() => archived(h.deck, 'thirty').archived_at !== null, 'the sweep after the pref change')
  assert.equal(archived(h.deck, 'thirty').archived_by, 'auto')
  assert.equal(archived(h.deck, 'seven').archived_at, null, '7 hours is under 24')
})

test('an archived live session that gets a permission hook on the hook socket is unarchived, and the WebSocket says so', async t => {
  const h = await harness(t)
  h.send('SessionStart', Date.now() - 1000)
  const id = h.deck.projector.snapshot().sessions[0].id
  assert.equal((await h.request(`/api/sessions/${id}/archive`, { method: 'POST' })).data.session.archivedBy, 'owner')
  assert.deepEqual((await h.request('/api/sessions?archived=1')).data.sessions.map(session => session.id), [id])

  const ws = new WebSocket(`ws://127.0.0.1:${h.deck.address().port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { origin: h.origin() })
  t.after(() => ws.terminate())
  const messages = []
  ws.on('message', raw => messages.push(JSON.parse(raw)))
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', apiVersion: 1, lastSeq: 0, epoch: null })))
  await waitFor(() => messages.some(message => message.t === 'snapshot'), 'the snapshot')
  const snapshot = messages.find(message => message.t === 'snapshot').data
  assert.equal(snapshot.sessions.find(session => session.id === id).archivedBy, 'owner')
  assert.equal(snapshot.counts.archived, 1)

  const sock = net.connect(path.join(h.env.XDG_RUNTIME_DIR, 'fleetmates-deck/hooks.sock'))
  await once(sock, 'connect')
  sock.end(JSON.stringify({ v: 1, hookTs: Date.now(), ptyId: null, claudePid: null, pidChain: [], truncated: false,
    hook: { ...fixture, cwd: h.dir, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pwd' } } }) + '\n')
  await once(sock, 'close')
  await waitFor(() => messages.some(message => message.t === 'request.opened'), 'request.opened')
  await waitFor(() => messages.some(message => message.t === 'session.upserted' && message.data.id === id && message.data.archivedAt === null), 'the unarchived session.upserted')
  const upserted = messages.find(message => message.t === 'session.upserted' && message.data.id === id && message.data.archivedAt === null)
  assert.equal(upserted.data.archivedBy, null)
  await waitFor(() => messages.some(message => message.t === 'counts' && message.data.archived === 0), 'counts.archived back to 0')
  assert.equal(archived(h.deck, id).archived_at, null)
})
