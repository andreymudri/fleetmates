// The deck's own memory facts in SQLite (06-storage 4.10, migration 0006): ask threads and their
// messages, the misses log (D-130, D-140), captures (D-137), note reads seen in hooks (D-138) and
// observed vault_learn calls (D-137). Question, answer and note text stay in these tables and never
// go into the events table; this module appends no events. M5 stores only scope 'vault' threads
// (D-144). Nothing here touches the vault.
import { randomBytes } from 'node:crypto'
import { apiError } from '../http/router.mjs'

/**
 * @typedef {{ run: Function, get: Function, all: Function, tx: Function }} Store
 * @typedef {{ path: string, line: number, viaGraph: boolean }} Citation
 * @typedef {{ id: string, title: string, scope: string, createdAt: number, updatedAt: number }} AskThread
 * @typedef {{ id: string, threadId: string, role: 'user'|'assistant', text: string, citations: Citation[], generalKnowledge: string|null, isMiss: boolean, status: 'complete'|'cancelled'|'error', error: string|null, unverified: boolean, droppedCitations: number, createdAt: number }} AskMessage
 * @typedef {{ id: string, question: string, threadId: string|null, searchedTerms: string[], createdAt: number, resolvedBy: string|null }} Miss
 * @typedef {{ path: string, day: string, capturedAt: number, via: 'vault_learn'|'frontmatter', sessionId: string|null, repoId: string|null, repoName: string|null, opened: boolean, openedAt: number|null }} CaptureRow
 * @typedef {{ id: number, sessionId: string|null, repoId: string|null, slug: string, at: number }} LearnCall
 */

