# Execution and recovery: real profile trials and issue acceptance

## Scope and source

T9 exercised the integrated execution-recovery source
`db6a5f0c7fd63ced3abcb95a16b24f86afc29ca5` (the T8 merge on the run branch)
on Linux x64 with Node v26.7.0 and Codex CLI 0.160.1, authenticated with a
subscription login (`codex login status`). This task changes
only README, the issue 25 progress report and this report. No producer,
adapter, test, manifest or plan was modified, and no issue was closed.

Three evidence classes are kept apart below. Real runs are authenticated Codex
model turns started by `workflow-execute` and `workflow-resume` in throwaway
projects. Local probes are non-model CLI invocations against the same
projects. Repository tests are fixture executions in the root suite. A fixture
pass is never reported as a real outcome, and an unmet criterion stays unmet.

Every receipt is retained outside the repository in a private temporary
directory (`/tmp/hx/t9/receipts`, parent mode 0700). Receipts hold CLI
stdout/stderr, wall-clock metadata, journal listings and acceptance results. A
pattern scan for bearer tokens, API keys and OAuth token fields over the
receipts and both run-state directories found no match. Authentication data
was never read or copied. Commands below use `<product>` for the repository
checkout and `<project>` for a trial project.

## Clean projects and contracts

Each project was a fresh Git repository created by a setup script, with no
remote, no dependency tree and no copied operator configuration. The base
branch `main` held one commit. The run branch `run/<id>` was created from it
and checked out at the project root, as the controller requires. Each project
contained:

- `package.json` with `"test": "node --test"` and a dependency-free lockfile.
- `test/smoke.test.cjs`, a passing assertion so the baseline has a test.
- `plan.md` with one task, its `**Files:**` set and an `**Acceptance:**` list.
- `fleetmates.gate.json` with a `tests` command check (`npm test`) and a
  mandatory `review` agent check with lens `correctness`, blocking on high.
- `env.json`, the README recipe shape with toolchain `node` prefix `v26.`,
  lockfile `package-lock.json`, no setup, baseline `npm test` (60,000 ms),
  `required: []` and `dependencies: "clean-checkout"`.
- `roles.json`: implementer read/write/execute, reviewer read/execute,
  integrator read/write/execute/sharedRefs. Network and publication were false
  for every role. The controller resolves the integrator in the explicit
  host-bounded mode, whose plan contract requires read, write, execute and
  sharedRefs true; a policy without sharedRefs was not tried.

The bug-fix project (`p1b`) shipped `src/sum.cjs` returning `a - b`; its task
was to fix the sum and add a regression test. The feature project (`p2`)
asked for a new `src/clamp.cjs` with tests. The request file for `p1b`:

```json
{"version":1,"profile":"bug-fix","runId":"p1b","planPath":"plan.md","baseBranch":"main",
 "baseCommit":"d9524a6f25571a1e3934befdf325db43562859f1","runBranch":"run/p1b","harness":"codex","sandboxMode":"clone",
 "parameters":{},"limits":{"maxWallMs":2400000,"maxAttempts":40,"maxRepairRounds":1,"stepTimeoutMs":1500000},
 "environment":"env.json","rolePolicy":"roles.json",
 "retention":{"maxArtifactBytes":4194304,"maxRunBytes":67108864,"maxAgeMs":2592000000},
 "model":"gpt-6.1-sol","effort":"low"}
```

The `p2` request differed only in profile `feature`, run `p2`, run branch
`run/p2` and base commit `f1b39b6ed758c30b0d9a7a79fed80a167bb92446`.

```sh
node <product>/scripts/cli.mjs workflow-execute --file <request.json> --root <project>
```

A first bug-fix project (`p1`) used `node --test test/`, which Node v26 does
not accept as a directory argument. Its execution stopped at preflight in
391 ms with exit 4 and the infrastructure blocker `Environment baseline failed
or its evidence is incomplete`. Zero attempts were used and no model turn
started. That run's journal already held the request, so a second
`workflow-execute` on it returned exit 2 with `Run already has an execution
journal; resume it instead of starting again`. This was a defect in the trial
fixture, not in the product. The corrected project was recreated as `p1b`.

