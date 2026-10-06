import os from 'node:os'
import path from 'node:path'

/** Resolve setup paths from an isolated environment. */
export function setupPaths(env = process.env) {
  const home = env.HOME || os.homedir()
  const configRoot = env.XDG_CONFIG_HOME || path.join(home, '.config')
  const stateRoot = env.XDG_STATE_HOME || path.join(home, '.local/state')
  const dataRoot = env.XDG_DATA_HOME || path.join(home, '.local/share')
  const config = path.join(configRoot, 'fleetmates/deck')
  const state = path.join(stateRoot, 'fleetmates/deck')
  const share = path.join(dataRoot, 'fleetmates-deck')
  return {
    home, config, state, share,
    spool: path.join(state, 'spool'),
    logs: path.join(state, 'logs'),
    token: path.join(state, 'token'),
    hook: path.join(share, 'hook/deck-hook.mjs'),
    settings: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
    units: path.join(configRoot, 'systemd/user'),
    runtime: env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'fleetmates-deck') : null
  }
}
