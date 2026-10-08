# Release platform: strict execution is POSIX-only, and the legacy paths hold on Windows

## Destination

Before fleetmates 2.4.0 is released, the root suite passes on the CI matrix (ubuntu, macOS, Windows). Strict execution (the execution journal, retained artifacts, the strict driver, reviewed integration, the workflow controller and native verification) refuses explicitly on Windows with one stated reason, instead of failing deep inside with unrelated messages, and its tests skip there for that same reason. The legacy paths that worked on Windows in 2.3.1 work there again.

Measured on PR #49 at f4b3a29a: Windows had 367 failures. 362 are in the strict family (execution-journal 96, execution-recovery 57, driver-recovery 57, reviewed-integration 55, workflow-controller 41, execution-artifacts 36, execution-controller-cli 15, execution-prerequisites 5). 5 are legacy (harness-codex 3, harness-cursor 1, git 1). Ubuntu and macOS fixes already landed on `release/2.4.0` (git-lfs filter, canonical run paths, socket path length).

## Global Constraints

- Node >= 24.2.0; zero new runtime or development dependencies (root package); `hub/` is not changed.
- Commit messages: single-line conventional English; configured git author only; never run `git config` (a linked worktree writes the shared `.git/config`).
- No personal identities, credentials or actual home paths in code, docs, fixtures or test output; use `/home/you` placeholders.
- Do not modify `fleetmates.gate.json`, any file in `docs/plans/`, or anything under `.fleetmates/` by hand.
- Task changes stay in their declared file sets.
- Every new test must be seen failing under a targeted mutation of the code it covers, then restored; run affected and complete suites after.
- Use a private short `TMPDIR` under `/tmp/hx` (for example `/tmp/hx/p1`); kill every process a task starts.
- No real model sessions (Claude, Codex, Cursor) in this run.
- No Windows machine is available to teammates. Windows behaviour is reasoned from the CI log failures quoted in each task and from Node's documented `fs.constants` (on win32 `O_NOFOLLOW` and `O_NONBLOCK` are undefined). The orchestrator validates on the PR #49 Windows leg after integration.
- Docs in English, plain prose, no em dash character.

## Out of Scope

- Real Windows support for strict execution (no-follow reads, private ACLs, lock semantics) - the owner chose an explicit refusal for 2.4.0 on 2026-10-08.
- The hub (deck) suite - it is green on ubuntu and macOS, and its one ubuntu failure on f4b3a29a was a Playwright timeout that passes on rerun.
- Releasing, tagging or publishing - owner steps after PR #49 is green.

### Task 1: one platform gate for strict execution, refused by the CLI on Windows

**Files:**
- Create: `scripts/execution-platform.mjs`
- Create: `tests/strict-platform.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Test: `tests/execution-platform.test.mjs`

**Model:** capable

**Acceptance:**
- `scripts/execution-platform.mjs` exports `strictExecutionSupport({ platform = process.platform, constants = fs.constants } = {})`, returning `{ supported: true, reason: null }` or `{ supported: false, reason }`. It is unsupported when `platform === 'win32'` or when `constants.O_NOFOLLOW` or `constants.O_NONBLOCK` is not a number. The reason is one fixed sentence: `strict execution needs POSIX no-follow, nonblocking reads and private file modes; it is not supported on Windows`.
- `scripts/cli.mjs` checks it once, before any other work, for `workflow-execute`, `workflow-resume`, `workflow-status`, `workflow-resolve`, `workflow-accept`, `workflow-prune`, `execution-record`, `execution-status`, and `dispatch` with `--execution`. When unsupported it prints the reason as one line (JSON `{ "error": <reason> }` where the command already prints JSON errors, otherwise plain) and exits 2. Every other command, and `dispatch` without `--execution`, is unchanged.
- `tests/strict-platform.mjs` is a test helper for the strict suites: it exports `strictTest`, which is `test` from `node:test` when `strictExecutionSupport().supported`, and otherwise `test.skip` wrapped so the skip message is the reason. It also honours `FLEETMATES_TEST_STRICT_UNSUPPORTED=1`, test-only, so a POSIX machine can see the skip path. It has no other behaviour.
- `tests/execution-platform.test.mjs` covers: supported on linux and darwin with numeric flags; unsupported on win32 even with numeric flags; unsupported when either flag is undefined; the exact reason string; `strictTest` skipping under `FLEETMATES_TEST_STRICT_UNSUPPORTED=1` (run a child `node --test` on a one-test file under the scratch TMPDIR and read its TAP `# skip` count); and, on a POSIX host, that `workflow-status` and `execution-status` do not print the reason (they fail for other reasons in an empty repo, which is fine). A test guarded `{ skip: process.platform !== 'win32' }` asserts that on Windows each listed command exits 2 with the reason.
- `CHANGELOG.md` v2.4.0: one Known issues bullet stating strict execution and native verification are POSIX-only and refuse on Windows with exit 2, legacy dispatch is unaffected. Under Fixed, one bullet for the landed `release/2.4.0` fix that canonicalizes the strict driver run directory and the isolated integrator session directory under linked paths such as the macOS `/var` link. Under Changed, one bullet saying the quiet test reporter names each failure's file and line. The git-lfs line under Added stays as it is.
- `README.md` `### Platforms`: one short paragraph with the same POSIX-only statement and the exit code.
- Mutations each fail a test, then are restored: dropping the win32 clause, dropping the `O_NONBLOCK` clause, and removing the CLI check for `workflow-status`.

