import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openDeckDb } from '../../server/db/index.mjs'
import { fileURLToPath } from 'node:url'
import { runRetention } from '../../server/db/retention.mjs'

async function withDatabase(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-db-'))
  const file = path.join(dir, 'private', 'deck.db')
  try { await fn(file, dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('opens strict M1 schema with private files, WAL, foreign keys and a stable epoch', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  try {
    assert.equal(store.get('PRAGMA user_version').user_version, 6)
    assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal')
    assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1)
    assert.equal(store.get('PRAGMA auto_vacuum').auto_vacuum, 2)
    const tables = new Set(store.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map(row => row.name))
    for (const name of ['meta', 'repos', 'sessions', 'session_summaries', 'requests', 'events', 'hook_events', 'rejected_events', 'runs', 'prefs', 'notification_history', 'approval_audit', 'meetings', 'meeting_pins', 'meeting_item_dismissals']) assert.ok(tables.has(name), name)
    for (const row of store.all('PRAGMA table_list').filter(row => row.schema === 'main' && !row.name.startsWith('sqlite_'))) assert.equal(row.strict, 1, row.name)
    const epoch = store.get("SELECT value FROM meta WHERE key = 'epoch'").value
    assert.match(epoch, /^[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700)
    store.close()
    const reopened = openDeckDb(file)
    try { assert.equal(reopened.get("SELECT value FROM meta WHERE key = 'epoch'").value, epoch) } finally { reopened.close() }
  } finally { store.close() }
}))

test('opening an existing permissive state directory makes it private', async () => withDatabase(async file => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o755 })
  await chmod(path.dirname(file), 0o755)
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o755)
  const store = openDeckDb(file)
  try { assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700) } finally { store.close() }
}))

test('database rejects relative paths before changing the current directory', () => {
  assert.throws(() => openDeckDb('deck.db'), /absolute file path/)
})

test('opening an existing permissive database file makes it private', async () => withDatabase(async file => {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '')
  await chmod(file, 0o644)
  assert.equal((await stat(file)).mode & 0o777, 0o644)
  const store = openDeckDb(file)
  try { assert.equal((await stat(file)).mode & 0o777, 0o600) } finally { store.close() }
}))

test('schema refuses duplicate crew slots, live process keys and hook events', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  try {
    store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/a','a',0,'a',1)")
    assert.throws(() => store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/b','b',0,'b',1)"), /UNIQUE/)
    store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/b','b',1,'b',1)")
    const insert = "INSERT INTO sessions(id,origin,process_key,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES(?, 'wrapped', 'pty-1', ?, '/repo', 'running', 1, 1, 1, 1, 1)"
    store.run(insert, 's1', '/a')
    assert.throws(() => store.run(insert, 's2', '/b'), /UNIQUE/)
    const hookInsert = "INSERT INTO hook_events(dedupe_key,claude_session_id,event,hook_ts,received_at,via,applied,payload) VALUES(?, 'cc','Stop',1,1,'socket',1,'{}')"
    store.run(hookInsert, 'same-hook')
    assert.throws(() => store.run(hookInsert, 'same-hook'), /UNIQUE/)
  } finally { store.close() }
}))

test('migration makes a backup and rejects a newer schema', async () => withDatabase(async file => {
  await mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE legacy_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO legacy_probe VALUES (7, 'recover me')")
  db.close()
  let store = openDeckDb(file)
  store.close()
  const backups = (await readdir(path.dirname(file))).filter(name => name.includes('.pre-0001.bak'))
  assert.equal(backups.length, 1)
  const backup = new DatabaseSync(path.join(path.dirname(file), backups[0]), { readOnly: true })
  try {
    assert.equal(backup.prepare('SELECT value FROM legacy_probe WHERE id = 7').get().value, 'recover me')
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 0)
  } finally { backup.close() }
  const future = new DatabaseSync(file)
  future.exec('PRAGMA user_version = 99')
  future.close()
  assert.throws(() => openDeckDb(file), /newer deck.*schema 99/i)
}))

