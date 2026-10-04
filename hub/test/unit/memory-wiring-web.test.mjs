// M5 web client plumbing for Memory (docs/plans/2026-10-04-deck-m5.md Task 8): the memory REST helpers of
// actions.js, the Memory reducers and routes of deck-store.js, and the Citation and NoteChip components under
// renderToStaticMarkup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import * as actions from '../../web/src/state/actions.js'
import { reduce, initialState, matchRoute, memoryQuery, noteLine } from '../../web/src/state/deck-store.js'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load(rel) {
  const { module } = await runnerImport(path.join(hub, 'web/src', rel), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const message = msg => ({ type: 'message', message: msg })
const snapshot = (seq, extra = {}) => message({
  t: 'snapshot', seq, epoch: 'e1', data: {
    sessions: [], requests: [], runs: [], repos: [], counts: null, order: [], recap: null, ruleOffers: [], research: [],
    recorder: { state: 'idle' }, health: [], prefs: { lang: 'en', firstRunCompletedAt: 1 }, setup: { firstRunCompletedAt: 1 }, ...extra
  }
})
const loaded = (extra = {}) => reduce(initialState(), snapshot(1, extra))
const delta = (threadId, messageId, text) => message({ t: 'ask.delta', data: { threadId, messageId, text, ephemeral: true } })
const vaultThread = id => ({ id, title: `t-${id}`, scope: 'vault', createdAt: 1, updatedAt: 1 })
const started = (state, threadId, assistantMessageId, question = 'q') =>
  reduce(state, { type: 'memory.askStarted', thread: vaultThread(threadId), userMessage: { id: `u-${assistantMessageId}`, threadId, role: 'user', text: question }, assistantMessageId })
const messagesOf = (state, threadId) => state.memory.messages[threadId] ?? []
const assistantOf = (state, threadId, id) => messagesOf(state, threadId).find(row => row.id === id)

function fakeApi() {
  const calls = []
  const record = method => async (to, body) => {
    calls.push(body === undefined ? [method, to] : [method, to, body])
    return {}
  }
  return { calls, get: record('GET'), post: record('POST'), patch: record('PATCH'), del: record('DELETE') }
}

test('each memory action sends its method, URL and body, with a note path encoded as one value', async () => {
  const api = fakeApi()
  const odd = '02-wiki/filas/retry #2?.md'
  await actions.fetchGraph(api, { tags: ['nestjs', 'filas'], status: 'ativo', folder: '02-wiki', maxNodes: 300 })
  await actions.fetchGraph(api)
  await actions.fetchVaultList(api, { folder: '02-wiki/nestjs', tags: ['moc'], tipo: 'moc' })
  await actions.fetchNote(api, odd)
  await actions.searchVault(api, 'retry #2', 10)
  await actions.searchVault(api, 'filas')
  await actions.fetchCaptures(api, '2026-10-04')
  await actions.fetchCaptures(api)
  await actions.fetchMisses(api)
  await actions.resolveMiss(api, 'mi/1', `note:${odd}`)
  await actions.askVault(api, { text: 'Como funcionam os retries?' })
  await actions.askVault(api, { threadId: 'th1', text: 'E o backoff?' })
  await actions.cancelAsk(api, 'm#1')
  await actions.fetchThreads(api, { limit: 10 })
  await actions.fetchThreads(api)
  await actions.fetchThread(api, 'th/1')
  await actions.deleteThread(api, 'th/1')
  await actions.fetchSessionMemory(api, 's#1')
  await actions.openVaultNote(api, odd)
  assert.deepEqual(api.calls, [
    ['GET', '/api/vault/graph?tags=nestjs%2Cfilas&status=ativo&folder=02-wiki&maxNodes=300'],
    ['GET', '/api/vault/graph'],
    ['GET', '/api/vault/list?folder=02-wiki%2Fnestjs&tags=moc&tipo=moc'],
    ['GET', '/api/vault/note?path=02-wiki%2Ffilas%2Fretry%20%232%3F.md'],
    ['GET', '/api/vault/search?q=retry+%232&limit=10'],
    ['GET', '/api/vault/search?q=filas'],
    ['GET', '/api/vault/captures?day=2026-10-04'],
    ['GET', '/api/vault/captures'],
    ['GET', '/api/misses'],
    ['POST', '/api/misses/mi%2F1/resolve', { resolvedBy: `note:${odd}` }],
    ['POST', '/api/ask', { text: 'Como funcionam os retries?' }],
    ['POST', '/api/ask', { threadId: 'th1', text: 'E o backoff?' }],
    ['POST', '/api/ask/m%231/cancel'],
    ['GET', '/api/threads?limit=10'],
    ['GET', '/api/threads'],
    ['GET', '/api/threads/th%2F1'],
    ['DELETE', '/api/threads/th%2F1'],
    ['GET', '/api/sessions/s%231/memory'],
    ['POST', '/api/open', { kind: 'vaultNote', ref: odd }]
  ])
  // The server reads back exactly the path the browser sent.
  assert.equal(new URL(`http://x${api.calls[3][1]}`).searchParams.get('path'), odd)
})

test('ask.delta appends only to its own message, in its own thread', () => {
  let state = loaded()
  state = started(state, 'th1', 'a1')
  state = started(state, 'th2', 'a2')
  state = reduce(state, delta('th1', 'a1', 'Retries usam '))
  state = reduce(state, delta('th1', 'a1', 'backoff exponencial.'))
  assert.equal(assistantOf(state, 'th1', 'a1').text, 'Retries usam backoff exponencial.')
  assert.equal(assistantOf(state, 'th1', 'a1').status, 'streaming')
  assert.equal(assistantOf(state, 'th2', 'a2').text, '', 'the other thread\'s message is untouched')
  assert.deepEqual(messagesOf(state, 'th1').map(row => row.role), ['user', 'assistant'])
  assert.equal(messagesOf(state, 'th1')[0].text, 'q')
  assert.deepEqual(state.memory.asking, { th1: 'a1', th2: 'a2' })
  assert.equal(state.memory.activeThreadId, 'th2')
})

test('deltas that arrive before memory.askStarted are applied after it, and a meeting ask still claims its own', () => {
  let state = loaded()
  state = reduce(state, delta('th9', 'a9', 'Guards '))
  state = reduce(state, delta('th9', 'a9', 'rodam antes.'))
  assert.equal(state.memory.messages.th9, undefined, 'an unknown thread is held, not shown')
  state = started(state, 'th9', 'a9')
  assert.equal(assistantOf(state, 'th9', 'a9').text, 'Guards rodam antes.')
  assert.equal(state.data.askPending.th9, undefined, 'the held stream is claimed')
  state = reduce(state, delta('th9', 'a9', ' Sempre.'))
  assert.equal(assistantOf(state, 'th9', 'a9').text, 'Guards rodam antes. Sempre.')
  // An answer that finished before the POST answer arrived is taken whole.
  state = reduce(state, message({ t: 'ask.done', data: { threadId: 'th8', message: { id: 'a8', role: 'assistant', text: 'pronto', citations: [], status: 'complete' }, ephemeral: true } }))
  state = started(state, 'th8', 'a8')
  assert.equal(assistantOf(state, 'th8', 'a8').status, 'complete')
  assert.equal(state.memory.asking.th8, undefined)
})

test('ask.done replaces the streamed text with the stored text and citations; ask.error marks the message', () => {
  let state = started(loaded(), 'th1', 'a1')
  state = reduce(state, delta('th1', 'a1', 'rascunho parcial'))
  const stored = { id: 'a1', threadId: 'th1', role: 'assistant', text: 'Texto final.', citations: [{ path: '02-wiki/nestjs/bullmq-worker.md', line: 13, viaGraph: false }], generalKnowledge: null, isMiss: false, status: 'complete', error: null, unverified: false, droppedCitations: 0, createdAt: 2 }
  state = reduce(state, message({ t: 'ask.done', data: { threadId: 'th1', message: stored, ephemeral: true } }))
  assert.deepEqual(assistantOf(state, 'th1', 'a1'), stored)
  assert.equal(state.memory.asking.th1, undefined)
  state = reduce(state, delta('th1', 'a1', 'tarde'))
  assert.equal(assistantOf(state, 'th1', 'a1').text, 'Texto final.', 'a late delta does not reopen a finished answer')

  state = started(state, 'th1', 'a2')
  state = reduce(state, message({ t: 'ask.error', data: { threadId: 'th1', messageId: 'a2', error: { code: 'ask_failed', message: 'timed out after 120 s' }, ephemeral: true } }))
  assert.equal(assistantOf(state, 'th1', 'a2').status, 'error')
  assert.equal(assistantOf(state, 'th1', 'a2').error.message, 'timed out after 120 s')
  assert.equal(state.memory.asking.th1, undefined)
})

test('a meeting-scope ask stream does not touch memory', () => {
  let state = loaded()
  state = reduce(state, { type: 'meeting.ask', thread: { id: 'mt', scope: 'meeting:m1' }, userMessage: { text: 'q' }, assistantMessageId: 'ma' })
  const memory = state.memory
  state = reduce(state, delta('mt', 'ma', 'Decidido.'))
  state = reduce(state, message({ t: 'ask.done', data: { threadId: 'mt', message: { id: 'ma', text: 'Decidido.' }, ephemeral: true } }))
  assert.equal(state.memory, memory)
  assert.equal(state.data.meetingAsk.m1.text, 'Decidido.')
  assert.equal(reduce(state, { type: 'memory.askStarted', thread: { id: 'mt', scope: 'meeting:m1' }, assistantMessageId: 'ma' }), state, 'memory.askStarted ignores a meeting thread')
})

test('threads load, list and delete; misses and the vault-mcp health row reach memory', () => {
  let state = loaded({ health: [{ dep: 'vault-mcp', state: 'up', reason: null, version: '0.3.0', capabilities: ['structured'] }] })
  assert.deepEqual(state.memory.vault, { state: 'up', reason: null, capabilities: ['structured'] })
  state = reduce(state, message({ t: 'health.changed', seq: 2, data: { dep: 'vault-mcp', state: 'down', reason: 'spawn npx ENOENT', version: null, capabilities: [] } }))
  assert.deepEqual(state.memory.vault, { state: 'down', reason: 'spawn npx ENOENT', capabilities: [] })
  state = reduce(state, message({ t: 'misses.changed', data: { unresolved: 3, ephemeral: true } }))
  assert.equal(state.memory.missesUnresolved, 3)
  state = reduce(state, { type: 'memory.missesFetched', unresolved: 2 })
  assert.equal(state.memory.missesUnresolved, 2)

  state = reduce(state, { type: 'memory.threadsListed', threads: [vaultThread('th1'), vaultThread('th2')] })
  assert.deepEqual(Object.keys(state.memory.threads), ['th1', 'th2'])
  state = reduce(state, { type: 'memory.threadLoaded', thread: vaultThread('th1'), messages: [{ id: 'u1', role: 'user', text: 'q' }, { id: 'a1', role: 'assistant', text: 'r', citations: [], status: 'complete' }] })
  assert.deepEqual(messagesOf(state, 'th1').map(row => row.id), ['u1', 'a1'])
  state = reduce(state, { type: 'memory.activeThread', id: 'th1' })
  assert.equal(state.memory.activeThreadId, 'th1')
  state = reduce(state, { type: 'memory.threadDeleted', id: 'th1' })
  assert.equal(state.memory.threads.th1, undefined)
  assert.equal(state.memory.messages.th1, undefined)
  assert.equal(state.memory.activeThreadId, null)
  // A snapshot keeps the browser's own Memory state.
  state = reduce(state, snapshot(5))
  assert.ok(state.memory.threads.th2)
  assert.equal(state.memory.missesUnresolved, 2)
})

test('no memory reducer touches sessionStorage, localStorage or IndexedDB', () => {
  const names = ['sessionStorage', 'localStorage', 'indexedDB']
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  const touched = []
  const trap = name => new Proxy({}, { get: (_, key) => { touched.push(`${name}.${String(key)}`)
    return () => {} } })
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { value: trap(name), configurable: true, writable: true })
    let state = reduce(initialState(), message({ t: 'ask.delta', data: { threadId: 'th', messageId: 'a', text: 'sentinel-early' } }))
    state = started(state, 'th', 'a', 'sentinel-question')
    state = reduce(state, delta('th', 'a', 'sentinel-answer'))
    state = reduce(state, message({ t: 'ask.done', data: { threadId: 'th', message: { id: 'a', text: 'sentinel-answer' } } }))
    state = reduce(state, { type: 'memory.threadLoaded', thread: vaultThread('th'), messages: [] })
    state = reduce(state, message({ t: 'misses.changed', data: { unresolved: 1 } }))
    reduce(state, { type: 'memory.threadDeleted', id: 'th' })
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
  assert.deepEqual(touched, [])
})

test('the route parser gives memory its view and thread, and a note route its #L line', () => {
  assert.deepEqual(matchRoute('/memory'), { name: 'memory', params: { view: 'graph', thread: null } })
  assert.deepEqual(matchRoute('/memory?view=browse&thread=new'), { name: 'memory', params: { view: 'browse', thread: 'new' } })
  assert.deepEqual(matchRoute('/memory?view=misses&thread=th1'), { name: 'memory', params: { view: 'misses', thread: 'th1' } })
  assert.deepEqual(matchRoute('/memory?view=nope'), { name: 'memory', params: { view: 'graph', thread: null } })
  assert.deepEqual(memoryQuery('?view=captures'), { view: 'captures', thread: null })
  assert.deepEqual(matchRoute('/memory/note/02-wiki/nestjs/bullmq-worker.md#L13'), { name: 'memoryNote', params: { path: '02-wiki/nestjs/bullmq-worker.md', line: 13 } })
  assert.deepEqual(matchRoute('/memory/note/02-wiki/a%23b.md'), { name: 'memoryNote', params: { path: '02-wiki/a#b.md' } })
  assert.deepEqual(matchRoute('/memory/note/02-wiki/a.md#Lx'), { name: 'memoryNote', params: { path: '02-wiki/a.md' } })
  assert.equal(noteLine('#L7'), 7)
  assert.equal(noteLine('L0'), null)
})

test('Citation links to the note line, reads path:line and via graph, and shows hidden characters as tokens', async () => {
  const { Citation } = await load('components/Citation.jsx')
  const { NoteChip, noteHref } = await load('components/NoteChip.jsx')
  const source = render(Citation, { path: '02-wiki/nestjs/auth-guard.md', line: 11, viaGraph: true })
  assert.match(source, /<a class="citation citation--source" href="\/memory\/note\/02-wiki\/nestjs\/auth-guard\.md#L11">/)
  assert.match(source, /<bdi>02-wiki\/nestjs\/auth-guard\.md<\/bdi>:11/)
  assert.match(source, /<span aria-hidden="true"> · <\/span>via graph/)
  assert.doesNotMatch(render(Citation, { path: '02-wiki/a.md', line: 3 }), /via graph/)

  const evil = '02-wiki/a‮gnp.md'
  const tricked = render(Citation, { path: evil, line: 2, variant: 'callout', title: 'Fila ‮abc', snippet: 'linha‮ um' })
  assert.doesNotMatch(tricked, /‮/, 'no raw U+202E in the markup')
  assert.match(tricked, /<bdi>02-wiki\/a&lt;U\+202E&gt;gnp\.md<\/bdi>:2/)
  assert.match(tricked, /<bdi class="citation-title" lang="pt-BR">Fila &lt;U\+202E&gt;abc<\/bdi>/)
  assert.match(tricked, /<span class="citation-snippet" lang="pt-BR" dir="auto">linha&lt;U\+202E&gt; um<\/span>/)
  assert.match(tricked, /href="\/memory\/note\/02-wiki\/a%E2%80%AEgnp\.md#L2"/)

  assert.equal(noteHref('02-wiki/a#b.md', 4), '/memory/note/02-wiki/a%23b.md#L4')
  const chip = render(NoteChip, { path: '02-wiki/docker/compose-healthcheck.md', title: 'compose ‮healthcheck', variant: 'learned' })
  assert.match(chip, /<a class="note-chip note-chip--learned" href="\/memory\/note\/02-wiki\/docker\/compose-healthcheck\.md">/)
  assert.match(chip, /data-domain="docker"/)
  assert.doesNotMatch(chip, /‮/)
  assert.match(render(NoteChip, { path: '03-projects/fila.md' }), /<bdi class="note-chip-title" lang="pt-BR">fila<\/bdi>/)
})

test('main.jsx imports the four memory stylesheets once, after meeting-live.css, and the components import no CSS', async () => {
  const main = await readFile(path.join(hub, 'web/src/main.jsx'), 'utf8')
  const imports = [...main.matchAll(/^import '\.\/styles\/([\w-]+\.css)'$/gm)].map(match => match[1])
  const at = imports.indexOf('meeting-live.css')
  assert.deepEqual(imports.slice(at, at + 5), ['meeting-live.css', 'memory.css', 'memory-graph.css', 'memory-ask.css', 'memory-lists.css'])
  for (const name of ['memory.css', 'memory-graph.css', 'memory-ask.css', 'memory-lists.css']) assert.equal(imports.filter(item => item === name).length, 1, name)
  for (const name of ['Citation.jsx', 'NoteChip.jsx']) {
    const code = await readFile(path.join(hub, 'web/src/components', name), 'utf8')
    assert.doesNotMatch(code, /import\s+['"][^'"]+\.css['"]/, `${name} imports no CSS`)
  }
})
