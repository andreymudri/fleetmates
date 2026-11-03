---
name: finishing-a-development-branch
description: Use when implementation is complete and needs integrating - re-runs the gate to verify each phase, then decides how the run branch lands.
---

# Finishing a Development Branch

Work is not finished because the code looks done. It is finished when a gate you just ran
says so — not when a record claims one already did.

## The completion gate

Work is not finished because the code looks done, and never because "the tests looked green"
or "the teammate said it was done" earlier in the conversation. Which check applies depends on
what state the run is in — check in this order.

### 1. Fleet run: `status.gates` is recorded

If `.fleetmates/<run-id>/status.json` exists and has a non-empty `status.gates`, this is a fleet
run — but a record in `status.gates` is a report written by the agents being enforced, and
`status.json` is agent-writable, so it is never trusted as evidence. A recorded `verdict` of
`PASS` proves nothing by itself:

    {
      "gates": {
        "<phaseName>": {
          "verdict": "PASS",
          "failed": [],
          "skipped": [],
          "pending": [],
          "recordedAt": 1785952191621
        }
      }
    }

Use `status.gates` only to see which phases the run executed. For each of those phases,
**re-run the gate now**:

    node "<fleetmates root>/scripts/cli.mjs" gate --run <runId> --plan <planPath> --root <project root> --phase <name>

`gate` recomputes `fileset` and `ownership` from git at the moment it runs — it does not read
or trust the old record. If any phase's fresh run does not exit `0`, the work is not finished —
name the phase and stop.

### 2. Inline run: a run directory exists but gates are absent or empty

`executing-plans` runs plans inline, task by task, and never writes a gate manifest or a
verdict — that's by design, not an omission. If `status.json` exists but `status.gates` is
absent or empty, the run is inline, and the absent gates are expected, not a fault to fix here.

There is no fleet history to derive `fileset` or `ownership` from, so run the gate solo:

    node "<fleetmates root>/scripts/cli.mjs" gate --no-fleet --root <project root>

`--no-fleet` is the only way the enforcement checks are skipped, and it runs the project's
full test suite (and any other command checks `fleetmates.gate.json` declares) fresh — a
remembered result, or a run from earlier in this session, is not evidence. Once it exits
`0`, proceed.

### 3. No run directory at all

Someone may have finished work on a branch without ever calling `init-run` — there's no
`.fleetmates/<run-id>/` to read. Run the gate solo the same way as case 2, confirm it exits `0`
from fresh output, and proceed the same way.

## Branch taxonomy

Two kinds of branch exist in this plugin, and they are not interchangeable:

- **Teammate branches** are scratch. Each teammate does its work on its own branch, inside its
  own worktree, and that branch is deleted by `prune-run` for each worktree it removes, once the
  run branch provably contains it.
- **The run branch** is the deliverable. It is the only branch that matters once the run is
  done, and **`tm-integrator` is the sole writer of it.** Teammate branches merge into the run
  branch; the run branch never merges into a teammate branch, and no other role pushes to it
  directly.

If you find yourself about to commit implementation work straight onto the run branch instead
of a teammate branch, stop — that's the wrong direction for this model.

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

## Surface unresolved findings

Before proposing integration, check for parked or deferred findings from review — anything a
gate check or reviewer flagged but did not block on. Report them explicitly here, individually,
with enough detail to judge. Do not let them get buried in a "looks good" summary. The user
decides whether an unresolved finding blocks integration; that call is not yours to make
silently.

## Remote CI

A local gate runs on one machine, and the project's GitHub Actions may run on others. Do this
step after every phase's gate has passed again and before presenting the integration options.

Before any push, run on this machine the CI steps this machine can run, so the remote CI confirms
rather than discovers:

    node "<fleetmates root>/scripts/cli.mjs" ci-local --root <project root> [--dry-run]

It reads the workflows that run on a branch push or a pull request, takes each job whose
`runs-on` (or `matrix.os` list) is this operating system, and runs that job's `run:` steps in
order, with the step's shell, its `env`, its `working-directory`, and `GITHUB_ENV` and
`GITHUB_PATH` carried to the next step, in the user's own environment. A `git config --global`
step (a CI identity, say) is undone after its step: the global git config files are put back as
they were, and the run names each one it restored. What it cannot reproduce it
skips and names: a `uses:` action, an expression other than `matrix.os`, `runner.os` and
`runner.temp`, an `if:` other than a `runner.os` comparison, an unusual shell, and every job for
another operating system. Those are what the remote CI is still for. Exit 0 means every step it
ran passed; exit 1 names the step that failed and nothing after it ran, so fix it before pushing,
and do not push; exit 3 means no step runs on this machine, so say that the remote CI is the
only check. `--dry-run` lists what would run and runs nothing.

Ask the user before pushing the run branch, unless ci.push is auto, in which case push without
asking. The `ci-wait` command only reads; it never pushes, so the push is this step's own action. If the user
declines the push, remote CI was not read: say so, and present the run as unverified by CI.

Two config keys shape this step: `ci.push` is `ask` (the default) or `auto`, and
`ci.waitMinutes` is an integer from 1 to 720, 60 by default. Set either through the CLI, in the
tracked `fleetmates.gate.json` by default or with `--local` in the gitignored
`fleetmates.local.json`; any other value is refused with exit 2. The `config list` command does not print
them, so read one back with `config get`:

    node "<fleetmates root>/scripts/cli.mjs" config set ci.push auto --root <project root> [--local]
    node "<fleetmates root>/scripts/cli.mjs" config set ci.waitMinutes 30 --root <project root> [--local]
    node "<fleetmates root>/scripts/cli.mjs" config get ci.push --root <project root>

Then wait for the remote CI of the branch tip:

    node "<fleetmates root>/scripts/cli.mjs" ci-wait --branch <run branch> --root <project root> [--minutes <1-720>]

It reads the GitHub Actions workflow runs of the branch's tip commit through `gh api` every 30
seconds, for up to `ci.waitMinutes` minutes (60 when unset), or `--minutes` when given. It judges
whole workflow runs, not single jobs: every run on the tip must be completed with conclusion
`success` or `skipped`, and any other conclusion, `neutral` included, is a failure. A re-run counts
by its latest attempt. A run still queued or in progress is pending, and so is a tip on which no
run has started yet. Whether the project has workflows at all is read from the tip commit's tree,
not from the working tree.

Its exit code is the answer:

- `0`: every workflow run on the tip passed. It also exits `0`, printing `no CI workflows: skipped`,
  when the tip commit has no `.github/workflows`; tell the user the project has no remote CI, so
  this step was skipped.
- `1`: a run failed. It prints each failed run with its conclusion and its link.
- `3`: runs were still pending when the window closed. It prints them with their links.
- `4`: remote CI could not be read: `gh` is not installed or not logged in, the response was not
  readable, or the tip has more than 100 workflow runs.
- `2`: a bad invocation, such as a branch that does not exist or a `--minutes` outside 1 to 720.

A red, pending or unreadable CI means the merge is not offered: report what `ci-wait` printed,
links included, and stop. Fix a failure on a task branch, re-run the gate, push and wait again.
Keeping the branch for further work stays available.

## Integration options

Once a freshly re-run gate has passed for every phase and any parked findings are on the table,
present the choice — do not pick one unilaterally:

1. **Merge to the default branch.**
2. **Open a pull request** for external review before it lands.
3. **Keep the branch for further work** — integration isn't forced just because the gate passed.

Carry out whichever the user picks; don't default to merging in the absence of an answer.
