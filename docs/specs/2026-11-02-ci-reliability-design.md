# CI reliability: catch platform and timing failures before the remote CI does

Status: approved 2026-11-02. Target release: 2.7.0.

## Problem

Of the last 14 failed CI runs on this repository, 13 failed only on macOS or Windows. About half
were platform hazards that a Linux machine never exercises: a temp directory reached through a
symlink (`/var` to `/private/var`), Windows 8.3 short names (`RUNNER~1`), CRLF conversion by
`core.autocrlf`, writing over a hidden `.git` file, socket path length. The other half were
timing flakes: watchers, polling windows, process exit tails. Every one of them surfaced only
after a push, and each cost a full CI round trip to discover.

The same holds for any project a fleet works on. The feature is for fleetmates users, not only
for this repository.

## Success criteria

- Two of the three real failures fixed on 2026-11-02 (the ledger refusing a symlinked ancestor,
  CRLF in the rescue patch test) each go red under the platform simulator on Linux when their fix
  is reverted. The third, EPERM writing a hidden `.git` file, is a Windows file attribute no
  environment variable reproduces; it is in the portability lens checklist instead.
- A test that fails once and passes on its retry no longer turns a check red, and is never
  silent: it is reported and recorded in a tracked quarantine list.
- A fleet run is not offered for merge while the project's remote CI is red or pending on the
  run branch, unless the project has no CI, in which case the finish says so.

## Decisions

| Decision | Choice |
|---|---|
| Simulator delivery | A CLI wrapper plus a per-check manifest flag |
| Simulator in the gate | Replaces the normal run of that check, it does not add one |
| Remote CI | `doctor` warns about weak CI triggers, and the finish waits for remote CI |
| Push authorization | The finish asks before each push; `ci.push: auto` skips the question |
| Portability lens | On automatically when the CI matrix includes macOS or Windows; can be forced |
| Flaky rerun scope | Only the failed tests when the check declares a `report`, else the whole command |
| Flaky verdict | Pass on retry is green with a warning |
| Quarantine store | Tracked `fleetmates.flaky.json`, protected like the gate manifest |
| Flaky in user CI | The same command works in a GitHub Actions step |
| Quarantined test failing again | Still runs; a failure is a warning, not a red check |

## Components

### 1. Platform simulator: `platform-sim`

    node "<fleetmates root>/scripts/cli.mjs" platform-sim --root <project root> -- <command...>

Runs the command with:

- `TMPDIR`, `TMP` and `TEMP` pointing at a directory reached through a symlink, whose path
  contains a space.
- `GIT_CONFIG_GLOBAL` pointing at a generated file with `core.autocrlf=true`, layered over the
  user's own global config through an `[include]` of it, so identity and signing settings keep
  working.
- `umask 077` on POSIX.

It prints one line naming the conditions it applied, then the command's own output, and exits
with the command's exit code. The scratch directory is removed afterwards, including on failure.
On Windows it applies only the conditions that make sense there (autocrlf) and says which it
skipped.

In `fleetmates.gate.json`, a `command` check may set `"platformSim": true`. The gate then runs
that check through the simulator instead of running it plainly. Gate time is unchanged. A
failure that happens only on a plain Linux run still reaches the remote CI.

### 2. Flaky detector: `flaky`

    node "<fleetmates root>/scripts/cli.mjs" flaky --root <project root> [--report <path>] -- <command...>

1. Runs the command.
2. On a non-zero exit, retries exactly once. With `--report` (the same JUnit or TAP report the
   gate already reads for the test inventory), it retries only the failed tests when the runner
   is one it knows how to filter (node:test, vitest, jest, pytest); otherwise it reruns the
   whole command.
3. A pass on the retry exits 0, prints a `flaky:` line per test, and adds or updates the test in
   `fleetmates.flaky.json` with the date and a count. A second failure exits with the original
   code.
4. A test already in quarantine that fails is reported as a warning and does not fail the check.
   Only named tests from a report are ever quarantined. Without a report, a pass on the retry is
   reported as a flake of the whole command and recorded for visibility, but the whole command is
   never treated as quarantined: if it fails twice, the check is red, every time. Likewise, a
   retry that exits non-zero while its report names no failed test is red, because the failure is
   outside any test (a crash, an unhandled rejection, a coverage threshold).
   A run is excused only when every test that failed on the first attempt either passed on the
   retry or is quarantined, and every test still failing is quarantined. Tests are identified by
   their file (or JUnit classname) plus name, so a quarantined test never excuses a same-named
   test elsewhere. Known limit: a failure outside any test that happens in the same run as a
   quarantined test failing twice cannot be told apart with a single retry; every excused run
   therefore prints a line saying the exit code was overridden and why.
   A quarantined test that passes increments a pass streak. After 20 passes in a row, `doctor`
   suggests removing it.

