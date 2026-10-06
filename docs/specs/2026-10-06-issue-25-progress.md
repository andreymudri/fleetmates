# Issue 25 implementation status

This branch delivers independently testable local primitives. It does not
close the parent roadmap or claim real-model evaluation outcomes.

| Workstream | Implemented here | Remaining obligation |
| --- | --- | --- |
| W01 | Explicit session binding, bounded Stop guard, suspension/resume/abandon refs, finish refusal, digest/doctor interruption reporting | Live callback capture; broader completion identity and execution-state contracts |
| W02 | Exact input identity and local acceptance/reviewer summaries | Curated dataset, repeated real workflows, independent outcomes, held-out baseline and resource metrics |
| W03 | Versioned bounded bundles, anchored human learnings and explicit acceptance/dependency contracts in implementation/review/integration prompts, hashes, source lines and mandatory preservation | Vault selection, review evidence invalidation and observed selection quality |
| W04 | Acceptance-to-current-evidence mapping; human-required and unresolved states; reviewable versioned Node/TypeScript profile; actual command timeout metadata with conservative unknown failure status; private retained output logs with content hashes, compact summaries and explicit incomplete capture | Further stack profiles, execution adapters, durable evidence retention and independent code/environment/infrastructure/flaky classification |
| W05 | Git-computed test-change policy with declared exceptions and honest temporal/coverage limits | Independent behavioral red/green execution and richer ordering evidence |
| W06 | Explicit ui target parsing, committed-target init preflight, anchored mandatory target bundles and ui reviewer method requiring rendering/behavioral evidence | Native ui manifest kind, project renderer/artifact adapter, independent rendered/behavioral/accessibility evidence |
| W07 | Scoped human learning selection; no automatic knowledge writes; current-plan feedback drafts with explicit scoped evidence, typed learning proposals and bounded defect tasks/dependencies | Owned learning commits, reviewed application to authoritative plan anchors, knowledge refresh and stale/superseded repairs |
| W08 | Local outcome counts, precision excluding unresolved findings, recall requiring independent labels; provenance-preserving duplicate groups and per-lens/category/model reports tied to current inputs | Calibrated real reviewer datasets, independent reproduction, refutation quality and shadow selection |
| W09 | Bounded read-only GitHub CI adapter, exact SHA and explicit required app/check identities, latest attempt and unresolved status reporting | Full-input receipts, failure reproduction, bounded task repairs, publication idempotency and reconciliation |
| W10 | Five versioned dry-run profiles on existing CLI fragments, phase/artifact contracts, explicit capability blockers, tracked repair-budget limits | Execution controller, stdout capture, review aggregation, actual capability probing/wall-time enforcement and real evaluation |
| W11 | Immutable bounded local metadata journal in common Git storage, input/branch reconciliation, unknown-effect reporting and persisted-recorder crash fixture | Driver integration, checkout/artifact recovery, external outcome queries, resolution/resume adapters, retention and real driver/daemon trials |
| W12-W13 | Codex/Cursor read-only authentication probes bounded to 5 seconds plus 250 ms cleanup and 64 KiB output; bounded workflow JSON reads | Broader environment preflight, separate capability contracts and role enforcement |
| W14-W15 | Conditional later scope | Bottleneck evidence and an explicit release requirement |

## Local commands

Command checks retain raw output in private temporary files outside previews,
up to 16 MiB per command. Results reference the file and retained-content hash;
successful summaries remain empty and failure tails stay bounded. Truncation,
storage errors and timeout capture remain incomplete and cannot pass a check.
These files may contain sensitive diagnostics and require operator cleanup.
They are temporary local observations, not durable or full-input CI receipts.

Local Linux verification covers eleven command-log tests, each observed failing
under a targeted implementation mutation and passing after restoration. Cases
include exact raw output and hashes, preview removal, buffered and streamed
executors, truncation, timeout, executor exceptions, write/create/close failures,
binary diagnostic bounds and executor output limits. The full root and hub
command checks and instruction security lint passed. Inline correctness,
security, tests and claims review found no blocking findings. This verification
does not establish Windows behavior or independent real-model outcomes.

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

## Bounded authentication preflight

Codex login status and Cursor status run without a shell or model turn. Each
probe allows five seconds and 64 KiB of combined output, followed by at most
250 ms of process-group cleanup. Crossing either limit refuses dispatch, even
if the command subsequently exits successfully. The existing gate runner owns
process-group retirement and escalation. Windows retains the runner's existing
limitation for descendants that outlive their direct parent. These checks do
not establish role capabilities, sandbox isolation or external service health.
