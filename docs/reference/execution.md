# Event ledger, diagnostics and bounded execution

Moved from the project README. These sections document the ledger, hook diagnostics, reviewer outcome reports and the execution and recovery commands, with the issues that remain open.

## Event ledger and hook diagnostics

`node scripts/cli.mjs digest --ledger --run <runId> --root <project>` reports each task's
fixed event counts and result enums. Bash commands are represented by SHA-256 fingerprints;
command output and handoff prose are never included. Events live in per-task JSONL files under
`.fleetmates/<runId>/ledger/`. The reader rejects links, non-regular files, partial records,
invalid events and files over 1 MiB. An unavailable ledger is reported explicitly. The ledger
is writable observation data, not a substitute for the existing git-derived enforcement.

SessionStart restores a registered teammate's own task and phase from its committed plan in
`docs/plans/`. PreCompact emits a reminder; SessionStart on compact re-injects it afterward.
PostToolUse records Bash outcomes when the harness supplies an exit code, otherwise unknown.
Repeated stops without new successful command fingerprints or a passing gate trigger a fixed
stall warning, capped at three blocks; active-stop retries are allowed to terminate as blocked.
The headless driver already caps enforcement retries and records its gate and handoff events.

`node scripts/cli.mjs doctor --hooks [--session <sessionId>]` checks callback receipts from the
last 24 hours in the Claude config directory. It reports unverified callbacks honestly. Start a
session, run Bash, compact, and stop a teammate in the installed Claude Code version to prove
the callbacks fire. Synthetic tests validate the handlers, not a live Claude installation.

### Reviewer outcome reports

`workflow-report --file <json>` can include `reviewOutcomes` with `findings`
and optional independently established `labeledDefects`. Findings declare
`id`, `identity` (the acceptance input hash), `outcome` (confirmed, refuted,
duplicate, unreproduced or accepted), `rationale`, nonempty `evidence` log
references, and `provenance` (`lens`, `category`, `model`, `source`). A duplicate
also names `duplicateOf`. The report preserves each source observation in a
canonical group and reports metrics by lens, category and model. Stale inputs,
missing duplicate targets and cycles cannot silently become current evidence.
References and outcomes are observations, not independent reproduction proof.
This is reporting only; it does not change review policy or model selection.

A `workflow-report` input can also include `verifierProfile` with a `package`
object, `platform` (`linux`, `darwin` or `win32`) and optional `required` npm
script names (`test` by default; also `typecheck`, `lint`, `build`). It emits a
versioned Node/TypeScript proposal using existing gate inference and required
fileset, ownership and review checks. Missing scripts make it not ready. Review
and track this proposal before using it; generating it runs no commands and
satisfies no acceptance requirement. Command gate results distinguish actual
timeouts from otherwise unclassified failures; inspect evidence before deciding
whether a code change or retry is appropriate.

Command gate results also include `log`: a private local `path`, retained
`bytes`, `observedBytes`, `maxBytes`, a `sha256` of the retained bytes,
`complete`, `truncated` and any storage `error` code. Successful commands keep
their empty diagnostic summary while retaining output for inspection. The
default executor captures raw combined stdout/stderr in arrival order;
buffered custom executors retain their returned output instead. These are
output observations, not authenticated execution or acceptance receipts.

Each command gets a separate `fm-command-log-*/output.log` beneath the system
temporary directory, outside its working tree. Directories/files use 0700/0600
on POSIX; Windows uses the temporary directory's existing access controls.
Logs survive preview removal until the operator or operating system removes
them. Output is stored without redaction and may contain sensitive project
diagnostics. Delete the containing directory when the evidence is no longer
needed; there is no automatic retention sweep or durable recovery guarantee.