- [ ] Step 1: Write `tests/execution-platform.test.mjs`; observe it fail (module missing).
- [ ] Step 2: Implement `scripts/execution-platform.mjs`, `tests/strict-platform.mjs` and the CLI check.
- [ ] Step 3: Apply the three mutations; observe the failures; restore.
- [ ] Step 4: Update CHANGELOG and README; run the test file and the root suite; commit only the declared files.

### Task 2: harness result reads refuse links on Windows; native verification tests skip there

**Files:**
- Modify: `scripts/harnesses/codex.mjs`
- Modify: `scripts/harnesses/cursor.mjs`
- Test: `tests/harness-codex.test.mjs`
- Test: `tests/harness-cursor.test.mjs`

**Model:** capable

**Acceptance:**
- Windows CI failures to fix (f4b3a29a): `readResult refuses a result file larger than its bound rather than parsing it` (`tests/harness-codex.test.mjs:1312`) and `readResult refuses a stream file larger than its bound rather than parsing it` (`tests/harness-cursor.test.mjs:643`). Both returned the parsed result where `null` was expected: the symlink case at the end of each test. On win32 `O_NOFOLLOW` is undefined, so `readResult` (`scripts/harnesses/codex.mjs:318`, `scripts/harnesses/cursor.mjs:289`) follows a link.
- Both `readResult` functions refuse (return `null`) a path that is a symbolic link on every platform. Where `O_NOFOLLOW` is missing they reuse the existing Windows-aware pattern of `openReportFile` in `scripts/test-report.mjs:254`: `lstat` first, refuse a link or non-regular file, open, then match the opened handle's `dev` and `ino` to the `lstat` result. Import that helper if its contract fits; otherwise implement the same check locally. The size bounds are unchanged.
- A new test in each file forces the no-`O_NOFOLLOW` branch on POSIX through a parameter or seam that production code does not use (for example an injected `noFollow: 0`, as `openReportFile` takes), and asserts a link is refused and a regular file within bound is read.
- Native verification is POSIX-only (`buildVerificationInvocation` uses `/usr/bin/env` and `/tmp`, `scripts/harnesses/codex.mjs` ~526). These Windows failures are skipped on win32 with `{ skip: process.platform === 'win32' && '<reason>' }`, the reason saying native verification is POSIX-only: `verification broker construction uses host configuration, structured argv and a filtered environment` (`tests/harness-codex.test.mjs:800`) and every case of `injected restriction fixture rejects ...` (`tests/harness-codex.test.mjs:989`, it failed with `ENOENT ... D:\tmp\fm-denied-...`). No other test changes.
- Mutations each fail a test, then are restored: removing the link refusal from the fallback branch in each harness.

- [ ] Step 1: Write the forced-fallback tests; observe them fail.
- [ ] Step 2: Implement the fallback in both harnesses; add the two win32 skips.
- [ ] Step 3: Apply the mutations; observe the failures; restore.
- [ ] Step 4: Run both test files and the root suite; commit only the declared files.

### Task 3: the multi-byte git stderr test fits the Windows command line

**Files:**
- Test: `tests/git.test.mjs`

**Model:** cheap

