import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  COMMAND_TIMEOUT_MS,
  KILL_GRACE_MS,
  REAP_INTERVAL_MS,
  defaultExec,
  liveGroupPids,
  registerGroup,
  runCommandCheck,
  describePendingCheck,
  runChecks,
  aggregateVerdict,
  deriveContext,
  runFilesetCheck,
  runOwnershipCheck,
  mergedParentFiles,
  landedForFiles,
  creditRunTipTasks,
} from '../scripts/gate-runner.mjs'
import { GitError, createGit, defaultGitExec } from '../scripts/git.mjs'
import { previewClaimPath } from '../scripts/merge-preview.mjs'

const fakeExec = (table) => async (cmd) => table[cmd] ?? { code: 127, output: `not stubbed: ${cmd}` }

test('a zero-exit command passes', async () => {
  const exec = fakeExec({ 'npm test': { code: 0, output: 'ok' } })
  const res = await runCommandCheck({ name: 'test', kind: 'command', run: 'npm test' }, { cwd: '.', exec })
  assert.equal(res.status, 'pass')
  assert.equal(res.exitCode, 0)
})

test('a non-zero-exit command fails', async () => {
  const exec = fakeExec({ 'npm test': { code: 1, output: 'boom' } })
  const res = await runCommandCheck({ name: 'test', kind: 'command', run: 'npm test' }, { cwd: '.', exec })
  assert.equal(res.status, 'fail')
  assert.equal(res.exitCode, 1)
  assert.match(res.output, /boom/)
})

test('failed command output is truncated to the last 40 lines', async () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
  const exec = fakeExec({ 'x': { code: 1, output: long } })
  const res = await runCommandCheck({ name: 'x', kind: 'command', run: 'x' }, { cwd: '.', exec })
  assert.equal(res.output.split('\n').length, 40)
  assert.match(res.output, /line 199/)
})

test('a command check may lower its own timeout', async () => {
  let seen = null
  await runCommandCheck(
    { name: 'quick', kind: 'command', run: 'true', timeoutMs: 1000 },
    { cwd: process.cwd(), exec: async (_cmd, _cwd, opts) => { seen = opts; return { code: 0, output: '' } } },
  )
  assert.equal(seen.timeoutMs, 1000)
})

test('a command check with no timeoutMs gets the default', async () => {
  let seen = null
  await runCommandCheck(
    { name: 'quick', kind: 'command', run: 'true' },
    { cwd: process.cwd(), exec: async (_cmd, _cwd, opts) => { seen = opts; return { code: 0, output: '' } } },
  )
  assert.equal(seen.timeoutMs, COMMAND_TIMEOUT_MS)
})

// The error string names 3600000 as the boundary ("must not exceed ... (60 minutes)"), which
// means the boundary value itself must be ACCEPTED, not rejected. `value > TIMEOUT_CEILING_MS`
// does that; `value >= TIMEOUT_CEILING_MS` would not, and nothing else here would catch that —
// the malformed-value table below only exercises the reject side, one past the ceiling.
test('timeoutMs at the ceiling itself is accepted, not just one below it', async () => {
  let seen = null
  await runCommandCheck(
    { name: 'quick', kind: 'command', run: 'true', timeoutMs: 60 * 60_000 },
    { cwd: process.cwd(), exec: async (_cmd, _cwd, opts) => { seen = opts; return { code: 0, output: '' } } },
  )
  assert.equal(seen.timeoutMs, 60 * 60_000)
})

// The domain has no floor, by design (docs/specs/2026-08-26-purge-and-teardown-design.md:76:
// "a positive integer no greater than a hard 60-minute ceiling"), and nothing else in this file
// proves that on the ACCEPT side: every timeoutMs that reaches `timeoutFault` elsewhere here is
// either malformed (the table below) or >= 1000 (1000 above, 3600000 two tests up), so a
// re-inserted `if (value < 1000) return ...` — the exact branch a previous round deleted — would
// sit on both sides of every other value in this file and go unnoticed. Driven through
// `runChecks`, not `runCommandCheck` directly, so a sub-1000 value is proved to reach `exec`
// intact through the manifest path `timeoutFault` guards, not merely accepted by the function in
// isolation.
// THE CONSUMER, pinned independently of the refusal that currently protects it. `derive` in
// `scripts/cli.mjs` hands `deriveContext` the run branch's NAME, and this function passed that
// name on as the merge preview's base — while `ctx.runBranchRef` carried the ref HEAD actually
// pointed at. The two disagree exactly when the name is ITSELF a ref path: `qualifyBranch` returns
// any `refs/`-prefixed string unchanged, so `refs/heads/run-branch` re-qualified to the REAL
// branch while the ref stayed the planted one, and a gate reported merge=pass on a tree where
// merging into the real run branch conflicts.
//
// `classifyHeadRef` refuses that HEAD state now, so nothing reaches this function with such a
// name through the CLI — which is why this is a unit test and not an end-to-end one. The point is
// that the guarantee should not rest on the refusal alone: a consumer handed a ref cannot misread
// which ref is meant, and that property is this test's subject.
test('the merge preview is built from the run branch ref, not from a name two rules can qualify differently', async () => {
  const seen = []
  const ctx = {
    cwd: process.cwd(),
    runId: 'r1',
    runBranch: 'refs/heads/run-branch',
    runBranchRef: 'refs/heads/refs/heads/run-branch',
    tasks: [{ id: 'T1', phase: 1 }],
    currentPhase: 1,
    git: {
      branchExists: async () => true,
      addWorktreeDetached: async (_dir, base) => {
        seen.push(base)
        // Stops the preview here: what this test is about has already been observed, and nothing
        // below it needs a real worktree.
        throw new Error('recorded')
      },
    },
  }
  await runChecks([], ctx)
  assert.deepEqual(
    seen,
    ['refs/heads/refs/heads/run-branch'],
    'the preview was based on the run branch NAME, which qualifies to a different ref than the one HEAD points at',
  )
})

test('a sub-second timeoutMs is not a floor violation and reaches exec unchanged', async () => {
  let seen = null
  const results = await runChecks(
    [{ name: 'quick', kind: 'command', run: 'true', timeoutMs: 300 }],
    { cwd: process.cwd(), solo: true, exec: async (_cmd, _cwd, opts) => { seen = opts; return { code: 0, output: '' } } },
  )
  assert.equal(results[0].status, 'pass')
  assert.equal(seen.timeoutMs, 300)
})

test('a malformed timeoutMs fails its entry and never falls back to the default', async () => {
  for (const bad of ['600000', 0, -1, 1.5, null, true, 60 * 60_000 + 1]) {
    const results = await runChecks(
      [{ name: 'test', kind: 'command', run: 'true', timeoutMs: bad }],
      { cwd: process.cwd(), solo: true, exec: async () => { throw new Error('the check must not run') } },
    )
    assert.equal(results[0].status, 'fail', `timeoutMs ${JSON.stringify(bad)} should not have run`)
    assert.match(results[0].output, /timeoutMs must (?:be a positive integer|not exceed)/)
    assert.match(results[0].output, /entry #0 in this phase's check list/)
  }
})

test('a malformed timeoutMs cannot be waved through with optional: true', async () => {
  const results = await runChecks(
    [{ name: 'test', kind: 'command', run: 'true', timeoutMs: 0, optional: true }],
    { cwd: process.cwd(), solo: true },
  )
  assert.equal(aggregateVerdict(results).verdict, 'FAIL')
})

// `runChecks` -> `runCheckList` rejects a faulty bound before any runner is called (see the
// malformed-timeoutMs tests above), so the guard at the top of `runCommandCheck` itself is
// unreachable from that path. It exists for the EXPORTED api: `runCommandCheck` is called
// directly from tests and could be called directly by a programmatic caller, and without this
// guard a malformed bound reaching it here would silently apply COMMAND_TIMEOUT_MS instead of
// being refused — the exact silent fallback the comment above the guard forbids.
test('runCommandCheck itself rejects a malformed timeoutMs before calling exec', async () => {
  await assert.rejects(
    () => runCommandCheck(
      { name: 'quick', kind: 'command', run: 'true', timeoutMs: 0 },
      { cwd: process.cwd(), exec: async () => { throw new Error('exec must not run') } },
    ),
    /timeoutMs must be a positive integer/,
  )
})

// --- runCommandCheck preview claims ------------------------------------------------------------
//
// A `command` check that runs inside a merge preview holds a claim naming its own pid for as
// long as the check runs, so the reaper never removes the preview out from under a check that
// is still using it. No preview, no claim — see the `previewDir === null` guard in
// `runCommandCheck` itself.

test('a command check holds a claim on the preview while it runs and releases it after', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-preview-'))
  let duringRun = null
  let duringContent = null
  const result = await runCommandCheck(
    { name: 'test', kind: 'command', run: 'true' },
    {
      cwd: dir,
      previewDir: dir,
      exec: async (_cmd, _cwd, { onSpawn }) => {
        onSpawn(999999)
        duringRun = existsSync(previewClaimPath(dir, 999999))
        // The reaper parses this content to get the pid it probes (scripts/cli.mjs). A claim
        // naming the WRONG pid is worse than no claim at all: it either names a process that is
        // not running, so the preview is reaped out from under a live check, or it names a
        // process that never exits, so the preview is never reaped once this check is done.
        duringContent = await readFile(previewClaimPath(dir, 999999), 'utf8')
        return { code: 0, output: '' }
      },
    },
  )
  assert.equal(result.status, 'pass')
  assert.equal(duringRun, true, 'the claim must exist while the check is running')
  assert.equal(duringContent, '999999\n', 'the claim must name the pid the reaper will probe')
  assert.equal(existsSync(previewClaimPath(dir, 999999)), false, 'the claim must be released')
  await rm(dir, { recursive: true, force: true })
})

test('a claim is released even when the check throws', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-preview-'))
  let duringContent = null
  await assert.rejects(runCommandCheck(
    { name: 'test', kind: 'command', run: 'true' },
    {
      cwd: dir,
      previewDir: dir,
      exec: async (_cmd, _cwd, { onSpawn }) => {
        onSpawn(999998)
        duringContent = await readFile(previewClaimPath(dir, 999998), 'utf8')
        throw new Error('boom')
      },
    },
  ))
  assert.equal(duringContent, '999998\n', 'the claim must name the pid the reaper will probe')
  assert.equal(existsSync(previewClaimPath(dir, 999998)), false)
  await rm(dir, { recursive: true, force: true })
})

test('a check outside a preview writes no claim', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-solo-'))
  let handed
  await runCommandCheck(
    { name: 'test', kind: 'command', run: 'true' },
    { cwd: dir, exec: async (_cmd, _cwd, opts) => { handed = opts.onSpawn; return { code: 0, output: '' } } },
  )
  assert.equal(handed, null)
  await rm(dir, { recursive: true, force: true })
})

// EEXIST at the claim path means something already holds that exact path — a stale claim of
// our own left by a recycled pid, or a plant. `onSpawn` must neither throw (the spawn site has
// nothing to do with the check that is about to run) nor unlink what it did not create (the
// `finally` releases only what THIS call recorded in `claims`). The pre-existing file must
// survive the whole check unchanged.
test('a claim path that already exists is left alone, and the check still runs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-preview-'))
  const claim = previewClaimPath(dir, 999997)
  await writeFile(claim, 'not ours\n', 'utf8')
  const result = await runCommandCheck(
    { name: 'test', kind: 'command', run: 'true' },
    {
      cwd: dir,
      previewDir: dir,
      exec: async (_cmd, _cwd, { onSpawn }) => { onSpawn(999997); return { code: 0, output: '' } },
    },
  )
  assert.equal(result.status, 'pass', 'the pre-existing claim must not fail the check')
  assert.equal(await readFile(claim, 'utf8'), 'not ours\n', 'the pre-existing claim must be untouched')
  // `previewClaimPath` names a SIBLING of `dir` (`${previewOwnerMarkerPath(dir)}.${pid}`), not
  // a path inside it, so `rm(dir, { recursive: true })` below cannot reach it. Removed
  // explicitly rather than left to leak into the shared temp root on every run.
  await rm(claim, { force: true })
  await rm(dir, { recursive: true, force: true })
})

test('agent and mcp checks come back pending', () => {
  const res = describePendingCheck({ name: 'review', kind: 'agent', agent: 'tm-reviewer' })
  assert.equal(res.status, 'pending')
  assert.equal(res.kind, 'agent')
  assert.equal(res.check.agent, 'tm-reviewer')
})

test('all-pass aggregates to PASS', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'b', status: 'pass' }])
  assert.equal(v.verdict, 'PASS')
  assert.deepEqual(v.failed, [])
})

test('any fail aggregates to FAIL and names the check', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'b', status: 'fail' }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.failed, ['b'])
})

test('a skipped optional check does not fail but is reported', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'contract', status: 'skip', optional: true }])
  assert.equal(v.verdict, 'PASS')
  assert.deepEqual(v.skipped, ['contract'])
})

test('an optional failing check does not fail the gate but is reported in optionalFailed', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'contract', status: 'fail', optional: true }])
  assert.equal(v.verdict, 'PASS')
  assert.deepEqual(v.failed, [])
  assert.deepEqual(v.optionalFailed, ['contract'])
})

test('a non-optional failing check still fails the gate', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'b', status: 'fail', optional: false }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.failed, ['b'])
  assert.deepEqual(v.optionalFailed, [])
})

test('a non-optional pending check fails the gate', () => {
  const v = aggregateVerdict([{ name: 'review', status: 'pending' }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.pending, ['review'])
})

test('an empty result set fails rather than silently passing', () => {
  assert.equal(aggregateVerdict([]).verdict, 'FAIL')
})

test('a result with no status field aggregates to FAIL', () => {
  const v = aggregateVerdict([{ name: 'x' }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.failed, ['x'])
})

test('a result with an unrecognised status aggregates to FAIL', () => {
  const v = aggregateVerdict([{ name: 'y', status: 'passed' }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.failed, ['y'])
})

// --- fixtures shared by deriveContext / runFilesetCheck / runOwnershipCheck --------------

const RUN_ID = 'r1'
const RUN_BRANCH = 'run'
const BASE_BRANCH = 'main'
const T1_BRANCH = 'fleetmates/r1/T1'
const T2_BRANCH = 'fleetmates/r1/T2'

function planMarkdown() {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    '',
    '**Depends:** none',
    '',
    '### Task 2: second task',
    '',
    '**Files:**',
    '- Create: `b.mjs`',
    '',
    '**Depends:** T1',
    '',
  ].join('\n')
}

// Builds a fake git object exposing every method deriveContext / runFilesetCheck /
// runOwnershipCheck consume. `resolveRefCalls` records every argument passed to
// resolveRef, in order, so tests can assert every ref reaching git is fully qualified.
function fakeGit(overrides = {}) {
  const resolveRefCalls = []
  const defaults = {
    mergeBase: async () => 'anchorSha1',
    fileAtCommit: async () => planMarkdown(),
    // Every path is a plain file unless a test says otherwise. contentAt pairs this with
    // fileAtCommit, so a double that omits it makes the ownership check throw rather than
    // exercise the branch under test.
    fileModeAtCommit: async () => '100644',
    resolveRef: async (ref) => {
      resolveRefCalls.push(ref)
      if (ref === 'refs/heads/run') return 'runSha1'
      return `${ref}-sha`
    },
    branchExists: async () => false,
    isAncestor: async () => false,
    changedFiles: async () => [],
    commitsBetween: async () => [],
    commitParents: async () => [],
    isDirty: async () => false,
    mergedBranchTips: async () => new Set(),
  }
  const git = { ...defaults, ...overrides }
  git.resolveRefCalls = resolveRefCalls
  // Preserve call recording even when a test overrides resolveRef directly.
  if (overrides.resolveRef) {
    const custom = overrides.resolveRef
    git.resolveRef = async (ref) => { resolveRefCalls.push(ref); return custom(ref) }
  }
  return git
}

// --- deriveContext ------------------------------------------------------------------------

test('deriveContext derives phase 1 when nothing is integrated', async () => {
  const git = fakeGit()
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, 1)
  assert.equal(ctx.phaseError, null)
  assert.deepEqual(ctx.integratedPhases, [])
  assert.equal(ctx.anchorSha, 'anchorSha1')
  assert.equal(ctx.runSha, 'runSha1')
  assert.equal(ctx.tasks.length, 2)
})

test('deriveContext derives phase 2 once phase 1 branches are ancestors', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    isAncestor: async (sha, runSha) => sha === `refs/heads/${T1_BRANCH}-sha` && runSha === 'runSha1',
    changedFiles: async ({ branch }) => (branch === `refs/heads/${T1_BRANCH}-sha` ? ['a.mjs'] : []),
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, 2)
  assert.equal(ctx.phaseError, null)
  assert.deepEqual(ctx.integratedPhases, [1])
})

test('deriveContext derives currentPhase: null when every phase is integrated', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    isAncestor: async () => true,
    changedFiles: async () => ['some-file'],
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, null)
  assert.deepEqual(ctx.integratedPhases, [1, 2])
})

test('deriveContext surfaces phaseError for out-of-order integration', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T2_BRANCH,
    isAncestor: async (sha, runSha) => sha === `refs/heads/${T2_BRANCH}-sha` && runSha === 'runSha1',
    changedFiles: async ({ branch }) => (branch === `refs/heads/${T2_BRANCH}-sha` ? ['b.mjs'] : []),
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, null)
  assert.match(ctx.phaseError, /phase 1/)
  assert.deepEqual(ctx.integratedPhases, [2])
})

// A branch created with zero file changes past the anchor must never read as "integrated" —
// isAncestor(X, X) is trivially true, so a phantom branch pointed at the anchor (or at the
// run tip) would otherwise pass with no work done. See the real-repo regression test below
// ("an empty task branch at the run tip does not read as integrated").
test('deriveContext does not treat a branch with zero file changes past the anchor as integrated', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    // isAncestor alone would say yes — the branch sha equals the anchor sha (zero changes).
    isAncestor: async () => true,
    changedFiles: async () => [],
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, 1)
  assert.deepEqual(ctx.integratedPhases, [])
})

// H3-empty: counting commits is not the same as counting file changes. `git commit
// --allow-empty` produces a real commit with zero file changes; a branch consisting only of
// such commits must not read as integrated either.
test('deriveContext does not treat a branch with only empty commits as integrated', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    isAncestor: async () => true,
    // The branch has a real commit (so a commit-counting check would wrongly pass); it just
    // never touched a file.
    changedFiles: async () => [],
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, 1)
  assert.deepEqual(ctx.integratedPhases, [])
})

// M1: a plan that parses to zero tasks must not read as "every phase is integrated". A
// directory anchor (`git show <sha>:docs` renders a tree listing) parses to zero tasks the
// same way an empty file would; derivePhase then returns `{phase: null}` with no error, and
// runFilesetCheck's "nothing left to check" fast path passes vacuously while a task branch
// can carry an undeclared file. An empty task list is a derive failure, not a clean run.
test('deriveContext fails when the plan parses to zero tasks, naming the plan path and anchor', async () => {
  const git = fakeGit({ fileAtCommit: async () => '' })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'docs' })
  assert.equal(ctx.currentPhase, null)
  assert.ok(ctx.phaseError, 'expected a phaseError for a zero-task plan')
  assert.match(ctx.phaseError, /docs/)
  assert.match(ctx.phaseError, /anchorSha1/)
  assert.deepEqual(ctx.tasks, [])
})

// --- runFilesetCheck ------------------------------------------------------------------------

const T1_TASK = { id: 'T1', phase: 1, files: ['a.mjs'] }

