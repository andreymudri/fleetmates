import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bulletSection,
  proseSection,
  parsePlanSections,
  PlanSectionError,
} from '../scripts/plan-sections.mjs'

// The 1-based line of the first line that contains `needle`. Tests assert error line numbers
// against this rather than against a hand-counted constant: a hand-counted line drifts the
// moment anyone edits a fixture above it, and drifts silently.
function lineOf(markdown, needle) {
  const index = markdown.split('\n').findIndex((line) => line.includes(needle))
  assert.notEqual(index, -1, `fixture is missing its anchor: ${needle}`)
  return index + 1
}

const FULL = `# A plan

## Statement

Make the gate answer from git,
without an operator.

## Acceptance

- The verdict needs no operator
- A second run gives the same verdict

## Destination

The gate answers PASS or FAIL from git alone,
with no operator in the loop.

## Global Constraints

- Node >= 24.2.0

## Not Yet Specified

- Where does a resolved fog entry go once someone decides it?
- Should \`status\` show open fog too, or is that only a landing concern?

## Out of Scope

- Caching — the destination is the verdict, not latency
- Token usage — worth its own spec

### Task 1: something

**Files:**
- Create: \`scripts/thing.mjs\`
`

test('all three sections are parsed from one document', () => {
  const sections = parsePlanSections(FULL)
  assert.equal(
    sections.destination,
    'The gate answers PASS or FAIL from git alone, with no operator in the loop.',
  )
  assert.deepEqual(
    sections.notYetSpecified.map((entry) => entry.text),
    [
      'Where does a resolved fog entry go once someone decides it?',
      'Should `status` show open fog too, or is that only a landing concern?',
    ],
  )
  assert.deepEqual(
    sections.outOfScope.map((entry) => entry.text),
    [
      'Caching — the destination is the verdict, not latency',
      'Token usage — worth its own spec',
    ],
  )
  assert.equal(
    sections.notYetSpecified[0].line,
    lineOf(FULL, 'Where does a resolved fog entry go'),
  )
  assert.equal(sections.outOfScope[1].line, lineOf(FULL, 'Token usage'))
})

test('no section leaks a task heading or a task file bullet into itself', () => {
  const sections = parsePlanSections(FULL)
  const all = [...sections.notYetSpecified, ...sections.outOfScope].map((e) => e.text)
  for (const text of all) assert.ok(!text.includes('scripts/thing.mjs'), text)
  assert.ok(!sections.destination.includes('Global Constraints'))
})

test('a document with none of the three sections parses to the empty shape', () => {
  const sections = parsePlanSections('# A plan\n\n### Task 1: something\n')
  assert.deepEqual(sections, { destination: null, notYetSpecified: [], outOfScope: [], statement: null, acceptance: [] })
})

test('parsePlanSections tolerates a nullish document', () => {
  assert.deepEqual(parsePlanSections(undefined), {
    destination: null,
    notYetSpecified: [],
    outOfScope: [],
    statement: null,
    acceptance: [],
  })
})

test('Destination alone parses, with the other two empty', () => {
  const md = '# A plan\n\n## Statement\n\nDo the thing.\n\n## Acceptance\n\n- The thing is done\n\n## Destination\n\nSomewhere specific.\n'
  const sections = parsePlanSections(md)
  assert.equal(sections.destination, 'Somewhere specific.')
  assert.deepEqual(sections.notYetSpecified, [])
  assert.deepEqual(sections.outOfScope, [])
})

test('Not Yet Specified alone parses, with no destination and no out of scope', () => {
  const md = '# A plan\n\n## Not Yet Specified\n\n- Which store owns this?\n'
  const sections = parsePlanSections(md)
  assert.equal(sections.destination, null)
  assert.deepEqual(
    sections.notYetSpecified.map((e) => e.text),
    ['Which store owns this?'],
  )
  assert.deepEqual(sections.outOfScope, [])
})

test('Out of Scope alone is refused, because it has no Destination to be beyond', () => {
  const md = '# A plan\n\n## Out of Scope\n\n- Caching — worth its own spec\n'
  assert.ok(md.includes('## Out of Scope'), 'fixture must carry the section it is refused for')
  assert.ok(!md.includes('## Destination'), 'fixture must not carry a destination')
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-destination')
      assert.equal(error.line, null)
      assert.equal(error.entry, null)
      return true
    },
  )
})

test('Out of Scope with a Destination is accepted', () => {
  const md = '# A plan\n\n## Statement\n\nDo the thing.\n\n## Acceptance\n\n- The thing is done\n\n## Destination\n\nSomewhere.\n\n## Out of Scope\n\n- Caching — its own spec\n'
  assert.deepEqual(
    parsePlanSections(md).outOfScope.map((e) => e.text),
    ['Caching — its own spec'],
  )
})

