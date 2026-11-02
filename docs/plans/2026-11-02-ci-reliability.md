# CI reliability implementation plan

Spec: `docs/specs/2026-11-02-ci-reliability-design.md`.

## Global Constraints

- Node >= 20, ESM `.mjs`, `node:test` + `node:assert/strict`
- Zero new runtime or dev dependencies at the repo root
- Commit messages: single line, commitlint style, English, no tool attribution of any kind
- No personal names, emails or real home paths in code, docs, fixtures or test output
- Every new test must be shown to fail under a mutation of the code it covers, then pass (CONTRIBUTING.md)
- Anything a manifest, report, workflow file or teammate authored that reaches a terminal goes through `printable` from `scripts/reviews.mjs`
- Commands are spawned with an argv array, never `shell: true` with interpolated paths
- Run long test commands in the foreground with an explicit timeout of at least 600000 ms
- Each teammate runs its tests with a private `TMPDIR` under its own worktree
- Nothing in this plan edits a user's GitHub workflow; only Task 8 edits this repository's own
- No task edits `fleetmates.gate.json`; turning `platformSim` and `flaky` on for this repository's gate is a separate owner-visible commit after the run

## Destination

A fleet run catches the common macOS and Windows failure classes on a Linux machine, tells a
timing flake apart from a real failure without hiding either, and is not offered for merge while
the project's remote CI is red or pending.

## Out of Scope

- Generating or editing a user's GitHub workflows — a workflow is the user's release machinery; `doctor` only suggests.
- Emulating Windows signals, ACLs, hidden attributes or mandatory locks on Linux — no environment variable reproduces them; the portability lens covers them.
- Retrying a failing test more than once — a test that needs two retries is broken, not flaky.

### Task 1: platform simulator module

**Files:**
- Create: `scripts/platform-sim.mjs`
- Test: `tests/platform-sim.test.mjs`
- Create: `tests/fixtures/platform-sim/realpath-probe.mjs`
- Create: `tests/fixtures/platform-sim/eol-probe.mjs`

- [ ] **Step 1:** Write the two fixtures. `realpath-probe.mjs` exits 1 when `realpathSync(os.tmpdir()) !== os.tmpdir()` (the class behind the ledger failure). `eol-probe.mjs` creates a git repo in `os.tmpdir()`, commits a file containing `a\n` through the simulated global config, checks it out into a second worktree and exits 1 when the checked-out bytes are not `a\n` (the class behind the rescue CRLF failure).
- [ ] **Step 2:** Write `tests/platform-sim.test.mjs` first: each probe exits 0 when spawned plainly and non-zero under `runPlatformSim`; `buildSimEnv` returns `TMPDIR`, `TMP` and `TEMP` equal to one path that is a symlink and contains a space; `GIT_CONFIG_GLOBAL` names a file containing `autocrlf = true` and an `[include] path =` line naming the user's previous global config when one existed; the scratch directory is gone after the run, including after the command fails and after it throws on spawn; the exit code is the command's own; on `win32` (injected `platform`) the symlink condition is reported as skipped. Run it and watch it fail.
- [ ] **Step 3:** Create `scripts/platform-sim.mjs` exporting:

```js
export const SIM_CONDITIONS = ['symlinked-tmpdir', 'space-in-tmpdir', 'autocrlf', 'umask-077']
// Returns { env, applied: string[], skipped: { name, reason }[], cleanup: () => Promise<void> }
export async function buildSimEnv({ baseEnv = process.env, platform = process.platform, homedir = os.homedir() } = {})
// Spawns argv[0] with argv.slice(1) (no shell) under buildSimEnv, streams output through onOutput,
// and always runs cleanup. Returns { code, applied, skipped }.
export async function runPlatformSim(argv, { cwd, onOutput = (chunk) => process.stdout.write(chunk), platform, baseEnv } = {})
```

  The real temp dir is created with `mkdtemp` under the real `os.tmpdir()`, then `real dir/target` and a symlink `real dir/sim link` pointing at it; `TMPDIR` is the link path. `umask 077` is applied by setting `process.umask` only for the child via a tiny `node -e` trampoline that calls `process.umask(0o077)` then `execFileSync`s the argv with `stdio: 'inherit'`, so the parent's umask never changes.
