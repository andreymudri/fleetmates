# Execution prerequisites for open issues 44 and 45

## Destination

Dispatch can establish an observed, bounded environment baseline and enforce
declared role capabilities through supported adapters before starting a task.
Unsupported required capabilities refuse execution rather than becoming a
permission or an implementation failure. This is the first implementation
group of the approved open-issues delivery design.

## Global Constraints

- Node >= 24.2.0; zero new core runtime or development dependencies.
- Commit messages: single-line, commitlint style, English; configured author only.
- No personal identities, real home paths or credentials in public artifacts.
- Do not modify existing gate manifests, existing plans or fleet state by hand.
- Use the CLI for fleet state and worktree-isolated task branches.
- Existing Git-derived gates, test inventory, protected paths and finite execution bounds remain required.
- Recipes and retrieved text cannot grant network, publication or shared-ref capabilities.
- Preserve existing adapter callers when no new required contract is provided; new contracts never silently downgrade to legacy behavior.
- Observe targeted failing mutations for every new behavioral test, restore code and run the complete affected suites.
- Read docs/specs/2026-10-06-open-issues-delivery-design.md before implementation.

## Contracts between tasks

All three producer modules use version 1 and return serializable observations.
They never mutate a tracked manifest, plan, learning or permission configuration.
Identity is SHA-256 of canonical, ordered content, excluding timestamps,
duration, raw output and machine-specific temporary paths. Actual log references
are retained separately. Toolchain/platform/lockfile/recipe changes invalidate
the environment identity; unknown metrics remain null.

T1 exports `validateEnvironmentRecipe(value)`,
`captureEnvironment({ git, commit, recipePath, cwd, execute = false, exec,
now })`. `git` is the existing createGit object; `commit` is exact; the recipe
is an anchored regular blob no larger than 512 KiB. `exec` uses the defaultExec
signature and is injectable for meaningful process tests. Setup/baseline checks
use runCommandCheck with that executor and its retained evidence.

T2 exports `validateRolePolicy(value)` and
`resolveRoleCapabilities({ policy, role, harness, sandboxMode, network })`.
The resolver returns `{ version: 1, ready, blocked, requested, enforcement }`.
The adapter consumes its `enforcement` result, never prompt text. Policy entries
are exact booleans for `read`, `write`, `execute`, `network`, `sharedRefs` and
`publication`. Policy is a versioned object with an explicit roles map.
Unknown roles, keys and wrong types are malformed input. A reviewer can request
read and execute but cannot request write, sharedRefs or publication. A network
request cannot widen the host's `network` value. Required unsupported execution
or sandbox capabilities make `ready` false, naming the missing enforcement.

T3 exports `probeCapabilities({ required, harness, env, exec })` with
`required` drawn from `harness`, `render`, `ci` and `vault`. Return
`{ version: 1, ready, observations, blocked }`; each observation contains
`capability`, `state` (available/unavailable/unknown), `reason`, and bounded
version metadata where observed. No supplied status bypasses the actual probe.
The executor is the existing defaultExec signature. Probe stdout/stderr is
bounded to 64 KiB, timeout to 5 seconds and cleanup grace to 250 ms. Commands
use executable/argv arrays without a shell or model turn. Optional services
are not probed unless requested. Unknown/missing required capability blocks.

T1 recipe shape:

```json
{
  "version": 1,
  "toolchains": [{ "name": "node", "command": "node", "argv": ["--version"], "expected": "v24." }],
  "lockfiles": ["package-lock.json"],
  "setup": [{ "name": "install", "run": "npm ci", "timeoutMs": 60000 }],
  "baseline": [{ "name": "test", "run": "npm test", "timeoutMs": 60000 }],
  "required": ["harness"],
  "dependencies": "clean-checkout"
}
```

The same fields can declare linked dependencies. Lockfile paths are validated
repo-relative regular anchored blobs; missing declared lockfiles refuse the
snapshot. Setup/baseline arrays are bounded to 20 entries each, toolchains and
lockfiles to 20 each. Arbitrary nonzero output is an environment failure for
this preparation step, not evidence of a code defect. `execute: false` is an
explicit not-executed observation and cannot satisfy dispatch's required baseline.
Keep toolchain comparisons explicit and bounded; the expected prefix is a
declared compatibility requirement, not a replacement for the actual version.

