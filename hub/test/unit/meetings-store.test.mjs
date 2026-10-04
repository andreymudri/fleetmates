import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openDeckDb } from '../../server/db/index.mjs'
import {
  addPin, dismissItem, dismissed, getMeeting, listMeetings, noteApps, pins, pruneMissing, removePin,
  undismissItem, upsertMeeting
} from '../../server/meetings/store.mjs'

async function withStore (fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-mtg-'))
  const file = path.join(dir, 'private', 'deck.db')
  const store = openDeckDb(file)
  try { await fn(store, file) } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}

// The store takes keys only; the meeting note reader computes them. A plain sha1 hex stands in here.
const sha1 = text => createHash('sha1').update(text).digest('hex')

const base = { tag: 'acme', state: 'recording', startedAt: 1000, endedAt: null, sessionDir: '/home/you/sessions/2026-09-08T14-00-12', notePath: null, at: 1000 }

function meeting (store, id, fields = {}) {
  return upsertMeeting(store, { id, ...base, confidential: false, ...fields })
}

test('inserting a labelled pin for a confidential meeting by raw SQL aborts', async () => withStore(store => {
  meeting(store, 'm1', { confidential: true })
  assert.throws(() => store.run("INSERT INTO meeting_pins(id,meeting_id,t,label,created_at) VALUES('p1','m1',1,'secret line',1)"), /confidential meeting: pin label not allowed/)
  store.run("INSERT INTO meeting_pins(id,meeting_id,t,label,created_at) VALUES('p2','m1',1,NULL,1)")
  assert.throws(() => store.run("UPDATE meeting_pins SET label = 'secret line' WHERE id = 'p2'"), /confidential meeting: pin label not allowed/)
}))

test('addPin on a confidential meeting stores label null without throwing', async () => withStore(store => {
  meeting(store, 'm1', { confidential: true })
  const { pin, created, events } = addPin(store, 'm1', { t: 12.5, label: 'secret line', at: 2000 })
  assert.equal(created, true)
  assert.equal(pin.label, null)
  assert.equal(store.get('SELECT label FROM meeting_pins WHERE id = ?', pin.id).label, null)
  assert.deepEqual(events.map(event => event.type), ['meeting.pin.added'])
  assert.deepEqual(events[0].data, { ...pin, meetingId: 'm1' })
  assert.equal(events[0].data.label, null)
}))

test('addPin cuts the label to 80 characters for a non-confidential meeting', async () => withStore(store => {
  meeting(store, 'm1')
  const { pin } = addPin(store, 'm1', { t: 1, label: 'x'.repeat(100), at: 2000 })
  assert.equal(pin.label, 'x'.repeat(80))
  assert.deepEqual(pins(store, 'm1'), [pin])
}))

test('two pins 2.0 s apart merge and 2.1 s apart do not', async () => withStore(store => {
  meeting(store, 'm1')
  const first = addPin(store, 'm1', { t: 10.1, label: 'a', at: 2000 })
  const merged = addPin(store, 'm1', { t: 12.1, label: 'b', at: 2001 })
  assert.equal(merged.created, false)
  assert.equal(merged.pin.id, first.pin.id)
  assert.deepEqual(merged.events, [])
  const separate = addPin(store, 'm1', { t: 14.2, label: 'c', at: 2002 })
  assert.equal(separate.created, true)
  assert.notEqual(separate.pin.id, first.pin.id)
  assert.deepEqual(pins(store, 'm1').map(pin => pin.t), [10.1, 14.2])
}))

test('removePin deletes the pin and appends meeting.pin.removed', async () => withStore(store => {
  meeting(store, 'm1')
  const { pin } = addPin(store, 'm1', { t: 3, label: 'a', at: 2000 })
  const result = removePin(store, 'm1', pin.id, 2001)
  assert.equal(result.removed, true)
  assert.deepEqual(result.events.map(event => [event.type, event.data]), [['meeting.pin.removed', { meetingId: 'm1', id: pin.id }]])
  assert.deepEqual(pins(store, 'm1'), [])
  assert.deepEqual(removePin(store, 'm1', pin.id, 2002), { removed: false, events: [] })
}))

test('flipping confidential to 1 nulls stored labels', async () => withStore(store => {
  meeting(store, 'm1')
  addPin(store, 'm1', { t: 3, label: 'kept until confidential', at: 2000 })
  store.run('UPDATE meetings SET confidential = 1 WHERE id = ?', 'm1')
  assert.deepEqual(store.all('SELECT label FROM meeting_pins WHERE meeting_id = ?', 'm1').map(row => row.label), [null])
}))

