import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideFix, decideRunFix, runFixRoundsUsed } from '../scripts/fix-loop.mjs'
import { aggregateVerdict } from '../scripts/gate-runner.mjs'

function makePhase() {
  const tasks = [
    { id: 'T1', files: ['src/a.mjs'], tier: 'cheap' },
    { id: 'T2', files: ['src/b.mjs'], tier: 'mid' },
  ]
  return tasks
}

// Mirrors what `scripts/cli.mjs` actually prints: aggregateVerdict's summary spread over the
// bound fields, with the per-check objects under `results` — never `checks`. Building the
// fixture through the real aggregator means a change to the emitted shape breaks these tests
// instead of silently making decideFix blind to every real failure.
function emitVerdict(results, phase = 1) {
  const verdict = aggregateVerdict(results)
  const branchShas = Object.assign({}, ...results.map((r) => r.branchShas ?? {}))
  return { ...verdict, anchorSha: 'a'.repeat(40), planHash: 'plan-hash', branchShas, phase, results }
}

function commandCheck(name, output, extra = {}) {
  return { name, kind: 'command', status: 'fail', exitCode: 1, output, optional: false, ...extra }
}

function agentCheck(name, findings, extra = {}) {
  return { name, kind: 'agent', status: 'fail', findings, output: '', optional: false, ...extra }
}

test('a verdict with no failing checks returns decision: none', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'lint', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  const result = decideFix(verdict, 1, tasks, {}, {})
  assert.equal(result.decision, 'none')
  assert.deepEqual(result.tasks, [])
  assert.equal(result.reason, null)
})

test('a realistically emitted FAIL verdict is read from results, so a fileset failure escalates', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'fail', output: 'T1: outside declared set — src/z.mjs', optional: false },
    agentCheck('agent-check', [{ file: 'src/a.mjs' }]),
  ])
  // Guards the fixture itself: the CLI emits string-name arrays here, not per-check objects.
  assert.deepEqual(verdict.failed, ['fileset', 'agent-check'])
  assert.equal(verdict.checks, undefined)

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'fileset')
})

test('a failing ownership check escalates with process-violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'ownership', kind: 'ownership', status: 'fail', output: 'unexplained commit', optional: false },
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'ownership')
})

test('a failing agent check citing src/a.mjs retries T1 at tier mid, round 1', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T1')
  assert.equal(result.tasks[0].tier, 'mid')
  assert.equal(result.tasks[0].round, 1)
  assert.deepEqual(result.tasks[0].checks, ['agent-check'])
})

test('an agent finding citing the SECOND task retries T2, not whichever task came first', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/b.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T2')
  // T2 is declared `mid`, so its own escalation is `capable` — a tier T1 would never produce.
  assert.equal(result.tasks[0].tier, 'capable')
  assert.equal(result.tasks[0].round, 1)
})

test('a failing command check whose output mentions src/b.mjs retries T2 at tier capable', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('command-check', 'error in src/b.mjs at line 10')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T2')
  assert.equal(result.tasks[0].tier, 'capable')
})

test('a failing command check whose output mentions no declared file escalates as unattributable', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('command-check', 'error in src/unrelated.mjs')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'command-check')
})

test('an optional check that fails does not drive the loop, matching the PASS the gate issued', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'lint', kind: 'command', status: 'fail', exitCode: 1, output: 'src/a.mjs: advisory', optional: true },
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  assert.equal(verdict.verdict, 'PASS')
  assert.deepEqual(verdict.optionalFailed, ['lint'])

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'none')
  assert.deepEqual(result.tasks, [])
})

test('rounds is the already-unwrapped per-phase map: T1 at round 2 with budget 2 is exhausted', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])], 3)
  // Exactly what readFixRounds(status, phase) hands back — the { taskId: count } map itself.
  const rounds = { T1: 2 }
  const result = decideFix(verdict, 3, tasks, rounds, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'budget-exhausted')
  assert.equal(result.taskId, 'T1')
})

test('rounds is not re-indexed by phase, so a count already spent is carried into the next round number', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])], 3)
  const result = decideFix(verdict, 3, tasks, { T1: 1 }, { fixRounds: 3 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].round, 2)
})