## Out of Scope

- Completing evaluations and closing issues 44/45 in this producer group - actual clean-checkout and consumer enforcement trials follow integration and feed issue 34.
- Changing the default gate policy - preserve the existing tracked checks.
- Adding another execution DSL - consume the fixed CLI/profile fragments.
- Production publication or Vault writes - a capability probe does not grant those permissions.

### Task 1: capture anchored environment recipes and executable baselines

**Files:**
- Create: `scripts/environment-preflight.mjs`
- Test: `tests/environment-preflight.test.mjs`

**Acceptance:**
- Validate the exact recipe contract and bounded nested values before executing any command.
- Read recipe and lockfile bytes from the exact committed anchor, refusing symlinks, missing files, unsafe paths, oversized inputs and uncommitted substitutions.
- Observe required tool versions with bounded argv-only probes and record platform, source hashes and dependency-layout limits.
- Execute explicitly requested setup followed by baseline checks through runCommandCheck, retaining logs, completeness and durations. An incomplete capture or setup failure blocks baseline and readiness.
- Return a reproducible identity that changes on relevant input/version/platform changes, while timestamps and private log locations do not change identity.
- `execute: false`, absent tools and malformed recipes never produce a ready baseline.
- Test actual temporary repositories, a clean dependency-free Node fixture, linked-layout disclosure, incompatible versions, storage/timeout failure and setup-before-baseline ordering.

- [ ] Step 1: Write the behavior tests for the recipe shape above, including `assert.equal(report.ready, false)` before execution and `assert.equal(report.baseline.status, 'pass')` only after actual successful execution.
- [ ] Step 2: Run `node --test tests/environment-preflight.test.mjs` and inspect the expected behavioral failures.
- [ ] Step 3: Implement the three anchored reads and executor pipeline using the existing createGit, runCommandCheck and defaultExec contracts; do not add dependencies or a second process runner.
- [ ] Step 4: Mutate each newly covered guard/ordering/hash behavior, observe its matching failing assertion, restore the implementation and run the full root suite.
- [ ] Step 5: Commit only the declared module and test file and return the test/mutation evidence.

### Task 2: define enforceable role capability contracts

**Files:**
- Create: `scripts/role-capabilities.mjs`
- Test: `tests/role-capabilities.test.mjs`

**Acceptance:**
- Validate versioned policy roles and the exact boolean fields before resolving any capability.
- Keep requested authority separate from actual adapter enforcement and host-approved network access.
- Never accept reviewer writes, shared-ref mutation or publication, including malformed/coercible values and role aliases.
- Map supported Codex read-only and workspace-write behavior and Cursor plan/ask behavior explicitly; report unsupported role/sandbox combinations instead of claiming enforcement.
- A retrieved-text field or injected extra key cannot broaden a role contract.
- Integrator shared-ref authority remains explicitly declared; absent publication capability stays false and cannot be inferred from clean checks.
- Default legacy callers remain separately identifiable; a new required policy has no silent compatibility fallback.

- [ ] Step 1: Write the blocked reviewer cases using `assert.equal(resolveRoleCapabilities(request).ready, false)` and explicit reason/enforcement assertions.
- [ ] Step 2: Run `node --test tests/role-capabilities.test.mjs` and inspect the intended failures.
- [ ] Step 3: Implement the pure validator/resolver with fixed supported adapter mappings and immutable returned policy values.
- [ ] Step 4: Remove each newly tested restriction in turn, observe its targeted assertion fail, restore and run the complete root suite.
- [ ] Step 5: Commit only the declared module/test and return the tested support and unsupported-enforcement matrix.

### Task 3: observe bounded optional capability probes

**Files:**
- Create: `scripts/capability-preflight.mjs`
- Test: `tests/capability-preflight.test.mjs`

**Acceptance:**
- Validate requested service names and harness names before probes, with at most one probe per capability.
- Observe authentication through the existing supported harness mechanism without exposing identity, token or credential text in the compact report.
- Browser readiness requires an installed executable/version; CI readiness requires the installed authenticated gh interface; Vault readiness requires an explicit installed adapter with its supported read-only capability probe. Absence is explicit, not an automatic install/download.
- Reuse bounded argv-only execution and cleanup; timeout/output-limit, spawn and parse failures cannot become available.
- Required unknown/unavailable observations block readiness; optional unrequested services incur no probe or network request.
- Test real bounded child processes for hangs, excess output and nonzero exits, plus fixture-backed auth/schema responses and secret-free summaries.

