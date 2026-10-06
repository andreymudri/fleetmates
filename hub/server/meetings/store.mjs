// The deck's own meeting facts in SQLite (06-storage 4.9): meeting rows, pins and dismissed action
// items. Every write runs in one `store.tx` and returns the durable events it appended, so the
// caller can publish them. No title, transcript, ask or note text is stored or put in an event
// (06-storage 10.1), and no pin label is stored for a confidential meeting.
import { randomBytes } from 'node:crypto'
import { scrubBackups } from '../db/backups.mjs'

/**
 * @typedef {{ run: Function, get: Function, all: Function, appendEvent: Function, tx: Function }} Store
 * @typedef {{ seq: number, at: number, type: string, entityId: string, data: object }} StoredEvent
 * @typedef {'recording'|'stopping'|'recorded'|'transcribed'|'awaiting_names'|'synthesized'} MeetingState
 * @typedef {{ id: string, tag: string, confidential: boolean, state: MeetingState, startedAt: number|null, endedAt: number|null, notePath: string|null, apps: string[] }} Meeting
 * @typedef {{ id: string, t: number, label: string|null, createdAt: number }} Pin
 */

/** Pins of one meeting closer than this many seconds (inclusive) merge into one (05-api 2.11). */
export const PIN_MERGE_S = 2
/** Pin labels keep this many characters (05-api 2.11). */
export const PIN_LABEL_MAX = 80

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SHA1_HEX = /^[0-9a-f]{40}$/

function ulid (now = Date.now()) {
  let time = BigInt(now)
  let head = ''
  for (let i = 0; i < 10; i++) { head = ULID_ALPHABET[Number(time & 31n)] + head; time >>= 5n }
  let random = BigInt(`0x${randomBytes(10).toString('hex')}`)
  let tail = ''
  for (let i = 0; i < 16; i++) { tail = ULID_ALPHABET[Number(random & 31n)] + tail; random >>= 5n }
  return head + tail
}

/** @param {Store} store @param {StoredEvent[]} events */
const appender = (store, events) => (/** @type {Omit<StoredEvent, 'seq'>} */ event) => {
  const seq = store.appendEvent(event)
  events.push({ seq: Number(seq), ...event })
}

/** @param {any} row @returns {Meeting} */
function meetingView (row) {
  return {
    id: row.id,
    tag: row.tag,
    confidential: row.confidential === 1,
    state: row.state,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    notePath: row.confidential === 1 ? null : row.note_path ?? null,
    apps: JSON.parse(row.apps)
  }
}

/** @param {any} row @returns {Pin} */
const pinView = row => ({ id: row.id, t: row.t, label: row.label ?? null, createdAt: row.created_at })

/** @param {Store} store @param {string} id */
const meetingRow = (store, id) => store.get('SELECT * FROM meetings WHERE id = ?', id)

/**
 * Create or update a meeting row. Fields left undefined keep their stored value on an update.
 * Confidentiality only rises: a confidential row stays confidential whatever `confidential` says,
 * and a new row whose `confidential` is not a boolean is confidential (fail closed, DB-O2).
 * `note_path` is written as null for a confidential row. Appends `meeting.updated` (data `Meeting`)
 * when the view changed. When the row turns confidential, the `meetings_became_confidential`
 * trigger also scrubs the meeting's pin labels and the label and notePath of its earlier events,
 * and after the commit a `PRAGMA wal_checkpoint(TRUNCATE)` moves the scrubbed pages out of the WAL
 * (`secure_delete` is on). Its result is not checked: a checkpoint that SQLite reports busy (per
 * the SQLite docs, while another connection reads; not tested here) leaves that to a later one.
 * @param {Store} store
 * @param {{ id: string, tag?: string, confidential?: boolean, state?: MeetingState, startedAt?: number|null, endedAt?: number|null, sessionDir?: string|null, notePath?: string|null, at: number }} fields
 * @returns {{ meeting: Meeting, events: StoredEvent[] }}
 */
