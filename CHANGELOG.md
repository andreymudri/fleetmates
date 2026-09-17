# Changelog

## Unreleased

### Added

- A headless driver and a Codex adapter, alongside the existing Claude Code Workflow path. New
  commands: `dispatch`, `dispatch-reviews`, `dispatch-integrator`, `message`, `sessions`.
- `harnesses.codex.*` config: `sandbox` (`clone` default, `files`, `full`), `network`,
  `timeoutMinutes`, `tierModels`.
- A Cursor adapter (`--harness cursor`): teammates run in a scrubbed, git-less checkout that the
  host commits, with `--sandbox enabled` and never `--force`.
- `harnesses.cursor.*` config: `sandbox` (`files` only), `network`, `timeoutMinutes`, `tierModels`.

### Fixed

- Codex `files` sandbox: the teammate's edits were never committed to its task branch. The host
  now commits the checkout through the same hardened path the Cursor adapter uses.

## v2.0.1

No change to the plugin itself — the published files are identical to 2.0.0.

- The first release published by `release.yml` through npm trusted publishing, so it is the first
  `fleetmates` version on npm with a provenance attestation. 2.0.0 was published by hand.

## v2.0.0

**claude-teammates is now fleetmates**, published on npm as `fleetmates`.

### Breaking

- Plugin, marketplace and npm package are `fleetmates`; skills are namespaced `fleetmates:`, and
  `using-teammates` / `teammates-config` are `using-fleetmates` / `fleetmates-config`.
- On disk: `.fleetmates/`, `fleetmates.gate.json`, `fleetmates.local.json`, task branches
  `fleetmates/<run>/<task>`, claim refs `refs/fleetmates/…`, and the `fleetmates-map` header in map
  notes.
- The update-check opt-out is `FLEETMATES_UPDATE_CHECK`; `CLAUDE_TEAMMATES_UPDATE_CHECK` still works.

### Migration

- The first CLI command in a repository migrates every legacy name, or refuses with exit 2 while a
  teammate is live or when both spellings exist. A failure part-way exits 4 and prints how to
  reverse each completed step.
- SessionStart warns while `claude-teammates` is still installed beside `fleetmates`.

### Distribution

- The marketplace installs the plugin from npm, and the package ships without tests or docs.
- The update check reads the npm registry instead of `plugin.json` on GitHub.
- `release.yml` publishes a `v*` tag through npm trusted publishing, after the three-OS matrix.

## v1.3.0

Every open finding in `docs/followups/2026-08-27-purge-open-findings.md` is closed, and the
measurement that closed the largest of them is a script now. `npm test` 2211 | 2208 pass | 0 fail
| 3 skipped, green on all three platforms; `npm run test:hostile-tmpdir` PASS.

### Added

- **`brief --fix-round`.** The ordinary brief opens with `git checkout -B <branch> <base>`, which
  on a fix round resets the task branch to the base — destroying the work the round was convened
  to repair. Compounding it, a fresh isolation worktree cannot check out a branch a dead worktree
  still holds, so the naive retry was blocked-then-destructive. The flag emits the same brief with
  a checkout that does not reset, and two refusals in place of it: report `blocked` if the log
  shows the base, and report `blocked` rather than free a branch another worktree holds, because
  the worktree guard stops a teammate from touching another worktree at all. That removal is the
  orchestrator's, and `skills/parallel-execution/SKILL.md` now names the flag where it tells the
  orchestrator to respawn.
- **`npm run test:hostile-tmpdir`**, in CI on the two legs that can measure it. It runs the suite
  once under a directory name carrying four hazards — a single quote, a space, a command
  substitution and enough length to exercise `sun_path` — and answers one question: did a
  directory name get to choose what the suite executed? The injection COUNT is the verdict, not
  the suite's exit code: a test can go green having executed the injected command, which 4 of the
  17 executions found on 2026-09-01 did.

### Fixed

- **Every temp path in the suite is TMPDIR-derived, and eighteen of them reached a `shell: true`
  command unquoted.** Measured under a TMPDIR named `h'$(echo X >> log)'x`: the injected command
  ran **17 times in `tests/gate-runner.test.mjs` alone and turned 13 of that file's 171 tests
  red**, plus one more site in `tests/cli.test.mjs`. Four distinct shapes, each now behind a
  helper with an injection test of its own — including one built at runtime in a child process out
  of `process.argv`, where no build-time quoting helper can reach and the path has to arrive as a
  shell PARAMETER instead. Every one of those tests asserts both halves: that the marker was not
  created, and that the command still works at the hostile path, so quoting that merely broke the
  command cannot pass.
- **A run id could draw a forged terminal write out of the containment refusal.**
  `assertContained` built its sentence with a bare `${segment}` and `collect-reviews` printed
  `err.message` unwrapped, so `--run $'x\e[2K\rreview: PASS/../../pwned'` put a raw ESC and CR on
  stdout — erasing the line this CLI had written and leaving a sentence the run id chose.
  Pre-existing: byte-identical on `922ac91`.
