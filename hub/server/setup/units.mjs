import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const templateDir = fileURLToPath(new URL('../../systemd/', import.meta.url))
export const UNIT_NAMES = ['fleetmates-deckd.service', 'fleetmates-deck.service']

function execArg(value) {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('unit path must be absolute and one line')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`
}

function conditionPath(value) {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('unit path must be absolute and one line')
  return value.replaceAll('%', '%%')
}

/** Render the shipped unit with absolute executable and hub paths. */
export function renderUnit(name, nodePath, hubPath) {
  if (!UNIT_NAMES.includes(name)) throw new Error(`unknown unit: ${name}`)
  const entry = name === 'fleetmates-deckd.service' ? 'deckd/main.mjs' : 'server/main.mjs'
  const entryPath = path.join(hubPath, entry)
  return fs.readFileSync(path.join(templateDir, name), 'utf8').replaceAll('@NODE@', execArg(nodePath)).replaceAll('@ENTRY@', execArg(entryPath)).replaceAll('@ENTRY_PATH@', conditionPath(entryPath))
}

/** Write a unit when its rendered content differs. */
export function writeUnit(file, content) {
  try { if (fs.readFileSync(file, 'utf8') === content) return false } catch (error) { if (error.code !== 'ENOENT') throw error }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temp, content, { mode: 0o644 })
    fs.renameSync(temp, file)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  return true
}

/** launchd labels for the two services; the plist file is `<label>.plist` in `~/Library/LaunchAgents`. */
export const LAUNCHD_LABELS = Object.freeze({ deckd: 'io.fleetmates.deck.deckd', web: 'io.fleetmates.deck.web' })

function plistString(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('plist value must be one line')
  return `<string>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')}</string>`
}

/**
 * Render a LaunchAgent plist that runs `nodePath entry`, restarts it after a failed exit, and writes stdout and
 * stderr to `<logsDir>/<name>.out.log` and `.err.log`, where `<name>` is the last dot-separated part of the label.
 */
export function renderPlist(label, nodePath, entry, logsDir) {
  for (const value of [nodePath, entry, logsDir]) if (!path.posix.isAbsolute(value)) throw new Error('plist path must be absolute')
  const name = label.split('.').at(-1)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${plistString(label)}
  <key>ProgramArguments</key>
  <array>
    ${plistString(nodePath)}
    ${plistString(entry)}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  ${plistString(path.posix.join(logsDir, `${name}.out.log`))}
  <key>StandardErrorPath</key>
  ${plistString(path.posix.join(logsDir, `${name}.err.log`))}
</dict>
</plist>
`
}
