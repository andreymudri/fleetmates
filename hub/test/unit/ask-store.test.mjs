import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openDeckDb } from '../../server/db/index.mjs'
import {
  appendMessage, capturesOn, createThread, deleteThread, finishMessage, getThread, insertMiss, learnCallsSince,
  learnedToday, listMisses, listThreads, markOpened, noteUsage, recordLearnCall, recordNoteRead, resolveMiss,
  sessionMemory, threadContext, unresolvedCount, upsertCapture, THREAD_TITLE_MAX, CONTEXT_MAX_CHARS
} from '../../server/ask/store.mjs'

async function withStore(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-ask-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  try { await fn(store) } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
}

function seedSession(store, { sessionId = 's1', repoId = '/home/you/work/api', repoName = 'api', slot = 0 } = {}) {
  if (!store.get('SELECT 1 AS x FROM repos WHERE id = ?', repoId)) store.run('INSERT INTO repos(id,name,crew_slot,crew_seed,first_seen_at) VALUES(?,?,?,?,1)', repoId, repoName, slot, repoName)
  store.run("INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES(?, 'wrapped', ?, ?, 'running', 1, 1, 1, 1, 1)", sessionId, repoId, repoId)
}

const BLOCK = '\n```deck-answer\n{"citations":[{"path":"02-wiki/nestjs/bullmq-worker.md","line":13,"viaGraph":false}],"isMiss":false}\n```\n'

test('createThread stores a vault thread titled by the first question cut to 120 characters, and lists newest first', async () => withStore(store => {
  const long = 'Como o worker do BullMQ reprocessa jobs que falharam '.repeat(5)
  const first = createThread(store, { title: long, at: 10 })
  assert.equal(first.scope, 'vault')
  assert.equal(first.title.length, THREAD_TITLE_MAX)
  assert.equal(THREAD_TITLE_MAX, 120)
  assert.equal(first.title, long.slice(0, 120))
  assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'id', 'scope', 'title', 'updatedAt'])
  const second = createThread(store, { title: 'Guards no NestJS', at: 20 })
  appendMessage(store, { threadId: first.id, role: 'user', text: 'mais um', at: 30 })
  assert.deepEqual(listThreads(store, { limit: 30 }).map(thread => thread.id), [first.id, second.id])
  assert.deepEqual(listThreads(store, { limit: 1 }).map(thread => thread.id), [first.id])
  store.run("INSERT INTO meetings(id, tag, confidential, state, updated_at) VALUES('m1', 'acme', 0, 'recorded', 1)")
  store.run("INSERT INTO ask_threads(id, title, scope, created_at, updated_at) VALUES('mt', 'q', 'meeting:m1', 99, 99)")
  assert.ok(!listThreads(store, {}).some(thread => thread.id === 'mt'), 'meeting threads are not listed')
}))

test('appendMessage and finishMessage store an answer that getThread returns in the AskMessage shape', async () => withStore(store => {
  const thread = createThread(store, { title: 'q', at: 1 })
  const user = appendMessage(store, { threadId: thread.id, role: 'user', text: 'Como funciona o guard?', at: 2 })
  const assistant = appendMessage(store, { threadId: thread.id, role: 'assistant', text: '', at: 3 })
  finishMessage(store, assistant.id, {
    text: 'O guard valida o token.', citations: [{ path: '02-wiki/nestjs/auth-guard.md', line: 11, viaGraph: true }],
    generalKnowledge: null, isMiss: false, status: 'complete', error: null, unverified: false, droppedCitations: 1,
    searches: [{ query: 'guard', resultCount: 2 }], durationMs: 1234
  })
  const { thread: stored, messages } = getThread(store, thread.id)
  assert.equal(stored.id, thread.id)
  assert.equal(stored.updatedAt, 3)
  assert.deepEqual(messages.map(message => message.id), [user.id, assistant.id])
  assert.deepEqual(messages[1], {
    id: assistant.id, threadId: thread.id, role: 'assistant', text: 'O guard valida o token.',
    citations: [{ path: '02-wiki/nestjs/auth-guard.md', line: 11, viaGraph: true }], generalKnowledge: null,
    isMiss: false, status: 'complete', error: null, unverified: false, droppedCitations: 1, createdAt: 3
  })
  const row = store.get('SELECT searches, duration_ms FROM ask_messages WHERE id = ?', assistant.id)
  assert.deepEqual(JSON.parse(row.searches), [{ query: 'guard', resultCount: 2 }])
  assert.equal(row.duration_ms, 1234)
  assert.equal(getThread(store, 'nope'), null)
}))

