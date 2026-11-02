// A line-oriented reader for the few keys this needs. Not a YAML parser: it reads `on:`,
// `runs-on:`, `os:` lists and `run:` lines, and reports what it could not read rather than guessing.
// Reading is bounded: files over 256 KiB, lines over 4 KiB and files past the 64th are reported,
// not read.
//
// Nothing here prints. Paths and reasons come from the user's repository, so a caller that shows
// them on a terminal passes them through `printable` from `scripts/reviews.mjs`.
import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_WORKFLOW_BYTES = 256 * 1024

const WORKFLOW_DIR = ['.github', 'workflows']

// Strips a `#` comment that is outside quotes. A `#` only starts a comment at the line start or
// after whitespace, as in YAML, so `foo#bar` is kept.
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

// A line longer than this is not read: it becomes a blank line and is listed in `unread`.
export const MAX_LINE_CHARS = 4096

// Trimming uses trimEnd/trim, not a `/\s+$/` regex, which backtracks quadratically on a long
// whitespace run that does not end the line.
function lines(text, unread) {
  return text.split(/\r?\n/).map((raw, i) => {
    if (raw.length > MAX_LINE_CHARS) {
      unread.push({ line: i + 1, reason: 'longer than 4 KiB' })
      return { indent: 0, text: '' }
    }
    const content = stripComment(raw).trimEnd()
    return { indent: content.length - content.trimStart().length, text: content.trim() }
  })
}

function unquote(value) {
  const v = value.trim()
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1)
  return v
}

// A minimal flow-style reader: `{ a: x, b: [c, d] }`, `[a, b]` and scalars. Returns undefined
// when the text is not something it can read, so the caller can say so.
function parseFlow(text) {
  let i = 0
  const s = text
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }
  function scalar(stops) {
    ws()
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++]
      const start = i
      while (i < s.length && s[i] !== q) i++
      if (i >= s.length) throw new Error('unterminated quote')
      const out = s.slice(start, i)
      i++
      return out
    }
    const start = i
    while (i < s.length && !stops.includes(s[i])) i++
    return s.slice(start, i).trim()
  }
  function value(stops) {
    ws()
    if (s[i] === '{') return mapping()
    if (s[i] === '[') return sequence()
    const v = scalar(stops)
    return v === '' || v === '~' || v === 'null' ? null : v
  }
  function mapping() {
    i++
    const out = {}
    ws()
    if (s[i] === '}') { i++; return out }
    for (;;) {
      const key = scalar([':', ',', '}'])
      ws()
      if (s[i] === ':') { i++; out[key] = value([',', '}']) } else out[key] = null
      ws()
      if (s[i] === ',') { i++; continue }
      if (s[i] === '}') { i++; return out }
      throw new Error('bad mapping')
    }
  }
  function sequence() {
    i++
    const out = []
    ws()
    if (s[i] === ']') { i++; return out }
    for (;;) {
      out.push(value([',', ']']))
      ws()
      if (s[i] === ',') { i++; continue }
      if (s[i] === ']') { i++; return out }
      throw new Error('bad sequence')
    }
  }
  try {
    const out = value([])
    ws()
    return i === s.length ? out : undefined
  } catch {
    return undefined
  }
}

// The lines nested under the line at `index`: every following line indented deeper, blank lines
// included, up to the first content line at or above its indentation.
function childrenOf(ls, index) {
  const base = ls[index].indent
  const out = []
  for (let j = index + 1; j < ls.length; j++) {
    if (ls[j].text === '') continue
    if (ls[j].indent <= base) break
    out.push(ls[j])
  }
  return out
}