- [ ] **Step 4:** Run the test file, then mutate: drop the symlink (point `TMPDIR` at the real dir) and watch the realpath probe test fail; drop `autocrlf` and watch the EOL probe test fail. Restore.

### Task 2: flaky detector module

**Files:**
- Create: `scripts/flaky.mjs`
- Test: `tests/flaky.test.mjs`
- Create: `tests/fixtures/flaky/fails-n-times.mjs`

- [ ] **Step 1:** Write `fails-n-times.mjs`: reads a counter file named by `FLAKY_COUNTER`, increments it, exits 1 while the count is at most `FLAKY_FAILS`, else 0; when `FLAKY_REPORT` is set it also writes a JUnit file with one `<testcase name="t1">` that carries a `<failure>` on failing runs.
- [ ] **Step 2:** Write `tests/flaky.test.mjs` first: fails 0 times -> exit 0, no retry, quarantine untouched; fails once -> exit 0, one `flaky` entry naming `t1` (from the report) or the whole command (without one), quarantine file written with `{ v: 1, tests: { "<id>": { firstSeen, lastSeen, flakes: 1, passStreak: 0 } } }`; fails twice -> the original exit code and no quarantine change; a test already quarantined that fails twice -> exit 0 with a `quarantined` warning; without a report, a recorded whole-command entry never excuses a second failure (fails twice -> the original exit code even when that entry exists); a retry that exits non-zero while its report names no failed test -> the original exit code; the report file is removed before each attempt so a stale report cannot pick the retried tests; every name read from a report or argv that reaches stdout, a `::warning` line or the step summary carries no raw control byte (a test name containing ESC, CR and newline); a quarantined test that passes -> `passStreak` + 1 and `flakes` unchanged; a malformed quarantine file -> throws `FlakyConfigError` naming the file and no command runs; `GITHUB_ACTIONS=true` -> a `::warning title=flaky::` line per flaky test and a markdown table appended to the file named by `GITHUB_STEP_SUMMARY`; `retryArgv` returns `--test-name-pattern` for node:test, `-t` for vitest and jest, `--deselect`-free `-k` for pytest, and `null` for an unknown runner; `canWrite: false` (teammate worktree) reports but never writes the quarantine file. Run it and watch it fail.
- [ ] **Step 3:** Create `scripts/flaky.mjs` exporting:

```js
export const QUARANTINE_FILE = 'fleetmates.flaky.json'
export const RELEASE_STREAK = 20
export class FlakyConfigError extends Error {}
export async function readQuarantine(root)           // { v: 1, tests: {} } when absent; throws FlakyConfigError when malformed
export function retryArgv(argv, failedNames)          // argv for a filtered rerun, or null
// Returns { code, flaky: string[], quarantinedFailures: string[], retried: 'none'|'filtered'|'whole' }
export async function runFlaky(argv, { root, cwd, report = null, exec, canWrite = true, env = process.env, now = Date.now } = {})
```

  The report is read with `readReport` from `scripts/test-report.mjs`; an unreadable report falls back to a whole-command retry. Quarantine writes are atomic (temp file plus rename).
- [ ] **Step 4:** Run the tests, then mutate: make a second failure return 0 and watch the "fails twice" test fail; skip the quarantine write and watch the "fails once" test fail. Restore.

### Task 3: CI workflow reader

**Files:**
- Create: `scripts/ci-workflows.mjs`
- Test: `tests/ci-workflows.test.mjs`