test('deleteThread removes the thread and its messages and keeps its misses with the question', async () => withStore(store => {
  const thread = createThread(store, { title: 'q', at: 1 })
  appendMessage(store, { threadId: thread.id, role: 'user', text: 'q', at: 2 })
  const miss = insertMiss(store, { question: 'Onde fica a fila?', threadId: thread.id, searchedTerms: ['fila'], at: 3 })
  assert.equal(deleteThread(store, thread.id), true)
  assert.equal(deleteThread(store, thread.id), false)
  assert.equal(getThread(store, thread.id), null)
  assert.equal(store.get('SELECT count(*) AS n FROM ask_messages').n, 0)
  assert.deepEqual(listMisses(store).map(row => [row.id, row.question, row.threadId]), [[miss.id, 'Onde fica a fila?', null]])
}))

test('threadContext keeps the last 6 messages newest last under the heading, and strips assistant blocks', async () => withStore(store => {
  const thread = createThread(store, { title: 'q', at: 1 })
  assert.equal(threadContext(store, thread.id), '')
  for (let i = 1; i <= 8; i++) {
    const role = i % 2 ? 'user' : 'assistant'
    appendMessage(store, { threadId: thread.id, role, text: role === 'assistant' ? `answer ${i}${BLOCK}tail after block ${i}` : `question ${i}`, at: 10 + i })
  }
  const context = threadContext(store, thread.id)
  assert.ok(context.startsWith('Earlier in this thread'), context)
  for (const n of [1, 2]) assert.ok(!context.includes(`question ${n}`) && !context.includes(`answer ${n}`), `message ${n} is outside the last 6`)
  const order = [3, 4, 5, 6, 7, 8].map(n => context.indexOf(n % 2 ? `question ${n}` : `answer ${n}`))
  assert.ok(order.every(index => index >= 0), context)
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'oldest first, newest last')
  assert.ok(!context.includes('deck-answer'), 'no deck-answer fence')
  assert.ok(!context.includes('"citations"'), 'no block JSON')
  assert.ok(!context.includes('tail after block'), 'nothing after the block')
}))

test('threadContext caps the messages at 8,000 characters by dropping the oldest first', async () => withStore(store => {
  const thread = createThread(store, { title: 'q', at: 1 })
  assert.equal(CONTEXT_MAX_CHARS, 8000)
  appendMessage(store, { threadId: thread.id, role: 'user', text: 'OLDEST ' + 'a'.repeat(3000), at: 2 })
  appendMessage(store, { threadId: thread.id, role: 'assistant', text: 'MIDDLE ' + 'b'.repeat(3000), at: 3 })
  appendMessage(store, { threadId: thread.id, role: 'user', text: 'NEWEST ' + 'c'.repeat(3000), at: 4 })
  const context = threadContext(store, thread.id)
  assert.ok(!context.includes('OLDEST'), 'the oldest is dropped')
  assert.ok(context.includes('MIDDLE'), 'the middle one fits')
  assert.ok(context.includes('NEWEST'), 'the newest is kept')
  const body = context.slice(context.indexOf('\n') + 1)
  assert.ok(body.length <= CONTEXT_MAX_CHARS, `body is ${body.length} characters`)
}))

