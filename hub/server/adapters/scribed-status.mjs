import { status as scribedStatus } from './scribed.mjs'

/** Poll the M0 status client with injected clock, probe and lifecycle timers. */
export function createScribedStatus({ status = scribedStatus, socketPath, timeoutMs = 5000, now = Date.now, pollMs = 2000, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let current = { state: 'unknown', recording: false, checkedAt: null }
  let nextAt = 0
  let inFlight = null
  let running = false
  let timer = null
  let generation = 0
  const snapshot = () => ({ ...current })
  function poll(at = now()) {
    if (inFlight) return inFlight
    if (at < nextAt) return Promise.resolve(snapshot())
    nextAt = at + pollMs
    const revision = generation
    inFlight = (async () => {
      let value
      try {
        const result = await status({ socketPath, timeoutMs })
        if (result.type !== 'status' || typeof result.recording !== 'boolean') throw new TypeError('invalid scribed status')
        value = { state: 'ok', recording: result.recording, checkedAt: at }
      } catch { value = { state: 'down', recording: false, checkedAt: at } }
      if (revision === generation) {
        current = value
        onChange(snapshot())
      }
      return snapshot()
    })().finally(() => { inFlight = null })
    return inFlight
  }
  async function loop() {
    try { await poll() } finally {
      if (running) {
        timer = setTimer(() => { void loop() }, Math.max(0, nextAt - now()))
        timer?.unref?.()
      }
    }
  }
  return {
    poll,
    snapshot,
    isRecording: () => current.recording,
    start() {
      if (running) return inFlight ?? Promise.resolve(snapshot())
      running = true
      return loop()
    },
    stop() {
      running = false
      generation++
      if (timer !== null) clearTimer(timer)
      timer = null
    }
  }
}