test('an agent finding carrying an absolute backslash path still attributes to its owner', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    agentCheck('agent-check', [{ file: 'C:\\projetos\\repo\\src\\b.mjs', line: 12 }]),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T2')
})

test('an agent finding citing a longer path that merely ends in a declared name does not attribute', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'vendor/other-src/a.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

test('command output naming only a neighbouring file does not attribute to the declared prefix', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    commandCheck('command-check', 'snapshot mismatch: src/a.mjs.snap is obsolete'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'command-check')
})

test('command output naming a declared file with a windows path and a line suffix attributes', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    commandCheck('command-check', 'FAIL C:\\projetos\\repo\\src\\a.mjs:41:7 expected 1'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].taskId, 'T1')
})

test('a task at tier capable retries at capable, pinning the cap', () => {
  const tasks = [{ id: 'T1', files: ['src/a.mjs'], tier: 'capable' }]
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].tier, 'capable')
})

test('a task from a plan written before routing existed carries no tier and defaults to mid', () => {
  const tasks = [{ id: 'T1', files: ['src/a.mjs'] }]
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].tier, 'capable')
})

// --- attribution: the most specific declared path owns the file, not the first task listed ---

// T1 declares `src/a.mjs` and T2 declares `vendor/src/a.mjs`. A suffix match makes the reported
// `vendor/src/a.mjs` look like T1's file too, and `tasks.find` then hands the retry to whichever
// task the plan happened to list first. T1 would be retried on a path outside its own declared
// write set: either the round is wasted or T1 widens its fileset and trips the next gate.
const nestedTasks = [
  { id: 'T1', files: ['src/a.mjs'], tier: 'cheap' },
  { id: 'T2', files: ['vendor/src/a.mjs'], tier: 'mid' },
]

test('an agent finding citing vendor/src/a.mjs retries the task that declares it, not the suffix match', () => {
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'vendor/src/a.mjs' }])])
  const result = decideFix(verdict, 1, nestedTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T2'])
})

test('the other direction: an agent finding citing src/a.mjs still retries only the shorter declarer', () => {
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])])
  const result = decideFix(verdict, 1, nestedTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T1'])
})

test('a command output naming vendor/src/a.mjs attributes to the owner alone, not to both tasks', () => {
  const verdict = emitVerdict([commandCheck('command-check', 'FAIL vendor/src/a.mjs:3 boom')])
  const result = decideFix(verdict, 1, nestedTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T2'])
})

test('a command output naming both declared paths still attributes to both, one occurrence each', () => {
  const verdict = emitVerdict([
    commandCheck('command-check', 'FAIL vendor/src/a.mjs:3 boom\nFAIL src/a.mjs:9 boom'),
  ])
  const result = decideFix(verdict, 1, nestedTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId).sort(), ['T1', 'T2'])
})

// A bare single-segment declaration has no directory to anchor it, so a trailing-segment match
// would let it claim every same-named file in the tree — the widest possible over-attribution.
const bareTasks = [{ id: 'T1', files: ['a.mjs'], tier: 'mid' }]

test('a task declaring a bare filename does not claim a nested file of the same name (agent)', () => {
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'vendor/dep/a.mjs' }])])
  const result = decideFix(verdict, 1, bareTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

test('a task declaring a bare filename does not claim a nested file of the same name (command)', () => {
  const verdict = emitVerdict([commandCheck('command-check', 'FAIL vendor/dep/a.mjs:3 boom')])
  const result = decideFix(verdict, 1, bareTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

test('a task declaring a bare filename still owns that file at the repo root', () => {
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: './a.mjs' }])])
  const result = decideFix(verdict, 1, bareTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T1'])
})

// --- the leading path boundary in `mentions` ---

// Pins `(?<![0-9A-Za-z._-])`. Deleting it leaves every other test green while letting a task
// that declares only `src/a.mjs` be retried for a failure in someone else's `other-src/a.mjs`.
test('command output naming a differently-prefixed sibling directory does not attribute', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    commandCheck('command-check', 'vendor/other-src/a.mjs: parse error'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'command-check')
})

