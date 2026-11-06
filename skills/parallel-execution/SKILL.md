---
name: parallel-execution
description: Use when executing a written plan across background teammates - splits it into phases, dispatches worktree-isolated implementers, and integrates results.
---

# Parallel Execution

This file holds the steps every run takes. Rarer cases, and the reasons behind each step, are in
the `reference/` files beside it; the table at the end says which one to read when.

## Check the plan before init-run

Before `init-run`, re-read the task statement the plan was written from and confirm two things:
the plan's Out of Scope section excludes nothing the statement requires, and every task a
`**Depends:**` line names exists in the plan. Nothing enforces this check: gates and reviewers
judge the work against the plan, so a plan that leaves out what the statement requires passes
every gate.

## Start the run

Check out the run branch first, then run `init-run` from it:

    git checkout -b <run branch> <base branch>    # e.g. run/<runId> from master
    node "<fleetmates root>/scripts/cli.mjs" init-run <planPath> --run <runId> --root <project root>

It writes `.fleetmates/<runId>/plan.json` and `status.json` and prints the phase breakdown. Why the
order matters, and what to do when `init-run` records no run branch, is in
`reference/init-and-dispatch.md`.

## Batches

`workflow` groups a phase's tasks by tier, in plan order, into batches of at most `batchSize`
(default 3; `config set batchSize 1` restores one teammate per task), and the summary line of
`workflow --out` names them. A batch is one `tm-implementer` doing its tasks in sequence in one
worktree, each on its own branch from the base, so the gate checks are unchanged. The
`maxParallel` bound counts batches. A phase left with one batch takes the direct-`Agent` path, as one `Agent` briefed
by `brief` with one `--task` per task, in batch order. Batching has three limits: wall time grows,
because a batch's tasks run one after another; the SubagentStop hook checks a stop against the
batch's latest located task only; and a teammate that dies mid-batch leaves its later tasks
`orphaned`.

## Dispatch a phase

Phases with three or more tasks go through the Workflow tool, which needs the user's opt-in: ask
once per run, then remember the answer for that run. Write the script to a file, then invoke
`Workflow` with that file:

    node "<fleetmates root>/scripts/cli.mjs" workflow --run <runId> --phase <n> --root <project root> \
      --base <base branch> --models '{"cheap":"haiku","mid":"opus","capable":"opus"}' --out <file>

With `--out`, `workflow` prints only the file's path and a one-line summary, so the script stays
out of your context. That holds for this command's output only: without `--out` it prints the
whole script, and reading the file back loads it all the same.

If the user declines, or the Workflow tool is unavailable, do not stop: use the direct-`Agent`
path for the whole phase and say which path you took. That path also takes every phase with fewer
than three tasks. Each task, or each batch (above), is its own background `Agent` with
`isolation: 'worktree'` and the `tm-implementer` persona, at most `maxParallel` at a time, briefed
with what the CLI prints:

    node "<fleetmates root>/scripts/cli.mjs" brief --run <id> --task <id> --plan <path> --base <branch> --root <project root>

Set the model on every dispatch, from the task's `tier` in `plan.json`:

    cheap    -> haiku
    mid      -> opus
    capable  -> opus

Role dispatches do not read the plan: `tm-integrator` runs at `cheap` and `tm-reviewer` at
`capable` unless configured otherwise. Wait on completion notifications; do not poll in a loop.

## Watch the phase

On the direct-`Agent` path, start the fleet watchdog after dispatching a phase, unless
`watch.enabled` is false:

    node "<fleetmates root>/scripts/cli.mjs" watch --run <runId> --plan <planPath> --root <project root>

Run it with `Monitor`, so each line it prints to stdout arrives as one JSON event; the
`fleet-supervision` skill says how to answer each one. After its `start` line it prints only events
that need an answer, and `exit` only when it ends on errors. Once every task of the current phase
is `done`, `blocked` or `orphaned` in the run status, it exits 0 and prints nothing. Start at most
one per run. While one holds `.fleetmates/<runId>/watch.lock`, a second `watch` on the same run
exits 2 and names the pid holding the lock. With `watch.enabled` set to false, `watch` prints
`watchdog disabled by watch.enabled` and exits 0.

Do not start the watchdog on the Workflow path: the Workflow's completion notification already
wakes you. The cost is the stall signal: nothing watches the teammates inside a running Workflow,
so a stall there surfaces only through the Workflow itself.

## After a phase returns

Append every result to `status.json`; a teammate that returned nothing is `orphaned`, not `done`.
A returned `done` is a claim, so check it against git:

    node "<fleetmates root>/scripts/cli.mjs" doctor --run <runId> --plan <planPath> --root <project root>

Then run `phase-gate`. Only on PASS, detach the main worktree (next section) and dispatch
`tm-integrator` to merge the teammate branches in dependency order with `--no-ff`. Then clean up:

    node "<fleetmates root>/scripts/cli.mjs" prune-run --run <runId> --plan <planPath> --root <project root> --yes

It removes only worktrees whose phase recomputes to PASS, and the removal cannot be undone. Before
dispatching a later phase, run `plan-drift`.

## Before dispatching tm-integrator

Detach the main worktree first:

    git checkout --detach

The integrator is the sole writer to the run branch and cannot check it out while the main
worktree holds it. Without this it has no supported way to advance the branch, and reaches for
`git update-ref`, which desyncs the main worktree's index from its HEAD. Re-attach after the
merge with `git checkout <run branch>`.

## Review the run

After the last phase is integrated, run the run review in `phase-gate`, section "Review the run".
It judges the integrated diff once, and its fix route sends findings to a `fix-<n>` task that a
`tm-implementer` fixes and `tm-integrator` merges. A review check scoped `phase` is not part of it:
`phase-gate` reviews that one inside each phase gate.

## Read results, not diffs

Do not review diffs and do not re-run the suites the gate runs. Read the CLI's output and the
results teammates return; running `gate` and `finish` is the verification. The exception is
investigating a FAIL verdict or a merge conflict, where reading the failing diff and re-running
the failing command is the investigation. This saves context and adds no check: a defect the
gate and the reviewers miss, you miss too.

## Invariants

- A teammate **never touches the main worktree**; it works only in its own.
- A teammate writes only the files its task declared. Strays are a gate failure, caught at
  merge.
- Phase N+1 does not start before phase N gets a PASS.

## When to read a reference

| Situation | Read |
|---|---|
| Why the run branch comes before `init-run`; a run-branch record that is missing or wrong; the full dispatch rules; what checks a teammate's work when it returns early; a harness other than Claude Code | `reference/init-and-dispatch.md` |
| `plan-drift` and what `doctor` reports; tasks that import each other | `reference/results-and-gate.md` |
| What `prune-run` removes; a worktree to drop before its phase passes; worktree bootstrap; `--enforcement-only` | `reference/cleanup-and-worktrees.md` |
| Why each tier runs on its model; role tiers and their config keys | `reference/models.md` |
| The plan must change mid-run; a `## Not Yet Specified` entry becomes a task | `reference/plan-amendments.md` |
| A phase fix round: the live teammate, or a `brief --fix-round` respawn | `reference/fix-rounds.md` |
| The blast radius in a brief, or `map` | `reference/blast-radius-map.md` |
| A headless run (print mode) | `reference/headless.md` |
