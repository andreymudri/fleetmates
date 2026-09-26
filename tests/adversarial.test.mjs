// Pins the boundary between what the gate defends and what it does not, both with real
// git repositories. No fake git anywhere in this file: every bug this suite regression-tests
// was invisible to a fake with canned changedFiles, and several of them shipped precisely
// because a fake agreed with the implementation. See:
//   docs/specs/2026-08-05-tamper-evident-enforcement-design.md ("Not defended against")
//   docs/plans/2026-08-05-tamper-evident-enforcement.md (Task 4)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, lstat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCli } from '../scripts/cli.mjs'

const PLAN = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Create: \`b.mjs\`

**Depends:** T1
`

// The default phase runs only the two enforcement checks — command checks are irrelevant
// to what this file pins and would only make failures harder to attribute.
const MANIFEST = {
  phases: {
    default: {
      checks: [
        { name: 'fileset', kind: 'fileset' },
        { name: 'ownership', kind: 'ownership' },
      ],
    },
  },
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// Builds a real repository: `main` carries a committed plan.md, package.json, an
// enforcement-only fleetmates.gate.json, and a .gitignore excluding .fleetmates/ — without
// that last piece, `ownership`'s dirty-worktree check sees init-run's own state files as
// untracked and fails every test for a reason unrelated to what each test means to pin.
// The repo is left checked out on `run-branch`, off `main`.
async function withRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-adv-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  await writeFile(path.join(root, 'plan.md'), PLAN, 'utf8')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify(MANIFEST), 'utf8')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n', 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'initial'])
  git(root, ['checkout', '--quiet', '-b', 'run-branch'])
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runCliOn(root, args) {
  const lines = []
  const io = { out: (t) => lines.push(t) }
  const code = await runCli([...args, '--root', root], io)
  return { code, out: lines.join('\n') }
}

// Creates fleetmates/<runId>/<taskId>, writes and commits the given files, and returns to
// run-branch. `from` defaults to run-branch's current tip (the anchor, for a fresh repo).
async function taskBranch(root, runId, taskId, { from = 'run-branch', files = {} } = {}) {
  const branch = `fleetmates/${runId}/${taskId}`
  git(root, ['checkout', '--quiet', '-b', branch, from])
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(root, rel), content, 'utf8')
  }
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', `${taskId}: work`])
  git(root, ['checkout', '--quiet', 'run-branch'])
  return branch
}

async function readStatus(root, runId) {
  return JSON.parse(await readFile(path.join(root, '.fleetmates', runId, 'status.json'), 'utf8'))
}

// ============================================================================================
// Step 2 — attacks that ARE defended. Each asserts the gate FAILs.
// ============================================================================================

test('gate fails when a teammate commits a file outside its declared set', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'export default 1\n', 'stray.mjs': 'export default 2\n' } })
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /stray\.mjs/)
  })
})

test('gate fails and names the pre-image when a teammate renames away a file belonging to another task', async () => {
  await withRepo(async (root) => {
    // T1 lands a.mjs and is integrated first — the real workflow order.
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    // T2 forks after that merge, so a.mjs is present in its history, then renames it away
    // instead of adding its own declared b.mjs.
    git(root, ['checkout', '--quiet', '-b', 'fleetmates/r1/T2', 'run-branch'])
    git(root, ['mv', 'a.mjs', 'b.mjs'])
    git(root, ['commit', '--quiet', '-m', 'T2: rename instead of adding my own file'])
    git(root, ['checkout', '--quiet', 'run-branch'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    // --no-renames means git reports both the deletion of a.mjs (the pre-image, which
    // belongs to T1) and the addition of b.mjs — the deletion must show up as a violation
    // of T2's declared set.
    assert.match(out, /a\.mjs/)
  })
})

test('gate fails even when a tag shadows the task branch name', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n', 'stray.mjs': 'y\n' } })
    // Plant a tag with the exact branch name, pointing at a clean commit. Every ref this
    // codebase resolves is fully qualified through refs/heads/, so the tag cannot stand in
    // for the branch — the stray file must still be seen.
    git(root, ['tag', 'fleetmates/r1/T1', 'main'])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /stray\.mjs/)
  })
})

test('gate fails on a merge commit that introduces its own content: a new file, a tampered file, and a deletion', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'A1\n' } })
    git(root, ['checkout', '--quiet', '-b', 'fleetmates/r1/T2', 'main'])
    await writeFile(path.join(root, 'b.mjs'), 'B1\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'T2: b.mjs'])
    git(root, ['checkout', '--quiet', 'run-branch'])

    // An octopus merge of both task branches, then hand-tampered before completing:
    // a.mjs gets different bytes than T1 committed, rogue.mjs has no source in any parent,
    // and b.mjs — which T2's own parent introduced — is deleted.
    git(root, ['merge', '--quiet', '--no-ff', '--no-commit', 'fleetmates/r1/T1', 'fleetmates/r1/T2'])
    await writeFile(path.join(root, 'a.mjs'), 'TAMPERED\n', 'utf8')
    await writeFile(path.join(root, 'rogue.mjs'), 'no legitimate source\n', 'utf8')
    git(root, ['rm', '--quiet', '-f', 'b.mjs'])
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'merge T1 and T2 with smuggled content'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /reachable from no task branch/)
  })
})

test('gate fails naming --no-ff when a teammate commits directly to the run branch', async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, 'sneaky.mjs'), 'x\n', 'utf8')
    git(root, ['add', 'sneaky.mjs'])
    git(root, ['commit', '--quiet', '-m', 'direct write to the run branch'])
    const sha = git(root, ['rev-parse', 'HEAD']).trim()

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /--no-ff/)
    assert.match(out, new RegExp(sha))
  })
})

test('a forged status.json PASS changes neither the gate verdict nor complete', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    const statusPath = path.join(root, '.fleetmates', 'r1', 'status.json')
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    status.gates = { 1: { verdict: 'PASS', failed: [], skipped: [], pending: [], recordedAt: Date.now() } }
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')

    // No task branches exist, so the recomputed gate fails naming T1's missing branch —
    // the forged PASS buys nothing because neither command ever reads status.gates.
    //
    // The two commands report that in their own vocabularies: `gate` exits 1 for a FAIL verdict,
    // and `complete` exits 3, its one code meaning the recomputed checks REJECTED this task. 3
    // rather than the 4 it used to return because 4 also covers four cannot-verify situations,
    // and the stop-time hook has to be able to tell a rejection from a run it cannot verify.
    const gateResult = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(gateResult.code, 1)
    assert.equal(JSON.parse(gateResult.out).verdict, 'FAIL')

    const completeResult = await runCliOn(root, ['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md'])
    assert.equal(completeResult.code, 3)
  })
})

test('gate still fails correctly when .fleetmates/plan.json is deleted', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await rm(path.join(root, '.fleetmates', 'r1', 'plan.json'))
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    // The gate never reads .fleetmates/plan.json — everything comes from git — so deleting
    // it changes nothing about the verdict: it still fails on the missing T1 branch.
    assert.equal(code, 1)
    assert.match(out, /T1/)
  })
})

test('gate still fails correctly when .fleetmates/ is deleted entirely', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await rm(path.join(root, '.fleetmates'), { recursive: true, force: true })
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /T1/)
  })
})

test('gate fails on a widened working-tree plan edit because the plan is read from the anchor commit', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n', 'stray.mjs': 'y\n' } })
    // Widen T1's declared file set in the working tree only — never committed.
    const widened = PLAN.replace('- Create: `a.mjs`', '- Create: `a.mjs`\n- Create: `stray.mjs`')
    await writeFile(path.join(root, 'plan.md'), widened, 'utf8')

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /stray\.mjs/)
  })
})

test('gate fails with the phase error, not a silent skip, when phases integrate out of order', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T2 out of order', 'fleetmates/r1/T2'])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /not integrated but a later phase is/)
  })
})

test('a manifest marking fileset/ownership optional: true still fails the gate', async () => {
  await withRepo(async (root) => {
    await writeFile(
      path.join(root, 'fleetmates.gate.json'),
      JSON.stringify({
        phases: {
          default: {
            checks: [
              { name: 'fileset', kind: 'fileset', optional: true },
              { name: 'ownership', kind: 'ownership', optional: true },
            ],
          },
        },
      }),
      'utf8',
    )
    // No branches exist; fileset fails on T1's missing branch. ALWAYS_ENFORCED_KINDS in
    // gate-runner.mjs forces optional back to false for fileset/ownership regardless of
    // what the manifest declares, so the gate still fails rather than shipping anyway.
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.equal(JSON.parse(out).verdict, 'FAIL')
  })
})

test('gate fails and marks the check pending for a manifest with kind "toString"', async () => {
  await withRepo(async (root) => {
    await writeFile(
      path.join(root, 'fleetmates.gate.json'),
      JSON.stringify({ phases: { default: { checks: [{ name: 'evil', kind: 'toString' }] } } }),
      'utf8',
    )
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    const check = parsed.results.find((r) => r.name === 'evil')
    assert.equal(check.status, 'pending')
  })
})

test('fast-forwarding the run branch to an empty commit does not read its phase as integrated', async () => {
  await withRepo(async (root) => {
    git(root, ['checkout', '--quiet', '-b', 'fleetmates/r1/T1'])
    git(root, ['commit', '--quiet', '--allow-empty', '-m', 'T1: no-op'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--ff-only', 'fleetmates/r1/T1'])

    const { out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    const parsed = JSON.parse(out)
    // T1's branch is now an ancestor of the run branch via the fast-forward, but it
    // changed zero files. deriveContext requires at least one changed file before a phase
    // counts as integrated, so phase 1 must still read as open (never null or 2).
    assert.equal(parsed.phase, 1)
  })
})

test('gate reports the ambiguity, not a silent guess, when both main and master exist', async () => {
  await withRepo(async (root) => {
    git(root, ['branch', 'master', 'main'])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /ambiguous base branch/)
  })
})

// Was pinned in the "NOT defended" section below, as one half of a self-integration bullet that
// covered two different shapes. This half is now defended: `deriveContext` measures every task
// branch against its OWN fork point, so a ref parked at a run tip that already carries someone
// else's work shows no work of its own, its phase does not read as integrated, and the fileset
// check actually runs against it instead of being skipped by the "every phase is integrated"
// fast path. The other half — a teammate doing real work and merging it itself — is still open
// and still pinned below.
//
// T1 is merged --no-ff rather than fast-forwarded (which is what the old fixture did) so that
// phase 1 is genuinely integrated and phase 2 is the phase under test. A fast-forwarded T1 now
// reads as no work itself, so the check would fail on T1 and never reach T2 — that is the
// fast-forward limit, pinned separately in tests/gate-runner.test.mjs, not this shape.
test('gate fails when a task ref is parked at a run tip carrying another task\'s work', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])
    // T2's branch is created pointing at the run tip, which already carries T1's real work,
    // and never moves. Diffed against the run anchor it showed a.mjs and got credit for work
    // it never did; diffed against its own fork point it shows nothing.
    git(root, ['branch', 'fleetmates/r1/T2', 'run-branch'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    assert.equal(parsed.phase, 2)
    const fileset = parsed.results.find((r) => r.name === 'fileset')
    assert.match(fileset.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
  })
})

// A plan with two phase-2 siblings (T2, T3 each depend only on T1 and touch disjoint files, so
// `assignPhases` places both in phase 2).
const SIBLING_TIP_PLAN = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Create: \`b.mjs\`

**Depends:** T1

### Task 3: C

**Files:**
- Create: \`c.mjs\`

**Depends:** T1
`

// `gate` reads the plan at the run anchor (mergeBase of main and run-branch), not from the
// working tree — pinned above by 'gate fails on a widened working-tree plan edit'. To make a
// custom plan reach the anchor, it must be committed to `main` before `run-branch` diverges,
// so it is committed there and fast-forwarded onto `run-branch`, which has not diverged yet.
function commitPlanAtAnchor(root, planMarkdown) {
  git(root, ['checkout', '--quiet', 'main'])
  return writeFile(path.join(root, 'plan.md'), planMarkdown, 'utf8').then(() => {
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'plan: amend for this test'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', 'main'])
  })
}

