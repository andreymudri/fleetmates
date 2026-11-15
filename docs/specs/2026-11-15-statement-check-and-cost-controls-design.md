# Statement check, review depth, budget stop and static checks: design

Status: approved by the owner on 2026-11-15.

## Why

The A/B eval of 2026-11-06 (see `2026-11-06-cost-cuts-design.md`) left two findings open.

- **Gates judge the work against the plan, never the plan against the request.** On one task the
  plan put out of scope helpers the task needed. Both arms failed the same way and no gate or
  reviewer reported it. The only guard today is a prose "statement check" in `writing-plans` and
  `executing-plans`, which the author of the plan performs on their own plan.
- **The fleet arm cost 5x to 12x as much.** Every phase gets the same reviewer lenses whatever
  the size of the change, and `cost.budget` only prints a warning.

Four changes follow. They are independent and land as separate commits.

## 1. Statement check

### Plan format

Two optional header sections join `## Destination`, `## Not Yet Specified` and `## Out of Scope`:

- `## Statement`: prose. The request the plan was written from, verbatim.
- `## Acceptance`: bullets. What must be true of the finished work, taken from the statement and
  not from the plan's tasks.

`scripts/plan-sections.mjs` parses both. `parsePlanSections` returns `statement` (collapsed
prose or `null`) and `acceptance` (entries with text and line).

### Rule enforced at `init-run`

A plan with an `## Out of Scope` heading must carry a `## Statement` with prose and an
`## Acceptance` with at least one entry. This mirrors the existing Destination rule: a boundary
can only be judged against what was asked. The two new defects are `missing-statement` and
`missing-acceptance`, both document-level, refused with exit 2 by the same path that refuses a
missing Destination. `rebuild-state` degrades on them the way it does on the existing defects.

A plan without Out of Scope is not affected, so existing plans without that section still start.

### The check

A new command prints one reviewer prompt:

    cli.mjs plan-check --plan <path> [--root <path>]

- It reads the plan from the working tree, refuses a plan with a section defect, and refuses a
  plan that has no Statement (there is nothing to compare).
- The prompt assigns the lens `statement`. The reviewer reads only the plan. It reports each
  requirement in the Statement or Acceptance that an Out of Scope entry excludes, that no task
  covers, or that depends on a task the plan does not contain. Findings use the reviewer's
  existing severity scale; a dropped requirement is `high`.
- The command writes nothing and dispatches nothing. The orchestrator hands the prompt to one
  `tm-reviewer`, in the inline path and in a fleet alike, before the first task starts.

The check is run by a fresh reviewer because the session that wrote the plan is the reader that
made the mistake in the eval.

### Acceptance in the final review

`scripts/review-gen.mjs` adds the plan's Acceptance entries to the spec-compliance stage of every
reviewer prompt, when the plan has them. The finished diff is then judged against the request's
criteria as well as the task specs.

### Skills

- `writing-plans`: documents the two sections and the new rule, tells the author to run
  `plan-check`, and corrects the paragraph that says nothing enforces the header sections
  (`init-run` and `rebuild-state` have parsed them for some time).
- `executing-plans`: step 2 runs `plan-check` through one reviewer instead of a self-check.
- `parallel-execution`: runs `plan-check` once, before phase 1.

## 2. Review depth (advisory)

    cli.mjs review-depth [--base <branch>] [--root <path>] [--json]

The command measures the diff between the base and the working branch: changed files, changed
lines, and the coupled files outside the diff that the existing map (`scripts/codemap.mjs`)
reports. It prints the numbers and one suggestion:

| Suggestion | Default rule |
|---|---|
| `tests-only` | at most 3 files and 60 changed lines, and no coupled file outside the diff |
| `two-lenses` (`correctness`, `tests`) | anything between |
| `all-lenses` | more than 15 files or 600 changed lines |

It never fails anything: the exit code is 0 for every suggestion, and no gate reads it. That
keeps the map's standing rule that a map able to fail a phase is a map worth gaming.
`executing-plans` uses the suggestion to size the inline final review. The fleet gate keeps the
lenses its manifest declares.

A file outside the diff counts as coupled when it changed in at least half of the commits that
touched a file of the diff. Without that floor, one shared commit in a long history would make
every change to an old file look coupled.

The thresholds are defaults chosen without measurement. They are deferred: reopen them after the
command has been used on ten real changes.

## 3. Budget stop (opt-in)

A new key, `cost.stopAtBudget`, boolean, default `false`. Like the rest of `cost`, both config
layers may carry it. `stopAtBudget: true` without a `cost.budget` and at least one entry in
`cost.prices` is a configuration error, because the stop could never trigger. It is reported by
`dispatch` and `workflow` (exit 2) and not while the config is resolved: the three keys may sit
in different layers, and refusing at resolution would make every command fail, `config set`
included, until the layers agreed.

When it is on, `dispatch` and `workflow` price the current session's usage (the computation
`usage` already does) before starting teammates:

- If the priced total has reached the budget, the command starts nothing, prints the total, the
  budget and the number of unpriced agents, and exits 1: the command ran and declined, which is
  not a malformed invocation (2) or a failed verification (4).
- Unpriced agents are not counted. The message says so, because the total is a lower bound.
- If the session's usage cannot be read, the command proceeds and prints that the budget could
  not be checked. A missing transcript store must not halt a run.
- Teammates already running are not touched.

With the key off or absent, behaviour is exactly as today: the budget warns in `usage` only.

## 4. Static checks (documentation)

Complexity, duplication and dead-code tools are ordinary `command` checks. The `phase-gate` skill
and the README get a short section with an example manifest entry and the reason to prefer them
over a reviewer lens for what they cover: they are deterministic and cost no model call. Nothing
changes in this repository's own `fleetmates.gate.json`, and no dependency is added.

## Testing

Each rule gets a test that is shown to fail when the rule is removed:

- the two new section defects, and that a plan without Out of Scope is untouched;
- `plan-check` refusals and the content of the prompt;
- Acceptance entries reaching the reviewer prompt, and their absence when the plan has none;
- each `review-depth` suggestion at its boundary, and exit code 0 for all three;
- `cost.stopAtBudget` validation; dispatch refused at the budget, allowed below it, allowed with
  the key off, and allowed when usage cannot be read.

## Out of scope

- Enforcing review depth in the gate: it would reverse the map's documented rule.
- A built-in static analysis check: one language only, and a design of its own.
- Stopping teammates that are already running when the budget is reached.
- Ingest, triage, deploy and observability stages: fleetmates executes a written plan.
