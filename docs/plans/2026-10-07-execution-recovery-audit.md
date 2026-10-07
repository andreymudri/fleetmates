# Execution recovery audit fixes

## Destination

Every defect the cross-task audit of run `open-issues-execution-recovery` confirmed is fixed and
pinned by a test that fails without the fix, so a profile run can reach `verified-complete`
(exit 0) through `workflow-execute`/`workflow-resume`, repair a code failure inside its budget,
survive an interrupted write, and report a finished run as reconciled.

## Global Constraints

- Node >= 24.2.0; zero new runtime or development dependencies (root package); `hub/` keeps its existing dependencies only.
- Commit messages: single-line conventional English; configured git author only; never run `git config` (a linked worktree writes the shared `.git/config`).
- No personal identities, credentials or actual home paths in code, docs, fixtures or test output; use `/home/you` placeholders.
- Do not modify `fleetmates.gate.json`, any file in `docs/plans/`, or anything under `.fleetmates/` by hand.
- Task changes stay in their declared file sets.
- Preserve Git-derived fileset/ownership enforcement and every tracked gate check.
- Every new test must be seen failing under a targeted mutation of the code it covers, then restored; run affected and complete suites after.
- Use `TMPDIR=/tmp/hx` for tests; kill every process a task starts, including `node -e setInterval` fixture children.
- No real model sessions (Claude, Codex, Cursor) in this run; use the existing fake-harness and child-process fixtures.
- Docs in English, plain prose, no em dash character.

## Contracts between tasks

These are the exact interfaces later tasks build on. A task that produces one implements it as
written; a task that consumes one relies on nothing beyond it.

- **Retention bounds (T1 -> T4, T5):** `scripts/execution-artifacts.mjs` exports
  `RETENTION_LIMITS` (the existing upper bounds object). `workflow-controller.mjs` and `cli.mjs`
  import it instead of keeping their own copies.
- **Retain never refuses because of other files (T1):** `retainExecutionArtifact` no longer throws
  because some *other* stored artifact is older than `maxAgeMs` or because the run is over
  `maxRunBytes` from old content; it refuses only when the new artifact itself cannot fit.
  `pruneExecutionArtifacts({ root, runId, retention, liveReferences })` (existing signature) removes
  non-live content and returns `{ removed: [...], kept: [...], bytes }`.
- **Interrupted-write reconciliation (T1):** the journal and artifact store lock directories
  record the holder pid in `<lock>/pid`. A lock whose pid is not alive, and a `.<uuid>.tmp` file
  older than 60 s with no live lock, are removed by the next writer and reported in the returned
  metadata as `reconciled: [{ path, reason }]`. A lock held by a live process is waited on with
  bounded backoff (total wait <= 5 s) before refusing with the existing "busy" error.
- **Superseded attempts (T1 -> T5):** `reconcileExecution(..., { expectedAdvances })` (in
  `scripts/execution-recovery.mjs`) accepts `expectedAdvances: [{ ref, to }]`. An attempt whose
  only mismatch is that `ref` now points at `to`, or at a descendant of `to`, is reported with
  state `superseded`, which does not count as unresolved.
- **Agent dispatch is a resolvable effect (T1 -> T4, T5):** `execution-recovery.mjs` accepts
  effect kind `agent-dispatch` with outcomes `not-started` and `completed` in
  `resolveExecutionEffect`. A resolved `not-started` lets resume redispatch the step; `completed`
  lets resume validate and reuse the step's outputs.
- **Gate state-failure exit (T5 -> T4):** `cli.mjs gate` exits 5 when the only failed entries are
  `derive` and/or `run-state`. A verdict with any other failed check keeps exit 1. Exit 0/2/3
  are unchanged.
- **Dispatch execution contract (T5 -> T4):** `cli.mjs dispatch` accepts `--execution <abs path>`
  naming a JSON file whose content is exactly the object `dispatchPhase` already validates as its
  required execution (`scripts/driver.mjs` `requiredExecution`): `{ version: 1, common, runId,
  executionId, inputs, retention, maxAttempts, deadlineAt }`, and passes it unchanged as the
  `execution` option, so the T6 per-attempt journal is used. The controller builds it: `common` is
  the canonical git common dir, `executionId` a label derived from the controller attempt,
  `inputs` a strict execution identity, `retention` the request's retention, `maxAttempts` <= 10,
  `deadlineAt` no later than the request deadline and within 24 h. Strict execution refuses files
  sandboxes, so the controller appends `--execution` only for harnesses whose sandbox mode is not
  `files` (not cursor) and reports the journal as unavailable otherwise.
  (Amended 2026-10-07: the original four-field shape did not match `requiredExecution`.)