export function upsertMeeting (store, { id, tag, confidential, state, startedAt, endedAt, sessionDir, notePath, at }) {
  let rose = false
  const result = store.tx(() => {
    /** @type {StoredEvent[]} */
    const events = []
    const append = appender(store, events)
    const row = meetingRow(store, id)
    const before = row ? meetingView(row) : null
    if (!row) {
      const secret = confidential === false ? 0 : 1
      store.run(
        'INSERT INTO meetings(id, tag, confidential, state, started_at, ended_at, note_path, session_dir, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        id, tag, secret, state, startedAt ?? null, endedAt ?? null, secret ? null : notePath ?? null, sessionDir ?? null, at
      )
    } else {
      const secret = row.confidential === 1 || confidential === true ? 1 : 0
      const nextNote = secret ? null : notePath === undefined ? row.note_path : notePath
      store.run(
        'UPDATE meetings SET tag = ?, confidential = ?, state = ?, started_at = ?, ended_at = ?, note_path = ?, session_dir = ?, updated_at = ? WHERE id = ?',
        tag ?? row.tag, secret, state ?? row.state,
        startedAt === undefined ? row.started_at : startedAt,
        endedAt === undefined ? row.ended_at : endedAt,
        nextNote,
        sessionDir === undefined ? row.session_dir : sessionDir,
        at, id
      )
    }
    const meeting = meetingView(meetingRow(store, id))
    rose = before !== null && !before.confidential && meeting.confidential
    if (JSON.stringify(meeting) !== JSON.stringify(before)) append({ at, type: 'meeting.updated', entityId: id, data: meeting })
    return { meeting, events }
  })
  if (rose) {
    store.get('PRAGMA wal_checkpoint(TRUNCATE)')
    scrubBackups(store.file, id)
  }
  return result
}

/**
 * Add the `routed_apps` labels seen while polling, keeping the union in first-seen order (MEET-O1).
 * Appends `meeting.updated` when a label was new. A missing meeting gives `meeting` null.
 * @param {Store} store
 * @param {string} id
 * @param {string[]} apps
 * @param {number} at
 * @returns {{ meeting: Meeting|null, events: StoredEvent[] }}
 */
export function noteApps (store, id, apps, at) {
  return store.tx(() => {
    /** @type {StoredEvent[]} */
    const events = []
    const row = meetingRow(store, id)
    if (!row) return { meeting: null, events }
    const known = JSON.parse(row.apps)
    const next = [...known]
    for (const app of apps) if (typeof app === 'string' && app && !next.includes(app)) next.push(app)
    if (next.length !== known.length) {
      store.run('UPDATE meetings SET apps = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), at, id)
      appender(store, events)({ at, type: 'meeting.updated', entityId: id, data: meetingView(meetingRow(store, id)) })
    }
    return { meeting: meetingView(meetingRow(store, id)), events }
  })
}

/**
 * The meetings, newest `started_at` first (a row without one last), ties by id descending.
 * `before` keeps rows whose `started_at` is lower; `limit` defaults to 50 and is capped at 500.
 * @param {Store} store
 * @param {{ before?: number|null, limit?: number }} [options]
 * @returns {Meeting[]}
 */
export function listMeetings (store, { before = null, limit = 50 } = {}) {
  const count = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 50))
  const rows = Number.isFinite(before)
    ? store.all('SELECT * FROM meetings WHERE started_at < ? ORDER BY started_at DESC, id DESC LIMIT ?', before, count)
    : store.all('SELECT * FROM meetings ORDER BY started_at IS NULL, started_at DESC, id DESC LIMIT ?', count)
  return rows.map(meetingView)
}

/**
 * One meeting, or null when there is no row.
 * @param {Store} store
 * @param {string} id
 * @returns {Meeting|null}
 */
export function getMeeting (store, id) {
  const row = meetingRow(store, id)
  return row ? meetingView(row) : null
}

/**
 * Pin a moment. A pin of the same meeting whose `t` is within 2 s (inclusive, compared in
 * milliseconds) is returned instead, with `created` false and no event. The label is cut to 80
 * characters and written as null for a confidential meeting. Appends `meeting.pin.added`
 * (`Pin & { meetingId }`) for a new pin. Returns null when the meeting has no row.
 * @param {Store} store
 * @param {string} id meeting id
 * @param {{ t: number, label?: string|null, at: number }} pin
 * @returns {{ pin: Pin, created: boolean, events: StoredEvent[] } | null}
 */
