# Statement check, review depth, budget stop and static check docs

Spec: `docs/specs/2026-11-15-statement-check-and-cost-controls-design.md`.

## Statement

Apply four improvements to fleetmates, taken from a review of an "agentic software factory"
diagram: (1) acceptance criteria checked against the original request, with the request and the
criteria living in the plan, one fresh reviewer comparing the plan to the request before
execution, and both sections required when the plan declares Out of Scope; (2) an advisory rule
that sizes the review to the change and never fails a gate; (3) an opt-in budget stop that makes
dispatch refuse new teammates once known spend reaches the budget; (4) documentation and an
example for adding complexity, duplication and dead-code tools as gate command checks.

## Acceptance

- `init-run` refuses a plan that has `## Out of Scope` but no `## Statement` prose or no
  `## Acceptance` entry, and still accepts a plan without `## Out of Scope`.
- `plan-check` prints one reviewer prompt with the `statement` lens that names the plan path and
  tells the reviewer what to compare; it writes nothing and dispatches nothing.
- The run review prompt tells the reviewer to judge the diff against the plan's `## Acceptance`
  entries when the plan has them.
- `review-depth` prints the measured numbers and one of `tests-only`, `two-lenses`, `all-lenses`,
  and exits 0 for all three.
- With `cost.stopAtBudget` on, `workflow` and `dispatch` start nothing once priced spend reaches
  `cost.budget`, and behave as before with the key off.
- The `phase-gate` skill and the README show static analysis tools as `command` checks.
- `writing-plans`, `executing-plans` and `parallel-execution` describe the new sections and run
  `plan-check`; the stale sentence that nothing enforces the header sections is gone.

## Destination

A plan can be checked against the request it was written from before any task runs, the inline
review is sized to the change, and a configured budget can stop new dispatches.

## Global Constraints

- Node >= 24.2.0
- Zero dependencies, runtime and dev
- Commit messages: single line, commitlint style, English, no tool attribution
- No personal names, emails, usernames or real home paths in code, docs, fixtures or test output
- Every new test is shown to fail when the code it covers is broken, then the code is restored;
  check `git diff` after undoing a mutation
- Never modify `fleetmates.gate.json`, existing plans in `docs/plans/`, or anything under `.fleetmates/`
- Plan-authored text never enters a generated prompt raw: pass paths through `dataLiteral` and
  tell the reviewer to read the file

## Out of Scope

- Enforcing review depth in the gate - it would reverse the map's documented rule that no gate reads it.
- A built-in static analysis check - one language only, and it needs a design of its own.
- Stopping teammates that are already running when the budget is reached - the spec stops new dispatches only.
- Pricing the per-task usage records of a headless run - they hold tokens without a price path, and the spec prices the session's usage.
- Storing Statement and Acceptance in `plan.json` - no command reads them from there.

### Task 1: parse Statement and Acceptance, refuse a boundary without them

**Files:**
- Modify: `scripts/plan-sections.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/plan-sections.test.mjs`

- [ ] **Step 1:** In `tests/plan-sections.test.mjs` add failing tests: `parsePlanSections` returns
  `statement` (collapsed prose or `null`) and `acceptance` (entries with `text` and `line`); a
  plan with `## Out of Scope` and `## Destination` but no `## Statement` throws
  `PlanSectionError` with `reason: 'missing-statement'`; an empty `## Statement` heading throws
  the same; with a Statement but no `## Acceptance` entry it throws `reason:
  'missing-acceptance'`; a plan with none of the sections parses as before.
- [ ] **Step 2:** In `parsePlanSections`, after the Destination check, add:

  ```js
  const statement = proseSection(markdown, 'Statement')
  const acceptance = bulletSection(markdown, 'Acceptance')
  if (hasOutOfScope && !statement) {
    throw new PlanSectionError('this plan has an Out of Scope section but no Statement', { reason: 'missing-statement' })
  }
  if (hasOutOfScope && acceptance.length === 0) {
    throw new PlanSectionError('this plan has an Out of Scope section but no Acceptance entry', { reason: 'missing-acceptance' })
  }
  ```

  and return `{ destination, notYetSpecified, outOfScope, statement, acceptance }`. Update the
  module header comment and the JSDoc return type.
