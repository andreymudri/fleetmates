## Choosing a model per dispatch

Every task in `plan.json` carries a `tier`, either declared in the plan or inferred by
`init-run`. Read it; do not re-derive it. Resolve it at dispatch:

    cheap    -> haiku
    mid      -> opus
    capable  -> opus

`mid` runs on opus because a replay of 30 already-merged tasks measured it: opus passed 29 of 30
at a mean US$1.52 and 5.4 minutes per task. Sonnet, the tier's previous model, passed 29 of 30
at US$3.87 and 14.1 minutes. The data and the tool that reran it are in `tools/replay/`. To
restore sonnet for `mid`, dispatch `mid` tasks on sonnet and pass
`--models '{"cheap":"haiku","mid":"sonnet","capable":"opus"}'` to `workflow` — configuration
stores tiers, not models.

An omitted model inherits the session's, which is usually the most expensive tier, and that
cost multiplies across every teammate in a phase. Set it explicitly on every dispatch — task
dispatches and role dispatches alike. There is no dispatch that legitimately omits its model.

Role dispatches are fixed and not read from the plan: `tm-integrator` runs at `cheap`,
`tm-reviewer` at `capable`. Review is the last line of defence before integration.

The integrator's tier is measured, not assumed: `tools/replay/data/integrator-verdict.json`
records the verdict `cheap`. Replayed on 14 past integrations, haiku and sonnet, the control,
each passed all 14 with no wrong-tree result, at a mean US$0.049 against US$0.171 per
integration. None of those integrations had a conflict, so the measurement covers clean
integrations only, and how haiku resolves a conflict is unmeasured. The `tm-integrator` contract
escalates every conflict, with both hunks and the owning task ids, instead of resolving it: the
phase gate's `merge` check already fails on any conflict between the same branches, so a
conflict at integration means the tree changed after the gate. Set `agents.integrator.tier` to
route integration higher.

The `tm-integrator` dispatch carries the configured integrator tier and effort, read with
`config get agents.integrator.tier` and `config get agents.integrator.effort`. `config get` on
an unset key exits 2 with `unset: <key>` — the same exit code every hard config failure uses,
but here it is the normal case, not an error. Tier and effort fall back differently:

- `unset: agents.integrator.tier` — dispatch at the **fixed integrator tier, `cheap`** (model
  `haiku`). Do not omit the model to inherit the session's; the fixed role tier is the
  fallback. A configured tier replaces `cheap`. The same shape holds for `tm-reviewer`, whose
  fixed tier is `capable` — see `phase-gate`.
- `unset: agents.integrator.effort` — omit the `effort` option, and the dispatch inherits the
  session's effort. Effort is the only option that falls back by omission.

These two keys are ergonomics, not enforcement, unlike the reviewer's tier and effort: the
integrator merges branches, it does not judge a check, so either layer may set them and the
gitignored `fleetmates.local.json` is the normal place to.

When generating a Workflow, pass the same map through so the generated dispatches carry
concrete models:

    node "<fleetmates root>/scripts/cli.mjs" workflow --run <id> --phase <n> --root <root> \
      --models '{"cheap":"haiku","mid":"opus","capable":"opus"}'
