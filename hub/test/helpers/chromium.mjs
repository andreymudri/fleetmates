import fs from 'node:fs'
import path from 'node:path'

// Test-only browser lookup. Imports only node: modules, so nothing under hub/ outside test/.

/**
 * The browser the e2e and perf tests drive: `CHROMIUM_PATH` when it is set and exists, else the first
 * existing well-known Chromium or Chrome path for Linux, macOS and Windows, else null. The Windows
 * candidates are built only from the `ProgramFiles`, `ProgramFiles(x86)` and `LOCALAPPDATA`
 * variables that are set.
 * @param {{ env?: Record<string, string | undefined>, exists?: (p: string) => boolean }} [opts]
 * @returns {string | null}
 */
export function findChromium ({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.CHROMIUM_PATH && exists(env.CHROMIUM_PATH)) return env.CHROMIUM_PATH
  const chrome = ['Google', 'Chrome', 'Application', 'chrome.exe']
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].filter(name => env[name]).map(name => path.win32.join(/** @type {string} */ (env[name]), ...chrome)),
  ]
  return candidates.find(p => exists(p)) ?? null
}