test('misses: insert, list newest first, count unresolved and resolve as dismissed or a vault note', async () => withStore(store => {
  const a = insertMiss(store, { question: 'Fila de jobs?', threadId: null, searchedTerms: ['fila', 'jobs'], at: 1 })
  const b = insertMiss(store, { question: 'Container de build?', threadId: null, searchedTerms: [], at: 2 })
  assert.deepEqual(a, { id: a.id, question: 'Fila de jobs?', threadId: null, searchedTerms: ['fila', 'jobs'], createdAt: 1, resolvedBy: null })
  assert.deepEqual(listMisses(store).map(miss => miss.id), [b.id, a.id])
  assert.equal(unresolvedCount(store), 2)
  assert.equal(resolveMiss(store, a.id, 'dismissed').resolvedBy, 'dismissed')
  assert.equal(resolveMiss(store, b.id, 'note:02-wiki/docker/build-cache.md').resolvedBy, 'note:02-wiki/docker/build-cache.md')
  assert.equal(unresolvedCount(store), 0)
  assert.equal(resolveMiss(store, 'nope', 'dismissed'), null)
}))

test('resolveMiss refuses research:, a path with .., an absolute path and a non-.md path', async () => withStore(store => {
  const miss = insertMiss(store, { question: 'q', threadId: null, searchedTerms: [], at: 1 })
  for (const value of ['research:x', 'note:../secret.md', 'note:02-wiki/../../etc/passwd.md', 'note:/home/you/vault/a.md', 'note:02-wiki/a.txt', 'note:', 'other', 'note:02-wiki/a\0.md']) {
    assert.throws(() => resolveMiss(store, miss.id, value), error => error.code === 'validation_failed', value)
  }
  assert.equal(listMisses(store)[0].resolvedBy, null)
}))

test('note reads, learn calls, learnedToday and sessionMemory read back per session since a time', async () => withStore(store => {
  seedSession(store)
  seedSession(store, { sessionId: 's2', repoId: '/home/you/work/web', repoName: 'web', slot: 1 })
  recordNoteRead(store, { sessionId: 's1', path: '02-wiki/nestjs/auth-guard.md', tool: 'vault_get_note', at: 5 })
  recordNoteRead(store, { sessionId: 's1', path: '02-wiki/nestjs/auth-guard.md', tool: 'vault_get_note', at: 50 })
  recordNoteRead(store, { sessionId: 's1', path: '02-wiki/nestjs/bullmq-worker.md', tool: 'vault_get_note', at: 40 })
  recordNoteRead(store, { sessionId: 's2', path: '02-wiki/docker/build-cache.md', tool: 'vault_get_note', at: 45 })
  recordLearnCall(store, { sessionId: 's1', repoId: '/home/you/work/api', slug: 'fila-com-retry', at: 5 })
  recordLearnCall(store, { sessionId: 's1', repoId: '/home/you/work/api', slug: 'guard-por-rota', at: 30 })
  recordLearnCall(store, { sessionId: 's2', repoId: '/home/you/work/web', slug: 'cache-de-build', at: 35 })
  assert.deepEqual(learnCallsSince(store, 10), [
    { id: 2, sessionId: 's1', repoId: '/home/you/work/api', slug: 'guard-por-rota', at: 30 },
    { id: 3, sessionId: 's2', repoId: '/home/you/work/web', slug: 'cache-de-build', at: 35 }
  ])
  assert.equal(learnedToday(store, 's1', 10), 1)
  assert.equal(learnedToday(store, 's1', 0), 2)
  upsertCapture(store, { path: '02-wiki/nestjs/guard-por-rota.md', day: '2026-10-04', capturedAt: 31, via: 'vault_learn', sessionId: 's1', repoId: '/home/you/work/api' })
  upsertCapture(store, { path: '02-wiki/nestjs/frontmatter-only.md', day: '2026-10-04', capturedAt: 32, via: 'frontmatter', sessionId: null, repoId: null })
  assert.deepEqual(sessionMemory(store, 's1', { since: 10 }), {
    read: [{ path: '02-wiki/nestjs/auth-guard.md', at: 50 }, { path: '02-wiki/nestjs/bullmq-worker.md', at: 40 }],
    learned: [{ path: '02-wiki/nestjs/guard-por-rota.md', at: 31 }]
  })
}))

