---
name: parallel-execution
description: Use when executing a written plan across background teammates - splits it into phases, dispatches worktree-isolated implementers, and integrates results.
---

# Parallel Execution

## 1. Initialize the run

Create and check out this run's branch **before** initializing, then run `init-run` from it:

    git checkout -b <run branch> <base branch>    # e.g. run/<runId> from master
    node "<fleetmates root>/scripts/cli.mjs" init-run <planPath> --run <runId> --root <project root>

This writes `.fleetmates/<runId>/plan.json` and `status.json` and prints the phase breakdown.
Tasks land in the same phase only when their deps are satisfied and their file sets are
disjoint.

The order matters for enforcement, not just tidiness. `init-run` records a run branch by
fill-if-absent: it records HEAD when the run has no `runBranch` recorded yet **and** HEAD is not the
base branch, and it records nothing when HEAD is the base. A value already recorded always wins —
`writePlan` resolves the field as `carried ?? usable` — so a re-init from a different branch keeps
the old record and prints a note naming the branch it kept. Compare that name by bytes rather than
by eye: the check is byte-wise, and zero-width and homoglyph characters render identically in a
terminal.

It records nothing at all wherever it cannot resolve the base on its own: it derives the base
itself and takes no `--base`, so a repository holding both `main` and `master`, or neither, throws
into a catch that leaves the field unset, and no §1 order can arm anything there until a command
that does take `--base` records it.

One input escapes that description: a
recorded empty string is carried like any other, then dropped on write because it is falsy, so the
field disappears, the note names no branch, and the run ends up with no record rather than the one
it reports keeping.

That record does not resolve a stopping teammate to its task — the worktree location record written
by `locate` does that. What it decides is whether the stop-time checks are allowed to be a verdict:
`complete --enforcement-only` compares the recorded run branch against the branch the main worktree
has checked out, and when it is absent or different it reports that it cannot verify completion and
the stop is allowed. Checking the run branch out before the **first** `init-run` is therefore what
puts the record in place at the start of the run, on a run id that has none yet. It does not repair a run whose
recorded branch is already wrong: no command overwrites that field. To correct one, remove
`runBranch` from `.fleetmates/<runId>/plan.json` and run `init-run` again — from an attached branch.
An absent record needs no hand-editing: some later commands fill it in and others only read it, so
read `runBranch` in `.fleetmates/<runId>/plan.json` rather than predicting which.
On a detached HEAD `init-run` records the literal string `HEAD`, which is not a run branch and
which no command overwrites, so it disarms the second layer until the field is removed by hand.

When `init-run` records nothing it prints a note directing you to check the run branch out before **gating**; the note
concerns `gate` refusing to run from the base branch, and a checkout on its own records no run
branch.

## 2. Dispatch the phase

Phases with **three or more** tasks go through the Workflow tool:

    node "<fleetmates root>/scripts/cli.mjs" workflow --run <runId> --phase <n> --root <project root>

Write that source to a file and invoke `Workflow` with it. The Workflow tool needs the user's
opt-in — ask once per run, then remember it for that run.

**If the user declines, or the Workflow tool is unavailable, do not stop.** Fall back to the
direct-agent path below for the whole phase: dispatch each task as its own background `Agent`
with `isolation: 'worktree'`, respecting `maxParallel`. The result contract is identical, so
nothing downstream changes. Say which path you took.

Phases with fewer than three tasks are dispatched as direct background `Agent` calls with
`isolation: 'worktree'` and the `tm-implementer` persona. Same result contract either way.

On either direct-`Agent` path — the fallback above and the fewer-than-three-task case — build each
teammate's brief with the CLI rather than composing it by hand:

    node "<fleetmates root>/scripts/cli.mjs" brief --run <id> --task <id> --plan <path> --base <branch> --root <project root>

The Workflow path already renders each brief from the same composer, so a hand-written dispatch is
only ever a way to drift from what the gate enforces.

