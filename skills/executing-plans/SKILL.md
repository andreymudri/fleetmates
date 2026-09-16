---
name: executing-plans
description: Use when you have a written implementation plan to execute inline in this session, with checkpoints - the non-fleet execution path.
---

# Executing Plans

_Adapted from the MIT-licensed superpowers plugin by Jesse Vincent. See NOTICE.md._

Execute a written plan inline, in this session, task by task, checkpointing with your human
partner as you go. This is the counterpart to `parallel-execution`: same run state, different
cadence. Use `using-fleetmates` to decide which one applies before reaching for this skill.

## 1. Initialize the run

    node "<fleetmates root>/scripts/cli.mjs" init-run <planPath> --run <runId> --root <project root>

This writes `.fleetmates/<runId>/plan.json` and `status.json` — the same shared state a fleet
run would write. Because of that:

- `node "<fleetmates root>/scripts/cli.mjs" digest --run <runId> --root <project root>`
  renders this run unchanged, whether it ran inline or across teammates.
- `fleet-lifecycle resume <runId>` can resume it later.
- If the work turns out to be bigger than expected mid-run, hand it to `parallel-execution`
  without translating anything — the state is already in the shape it expects.

Never start implementation on `main`/`master` without explicit consent from your human partner.

## 2. Review the plan critically

Read it fully before touching code. Raise concerns with your human partner before starting —
gaps, unclear steps, or a task that looks bigger than a single sitting.

## 3. Execute and checkpoint

Work through tasks in dependency order. Follow each step; run the verifications it specifies.

Checkpoint with your human partner **per task, or per small batch of related tasks** — not
automatically per phase the way a fleet gate does, and not silently at the end of the whole
plan. Report what changed, what you verified, and any deviation from the plan before moving on.

### Gate manifest is optional here

A fleet phase demands a `fleetmates.gate.json` manifest before it will pass. Inline work does
not need one. When no manifest exists, checkpoint against the plan's own verification steps
instead of demanding one be written first.

**Do not require a phase structure, a manifest, or a reviewer dispatch for small inline work.**
Ceremony that makes a two-task change expensive is ceremony that gets skipped — and a skipped
skill protects nothing. Reserve that machinery for work that has actually grown into a fleet
(see `parallel-execution` and `phase-gate`).

## 4. Finish

After all tasks are complete and verified, use `finishing-a-development-branch` (if available)
or otherwise confirm tests pass and present integration options to your human partner.

## When to stop and ask for help

Stop immediately when you hit a blocker (missing dependency, failing test, unclear
instruction), when the plan has a gap that prevents starting, or when a verification fails
repeatedly. Ask rather than guess.

## Remember

- Shared state with the fleet path: `.fleetmates/<run-id>/`, `init-run`, `digest`, resumable via
  `fleet-lifecycle`.
- Checkpoint per task or per batch, with the user — not per phase, not automated.
- No gate manifest required; the plan's own verification steps stand in for one.
- Scale up to `parallel-execution` any time without rewriting state.