- [ ] **Step 3:** In `scripts/cli.mjs` `formatPlanSectionError`, add the two document-level
  refusals before the `missing-reason` branch, each three lines, no plan text quoted.
- [ ] **Step 4:** Add a CLI test that `init-run` exits 2 with the new refusal text for each
  defect (follow the existing `init-run` section-defect test in the suite).
- [ ] **Step 5:** Run `node --test tests/plan-sections.test.mjs` and the CLI test file; mutate
  each new `if` to `false`, watch its test fail, restore, check `git diff`.

### Task 2: `plan-check` prints the statement reviewer prompt

**Files:**
- Create: `scripts/plan-check.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/plan-check.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Write failing tests for `planCheckPrompt({ planPath })`: the prompt names the
  lens `statement`, carries the path as a JSON literal, tells the reviewer to read only the plan,
  lists the three things to report (a requirement an Out of Scope entry excludes, one no task
  covers, a `**Depends:**` naming a task that does not exist), rates a dropped requirement
  `high`, and says the reviewer is read-only. A path containing a newline and backticks appears
  only inside the JSON literal.
- [ ] **Step 2:** Implement `scripts/plan-check.mjs` exporting `planCheckPrompt`, using
  `dataLiteral` from the module `review-gen.mjs` takes it from, and returning
  `{ lens: 'statement', agentType: '<product>:tm-reviewer', prompt }`.
- [ ] **Step 3:** Wire `plan-check --plan <path> [--root <path>]` in `scripts/cli.mjs`: add it to
  the usage text and the flag tables, read the plan from the working tree, exit 2 with the
  section refusal on a `PlanSectionError`, exit 2 with `plan-check: the plan has no Statement
  section, so there is nothing to compare it against` when `statement` is null, otherwise print
  the JSON of `planCheckPrompt` and exit 0. It writes nothing.
- [ ] **Step 4:** CLI tests: the three exits above, and that no file is created under the root.
- [ ] **Step 5:** Run the tests; mutate the missing-Statement refusal and the path literal,
  watch the tests fail, restore, check `git diff`.

### Task 3: run review judges the diff against Acceptance

**Files:**
- Modify: `scripts/review-gen.mjs`
- Test: `tests/review-gen.test.mjs`

- [ ] **Step 1:** Add a failing test: the integrated (run) review prompt contains the sentence
  telling the reviewer that when the tracked plan has an `## Acceptance` section, each entry is
  compared against the integrated diff in Stage 1 and an unmet entry is a spec-compliance
  finding. The phase review prompt does not contain it.
- [ ] **Step 2:** Append that sentence to the integrated `scope` Stage 1 line in
  `generateReviewDispatch`. No plan text is passed in: the reviewer already reads the plan.
- [ ] **Step 3:** Run the test; remove the sentence, watch it fail, restore, check `git diff`.

### Task 4: `review-depth` suggests how much review a diff needs

**Files:**
- Create: `scripts/review-depth.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/review-depth.test.mjs`

**Depends:** T2

- [ ] **Step 1:** Write failing tests for the pure function
  `reviewDepth({ files, lines, coupled })` returning `{ suggestion, lenses, files, lines, coupled }`:

  ```js
  export const DEPTH_LIMITS = Object.freeze({ smallFiles: 3, smallLines: 60, largeFiles: 15, largeLines: 600 })
  // tests-only: files <= 3 && lines <= 60 && coupled === 0   -> lenses []
  // all-lenses: files > 15 || lines > 600                    -> lenses null (the manifest's own)
  // two-lenses: anything else                                -> lenses ['correctness', 'tests']
  ```

  Test each boundary on both sides (3/4 files, 60/61 lines, coupled 0/1, 15/16 files, 600/601 lines).
- [ ] **Step 2:** Implement `reviewDepth` and `renderReviewDepth(result)` (three lines: the
  numbers, the suggestion, and that the result is advisory and no gate reads it).
- [ ] **Step 3:** Wire `review-depth [--base <branch>] [--root <path>] [--json]`: derive the base
  the way `doctor` does when absent, take changed files and added plus deleted lines from
  `git diff --numstat <merge-base>..HEAD`, and count coupled files outside the diff with
  `buildCoupling` and `neighboursOf` over the same 500-commit window briefs use. Exit 0 for
  every suggestion; exit 2 when the base cannot be resolved.
