# Writing plans: protected paths and dropped tests

## Protected paths

A path the gate manifest protects — `fleetmates.gate.json` always, plus whatever its top-level
`protected` array adds — may only be changed by a task whose file line carries the ` (protected)`
modifier after the verb:

- `- Modify (protected): \`fleetmates.gate.json\``

Exact lower case only: `(Protected)` is refused like any other malformed file line. The modifier
does not add a second file list: the path is declared in `files` like any other, and the marking
only authorises the change. The gate reads the plan from the anchor commit, so a marking added
mid-run counts only once it is amended on the base branch and the base is merged into the run
branch (see `parallel-execution`, "Amending a
plan mid-run"). A task that changes a protected path without the marking fails `fileset` and
escalates, even when the path is declared.

## Dropped tests

When the gate's manifest gives a `command` check a `report`, the gate compares the suite's tests
before and after the phase. A task that deletes a test, renames one, or makes one stop running must
mark the test file with ` (drops)`:

- `- Test (drops): \`tests/old-parse.test.mjs\``

Exact lower case, read from the plan at the anchor like `(protected)`, and one modifier per line:
a file that needs both markings goes on two lines. Without it the gate's inventory result fails and
the phase escalates. A test that is skipped where the gate runs — no database, no GPU — is not a
plan matter: it is declared in the manifest's `skips`, which is protected.