Each log retains at most 16 MiB. Failure summaries carry at most 40 lines and
64 KiB of decoded diagnostic text, plus an incompleteness notice when needed.
Timeouts and output/storage limits leave `complete: false`. Incomplete capture
cannot pass a command check even when the subprocess exits zero. The existing
`outcome` describes the subprocess; `log` separately describes its output
evidence. A content hash detects changed bytes only when compared with the
receipt; it does not authenticate the operator or establish semantic success.

For anchored context, a task may include an `**Acceptance:**` section in its
tracked plan. Its entire task contract then enters the bounded bundle as
mandatory context. Existing `**Depends:** T1` declarations also include the
upstream task's contract. Implementation, review and integration use the plan
anchor, with source lines and hashes; later edits do not silently replace it.
Missing dependencies or mandatory budget overflow refuse dispatch. This does
not infer dependencies from file history or treat learnings as tracked policy.

Tasks may also declare `ui: design/settings.html, design/settings.md` using
unique repository-relative Markdown, HTML or SVG files. Commit targets on the
chosen base with the plan. `init-run` rejects missing or nonregular committed
targets; dispatch reads their contents at the plan anchor into mandatory
bounded context. An agent check can select `lens: ["ui"]`; that method requires
rendered and behavioral evidence and reports unavailable verification explicitly.
Renderer setup, artifact capture and a native `kind: "ui"` adapter remain
unsupported. Source structure alone does not prove visual acceptance.

`ci-status --file <json>` provides read-only GitHub CI reporting for the current
committed branch tip. Input declares `repository` (`owner/repository`), `inputs`
(`commit`, `plan`, `manifest`, `environment`, `verifier`) and nonempty `required`
checks such as `[{"name":"test (ubuntu-latest)","app":"github-actions"}]`.
It requires the installed/authenticated `gh` CLI. Current exact-commit required
checks must all succeed; pending, skipped, missing and truncated results cannot
pass. Exit codes are 0 for passed CI checks, 4 for unmet checks and 2 for an
invalid/unavailable query. Other input fields are declared associations, not
independently verified by GitHub metadata. Uncommitted changes are outside its
scope. This command performs no repairs, publication, merge or deployment.

`feedback-draft --file <json>` prepares reviewed feedback proposals without
writing project files. Input has `runId`, `date` (ISO day), `inputs`, `planPath`
and `findings`. inputs.commit must match the current branch tip and inputs.plan
must be the SHA-256 of the committed plan. Each finding declares `id`, `title`,
`type` (rule, decision, pitfall, defect), `description`, `scope` and `evidence`.
Defects also declare exact `files` and `acceptance`; optional `dependsOnTasks`
and `dependsOnFindings` make dependencies explicit. Proposed tasks follow all
existing terminal tasks. Learnings stay proposed and owned by the repo.
Review the draft and apply it through authoritative plan and ownership rules;
this command does not amend the plan, write learnings or call Vault.
Workflow JSON inputs are limited to opened regular files and an actual 1 MiB
read budget.

`workflow-profile --file <json>` expands a reusable profile in dry-run mode.
Choose `bug-fix`, `feature`, `migration`, `ui` or `research`; provide `runId`,
`planPath`, `baseBranch`, `harness` (`codex`/`cursor`), exact `inputs` hashes and
capability declarations (`available`/`unavailable`/`unknown`). The proposal shows
phases, required artifacts, existing CLI commands and side effects. Tracked
checks and repair budgets remain mandatory. Migration parameters require
`compatibility` and `rollback`; UI requires render capability; a profile with
`parameters.requiresVault: true` requires Vault. The expansion is nonexecutable:
a controller and actual verification remain necessary, and no agent or command
runs during dry-run. Declared capabilities do not grant permissions.

### Execution prerequisites (issues 44 and 45 remain open)

`environment-check --file <json> [--execute] --root <project>` accepts
`{"commit":"<exact-commit>","recipePath":"recipe.json","harness":"codex"}`.
The request is a local input file; the recipe and declared lockfiles must be
regular committed blobs at that exact commit. The recipe has these exact fields:

