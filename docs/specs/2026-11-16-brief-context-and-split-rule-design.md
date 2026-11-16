# Brief context and the split rule: design

Status: design answers given by the owner on 2026-11-16; this document awaits the owner's review.

Second of three changes designed together. It lands after
`2026-11-16-skill-context-cuts-design.md` and before `2026-11-16-tickets-design.md`.

## Why

Two findings, both from comparing fleetmates with another agent orchestrator and from the eval of
2026-11-06:

- **A teammate never sees the request.** A brief carries the task, the declared files and the
  global constraints. The context bundle (`scripts/plan-context.mjs`) adds task-level contracts
  only. The plan's `## Destination` and `## Statement` do not reach an implementer, so it judges
  its work against the plan author's reading of the request.
- **The eligibility rule is too loose.** A fleet is eligible at three or more tasks on disjoint
  files. The eval found the fleet 5 to 12 times as expensive as the inline path for the same
  quality. A plan's steps and files do not each need a task.

## 1. Destination and Statement in the brief

- Every implementer brief, full and terse, carries the plan's Destination and Statement when the
  plan has them. They are read from the plan at the anchor commit, like the rest of the brief.
- They travel in the context bundle, which already passes plan text as JSON data. The Statement is
  the request verbatim and must reach the teammate as data, never as instructions.
- The bundle labels them as context for understanding the task. They add no scope: the declared
  file set stays the only write set, and the bundle says so.
- A Statement longer than 2000 characters is cut there, and the bundle names the plan path where
  the rest can be read.
- A batch brief carries them once, not once per task.
- A plan without these sections produces the brief it produces today, byte for byte.
- Reviewer prompts are not changed. The integrated review already receives the Acceptance entries.

This change has no effect on the inline path, which has no briefs.

## 2. The split rule

Skills only, no code.

- **Fleet eligibility** keeps its three conditions (a written plan, three or more tasks on
  disjoint files, a git repository) and gains a fourth: each task is a real boundary. A real
  boundary is one of: output that is independent and can be produced in parallel, a real
  prerequisite of another task, or work that needs an independent review. After the context cuts
  this text lives in `skills/using-fleetmates/reference/fleet-or-solo.md`; the core's short
  paragraph names the fourth condition too.
- **`writing-plans`**, in its task-sizing section: a plan's steps, files and phases do not each
  need a task. One owner end to end is the default, and a task is split off only at a real
  boundary, with the same three cases.

The skill does not cite the eval's numbers: they come from one eval of five tasks.

## Testing

- Bundle content: Destination and Statement present when the plan has them, absent when it does
  not, and the brief unchanged for a plan without them.
- The 2000 character cut, at the boundary, with the plan path named.
- A Statement that contains text shaped like an instruction or a closing delimiter reaches the
  brief inside the JSON data and nowhere else.
- One copy in a batch brief.
- The pinned skill sentences for the new eligibility condition and the new sizing rule, and the
  size caps from the context cuts still met.

Each test is shown to fail when the rule it covers is removed.

## Out of scope

- Giving Acceptance entries to implementers: a teammate may try to meet entries that belong to
  other tasks.
- Giving Destination and Statement to phase reviewers.
- An advisory in `init-run` about small tasks: it needs thresholds nobody has measured.
- Changing `fleet.mode` or which option the fleet-or-inline prompt recommends.
