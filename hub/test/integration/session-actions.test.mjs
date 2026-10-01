// M2 session actions (docs/deck/05-api.md section 2.3; state-machines rows 42, 46 and 50): Stop, Nudge,
// Relaunch, the scrollback read and the RepoView fields lastSessionAt and branch, against a real deckd started
// in this process with an injected login environment (no login shell runs) and the real server.
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { startDeckServer } from '../../server/main.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'

const token = 'a'.repeat(43)
// deckd spawns only `claude`, so the stub is found as `claude` on PATH.
const stubDir = fileURLToPath(new URL('./stubs/', import.meta.url))
const startFixture = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))

let rt
let deckd
let bin
let dir
let term
let hangScript
let scripts = 0

before(async () => {
  rt = await makeRuntimeDir()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-'))
  bin = await fakeBin({ version: '2.1.282' })
  // Launched spawns (Relaunch) take the login environment: the fake claude, waiting forever.
  hangScript = path.join(dir, 'hang.json')
  fs.writeFileSync(hangScript, JSON.stringify({ sessionId: 'auto', steps: [{ hang: true }] }))
  deckd = await startDeckd({ runtimeDir: rt.dir, loginEnv: { PATH: bin.env.PATH, HOME: dir, FAKE_CLAUDE_SCRIPT: hangScript, FAKE_CLAUDE_VERSION: '2.1.282' } })
  term = await connectDeckd({ runtimeDir: rt.dir, kind: 'terminal', name: 'test-terminal' })
})