On a pure direct-`Agent` phase a teammate can stop before any other lifecycle command has run. The
`SubagentStop` hook does two cheap things at that moment: it blocks a teammate whose task branch
does not exist, and it runs `complete --enforcement-only`. That run keeps every non-`command`
check the manifest declares, plus `merge`, which the gate computes for itself. Do not declare `merge` in the manifest: it finds
no runner there and lands as a `pending` that fails the gate verdict beside the computed result, an `agent` check declared there finds no runner
either, though it fails the verdict only when it is not marked optional. Only a
task-scoped failure refuses the stop, meaning `fileset` or `merge`, so a refused stop is not always about a
file set; an `ownership` failure with no task-scoped failure beside it is reported and the stop is allowed. The
teammate is shown none of that detail — the hook reads the exit status and never forwards what the
check printed.

Treat both as best effort. The hook resolves a stopping teammate through records under
`.fleetmates/`, which is gitignored and writable by every teammate, and it allows the stop on
anything it cannot establish — a teammate it cannot resolve, a plan it cannot read, a recorded run
branch that is not the branch checked out. That is deliberate. The hook can only ever add a block that would
not otherwise happen, so declining to block on anything it cannot establish is what keeps an unreadable record from costing a teammate a turn. It is not a guarantee against
being blocked over foreign state: the records are teammate-writable, so a planted location record makes the hook establish
something false and block whoever stops in the worktree that record keys on — resolution is by
worktree path, not by teammate identity, and any linked worktree of this repository qualifies,
including a reviewer's scratch one. One plant costs one forced retry, since the next stop carries
`stop_hook_active`.

What this buys is a fast signal on the common honest mistake, not a barrier against a determined
one. The enforcement is the phase gate: its `fileset` and `ownership` checks recompute from git and
read nothing under `.fleetmates/`, whatever else the command around them reads. Which checks run is
another matter: that list comes from `fleetmates.gate.json` in the working tree, which every teammate
can write, and an `agent` check's result comes from files under `.fleetmates/` the enforced teammate
can write too. Do the §1 order because it is what lets
`complete --enforcement-only` reach a verdict; the branch-existence check does not depend on it and
blocks whether or not a run branch was ever recorded. Never read a stop that was allowed as a
verdict.

Wait on completion notifications. Do not poll in a loop.

### On a harness other than Claude Code

When the orchestrator is not Claude Code, the Workflow tool and background `Agent` calls do not
exist. Dispatch the whole phase through the CLI instead:

    node "<fleetmates root>/scripts/cli.mjs" dispatch --run <id> --phase <n> --harness <name> --root <project root>

This is worktree-isolated and gate-identical: it produces the same result contract the Workflow
and Agent paths do, and resuming a run re-runs the same `dispatch`. The harness name is the one
the orchestrator is itself running in, passed explicitly.

## 3. Record results

Append every result to `status.json`. A teammate that returned nothing is `orphaned`, not
`done` — offer to respawn it.

Before dispatching a later phase, check whether the plan still describes the tree:

    node "<fleetmates root>/scripts/cli.mjs" plan-drift --run <runId> --plan <planPath> --root <project root>

It compares the working-tree plan against the plan at the anchor and separates drift that still
reaches the work from drift on an already-integrated phase, which exits 1. A later task's brief
that describes interfaces earlier fix rounds replaced, or acceptance criteria still demanding
behaviour a security fix removed, both surface here — and both are corrected in the dispatch, not
only in the plan, because a dispatch already sent carries the old text.

A returned `done` is a claim, not evidence. Check it against git before believing it:

    node "<fleetmates root>/scripts/cli.mjs" doctor --run <runId> --plan <planPath> --root <project root>

A teammate that skipped its `checkout -B` commits on the harness's own branch and leaves
`fleetmates/<runId>/<taskId>` pointing at the run tip with nothing on it: the returned `branch`
names a real ref, the task merges as a no-op, and `fileset` sees no stray path because it sees no
path at all. `doctor` reports that branch as contributing nothing, along with anything else that
moved in the repository while the phase ran.

## 4. Gate, then integrate

Run `phase-gate`. Only on PASS, dispatch `tm-integrator` to merge the teammate branches in
dependency order with `--no-ff`. The integrator is the sole writer to the run branch and runs
alone. No bookkeeping call follows the merge: the next phase is derived from what is merged.

### Import coupling across tasks

