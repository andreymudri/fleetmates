// The launch flow and the session actions of M2 (docs/deck/05-api.md section 2.3, docs/deck/03-architecture.md
// section 4.1, state-machines rows 1, 4 to 6, 42, 46 and 50, D-68): start a session in a deckd PTY, type its
// first prompt once Claude Code shows the idle input box, and Stop, Nudge, Relaunch and the scrollback read.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { apiError } from '../http/router.mjs'
import { DEFAULT_RENDER_SIZE, readStoredHistory, renderHistory } from '../screen/history.mjs'

/** Longest launch task, in characters. */
export const TASK_MAX = 10_000
/** Default and largest `lines` of `GET /api/sessions/:id/scrollback`. */
export const SCROLLBACK_LINES = 1000
export const SCROLLBACK_LINES_MAX = 5000
/** Rendered stored rows the launcher remembers, newest used kept. */
export const RENDER_CACHE_SIZE = 64
/**
 * The first prompt of a "Run as a fleetmates job" launch (D-68); a blank line and the owner's task follow it.
 */
export const FLEETMATES_JOB_PROMPT = 'Run this task as a fleetmates run: write a fleetmates plan for it, then execute that plan with fleetmates so every task works in its own git worktree. The task:'

const PTY_ORIGINS = ['wrapped', 'launched']
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/**
 * Text that is safe inside one bracketed paste: the paste end marker and every C0 control other than tab and
 * newline are removed, so the text cannot end the paste early or send keys of its own.
 * @param {string} text
 * @returns {string}
 */
export function sanitizePaste(text) {
  return text.replaceAll(PASTE_END, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
}

/**
 * The bytes typed as a launch's first prompt: one bracketed paste of the sanitized text, then Enter.
 * @param {string} text
 * @returns {string}
 */
export function firstPromptKeys(text) {
  return `${PASTE_START}${sanitizePaste(text)}${PASTE_END}\r`
}

/**
 * The branch a working tree has checked out, read from its `HEAD` file (a `.git` file pointing at a gitdir is
 * followed); null when HEAD is detached or unreadable.
 * @param {string} root the working tree
 * @returns {string | null}
 */
export function headBranch(root) {
  try {
    let gitDir = path.join(root, '.git')
    if (fs.statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitDir, 'utf8'))
      if (!pointer) return null
      gitDir = path.resolve(root, pointer[1])
    }
    const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'))
    return ref ? ref[1] : null
  } catch { return null }
}

/**
 * Keep the newest `lines` lines of `text`, cut on `\r\n` boundaries; report whether older ones were dropped.
 * @param {string} text
 * @param {number} lines
 */
function lastLines(text, lines) {
  let at = text.endsWith('\r\n') ? text.length - 2 : text.length
  for (let i = 0; i < lines; i++) {
    if (at <= 0) return { text, truncated: false }
    at = text.lastIndexOf('\r\n', at - 1)
    if (at === -1) return { text, truncated: false }
  }
  return { text: text.slice(at + 2), truncated: true }
}

/**
 * Create the launcher over the deckd link Task 4 built (`hub/server/pty/link.mjs`). It subscribes to
 * `link.onIdle` at once to type pending launch tasks; `close()` unsubscribes. `render` turns a stored
 * scrollback row into served text (`renderHistory`); each row is rendered once and kept in a cache of
 * `RENDER_CACHE_SIZE` rows.
 * @param {{ store: object, projector: object, link?: import('../pty/link.mjs').DeckdLink, publish?: Function,
 *   now?: () => number, preferences: () => { prefs: { claudeCommand: string } }, render?: typeof renderHistory }} options
 */