test('runFilesetCheck passes on declared changes and records branchShas', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => ['a.mjs'],
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha` })
})

test('runFilesetCheck fails naming a stray path', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => ['a.mjs', 'secret.mjs'],
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /secret\.mjs/)
})

// `mergedParentFiles`'s in-range filter, pinned directly: a task ref parked exactly at the
// ANCHOR, where the merge naming the anchor as a secondary parent happens to carry a file with
// the SAME NAME as the parked task's own declared file (the coincidence a plan amendment could
// produce). Without the filter, the anchor itself would be keyed and `landedForFiles` would
// read this ref as landed on a merge it was never part of — the anchor is the boundary
// `commitsBetween` excludes, not a commit this run's history begins from. The run tip IS the
// integrator's merge commit, on the walk's own first-parent chain (`commitParents('mergeSha1')`
// is reached directly from `runSha`), so this test actually exercises the filter rather than
// stopping before the walk ever visits the merge — the filter's necessity was reconfirmed
// against this exact mock, in this shape, before the test was written.
test('runFilesetCheck does not read a ref parked at the anchor as landed even when a coincidental filename matches', async () => {
  const T2_TASK = { id: 'T2', phase: 1, files: ['b.mjs'] }
  const git = fakeGit({
    branchExists: async () => true,
    resolveRef: async (ref) => {
      // T2 is parked exactly at the anchor.
      if (ref === `refs/heads/${T2_BRANCH}`) return 'anchorSha1'
      return `${ref}-sha`
    },
    commitsBetween: async () => ['mergeSha1'],
    // The lone in-range merge's SECOND parent is the anchor itself — the shape a plan
    // amendment produces once its own base tip becomes the anchor. It is also the run tip
    // itself, so the chain walk reaches it in one step from `runSha`.
    commitParents: async (sha) => (sha === 'mergeSha1' ? ['firstParentSha', 'anchorSha1'] : []),
    // Coincidence: the amendment merge happens to touch a file named `b.mjs`, the same name
    // T2 declared. The walk's own call shape diffs the SECONDARY PARENT's own tree
    // (`anchorSha1`) against the chain's prior tip (`firstParentSha`), not the merge commit's.
    changedFiles: async ({ base, branch }) => (base === 'firstParentSha' && branch === 'anchorSha1' ? ['b.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'mergeSha1', anchorSha: 'anchorSha1',
    tasks: [T2_TASK], currentPhase: 1, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
})

// T2 (phase 2, under check) sits at T1's tip (phase 1, merged). T2's own diff is empty and
// T1's sha IS a merged tip, so without the duplicate rule this passes — the shape
// `deriveContext`'s "ref parked at a merged SIBLING'S tip" comment names as undefended.
// Fix-round rewrite: T2's ref is pointed at T1's own merged tip (the shared sha), instead of
// committing. The merge that landed T1 carried T1's declared file, `a.mjs` — never T2's `b.mjs`
// — so `landedForFiles` reads false for T2 even though the sha is shared and genuinely merged.
// No message names T1 at all: T2's own failure is self-contained, and does not depend on
// reasoning about any other ref, only on what the merge that named its sha actually carried.
test('runFilesetCheck fails a branch parked on a merged sibling\'s tip, naming only its own no-op', async () => {
  const T2_TASK = { id: 'T2', phase: 2, files: ['b.mjs'] }
  const SHARED_SHA = 'sharedSha1'
  const git = fakeGit({
    branchExists: async () => true,
    resolveRef: async (ref) => {
      if (ref === `refs/heads/${T1_BRANCH}`) return SHARED_SHA
      if (ref === `refs/heads/${T2_BRANCH}`) return SHARED_SHA
      if (ref === 'refs/heads/run') return 'runSha1'
      return `${ref}-sha`
    },
    commitsBetween: async () => ['mergeSha1', SHARED_SHA],
    commitParents: async (sha) => (sha === 'mergeSha1' ? ['firstParentSha', SHARED_SHA] : []),
    // The merge naming the shared sha carried T1's declared file, never T2's.
    changedFiles: async ({ base, branch }) => (base === 'firstParentSha' && branch === 'mergeSha1' ? ['a.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1',
    tasks: [T1_TASK, T2_TASK], currentPhase: 2, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes past its fork point/)
  assert.doesNotMatch(res.output, /T1/)
})

// T8 and T9 (phase 3, untouched) both sit at the run tip while phase 2 is gated. Widening the
// SUBJECT to every task in the run — rather than only the phase under check — would fail this
// phase for two not-yet-started refs of a LATER phase, which is not a violation of anything.
test('runFilesetCheck does not fail the current phase for two refs of a later phase sharing a sha', async () => {
  const T2_TASK = { id: 'T2', phase: 2, files: ['b.mjs'] }
  const T8_TASK = { id: 'T8', phase: 3, files: ['h.mjs'] }
  const T9_TASK = { id: 'T9', phase: 3, files: ['i.mjs'] }
  const T8_BRANCH = 'fleetmates/r1/T8'
  const T9_BRANCH = 'fleetmates/r1/T9'
  const FUTURE_SHA = 'futureSha1'
  const git = fakeGit({
    branchExists: async () => true,
    resolveRef: async (ref) => {
      if (ref === `refs/heads/${T8_BRANCH}`) return FUTURE_SHA
      if (ref === `refs/heads/${T9_BRANCH}`) return FUTURE_SHA
      if (ref === 'refs/heads/run') return 'runSha1'
      return `${ref}-sha`
    },
    changedFiles: async ({ branch }) => (branch === `refs/heads/${T2_BRANCH}-sha` ? ['b.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1',
    tasks: [T2_TASK, T8_TASK, T9_TASK], currentPhase: 2, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// `mergedParentFiles` walks every task ref's merge history, not just this phase's, so a
// corrupted ref anywhere in that history must fail the check cleanly rather than let the
// GitError propagate as an uncaught throw where a FAIL verdict belongs.
test('runFilesetCheck fails with the git error when the merge-history walk fails', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    commitsBetween: async () => { throw new GitError('bad revision anchorSha1..runSha1') },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1',
    tasks: [T1_TASK], currentPhase: 1, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /could not walk this run's merge history/)
  assert.match(res.output, /bad revision/)
})

// A teammate that skips its `git checkout -B fleetmates/<run>/<task>` and commits on the
// harness's own worktree branch leaves the conventional ref existing but empty: it points at
// the run tip with no work on it. `filesetViolations` of an empty change list is empty, so the
// check used to pass, the task merged as a no-op, and the returned `status: done` was believed.
// An existing branch that contributes nothing is a failure, not a clean pass.
// Wiring for the side-door rule: the branch is an ancestor of the base but not of the run
// branch. isAncestor is asked exactly that pair of questions, and a merge into the base with no
// gate PASS is a fail, not a pass carrying a note.
test('runOwnershipCheck fails a task branch merged into the base branch but not the run branch', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => [],
    isAncestor: async (sha, target) => sha === `refs/heads/${T1_BRANCH}-sha` && target === 'baseSha1',
    resolveRef: async (ref) => {
      if (ref === 'refs/heads/run') return 'runSha1'
      if (ref === 'refs/heads/main') return 'baseSha1'
      return `${ref}-sha`
    },
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, new RegExp(T1_BRANCH))
  assert.match(res.output, /main/)
})

test('runOwnershipCheck passes a task branch that is an ancestor of both the base and the run branch', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => [],
    // Landed the ordinary way: the run branch carries it, and the run branch has since landed
    // on the base. Ancestor of both, and no violation.
    isAncestor: async () => true,
    resolveRef: async (ref) => {
      if (ref === 'refs/heads/run') return 'runSha1'
      if (ref === 'refs/heads/main') return 'baseSha1'
      return `${ref}-sha`
    },
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// A branch that is ALREADY an ancestor of the run branch has landed: merge-base(run, branch) is
// the branch's own tip, so its diff is vacuously empty for a reason that has nothing to do with
// whether work was done. Reported as a violation, that turns every re-verification of an
// integrated phase — which is exactly what `finish` does — into a false failure. The emptiness
// rule is about work that never reached the conventional ref, and that question is only
// meaningful before the branch is merged.
test('runFilesetCheck does not report an already-integrated branch as contributing nothing', async () => {
  const t1Sha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    isAncestor: async (_sha, target) => target === 'mergeSha1',
    // The run tip IS the integrator's merge commit — the walk starts at `runSha` and follows
    // `parents[0]` back to `anchorSha`, so the merge must be reachable from `runSha` by that
    // exact chain, not merely present somewhere in `commitsBetween`'s output.
    commitsBetween: async () => ['mergeSha1', t1Sha],
    commitParents: async (sha) => (sha === 'mergeSha1' ? ['anchorSha1', t1Sha] : []),
    // T1's own sha is already on the run branch, so its fork-point diff (this check's own
    // top-level diff, computed the same way for every task) is empty — merge-base(run, sha)
    // is `sha` itself, exactly like a real already-landed branch.
    mergeBase: async (_run, sha) => (sha === t1Sha ? t1Sha : 'anchorSha1'),
    // The merge that landed T1's branch carried its declared file, `a.mjs` — T1's own
    // contribution since it diverged from the chain's prior tip (the anchor here) — which is
    // what makes the branch read as integrated, not ancestry alone.
    changedFiles: async ({ base, branch }) => (base === 'anchorSha1' && branch === t1Sha ? ['a.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'mergeSha1', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: t1Sha })
})

// `landedForFiles`'s path normalization, pinned directly: plans are hand-authored on Windows,
// and `plan-parser` stores a declared path verbatim, so a task declaring `./a.mjs` (a leading
// `./` a human might type) must still match a merge diff reporting the same file as plain
// `a.mjs` — the shape `git diff --name-only` actually reports paths in. Without normalizing
// both sides the same way `filesetViolations` does, a branch that genuinely landed would read
// as not-landed over a formatting difference, not a real absence.
test('runFilesetCheck matches a declared path against a differently-normalized merge diff path', async () => {
  const dotSlashTask = { id: 'T1', phase: 1, files: ['./a.mjs'] }
  const t1Sha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    isAncestor: async (_sha, target) => target === 'mergeSha1',
    commitsBetween: async () => ['mergeSha1', t1Sha],
    commitParents: async (sha) => (sha === 'mergeSha1' ? ['anchorSha1', t1Sha] : []),
    mergeBase: async (_run, sha) => (sha === t1Sha ? t1Sha : 'anchorSha1'),
    // The diff reports the plain path, with no leading `./` — the declared path has one.
    changedFiles: async ({ base, branch }) => (base === 'anchorSha1' && branch === t1Sha ? ['a.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'mergeSha1', anchorSha: 'anchorSha1', tasks: [dotSlashTask], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// `mergedParentFiles` unions file sets across two chain commits that both name the SAME sha as
// a secondary parent, rather than keeping only the first. Chain: `runSha` (M2) -> M1 ->
// `anchorSha`. Both M2 and M1 name `sharedParent` as their own secondary parent, but from
// different first parents, so each contributes a DIFFERENT file to the union: M2's own diff
// (base M1) gives `y.mjs`; M1's own diff (base anchor) gives `x.mjs`. The task here declares
// only `x.mjs` — the file M1's traversal contributes, processed SECOND since the walk starts at
// `runSha` and only reaches M1 afterward. A "first merge wins" version (keeping the set from
// M2's visit and never adding to it) would read this task as not-landed.
test('mergedParentFiles unions file sets across two merges naming the same sha, rather than keeping only the first', async () => {
  const declaresSecondFile = { id: 'T1', phase: 1, files: ['x.mjs'] }
  const git = fakeGit({
    branchExists: async () => true,
    isAncestor: async (_sha, target) => target === 'M2',
    resolveRef: async (ref) => (ref === `refs/heads/${T1_BRANCH}` ? 'sharedParent' : `${ref}-sha`),
    commitsBetween: async () => ['M2', 'M1', 'sharedParent'],
    commitParents: async (sha) => {
      if (sha === 'M2') return ['M1', 'sharedParent']
      if (sha === 'M1') return ['anchorSha1', 'sharedParent']
      return []
    },
    mergeBase: async (_run, sha) => (sha === 'sharedParent' ? 'sharedParent' : 'anchorSha1'),
    changedFiles: async ({ base, branch }) => {
      if (branch !== 'sharedParent') return []
      if (base === 'M1') return ['y.mjs'] // M2's own visit
      if (base === 'anchorSha1') return ['x.mjs'] // M1's own visit
      return []
    },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'M2', anchorSha: 'anchorSha1', tasks: [declaresSecondFile], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// `mergedParentFiles` and `landedForFiles` are exported so `scripts/doctor.mjs` can decide
// `landed` with the exact same predicate `runFilesetCheck` enforces with, rather than keeping a
// second implementation that could silently disagree with the gate. Called directly here,
// outside `runFilesetCheck`, to pin the export itself — not just behaviour reachable only
// through the check.
test('mergedParentFiles and landedForFiles are exported and usable directly', async () => {
  const git = fakeGit({
    commitsBetween: async () => ['M1', 'sharedParent'],
    commitParents: async (sha) => (sha === 'M1' ? ['anchorSha1', 'sharedParent'] : []),
    changedFiles: async ({ base, branch }) => (base === 'anchorSha1' && branch === 'sharedParent' ? ['x.mjs'] : []),
  })
  const index = await mergedParentFiles(git, { anchorSha: 'anchorSha1', runSha: 'M1' })
  assert.equal(landedForFiles(index, 'sharedParent', ['x.mjs']), true)
  assert.equal(landedForFiles(index, 'sharedParent', ['y.mjs']), false)
  assert.equal(landedForFiles(index, 'someOtherSha', ['x.mjs']), false)
})

// One merge-history walk for the whole phase, not one per task: `mergedParentFiles` is called
// once, before the per-task loop, and its result is reused for every task in the phase.
test('runFilesetCheck builds the merge-history index once for the whole phase, not once per task', async () => {
  let calls = 0
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    commitsBetween: async () => { calls += 1; return [] },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1',
    tasks: [T1_TASK, { id: 'T2', phase: 1, files: ['b.mjs'] }], currentPhase: 1, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.equal(calls, 1)
})

// Reversed from the design this replaced: the merge-history walk used to be lazy, skipped
// entirely when every branch's own diff came up non-empty. `mergedParentFiles` is now built
// unconditionally, before the per-task loop even inspects any branch's diff, because
// `deriveContext`'s own integration credit needs the SAME index regardless of what any single
// task's diff looks like, and `runFilesetCheck` builds its own copy the same way. Pinned here so
// reintroducing laziness (skipping the walk when it looks unneeded) is a deliberate choice, not
// an accidental regression: every branch below carries real, non-empty changes, and the walk
// still runs.
test('runFilesetCheck builds the merge-history index even when every branch carries its own changes', async () => {
  let calls = 0
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => ['a.mjs'],
    commitsBetween: async () => { calls += 1; return [] },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.equal(calls, 1)
})

// The enforcing counterpart of doctor's run-tip case. From phase 2 onward the run tip is past
// the anchor, so a branch left exactly where `git checkout -B <task> <run branch>` put it
// satisfies both halves of the landed test while carrying no work of its own — and this check
// decides whether the phase may integrate.
test('runFilesetCheck fails a branch parked at the run tip with no contribution', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    isAncestor: async (_sha, target) => target === 'runSha1',
    resolveRef: async () => 'runSha1',
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /contributes no file changes/)
})

// The case a run-tip-only exclusion cannot see. The integrator merged a sibling after this
// branch was created, so the run tip moved past the commit the branch is parked at: it is past
// the anchor, it is not the tip, and — with no merge in range naming this sha at all (the
// default `commitsBetween`/`commitParents` stubs return nothing) — `landedForFiles` reads false
// regardless of the sha's relationship to the tip.
test('runFilesetCheck fails a branch parked at an intermediate post-anchor commit', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    isAncestor: async (_sha, target) => target === 'runSha2',
    resolveRef: async (ref) => (ref === 'refs/heads/run' ? 'runSha2' : 'midSha'),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'runSha2', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /contributes no file changes/)
})

test('runFilesetCheck fails when a task branch contributes no file changes', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /T1/)
  assert.match(res.output, /no file changes/)
  // The branch sha is still recorded, so verdictCoversTree keeps working across a fix round.
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha` })
})

test('runFilesetCheck fails on a missing branch', async () => {
  const git = fakeGit({ branchExists: async () => false })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /does not exist/)
})

test('runFilesetCheck fails when the phase selects zero tasks', async () => {
  const git = fakeGit()
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 2, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /selected no tasks/)
})

test('runFilesetCheck fails on phaseError', async () => {
  const git = fakeGit()
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: 'phase 1 is not integrated but a later phase is' }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /phase 1 is not integrated/)
})

