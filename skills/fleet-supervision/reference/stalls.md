## When a teammate stalls

A teammate that returns a status with no tip sha and no evidence, or that reports it is waiting on
something, has stalled. `liveness` is the check that surfaces it, and what it detects is an absence
of progress — no commit and no worktree write inside the window — not a backgrounded command. Every
stalled row carries one hint line:

      -> likely cause: backgrounded command waiting on a notification that never arrives; resume this agent (do not respawn) and tell it to run in the foreground

That names a likely cause; it is a guess, not a diagnosis. Two causes produce the same board, and
the hint names only one of them. A teammate may have backgrounded a long command deliberately. Or
it ran that command in the foreground and the harness moved it to the background at the harness
timeout of 120 seconds, against a suite that takes 200-340 seconds in this repository, leaving the
agent waiting for a completion notification that a detached command never sends. Neither cause is
ranked above the other, because no relative frequency has been measured: of the two stalls this
repository records, one attributes the first cause (run `codemap`) and one names no cause at all
(run `claims`), while the second cause has been reported by teammates in session and never written
down. So do not assume disobedience without checking which cause applies — and do not assume the
harness either. Treat the hint as the guess it is until the teammate's own account settles it.

At dispatch time, prevent it: tell the teammate to pass an explicit longer timeout on the
long-running command rather than relying on the default.

The recovery is to resume THAT agent with an instruction to re-run in the foreground with an
explicit longer timeout. Do not respawn it: a respawn discards the task's whole context, and a
returned teammate's worktree keeps its branch checked out, so a fresh dispatch fails with "already
used by worktree" until that worktree is pruned.
