# Test Inventory: Dropped Tests and Skipped Tests at the Phase Gate — Design

Depends on `docs/specs/2026-09-26-protected-paths-design.md` (branch `feat/protected-paths`): the
manifest keys added here are enforcement keys, and the manifest is a protected path.

## Problem, and what the evidence changed

The gate runs the project's suite and reads its exit code. A phase can make the suite weaker and
still exit 0, and nothing computed notices. The first draft of this spec (recorded in the protected
paths spec, "Next: spec 2") aimed at one shape: a test that ran before the phase and is skipped or
gone after it.

Before designing, the history was measured (2026-09-26, every repository under `~/Work/projetos`
with fleet state):

- **238 stored review findings.** None reports a skip marker added to an existing test; one reports
  a deleted test (vault-mcp T15, deliberate, a runner hang). 48 (20%) report a test that cannot
  fail — vacuous, unpinned, surviving a mutation.
- **Git history since 2026-06-01.** Every skip marker added arrived with a NEW test, and the three
  deleted test files were chores (bytecode, duplicates, a release). The recurring shape is a test
  that never runs in the gate's environment: `skipif(not DSN_ADMIN)` across five nautilus-lab
  commits, CUDA and audio-fixture skips in TurbidAssist, `#[ignore]` on the 80–93 MB real-map
  tests in RustOt, a born-skipped test in thetowerbot, and the recorded rustot-stats case (five live
  assertions skipped at every gate because the environment was not provisioned).

So this spec ships two rules over one normalised report. The drop rule is a deterrent for a shape
with no recorded incident; the skip rule addresses the shape that recurs. The first draft's
"skipped count rises → escalate" is replaced: counted per file it escalated every legitimate new
test born skipped, and it never saw a test skipped at both ends.

## Rules

Per `command` check that declares a report, the gate compares the **baseline** report (the suite
run at `runSha`, the run tip before this phase's merges) with the **preview** report (the suite
run in the merge preview, as today). A test is identified by its ID (below); a test is *ran* when
its case has no `<skipped>` child, *skipped* otherwise (a `todo` is skipped: its failures do not
count).

| Case | Result |
|---|---|
| **Drop:** an ID that ran at the baseline is absent or skipped in the preview | Escalate, unless a task of this phase marks the test's unit `(drops)` |
| **New skip:** an ID absent at the baseline is skipped in the preview | Escalate, unless the unit is in the manifest's `skips` |
| **Standing skip:** an ID skipped at the baseline and in the preview, unit not in `skips` | Reported, never failed |
| **Stale declaration:** a `skips` unit with no skipped ID in the preview | Reported, never failed |
| An ID skipped at the baseline and absent or ran in the preview | Nothing: removing or reviving a skipped test weakens nothing |

Standing skips are reported and not failed so adoption does not break: nautilus-lab's Postgres
tests are listed at every gate until someone provisions the database or declares them. A rename
inside a file reads as a drop plus a new ID; that escalates and `(drops)` authorises it — rare, and
cheap to mark.

## Identity and normalisation

`scripts/test-report.mjs`, zero dependencies, pure (bytes in, structure out):

    parseJunit(xml, { root }) -> { units: Map<unit, Map<id, { ran: n, skipped: n }>> }

- **Unit** = the case's `file` attribute made repo-relative, or its `classname` when it has no
  `file`. `root` is the directory the suite ran in, stripped from absolute paths — the baseline and
  the preview run in different directories, and `node --test` writes absolute paths (measured). A
  `file` outside `root` is a parse failure.
- **ID** = `unit`, the enclosing `testsuite` names, the case `classname` and its `name`, joined by
  ` > ` with empty parts dropped and adjacent repeats collapsed (node's constant classname is why its
  IDs read `tests/a.test.mjs > test > y`). Counts, not
  booleans: a parametrised name can repeat, so an ID's drop is a fall in its `ran` count.
- A report is one file, or every `*.xml` under a directory (Gradle writes one per class), merged.
- Refused, as a parse failure: not XML, no `testsuites`/`testsuite` root, a case with no `name`,
  entity declarations (`<!DOCTYPE`/`<!ENTITY`), more than 50 MB. The parser is a small tokenizer
  over elements and attributes; it never expands entities beyond the five predefined ones and
  numeric references.