- **Fix-round dispatch (T5 -> T4):** `cli.mjs dispatch` accepts `--fix-round --task <id>` (repeatable).
  It dispatches only the named tasks with the fix-round brief (no branch reset) and respawns them
  even when a `done` result is recorded. `record-fix-round` keeps its current interface.
- **Acceptance evidence (T5 -> T4):** `cli.mjs workflow-accept --file <abs> --root <abs>` reads
  `{ version: 1, runId, tree, criteria: [{ criterion, status: 'pass'|'fail', note }] }`, refuses a
  `tree` that is not the current integrated run-branch tree, and retains one `acceptance-evidence`
  artifact per criterion as `{ version: 1, criterion, tree, status }`. `workflow-resume` passes
  every retained acceptance reference for the run to the controller's existing `acceptance`
  option.

## Out of Scope

- Changing what `dispatch-integrator --isolated-legacy` does - the owner decided to keep it; T6 documents it and its trust limits.
- Real subscription-model trials - T9 of the previous run covered them; this run uses fixtures only.

### Task 1: make execution storage recoverable after interruption and age

**Files:**
- Modify: `scripts/execution-artifacts.mjs`
- Modify: `scripts/execution-journal.mjs`
- Modify: `scripts/execution-recovery.mjs`
- Test: `tests/execution-artifacts.test.mjs`
- Test: `tests/execution-journal.test.mjs`
- Test: `tests/execution-recovery.test.mjs`

**Acceptance:**
- An artifact older than `maxAgeMs` in the store does not make a later `retainExecutionArtifact` throw; a new artifact that alone exceeds a bound still refuses.
- `pruneExecutionArtifacts` removes only content not in `liveReferences` and reports what it removed and kept.
- A planted stale `.<uuid>.tmp` (older than 60 s) and a lock whose `pid` file names a dead process are reconciled by the next journal append and the next retain, and reported in `reconciled`; a lock held by a live pid is waited on (<= 5 s) then refused as busy.
- 8 concurrent `retainExecutionArtifact` calls on one store all succeed.
- `RETENTION_LIMITS` is exported and is the single definition of the upper bounds.
- `reconcileExecution` reports `superseded` for an attempt whose only mismatch is a ref advanced to (or past) an `expectedAdvances` entry.
- `resolveExecutionEffect` accepts kind `agent-dispatch` with outcomes `not-started` and `completed`, and still refuses unknown kinds and outcomes.
- Boundary tests pin the journal's 1000-event limit and 1 MiB read bound (n accepted, n+1 refused).

- [ ] Step 1: Write failing tests for each acceptance line using real temporary repositories and real child processes for the dead-pid case.
- [ ] Step 2: Observe each fail for the intended reason.
- [ ] Step 3: Implement pid-stamped locks, bounded backoff, stale tmp reconciliation, the retain/prune split, `RETENTION_LIMITS`, `superseded` and the `agent-dispatch` effect kind.
- [ ] Step 4: Mutate each guard (age refusal scope, pid liveness check, tmp age threshold, backoff bound, superseded ancestry check, effect-kind allow-list, each numeric bound); observe the matching test fail; restore.
- [ ] Step 5: Run the three test files and the root suite; commit only the declared files.

### Task 2: stop leaking verification process trees and keep clone identity

**Files:**
- Modify: `scripts/harnesses/codex.mjs`
- Modify: `scripts/harnesses/cursor.mjs`
- Test: `tests/harness-codex.test.mjs`
- Test: `tests/harness-cursor.test.mjs`

**Acceptance:**
- The verification trampoline handles SIGTERM, SIGINT and SIGHUP by killing its detached command's process group before exiting; a test terminates the trampoline from outside and asserts that no process of the command's group survives.
- The existing "verification trampoline preserves child exits" test sets the inner `timeoutMs` (e.g. 200) on `buildVerificationInvocation` with a larger outer timeout, asserts `receipt.timedOut`, and leaves no process behind (asserted, not assumed).
- In clone mode, `user.name` and `user.email` resolved in the run repository are written into the clone's own git config, so an implementer commit in the clone carries the project identity, not the host global one; verified for codex and, if cursor has a clone path, for cursor.
- SIGKILL of the trampoline still cannot be trapped; that limit is stated in a code comment next to the handler.

- [ ] Step 1: Write the outside-termination test, the fixed timeout test and the clone-identity tests; run them and observe the leak and the wrong author.
- [ ] Step 2: Implement the signal handlers and the clone identity copy.
- [ ] Step 3: Mutate the handler registration, the group kill and the identity copy; observe matching failures; restore.
- [ ] Step 4: Run both harness test files twice and confirm with `pgrep -f setInterval` that nothing they started survives; run the root suite.
- [ ] Step 5: Commit only the declared files.

