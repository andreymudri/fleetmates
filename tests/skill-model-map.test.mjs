import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseDoc, splitFrontmatter, assertStatement, assertNoStatement } from './md-contract.mjs'

// The tier->model map lives only in skill text: config stores tiers, never models. These tests pin
// the Claude map in `parallel-execution` to the measured routing (`mid` on opus, see
// tools/replay/README.md) and the integrator's fixed role model to the recorded verdict in
// tools/replay/data/integrator-verdict.json, so a rerun that flips the verdict fails here until
// the skill follows it. The README restates the same routing and is held to the skill, and the
// reviewer's fixed tier is pinned in both skills that state it.

const EXPECTED_MAP = { cheap: 'haiku', mid: 'opus', capable: 'opus' }
const REVIEWER_TIER = 'capable'

// Source-text assertions strip comments first: a markdown comment documenting the map would
// otherwise satisfy (or break) the assertion it documents.
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '')

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8')

const withFrontmatter = async (rel, label) => {
  const { body } = splitFrontmatter(stripComments(await read(rel)), label)
  return parseDoc(body, rel)
}

const skill = () => withFrontmatter('skills/parallel-execution/SKILL.md', 'parallel-execution')
const phaseGate = () => withFrontmatter('skills/phase-gate/SKILL.md', 'phase-gate')
const integrator = () => withFrontmatter('agents/tm-integrator.md', 'tm-integrator')
const readmeText = async () => stripComments(await read('README.md'))
const readme = async () => parseDoc(await readmeText(), 'README.md')

const verdict = async () => JSON.parse(await read('tools/replay/data/integrator-verdict.json'))

const section = async () => (await skill()).section('Choosing a model per dispatch')

// The one capture of `pattern` in the single statement it matches.
const captured = (scope, pattern, message) => assertStatement(scope, pattern, message).text.match(pattern)

test('stripComments removes a markdown comment, so a commented map cannot satisfy the assertion', () => {
  assert.equal(stripComments('a <!-- mid -> opus --> b'), 'a  b')
  assert.equal(stripComments('<!--\n    mid -> opus\n-->\n'), '\n')
})

const skillMap = (s) => {
  const maps = s.code
    .map((b) => [...b.code.matchAll(/^\s*(\w+)\s*->\s*(\S+)\s*$/gm)])
    .filter((m) => m.length)
  assert.equal(maps.length, 1, 'the section must hold exactly one tier -> model code block')
  return Object.fromEntries(maps[0].map((m) => [m[1], m[2]]))
}

test('the dispatch map is exactly cheap -> haiku, mid -> opus, capable -> opus', async () => {
  assert.deepEqual(skillMap(await section()), EXPECTED_MAP)
})

test('the workflow example passes the same map through --models', async () => {
  const s = await section()
  const examples = s.code.filter((b) => /\bworkflow\b/.test(b.code) && /--models/.test(b.code))
  assert.equal(examples.length, 1, 'the section must hold exactly one workflow --models example')
  const json = /--models\s+'([^']*)'/.exec(examples[0].code)
  assert.ok(json, 'the workflow example must quote its --models JSON')
  assert.deepEqual(JSON.parse(json[1]), EXPECTED_MAP)
})

// Any sentence naming both `mid` and sonnet is taken to say mid means sonnet, unless it describes
// restoring sonnet. A verb list ("means", "is", "runs on") let "resolves to", "dispatches to" and
// "uses" through; this does not depend on the verb at all.
const MID_SONNET = (text) => /\bmid\b/i.test(text) && /\bsonnet\b/i.test(text) && !/restore|--models/i.test(text)

test('the mid-and-sonnet screen flags any verb and exempts only a restore sentence', () => {
  for (const s of ['In short, mid resolves to sonnet.', 'mid dispatches to sonnet.', 'mid uses sonnet.', 'fixed integrator tier, mid (model sonnet).']) {
    assert.ok(MID_SONNET(s), s)
  }
  for (const s of ['To restore sonnet for mid, dispatch mid tasks on sonnet.', "pass --models '{\"mid\":\"sonnet\"}'", 'mid runs on opus.']) {
    assert.ok(!MID_SONNET(s), s)
  }
})

test('no prose in the skill says mid means sonnet', async () => {
  const hits = (await skill()).statements.filter((s) => MID_SONNET(s.text)).map((s) => s.text)
  assert.deepEqual(hits, [], 'mid runs on opus now; only a sentence restoring sonnet may name both')
})

