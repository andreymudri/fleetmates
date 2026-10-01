// M2 Task 3: PATCH /api/repos/:repoKey/crew, GET /api/runs/:repoKey/:runId/plan, POST /api/open and the
// run.updated poll. Each test drives the real deck server with a fake run reader and a fake opener.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { startDeckServer } from '../../server/main.mjs'

const token = 'a'.repeat(43)
const CAP = 256 * 1024

/** A private HOME with a token, a static page and a repo directory holding a plan. */
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rco-'))
  // A token-shaped variable, so a test can check child processes do not inherit it.
  const env = { HOME: dir, DECK_TEST_TOKEN: 'not-a-real-token' }
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const repo = path.join(dir, 'dev', 'alpha')
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'plan.md'), '# Plan\n\n- T1 build it\n')
  return { dir, env, staticDir, repo: fs.realpathSync(repo) }
}

async function harness(t, options = {}) {
  const place = home()
  const runs = []
  let reads = 0
  const opened = []
  const runReader = { async list() { reads++
    return structuredClone(runs) }, close() {} }
  const deck = await startDeckServer({ env: place.env, port: 0, staticDir: place.staticDir, notifications: false,
    connectDeckd: async () => { throw Error('fake offline') }, reconnectMs: 60_000, runPollMs: 3_600_000,
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }), runReader,
    services: { async open(...args) { opened.push(args) } }, ...options })
  t.after(async () => { await deck.close()
    fs.rmSync(place.dir, { recursive: true, force: true }) })
  const events = []
  deck.subscribe(event => events.push(event))
  const request = async (route, init = {}) => {
    const origin = `http://127.0.0.1:${deck.address().port}`
    const headers = { Authorization: `Bearer ${token}`, Origin: origin, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }
    const response = await fetch(origin + route, { ...init, headers })
    return { status: response.status, data: await response.json() }
  }
  const json = (route, method, body) => request(route, { method, body: JSON.stringify(body) })
  const addRepo = (id, name, slot, shared = 0) => deck.store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', id, name, slot, shared, name, 1)
  const crewRow = id => deck.store.get('SELECT crew_seed AS seed,crew_slot AS slot,crew_slot_shared AS shared,hat FROM repos WHERE id=?', id)
  return { deck, place, runs, opened, events, request, json, addRepo, crewRow, get reads() { return reads } }
}

/** Await a condition the server reaches on its own; the deadline only turns a hang into a failure. */
async function waitFor(fn) {
  const until = Date.now() + 5000
  while (!fn()) { assert.ok(Date.now() < until, 'timed out')
    await new Promise(resolve => setImmediate(resolve)) }
}

const upserts = h => h.events.filter(event => event.type === 'repo.upserted')

test('crew PATCH: Reroll seed, slot move and hat each persist and publish one repo.upserted', async t => {
  const h = await harness(t)
  h.addRepo('/r/alpha', 'alpha', 0)
  h.addRepo('/r/beta', 'beta', 1)
  const seed = await h.json('/api/repos/alpha/crew', 'PATCH', { seed: 'alpha#2' })
  assert.equal(seed.status, 200)
  assert.equal(seed.data.repo.crew.seed, 'alpha#2')
  assert.equal(h.crewRow('/r/alpha').seed, 'alpha#2')
  assert.equal(upserts(h).length, 1)
  assert.equal(upserts(h)[0].data.crew.seed, 'alpha#2')
  assert.equal(typeof upserts(h)[0].seq, 'number', 'repo.upserted is durable')
  const slot = await h.json('/api/repos/alpha/crew', 'PATCH', { slot: 5 })
  assert.equal(slot.data.repo.crew.slot, 5)
  assert.equal(h.crewRow('/r/alpha').slot, 5)
  assert.equal(upserts(h).length, 2)
  assert.equal(upserts(h)[1].data.crew.slot, 5)
  const hat = await h.json('/api/repos/alpha/crew?repoId=%2Fr%2Falpha', 'PATCH', { hat: 'cap' })
  assert.equal(hat.data.repo.crew.hat, 'cap')
  assert.equal(h.crewRow('/r/alpha').hat, 'cap')
  assert.equal(upserts(h).length, 3)
  assert.equal(upserts(h)[2].data.crew.hat, 'cap')
})

