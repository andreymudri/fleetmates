## The watchdog

`watch`, started under `Monitor` after each direct-`Agent` dispatch (see `Watch the phase` in `parallel-execution`), acts on
the signals `liveness` reports. It prints one JSON object per stdout line. The first is `start`,
naming the stale window in use, for example
`{"event":"start","staleMinutes":20,"learned":false,"samples":0}`. Then, every `intervalMinutes`,
it reads the current phase, leaves out every task whose status is `done`, `blocked` or `orphaned`,
and decides at most one action per remaining task.

A task is `stalled` when neither a commit nor a worktree write landed inside the stale window. A
task that `liveness` would call working is treated as spinning when its event ledger records at
least `spinFailures` failures of one command inside the stale window, counted since that command
last passed. A stalled or spinning task climbs one ladder: up to `resumes` resumes, then a respawn,
which starts the resume count again, and once `respawns` respawns are spent, one `orphan`. With
the defaults that is resume, resume, respawn, resume, resume, orphan. After any action the task
gets one full stale window, measured from that action, before the next one.
The respawn comes only after the resumes that "When a teammate stalls" prescribes have been spent,
which is why that section's advice against respawning still holds for the first response.

An action prints an event naming the task and its attempt, for example
`{"event":"resume","task":"T1","at":"<ISO time>","attempt":1}`, and appends a `watchdog` event to
that task's ledger. An action on a spinning task also carries `reason: spinning`. A task whose
freshness could not be measured gets one `unmeasured` event carrying the reason. A tick that fails
prints `watch-error` with the message, and so does a ledger append that fails. Once nothing in
the phase is in flight, `watch` exits 0 without printing an event. After three failed ticks in a
row it prints `exit` with reason `errors` and exits 1. `watch --once` runs a single tick and exits 1 when
that tick failed. The ladder is kept per task in `.fleetmates/<runId>/watch.json`, so a restarted
`watch` picks up where the last one stopped.

| Event | Orchestrator response |
|---|---|
| `resume` | `SendMessage` to that teammate (other harnesses: `node "<fleetmates root>/scripts/cli.mjs" message --task`) with exactly: "The fleet watchdog saw no commit and no file change for the stale window. If a command is running in the background, re-run it in the foreground with an explicit timeout of at least 600000 ms. Then reply with your current status." If the agent is gone, treat it as `respawn`. |
| `resume` with `reason: spinning` | `SendMessage` with exactly: "The fleet watchdog saw the same command fail repeatedly with no success in between. Stop re-running it unchanged: read the last failure, state one hypothesis, try a different approach, or report blocked with the failing output." |
| `respawn` | `TaskStop` the teammate, run `node "<fleetmates root>/scripts/cli.mjs" rescue --run <id> --task <t>`, then dispatch that task again with a fix-round brief, which checks the task branch out as it stands instead of resetting it, so its commits survive. On Claude Code, re-spawn `tm-implementer` with the brief from `node "<fleetmates root>/scripts/cli.mjs" brief --run <id> --task <t> --plan <path> --base <branch> --fix-round`; on other harnesses, run `node "<fleetmates root>/scripts/cli.mjs" dispatch --run <id> --phase <n> --fix-round --task <t>`. Tell the new teammate to run `git apply --index <patch>` first when rescue printed a patch. If rescue fails, treat it as `orphan`. |
| `orphan` | Mark the task `orphaned` in status, `PushNotification` the owner with the task id, take no further action on it. |
| `unmeasured` | `PushNotification` the owner with the task id and reason; take no action. |
| `watch-error` | Nothing; three in a row end the watchdog with `exit` reason `errors`. |
| `exit` | `errors`: restart `watch` once; `watch.json` keeps the ladder. The Monitor stream ending with no `exit` event is the idle exit when every task of the phase is `done`, `blocked` or `orphaned` in the run status; otherwise restart `watch` once. |

`dispatch --task` without `--fix-round` exits 2 with "--task names the tasks of a repair round;
pass it with --fix-round", so the respawn row names both flags.

`rescue` saves the teammate's uncommitted work, tracked and untracked, as a patch under
`.fleetmates/<runId>/rescue/` and then removes its worktree, which frees the task branch for the
new teammate. It prints `rescued <t> to <patch>`, or `<t> had no uncommitted work`, then
`worktree removed: <path>`, and exits 0. With no worktree registered for the task it prints
`no worktree is registered for task <t>` and exits 2. A worktree that belongs to another repository
is refused: rescue prints `rescue failed, worktree left in place:` with the reason, exits 1 and
leaves that worktree where it is.

Watchdog events are supervision only and never gate evidence. Their signals are forgeable by the
teammate they describe, and no gate check reads `watch.json`, the rescue directory or a `watchdog`
ledger event.

Configure it under `watch` in `fleetmates.local.json` or `fleetmates.gate.json`;
`node "<fleetmates root>/scripts/cli.mjs" config get watch.<key>` prints the value in effect. The seven keys and their defaults:

| Key | Default | Meaning |
|---|---|---|
| `watch.enabled` | `true` | `false` makes `watch` print `watchdog disabled by watch.enabled` and exit 0 |
| `watch.resumes` | `2` | resumes before a respawn |
| `watch.respawns` | `1` | respawns before the task is orphaned |
| `watch.staleMinutes` | `20` | stale window when none is learned |
| `watch.intervalMinutes` | `5` | minutes between ticks |
| `watch.learn` | `true` | learn the stale window from this repository's finished tasks |
| `watch.spinFailures` | `5` | failures of one command that make a working task spinning |

The stale window is learned per repository. When a task reaches `done` in status and the watchdog
never resumed, respawned or orphaned it, its longest quiet stretch (the shorter of tip age and worktree age, at its
largest) is added as a sample to `.fleetmates/watch-envelope.json`, which keeps the last 50. With 5
samples or more, the window is the 90th percentile of the samples times 1.5, rounded up to whole
minutes and clamped to 10-60 minutes; with fewer it is `watch.staleMinutes`. The `start` event
says which: `learned` is true and `samples` counts them. With `watch.learn` false the configured
window is used whatever the file holds. That file is under `.fleetmates/`, which every teammate
can write, so a teammate can forge samples; the clamp is what bounds how far a forged sample can
move the window.