test('a version 1 database migrates to the latest version with a pre-0002 backup and gains sessions.launch_task', async () => withDatabase(async file => {
  await mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(await readFile(fileURLToPath(new URL('../../server/db/migrations/0001-init.sql', import.meta.url)), 'utf8'))
  db.exec('PRAGMA user_version = 1')
  db.close()
  const store = openDeckDb(file)
  try {
    assert.equal(store.get('PRAGMA user_version').user_version, 6)
    assert.ok(store.all('PRAGMA table_info(sessions)').some(column => column.name === 'launch_task'), 'sessions.launch_task exists')
  } finally { store.close() }
  const backups = (await readdir(path.dirname(file))).filter(name => name.includes('.pre-0002.bak'))
  assert.equal(backups.length, 1)
  const backup = new DatabaseSync(path.join(path.dirname(file), backups[0]), { readOnly: true })
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1) } finally { backup.close() }
}))

test('a version 2 database migrates to 6 with a pre-0003 backup and gains sessions.archived_at and archived_by, request reasons and the approvals audit', async () => withDatabase(async file => {
  await mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  for (const name of ['0001-init.sql', '0002-launch.sql']) db.exec(await readFile(fileURLToPath(new URL(`../../server/db/migrations/${name}`, import.meta.url)), 'utf8'))
  db.exec('PRAGMA user_version = 2')
  db.exec("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/r','r',0,'r',1)")
  db.exec("INSERT INTO sessions(id,origin,process_key,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES('s1','wrapped','pty-1','/r','/r','running',1,1,1,1,1)")
  db.exec("INSERT INTO requests(id,session_id,kind,tier,summary,state,source,match_key,created_at) VALUES('q1','s1','permission','caution','ls','open','permission_request','k',1)")
  db.close()
  const store = openDeckDb(file)
  try {
    assert.equal(store.get('PRAGMA user_version').user_version, 6)
    assert.deepEqual({ ...store.get('SELECT reasons, confirm_label FROM requests WHERE id = ?', 'q1') }, { reasons: '[]', confirm_label: null })
    assert.throws(() => store.run("UPDATE requests SET reasons = 'not json' WHERE id = 'q1'"), /CHECK/)
    const columns = store.all('PRAGMA table_info(approval_audit)').map(column => column.name)
    assert.deepEqual(columns, ['id', 'at', 'kind', 'request_id', 'session_id', 'repo_id', 'tier', 'reasons', 'via', 'choice', 'option_label', 'confirm_label', 'summary', 'tiers_sha256'])
    assert.ok(store.all('PRAGMA index_list(approval_audit)').some(index => index.name === 'approval_audit_at'))
    store.run("INSERT INTO approval_audit(at, kind, tier, reasons, via) VALUES(1, 'answered', 'safe', '[\"safe.shell.ls\"]', 'browser')")
    assert.throws(() => store.run("INSERT INTO approval_audit(at, kind) VALUES(1, 'approved')"), /CHECK/)
    assert.throws(() => store.run("INSERT INTO approval_audit(at, kind, via) VALUES(1, 'answered', 'keyboard')"), /CHECK/)
    const sessionColumns = store.all('PRAGMA table_info(sessions)').map(column => column.name)
    assert.ok(sessionColumns.includes('archived_at'), 'sessions.archived_at exists')
    assert.ok(sessionColumns.includes('archived_by'), 'sessions.archived_by exists')
    assert.equal(store.get("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index' AND name = 'sessions_archived'").n, 1)
    assert.throws(() => store.run("INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at,archived_at,archived_by) VALUES('s','wrapped','/r','/r','done',1,1,1,0,1,1,'someone')"), /CHECK/)
  } finally { store.close() }
  const backups = (await readdir(path.dirname(file))).filter(name => name.includes('.pre-0003.bak'))
  assert.equal(backups.length, 1)
  assert.equal((await stat(path.join(path.dirname(file), backups[0]))).mode & 0o777, 0o600)
  const backup = new DatabaseSync(path.join(path.dirname(file), backups[0]), { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(backup.prepare('SELECT summary FROM requests WHERE id = ?').get('q1').summary, 'ls')
  } finally { backup.close() }
}))

test('a version 4 database migrates to 6 with a pre-0005 backup and gains the meetings tables, indexes and triggers', async () => withDatabase(async file => {
  await mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  for (const name of ['0001-init.sql', '0002-launch.sql', '0003-archive.sql', '0004-approvals.sql']) db.exec(await readFile(fileURLToPath(new URL(`../../server/db/migrations/${name}`, import.meta.url)), 'utf8'))
  db.exec('PRAGMA user_version = 4')
  db.close()
  const store = openDeckDb(file)
  try {
    assert.equal(store.get('PRAGMA user_version').user_version, 6)
    const names = new Set(store.all('SELECT name FROM sqlite_schema').map(row => row.name))
    for (const name of ['meetings', 'meeting_pins', 'meeting_item_dismissals', 'meetings_started', 'meeting_pins_meeting', 'meeting_pins_no_label_ins', 'meeting_pins_no_label_upd', 'meetings_became_confidential']) assert.ok(names.has(name), name)
  } finally { store.close() }
  const backups = (await readdir(path.dirname(file))).filter(name => name.includes('.pre-0005.bak'))
  assert.equal(backups.length, 1)
  const backup = new DatabaseSync(path.join(path.dirname(file), backups[0]), { readOnly: true })
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 4) } finally { backup.close() }
}))

