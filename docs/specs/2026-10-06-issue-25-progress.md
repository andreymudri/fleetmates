# Issue 25 implementation status

This branch delivers independently testable local primitives. It does not
close the parent roadmap or claim real-model evaluation outcomes.

| Workstream | Implemented here | Remaining obligation |
| --- | --- | --- |
| W01 | Explicit session binding, bounded Stop guard, suspension/resume/abandon refs, finish refusal, digest/doctor interruption reporting | Live callback capture; broader completion identity and execution-state contracts |
| W02 | Exact input identity and local acceptance/reviewer summaries | Curated dataset, repeated real workflows, independent outcomes, held-out baseline and resource metrics |
| W03 | Versioned bounded bundles, anchored human learnings and explicit acceptance/dependency contracts in implementation/review/integration prompts, hashes, source lines and mandatory preservation | Vault selection, review evidence invalidation and observed selection quality |
| W04 | Acceptance-to-current-evidence mapping; human-required and unresolved states; reviewable versioned Node/TypeScript profile; actual command timeout metadata with conservative unknown failure status | Further stack profiles, execution adapters, retained full logs and independent code/environment/infrastructure/flaky classification |
| W05 | Git-computed test-change policy with declared exceptions and honest temporal/coverage limits | Independent behavioral red/green execution and richer ordering evidence |
| W06 | Explicit ui target parsing, committed-target init preflight, anchored mandatory target bundles and ui reviewer method requiring rendering/behavioral evidence | Native ui manifest kind, project renderer/artifact adapter, independent rendered/behavioral/accessibility evidence |
| W07 | Scoped human learning selection; no automatic knowledge writes; current-plan feedback drafts with explicit scoped evidence, typed learning proposals and bounded defect tasks/dependencies | Owned learning commits, reviewed application to authoritative plan anchors, knowledge refresh and stale/superseded repairs |
| W08 | Local outcome counts, precision excluding unresolved findings, recall requiring independent labels; provenance-preserving duplicate groups and per-lens/category/model reports tied to current inputs | Calibrated real reviewer datasets, independent reproduction, refutation quality and shadow selection |
| W09 | Bounded read-only GitHub CI adapter, exact SHA and explicit required app/check identities, latest attempt and unresolved status reporting | Full-input receipts, failure reproduction, bounded task repairs, publication idempotency and reconciliation |
| W10 | Five versioned dry-run profiles on existing CLI fragments, phase/artifact contracts, explicit capability blockers, tracked repair-budget limits | Execution controller, stdout capture, review aggregation, actual capability probing/wall-time enforcement and real evaluation |
| W11 | Immutable bounded local metadata journal in common Git storage, input/branch reconciliation, unknown-effect reporting and persisted-recorder crash fixture | Driver integration, checkout/artifact recovery, external outcome queries, resolution/resume adapters, retention and real driver/daemon trials |
| W12-W13 | No implementation claim | Separate bounded specs, environment preflight and role capabilities |
| W14-W15 | Conditional later scope | Bottleneck evidence and an explicit release requirement |

## Local commands

`bind-session`, `suspend`, `resume`, `abandon` and `run-status` are described in
README. Session bindings and lifecycle refs are local observations. They do
not authenticate the operator and cannot turn skipped checks into completion.

`context-bundle --file <json>` reads `task`, `role`, `commit`, `maxBytes`,
`vault` and `items`. Each item declares `id`, `text`, `source`, `startLine`,
`endLine`, `reason` and `mandatory`. Optional order is the declared selection
priority. The budget measures text UTF-8 bytes, not tokenizer output or total
serialized metadata. Mandatory overflow is a refusal. The Vault status is
explicit; `required-missing` refuses the bundle. These are advisory data.

`workflow-report --file <json>` reads `inputs`, `requirements`, `evidence`,
optional `findings` and optional independently established `labeledDefects`.
Inputs name commit, plan, manifest, environment and verifier versions/hashes.
Requirements declare an id and deterministic/judgment/human evidence kind.
Evidence carries requirement, kind, status, matching input identity and a
full log path. Exit 4 means unmet acceptance; exit 2 means malformed input.
A report supplied by an agent is an observation, not independent execution
proof. Passing a build cannot satisfy an undeclared or human-only criterion.

An optional manifest check `{ "name": "test-policy", "kind": "tdd" }`
uses common Node test/spec globs. Projects can declare `tests.match` and
exact-path exceptions with `reason` and `evidence`. Neither a test edit nor
an exception proves coverage. Existing inventory and ownership checks remain
required. Unmeasurable integrated task diffs stay pending.

## Human learning selection

Human-owned `fleetmates.learnings.md` is read from the same committed plan
anchor as mandatory plan constraints. Implementation briefs, generated
workflows, reviewer prompts and integrator prompts receive advisory JSON
bundles when the file exists. No guidance file is created or rewritten.

An entry header can be `## YYYY-MM-DD run: <id> scope: src/**,lib/**`.
Omitting scope means global. Global entries and a file preface are preserved;
scoped entries are selected against the task or phase's owned paths. Older
free-form guidance is preserved as global advisory context. Mandatory budget
overflow refuses dispatch and asks the owner to condense guidance. Optional
omissions are recorded. The absence of a Vault is explicit. This selector
has fixture-backed behavior, not a measured claim of improved model outcomes.
