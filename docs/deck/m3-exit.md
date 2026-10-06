# M3 exit report (Unblock)

Status: **code ready, milestone not complete.** The suites below were run on 2026-10-04 on the
integrated M3 tree (run branch `run/deck-m3` at `1179b59`, phases 1 to 9 of run deck-m3a, plus this
task's version, build label and documentation changes). Exit criteria 4 and 5 need the owner and a
real Claude Code session, and are PENDING. So are the pinned real-Claude rule checks, the Orca smoke,
the "M3 before exit" decisions, the dogfood update and the tag and publication of `deck-v0.3.0`.
None of them is claimed here.

Exit criteria from [12-milestones.md](12-milestones.md) section 5:

| # | Criterion | State |
|---|---|---|
| 1 | A Destructive request is never answered without the confirm checkbox, never in a batch, never from a popup or a keyboard shortcut | Green (section 1.1) |
| 2 | With fake `claude`, answers `1`, `2`, `3` land; `did-not-land.json` shows "did not land" after the verify timeout; `answered-in-terminal.json` refuses the browser answer | Green on the fake `claude`, with the frames named in section 1.1: options 1, 2 and 3 land on synthetic frames built from the captured 2.1.285 permission box; the option 2 check on a real frame is PENDING (owner) |
| 3 | Suggestion after the configured count; write and revoke keep every other key and the order of `settings.local.json`; external edits show as "added by hand" | Green (section 1.1) |
| 4 | Manual: real Claude Code smoke answering all three options from the browser on the pinned version | PENDING (owner). Section 8 |
| 5 | Manual: one working week answering permission prompts from the deck with zero answers delivered to a prompt other than the one shown | PENDING (owner). Template in section 8 |
| 6 | The tier design-oversight review is done and resolved before M3 starts | Done 2026-10-02 (D-75 to D-83), before the run started |

## 1. Test suites

Run from the repository root of the task worktree on 2026-10-04. The hub suites need
`npm ci --prefix hub` first and a short `TMPDIR`, because Unix socket paths are limited to about
108 bytes.

| Suite | Command | Result |
|---|---|---|
| Root (fleetmates) | `npm test` | 2796 tests, 2779 pass, 0 fail, 17 skipped |
| Hub | `mkdir -p /tmp/hx && TMPDIR=/tmp/hx npm --prefix hub test` | 1465 tests, 1465 pass, 0 fail, 0 skipped, 0 todo (1463 at `1179b59`; this task drops one test from `m2-release.test.mjs` and adds three in `m3-release.test.mjs`) |
| Unblock e2e (M3) | `TMPDIR=/tmp/hx node --test --test-concurrency=1 test/e2e/unblock.spec.mjs` from `hub/` | 8 tests, 8 pass, 0 todo |
| Security e2e | same, `test/e2e/security.spec.mjs` | 15 tests, 15 pass, 0 todo |
| Accessibility e2e | same, `test/e2e/accessibility.spec.mjs` | 19 tests, 19 pass, 0 todo |
| Observe, control, settings-save and archive e2e | same, the four specs in one call | 76 tests, 76 pass, 0 todo |

Notes:

- The e2e specs are not part of `npm --prefix hub test`, and the hub suite is not in CI yet.
- Never run a bare `node --test` in this repository: its default glob includes
  `hub/test/capture/capture-cc.mjs`, which starts real Claude Code.
- In the unblock run, the Team test printed "run request tiers: T4 caution, T5 safe". The test
  tolerates either tier for the run rows because of the cold worktree cache (section 9, classifier).

### 1.1 Exit criteria 1 to 3: the evidence

Exit criterion 1 (Destructive is never answered without the checkbox, in a batch, from a popup or by a
shortcut):

- `unblock.spec.mjs` "Exit criterion 1 (drawer): Enter and Alt A on a Destructive row send nothing;
  its checkbox ticks only by click or Space; Alt Shift A leaves the Destructive and Caution rows" and
  "Exit criterion 1 (Home, palette, PromptBar): a Destructive card has no Allow; palette Enter opens
  the drawer on it; PromptBar digit 1 sends nothing". Each checks that the network log holds no
  answer request.
- `security.spec.mjs` "approval bypass (M3): a forged request whose command is not on screen is
  not_on_screen; a Destructive answer without confirm and a batch holding a Destructive id change
  nothing; a foreign origin cannot answer with a stolen token" (the server side, without the UI).
- `hub/test/integration/answer-api.test.mjs` "a Destructive answer without confirm is 409
  confirm_required and the fake receives nothing; with it the allow lands" and "a batch holding a
  Destructive id is 409 batch_not_safe and answers none"; `deliver.test.mjs` "a popup answer on a
  Caution request gets tier_forbids" and "prompt-swap: a Safe answer is refused not_on_screen when a
  Destructive prompt replaced it; Destructive needs confirm". All in the hub suite run above.

Exit criterion 2 (delivery with the fake `claude`):

- `unblock.spec.mjs` "Exit criterion 2 (PromptBar): digits 1, 2 and 3 land with approve-safe,
  approve-always and deny-then-instruct", "Exit criterion 2 (drawer): Allow once lands 1 on
  approve-safe; Deny lands 3 on deny-then-instruct and its follow-up reaches the session" and "Exit
  criterion 2 (did-not-land, answered-in-terminal): an unproved answer shows the error after 3 s; a
  terminal answer refuses the browser one and the row says so".
- The frames those scripts replay (from `hub/test/fixtures/scripts/`, checked for this report):
  `approve-safe.json` answers on `synthetic-permission-bash`; `approve-always.json` and
  `deny-then-instruct.json` on `synthetic-permission-always`; `answered-in-terminal.json` on
  `synthetic-permission-bash`; `did-not-land.json` on the captured 2.1.285 `permission-2` frame. The
  synthetic frames are the captured `permission-2` box with its command and description rows
  templated, marked SYNTHETIC in the scripts and in `deliver.test.mjs` (D-95). They exist because the
  2.1.285 recapture ran with an `ask` rule for Bash: its real Bash frames show only "1. Yes" and
  "2. No" around a fixed Caution command, so no real frame offers a Safe Bash request, a "don't ask
  again" option 2 or a "3. No" deny. So options 1 and 3 are proven landing on the fake `claude` with
  synthetic frames derived from the real 2.1.285 box, option 2 on `synthetic-permission-always`, and
  "did not land" on a real 2.1.285 frame. The same keys on real 2.1.285 Bash frames with three
  options, and option 2 on a real "don't ask again" Bash label, are PENDING (exit criterion 4 and
  the D-95 dogfood check, section 8).
- `deliver.test.mjs` "approve-safe ...", "approve-always (SYNTHETIC frame, D-95): option 2 lands only
  when allowAlways holds, else tier_forbids", "deny-then-instruct ...", "did-not-land: no proof in
  3 s gives did_not_land, the deck does not retry, and a late hook still answers", "answered-in-terminal
  ..." and "typing guard (D-84) ..." run the same scripts against a real deckd in the hub suite.

The plan's Not Yet Specified question on exit criterion 2 (whether option 2 counts when no real Bash
label names a pattern) is settled by D-95 and D-103: Allow always is offered only when option 2 reads
exactly "Yes, and don't ask again for <pattern>" and the pattern equals the deck's rule candidate, and
no Bash prefix rule exists. This report states the evidence above and leaves the criterion's wording
to the owner.