test('command output naming a file whose leading segment merely ends in the declared one does not attribute', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('command-check', 'my-src/a.mjs failed')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

// --- the failing set must mirror aggregateVerdict's blocking set ---

// aggregateVerdict blocks on three things: a non-optional `fail`, ANY unrecognized or missing
// status, and ANY non-optional `pending`. Counting only the first means the gate FAILs while
// decideFix returns `none`. The skill forbids integrating on `none` and asks the operator to
// re-derive the verdict — but re-deriving is deterministic, so gate -> none -> gate loops
// forever with no escalate exit. Every one of these must reach a terminal decision.
test('a non-optional pending check blocks the gate, so it must not read as decision none', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'mcp-check', kind: 'mcp', status: 'pending', output: 'no runner for kind mcp', optional: false },
  ])
  assert.equal(verdict.verdict, 'FAIL')
  assert.deepEqual(verdict.pending, ['mcp-check'])

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.notEqual(result.decision, 'none')
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'mcp-check')
})

test('an unrecognized status blocks the gate even when marked optional, so decideFix must too', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'weird', kind: 'command', status: 'errored', output: 'src/b.mjs blew up', optional: true },
  ])
  // aggregateVerdict routes unrecognized statuses to `failed` regardless of `optional`.
  assert.equal(verdict.verdict, 'FAIL')
  assert.deepEqual(verdict.failed, ['weird'])

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T2'])
})

test('a missing status blocks the gate and must not be silently dropped from the failing set', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([{ name: 'no-status', kind: 'command', output: '', optional: false }])
  assert.equal(verdict.verdict, 'FAIL')

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

test('an optional pending check does not block the gate, so it stays out of the failing set', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'advisory', kind: 'mcp', status: 'pending', output: 'src/a.mjs', optional: true },
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  assert.equal(verdict.verdict, 'PASS')

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'none')
})

test('a skipped check is not blocking and does not enter the failing set', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
    { name: 'e2e', kind: 'command', status: 'skip', output: '', optional: false },
  ])
  assert.equal(verdict.verdict, 'PASS')
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'none')
})

// --- the process-violation scan must precede the optional filter ---

// `ALWAYS_ENFORCED_KINDS` forces `optional: false` when the gate constructs the result, inside
// the gate process. decideFix does not consume that object: it consumes a serialized verdict
// handed in by the caller — assembled, per the skill, by the same agent whose fileset violation
// is being adjudicated. `optional: true` on a fileset check is therefore reachable, and it must
// not be able to downgrade the escalation to `none`.
test('a fileset failure marked optional still escalates as a process violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'fail', output: 'T1 wrote src/z.mjs', optional: true },
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'fileset')
})

test('an optional fileset failure escalates rather than being masked by an attributable retry', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'fail', output: 'T1 wrote src/z.mjs', optional: true },
    commandCheck('unit', 'error in src/a.mjs'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
})

test('an ownership check left pending is outside pass/skip and escalates as a process violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'ownership', kind: 'ownership', status: 'pending', output: '', optional: true },
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'ownership')
})

test('a passing fileset check is not a process violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'pass', output: '', optional: false },
    commandCheck('unit', 'error in src/a.mjs'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T1'])
})

test('a skipped fileset check is not a process violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'skip', output: '', optional: false },
    commandCheck('unit', 'error in src/a.mjs'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
})

// --- a task carrying no `files` key at all ---

