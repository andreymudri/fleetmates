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
