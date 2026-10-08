# Release blockers before fleetmates 2.4.0 and the deck

## Destination

The open items the owner marked as release blockers are closed. Each guard the audit left
unpinned fails a test when it is removed. The artifact store recovers from any chain of dead
reclaim tokens, and its tokens are synced to disk. A real Codex run reaches `verified-complete`
with exit 0 through native verification, and the validation record shows the evidence.

## Global Constraints

- Node >= 24.2.0; zero new runtime or development dependencies (root package); `hub/` is not changed.
- Commit messages: single-line conventional English; configured git author only; never run `git config` (a linked worktree writes the shared `.git/config`).
- No personal identities, credentials or actual home paths in code, docs, fixtures or test output; use `/home/you` placeholders.
- Do not modify `fleetmates.gate.json`, any file in `docs/plans/`, or anything under `.fleetmates/` by hand.
- Task changes stay in their declared file sets.
- Every new test must be seen failing under a targeted mutation of the code it covers, then restored; run affected and complete suites after.
- Use a private short `TMPDIR` under `/tmp/hx` (for example `/tmp/hx/b1`) for tests; kill every process a task starts, including `node -e setInterval` fixture children.
- Real model sessions are allowed only in Task 4, and only Codex (the owner authorized it on 2026-10-08), in throwaway projects under `/tmp/hx`. Tasks 1 to 3 use the existing fake-harness and child-process fixtures and must never invoke the real `codex`, `cursor-agent` or `claude` binaries.
- Docs in English, plain prose, no em dash character.

## Out of Scope

- The controller's `--execution` `maxAttempts` being 10 rather than min(10, the request's value) - the owner left it as a design call and did not mark it a blocker.
- The flaky "ordinary pipeline timeout" and hub "fm ls" tests - not marked as blockers; neither flake has been reproduced.
- Merging to `master`, version bumps, CHANGELOG, tags and publishing - release steps that follow this run and need the owner's confirmation one by one.

### Task 1: artifact store lock recovers any dead reclaim chain and syncs its tokens

**Files:**
- Modify: `scripts/execution-artifacts.mjs`
- Test: `tests/execution-artifacts.test.mjs`

**Acceptance:**
- A dead-holder lock carrying a chain of 8 dead reclaim tokens, and one carrying 20, are reclaimed by the next `retainExecutionArtifact` (reported as `reconciled: [{ path: '.lock', reason: 'dead-lock-holder' }]`), instead of refusing as busy after about 5 s. Today a chain of 8 refuses forever (`MAX_RECLAIM_CHAIN` at `scripts/execution-artifacts.mjs:112`, loop at `:172`).
- The reclaim loop stays bounded: its bound is derived from the entries actually present in the lock directory (read once per reclaim attempt), not a fixed 8, and a lock directory with more entries than a stated hard cap refuses with an error that names the lock path rather than spinning.
- Safety is unchanged: a lock held by a live pid is never removed; two concurrent writers reclaiming the same dead lock remove it at most once (an existing or new test with real child processes shows it).
- `writePid` syncs the file before closing it, so both the lock's `pid` and every reclaim token are durable before they are renamed or linked into place. A test pins the sync. Either use an injectable seam, or a source assertion that strips comments first; a comment naming the symbol must not satisfy it.
- The inode recheck in `reclaimLock` (`current.ino !== holder.ino`, `scripts/execution-artifacts.mjs:180`) is pinned. A test replaces the lock directory with a new one between the holder read and the reclaim (same dead pid, new inode) and asserts the new directory is left in place.

- [ ] Step 1: Write the chain-8, chain-20, hard-cap, sync and inode-swap tests; run them and observe each fail for the intended reason.
- [ ] Step 2: Implement the entry-derived chain bound, the hard-cap refusal and the sync in `writePid`.
- [ ] Step 3: Mutate the chain bound back to 8, drop the sync, and drop the inode recheck; observe the matching test fail each time; restore.
- [ ] Step 4: Run `tests/execution-artifacts.test.mjs`, `tests/execution-journal.test.mjs` and the root suite; commit only the declared files.

### Task 2: pin the controller guards and correct the exit contract comment

**Files:**
- Modify: `scripts/workflow-controller.mjs`
- Test: `tests/workflow-controller.test.mjs`