**Acceptance:**
- Windows CI failure (f4b3a29a): `defaultGitExec keeps multi-byte characters intact across stderr chunk boundaries` (`tests/git.test.mjs:1723`) failed with `spawn ENAMETOOLONG`. The argument is `'€'.repeat(40_000)` plus a pad, over the Windows command line limit of 32767 characters.
- On win32 the test uses a repeat count that keeps the whole command line under that limit (for example 10_000), and keeps 40_000 elsewhere. The trace output must still exceed one pipe read so a chunk boundary falls inside a code point: keep the three pads.
- The test still fails on POSIX when the decoder is per-chunk: mutate `defaultGitExec` in `scripts/git.mjs` to decode each chunk separately, observe the failure, restore. `scripts/git.mjs` is not committed.

- [ ] Step 1: Make the count platform-dependent.
- [ ] Step 2: Run the mutation; observe the failure; restore.
- [ ] Step 3: Run `tests/git.test.mjs` and the root suite; commit only the declared file.

### Task 4: journal, artifact, recovery and driver-recovery suites skip on Windows

**Files:**
- Test: `tests/execution-journal.test.mjs`
- Test: `tests/execution-artifacts.test.mjs`
- Test: `tests/execution-recovery.test.mjs`
- Test: `tests/driver-recovery.test.mjs`

**Depends:** T1

**Model:** cheap

**Acceptance:**
- Each file declares its tests through `strictTest` from `tests/strict-platform.mjs`, for example `import { strictTest as test } from './strict-platform.mjs'` in place of the `node:test` import of `test`. Tests that already carry their own `skip` option keep it. Nothing else in these files changes.
- Windows CI on f4b3a29a failed 96, 36, 57 and 57 tests in these files, with `No-follow nonblocking artifact reads are unsupported`, `Unsafe execution directory` and `persisted barrier was not reached`; on Windows every one of them is skipped with the T1 reason.
- With `FLEETMATES_TEST_STRICT_UNSUPPORTED=1`, running these four files reports 0 failures and every test skipped (state the counts). Without it, the counts of passing tests equal those before the change (state both).

- [ ] Step 1: Switch the four files to `strictTest`.
- [ ] Step 2: Run them with and without `FLEETMATES_TEST_STRICT_UNSUPPORTED=1`; compare counts.
- [ ] Step 3: Run the root suite; commit only the declared files.

### Task 5: integration, controller and prerequisite suites hold on Windows

**Files:**
- Test: `tests/reviewed-integration.test.mjs`
- Test: `tests/workflow-controller.test.mjs`
- Test: `tests/execution-controller-cli.test.mjs`
- Test: `tests/execution-prerequisites.test.mjs`

**Depends:** T1

**Model:** mid

**Acceptance:**
- `tests/reviewed-integration.test.mjs`, `tests/workflow-controller.test.mjs` and `tests/execution-controller-cli.test.mjs` declare their tests through `strictTest`, as in Task 4 (Windows failures 55, 41 and 15). Tests that already carry their own `skip` option keep it.
- `tests/execution-prerequisites.test.mjs` is mostly cross-platform (128 of 133 passed on Windows) and is not switched wholesale. Its five Windows failures are handled one by one:
  - `linked setup reaches layout assertions under apostrophe TMPDIR` (~704) failed with `spawn /usr/bin/env ENOENT`: a POSIX-only fixture; skip on win32 with that reason.
  - `required message refuses unavailable native verifier without retaining an old ready receipt` and `... missing native verifier ...` (~786) failed with exit 4 where 0 was expected in setup: they need native verification; skip on win32 through `strictTest` or an equivalent `skip` with the T1 reason.
  - `integrator dispatch from detached main supplies isolated exact assignment with configured effort ...` and `... inherited effort ...` (~851): `--isolated-legacy` is a legacy path, so these must pass on Windows. The fixture's assertion `worktrees.includes(\`worktree ${options.sandbox.cwd}\n...\`)` compares `git worktree list --porcelain` output, which on Windows prints forward slashes (`C:/Users/...`), with a native path (`C:\Users\...`). Compare normalized paths (separators, and realpath of both sides) instead of raw strings. The comparison must still reject a different worktree path: mutate the fixture's expected path to a sibling directory, observe the failure, restore.
- With `FLEETMATES_TEST_STRICT_UNSUPPORTED=1` the three switched files report 0 failures and every test skipped, and `tests/execution-prerequisites.test.mjs` reports 0 failures with exactly the native-verification tests skipped (state the counts). Without it, passing counts equal those before the change.

- [ ] Step 1: Switch the three files to `strictTest`.
- [ ] Step 2: Handle the five prerequisite tests as listed; run the path mutation.
- [ ] Step 3: Run the four files with and without the variable; run the root suite; commit only the declared files.
