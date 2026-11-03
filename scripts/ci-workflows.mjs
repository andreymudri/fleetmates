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
      return { indent: 0, text: '', raw: '' }
    }
    const content = stripComment(raw).trimEnd()
    return { indent: content.length - content.trimStart().length, text: content.trim(), raw }
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

// Whether the workflow runs on a branch push or a pull request at all: the CI a local mirror
// stands in for. A tag-only push, a release or a manual dispatch is not.
function readTriggered(ls) {
  const index = ls.findIndex(l => l.indent === 0 && /^("on"|'on'|on)\s*:/.test(l.text))
  if (index === -1) return false
  const kv = keyOf(ls[index])
  const value = blockValue(kv.value, childrenOf(ls, index))
  if (value === undefined) return false
  const events = value.kind === 'scalar' ? [value.value] : value.kind === 'list' ? value.list : value.kind === 'map' ? Object.keys(value.map) : []
  if (events.includes('pull_request')) return true
  return readOn(ls) === true
}

// The indices of the lines nested under ls[index] (see childrenOf), blank lines left out.
function childIndices(ls, index, base = ls[index].indent) {
  const out = []
  for (let j = index + 1; j < ls.length; j++) {
    if (ls[j].text === '') continue
    if (ls[j].indent <= base) break
    out.push(j)
  }
  return out
}

// The `key: value` entries among `indices` at their shallowest indentation, in order, each with the
// indices nested under it. `col` overrides that indentation, for the keys of a `- ` list item.
function entriesAt(ls, indices, col) {
  if (indices.length === 0) return []
  const at = col ?? Math.min(...indices.map(i => ls[i].indent))
  const out = []
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]
    if (ls[i].indent !== at) continue
    const kv = keyOf(ls[i])
    if (!kv || kv.dash) continue
    const nested = []
    for (let j = k + 1; j < indices.length && ls[indices[j]].indent > at; j++) nested.push(indices[j])
    out.push({ key: kv.key, value: kv.value, nested })
  }
  return out
}

// A scalar value: inline (quotes removed) or a `|` / `>` block scalar read from the raw lines, so a
// `#` in a script is kept. Folded (`>`) joins lines with spaces, as YAML does for plain lines.
function scalarOf(ls, entry) {
  const v = entry.value
  if (/^[|>][+-]?$/.test(v)) {
    if (entry.nested.length === 0) return ''
    const first = entry.nested[0]
    const last = entry.nested[entry.nested.length - 1]
    const indent = ls[first].raw.length - ls[first].raw.trimStart().length
    const body = []
    for (let j = first; j <= last; j++) body.push(ls[j].raw.slice(Math.min(indent, ls[j].raw.length - ls[j].raw.trimStart().length)))
    return v[0] === '|' ? `${body.join('\n')}\n` : `${body.join(' ')}\n`
  }
  return unquote(v)
}

// A map of scalars (`env:` and the like), or null when an entry is not a scalar.
function scalarMap(ls, entry) {
  if (entry.value !== '') {
    const v = parseFlow(entry.value)
    if (v === null) return {}
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const out = {}
    for (const [k, x] of Object.entries(v)) { if (x !== null && typeof x === 'object') return null; out[k] = x ?? '' }
    return out
  }
  const out = {}
  for (const e of entriesAt(ls, entry.nested)) out[e.key] = scalarOf(ls, e)
  return out
}

// The `- ` items of a block list under `entry`, each as the entries of its own keys.
function listItems(ls, entry) {
  const items = []
  if (entry.nested.length === 0) return items
  const dashCol = Math.min(...entry.nested.map(i => ls[i].indent))
  const starts = entry.nested.filter(i => ls[i].indent === dashCol && ls[i].text.startsWith('-'))
  for (const [n, start] of starts.entries()) {
    const end = starts[n + 1] ?? Infinity
    const rest = entry.nested.filter(i => i > start && i < end)
    const after = ls[start].text.replace(/^-\s*/, '')
    const col = ls[start].indent + (ls[start].text.length - after.length)
    const own = []
    if (after !== '') {
      const kv = keyOf({ text: after, indent: col })
      // The dash line's own key holds the deeper lines up to the item's next key.
      const nextKey = rest.findIndex(i => ls[i].indent <= col)
      if (kv) own.push({ key: kv.key, value: kv.value, nested: nextKey === -1 ? rest : rest.slice(0, nextKey) })
    }
    items.push([...own, ...entriesAt(ls, rest, col)])
  }
  return items
}