// Was recorded only as prose, in the spec's "Not defended against" list and in
// `deriveContext`'s own comment (scripts/gate-runner.mjs): T3 commits `c.mjs` and is merged
// `--no-ff`; T2 never commits anything of its own, and its ref is pointed directly at T3's tip
// instead. T2's sha is a genuine secondary parent of the merge and genuinely inside
// anchor..run, so the old empty-diff test (which asks only "is this sha a merged tip") passed
// it, and the old `ownWorkBase` fork-point trick credited T2 with `c.mjs` in `deriveContext`
// too, reading phase 2 as fully integrated and skipping the fileset check entirely.
//
// Closed, round 4 (see the comment above `mergedParentFiles` in scripts/gate-runner.mjs for the
// three earlier designs and why each of them broke something real): `deriveContext` no longer
// special-cases the shared sha at all. It asks, per task, whether the merge that landed a sha
// carried THAT task's declared files. The merge that landed T3's tip carried `c.mjs`, T3's own
// file — never T2's `b.mjs` — so T2 reads not-integrated and the ordinary `currentPhase`
// machinery reaches phase 2, where `runFilesetCheck`'s own empty-diff test (same predicate,
// same shared index) reports T2's self-contained, accurate failure.
//
// This is the DISJOINT case only: T2's declared file (`b.mjs`) never intersects what the merge
// landing T3's tip carried (`c.mjs`). The predicate needs exactly that non-intersection to work
// — `scripts/phases.mjs` guarantees it within one phase, T2 and T3 here included, but not
// across phases. The SAME sibling-tip shape with an OVERLAPPING declared set remains open; see
// 'LIMIT (sibling-tip, overlapping declared set)' below.
test('gate fails when a task ref is parked at a merged SIBLING\'s tip', async () => {
  await withRepo(async (root) => {
    await commitPlanAtAnchor(root, SIBLING_TIP_PLAN)

    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    const t3Branch = await taskBranch(root, 'r1', 'T3', { files: { 'c.mjs': 'x\n' } })
    const t3Tip = git(root, ['rev-parse', t3Branch]).trim()
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T3', t3Branch])

    // T2 never commits: its ref is pointed straight at T3's own tip commit, not at the merge
    // commit that carried it.
    git(root, ['branch', 'fleetmates/r1/T2', t3Tip])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    // Phase 1 genuinely integrated, phase 2 is not (T2's own declared file never landed), so
    // `currentPhase` reaches the unremarkable 2 — not the early, dedicated phaseError shape
    // (`phase: null`) two earlier designs produced.
    assert.equal(parsed.phase, 2)
    const fileset = parsed.results.find((r) => r.name === 'fileset')
    assert.match(fileset.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes past its fork point/)
    assert.match(fileset.output, new RegExp(t3Tip))
    assert.doesNotMatch(fileset.output, /T3:/)
  })
})

