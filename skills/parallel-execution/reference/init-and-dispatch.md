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
