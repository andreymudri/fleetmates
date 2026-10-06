import { apiError } from '../http/router.mjs'
import { appendMessage, createThread, finishMessage, getThread, insertMiss, threadContext, unresolvedCount } from './store.mjs'
import { parseAnswer, validateCitations } from './answer.mjs'

/**
 * Persist vault asks and publish their answers only as ephemeral events.
 * @param {{ store: object, engine: object, vault: object, health: Function, publish: Function,
 *   now?: Function, prefs: Function, log?: Function }} options
 * @returns {object} ask, cancel, close, isAsking and reapOrphans
 */
export function createAskService ({ store, engine, vault, health, publish, now = Date.now, prefs, log = () => {} }) {
  const running = new Map()
  // Store helpers are independently atomic. Inside our larger transaction they share its boundary.
  const inTransaction = { ...store, tx: fn => fn() }
  const emit = (type, data) => publish({ type, at: now(), data: { ...data, scope: 'vault', ephemeral: true } })
  const busy = threadId => [...running.values()].some(entry => entry.threadId === threadId)
  let closed = false

  async function finish (entry, result) {
    const { messageId, threadId, question } = entry
    try {
      let fields
      if (result.status === 'error') {
        fields = { text: '', status: 'error', error: result.error ?? 'ask failed', durationMs: result.durationMs ?? 0 }
      } else {
        const parsed = parseAnswer(result.text ?? '')
        const validated = await validateCitations(parsed.block?.citations ?? [], {
          toolPaths: result.toolPaths ?? [], knownPaths: vault.knownPaths(), searchHits: result.searchHits ?? [],
          lineBound: path => vault.lineBound(path)
        })
        fields = {
          text: parsed.text, status: result.status, citations: validated.kept,
          droppedCitations: validated.dropped.length, unverified: !parsed.block,
          generalKnowledge: parsed.block?.generalKnowledge ?? null,
          isMiss: result.status === 'complete' && parsed.block?.isMiss === true,
          searches: result.searches ?? [], durationMs: result.durationMs ?? 0
        }
        if (fields.isMiss) fields.searchedTerms = parsed.block.searched.length ? parsed.block.searched : (result.searches ?? []).map(search => search.query)
      }
      const message = store.tx(() => {
        const message = finishMessage(inTransaction, messageId, fields)
        if (message && fields.isMiss) insertMiss(inTransaction, { question, threadId, searchedTerms: fields.searchedTerms, at: now() })
        return message
      })
      if (!message) return
      log({ event: 'ask.finished', threadId, messageId, status: message.status, length: message.text.length, durationMs: result.durationMs ?? 0 })
      if (closed) return
      if (fields.isMiss) emit('misses.changed', { unresolved: unresolvedCount(store) })
      if (message.status === 'error') emit('ask.error', { threadId, messageId, error: { code: 'ask_failed', message: message.error, retryable: false } })
      else emit('ask.done', { threadId, message })
    } finally { running.delete(messageId) }
  }

  function ask ({ threadId, text }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || text.includes('\0')) throw apiError(422, 'validation_failed', { fields: ['text'] })
    if (closed || ['down', 'unknown'].includes(health().state)) throw apiError(503, 'vault_unavailable')
    if (threadId !== undefined && (typeof threadId !== 'string' || !threadId)) throw apiError(422, 'validation_failed', { fields: ['threadId'] })
    if (threadId && busy(threadId)) throw apiError(409, 'ask_in_progress')
    const settings = prefs()
    if (!settings.vaultPath) throw apiError(503, 'vault_unavailable')
    const created = store.tx(() => {
      const thread = threadId ? getThread(store, threadId)?.thread : createThread(store, { title: text, at: now() })
      if (!thread || thread.scope !== 'vault') throw apiError(404, 'not_found')
      const context = threadContext(store, thread.id)
      const userMessage = appendMessage(inTransaction, { threadId: thread.id, role: 'user', text, at: now() })
      const assistant = appendMessage(inTransaction, { threadId: thread.id, role: 'assistant', text: '', at: now() })
      return { thread, userMessage, assistantMessageId: assistant.id, prompt: context ? `${context}\n\n${text}` : text }
    })
    const entry = { threadId: created.thread.id, messageId: created.assistantMessageId, question: text, runId: null, work: null }
    running.set(entry.messageId, entry)
    log({ event: 'ask.started', threadId: entry.threadId, messageId: entry.messageId, length: text.length })
    let run
    try {
      run = engine.run({ threadId: entry.threadId, prompt: created.prompt, mcpCommand: settings.vaultCommand,
        vaultPath: settings.vaultPath, lang: settings.lang, onDelta: delta => {
          if (!closed && running.has(entry.messageId)) emit('ask.delta', { threadId: entry.threadId, messageId: entry.messageId, text: delta })
        } })
      entry.runId = run.runId
    } catch { run = Promise.resolve({ status: 'error', error: 'ask failed to start' }) }
    entry.work = Promise.resolve(run).then(result => finish(entry, result), () => finish(entry, { status: 'error', error: 'ask failed' }))
      .catch(() => {
        running.delete(entry.messageId)
        // A persistence failure must never become an unhandled rejection or leak question text to a log.
        log({ event: 'ask.persistence_error', threadId: entry.threadId, messageId: entry.messageId })
      })
    return { thread: created.thread, userMessage: created.userMessage, assistantMessageId: created.assistantMessageId }
  }

  function cancel (messageId) {
    const entry = running.get(messageId)
    if (!entry) {
      if (store.get("SELECT id FROM ask_messages WHERE id=? AND role='assistant'", messageId)) throw apiError(409, 'invalid_state')
      throw apiError(404, 'not_found')
    }
    engine.cancel(entry.runId)
    return { messageId }
  }

  function reapOrphans () {
    engine.reapOrphans()
    // Queued asks have no child in running.json; their unfinished rows also need recovery.
    for (const row of store.all("SELECT id FROM ask_messages WHERE role='assistant' AND duration_ms IS NULL AND text='' AND error IS NULL")) {
      finishMessage(store, row.id, { text: '', status: 'error', error: 'interrupted by a deck restart', durationMs: 0 })
    }
  }

  async function close () {
    closed = true
    const entries = [...running.values()]
    for (const entry of entries) engine.cancel(entry.runId)
    await Promise.all(entries.map(entry => entry.work))
  }
  return { ask, cancel, close, isAsking: busy, reapOrphans }
}