test('runFilesetCheck passes when every phase is integrated (currentPhase null) and records branchShas', async () => {
  const git = fakeGit({ branchExists: async () => true })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: null, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  // A PASS with no branchShas reads to verdictCoversTree as still covering the tree no
  // matter how branches move afterwards — the resolved shas must be attached even on the
  // all-integrated short-circuit.
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha` })
})

test('runFilesetCheck fails without git access', async () => {
  const check = { name: 'fileset', kind: 'fileset' }
  const res = await runFilesetCheck(check, {})
  assert.equal(res.status, 'fail')
  assert.match(res.output, /no git access/)
})

test('runFilesetCheck converts GitError to a fail', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => { throw new GitError('changedFiles boom') },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /changedFiles boom/)
})

test('runFilesetCheck lets a non-GitError propagate', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => { throw new Error('not a git error') },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  await assert.rejects(() => runFilesetCheck(check, ctx), /not a git error/)
})

// M2: `optional: true` is meaningful on a `command` check ("advisory") but on `fileset` or
// `ownership` it means "detect the violation and ship anyway", which is never coherent. An
// uncommitted manifest marking either check optional must not be able to disable enforcement
// while appearing to record it — the result must always come back non-optional so
// aggregateVerdict counts it.
test('runFilesetCheck ignores optional:true and still fails the gate on a violation', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => ['a.mjs', 'secret.mjs'],
  })
  const check = { name: 'fileset', kind: 'fileset', optional: true }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.equal(res.optional, false)
  assert.equal(aggregateVerdict([res]).verdict, 'FAIL')
})

// --- runOwnershipCheck ------------------------------------------------------------------------

test('runOwnershipCheck passes when every commit is reachable', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    isAncestor: async (a, b) => a === 'c1' && b === `refs/heads/${T1_BRANCH}-sha`,
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

test('runOwnershipCheck fails naming an unexplained commit and mentioning --no-ff', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    isAncestor: async () => false,
    commitParents: async () => ['p0'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /c1/)
  assert.match(res.output, /--no-ff/)
})

test('runOwnershipCheck accepts a merge commit whose second parent is a task branch', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'p1' && b === `refs/heads/${T1_BRANCH}-sha`,
    commitParents: async () => ['p0', 'p1'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

test('runOwnershipCheck fails a merge commit whose content for a file has no source in any parent', async () => {
  const branchSha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'p1' && b === branchSha,
    commitParents: async () => ['p0', 'p1'],
    mergeBase: async (a, b) => (a === 'p0' && b === 'p1' ? 'base01' : 'anchorSha1'),
    // BACKDOOR.mjs differs between the merge commit and its first parent, but neither the
    // first parent nor the second parent (nor their common base) ever had it — content with
    // no legitimate source.
    changedFiles: async ({ base, branch }) => (base === 'p0' && branch === 'm1' ? ['BACKDOOR.mjs'] : []),
    fileAtCommit: async (sha, filePath) => {
      if (filePath === 'BACKDOOR.mjs' && sha === 'm1') return 'export const backdoor = true\n'
      throw new GitError(`no such path ${filePath} at ${sha}`)
    },
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /m1/)
})

// The confirmed gap: a two-parent-owned merge short-circuited on the first matching
// secondary parent, so an octopus merge with a legitimate parent AND a rogue (unowned)
// parent was waved through — content riding in behind the rogue parent was never inspected.
// Every secondary parent must be independently confirmed as an ancestor of a task branch.
test('runOwnershipCheck requires every parent of an octopus merge to be owned by a task branch', async () => {
  const t1Sha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    commitsBetween: async () => ['m1'],
    // Only the T1 branch tip is an ancestor of a task branch; 'rogue' is not.
    isAncestor: async (a, b) => a === t1Sha && b === t1Sha,
    commitParents: async () => ['p0', t1Sha, 'rogue'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /m1/)
})

// Advancing the base branch mid-run and merging it into the run branch produces a merge whose
// secondary parent is the base, never a task branch. Without base ancestry as an explanation
// that legitimate advance is indistinguishable from a direct write — run `preview` hit exactly
// this and paid for a full run-branch rebuild.
test('runOwnershipCheck accepts a merge whose secondary parent is an ancestor of the base branch', async () => {
  const baseSha = `refs/heads/${BASE_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    // Nothing on a task branch explains this merge; only the base does.
    isAncestor: async (a, b) => a === 'baseAdvance' && b === baseSha,
    commitParents: async () => ['p0', 'baseAdvance'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// Accepting base ancestry must not turn into accepting anything: a plain, parentless-of-any-
// -owner commit written straight onto the run branch is still the case this check exists for.
test('runOwnershipCheck still fails a direct write explained by neither a task branch nor the base', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    isAncestor: async () => false,
    commitParents: async () => ['p0'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /c1/)
})

// The octopus case, now with base ancestry in play: one legitimate base parent must not vouch
// for a rogue sibling parent. Every secondary parent is still checked independently.
test('runOwnershipCheck fails an octopus merge mixing a base-owned parent with an unowned one', async () => {
  const baseSha = `refs/heads/${BASE_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'baseAdvance' && b === baseSha,
    commitParents: async () => ['p0', 'baseAdvance', 'rogue'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /m1/)
})

// A run configured with a base branch that does not exist keeps today's behaviour exactly:
// no resolve is attempted (which would be a GitError and fail the check for a new reason),
// and the commit stays unexplained.
test('runOwnershipCheck leaves a commit unexplained when the base branch does not exist', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    commitsBetween: async () => ['m1'],
    isAncestor: async () => false,
    commitParents: async () => ['p0', 'baseAdvance'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: 'no-such-base',
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /m1/)
  assert.ok(
    !git.resolveRefCalls.includes('refs/heads/no-such-base'),
    'no resolve should be attempted for a base branch that does not exist',
  )
})

// Accepting base ancestry costs a signal: before it, an accidental commit landing on the base
// branch mid-run rode into the run branch as an ownership FAILURE — wrong, but the only place
// a moved baseline was ever visible. Nothing pins the base ref, so the movement itself cannot
// be detected after the fact; what can be preserved is a record of what was admitted because
// of it. A pass that admitted nothing must stay quiet, or the note becomes noise nobody reads.
test('runOwnershipCheck records every base-explained commit in its own passing output', async () => {
  const baseSha = `refs/heads/${BASE_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'baseAdvance' && b === baseSha,
    commitParents: async () => ['p0', 'baseAdvance'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.match(res.output, /m1/)
})

test('the base-explained note names the base branch it accepted the commit from', async () => {
  const baseSha = `refs/heads/${BASE_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'baseAdvance' && b === baseSha,
    commitParents: async () => ['p0', 'baseAdvance'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.match(res.output, new RegExp(BASE_BRANCH))
})

test('a pass with no base-explained commits carries no note and an empty output', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    // Explained the ordinary way: the secondary parent is an ancestor of a task branch.
    isAncestor: async (a, b) => a === 'p1' && b === `refs/heads/${T1_BRANCH}-sha`,
    commitParents: async () => ['p0', 'p1'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.equal(res.output, '')
})

test('runOwnershipCheck fails on a dirty worktree', async () => {
  const git = fakeGit({ isDirty: async () => true })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /uncommitted changes/)
})

test('runOwnershipCheck fails without git access', async () => {
  const check = { name: 'ownership', kind: 'ownership' }
  const res = await runOwnershipCheck(check, {})
  assert.equal(res.status, 'fail')
  assert.match(res.output, /no git access/)
})

test('runOwnershipCheck converts GitError to a fail', async () => {
  const git = fakeGit({ commitsBetween: async () => { throw new GitError('commitsBetween boom') } })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /commitsBetween boom/)
})

// Mirrors the fileset check's equivalent test — without this, the two checks are silently
// asymmetric: fileset lets a non-GitError propagate (tested above), and until this test
// existed, ownership's identical `if (!(err instanceof GitError)) throw err` had no coverage.
test('runOwnershipCheck lets a non-GitError propagate', async () => {
  const git = fakeGit({ commitsBetween: async () => { throw new Error('not a git error') } })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [] }
  await assert.rejects(() => runOwnershipCheck(check, ctx), /not a git error/)
})

// Mutation-testing gap: mutating `parents.slice(1)` to `parents` at the ownership scan site
// left the suite green, because every prior test only ever exercised a *second* parent
// explaining a merge. Reproduced concretely: the run branch fast-forwards onto a task
// branch's tip, then takes a direct commit — that commit's sole (first) parent is the task
// branch tip. isAncestor(firstParent, firstParent) is trivially true, so if the scan ever
// includes the first parent, the direct write explains itself. `parents.slice(1)` must
// exclude it.
test('a commit whose sole parent sits on a task branch is still unexplained', async () => {
  const branchSha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    // Reflexive only: true exactly when the two arguments are literally the same value.
    // The direct commit 'c1' is not itself the branch tip, so the initial "is the commit
    // itself an ancestor of a task branch" check is false — only the parent-scan path can
    // wrongly explain it, and only if that scan is allowed to see the first parent.
    isAncestor: async (a, b) => a === b,
    commitParents: async () => [branchSha],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /c1/)
})

test('runOwnershipCheck ignores optional:true and still fails the gate on a violation', async () => {
  const git = fakeGit({ isDirty: async () => true })
  const check = { name: 'ownership', kind: 'ownership', optional: true }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.equal(res.optional, false)
  assert.equal(aggregateVerdict([res]).verdict, 'FAIL')
})

// --- runChecks dispatch -----------------------------------------------------------------------

test('runChecks dispatches command, fileset and ownership checks', async () => {
  const exec = fakeExec({ 'npm test': { code: 0, output: '' } })
  const git = fakeGit()
  const ctx = { cwd: '.', exec, git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [], currentPhase: null, phaseError: null }
  const results = await runChecks([
    { name: 'test', kind: 'command', run: 'npm test' },
    { name: 'fileset', kind: 'fileset' },
    { name: 'ownership', kind: 'ownership' },
    { name: 'review', kind: 'agent', agent: 'tm-reviewer' },
  ], ctx)
  // The gate's own computed merge check leads the list; this ctx has no in-progress phase and
  // so no branches to preview, which is a clean merge by definition.
  assert.deepEqual(results.map((r) => r.name), ['merge', 'test', 'fileset', 'ownership', 'review'])
  assert.deepEqual(results.map((r) => r.status), ['pass', 'pass', 'pass', 'pass', 'pending'])
})

test('runChecks yields pending for prototype-shadowing kinds', async () => {
  const results = await runChecks([
    { name: 'a', kind: 'toString' },
    { name: 'b', kind: 'constructor' },
    { name: 'c', kind: 'valueOf' },
    { name: 'd', kind: '__proto__' },
  ], {})
  assert.deepEqual(results.map((r) => r.status), ['pending', 'pending', 'pending', 'pending'])
})

// --- a check kind must be a STRING before a runner is selected -------------------------------
//
// The test above pins prototype-shadowing kinds, and every one of them is a STRING. The spelling
// nothing covered is the one JSON can express: an ARRAY. JavaScript coerces on property lookup and
// does not coerce in a Set, so `["command"]` lands on the wrong side of every guard at once — it
// survives cli.mjs's `--enforcement-only` filter (`!== 'command'`), satisfies
// `Object.hasOwn(RUNNERS, kind)`, resolves `RUNNERS[kind]` to a real runner, and is absent from
// `ALWAYS_ENFORCED_KINDS`, so `optional: true` is honoured.
//
// `fleetmates.gate.json` lives in the main worktree and is writable by any teammate, so this needs
// no other foothold.

// Every kind the manifest accepts, in the array spelling. `command` is the execution path;
// `fileset`/`ownership` are the real enforcement runners; `agent`/`mcp` have no runner and would
// otherwise land as pendings; `merge` is gate-computed and a manifest must not be able to supply
// it at all.
const MANIFEST_KINDS = ['command', 'fileset', 'ownership', 'agent', 'mcp', 'merge']

test('an array-spelled kind never reaches a runner, for any kind the manifest accepts', async () => {
  for (const kind of MANIFEST_KINDS) {
    // `run` is present so that if the command runner were ever reached, it would have something
    // to execute — the test must not pass merely because the payload was empty.
    const results = await runChecks([{ name: `k-${kind}`, kind: [kind], run: 'node -e ""' }], {})
    assert.equal(results.length, 1, `unexpected extra results for ${kind}`)
    const [result] = results
    assert.equal(result.status, 'fail', `an array-spelled ${kind} did not fail`)
    assert.equal(result.optional, false, `an array-spelled ${kind} was optional`)
    assert.match(result.output, /kind must be a string/)
    // Named in the diagnosis, so an operator can find the entry in the manifest.
    assert.match(result.output, /fleetmates\.gate\.json/)
  }
})

// The false-PASS half, which the execution fix alone would not have closed: the real `fileset`
// runner executes and then declines to block, because `ALWAYS_ENFORCED_KINDS.has` does not coerce
// while the runner lookup does. Measured against the merged tree as
// `{"verdict":"PASS","failed":[],"optionalFailed":["fileset"]}` — a forged manifest reaching a
// false gate PASS, which is the bound this design has claimed since phase 1.
test('an array-spelled enforcement kind cannot buy itself out with optional', async () => {
  const results = await runChecks([{ name: 'fileset', kind: ['fileset'], optional: true }], {})
  const verdict = aggregateVerdict(results)
  assert.equal(verdict.verdict, 'FAIL')
  assert.deepEqual(verdict.failed, ['fileset'])
  assert.deepEqual(verdict.optionalFailed, [])
})

// Every non-string shape, not only the array. The rule is a type test, so it is asserted as one:
// nothing that is not a string may reach a runner by any route.
test('no non-string kind reaches a runner by any route', async () => {
  const shapes = [
    ['array', ['command']],
    ['nested array', [['command']]],
    ['object with toString', { toString: () => 'command' }],
    ['number', 1],
    ['boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['String object', new String('command')], // eslint-disable-line no-new-wrappers
  ]
  for (const [label, kind] of shapes) {
    const results = await runChecks([{ name: label, kind, run: 'node -e ""' }], {})
    assert.equal(results[0].status, 'fail', `${label} did not fail`)
    assert.equal(results[0].optional, false, `${label} was optional`)
    assert.match(results[0].output, /kind must be a string/, label)
  }
})

// The control, so none of the above passes by breaking ordinary manifests: string kinds behave
// exactly as before, including the pendings for kinds with no runner and the honoured `optional`
// on an advisory command check.
test('string kinds are unaffected by the type test', async () => {
  const results = await runChecks([
    { name: 'ok', kind: 'command', run: 'node -e ""' },
    { name: 'advisory', kind: 'command', run: 'node -e "process.exit(1)"', optional: true },
    { name: 'review', kind: 'agent' },
  ], { cwd: process.cwd() })
  const byName = Object.fromEntries(results.map((r) => [r.name, r]))
  assert.equal(byName.ok.status, 'pass')
  assert.equal(byName.advisory.status, 'fail')
  assert.equal(byName.advisory.optional, true, 'an advisory command check lost its optional flag')
  assert.equal(byName.review.status, 'pending')
  assert.equal(aggregateVerdict(results).optionalFailed.includes('advisory'), true)
})

// The diagnosis has to name the entry the operator must go and fix. A malformed entry frequently
// carries no `name` — `null` and a bare string are both reachable from a hand-written manifest —
// and `name` is the only field `aggregateVerdict` reports, so two such entries both surfaced as
// `{"failed":[null]}` under a message telling the operator to fix a `kind` on an entry they had
// no way to identify. Position in the phase's check list is what distinguishes them.
test('a nameless malformed entry is reported by its position in the check list', async () => {
  const results = await runChecks([null, { name: 'ok', kind: 'command', run: 'node -e ""' }, 'just a string'], {
    cwd: process.cwd(),
  })
  assert.equal(results[0].status, 'fail')
  assert.equal(results[2].status, 'fail')
  // Distinct, and each one points at the entry it came from — index 0 and index 2, not 0 and 1.
  assert.match(results[0].output, /entry #0 in this phase's check list/)
  assert.match(results[2].output, /entry #2 in this phase's check list/)
  // ...and the verdict line alone locates them, which is where `[null, null]` was printed.
  const { failed } = aggregateVerdict(results)
  assert.deepEqual(failed, ["entry #0 in this phase's check list", "entry #2 in this phase's check list"])
})

// An entry that DOES have a name keeps it — the position is added to the message, not substituted
// for the name, so an operator reading a named failure is not sent hunting by index instead.
test('a named malformed entry keeps its name and still reports its position', async () => {
  const [result] = await runChecks([{ name: 'lint', kind: ['command'], run: 'node -e ""' }], {})
  assert.equal(result.name, 'lint')
  assert.match(result.output, /entry #0 in this phase's check list/)
})

// The same substitution `malformedKindResult` gets, now pinned on `malformedTimeoutResult` too: a
// malformed `timeoutMs` entry with no `name` must report its position as the name, not `check.name`
// unchanged — which would surface as `{"failed":[null]}`, same defect the comment above the
// nameless-entry test at the top of this describes for a bad `kind`.
test('a nameless malformed timeoutMs entry is reported by its position, not as null', async () => {
  const results = await runChecks(
    [{ kind: 'command', run: 'true', timeoutMs: 0 }],
    { cwd: process.cwd(), solo: true, exec: async () => { throw new Error('the check must not run') } },
  )
  assert.equal(results[0].status, 'fail')
  assert.equal(results[0].name, "entry #0 in this phase's check list")
  assert.match(results[0].output, /entry #0 in this phase's check list/)
})

// The number in that message tells the operator which entry of `fleetmates.gate.json` to go and
// fix, so it has to survive a caller that hands `runChecks` a SUBSET of the manifest's list.
// `cli.mjs` does exactly that for `--enforcement-only`, which `complete`, `finish` and `prune-run`
// all accept, by filtering the command checks out first — after which a recounted index names a different
// entry than the message points at. The surviving entries' manifest positions travel on the
// context instead of being recounted here.
test('a filtered check list still reports the manifest position of a malformed entry', async () => {
  // Manifest = [tests(command), lint(command), <malformed>, fileset]; the two command checks are
  // filtered out, so the malformed entry is at list index 0 and manifest index 2.
  const results = await runChecks(
    [{ kind: ['fileset'] }, { name: 'fileset', kind: 'fileset' }],
    { cwd: process.cwd(), checkPositions: [2, 3] },
  )
  assert.equal(results[0].status, 'fail')
  assert.match(results[0].output, /entry #2 in this phase's check list/)
  assert.doesNotMatch(results[0].output, /entry #0 in this phase's check list/)
  // The fallback name carries the same position, so the verdict line alone locates the entry.
  assert.equal(results[0].name, "entry #2 in this phase's check list")
})
// The no-positions fallback — an unfiltered list's own index IS the manifest position — needs no
// test of its own here: the nameless-entry test above supplies no positions and asserts #0 and #2.

// The malformed-timeoutMs path builds its result through `manifestPosition(ctx, index)` too, and
// nothing above exercises that with a non-trivial `checkPositions`: every timeoutMs test in this
// file hands `runChecks` a ctx with no positions, where `manifestPosition` degenerates to the
// bare `index` and cannot tell the two apart. `gate --no-fleet` keeps command checks (unlike
// `--enforcement-only`, which filters them out) and can still filter OTHER checks ahead of one,
// so this offset is reachable in production the same way the kind path's is above.
test('a filtered check list still reports the manifest position of a malformed timeoutMs entry', async () => {
  // Manifest = [tests(command), lint(command), <malformed timeoutMs, no name>, fileset]; the two
  // well-formed command checks are filtered out ahead of it, so the malformed entry sits at
  // list index 0 but manifest index 2. Nameless on purpose, so the fallback name pins the
  // position too, the same way the kind-path test above does.
  const results = await runChecks(
    [{ kind: 'command', run: 'true', timeoutMs: 0 }, { name: 'fileset', kind: 'fileset' }],
    { cwd: process.cwd(), checkPositions: [2, 3], exec: async () => { throw new Error('the check must not run') } },
  )
  assert.equal(results[0].status, 'fail')
  assert.match(results[0].output, /entry #2 in this phase's check list/)
  assert.doesNotMatch(results[0].output, /entry #0 in this phase's check list/)
  assert.equal(results[0].name, "entry #2 in this phase's check list")
})

// The `JSON.stringify` fallback in `malformedKindResult`. Unreachable from `fleetmates.gate.json`,
// which is `JSON.parse`-only — every shape that file can express serialises. It guards the
// EXPORTED api, which `cli.mjs` and these tests call with real JavaScript values, so it is pinned
// through that door: without the `catch`, this throws out of `runChecks` and no verdict is
// recorded at all, which is the failure mode the per-check `try` further down exists to prevent.
test('a kind JSON cannot serialise is still reported rather than thrown', async () => {
  const results = await runChecks([{ name: 'bigint', kind: 10n }], {})
  assert.equal(results[0].status, 'fail')
  assert.equal(results[0].optional, false)
  assert.match(results[0].output, /kind must be a string, got 10/)
})

// `describePendingCheck` is exported and reachable independently of `runChecks`, and it computes
// `optional` from the same non-coercing Set. A non-string kind must be non-optional there too.
test('describePendingCheck forces a non-string kind non-optional', () => {
  assert.equal(describePendingCheck({ name: 'a', kind: ['fileset'], optional: true }).optional, false)
  assert.equal(describePendingCheck({ name: 'b', kind: ['command'], optional: true }).optional, false)
  // ...while a genuine advisory command check keeps its flag.
  assert.equal(describePendingCheck({ name: 'c', kind: 'command', optional: true }).optional, true)
})

test('runChecks records a fail when a runner throws', async () => {
  const git = fakeGit({ branchExists: async () => { throw new Error('unexpected boom') } })
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const results = await runChecks([{ name: 'fileset', kind: 'fileset' }], ctx)
  // The same throw stops the merge preview from being assembled, so the merge check fails too;
  // the fileset check still reports its own throw rather than vanishing behind it.
  assert.equal(results[0].name, 'merge')
  assert.equal(results[0].status, 'fail')
  const fileset = results.find((r) => r.name === 'fileset')
  assert.equal(fileset.status, 'fail')
  assert.match(fileset.output, /check threw/)
  assert.match(fileset.output, /unexpected boom/)
})

// --- tag-shadowing regression: every ref-shaped argument reaching git must be a sha or a
// fully-qualified ref ------------------------------------------------------------------------
//
// A narrower version of this test once asserted only that every `resolveRef` argument was
// fully qualified. That version could not see H1: `deriveContext` called `git.mergeBase`
// with the bare `baseBranch`/`runBranch` strings directly, never routing them through
// `resolveRef` at all, so the earlier test passed while the bypass was live. This version
// records every ref-shaped argument reaching *every* method a bare name could reach —
// mergeBase, isAncestor, commitsBetween, changedFiles, commitParents, fileAtCommit, and
// resolveRef — and requires each to already be a sha or a fully-qualified `refs/...` ref.

function shaFor(ref) {
  // A stable, sha-shaped (40 lowercase hex chars) fake, so downstream calls receive
  // something a real caller could not mistake for a bare branch name.
  let hash = 0x811c9dc5
  const text = String(ref)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').repeat(5).slice(0, 40)
}

function refShapedFakeGit() {
  const calls = { resolveRef: [], mergeBase: [], isAncestor: [], commitsBetween: [], changedFiles: [], commitParents: [], fileAtCommit: [], mergedBranchTips: [] }
  const git = {
    async mergeBase(a, b) { calls.mergeBase.push([a, b]); return shaFor(`merge-base:${a}:${b}`) },
    async fileAtCommit(sha, filePath) { calls.fileAtCommit.push(sha); void filePath; return planMarkdown() },
    async resolveRef(ref) { calls.resolveRef.push(ref); return shaFor(ref) },
    async branchExists(name) { return name === T1_BRANCH || name === T2_BRANCH },
    async isAncestor(ancestor, descendant) { calls.isAncestor.push([ancestor, descendant]); return true },
    async changedFiles({ base, branch }) { calls.changedFiles.push({ base, branch }); return [] },
    async commitsBetween({ from, to }) { calls.commitsBetween.push({ from, to }); return [shaFor('commit1')] },
    async commitParents(sha) { calls.commitParents.push(sha); return [shaFor('parent0'), shaFor('parent1')] },
    async mergedBranchTips({ runSha, anchorSha }) { calls.mergedBranchTips.push({ runSha, anchorSha }); return new Set() },
    async isDirty() { return false },
  }
  return { git, calls }
}

test('every ref-shaped argument reaching git is a sha or a fully-qualified ref', async () => {
  const { git, calls } = refShapedFakeGit()

  await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  await runFilesetCheck(
    { name: 'fileset', kind: 'fileset' },
    { git, runId: RUN_ID, anchorSha: shaFor('anchor'), runSha: shaFor('run'), tasks: [T1_TASK], currentPhase: 1, phaseError: null },
  )
  await runOwnershipCheck(
    { name: 'ownership', kind: 'ownership' },
    { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: shaFor('anchor'), runSha: shaFor('run'), tasks: [T1_TASK] },
  )

  const shaped = (v) => /^[0-9a-f]{40}$/.test(v) || /^refs\//.test(v)
  const assertAllShaped = (label, values) => {
    for (const v of values) assert.ok(shaped(v), `${label} received a bare, non-shaped ref: ${JSON.stringify(v)}`)
  }
  assertAllShaped('resolveRef', calls.resolveRef)
  assertAllShaped('fileAtCommit', calls.fileAtCommit)
  assertAllShaped('mergeBase', calls.mergeBase.flat())
  assertAllShaped('isAncestor', calls.isAncestor.flat())
  assertAllShaped('commitsBetween', calls.commitsBetween.flatMap(({ from, to }) => [from, to]))
  assertAllShaped('changedFiles', calls.changedFiles.flatMap(({ base, branch }) => [base, branch]))
  assertAllShaped('commitParents', calls.commitParents)

  assert.ok(calls.mergeBase.length > 0, 'mergeBase was never called')
  assert.ok(calls.isAncestor.length > 0, 'isAncestor was never called')
  assert.ok(calls.commitsBetween.length > 0, 'commitsBetween was never called')
  assert.ok(calls.changedFiles.length > 0, 'changedFiles was never called')
  assert.ok(calls.commitParents.length >= 0)
  assert.ok(calls.fileAtCommit.length > 0, 'fileAtCommit was never called')
  // `mergedBranchTips` is no longer called by anything in this file — the fix-round rewrite
  // replaced it with `mergedParentFiles`, built from `commitsBetween`/`commitParents`/
  // `changedFiles` directly, which the assertions above already cover.
})

// --- real-repo regressions: H2 (evil merge) and H3 (empty task branch) ----------------------

async function withRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-gate-runner-'))
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await fn({ root, sh, git: createGit({ cwd: root }) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function singleTaskPlan() {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    '',
    '**Depends:** none',
    '',
  ].join('\n')
}

// Two phases whose declared sets OVERLAP: T2 modifies a file T1 created. Legal across phases
// (`scripts/phases.mjs` enforces disjointness only within a phase) and routine in a real plan,
// which is what makes it the shape a containment-only run-tip test lets through.
function overlappingTwoPhasePlan() {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    '- Create: `b.mjs`',
    '',
    '**Depends:** none',
    '',
    '### Task 2: second task',
    '',
    '**Files:**',
    '- Modify: `a.mjs`',
    '',
    '**Depends:** T1',
    '',
  ].join('\n')
}

// Two phases with disjoint declared sets, both of which a single merge carries — so two run-tip
// refs are each individually eligible for the same parent and only scarcity separates them.
function twoPhaseBothFilesPlan() {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    '',
    '**Depends:** none',
    '',
    '### Task 2: second task',
    '',
    '**Files:**',
    '- Modify: `b.mjs`',
    '',
    '**Depends:** T1',
    '',
  ].join('\n')
}

// Three tasks over two phases, with TWO tasks in phase 2 — the shape the anchor-based
// "integrated" test could not judge, because it needs a sibling whose merge moves the run tip
// past a branch parked in that same phase.
function twoInSecondPhasePlan() {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    '',
    '**Depends:** none',
    '',
    '### Task 2: parked task',
    '',
    '**Files:**',
    '- Create: `b.mjs`',
    '',
    '**Depends:** T1',
    '',
    '### Task 3: sibling task',
    '',
    '**Files:**',
    '- Create: `c.mjs`',
    '',
    '**Depends:** T1',
    '',
  ].join('\n')
}

// H2: a merge commit's --no-ff shape is not proof its tree carries only what its second
// parent contributed. Reproduced with `git merge --no-ff --no-commit`, then adding an
// out-of-band file before completing the commit.
test('an evil --no-ff merge that carries extra content is unexplained (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '--no-commit', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'BACKDOOR.mjs'), 'export const backdoor = true\n', 'utf8')
    await sh(['add', '-A'])
    await sh(['commit', '-m', 'Merge T1'])

    const mergeSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'fail')
    assert.match(res.output, new RegExp(mergeSha))
  })
})

// The more useful attack: keep the filename the task legitimately owns, but replace its
// reviewed content during the merge. A name-set comparison (the previous version of this
// check) cannot see this — both the name set and the ancestry look honest. Only a
// byte-for-byte content comparison against the branch's actual contribution catches it.
test('a merge that tampers with content under an unchanged filename is unexplained (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'from-branch\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '--no-commit', 'fleetmates/r1/T1'])
    // Same filename the merge legitimately brings in, different bytes.
    await writeFile(path.join(root, 'a.mjs'), 'TAMPERED-IN-MERGE\n', 'utf8')
    await sh(['add', '-A'])
    await sh(['commit', '-m', 'Merge T1'])

    const mergeSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'fail')
    assert.match(res.output, new RegExp(mergeSha))
  })
})

// The other side of the same coin: an integrator resolving a genuine conflict legitimately
// writes content into the merge commit that matches neither parent verbatim. If the content
// check cannot tell this apart from tampering, it breaks ordinary integration, which is
// worse than the hole it closes. Two branches modify the same line differently from a common
// ancestor; the run branch already carries one of them (phase 1, cleanly merged); merging
// the second produces a real git conflict, hand-resolved and committed.
test('a genuine hand-resolved merge conflict is explained, not flagged as tampering (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), planMarkdown(), 'utf8')
    await writeFile(path.join(root, 'shared.txt'), 'line1\nline2\nline3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // Phase 1: T2 changes shared.txt, merges cleanly onto run.
    await sh(['checkout', '-b', 'fleetmates/r1/T2'])
    await writeFile(path.join(root, 'shared.txt'), 'line1\nline2-T2\nline3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T2', 'fleetmates/r1/T2'])

    // Phase 2: T1, branched from the original anchor (unaware of T2's change), changes the
    // same line differently — a genuine conflict when merged onto run.
    await sh(['checkout', 'main'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'shared.txt'), 'line1\nline2-T1\nline3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    const merge = await sh(['merge', '--no-ff', '--no-commit', 'fleetmates/r1/T1'])
    assert.match(merge.stdout + merge.stderr, /[Cc]onflict/, 'expected a real git conflict to set up this test')
    // Hand-resolve, combining both intents — content matching neither parent verbatim.
    await writeFile(path.join(root, 'shared.txt'), 'line1\nline2-merged\nline3\n', 'utf8')
    await sh(['add', 'shared.txt'])
    await sh(['commit', '-m', 'Merge T1 (resolved conflict)'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'pass', res.output)
  })
})

// H3: isAncestor(X, X) is trivially true, so a task branch created at the run tip with zero
// commits of its own must not read as "integrated" — otherwise a run in which no task did
// any work returns a clean gate PASS.
test('an empty task branch at the run tip does not read as integrated (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    // Created at the run tip; no commits of its own.
    await sh(['branch', 'fleetmates/r1/T1'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    assert.deepEqual(ctx.integratedPhases, [])
    assert.equal(ctx.currentPhase, 1)

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.notEqual(res.output, 'every phase in the plan is integrated')
  })
})

// The shape no ancestry exclusion could see, against real git. T2 is parked at a commit that is
// past the anchor, on the run branch, and no longer its tip — because the run tip moved on after
// T2's ref was created. Ancestry says "landed" for all three of those facts; only the merge that
// carried T1 (and never carried T2) tells them apart.
test('a phase-1 branch parked at an intermediate post-anchor commit fails the fileset check (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])
    const afterT1 = (await sh(['rev-parse', 'run'])).stdout.trim()

    // T2's ref is created here and never moves — the stale-base shape.
    await sh(['branch', 'fleetmates/r1/T2', afterT1])

    // The run tip then moves past it: a sibling branch, outside the plan, is merged in. T2 is
    // now parked at an INTERMEDIATE post-anchor commit — afterT1 is the FIRST parent of this
    // merge, so nothing names it as a branch the run branch carried.
    await sh(['checkout', '-b', 'sibling', afterT1])
    await writeFile(path.join(root, 'c.txt'), 'c\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'sibling work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge sibling', 'sibling'])
    assert.notEqual((await sh(['rev-parse', 'run'])).stdout.trim(), afterT1)

    // The context is built directly rather than through deriveContext: deriveContext decides
    // which phases are integrated by diffing each branch against the run ANCHOR, so a branch
    // parked downstream of a sibling's merge shows that sibling's files and reads as integrated
    // there. That is a separate question in a separate function, and this task does not change
    // it; what is under test here is the fileset check's own landed test against real git.
    const anchorSha = (await sh(['merge-base', 'main', 'run'])).stdout.trim()
    const runSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const ctx = {
      git,
      runId: 'r1',
      runSha,
      anchorSha,
      tasks: [{ id: 'T1', phase: 1, files: ['a.mjs'] }, { id: 'T2', phase: 1, files: ['b.mjs'] }],
      currentPhase: 1,
      phaseError: null,
    }
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)

    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
    // T1 was genuinely merged in, so its empty diff is still excused.
    assert.doesNotMatch(res.output, /T1:/)
  })
})

// The merge-parent test subsumes the TIP exclusion but NOT the anchor exclusion, because this
// plugin's own plan-amendment procedure merges the base branch into the run branch — so the base
// tip is a secondary parent of a merge inside the range, and for a run whose amendments have all
// landed, merge-base(base, run) IS that base tip. Without filtering, the anchor is a member of
// the merged set, and a task branch parked at the anchor — a teammate that ran
// `git checkout -B <task> <base>`, committed on some other ref, and left the conventional ref
// empty — reads as merged and the phase integrates a no-op. This is the shape the old
// `!isAncestor(sha, anchorSha)` clause caught, and an enforcing check must never get less strict.
test('a task branch parked at the anchor still fails after a plan amendment merged the base in (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await writeFile(path.join(root, 'run.txt'), 'r1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'r1'])

    // The plan amendment: the base advances, and the run branch merges it in.
    await sh(['checkout', 'main'])
    await writeFile(path.join(root, 'plan.md'), 'amended\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'amend the plan'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'merge: plan amendment', 'main'])

    const anchorSha = (await sh(['merge-base', 'main', 'run'])).stdout.trim()
    const runSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    assert.equal(anchorSha, (await sh(['rev-parse', 'main'])).stdout.trim(), 'fixture: the anchor is the base tip')

    // The stale ref: created off the base, never moved, carrying nothing.
    await sh(['branch', 'fleetmates/r1/T14', anchorSha])

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, {
      git, runId: 'r1', runSha, anchorSha,
      tasks: [{ id: 'T14', phase: 1, files: ['a.mjs'] }], currentPhase: 1, phaseError: null,
    })

    assert.equal(res.status, 'fail')
    assert.match(res.output, /T14: branch fleetmates\/r1\/T14 contributes no file changes/)
  })
})

// The limit the comment above the landed test states, pinned so the comment is checkable rather
// than merely plausible. A branch integrated by FAST-FORWARD carries real work, but leaves no
// merge commit to name it and no diff past its own fork point, so it is indistinguishable from a
// branch parked at that same commit and is failed. `tm-integrator`'s contract is `--no-ff` for
// exactly this reason. If this test ever starts failing, the comment is what needs revisiting.
test('a fast-forward-integrated branch is failed, not excused — the stated limit (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--ff-only', 'fleetmates/r1/T1'])

    const anchorSha = (await sh(['merge-base', 'main', 'run'])).stdout.trim()
    const runSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, {
      git, runId: 'r1', runSha, anchorSha,
      tasks: [{ id: 'T1', phase: 1, files: ['a.mjs'] }], currentPhase: 1, phaseError: null,
    })

    assert.equal(res.status, 'fail')
    assert.match(res.output, /contributes no file changes/)
  })
})

// The same limit, at `deriveContext`'s own level rather than `runFilesetCheck`'s: a
// fast-forward leaves no merge commit, so the branch's sha is never a key in `mergedFiles`
// (built by `mergedParentFiles`, which walks only merge commits), and `landedForFiles` reads
// false even though the work genuinely is on the run branch. `tm-integrator`'s contract is
// `--no-ff` for exactly this reason.
test('deriveContext does not read a fast-forward-integrated branch as integrated (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--ff-only', 'fleetmates/r1/T1'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    assert.deepEqual(ctx.integratedPhases, [])
    assert.equal(ctx.currentPhase, 1)
  })
})

// H3-empty: a single `git commit --allow-empty`, honestly merged, is a real commit — a
// commit-counting guard would call the phase integrated even though the branch touched no
// file. The guard must count file changes, not commits.
test('a branch consisting only of an empty commit does not read as integrated (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await sh(['commit', '--allow-empty', '-m', 'empty T1 commit'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    assert.deepEqual(ctx.integratedPhases, [])
    assert.equal(ctx.currentPhase, 1)
  })
})

// V3: a merge that brings in a file and deletes it before committing is invisible to a diff
// taken only between the merge commit and its first parent — added, then removed, nets to
// no difference at all. Deletion is a content change with no legitimate source, exactly like
// a fabricated addition, and must be caught the same way.
test('a merge that deletes the task branch\'s entire contribution is unexplained (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'content\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '--no-commit', 'fleetmates/r1/T1'])
    await sh(['rm', '-f', 'a.mjs'])
    await sh(['commit', '-m', 'Merge T1 (dropped)'])

    const mergeSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'fail')
    assert.match(res.output, new RegExp(mergeSha))
  })
})

// H1: `fileset` must diff a task branch against its actual fork point off the run branch, not
// against the run anchor fixed at the start of the whole run. A phase-2 branch legitimately
// forks from the run branch *after* phase 1 was merged into it, so phase 1's files land in a
// phase-2 branch's diff against the (stale) anchor even though the phase-2 teammate never
// touched them. `anchor...branch` does not save this either: once the anchor is an ancestor of
// the branch, `merge-base(anchor, branch) == anchor`, so the three-dot diff degenerates to the
// same two-dot diff. The fix diffs against `merge-base(runSha, branchSha)` instead — the task
// branch's real fork point off the run branch as it stood when the teammate branched.
test('runFilesetCheck does not blame a phase-2 branch for phase-1 files merged onto run before it forked (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), planMarkdown(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // Phase 1: T1 commits a.mjs, merged --no-ff onto run.
    await sh(['checkout', '-b', T1_BRANCH])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', T1_BRANCH])

    // Phase 2: T2 branches off run *after* phase 1 landed, and commits only b.mjs.
    await sh(['checkout', '-b', T2_BRANCH])
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 work'])
    await sh(['checkout', 'run'])

    const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
    assert.equal(ctx.currentPhase, 2)
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'pass', res.output)

    // Extend: T2 also commits a stray file. The fail must name only the stray file, not
    // a.mjs, which T2 never touched.
    await sh(['checkout', T2_BRANCH])
    await writeFile(path.join(root, 'stray.mjs'), 'export const stray = true\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 stray commit'])
    await sh(['checkout', 'run'])

    const ctx2 = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
    const res2 = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx2)
    assert.equal(res2.status, 'fail')
    assert.match(res2.output, /stray\.mjs/)
    assert.doesNotMatch(res2.output, /a\.mjs/)
  })
})

// The same stale base, one function earlier: `deriveContext` decided whether a phase was
// integrated by diffing each task branch against the run ANCHOR. From phase 2 onward the run tip
// is past the anchor, so a branch parked at the run tip and never committed to shows the SIBLING'S
// merged files as its own work; the phase reads integrated, `derivePhase` advances past it, and
// `runFilesetCheck` takes its "every phase in the plan is integrated" fast path — so the landed
// test below never runs for that task at all and the empty ref merges as a no-op behind a PASS.
// A fake git cannot exhibit this: it lives in what real `merge-base` and `changedFiles` return.
test('a phase-2 branch parked at the run tip does not read as integrated (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoInSecondPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // Phase 1: real work, merged --no-ff, so the run tip is now past the anchor.
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])
    const afterT1 = (await sh(['rev-parse', 'run'])).stdout.trim()

    // Phase 2, T2: the ref is created at the run tip as it stands right now and never moves —
    // the teammate committed on some other branch, or never committed at all.
    await sh(['branch', 'fleetmates/r1/T2', afterT1])

    // Phase 2, T3: real work, merged --no-ff, so the run tip moves past where T2 is parked.
    await sh(['checkout', '-b', 'fleetmates/r1/T3', afterT1])
    await writeFile(path.join(root, 'c.mjs'), 'export const c = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T3 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T3', 'fleetmates/r1/T3'])
    assert.notEqual((await sh(['rev-parse', 'run'])).stdout.trim(), afterT1)

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    // Phase 1 genuinely integrated; phase 2 is not, because T2 contributed nothing of its own.
    assert.deepEqual(ctx.integratedPhases, [1])
    assert.equal(ctx.currentPhase, 2)
    assert.equal(ctx.phaseError, null)

    // And because phase 2 is still the current phase, the landed test is actually reached:
    // T2 is reported as contributing nothing, while T3's merged (and therefore empty) diff is
    // still excused.
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
    assert.doesNotMatch(res.output, /T3:/)
  })
})

// Fix-round rewrite (round 4): three earlier designs tried to classify the SHARED SHA as
// suspicious or benign, and each broke something real (see the comment above `mergedParentFiles`
// in scripts/gate-runner.mjs for the full history). This test pins the design that replaced
// them: T3 does the real work and is merged `--no-ff`; T2 never commits and its ref is pointed
// at T3's own tip instead of at the merge commit that carried it. `deriveContext` no longer
// special-cases the shared sha at all — it asks, per task, whether the merge that landed this
// sha actually carried THIS task's declared files. The merge that landed T3's tip carried
// `c.mjs`, T3's own file, never T2's `b.mjs`, so T2 reads false and phase 2 does not integrate
// on T3's legitimate merge alone. `integratedPhases` is the ordinary computed array on every
// path — no dedicated phaseError, no silent exclusion. Phase 1 IS genuinely integrated and
// phase 2 genuinely is not, so `currentPhase` reads the unremarkable 2, and
// `runFilesetCheck`'s own empty-diff test (over the SAME shared `mergedParentFiles` index)
// reports T2's true, actionable, self-contained failure.
test('deriveContext does not credit a ref parked on a merged sibling\'s tip, and integratedPhases stays the computed set', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoInSecondPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    await sh(['checkout', '-b', 'fleetmates/r1/T3'])
    await writeFile(path.join(root, 'c.mjs'), 'export const c = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T3 work'])
    const t3Tip = (await sh(['rev-parse', 'fleetmates/r1/T3'])).stdout.trim()
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T3', 'fleetmates/r1/T3'])

    // T2 never commits: its ref is pointed straight at T3's own tip commit.
    await sh(['branch', 'fleetmates/r1/T2', t3Tip])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    // Phase 1 genuinely integrated, and `integratedPhases` says so directly — no dedicated
    // phaseError, no `[]` regardless of what is actually integrated (the shape that inverted
    // `plan-drift`'s verdict in the previous fix round).
    assert.deepEqual(ctx.integratedPhases, [1])
    assert.equal(ctx.currentPhase, 2)
    assert.equal(ctx.phaseError, null)

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
    assert.doesNotMatch(res.output, /T3:/)
  })
})

// The discriminator's other half: two refs sharing the RUN TIP itself are the ordinary state
// every fleet passes through between `git checkout -B <task> <run branch>` and its first
// commit. Reproduced with the real CLI (fix-round finding A): a phase-1 plan with every task
// branch freshly created and nothing committed used to report each task as "parked at" a
// sibling; the true, actionable cause is that none of them has done any work yet.
test('deriveContext does not treat siblings sharing the run tip as a violation (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoInSecondPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // T1 is the only phase-1 task in this plan; give it its own real, unmerged commit so the
    // run tip advances past main, then park T2 and T3 (both phase 2, still un-started) exactly
    // where `git checkout -B <task> <run branch>` would put them.
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    const runTip = (await sh(['rev-parse', 'run'])).stdout.trim()
    await sh(['branch', 'fleetmates/r1/T2', runTip])
    await sh(['branch', 'fleetmates/r1/T3', runTip])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    assert.equal(ctx.phaseError, null)
    assert.deepEqual(ctx.integratedPhases, [1])
    assert.equal(ctx.currentPhase, 2)

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
    assert.match(res.output, /T3: branch fleetmates\/r1\/T3 contributes no file changes/)
    assert.doesNotMatch(res.output, /parked at the other's tip/)
  })
})

// The plan-amendment shape, against the merge index `deriveContext` uses to find a merged
// branch's fork point. This plugin's amendment procedure merges the BASE branch into the run
// branch, so the base tip is printed as a secondary parent of a merge inside anchor..run — and
// for a run whose amendments have landed, merge-base(base, run) IS that base tip. An index that
// keys every secondary parent therefore keys the ANCHOR, and a task ref parked there gets a
// fork point far behind the anchor, filling its diff with the base branch's own commits. It
// would read as work, its phase would read integrated, `currentPhase` would go null, and
// `runFilesetCheck` would return the vacuous "every phase in the plan is integrated" pass — the
// exact pass the fork-point base exists to stop reaching. `mergedBranchTips` filters its parents
// to the range for this same reason; the index must filter the same way.
//
// Not a constructed shape: `run/followups` itself carries `merge: plan amendment` commits.
test('a task branch parked at the anchor does not read as integrated after a plan amendment (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), planMarkdown(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // Phase 1: real work, merged --no-ff.
    await sh(['checkout', '-b', T1_BRANCH])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', T1_BRANCH])

    // The plan amendment: the base advances and the run branch merges it in, so the base tip
    // is a secondary parent of a merge inside anchor..run, and is itself the anchor.
    await sh(['checkout', 'main'])
    await writeFile(path.join(root, 'amend.txt'), 'amended\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'amend the plan'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'merge: plan amendment', 'main'])

    const anchorSha = (await sh(['merge-base', 'main', 'run'])).stdout.trim()
    assert.equal(anchorSha, (await sh(['rev-parse', 'main'])).stdout.trim(), 'fixture: the anchor is the base tip')

    // Phase 2's ref: created off the base, never committed to.
    await sh(['branch', T2_BRANCH, anchorSha])

    const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })

    assert.deepEqual(ctx.integratedPhases, [1])
    assert.equal(ctx.currentPhase, 2)
    assert.equal(ctx.phaseError, null)

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
  })
})

// V5: pinned exactly to the coordinator's literal reported repro (both tasks declaring the
// same file, T1 merging clean first, T2 conflicting second) to settle a reported
// contradiction. Extensive re-testing (this shape, the reverse order, and a variant where
// the seed commit lives only on the run branch) could not reproduce a FAIL — this
// implementation returns PASS for all of them, consistent with the one-sentence rule stated
// above mergeContentExplainedByParents. Pinned here so any future regression is caught, and
// so the exact tested shape is on record.
test('a hand-resolved conflict over the coordinator\'s exact V5 scenario is explained, not flagged (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), [
      '### Task 1: first task',
      '',
      '**Files:**',
      '- Create: `a.mjs`',
      '',
      '**Depends:** none',
      '',
      '### Task 2: second task',
      '',
      '**Files:**',
      '- Create: `a.mjs`',
      '',
      '**Depends:** none',
      '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(root, 'a.mjs'), 'line1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'line1 edited by T1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', '-b', 'fleetmates/r1/T2', 'main'])
    await writeFile(path.join(root, 'a.mjs'), 'line1 edited by T2\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])
    const conflict = await sh(['merge', '--no-ff', '--no-commit', 'fleetmates/r1/T2'])
    assert.match(conflict.stdout + conflict.stderr, /[Cc]onflict/, 'expected a real git conflict to set up this test')
    await writeFile(path.join(root, 'a.mjs'), 'line1 edited by T1 and T2\n', 'utf8')
    await sh(['add', 'a.mjs'])
    await sh(['commit', '-m', 'Merge T2'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'pass', res.output)
  })
})

// --- runChecks merge preview -----------------------------------------------------------------
//
// The gate's `command` checks are meaningless against any tree but the one integration will
// actually produce, so runChecks builds the phase's merge preview itself and runs the whole
// check list inside it. These tests pin the four outcomes that preview can have — clean,
// conflicted, failed outright, and "no branches to merge" — plus the fact that a manifest can
// neither supply nor suppress the computed `merge` check.

const T2_PHASE1_TASK = { id: 'T2', phase: 1, files: ['b.mjs'] }

// A git double carrying the worktree methods withMergePreview drives. The defaults describe a
// phase whose branches all exist and merge cleanly.
function previewGit(overrides = {}) {
  return fakeGit({
    branchExists: async () => true,
    addWorktreeDetached: async (dir) => dir,
    mergeInto: async () => null,
    removeWorktree: async () => true,
    ...overrides,
  })
}

function previewCtx(overrides = {}) {
  return {
    cwd: '/project/root',
    runId: RUN_ID,
    runBranch: RUN_BRANCH,
    baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1',
    runSha: 'runSha1',
    tasks: [T1_TASK],
    currentPhase: 1,
    phaseError: null,
    ...overrides,
  }
}

// `onSpawn` is captured alongside `cmd`/`cwd` so a call site can assert it is exactly `null`
// outside a preview — `runCommandCheck` only builds a real claim writer when it is handed a
// non-null `previewDir`, and a caller that wired the wrong value in either direction (a real
// path where there should be none, or `null` where a preview really exists) shows up here.
const recordingExec = (calls, result = { code: 0, output: '' }) => async (cmd, cwd, opts) => {
  calls.push({ cmd, cwd, onSpawn: opts?.onSpawn ?? null })
  return result
}

test('a command check runs inside the merge preview worktree when the phase merges cleanly', async () => {
  const calls = []
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec(calls) })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)

  assert.deepEqual(results.map((r) => [r.name, r.kind, r.status]), [
    ['merge', 'merge', 'pass'],
    ['test', 'command', 'pass'],
  ])
  assert.equal(calls.length, 1)
  assert.notEqual(calls[0].cwd, '/project/root', 'the command must not run against the project root')
  assert.match(calls[0].cwd, /tm-preview-/)
})

// `runCommandCheck` only holds a claim when it is HANDED a real `previewDir` — proven above by
// unit tests that call it directly and supply `previewDir` by hand. Neither of those tests can
// see whether `runChecks`/`runCheckList` actually WIRE the real preview path through to it: a
// dropped fifth argument at the `runCheckList` call site, or a dropped `previewDir` from the
// ctx spread inside `runCheckList`, both silently default back to `null` and leave the rest of
// the suite green, because every other test either doubles `previewDir` itself or never
// inspects `onSpawn`. This test goes through `runChecks` end to end, against the real preview
// directory `withMergePreview` creates on disk, and fails loudly — via the exec double's own
// throw — the moment that wiring is missing.
test('a command check inside a real merge preview is actually handed a claim writer, not just told it could be', async () => {
  let duringExists = null
  let claimPath = null
  const exec = async (_cmd, cwd, { onSpawn }) => {
    if (typeof onSpawn !== 'function') throw new Error('a check inside a preview must be handed a claim writer')
    onSpawn(999996)
    claimPath = previewClaimPath(cwd, 999996)
    duringExists = existsSync(claimPath)
    return { code: 0, output: '' }
  }
  const ctx = previewCtx({ git: previewGit(), exec })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)

  assert.equal(results[1].status, 'pass', results[1].output)
  assert.equal(duringExists, true, 'the claim must exist on disk in the real preview while the check runs')
  assert.equal(existsSync(claimPath), false, 'the claim must be released once the check returns')
})

test('the computed merge check can never be marked optional by a manifest', async () => {
  const ctx = previewCtx({ git: previewGit({ mergeInto: async () => ['a.mjs'] }) })
  const results = await runChecks([], ctx)
  assert.equal(results[0].name, 'merge')
  assert.equal(results[0].optional, false)
})

test('a conflicting phase fails the merge check with the pair report and skips every command check', async () => {
  const calls = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async () => ['a.mjs', 'b.mjs'] }),
    exec: recordingExec(calls),
    tasks: [T1_TASK, T2_PHASE1_TASK],
  })
  const results = await runChecks([
    { name: 'test', kind: 'command', run: 'npm test' },
    { name: 'lint', kind: 'command', run: 'npm run lint' },
  ], ctx)

  const [merge, ...rest] = results
  assert.equal(merge.name, 'merge')
  assert.equal(merge.status, 'fail')
  assert.deepEqual(merge.pairs, [{ branches: [T1_BRANCH, T2_BRANCH], paths: ['a.mjs', 'b.mjs'] }])
  // The report names both branches and both paths, so the fix loop can escalate to a pair
  // rather than blaming one owner.
  assert.deepEqual(JSON.parse(merge.output), merge.pairs)

  assert.deepEqual(rest.map((r) => r.status), ['skip', 'skip'])
  for (const r of rest) assert.match(r.output, /does not merge cleanly/)
  assert.equal(calls.length, 0, 'no command may run against the unmerged tree')
})

// The timeoutMs guard in runCheckList runs BEFORE the merge-conflict skip on purpose: a
// malformed bound is a configuration fault, and a phase that does not merge is exactly where it
// would otherwise go unreported — reordered below the skip, this same entry would report a
// benign `skip` carrying CONFLICT_SKIP instead of the fault, and the fault would stay invisible
// until the conflict was fixed and the check finally ran. Pinned the same way the neighbouring
// hasUsableKind-before-the-skip claim is pinned: this needs a conflicted preview to reach at
// all, which is why it lives here and not next to the other timeoutMs tests.
test('a malformed timeoutMs fails its entry even when the phase does not merge cleanly', async () => {
  const calls = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async () => ['a.mjs', 'b.mjs'] }),
    exec: recordingExec(calls),
    tasks: [T1_TASK, T2_PHASE1_TASK],
  })
  const results = await runChecks(
    [{ name: 'test', kind: 'command', run: 'npm test', timeoutMs: 0 }],
    ctx,
  )
  const [merge, entry] = results
  assert.equal(merge.name, 'merge')
  assert.equal(merge.status, 'fail')
  assert.equal(entry.status, 'fail')
  assert.match(entry.output, /timeoutMs must be a positive integer/)
  assert.doesNotMatch(entry.output, /does not merge cleanly/)
  assert.equal(calls.length, 0, 'no command may run against the unmerged tree')
})

test('a conflicting phase yields FAIL, and the block comes from the merge check itself', async () => {
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async () => ['a.mjs'] }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T2_PHASE1_TASK],
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  const verdict = aggregateVerdict(results)
  assert.equal(verdict.verdict, 'FAIL')
  // aggregateVerdict does not block on `skip`; the skipped command checks are reporting only.
  assert.deepEqual(verdict.failed, ['merge'])
  assert.deepEqual(verdict.skipped, ['test'])
})

// withMergePreview rejects when the preview could not be built at all — a merge that failed
// without leaving unmerged paths (unset user.email, a deleted branch, unrelated histories),
// or a worktree that could not be created. That is neither a clean tree nor a reportable
// conflict, so the gate records the merge check as a fail carrying git's reason and skips the
// command checks rather than running them against the unmerged tree.
test('a merge preview that fails outright fails the merge check and skips the command checks', async () => {
  const calls = []
  const ctx = previewCtx({
    // mergeInto reporting a conflict with no paths: withMergePreview throws rather than
    // handing the callback a conflict naming nothing.
    git: previewGit({ mergeInto: async () => [] }),
    exec: recordingExec(calls),
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)

  assert.equal(results[0].name, 'merge')
  assert.equal(results[0].status, 'fail')
  assert.match(results[0].output, /merge preview/)
  assert.equal(results[1].status, 'skip')
  assert.equal(calls.length, 0, 'no command may run when the preview could not be built')
  assert.equal(aggregateVerdict(results).verdict, 'FAIL')
})

test('a solo run builds no merge preview and runs command checks against the project root', async () => {
  const calls = []
  // A solo (--no-fleet) ctx carries no git at all; ctx.solo is honoured too, so a caller that
  // says so explicitly is never previewed either.
  for (const ctx of [
    { cwd: '/project/root', exec: recordingExec(calls) },
    { cwd: '/project/root', exec: recordingExec(calls), solo: true, git: previewGit() },
  ]) {
    const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
    assert.deepEqual(results.map((r) => r.name), ['test'])
    assert.equal(results[0].status, 'pass')
  }
  assert.deepEqual(calls.map((c) => c.cwd), ['/project/root', '/project/root'])
  // A solo run stands in the repository itself, not a preview: a claim written there is
  // litter naming nothing the reaper reads, so `onSpawn` must never reach `exec` at all.
  assert.deepEqual(calls.map((c) => c.onSpawn), [null, null])
})

test('a phase with no task branches passes the merge check and runs commands against the run tree', async () => {
  const calls = []
  const ctx = previewCtx({
    git: previewGit({
      branchExists: async () => false,
      addWorktreeDetached: async () => { throw new Error('no worktree may be created with nothing to merge') },
    }),
    exec: recordingExec(calls),
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['merge', 'pass'], ['test', 'pass']])
  assert.deepEqual(calls.map((c) => c.cwd), ['/project/root'])
  // `path` is null here — nothing was merged — and null is not a preview: a claim written
  // beside the run branch's own tree would name nothing the reaper reads either.
  assert.deepEqual(calls.map((c) => c.onSpawn), [null])
})

test('a manifest entry claiming kind "merge" finds no runner and lands as pending, blocking the phase', async () => {
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec([]) })
  const results = await runChecks([{ name: 'merge', kind: 'merge' }], ctx)
  // The first result is the gate's own computed merge check; the manifest's entry cannot
  // supply or suppress it, and lands as pending.
  assert.deepEqual(results.map((r) => r.status), ['pass', 'pending'])
  const verdict = aggregateVerdict(results)
  assert.equal(verdict.verdict, 'FAIL')
  assert.deepEqual(verdict.pending, ['merge'])
})

test('a manifest entry claiming kind "merge" cannot mark itself optional to escape blocking', async () => {
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec([]) })
  const results = await runChecks([{ name: 'merge', kind: 'merge', optional: true }], ctx)
  assert.equal(results[1].status, 'pending')
  assert.equal(results[1].optional, false)
  assert.equal(aggregateVerdict(results).verdict, 'FAIL')
})

// The worktree has to outlive the whole check list, not just the merge: if withMergePreview's
// callback returned as soon as the merge was known, the directory would already be gone by the
// time the first command ran.
test('the preview worktree is removed once, after the last check has run inside it', async () => {
  const order = []
  const git = previewGit({
    addWorktreeDetached: async (dir) => {
      await writeFile(path.join(dir, 'marker.txt'), 'inside the preview\n', 'utf8')
      order.push('add')
      return dir
    },
    removeWorktree: async (dir) => { order.push('remove'); assert.match(dir, /tm-preview-/); return true },
  })
  const read = []
  const exec = async (cmd, cwd) => {
    order.push(cmd)
    read.push((await readFile(path.join(cwd, 'marker.txt'), 'utf8')).trim())
    return { code: 0, output: '' }
  }
  const results = await runChecks([
    { name: 'test', kind: 'command', run: 'npm test' },
    { name: 'lint', kind: 'command', run: 'npm run lint' },
  ], previewCtx({ git, exec }))

  assert.deepEqual(results.map((r) => r.status), ['pass', 'pass', 'pass'])
  assert.deepEqual(read, ['inside the preview', 'inside the preview'])
  assert.deepEqual(order, ['add', 'npm test', 'npm run lint', 'remove'])
  assert.equal(order.filter((o) => o === 'remove').length, 1)
})

// The fail-closed clause in aggregateVerdict ("no checks ran, so nothing was verified") has to
// survive the gate prepending its own computed results to the list. An enforced agent that
// empties the working-tree manifest — the very edit that stops `fileset` and `ownership` from
// running — must not turn the phase green just because the gate's own `merge` check is sitting
// in the results array. The regression test for this invariant that calls aggregateVerdict([])
// directly cannot see it: the array is never empty by the time it is aggregated. These go
// through runChecks.
test('a manifest that contributed zero checks fails the phase even though the gate computed a merge result', async () => {
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec([]) })
  const results = await runChecks([], ctx)
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['merge', 'pass']])
  const verdict = aggregateVerdict(results)
  assert.equal(verdict.verdict, 'FAIL', 'a passing self-generated merge is not a verified phase')
})

test('an empty manifest fails the phase on every preview outcome, and matches --no-fleet', async () => {
  const outcomes = {
    clean: previewGit(),
    conflicted: previewGit({ mergeInto: async () => ['a.mjs'] }),
    // mergeInto reporting a conflict with no paths: withMergePreview throws, so this is the
    // preview-could-not-be-built path.
    unbuildable: previewGit({ mergeInto: async () => [] }),
  }
  for (const [name, git] of Object.entries(outcomes)) {
    const results = await runChecks([], previewCtx({ git, exec: recordingExec([]) }))
    assert.equal(aggregateVerdict(results).verdict, 'FAIL', `empty manifest passed on the ${name} preview`)
  }
  // The solo path builds no preview at all and has always failed closed here. The two modes
  // must agree: an empty check list is never a pass.
  assert.equal(aggregateVerdict(await runChecks([], { cwd: '/project/root', solo: true })).verdict, 'FAIL')
})

// The counterpart: one real manifest check is enough to make the list non-empty, so the fix
// above cannot be satisfied by failing every fleet phase.
test('a single passing manifest check still yields PASS alongside the computed merge result', async () => {
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec([]) })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.equal(aggregateVerdict(results).verdict, 'PASS')
})

// The preview must be built from the *run branch*, the tree integration actually merges into,
// not from the base branch. In a two-phase run whose phase 1 is already merged into the run
// branch, a preview built from the base would hand phase 2 a tree with none of phase 1's code
// in it: command checks fail against a tree integration will never produce, and a
// phase-1/phase-2 conflict is blamed on the wrong pair. Nothing else asserts the ref, so
// swapping it stays green.
test('the preview worktree is created from the run branch, not the base branch', async () => {
  const bases = []
  const ctx = previewCtx({
    git: previewGit({ addWorktreeDetached: async (dir, base) => { bases.push(base); return dir } }),
    exec: recordingExec([]),
  })
  await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(bases, [RUN_BRANCH])
  assert.notEqual(bases[0], BASE_BRANCH)
})

// The previewed branch set is the current phase's, resolved exactly the way the fileset check
// resolves it. Without this, a phase-2 teammate pushing a branch while phase 1 is being gated
// gets merged into phase 1's preview, and a conflict or a broken command among branches outside
// the phase fails phase 1 — sending the fix loop at tasks that are not even in it.
test('only the current phase\'s branches are merged into the preview', async () => {
  const merged = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async (_dir, branches) => { merged.push(...branches); return null } }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T2_PHASE1_TASK, { id: 'T3', phase: 2, files: ['c.mjs'] }],
  })
  await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(merged, [T1_BRANCH, T2_BRANCH])
  assert.ok(!merged.includes('fleetmates/r1/T3'), 'a phase-2 branch must not reach a phase-1 preview')
})

// The `previewed` guard exists so a throw raised *after* the callback resolved can never re-run
// checks that already ran. Unreachable with the real accessor — its removeWorktree is async, so
// withMergePreview's `.catch()` swallows it — but reachable with one that throws synchronously,
// which is exactly the shape a future edit could introduce.
test('a throw raised after the checks already ran does not run them a second time', async () => {
  const calls = []
  let branchExistsCalls = 0
  const git = previewGit({
    branchExists: async () => { branchExistsCalls += 1; return true },
    // Synchronous throw: `git.removeWorktree(dir).catch(...)` never gets a promise to catch, so
    // the rejection escapes the `finally` after `run` has already resolved.
    removeWorktree: () => { throw new Error('worktree teardown boom') },
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], previewCtx({ git, exec: recordingExec(calls) }))

  assert.equal(branchExistsCalls, 1, 'the branch set must not be reassembled for a second run')
  assert.equal(calls.length, 1, 'the command check must not execute twice')
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['merge', 'fail'], ['test', 'fail']])
  assert.match(results[0].output, /worktree teardown boom/)
  assert.equal(aggregateVerdict(results).verdict, 'FAIL')
})

test('a branch lookup that throws while assembling the preview fails the merge check, not the run', async () => {
  const calls = []
  const ctx = previewCtx({
    git: previewGit({ branchExists: async () => { throw new Error('branch lookup boom') } }),
    exec: recordingExec(calls),
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.equal(results[0].name, 'merge')
  assert.equal(results[0].status, 'fail')
  assert.match(results[0].output, /branch lookup boom/)
  assert.equal(results[1].status, 'skip')
  assert.equal(calls.length, 0)
})

// --- ctx.taskScope: narrowing a `complete` invocation to one task --------------------------
//
// `complete` verifies the calling task, not the whole phase, so `cli.mjs` marks its context
// with `taskScope: <task id>`. `gate` never sets it. Two places in this file honour the marker
// — the previewed branch set and the fileset check's phase-task list — while `runOwnershipCheck`
// deliberately does not, which is the whole reason the narrowing travels as a marker rather
// than as a pre-filtered `ctx.tasks`: ownership must keep explaining *every* commit on the run
// branch, and a filtered task list would silently hide a direct write riding in behind
// whichever task happens to finish first.
//
// These tests drive `runChecks` / `runFilesetCheck` / `runOwnershipCheck` directly, so they pin
// this file's half of the contract whether or not the `cli.mjs` half has landed yet.

const T3_PHASE2_TASK = { id: 'T3', phase: 2, files: ['c.mjs'] }
const T3_BRANCH = 'fleetmates/r1/T3'

// The finding this closes: with the phase-wide branch set, the first teammate of a 3-task phase
// to run `complete` gets every sibling's branch merged into its preview. A sibling's stray
// commit — or a sibling branch that does not exist yet — fails the preview, and the teammate
// reads it as "my own work is broken".
test('with taskScope set, only that task\'s branch is merged into the preview', async () => {
  const merged = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async (_dir, branches) => { merged.push(...branches); return null } }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T2_PHASE1_TASK],
    taskScope: 'T2',
  })
  await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(merged, [T2_BRANCH])
  assert.ok(!merged.includes(T1_BRANCH), 'a sibling\'s branch must not reach a task-scoped preview')
})

// The paired half, and the property most worth pinning: absent the marker — every `gate`
// invocation — the previewed set is byte-for-byte the phase-wide set it has always been.
test('with taskScope absent, the previewed branch set is the whole phase, unchanged', async () => {
  const merged = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async (_dir, branches) => { merged.push(...branches); return null } }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T2_PHASE1_TASK, T3_PHASE2_TASK],
  })
  assert.equal(ctx.taskScope, undefined)
  await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(merged, [T1_BRANCH, T2_BRANCH])
})

// A taskScope that names nothing in the current phase narrows to zero tasks, which the existing
// "selected no tasks" guard turns into a fail. Fail-closed, not a vacuous pass.
test('a taskScope naming no task in the current phase previews nothing and does not pass vacuously', async () => {
  const merged = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async (_dir, branches) => { merged.push(...branches); return null } }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T3_PHASE2_TASK],
    taskScope: 'T3',
  })
  const results = await runChecks([{ name: 'fileset', kind: 'fileset' }], ctx)
  assert.deepEqual(merged, [])
  assert.equal(results.find((r) => r.name === 'fileset').status, 'fail')
  assert.equal(aggregateVerdict(results).verdict, 'FAIL')
})

const scopedFilesetGit = () => fakeGit({
  branchExists: async () => true,
  // T2's branch carries a path outside its declared set; T1's is clean.
  changedFiles: async ({ branch }) => (branch.includes('T2') ? ['b.mjs', 'stray.mjs'] : ['a.mjs']),
})

test('with taskScope set, runFilesetCheck considers only that task', async () => {
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git: scopedFilesetGit(), runId: RUN_ID, anchorSha: 'anchorSha1', runSha: 'runSha1',
    tasks: [T1_TASK, T2_PHASE1_TASK], currentPhase: 1, phaseError: null, taskScope: 'T1',
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass', 'a sibling\'s violation must not fail the scoped task')
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha` })
})

// The same context without the marker: the sibling's violation is exactly as fatal as it is
// today. Together with the test above this pins that the narrowing is the marker's doing and
// nothing else.
test('with taskScope absent, runFilesetCheck still walks every task in the phase', async () => {
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git: scopedFilesetGit(), runId: RUN_ID, anchorSha: 'anchorSha1', runSha: 'runSha1',
    tasks: [T1_TASK, T2_PHASE1_TASK], currentPhase: 1, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /T2: outside declared set/)
  assert.deepEqual(res.branchShas, {
    [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha`,
    [T2_BRANCH]: `refs/heads/${T2_BRANCH}-sha`,
  })
})

// The all-integrated short-circuit records branch shas for verdictCoversTree rather than
// diffing. A task-scoped verdict must not claim to cover a sibling's branch either: recording
// one would let a sibling moving its branch invalidate this task's verdict.
test('with taskScope set, the all-integrated path records only that task\'s branch sha', async () => {
  const git = fakeGit({ branchExists: async () => true })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK, T2_PHASE1_TASK],
    currentPhase: null, phaseError: null, taskScope: 'T2',
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.deepEqual(res.branchShas, { [T2_BRANCH]: `refs/heads/${T2_BRANCH}-sha` })
})

// Ownership is the one that must NOT narrow. A commit explained only by a *sibling's* branch
// stays explained under taskScope; if the marker leaked into runOwnershipCheck, that commit
// would read as unexplained and the scoped teammate would be blocked by work it does not own —
// and the same leak is what would let a direct write hide behind whichever task ran first.
test('with taskScope set, runOwnershipCheck still sees every task in the run', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    isAncestor: async (a, b) => a === 'c1' && b === `refs/heads/${T2_BRANCH}-sha`,
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1',
    tasks: [T1_TASK, T2_PHASE1_TASK, T3_PHASE2_TASK], taskScope: 'T1',
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
  // Every task branch in the run was resolved, not just the scoped one — including a task from
  // another phase, since ownership is run-wide and not phase-wide either.
  for (const branch of [T1_BRANCH, T2_BRANCH, T3_BRANCH]) {
    assert.ok(git.resolveRefCalls.includes(`refs/heads/${branch}`), `${branch} must still be consulted`)
  }
})

// --- ctx.previewLink: declared preview.link entries reaching withMergePreview --------------
//
// previewLinks(config) (gate-config.mjs) has to actually reach withMergePreview for the
// feature to do anything. runChecks is the wiring point: it must pass ctx.previewLink through
// as `link`, and ctx.cwd through as `repoRoot`, on every call — real linking, driven through
// the real withMergePreview/linkInto, not a git double, since the double covers only the
// worktree operations withMergePreview needs, and linking is real filesystem work.

async function withLinkableRepoRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-gate-runner-link-'))
  try {
    const deps = path.join(root, 'deps')
    await mkdir(deps, { recursive: true })
    await writeFile(path.join(deps, 'marker.txt'), 'linked build input\n', 'utf8')
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('ctx.previewLink reaches withMergePreview and is linked into the preview tree', async () => {
  await withLinkableRepoRoot(async (root) => {
    const seen = []
    const ctx = previewCtx({
      cwd: root,
      previewLink: ['deps'],
      git: previewGit(),
      exec: async (cmd, cwd) => {
        seen.push(await readFile(path.join(cwd, 'deps', 'marker.txt'), 'utf8'))
        return { code: 0, output: '' }
      },
    })
    const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
    assert.deepEqual(results.map((r) => r.status), ['pass', 'pass'])
    assert.deepEqual(seen, ['linked build input\n'])
  })
})

test('a link failure records the merge check as fail with the link message and skips command checks', async () => {
  await withLinkableRepoRoot(async (root) => {
    const calls = []
    const ctx = previewCtx({
      cwd: root,
      // 'absent' does not exist under root: linkInto fails with an ENOENT-shaped message
      // before the callback (and so the command check) ever runs.
      previewLink: ['absent'],
      git: previewGit(),
      exec: recordingExec(calls),
    })
    const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
    assert.equal(results[0].name, 'merge')
    assert.equal(results[0].status, 'fail')
    assert.match(results[0].output, /preview link 'absent' failed/)
    assert.equal(results[1].status, 'skip')
    assert.equal(calls.length, 0, 'no command may run when linking failed')
    assert.equal(aggregateVerdict(results).verdict, 'FAIL')
  })
})

test('with ctx.previewLink absent, the preview receives no links and behaves exactly as before', async () => {
  const calls = []
  // cwd is not a real directory: with no link entries, repoRoot is passed through but never
  // consulted, so this must behave identically to every preview test above that predates
  // ctx.previewLink.
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec(calls) })
  assert.equal(ctx.previewLink, undefined)
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['merge', 'pass'], ['test', 'pass']])
  // The one property "identical to today" most needs: the command still runs inside the
  // preview worktree, not at ctx.cwd, exactly as it did before ctx.previewLink existed.
  assert.equal(calls.length, 1)
  assert.match(calls[0].cwd, /tm-preview-/)
})

test('a solo run builds no preview and consults no links even when ctx.previewLink is set', async () => {
  const calls = []
  const ctx = {
    cwd: '/project/root',
    exec: recordingExec(calls),
    solo: true,
    previewLink: ['deps'],
    git: previewGit(),
  }
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['test', 'pass']])
  assert.deepEqual(calls.map((c) => c.cwd), ['/project/root'])
})

// --- ownWorkBase: the run-tip position, closed by scarcity (real repo) -----------------------
//
// Was a LIMIT: the gate FAILed a genuinely, fully landed task because a ref at the run tip is not
// a key in `mergedParentFiles`'s index. `creditRunTipTasks` matches such a ref to a merged parent
// that carried its whole declared set and that no other task ref already points at. This is the
// exact construction the LIMIT used to pin, with the assertions inverted — the shape was not
// changed to make it pass.
test('ownWorkBase: a fix round re-pointing an already-integrated branch at the run tip reads as landed (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    // The brief's own recommended fix-round step: `git checkout -B fleetmates/r1/T1 run`. T1's
    // work is already, genuinely, on the run branch — this only moves where the CONVENTIONAL
    // REF points, at a commit that is already the run tip. Nothing else claims T1's merge, so
    // the parent is free and T1 matches it.
    await sh(['branch', '-f', 'fleetmates/r1/T1', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    assert.deepEqual(ctx.integratedPhases, [1])

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'pass')
  })
})

// The regression guard, and the reason `creditRunTipTasks` matches instead of testing
// containment. A closure that asked only "did some merged parent carry this task's whole declared
// set" (`f6e2191`, reverted by `227abf2`) passed this: T1's merge carried a SUPERSET of T2's
// declared set, which a phase-2 task that only MODIFIES a file phase 1 created has by
// construction. T1's own ref still points at that parent, so it is spent and T2 matches nothing.
// If this test ever goes green on a PASS, the enforcing check has been traded away again.
test('a run-tip ref is NOT credited with a merge another task ref still points at (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), overlappingTwoPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // T1 declares and lands BOTH files; T2 declares only `a.mjs` and never writes anything.
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    await sh(['branch', '-f', 'fleetmates/r1/T2', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    assert.equal(ctx.currentPhase, 2)
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes past its fork point/)
  })
})

// Scarcity is a cap, not a per-ref test: two refs both re-pointed to the run tip cannot both be
// credited with the one merge between them, so one is always left over and its phase does not
// read as integrated.
test('two refs at the run tip cannot both be credited with a single merged parent (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoPhaseBothFilesPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    await sh(['branch', '-f', 'fleetmates/r1/T1', 'run'])
    await sh(['branch', '-f', 'fleetmates/r1/T2', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
  })
})

// --- the spare parent, closed (real repo) ----------------------------------------------------
//
// Was a LIMIT. Two merges crediting the SAME task — an initial integration plus a fix round's own
// merge — put two parents in the index while only one ref points AT one of them, and the leftover
// was matchable by a run-tip ref whose declared set it contained in full. `spentParents` closes it
// by spending a parent that is an ANCESTOR of a task ref whose declared set the parent's carried
// files intersect, not only one a ref points directly at. Same construction the LIMIT pinned, with
// the assertion inverted.
test('the spare parent of a task merged twice is spent, not matchable by a run-tip ref (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), overlappingTwoPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // T1 lands `a.mjs`, then a fix round lands a second merge also touching `a.mjs`. Two parents
    // now carry T1's file; T1's ref can only point at one of them.
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])
    await sh(['checkout', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 2\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 fix round'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1 again', 'fleetmates/r1/T1'])

    // T2 declares `a.mjs`, writes nothing, parks at the run tip. Both parents carry `a.mjs` and
    // both are ancestors of T1's ref, so neither is free.
    await sh(['branch', '-f', 'fleetmates/r1/T2', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes past its fork point/)
  })
})

// The direction spending must NOT break, and the reason `spentParents` requires the carried files
// to intersect the ref's OWN declared set rather than spending on ancestry alone. A phase-2 task
// legitimately forks from the run tip after phase 1 was merged, so phase 1's merged parent is an
// ancestor of the phase-2 ref. On ancestry alone that parent reads as spent by a task that never
// earned it, and a fix round re-pointing phase 1's own ref at the run tip fails a genuinely landed
// task — the exact false FAIL this whole mechanism exists to remove. Measured, not reasoned about:
// deleting the intersection guard turns this test red.
test('a later sibling does not spend the merged parent of an earlier task it never earned (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoPhaseBothFilesPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    // T2 forks AFTER T1's merge, so T1's merged parent is an ancestor of T2's tip.
    await sh(['checkout', '-b', 'fleetmates/r1/T2', 'run'])
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T2', 'fleetmates/r1/T2'])

    // T1's fix round finds nothing to change and leaves its ref at the run tip.
    await sh(['branch', '-f', 'fleetmates/r1/T1', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'pass')
  })
})

test('creditRunTipTasks matches on containment, spends each parent once, and never credits an empty declared set', () => {
  const mergedFiles = new Map([
    ['P1', new Set(['a.mjs', 'b.mjs'])],
    ['P2', new Set(['c.mjs'])],
  ])
  const runSha = 'RUNTIP'

  // A parent no ref points at, containing the whole declared set: credited.
  assert.deepEqual(
    [...creditRunTipTasks({
      tasks: [{ id: 'T1', files: ['a.mjs'] }],
      shaByTask: new Map([['T1', runSha]]),
      runSha, mergedFiles,
    })],
    ['T1'],
  )

  // The same parent, but another task's ref points AT it: spent, so nothing is credited.
  assert.deepEqual(
    [...creditRunTipTasks({
      tasks: [{ id: 'T1', files: ['a.mjs', 'b.mjs'] }, { id: 'T2', files: ['a.mjs'] }],
      shaByTask: new Map([['T1', 'P1'], ['T2', runSha]]),
      runSha, mergedFiles,
    })],
    [],
  )

  // Two run-tip tasks, one eligible parent: exactly one is credited, never both.
  assert.equal(
    creditRunTipTasks({
      tasks: [{ id: 'T1', files: ['a.mjs'] }, { id: 'T2', files: ['b.mjs'] }],
      shaByTask: new Map([['T1', runSha], ['T2', runSha]]),
      runSha, mergedFiles,
    }).size,
    1,
  )

  // Augmenting, not greedy: T1 can only use P1, T2 can use either. T1 must not be starved by T2
  // taking P1 first.
  assert.equal(
    creditRunTipTasks({
      tasks: [{ id: 'T2', files: [] }, { id: 'T1', files: ['a.mjs'] }],
      shaByTask: new Map([['T1', runSha], ['T2', runSha]]),
      runSha, mergedFiles,
    }).has('T1'),
    true,
  )

  // Partial containment is not containment.
  assert.deepEqual(
    [...creditRunTipTasks({
      tasks: [{ id: 'T1', files: ['a.mjs', 'c.mjs'] }],
      shaByTask: new Map([['T1', runSha]]),
      runSha, mergedFiles,
    })],
    [],
  )

  // An empty declared set is contained in every parent and must still be credited by none.
  assert.deepEqual(
    [...creditRunTipTasks({
      tasks: [{ id: 'T1', files: [] }],
      shaByTask: new Map([['T1', runSha]]),
      runSha, mergedFiles,
    })],
    [],
  )
})

// A mode-only change carries no bytes, so a byte-only comparison sees "no parent touched this
// file" for a file `git diff --name-only` did list — and mergeContentExplainedByParents then
// condemns the whole merge as having content with no legitimate source. That is a false FAIL:
// the chmod is the honest contribution of the very parent being consulted. Found in run `fog`,
// where a hooks fix whose entire payload was `100644 -> 100755` on one file made a correctly
// re-parented base merge unexplainable, with no route around it.
test('a base merge whose only contribution is a mode change is explained, not flagged (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'hook.sh'), '#!/bin/sh\necho hi\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // One honest task branch, merged --no-ff, so the run branch is a normal mid-run branch.
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'work\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    // The base advances by a commit whose ENTIRE payload is the executable bit: same blob
    // before and after. This is the documented, legitimate route for a mid-run amendment.
    //
    // `update-index --chmod` writes the bit into the INDEX directly, which is the only way to
    // stage a mode change on Windows, where the filesystem has no exec bit for `chmod` to set
    // and a chmod-then-add commits nothing at all. `core.fileMode false` then keeps the two
    // platforms in agreement: where git DOES honour filemode, the working tree would otherwise
    // read as dirty against the new index and the ownership check would fail on that instead of
    // on the thing under test. Same technique, and same reason, as the mode-only case in
    // tests/adversarial.test.mjs.
    await sh(['config', 'core.fileMode', 'false'])
    await sh(['checkout', 'main'])
    await sh(['update-index', '--chmod=+x', 'hook.sh'])
    await sh(['commit', '-m', 'chmod +x hook.sh'])
    const before = await sh(['rev-parse', 'HEAD~1:hook.sh'])
    const after = await sh(['rev-parse', 'HEAD:hook.sh'])
    assert.equal(after.stdout.trim(), before.stdout.trim(), 'setup: the blob must be identical, so this is mode-only')

    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge base', 'main'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'pass', res.output)
  })
})

// POSIX process groups and signal dispositions. The win32 half of `killGroup` is `taskkill`,
// which these cannot drive.
const POSIX_ONLY = process.platform === 'win32' && 'POSIX process groups and signal dispositions'

// A pid the OS still knows about. A signal-0 probe answers YES for a zombie too — the window
// between a kill landing and node reaping the child — so every caller polls rather than
// sampling once.
const alivePid = (pid) => { try { process.kill(Number(pid), 0); return true } catch { return false } }

// Polls for at most `ms`, so a process that never dies costs a bounded wait rather than a hung
// suite. Answers whether the pid is gone, not whether it died for the reason the caller wanted.
const waitForExit = async (pid, ms = 3_000) => {
  const until = Date.now() + ms
  while (Date.now() < until && alivePid(pid)) await new Promise((r) => setTimeout(r, 25))
  return !alivePid(pid)
}

const killPid = (pid) => { try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone, which is the pass case */ } }

// Armed timers, from node's own resource table. Read ONLY as a delta around a single call: the
// test runner and everything else in this process arm timers of their own, so the absolute
// count carries no meaning and a delta of zero is all this can assert.
const armedTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

// OUR end of a child's stdio, from the same table and read the same way: as a delta around one
// call and never as an absolute. A pipe still open after the verdict is a gate that has reported
// and cannot exit, which is the leaked-timer defect in another resource.
const pipeWraps = () => process.getActiveResourcesInfo().filter((r) => r === 'PipeWrap').length

// The GROUP, probed exactly the way the module probes it: a liveness test on the pgid. That is
// what makes "the group has emptied" an OBSERVED EVENT here rather than an elapsed interval —
// and its limit is the module's own, that a pgid the OS has already handed back out answers
// this "alive" and nothing in a process can tell the difference.
const groupEmpty = (pid) => { try { process.kill(-Number(pid), 0); return false } catch (err) { return err.code === 'ESRCH' } }

// Polls until a predicate holds and answers the timestamp it first held at, or null if it never
// did inside `ms`. Every ordering claim below is built out of these instead of a fixed sleep,
// because a fixed window races a process startup and loses under load: the same group leader
// that clears a 200ms window in 35ms unloaded took 659ms at eight times oversubscription, and
// the test then failed with the very message the genuine defect produces.
const waitUntil = async (predicate, ms = 5_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return Date.now()
    await new Promise((r) => setTimeout(r, 10))
  }
  return predicate() ? Date.now() : null
}
const waitForGroupEmpty = (pid, ms) => waitUntil(() => groupEmpty(pid), ms)
const waitForRegistration = (pid, ms) => waitUntil(() => liveGroupPids().includes(pid), ms)
const waitForRetirement = (pid, ms) => waitUntil(() => !liveGroupPids().includes(pid), ms)

// A group member whose LIFETIME THE TEST CONTROLS. It polls for a file and exits when it
// appears, so "a member is still running" and "the member has gone" are both things the test
// causes and can then observe, never intervals it hopes will line up. Its stdio is redirected on
// purpose: what it must hold open is the process GROUP, never our end of the pipes, or `close`
// would wait on it and the test would be measuring the pipe rather than the group.
// One POSIX shell word, whatever the string holds. Single quotes suspend every expansion the
// shell does, and the only character they cannot carry is `'` itself, which is closed, escaped
// and reopened. Use it for ANY value that reaches a `shell: true` command from outside this file
// — `defaultExec` spawns with `shell: true`, so an unquoted interpolation is the shell's input,
// not an argument.
const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`

// The escaped-grandchild command, shared by the three tests that need one: exec into a node that
// spawns a DETACHED grandchild holding the pipes, records its pid, and exits. `escFile` is under
// `tmpdir()`, so it is TMPDIR-derived and carries whatever characters the environment put there.
const escapeeExec = (escFile) => `exec ${process.execPath} -e ${shq(
  "const{spawn}=require('node:child_process');const fs=require('node:fs');"
  + "const c=spawn('sh',['-c','sleep 10'],{detached:true,stdio:'inherit'});c.unref();"
  + `fs.writeFileSync(${JSON.stringify(escFile)},String(c.pid));console.log('ESCAPED='+c.pid)`,
)}`

// TMPDIR is the environment's, not this suite's, and every temp path below is derived from it. A
// command built by interpolation therefore carries whatever characters the environment put in that
// name across two levels at once: `escapeeExec` writes the path into a SINGLE-QUOTED JS string
// literal, which is itself inside a DOUBLE-QUOTED shell word. A `'` closes the first and `$(…)` is
// expanded inside the second, so one hostile directory name reaches both. Measured before the fix:
// a whole-file run under such a TMPDIR executed the injected command 17 times and turned 13 tests
// red.
//
// Both halves of this assertion carry weight. The marker proves nothing was executed; reading the
// pid back out of the hostile path proves the command still WORKS there, so quoting that merely
// broke the command could not pass this.
test('a temp path carrying shell metacharacters cannot inject a command through the held member', { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
  // Same class as the test below it, second shape: `heldMember` puts the path inside a
  // double-quoted word that is itself inside the single-quoted argument of `sh -c`, so a `'` in
  // the name closes the `sh -c` script and `$(…)` expands inside the double quotes.
  //
  // Releasing the member at the end is the half that proves the quoting did not merely break the
  // command: it exits only if it was really polling the hostile path.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-inject-held-'))
  const marker = path.join(dir, 'INJECTED')
  const goFile = path.join(dir, "h'$(touch INJECTED)'go")
  let spawned = null
  try {
    const { code, output } = await defaultExec(`${heldMember(goFile)} echo started`, dir, {
      timeoutMs: 10_000,
      onSpawn: (pid) => { spawned = pid },
    })
    assert.equal(code, 0, output)
    assert.equal(
      existsSync(marker),
      false,
      'the command substitution in the temp path was executed by the shell, so a directory name chose what this suite runs',
    )
    assert.match(output, /started/)
    assert.equal(groupEmpty(spawned), false, 'the member is not waiting at all, so the quoting broke the command instead of neutralising it')
    await releaseMember(goFile)
    assert.notEqual(
      await waitForGroupEmpty(spawned, 5_000),
      null,
      'the member never exited after its file appeared, so it was polling some path other than the one it was given',
    )
  } finally {
    await releaseMember(goFile).catch(() => {})
    if (spawned) { try { process.kill(-spawned, 'SIGKILL') } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true })
  }
})

test('a temp path carrying shell metacharacters cannot inject a command through the recorded pid', { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
  // Third shape: a single-quoted redirection target, where a `'` in the name closes the quote and
  // everything after it is read as shell source. Reading the pid back out of the hostile path is
  // what proves the redirection still lands where it was told to.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-inject-pid-'))
  const marker = path.join(dir, 'INJECTED')
  const pidFile = path.join(dir, "h'$(touch INJECTED)'pid")
  let kid = null
  try {
    const { code, output } = await defaultExec(`sleep 5 >/dev/null 2>&1 & ${recordPid(pidFile)}`, dir, { timeoutMs: 10_000 })
    assert.equal(code, 0, output)
    assert.equal(
      existsSync(marker),
      false,
      'the command substitution in the temp path was executed by the shell, so a directory name chose what this suite runs',
    )
    assert.equal(existsSync(pidFile), true, 'the redirection did not reach the hostile path, so the quoting broke the command instead of neutralising it')
    kid = (await readFile(pidFile, 'utf8')).trim()
    assert.match(kid, /^\d+$/, `the command did not record its child pid: ${JSON.stringify(kid)}`)
  } finally {
    if (kid) killPid(kid)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a temp path carrying shell metacharacters cannot inject a command', { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-inject-'))
  const marker = path.join(dir, 'INJECTED')
  // The injected command is RELATIVE and the command runs with `dir` as its cwd, so the marker
  // needs no `/` — a directory name cannot contain one, and an absolute marker would have made
  // this an unmakeable path rather than a hostile one.
  const hostile = path.join(dir, "h'$(touch INJECTED)'x")
  await mkdir(hostile)
  const escFile = path.join(hostile, 'escapee.pid')
  let kid = null
  let p = null
  try {
    p = defaultExec(escapeeExec(escFile), dir, { timeoutMs: 8_000, graceMs: 100 })
    const until = Date.now() + 6_000
    while (Date.now() < until && !existsSync(escFile)) await new Promise((r) => setTimeout(r, 25))
    assert.equal(
      existsSync(marker),
      false,
      'the command substitution in the temp path was executed by the shell, so a directory name chose what this suite runs',
    )
    assert.equal(existsSync(escFile), true, 'the escapee never wrote its pid to the hostile path, so the quoting broke the command instead of neutralising it')
    kid = (await readFile(escFile, 'utf8')).trim()
    assert.match(kid, /^\d+$/, `the escapee did not record its grandchild: ${JSON.stringify(kid)}`)
  } finally {
    if (kid) killPid(kid)
    if (p) await p.catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

// The pid of the job just backgrounded, recorded where the test can read it. `pidFile` is under
// `tmpdir()`, so it is TMPDIR-derived like every other path here.
const recordPid = (pidFile) => `echo $! > ${shq(pidFile)}`

const heldMember = (goFile) => `sh -c ${shq(`while [ ! -f ${shq(goFile)} ]; do sleep 0.02; done`)} >/dev/null 2>&1 &`
const releaseMember = (goFile) => writeFile(goFile, 'go')

// Retirement is generous by TEN reap intervals here — 2_500 against a REAP_INTERVAL_MS of 250,
// and the earlier wording said "two", which is the same defect class as an overstated claim in
// the module. Deliberately loose all the same: what is being pinned is that the window is
// BOUNDED BY A PROBE INTERVAL rather than by the timeout, and the difference between those two
// is a quarter of a second against fifteen minutes. A tighter bound would only buy flake.
//
// The cost of that looseness, stated rather than left to be discovered: it means these tests
// cannot notice REAP_INTERVAL_MS being raised as far as 2_000, and they cannot tell retirement
// at the child's `exit` apart from retirement at the next reap. Both of those are held by the
// change-detector on the constant below and by nothing behavioural.
const REAP_BOUND_MS = 2_500

test('KILL_GRACE_MS is five seconds, an upper bound nothing in this file can reach behaviourally', () => {
  // THE UPPER SIDE OF THE GRACE, and it is a change-detector on purpose. The LOWER side is
  // behavioural — the SIGTERM trap below does 300ms of real work and a zero grace loses its
  // `echo` — but the upper side is not reachable at all: raising this to 60_000 leaves every
  // test in this file green, because the only run whose signal the constant's own value can
  // delay is one whose trap exits INSIDE the window, and `cleanup` then clears the timer the
  // moment the group is observed empty. What the number actually buys is how long a
  // SIGTERM-ignoring member gets to outlive the verdict, and that is a policy, not a behaviour.
  // Pinning it makes the edit deliberate; it does not say five seconds suits your suite.
  assert.equal(KILL_GRACE_MS, 5_000)
})

test('REAP_INTERVAL_MS is 250ms, which is the whole width of the window rule 2 leaves open', () => {
  // Same shape and the same honesty. The retirement tests above allow REAP_BOUND_MS — ten of
  // these — precisely so that they do not flake, which means raising this to 2_000 leaves them
  // green while quadrupling the interval during which a retired-but-unnoticed pgid can be handed
  // to a stranger. Nothing behavioural in this file separates 250 from 2_000, so this is what
  // separates them.
  assert.equal(REAP_INTERVAL_MS, 250)
})

test('a timed-out command check kills the whole process group, not just the shell', { skip: POSIX_ONLY }, async () => {
  // The grandchild's stdio is redirected on purpose. Inheriting the pipe makes `close` wait on
  // the grandchild no matter who was killed, so the promise would not settle until `sleep`
  // ended of its own accord — and a test that waits out the sleep passes even when the kill
  // reached only the shell, which is the one thing it exists to catch.
  const { code, output } = await defaultExec('sleep 30 >/dev/null 2>&1 & echo GRANDCHILD=$!; wait', process.cwd(), { timeoutMs: 300 })
  const pid = /GRANDCHILD=(\d+)/.exec(output)?.[1]
  assert.ok(pid, `the command did not report its grandchild pid: ${JSON.stringify(output)}`)
  try {
    assert.equal(await waitForExit(pid, 6_000), true, 'the grandchild outlived the timeout, so only the shell was killed')
    assert.notEqual(code, 0)
    assert.match(output, /timed out after 300ms; its process group was killed/)
  } finally {
    // A failing run has left a live `sleep` behind; it is this test's to clean up.
    killPid(pid)
  }
})

test('the notice boundary at exactly 1000ms reports whole seconds, not milliseconds', { skip: POSIX_ONLY }, async () => {
  // Mutation this pins: `timeoutMs >= 1000` -> `timeoutMs > 1000` in `resolveTimedOut`. Nothing
  // else in this file touches the boundary itself — every sub-second notice test (300/400/600/
  // 700/900ms above and below) sits strictly under it, every whole-second one (2500/3000ms
  // below) sits strictly over it, and the `timeoutMs: 1000` at the top of this file never
  // reaches a real timeout at all, only `timeoutFault`/`exec`. 1000 is the most natural round
  // manifest value there is, so its own notice text has to be pinned directly.
  const { code, output } = await defaultExec('sleep 5', process.cwd(), { timeoutMs: 1000 })
  assert.notEqual(code, 0)
  assert.match(output, /timed out after 1s; its process group was killed/)
})

test('a timed-out command check is a fail carrying its reason, never a pass', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // THE SUITE THE GRACE WINDOW EXISTS FOR: it traps SIGTERM, writes its coverage note and exits
  // 0, all inside the grace. `code ?? 1` passes that 0 straight through, `runCommandCheck` then
  // reads `code === 0` as a pass and BLANKS the output on the pass branch — so the operator sees
  // a green check with no output at all for a suite that never finished.
  //
  // The real `defaultExec` runs here, and that is the point of the test: the version this
  // replaced stubbed `exec` with a hardcoded `{code: 1}` and so never reached the close handler
  // where the defect lived. `exec` is wrapped only to shorten the 15-minute default.
  //
  // It is also the one run in this file that ARMS THE GRACE and then settles without it firing —
  // the trap exits 0 inside the window, so the group is empty when `cleanup` probes it — and the
  // delta below is what pins the `clearTimeout(grace)` on that branch. `graceMs` is left at its
  // default here, because a shortened one would hide most of the lingering.
  //
  // WHAT DELETING THAT `clearTimeout` ACTUALLY COSTS, because this comment used to name the
  // wrong consequence and the wrong consequence is the more alarming one. It does NOT deliver a
  // SIGKILL to a freed pid: this branch retires the pid on its way past, and `killGroup` returns
  // on `liveGroups.has(pid)` before it probes anything, so the signal is withheld — traced on
  // the mutant, the grace fires and sends nothing. The cost is the timer itself. It stays armed
  // and REF'D for the full five-second default (the `grace?.unref()` is on the other branch
  // only), so a gate that has already reported its verdict holds node open for five seconds per
  // timed-out check. That is rule 3, not rule 2.
  //
  // Read the corrected version before touching `liveGroups.has(pid)`: that guard is not made
  // redundant by anything here. It is the one thing standing between a retired pgid and every
  // signal this module can still send at it.
  //
  // THE TRAP DOES REAL WORK — `sleep 0.3` before the echo — and that is what pins KILL_GRACE_MS's
  // VALUE rather than merely its existence. With an instant trap, setting the constant to 0 left
  // all 142 tests green three runs running, because the handler finished inside the single tick a
  // zero grace leaves. Three hundred milliseconds of it does not: a zero grace SIGKILLs the shell
  // mid-`sleep` and "coverage written" never reaches the output.
  const before = armedTimers()
  const result = await runCommandCheck(
    { name: 'slow', kind: 'command', run: "trap 'sleep 0.3; echo coverage written; exit 0' TERM; sleep 20 & wait" },
    { cwd: process.cwd(), exec: (cmd, cwd) => defaultExec(cmd, cwd, { timeoutMs: 300 }) },
  )
  assert.equal(armedTimers(), before, 'the grace timer stayed armed and ref\'d past the verdict, so a gate that has reported holds node open for the full five-second grace — the SIGKILL itself is withheld by the registration guard, the delay is not')
  assert.equal(result.status, 'fail', `a suite killed by the timeout must not read as a pass: ${JSON.stringify(result)}`)
  assert.notEqual(result.exitCode, 0)
  assert.match(result.output, /coverage written/)
  assert.match(result.output, /timed out after 300ms; its process group was killed/)
})

test('a check that ignores SIGTERM is SIGKILLed when the grace expires', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // The other half of the KILL_GRACE_MS claim — "one that ignores it does not get to outlive the
  // gate" — which nothing pinned: the group-kill test above uses `sleep`, and `sleep` dies on
  // SIGTERM, so replacing the grace SIGKILL with a comment left the whole suite green.
  //
  // `trap '' TERM` sets SIG_IGN, and an ignored disposition is inherited across exec, so the
  // background `sleep` ignores SIGTERM too. Only the grace SIGKILL can end either of them.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-grace-'))
  let kid = null
  try {
    const pidFile = path.join(dir, 'kid.pid')
    const { code, output } = await defaultExec(
      `trap '' TERM; sleep 20 & ${recordPid(pidFile)}; wait`,
      process.cwd(),
      // `graceMs` is shortened from its 5-second default for the wall clock only; the path it
      // drives is the production one.
      { timeoutMs: 400, graceMs: 400 },
    )
    kid = (await readFile(pidFile, 'utf8')).trim()
    assert.match(kid, /^\d+$/, `the command did not report its child pid: ${JSON.stringify(kid)}`)
    assert.equal(await waitForExit(kid, 5_000), true, 'a SIGTERM-ignoring child outlived the gate, so the grace SIGKILL never landed')
    assert.notEqual(code, 0)
    assert.match(output, /timed out after 400ms; its process group was killed/)
  } finally {
    if (kid) killPid(kid)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a timed-out check settles on the kill, not on pipes a grandchild escaped the group still holds', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // `close` waits for the stdio PIPES, not for the direct child. A grandchild that leaves the
  // process group while inheriting them — `setsid`, or `spawn(..., { detached: true, stdio:
  // 'inherit' })` — survives every signal the timeout can deliver and holds those pipes open, so
  // settling only on `close` leaves the 15-minute bound bypassable by an ordinary manifest `run`
  // string, and the gate records no verdict at all.
  // ONE node startup, not two, and a timeout with room around it. The escapee has to be up
  // before the SIGTERM or the test measures nothing, and that is a race against process startup:
  // measured, the two-node version cleared a 300ms window in 35ms unloaded and took 659ms at
  // eight times oversubscription. Spawning a detached `sh` instead of a second node halves the
  // startup, and 900ms against it is headroom at any load this file has been verified at — 8x
  // oversubscription, and one core with 16 competing loops. It is NOT unconditional headroom,
  // and the earlier wording implied it was: at 48 busy loops pinned to one core the escapee's
  // startup does not fit and this fails on the setup assertion below. That is the accepted
  // failure mode, not a hidden one — the assertion is ordered first and its message is nothing
  // like the one the real defect gives, so a blown setup is diagnosable at a glance.
  const escapee = "const{spawn}=require('node:child_process');const c=spawn('sh',['-c','sleep 8'],{detached:true,stdio:'inherit'});c.unref();console.log('ESCAPED='+c.pid)"
  const started = Date.now()
  const openPipes = pipeWraps()
  const { code, output } = await defaultExec(
    `${process.execPath} -e "${escapee}"; sleep 8`,
    process.cwd(),
    { timeoutMs: 900, graceMs: 200 },
  )
  const elapsed = Date.now() - started
  // Sampled a tick AFTER the verdict, because `destroy()` releases the handle asynchronously:
  // read immediately, both pipes still show as open in a build that does drop them. The settle
  // is what the elapsed assertion above covers; this covers the other half of the same claim,
  // that a settled gate can then exit — measured, dropping `dropPipes()` leaves both PipeWraps
  // active for as long as the escaped grandchild lives.
  await new Promise((r) => setTimeout(r, 100))
  const leakedPipes = pipeWraps() - openPipes
  const pid = /ESCAPED=(\d+)/.exec(output)?.[1]
  try {
    assert.ok(pid, `setup: the command did not report its escaped grandchild, so its node startup did not fit inside the 900ms timeout and there was never a process holding the pipes to measure: ${JSON.stringify(output)}`)
    assert.equal(leakedPipes, 0, 'our end of the pipes stayed open on a grandchild that outran the kill, so the gate reports its verdict and then cannot exit')
    assert.ok(alivePid(pid), 'setup: the grandchild must still hold the pipes when the promise settles')
    // Bounded by timeoutMs + graceMs, generously: the escapee holds the pipes for 8s, so
    // anything near that is a settle that waited on `close`.
    assert.ok(elapsed < 4_000, `settled after ${elapsed}ms, so it waited on pipes the kill cannot close`)
    assert.notEqual(code, 0)
    // The output collected before the kill still reaches the caller.
    assert.match(output, /ESCAPED=\d+/)
    assert.match(output, /timed out after 900ms; its process group was killed/)
  } finally {
    if (pid) killPid(pid)
  }
})

// THE TWO TESTS BELOW PIN DEFAULTEXEC'S OWN NO-OPTIONS DEFAULT, not production's call site.
// `runCommandCheck` no longer calls `exec(check.run, cwd)` with no options object — since the
// per-check `timeoutMs` bound was added it always passes one:
// `exec(check.run, cwd, { timeoutMs: check.timeoutMs ?? COMMAND_TIMEOUT_MS })`, so a manifest
// entry can lower its own timeout. What now pins the default production actually APPLIES,
// through that options object, is `'a command check with no timeoutMs gets the default'` above:
// it drives `runCommandCheck` itself and asserts the options its stub `exec` receives carry
// `COMMAND_TIMEOUT_MS`.
//
// The two tests below still earn their keep: they pin `defaultExec`'s OWN behaviour when handed
// no options at all, which stays a real code path — every direct `defaultExec(...)` call in this
// file that omits the third argument exercises it, and so would a programmatic caller of
// `defaultExec` that is not `runCommandCheck`. Until this round a third test in this group ran
// `defaultExec('sleep 1')` and asserted it was not killed. That one is gone, for two reasons and
// not for its second of wall clock alone.
//
// IT WAS THE ONLY TEST IN THIS FILE THAT RAN A POSIX COMMAND UNGUARDED. `.github/workflows/
// test.yml` runs the matrix [ubuntu-latest, windows-latest, macos-latest], and `sleep` is not a
// cmd.exe builtin — on win32 `spawn('sleep 1', { shell: true })` resolves it off PATH and fails
// outright unless the runner image happens to carry Git's usr/bin.
//
// THE RULE, WHICH IS WHAT A NEW TEST SHOULD BE CHECKED AGAINST — stated as an invariant and not
// as a count, because the count was wrong within one commit of being written and the next reader
// consults this sentence when deciding whether their test needs the guard:
//
//   a test that runs a POSIX-only construct — `sleep`, `trap`, a process group, a signal
//   disposition — carries `skip: POSIX_ONLY`, and so does any helper only such tests call.
//
// `heldMember`, `driverSource` and `reaperDriverSource` are those helpers; they contain `sleep`
// and are invoked from guarded tests only. Do not count `skip: POSIX_ONLY` occurrences and
// expect the number of guarded TESTS: the declaration at the signal loop below sits inside a
// four-element `for`, so one occurrence there registers four tests. That is also why this file
// reports four more tests than it has `test(` lines.
//
// AND IT WAS SUBSUMED. The spy test below makes the same no-options call and asserts the delay
// the timeout was ARMED WITH, so it catches everything the sleep caught (`timeoutMs = 30`)
// plus two things it could not: the timer being deleted outright, and the applied default
// diverging from the constant. Measured, 3.8ms against 1004.9ms.

test('COMMAND_TIMEOUT_MS is fifteen minutes, which is a policy no behavioural test can reach', () => {
  // The test above proves the default is APPLIED. It cannot prove the default is RIGHT: cutting
  // the constant to 60s leaves every test in this file green, because none of them runs for a
  // minute, while a project suite on a cold cache starts failing its gate. Pinning the number is
  // a change-detector and is meant to be — it makes that edit deliberate instead of silent.
  // What it does NOT do, stated so nobody reads more into it: say the number suits your suite.
  assert.equal(COMMAND_TIMEOUT_MS, 15 * 60_000)
})

test('the default a no-options call applies IS COMMAND_TIMEOUT_MS, not merely some default over a second', async () => {
  // THE GAP BETWEEN THE TWO TESTS ABOVE, which neither of them closes. The `sleep 1` test pins
  // that SOME default over one second is applied. The change-detector pins that the CONSTANT is
  // fifteen minutes. Rewriting the default binding to `timeoutMs = 60_000` while leaving
  // `COMMAND_TIMEOUT_MS = 15 * 60_000` untouched satisfies both and leaves the suite green — and
  // every real gate would then bound its checks at sixty seconds, so a project suite taking 90s
  // on a cold cache reports a FAIL it did not earn. What is missing is the IDENTITY of the two,
  // and this is the only test that asserts it.
  //
  // Observed rather than waited out: the module arms its timeout with the global `setTimeout`,
  // and the executor of `defaultExec`'s promise runs SYNCHRONOUSLY, so replacing the global for
  // exactly the duration of the call captures the delay it asked for. Nothing else in the
  // process can interleave inside a synchronous call, and it is restored in a `finally` before
  // anything is awaited, so the swap cannot outlive the statement. The alternative — letting the
  // real default fire — is fifteen minutes of wall clock.
  const realSetTimeout = globalThis.setTimeout
  const delays = []
  let pending
  try {
    globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest) }
    // NO OPTIONS OBJECT AT ALL — this pins `defaultExec`'s OWN default for that shape, which is
    // still a real call site (every direct `defaultExec(...)` call in this file that omits a
    // third argument takes it). It is no longer how `runCommandCheck` calls `exec`: since the
    // per-check `timeoutMs` bound was added, production always passes
    // `{ timeoutMs: check.timeoutMs ?? COMMAND_TIMEOUT_MS }`, pinned separately by
    // `'a command check with no timeoutMs gets the default'`. Passing anything here would pin
    // the argument rather than this function's own default.
    pending = defaultExec('exit 0', process.cwd())
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  const { code } = await pending
  assert.equal(code, 0)
  assert.equal(delays.length, 1, `expected the one timeout timer and nothing else armed synchronously, got ${JSON.stringify(delays)}`)
  assert.equal(delays[0], COMMAND_TIMEOUT_MS, `a no-options call armed its timeout at ${delays[0]}ms while COMMAND_TIMEOUT_MS is ${COMMAND_TIMEOUT_MS}ms — every real gate runs on this default, so the number the module documents is not the number it enforces`)
})

test('a probe that answers EPERM keeps the pid registered, because that signal could not have landed either', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // EPERM says the group EXISTS and is not ours to signal. Retiring on it would drop a running
  // group from the sweep on the strength of an error that says the opposite — and inverting the
  // guard so that ANY probe error retires the pid left the whole suite green.
  //
  // Unreachable from a real group: an unprivileged process cannot arrange one it may not signal.
  // So the PROBE is stubbed and only the probe — every signal that is not a probe still reaches
  // the real `process.kill`, and the stub is confined to this one pid. The claim is rated low
  // honestly: the signal would fail with EPERM anyway and nothing leaks. It is pinned because an
  // unpinned clause is a claim nothing checks.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-eperm-'))
  const goFile = path.join(dir, 'go')
  const realKill = process.kill.bind(process)
  let spawned = null
  // COUNTED, NOT WAITED OUT. The previous version slept a flat 700ms and hoped that was "several
  // probes"; on a loaded host it can be fewer than one, which makes the assertion below vacuous
  // in exactly the conditions a reaper bug would show up in, and on an idle one it is 450ms of
  // wall clock spent after the answer was already in. The stub knows when it has answered, so
  // the test waits for the EVENT — two EPERM answers, which is two reaper ticks — and stops.
  let epermAnswers = 0
  try {
    await defaultExec(`${heldMember(goFile)} echo started`, process.cwd(), {
      timeoutMs: 20_000,
      onSpawn: (pid) => { spawned = pid },
    })
    assert.ok(liveGroupPids().includes(spawned), 'setup: a running group must be registered before this can ask what happens when its probe fails')
    process.kill = (target, sig) => {
      if ((sig === 0 || sig === '0') && target === -spawned) {
        epermAnswers += 1
        const err = new Error('operation not permitted')
        err.code = 'EPERM'
        throw err
      }
      return realKill(target, sig)
    }
    assert.notEqual(await waitUntil(() => epermAnswers >= 2, 5_000), null, `setup: the probe was only asked ${epermAnswers} time(s), so nothing here has been given a chance to retire the pid`)
    assert.ok(liveGroupPids().includes(spawned), 'a probe that could not tell whether the group is ours retired the pid anyway, dropping a live group from the sweep')
  } finally {
    process.kill = realKill
    await releaseMember(goFile)
    if (spawned) { try { process.kill(-spawned, 'SIGKILL') } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true })
  }
})

test('defaultExec hands the spawned pid to onSpawn before the promise resolves', async () => {
  const seen = []
  const { code } = await defaultExec('exit 0', process.cwd(), { onSpawn: (pid) => seen.push(pid) })
  assert.equal(code, 0)
  assert.equal(seen.length, 1)
  assert.ok(Number.isInteger(seen[0]) && seen[0] > 0, `expected a pid, got ${seen[0]}`)
})

test('a throw from onSpawn rejects with nothing left running, armed or registered', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // The throwing `onSpawn` is a real path, not a hypothetical: it is the claim-file write, and a
  // claim can fail with EACCES or ENOSPC. Thrown BEFORE the listeners were attached, it left
  // `done()` unreachable — both timers armed, the pid still in `liveGroups`, the pipes never
  // drained and the child never killed. Measured on the pre-fix module: the promise rejected at
  // 9ms and the process stayed alive until 8016ms, and with the 15-minute default that is a gate
  // that reports its failure and then does not exit for fifteen minutes — after which its exit
  // sweep SIGKILLs a group that died long ago, which on a busy host is a recycled pid.
  let spawned = null
  const before = armedTimers()
  await assert.rejects(
    defaultExec('sleep 20 & wait', process.cwd(), {
      timeoutMs: 60_000,
      onSpawn: (pid) => { spawned = pid; throw new Error('claim write failed') },
    }),
    /claim write failed/,
  )
  try {
    assert.ok(Number.isInteger(spawned), `expected a pid, got ${spawned}`)
    assert.equal(armedTimers(), before, 'a timer stayed armed, so the gate keeps node alive after it has reported')
    assert.equal(await waitForExit(spawned, 5_000), true, 'the group outlived the rejection')
    // RETIRED WHEN THE GROUP IS OBSERVED GONE, not at the rejection — the pid is still on the
    // sweep list for the moment between the SIGKILL being sent and the group actually emptying,
    // and it has to be, because that is the moment the sweep would need it. What this pins is
    // that it does not stay there: the group ends and the pid comes off within a probe interval.
    assert.notEqual(await waitForRetirement(spawned, REAP_BOUND_MS + 2_000), null, 'the pid stayed in liveGroups after its group died, so the exit sweep will signal a pid the OS may have recycled')
  } finally {
    if (spawned) killPid(spawned)
  }
})

test('liveGroupPids reports a running group and drops it once the command ends', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  let duringRun = null
  let seen = null
  const { code } = await defaultExec('exit 0', process.cwd(), {
    onSpawn: (pid) => { seen = pid; duringRun = liveGroupPids() },
  })
  assert.equal(code, 0)
  assert.ok(duringRun.includes(seen), 'a live group must be registered before anything can observe the process it names')
  assert.ok(!liveGroupPids().includes(seen), 'a finished group must be deregistered, or the exit sweep signals a recycled pid')
})

// ── WHAT SETTLING IS ALLOWED TO MEAN ─────────────────────────────────────────────────────────
// Three tests on one decision, because three defects were three readings of it: `defaultExec`'s
// promise SETTLING and the check's process group BEING OVER are different events, and `cleanup`
// used to treat them as the same one. See the block above `killGroup` in the module.

test('a member that survives the SIGTERM is still SIGKILLed at the grace, though the shell dying settled the check', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // THE POPULATION KILL_GRACE_MS EXISTS FOR — a member that survives SIGTERM — and the case
  // `cleanup` used to void for exactly that population. `/bin/sh` takes SIGTERM's DEFAULT
  // disposition, so the top-level shell dies at once and takes our end of the pipes with it;
  // a member that ignores SIGTERM and had its stdio redirected keeps running while `close`
  // fires milliseconds later. The verdict that settled on it then ran a `cleanup` that
  // `clearTimeout(grace)`'d the escalation away AND dropped the pid from the sweep set, so no
  // later path reached the survivor either. Measured on that shape at {timeoutMs: 400,
  // graceMs: 1000}: settled at 411ms, `liveGroupPids()` empty, and 2.5s later `ps -o pid,pgid`
  // still showed the survivor at PGID == the child's pid — inside the very group killGroup aims
  // at, and `kill -KILL -<pgid>` by hand, the identical call the grace would have made, emptied
  // it. If nothing ever survived SIGTERM the grace SIGKILL would have no purpose at all.
  let spawned = null
  const before = armedTimers()
  // `trap '' TERM` sets SIG_IGN, which is inherited across the exec into `sleep`. The
  // redirection is what lets `close` fire while the survivor is still running; the trailing
  // `sleep` is what keeps the leader alive until the timeout rather than before it.
  const run = `sh -c 'trap "" TERM; sleep 30' >/dev/null 2>&1 & echo SURVIVOR=$!; sleep 30`
  const { code, output } = await defaultExec(run, process.cwd(), { timeoutMs: 400, graceMs: 300, onSpawn: (pid) => { spawned = pid } })
  const survivor = /SURVIVOR=(\d+)/.exec(output)?.[1]
  try {
    assert.ok(survivor, `setup: the command did not report its survivor: ${JSON.stringify(output)}`)
    // Both read at the settle, and neither is a race: the survivor ignores SIGTERM and sleeps
    // for 30 seconds, so it is certainly alive here, and a group with a member in it is
    // certainly non-empty. This is the conflation stated as an assertion — the verdict is
    // written while the group it says was killed is still running.
    assert.ok(alivePid(survivor), 'setup: the survivor must still be running when the promise settles, or this test measures nothing')
    assert.ok(liveGroupPids().includes(spawned), 'the pid was retired on the strength of the promise settling, while its group still had a member — so nothing reaches that member ever again')
    // AND THE GATE STILL DOES NOT WAIT FOR IT. The grace survives the verdict UNREF'D, so it
    // fires if node is alive anyway and costs nothing if node wants to exit — where the exit
    // sweep sends the same SIGKILL. Left ref'd, every check with a surviving member would hold
    // the gate open for the full five-second default after it had already reported.
    assert.equal(armedTimers(), before, 'the surviving grace was left holding the event loop open, so a check that has reported its verdict still delays the gate')
    assert.notEqual(code, 0)
    assert.match(output, /timed out after 400ms; its process group was killed/)
    // The note above is the spec's wording (docs/specs/2026-08-26-purge-and-teardown-design.md)
    // and this is what has to make it true: the SIGKILL the grace was armed for still lands,
    // graceMs after the note was written. What no wording can promise is a member that left the
    // group — that one is unreachable by anything in the module, grace or not.
    assert.equal(await waitForExit(survivor, 6_000), true, 'the grace SIGKILL never landed, so a member that survived the SIGTERM outlived the gate while the report said its group was killed')
  } finally {
    if (survivor) killPid(survivor)
  }
})

test('a check that finishes early while its group runs on keeps the pid on the sweep set', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // Not a timeout at all, which is the point: the command exits 0 in milliseconds and leaves a
  // member behind with redirected stdio. `cleanup`'s unconditional `liveGroups.delete` was the
  // last retirement path that dropped a group which was still running, and it contradicted the
  // invariant the module documents. Measured: `sleep 47 >/dev/null 2>&1 & echo started;
  // sleep 0.05` resolved code 0 with `liveGroupPids()` empty, and a SIGINT two seconds later
  // left `sleep 47` running.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-registered-'))
  const goFile = path.join(dir, 'go')
  let spawned = null
  try {
    const { code, output } = await defaultExec(`${heldMember(goFile)} echo started`, process.cwd(), {
      timeoutMs: 20_000,
      onSpawn: (pid) => { spawned = pid },
    })
    assert.equal(code, 0, output)
    assert.match(output, /started/)
    assert.equal(groupEmpty(spawned), false, 'setup: the member must still hold the group when the check has already finished')
    assert.ok(liveGroupPids().includes(spawned), 'a check that PASSED while leaving its group running was dropped from the sweep set, so a Ctrl-C now leaves that group behind')
  } finally {
    await releaseMember(goFile)
    if (spawned) { try { process.kill(-spawned, 'SIGKILL') } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true })
  }
})