`fleetmates.flaky.json` is added to the protected set, so a teammate cannot quarantine its own
failing test: the change fails `fileset` unless the plan marks the file `(protected)`. The CLI
writes it only from the main worktree or from CI, never from a teammate worktree.

When `GITHUB_ACTIONS=true`, it also prints `::warning` annotations and appends a short table to
`GITHUB_STEP_SUMMARY`. A gate `command` check may set `"flaky": true` to run through it.

### 3. Portability review lens

A new `portability` lens for `tm-reviewer`. `review-dispatch` adds it to a phase's review when
any workflow under `.github/workflows` has a matrix or `runs-on` naming macOS or Windows, or when
the manifest lists it explicitly. The prompt is a checklist: realpath and symlinked ancestors,
8.3 names, path separators and length, EOL, hidden and read-only files, socket paths, signals and
process groups, `shell: true` quoting, fixed sleeps and polling windows. Findings use the usual
severities and `blockOn`.

### 4. Remote CI before the merge

`doctor` reads `.github/workflows` and warns when:

- the test workflows run only on `pull_request` and the default branch, so a run branch push
  gets no CI;
- the matrix covers a single OS while `package.json` has no `os` field restricting it to that OS;
- no step uses the flaky detector.

It only suggests; it never edits a workflow.

`finishing-a-development-branch` gains a step before the integration options. When the project
has GitHub Actions workflows, it asks before pushing the run branch (`ci.push: auto` in config
skips the question), then polls the GitHub Actions workflow runs for the branch tip until all pass, one fails,
or `ci.waitMinutes` (default 60) passes. It judges workflow runs, not individual check runs:
every workflow run on the tip commit must be completed with conclusion `success` or `skipped` (a run whose every job was skipped by `if:` failed nothing; `neutral`, a missing conclusion and every other value fail) (a re-run is the
same run id with a newer attempt, so the latest attempt counts), a run still queued or in
progress is pending, and a tip with no workflow run yet is pending. Judging whole runs keeps the
push and pull request runs of one workflow apart, waits for jobs behind `needs:`, and does not
count a job skipped by `if:` as a failure. Whether the project has workflows is read from the
tip commit's tree, not the working tree. A failure or timeout is reported with the job links and
the merge is not offered. With no workflows, the step is skipped and the finish says so.

### 5. Local CI mirror: `ci-local`

Added 2026-11-02 after the first push of this feature spent a full CI round on failures a Linux
machine could have shown: the hostile-TMPDIR sweep runs on Linux and was not run before the push.

    node "<fleetmates root>/scripts/cli.mjs" ci-local --root <project root> [--dry-run]

It reads the workflows that run on a branch push or a pull request (a tag-only workflow is a
release, not CI, and is left out), takes each job whose `runs-on`, or `matrix.os` list, names this
operating system, and runs the job's `run:` steps in order: the step's shell (bash on Linux and
macOS and pwsh on Windows by default, as on a hosted runner), `env` from the workflow, the job and
the step, `working-directory`, and `GITHUB_ENV` and `GITHUB_PATH` carried to the next step. It
stops at the first failing step with exit 1. It skips and names what it cannot reproduce: `uses:`
actions, expressions other than `matrix.os`, `runner.os` and `runner.temp`, `if:` conditions other
than a `runner.os` comparison, other shells, and jobs for other operating systems. Exit 3 when
nothing runs here. Steps run in the user's own environment, with no variable added beyond what a
runner provides, so a test that points git at a fake `HOME` still works. A global git config file
a step changes (a `git config --global` CI identity) is restored after that step, and named. A
first version pointed `GIT_CONFIG_GLOBAL` at a scratch file instead, and that broke a hub test
whose fixture configures git through a fake `HOME`. The finish runs it before
any push and does not push on exit 1.

## Error handling

- The simulator cannot create its symlink (Windows without the privilege): it skips that
  condition, says so, and still runs the command.
- The flaky detector cannot parse the report: it falls back to rerunning the whole command.
- `fleetmates.flaky.json` is malformed: the detector refuses with exit 2 naming the file, the
  same way a malformed gate manifest is refused.
- `gh` is missing or not authenticated when the finish waits for CI: it reports that remote CI
  could not be read and does not offer the merge as verified.

## Testing

Every new test is mutation-checked, as `CONTRIBUTING.md` requires. The simulator is proved
against the two reproducible failures above: each is reintroduced in a fixture, fails under
`platform-sim` on Linux, and passes plainly. The flaky detector is tested with a fake runner that
fails a set number of times. The lens trigger is tested against fixture workflow files. The
finish step is tested with an injected `gh` and fake check-run snapshots.

## Out of scope

- Generating or editing the user's GitHub workflows. `doctor` only suggests, because a workflow
  is the user's release machinery.
- Emulating Windows signals, ACLs or mandatory file locks on Linux. These stay with the
  portability lens and the remote CI, because no environment variable reproduces them.
- Retrying more than once. A test that needs two retries is broken, not flaky.
