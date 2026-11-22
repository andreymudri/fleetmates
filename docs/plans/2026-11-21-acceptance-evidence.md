# Acceptance evidence

Spec: `docs/specs/2026-11-21-acceptance-evidence-design.md`.

## Global Constraints

- Node >= 24.2, zero dependencies
- Commit messages: single line, commitlint style, English, no tool attribution
- No personal names, emails, usernames or real home paths in any file
- Every new test is shown to fail when the rule it covers is removed
- Text read from a plan or an evidence file is printed through `printable`

## Destination

A session can record, per entry of a plan's Acceptance section, whether it verified the entry and
how, and one command lists the entries left without evidence.

## Statement

Start ticket 9: `finish` lists the Acceptance entries of the plan that have no recorded evidence.
Inline path. Each entry of the plan's Acceptance section gets a state in the run (verified or not,
with the evidence). The list appears in a command of its own, which runs nothing, and in `finish`
as well. Evidence is a state and a required note. It is recorded with the commit; the list shows
the commit and passes no verdict on its age. The list exits 1 when an entry has no evidence or
failed. A recorded fail does not change the verdict of `finish`: it warns and does not block. An
entry left without evidence is reported in the final message and offered as a ticket.

## Acceptance

- `acceptance --run <id> --plan <path>` lists every Acceptance entry of the plan with `pass`, `fail` or no evidence, and exits 0 only when every entry has `pass`.
- `acceptance --run <id> --plan <path> --entry <An> (--pass | --fail) --note <text>` records the evidence with the current commit and the recorder, and a second recording replaces the first.
- An entry whose text changed after its evidence was recorded is listed as having no evidence.
- A plan without an Acceptance section prints nothing and exits 0.
- An unknown entry, a missing note, an unknown run and a damaged evidence file exit 2.
- `finish` prints the list after its summary, and its verdict and exit code are the same with and without recorded evidence.
- `executing-plans` tells the session to record the evidence, run the list and name the entries left without evidence.
- `npm test` passes.

## Out of Scope

- Blocking `finish` on evidence — the evidence is declared by the session that did the work, and the owner chose a warning.
- Invalidating evidence when a commit is added — a changelog commit after the verification would force every entry to be recorded again.
- The CLI running verification commands — an entry such as "npm test passes" would run the suite a second time.
- Fleet-side acceptance tests — a separate proposal that waits for an eval.
- `workflow-accept` — it serves the strict Workflow controller and is neither reused nor changed.

### Task 1: the evidence store and the command

**Files:**
- Create: `scripts/acceptance.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/acceptance.test.mjs`
- Modify: `tests/cli.test.mjs`

- [ ] **Step 1:** Write `tests/acceptance.test.mjs` first, one test per rule of the spec's Testing section except the `finish` one, and watch them fail.
- [ ] **Step 2:** `scripts/acceptance.mjs`: `acceptanceEntries(markdown)` (ids `A1`..`An` with text and hash, from `bulletSection(markdown, 'Acceptance')`), `readEvidence`, `recordEvidence` (atomic write of `.fleetmates/<run>/acceptance.json`), `summarizeAcceptance(entries, evidence)`, `renderAcceptance(...)`, and `runAcceptanceCommand({ root, flags, io, env, now })`.
- [ ] **Step 3:** Wire `acceptance` into `scripts/cli.mjs`: usage, required and known flags, `pass` and `fail` as valueless flags, the handler. Update the printable census only if a counted line was added.
- [ ] **Step 4:** Mutation: for each rule, break its line, watch its test fail, restore, and check with `git diff` that only the intended code remains.

### Task 2: the list in finish

**Files:**
- Modify: `scripts/cli.mjs`
- Modify: `scripts/acceptance.mjs`
- Test: `tests/acceptance.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Test first: `finish` on a run whose plan has Acceptance entries prints the list, and its exit code is the same with no evidence, with `pass` and with `fail`.
- [ ] **Step 2:** After the ticket reminder in `finish`, print `acceptanceLinesForFinish({ root, runId, planPath })`; an error reading the plan or the evidence prints one line and never changes the exit code.
- [ ] **Step 3:** Mutation: make the helper return nothing, watch the test fail, restore.

### Task 3: skill, docs and counts

**Files:**
- Modify: `skills/executing-plans/SKILL.md`
- Modify: `tests/skills.test.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `CONTRIBUTING.md`

**Depends:** T2

- [ ] **Step 1:** In `executing-plans`, step 4: record the evidence for each Acceptance entry, run the list, and name in the final message the entries left without evidence. Pin the sentence in `tests/skills.test.mjs`, and watch the pin fail with the sentence removed.
- [ ] **Step 2:** README command block and an `## Unreleased` entry in the changelog.
- [ ] **Step 3:** Run the security lint, `npm test` once and the hostile-tmpdir sweep; update the passing count in `CONTRIBUTING.md`.
