## Remote CI: commands, keys and exit codes

Before any push, run on this machine the CI steps this machine can run, so the remote CI confirms
rather than discovers:

    node "<fleetmates root>/scripts/cli.mjs" ci-local --root <project root> [--dry-run] [--keep-home] [--no-platform-sim]

It reads the workflows that run on a branch push or a pull request, takes each job whose
`runs-on` (or `matrix.os` list) is this operating system, and runs that job's `run:` steps in
order, with the step's shell, its `env`, its `working-directory`, and `GITHUB_ENV` and
`GITHUB_PATH` carried to the next step. Each job runs in an environment shaped like a fresh
hosted runner rather than this shell: an empty `HOME` and XDG directories (the toolchain
directories of mise, asdf, volta, rustup, cargo, pyenv, nvm and bun, and the npm cache, stay
visible), and the platform simulator's symlinked temp dir, `core.autocrlf=true` and `umask 077`,
with the workflow's own `env` applied over them. A test that passes only because of this
machine's own config, or only on a canonical temp path, fails here instead of on the runner.
`--keep-home` and `--no-platform-sim` turn either off; with the user's own `HOME`, a
`git config --global` step is undone after its step and the run names each file it restored. What it cannot reproduce it
skips and names: a `uses:` action, an expression other than `matrix.os`, `runner.os` and
`runner.temp`, an `if:` other than a `runner.os` comparison, an unusual shell, and every job for
another operating system. Those are what the remote CI is still for. Exit 0 means every step it
ran passed; exit 1 names the step that failed and nothing after it ran, so fix it before pushing,
and do not push; exit 3 means no step runs on this machine, so say that the remote CI is the
only check. `--dry-run` lists what would run and runs nothing.

Two config keys shape this step: `ci.push` is `ask` (the default) or `auto`, and
`ci.waitMinutes` is an integer from 1 to 720, 60 by default. Set either through the CLI, in the
tracked `fleetmates.gate.json` by default or with `--local` in the gitignored
`fleetmates.local.json`; any other value is refused with exit 2. The `config list` command does not print
them, so read one back with `config get`:

    node "<fleetmates root>/scripts/cli.mjs" config set ci.push auto --root <project root> [--local]
    node "<fleetmates root>/scripts/cli.mjs" config set ci.waitMinutes 30 --root <project root> [--local]
    node "<fleetmates root>/scripts/cli.mjs" config get ci.push --root <project root>

Then wait for the remote CI of the branch tip:

    node "<fleetmates root>/scripts/cli.mjs" ci-wait --branch <run branch> --root <project root> [--minutes <1-720>]

It reads the GitHub Actions workflow runs of the branch's tip commit through `gh api` every 30
seconds, for up to `ci.waitMinutes` minutes (60 when unset), or `--minutes` when given. It judges
whole workflow runs, not single jobs: every run on the tip must be completed with conclusion
`success` or `skipped`, and any other conclusion, `neutral` included, is a failure. A re-run counts
by its latest attempt. A run still queued or in progress is pending, and so is a tip on which no
run has started yet. Whether the project has workflows at all is read from the tip commit's tree,
not from the working tree.

Its exit code is the answer:

- `0`: every workflow run on the tip passed. It also exits `0`, printing `no CI workflows: skipped`,
  when the tip commit has no `.github/workflows`; tell the user the project has no remote CI, so
  this step was skipped.
- `1`: a run failed. It prints each failed run with its conclusion and its link.
- `3`: runs were still pending when the window closed. It prints them with their links.
- `4`: remote CI could not be read: `gh` is not installed or not logged in, the response was not
  readable, or the tip has more than 100 workflow runs.
- `2`: a bad invocation, such as a branch that does not exist or a `--minutes` outside 1 to 720.
