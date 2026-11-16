# Skill context cuts

Spec: `docs/specs/2026-11-16-skill-context-cuts-design.md`.

## Global Constraints

- Node >= 24.2, zero dependencies
- Move text, do not reword or delete it; description lines are the one exception
- A cap that cannot be met by moving text is raised to the smallest size reached, and reported
- Commit messages: single line, commitlint style, English, no tool attribution
- No personal names, emails, usernames or real home paths in any file
- Every new test is shown to fail when the rule it covers is removed

## Destination

A session that works inline loads about 40% less skill text, with every rule still on disk and a
test that stops each core from growing back.

## Statement

Reduce token use. Cut all four: a leaner session start; the inline path skills (`grilling`,
`writing-plans`, `brainstorming`, `finishing-a-development-branch`) as a short core plus
references; the fleet-only skills (`fleet-supervision`, `fleet-lifecycle`) in the same form; and
shorter skill descriptions. Deliver it as its own pull request, before the brief and split-rule
change and before tickets. Only move text and lock the sizes with a test; when a core does not fit
its cap by moving alone, raise the cap and report it.

## Acceptance

- The text the session start hook injects is at most 4864 bytes.
- `SKILL.md` of `grilling`, `brainstorming` and `finishing-a-development-branch` is at most 6144
  bytes each, of `writing-plans` at most 7168, and of `fleet-supervision` and `fleet-lifecycle` at
  most 8192, or a raised cap is recorded with its reason.
- No sentence present in a split skill before the change is missing from that skill's `SKILL.md`
  plus `reference/` files after it.
- Every description is at most 160 characters and starts with `Use when`, or is listed as an
  exception with its reason.
- A test fails when a core grows past its cap, when a core names a reference that does not exist,
  and when a reference file is named by no core.
- `npm test` passes.

## Out of Scope

- Rewording or deleting rules — there is no eval that measures a change of behaviour.
- `executing-plans`, `test-driven-development`, `systematic-debugging`, `receiving-code-review`, `writing-skills`, `fleetmates-config` — each is under 9 KB and loaded only when used.
- The agent definitions under `agents/` — they are a teammate's system prompt and a fleet cost.
- Which events run the session start hook — the saving comes from the text, not the schedule.

### Task 1: size caps and reference wiring tests

**Files:**
- Modify: `tests/skills.test.mjs`

- [ ] **Step 1:** Add a `CAPS` table (skill name to byte cap for `SKILL.md`) holding the two skills that already have a core, `parallel-execution` and `phase-gate`, at 8192, and one test per entry that fails when the file is larger. If a cap test for those two exists already, extend it instead of adding a second.
- [ ] **Step 2:** Add a test that, for every skill with a `reference/` directory, every `reference/<file>.md` named in `SKILL.md` exists and every file in the directory is named in `SKILL.md`.
- [ ] **Step 3:** Mutation: lower one cap below the file's size, and name a missing reference in a scratch copy; watch both fail; restore with `git checkout`.

### Task 2: lean session start

**Files:**
- Modify: `skills/using-fleetmates/SKILL.md`
- Create: `skills/using-fleetmates/reference/fleet-or-solo.md`
- Modify: `tests/skill-entrypoint.test.mjs`
- Modify: `tests/hook.test.mjs`
- Modify: `tests/skills.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Move `### The fleet policy` and `### Presenting the choice` from `## Fleet or Solo` to `reference/fleet-or-solo.md`, unchanged. Keep the eligibility conditions in the core and add one sentence there telling the session to read the reference when a fleet is eligible.
- [ ] **Step 2:** Point the tests that pin the moved text at the skill's corpus. Pin in `SKILL.md` itself: the section list, and the sentences of the rule, the red flags and the non-negotiables.
- [ ] **Step 3:** Add a test that runs `hooks/session-start` and fails when the injected context is over 4864 bytes.
- [ ] **Step 4:** Mutation: paste the moved section back into the core and watch the size test fail; restore.

### Task 3: grilling core

**Files:**
- Modify: `skills/grilling/SKILL.md`
- Create: `skills/grilling/reference/asking.md`
- Create: `skills/grilling/reference/ledger.md`
- Create: `skills/grilling/reference/endings.md`
- Create: `skills/grilling/reference/red-flags.md`
- Modify: `tests/skill-grilling.test.mjs`
- Modify: `tests/skill-brainstorming.test.mjs`
- Modify: `tests/skills.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Keep in the core: when to use, the loop, the design tree, the rules of one turn, fact-finding, the three ledger buckets, the coverage sweep and the stop condition. Move, unchanged: the worked question example and the label notes to `asking.md`; the ledger example and the description of each bucket to `ledger.md`; `What is not grillable`, `Where this ends` and `Scope guard` to `endings.md`; `Red flags` to `red-flags.md`. Add `## When to read a reference` naming each file and its situation.
- [ ] **Step 2:** Point tests that pin moved text at the corpus; pin the core's section list and hard-rule sentences; add the 6144 cap.
- [ ] **Step 3:** Mutation: move the loop to a reference and watch the core test fail; restore.

### Task 4: writing-plans core

