const ranks = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'PermissionDenied', 'PostToolUseFailure', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd']
const rank = event => {
  const index = ranks.indexOf(event)
  return index < 0 ? 1 : index === 0 ? 0 : index + 1
}

function compare(a, b) {
  return a.hookTs - b.hookTs || rank(a.hook.hook_event_name) - rank(b.hook.hook_event_name)
}

/** Events that end a wait for the owner: once one is a session's latest, its buffer flushes early (TEST-O2). */
const ATTENTION = new Set(['Stop', 'PermissionRequest', 'Notification'])

/**
 * Hold each session's events briefly, then deliver them in hook-time order. A session whose latest event
 * (by hook time) is Stop, PermissionRequest or Notification flushes on the next turn of the event loop
 * instead of waiting out the window, so rows pushed in the same turn still arrive as one sorted batch.
 */
export function createReorderBuffer(onBatch, { windowMs = 250 } = {}) {
  const pending = new Map()
  const timers = new Map()
  const early = new Map()
  function schedule(sessionId, delay = windowMs) {
    timers.set(sessionId, setTimeout(() => flush(sessionId, true), delay))
  }
  function latestIsAttention(sessionId) {
    const rows = pending.get(sessionId)
    if (!rows?.length) return false
    const latest = rows.reduce((last, row) => compare(row, last) > 0 ? row : last)
    return ATTENTION.has(latest.hook.hook_event_name)
  }
  function flush(sessionId, fromTimer = false) {
    const rows = pending.get(sessionId)
    if (!rows?.length) return
    pending.delete(sessionId)
    clearTimeout(timers.get(sessionId))
    timers.delete(sessionId)
    clearImmediate(early.get(sessionId))
    early.delete(sessionId)
    try {
      onBatch(rows.sort(compare), fromTimer)
    } catch (error) {
      if (!fromTimer) throw error
      if (rows.length) {
        pending.set(sessionId, rows)
        schedule(sessionId, Math.max(windowMs, 100))
      }
    }
  }
  return {
    push(row) {
      const sessionId = row.hook.session_id
      if (!pending.has(sessionId)) {
        pending.set(sessionId, [])
        schedule(sessionId)
      }
      pending.get(sessionId).push(row)
      if (ATTENTION.has(row.hook.hook_event_name) && !early.has(sessionId)) {
        early.set(sessionId, setImmediate(() => {
          early.delete(sessionId)
          if (latestIsAttention(sessionId)) flush(sessionId, true)
        }))
      }
    },
    flushAll() { for (const sessionId of pending.keys()) flush(sessionId) },
    close() {
      for (const timer of timers.values()) clearTimeout(timer)
      for (const immediate of early.values()) clearImmediate(immediate)
      pending.clear()
      timers.clear()
      early.clear()
    }
  }
}
