import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { composeBrief } from '../scripts/brief.mjs'
import { renderDigest } from '../scripts/digest.mjs'
import { CAVEMAN_LEVELS } from '../scripts/config.mjs'
import { parseDoc, splitFrontmatter, assertStatement, assertNoStatement, assertClaim } from './md-contract.mjs'

// WHY THIS FILE EXISTS
// --------------------
// `caveman` was carried for a session as "the largest remaining token lever". Measuring it on
// 2026-08-25 against real subagent transcripts found the opposite, and found that no document
// stated what the knob actually reaches — the README and this skill both listed it beside
// `maxParallel` with a four-level domain and no scope at all.
//
// Every assertion below is paired: one pins the sentence in the skill, one pins the behaviour
// that sentence describes. A claim about code that no test binds to the code is exactly the
// defect the `claims` review lens exists to catch, and documenting a measurement is the easiest
// place in this repository to commit one.

const doc = async () => {
  const text = await readFile(new URL('../skills/fleetmates-config/SKILL.md', import.meta.url), 'utf8')
  const { body } = splitFrontmatter(text, 'fleetmates-config')
  return parseDoc(body, 'fleetmates-config/SKILL.md')
}

// The SECTION that holds the claim, not the whole document. `assertClaim` screens back-references
// across whatever scope it is handed, so passing the document made an innocuous sentence in an
// unrelated section fail the caveman test — with a message about caveman. Both screens belong
// where the claim lives.
//
// ONE definition of "which section", used by every caller. It was a helper nothing called, beside
// a regression test that re-implemented the same `sections.find` inline — so the helper could
// regress without failing anything, which a review filed twice: once as bypassed, once as
// unreachable. A lookup used in two places is written once.
const findCavemanSection = (parsed) => {
  const section = parsed.sections.find((s) => /What .*caveman.* actually reaches/.test(s.title ?? ''))
  assert.ok(section, 'the skill must keep a section stating what caveman reaches')
  return section
}


const task = {
  id: 'T1',
  title: 'a task',
  files: ['a.mjs'],
  branch: 'fleetmates/r1/T1',
}
const brief = (caveman) => composeBrief({ task, runId: 'r1', planPath: 'p.md', baseBranch: 'main', caveman })

// WHY THIS IS SIX LAYERS AND NOT ONE, AND WHY NONE OF THEM IS A PROOF.
//
// The claim has now been defeated TEN times, and every fix opened the next hole: co-occurrence
// matching; one sentence satisfying the claim while stating its inverse; the inverse appended to
// the claim sentence, which `assertClaim` exempts by construction; a heading, which `parseDoc`
// never turns into a statement; the inverse appended to an allow-listed sentence; an inversion in
// another section once the claim was scoped to its own; a sentence naming neither "reviewer" nor
// "caveman"; the round-four instrument defeating itself, through the `[^.]*` in its own
// exact-shape regex; a heading pairing "reviewer" with "level", which a round-six fix stopped
// screening for; and — round six again — a whole ADDED section stating the inverse, carried past
// a byte-for-byte snapshot by updating the fixture with `cp` in the same commit.
//
// Two lessons, both learned the expensive way:
//
//   1. ANY boundary drawn inside the file leaves the rest of the file to be a word-matching
//      problem again. Pinning one section moved the hole to every other section.
//   2. A snapshot whose fixture lives beside it can be updated with one `cp`, which defeats the
//      snapshot AND any presence check in the same motion. A presence check is not a negative:
//      `includes()` asserts the claim is still THERE, never that nothing contradicts it — which
//      is escape #3's shape, and it was re-shipped as a "fix" for escape #9.
//
// So what a fixture cannot carry lives HERE, in the test file, where updating it is a separate and
// visible act: the heading inventory, the caveman-line inventory, and the negative screens. `cp`
// on the fixture does not touch them.
//
// AND, STATED PLAINLY: none of this proves the skill cannot contradict itself. An author who edits
// the fixture AND this file can say anything. What the layers buy is that every route now requires
// a deliberate edit to a test file, which is a line in a diff a reviewer can question. The claim
// that is genuinely PROVEN is the runtime one — no caveman path in any reviewer or integrator
// dispatch artifact — because that is mechanically checkable. The prose layers are change
// detectors. Six rounds of calling a change detector a proof is what produced this comment.
const SKILL_URL = new URL('../skills/fleetmates-config/SKILL.md', import.meta.url)
const SKILL_FIXTURE_URL = new URL('./fixtures/fleetmates-config.SKILL.md', import.meta.url)

