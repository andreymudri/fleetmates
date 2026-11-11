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
  itself still run. Fileset and ownership run even when a phase's manifest omits them, because the
  gate injects them, so the flag always has an enforcement check to report. Every dropped check is
  reported as skip, never silently omitted. And it will not let `prune-run` remove
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
