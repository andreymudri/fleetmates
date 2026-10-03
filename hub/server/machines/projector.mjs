import { realpathSync } from 'node:fs'
import { capHistory } from '../../deckd/screen-model.mjs'
import { dedupeKey } from '../ingest/validate.mjs'
import { historySize, sizeHeader } from '../screen/history.mjs'
import { isRunName } from '../adapters/fleetmates.mjs'
import { archiveFinished, archiveSession, autoArchiveCandidates, unarchiveNeedingOwner, unarchiveSession } from './archive.mjs'
import { projectCounts, projectHome } from './counts.mjs'
import { applyRequestHook, expireRequests, isRequestOpening, reconcileRequestOpenings, resumedActivityEvents } from './request.mjs'
import { applySessionHook, applySubagentLifecycle, captureReviewBaseline, ignoresSessionHook, isObsoleteSessionStart, leadRunId, persistSessionSummary, recordSessionIdentity, recordToolStep, refreshSessionChanges, workingRoot, resolveSession, sameKnownProcess } from './session.mjs'

const ranks = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'PermissionDenied', 'PostToolUseFailure', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd']
const rank = event => {
  const index = ranks.indexOf(event)
  return index < 0 ? 1 : index === 0 ? 0 : index + 1
}

/**
 * The commit the session's review compares against, read from the stored `review_baseline`. The stored value
 * is JSON that also holds per-file fingerprints and file contents, which stay private: the view carries only
 * the commit sha, and null outside git, for an unborn HEAD, or for a value it cannot read.
 * @param {string|null} value the `sessions.review_baseline` column
 * @returns {string|null}
 */
function reviewBaselineHead(value) {
  if (typeof value !== 'string') return null
  try {
    const head = JSON.parse(value)?.head
    return typeof head === 'string' && /^[0-9a-f]{40,64}$/.test(head) ? head : null
  } catch { return null }
}
function sessionView(row, store) {
  return {
    id: row.id,
    claudeSessionId: row.claude_session_id,
    sessionAliases: store.all('SELECT claude_session_id FROM session_aliases WHERE session_id=? ORDER BY replaced_at,claude_session_id', row.id).map(alias => alias.claude_session_id),
    origin: row.origin,
    ptyId: row.pty_id,
    repoId: row.repo_id,
    cwd: row.cwd,
    branch: row.branch,
    task: row.task,
    runRef: row.run_id ? { repoId: row.run_repo_id, runId: row.run_id, taskId: row.run_task_id } : null,
    role: row.role,
    state: row.state,
    stateSince: row.state_since,
    lastActivityAt: row.last_activity_at,
    alive: !!row.alive,
    processKey: row.process_key,
    activity: row.activity,
    subagentsActive: row.subagents_active,
    joinedMidLife: !!row.joined_mid_life,
    changedFiles: JSON.parse(row.changed_files),
    crashKind: row.crash_kind,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    lastInputFrom: row.last_input_from,
    lastInputName: row.last_input_name,
    transcriptPath: row.transcript_path,
    reviewedAt: row.reviewed_at,
    reviewBaseline: reviewBaselineHead(row.review_baseline),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    archivedAt: row.archived_at ?? null,
    archivedBy: row.archived_by ?? null,
    toolCalls: store.get('SELECT COUNT(*) AS n FROM session_steps WHERE session_id=?', row.id).n
  }
}
function requestView(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    tier: row.tier,
    toolName: row.tool_name,
    summary: row.summary,
    detail: JSON.parse(row.detail),
    why: row.why,
    options: JSON.parse(row.options),
    state: row.state,
    expiredReason: row.expired_reason,
    answer: row.answer ? JSON.parse(row.answer) : null,
    source: row.source,
    matchKey: row.match_key,
    delivery: row.delivery,
    screenMatch: row.screen_match,
    taskId: row.task_id,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    notifiedAt: row.notified_at,
    renotifiedAt: row.renotified_at
  }
}

/**
 * Longest stored exit scrollback in bytes (06-storage `session_scrollback`); a longer tail keeps its end, a
 * longer history keeps its newest whole lines.
 */
