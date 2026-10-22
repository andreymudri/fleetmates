import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Issue #56: on Windows a console child started without windowsHide opens a visible window, so
// every hub child process must go through platform/child.mjs. hook/deck-hook.mjs is not walked:
// init copies it alone, it may import only node: modules, and on win32 it never starts a child.
// platform/index.mjs keeps its node:-only import contract (platform.test.mjs); its two win32 calls
// pass windowsHide themselves, pinned by its creation-time and killTree tests.
const hub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOTS = ['bin', 'deckd', 'server', 'platform']
const ALLOWED = new Set(['platform/child.mjs', 'platform/index.mjs'])
const RAW = /\bfrom\s*['"](?:node:)?child_process['"]|\b(?:require|import)\s*\(\s*['"](?:node:)?child_process['"]\s*\)/

/** @param {string} dir @returns {string[]} */
function walk (dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full)
    return /\.(mjs|js)$/.test(entry.name) ? [full] : []
  })
}

/** Blank out comments, keeping newlines so line numbers still match, and leaving strings alone. */
function stripComments (source) {
  let out = ''
  for (let i = 0; i < source.length;) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else { out += c; i++ }
  }
  return out
}

test('stripComments blanks comments but keeps strings and line numbers', () => {
  const src = "a // import('node:child_process')\n/* from 'child_process' */ b\nconst s = '// kept'"
  const out = stripComments(src)
  assert.equal(out.split('\n').length, 3)
  assert.doesNotMatch(out, /child_process/)
  assert.match(out, /'\/\/ kept'/)
})

test('the RAW pattern catches every import form', () => {
  for (const line of [
    "import { spawn } from 'node:child_process'",
    'import cp from "child_process"',
    "const cp = require('child_process')",
    "const cp = await import('node:child_process')",
  ]) assert.match(line, RAW, line)
  assert.doesNotMatch("import { spawn } from '../platform/child.mjs'", RAW)
})

test('no hub production file imports child_process except platform/child.mjs', () => {
  const files = ROOTS.flatMap(root => walk(path.join(hub, root)))
  const rel = files.map(f => path.relative(hub, f).split(path.sep).join('/'))
  assert.ok(rel.includes('server/machines/session.mjs'), 'the walk must reach the session scan')
  assert.ok(files.length >= 20, `the walk found only ${files.length} files`)
  const offenders = []
  for (const [i, file] of files.entries()) {
    if (ALLOWED.has(rel[i])) continue
    stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, n) => {
      if (RAW.test(line)) offenders.push(`${rel[i]}:${n + 1}`)
    })
  }
  assert.deepEqual(offenders, [], 'import platform/child.mjs instead, so the child hides its window on Windows')
})
