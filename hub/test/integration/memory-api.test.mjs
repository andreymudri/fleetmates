import assert from 'node:assert/strict'
import { test } from 'node:test'
import { insertMiss } from '../../server/ask/store.mjs'
import { memoryHarness as harness, waitFor } from '../helpers/memory-harness.mjs'
const worker = '02-wiki/nestjs/bullmq-worker.md'

test('memory routes use MCP, persist streamed asks and open vault notes through Obsidian', async t => {
  const h = await harness(t)
  const graph = await h.request('/api/vault/graph')
  assert.equal(graph.status, 200)
  assert.equal(graph.data.nodes.length, 22)
  assert.ok((await h.request('/api/vault/list')).data.notes.some(note => note.path === worker))
  assert.equal((await h.request(`/api/vault/note?path=${encodeURIComponent(worker)}`)).data.note.title, 'BullMQ worker')
  assert.ok((await h.request('/api/vault/search?q=retry')).data.hits.length)
  assert.ok(Array.isArray((await h.request('/api/vault/captures')).data.captures))
  const opened = await h.request('/api/open', 'POST', { kind: 'vaultNote', ref: worker })
  assert.equal(opened.status, 202)
  assert.deepEqual(h.opened, [`obsidian://open?vault=Test%20vault&file=${encodeURIComponent(worker)}`])
  assert.equal((await h.request('/api/open', 'POST', { kind: 'vaultNote', ref: 'missing.md' })).data.error.code, 'vault_error')
  const started = await h.request('/api/ask', 'POST', { text: 'How does retry work?' })
  assert.equal(started.status, 202)
  const id = started.data.thread.id
  assert.equal((await h.request('/api/ask', 'POST', { threadId: id, text: 'Again?' })).status, 409)
  const done = await waitFor(() => h.events.find(event => event.type === 'ask.done'))
  assert.ok(h.events.some(event => event.type === 'ask.delta'))
  assert.equal(done.data.message.citations.length, 2)
  assert.ok(h.events.filter(event => event.type.startsWith('ask.')).every(event => event.data.ephemeral && !Object.hasOwn(event, 'seq')))
  assert.equal(h.deck.store.get("SELECT count(*) AS n FROM events WHERE type LIKE 'ask.%'").n, 0)
  assert.equal((await h.request(`/api/threads/${id}`)).data.messages[1].text, done.data.message.text)
  assert.equal((await h.request('/api/threads')).data.threads[0].id, id)
  const miss = insertMiss(h.deck.store, { question: 'Unknown topic', threadId: id, searchedTerms: [], at: Date.now() })
  assert.equal((await h.request('/api/misses')).data.unresolved, 1)
  assert.equal((await h.request(`/api/misses/${miss.id}/resolve`, 'POST', { resolvedBy: 'research:1' })).status, 422)
  assert.equal((await h.request(`/api/misses/${miss.id}/resolve`, 'POST', { resolvedBy: 'note:02-wiki/x.md' })).data.miss.resolvedBy, 'note:02-wiki/x.md')
  assert.equal((await h.request(`/api/threads/${id}`, 'DELETE')).status, 200)
  assert.equal((await h.request(`/api/threads/${id}`)).status, 404)
})

test('missing graph tool reports 501 and offline MCP reports retryable 503 while sessions remain available', async t => {
  const degraded = await harness(t, 'no-graph')
  const missing = await degraded.request('/api/vault/graph')
  assert.equal(missing.status, 501)
  assert.equal(missing.data.error.code, 'vault_tool_missing')
  const down = await harness(t, 'exit1')
  for (const route of ['/api/vault/graph', '/api/vault/list', `/api/vault/note?path=${worker}`, '/api/vault/search?q=retry', '/api/vault/captures']) {
    const response = await down.request(route)
    assert.equal(response.status, 503, route)
    assert.equal(response.data.error.code, 'vault_unavailable')
    assert.equal(response.data.error.retryable, true)
  }
  assert.equal((await down.request('/api/sessions')).status, 200)
  const health = (await down.request('/api/health')).data.deps.find(dep => dep.dep === 'vault-mcp')
  assert.equal(health.state, 'down')
  assert.match(health.reason, /VAULT_PATH is not a directory/)
})