test('a pid whose group empties with no event left to announce it is retired within a probe interval', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // The other half of keeping the pid: something has to take it off again. Once the promise has
  // settled there is no `close`, no `exit` and no signal left to notice the member finally
  // going, so the pid used to sit on the sweep list until the next signal attempt — which on the
  // 15-minute production default is fifteen minutes. Measured: group empty at 310ms, pid still
  // registered at 5016ms with timeoutMs 5000.
  //
  // What closes it is a re-probe on a timer, and what that buys is a BOUND, not safety: the
  // probe is a liveness test, so a pgid handed straight back out answers it "alive" and the pid
  // stays registered against a stranger. The exposure is one probe interval instead of one
  // timeout, and that is the whole claim.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-reap-'))
  const goFile = path.join(dir, 'go')
  let spawned = null
  try {
    await defaultExec(`${heldMember(goFile)} echo started`, process.cwd(), {
      timeoutMs: 20_000,
      onSpawn: (pid) => { spawned = pid },
    })
    assert.ok(liveGroupPids().includes(spawned), 'setup: the pid must survive the settle for this to have anything to retire')
    // The member goes because the TEST says so, so the emptying below is an event it caused.
    await releaseMember(goFile)
    const emptiedAt = await waitForGroupEmpty(spawned, 5_000)
    assert.notEqual(emptiedAt, null, 'setup: the member never exited, so the group never emptied')
    const retiredAt = await waitForRetirement(spawned, REAP_BOUND_MS + 2_000)
    assert.notEqual(retiredAt, null, 'the pid was never retired at all: with nothing left to announce the group ending, it sits on the sweep list until the timeout — fifteen minutes on the production default')
    assert.ok(retiredAt - emptiedAt < REAP_BOUND_MS, `retired ${retiredAt - emptiedAt}ms after the group emptied, which is not a probe interval — the window is bounded by the timeout again`)
  } finally {
    await releaseMember(goFile)
    if (spawned) { try { process.kill(-spawned, 'SIGKILL') } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true })
  }
})

