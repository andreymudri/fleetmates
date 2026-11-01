// A teammate that keeps re-running the same failing command is busy and stuck at once: its commits
// and file writes can be fresh, so liveness reads it as working. This reads the event ledger for
// that shape. Pure; the ledger's own trust limits apply (a teammate can write its own ledger).
export const DEFAULT_SPIN_FAILURES = 5

export function spinState(events, { now, windowMs, failures = DEFAULT_SPIN_FAILURES }) {
  if (!Number.isFinite(now) || !Number.isFinite(windowMs)) throw new Error('spinState requires a numeric clock and window')
  const counts = new Map()
  for (const e of events ?? []) {
    if (e?.kind !== 'command-run' || !e.fingerprint || !(e.at >= now - windowMs)) continue
    if (e.result === 'fail') counts.set(e.fingerprint, (counts.get(e.fingerprint) ?? 0) + 1)
    else if (e.result === 'pass') counts.set(e.fingerprint, 0)
  }
  let worst = null
  for (const [fingerprint, fails] of counts) {
    if (fails >= failures && (!worst || fails > worst.fails)) worst = { fingerprint, fails }
  }
  return worst ? { spinning: true, ...worst } : { spinning: false }
}