async function versionFiveDatabase(file) {
  await mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  for (const name of ['0001-init.sql', '0002-launch.sql', '0003-archive.sql', '0004-approvals.sql', '0005-meetings.sql']) db.exec(await readFile(fileURLToPath(new URL(`../../server/db/migrations/${name}`, import.meta.url)), 'utf8'))
  db.exec('PRAGMA user_version = 5')
  return db
}

test('a version 5 database migrates to 6 with a pre-0006 backup, gains the memory schema, and a meeting that rises to confidential loses its ask threads', async () => withDatabase(async file => {
  const db = await versionFiveDatabase(file)
  db.exec("INSERT INTO meetings(id, tag, confidential, state, updated_at) VALUES('m1', 'acme', 0, 'recorded', 1), ('m2', 'acme', 0, 'recorded', 1)")
  db.close()
  const store = openDeckDb(file)
  try {
    assert.equal(store.get('PRAGMA user_version').user_version, 6)
    const schema = new Map(store.all('SELECT name, type FROM sqlite_schema').map(row => [row.name, row.type]))
    const expected = {
      table: ['ask_threads', 'ask_messages', 'misses', 'captures', 'note_reads', 'vault_learn_calls'],
      index: ['ask_threads_recent', 'ask_messages_thread', 'misses_unresolved', 'captures_day', 'note_reads_path', 'note_reads_session', 'vault_learn_calls_at'],
      trigger: ['ask_threads_no_confidential', 'meetings_became_confidential']
    }
    for (const [type, names] of Object.entries(expected)) for (const name of names) assert.equal(schema.get(name), type, name)
    for (const row of store.all('PRAGMA table_list').filter(row => row.schema === 'main' && !row.name.startsWith('sqlite_'))) assert.equal(row.strict, 1, row.name)
    const messageColumns = store.all('PRAGMA table_info(ask_messages)').map(column => column.name)
    for (const name of ['searches', 'unverified', 'duration_ms']) assert.ok(messageColumns.includes(name), `ask_messages.${name}`)
    assert.ok(!store.all('PRAGMA table_info(captures)').some(column => column.name === 'research_id'), 'captures.research_id is left to M6')
    assert.deepEqual(store.all('PRAGMA table_info(vault_learn_calls)').map(column => column.name), ['id', 'session_id', 'repo_id', 'slug', 'at'])

    store.run("INSERT INTO ask_threads(id, title, scope, created_at, updated_at) VALUES('t1', 'q', 'meeting:m1', 1, 1), ('t2', 'q', 'meeting:m2', 1, 1), ('t3', 'q', 'vault', 1, 1)")
    store.run("INSERT INTO ask_messages(id, thread_id, role, text, created_at) VALUES('a1', 't1', 'user', 'q', 1)")
    store.run("UPDATE meetings SET confidential = 1 WHERE id = 'm1'")
    assert.deepEqual(store.all('SELECT id FROM ask_threads ORDER BY id').map(row => row.id), ['t2', 't3'])
    assert.equal(store.get("SELECT count(*) AS n FROM ask_messages WHERE id = 'a1'").n, 0)
    assert.throws(() => store.run("INSERT INTO ask_threads(id, title, scope, created_at, updated_at) VALUES('t4', 'q', 'meeting:m1', 1, 1)"), /confidential meeting: ask not stored/)
    assert.throws(() => store.run("INSERT INTO ask_threads(id, title, scope, created_at, updated_at) VALUES('t5', 'q', 'meeting:unknown', 1, 1)"), /confidential meeting: ask not stored/)
    assert.throws(() => store.run("INSERT INTO ask_messages(id, thread_id, role, text, created_at, searches) VALUES('a2', 't3', 'assistant', '', 1, 'not json')"), /CHECK/)
    assert.throws(() => store.run("INSERT INTO ask_messages(id, thread_id, role, text, created_at, unverified) VALUES('a3', 't3', 'assistant', '', 1, 2)"), /CHECK/)
    store.run("INSERT INTO captures(path, day, captured_at, via) VALUES('02-wiki/x.md', '2026-10-04', 1, 'frontmatter')")
    assert.throws(() => store.run("INSERT INTO captures(path, day, captured_at, via) VALUES('02-wiki/y.md', '2026-10-04', 1, 'research')"), /CHECK/)
    assert.throws(() => store.run("INSERT INTO captures(path, day, captured_at, via) VALUES('02-wiki/x.md', '2026-10-04', 2, 'vault_learn')"), /UNIQUE/)
  } finally { store.close() }
  const backups = (await readdir(path.dirname(file))).filter(name => name.includes('.pre-0006.bak'))
  assert.equal(backups.length, 1)
  const backup = new DatabaseSync(path.join(path.dirname(file), backups[0]), { readOnly: true })
  try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 5) } finally { backup.close() }
}))