after(async () => {
  term?.close()
  await deckd?.close()
  await bin?.cleanup()
  await rt?.cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function server(t) {
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const state = path.join(home, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(home, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const deck = await startDeckServer({ env: { HOME: home, XDG_RUNTIME_DIR: rt.dir }, port: 0, staticDir, notifications: false,
    runPollMs: 3_600_000, runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  t.after(() => deck.close())
  const origin = `http://127.0.0.1:${deck.address().port}`
  const request = async (route, method = 'GET') => {
    const response = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${token}`, Origin: origin } })
    return { status: response.status, data: await response.json() }
  }
  return { deck, home, request }
}

/** Spawn a wrapped PTY as `fm claude` would: the stub, or the fake claude running `steps`. */
async function spawnWrapped({ steps, log } = {}) {
  const cwd = fs.mkdtempSync(path.join(dir, 'repo-'))
  const argv = ['claude']
  const env = { PATH: [stubDir, process.env.PATH].join(path.delimiter), HOME: dir }
  if (steps) {
    const script = path.join(dir, `script-${++scripts}.json`)
    fs.writeFileSync(script, JSON.stringify({ sessionId: 'auto', steps }))
    Object.assign(env, { PATH: bin.env.PATH, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_VERSION: '2.1.282', ...(log ? { FAKE_CLAUDE_LOG: log } : {}) })
  }
  const reply = await term.request('spawn', { cwd, argv, cols: 120, rows: 40, origin: 'wrapped', env })
  return { ptyId: reply.ptyId, cwd }
}

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
const byId = (deck, id) => deck.projector.snapshot().sessions.find(row => row.id === id)

/** A row inserted straight into the store, for the refusals that need no process. */
function row(deck, id, fields) {
  deck.store.run("INSERT OR IGNORE INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES('/r','r',0,1,'r',0)")
  const values = { origin: 'wrapped', state: 'ended', alive: 0, pty_id: null, claude_session_id: null, started_at: 1000, repo_id: '/r', ...fields }
  deck.store.run('INSERT INTO sessions(id,origin,pty_id,process_key,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at,claude_session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, values.origin, values.pty_id, values.pty_id, values.repo_id, '/r', values.state, 1000, 1000, 1000, values.alive, values.started_at, values.claude_session_id)
}

test('Stop sets the stop flag, deckd ends the PTY with SIGTERM, and the session ends rather than crashes', async t => {
  const { deck, request } = await server(t)
  const { ptyId, cwd } = await spawnWrapped()
  const session = await until(() => sessionOf(deck, ptyId), 'the wrapped row')
  hook(deck, ptyId, cwd, 'SessionStart')
  hook(deck, ptyId, cwd, 'UserPromptSubmit', { prompt: 'work' })
  assert.equal(byId(deck, session.id).state, 'running')
  const exited = new Promise(resolve => { const off = term.on('exit', msg => { if (msg.ptyId === ptyId) { off()
    resolve(msg) } }) })
  const stopped = await request(`/api/sessions/${session.id}/stop`, 'POST')
  assert.equal(stopped.status, 202)
  assert.equal(stopped.data.session.id, session.id)
  assert.equal(deck.store.get('SELECT user_stop_requested FROM sessions WHERE id=?', session.id).user_stop_requested, 1)
  const exit = await exited
  assert.ok(exit.signal === 'SIGTERM' || exit.signal === 15 || exit.code === 143, `ended by SIGTERM: ${JSON.stringify(exit)}`)
  const ended = await until(() => !byId(deck, session.id).alive && byId(deck, session.id), 'the exit')
  assert.equal(ended.state, 'ended', 'row 42: a requested stop is never a crash')
  assert.equal(ended.crashKind, null)
})

test('Stop refuses observed, ended and crashed sessions with the listed errors', async t => {
  const { deck, request } = await server(t)
  row(deck, 'observed', { origin: 'observed', state: 'running', alive: 1 })
  row(deck, 'ended', { state: 'ended' })
  row(deck, 'crashed', { state: 'crashed' })
  for (const [id, status, code] of [['observed', 409, 'read_only_session'], ['ended', 409, 'invalid_state'], ['crashed', 409, 'invalid_state'], ['missing', 404, 'not_found']]) {
    const refused = await request(`/api/sessions/${id}/stop`, 'POST')
    assert.equal(refused.status, status, id)
    assert.equal(refused.data.error.code, code, id)
  }
  assert.equal(deck.store.get('SELECT user_stop_requested FROM sessions WHERE id=?', 'observed').user_stop_requested, 0)
})

test('Nudge types exactly one Enter with source deck into an idle session and refuses a running or observed one', async t => {
  const { deck, request } = await server(t)
  const log = path.join(dir, `nudge-${process.pid}.log`)
  const { ptyId, cwd } = await spawnWrapped({ steps: [{ expectInput: { match: '\\r', timeoutMs: 10_000 } }, { expectInput: { match: 'never', timeoutMs: 10_000 } }], log })
  const session = await until(() => sessionOf(deck, ptyId), 'the wrapped row')
  hook(deck, ptyId, cwd, 'SessionStart')
  assert.equal(byId(deck, session.id).state, 'idle')
  // A key sent before the fake set raw mode would reach it through the line discipline as \n.
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"ready"'), 'the fake to start')
  const inputs = []
  t.after(term.on('input', msg => { if (msg.ptyId === ptyId) inputs.push(msg) }))
  const nudged = await request(`/api/sessions/${session.id}/nudge`, 'POST')
  assert.equal(nudged.status, 202)
  await until(() => inputs.length, 'the input event')
  assert.deepEqual(inputs.map(msg => [msg.source, msg.bytes]), [[{ kind: 'deck' }, 1]])
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"expectInput"'), 'the fake to read it')
  const typed = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => typeof entry.input === 'string').map(entry => entry.input)
  assert.deepEqual(typed, ['\r'])

  hook(deck, ptyId, cwd, 'UserPromptSubmit', { prompt: 'work' })
  assert.equal(byId(deck, session.id).state, 'running')
  const refused = await request(`/api/sessions/${session.id}/nudge`, 'POST')
  assert.equal(refused.status, 409)
  assert.equal(refused.data.error.code, 'invalid_state')
  row(deck, 'observed-idle', { origin: 'observed', state: 'idle', alive: 1 })
  assert.equal((await request('/api/sessions/observed-idle/nudge', 'POST')).data.error.code, 'read_only_session')
  assert.equal(inputs.length, 1, 'nothing else was typed')
  await term.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 })
})

test('Relaunch of a crashed session spawns claude --resume <id> in the same deck session', async t => {
  const { deck, request } = await server(t)
  const { ptyId, cwd } = await spawnWrapped({ steps: [{ expectInput: { match: 'die', timeoutMs: 10_000 } }, { exit: { code: 1 } }] })
  const session = await until(() => sessionOf(deck, ptyId), 'the wrapped row')
  hook(deck, ptyId, cwd, 'SessionStart')
  await term.request('write', { ptyId, data: Buffer.from('die').toString('base64'), source: { kind: 'terminal' } })
  const crashed = await until(() => byId(deck, session.id).state === 'crashed' && byId(deck, session.id), 'the crash')
  assert.equal(crashed.claudeSessionId, `claude-${ptyId}`)
  const spawned = new Promise(resolve => { const off = term.on('spawned', msg => { off()
    resolve(msg) }) })
  const relaunched = await request(`/api/sessions/${session.id}/relaunch`, 'POST')
  assert.equal(relaunched.status, 202)
  const msg = await spawned
  assert.deepEqual(msg.argv, ['claude', '--resume', `claude-${ptyId}`])
  assert.equal(msg.origin, 'launched')
  assert.equal(msg.cwd, cwd)
  const after = byId(deck, session.id)
  assert.deepEqual([after.state, after.alive, after.ptyId, after.origin, after.crashKind], ['starting', true, msg.ptyId, 'launched', null])
  assert.equal(relaunched.data.session.id, session.id)
  assert.deepEqual(deck.projector.snapshot().sessions.filter(row => row.ptyId === msg.ptyId).map(row => row.id), [session.id], 'the deck session id is kept, no new row')
  const again = await request(`/api/sessions/${session.id}/relaunch`, 'POST')
  assert.equal(again.status, 409, 'only a crashed session relaunches')
  row(deck, 'observed-crash', { origin: 'observed', state: 'crashed' })
  assert.equal((await request('/api/sessions/observed-crash/relaunch', 'POST')).data.error.code, 'invalid_state', 'observed without a Claude session id')
  await term.request('kill', { ptyId: msg.ptyId, signal: 'SIGKILL', graceMs: 0 })
})

test('scrollback reads deckd for a live session and the stored tail after it exits', async t => {
  const { deck, request } = await server(t)
  const { ptyId } = await spawnWrapped()
  const session = await until(() => sessionOf(deck, ptyId), 'the wrapped row')
  let live
  for (const end = Date.now() + 10_000; ;) {
    live = await request(`/api/sessions/${session.id}/scrollback?lines=50`)
    if (live.status === 200 && live.data.text.includes('READY')) break
    assert.ok(Date.now() < end, `timed out reading the live scrollback: ${live.status} ${JSON.stringify(live.data).slice(0, 80)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(live.data.source, 'deckd')
  assert.equal(live.data.truncated, false)
  for (const bad of ['0', '5001', 'x']) assert.equal((await request(`/api/sessions/${session.id}/scrollback?lines=${bad}`)).status, 422, bad)
  await term.request('write', { ptyId, data: Buffer.from('last words\r').toString('base64'), source: { kind: 'terminal' } })
  await term.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 })
  await until(() => !byId(deck, session.id).alive, 'the exit')
  const stored = await request(`/api/sessions/${session.id}/scrollback`)
  assert.equal(stored.status, 200)
  assert.equal(stored.data.source, 'stored')
  assert.ok(stored.data.text.includes('last words'), 'the tail deckd kept at exit')
  row(deck, 'nothing', { origin: 'observed', state: 'ended' })
  assert.equal((await request('/api/sessions/nothing/scrollback')).status, 404)
})

test('GET /api/repos reports the HEAD branch, null when detached, and the newest session start', async t => {
  const { deck, request } = await server(t)
  const attached = fs.mkdtempSync(path.join(dir, 'attached-'))
  const detached = fs.mkdtempSync(path.join(dir, 'detached-'))
  for (const [root, head] of [[attached, 'ref: refs/heads/feature/combat\n'], [detached, `${'a'.repeat(40)}\n`]]) {
    fs.mkdirSync(path.join(root, '.git'))
    fs.writeFileSync(path.join(root, '.git/HEAD'), head)
  }
  deck.store.run('INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES(?,?,?,?,?)', attached, 'attached', 1, 'attached', 0)
  deck.store.run('INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES(?,?,?,?,?)', detached, 'detached', 2, 'detached', 0)
  row(deck, 'older', { repo_id: attached, started_at: 1000 })
  row(deck, 'newer', { repo_id: attached, started_at: 3000 })
  row(deck, 'middle', { repo_id: attached, started_at: 2000 })
  const repos = (await request('/api/repos')).data.repos
  const one = repos.find(repo => repo.id === attached)
  const two = repos.find(repo => repo.id === detached)
  assert.equal(one.branch, 'feature/combat')
  assert.equal(two.branch, null)
  assert.equal(one.lastSessionAt, 3000)
  assert.equal(two.lastSessionAt, null)
  assert.deepEqual(Object.keys(one.crew).sort(), ['hat', 'seed', 'slot', 'slotShared'], 'the nested crew object stays')
})