Measured shapes the parser must accept (fixtures captured from the real runner in the plan):

| Runner | Unit comes from | Note |
|---|---|---|
| `node --test --test-reporter=junit` | `file`, absolute | `describe` is a nested `testsuite`; `todo` is `<skipped type="todo">` |
| pytest `-o junit_family=xunit1` | `file`, relative | xunit2 (the default) has no `file`: unit falls back to the dotted `classname` |
| jest-junit `addFileAttribute=true` | `file` | fixture captured in the plan if jest is installable; otherwise documented as unmeasured |
| cargo-nextest junit | `classname` (binary id) | **Measured (0.9.146): `#[ignore]` tests are absent from the JUnit report**, with or without `--run-ignored default`. Closed by a `nextest-list.json` beside it (below) |
| gotestsum `--junitfile` | `classname` (package) | Go is not installed here; documented as unmeasured |

**nextest listing.** A report directory may also hold `nextest-list.json`, the output of
`cargo nextest list --message-format json`. Every test it marks `ignored: true` counts as skipped,
under unit = binary id and the same ID the JUnit report would give it (`demo::it > heavy`); a test
the run executed anyway is not counted twice. The recipe, in the path form because nextest writes
its JUnit under its own target directory (`[profile.default.junit] path = "junit.xml"`):

    cargo nextest run; s=$?; cargo nextest list --message-format json > target/nextest/default/nextest-list.json; exit $s

with `"report": { "format": "junit", "path": "target/nextest/default" }`. Measured end to end on a
crate with one `#[ignore]` test: the inventory holds it as skipped.

`skips` and `(drops)` name units exactly as the parser produces them — a path for runners that
emit `file`, the classname otherwise. Every `inventory` line names the unit as the parser produced
it, so the value to copy into a declaration is in the failure that asks for it.

## Manifest

On a `command` check, optional:

```json
{ "name": "test", "kind": "command",
  "run": "node --test --test-reporter=junit --test-reporter-destination=$FLEETMATES_REPORT_DIR/node.xml",
  "report": { "format": "junit", "dir": true } }
```

- `"dir": true` — the runner writes under `$FLEETMATES_REPORT_DIR`, a fresh directory outside every
  tree, one per execution.
