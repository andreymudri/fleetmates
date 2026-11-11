## 3. Record results

Append every result to `status.json`. A teammate that returned nothing is `orphaned`, not
`done` — offer to respawn it.

Before dispatching a later phase, check whether the plan still describes the tree:

    node "<fleetmates root>/scripts/cli.mjs" plan-drift --run <runId> --plan <planPath> --root <project root>

It compares the working-tree plan against the plan at the anchor and separates drift that still
reaches the work from drift on an already-integrated phase, which exits 1. A later task's brief
that describes interfaces earlier fix rounds replaced, or acceptance criteria still demanding
behaviour a security fix removed, both surface here — and both are corrected in the dispatch, not
only in the plan, because a dispatch already sent carries the old text.

A returned `done` is a claim, not evidence. Check it against git before believing it:

    node "<fleetmates root>/scripts/cli.mjs" doctor --run <runId> --plan <planPath> --root <project root>

A teammate that skipped its `checkout -B` commits on the harness's own branch and leaves
`fleetmates/<runId>/<taskId>` pointing at the run tip with nothing on it: the returned `branch`
names a real ref, the task merges as a no-op, and `fileset` sees no stray path because it sees no
path at all. `doctor` reports that branch as contributing nothing, along with anything else that
moved in the repository while the phase ran.

## 4. Gate, then integrate

Run `phase-gate`. Only on PASS, dispatch `tm-integrator` to merge the teammate branches in
dependency order with `--no-ff`. The integrator is the sole writer to the run branch and runs
alone. No bookkeeping call follows the merge: the next phase is derived from what is merged.

### Import coupling across tasks

A task whose file set imports a symbol another task introduces cannot build on its own branch.
Merging it first produces a commit whose tree cannot load. In run `followups2`, T2's
`scripts/doctor.mjs` imported `printable` from T3's `scripts/reviews.mjs`; on T2's own tip the CLI
died at import before printing its help, and merging T2 ahead of T3 would have carried that
unloadable tree onto the run branch. A revert of the providing task breaks every consumer, not only
the feature that motivated it.

The softer form leaves the tree loading and only a comment wrong. In run `followups3`, T3's change
to the CLI entrypoint carries a comment citing `reviewFileName` as precedent for wrapping before
quoting: true once T2's `scripts/reviews.mjs` is merged, false on T3 alone. Nothing fails to load —
the commit's comment is simply wrong about its own tree, and the merge order was given to the
integrator for that reason.

Both forms share one rule: the integrator merges in dependency order, and a reviewer judging a
cross-task claim judges it on the merge, not on one branch.
