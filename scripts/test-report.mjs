// The test inventory: a JUnit report reduced to what the gate compares — per unit (a test file, or
// the classname when the runner names no file), per test ID, how many times it ran and how many
// times it was skipped. See docs/specs/2026-09-26-test-inventory-design.md.
//
// The report is written by a process running teammate code, so everything read here is
// agent-written: refusals quote a bounded, `printable` excerpt, and the parser expands no entity
// beyond the five predefined ones and numeric references — a DOCTYPE is refused outright rather
// than half-understood.
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { printable } from './reviews.mjs'

export const MAX_REPORT_BYTES = 50 * 1024 * 1024
const EXCERPT = 200

export class ReportParseError extends Error {}

function refuse(reason, excerpt = '') {
  const shown = excerpt === '' ? '' : `: ${printable(String(excerpt).slice(0, EXCERPT))}`
  throw new ReportParseError(`test report ${reason}${shown}`)
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : whole
  })
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function attributes(source) {
  const attrs = {}
  for (const m of source.matchAll(ATTR)) attrs[m[1]] = decode(m[2] ?? m[3] ?? '')
  return attrs
}

// Elements only: text content is irrelevant to an inventory (a `<skipped>` counts by existing, not
// by what it says), so text, comments, CDATA and processing instructions are stepped over.
function* elements(xml) {
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) return
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      if (end === -1) refuse('has an unterminated comment')
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      if (end === -1) refuse('has an unterminated CDATA section')
      i = end + 3
      continue
    }
    if (xml.startsWith('<!', lt)) refuse('declares a DOCTYPE or entity, which a test report never needs', xml.slice(lt, lt + 60))
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      if (end === -1) refuse('has an unterminated processing instruction')
      i = end + 2
      continue
    }
    // A `>` inside a quoted attribute value is legal XML, so the tag's end is found by skipping
    // quoted runs rather than by the first `>`.
    let j = lt + 1
    let quote = null
    for (; j < xml.length; j += 1) {
      const c = xml[j]
      if (quote) { if (c === quote) quote = null } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    if (j >= xml.length) refuse('has an unterminated tag', xml.slice(lt, lt + 60))
    const body = xml.slice(lt + 1, j)
    i = j + 1
    if (body[0] === '/') { yield { close: body.slice(1).trim() }; continue }
    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const name = inner.match(/^[^\s/>]+/)?.[0]
    if (!name) refuse('has a tag with no name', xml.slice(lt, lt + 60))
    yield { open: name, attrs: attributes(inner.slice(name.length)), selfClosing }
  }
}