### Task 3: an empty .git directory is not a repository in the deck

**Files:**
- Modify: `hub/bin/fm.mjs`
- Modify: `hub/server/machines/session.mjs`
- Modify: `hub/server/approvals/tiers.mjs`
- Test: `hub/test/integration/fm.test.mjs`
- Test: `hub/test/unit/machines.test.mjs`
- Test: `hub/test/unit/tiers.test.mjs`

**Acceptance:**
- `repoOf` in `hub/bin/fm.mjs`, `workingRoot` in `hub/server/machines/session.mjs` and `inGitWorkTree` in `hub/server/approvals/tiers.mjs` treat a `.git` directory as a repository marker only when it contains a `HEAD` file (a `.git` file must still start with `gitdir:`).
- Tests create an empty `.git` directory in an ancestor of their fixture directory (never `/tmp/.git` itself) and assert the fixture is not attributed to that ancestor; with a real repository the existing behavior is unchanged.
- With an empty `.git` in an ancestor of TMPDIR, `fm.test.mjs`, `machines.test.mjs` and `rules-api.test.mjs` all pass (they failed before: "fm ls lists each PTY...", "public session projections...", the /api/rules tests).

- [ ] Step 1: Write the ancestor-empty-.git tests; run them and observe the misattribution.
- [ ] Step 2: Implement the HEAD check in the three walk-ups.
- [ ] Step 3: Mutate each of the three checks back to plain existence; observe the matching failure; restore.
- [ ] Step 4: Run the full hub suite with `TMPDIR=/tmp/hx` (after `npm ci --prefix hub`) and once more with an empty `.git` in an ancestor of a short TMPDIR you create; both green.
- [ ] Step 5: Commit only the declared files.

### Task 4: repair rounds, execution journal and honest classification in the controller

**Files:**
- Modify: `scripts/workflow-controller.mjs`
- Modify: `scripts/workflow-profile.mjs`
- Modify: `scripts/driver.mjs`
- Test: `tests/workflow-controller.test.mjs`
- Test: `tests/workflow-profile.test.mjs`
- Test: `tests/driver-recovery.test.mjs`
- Modify: `scripts/brief.mjs`
- Test: `tests/brief.test.mjs`
- Test: `tests/execution-controller-cli.test.mjs`

**Depends:** T1

**Acceptance:**
- EXIT_CONTRACT maps `gate` exit 5 to `infrastructure` and exit 1 to `code`; the comment claiming exit 1 is the only code failure is corrected.
- On a code failure whose `fix` decision is `retry`, the controller runs `record-fix-round --run --phase --task <id>` for each listed task, then `dispatch --fix-round --task <id>...`, then review, collect and gate again; rounds are bounded by `min(request.limits.maxRepairRounds, the fix decision's remaining budget)`; `escalate` or an exhausted budget stops `failed` with the existing reasons. The fake CLI in tests implements the T5 contract exactly.
- `driver.mjs` gains a fix-round mode used by `dispatch --fix-round`: it respawns or resumes the named tasks even when a `done` result is recorded, never resets their branches, and journals the attempt.
- The controller writes the dispatch execution contract file and appends `--execution <abs>` to every `dispatch` argv; expansion validation accepts that argument and nothing else new.
- Agent steps (`dispatch`, `dispatch-reviews`) are journaled as `agent-dispatch` effects (start before spawn, outcome after); an interrupted one resolved `not-started` is redispatched on resume and one resolved `completed` is validated and reused.
- The controller reads the lifecycle with `lifecycleStatus(root, runId)` instead of assuming `running`; a suspended or abandoned run never reports `verified-complete`.
- Retention bounds are imported from `RETENTION_LIMITS`; boundary tests pin `maxAttempts`, `maxWallMs`, `stepTimeoutMs`, `maxRepairRounds` and the 4096-byte parameter bound (n accepted, n+1 refused).
- A two-task phase with `maxParallel: 2` and an execution contract completes without a "busy" storage error.
- `scripts/brief.mjs`: a fix-round brief never resets the task branch, including when the task carries `runtime` (today `checkoutSteps` returns the runtime steps first and ignores `fixRound`); a test composes a fix-round brief with runtime and asserts no `checkout -B <branch> <base>` and the fix-round instructions present.
- `tests/execution-controller-cli.test.mjs` (amended into this task 2026-10-07): only the existing tests this task's behavior change invalidates are updated ("a failing gate stops with no merge and reports the repair budget as undelivered" and the gate-run-state case of "a gate that cannot derive run state is reported as blocked infrastructure"), so the merged tree stays green; the fake CLI there gains `record-fix-round`. T5 rewrites this file further for its own contracts.

