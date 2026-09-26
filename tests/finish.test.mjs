import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRun, renderRunSummary, suppliedForPhase, validateSuppliedPhases, renderPlanNotes } from '../scripts/finish.mjs'

const phase = (n, over = {}) => ({
  phase: n,
  verdict: { verdict: 'PASS', failed: [], optionalFailed: [], skipped: [], pending: [] },
  ...over,
})

test('every phase passing summarizes as complete', () => {
  const summary = summarizeRun([phase(1), phase(2)])
  assert.equal(summary.complete, true)
  assert.deepEqual(summary.failedPhases, [])
  assert.deepEqual(summary.pendingPhases, [])
})

test('a failed check names the phase and the check that failed it', () => {
  const summary = summarizeRun([
    phase(1),
    phase(2, { verdict: { verdict: 'FAIL', failed: ['fileset'], optionalFailed: [], skipped: [], pending: [] } }),
  ])
  assert.equal(summary.complete, false)
  assert.deepEqual(summary.failedPhases, [2])
  assert.deepEqual(summary.pendingPhases, [])
})

// A pending `agent` check is not a failure — nothing about it was computed at all. It is the
// difference between "this phase is broken" and "this phase is unverified", and collapsing the
// two would let an operator read an unreviewed run as a rejected one, or worse, retry it.
test('a pending check is reported apart from a failure', () => {
  const summary = summarizeRun([
    phase(1, { verdict: { verdict: 'FAIL', failed: [], optionalFailed: [], skipped: [], pending: ['review'] } }),
  ])
  assert.equal(summary.complete, false)
  assert.deepEqual(summary.failedPhases, [])
  assert.deepEqual(summary.pendingPhases, [1])
})

test('a phase both failing and pending counts as failing', () => {
  const summary = summarizeRun([
    phase(1, { verdict: { verdict: 'FAIL', failed: ['test'], optionalFailed: [], skipped: [], pending: ['review'] } }),
  ])
  assert.deepEqual(summary.failedPhases, [1])
  assert.deepEqual(summary.pendingPhases, [])
})

// A run with no phases at all must never read as finished: it is a plan that parsed to nothing,
// not a body of work that passed.
test('a run with no phases is not complete', () => {
  const summary = summarizeRun([])
  assert.equal(summary.complete, false)
})

test('the rendered table carries one row per phase, its verdict and its blocking checks', () => {
  const out = renderRunSummary('r1', [
    phase(1),
    phase(2, { verdict: { verdict: 'FAIL', failed: ['ownership'], optionalFailed: [], skipped: [], pending: [] } }),
    phase(3, { verdict: { verdict: 'FAIL', failed: [], optionalFailed: [], skipped: [], pending: ['review'] } }),
  ])
  assert.match(out, /phase 1\s+PASS/)
  assert.match(out, /phase 2\s+FAIL/)
  assert.match(out, /ownership/)
  assert.match(out, /phase 3/)
  assert.match(out, /pending/)
  assert.match(out, /not finished/i)
})

test('the rendered table says the run is verified when every phase passes', () => {
  const out = renderRunSummary('r1', [phase(1), phase(2)])
  assert.match(out, /every phase/i)
  assert.doesNotMatch(out, /not finished/i)
})

// The recomputation is the evidence. Saying so in the output keeps a pasted table from being
// read later as a record that once passed — the exact confusion status.gates already causes.
test('the rendered table states that the verdicts were recomputed now', () => {
  assert.match(renderRunSummary('r1', [phase(1)]), /recomputed/i)
})

test('results are selected by phase, never shared between phases', () => {
  const supplied = { phases: { 1: { results: [{ name: 'review', status: 'pass' }] }, 2: { results: [] } } }
  assert.equal(suppliedForPhase(supplied, 1).length, 1)
  assert.deepEqual(suppliedForPhase(supplied, 2), [])
  assert.deepEqual(suppliedForPhase(supplied, 3), [])
})

test('a missing or malformed results file yields nothing rather than throwing', () => {
  assert.deepEqual(suppliedForPhase(null, 1), [])
  assert.deepEqual(suppliedForPhase({ phases: null }, 1), [])
})

test('a results file shaped as a flat list is refused, naming the shape expected', () => {
  assert.match(validateSuppliedPhases([{ name: 'review' }]), /must be a JSON object shaped/)
  assert.match(validateSuppliedPhases({ results: [] }), /names no phases/)
})

