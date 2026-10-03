import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openDeckDb } from '../../server/db/index.mjs'
import { archiveFinished, autoArchiveCandidates } from '../../server/machines/archive.mjs'
import { projectCounts, projectHome } from '../../server/machines/counts.mjs'
import { createProjector } from '../../server/machines/projector.mjs'

const hour = 3_600_000
const fixtureDir = new URL('../fixtures/hooks/2.1.282/', import.meta.url)
function fixture(name, changes = {}, hookTs = 1000) {
  const hook = JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8'))
  return { v: 1, hook: { ...hook, ...changes }, hookTs, ptyId: null, claudePid: 42, pidChain: [42], truncated: false, receivedAt: hookTs, via: 'socket' }
}
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-archive-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  const clock = { now: 1000 }
  const events = []
  const projector = createProjector({ store, now: () => clock.now, publish: event => events.push(event) })
  store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/repo','repo',0,'repo',0)")
  // A session row in the given state; `open` adds an open permission request.
  function row(id, { state = 'done', alive = 0, changed = [], endedAt = null, stateSince = 1, open = false, archivedAt = null } = {}) {
    store.run('INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at,ended_at,changed_files,archived_at,archived_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, 'wrapped', '/repo', '/repo', state, stateSince, stateSince, stateSince, alive, 1, endedAt, JSON.stringify(changed), archivedAt, archivedAt === null ? null : 'owner')
    if (open) store.run("INSERT INTO requests(id,session_id,kind,tier,summary,state,source,match_key,created_at) VALUES(?,?,'permission','safe','ok','open','permission_request',?,1)", `r-${id}`, id, `m-${id}`)
  }
  return { store, projector, clock, events, row, dir, close() { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const upserts = (events, id) => events.filter(event => event.type === 'session.upserted' && event.entityId === id)

test('archive then unarchive round trip publishes session.upserted carrying archivedAt and archivedBy', () => {
  const h = harness()
  try {
    h.projector.applyHooks([fixture('SessionStart.startup.json', { cwd: h.dir }), fixture('UserPromptSubmit.json', { cwd: h.dir }, 1500)])
    const id = h.projector.snapshot().sessions[0].id
    assert.equal(h.projector.snapshot().sessions[0].archivedAt, null)
    assert.equal(h.projector.snapshot().sessions[0].archivedBy, null)
    h.events.length = 0
    h.clock.now = 5000
    assert.deepEqual(h.projector.archive(id, 'owner'), [id])
    const archived = upserts(h.events, id)
    assert.equal(archived.length, 1)
    assert.equal(archived[0].data.archivedAt, 5000)
    assert.equal(archived[0].data.archivedBy, 'owner')
    assert.ok(h.events.some(event => event.type === 'counts' && event.data.archived === 1))
    assert.deepEqual(h.projector.archive(id, 'owner'), [], 'archiving an archived session changes nothing')
    h.events.length = 0
    assert.deepEqual(h.projector.unarchive(id), [id])
    const restored = upserts(h.events, id)
    assert.equal(restored.length, 1)
    assert.equal(restored[0].data.archivedAt, null)
    assert.equal(restored[0].data.archivedBy, null)
    assert.ok(h.events.some(event => event.type === 'counts' && event.data.archived === 0))
    assert.deepEqual(h.projector.archive('missing', 'owner'), { ok: false, code: 'not_found' })
  } finally { h.close() }
})

test('archiving a session with an open request is refused with needs_you', () => {
  const h = harness()
  try {
    h.row('waiting', { state: 'needs_approval', alive: 1, open: true })
    h.events.length = 0
    assert.deepEqual(h.projector.archive('waiting', 'owner'), { ok: false, code: 'needs_you' })
    assert.equal(h.store.get("SELECT archived_at FROM sessions WHERE id='waiting'").archived_at, null)
    assert.equal(upserts(h.events, 'waiting').length, 0)
  } finally { h.close() }
})

test('an archived live session that receives a PermissionRequest hook is unarchived in the same commit', () => {
  const h = harness()
  try {
    h.projector.applyHooks([fixture('SessionStart.startup.json', { cwd: h.dir }), fixture('UserPromptSubmit.json', { cwd: h.dir }, 1500)])
    const id = h.projector.snapshot().sessions[0].id
    h.clock.now = 1800
    assert.deepEqual(h.projector.archive(id, 'owner'), [id])
    h.events.length = 0
    h.clock.now = 2100
    const committed = h.projector.applyHooks([fixture('PermissionRequest.AskUserQuestion.json', { cwd: h.dir, tool_name: 'Bash', tool_input: { command: 'pwd' } }, 2000)])
    assert.ok(committed.some(event => event.type === 'request.opened' && event.data.sessionId === id))
    assert.ok(h.events.some(event => event.type === 'request.opened' && event.data.sessionId === id), 'request.opened is published')
    const last = upserts(h.events, id).at(-1)
    assert.equal(last.data.archivedAt, null)
    assert.equal(last.data.archivedBy, null)
    assert.ok(h.events.indexOf(last) > h.events.findIndex(event => event.type === 'request.opened'))
    assert.deepEqual(committed.map(event => event.seq), h.events.map(event => event.seq), 'one commit published both')
    const row = h.store.get('SELECT archived_at, archived_by FROM sessions WHERE id=?', id)
    assert.deepEqual({ ...row }, { archived_at: null, archived_by: null })
    const counts = h.events.filter(event => event.type === 'counts').at(-1).data
    assert.equal(counts.archived, 0)
    assert.equal(counts.needYouSessions, 1)
  } finally { h.close() }
})

test('archiveFinished takes ended, reviewed and crashed sessions without changes and skips live, waiting and unreviewed ones', () => {
  const h = harness()
  try {
    h.row('live', { state: 'running', alive: 1 })
    h.row('waiting', { state: 'needs_approval', alive: 0, open: true })
    h.row('unreviewed', { state: 'done', changed: [{ path: 'a.txt', adds: 1, dels: 0 }] })
    h.row('ended', { state: 'ended', endedAt: 10 })
    h.row('reviewed', { state: 'reviewed' })
    h.row('crashed', { state: 'crashed' })
    h.row('already', { state: 'ended', endedAt: 10, archivedAt: 5 })
    assert.deepEqual(archiveFinished(h.store, { at: 7000 }).sort(), ['crashed', 'ended', 'reviewed'])
    assert.deepEqual(h.store.all('SELECT id, archived_at, archived_by FROM sessions WHERE archived_at IS NOT NULL ORDER BY id').map(row => ({ ...row })), [
      { id: 'already', archived_at: 5, archived_by: 'owner' },
      { id: 'crashed', archived_at: 7000, archived_by: 'owner' },
      { id: 'ended', archived_at: 7000, archived_by: 'owner' },
      { id: 'reviewed', archived_at: 7000, archived_by: 'owner' }
    ])
  } finally { h.close() }
})

test('autoArchiveCandidates takes a session ended past the delay and nothing newer, unreviewed or with the delay off', () => {
  const h = harness()
  try {
    const at = 100 * hour
    h.row('old', { state: 'ended', endedAt: at - 25 * hour })
    h.row('recent', { state: 'ended', endedAt: at - 23 * hour })
    h.row('unreviewed', { state: 'done', stateSince: at - 30 * hour, changed: [{ path: 'a.txt', adds: 1, dels: 0 }] })
    h.row('idle-old', { state: 'reviewed', stateSince: at - 48 * hour })
    assert.deepEqual(autoArchiveCandidates(h.store, { at, afterHours: 24 }).sort(), ['idle-old', 'old'])
    assert.deepEqual(autoArchiveCandidates(h.store, { at, afterHours: null }), [])
    h.clock.now = at
    assert.deepEqual(h.projector.autoArchive(24).sort(), ['idle-old', 'old'])
    assert.equal(h.store.get("SELECT archived_by FROM sessions WHERE id='old'").archived_by, 'auto')
    assert.deepEqual(h.projector.autoArchive(null), [])
  } finally { h.close() }
})

test('projectCounts excludes archived sessions from needYouSessions, running and toReview and reports archived', () => {
  const h = harness()
  try {
    h.row('running', { state: 'running', alive: 1 })
    h.row('done', { state: 'done' })
    h.row('waiting', { state: 'needs_approval', alive: 1, open: true })
    const before = projectCounts(h.store)
    assert.deepEqual([before.needYouSessions, before.running, before.toReview, before.archived], [1, 1, 1, 0])
    h.store.run("UPDATE sessions SET archived_at = 9, archived_by = 'owner'")
    const after = projectCounts(h.store)
    assert.deepEqual([after.needYouSessions, after.running, after.toReview, after.archived], [0, 0, 0, 3])
    const views = [{ id: 'a', state: 'running', stateSince: 1, archivedAt: 9 }, { id: 'b', state: 'running', stateSince: 2, archivedAt: null }]
    const home = projectHome(views)
    assert.deepEqual([home.order, home.grid.map(row => row.id), home.rail.map(row => row.id)], [['b'], ['b'], ['b']])
  } finally { h.close() }
})
