// The shared input machine for one PTY (docs/deck/interaction/state-machines.md section 3): last keystroke
// wins, with an indicator. It is fed deckd `input` events (who typed) and `client` events (terminal clients
// attaching and detaching) and never sees the bytes themselves.

/** No input for this long makes an active PTY `quiet`. */
export const INPUT_QUIET_MS = 2000
/** Bytes from the other source within this long of the current source's last byte are a collision. */
export const COLLISION_WINDOW_MS = 1500
/** How long the collision chip is held before the machine settles. */
export const COLLISION_HOLD_MS = 3000

/**
 * @typedef {'quiet' | 'terminal_active' | 'browser_active' | 'collision'} InputState
 * @typedef {{ state: InputState, from: 'terminal' | 'browser' | null, name: string | null, detached: boolean }} InputView
 */

/**
 * Create the input machine for one PTY. `emit` is called with the new view after every change of state,
 * source or `detached`.
 * @param {{ now?: () => number, setTimeout?: Function, clearTimeout?: Function, emit: (view: InputView) => void,
 *   from?: 'terminal' | 'browser' | null, name?: string | null }} options `from` and `name` seed who typed last
 * @returns {{ input: (source: { kind?: string, name?: string } | null | undefined) => void,
 *   client: (change: string, client: { kind?: string } | null | undefined) => void,
 *   terminals: (count: number) => void, view: () => InputView, close: () => void }}
 */
export function createInputMachine({ now = Date.now, setTimeout: arm = setTimeout, clearTimeout: disarm = clearTimeout, emit, from = null, name = null }) {
  /** @type {InputView} */
  let view = { state: 'quiet', from, name, detached: false }
  const last = { terminal: -Infinity, browser: -Infinity }
  let terminalClients = 0
  let quietTimer = null
  let holdTimer = null
  let latestAt = -Infinity

  function set(next) {
    const merged = { ...view, ...next }
    if (merged.state === view.state && merged.from === view.from && merged.name === view.name && merged.detached === view.detached) return
    view = merged
    emit({ ...view })
  }
  function settle() {
    holdTimer = null
    set({ state: now() - latestAt < INPUT_QUIET_MS ? `${view.from}_active` : 'quiet' })
  }
  function quiet() {
    quietTimer = null
    if (view.state !== 'collision') set({ state: 'quiet' })
  }

  return {
    input(source) {
      const kind = source?.kind === 'terminal' ? 'terminal' : 'browser'
      const label = kind === 'terminal' && typeof source?.name === 'string' ? source.name : null
      const at = now()
      const other = kind === 'terminal' ? 'browser' : 'terminal'
      const crossing = view.state !== 'quiet' && view.from === other && at - last[other] < COLLISION_WINDOW_MS
      last[kind] = at
      latestAt = at
      if (quietTimer) disarm(quietTimer)
      quietTimer = arm(quiet, INPUT_QUIET_MS)
      if (crossing) {
        if (holdTimer) disarm(holdTimer)
        holdTimer = arm(settle, COLLISION_HOLD_MS)
        set({ state: 'collision', from: kind, name: label })
      } else set({ state: view.state === 'collision' ? 'collision' : `${kind}_active`, from: kind, name: label })
    },
    client(change, client) {
      if (client?.kind !== 'terminal') return
      if (change === 'attached') terminalClients++
      else if (change === 'detached') terminalClients = Math.max(0, terminalClients - 1)
      else return
      set({ detached: change === 'detached' && terminalClients === 0 })
    },
    terminals(count) { terminalClients = Math.max(0, Math.trunc(count) || 0) },
    view: () => ({ ...view }),
    close() {
      if (quietTimer) disarm(quietTimer)
      if (holdTimer) disarm(holdTimer)
      quietTimer = holdTimer = null
    }
  }
}
