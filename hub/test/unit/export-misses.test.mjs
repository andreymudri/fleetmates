import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDeckDb } from '../../server/db/index.mjs'
import { insertMiss, resolveMiss } from '../../server/ask/store.mjs'
import { exportMisses } from '../../server/ask/export-misses.mjs'

test('miss export selects retrieval resolutions and open queries, with a read-only private CLI output', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'export-'))
  const state = path.join(home, '.local/state/fleetmates/deck')
  await mkdir(state, { recursive: true })
  const file = path.join(state, 'deck.db')
  const store = openDeckDb(file)
  try {
    for (const [i, resolution] of [null, 'note:02-wiki/x.md', 'dismissed', 'research:r1'].entries()) {
      const miss = insertMiss(store, { question: `Query ${i}`, threadId: null, searchedTerms: [], at: i + 1 })
      if (resolution?.startsWith('research:')) store.run('UPDATE misses SET resolved_by=? WHERE id=?', resolution, miss.id)
      else if (resolution) resolveMiss(store, miss.id, resolution)
    }
    const parse = lines => lines.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(parse(exportMisses(store)), [{ query: 'Query 1', expectedTopPath: '02-wiki/x.md', askedAt: 2 }])
    assert.deepEqual(parse(exportMisses(store, { kind: 'all' })).map(row => row.expectedTopPath), [null, '02-wiki/x.md'])
    store.get('PRAGMA wal_checkpoint(TRUNCATE)')
    const before = await readFile(file), version = store.get('PRAGMA user_version').user_version
    const cli = fileURLToPath(new URL('../../bin/fleetmates-deck.mjs', import.meta.url))
    const out = path.join(home, 'queries.jsonl')
    const result = spawnSync(process.execPath, [cli, 'export-misses', '--kind', 'all', '--out', out], { env: { HOME: home }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(parse(await readFile(out, 'utf8')).length, 2)
    assert.equal((await stat(out)).mode & 0o777, 0o600)
    assert.deepEqual(await readFile(file), before)
    assert.equal(store.get('PRAGMA user_version').user_version, version)
    const invalid = spawnSync(process.execPath, [cli, 'export-misses', '--kind', 'other'], { env: { HOME: home }, encoding: 'utf8' })
    assert.equal(invalid.status, 2)
    assert.match(invalid.stderr, /usage:/)
  } finally { store.close(); await rm(home, { recursive: true, force: true }) }
})