Exit criterion 3 (rules): `unblock.spec.mjs` "Exit criterion 3: three Safe approvals offer "Make it a
rule?"; accepting writes the rule and keeps every other key, Undo removes it as an undo, and a
hand-added rule shows "added by hand"", with the threshold at 3 and a temp repo's
`settings.local.json`; `hub/test/integration/rules-api.test.mjs` "POST, GET and DELETE /api/rules
round trip on a temp repo keeps the other keys of the settings file" and "DELETE with ?undo=1 is the
toast Undo ...".

Other M3 surfaces: `unblock.spec.mjs` "Team: "Review 2 requests" opens the drawer on the run's rows
only, and its keys answer only those rows" and "Focus Changes: the diff of a file the session
edited, against the baseline of its SessionStart".

## 2. The run: phases, tasks and gate verdicts

Gate verdict files are in the run's handoff directory (`.fleetmates/deck-m3a/handoff/gate-m3-*.json`,
gitignored run state). Read for this report:

| Phase | Tasks | Gate |
|---|---|---|
| 1 | T1, T2, T3, T4, T5, T6, T11 | FAIL on review in rounds 0 to 5, PASS in round 6 |
| 2 | T19, T7, T12, T14, T15 | FAIL on review in every recorded round (1 to 7). Integrated with known findings by owner decision D-92; Task 20 closed them in phase 4 |
| 3 | T21 (session archive merged in, D-93) | PASS |
| 4 | T20, T13 | FAIL on review, then FAIL in rounds 1 and 2, PASS in rounds 3 and 4 |
| 5 | T8, T9 | FAIL on review in rounds 0 to 2, FAIL on `hub-test` and review in round 3, PASS in round 4 |
| 6 | T10 | FAIL on review, PASS in rounds 1 to 4 |
| 7 | T16 | PASS, and PASS in round 1 |
| 8 | T17 | PASS in round 1 |
| 9 | T22, T23, T24 | PASS, and PASS in round 3 |
| 10 | T18 (this task) | not gated yet |