export function createLauncher({ store, projector, link, now = Date.now, preferences, render = renderHistory }) {
  const typing = new Set()
  /** @type {Map<string, Promise<{ data: string, truncated: boolean }>>} */
  const rendered = new Map()
  // A stored row is keyed by its session, capture time and length; a new exit of the same session replaces it.
  function renderStored(id, stored) {
    const key = `${id}\n${stored.captured_at}\n${stored.text.length}`
    let entry = rendered.get(key)
    if (entry) rendered.delete(key)
    else {
      const { text, size } = readStoredHistory(stored.text)
      entry = Promise.resolve().then(() => render(text, size ?? DEFAULT_RENDER_SIZE))
      entry.catch(() => { if (rendered.get(key) === entry) rendered.delete(key) })
    }
    rendered.set(key, entry)
    while (rendered.size > RENDER_CACHE_SIZE) rendered.delete(rendered.keys().next().value)
    return entry
  }
  const live = () => {
    if (!link?.connected) throw apiError(503, 'deckd_unavailable')
  }
  const view = id => projector.snapshot().sessions.find(row => row.id === id)
  const row = id => {
    const found = store.get('SELECT * FROM sessions WHERE id=?', id)
    if (!found) throw apiError(404, 'not_found')
    return found
  }
  async function spawn(fields) {
    try { return await link.request('spawn', fields) } catch (error) {
      if (error.status === 503) throw error
      throw apiError(502, 'spawn_failed', { stderr: typeof error.message === 'string' ? error.message : '' })
    }
  }
  const keys = text => Buffer.from(text, 'utf8').toString('base64')
  // kill and write on a PTY deckd no longer has: the session is no longer in a state the action applies to.
  async function onPty(op, fields, state) {
    try { return await link.request(op, fields) } catch (error) {
      if (error.status === 503) throw error
      throw apiError(409, 'invalid_state', { state })
    }
  }

  // 03-architecture 4.1 step 4: the launch task is typed once, on an idle screen, never before one.
  function onIdle({ sessionId }) {
    if (!sessionId || typing.has(sessionId)) return
    const pending = store.get('SELECT id,pty_id,launch_task FROM sessions WHERE id=? AND alive=1', sessionId)
    if (!pending?.launch_task || !pending.pty_id) return
    typing.add(sessionId)
    link.request('write', { ptyId: pending.pty_id, data: keys(firstPromptKeys(pending.launch_task)), source: { kind: 'deck' } })
      .then(() => { store.tx(() => { store.run('UPDATE sessions SET launch_task=NULL WHERE id=? AND pty_id=?', sessionId, pending.pty_id) }) })
      .catch(() => {})
      .finally(() => { typing.delete(sessionId) })
  }
  const offIdle = link?.onIdle ? link.onIdle(onIdle) : () => {}

  return {
    /**
     * `POST /api/sessions` for a resolved repo (state-machines row 1).
     * @param {string} repoId
     * @param {{ task?: unknown, mode?: unknown }} body
     * @param {{ taskLabel?: string }} [options] internal display title, independent of the first prompt
     * @returns {Promise<{ status: 201, data: { session: object, warning?: { kind: 'repo_busy', sessionIds: string[] } } }>}
     */
    async launch(repoId, body, { taskLabel } = {}) {
      const task = body.task ?? ''
      const mode = body.mode ?? 'plain'
      if (!['plain', 'fleetmates'].includes(mode)) throw apiError(422, 'validation_failed', { fields: ['mode'] })
      if (typeof task !== 'string' || task.length > TASK_MAX || task.includes('\0')) throw apiError(422, 'validation_failed', { fields: ['task'] })
      // new-session AC5: a plain launch may start with no task; a fleetmates job needs one.
      if (mode === 'fleetmates' && !task.trim()) throw apiError(422, 'validation_failed', { fields: ['task'] })
      live()
      const reply = await spawn({ cwd: repoId, argv: [preferences().prefs.claudeCommand], env: {}, cols: 120, rows: 40, origin: 'launched' })
      // D-68: another plain session alive in the repo is a warning, never a refusal.
      const busy = store.all("SELECT id FROM sessions WHERE repo_id=? AND role='solo' AND alive=1 AND (pty_id IS NULL OR pty_id<>?) ORDER BY started_at,id", repoId, reply.ptyId).map(other => other.id)
      const launchTask = !task.trim() ? null : mode === 'fleetmates' ? `${FLEETMATES_JOB_PROMPT}\n\n${task}` : task
      const session = projector.create({ id: randomUUID(), origin: 'launched', pty_id: reply.ptyId, process_key: reply.ptyId, repo_id: repoId, cwd: repoId,
        branch: headBranch(repoId), task: taskLabel ?? (task.trim() ? task : 'Untitled'), launch_task: launchTask }, now())
      return { status: 201, data: { session, ...(busy.length ? { warning: { kind: 'repo_busy', sessionIds: busy } } : {}) } }
    },
    /** `POST /api/sessions/:id/stop` (row 50; the exit that follows ends the session, row 42). */
    async stop(id) {
      const current = row(id)
      if (current.origin === 'observed') throw apiError(409, 'read_only_session')
      if (['ended', 'crashed'].includes(current.state) || !current.alive || !current.pty_id) throw apiError(409, 'invalid_state', { state: current.state })
      live()
      projector.signal(id, { type: 'stop_requested' }, now())
      await onPty('kill', { ptyId: current.pty_id, signal: 'SIGTERM', graceMs: 5000 }, current.state)
      return { status: 202, data: { session: view(id) } }
    },
    /** `POST /api/sessions/:id/nudge`: one Enter typed by the deck into an idle or stale session. */
    async nudge(id) {
      const current = row(id)
      if (current.origin === 'observed') throw apiError(409, 'read_only_session')
      if (!['stale', 'idle'].includes(current.state) || !current.alive || !current.pty_id) throw apiError(409, 'invalid_state', { state: current.state })
      live()
      await onPty('write', { ptyId: current.pty_id, data: keys('\r'), source: { kind: 'deck' } }, current.state)
      return { status: 202, data: { session: view(id) } }
    },
    /** `POST /api/sessions/:id/relaunch` (row 46): a new process in the same deck session. */
    async relaunch(id) {
      const current = row(id)
      const allowed = current.state === 'crashed' && (PTY_ORIGINS.includes(current.origin) || current.origin === 'observed' && !!current.claude_session_id)
      if (!allowed) throw apiError(409, 'invalid_state', { state: current.state })
      live()
      const command = preferences().prefs.claudeCommand
      const argv = current.claude_session_id ? [command, '--resume', current.claude_session_id] : [command]
      const reply = await spawn({ cwd: current.cwd, argv, env: {}, cols: 120, rows: 40, origin: 'launched' })
      projector.signal(id, { type: 'relaunched', ptyId: reply.ptyId }, now())
      return { status: 202, data: { session: view(id) } }
    },
    /**
     * `GET /api/sessions/:id/scrollback`: deckd's serialized history for a live PTY (its raw ring when deckd
     * sends no `history`), else the text stored at exit rendered by `render` at its stored size (120x40 when
     * the row names none), once per stored row.
     * @param {string} id
     * @param {number} lines
     */
    async scrollback(id, lines) {
      const current = row(id)
      if (current.alive && current.pty_id && link?.connected) {
        const reply = await link.request('screen', { ptyId: current.pty_id, scrollback: lines + 1, history: true })
        const served = typeof reply.history?.data === 'string' ? reply.history.data : Buffer.from(reply.scrollback ?? '', 'base64').toString('utf8')
        const { text, truncated } = lastLines(served, lines)
        return { data: { text, source: 'deckd', truncated } }
      }
      const stored = store.get('SELECT captured_at,text,truncated FROM session_scrollback WHERE session_id=?', id)
      if (!stored) throw apiError(404, 'not_found')
      const out = await renderStored(id, stored)
      const { text, truncated } = lastLines(out.data, lines)
      return { data: { text, source: 'stored', truncated: !!stored.truncated || out.truncated || truncated } }
    },
    close() { offIdle() }
  }
}