A task whose file set imports a symbol another task introduces cannot build on its own branch.
Merging it first produces a commit whose tree cannot load. In run `followups2`, T2's
`scripts/doctor.mjs` imported `printable` from T3's `scripts/reviews.mjs`; on T2's own tip the CLI
died at import before printing its help, and merging T2 ahead of T3 would have carried that
unloadable tree onto the run branch. A revert of the providing task breaks every consumer, not only
the feature that motivated it.

The softer form leaves the tree loading and only a comment wrong. In run `followups3`, T3's change
to the CLI entrypoint carries a comment citing `reviewFileName` as precedent for wrapping before
quoting: true once T2's `scripts/reviews.mjs` is merged, false on T3 alone. Nothing fails to load —
the commit's comment is simply wrong about its own tree, and the merge order was given to the
integrator for that reason.

Both forms share one rule: the integrator merges in dependency order, and a reviewer judging a
cross-task claim judges it on the merge, not on one branch.

## 5. Clean up the phase

Once the phase has a recorded PASS and its branches are merged, remove what it left.

This is irreversible on every prunable worktree, not only a leaked preview: `git worktree
remove --force` runs whether or not a teammate's worktree still holds edits made after its
branch merged, and `--force` follows a junction out of the worktree to its target instead of
stopping at the boundary — verified on Windows, and exactly the shape a dependency install
during bootstrap (see "Worktree mechanics" below) can leave behind; nothing unlinks it first
the way a leaked preview's own links are unlinked, because that sweep runs only for previews:

    node "<fleetmates root>/scripts/cli.mjs" prune-run --run <runId> --plan <planPath> --root <project root> --yes

This is the only supported way to clean up after a phase. It recomputes each phase's gate rather
than reading `status.gates`, removes only this run's worktrees whose phase passes, sweeps every
leaked merge-preview worktree under the system temp directory regardless of which run left it —
even one holding an operator's own uncommitted work — deletes each removed worktree's branch
where `git merge-base --is-ancestor` proves it is already in the run branch — the run branch it
proves against is the ref HEAD symbolically points at, so no tag or same-named branch can
redirect that proof — and names every worktree it leaves alone with the reason. Do not remove a
worktree or delete a teammate branch by hand: `git worktree remove` refuses one holding
uncommitted work only until `--force` is added, and nothing then stops `--force` from reaching a
worktree whose phase has not passed yet; `git branch -D` does not measure "merged" at all — the
one thing it refuses is a branch a registered worktree still has checked out, which is why the
worktree has to go first, and otherwise it force-deletes regardless of ancestry — and `-d`, the
flag that does measure, measures against the branch's own upstream or HEAD, never against the
run branch. The one exception is a task going to a fresh implementer before its phase has
passed: this command cannot reach that worktree yet, so it still has to be removed by hand with
`--force` — authorised there because abandoning that teammate's unfinished worktree for a fresh
dispatch is the deliberate point, and a mid-stall worktree is exactly the one most likely to
hold modified or untracked files a bare remove refuses over — and that authorisation covers the
teammate's unfinished work only: `--force` still follows a junction out of the worktree the same
way, and nothing unlinks it first there either, so check the worktree for one first with
`dir /AL /S` and remove the link itself with `rd <link>` — both from cmd.exe, not PowerShell,
where
`rd` and `rmdir` are aliases for `Remove-Item`; never a recursive delete, which follows it —
before forcing — see the matching exception in "Worktree mechanics" below.

Without `--yes` it removes nothing and prints the prunable and leaked-preview lists it would
act on if nothing changes before the `--yes` run — both runs recompute the gate from scratch,
so a phase that fails a check during the dry run and passes during the `--yes` run has
worktrees force-removed that never appeared in the list the operator approved; the per-branch
"left `<branch>` in place: not an ancestor" line is decided only while `--yes` runs the
removal, so a dry run does not yet show which merged worktree's branch would survive.

## Choosing a model per dispatch

Every task in `plan.json` carries a `tier`, either declared in the plan or inferred by
`init-run`. Read it; do not re-derive it. Resolve it at dispatch:

    cheap    -> haiku
    mid      -> sonnet
    capable  -> opus

