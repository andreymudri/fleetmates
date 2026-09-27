import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseJunit, parseNextestList, readReport, openReportFile, compareInventories, ReportParseError, MAX_REPORT_BYTES } from '../scripts/test-report.mjs'

const FIXTURES = new URL('./fixtures/junit/', import.meta.url)
const fixture = (name) => readFile(new URL(name, FIXTURES), 'utf8')

// Plain objects, so a failing deepEqual prints the whole inventory.
function flat({ units }) {
  const out = {}
  for (const [unit, ids] of units) {
    out[unit] = {}
    for (const [id, c] of ids) out[unit][id] = { ...c }
  }
  return out
}

// Captured from `node --test --test-reporter=junit` (Node 26), the scratch root replaced by /ROOT.
test('node --test: absolute file made relative, describe nests, todo is skipped, repeats count', async () => {
  const inv = flat(parseJunit(await fixture('node.xml'), { root: '/ROOT' }))
  const u = 'tests/a.test.mjs'
  assert.deepEqual(Object.keys(inv), [u])
  assert.deepEqual(inv[u], {
    [`${u} > test > runs`]: { ran: 1, skipped: 0 },
    [`${u} > test > skipped`]: { ran: 0, skipped: 1 },
    [`${u} > test > later`]: { ran: 0, skipped: 1 },
    [`${u} > grp > test > inner`]: { ran: 1, skipped: 0 },
    [`${u} > test > twin`]: { ran: 2, skipped: 0 },
  })
})

test('pytest xunit1: the relative file attribute is the unit, parametrised ids are distinct', async () => {
  const inv = flat(parseJunit(await fixture('pytest-xunit1.xml'), { root: '/ROOT' }))
  const u = 'tests/test_x.py'
  assert.deepEqual(Object.keys(inv), [u])
  assert.deepEqual(inv[u][`${u} > pytest > tests.test_x > test_skipped`], { ran: 0, skipped: 1 })
  assert.deepEqual(inv[u][`${u} > pytest > tests.test_x.TestGrp > test_inner`], { ran: 1, skipped: 0 })
  assert.deepEqual(inv[u][`${u} > pytest > tests.test_x > test_param[2]`], { ran: 1, skipped: 0 })
  assert.equal(Object.keys(inv[u]).length, 5)
})

test('pytest xunit2 (the default) has no file: the unit falls back to the dotted classname', async () => {
  const inv = flat(parseJunit(await fixture('pytest-xunit2.xml'), { root: '/ROOT' }))
  assert.deepEqual(Object.keys(inv).sort(), ['tests.test_x', 'tests.test_x.TestGrp'])
})