export const SCROLLBACK_CAP = 2 * 1024 * 1024
/**
 * Expired reason for requests closed by `screen_idle` (state-machines row 21: the prompt left the screen with
 * no outcome). The plan names it `prompt_gone`, but the `requests.expired_reason` CHECK in 0001-init.sql and
 * the 05-api `expiredReason` type allow only process_ended, session_replaced, interrupted and superseded, so
 * this uses `interrupted`, the reason `Notification(idle_prompt)` already gives the same row.
 */
export const PROMPT_GONE_REASON = 'interrupted'
const PTY_ORIGINS = ['wrapped', 'launched']

const realPath = location => {
  try { return realpathSync(location) } catch { return null }
}

/**
 * Persist ordered hook batches and publish only sequences from committed transactions.
 * `locateTask(repoRoot, cwd)` resolves a directory to the fleetmates task whose worktree it is
 * (`{ runId, taskId }` or null); it joins sessions to runs (04-integrations 1.3, state-machines 11).
 */
export function createProjector({ store, now = Date.now, publish = () => {}, locateTask = () => null }) {
  function locate(repoRoot, cwd) {
    try { return locateTask(repoRoot, cwd) ?? null } catch { return null }
  }
  // The teammate task a hook belongs to: a hook whose cwd differs from the session's and resolves to a task of
  // a run in the session's repo, else the session's own runRef task. The session's repo never moves for it.
  function taskIdFor(session, hook) {
    if (typeof hook.cwd === 'string' && hook.cwd !== session.cwd) {
      const found = locate(session.repo_id, hook.cwd)
      if (found) return found.taskId
    }
    return session.run_task_id ?? null
  }
  // A SessionStart inside a teammate worktree makes the session that task's teammate; so does a later hook from a
  // solo session there, for a teammate that started before its `locate` wrote the index record.
  function joinTeammate(session, roles = ['solo', 'teammate']) {
    if (!roles.includes(session.role)) return session
    const found = locate(session.repo_id, session.cwd)
    if (!found) return session
    store.run('UPDATE sessions SET role=?,run_repo_id=?,run_id=?,run_task_id=? WHERE id=?', 'teammate', session.repo_id, found.runId, found.taskId, session.id)
    return store.get('SELECT * FROM sessions WHERE id=?', session.id)
  }
  // A lead names its run in `scripts/cli.mjs ... --run <id>` from the repo root; the run row records it.
  function joinLead(session, hook, at) {
    if (!['solo', 'lead'].includes(session.role)) return session
    const runId = leadRunId(hook.tool_input?.command)
    if (runId === null || !isRunName(session.repo_id, runId)) return session
    if (realPath(session.cwd) !== session.repo_id || realPath(hook.cwd ?? session.cwd) !== session.repo_id) return session
    store.run('UPDATE sessions SET role=?,run_repo_id=?,run_id=?,run_task_id=NULL WHERE id=?', 'lead', session.repo_id, runId, session.id)
    store.run('INSERT INTO runs(repo_id,run_id,lead_session_id,first_seen_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(repo_id,run_id) DO UPDATE SET lead_session_id=excluded.lead_session_id,last_seen_at=MAX(last_seen_at,excluded.last_seen_at)',
      session.repo_id, runId, session.id, at, at)
    return store.get('SELECT * FROM sessions WHERE id=?', session.id)
  }
  function snapshot() {
    const sessions = store.all('SELECT * FROM sessions ORDER BY started_at, id').map(row => sessionView(row, store))
    const requests = store.all('SELECT * FROM requests ORDER BY created_at, id').map(requestView)
    return { seq: Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq), sessions, requests, counts: projectCounts(store), home: projectHome(sessions, requests) }
  }
  // The urgency order is the snapshot's `home.order`; only the fields it sorts on are read here.
  function urgencyOrder() {
    const sessions = store.all('SELECT id, state, state_since, archived_at FROM sessions').map(row => ({ id: row.id, state: row.state, stateSince: row.state_since, archivedAt: row.archived_at }))
    const requests = store.all('SELECT session_id, created_at FROM requests WHERE state = ?', 'open').map(row => ({ sessionId: row.session_id, createdAt: row.created_at, state: 'open' }))
    return projectHome(sessions, requests).order
  }
  let publishedOrder = null
  // order.changed (05-api 3.4) when the order differs from the last one clients were given. A session that
  // only leaves the order (it ended) moves nobody, so that alone publishes nothing; clients drop ended rows.
  function orderEvent(at) {
    const order = urgencyOrder()
    const current = new Set(order)
    const kept = publishedOrder.filter(id => current.has(id))
    if (kept.length !== order.length || kept.some((id, index) => id !== order[index])) store.appendEvent({ at, type: 'order.changed', data: { order } })
    return order
  }
  function commit(fn) {
    const before = Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq)
    publishedOrder ??= urgencyOrder()
    let order
    store.tx(() => {
      fn()
      // Every path that opens a request (hooks, late reconcile, screen parse) unarchives in the same transaction.
      const unarchived = unarchiveNeedingOwner(store)
      if (unarchived.length) {
        const at = now()
        for (const id of unarchived) store.appendEvent({ at, type: 'session.upserted', entityId: id, data: sessionView(store.get('SELECT * FROM sessions WHERE id=?', id), store) })
        store.appendEvent({ at, type: 'counts', data: projectCounts(store) })
      }
      order = orderEvent(now())
    })
    publishedOrder = order
    const events = store.all('SELECT seq, at, type, entity_id, data FROM events WHERE seq > ? ORDER BY seq', before).map(row => ({ seq: Number(row.seq), at: row.at, type: row.type, entityId: row.entity_id, data: JSON.parse(row.data) }))
    for (const event of events) publish(event)
    return events
  }
  // screen_idle and counted output for a live PTY session. Returns whether the session changed in a way that is
  // published; a silent last_activity_at update returns false.
  function applyScreenSignal(row, signal, at) {
    if (!row.alive || !PTY_ORIGINS.includes(row.origin)) return false
    if (signal.type === 'output') {
      if (row.state !== 'stale') {
        store.run('UPDATE sessions SET last_activity_at=MAX(last_activity_at,?) WHERE id=?', at, row.id)
        return false
      }
      // Row 29: activity resets stale.
      store.run('UPDATE sessions SET state=?,state_since=?,since_ts=?,last_activity_at=MAX(last_activity_at,?) WHERE id=?', 'running', at, at, at, row.id)
      return true
    }
    if (row.state === 'running') {
      // Row 30: no open tool step and no subagent working, else the idle screen is the lead waiting on them.
      if (row.subagents_active !== 0 || store.get('SELECT 1 AS open FROM session_steps WHERE session_id=? AND status=? LIMIT 1', row.id, 'running')) return false
      const refreshed = refreshSessionChanges(store, row)
      const state = JSON.parse(refreshed.changed_files).length ? 'done' : 'idle'
      store.run('UPDATE sessions SET state=?,state_since=?,since_ts=? WHERE id=?', state, at, at, row.id)
      return true
    }
    if (!['needs_approval', 'asked_you'].includes(row.state)) return false
    // Row 21: the prompt left the screen with no outcome (Esc in the terminal). A question the deck opened from
    // the last assistant text (source stop_question) is answered at the idle input box, so it stays open.
    const open = store.all('SELECT id FROM requests WHERE session_id=? AND state=? AND source<>?', row.id, 'open', 'stop_question')
    if (open.length === 0) return false
    store.run('UPDATE requests SET state=?,expired_reason=? WHERE session_id=? AND state=? AND source<>?', 'expired', PROMPT_GONE_REASON, row.id, 'open', 'stop_question')
    for (const request of open) {
      const closed = store.get('SELECT * FROM requests WHERE id=?', request.id)
      store.appendEvent({ at, type: 'request.closed', entityId: closed.id, data: requestView(closed) })
    }
    const left = store.all('SELECT kind FROM requests WHERE session_id=? AND state=?', row.id, 'open')
    const state = left.some(request => request.kind === 'permission') ? 'needs_approval' : left.length ? 'asked_you' : 'idle'
    store.run('UPDATE sessions SET state=?,state_since=?,since_ts=? WHERE id=?', state, state === row.state ? row.state_since : at, at, row.id)
    return true
  }
  function closeRequests(sessionId, reason, at) {
    const open = store.all('SELECT id FROM requests WHERE session_id = ? AND state = ?', sessionId, 'open')
    expireRequests(store, sessionId, reason)
    for (const request of open) {
      const row = store.get('SELECT * FROM requests WHERE id = ?', request.id)
      store.appendEvent({ at, type: 'request.closed', entityId: row.id, data: requestView(row) })
    }
  }
  // Runs one archive change in `commit`: a `session.upserted` per changed session and one `counts`.
  function archiveCommit(change) {
    let result
    commit(() => {
      result = change()
      if (!Array.isArray(result)) return
      const at = now()
      for (const id of result) store.appendEvent({ at, type: 'session.upserted', entityId: id, data: sessionView(store.get('SELECT * FROM sessions WHERE id=?', id), store) })
      store.appendEvent({ at, type: 'counts', data: projectCounts(store) })
    })
    return result
  }
  return {
    snapshot,
    /**
     * Archive one session (`archived_by` = `by`, `archived_at` = now).
     * @param {string} id session id
     * @param {'owner'|'auto'} by who archived it
     * @returns {string[] | { ok: false, code: 'not_found'|'needs_you' }} the changed ids (empty when already
     *   archived), or the refusal
     */
    archive(id, by) {
      return archiveCommit(() => {
        const result = archiveSession(store, id, { by, at: now() })
        if (!result.ok) return result
        return result.changed ? [id] : []
      })
    },
    /**
     * Clear the archive of one session.
     * @param {string} id session id
     * @returns {string[]} the changed ids (empty when it was not archived or does not exist)
     */
    unarchive(id) {
      return archiveCommit(() => unarchiveSession(store, id).changed ? [id] : [])
    },
    /**
     * Archive, by the owner, every finished session without unreviewed changes.
     * @returns {string[]} the archived ids
     */
    archiveFinished() {
      return archiveCommit(() => archiveFinished(store, { at: now() }))
    },
    /**
     * Archive, as `'auto'`, every auto-archive candidate for a delay of `afterHours` (null means never).
     * @param {number|null} afterHours the `autoArchiveAfter` pref
     * @returns {string[]} the archived ids
     */
    autoArchive(afterHours) {
      return archiveCommit(() => {
        const at = now()
        const ids = autoArchiveCandidates(store, { at, afterHours })
        for (const id of ids) archiveSession(store, id, { by: 'auto', at })
        return ids
      })
    },
    /**
     * Insert a session row the deck itself started (the launch flow, state-machines row 1) in one transaction
     * and append `session.upserted`, `counts` and, when the urgency order moved, `order.changed`. A live row
     * that already holds `pty_id` (a hook from the new PTY was ingested before this insert) is adopted
     * instead: it takes `origin`, `task` (unless `Untitled`), `launch_task` and `joined_mid_life = 0`.
     * @param {{ id: string, origin: string, pty_id: string, process_key: string, repo_id: string, cwd: string,
     *   task?: string, launch_task?: string | null, branch?: string | null }} row columns of the new row
     * @param {number} [at] start time
     * @returns {object} the session view
     */
    create(row, at = now()) {
      let id = row.id
      commit(() => {
        const live = store.get('SELECT id FROM sessions WHERE pty_id=? AND alive=1', row.pty_id)
        if (live) {
          id = live.id
          store.run("UPDATE sessions SET origin=?,task=CASE WHEN ?='Untitled' THEN task ELSE ? END,launch_task=?,joined_mid_life=0 WHERE id=?", row.origin, row.task ?? 'Untitled', row.task ?? 'Untitled', row.launch_task ?? null, id)
        } else {
          store.run('INSERT INTO sessions(id,origin,pty_id,process_key,repo_id,cwd,branch,task,launch_task,state,state_since,since_ts,last_activity_at,alive,joined_mid_life,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            id, row.origin, row.pty_id, row.process_key, row.repo_id, row.cwd, row.branch ?? null, row.task ?? 'Untitled', row.launch_task ?? null, 'starting', at, at, at, 1, 0, at)
        }
        store.appendEvent({ at, type: 'session.upserted', entityId: id, data: sessionView(store.get('SELECT * FROM sessions WHERE id=?', id), store) })
        store.appendEvent({ at, type: 'counts', data: projectCounts(store) })
      })
      return sessionView(store.get('SELECT * FROM sessions WHERE id=?', id), store)
    },
    applyHooks(batch) {
      return commit(() => {
        for (const envelope of [...batch].sort((a, b) => a.hookTs - b.hookTs || rank(a.hook.hook_event_name) - rank(b.hook.hook_event_name))) {
          const hook = envelope.hook
          const key = envelope.dedupeKey ?? dedupeKey(envelope)
          if (store.get('SELECT id FROM hook_events WHERE dedupe_key = ?', key)) continue
          let session = resolveSession(store, envelope)
          if (!session && hook.hook_event_name === 'SessionEnd') continue
          const beforeRequests = session ? new Map(store.all('SELECT * FROM requests WHERE session_id = ?', session.id).map(row => [row.id, requestView(row)])) : new Map()
          const previousEndReason = session?.end_reason
          const previousConversation = session?.claude_session_id
          const obsoleteStart = isObsoleteSessionStart(store, session, envelope)
          if (session && !obsoleteStart && (hook.hook_event_name !== 'SessionStart' || envelope.hookTs < session.since_ts)) session = recordSessionIdentity(store, session, envelope)
          const identityChanged = !!session && session.claude_session_id !== previousConversation
          const replacementChanged = !!session && session.end_reason !== previousEndReason
          const late = !!session && (obsoleteStart || envelope.hookTs < session.since_ts || !session.alive && !(hook.hook_event_name === 'SessionStart' && hook.source === 'resume'))
          let requestChanged = replacementChanged && [...beforeRequests].some(([id, row]) => row.state === 'open' && store.get('SELECT state FROM requests WHERE id=?', id)?.state !== 'open')
          const lifecycleEvent = ['SubagentStart', 'SubagentStop'].includes(hook.hook_event_name)
          let lifecycleAccepted = false
          let lifecycleChanged = false
          let openingApplied = false
          if (late && session.alive && isRequestOpening(hook) && sameKnownProcess(store, session, envelope)) {
            const boundary = Math.max(session.joined_mid_life ? 0 : session.started_at, store.get("SELECT COALESCE(MAX(hook_ts),0) AS at FROM hook_events WHERE session_id=? AND applied=1 AND event='SessionStart' AND COALESCE(json_extract(payload,'$.source'),'startup')<>'compact'", session.id).at)
            const currentConversation = candidate => candidate.session_id === session.claude_session_id || !!store.get('SELECT claude_session_id FROM session_aliases WHERE session_id=? AND claude_session_id=? AND source=?', session.id, candidate.session_id, 'compact')
            if (envelope.hookTs >= boundary && currentConversation(hook)) {
              const history = store.all('SELECT hook_ts,payload,pty_id,claude_pid FROM hook_events WHERE session_id=? AND hook_ts>=? ORDER BY hook_ts,id', session.id, boundary)
                .map(row => ({ hookTs: row.hook_ts, hook: JSON.parse(row.payload), ptyId: row.pty_id, claudePid: row.claude_pid }))
                .filter(item => sameKnownProcess(store, session, item) && currentConversation(item.hook))
              const owner = session
              requestChanged = reconcileRequestOpenings(store, { ...session, repo_id: workingRoot(session.cwd) }, [...history, envelope].sort((a, b) => a.hookTs - b.hookTs || rank(a.hook.hook_event_name) - rank(b.hook.hook_event_name)), { taskFor: item => taskIdFor(owner, item.hook) }) || requestChanged
              openingApplied = requestChanged
              if (requestChanged) {
                const open = store.all('SELECT kind FROM requests WHERE session_id=? AND state=?', session.id, 'open')
                const state = open.some(row => row.kind === 'permission') ? 'needs_approval' : open.length ? 'asked_you' : session.state
                store.run('UPDATE sessions SET state=? WHERE id=?', state, session.id)
                session = store.get('SELECT * FROM sessions WHERE id=?', session.id)
              }
            }
          }
          if (late && lifecycleEvent) {
            const result = applySubagentLifecycle(store, session, envelope, true)
            session = result.session
            lifecycleAccepted = result.accepted
            lifecycleChanged = result.changed
          }
          if (late && session.alive && (!lifecycleEvent || lifecycleAccepted) && [...resumedActivityEvents, 'PermissionDenied'].includes(hook.hook_event_name) && (hook.hook_event_name !== 'UserPromptSubmit' || sameKnownProcess(store, session, envelope))) {
            requestChanged = applyRequestHook(store, { ...session, repo_id: workingRoot(session.cwd) }, envelope, { late: true }) || requestChanged
            if (requestChanged && ['needs_approval', 'asked_you'].includes(session.state)) {
              const open = store.all('SELECT kind FROM requests WHERE session_id = ? AND state = ?', session.id, 'open')
              const state = open.some(row => row.kind === 'permission') ? 'needs_approval' : open.length ? 'asked_you' : 'running'
              store.run('UPDATE sessions SET state = ? WHERE id = ?', state, session.id)
              session = store.get('SELECT * FROM sessions WHERE id = ?', session.id)
            }
          }
          if (late && requestChanged && hook.hook_event_name === 'SessionStart' && ['needs_approval', 'asked_you'].includes(session.state)) {
            const open = store.all('SELECT kind FROM requests WHERE session_id=? AND state=?', session.id, 'open')
            const state = open.some(row => row.kind === 'permission') ? 'needs_approval' : open.length ? 'asked_you' : 'running'
            store.run('UPDATE sessions SET state=? WHERE id=?', state, session.id)
            session = store.get('SELECT * FROM sessions WHERE id=?', session.id)
          }
          if (!late) {
            const known = !!session
            if (!known) session = applySessionHook(store, envelope, null, false)
            if (session && lifecycleEvent) {
              const result = applySubagentLifecycle(store, session, envelope)
              session = result.session
              lifecycleAccepted = result.accepted
              lifecycleChanged = result.changed
            }
            if (known && session.alive && hook.hook_event_name !== 'SessionStart') session = joinTeammate(session, ['solo'])
            if (session && (!lifecycleEvent || lifecycleAccepted) && !ignoresSessionHook(store, session, hook)) {
              requestChanged = applyRequestHook(store, { ...session, repo_id: workingRoot(session.cwd) }, envelope, { taskId: taskIdFor(session, hook) })
              if (known) session = applySessionHook(store, envelope, session, requestChanged)
            }
            if (session && hook.hook_event_name === 'SessionStart') session = joinTeammate(session)
            if (session?.alive && hook.hook_event_name === 'PreToolUse' && hook.tool_name === 'Bash') session = joinLead(session, hook, envelope.hookTs)
          }
          if (session && (!late || session.alive && sameKnownProcess(store, session, envelope))) recordToolStep(store, session, envelope, { taskId: taskIdFor(session, hook) })
          store.run('INSERT INTO hook_events(dedupe_key,session_id,claude_session_id,event,hook_ts,received_at,via,pty_id,claude_pid,applied,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)', key, session?.id ?? null, hook.session_id, hook.hook_event_name, envelope.hookTs, envelope.receivedAt ?? now(), envelope.via ?? 'socket', envelope.ptyId ?? null, envelope.claudePid ?? null, lifecycleEvent ? lifecycleAccepted ? 1 : 0 : openingApplied || !late ? 1 : 0, JSON.stringify(hook))
          if (session && (!late || requestChanged)) {
            for (const row of store.all('SELECT * FROM requests WHERE session_id = ?', session.id)) {
              if (!beforeRequests.has(row.id)) store.appendEvent({ at: envelope.hookTs, type: 'request.opened', entityId: row.id, data: requestView(row) })
              else if (beforeRequests.get(row.id).state === 'open' && row.state !== 'open') store.appendEvent({ at: envelope.hookTs, type: 'request.closed', entityId: row.id, data: requestView(row) })
              else if (JSON.stringify(beforeRequests.get(row.id)) !== JSON.stringify(requestView(row))) store.appendEvent({ at: envelope.hookTs, type: 'request.updated', entityId: row.id, data: requestView(row) })
            }
          }
          if (session) persistSessionSummary(store, session)
          if (session && (!late || requestChanged || identityChanged || replacementChanged || lifecycleChanged)) store.appendEvent({ at: envelope.hookTs, type: 'session.upserted', entityId: session.id, data: sessionView(session, store) })
        }
        store.appendEvent({ at: now(), type: 'counts', data: projectCounts(store) })
      })
    },
    tick(at = now()) {
      return commit(() => {
        for (const row of store.all('SELECT * FROM sessions WHERE origin = ? AND alive = 1 AND end_reason IN (?, ?) AND ? - state_since >= ?', 'observed', 'clear', 'resume', at, 5000)) {
          closeRequests(row.id, 'process_ended', at)
          const state = JSON.parse(row.changed_files).length ? 'done' : 'ended'
          store.run('UPDATE sessions SET state = ?, state_since = ?, alive = 0, activity = NULL, ended_at = ?, since_ts = ? WHERE id = ?', state, state === row.state ? row.state_since : at, at, at, row.id)
          persistSessionSummary(store, store.get('SELECT * FROM sessions WHERE id = ?', row.id))
          store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id), store) })
        }
        for (const row of store.all('SELECT * FROM sessions WHERE state = ? AND (activity IS NULL OR activity <> ?) AND ? - last_activity_at >= ?', 'running', 'compacting', at, 1_200_000)) {
          store.run('UPDATE sessions SET state = ?, state_since = last_activity_at WHERE id = ?', 'stale', row.id)
          store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id), store) })
        }
        for (const row of store.all('SELECT * FROM sessions WHERE origin = ? AND alive = 1 AND process_key IS NULL AND ? - last_activity_at >= ?', 'observed', at, 86_400_000)) {
          closeRequests(row.id, 'process_ended', at)
          store.run('UPDATE sessions SET state = ?, state_since = ?, alive = 0, activity = NULL, ended_at = ?, since_ts = ? WHERE id = ?', 'ended', row.state === 'ended' ? row.state_since : at, at, at, row.id)
          persistSessionSummary(store, store.get('SELECT * FROM sessions WHERE id = ?', row.id))
          store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id), store) })
        }
        store.appendEvent({ at, type: 'counts', data: projectCounts(store) })
      })
    },
    /**
     * Apply one non-hook signal to a session in one transaction: `pid_gone`, `lost`, `review`, from the session
     * actions `stop_requested` (row 50) and `relaunched` (`{ ptyId }`, row 46, only from `crashed`), and from deckd
     * `exit` (`{ code, signal, tail, history }`, tail base64 from `exits`; `session_scrollback` stores
     * `history.data` behind a header naming `history.cols` and `history.rows` when deckd sent one, else the
     * raw tail),
     * `screen_idle` (rows 21 and 30) and `output` (counted output, state-machines 1.10). `screen_idle` and
     * `output` append no event when they change nothing a client sees.
     */
    signal(sessionId, signal, at = now()) {
      return commit(() => {
        let row = store.get('SELECT * FROM sessions WHERE id = ?', sessionId)
        if (!row) return
        if (signal.type === 'screen_idle' || signal.type === 'output') {
          if (!applyScreenSignal(row, signal, at)) return
        } else if (signal.type === 'pid_gone' && row.origin === 'observed' && row.alive) {
          closeRequests(row.id, 'process_ended', at)
          const announced = ['clear', 'resume'].includes(row.end_reason)
          const state = announced ? JSON.parse(row.changed_files).length ? 'done' : 'ended' : 'crashed'
          store.run('UPDATE sessions SET state=?,state_since=?,alive=0,activity=NULL,crash_kind=?,ended_at=?,since_ts=? WHERE id=?', state, row.state === state ? row.state_since : at, announced ? null : 'lost', at, at, row.id)
        } else if (signal.type === 'exit' && row.alive) {
          row = refreshSessionChanges(store, row)
          closeRequests(row.id, 'process_ended', at)
          const exitSignal = signal.signal && signal.signal !== '0' ? String(signal.signal) : null
          // Row 8: a session still starting with no Claude session id never came up, so any exit is a crash.
          // A requested stop (row 42) still wins, so Stop on a session that never started ends it.
          const neverStarted = row.state === 'starting' && !row.claude_session_id
          const crashed = !row.user_stop_requested && (neverStarted || (signal.code !== 0 || exitSignal !== null) && !row.end_announced)
          const state = crashed ? 'crashed' : JSON.parse(row.changed_files).length ? 'done' : 'ended'
          store.run('UPDATE sessions SET state=?,state_since=?,alive=0,activity=NULL,ended_at=?,exit_code=?,exit_signal=?,crash_kind=?,since_ts=? WHERE id=?', state, state === row.state ? row.state_since : at, at, signal.code ?? null, exitSignal, crashed ? exitSignal ? 'signal' : 'exit' : null, at, row.id)
          let scrollback = null
          if (typeof signal.history?.data === 'string') {
            // deckd's serialized history (05-api 5.2), cut by whole leading lines like deckd's own cap, after
            // the header naming the size deckd serialized it at (06-storage `session_scrollback`).
            const size = historySize(signal.history)
            const header = size ? sizeHeader(size) : ''
            const text = capHistory(signal.history.data, SCROLLBACK_CAP - header.length)
            scrollback = { text: header + text, truncated: text !== signal.history.data }
          } else if (typeof signal.tail === 'string') {
            let bytes = Buffer.from(signal.tail, 'base64')
            const truncated = bytes.length > SCROLLBACK_CAP
            if (truncated) bytes = bytes.subarray(bytes.length - SCROLLBACK_CAP)
            scrollback = { text: bytes.toString('utf8'), truncated }
          }
          if (scrollback) store.run('INSERT INTO session_scrollback(session_id,captured_at,text,truncated) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET captured_at=excluded.captured_at,text=excluded.text,truncated=excluded.truncated', row.id, at, scrollback.text, scrollback.truncated ? 1 : 0)
        } else if (signal.type === 'lost' && row.origin !== 'observed' && row.alive) {
          // Reconciliation rule 5(c): deckd no longer knows the PTY and kept no exit record for it.
          row = refreshSessionChanges(store, row)
          closeRequests(row.id, 'process_ended', at)
          store.run('UPDATE sessions SET state=?,state_since=?,alive=0,activity=NULL,ended_at=?,exit_code=NULL,exit_signal=NULL,crash_kind=?,since_ts=? WHERE id=?', 'crashed', row.state === 'crashed' ? row.state_since : at, at, 'lost', at, row.id)
        } else if (signal.type === 'stop_requested' && row.alive) {
          // Row 50: the owner asked to stop it; the exit that follows ends it, never crashes it (row 42).
          store.run('UPDATE sessions SET user_stop_requested=1 WHERE id=?', row.id)
        } else if (signal.type === 'relaunched' && row.state === 'crashed' && typeof signal.ptyId === 'string') {
          // Row 46: deckd spawned a replacement process; the same deck session starts again on the new PTY.
          store.run("UPDATE sessions SET state='starting',state_since=?,since_ts=?,last_activity_at=MAX(last_activity_at,?),alive=1,pty_id=?,process_key=?,origin='launched',crash_kind=NULL,exit_code=NULL,exit_signal=NULL,ended_at=NULL,end_announced=0,end_reason=NULL,user_stop_requested=0,activity=NULL,subagents_active=0 WHERE id=?",
            at, at, at, signal.ptyId, signal.ptyId, row.id)
        } else if (signal.type === 'review' && row.state === 'done') {
          const baseline = captureReviewBaseline(workingRoot(row.cwd), row.review_baseline)
          if (!baseline && row.review_baseline) return
          store.run('UPDATE sessions SET state=?,reviewed_at=?,state_since=?,since_ts=?,changed_files=?,review_baseline=? WHERE id=?', row.alive ? 'reviewed' : 'ended', at, at, at, '[]', baseline ?? row.review_baseline, row.id)
        }
        persistSessionSummary(store, store.get('SELECT * FROM sessions WHERE id = ?', row.id))
        store.appendEvent({ at, type: 'session.upserted', entityId: row.id, data: sessionView(store.get('SELECT * FROM sessions WHERE id = ?', row.id), store) })
        store.appendEvent({ at, type: 'counts', data: projectCounts(store) })
      })
    }
  }
}