// The medium every earlier design left open (fix round 4's specific charge): T2 is parked on
// T3's tip exactly as above, but T3 then does a SECOND round of real work — a fix-round commit
// that moves T3's OWN ref forward, off the shared sha. Every earlier design keyed on two refs
// sharing something RIGHT NOW (entry counts, membership sets, run-tip comparisons), so once only
// ONE ref still pointed at the shared sha, none of those checks had anything left to compare —
// T2 would have silently passed. `landedForFiles` reads only the merge that already landed T3's
// FIRST round, which still only ever carried `c.mjs`; it does not care where T3's ref currently
// sits, so T2 still fails the same way.
test('gate still fails a parked ref after the sibling it parked on makes a further fix-round commit', async () => {
  await withRepo(async (root) => {
    await commitPlanAtAnchor(root, SIBLING_TIP_PLAN)

    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    const t3Branch = await taskBranch(root, 'r1', 'T3', { files: { 'c.mjs': 'x\n' } })
    const t3FirstTip = git(root, ['rev-parse', t3Branch]).trim()
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T3', t3Branch])

    // T2 parks on T3's FIRST-round tip — never moves again.
    git(root, ['branch', 'fleetmates/r1/T2', t3FirstTip])

    // T3's fix round: a further commit on T3's OWN branch, moving T3's ref off the shared sha.
    // (Not re-merged — this pins the shape as it stands mid-round, before any further gate.)
    git(root, ['checkout', '--quiet', t3Branch])
    await writeFile(path.join(root, 'c.mjs'), 'x2\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'T3: fix-round commit'])
    git(root, ['checkout', '--quiet', 'run-branch'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    const fileset = parsed.results.find((r) => r.name === 'fileset')
    assert.match(fileset.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
  })
})

// The pre-merge half of the SIBLING'S-tip shape. `landedForFiles` gates on
// `mergedParentFiles` membership, and nothing not-yet-integrated can be a member of that
// index — so T2's ref, pointed at T3's own STILL-UNMERGED commit, does NOT trip it. T2's diff
// off the run tip is T3's real, non-empty `c.mjs`, so the ordinary declared-set violation
// catches it instead (T2 only declared `b.mjs`) — the same predicate decides both shapes, so
// the split between them is what the merge actually carried, not a separate rule.
test('gate catches a ref parked at an unmerged sibling\'s tip via the declared-set violation, not the empty-diff test', async () => {
  await withRepo(async (root) => {
    await commitPlanAtAnchor(root, SIBLING_TIP_PLAN)

    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    // T3 commits but is NOT yet merged.
    const t3Branch = await taskBranch(root, 'r1', 'T3', { files: { 'c.mjs': 'x\n' } })
    const t3Tip = git(root, ['rev-parse', t3Branch]).trim()

    // T2 never commits: its ref is pointed straight at T3's own (still unmerged) tip.
    git(root, ['branch', 'fleetmates/r1/T2', t3Tip])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    assert.equal(parsed.phase, 2)
    const fileset = parsed.results.find((r) => r.name === 'fileset')
    assert.match(fileset.output, /T2: outside declared set — c\.mjs/)
    assert.doesNotMatch(fileset.output, /parked at another's tip/)
    assert.doesNotMatch(fileset.output, /merged sibling's tip/)
  })
})

// Fix-round finding A: the ordinary, benign state every fleet passes through between
// `git checkout -B <task> <run branch>` and its first commit — a phase's siblings freshly
// created together, nothing committed yet. An earlier version of the duplicate rule had no
// run-tip exclusion and reported every one of them as "parked at" the others; the true,
// actionable cause is that none of them has done any work yet.
test('gate does not treat freshly-dispatched siblings sharing the run tip as parked on each other', async () => {
  await withRepo(async (root) => {
    await commitPlanAtAnchor(root, SIBLING_TIP_PLAN)

    const runTip = git(root, ['rev-parse', 'run-branch']).trim()
    git(root, ['branch', 'fleetmates/r1/T1', runTip])
    git(root, ['branch', 'fleetmates/r1/T2', runTip])
    git(root, ['branch', 'fleetmates/r1/T3', runTip])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    assert.equal(parsed.phase, 1)
    const fileset = parsed.results.find((r) => r.name === 'fileset')
    assert.match(fileset.output, /T1: branch fleetmates\/r1\/T1 contributes no file changes/)
    assert.doesNotMatch(fileset.output, /parked at another's tip/)
  })
})

// Fix-round finding 1 (security HIGH): T2 and T3 (phase 2) are dispatched together and never
// commit — the ordinary, benign state, sharing the run tip exactly as the previous test does.
// Unlike the previous test, something ELSE then lands on the run branch: a plan amendment
// merging the base in, this repository's own documented amendment procedure
// (skills/parallel-execution/SKILL.md). That moves the run tip past T2 and T3 without either of
// them doing anything at all, so their shared sha is no longer the run tip. Two earlier designs
// broke on this exact shape — a "not the run tip" discriminator, and, separately, a
// `git.mergedBranchTips`-membership discriminator, since the amendment merge's secondary parent
// IS the old run tip. `landedForFiles` does not classify the shared sha at all: it asks whether
// the amendment merge's OWN diff (against its own first parent) carries either idle task's
// declared file, and an amendment merge that only ever touched `amend.txt` never does.
test('gate does not treat two idle siblings as parked when an unrelated commit moves the run tip past them', async () => {
  await withRepo(async (root) => {
    await commitPlanAtAnchor(root, SIBLING_TIP_PLAN)

    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    // T2 and T3 (phase 2) are created at the run tip, right after T1's merge, and never commit.
    const runTip = git(root, ['rev-parse', 'run-branch']).trim()
    git(root, ['branch', 'fleetmates/r1/T2', runTip])
    git(root, ['branch', 'fleetmates/r1/T3', runTip])

    // The plan-amendment procedure: the base advances and the run branch merges it in. This is
    // unrelated to T2 and T3 — neither teammate did anything — but it moves the run tip past
    // the sha they share.
    git(root, ['checkout', '--quiet', 'main'])
    await writeFile(path.join(root, 'amend.txt'), 'amended\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'amend the plan'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'merge: plan amendment', 'main'])

    assert.notEqual(git(root, ['rev-parse', 'run-branch']).trim(), runTip, 'fixture: the run tip must have moved past T2 and T3')

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    assert.equal(parsed.phase, 2)
    const fileset = parsed.results.find((r) => r.name === 'fileset')
    assert.match(fileset.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
    assert.match(fileset.output, /T3: branch fleetmates\/r1\/T3 contributes no file changes/)
    assert.doesNotMatch(fileset.output, /parked at another's tip/)
    assert.doesNotMatch(fileset.output, /cannot be phase-gated until it is fixed/)
  })
})

// Fix-round finding 1 (correctness HIGH): the executed repro from the finding, byte for byte.
// T2's declared file is `a.mjs` — the SAME file T1 created — because that exact collision is
// what the whole-range walk this test replaced got wrong: it attributed a merge's ENTIRE
// first-parent diff to every one of its secondary parents, so T3's sync merge (which pulls in
// T1's `a.mjs` while adding its own `c.mjs`) credited the post-T1 run tip with `{a.mjs}` too —
// and T2, parked there and declaring `a.mjs`, read landed with nothing written. An earlier
// version of this test used a declared file (`b.mjs`) that never collided with what the sync
// carried, so it passed even against the bug it meant to pin; this version does not.
//
// T3 forks EARLY (before T1 lands) so its own `git merge --no-ff run-branch`, made on T3's own
// branch to pick up T1's interface, is a genuine non-fast-forward merge naming the post-T1 tip
// as a secondary parent — not a merge `tm-integrator` ever ran. The fix walks only the run
// branch's own first-parent chain: the post-T1 tip is the FIRST parent of the integrator's own
// merge of T3, never a secondary parent of anything on that chain, so it is not indexed at all.
test('gate does not credit an idle ref parked on a run tip that only a sibling\'s own sync merge later named', async () => {
  await withRepo(async (root) => {
    const overlapPlan = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Modify: \`a.mjs\`

**Depends:** T1

### Task 3: C

**Files:**
- Create: \`c.mjs\`

**Depends:** T1
`
    await commitPlanAtAnchor(root, overlapPlan)
    await writeFile(path.join(root, 'a.mjs'), 'seed\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'seed a.mjs'])

    // T3 forks BEFORE T1 lands, so its own sync merge with run-branch (after T1 merges) is a
    // genuine, non-fast-forward merge rather than a no-op.
    git(root, ['checkout', '--quiet', '-b', 'fleetmates/r1/T3'])
    await writeFile(path.join(root, 'c.mjs'), 'x\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'T3: work'])
    git(root, ['checkout', '--quiet', 'run-branch'])

    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    // T2 (phase 2, idle) is dispatched right after T1 merges, and never commits.
    git(root, ['branch', 'fleetmates/r1/T2', 'run-branch'])

    // T3's own sync, picking up T1's interface: names the post-T1 tip as a secondary parent of
    // this commit, which is NOT a merge `tm-integrator` ever ran.
    git(root, ['checkout', '--quiet', 'fleetmates/r1/T3'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'T3: sync with run-branch', 'run-branch'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T3', 'fleetmates/r1/T3'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    const fileset = parsed.results.find((r) => r.name === 'fileset')
    assert.match(fileset.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
    assert.doesNotMatch(fileset.output, /parked at another's tip/)
    assert.doesNotMatch(fileset.output, /cannot be phase-gated until it is fixed/)
  })
})

// Fix-round finding B1, closed by round 4's per-task predicate rather than a run-wide
// discriminator: a phase-3 teammate points its ref at an EARLIER, already-integrated phase's
// own merged tip. Two earlier designs (a silent, run-wide shared-sha exclusion; a dedicated
// phaseError gated on shared-sha membership) both had to reason about T1 and T3 TOGETHER
// because they classified the SHA, and both accidentally stripped T1's own genuine credit or
// produced a message naming both tasks as if symmetric. The declared-files predicate needs no
// such cross-task reasoning: T1's own check asks whether the merge that landed its sha carried
// T1's file (`a.mjs` — yes), and T3's own, unrelated check asks the same question of T3's file
// (`c.mjs` — no, that merge only ever carried `a.mjs`). Phase 1 and phase 2 stay cleanly
// integrated; only phase 3, the one that is actually not done, fails — with an accurate,
// self-contained message, never the generic ordering error.
test('gate does not let a later phase\'s parked ref strip an earlier phase\'s genuine integration credit', async () => {
  await withRepo(async (root) => {
    const threePhasePlan = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Create: \`b.mjs\`

**Depends:** T1

### Task 3: C

**Files:**
- Create: \`c.mjs\`

**Depends:** T2
`
    await commitPlanAtAnchor(root, threePhasePlan)

    const t1Branch = await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    const t1Tip = git(root, ['rev-parse', t1Branch]).trim()
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', t1Branch])
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T2', 'fleetmates/r1/T2'])

    // T3 (phase 3) never commits: its ref is pointed at T1's own merged tip — a fixed
    // ancestor now that T2's merge has moved the run tip past it.
    git(root, ['branch', 'fleetmates/r1/T3', t1Tip])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    // Phases 1 and 2 are both genuinely integrated, so `derivePhase` reaches phase 3 as the
    // current phase — never the generic "phase N is not integrated but a later phase is"
    // ordering error, which would mean phase 1's real integration went unrecognized.
    assert.equal(parsed.phase, 3)
    const fileset = parsed.results.find((r) => r.name === 'fileset')
    assert.doesNotMatch(fileset.output, /refusing to guess which phase to enforce/)
    assert.match(fileset.output, /T3: branch fleetmates\/r1\/T3 contributes no file changes past its fork point/)
    assert.match(fileset.output, new RegExp(t1Tip))
    assert.doesNotMatch(fileset.output, /T1:/)
  })
})

// A plan with T3 as T2's only phase-2 sibling (both depend only on T1).
const NEAR_SIBLING_PLAN = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Create: \`b.mjs\`

**Depends:** T1

### Task 3: C

**Files:**
- Create: \`c.mjs\`

**Depends:** T1
`

// The near-sibling shape: a distinct sha one empty commit above a merged sibling's tip. Every
// design before round 4 classified shas (shared-by-anyone, not-the-run-tip, a member of
// `git.mergedBranchTips`), and this shape defeated all of them the same way — a commit that is
// itself merged under its OWN name is a genuine, distinct member of whatever sha-level set was
// being checked, so it read as landed regardless of what it actually contained.
//
// Round 4's declared-files predicate closes it, not by design intent but as a consequence of
// asking a stricter question: `landedForFiles` requires the merge's own diff to intersect the
// task's declared files, and T2's merge — bringing in a branch that is byte-identical to
// content already on the run branch — has an EMPTY diff against its own first parent. An empty
// set can never intersect a non-empty declared set, so T2 fails the same way any other
// contribution-free branch does. Confirmed by executing this exact construction; not asserted
// from the design alone.
test('gate fails a ref built one empty commit above a merged sibling\'s tip, even merged under its own name', async () => {
  await withRepo(async (root) => {
    await commitPlanAtAnchor(root, NEAR_SIBLING_PLAN)

    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])

    const t3Branch = await taskBranch(root, 'r1', 'T3', { files: { 'c.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T3', t3Branch])

    // T2 branches from T3's tip and adds one empty commit — a distinct sha, not T3's own —
    // then that branch is merged under T2's own name, exactly as a genuine contribution would
    // be.
    git(root, ['checkout', '--quiet', '-b', 'fleetmates/r1/T2', t3Branch])
    git(root, ['commit', '--quiet', '--allow-empty', '-m', 'T2: empty, contributes nothing'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T2', 'fleetmates/r1/T2'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    const fileset = parsed.results.find((r) => r.name === 'fileset')
    assert.match(fileset.output, /T2: branch fleetmates\/r1\/T2 contributes no file changes/)
    assert.doesNotMatch(fileset.output, /T3:/)
  })
})

// ============================================================================================
// Step 3 — limits that are NOT defended. Each asserts the CURRENT behavior (usually a PASS),
// with a comment naming the limitation and pointing at the spec's "Not defended against" list.
// This is deliberate: an untested limitation drifts into an implied guarantee, which is the
// exact defect that started this work.
// ============================================================================================

test('LIMIT (self-integration): a teammate that does real work and merges its own branches reads as integrated', async () => {
  await withRepo(async (root) => {
    // Spec: "Self-integration ... a teammate creates its own task branches, does real work on
    // each, and merges them itself, bypassing tm-integrator." Out of scope by design:
    // enforcement does not stop a teammate targeting it, and running a teammate's code is
    // arbitrary execution. Every branch here carries its own work against its own fork point,
    // so nothing at this level distinguishes it from legitimate integration — the difference
    // is WHO ran the merge, which git does not record in a way this check can trust.
    //
    // The parked-branch variant this bullet used to be conflated with is now DEFENDED; see
    // 'gate fails when a task ref is parked at a run tip carrying another task's work' above.
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', 'fleetmates/r1/T1'])
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'y\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T2', 'fleetmates/r1/T2'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 0)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'PASS')
    // Both phases read as integrated, so this is the "every phase in the plan is integrated"
    // verdict — the teammate's own merges were accepted as integration, which is the point of
    // the limitation. Asserted after observing the run, not written from expectation.
    assert.equal(parsed.phase, null)
  })
})

// LIMIT (sibling-tip, overlapping declared set): the sibling-tip test above
// ('gate fails when a task ref is parked at a merged SIBLING's tip') pins the DISJOINT case —
// T2's declared file never intersects what the merge that landed T3's tip carried, so
// `landedForFiles` correctly reads false. `scripts/phases.mjs` guarantees that disjointness
// only WITHIN one phase; across phases a later task routinely modifies a file an earlier task
// created, and `landedForFiles` grants landed on ANY intersection with what the integrating
// merge carried, with no way to tell a genuine contributor from a parked ref reusing the same,
// real intersection. Executed: T1 creates `a.mjs` and is merged; T2 declares `Modify: a.mjs,
// Create: b.mjs`, writes nothing, and its ref is pointed at T1's own merged tip. Verdict PASS;
// `b.mjs` never exists. Recorded in the spec's "Not defended against" list as sibling-tip
// self-integration.
test('LIMIT (sibling-tip, overlapping declared set): a parked ref whose declared set intersects what the sibling\'s merge carried reads as landed', async () => {
  await withRepo(async (root) => {
    const overlapPlan = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Modify: \`a.mjs\`
- Create: \`b.mjs\`

**Depends:** T1
`
    await commitPlanAtAnchor(root, overlapPlan)

    const t1Branch = await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    const t1Tip = git(root, ['rev-parse', t1Branch]).trim()
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', t1Branch])

    // T2 never commits: its ref is pointed straight at T1's own merged tip. T2's declared set
    // (`a.mjs`, `b.mjs`) intersects `a.mjs` — what the merge that landed T1 actually carried.
    git(root, ['branch', 'fleetmates/r1/T2', t1Tip])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 0)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'PASS')
    assert.equal(parsed.phase, null)
  })
})

// WAS a recorded LIMIT: contentAt compared bytes and never mode, so an integrator could flip a
// file's permission bits beyond what the honest task branch committed and the merge still read
// as clean. contentAt now pairs each blob with its tree mode, which closes it — a mode the
// merge commit carries and no parent contributed is content with no legitimate source, exactly
// like a fabricated byte. The same change also stopped a legitimate chmod from reading as
// "no parent touched this file", which is what surfaced the gap; see the mode-change test in
// tests/gate-runner.test.mjs for that direction.
//
// `update-index --chmod` writes the bit into the index without touching the file on disk.
// Where git honours filemode — POSIX, not Windows — the working tree then differs from HEAD,
// and the next `checkout -b <branch> main` is refused as an overwrite of local changes, so the
// test failed on Linux and macOS while passing there. Turning filemode off for this repository
// makes the platforms agree, and costs the test nothing: the bit still reaches the commit.
test('a merge that flips a file\'s executable bit beyond its task branch is caught by ownership', async () => {
  await withRepo(async (root) => {
    git(root, ['config', 'core.fileMode', 'false'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '--no-commit', 'fleetmates/r1/T1'])
    git(root, ['update-index', '--chmod=+x', 'a.mjs'])
    git(root, ['commit', '--quiet', '-m', 'integrate T1 (tampered mode bit)'])

    await taskBranch(root, 'r1', 'T2', { from: 'main', files: { 'b.mjs': 'y\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T2', 'fleetmates/r1/T2'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /reachable from no task branch/)
  })
})

test('LIMIT (uncommitted work): an out-of-set file left uncommitted in a teammate worktree is invisible', async () => {
  await withRepo(async (root) => {
    // Spec: "Uncommitted work. The gate reads commits. The claim is precisely 'committed
    // changes stayed in the declared set'." A teammate's worktree is separate from the
    // main checkout the gate runs from, so an uncommitted stray file there never reaches
    // either the fileset diff or the main worktree's dirty check.
    const wtPath = path.join(path.dirname(root), `${path.basename(root)}-t1`)
    git(root, ['worktree', 'add', '--quiet', '-b', 'fleetmates/r1/T1', wtPath, 'main'])
    try {
      await writeFile(path.join(wtPath, 'a.mjs'), 'x\n', 'utf8')
      git(wtPath, ['add', 'a.mjs'])
      git(wtPath, ['commit', '--quiet', '-m', 'T1: a.mjs'])
      await writeFile(path.join(wtPath, 'stray.mjs'), 'sneaky, never committed\n', 'utf8')

      const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
      assert.equal(code, 0)
      assert.equal(JSON.parse(out).verdict, 'PASS')
    } finally {
      await rm(wtPath, { recursive: true, force: true })
    }
  })
})

test('LIMIT (forged digest): a forged status.tasks[].state is reported as-is because status.json is a report, not evidence', async () => {
  await withRepo(async (root) => {
    // Spec: "A teammate that forges run state. .fleetmates/ is writable. Nothing reads it
    // for a verdict, so this buys little — but the digest and supervision output can be
    // made to lie."
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    const statusPath = path.join(root, '.fleetmates', 'r1', 'status.json')
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    status.tasks.find((t) => t.id === 'T1').state = 'done'
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')

    const { code, out } = await runCliOn(root, ['digest', '--run', 'r1'])
    assert.equal(code, 0)
    // No branch for T1 exists and no gate ever ran; the digest still shows T1 as done
    // because it renders whatever status.json says, unverified.
    assert.match(out, /A ✓/)
  })
})

// ============================================================================================
// Step 4 — non-attack tests: a compliant run behaves as intended.
// ============================================================================================

test('a compliant run passes the gate and complete marks the task done', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })

    const gateResult = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(gateResult.code, 0)
    assert.equal(JSON.parse(gateResult.out).verdict, 'PASS')

    const completeResult = await runCliOn(root, ['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md'])
    assert.equal(completeResult.code, 0)
    assert.match(completeResult.out, /T1 done/)
    const status = await readStatus(root, 'r1')
    assert.equal(status.tasks.find((t) => t.id === 'T1').state, 'done')
  })
})

// ============================================================================================
// Step 5 — the fix loop's trust boundary.
//
// What the two tests immediately below pin: the fix-round budget is bookkeeping that lives in
// `.fleetmates/status.json`, and `.fleetmates/` is writable by exactly the agents the gate
// enforces. So the budget bounds the loop against DRIFT AND MISTAKES — a check that stays red
// because the retry did not help, an operator who re-runs `fix` after a crash, a phase that
// would otherwise ping-pong forever — and against nothing else. What they do NOT pin, because
// it is not true: that the budget survives a teammate aiming at it. A teammate that rewrites
// its own round counter downward gets more retries (pinned below), and that is the accepted
// cost, because the thing a retry cannot buy is a verdict: `gate`'s ENFORCEMENT CHECKS read no
// file out of `.fleetmates/` at all, so every verdict is recomputed from git on every round.
//
// Stated at that precision on purpose, matching skills/phase-gate/SKILL.md. The gate *command*
// does touch `.fleetmates/`: after the verdict is computed, `cli.mjs` calls
// `readState(root, runId, 'status')` to write the record back, and `readState` rethrows
// anything that is not ENOENT — a `status.json` containing `{ not json` makes `gate` throw a
// SyntaxError rather than return an exit code. That is a fail-closed crash, not a hole, and it
// happens strictly after the verdict exists; `.fleetmates/` is a report sink, never an input.
// The budget protects tokens; git protects correctness. See scripts/state.mjs
// (`readFixRounds`) and the spec's "Not defended against" list.
// ============================================================================================

test('the round counter is not an input to the verdict: the gate output is identical with five rounds recorded and with the counter wiped', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    const statusPath = path.join(root, '.fleetmates', 'r1', 'status.json')

    // Spend five rounds through the real writer. Asserting the counter actually reads 5 is
    // load-bearing, not decoration: a fresh init-run status carries no `fixRounds` at all, so
    // without this the "recorded then wiped" setup would be byte-identical to "never recorded"
    // and the test would survive `recordFixRound` being neutered outright.
    for (let i = 0; i < 5; i += 1) {
      const recorded = await runCliOn(root, ['record-fix-round', '--run', 'r1', '--phase', '1', '--task', 'T1'])
      assert.equal(recorded.code, 0)
    }
    assert.deepEqual(JSON.parse(await readFile(statusPath, 'utf8')).fixRounds, { 1: { T1: 5 } })

    // No task branches exist, so the gate fails on T1's missing branch — with the counter
    // sitting well above any budget the loop would ever grant.
    const high = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(high.code, 1)
    assert.equal(JSON.parse(high.out).verdict, 'FAIL')
    assert.match(high.out, /T1/)

    // Now wipe the counter — the most the round bookkeeping can be tampered with, short of
    // deleting the file — and re-run the same gate against the same tree.
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    status.fixRounds = {}
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')

    const wiped = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(wiped.code, 1)
    // Byte-identical, not merely both-FAIL. The gate result carries no timestamp, so the two
    // runs differ in exactly one thing — the round counter — and the verdict does not move.
    // A `gate` that consulted `fixRounds` for anything at all would have to break this.
    assert.equal(wiped.out, high.out)
  })
})

test('a fileset failure escalates as process-violation on round 0, with the whole budget still unspent', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    // No task branches: fileset fails on T1's missing branch, and nothing has been recorded,
    // so the full budget is available and no round has been spent.
    const gateResult = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(gateResult.code, 1)
    const verdictPath = path.join(root, '.fleetmates', 'verdict.json')
    await writeFile(verdictPath, gateResult.out, 'utf8')

    const fixResult = await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath])
    assert.equal(fixResult.code, 0)
    const decision = JSON.parse(fixResult.out)
    // A fileset failure is a process violation, not a code defect: retrying it would apply
    // pressure toward widening the declared file set. The loop is therefore never entered for
    // one, at round 0 or at any other round — the budget is irrelevant to this decision.
    assert.equal(decision.decision, 'escalate')
    assert.equal(decision.reason, 'process-violation')
    assert.equal(decision.check, 'fileset')
    assert.deepEqual(decision.tasks, [])
    const status = await readStatus(root, 'r1')
    assert.equal(status.fixRounds, undefined)
  })
})

// A manifest whose enforcement checks all pass but whose command check always fails, naming
// T1's declared file so `decideFix` can attribute it. This is the only shape that reaches the
// retry branch at all: fileset and ownership escalate as process violations before the budget
// is ever consulted (pinned above).
//
// `fixRounds` is deliberately 3, NOT the 2 that both `DEFAULT_FIX_ROUNDS` constants fall back to
// (scripts/fix-loop.mjs and scripts/gate-config.mjs). With the manifest agreeing with the
// default, every budget assertion below held even when the manifest value was never read at
// all — a reviewer stubbed `fixRoundsForPhase` to return `undefined` unconditionally and the
// whole file stayed green. A third round can only come from this literal, so the budget-key
// plumbing in `scripts/cli.mjs` (the numeric-phase vs `phaseName` key-space split its own
// comment documents as a live bug class) can no longer read the wrong key unnoticed.
const RETRYABLE_BUDGET = 3
const RETRYABLE_MANIFEST = {
  phases: {
    default: {
      fixRounds: RETRYABLE_BUDGET,
      checks: [
        { name: 'fileset', kind: 'fileset' },
        { name: 'ownership', kind: 'ownership' },
        { name: 'test', kind: 'command', run: 'node -e "console.log(\'a.mjs failed\'); process.exit(1)"' },
      ],
    },
  },
}

// Sets up a run whose gate fails on an attributable command check: T1 lands its declared
// a.mjs, so both enforcement checks pass and only `test` is red.
//
// The swapped manifest is amended into the base commit rather than left in the working tree.
// withRepo commits its own fleetmates.gate.json, so overwriting it in place would leave the
// worktree dirty and fail `ownership` — turning every decision below into a process violation
// for a reason that has nothing to do with the fix loop. run-branch is still at main's tip
// here, so moving both refs onto the amended commit leaves the repo exactly as withRepo left
// it, only with a different committed manifest.
async function retryableRun(root) {
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify(RETRYABLE_MANIFEST), 'utf8')
  git(root, ['checkout', '--quiet', 'main'])
  git(root, ['add', 'fleetmates.gate.json'])
  git(root, ['commit', '--quiet', '--amend', '--no-edit'])
  git(root, ['branch', '--quiet', '-f', 'run-branch', 'main'])
  git(root, ['checkout', '--quiet', 'run-branch'])

  await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
  await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
}

// Runs the gate, asserts it FAILed, parks the verdict under the gitignored .fleetmates/ (so it
// never dirties the worktree the ownership check inspects) and returns its path.
async function gateVerdict(root) {
  const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
  assert.equal(code, 1)
  const verdictPath = path.join(root, '.fleetmates', 'verdict.json')
  await writeFile(verdictPath, out, 'utf8')
  return verdictPath
}

test('LIMIT (self-served budget): a teammate that rewrites its own fixRounds downward buys more retries and nothing else — the verdict is unchanged', async () => {
  await withRepo(async (root) => {
    await retryableRun(root)
    // Spend the whole budget honestly first.
    for (let i = 0; i < RETRYABLE_BUDGET; i += 1) {
      await runCliOn(root, ['record-fix-round', '--run', 'r1', '--phase', '1', '--task', 'T1'])
    }
    const verdictPath = await gateVerdict(root)
    const exhausted = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath])).out)
    assert.equal(exhausted.decision, 'escalate')
    assert.equal(exhausted.reason, 'budget-exhausted')

    // Now cheat: status.json is written by the agents the gate enforces, so the counter can
    // simply be zeroed. The loop reopens.
    const statusPath = path.join(root, '.fleetmates', 'r1', 'status.json')
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    status.fixRounds = { 1: { T1: 0 } }
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')

    const bought = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath])).out)
    assert.equal(bought.decision, 'retry')
    assert.equal(bought.tasks[0].taskId, 'T1')
    assert.equal(bought.tasks[0].round, 1)

    // The rewritten counter bought rounds, not a verdict: the gate run after the tamper is
    // still a FAIL. Read this assertion narrowly — RETRYABLE_MANIFEST's command check exits 1
    // unconditionally, so this re-gate would stay red under an implementation that trusted
    // `fixRounds` too, and it therefore does not by itself demonstrate recomputation. That the
    // verdict is genuinely recomputed from git is pinned by the fileset tests above, which
    // change the tree and watch the verdict follow.
    const regated = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(regated.code, 1)
    assert.equal(JSON.parse(regated.out).verdict, 'FAIL')
  })
})

