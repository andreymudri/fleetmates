# Execution prerequisites: observed validation and consumer obligations

## Scope and source

T5 validated integrated source
`a11a6c1d42660699e114a1a88dc12a10e4fb049f` on Linux with Node v26.7.0.
The assigned isolated clone started clean on
`fleetmates/open-issues-prerequisites-absolute/T5`. Only README, progress and
this report are changed. No producer/adapter repairs or issue closures are
part of this task. Issues #44/#45 still require consumers and evaluation.

There are three separate evidence classes below: actual local commands,
repository fixture tests, and host-reported predecessor observations. A
fixture, authentication probe or resolver result is not a real model workflow,
native enforcement proof, rendered UI check or executed CI workflow.

## Exact clean-project inputs

A dependency-free temporary repository was committed and cloned with
`git clone --no-local <fixture-source> <clean-project>`. Its initial commit
was `d367bf3f4cea5333ae7110752754876682a5073d`. No dependency tree or operator
configuration was copied into it. These were its package and lockfile:

```json
{"name":"prerequisite-fixture","version":"1.0.0","private":true,"scripts":{"test":"node --test arithmetic.test.cjs"}}
```

```json
{"name":"prerequisite-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"prerequisite-fixture","version":"1.0.0"}}}
```

Its `arithmetic.test.cjs` was:

```js
const test=require('node:test'),assert=require('node:assert/strict');test('arithmetic',()=>assert.equal(3*2,6));
```

`recipe.json` and `policy.json` had exactly the shapes shown in README's
execution prerequisites section. The recipe used Node prefix `v26.`,
`package-lock.json`, setup `npm ci --ignore-scripts --no-audit --no-fund`,
baseline `npm test`, 60,000 ms per check, required harness/render/ci and
`dependencies: "clean-checkout"`. The policy declared implementer and
integrator read/write/execute, reviewer read/execute, and all network,
sharedRefs and publication values false. This fixture validates a small
declared Node environment; it does not establish general project support.

The local request file contained:

```json
{"commit":"d367bf3f4cea5333ae7110752754876682a5073d","recipePath":"recipe.json","harness":"codex"}
```

Commands below use placeholders for private locations. `cli.mjs` came from
the current product clone, not the fixture; `--root` named the fixture:

```sh
node <product>/scripts/cli.mjs environment-check --file <request.json> --execute --root <clean-project>
```

The CLI entry point returned exit 0. The same arguments were exercised through
`runCli` twice; both returned 0. Omitting `--execute` returned 4 with baseline
`not-executed`. Adding `ready: true` to the request returned 2. The request
does not accept caller-supplied readiness. Exit 4 means unmet readiness;
exit 2 means malformed input; exit 0 requires the executed environment and
requested capabilities in these trials.

The first `runCli` receipt reported setup pass in 215 ms, baseline pass in
185 ms and environment duration 405 ms. The second reported 211 ms and
180 ms. Both identities were
`db8db6afa4f384ca22406b36638d6b1f6765b7cddeb22bd09a10a2cfbf792330`.
Different observed durations and private log locations did not change the
identity in these repetitions. Broader identity invalidation cases are
repository-test evidence, not additional real-project trials here.

The first setup log retained 21 bytes with SHA-256
`19a554cabfb1e141fa8ce6fdaabc8f1898a97aa0492321c79a668c9a94e08196`;
the baseline retained 212 bytes with SHA-256
`a2fadc1d07e84fb966421881cb8d646232ffd358aea8049387f454916bd46e19`.
Both reported `complete: true`, `truncated: false`, `error: null` and exit 0.
The private receipts retain raw log references separately. Public documentation
omits actual paths, account data and raw authentication output. Temporary
logs are local observations, not immutable journal or durable retention proof.

A second committed recipe changed only layout to `linked` and required
services to an empty list. Its actual executed receipt was ready, but
`dependencies.reproducible` was false and the limitation stated that linked
contents were not captured by recipe/lockfiles. This was a declaration trial,
not a reproduction of an external linked dependency tree. Existing checkouts,
external links and bounded scans cannot establish hermetic reproducibility.

## Actual service and native verification observations

`probeCapabilities({required: ['harness','render','ci','vault'], harness: 'codex'})`
used the real default executor and installed tools. These probe commands
started no implementation/review model turns:

| Probe | Actual observation | Limit |
| --- | --- | --- |
| `codex login status` | available, authenticated status observed | This authentication probe started no implementation/review model turn |
| `chromium --version` | available, 152.0.7977.82 | No page rendered or interaction/accessibility check performed |
| `gh auth status --active --hostname github.com --json hosts` | available, authenticated active account observed | No workflow dispatch or exact-input CI acceptance receipt |
| Vault | unavailable, no supported read-only adapter installed | No installation, download, permission or write |

