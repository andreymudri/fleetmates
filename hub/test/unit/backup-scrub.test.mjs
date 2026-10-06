import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDeckDb } from '../../server/db/index.mjs'
import { listBackups, scrubBackups } from '../../server/db/backups.mjs'
import { upsertMeeting } from '../../server/meetings/store.mjs'

test('confidential rise scrubs migrated backups, preserves unrelated backups and deletes corrupt ones', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scrub-'))
  const file = path.join(dir, 'deck.db')
  let store
  try {
    const db = new DatabaseSync(file)
    const migrations = new URL('../../server/db/migrations/', import.meta.url)
    for (const name of (await readdir(migrations)).filter(name => /^000[1-5]/.test(name)).sort()) db.exec(await readFile(new URL(name, migrations), 'utf8'))
    db.exec('PRAGMA user_version=5')
    db.prepare("INSERT INTO meetings(id,tag,confidential,state,started_at,note_path,session_dir,updated_at) VALUES('meeting','test',0,'recorded',1,'NOTE_SENTINEL', '/home/you/meetings',1)").run()
    db.prepare("INSERT INTO meeting_pins(id,meeting_id,t,label,created_at) VALUES('pin','meeting',0,'LABEL_SENTINEL',1)").run()
    db.prepare("INSERT INTO events(at,type,entity_id,data) VALUES(1,'meeting.updated','meeting',?)").run(JSON.stringify({ id: 'meeting', notePath: 'EVENT_SENTINEL' }))
    db.close()
    store = openDeckDb(file)
    const backup = listBackups(file)[0]
    assert.ok((await readFile(backup)).includes(Buffer.from('LABEL_SENTINEL')))
    const unrelated = `${file}.pre-0005.bak`
    const other = new DatabaseSync(unrelated); other.exec('CREATE TABLE marker(value TEXT)'); other.close()
    const unchanged = (await stat(unrelated)).mtimeMs
    upsertMeeting(store, { id: 'meeting', tag: 'test', confidential: true, state: 'recorded', startedAt: 1, endedAt: null, sessionDir: '/home/you/meetings', notePath: null, at: 2 })
    const bytes = await readFile(backup)
    for (const sentinel of ['LABEL_SENTINEL', 'NOTE_SENTINEL', 'EVENT_SENTINEL']) assert.equal(bytes.includes(Buffer.from(sentinel)), false, sentinel)
    assert.equal((await stat(unrelated)).mtimeMs, unchanged)
    const after = (await stat(backup)).mtimeMs
    upsertMeeting(store, { id: 'meeting', tag: 'test', confidential: true, state: 'recorded', startedAt: 1, sessionDir: '/home/you/meetings', at: 3 })
    assert.equal((await stat(backup)).mtimeMs, after)
    const corrupt = `${file}.pre-0004.bak.1`
    await writeFile(corrupt, 'corrupt')
    const logs = []
    scrubBackups(file, 'meeting', { log: line => logs.push(line) })
    await assert.rejects(stat(corrupt), { code: 'ENOENT' })
    assert.deepEqual(logs, ['deck: backup.scrub_failed deck.db.pre-0004.bak.1'])
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }) }
})