**Files:**
- Modify: `skills/writing-plans/SKILL.md`
- Create: `skills/writing-plans/reference/header-sections.md`
- Create: `skills/writing-plans/reference/protected-and-dropped.md`
- Create: `skills/writing-plans/reference/model-tier.md`
- Modify: `tests/skill-writing-plans.test.mjs`
- Modify: `tests/skill-contracts.test.mjs`
- Modify: `tests/skills.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Keep in the core: save location, global constraints, the header sections' example and the rules `init-run` refuses on, the task format, dependencies, the declared write set, the example plan, the self-check, task sizing and the self-review. Move, unchanged: the fog-or-task test, the entry rules and the rest of the header sections' discussion to `header-sections.md`; `Protected paths` and `Dropped tests` to `protected-and-dropped.md`; `Declaring a model tier` to `model-tier.md`. Add `## When to read a reference`.
- [ ] **Step 2:** Point tests at the corpus where text moved; pin the core's section list and hard-rule sentences; add the 7168 cap.
- [ ] **Step 3:** Mutation: move the task format to a reference and watch the core test fail; restore.

### Task 5: brainstorming core

**Files:**
- Modify: `skills/brainstorming/SKILL.md`
- Create: `skills/brainstorming/reference/process-flow.md`
- Create: `skills/brainstorming/reference/design-guidance.md`
- Modify: `tests/skill-brainstorming.test.mjs`
- Modify: `tests/skills.test.mjs`

**Depends:** T3

- [ ] **Step 1:** Keep in the core: the hard gate, the anti-pattern, the checklist, the process and what follows the design. Move, unchanged: the `Process Flow` graph to `process-flow.md`; the decomposition of a project too large for one spec, `Design for isolation and clarity` and `Working in existing codebases` to `design-guidance.md`. Add `## When to read a reference`.
- [ ] **Step 2:** Point tests at the corpus where text moved; pin the core's section list and hard-rule sentences; add the 6144 cap.
- [ ] **Step 3:** Mutation: move the checklist to a reference and watch the core test fail; restore.

### Task 6: finishing-a-development-branch core

**Files:**
- Modify: `skills/finishing-a-development-branch/SKILL.md`
- Create: `skills/finishing-a-development-branch/reference/cleanup.md`
- Create: `skills/finishing-a-development-branch/reference/remote-ci.md`
- Create: `skills/finishing-a-development-branch/reference/auto-merge.md`
- Modify: `tests/skill-finishing-branch.test.mjs`
- Modify: `tests/skill-contracts.test.mjs`
- Modify: `tests/skills.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Keep in the core: the completion gate, the branch taxonomy, surfacing unresolved findings and the integration options. Move, unchanged: `Worktree and branch cleanup` to `cleanup.md`, `Remote CI` to `remote-ci.md`, `Auto-merge` to `auto-merge.md`. Add `## When to read a reference`.
- [ ] **Step 2:** Point tests at the corpus where text moved; pin the core's section list and hard-rule sentences; add the 6144 cap.
- [ ] **Step 3:** Mutation: move the completion gate to a reference and watch the core test fail; restore.

### Task 7: fleet skills

**Files:**
- Modify: `skills/fleet-supervision/SKILL.md`
- Create: `skills/fleet-supervision/reference/watchdog.md`
- Create: `skills/fleet-supervision/reference/stalls.md`
- Modify: `tests/skills.test.mjs`
- Modify: `tests/skill-contracts.test.mjs`
- Modify: `tests/issue26-discipline.test.mjs`

**Depends:** T1

- [ ] **Step 1:** In `fleet-supervision`, move `The watchdog` to `watchdog.md` and `When a teammate stalls` to `stalls.md`, unchanged, and add `## When to read a reference`. `fleet-lifecycle` is already under 8192 bytes and gets only the cap.
- [ ] **Step 2:** Point tests at the corpus where text moved; pin the core's section list and hard-rule sentences; add both 8192 caps.
- [ ] **Step 3:** Mutation: move the digest section to a reference and watch the core test fail; restore.

### Task 8: descriptions

**Files:**
- Modify: `skills/grilling/SKILL.md`
- Modify: `skills/brainstorming/SKILL.md`
- Modify: `skills/receiving-code-review/SKILL.md`
- Modify: `skills/using-fleetmates/SKILL.md`
- Modify: `skills/writing-plans/SKILL.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/test-driven-development/SKILL.md`
- Modify: `tests/skills.test.mjs`

**Depends:** T2, T3, T4, T5

- [ ] **Step 1:** Shorten each description over 160 characters, keeping its `Use when` clause and every trigger phrase; drop only what restates the skill's contents.
- [ ] **Step 2:** Add a test that every description is at most 160 characters, with a named exception list that carries a reason per entry. Mutation: lengthen one and watch it fail; restore.

### Task 9: changelog and counts

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/specs/2026-11-16-skill-context-cuts-design.md`

**Depends:** T2, T3, T4, T5, T6, T7, T8

- [ ] **Step 1:** Add an `## Unreleased` entry with the measured sizes before and after. Record every raised cap in the spec with its reason.
- [ ] **Step 2:** Run `npm test` once, update the passing count in `CONTRIBUTING.md`, and run the lint and the hostile-tmpdir sweep that CI runs.
