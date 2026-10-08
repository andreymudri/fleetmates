# Release fixes: journal read race, integration identity and retried verification status

## Destination

Before fleetmates 2.4.0 and the deck are released, three things hold. Parallel strict tasks never fail a journal read because another task is mid-append. The host-bounded integration merge keeps the commit identity the operator set in the environment. A run whose driver verification failed once and then passed reports reconciled in `workflow-status`. Each fix is pinned by a test that fails without it.

## Global Constraints

- Node >= 24.2.0; zero new runtime or development dependencies (root package); `hub/` is not changed.
- Commit messages: single-line conventional English; configured git author only; never run `git config` (a linked worktree writes the shared `.git/config`).
- No personal identities, credentials or actual home paths in code, docs, fixtures or test output; use `/home/you` placeholders and placeholder identities in tests.
- Do not modify `fleetmates.gate.json`, any file in `docs/plans/`, or anything under `.fleetmates/` by hand.
- Task changes stay in their declared file sets.
- Every new test must be seen failing under a targeted mutation of the code it covers, then restored; run affected and complete suites after.
- Use a private short `TMPDIR` under `/tmp/hx` (for example `/tmp/hx/c1`); kill every process a task starts.
- No real model sessions (Claude, Codex, Cursor) in this run.
- Docs in English, plain prose, no em dash character.

## Out of Scope

- Copying the run repository's resolved identity into a Codex clone (`scripts/harnesses/codex.mjs` ~259) - it is intentional, and an environment identity still overrides it for the worker's own commits.
- Releasing, tagging or publishing - release steps that follow this run, each confirmed by the owner.

### Task 1: a journal read never fails on another writer's in-flight temporary file

**Files:**
- Modify: `scripts/execution-journal.mjs`
- Test: `tests/execution-journal.test.mjs`

**Acceptance:**
- Background (open item 14). `appendExecutionEvent` writes `.<uuid>.tmp` in the journal directory, syncs it, links it to `<sha>.json` and unlinks it (`scripts/execution-journal.mjs` ~250). `readExecutionEvents` (~172-180) skips only lock entries, so an unlocked reader that runs during that window throws `Incomplete execution journal storage`. The driver reads without the lock (`scripts/driver.mjs` ~439 and ~616).
- A test first reproduces the failure. It runs real concurrent appends from at least two child processes against one journal, while a reader calls `readExecutionEvents` in a loop. It must observe the throw on the current code, and the test is made deterministic enough to fail reliably, for example by holding a temporary file in place through a seam or a planted `.<uuid>.tmp` of the exact appender name shape.
- After the fix, `readExecutionEvents` does not throw on a temporary file with the appender's exact name shape (`.` + UUID + `.tmp`) that is younger than the existing stale threshold. It ignores the file, because a temporary is never a record.
- Any other unexpected entry is still refused with the same error. That covers a non-matching name, a stale temporary older than the threshold that no lock holder reconciled, and a symlink.
- The concurrent test passes 20 times in a row after the fix.
- Mutations each fail a test, then are restored: dropping the temporary-name allowance, widening it to any `.tmp` name, and dropping the age bound.

- [ ] Step 1: Write the concurrent reproduction and the planted-temporary tests; observe the throw.
- [ ] Step 2: Implement the bounded allowance in `readExecutionEvents`.
- [ ] Step 3: Apply the three mutations; observe the matching failures; restore.
- [ ] Step 4: Run `tests/execution-journal.test.mjs` and `tests/driver-recovery.test.mjs` (the latter 5 times, to cover the test at ~613), then the root suite; commit only the declared files.

### Task 2: host-bounded integration keeps the operator's environment identity

**Files:**
- Modify: `scripts/reviewed-integration.mjs`
- Test: `tests/reviewed-integration.test.mjs`

