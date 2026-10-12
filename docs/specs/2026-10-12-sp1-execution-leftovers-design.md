# SP1: execution leftovers design

Sub-project 1 of the work that completes issues #26, #33, #42, #43, #44 and #45. It covers the
remaining obligations that need neither a live model session nor a new owner policy. Later
sub-projects: SP2 role capabilities (#45), SP3 deck decision and evidence views (#26), SP4 effect
and capability adapters (#43, #44), SP5 live validation, SP6 evaluation campaign.

## Starting state

An inventory against master `d6582651` found that most leftovers recorded after the
`execution-recovery-audit` run are already fixed: the `message` exit codes, the artifacts lock
inode recheck and dead-token chain, the drift pattern pin, the exit contract comment, and both
MEDIUM findings under #44 and #45 (commit `ee1e261f`). The progress spec and the validation
matrices still describe them as open.

## Decisions

- A phase's driver contract carries `maxAttempts = min(10, request.maxAttempts - attemptsUsed)`,
  not a constant 10. The run-wide budget then holds inside one dispatch. At zero remaining the
  controller already blocks before writing a contract (`workflow-controller.mjs:459`).
- Querying PR effects after an uncertain outcome (#43) moves to SP4. Nothing produces a `pr`
  effect until a publication step exists, and SP4 builds that step with its authority model.
- No issue closes in SP1. Each touched issue gets a comment naming what SP1 delivered and which
  sub-project carries the rest.

## Tasks

| Task | Change | Files |
|---|---|---|
| T1 | Driver contract `maxAttempts` from the remaining run budget; the repair round cap derives from it | `scripts/workflow-controller.mjs`, `tests/workflow-controller.test.mjs` |
| T2 | Controller handling of an `escalate` fix decision: the phase stops with a `fix-escalated` blocker and no further round runs | `tests/workflow-escalation.test.mjs` (new) |
| T3 | Execute-level tests for the migration, UI and research profiles through the controller with a fake harness | `tests/workflow-profiles-execute.test.mjs` (new) |
| T4 | Startup margin for the flaky ordinary pipeline timeout test | `tests/harness-codex.test.mjs` |
| T5 | README and `doctor` keep the running, blocked, suspended, abandoned, failed and verified-complete states distinct and name the Stop handler's skipped checks and fail-open points (#33) | `README.md`, `scripts/doctor.mjs`, `tests/doctor.test.mjs` |
| T6 | Progress spec and validation matrices restated against master, with the fixing commit for each closed item and SP4/SP5 named for each moved one | `docs/specs/2026-10-06-issue-25-progress.md`, `docs/specs/2026-10-06-execution-recovery-validation.md` |

### T1 detail

The contract is written per phase dispatch. Remaining is `request.limits.maxAttempts -
ctx.attemptsUsed` at the moment the contract is written, clamped to `[1, 10]`. The repair cap at
`workflow-controller.mjs:414` uses the contract's value minus one instead of `DRIVER_ATTEMPTS - 1`.
The test at `tests/workflow-controller.test.mjs:905` that pins 10 changes to a budget of at least
10 remaining; new tests pin a remaining budget of 3 (contract 3, at most 2 rounds) and of 1
(contract 1, no round).

### T3 detail

- Migration refuses to expand without `compatibility` and `rollback` parameters, and with them
  runs to `human-required` whose acceptance step lists `compatibility-check` and
  `rollback-review`.
- UI with render `unavailable` blocks before any dispatch, naming the render capability. With
  render `available` it runs to `human-required`, and its acceptance inputs list
  `rendered-output`, `interaction-check` and `accessibility-check`. No rendered evidence is
  claimed; that is #38.
- Research runs to `human-required` with `sources`, `claim-evidence` and `uncertainty-review`.

### T4 detail

The inner timeout moves from 200 ms to 1000 ms and the late effect from 800 ms to 2500 ms, with
the outer wait adjusted, so process startup under load cannot consume the whole window. The test
still fails if the timeout does not stop the child.

## Testing

Every new or changed test is seen failing under a targeted mutation of the code it covers, then
restored. The root suite passes on Linux, macOS and Windows in CI.

## Out of scope

PR effect queries (SP4), live callbacks and real profile runs (SP5), W02 evaluation (SP6), and
any change to role capabilities (SP2).