test('the budget comes from the manifest, walked end to end through the real subcommands: retry 1, retry 2, retry 3, then budget-exhausted', async () => {
  await withRepo(async (root) => {
    await retryableRun(root)

    // Every round the manifest declares must be granted. Rounds 1 and 2 would be granted by
    // `DEFAULT_FIX_ROUNDS` alone; round 3 exists only in RETRYABLE_MANIFEST, so reaching it is
    // the assertion that the manifest's budget was actually read and keyed correctly.
    for (let round = 1; round <= RETRYABLE_BUDGET; round += 1) {
      const decision = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', await gateVerdict(root)])).out)
      assert.equal(decision.decision, 'retry', `round ${round} must be granted by the manifest budget of ${RETRYABLE_BUDGET}`)
      assert.deepEqual(decision.tasks.map((t) => [t.taskId, t.round]), [['T1', round]])
      // The caller records a round only when it actually dispatches the retry — `fix` is a pure
      // read, so without this writer the sequence loops at round 1 forever.
      const recorded = await runCliOn(root, ['record-fix-round', '--run', 'r1', '--phase', '1', '--task', 'T1'])
      assert.equal(recorded.code, 0)
      assert.match(recorded.out, new RegExp(`T1 phase 1 round ${round}`))
    }

    // The manifest's budget is spent — and only now. The loop terminates at a human instead of
    // granting a fourth round.
    const exhausted = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', await gateVerdict(root)])).out)
    assert.equal(exhausted.decision, 'escalate')
    assert.equal(exhausted.reason, 'budget-exhausted')
    assert.equal(exhausted.taskId, 'T1')
    assert.deepEqual(exhausted.tasks, [])
  })
})

// `fix` reads plan.json out of `.fleetmates/`, which is exactly as agent-writable as
// status.json. The three tests below pin what that buys. None of them is a hole in the gate —
// no verdict moves — but each changes which teammate the loop points at, and an untested
// limitation drifts into an implied guarantee.

async function rewritePlan(root, runId, mutate) {
  const planPath = path.join(root, '.fleetmates', runId, 'plan.json')
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  mutate(plan)
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
}

test('LIMIT (plan.json rewrite): moving the failing file into another task\'s declared set redirects the retry onto that innocent task', async () => {
  await withRepo(async (root) => {
    await retryableRun(root)
    // The gate itself is untouched by this: `fileset` reads plan.md out of the anchor COMMIT,
    // so the phase still derives as 1, T1 still owns a.mjs there, and both enforcement checks
    // still pass. Only `fix`'s attribution input is rewritten.
    await rewritePlan(root, 'r1', (plan) => {
      const t1 = plan.tasks.find((t) => t.id === 'T1')
      const t2 = plan.tasks.find((t) => t.id === 'T2')
      t1.files = ['zzz.mjs']
      t2.phase = 1
      t2.files = ['a.mjs']
    })

    const decision = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', await gateVerdict(root)])).out)
    // T2 committed nothing and its branch does not even exist; the failing command named
    // a.mjs, which T1 wrote. The retry goes to T2 anyway — the outcome scripts/fix-loop.mjs
    // names as "pollutes an innocent branch", reached here through plan.json rather than
    // through the attribution logic that comment guards.
    assert.equal(decision.decision, 'retry')
    assert.deepEqual(decision.tasks.map((t) => t.taskId), ['T2'])
    // And nothing about the verdict moved: the gate is still recomputed from git and still red.
    const regated = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(regated.code, 1)
  })
})

test('LIMIT (plan.json rewrite): rewriting the failing task\'s own phase drops it from phaseTasks and the failure becomes unattributable', async () => {
  await withRepo(async (root) => {
    await retryableRun(root)
    await rewritePlan(root, 'r1', (plan) => {
      plan.tasks.find((t) => t.id === 'T1').phase = 2
    })

    const decision = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', await gateVerdict(root)])).out)
    // `fix` filters plan.json's tasks to the numeric phase it was asked about, so T1 is no
    // longer a candidate and the command output naming a.mjs matches nobody. Fail-safe — the
    // phase halts at a human rather than retrying or passing — but undocumented until now.
    assert.equal(decision.decision, 'escalate')
    assert.equal(decision.reason, 'unattributable')
    assert.equal(decision.check, 'test')
    assert.deepEqual(decision.tasks, [])
  })
})

test('LIMIT (persisted verdict): feeding the gate record stored in status.json back as --verdict decides none, exactly as the skill says is incidental', async () => {
  await withRepo(async (root) => {
    await retryableRun(root)
    const gateResult = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(gateResult.code, 1)

    // skills/phase-gate/SKILL.md forbids reading the verdict back from `.fleetmates/` and notes
    // that doing it today "degenerates harmlessly, because the persisted object carries no
    // `results` key and the decision comes back `none` … that is incidental, not guaranteed."
    // This pins the incidental behaviour so it breaks loudly the day `results` starts being
    // persisted and the on-disk record silently becomes a decision input.
    const statusPath = path.join(root, '.fleetmates', 'r1', 'status.json')
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    const persisted = status.gates['1']
    assert.equal(persisted.verdict, 'FAIL')
    assert.equal(persisted.results, undefined)

    const recordPath = path.join(root, '.fleetmates', 'persisted-verdict.json')
    await writeFile(recordPath, JSON.stringify(persisted), 'utf8')
    const fromRecord = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', recordPath])).out)
    assert.equal(fromRecord.decision, 'none')
    assert.deepEqual(fromRecord.tasks, [])

    // The whole status.json is the same shape of mistake and lands the same way.
    const fromStatus = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', statusPath])).out)
    assert.equal(fromStatus.decision, 'none')

    // A genuine verdict for the same tree, from the same moment, decides `retry`. That is what
    // makes `none` above a real degeneration rather than the honest answer.
    const fromGate = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', await gateVerdict(root)])).out)
    assert.equal(fromGate.decision, 'retry')
  })
})

