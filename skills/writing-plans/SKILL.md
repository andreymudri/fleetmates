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
that unjudgeable. This is the format's rule, defined in `scripts/plan-sections.mjs`; it is
refused at the moment a run is created once `init-run` wires that module in, which has not
happened yet — see below.

**The fog-or-task test**, and the rule the whole feature rests on — it turns on
dispatchability, not sharpness:

> Can you write it as a task — a declared file set, and acceptance criteria a green suite would
> satisfy? If yes, it is a task, even when it is blocked and cannot be worked yet. If no, it is
> Not Yet Specified, however sharply you can phrase the question.

The consequence: do not pre-slice fog into task-shaped pieces. One fog entry may graduate into
three tasks, or into none. A question can be perfectly sharp and still have nowhere to go —
sharpness is not the test, dispatchability is.

**The two entry rules, and what each is for:**

- Every `## Out of Scope` entry needs a reason clause — a separator (em dash, en dash, spaced
  hyphen, or spaced double hyphen) followed by at least one non-whitespace character. A reason
  clause is what makes a boundary reviewable; an entry without one is a word, not a decision.
- Every `## Not Yet Specified` entry must contain a `?` — anywhere in the entry, not necessarily
  at the end, so the question can carry the context that makes it worth reading. A question mark
  is what keeps fog from becoming a dumping ground for work nobody wanted to size.

**Nothing enforced reads these sections yet.** `scripts/plan-sections.mjs` defines the two entry
rules and the destination dependency above, and checks shape — a separator is present, a `?` is
present, a destination has prose — not truth. But no caller in `scripts/` imports
`parsePlanSections`: as of this writing `init-run` does not parse these sections, no check
consults them, no verdict depends on them, and no teammate is handed them. A plan can carry a
bare-noun Out of Scope entry or an unanswered fog entry today and nothing will refuse it. The
wiring that makes `init-run` enforce these rules at the moment a run is created is its own task;
until that lands, treat this section as the format's rules, not as something the CLI checks. Do
not write a sentence here or in a plan that implies otherwise.

**An `## Out of Scope` entry does not answer a reviewer's finding.** A finding relocated there
is still a finding, and moving it changes nothing about whether it is real. The mechanical rules
cannot catch this: a well-formed entry with a plausible reason is exactly what silencing a
finding would look like to a parser.

## Machine-readable task format

This plugin parses its own plans. `scripts/plan-parser.mjs` reads a `**Files:**` block under
each `### Task N: <title>` heading, and only three file-line forms are recognised:

- `- Create: \`path\``
- `- Modify: \`path\``
- `- Test: \`path\``

Any other bullet form is silently dropped, leaving the task with no declared files. Phase
assignment (`scripts/phases.mjs`) reads an empty file list as "conflicts with nothing" — so
every such task lands in phase 1 and its implementers edit the same files simultaneously.
Use the three forms exactly, one file per bullet.

## Dependencies are mandatory where they exist

A task that builds on another must carry `**Depends:** T1, T3`. Without it, the dependent
work is scheduled concurrently with the task it depends on, and a fleet will run them in
parallel worktrees regardless of what the prose says.

When a task has no dependencies, omit the **Depends:** line entirely — that is the intended
way to say "nothing." A sentinel like `**Depends:** none` is tolerated by the parser, but
omission is the documented form; don't rely on the sentinel.

## Declaring a model tier

A task may declare the model tier it should run at:

    **Model:** cheap

Valid values are `cheap`, `mid`, and `capable`. Omit the line and `init-run` infers a tier
from the task's shape — how many other tasks depend on it, how many files it declares, and
whether its brief already contains the code to write. Declare one only when you know the
inference would be wrong; an unrecognised value fails `init-run` with the offending task id.

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

## Self-review

Before handing the plan off, check:

- **Spec coverage** — every requirement in the spec maps to at least one task.
- **Placeholder scan** — no "TBD", "similar to Task N", or other stand-ins remain.
- **Type consistency** — the same field, function, or shape is described identically wherever
  it appears across tasks.