const get = (entries, key) => entries.find(e => e.key === key)

// The jobs of a workflow, each with what a local run needs: the runner labels it can run on (its
// `runs-on`, or the `os` list of its matrix when `runs-on` names `matrix.os`), its env, `if`,
// default shell and working directory, and its steps. A job or step this cannot read is reported
// with a reason instead of guessed.
function readJobs(ls) {
  const index = ls.findIndex(l => l.indent === 0 && /^jobs\s*:/.test(l.text))
  const top = entriesAt(ls, ls.map((l, i) => i).filter(i => ls[i].text !== ''), 0)
  const envEntry = get(top, 'env')
  const env = envEntry ? scalarMap(ls, envEntry) : {}
  if (index === -1) return { env, jobs: [] }
  const jobs = []
  for (const job of entriesAt(ls, childIndices(ls, index))) {
    const keys = entriesAt(ls, job.nested)
    const out = { id: job.key, labels: [], env: {}, if: null, shell: null, workingDirectory: null, steps: [], unreadable: null }
    const runsOn = get(keys, 'runs-on')
    const runsOnValue = runsOn ? (runsOn.value !== '' ? parseFlow(runsOn.value) : blockValue('', runsOn.nested.map(i => ls[i]))?.list) : undefined
    let labels = runsOnValue === undefined || runsOnValue === null ? [] : Array.isArray(runsOnValue) ? runsOnValue : [runsOnValue]
    if (labels.some(l => typeof l === 'string' && /^\$\{\{\s*matrix\.os\s*\}\}$/.test(l))) {
      const matrix = get(entriesAt(ls, get(keys, 'strategy')?.nested ?? []), 'matrix')
      const os = matrix && get(entriesAt(ls, matrix.nested), 'os')
      const list = os ? (os.value !== '' ? parseFlow(os.value) : blockValue('', os.nested.map(i => ls[i]))?.list) : undefined
      labels = Array.isArray(list) ? list.map(l => ({ label: l, matrixOs: l })) : []
      if (labels.length === 0) out.unreadable = 'runs-on names matrix.os and its matrix has no readable os list'
    } else {
      labels = labels.map(l => ({ label: l, matrixOs: null }))
    }
    out.labels = labels
    const jobEnv = get(keys, 'env')
    if (jobEnv) { const m = scalarMap(ls, jobEnv); if (m === null) out.unreadable ??= 'its env is not a map of values'; else out.env = m }
    const cond = get(keys, 'if')
    if (cond) out.if = scalarOf(ls, cond)
    const defaults = get(keys, 'defaults')
    const run = defaults && get(entriesAt(ls, defaults.nested), 'run')
    if (run) {
      const r = entriesAt(ls, run.nested)
      if (get(r, 'shell')) out.shell = scalarOf(ls, get(r, 'shell'))
      if (get(r, 'working-directory')) out.workingDirectory = scalarOf(ls, get(r, 'working-directory'))
    }
    const steps = get(keys, 'steps')
    if (get(keys, 'uses')) out.unreadable ??= 'it calls a reusable workflow'
    else if (!steps) out.unreadable ??= 'it has no steps'
    else {
      for (const item of listItems(ls, steps)) {
        const step = { name: null, run: null, uses: null, shell: null, workingDirectory: null, env: {}, if: null, unreadable: null }
        for (const e of item) {
          if (e.key === 'name') step.name = scalarOf(ls, e)
          else if (e.key === 'run') step.run = scalarOf(ls, e)
          else if (e.key === 'uses') step.uses = scalarOf(ls, e)
          else if (e.key === 'shell') step.shell = scalarOf(ls, e)
          else if (e.key === 'working-directory') step.workingDirectory = scalarOf(ls, e)
          else if (e.key === 'if') step.if = scalarOf(ls, e)
          else if (e.key === 'env') { const m = scalarMap(ls, e); if (m === null) step.unreadable = 'its env is not a map of values'; else step.env = m }
        }
        out.steps.push(step)
      }
    }
    jobs.push(out)
  }
  return { env: env ?? {}, jobs }
}

export function readWorkflowText(text) {
  const unread = []
  const ls = lines(text, unread)
  return { oses: readOses(ls), branchPushes: readOn(ls), usesFlaky: readFlaky(ls), triggered: readTriggered(ls), ...readJobs(ls), unread }
}

// The OS a runner label names, or null: `ubuntu-latest` is linux, `macos-14` macos, and so on.
export { osOf as runnerOs }

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