// ============================================================================================
// Step 6 — the `--results` trust boundary, against real repositories with real violations.
//
// What these pin: `--results` is caller input for one run and can only ever fill in a check
// the CLI cannot run itself. It cannot supply a computed check (`command`, `fileset`,
// `ownership`), cannot name a check the phase's manifest does not declare, cannot name one the
// manifest declares twice, and cannot smuggle `optional: true` past a failing review. In every
// rejection the gate exits 2 having recorded nothing, and the genuine violation is still there
// on the next plain run — the file buys the caller no credit and no erasure.
//
// What these do NOT pin: that a determined teammate cannot get arbitrary code to run. It
// still can — `--results` is read by a CLI the teammate may invoke, in a repository the
// teammate may write, and a teammate that can run `node` can run anything. Nothing here
// narrows or widens the boundary the rest of this file describes; `--results` is a re-entry
// path for the pending checks, not a new privilege, and these tests exist to keep it that way.
// ============================================================================================

// The manifests below declare an `agent` check alongside the two enforcement checks, because
// `agent` is the only suppliable kind this repo's checks exercise. Written per test rather
// than into `withRepo`'s default, which stays enforcement-only on purpose (see MANIFEST).
//
// Amended INTO the initial commit, with main moved along, rather than left in the working
// tree: fleetmates.gate.json is tracked, so a plain overwrite leaves the worktree dirty and
// `ownership` fails the run on that instead of on what the test is about. Committing it on
// run-branch alone would be worse — an unexplained commit, which `ownership` also fails.
// Call before taskBranch, so task branches fork from the amended commit.
async function commitManifest(root, checks) {
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks } } }), 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '--amend', '--no-edit'])
  git(root, ['branch', '--force', 'main', 'run-branch'])
}

// Under `.fleetmates/` because that is the one path withRepo's .gitignore excludes. Dropped in
// the repo root instead, the results file is an untracked file in the worktree and `ownership`
// fails the run on it — which would mask the very rejection each test below means to pin, and
// did exactly that on the first draft of the last test here.
async function writeResults(root, results) {
  const file = path.join(root, '.fleetmates', 'supplied-results.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ results }), 'utf8')
  return file
}

test('--results supplying a passing fileset does not erase a real fileset violation', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n', 'stray.mjs': 'y\n' } })

    // Establish the violation is genuine BEFORE the attack, so the exit 2 below can only be
    // the rejection and not a fixture that never had anything to suppress in the first place.
    const before = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(before.code, 1)
    assert.match(before.out, /stray\.mjs/)

    const file = await writeResults(root, [{ name: 'fileset', kind: 'fileset', status: 'pass' }])
    const attack = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md', '--results', file])
    // Rejected on the check's DECLARED kind, not on the kind the file claims — the file's own
    // `kind` field is never consulted, so relabelling it `agent` would not help either.
    assert.equal(attack.code, 2)
    assert.match(attack.out, /--results may not supply a fileset check/)

    const after = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(after.code, 1)
    assert.match(after.out, /stray\.mjs/)
  })
})

test('--results supplying a passing ownership does not erase an unexplained commit', async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, 'sneaky.mjs'), 'x\n', 'utf8')
    git(root, ['add', 'sneaky.mjs'])
    git(root, ['commit', '--quiet', '-m', 'direct write to the run branch'])
    const sha = git(root, ['rev-parse', 'HEAD']).trim()

    const before = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(before.code, 1)
    assert.match(before.out, new RegExp(sha))

    const file = await writeResults(root, [{ name: 'ownership', kind: 'ownership', status: 'pass' }])
    const attack = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md', '--results', file])
    assert.equal(attack.code, 2)
    assert.match(attack.out, /--results may not supply a ownership check/)

    const after = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(after.code, 1)
    assert.match(after.out, new RegExp(sha))
  })
})

test('--results naming a check absent from the manifest exits 2 and records no verdict', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })

    const file = await writeResults(root, [{ name: 'invented', kind: 'agent', status: 'pass' }])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md', '--results', file])
    assert.equal(code, 2)
    assert.match(out, /--results names a check not in this phase's manifest: "invented"/)

    // Exit 2 happens before the gate record is written, so an invented name cannot even
    // create a status.gates entry to be read back later as evidence the phase was gated.
    const status = await readStatus(root, 'r1')
    assert.equal(status.gates, undefined)
  })
})

test('--results naming a check the manifest declares twice is rejected rather than resolved', async () => {
  await withRepo(async (root) => {
    // One name, two kinds. `byName` resolves such a name to exactly one check (last wins)
    // while the merge fills EVERY pending result carrying it — so without this rejection an
    // `agent` result would land on the `command` check, and whether the file was accepted at
    // all would depend on which of the two the manifest happened to declare second.
    await commitManifest(root, [
      { name: 'fileset', kind: 'fileset' },
      { name: 'ownership', kind: 'ownership' },
      { name: 'review', kind: 'command', run: 'node -e ""' },
      { name: 'review', kind: 'agent' },
    ])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })

    const file = await writeResults(root, [{ name: 'review', kind: 'agent', status: 'pass' }])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md', '--results', file])
    assert.equal(code, 2)
    assert.match(out, /--results names a check declared more than once in this phase's manifest: "review"/)
  })
})

test('--results cannot declare a failing review optional and turn the verdict into a PASS', async () => {
  await withRepo(async (root) => {
    await commitManifest(root, [
      { name: 'fileset', kind: 'fileset' },
      { name: 'ownership', kind: 'ownership' },
      { name: 'review', kind: 'agent' },
    ])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })

    const file = await writeResults(root, [
      { name: 'review', kind: 'agent', status: 'fail', optional: true, findings: [{ severity: 'high' }] },
    ])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md', '--results', file])
    // `optional` is a manifest declaration that a check does not block. Taking it from the
    // supplied file would let the very report of a failure demote that failure to advisory —
    // PASS, exit 0, the failed review filed under `optionalFailed`. It comes from the
    // COMPUTED result instead, so the manifest's silence means required and the gate blocks.
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    // Exactly `review` — the phase is otherwise compliant, so a FAIL that dragged in a dirty
    // worktree or a missing branch would not be evidence that `optional` was ignored.
    assert.deepEqual(parsed.failed, ['review'])
    assert.deepEqual(parsed.optionalFailed, [])
    assert.equal(parsed.results.find((r) => r.name === 'review').optional, false)
  })
})

test('supplying a legitimate agent result leaves the fileset and ownership results untouched', async () => {
  await withRepo(async (root) => {
    await commitManifest(root, [
      { name: 'fileset', kind: 'fileset' },
      { name: 'ownership', kind: 'ownership' },
      { name: 'review', kind: 'agent' },
    ])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })

    // A compliant phase: both enforcement checks pass and only `review` is pending, so the
    // plain run fails on the pending check alone. That isolates the supplied result as the
    // one thing that changes between the two runs.
    const plain = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(plain.code, 1)
    const plainResults = JSON.parse(plain.out).results
    assert.equal(plainResults.find((r) => r.name === 'review').status, 'pending')
    assert.equal(plainResults.find((r) => r.name === 'fileset').status, 'pass')
    assert.equal(plainResults.find((r) => r.name === 'ownership').status, 'pass')

    const file = await writeResults(root, [{ name: 'review', kind: 'agent', status: 'pass', findings: [] }])
    const supplied = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md', '--results', file])
    assert.equal(supplied.code, 0)
    const suppliedResults = JSON.parse(supplied.out).results
    assert.equal(JSON.parse(supplied.out).verdict, 'PASS')

    // Byte-identical, not merely equivalent: `mergeSuppliedResults` returns the computed
    // entry itself for any name the file does not fill, so nothing about fileset or
    // ownership — status, output, optional, the branchShas the fileset check carries — may
    // differ. Both are recomputed from the same git state, so there is nothing legitimately
    // time-varying in them to exempt.
    for (const name of ['fileset', 'ownership']) {
      assert.equal(
        JSON.stringify(suppliedResults.find((r) => r.name === name)),
        JSON.stringify(plainResults.find((r) => r.name === name)),
      )
    }
  })
})

test('a compliant two-phase run passes phase 1, is merged --no-ff, then derives and passes phase 2 with no manual state edits', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])

    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    const phase1 = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(phase1.code, 0)
    assert.equal(JSON.parse(phase1.out).phase, 1)

    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])

    // T2 branches off the run branch AFTER the phase-1 merge — the real workflow, and a
    // regression test for a confirmed bug where every phase-2 task false-failed on files
    // phase 1 had already merged (the forkPoint fix in runFilesetCheck).
    await taskBranch(root, 'r1', 'T2', { from: 'run-branch', files: { 'b.mjs': 'y\n' } })
    const phase2 = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(phase2.code, 0)
    assert.equal(JSON.parse(phase2.out).phase, 2)

    const completeResult = await runCliOn(root, ['complete', '--run', 'r1', '--task', 'T2', '--plan', 'plan.md'])
    assert.equal(completeResult.code, 0)
    assert.match(completeResult.out, /T2 done/)
  })
})

// ============================================================================================
// Step 7 — the `preview.link` boundary, against real repositories and a real merge preview.
//
// What these pin: a manifest cannot use `preview.link` to reach outside the repository. The
// manifest is read from the working tree, which an enforced teammate may write, so the entries
// it declares are caller input in exactly the sense `--results` is: an entry that escapes the
// repository textually, escapes it only after normalisation, or is absolute is refused before
// any worktree exists, and an entry naming a directory that is not there fails the `merge`
// check rather than being deferred into a `command` check that would then blame the teammate's
// code for a missing build input. In every rejection the gate FAILs, nothing is created at the
// escape target, and the `command` checks are recorded `skip` — never `pass`.
//
// What these do NOT pin: that a determined teammate cannot get arbitrary code to run. It still
// can, and that limit is unchanged and documented — a `command` check is a shell command read
// from the same editable manifest, so a teammate that can write the manifest can already run
// anything without needing a link at all. These tests narrow nothing there. What they pin is
// narrower and worth pinning on its own: the link mechanism does not hand that code a writable
// junction into a directory OUTSIDE the repository, which is the one privilege linking adds.
//
// The last test is the counterweight to all of them. A gate that refused every entry would
// satisfy every rejection above, so one test provisions a legitimate link end to end and
// proves a `command` check read through it.
// ============================================================================================

// Like commitManifest, but also carries a top-level `preview` block and, optionally, extra
// .gitignore entries — an untracked build directory left unignored is a dirty worktree and
// `ownership` would fail the run on that instead of on what the test is about. Same amend-into-
// the-initial-commit reasoning, so call it before taskBranch and before creating the ignored
// directory (it runs `git add .`).
async function commitPreviewManifest(root, { link, checks, ignore = [] }) {
  const config = { preview: { link }, phases: { default: { checks } } }
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify(config), 'utf8')
  await writeFile(path.join(root, '.gitignore'), ['.fleetmates/', ...ignore, ''].join('\n'), 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '--amend', '--no-edit'])
  git(root, ['branch', '--force', 'main', 'run-branch'])
}

// lstat, not stat: `stat` follows links, so it reports false for a dangling link — exactly the
// artifact the escape assertions below exist to detect. For entry '../escape' the computed link
// path is byte-identical to the escape target, and both a POSIX symlink and a Windows junction
// are created happily against a missing target, so a regression that drops the pre-symlink guard
// would leave a real link there that `stat` cannot see.
async function exists(p) {
  return await lstat(p).then(() => true, () => false)
}

const PREVIEW_CHECKS = [
  { name: 'fileset', kind: 'fileset' },
  { name: 'ownership', kind: 'ownership' },
  // Passes trivially if it is ever run, so a recorded `skip` below is evidence the gate
  // withheld it and not evidence the command itself was broken.
  { name: 'noop', kind: 'command', run: 'node -e ""' },
]

