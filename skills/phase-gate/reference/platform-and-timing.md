## Platform and timing failures

Two flags on a `command` check in `fleetmates.gate.json` aim at failures that otherwise show up
only on the remote CI: a check that breaks on another operating system, and a test that fails
once and passes on a rerun. Both are `true` or `false`; any other value fails the check with
`<flag> must be true or false`, and is never read as a default.

**`"platformSim": true`** runs the check under the platform simulator instead of running it
plainly, so the gate does no extra run. The simulator points `TMPDIR`, `TMP` and `TEMP` at a
directory reached through a symlink whose path holds a space, points `GIT_CONFIG_SYSTEM` at a
generated file that sets `core.autocrlf=true` and includes the user's own system git config (the
level Git for Windows sets it at on a Windows runner; the global config is left alone), and
on POSIX runs the command under `umask 077`. The check's output carries one
`platform-sim: applied ...` line naming those conditions and any it skipped, and the scratch
directory is removed afterwards, on a failure too. On Windows the symlink and the umask are skipped
and named as skipped; this is unit-tested with an injected platform, not on a Windows host.
The same simulator runs by hand:

    node "<fleetmates root>/scripts/cli.mjs" platform-sim --root <project root> -- <command...>

It exits with the command's own exit code. A failure that appears only on a plain Linux run, such
as one that needs the real temp directory, still reaches the remote CI.

The simulated `core.autocrlf` reaches git only through `GIT_CONFIG_SYSTEM`. Code that drops every
`GIT_*` variable before calling git, as a hardened git wrapper does, reads the user's real
system config instead, so files checked out under the simulator read to it as modified. On a real
machine both read the same system config and agree. A test of such code pins `core.autocrlf` in its
fixture repository's own config, which every git reads.

**`"flaky": true`** runs the check through the flaky detector. On a non-zero exit the check is
retried exactly once, and a pass on that retry passes the check while keeping a `flaky: <id>`
line in its output, so a flake is green but never silent. The check's timeout bounds both
attempts together, and an attempt that timed out is not retried.

In the gate, the retry reruns the whole command. The check runs through a shell (`/bin/sh -c <run>`,
or `cmd.exe /d /s /c "<run>"` on Windows), so the detector cannot read the test runner off its
arguments and never filters the retry to the failed tests; the Windows form is unit-tested only.
The detector names failed tests only from a report that is a single JUnit file, as
`<file>::<classname>::<name>` (or the part of that the report carries). Otherwise it names the
whole command, as `/bin/sh -c <run>` on POSIX, and a whole command is never quarantined as a named
test. In the gate that covers both report forms in the main worktree: a `"dir": true` report is a
directory, which the detector does not read names from, and an in-tree `"path"` report is refused
outside a worktree the gate owns. Since the gate writes the quarantine file only from the main
worktree, it never records a named test there; named tests reach the file through the `flaky`
command with a single-file `--report`. Inside a merge preview an in-tree `"path"` report does name
the failed tests, so a test already in the file can still be excused there.

When both attempts fail, the check fails with the first attempt's exit code, with one exception:
a run is excused only when every test that failed on the first attempt either passed on the retry
or is already quarantined, and every test still failing is quarantined. Only named tests from a
report are ever quarantined, so a whole command that fails twice is red every time, and so is a
retry that exits non-zero while its report names no failed test. An excused check passes and
prints `flaky: quarantined test failed: <id>` and a line saying which exit code was overridden and
why. That line is there because of a known limit: a failure outside any test (a crash, a coverage
threshold) in the same run as a quarantined test failing twice cannot be told apart with a single
retry.

Both flags together run each attempt, the retry included, under the simulator.

**The quarantine file** is `fleetmates.flaky.json` at the project root. Each entry records when the
test was first and last seen flaky, how many times, and its current pass streak. A test that passes
on its retry is added or updated there; a quarantined test that passes adds one to its streak, and
one that fails resets it. A malformed file fails the check, and the same file refuses the `flaky`
command with exit 2. The gate writes the file only when the check runs in the main worktree outside
a merge preview; the `flaky` command writes it only from the main worktree's top level or when
`GITHUB_ACTIONS=true`. A teammate's worktree never writes it.

The file is protected like the gate manifest: it is always in the protected set, so a task that
changes it fails `fileset` unless its plan line marks the path `(protected)`. A teammate therefore
cannot quarantine its own failing test. After 20 passes in a row, `doctor` suggests removing a test
from the file; nothing removes it automatically.

**The `portability` review lens** is added to a phase's review without any manifest change when a
workflow under `.github/workflows` runs on macOS or Windows, through `runs-on` or a matrix `os`
list. `review-dispatch` emits a reviewer for it and `collect-reviews` expects its findings: with no
findings file for it, `collect-reviews` exits 4 naming `portability` among the missing lenses. Listing
`portability` in the manifest adds it on any project. An explicit empty lens list stays empty.