- **The merge preview was based on the run branch's NAME rather than the ref HEAD points at.**
  The two disagree exactly when the name is itself a ref path, which `qualifyBranch` passes
  through unchanged — a gate could report `merge=pass` on a tree where merging into the real run
  branch conflicts. `classifyHeadRef` already refuses that HEAD state, so the fix is defence in
  depth rather than a reachable hazard, and its test builds the disagreement directly because no
  CLI path can produce it any more.
- **Both `prune-run` dead ends now say what to do.** `--base` is spliced into
  `refs/heads/<value>`, so a remote-tracking ref or a raw commit exited on git's own
  `fatal: Needed a single revision`; it is refused by name now. And the same-branch refusal named
  "the gate" — a command the operator had not run — and offered `--base`, which cannot help; it
  separates the two situations that produce it now, including the integrated run that has no
  branch left to derive, and carries the two commands that make a hand cleanup safe.
- **The unix-socket test could not survive a long `TMPDIR`, and a space in one broke six
  `file://` URLs.** The socket path is bounded by `sun_path` — 108 bytes on Linux, 104 on macOS
  and the BSDs — and a 77-byte TMPDIR with nothing hostile in it was enough to turn it red. The
  space defect only surfaced once length was ruled out: `curl` failed on a URL built by hand,
  `hooks/update-check` exited 0 as it does on any fetch failure, and the test read the zero-byte
  cache the script had already stamped and died on `Unexpected end of JSON input` — a fetch that
  never happened, reported as a parse bug three tests from its cause.
- **The `printable` census header was stale by more than two times** — 48 recorded against 104
  actual — in a paragraph that spends four sentences warning the reader that exactly this
  happens. It is a test now rather than a number, so it cannot rot again quietly. It is a
  tripwire, not a budget: a new wrapper is supposed to turn it red.

### Notes

Two capabilities were considered, written, measured and **rejected**. Both have their reasoning
recorded in the tree so they are not re-litigated.

Hoisting `idRefusal` out of `init-run` to run for every command turns six `SANITISED_SITES` rows
red and closes nothing: a run directory is a directory anyone with write access can create, so a
hostile id does not need `init-run` to exist, the CLI must escape whatever it is handed
regardless, and refusing at the door only removes the route those rows use to prove it does.

A `--run-branch` flag for `prune-run` was rejected for the opposite reason — `doctor` takes one
and is read-only, while `prune-run` runs `git branch -D` and removes worktrees, and handing that
path an operator-typed name reopens the class `classifyHeadRef` exists to close.

One measurement worth carrying: the `sun_path` limit READS as a quoting failure and is not.
Reproduce with a long, benign `TMPDIR` before calling anything in that area a quoting defect.

## v1.2.1

The macos and windows legs of the matrix, red since v1.2.0 on two tests whose subject behaved
correctly on both. `npm test` 2190 | 2187 pass | 0 fail | 3 skipped, green on all three
platforms.

### Fixed

- **Two tests asserted linux's errnos as though they were every platform's.**
  `collect-reviews refuses when the previous results file can be neither removed nor emptied`
  matched `unlink failed (EISDIR` and the same for the truncate fallback. Only linux answers
  that pair: `unlink` on a directory answers `EISDIR` on linux and `EPERM` on darwin and win32,
  and the fallback opens and answers `EISDIR` on linux and darwin while win32, having no
  `O_NOFOLLOW` to open safely with, refuses before trying. The CLI printed the right refusal and
  exited 4 on all three throughout. The assertions are per-platform now and still require both
  attempts and both failures, which is the diagnosis that pair carries.
- **The flag-word guard was asserted to be unreachable on the platform that reaches it.**
  `the fused open refuses to build a flag word from constants it does not have` closed on
  `typeof fusedHolderOpenFlags() === 'number'`. On win32 `O_NOFOLLOW` is absent, so the guard
  does exactly what it exists for and returns `null`. That leg asserts `null` there now, and is
  the first thing in the suite to observe the missing constant **on-platform** rather than
  disclaim it.

### Notes

Both defects rest on one premise: a comment saying no leg of this suite runs on win32. It was
not stale — it was **false when written**. The three-platform matrix landed on 2026-08-07 in
`1f76b15`, released in v0.1.1; the comments asserting its absence were written on 2026-08-27, in
`9a45812` and `04a74d0`, twenty days later. It appears three times in `scripts/cli.mjs`, one of
which calls the win32 by-path preview branch unreachable on this suite's platforms when it is
the branch win32 always takes. All three are corrected.

Not closed, and not diagnosed: `a gate that exits of its own accord sweeps the check group on
the way out` timed out at 30s on macos once and passed in two later runs of the same code. One
occurrence in three, root cause unknown, left alone rather than guessed at.

## v1.2.0

