import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openDeckDb } from '../../server/db/index.mjs'
import { runRetention } from '../../server/db/retention.mjs'

async function withDatabase(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-db-'))
  const file = path.join(dir, 'private', 'deck.db')
  try { await fn(file, dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('opens strict M1 schema with private files, WAL, foreign keys and a stable epoch', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  try {
    assert.equal(store.get('PRAGMA user_version').user_version, 1)
    assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal')
    assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1)
    assert.equal(store.get('PRAGMA auto_vacuum').auto_vacuum, 2)
    const tables = new Set(store.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map(row => row.name))
    for (const name of ['meta', 'repos', 'sessions', 'session_summaries', 'requests', 'events', 'hook_events', 'rejected_events', 'runs', 'prefs', 'notification_history']) assert.ok(tables.has(name), name)
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

test('schema refuses duplicate exclusive crew slots and live process keys', async () => withDatabase(async file => {
  const store = openDeckDb(file)
  try {
    store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/a','a',0,'a',1)")
    assert.throws(() => store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/b','b',0,'b',1)"), /UNIQUE/)
    store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/b','b',1,'b',1)")
    const insert = "INSERT INTO sessions(id,origin,process_key,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES(?, 'wrapped', 'pty-1', ?, '/repo', 'running', 1, 1, 1, 1, 1)"
    store.run(insert, 's1', '/a')
    assert.throws(() => store.run(insert, 's2', '/b'), /UNIQUE/)
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

test('failed migration rolls back schema changes and preserves the backup', async () => withDatabase(async file => {
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
    for (const type of ['meeting.transcript', 'ask.delta', 'screen.tail', 'input.source', 'setup.check', 'ui.navigate', 'hb']) {
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