const SEPARATORS = [
  ['an em dash', 'Caching — the destination is the verdict'],
  ['an en dash', 'Caching – the destination is the verdict'],
  ['a spaced hyphen', 'Caching - the destination is the verdict'],
  ['a spaced double hyphen', 'Caching -- the destination is the verdict'],
]

for (const [name, entry] of SEPARATORS) {
  test(`a reason clause introduced by ${name} is accepted`, () => {
    const md = `## Statement\n\nDo the thing.\n\n## Acceptance\n\n- The thing is done\n\n## Destination\n\nSomewhere.\n\n## Out of Scope\n\n- ${entry}\n`
    assert.ok(md.includes(entry), 'fixture must carry the entry under test')
    assert.deepEqual(
      parsePlanSections(md).outOfScope.map((e) => e.text),
      [entry],
    )
  })
}

test('a separator with nothing after it is not a reason clause', () => {
  const md = '## Statement\n\nDo the thing.\n\n## Acceptance\n\n- The thing is done\n\n## Destination\n\nSomewhere.\n\n## Out of Scope\n\n- Caching —\n'
  assert.ok(md.includes('- Caching —'), 'fixture must carry the malformed entry')
  assert.throws(() => parsePlanSections(md), PlanSectionError)
})

test('a bare noun in Out of Scope is refused, naming its line and quoting it', () => {
  const md = `# A plan

## Statement

Do the thing.

## Acceptance

- The thing is done

## Destination

Somewhere specific.

## Out of Scope

- Caching — the destination is the verdict, not latency
- Caching
`
  assert.ok(md.split('\n').includes('- Caching'), 'fixture must carry the bare noun')
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-reason')
      assert.equal(error.entry, 'Caching')
      assert.equal(error.line, md.split('\n').indexOf('- Caching') + 1)
      assert.equal(error.index, 2)
      return true
    },
  )
})

test('a fog entry whose question mark is mid sentence is accepted', () => {
  const entry = 'Where does a resolved entry go? It depends on who decides it.'
  const md = `## Not Yet Specified\n\n- ${entry}\n`
  assert.ok(md.includes(entry), 'fixture must carry the entry under test')
  assert.deepEqual(
    parsePlanSections(md).notYetSpecified.map((e) => e.text),
    [entry],
  )
})

test('a fog entry with no question mark anywhere is refused, naming its line', () => {
  const md = `# A plan

## Not Yet Specified

- Should status show open fog too?
- Rewrite scripts/reviews.mjs
`
  assert.ok(
    md.split('\n').includes('- Rewrite scripts/reviews.mjs'),
    'fixture must carry the work item wearing a note as clothes',
  )
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-question')
      assert.equal(error.entry, 'Rewrite scripts/reviews.mjs')
      assert.equal(error.line, lineOf(md, 'Rewrite scripts/reviews.mjs'))
      assert.equal(error.index, 2)
      return true
    },
  )
})

test('PlanSectionError is an Error subclass with its own name and own properties', () => {
  const error = new PlanSectionError('a message', { line: 4, entry: 'x', reason: 'missing-reason' })
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'PlanSectionError')
  assert.equal(error.message, 'a message')
  for (const key of ['line', 'entry', 'reason']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(error, key),
      `${key} must be an own property, so a caller can format without re-parsing the message`,
    )
  }
})

test('bulletSection terminates at the next heading of any level', () => {
  const md = `## Out of Scope

- Caching — its own spec

### Task 1: something

**Files:**
- Create: \`scripts/thing.mjs\`
`
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — its own spec'],
  )
})

test('bulletSection joins a wrapped bullet into one entry', () => {
  const md = '## Out of Scope\n\n- Caching — worth its own spec,\n  and a different destination\n'
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — worth its own spec, and a different destination'],
  )
})

test('a wrapped bullet reports the line of its first line', () => {
  const md = '## Out of Scope\n\n- Caching — worth its own spec,\n  and a different destination\n'
  assert.equal(bulletSection(md, 'Out of Scope')[0].line, lineOf(md, '- Caching'))
})

test('a blank line closes a bullet, so a following indented paragraph is not swallowed', () => {
  const md = '## Out of Scope\n\n- Caching — its own spec\n\n  An unrelated indented paragraph.\n'
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — its own spec'],
  )
})

