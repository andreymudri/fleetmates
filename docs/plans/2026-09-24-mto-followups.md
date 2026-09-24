# Close the open findings from the mid-tier-to-opus run

Date: 2026-09-24. These fixes land in the unreleased 2.2.0.

## Why

The mid-tier-to-opus run passed every gate but left a list of non-blocking review findings. They
are in the replay tooling, its tests, and the routing prose and its test. This run closes the
ones that still apply to the tree. The classifier-only findings are moot: that code was never
merged, and it is not in this tree.

## Global Constraints

- Node >= 24.2.0
- ESM only; two-space indent; no semicolons; match surrounding style
- Root `package.json` keeps zero runtime dependencies and zero dev dependencies
- `npm test` never opens a network connection, never starts a model session and never requires Python
- Replay tooling never modifies another repository; replay cells clone into `$TMPDIR`
- Every fix is test-first: show the defect (or the surviving mutation) before the fix and the failing test after it
- The committed data under `tools/replay/data/` stays byte-identical
- Commit messages: single-line summary, commitlint style, English, no co-author or tool attribution trailers
- `npm test` green after every task

## Destination

Every finding recorded for the mid-tier-to-opus run is either fixed and pinned by a test, or
named in Out of Scope with its reason.

## Out of Scope

- Recording integration outcomes (escalated, blocked) in `status.json` — a new feature of the run-state format, not a defect; the census already reports these as unknown rather than false.
- Findings against `tools/classifier/`, `scripts/classifier-features.mjs` and `label.mjs` — that code lives only on the archived, never-merged classifier branch.

### Task 1: replay.mjs argument, run-id and preview-link fixes

**Files:**
- Modify: `tools/replay/replay.mjs`
- Test: `tests/replay.test.mjs`

**Model:** mid

- [ ] **Step 1:** `parseArgs` refuses a value-taking flag given with no value, or followed by another `--flag`, with exit 2 naming the flag. Today a bare `--seed` parses as `true`, `Number(true)` is 1, and it is accepted. A bare `--out` falls back to `tools/replay/data/` and rewrites the committed `loss.json`. Test both.
- [ ] **Step 2:** Run-id matching must treat a hyphen as part of the id. Replace the `\b` anchors in the other-run and own-run patterns (around lines 353 and 355) with `(?<![\w-])` and `(?![\w-])`. Add a test with runs `foo` and `foo-bar`, built from the existing two-run collision fixture: run `foo`'s squash-merged T1 must not resolve to `foo-bar`'s merge. The scratchpad reproduction is `repro-hyphen.mjs`. Also add tests pinning both the `\b`-replacement anchors and the own-run guard.
- [ ] **Step 3:** A candidate merge counts as "another run's" only when that run has `.fleetmates/<run>/plan.json` under the roots. A run with no state directory is invisible, so a sole candidate from it is accepted. Recognise another run from the merge subject too: a subject naming a run id that differs from the task's run, in the `merge(<run>)` or `(<run>)` forms fleetmates writes, is rejected even when no state dir exists for it. Reproduce first; if the current code already rejects it, add the test only and say so.
- [ ] **Step 4:** Preview-link fixes:
  - A `preview.link` copy failure must record the cell as `invalid` with failReason `preview-copy`. Today it records `fail` with cost 0 and `costMissing: false`, which skews the loss. Test it.
  - The copy destination check must resolve parent directories. A nested entry under a base-tree symlink must be refused. Test it.
  - Edits a session makes under a copied link directory escape the fileset check. Make the copied link trees read-only (files and directories) before the session starts, and restore write permission before removing the clone. Test that a session writing under a copied link directory does not change it, and that clone removal still succeeds.
  - Add a test for the line `main` prints on a preview-copy failure.
- [ ] **Step 5:** `npm test` green; commit `fix(replay): refuse valueless flags, anchor run ids across hyphens, harden preview-link copies`.

### Task 2: integrator-census test gaps

**Files:**
- Modify: `tools/replay/integrator-census.mjs`
- Test: `tests/integrator-census.test.mjs`

**Model:** mid

- [ ] **Step 1:** Add a fixture merge that `git merge-tree` completes cleanly, but whose recorded tree differs because the integrator edited during a `--no-commit` merge. Assert that the census marks it `conflict: true`. Show that mutating the tree comparison (around lines 110-112) to `return true` fails the test.
- [ ] **Step 2:** The conflicting fixture merge (around test line 75) runs through a bare `spawnSync` without the fixture git identity and config isolation the `git()` helper sets. Route it through the same environment, and assert that it really stopped on a conflict (MERGE_HEAD exists, exit 1). An identity failure must not be accepted as the expected conflict. Show that `env -u EMAIL GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 node --test tests/integrator-census.test.mjs` passes.
- [ ] **Step 3:** `npm test` green; commit `test(replay): pin the census tree-diff conflict rule and isolate its conflict fixture`.