/** A thread's title keeps this many characters of its first question. */
export const THREAD_TITLE_MAX = 120
/** The thread context of a follow-up keeps at most this many characters of messages (10-memory 2.4). */
export const CONTEXT_MAX_CHARS = 8000
/** The thread context of a follow-up holds at most this many messages (10-memory 2.4). */
export const CONTEXT_MAX_MESSAGES = 6
/** The heading the thread context sits under (10-memory 2.4). */
export const CONTEXT_HEADING = 'Earlier in this thread'

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BLOCK_START = /^```deck-answer\b/m

function ulid (now = Date.now()) {
  let time = BigInt(now)
  let head = ''
  for (let i = 0; i < 10; i++) { head = ULID_ALPHABET[Number(time & 31n)] + head; time >>= 5n }
  let random = BigInt(`0x${randomBytes(10).toString('hex')}`)
  let tail = ''
  for (let i = 0; i < 16; i++) { tail = ULID_ALPHABET[Number(random & 31n)] + tail; random >>= 5n }
  return head + tail
}

/** @param {any} row @returns {AskThread} */
const threadView = row => ({ id: row.id, title: row.title, scope: row.scope, createdAt: row.created_at, updatedAt: row.updated_at })

/** @param {any} row @returns {AskMessage} */
const messageView = row => ({
  id: row.id,
  threadId: row.thread_id,
  role: row.role,
  text: row.text,
  citations: JSON.parse(row.citations),
  generalKnowledge: row.general_knowledge ?? null,
  isMiss: row.is_miss === 1,
  status: row.status,
  error: row.error ?? null,
  unverified: row.unverified === 1,
  droppedCitations: row.dropped_citations,
  createdAt: row.created_at
})

/** @param {any} row @returns {Miss} */
const missView = row => ({
  id: row.id,
  question: row.question,
  threadId: row.thread_id ?? null,
  searchedTerms: JSON.parse(row.searched_terms),
  createdAt: row.created_at,
  resolvedBy: row.resolved_by ?? null
})

/** @param {any} row @returns {CaptureRow} */
const captureView = row => ({
  ...(row.research_id ? { researchId: row.research_id } : {}),
  path: row.path,
  day: row.day,
  capturedAt: row.captured_at,
  via: row.via,
  sessionId: row.session_id ?? null,
  repoId: row.repo_id ?? null,
  repoName: row.repo_name ?? null,
  opened: row.opened_at !== null && row.opened_at !== undefined,
  openedAt: row.opened_at ?? null
})

/**
 * Create a vault-scope thread whose title is `title` (the first question) cut to 120 characters.
 * @param {Store} store
 * @param {{ title: string, at: number }} fields
 * @returns {AskThread}
 */
export function createThread (store, { title, at }) {
  const id = ulid(at)
  const cut = [...String(title)].slice(0, THREAD_TITLE_MAX).join('')
  store.run("INSERT INTO ask_threads(id, title, scope, created_at, updated_at) VALUES(?, ?, 'vault', ?, ?)", id, cut, at, at)
  return threadView(store.get('SELECT * FROM ask_threads WHERE id = ?', id))
}

/**
 * Append a message to a thread and move the thread's `updated_at` to `at`. An assistant message is
 * appended with empty text when its ask starts, so its id exists while it streams, and
 * `finishMessage` fills it in. Throws when the thread does not exist (foreign key).
 * @param {Store} store
 * @param {{ threadId: string, role: 'user'|'assistant', text: string, at: number, id?: string }} fields
 * @returns {AskMessage}
 */
export function appendMessage (store, { threadId, role, text, at, id = ulid(at) }) {
  return store.tx(() => {
    store.run('INSERT INTO ask_messages(id, thread_id, role, text, created_at) VALUES(?, ?, ?, ?, ?)', id, threadId, role, text, at)
    store.run('UPDATE ask_threads SET updated_at = max(updated_at, ?) WHERE id = ?', at, threadId)
    return messageView(store.get('SELECT * FROM ask_messages WHERE id = ?', id))
  })
}

/**
 * Store the outcome of an ask on its assistant message. Returns null for an unknown id.
 * @param {Store} store
 * @param {string} id
 * @param {{ text: string, citations?: Citation[], generalKnowledge?: string|null, isMiss?: boolean, status: 'complete'|'cancelled'|'error', error?: string|null, unverified?: boolean, droppedCitations?: number, searches?: { query: string, resultCount: number|null }[], durationMs?: number|null }} fields
 * @returns {AskMessage|null}
 */
export function finishMessage (store, id, { text, citations = [], generalKnowledge = null, isMiss = false, status, error = null, unverified = false, droppedCitations = 0, searches = [], durationMs = null }) {
  store.run(
    'UPDATE ask_messages SET text = ?, citations = ?, general_knowledge = ?, is_miss = ?, status = ?, error = ?, unverified = ?, dropped_citations = ?, searches = ?, duration_ms = ? WHERE id = ?',
    text, JSON.stringify(citations), generalKnowledge, isMiss ? 1 : 0, status, error, unverified ? 1 : 0, droppedCitations, JSON.stringify(searches), durationMs, id
  )
  const row = store.get('SELECT * FROM ask_messages WHERE id = ?', id)
  return row ? messageView(row) : null
}

/**
 * A thread and its messages, oldest first, or null for an unknown id.
 * @param {Store} store
 * @param {string} id
 * @returns {{ thread: AskThread, messages: AskMessage[] }|null}
 */
export function getThread (store, id) {
  const row = store.get('SELECT * FROM ask_threads WHERE id = ?', id)
  if (!row) return null
  const messages = store.all('SELECT * FROM ask_messages WHERE thread_id = ? ORDER BY created_at, rowid', id).map(messageView)
  return { thread: threadView(row), messages }
}

/**
 * Vault-scope threads, most recently updated first.
 * @param {Store} store
 * @param {{ limit?: number }} [options]
 * @returns {AskThread[]}
 */
export function listThreads (store, { limit = 30 } = {}) {
  return store.all("SELECT * FROM ask_threads WHERE scope = 'vault' ORDER BY updated_at DESC, id DESC LIMIT ?", limit).map(threadView)
}

/**
 * Delete a thread and, by cascade, its messages. Its misses keep their question with a null thread.
 * @param {Store} store
 * @param {string} id
 * @returns {boolean} whether a thread was deleted
 */
export function deleteThread (store, id) {
  return Number(store.run('DELETE FROM ask_threads WHERE id = ?', id).changes) > 0
}

/** @param {string} text */
function withoutBlock (text) {
  const match = BLOCK_START.exec(text)
  return (match ? text.slice(0, match.index) : text).trim()
}

/**
 * The context a follow-up carries in its prompt (10-memory 2.4): the last 6 messages of the thread
 * with non-empty text, newest last, each assistant message without its `deck-answer` block and
 * anything after it, under the heading "Earlier in this thread". The messages are capped at 8,000
 * characters together by dropping the oldest first. An empty string when nothing is left.
 * @param {Store} store
 * @param {string} threadId
 * @returns {string}
 */
export function threadContext (store, threadId) {
  const rows = store.all('SELECT role, text FROM ask_messages WHERE thread_id = ? ORDER BY created_at, rowid', threadId)
  const entries = rows
    .map(row => ({ role: row.role, text: row.role === 'assistant' ? withoutBlock(row.text) : row.text.trim() }))
    .filter(entry => entry.text)
    .slice(-CONTEXT_MAX_MESSAGES)
    .map(entry => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
  while (entries.length && entries.join('\n\n').length > CONTEXT_MAX_CHARS) entries.shift()
  return entries.length ? `${CONTEXT_HEADING}\n${entries.join('\n\n')}` : ''
}

/**
 * Record a question the vault could not answer (D-130).
 * @param {Store} store
 * @param {{ question: string, threadId: string|null, searchedTerms: string[], at: number }} fields
 * @returns {Miss}
 */
export function insertMiss (store, { question, threadId, searchedTerms, at }) {
  const id = ulid(at)
  store.run('INSERT INTO misses(id, question, thread_id, searched_terms, created_at) VALUES(?, ?, ?, ?, ?)', id, question, threadId ?? null, JSON.stringify(searchedTerms ?? []), at)
  return missView(store.get('SELECT * FROM misses WHERE id = ?', id))
}

/**
 * Misses, newest first.
 * @param {Store} store
 * @param {{ limit?: number, unresolvedOnly?: boolean }} [options]
 * @returns {Miss[]}
 */
export function listMisses (store, { limit = 200, unresolvedOnly = false } = {}) {
  const where = unresolvedOnly ? 'WHERE resolved_by IS NULL' : ''
  return store.all(`SELECT * FROM misses ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, limit).map(missView)
}

