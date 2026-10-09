import os from 'node:os'
import path from 'node:path'
import { deckDir, endpoint, runtimeBase } from '../../platform/index.mjs'

/**
 * Resolve setup paths from an isolated environment for `platform`. linux and darwin use the XDG layout; win32 uses
 * %APPDATA% for config and %LOCALAPPDATA% for state and share (docs/deck/16-platforms.md section 7). An XDG variable
 * that is set wins on every platform. Paths are joined with the target platform's path module, not the host's.
 */
export function setupPaths(env = process.env, { platform = process.platform, uid = process.getuid?.() ?? null } = {}) {
  const win = platform === 'win32'
  const p = win ? path.win32 : path.posix
  const home = env.HOME || (win && env.USERPROFILE) || os.homedir()
  let config, state, share
  if (win) {
    const roaming = env.APPDATA || p.join(home, 'AppData', 'Roaming')
    const local = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local')
    config = env.XDG_CONFIG_HOME ? p.join(env.XDG_CONFIG_HOME, 'fleetmates', 'deck') : p.join(roaming, 'fleetmates', 'deck')
    state = env.XDG_STATE_HOME ? p.join(env.XDG_STATE_HOME, 'fleetmates', 'deck') : p.join(local, 'fleetmates', 'deck', 'state')
    share = env.XDG_DATA_HOME ? p.join(env.XDG_DATA_HOME, 'fleetmates-deck') : p.join(local, 'fleetmates', 'deck', 'share')
  } else {
    config = p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'fleetmates/deck')
    state = p.join(env.XDG_STATE_HOME || p.join(home, '.local/state'), 'fleetmates/deck')
    share = p.join(env.XDG_DATA_HOME || p.join(home, '.local/share'), 'fleetmates-deck')
  }
  // Where the service manager reads its definitions: systemd user units, LaunchAgents, or none (win32 autostart is a
  // registry value).
  const units = win ? null : platform === 'darwin' ? p.join(home, 'Library', 'LaunchAgents') : p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'systemd/user')
  const base = runtimeBase({ env, platform, uid, home })
  return {
    home, config, state, share,
    spool: p.join(state, 'spool'),
    logs: p.join(state, 'logs'),
    token: p.join(state, 'token'),
    hook: p.join(share, 'hook', 'deck-hook.mjs'),
    settings: p.join(env.CLAUDE_CONFIG_DIR || p.join(home, '.claude'), 'settings.json'),
    units,
    runtime: deckDir(base, { platform }),
    endpoints: { deckd: endpoint(base, 'deckd', { platform, uid }), hooks: endpoint(base, 'hooks', { platform, uid }) }
  }
}
