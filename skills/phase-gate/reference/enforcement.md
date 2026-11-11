## What the enforcement checks do and do not cover

`fileset` and `ownership` are computed by the gate from git, at the moment it runs. They read
no file from `.fleetmates/`: the run phase, the anchor, and the plan all come from git, because
`status.json` is written by the agents being enforced. `complete` recomputes rather than
trusting a recorded verdict.

**These checks are tamper-evident, not tamper-proof.** They catch drift, mistakes, and attacks
that are not aimed at them. They do not stop a teammate that targets them: a teammate runs its
own tests, and running a teammate's code is arbitrary execution, so a determined teammate can
do anything the user can — including fast-forwarding the run branch to make a phase look
integrated. `docs/specs/2026-08-05-tamper-evident-enforcement-design.md` lists what is out of
scope; `tests/adversarial.test.mjs` pins each limit with a test.

`ownership` also fails a task branch that is an ancestor of the **base** branch but not of the
run branch. This run's work reaches the base by riding the run branch, which lands as a whole
after a PASS; any other route puts integrated content in front of users with no gate verdict
behind it — a reviewer merging task branches into `master`, a teammate landing its own work.
The question is asked of the two refs as they stand, so there is no recorded base sha for the
enforced party to rewrite; the cost is that it says the branch is there, not when it arrived.

Both run on every phase whether or not the manifest lists them: the gate injects whichever one
the phase's check list lacks, and `gate` names them in an `injected` field of its JSON (`complete`,
`finish` and `prune-run` print a line). A merge can rewrite the manifest the next gate reads, so a
check the manifest could remove is a check that merge could switch off. An injected `ownership`
that fails adds a note: the commits it names may predate this fleetmates version, or come from an
inline run that should have passed `--no-fleet`.

`ownership` explains a commit on the run branch's own first-parent chain — every integration merge,
every direct write — only by the merge rule, never by its being reachable from a task branch: the
next phase's branches fork from the run tip and carry every earlier write in their history. And an
integration merge may carry only files declared by the tasks it integrates — a task integrates a
secondary parent when the parent is on its branch's own first-parent chain, which a later phase's
branch, forked from the run tip, never has — plus what only a base parent changed. So a payload
merged in from a side branch, or a landed task branch that grew a commit outside its set and was
merged again, fails, and dispatching the next phase does not change that.

**Protected paths.** `fileset` also fails a task that changes a protected path its plan line does
not mark `(protected)`, even when the path is declared: the output line reads
`T1: protected — <path> (…)`, separate from the `outside declared set` line. The manifest is always
protected, under both its current and legacy names; its top-level `protected` array adds paths.
`ownership` fails a merge whose hand-resolved conflict touches a protected path unless a task it
integrates marks the path; a later task's marking does not count. The one exception is the base:
a merge of the base branch may resolve a conflict on a protected path that only the base side
changed. Approving such an escalation is a plan amendment on the base branch
(see `parallel-execution`, "Amending a plan mid-run"), then a re-gate.

**Test inventory.** A `command` check whose manifest entry carries a `report` gets a computed result
`<name>:inventory` right after it. The gate runs the suite twice — on the run tip before this
phase's merges (the baseline, in a worktree of its own) and in the preview — and compares the JUnit
reports test by test:

- `drop: <id> — ran at the baseline, absent|skipped now (changed by T2)` — a test that ran is gone
  or skipped. Approved by marking the file `- Test (drops)` in the plan on the base branch.
- `new skip: <id>` — a test that did not exist is skipped where the gate runs. Approved by declaring
  its unit in the manifest's `skips` with a reason; the manifest is protected, so that is an
  operator decision.
- `standing skip:` and `stale skips entry:` lines ride on a PASS and never fail it; `finish` names
  the standing skips of the last phase at the end of the run.

An absent or unparseable report is a FAIL. `complete` reports the inventory as `skip` (no
baseline); so does a solo gate. An `inventory` FAIL is a process violation and escalates, like
`fileset` and `ownership`. What it cannot see: a loosened assertion (the test still runs), and a
test that writes its own report — the report comes from a process running teammate code.

Skipped only when the caller passes `--no-fleet`. Missing state is a failure, never a skip.

A `fileset` or `ownership` failure is a process violation, not a code defect. Do not widen the
plan's file set to make it pass.
