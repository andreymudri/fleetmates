import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openDeckDb } from '../../server/db/index.mjs'
import { readConfig } from '../../server/meetings/config.mjs'
import { findNote } from '../../server/meetings/note.mjs'
import { createPostWatch } from '../../server/meetings/post-watch.mjs'
import { addPin, getMeeting, pins, upsertMeeting } from '../../server/meetings/store.mjs'
import { writeMeetingsTree } from '../helpers/meetings-tree.mjs'

// Meetings and scribed run on Linux only (docs/deck/16-platforms.md section 1). FLEETMATES_TEST_FORCE_WINDOWS=1
// shows the skip on Linux, as it does for posixTest.
const LINUX_ONLY = (process.platform !== 'linux' || process.env.FLEETMATES_TEST_FORCE_WINDOWS === '1') && 'meetings and scribed are Linux only (16-platforms section 1)'

const MINUTE = 60 * 1000

async function withTree (fn, { variants = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-pw-'))
  const store = openDeckDb(path.join(root, 'private', 'deck.db'))
  const watches = []
  try {
    const tree = await writeMeetingsTree(root, undefined, { variants })
    const config = readConfig(tree.configPath, { home: root })
    assert.equal(config.ok, true)
    const published = []
    const make = options => {
      const w = createPostWatch({ store, config: () => config, publish: event => published.push(event), ...options })
      watches.push(w)
      return w
    }
    await fn({ root, store, tree, config, published, make })
  } finally {
    for (const w of watches) w.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

/** Timers whose callbacks run only when the test calls `fire()`. */
function manualTimers () {
  let pending = new Map()
  let next = 1
  return {
    setTimeout: (fn) => { const id = next++; pending.set(id, fn); return id },
    clearTimeout: id => { pending.delete(id) },
    fire () { const due = [...pending.values()]; pending = new Map(); for (const fn of due) fn() },
    count: () => pending.size
  }
}

const noWatch = () => ({ close () {}, on () {}, unref () {} })

async function until (check, label, ms = 5000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Write `session.json` the way a careful writer does: a temporary file renamed over the target. */
async function writeManifest (dir, id, state, tag = 'pessoal') {
  const tmp = path.join(dir, '.session.json.tmp')
  await writeFile(tmp, JSON.stringify({ session_id: id, tag, started_at: '2026-09-12T15:00:00-03:00', state }), { mode: 0o600 })
  await rename(tmp, path.join(dir, 'session.json'))
}

async function freshSession (tree, id) {
  const dir = path.join(tree.sessionDir, id)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

const updates = published => published.filter(e => e.type === 'meeting.updated')

test('writing recorded, transcribed, awaiting_names, transcribed, synthesized in turn publishes five meeting.updated in that order', { skip: LINUX_ONLY }, async () => withTree(async ({ store, tree, published, make }) => {
  // The poll never fires here (manual timers): fs.watch alone drives each step.
  const id = '2026-09-12T15-30-00'
  const dir = await freshSession(tree, id)
  upsertMeeting(store, { id, tag: 'pessoal', confidential: false, state: 'stopping', startedAt: 1, endedAt: null, sessionDir: dir, notePath: null, at: 1 })
  const w = make({ timers: manualTimers() })
  w.watch(id)
  const states = ['recorded', 'transcribed', 'awaiting_names', 'transcribed', 'synthesized']
  for (const [i, state] of states.entries()) {
    await writeManifest(dir, id, state)
    await until(() => updates(published).length === i + 1, `update ${i + 1} (${state})`)
  }
  const events = updates(published)
  assert.deepEqual(events.map(e => e.data.state), states)
  for (const e of events) {
    assert.equal(e.entityId, id)
    assert.equal(typeof e.seq, 'number')
    assert.equal(e.data.stuck, false)
    assert.equal(e.data.interrupted, false)
    assert.equal('title' in e.data, false)
  }
  assert.equal(getMeeting(store, id).state, 'synthesized')
  assert.deepEqual(w.watching(), [])
}))

test('with watch replaced by a no-op, the 10 s poll alone sees each change', async () => withTree(async ({ store, tree, published, make }) => {
  const id = '2026-09-12T15-31-00'
  const dir = await freshSession(tree, id)
  upsertMeeting(store, { id, tag: 'pessoal', confidential: false, state: 'stopping', startedAt: 1, endedAt: null, sessionDir: dir, notePath: null, at: 1 })
  const timers = manualTimers()
  const delays = []
  const w = make({ watch: noWatch, timers: { ...timers, setTimeout: (fn, ms) => { delays.push(ms); return timers.setTimeout(fn, ms) } } })
  w.watch(id)
  await until(() => timers.count() === 1, 'the first poll to be armed')
  assert.equal(delays[0], 10000)
  for (const [i, state] of ['recorded', 'transcribed'].entries()) {
    await writeManifest(dir, id, state)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(updates(published).length, i, `nothing seen before the poll fires (${state})`)
    timers.fire()
    await until(() => updates(published).length === i + 1, `the poll to see ${state}`)
  }
  assert.deepEqual(updates(published).map(e => e.data.state), ['recorded', 'transcribed'])
}))

test('stuck becomes true after 10 quiet minutes without a held lock', async () => withTree(async ({ store, tree, published, make }) => {
  const id = '2026-09-12T15-32-00'
  const dir = await freshSession(tree, id)
  await writeManifest(dir, id, 'transcribed')
  await writeFile(path.join(dir, 'postmeet.log'), 'transcrevendo\n', { mode: 0o600 })
  const logTime = new Date(Date.now())
  await utimes(path.join(dir, 'postmeet.log'), logTime, logTime)
  upsertMeeting(store, { id, tag: 'pessoal', confidential: false, state: 'transcribed', startedAt: 1, endedAt: null, sessionDir: dir, notePath: null, at: 1 })
  let clock = logTime.getTime() + 9 * MINUTE
  const timers = manualTimers()
  const w = make({ watch: noWatch, timers, now: () => clock })
  w.watch(id)
  await until(() => timers.count() === 1, 'the first poll to be armed')
  timers.fire()
  await until(() => timers.count() === 1, 'the poll to re-arm')
  assert.equal(updates(published).length, 0, 'nine quiet minutes are not stuck')
  clock = logTime.getTime() + 10 * MINUTE + 1000
  timers.fire()
  await until(() => updates(published).length === 1, 'the stuck update')
  const [event] = updates(published)
  assert.equal(event.data.state, 'transcribed')
  assert.equal(event.data.stuck, true)
  assert.equal(event.entityId, id)
  assert.deepEqual(w.watching(), [id], 'a stuck meeting stays watched')
}))

test('synthesized stops the watch and stores notePath for pessoal and null for client-a', async () => withTree(async ({ store, tree, published, make }) => {
  const looked = []
  const spy = async where => { looked.push(where.id); return findNote(where) }
  const w = make({ watch: noWatch, timers: manualTimers(), findNote: spy })
  const cases = [['planning', 'pessoal', false], ['weekly', 'client-a', true]]
  for (const [key, tag, confidential] of cases) {
    const id = tree.ids[key]
    upsertMeeting(store, { id, tag, confidential, state: 'transcribed', startedAt: 1, endedAt: null, sessionDir: path.join(tree.sessionDir, id), notePath: null, at: 1 })
    w.watch(id)
  }
  await until(() => updates(published).length === 2, 'both synthesized updates')
  assert.equal(getMeeting(store, tree.ids.planning).notePath, tree.notes.planning)
  assert.equal(getMeeting(store, tree.ids.weekly).notePath, null)
  assert.deepEqual(looked, [tree.ids.planning], 'the note of a confidential meeting is never looked up')
  const row = store.get('SELECT note_path FROM meetings WHERE id = ?', tree.ids.weekly)
  assert.equal(row.note_path, null)
  assert.deepEqual(w.watching(), [])
}))

test('a session directory removed from the tree loses its row on the next sync', async () => withTree(async ({ store, tree, make }) => {
  const w = make({ watch: noWatch, timers: manualTimers() })
  await w.sync()
  for (const id of tree.ids.meetings) assert.ok(getMeeting(store, id), `row for ${id}`)
  await rm(path.join(tree.sessionDir, tree.ids.retro), { recursive: true })
  await w.sync()
  assert.equal(getMeeting(store, tree.ids.retro), null)
  assert.ok(getMeeting(store, tree.ids.planning))
}))

test('a session whose tag is not in the config is stored confidential', async () => withTree(async ({ store, tree, config, make }) => {
  const id = '2026-09-12T15-33-00'
  const dir = await freshSession(tree, id)
  await writeManifest(dir, id, 'synthesized', 'acme')
  // A policy that knows only the configured tags and answers nothing for any other.
  const known = tag => config.tags.find(entry => entry.tag === tag)
  const w = make({ watch: noWatch, timers: manualTimers(), policy: known })
  await w.sync()
  assert.equal(getMeeting(store, id).confidential, true)
  assert.equal(getMeeting(store, tree.ids.planning).confidential, false)
  assert.equal(getMeeting(store, tree.ids.weekly).confidential, true)
}))

test('sync watches the sessions not synthesized and not interrupted, with the derived flags', async () => withTree(async ({ store, tree, published, make }) => {
  // The interrupted variant has no manifest; give it a row the way the recorder would have made one.
  upsertMeeting(store, { id: tree.ids.interrupted, tag: 'client-b', confidential: true, state: 'recording', startedAt: 1, endedAt: null, sessionDir: null, notePath: null, at: 1 })
  const looked = []
  const spy = async where => { looked.push(where.id); return findNote(where) }
  const w = make({ watch: noWatch, timers: manualTimers(), findNote: spy })
  await w.sync()
  assert.ok(looked.includes(tree.ids.planning), 'the note of a pessoal meeting is looked up')
  assert.equal(looked.includes(tree.ids.weekly), false, 'the note of a confidential meeting is never looked up')
  assert.equal(looked.includes(tree.ids.contract), false, 'the note of a client-b meeting is never looked up')
  assert.deepEqual(w.watching().sort(), [tree.ids.awaitingNames, tree.ids.stuck].sort())
  const interrupted = updates(published).find(e => e.entityId === tree.ids.interrupted)
  assert.equal(interrupted.data.state, 'stopping')
  assert.equal(interrupted.data.interrupted, true)
  assert.equal(getMeeting(store, tree.ids.planning).notePath, tree.notes.planning, 'sync finds the note of a synthesized meeting')
  assert.equal(getMeeting(store, tree.ids.weekly).notePath, null)
  looked.length = 0
  await w.sync()
  assert.deepEqual(looked, [], 'a row that already holds its notePath is not looked up again')
}, { variants: ['awaitingNames', 'stuck', 'interrupted'] }))

test('a missing session_dir keeps every row and its pin, stops every watch and reports it', async () => withTree(async ({ store, tree, config, make }) => {
  let current = config
  const timers = manualTimers()
  const w = make({ watch: noWatch, timers, config: () => current })
  assert.equal((await w.sync()).ok, true)
  assert.deepEqual(w.watching(), [tree.ids.awaitingNames])
  const { pin } = addPin(store, tree.ids.retro, { t: 12, label: 'ligar o flag', at: 5 })
  current = { ...config, sessionDir: path.join(tree.sessionDir, 'gone') }
  const result = await w.sync()
  for (const id of tree.ids.meetings) assert.ok(getMeeting(store, id), `row kept for ${id}`)
  assert.deepEqual(pins(store, tree.ids.retro).map(p => p.id), [pin.id])
  assert.deepEqual(result, { ok: false, reason: 'session_dir' })
  assert.deepEqual(w.watching(), [])
  assert.equal(timers.count(), 0)
}, { variants: ['awaitingNames'] }))

test('a session with neither a manifest nor a row is skipped and the others are stored', async () => withTree(async ({ store, tree, make }) => {
  const w = make({ watch: noWatch, timers: manualTimers() })
  assert.equal((await w.sync()).ok, true)
  assert.equal(getMeeting(store, tree.ids.interrupted), null)
  for (const id of tree.ids.meetings) assert.ok(getMeeting(store, id), `row for ${id}`)
}, { variants: ['interrupted'] }))

test('watch ignores an id that is not a session id and a second call for a watched id', async () => withTree(async ({ store, tree, make }) => {
  const dirs = []
  const spyWatch = dir => { dirs.push(dir); return noWatch() }
  const timers = manualTimers()
  const w = make({ watch: spyWatch, timers })
  w.watch('../escape')
  w.watch('not-a-session')
  assert.deepEqual(dirs, [])
  const id = tree.ids.planning
  upsertMeeting(store, { id, tag: 'pessoal', confidential: false, state: 'awaiting_names', startedAt: 1, endedAt: null, sessionDir: null, notePath: null, at: 1 })
  // Hold the manifest at a state that keeps the watch open.
  await writeManifest(path.join(tree.sessionDir, id), id, 'awaiting_names')
  w.watch(id)
  w.watch(id)
  assert.deepEqual(dirs, [path.join(tree.sessionDir, id)])
  await until(() => timers.count() === 1, 'the poll to be armed')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(timers.count(), 1, 'one poll per watched session')
}))

test('a config change that moves session_dir re-opens each watch on the new directory', async () => withTree(async ({ root, tree, config, make }) => {
  const dirs = []
  const closedDirs = []
  const spyWatch = dir => { dirs.push(dir); return { close () { closedDirs.push(dir) }, on () {}, unref () {} } }
  let current = config
  const w = make({ watch: spyWatch, timers: manualTimers(), config: () => current })
  await w.sync()
  const id = tree.ids.awaitingNames
  assert.deepEqual(dirs, [path.join(tree.sessionDir, id)])
  const moved = path.join(root, 'moved')
  await mkdir(moved, { mode: 0o700 })
  await cp(path.join(tree.sessionDir, id), path.join(moved, id), { recursive: true })
  current = { ...config, sessionDir: moved }
  await w.sync()
  assert.deepEqual(closedDirs, [path.join(tree.sessionDir, id)])
  assert.deepEqual(dirs, [path.join(tree.sessionDir, id), path.join(moved, id)])
  assert.deepEqual(w.watching(), [id])
}, { variants: ['awaitingNames'] }))

test('with config().ok false, sync keeps the rows and stops every watch; close stops every timer', async () => withTree(async ({ store, tree, config, make }) => {
  let current = config
  const timers = manualTimers()
  const w = make({ watch: noWatch, timers, config: () => current })
  await w.sync()
  assert.deepEqual(w.watching(), [tree.ids.awaitingNames])
  await until(() => timers.count() === 1, 'the poll to be armed')
  current = { ok: false, path: null, error: { code: 'not_found', line: null, message: 'gone' } }
  await w.sync()
  assert.deepEqual(w.watching(), [])
  assert.equal(timers.count(), 0)
  for (const id of tree.ids.meetings) assert.ok(getMeeting(store, id), `row kept for ${id}`)
  current = config
  await w.sync()
  assert.deepEqual(w.watching(), [tree.ids.awaitingNames])
  await until(() => timers.count() === 1, 'the poll to be armed again')
  w.close()
  assert.deepEqual(w.watching(), [])
  assert.equal(timers.count(), 0)
}, { variants: ['awaitingNames'] }))