test('a bullet containing U+2028 survives, because the patterns use a negated newline class', () => {
  const entry = 'Caching still one entry — its own spec'
  const md = `## Out of Scope

- ${entry}
`
  assert.ok(md.includes(' '), 'fixture must actually carry the separator under test')
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    [entry],
  )
})

// Reproduced: `bulletSection` matched only the `-` marker, so a section written with `*` or
// `+` bullets (both valid CommonMark) yielded no entries at all — and for `## Out of Scope`/
// `## Not Yet Specified` that meant every refusal was silently skipped, because a section that
// parses to zero entries has nothing to refuse. This comment used to add "and both used in this
// project's own plans", which is false and was worth checking rather than repeating: there are
// ZERO `*` bullets in docs/plans and docs/specs, and every `+` at a line start is inside a code
// fence or a JS string concatenation. Nothing here depended on the claim, but a reader deciding
// whether the widening still earns its keep would have been told the wrong thing.
//
// This test pins the BULLET pattern's marker class only. The continuation lookahead's matching
// class is a separate half, pinned by `a bare \`*\` or \`+\` marker line is dropped, not joined
// onto the entry above` — a bare `*` or `+` line is the only input the two patterns disagree
// about.
test('bulletSection recognises `-`, `*` and `+` as bullet markers', () => {
  const md = '## Out of Scope\n\n- Dash — its own spec\n* Star — its own spec\n+ Plus — its own spec\n'
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Dash — its own spec', 'Star — its own spec', 'Plus — its own spec'],
  )
})

test('a `*` bulleted entry still joins its wrapped continuation line', () => {
  const md = '## Out of Scope\n\n* Caching — worth its own spec,\n  and a different destination\n'
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — worth its own spec, and a different destination'],
  )
})

test('a `+` bulleted entry still joins its wrapped continuation line', () => {
  const md = '## Out of Scope\n\n+ Caching — worth its own spec,\n  and a different destination\n'
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — worth its own spec, and a different destination'],
  )
})

// An entry-level refusal must still fire when the section is written with `*` bullets — not
// only for `-`, which is the one shape a marker-narrow implementation happens to see.
test('a `*` bulleted Out of Scope entry with no reason is still refused', () => {
  const md = '## Statement\n\nDo the thing.\n\n## Acceptance\n\n- The thing is done\n\n## Destination\n\nSomething landable.\n\n## Out of Scope\n\n* Caching\n'
  assert.throws(
    () => parsePlanSections(md),
    (err) => err instanceof PlanSectionError && err.reason === 'missing-reason' && err.entry === 'Caching',
  )
})

test('a `*` bulleted Not Yet Specified entry with no question mark is still refused', () => {
  const md = '## Not Yet Specified\n\n* no question at all\n'
  assert.throws(
    () => parsePlanSections(md),
    (err) => err instanceof PlanSectionError && err.reason === 'missing-question' && err.entry === 'no question at all',
  )
})

test('bulletSection returns an empty array when the heading is absent', () => {
  assert.deepEqual(bulletSection('# A plan\n', 'Out of Scope'), [])
})

test('a heading with regex metacharacters is matched literally, not as a pattern', () => {
  assert.deepEqual(bulletSection('## Out of Scope\n\n- x\n', 'Out.of.Scope'), [])
})

test('proseSection returns null for an absent heading and collapses whitespace otherwise', () => {
  assert.equal(proseSection('# A plan\n', 'Destination'), null)
  assert.equal(
    proseSection('## Statement\n\nDo the thing.\n\n## Acceptance\n\n- The thing is done\n\n## Destination\n\nOne line\nand   a second.\n\n## Next\n\ntext\n', 'Destination'),
    'One line and a second.',
  )
})

// The continuation lookahead is `[-*+]\s|[-*+]$` — not a bare marker character, and not nothing
// at all. (It read `-\s|-$` when this comment was written; the marker class was widened to
// `[-*+]` and this text was not updated with it.) Both mutations used to leave the whole suite
// green, so the two tests below are written to go red under each: dropping the lookahead lets a
// bullet-shaped line be swallowed as continuation, and narrowing it to `(?![-*+])` truncates a
// continuation that merely starts with a marker character. The tests below exercise the `-`
// half; the `*`/`+` half of the same class is covered by `a bare \`*\` or \`+\` marker line is
// dropped, not joined onto the entry above`.
test('a continuation starting with `--` joins, and a hyphen-only line does not', () => {
  const md = `## Out of Scope

- Merge flags — the runner passes
  --no-ff so the merge commit survives
  -
- Caching — its own spec
`
  assert.ok(md.includes('\n  --no-ff'), 'fixture must carry the `--` continuation under test')
  assert.ok(md.includes('\n  -\n'), 'fixture must carry the hyphen-only line under test')
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    [
      'Merge flags — the runner passes --no-ff so the merge commit survives',
      'Caching — its own spec',
    ],
  )
})