## Trial 1: bug-fix profile

`workflow-execute` on `p1b` exited 4 after 108.5 s of wall time with state
`human-required`, `verifiedComplete: false`, `publication: "absent"` and no
blockers. It used 7 of 40 attempts and 108,392 of 2,400,000 ms of wall budget.

| Step | Attempt | Outcome | Duration |
| --- | --- | --- | --- |
| prepare (`init-run`) | prepare.1 | completed, exit 0 | 90 ms |
| baseline (`preview-check`) | baseline.1 | completed, exit 0 | 74 ms |
| implement-1 (`dispatch`) | implement-1.1 | completed, exit 0, task result `done` | 63,655 ms |
| review-1 (`dispatch-reviews`) | review-1.1 | completed, exit 0, zero findings | 42,516 ms |
| collect-1 (`collect-reviews`) | collect-1.1 | completed, exit 0, review pass | 86 ms |
| gate-1 (`gate`) | gate-1.1 | completed, exit 0, verdict PASS | 369 ms |
| integrate-1 (host-bounded) | integrate-1.1 | completed, one no-ff merge | 1,079 ms |

Each dispatch printed its prerequisite report first. The implementer and
reviewer reports showed `enforcement.kind: "required"`, runtime
`codex-sandbox`, `observed: true`, network/sharedRefs/publication false, and
write true or false respectively. The worker environment was ready: total
508 ms (implementer) and 493 ms (reviewer), setup 0 ms, baseline 409 ms and
392 ms. In this trial required native verification was observed ready. That
differs from the earlier isolated-clone refusal recorded in the prerequisites
report; the cause of the difference was not investigated here.

The gate verdict named anchor `d9524a6f`, task tip `bf420575`, and passing
merge, tests, review, fileset and ownership results. The integration receipt
recorded mode `host-bounded`, verification `native-required`, tested tree
`d69a4cc3`, and a single merge of `bf420575` from run tip `d9524a6f` to
`0449d88a`. After the run, the run branch's first-parent history was that
merge over the anchor. The task branch was preserved, the root checkout was
clean apart from the ignored `.fleetmates/` and the base was unchanged.

A read-back script read all 19 artifacts the report references through
`readExecutionArtifact`, which verifies the hash. The journal held 16 version 2
events (8 starts, 8 completions), all with task `profile`. Artifact and
journal directories were mode 0700 and every file 0600.

The report enumerated seven obligations: implementation, command, review,
integration and final review passed with current receipts. `final-command` and
`acceptance` stayed `unresolved` because no acceptance evidence existed and
`finish` therefore never ran. The CLI reported `repairRounds` max 1,
delivered 0 and decision null; no code failure occurred in either trial.

## Trial 2: feature profile, interruption and recovery

`workflow-execute` on `p2` was started in its own process group by an
interruption script. It polled the process table until a child running
`cli.mjs gate --run p2` appeared, then sent SIGKILL to the controller's
process group and to any matching survivors. Before the kill, the journal had
completed records for prepare, baseline, implement-1 (46.6 s), review-1
(46.0 s) and collect-1, then a persisted `gate-1.1` start at 16:45:39.513 UTC.
No end record exists for that gate attempt.

The interruption script matched its own command line, which contained the
project path, and killed itself with the survivors. Its receipt (survivor
list, kill timestamp) was therefore never written. This was a trial-script
defect. What remained observable: no process for the project was left, the
run branch still pointed at the base commit, the task branch held `2456877c`,
there was one worktree, and the checkout was clean apart from ignored state.

`workflow-status` then exited 4 with state `unresolved`: one unresolved
attempt (`gate-1.1`, `interrupted`, not ended), zero unknown effects and
`inputsChanged: false`. Every earlier step attempt reconciled as `ready`; the
request record read `stale`, as it does in every status receipt here, and is
not counted as an unresolved step.

Before resuming, SHA-256 fingerprints of the implementer stream, reviewer
stream and task result were recorded. `workflow-resume --run p2` exited 4
after 2.3 s with state `human-required`:

