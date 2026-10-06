# Workflow completion and interruption (#25 W01)

## Contract

A session stop is not delivery completion. The Stop guard runs the existing
`finish --enforcement-only` path, reports its skipped obligations, and never
promotes its result into full verification. Only the unfiltered finish path
can establish completion, with current command and review evidence.

An operator explicitly binds a session to one run using `bind-session`.
The binding lives under the Git common directory, keyed by a hash of the
session ID. It names the repository, exact run branch ref, base branch,
tracked plan path and anchored plan content hash. There is no newest-run
selection and no trust in status.json verdicts. A second, different binding
for the same session is refused. Changing a plan requires an explicit new
session binding rather than silently reusing previous requirements.

The hook makes one Git discovery call outside a bound session. Missing state,
missing bindings, malformed input, changed requirements, foreign branches,
process errors and timeouts allow the stop with a diagnostic when relevant.
A failed or unresolved finish blocks once; stop_hook_active allows the retry.
Git subprocesses and hook input/output have finite limits.

## Interruption

`suspend` and `abandon` write separate Git refs at the observed run tip;
`resume` deletes a suspension ref with compare-and-swap. Abandonment is final
for that run identity. These refs are operator-writable observations, not
proof of authenticated human identity or permission. Neither state means
verified completion. `run-status` reports the refs and their tips without
claiming historical checks apply to the present tree. Abrupt process loss
leaves the binding and refs intact; it never creates completion evidence.

Bindings and lifecycle markers are local and contain no transcript or secret.
No automatic Vault writes or network operations are introduced.

## Validation

Exercise actual temporary repositories, qualified refs, conflicting session
bindings, stale plan hashes, branch switches, marker transitions and the hook
handler's subprocess outcome mapping. Mutation checks must show each new
behavioral test fails when its relevant guard is removed. Full root tests
remain required. Live Claude callback verification is a separate owner check.

## Remaining roadmap

W02 requires real repeated workflow evaluations and independently labeled
outcomes. W03 requires versioned, bounded context selection with mandatory
instruction preservation. W04-W13 need separate bounded contracts and tests;
W14 requires bottleneck evidence and W15 an explicit release requirement.
Nothing in this specification declares those workstreams complete.