const KEY = /^(-\s+)?("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*:(?:\s+(.*)|$)/

function keyOf(line) {
  const m = KEY.exec(line.text)
  return m ? { key: unquote(m[2]), value: (m[3] ?? '').trim(), dash: Boolean(m[1]) } : null
}

// Reads a value that is either inline (flow or scalar) or a block of `- item` / `key:` lines.
// Returns { kind: 'map', map } | { kind: 'list', list } | { kind: 'scalar', value } |
// { kind: 'empty' } | undefined when it cannot be read.
function blockValue(inline, children) {
  if (inline !== '') {
    const v = parseFlow(inline)
    if (v === undefined) return undefined
    if (v === null) return { kind: 'empty' }
    if (Array.isArray(v)) return { kind: 'list', list: v }
    if (typeof v === 'object') return { kind: 'map', map: v }
    return { kind: 'scalar', value: v }
  }
  if (children.length === 0) return { kind: 'empty' }
  const indent = children[0].indent
  const direct = children.filter(c => c.indent === indent)
  if (direct.every(c => c.text.startsWith('- ') || c.text === '-')) {
    const list = []
    for (const c of direct) {
      const item = c.text.slice(1).trim()
      if (item === '') return undefined
      const v = parseFlow(item)
      if (v === undefined || (v !== null && typeof v === 'object')) return undefined
      list.push(v)
    }
    return { kind: 'list', list }
  }
  const map = {}
  for (let k = 0; k < children.length; k++) {
    const c = children[k]
    if (c.indent !== indent) continue
    const kv = keyOf(c)
    if (!kv || kv.dash) return undefined
    const rest = []
    for (let j = k + 1; j < children.length && children[j].indent > indent; j++) rest.push(children[j])
    map[kv.key] = { inline: kv.value, children: rest }
  }
  return { kind: 'map', map, block: true }
}

// Sample names of the branches a fleet run pushes: a run branch and a task branch.
export const FLEET_BRANCH_SAMPLES = ['run/ci-reliability', 'fleetmates/ci-reliability/T1']

// A GitHub branch-filter glob as a RegExp: `**` matches anything, `*` matches anything but `/`,
// `?` one character that is not `/`; every other character is literal.
function globRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') { out += '.*'; i++ }
    else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[\\^$.|+()[\]{}]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

// The rule: a `branches` filter covers fleet run branches when it matches at least one name in
// FLEET_BRANCH_SAMPLES. Patterns apply in order, as GitHub applies them: a match includes the
// name and a later `!pattern` match excludes it again. So `**`, `run/**` and `fleetmates/**`
// count, while `feat/*`, `master`, `release/*` and a bare `*` (no slash) do not.
function coversFleetBranches(patterns) {
  return FLEET_BRANCH_SAMPLES.some(name => {
    let included = false
    for (const p of patterns) {
      if (typeof p !== 'string' || p === '') continue
      if (p.startsWith('!')) { if (globRegExp(p.slice(1)).test(name)) included = false }
      else if (globRegExp(p).test(name)) included = true
    }
    return included
  })
}

// `push` value -> true | false | null (unreadable).
function pushCoversBranches(value) {
  if (value === undefined) return null
  if (value.kind === 'empty') return true
  if (value.kind !== 'map') return null
  const get = key => {
    if (!(key in value.map)) return undefined
    const entry = value.map[key]
    if (!value.block) return entry === null ? { kind: 'empty' } : Array.isArray(entry) ? { kind: 'list', list: entry } : typeof entry === 'object' ? { kind: 'map', map: entry } : { kind: 'scalar', value: entry }
    return blockValue(entry.inline, entry.children)
  }
  if ('branches' in value.map) {
    const branches = get('branches')
    if (branches === undefined || branches.kind === 'empty') return null
    const list = branches.kind === 'list' ? branches.list : branches.kind === 'scalar' ? [branches.value] : null
    if (!list) return null
    return coversFleetBranches(list)
  }
  // `branches-ignore` without `branches` runs on every other branch.
  if ('branches-ignore' in value.map) return true
  // A tag filter with no branch filter runs on tag pushes only.
  if ('tags' in value.map || 'tags-ignore' in value.map) return false
  return true
}

function readOn(ls) {
  const index = ls.findIndex(l => l.indent === 0 && /^("on"|'on'|on)\s*:/.test(l.text))
  if (index === -1) return null
  const kv = keyOf(ls[index])
  const value = blockValue(kv.value, childrenOf(ls, index))
  if (value === undefined) return null
  if (value.kind === 'scalar') return value.value === 'push'
  if (value.kind === 'list') return value.list.includes('push')
  if (value.kind !== 'map') return null
  if (!('push' in value.map)) return false
  const entry = value.map.push
  if (value.block) return pushCoversBranches(blockValue(entry.inline, entry.children))
  if (entry === null) return true
  return pushCoversBranches(Array.isArray(entry) ? undefined : typeof entry === 'object' ? { kind: 'map', map: entry } : undefined)
}

function osOf(label) {
  if (typeof label !== 'string' || label.includes('${{')) return null
  const l = label.toLowerCase()
  if (/ubuntu|linux/.test(l)) return 'linux'
  if (/macos|osx/.test(l)) return 'macos'
  if (/windows/.test(l)) return 'windows'
  return null
}

function readOses(ls) {
  const oses = new Set()
  for (let k = 0; k < ls.length; k++) {
    const kv = keyOf(ls[k])
    if (!kv || (kv.key !== 'runs-on' && kv.key !== 'os')) continue
    // A `- os: x` item is itself nested one level in from its dash.
    const value = blockValue(kv.value, childrenOf(ls, k))
    if (value === undefined) continue
    const labels = value.kind === 'list' ? value.list : value.kind === 'scalar' ? [value.value] : []
    for (const label of labels) {
      const os = osOf(label)
      if (os) oses.add(os)
    }
  }
  return oses
}

// `cli.mjs flaky` or `fleetmates flaky`, where the cli.mjs path may end in a closing quote, as in
// the spec's own `node "<root>/scripts/cli.mjs" flaky -- <command>`.
const FLAKY = /(?:^|[\s/"'])(?:cli\.mjs["']?|fleetmates)\s+flaky(?:\s|$)/

function readFlaky(ls) {
  return ls.some(l => FLAKY.test(l.text))
}

export function readWorkflowText(text) {
  const unread = []
  const ls = lines(text, unread)
  return { oses: readOses(ls), branchPushes: readOn(ls), usesFlaky: readFlaky(ls), unread }
}

// At most this many workflow files are read, in name order; the rest are listed in `skipped`.
export const MAX_WORKFLOW_FILES = 64

export async function readWorkflows(root) {
  const dir = join(root, ...WORKFLOW_DIR)
  let names
  try {
    if (!(await stat(dir)).isDirectory()) return { present: false, files: [], skipped: [] }
    names = await readdir(dir)
  } catch {
    return { present: false, files: [], skipped: [] }
  }
  const files = []
  const skipped = []
  const workflowNames = names.filter(n => /\.ya?ml$/i.test(n)).sort()
  for (const [index, name] of workflowNames.entries()) {
    const path = [...WORKFLOW_DIR, name].join('/')
    if (index >= MAX_WORKFLOW_FILES) { skipped.push({ path, reason: 'more than 64 workflow files' }); continue }
    let info
    try {
      info = await stat(join(dir, name))
    } catch (err) {
      skipped.push({ path, reason: `cannot stat: ${err.code ?? err.message}` })
      continue
    }
    if (!info.isFile()) { skipped.push({ path, reason: 'not a regular file' }); continue }
    if (info.size > MAX_WORKFLOW_BYTES) { skipped.push({ path, reason: `larger than 256 KiB (${info.size} bytes)` }); continue }
    let text
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch (err) {
      skipped.push({ path, reason: `cannot read: ${err.code ?? err.message}` })
      continue
    }
    files.push({ path, ...readWorkflowText(text) })
  }
  return { present: files.length + skipped.length > 0, files, skipped }
}

export function workflowSummary(read) {
  const oses = new Set()
  if (!read?.present) return { present: false, oses, branchPushes: false, usesFlaky: false }
  for (const f of read.files) for (const os of f.oses) oses.add(os)
  return {
    present: true,
    oses,
    branchPushes: read.files.some(f => f.branchPushes === true),
    usesFlaky: read.files.some(f => f.usesFlaky),
  }
}

const NODE_OS = { linux: 'linux', darwin: 'macos', win32: 'windows' }
const ALL_OSES = ['linux', 'macos', 'windows']

// The OSes a package.json `os` field allows, among the three CI can run; null when unrestricted.
function allowedOses(pkg) {
  const field = pkg?.os
  if (!Array.isArray(field) || field.length === 0) return null
  const positive = field.filter(v => typeof v === 'string' && !v.startsWith('!'))
  const negative = field.filter(v => typeof v === 'string' && v.startsWith('!')).map(v => NODE_OS[v.slice(1)]).filter(Boolean)
  if (positive.length > 0) return new Set(positive.map(v => NODE_OS[v]).filter(Boolean))
  return new Set(ALL_OSES.filter(os => !negative.includes(os)))
}

export function ciAdvice(summary, pkg) {
  if (!summary?.present) return []
  const out = []
  if (!summary.branchPushes) {
    out.push('no workflow runs on a push to any branch (only pull_request or a fixed branch list), so a pushed run branch gets no CI; add a push trigger with no branch filter or with branches: [\'**\']')
  }
  if (summary.oses.size === 1) {
    const [only] = summary.oses
    const allowed = allowedOses(pkg)
    if (!(allowed && allowed.size === 1 && allowed.has(only))) {
      out.push(`the CI matrix covers a single OS (${only}) and package.json has no os field restricting the package to it; add the other OSes to the matrix`)
    }
  }
  if (!summary.usesFlaky) {
    out.push('no workflow step runs the flaky detector; run the tests through `node "<fleetmates root>/scripts/cli.mjs" flaky -- <test command>` so a timing flake is reported instead of failing the job')
  }
  return out
}