The owner decided D-87 to D-103 between rounds (section 7); D-89 and D-90 each record an extra Task 7
fix round the owner authorized. The phase 1 to 7 review archives were lost; their
non-blocking findings come from the orchestrator's ledger. The phase 8 and 9 review JSON was read for
section 9.

## 3. The Claude Code 2.1.285 recapture (Task 19)

- Authorization: D-83 authorized one recapture in a prompting permission mode for Bash, Edit, Write
  and WebFetch. The installed Claude Code was 2.1.285, not the pinned 2.1.282, and the owner chose to
  recapture on 2.1.285 and allowed the session to run unattended. No other real Claude Code session ran
  in M3.
- Date and size: `capturedAt` 2026-10-02T22:15:16Z, 120x40, capture script 0.2.0 (from
  `hub/test/fixtures/hooks/2.1.285/MANIFEST.json`).
- Files: `hub/test/fixtures/hooks/2.1.285/` (hook payloads for SessionStart, SessionEnd, PreToolUse,
  PostToolUse and PermissionRequest of Bash, Edit, Write, WebFetch, Read and AskUserQuestion,
  Notification, PreCompact, PostCompact, Stop, SubagentStop, UserPromptSubmit, and
  `sequence.approve-safe.jsonl`) and `hub/test/fixtures/screens/2.1.285/` (`trust-folder`,
  `idle-input`, `spinner`, `permission-2`, `tool-output`, `permission-edit`, `permission-write`,
  `permission-webfetch`, `permission-bash-long`, `question-options`, `question-text`, `compacting`,
  each `.ansi` with its `.expect.json`, plus the two SYNTHETIC frames `synthetic-permission-bash` and
  `synthetic-permission-always` that later tasks added). Not copied: the ToolSearch payloads.
- Skipped steps (MANIFEST `skipped`): `bash-2` (no `PostToolUse(Bash)`) and `bash-3` (no
  `PreToolUse(Bash)`). The script set an `ask` rule for Bash, so the Bash prompt showed only "1. Yes"
  and "2. No"; there is no Bash option 2 label and no `option2-rule.json`. Edit and Write option 2 is
  "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this
  session (shift+tab)". WebFetch option 2 is "Yes, and don't ask again for example.com". The long Bash
  command wrapped inside the box instead of being cut.
