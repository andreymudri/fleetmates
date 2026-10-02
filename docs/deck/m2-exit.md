# M2 exit report (Control)

Status: **code ready, milestone not complete.** The automated suites, budgets and the release
preparation below were run on 2026-10-02 on the integrated M2 tree (run branch tip `3eea239` plus
this task's documentation and version changes). Exit criterion 6 (two manual working days), the
manual smoke with real Claude Code, the Orca and keyboard checks, the owner decisions in section 7,
and the tag and publication of `deck-v0.2.0` are still PENDING. They need the owner and are not
claimed here.

Exit criteria from [12-milestones.md](12-milestones.md) section 4:

| # | Criterion | State |
|---|---|---|
| 1 | Launch from the UI: the session reaches `running` and the task is typed only after the idle box appears | Green (section 1.1) |
| 2 | Web server restart with 3 live PTYs: all 3 stay alive and controllable after the browser reconnects | Green (section 1.1) |
| 3 | Shared input: "Last typed from" is correct for terminal and browser, and the collision chip appears within the collision window | Green (section 1.1) |
| 4 | Focus, New session, Team run and Crew sheet acceptance criteria green | Green for every M2 criterion (section 1.2). Focus AC4 to AC6 answer from the PromptBar, which is M3 |
| 5 | Accessibility audit done on the React build; S1 and S2 findings fixed | Done; both fixed, no axe finding of any impact left (section 3) |
| 6 | Manual: two working days with every session started by `fm claude` or the UI and Focus as the main control surface, no keystroke lost or duplicated | PENDING (owner). Template in section 8 |

## 1. Test suites

Run from the repository root. The hub suites need `npm ci --prefix hub` first and a short
`TMPDIR`, because Unix socket paths are limited to about 108 bytes. Machine and load in section 2.

| Suite | Command | Result |
|---|---|---|
| Root (fleetmates) | `npm test` | 2796 tests, 2779 pass, 0 fail, 17 skipped |
| Hub | `mkdir -p /tmp/hx && TMPDIR=/tmp/hx npm --prefix hub test` | 905 tests, 905 pass, 0 fail, 0 skipped, 0 todo |
| Observe e2e (M1) | `TMPDIR=/tmp/hx node --test --test-concurrency=1 test/e2e/observe.spec.mjs` from `hub/` | 39 tests, 39 pass, 0 todo |
| Security e2e | same, `test/e2e/security.spec.mjs` | 14 tests, 14 pass, 0 todo |
| Accessibility e2e | same, `test/e2e/accessibility.spec.mjs` | 14 tests, 14 pass, 0 todo |
| Settings save e2e | same, `test/e2e/settings-save.spec.mjs` | 1 test, 1 pass |
| Control e2e (M2) | same, `test/e2e/control.spec.mjs` | 30 tests, 30 pass, 0 todo |

The five e2e specs were also run together in one `node --test --test-concurrency=1` call: 98 tests,
98 pass, 0 todo, in 152 s.

Notes:

- The e2e specs and the performance scripts are not part of `npm --prefix hub test`, and the hub
  suite is not in CI yet. The release workflow runs the observe, security and accessibility specs,
  not `control.spec.mjs` or `settings-save.spec.mjs`.
- Never run a bare `node --test` in this repository: its default glob includes
  `hub/test/capture/capture-cc.mjs`, which starts real Claude Code.
- Timing-sensitive tests can fail under load. In this task's first hub run, `fm.test.mjs` "SIGHUP to
  fm attach detaches without printing and leaves the PTY running" failed once (`fm died of signal
  1`); the next full run passed. Section 6 lists the tests seen flaky during the run. Rerun a lone
  failure on its own before treating it as real.

### 1.1 Exit criteria 1 to 3

| # | Integration test (hub suite) | Browser test (`control.spec.mjs`) |
|---|---|---|
| 1 | `launch.test.mjs` "a launch stays starting after SessionStart, gets its task typed on the idle screen, then runs" (fake `claude` on `slow-start.json`; the task arrives as one bracketed paste at least 900 ms after `SessionStart`, and `launch_task` is cleared once typed) | "New session AC3, AC4 and exit criterion 1: a busy repo warns but launches; Alt Enter posts repoKey and task, opens Focus with the terminal focused, and the task is typed after the idle box" |
| 2 | `restart.test.mjs` "a restarted server reconciles the three running PTYs and the reconnected tab types into each again" (the first server is closed, a second one starts on the same deckd) | "Exit criterion 2: a server restart with three live PTYs; the page reconnects without a reload and types into each again" |
| 3 | `shared-input.test.mjs` "kitty types, the browser types inside the window: terminal_active, collision, quiet, lastInputFrom browser, then detached", plus the four machine tests in the same file (constants, collision hold, settle, no collision outside the window) | "Exit criterion 3: fm claude in a terminal and the browser type into one session; "Last typed from" follows the typist and crossing keystrokes show the collision chip" |

The criterion names `slow-start.json` and `idle.json`; the launch test uses `slow-start.json` only.
`idle.json`'s Stop hook would move the session to idle on its own, so the empty-task case
("an empty plain launch writes no input, even on an idle screen, and goes idle on SessionStart
(row 5)") uses an inline script instead.

### 1.2 Screen acceptance criteria (`control.spec.mjs`)

| Screen | Criteria with a passing test |
|---|---|
| Focus ([screens/focus.md](screens/focus.md) 10) | AC1, AC2, AC3, AC7, AC8, AC9, AC10, AC11, AC12 (Changes shows the M2 caption instead of a diff), plus "a failed Stop shows the Could not stop toast". AC4 to AC6 need the PromptBar answer path (M3) |
| New session ([screens/new-session.md](screens/new-session.md)) | AC1 to AC9, plus `Alt U` opening the Needs-you drawer above the form |
| Team run ([screens/team-run.md](screens/team-run.md)) | AC1 to AC9, including AC6 (Review opens the drawer on the run's two requests with focus on T4), AC8 (a T5 teammate hook appends to the T5 panel within 1 s and nowhere else) and the D-69 teammate link |
| Crew sheet ([screens/crew-sheet.md](screens/crew-sheet.md)) | AC1 to AC6, plus Undo PATCHing the previous values within 6 s |
| Settings, Appearance; Home compact | text size, motion and density apply at once and the server keeps text size and motion; compact cards show live tails, observed cards their last hook steps; quiet-row Stop opens the dialog and stops the session |

The M1 observe spec still passes with the assertions the M2 UI changed (Home header buttons, palette
groups, quiet-row controls on PTY sessions, Settings Appearance).

## 2. Performance

Measured on 2026-10-02 on the reference machine: AMD Ryzen 7 5700X (8 cores, 16 threads), Linux 7.2,
Node v26.7.0, Chromium 152.0.7977.82 headless. CI pins Node 24.21.0 in `hub/.node-version`; these
runs used the newer local Node and are not a CI measurement. The desktop session was in use.

| Budget | Script | Result | Load average (1 min) |
|---|---|---|---|
| Keystroke echo through Focus, p95 under 50 ms | `focus-echo.mjs` (`npm --prefix hub run perf`) | p95 32.3 ms, p50 25.5 ms, max 33.8 ms over 200 keys 20 ms apart; the frame reached the page at p95 15.7 ms (`wire`), the rest is xterm.js rendering. Within budget | 2.71 before, 2.73 after |
| Hook to UI, p95 under 300 ms for `Stop`, `PermissionRequest` and `Notification` | `hook-latency.mjs` | p95 52.3 ms, p50 43.4 ms, max 60.2 ms (260 `PermissionRequest` envelopes). Within budget | 2.64 before, 2.58 after |
| Home first paint with 20 sessions, under 500 ms | `home-paint.mjs` | median 51.1 ms from snapshot to painted Home (5 runs: 53.9, 49.9, 51.1, 50.1, 52); navigation to paint p50 152.7 ms. Within budget | 2.75 before and after |
| Idle CPU of deckd plus the web server with 10 sessions, under 2% of one core | `idle-cpu.mjs` | 0.18% (deckd 0, server 0.18) over 60 s with the 10 sessions attached in 10 Focus pages. Within budget. With the 10 sessions redrawing a spinner: 4.27% (deckd 2.55, server 1.72), reported, not gated | 2.57 at start, 1.85 at end |

Hook to UI keeps the owner's TEST-O2 decision of 2026-09-30: `PostToolUse` keeps the 250 ms
reorder window and is outside the budget. In the same run its 240 envelopes measured p95 305.6 ms,
almost all of it the hold.

The spinning idle number grew from 1.85% in M1 to 4.27% because every session is now attached in a
Focus page with screen watching on, so deckd streams the redraws; it is reported, not gated.

Commands (the hook and idle scripts walk the process ancestry for a `claude` process, so run them
outside a Claude Code session or detached with `setsid -f`):

    mkdir -p /tmp/hx/perf
    TMPDIR=/tmp/hx/perf npm --prefix hub run perf
    TMPDIR=/tmp/hx/perf node hub/test/perf/home-paint.mjs
    TMPDIR=/tmp/hx/perf setsid -f sh -c 'node hub/test/perf/hook-latency.mjs > /tmp/hx/perf/hook.json'
    TMPDIR=/tmp/hx/perf setsid -f sh -c 'node hub/test/perf/idle-cpu.mjs > /tmp/hx/perf/idle.json'

## 3. Accessibility audit and the fixes after the evidence task

The audit on the React build (09-testing section 11.2, "end of M2") is
`hub/test/e2e/accessibility.spec.mjs`. It runs axe-core 4.13.0 on 31 screens and overlays,
including Focus with a live terminal and its Stop dialog, New session and its conflict state, the
Team run page and plan drawer, Settings Appearance, compact Home and the Crew sheet. It fails on any
serious or critical violation and prints every finding by impact; in this run every screen printed
an empty list. It also checks: Tab reaches the terminal, the leave hint shows, `Alt K` opens the
palette from it and `Alt Esc` leaves it (no keyboard trap, WCAG 2.1.2); the Stop dialog takes focus
on Cancel, keeps Tab inside and returns focus to Stop; with reduced motion nothing animates on the
Crew page, Home or Focus; Settings "Always reduce motion" stops every CSS animation and the terminal
caret blink with the OS preference off.

Findings of the evidence task (Task 15), each fixed by Task 18 or Task 19 and pinned by a test that
was a `todo` before the fix:

| Severity | Finding | Fix and test |
|---|---|---|
| S1 | The plan drawer rendered markdown-it `text`, `code_inline` and `fence` content raw, so U+202E, ESC and BEL reached the DOM (qa 1.7) | Task 18: prose goes through `titleText`, code through `shown`. `security.spec.mjs` "untrusted text (M2): escape, bell and bidi controls in plan markdown never reach the DOM raw", and a `team-run.test.mjs` case |
| S2 | The Crew sheet's scrolling grid was not keyboard reachable (axe `scrollable-region-focusable`, serious) | Task 18: the region is focusable and labelled. `accessibility.spec.mjs` "axe (M2): the Crew sheet" |
| Minor | axe `aria-allowed-role` on the plan drawer's `aside` | Task 18: the drawer is a `section` with `role="dialog"` |
| Low | The Team header pill counted a lead without a task claim ("2 of 5" instead of "2 of 4") | Task 18: only task workers count (TEAM-O7). `control.spec.mjs` "Team AC2: the header pill of the canvas run reads 2 of 4 need you" |
| Low | The terminal caret kept blinking with Settings "Always reduce motion" | Task 18: `TerminalView` also reads `data-motion="reduce"`. `accessibility.spec.mjs` "motion (qa 1.4): the terminal caret does not blink with Settings "Always reduce motion"", with the earlier race in that check fixed |
| Low | On `/new` the Needs-you drawer sat under the New session scrim, so a click on it cancelled the form | Task 18: the drawer stacks above the dialog. `control.spec.mjs` "New session: Alt U opens the Needs-you drawer above the form" |
| Low | Run file changes reached the Team page only on the 60 s poll | Task 19: the server arms the run reader's file watch. `run-watch.test.mjs` (5 tests) |
| Low | The session view did not carry `reviewBaseline`, so Focus Facts hid the row | Task 19: the view carries the baseline commit sha only. A `machines.test.mjs` case |

## 4. Release preparation

Prepared, not tagged or published:

- `hub/package.json` and the lockfile root entries: version 0.2.0. `"private": true` stays (Q1 is
  still the owner's), so the release workflow's package job fails until the owner removes it.
- `hub/CHANGELOG.md`: the 0.2.0 entry with "Tested Claude Code: 2.1.282", "deckd changed: yes" (with
  the [13-operations.md](13-operations.md) section 9.2 note: restart deckd only when no session you
  care about runs) and "Database migration: yes" (`0002-launch`).
- `GET /api/version` reports the package version and `build: 'm2'`; `apiVersion` stays 1.
  `hub/test/unit/m2-release.test.mjs` pins that the package version equals the newest changelog
  heading, the lockfile root entries carry it, and `/api/version` reports it with `build: 'm2'`.
- `hub/README.md`: `fm claude`, `fm attach <id|repo>`, `fm ls`, the `Ctrl ]` then `d` escape, the
  D-67 fallback, launching from the deck, the login-environment rule and the M2 limits.
- Spec corrections: [05-api.md](05-api.md) (deckd proto 2, exit tails, `loginEnvNames`, deckd and
  hooks health reasons, `input.source.detached`, `RepoView`, `reviewBaseline`, `term.error` codes,
  the 64 KiB input frame cap, the POST body allowlist, the empty-task rule, `open_failed`, the Host,
  Origin and body cap rules, the deckd socket control), [06-storage.md](06-storage.md)
  (`sessions.launch_task`, what `review_baseline` holds),
  [screens/needs-you-drawer.md](screens/needs-you-drawer.md) (run and task filters and their copy),
  [screens/crew-sheet.md](screens/crew-sheet.md) (`PATCH`),
  [design/design-system.md](design/design-system.md) 11.13 (markdown-it), NEW-O2, and the
  [09-testing.md](09-testing.md) section 9 perf rows.

Deviations from the plan's wording that the code made and the docs now describe:

- Screen idle expires open requests with reason `interrupted` (`PROMPT_GONE_REASON` in
  `hub/server/machines/projector.mjs`), not `prompt_gone`: the `requests.expired_reason` CHECK in
  `0001-init.sql` allows only `process_ended`, `session_replaced`, `interrupted` and `superseded`.
- `reviewBaseline` in the session view is the baseline commit sha only; the stored
  `review_baseline` JSON also holds file contents, which stay on the server.
- `POST /api/open` answers 502 `open_failed` when the opener cannot be started
  (`runs-crew-open.test.mjs` "a missing opener is 502 open_failed"). The opener is detached and not
  awaited, so its exit status is not checked.
- The first run poll publishes every run once; later passes publish only changed runs.
- A 413 response sets `Connection: close`.

Clean install: not rehearsed again in this task. The M1 rehearsal is in
[m1-exit.md](m1-exit.md) section 3; `hub/test/unit/package-contents.test.mjs` (in the hub suite
above) still packs a staged copy, extracts it and imports `server/main.mjs` and `deckd/main.mjs`.

## 5. The M0 spike, deleted in M2

Task 16 deleted `hub/spike/` (page, `main.js`, `server.mjs`), `hub/test/integration/spike-reattach.test.mjs`
and `hub/test/perf/keystroke-echo.spec.mjs`; `hub/test/unit/spike-removed.test.mjs` keeps them gone.
What carries each dropped case now:

| Dropped case | Carried by |
|---|---|
| keystroke echo through the spike page (`keystroke-echo.spec.mjs`) | `hub/test/perf/focus-echo.mjs`, through Focus |
| a PTY survives the spike server being SIGKILLed and a new server reattaches with a replay | `restart.test.mjs` (above) and `control.spec.mjs` "Exit criterion 2". Both close the first server rather than SIGKILL it |
| output deckd sends before the screen response is not forwarded twice | `terminal-channel.test.mjs` "the attach seam: output that arrived before the screen response is in the snapshot only, later output streams once" |
| after a dropped event a live viewer gets a fresh replay | `terminal-channel.test.mjs` "a dropped event after the first sync sends a fresh snapshot but no second term.attached and no second resize" |
| the spike server refuses any host but 127.0.0.1; listens on 127.0.0.1 only | `security.spec.mjs` "DNS rebinding: ..." and "binding: the deck listens on 127.0.0.1 only and refuses any other address"; `security.test.mjs` "server refuses non-loopback binds and unsafe token files" |
| foreign or missing Origin and foreign Host spawn nothing | `security.spec.mjs` "drive-by page: a foreign origin in Chromium can neither write with a stolen token nor open the WebSocket"; `security.test.mjs` "writes reject missing Origin and preflights" |
| a `/ws` upgrade without the token is refused | `security.spec.mjs` "tokens: every route in the router table answers 401 without the token and with a wrong one, and the WebSocket refuses both" |
| every response forbids framing and inline script | `server.test.mjs` "static assets, history fallback, identity proof and security headers"; `security.spec.mjs` "static files" |
| serves the page and the xterm files and nothing else | `security.spec.mjs` "static files: traversal and encoded variants never serve a file outside the web root" |
| spawn refuses a relative, missing or non-directory cwd | `deckd-m2.test.mjs` "spawn refuses a non-string env value, an env that is not an object, and a bad cwd" |
| `?spawn=1` spawns nothing until Start is clicked | No counterpart: the deck has no spawn-on-load page. A launch is a token-, Host- and Origin-checked `POST /api/sessions` (the security tests above) |

## 6. Findings carried out of the run

Each was checked against the code on 2026-10-02 as noted.

| Severity | Finding | Checked how |
|---|---|---|
| Low | The run reader keeps a watcher on a run directory that is deleted and recreated with the same run id (`hub/server/adapters/fleetmates.mjs:359` skips a key it already watches), so edits to the new directory reach the page only on the 60 s poll | Code read |
| Low | The server starts no run pass at startup (`hub/server/main.mjs:312-313` registers the watch and the 60 s poll only), so a run directory is watched only after something lists runs: the first `GET /api/runs`, a WebSocket snapshot or the first poll | Code read |
| Low | Crew Undo cannot restore a shared slot: the crew `PATCH` always writes `crew_slot_shared=0` (`hub/server/http/api.mjs:229`), so an Undo to a slot another repo holds gets 409 `slot_taken` | Code read |
| Low | Copy keys used by the screens but absent from every copy deck in `docs/deck/`: 144 keys, among them the M2 `team.*`, `focus.*` (list, stop, crash, paste, link, log, changes, facts), `terminal.link.confirm`, the crew language names and many Settings Connections keys. They need a copy-deck pass | A script that reads every `*_COPY` object in `hub/web/src` and looks for each key in backticks in `docs/deck/**/*.md` |
| Low | `deck-hook` stamps `deckHookVersion: '0.1.0'` as a literal (`hub/hook/deck-hook.mjs:75`), and nothing in `hub/server` or `hub/bin` reads it, so the "Hooks are from an older deck release" note of [13-operations.md](13-operations.md) 9.4 is not built | `grep -rn deckHookVersion hub/server hub/bin` finds nothing |
| Low | The release workflow's leak filter still names `spike/` (`.github/workflows/deck-release.yml:116`). Harmless now that the directory is gone; the owner's call | Code read |
| Low | Flaky under load: `hooks.test.mjs` "200 ms budget" and "hook sends one complete line ... without creating spool", `fm.test.mjs` "SIGHUP to fm attach" (failed once in this task, then passed), `observe.spec.mjs` "Home AC15 and Failures AC4", and a Rolldown panic seen once in the package-contents test | Only the `fm.test.mjs` failure was seen in this task; the others are carried from the run's notes, not reproduced |

Known to the owner from dogfooding, recorded and not fixed here:

- The Settings vault row offers "Fix in Settings", which does nothing useful.
- Settings once failed to persist in the owner's browser; it was not reproducible.

## 7. Owner decisions

Decided on 2026-10-01 (the M2 plan header), built in M2:

| Decision | Where |
|---|---|
| The launch task is typed after the idle input box appears, not passed as `claude "<task>"` | Exit criterion 1 |
| An empty task is allowed for plain launches and refused only in `fleetmates` mode | [05-api.md](05-api.md) 2.3 |
| Repo scan depth: the depth 2 walk that ships (NEW-O2 decided) | [15-open-questions.md](15-open-questions.md) |
| Host rules as in 08-security: `127.0.0.1` only, 421 for `localhost`, 256 KiB body cap | [05-api.md](05-api.md) 1 |
| Crew writes use `PATCH` | [screens/crew-sheet.md](screens/crew-sheet.md) |
| Plan markdown: markdown-it with `html: false`, tokens mapped to React elements | design-system 11.13 |
| Open plan: read-only drawer by default, "Open in editor" through `POST /api/open` (TEAM-O5 default) | Team run |
| `RepoView` keeps the nested `crew: { slot, slotShared, seed, hat }` | [05-api.md](05-api.md) 7 |
| The spike is deleted in M2 | Section 5 |
| Run join: lead detection and teammate attribution are built in M2 | Team run |
| deckd peer uid: documentation only; the 0700 directory and 0600 socket are the control | [05-api.md](05-api.md) 5 |
| `fm ls` shows deckd facts only (id, repo, pid, started, attached clients) | `hub/README.md` |
| Login environment: keep profile `CLAUDE_CODE_*` variables, drop Claude Code's per-session ones | `hub/README.md` |
| doctor's deckd line names (never values) the login-environment variables that differ | `hub/README.md` |
| PTY output only updates `lastActivityAt` and ends `stale`; hooks move sessions between idle, done, reviewed and running | Task 4 |
| Hooks-installed signal: a `hooks` health row, read by the New session form | [05-api.md](05-api.md) 7 |
| Accessibility S1 and S2 fix tasks are added after the evidence task | Tasks 18 and 19 (section 3) |

Still open, "M2 before exit" ([12-milestones.md](12-milestones.md) section 9 and
[15-open-questions.md](15-open-questions.md)). The owner confirms or changes each before the
milestone closes. The column gives the default the specs name; this report checked it against the
built UI only for TEAM-O5, TEAM-O7 and design-system 15.6.

| Item | Default |
|---|---|
| NEW-O3: themed "Launch a ship" (design-system 15.1) | Keep the themed label |
| NEW-O5: after launch, Focus or stay | Focus with the terminal focused |
| TEAM-O2: gate banner sentence | "Gate 1 passed at 13:02." plus "failed: {checks}" on FAIL |
| TEAM-O3: run elapsed time | Lead session `startedAt`, else the earliest task `startedAt`, else hidden |
| TEAM-O4: gate "checking" state | Never shown; only recorded verdicts |
| TEAM-O5: "Open plan" | Read-only drawer, plus "Open in editor" |
| TEAM-O6: teammate terminals | Tool steps only, with the "Tool steps only" note |
| TEAM-O7: what the lead works on | "lead" alone unless a task claim names it; the header pill counts the lead only then |
| TEAM-O8: task "Done" is a claim | Keep "Done", with the verified tooltip once a later gate passes |
| FOC-O3: Facts tab content | As proposed in focus.md 4.5 |
| CREW-O4: the Crew sheet under Settings | As in crew-sheet.md |
| API-O2: `repoKey` in API paths | `repoKey` in paths, `?repoId=` accepted everywhere |
| design-system 15.6: xterm `screenReaderMode` | Off by default (`terminalScreenReader: false`), with a Settings toggle |
| Q15: keyboard map (Alt chords vs Claude Code and Hyprland) | The proposed map in [interaction/keyboard.md](interaction/keyboard.md) |

## 8. Owner checks still PENDING, and the two-day log template

| Check | Reference |
|---|---|
| Exit criterion 6: two working days | Template below |
| Manual smoke with real Claude Code 2.1.282, including the `fm claude` row | [09-testing.md](09-testing.md) section 5.4 |
| Orca screen reader smoke on Focus with a live terminal | [09-testing.md](09-testing.md) section 11.2, [qa/qa-checklist.md](qa/qa-checklist.md) 1.9 |
| Keyboard check against Claude Code 2.1.282 and Hyprland | [interaction/keyboard.md](interaction/keyboard.md) section 5 |
| The "M2 before exit" decisions in section 7 | [12-milestones.md](12-milestones.md) section 9 |
| Tag `deck-v0.2.0` and publish | PENDING, after this report and Q1 (`"private": true`) |

Copy to `docs/deck/dogfood/<yyyy-mm-dd>-m2.md` and fill in one block per working day. The criterion
passes with two working days on which every session was started by `fm claude` or from the deck,
Focus was the main control surface, and no keystroke was lost or duplicated. Log every incident.

    # M2 two-day check, <start date> to <end date>

    Build: deck <version or commit>, deckd <version from fleetmates-deck doctor>
    Claude Code: <version> (pinned: 2.1.282)

    ## Day N, <weekday yyyy-mm-dd>

    Sessions: started with fm claude <n>; launched from the deck <n>; plain claude <n, should be 0>
    Max concurrent sessions <n>; repos <list>; team run <yes/no>
    Focus as the main surface: <yes/no, and when you went to the terminal instead>
    Keystroke incidents:
    | Time | Session | Typed in (browser / terminal) | Lost, duplicated or out of order | What showed on screen |
    |---|---|---|---|---|
    Collision chip or "Last typed from" wrong: <none or list>
    Web server or deckd restarts, and whether the sessions came back: <none or list>
    Bugs filed (severity): <none or list>
    Day result: <pass / fail, why>

    ## Summary

    Days passed: <n> of 2
    Verdict: <passed / not passed>

Days 1 and 2: PENDING.
