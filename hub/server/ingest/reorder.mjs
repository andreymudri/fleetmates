const ranks = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'PermissionDenied', 'PostToolUseFailure', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd']

function compare(a, b) {
  return a.hookTs - b.hookTs || ranks.indexOf(a.hook.hook_event_name) - ranks.indexOf(b.hook.hook_event_name)
}

/** Hold each session's events briefly, then deliver them in hook-time order. */
export function createReorderBuffer(onBatch, { windowMs = 250 } = {}) {
  const pending = new Map()
  const timers = new Map()
  function flush(sessionId) {
    const rows = pending.get(sessionId)
    if (!rows?.length) return
    pending.delete(sessionId)
    clearTimeout(timers.get(sessionId))
    timers.delete(sessionId)
    onBatch(rows.sort(compare))
  }
  return {
    push(row) {
      const sessionId = row.hook.session_id
      if (!pending.has(sessionId)) {
        pending.set(sessionId, [])
        timers.set(sessionId, setTimeout(() => flush(sessionId), windowMs))
      }
      pending.get(sessionId).push(row)
    },
    flushAll() { for (const sessionId of pending.keys()) flush(sessionId) },
    close() { for (const timer of timers.values()) clearTimeout(timer); pending.clear(); timers.clear() }
  }
}