```json
{
  "version": 1,
  "toolchains": [{ "name": "node", "command": "node", "argv": ["--version"], "expected": "v26." }],
  "lockfiles": ["package-lock.json"],
  "setup": [{ "name": "install", "run": "npm ci --ignore-scripts --no-audit --no-fund", "timeoutMs": 60000 }],
  "baseline": [{ "name": "test", "run": "npm test", "timeoutMs": 60000 }],
  "required": ["harness", "render", "ci"],
  "dependencies": "clean-checkout"
}
```

This is the tested dependency-free fixture recipe on Node v26.7.0, not a
universal project installation recipe. Core requires Node >= 24.2.0. Choose
and commit the toolchain prefix, lockfiles and setup appropriate to the project.
`dependencies` can instead be `linked`, which reports reproducibility limits.
Arrays are bounded to 20 entries; baseline requires at least one check.
Check timeouts range from 1 to 3,600,000 ms. Tool/service probes are bounded to
5 seconds, 250 ms cleanup and 64 KiB output. Services are `harness`, `render`,
`ci` and `vault`; unrequested services are omitted.

In the clean fixture, this command returned 4 without `--execute`, 0 after
setup/baseline and required probes passed, and 2 for an injected `ready` field.
Inspect the receipt, not just the exit: setup/baseline include durations and
private log references, completeness and hashes. Missing capabilities stay
unavailable or unknown. Browser presence is not UI validation; GitHub login
is not an executed workflow. The tested Vault probe reported unavailable.

`dispatch`, `dispatch-reviews` and `dispatch-integrator` accept
`--environment <recipe-path>` and `--role-policy <policy-path>`, both committed
repository-relative paths. A policy has version 1 and explicitly declared roles;
each entry must include all six boolean fields:

```json
{
  "version": 1,
  "roles": {
    "implementer": { "read": true, "write": true, "execute": true, "network": false, "sharedRefs": false, "publication": false },
    "reviewer": { "read": true, "write": false, "execute": true, "network": false, "sharedRefs": false, "publication": false },
    "integrator": { "read": true, "write": true, "execute": true, "network": false, "sharedRefs": false, "publication": false }
  }
}
```

The tested resolver maps Codex clone/files reviewers to read-only and writable
roles to workspace-write. Required `full` mode, `execute: false`, reviewer
network, shared-ref authority and publication are unsupported. Host-approved
network is required for a network request. Cursor files-mode resolution maps
nonwriting/nonexecuting roles to ask and writable/executing roles to its enabled
sandbox; executing read-only review and required non-model environment
verification remain unsupported. Resolver readiness is not native readiness.
These integrator entries grant no shared-ref or publication authority.
Actual CLI trials with this policy returned 4 for Codex integrator dispatch
and Cursor reviewer dispatch because their selected sandbox mode was
unsupported; a missing committed policy returned 2. Thus a supported resolver
row alone does not establish a supported dispatch path.

Required native verification in the 2026-10-06 isolated-clone trial refused
with exit 4 because restrictions were not independently observed. There was no
required-policy fallback. In the 2026-10-07 execution-recovery trials on a
Linux host, the same contracts reported `enforcement.kind: "required"` with
`observed: true` for both implementer and reviewer dispatch; readiness depends
on the host's native sandbox runtime. The standalone `environment-check` trial used the
host command executor; its pass does not establish required sandbox enforcement.
Legacy invocation remains a separately unverified compatibility path.
Changed source HEAD invalidates a bound continuation even when contract bytes
are equal. Recipes and retrieved text are not permission grants.

See [current observations and consumer obligations](../../docs/specs/2026-10-06-execution-prerequisites-validation.md)
for commands, evidence provenance, unresolved findings and evaluation limits.

