# Tamper-Evident Enforcement — Final Scope

Date: 2026-08-05
Status: approved, pre-implementation
Supersedes `2026-08-05-boundary-enforcement-design.md` and closes the sequence begun in
`2026-08-05-runtime-enforcement-design.md`.

## What happened, briefly

Four designs were attempted. Three were defeated, each one layer below the last, and every
defeat was reproduced by running it:

| Design | Authority it trusted | How it fell |
|---|---|---|
| Runtime enforcement | `status.json` | Teammate rewrites it; `integrated` resets the baseline. |
| Adversarial enforcement | Git ancestry | Teammate plants a tag shadowing a branch (diff reads empty); teammate fast-forwards the run branch and creates the other tasks' branches, so every phase reads integrated and no check runs. |
| Boundary enforcement | A command allowlist in a harness hook | Every permitted verb executes teammate-authored code: `npm test` via `package.json`, `git commit` via `.git/hooks/`, **`git status` via `core.fsmonitor`**, `node --test` by definition. Three files were written outside the clone by approved commands. |

The pattern is not a sequence of oversights. It is one fact surfacing repeatedly:

> A `tm-implementer` must write code and execute it. Executing teammate-authored code **is**
> arbitrary execution. No allowlist can separate "run your tests" from "run anything",
> because they are the same operation.

Preventing that requires containing execution — an OS-level sandbox — which is infrastructure
this plugin does not have and will not acquire here. Everything short of it raises the cost of
an attack without preventing one.

So this spec stops claiming prevention.

## What this delivers

**Tamper-evident enforcement.** The gate detects violations that arise from drift, confusion,
mistakes, and attacks that are not specifically aimed at the gate. It records what it checked
and what it found. It does not stop a teammate that is deliberately targeting it.

That is a smaller claim than the previous specs made, and it is the one the code can keep.

### Enforced, and verified by tests

- **V1 fileset** — each task branch, resolved through a fully-qualified `refs/heads/` name to
  a sha, diffed against the run anchor. Any changed path outside the task's declared files is
  a violation. Renames report both pre- and post-image.
- **V2 ownership** — no task branch may be the run branch under any alias spelling; the main
  worktree must be clean; every commit on the run branch since the anchor must be reachable
  from a task branch — except a commit on the run branch's own first-parent chain, which only
  the merge rule can explain, and that rule also requires each integration merge to carry only
  files the tasks it integrates declare (2026-09-26: reachability let the next phase's branches,
  forked from the run tip, vouch for every earlier write to the run branch).
- **V4 non-removable enforcement** — `fileset` and `ownership` are injected into any phase whose
  manifest omits them, so a merge that rewrites the manifest cannot switch off the check that
  reports it. The manifest may add to them, never narrow them.
- **V5 protected paths** — a task that changes the manifest, or a path in its `protected` list,
  fails `fileset` unless its plan line at the anchor marks it `(protected)`; a hand-resolved
  conflict on such a path fails `ownership` unless a task the merge integrates marks it (a base
  merge may resolve one on a file only the base changed — see "Not defended against"). See
  `docs/specs/2026-09-26-protected-paths-design.md`.
- **V6 test inventory** — a `command` check with a `report` is run again on the run tip before the
  phase; a test that ran and is now absent or skipped fails `<name>:inventory` unless a phase task
  marks its file `(drops)`, and a new test skipped in the gate environment fails it unless the
  protected manifest's `skips` declares the unit. See `docs/specs/2026-09-26-test-inventory-design.md`.
- **V3 completion** — `complete` recomputes the gate rather than reading a recorded verdict.
  A forged or stale `status.json` PASS buys nothing.
- **Phase derivation** — from what is actually merged, never from a stored field. Out-of-order
  integration is an error, not a guess.
- **Fail-closed inputs** — unresolvable refs, missing branches, git errors, and a phase that
  selects zero tasks are all failures, never passes.

### Not defended against — the honest list

These are known, reproduced, and deliberately out of scope. Each must appear in the docs
where the corresponding claim is made:

- **Write access to the base branch.** A `(protected)` marking is authoritative because the plan
  is read at the anchor; whoever can commit to the base can mark anything, including a task that
  drops every command check from the manifest. For the same reason a merge whose secondary parent
  comes from the base may hand-resolve a conflict on a protected path the base itself changed:
  that is the operator's amendment merge, and no task branch could ever carry its base parent to
  authorise it.