**Acceptance:**
- Removing `implement-<phase>` from the driver identity drift pattern (`scripts/workflow-controller.mjs:908`) fails a test.
- Counting a `not-started` resolution as drift (`:910`) fails a test.
- Applying the 9-round driver repair cap when there is no driver journal (`:397`) fails a test; the existing cap-with-journal test stays green.
- The comment above `EXIT_CONTRACT` (`:330`) says the gate exits 5 for a derive-only or run-state-only failure and 1 when any other check failed. No code in `scripts/workflow-controller.mjs` changes other than that comment.

- [ ] Step 1: Write the three guard tests against the current code; confirm each passes.
- [ ] Step 2: Apply each of the three mutations in turn; observe the matching test fail; restore.
- [ ] Step 3: Correct the comment.
- [ ] Step 4: Run `tests/workflow-controller.test.mjs`, `tests/execution-controller-cli.test.mjs` and the root suite; commit only the declared files.

### Task 3: pin acceptance keep-latest and the invalid-contract exits in the CLI

**Files:**
- Test: `tests/execution-controller-cli.test.mjs`
- Test: `tests/execution-prerequisites.test.mjs`

**Acceptance:**
- In `tests/execution-controller-cli.test.mjs`, a test calls `workflow-accept` twice for the same criterion, fail then pass and then pass then fail. Each time it asserts that the next `workflow-resume` hands the controller only the later evidence. A keep-first mutation of `retainedAcceptance` (`scripts/cli.mjs` ~3190) then fails the test.
- In `tests/execution-prerequisites.test.mjs`, tests cover a committed but invalid `--role-policy` and a committed but invalid `--environment` (valid JSON with an unknown key, and bytes that are not JSON). Each test asserts exit 2 and that nothing spawned, for:
  - `dispatch-integrator` without a mode flag;
  - `dispatch-integrator --isolated-legacy`;
  - plain `dispatch`.
- Making `validateRolePolicy` or `validateEnvironmentRecipe` non-fatal in `prepareDispatchPrerequisites` (`scripts/cli.mjs` ~7398 and ~7404) fails at least one of those tests. This shows that plain `dispatch` refuses an invalid policy and does not fall back to legacy dispatch as if no policy were given.
- No file outside the two test files changes.

- [ ] Step 1: Write the tests; confirm they pass on the current code.
- [ ] Step 2: Apply the keep-first mutation and each of the two non-fatal validation mutations in turn; observe the matching tests fail; restore.
- [ ] Step 3: Run both test files and the root suite; commit only the declared files.

### Task 4: prove native verified-complete with a real Codex run

**Files:**
- Modify: `docs/specs/2026-10-06-execution-recovery-validation.md`

**Depends:** T1, T2, T3

**Acceptance:**
- A real `workflow-execute` (or `workflow-execute` then `workflow-resume`) run over a throwaway project under `/tmp/hx` uses the Codex harness. It must have a committed `--environment` recipe and a role policy that make verification `native-required`, run the real `codex sandbox` verification, and record acceptance with `workflow-accept`. It ends in state `verified-complete` with `verifiedComplete: true` and exits 0. The exact commands, their exits, and the report fields `state`, `verification`, `verifiedComplete` and `obligations` are recorded verbatim in the validation doc. Personal paths are replaced with `/home/you`.
- If the run cannot reach exit 0, the task does not paper over it. It records the exact refusal and the step where it stopped, marks open item 8 as still unproven with that evidence, and returns `blocked` with the defect and its file:line, so the owner can plan a fix.
- The "Open items after the audit" list marks items 2, 4, 5, 6, 7 and 10 as fixed or pinned, citing the T1 to T3 commits and the test names that pin them. Item 8's status comes from the real run, and items 1, 3, 9 and 11 stay open as they are.
- Before returning, no Codex process, sandbox or fixture child this task started is still running (`pgrep -af codex` shows only processes that existed before the task).

- [ ] Step 1: Read `scripts/workflow-controller.mjs` (`native-required`, `verified-complete`), the README "Bounded workflow execution" section and T9's trial notes in the validation doc; write the recipe, the role policy and the request for a minimal bug-fix profile.
- [ ] Step 2: Run it for real; capture the commands, exits and report fields.
- [ ] Step 3: Update the validation doc from those outputs only.
- [ ] Step 4: Run `git diff --check`, `node scripts/security-lint.mjs --root . --json` and a scan for personal paths and em dashes; commit only the declared file.
