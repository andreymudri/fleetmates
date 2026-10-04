// The live meeting ask (MEET-O4, D-105; 11-meetings 9.1): scribed's `ask` over the transcript only, streamed
// to the browser as ephemeral `ask.delta` then `ask.done` or `ask.error`. Nothing is stored: the thread and
// messages are transient (`persisted: false`), no event is appended, and `log` gets ids and lengths only.
import { randomUUID } from 'node:crypto'
import { apiError } from '../http/router.mjs'
import { ScribedError } from '../adapters/scribed.mjs'

/** Finished message ids remembered so a late `stop` reads `invalid_state` rather than `not_found`. */
const FINISHED_CAP = 64

/**
 * @typedef {{ id: string, title: string, scope: string, createdAt: number, persisted: false }} AskThread
 * @typedef {{ id: string, role: 'user'|'assistant', text: string, citations?: [], persisted: false }} AskMessage
 * @typedef {{ t: number, question: string, answer: string }} LiveAsk
 */

/**
 * The scribed ask for the meeting that is recording. One ask in flight per meeting.
 * @param {{
 *   client: { ask: Function, history: Function },
 *   recorder: { view: () => { state: string, meetingId: string|null } },
 *   publish: (event: { type: string, at: number, data: object }) => void,
 *   now?: () => number,
 *   newId?: () => string,
 *   log?: (entry: object) => void
 * }} opts
 */
export function createMeetingAsk ({ client, recorder, publish, now = Date.now, newId = randomUUID, log = () => {} }) {
  /** @type {Map<string, { meetingId: string, threadId: string, controller: AbortController }>} */
  const running = new Map()
  /** @type {Set<string>} meeting ids with an ask in flight */
  const busy = new Set()
  /** @type {string[]} */
  const finished = []

  /** @param {string} messageId */
  function settle (messageId) {
    const entry = running.get(messageId)
    if (!entry) return
    running.delete(messageId)
    busy.delete(entry.meetingId)
    finished.push(messageId)
    if (finished.length > FINISHED_CAP) finished.shift()
  }

  /** @param {string} meetingId */
  function requireRecording (meetingId) {
    const view = recorder.view()
    if (view.state === 'unavailable') throw apiError(503, 'scribed_unavailable')
    if (view.state !== 'recording' || view.meetingId !== meetingId) throw apiError(409, 'not_recording')
  }

  /**
   * Start an ask. Returns at once; the answer streams as ephemeral events.
   * @param {string} meetingId
   * @param {string} text the question
   * @returns {{ thread: AskThread, userMessage: AskMessage, assistantMessageId: string }}
   * @throws {Error} `scribed_unavailable` (503), `not_recording` (409) or `ask_in_progress` (409)
   */
  function ask (meetingId, text) {
    requireRecording(meetingId)
    if (busy.has(meetingId)) throw apiError(409, 'ask_in_progress')
    const createdAt = now()
    const threadId = newId()
    const userMessageId = newId()
    const assistantMessageId = newId()
    const controller = new AbortController()
    busy.add(meetingId)
    running.set(assistantMessageId, { meetingId, threadId, controller })
    log({ event: 'ask.start', meetingId, threadId, messageId: assistantMessageId, length: text.length })
    const parts = []
    const live = () => running.has(assistantMessageId) && !controller.signal.aborted
    client.ask(text, {
      signal: controller.signal,
      onDelta: (/** @type {string} */ delta) => {
        if (!live()) return
        parts.push(delta)
        publish({ type: 'ask.delta', at: now(), data: { threadId, messageId: assistantMessageId, text: delta, ephemeral: true } })
      }
    }).then(() => {
      if (!live()) return
      const answer = parts.join('')
      settle(assistantMessageId)
      log({ event: 'ask.done', meetingId, threadId, messageId: assistantMessageId, length: answer.length })
      publish({
        type: 'ask.done',
        at: now(),
        data: { threadId, message: { id: assistantMessageId, role: 'assistant', text: answer, citations: [], persisted: false }, ephemeral: true }
      })
    }, (/** @type {unknown} */ err) => {
      if (!live()) return
      settle(assistantMessageId)
      const error = err instanceof ScribedError
        ? { code: 'scribed_refused', message: 'scribed_refused', retryable: false, details: { text: err.message } }
        : { code: 'scribed_unavailable', message: 'scribed_unavailable', retryable: true, details: {} }
      log({ event: 'ask.error', meetingId, threadId, messageId: assistantMessageId, code: error.code })
      publish({ type: 'ask.error', at: now(), data: { threadId, messageId: assistantMessageId, error, ephemeral: true } })
    })
    return {
      thread: { id: threadId, title: text, scope: `meeting:${meetingId}`, createdAt, persisted: false },
      userMessage: { id: userMessageId, role: 'user', text, persisted: false },
      assistantMessageId
    }
  }

  /**
   * Stop displaying an answer (11-meetings 9.1): scribed has no cancel, so its `claude` child keeps running and
   * may still save the answer to `asks.jsonl`. The connection is closed, no further event is published for this
   * message, and the meeting can be asked again.
   * @param {string} messageId the `assistantMessageId`
   * @throws {Error} `not_found` (404) for an unknown id, `invalid_state` (409) for one already finished
   */
  function stop (messageId) {
    const entry = running.get(messageId)
    if (!entry) {
      if (finished.includes(messageId)) throw apiError(409, 'invalid_state')
      throw apiError(404, 'not_found')
    }
    settle(messageId)
    entry.controller.abort()
    log({ event: 'ask.stop', meetingId: entry.meetingId, threadId: entry.threadId, messageId })
  }

  /**
   * scribed's `history` for the recording meeting, so asks made from the TUI or CLI show in the live view. A
   * meeting that is not the recording one has no live asks: scribed only answers for its current session.
   * @param {string} meetingId
   * @returns {Promise<LiveAsk[]>}
   * @throws {Error} `scribed_unavailable` (503) when scribed cannot answer
   */
  async function history (meetingId) {
    const view = recorder.view()
    if (view.state !== 'recording' || view.meetingId !== meetingId) return []
    let result
    try {
      result = await client.history()
    } catch {
      throw apiError(503, 'scribed_unavailable')
    }
    log({ event: 'ask.history', meetingId, count: result.asks.length })
    return result.asks.map(({ t, question, answer }) => ({ t, question, answer }))
  }

  /** Stop displaying every ask in flight (server shutdown). */
  function close () {
    for (const [messageId, entry] of [...running]) {
      settle(messageId)
      entry.controller.abort()
    }
  }

  return { ask, stop, history, close }
}