// Pins both `task.files ?? []` sites. A plan task with no declared file set is malformed, but
// decideFix's whole contract is to return a decision the caller can serialise; a TypeError
// crashes the gate loop with no verdict recorded at all.
test('a task with no files key yields a serialisable decision, not a TypeError (agent path)', () => {
  const tasks = [{ id: 'T1', tier: 'mid' }, { id: 'T2', files: ['src/b.mjs'], tier: 'mid' }]
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/b.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T2'])
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('a task with no files key yields a serialisable decision, not a TypeError (command path)', () => {
  const tasks = [{ id: 'T1', tier: 'mid' }]
  const verdict = emitVerdict([commandCheck('command-check', 'error in src/a.mjs')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

// --- decideFix must be total: every input shape yields a serialisable decision ---
//
// The caller treats decideFix's return value as the loop's decision and serialises it. A throw
// is not a decision: the loop's decision step dies with no verdict recorded, which hangs the
// loop exactly the way the `pending` -> `none` deadlock did, by a different door. `fix` reads
// `plan.json` out of `.fleetmates/`, which is agent-writable, so none of these shapes are
// hypothetical — `init-run` validates declared tiers but `fix` re-reads the file afterwards.

test('an out-of-vocabulary tier yields a decision instead of throwing', () => {
  const tasks = [{ id: 'T1', files: ['src/a.mjs'], tier: 'fast' }]
  const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  assert.equal(result.decision, 'retry')
  // Treated exactly the way a missing tier is: fall back to DEFAULT_TIER ('mid'), then escalate it.
  assert.equal(result.tasks[0].tier, 'capable')
})

test('an empty-string, numeric or structural tier is treated as unrecognised, not as a crash', () => {
  for (const tier of ['', 3, {}, [], true]) {
    const label = JSON.stringify(tier) ?? String(tier)
    const tasks = [{ id: 'T1', files: ['src/a.mjs'], tier }]
    const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
    const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, label)
    assert.equal(result.tasks[0].tier, 'capable', label)
  }
})

test('a recognised tier is still escalated normally, so the fallback did not swallow the vocabulary', () => {
  const tasks = [{ id: 'T1', files: ['src/a.mjs'], tier: 'cheap' }]
  const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.tasks[0].tier, 'mid')
})

// `verdict?.results ?? []` accepted any non-nullish value, and the caller's try covers only
// readFile/JSON.parse — so "valid JSON but not a verdict" is precisely the shape that escapes it.
test('a verdict whose results is not an array escalates instead of throwing', () => {
  const tasks = makePhase()
  for (const results of [{}, 'fail', 7, true, { find: 1 }]) {
    const result = decideFix({ results }, 1, tasks, {}, { fixRounds: 2 })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
    // Not `none`: a verdict the loop cannot read must reach a human, never re-enter the gate,
    // because re-derivation is deterministic and would otherwise repeat forever.
    assert.equal(result.decision, 'escalate')
    assert.equal(result.reason, 'malformed-verdict')
    assert.deepEqual(result.tasks, [])
  }
})

test('a missing or empty verdict still decides none, so the array guard did not widen to nullish', () => {
  const tasks = makePhase()
  for (const verdict of [undefined, null, {}]) {
    const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
    assert.equal(result.decision, 'none')
  }
})

test('an agent check whose findings is not an array yields a decision, not a TypeError', () => {
  const tasks = makePhase()
  for (const findings of [5, 'src/a.mjs', {}, true]) {
    const verdict = emitVerdict([agentCheck('agent-check', findings)])
    const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
    // No usable findings means nothing to attribute, which is already an escalate path.
    assert.equal(result.decision, 'escalate')
    assert.equal(result.reason, 'unattributable')
  }
})

test('a task whose files is not an array yields a decision, not a TypeError', () => {
  const verdict = emitVerdict([commandCheck('unit', 'error in src/b.mjs')])
  for (const files of [{}, 7, true]) {
    const tasks = [{ id: 'T1', files, tier: 'mid' }, { id: 'T2', files: ['src/b.mjs'], tier: 'mid' }]
    const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
    assert.deepEqual(result.tasks.map((t) => t.taskId), ['T2'])
  }
})

test('a string files value does not iterate as characters and claim files it never declared', () => {
  const tasks = [{ id: 'T1', files: 'src/a.mjs', tier: 'mid' }]
  const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

// `rounds` comes from JSON.parse, so bracket-indexing it by a task id reaches up the prototype
// chain, and `??` does not catch an inherited value because it is not nullish.
test('a task id inherited from Object.prototype does not bypass the round budget', () => {
  const tasks = [{ id: 'constructor', files: ['src/a.mjs'], tier: 'mid' }]
  const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 0 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'budget-exhausted')
  assert.equal(result.taskId, 'constructor')
})

test('every Object.prototype key used as a task id counts as zero rounds, not as an inherited value', () => {
  const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
  for (const id of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    const tasks = [{ id, files: ['src/a.mjs'], tier: 'mid' }]
    const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
    assert.equal(result.decision, 'retry', id)
    // The round must be a number, not a string produced by concatenating an inherited function.
    assert.equal(result.tasks[0].round, 1, id)
    assert.equal(typeof result.tasks[0].round, 'number', id)
  }
})

test('an own round count is still honoured, so the prototype guard did not disable the budget', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
  assert.equal(decideFix(verdict, 1, tasks, { T1: 2 }, { fixRounds: 2 }).reason, 'budget-exhausted')
  assert.equal(decideFix(verdict, 1, tasks, { T1: 1 }, { fixRounds: 2 }).tasks[0].round, 2)
})

test('a non-numeric own round count counts as zero rather than poisoning the round number', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
  for (const value of ['2', null, {}, NaN, -1]) {
    const label = String(value)
    const result = decideFix(verdict, 1, tasks, { T1: value }, { fixRounds: 2 })
    assert.equal(result.decision, 'retry', label)
    assert.equal(result.tasks[0].round, 1, label)
  }
})

test('a rounds map that is not an object at all does not throw', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
  for (const rounds of [null, undefined, 7, 'x', ['a']]) {
    const result = decideFix(verdict, 1, tasks, rounds, { fixRounds: 2 })
    assert.equal(result.decision, 'retry')
    assert.equal(result.tasks[0].round, 1)
  }
})

// Pins `Object.hasOwn` itself rather than the numeric guard behind it. Every Object.prototype
// member happens to be a function, so the "must be a number" check alone kills the `constructor`
// case — but the rule being enforced is *own key*, not *not a function*. An inherited count that
// IS a number must still read as zero, or a task borrows a budget it never spent.
test('an inherited numeric round count is not borrowed, so the own-key check is load-bearing', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('unit', 'error in src/a.mjs')])
  const rounds = Object.create({ T1: 9 })
  assert.equal(rounds.T1, 9, 'fixture must actually inherit the count')
  const result = decideFix(verdict, 1, tasks, rounds, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].round, 1)
})