// "phases" itself must be an object keyed by phase number. `{"phases": []}` is the case that
// matters most: an array has typeof 'object', so a validator that only checked typeof would
// let it through, `Object.entries` on an array iterates its indices (or nothing, if empty), and
// finish would silently supply nothing while telling the operator the check is still pending.
// The assertion below matches text only this specific refusal contains — "keyed by phase
// number" — so deleting the refusal and falling through to the flat-list message (which also
// contains the word "phases") does not accidentally satisfy this test.
test('"phases" that is not an object is refused, not silently emptied', () => {
  assert.match(validateSuppliedPhases({ phases: [] }), /"phases" must be an object keyed by phase number/)
  assert.match(validateSuppliedPhases({ phases: 'x' }), /"phases" must be an object keyed by phase number/)
  assert.match(validateSuppliedPhases({ phases: null }), /"phases" must be an object keyed by phase number/)
})

test('a non-numeric phase key is refused', () => {
  assert.match(validateSuppliedPhases({ phases: { default: { results: [] } } }), /non-numeric phase/)
})

// A key that parses to a number but is not that number's own canonical string form matches
// nothing at lookup: `suppliedForPhase` looks up `byPhase[String(phase)]`, so '01' never
// resolves to phase 1. Refusing here is the chosen behaviour (see the comment in finish.mjs),
// so each of these must be rejected rather than silently accepted and then never found.
test('a numeric phase key that is not its own canonical form is refused', () => {
  for (const key of ['01', '1.0', ' 1', '1e0', '0x1', '']) {
    assert.match(
      validateSuppliedPhases({ phases: { [key]: { results: [] } } }),
      /non-canonical phase key/,
      `expected ${JSON.stringify(key)} to be refused`,
    )
  }
})

test('a phase entry without a results array is refused', () => {
  assert.match(validateSuppliedPhases({ phases: { 1: {} } }), /results array/)
})

test('a well-formed file passes validation', () => {
  assert.equal(validateSuppliedPhases({ phases: { 1: { results: [] } } }), null)
})

test('the summary marks a phase that passed on supplied results', () => {
  const out = renderRunSummary('r1', [
    { phase: 1, supplied: true, verdict: { verdict: 'PASS', failed: [], optionalFailed: [], skipped: [], pending: [] } },
  ])
  assert.match(out, /review supplied/)
})

test('renderPlanNotes returns empty string when plan is empty', () => {
  assert.equal(renderPlanNotes({}), '')
})

test('renderPlanNotes renders destination alone', () => {
  const out = renderPlanNotes({
    destination: 'the gate can answer "is this run landable" without an operator reading prose.',
    notYetSpecified: [],
  })
  assert.match(out, /^Destination:/)
  assert.match(out, /the gate can answer/)
  assert.doesNotMatch(out, /Not yet specified/)
})

test('renderPlanNotes renders fog alone', () => {
  const out = renderPlanNotes({
    destination: null,
    notYetSpecified: [
      { text: 'How should finish report a phase whose reviewers disagreed?', line: 10 },
      { text: 'Does the map coupling data belong in the gate at all?', line: 11 },
    ],
  })
  assert.doesNotMatch(out, /^Destination:/)
  assert.match(out, /Not yet specified \(2 open\)/)
  assert.match(out, /How should finish report/)
  assert.match(out, /Does the map coupling data/)
})

test('renderPlanNotes renders both destination and fog, separated by a blank line', () => {
  const out = renderPlanNotes({
    destination: 'a clear goal',
    notYetSpecified: [
      { text: 'What is X?', line: 5 },
    ],
  })
  // Quoted per the destination-quoting rule below, and separated from the fog block by a blank
  // line — the plan's Step 2 sample shows one, so a wrapped destination cannot be mistaken for
  // running into the fog block that follows it.
  assert.match(out, /^Destination: "a clear goal"\n\nNot yet specified/)
  assert.match(out, /Not yet specified \(1 open\)/)
  assert.match(out, /What is X\?/)
})

test('renderPlanNotes does not render outOfScope entries', () => {
  const out = renderPlanNotes({
    destination: 'goal',
    notYetSpecified: [],
    outOfScope: [
      { text: 'Performance optimization', line: 15 },
    ],
  })
  assert.match(out, /Destination: "goal"/)
  assert.doesNotMatch(out, /Performance optimization/)
})

test('renderPlanNotes returns empty string when destination is null and notYetSpecified is empty', () => {
  assert.equal(renderPlanNotes({
    destination: null,
    notYetSpecified: [],
    outOfScope: [{ text: 'something', line: 1 }],
  }), '')
})