- [ ] **Step 4:** CLI test in a temporary repository: a one-file change prints `tests-only`, and
  the exit code is 0.
- [ ] **Step 5:** Run the tests; mutate each threshold comparison, watch a boundary test fail,
  restore, check `git diff`.

### Task 5: `cost.stopAtBudget` stops new dispatches

**Files:**
- Modify: `scripts/config.mjs`
- Modify: `scripts/usage.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/config.test.mjs`
- Test: `tests/usage-cost.test.mjs`
- Test: `tests/usage-cli.test.mjs`

**Depends:** T4

- [ ] **Step 1:** Failing config tests: `cost.stopAtBudget` accepts a boolean and refuses any
  other type; the resolved config carries `cost.stopAtBudget` (local over gate, default
  `false`); resolving a config with `stopAtBudget: true` and no budget, or with no price, throws
  `ConfigError('cost.stopAtBudget needs cost.budget and at least one cost.prices entry')`;
  `config set cost.stopAtBudget true` is accepted.
- [ ] **Step 2:** Implement in `scripts/config.mjs`: add the field to `validateCost`, to the
  merged `cost` block, the cross-field check after merging, and to the `config set` pattern.
- [ ] **Step 3:** Failing tests for a pure `budgetStop(report)` in `scripts/usage.mjs`, given an
  annotated report: returns `null` when there is no `cost`, no budget or the total is below the
  budget; returns `{ total, budget, currency, unpriced }` when `total >= budget`.
- [ ] **Step 4:** Implement `budgetStop` and `budgetStopLines(stop)` (the total, the budget, the
  unpriced count with "not counted, so the total is a lower bound", and that nothing was started).
- [ ] **Step 5:** In `scripts/cli.mjs` add `async function budgetRefusal(root, config, io)`: with
  `stopAtBudget` off return `false`; read the session usage as `usage` does; on a read error
  print `budget not checked: <message>` and return `false`; otherwise annotate, and when
  `budgetStop` returns a stop, print its lines and return `true`. Call it in `workflow` after the
  config is resolved and in both `dispatch` branches before any teammate is started; exit 1 on
  `true`.
- [ ] **Step 6:** CLI tests against a fixture transcript store (`CLAUDE_CONFIG_DIR`, as
  `tests/usage-cli.test.mjs` does): `workflow` exits 1 and prints no workflow at the budget;
  exits 0 below it; exits 0 with the key off at the budget; exits 0 and prints `budget not
  checked` when the store is missing.
- [ ] **Step 7:** Run the tests; mutate `total >= budget`, the off switch and the read-error
  path, watch the tests fail, restore, check `git diff`.

### Task 6: skills, README and changelog

**Files:**
- Modify: `skills/writing-plans/SKILL.md`
- Modify: `skills/executing-plans/SKILL.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Modify: `skills/fleetmates-config/SKILL.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `CONTRIBUTING.md`

**Depends:** T1, T2, T3, T4, T5

- [ ] **Step 1:** `writing-plans`: document `## Statement` and `## Acceptance`, the rule that
  Out of Scope requires both, and `plan-check`; replace the paragraph that says nothing enforced
  reads the header sections with what `init-run` and `rebuild-state` do; replace the
  self-review "Statement check" bullet with running `plan-check` through one reviewer.
- [ ] **Step 2:** `executing-plans`: step 2 runs `plan-check` and hands the prompt to one
  `tm-reviewer` before the first task; the finish step runs `review-depth` and sizes the final
  review by its suggestion, giving the reviewers the plan's Acceptance entries to judge against.
- [ ] **Step 3:** `parallel-execution`: run `plan-check` once before phase 1; note that
  `workflow` and `dispatch` refuse to start teammates when `cost.stopAtBudget` is on and the
  budget is reached.
- [ ] **Step 4:** `phase-gate` and `README.md`: a short section with one example `command`
  check for a static analysis tool, and why it is preferred to a reviewer lens for what it
  covers. `fleetmates-config`: the `cost.stopAtBudget` key.
- [ ] **Step 5:** `CHANGELOG.md` under `## Unreleased` (`### Added`), and the passing-test count
  in `CONTRIBUTING.md`.
- [ ] **Step 6:** Run the skill tests that pin skill text and size, then lint, then the full
  root suite and the hostile-TMPDIR sweep once, as `.github/workflows/test.yml` runs them.