| Step | Attempt | Outcome |
| --- | --- | --- |
| prepare, baseline, implement-1, review-1 | attempt 1 | reused after revalidation |
| collect-1 | collect-1.2 | rerun, exit 0, 87 ms |
| gate-1 | gate-1.2 | fresh gate, exit 0, 370 ms |
| integrate-1 | integrate-1.1 | host-bounded merge, 1,076 ms |

All three session fingerprints matched afterwards, and no new session file
appeared. No model was redispatched. The merge moved `run/p2` from
`f1b39b6e` to `36060698`, with task tip `2456877c`. The resume report counted
9 attempts and 94,939 ms of wall budget, including the prior invocation.

A second `workflow-resume` exited 4 in 1.2 s. It reused the integration (the
controller accepts a recorded merge only while it is an ancestor of the run
tip and the task tips are unchanged), and reran
`collect-1.3` and `gate-1.3`. The run tip stayed `36060698`, so no second
merge happened, and the session fingerprints still matched. `doctor` reported
the same journal summary (12 attempts, 8 unresolved, 0 unknown effects) with
`verifiedComplete: false`.

This trial covers one documented boundary: after collection, during a
mandatory gate, before integration. It did not interrupt a real model inside
`dispatch` (spawn, result persistence or collection inside the driver). The
repository test `a controller killed during an agent step leaves an
outcome-less attempt that resume will not redispatch` covers that boundary
with fixtures only. A real abrupt harness loss and a Deck daemon restart were
not exercised.

## Identities and resources

| Field | p1b | p2 |
| --- | --- | --- |
| Execution id | `wf-09f4b8bce160...` | `wf-7811ca02703e...` |
| Strict identity | `7fb26a7f...` | `bb22e8fc...` |
| Profile hash | `cbf93cb6...` | `1cc8b74b...` |
| Commit | `d9524a6f...` | `f1b39b6e...` |
| Plan SHA-256 | `553a2a51...` | `95ba67f9...` |
| Manifest SHA-256 | `b814f53b...` | `b814f53b...` |
| Context SHA-256 | `69c6036d...` | `f9fec86f...` |
| Environment identity | `6b5aa083...` | `4f68a49d...` |
| Verifier (CLI) SHA-256 | `d5599ac6...` | `d5599ac6...` |
| Model / effort | `gpt-6.1-sol` / `low` | `gpt-6.1-sol` / `low` |
| Implementer sandbox | workspace-write | workspace-write |
| Reviewer sandbox | read-only | read-only |
| Prompt identity | null | null |
| Implementer tokens (input / cached / output / reasoning) | 171,763 / 143,872 / 1,462 / 38 | 154,298 / 106,624 / 1,347 / 35 |
| Reviewer tokens (input / cached / output / reasoning) | 98,147 / 56,960 / 1,103 / 48 | 129,634 / 82,560 / 1,247 / 108 |
| Cache-write tokens | 0 / 0 | 0 / 0 |
| USD, tool calls, human intervention | null | null |

Model, effort and sandbox come from each Codex thread's own `turn_context`
record. The extraction read only those three fields, matched by the thread id
in the stream. They are not in the fleetmates session record. Token counts are
the `turn.completed` usage fields from each stream, reported as given and not
summed. Prompt identity is null because nothing on this path records a
brief or prompt hash (see finding 5).

## Independent acceptance

An operator script exported each integrated run tree with `git archive` into
a new directory and ran the plan's acceptance itself. These are operator
observations; the controller cannot consume them as acceptance evidence.

- `p1b` tree `d69a4cc3`: `npm test` exit 0, three tests pass. `sum(2, 3)`
  returned 5 and `sum(-1, 1)` returned 0. The new test uses `node:test` and
  `node:assert/strict`. After restoring the original subtraction, the new test
  exited 1 with `actual: -2, expected: 0`.
- `p2` tree `a4d40857`: `npm test` exit 0, two tests pass. `clamp(5, 0, 10)`
  returned 5, `clamp(-3, 0, 10)` returned 0 and `clamp(42, 0, 10)` returned 10.
  `src/clamp.cjs` assigns `module.exports = clamp` and contains no `require`.

## Findings from the trials

