import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const templateDir = fileURLToPath(new URL('../../systemd/', import.meta.url))
export const UNIT_NAMES = ['fleetmates-deckd.service', 'fleetmates-deck.service']

/** Render the shipped unit with absolute executable and hub paths. */
export function renderUnit(name, nodePath, hubPath) {
  if (!UNIT_NAMES.includes(name)) throw new Error(`unknown unit: ${name}`)
  if (/\s/.test(nodePath) || /\s/.test(hubPath)) throw new Error('unit paths cannot contain whitespace')
  return fs.readFileSync(path.join(templateDir, name), 'utf8').replaceAll('@NODE@', nodePath).replaceAll('@HUB@', hubPath)
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
