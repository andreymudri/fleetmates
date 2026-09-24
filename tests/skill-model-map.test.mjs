import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseDoc, splitFrontmatter, assertStatement, assertNoStatement } from './md-contract.mjs'

// The tier->model map lives only in skill text: config stores tiers, never models. These tests pin
// the Claude map in `parallel-execution` to the measured routing (`mid` on opus, see
// tools/replay/README.md) and the integrator's fixed role model to the recorded verdict in
// tools/replay/data/integrator-verdict.json, so a rerun that flips the verdict fails here until
// the skill follows it.

const EXPECTED_MAP = { cheap: 'haiku', mid: 'opus', capable: 'opus' }

// Source-text assertions strip comments first: a markdown comment documenting the map would
// otherwise satisfy (or break) the assertion it documents.
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '')

const skill = async () => {
  const text = await readFile(new URL('../skills/parallel-execution/SKILL.md', import.meta.url), 'utf8')
  const { body } = splitFrontmatter(stripComments(text), 'parallel-execution')
  return parseDoc(body, 'parallel-execution/SKILL.md')
}

const verdict = async () =>
  JSON.parse(await readFile(new URL('../tools/replay/data/integrator-verdict.json', import.meta.url), 'utf8'))

const section = async () => (await skill()).section('Choosing a model per dispatch')

test('stripComments removes a markdown comment, so a commented map cannot satisfy the assertion', () => {
  assert.equal(stripComments('a <!-- mid -> opus --> b'), 'a  b')
  assert.equal(stripComments('<!--\n    mid -> opus\n-->\n'), '\n')
})

test('the dispatch map is exactly cheap -> haiku, mid -> opus, capable -> opus', async () => {
  const s = await section()
  const maps = s.code
    .map((b) => [...b.code.matchAll(/^\s*(\w+)\s*->\s*(\S+)\s*$/gm)])
    .filter((m) => m.length)
  assert.equal(maps.length, 1, 'the section must hold exactly one tier -> model code block')
  assert.deepEqual(Object.fromEntries(maps[0].map((m) => [m[1], m[2]])), EXPECTED_MAP)
})

test('the workflow example passes the same map through --models', async () => {
  const s = await section()
  const examples = s.code.filter((b) => /\bworkflow\b/.test(b.code) && /--models/.test(b.code))
  assert.equal(examples.length, 1, 'the section must hold exactly one workflow --models example')
  const json = /--models\s+'([^']*)'/.exec(examples[0].code)
  assert.ok(json, 'the workflow example must quote its --models JSON')
  assert.deepEqual(JSON.parse(json[1]), EXPECTED_MAP)
})

// Naming sonnet as the way to restore the old routing is allowed; stating that `mid` IS sonnet
// is not. The old skill said "fixed integrator tier, mid (model sonnet)".
test('no prose in the skill says mid means sonnet', async () => {
  const doc = await skill()
  assertNoStatement(
    doc,
    /\bmid\b,?\s*\(model sonnet\)|\bmid\b\s*(->|=|means|is|maps to|runs on|runs at)\s*sonnet\b/i,
    'mid runs on opus now',
  )
})

test("the integrator's fixed role model matches the recorded verdict", async () => {
  const v = await verdict()
  assert.ok(['cheap', 'sonnet'].includes(v.verdict), `unexpected verdict ${v.verdict}`)
  const s = await section()
  if (v.verdict === 'cheap') {
    assertStatement(s, /tm-integrator runs at cheap\b/, 'the integrator role tier must be cheap')
    assertStatement(
      s,
      new RegExp(`fixed integrator tier, cheap \\(model ${EXPECTED_MAP.cheap}\\)`),
      'the unset fallback must name the cheap tier and its model',
    )
    assertStatement(s, /configured tier replaces cheap\b/, 'a configured tier must still replace it')
    assertNoStatement(s, /tm-integrator runs at mid\b|fixed integrator tier, mid\b/, 'no stale mid integrator')
  } else {
    assertStatement(s, /tm-integrator runs on sonnet\b/, 'the integrator must keep sonnet as a role model')
    assertStatement(s, /integrator-verdict\.json/, 'the sonnet role model must cite the verdict file')
  }
  assertStatement(s, /integrator-verdict\.json/, 'the integrator choice must cite the verdict file')
})