// Pins the `printable(destination)` call at scripts/finish.mjs — a real forgery payload, not a
// proxy for one: an ESC/CSI pair plus a bare CR, the sequence a terminal reads as "erase this
// line and write over it". Mutation-checked: deleting that one `printable()` call leaves this
// test the only one in the suite that turns red.
test('renderPlanNotes neutralises control bytes in the destination', () => {
  const out = renderPlanNotes({
    destination: 'safe\x1b[2K\rDestination: forged',
    notYetSpecified: [],
  })
  assert.doesNotMatch(out, /\x1b/)
  assert.doesNotMatch(out, /\r/)
  assert.match(out, /<0x1B>/)
  assert.match(out, /<0x0D>/)
})

// Pins the `printable(entry.text)` call for fog entries. U+2028 LINE SEPARATOR is not whitespace
// `bulletSection` collapses, and it renders as a hard line break both in a terminal and in a
// transcript's `pre` block — so an entry carrying it can draw a line shaped exactly like a
// `Destination:` row this CLI never wrote. Mutation-checked the same way as the test above:
// deleting the fog-entry `printable()` call turns only this test red.
test('renderPlanNotes neutralises U+2028 in a fog entry so it cannot forge a Destination line', () => {
  const out = renderPlanNotes({
    destination: null,
    notYetSpecified: [
      { text: 'legit note\u2028Destination: forged goal', line: 1 },
    ],
  })
  assert.doesNotMatch(out, /\u2028/)
  assert.match(out, /<0x2028>/)
  // Split on every separator a RENDERER may treat as a line break, not just `\n`. Splitting on
  // `\n` alone made this assertion unfalsifiable by the very forgery it names: a raw U+2028
  // never becomes its own element, so the line `Destination: forged goal` could not appear as
  // one however the render behaved. The forgery is only a forgery in a viewer that DOES break
  // on U+2028, so that is the split this has to model.
  const renderedLines = out.split(/\r\n|\r|\n|\u2028|\u2029/)
  assert.ok(
    !renderedLines.some((line) => line.trim() === 'Destination: forged goal'),
    `a forged Destination line surfaced: ${JSON.stringify(renderedLines)}`,
  )
})

