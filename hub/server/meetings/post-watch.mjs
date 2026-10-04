// Post-processing watch and history sync (state-machines 6.4): follows each meeting from stop to
// `synthesized`, finds its note, and keeps the meeting rows in step with `session_dir`. Published
// `meeting.updated` events carry the `Meeting` view plus the derived `stuck` and `interrupted`; no
// title, transcript or note text is read into a row or an event.
import fs from 'node:fs'
import path from 'node:path'
import { policyFor } from './config.mjs'
import { SESSION_ID, listSessions, postState } from './history.mjs'
import { findNote as findNoteOnDisk } from './note.mjs'
import { getMeeting, pruneMissing, upsertMeeting } from './store.mjs'

/**
 * Confidentiality of a policy answer, failing closed (DB-O2): only an explicit `false` (or
 * `{ confidential: false }`) is not confidential.
 * @param {boolean | { confidential?: boolean } | null | undefined} answer
 * @returns {boolean}
 */
const isConfidential = answer => typeof answer === 'boolean' ? answer : answer?.confidential !== false

/**
 * Create the post-processing watch.
 * `watch(id)` follows `<sessionDir>/<id>/` with `watch` (fs.watch) and a `pollMs` poll until `postState` says
 * `synthesized`, then stops. Each change of `state` or `stuck` updates the row and publishes `meeting.updated`.
 * On `synthesized`, the note of a non-confidential meeting is looked up with `findNote` and its path stored;
 * a confidential meeting's note is never looked up.
 * `sync()` lists the sessions, upserts a row for each (confidential from `policy(tag)`), prunes the rows whose
 * directory is gone and watches every session that is not `synthesized`, not interrupted and not recording.
 * With `config().ok` false it keeps the rows and stops every watch.
 * @param {{
 *   store: object,
 *   config: () => any,
 *   policy?: (tag: string) => boolean | { confidential?: boolean } | null | undefined,
 *   publish: (event: { seq: number, at: number, type: string, entityId: string, data: object }) => void,
 *   now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   watch?: typeof fs.watch,
 *   pollMs?: number,
 *   findNote?: typeof findNoteOnDisk
 * }} options `policy` defaults to `policyFor(config(), tag)`; `findNote` defaults to the vault reader of note.mjs
 * @returns {{ watch: (id: string) => void, unwatch: (id: string) => void, sync: (options?: { recordingId?: string|null }) => Promise<void>,
 *   watching: () => string[], close: () => void }}
 */
