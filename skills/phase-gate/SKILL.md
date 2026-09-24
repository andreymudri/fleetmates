---
name: phase-gate
description: Use when a phase finished and needs an automated verdict before integration - runs command, agent, and MCP checks and decides PASS or FAIL.
---

# Phase Gate

Phases run autonomously end to end. The boundary is where verification happens.

## Run it

    node "<fleetmates root>/scripts/cli.mjs" gate --run <runId> --root <project root> [--phase <name>]

Exit codes: `0` PASS, `1` FAIL, `2` the manifest is broken, `3` no manifest (an inferred one
was printed).

On exit 3, show the user the inferred manifest, get confirmation, and save it as
`fleetmates.gate.json`. Never invent checks silently.

Exit 2 is not a verdict — nothing was judged. `fleetmates.gate.json` is present and malformed,
and the message names the file and what is wrong with it. Show that message and stop; do not
re-run the gate, and never save an inferred manifest over the broken one, which would discard
the checks the operator meant to fix. `complete` and `fix` read the same manifest and exit 2
the same way.

## Finish the pending checks

The CLI runs `command` checks itself and returns `agent` and `mcp` checks as `pending` —
those you execute:

- **agent** — generate the dispatches rather than assembling them by hand:

    node "<fleetmates root>/scripts/cli.mjs" review-dispatch --run <runId> --root <project root> --phase <name> [--models <json>]

  It prints one reviewer per lens with the tier, effort, findings path, scratch worktree and
  prompt already resolved, and exits 4 rather than emitting a dispatch when the phase has no
  task branch to review. Every rule below is what it encodes; they are stated here because a
  dispatch assembled by hand still has to follow them.

  Dispatch one `tm-reviewer` per lens in parallel over the phase diff, **without a
  `name`**. A named reviewer becomes an addressable teammate that goes idle without emitting its
  result, and the review is lost; unnamed reviewers return normally. Six consecutive named
  dispatches were lost this way in run `preview` before the pattern was identified. Each dispatch
  carries the configured reviewer tier and effort, read with
  `config get agents.reviewer.tier` and `config get agents.reviewer.effort`. `config get` on an
  unset key exits 2 with `unset: <key>` — the same exit code every hard config failure uses, but
  here it is the normal case, not an error. The two keys fall back differently, and treating them
  alike is how a reviewer ends up judging below its guaranteed tier:
    - `unset: agents.reviewer.tier` — dispatch at the **fixed reviewer tier, `capable`** (model
      `opus`, per the tier→model map in `parallel-execution` — remap there and this line follows).
      Never omit the model to inherit the session's: in a session on a smaller model (haiku or
      sonnet) that would have the reviewer grading every `agent` check below the model this
      skill guarantees. The map now sends `mid` to opus as well, so `mid` and `capable`
      resolve to the same model; the reviewer is still dispatched at `capable`, the tier this
      skill pins. A
      configured tier replaces `capable`; nothing else does.
    - `unset: agents.reviewer.effort` — omit the `effort` option, and the dispatch inherits the
      session's effort. Only effort falls back this way.

  Name a findings path per lens in the dispatch —
  `.fleetmates/<runId>/reviews/<phase>-<lens>.json` — which the reviewer writes before it
  returns. The response stays the interface: read it first, and read that file before
  respawning a reviewer that idled without returning one. A file present with no response is a
  recovered review, not a fresh one; record it as recovered. Neither an absent response nor an
  absent file is a clean lens — a missing result is never an empty findings array, and the
  check stays `pending`, which the CLI scores as FAIL.

  Each findings file carries a `stamp` naming the phase, the lens and the branch tips it judged.
  `collect-reviews` refuses a file whose stamp names different tips — a fix round moves a branch,
  and findings about the old tree are not findings about this one.

  To rebuild the results file from those drops rather than by hand:

    node "<fleetmates root>/scripts/cli.mjs" collect-reviews --run <runId> --root <project root> --phase <name>

  `--phase` is not optional on a plan with more than one phase, on either command above:
  omitted, it names the manifest key `default`, which scopes the review to every task branch in
  the run — including ones integrated rounds ago. The CLI refuses that with exit 2 rather than
  reviewing it. The guard counts every distinct phase value, integer or not, so a `plan.json`
  mixing phase `1` with phase `"2"` is refused too. Only integer phases are listed in the refusal;
  a non-integer one is reported as a count, because `--phase` cannot select it — no `--phase`
  reviews that task's branch, and the fix is the plan, not the flag. Nothing in this repository
  writes a non-integer phase; a plan is agent-written, which is why the case is stated here.

  It prints a `--results` file with `source: "file"`, applying the manifest's own `blockOn`. It
  also writes that same document to `.fleetmates/<runId>/reviews/results-<phase>.json` and prints
  that path last, so the `gate --results <path>` that follows names a file that exists — run
  without a redirect and without this, the review check stays `pending` forever while the gate
  reports FAIL with an empty `failed` list, naming nothing to fix. Pass the written path, not a
  capture of stdout: a `> results.json` redirect no longer round-trips, because the trailing
  path line is inside the captured bytes and `gate --results` on that capture exits 2 on
  `--results must be a readable JSON file shaped { "results": [...] }`, while the file the same
  command wrote exits 0 with verdict PASS — both measured on this tree. This is a breaking
  change to a workflow this skill used to invite, not a nicety. The file's existence is itself
  the claim: the previous `results-<phase>.json` is removed at the start of the command body,
  before the manifest is read and before any findings file is opened, so every refusal that
  judges this round's work is downstream of the clear and leaves no results file behind —
  measured, by making a second round refuse on a stale stamp and watching the first round's file
  go with it. Two classes of refusal sit above it and leave the earlier round's file where it
  was. An argv refusal — an unknown flag, a missing `--run` — exits 2 before this command body
  runs at all. And the clear itself can fail: a previous file that can be neither unlinked nor
  emptied exits 4 with `could not clear the previous results file at …`, and a `reviews`
  directory that is a symlink exits 4 with `… must be a real directory` before the clear is even
  attempted; either way the earlier round's file is still on disk saying what that round said.
  After any refusal, hand `gate --results` nothing at all: only a path printed on a `results
  written to …` line is this command's answer, and no refusal prints one — least of all the
  clear failure above, which names that very path while refusing to stand behind what is at it.
  The gate parses whatever file it is handed and trusts it, so a surviving `"status": "pass"` is
  read back as this round's verdict — measured on this tree for both shapes, one with the file
  and its directory owned by another uid under ordinary modes and one with the directory
  symlinked, each leaving a byte-identical file the gate then returned verdict PASS on. Scoping
  to the success line is what closes a bypass, and the bypass was measured too: a round-2
  collection refused at the clear over findings carrying a blocking high, and `gate --results`
  on the path that refusal itself printed exited 0 with verdict PASS over round 1's document. A
  read-only directory ALONE is not one of these: there `unlink` fails and the in-place empty
  succeeds, and the gate refuses the zero-byte file it leaves. It exits 4 and prints nothing
  usable while any lens has no file, or when a file exists and does not parse — respawn those
  lenses instead. A third condition exits 4 and does print something usable: when the collection
  succeeded and only the write failed, the complete results go to stdout above `cannot write the
  results file at …`, so keep those bytes rather than re-running the reviews — but drop that
  last line before passing them on, because a plain redirect captures it and `gate --results`
  then exits 2 for exactly the reason above; `head -n -1` is enough, and with it the gate exits
  0 with verdict PASS, measured on this tree. A file for a lens this phase did not dispatch is
  reported and ignored, never merged.

  Where a line quotes a value an agent wrote — a lens, a stamp or a reason out of a findings file;
  a check name, kind or `preview.link` entry out of the gate manifest, whose contents this CLI
  validates for shape and not for content; the bytes a JSON parse error quotes back out of a
  `--results` file or the verdict file `fix` is handed below — the value is printed with its
  control bytes and line separators replaced by a visible `<0x1B>`-style token. Any of those files
  could otherwise carry an escape sequence that erases the line in the terminal and draws one
  reading like a PASS this CLI computed, or a line break that adds one. That covers the lines a
  refusal prints, the ones a passing command prints, and the check names inside `finish`'s run
  summary table. It does not cover the bidi and format controls, which pass through. Read the exit
  code, not the shape of a line.

  Both come from the tracked manifest only — the reviewer grades the diff, so
  letting the gitignored layer choose its tier would let the party being judged pick its own
  judge. Then take every finding at a `blockOn` severity and
  dispatch a second reviewer prompted to **refute** it. Only findings that survive refutation
  block the gate.

  A `claims` finding is a claim whose mutation left the suite green — the code does not deliver
  what the comment, skill or spec says it does. At `high` that blocks the phase, and the fix is
  either to make the code deliver the claim or to correct the claim. Weakening the test is not a
  fix.

  A `claims` reviewer also writes two keys that are not findings, and `collect-reviews` acts on
  both: `collectReviewResults` reads `lens`, `stamp`, `findings`, `unableToVerify` and `unprobed`,
  and ignores every other key. It does not *keep* all of them — `stamp` is consumed to reject a
  stale file and then dropped from the emitted result, and neither key below survives into the
  result as a key either; what survives of `unprobed` is a count in the check's `output`.

  - `unableToVerify` means the reviewer could not build the phase's tree or get a green baseline
    in its scratch worktree, so it probed nothing. A non-empty `unableToVerify` is refused exactly
    like a lens with no file at all: nothing is emitted, `collect-reviews` names the lens and its
    reason and exits 4. Respawn that lens; do not record a pass for it. An empty string is not a
    report of failure and collects normally. The key is read only as a reason string: written as
    an array, an object, a boolean or a number it is reported as a file that cannot be read, and
    the fix is to the file rather than a respawn.
  - `unprobed` lists claims it enumerated and did not reach. The lens is bounded by its mutation
    cap, and a review that reached 8 of 40 claims would otherwise collect identically to an
    exhaustive clean one, so the count is surfaced in the emitted check's `output` — for a passing
    and a failing verdict alike. The list itself is only in the findings file. Like the key above
    it is read only in its documented shape, a list: written as a number, a string, an object or a
    boolean it is reported as a file that cannot be read rather than counted as nothing, because a
    review that says it reached a fifth of its claims must never emit a result with no bounded
    note. An empty list is a review that reached everything it enumerated, and collects silently.
