# Bounded profile execution and recoverable attempts

## Destination

Execute the five existing fixed workflow profiles through current CLI and
harness adapters, retaining validated outputs and finite budgets. A resumed
attempt reconciles actual inputs, refs and artifacts before reuse. Completion
reports enumerate current obligations instead of accepting a status string.
This is the second group of the approved open-issues delivery design, covering
issues 42, 43 and the executable portion of 33, with the two confirmed
prerequisite findings under 44/45 repaired before their workflow consumers.

## Global Constraints

- Node >= 24.2.0; zero new core runtime or development dependencies.
- Commit messages: single-line conventional English; configured author only.
- No personal identities, credentials or actual home paths in public artifacts.
- Do not modify existing gate manifests, implementation plans or run state by hand.
- Task changes stay in their declared file sets; use the CLI for fleet state.
- Preserve Git-derived fileset/ownership enforcement and every tracked gate check.
- Run targeted behavioral mutations, observe their corresponding assertion fail, restore and run affected and complete suites.
- Use short TMPDIR values and stop every test daemon/browser started by the task.
- New required contracts never fall back to an unrestricted legacy invocation.
- No automatic telemetry, model downloads, Vault writes, production publication or deployment.
- Read docs/specs/2026-10-06-open-issues-delivery-design.md and the integrated prerequisite module contracts.

## Contracts between tasks

Artifacts are immutable bounded private content under canonical common-Git
storage, with version, kind, SHA-256, byte length and an opaque reference.
Metadata contains no transcript bodies, credentials or personal paths.
Read validates a regular file, size, content hash and run binding. A missing or
altered artifact is unresolved, never an empty success. An explicit local
retention policy bounds individual artifacts, total run bytes and age. Cleanup
cannot discard a current unresolved attempt's required recovery evidence.

Strict execution inputs contain exact source commit and SHA-256 identities for
plan, tracked manifest, context, observed environment and installed verifier.
Keep the existing five-field observation APIs compatible, but label legacy
receipts unverified and do not promote them into strict completion evidence.
Durations and provider metrics that were not observed remain null.

New attempt metadata separates stable execution/run/task/step/attempt identity
from harness session, process and disposable checkout. Start is persisted
before a side effect; an observed end references validated artifacts and actual
refs. Version 1 journal entries remain readable as historical observations.
A missing end is interrupted or an unknown effect, never verified complete.

The existing generative integrator remains a visibly legacy path. A new
explicit `host-bounded` integration mode has a required integrator policy with
read/write/execute/sharedRefs true and network/publication false. The trusted
host permits only ordinary checkout and no-ff merges of exact reviewed owned
local task tips into the run branch. It disables hooks/fsmonitor/signing, never
executes commands from model text, never force-moves refs, and refuses moved
inputs, dirty state, conflicts and unsupported settings. This is fixed local
Git authority, not a claim of hostile same-UID isolation. The role resolver
reports this mode separately; sharedRefs stays unsupported for an unrestricted
sandboxed model.

The controller executes only the fixed fragments of workflow-profile. Resolve
the installed CLI absolutely, append an explicit absolute project root, validate
expanded inputs independently, and reject arbitrary artifact-supplied commands.
Collect reviews from the exact path emitted on the CLI's successful write line;
do not parse the trailing-path stdout as JSON. Capture actual stdout/stderr with
bounded existing executors. Validate schemas, current stamps, refs and hashes
before releasing dependencies. Require actual environment and role contracts,
finite attempt/repair/wall-time budgets and current acceptance obligations.

Suspension, abandonment, blocked infrastructure, failed implementation and
verified-complete remain distinct. Unknown PR effects use bounded read-only
GitHub queries when explicitly supported; unsupported Vault/publication effects
remain unresolved. An explicit operator resolution records its local trust
boundary and never implies authenticated external authorization.

### Shared API contracts

These signatures are the producer/consumer boundary. Consumers import the
producer rather than reproducing storage, identity or freshness rules.

