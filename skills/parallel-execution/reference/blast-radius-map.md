## The map

Every generated brief carries a **blast radius**: the files that have historically changed
alongside the task's declared set. They are outside the file set, so the teammate may not edit
them — they are what its change is most likely to break without touching. It is computed from
`git log` at dispatch time and stored nowhere, so it cannot go stale. Coupling for a brief is
computed over a fixed window of the last 500 commits, which the workflow path hardcodes and no
flag changes; `--commits` sets the window for the standalone `map` command only, and `workflow
--commits` is swallowed without complaint. A brief with no blast radius section usually means new
files rather than a broken dispatch: a declared file needs at least three commits of its own
history before coupling counts it, so a task whose files were just added gets no section even in a
repository with thousands of commits.

Ask the same question yourself for any file set:

    node "<fleetmates root>/scripts/cli.mjs" map --files <a,b> --root <project root>

Coupling is correlation in history, not a dependency: a source and its test, a caller and its
callee, and two files one person kept tidy all look alike to it. Nothing enforces it and no gate
reads it — a map that could fail a phase would be a map worth gaming.