- **mcp** — call the declared tool and compare against `passWhen`. If the server is not
  connected and the check is `optional`, record `skip` and say so out loud. A missing optional
  server is never a silent pass.

Then hand those results back and let the CLI recompute:

    node "<fleetmates root>/scripts/cli.mjs" gate --run <runId> --plan <planPath> --root <project root> --results <path>

The file is `{ "results": [ { "name": "review", "kind": "agent", "status": "pass", "findings": [] } ] }`.
Add `"source": "file"` to an entry recovered from a reviewer's findings file rather than from
its returned response; unset means `response`. It is provenance only — the verdict is identical
either way — and anything but those two values is rejected.
Only `agent` and `mcp` checks may be supplied; a `command`, `fileset`, or `ownership` entry is
rejected, because those are computed and supplying one would be a way to hand the gate a passing
enforcement check. The verdict is recomputed from the merged set, so a recorded PASS is always
CLI-computed — never hand-written into `status.json`.

`finish` recomputes every phase, and every `agent` check comes back pending because nothing runs
one. Hand it the same results, keyed by phase: `{ "phases": { "1": { "results": [...] } } }`. A
phase that passed on supplied results is marked `(review supplied)` in its output, so a reader
can tell a recomputed pass from a reported one.

## On a harness other than Claude Code