### Task 3: integrator-replay fixes and test gaps

**Files:**
- Modify: `tools/replay/integrator-replay.mjs`
- Test: `tests/integrator-replay.test.mjs`

**Model:** mid

- [ ] **Step 1:** Code fixes, each test-first:
  - The printed resume command shell-quotes every argument, so the `--models` JSON survives bash. Test that it round-trips through `bash -c`.
  - `verifyHistory` checks that each added merge's second parent equals the dispatched task tip, in the dispatched order. A reversed order with swapped messages is `not-merge` (or a new `wrong-order` reason, if the header and verdict counts are updated to match).
  - `command` checks marked `optional: true` do not fail the cell, matching the real gate (`scripts/gate-runner.mjs`, `optionalFailed`).
  - Print one progress line per finished cell to stdout: index/total, role, model, status, failReason and seconds. Nothing is printed that is not already written to the jsonl. The operator took the silent run for a hang.
  - On a `session-error`, capture the session's stderr and print the reason (first 300 characters, control characters made visible) in the preflight and per-cell lines. Stderr is never written to the jsonl.
- [ ] **Step 2:** Pin the claims no test covers today. The code is believed correct, so show each mutation surviving before and failing after:
  - resume skip keyed by model (around lines 510-511): a rerun with a different candidate model runs its cells;
  - pre-rename `.teammates/` state and `teammates/` task prefixes (around lines 68 and 95);
  - the `preview.link` copy into the clone (around line 301), with a manifest whose command check needs the linked path;
  - a deleted run branch scores `wrong-tree` (around line 269);
  - checks are chosen by the integration's phase (around line 327), with a manifest whose phases differ;
  - a candidate-only `invalid` cell is excluded from the verdict (around line 362), and so is a control-only one;
  - an unknown control mean cost never makes the candidate count as cheaper (around line 367);
  - the census's empty directory is removed afterwards (around line 459);
  - standalone `--preflight` returns 0 on a healthy fake session (around line 495).
- [ ] **Step 3:** `npm test` green; commit `fix(replay): quote the resume command, verify merge order, honour optional checks, report progress and session errors`.

### Task 4: routing prose, its test, and the integrator conflict rule

**Files:**
- Modify: `agents/tm-integrator.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Test: `tests/skill-model-map.test.mjs`

**Model:** mid

- [ ] **Step 1:** The integrator escalates every conflict. A phase gate's `merge` check already merges the same branches in a preview and fails on any conflict, so a conflict at integration means the tree changed after the gate. That is never the integrator's call, and the haiku measurement covered clean integrations only. In `agents/tm-integrator.md`, replace the "Trivial conflicts … you may resolve" rule with "Never resolve a conflict: stop and escalate with both hunks and the owning task ids", keeping the reason in one sentence. Update the `parallel-execution` sentence that says the contract lets it resolve trivial conflicts. Update any test that pins the old wording, and add one pinning the new rule (strip comments first).
- [ ] **Step 2:** Tighten `tests/skill-model-map.test.mjs`:
  - The "mid means sonnet" check flags any sentence that names both `mid` and `sonnet`, except sentences that describe restoring sonnet (containing "restore" or "--models"). A fixed verb list lets "resolves to", "dispatches to" and "uses" through.
  - The sonnet-verdict branch asserts that the cheap integrator wording is absent, mirroring the cheap branch.
  - The reviewer's fixed tier `capable` is pinned in both `skills/phase-gate/SKILL.md` and `skills/parallel-execution/SKILL.md`.
  - The verdict word quoted in the skill ("records the verdict `cheap`") equals the verdict file's value.
  - The README's integrator tier and tier-to-model table match the skill.

  Show each mutation from the phase-3 review surviving before and failing after.
- [ ] **Step 3:** Add a "Fixed" subsection to the `v2.2.0` section of `CHANGELOG.md`. Cover the replay tooling fixes from Tasks 1-3 in one or two bullets, and the integrator conflict rule in one bullet under "Changed".
- [ ] **Step 4:** `npm test` green; commit `fix(routing): escalate every integration conflict and pin the routing prose`.