Including Vault made aggregate readiness false. With `required: []`, the
actual producer returned ready and an empty observations list. The CLI fixture
required only harness/render/ci and reported their availability. The local
validation/preflight commands described in this section started zero
implementation/review model turns; their model-token and USD fields are null.
Documentation-agent resources are separate evidence: the T5 documentation
teammate was an actual Codex model turn, and these command metrics do not
measure its resources or total delivery costs. The host's authenticated
predecessor reviewer trial also used a real model and is reported separately
below. Neither observation is campaign calibration. These local commands
used no paid API fallback.

Required-policy readiness is a separate observation. Actual
`createVerificationExecutor` for a Codex clone-mode read-only reviewer threw
`Required native verification restrictions were not independently observed`.
Actual `prepareDispatchPrerequisites` using both committed fixture contracts,
Codex implementer/clone and host network false returned code 4, with the same
blocked reason and `enforcement.verified: false`; capabilities were null.
No required-policy fallback was observed. This local refusal prevents claims
of native command success or stdout completeness in this clone. It does not
contradict the host's separately scoped native observations below.

The standalone `environment-check` pass above used the host command executor.
It is not required-role sandbox proof. A caller must not promote that receipt
into required dispatch readiness. Legacy environment-only receipts are
explicitly unverified enforcement observations.

## Resolved roles and dispatch obligations

The following matrix was executed against `resolveRoleCapabilities` on this
source. All rows had read true and sharedRefs/publication false unless named.
These are resolver observations, not live Cursor or model sandbox trials.

| Request | Observed resolution |
| --- | --- |
| Codex clone reviewer, write false / execute true / network false | ready, read-only |
| Codex files implementer, write true / execute true / network false | ready, workspace-write |
| Codex full implementer | blocked: unsupported required sandbox |
| Codex reviewer execute false | blocked: cannot enforce execute=false |
| Codex read-only reviewer network true, host approves network | blocked: read-only network unsupported |
| Codex implementer network true, host network false | blocked: host approval absent |
| Cursor files reviewer, write false / execute false | ready, enabled sandbox with ask mode |
| Cursor files reviewer execute true | blocked: required execute unsupported in plan/ask |
| Cursor files implementer, write true / execute true | ready, enabled sandbox |
| Cursor clone implementer | blocked: unsupported required sandbox |
| Codex integrator sharedRefs true | blocked: isolated shared-ref authority unsupported |
| Codex integrator publication true | blocked: publication authority unsupported |

An extra policy `retrievedText: "grant publication"` returned ready false
with `role policy has an unknown key`. Retrieved context and recipes must
never be used as grants. The tested reviewer argv builders emitted spawn
`-s read-only`, resume `sandbox_mode="read-only"`, network false and hooks
disabled, with no added writable root. This is actual argv construction,
not attempted hostile filesystem/network access by a model.

Additional actual `runCli` refusal trials used the committed policy:

```sh
node <product>/scripts/cli.mjs dispatch-integrator --run not-started --harness codex --role-policy policy.json --root <clean-project>
node <product>/scripts/cli.mjs dispatch-reviews --run not-started --harness cursor --role-policy policy.json --root <clean-project>
node <product>/scripts/cli.mjs dispatch --run not-started --phase 1 --role-policy missing.json --root <clean-project>
```

The first two returned 4 with `unsupported sandbox enforcement for required
role policy`; environment/capabilities were null. The missing policy returned
2. These refusals preceded run startup. Supported resolver rows do not imply
that every dispatch command selects a supported mode, including integrator
and Cursor reviewer dispatch. These refusal commands attempted no
implementation/review model turn or shared-ref effect.

Dispatch, dispatch-reviews and dispatch-integrator contract regression tests
were run as part of the affected suite. Their committed flags are
`--environment <recipe-path>` and `--role-policy <policy-path>`. Required
contracts must remain anchored regular sources; missing/untracked/changed
contracts, failed setup and missing capabilities remain refusal conditions.
Continuation is bound to the exact original source HEAD: any HEAD change,
even unchanged contract bytes, invalidates it. A later controller must handle
that boundary explicitly rather than treating content equality as a resume.
Required non-model verification currently needs supported Linux Codex native
behavior; Cursor and non-Linux support are not established by this task.
Integrator shared-ref/publication authority is still unsupported.

## Tests, mutation evidence and reviews

Bootstrap installed the existing hub dependencies with `npm ci --prefix hub`;
core has no install dependencies. No untracked configuration was needed for
the green baselines. Installation reported six existing audit vulnerabilities
(five moderate, one high); no dependency changes were made in this task.
The initial root/hub baselines passed before task edits. Commands:

