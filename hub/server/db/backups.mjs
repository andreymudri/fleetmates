import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Migration backups beside the database, including numbered collision copies. */
export function listBackups(file) {
  if (!file || !existsSync(path.dirname(file))) return []
  const prefix = `${path.basename(file)}.pre-`
  return readdirSync(path.dirname(file)).filter(name => name.startsWith(prefix) && /^\d{4}\.bak(?:\.\d+)?$/.test(name.slice(prefix.length))).map(name => path.join(path.dirname(file), name))
}
/** Raise the backup's own privacy trigger, compact its pages, and discard unreadable backups. */
export function scrubBackups(file, meetingId, { log = message => process.stderr.write(`${message}\n`) } = {}) {
  for (const backup of listBackups(file)) {
    let db
    try {
      db = new DatabaseSync(backup)
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meetings'").get()) continue
      const row = db.prepare('SELECT confidential FROM meetings WHERE id=?').get(meetingId)
      if (!row || row.confidential) continue
      db.exec('PRAGMA secure_delete = ON')
      db.prepare('UPDATE meetings SET confidential=1 WHERE id=?').run(meetingId)
      db.exec('VACUUM')
    } catch {
      try { if (db?.isOpen) db.close() } catch {}
      try { unlinkSync(backup) } catch {}
      try { log(`deck: backup.scrub_failed ${path.basename(backup)}`) } catch {}
    } finally { if (db?.isOpen) db.close() }
  }
}
