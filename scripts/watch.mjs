// The watchdog's ladder, pure: given one liveness row and what the watchdog already did for that
// task, decide the next action. No repository access and no clock of its own, like liveness.mjs.
// The signals behind a row are forgeable by the teammate they describe, so nothing here is gate
// evidence; it only decides how hard to nudge.

export const WATCH_DEFAULTS = Object.freeze({
  enabled: true, resumes: 2, respawns: 1, staleMinutes: 20, intervalMinutes: 5,
})

export const ACTIONS = Object.freeze(['none', 'resume', 'respawn', 'orphan', 'unmeasured'])

export function emptyHistory() {
  return { resumes: 0, respawns: 0, lastActionAt: null, orphaned: false, notified: false, maxQuietMs: null, sampled: false }
}

function quietOf(row) {
  const ages = [row.tipAgeMs, row.touchAgeMs].filter((a) => Number.isFinite(a))
  return ages.length ? Math.min(...ages) : null
}

export function nextAction(row, history, config, now) {
  if (!Number.isFinite(now)) throw new Error(`nextAction requires a numeric clock, got ${JSON.stringify(now)}`)
  const h = { ...emptyHistory(), ...(history ?? {}) }
  // Longest quiet stretch seen so far (shorter of tip age and touch age), written to the copy only.
  if (row.state === 'working' || row.state === 'stalled' || row.state === 'spinning') {
    const quiet = quietOf(row)
    if (quiet != null) h.maxQuietMs = Math.max(h.maxQuietMs ?? 0, quiet)
  }
  const none = { action: 'none', attempt: 0, history: h }
  if (h.orphaned) return none
  if (row.state === 'unknown') {
    if (h.notified) return none
    return { action: 'unmeasured', attempt: 0, reason: row.unknownReason ?? null, history: { ...h, notified: true } }
  }
  if (row.state !== 'stalled' && row.state !== 'spinning') return none
  const why = row.state === 'spinning' ? { reason: 'spinning' } : {}
  // A teammate just nudged gets a full window to show progress, measured from the nudge.
  if (h.lastActionAt != null && now - h.lastActionAt < config.staleMinutes * 60 * 1000) return none
  if (h.resumes < config.resumes) {
    return { action: 'resume', attempt: h.resumes + 1, ...why, history: { ...h, resumes: h.resumes + 1, lastActionAt: now } }
  }
  if (h.respawns < config.respawns) {
    return { action: 'respawn', attempt: h.respawns + 1, ...why, history: { ...h, resumes: 0, respawns: h.respawns + 1, lastActionAt: now } }
  }
  return { action: 'orphan', attempt: 0, ...why, history: { ...h, orphaned: true, lastActionAt: now } }
}
