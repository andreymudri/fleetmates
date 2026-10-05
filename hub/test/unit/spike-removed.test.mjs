// M2 Task 16: the M0 spike is gone and nothing points at it. The perf script
// runs the Focus echo harness, jsconfig no longer type-checks a spike folder,
// and no hub source imports a module from a spike path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const self = fileURLToPath(import.meta.url)

/**
 * Removes block and line comments so a comment that names a path does not
 * count as an import of it. Strings are kept; a `//` inside a quoted string or
 * a template is left alone.
 * @param {string} source
 * @returns {string}
 */
function stripComments (source) {
  let out = ''
  let i = 0
  /** @type {string | null} */
  let quote = null
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += next ?? ''; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2)
      i = end === -1 ? source.length : end
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Every .mjs, .js and .jsx file under `dir`, skipping node_modules.
 * @param {string} dir
 * @returns {string[]}
 */
function sources (dir) {
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(full))
    else if (/\.(mjs|js|jsx)$/.test(entry.name)) found.push(full)
  }
  return found
}

test('hub/spike no longer exists', () => {
  assert.equal(existsSync(path.join(hub, 'spike')), false)
})

test('the perf script runs test/perf/focus-echo.mjs, and that file exists', () => {
  const pkg = JSON.parse(readFileSync(path.join(hub, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.perf, 'node test/perf/focus-echo.mjs')
  assert.equal(existsSync(path.join(hub, 'test/perf/focus-echo.mjs')), true)
})

test('the M0 keystroke echo spec is gone: test/perf/keystroke-echo.spec.mjs does not exist', () => {
  assert.equal(existsSync(path.join(hub, 'test/perf/keystroke-echo.spec.mjs')), false)
})

test('jsconfig.json does not include spike', () => {
  const config = JSON.parse(readFileSync(path.join(hub, 'jsconfig.json'), 'utf8'))
  assert.equal(config.include.includes('spike'), false)
})

test('stripComments drops line and block comments and keeps strings', () => {
  const stripped = stripComments("// import 'spike/a'\n/* import('spike/b') */\nconst u = 'http://x' // c\n")
  assert.equal(stripped.includes('spike/'), false)
  assert.equal(stripped.includes("'http://x'"), true)
})

test('no hub source imports a module whose specifier contains spike/', () => {
  const imports = /\bimport\s*\(\s*(['"`])([^'"`]*)\1|\bimport\s+(?:[^'"`;]*?\s+from\s+)?(['"])([^'"]*)\3|\bexport\s+[^'"`;]*?\s+from\s+(['"])([^'"]*)\5/g
  /** @type {string[]} */
  const offenders = []
  for (const file of sources(hub)) {
    if (file === self) continue
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const match of code.matchAll(imports)) {
      const specifier = match[2] ?? match[4] ?? match[6]
      if (specifier.includes('spike/')) offenders.push(`${path.relative(hub, file)}: ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [])
})
