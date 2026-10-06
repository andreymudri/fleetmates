// The recorder machine of state-machines 6.2 and 6.3 over the scribed client, the scribed health row of
// state-machines 5.3, and the `isRecording()` that quiet mode reads (9.5). scribed is the source of truth: the
// 2 s `status` poll doubles as the health probe, and the deck's own start and stop only move the view until the
// next poll. Transcript lines are kept in memory (`ring`) and published as ephemeral events; no transcript text
// reaches the store, an event that is appended, or `log`.

import path from 'node:path'
import { ScribedError, ScribedTimeout, ScribedUnavailable, transcriptLine } from '../adapters/scribed.mjs'
import { policyFor } from './config.mjs'
import { readLiveEvents } from './history.mjs'
import { getMeeting, noteApps, upsertMeeting } from './store.mjs'

/** An answer slower than this (ms) counts as slow for the health row (state-machines 5.3). */
export const SCRIBED_SLOW_MS = 5000
/** Longest wait between probes while scribed is down (ms). */
export const DOWN_BACKOFF_MAX_MS = 60000
/** Longest wait between `subscribe` reconnects (ms). */
export const SUBSCRIBE_BACKOFF_MAX_MS = 30000
/** First wait before a `subscribe` reconnect (ms). */
export const SUBSCRIBE_RECONNECT_MS = 2000

/**
 * @typedef {{ t0: number, t1: number, speaker: string, text: string, asrModel: string|null }} TranscriptLine
 *   `asrModel` is the event's `asr_model`, null when it has none or the line came from `tail`
 * @typedef {{ state: 'unavailable'|'idle'|'starting'|'recording'|'stopping', meetingId: string|null,
 *   tag: string|null, confidential: boolean, elapsedS: number, since: number|null, startedAt: number|null,
 *   apps: string[], quiet: boolean, slow: boolean, lost: boolean,
 *   lastError: { cmd: string, message: string, at: number } | null }} Recorder
 * @typedef {{ dep: 'scribed', state: 'unknown'|'checking'|'ok'|'degraded'|'down', reason: string|null,
 *   since: number, nextProbeAt: number|null, attempt: number }} Health
 */

const TAIL_LINE = /^\[(\d+):(\d{2})\] ([^:]+?): (.*)$/

/**
 * The published line of a parsed `transcript` event, with the event's `asr_model` (the live view's meta line).
 * @param {{ t0: number, t1: number, speaker: string, text: string, asrModel: string|null }} parsed
 * @returns {TranscriptLine}
 */
const lineOf = parsed => ({ t0: parsed.t0, t1: parsed.t1, speaker: parsed.speaker, text: parsed.text, asrModel: parsed.asrModel })

/**
 * How a line prints in `tail`: whole seconds, speaker and text.
 * @param {TranscriptLine} line
 * @returns {string}
 */
const tailKey = line => `${Math.floor(line.t0)}\u0000${line.speaker}\u0000${line.text}`

/**
 * Parse the plain `tail` text, one `[MM:SS] Speaker: texto` line per event (`MM` is total minutes). `t1` is the
 * next line's `t0`, the last line's own `t0`.
 * @param {string} text
 * @returns {TranscriptLine[]}
 */
export function parseTailText (text) {
  /** @type {TranscriptLine[]} */
  const lines = []
  for (const raw of String(text).split('\n')) {
    const m = TAIL_LINE.exec(raw.replace(/\r$/, ''))
    if (!m || Number(m[2]) > 59) continue
    lines.push({ t0: Number(m[1]) * 60 + Number(m[2]), t1: 0, speaker: m[3], text: m[4], asrModel: null })
  }
  for (let i = 0; i < lines.length; i++) lines[i].t1 = i + 1 < lines.length ? lines[i + 1].t0 : lines[i].t0
  return lines
}

/**
 * Wait before probe `attempt` (1 based) while scribed is down: 2, 4, 8 … 60 s.
 * @param {number} attempt
 * @returns {number} ms
 */
