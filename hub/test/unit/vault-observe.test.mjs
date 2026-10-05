import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector } from '../../server/machines/projector.mjs'
import { observeToolUse, slugify } from '../../server/vault/observe.mjs'
import { sessionMemory, learnCallsSince } from '../../server/ask/store.mjs'

async function withStore (fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vobs-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  store.run("INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES('/home/you/work/api','api',0,'api',1)")
  store.run("INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES('s1','observed','/home/you/work/api','/home/you/work/api','running',1,1,1,1,1)")
  try { await fn(store) } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}
const session = { id: 's1', repo_id: null }
const hook = (tool_name, tool_input, hook_event_name = 'PreToolUse') => ({ hook_event_name, tool_name, tool_input })

test('read observation accepts any MCP server prefix but refuses post hooks and unsafe or oversized paths', async () => withStore(store => {
  for (const prefix of ['vault', 'notes']) assert.equal(observeToolUse(store, { session, hook: hook(`mcp__${prefix}__vault_get_note`, { path: '02-wiki/a.md', private: 'secret' }), at: 10 }), true)
  for (const invalid of ['../a.md', 'a/../b.md', '/a.md', 'C:/a.md', 'a\\b.md', 'a\0.md', 'x'.repeat(513) + '.md', 'a.txt', 42]) {
    assert.equal(observeToolUse(store, { session, hook: hook('mcp__vault__vault_get_note', { path: invalid }), at: 11 }), false)
  }
  assert.equal(observeToolUse(store, { session, hook: hook('mcp__vault__vault_get_note', { path: 'a.md' }, 'PostToolUse'), at: 11 }), false)
  assert.equal(store.get('SELECT count(*) AS n FROM note_reads').n, 2)
  assert.deepEqual(sessionMemory(store, 's1').read, [{ path: '02-wiki/a.md', at: 10 }])
}))

test('learning observations store only a folded slug, session and repo and reject invalid titles', async () => withStore(store => {
  assert.equal(slugify('  Filas, Ação e Retry! '), 'filas-acao-e-retry')
  assert.equal(observeToolUse(store, { session, hook: hook('mcp__notes__vault_learn', { titulo: 'Filas, Ação e Retry!', insight: 'private body' }), at: 10 }), true)
  for (const titulo of [null, 42, '', '---', 'x'.repeat(513)]) assert.equal(observeToolUse(store, { session, hook: hook('mcp__vault__vault_learn', { titulo }), at: 10 }), false)
  assert.equal(observeToolUse(store, { session, hook: hook('Read', { titulo: 'Ignored' }), at: 10 }), false)
  assert.deepEqual(learnCallsSince(store, 0), [{ id: 1, sessionId: 's1', repoId: null, slug: 'filas-acao-e-retry', at: 10 }])
}))

test('projector records late MCP reads, counts learns since local midnight, deduplicates and rolls back atomically', async () => withStore(store => {
  const now = new Date(2026, 9, 5, 12).getTime()
  const projector = createProjector({ store, now: () => now })
  const envelope = (name, input, at, key) => ({ v: 1, hookTs: at, receivedAt: now, ptyId: null, claudePid: 42, pidChain: [42], truncated: false, dedupeKey: key, hook: {
    session_id: 's1', transcript_path: '/home/you/.claude/projects/x/a.jsonl', cwd: '/home/you/work/api', ...hook(name, input)
  } })
  projector.applyHooks([envelope('mcp__vault__vault_learn', { titulo: 'Today learn' }, now, 'learn')])
  const id = store.get("SELECT session_id FROM hook_events WHERE dedupe_key='learn'").session_id
  assert.equal(projector.snapshot().sessions.find(row => row.id === id).learnedToday, 1)
  const late = envelope('mcp__notes__vault_get_note', { path: '02-wiki/a.md' }, now - 1000, 'late-read')
  projector.applyHooks([late, late])
  assert.equal(store.get('SELECT count(*) AS n FROM note_reads WHERE session_id=?', id).n, 1)
  projector.applyHooks([envelope('mcp__vault__vault_learn', { titulo: 'Yesterday' }, now - 86400000, 'yesterday')])
  assert.equal(projector.snapshot().sessions.find(row => row.id === id).learnedToday, 1)
  const original = store.appendEvent
  store.appendEvent = () => { throw Error('rollback probe') }
  try { assert.throws(() => projector.applyHooks([envelope('mcp__vault__vault_get_note', { path: 'rollback.md' }, now + 1, 'rollback')]), /rollback probe/) } finally { store.appendEvent = original }
  assert.equal(store.get("SELECT count(*) AS n FROM note_reads WHERE path='rollback.md'").n, 0)
}))
