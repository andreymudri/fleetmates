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
skips the question), then polls `ci-evidence` for the required checks until all pass, one fails,
or `ci.waitMinutes` (default 60) passes. A failure or timeout is reported with the job links and
the merge is not offered. With no workflows, the step is skipped and the finish says so.

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
