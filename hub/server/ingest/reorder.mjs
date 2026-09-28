const ranks = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'PermissionDenied', 'PostToolUseFailure', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd']
const rank = event => {
  const index = ranks.indexOf(event)
  return index < 0 ? 1 : index === 0 ? 0 : index + 1
}

function compare(a, b) {
  return a.hookTs - b.hookTs || rank(a.hook.hook_event_name) - rank(b.hook.hook_event_name)
}

/** Hold each session's events briefly, then deliver them in hook-time order. */
export function createReorderBuffer(onBatch, { windowMs = 250 } = {}) {
  const pending = new Map()
  const timers = new Map()
  function schedule(sessionId, delay = windowMs) {
    timers.set(sessionId, setTimeout(() => flush(sessionId, true), delay))
  }
  function flush(sessionId, fromTimer = false) {
    const rows = pending.get(sessionId)
    if (!rows?.length) return
    pending.delete(sessionId)
    clearTimeout(timers.get(sessionId))
    timers.delete(sessionId)
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
    },
    flushAll() { for (const sessionId of pending.keys()) flush(sessionId) },
    close() { for (const timer of timers.values()) clearTimeout(timer); pending.clear(); timers.clear() }
  }
}
