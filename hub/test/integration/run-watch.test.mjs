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

/** Start the deck over home(); `setup(place)` runs first, so whatever it writes is on disk at startup. */
async function harness(t, setup = () => {}) {
  const place = home()
  setup(place)
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
  /** GET /api/runs as the Team page does on load. The server's priming pass at listen() already watches r1. */
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

/** A deck server over an injected run reader; returns the server and the run.updated events for r1. */
async function injected(t, place, runReader) {
  const deck = await startDeckServer({ env: place.env, port: 0, staticDir: place.staticDir, notifications: false,
    connectDeckd: async () => { throw Error('fake offline') }, reconnectMs: 600_000, runPollMs: 600_000, runReader,
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  t.after(async () => { await deck.close()
    fs.rmSync(place.dir, { recursive: true, force: true }) })
  const events = []
  deck.subscribe(event => events.push(event))
  const updates = () => events.filter(event => event.type === 'run.updated' && event.data.runId === 'r1')
  return { deck, updates }
}

/** A run reader whose list() resolves only when the test calls the matching entry of `releases`. */
function gatedReader(place, current) {
  const control = { fire: null, releases: [] }
  // Each call snapshots the run state at the moment the pass starts, as a real read would.
  control.reader = {
    list() {
      const seen = [{ repoId: place.repo, runId: 'r1', tasks: [{ id: 'T1', state: current() }], readError: null }]
      return new Promise(resolve => { control.releases.push(() => resolve(seen)) })
    },
    watch(callback) { control.fire = callback },
    close() {}
  }
  return control
}

/** Let every queued promise reaction run, so a released pass has finished before the next step. */
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('a watch event during a pass reruns the pass once it ends, publishing both states in order', async t => {
  const place = home()
  let state = 'pending'
  const gate = gatedReader(place, () => state)
  const { updates } = await injected(t, place, gate.reader)
  const { releases } = gate
  assert.equal(typeof gate.fire, 'function', 'the server registers a watch callback')
  // listen() starts the priming pass, which records 'pending' as the baseline. Release it and let it end, so
  // the watch-driven passes below are the only ones left; the baseline means 'pending' is never published.
  await waitFor(() => releases.length === 1, 2000, 'the priming pass to call list()')
  releases[0]()
  await settle()
  state = 'blocked'
  gate.fire()
  await waitFor(() => releases.length === 2, 2000, 'the first watch-driven pass to call list()')
  state = 'in_progress'
  gate.fire()
  await settle()
  assert.equal(releases.length, 2, 'passes never overlap')
  releases[1]()
  await waitFor(() => releases.length === 3, 2000, 'the rerun pass to call list()')
  releases[2]()
  await waitFor(() => updates().length === 2, 2000, 'run.updated for both states')
  assert.deepEqual(updates().map(event => event.data.tasks[0].state), ['blocked', 'in_progress'])
  assert.equal(releases.length, 3, 'list() ran exactly three times: priming, the first pass and its rerun')
})

test('a watch event during the priming pass reruns the pass once priming ends, publishing the change', async t => {
  const place = home()
  let state = 'pending'
  const gate = gatedReader(place, () => state)
  const { updates } = await injected(t, place, gate.reader)
  const { releases } = gate
  // The priming pass snapshots 'pending' and stays busy until released; the watch event lands meanwhile.
  await waitFor(() => releases.length === 1, 2000, 'the priming pass to call list()')
  state = 'in_progress'
  gate.fire()
  await settle()
  assert.equal(releases.length, 1, 'the watch event does not overlap the priming pass')
  releases[0]()
  await waitFor(() => releases.length === 2, 2000, 'the rerun after the priming pass to call list()')
  releases[1]()
  await waitFor(() => updates().length === 1, 2000, 'run.updated from the rerun')
  assert.equal(updates()[0].data.tasks[0].state, 'in_progress')
})

test('a failing priming list leaves the baseline empty, so the next pass publishes the unchanged run once', async t => {
  const place = home()
  let fire = null
  let calls = 0
  const runReader = {
    list() {
      calls += 1
      if (calls === 1) return Promise.reject(Error('first read fails'))
      return Promise.resolve([{ repoId: place.repo, runId: 'r1', tasks: [{ id: 'T1', state: 'pending' }], readError: null }])
    },
    watch(callback) { fire = callback },
    close() {}
  }
  const { updates } = await injected(t, place, runReader)
  await waitFor(() => calls === 1, 2000, 'the priming pass to call list()')
  await settle()
  assert.equal(updates().length, 0, 'the failed priming pass publishes nothing')
  fire()
  await waitFor(() => updates().length === 1, 2000, 'run.updated from the first successful pass')
  assert.equal(updates()[0].data.tasks[0].state, 'pending')
  fire()
  await waitFor(() => calls === 3, 2000, 'the third pass to call list()')
  await settle()
  assert.equal(updates().length, 1, 'the run is published once, then the recorded baseline holds')
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

test('a run present at start is watched without any client listing runs, and startup publishes nothing', async t => {
  const h = await harness(t)
  // No GET /api/runs and no WebSocket snapshot: only the server's own priming pass can attach the watcher.
  await waitFor(() => watchers() > h.before, 2000, 'the priming pass to watch the run directory')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(h.updates().length, 0, 'no run.updated at startup for an unchanged run')
  fs.writeFileSync(path.join(h.runDir, 'status.json'), JSON.stringify({ runId: 'r1', tasks: [{ id: 'T1', state: 'in_progress' }] }))
  await waitFor(() => h.updates().length === 1, 2000, 'run.updated after the edit')
  assert.equal(h.updates()[0].data.tasks[0].state, 'in_progress')
})

test('the priming pass records every run present at start, so editing one run publishes only that run', async t => {
  // Run r2 sits in the same repo as r1 before the server starts; only r1 is edited afterwards.
  const h = await harness(t, place => {
    const r2 = path.join(place.repo, '.fleetmates', 'r2')
    fs.mkdirSync(r2, { recursive: true })
    fs.writeFileSync(path.join(r2, 'plan.json'), JSON.stringify({ runId: 'r2', totalPhases: 1, tasks: [{ id: 'T1', title: 'First', phase: 1, files: [], deps: [] }] }))
    fs.writeFileSync(path.join(r2, 'status.json'), JSON.stringify({ runId: 'r2', tasks: [{ id: 'T1', state: 'pending' }] }))
  })
  // One watcher per listed run directory: both are watched once the priming pass has read them.
  await waitFor(() => watchers() === 2, 2000, 'the priming pass to watch both run directories')
  await new Promise(resolve => setTimeout(resolve, 100))
  fs.writeFileSync(path.join(h.runDir, 'status.json'), JSON.stringify({ runId: 'r1', tasks: [{ id: 'T1', state: 'in_progress' }] }))
  await waitFor(() => h.updates().length === 1, 2000, 'run.updated for r1 after the edit')
  await new Promise(resolve => setTimeout(resolve, 100))
  const published = h.events.filter(event => event.type === 'run.updated').map(event => event.data.runId)
  assert.deepEqual(published, ['r1'], 'the unchanged r2 matches its priming baseline and is not published')
})
