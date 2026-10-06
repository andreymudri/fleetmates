# Bounded context and outcome evidence (#25 W02-W04, W07-W08)

## Context contract

A versioned context bundle preserves every mandatory item and selects optional
items in declared priority order within a UTF-8 byte budget. If mandatory items
exceed the budget, generation fails rather than dropping policy. Each item
has an identity, source path, line range, content hash, selection reason and
explicit mandatory/optional status. The bundle records its commit, role and
task identity. Text cannot grant permissions. Vault capability is explicit;
repo-only context is supported without a personal Vault.

Human-owned learnings are advisory. A tracked learning is only selected when
it matches a task-owned path or is declared global; a selector cannot promote
it into enforcement. No automatic learnings or Vault writes. Roles share the
same bundle contract, but integration and review context must include their
own acceptance and dependency contracts.

## Evidence contract

Acceptance evidence distinguishes pass, fail, unresolved and human-required.
Missing values remain null. Outcomes are tied to the exact input identity;
changing commit, plan, manifest, environment or verifier makes them stale.
Recorded command output is an observation, not proof a command executed.
Environment/infrastructure/flaky/configuration outcomes remain separate from
behavioral code failures. Reviewer outcomes retain confirmed, refuted,
duplicate, unreproduced and accepted distinctions. A changed patch alone does
not confirm a finding. Precision excludes unresolved judgments; recall needs
an independently labeled defect set. Local summaries contain no telemetry.

These primitives do not declare real-model workflow success or routing
improvements. W02 baseline trials, held-out evaluations and human outcome
labels remain required before measured promotion. W03 acceptance/dependency context integration and real selection evaluation,
W04 project verifier profiles and W07 authoritative plan amendment are
separate implementation obligations, not established by a pure bundle test.

## Provenance-preserving reviewer outcomes

`workflow-report` accepts an optional `reviewOutcomes` object with `findings`
and optional independent `labeledDefects`. Its input identity always comes
from the enclosing acceptance report, never from a nested override. Each
finding requires `id`, `identity`, `outcome`, a nonempty `rationale`, nonempty
`evidence` references and `provenance` containing `lens`, `category`, `model`
and `source`. Confirmed outcomes are declared observations; references do not
prove reproduction and must be independently evaluated before promotion.

A `duplicate` requires `duplicateOf` referencing another finding with the same
input identity. Chains resolve to their canonical finding; missing targets,
cycles, mixed-input links and duplicate IDs reject the report. Similar text
alone never creates a duplicate. Canonical groups preserve every observation
and its provenance, rationale and evidence references. Duplicates do not add
confirmed outcomes or increase recall. Stale findings are listed separately
and cannot contribute to current groups or metrics.

Metrics also break down by declared lens, category and model. These are
per-observation attribution summaries: a duplicate does not inherit the
canonical finding's confirmed status in a different lens. Unknown precision
and recall remain null. The mode is reporting only; no routing, mandatory
review policy or effort selection changes. Calibrated datasets and real
workflow evaluations remain outstanding.

## Node/TypeScript verifier profile and command outcomes

An optional `verifierProfile` in `workflow-report` declares `package`,
`platform` (linux, darwin or win32) and `required` script names (test by default).
The versioned Node/TypeScript profile reuses existing gate inference, including
runner-specific test inventory and focus guards, fileset/ownership checks and
agent review. It emits a proposed phase configuration and acceptance mappings,
never modifies a tracked manifest or runs a package command. Unsupported or
empty declarations fail early; missing required scripts make the profile not
ready. Script order and identity are reproducible independently of host CPU
scheduling hints. Project owners must review and track the proposal through
existing ownership rules. Profile readiness does not satisfy acceptance.

Actual command checks now attach a compact structured outcome. Exit zero is
success only when no timeout occurred. A timer expiration from the process
runner is explicitly timeout, including a process that exits zero while being
interrupted. Other nonzero exits remain unclassified: arbitrary stderr cannot
prove whether a failure is code, environment, infrastructure or flaky. The
report directs inspection before code changes, with no automatic retry or
relaxation of verification. These outcome hints never change mandatory gates.
Full semantic acceptance, stack-specific execution adapters, independent flaky
classification and retained full-log evidence remain separate obligations.

## Anchored acceptance and dependency context

Implementation briefs, workflows, reviewer prompts and integrator prompts now
select task contracts from the same committed plan anchor as global constraints.
A task opts into an acceptance contract with `**Acceptance:**` in its body.
The whole task section is mandatory context, preserving adjacent constraints,
filesets and verification commands rather than selecting an isolated sentence.
Explicit `**Depends:** T1` declarations select the dependency task's whole
contract. Cached task dependency fields and co-change history cannot add or
remove these anchored dependencies. Phase roles select the contracts for their
member task IDs. Unrelated tasks and plans with no acceptance/dependency
contracts retain the previous behavior.