test('upsertCapture is unique per path and day, upgrades a frontmatter row to vault_learn and never the reverse', async () => withStore(store => {
  seedSession(store)
  const day = '2026-10-04'
  upsertCapture(store, { path: '02-wiki/a.md', day, capturedAt: 10, via: 'frontmatter', sessionId: null, repoId: null })
  upsertCapture(store, { path: '02-wiki/a.md', day, capturedAt: 11, via: 'vault_learn', sessionId: 's1', repoId: '/home/you/work/api' })
  upsertCapture(store, { path: '02-wiki/b.md', day, capturedAt: 20, via: 'vault_learn', sessionId: 's1', repoId: '/home/you/work/api' })
  upsertCapture(store, { path: '02-wiki/b.md', day, capturedAt: 21, via: 'frontmatter', sessionId: null, repoId: null })
  upsertCapture(store, { path: '02-wiki/b.md', day: '2026-10-05', capturedAt: 30, via: 'frontmatter', sessionId: null, repoId: null })
  const captures = capturesOn(store, day)
  assert.deepEqual(captures.map(row => [row.path, row.via, row.sessionId, row.repoId, row.repoName]), [
    ['02-wiki/b.md', 'vault_learn', 's1', '/home/you/work/api', 'api'],
    ['02-wiki/a.md', 'vault_learn', 's1', '/home/you/work/api', 'api']
  ])
  assert.equal(store.get('SELECT count(*) AS n FROM captures').n, 3)
  assert.ok(captures.every(row => row.opened === false))
}))

test('markOpened sets opened once per path and day', async () => withStore(store => {
  upsertCapture(store, { path: '02-wiki/a.md', day: '2026-10-04', capturedAt: 10, via: 'frontmatter', sessionId: null, repoId: null })
  assert.equal(markOpened(store, '02-wiki/a.md', '2026-10-04', 100), true)
  assert.equal(markOpened(store, '02-wiki/a.md', '2026-10-04', 200), false)
  assert.equal(markOpened(store, '02-wiki/missing.md', '2026-10-04', 200), false)
  assert.equal(store.get('SELECT opened_at FROM captures').opened_at, 100)
  assert.equal(capturesOn(store, '2026-10-04')[0].opened, true)
}))

test('noteUsage counts a thread once even when it cites the note twice, and lists reads with the repo name', async () => withStore(store => {
  seedSession(store)
  const target = '02-wiki/nestjs/auth-guard.md'
  const cites = (threadId, at, paths) => {
    const message = appendMessage(store, { threadId, role: 'assistant', text: '', at })
    finishMessage(store, message.id, { text: 'a', citations: paths.map(p => ({ path: p, line: 1, viaGraph: false })), generalKnowledge: null, isMiss: false, status: 'complete', error: null, unverified: false, droppedCitations: 0, searches: [], durationMs: 1 })
  }
  const one = createThread(store, { title: 'Primeira', at: 1 })
  const two = createThread(store, { title: 'Segunda', at: 2 })
  const old = createThread(store, { title: 'Antiga', at: 0 })
  cites(one.id, 10, [target, target])
  cites(one.id, 12, [target])
  cites(two.id, 11, ['02-wiki/other.md', target])
  cites(old.id, 1, [target])
  recordNoteRead(store, { sessionId: 's1', path: target, tool: 'vault_get_note', at: 20 })
  recordNoteRead(store, { sessionId: 's1', path: '02-wiki/other.md', tool: 'vault_get_note', at: 21 })
  const usage = noteUsage(store, target, { since: 5 })
  assert.deepEqual(usage.citedIn, [
    { threadId: one.id, title: 'Primeira', at: 12 },
    { threadId: two.id, title: 'Segunda', at: 11 }
  ])
  assert.deepEqual(usage.readBy, [{ sessionId: 's1', repoId: '/home/you/work/api', repoName: 'api', at: 20, tool: 'vault_get_note' }])
}))