- [ ] Step 1: Write failing tests: gate exit 5 classification, a full repair round to PASS within budget, budget exhaustion, escalate, the execution argv, an interrupted agent dispatch resolved both ways, suspended lifecycle, the numeric bounds, and the two-task parallel run.
- [ ] Step 2: Observe each fail for the intended reason.
- [ ] Step 3: Implement the controller, profile and driver changes against the contracts above.
- [ ] Step 4: Mutate each new guard and bound; observe the matching failure; restore.
- [ ] Step 5: Run the three test files, `tests/driver.test.mjs` and the root suite; commit only the declared files.

### Task 5: CLI contracts for gate state failures, repair, acceptance and recovery

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/execution-controller-cli.test.mjs`
- Test: `tests/cli.test.mjs`
- Test: `tests/adversarial.test.mjs`
- Test: `tests/execution-prerequisites.test.mjs`

**Depends:** T1, T4

**Acceptance:**
- `gate` exits 5 when the only failed entries are `derive` and/or `run-state`, and 1 when any other check failed (including a real fileset failure alongside `run-state`); `reclassifyGateStateFailure` is deleted and the controller's classification is used.
- `dispatch --execution <abs>` and `dispatch --fix-round --task <id>` implement the contracts above; a relative path, a missing file or an unknown task exits 2 before any spawn.
- `workflow-accept --file <abs> --root <abs>` implements the acceptance contract; `workflow-resume` passes the retained acceptance references, and a fixture run with acceptance recorded runs `finish` and reports `obligations.verifiedComplete: true`. (Amended 2026-10-07: `verified-complete` with exit 0 also requires native verification, which runs the real `codex sandbox`; no real model or sandbox session is allowed in this run, so the injected-fixture run ends `unresolved` with exit 4 and the native path stays unproven, which T6 records.)
- `workflow-status` passes the recorded integration steps' after-refs as `expectedAdvances`, so a normally finished run reports `reconciled` and exits 0; the existing tautological assertion at `tests/execution-controller-cli.test.mjs` (status exit vs its own unresolved count) is replaced by a concrete expected exit.
- `workflow-prune --run <id> --root <abs>` calls `pruneExecutionArtifacts` with the journal's live references and prints what it removed and kept.
- `workflow-resolve` resolves an interrupted `agent-dispatch` effect; an invalid `reason` gets an error that says it must be one token.
- `message` exits 4 unless the resumed turn produced a new valid result: any `exitCode !== 0` (including -2 on spawn failure) and a clean exit with no new result exit 4; when the adapter exposes `readResult`, the outcome is read through it with `streamPath`, so a cursor result in the stream file counts. The tests in `tests/cli.test.mjs`, `tests/execution-prerequisites.test.mjs` (the two "required ... session persists enforcement through message and flagless dispatch" tests and "CLI message persists actual worker receipts...") that pinned the old exit 0 are updated to the new contract, and `tests/adversarial.test.mjs` "gate reports the ambiguity, not a silent guess, when both main and master exist" expects the derive-only exit 5; in those two files only the expected exit codes change (amended 2026-10-07).
- The run-id and request numeric bounds are pinned by boundary tests (n accepted, n+1 refused).

- [ ] Step 1: Write failing CLI-level tests in real temporary repositories for every acceptance line.
- [ ] Step 2: Observe each fail for the intended reason.
- [ ] Step 3: Implement the handlers and wiring.
- [ ] Step 4: Mutate each new guard and exit path; observe matching failures; restore.
- [ ] Step 5: Run both test files, the root suite and `node scripts/security-lint.mjs --root . --json`; commit only the declared files.

### Task 6: document the fixed contracts and update the validation record

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/2026-10-06-execution-recovery-validation.md`

**Depends:** T2, T3, T5

**Acceptance:**
- README documents `gate` exit 5, `dispatch --execution`, `dispatch --fix-round`, `workflow-accept`, `workflow-prune`, the `agent-dispatch` resolution, repair rounds and their bound, the corrected `workflow-status` exit rule (0 only with no unresolved attempts, no unknown effects and lifecycle `running`), and `dispatch-integrator --isolated-legacy` with its trust limits.
- The validation doc's findings list marks each item this run fixed as fixed with the commit, keeps every unfixed item listed, and states that no new real-model trial was run.
- Every sentence about what code does is backed by a command run at the task's tip; nothing unmet is reported as met.

- [ ] Step 1: Run the new commands at the tip in a throwaway repository under /tmp/hx and record their exits.
- [ ] Step 2: Write the README and validation updates from those outputs.
- [ ] Step 3: Run `git diff --check`, `node scripts/security-lint.mjs --root . --json` and a scan for personal paths and em dashes; commit only the declared files.
