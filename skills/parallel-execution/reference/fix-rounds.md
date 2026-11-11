## Why fresh implementers, and how review fits between tasks

This section describes a review check scoped `phase`, which each phase gate carries. A review check
with no `scope` is scoped `run`: the phase gates between tasks then run the command checks,
`fileset` and `ownership` but no review, and the review runs once on the integrated run, as
phase-gate's section "Review the run" describes.

Each teammate is a **fresh** agent carrying only its own task's context — the brief for
that task, the interfaces it touches, and the global constraints. It never inherits the
session's accumulated history or another teammate's context. A dispatch built from pasted
history of prior tasks defeats this: hand over files and pointers, not narrative.

Review happens **between tasks, not only at the end**: each teammate's result gets its
task-scoped gate (Step 4) before the next phase starts, catching spec and quality gaps
while the context to fix them is still cheap. The broad review at branch completion
(`phase-gate`'s final pass) never substitutes for this — it catches cross-task drift, not
per-task defects.

If a teammate needs a fix round, address the live teammate first: `SendMessage` the teammate that
owns the failing task, by the id its dispatch returned, with the finding text. Its worktree still
holds the context a cold respawn would have to rebuild. Respawn on that task only when that
teammate is gone; a respawned teammate re-runs `locate`, which overwrites the record with its new
worktree. Note in `status.json` that the task restarted.

**Brief a fix-round respawn with `brief --fix-round`, never the ordinary brief.** The ordinary
one opens with `git checkout -B <branch> <base>`, which resets the task branch to the base and
destroys the very work the round was convened to repair. `--fix-round` emits the same brief with
a checkout that does not reset, and tells the teammate to report `blocked` rather than free a
branch a dead worktree still holds — that removal is yours, because the worktree guard blocks a
teammate from touching another worktree at all. A teammate inside a running `Workflow`
cannot receive `SendMessage`, so a phase dispatched through the `Workflow` tool has no live
teammate to address and its fix round respawns.
