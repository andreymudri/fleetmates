import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { WebSocket } from 'ws'
import { memoryHarness, token, waitFor } from '../helpers/memory-harness.mjs'

test('vault asks emit ephemeral cited, miss and general-knowledge answers and restore persisted threads', async t => {
  let fixture = 'answer-cited'
  const h = await memoryHarness(t, 'ok', { fixture: () => fixture, delay: '0' })
  const ws = new WebSocket(h.base.replace('http:', 'ws:') + '/api/ws', ['deck.v1', `deck.auth.${token}`], { origin: h.base })
  const messages = []
  ws.on('message', raw => messages.push(JSON.parse(raw)))
  await once(ws, 'open')
  t.after(() => ws.close())
  ws.send(JSON.stringify({ t: 'hello', apiVersion: 1, lastSeq: 0, epoch: null }))
  await waitFor(() => messages.find(message => message.t === 'snapshot'))
  const ask = async (name, text) => {
    fixture = name
    const response = await h.request('/api/ask', 'POST', { text })
    assert.equal(response.status, 202)
    const done = await waitFor(() => messages.find(message => message.t === 'ask.done' && message.data.threadId === response.data.thread.id))
    assert.equal(Object.hasOwn(done, 'seq'), false)
    assert.equal(done.data.ephemeral, true)
    const restored = await h.request(`/api/threads/${response.data.thread.id}`)
    assert.deepEqual(restored.data.messages[1], done.data.message)
    return done.data.message
  }
  const cited = await ask('answer-cited', 'How do retries work?')
  assert.equal(cited.citations.length, 2)
  assert.ok(cited.citations.some(citation => citation.viaGraph))
  assert.ok(messages.some(message => message.t === 'ask.delta' && message.data.ephemeral && !Object.hasOwn(message, 'seq')))
  const miss = await ask('answer-miss', 'How do Kubernetes operators work?')
  assert.equal(miss.isMiss, true)
  await waitFor(() => messages.find(message => message.t === 'misses.changed'))
  const listed = await h.request('/api/misses')
  assert.equal(listed.data.unresolved, 1)
  assert.ok(listed.data.misses[0].searchedTerms.length)
  assert.equal(listed.data.misses[0].resolvedBy, null)
  const general = await ask('general-knowledge', 'How do healthchecks work?')
  assert.match(general.generalKnowledge, /depends_on/)
  assert.equal(general.text.includes(general.generalKnowledge), false)
  assert.equal(h.deck.store.get("SELECT count(*) AS n FROM events WHERE type LIKE 'ask.%' OR type='misses.changed'").n, 0)
  for (const argv of h.askSpawns) {
    assert.equal(argv[argv.indexOf('--tools') + 1], '')
    assert.equal(argv.includes('--strict-mcp-config'), true)
    assert.deepEqual(argv[argv.indexOf('--allowedTools') + 1].split(',').sort(), ['vault_search', 'vault_get_note', 'vault_list', 'vault_backlinks'].map(name => `mcp__vault__${name}`).sort())
    for (const tool of ['vault_write_note', 'vault_edit_note', 'vault_learn', 'vault_move', 'vault_delete']) assert.ok(argv[argv.indexOf('--disallowedTools') + 1].split(',').includes(`mcp__vault__${tool}`))
  }
  assert.doesNotMatch(await readFile(h.vaultLog, 'utf8'), /write:/)
})
test('the fake CLI refuses an Ask invocation that allows vault_learn and the service stores an empty error', async t => {
  const h = await memoryHarness(t, 'ok', { delay: '0', transformAsk: args => {
    const argv = [...args], at = argv.indexOf('--allowedTools') + 1
    argv[at] += ',mcp__vault__vault_learn'
    return argv
  } })
  const started = await h.request('/api/ask', 'POST', { text: 'A read-only question' })
  assert.equal(started.status, 202)
  await waitFor(() => h.events.find(event => event.type === 'ask.error'))
  const restored = await h.request(`/api/threads/${started.data.thread.id}`)
  assert.equal(restored.data.messages[1].status, 'error')
  assert.equal(restored.data.messages[1].text, '')
  assert.doesNotMatch(await readFile(h.vaultLog, 'utf8'), /write:/)
})
