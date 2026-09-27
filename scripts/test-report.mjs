// The test inventory: a JUnit report reduced to what the gate compares — per unit (a test file, or
// the classname when the runner names no file), per test ID, how many times it ran and how many
// times it was skipped. See docs/specs/2026-09-26-test-inventory-design.md.
//
// The report is written by a process running teammate code, so everything read here is
// agent-written: refusals quote a bounded, `printable` excerpt, and the parser expands no entity
// beyond the five predefined ones and numeric references — a DOCTYPE is refused outright rather
// than half-understood.
import { open, readdir, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
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

// A hand scanner, linear in the tag's length. The regex it replaces was quadratic on a long run of
// name characters with no `=` (review: an 80 KB tag took 5.5 s), and the report is agent-written.
function attributes(source) {
  const attrs = {}
  let i = 0
  const n = source.length
  const space = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
  while (i < n) {
    while (i < n && (space(source[i]) || source[i] === '/')) i += 1
    const start = i
    while (i < n && !space(source[i]) && source[i] !== '=' && source[i] !== '/' && source[i] !== '>') i += 1
    const name = source.slice(start, i)
    while (i < n && space(source[i])) i += 1
    if (name === '' || source[i] !== '=') { if (name === '' && i === start) i += 1; continue }
    i += 1
    while (i < n && space(source[i])) i += 1
    const quote = source[i]
    if (quote !== '"' && quote !== "'") continue
    const end = source.indexOf(quote, i + 1)
    if (end === -1) break
    attrs[name] = decode(source.slice(i + 1, end))
    i = end + 1
  }
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

// Adjacent repeats collapse: nextest names the unit, the suite and the classname identically. The
// nextest listing builds its IDs through this same function, so both sources name a test alike.
function testId(parts) {
  return parts.filter((p, i, all) => p !== '' && (i === all.length - 1 || p !== all[i - 1])).join(' > ')
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
      const id = testId([unit, ...suites, el.attrs.classname ?? '', el.attrs.name])
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
export async function readReport(target, { root, maxBytes = MAX_REPORT_BYTES } = {}) {
  // lstat, and regular files only: a FIFO or a link to /dev/zero reports size 0 and then reads
  // without bound (review: a FIFO with no writer hung the gate past the suite's own timeout).
  let info
  try { info = await lstat(target) } catch { return null }
  if (info.isSymbolicLink()) refuse('is a symbolic link')
  if (!info.isDirectory() && !info.isFile()) refuse('is not a regular file')
  const names = info.isDirectory() ? (await readdir(target)).sort() : null
  const files = names ? names.filter((f) => f.endsWith('.xml')).map((f) => path.join(target, f)) : [target]
  const listing = names?.includes(NEXTEST_LIST) ? path.join(target, NEXTEST_LIST) : null
  if (files.length === 0 && !listing) return null
  const units = new Map()
  let total = 0
  for (const file of files) {
    const bytes = await readRegularFile(file, maxBytes - total)
    total += bytes.length
    parseJunit(bytes.toString('utf8'), { root }, units)
  }
  // Read after the JUnit files, so a test the run executed (`--run-ignored all`) is not also
  // counted as skipped.
  if (listing) parseNextestList((await readRegularFile(listing, maxBytes - total)).toString('utf8'), units)
  return { units }
}

// cargo-nextest leaves `#[ignore]` tests out of its JUnit report entirely (measured, 0.9.146), so
// a test ignored from birth, or at every gate, would be invisible to the skip rules. Its listing
// (`cargo nextest list --message-format json`) marks every test `ignored: true|false` whatever
// filter is used; a check that writes it as `nextest-list.json` beside the JUnit report gets each
// ignored test counted as skipped, under the ID the JUnit report would have given it.
export const NEXTEST_LIST = 'nextest-list.json'

export function parseNextestList(text, units = new Map()) {
  let doc
  try { doc = JSON.parse(text) } catch { refuse(`listing ${NEXTEST_LIST} is not JSON`, text.slice(0, 80)) }
  const suites = doc?.['rust-suites']
  if (suites === null || typeof suites !== 'object' || Array.isArray(suites)) refuse(`listing ${NEXTEST_LIST} has no rust-suites object`)
  for (const [key, suite] of Object.entries(suites)) {
    const binaryId = typeof suite?.['binary-id'] === 'string' && suite['binary-id'] !== '' ? suite['binary-id'] : key
    const cases = suite?.testcases
    if (cases === null || typeof cases !== 'object' || Array.isArray(cases)) refuse(`listing ${NEXTEST_LIST} has a suite without testcases`, binaryId)
    for (const [name, tc] of Object.entries(cases)) {
      if (tc?.ignored !== true) continue
      const id = testId([binaryId, binaryId, binaryId, name])
      if ((units.get(binaryId)?.get(id)?.ran ?? 0) > 0) continue
      count(units, binaryId, id, true)
    }
  }
  return { units }
}

// Opened once, then judged and read through that one handle: a check by path followed by a read
// by path left a window in which the suite (teammate code, possibly still running a leftover
// process) could swap in a FIFO — a read that never returns, outside the check's timeout — or a
// link to a file outside the report (review round 3, both reproduced). O_NOFOLLOW refuses a link,
// O_NONBLOCK keeps a FIFO from blocking the open, and fstat on the handle answers for the file
// actually read. The size is checked before any byte is read, and the read is bounded by it.
async function readRegularFile(file, remaining) {
  const handle = await openReportFile(file)
  try {
    const info = await handle.stat()
    if (!info.isFile()) refuse(`holds ${path.basename(file)}, which is not a regular file`)
    if (info.size > remaining) refuse(`is larger than ${MAX_REPORT_BYTES} bytes`)
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

// win32 has neither O_NOFOLLOW nor O_NONBLOCK (both undefined there, and a FIFO cannot sit in a
// directory). What stands in for the refusing open: lstat first and refuse a link, open, then
// require the handle to be the very file lstat saw, so a link swapped in between is caught after
// the open rather than at it. `noFollow: null` forces that path, so both run in every platform's tests.
export async function openReportFile(file, { noFollow = constants.O_NOFOLLOW } = {}) {
  const name = path.basename(file)
  const opened = (flags) => open(file, flags).catch((err) => {
    if (err?.code === 'ELOOP') refuse(`holds ${name}, which is a symbolic link`)
    if (err?.code === 'EISDIR') refuse(`holds ${name}, which is not a regular file`)
    throw err
  })
  if (noFollow != null) return opened(constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0))
  const seen = await lstat(file, { bigint: true })
  if (seen.isSymbolicLink()) refuse(`holds ${name}, which is a symbolic link`)
  const handle = await opened(constants.O_RDONLY)
  const now = await handle.stat({ bigint: true })
  if (now.dev !== seen.dev || now.ino !== seen.ino) {
    await handle.close()
    refuse(`holds ${name}, which was replaced while it was being opened`)
  }
  return handle
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