// --- the run fix route (docs/specs/2026-11-06-cost-cuts-design.md, section 2) -------------------
// A blocking run finding is not one task's to retry: the run review judged the integrated diff.
// It becomes ONE fix task, `fix-<n>`, on `fleetmates/<run>/fix-<n>`, whose file set is the paths
// the blocking findings cite that some plan task declares. Two rounds at most, then escalation.

function runVerdict(results) {
  return { ...emitVerdict(results, 'run'), phase: 'run' }
}

const RUN_TASKS = [
  { id: 'T1', files: ['src/a.mjs'], tier: 'cheap', phase: 1 },
  { id: 'T2', files: ['src/b.mjs', 'docs/b.md'], tier: 'mid', phase: 2 },
]

function decideRun(results, opts = {}) {
  return decideRunFix(runVerdict(results), { runId: 'r1', tasks: RUN_TASKS, rounds: {}, fixRounds: 2, ...opts })
}

test('a blocking run finding becomes one fix task with the declared paths it cites as its file set', () => {
  const findings = [
    { severity: 'high', file: 'src/b.mjs', line: 3, summary: 'off by one' },
    { severity: 'high', file: '/work/repo/src/a.mjs', line: 9, summary: 'unchecked input' },
    // Below the blocking severity: not part of the brief, and its path is not added to the set.
    { severity: 'low', file: 'docs/b.md', line: 1, summary: 'typo' },
  ]
  const result = decideRun([agentCheck('review', findings)])
  assert.equal(result.decision, 'retry')
  assert.equal(result.reason, null)
  assert.equal(result.tasks.length, 1)
  const [task] = result.tasks
  assert.equal(task.taskId, 'fix-1')
  assert.equal(task.branch, 'fleetmates/r1/fix-1')
  assert.equal(task.round, 1)
  assert.deepEqual(task.files, ['src/a.mjs', 'src/b.mjs'])
  assert.deepEqual(task.findings, findings.slice(0, 2))
  assert.deepEqual(task.checks, ['review'])
  // The most capable tier among the declaring tasks, escalated one step, as a phase retry does.
  assert.equal(task.tier, 'capable')
})