The findings below are as T9 recorded them on `db6a5f0c`. Each ends with its
status after the audit run `execution-recovery-audit`, checked at that run's
tip `584e9175`. "Fixed" names the audit task and its commits and rests on
repository tests and local probes only: no new real-model, sandbox or Claude
Code trial was run for the audit, so no real outcome above changes.

1. Nothing produces `acceptance-evidence`. The only references are the profile
   output name and the controller's consumer check, and the CLI request has no
   acceptance field. Every profile run therefore ends `human-required` with
   exit 4, and both real runs did. The `verified-complete` exit 0 path, and
   the `finish` step that precedes it, did not run in these trials.
   Status: producer fixed in audit T5 (`4a8992de`, merged `8775d8d4`):
   `workflow-accept` retains the evidence and `workflow-resume` passes it. In
   the fixture test, `finish` runs and `obligations.verifiedComplete` is true,
   but the injected verification fixture keeps the state `unresolved` with
   exit 4. The exit 0 path through native verification stays unproven (open
   item 8 below).
2. On a code failure the controller stops at the existing `fix` decision and
   delivers no repair round. `maxRepairRounds` is validated and recorded but
   not consumed. Neither real run had a code failure, so this path is
   fixture-backed only.
   Status: fixed in audit T4 (`f0743b53`, `27b8f876`, merged `1d277dc2`) with
   the CLI side in audit T5 (`4a8992de`). A retry runs `record-fix-round`,
   then `dispatch --fix-round --task <id>...`, then review, collection and
   gate again, at most min(`maxRepairRounds`, the phase fix budget) rounds per
   phase, and at most 9 under the driver journal. Still fixture-only; open
   item 2 lists the guards around it that no test pins.
3. `message` returns 0 for a resumed child with `exitCode: -2` (the adapters'
   spawn failure value) and for a clean exit that leaves no result. It reads
   only `<task>.result.json`, so a Cursor result delivered in the stream file,
   where the Cursor adapter's `readResult` looks, reports `no-result`. A probe
   using the suite's adapter-stub seam observed all three for both harnesses.
   Status: fixed in audit T5 (`4a8992de`, `b82bd04a`, `05cad812`). `message`
   exits 4 unless the resumed turn produced a new valid result, and a Cursor
   result in the stream file counts.
4. `gate` exits 1 both for a FAIL verdict and when it cannot derive run state.
   On `p2`, `gate --plan missing-plan.md` exited 1 with `failed: ["derive"]`.
   The CLI reclassifies derive and run-state failures as infrastructure by
   reading the retained gate output; the gate's exit code alone cannot.
   Status: fixed in audit T5 (`4a8992de`, `05cad812`); the controller maps
   exit 5 to infrastructure since audit T4 (`f0743b53`). A probe at the tip:
   `gate --plan missing-plan.md` exited 5 with `failed: ["derive"]`, an
   unreadable `status.json` alone exited 5 with `failed: ["run-state"]`, the
   same beside a fileset violation exited 1 with
   `failed: ["fileset","run-state"]`, and a fileset violation alone exited 1.
5. The only `dispatchPhase` call, in `scripts/cli.mjs`, passes no `execution`
   contract. T6's per-attempt driver journal (attempts persisted before
   spawn, model/effort/prompt binding, in-driver recovery) is therefore not
   reached through `workflow-execute`. Both journals hold only controller
   events with task `profile`. Per the CLI's own limitation text and the
   fixture test named above, an interrupted implement or review step stays an
   unknown effect that no command clears; this was not reproduced for real.
   Status: fixed for codex clone runs in audit T4 (`9cd83cf7`, `27b8f876`)
   and audit T5 (`4a8992de`). The controller writes an execution contract per
   dispatch attempt and passes it with `dispatch --execution`. A cursor
   harness or a files sandbox still gets none, because strict driver
   execution refuses files sandboxes, and the report names the driver journal
   unavailable. An interrupted agent step is now an `agent-dispatch` effect
   that `workflow-resolve` clears with `not-started` or `completed` (audit T1
   `6c68985a`). The contract's `maxAttempts` is always 10 (open item 1). No
   real model run has reached the driver journal.
