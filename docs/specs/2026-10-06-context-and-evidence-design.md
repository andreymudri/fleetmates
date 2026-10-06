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
