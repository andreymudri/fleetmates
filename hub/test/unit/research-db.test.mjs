import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openDeckDb } from '../../server/db/index.mjs'

test('M6 migration backs up schema 6 privately and creates a strict research registry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-db-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'deck.db')
  const old = new DatabaseSync(file)
  const migrations = new URL('../../server/db/migrations/', import.meta.url)
  for (const name of (await fs.readdir(migrations)).filter(name => /^000[1-6]-.*\.sql$/.test(name)).sort()) old.exec(await fs.readFile(new URL(name, migrations), 'utf8'))
  old.exec('PRAGMA user_version=6')
  old.close()
  const db = openDeckDb(file)
  try {
    assert.equal(db.get('PRAGMA user_version').user_version, 7)
    assert.equal(db.get("SELECT strict FROM pragma_table_list WHERE name='research'").strict, 1)
    assert.equal(db.get("SELECT count(*) AS n FROM sqlite_schema WHERE name='research_created'").n, 1)
    db.run("INSERT INTO repos(id,name,crew_seed,crew_slot,first_seen_at) VALUES('/fixture','fixture','fixture',0,1)")
    db.run("INSERT INTO research(id,repo_id,request,created_at) VALUES('research-fixture','/fixture','{}',1)")
    assert.throws(() => db.run("INSERT INTO research(id,repo_id,request,created_at) VALUES('bad','/fixture','[]',1)"), /CHECK/)
    assert.throws(() => db.run("INSERT INTO research(id,repo_id,request,created_at) VALUES('missing','/absent','{}',1)"), /FOREIGN KEY/)
  } finally { db.close() }
  const backup = path.join(dir, 'deck.db.pre-0007.bak')
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o600)
  const prior = new DatabaseSync(backup, { readOnly: true })
  try {
    assert.equal(prior.prepare('PRAGMA user_version').get().user_version, 6)
    assert.equal(prior.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='research'").get().n, 0)
  } finally { prior.close() }
})