// LAYER 0 — THE ANCHOR THAT DOES NOT LIVE IN A FILE THE SKILL CAN BE COPIED OVER.
//
// The fixture is the weak link in every snapshot: `cp skills/... tests/fixtures/...` updates it in
// one motion, and layers 1 and 5 both go green. That is how escape #10 got in, and re-running the
// battery showed escape #7 — a contradicting sentence added INSIDE an existing section, naming
// neither "reviewer" nor "caveman" — was still green after five layers, because it adds no
// heading, no caveman token, and leaves the claim sentence intact.
//
// A digest constant lives in THIS file. `cp` on the fixture cannot touch it, so ANY byte change to
// the skill — added sentence, added section, reworded aside, trailing space — fails here first.
// This is the layer that actually closes the prose surface. The rest survive because they turn
// "the digest changed" into a message that says WHICH kind of change it was.
const SKILL_SHA256 = '0b2f9a9336f054237a9e8d1cce234f8133a8983d78049ed1f90254274df5381d'

test('the skill matches the digest recorded in this test file', async () => {
  const text = await readFile(SKILL_URL)
  const actual = createHash('sha256').update(text).digest('hex')
  assert.equal(actual, SKILL_SHA256,
    'skills/fleetmates-config/SKILL.md changed. Updating tests/fixtures/ is NOT enough — this ' +
    'constant is deliberately outside any file a `cp` from the skill can reach. Update it here, ' +
    'in the same commit, and say in the message what the measurement now is and why it changed')
})

// LAYER 1 — the readable diff. Redundant for DETECTION now that layer 0 exists; kept because a
// byte-equality failure prints what changed, and a digest mismatch prints two hex strings.
test('the fleetmates-config skill is exactly the reviewed text, byte for byte', async () => {
  const [text, fixture] = await Promise.all([
    readFile(SKILL_URL, 'utf8'),
    readFile(SKILL_FIXTURE_URL, 'utf8'),
  ])
  assert.equal(text, fixture,
    'skills/fleetmates-config/SKILL.md changed; if the change is intended, update ' +
    'tests/fixtures/fleetmates-config.SKILL.md in the SAME commit and say why in the message')
})

// LAYER 2 — the section inventory, which is what closes the `cp` route. An added section is the
// escape that carried an inversion past the byte snapshot; the allow-list lives here rather than
// in the fixture, so copying the skill over the fixture does not authorise it.
const HEADINGS = [
  '# Fleetmates Config',
  '## What `config` covers, and what it does not',
  '## What `caveman` actually reaches',
  '## Read before you write',
  '## Collect the change interactively',
  '## Never hand-edit a key `config set` accepts',
  '## Harness settings',
]