// Runs a one-task phase whose manifest declares `link`, and returns the parsed gate verdict.
async function gateWithLink(root, link) {
  await commitPreviewManifest(root, { link, checks: PREVIEW_CHECKS })
  await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
  const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
  return { code, parsed: JSON.parse(out) }
}

// The three rejections share their shape entirely: FAIL, `merge` alone failing, the entry named
// in the merge output, and the command check withheld. Only the message differs.
function assertLinkRejected(code, parsed, entry, messagePattern) {
  assert.equal(code, 1)
  assert.equal(parsed.verdict, 'FAIL')
  assert.deepEqual(parsed.failed, ['merge'])
  const merge = parsed.results.find((r) => r.name === 'merge')
  assert.equal(merge.status, 'fail')
  // The entry is interpolated with JSON.stringify, so a Windows absolute path appears with its
  // backslashes doubled. Compare against that same escaping rather than the raw string.
  const asWritten = JSON.stringify(entry).slice(1, -1)
  assert.ok(merge.output.includes(asWritten), `the merge output must name the entry: ${merge.output}`)
  assert.match(merge.output, messagePattern)
  // `skip`, not merely "not pass": aggregateVerdict counts `skip` as neither failed nor
  // pending, so a check that quietly passed against the unprovisioned run branch would be
  // indistinguishable from one honestly withheld if this only asserted the absence of `pass`.
  assert.equal(parsed.results.find((r) => r.name === 'noop').status, 'skip')
}

test('a manifest declaring a preview.link that escapes the repository fails the gate and creates nothing at the escape target', async () => {
  await withRepo(async (root) => {
    // Namespaced by the repo's own mkdtemp suffix. `path.resolve(root, '..', 'escape')`
    // collapses to a single fixed path in the system temp directory shared by every test that
    // spells it that way, and nothing in withRepo's cleanup removes a path outside the repo —
    // so one aborted run leaves a directory that fails the precondition of every later run.
    const escapeName = `escape-${path.basename(root)}`
    const escapeTarget = path.resolve(root, '..', escapeName)
    assert.equal(await exists(escapeTarget), false, 'fixture precondition: the escape target must not pre-exist')

    const { code, parsed } = await gateWithLink(root, [`../${escapeName}`])
    assertLinkRejected(code, parsed, `../${escapeName}`, /escapes the repository/)

    // The entry is refused by validateLinkPaths before withMergePreview creates any worktree,
    // so there is no window in which a junction into the parent directory exists.
    assert.equal(await exists(escapeTarget), false, 'nothing may be created at the escape target')
  })
})

test('a manifest declaring an absolute preview.link fails the gate and creates nothing at the escape target', async () => {
  await withRepo(async (root) => {
    const escapeTarget = path.resolve(root, '..', `abs-escape-${path.basename(root)}`)
    assert.equal(await exists(escapeTarget), false, 'fixture precondition: the escape target must not pre-exist')

    const { code, parsed } = await gateWithLink(root, [escapeTarget])
    assertLinkRejected(code, parsed, escapeTarget, /must be repo-relative/)

    assert.equal(await exists(escapeTarget), false, 'nothing may be created at the escape target')
  })
})

test('a manifest declaring a preview.link that escapes only after normalisation fails the gate and creates nothing at the escape target', async () => {
  await withRepo(async (root) => {
    // 'a/../../escape' contains no leading '..' and names a plausible in-repo subdirectory; it
    // reaches the parent of the repository only once path.normalize collapses the segments.
    const escapeName = `escape-${path.basename(root)}`
    const escapeTarget = path.resolve(root, '..', escapeName)
    assert.equal(await exists(escapeTarget), false, 'fixture precondition: the escape target must not pre-exist')

    const { code, parsed } = await gateWithLink(root, [`a/../../${escapeName}`])
    assertLinkRejected(code, parsed, `a/../../${escapeName}`, /escapes the repository/)

    assert.equal(await exists(escapeTarget), false, 'nothing may be created at the escape target')
  })
})

test('a manifest declaring a preview.link that does not exist fails the merge check with ENOENT and skips the command checks', async () => {
  await withRepo(async (root) => {
    // Unlike the three above this entry is textually legitimate, so it survives
    // validateLinkPaths, a worktree is created, the merge succeeds, and the failure comes from
    // the explicit stat in linkInto — neither a POSIX symlink nor a Windows junction refuses a
    // missing target on its own, and a dangling link would defer this to the command check.
    const { code, parsed } = await gateWithLink(root, ['not-installed'])
    assert.equal(code, 1)
    assert.equal(parsed.verdict, 'FAIL')
    assert.deepEqual(parsed.failed, ['merge'])
    const merge = parsed.results.find((r) => r.name === 'merge')
    assert.equal(merge.status, 'fail')
    assert.match(merge.output, /preview link 'not-installed' failed: ENOENT/)
    // The remedy sentence is part of what makes this a manifest error rather than a code
    // defect, so it is pinned rather than left to the message's first clause.
    assert.match(merge.output, /Run your install step, or remove it from preview\.link/)
    // A preview missing its build inputs is exactly the state in which a command check
    // produces failures that look like code defects. It must be withheld, not run, and not
    // recorded `pass` against the unprovisioned run-branch tree.
    assert.equal(parsed.results.find((r) => r.name === 'noop').status, 'skip')
  })
})

test('a legitimate preview.link provisions the preview and a command check reads through it', async () => {
  await withRepo(async (root) => {
    // The probe reports where it ran and what the linked path resolves to, so the assertions
    // below can tell "read through the link, from inside the preview" apart from "read from
    // the repository working tree" — the two are indistinguishable by exit code alone, and a
    // check that was skipped still yields PASS and exit 0.
    const sentinel = path.join(root, '.fleetmates', 'link-probe.json')
    // realpathSync.native, not realpathSync: on Windows the plain form can return an 8.3 short
    // path (`C:\Users\RUNNER~1\...`) while the test's own side resolves to the long one
    // (`C:\Users\runneradmin\...`), and the two compare unequal for the same file. The native
    // form canonicalises both to the long name. This bit CI on windows-latest, where the temp
    // directory sits under a user whose name is long enough to be shortened.
    const probe = `import { realpathSync, readFileSync, writeFileSync } from 'node:fs'
// Throws — and so exits non-zero, failing the check — if the link was never created.
const marker = 'build/deps/marker.txt'
writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify({
  cwd: realpathSync.native(process.cwd()),
  markerReal: realpathSync.native(marker),
  content: readFileSync(marker, 'utf8'),
}))
`
    await commitPreviewManifest(root, {
      link: ['build/deps'],
      ignore: ['build/'],
      checks: [
        { name: 'fileset', kind: 'fileset' },
        { name: 'ownership', kind: 'ownership' },
        // Nested one level below the repository root on purpose: `build/` is not tracked, so
        // the merged tree contains no `build` at all and the probe is unreachable there by
        // accident — running it requires linkInto to have created the parent and the link.
        { name: 'reads-through-link', kind: 'command', run: 'node build/deps/probe.mjs' },
      ],
    })

    // Real, untracked content in the actual repository working tree: preview.link resolves
    // against the repo root, not against anything committed.
    await mkdir(path.join(root, 'build', 'deps'), { recursive: true })
    await writeFile(path.join(root, 'build', 'deps', 'marker.txt'), 'linked build input\n', 'utf8')
    await writeFile(path.join(root, 'build', 'deps', 'probe.mjs'), probe, 'utf8')
    await mkdir(path.dirname(sentinel), { recursive: true })

    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 0, out)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'PASS')
    assert.equal(parsed.results.find((r) => r.name === 'merge').status, 'pass')
    assert.equal(parsed.results.find((r) => r.name === 'reads-through-link').status, 'pass')

    // The sentinel exists only if the command genuinely executed; `pass` above cannot be
    // reached by a withheld check, but neither can it distinguish WHERE the check ran.
    const report = JSON.parse(await readFile(sentinel, 'utf8'))
    // Native form on both sides of the comparison, for the 8.3 short-name reason above.
    const realRoot = realpathSync.native(root)
    // Ran inside the merge preview's scratch worktree, not in the repository working tree —
    // where `build/deps/marker.txt` also exists and would have satisfied a naive probe with no
    // link created at all.
    assert.notEqual(report.cwd, realRoot)
    assert.equal(path.relative(realRoot, report.cwd).startsWith('..'), true,
      `the check must run outside the repository working tree, ran in ${report.cwd}`)
    // ...and the path it read resolves back to the repository's real file, which is what makes
    // it a link rather than a copy the preview happened to contain.
    assert.equal(report.markerReal, path.join(realRoot, 'build', 'deps', 'marker.txt'))
    assert.equal(report.content, 'linked build input\n')

    // The linked directory must survive the gate. This is the only test where a real junction,
    // a real `git worktree remove` and a real recursive `rm` of the preview are all present at
    // once, so it is the only place the *destructive* consequence of tearing links down in the
    // wrong order can be observed. `tests/merge-preview.test.mjs` pins the ordering, but it
    // records call order against a fake git with no link on disk — evidence about sequence, not
    // about outcome. Move the teardown in `scripts/merge-preview.mjs` after the `rm` and every
    // assertion above still passes while these two files are deleted from the repository: in
    // production that is the user's real `node_modules` erased by a gate run.
    assert.equal(await exists(path.join(root, 'build', 'deps', 'marker.txt')), true,
      'the gate must not delete the linked directory it borrowed')
    assert.equal(await exists(path.join(root, 'build', 'deps', 'probe.mjs')), true,
      'the gate must not delete the linked directory it borrowed')
    assert.equal(await readFile(path.join(root, 'build', 'deps', 'marker.txt'), 'utf8'),
      'linked build input\n', 'the linked file must still be readable after the gate')
  })
})

// ============================================================================================
// Step 8 — the config layer's trust boundary.
//
// `fleetmates.local.json` is gitignored on purpose: it holds machine-local ergonomics, so it must
// not be committed. That same gitignore is what makes it interesting here. A teammate runs its
// own code, so it can write the file during its own task, and neither `fileset` nor `ownership`
// will ever see it — the worktree stays clean. The whole defence is therefore that the file
// cannot reach anything that decides a verdict: enforcement keys (`phases`, `lens`, `preview`,
// and `agents.reviewer.*`) live in the TRACKED manifest and are rejected by name in this layer.
//
// Two properties, and both are needed. The gate must not honour such a file (below), and the
// CLI must not ignore it quietly either — a silently dropped override is how an operator comes
// to believe the gate was reconfigured when it was not. See SECURITY.md and scripts/config.mjs.
// ============================================================================================

// A hostile local layer, written exactly as a teammate would: the empty check list would retire
// `fileset` and `ownership` — the two checks that catch it — and the inflated budget would keep
// the fix loop retrying long past the point the operator meant to stop.
//
// `fixRounds` appears twice, and the two copies do different jobs — do not assume the top-level
// one is a duplicate and delete it.
//
// `phases.<name>.fixRounds` then `phases.default.fixRounds` is the only spelling any production
// path reads (`fixRoundsForPhase`), so it is the one the fix-loop test below pins. The top-level
// copy is read by nothing: removing it changes no gate or fix behaviour, and no single-step
// mutation makes it matter. It earns its place in a different test — it is the spelling an
// attacker guessing at the schema reaches for, and being an *unknown* key rather than an
// enforcement one it is the nearest neighbour the `config list` test rules out, pinning that the
// validator names `phases` and not `fixRounds`. Delete it and that assertion asserts nothing.
const HOSTILE_LOCAL = {
  phases: { default: { checks: [], fixRounds: 99 } },
  fixRounds: 99,
}

// Amends a .gitignore that also excludes the local layer into the base commit — which is what a
// real project has, since `config set --local` adds the entry itself. Without it the hostile
// file below would be an untracked path, `ownership`'s dirty-worktree check would fail on the
// file's mere existence, and the tests would prove nothing about whether its CONTENT was
// honoured.
//
// Amended into the base rather than committed on top, for the reason `retryableRun` gives about
// its own manifest swap: a commit on run-branch that no task branch explains is itself an
// ownership violation, and it must also survive `retryableRun`'s later amend of the same commit.
// Call this BEFORE `retryableRun`, never after — the second amend keeps the first's content, but
// not the other way round. The guard below makes that a real constraint rather than a comment:
// swapped, this function's `branch -f run-branch main` orphans the task branch `retryableRun`
// already cut, and the run fails as a gate exit 1 while `decideFix` reports `none` — loud, but
// pointing at the wrong subsystem entirely.
async function ignoreLocalLayer(root) {
  const branches = git(root, ['branch', '--list', 'teammates/*', '--format=%(refname:short)']).trim()
  assert.equal(branches, '', 'ignoreLocalLayer must run before any task branch exists — call it before retryableRun')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\nfleetmates.local.json\n', 'utf8')
  git(root, ['checkout', '--quiet', 'main'])
  git(root, ['add', '.gitignore'])
  git(root, ['commit', '--quiet', '--amend', '--no-edit'])
  git(root, ['branch', '--quiet', '-f', 'run-branch', 'main'])
  git(root, ['checkout', '--quiet', 'run-branch'])
}