`execution-record --file <json>` stores immutable local execution observations
in the main repository's common Git directory. Events declare `id`, `runId`,
`step`, `attempt`, `kind`, `at` and `inputs`; kinds are `step-started`,
`step-completed`, `step-failed`, `effect-started`, `effect-completed`,
`effect-failed` or `effect-unknown`. Effects also declare `{id,kind,reference}`
with kind `pr`, `vault` or `publication`. Optional `branches` map fully qualified
refs/heads names to exact SHAs. Identical retries are idempotent; conflicting
IDs refuse. No external effect is executed and prompt/command/output fields
are excluded from persisted records.

`execution-status --run <id> --file <json>` reads `{inputs}` and reconciles
recorded branch tips with Git. Interrupted, stale and unknown-effect attempts
stay unresolved. A completed observation still requires current gates and is
never verified delivery. Use the main repository's root; disposable clones
have separate metadata. Automatic driver recovery and external reconciliation
adapters remain unsupported; these commands repeat no external action.

### Bounded workflow execution (issues 42, 43 and 33 remain open)

Six commands run, recover and maintain a fixed workflow profile. Each
requires an absolute `--root`; a missing or relative root exits 2 before
anything is read.

```sh
node scripts/cli.mjs workflow-execute --file <request.json> --root <absolute-project-root>
node scripts/cli.mjs workflow-resume  --run <id>            --root <absolute-project-root>
node scripts/cli.mjs workflow-status  --run <id>            --root <absolute-project-root>
node scripts/cli.mjs workflow-resolve --file <resolution.json> --root <absolute-project-root>
node scripts/cli.mjs workflow-accept  --file <absolute-acceptance.json> --root <absolute-project-root>
node scripts/cli.mjs workflow-prune   --run <id>            --root <absolute-project-root>
```

A version 1 request has exactly these fields. There are no defaults: a
missing field, an unknown field, an executable or argv field all exit 2.

```json
{"version":1,"profile":"bug-fix","runId":"p1b","planPath":"plan.md","baseBranch":"main",
 "baseCommit":"<exact commit at the tip of baseBranch>","runBranch":"run/p1b","harness":"codex","sandboxMode":"clone",
 "parameters":{},"limits":{"maxWallMs":2400000,"maxAttempts":40,"maxRepairRounds":1,"stepTimeoutMs":1500000},
 "environment":"env.json","rolePolicy":"roles.json",
 "retention":{"maxArtifactBytes":4194304,"maxRunBytes":67108864,"maxAgeMs":2592000000},
 "model":"<model>","effort":"low"}
```

- `profile` is `bug-fix`, `feature`, `migration`, `ui` or `research`; `harness`
  is `codex` or `cursor`; `sandboxMode` is `clone` or `files`.
