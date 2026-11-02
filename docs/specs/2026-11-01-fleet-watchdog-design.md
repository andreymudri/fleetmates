# Fleet watchdog design

Date: 2026-11-01. Status: approved design, plan not yet written.

## Purpose

Keep implementer teammates of a fleet run moving when one of them stalls. Today `cli.mjs liveness`
detects a stall (no commit and no worktree write inside the window) but only reports it, and
`skills/fleet-supervision/SKILL.md` says so: "It reports; it does not act." When the owner is away,
a stalled teammate stays parked until someone looks. The watchdog closes that gap: it detects the
stall on a fixed heartbeat and drives a bounded recovery ladder without waiting for the owner.

Success criteria:

- A teammate that stalls is resumed within one heartbeat after the stale window expires.
- A teammate that keeps stalling is replaced, and its uncommitted work survives the replacement.
- A task that keeps stalling after replacement stops consuming agents and the owner is notified.
- Nothing is spent on tokens while every teammate is working.

## Decisions

Each was settled with the owner on 2026-11-01, except those marked as assumptions.

| Decision | Choice |
|---|---|
| Which agents are watched | Fleet teammates, not deck sessions |
| Mechanism | A non-LLM process (`cli.mjs watch`) that emits events; the orchestrator acts on them |
| Autonomy | Fully automatic, including respawn |
| Uncommitted work before respawn | Saved as a patch; the new teammate starts from it |
| Ladder | Configurable, default 2 resumes then 1 respawn |
| Timing | Stale window 20 minutes, heartbeat 5 minutes, both configurable |
| `unknown` rows | Notify once per task, never act |
| Lifecycle | Started automatically after each phase dispatch, exits on its own when the phase has nothing in flight |
| Scope (assumption) | Implementer tasks only; reviewers and the integrator have no task branch for liveness to measure |
| Resume text (assumption) | Fixed text, never built from teammate output |
| Old agent on respawn (assumption) | Stopped with `TaskStop` before its worktree is rescued |
| Respawn path (assumption) | Existing `dispatch --task`, which already accepts a single task |

A subagent watchdog was rejected: a Claude subagent has no handle to resume a sibling, and an LLM
polling loop pays tokens on every heartbeat. A process that resumes agents on its own was rejected
because in Claude Code only the orchestrator session holds the agent handles.

## Architecture

```
cli.mjs watch (background, read via Monitor)          orchestrator session
  every intervalMinutes:                                on each event line:
    gather tips + touches for the current phase   -->     resume   -> SendMessage (Codex/Cursor: cli message)
    livenessRows(...)                                     respawn  -> TaskStop, cli rescue, cli dispatch --task
    nextAction(row, history, config, now)                 orphan   -> mark task orphaned, PushNotification
    persist watch.json, append event-ledger              unmeasured -> PushNotification
    print one JSON event per action
  exit 0 when no task in the phase is in flight
```

### Units

1. **`scripts/watch.mjs`**, pure. `nextAction(row, history, config, now)` returns one of
   `none`, `resume`, `respawn`, `orphan`, `unmeasured`, plus the attempt number. It holds the whole
   ladder and has no repository access, following the same rule `liveness.mjs` follows.
2. **`cli.mjs watch --run <id> --plan <path> [--root <path>]`**. The loop. It gathers signals the
   same way `liveness` does (shared helper, not a copy), calls `nextAction`, writes
   `.fleetmates/<run-id>/watch.json` and an event-ledger entry for every non-`none` action, and
   prints one JSON object per line on stdout. It holds `.fleetmates/<run-id>/watch.lock` (pid); a
   second `watch` on the same run exits non-zero naming the holder. A stale lock whose pid is dead
   is taken over.
3. **`cli.mjs rescue --run <id> --task <t> [--root <path>]`**. Writes
   `.fleetmates/<run-id>/rescue/<task>-<n>.patch` with `git diff --binary HEAD` plus untracked files
   (added with intent-to-add on a temporary index, so the real index is untouched), verifies the
   patch is non-empty or that the worktree was clean, then removes the worktree. It refuses to
   remove the worktree if writing the patch failed.
4. **Config** in `fleetmates.local.json`, validated by `scripts/config.mjs`:
   `watch.enabled` (default true), `watch.resumes` (2), `watch.respawns` (1),
   `watch.staleMinutes` (20), `watch.intervalMinutes` (5). Integers must be at least 0 for counts
   and at least 1 for minutes.
5. **Skills**. `parallel-execution` starts `watch` in the background right after each phase
   dispatch when `watch.enabled` is true, and reads it through `Monitor`. `fleet-supervision`
   documents each event and the exact response. The brief for a respawned task names the rescue
   patch and tells the teammate to apply it first.

## The ladder

Per task, with defaults `resumes = 2`, `respawns = 1`:

```
stalled -> resume 1 -> stalled -> resume 2 -> stalled -> respawn 1 (rescue + new agent)
        -> stalled -> resume 1 -> stalled -> resume 2 -> stalled -> orphan
```

