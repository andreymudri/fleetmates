---
name: phase-gate
description: Use when a phase finished and needs an automated verdict before integration - runs command, agent, and MCP checks and decides PASS or FAIL.
---

# Phase Gate

Phases run autonomously end to end. The boundary is where verification happens.

## Run it

    node "<fleetmates root>/scripts/cli.mjs" gate --run <runId> --root <project root> [--phase <name>]

Exit codes: `0` PASS, `1` FAIL, `2` the manifest is broken, `3` no manifest (an inferred one
was printed), `5` a derive or run-state failure only (the only failed entries are `derive`
and/or `run-state`, so nothing was judged; a check that failed beside them keeps exit `1`).

On exit 3, show the user the inferred manifest, get confirmation, and save it as
`fleetmates.gate.json`. Never invent checks silently.

Exit 2 is not a verdict — nothing was judged. `fleetmates.gate.json` is present and malformed,
and the message names the file and what is wrong with it. Show that message and stop; do not
re-run the gate, and never save an inferred manifest over the broken one, which would discard
the checks the operator meant to fix. `complete` and `fix` read the same manifest and exit 2
the same way.

## Agent and mcp checks

`gate` runs the `command` checks itself and returns `agent` and `mcp` checks as `pending`, which it
scores as FAIL until their results are supplied. For an `agent` check, generate the reviewer
dispatches rather than assembling them:

    node "<fleetmates root>/scripts/cli.mjs" review-dispatch --run <runId> --root <project root> --phase <n> [--models <json>]

Dispatch one `tm-reviewer` per lens it prints, in parallel and **without a `name`**: a named
reviewer goes idle without returning its result. Each carries the model and effort the dispatch
names; with `agents.reviewer.tier` unset that is the fixed `capable` tier, never the session's
model. Each reviewer writes its findings to `.fleetmates/<runId>/reviews/<phase>-<lens>.json`, and
a lens with neither a response nor that file is missing, not clean. Take every finding at a
`blockOn` severity to a second reviewer prompted to refute it; only findings that survive block.
Then collect:

    node "<fleetmates root>/scripts/cli.mjs" collect-reviews --run <runId> --root <project root> --phase <n>

Hand the gate the path printed on the `results written to …` line, never a capture of stdout; a
refusal prints no such line, and then there is nothing to hand on:

    node "<fleetmates root>/scripts/cli.mjs" gate --run <runId> --plan <planPath> --root <project root> --results <path>

For an `mcp` check, call the declared tool and compare against `passWhen`. A missing optional
server is recorded `skip`, and said out loud.

## Review the run

A review check scoped `run` in `fleetmates.gate.json` belongs to no phase gate. It is judged once,
after the last phase is integrated, on the run's integrated diff
`merge-base(base, run branch)..run branch`. An `agent` check with no `scope` is scoped `run`,
and `"scope": "phase"` keeps a review in each phase gate instead. With the run branch checked out:

1. `review-dispatch --phase run`, then the reviewers and the refute pass as above.
2. `collect-reviews --phase run`, which writes `.fleetmates/<runId>/reviews/results-run.json`,
   already shaped for `finish`.
3. `finish --run <runId> --plan <planPath> --root <project root> --results <that file>`.

A commit on the run branch after the review makes its findings stale, and `collect-reviews`
refuses them. On a run FAIL, ask for the fix decision with the same file:

    node "<fleetmates root>/scripts/cli.mjs" fix --run <runId> --phase run --verdict <that file> --root <project root>

On `retry` it names one task, `fix-<n>`, with its `branch`, the `cutFrom` tip, its `files` and its
`findings`. The `brief` command renders plan tasks only, so brief a `tm-implementer` yourself from
that output: create the branch at `cutFrom`, change only those files, fix those findings. Record the
round once, when you dispatch it, with `record-fix-round --run <runId> --phase run --task fix-<n>`.
When the task returns, detach the main worktree and dispatch `tm-integrator` to merge the fix branch
with `--no-ff`, then run the run review and `finish` again from step 1. The budget is the run's
`fixRounds`, at most two rounds, and then the decision is `escalate`; `none` and `escalate` mean
what they mean for a phase.

What this route does not cover:

- `ownership` bounds a fix branch by every path the plan declares, not by the `files` that `fix`
  emitted, because that list is run state and no check reads run state.
- Only review findings are routable. A failing command check in the run gate leaves no verdict
  document for `fix`, so report it as an escalation; a `fileset-run` failure escalates, and so does
  a finding that cites a path no plan task declares.
- The `workflow-execute` controller stops with `run-fix-required` on a run retry instead of running
  the round; continue the route from there as above.
- A review check scoped `phase` is not reviewed here: it keeps a review per phase, through the
  same commands with `--phase <n>`.

## Reporting rule

**Never report a phase done without a recorded PASS in `status.json`.** A check that was
skipped is reported as skipped, every time. No "should work".

**Evidence before claims, always.** Never claim a task, phase, or fix is complete, fixed,
or passing without having run the verification yourself in this pass and seen its output —
a prior run, an agent's self-report, or "should pass now" is not evidence. "Tests pass"
requires the test command's fresh output showing the count and zero failures, not
recollection of an earlier green run. "Bug fixed" requires re-running the original failing
case and watching it pass now, not the diff alone. If a `tm-implementer` reports DONE,
that report is not the evidence — the gate's own check run against its diff is. Skipping
this because a check "obviously" passes is the same defect as skipping the check.

## When to read a reference

| Situation | Read |
|---|---|
| A review in detail: reviewer tier and effort, findings files and stamps, `collect-reviews` refusals and exit codes, the `claims` lens keys, results keyed by phase for `finish` | `reference/review-results.md` |
| A phase gate failed: `fix`, `retry`, `escalate`, the round budget, a `--no-fleet` gate | `reference/on-fail.md` |
| The `merge` check: the preview, `preview.link`, a conflict | `reference/merge-preview.md` |
| What `fileset` and `ownership` cover, protected paths, the test inventory | `reference/enforcement.md` |
| `platformSim`, `flaky`, the quarantine file, the `portability` lens | `reference/platform-and-timing.md` |
| The orchestrator is not Claude Code | `reference/other-harnesses.md` |