// Each branch asserts its own wording present and the other branch's wording absent, so a flipped
// verdict fails until the skill drops the old role model, not merely until it adds the new one.
const CHEAP_WORDING = /tm-integrator runs at cheap\b|fixed integrator tier, cheap\b/
const assertIntegratorMatches = (v, s) => {
  assert.ok(['cheap', 'sonnet'].includes(v), `unexpected verdict ${v}`)
  if (v === 'cheap') {
    assertStatement(s, /tm-integrator runs at cheap\b/, 'the integrator role tier must be cheap')
    assertStatement(
      s,
      new RegExp(`fixed integrator tier, cheap \\(model ${EXPECTED_MAP.cheap}\\)`),
      'the unset fallback must name the cheap tier and its model',
    )
    assertStatement(s, /configured tier replaces cheap\b/, 'a configured tier must still replace it')
    assertNoStatement(s, /tm-integrator runs at mid\b|fixed integrator tier, mid\b/, 'no stale mid integrator')
    assertNoStatement(s, /tm-integrator runs on sonnet\b/, 'no stale sonnet integrator')
  } else {
    assertStatement(s, /tm-integrator runs on sonnet\b/, 'the integrator must keep sonnet as a role model')
    assertNoStatement(s, CHEAP_WORDING, 'no stale cheap integrator')
  }
  assertStatement(s, /integrator-verdict\.json/, 'the integrator choice must cite the verdict file')
}

test("the integrator's fixed role model matches the recorded verdict", async () => {
  assertIntegratorMatches((await verdict()).verdict, await section())
})

test('the skill as written fails the check under the opposite verdict', async () => {
  const s = await section()
  const opposite = (await verdict()).verdict === 'cheap' ? 'sonnet' : 'cheap'
  assert.throws(() => assertIntegratorMatches(opposite, s), assert.AssertionError)
})

test('the verdict word the skill quotes is the verdict file value', async () => {
  const [, word] = captured(await section(), /records the verdict (\w+)/, 'the skill must quote the verdict')
  assert.equal(word, (await verdict()).verdict)
})

test(`the reviewer's fixed tier is ${REVIEWER_TIER} in both phase-gate and parallel-execution`, async () => {
  const pg = await phaseGate()
  const [, fixed] = captured(pg, /fixed reviewer tier, (\w+)/, 'phase-gate must name the fixed reviewer tier')
  assert.equal(fixed, REVIEWER_TIER)
  const [, still] = captured(pg, /the reviewer is still dispatched at (\w+)/, 'phase-gate must keep the reviewer tier distinct from mid')
  assert.equal(still, REVIEWER_TIER)
  const [, role] = captured(await section(), /tm-reviewer at (\w+)/, 'parallel-execution must name the reviewer role tier')
  assert.equal(role, REVIEWER_TIER)
})

test("the README's fixed role tiers match the skill", async () => {
  const [, integratorTier] = captured(await section(), /tm-integrator runs at (\w+)/, 'the skill must name the integrator tier')
  const doc = await readme()
  const [, reviewer, integ] = captured(doc, /fixes them at (\w+) and (\w+)/, 'the README must name both fixed role tiers')
  assert.equal(reviewer, REVIEWER_TIER)
  assert.equal(integ, integratorTier)
  const [, cited] = captured(doc, /The integrator's (\w+) comes from a replay/, 'the README must cite the integrator tier')
  assert.equal(cited, integratorTier)
})

test("the README's tier-to-model map and table match the skill", async () => {
  const map = skillMap(await section())
  const [, cheap, mid, capable] = captured(
    await readme(),
    /the map is cheap -> (\w+), mid -> (\w+), capable -> (\w+)/,
    'the README must state the tier -> model map',
  )
  assert.deepEqual({ cheap, mid, capable }, map)
  // Rows whose tier cell is a bare tier are the current routing; `mid (before)` is the old one.
  const rows = [...(await readmeText()).matchAll(/^\|\s*(cheap|mid|capable)\s*\|\s*(\w+)\s*\|/gm)]
  assert.ok(rows.length >= 2, 'the README replay table must list the current tiers')
  for (const [, tier, model] of rows) assert.equal(model, map[tier], `README table row ${tier}`)
})

// The phase gate's merge check already fails on any conflict, so a conflict at integration means
// the tree changed after the gate; the integrator escalates every one rather than judging which
// are trivial.
test('the integrator never resolves a conflict and escalates with both hunks and the owning task ids', async () => {
  const doc = await integrator()
  assertStatement(
    doc.section('Rules'),
    /^Never resolve a conflict: stop and escalate with both hunks and the owning task ids\b/i,
    'the integrator must escalate every conflict',
  )
  assertNoStatement(doc, /\bmay resolve\b|\bresolving a conflict is fine\b|\btrivial conflicts?\b/i, 'no conflict is the integrator\'s to resolve')
})

test('parallel-execution does not say the integrator resolves trivial conflicts', async () => {
  const s = await section()
  assertNoStatement(s, /\btrivial\b/i, 'the integrator contract resolves no conflict')
  assertStatement(s, /tm-integrator contract escalates every conflict\b/, 'the skill must state the escalation rule')
})