test('crew PATCH: a taken slot is 409 slot_taken and changes nothing; Undo restores the old values', async t => {
  const h = await harness(t)
  h.addRepo('/r/alpha', 'alpha', 0)
  h.addRepo('/r/beta', 'beta', 1)
  const taken = await h.json('/api/repos/alpha/crew', 'PATCH', { seed: 'alpha#3', hat: 'bandana', slot: 1 })
  assert.equal(taken.status, 409)
  assert.equal(taken.data.error.code, 'slot_taken')
  assert.deepEqual({ ...h.crewRow('/r/alpha') }, { seed: 'alpha', slot: 0, shared: 0, hat: 'none' })
  assert.equal(upserts(h).length, 0)
  await h.json('/api/repos/alpha/crew', 'PATCH', { seed: 'alpha#7', slot: 4, hat: 'bandana' })
  assert.deepEqual({ ...h.crewRow('/r/alpha') }, { seed: 'alpha#7', slot: 4, shared: 0, hat: 'bandana' })
  const undo = await h.json('/api/repos/alpha/crew', 'PATCH', { seed: 'alpha', slot: 0, hat: 'none' })
  assert.equal(undo.status, 200)
  assert.deepEqual({ ...h.crewRow('/r/alpha') }, { seed: 'alpha', slot: 0, shared: 0, hat: 'none' })
  assert.deepEqual(undo.data.repo.crew, { slot: 0, slotShared: false, seed: 'alpha', hat: 'none' })
})

test('crew PATCH: setting a slot clears crew_slot_shared; a shared holder does not take the slot', async t => {
  const h = await harness(t)
  h.addRepo('/r/alpha', 'alpha', 0)
  h.addRepo('/r/gamma', 'gamma', 0, 1)
  const moved = await h.json('/api/repos/gamma/crew', 'PATCH', { slot: 6 })
  assert.equal(moved.status, 200)
  assert.equal(moved.data.repo.crew.slotShared, false)
  assert.deepEqual({ ...h.crewRow('/r/gamma') }, { seed: 'gamma', slot: 6, shared: 0, hat: 'none' })
  h.addRepo('/r/delta', 'delta', 2, 1)
  assert.equal((await h.json('/api/repos/alpha/crew', 'PATCH', { slot: 2 })).status, 200)
})

test('crew PATCH: validation of seed, slot, hat and unknown fields; an unknown repo is 404', async t => {
  const h = await harness(t)
  h.addRepo('/r/alpha', 'alpha', 0)
  h.addRepo('/r/beta', 'beta', 1)
  for (const body of [{}, { seed: 'beta' }, { seed: 'alpha#1' }, { seed: 'alpha#1000' }, { seed: 'alpha#02' }, { seed: 'alpha#x' },
    { seed: 7 }, { slot: 9 }, { slot: -1 }, { slot: 1.5 }, { slot: '2' }, { hat: 'crown' }, { extra: true }, { hat: 'cap', extra: 1 }]) {
    const response = await h.json('/api/repos/alpha/crew', 'PATCH', body)
    assert.equal(response.status, 422, JSON.stringify(body))
    assert.equal(response.data.error.code, 'validation_failed')
  }
  assert.deepEqual({ ...h.crewRow('/r/alpha') }, { seed: 'alpha', slot: 0, shared: 0, hat: 'none' })
  assert.equal((await h.json('/api/repos/alpha/crew', 'PATCH', { seed: 'alpha#999' })).status, 200)
  assert.equal((await h.json('/api/repos/missing/crew', 'PATCH', { hat: 'cap' })).status, 404)
  assert.equal(upserts(h).length, 1)
})