test('the skill has exactly the sections that were reviewed', async () => {
  const text = await readFile(SKILL_URL, 'utf8')
  const found = text.split('\n').filter((l) => /^#{1,6} /.test(l))
  assert.deepEqual(found, HEADINGS,
    'a section was added, removed or renamed; an ADDED section stating the inverse is escape #10, ' +
    'so add it to HEADINGS here deliberately rather than only updating the fixture')
})

// LAYER 3 — every caveman mention outside the pinned section, inventoried. Restored: a round-six
// fix narrowed this to a line filter and it stopped catching what it had caught.
const ALLOWED_CAVEMAN_LINES = [
  /^`config` manages the \*\*ergonomics\*\* keys only: `maxParallel`, `caveman`, and$/,
]

test('every mention of caveman outside the pinned section is accounted for', async () => {
  const text = await readFile(SKILL_URL, 'utf8')
  const i = text.indexOf('## What `caveman` actually reaches')
  const j = text.indexOf('\n## ', i + 10)
  const outside = text.slice(0, i) + (j === -1 ? '' : text.slice(j))
  const strays = outside.split('\n').filter((l) => /caveman/i.test(l))
    .filter((l) => !ALLOWED_CAVEMAN_LINES.some((a) => a.test(l.trim())))
  assert.deepEqual(strays, [],
    'a mention of caveman outside the pinned section is unreviewed; add it here deliberately')
})

// LAYER 4 — the doc-wide heading screen a round-six fix DELETED, restored with both halves. It
// keys on `caveman|level`, because the escape it was written for named "level" and not "caveman".
test('no heading pairs reviewers with the caveman level', async () => {
  const text = await readFile(SKILL_URL, 'utf8')
  const offenders = text.split('\n')
    .filter((l) => /^#{1,6} /.test(l))
    .filter((l) => /reviewer|lens|grading/i.test(l) && /caveman|level/i.test(l))
  assert.deepEqual(offenders, [],
    'a heading can state the inverse of the claim without any sentence doing so')
})

// LAYER 5 — the bytes still SAY the thing. Presence only, and deliberately labelled as such: this
// catches deletion and alteration of the claim, never an addition beside it. Layer 2 is what
// covers additions.
test('the pinned skill still states that reviewers are unaffected by caveman', async () => {
  const text = await readFile(SKILL_URL, 'utf8')
  assert.ok(
    text.includes('Reviewer and integrator dispatches carry no caveman path at all, so the\nreviewers — the largest emitters in a run — are unaffected by any value you set.'),
    'the load-bearing sentence must survive verbatim in the skill',
  )
  assert.ok(
    text.includes('The caveman brief is **larger** than the default, by about 3%.'),
    'the measurement that motivates the claim must survive verbatim',
  )
})

// LAYER 6 — the operator-facing copies. README was bound by nothing until round six; CHANGELOG was
// bound by nothing until round seven, and states the measurement in MORE detail than either pinned
// file. Exact sentences rather than whole-file snapshots: both are long and edited constantly for
// reasons that have nothing to do with this claim.
test('every operator-facing copy of the claim says the same thing', async () => {
  const [readme, changelog] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
  ])
  assert.ok(
    readme.includes('Reviewer and integrator dispatches carry no caveman path, so the\nreviewers — the largest emitters in a run — are unaffected by any value you set.'),
    'README.md must carry the claim verbatim',
  )
  assert.ok(
    changelog.includes('`scripts/review-gen.mjs` has no caveman path, so reviewers — the largest emitters, at 22,900 and\n  12,965 output tokens — never receive the instruction at all.'),
    'CHANGELOG.md carries the same measurement in more detail and must not drift from it',
  )
})

// THE ONE LAYER THAT IS A PROOF RATHER THAN A CHANGE DETECTOR. The claim is about RUNTIME, and
// every prior round attacked the prose — so once the prose was pinned, the next hole was the
// artifact the prose describes. `review-gen.mjs` builds the dispatch; `agents/tm-reviewer.md` and
// `agents/tm-integrator.md` ARE the dispatch prompts, and were bound by nothing: a caveman path
// added to either makes the pinned sentence false at runtime with every prose layer still green.
test('caveman never reaches a reviewer or integrator dispatch', async () => {
  const artifacts = [
    '../scripts/review-gen.mjs',
    '../agents/tm-reviewer.md',
    '../agents/tm-integrator.md',
  ]
  for (const rel of artifacts) {
    const source = await readFile(new URL(rel, import.meta.url), 'utf8')
    assert.ok(!/caveman/i.test(source),
      `${rel} must carry no caveman path; the skill claims reviewers and integrators are unaffected`)
  }
})

test('the skill states that the terse brief is larger, not smaller', async () => {
  // Named subject, not a bare comparative. `/(larger|longer|bigger)/i` matched any unrelated
  // sentence in the skill — "no longer" alone satisfied it — so the claim this test exists to
  // pin could be deleted outright and the suite stayed green. Found by mutation.
  assertStatement(
    await doc(),
    /caveman brief[\s\S]*\blarger\b[\s\S]*than the default/i,
    'fleetmates-config must say the caveman brief is larger than the default',
  )
  assertNoStatement(
    await doc(),
    /caveman[\s\S]*brief[\s\S]*\b(smaller|shorter|terser|briefer)\b/i,
    'fleetmates-config must not claim the caveman brief is smaller',
  )
})

test('the caveman brief is in fact larger than the default brief', () => {
  // The claim above is only worth making because the arithmetic runs the other way from the
  // name. The STYLE block costs more than the compressed connective prose saves, and a brief
  // sits in the agent's prefix, so that cost is re-read on every turn.
  assert.ok(
    brief('full').length > brief(false).length,
    'expected the caveman brief to be longer than the default brief',
  )
})

