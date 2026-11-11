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

Approving a `fileset` escalation on a protected path is this same operation: add ` (protected)` to
that task's file line in the amended plan, then re-run the gate.

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