An omitted model inherits the session's, which is usually the most expensive tier, and that
cost multiplies across every teammate in a phase. Set it explicitly on every dispatch — task
dispatches and role dispatches alike. There is no dispatch that legitimately omits its model.

Role dispatches are fixed and not read from the plan: `tm-integrator` runs at `mid`,
`tm-reviewer` at `capable`. Review is the last line of defence before integration.

The `tm-integrator` dispatch carries the configured integrator tier and effort, read with
`config get agents.integrator.tier` and `config get agents.integrator.effort`. `config get` on
an unset key exits 2 with `unset: <key>` — the same exit code every hard config failure uses,
but here it is the normal case, not an error. Tier and effort fall back differently:

- `unset: agents.integrator.tier` — dispatch at the **fixed integrator tier, `mid`** (model
  `sonnet`). Do not omit the model to inherit the session's; the fixed role tier is the
  fallback. A configured tier replaces `mid`. The same shape holds for `tm-reviewer`, whose
  fixed tier is `capable` — see `phase-gate`.
- `unset: agents.integrator.effort` — omit the `effort` option, and the dispatch inherits the
  session's effort. Effort is the only option that falls back by omission.

These two keys are ergonomics, not enforcement, unlike the reviewer's tier and effort: the
integrator merges branches, it does not judge a check, so either layer may set them and the
gitignored `fleetmates.local.json` is the normal place to.

When generating a Workflow, pass the same map through so the generated dispatches carry
concrete models:

    node "<fleetmates root>/scripts/cli.mjs" workflow --run <id> --phase <n> --root <root> \
      --models '{"cheap":"haiku","mid":"sonnet","capable":"opus"}'

## Before dispatching tm-integrator

Detach the main worktree first:

    git checkout --detach

The integrator is the sole writer to the run branch and cannot check it out while the main
worktree holds it. Without this it has no supported way to advance the branch, and reaches for
`git update-ref`, which desyncs the main worktree's index from its HEAD. Re-attach after the
merge with `git checkout <run branch>`.

## Amending a plan mid-run

The gate reads the plan with `git show <mergeBase(base, runBranch)>:<planPath>` — never from the
working tree, so a teammate cannot widen its own file set by editing the plan in its worktree.
That also means an amendment committed only on the run branch changes nothing: the merge-base does
not move, and `fileset` still reads the old plan.

State the limit with the guarantee: the plan is read from git at the anchor, so a working-tree edit
is inert, but a commit on the base branch is authoritative by design and is not distinguishable
from an amendment the user made. A teammate has Bash; if it can move `refs/heads/<base>` it can
commit a widened `**Files:**` list for its own task, and once that reaches the anchor `fileset`
permits every path it declared for itself. What bounds this is write access to the base branch,
not the plan read.

To make an amendment authoritative:

1. Commit it on the **base** branch.
2. Merge the base into the run branch with `--no-ff`: that moves the merge-base onto the new base
   tip, and `ownership` accepts the merge because its secondary parent is an ancestor of the base.
   The limit on that acceptance: every secondary parent is checked, so a rogue parent riding
   alongside the base parent still fails. Merging the base into the run branch is the
   orchestrator's operation, not a `tm-integrator` dispatch: the integrator's contract is scoped to
   teammate branches after a passing gate, and an amendment happens precisely when neither holds —
   the base is not a teammate branch, there is no gate PASS (the failing gate is *why* the
   amendment exists), and the merge carries `planPath`, which belongs to no task's declared set, so
   a contracted integrator stops and reports rather than merges. Do it yourself: detach the main
   worktree with `git checkout --detach`, `git checkout <run branch>`, `git merge --no-ff <base>`,
   then re-attach the main worktree to the run branch.
3. Rebase any in-flight task branch onto the new run-branch tip. Not to avoid a `fileset` failure —
   that check diffs each branch from `mergeBase(runBranch, branch)`, the branch's own fork point,
   never from the anchor, so an un-rebased branch still diffs to its own changes only and that
   failure cannot occur. Rebase because the branch needs the amended plan and the interfaces
   earlier phases merged.