- T2 exports `retainExecutionArtifact({ common, runId, kind, bytes, retention, now })`,
  `readExecutionArtifact({ common, runId, reference, retention })` and
  `pruneExecutionArtifacts({ common, runId, retention, liveReferences, now })`.
  `bytes` is a Buffer or Uint8Array; reads return a Buffer. `retention` has
  `maxArtifactBytes`, `maxRunBytes` and `maxAgeMs`, all positive safe integers
  with enforced upper bounds. An immutable reference has exactly `version: 1`,
  `runId`, `kind`, `sha256` and `byteLength`; it contains no absolute path.
  Retention returns `{ reference, durability, trust }`; a failed write throws,
  never returning a usable reference. Cleanup returns counts and unresolved
  references without exposing artifact bodies. A referenced artifact retained
  for recovery can make a byte/age limit unsatisfiable; report that condition
  instead of deleting the evidence or silently claiming the limit is met.
- T3 exports `strictExecutionIdentity(inputs)` over exact `commit` and
  SHA-256 `plan`, `manifest`, `context`, `environment`, `verifier` fields, and
  `summarizeCompletionObligations({ inputs, requirements, receipts,
  artifactObservations, branches, lifecycle })`. Requirements have unique
  bounded `id`, `kind`, `mandatory`, and expected source/ref identities.
  Receipt IDs are unique and bind requirement, execution identity, actual
  status, artifact reference and current refs. Each requirement declares its
  exact expected step inputs and tested tree/ref identity; the current final
  integrated tree has separate mandatory final command/review obligations.
  Anchored request inputs and a pre-implementation receipt are not final-tree
  verification. Reconciliation preserves valid unchanged task observations
  while refreshing obligations affected by an integrated tree change. Artifact observations come from
  T2 reads performed by the trusted controller, never from model claims.
  The report exposes `verifiedComplete`, `state`, `obligations`, `stale` and
  explicit trust limits. Existing `evidenceIdentity` and `summarizeAcceptance`
  keep their legacy signatures; their reports cannot satisfy this strict API.
- T4 exports `integrateReviewedPhase({ root, runId, phase, branch,
  expectedRunTip, taskTips, gateReceipt, policy, git })`. The trusted controller
  supplies an actual freshly executed gate receipt with exact plan, manifest,
  verifier and task-tip identities and required check outcomes, never merely
  the mutable phase PASS marker. The operation independently rederives current
  tracked ownership, refs and inputs before each merge. Return only observed
  merges with before/after refs, completion state and trust limits. Preserve
  any partial merge sequence in an error receipt so recovery observes the
  actual state. `git` is the bounded executor seam used by the host; model or
  artifact text cannot supply its argv. Extend `resolveRoleCapabilities` with
  an explicit `host-bounded` mode, retaining all legacy isolated-model refusal
  behavior.
- T5 exports `reconcileExecutionAttempt({ common, runId, inputs, branches,
  retention, checkouts, effectQueries })` and
  `resolveExecutionEffect({ common, runId, effectId, resolution, reason })`.
  A resolution is a bounded local operator observation of completed, failed or
  unknown; an unknown observation still blocks a retry. Version 2 journal
  records bind strict identity and artifact references and retain the existing
  version 1 reader. Reconciliation reads real T2 artifacts and T3 identities;
  it never marks historical records verified complete. Queries are fixed
  bounded read-only adapters selected by supported effect kind, with no shell
  command, URL or executable supplied by an artifact.
- T6 extends `dispatchPhase` with an optional required execution contract,
  preserving the legacy call shape. The required contract contains common Git
  storage, stable run/execution identity, strict inputs, retention and finite
  attempt/deadline bounds. Missing mandatory journal/artifact evidence fails
  closed. Persist fresh worker setup and baseline observations, including duration
  and complete log references, before pre-spawn verification can replace current
  workerEnvironment metadata. Retain both initial setup and current continuation
  observations; a not-rerun receipt never substitutes for the original setup
  outcome. No consumer treats the unchanged legacy state-only fast path as
  verified execution.
- T7 exports `executeWorkflowProfile({ root, cliPath, request, environment,
  rolePolicy, retention, executor, now })` and
  `resumeWorkflowProfile({ root, cliPath, runId, executor, now })`. `request`
  selects an existing fixed profile and bounded parameters; the controller
  loads exact committed inputs rather than accepting expanded argv as trusted.
  `executor` follows the existing bounded command execution contract, including
  complete stdout/stderr observations. The report references immutable
  artifacts, exact inputs, attempts and T3 obligations. Publication is absent.
  Resume rereads the retained request and current committed contracts, rederives
  the fixed profile, reconciles T5 evidence and reruns invalidated obligations.
  No model text defines commands or authorizes a dependent step.