- Redaction review: `capture-cc.mjs` redacted the repo path, `$HOME`, account email, display name,
  organization, username, session ids, transcript path, typed prompts, JWTs and token-like runs. By
  hand, before commit: the PostCompact `compact_summary` and SubagentStop `last_assistant_message`
  (they quoted the owner's instruction files), the
  claude.ai session link id in `idle-input.ansi`, the subagent id, the `prompt_id` UUIDs new in
  2.1.285, and the throwaway repo name in `scratchpad_dir` and a status line (all listed in the
  MANIFEST `redactions`). According to the run ledger, the Task 19 commits were rewritten so raw
  prompt ids never reached a shared branch; not re-checked here. Left as is (low): the status line in
  `tool-output.ansi` shows account usage percentages, and `trust-folder.ansi` shows two of the owner's
  allow rules with their paths redacted. The redactor still lacks rules for the hand-redacted fields
  (section 9).
- Pin move: `fleetmatesDeck.testedClaudeCode` in `hub/package.json` is 2.1.285. The 2.1.282 set stays
  in the tree as the earlier regression set.

## 4. Accessibility audit and the fix tasks

Task 17 audited the answering drawer (Safe, Caution, Destructive and question rows), the PromptBar
for each tier, Settings Approval rules with the revoke dialog open and the Changes diff with axe and
the keyboard. Findings and their fix tasks (added by amending the plan after Task 17, as in M2):

| Id | Severity | Finding | State |
|---|---|---|---|
| T17-F1 | S2 | Focus asks for the Changes diff by the absolute path the Edit hook reported, and the server refused every absolute name, so every diff showed "Could not read the diff: validation_failed" | Fixed by Task 22: an absolute name is served when it is exactly one of the session's changed files inside the work tree |
| T17-F2 | S2 | When the focused drawer row was answered and left, focus fell to `<body>`, so the drawer keys, the Tab trap and Esc stopped working | Fixed by Task 23: focus moves to the next row, else the previous one, else the close button |
| T17-F3 | S3 | axe `landmark-unique`: drawer sections with equal counts had the same name | Fixed by Task 23: each section is named by its title and count ("Needs you · 1") |
| (claims review) | | A late `--run` command stamped behind an early-flushed PermissionRequest left the session `solo` | Fixed by Task 24 |

`accessibility.spec.mjs` and `unblock.spec.mjs` hold no todo test (0 todo in the runs above). The
Orca smoke is PENDING (section 8).

## 5. Release preparation

- Version 0.3.0 in `hub/package.json` (still `"private": true`) and in the two root entries of
  `hub/package-lock.json`. `hub/CHANGELOG.md` has the `v0.3.0` entry: tested Claude Code 2.1.285,
  "deckd changed: yes" (the guarded write), and migrations `0003-archive` and `0004-approvals`.
- Build label: `GET /api/version` reports `build: 'm3'` and `BUILD` in `hub/web/src/state/api.js` is
  `'m3'`. Assertions updated: the two `hello` builds and the reload-guard key
  (`fleetmates-deck.reloaded.m3`) in `web-shell.test.mjs`, the `/api/version` body in
  `m1-web-fixes.test.mjs`. `m2-release.test.mjs` keeps its CHANGELOG and lockfile checks and drops its
  build test, which `m3-release.test.mjs` takes over.
- Mutations: with the CHANGELOG heading changed to `v0.3.1`, `m3-release.test.mjs` failed 3 of 3
  (`'0.3.1' !== '0.3.0'`); restored, 3 of 3 pass. With the build label reverted to `'m2'` in
  `api.mjs` and `api.js`, four tests failed: the `/api/version` test of `m3-release.test.mjs`, "the
  REST client hands screens the bare body the real deck server sends" of `m1-web-fixes.test.mjs`, and
  "reconnect sends lastSeq and epoch ..." and "heartbeat silence reconnects ..." of
  `web-shell.test.mjs`; restored, they pass.
- README: answering and its tier rules, rules in `settings.local.json`, `tiers.json` and its error
  banner, `fleetmates-deck audit`, and the M3 limits.
- Publication: PENDING. Tag `deck-v0.3.0` and publish only after this report, the owner checks and Q1.

## 6. Spec deviations recorded

- [05-api.md](05-api.md): the `hello` `features` list and the `write` `guard` with `screen_changed`
  and `typing_in_terminal` (replacing `expectPrompt` and `E_PROMPT_CHANGED`); the codes
  `deckd_outdated`, `options_unreadable`, `skipped_not_safe`; the answer and batch statuses (409, not
  422 or 403); the `Request`, `RuleView` and `RuleOffer` fields; `tiersError` and `?undo=1` on the
  rule routes; the GET that refreshes the rule mirror.
- [06-storage.md](06-storage.md): migration 0004 (`requests.reasons`, `requests.confirm_label`,
  `approval_audit`) and its retention.
- [07-approvals.md](07-approvals.md): `tiers.default.json` as built, the plain floor (D-87), the
  D-88 to D-92 rules, the rules left after D-98, D-102 and D-103, the guarded write in 5.1, the
  `reset_files` count, and the worked examples whose tier changed.
- [09-testing.md](09-testing.md): the scenarios that exist (3.5) and the 2.1.285 recapture (5.2).
- [13-operations.md](13-operations.md): the `audit` output (4.3).
- [14-decisions.md](14-decisions.md): D-87 to D-103 (D-94 and D-96 were never assigned).
- [15-open-questions.md](15-open-questions.md): SET-O4, DRW-O2, APR-O6, APR-O7 and APR-O8 with the
  defaults that shipped, still the owner's.
- Copy decks: [screens/focus.md](screens/focus.md) and [screens/settings.md](screens/settings.md)
  gained the M3 strings they lacked; [screens/needs-you-drawer.md](screens/needs-you-drawer.md),
  [screens/home.md](screens/home.md) and [screens/palette.md](screens/palette.md) already held every
  M3 string of their screens and got an as-built note. Checked with a script that reads each
  screen's `*_COPY` object in `hub/web/src` and looks for every string in the screen's copy deck.

## 7. Owner decisions during the run

D-87 to D-103 are recorded in [14-decisions.md](14-decisions.md) section 1.7 and applied in the docs
each row lists. In short: Bash Safe needs a plain command from an allowlist (D-87) with bare in-repo
paths (D-88); the execution-config list grew and several named lists became fail-closed rules
(D-89, D-90); runner steering joined the accepted residual (D-91); phase 2 was integrated with known
findings that Task 20 closed (D-92); the session archive was merged in by Task 21 (D-93); Allow
always fails closed on unseen wording (D-95); the Bash rule form (D-97); no Bash prefix rules at all
(D-98 to D-103). On 2026-10-04 the owner waived the M1 dogfood week as a gate for starting M4.

## 8. Owner checks still PENDING, and the one-week log template

| Check | Reference |
|---|---|
| Exit criterion 4: the [09-testing.md](09-testing.md) section 5.4 smoke row "`fm claude` in a second repo, answer from the browser", answering all three options. The plan names 2.1.282; the pin is now 2.1.285, so run it on the pinned version | [09-testing.md](09-testing.md) section 5.4 |
| Exit criterion 5: one working week answering from the deck | Template below |
| D-95: the Bash option 2 wording, on the first real Bash prompt that offers "don't ask again" (no captured frame shows it) | [07-approvals.md](07-approvals.md) section 6 |
| D-97: the rule form a real session writes for option 2 (no `option2-rule.json` was captured) | [07-approvals.md](07-approvals.md) section 7.1 |
| Pinned real-Claude rule checks: a prefix rule does not approve a chained command; whether `Bash(npm run test:*)` also allows `npm run test-and-publish` (F16); option 2 writes the same `settings.local.json`; whether a running session picks up an added or revoked rule without a restart (APR-O7) | [07-approvals.md](07-approvals.md) section 13 |
| Whether Claude Code matches rule tool names case-insensitively (the validator accepts `bash` as a tool-wide Caution rule) | Section 9 |
| Orca screen reader smoke on the answering drawer, the PromptBar and Settings Approval rules | [09-testing.md](09-testing.md) section 11.2 |
| Dogfood check: after an answered drawer row leaves, focus is on the next row's "Allow once", so a repeated Enter or `Alt A` allows the next Safe or Caution request. Is that acceptable? | [screens/needs-you-drawer.md](screens/needs-you-drawer.md) section 9 |
| "M3 before exit" items with their shipped defaults: SET-O4 (5, 3, Never; re-offer after dismissal), DRW-O2 (description from the headline reason), APR-O6 (multi-question prompts answered in the terminal), APR-O7 (toast says running sessions may keep the old rule), APR-O8 (request audit 30 days, rule and tiers events kept). PAL-O3 is decided (D-85) | [15-open-questions.md](15-open-questions.md) |
| M1 dogfood week: still PENDING ([m1-exit.md](m1-exit.md)); the owner waived it as a gate for starting M4 on 2026-10-04 | [m1-exit.md](m1-exit.md) |
| Dogfood install: `~/deck-dogfood` has not been updated with M3. deckd changed, so the update needs a deckd restart, which ends every PTY session; the owner approves the moment | [13-operations.md](13-operations.md) section 4 |
| Tag `deck-v0.3.0` and publish | PENDING, after this report and Q1 (`"private": true`) |

Copy to `docs/deck/dogfood/<yyyy-mm-dd>-m3.md` and fill in one block per working day. The criterion
passes with one working week in which permission prompts were answered from the deck and no answer
reached a prompt other than the one shown. Log every answer from the deck; `fleetmates-deck audit
--since <first day>` prints them to compare with.

    # M3 one-week check, <start date> to <end date>

    Build: deck <version or commit>, deckd <version from fleetmates-deck doctor>
    Claude Code: <version> (pinned: 2.1.285)

    ## Day N, <weekday yyyy-mm-dd>

    Sessions in deckd: <n>; plain claude: <n>
    Answers from the deck:
    | Time | Repo | Tier | Surface (drawer / card / palette / PromptBar / popup / batch) | Choice | Landed (yes / did not land) | Prompt it reached was the one shown (yes / NO) |
    |---|---|---|---|---|---|---|
    Answers delivered to a different prompt: <none, or each with what was shown and what was answered>
    Refusals seen (not_on_screen, typing_in_terminal, deckd_outdated, others): <list>
    Rule suggestions accepted or dismissed: <list>
    Bash option 2 wording seen (D-95): <none, or the exact label>
    Bugs filed (severity): <none or list>
    Day result: <pass / fail, why>

    ## Summary

    Days: <n> of 5
    Answers from the deck: <n>; delivered to a different prompt: <n, must be 0>
    Verdict: <passed / not passed>

Days 1 to 5: PENDING.

## 9. Open findings

The non-blocking review findings carried from phases 1 to 9, from the orchestrator's ledger and the
phase 8 and 9 review JSON, plus one this task found. Each was checked against the code on 2026-10-04
by `grep` and by reading the line named, unless the State column says otherwise; "ran" marks the
ones checked by running code. Severity is the reviewer's.

### Classifier and rules (`hub/server/approvals/`)

| Severity | Where | Finding | State |
|---|---|---|---|
| Low | `tiers.mjs:1885-1913` (`createWorktreeCache`) | `get` returns an empty list until the first `git worktree list` lands, so the first request from a linked worktree is Caution with `scope.cwd` or `runner.outside`; an identical later request is Safe. Fails closed | Open. The unblock Team test tolerates it (it printed "T4 caution, T5 safe" in this task's run). Suggested owner: a classifier follow-up task (re-classify when the read lands, or show a "checking" reason) |
| Info | `tiers.mjs:589-620` (`hooksPathCache`) | Until the `core.hooksPath` read lands for a repo, writes and runners there are Caution `file.execution-config` | By design (D-92 (a), fails closed). Ran: the first `cargo test` and `Write src/b.rs` in a fresh repo were Caution, Safe 1.5 s later |
| Low | `tiers.mjs:606-608` | (T20 residual) The hooksPath cache key missed edits to an included git config file alone | Fixed by Task 20's later rounds: the key now covers every file a read named as a source or include target. Comment read; not re-tested here |
| Info | `tiers.mjs:589-604` | (D-91 residual) `/etc/gitconfig` and an `XDG_CONFIG_HOME` outside home were not read for `core.hooksPath` | Fixed by Task 20 (D-92 (a)): git itself reads `core.hooksPath` now. Not re-tested here |
| Info | `floor.plain` | `git diff HEAD~1` is Caution (`~` is not plain text) | By design (D-87). Ran |
| Info | 07-approvals 3.5 | D-88 accepted residuals: `grep -r` and `rg -uu` print an in-repo `.env`; `git log -p`, `git grep`, `git show` print committed secrets; `git ls-files -s` plus `git show <blob>`; `git remote -v`; in-repo writes to `.vscode/tasks.json` and `CLAUDE.md` are Safe | By design (D-88, D-91), documented in 07-approvals 3.5. Ran for the two writes |
| Medium | `shell.mjs` word lookups | (phase 1) The command word `constructor` threw in the classifier | Fixed by Task 20 (D-92 (d)). Ran: `constructor`, `constructor x` and `__proto__` classify Caution with no throw |
| Medium | `tiers.mjs:119` | (Task 7) `GNUmakefile` and `BSDmakefile` were not on the execution-config list | Fixed by Task 7 (D-89 (1)). Ran: `Write GNUmakefile` is Caution |
| Low | `rules.mjs:528` (`validatePattern`) | Lowercase `bash` is accepted as a tool-wide Caution rule with `warning: 'toolWide'`; this matters only if Claude Code matches tool names case-insensitively | Open. Ran. Suggested owner: the owner checks Claude Code's behaviour (section 8), then a rules follow-up if needed |
| Info | `rules.mjs` | A hand-typed exact Bash rule that classifies Caution is accepted (`Bash(npm run test --script-shell=/tmp/e)`) | By design (D-101 exact-rule policy). Ran |
| Info | D-103 | Allow always is never offered for `npm run` (Claude Code's label names `npm run test:*`, the candidate is exact) | By design (D-103) |
| Low | `rules.mjs:719-720` | The `writeRule` docblock still says callers pass `Bash(<prefix>:*)` (D-97); stale since D-103 | Open. Suggested owner: the next task that owns `rules.mjs` |
| Info | `rules.mjs` writer | A short window between the re-read compare and the rename can lose a concurrent edit | By design (07-approvals 7.2 step 7) |
| Low | `tiers.mjs:72-73`, `rules.mjs:261-262` | The persistence lists are copied in two modules; `test/unit/rules/validate.test.mjs:185` asserts they are equal | Open, pinned. Suggested owner: a refactor task that exports one list |
| Low | `server/screen/prompt.mjs:50-57` | `truncated` relies on a `…` marker no captured frame shows (the long 2.1.285 command wraps) | Open, marked in the code. Suggested owner: the owner, on a real long prompt; then the parser |
| Low | `server/machines/projector.mjs:88`, `tiers.mjs:1865` | `headlineReason` duplicates the classifier's inline headline rule | Open. Suggested owner: a refactor task that exports one helper |
| Low | `hub/server/http/api.mjs:443`, `hub/web/src/screens/settings/ApprovalRules.jsx:130-137` | (found by this task) A refused rule other than `destructive_rule` and the I/O codes shows the raw code in Settings: the API sends `message` equal to the code and the server text in `details.message`, and `ruleErrorText` reads `message`. So "Script rules name one script exactly." and "Not a Claude Code permission pattern." never reach the dialog, which shows `invalid_pattern` | Open. Ran the HTTP side (POST of `Bash(npm run test:*)` answered `"message":"invalid_pattern"` with the text in `details`); the Settings render was not run. Suggested owner: a web follow-up |
| Low | `api.mjs` `GET /api/rules`, `rules.mjs:808` (`listRules`) | The GET refreshes the rule mirror and can append `found` and `vanished` rows to `rule_audit`, against 08-security 3.6 "GET never changes state" | Open, documented in 05-api 2.5. Suggested owner: the owner decides between documenting it in 08-security and moving the reconcile out of the GET |
| Low | `hub/server/main.mjs:170-175` | `tiers.json` is not watched when the config directory is missing at server start (`fs.watch` fails inside a `try`) | Open (`init` creates the directory). Suggested owner: a server follow-up |

### Delivery and verification (`deliver.mjs`, `request.mjs`, `link.mjs`)

| Severity | Where | Finding | State |
|---|---|---|---|
| Medium | `hub/server/main.mjs:197-198` | (T10 r1, r3) A server restart left `delivery` at `sending` or `verifying`, blocking later answers | Fixed by Task 16 (`recoverDeliveries` at start; `test/integration/deliver-recovery.test.mjs`) |
| Low | `main.mjs:455-471` | (T5, T10) The notification machine and the deliverer were not closed on shutdown | Fixed by Task 16 |
| Low | `main.mjs:141-156`, `:215` | (T10) `expired`, `tiers_loaded` and `tiers_rejected` audit rows had no writer | Fixed by Task 16 |
| Low | `request.mjs:946-950` | (T10 r3) A `stop_question` deck reply that did not land was credited to the deck when the owner typed other text | Fixed in Task 10's rounds: the UserPromptSubmit text is checked against the reply digest |
| Low | `request.mjs:958` | (T10 r2) An AskUserQuestion deck reply that did not land, then the owner's own reply, was recorded via browser | Fixed in Task 10's rounds: the reported answer is checked against the reply digest |
| Low | `deliver.mjs:417` | (T10 r4) An accepted Try again with a different choice uses the pending answer, not the earlier `did_not_land` one that may have reached Claude. Attribution only | Not re-verified; carried as open. Suggested owner: a delivery follow-up |
| Low | `projector.mjs:117` | (T10 r4) The `Request` view exposes the stored `answer` while delivery is in flight, including the salted reply digest | Open, documented in 05-api 2.4. Suggested owner: a server follow-up that strips it |
| Low | `deliver.mjs` | (T10 r4, tests) The accepted-path `clearAttempt` and the closed-row `verifying` delivery of row 15 are unpinned | Not re-verified; carried as open (tests) |
| Low | `hub/server/pty/link.mjs:300` | (T10 r4) A guarded write whose keys deckd wrote but whose reply was lost (timeout or closed) becomes `deckd_unavailable` and is treated as refused | Open: the line still maps `closed` and `timeout` to `deckd_unavailable`. Suggested owner: a delivery follow-up (verify an unknown outcome like an accepted one) |
| Info | `NeedsYouDrawer.jsx:287-291` | (T12) The drawer's batch list does not leave out a `queued` row | By design: the server retries a batch id that is not on screen yet until the verify timeout (`deliver.mjs:571-572`) |
| Low | `server/machines/session.mjs:764-766` | (T24 diagnosis) `since_ts` moves on every applied hook, not only on state-changing events as state-machines 1.4 and `0001-init.sql` say | Open. Suggested owner: the owner decides between the spec and the code |
| Info | `deck-hook` | The macOS stamp-to-send gap through the `ps` fallback is unmeasured | Open (no macOS run in M3) |
| Low | `projector.mjs:425-427` | (T24 round 3 claims) The comment says the envelope's PTY and pid must both match and an envelope with neither passes; `sameKnownProcess` (`session.mjs:514-523`) checks each field on its own. Unpinned survivors: equal stamps, dropping `applied === 1`, `session.alive` or the Bash filter in the late join | Open. Suggested owner: a follow-up that owns `projector.mjs` |

### Web (`hub/web/src/`)

| Severity | Where | Finding | State |
|---|---|---|---|
| Low | `screens/failures/Failures.jsx:175` | (T14) Settings got no `dispatch`, so the revoke toast showed inline | Fixed by Task 16 |
| Low | `Failures.jsx`, `Focus.jsx:877-878`, `TeamRun.jsx:592` | (T13) The palette's "Allowed ..." toast showed only when opened from Home | Fixed by Task 16 |
| Low | `server/http/api.mjs:183-187` | (T16) `GET /api/rules` lacked the per-rule `tracked` flag | Fixed by Task 16 |
| Low | `server/main.mjs:386-389` | (T16) The WebSocket upgrade listener counted an unauthenticated socket as a tab | Fixed by Task 16 round 1: the upgrade is authorized first |
| Low | `screens/drawer/NeedsYouDrawer.jsx:455`, `state/actions.js:151` | (T17 claims) The drawer toast Undo did not send `?undo=1`, so the `revokeRule` doc claim held for Home only | Fixed by Task 23: both toasts send it |
| Low | drawer | (T12) The "Reconnecting to the deck server…" dimming is not built and a failed single answer shows no message (no copy string exists; `grep` of `hub/web/src` finds none) | Open. Suggested owner: a web follow-up with copy from the owner |
| Info | Home cards | (T13) No 30 s "Tell Claude what to do instead" on a card after Deny; observed cards keep the M1 markup | By design (the plan did not ask for it); noted in [screens/home.md](screens/home.md) |
| Low | `hub/test/unit/focus-m3.test.mjs:118-119` | (T15) The Edit-labels test reads the 2.1.282 `permission-edit` frame although the 2.1.285 one exists | Open. Suggested owner: a test follow-up |
| Low | `server/http/api.mjs` | (T16) A DELETE with a body is ignored, not refused | Not re-verified; carried as open |
| Low | `server/main.mjs:417` | (T16 r1) The popup single-request guard is unpinned (`notification.mjs` enforces it) | Not re-verified; carried as open (tests) |

### Tests and fixtures

| Severity | Where | Finding | State |
|---|---|---|---|
| Medium (security) | `hub/test/capture/capture-cc.mjs` | The redactor has no rule for `prompt_id`, `scratchpad_dir`, `compact_summary`, `last_assistant_message` or OSC 8 session links; the 2.1.285 set was redacted by hand (section 3) | Open: a `grep` of the script finds none of those names. Suggested owner: a task before the next recapture |
| Low | `hub/test/unit/approvals-shell.test.mjs:278` | The 100 KB linear-time test failed once under load at 87.9 ms | Mitigated: it now takes the best of 5 runs; it passed in both hub runs of this task |
| Medium | `hub/test/e2e/unblock.spec.mjs:400-406` | (phase 8 claims) The comment said the 150 ms pause between the lead's hooks keeps the order a real session sends them | Fixed by Task 17 round 1: the comment now says the fake fires async hooks about a millisecond apart and the pause stands in for a real session's spacing |
| Low | `hub/test/e2e/security.spec.mjs:452-453`, `hub/test/e2e/accessibility.spec.mjs:399` | Comments still say Focus asks for the diff by an absolute path the server refuses, and the security test answers the diff request with a relative-path stub; stale since Task 22 | Open, outside this task's files. Suggested owner: a task that owns those specs |
| Low | `screens/2.1.285/tool-output.ansi`, `trust-folder.ansi` | The status line shows account usage percentages; the trust frame shows two of the owner's allow rules with paths redacted | Kept as is (low) |

### Session archive (run deck-ar1, merged into M3 by Task 21)

| Severity | Where | Finding | State |
|---|---|---|---|
| Medium (tests) | `server/machines/projector.mjs` (`urgencyOrder`) | The archived filter of the urgency order is unpinned (no test asserts `order.changed` on archive or unarchive) | Not re-verified; carried as open |
| Low (tests) | `web/src/state/deck-store.js:98` | The rejoin guards are unpinned | Not re-verified; carried as open |
| Low (claims) | `server/machines/counts.mjs:5` | The comment says archived sessions "and their requests count only in `archived`", but `archived` counts sessions only (`counts.mjs:9`) | Open |
| Low | `components/SessionCard.jsx` | "Could not change the archive: {message}" was not in the archive copy | Fixed: [archive.md](archive.md) lists it |
| Medium (tests) | `hub/test/e2e/archive.spec.mjs:167-173` | The 25-session paging test never requires a "Show more" click (the loop can run 0 times) | Open. Suggested owner: an archive test follow-up (assert a first page of 20 and at least one click) |
| Low (tests) | `archive.spec.mjs` | The archive-finished auto-unarchive test seeds no edited session | Not re-verified; carried as open |

## 10. Follow-ups outside this task's files

- `hub/test/e2e/security.spec.mjs` (the diff-route stub) and `hub/test/e2e/accessibility.spec.mjs`
  (the T17-F1 comments) are stale after Task 22 (section 9). Not edited here.
- [08-security.md](08-security.md) section 3.6 says `GET` never changes state; `GET /api/rules`
  refreshes the rule mirror (section 9). Not edited here.
- [screens/team-run.md](screens/team-run.md) lacks "Gate {n} passed at {time}." of `TEAM_COPY`, an M2
  string the copy check found; not an M3 string, not edited here.