- **A landed task's authority has no phase bound.** Task refs are agent-writable. An integrator
  that extends a landed task's branch in a later phase and merges it again is judged by that
  task's declared set and markings, as a fix round would be; a marked task can then change its
  protected path after its own phase's review. Bounding it by refs would be forgeable by the same
  write.
- **A landed task's ref moved onto the run tip** loses the task's own commits from its
  first-parent chain, so its earlier integration merge fails `ownership` — a false FAIL, reported
  with the merge named, never a false PASS.
- **A hand-resolved conflict on an unprotected path.** Accepted unverified, as before; pinned by
  a LIMIT test.
- **A loosened assertion.** `assert.equal(x, 5)` → `assert.ok(x)` keeps the test running, so the
  inventory does not move. Pinned by a LIMIT test; the `tests` review lens judges it.
- **A test that writes its own report.** The JUnit report comes from a process running teammate
  code; a test file that drops a forged report into `$FLEETMATES_REPORT_DIR` controls the
  inventory. Pinned by a LIMIT test — the same boundary as "a teammate that runs arbitrary code".

- **A teammate that runs arbitrary code.** It has Bash with the user's permissions. It can
  write any file, including its own `package.json`, `.git/hooks/`, and `.git/config`.
- **Self-integration, in two shapes.** Both confirmed, both out of scope for the same reason as
  arbitrary code execution.

  1. A teammate creates its own task branches, does real work on each, and merges them into the
     run branch itself, bypassing `tm-integrator`. Every branch then carries its own work off its
     own fork point, which is exactly the shape legitimate integration has; the only difference
     is who ran the merge, and git does not record that in a form this gate can trust.
  2. A teammate points a task ref at a merged SIBLING's tip. T3 commits `c.mjs` and is merged
     `--no-ff`; T2's ref is then pointed at T3's tip and never moves. T2's sha is a genuine
     secondary parent of that merge and genuinely inside `anchor..run`, so `deriveContext` hands
     back T3's fork point and credits T2 with `c.mjs`, while `b.mjs` — T2's only declared file —
     never reaches the run branch at all. `runFilesetCheck` has the symmetric hole via
     `mergedBranchTips`, which asks the same membership question. The fork-point base cannot
     separate these: the ref sits at a commit that really was merged, just not as this task.

     A signal exists and is not checked anywhere today: in this shape **two task refs resolve to
     the identical sha**, and the gate already reports every task branch's sha in `branchShas`.
     Recorded here so a future check does not have to rediscover it; nothing implements it yet.

     It is a signal and **not a decision procedure**, which is the part worth writing down.
     Refusing both tasks on a shared sha was implemented and reverted: two teammates dispatched
     together and not yet committed share the run tip as their ordinary, benign state, and once
     anything else lands — a plan amendment, this repo's own documented procedure — that shared
     sha is no longer the run tip. The check then accuses two idle, honest teammates of parking.
     That is the same false positive two earlier discriminators produced (`not the run tip`, and
     `git.mergedBranchTips` membership), and `gate does not treat two idle siblings as parked when
     an unrelated commit moves the run tip past them` pins it. Sharing a sha says at most one task
     did that commit's work; it does not say either of them was *supposed* to have done it yet,
     and the honest reading of the common case is "neither has committed", which the ordinary
     empty-diff message already reports correctly. Any future use of this signal has to add
     something that separates "shares a sha" from "shares a sha *and* should not", or it will
     rediscover this regression.

  3. The RUN-TIP variant, now caught by SCARCITY rather than left open. A ref sitting exactly at
     the run tip is named by no merge, so the declared-files predicate has nothing to attribute
     by and used to read false unconditionally — which failed a genuinely landed task whose ref
     a fix round re-pointed with the brief's own `git checkout -B <task> <run branch>`.
     `creditRunTipTasks` credits such a ref only by matching it to a merged parent that carried
     its WHOLE declared set and that **no other task ref already points at**, one task per
     parent. A merged contribution was earned once and can only be spent once.

     A first attempt (`f6e2191`, reverted by `227abf2`) asked containment alone — "did some
     merged parent carry this task's whole declared set" — and was a fail-open in the routine
     case: the gate for phase N runs before any phase-N branch is merged, so an idle phase-N ref
     sits exactly at the run tip, and a phase-2 task that only MODIFIES a file phase 1 created
     has its declared set contained in phase 1's merge by construction. Executed: T1 merges
     `a.mjs` + `b.mjs`, T2 declares only `a.mjs` and writes nothing, verdict PASS. Under
     scarcity T1's own ref still points at that parent, so it is spent and T2 matches nothing.
     Attributing by the merge SUBJECT was rejected on the `status.json` grounds — `tm-integrator`
     writes that subject and is one of the enforced parties.

     The **spare parent** — two merges crediting the same task, an initial integration plus a fix
     round's own merge, leaving one parent claimed by no ref — was a residual of the first
     scarcity version and is now closed too. `spentParents` spends a parent that is an ANCESTOR of
     a task ref whose declared set the parent's carried files intersect, not only one a ref points
     directly at. Both halves are pinned: ancestry alone would spend a phase-1 parent on behalf of
     any phase-2 task that forked after it and reintroduce the original false FAIL, so the
     declared-set intersection is what keeps a later task from spending a parent it never earned.

     No residual is currently known for the run-tip position. That is a statement about what has
     been executed against it — the four shapes above plus the spare parent and the later-sibling
     guard — not a proof that none exists.

  One variant that used to sit in this bullet is now CAUGHT, and is pinned in
  `tests/adversarial.test.mjs` under the defended section: a teammate pointing a task ref at a
  run tip that already carries someone else's real work, and committing nothing itself.
  `deriveContext` measures every task branch against its own fork point off the run branch
  rather than against the run anchor, so such a ref shows no work of its own, its phase does not
  read as integrated, and the fileset check runs against it instead of being skipped by the
  "every phase in the plan is integrated" fast path. The same base also catches a ref parked at
  the anchor after a plan amendment merged the base branch in, because the merge index behind it
  counts only parents inside `anchor..run`. A branch integrated by fast-forward is
  indistinguishable from one parked at the same commit and is failed too — `tm-integrator`'s
  contract is `--no-ff`, so that state is out-of-contract rather than undetected.