Two runs' worth of work, closing the purge/teardown gaps and then closing what reviewing them
found. 152 commits, every phase gated PASS, `npm test` 2190 | 2187 pass | 0 fail | 3 skipped.

### Breaking

- **`collect-reviews` writes its results to a file, and `> results.json` no longer round-trips.**
  The command now writes `.teammates/<runId>/reviews/results-<phase>.json` and prints that path
  last, so the `gate --results <path>` that follows names a file that exists. The trailing path
  line is inside the captured bytes, so a plain redirect produces something `gate --results`
  refuses with exit 2, while the file the same command wrote exits 0 with verdict PASS. Pass the
  written path. Run without a redirect and without the file, and the review check sat `pending`
  forever while the gate reported FAIL with an empty `failed: []`, naming nothing to fix — which
  is what this replaces.
- **`--phase` is refused on a plan carrying more than one phase.** Omitting it used to resolve
  silently to the `default` manifest key and review every task branch in the run under one stamp.
  The refusal counts integer phases only, so a plan mixing `1` with `"2"` or `2.5` still escapes
  the fence; that limitation is documented where the guard is taught.

### Closed hazards

- **The run branch is resolved symbolically.** `currentBranch()` is reimplemented over
  `git symbolic-ref --quiet HEAD`, so the name never passes through git's abbreviation rules. A
  teammate that planted `refs/heads/refs/heads/<run branch>` — three ordinary `update-ref` writes
  from its own worktree — owned `ctx.runSha`, and `prune-run --yes` then deleted an unmerged task
  branch **reporting it as contained, exit 0**, with both reflogs already gone. `derive` now
  refuses a detached HEAD, a HEAD outside `refs/heads/`, and a name that is itself a ref path.
- **The merge-preview owner marker is vetted on the descriptor it read.** The marker is opened
  once with `O_RDONLY|O_NONBLOCK|O_NOFOLLOW` and `fstat`ed, so `isFile()` is asked of an object
  rather than of a name. While the vetting was an `lstat` by path, a regular file approved by the
  lstat could be swapped for a fifo before the read resolved the name again — and a fifo there
  made the read block forever, uninterruptible by `process.exit()` because the libuv thread parks
  in `open(2)`.

### Added

- Per-check `timeoutMs` in the gate manifest, with a command check bounded by a process-group kill.
- `prune-run` deletes a pruned task branch once the run branch **provably** contains it, proved by
  sha so a same-named tag cannot redirect the proof.
- A preview holds a claim file per holder for the duration of a command check.
- Every teammate brief and both agent definitions now state the environment walls, the claim
  discipline — *every claim written into a comment, a skill sentence or a test comment must be
  backed by a command you actually ran* — and the scope rules.

### Notes

What these runs did **not** close is recorded with each finding's own reproduction in
`docs/followups/2026-08-27-purge-open-findings.md`, including four pre-existing defects no task
owned, a bind-mount boundary pinned rather than closed, and the review-methodology findings that
nine and five review rounds bought.

## v1.1.6

Two review passes over code that had shipped without any.