When the orchestrator is not Claude Code, dispatch the reviewers and the integrator through the
CLI rather than the `Agent` path. The reviewer dispatch is:

    node "<fleetmates root>/scripts/cli.mjs" dispatch-reviews --run <id> --phase <name> --harness <h> --root <project root>

and the integrator step is:

    node "<fleetmates root>/scripts/cli.mjs" dispatch-integrator --run <id> --phase <name> --harness <h> --root <project root>

Each is worktree-isolated and gate-identical, and the harness name is the one the orchestrator is
running in, passed explicitly.

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

## On FAIL

Ask the CLI for a fix decision before asking the user. Hand it the run, the failing phase, the
run root, and the verdict JSON you just produced; it prints one of three decisions — `none`,
`retry`, or `escalate` — and exits 0 for all three, so read the `decision` field rather than the
exit status.

    node "<fleetmates root>/scripts/cli.mjs" fix --run <runId> --phase <n> --verdict <path> --root <project root>

`--verdict` names a file holding that same JSON, and `--phase` must match its own `phase` field —
a mismatch exits 2 rather than adjudicating the wrong phase's findings, and so does a malformed
`fleetmates.gate.json`. Exit 1 means the run has no plan at all or the verdict file could not be
read: an argument error, not a decision. Exit 0 covers `none`, `retry`, and `escalate` alike, so
the exit status never tells them apart — only the `decision` field does.

