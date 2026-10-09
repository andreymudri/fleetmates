# What installing fleetmates registers

Moved from the project README. See the [README](../../README.md#quick-start) for the install commands.

## Hooks and the Stop guard

Beyond the skills and commands, the plugin declares a `SubagentStop` hook with no matcher and
`async: false`. That means **every** subagent stop on this machine — in any project, including one
with no fleetmates run — synchronously spawns `node scripts/subagent-stop.mjs` before the stop is
allowed to complete.

The handler is written to be cheap and to fail open: it resolves the stopping agent through a
worktree location record and returns immediately when it finds none, which is the case for every
subagent outside a run, and any error is an allow. But it is a synchronous spawn on a hot path and
it is machine-wide rather than scoped to this repository, so it is worth knowing before installing.

The plugin also registers a synchronous main-session `Stop` guard. It enforces only an
explicit session binding, never the newest run in the repository. Bind the orchestrating
session on its run branch with:

```sh
node scripts/cli.mjs bind-session --run <id> --plan <path> --session <session-id> --base <base>
```

The guard recomputes `finish --enforcement-only`, blocks once on failed or unresolved
checks, and displays skipped obligations. A cheap PASS does not establish delivery
completion. Missing bindings, changed requirements, process errors, timeouts and the
harness retry escape allow stopping. Process death is not prevented. The unbound path
costs one Git discovery process. Verify live callback behavior with `doctor --hooks --stop --session <session-id>`
in the installed harness. A receipt records that this handler fired, not that delivery passed.

Use `suspend --run <id> --plan <path> --base <base>` to pause, `resume --run <id>` to
continue, or `abandon --run <id> --plan <path> --base <base>` to end that run identity.
`run-status --run <id>` reports their Git refs. Suspension and abandonment never mean
verified completion. Marker refs are writable local observations, not authenticated
operator identity or authorization. No transcript is stored in the session binding.

## Update notices

Claude Code updates plugins in the background and says nothing, so a new version usually arrives
silently. This plugin tells you two things instead.

**Which version you are on, and whether the install actually works.** The first session after the
installed version changes, the plugin reports the change, links its release notes, and confirms
what it found — `ready: 14 skills, 3 agents, cli ok`. Once per version, then silent. No network.

If parts are missing it says so instead, naming them, and repeats that **every** session until
fixed:

    WARNING: fleetmates is installed but NOT fully working. Missing: scripts/cli.mjs.
    Fleet commands and phase gates will fail. Reinstall with /plugin install fleetmates.

Note what this cannot tell you: whether the plugin is *enabled*. Claude Code only runs a plugin's
hooks when `enabledPlugins` has it turned on, so if it were off, nothing here would run to report
it. The check covers the failure you can actually hit with it on — a partial unpack, an interrupted
update, a missing `node`.

**Whether a newer one is published.** A background check compares the installed version against the
published one and reports a newer one on a later session. It runs at most once every 24 hours.

The check is a single `GET` to `https://registry.npmjs.org/fleetmates/latest`, the npm registry's
record of the newest published version, with a five-second timeout. It sends nothing about you, your machine,
or your project beyond the request itself, and it runs in a hook declared `"async": true`, so it
never delays a session. If it fails — offline, proxied, no `curl` — it exits silently, and the
24-hour limit still applies: the attempt is stamped before it is made, so a machine that can never
reach the registry does not retry on every session.

Turn it off with:

    FLEETMATES_UPDATE_CHECK=0

`CLAUDE_TEAMMATES_UPDATE_CHECK=0`, the name from before the rename, still works, so an opt-out set
under the old name is not switched back on.

Both notices keep their state in `${CLAUDE_CONFIG_DIR:-~/.claude}/fleetmates/`: the version
you last saw, and the cached result of the last check. Deleting that directory re-shows the current
version's notice once.

Because the check writes a cache the *next* session reads, a newly published version is reported
one session after the check that found it. That is the cost of never blocking session start.
