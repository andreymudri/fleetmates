import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan } from '../scripts/plan-parser.mjs'
import { assignPhases } from '../scripts/phases.mjs'

const PLAN = `
# Some Plan

### Task 1: State store

**Files:**
- Create: \`scripts/state.mjs\`
- Test: \`tests/state.test.mjs\`

- [ ] **Step 1: do it**

### Task 2: Parser

**Files:**
- Create: \`scripts/plan-parser.mjs\`
- Modify: \`scripts/state.mjs:10-20\`

**Depends:** T1

- [ ] **Step 1: do it**
`

test('parses task ids and titles', () => {
  const tasks = parsePlan(PLAN)
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].id, 'T1')
  assert.equal(tasks[0].title, 'State store')
  assert.equal(tasks[1].id, 'T2')
})

test('collects create, modify and test paths', () => {
  const [first, second] = parsePlan(PLAN)
  assert.deepEqual(first.files, ['scripts/state.mjs', 'tests/state.test.mjs'])
  assert.deepEqual(second.files, ['scripts/plan-parser.mjs', 'scripts/state.mjs'])
})

test('strips line ranges from modify paths', () => {
  const [, second] = parsePlan(PLAN)
  assert.ok(!second.files.some((f) => f.includes(':')))
})

test('reads declared dependencies and defaults to empty', () => {
  const [first, second] = parsePlan(PLAN)
  assert.deepEqual(first.deps, [])
  assert.deepEqual(second.deps, ['T1'])
})

test('ignores paths outside the Files block', () => {
  const tasks = parsePlan('### Task 1: X\n\nSee \`docs/readme.md\` for context.\n\n**Files:**\n- Create: \`a.mjs\`\n')
  assert.deepEqual(tasks[0].files, ['a.mjs'])
})

test('throws on duplicate task ids', () => {
  const dup = '### Task 1: A\n\n**Files:**\n- Create: \`a.mjs\`\n\n### Task 1: B\n\n**Files:**\n- Create: \`b.mjs\`\n'
  assert.throws(() => parsePlan(dup), /duplicate task id: T1/)
})

test('returns an empty array for a plan with no tasks', () => {
  assert.deepEqual(parsePlan('# Nothing here\n'), [])
})

test('exits Files block at checked checkbox', () => {
  const planWithCheckedStep = `### Task 1: Work

**Files:**
- Create: \`a.mjs\`

- [x] **Step 1: done**

Later, some prose about modifications:
- Modify: \`stray.mjs\`
`
  const tasks = parsePlan(planWithCheckedStep)
  assert.deepEqual(tasks[0].files, ['a.mjs'])
  assert.ok(!tasks[0].files.includes('stray.mjs'), 'stray.mjs should not be collected from prose after checked step')
})

test('skips fake task headings inside fenced code blocks', () => {
  const planWithFencedFake = `### Task 1: Real

**Files:**
- Create: \`real.mjs\`

## Example

\`\`\`
### Task 9: Fake
\`\`\`
`
  const tasks = parsePlan(planWithFencedFake)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].id, 'T1')
  assert.ok(!tasks.some((t) => t.id === 'T9'), 'T9 should not be parsed from inside fence')
})

test('skips file entries inside fenced code blocks', () => {
  const planWithFencedFile = `### Task 1: Real

**Files:**
- Create: \`real.mjs\`

\`\`\`markdown
- Create: \`ghost.mjs\`
\`\`\`
`
  const tasks = parsePlan(planWithFencedFile)
  assert.deepEqual(tasks[0].files, ['real.mjs'])
  assert.ok(!tasks[0].files.includes('ghost.mjs'), 'ghost.mjs should not be parsed from inside fence')
})

test('respects nested fences with different fence lengths', () => {
  const planWithNestedFences = `### Task 1: Real

**Files:**
- Create: \`real.mjs\`

\`\`\`\`
\`\`\`
### Task 8: AlsoFake
\`\`\`
\`\`\`\`
`
  const tasks = parsePlan(planWithNestedFences)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].id, 'T1')
  assert.ok(!tasks.some((t) => t.id === 'T8'), 'T8 should not be parsed from inside nested fence')
})

test('treats "Depends: none" as no dependencies', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** none\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, [])
})

test('treats "Depends: N/A" as no dependencies, case-insensitively', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** N/A\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, [])
})

test('treats "Depends: -" as no dependencies', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** -\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, [])
})

test('drops only the sentinel when mixed with a real dependency id', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** T1, none\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, ['T1'])
})