**`fix` does not apply to a `--no-fleet` gate, and this whole section does not either.** `--phase`
here must be an INTEGER, because tasks and fix rounds are keyed by numeric phase. A `--no-fleet`
gate names its phase from the manifest instead — `default`, typically — and emits a verdict
carrying `phaseName` with no integer `phase`, so handing it to `fix` exits 2 (a third cause,
alongside the phase mismatch and the malformed manifest). That is not a defect to work around:
`--no-fleet` builds no preview and has no task branches, so there is no teammate to redispatch and
nothing for a decision engine to attribute a finding to. **Fix the findings directly, then re-run
the gate from scratch for a fresh verdict.** Everything below about `retry`, `escalate` and the
round budget presumes a fleet phase with task branches. Two rules still bind on a solo gate, and both are restated here in full rather than cross-referenced:
**a PASS reached after N rounds of fixes is reported as such, never as a clean first-pass PASS**,
and **a check that was skipped is reported as skipped, every time**. A solo gate writes a verdict
into `status.json` only when the caller passes `--run`, and a solo gate invoked without `--run`
writes no verdict anywhere.

**The verdict you hand it must be the JSON this gate printed in this same pass, and must never be
read back from `.fleetmates/`.** The only verdict persisted on disk lives in
`status.gates[<phase>]` inside `.fleetmates/<run>/status.json`, written by the very agents this
gate exists to enforce — the same file `scripts/enforce.mjs` refuses to consult when picking a
branch. Feeding that record in today degenerates harmlessly, because the persisted object carries
no `results` key and the decision comes back `none`; that is incidental, not guaranteed. Treat it
as a rule so a change that starts persisting `results` cannot quietly turn the on-disk record into
a decision input.

On `none`, the decision engine found no failing check in the verdict you handed it. **This does
not mean "the failure needs no fix" and it is never permission to integrate.** You reached this
section because the gate failed, so a `none` decision means the verdict you passed is not the
one that failed — a stale file, the wrong phase, the wrong run root, or a verdict written before
the last check completed. Re-derive the verdict by running the gate again from scratch and ask
again. Integrate only on a freshly recomputed PASS, never on `none`.

On `retry`, redispatch each listed task at the listed `tier`, resuming the same teammate so it
keeps its task context, and hand it the failing check names and the surviving findings. Then run
the gate again from scratch — never reuse the previous verdict, and never re-run only the
failing check.

A retried teammate that returns `blocked` ends the loop immediately. `blocked` means missing
input, and further rounds cannot supply it.

On `escalate`, halt before integration and report, in this order: the escalation reason, which
check failed, the exact command output or finding list, the offending diff hunks, the owning
teammate, and the round history — which tier ran each round and what failed each time. Then
offer three choices: retry the failing task with the findings fed back, override and proceed,
or abort the phase.

A PASS reached after N fix rounds is reported as such, never as a clean first-pass PASS.

**The round budget is a cost bound, not a security bound.** `fixRounds` lives in `status.json`,
which is written by the agents the gate enforces. A teammate that rewrites its own count buys
itself more retries — wasted tokens, not a false PASS, because the verdict is recomputed from
git every round. Do not describe the loop as tamper-evident; only `fileset` and `ownership`
carry that property.

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

Skipped only when the caller passes `--no-fleet`. Missing state is a failure, never a skip.

A `fileset` or `ownership` failure is a process violation, not a code defect. Do not widen the
plan's file set to make it pass.

## Reporting rule

**Never report a phase done without a recorded PASS in `status.json`.** A check that was
skipped is reported as skipped, every time. No "should work".

**Evidence before claims, always.** Never claim a task, phase, or fix is complete, fixed,
or passing without having run the verification yourself in this pass and seen its output —
a prior run, an agent's self-report, or "should pass now" is not evidence. "Tests pass"
requires the test command's fresh output showing the count and zero failures, not
recollection of an earlier green run. "Bug fixed" requires re-running the original failing
case and watching it pass now, not the diff alone. If a `tm-implementer` reports DONE,
that report is not the evidence — the gate's own check run against its diff is. Skipping
this because a check "obviously" passes is the same defect as skipping the check.
