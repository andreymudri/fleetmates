# Cost cuts for fleet runs: design

Status: approved by the owner on 2026-11-06. Item 2 (routing) is deferred, see the end.

## Why

An A/B eval measured fleetmates 2.8.0 against the same Claude Code without the plugin. Both arms
got the same frozen plan for 5 FeatureBench L1 tasks, with Opus 5.5 as the session model.

- Quality (fail-to-pass fraction) was identical on all 5 tasks.
- The fleet arm took 1.3x to 6.3x the wall time and cost 5x to 12x as much: USD 64.45 against
  USD 10.20 in total.

The fleet arm's cost broke down by role as follows:

| Role | Share | Evidence |
|---|---|---|
| Orchestrator (main session) | ~30% | 80 API calls on one task, median context 145k tokens, 11.2M context tokens read in total |
| Implementers | ~53% | Inferred: the Workflow-dispatched teammates do not appear in the stream, so this is the total minus the attributed share |
| Reviewers | ~17% | One `tm-reviewer` per lens per phase, on the capable tier |
| Integrator | ~0% | cheap tier |

Three things drove the orchestrator's share:

- **Skill bodies.** `parallel-execution` (31 KB) and `phase-gate` (33 KB) are loaded whole and
  re-read on every orchestrator call. About 13 KB of the two is needed on a typical run.
- **Wake-ups.** The orchestrator woke 7 to 23 times per run: watchdog start and idle exit, plus one
  wake-up per returning review lens.
- **Self-inspection.** The orchestrator read diffs and re-ran test suites itself, on top of the
  gate and the reviewers. That added 45k to 81k characters of shell output per run.
  `workflow` printed a 24k-character script into context.

The one quality failure in the eval came from the plan itself. Its Out of Scope section excluded
helpers the task needed, both arms followed the plan, and no gate noticed, because gates and
reviewers judge work against the plan.

## Goals

- Cut the orchestrator's and the reviewers' cost on a fleet run without weakening any enforcement
  invariant (CONTRIBUTING.md, "Changing the enforcement path").
- Measure it: the same 3 eval tasks, the fleet arm only, against the 2.8.0 numbers.

## Design

### 1. Skills: a short core plus on-demand references

- `skills/parallel-execution/SKILL.md` and `skills/phase-gate/SKILL.md` become a core of about 6 KB
  each. The core holds the steps every run executes, then a table of the form "when X happens,
  read `reference/<file>.md`".
- The rare-case sections move verbatim, headings included, into `skills/<name>/reference/*.md`.
  Examples: amending a plan mid-run, worktree and junction mechanics, a harness other than Claude
  Code, results-file refusal edge cases, platform and timing failures, and the rationale sections.
- Tests read a skill as one corpus: `SKILL.md` followed by its `reference/*.md` in name order. A
  sentence lock therefore follows its sentence wherever it lands. Corpus-inventory labels are
  re-locked to the new file names, and the sentence lists themselves do not change.
- New tests:
  - each of the two cores is at most 8 KB;
  - every reference file is named by its skill's core;
  - the cross-skill checks also scan `reference/*.md`: no relative `cli.mjs`, every cited CLI
    subcommand exists, every cited `tm-*` agent exists.
- `fleet-supervision` and `finishing-a-development-branch` are out of this change.

### 2. Review once per run, on the integrated diff

- An `agent` check gains `scope: "run" | "phase"`. When `scope` is absent it is treated as `"run"`.
  `scope` is validated with the other enforcement keys: tracked manifest only.
- **Phase gates.** `checksForPhase` leaves out agent checks whose effective scope is `run`. A phase
  gate is then the command checks plus `fileset`, `ownership` and the gate-computed `merge`.
  `scope: "phase"` restores today's behaviour for a manifest that wants it.
- **Run gate.** `finish` computes one more entry, named `run`, after the numbered phases. Its
  checks come from `phases.run.checks` when declared. Otherwise they come from `phases.default`:
  the command checks, the run-scoped agent checks and an injected `fileset-run` check.
  - `fileset-run` passes when every path changed in `merge-base(base, runTip)..runTip` is declared
    by some task of the plan at the anchor, or is under the manifest's protected rules. It is
    computed from git and the anchored plan only.
  - The run entry's supplied results arrive through `finish --results` under the reserved key
    `run`, beside the numeric keys.
  - The verdict stays `aggregateVerdict`'s, and a pending agent check stays a FAIL.
- **Review input.** `review-dispatch --phase run` and `collect-reviews --phase run` review the
  integrated diff `merge-base(base, runTip)..runTip`. The findings stamp names the run branch and
  its tip sha, so any later commit on the run branch makes the findings stale.
- **Lenses.** Lens resolution is unchanged: the declared `lens`, else the top-level `lens`, else
  `correctness, security, tests`, plus `portability` when CI runs on macOS or Windows. Nothing is
  skipped by size or by path.
