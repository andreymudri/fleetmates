import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// The two modules whose job is the legacy spelling.
const EXEMPT_FILES = new Set(['scripts/names.mjs', 'scripts/migrate.mjs'])

const LEGACY_SPELLINGS = [
  /claude-teammates/,
  /teammates\.(gate|local)\.(json|yaml)/,
  /(^|[^\w.-])\.teammates(?![\w-])/,
  /refs\/teammates\//,
  /(^|[`'"/\s(])teammates\/(\$\{|<|[\w-]+\/)/,
  /teammates-map/,
  /using-teammates|teammates-config/,
  /CLAUDE_TEAMMATES_/,
  /teammates-\$\{/,
]

// Comments go first, because the comment that explains a name is otherwise the use this test
// counts. JS: whole-line `//` and `*` lines, and a trailing ` // …` preceded by whitespace (so
// `https://` survives). Bash: whole-line `#`. A `legacy-name:begin` … `legacy-name:end` block is
// the sanctioned dual-read (the update-check opt-out and the old-plugin warning) and is skipped.
function codeLines(file, text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  let skipping = false
  for (const [i, raw] of lines.entries()) {
    if (/legacy-name:begin/.test(raw)) { skipping = true; continue }
    if (/legacy-name:end/.test(raw)) { skipping = false; continue }
    if (skipping) continue
    const trimmed = raw.trim()
    if (trimmed === '') continue
    if (file.endsWith('.mjs') || file.endsWith('.js')) {
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      kept.push([i + 1, raw.replace(/\s\/\/\s.*$/, '')])
    } else {
      if (trimmed.startsWith('#')) continue
      kept.push([i + 1, raw])
    }
  }
  return kept
}

// Recursive, because the scan's whole point is to catch a legacy spelling wherever one lives —
// a flat, one-level `readdirSync` stopped being sound the moment a task (T5, `scripts/harnesses/`)
// introduced the first subdirectory under `scripts/`: it threw `EISDIR` trying to `readFileSync`
// the directory itself, and would otherwise have left everything under it unscanned rather than
// failing loudly. `relDir` is built with a literal `/`, never `path.join`, so the relative paths
// this returns match `EXEMPT_FILES` and the git-style forward-slash paths the rest of the plugin
// uses, on every platform.
function walk(absDir, relDir) {
  const found = []
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...walk(path.join(absDir, entry.name), rel))
    } else if (entry.isFile()) {
      found.push(rel)
    }
  }
  return found
}

function sources() {
  const found = []
  for (const dir of ['scripts', 'hooks']) {
    for (const rel of walk(path.join(root, dir), dir)) {
      if (!EXEMPT_FILES.has(rel)) found.push(rel)
    }
  }
  return found
}

test('no legacy spelling is used as a name outside names.mjs and migrate.mjs', () => {
  const hits = []
  for (const rel of sources()) {
    const text = readFileSync(path.join(root, rel), 'utf8')
    for (const [line, code] of codeLines(rel, text)) {
      if (LEGACY_SPELLINGS.some((re) => re.test(code))) hits.push(`${rel}:${line}: ${code.trim()}`)
    }
  }
  assert.deepEqual(hits, [])
})

test('the scan would catch a legacy spelling, so the empty result above means something', () => {
  const planted = codeLines('scripts/x.mjs', "const dir = '.teammates'\n// '.teammates' in a comment\n")
  assert.equal(planted.length, 1)
  assert.ok(LEGACY_SPELLINGS.some((re) => re.test(planted[0][1])))
})