**Acceptance:**
- Background. `scopedGit` (`scripts/reviewed-integration.mjs` ~54) drops every `GIT_*` variable, and that includes `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`. So the integration merge (~365) takes the host's global identity, even when the operator set a placeholder identity in the environment. The real T6 trial showed this.
- After the fix, those four variables pass through to the integration git calls when they are set. Every other `GIT_*` variable is still dropped, including `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG*` and `GIT_EXEC_PATH`.
- Test 1 runs an isolated `HOME` whose gitconfig names a host identity, with a placeholder identity in the environment. It asserts that the real integration merge commit has the placeholder as both author and committer.
- Test 2 asserts that a planted `GIT_DIR` or `GIT_INDEX_FILE` in the environment still does not reach the integration git.
- Mutations each fail a test, then are restored: dropping the identity allowance, and allowing every `GIT_*` variable through.

- [ ] Step 1: Write both tests; observe the identity test fail.
- [ ] Step 2: Implement the four-variable allowance.
- [ ] Step 3: Apply the mutations; observe the failures; restore.
- [ ] Step 4: Run `tests/reviewed-integration.test.mjs` and the root suite; commit only the declared files.

### Task 3: a failed attempt followed by a completed retry is superseded

**Files:**
- Modify: `scripts/execution-recovery.mjs`
- Test: `tests/execution-recovery.test.mjs`

**Acceptance:**
- Background (open item 13). In `reconcileExecution` (`scripts/execution-recovery.mjs` ~212), an attempt that ended `step-failed` stays `failed-observation`, and that counts as unresolved even when a later attempt of the same executionId, task and step ended `step-completed`. So `workflow-status` exits 4 after a run whose teammate was rejected once and then passed. The `unresolved` count comes from `scripts/cli.mjs` ~3288.
- After the fix, such a failed attempt is reported as `superseded`. A failed attempt with no later completed attempt of the same executionId, task and step stays `failed-observation` and stays unresolved. A later attempt that is still started-only, or that failed again, does not supersede it. Neither does a completed attempt under a different executionId, task or step.
- An attempt that failed because an external effect failed (`effects.some(e => e.outcome === 'failed')`) is not superseded by this rule, because the retry does not undo an external effect.
- Tests cover each case: superseded, no later attempt, later attempt started-only, later attempt failed, different executionId, different task, different step, and failed external effect.
- One test runs through the CLI. It is based on the T5 fixture in `tests/workflow-controller.test.mjs` that feeds the driver outcomes `['step-failed', 'step-completed']`, and it asserts that `workflow-status` exits 0. Keep this test in `tests/execution-recovery.test.mjs` if possible; if it needs the controller fixture, say so in the result rather than editing an undeclared file.
- Mutations each fail a test, then are restored: superseding any failed attempt, ignoring the executionId/task/step match, and dropping the external-effect exclusion.

- [ ] Step 1: Write the tests; observe the superseded cases fail.
- [ ] Step 2: Implement the rule.
- [ ] Step 3: Apply the mutations; observe the failures; restore.
- [ ] Step 4: Run `tests/execution-recovery.test.mjs`, `tests/execution-controller-cli.test.mjs`, `tests/workflow-controller.test.mjs` and the root suite; commit only the declared files.

### Task 4: record the fixes in the validation doc

**Files:**
- Modify: `docs/specs/2026-10-06-execution-recovery-validation.md`

**Depends:** T1, T2, T3

**Acceptance:**
- Open items 13 and 14 and the integration-identity observation from Trial 4 are marked fixed. Each cites the task commit and the test names that pin it, and each test name is checked by running it at the task's tip.
- No other item's status changes. The doc states that no new real-model trial was run for these fixes.

- [ ] Step 1: Run the cited tests at the tip and record the counts.
- [ ] Step 2: Update the doc from those outputs only.
- [ ] Step 3: Run `git diff --check`, `node scripts/security-lint.mjs --root . --json` and a scan for personal paths and em dashes; commit only the declared file.