export function downBackoffMs (attempt) {
  return Math.min(2000 * 2 ** Math.max(0, attempt - 1), DOWN_BACKOFF_MAX_MS)
}

/**
 * Wait before the next `subscribe` connect after `failures` failed connects in a row: 2 s after an EOF, then
 * 2, 4, 8 … 30 s.
 * @param {number} failures
 * @returns {number} ms
 */
export function subscribeBackoffMs (failures) {
  if (failures <= 1) return SUBSCRIBE_RECONNECT_MS
  return Math.min(SUBSCRIBE_RECONNECT_MS * 2 ** (failures - 1), SUBSCRIBE_BACKOFF_MAX_MS)
}

/**
 * @param {string} code
 * @param {number} status
 * @param {string} message
 * @param {object} [details]
 * @returns {Error & { code: string, status: number, details?: object }}
 */
function recorderError (code, status, message, details) {
  return Object.assign(new Error(message), { code, status }, details ? { details } : {})
}

/**
 * Create the recorder. Polling starts at once (on a 0 ms timer); `close()` stops it.
 * @param {{
 *   client: ReturnType<typeof import('../adapters/scribed.mjs').createScribedClient>,
 *   store: { appendEvent: Function, get: Function, run: Function, all: Function, tx: Function },
 *   config: () => any,
 *   policy?: (tag: string) => { confidential: boolean } | boolean,
 *   prefs?: () => { quietInMeetings?: boolean },
 *   publish?: (event: object) => void,
 *   onStopped?: (id: string) => void,
 *   now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   log?: (entry: object) => void,
 *   pollMs?: number,
 *   stopSlowMs?: number,
 *   ringCap?: number
 * }} options `config()` returns the Task 4 `parseConfig` result; `policy` defaults to `policyFor(config(), tag)`;
 *   `onStopped(id)` runs when a meeting stops (the deck's stop, another client's stop, or a changed session).
 */
