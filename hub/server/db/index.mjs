import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url))
const migrations = readdirSync(migrationsDir).filter(name => /^\d{4}[-_].+\.sql$/.test(name)).sort()
const latestVersion = Number(migrations.at(-1)?.slice(0, 4) ?? 0)
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
// Ephemeral events of 05-api 3.4: published without `seq` and never appended to `events`.
const ephemeralEvents = new Set(['meeting.transcript', 'meeting.recovered', 'ask.delta', 'ask.done', 'ask.error', 'misses.changed', 'screen.tail', 'input.source', 'setup.check', 'ui.navigate', 'hb', 'error'])

function newEpoch(now = Date.now()) {
  let time = BigInt(now)
  let value = ''
  for (let i = 0; i < 10; i++) { value = alphabet[Number(time & 31n)] + value; time >>= 5n }
  let random = BigInt(`0x${randomBytes(10).toString('hex')}`)
  let tail = ''
  for (let i = 0; i < 16; i++) { tail = alphabet[Number(random & 31n)] + tail; random >>= 5n }
  value += tail
  return value
}

function privateFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = file + suffix
    if (existsSync(target)) chmodSync(target, 0o600)
  }
}

function backupBeforeMigration(db, file, version) {
  const dir = path.dirname(file)
  const name = `${path.basename(file)}.pre-${String(version).padStart(4, '0')}.bak`
  let target = path.join(dir, name)
  for (let n = 1; existsSync(target); n++) target = path.join(dir, `${name}.${n}`)
  const previousUmask = process.umask(0o077)
  try { db.prepare('VACUUM INTO ?').run(target) } finally { process.umask(previousUmask) }
  chmodSync(target, 0o600)
  const backups = readdirSync(dir)
    .filter(entry => entry.startsWith(`${path.basename(file)}.pre-`) && entry.includes('.bak'))
    .map(entry => ({ entry, mtime: statSync(path.join(dir, entry)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const old of backups.slice(3)) unlinkSync(path.join(dir, old.entry))
}

/** Open the deck database, applying forward migrations before returning a writer. */
export function openDeckDb(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('deck database needs an absolute file path')
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (statSync(dir).uid !== process.getuid()) throw Error('deck database directory must be owned by the current user')
  chmodSync(dir, 0o700)
  const previousUmask = process.umask(0o077)
  let db
  try { db = new DatabaseSync(file) } finally { process.umask(previousUmask) }
  try {
    privateFiles(file)
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA temp_store = MEMORY;')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version > latestVersion) throw Error(`deck.db was written by a newer deck (schema ${version}). Upgrade, or restore deck.db.pre-*.bak.`)
    if (version === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL')
    if (version < latestVersion) {
      backupBeforeMigration(db, file, version + 1)
      for (const name of migrations) {
        const next = Number(name.slice(0, 4))
        if (next <= version) continue
        db.exec('BEGIN IMMEDIATE')
        try {
          db.exec(readFileSync(path.join(migrationsDir, name), 'utf8'))
          db.exec(`PRAGMA user_version = ${next}`)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw Error(`Migration ${name} failed: ${error.message}`, { cause: error })
        }
      }
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('epoch', ?)").run(newEpoch())
    db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('created_at', ?)").run(String(Date.now()))
    privateFiles(file)
    return {
      db,
      run(sql, ...params) { return db.prepare(sql).run(...params) },
      get(sql, ...params) { return db.prepare(sql).get(...params) },
      all(sql, ...params) { return db.prepare(sql).all(...params) },
      appendEvent({ at = Date.now(), type, entityId = null, data = {} }) {
        if (ephemeralEvents.has(type)) throw new TypeError(`${type} is ephemeral and cannot be persisted`)
        if (typeof type !== 'string' || !type) throw new TypeError('event type is required')
        return db.prepare('INSERT INTO events(at,type,entity_id,data) VALUES(?,?,?,?)').run(at, type, entityId, JSON.stringify(data)).lastInsertRowid
      },
      tx(fn) {
        db.exec('BEGIN IMMEDIATE')
        try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
      },
      close() { if (db.isOpen) db.close() }
    }
  } catch (error) { if (db.isOpen) db.close(); throw error }
}