- **A teammate that forges run state.** `.teammates/` is writable. Nothing reads it for a
  verdict, so this buys little — but the digest and supervision output can be made to lie.
- **Uncommitted work.** The gate reads commits. The claim is precisely "committed changes
  stayed in the declared set".
- **A teammate that edits the enforcement code.** Out of reach in a normal install, where the
  CLI lives at `CLAUDE_PLUGIN_ROOT`; reachable in this repo, which is its own plugin.
- **A run whose base branch is another run's branch.** Not a hole in `ownership` — the opposite:
  the check reports what is there, and what is there is unowned. Run `followups2` used
  `run/claims`, another run's deliverable branch, as its base. The amendment procedure commits an
  amendment on the BASE branch, so four plan amendments landed on `run/claims` — `3a5d074`,
  `39cbd61`, `5f46838`, `c9a122c` — on top of `8897e38`, which created the same plan file. Counted
  from `git log --oneline run/claims`, that is FIVE commits above `09f5ad9 merge: teammates/claims/T3`,
  each touching only `docs/plans/2026-08-11-run-claims-followups.md`. "Unowned commits" is the
  accurate noun rather than "amendments": one of the five creates the plan rather than amending it,
  and `ownership` does not distinguish the two — it asks only which task branch explains a commit.
  Evaluated for run `claims`, `ownership` reported those commits as reachable from no task branch of
  that run and from no ancestor of ITS base, which is exactly what they are.

  That report is not permanent, and its answer depends on the base it is run against. Measured today
  with base `master`: `git merge-base master run/claims` is `c9a122c`, the tip of `run/claims`
  itself, so the derived anchor equals the run sha, the commit range `anchor..run` is EMPTY, and
  `ownership` has nothing to report and passes. `run/claims` landed to `master` inside
  `run/claims-followups`, which made it an ancestor of `master` and moved the anchor onto the run
  tip. Only against a base predating that landing — `fff2307^1`, that is `7bd2e0c` — does the anchor
  fall back far enough for the range to hold 23 commits and for `ownership` to name the five. So the
  check has no memory of the violation; the record of it lives in this spec and in the permanent
  history of the default branch — `run/claims` reached `master` through `fff2307`, so
  `git log --oneline run/claims` still lists those five commits above `09f5ad9` in a fresh clone
  that has no reflog at all. Do not send a reader to `git reflog` for them: reflog entries are
  local to one clone and expire (90 days by default), so it is the least durable copy of the
  evidence rather than the record. Read the emptied range forward as well as backward: when the
  derived anchor equals the run sha the range `anchor..run` holds nothing, so an `ownership` PASS
  computed in that state inspected zero commits, and the gate prints it identically to a PASS over
  a non-empty range. A green `ownership` on a run already merged into its base is therefore not
  evidence that anything was checked — a consequence of anchor derivation, not a second hole in
  the check. (The
  gate for run `claims` does still fail today, but on `fileset`, for an unrelated reason — do not
  read that failure as this one.) Nothing was rewritten to hide the commits, and the content
  still landed, because `run/claims` was an ancestor of `run/claims-followups`. The remedy is
  procedural and is stated in `skills/parallel-execution/SKILL.md`: branch a run's base from the
  default branch, not from another run's branch, and land a first run before stacking a second on
  it. **No ownership exception is added for this.** Every exception is a way to launder an unowned
  commit, and one accepting anything reachable from a parent run's branch would accept precisely
  the commit the check exists to catch.