test('the digest renderer ignores the caveman level and reads only its truthiness', () => {
  const status = {
    runId: 'r1',
    phase: 1,
    totalPhases: 2,
    maxParallel: 4,
    tasks: [{ id: 'T1', title: 'a task', state: 'running', startedAt: 1000 }],
  }
  const now = 61000
  const lite = renderDigest(status, now, 'lite')
  const ultra = renderDigest(status, now, 'ultra')
  assert.equal(lite, ultra, 'lite and ultra must render identically; the level is not honoured')
  assert.notEqual(lite, renderDigest(status, now, false), 'a truthy level must still change the digest')
})

test('the skill states that effort, not caveman, is the control for thinking', async () => {
  assertStatement(
    await doc(),
    /effort[\s\S]*thinking/i,
    'fleetmates-config must name effort as the control for thinking tokens',
  )
})

// The skill said "The four levels are validated" while CAVEMAN_LEVELS has three. Nothing bound the
// prose to the constant, so the count could drift in either direction unnoticed — and a document
// whose whole purpose is to state a measured scope had the wrong number in it.
test('the skill states the level count the code actually validates', async () => {
  assert.equal(CAVEMAN_LEVELS.length, 3, 'the fixture below names three; update both together')
  assertStatement(
    await doc(),
    /three levels[\s\S]*validated/i,
    'fleetmates-config must state the same level count CAVEMAN_LEVELS defines',
  )
  assertNoStatement(
    await doc(),
    /\b(two|four|five)\s+levels\b/i,
    'fleetmates-config must not name a level count the code does not validate',
  )
})

// The skill was bound to CAVEMAN_LEVELS; the README and CHANGELOG carry the same sentence and were
// NOT — mutating either back to "four levels" left the suite green while a followups doc claimed
// the two "cannot drift apart again in either direction". Bound here, so the claim is true.
test('the README and CHANGELOG state the level count the code validates', async () => {
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six']
  const correct = WORDS[CAVEMAN_LEVELS.length]
  // The wrong spellings are derived by EXCLUDING the right one, not hard-coded. A fixed list of
  // `(two|four|five)` contradicted the assertion above it for any count in that list — the two
  // could never both hold — so the test was unsatisfiable the moment CAVEMAN_LEVELS changed to one
  // of them, which is precisely when it needed to work.
  const wrong = WORDS.filter((w) => w !== correct).join('|')
  // README ONLY. CHANGELOG.md is a record of what a release said, so binding it to the LIVE
  // constant would make a future level change fail a test about a shipped version — history
  // rewritten to keep a test green. Its entry is checked against a fixed spelling below instead:
  // it was wrong when written, which is a different fault from drifting later.
  for (const file of ['../README.md']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8')
    // NO `continue` guard. Skipping when the sentence is absent let the binding evaporate on the
    // exact reword it exists to catch: delete the claim and the file stops being checked at all.
    assert.match(text, new RegExp(`${correct} levels are validated`, 'i'),
      `${file} must name the same level count CAVEMAN_LEVELS defines`)
    assert.doesNotMatch(text, new RegExp(`\\b(${wrong}) levels are validated`, 'i'),
      `${file} names a level count the code does not validate`)
  }

  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(changelog, /three levels are validated/i,
    'the CHANGELOG entry stated four when the code validated three; it is corrected, not bound')
})

// The scoping is the point, so it is pinned: prose elsewhere in the skill must not fail the test
// that speaks for the caveman section. Without this, an editor adding an unrelated paragraph gets
// a caveman-scope failure and learns to distrust the assertion.
test('prose in an unrelated section does not fail the caveman claim', async () => {
  const text = await readFile(new URL('../skills/fleetmates-config/SKILL.md', import.meta.url), 'utf8')
  const { body } = splitFrontmatter(text, 'fleetmates-config')
  const edited = `${body}\n\n## Troubleshooting\n\nThe above requirement applies to every layer.\n`
  const parsed = parseDoc(edited, 'fleetmates-config/SKILL.md (edited)')
  const section = findCavemanSection(parsed)
  assertClaim(section, {
    label: 'reviewers are unaffected by caveman',
    claim: /Reviewer and integrator dispatches carry no caveman path at all/,
    subject: /reviewer/i,
    // No `allow` entries: both that were here matched nothing in the screened section — one
    // appears nowhere in the skill, the other lives in a different section — so they were carried
    // over from when `assertClaim` ran document-wide. A dead allow entry only makes the screen
    // stricter, so this is not a hole; it is a list that had stopped describing anything.
    allow: [],
  })
})
