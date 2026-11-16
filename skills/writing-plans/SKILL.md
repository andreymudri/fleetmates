---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code - produces a plan this plugin can parse, phase, and dispatch to a fleet.
---

# Writing Plans

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

## Save location

Save the plan to `docs/plans/YYYY-MM-DD-<feature-name>.md`.

## Global Constraints

Every plan needs a **Global Constraints** section in its header, before the first task — the
project-wide requirements every task inherits: version floors, dependency limits, naming
conventions, commit-message style, anything a task shouldn't have to restate. One line per
constraint, with the exact value, not a vague pointer:

```markdown
## Global Constraints

- Node >= 20
- Zero new runtime dependencies
- Commit messages: single-line, commitlint style, English
```

A task's own requirements are on top of this, not instead of it — every task implicitly
carries the Global Constraints too. That's why `parallel-execution` dispatch hands each
implementer the global constraints alongside its task brief: they're plan-wide, not
per-task, so nothing downstream has to look them up separately.

## Destination, fog, and out-of-scope

Three more optional header sections, alongside `## Global Constraints`, before the first task:

```markdown
## Destination

The gate can answer "is this run landable" without an operator reading any prose.

## Not Yet Specified

- How should finish report a phase whose reviewers disagreed?
- Does the map's coupling data belong in the gate at all?

## Out of Scope

- Replacing `.fleetmates/` with a real datastore — swapping it invalidates every check that
  reads it, and the coordination store is not what this destination is about.
```

All three are optional. `## Out of Scope` requires a `## Destination` with prose under it in
the same document — an empty `## Destination` heading is treated exactly like an absent one,
because "out of scope" means beyond the destination, and a heading with nothing under it leaves
that unjudgeable. This is the format's rule, defined in `scripts/plan-sections.mjs`, and
`init-run` refuses a plan that breaks it — see below.

### Statement and Acceptance

Two more header sections record what was asked, so the plan can be checked against it:

```markdown
## Statement

Make the usage report show cost per agent, and warn when a run passes its budget.

## Acceptance

- The report prints a cost for every agent whose model has a price
- A run past its budget prints a warning and still exits 0
```

`## Statement` is the request as it was made, in prose, copied rather than summarised.
`## Acceptance` lists what must be true of the finished work, taken from the statement and not
from the tasks: a criterion derived from a task only restates the plan.

**A plan with `## Out of Scope` must carry both**: a `## Statement` with prose and an
`## Acceptance` with at least one entry. Gates and reviewers judge the work against the plan, so
a plan that excludes something the request needs passes every one of them; the boundary can only
be judged against the request. A plan without `## Out of Scope` may omit both.

Before execution, have one fresh reviewer read the plan against its statement:

    node "<fleetmates root>/scripts/cli.mjs" plan-check --plan docs/plans/<file>.md --root <project root>

It prints one `tm-reviewer` prompt with the lens `statement` and does nothing else. Dispatch that
reviewer and resolve its `high` findings in the plan before the first task starts. The reviewer
is fresh on purpose: the session that wrote the plan reads its own Out of Scope entry as the
decision it remembers making.

What separates a Not Yet Specified entry from a task, the two entry rules, and what enforces
the header sections are in `reference/header-sections.md`.

## Machine-readable task format

This plugin parses its own plans. `scripts/plan-parser.mjs` reads a `**Files:**` block under
each `### Task N: <title>` heading, and only three file-line forms are recognised:

- `- Create: \`path\``
- `- Modify: \`path\``
- `- Test: \`path\``

A line inside a `**Files:**` block that is shaped like a file line — `- Word: \`…\`` or
`- Word (…): \`…\`` — but is not exactly one of the recognised forms makes `init-run` refuse the
plan, naming the line, and every later command that reads the plan refuses it the same way. A misspelled verb or trailing text after the path used to drop the file
silently, and phase assignment (`scripts/phases.mjs`) reads an empty file list as "conflicts with
nothing", landing the task in phase 1 beside everything else. Use the forms exactly, one file per
bullet.

A task that changes a path the gate protects, or that drops a test, marks the file line: see
`reference/protected-and-dropped.md`.

## Dependencies are mandatory where they exist

A task that builds on another must carry `**Depends:** T1, T3`. Without it, the dependent
work is scheduled concurrently with the task it depends on, and a fleet will run them in
parallel worktrees regardless of what the prose says.

When a task has no dependencies, omit the **Depends:** line entirely — that is the intended
way to say "nothing." A sentinel like `**Depends:** none` is tolerated by the parser, but
omission is the documented form; don't rely on the sentinel.

## Declared files are the enforced write set

An implementer may only create or modify the files its task declares. This is the permitted
write set for that task — a stray path outside it is caught at merge and fails the phase gate.

## The example plan

<!-- example-plan -->
```markdown
### Task 1: add user model

**Files:**
- Create: `src/models/user.mjs`
- Test: `tests/user.test.mjs`

- [ ] **Step 1:** Define the `User` class with `id`, `email`, `createdAt`.

### Task 2: add user repository

**Files:**
- Create: `src/repositories/user-repository.mjs`
- Modify: `src/models/user.mjs`
- Test: `tests/user-repository.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Implement `findById` and `save` backed by an in-memory map.
```

## Self-check before dispatch

Before handing a plan to a fleet, run it through the parser and phase assigner yourself:

```
node "<fleetmates root>/scripts/cli.mjs" init-run docs/plans/<file>.md --run plancheck --root <project root>
```

Read the printed phase breakdown and confirm it matches intent — tasks that should run
sequentially must not land in the same phase. Then remove the scratch run directory; it was
only for this check, not for the real run.

## Task right-sizing, bite-sized steps, no placeholders

Match the discipline this plan itself follows: each task should be sized so one implementer
can finish it without touching another task's files. Each step is one action. Code steps carry
actual code, not a description of code. Never write "TBD" or "similar to Task N" — write out
the content, even if it repeats a pattern from an earlier task.

A plan's steps, files and phases do not each need a task. One owner end to end is the default;
split a task off only at a real boundary: independent parallel output, a real prerequisite of
another task, or work that needs an independent review.

## Self-review

Before handing the plan off, check:

- **Spec coverage** — every requirement in the spec maps to at least one task.
- **Placeholder scan** — no "TBD", "similar to Task N", or other stand-ins remain.
- **Type consistency** — the same field, function, or shape is described identically wherever
  it appears across tasks.
- **Statement check** — run `plan-check` and give the prompt it prints to one `tm-reviewer`, then
  fix its high findings in the plan (see "Statement and Acceptance" above). Nothing else reads the
  plan against its statement: gates and reviewers judge the work against the plan, so a plan that
  leaves out what the statement requires passes every gate. Do not do this check yourself in the
  reviewer's place: you are the reader who wrote the plan.

## When to read a reference

| Situation | Read |
|---|---|
| Writing Not Yet Specified or Out of Scope entries, or `init-run` refused a header section | `reference/header-sections.md` |
| A task changes a protected path, or deletes, renames or stops running a test | `reference/protected-and-dropped.md` |
| A task should run at a model tier other than the inferred one | `reference/model-tier.md` |
