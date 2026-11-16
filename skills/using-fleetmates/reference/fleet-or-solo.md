# Fleet or solo: the policy and the choice

Read this when a fleet is eligible, as `using-fleetmates` defines it.

### A real boundary

The fourth eligibility condition. A plan's steps, files and phases do not each need a task: one
owner end to end is the default. A task is a real boundary when it is one of:

- **Independent parallel output.** It can be built and verified without waiting for the result of
  another task.
- **A real prerequisite.** Another task cannot start until it lands.
- **Independent review.** Its result has to be judged by a reader who did not write it.

A plan whose tasks are slices of one piece of work fails this condition, however many files it
touches. Take the inline path and say why in one line.

### The fleet policy

When a fleet is eligible, read the `fleet.mode` key first:

    node "<fleetmates root>/scripts/cli.mjs" config get fleet.mode --root <project root>

`fleet.mode` is `ask` (the default) or `auto`. With `auto`, run the plan through `init-run`,
show the phase breakdown in one short message, and start the fleet without asking. With `ask`,
present the choice as described below. Set it per repository with
`config set fleet.mode auto`, or with `--local` for this checkout only.

### Presenting the choice

When a fleet **is** eligible and `fleet.mode` is `ask`, never ask in prose. Prose hides the two things the decision
turns on: how much runs at once, and what it costs to be wrong. Run the plan through
`init-run` first so you have the real phase breakdown, then ask with `AskUserQuestion`,
recommending fleet, with a preview showing that breakdown:

```
Fleet — 9 tasks, 3 phases          Inline — 9 tasks, sequential
                                   
  phase 1  T1 T2 T3 T4 T5 T6 T7      T1 -> T2 -> T3 -> T4 -> T5
           7 worktrees, parallel      -> T6 -> T7 -> T8 -> T9
    gate   test fileset ownership   
           review                     one worktree, this session
                                      you see every edit as it lands
  phase 2  T8                       
    gate   ...                      
                                    
  phase 3  T9                       
    gate   ...                      
                                    
  -> merged to run branch           -> committed as you go
```

Fill the preview from the actual `init-run` output — never a generic example. The gate
rows come from the phase's own manifest checks, so the user sees what will actually run.

State these trade-offs in the option descriptions, not as decoration:

- **Fleet** — wall-clock scales with the widest phase, not the task count. Each teammate is
  fresh, carrying only its own task's context. Cost multiplies by the number of teammates.
  You review at gates, not per edit.
- **Inline** — one context, every edit visible as it happens, cheapest for small work.
  Wall-clock is the sum of every task, and later tasks inherit the accumulated context of
  earlier ones.

If the user picks inline for eligible work, that is their call — take it without re-arguing.