test('upsertMeeting with confidential false on a confidential row keeps 1, and a confidential row stores no note_path', async () => withStore(store => {
  meeting(store, 'm1', { confidential: true, notePath: 'Meetings/a.md' })
  assert.equal(store.get('SELECT note_path FROM meetings WHERE id = ?', 'm1').note_path, null)
  const { meeting: view } = upsertMeeting(store, { id: 'm1', confidential: false, state: 'synthesized', notePath: 'Meetings/a.md', at: 3000 })
  assert.equal(store.get('SELECT confidential FROM meetings WHERE id = ?', 'm1').confidential, 1)
  assert.equal(view.confidential, true)
  assert.equal(view.state, 'synthesized')
  assert.equal(view.notePath, null)
  assert.equal(store.get('SELECT note_path FROM meetings WHERE id = ?', 'm1').note_path, null)
}))

test('upsertMeeting raising confidentiality clears a stored note_path and pin labels', async () => withStore(store => {
  meeting(store, 'm1', { notePath: 'Meetings/a.md' })
  addPin(store, 'm1', { t: 3, label: 'line', at: 2000 })
  const { meeting: view } = upsertMeeting(store, { id: 'm1', confidential: true, at: 3000 })
  assert.equal(view.notePath, null)
  assert.equal(store.get('SELECT note_path FROM meetings WHERE id = ?', 'm1').note_path, null)
  assert.equal(pins(store, 'm1')[0].label, null)
}))

test('a new row whose confidential is omitted, null or not a boolean is stored confidential with no note_path', async () => withStore(store => {
  const fields = { tag: 'acme', state: 'synthesized', notePath: 'Meetings/2026-09-08 acme Title.md', at: 1000 }
  upsertMeeting(store, { id: 'omitted', ...fields })
  upsertMeeting(store, { id: 'null', ...fields, confidential: null })
  upsertMeeting(store, { id: 'yes', ...fields, confidential: 'yes' })
  for (const id of ['omitted', 'null', 'yes']) {
    assert.deepEqual({ ...store.get('SELECT confidential, note_path FROM meetings WHERE id = ?', id) }, { confidential: 1, note_path: null }, id)
  }
}))

test('a raw UPDATE of confidential to 1 scrubs note_path and the meeting\'s earlier event label and notePath', async () => withStore(store => {
  meeting(store, 'm1', { notePath: 'Meetings/2026-09-08 acme Title.md' })
  meeting(store, 'm2', { notePath: 'Meetings/2026-09-08 acme Other.md' })
  addPin(store, 'm1', { t: 3, label: 'pin label', at: 2000 })
  addPin(store, 'm2', { t: 3, label: 'other label', at: 2000 })
  store.run('UPDATE meetings SET confidential = 1 WHERE id = ?', 'm1')
  assert.equal(store.get('SELECT note_path FROM meetings WHERE id = ?', 'm1').note_path, null)
  const data = (id, type) => store.all('SELECT data FROM events WHERE entity_id = ? AND type = ? ORDER BY seq', id, type).map(row => JSON.parse(row.data))
  assert.deepEqual(data('m1', 'meeting.updated').map(event => event.notePath), [null])
  assert.deepEqual(data('m1', 'meeting.pin.added').map(event => event.label), [null])
  assert.deepEqual(data('m2', 'meeting.updated').map(event => event.notePath), ['Meetings/2026-09-08 acme Other.md'])
  assert.deepEqual(data('m2', 'meeting.pin.added').map(event => event.label), ['other label'])
}))

test('after a rise to confidential neither the note title nor the pin label is in deck.db, its WAL or its shm', async () => withStore((store, file) => {
  meeting(store, 'm1', { notePath: 'Meetings/2026-09-08 acme SENTINEL-TITLE.md' })
  addPin(store, 'm1', { t: 3, label: 'SENTINEL-LABEL said here', at: 2000 })
  upsertMeeting(store, { id: 'm1', confidential: true, at: 3000 })
  const scan = when => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (!existsSync(file + suffix)) continue
      const bytes = readFileSync(file + suffix)
      for (const sentinel of ['SENTINEL-TITLE', 'SENTINEL-LABEL']) assert.equal(bytes.includes(Buffer.from(sentinel)), false, `${sentinel} in deck.db${suffix} ${when}`)
    }
  }
  scan('while open')
  store.close()
  scan('after close')
}))

test('getMeeting and listMeetings return Meeting views, newest first, with before and limit', async () => withStore(store => {
  meeting(store, 'm1', { startedAt: 1000 })
  meeting(store, 'm2', { startedAt: 2000, notePath: 'Meetings/b.md' })
  meeting(store, 'm3', { startedAt: 3000 })
  assert.deepEqual(getMeeting(store, 'm2'), { id: 'm2', tag: 'acme', confidential: false, state: 'recording', startedAt: 2000, endedAt: null, notePath: 'Meetings/b.md', apps: [] })
  assert.equal(getMeeting(store, 'missing'), null)
  assert.deepEqual(listMeetings(store, {}).map(row => row.id), ['m3', 'm2', 'm1'])
  assert.deepEqual(listMeetings(store, { limit: 2 }).map(row => row.id), ['m3', 'm2'])
  assert.deepEqual(listMeetings(store, { before: 3000, limit: 1 }).map(row => row.id), ['m2'])
}))

