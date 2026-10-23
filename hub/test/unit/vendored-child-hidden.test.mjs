import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closure } from '../../bin/vendor-fleetmates.mjs'

// The deck server runs the vendored fleetmates modules inside its console-less service, so on
// Windows any of their children started without windowsHide opens a visible window (issue #56).
const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts')
const CALL = /\b(spawn|spawnSync|execFile|execFileSync)\s*\(/g

/** The source text from `start` to the matching close paren of the call. */
function callText(source, start) {
  let depth = 0
  for (let i = source.indexOf('(', start); i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) return source.slice(start, i + 1)
  }
  return source.slice(start)
}

test('every child the vendored fleetmates modules start sets windowsHide', () => {
  const offenders = []
  for (const [name, source] of closure(scripts)) {
    for (const match of source.matchAll(CALL)) {
      const line = source.slice(0, match.index).split('\n').length
      if (source.slice(source.lastIndexOf('\n', match.index) + 1, match.index).trimStart().startsWith('//')) continue
      if (!/\bwindowsHide\s*:\s*true\b/.test(callText(source, match.index))) offenders.push(`${name}:${line}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('the call scan sees a spawn without windowsHide', () => {
  const source = "const child = spawn('git', args, { cwd })\n"
  assert.equal(/\bwindowsHide\s*:\s*true\b/.test(callText(source, source.search(CALL))), false)
})
