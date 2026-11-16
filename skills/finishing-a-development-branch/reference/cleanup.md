## Worktree and branch cleanup

A finished run leaves a worktree and a scratch branch per task. The `--yes` flag runs
`git worktree remove --force` on every worktree it lists as prunable, and that discards
uncommitted and untracked changes in it without asking. On Windows, it also follows a
junction a worktree holds, so a worktree provisioned with a junction back into the
repository — the kind a fresh worktree's own dependency install might use as a shortcut,
such as a junction into the repository's real `node_modules` — has that target's
contents deleted too, not just the worktree's own. Without `--yes` the command removes
nothing, and it prints the worktrees and branches it would act on if nothing changes
before the `--yes` run — both runs recompute the gate from scratch, but not which of
those branches would actually be deleted — that verdict is computed only inside the
removal itself. Run it first without `--yes` to read the plan, then add `--yes` to
remove what it lists:

    node "<fleetmates root>/scripts/cli.mjs" prune-run --run <runId> --plan <planPath> --root <project root> [--yes]

It removes a task's worktree only where that task's phase gate recomputes to PASS, and
it deletes the worktree's branch only where `git merge-base --is-ancestor` proves the
run branch already contains it. That proof is against the ref `derive` takes directly
off `git symbolic-ref --quiet HEAD`, not off an abbreviated name, and `derive` refuses
to produce a run branch at all when HEAD is detached, when HEAD points outside
`refs/heads/`, or when the name that ref strips to is itself a ref path — so nothing a
teammate can plant under `refs/heads/` changes which ref this proof or the deletion it
authorises runs against. That proof is not something a bare `git branch -D` makes on its own: `-D`
deletes whatever branch it is given without asking whether the run branch contains it —
it refuses only a branch a registered worktree still holds checked out, which is why
`prune-run` removes the worktree first — and the plain `-d` measures "merged" against
the branch's upstream or your current HEAD, never against the run branch. It never
touches the main worktree, and it never removes another run's task worktree, but it does
force-remove a leaked merge-preview worktree — a scratch worktree under the system temp
directory — regardless of which run's gate created it, because a killed gate cannot run
its own cleanup. Every worktree it examines and declines to remove is printed with the
reason; it examines worktrees, not bare branches, so a task branch whose worktree is
already gone is not reported either way.

Do not sweep by hand: a hand-run `git worktree remove --force` or `git branch -D` supplies
neither the recomputed phase gate nor the ancestry proof above — it only does what the flag
itself says, on whatever you point it at.

What this does not clean up: `.fleetmates/<run-id>/` stays on disk on purpose. Delete it
yourself when you no longer want the record: `resume` reads it to continue a run, while
`rebuild-state` reads it twice: once to refuse when it exists, since it exists for the
case where the directory is already gone, and once to keep the run branch it recorded —
delete the directory and a later `rebuild-state` run from any other checkout records that
checkout as the run branch, permanently, and `complete --enforcement-only` can no longer
verify completion for the rest of the run. It is gitignored.