The T8 CLI surface is `workflow-execute --file <request-json>`,
`workflow-resume --run <id>`, `workflow-status --run <id>` and
`workflow-resolve --file <resolution-json>`, all with explicit absolute project
root. Required execution request version 1 includes the selected profile,
run ID, committed plan/base identities, environment and role-policy source
paths, explicit model/effort, bounded retention and finite execution limits.
Unknown keys, arbitrary executable/argv fields and unsupported effect adapters
are refused. The installed absolute CLI path is resolved by the trusted host,
not taken from a project request. Status is read-only reconciliation. Resolution
records only a local observation and does not perform an external effect.

## Out of Scope

- Replacing the fleet execution model or adding a general workflow DSL - execute the already expanded fixed CLI fragments.
- Claiming live Claude callback validation without provider execution - the weekly provider limit currently blocks those observations.
- Production publication or Vault writes - this delivery reconciles only explicitly authorized supported effects and isolated trials.
- Deck terminal persistence across daemon restart - preserve the accepted deckd/PTY loss boundary.
- Promoting quality or scheduling conclusions from these integration trials - repeated matched W02 evaluation follows its frozen independent dataset.

### Task 1: preserve native execution output and require a successful executor fixture

**Files:**
- Modify: `scripts/cli.mjs`
- Modify: `scripts/harnesses/codex.mjs`
- Test: `tests/execution-prerequisites.test.mjs`
- Test: `tests/harness-codex.test.mjs`

**Acceptance:**
- Reproduce the independently confirmed loss of asynchronous Node console output at prerequisite candidate dea1de78 before changing execution behavior. Compare console.log and synchronous writes through the actual bounded native executor.
- Isolate the child-process/output mechanism, preserve complete bounded stdout/stderr and actual exit outcomes, and make compatible console-based version probes succeed without widening filesystem, Git, network or publication authority.
- Add a deterministic injected-runtime success fixture that must return a verified executor for a valid independently checked restriction receipt. An unconditional rejection before return must fail its success assertion.
- Keep simulated receipt validation distinct from actual Linux dummy filesystem/network denial evidence and unsupported-platform refusals.
- Exercise output/timeout/size limits, nonzero and signal exits, malformed/incomplete restriction receipts and source changes. A failed UV_USE_IO_URING=0 observation is not a fix.
- Keep required role enforcement fail closed; no unrestricted fallback, new dependency or modification of installed plugin code.

- [ ] Step 1: Run the existing host reproducer against the anchored candidate and add behavioral assertions requiring console and synchronous outputs to agree.
- [ ] Step 2: Observe the output assertion fail on the existing executor and observe a success assertion fail when a valid receipt is rejected.
- [ ] Step 3: Implement the isolated output fix and deterministic success fixture within the declared files.
- [ ] Step 4: Mutate output retention, the valid receipt return, and each changed restriction/limit guard; observe the matching assertions fail and restore.
- [ ] Step 5: Run affected/root/hub checks, actual non-model native denial probes and instruction lint, then commit only declared files and report platform limits.

### Task 2: retain bounded private execution artifacts

**Files:**
- Create: `scripts/execution-artifacts.mjs`
- Test: `tests/execution-artifacts.test.mjs`

**Acceptance:**
- Export retainExecutionArtifact, readExecutionArtifact and pruneExecutionArtifacts with an explicit validated local retention contract.
- Bind exact bytes, kind and run identity; reject links, non-regular/oversized inputs, changed bytes, unsupported versions and unsafe references.
- Use exclusive immutable writes and private modes in canonical common Git storage; deduplicate equal content without accepting a different identity.
- Bound per-artifact and total-run bytes and expose incomplete/storage/retention failure instead of claiming a retained artifact.
- Age cleanup respects a supplied independently reconciled set of live recovery references; do not silently prune unresolved evidence.
- Document fsync/power-loss and same-UID trust limitations in returned metadata, without exposing source home paths.