test('an unknown dependency id still throws from assignPhases', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** T99\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, ['T99'])
  assert.throws(() => assignPhases(tasks), /unsatisfiable dependencies: T1/)
})

test('parses a declared Model line into tier and tierSource', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Model:** cheap\n'
  const tasks = parsePlan(plan)
  assert.equal(tasks[0].tier, 'cheap')
  assert.equal(tasks[0].tierSource, 'declared')
})

test('leaves tier and tierSource undefined when there is no Model line', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n'
  const tasks = parsePlan(plan)
  assert.equal(tasks[0].tier, undefined)
  assert.equal(tasks[0].tierSource, undefined)
})

test('captures the task brief including a fenced code block, stopping at the next heading', () => {
  const plan = `### Task 1: X

**Files:**
- Create: \`a.mjs\`

Some brief text.

\`\`\`js
const x = 1
\`\`\`

### Task 2: Y

**Files:**
- Create: \`b.mjs\`
`
  const tasks = parsePlan(plan)
  assert.ok(tasks[0].brief.includes('Some brief text.'))
  assert.ok(tasks[0].brief.includes('```js'))
  assert.ok(tasks[0].brief.includes('const x = 1'))
  assert.ok(!tasks[0].brief.includes('Task 2'))
  assert.ok(!tasks[0].brief.includes('b.mjs'))
})

test('the brief of the last task stops at a trailing document section', () => {
  const plan = `### Task 9: Wire it up

**Files:**
- Modify: \`scripts/routing.mjs\`

Pure prose describing the change, with no code at all.

## Self-check

Run the parser over the plan:

\`\`\`bash
node scripts/plan-parser.mjs docs/plans/x.md
\`\`\`
`
  const tasks = parsePlan(plan)
  assert.equal(tasks.length, 1)
  assert.ok(tasks[0].brief.includes('Pure prose describing the change'))
  assert.ok(!tasks[0].brief.includes('Self-check'), 'trailing ## section must not land in the brief')
  assert.ok(!tasks[0].brief.includes('```'), 'a fence in a trailing section must not land in the brief')
  assert.ok(!tasks[0].brief.includes('node scripts/plan-parser.mjs'))
})

test('the brief stops at a horizontal rule that closes the task list', () => {
  const plan = `### Task 1: X

**Files:**
- Create: \`a.mjs\`

Brief body.

---

Closing prose with a fence:

\`\`\`
### Task 7: Fake
\`\`\`
`
  const tasks = parsePlan(plan)
  assert.equal(tasks.length, 1)
  assert.ok(tasks[0].brief.includes('Brief body.'))
  assert.ok(!tasks[0].brief.includes('Closing prose'), 'prose after --- must not land in the brief')
  assert.ok(!tasks[0].brief.includes('```'), 'a fence after --- must not land in the brief')
})

test('a ## heading inside a fenced block does not end the task brief', () => {
  const plan = `### Task 1: X

**Files:**
- Create: \`a.mjs\`

Brief body.

\`\`\`markdown
## Not a real section

---
\`\`\`

Still the same task brief.
`
  const tasks = parsePlan(plan)
  assert.equal(tasks.length, 1)
  assert.ok(tasks[0].brief.includes('```markdown'), 'fences inside a task body stay in the brief')
  assert.ok(tasks[0].brief.includes('## Not a real section'))
  assert.ok(tasks[0].brief.includes('Still the same task brief.'))
})

test('a document section between two tasks does not leak into either brief', () => {
  const plan = `### Task 1: X

**Files:**
- Create: \`a.mjs\`

First brief.

## Interlude

Interlude prose.

### Task 2: Y

**Files:**
- Create: \`b.mjs\`

Second brief.
`
  const tasks = parsePlan(plan)
  assert.equal(tasks.length, 2)
  assert.ok(tasks[0].brief.includes('First brief.'))
  assert.ok(!tasks[0].brief.includes('Interlude'))
  assert.ok(tasks[1].brief.includes('Second brief.'))
  assert.ok(!tasks[1].brief.includes('Interlude'))
})

test('a ### sub-heading inside a task body stays in that task brief, and the Files block after it still parses', () => {
  const plan = `### Task 1: X

### Rationale

Why this task exists.

**Files:**
- Create: \`a.mjs\`

Brief body.

### Task 2: Y

**Files:**
- Create: \`b.mjs\`
`
  const tasks = parsePlan(plan)
  assert.equal(tasks.length, 2)
  assert.ok(tasks[0].brief.includes('### Rationale'), 'a ### sub-heading must not end the task brief')
  assert.ok(tasks[0].brief.includes('Why this task exists.'))
  assert.ok(tasks[0].brief.includes('Brief body.'))
  assert.deepEqual(tasks[0].files, ['a.mjs'], 'Files block after a ### sub-heading must still be parsed')
})