6. After a completed `human-required` run, `workflow-status` exits 4 because
   attempts recorded before integration reconcile as `branch-changed` once the
   run branch moves. Status exit 4 does not distinguish that from a stuck run.
   Status: fixed in audit T1 (`6c68985a`, the `superseded` state) and audit
   T5 (`4a8992de`, the integration after-refs passed as `expectedAdvances`).
   Status exits 0 only with no unresolved attempt, no unknown effect and the
   lifecycle `running`. A probe at the tip: one completed step exited 0, a
   `suspended` lifecycle marker exited 4, and an interrupted `agent-dispatch`
   exited 4 with one unknown effect.
7. In clone mode the implementer's task commit carried the host's global Git
   identity, not the fixture repository's local identity. The host-bounded
   merge commit carried the local identity. Projects that require a specific
   author need their identity configured globally or in the clone.
   Status: fixed in audit T2 (`be5c2137`, `234d95b7`, merged `a0586108`). The
   codex clone receives the run repository's identity, and the Cursor
   checkout commit uses the run repository's identity, per the harness tests
   that passed at the tip.
8. The read-only PR outcome query and `pruneExecutionArtifacts` have no caller
   outside their modules. No CLI command prunes retained artifacts or queries
   an effect. Vault and publication effects have no adapter.
   Status: pruning fixed in audit T1 (`6c68985a`, `7c05f5cc`) and audit T5
   (`4a8992de`, `workflow-prune`). Still open: the PR outcome query in
   `scripts/execution-recovery.mjs` has no caller outside the module, and
   Vault and publication effects have no adapter.
9. `workflow-resolve` requires `reason` to be one token matching
   `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. A reason with spaces was refused with
   the generic `Invalid bounded local operator resolution`. An effect the
   journal never recorded was refused with `Resolution needs one strict
   recorded external effect`. Both exited 2.
   Status: fixed in audit T5 (`4a8992de`). A reason with spaces now exits 2
   with `reason must be one token: a letter or digit, then up to 127 letters,
   digits, dots, underscores or dashes, with no spaces`.
10. Each of the two root suite runs with `TMPDIR=/tmp/hx` left four
    processes (a `node -e setInterval` child under a trampoline shell) whose
    cwd was a deleted `fm-trampoline-*` directory. That directory is created by the
    `verification trampoline preserves child exits...` test in
    `tests/harness-codex.test.mjs`. They were killed by hand.
    Status: fixed in audit T2 (`be5c2137`, `234d95b7`). The harness tests
    that terminate the trampoline with SIGTERM, SIGINT and SIGHUP from
    outside, and the one with an outer timeout shorter than its own, assert
    that no process of the command's group survives; SIGKILL cannot be
    trapped. After both harness test files ran at the tip, `pgrep -af "node
    -e setInterval"` matched no process.
11. The first hub run failed `fm ls lists each PTY with its repo, pid, start
    and attached clients` (repo column `tmp` instead of `~/ls-plain`). The
    file passed alone (27/27) and the full hub rerun passed 1,873/1,873.
    Status: the empty-`.git` misattribution was fixed in audit T3
    (`f2202bce`, `2d33f133`, merged `6cec44e7`): the three walk-ups count a
    `.git` directory only with a `HEAD`. With an empty `.git` in an ancestor
    of `TMPDIR`, `fm.test.mjs`, `machines.test.mjs` and `tiers.test.mjs`
    passed 336 of 336 at the tip. The test is still reported flaky under load
    (open item 9).

## Open items after the audit

These remain open at `584e9175`. File and line references were read at that
tip. "Unpinned" means the mutation named was applied, the named test files
still passed, and the file was then restored.