test('a hyphen followed by whitespace and nothing else is not a continuation either', () => {
  // Written as a single-quoted string with explicit `\n` escapes rather than as a multi-line
  // template literal: the line under test ends in a trailing space, and a trailing space at the
  // end of a real source line is what an editor or a formatter strips without a word. Escaped, it
  // is an ordinary character mid-line, and the assert below fails loudly if it goes anyway.
  const md = '## Out of Scope\n\n- Caching — its own spec\n  - \n'
  assert.ok(md.includes('\n  - \n'), 'fixture must carry the trailing-space hyphen line')
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — its own spec'],
  )
})

test('a missing Destination is reported before any malformed entry in the same document', () => {
  const md = `# A plan

## Out of Scope

- Caching

## Not Yet Specified

- A note with no question mark
`
  assert.ok(!md.includes('## Destination'), 'fixture must not carry a destination')
  assert.ok(md.split('\n').includes('- Caching'), 'fixture must also carry a malformed entry')
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      // The document-level defect wins: an entry refusal here would quote `- Caching`, a bullet
      // that is not what is wrong with this plan.
      assert.equal(error.reason, 'missing-destination')
      assert.equal(error.line, null)
      assert.equal(error.entry, null)
      assert.equal(error.index, null)
      return true
    },
  )
})

// The Destination requirement is two decisions — what triggers it, and what satisfies it — and
// each one used to survive its own mutation with the suite green. No fixture elsewhere in this
// file distinguishes the two readings of either half; the two below are written to do nothing
// else.
test('an Out of Scope heading with no bullets under it still requires a Destination', () => {
  const md = `# A plan

## Out of Scope

`
  assert.ok(md.includes('## Out of Scope'), 'fixture must carry the heading under test')
  assert.ok(!md.includes('## Destination'), 'fixture must not carry a destination')
  assert.deepEqual(bulletSection(md, 'Out of Scope'), [], 'fixture section must be empty of bullets')
  // Triggered by the presence of the heading, not by the bullet count: an author who opened the
  // section has declared a boundary exists, and a plan with a boundary needs the destination it
  // is a boundary of. Reading this off `outOfScope.length` would let the empty section through.
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-destination')
      return true
    },
  )
})

test('a Destination heading with no prose under it does not satisfy the requirement', () => {
  const md = `## Destination

## Out of Scope

- Caching — its own spec
`
  assert.ok(md.includes('## Destination'), 'fixture must carry the empty destination heading')
  assert.equal(
    proseSection(md, 'Destination'),
    '',
    'fixture must produce an empty-string destination, not null',
  )
  // The check is `!destination`, not `destination === null`, so the empty string is refused
  // exactly like an absent heading. What the rule buys is a destination Out of Scope can be
  // judged against; an opened heading with nothing under it buys none of it, and accepting it
  // would let an author satisfy the rule by typing four characters. Weakening this back to
  // `=== null` is what the assert above and the refusal below jointly forbid.
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-destination')
      assert.equal(error.line, null)
      assert.equal(error.entry, null)
      return true
    },
  )
})

// A spaced thematic break (`* * *`, `- - -`) satisfies the bullet pattern: `[-*+]` takes the
// first marker, `\s+` takes the space, and the capture group swallows the rest, yielding an
// entry whose text is the leftover markers. Both consumers are hit — `parseConstraints`
// injects `* *` into every teammate brief, and `parsePlanSections` refuses a plan whose only
// defect is a horizontal rule. CommonMark gives thematic breaks precedence over list items
// for exactly this ambiguity.
//
// `+` is deliberately NOT covered: it is not a thematic-break character in CommonMark, so
// `+ + +` really is a list item whose content is `+ +`, and must keep parsing as one.
test('a spaced thematic break is not a bullet entry', () => {
  for (const rule of ['* * *', '- - -', '*  *  *', '- - - -', '  * * *', '***', '---']) {
    const md = ['## Global Constraints', '', '- alpha', '', rule, '', '- beta', ''].join('\n')
    const items = bulletSection(md, 'Global Constraints').map((i) => i.text)
    assert.deepEqual(items, ['alpha', 'beta'], `${JSON.stringify(rule)} must not yield an entry`)
  }
})

test('a `+` run is still a bullet, because `+` is not a thematic-break character', () => {
  const md = ['## Global Constraints', '', '+ + +', ''].join('\n')
  assert.deepEqual(bulletSection(md, 'Global Constraints').map((i) => i.text), ['+ +'])
})