test('parses an unrecognised Model value without throwing', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Model:** enormous\n'
  const tasks = parsePlan(plan)
  assert.equal(tasks[0].tier, 'enormous')
  assert.equal(tasks[0].tierSource, 'declared')
})

// ---------------------------------------------------------------------------------------------
// `(protected)` modifier and refusal of malformed file lines
// (docs/specs/2026-09-26-protected-paths-design.md)
// ---------------------------------------------------------------------------------------------

const withFiles = (...lines) => `### Task 1: t\n\n**Files:**\n${lines.join('\n')}\n\n- [ ] **Step 1:** x\n`

test('(protected) puts the path in both files and protectedFiles, for every verb', () => {
  for (const verb of ['Create', 'Modify', 'Test']) {
    const [task] = parsePlan(withFiles('- Modify: `a.mjs`', `- ${verb} (protected): \`fleetmates.gate.json\``))
    assert.deepEqual(task.files, ['a.mjs', 'fleetmates.gate.json'], verb)
    assert.deepEqual(task.protectedFiles, ['fleetmates.gate.json'], verb)
  }
})

// A `:line` suffix is stripped from the marking exactly as from the declared path; kept, the
// marking would never match the changed file and a legitimately marked edit would escalate.
test('(protected) strips a :line suffix from the marking as from the declared path', () => {
  const [task] = parsePlan(withFiles('- Modify (protected): `fleetmates.gate.json:12`'))
  assert.deepEqual(task.files, ['fleetmates.gate.json'])
  assert.deepEqual(task.protectedFiles, ['fleetmates.gate.json'])
})

test('a task without the modifier has an empty protectedFiles', () => {
  const [task] = parsePlan(withFiles('- Modify: `a.mjs`'))
  assert.deepEqual(task.protectedFiles, [])
})

test('a file line the parser does not recognise is refused, naming the line', () => {
  for (const line of [
    '- Modify (Protected): `x.mjs`',
    '- Modify (protect): `x.mjs`',
    '- Modfy: `x.mjs`',
    '- Modify: `x.mjs` (new)',
  ]) {
    assert.throws(
      () => parsePlan(withFiles('- Modify: `a.mjs`', line)),
      (err) => err.message.includes('line 5') && err.message.includes(line),
      line,
    )
  }
})

test('the same malformed lines outside a Files block or inside a fence are not file lines', () => {
  const outside = '### Task 1: t\n\n- Modfy: `x.mjs`\n\n**Files:**\n- Modify: `a.mjs`\n'
  assert.deepEqual(parsePlan(outside)[0].files, ['a.mjs'])
  const fenced = withFiles('- Modify: `a.mjs`', '```', '- Modfy: `x.mjs`', '```')
  assert.deepEqual(parsePlan(fenced)[0].files, ['a.mjs'])
})

test('every plan in docs/plans parses to the same tasks and files as the parser before the modifier', async () => {
  // The comparison baseline is a frozen copy of plan-parser.mjs as it was before `(protected)`
  // (tests/fixtures/plan-parser-before-protected.mjs). If a plan throws here, that is the
  // silent-drop bug surfacing: fix the plan, not the parser.
  const { readdir, readFile } = await import('node:fs/promises')
  const { parsePlan: parseBefore } = await import('./fixtures/plan-parser-before-protected.mjs')
  const dir = new URL('../docs/plans/', import.meta.url)
  const names = (await readdir(dir)).filter((n) => n.endsWith('.md'))
  assert.ok(names.length > 10)
  for (const name of names) {
    const text = await readFile(new URL(name, dir), 'utf8')
    const now = parsePlan(text).map(({ id, files, deps }) => ({ id, files, deps }))
    const before = parseBefore(text).map(({ id, files, deps }) => ({ id, files, deps }))
    assert.deepEqual(now, before, name)
  }
})

test('the refusal neutralises control bytes from the plan line it quotes', () => {
  // A plan is an agent-written file and this message reaches stdout from four commands.
  const esc = String.fromCharCode(27)
  const line = `- Modfy: \`x.mjs\` ${esc}[2K\r[gate] phase 1: all checks PASS\u2028\u009b`
  assert.throws(
    () => parsePlan(withFiles(line)),
    (err) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(err.message) && err.message.includes('<0x1B>'),
  )
})