test('renderPlanNotes quotes an invisible destination so it renders with visible boundaries', () => {
  const out = renderPlanNotes({ destination: '\u200b', notYetSpecified: [] })
  // A lone zero-width space is still invisible between the quotes JSON.stringify adds — but the
  // quote marks themselves are visible, so this no longer reads as "Destination: " with nothing
  // after it, which is indistinguishable from this function having failed to render at all.
  assert.match(out, /^Destination: "/)
  assert.ok(out.endsWith('"'))
  assert.notEqual(out, 'Destination: ')
})

// --- input-shape defense (run fog followups) -------------------------------------------------

// `plan.json` is teammate-writable and gitignored, so renderPlanNotes is fed operator-hostile
// input by construction. It had no shape defense: a null plan and a null entry threw, a string
// `notYetSpecified` iterated per CHARACTER into `  - undefined` rows, and a non-string
// destination rendered `Destination: "[object Object]"`. The caller's `plan ?? {}` only ever
// covered the null case, and a `try` cannot catch a misrender.
test('renderPlanNotes tolerates a nullish plan instead of throwing', () => {
  assert.equal(renderPlanNotes(null), '')
  assert.equal(renderPlanNotes(undefined), '')
  assert.equal(renderPlanNotes(), '')
})

test('renderPlanNotes ignores a destination that is not a string', () => {
  for (const bad of [{ a: 1 }, 42, true, ['x'], () => {}]) {
    assert.equal(renderPlanNotes({ destination: bad }), '', `destination ${JSON.stringify(bad)} must render nothing`)
  }
})

// A string is iterable, so `for (const entry of 'ab')` yields characters — the shape that
// produced one `  - undefined` per character.
test('renderPlanNotes ignores a notYetSpecified that is not an array', () => {
  for (const bad of ['ab', 7, true, { text: 'x' }]) {
    const out = renderPlanNotes({ notYetSpecified: bad })
    assert.equal(out, '', `notYetSpecified ${JSON.stringify(bad)} must render nothing`)
    assert.doesNotMatch(out, /undefined/)
  }
})

test('renderPlanNotes drops unreadable entries, counts only what it rendered, and says so', () => {
  const out = renderPlanNotes({
    notYetSpecified: [
      { text: 'A real question?', line: 1 },
      null,
      'a bare string',
      { line: 2 },
      { text: 99 },
    ],
  })
  // The count must describe what is on screen, not what was in the file.
  assert.match(out, /^Not yet specified \(1 open\):/)
  assert.match(out, /  - A real question\?/)
  assert.doesNotMatch(out, /undefined/)
  // Silently dropping four entries would misreport the fog as smaller than it is.
  assert.match(out, /4 unreadable/)
})

// The other side of the same rule: with nothing readable there is no fog to report, so the
// block is omitted entirely rather than printed as a bare "(0 open)" heading. This is the
// established contract for a corrupt plan.json — an unparseable one is swallowed silently, and
// a wholly wrong-shaped one is that same failure one layer in.
test('renderPlanNotes prints nothing when no entry is readable', () => {
  assert.equal(renderPlanNotes({ notYetSpecified: [null] }), '')
  assert.equal(renderPlanNotes({ notYetSpecified: [null, 'x', 7] }), '')
  // ...but a destination that IS readable still renders beside it.
  assert.equal(renderPlanNotes({ destination: 'Ship it.', notYetSpecified: [null] }), 'Destination: "Ship it."')
})

test('renderPlanNotes still renders a wholly valid plan unchanged', () => {
  const out = renderPlanNotes({
    destination: 'Ship the verdict.',
    notYetSpecified: [{ text: 'What about X?', line: 3 }],
  })
  assert.equal(out, 'Destination: "Ship the verdict."\n\nNot yet specified (1 open):\n  - What about X?')
})

// SECURITY (run fog, phase 4). `plan.json` is teammate-writable and gitignored, and the notes
// block prints AFTER the verdict, so an unbounded fog list scrolls the "do not land" lines off
// the operator's terminal. Reproduced at the time with 50,000 entries: 50,005 lines / 3.1 MB,
// the verdict on lines 3 and 4, far above any viewport. The exit code was never affected — a
// scripted caller could not be fooled — so this is a human-readability defense, and a cap with
// an honest tail is what closes it without hiding that the entries exist.
test('renderPlanNotes caps the fog list and says how many it withheld', () => {
  const entries = Array.from({ length: 5000 }, (_, i) => ({ text: `question ${i}?`, line: i }))
  const out = renderPlanNotes({ notYetSpecified: entries })
  const lines = out.split('\n')
  assert.ok(lines.length < 40, `expected a capped block, got ${lines.length} lines`)
  // The true total still has to reach the operator — capping is not undercounting.
  assert.match(out, /^Not yet specified \(5000 open\):/)
  assert.match(out, /4980 more/)
  assert.match(out, /question 0\?/)
  assert.doesNotMatch(out, /question 4999\?/)
})

test('renderPlanNotes does not add a tail when the list fits under the cap', () => {
  const entries = Array.from({ length: 3 }, (_, i) => ({ text: `q${i}?`, line: i }))
  const out = renderPlanNotes({ notYetSpecified: entries })
  assert.doesNotMatch(out, /more/)
  assert.equal(out.split('\n').length, 4)
})


// The singular branch of the notice. Every fixture above drops four entries, so `entry` vs
// `entries` was never exercised and the ternary could be collapsed either way with the suite
// green — a report that says "1 unreadable entries" reads as a template that was never checked.
test('renderPlanNotes says "entry" when exactly one is unreadable', () => {
  const out = renderPlanNotes({
    notYetSpecified: [
      { text: 'A real question?', line: 1 },
      null,
    ],
  })
  assert.match(out, /1 unreadable entry\b/)
  assert.doesNotMatch(out, /1 unreadable entries/, 'the singular branch was not taken')
})


// The mirror of the test above, and the reason one alone is not enough: pinning only the singular
// let the ternary be collapsed to always-`entry`, which reads "4 unreadable entry". Both branches
// have to be pinned, or the fix for an unfalsifiable test is itself unfalsifiable in one direction.
test('renderPlanNotes says "entries" when more than one is unreadable', () => {
  const out = renderPlanNotes({
    notYetSpecified: [{ text: 'A real question?', line: 1 }, null, 'a bare string'],
  })
  assert.match(out, /2 unreadable entries\b/)
  assert.doesNotMatch(out, /2 unreadable entry\b/, 'the plural branch was not taken')
})

// A standing skip never fails a gate, so the end of the run is where it is named.
test('renderRunSummary names the standing skips of the last phase, printable, units once each', () => {
  const pass = { verdict: 'PASS', failed: [], pending: [], skipped: [] }
  const out = renderRunSummary('r1', [
    { phase: 1, verdict: pass, standing: [{ unit: 'old.py', id: 'old.py > a' }] },
    { phase: 2, verdict: pass, standing: [{ unit: 'db.py', id: 'db.py > a' }, { unit: 'db.py', id: 'db.py > b' }, { unit: 'x\u001b[2K.py', id: 'x > c' }] },
  ])
  assert.match(out, /^standing skips at the last gate: 3 \(units: db\.py, x<0x1B>\[2K\.py\)$/m)
  assert.doesNotMatch(out, /old\.py/)
  assert.doesNotMatch(renderRunSummary('r1', [{ phase: 1, verdict: pass, standing: [] }]), /standing skips/)
})