test('a report directory merges every xml in it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-report-'))
  try {
    const one = '<testsuite name="s"><testcase classname="A" name="x"/></testsuite>'
    const two = '<testsuite name="s"><testcase classname="B" name="y"><skipped/></testcase></testsuite>'
    await writeFile(path.join(dir, 'TEST-A.xml'), one)
    await writeFile(path.join(dir, 'TEST-B.xml'), two)
    await writeFile(path.join(dir, 'notes.txt'), 'not a report')
    const inv = flat(await readReport(dir, { root: dir }))
    assert.deepEqual(inv, { A: { 'A > s > A > x': { ran: 1, skipped: 0 } }, B: { 'B > s > B > y': { ran: 0, skipped: 1 } } })
    // A test named like its classname keeps its name: only the unit/suite/classname run collapses.
    assert.deepEqual(flat(parseJunit('<testsuite name="K"><testcase classname="K" name="K"/></testsuite>')), { K: { 'K > K': { ran: 1, skipped: 0 } } })
    await mkdir(path.join(dir, 'empty'))
    assert.equal(await readReport(path.join(dir, 'empty'), { root: dir }), null)
    assert.equal(await readReport(path.join(dir, 'missing.xml'), { root: dir }), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('entities: predefined and numeric references decode, a > inside a quoted value is legal', () => {
  const xml = '<testsuite name="s"><testcase classname="C" name="a &amp; b &#x3E; c &#62; d &lt;e&gt; &apos;q&quot;" note="x>y"/></testsuite>'
  const inv = flat(parseJunit(xml, { root: '/' }))
  assert.deepEqual(Object.keys(inv.C), [`C > s > C > a & b > c > d <e> 'q"`])
})

for (const [label, xml] of [
  ['not XML', 'PASS 12 tests'],
  ['no testsuite(s) root', '<results><testcase classname="A" name="x"/></results>'],
  ['a case without a name', '<testsuite><testcase classname="A"/></testsuite>'],
  ['a case with neither file nor classname', '<testsuite><testcase name="x"/></testsuite>'],
  ['a DOCTYPE', '<!DOCTYPE x [<!ENTITY a "b">]><testsuite><testcase classname="A" name="&a;"/></testsuite>'],
  ['a file outside the tree', '<testsuite><testcase file="/elsewhere/a.test.mjs" name="x"/></testsuite>'],
  ['an unterminated tag', '<testsuite><testcase name="x"'],
]) {
  test(`refused: ${label}`, () => {
    assert.throws(() => parseJunit(xml, { root: '/ROOT' }), ReportParseError)
  })
}

test('a refusal quotes a bounded, printable excerpt', () => {
  const hostile = `\u001b[2K\u009bPASS\u2028${'x'.repeat(5000)}`
  const err = (() => { try { parseJunit(hostile, { root: '/' }) } catch (e) { return e } })()
  assert.ok(err instanceof ReportParseError)
  assert.doesNotMatch(err.message, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
  assert.ok(err.message.length < 400, err.message.length)
})

test('an oversized report is refused before it is parsed', () => {
  assert.throws(() => parseJunit('<'.repeat(MAX_REPORT_BYTES + 1)), /larger than/)
})

// --- comparison ------------------------------------------------------------------------------

const inv = (spec) => {
  const units = new Map()
  for (const [unit, ids] of Object.entries(spec)) units.set(unit, new Map(Object.entries(ids)))
  return { units }
}
const R = { ran: 1, skipped: 0 }
const S = { ran: 0, skipped: 1 }

test('a test that ran at the baseline and is absent or skipped now is a drop', () => {
  const base = inv({ 'a.test.mjs': { 'a > x': R, 'a > y': R, 'a > z': R } })
  const now = inv({ 'a.test.mjs': { 'a > x': R, 'a > y': S } })
  const r = compareInventories(base, now)
  assert.deepEqual(r.dropped, [{ unit: 'a.test.mjs', id: 'a > y', now: 'skipped' }, { unit: 'a.test.mjs', id: 'a > z', now: 'absent' }])
  assert.deepEqual(r.newSkips, [])
})

test('a drop in a unit a phase task marks (drops) is authorised', () => {
  const base = inv({ 'a.test.mjs': { 'a > x': R }, 'b.test.mjs': { 'b > x': R } })
  const now = inv({})
  const r = compareInventories(base, now, { drops: new Set(['a.test.mjs']) })
  assert.deepEqual(r.dropped.map((d) => d.unit), ['b.test.mjs'])
})

test('a repeated name that runs fewer times is a drop', () => {
  const r = compareInventories(inv({ u: { 'u > twin': { ran: 2, skipped: 0 } } }), inv({ u: { 'u > twin': R } }))
  assert.equal(r.dropped.length, 1)
})

test('a new test born skipped is a new skip unless its unit is declared in skips', () => {
  const base = inv({ 'db.py': { 'db > old': R } })
  const now = inv({ 'db.py': { 'db > old': R, 'db > new': S }, 'gpu.py': { 'gpu > x': S } })
  assert.deepEqual(compareInventories(base, now).newSkips, [{ unit: 'db.py', id: 'db > new' }, { unit: 'gpu.py', id: 'gpu > x' }])
  assert.deepEqual(compareInventories(base, now, { skips: new Set(['gpu.py']) }).newSkips, [{ unit: 'db.py', id: 'db > new' }])
})

test('a standing skip is reported, and a declared unit with nothing skipped is stale', () => {
  const base = inv({ 'db.py': { 'db > x': S }, 'gpu.py': { 'gpu > y': S } })
  const now = inv({ 'db.py': { 'db > x': S }, 'gpu.py': { 'gpu > y': S } })
  const r = compareInventories(base, now, { skips: new Set(['gpu.py', 'gone.py']) })
  assert.deepEqual(r.standing, [{ unit: 'db.py', id: 'db > x' }])
  assert.deepEqual(r.stale, [{ unit: 'gone.py' }])
  assert.deepEqual(r.dropped, [])
  assert.deepEqual(r.newSkips, [])
})

test('removing or reviving a test that was skipped weakens nothing', () => {
  const base = inv({ u: { 'u > a': S, 'u > b': S } })
  const now = inv({ u: { 'u > b': R } })
  const r = compareInventories(base, now)
  assert.deepEqual([r.dropped, r.newSkips, r.standing], [[], [], []])
})

test('a new test that runs is nothing', () => {
  const r = compareInventories(inv({}), inv({ u: { 'u > a': R } }))
  assert.deepEqual([r.dropped, r.newSkips, r.standing, r.stale], [[], [], [], []])
})

// Captured from cargo-nextest 0.9.146 over a crate with one `#[ignore]` test. MEASURED LIMIT: nextest
// leaves ignored tests out of its JUnit report entirely (no case, `skipped="0"`), with or without
// `--run-ignored default`. A newly ignored test therefore reads as absent — the drop rule sees it —
// but a test born ignored, or ignored at every gate, is invisible to the skip rules.
test('nextest: classname is the unit, and an ignored test is absent rather than skipped', async () => {
  const inv = flat(parseJunit(await fixture('nextest.xml'), { root: '/ROOT' }))
  assert.deepEqual(inv, {
    'demo::it': { 'demo::it > runs': { ran: 1, skipped: 0 } },
    demo: { 'demo > tests::it_works': { ran: 1, skipped: 0 } },
  })
})

// Review round: the attribute regex was quadratic in a tag's length (an 80 KB tag took 5.5 s).
test('a long tag parses in linear time', () => {
  const start = Date.now()
  const xml = `<testsuite name="s"><testcase classname="C" name="x" ${'a'.repeat(400_000)}/></testsuite>`
  parseJunit(xml, { root: '/' })
  assert.ok(Date.now() - start < 1000, `${Date.now() - start} ms`)
})

test('attribute scanning: spaces around =, both quote styles, valueless names, and a > inside a value', () => {
  const inv = flat(parseJunit(`<testsuite name = 's'><testcase disabled classname= "C" name ='a>b' /></testsuite>`, { root: '/' }))
  assert.deepEqual(Object.keys(inv.C), ['C > s > C > a>b'])
})

// --- review round: rows and parser details the first suite left unpinned ------------------------

test('a self-closing testsuite does not enter the suite path of later cases', () => {
  const inv = flat(parseJunit('<testsuites><testsuite name="empty"/><testsuite name="s"><testcase classname="C" name="x"/></testsuite></testsuites>', { root: '/' }))
  assert.deepEqual(Object.keys(inv.C), ['C > s > C > x'])
})

test('a relative file is normalised, and a drive-letter file is absolute', () => {
  const rel = flat(parseJunit('<testsuite><testcase file="./tests/./a.test.mjs" name="x"/></testsuite>', { root: '/' }))
  assert.deepEqual(Object.keys(rel), ['tests/a.test.mjs'])
  const win = flat(parseJunit('<testsuite><testcase file="C:\\work\\repo\\tests\\a.test.mjs" name="x"/></testsuite>', { root: 'C:\\work\\repo' }))
  assert.deepEqual(Object.keys(win), ['tests/a.test.mjs'])
  assert.throws(() => parseJunit('<testsuite><testcase file="D:/other/a.test.mjs" name="x"/></testsuite>', { root: 'C:/work/repo' }), ReportParseError)
})

test('an unterminated comment is refused', () => {
  assert.throws(() => parseJunit('<testsuite><!-- open <testcase classname="C" name="x"/></testsuite>', { root: '/' }), /unterminated comment/)
})

test('the size cap is cumulative over a report directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-report-cap-'))
  try {
    const one = '<testsuite><testcase classname="A" name="x"/></testsuite>'
    await writeFile(path.join(dir, 'a.xml'), one)
    await writeFile(path.join(dir, 'b.xml'), one)
    await readReport(dir, { root: dir, maxBytes: one.length * 2 })
    await assert.rejects(readReport(dir, { root: dir, maxBytes: one.length * 2 - 1 }), /larger than/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a skips unit whose tests all run is stale', () => {
  const r = compareInventories(inv({ 'db.py': { 'db > x': S } }), inv({ 'db.py': { 'db > x': R } }), { skips: new Set(['db.py']) })
  assert.deepEqual(r.stale, [{ unit: 'db.py' }])
})

test('an authorised drop to skipped, and a declared new skip, are not standing skips', () => {
  const r = compareInventories(
    inv({ 'a.mjs': { 'a > x': R } }),
    inv({ 'a.mjs': { 'a > x': S }, 'db.py': { 'db > n': S } }),
    { drops: new Set(['a.mjs']), skips: new Set(['db.py']) },
  )
  assert.deepEqual([r.dropped, r.newSkips, r.standing], [[], [], []])
})

// Review round 2: a FIFO or a link to /dev/zero reports size 0 and then reads without bound.
// No mkfifo and no unprivileged file symlinks on win32; the portable cases are the two tests below.
test('a report that is not a regular file is refused before it is read', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync } = await import('node:child_process')
  const { symlink } = await import('node:fs/promises')
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-report-fifo-'))
  try {
    execFileSync('mkfifo', [path.join(dir, 'fifo.xml')])
    await assert.rejects(readReport(dir, { root: dir }), /not a regular file/)
    await assert.rejects(readReport(path.join(dir, 'fifo.xml'), { root: dir }), /not a regular file/)
    const other = await mkdtemp(path.join(tmpdir(), 'tm-report-link-'))
    await symlink('/dev/zero', path.join(other, 'zero.xml'))
    // Refused at the open itself (O_NOFOLLOW), which is what closes the swap between check and read.
    await assert.rejects(readReport(other, { root: other }), /zero\.xml, which is a symbolic link/)
    await assert.rejects(readReport(path.join(other, 'zero.xml'), { root: other }), /symbolic link/)
    await rm(other, { recursive: true, force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a directory named like a report is refused, not read', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-report-dir-'))
  try {
    await mkdir(path.join(dir, 'nested.xml'))
    await assert.rejects(readReport(dir, { root: dir }), /nested\.xml, which is not a regular file/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// win32 has no O_NOFOLLOW; the fallback is forced here so it runs where links can be made.
test('without O_NOFOLLOW a link is refused by lstat, and a regular file still opens', { skip: process.platform === 'win32' }, async () => {
  const { symlink } = await import('node:fs/promises')
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-report-nofollow-'))
  try {
    await writeFile(path.join(dir, 'real.xml'), '<testsuites/>')
    await symlink(path.join(dir, 'real.xml'), path.join(dir, 'link.xml'))
    await assert.rejects(openReportFile(path.join(dir, 'link.xml'), { noFollow: null }), /link\.xml, which is a symbolic link/)
    const handle = await openReportFile(path.join(dir, 'real.xml'), { noFollow: null })
    assert.equal((await handle.readFile('utf8')), '<testsuites/>')
    await handle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// nextest leaves ignored tests out of its JUnit report; its listing names them. Captured from
// `cargo nextest list --run-ignored ignored-only --message-format json` (0.9.146) over the same
// crate as nextest.xml, absolute paths replaced.
test('a nextest listing beside the JUnit report counts each ignored test as skipped, under the JUnit ID', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-report-nx-'))
  try {
    await writeFile(path.join(dir, 'junit.xml'), await fixture('nextest.xml'))
    await writeFile(path.join(dir, 'nextest-list.json'), await fixture('nextest-list.json'))
    const got = flat(await readReport(dir, { root: '/ROOT' }))
    assert.deepEqual(got, {
      'demo::it': { 'demo::it > runs': { ran: 1, skipped: 0 }, 'demo::it > heavy': { ran: 0, skipped: 1 } },
      demo: { 'demo > tests::it_works': { ran: 1, skipped: 0 } },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an ignored test the run executed is not also counted as skipped', () => {
  const units = parseJunit('<testsuites><testsuite name="demo::it"><testcase classname="demo::it" name="heavy"/></testsuite></testsuites>', { root: '/' }).units
  parseNextestList(JSON.stringify({ 'rust-suites': { 'demo::it': { 'binary-id': 'demo::it', testcases: { heavy: { ignored: true } } } } }), units)
  assert.deepEqual(flat({ units }), { 'demo::it': { 'demo::it > heavy': { ran: 1, skipped: 0 } } })
})

test('a nextest listing that is not the expected shape is refused', () => {
  for (const bad of ['nope', '{}', '{"rust-suites":[]}', '{"rust-suites":{"a":{"testcases":[]}}}']) {
    assert.throws(() => parseNextestList(bad), ReportParseError, bad)
  }
})

// Only `ignored: true` counts: a test the run filtered out (`-E`, a partition) is listed with
// `ignored: false` and absent from the JUnit report, and it is not a skip.
test('a listed test that is not ignored adds nothing', () => {
  const { units } = parseNextestList(JSON.stringify({ 'rust-suites': { b: { 'binary-id': 'b', testcases: { filtered: { ignored: false, 'filter-match': { status: 'mismatch' } } } } } }))
  assert.deepEqual(flat({ units }), {})
})