- **Workflow path.** `workflow-profile` drops the per-phase review and collect steps and its
  requirement that every phase carry a mandatory agent check. Instead it requires a mandatory
  review for the run, and emits `review-run` and `collect-run` before `finish`. The controller
  builds the `run` entry of its finish results. Phases declared `scope: "phase"` keep their current
  steps.
- **Fix route.**
  - `fix --phase run --verdict <file>` adjudicates the run gate as `fix` does for a phase today.
    On `retry` it emits one fix task: id `fix-<n>`, branch `fleetmates/<run>/fix-<n>` cut from the
    run tip, the blocking findings as its brief, and a file set made of the paths those findings
    cite that some plan task declares.
  - A `tm-implementer` does the fix task. The `tm-integrator` merges it with `--no-ff`, staying the
    only writer of the run branch. Then `finish`, the run review and the run gate run again.
  - The round budget is the run entry's `fixRounds`, else `phases.default.fixRounds`, capped at 2.
    After that the decision is `escalate`.
  - A finding that cites only paths no plan task declares escalates at once.
- **Migration.** Existing manifests whose agent check has no `scope` move to run-level review.
  This repository's own `fleetmates.gate.json` is updated in the same change, under a
  `(protected)` plan marking.

### 3. A quieter orchestrator

- **Self-inspection rule.** The `parallel-execution` core states that the orchestrator does not
  review diffs and does not re-run the suites the gate runs. It reads CLI output and teammate
  results. The stated exception is investigating a FAIL verdict or a merge conflict.
- **Watchdog.** It emits only actionable events (a stalled or orphaned teammate, a watch error),
  plus `exit` on errors. The phase-idle exit is silent. The core says not to start it on the
  Workflow path, whose completion notification already wakes the orchestrator. It stays on the
  direct-Agent path, where it is the only stall signal.
- **`workflow --out <file>`** writes the generated script to the file and prints only the path and
  a one-line summary, so the script never enters the orchestrator's context.

### 4. A plan check before execution

The `parallel-execution` core, `executing-plans` and the self-review list in `writing-plans` gain
one step. Before `init-run`, or before the first task inline, re-read the task statement and
confirm two things:

- the Out of Scope section excludes nothing the statement requires;
- every task's dependencies exist in the plan.

This is prose guidance with no enforcement, and the skills say so.

## Testing

- Every behaviour change starts with a failing test, and each new test is checked by mutation, as
  CONTRIBUTING.md requires.
- The full suite stays green. CONTRIBUTING.md's expected count is updated to the new total.
- The adversarial tests and the enforcement invariants hold:
  - no check reads `.fleetmates/`;
  - `aggregateVerdict` is the only verdict producer;
  - pending counts as FAIL.

## Validation

- The external harness mounts this branch's plugin over the installed 2.8.0 inside its containers,
  then re-runs the fleet arm on the same 3 tasks with the same frozen plans.
- PASS requires three things:
  - the total cost is at least 30% below the 2.8.0 fleet arm's USD 34.57;
  - the fail-to-pass result is the same, 100% on the two tasks 2.8.0 solved;
  - this suite is green.
- Wall time is reported, with no threshold.

## Out of Scope

- Routing to inline by default, with a fleet only above a measured size threshold. Deferred until
  this change is measured: it is the lever on the implementers' share, and the eval forces the
  fleet path, so it cannot be measured there.
- Slimming `fleet-supervision` and `finishing-a-development-branch`. They were not loaded in the
  measured runs.
- Moving integration into the CLI. The integrator costs nothing measurable, and "the integrator is
  the only writer of the run branch" stays as is.
- Skipping review by diff size or touched paths. The owner chose to always review with
  correctness, security and tests.
- Implementer cost in general. The tiers, briefs and per-task fan-out are unchanged.

## Decision ledger

RESOLVED (owner, 2026-11-06)

- Scope: items 1, 3 and 4 now, and item 2 after validation.
- Validation: the fleet arm on 3 tasks, at most USD 44 of eval spend.
- Delivery: a pull request from `feat/cost-cuts`, with no merge and no release. If a PR is not
  possible, a local branch.
- Skills: a core plus `reference/`.
- Review: once per run by default, with `scope: "phase"` as an opt-in.
- Integration: the `tm-integrator` stays.
- Plan check: a prose step.
- Fix route for run findings: a fix task on a branch from the run tip, integrated by the
  `tm-integrator`, with at most 2 rounds and then escalation.
- Lenses: correctness, security and tests always, never skipped. Portability follows the existing
  CI-OS rule.
- Watchdog: actionable events only, and not started on the Workflow path.
- Orchestrator self-inspection: forbidden, except to investigate a FAIL or a conflict.
- Success criterion: at least 30% cheaper than 2.8.0, with the same fail-to-pass result.

DEFERRED

- Item 2, routing. Reopens once validation reports.
- Slimming `fleet-supervision` and `finishing-a-development-branch`. Reopens if a measured run
  shows them loaded.
