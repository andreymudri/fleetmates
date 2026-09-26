# Test Inventory — Implementation Plan

Spec: `docs/specs/2026-09-26-test-inventory-design.md`

## Global Constraints

- Node >= 20, zero new runtime dependencies, ESM `.mjs`
- Code style matches the surrounding file: no semicolons, two-space indent, single quotes, comments explain why
- Tests use `node:test` + `node:assert/strict`; gate behaviour is tested against real git repositories and a real `node --test` suite, never a fake git
- Commit messages: single-line, commitlint style, English; no co-author or tool attribution lines
- `npm test` green at the end of every task
- Source-text assertions strip comments before counting a symbol
- Every value from an agent-written file (a report, the manifest, the plan) reaches stdout through `printable`/`printableBlock`
- Literal U+2028/U+2029 never appear in source; write ` `

## Destination

A phase that drops a test that used to run, or adds a test that is skipped where the gate runs, escalates unless the plan or the manifest says so; a test skipped at every gate is named at every gate.

## Out of Scope

- Loosened or vacuous assertions — the run count does not move; the `tests` review lens covers it.
- A runner or test that writes its own report — the report comes from a process running teammate code.
- NUnit/Unity — no project here to capture a real report from.

### Task 1: JUnit parser and inventory comparison

**Files:**
- Create: `scripts/test-report.mjs`
- Test: `tests/test-report.test.mjs`
- Create: `tests/fixtures/junit/node.xml`
- Create: `tests/fixtures/junit/pytest-xunit1.xml`
- Create: `tests/fixtures/junit/pytest-xunit2.xml`
- Create: `tests/fixtures/junit/nextest.xml`

- [ ] **Step 1:** Capture fixtures from the real runners in a scratch directory: `node --test --test-reporter=junit` over a file with a passing test, a `{ skip }` test, a `todo`, a `describe` with an inner test, and two tests sharing a name; pytest with `--junitxml` under `-o junit_family=xunit1` and the default, over the same shapes plus a parametrised test. `cargo install cargo-nextest --locked` and capture a two-test crate with one `#[ignore]` under `[profile.default.junit] path`; if the install fails, do not create `nextest.xml` and record that in the spec's runner table as unmeasured. Replace the scratch absolute root in each fixture with the literal `/ROOT` so the tests pass `root: '/ROOT'`.
- [ ] **Step 2:** Failing tests: units and IDs for every fixture (node `file` made relative against `root`; pytest xunit2 falls back to the dotted `classname`); nested suites join with ` > `; todo counts as skipped; repeated names count 2; a directory of reports merges; refusals — not XML, no testsuite(s) root, a case without `name`, `<!DOCTYPE`, a `file` outside `root`, input over 50 MB — each throws `ReportParseError` whose message quotes no more than 200 bytes, through `printable`.
- [ ] **Step 3:** Implement `parseJunit(xml, { root })` returning `{ units: Map<string, Map<string, { ran: number, skipped: number }>> }` with a tokenizer that handles elements, attributes (both quote styles), self-closing tags, comments, CDATA, and the five predefined entities plus numeric references; `readReport(pathOrDir, { root })` reading one file or every `*.xml` directly under a directory (sorted) and merging counts.
- [ ] **Step 4:** Failing tests, then `compareInventories(baseline, preview, { drops: Set<unit>, skips: Set<unit> })` returning `{ dropped, newSkips, standing, stale }`, each an array of `{ unit, id }` (`stale` of `{ unit }`), per the spec's rule table: a drop is a fall in an ID's `ran` count; a new skip is an ID absent at the baseline with `skipped > 0` in the preview; standing is skipped at both ends with the unit not in `skips`; stale is a `skips` unit with no skipped ID in the preview. `dropped` and `newSkips` exclude units in `drops`/`skips` respectively.
- [ ] **Step 5:** `npm test`, commit `feat(test-report): parse JUnit into a per-unit inventory and compare two of them`.

### Task 2: plan parser — `(drops)` modifier

**Files:**
- Modify: `scripts/plan-parser.mjs`
- Test: `tests/plan-parser.test.mjs`
- Modify: `skills/writing-plans/SKILL.md`