- `runId` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`. `runBranch` must differ
  from `baseBranch`, exist, and be checked out at the root.
- `baseCommit` must be the current tip of `baseBranch`; a moved base is
  reported as a `changed-input` blocker with exit 4 before any journal write.
- `planPath`, `environment` and `rolePolicy` are repository-relative paths read
  from the committed base. The recipe and policy shapes are the ones in the
  execution prerequisites section. The controller resolves the integrator in
  the host-bounded mode, whose contract is read, write, execute and sharedRefs
  true with network and publication false; the trials used such a policy.
- `parameters` is an object of at most 4,096 JSON bytes. `migration` needs
  `compatibility` and `rollback`; `requiresVault` is a boolean; `dispatch` is
  reserved.
- `limits`: `maxWallMs` 1,000 to 86,400,000; `maxAttempts` 1 to 500;
  `maxRepairRounds` 0 to 10; `stepTimeoutMs` 1,000 to 21,600,000.
- `retention`: positive integers up to 16 MiB per artifact, 256 MiB per run
  and 365 days.
- `model` is one bounded token not starting with a dash. `effort` is `low`,
  `medium`, `high`, `xhigh`, `max` or null; Cursor requires null. The trusted
  host adds them only to `dispatch` and `dispatch-reviews`.

The controller runs `init-run`, `preview-check`, then per phase `dispatch`,
`dispatch-reviews`, `collect-reviews`, `gate` and a host-bounded no-ff merge,
then acceptance and `finish`. The CLI it runs is the installed one, never a
path from the request. Each step's start is journaled before it runs, and its
outputs are retained and read back before the next step is released.

Exit codes. `workflow-execute` and `workflow-resume` exit 0 only for a
`verified-complete` report and 4 for every other report. A
`verified-complete` report needs passing acceptance evidence for every
required criterion and native verification, which runs the real `codex
sandbox`. No real-model or sandbox trial has run against this source, so the
exit 0 path is unproven. In the repository suite, a fixture run with
acceptance recorded runs `finish` and reports `obligations.verifiedComplete:
true`, and its injected verification fixture keeps the state `unresolved`
with exit 4. `workflow-status` reads only. It exits 0 only when no attempt is
unresolved, no effect is unknown and the run lifecycle is `running`, and 4
otherwise, including an absent run and a run whose lifecycle marker reads
`suspended`. Attempts recorded before an integration moved the run branch to
the after-ref its integration receipt names read `superseded`, which is not
unresolved, so a normally finished run reports `reconciled`.
`workflow-resolve` takes
`{"version":1,"runId":"<id>","effectId":"<id>","outcome":"<outcome>","reason":"<token>"}`,
where `reason` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; any other reason
exits 2 with an error saying it must be one token with no spaces. Outcomes
depend on the effect kind: `agent-dispatch` takes `not-started` or
`completed`, while `pr`, `vault` and `publication` take `completed`,
`failed` or `unknown`. It records only a local observation of an effect
already in the journal, performs no external action, and exits 2 for an
effect the journal never recorded or an outcome its kind does not take.

`workflow-accept` reads
`{"version":1,"runId":"<id>","tree":"<tree id>","criteria":[{"criterion":"<token>","status":"pass|fail","note":"<text>"}]}`
with 1 to 20 criteria, each named once and each note at most 1,024
characters. It exits 2 for a relative `--file`, a run with no retained
request, a tree other than the run branch's current tree, or a run branch
that is no longer at the tip its last completed integration recorded. It
retains one `acceptance-evidence` artifact per criterion holding
`{version, criterion, tree, status}`, records them as a completed
`acceptance` journal step and exits 0. `workflow-resume` passes the retained
references to the controller, one per criterion; the code keeps the latest
one recorded for a criterion, a choice no test pins yet. The evidence is a
local operator observation, not authenticated authorization.

`workflow-prune` treats every artifact a journal event references as live
and never removes it. Non-live content goes when it is older than
`maxAgeMs` or larger than `maxArtifactBytes`, while the run is over
`maxRunBytes`, or while the store is full; when the journal references no
artifact at all, everything goes. It prints what it removed and kept (each
kept entry marked live or not), the bytes left, unresolved references and
whether the retention limits hold, and exits 0. An invalid run id exits 2.
An unreferenced artifact within its bounds is kept.

Resume rereads the retained request and the committed contracts, reuses prior
outputs only after revalidating them, and always reruns `collect-reviews` and
`gate`. In the 2026-10-07 trial a controller killed during the gate was
resumed without redispatching any model or repeating the merge. Each agent
step (`dispatch`, `dispatch-reviews`) is journaled as an `agent-dispatch`
effect whose start is persisted before the spawn. One that was interrupted or
timed out is an unknown effect: status exits 4 and resume will not redispatch
it until an operator resolves it with `workflow-resolve`. `not-started` lets
resume redispatch the step; `completed` lets resume reuse it once its outputs
validate, and blocks it when they do not. `doctor` reports the same journal
summary.

Repair rounds. A gate FAIL (exit 1) is a code failure and goes to the
existing `fix --verdict` decision. On `retry` the controller runs
`record-fix-round` for each named task, then `dispatch --fix-round --task
<id>...` for exactly those tasks, then review, collection, gate and
integration again under round-suffixed step ids. Rounds per phase are
bounded by the smaller of `maxRepairRounds` and the phase's manifest fix
budget and, when the driver journal is in use, by 9 (the driver's 10
attempts per task less the first dispatch). `escalate`, a `none` decision
for a failed verdict, or an exhausted budget stops the run `failed`; the
report's `host.repairRounds.delivered` counts the rounds run. Gate exit 5 is
classified as infrastructure and never reaches the fix decision.

Two `dispatch` flags serve the controller. `--execution <absolute path>`
names a JSON execution contract `{version: 1, common, runId, executionId,
inputs, retention, maxAttempts, deadlineAt}` that is passed unchanged to the
driver as its required execution, so the driver journals each attempt. The
controller writes one per dispatch attempt under
`.fleetmates/<run>/execution/` and appends the flag to every `dispatch` argv,
except for a cursor harness or a files sandbox, which strict driver execution
refuses; the report then names the driver journal unavailable. The contract
it writes always says `maxAttempts` 10, whatever the request's
`maxAttempts`. `--fix-round --task <id>` (repeatable) dispatches only the
named tasks of the phase with the fix-round brief, which checks the task
branch out without resetting it, and respawns them even when a `done` result
is recorded. `--task` without `--fix-round`, `--fix-round` without `--task`,
a task outside the phase, a relative `--execution` path and a missing
contract file all exit 2 before any probe or spawn.

Storage is private and local: the journal is under
`<git-common-dir>/fleetmates-execution/<sha256 of run id>/` (at most 1,000
events and 1 MiB) and artifacts under
`<git-common-dir>/fleetmates-artifacts/<sha256 of run id>/<sha256>.bin`, with
0700 directories and 0600 files. Artifacts can contain task summaries, private
log paths and command output. `workflow-prune` removes what no journal event
references once it is past its bounds; delete a run's two directories by hand
to drop live evidence as well.

Integrator dispatch outside the workflow. The controller merges in its own
host-bounded mode and uses neither legacy `dispatch-integrator` mode; both are
kept by owner decision. Both exit 4 before spawning unless the run's status
records a PASS for the current phase. Without a flag the integrator agent runs
in full mode in the main checkout, and the command exits 0 once the process
exits, printing that completion is unverified: nothing checks what it did.
`--isolated-legacy` is a bare flag (a value exits 2). It also requires the
recorded PASS to match the current phase, anchor, plan hash and task tips and
an ownership preflight to pass, and it exits 4 unless the harness supports
effort, the configured sandbox mode is `full` and the integrator role has a
model. It spawns the agent in a registered worktree on the run branch under
`.fleetmates/<run>/sessions/`, and accepts the work only if the process exits
0, the result is `done` for the run branch with files inside the phase's
declared sets, the worktree is clean, the run branch gained exactly one
first-parent merge per task in plan order whose parents are the previous tip
and the recorded task tip, ownership passes, and the run ref did not move
during validation. The worktree is kept. Trust limits: the agent runs with
full authority as the same user, and its filesystem, network and publication
restrictions are prompt instructions, not confinement. The checks come after
the fact and observe refs, the main checkout, the worktree and the result
file only, so anything else it did, such as a remote action or a write
outside those, is not detected. On either mode, a committed, valid
`--role-policy` or `--environment` contract exits 4; a missing, uncommitted,
modified or invalid one exits 2; neither spawns, because a required policy
never falls back to legacy dispatch.

Limits: the read-only PR outcome query has no CLI entry point; Vault and
publication effects have no adapter. Observations are same-UID local
evidence, not isolation from a hostile process. Driver recovery does not keep
Deck terminals alive across a deckd restart. See the
[execution and recovery validation](../../docs/specs/2026-10-06-execution-recovery-validation.md)
for the real trials, findings, open items and issue matrices.
