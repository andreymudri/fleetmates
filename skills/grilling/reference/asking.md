# Grilling: a worked question and its labels

> `AskUserQuestion`, one of the questions in a round (header `Ledger`):
>
> **Where does the run ledger live?** This decides who can corrupt it, and it sets up who may
> write it during a fix round.
>
> 1. label `Worktree` — `.fleetmates/<run-id>/` in the working tree. Simplest, but a task branch
>    can reach it, so "who may write it" stays open and needs a guard.
> 2. label `Common dir (recommended)` — one copy every worktree shares. Closes the
>    concurrent-write branch, and makes retention a git-cleanup question rather than a new one.
> 3. label `Temp dir` — survives a branch reset, lost on a fresh clone, so it reopens resume and
>    rebuild as branches of their own.

Labels stay short and plain, with the recommendation marked inside the label text: a label is
emitted verbatim, so markdown in it reaches the user as literal asterisks. No fourth entry is
declared for the user's own words; the prompt already offers one.

Where the orchestrator has no `AskUserQuestion` tool, offer the options as a numbered list and
read the user's pick, marking the recommended one the same way.