export function createPostWatch ({
  store, config, policy, publish, now = Date.now, timers = { setTimeout, clearTimeout }, watch = fs.watch,
  pollMs = 10000, findNote = findNoteOnDisk
}) {
  const policyOf = policy ?? (tag => policyFor(config(), tag))
  /** @type {Map<string, { id: string, dir: string, handle: any, timer: any, stuck: boolean, running: boolean, pending: boolean, stopped: boolean }>} */
  const watchers = new Map()
  /** The `interrupted` flag of each session as the last sync listed it. */
  const interrupted = new Map()
  let closed = false
  let syncing = Promise.resolve()

  function emit (events, stuck) {
    for (const event of events) {
      if (event.type !== 'meeting.updated') continue
      publish({
        seq: event.seq, at: event.at, type: event.type, entityId: event.entityId,
        data: { ...event.data, stuck, interrupted: interrupted.get(event.entityId) === true }
      })
    }
  }

  /** Append and publish a `meeting.updated` for a change the row does not hold (only `stuck` moved). */
  function emitView (meeting, at, stuck) {
    const event = { at, type: 'meeting.updated', entityId: meeting.id, data: meeting }
    const seq = Number(store.appendEvent(event))
    emit([{ seq, ...event }], stuck)
  }

  async function lookUpNote (cfg, meeting) {
    if (meeting.confidential || !meeting.tag || !cfg.vaultPath || !cfg.meetingsFolder) return null
    try {
      return await findNote({ vaultPath: cfg.vaultPath, meetingsFolder: cfg.meetingsFolder, id: meeting.id, tag: meeting.tag, date: meeting.id.slice(0, 10) })
    } catch { return null }
  }

  async function checkOnce (entry) {
    const cfg = config()
    if (!cfg?.ok || entry.stopped) return
    let post
    try { post = await postState(cfg.sessionDir, entry.id, { now: now() }) } catch { return }
    if (entry.stopped) return
    const row = getMeeting(store, entry.id)
    if (!row) return
    const synthesized = post.state === 'synthesized'
    if (post.state === row.state && post.stuck === entry.stuck && !synthesized) return
    const at = now()
    let notePath
    if (synthesized) {
      const found = await lookUpNote(cfg, row)
      if (entry.stopped) return
      if (found) notePath = found
    }
    const stuckMoved = post.stuck !== entry.stuck
    entry.stuck = post.stuck
    const { meeting, events } = upsertMeeting(store, { id: entry.id, state: post.state, notePath, at })
    if (events.length) emit(events, post.stuck)
    else if (stuckMoved) emitView(meeting, at, post.stuck)
    if (synthesized) unwatch(entry.id)
  }

  async function check (entry) {
    if (entry.running) { entry.pending = true; return }
    entry.running = true
    try {
      do {
        entry.pending = false
        await checkOnce(entry)
      } while (entry.pending && !entry.stopped)
    } finally { entry.running = false }
  }

  function arm (entry) {
    if (entry.stopped) return
    entry.timer = timers.setTimeout(() => {
      entry.timer = null
      if (entry.stopped) return
      check(entry).catch(() => {}).finally(() => arm(entry))
    }, pollMs)
    entry.timer?.unref?.()
  }

  /**
   * Follow one session until it is `synthesized`. A second call for a watched id does nothing.
   * @param {string} id
   */
  function watchSession (id) {
    if (closed || watchers.has(id) || typeof id !== 'string' || !SESSION_ID.test(id)) return
    const cfg = config()
    if (!cfg?.ok) return
    const dir = path.join(cfg.sessionDir, id)
    const entry = { id, dir, handle: null, timer: null, stuck: false, running: false, pending: false, stopped: false }
    watchers.set(id, entry)
    try {
      entry.handle = watch(dir, () => { if (!entry.stopped) check(entry).catch(() => {}) })
      entry.handle?.on?.('error', () => { try { entry.handle?.close() } catch {} entry.handle = null })
      entry.handle?.unref?.()
    } catch { entry.handle = null }
    check(entry).catch(() => {}).finally(() => { if (entry.timer === null) arm(entry) })
  }

  /**
   * Stop following one session.
   * @param {string} id
   */
  function unwatch (id) {
    const entry = watchers.get(id)
    if (!entry) return
    watchers.delete(id)
    entry.stopped = true
    if (entry.timer !== null) timers.clearTimeout(entry.timer)
    entry.timer = null
    if (entry.handle) { try { entry.handle.close() } catch {} }
    entry.handle = null
  }

  const stopAll = () => { for (const id of [...watchers.keys()]) unwatch(id) }

  async function syncOnce ({ recordingId = null } = {}) {
    if (closed) return
    const cfg = config()
    if (!cfg?.ok) { stopAll(); return }
    const sessions = await listSessions(cfg.sessionDir, { now: now(), recordingId })
    if (closed) return
    const at = now()
    const follow = []
    for (const session of sessions) {
      const row = getMeeting(store, session.id)
      const tag = session.tag ?? row?.tag ?? null
      // No manifest and no row: the tag is unknown, so there is nothing to store yet.
      if (tag === null) continue
      interrupted.set(session.id, session.interrupted)
      const confidential = isConfidential(policyOf(tag))
      let notePath
      if (session.state === 'synthesized' && !row?.notePath) {
        notePath = await lookUpNote(cfg, { id: session.id, tag, confidential: confidential || row?.confidential === true }) ?? undefined
      }
      const { events } = upsertMeeting(store, {
        id: session.id, tag, confidential, state: session.state, startedAt: session.startedAt, endedAt: session.endedAt,
        sessionDir: session.dir, notePath, at
      })
      emit(events, watchers.get(session.id)?.stuck ?? false)
      if (session.state !== 'synthesized' && session.state !== 'recording' && !session.interrupted) follow.push(session)
    }
    const listed = sessions.map(session => session.id)
    pruneMissing(store, listed, at)
    const keep = new Set(follow.map(session => session.id))
    for (const [id, entry] of watchers) {
      if (!keep.has(id) || entry.dir !== path.join(cfg.sessionDir, id)) unwatch(id)
    }
    for (const id of interrupted.keys()) if (!listed.includes(id)) interrupted.delete(id)
    for (const session of follow) watchSession(session.id)
  }

  return {
    watch: watchSession,
    unwatch,
    /**
     * Bring the rows in step with `session_dir` (server start and each config change). Calls run one at a time.
     * @param {{ recordingId?: string|null }} [options] the session scribed is recording, listed as `recording`
     */
    sync (options) {
      const run = syncing.then(() => syncOnce(options))
      syncing = run.catch(() => {})
      return run
    },
    watching: () => [...watchers.keys()],
    close () {
      closed = true
      stopAll()
    }
  }
}