- [ ] Step 1: Write tests that retain actual bytes in a temporary repository, then assert `assert.deepEqual(await readExecutionArtifact(request), original)` and `await assert.rejects(readExecutionArtifact(changedRequest))` after changing the file.
- [ ] Step 2: Observe behavioral RED with a minimal temporary producer and distinguish it from a missing import/setup error.
- [ ] Step 3: Implement bounded no-follow regular-file reads and immutable private content storage using Node built-ins and the existing common-Git discovery.
- [ ] Step 4: Mutate content/run binding, regular-file checks, each byte bound and live-reference retention protection; fail matching assertions, restore and run root checks.
- [ ] Step 5: Commit only the declared producer/test and return current observations and mutation evidence.

### Task 3: bind current completion obligations and lifecycle evidence

**Files:**
- Create: `scripts/completion-obligations.mjs`
- Modify: `scripts/workflow-lifecycle.mjs`
- Modify: `scripts/workflow-evidence.mjs`
- Modify: `scripts/orchestrator-stop.mjs`
- Test: `tests/completion-obligations.test.mjs`
- Test: `tests/workflow-lifecycle.test.mjs`
- Test: `tests/workflow-evidence.test.mjs`

**Acceptance:**
- Define strict current input/requirement identities including context and enumerate mandatory implementation, command, review, acceptance and integration obligations.
- Distinguish anchored request identity, exact per-step tested task inputs and the current final integrated tree. Recompute affected mandatory final command/review obligations without treating pre-implementation observations as final verification.
- Distinguish observations from execution-backed receipts; historical version 1 bindings never establish strict verified completion.
- Invalidate affected receipts on changed code/tree, plan, manifest, context, environment, verifier, task refs or missing artifact observations.
- A conflicting, skipped, unverified or incomplete mandatory observation remains failed/unresolved; model done is not a receipt.
- Extend explicit session binding without inferring another run, preserve ambiguity and loop protection, and expose blocked/failed/suspended/abandoned/verified-complete distinctly.
- Preserve bounded fail-open Stop behavior and explicitly report that handler execution or an enforcement-only pass is not an actual graceful harness callback or full completion.
- Test abrupt process disappearance, stale inputs and conflicting evidence with actual temporary Git repositories; do not recapture Claude fixtures.

- [ ] Step 1: Write strict-identity tests asserting `assert.equal(report.verifiedComplete, false)` after changing every relevant input and when a mandatory receipt is absent.
- [ ] Step 2: Observe intended failures without changing an existing binding to satisfy the candidate.
- [ ] Step 3: Implement the bounded strict requirement/receipt APIs and compatible lifecycle extensions; retain explicit legacy observation reporting.
- [ ] Step 4: Remove identity, conflict, state and loop guards individually; observe corresponding failures and restore before complete root checks.
- [ ] Step 5: Commit the declared files and report executable handler tests separately from pending real callbacks.

### Task 4: add explicit reviewed host integration authority

**Files:**
- Create: `scripts/reviewed-integration.mjs`
- Modify: `scripts/role-capabilities.mjs`
- Test: `tests/reviewed-integration.test.mjs`
- Test: `tests/role-capabilities.test.mjs`

**Acceptance:**
- Add an explicit host-bounded integrator enforcement result without widening implementer/reviewer authority or existing unrestricted model support.
- Bind a fresh actual gate receipt to run tip, exact task tips, anchored plan, tracked manifest and verifier; a mutable recorded status alone cannot authorize integration.
- Merge only the phase's current owned local task refs through normal checkout and no-ff operations; preserve configured author and reject direct/force ref mutation.
- Disable hooks/fsmonitor/signing for the fixed Git operations and never execute artifact/prompt commands or a remote publication action.
- Refuse absent required authority, changed inputs/refs, dirty state, unsupported configuration and conflicts; retain any observed partial progress for reconciliation.
- Test exact merges and every refusal in actual repositories, including a hostile configured hook that must not run and changed tips after gating.

- [ ] Step 1: Write an actual repository fixture and assert `assert.equal(receipt.mode, 'host-bounded')`, exact merged ancestors and no unrelated ref changes.
- [ ] Step 2: Observe failure when the module does not enforce the policy or current gate identity.
- [ ] Step 3: Implement the fixed scoped integration operation and a separate immutable resolver result for its declared host authority.
- [ ] Step 4: Mutate each authority, freshness, ownership and Git-hook restriction; inspect behavior assertions, restore and run root checks.
- [ ] Step 5: Commit declared files with an exact support/trust matrix.

### Task 5: reconcile journal attempts, artifacts and uncertain effects