test('noteApps keeps the union in first-seen order and appends meeting.updated only on change', async () => withStore(store => {
  meeting(store, 'm1')
  assert.deepEqual(noteApps(store, 'm1', ['Zoom', 'Firefox'], 2000).meeting.apps, ['Zoom', 'Firefox'])
  const again = noteApps(store, 'm1', ['Firefox', 'Slack', 'Zoom'], 2001)
  assert.deepEqual(again.meeting.apps, ['Zoom', 'Firefox', 'Slack'])
  assert.deepEqual(again.events.map(event => event.type), ['meeting.updated'])
  assert.deepEqual(noteApps(store, 'm1', ['Slack'], 2002).events, [])
}))

test('a dismissal stores only the 40-character sha1 key and the item text is absent from the database file bytes', async () => withStore((store, file) => {
  meeting(store, 'm1')
  const text = 'Send the quarterly numbers to the client before Friday'
  const key = sha1(text)
  assert.match(key, /^[0-9a-f]{40}$/)
  assert.equal(dismissItem(store, 'm1', key, 2000).dismissed, true)
  assert.deepEqual(dismissed(store, 'm1'), [key])
  assert.deepEqual(store.all('SELECT item_key FROM meeting_item_dismissals').map(row => row.item_key), [key])
  assert.throws(() => dismissItem(store, 'm1', text, 2001), TypeError)
  assert.equal(dismissItem(store, 'missing', key, 2001).dismissed, false)
  store.close()
  for (const suffix of ['', '-wal']) {
    if (!existsSync(file + suffix)) continue
    assert.equal(readFileSync(file + suffix).includes(Buffer.from('quarterly numbers')), false, `item text in deck.db${suffix}`)
  }
}))

test('undismissItem removes the dismissal', async () => withStore(store => {
  meeting(store, 'm1')
  const key = sha1('Book the room')
  dismissItem(store, 'm1', key, 2000)
  assert.equal(undismissItem(store, 'm1', key).removed, true)
  assert.deepEqual(dismissed(store, 'm1'), [])
  assert.equal(undismissItem(store, 'm1', key).removed, false)
}))

test('pruneMissing removes the row, its pins and dismissals', async () => withStore(store => {
  meeting(store, 'm1')
  meeting(store, 'm2')
  addPin(store, 'm1', { t: 1, label: 'a', at: 2000 })
  dismissItem(store, 'm1', sha1('Book the room'), 2000)
  assert.deepEqual(pruneMissing(store, ['m2'], 3000).removed, ['m1'])
  assert.equal(getMeeting(store, 'm1'), null)
  assert.ok(getMeeting(store, 'm2'))
  assert.equal(store.get('SELECT count(*) AS n FROM meeting_pins').n, 0)
  assert.equal(store.get('SELECT count(*) AS n FROM meeting_item_dismissals').n, 0)
}))

test('no appended event data has a title key, and each write returns the events it appended', async () => withStore(store => {
  const results = [
    meeting(store, 'm1'),
    upsertMeeting(store, { id: 'm1', state: 'synthesized', notePath: 'Meetings/2026-09-08 a.md', endedAt: 5000, at: 5000 }),
    noteApps(store, 'm1', ['Zoom'], 5001),
    addPin(store, 'm1', { t: 4, label: 'a', at: 5002 })
  ]
  results.push(removePin(store, 'm1', results[3].pin.id, 5003))
  const returned = results.flatMap(result => result.events)
  const stored = store.all("SELECT seq, type, entity_id, data FROM events WHERE type LIKE 'meeting.%' ORDER BY seq")
  assert.deepEqual(returned.map(event => [event.seq, event.type, event.entityId]), stored.map(row => [Number(row.seq), row.type, row.entity_id]))
  assert.deepEqual(returned.map(event => event.type), ['meeting.updated', 'meeting.updated', 'meeting.updated', 'meeting.pin.added', 'meeting.pin.removed'])
  for (const row of stored) assert.equal(Object.hasOwn(JSON.parse(row.data), 'title'), false, row.type)
  assert.deepEqual(Object.keys(JSON.parse(stored[0].data)).sort(), ['apps', 'confidential', 'endedAt', 'id', 'notePath', 'startedAt', 'state', 'tag'])
}))