// ── THE TEARDOWN ITSELF, OUT OF PROCESS ──────────────────────────────────────────────────────
// A signal handler cannot be observed from inside the process that installs it. Node's default
// disposition for all four of these signals TERMINATES the process without running any handler
// or any `exit` listener, so nothing an in-process test can assert distinguishes a registered
// handler from an absent one — measured: replacing the sweep with `() => {}` and deleting both
// signal registrations left all 134 other tests in this file green, while a real gate sent
// SIGINT still exited 130 and left its `sleep` running. So these spawn a real gate in a child
// node, signal it, and read BOTH its exit code and whether the check's group outlived it.
//
// What they cannot cover: SIGKILL and SIGSTOP, which no handler can displace. A gate killed
// that way still orphans its checks, and the only thing that covers it is the claim file the
// orphan holds itself.

// The driver: one real `defaultExec` whose command records a grandchild pid and then waits. The
// grandchild's stdio is redirected on purpose, so nothing the test observes can be a pipe
// closing rather than the sweep.
// The one line both drivers need: a command that backgrounds a member and records its pid where
// the test can read it. Shared so that the quoting below is pinned once for both of them.
// `pidFile` arrives as `process.argv[2]` at runtime, so it is the driver's own source that has to
// carry the path safely into a `shell: true` command.
const runLineSource = (secs, tail) => [
  // The path reaches the shell as a PARAMETER rather than as source text. A double-quoted
  // expansion is not re-parsed, so no character in the name can be read as syntax — which is the
  // whole point here, because the name is TMPDIR-derived and this source is built at runtime out
  // of `process.argv`, where a build-time quoting helper cannot reach it.
  'process.env.TM_PIDFILE = pidFile',
  'const run = ' + JSON.stringify(`sleep ${secs} >/dev/null 2>&1 & echo $! > "$TM_PIDFILE"; ${tail}`),
]