/** @param {string} value */
function validNotePath (value) {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || !value.endsWith('.md')) return false
  return value.split('/').every(segment => segment && segment !== '.' && segment !== '..')
}

/**
 * Triage a miss (D-140): `dismissed`, or `note:<vault-relative .md path>` ("The vault has this").
 * `research:<id>` is M6's and refused here, as is any path that is absolute, holds `..`, `.`, an
 * empty segment, a backslash or NUL, or does not end in `.md`; a refusal throws an API error
 * `validation_failed` (422). Returns null for an unknown id.
 * @param {Store} store
 * @param {string} id
 * @param {string} resolvedBy
 * @returns {Miss|null}
 */
export function resolveMiss (store, id, resolvedBy) {
  const ok = resolvedBy === 'dismissed' || (typeof resolvedBy === 'string' && resolvedBy.startsWith('note:') && validNotePath(resolvedBy.slice(5)))
  if (!ok) throw apiError(422, 'validation_failed', { field: 'resolvedBy' })
  store.run('UPDATE misses SET resolved_by = ? WHERE id = ?', resolvedBy, id)
  const row = store.get('SELECT * FROM misses WHERE id = ?', id)
  return row ? missView(row) : null
}

/**
 * The number of misses not yet resolved.
 * @param {Store} store
 * @returns {number}
 */
export function unresolvedCount (store) {
  return store.get('SELECT count(*) AS n FROM misses WHERE resolved_by IS NULL').n
}

/**
 * Record a note read seen in a hook (D-138).
 * @param {Store} store
 * @param {{ sessionId: string, path: string, tool?: string, at: number }} fields
 */
export function recordNoteRead (store, { sessionId, path, tool = 'vault_get_note', at }) {
  store.run('INSERT INTO note_reads(session_id, path, tool, at) VALUES(?, ?, ?, ?)', sessionId, path, tool, at)
}

/**
 * Record a vault_learn call seen in a hook (D-137), by the slug of its `titulo`.
 * @param {Store} store
 * @param {{ sessionId: string|null, repoId: string|null, slug: string, at: number }} fields
 * @returns {number} the row id
 */
export function recordLearnCall (store, { sessionId, repoId, slug, at }) {
  return Number(store.run('INSERT INTO vault_learn_calls(session_id, repo_id, slug, at) VALUES(?, ?, ?, ?)', sessionId ?? null, repoId ?? null, slug, at).lastInsertRowid)
}

/**
 * Observed vault_learn calls at or after `at`, oldest first.
 * @param {Store} store
 * @param {number} at
 * @returns {LearnCall[]}
 */
export function learnCallsSince (store, at) {
  return store.all('SELECT id, session_id, repo_id, slug, at FROM vault_learn_calls WHERE at >= ? ORDER BY at, id', at)
    .map(row => ({ id: row.id, sessionId: row.session_id ?? null, repoId: row.repo_id ?? null, slug: row.slug, at: row.at }))
}

/**
 * Insert a capture, unique per `(path, day)`. On a conflict, a `vault_learn` capture upgrades a
 * `frontmatter` row's via, session and repo; nothing else changes an existing row, so a
 * `vault_learn` row is never downgraded.
 * @param {Store} store
 * @param {{ path: string, day: string, capturedAt: number, via: 'vault_learn'|'frontmatter', sessionId: string|null, repoId: string|null }} fields
 * @returns {CaptureRow}
 */