1. The controller writes `maxAttempts: DRIVER_ATTEMPTS` (10) into every
   dispatch execution contract (`scripts/workflow-controller.mjs:508` and
   `:513`), not min(10, the request's `maxAttempts`). This is a design call
   left to the owner.
2. Three audit T4 guards are unpinned. Each mutation left
   `tests/workflow-controller.test.mjs` and
   `tests/execution-controller-cli.test.mjs` at 59 of 59 passing: dropping
   `implement-<phase>` from the driver identity drift pattern
   (`scripts/workflow-controller.mjs:908`), counting a `not-started`
   resolution as drift (`:910`), and applying the 9-round driver cap without
   a driver journal (`:397`). The cap with a journal is pinned.
3. The harness-codex test "ordinary pipeline timeout stops its own delayed
   child fixture" is reported flaky under load. It passed in every run in
   this task; the flake was not reproduced.
4. The artifacts lock reclaim's inode recheck
   (`scripts/execution-artifacts.mjs:180`, `current.ino !== holder.ino`) is
   unpinned: removing it left `tests/execution-artifacts.test.mjs` and
   `tests/execution-journal.test.mjs` at 129 of 129 passing.
5. A chain of 8 dead reclaim tokens leaves the artifact store busy for good
   (`MAX_RECLAIM_CHAIN` at `scripts/execution-artifacts.mjs:112`, loop at
   `:172`). A probe planted a dead-holder lock with 7 and with 8 dead tokens.
   With 7 the next retain reclaimed it (`dead-lock-holder`). With 8, two
   consecutive retains each refused after about 5,000 ms with `Artifact
   storage is busy or an interrupted write requires reconciliation`.
6. `claimToken` (`scripts/execution-artifacts.mjs:158`) writes its token
   through `writePid` (`:128`), which does not fsync; the file's only `sync()`
   calls are at `:85`, `:237` and `:272`.
7. `retainedAcceptance` keeping the latest evidence per criterion
   (`scripts/cli.mjs:3195`) is unpinned: a keep-first mutation left
   `tests/execution-controller-cli.test.mjs` at 26 of 26 passing.
8. The native `verified-complete` path (exit 0 through the real `codex
   sandbox` verification) is unproven. The audit ran no real-model or sandbox
   trial; the fixture run ends `unresolved` with exit 4.
9. The hub test "fm ls lists each PTY with its repo, pid, start and attached
   clients" is reported flaky under load. It passed in the one run in this
   task; the flake was not reproduced.
10. The comment above `EXIT_CONTRACT` (`scripts/workflow-controller.mjs:330`)
    still says a derive or run-state failure arrives as exit 1 until the gate
    implements exit 5. The gate exits 5 at this tip (finding 4), so that
    sentence is stale.
11. `dispatch-integrator --isolated-legacy` is kept by owner decision.
    README's "Integrator dispatch outside the workflow" paragraph states what
    it checks and its trust limits: full same-user authority, restrictions
    that are prompt instructions, and after-the-fact checks over refs, the
    checkouts and the result file only.

## CLI contracts, defaults and trust limits

README's "Bounded workflow execution" section documents the request and
resolution schemas, exit codes, retention bounds, storage layout and legacy
paths as read from `scripts/cli.mjs` and `scripts/workflow-controller.mjs`
and observed in these trials. There are no defaults: every request field is
required, and an unknown field is refused. The recovery module and its
tests treat version 1 journal events as historical observations that never
become completion evidence; no version 1 event was produced in these trials.
Dispatch without `--environment`/`--role-policy` stays the labelled legacy
path; it was not used here.

Trust limits stated in the receipts' `trust` fields: commands come only from
the fixed profile fragments; executor, capability and environment
observations are same-UID local observations, not hostile-process isolation;
local journal observations are not authenticated external authorization;
fsync does not guarantee power-loss recovery. By its output contract a
`workflow-resolve` records a local observation (`externalEffect:
"none-performed"`); no resolution was recorded in these trials. Deck was not
changed or tested here. Driver or controller recovery does not preserve deckd
PTYs across a daemon restart, which remains the accepted Deck boundary.

## Issue acceptance matrices

Status values: met (observed in a real run or probe on this source), partial,
fixture (repository tests only), unmet, pending (needs owner or provider
evidence).

The matrices record T9's evidence on `db6a5f0c` and are not re-scored here.
Where a gap cites finding 1, 2, 5, 8 or 9, the audit added code and fixture
or probe evidence only, as each finding's status says; no criterion moved to
met, because no real run exercised the new paths.

### Issue 42 (W10)

| Criterion | Status | Evidence and gap |
| --- | --- | --- |
| Execute bug-fix, feature, migration, UI and research profiles | partial | Bug-fix and feature ran for real. Migration, UI and research are only expanded in dry-run tests; UI also needs a render capability |
| Validate named outputs before releasing dependent work | met | Each step's artifacts were read back and validated before the next spawn; task result, review stamp, results path and gate input were bound to exact tips |
| Distinguish preparation, implementation, verification, judgment, publication | partial | Steps are typed and publication is absent; judgment is the unmet acceptance step |
| Optional steps, attempt/repair/wall-time limits, capability preflight, escalation | partial | Attempt and wall budgets were recorded and capability/environment preflight ran for real. Repair rounds are not delivered (finding 2); escalation is fixture-only |
| Capture stdout, collect current reviews, integrate W11 boundaries | partial | Stdout artifacts and current review collection were observed. W11 driver boundaries are not wired (finding 5) |
| Reuse on two tasks; evaluate real workflows through W02 | partial | Two real tasks reused the same CLI path. W02 evaluation is pending: these integration trials are not a dataset or a quality measurement |

### Issue 43 (W11)

| Criterion | Status | Evidence and gap |
| --- | --- | --- |
| Versioned run/step/attempt records at real driver boundaries | partial | Version 2 controller step records were observed. The driver-level attempt journal is not reached from the CLI (finding 5) |
| Reconcile refs, worktrees, artifacts and inputs before redispatch; fresh gates | met | Resume revalidated and reused prior outputs, reran collect and gate fresh, and did not redispatch a model |
| Query authorized PR/Vault/publication effects after uncertain outcomes | unmet | The PR query exists only as a module function (finding 8); Vault and publication have no adapter |
| Suspend/resume/resolution adapters with bounded retention and honest limits | partial | Resume and resolve exist and refuse unrecorded effects. Retention is bounded per artifact and run, but no command prunes |
| Kill a real driver at documented boundaries | partial | One real boundary (during the gate, after collection) recovered with no duplicate model run or merge. In-dispatch boundaries are fixture-only |
| Keep Deck daemon/PTY restart limits explicit | met (documentation) | Stated here and in README; no deckd restart was tested |

### Issue 33 (W01)

| Criterion | Status | Evidence and gap |
| --- | --- | --- |
| Pin completion requirements to tracked identities; enumerate unmet obligations | met | Both real reports bound commit, plan, manifest, context, environment and verifier hashes and listed `final-command` and `acceptance` as unresolved |
| Invalidate evidence on input change; separate current from historical verdicts | fixture | Changed-input and stale-acceptance refusals are repository tests. Real resumes reran mandatory verdicts rather than reusing them |
| Real graceful callbacks, abrupt loss, ambiguous bindings, suspension, abandonment, loops | pending | No Claude Code session was started and no fixture was recaptured. Only an abrupt controller loss was observed for real |
| Distinct states; skipped checks and fail-open limits in README and doctor | partial | `human-required` and `blocked` were observed for real; doctor and status print limitations and standing skips. The remaining states are fixture-only |

## Checks, reviews and claims coverage

Commands run in the T9 worktree on the base source before any edit:

```sh
TMPDIR=/tmp/hx npm test
npm ci --prefix hub
TMPDIR=/tmp/hx npm --prefix hub test
node scripts/security-lint.mjs --root . --json
```

Root: 3,465 tests, 3,448 pass, 0 fail, 17 skipped. Hub: one load-dependent
failure (finding 11), then 1,873 of 1,873 on rerun. Instruction lint: 17
files, zero findings. The deck process check printed nothing after the hub
run. After the documentation edits, the root suite again reported 3,465
tests, 3,448 pass, 0 fail and 17 skipped, lint again reported zero findings,
and `git diff --check` passed. The `complete` gate is recorded in the task
result.

T9 used zero fix rounds. The four-lens review (correctness, security, tests,
claims) and the full phase gate belong to the host and are pending here. Every
behavioral sentence in this report traces to a receipt or a command run in
this task, as listed above. Bounded claims coverage: findings 1, 2 and 5 are
backed by source reads plus the real reports; findings 3, 4, 6 and 9 by
probes; the rest by real-run receipts. No product mutation was run, because
T9 changes no code.

No telemetry, Vault write, fixture recapture, model download, push or
publication was performed. Live Claude callbacks, W02 campaigns and human
acceptance judgments remain owner obligations.
