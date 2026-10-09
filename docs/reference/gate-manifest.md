# Gate manifest

Moved from the project README. The manifest is `fleetmates.gate.json` at the project root.

Copy `fleetmates.gate.json` into any project the fleet runs in, or let
`node scripts/cli.mjs gate --run <id>` infer one from `package.json` and print it for you to
confirm. A project whose test runner is itself a dependency should declare what to link into the
preview:

```json
{ "preview": { "link": ["node_modules"] } }
```

The preview contains tracked content only, so without that a command check runs against a tree
with no dependencies installed and fails for a reason that has nothing to do with the code.

`fileset` and `ownership` run on every phase even when the manifest omits them. Paths that decide
what the gate checks can be protected; the manifest always is:

```json
{ "protected": ["package.json", "tests/conftest.py"] }
```

A task may change a protected path only when its plan line says so —
``- Modify (protected): `package.json` `` — and the plan is read from the anchor commit, so a
marking added mid-run counts once it is amended on the base branch and the base is merged into
the run branch.

A `command` check can hand the gate a JUnit report, and the gate then compares the tests that ran
before the phase with the tests that run after it:

```json
{ "name": "test", "kind": "command",
  "run": "node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=\"$FLEETMATES_REPORT_DIR/node.xml\" tests/*.test.mjs",
  "report": { "format": "junit", "dir": true } }
```

`"dir": true` means the runner writes under `$FLEETMATES_REPORT_DIR` (`%FLEETMATES_REPORT_DIR%` on
Windows, where checks run through `cmd.exe` and the suggested manifest carries no report), a fresh
directory per run;
`"path": "build/test-results/test"` names an in-tree report instead, deleted before each run — only
ever inside the gate's own preview and baseline worktrees, and never through a symbolic link. A test
that stops running needs its file marked ``- Test (drops): `…` `` in the plan; a new test that is
skipped where the gate runs needs its unit declared:

```json
{ "skips": [{ "file": "tests/db/test_schema.py", "reason": "POSTGRES_ADMIN_DSN not provisioned in the gate" }] }
```

For pytest pass `-o junit_family=xunit1` so cases carry their file. cargo-nextest leaves `#[ignore]`d
tests out of its JUnit report, so have the check also write its listing beside it:

```json
{ "name": "test", "kind": "command",
  "run": "cargo nextest run; s=$?; cargo nextest list --message-format json > target/nextest/default/nextest-list.json; exit $s",
  "report": { "format": "junit", "path": "target/nextest/default" } }
```

with `[profile.default.junit] path = "junit.xml"` in `.config/nextest.toml`.