- `"path": "build/test-results/test"` — for a runner that cannot write outside the tree (Gradle,
  nextest's store). Repo-relative, validated like `protected` entries. The gate deletes it in the
  executing tree before the run and requires it after.
- Exactly one of the two. `format` is `"junit"` (the only value in v1).

Top level, optional:

```json
{ "skips": [ { "file": "tests/db/test_schema.py", "reason": "POSTGRES_ADMIN_DSN not provisioned in the gate" } ] }
```

- `file` is a unit, exact. `reason` is a non-empty string; an entry without one is rejected at
  validation.
- `skips` joins `ENFORCEMENT_KEYS` (so it cannot come from the local layer). The manifest is
  protected, so adding a skip needs a `(protected)` marking — the operator approves it.

## Plan

A fourth file-line modifier: `- Test (drops): \`tests/old-parse.test.mjs\``. Parsed like
`(protected)` (exact lower case; both may not be combined on one line — a task that needs both
writes two lines, which the refusal names). The path goes to `files` and to a new `dropFiles`.
Authorisation reads the plan at the anchor, so a mid-run marking counts once the amendment is on
the base and the base is merged into the run branch. A drop is authorised when ANY task of the
phase being gated marks its unit — authorisation does not depend on which task changed the file,
because a drop can come from a change to source, not to the test.

## Execution

- **Where:** `gate` and `finish` (which recomputes the gate). `complete` reports `inventory` as
  `skip` ("the early check does not run the baseline") — doubling a teammate's suite time for a
  result the gate recomputes anyway is not worth it. A solo (`--no-fleet`) gate has no baseline:
  `skip` with that reason.
- **Baseline:** a detached worktree at `runSha`, created and linked exactly as the preview is
  (`preview.link` applies), removed after. Only when at least one check declares `report`. The
  preview and the baseline run under the same manifest object, parsed once. Sequential, never
  parallel with the preview: the RustOt runs already hit memory limits with one suite at a time.
- **Report contract:** before each execution the gate creates `FLEETMATES_REPORT_DIR` (`dir`) or
  deletes the in-tree `path`, runs the command with the variable in its environment, and reads the
  report whatever the exit code. A failing suite still has an inventory.
- **No cache:** a baseline stored under `.fleetmates/` is agent-writable.
- **Phase with no branches:** the preview runs in the main worktree today (`withMergePreview` with
  no branches); the baseline would be the same tree, so `inventory` is `skip` ("no phase branches
  to compare").

## Results and escalation

For each `command` check with `report`, the gate appends a computed result
`{ name: '<check>:inventory', kind: 'inventory' }` right after that check. It is computed like
`merge`: a manifest entry of kind `inventory` finds no runner and lands `pending` (blocks).
`inventory` joins `PROCESS_KINDS` in `fix-loop.mjs`, so its FAIL escalates as a process violation.

| Situation | `inventory` |
|---|---|
| Undeclared drop or undeclared new skip | FAIL; one line per ID, grouped `drop:` / `new skip:`, with the unit and the phase tasks whose branches changed that unit (diagnosis only) |
| Report declared, absent after the baseline or the preview run | FAIL, naming which run |
| Report does not parse | FAIL with the parse error (through `printable`) |
| Check has no `report` | no `inventory` result (the report is opt-in per check) |
| `complete`, solo gate, phase with no branches | `skip` with the reason |
| Otherwise | PASS; output lists standing skips and stale declarations, if any |

`finish`'s run summary gains one line: `standing skips at the last gate: N (units: …)`, printed
through `printable`, so the rustot-stats case is visible at the end of every run.

## `.only`

No regex. The suggested manifest (`gate-config.mjs`'s inferred manifest and the README) passes the
runner's own refusal: `node --test` ignores `.only` unless `--test-only` is given; vitest
`--allowOnly=false`; mocha `--forbid-only`; Jest has no flag, so under Jest a focused suite shows as
drops in the inventory and escalates. A `.only` that the runner refuses fails the command check and
goes to the ordinary retry.

## Errors

| Situation | Result |
|---|---|
| `report` with both or neither of `dir`/`path`, unknown `format`, `path` absolute or escaping | Manifest rejected at validation, naming the check |
| `skips` not an array, entry without `reason`, `file` absolute or escaping | Manifest rejected at validation |
| `(drops)` with other case, or combined with `(protected)` on one line | Plan refused (`PlanParseError`) naming the line |
| Baseline worktree cannot be created | `inventory` FAIL naming the git error; the command check's own preview result is unaffected |

## Testing

- `tests/test-report.test.mjs`: fixtures captured from real runners (node, pytest xunit1 and
  xunit2, nextest if installable); root stripping, nested suites, todo, parametrised repeats, merge
  of a report directory; each refusal.
- `tests/test-report.test.mjs` also holds the rule table as pure cases over two inventories.
- `tests/inventory-gate.test.mjs`, real git with `node --test` as the suite: a phase that deletes a
  test (drop, FAIL), the same with `(drops)` (PASS) and with `(drops)` on another phase's task
  (FAIL), a new test born skipped (FAIL), the same unit in `skips` (PASS), a standing skip (PASS,
  reported), a renamed test (drop), a report the suite never writes (FAIL), a baseline that writes
  none or whose tree cannot be built (FAIL), the solo, branchless and conflicted skips, `complete`,
  `finish`, the path form, and the process-violation escalation. Adversarial cases in the same file:
  `.skip` added to an existing test → FAIL escalated; `report` removed from the manifest without
  `(protected)` → fileset FAIL (spec 1); LIMIT: a loosened assertion passes; LIMIT: a test file that
  writes its own report into `$FLEETMATES_REPORT_DIR` controls the verdict.
- Mutation-checked: every guard and rule was broken against its tests; each mutant a review round
  found surviving got a test. The one survivor kept is the size check before a report is read —
  without it the report is still refused, only after it is loaded, which no test observes.

## Implementation notes (2026-09-26)

- **nextest omits ignored tests** from its JUnit report (measured on 0.9.146, above). First shipped
  as a documented blind spot; closed before merge by reading `nextest-list.json` beside the report.
- **The suggested `node --test` check rewrites the script itself**, inserting the reporter flags
  right after `node --test`, and only for a script that names no reporter and carries no shell
  syntax. Measured: flags appended with `npm run test -- …` never reach the runner (node stops
  reading options at the first positional argument); `NODE_OPTIONS` reaches every nested
  `node --test` a suite spawns, which then writes into the same report; and a script with its own
  reporter plus two more has more reporters than destinations, so node refuses to start.
- **The in-tree report form is safe to delete only where the gate owns the tree.** Review found
  `report.path: "reports/.."` accepted, and the pre-run delete removed the repository, `.git`
  included. Validation now refuses a path that is the tree, climbs, or touches `.git`; the delete
  runs only in the preview or baseline worktree; and every component of the path is checked for a
  symbolic link before the delete and again before the read.
- **Round 2 found the delete still reachable outside the tree** through a backslash, which the
  symlink walk read as a separator and `rm` as part of a name. An in-tree `path` is now plain
  `/`-separated segments of `[A-Za-z0-9._-]`, no `.`/`..` segment, no segment ending in a dot, no
  `.git` in any case; the delete target is built from the same segments the walk checked. A window
  remains between the walk and the delete, open only to a process an earlier check left running in
  the gate's own worktree. Report files must be regular files: a FIFO or a link to `/dev/zero`
  reports size 0 and then reads without bound. The suggested `node --test` rewrite matches `--test`
  as a whole flag and puts `node_modules/.bin` on `PATH`, since it no longer runs through `npm run`.
- **Round 3 found no remaining delete outside the report location, and a read-side race**: a
  check by path followed by a read by path let a suite swap in a FIFO (the gate hung past the
  check's timeout) or a link to a file outside the report (its first bytes reached the parse
  error). Each report file is now opened once with `O_NOFOLLOW | O_NONBLOCK`, judged by `fstat`
  on that handle, and read from it within the size cap.
- **Attributes are scanned by hand**, linear in the tag: the regex was quadratic (80 KB tag, 5.5 s).
  Report files are sized before they are read.
- **A symlink at an in-tree report path is refused**: the suite could otherwise point the gate at a
  file the tree does not hold.
- **A test ID collapses adjacent repeats** (`demo::it > runs`, not `demo::it > demo::it > demo::it >
  runs`): nextest names the unit, the suite and the classname identically.
- **Stacked modifiers are refused** (`(drops) (protected)`): the shape pattern used to accept only
  one parenthesised group, so the stacked line matched neither pattern and left `files` silently.
- **`checksForPhase` hands each report-bearing check the manifest's `skips`**, overwriting the
  entry's own, the same way it hands enforcement checks `protected`.
- **A report directory is merged**, which is also what the forged-report LIMIT test uses: a test
  file writing a second `*.xml` into `$FLEETMATES_REPORT_DIR` controls the inventory.
- The end-to-end tests live in `tests/inventory-gate.test.mjs` (one harness for gate, `complete`,
  `finish` and the adversarial cases) rather than in `tests/gate-runner.test.mjs` and
  `tests/adversarial.test.mjs`.

## Out of scope

- **A loosened or vacuous assertion.** The run count does not move. It is 20% of stored review
  findings and is the `tests` review lens's job; a diff heuristic per language and matcher would
  bury the signal, and mutation testing costs dozens of suite runs per gate. Pinned by a LIMIT test.
- **A runner or test file that writes the report itself.** The report is produced by a process
  running teammate code; nothing inside that process can be trusted to describe it. Same boundary as
  "a teammate that runs arbitrary code" in the tamper-evident spec. Pinned by a LIMIT test.
- **NUnit/Unity.** No Unity project exists here to capture a real report from.
- **Provisioning the environment** so standing skips run. The inventory makes them visible; making
  them run is each project's gate setup.