test('plan read returns the markdown, and cuts it at 256 KiB with truncated: true', async t => {
  const h = await harness(t)
  h.addRepo(h.place.repo, 'alpha', 0)
  h.runs.push({ repoId: h.place.repo, runId: 'r1', planPath: 'docs/plan.md', tasks: [] }, { repoId: h.place.repo, runId: 'none', planPath: null, tasks: [] })
  const small = await h.request('/api/runs/alpha/r1/plan')
  assert.equal(small.status, 200)
  assert.deepEqual(small.data, { path: 'docs/plan.md', markdown: '# Plan\n\n- T1 build it\n', truncated: false })
  fs.writeFileSync(path.join(h.place.repo, 'docs', 'plan.md'), '#'.repeat(CAP + 100))
  const big = await h.request('/api/runs/alpha/r1/plan')
  assert.equal(big.data.truncated, true)
  assert.equal(big.data.markdown.length, CAP)
  fs.writeFileSync(path.join(h.place.repo, 'docs', 'plan.md'), '#'.repeat(CAP))
  assert.equal((await h.request('/api/runs/alpha/r1/plan')).data.truncated, false)
  assert.equal((await h.request('/api/runs/alpha/none/plan')).status, 404)
  assert.equal((await h.request('/api/runs/alpha/missing/plan')).status, 404)
  fs.rmSync(path.join(h.place.repo, 'docs', 'plan.md'))
  assert.equal((await h.request('/api/runs/alpha/r1/plan')).status, 404)
})

test('planPath outside the repo, a symlink leaving it, .desktop, an executable .md and a FIFO are 403 path_not_allowed', async t => {
  const h = await harness(t)
  h.addRepo(h.place.repo, 'alpha', 0)
  const outside = path.join(path.dirname(h.place.repo), 'outside.md')
  fs.writeFileSync(outside, '# secret\n')
  fs.symlinkSync(outside, path.join(h.place.repo, 'link.md'))
  fs.writeFileSync(path.join(h.place.repo, 'plan.desktop'), '[Desktop Entry]\nExec=true\n')
  fs.writeFileSync(path.join(h.place.repo, 'exec.md'), '# run me\n', { mode: 0o755 })
  fs.chmodSync(path.join(h.place.repo, 'exec.md'), 0o755)
  execFileSync('mkfifo', [path.join(h.place.repo, 'fifo.md')])
  const bad = ['../outside.md', 'link.md', 'plan.desktop', 'exec.md', 'fifo.md']
  for (const [i, planPath] of bad.entries()) h.runs.push({ repoId: h.place.repo, runId: `bad${i}`, planPath, tasks: [] })
  for (const [i, planPath] of bad.entries()) {
    const read = await h.request(`/api/runs/alpha/bad${i}/plan`)
    assert.equal(read.status, 403, `GET plan ${planPath}`)
    assert.equal(read.data.error.code, 'path_not_allowed')
    assert.doesNotMatch(JSON.stringify(read.data), /secret|run me|Desktop/)
    const open = await h.json('/api/open', 'POST', { kind: 'runPlan', ref: { repoId: h.place.repo, runId: `bad${i}` } })
    assert.equal(open.status, 403, `POST open ${planPath}`)
    assert.equal(open.data.error.code, 'path_not_allowed')
  }
  assert.deepEqual(h.opened, [])
})