// `file` made relative to the directory the suite ran in: `node --test` writes absolute paths
// (measured), and the baseline and the preview run in different directories, so an absolute path
// would make every test of one look absent from the other.
function unitOf(attrs, root) {
  if (typeof attrs.file === 'string' && attrs.file !== '') {
    const file = attrs.file.replaceAll('\\', '/')
    if (!path.posix.isAbsolute(file) && !/^[A-Za-z]:\//.test(file)) return path.posix.normalize(file)
    // Several spellings of one root are accepted: a runner may report the real path of a
    // directory the gate names through a symlink (a temp dir on macOS is one).
    const roots = (Array.isArray(root) ? root : [root]).map((r) => String(r ?? '').replaceAll('\\', '/').replace(/\/+$/, '')).filter((r) => r !== '')
    for (const r of roots) {
      if (file.startsWith(`${r}/`)) return path.posix.normalize(file.slice(r.length + 1))
    }
    refuse(`names a file outside the tree it ran in (${printable(roots[0] ?? '')})`, file)
  }
  if (typeof attrs.classname === 'string' && attrs.classname !== '') return attrs.classname
  return null
}

function count(units, unit, id, skipped) {
  if (!units.has(unit)) units.set(unit, new Map())
  const ids = units.get(unit)
  const entry = ids.get(id) ?? { ran: 0, skipped: 0 }
  if (skipped) entry.skipped += 1
  else entry.ran += 1
  ids.set(id, entry)
}

export function parseJunit(xml, { root } = {}, units = new Map()) {
  if (typeof xml !== 'string') refuse('is not text')
  if (Buffer.byteLength(xml, 'utf8') > MAX_REPORT_BYTES) refuse(`is larger than ${MAX_REPORT_BYTES} bytes`)
  const suites = []
  let sawRoot = false
  let testcase = null
  for (const el of elements(xml)) {
    if (el.open === 'testsuites' || el.open === 'testsuite') sawRoot = true
    if (el.open === 'testsuite') {
      if (!el.selfClosing) suites.push(el.attrs.name ?? '')
    } else if (el.close === 'testsuite') {
      suites.pop()
    } else if (el.open === 'testcase') {
      if (typeof el.attrs.name !== 'string' || el.attrs.name === '') refuse('has a testcase with no name')
      const unit = unitOf(el.attrs, root)
      if (unit === null) refuse('has a testcase with neither file nor classname', el.attrs.name)
      // Adjacent repeats collapse: nextest names the unit, the suite and the classname identically.
      const id = [unit, ...suites, el.attrs.classname ?? '', el.attrs.name]
        .filter((p, i, parts) => p !== '' && (i === parts.length - 1 || p !== parts[i - 1])).join(' > ')
      if (el.selfClosing) count(units, unit, id, false)
      else testcase = { unit, id, skipped: false }
    } else if (el.open === 'skipped' && testcase) {
      testcase.skipped = true
    } else if (el.close === 'testcase' && testcase) {
      count(units, testcase.unit, testcase.id, testcase.skipped)
      testcase = null
    }
  }
  if (!sawRoot) refuse('has no testsuites or testsuite element', xml.slice(0, 80))
  return { units }
}

// One report file, or every `*.xml` directly under a directory (Gradle writes one per class),
// merged in name order so the same directory always yields the same inventory.
export async function readReport(target, { root } = {}) {
  let info
  try { info = await stat(target) } catch { return null }
  const files = info.isDirectory()
    ? (await readdir(target)).filter((f) => f.endsWith('.xml')).sort().map((f) => path.join(target, f))
    : [target]
  if (files.length === 0) return null
  const units = new Map()
  let total = 0
  for (const file of files) {
    const bytes = await readFile(file)
    total += bytes.length
    if (total > MAX_REPORT_BYTES) refuse(`is larger than ${MAX_REPORT_BYTES} bytes`)
    parseJunit(bytes.toString('utf8'), { root }, units)
  }
  return { units }
}

// The spec's rule table. `drops` and `skips` are sets of units: a drop in a unit a phase task marks
// `(drops)` is authorised, and a new skip in a unit the manifest's `skips` lists is expected.
export function compareInventories(baseline, preview, { drops = new Set(), skips = new Set() } = {}) {
  const dropped = []
  const newSkips = []
  const standing = []
  const seenSkipped = new Set()
  for (const [unit, ids] of baseline.units) {
    for (const [id, before] of ids) {
      const after = preview.units.get(unit)?.get(id) ?? { ran: 0, skipped: 0 }
      if (after.ran < before.ran && !drops.has(unit)) dropped.push({ unit, id, now: after.skipped > 0 ? 'skipped' : 'absent' })
      if (before.skipped > 0 && after.skipped > 0 && !skips.has(unit)) standing.push({ unit, id })
    }
  }
  for (const [unit, ids] of preview.units) {
    for (const [id, after] of ids) {
      if (after.skipped > 0) seenSkipped.add(unit)
      const before = baseline.units.get(unit)?.get(id)
      if (!before && after.skipped > 0 && !skips.has(unit)) newSkips.push({ unit, id })
    }
  }
  const stale = [...skips].filter((unit) => !seenSkipped.has(unit)).map((unit) => ({ unit }))
  return { dropped, newSkips, standing, stale }
}