// A thematic break ends the list, so an indented line after one is not a continuation of the
// entry above it.
test('a thematic break closes the list rather than joining across it', () => {
  const md = ['## Global Constraints', '', '- alpha', '* * *', '  trailing', ''].join('\n')
  assert.deepEqual(bulletSection(md, 'Global Constraints').map((i) => i.text), ['alpha'])
})

// The continuation lookahead was widened from `-` to `[-*+]` so a bare `*` or `+` marker line
// is not glued onto the entry above it, but nothing pinned the widening: reverting the
// lookahead alone to `-`-only left the suite green, because the two tests named for
// continuation joining detect the BULLET pattern's class, not the lookahead's. A bare marker
// line is the only input that tells them apart — it cannot be a bullet (no content follows),
// so only the lookahead decides whether it joins.
test('a bare `*` or `+` marker line is dropped, not joined onto the entry above', () => {
  for (const marker of ['*', '+', '-']) {
    const md = ['## Global Constraints', '', '- alpha', `  ${marker}`, ''].join('\n')
    assert.deepEqual(
      bulletSection(md, 'Global Constraints').map((i) => i.text),
      ['alpha'],
      `a bare ${JSON.stringify(marker)} must not be appended to the previous entry`,
    )
  }
})

// The other half of the same lookahead: `[-*+]\s` — an indented marker FOLLOWED by content is a
// nested bullet, which the bullet pattern claims first, so it stays a standalone entry rather
// than joining. Pinned per marker for the same reason as above.
test('an indented marker with content stays its own entry rather than joining', () => {
  for (const marker of ['*', '+', '-']) {
    const md = ['## Global Constraints', '', '- alpha', `  ${marker} beta`, ''].join('\n')
    assert.deepEqual(
      bulletSection(md, 'Global Constraints').map((i) => i.text),
      ['alpha', 'beta'],
      `an indented ${JSON.stringify(marker)} entry must not be appended to the previous entry`,
    )
  }
})

// A boundary is judged against what was asked. Gates and reviewers judge the work against the
// plan, so a plan that excludes something has to carry the request and its criteria.
const BOUNDED = '## Destination\n\nSomewhere.\n\n## Out of Scope\n\n- Caching — its own spec\n'

test('Statement and Acceptance are parsed, with the line of each acceptance entry', () => {
  const md = `## Statement\n\nMake the report\nreadable.\n\n## Acceptance\n\n- A reader finds the total\n- Nothing is truncated\n\n${BOUNDED}`
  const sections = parsePlanSections(md)
  assert.equal(sections.statement, 'Make the report readable.')
  assert.deepEqual(sections.acceptance.map((e) => e.text), ['A reader finds the total', 'Nothing is truncated'])
  assert.equal(sections.acceptance[1].line, lineOf(md, 'Nothing is truncated'))
})

test('Out of Scope without a Statement is refused as a document-level defect', () => {
  const md = `## Acceptance\n\n- It is done\n\n${BOUNDED}`
  assert.throws(() => parsePlanSections(md), (error) => {
    assert.ok(error instanceof PlanSectionError)
    assert.equal(error.reason, 'missing-statement')
    assert.equal(error.line, null)
    assert.equal(error.entry, null)
    return true
  })
})

test('a Statement heading with no prose under it does not satisfy the requirement', () => {
  const md = `## Statement\n\n## Acceptance\n\n- It is done\n\n${BOUNDED}`
  assert.throws(() => parsePlanSections(md), (error) => error instanceof PlanSectionError && error.reason === 'missing-statement')
})

test('Out of Scope with a Statement but no Acceptance entry is refused', () => {
  for (const acceptance of ['', '## Acceptance\n\n', '## Acceptance\n\nProse is not an entry.\n\n']) {
    const md = `## Statement\n\nDo it.\n\n${acceptance}${BOUNDED}`
    assert.throws(() => parsePlanSections(md), (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-acceptance')
      assert.equal(error.entry, null)
      return true
    }, acceptance)
  }
})

test('a missing Destination is reported before a missing Statement', () => {
  assert.throws(() => parsePlanSections('## Out of Scope\n\n- Caching — its own spec\n'),
    (error) => error instanceof PlanSectionError && error.reason === 'missing-destination')
})

test('a plan without Out of Scope needs neither a Statement nor an Acceptance section', () => {
  const sections = parsePlanSections('## Destination\n\nSomewhere.\n\n## Not Yet Specified\n\n- Which store owns this?\n')
  assert.equal(sections.statement, null)
  assert.deepEqual(sections.acceptance, [])
})
