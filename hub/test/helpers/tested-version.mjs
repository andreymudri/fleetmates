import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The Claude Code version this deck is tested with: `fleetmatesDeck.testedClaudeCode`
 * in hub/package.json. Tests read the pin here instead of hardcoding it.
 * @returns {string}
 */
export function testedVersion () {
  const pkg = JSON.parse(readFileSync(path.join(hubDir, 'package.json'), 'utf8'))
  return pkg.fleetmatesDeck.testedClaudeCode
}

/**
 * The tested version with its patch number bumped by one, for tests that need a
 * Claude Code newer than the pin.
 * @returns {string}
 */
export function newerVersion () {
  const [major, minor, patch] = testedVersion().split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}