**Files:**
- Modify: `scripts/execution-journal.mjs`
- Create: `scripts/execution-recovery.mjs`
- Test: `tests/execution-journal.test.mjs`
- Test: `tests/execution-recovery.test.mjs`

**Depends:** T2, T3

**Acceptance:**
- Add strict versioned execution/attempt/artifact metadata while preserving readable historical version 1 observations.
- Reconcile actual retained content, current refs, checkout availability and strict input identities before reuse or redispatch.
- Validate start/end ordering, unique attempts and explicit external effect outcomes; unknown effects refuse non-idempotent retries.
- Provide bounded read-only outcome queries for explicitly supported authorized PR references, with secret-free whitelisted observations and no effect creation.
- Unsupported Vault/publication adapters remain unknown. Explicit operator resolution is recorded with its local trust limit and cannot claim authenticated authorization.
- Bound event storage and retention and report inability to persist a required start before permitting the associated action.

- [ ] Step 1: Write tests asserting stale/changed/missing-artifact and unknown-effect states from actual journal and Git observations.
- [ ] Step 2: Observe behavioral RED by bypassing reconciliation in the test seam, not by breaking the fixture setup.
- [ ] Step 3: Extend journal metadata and implement bounded supported query/resolution adapters over retained artifacts and observed refs.
- [ ] Step 4: Mutate persistence ordering, artifact identity, stale-ref and unknown-effect guards; observe targeted failures and restore before root checks.
- [ ] Step 5: Commit only declared files and report read-only real versus fixture-backed query evidence separately.

### Task 6: integrate recoverable boundaries with the actual driver

**Files:**
- Modify: `scripts/driver.mjs`
- Modify: `scripts/brief.mjs`
- Test: `tests/driver.test.mjs`
- Test: `tests/driver-recovery.test.mjs`
- Test: `tests/brief.test.mjs`

**Depends:** T1, T2, T3, T5

**Acceptance:**
- Persist stable attempts before harness spawn/resume and collection; bind model/effort/prompt/source identities without transcript bodies in metadata.
- Replace status-string reuse with actual schema, strict inputs, retained artifact and ref reconciliation. Legacy missing evidence is visibly unverified and never promoted to completion.
- Preserve prior task work; do not reset a fix or later phase to the original base, and correct separate-git-dir clone root/location handling explicitly.
- Observe current results only after actual process completion and artifact validation; remove stale outputs before a new invocation can consume them.
- Reconcile interrupted collection and lost disposable checkouts without blind duplicate model/effect execution; fail closed on required journal persistence failure.
- Kill a real driver process at documented spawn/result-persistence/collection boundaries using the supported adapter protocol, proving preserved commits and fresh mandatory verification.
- Keep fixture-backed adapter loss tests distinct from actual subscription-model interruption trials and Deck daemon loss.

- [ ] Step 1: Write actual child-driver tests with explicit persisted barriers, kill the driver and assert recoverable refs/artifacts rather than only recorder events.
- [ ] Step 2: Observe that stale status-string evidence cannot satisfy the updated behavior.
- [ ] Step 3: Connect the journal/artifact/recovery APIs to bounded driver boundaries and clone-aware current-tip brief composition.
- [ ] Step 4: Mutate ordering, stale-result cleanup, source/ref validation and preserved-work guards; restore after targeted failures and run root checks.
- [ ] Step 5: Commit the declared driver/brief/tests and return precise boundary receipts and cleanup evidence.

### Task 7: execute fixed workflow profiles with validated dependencies

**Files:**
- Modify: `scripts/workflow-profile.mjs`
- Create: `scripts/workflow-controller.mjs`
- Test: `tests/workflow-profile.test.mjs`
- Test: `tests/workflow-controller.test.mjs`

**Depends:** T1, T2, T3, T4, T5, T6