test('a hostile fleetmates.local.json declaring an empty check list leaves the gate verdict untouched', async () => {
  await withRepo(async (root) => {
    await ignoreLocalLayer(root)
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    // A VIOLATING tree, not a compliant one, and deliberately so. Against a clean tree both
    // runs would say PASS and an implementation that had genuinely emptied the check list would
    // say PASS too — the assertion would hold for the wrong reason. With a real fileset
    // violation present, retiring the checks is the one thing that would visibly change the
    // answer, so "unchanged" here means the local layer supplied no checks.
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n', 'stray.mjs': 'y\n' } })

    const before = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(before.code, 1)
    assert.equal(JSON.parse(before.out).verdict, 'FAIL')

    await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify(HOSTILE_LOCAL), 'utf8')
    // Invisible to git, which is precisely why the file must not be trusted — and why this test
    // exists rather than relying on `ownership` to catch it.
    assert.equal(git(root, ['status', '--porcelain']).trim(), '')

    const after = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(after.code, before.code)
    // Byte-identical, not merely both-FAIL: the gate result carries no timestamp, so the two
    // runs differ in exactly one thing — the presence of the hostile file.
    assert.equal(after.out, before.out)

    // And the checks the hostile file tried to retire are still the ones that produced the
    // verdict, named. `verdict: FAIL` alone would also be satisfied by a gate that ran no
    // enforcement checks and failed for some unrelated reason.
    const parsed = JSON.parse(after.out)
    assert.equal(parsed.results.find((r) => r.name === 'fileset').status, 'fail')
    assert.ok(parsed.results.some((r) => r.name === 'ownership'))
    assert.match(after.out, /stray\.mjs/)
  })
})

test('the same hostile file cannot extend the fix-round budget the tracked manifest sets', async () => {
  await withRepo(async (root) => {
    // The other half of HOSTILE_LOCAL. The verdict test above says nothing about `fixRounds` —
    // its assertions are all about the gate result, which the budget does not touch — so
    // without this test a `fixRoundsForPhase` that merged the gitignored layer would pass the
    // whole suite while handing a teammate 99 retries it was never granted.
    await ignoreLocalLayer(root)
    await retryableRun(root)
    await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify(HOSTILE_LOCAL), 'utf8')
    // Still invisible to git, exactly as in the verdict test.
    assert.equal(git(root, ['status', '--porcelain']).trim(), '')

    const verdictPath = await gateVerdict(root)
    // The tracked manifest grants RETRYABLE_BUDGET rounds and the hostile file asks for 99, so
    // every round below must be granted and the one after it refused. Walked through the real
    // `fix` and `record-fix-round` subcommands rather than by reading a number back, because the
    // budget only means anything at the point the loop stops.
    for (let round = 1; round <= RETRYABLE_BUDGET; round += 1) {
      const granted = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath])).out)
      assert.equal(granted.decision, 'retry')
      assert.equal(granted.tasks[0].taskId, 'T1')
      assert.equal(granted.tasks[0].round, round)
      const recorded = await runCliOn(root, ['record-fix-round', '--run', 'r1', '--phase', '1', '--task', 'T1'])
      assert.equal(recorded.code, 0)
    }

    const exhausted = JSON.parse((await runCliOn(root, ['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath])).out)
    // The discrimination lives in the loop above, not here: a `fix` that merged the hostile
    // layer's 99 would keep granting rounds, so `granted.round === round` for exactly
    // RETRYABLE_BUDGET rounds and a stop on the next one is what proves the budget came from the
    // tracked manifest. Do not drop those as redundant with this assertion — without them this
    // one holds for a run that never granted a round at all.
    //
    // `budget-exhausted` by name, not merely `escalate`, because `decideFix` has four escalate
    // reasons (`malformed-verdict`, `process-violation`, `unattributable`, `budget-exhausted`)
    // and the first three would stop the loop here too, at the same decision, for reasons that
    // say nothing about whose budget was honoured.
    assert.equal(exhausted.decision, 'escalate')
    assert.equal(exhausted.reason, 'budget-exhausted')
    assert.deepEqual(exhausted.tasks, [])
  })
})

test('the same hostile fleetmates.local.json makes config list exit 2, naming phases as an enforcement key', async () => {
  await withRepo(async (root) => {
    await ignoreLocalLayer(root)
    await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify(HOSTILE_LOCAL), 'utf8')

    const { code, out } = await runCliOn(root, ['config', 'list'])
    assert.equal(code, 2)
    // The exact message, whole. Six distinct config failures share exit 2 — an unsupported flag
    // spelling, an enforcement key, an unknown key, an unsafe key segment, a corrupt layer, and
    // a flag given a value it does not take — so an assertion on the exit code, or on the mere
    // appearance of the word `phases`, cannot tell which one fired and would certify a rejection
    // it never observed.
    assert.equal(out, 'phases is an enforcement key; it may only be set in fleetmates.gate.json')
    // The nearest neighbour, ruled out explicitly: `fixRounds` in this same file IS an unknown
    // key, so a validator that walked the object in a different order would reject the file at
    // exit 2 with that wording instead — loud, but about the wrong key, and it would leave
    // `phases` unmentioned for an operator reading the message.
    assert.doesNotMatch(out, /unknown key in fleetmates\.local\.json/)
    // Not printed and then ignored: no resolved value may reach stdout alongside the rejection.
    assert.doesNotMatch(out, /maxParallel/)
  })
})

test('a fleetmates.local.json declaring agents.reviewer.tier is rejected by name', async () => {
  await withRepo(async (root) => {
    await ignoreLocalLayer(root)
    // `cheap` is a perfectly valid tier — the value is not the problem. The reviewer produces
    // the verdict for every `agent`-kind check, so choosing its tier from the gitignored layer
    // is a teammate picking the judge for its own diff, leaving no `fileset` or `ownership`
    // evidence. `agents.implementer.tier` in this same position is accepted; the role is what
    // makes this one enforcement.
    await writeFile(
      path.join(root, 'fleetmates.local.json'),
      JSON.stringify({ agents: { reviewer: { tier: 'cheap' } } }),
      'utf8',
    )

    const { code, out } = await runCliOn(root, ['config', 'list'])
    assert.equal(code, 2)
    assert.equal(out, 'agents.reviewer is an enforcement key; it may only be set in fleetmates.gate.json')
    // Ruled out explicitly, because both are exit-2 rejections of the same file and only one of
    // them is the guarantee this test claims: `unknown agent role` would mean the role was
    // refused as a typo rather than as enforcement, and would equally refuse a legitimate
    // reviewer entry in the tracked manifest.
    assert.doesNotMatch(out, /unknown agent role/)
    assert.doesNotMatch(out, /unknown key in fleetmates\.local\.json/)
  })
})

test('the same reviewer tier is accepted in the tracked manifest, so the rejection above is about the layer and not the key', async () => {
  await withRepo(async (root) => {
    // The mirror of the test above. Without it, `agents.reviewer.tier` being rejected everywhere
    // — a config that simply cannot express a reviewer tier at all — would satisfy every
    // assertion there while making the documented split meaningless.
    const manifest = { ...MANIFEST, agents: { reviewer: { tier: 'cheap' } } }
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify(manifest), 'utf8')

    const { code, out } = await runCliOn(root, ['config', 'list'])
    assert.equal(code, 0, out)
    assert.match(out, /^agents\.reviewer\.tier {4}cheap {2}\(fleetmates\.gate\.json\)$/m)
  })
})

// ============================================================================================
// Protected paths and non-removable enforcement checks
// (docs/specs/2026-09-26-protected-paths-design.md).
//
// The gate reads the manifest from the main worktree, which holds the run branch AFTER the last
// integration. Before `checksForPhase` injected `fileset` and `ownership`, an integrator merge that
// rewrote the manifest switched off, at the next gate, the one check that would report that merge.
// ============================================================================================

// Integrates a task branch with `--no-ff --no-commit`, lets `tamper` change the merge's tree, then
// completes it — the integrator's merge, carrying content no parent explains. Returns its sha.
async function evilMerge(root, branch, tamper) {
  git(root, ['merge', '--quiet', '--no-ff', '--no-commit', branch])
  await tamper()
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', `merge ${branch}`])
  return git(root, ['rev-parse', 'HEAD']).trim()
}

const NARROWED_MANIFEST = {
  phases: {
    default: {
      checks: [
        { name: 'fileset', kind: 'fileset', optional: true, protected: [], scope: 'none' },
        { name: 'ownership', kind: 'ownership', optional: true, skip: true, protected: [] },
      ],
    },
  },
}

for (const [shape, manifest] of [
  ['narrows both declared enforcement checks', NARROWED_MANIFEST],
  ['removes both enforcement checks outright', { phases: { default: { checks: [] } } }],
]) {
  test(`an integrator merge that ${shape} still fails the next phase's gate`, async () => {
    await withRepo(async (root) => {
      await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
      await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
      const sha = await evilMerge(root, 'fleetmates/r1/T1', async () => {
        await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify(manifest), 'utf8')
        await writeFile(path.join(root, 'rogue.mjs'), 'smuggled\n', 'utf8')
      })
      await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'y\n' } })
      const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
      assert.equal(code, 1, out)
      const verdict = JSON.parse(out)
      assert.equal(verdict.verdict, 'FAIL')
      assert.ok(verdict.failed.includes('ownership'), out)
      assert.match(out, new RegExp(sha))
    })
  })
}

test('the same attack on the last integration is caught by finish', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'y\n' } })
    await evilMerge(root, 'fleetmates/r1/T2', async () => {
      await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }), 'utf8')
      await writeFile(path.join(root, 'rogue.mjs'), 'smuggled\n', 'utf8')
    })
    const { code, out } = await runCliOn(root, ['finish', '--run', 'r1', '--plan', 'plan.md', '--base', 'main'])
    assert.equal(code, 1, out)
    assert.match(out, /failed: ownership/)
    assert.doesNotMatch(out, /ready to land/)
  })
})

// Swaps the committed plan for `plan` on the base before anything is dispatched, so the anchor
// reads it — the only place a `(protected)` marking counts.
function replacePlanOnBase(root, plan) {
  git(root, ['checkout', '--quiet', 'main'])
  execFileSync('git', ['rm', '--quiet', 'plan.md'], { cwd: root })
  return writeFile(path.join(root, 'plan.md'), plan, 'utf8').then(() => {
    git(root, ['add', 'plan.md'])
    git(root, ['commit', '--quiet', '-m', 'plan'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--ff-only', 'main'])
  })
}

const MANIFEST_TASK_PLAN = (modifier) => `### Task 1: A

**Files:**
- Create: \`a.mjs\`
- Modify${modifier}: \`fleetmates.gate.json\`
`

test('a teammate editing the manifest it declares but does not mark is blocked at stop time', async () => {
  await withRepo(async (root) => {
    await replacePlanOnBase(root, MANIFEST_TASK_PLAN(''))
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n', 'fleetmates.gate.json': '{"phases":{}}\n' } })
    const { code, out } = await runCliOn(root, ['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--enforcement-only'])
    // 3 is the code the SubagentStop hook blocks on: the teammate hears it before it stops.
    assert.equal(code, 3, out)
    assert.match(out, /T1: protected — fleetmates\.gate\.json/)
  })
})

test('the same edit passes once the plan on the base marks it (protected)', async () => {
  await withRepo(async (root) => {
    await replacePlanOnBase(root, MANIFEST_TASK_PLAN(' (protected)'))
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    // The edited manifest still declares both checks, so what is being tested is the marking.
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n', 'fleetmates.gate.json': JSON.stringify({ ...MANIFEST, protected: ['package.json'] }) } })
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 0, out)
  })
})

test('a merge that leaves the manifest invalid records no verdict, and finish refuses', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    await evilMerge(root, 'fleetmates/r1/T1', async () => {
      await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ ...MANIFEST, protected: 'package.json' }), 'utf8')
    })
    const gate = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(gate.code, 2, gate.out)
    assert.match(gate.out, /protected must be an array/)
    assert.equal((await readStatus(root, 'r1')).gates?.['1'], undefined)
    const finish = await runCliOn(root, ['finish', '--run', 'r1', '--plan', 'plan.md', '--base', 'main'])
    assert.notEqual(finish.code, 0, finish.out)
    assert.doesNotMatch(finish.out, /ready to land/)
  })
})

