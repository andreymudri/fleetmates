import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseJunit, readReport, compareInventories, ReportParseError, MAX_REPORT_BYTES } from '../scripts/test-report.mjs'

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