Each item records the repository-relative plan path, exact source lines,
content hash and selection reason. Fenced headings do not create extra tasks
or terminate a contract. A missing declared dependency refuses generation.
Mandatory contract overflow also refuses dispatch; it cannot silently drop
acceptance criteria. Files must be tracked regular blobs, at most 512 KiB;
local or later run-branch edits do not replace the anchored source. Anchor
changes generate new bundle identities. Learnings remain separately advisory;
this feature cannot grant permissions or amend an authoritative plan.

## Explicit UI targets and reviewer preparation

A plan task can declare `ui: design/settings.html, design/settings.md`.
Targets are unique repository-relative Markdown, HTML or SVG paths, at most
20 per task. Empty declarations, traversal, absolute paths, controls and
unsupported types are refused. Fenced examples do not declare targets.
`init-run` requires every target to be a committed regular file in the current
branch before writing run state. Dispatch reads targets from the committed
plan anchor, never local or later run-branch edits. The project must commit its
plan and targets on its chosen base before dispatch as with existing plans.

Targets become mandatory bounded context with source paths, line ranges and
content hashes, along with their owning task contract. Required overflow or
missing anchor targets refuses dispatch. This does not grant permission to
execute HTML/SVG scripts or commands embedded in target text.

Projects can select the existing agent review lens `ui`. Its method requires
rendered evidence at the declared viewport/theme/state plus applicable
interaction, keyboard and accessibility evidence. Missing evidence must be
reported with `unableToVerify`, which existing collection keeps unresolved.
A source-level comparison or green build is not rendered verification. The
reviewer remains read-only on shared refs and uses only project-authorized
commands in a scratch worktree.

This delivery prepares and validates inputs. A native manifest `kind: ui`,
a project renderer adapter, artifact capture and independent visual/behavioral
trials remain outstanding. No actual rendering or model judgment is claimed
by the fixture tests, and no visual baseline is updated automatically.

## Exact-commit GitHub CI reporting

`ci-status --file <json>` reads `repository`, the existing five-field `inputs`
identity, and a nonempty `required` list of `{name, app}` check identities.
An optional task label remains declared attribution, not inferred ownership.
The adapter requires inputs.commit to match the current branch SHA, queries
GitHub check-runs using the installed/authenticated `gh` CLI with a 15-second
and 1 MiB response bound, and rechecks the branch tip after the query.
Repository/required identities are validated before network activity.

Only exact-commit checks from the named app count. The latest check ID for a
name/app is the current attempt; earlier attempts remain listed. Success
passes, active checks remain pending, failure/timeout/action-required fail,
and skipped/neutral/cancelled or absent results remain unresolved or missing.
A snapshot truncated beyond the API page cannot complete. Exit 0 means all
explicit required checks passed for that committed SHA; exit 4 means unmet
CI checks; exit 2 means invalid or unavailable input/capability.

The scope is the committed branch tip, not uncommitted workspace contents.
Plan, manifest, environment and verifier values are declared association only:
GitHub check metadata does not independently prove those input values. The
report exposes that limitation for each field. It does not turn a CI PASS into
semantic acceptance, independently classify a failure, repair code, publish,
merge or deploy. Full-input CI receipts, task repair budgets, log reproduction
and effect reconciliation remain outstanding W09 work.

## Reviewable feedback drafts

`feedback-draft --file <json>` prepares proposals from a committed plan at the
current branch tip. Input declares `runId`, ISO `date`, the five-field `inputs`
identity, `planPath` and nonempty `findings`. The plan content hash must match
inputs.plan; branch movement refuses the draft. Findings require unique `id`,
a single-line `title`, `type` (rule, decision, pitfall or defect), `description`,
nonempty affected `scope` and source `evidence` references. References remain
observations, not authenticated human approval or independent reproduction.

Defects also require explicit `files` and nonempty `acceptance` criteria.
Optional `dependsOnTasks` names existing task IDs and `dependsOnFindings`
names other proposed defects. No fileset is inferred from vague prose. New
IDs follow existing numeric task IDs; dependencies on all terminal existing
tasks place proposals after the existing plan. File overlap and explicit defect
dependencies use the current phase planner; cycles or unknown IDs refuse the
draft. Paths cannot name Git internals, run state, traversal or broad globs.
Description, evidence and acceptance strings are quoted JSON data so embedded
Markdown cannot introduce additional tasks or erase dependencies.

Learnings retain run/date/scope/type/source evidence with canonical owner
repo-learning and state proposed. The output is draft-only and requires review.
No plan, learning file, run state or Vault is written. Applying defects to the
authoritative anchor and committing reviewed learnings through ownership rules
remain explicit obligations, as do stale/superseded knowledge repair and Vault
approval. A generated proposal cannot claim amendment or completion.

All workflow JSON file inputs now use a fixed 1 MiB read bound on an opened
regular file. Available no-follow/nonblocking flags reject links and FIFOs;
size is checked both before and during the bounded read. Oversized or growing
input cannot make the parser drain unbounded data.