export function upsertCapture (store, { path, day, capturedAt, via, sessionId, repoId }) {
  store.run(
    `INSERT INTO captures(path, day, captured_at, via, session_id, repo_id) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, day) DO UPDATE SET via = excluded.via, session_id = excluded.session_id, repo_id = excluded.repo_id
     WHERE captures.via = 'frontmatter' AND excluded.via = 'vault_learn'`,
    path, day, capturedAt, via, sessionId ?? null, repoId ?? null
  )
  return captureView(store.get('SELECT c.*, r.name AS repo_name FROM captures c LEFT JOIN repos r ON r.id = c.repo_id WHERE c.path = ? AND c.day = ?', path, day))
}

/**
 * The captures of one local day, newest first, with the repo name when the repo is known.
 * @param {Store} store
 * @param {string} day local `YYYY-MM-DD`
 * @returns {CaptureRow[]}
 */
export function capturesOn (store, day) {
  return store.all('SELECT c.*, r.name AS repo_name FROM captures c LEFT JOIN repos r ON r.id = c.repo_id WHERE c.day = ? ORDER BY c.captured_at DESC, c.id DESC', day).map(captureView)
}

/**
 * Mark a capture opened in the deck, once. Returns whether a row changed.
 * @param {Store} store
 * @param {string} path
 * @param {string} day
 * @param {number} at
 * @returns {boolean}
 */
export function markOpened (store, path, day, at) {
  return Number(store.run('UPDATE captures SET opened_at = ? WHERE path = ? AND day = ? AND opened_at IS NULL', at, path, day).changes) > 0
}

/**
 * Where a note was used since `since`: the threads whose assistant messages cite it (one entry per
 * thread, at its latest citing message, newest first, read with `json_each` over
 * `ask_messages.citations`) and the hook-observed reads, newest first, with the repo name.
 * @param {Store} store
 * @param {string} path
 * @param {{ since?: number }} [options]
 * @returns {{ citedIn: { threadId: string, title: string, at: number }[], readBy: { sessionId: string, repoId: string|null, repoName: string|null, at: number, tool: string }[] }}
 */
export function noteUsage (store, path, { since = 0 } = {}) {
  const citedIn = store.all(
    `SELECT t.id AS thread_id, t.title, max(m.created_at) AS at
       FROM ask_messages m
       JOIN ask_threads t ON t.id = m.thread_id
       JOIN json_each(m.citations) c
      WHERE m.created_at >= ? AND json_extract(c.value, '$.path') = ?
      GROUP BY t.id
      ORDER BY at DESC, t.id DESC`,
    since, path
  ).map(row => ({ threadId: row.thread_id, title: row.title, at: row.at }))
  const readBy = store.all(
    `SELECT n.session_id, s.repo_id, r.name AS repo_name, n.at, n.tool
       FROM note_reads n
       LEFT JOIN sessions s ON s.id = n.session_id
       LEFT JOIN repos r ON r.id = s.repo_id
      WHERE n.path = ? AND n.at >= ?
      ORDER BY n.at DESC`,
    path, since
  ).map(row => ({ sessionId: row.session_id, repoId: row.repo_id ?? null, repoName: row.repo_name ?? null, at: row.at, tool: row.tool }))
  return { citedIn, readBy }
}

/**
 * A session's memory since `since` (05-api `GET /api/sessions/:id/memory`): the notes it read, one
 * entry per path at its latest read, newest first, and the notes it learned (its `vault_learn`
 * captures), newest first. The service adds titles; this store does not know them.
 * @param {Store} store
 * @param {string} sessionId
 * @param {{ since?: number }} [options]
 * @returns {{ read: { path: string, at: number }[], learned: { path: string, at: number }[] }}
 */
export function sessionMemory (store, sessionId, { since = 0 } = {}) {
  const read = store.all('SELECT path, max(at) AS at FROM note_reads WHERE session_id = ? AND at >= ? GROUP BY path ORDER BY at DESC, path', sessionId, since)
    .map(row => ({ path: row.path, at: row.at }))
  const learned = store.all("SELECT path, captured_at FROM captures WHERE session_id = ? AND via = 'vault_learn' AND captured_at >= ? ORDER BY captured_at DESC, id DESC", sessionId, since)
    .map(row => ({ path: row.path, at: row.captured_at }))
  return { read, learned }
}

/**
 * The number of vault_learn calls observed for a session at or after `since` (the session view's
 * `learnedToday` when `since` is local midnight).
 * @param {Store} store
 * @param {string} sessionId
 * @param {number} since
 * @returns {number}
 */
export function learnedToday (store, sessionId, since) {
  return store.get('SELECT count(*) AS n FROM vault_learn_calls WHERE session_id = ? AND at >= ?', sessionId, since).n
}