test('misses.resolved_by accepts null, research, note and dismissed, and refuses anything else', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  try {
    const insert = 'INSERT INTO misses(id, question, created_at, resolved_by) VALUES(?, ?, 1, ?)'
    store.run(insert, 'm0', 'q', null)
    store.run(insert, 'm1', 'q', 'research:r1')
    store.run(insert, 'm2', 'q', 'note:02-wiki/x.md')
    store.run(insert, 'm3', 'q', 'dismissed')
    assert.throws(() => store.run(insert, 'm4', 'q', 'other'), /CHECK/)
  } finally { store.close() }
}))

test('failed migration rolls back schema changes and preserves the backup',async () => withDatabase(async file => {
  await mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  db.close()
  assert.throws(() => openDeckDb(file), /Migration 0001-init\.sql failed: table meta already exists/)
  const original = new DatabaseSync(file)
  try {
    assert.equal(original.prepare('PRAGMA user_version').get().user_version, 0)
    assert.equal(original.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='repos'").get().n, 0)
  } finally { original.close() }
  const backups = (await readdir(path.dirname(file))).filter(name => name.includes('.pre-0001.bak'))
  assert.equal(backups.length, 1)
  assert.equal((await stat(path.join(path.dirname(file), backups[0]))).mode & 0o777, 0o600)
}))

test('write batches roll back together and event sequence never repeats', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  try {
    assert.throws(() => store.tx(() => {
      store.run("INSERT INTO prefs(key, value, updated_at) VALUES('bell', 'true', 1)")
      store.run("INSERT INTO events(at, type, data) VALUES(1, 'counts', '{}')")
      throw Error('abort')
    }), /abort/)
    assert.equal(store.get("SELECT count(*) AS n FROM prefs").n, 0)
    assert.equal(store.get("SELECT count(*) AS n FROM events").n, 0)
    store.run("INSERT INTO events(at, type, data) VALUES(1, 'counts', '{}')")
    const first = store.get('SELECT seq FROM events').seq
    store.run('DELETE FROM events')
    store.run("INSERT INTO events(at, type, data) VALUES(2, 'counts', '{}')")
    assert.ok(store.get('SELECT seq FROM events').seq > first)
  } finally { store.close() }
}))

test('durable event writer refuses all ephemeral event types', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  try {
    for (const type of ['meeting.transcript', 'ask.delta', 'misses.changed', 'screen.tail', 'input.source', 'setup.check', 'ui.navigate', 'hb']) {
      assert.throws(() => store.appendEvent({ type }), /ephemeral/)
    }
    const seq = store.appendEvent({ type: 'counts', data: { running: 1 } })
    assert.deepEqual({ ...store.get('SELECT type,data FROM events WHERE seq=?', seq) }, { type: 'counts', data: '{"running":1}' })
    assert.equal(store.get('SELECT count(*) AS n FROM events').n, 1)
  } finally { store.close() }
}))

