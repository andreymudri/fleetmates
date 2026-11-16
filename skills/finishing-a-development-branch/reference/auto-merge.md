## Auto-merge

`land.autoMerge` is false by default and is read only from the tracked `fleetmates.gate.json`;
`config set land.autoMerge true --local` is refused with exit 2. A repository opts in once:

    node "<fleetmates root>/scripts/cli.mjs" config set land.autoMerge true --root <project root>

Merge the pull request you just opened without asking only when every one of these holds:

- `land.autoMerge` is true and `land.mode` is `pr`.
- `ci-wait` exited `0` on the tip with at least one workflow run. A project with no remote CI
  (`no CI workflows: skipped`) is never merged automatically.
- No unresolved finding was surfaced in this run.
- `merge-guard` exits `0`. It refuses, with exit `1`, a run branch that changes the gate manifest,
  the flaky quarantine, any path in the base branch's `protected` list, or a CI workflow, because
  a run that rewrites the rules it is judged by must not judge itself:

      node "<fleetmates root>/scripts/cli.mjs" merge-guard --branch <run branch> --base <base branch> --root <project root>

Then merge it:

    gh pr merge <number> --merge

If any condition fails, leave the pull request open and say in one line which one failed. Never
pass `--admin` and never bypass a required review: auto-merge is the user's standing permission
to skip their own click, not to skip the repository's rules.