If a merge is not appropriate — the base diverged such that merging would drag unrelated work into
the run — rebuild the run branch on the new base tip and re-merge each task branch with `--no-ff`.
Rebuilding the run branch is the orchestrator's operation, not the integrator's: `tm-integrator`
does checkout plus `--no-ff` merge and reports `blocked` rather than reset or force-move a branch,
so a dispatch asking it to rebuild asks for something its contract does not cover.

Amend only when a task's declared file set is genuinely wrong. Correcting a stale *interface* — a
signature an earlier phase's fix rounds changed — belongs in the dispatch brief, not the plan.

Graduating a `## Not Yet Specified` entry into a task is this same operation, and no new command
exists for it: edit the plan — delete the fog entry, add a `### Task N` — commit it on the base
branch, merge `--no-ff` into the run branch, then re-run `init-run` so `plan.json` is recompiled
before rebasing any in-flight branch. A working-tree edit to the fog entry is inert for the same
reason any other plan edit is: the gate reads the plan from git at the anchor, not the tree.

**Branch a run's base from the default branch, not from another run's branch.** Step 1 commits the
amendment on the base, so if the base is another run's deliverable branch the amendment lands
there, where it belongs to no task of that run and to no ancestor of that run's own base — which is
what `ownership` then reports, correctly, whenever that branch is gated. Run `followups2` based on
`run/claims` did exactly this, and `ownership` gated on `run/claims` named five unowned commits:
nothing was rewritten to hide them, and no ownership exception is added to accept them, because an
exception broad enough to accept a parent run's branch accepts exactly what the check exists to
catch. That report does not last. Once `run/claims` landed to the default branch it became an
ancestor of it, the derived anchor moved onto the run tip, the commit range emptied, and `ownership`
now passes on `run/claims` — so do not count on the check to preserve the finding. Prevent it
instead: if work genuinely stacks, land the first run before starting the second.

## Invariants

- A teammate **never touches the main worktree**; it works only in its own.
- A teammate writes only the files its task declared. Strays are a gate failure, caught at
  merge.
- Phase N+1 does not start before phase N gets a PASS.

## Why fresh implementers, and how review fits between tasks

Each teammate is a **fresh** agent carrying only its own task's context — the brief for
that task, the interfaces it touches, and the global constraints. It never inherits the
session's accumulated history or another teammate's context. A dispatch built from pasted
history of prior tasks defeats this: hand over files and pointers, not narrative.

