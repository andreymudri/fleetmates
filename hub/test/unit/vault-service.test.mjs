import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVaultClient } from '../../server/adapters/vault-mcp.mjs'
import { createVaultService, localDate } from '../../server/vault/service.mjs'
import { openDeckDb } from '../../server/db/index.mjs'
import { upsertCapture, capturesOn, recordNoteRead } from '../../server/ask/store.mjs'

const worker = '02-wiki/nestjs/bullmq-worker.md'
async function harness (fn, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vsvc-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  const client = createVaultClient({ command: [process.execPath, fileURLToPath(new URL('../fakes/fake-vault-mcp.mjs', import.meta.url))], env: { HOME: dir, XDG_RUNTIME_DIR: dir, VAULT_LANG: 'en', ...extra } })
  try {
    await client.start()
    await fn({ store, client, service: createVaultService({ client, store }) })
  } finally { await client.close(); store.close(); await rm(dir, { recursive: true, force: true }) }
}

test('vault service resolves graph, note links, backlinks, titles, usage and capture opening through MCP', async () => harness(async ({ service, store }) => {
  const day = localDate(Date.now()).day
  upsertCapture(store, { path: worker, day, capturedAt: Date.now(), via: 'frontmatter' })
  const graph = await service.graph({ tags: ['nestjs'], maxNodes: 20 })
  assert.ok(graph.nodes.length > 0)
  assert.ok(graph.nodes.every(node => node.tags.includes('nestjs')))
  assert.ok(service.knownPaths().has(worker))
  const result = await service.note(worker)
  assert.equal(result.note.title, 'BullMQ worker')
  assert.equal(result.backlinks.length, 3)
  assert.ok(result.linksOut.some(note => note.path.endsWith('/auth-guard.md') && note.domain === 'nestjs'))
  assert.deepEqual(result.usage, { citedIn: [], readBy: [] })
  assert.equal(capturesOn(store, day)[0].opened, true)
  const hits = await service.search('retry backoff', 100)
  assert.ok(hits.some(hit => hit.path === worker && hit.title === 'BullMQ worker' && hit.line > 0))
  assert.ok(Number.isFinite(await service.lineBound(worker)))
}))

test('missing graph capability, MCP tool errors and rejected calls have distinct contract codes', async () => {
  await harness(async ({ service }) => {
    await assert.rejects(service.graph(), error => error.code === 'vault_tool_missing' && error.details.tool === 'vault_graph')
    await assert.rejects(service.note('absent.md'), error => error.code === 'vault_error' && error.details.text === 'note not found: absent.md')
  }, { FAKE_VAULT_MODE: 'no-graph' })
  const service = createVaultService({ client: { call: async () => { throw Error('private host details') } }, store: {} })
  await assert.rejects(service.list(), error => error.code === 'vault_unavailable' && !JSON.stringify(error.details).includes('private'))
  const unavailable = createVaultService({ client: { health: () => ({ state: 'down', capabilities: [] }) }, store: {} })
  await assert.rejects(unavailable.graph(), error => error.code === 'vault_unavailable')
})

test('list caches are filter-specific, defensive, expire after 60 seconds and feed known paths', async () => {
  let at = 0
  const calls = []
  const client = { call: async (tool, args) => {
    calls.push({ tool, args })
    return { structured: { notes: [{ path: '02-wiki/test/note.md', title: args.tipo ?? 'Note', tags: ['a'] }] }, isError: false }
  } }
  const service = createVaultService({ client, store: {}, now: () => at })
  const notes = await service.list()
  notes[0].tags.push('poison')
  assert.deepEqual((await service.list())[0].tags, ['a'])
  assert.equal(calls.length, 1)
  assert.equal((await service.list({ tipo: 'moc' }))[0].title, 'moc')
  assert.equal(calls.length, 2)
  assert.ok(service.knownPaths().has('02-wiki/test/note.md'))
  at = 60000
  assert.equal(service.knownPaths().size, 0)
  await service.list()
  assert.equal(calls.length, 3)
})

test('line bounds reconstruct continuation pages, cache briefly and stop on large or stalled notes', async () => {
  let at = 0
  let mode = 'pages'
  const offsets = []
  const client = { call: async (tool, args) => {
    offsets.push(args.offset ?? 0)
    return { isError: false, structured: { note: {
      path: 'x.md', frontmatter: args.offset ? null : { tipo: 'wiki' }, body: args.offset ? 'b\nc' : 'a\n',
      total: mode === 'large' ? 200001 : 5, offset: args.offset ?? 0,
      truncated: mode === 'stalled' || !args.offset, nextOffset: mode === 'stalled' ? 0 : 2
    } } }
  } }
  const service = createVaultService({ client, store: {}, now: () => at })
  const bound = await service.lineBound('x.md')
  assert.ok(Number.isFinite(bound) && bound >= 3)
  assert.deepEqual(offsets, [0, 2])
  assert.equal(await service.lineBound('x.md'), bound)
  assert.equal(offsets.length, 2)
  at = 60000
  mode = 'large'
  assert.equal(await service.lineBound('x.md'), Infinity)
  assert.equal(offsets.length, 3)
  at = 120000
  mode = 'stalled'
  assert.equal(await service.lineBound('x.md'), Infinity)
  assert.equal(offsets.length, 4)
})

test('session memory retains recorded notes when vault access is down and uses only three related hits', async () => harness(async ({ service, store, client }) => {
  store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/home/you/work/api','api',0,'api',1)")
  store.run("INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES('s1','observed','/home/you/work/api','/home/you/work/api','running',1,1,1,1,1)")
  recordNoteRead(store, { sessionId: 's1', path: worker, at: 1 })
  const memory = await service.sessionMemory('s1', 'retry backoff')
  assert.ok(memory.related.length <= 3)
  assert.ok(memory.related.length > 0)
  assert.deepEqual(memory.read, [{ path: worker, at: 1 }])
  await client.close()
  const offline = await service.sessionMemory('s1', 'retry backoff')
  assert.equal(offline.related, null)
  assert.equal(offline.relatedError.code, 'vault_unavailable')
  assert.deepEqual(offline.read, memory.read)
}))

test('vault and ask modules never import filesystem access except the state-only ask engine', async () => {
  for (const folder of ['vault', 'ask']) {
    const directory = new URL(`../../server/${folder}/`, import.meta.url)
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.mjs') || folder === 'ask' && name === 'engine.mjs') continue
      const code = (await readFile(new URL(name, directory), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      assert.doesNotMatch(code, /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?fs(?:\/promises)?['"]/, name)
    }
  }
})
