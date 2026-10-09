import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { openUrlArgv } from '../../platform/index.mjs'

/** Run a short query command and return its exit status and stdout. */
async function queryCommand(file, argv, env) {
  const result = spawnSync(file, argv, { encoding: 'utf8', env, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' }
}

/**
 * Start a launcher detached. A launcher that exits within `grace` ms reports its exit code; one
 * still running then (a browser started directly from $BROWSER) counts as started and is left alone.
 */
function startCommand(file, argv, env, extra = {}, grace = 1500) {
  return new Promise(resolve => {
    let child
    try { child = spawn(file, argv, { env, detached: true, stdio: 'ignore', windowsHide: true, ...extra }) } catch { resolve(false); return }
    const timer = setTimeout(() => { child.removeAllListeners(); child.unref(); resolve(true) }, grace)
    child.once('error', () => { clearTimeout(timer); resolve(false) })
    child.once('exit', code => { clearTimeout(timer); resolve(code === 0) })
  })
}

/** Find a desktop entry by id in $XDG_DATA_HOME and $XDG_DATA_DIRS, as `gio launch` needs a path. */
function desktopFile(id, env) {
  const dirs = [env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local/share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')]
  for (const dir of dirs.filter(Boolean)) {
    const candidate = path.join(dir, 'applications', id)
    try { if (fs.statSync(candidate).isFile()) return candidate } catch {}
  }
  return null
}

/**
 * Open a local file in the user's web browser, not in whatever handles text/html (often an editor).
 * Order: each command in $BROWSER (colon separated, `%s` replaced by the file, else appended), then
 * the `xdg-settings get default-web-browser` entry through `gtk-launch` and then `gio launch`, then
 * `xdg-open`. Only the file path is ever passed, so a token inside the file never reaches argv.
 * That order is linux's. On darwin the file is opened with `open`, and on win32 with `cmd.exe /d /s /c start`
 * (openUrlArgv, the file quoted by quoteCmdArg, verbatim arguments and no window); $BROWSER is not read there.
 * `query` and `start` are injectable spawners.
 * @returns {Promise<boolean>} whether some launcher reported success
 */
export async function openInBrowser(file, { env = process.env, query = queryCommand, start = startCommand, platform = process.platform } = {}) {
  if (platform === 'darwin' || platform === 'win32') {
    const [command, ...argv] = openUrlArgv(file, { platform })
    return platform === 'win32' ? start(command, argv, env, { windowsVerbatimArguments: true, windowsHide: true }) : start(command, argv, env)
  }
  for (const entry of (env.BROWSER || '').split(':')) {
    const words = entry.trim().split(/\s+/).filter(Boolean)
    if (!words.length) continue
    const argv = words.slice(1).map(word => word.replaceAll('%s', file))
    if (!words.slice(1).some(word => word.includes('%s'))) argv.push(file)
    if (await start(words[0], argv, env)) return true
  }
  const clean = { ...env }
  delete clean.BROWSER
  const answer = await query('xdg-settings', ['get', 'default-web-browser'], clean)
  const id = answer.status === 0 ? answer.stdout.trim() : ''
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.desktop$/.test(id)) {
    if (await start('gtk-launch', [id, file], env)) return true
    const entry = desktopFile(id, env)
    if (entry && await start('gio', ['launch', entry, file], env)) return true
  }
  return start('xdg-open', [file], env)
}