- [ ] Step 1: Write tests asserting `assert.equal(report.ready, false)` for a hanging or malformed required probe and asserting an empty call list for unrequested services.
- [ ] Step 2: Run `node --test tests/capability-preflight.test.mjs` and inspect the intended failures.
- [ ] Step 3: Implement the fixed probes through existing harness authentication and defaultExec, with output whitelist projection before reporting.
- [ ] Step 4: Mutate each tested limit, required-state check and whitelist selection, observe targeted failures, restore and run the full root suite.
- [ ] Step 5: Commit the declared module/test and report actual versus fixture-backed observations separately.

### Task 4: connect prerequisites to CLI dispatch and sandbox adapters

**Files:**
- Modify: `scripts/cli.mjs`
- Modify: `scripts/harnesses/codex.mjs`
- Modify: `scripts/harnesses/cursor.mjs`
- Test: `tests/execution-prerequisites.test.mjs`
- Test: `tests/harness-codex.test.mjs`
- Test: `tests/harness-cursor.test.mjs`

**Depends:** T1, T2, T3

**Acceptance:**
- Add `environment-check --file <json> [--execute]` using bounded readWorkflowInput and independently anchored recipe reads; malformed requests exit 2, unmet execution readiness exits 4.
- Add optional committed `--environment <recipe-path>` and `--role-policy <policy-path>` contracts to dispatch, dispatch-reviews and dispatch-integrator. Refuse missing/untracked/unsafe contracts and changed inputs before spawning.
- New required contracts invoke actual capability/environment checks and cannot accept declared available flags or not-executed baseline summaries.
- Pass resolved role enforcement into both spawn and resume argv builders. Codex required reviewer enforcement uses read-only without an added writable root; Cursor uses its observed supported read-only mode or refuses unsupported combinations.
- Preserve result artifact capture by the host, mandatory disabled Codex hooks, host network limits and existing files-sandbox control-path guards.
- Unsupported preflight blocks before makeSandbox/spawn/collect. Legacy invocations remain compatible and their unverified environment/capability limits remain explicit.
- Test CLI-level temporary repos and adapter argv/role propagation, including resume, changed contracts, setup failures, unavailable render/Vault and blocked shared-ref requests.

- [ ] Step 1: Write CLI integration and adapter regression tests before changing the dispatch path; assert no adapter spawn on a blocked contract.
- [ ] Step 2: Run the three declared affected test files and inspect the failures.
- [ ] Step 3: Add the command/flag routing, anchored validators and adapter enforcement propagation through existing dispatch paths.
- [ ] Step 4: Mutate new CLI refusal and adapter spawn/resume guards one at a time, observe failures and restore.
- [ ] Step 5: Run complete root and hub command checks plus instruction lint; commit only declared integration files.

### Task 5: document tested prerequisites and consumer obligations

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/2026-10-06-issue-25-progress.md`
- Create: `docs/specs/2026-10-06-execution-prerequisites-validation.md`

**Depends:** T4

**Acceptance:**
- Document exact committed recipe/policy shapes, command and dispatch flags, exit statuses and actual supported/unsupported role enforcement.
- Record setup time/logs, clean-checkout reproduction, linked-dependency limits, secret-free observations and no permission promotion from retrieved text.
- Exercise an actual clean temporary Node project and authenticated installed Codex preflight, plus browser and CI read-only probes; retain actual observations independently of fixture tests.
- Keep missing real workflow evaluation, unsupported adapter behavior and publication authority explicit; do not close any unsatisfied criterion.
- Record current root/hub, instruction lint, targeted mutation and correctness/security/tests/claims review evidence before integration.

- [ ] Step 1: Execute the documented commands in an isolated clean fixture project and inspect the real receipts.
- [ ] Step 2: Write the validation report with exact inputs and observed values; unknown metrics remain null and personal paths use placeholders.
- [ ] Step 3: Update README/progress without claiming later execution, evaluation, UI or recovery work is delivered.
- [ ] Step 4: Run `git diff --check`, instruction lint and the complete root/hub gate checks; commit only the declared documentation files.
