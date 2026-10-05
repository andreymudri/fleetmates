// Screen signals the web server derives from deckd `screen` events (docs/deck/05-api.md 5.4): the debounced
// screen-idle signal of state-machines row 30 (SM-O6 default, docs/deck/spikes/m0.md 3.2) and counted output
// (state-machines 1.10).

/** How long a PTY's last screen must stay idle, with no busy screen after it, before idle fires. */
export const IDLE_AFTER_MS = 500

/**
 * Track screen-idle per PTY. A PTY fires `idle` once after two consecutive screens that parse idle, or after
 * IDLE_AFTER_MS during which its last screen parsed idle and no non-idle screen arrived. A non-idle screen
 * re-arms it. One idle reading alone waits because m0.md 3.2 measured idle readings mid-repaint.
 * @param {{ now?: () => number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [options]
 * @returns {{
 *   screen: (ptyId: string, idle: boolean) => void,
 *   onIdle: (fn: (event: { ptyId: string, at: number }) => void) => () => void,
 *   forget: (ptyId: string) => void,
 *   close: () => void
 * }}
 */
export function createIdleTracker({ now = Date.now, setTimeout: set = setTimeout, clearTimeout: clear = clearTimeout } = {}) {
  /** @type {Map<string, { streak: number, fired: boolean, timer: any }>} */
  const ptys = new Map()
  const listeners = new Set()
  const stop = entry => {
    if (entry.timer !== null) clear(entry.timer)
    entry.timer = null
  }
  const fire = (ptyId, entry) => {
    stop(entry)
    entry.fired = true
    const event = { ptyId, at: now() }
    for (const fn of [...listeners]) {
      try { fn(event) } catch {}
    }
  }
  return {
    /** Feed one parsed screen of a PTY. */
    screen(ptyId, idle) {
      let entry = ptys.get(ptyId)
      if (!entry) ptys.set(ptyId, entry = { streak: 0, fired: false, timer: null })
      if (!idle) {
        stop(entry)
        entry.streak = 0
        entry.fired = false
        return
      }
      if (entry.fired) return
      entry.streak++
      if (entry.streak >= 2) return fire(ptyId, entry)
      if (entry.timer === null) {
        entry.timer = set(() => {
          entry.timer = null
          if (!entry.fired && ptys.get(ptyId) === entry) fire(ptyId, entry)
        }, IDLE_AFTER_MS)
        entry.timer?.unref?.()
      }
    },
    /** Subscribe to idle firings; returns the unsubscribe function. */
    onIdle(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    /** Drop a PTY's state (it exited), cancelling its pending timer. */
    forget(ptyId) {
      const entry = ptys.get(ptyId)
      if (entry) stop(entry)
      ptys.delete(ptyId)
    },
    /** Cancel every pending timer and forget every PTY. */
    close() {
      for (const entry of ptys.values()) stop(entry)
      ptys.clear()
    }
  }
}

/**
 * Whether a screen change counts as activity (state-machines 1.10): some changed row lies outside the bottom
 * status region (spinner, token counter, input box), which Claude Code redraws while a tool runs.
 * @param {number[]} changedRows rows deckd reported as changed
 * @param {number[]} statusRows rows of the status region from `parseScreen`
 * @returns {boolean}
 */
export function isCountedOutput(changedRows, statusRows) {
  if (!Array.isArray(changedRows)) return false
  const status = new Set(statusRows)
  return changedRows.some(row => !status.has(row))
}