export function createRecorder ({
  client, store, config, policy, prefs = () => ({ quietInMeetings: true }), publish = () => {},
  onStopped = () => {}, now = Date.now, timers = { setTimeout, clearTimeout }, log = () => {},
  pollMs = 2000, stopSlowMs = 60000, ringCap = 10000
}) {
  const policyOf = policy ?? (tag => policyFor(config(), tag))
  /** @param {string} tag */
  const confidentialOf = tag => {
    const p = policyOf(tag)
    return typeof p === 'boolean' ? p : p?.confidential !== false
  }

  // Recorder view fields.
  /** @type {Recorder['state']} */
  let state = 'unavailable'
  /** @type {string|null} */
  let meetingId = null
  /** @type {string|null} */
  let tag = null
  let confidential = false
  let elapsedS = 0
  /** @type {number|null} */
  let since = now()
  /** @type {number|null} */
  let startedAt = null
  /** @type {string[]} */
  let apps = []
  let slow = false
  let lost = false
  /** @type {Recorder['lastError']} */
  let lastError = null
  let lastKey = ''

  // Health row.
  /** @type {Health} */
  let healthRow = { dep: 'scribed', state: 'unknown', reason: null, since: now(), nextProbeAt: null, attempt: 0 }
  let fastAnswers = 0

  // Poll loop.
  let closed = false
  /** @type {any} */
  let pollTimer = null
  /** @type {Promise<Health>|null} */
  let polling = null
  // Bumped by every command outcome, so a poll sent before it cannot undo it.
  let epoch = 0

  // Commands.
  let stopInFlight = false
  /** @type {any} */
  let slowTimer = null

  // Subscription and ring.
  /** @type {{ token: object, handle: { close: () => void } } | null} */
  let sub = null
  /** @type {any} */
  let subTimer = null
  let subFailures = 0
  /** @type {number|null} */
  let lostAt = null
  /** @type {TranscriptLine[]} */
  let ring = []
  let lastT1 = -Infinity
  /** @type {TranscriptLine[]|null} lines held while a gap fill or a ring fill runs */
  let held = null

  /** @param {{ seq?: number, at: number, type: string, entityId?: string|null, data: object }[]} events */
  const publishStored = events => {
    for (const event of events) publish({ seq: event.seq, at: event.at, type: event.type, entityId: event.entityId, data: event.data })
  }

  /** @returns {Recorder} */
  function view () {
    return {
      state,
      meetingId,
      tag,
      confidential,
      elapsedS,
      since,
      startedAt,
      apps: [...apps],
      quiet: state === 'recording' && prefs()?.quietInMeetings !== false,
      slow,
      lost,
      lastError: lastError ? { ...lastError } : null
    }
  }

  // meeting.status is durable and appended only when a field other than elapsedS changed (D-118).
  function publishView () {
    const current = view()
    const key = JSON.stringify({ ...current, elapsedS: 0 })
    if (key === lastKey) return
    lastKey = key
    const at = now()
    const seq = Number(store.appendEvent({ at, type: 'meeting.status', data: current }))
    publish({ seq, at, type: 'meeting.status', data: current })
  }

  /** @param {Recorder['state']} next */
  function setState (next) {
    if (next !== state) {
      state = next
      since = now()
    }
  }

  function clearMeeting () {
    meetingId = null
    tag = null
    confidential = false
    elapsedS = 0
    startedAt = null
    apps = []
    slow = false
    lost = false
    ring = []
    lastT1 = -Infinity
    held = null
    lostAt = null
  }

  /** The meeting fields of a lost meeting, for `restoreLost`. */
  function lostMeeting () {
    return { meetingId: /** @type {string} */ (meetingId), tag, confidential, elapsedS, startedAt, apps, ring, lastT1, lostAt }
  }

  /** @param {ReturnType<typeof lostMeeting>} saved */
  function restoreLost (saved) {
    ({ meetingId, tag, confidential, elapsedS, startedAt, apps, ring, lastT1, lostAt } = saved)
    lost = true
    held = null
  }

  /** @param {Partial<Health>} patch */
  function setHealth (patch) {
    const next = { ...healthRow, ...patch }
    const changed = next.state !== healthRow.state || next.reason !== healthRow.reason
    if (changed) next.since = now()
    healthRow = next
    if (!changed) return
    const at = now()
    const data = { ...healthRow }
    const seq = Number(store.appendEvent({ at, type: 'health.changed', data }))
    publish({ seq, at, type: 'health.changed', data })
  }

  /** @param {number} tookMs */
  function healthAnswered (tookMs) {
    if (tookMs >= SCRIBED_SLOW_MS) {
      fastAnswers = 0
      setHealth({ state: 'degraded', reason: 'scribed_slow', attempt: 0, nextProbeAt: null })
      return
    }
    if (healthRow.state === 'degraded') {
      fastAnswers++
      if (fastAnswers < 2) return
    }
    fastAnswers = 0
    setHealth({ state: 'ok', reason: null, attempt: 0, nextProbeAt: null })
  }

  /** @param {unknown} err */
  function healthFailed (err) {
    fastAnswers = 0
    if (err instanceof ScribedUnavailable) {
      const attempt = healthRow.state === 'down' ? healthRow.attempt + 1 : 1
      setHealth({ state: 'down', reason: 'scribed_unavailable', attempt, nextProbeAt: now() + downBackoffMs(attempt) })
      wentDown()
      return
    }
    const reason = err instanceof ScribedTimeout ? 'scribed_timeout' : 'scribed_protocol_error'
    setHealth({ state: 'degraded', reason, attempt: 0, nextProbeAt: null })
  }

  // Row 2: scribed down in any state is `unavailable`; a meeting being recorded keeps its view, marked lost.
  function wentDown () {
    if (state === 'recording' || state === 'stopping') lost = true
    // The gap since the subscription was lost is filled when scribed is back on the same meeting.
    const gapSince = lost ? lostAt ?? now() : null
    closeSubscription()
    lostAt = gapSince
    setState('unavailable')
    publishView()
  }

  function nextPollMs () {
    return healthRow.state === 'down' ? downBackoffMs(healthRow.attempt) : pollMs
  }

  /** @param {number} ms */
  function schedulePoll (ms) {
    if (pollTimer !== null) timers.clearTimeout(pollTimer)
    pollTimer = null
    if (closed) return
    pollTimer = timers.setTimeout(() => {
      pollTimer = null
      void poll()
    }, ms)
    pollTimer?.unref?.()
  }

  /** @returns {Promise<Health>} */
  function poll () {
    if (polling) return polling
    const sentEpoch = epoch
    const sentAt = now()
    polling = (async () => {
      /** @type {Record<string, any>|null} */
      let status = null
      try {
        const took = Date.now()
        status = await client.status()
        if (closed) return { ...healthRow }
        healthAnswered(Date.now() - took)
      } catch (err) {
        if (closed) return { ...healthRow }
        healthFailed(err)
      }
      if (status && sentEpoch === epoch) applyStatus(status, sentAt)
      schedulePoll(nextPollMs())
      return { ...healthRow }
    })().finally(() => { polling = null })
    return polling
  }

  /**
   * @param {string} id
   * @param {{ tag: string, elapsed: number, at: number }} found
   */
  function join (id, { tag: joinedTag, elapsed, at }) {
    clearMeeting()
    meetingId = id
    tag = joinedTag
    confidential = confidentialOf(joinedTag)
    elapsedS = elapsed
    const existing = getMeeting(store, id)
    startedAt = existing?.startedAt ?? at - Math.round(elapsed * 1000)
    const cfg = config()
    const sessionDir = cfg?.ok && cfg.sessionDir ? path.join(cfg.sessionDir, id) : undefined
    const { meeting, events } = upsertMeeting(store, { id, tag: joinedTag, confidential, state: 'recording', startedAt, sessionDir, at })
    confidential = meeting.confidential
    apps = [...meeting.apps]
    publishStored(events)
    setState('recording')
    log({ event: 'recorder.joined', meetingId: id })
    ensureSubscribed()
    void fillRing(id)
  }

  /**
   * Rows 12 and 14: the meeting stopped without the deck's stop. Its row is `stopping` until the post-recording
   * watch sees `session.json`.
   * @param {string} id
   */
  function closeExternal (id) {
    const at = now()
    const { events } = upsertMeeting(store, { id, state: 'stopping', endedAt: at, at })
    publishStored(events)
    log({ event: 'recorder.closed', meetingId: id })
    callStopped(id)
  }

  /** @param {string} id */
  function callStopped (id) {
    try { onStopped(id) } catch (err) {
      log({ event: 'recorder.on_stopped_failed', meetingId: id, error: /** @type {Error} */ (err)?.name ?? 'Error' })
    }
  }

  /**
   * Apply one `status` (a poll, or the first message of a subscription).
   * @param {Record<string, any>} st
   * @param {number} at
   */
  function applyStatus (st, at = now()) {
    if (closed || state === 'starting') return
    const id = typeof st.session_id === 'string' && st.session_id ? st.session_id : null
    const elapsed = typeof st.elapsed_s === 'number' ? st.elapsed_s : 0
    if (stopInFlight) {
      // Row 13: scribed's own stopping is invisible in status; the stop's answer decides.
      publishView()
      return
    }
    const wasLive = (state === 'recording' || state === 'stopping' || (state === 'unavailable' && lost)) && meetingId !== null
    if (!st.recording || id === null) {
      if (wasLive) closeExternal(/** @type {string} */ (meetingId))
      clearMeeting()
      setState('idle')
      publishView()
      return
    }
    if (wasLive && meetingId === id) {
      lost = false
      setState('recording')
      ensureSubscribed()
    } else {
      if (wasLive) closeExternal(/** @type {string} */ (meetingId))
      join(id, { tag: typeof st.tag === 'string' ? st.tag : '', elapsed, at })
    }
    elapsedS = elapsed
    if (Array.isArray(st.routed_apps) && st.routed_apps.length && meetingId) {
      const { meeting, events } = noteApps(store, meetingId, st.routed_apps, now())
      if (meeting) apps = [...meeting.apps]
      publishStored(events)
    }
    publishView()
  }

  /**
   * Forward one line of the current meeting: ring, `lastT1`, ephemeral `meeting.transcript`.
   * @param {TranscriptLine} line
   */
  function forward (line) {
    ring.push(line)
    if (ring.length > ringCap) ring.splice(0, ring.length - ringCap)
    if (line.t1 > lastT1) lastT1 = line.t1
    publish({ at: now(), type: 'meeting.transcript', data: { meetingId, line, ephemeral: true } })
  }

  /** @param {Record<string, any>} event */
  function onTranscript (event) {
    const parsed = transcriptLine(event)
    if (!parsed || meetingId === null || parsed.sessionId !== meetingId) {
      log({ event: 'recorder.transcript_dropped', meetingId })
      return
    }
    const line = lineOf(parsed)
    if (held) held.push(line)
    else forward(line)
  }

  /** @param {Record<string, any>} event @returns {TranscriptLine|null} */
  const fileLine = event => {
    const parsed = transcriptLine(event)
    return parsed ? lineOf(parsed) : null
  }

  /**
   * Joining a meeting already in progress: the ring starts from `transcript.jsonl`. Lines the subscription
   * delivers meanwhile are held and appended after the file's.
   * @param {string} id
   */
  async function fillRing (id) {
    const cfg = config()
    if (!cfg?.ok || !cfg.sessionDir) return
    held = []
    let count = 0
    try {
      const events = await readLiveEvents(cfg.sessionDir, id)
      if (meetingId !== id) return
      for (const event of events) {
        const line = fileLine(event)
        if (!line) continue
        ring.push(line)
        if (line.t1 > lastT1) lastT1 = line.t1
        count++
      }
      if (ring.length > ringCap) ring.splice(0, ring.length - ringCap)
    } catch (err) {
      log({ event: 'recorder.ring_fill_failed', meetingId: id, error: /** @type {any} */ (err)?.code ?? 'error' })
    } finally {
      if (meetingId === id) releaseHeld()
    }
    log({ event: 'recorder.ring_filled', meetingId: id, count })
  }

  function releaseHeld () {
    const lines = held ?? []
    held = null
    for (const line of lines) if (line.t1 > lastT1) forward(line)
  }

  /**
   * Row 16: after a reconnect while recording, publish what was missed. `transcript.jsonl` first; when it cannot
   * be read, `tail` with the gap in minutes rounded up.
   * @param {string} id
   * @param {number} gapSince
   */
  async function gapFill (id, gapSince) {
    const after = lastT1
    held = []
    /** @type {TranscriptLine[]} */
    let lines = []
    let source = 'file'
    try {
      const cfg = config()
      if (!cfg?.ok || !cfg.sessionDir) throw new Error('no session_dir')
      lines = (await readLiveEvents(cfg.sessionDir, id, { afterT1: after })).map(fileLine).filter(line => line !== null)
    } catch {
      source = 'tail'
      try {
        const minutes = Math.max(1, Math.ceil((now() - gapSince) / 60000))
        // `tail` prints whole seconds, so a line that started after `after` can print below it: keep from the
        // second `after` falls in, minus the lines the ring already holds.
        const from = Math.floor(after)
        const seen = new Set(ring.filter(line => line.t1 >= from).map(tailKey))
        lines = parseTailText(await client.tail(minutes)).filter(line => line.t0 >= from && !seen.has(tailKey(line)))
      } catch (err) {
        log({ event: 'recorder.gap_fill_failed', meetingId: id, error: /** @type {Error} */ (err)?.name ?? 'Error' })
        lines = []
      }
    }
    if (meetingId !== id || closed) return
    for (const line of lines) forward(line)
    publish({ at: now(), type: 'meeting.recovered', data: { meetingId: id, count: lines.length, ephemeral: true } })
    log({ event: 'recorder.gap_filled', meetingId: id, source, count: lines.length })
    releaseHeld()
  }

  function ensureSubscribed () {
    if (closed || sub || subTimer !== null || healthRow.state === 'down') return
    openSubscription()
  }

  function openSubscription () {
    const token = {}
    let got = false
    const handle = client.subscribe({
      onStatus: st => {
        if (sub?.token !== token) return
        got = true
        subFailures = 0
        const gapSince = lostAt
        lostAt = null
        applyStatus(st)
        if (gapSince !== null && state === 'recording' && meetingId) void gapFill(meetingId, gapSince)
      },
      onTranscript: event => {
        if (sub?.token === token) onTranscript(event)
      },
      onClose: err => {
        if (sub?.token !== token) return
        sub = null
        if (closed || healthRow.state === 'down') return
        if (!got) subFailures++
        if (lostAt === null) lostAt = now()
        log({ event: 'recorder.subscribe_closed', error: err ? err.name : null, failures: subFailures })
        subTimer = timers.setTimeout(() => {
          subTimer = null
          ensureSubscribed()
        }, subscribeBackoffMs(subFailures))
        subTimer?.unref?.()
      }
    })
    sub = { token, handle }
  }

  function closeSubscription () {
    if (subTimer !== null) timers.clearTimeout(subTimer)
    subTimer = null
    const current = sub
    sub = null
    subFailures = 0
    lostAt = null
    current?.handle.close()
  }

  /**
   * Start a recording with `tag` (rows 4 to 7).
   * @param {string} wanted
   * @returns {Promise<Recorder>} the view after scribed's answer (`idle` after a timeout: the next poll decides)
   * @throws {Error} `unknown_tag` (422) before any command, `invalid_state` (409, `details.state`) while starting,
   *   recording or stopping, scribed's `ScribedError` with `code: 'scribed_refused'` and `details.text` (its message
   *   verbatim), `ScribedUnavailable` with `code: 'scribed_unavailable'`
   */
  async function start (wanted) {
    const cfg = config()
    const known = cfg?.ok && Array.isArray(cfg.tags) && cfg.tags.some(/** @param {any} t */ t => t?.tag === wanted)
    if (typeof wanted !== 'string' || !known) throw recorderError('unknown_tag', 422, 'unknown tag')
    if ((state !== 'idle' && state !== 'unavailable') || stopInFlight) {
      throw recorderError('invalid_state', 409, `recorder is ${state}`, { state })
    }
    // A meeting lost when scribed went down is kept until scribed's answer says what became of it: a new session
    // closes it, a failed start puts it back for the next poll to decide.
    const previous = state === 'unavailable' && lost && meetingId !== null ? lostMeeting() : null
    /** @param {Recorder['state']} fallback */
    const settle = fallback => {
      if (previous) {
        restoreLost(previous)
        setState('unavailable')
      } else {
        setState(fallback)
      }
    }
    clearMeeting()
    lastError = null
    setState('starting')
    publishView()
    let answer
    try {
      answer = await client.start(wanted)
    } catch (err) {
      epoch++
      if (closed) throw err
      if (err instanceof ScribedTimeout) {
        // Row 7: the next poll decides (row 11 may move to recording).
        settle('idle')
        publishView()
        log({ event: 'recorder.start_timeout' })
        return view()
      }
      if (err instanceof ScribedUnavailable) {
        settle('idle')
        healthFailed(err)
        publishView()
        throw Object.assign(err, { code: 'scribed_unavailable', status: 503 })
      }
      const message = /** @type {Error} */ (err)?.message ?? String(err)
      lastError = { cmd: 'start', message, at: now() }
      settle('idle')
      publishView()
      log({ event: 'recorder.start_refused', bytes: Buffer.byteLength(message) })
      if (err instanceof ScribedError) Object.assign(err, { code: 'scribed_refused', status: 409, details: { text: message } })
      throw err
    }
    epoch++
    if (closed) return view()
    const at = now()
    const id = answer.session_id
    if (!id) {
      // No session named: the next poll joins it.
      settle('idle')
      publishView()
      return view()
    }
    if (previous && previous.meetingId !== id) closeExternal(previous.meetingId)
    meetingId = id
    tag = wanted
    confidential = confidentialOf(wanted)
    startedAt = at
    elapsedS = 0
    const sessionDir = cfg.sessionDir ? path.join(cfg.sessionDir, id) : undefined
    const { meeting, events } = upsertMeeting(store, { id, tag: wanted, confidential, state: 'recording', startedAt: at, sessionDir, at })
    confidential = meeting.confidential
    apps = [...meeting.apps]
    publishStored(events)
    setState('recording')
    log({ event: 'recorder.started', meetingId: id })
    ensureSubscribed()
    publishView()
    return view()
  }

  /**
   * Stop the recording (rows 8 to 10): `stopping` at once, scribed's `stop` runs in the background.
   * @returns {Recorder} the `stopping` view
   * @throws {Error} `not_recording` (409) unless recording
   */
  function stop () {
    if (state !== 'recording' || meetingId === null) throw recorderError('not_recording', 409, 'not recording')
    const id = meetingId
    stopInFlight = true
    lastError = null
    slow = false
    setState('stopping')
    const { events } = upsertMeeting(store, { id, state: 'stopping', at: now() })
    publishStored(events)
    publishView()
    slowTimer = timers.setTimeout(() => {
      slowTimer = null
      if (state === 'stopping' && stopInFlight && meetingId === id) {
        slow = true
        publishView()
      }
    }, stopSlowMs)
    slowTimer?.unref?.()
    void runStop(id)
    return view()
  }

  /** @param {string} id */
  async function runStop (id) {
    try {
      await client.stop()
      epoch++
      stopInFlight = false
      clearSlow()
      if (closed) return
      const at = now()
      const { events } = upsertMeeting(store, { id, state: 'recorded', endedAt: at, at })
      publishStored(events)
      log({ event: 'recorder.stopped', meetingId: id })
      callStopped(id)
      if (meetingId === id && (state === 'stopping' || state === 'unavailable')) {
        clearMeeting()
        if (state === 'stopping') setState('idle')
      }
      publishView()
    } catch (err) {
      epoch++
      stopInFlight = false
      clearSlow()
      if (closed) return
      // Row 10: the next poll decides.
      const message = /** @type {Error} */ (err)?.message ?? String(err)
      lastError = { cmd: 'stop', message, at: now() }
      slow = false
      log({ event: 'recorder.stop_failed', meetingId: id, error: /** @type {Error} */ (err)?.name ?? 'Error' })
      publishView()
    }
  }

  function clearSlow () {
    if (slowTimer !== null) timers.clearTimeout(slowTimer)
    slowTimer = null
  }

  schedulePoll(0)

  return {
    start,
    stop,
    /** @returns {Recorder} */
    view,
    /** @returns {boolean} true only in `recording` */
    isRecording: () => state === 'recording',
    /** @returns {Health} the scribed health row */
    health: () => ({ ...healthRow }),
    /**
     * Poll at once (`U.Retry`).
     * @returns {Promise<Health>}
     */
    probeNow: () => {
      if (pollTimer !== null) timers.clearTimeout(pollTimer)
      pollTimer = null
      return poll()
    },
    /**
     * The live lines of `id` when it is the meeting being recorded, else an empty list.
     * @param {string} id
     * @returns {TranscriptLine[]}
     */
    ring: id => (id === meetingId && id !== null ? ring.map(line => ({ ...line })) : []),
    /** Stop polling, timers and the subscription. */
    close: () => {
      closed = true
      if (pollTimer !== null) timers.clearTimeout(pollTimer)
      pollTimer = null
      clearSlow()
      closeSubscription()
    }
  }
}