- [ ] **Step 1:** Write the test first with inline YAML strings: a matrix `os: [ubuntu-latest, windows-latest, macos-latest]` -> `oses` is `['linux', 'windows', 'macos']`; `runs-on: macos-14` -> `macos`; `on: { push: { branches: [master] }, pull_request: {} }` -> `branchPushes: false`; `on: push` with no branch filter, or `branches: ['**']` -> `true`; a step whose `run` contains `cli.mjs flaky` or `fleetmates flaky` -> `usesFlaky: true`; `ciAdvice` returns the three warnings of the spec (branch pushes, single OS when `package.json` has no `os` field restricting it, no flaky step) and nothing for a workflow set that satisfies all three; no `.github/workflows` directory -> `{ present: false }` and no advice; a file over 256 KiB is skipped and reported, not parsed.
- [ ] **Step 2:** Create `scripts/ci-workflows.mjs` exporting:

```js
// A line-oriented reader for the few keys this needs. Not a YAML parser: it reads `on:`,
// `runs-on:`, `os:` lists and `run:` lines, and reports what it could not read rather than guessing.
export async function readWorkflows(root)   // { present, files: [{ path, oses, branchPushes, usesFlaky }], skipped: [{ path, reason }] }
export function workflowSummary(read)       // { present, oses: Set<'linux'|'macos'|'windows'>, branchPushes, usesFlaky }
export function ciAdvice(summary, pkg)       // string[] of warnings, each one line
```

- [ ] **Step 3:** Run the tests, mutate the `branches: ['**']` case to read as default-branch-only and watch it fail. Restore.

### Task 4: portability review lens

**Files:**
- Modify: `scripts/review-gen.mjs`
- Test: `tests/review-gen.test.mjs`

- [ ] **Step 1:** Add tests first: `methodFor(LENS_METHODS, 'portability')` returns a prompt that names each checklist item of the spec (realpath and symlinked ancestors, 8.3 short names, path separators and length, line endings, hidden and read-only files, socket paths, signals and process groups, `shell: true` quoting, fixed sleeps and polling windows); it tells the reviewer to cite file:line and to rate a hazard on a platform the project's CI runs as `high`; a generated dispatch for lens `portability` carries that prompt. Run and watch them fail.
- [ ] **Step 2:** Add a `portability` entry to `LENS_METHODS` returning that prompt as a joined array of lines, in the style of the `ui` entry. It takes no data arguments.
- [ ] **Step 3:** Run, mutate (drop the 8.3 line) and watch the checklist test fail. Restore.

### Task 5: gate wiring

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Modify: `scripts/gate-config.mjs`
- Test: `tests/gate-ci-reliability.test.mjs`

**Depends:** T1, T2, T3

- [ ] **Step 1:** Write `tests/gate-ci-reliability.test.mjs` first: a `command` check with `"platformSim": true` running the realpath probe fails, and the same check without the flag passes; a check with `"flaky": true` running `fails-n-times.mjs` with one failure passes and its result carries `flaky: ['<id>']`, and with two failures fails; `platformSim` and `flaky` together compose (the retry also runs under the simulator); a non-boolean `platformSim` or `flaky` is refused by manifest validation with the check name; `protectedPaths({})` includes `fleetmates.flaky.json`; `reviewLenses(config, phaseName, summary)` adds `portability` when `summary.oses` has `macos` or `windows`, does not add it for Linux only, keeps it when the manifest lists it, and never duplicates it. Run and watch them fail.
- [ ] **Step 2:** In `gate-config.mjs`: add `fleetmates.flaky.json` to the fixed protected set in `protectedPaths`; export `reviewLenses(config, phaseName, summary)` returning the review check's lenses plus `portability` per the rule above.
- [ ] **Step 3:** In `gate-runner.mjs` `runCommandCheck`: validate the two flags; when either is set, run the check's command through `runFlaky` and/or `runPlatformSim` instead of the plain `exec`, keeping the existing timeout, log, claim and report handling; attach `flaky` and `quarantinedFailures` to the result and include them in its printed output. The quarantine is written only when `previewDir` is null and `cwd` is the main worktree.
- [ ] **Step 4:** Run, mutate (ignore the `platformSim` flag) and watch the probe test fail. Restore.

### Task 6: CLI commands and finish CI wait

