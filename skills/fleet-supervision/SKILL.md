---
name: fleet-supervision
description: Use when checking what a running fleet is doing - renders the digest, surfaces blocked or failed teammates, and suggests scaling.
---

# Fleet Supervision

## Digest

    node "<fleetmates root>/scripts/cli.mjs" digest --run <runId> --root <project root>

Show that block as-is. It is deliberately compact; do not expand it into prose.

## What the repository says

    node "<fleetmates root>/scripts/cli.mjs" doctor --run <runId> --plan <planPath> --root <project root>

The digest renders `status.json`, which the teammates being supervised write; `doctor` asks git
instead. It reports the main worktree's branch and any dirty paths, every worktree and who holds
it, and per task the branch tip and what it actually contributes from its own fork point. Exit 1
means it found problems, all named — a branch with no changes (the work landed on another ref), a
worktree inside the repository, a branch that reached the base branch without the run branch.

Run it after a teammate returns and before a gate. It decides nothing and records nothing: a
teammate is `done` on the strength of this report and the gate, never on its own say-so.

## Event-driven, not polling

Background teammates notify on completion — react to those notifications. The only timer is a
long heartbeat (20-30 minutes) to catch a teammate that hangs and never notifies. Do not sit
in a poll loop.

## The heartbeat

    node "<fleetmates root>/scripts/cli.mjs" liveness --run <runId> --plan <planPath> --root <project root>

Run it on the 20-30 minute heartbeat, not in a loop. Exit 1 means at least one teammate of the
current phase has neither committed nor touched its worktree inside the window.

Exit 2 means it did not measure what you asked about, and is neither a stall nor an all-clear. Fix
what the message names and run it again. It reports that when:

- no current phase can be named — the main worktree is on the base branch, the plan is missing at
  the anchor, or the phases integrated out of order;
- the run id matches no run directory (a typo would otherwise report a board of "not started");
- the plan in the working tree has no task in the derived phase, which an amendment mid-run causes;
- a row reads `unknown`, meaning freshness was not measured for that teammate. Two causes, and the
  output names which: no worktree of that branch could be read — none is registered, because the
  teammate was dispatched without worktree isolation or is working in the main worktree — or the
  walk hit its 5000-entry cap, for which the fix is to add the generated directory to the project
  .gitignore, since the walk skips what git ignores.

A row is only `stalled` when both signals were measured, and a measured stall outranks an unknown
row: a board carrying both exits 1, and names the unmeasured task anyway. A run whose phases are
all integrated is finished, at exit 0.

It reports; it does not act. A stalled row is your cue to message that teammate or offer to stop
it — the CLI has no handle on a subagent. Both of its signals are forgeable by the teammate they
describe, so a stall is a prompt to look, never evidence for a gate.

## When a teammate stalls

A teammate that returns a status with no tip sha and no evidence, or that reports it is waiting on
something, has stalled. `liveness` is the check that surfaces it, and what it detects is an absence
of progress — no commit and no worktree write inside the window — not a backgrounded command. Every
stalled row carries one hint line:

      -> likely cause: backgrounded command waiting on a notification that never arrives; resume this agent (do not respawn) and tell it to run in the foreground

That names a likely cause; it is a guess, not a diagnosis. Two causes produce the same board, and
the hint names only one of them. A teammate may have backgrounded a long command deliberately. Or
it ran that command in the foreground and the harness moved it to the background at the harness
timeout of 120 seconds, against a suite that takes 200-340 seconds in this repository, leaving the
agent waiting for a completion notification that a detached command never sends. Neither cause is
ranked above the other, because no relative frequency has been measured: of the two stalls this
repository records, one attributes the first cause (run `codemap`) and one names no cause at all
(run `claims`), while the second cause has been reported by teammates in session and never written
down. So do not assume disobedience without checking which cause applies — and do not assume the
harness either. Treat the hint as the guess it is until the teammate's own account settles it.

At dispatch time, prevent it: tell the teammate to pass an explicit longer timeout on the
long-running command rather than relying on the default.

The recovery is to resume THAT agent with an instruction to re-run in the foreground with an
explicit longer timeout. Do not respawn it: a respawn discards the task's whole context, and a
returned teammate's worktree keeps its branch checked out, so a fresh dispatch fails with "already
used by worktree" until that worktree is pruned.

## The SubagentStop backstop

A teammate's stop runs the `SubagentStop` hook, which re-runs the cheap enforcement checks and can
refuse the stop; a refusal appears in that teammate's transcript as one of two fixed messages — the
branch the task is missing, named alongside a pointer to the teammate's brief for the step that
creates it, or a direction to run its own verification command — never as the failing check's
text, which is not forwarded. But `SubagentStop` fires only when a teammate actually stops — a stalled or parked
teammate never reaches it, so `liveness` remains the only thing that sees a teammate which never
stops at all. No stop-path hook fires for a parked agent.

## Failure handling

| Symptom | Response |
|---|---|
| Result is null (died or skipped) | Mark `orphaned`, never `done`. Offer respawn. |
| Teammate blocked on another task | Missing edge in `plan.json`. Record it, requeue after the blocker. |
| Files touched outside the declared set | Gate failure. Report the stray paths with the owning task. |
| Merge conflict | Escalated by `tm-integrator` with both hunks. Do not resolve semantics yourself. |
| Silent past the heartbeat | Detected by `liveness` above (exit 1). Surface it; offer stop or wait. Never assume progress. |

## Scaling suggestions

When queued tasks exceed idle slots, suggest — never silently decide:

> 4 tasks queued, 2 idle slots. Add 2 implementers?

Route the actual spawn through `fleet-lifecycle`.