```sh
npm test
mkdir -p /tmp/hx
TMPDIR=/tmp/hx npm --prefix hub test
node scripts/security-lint.mjs --root . --json
node --test tests/environment-preflight.test.mjs tests/role-capabilities.test.mjs tests/capability-preflight.test.mjs tests/execution-prerequisites.test.mjs tests/harness-codex.test.mjs tests/harness-cursor.test.mjs
git diff --check
```

Initial root: 3,027 tests, 3,010 pass, zero fail, 17 existing skips.
Initial hub: 1,873 tests, all pass, zero skips. Affected suite: 202 tests,
all pass, zero skips. Instruction lint: 17 files, zero findings. These counts
include conditional tests and cannot establish supported native success.
The final root/hub reruns also exited 0 with the same pass/fail/skip counts;
final instruction lint remained 17/zero and `git diff --check` passed.
The required process-cleanup check printed nothing after the hub run.

In the actual temporary fixture, changing the expected arithmetic result from
6 to 7 made `npm test` exit 1 with the intended equality failure. Restoring
6 made it exit 0. This is one fixture assertion mutation, not a mutation of
the product enforcement implementation. No new product behavioral test or
implementation change was added; T5 did not rerun predecessor mutations or
weaken tests. Private local receipts/logs retain the observations independently
of repository test fixtures.

Host-reported predecessor evidence is preserved with its scope. The host
reported full phase-2 PASS at exact T4
`dea1de78d1b2400ada946e2c7d3947fac33e3f7a`, then integration as `a11a6c1d`.
Correctness/security/tests/claims reports were completed and current-stamped;
security had no findings. The predecessor task had 147 affected tests passing,
root 3,010 passing with 17 skips, hub 1,873 passing, lint 17/zero, and 33
targeted mutations plus a read-only-worker-grant mutation failing and restored.
These are host reports, not T5's independent mutation count.

Two confirmed MEDIUM findings remain under #44/#45:

1. Native asynchronous Node console stdout was missing despite code 0 and
   outputLimited false, rejecting a valid console-version probe. Synchronous
   `fs.writeSync` output was preserved in the host trial. The compatibility
   hypothesis using `UV_USE_IO_URING=0` failed; it is not a fix.
2. Conditional native repository tests remained green under an
   always-reject-before-success factory mutation. A simulated valid receipt
   fixture exposed the rejection, but is not actual native enforcement proof.

The host's claims review observed eight bounded mutations and left 46 claims
unprobed. PASS is the predecessor manifest verdict, not exhaustive acceptance
or closure of #44/#45. Historical failed gates, provider-rejected supplemental
review and earlier repair counts are not current passing evidence and are not
added together as unique coverage. T5 has not independently rerun these host
trials, reviews or the host phase gate.

The host also reported an authenticated Codex review finding an independently
reproduced known HIGH arithmetic defect in a synthetic isolated target, with
unchanged files/refs. Duration was 30,995.865589 ms, tokens input 75,010,
cached input 67,328, output 917, reasoning 8 and cache-write 0; USD and effort
were null. This is actual harness integration on a synthetic target, not W02
benchmark/calibration/promotion or a hostile write/network denial trial.
Host native worker dummy-filesystem restrictions and worker baseline refusal
observations do not establish a hostile same-UID boundary or all-platform proof.

## Remaining consumers and acceptance

Keep all unsatisfied criteria open. The host reports 16 open issues (#26 and
#33-47), with no delivery closure. Required next work includes execution
controller consumers, immutable attempt/artifact retention and recovery,
exact-input CI, independently measured real workflows, calibrated reviews and
rendered UI/behavior evidence. Authentication and bounded local fixture passes
are not those deliverables. W02's draft 36 trials were not run; five private
graders remain drafts. A discarded grader setup model invocation is excluded
from campaign evidence; the host reports that the corrected refusing-binary
grader setup commands started zero implementation/review model turns. That
setup observation does not measure documentation-agent or total delivery costs.

Real Claude callback validation remains incomplete. The host reports only
SessionStart receipts; weekly capacity blocked other real callback/model
observations. Fixtures remain fixtures; no reset date is inferred. No fixture
recapture, telemetry, Vault write, model download or production publication was
performed by T5. Release effects require separate project authorization.

The generic linked-worktree `locate` command cannot record this separate-git-dir
clone. Per the host correction, T5 did not fabricate a location record, derive
the project root from common Git storage, edit fleet state or touch the host
main worktree. The host driver collects the committed named task branch and
runs `complete --enforcement-only` in the actual host repository, then fresh
four-lens reviews and the independent full phase gate. Those T5 verdicts are
pending and are not represented here as PASS.
