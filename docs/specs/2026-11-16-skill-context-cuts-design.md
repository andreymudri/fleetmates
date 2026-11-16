# Skill context cuts: design

Status: design answers given by the owner on 2026-11-16; this document awaits the owner's review.

This is the first of three changes designed together. The other two are
`2026-11-16-brief-context-and-split-rule-design.md` and `2026-11-16-tickets-design.md`. Each lands
as its own pull request, in that order.

## Why

The cost cuts of 2026-11-06 (`2026-11-06-cost-cuts-design.md`) shortened the two fleet skills and
left the rest as it was. A session that works inline, which is the path the eval of that date
found cheaper, pays for text it does not use:

| Text | Size today | When it is charged |
|---|---|---|
| Session start hook: all of `using-fleetmates` | 7.0 KB | Every start, resume, clear, compaction and fork |
| `brainstorming`, `grilling`, `writing-plans`, `executing-plans`, `finishing-a-development-branch` | 50 KB | Once per feature, and again after each compaction, because loaded skills are attached again |
| `fleet-supervision`, `fleet-lifecycle` | 23 KB | Fleet runs only |
| The description line of 15 skills | 2.4 KB | Every session, in the skill list |

About half of `using-fleetmates` is the fleet-or-inline choice: the policy, the preview and the
trade-offs. It is needed only when a fleet is eligible.

## Method

**Move, do not delete.** No rule is removed and no sentence that stays in a core is reworded. Text
leaves `SKILL.md` for a file under the skill's `reference/` directory, and the core names that
file at the point where its situation comes up. This is the form `parallel-execution` and
`phase-gate` already have.

The one exception is the description lines (section 4), which cannot be moved and are shortened.

There is no eval that measures whether a shorter skill changes what a session does. The method is
chosen for that reason: a moved rule can still be read, and a size test keeps the cores from
growing back.

## 1. Session start

`using-fleetmates/SKILL.md` keeps what every session needs: the rule, the skill priority, the
routing table, the red flags, how to invoke the CLI, and the non-negotiables. The section
`Fleet or Solo`, with the fleet policy and the presentation of the choice, moves to
`skills/using-fleetmates/reference/fleet-or-solo.md`. The core keeps one short paragraph: the
three eligibility conditions, and the instruction to read the reference before choosing how a
written plan is executed.

`hooks/session-start` is unchanged: it injects `SKILL.md`, which is now shorter.

Cap: the text the hook injects is at most 4 KB.

## 2. Inline path skills

| Skill | Today | Cap for `SKILL.md` |
|---|---|---|
| `grilling` | 11.1 KB | 6 KB |
| `writing-plans` | 11.6 KB | 7 KB |
| `brainstorming` | 8.8 KB | 6 KB |
| `finishing-a-development-branch` | 14.4 KB | 6 KB |

`executing-plans` (4.4 KB) is not changed. With these caps a full feature flow loads at most
29.4 KB, against 50 KB today.

What stays in each core is what every use of the skill needs: its steps in order, its hard rules,
and the list of references with the situation that calls for each. What moves is worked examples,
red-flag tables, and sections for a case that most uses do not meet (for example protected paths
and dropped tests in `writing-plans`, or remote CI and auto-merge in
`finishing-a-development-branch`). The plan lists the destination of every section.

`writing-plans` has a higher cap because the task format it defines is needed by every plan.

## 3. Fleet skills

`fleet-supervision` (16.0 KB) and `fleet-lifecycle` (7.4 KB) take the same form, with the 8 KB cap
that `parallel-execution` and `phase-gate` already have.

## 4. Descriptions

Each description keeps its `Use when` clause, which is what decides whether the skill is chosen,
and drops what follows it when the rest only restates the skill's contents. Cap: 160 characters.
Five descriptions are over it today; `grilling` is the longest at 233.

This is the smallest saving of the four, and the only change here that rewords text a session acts
on. If a description cannot be shortened without losing a trigger, it stays as it is and the cap
lists it as an exception with the reason.

## Testing

- A size test for every core named above and for the hook's injected text, in the form of the
  existing 8 KB test. Mutation: add text past the cap and watch it fail.
- For each skill split here, a test that pins the core's section list and its hard-rule sentences,
  as `tests/skills.test.mjs` does for `parallel-execution` and `phase-gate`, so an every-use rule
  cannot move to a reference unnoticed.
- A test that every reference file a core names exists, and that every file under a `reference/`
  directory is named by its core.
- Existing tests that read a skill as one corpus (`SKILL.md` plus references) keep their pinned
  sentences wherever the text lands. Tests that pin a core's digest or headings are updated on
  purpose, each in the commit that moves the text.
- The packaging tests must show the new reference files in the published package.

## Out of scope

- Rewording or deleting rules: a change of behaviour without a way to measure it.
- `executing-plans`, `test-driven-development`, `systematic-debugging`, `receiving-code-review`,
  `writing-skills`, `fleetmates-config`: each is under 9 KB and loaded only when used.
- The agent definitions under `agents/`: they are a teammate's system prompt, and a fleet cost.
- Changing which events run the session start hook.

## Deferred

- Whether the cuts change behaviour. Reopen if a session skips a step whose text moved to a
  reference; the fix is to move that text back and raise the cap, not to reword it.
