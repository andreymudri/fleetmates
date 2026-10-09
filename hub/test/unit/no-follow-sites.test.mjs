// deck-platforms Task 11: win32 has no O_NOFOLLOW (fs.constants.O_NOFOLLOW is undefined there), so a
// raw `flags | constants.O_NOFOLLOW` open follows a symlink on Windows without saying so. Every
// no-follow open in the server, bin and deckd sources goes through openNoFollowSync or openNoFollow
// from hub/platform/index.mjs instead. The only raw uses left are in code that runs on one POSIX
// platform: hub/server/meetings/ (Linux only) and hub/bin/prepare-native.mjs (darwin only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Removes block and line comments, so a comment that names O_NOFOLLOW does not count as a use of
 * it. Strings are kept; a `//` inside a quoted string or a template is left alone.
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
 * Every .mjs file under `dir`, as a hub-relative path with forward slashes.
 * @param {string} dir absolute
 * @returns {string[]}
 */
function sources (dir) {
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(full))
    else if (entry.name.endsWith('.mjs')) found.push(path.relative(hub, full).split(path.sep).join('/'))
  }
  return found
}

const code = rel => stripComments(readFileSync(path.join(hub, rel), 'utf8'))

/** Raw O_NOFOLLOW is allowed only where the code runs on a single POSIX platform. */
const allowed = rel => rel.startsWith('server/meetings/') || rel === 'bin/prepare-native.mjs'

// The sites that used a raw O_NOFOLLOW open before Task 11.
const SITES = [
  'server/adapters/fleetmates.mjs',
  'server/approvals/extension-scan.mjs',
  'server/machines/session.mjs',
  'server/machines/request.mjs',
  'server/http/open.mjs',
  'server/research/output.mjs',
  'server/approvals/confirm-count.mjs',
  'server/adapters/git-diff.mjs',
  'bin/fleetmates-deck.mjs'
]

test('stripComments drops line and block comments and keeps strings', () => {
  const stripped = stripComments("// O_NOFOLLOW a\n/* O_NOFOLLOW b */\nconst u = 'http://x' // c\n")
  assert.equal(stripped.includes('O_NOFOLLOW'), false)
  assert.equal(stripped.includes("'http://x'"), true)
})

test('O_NOFOLLOW appears outside comments only in hub/server/meetings/ and hub/bin/prepare-native.mjs', () => {
  const files = ['server', 'bin', 'deckd'].flatMap(dir => sources(path.join(hub, dir)))
  assert.ok(files.length > 50, `scanned only ${files.length} files`)
  const offenders = files.filter(rel => !allowed(rel) && code(rel).includes('O_NOFOLLOW'))
  assert.deepEqual(offenders, [])
})

test('each former raw O_NOFOLLOW site opens through openNoFollowSync or openNoFollow from the platform module', () => {
  const missing = SITES.filter(rel => {
    const text = code(rel)
    return !/\bopenNoFollow(Sync)?\s*\(/.test(text) || !/from\s+['"][./]*platform\/index\.mjs['"]/.test(text)
  })
  assert.deepEqual(missing, [])
})