- **`usage` could be made to report transcripts from anywhere on disk as this project's spend.**
  `readdir` and `stat` both follow symlinks, so a session directory whose `subagents/` was a
  symlink out of the store was **auto-selected with no `--session` flag**, and the walk read and
  attributed files outside the store. The hand-written walk had closed the symlink hole for links
  found *inside* it and left the one at its own entry point, under a comment asserting the hole was
  shut. Reproduced live.

  The first fix for it was defeated by a single symlink: it anchored containment on
  `realpath(projectDir)`, and `projectDir` is a name derived from the root — `<projectsDir>/<slug>`
  — which whoever writes the store can replace with a link. Containment is now an **exact match**
  against the one path the store may be, anchored on `projectsDir`, which the caller supplies.
  That also removes two defects of the prefix arithmetic it replaced: a legitimate session named
  `..foo` was refused (while this module's own name check accepts it), and a store symlinked to a
  *sibling* session was accepted and reported under the wrong session id.

- **`agent-<id>.meta.json` is a derived path and passed no check at all.** It is never enumerated,
  so neither the walk's `isFile()` filter nor the containment check ever saw it. A symlinked meta
  file was a constrained arbitrary file read — any JSON file on disk, with two of its string fields
  printed into the operator's table — and `mkfifo agent-<id>.meta.json` hung `usage` forever, with
  no timeout and no `AbortSignal`, the pending read keeping the process from exiting. Guarded by
  `lstat` + `isFile()`.

- **The walk reads from the resolved store path**, not the name it checked, so no open below the
  containment check traverses an unresolved link component. This narrows a TOCTOU window measured
  at 16.5% of invocations under a concurrent `rename()`. It does not close it: Node cannot, without
  fd-relative opens, and that is recorded rather than papered over.

- **Three tests would have taken Windows CI red** — they build symlinks and lacked the
  `{ skip: process.platform === 'win32' }` this suite uses elsewhere, so they threw EPERM inside
  the fixture builder and failed rather than skipped.

- **`isUnsafePathComponent` gained direct tests.** It had none: it was reachable only through two
  call sites that pre-filter their input, so deleting the **Windows separator** from the check left
  the whole suite green — in the release whose subject was Windows path semantics. Its dead third
  arm (`resolved === '.' || '..'`, unreachable because the strip removes the whole trailing run) is
  removed rather than tested, with the equivalence brute-forced over 177,155 inputs.

- **The `caveman` claim was defeated a ninth and a tenth time.** Only one route was opened by the
  previous fix — an added section carried past the byte-for-byte snapshot by `cp`-ing the fixture.
  The other two had never been bound by any round: `agents/tm-reviewer.md`, which IS the reviewer's
  dispatch prompt, and `CHANGELOG.md`, which states the measurement in more detail than either
  pinned file. The
  anchor for the skill's text is now a SHA-256 constant in the test file, which a `cp` over the
  fixture cannot reach; `agents/tm-reviewer.md`, `agents/tm-integrator.md` and `CHANGELOG.md` are
  bound for the first time. The prose layers are documented as change detectors rather than proofs
  — the runtime check is the only mechanically decidable one.

## v1.1.5

One path-traversal gap, closed in both places that had it.

Windows strips trailing spaces and dots from a path component, so `'.. '` reaches the filesystem as
`..` — the value `reviewFileName` and the `usage` session check both existed to refuse, wearing a
suffix that `=== '..'` cannot see. Reported against one of them and deliberately carried across
v1.1.4, because the two were separate implementations of a single rule: fixing either alone would
have left the other, and left a comment claiming a shared rule that was not shared.

They are one exported function now, `isUnsafePathComponent`. It tests what a component *resolves*
to rather than its literal, so a name that merely contains dots (`v1.2.3`) still works, while
anything collapsing to nothing, `.` or `..` is refused. A single mutation of that function fails
tests at both call sites, which is what the shared rule buys.

## v1.1.4

`usage` reported a workflow-dispatched run as costing nothing. Bug fixes and the tests that pin
them; no new commands, no changed contracts.

### `usage` reported a whole run as zero

`readdir` on `subagents/` did not recurse, and a workflow-dispatched run keeps its transcripts
under `subagents/workflows/<wf-id>/`. So the command matched no `.jsonl` at all, printed
`(0 subagents)`, a table of zeros, and **exit 0**. Against a real store that concealed five
transcripts and **31,394,783 cache reads**.

That is the outcome `scripts/usage-store.mjs` and `scripts/cli.mjs` each independently state must
never happen — "a zero reads as *no usage*, and would be a lie the reader has no way to catch".
The nesting is caused by workflow dispatch, not by harness age: the only session with a nested
store was the only session that had run a workflow, and this plugin ships `workflow-gen.mjs`.

The store is now walked explicitly rather than with `readdir({recursive: true})`, which follows
directory symlinks, propagates a nested failure to the caller, and is unbounded. The walk skips
symlinks, records a directory it cannot enter and carries on, and reports when it stops at its cap
instead of truncating silently.

### `usage` told other lies about the same store, and no longer does

- **A torn last line discarded the whole transcript.** The parse was all-or-nothing, and a
  transcript is appended to while its session runs — exactly when an operator reports on one. A
  fixture lost 1.7M cache reads while the headline still read `fixed prefix = 100%`. Parsed per
  line now; the bad line is dropped and counted.
- **Parse errors quoted the transcript back.** `JSON.parse` messages embed the offending source,
  and the source is the operator's own conversation. Reasons are built from line counts now.
- **`--session` was joined into the store path unvalidated**, so `../../../outside` read `.jsonl`
  files elsewhere on disk. Refused by name, on the rule `reviewFileName` already applies.
- **Nothing printed by `usage` was neutralised** — the only render module in `scripts/` with no
  `printable` at all. A crafted `meta.json` could draw a line that read like real output, needing
  no escape sequence: a literal newline counted as one character to the column fitter. Table,
  error path and `--json` are all neutralised now.
- **Numeric columns truncated.** `1,000,000,000` rendered as `1,000,000,…`. They widen instead;
  only text columns are capped.
- **A session was picked by mtime with no test behind it.** The v1.1.2 selection fix was unpinned:
  inverting the sort to choose the *oldest* session left the suite green.

### The quiet reporter could be made to lie about its own run

Test-authored text — stdout, stderr, a test's name, its error stack — was passed through raw. An
escape sequence in any of them could erase the reporter's summary line and draw another, or conceal
it outright with SGR 8, so a failing run read as green. All four are neutralised with the content's
own newlines and tabs kept, so failure detail loses nothing. The exit code remains the authority.

### Documented claims that the code did not deliver

`caveman` was documented with **four** levels; `CAVEMAN_LEVELS` has three. `tm-implementer` was
documented as declaring **seven** tools; it declares six. A `finish` advisory named a remedy that
could not work in one direction, so following it looped forever. `fix` reported a real boundary — a
`--no-fleet` verdict names its phase from the manifest and has no numeric phase — as a missing
argument, which reads as a typo.

### Under the hood

Every fix above is pinned by a test verified to fail when the fix is reverted. The claim that
reviewer dispatches are unaffected by `caveman` is now pinned by an exact snapshot of the section
that states it, after eight distinct ways of asserting the opposite survived successive
pattern-matching attempts.

## v1.1.3

Documentation only, plus the test file that binds it. `caveman` was measured and is not the lever
it was carried as; no code behaviour changed.

### The `caveman` lever is measured, and it is not one

- **Measured 2026-08-25 against the real subagent transcripts, and documented, after `caveman`
  had been carried for a session as "the largest remaining token lever".** The premise held and
  the lever failed. An agent's own output really does drive its cost — 71% and 48% of context
  growth in the two real multi-turn agents, against 21% and 32% from tool results — but **72-76%
  of that output is thinking**, which a style instruction cannot reach. `agents.<role>.effort` is
  the control for thinking; `caveman` is not.
- **`caveman` reaches two things: the implementer brief and the local `digest` output.**
  `scripts/review-gen.mjs` has no caveman path, so reviewers — the largest emitters, at 22,900 and
  12,965 output tokens — never receive the instruction at all. Inside the brief it is scoped to
  the returned summary and blockers, and that summary is the **last** message an agent emits
  (turn 49/49 and 46/46), so it is re-read zero times by the agent that wrote it. The one part
  `caveman` touches is the one part that does not accumulate.
- **The caveman brief is larger than the default, by 156 chars (2.8%)**, and a brief sits in the
  prefix, so that cost *is* re-read every turn. The three levels are validated but not honoured by
  this plugin's own code: `digest` reads only truthiness, and the brief delegates the level to an
  external `caveman:caveman` skill.
- README and `skills/teammates-config` now state all of the above; previously neither said what
  the knob reached. `tests/skill-config.test.mjs` pins each claim twice — once as a sentence in
  the skill, once as the behaviour that sentence describes — so the documentation cannot drift
  from the code it describes.


## v1.1.2

A `usage` bugfix, and the measurement v1.1.1 shipped unconfirmed is now taken.

### Fixes

- **`usage` mistook the harness's `memory/` directory for a session.** It sits beside the session
  directories inside the project directory and is written every session, so it won every mtime
  comparison in `newestSession` — the command failed with `no transcripts found at
  .../memory/subagents`, which reads as "that session is empty" rather than "that was never a
  session". A session is now the newest directory that carries a `subagents/` store, ordered by
  the later of the session directory's and the store's mtime. With no store anywhere, the failure
  names the layout instead of whichever directory happened to be newest.

### The v1.1.1 tool-declaration saving is confirmed — and its stated cause was wrong

- **Measured: 27,499 → 9,610 tokens of fixed prefix per `tm-implementer` turn**, a saving of
  **17,889 per turn**, re-paid on every turn. v1.1.1 predicted ~7,900 by extrapolating from
  `tm-reviewer`; the extrapolation was the wrong shape, since `tm-implementer` declares six
  tools to the reviewer's five and has a longer definition. The delta is the number that carries,
  not either absolute.
- **v1.1.1 said the declarations "could not take effect in the session that measured them"
  because Claude Code loads agent definitions at session start. That was right about the symptom
  and wrong about the cause,** and a reader who inherited it would have drawn the wrong
  conclusion: restarting would never have fixed it. Claude Code does not load this repo. It loads
  a snapshot under `~/.claude/plugins/cache/…/<version>/`, copied at the git SHA recorded in
  `installed_plugins.json`, and that snapshot was pinned 40 commits behind `master` — it contained
  no `usage.mjs`, no `quiet-reporter.mjs` and no `tools:` line on `tm-implementer`. Everything in
  v1.1.0 and v1.1.1 had never been exercised by the live harness at the time it was released.
- The practical consequence, which applies to this release too: **editing `agents/`, `skills/`,
  `hooks/` or `scripts/` changes nothing about a running session.** Run `claude plugin update
  claude-teammates@claude-teammates` and restart; an unbumped version makes the update a no-op.

## v1.1.1

Token-usage work. `npm test` stops emitting ~40,000 tokens of pass lines, a `usage` command makes
per-run token cost measurable, and the two agents that inherited every tool now declare the six
they need. No behaviour a plan or a gate depends on has moved.

### `npm test` costs ~126 tokens of output instead of ~40,372

- **A quiet test reporter** (`scripts/quiet-reporter.mjs`) prints failures and one summary line:
  161,489 chars down to 504, a **99.7% reduction** on a green run. `npm run test:verbose` keeps
  the full per-test output.
- Failures keep their full stack and diff, `test:stderr`/`test:stdout` pass through, the summary
  prints on red as well as green, and exit codes are unchanged. The whole saving comes from the
  success path, which is where the noise was.
- Counts come from the root `test:summary` event, never from tallying `test:pass` — a parent
  suite emits its own, which measured 5 where the truth was 4.

### `usage` — per-run token reporting

- **New subcommand:** `cli.mjs usage [--session <id>] [--json] [--root <path>]` reads the
  harness's transcript store and reports, per agent role, the turns, the fixed prefix, the prefix
  paid across all turns, cache reads and output.
- It reports the **fixed prefix** separately because totals hide the thing worth knowing: on run
  `fog` the integrator looked *cheapest* by cache reads while carrying a 5× larger prefix than a
  reviewer whose prompt was longer. Fixed prefix was 40% of all cache reads.
- An unparseable transcript is named and counted rather than skipped, a missing store fails
  naming the path rather than rendering zeros, and a transcript with no metadata keeps its row.
  Each of those would otherwise let the tool understate a total, which is how an optimization
  appears to prove a saving nobody made.
- Honours `CLAUDE_CONFIG_DIR`.

### Agents declare their tool sets

- `tm-implementer` and `tm-integrator` declared no `tools:` and so inherited every tool, including
  whatever MCP servers a session happens to have connected. Both now declare
  `Read, Write, Edit, Bash, Grep, Glob`. `tm-reviewer` already declared its own.
- Measured, with an identical probe prompt and model in one session: an agent whose declaration
  was active carried a **7,867**-token prefix against **27,499** for one without — **19,632
  tokens per turn**, of which agent-definition size explains only ~604. The prefix is re-read on
  every turn.
- **The saving is not yet confirmed for these two agents.** Claude Code loads agent definitions at
  session start, so the declarations added here could not take effect in the session that measured
  them; `HANDOFF.md` records the one probe that closes it. Least privilege stands on its own
  merits meanwhile: a teammate implementing one task in one worktree has no business holding the
  tool that sends email.

### Fixes

- **`projectSlug` stripped of the drive colon.** Every absolute Windows path carries a drive
  letter and a colon cannot appear in a Windows filename, so the slug named a directory that could
  never exist and `usage` could only ever miss there. Whether the harness itself substitutes the
  same character is unverified against a real Windows install.
- **Three test-only Windows failures**, each an assumption that POSIX semantics hold everywhere: a
  file mode asserted on a filesystem with no exec bit, a reporter path passed as a native path
  where the ESM loader reads `D:` as a URL scheme, and the slug above.

## v1.1.0

Plans gain three optional header sections, `finish` reports them, `rebuild-state` stops refusing
a defect it cannot let anyone fix, and the test suite stops spending ~40,000 tokens of context
per run. One CLI surface is new (`init-run` now refuses a malformed header section); the rest is
behaviour that was already promised.

### Plans can now state a destination, its fog, and its boundaries

- **`## Destination`, `## Not Yet Specified` and `## Out of Scope`** are parsed by
  `scripts/plan-sections.mjs`, compiled into `plan.json` by `init-run`, and reported by `finish`.
  All three are optional. An `## Out of Scope` section requires a `## Destination` **with prose
  under it** — an empty heading is refused exactly like an absent one, because "out of scope"
  means beyond the destination and a bare heading leaves that unjudgeable.
- **Two entry rules, checked for shape and not for truth.** Every Out of Scope entry needs a
  reason clause (a separator followed by non-whitespace); every Not Yet Specified entry must
  contain a `?`. A malformed section now fails `init-run` with the offending line quoted, its
  control bytes neutralised so a crafted entry cannot redraw the refusal above it.
- **`finish` prints the destination and the open fog** after the run summary, and says when those
  notes no longer match the plan at the anchor — the notes come from `plan.json` while the verdict
  is computed from git, and one report could previously describe two versions with nothing marking
  it.

### The test suite stopped costing 40,000 tokens a run

- **`npm test` prints failures and one summary line**, down from 161,489 chars (~40,372 tokens) to
  504 (~126), a 99.7% reduction on a green run. `npm run test:verbose` keeps the full output.
  This was measured, not guessed: across three real agent transcripts, fresh input was 212 tokens
  and cache reads were 2,190,488. Cache reads scale with turns × context, so anything sitting in
  an agent's context is paid for again on every later turn — and every agent in a fleet is told to
  run this command, some of them repeatedly.
- Failures keep their full stack and diff, stderr passes through, the summary prints on red as
  well as green, and exit codes are unchanged.

### Fixes

- **`ownership` no longer false-FAILs on a mode-only change.** `contentAt` compared blob bytes and
  never the tree mode, so a chmod was invisible in both directions: an honest merge carrying one
  could never be explained, and a tampered permission bit was waved through. The second half was a
  recorded limitation; one change closes both.
- **`rebuild-state` recovers from a section defect in the plan at the anchor** instead of printing
  `init-run`'s refusal and returning 2. That plan is a historical commit the operator cannot fix,
  and correcting the working-tree copy did not clear it. It now warns — naming the command, the
  anchor, and where the plan was read from — writes `null`/`[]`/`[]` for the three fields, and
  rebuilds everything git can vouch for. `init-run` still refuses, because it reads the working
  tree, where a defect is fixable.
- **A spaced thematic break no longer parses as a bullet.** `* * *` satisfied the bullet pattern,
  so `parseConstraints` injected `* *` as a constraint into **every teammate brief**, and a plan
  whose only defect was a horizontal rule was refused. Thematic breaks now outrank list items, per
  CommonMark. `+ + +` still parses as a list item, because `+` is not a thematic-break character.
- **`renderPlanNotes` defends its own input shape.** `plan.json` is teammate-writable and
  gitignored: a null plan and a null entry threw, a string `notYetSpecified` iterated per
  character into `  - undefined` rows, and a non-string destination rendered
  `Destination: "[object Object]"`. The fog list is also capped at 20 entries — it prints after
  the verdict, and 50,000 entries pushed the "do not land" lines off screen (50,005 lines / 3.1 MB,
  now 22 lines / 1.3 KB). The heading still reports the true total.
- **SessionStart hooks run on Unix again.** `hooks/run-hook.cmd` was committed 100644, so every
  Unix install died at exit 126, and the hook matched three of five SessionStart sources.
- **Windows CI is green again.** Two tests asserted a POSIX exec bit on a filesystem that has
  none; the index mode was correct throughout, and remains the assertion that matters.

### Tests

- Four claims the phase reviews found unpinned are now pinned, each confirmed unpinned first and
  re-checked by mutation afterwards: the `printable` call on the missing-reason refusal branch, the
  continuation lookahead's marker class, `init-run`'s section-before-task ordering, and the
  `if (notes)` guard in `finish`.
- Two vacuous assertions repaired: a phase comparison with no absolute expectation (gutting
  `assignPhases` left it green) and a U+2028 forgery check that split on `\n`, which that split
  can never produce.
- Prose corrected in four places where a comment claimed more than the code delivered.

## v1.0.1

All four follow-ups recorded under v1.0.0 below, closed. They are documentation or test
changes; no runtime behaviour moved, and no CLI, hook or gate surface changed.

- **A scan over statements now reaches headings too.** `claimSites` in `tests/md-contract.mjs`
  returns every place a claim can be written in a scope — statements built from prose, the scope's
  own heading, and every heading nested in it. The SubagentStop refusal scan reads it instead of
  `doc.statements`. Measured against the real tree before and after: a heading carrying the denied
  promise scored 0 hits under the old scan and 1 under the new one. The locked
  `The SubagentStop backstop` section additionally pins that it holds no nested heading.
- **Two documents no longer gloss the missing-branch refusal as "the branch to create".** The
  handler names the missing branch and sends the teammate to its brief for the step that creates
  it, deliberately declining to present a ref derived from a teammate-writable record as an
  instruction. `agents/tm-implementer.md` and `skills/fleet-supervision/SKILL.md` now say that, and
  both locked inventories were updated with them.
- **`skills/parallel-execution` no longer uses "block" in two senses one clause apart.** The
  gate-verdict sense now reads "fails the gate verdict"; the stop sense reads "refuses the stop".

And the fourth, **a region lock binds one block or one section**, which was recorded as needing a
corpus-wide scan rather than a patch:

- **`assertCorpusInventory` locks a mechanism across every document at once.** Every claim site in
  every skill and agent contract naming the SubagentStop mechanism must be one of the sentences
  listed in `tests/skill-contracts.test.mjs`, attributed to the document it appears in. A sentence
  added anywhere fails, and one moved between documents fails as surely as one reworded.
  Demonstrated by appending a contradicting sentence to `skills/phase-gate/SKILL.md` — a document
  no lock covered: the corpus lock failed and the cross-document denylist scan did not, which is
  the escape this closes. It buys location, not meaning: the subject pattern is a lexicon, so a
  sentence discussing the hook without naming it still passes, exactly as under a section lock.
- **A document's statements were counted once per enclosing heading.** `parseDoc` built
  `doc.statements` by concatenating overlapping sections, so a sentence under `### x` inside `## y`
  inside `# z` appeared three times — 316 entries for 154 sentences in `parallel-execution`. Scans
  survived it by checking the same sentence twice; a corpus inventory would have encoded nesting
  depth as content. Now built from the block list once, in document order.

## v1.0.0

First stable release. The plugin orchestrates a fleet of worktree-isolated teammates against a
written plan, and gates each phase on checks that recompute from git rather than from anything an
agent wrote.

### Enforcement

- **`SubagentStop` hook** (`scripts/subagent-stop.mjs`). A teammate that stops without a task branch
  is blocked once and told which branch its brief names; the always-enforced checks then run through
  `complete --enforcement-only`. Both are best effort by construction — the hook allows the stop on
  anything it cannot establish, so an unreadable record never costs a teammate a turn. The phase
  gate remains the enforcement.
- **Ownership** refuses any commit on the run branch that no task branch explains, with a
  base-ancestry allowance for mid-run plan amendments. It asks git about refs that exist now and
  reads no run state.
- **Fileset** enforces each task's declared file set per phase.
- **Merge preview** builds a scratch worktree, so a phase's `test` check is evidence about the merge
  rather than about one branch.

### Review

- **`claims` reviewer lens** with a mutation method: break what a claim protects, run the suite,
  report the claims that survive. Emits `unprobed` and `unableToVerify` so a bounded review cannot
  read as an exhaustive one.
- **Findings are stamped** with the branch tips they judged. `collect-reviews` refuses a file whose
  stamp names different tips, naming the lens and the reason rather than failing downstream.

### Supervision

- **`liveness`** heartbeat for stalled and parked teammates.
- **`map` / `map-notes`** coupling analysis, with blast radius rendered into implementer briefs.
- **`prune-run`** reports and reaps leaked merge-preview worktrees, unlinking Windows junctions
  before removal.

### Install-time behaviour

Installing registers a `SubagentStop` hook with no matcher and `async: false`: every subagent stop
on the machine synchronously spawns `node scripts/subagent-stop.mjs`, in any project, including one
with no teammates run. The handler resolves the stopping agent through a worktree location record
and returns immediately when it finds none, and any error is an allow. README.md states this under
"What installing registers".

### Compatibility

- Requires git 2.24 or newer (`--end-of-options`), declared and detected.
- Requires Node 24.2 or newer.

### Documented boundaries

These are properties of the design, not open defects. Each was measured during the release run and
each is stated where an operator will meet it — in `SECURITY.md` and in
`skills/parallel-execution/SKILL.md` — not only here.

- **`.teammates/` is teammate-writable and invisible to git.** The checks that recompute —
  `fileset`, `ownership`, `merge` — read git and never that directory. But an `agent`-kind check
  such as `review` has no result of its own: `collect-reviews` builds one from files under
  `.teammates/<runId>/reviews/`, which the enforced teammate can write. A planted set of
  empty-findings files reaches `PASS` with no reviewer having run. Treat a recorded `agent` verdict
  as evidence only about a reviewer you know ran.
- **The gate's check list is teammate-writable.** Which checks run comes from `teammates.gate.json`
  in the working tree. The computed results cannot be forged; the list deciding what runs is not
  itself protected.
- **A planted `runBranch` disarms stop-time enforcement** for a whole run and persists until an
  operator removes the field by hand. A planted worktree location record can block a victim teammate
  once.
- **The recorded branch name cannot be compared by eye.** The check is byte-wise and zero-width and
  homoglyph characters render identically in a terminal.
- **`init-run` records no run branch on a detached HEAD** (it records the literal string `HEAD`), and
  none at all in a repository holding both `main` and `master`, where it cannot resolve the base and
  accepts no `--base`.
- **An allowed stop is not a verdict.** Stop-time enforcement is a fast signal on the common honest
  mistake, not a barrier against a determined teammate.

## Known follow-ups for v1.0.1

Found by the release-gate review at the tagged tree, below the blocking threshold, recorded here
rather than fixed after the gate ran. **All four are closed in v1.0.1 above**; the list is kept as
written so the record of what shipped in v1.0.0 stays accurate.

- **The region locks in `tests/skill-contracts.test.mjs` ignore the heading of the region they lock.**
  `parseDoc` slices a section past its own heading and `statementsOf` builds statements only from
  paragraphs and list items, so a reversed claim placed in the heading of the SubagentStop backstop
  section, or of the block the contract lock binds, passes. The equivalent hole in the two prose
  sections is closed — those scan headings explicitly — so this is a consistency gap, not an unknown.
- **A region lock binds one block or one section.** Prose written outside it that avoids both the
  `refuse|reject|block` prefilter and the denied phrasings can still carry the claim. This is the
  documented scope bound of `tests/md-contract.mjs`, which states that a contradiction placed under
  another heading is out of scope by construction.
- **Two documents summarise the missing-branch refusal as naming "the branch to create"** —
  `agents/tm-implementer.md` and `skills/fleet-supervision/SKILL.md`. Two lenses raised this
  independently, which is why five findings are recorded here as four bullets. The
  branch in that message is derived from a location record under `.teammates/index/`, which any
  teammate can write, and `scripts/subagent-stop.mjs` deliberately declines to present it as an
  instruction — it sends the teammate to its brief, whose branch name comes from the dispatch rather
  than from a file a teammate can plant. The contract should describe the message the way the handler
  does.
- **Section 2 of `skills/parallel-execution` uses "block" in two senses one clause apart.** In "lands
  as a blocking `pending`" it means blocks the gate verdict; in "only a task-scoped failure blocks" it
  means refuses the stop. Both are true and the section is about the second, so the first should be
  disambiguated. Found independently of, and consistent with, the contract-gloss follow-up above,
  which two lenses raised separately.