test('retention keeps summaries, open requests and recent replay while pruning old detail', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  const day = 86_400_000
  const now = 50 * day
  try {
    store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/repo','repo',0,'repo',0)")
    for (const [id, state, endedAt] of [['old','ended',19 * day], ['old-open','ended',19 * day], ['recent','ended',21 * day], ['active','needs_approval',null]]) {
      store.run('INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, 'wrapped', '/repo', '/repo', state, 0, 0, 0, state === 'ended' ? 0 : 1, 0, endedAt)
    }
    store.run("INSERT INTO session_summaries(session_id,repo_id,repo_name,task,origin,role,outcome,started_at,ended_at,duration_ms) VALUES('old','/repo','repo','task','wrapped','solo','ended',0,1,1)")
    store.run("INSERT INTO requests(id,session_id,kind,tier,summary,state,source,match_key,created_at) VALUES('open','old-open','permission','safe','ok','open','permission_request','one',1)")
    store.run("INSERT INTO requests(id,session_id,kind,tier,summary,state,source,match_key,created_at,answer) VALUES('closed','active','permission','safe','ok','answered','permission_request','two',1,'{}')")
    store.run("INSERT INTO events(at,type,data) VALUES(1,'counts','{}'),(?, 'counts','{}')", now)
    store.run("INSERT INTO hook_events(dedupe_key,session_id,claude_session_id,event,hook_ts,received_at,via,applied,payload) VALUES('old-hook','active','cc','Stop',1,1,'socket',1,'{}')")
    store.run("INSERT INTO rejected_events(received_at,via,reason,raw) VALUES(1,'socket','bad','x')")
    store.run("INSERT INTO session_scrollback(session_id,captured_at,text,truncated) VALUES('active',1,'old screen',0)")
    runRetention(store, { now })
    assert.equal(store.get("SELECT count(*) AS n FROM sessions WHERE id='old'").n, 0)
    assert.equal(store.get("SELECT count(*) AS n FROM sessions WHERE id='old-open'").n, 1)
    assert.equal(store.get("SELECT count(*) AS n FROM sessions WHERE id='recent'").n, 1)
    assert.equal(store.get("SELECT count(*) AS n FROM session_summaries WHERE session_id='old'").n, 1)
    assert.equal(store.get("SELECT count(*) AS n FROM requests WHERE id='open'").n, 1)
    assert.equal(store.get("SELECT count(*) AS n FROM requests WHERE id='closed'").n, 0)
    assert.equal(store.get("SELECT count(*) AS n FROM rejected_events").n, 0)
    assert.equal(store.get("SELECT count(*) AS n FROM hook_events").n, 0)
    assert.equal(store.get("SELECT count(*) AS n FROM session_scrollback").n, 0)
    assert.equal(store.get("SELECT count(*) AS n FROM events WHERE at=1").n, 0)
    assert.equal(store.get("SELECT count(*) AS n FROM events WHERE at=? AND type='counts'", now).n, 1)
    assert.equal(store.get("SELECT count(*) AS n FROM events WHERE at=? AND type='session.removed'", now).n, 1)
    assert.equal(store.get("SELECT value FROM meta WHERE key='last_retention_at'").value, String(now))
  } finally { store.close() }
}))

test('retention never deletes a live session or unreviewed work, however old, only sessions that ended', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  const day = 86_400_000
  try {
    store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/repo','repo',0,'repo',0)")
    const rows = [['running', 1], ['needs_approval', 1], ['asked_you', 1], ['idle', 1], ['stale', 1], ['starting', 1], ['done', 0], ['crashed', 0], ['reviewed', 0], ['ended', 0]]
    for (const [state, alive] of rows) {
      store.run('INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', state, 'wrapped', '/repo', '/repo', state, 1, 1, 1, alive, 1, state === 'ended' ? 1 : null)
    }
    assert.equal(runRetention(store, { now: 400 * day }).removed, 1)
    assert.deepEqual(store.all('SELECT id FROM sessions ORDER BY id').map(row => row.id), rows.map(([state]) => state).filter(state => state !== 'ended').sort())
  } finally { store.close() }
}))

test('retention rolls back earlier deletions when a later deletion fails', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  try {
    store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/repo','repo',0,'repo',0)")
    store.run("INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at,ended_at) VALUES('old','wrapped','/repo','/repo','ended',0,0,0,0,0,1)")
    const originalRun = store.run
    store.run = (sql, ...args) => {
      if (sql.startsWith('DELETE FROM hook_events')) throw Error('storage failure')
      return originalRun(sql, ...args)
    }
    assert.throws(() => runRetention(store, { now: 50 * 86_400_000 }), /storage failure/)
    store.run = originalRun
    assert.equal(store.get("SELECT count(*) AS n FROM sessions WHERE id='old'").n, 1)
    assert.equal(store.get("SELECT count(*) AS n FROM events WHERE type='session.removed'").n, 0)
  } finally { store.close() }
}))