- [ ] **Step 1:** Failing tests: `- Test (drops): \`t.test.mjs\`` puts the path in `files` and `dropFiles` for every verb; a task without it has `dropFiles: []`; `(Drops)`, `(drop)` and `(protected, drops)` are refused with the line; the `:line` suffix is stripped from the marking; the frozen-parser regression over `docs/plans/*.md` still holds.
- [ ] **Step 2:** `FILE_LINE = /^-\s+(?:Create|Modify|Test)(?:\s+\((protected|drops)\))?\s*:\s*`([^`]+)`\s*$/`; push the path to `protectedFiles` or `dropFiles` by the captured modifier; initialise `dropFiles: []`.
- [ ] **Step 3:** `skills/writing-plans/SKILL.md`: document `(drops)` next to `(protected)` — what it authorises, read at the anchor, one modifier per line.
- [ ] **Step 4:** `npm test`, commit `feat(plan-parser): accept the (drops) modifier`.

### Task 3: manifest — `skips` and a command check's `report`

**Files:**
- Modify: `scripts/config.mjs`
- Test: `tests/config.test.mjs`

- [ ] **Step 1:** Failing tests: `ENFORCEMENT_KEYS` gains `'skips'` and the local layer rejects it; `skips` rejects a non-array, an entry that is not an object, a missing/empty `reason`, a `file` that is absolute or escapes; accepts `[{ file: 'tests/db/test_schema.py', reason: 'no db' }]`. `phases` rejects on a check: `report` that is not an object, `format` other than `'junit'`, both or neither of `dir: true` and `path`, a `path` absolute or escaping; accepts both forms.
- [ ] **Step 2:** Implement: a shared `repoRelative(entry, what)` used by `protected`, `skips` and `report.path`; the `report` checks inside the `phases` validator, naming `phases.<name>.checks[<i>].report`.
- [ ] **Step 3:** `npm test`, commit `feat(config): skips and a command check's report contract`.

### Task 4: gate — report contract, baseline tree, `inventory` result

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Modify: `scripts/merge-preview.mjs`
- Modify: `scripts/fix-loop.mjs`
- Test: `tests/gate-runner.test.mjs`
- Test: `tests/merge-preview.test.mjs`
- Test: `tests/fix-loop.test.mjs`

**Depends:** T1, T2, T3

- [ ] **Step 1:** `merge-preview.mjs`: `withTreeAt({ git, sha, link, repoRoot, run, makeTempDir })` — a detached worktree at `sha`, linked like the preview, owner-marked and claimed like the preview so the reaper treats it the same way, removed in `finally`. Test with a real repo: the tree holds `sha`'s content, `preview.link` entries appear, the worktree is gone afterwards even when `run` throws.
- [ ] **Step 2:** `runCommandCheck`: when `check.report` is set, before `exec` create `FLEETMATES_REPORT_DIR` with `mkdtemp` (dir form) or `rm -rf` the in-tree `path` under the executing cwd (path form); pass the variable to `exec` through its env; after exec read the report with `readReport` against the executing cwd as `root`; attach `report: { inventory } | { error }` to the returned result object (never to its `output`). `defaultExec` gains an `env` option merged over `process.env`. Real-git tests with a `node --test` suite: dir form, path form (stale path deleted first), a suite that writes nothing (`error: 'absent'`), a failing suite still carries its inventory.
- [ ] **Step 3:** `runChecks`: after the preview's `runCheckList`, when any command check has `report` and the context is a full gate (`!ctx.solo && !ctx.early`, branches present), run the same report-bearing command checks with `withTreeAt({ sha: ctx.runSha })` and compute, per check, `{ name: '<check>:inventory', kind: 'inventory' }` from `compareInventories(baseline, preview, { drops: phase tasks' dropFiles, skips: manifest skips })`, inserted right after its command check. FAIL lines: `drop: <unit> > … — ran at the baseline, <absent|skipped> now (tasks changing it: T2)` and `new skip: <id>`; absent or unparseable report FAIL naming `baseline` or `preview`; PASS output lists `standing skip:` and `stale skips entry:` lines. `ctx.early`, `ctx.solo` and no branches give `skip` with the spec's reasons. The results never reach a runner: `RUNNERS` has no `inventory`, so a manifest-declared `inventory` stays `pending`.
- [ ] **Step 4:** `fix-loop.mjs`: `PROCESS_KINDS` gains `'inventory'`; test that an `inventory` FAIL escalates as `process-violation`.
- [ ] **Step 5:** Real-git gate tests from the spec's Testing list (deleted test, `(drops)`, born-skipped, `skips`, standing, rename, report never written), each mutation-checked.
- [ ] **Step 6:** `npm test`, commit `feat(gate): baseline the suite at the run tip and report dropped and skipped tests`.

### Task 5: CLI — early check, finish summary, suggested manifest

**Files:**
- Modify: `scripts/cli.mjs`
- Modify: `scripts/finish.mjs`
- Modify: `scripts/gate-config.mjs`
- Test: `tests/cli.test.mjs`
- Test: `tests/finish.test.mjs`
- Test: `tests/gate-config.test.mjs`

**Depends:** T4

- [ ] **Step 1:** `complete` passes `early: true` into the check context; its `inventory` results read `skip`. Test through `runCli`.
- [ ] **Step 2:** `finish`: the run summary gains `standing skips at the last gate: N (units: …)` from the last phase's inventory results, through `printable`; omitted when N is 0. Tests in `tests/finish.test.mjs` and one `runCli` case.
- [ ] **Step 3:** `gate-config.mjs` inferred manifest: for a `package.json` `test` script that runs `node --test`, suggest the junit reporter flags and `report: { format: 'junit', dir: true }`; for vitest append `--allowOnly=false`; for mocha `--forbid-only`. Tests over each inferred shape.
- [ ] **Step 4:** Update the printable census in `tests/cli.test.mjs` for any new wrapper site, naming it.
- [ ] **Step 5:** `npm test`, commit `feat(cli): skip the inventory in the early check and name standing skips at finish`.

### Task 6: adversarial tests and docs

**Files:**
- Test: `tests/adversarial.test.mjs`
- Modify: `docs/specs/2026-08-05-tamper-evident-enforcement-design.md`
- Modify: `docs/specs/2026-09-26-test-inventory-design.md`
- Modify: `skills/phase-gate/SKILL.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Depends:** T5

- [ ] **Step 1:** Adversarial tests (real repo, real `node --test` suite with `report`): `.skip` added to an existing test → gate FAIL, `fix` escalates `process-violation`; removing `report` from the manifest without `(protected)` → fileset FAIL; LIMIT: `assert.equal(x, 5)` → `assert.ok(x)` passes; LIMIT: a test file that overwrites `$FLEETMATES_REPORT_DIR`'s report controls the inventory.
- [ ] **Step 2:** Docs: tamper-evident spec gains the inventory under "Enforced" and the two LIMITs under "Not defended against"; `phase-gate` describes `<check>:inventory`, its lines, and that approving a drop is a `(drops)` amendment and approving a skip is a `skips` entry (protected); README documents `report` and `skips`; CHANGELOG Unreleased entry; the spec gets "Implementation notes" for anything that changed.
- [ ] **Step 3:** `npm test`, commit `test(adversarial): test inventory; docs`.