**Files:**
- Modify: `scripts/cli.mjs`
- Modify: `scripts/config.mjs`
- Test: `tests/ci-reliability-cli.test.mjs`

**Depends:** T1, T2, T3, T4, T5

- [ ] **Step 1:** Write `tests/ci-reliability-cli.test.mjs` first: `platform-sim -- node <probe>` exits non-zero and prints one `platform-sim: applied ...` line; `flaky --report <file> -- node fails-n-times.mjs` exits 0 on one failure and prints `flaky: fixture::t1` (test ids are `<file>::<classname>::<name>` with fallbacks, as built in Task 2); `flaky` exits 2 on a malformed quarantine file; `review-dispatch` on a repo whose fixture workflow has a Windows matrix emits a `portability` reviewer and on a Linux-only one does not; `doctor` prints each `ciAdvice` warning under a `CI:` heading and prints nothing CI-related when there is no `.github/workflows`; `ci-wait --branch <b> --root <r>` with an injected `gh` returning all checks passed exits 0, one failed exits 1 printing the job URL, still pending past `--minutes` exits 3, `gh` missing exits 4 naming it, and no workflows exits 0 printing `no CI workflows: skipped`; `config set ci.push auto` and `ci.waitMinutes 30` are accepted and `ci.push yes` is refused. Run and watch them fail.
- [ ] **Step 2:** In `config.mjs`, add a validated `ci` block: `push` is `ask` (default) or `auto`; `waitMinutes` is an integer 1 to 720 (default 60). Add both keys to `CONFIG_KEYS` in `cli.mjs`.
- [ ] **Step 3:** In `cli.mjs`, add the `platform-sim`, `flaky` and `ci-wait` subcommands (argv after `--`), route `review-dispatch` lenses through `reviewLenses` with `workflowSummary(await readWorkflows(root))`, and append `ciAdvice` to `doctor`. `ci-wait` resolves the branch tip, polls `gh api repos/{owner}/{repo}/commits/<sha>/check-runs` every 30 s through an injectable exec, and judges it with `summarizeCi` from `scripts/ci-evidence.mjs`, treating every check run on the tip as required. It never pushes.
- [ ] **Step 4:** Run, mutate (make `ci-wait` treat `pending` as pass) and watch the pending test fail. Restore.

### Task 7: skills, docs and changelog

**Files:**
- Modify: `skills/finishing-a-development-branch/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Modify: `skills/fleetmates-config/SKILL.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Test: `tests/skill-finishing-branch.test.mjs`

**Depends:** T6

- [ ] **Step 1:** Add a test first that `finishing-a-development-branch` has a `## Remote CI` section, placed before `## Integration options`, that names `ci-wait`, says the push is asked for unless `ci.push` is `auto`, and says a red, pending or unreadable CI means the merge is not offered. Run and watch it fail.
- [ ] **Step 2:** Write that section. In `phase-gate`, document `platformSim`, `flaky`, the quarantine file and its protection, and the automatic `portability` lens. In `fleetmates-config`, document `ci.push` and `ci.waitMinutes`. In `README.md`, add a short "CI reliability" section with the GitHub Actions step `node <fleetmates root>/scripts/cli.mjs flaky --report <path> -- <test command>`. Add an `## Unreleased` `### Added` entry to `CHANGELOG.md`.
- [ ] **Step 3:** Run the full root suite (the skill contract tests check every subcommand a skill names).

### Task 8: dogfood in this repository

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/deck.yml`
- Modify: `package.json`

**Depends:** T6

- [ ] **Step 1:** In `test.yml` and `deck.yml`, run on `push` to every branch (keep `pull_request`), and run the suites through `node scripts/cli.mjs flaky -- npm test` (root) and `node scripts/cli.mjs flaky -- npm --prefix hub test` (hub).
- [ ] **Step 2:** Add `"test:platform-sim": "node scripts/cli.mjs platform-sim -- npm test"` to `package.json` scripts.
- [ ] **Step 3:** Run `npm run test:platform-sim` with the timeout above and report the counts. A failure here is a real portability bug: report it with the test name rather than weakening anything.