The resume counter resets on each respawn; the respawn counter never resets within a run. After
`orphan` the watchdog takes no further action on that task. After any action the task gets a full
new stale window measured from the action time, so a resumed teammate is not re-flagged on the next
heartbeat before it had a chance to work. A `working` row resets nothing: the counters measure how
often this task has needed help, not how long ago.

`unknown` rows produce one `unmeasured` event per task per run, carrying the `unknownReason` from
`livenessRows`, and no action. `not started` rows are ignored.

## Events

One JSON object per line, for example:

    {"event":"resume","task":"T3","attempt":2,"run":"r1","at":"2026-11-01T12:00:00Z"}
    {"event":"respawn","task":"T3","attempt":1,"patch":".fleetmates/r1/rescue/T3-1.patch"}
    {"event":"orphan","task":"T3"}
    {"event":"unmeasured","task":"T5","reason":"walk-capped"}
    {"event":"exit","reason":"phase-idle"}

Task ids are printed through `printable`, so a hostile plan cannot inject terminal escapes.

## Error handling

- Signal gathering fails (git error, unreadable worktree): log a `watch-error` event and skip that
  heartbeat; three consecutive failures exit non-zero so the orchestrator sees the watchdog died.
- `rescue` fails: the orchestrator does not dispatch, marks the task orphaned and notifies. The
  worktree is left in place.
- The orchestrator's resume fails (agent already gone): it treats the event as a respawn.
- The `watch` process dies: the orchestrator sees the Monitor stream end without an `exit` event
  and restarts it once; `watch.json` makes the counters survive the restart.

## Trust boundary

The watchdog's signals are forgeable by the teammates they describe, as `liveness.mjs` already
states. Watchdog events are supervision only and are never cited as gate evidence. The resume
message is fixed text and never quotes teammate output.

## Testing

- `nextAction`: every rung of the ladder, counter reset on respawn, configured counts of 0, the
  post-action window, `unknown` notified once, `not started` ignored. Clock injected.
- `rescue`: in a temporary git repo, a modified tracked file, a new untracked file and a binary file
  all survive `git apply` of the patch onto a fresh checkout; the real index is unchanged; a failed
  patch write leaves the worktree in place.
- `watch`: end to end with an injected signal source and clock: emits the expected event sequence,
  exits when the phase is idle, refuses a second instance, takes over a dead lock.
- Config: each key rejects out-of-range values.
- Every new test is mutated to fail once, per `CONTRIBUTING.md`.

## Non-goals

- Watching deck sessions.
- An LLM watchdog agent.
- Acting on `unknown` rows.
- Watching reviewers or the integrator.
- Using watchdog state as gate evidence.

## Amendment: spinning teammates and a learned window

Approved by the owner on 2026-11-01 after reviewing Microsoft's TokenEconomizer, whose failure-loop
guard and per-repository envelope cover the two gaps below. Ideas only; no code is taken from it.

**Spinning.** A teammate that re-runs the same failing command keeps its commits and file writes
fresh, so liveness reads it as `working` and the ladder never fires on the most expensive kind of
stuck. A new pure `spinState` reads the task's event ledger: one command fingerprint failing
`watch.spinFailures` times (default 5) inside the stale window, with no success of that command in
between, turns a `working` row into `spinning`. A spinning row walks the same ladder as a stalled
one; its events carry `reason: "spinning"` and the orchestrator's resume text tells the teammate
to stop retrying unchanged. No judge model is used: the rule is deterministic and costs nothing.

This depends on the ledger recording failures, which it did not. Measured with a hook probe on
Claude Code 2.1.316: a failed Bash call fires only `PostToolUseFailure`, and a successful one's
`PostToolUse` payload carries no exit code. `context-hook.mjs` listened only to `PostToolUse` and
read `exit_code`, so every success was recorded `unknown` and no failure was recorded. The
amendment fixes that too, which also restores the success reset `stallDecision` relies on.

**Learned window.** The ladder's history now keeps, per task, the longest quiet stretch seen
(`maxQuietMs`, the smaller of tip age and touch age). When a task finishes `done` without the
watchdog ever acting, that value becomes one sample in `.fleetmates/watch-envelope.json`. Once 5
samples exist, and unless `watch.learn` is false, the stale window is p90 of the samples times 1.5,
clamped to 10-60 minutes; before that, `watch.staleMinutes` applies. The file is teammate-writable,
so the clamp is what bounds a forged sample. The window in use is printed in a `start` event.

New config keys: `watch.spinFailures` (integer >= 2, default 5) and `watch.learn` (boolean,
default true).

## Deferred

- Whether p90 x 1.5 with a 10-60 minute clamp is the right learned window. Reopens after the first
  three fleet runs that reach 5 samples, by comparing it with the stalls those runs recorded.
- Learning repository facts from repeated failures and injecting them into briefs (TokenEconomizer's
  envfacts idea). Separate spec; reopens once T8's failure events have a few runs of data.