Review happens **between tasks, not only at the end**: each teammate's result gets its
task-scoped gate (Step 4) before the next phase starts, catching spec and quality gaps
while the context to fix them is still cheap. The broad review at branch completion
(`phase-gate`'s final pass) never substitutes for this — it catches cross-task drift, not
per-task defects.

If a teammate needs a fix round, address the live teammate first: `SendMessage` the teammate that
owns the failing task, by the id its dispatch returned, with the finding text. Its worktree still
holds the context a cold respawn would have to rebuild. Respawn on that task only when that
teammate is gone; a respawned teammate re-runs `locate`, which overwrites the record with its new
worktree. Note in `status.json` that the task restarted.

**Brief a fix-round respawn with `brief --fix-round`, never the ordinary brief.** The ordinary
one opens with `git checkout -B <branch> <base>`, which resets the task branch to the base and
destroys the very work the round was convened to repair. `--fix-round` emits the same brief with
a checkout that does not reset, and tells the teammate to report `blocked` rather than free a
branch a dead worktree still holds — that removal is yours, because the worktree guard blocks a
teammate from touching another worktree at all. A teammate inside a running `Workflow`
cannot receive `SendMessage`, so a phase dispatched through the `Workflow` tool has no live
teammate to address and its fix round respawns.

## The map

Every generated brief carries a **blast radius**: the files that have historically changed
alongside the task's declared set. They are outside the file set, so the teammate may not edit
them — they are what its change is most likely to break without touching. It is computed from
`git log` at dispatch time and stored nowhere, so it cannot go stale. Coupling for a brief is
computed over a fixed window of the last 500 commits, which the workflow path hardcodes and no
flag changes; `--commits` sets the window for the standalone `map` command only, and `workflow
--commits` is swallowed without complaint. A brief with no blast radius section usually means new
files rather than a broken dispatch: a declared file needs at least three commits of its own
history before coupling counts it, so a task whose files were just added gets no section even in a
repository with thousands of commits.

Ask the same question yourself for any file set:

    node "<fleetmates root>/scripts/cli.mjs" map --files <a,b> --root <project root>

Coupling is correlation in history, not a dependency: a source and its test, a caller and its
callee, and two files one person kept tidy all look alike to it. Nothing enforces it and no gate
reads it — a map that could fail a phase would be a map worth gaming.

## Worktree mechanics

Each teammate works in its own git worktree — `isolation: 'worktree'` creates one per
teammate automatically; a teammate never shares a worktree with another.

- **Bootstrap before task work starts:** a fresh worktree has no installed dependencies and no
  untracked config the project needs (for example `.env`). Before writing the first test,
  install dependencies as the project requires, copy over any untracked config files the
  project needs, and run the existing test suite once to confirm a clean, green baseline. Do
  this every time, not just when something looks off: a failure caused by a missing dependency
  looks exactly like a RED test from `test-driven-development`, and the gate cannot tell the
  two apart. If the baseline can't be made green, report `blocked` rather than starting task
  work on top of it.
- **Inspect:** `git worktree list` shows every worktree in the repo, including ones from
  other runs. Use it to confirm a teammate actually got an isolated workspace, and to spot
  stale ones before starting a new run.
- **Prune with the command rather than by hand:**

      node "<fleetmates root>/scripts/cli.mjs" prune-run --run <runId> --plan <planPath> --root <project root> [--yes]

  It recomputes each phase's gate, removes only this run's worktrees whose phase passes, sweeps
  every leaked merge-preview worktree under the system temp directory regardless of which run
  left it, and names every one it left alone and why. Without `--yes` it removes nothing but
  prints the plan anyway.
- **Skip the slow part with `--enforcement-only`:**

      node "<fleetmates root>/scripts/cli.mjs" prune-run --run <runId> --plan <planPath> --root <project root> --enforcement-only [--yes]

  `finish` and `prune-run` otherwise recompute every command check of every phase — for a
  five-phase run, five full test suites — to answer a question that usually does not need them.
  It drops only command checks; fileset, ownership, and the merge check the gate computes for
  itself still run. Every dropped check is reported as skip, never silently omitted. It REFUSES
  with exit 2 when a phase's manifest declares no fileset and no ownership check, because with
  nothing else to verify the result would be meaningless. And it will not let `prune-run` remove
  a worktree for a phase whose PASS rests on a check the flag skipped — a cheap verdict is enough
  to report, not enough to delete.
- **Prune after the phase passes its gate, not when a teammate returns:** `phase-gate` resolves a
  `retry` by resuming the same teammate, and a resumed teammate whose worktree is gone cannot
  start — it fails with "its worktree no longer exists", and the task's whole context is lost
  with it. Once the phase has a recorded PASS, run `prune-run` to remove the worktree, not
  `git worktree remove` by hand — the command above already covers this case. Only prune
  worktrees belonging to **this** run — a leaked preview is swept regardless of which run left
  it, as above. The one exception is a task going to a **fresh**
  implementer instead of a resume, because resuming stalled: prune that task's worktree first,
  since `prune-run` only removes a worktree whose phase already recomputes to PASS and a
  mid-phase stall has none yet to rest that removal on — do it by hand with
  `git worktree remove --force <path>`, then `git worktree prune`; `--force` is required and
  authorised here, because a mid-stall worktree is exactly the one most likely to hold modified
  or untracked files a bare remove refuses over, and discarding that work is the deliberate
  point of abandoning it for a fresh implementer — that authorisation covers the teammate's
  unfinished work only, not a junction: `--force` still follows one out of the worktree and
  deletes its target, and nothing unlinks it first the way it does for a leaked preview, so
  check the worktree for one first with `dir /AL /S` and remove the link itself with
  `rd <link>` — both from cmd.exe, not PowerShell, where `rd` and `rmdir` are aliases for
  `Remove-Item`; never a recursive delete, which follows it — before forcing — because a
  returned teammate's worktree keeps its branch checked out and the new dispatch would
  otherwise fail with "already used by worktree"; then restate the findings, the branch and
  the file set in its dispatch, because none of that survives the handover.