**Acceptance:**
- Execute all five fixed profiles through existing CLI/harness interfaces, resolving absolute installed entrypoint and project root independently of cwd.
- Independently validate expanded tracked source and enforce actual environment/role preflight; supplied capability strings never authorize execution.
- Run known deterministic fragments only and validate every named task/review/gate/integration/acceptance artifact before releasing a dependent step.
- Capture bounded actual stdout/stderr and collect reviews from the successful CLI-written path; validate current review stamps and exact gate inputs.
- Enforce total wall-time, attempt and existing repair budgets; distinguish code repair from infrastructure/provider/policy/unknown-effect blockers.
- Use explicit host-bounded reviewed integration for required profiles, current acceptance evidence and fresh final gates; skip/partial/human-required never means complete.
- Resume through immutable attempt reconciliation, preserving observed outputs without reusing stale mandatory verdicts.
- Test two independent task/profile reuses and negative malformed/changed/missing/timeout/capability/unknown-effect cases using actual child executions.

- [ ] Step 1: Write child-executor tests asserting a missing artifact prevents the next command and an unverified capability prevents the first spawn.
- [ ] Step 2: Observe intended assertion failures while the expanded profile remains otherwise valid.
- [ ] Step 3: Implement the bounded fixed-step controller over existing executors, actual prerequisite producers, current receipts and recovery interfaces.
- [ ] Step 4: Mutate dependency validation, command whitelist, successful review-path parsing and each loop/time bound; restore after matching failures and run root checks.
- [ ] Step 5: Commit only the declared controller/profile/tests and return artifact and wall-time observations.

### Task 8: expose controlled execution and recovery through CLI/adapters

**Files:**
- Modify: `scripts/cli.mjs`
- Modify: `scripts/harnesses/codex.mjs`
- Modify: `scripts/harnesses/cursor.mjs`
- Test: `tests/execution-controller-cli.test.mjs`
- Test: `tests/harness-codex.test.mjs`
- Test: `tests/harness-cursor.test.mjs`

**Depends:** T7

**Acceptance:**
- Route bounded profile execution/resume/status/resolution and host-bounded integration through explicit versioned CLI contracts; malformed exits 2 and unresolved execution exits 4.
- Bind current source/environment/role inputs into driver/controller calls and pass explicit model/effort to actual supported dispatches.
- Fix absolute root handling, concrete integration assignments and current task tips without broadening the existing legacy default authority.
- Capture required read-only reviewer findings by the trusted host from validated structured output; no writable shared ref or findings-root permission is granted to the reviewer.
- Bound required stream/result storage, retain actual artifact references and fail explicitly on incomplete/oversized capture; preserve disabled Codex hooks and control-path guards.
- Report current obligations and recovery states through CLI/doctor, including standing skips and callback limitations.
- Test CLI-level actual repositories, process loss, changed contracts and no-spawn/no-merge/no-effect refusals.

- [ ] Step 1: Write CLI integration tests for actual profile receipts, current status and blocked effects before changing routing.
- [ ] Step 2: Observe the expected missing-execution behavior and authority refusals.
- [ ] Step 3: Wire the producers through existing handlers/adapters and host result capture, preserving explicit legacy limitations.
- [ ] Step 4: Mutate new refusal, host capture, source propagation and storage guards; restore after corresponding failures.
- [ ] Step 5: Run root/hub checks and instruction lint, then commit only declared files.

### Task 9: exercise real profiles and report issue acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/2026-10-06-issue-25-progress.md`
- Create: `docs/specs/2026-10-06-execution-recovery-validation.md`

**Depends:** T8

**Acceptance:**
- Execute two actual authenticated Codex profile tasks in isolated clean projects with required environment/role contracts and current independent acceptance.
- Exercise an actual supported driver interruption at documented boundaries and reconcile real refs/artifacts before any resume; avoid duplicate effects and verify fresh gates.
- Record model/effort/prompt/input/environment identities, observed setup/execution duration and available resource counters; missing values stay null.
- Document exact CLI/contract schemas, migration/defaults, trust limits, local retention, unsupported external adapters and Deck restart limits.
- Provide per-issue acceptance matrices for 42/43/33, keeping real callback and repeated W02/human obligations pending where unavailable.
- Run current root/hub checks, instruction lint and four-lens review without changing tracked policy; report fix rounds and bounded claims coverage.

- [ ] Step 1: Run actual clean-project subscription-model profiles and retain secret-free receipts outside the repository.
- [ ] Step 2: Execute and recover the real interrupted driver, then inspect current artifacts, refs and mandatory gates.
- [ ] Step 3: Write the validation and README/progress updates from actual outputs; never replace an unmet criterion with documentation.
- [ ] Step 4: Run diff checks, instruction lint and complete gate checks, then commit only declared docs.