test('an inline run fails the injected ownership check with the note, and --no-fleet keeps today\'s behaviour', async () => {
  await withRepo(async (root) => {
    // The shape sideswap_rust's `mainnet-dry-run` has: a manifest with no enforcement check,
    // `init-run` done, no task branch, and the work committed straight onto the run branch.
    git(root, ['checkout', '--quiet', 'main'])
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({
      phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } },
    }), 'utf8')
    git(root, ['commit', '--quiet', '-am', 'command-only manifest'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--ff-only', 'main'])
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await writeFile(path.join(root, 'a.mjs'), 'inline\n', 'utf8')
    git(root, ['add', 'a.mjs'])
    git(root, ['commit', '--quiet', '-m', 'inline work'])

    const fleet = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(fleet.code, 1, fleet.out)
    assert.match(fleet.out, /check injected: the manifest does not declare it/)
    assert.deepEqual(JSON.parse(fleet.out).injected, ['fileset', 'ownership'])

    const solo = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet'])
    assert.equal(solo.code, 0, solo.out)
    assert.match(solo.out, /--no-fleet: enforcement checks are not running/)
  })
})

test('LIMIT (unprotected conflict): an integrator\'s hand resolution of a conflict on an unprotected path is accepted', async () => {
  await withRepo(async (root) => {
    await replacePlanOnBase(root, `### Task 1: A

**Files:**
- Modify: \`shared.txt\`

### Task 2: B

**Files:**
- Modify: \`shared.txt\`

**Depends:** T1
`)
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'shared.txt': 'one\n' } })
    await taskBranch(root, 'r1', 'T2', { files: { 'shared.txt': 'two\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    try { git(root, ['merge', '--quiet', '--no-ff', 'fleetmates/r1/T2']) } catch { /* conflict, resolved below */ }
    await writeFile(path.join(root, 'shared.txt'), 'anything the integrator chose\n', 'utf8')
    git(root, ['add', 'shared.txt'])
    git(root, ['commit', '--quiet', '--no-edit'])
    const { out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    const ownership = JSON.parse(out).results.find((r) => r.name === 'ownership')
    assert.equal(ownership.status, 'pass', out)
  })
})

// Reachability from a task branch used to explain every commit on the run branch that a LATER
// task branch forked past. A direct write made before the next phase was dispatched was then
// carried in that phase's history and read as explained, by every gate and by `finish`.
test('a direct write to the run branch is not explained by a task branch that forked after it', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await writeFile(path.join(root, 'sneaky.mjs'), 'x\n', 'utf8')
    git(root, ['add', 'sneaky.mjs'])
    git(root, ['commit', '--quiet', '-m', 'direct write before dispatch'])
    const sha = git(root, ['rev-parse', 'HEAD']).trim()
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1, out)
    assert.match(out, new RegExp(sha))
  })
})

// Review round on the first-parent rule: excluding only the chain left a side door. The integrator
// commits the payload on a throwaway branch and merges THAT with an ordinary --no-ff, so the payload
// sits off the chain; the next phase's branch forks after the merge and vouched for it again, and
// the merge's secondary parent read as "owned" the same way. The merge is now judged by what it
// carries: only files declared by the tasks whose branches hold its secondary parents.
test('an integrator payload merged in from a side branch is not vouched for by the next phase', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    git(root, ['checkout', '--quiet', '-b', 'side'])
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }), 'utf8')
    await writeFile(path.join(root, 'rogue.mjs'), 'smuggled\n', 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '--quiet', '-m', 'payload'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate side', 'side'])
    const sideMerge = git(root, ['rev-parse', 'HEAD']).trim()
    git(root, ['branch', '--quiet', '-D', 'side'])
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'y\n' } })

    const gate = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(gate.code, 1, gate.out)
    assert.match(gate.out, new RegExp(`merge ${sideMerge} carries fleetmates\\.gate\\.json, rogue\\.mjs`))
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T2', 'fleetmates/r1/T2'])
    const finish = await runCliOn(root, ['finish', '--run', 'r1', '--plan', 'plan.md', '--base', 'main'])
    assert.equal(finish.code, 1, finish.out)
    assert.doesNotMatch(finish.out, /ready to land/)
  })
})

// The first-parent chain is read from the run branch as it stands, and a hand-built commit can give
// the run tip any first parent. Rebuilding the tip with `commit-tree` so its first parent is the
// anchor collapses the chain to that one commit and puts every earlier write back off it — but the
// forged tip is itself a chain merge, and what it carries against the anchor includes the write,
// which no task whose branch holds its secondary parent declares.
test('a run tip rebuilt with the anchor as its first parent does not launder an earlier direct write', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    const anchor = git(root, ['rev-parse', 'HEAD']).trim()
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'rogue.mjs'), 'smuggled\n', 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '--quiet', '-m', 'direct write'])
    const tip = git(root, ['rev-parse', 'HEAD']).trim()
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim()
    const forged = git(root, ['commit-tree', tree, '-p', anchor, '-p', tip, '-m', 'forged tip']).trim()
    git(root, ['update-ref', 'refs/heads/run-branch', forged])
    git(root, ['reset', '--quiet', '--hard', 'run-branch'])
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'y\n' } })
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1, out)
    const ownership = JSON.parse(out).results.find((r) => r.name === 'ownership')
    assert.equal(ownership.status, 'fail', out)
    assert.match(ownership.output, new RegExp(`merge ${forged} carries .*rogue\\.mjs`))
    assert.ok(tip)
  })
})

// Review round 2: a task branch that already landed grows a commit outside its declared set and is
// merged again as if it were a fix round. Its old tip is legitimately its own, the change is a clean
// single-side contribution, and `fileset` only diffs the phase in progress.
test('re-merging an integrated task branch that grew a commit outside its declared set fails ownership', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    git(root, ['checkout', '--quiet', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'x\n// touch\n', 'utf8')
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }), 'utf8')
    await writeFile(path.join(root, 'rogue.mjs'), 'smuggled\n', 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '--quiet', '-m', 'payload on an integrated branch'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 're-integrate T1', 'fleetmates/r1/T1'])
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'y\n' } })
    const gate = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(gate.code, 1, gate.out)
    assert.match(gate.out, /carries fleetmates\.gate\.json, rogue\.mjs/)
  })
})

// LIMIT (tamper-evident spec, "Not defended against"): a landed task's ref moved onto the run tip
// no longer has its own commits on its first-parent chain, so its first integration merge is
// integrated by no task. A fix round never does this — `brief --fix-round` keeps the branch — and
// round 3 showed that crediting a branch for what it merely holds lets every later phase's branch
// widen every earlier merge. The cost is a false FAIL that names the merge, never a false PASS.
test('LIMIT: a landed task whose ref was moved to the run tip fails ownership on its first merge', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    git(root, ['branch', '--quiet', '-f', 'fleetmates/r1/T1', 'run-branch'])
    git(root, ['checkout', '--quiet', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'x fixed\n', 'utf8')
    git(root, ['commit', '--quiet', '-am', 'T1 fix round'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 're-integrate T1', 'fleetmates/r1/T1'])
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'y\n' } })
    const { out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    const ownership = JSON.parse(out).results.find((r) => r.name === 'ownership')
    assert.equal(ownership.status, 'fail', out)
    assert.match(ownership.output, /merge [0-9a-f]{40} carries a\.mjs, which no task it integrates declares/)
  })
})

// Review round 3: with skip-worktree (or assume-unchanged) on the manifest, an edit to it in the
// main worktree never reaches `status --porcelain`, so the gate read a rewritten manifest from a
// tree it reported clean. `ownership` now names the flag.
test('gate fails when the manifest is hidden from status by skip-worktree', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    const t1 = await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'a\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', t1])
    git(root, ['update-index', '--skip-worktree', 'fleetmates.gate.json'])
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }), 'utf8')
    assert.equal(git(root, ['status', '--porcelain']), '')
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.notEqual(code, 0, out)
    assert.match(out, /fleetmates\.gate\.json is marked skip-worktree or assume-unchanged/)
  })
})

// The gate prints its verdict as JSON, and check output quotes file names an agent chose.
// `JSON.stringify` leaves the C1 range raw, and U+009B is CSI to a terminal decoding C1.
test('gate output carries no raw C1 control from an agent-chosen file name', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    const t1 = await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'a\n', 'z\u009b2J': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', t1])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.notEqual(code, 0, out)
    assert.doesNotMatch(out, /[\u0080-\u009f\u2028\u2029]/)
    assert.match(out, /z<0x9B>2J/)
    JSON.parse(out)
  })
})

// Review round 3 (tests lens): the per-merge scope rule's protected clause had no test of its own.
// A task that declares the manifest without marking it, landed, grows a manifest edit and is merged
// again: the file is in the task's declared set, so only the protected clause can fail it.
test('re-merging a landed task that declares the manifest without marking it fails ownership', async () => {
  const plan = PLAN.replace('- Create: `a.mjs`', '- Create: `a.mjs`\n- Modify: `fleetmates.gate.json`')
  assert.notEqual(plan, PLAN)
  await withRepo(async (root) => {
    // On the base, since the plan is read at the anchor; run-branch has no commits of its own yet.
    git(root, ['checkout', '--quiet', 'main'])
    await writeFile(path.join(root, 'plan.md'), plan, 'utf8')
    git(root, ['commit', '--quiet', '-am', 'declare the manifest in T1'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--ff-only', 'main'])
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    git(root, ['checkout', '--quiet', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }), 'utf8')
    git(root, ['commit', '--quiet', '-am', 'manifest edit on a landed branch'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 're-integrate T1', 'fleetmates/r1/T1'])
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'y\n' } })
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1, out)
    const ownership = JSON.parse(out).results.find((r) => r.name === 'ownership')
    assert.equal(ownership.status, 'fail', out)
    assert.match(ownership.output, /carries fleetmates\.gate\.json, which no task it integrates declares \(or marks/)
  })
})

// Review round 4: the repo config is writable by whoever the gate judges. An fsmonitor hook that
// reports nothing changed hid a rewritten manifest from `status`; the gate now runs its trusted
// `status` with fsmonitor off and full stat checks on.
test('gate fails when an fsmonitor hook hides a rewritten manifest from status', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    const t1 = await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'a\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', t1])
    const hook = path.join(root, '.fleetmates', 'fsmonitor.sh')
    await writeFile(hook, '#!/bin/sh\nprintf "tok\\0"\n', { mode: 0o755 })
    git(root, ['config', 'core.fsmonitor', hook])
    git(root, ['status', '--porcelain'])
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }), 'utf8')
    assert.equal(git(root, ['status', '--porcelain']), '')
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.notEqual(code, 0, out)
    const ownership = JSON.parse(out).results.find((r) => r.name === 'ownership')
    assert.match(ownership.output, /main worktree has uncommitted changes/)
  })
})

// Review round 4: scope and authorisation were unions over the whole merge, so in an octopus one
// task's declared set covered a sibling parent's change. T1, landed, grows a commit writing b.mjs
// (T2's file) and is re-merged in one octopus with T2: each parent must stay inside its own set.
test('an octopus does not let one task\'s declared set cover a sibling parent\'s change', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    git(root, ['checkout', '--quiet', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'b.mjs'), 'smuggled\n', 'utf8')
    git(root, ['add', 'b.mjs'])
    git(root, ['commit', '--quiet', '-m', 'payload'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    const t2 = await taskBranch(root, 'r1', 'T2', { files: { 'c.txt': 'c\n' } })
    git(root, ['checkout', '--quiet', t2])
    git(root, ['rm', '--quiet', 'c.txt'])
    await writeFile(path.join(root, 'b.mjs'), 'smuggled\n', 'utf8')
    git(root, ['add', 'b.mjs'])
    git(root, ['commit', '--quiet', '-m', 'T2 writes its own file'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'octopus', 'fleetmates/r1/T1', t2])
    const { out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    const ownership = JSON.parse(out).results.find((r) => r.name === 'ownership')
    assert.equal(ownership.status, 'fail', out)
    assert.match(ownership.output, /carries b\.mjs/)
  })
})