export function addPin (store, id, { t, label = null, at }) {
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw new TypeError('pin t must be a finite number of seconds >= 0')
  return store.tx(() => {
    /** @type {StoredEvent[]} */
    const events = []
    const row = meetingRow(store, id)
    if (!row) return null
    const near = store.all('SELECT * FROM meeting_pins WHERE meeting_id = ? ORDER BY t, id', id)
      .map(pin => ({ pin, gap: Math.round(Math.abs(pin.t - t) * 1000) }))
      .filter(({ gap }) => gap <= PIN_MERGE_S * 1000)
      .sort((a, b) => a.gap - b.gap)[0]
    if (near) return { pin: pinView(near.pin), created: false, events }
    const stored = row.confidential === 1 || typeof label !== 'string' ? null : Array.from(label).slice(0, PIN_LABEL_MAX).join('')
    const pinId = ulid(at)
    store.run('INSERT INTO meeting_pins(id, meeting_id, t, label, created_at) VALUES(?,?,?,?,?)', pinId, id, t, stored, at)
    const pin = pinView(store.get('SELECT * FROM meeting_pins WHERE id = ?', pinId))
    appender(store, events)({ at, type: 'meeting.pin.added', entityId: id, data: { ...pin, meetingId: id } })
    return { pin, created: true, events }
  })
}

/**
 * Remove a pin of a meeting. Appends `meeting.pin.removed` (`{ meetingId, id }`) when it existed.
 * @param {Store} store
 * @param {string} id meeting id
 * @param {string} pinId
 * @param {number} at
 * @returns {{ removed: boolean, events: StoredEvent[] }}
 */
export function removePin (store, id, pinId, at) {
  return store.tx(() => {
    /** @type {StoredEvent[]} */
    const events = []
    const { changes } = store.run('DELETE FROM meeting_pins WHERE id = ? AND meeting_id = ?', pinId, id)
    if (Number(changes) === 0) return { removed: false, events }
    appender(store, events)({ at, type: 'meeting.pin.removed', entityId: id, data: { meetingId: id, id: pinId } })
    return { removed: true, events }
  })
}

/**
 * The pins of a meeting in `t` order.
 * @param {Store} store
 * @param {string} id
 * @returns {Pin[]}
 */
export function pins (store, id) {
  return store.all('SELECT * FROM meeting_pins WHERE meeting_id = ? ORDER BY t, id', id).map(pinView)
}

/**
 * Dismiss an action item by its key, the sha1 hex the meeting note reader gives each action item
 * (the store never sees or computes from the item text). A key that is not 40 lower-case hex characters
 * throws, so item text can never land in `item_key`. `dismissed` is false when the meeting has no
 * row. Appends no event.
 * @param {Store} store
 * @param {string} id meeting id
 * @param {string} key
 * @param {number} at
 * @returns {{ dismissed: boolean, events: StoredEvent[] }}
 */
export function dismissItem (store, id, key, at) {
  if (typeof key !== 'string' || !SHA1_HEX.test(key)) throw new TypeError('item key must be a sha1 hex digest')
  return store.tx(() => {
    if (!meetingRow(store, id)) return { dismissed: false, events: [] }
    store.run('INSERT OR IGNORE INTO meeting_item_dismissals(meeting_id, item_key, dismissed_at) VALUES(?,?,?)', id, key, at)
    return { dismissed: true, events: [] }
  })
}

/**
 * Undo a dismissal. Appends no event.
 * @param {Store} store
 * @param {string} id meeting id
 * @param {string} key
 * @returns {{ removed: boolean, events: StoredEvent[] }}
 */
export function undismissItem (store, id, key) {
  return store.tx(() => {
    const { changes } = store.run('DELETE FROM meeting_item_dismissals WHERE meeting_id = ? AND item_key = ?', id, key)
    return { removed: Number(changes) > 0, events: [] }
  })
}

/**
 * The dismissed item keys of a meeting.
 * @param {Store} store
 * @param {string} id
 * @returns {string[]}
 */
export function dismissed (store, id) {
  return store.all('SELECT item_key FROM meeting_item_dismissals WHERE meeting_id = ? ORDER BY dismissed_at, item_key', id).map(row => row.item_key)
}

/**
 * Delete every meeting whose id is not in `ids` (its session directory is gone, 06-storage 4.9);
 * its pins and dismissals go with it through `ON DELETE CASCADE`. Appends no event.
 * @param {Store} store
 * @param {Iterable<string>} ids the session ids that still exist
 * @param {number} at
 * @returns {{ removed: string[], events: StoredEvent[] }}
 */
export function pruneMissing (store, ids, at) {
  void at
  const keep = new Set(ids)
  return store.tx(() => {
    const removed = store.all('SELECT id FROM meetings ORDER BY id').map(row => row.id).filter(id => !keep.has(id))
    for (const id of removed) store.run('DELETE FROM meetings WHERE id = ?', id)
    return { removed, events: [] }
  })
}
