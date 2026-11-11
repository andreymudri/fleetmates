## On a harness other than Claude Code

When the orchestrator is not Claude Code, dispatch the reviewers and the integrator through the
CLI rather than the `Agent` path. The reviewer dispatch is:

    node "<fleetmates root>/scripts/cli.mjs" dispatch-reviews --run <id> --phase <name> --harness <h> --root <project root>

and the integrator step is:

    node "<fleetmates root>/scripts/cli.mjs" dispatch-integrator --run <id> --phase <name> --harness <h> --root <project root>

Each is worktree-isolated and gate-identical, and the harness name is the one the orchestrator is
running in, passed explicitly.
