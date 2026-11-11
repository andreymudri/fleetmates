## Finish the pending checks

This file describes a review check scoped `phase`: reviewed inside each phase gate, over the phase
diff, with its results keyed by phase. A review check with no `scope` is scoped `run` and follows
the core's section "Review the run" instead; the rules below for reviewers, findings files and
stamps apply to it too.

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
