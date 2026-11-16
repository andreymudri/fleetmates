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

## Surface unresolved findings

Before proposing integration, check for parked or deferred findings from review — anything a
gate check or reviewer flagged but did not block on. Report them explicitly here, individually,
with enough detail to judge. Do not let them get buried in a "looks good" summary. The user
decides whether an unresolved finding blocks integration; that call is not yours to make
silently.

## Remote CI

A local gate runs on one machine, and the project's GitHub Actions may run on others. Do this
step after every phase's gate has passed again and before presenting the integration options.

Before any push, run `ci-local`; after it, wait with `ci-wait`. Both commands, the two config keys
and every exit code are in `reference/remote-ci.md`.

Ask the user before pushing the run branch, unless ci.push is auto, in which case push without
asking. The `ci-wait` command only reads; it never pushes, so the push is this step's own action. If the user
declines the push, remote CI was not read: say so, and present the run as unverified by CI.

A red, pending or unreadable CI means the merge is not offered: report what `ci-wait` printed,
links included, and stop. Fix a failure on a task branch, re-run the gate, push and wait again.
Keeping the branch for further work stays available.

## Integration options

Once a freshly re-run gate has passed for every phase and any parked findings are on the table,
the `land.mode` key decides how the run branch lands. Read it back with `config get`:

    node "<fleetmates root>/scripts/cli.mjs" config get land.mode --root <project root>

With `pr`, the default, open a pull request for the run branch without asking:

    gh pr create --head <run branch> --base <base branch> --fill

Put the unresolved findings from the step above in the pull request body, one per line, so they
stay in front of whoever reviews it.

With `ask`, present the choice and do not pick one unilaterally:

1. **Merge to the default branch.**
2. **Open a pull request** for external review before it lands.
3. **Keep the branch for further work** — integration isn't forced just because the gate passed.

Carry out whichever the user picks; don't default to merging in the absence of an answer.

## When to read a reference

| Situation | Read |
|---|---|
| Running the Remote CI step: its commands, keys and exit codes | `reference/remote-ci.md` |
| `land.autoMerge` is set, or the user asks for the pull request to merge by itself | `reference/auto-merge.md` |
| Removing a finished run's worktrees and scratch branches | `reference/cleanup.md` |
