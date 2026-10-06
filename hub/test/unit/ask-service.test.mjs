import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openDeckDb } from '../../server/db/index.mjs'
import { createAskService } from '../../server/ask/service.mjs'
import { appendMessage, createThread, getThread, listMisses } from '../../server/ask/store.mjs'

async function harness (t, state = 'ok') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asks-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  const runs = [], events = [], logs = []
  const engine = {
    run (options) {
      let resolve
      const promise = new Promise(done => { resolve = done })
      promise.runId = `run-${runs.length}`
      runs.push({ options, resolve, id: promise.runId })
      return promise
    },
    cancel (id) { runs.find(run => run.id === id)?.resolve({ status: 'cancelled', text: 'Partial answer' }) },
    reapOrphans () {}
  }
  const service = createAskService({ store, engine, vault: { knownPaths: () => new Set(['known.md']), lineBound: async () => 5 },
    health: () => ({ state }), prefs: () => ({ vaultPath: '/home/you/vault', vaultCommand: ['fake-mcp'], lang: 'en' }),
    publish: event => events.push(event), log: entry => logs.push(entry) })
  t.after(async () => { await service.close(); store.close(); await rm(dir, { recursive: true, force: true }) })
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)) }
  return { store, service, runs, events, logs, settle }
}
const answer = (text, block) => `${text}\n\n\x60\x60\x60deck-answer\n${JSON.stringify(block)}\n\x60\x60\x60`

test('ask persists validated citations, streams ephemeral events and keeps private text out of logs', async t => {
  const h = await harness(t)
  const started = h.service.ask({ text: 'Private question' })
  assert.throws(() => h.service.ask({ threadId: started.thread.id, text: 'second' }), error => error.status === 409)
  h.runs[0].options.onDelta('Private answer')
  h.runs[0].resolve({ status: 'complete', text: answer('Private answer', { isMiss: false, citations: [
    { path: 'known.md', line: 100, viaGraph: false }, { path: 'missing.md', line: 1, viaGraph: false }
  ] }), toolPaths: ['known.md'], searchHits: [{ path: 'known.md', line: 100 }], retrievalEmpty: true })
  await h.settle()
  const message = getThread(h.store, started.thread.id).messages[1]
  assert.equal(message.text, 'Private answer')
  assert.deepEqual(message.citations, [{ path: 'known.md', line: 100, viaGraph: false }])
  assert.equal(message.droppedCitations, 1)
  assert.equal(listMisses(h.store).length, 0)
  assert.deepEqual(h.events.map(event => event.type), ['ask.delta', 'ask.done'])
  assert.ok(h.events.every(event => event.data.ephemeral && event.data.scope === 'vault'))
  assert.equal(h.store.get("SELECT count(*) AS n FROM events WHERE type LIKE 'ask.%'").n, 0)
  assert.doesNotMatch(JSON.stringify(h.logs), /Private question|Private answer/)
  const followup = h.service.ask({ threadId: started.thread.id, text: 'Follow up' })
  assert.match(h.runs[1].options.prompt, /Earlier in this thread[\s\S]*Private question[\s\S]*Private answer[\s\S]*Follow up/)
  h.service.cancel(followup.assistantMessageId)
  await h.settle()
  assert.equal(getThread(h.store, started.thread.id).messages.at(-1).status, 'cancelled')
  assert.throws(() => h.service.cancel(followup.assistantMessageId), error => error.status === 409)
})

test('only an explicit model miss creates a miss, using search queries as fallback', async t => {
  const h = await harness(t)
  const started = h.service.ask({ text: 'Missing knowledge' })
  h.runs[0].resolve({ status: 'complete', text: answer('No matching notes', { isMiss: true, citations: [], searched: [] }), searches: [{ query: 'needle', resultCount: 0 }] })
  await h.settle()
  assert.equal(listMisses(h.store).length, 1)
  assert.equal(listMisses(h.store)[0].question, 'Missing knowledge')
  assert.deepEqual(listMisses(h.store)[0].searchedTerms, ['needle'])
  assert.deepEqual(h.events.map(event => event.type), ['misses.changed', 'ask.done'])
  assert.equal(h.events[0].data.unresolved, 1)
  const plain = h.service.ask({ text: 'Plain answer' })
  h.runs[1].resolve({ status: 'complete', text: 'Unstructured answer', retrievalEmpty: true })
  await h.settle()
  assert.equal(getThread(h.store, plain.thread.id).messages[1].unverified, true)
  assert.equal(listMisses(h.store).length, 1)
})

test('down vault refuses before spawning; errors store no prose and restart recovers unfinished rows', async t => {
  const down = await harness(t, 'down')
  assert.throws(() => down.service.ask({ text: 'Question' }), error => error.status === 503 && error.code === 'vault_unavailable')
  assert.equal(down.runs.length, 0)
  const h = await harness(t)
  const started = h.service.ask({ text: 'Question' })
  h.runs[0].resolve({ status: 'error', text: 'Unsafe partial answer', error: 'failed' })
  await h.settle()
  const message = getThread(h.store, started.thread.id).messages[1]
  assert.equal(message.text, '')
  assert.equal(message.status, 'error')
  assert.equal(h.events[0].type, 'ask.error')
  const thread = createThread(h.store, { title: 'Interrupted', at: Date.now() })
  appendMessage(h.store, { threadId: thread.id, role: 'assistant', text: '', at: Date.now() })
  h.service.reapOrphans()
  assert.equal(getThread(h.store, thread.id).messages[0].error, 'interrupted by a deck restart')
  assert.equal(getThread(h.store, started.thread.id).messages[1].error, 'failed')
})
