// M2 Task 19: run-file watching. The deck server watches each run directory its run reader has listed, so a
// change to plan.json or status.json reaches the Team page as run.updated without waiting for the run poll.
// Each test drives the real deck server and the real run reader over a temporary repo, with the poll set to
// 10 minutes so only the watch can deliver the change inside the 2 s bound.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startDeckServer } from '../../server/main.mjs'
import { openDeckDb } from '../../server/db/index.mjs'

const token = 'a'.repeat(43)
const watchers = () => process.getActiveResourcesInfo().filter(name => name === 'FSEventWrap').length

/** A private HOME whose deck database already knows a repo holding run r1 on disk. */
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'))
  const repo = path.join(fs.realpathSync(dir), 'dev', 'alpha')
  const runDir = path.join(repo, '.fleetmates', 'r1')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({ runId: 'r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'First', phase: 1, files: [], deps: [] }] }))
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({ runId: 'r1', tasks: [{ id: 'T1', state: 'pending' }] }))
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const store = openDeckDb(path.join(state, 'deck.db'))
  store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', repo, 'alpha', 0, 0, 'alpha', 1)
  store.close()
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  return { dir, repo, runDir, staticDir, env: { HOME: dir, PATH: process.env.PATH } }
}

async function harness(t) {
  const place = home()
  // A closed watcher's handle is released on a later turn of the event loop, so the previous test's deck may
  // still count here. Nothing else in this file watches files, so every earlier watcher must reach zero.
  await waitFor(() => watchers() === 0, 2000, 'earlier watchers to close')
  const before = 0
  const deck = await startDeckServer({ env: place.env, port: 0, staticDir: place.staticDir, notifications: false,
    connectDeckd: async () => { throw Error('fake offline') }, reconnectMs: 600_000, runPollMs: 600_000,
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  t.after(async () => { await deck.close()
    fs.rmSync(place.dir, { recursive: true, force: true }) })
  const events = []
  deck.subscribe(event => events.push(event))
  const updates = () => events.filter(event => event.type === 'run.updated' && event.data.runId === 'r1')
  /** GET /api/runs as the Team page does on load; that first read finds the run and attaches its watcher. */
  const runs = async () => {
    const origin = `http://127.0.0.1:${deck.address().port}`
    const response = await fetch(origin + '/api/runs', { headers: { Authorization: `Bearer ${token}`, Origin: origin } })
    assert.equal(response.status, 200)
    return (await response.json()).runs
  }
  return { deck, ...place, before, events, updates, runs }
}

/** Await a condition the server reaches on its own; `ms` only turns a missed bound into a failure. */
async function waitFor(fn, ms, what) {
  const until = Date.now() + ms
  while (!fn()) {
    assert.ok(Date.now() < until, `timed out after ${ms} ms waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('editing status.json publishes run.updated within 2 s with the 10 minute poll', async t => {
  const h = await harness(t)
  assert.equal((await h.runs()).find(run => run.runId === 'r1').tasks[0].state, 'pending')
  assert.ok(watchers() > h.before, 'the run directory is watched')
  fs.writeFileSync(path.join(h.runDir, 'status.json'), JSON.stringify({ runId: 'r1', tasks: [{ id: 'T1', state: 'in_progress' }] }))
  const edited = Date.now()
  await waitFor(() => h.updates().length === 1, 2000, 'run.updated after the edit')
  assert.ok(Date.now() - edited < 2000)
  const event = h.updates()[0]
  assert.equal(event.data.tasks[0].state, 'in_progress')
  assert.equal(typeof event.seq, 'number', 'run.updated is durable')
})

test('an unreadable status.json publishes the unreadable state within 2 s', async t => {
  const h = await harness(t)
  assert.equal((await h.runs()).find(run => run.runId === 'r1').readError, null)
  fs.writeFileSync(path.join(h.runDir, 'status.json'), '{"runId": "r1", "tasks": [')
  await waitFor(() => h.updates().length === 1, 2000, 'run.updated for the unreadable file')
  assert.deepEqual(h.updates()[0].data.readError, { file: 'status.json', message: 'Malformed JSON' })
})

test('closing the deck server closes its run-directory watchers', async t => {
  const h = await harness(t)
  await h.runs()
  assert.ok(watchers() > h.before, 'the run directory is watched')
  await h.deck.close()
  await waitFor(() => watchers() === h.before, 2000, 'the watcher to close')
})

test('a watch event during a pass reruns the pass once it ends, publishing both states in order', async t => {
  const place = home()
  let fire = null
  const releases = []
  let state = 'pending'
  // list() resolves only when the test releases it, so the second watch event is certain to land mid-pass.
  // Each call snapshots the run state at the moment the pass starts, as a real read would.
  const runReader = {
    list() {
      const seen = [{ repoId: place.repo, runId: 'r1', tasks: [{ id: 'T1', state }], readError: null }]
      return new Promise(resolve => { releases.push(() => resolve(seen)) })
    },
    watch(callback) { fire = callback },
    close() {}
  }
  const deck = await startDeckServer({ env: place.env, port: 0, staticDir: place.staticDir, notifications: false,
    connectDeckd: async () => { throw Error('fake offline') }, reconnectMs: 600_000, runPollMs: 600_000, runReader,
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  t.after(async () => { await deck.close()
    fs.rmSync(place.dir, { recursive: true, force: true }) })
  const events = []
  deck.subscribe(event => events.push(event))
  const updates = () => events.filter(event => event.type === 'run.updated' && event.data.runId === 'r1')
  assert.equal(typeof fire, 'function', 'the server registers a watch callback')
  const startCalls = releases.length
  fire()
  await waitFor(() => releases.length === startCalls + 1, 2000, 'the first pass to call list()')
  state = 'in_progress'
  fire()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(releases.length, startCalls + 1, 'passes never overlap')
  releases[startCalls]()
  await waitFor(() => releases.length === startCalls + 2, 2000, 'the rerun pass to call list()')
  releases[startCalls + 1]()
  await waitFor(() => updates().length === 2, 2000, 'run.updated for both states')
  assert.deepEqual(updates().map(event => event.data.tasks[0].state), ['pending', 'in_progress'])
  assert.equal(releases.length - startCalls, 2, 'list() ran exactly twice')
})

test('a repo registered after the first read rebuilds the reader with the watch, so both repos publish within 2 s', async t => {
  const h = await harness(t)
  assert.ok((await h.runs()).some(run => run.runId === 'r1'))
  // Register repo beta with run r2 the same way home() registers alpha: a row in the deck database.
  const beta = path.join(path.dirname(h.repo), 'beta')
  const betaRun = path.join(beta, '.fleetmates', 'r2')
  fs.mkdirSync(betaRun, { recursive: true })
  fs.writeFileSync(path.join(betaRun, 'plan.json'), JSON.stringify({ runId: 'r2', totalPhases: 1, tasks: [{ id: 'T1', title: 'First', phase: 1, files: [], deps: [] }] }))
  fs.writeFileSync(path.join(betaRun, 'status.json'), JSON.stringify({ runId: 'r2', tasks: [{ id: 'T1', state: 'pending' }] }))
  const store = openDeckDb(path.join(h.dir, '.local/state/fleetmates/deck/deck.db'))
  store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', beta, 'beta', 1, 0, 'beta', 1)
  store.close()
  const listed = await h.runs()
  assert.ok(listed.some(run => run.runId === 'r1') && listed.some(run => run.runId === 'r2'), 'the second read lists both runs')
  fs.writeFileSync(path.join(h.runDir, 'status.json'), JSON.stringify({ runId: 'r1', tasks: [{ id: 'T1', state: 'in_progress' }] }))
  fs.writeFileSync(path.join(betaRun, 'status.json'), JSON.stringify({ runId: 'r2', tasks: [{ id: 'T1', state: 'in_progress' }] }))
  const updated = runId => h.events.some(event => event.type === 'run.updated' && event.data.runId === runId &&
    event.data.tasks[0].state === 'in_progress')
  await waitFor(() => updated('r1') && updated('r2'), 2000, 'run.updated for r1 and r2 after the edits')
})
