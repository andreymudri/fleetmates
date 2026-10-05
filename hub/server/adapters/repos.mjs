// Repo discovery for the deck: the scan-root walk behind POST /api/repos/rescan and the repo row a deckd PTY
// in an unknown working tree needs. Moved out of main.mjs unchanged; the walk stays at depth 2 (owner decision
// 2026-10-01).
import fs from 'node:fs'
import path from 'node:path'
import { apiError } from '../http/router.mjs'

/**
 * The first free crew slot (0 to 8) among unarchived repos holding their own slot, or undefined when all nine
 * are taken.
 * @param {{ all: Function }} store
 * @returns {number | undefined}
 */
function freeSlot(store) {
  const occupied = new Set(store.all('SELECT crew_slot FROM repos WHERE archived_at IS NULL AND crew_slot_shared=0').map(row => row.crew_slot))
  return Array.from({ length: 9 }, (_, i) => i).find(slot => !occupied.has(slot))
}

/**
 * Walk `root` two directory levels deep and insert every git working tree not yet in `repos` (the body of
 * `services.rescan`, moved unchanged). Only a root that cannot be read fails (500 `settings_io_failed`); an
 * unreadable directory below it is skipped, so one locked folder does not hide the repos beside it.
 * @param {{ store: object, root: string, now: () => number, onInsert?: (id: string) => void }} options
 *   `onInsert` runs after each new row is written (main.mjs publishes `repo.upserted` there)
 * @returns {{ found: number }} how many repos were inserted
 */
export function scanRepos({ store, root, now, onInsert = () => {} }) {
  let found = 0
  function visit(dir, depth, top = false) {
    let entries = []
    let repo = false
    try {
      if (!fs.lstatSync(dir).isDirectory()) return
      repo = fs.existsSync(path.join(dir, '.git'))
      if (!repo && depth > 0) entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      if (top) throw apiError(500, 'settings_io_failed')
      return
    }
    if (repo) {
      const id = fs.realpathSync(dir)
      if (!store.get('SELECT id FROM repos WHERE id=?', id)) {
        let name = path.basename(dir)
        if (store.get('SELECT id FROM repos WHERE name=?', name)) name = `${path.basename(path.dirname(dir))}/${name}`
        const slot = freeSlot(store)
        store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', id, name, slot ?? 0, slot === undefined ? 1 : 0, name, now())
        found++
        onInsert(id)
      }
      return
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) visit(path.join(dir, entry.name), depth - 1)
  }
  visit(root, 2, true)
  return { found }
}

/**
 * Insert the repo row for `repoId` (a working-tree root) when it is missing, as the deckd reconciliation does
 * for a PTY found in an unknown tree. A name already taken becomes the full path.
 * @param {object} store
 * @param {string} repoId
 * @param {() => number} now
 * @returns {boolean} whether a row was inserted
 */
export function ensureRepo(store, repoId, now) {
  if (store.get('SELECT id FROM repos WHERE id=?', repoId)) return false
  let name = path.basename(repoId)
  if (store.get('SELECT id FROM repos WHERE name=?', name)) name = repoId
  const slot = freeSlot(store)
  store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', repoId, name, slot ?? 0, slot === undefined ? 1 : 0, name, now())
  return true
}
