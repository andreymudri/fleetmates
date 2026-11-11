## On FAIL

Ask the CLI for a fix decision before asking the user. Hand it the run, the failing phase, the
run root, and the verdict JSON you just produced; it prints one of three decisions — `none`,
`retry`, or `escalate` — and exits 0 for all three, so read the `decision` field rather than the
exit status.

    node "<fleetmates root>/scripts/cli.mjs" fix --run <runId> --phase <n> --verdict <path> --root <project root>

`--verdict` names a file holding that same JSON, and `--phase` must match its own `phase` field —
a mismatch exits 2 rather than adjudicating the wrong phase's findings, and so does a malformed
`fleetmates.gate.json`. Exit 1 means the run has no plan at all or the verdict file could not be
read: an argument error, not a decision. Exit 0 covers `none`, `retry`, and `escalate` alike, so
the exit status never tells them apart — only the `decision` field does.

**`fix` does not apply to a `--no-fleet` gate, and this whole section does not either.** `--phase`
here must be an INTEGER, because tasks and fix rounds are keyed by numeric phase. A `--no-fleet`
gate names its phase from the manifest instead — `default`, typically — and emits a verdict
carrying `phaseName` with no integer `phase`, so handing it to `fix` exits 2 (a third cause,
alongside the phase mismatch and the malformed manifest). That is not a defect to work around:
`--no-fleet` builds no preview and has no task branches, so there is no teammate to redispatch and
nothing for a decision engine to attribute a finding to. **Fix the findings directly, then re-run
the gate from scratch for a fresh verdict.** Everything below about `retry`, `escalate` and the
round budget presumes a fleet phase with task branches. Two rules still bind on a solo gate, and both are restated here in full rather than cross-referenced:
**a PASS reached after N rounds of fixes is reported as such, never as a clean first-pass PASS**,
and **a check that was skipped is reported as skipped, every time**. A solo gate writes a verdict
into `status.json` only when the caller passes `--run`, and a solo gate invoked without `--run`
writes no verdict anywhere.

**The verdict you hand it must be the JSON this gate printed in this same pass, and must never be
read back from `.fleetmates/`.** The only verdict persisted on disk lives in
`status.gates[<phase>]` inside `.fleetmates/<run>/status.json`, written by the very agents this
gate exists to enforce — the same file `scripts/enforce.mjs` refuses to consult when picking a
branch. Feeding that record in today degenerates harmlessly, because the persisted object carries
no `results` key and the decision comes back `none`; that is incidental, not guaranteed. Treat it
as a rule so a change that starts persisting `results` cannot quietly turn the on-disk record into
a decision input.

On `none`, the decision engine found no failing check in the verdict you handed it. **This does
not mean "the failure needs no fix" and it is never permission to integrate.** You reached this
section because the gate failed, so a `none` decision means the verdict you passed is not the
one that failed — a stale file, the wrong phase, the wrong run root, or a verdict written before
the last check completed. Re-derive the verdict by running the gate again from scratch and ask
again. Integrate only on a freshly recomputed PASS, never on `none`.

On `retry`, redispatch each listed task at the listed `tier`, resuming the same teammate so it
keeps its task context, and hand it the failing check names and the surviving findings. Then run
the gate again from scratch — never reuse the previous verdict, and never re-run only the
failing check.

A retried teammate that returns `blocked` ends the loop immediately. `blocked` means missing
input, and further rounds cannot supply it.

On `escalate`, halt before integration and report, in this order: the escalation reason, which
check failed, the exact command output or finding list, the offending diff hunks, the owning
teammate, and the round history — which tier ran each round and what failed each time. Then
offer three choices: retry the failing task with the findings fed back, override and proceed,
or abort the phase.

A PASS reached after N fix rounds is reported as such, never as a clean first-pass PASS.

**The round budget is a cost bound, not a security bound.** `fixRounds` lives in `status.json`,
which is written by the agents the gate enforces. A teammate that rewrites its own count buys
itself more retries — wasted tokens, not a false PASS, because the verdict is recomputed from
git every round. Do not describe the loop as tamper-evident; only `fileset` and `ownership`
carry that property.