- **A compromised orchestrator.**

## Documentation rule

Every place the plugin asserts an enforcement guarantee must state its limit in the same
breath. Specifically:

- `agents/tm-implementer.md` — "this is checked" is accurate; add that the check reads
  committed changes.
- `skills/phase-gate/SKILL.md` — a section stating the model: catches drift and mistakes,
  not a determined agent, with the reason (running a teammate's tests is arbitrary execution).
- `README.md` — one paragraph, so the claim is visible before install rather than discovered
  during a review.

A guarantee stated without its limit is the defect that started this work:
`tm-implementer.md` claimed the gate enforced a file set when no such check existed.

## What is dropped

- `hooks/pre-tool-use.mjs` and the `PreToolUse` wiring — not built.
- `scripts/boundary.mjs` and `tests/boundary.test.mjs` — not merged. The work was correct for
  what it was asked to do; the approach cannot deliver the guarantee. `teammates/bnd/T1` is
  abandoned.
- Clone isolation, `prepare-clone`, `collect` — not built. Teammates keep worktrees.

## What is kept from completed work

Both are merged into the remaining plan and are independently valuable:

- `scripts/git.mjs` (`teammates/bnd/T2`) — the six ancestry methods, `resolveRef` requiring a
  fully-qualified ref, `teammateRef`, `fetchRefspec` with `--no-tags`, and the trailing `--`
  on the commands that accept it. **This closes the confirmed tag-shadowing bypass**, which
  matters under the tamper-evident model too: a stray tag is exactly the kind of accident this
  model is meant to catch.
- `scripts/enforce.mjs` (`teammates/bnd/T3`) — convention-only branch resolution, the
  `{phase}|{error}` derivation, reachability-shaped ownership, `verdictCoversTree`, `planHash`.

## Remaining work

1. `scripts/gate-runner.mjs` — derived `fileset` and `ownership` checks over resolved shas;
   prototype-safe dispatch; a throwing check becomes a recorded failure.
2. `scripts/cli.mjs` — `gate` and `complete` recompute; `integrated` deleted; `--no-fleet` is
   the only skip; `status.json` written as a report.
3. `teammates.gate.json` and `inferGateConfig` — ship both checks.
4. Prose — the documentation rule above, across agents, skills, and README.
5. Adversarial tests — each documented attack that IS defended asserts failure; each attack
   that is NOT defended gets a test asserting the current behavior, so the limit is pinned
   rather than assumed.

Item 5 matters most. A limit that is written down but untested drifts into a claim.

## Global constraints

- Node stdlib only; Node >= 24.2; ESM named exports; injectable side effects
- `scripts/enforce.mjs` stays import-free
- Every rev argument fully qualified and resolved to a sha before use
- No subcommand may mutate enforcement authority