test('POST /api/open runPlan calls services.open with exactly one absolute path; other kinds and bad refs are 422', async t => {
  const h = await harness(t)
  h.addRepo(h.place.repo, 'alpha', 0)
  h.runs.push({ repoId: h.place.repo, runId: 'r1', planPath: 'docs/plan.md', tasks: [] })
  const opened = await h.json('/api/open', 'POST', { kind: 'runPlan', ref: { repoId: h.place.repo, runId: 'r1' } })
  assert.equal(opened.status, 202)
  assert.deepEqual(h.opened, [[path.join(h.place.repo, 'docs', 'plan.md')]])
  assert.ok(path.isAbsolute(h.opened[0][0]))
  for (const kind of ['vaultNote', 'meetingNote', 'postmeetLog']) {
    const response = await h.json('/api/open', 'POST', { kind, ref: 'x' })
    assert.equal(response.status, 422, kind)
    assert.equal(response.data.error.code, 'validation_failed')
    assert.equal(response.data.error.details.reason, 'kind_not_available')
  }
  for (const body of [{ kind: 'shell', ref: 'x' }, { ref: { repoId: h.place.repo, runId: 'r1' } }, { kind: 'runPlan' }, { kind: 'runPlan', ref: 'r1' },
    { kind: 'runPlan', ref: { repoId: h.place.repo } }, { kind: 'runPlan', ref: { repoId: h.place.repo, runId: 7 } },
    { kind: 'runPlan', ref: { repoId: h.place.repo, runId: 'r1', path: '/etc/passwd' } }, { kind: 'runPlan', ref: [h.place.repo, 'r1'] },
    { kind: 'runPlan', ref: { repoId: h.place.repo, runId: 'r1' }, path: '/etc/passwd' }]) {
    const response = await h.json('/api/open', 'POST', body)
    assert.equal(response.status, 422, JSON.stringify(body))
    assert.notEqual(response.data.error.details?.reason, 'kind_not_available', JSON.stringify(body))
  }
  assert.equal((await h.json('/api/open', 'POST', { kind: 'runPlan', ref: { repoId: h.place.repo, runId: 'missing' } })).status, 404)
  assert.equal(h.opened.length, 1)
})

test('a POST body is still 422 on routes that take none', async t => {
  const h = await harness(t)
  const response = await h.json('/api/repos/rescan', 'POST', { scanRoot: '/' })
  assert.equal(response.status, 422)
  assert.equal(response.data.error.code, 'validation_failed')
  assert.equal((await h.json('/api/setup/hooks', 'POST', { force: true })).status, 422)
})

test('run.updated is published once per changed run and never on an unchanged read', async t => {
  const h = await harness(t, { runPollMs: 20 })
  h.runs.push({ repoId: '/r/alpha', runId: 'r1', tasks: [{ id: 'T1', state: 'pending' }] }, { repoId: '/r/alpha', runId: 'r2', tasks: [] })
  const updates = () => h.events.filter(event => event.type === 'run.updated')
  // Two reads after a change guarantee one full poll ran on the changed data (polls never overlap).
  const settle = async () => { const start = h.reads
    await waitFor(() => h.reads >= start + 2) }
  await settle()
  const first = updates().length
  await settle()
  await settle()
  assert.equal(updates().length, first, 'unchanged reads publish nothing')
  h.runs[0].tasks[0].state = 'working'
  await settle()
  await settle()
  assert.equal(updates().length, first + 1)
  const event = updates().at(-1)
  assert.equal(event.data.runId, 'r1')
  assert.equal(event.data.tasks[0].state, 'working')
  assert.equal(typeof event.seq, 'number', 'run.updated is durable')
  assert.equal(h.deck.store.get('SELECT COUNT(*) AS n FROM events WHERE type=?', 'run.updated').n, first + 1)
})

test('the production opener runs xdg-open with the one path as argv and without the deck token in its environment', async t => {
  const calls = []
  const h = await harness(t, { services: {}, runCommand: (file, args, env) => { calls.push({ file, args, env })
    return { status: 0, stdout: '', stderr: '' } } })
  h.addRepo(h.place.repo, 'alpha', 0)
  h.runs.push({ repoId: h.place.repo, runId: 'r1', planPath: 'docs/plan.md', tasks: [] })
  assert.equal((await h.json('/api/open', 'POST', { kind: 'runPlan', ref: { repoId: h.place.repo, runId: 'r1' } })).status, 202)
  const opens = calls.filter(call => call.file === 'xdg-open')
  assert.equal(opens.length, 1)
  assert.deepEqual(opens[0].args, [path.join(h.place.repo, 'docs', 'plan.md')])
  assert.equal(opens[0].env.HOME, h.place.dir)
  assert.equal(Object.keys(opens[0].env).some(key => /TOKEN/i.test(key)), false)
})
