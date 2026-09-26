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
- **ID** = `unit` + ` > ` + the enclosing `testsuite` names + ` > ` + the case `name`. Counts, not
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
| cargo-nextest junit | `classname` (binary id) | fixture captured in the plan after `cargo install cargo-nextest` |
| gotestsum `--junitfile` | `classname` (package) | Go is not installed here; documented as unmeasured |

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
- `tests/gate-runner.test.mjs`: the rule table as pure cases over two parsed reports, then real-git
  cases with `node --test` as the suite: a phase that deletes a test (drop, FAIL), the same with
  `(drops)` (PASS), a new test born skipped (FAIL), the same unit in `skips` (PASS), a standing skip
  (PASS, reported), a renamed test (drop), a report the suite never writes (FAIL).
- `tests/adversarial.test.mjs`: a teammate adds `.skip` to an existing test → FAIL escalated as
  process violation; a teammate removes `report` from the manifest without `(protected)` → fileset
  FAIL (spec 1); LIMIT: a loosened assertion (`assert.equal(x, 5)` → `assert.ok(x)`) passes;
  LIMIT: a test file that writes its own report into `$FLEETMATES_REPORT_DIR` controls the verdict.
- `tests/fix-loop.test.mjs`: `inventory` FAIL escalates as `process-violation`.
- Each new test mutation-checked against the code it pins.

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
