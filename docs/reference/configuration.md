# Configuration subcommands

Moved from the project README. The keys themselves are listed under [Configuration](../../README.md#configuration) in the README.

## The four subcommands manage ergonomics, not enforcement

    node scripts/cli.mjs config list
    node scripts/cli.mjs config get maxParallel
    node scripts/cli.mjs config set <key> <value> [--local]
    node scripts/cli.mjs config unset <key> [--local]

`get`, `set` and `unset` accept only the four ergonomics keys in the table above. They do **not**
accept `phases`, `lens` or `preview` in either file — including without `--local`:

    $ node scripts/cli.mjs config set lens correctness
    unknown config key: lens        # exit 2

That is deliberate, not a gap. Enforcement policy is edited **by hand** in `fleetmates.gate.json`
so it lands as a reviewable diff rather than as a CLI mutation that leaves nothing to read.

**Check a hand edit with `config list`.** It *validates* more than it *prints*, and the two sets
are worth keeping apart. What it prints is fixed: the eight ergonomics rows in the worked example
below, and nothing else — `phases`, `lens` and `preview` never appear in its output. What it
validates is the whole of both layers, so it exits 2 with a message on a file that is no longer
valid JSON, a malformed ergonomics key, or a badly *shaped* enforcement key:

    $ node scripts/cli.mjs config list          # fleetmates.gate.json holds "lens": "performance"
    lens must be a non-empty array of strings   # exit 2

To read back an enforcement key's value, open `fleetmates.gate.json`. No subcommand will show it.

**`config list` checks shape, not content, and the difference bites.** A `lens` of `["nonsense"]`
is a well-shaped array of strings, so it is accepted, and `config list` exits 0 without printing
it. Whether those lens names mean anything to a reviewer is only exercised when the next `gate`
dispatches one — the same is true of a check's `run` string or a `preview.link` path. Shape is
structure and the CLI can see it; content is policy and only a real run can.

**Do not reach for `config get` here.** It rejects every enforcement key by name, in either file,
and that rejection says nothing about the manifest:

    $ node scripts/cli.mjs config get lens
    unknown config key: lens                    # exit 2

`config list` is the verification step; `config get` is for the ergonomics keys in the table above.

`list` reads both layers; `set` and `unset` write the tracked manifest unless you pass `--local`.

Worked example — raise the fan-out on a large machine without committing that choice:

    $ node scripts/cli.mjs config set maxParallel 12 --local
    wrote fleetmates.local.json

    $ node scripts/cli.mjs config list
    maxParallel  12  (fleetmates.local.json)
    caveman      false  (default)
    agents.implementer.tier    -  (default)
    agents.implementer.effort  -  (default)
    agents.reviewer.tier    -  (default)
    agents.reviewer.effort  -  (default)
    agents.integrator.tier    -  (default)
    agents.integrator.effort  -  (default)

In a project whose `.gitignore` does not yet exclude the file, `config set --local` adds the
entry and reports `added fleetmates.local.json to .gitignore` on a second line. This repository
already carries that entry, so the transcript above is what you get here.

`config list` prints the layer each *ergonomics* value came from, so a value you did not expect
can be traced to the file that set it.

**Model names never appear in either file.** Configuration stores a *tier* — `cheap`, `mid` or
`capable`. The map from tier to a concrete model lives in the dispatching skill and reaches the
CLI through `workflow --models`, so this repository and `fleetmates.gate.json` stay free of model
names that would otherwise go stale. Setting a model name as a tier is rejected.