const driverSource = () => [
  `import { defaultExec } from ${JSON.stringify(new URL('../scripts/gate-runner.mjs', import.meta.url).href)}`,
  'import { readFileSync } from "node:fs"',
  'const pidFile = process.argv[2]',
  'const exitWhenRunning = process.argv[3] === "exit"',
  ...runLineSource(60, 'wait'),
  'defaultExec(run, process.cwd(), { timeoutMs: 60_000 }).catch(() => {})',
  // The normal-exit variant waits for the grandchild to be on disk before exiting, so the `exit`
  // sweep is always reached with a group that is certainly running.
  'if (exitWhenRunning) {',
  '  const poll = setInterval(() => {',
  '    let pid = ""',
  '    try { pid = readFileSync(pidFile, "utf8").trim() } catch {}',
  '    if (/^\\d+$/.test(pid)) { clearInterval(poll); process.exit(7) }',
  '  }, 20)',
  '}',
].join('\n')

// `exit` is emitted ONCE and is not replayed to a listener that arrives later, so every caller
// gets this promise rather than attaching its own after the fact. See `startDriver`.
const waitForChild = (child) => new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

// Returns once the grandchild pid is on disk, or after a bounded wait — a driver that never got
// that far fails the setup assertion rather than hanging the suite.
//
// `exited` IS ARMED BEFORE THE POLL BELOW, AND THAT ORDERING IS THE TEST'S CORRECTNESS, not a
// tidiness. The `exit` driver decides to exit on ITS OWN 20ms poll of the very file this one
// polls, so the two race: whenever the driver's timer lands first, the process is gone and node
// has emitted `exit` before this function returns. A caller that attached its listener afterward
// would wait for an event already fired and hang until the test's timeout — measured on linux by
// inserting a 200ms delay between this returning and the attach: the exact 30 000ms timeout and
// `1 cancelled` that macos produced on runs 33255281167 and 33257095536, where the loaded runner
// lost that race on its own. Armed here, before the first `await`, nothing can be missed.
const startDriver = async (dir, mode = 'wait', { cwd = undefined, pidFile = path.join(dir, 'kid.pid') } = {}) => {
  const script = path.join(dir, 'driver.mjs')
  await writeFile(script, driverSource())
  const child = spawn(process.execPath, [script, pidFile, mode], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = waitForChild(child)
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const until = Date.now() + 15_000
  let kid = ''
  while (Date.now() < until && !/^\d+$/.test(kid)) {
    try { kid = (await readFile(pidFile, 'utf8')).trim() } catch { kid = '' }
    if (!/^\d+$/.test(kid)) await new Promise((r) => setTimeout(r, 20))
  }
  return { child, kid, exited, stderr: () => stderr }
}

test('a temp path carrying shell metacharacters cannot inject a command through the driver', { skip: POSIX_ONLY, timeout: 40_000 }, async () => {
  // Fourth shape, and the one the other three cannot cover: the driver builds its command in a
  // CHILD process at runtime, out of a path it took from `process.argv`, so the quoting that has
  // to hold is in generated source rather than in this file's own template. `cwd` is set so a
  // relative marker lands where this test can see and clean it.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-inject-drv-'))
  const marker = path.join(dir, 'INJECTED')
  const hostile = path.join(dir, "h'$(touch INJECTED)'d")
  await mkdir(hostile)
  let driver = null
  try {
    driver = await startDriver(dir, 'wait', { cwd: dir, pidFile: path.join(hostile, 'kid.pid') })
    assert.equal(
      existsSync(marker),
      false,
      'the command substitution in the temp path was executed by the shell, so a directory name chose what a spawned gate runs',
    )
    assert.match(
      driver.kid,
      /^\d+$/,
      `the driver never recorded its member pid at the hostile path, so the quoting broke the command instead of neutralising it: ${JSON.stringify(driver.stderr())}`,
    )
  } finally {
    if (driver) {
      driver.child.kill('SIGKILL')
      if (driver.kid) killPid(driver.kid)
      await driver.exited
    }
    await rm(dir, { recursive: true, force: true })
  }
})

for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGQUIT', 131]]) {
  test(`a ${signal} to a running gate sweeps the check's process group and exits ${expected}`, { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
    // SIGHUP and SIGQUIT are the two `detached` made worse rather than better: setsid() moved
    // the check's group out of node's session, so a hangup that used to reach the whole tree
    // through the shared group now reaches nothing, and the default disposition kills the gate
    // before its timer or its `exit` sweep can run. Measured on the pre-fix module: parent dead,
    // grandchild alive in its own session.
    const dir = await mkdtemp(path.join(tmpdir(), 'tm-teardown-'))
    let driver = null
    try {
      driver = await startDriver(dir)
      assert.match(driver.kid, /^\d+$/, `setup: the gate never reported a grandchild pid: ${driver.stderr()}`)
      assert.ok(alivePid(driver.kid), 'setup: the check must still be running when the signal arrives')
      const exited = driver.exited
      process.kill(driver.child.pid, signal)
      const seen = await exited
      assert.equal(seen.signal, null, `the gate took ${signal}'s default disposition instead of handling it, so no sweep ran: ${JSON.stringify(seen)}`)
      assert.equal(seen.code, expected, `128 + signal number is the convention the handlers already follow: ${JSON.stringify(seen)}`)
      assert.equal(await waitForExit(driver.kid, 5_000), true, `${signal} left the check's process group running, so a closed terminal orphans the whole tree with its timer gone`)
    } finally {
      if (driver) {
        driver.child.kill('SIGKILL')
        if (driver.kid) killPid(driver.kid)
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('a gate that exits of its own accord sweeps the check group on the way out', { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
  // The third registration — `process.once('exit', sweep)` — which the four signal tests above
  // cannot pin, because each of those handlers calls the sweep itself.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-teardown-'))
  let driver = null
  try {
    driver = await startDriver(dir, 'exit')
    assert.match(driver.kid, /^\d+$/, `setup: the gate never reported a grandchild pid: ${driver.stderr()}`)
    const seen = await driver.exited
    assert.equal(seen.code, 7, `setup: the driver must reach its own exit: ${JSON.stringify(seen)}`)
    assert.equal(await waitForExit(driver.kid, 5_000), true, 'the gate exited leaving its check running, so an ordinary early return orphans a suite')
  } finally {
    if (driver) {
      driver.child.kill('SIGKILL')
      if (driver.kid) killPid(driver.kid)
    }
    await rm(dir, { recursive: true, force: true })
  }
})

// The second driver, for the one clause of rule 3 that only node's OWN EXIT can answer: the
// reaper's `unref`. Its check PASSES in milliseconds and leaves a member holding the group for
// twenty-five seconds, which is the shape rule 1 keeps registered — so the reaper is still
// ticking with a non-empty `liveGroups` when the verdict is reported, and whether it is ref'd
// decides whether node can leave.
const reaperDriverSource = () => [
  `import { defaultExec } from ${JSON.stringify(new URL('../scripts/gate-runner.mjs', import.meta.url).href)}`,
  'import { readFileSync } from "node:fs"',
  'const pidFile = process.argv[2]',
  // Redirected stdio on the member, as everywhere else in this file: what it must hold open is
  // the process GROUP, never our end of the pipes, or `close` would wait on it and the exit
  // being measured would be the pipes rather than the timer.
  ...runLineSource(25, 'exit 0'),
  'const res = await defaultExec(run, process.cwd(), { timeoutMs: 60_000 })',
  // Reported by the driver rather than inferred by the parent, so the parent's stopwatch starts
  // at the VERDICT and never at the spawn — node's own startup is then not in the measurement,
  // which is what stops this racing a loaded host the way a fixed window would.
  'let alive = false',
  'try { process.kill(Number(readFileSync(pidFile, "utf8").trim()), 0); alive = true } catch {}',
  'process.stdout.write("SETTLED code=" + res.code + " alive=" + alive + "\\n")',
  // AND NOTHING ELSE. No `process.exit()`, exactly like `scripts/cli.mjs`, which has one
  // `process.exitCode = await runCli(...)` and never calls it: this node exits by DRAINING THE
  // LOOP, which is precisely what a ref'd repeating timer prevents.
].join('\n')

test('the reaper is unref\'d, so a check that has reported does not hold the gate open until its group ends', { skip: POSIX_ONLY, timeout: 40_000 }, async () => {
  // RULE 3, THE REAPER CLAUSE — "AFTER THE VERDICT THE GATE NEVER WAITS" — and until this test
  // it was the one line in the module nothing pinned. Deleting `reaper.unref?.()` left the whole
  // suite green, twice over two full `npm test` runs. Measured on that mutant with this exact
  // command: the verdict was reported at 10ms and node exited at 25037ms, held by its own
  // repeating timer until the member finally ended and the interval cleared itself. Unmutated,
  // 90ms. On the fifteen-minute production default with a check that leaves a daemon behind,
  // that is a gate which has PASSED and cannot exit.
  //
  // WHY THIS IS OUT OF PROCESS, AND WHY THE OBVIOUS IN-PROCESS TEST CANNOT WORK. The natural
  // move is an `armedTimers()` delta around a call, the way five other tests here sample it.
  // That was implemented against the mutant and it PASSES: `T-before = 1`, `T-after = 1`, on two
  // runs. The reason is structural, not a timing accident — `startReaper` returns early while
  // `reaper` is non-null, so ONE interval object survives across many tests for as long as any
  // group is live at each tick, and it is therefore counted on BOTH sides of every delta in this
  // file. No sampling of that counter can see this timer at all; only the interval's own
  // `hasRef()`, which is not reachable from outside the module, or node's own exit, which is
  // what this measures. The stopwatch runs from the driver's reported verdict to the driver's
  // exit, so neither node startup nor the parent's scheduling is inside it.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-unref-'))
  const pidFile = path.join(dir, 'kid.pid')
  const script = path.join(dir, 'reaper-driver.mjs')
  let child = null
  let kid = null
  try {
    await writeFile(script, reaperDriverSource())
    child = spawn(process.execPath, [script, pidFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settledAt = null
    child.stdout.on('data', (d) => {
      stdout += d
      if (settledAt === null && /SETTLED/.test(stdout)) settledAt = Date.now()
    })
    child.stderr.on('data', (d) => { stderr += d })
    const seen = await waitForChild(child)
    const exitedAt = Date.now()
    try { kid = (await readFile(pidFile, 'utf8')).trim() } catch { kid = null }
    assert.notEqual(settledAt, null, `setup: the gate never reported a verdict at all: ${JSON.stringify({ stdout, stderr })}`)
    // Both halves of the setup, from the driver's own report: the check PASSED, and its group
    // was still running when it did. A check that failed, or one whose member had already gone,
    // would leave `liveGroups` empty and the reaper would clear itself — which is a green result
    // that measured nothing.
    assert.match(stdout, /SETTLED code=0 alive=true/, `setup: the check must pass while its group is still running, or there is no live group to hold the reaper: ${JSON.stringify({ stdout, stderr })}`)
    assert.equal(seen.signal, null, `the gate was killed rather than exiting on its own: ${JSON.stringify(seen)}`)
    assert.equal(seen.code, 0, `the gate did not exit cleanly by draining its loop: ${JSON.stringify({ seen, stderr })}`)
    // THE PIN. Five seconds against a member that lives for twenty-five: the unmutated gate
    // takes tens of milliseconds and the mutant takes the member's whole lifetime, so there is
    // twenty seconds of daylight between the two answers and nothing here is a close call.
    assert.ok(
      exitedAt - settledAt < 5_000,
      `the gate reported its verdict and then stayed alive for ${exitedAt - settledAt}ms waiting on a group it had already given up on`
      + ' — the reaper is ref\'d, so every passing check that leaves anything running holds node open until that thing ends,'
      + ' which on the production default is a gate that has PASSED and cannot exit',
    )
  } finally {
    if (child) child.kill('SIGKILL')
    if (kid) killPid(kid)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a check whose process group empties early is retired while the promise is still pending', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // THE ESCAPED-GRANDCHILD PATH, which is the case the timeout exists for. The command execs
  // into a process that spawns a DETACHED grandchild inheriting the pipes and then exits, so the
  // group we spawned is empty within milliseconds while `close` still cannot fire. Linux frees a
  // pgid as soon as its group has no members, so a pid held until the timeout names whatever the
  // OS hands the number to next — and the module then signals it three ways: SIGTERM at the
  // timeout, SIGKILL at the grace, and a SIGKILL from the sweep on every Ctrl-C. `catch {}`
  // cannot detect that: once the number is reused no ESRCH is raised, because it names something
  // real.
  //
  // EVERY ORDERING HERE IS AN OBSERVED EVENT. The previous version raced retirement against a
  // fixed 300ms window and lost under load — measured, the leader that cleared it in 35ms
  // unloaded took 659ms at eight times oversubscription, and the test then failed with the exact
  // message the genuine mutation produces, so a loaded CI run was indistinguishable from a
  // regression. The timeout is set to twenty seconds precisely so that nothing below depends on
  // it: what is pinned is that retirement happens while the promise is STILL PENDING, which is
  // the structural claim, rather than that it happens inside some number of milliseconds.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-escaped-'))
  const escFile = path.join(dir, 'escapee.pid')
  let spawned = null
  let settled = false
  let escaped = null
  try {
    const p = defaultExec(escapeeExec(escFile), process.cwd(), {
      timeoutMs: 20_000,
      graceMs: 200,
      onSpawn: (pid) => { spawned = pid },
    })
    p.then(() => { settled = true }, () => { settled = true })
    assert.ok(Number.isInteger(spawned), `setup: expected a pid, got ${spawned}`)
    const emptiedAt = await waitForGroupEmpty(spawned, 10_000)
    assert.notEqual(emptiedAt, null, 'setup: the group never emptied, so there was nothing to retire')
    const retiredAt = await waitForRetirement(spawned, REAP_BOUND_MS + 2_000)
    assert.notEqual(retiredAt, null, 'the pid was never retired, so every signal path still aims at a number the OS has already freed')
    assert.ok(retiredAt - emptiedAt < REAP_BOUND_MS, `retired ${retiredAt - emptiedAt}ms after the group emptied, which is not a probe interval`)
    // THE CLAIM ITSELF: retirement did not wait for the promise. Held to the close or to the
    // timeout it would be twenty seconds away here.
    assert.equal(settled, false, 'the promise had already settled by the time the pid was retired, so this measured the close rather than the group')
    escaped = (await readFile(escFile, 'utf8')).trim()
    assert.match(escaped, /^\d+$/, 'setup: the escapee never recorded its grandchild')
    // Dropping the grandchild releases the pipes, so the check settles on its own instead of the
    // test waiting out a twenty-second timeout.
    killPid(escaped)
    const { code, output } = await p
    assert.equal(code, 0, output)
    assert.doesNotMatch(output, /timed out/, 'the timeout fired, so the settle above was not the close this test arranged')
  } finally {
    if (escaped) killPid(escaped)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a pid handed to a second call retires the first, which is the one reuse ordering that is observable', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // THE MIRROR OF THE TEST BELOW, and the half of pid reuse that CAN be pinned.
  //
  // `liveGroups.set` on an occupied key discards the old value silently, and that value is the
  // displaced call's only channel for learning it was retired. Strand it and nothing can ever
  // set that call's `retired` flag — `retireIfGroupGone` answers false, because the group at
  // that number is now the SECOND call's and alive — so the first call's grace fires with
  // `retired === false`, finds the pid registered, probes a group that answers alive, and
  // SIGKILLs a check that is running normally. A spurious FAIL, from the mechanism added to
  // prevent spurious FAILs.
  //
  // WHY THIS ONE IS REACHABLE WHEN THE OTHER IS NOT. Reuse after retirement is invisible: the
  // pid is gone from the map and nothing in the process can tell the new holder from the old.
  // Reuse BEFORE retirement announces itself — being handed a pid that is already in the map is
  // proof the previous holder's group has ended, because a live group keeps its pgid reserved
  // and the OS cannot hand the same one out twice. So the re-registration is the observable
  // event, and staging it needs no pid recycling at all: a number whose group is already gone
  // stands in for the recycled one exactly, since what `registerGroup` reacts to is the
  // COLLISION and not the history behind it.
  // WHAT THIS DOES NOT REACH, stated because a green run here is narrower than it looks: it
  // drives `registerGroup` directly, so it pins the DISPLACEMENT and not the fact that
  // `defaultExec` goes through it. Measured — rewrite that one call site back to a bare
  // WHAT THIS DOES NOT REACH, stated because a green run here is narrower than it looks: it
  // drives `registerGroup` directly, so it pins the DISPLACEMENT and not the fact that
  // `defaultExec` goes through it. Measured — rewrite that one call site back to a bare
  // `liveGroups.set` and this test stays green, because it never spawns the colliding call.
  // Pinning it behaviourally would need the kernel to hand a staged number to a real spawn,
  // which is not arrangeable. The test below pins that call site as SOURCE TEXT instead, which
  // needs no pid at all.
  //
  // THE STAGED PID IS ONE THE MODULE STILL OWNS, and that is a safety property rather than a
  // convenience. An earlier version staged a pid from a FINISHED `defaultExec` — already
  // retired, group already gone — which meant the number belonged to nobody from that instant
  // and the kernel was free to reissue it. Had it landed on a process-group LEADER,
  // `retireIfGroupGone` would answer false forever, the pid would still be on `liveGroups` at
  // exit, and the teardown sweep would have fired `process.kill(-pid, SIGKILL)` into a
  // stranger's group owned by the same user: the exact hazard cited above to decline the
  // behavioural pin, reintroduced at a narrower width. A HELD group cannot be reissued — a live
  // group keeps its pgid reserved, and the kernel skips a number still in use even with the
  // allocator aimed straight at it — so staging here carries no foreign-group risk at all.
  //
  // Taking the registration over from a call that has already SETTLED is what makes that safe:
  // the check exited 0 in milliseconds and left the member behind, so its timeout is cleared and
  // no grace was ever armed. There is nothing left for the displaced callback to disarm.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-reissue-'))
  const goFile = path.join(dir, 'go')
  let aRetired = false
  let bRetired = false
  let held = null
  try {
    await defaultExec(`${heldMember(goFile)} echo started`, process.cwd(), {
      timeoutMs: 20_000,
      onSpawn: (pid) => { held = pid },
    })
    assert.ok(Number.isInteger(held), `setup: expected a pid, got ${held}`)
    assert.equal(groupEmpty(held), false, 'setup: the member must still hold the group, or the number is free and this is staging a pid the kernel may have reissued')
    assert.ok(liveGroupPids().includes(held), 'setup: a group with a member still in it must be registered, or there is no registration to displace')
    // NOTHING AWAITS BETWEEN THE TWO REGISTRATIONS, deliberately: the reaper runs on a timer and
    // a tick between them would retire the first call itself, which is a different event wearing
    // the same result. Synchronous, so only the displacement can be what sets `aRetired`.
    registerGroup(held, () => { aRetired = true })
    assert.equal(aRetired, false, 'setup: registering retired the call that was doing the registering')
    registerGroup(held, () => { bRetired = true })
    assert.equal(aRetired, true, 'the displaced call was never told its number had been reissued, so nothing can set its `retired` flag and its grace SIGKILL will land on whoever holds the pid now')
    assert.equal(bRetired, false, 'the incoming call was retired by its own registration, which would disarm every signal it is entitled to send')
  } finally {
    // Released, then reaped: the member goes because the test says so, the group empties, and
    // the reaper takes the pid back off the sweep set. The pid is ours for the whole of that.
    await releaseMember(goFile)
    if (held) { try { process.kill(-held, 'SIGKILL') } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true })
  }
  assert.notEqual(
    await waitForRetirement(held, REAP_BOUND_MS + 2_000),
    null,
    'the staged registration was never reaped, so this test has left a pid on the sweep set for the rest of the run',
  )
  assert.equal(bRetired, true, 'the reaper retired the pid without telling the call that then held the registration, which is the same stranding this test exists for, one step later')
})

test('every registration goes through registerGroup, asserted as source text because no pid can reach it', async () => {
  // THE CALL SITE THE TEST ABOVE CANNOT PIN. Rewriting `registerGroup(child.pid, ...)` in
  // `defaultExec` back to a bare `liveGroups.set(...)` reintroduces the entire defect that
  // function exists to close, and leaves this file and the whole suite green: the displacement
  // test drives the helper directly and never spawns a colliding call, and a colliding call
  // cannot be arranged, because it needs the kernel to hand a staged number to a real spawn.
  //
  // So it is pinned as TEXT. That needs no pid, no spawn and no signal, it costs nothing, and it
  // asserts exactly the invariant the module's own comments lean on — that there is ONE place a
  // pid enters the set. Reading a script and asserting over it is an idiom this suite already
  // uses: tests/brief.test.mjs reads scripts/cli.mjs the same way to pin the exit codes the
  // brief documents.
  //
  // Its limit, so it is not read as more than it is: this says the call site SPELLS the right
  // thing, not that the right thing happens when it runs. What happens is the test above.
  const src = await readFile(new URL('../scripts/gate-runner.mjs', import.meta.url), 'utf8')
  // COMMENTS STRIPPED FIRST, and this is not fastidiousness: the module's own comments discuss
  // `liveGroups.set` by name — including the one that documents THIS assertion — so a naive
  // match over the raw text counts prose as code and the test fails on a documentation edit.
  // It did, on the first run. Whole-line `//` is the only comment form in that file, checked.
  const code = src.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n')
  const sets = [...code.matchAll(/liveGroups\.set\b/g)]
  assert.equal(sets.length, 1, `liveGroups.set occurs ${sets.length} times in the module's code — a second one is a registration that skips registerGroup, so the call it displaces is never told its number was reissued, and the grace SIGKILL that call still holds lands on the new holder's group`)
  const header = code.indexOf('export function registerGroup(')
  assert.notEqual(header, -1, 'the module no longer declares registerGroup, so the one place a pid enters the set is somewhere else now')
  // The first `}` at column zero after the header, which is where a top-level function ends.
  const end = code.indexOf('\n}', header)
  assert.notEqual(end, -1, 'registerGroup has no closing brace at column zero')
  assert.ok(
    sets[0].index > header && sets[0].index < end,
    'the single liveGroups.set sits outside registerGroup, so registrations no longer pass through the displacement that retires the call the pid was taken from',
  )
})

test('the per-call retirement latch withholds nothing from a group that is still ours', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // THE OTHER DIRECTION OF RULE 2's "PER CALL" CLAUSE, and the only direction a test can reach.
  //
  // `killGroup`'s own guard is a test on the NUMBER — `liveGroups.has(pid)` — which cannot tell
  // a pid still registered to US from the same number re-registered by a LATER `defaultExec`
  // after the OS handed it back. So each call latches its own `retired` flag and every signal it
  // sends goes through `signalGroup`, which refuses once that flag is set. The hazard that
  // closes — a grace timer from check A landing on check B's group — needs the OS to recycle a
  // pid inside a grace window, which is not arrangeable from inside a process; it is stated in
  // the module and pinned by nothing, deliberately.
  //
  // What IS reachable is the cost of getting the latch wrong in the safe-looking direction: a
  // flag latched too early makes `signalGroup` a no-op and the gate stops killing anything at
  // all. Latch `retired = true` at its declaration and this goes red on both signals, as does
  // every other signal test in the file — this one names the reason.
  //
  // Both signals are driven on ONE run: `trap '' TERM` sets SIG_IGN, inherited across the exec
  // into `sleep`, so the SIGTERM at the timeout is ignored and only the SIGKILL at the grace can
  // end it. The spy DELEGATES — every call still reaches the real `process.kill` — and records
  // whether the pid was ours at the moment of each signal, which is the question `signalGroup`
  // exists to answer.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-latch-'))
  const realKill = process.kill.bind(process)
  const signalled = []
  let spawned = null
  let kid = null
  try {
    const pidFile = path.join(dir, 'kid.pid')
    process.kill = (target, sig) => {
      if (sig !== 0 && sig !== '0') signalled.push({ target, sig, registered: spawned !== null && liveGroupPids().includes(spawned) })
      return realKill(target, sig)
    }
    // `ARMED` is printed only once the trap is set and the member is backgrounded, so its
    // presence in the output is the SETUP PREDICATE — see the ordering note below.
    const { code, output } = await defaultExec(
      `trap '' TERM; sleep 20 & ${recordPid(pidFile)}; echo ARMED; wait`,
      process.cwd(),
      { timeoutMs: 200, graceMs: 200, onSpawn: (pid) => { spawned = pid } },
    )
    const aimedAtTheGroup = signalled.filter((s) => s.target === -spawned)
    // THE HALF THAT HOLDS ON EVERY RUN, asserted before anything that a lost setup race can
    // disturb: the timeout fired at a group that was certainly still live, so a SIGTERM must
    // have gone out and it must have gone out while the pid was ours. A latch set too early
    // produces an EMPTY list here, which is the mutation this test is for.
    assert.equal(aimedAtTheGroup[0]?.sig, 'SIGTERM', `the latch withheld the timeout's SIGTERM from a group that was still this call's own: ${JSON.stringify(aimedAtTheGroup)} — a gate that signals nothing is not a safer gate, it is one that leaves every timed-out suite running`)
    assert.deepEqual(aimedAtTheGroup.filter((s) => !s.registered), [], `a signal was sent after the pid stopped being registered: ${JSON.stringify(aimedAtTheGroup)}`)
    assert.notEqual(code, 0)
    assert.match(output, /timed out after 200ms; its process group was killed/)
    // THE SETUP, DIAGNOSED BEFORE THE STRONGER HALF IS ASKED FOR. The grace SIGKILL is only
    // reachable if the member SURVIVES the SIGTERM, which needs `trap '' TERM` to have run
    // inside the 200ms window — and at 48 busy loops pinned to one core the shell does not get
    // that far. Without this guard that run failed on a bare ENOENT from the pid file, with no
    // message at all; with it, the run says what happened and the half it could still measure
    // above has already been measured.
    assert.match(output, /ARMED/, `setup: the shell did not install its SIGTERM trap inside the 200ms timeout, so there was never a member that could survive to the grace: ${JSON.stringify(output)}`)
    kid = await readFile(pidFile, 'utf8').then((s) => s.trim(), () => null)
    assert.match(kid ?? '', /^\d+$/, `setup: the command did not report its child pid: ${JSON.stringify(kid)}`)
    assert.deepEqual(
      aimedAtTheGroup.map((s) => s.sig),
      ['SIGTERM', 'SIGKILL'],
      `the latch withheld the grace SIGKILL from a group that was still this call's own: ${JSON.stringify(aimedAtTheGroup)}`,
    )
    // The signals were SENT, and this is what says the second one also landed.
    assert.equal(await waitForExit(kid, 5_000), true, 'the grace SIGKILL was recorded as sent but the SIGTERM-ignoring member outlived it')
  } finally {
    process.kill = realKill
    if (kid) killPid(kid)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a retired pid is never signalled again, even when the probe says something holds its group again', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // RULE 2, and the one hazard in this file that CANNOT be reached on a real system: a pgid the
  // OS has already handed back out answers the liveness probe "alive", and nothing inside a
  // process can tell that apart from our own group still running. Retirement has to be TERMINAL
  // for that reason — a second look is not a second chance — and the armed timers are what make
  // it matter: the timeout and the grace both fire at `child.pid` long after the escaped-
  // grandchild path retired it, so without the registration check the reuse window on the timer
  // path is as wide as the whole timeout.
  //
  // So the probe is made to LIE exactly the way reuse lies: it answers yes for a pid already
  // retired. Signals aimed at the group are then recorded and NOT delivered, because in the
  // situation being simulated they would land on a stranger.
  //
  // WHAT WITHHOLDS THEM IS NOW TWO THINGS, AND THIS TEST CANNOT TELL THEM APART. An earlier
  // version of this comment said "the registration check and nothing else", which was true when
  // it was written and stopped being true when `signalGroup` gained its per-call `retired`
  // latch: the latch refuses first, and `killGroup`'s `liveGroups.has(pid)` refuses after it.
  // Measured — remove the membership guard and this test stays green, remove the latch and it
  // stays green, remove both and it is the one test in the file that goes red. So what it pins
  // is the CLAIM, that a retired pid is never signalled again, and not either mechanism; do not
  // read a green run here as licence to delete one of them, and see the note above the guard in
  // `killGroup` for why both are kept.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-terminal-'))
  const escFile = path.join(dir, 'escapee.pid')
  const realKill = process.kill.bind(process)
  const signalledAfterRetirement = []
  let spawned = null
  let escaped = null
  try {
    const p = defaultExec(escapeeExec(escFile), process.cwd(), {
      timeoutMs: 700,
      graceMs: 100,
      onSpawn: (pid) => { spawned = pid },
    })
    assert.ok(Number.isInteger(spawned), `setup: expected a pid, got ${spawned}`)
    // Retirement is an OBSERVED event here, not an assumed one: it happens at the leader's exit,
    // and the timeout is only allowed to matter after this has been seen.
    assert.notEqual(await waitForRetirement(spawned, 10_000), null, 'setup: the escaped-grandchild path did not retire the pid, so there is no retired pid to signal')
    process.kill = (target, sig) => {
      if (target !== -spawned) return realKill(target, sig)
      if (sig === 0 || sig === '0') return true // what a recycled pgid answers, and it is a lie
      signalledAfterRetirement.push(sig)
      return true
    }
    const { code, output } = await p
    // THE CLAIM FIRST, BEFORE ANYTHING THAT CAN THROW ON A LOST SETUP RACE. The `readFile` used
    // to be the line above this one, and it fails with a bare ENOENT — no message, no diagnosis
    // — whenever the escapee's node startup does not fit inside the 700ms timeout. Measured at
    // 48 busy loops pinned to one core: `ENOENT ... escapee.pid`, and the assertion this test
    // exists for never ran at all. Same defect class as an assertion ordered behind its own
    // guard, and the fix is the same: assert the claim, then diagnose the setup.
    assert.deepEqual(signalledAfterRetirement, [], `signalled a pid this module had already retired: ${JSON.stringify(signalledAfterRetirement)} — the probe cannot save it, because a reused pgid answers the probe exactly as our own group would`)
    // The timer path really did run, which is what stops the assertion above being vacuous: the
    // note only reaches the output through the timeout, and the grace ran behind it.
    assert.match(output, /timed out after 700ms; its process group was killed/)
    assert.notEqual(code, 0)
    // Needed only for cleanup, so its absence is reported rather than thrown — and what it
    // reports is a WEAKER RUN, not a defect: with no escapee, the retirement observed above came
    // from the timeout's own kill rather than from the leader exiting, so only the grace SIGKILL
    // was ever in the spy's window.
    escaped = await readFile(escFile, 'utf8').then((s) => s.trim(), () => null)
    assert.notEqual(escaped, null, `setup: the escapee never recorded its grandchild, so its node startup did not fit inside the 700ms timeout and the assertion above saw only half the signals it should have: ${JSON.stringify(output)}`)
  } finally {
    process.kill = realKill
    if (escaped) killPid(escaped)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a group whose leader has exited but whose members are still running is killed, not retired', { skip: POSIX_ONLY, timeout: 20_000 }, async () => {
  // THE TRAP IN THE FIX ABOVE. `exec true` ends the group LEADER while the backgrounded `sleep`
  // stays a member, and a group with members keeps its pgid reserved — killing it is still
  // exactly right. So the retirement test is whether the GROUP is empty, never whether the
  // leader died: retiring on `child.exitCode !== null` drops this pid and the `sleep` outlives
  // the gate.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-leaderless-'))
  let kid = null
  try {
    const pidFile = path.join(dir, 'kid.pid')
    let spawned = null
    const p = defaultExec(
      `sleep 6 & ${recordPid(pidFile)}; exec true`,
      process.cwd(),
      { timeoutMs: 600, graceMs: 300, onSpawn: (pid) => { spawned = pid } },
    )
    assert.ok(Number.isInteger(spawned), `setup: expected a pid, got ${spawned}`)
    // Waits for the LEADER to die, which is safe to identify by pid here for the very reason
    // this test exists: a group with members keeps its pgid reserved, so nothing else can be
    // handed that number while the `sleep` runs.
    const deadline = Date.now() + 400
    while (Date.now() < deadline && alivePid(spawned)) await new Promise((r) => setTimeout(r, 10))
    assert.equal(alivePid(spawned), false, 'setup: the group leader must be gone before this can assert anything about a leaderless group')
    const stillRegistered = liveGroupPids().includes(spawned)
    const { code, output } = await p
    kid = (await readFile(pidFile, 'utf8')).trim()
    assert.equal(stillRegistered, true, 'the leader died and the pid was dropped from the sweep set while its group still had members, so a Ctrl-C now leaves that group behind')
    assert.match(kid, /^\d+$/, `the command did not report its child pid: ${JSON.stringify(kid)}`)
    assert.equal(await waitForExit(kid, 5_000), true, 'the kill never reached a group whose leader had exited, so a member of a still-reserved pgid outlived the gate')
    assert.notEqual(code, 0)
    assert.match(output, /timed out after 600ms; its process group was killed/)
  } finally {
    if (kid) killPid(kid)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a group that empties after its leader is retired without ever being signalled, timer included', { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
  // The window the exit-listener retirement CANNOT see: at the leader's exit the group still had
  // a member, so the pid was correctly kept — and then the member exited, with no `close`, no
  // `exit` and no signal left to notice it. Everything that fires afterwards aims at a pgid the
  // OS has already freed, and retirement has to protect the ARMED TIMERS as well as the sweep:
  // the timeout and the grace both fire at `child.pid` long after it stopped naming our group,
  // which on the escaped-grandchild path is a reuse window as wide as the whole timeout.
  //
  // NOTHING HERE RACES A CLOCK. The member exits when the TEST releases it, so "the leader has
  // gone while a member survives" and "the group has emptied" are events the test causes and
  // then observes. The previous version backed both onto fixed 200/400ms windows and lost under
  // load; worse, it failed with the same message the genuine mutation gives. The two failure
  // modes are separated below: a signal sent to a REGISTERED group means the timeout beat the
  // setup and the test measured nothing, and it says so; a signal sent to a RETIRED one is the
  // defect.
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-late-empty-'))
  const goFile = path.join(dir, 'go')
  const escFile = path.join(dir, 'escapee.pid')
  // A DELEGATING SPY, not a fake: every call still reaches the real `process.kill`, and all this
  // adds is a record of which ones were made and whether the pid was still ours at the time. It
  // is the only way to see the defect, because what separates probing from not probing is
  // whether a signal was SENT to a freed number — and learning about it from ESRCH afterwards,
  // as the `catch` does, is exactly one signal too late. A recycled pid raises no ESRCH at all,
  // so no assertion about the outcome can stand in for this one.
  const realKill = process.kill.bind(process)
  const signalled = []
  let spawned = null
  let escaped = null
  // THE SETUP GUARD, AND IT HAS TO BE CHECKABLE AT EVERY STEP RATHER THAN ONLY AT THE END.
  // A signal sent while the pid was still REGISTERED is a legitimate one: it means the timeout
  // beat the setup, the group was still live when it fired, and everything the test wanted to
  // observe afterwards has been destroyed by a SIGTERM the module was right to send. The
  // previous version checked this only after the promise settled, fifteen lines past the first
  // assertion the wreckage trips — so a loaded host failed on "the leader died and the pid was
  // dropped while its group still had a member", which is the GENUINE-DEFECT message, and a real
  // regression was indistinguishable from a busy machine. Right guard, wrong order.
  const prematureSignal = () => signalled.filter((s) => s.target === -spawned && s.registered)
  const stillMeasuringSomething = () => assert.deepEqual(
    prematureSignal(), [],
    'the timeout signalled the group while it was still live, so the ordering this test needs did not hold and it measured nothing —'
    + ' this is a lost race against the escapee\'s node startup, not a defect in the module',
  )
  try {
    process.kill = (target, sig) => {
      if (sig !== 0 && sig !== '0') signalled.push({ target, sig, registered: spawned !== null && liveGroupPids().includes(spawned) })
      return realKill(target, sig)
    }
    // The escapee holds the pipes so `close` cannot settle this early; the held member is what
    // outlives the leader and keeps the pgid reserved until the test lets it go.
    //
    // THE ONE FIXED WINDOW LEFT IN THIS FILE, and it is fixed because it cannot be anything else:
    // the timeout is chosen at spawn, and what has to fit inside it is a whole `node -e` startup
    // plus the release of the held member. 1_200 did not fit — at 48 busy loops on one core that
    // startup measures ~2000ms, and the SIGTERM then landed on a live group. 2_500 clears the
    // extreme case with room, and the guard above is what makes the residue diagnosable rather
    // than misleading. It costs 1.3s of wall clock against the old window and that is the price
    // of the honesty; a shorter escapee would be worth more, but leaving the process group needs
    // setsid, and nothing portable in `sh` does it.
    const p = defaultExec(`${heldMember(goFile)} ${escapeeExec(escFile)}`, process.cwd(), {
      timeoutMs: 2_500,
      graceMs: 100,
      onSpawn: (id) => { spawned = id },
    })
    assert.ok(Number.isInteger(spawned), `setup: expected a pid, got ${spawned}`)
    assert.notEqual(await waitUntil(() => !alivePid(spawned), 10_000), null, 'setup: the group leader never exited, so there was no leaderless window to measure')
    // A GROUP WITH MEMBERS KEEPS ITS PGID RESERVED, so this is still exactly the right thing to
    // kill and the pid must still be on the list — but only if the timeout has not already been
    // and gone, which is what the guard is asked first.
    stillMeasuringSomething()
    assert.ok(liveGroupPids().includes(spawned), 'the leader died and the pid was dropped while its group still had a member, so a Ctrl-C now leaves that group behind')
    await releaseMember(goFile)
    const emptiedAt = await waitForGroupEmpty(spawned, 10_000)
    assert.notEqual(emptiedAt, null, 'setup: the member never exited, so the group never emptied')
    const retiredAt = await waitForRetirement(spawned, REAP_BOUND_MS + 2_000)
    stillMeasuringSomething()
    assert.notEqual(retiredAt, null, 'the pid was never retired, so it stays on the sweep list for every later Ctrl-C and both armed timers still fire at it')
    assert.ok(retiredAt - emptiedAt < REAP_BOUND_MS, `retired ${retiredAt - emptiedAt}ms after the group emptied, which is not a probe interval`)
    const { code, output } = await p
    escaped = (await readFile(escFile, 'utf8')).trim()
    const aimedAtTheGroup = signalled.filter((s) => s.target === -spawned)
    // Asked a third time, because the timeout only fires here on a run where everything above
    // fitted inside it: the same guard, at the last moment it can still be wrong.
    stillMeasuringSomething()
    assert.deepEqual(aimedAtTheGroup, [], `signalled a group that had already emptied: ${JSON.stringify(aimedAtTheGroup)} — on a busy host that number belongs to someone else by now, and no ESRCH says so`)
    // The timer path DID run, which is what stops the assertion above being vacuous: the note
    // only reaches the output through the timeout, and the SIGTERM it would have sent was
    // withheld because the pid had been retired.
    assert.match(output, /timed out after 3s; its process group was killed/)
    assert.notEqual(code, 0)
  } finally {
    process.kill = realKill
    await releaseMember(goFile)
    if (escaped) killPid(escaped)
    await rm(dir, { recursive: true, force: true })
  }
})

// --- protected paths (docs/specs/2026-09-26-protected-paths-design.md) ------------------------
//
// Real repositories throughout, like every enforcement regression in this file. The manifest is
// the protected path: it is in the default set whatever the check entry carries.

const MANIFEST_FILE = 'fleetmates.gate.json'

function protectedPlan({ mark = false, extra = [] } = {}) {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    `- Modify${mark ? ' (protected)' : ''}: \`${MANIFEST_FILE}\``,
    ...extra,
    '',
  ].join('\n')
}

// Base commit with the plan and a manifest, run branch off it, T1's branch off that; `work` edits
// the T1 branch before it is committed. Returns the derived context, ready for a check.
async function protectedRun({ sh, git, root }, plan, work) {
  await writeFile(path.join(root, 'plan.md'), plan, 'utf8')
  await writeFile(path.join(root, MANIFEST_FILE), '{"phases":{}}\n', 'utf8')
  await writeFile(path.join(root, 'other.txt'), 'other\n', 'utf8')
  await sh(['add', '.'])
  await sh(['commit', '-m', 'base'])
  await sh(['checkout', '-b', 'run'])
  await sh(['checkout', '-b', 'fleetmates/r1/T1'])
  await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
  await sh(['add', 'a.mjs'])
  await work()
  await sh(['commit', '-m', 'T1 work'])
  await sh(['checkout', 'run'])
  return deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
}

const FILESET = { name: 'fileset', kind: 'fileset' }

for (const [shape, work] of [
  ['an edit', ({ root, sh }) => writeFile(path.join(root, MANIFEST_FILE), '{}\n', 'utf8').then(() => sh(['add', MANIFEST_FILE]))],
  ['a deletion', ({ sh }) => sh(['rm', '-q', MANIFEST_FILE])],
  ['a rename away', ({ sh }) => sh(['mv', MANIFEST_FILE, 'renamed.json'])],
  ['a rename onto it', ({ sh }) => sh(['rm', '-q', MANIFEST_FILE]).then(() => sh(['mv', 'other.txt', MANIFEST_FILE]))],
]) {
  test(`fileset fails ${shape} of a protected path the task declares but does not mark`, async () => {
    await withRepo(async (repo) => {
      const ctx = await protectedRun(repo, protectedPlan({ extra: ['- Create: `renamed.json`', '- Modify: `other.txt`'] }), () => work(repo))
      const res = await runFilesetCheck(FILESET, ctx)
      assert.equal(res.status, 'fail', res.output)
      assert.match(res.output, /T1: protected — fleetmates\.gate\.json/)
      assert.doesNotMatch(res.output, /outside declared set/)
    })
  })
}

test('fileset passes a change to a protected path the task marks (protected)', async () => {
  await withRepo(async (repo) => {
    const ctx = await protectedRun(repo, protectedPlan({ mark: true }), async () => {
      await writeFile(path.join(repo.root, MANIFEST_FILE), '{}\n', 'utf8')
      await repo.sh(['add', MANIFEST_FILE])
    })
    const res = await runFilesetCheck(FILESET, ctx)
    assert.equal(res.status, 'pass', res.output)
  })
})

test('fileset reports scope and protection as separate lines when a task breaks both', async () => {
  await withRepo(async (repo) => {
    const ctx = await protectedRun(repo, protectedPlan(), async () => {
      await writeFile(path.join(repo.root, MANIFEST_FILE), '{}\n', 'utf8')
      await writeFile(path.join(repo.root, 'stray.mjs'), 'x\n', 'utf8')
      await repo.sh(['add', MANIFEST_FILE, 'stray.mjs'])
    })
    const res = await runFilesetCheck(FILESET, ctx)
    const lines = res.output.split('\n')
    assert.ok(lines.some((l) => /^T1: outside declared set — stray\.mjs$/.test(l)), res.output)
    assert.ok(lines.some((l) => /^T1: protected — fleetmates\.gate\.json /.test(l)), res.output)
  })
})

test('fileset guards the paths the check carries, and the manifest when it carries none', async () => {
  await withRepo(async (repo) => {
    const ctx = await protectedRun(repo, protectedPlan({ extra: ['- Modify: `other.txt`'] }), async () => {
      await writeFile(path.join(repo.root, 'other.txt'), 'changed\n', 'utf8')
      await repo.sh(['add', 'other.txt'])
    })
    assert.equal((await runFilesetCheck(FILESET, ctx)).status, 'pass')
    const res = await runFilesetCheck({ ...FILESET, protected: ['fleetmates.gate.json', 'other.txt'] }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T1: protected — other\.txt/)
  })
})

// A case variant of the manifest, committed with plumbing through a private index, so NTFS and
// APFS build the same commit ext4 does — no worktree checkout ever holds two names differing only
// in case. Membership folds case; authorisation does not.
async function commitCaseVariant({ root, sh }, name) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(root, '.git', 'case-variant-index') }
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, env })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(' ')} exited ${code}`))))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
  await run(['read-tree', 'fleetmates/r1/T1'])
  const blob = await run(['hash-object', '-w', '--stdin'], '{"forged":true}\n')
  await run(['update-index', '--index-info'], `100644 ${blob}\t${name}\n`)
  const tree = await run(['write-tree'])
  const commit = await run(['commit-tree', tree, '-p', 'fleetmates/r1/T1', '-m', 'case variant'])
  await sh(['update-ref', 'refs/heads/fleetmates/r1/T1', commit])
}

test('fileset fails a case variant of the manifest, and a marking in other case does not authorise it', async () => {
  for (const mark of [false, true]) {
    await withRepo(async (repo) => {
      const ctx0 = await protectedRun(repo, protectedPlan({ mark, extra: ['- Create: `Fleetmates.gate.json`'] }), async () => {})
      await commitCaseVariant(repo, 'Fleetmates.gate.json')
      const ctx = await deriveContext({ git: repo.git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
      assert.ok(ctx0)
      const res = await runFilesetCheck(FILESET, ctx)
      assert.equal(res.status, 'fail', `mark=${mark}: ${res.output}`)
      assert.match(res.output, /T1: protected — Fleetmates\.gate\.json/)
    })
  }
})

// Two tasks that both change the manifest; T2's merge conflicts with T1's already-merged change and
// the integrator resolves it by hand. `markT2` decides whether that resolution is authorised.
async function protectedConflictRun({ root, sh, git }, { file = MANIFEST_FILE, markT2 }) {
  const plan = [
    '### Task 1: first', '', '**Files:**', `- Modify (protected): \`${file}\``, '',
    '### Task 2: second', '', '**Files:**', `- Modify${markT2 ? ' (protected)' : ''}: \`${file}\``, '', '**Depends:** T1', '',
  ].join('\n')
  await writeFile(path.join(root, 'plan.md'), plan, 'utf8')
  await writeFile(path.join(root, file), 'base\n', 'utf8')
  await sh(['add', '.'])
  await sh(['commit', '-m', 'base'])
  await sh(['checkout', '-b', 'run'])
  for (const [id, content] of [['T1', 'one\n'], ['T2', 'two\n']]) {
    await sh(['checkout', '-b', `fleetmates/r1/${id}`, 'run'])
    await writeFile(path.join(root, file), content, 'utf8')
    await sh(['commit', '-am', `${id} work`])
  }
  await sh(['checkout', 'run'])
  await sh(['merge', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
  await sh(['merge', '--no-ff', 'fleetmates/r1/T2']).catch(() => {})
  await writeFile(path.join(root, file), 'hand-resolved by the integrator\n', 'utf8')
  await sh(['add', file])
  await sh(['commit', '--no-edit'])
  return deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
}

const OWNERSHIP = { name: 'ownership', kind: 'ownership' }

test('ownership fails a hand-resolved conflict on a protected path when no parent task marks it', async () => {
  await withRepo(async (repo) => {
    const ctx = await protectedConflictRun(repo, { markT2: false })
    const res = await runOwnershipCheck(OWNERSHIP, ctx)
    assert.equal(res.status, 'fail', res.output)
    assert.match(res.output, /resolved a conflict on protected fleetmates\.gate\.json with no parent from a task marking it/)
  })
})

test('ownership accepts a hand-resolved conflict on a protected path when the parent task marks it', async () => {
  await withRepo(async (repo) => {
    const ctx = await protectedConflictRun(repo, { markT2: true })
    const res = await runOwnershipCheck(OWNERSHIP, ctx)
    assert.equal(res.status, 'pass', res.output)
  })
})

test('LIMIT: ownership still accepts a hand-resolved conflict on an unprotected path', async () => {
  await withRepo(async (repo) => {
    const ctx = await protectedConflictRun(repo, { file: 'shared.txt', markT2: false })
    const res = await runOwnershipCheck(OWNERSHIP, ctx)
    assert.equal(res.status, 'pass', res.output)
  })
})

test('an injected ownership check that fails says why it may be failing; a declared one does not', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await writeFile(path.join(root, 'direct.mjs'), 'x\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'inline work straight on the run branch'])
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const injected = await runOwnershipCheck({ ...OWNERSHIP, injected: true }, ctx)
    assert.equal(injected.status, 'fail')
    assert.match(injected.output, /check injected: the manifest does not declare it; .*\(use --no-fleet\)/)
    const declared = await runOwnershipCheck(OWNERSHIP, ctx)
    assert.equal(declared.status, 'fail')
    assert.doesNotMatch(declared.output, /check injected/)
  })
})

// Review round: authorisation came from every task whose branch carried the secondary parent, and
// a later phase's branch carries every earlier parent. A later task marking the manifest therefore
// authorised an earlier, unmarked task's hand-resolved conflict. Vouching now stops at each branch's
// floor, so only a branch that carries the parent past its own fork point can authorise it.
test('a later task marking the path does not authorise an earlier unmarked task\'s conflict resolution', async () => {
  await withRepo(async (repo) => {
    await protectedConflictRun(repo, { markT2: false })
    await repo.sh(['checkout', '-b', 'fleetmates/r1/T3', 'run'])
    await writeFile(path.join(repo.root, 'c.mjs'), 'export const c = 1\n', 'utf8')
    await repo.sh(['add', 'c.mjs'])
    await repo.sh(['commit', '-m', 'T3 work'])
    await repo.sh(['checkout', 'run'])
    const plan = (await readFile(path.join(repo.root, 'plan.md'), 'utf8'))
      + ['### Task 3: third', '', '**Files:**', `- Modify (protected): \`${MANIFEST_FILE}\``, '- Create: `c.mjs`', '', '**Depends:** T2', ''].join('\n')
    // The plan is read at the anchor, so the amended plan goes onto the base and the base into run.
    await repo.sh(['checkout', 'main'])
    await writeFile(path.join(repo.root, 'plan.md'), plan, 'utf8')
    await repo.sh(['commit', '-am', 'amend plan'])
    await repo.sh(['checkout', 'run'])
    await repo.sh(['merge', '--no-ff', '-m', 'merge base', 'main'])
    const ctx = await deriveContext({ git: repo.git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck(OWNERSHIP, ctx)
    assert.equal(res.status, 'fail', res.output)
    assert.match(res.output, /resolved a conflict on protected fleetmates\.gate\.json/)
  })
})

test('the operator\'s base merge may resolve a conflict on a protected path the base also changed', async () => {
  await withRepo(async ({ root, sh, git }) => {
    const plan = ['### Task 1: first', '', '**Files:**', `- Modify (protected): \`${MANIFEST_FILE}\``, '',
      '### Task 2: second', '', '**Files:**', '- Create: `b.mjs`', '', '**Depends:** T1', ''].join('\n')
    await writeFile(path.join(root, 'plan.md'), plan, 'utf8')
    await writeFile(path.join(root, MANIFEST_FILE), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, MANIFEST_FILE), 'claims lens\n', 'utf8')
    await sh(['commit', '-am', 'T1'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    await sh(['checkout', 'main'])
    await writeFile(path.join(root, MANIFEST_FILE), 'security lens\n', 'utf8')
    await sh(['commit', '-am', 'another run lands a lens'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', 'main']).catch(() => {})
    await writeFile(path.join(root, MANIFEST_FILE), 'claims lens\nsecurity lens\n', 'utf8')
    await sh(['add', MANIFEST_FILE])
    await sh(['commit', '--no-edit'])
    await sh(['checkout', '-b', 'fleetmates/r1/T2'])
    await writeFile(path.join(root, 'b.mjs'), 'b\n', 'utf8')
    await sh(['add', 'b.mjs'])
    await sh(['commit', '-m', 'T2'])
    await sh(['checkout', 'run'])
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck(OWNERSHIP, ctx)
    assert.equal(res.status, 'pass', res.output)
  })
})

// Membership folds case for configured entries too, not only for the lower-case default: a
// configured `Cargo.toml` must match the path git reports.
test('fileset guards a configured protected path that carries upper case', async () => {
  await withRepo(async (repo) => {
    const ctx = await protectedRun(repo, protectedPlan({ mark: true, extra: ['- Create: `Cargo.toml`'] }), async () => {
      await writeFile(path.join(repo.root, 'Cargo.toml'), '[package]\n', 'utf8')
      await repo.sh(['add', 'Cargo.toml'])
    })
    const res = await runFilesetCheck({ ...FILESET, protected: ['fleetmates.gate.json', 'Cargo.toml'] }, ctx)
    assert.equal(res.status, 'fail', res.output)
    assert.match(res.output, /T1: protected — Cargo\.toml/)
  })
})

// The other unverified acceptance: two secondary parents that disagree about a protected file while
// the first parent left it alone. Git refuses such an octopus, so the merge is built with
// `commit-tree`, carrying content of the integrator's own choosing.
test('ownership fails an octopus whose secondary parents disagree on a protected path when no parent marks it', async () => {
  await withRepo(async ({ root, sh, git }) => {
    const plan = ['### Task 1: first', '', '**Files:**', `- Modify: \`${MANIFEST_FILE}\``, '',
      '### Task 2: second', '', '**Files:**', `- Modify: \`${MANIFEST_FILE}\``, '', '**Depends:** T1', ''].join('\n')
    await writeFile(path.join(root, 'plan.md'), plan, 'utf8')
    await writeFile(path.join(root, MANIFEST_FILE), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    for (const [id, content] of [['T1', 'one\n'], ['T2', 'two\n']]) {
      await sh(['checkout', '-b', `fleetmates/r1/${id}`, 'run'])
      await writeFile(path.join(root, MANIFEST_FILE), content, 'utf8')
      await sh(['commit', '-am', id])
    }
    await sh(['checkout', 'run'])
    await writeFile(path.join(root, MANIFEST_FILE), 'integrator choice\n', 'utf8')
    await sh(['add', MANIFEST_FILE])
    const tree = (await sh(['write-tree'])).stdout.trim()
    const merge = (await sh(['commit-tree', tree, '-p', 'run', '-p', 'fleetmates/r1/T1', '-p', 'fleetmates/r1/T2', '-m', 'octopus'])).stdout.trim()
    await sh(['update-ref', 'refs/heads/run', merge])
    await sh(['reset', '--hard', 'run'])
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck(OWNERSHIP, ctx)
    assert.equal(res.status, 'fail', res.output)
    assert.match(res.output, /resolved a conflict on protected fleetmates\.gate\.json/)
  })
})
