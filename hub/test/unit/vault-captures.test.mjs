import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVaultClient } from '../../server/adapters/vault-mcp.mjs'
import { createVaultService, localDate } from '../../server/vault/service.mjs'
import { refreshCaptures } from '../../server/vault/captures.mjs'
import { recordLearnCall } from '../../server/ask/store.mjs'
import { openDeckDb } from '../../server/db/index.mjs'

async function harness (fn, mode = 'ok') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vcap-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  const client = createVaultClient({ command: [process.execPath, fileURLToPath(new URL('../fakes/fake-vault-mcp.mjs', import.meta.url))], env: { HOME: dir, XDG_RUNTIME_DIR: dir, VAULT_LANG: 'en', FAKE_VAULT_MODE: mode } })
  try { await client.start(); await fn({ store, service: createVaultService({ store, client }) }) } finally { await client.close(); store.close(); await rm(dir, { recursive: true, force: true }) }
}

test('captures use criado rather than mtime and attach only observed learns within two minutes before a daily entry', async () => harness(async ({ store, service }) => {
  const today = localDate(Date.now()).day
  const [y, m, d] = today.split('-').map(Number)
  const learnedAt = new Date(y, m - 1, d, 10, 39).getTime()
  store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/home/you/work/api','api',0,'api',1)")
  store.run("INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES('s1','observed','/home/you/work/api','/home/you/work/api','running',1,1,1,1,1)")
  let captures = await refreshCaptures({ service, store, day: today })
  assert.ok(captures.some(note => note.path === '02-wiki/docker/healthcheck-compose.md' && note.via === 'frontmatter'))
  assert.ok(!captures.some(note => note.path === '02-wiki/patterns/retry-backoff.md'), 'an old criado edited today is not a capture')
  recordLearnCall(store, { sessionId: 's1', repoId: '/home/you/work/api', slug: 'retry-backoff', at: learnedAt })
  recordLearnCall(store, { sessionId: 's1', repoId: '/home/you/work/api', slug: 'unmatched', at: learnedAt })
  captures = await refreshCaptures({ service, store, day: today })
  const learned = captures.find(note => note.path === '02-wiki/patterns/retry-backoff.md')
  assert.equal(learned.via, 'vault_learn')
  assert.equal(learned.sessionId, 's1')
  assert.equal(learned.repoName, 'api')
  assert.equal(learned.domain, 'patterns')
  assert.ok(!captures.some(note => note.path.includes('unmatched')))
  assert.equal((await refreshCaptures({ service, store, day: today })).length, captures.length)
}))

test('learns outside the time window or after the daily entry never attach a session', async () => harness(async ({ store, service }) => {
  const day = localDate(Date.now()).day
  const [y, m, d] = day.split('-').map(Number)
  for (const at of [new Date(y, m - 1, d, 10, 37).getTime(), new Date(y, m - 1, d, 10, 41).getTime(), new Date(y, m - 1, d - 1, 10, 39).getTime()]) {
    recordLearnCall(store, { sessionId: null, repoId: null, slug: 'retry-backoff', at })
  }
  const captures = await refreshCaptures({ service, store, day })
  assert.ok(!captures.some(note => note.path === '02-wiki/patterns/retry-backoff.md'))
}))

test('without vault_graph captures fall back to the daily links', async () => harness(async ({ store, service }) => {
  const captures = await refreshCaptures({ service, store, day: localDate(Date.now()).day })
  assert.deepEqual(captures.map(note => note.path), ['02-wiki/docker/healthcheck-compose.md'])
}, 'no-graph'))

test('refresh reads at most 50 candidates, tolerates a missing daily and propagates unavailable vaults', async () => harness(async ({ store }) => {
  const day = localDate(Date.now()).day
  let reads = 0
  const service = {
    list: async () => [],
    graph: async () => ({ nodes: Array.from({ length: 60 }, (_, i) => ({ id: `02-wiki/test/${i}.md`, mtime_ms: Date.now() })) }),
    readNote: async path => {
      if (path.startsWith('04-daily')) throw Object.assign(Error('missing'), { code: 'vault_error', details: { text: `note not found: ${path}` } })
      reads++
      return { frontmatter: { criado: day } }
    }
  }
  assert.equal((await refreshCaptures({ service, store, day })).length, 50)
  assert.equal(reads, 50)
  service.readNote = async () => { throw Object.assign(Error('down'), { code: 'vault_unavailable' }) }
  await assert.rejects(refreshCaptures({ service, store, day }), { code: 'vault_unavailable' })
}))