test('the blocking severities are the review check\'s blockOn', () => {
  const findings = [{ severity: 'medium', file: 'src/a.mjs', line: 1 }, { severity: 'high', file: 'src/b.mjs', line: 1 }]
  const result = decideRun([agentCheck('review', findings)], { blockOn: { review: ['medium'] } })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks[0].files, ['src/a.mjs'])
})

test('a blocking run finding citing a path no plan task declares escalates at once', () => {
  const result = decideRun([agentCheck('review', [
    { severity: 'high', file: 'src/a.mjs', line: 1 },
    { severity: 'high', file: 'src/stray.mjs', line: 2 },
  ])])
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'undeclared-path')
  assert.equal(result.file, 'src/stray.mjs')
  assert.deepEqual(result.tasks, [])
})

test('a blocking run finding citing no path at all escalates as undeclared', () => {
  const result = decideRun([agentCheck('review', [{ severity: 'high', summary: 'somewhere' }])])
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'undeclared-path')
})

// A failing review whose findings sit below the blocking severity names nothing to fix: escalate
// rather than retry an empty brief.
test('a failing run review with no blocking finding escalates as unattributable', () => {
  const result = decideRun([agentCheck('review', [{ severity: 'low', file: 'src/a.mjs' }])])
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'review')
})

test('a failing run command check is attributed by the declared paths its output names', () => {
  const result = decideRun([commandCheck('test', 'not ok 3 - src/b.mjs:12 expected 1')])
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks[0].files, ['src/b.mjs'])
  assert.deepEqual(result.tasks[0].findings, [])
  const silent = decideRun([commandCheck('test', 'segmentation fault')])
  assert.equal(silent.decision, 'escalate')
  assert.equal(silent.reason, 'unattributable')
})

test('a failing fileset-run check is a process violation, never a fix task', () => {
  const result = decideRun([
    { name: 'fileset-run', kind: 'fileset-run', status: 'fail', output: 'outside', optional: true },
    agentCheck('review', [{ severity: 'high', file: 'src/a.mjs' }]),
  ])
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'fileset-run')
})

test('a passing run verdict decides none', () => {
  const result = decideRun([{ name: 'review', kind: 'agent', status: 'pass', findings: [], optional: false }])
  assert.equal(result.decision, 'none')
})

test('a run verdict whose results are not a list escalates as malformed', () => {
  const result = decideRunFix({ phase: 'run', results: {} }, { runId: 'r1', tasks: RUN_TASKS, rounds: {}, fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'malformed-verdict')
})

test('the run fix round numbers the next task, and escalates at the cap of two', () => {
  const failing = [agentCheck('review', [{ severity: 'high', file: 'src/a.mjs' }])]
  const second = decideRun(failing, { rounds: { 'fix-1': 1 } })
  assert.equal(second.decision, 'retry')
  assert.equal(second.tasks[0].taskId, 'fix-2')
  assert.equal(second.tasks[0].branch, 'fleetmates/r1/fix-2')
  assert.equal(second.tasks[0].round, 2)
  const third = decideRun(failing, { rounds: { 'fix-1': 1, 'fix-2': 1 } })
  assert.equal(third.decision, 'escalate')
  assert.equal(third.reason, 'budget-exhausted')
  // Capped at two whatever the manifest allows.
  assert.equal(decideRun(failing, { rounds: { 'fix-1': 1, 'fix-2': 1 }, fixRounds: 5 }).decision, 'escalate')
  // And lower when the manifest says so.
  const once = decideRun(failing, { rounds: { 'fix-1': 1 }, fixRounds: 1 })
  assert.equal(once.decision, 'escalate')
  assert.equal(once.reason, 'budget-exhausted')
})

test('only own fix-<n> counts are run fix rounds', () => {
  assert.equal(runFixRoundsUsed({ 'fix-1': 1, 'fix-2': 1 }), 2)
  assert.equal(runFixRoundsUsed({ T1: 3, 'fix-01': 1, 'fix-x': 1, 'fix-1': 'a' }), 0)
  assert.equal(runFixRoundsUsed(Object.create({ 'fix-1': 1 })), 0)
  assert.equal(runFixRoundsUsed(null), 0)
})
