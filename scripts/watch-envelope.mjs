// The stale window learned per repository, like an envelope of how long a healthy teammate can go
// quiet here. Samples are the longest quiet stretch (no commit, no file write) of tasks that
// finished without the watchdog ever acting. The file holding them is under .fleetmates/ and so
// writable by teammates; the clamp bounds what a forged sample can buy.
export const ENVELOPE_MIN_SAMPLES = 5
export const ENVELOPE_MAX_SAMPLES = 50
export const ENVELOPE_FLOOR_MINUTES = 10
export const ENVELOPE_CAP_MINUTES = 60

export function learnedStaleMinutes(samplesMs, fallbackMinutes) {
  const s = (Array.isArray(samplesMs) ? samplesMs : []).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b)
  if (s.length < ENVELOPE_MIN_SAMPLES) return { minutes: fallbackMinutes, learned: false, samples: s.length }
  const p90 = s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]
  const minutes = Math.min(ENVELOPE_CAP_MINUTES, Math.max(ENVELOPE_FLOOR_MINUTES, Math.ceil((p90 * 1.5) / 60000)))
  return { minutes, learned: true, samples: s.length }
}

export function addSample(samplesMs, ms) {
  return [...(Array.isArray(samplesMs) ? samplesMs : []), ms].slice(-ENVELOPE_MAX_SAMPLES)
}
