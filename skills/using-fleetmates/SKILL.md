---
name: using-fleetmates
description: Use when starting any conversation or task - establishes how to find and use skills, and routes to the right process or fleet skill before anything else happens.
---

# Using Fleetmates

This is the entrypoint. Read it before doing anything else this session — including
answering a question, exploring the codebase, or checking a file.

## The Rule

**Invoke relevant skills BEFORE any response or action** — including clarifying
questions, exploring the codebase, or checking files.

Then announce "Using [skill] to [purpose]" and follow the skill exactly.

## Skill Priority

Process skills set the approach; implementation skills carry it out. When both
apply, the process skill goes first.

- "Let's build X" → `brainstorming` first, then implementation skills.
- "Fix this bug" → `systematic-debugging` first, then domain skills.

## Routing

| Situation | Skill |
|---|---|
| Exploring an idea, unclear requirements, before any design or plan | `brainstorming` |
| A plan or design has unresolved decisions, or the user asks to be grilled | `grilling` |
| Requirements are settled and a multi-step change needs a written plan | `writing-plans` |
| A written plan exists and there's a git repo with 3+ disjoint tasks — run a fleet | `parallel-execution` |
| A written plan exists but the work doesn't warrant a fleet — work it inline | `executing-plans` |
| A bug, test failure, or unexpected behavior, before proposing a fix | `systematic-debugging` |
| Implementing any feature or bugfix, before writing implementation code | `test-driven-development` |
| Feedback came back on your work, before acting on it | `receiving-code-review` |
| Implementation is complete and all tests pass — decide how to integrate | `finishing-a-development-branch` |
| Creating or editing a skill, or verifying one works before deployment | `writing-skills` |
| Spawn, list, message, scale, stop, or resume teammates in a running fleet | `fleet-lifecycle` |
| Changing how the fleet runs — parallelism, model tier or effort per role, caveman output | `fleetmates-config` |
| A fleet phase finished and needs a verdict before the next phase starts | `phase-gate` |
| Want to know what a running fleet is doing right now | `fleet-supervision` |
| Work that outlives this session, or the user names a ticket | `tickets` |

## Fleet or Solo

A fleet is **eligible** when all of these hold:

- There is a written plan (or one can be written first).
- The plan has three or more tasks that touch disjoint files.
- The repo is a git repo — worktree isolation depends on it.
- Each task is a real boundary: parallel output, a real prerequisite, or independent review.

If any fails, take the inline path (`executing-plans`) and say why in one line. A two-task
change costs more to orchestrate as a fleet than to just do.

When all of them hold, read `<fleetmates root>/skills/using-fleetmates/reference/fleet-or-solo.md`
before choosing how the plan is executed: it holds the fleet policy and how to present the choice.

## Red Flags

These thoughts mean STOP — you're rationalizing your way out of a skill check:

| Thought | Reality |
|---|---|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |

## Invoking the CLI

`<fleetmates root>` is where this plugin is installed: it is `$CLAUDE_PLUGIN_ROOT` when that
variable is set (Claude Code), otherwise the directory two levels above this skill's own
`SKILL.md` (`dirname(dirname(<this skill's dir>))`). `--root` is always the user's project repo.
They are never the same directory. Every CLI call in every skill uses both:

    node "<fleetmates root>/scripts/cli.mjs" <subcommand> --root <project root> ...

Invoking the CLI by a relative path fails as soon as the working directory
isn't the plugin's own — which, installed via `/plugin`, it never is.

## Non-negotiables

- No teammate ever touches the main worktree. Only `tm-integrator` writes to the run branch.
- Nothing is reported done without a recorded gate PASS.
- All run state lives in `.fleetmates/<run-id>/`, never only in an agent's head.

## When to read a reference

| Situation | Read |
|---|---|
| A fleet is eligible: the fleet policy, and presenting the fleet-or-inline choice | `reference/fleet-or-solo.md` |
