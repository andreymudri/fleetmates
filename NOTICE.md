# NOTICE

This plugin's skill content draws on [superpowers](https://github.com/obra/superpowers)
(version 6.2.0, © Jesse Vincent, MIT License). See `LICENSE-THIRD-PARTY` for the
full license text.

## Adapted skills

The following skills are adapted from superpowers skills of the same name:

| Skill | Adapted from |
|---|---|
| `brainstorming` | superpowers `brainstorming` |
| `executing-plans` | superpowers `executing-plans` |
| `receiving-code-review` | superpowers `receiving-code-review` |
| `systematic-debugging` | superpowers `systematic-debugging` |
| `test-driven-development` | superpowers `test-driven-development` |
| `writing-skills` | superpowers `writing-skills` |

## Same-named upstream skills, substantially rewritten

`writing-plans` and `finishing-a-development-branch` share their names with superpowers
skills, but the content here was substantially rewritten for this plugin's fleet/gate model —
different save locations, a different machine-readable task format, and a different
completion gate built around `status.json`. `writing-plans` does reuse the shape of upstream's
Self-Review structure (the same Spec coverage / Placeholder scan / Type consistency ordering)
and `finishing-a-development-branch` reuses upstream's three-option integration menu shape.
Both are listed here rather than under "Original skills" because that lineage exists, even
though neither is a line-for-line adaptation.

## Original skills

The following skills are original to `fleetmates` and are not adaptations
of, nor share a name with, any superpowers skill:

- `using-fleetmates`
- `fleet-lifecycle`
- `parallel-execution`
- `phase-gate`
- `fleet-supervision`
- `fleetmates-config`

Three of these original skills additionally absorb guidance from superpowers
skills that have no direct counterpart in this plugin:

- `parallel-execution` absorbs guidance from superpowers `subagent-driven-development`
  and `using-git-worktrees`.
- `fleet-lifecycle` absorbs guidance from superpowers `dispatching-parallel-agents`.
- `phase-gate` absorbs guidance from superpowers `verification-before-completion`
  and `requesting-code-review`.
