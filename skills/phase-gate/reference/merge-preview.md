## What the `merge` check does

Before the `command` checks run, the gate merges the phase's task branches into a scratch
worktree under the system temp directory and runs those checks there. So `test` measures what
integration will actually produce, not the run branch as it stands.

The preview contains **tracked content only** — `git worktree add` does not materialize
`node_modules`, virtualenvs, or generated artifacts. A project whose test runner is itself a
dependency declares what to link:

    { "preview": { "link": ["node_modules"] } }

Check that declaration before a run rather than at the first gate, when the fix is still a
one-line manifest edit:

    node "<fleetmates root>/scripts/cli.mjs" preview-check --root <project root>

It applies the same rules the `merge` check applies and exits 1 naming any entry that is
missing, not a directory, escaping, repeated, or tracked.

The gate symlinks each declared directory into the preview after the merge and removes the links
before the worktree. Entries must be repo-relative and inside the repository; an absolute path, a
`..` escape, a missing target, or a path the repository already tracks fails the `merge` check
naming the entry and the reason. A link that cannot be made is reported as a merge failure rather
than left to surface as a command-check failure, because a preview missing its build inputs
produces errors that look like code defects and are not.

**Links are shared, not copies.** A check that writes into `node_modules` writes to the real one,
because it is the same directory. That is the cost of linking; copying a real dependency tree is
minutes per gate run.

`--no-fleet` builds no preview, so nothing is linked and `preview.link` is not consulted.

A conflict fails the `merge` check and names both branches and the conflicting paths. The
`command` checks are then recorded `skip` — never `pass`. Treat a conflict like a process
violation: escalate it, do not retry. No single teammate can fix a conflict between two file
sets, so redispatching one owner cannot resolve it.

The preview is a preview. `tm-integrator` still performs the real merge with `--no-ff`, and a
passing preview is not permission to skip it.
