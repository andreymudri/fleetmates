# 12 · Milestones and delivery plan

Status labels as in [02-domain.md](02-domain.md). **Decided**: the milestone sequence M0 to M6 and its content in outline (D-44, with the order "observe first" chosen explicitly: M1 status and alerts, M2 launch and chat, M3 unblock), public release at M1, the M1 done criterion (3+ parallel sessions for a full work week without opening a pane to check status), capacity of 10+ hours a week, and the Later list. The rule "do not start M4 until M1 passes its one-week test" was proposed during design and not contested; this plan treats it as binding. **Proposed**: scope splits per screen, deliverables, exit criteria wording, task breakdowns, relative sizes, and the per-milestone assignment of Open items (no existing doc had a "Blocks milestone" column; the assignment here is this doc's).

Related: [03-architecture.md](03-architecture.md), [04-integrations.md](04-integrations.md), [09-testing.md](09-testing.md) (exit tests, dogfood week), [13-operations.md](13-operations.md) (release), [screens/README.md](screens/README.md) (screen index with milestones), [15-open-questions.md](15-open-questions.md).

## 1. Overview

| Milestone | Goal in one line | Public | Relative size (Proposed) |
|---|---|---|---|
| M0 spike | Prove deckd + node-pty + xterm.js render and drive the real Claude Code TUI; minimal scribed client | no | S |
| M1 observe | See every session's state at a glance, get told when one needs you | **yes (Decided)** | L |
| M2 control | `fm claude`, Focus with the live terminal, launch sessions from the UI | yes | L |
| M3 unblock | Approve and deny from the deck with tiers and rules; diff view | yes | M |
| M4 meetings | Meetings tab over TurbidAssist `scribed` | yes | M |
| M5 memory ask | Memory tab and palette ask over vault-mcp | yes | L |
| M6 deep research | Research as a fleetmates team, review, save to the vault | yes | M |
| Later | Phone push, remote access with auth, WSL, other agents, custom chat view, mobile, "while you were away" digest | n/a | n/a |

### 1.1 Capacity and estimate

- Capacity: 10+ hours a week (Decided, D-66 in [14-decisions.md](14-decisions.md)).
- The "six milestones in about 3 to 4 months" figure was a guess made by the assistant during design, not a measurement or a commitment. Sizes above are relative only (S, M, L), Proposed.
- Re-plan with real numbers twice: after M0 (hours spent vs the spike scope) and after M1 (the first full milestone including tests and release). Record actual hours per milestone in the milestone's exit notes.

### 1.2 Rules

1. **Order**: M0, M1, M2, M3, then M4, M5, M6 (Decided sequence). Work inside a milestone may run in parallel as fleetmates team runs (section 10).
2. **Public at M1** (Decided). The M1 release checklist is in [13-operations.md](13-operations.md) section 13.5.
3. **Gate: do not start M4 until M1 passes its one-week test** ([09-testing.md](09-testing.md) section 13). Reason given during design: the scope doubled with memory, research and meetings; the core must prove itself first. MS-O2 asks how far the gate reaches (default: all deck work from M4 on, but not separate-repo PRs).
4. **Open items**: each milestone lists the Open items that must be decided before it starts, and the ones whose default can ship but must be confirmed before it exits (section 9).
5. **Exit is testable**: every exit criterion below names an automated test, a measured number or a manual protocol with a pass rule.

## 2. M0 · Spike

**Goal.** Remove the technical risk behind "full control everywhere" (Decided) before building product: the Claude Code TUI must render and accept input cleanly through deckd, node-pty and xterm.js, with two inputs on one PTY under the Decided rule (last keystroke wins, with an indicator).

**Scope in**: deckd skeleton (spawn, attach, write, resize, list, kill, scrollback ring, input source stamping); `@xterm/headless` screen model and the permission prompt parser; `fm claude` minimal attach; a throwaway web page with xterm.js bridged to deckd; the capture script and first hook and screen fixture sets for the pinned Claude Code; the fake `claude` v0; a minimal Node client of the scribed socket (`status`, `subscribe`); latency measurements.

**Scope out**: SQLite, hooks ingest, any product screen, auth beyond a hard-coded loopback bind, packaging.

| Repo | Deliverables |
|---|---|
| fleetmates `hub/` | `deckd/` skeleton; `bin/fm.mjs` (claude, attach); `test/capture/`; `test/fake-claude/`; `test/fixtures/hooks/<v>/`, `screens/<v>/`; `test/fixtures/scribed/` hand-copied from the expectations in TurbidAssist's `tests/realtime/test_protocol.py` and reviewed; `server/adapters/scribed.mjs` (minimal); spike page (deleted at M2) |
| fleetmates root | none |
| vault-mcp | none |
| TurbidAssist | none required. The protocol fixture exporter (T0; TEST-O3, MTG-O3) is optional until M4 |
| docs | `docs/deck/spikes/m0.md` spike report (Proposed) |

**Docs involved**: [03-architecture.md](03-architecture.md) sections 2.1, 2.4, 4.4; [04-integrations.md](04-integrations.md) sections 2.2, 2.3, 4; [interaction/state-machines.md](interaction/state-machines.md) section 3 (shared input); [09-testing.md](09-testing.md) sections 3 and 5.

**Exit criteria**:

1. A real Claude Code session at the pinned version, spawned by deckd, renders in xterm.js in Chromium with no visible difference from kitty for five states: idle input box, spinner, tool output, a Bash permission prompt, an AskUserQuestion box (manual side-by-side check, screenshots in the spike report).
2. Keys typed in the browser and in an `fm claude` terminal both reach the PTY; deckd's `lastInputFrom` matches the last source (integration test with fake `claude` `echo.json`).
3. Keystroke echo p95 measured (budget 50 ms, 03-architecture section 7) and recorded.
4. The first hook fixture set and screen fixture set are committed through `capture-cc.mjs`; the prompt parser output equals the verbatim options printed by the pinned version (contract test).
5. Killing the spike web server leaves the PTY running; a new server process reattaches and shows the same screen (integration test).
6. The scribed client decodes every fixture in `test/fixtures/scribed/` (hand-copied from `test_protocol.py` expectations and reviewed; the T0 exporter is optional until M4) and receives `status` and `transcript` from a real scribed (manual).
7. The spike report answers SM-O1 (pid walk), SM-O6 (screen idle detection), SM-O12 (PTY size), TEST-O2 (hook latency split), OPS-O2 (login environment), with the chosen default for each.

**Dependencies**: none.

## 3. M1 · Observe (public)

**Goal.** "Losing track of parallel sessions" (the top pain, Decided): which session is doing what, blocked sessions go unnoticed, switching is painful. One look tells you what needs you; a popup and a bell tell you when you are away.

**Scope in**: web server with SQLite, hook ingestion (`deck-hook`, `hooks.sock`, spool), session and request machines for observed sessions, counts, token and Origin/Host checks, WebSocket snapshot and replay; `init`, `doctor`, `status`, `open`, `uninstall-hooks`; both systemd units; fleetmates run reader for team cards; notifications (popup, bell, re-notify, notify on done, quiet mode while TurbidAssist records, using the M0 scribed status poll); Home (comfortable grid, quiet row, crowding strip, calm), palette (Needs you and Sessions groups, jump to session, "Mark reviewed"), read-only Focus layout for jump to session (MS-O1 default) with "Mark reviewed", Needs-you drawer read-only, First run, Settings (Notifications, Connections), failure and loading patterns, Rail and shell, crew avatars; `en` i18n catalog, `pt` per Q19 in [15-open-questions.md](15-open-questions.md); CI; release.

**Scope out**: answering from the deck (M3; M1 rows say "Answer in your terminal"), launching, live terminals in the browser (M2), compact density (M2, needs screen tails), Meetings, Memory, Research.

| Repo | Deliverables |
|---|---|
| fleetmates `hub/` | `server/` (db, ingest, machines, http, ws, adapters `fleetmates`, `notify`, `scribed` status poll), `hook/deck-hook.mjs`, `bin/fleetmates-deck.mjs`, `systemd/`, `web/` (shell, Home, palette, drawer, First run, Settings sections, failures), `test/` suites, `README.md`, `CHANGELOG.md`, `.node-version`, `jsconfig.json` |
| fleetmates root | `tests/deck-imports.test.mjs` ([09-testing.md](09-testing.md) section 8); `README.md` deck section; `scripts/cli.mjs` `ui` and `deck` forwarding if kept (03-architecture section 6, Q1 in [15-open-questions.md](15-open-questions.md)); `.github/workflows/deck.yml`, `deck-release.yml` |
| vault-mcp | none |
| TurbidAssist | none |

**Screens**: [home.md](screens/home.md) (comfortable, quiet row, calm, counts), [palette.md](screens/palette.md) (M1 groups), [needs-you-drawer.md](screens/needs-you-drawer.md) (read-only), [first-run.md](screens/first-run.md), [settings.md](screens/settings.md) (Notifications, Connections), [failures-and-loading.md](screens/failures-and-loading.md) (M1 patterns), [rail-and-shell.md](screens/rail-and-shell.md), [crew-sheet.md](screens/crew-sheet.md) (avatars only), plus the read-only Focus subset per MS-O1.

**Docs involved**: [02-domain.md](02-domain.md); [03-architecture.md](03-architecture.md) sections 2.2, 2.3, 4.2, 4.4, 5, 6, 7; [04-integrations.md](04-integrations.md) sections 1, 2.1, 2.2, 5; [interaction/state-machines.md](interaction/state-machines.md) sections 1, 2 (observe part), 4, 5, 9, 10; [interaction/keyboard.md](interaction/keyboard.md); [design/](design/design-system.md); [08-security.md](08-security.md); [09-testing.md](09-testing.md); [13-operations.md](13-operations.md).

**Exit criteria**:

1. **Dogfood week passed** (Decided criterion; protocol in [09-testing.md](09-testing.md) section 13): 3+ parallel sessions for 5 consecutive working days without opening a pane to check status, report committed.
2. Every acceptance criterion in the M1 parts of the screen specs above passes in `hub-ui`; the counts property test (qa-checklist 1.8) passes.
3. Security suite green ([09-testing.md](09-testing.md) section 11.1).
4. Hook fixture contract tests green for every committed Claude Code version; `init` idempotency and `uninstall-hooks` tests green on all settings fixtures.
5. Budgets met: hook to UI (or TEST-O2 resolved with a new number), Home first paint with 20 sessions, idle CPU.
6. Published: `deck-v0.1.0` tagged, package on npm with provenance, README with screenshots, clean-install check passed ([13-operations.md](13-operations.md) section 13.5).

**Dependencies**: M0 (fixtures, parser, fake `claude`, scribed client).

## 4. M2 · Control

**Goal.** Full control of every session from the browser (Decided: "Full control everywhere" through the `fm claude` wrapper): switching is one click, and the real Claude Code terminal is mirrored in the browser ("chat in the UI" means the mirrored terminal, Decided).

**Scope in**: `fm claude`, `fm attach`, `fm ls` complete (detach, reattach, fallback to plain `claude`); deckd exit records, resize policy, `hello` versioning, login environment (OPS-O2); launch from the UI (repo picker from `~/dev`, task, first prompt typed on the idle box; same-repo warning); Focus (session list, live terminal, header, input indicator, Stop, Nudge, Relaunch, Changes list and Facts tab without diff); Home compact density; Team run page read-only; Crew sheet page with Customize; Settings Appearance; accessibility audit on the React build.

**Scope out**: answering from PromptBar or drawer (M3), diff view (M3), Memory tab in Focus (M5).

| Repo | Deliverables |
|---|---|
| fleetmates `hub/` | `deckd/` complete; `bin/fm.mjs` complete; `server/` launch flow, repo scan, PTY bridge; `web/` Focus, New session, compact Home, Team run, Crew sheet, Settings Appearance |
| fleetmates root | none expected |
| vault-mcp, TurbidAssist | none |

**Screens**: [focus.md](screens/focus.md), [new-session.md](screens/new-session.md), [home.md](screens/home.md) (compact, "Launch a ship"), [team-run.md](screens/team-run.md) (read-only), [crew-sheet.md](screens/crew-sheet.md), [settings.md](screens/settings.md) (Appearance), [palette.md](screens/palette.md) (Actions).

**Docs involved**: [03-architecture.md](03-architecture.md) sections 2.1, 2.4, 4.1, 4.4; [04-integrations.md](04-integrations.md) sections 1.3, 2.3, 6; [interaction/state-machines.md](interaction/state-machines.md) sections 1 (PTY rows), 3, 4.2; [interaction/keyboard.md](interaction/keyboard.md) section 5.

**Exit criteria**:

1. Launch from the UI: the session reaches `running` and the task is typed only after the idle box appears (integration test with fake `claude` `slow-start.json` and `idle.json`).
2. Web server restart with 3 live PTYs: all 3 stay alive and controllable after the browser reconnects (integration test).
3. Shared input: "Last typed from" is correct for terminal and browser, and the collision chip appears within the collision window (integration test).
4. Focus, New session, Team run and Crew sheet acceptance criteria green.
5. Accessibility audit done on the React build; S1 and S2 findings fixed ([09-testing.md](09-testing.md) section 11.2).
6. Manual: two working days with every session started by `fm claude` or the UI and Focus as the main control surface, no keystroke lost or duplicated (log any incident).

**Dependencies**: M1.

## 5. M3 · Unblock

**Goal.** Answer what blocks a session without leaving the deck, safely: tiers decide what can be batched, approved from a popup or turned into a rule (Decided tier rules).

**Scope in**: tier classifier and `tiers.json`; request answering by keystrokes into the PTY with verification and the typing guard; PromptBar in Focus, inline answers on Home cards, drawer answering (Allow, Deny, Reply, Safe batch, Destructive confirm checkbox), palette answering; rule suggestion after N Safe approvals, rule write and revoke in `.claude/settings.local.json`; Changes tab diff; Settings Approval rules; Team "Review N requests".

**Scope out**: approving observed sessions (they stay "Answer in your terminal"; the `PermissionRequest` hook answer path was rejected for v1, 03-architecture 4.3).

| Repo | Deliverables |
|---|---|
| fleetmates `hub/` | `server/approvals/`, delivery and verification, rules writer; `web/` PromptBar, drawer actions, card answers, Settings rules, diff |
| others | none |

**Screens**: [needs-you-drawer.md](screens/needs-you-drawer.md) (answering), [focus.md](screens/focus.md) (PromptBar, Changes diff), [home.md](screens/home.md) (inline answers), [palette.md](screens/palette.md) (answering), [settings.md](screens/settings.md) (Approval rules), [team-run.md](screens/team-run.md) (Review N).

**Docs involved**: [07-approvals.md](07-approvals.md); [03-architecture.md](03-architecture.md) section 4.3; [04-integrations.md](04-integrations.md) sections 2.4, 5; [interaction/state-machines.md](interaction/state-machines.md) section 2.

**Exit criteria**:

1. API and UI tests: a Destructive request is never answered without the confirm checkbox, never in a batch, never from a popup or a keyboard shortcut.
2. Delivery: with fake `claude`, answers `1`, `2`, `3` land; `did-not-land.json` shows "did not land" after the verify timeout; `answered-in-terminal.json` refuses the browser answer.
3. Rules: suggestion after the configured count; write and revoke preserve every other key and the order in `settings.local.json` fixtures; external edits show as "added by hand".
4. Manual: real Claude Code smoke answering all three options from the browser on the pinned version ([09-testing.md](09-testing.md) section 5.4).
5. Manual: one working week answering permission prompts from the deck with zero answers delivered to a prompt other than the one shown.
6. The design-oversight review of the tiers (Q4, APR-O1) is done and its findings are resolved before this milestone starts (section 9).

**Dependencies**: M2 (PTY bridge, PromptBar host, screen model in production).

## 6. M4 · Meetings

**Goal.** Meetings in v1 (Decided): list past meetings with summaries, start and stop recording, live transcript and ask, through TurbidAssist's `scribed` socket.

**Gate**: starts only after M1 passed its one-week test (section 1.2 rule 3).

**Scope in**: full scribed client (per-request connections, long-lived `subscribe`, 2 s status poll); meeting machine and post-states from `session.json` and vault notes; Record with a tag from `config.yaml`; rec bar on every screen; pins stored by the deck; confidential tag handling (no transcript text persisted); live ask per MEET-O4; "Start scribed" per OPS-O1; scribed degraded card; quiet mode wired to the full meeting machine.

**Scope out**: in-deck speaker naming (SM-O14 default: hint only), live decisions and action items (not produced live, MEET-O9).

| Repo | Deliverables |
|---|---|
| fleetmates `hub/` | `server/adapters/scribed.mjs` complete, meeting machine, history reader, pins; `web/` Meetings list, detail, search, live, rec bar |
| TurbidAssist | Fixture exporter current with the protocol; optional, only if decided: a `scribed` user unit (SM-O13), a `pin` command (MEET-O2), vault access in `ask` (MEET-O4) |
| vault-mcp | none |

**Screens**: [meetings.md](screens/meetings.md), [rail-and-shell.md](screens/rail-and-shell.md) (rec bar, rec dot), [failures-and-loading.md](screens/failures-and-loading.md) (scribed degraded), [home.md](screens/home.md) (Calm "last meeting").

**Docs involved**: [11-meetings.md](11-meetings.md); [04-integrations.md](04-integrations.md) section 4; [interaction/state-machines.md](interaction/state-machines.md) sections 6, 9.5; [reference/vault-turbid-contract.md](reference/vault-turbid-contract.md) part 2; [08-security.md](08-security.md).

**Exit criteria**:

1. scribed contract tests green against fixtures exported from the current TurbidAssist commit.
2. With fake scribed: start, recording, a `stop` taking 30 s, post-states through `synthesized`; socket loss mid-recording; scribed down keeps past meetings listed.
3. Confidential tag: zero sentinel transcript strings in the database, WAL, logs and spool (automated).
4. Quiet mode: during a recording, requests produce popups and no bell (integration test with the notify and `pw-play` shims).
5. Manual: three real meetings recorded end to end from the deck, at least one with a confidential tag; a web server restart during a recording does not stop it (OPS-O1).

**Dependencies**: M1 passed its week (gate); M1 shell. Technically independent of M2 and M3.

## 7. M5 · Memory ask

**Goal.** Ask the Obsidian vault and see it as a second brain with its connections (Decided), through vault-mcp only (Decided), with answers citing `path:line` and every miss logged (Decided: measure first, no embeddings).

**Scope in**: long-lived vault-mcp client and health; Ask engine (`claude -p` with vault-mcp as its only tool, Decided) with threads, citations, general-knowledge block, misses; Memory tab (Graph with clusters and local graph, Browse by MOC, Captures, Misses, note panel); palette `?` ask and Memory group; Focus Memory tab; golden query export process.

**Scope out**: embeddings or hybrid search (only if misses pile up, decided later); writing the vault (M6).

| Repo | Deliverables |
|---|---|
| vault-mcp | `vault_graph` tool and `structuredContent` for `vault_get_note` and `vault_list` ([reference/vault-turbid-contract.md](reference/vault-turbid-contract.md) 1.11), with tests; release 0.4 on npm |
| fleetmates `hub/` | `server/adapters/vault-mcp.mjs`, `server/ask/`, misses; `web/` Memory screens, palette ask, Focus Memory tab; golden query export command |
| TurbidAssist | none |

**Screens**: [memory.md](screens/memory.md), [palette.md](screens/palette.md) (Memory group, `?`), [focus.md](screens/focus.md) (Memory tab), [failures-and-loading.md](screens/failures-and-loading.md) (vault-mcp degraded), [home.md](screens/home.md) (Calm "charts added", "unanswered questions").

**Docs involved**: [10-memory-and-research.md](10-memory-and-research.md); [04-integrations.md](04-integrations.md) sections 2.5, 3; [interaction/state-machines.md](interaction/state-machines.md) section 8; [09-testing.md](09-testing.md) section 7.

**Exit criteria**:

1. vault-mcp 0.4 published with `vault_graph`; the deck's tool schema snapshot test pins it.
2. Memory acceptance criteria green with fixture `vault22`; Ask tests with fake `claude -p`: cited answer, miss logged with "Research this", general knowledge kept separate, argv check refuses any write tool.
3. Graph budget met: under 500 ms at 1,000 notes.
4. Golden queries: two weeks of real misses exported, reviewed, and the qualifying ones added to vault-mcp's suite.
5. Manual: 20 real questions about the owner's vault; each answer cites `path:line` or is logged as a miss.

**Dependencies**: M1 shell; vault-mcp 0.4. Gate from section 1.2.

## 8. M6 · Deep research

**Goal.** Research a topic with a fleetmates team, review the draft with its sources, and save it to the vault only after approval (Decided: draft, review, then save; Sources section, frontmatter, links to existing notes; existing topics get a new linked note).

**Scope in**: research form (palette `> research` and Memory button, same form, Decided) with presets Quick, Standard, Deep (Decided presets; sizes RES-O4); research run launched as a fleetmates team and shown as a session on the grid (Decided); research card on Home; review screen (sources with Why and Backs, rejected sources, orphan citation highlighting); save through `vault_learn` after a `preview: true` call (Decided: no write without preview).

**Scope out**: cost caps (Decided: subscription, no cap).

| Repo | Deliverables |
|---|---|
| vault-mcp | `vault_learn` `preview` ([reference/vault-turbid-contract.md](reference/vault-turbid-contract.md) 1.10) with tests; release |
| fleetmates root | The research run output contract (SM-O15): a research plan template or skill that makes the lead write draft, sources and rejected sources to agreed files under `.fleetmates/<runId>/` |
| fleetmates `hub/` | `server/research/` orchestration and output reader; `web/` research form, review, Home research card, palette `> research` |
| TurbidAssist | none |

**Screens**: [research.md](screens/research.md), [home.md](screens/home.md) (research card), [palette.md](screens/palette.md) (`> research`), [memory.md](screens/memory.md) ("Research this").

**Docs involved**: [10-memory-and-research.md](10-memory-and-research.md); [04-integrations.md](04-integrations.md) sections 1.3, 3.3, 3.4; [interaction/state-machines.md](interaction/state-machines.md) section 7.

**Exit criteria**:

1. vault-mcp `preview` released; its "dry run writes no byte" test green.
2. Integration test on a fixture vault in a git repo: form, run (fake team output files), review, save; the saved files and commit equal the preview's file list.
3. Save is impossible without a current preview (UI disabled with reason and API refusal, tested).
4. Manual: three real research runs, one per preset; each saved note has frontmatter, `[[links]]` to existing notes and a Sources section.

**Dependencies**: M5 (vault-mcp client, Memory entry points), M2 (launching sessions), vault-mcp `preview`, SM-O15 contract.

## 9. Open items per milestone

Collected from every doc (IDs with `-O` numbers, plus design-system section 15 and keyboard.md section 5, which have no IDs, and owner questions in [15-open-questions.md](15-open-questions.md) section 1 without a detailed ID). "Before start" means no safe default exists or changing the default later is expensive. "Before exit" means the listed default is safe to build and ship, but the owner confirms or changes it before the milestone closes. The assignment is Proposed.

### M0

| When | Items |
|---|---|
| Before start | none |
| Answered by the spike | SM-O1 (pid walk for observed sessions), SM-O6 (screen idle detection), SM-O12 / FOC-O2 (PTY size), TEST-O2 (hook to UI budget vs reorder window), OPS-O2 (login environment for children) |

### M1

| When | Items |
|---|---|
| Before start | MS-O1 (what "jump to session" opens before Focus exists); results of the M0 items above |
| Before exit | Package and command names (03-architecture section 3, [15-open-questions.md](15-open-questions.md) Q1); Q19 (`pt` UI catalog at M1 or later); OPS-O3 (tags and versioning); OPS-O4 (README language); TEST-O6 (scrub client names before going public); TEST-O4 (dogfood logging); SM-O2 (`agent_needs_input`); SM-O3 (question heuristic, decided from dogfood data); SM-O4 / FAIL-O3 (popups for stale and crash); SM-O7 (repo change mid-session); SM-O8 (resume reopens); SM-O17 (re-notify once or repeatedly); SM-O18 / FR-O1 (incompatible Claude Code blocks or warns); SM-O13 / FAIL-O1 / FR-O2 / OPS-O1 ("Start scribed" in First run); HOME-O1 (calm with a stale session); HOME-O2 / TEAM-O1 (phase names); HOME-O3 (calm open loops); HOME-O5 (team card title); FR-O4, HOME-O9 and design-system 15.1 (themed buttons); FAIL-O2 and design-system 15.4 (banner wording); SET-O1 (language row); SET-O2 (prefs storage); SHELL-O2 and design-system 15.3 (below 1280 and zoom); CREW-O1 to CREW-O3 and design-system 15.2 (crew slots and shades); design-system 15.5 (stale amber) |

### M2

| When | Items |
|---|---|
| Before start | Decided on 2026-10-01: Q18 (D-67, unwrapped sessions read-only and the `fm claude` fallback when deckd is down); SM-O5 / NEW-O1 (D-68, second plain session in the same repo, "Run as a fleetmates job"); FOC-O1 (D-69, Focus for a teammate). OPS-O2 was answered by the M0 spike |
| Before exit | NEW-O2 (scan depth); NEW-O3 (themed "Launch a ship"); TEAM-O2 to TEAM-O6 (gate sentence, elapsed time, gate checking, Open plan, teammate terminals); design-system 15.6 (xterm screen reader mode default); keyboard.md section 5 (Alt chords vs Claude Code and Hyprland) |

### M3

| When | Items |
|---|---|
| Before start | Design-oversight review of the tiers (Q4, APR-O1, not yet run); SM-O9 / DRW-O4 (Caution from a popup); DRW-O1 (Destructive confirm label); SM-O10 (terminal approvals count toward rules); SM-O11 (Safe request with no tiers.json pattern) |
| Before exit | SET-O4 (threshold options 5 / 3 / Never, re-offer after dismissal) |

### M4

| When | Items |
|---|---|
| Before start | Gate: M1 week passed; MS-O2 (gate scope); MEET-O4 (live ask engine and vault access); MEET-O11 (TurbidAssist config location); SM-O13 / MEET-O10 / OPS-O1 (how scribed is started); TEST-O3 (fixture exporter location) |
| Before exit | MEET-O1 (source label); MEET-O2 (pins); MEET-O3 (live title); MEET-O5 (partial lines); MEET-O6 / HOME-O8 ("Launch as session" from action items, Q6); MEET-O7 (confidential search); MEET-O8 (save answer to note); SM-O14 (speaker naming) |

### M5

| When | Items |
|---|---|
| Before start | MEM-O8 (Memory UI to be revisited with the owner: "we will talk more on the ui subject later", Q5); MEM-O1 (`vault_graph` API shape, Q8); MEM-O2 (misses log storage, Q8); SM-O16 / MEM-O7 (Ask output contract) |
| Before exit | MEM-O3 (captures and new notes); MEM-O4 (revert captures); MEM-O5 (Obsidian vault name); PAL-O1 (link counts) |

### M6

| When | Items |
|---|---|
| Before start | SM-O15 / RES-O1 / HOME-O4 (research run output contract); RES-O6 (which repo a research run lives in); RES-O3 (`preview` shipped in vault-mcp); RES-O2 (draft frontmatter vs what `vault_learn` writes); RES-O5 (new linked note vs append) |
| Before exit | RES-O4 (preset sizes); RES-O7 (themed "Send scouts") |

### Not tied to a milestone

TEST-O1 (credentialed canary), TEST-O5 (Firefox in CI), OPS-O5 (holding Claude Code back), OPS-O6 (rules on uninstall), MS-O3 (rate-limit display).

## 10. Suggested task breakdown (Proposed)

Sized for fleetmates team runs: each task owns a disjoint file set so teammates work in parallel worktrees, and "Depends" gives the phase order. To run one, copy the table into a `docs/plans/YYYY-MM-DD-deck-mN.md` plan in the fleetmates plan format (a `### Task N: <title>` heading, a `**Files:**` list of Create, Modify or Test lines with the path in backticks, and a `**Depends:** T1, T2` line; [reference/fleetmates-contract.md](reference/fleetmates-contract.md) docs conventions). File names follow 03-architecture section 3 and are Proposed. Tests ship in the same task as the code they test.

### 10.1 M0

| Task | Owns | Depends |
|---|---|---|
| T1 deckd skeleton: Unix socket protocol, spawn, attach, write with source stamp, resize, list, kill, scrollback ring | `hub/deckd/main.mjs`, `hub/deckd/pty-host.mjs`, `hub/deckd/protocol.mjs`, `hub/test/integration/deckd.test.mjs` | none |
| T2 Capture script and fake `claude` v0 | `hub/test/capture/*`, `hub/test/fake-claude/*`, `hub/test/fixtures/hooks/<v>/*`, `hub/test/fixtures/screens/<v>/*`, `hub/test/fixtures/scripts/*` | none |
| T3 Screen model and prompt parser | `hub/deckd/screen/*`, `hub/test/contract/screens.test.mjs` | T2 |
| T4 `fm claude` and `fm attach` minimal | `hub/bin/fm.mjs`, `hub/deckd/client.mjs`, `hub/test/integration/fm.test.mjs` | T1 |
| T5 Spike web page: xterm.js bridged to deckd over WebSocket | `hub/spike/*` (deleted at M2) | T1 |
| T6 scribed client minimal and fixtures | `hub/server/adapters/scribed.mjs`, `hub/test/contract/scribed.test.mjs`, `hub/test/fixtures/scribed/*`; TurbidAssist `scripts/export_protocol_fixtures.py` | none |
| T7 Measurements and spike report | `hub/test/perf/keystroke-echo.spec.mjs`, `docs/deck/spikes/m0.md` | T3, T4, T5 |

### 10.2 M1

| Task | Owns | Depends |
|---|---|---|
| T1 Package and CI scaffolding | `hub/package.json`, `hub/jsconfig.json`, `hub/.node-version`, lint configs, `hub/test/helpers/*`, `.github/workflows/deck.yml` | none |
| T2 SQLite schema, migrations, retention | `hub/server/db/*`, `hub/server/db/migrations/0001-init.sql`, `hub/test/unit/db/*` | T1 |
| T3 Hook script, ingest socket, spool, reorder buffer | `hub/hook/deck-hook.mjs`, `hub/server/ingest/*`, `hub/test/unit/ingest/*`, `hub/test/contract/hooks.test.mjs` | T1 |
| T4 Session and request machines (observe), counts | `hub/server/machines/session.mjs`, `hub/server/machines/request.mjs`, `hub/server/machines/counts.mjs`, `hub/test/unit/machines/*` | T2, T3 |
| T5 HTTP and WebSocket: token, Origin and Host checks, snapshot, replay | `hub/server/http/*`, `hub/server/ws/*`, `hub/server/main.mjs`, `hub/test/integration/security.test.mjs` | T2 |
| T6 fleetmates run adapter and root import check | `hub/server/adapters/fleetmates.mjs`, `hub/test/unit/adapters/fleetmates.test.mjs`, `tests/deck-imports.test.mjs` | T1 |
| T7 Notifications: popup, bell, re-notify, done, quiet mode | `hub/server/adapters/notify.mjs`, `hub/server/machines/notification.mjs`, `hub/test/unit/notify/*` | T4 |
| T8 CLI and setup: init, doctor, status, open, uninstall-hooks, unit templates | `hub/bin/fleetmates-deck.mjs`, `hub/server/setup/*`, `hub/systemd/*`, `hub/test/unit/setup/*`, `hub/test/fixtures/settings/*` | T1 |
| T9 Web shell: Rail, routing, store, i18n catalogs, toasts, banners | `hub/web/src/shell/*`, `hub/web/src/state/*`, `hub/web/src/i18n/*`, `hub/web/src/styles/*` | T5 |
| T10 Shared components and crew avatars | `hub/web/src/components/*` | T9 |
| T11 Home, palette (M1), drawer read-only, read-only Focus subset (MS-O1) | `hub/web/src/screens/home/*`, `.../palette/*`, `.../drawer/*`, `.../focus/*` | T10 |
| T12 First run, Settings (Notifications, Connections), failure patterns | `hub/web/src/screens/first-run/*`, `.../settings/*`, `.../failures/*` | T10 |
| T13 Fixture server and Playwright suites (acceptance, axe, XSS, counts property, visual) | `hub/test/e2e/*`, `hub/test/fixtures/ui/*`, `hub/test/visual/*` | T11, T12 |
| T14 Release: README, changelog, release workflow, root README section, plugin forwarding | `hub/README.md`, `hub/CHANGELOG.md`, `.github/workflows/deck-release.yml`, `README.md`, `scripts/cli.mjs` | T8, T13 |

### 10.3 M2

| Task | Owns | Depends |
|---|---|---|
| T1 deckd complete: exit records, `hello` versioning, resize policy, login environment | `hub/deckd/*` | none |
| T2 `fm` complete: detach, reattach, `ls`, fallback | `hub/bin/fm.mjs`, `hub/test/integration/fm.test.mjs` | T1 |
| T3 Launch flow: `POST /api/sessions`, repo scan, same-repo warning, first prompt on idle | `hub/server/launch/*`, `hub/server/adapters/repos.mjs` | T1 |
| T4 PTY bridge to the browser and restart reconciliation | `hub/server/pty-bridge/*`, `hub/test/integration/restart.test.mjs` | T1 |
| T5 Focus screen | `hub/web/src/screens/focus/*` | T4 |
| T6 New session form and compact Home | `hub/web/src/screens/new-session/*`, `hub/web/src/screens/home/compact/*` | T3, T4 |
| T7 Team run page, Crew sheet, Settings Appearance | `hub/web/src/screens/team-run/*`, `.../crew-sheet/*`, `.../settings/appearance/*` | none |
| T8 Accessibility audit fixes and M2 e2e suites | `hub/test/e2e/m2/*` | T5, T6, T7 |

### 10.4 M3

| Task | Owns | Depends |
|---|---|---|
| T1 Tier classifier and `tiers.json` defaults | `hub/server/approvals/tiers.mjs`, `hub/server/approvals/default-tiers.json` | none |
| T2 Answer delivery: keystroke, verify, typing guard | `hub/server/approvals/deliver.mjs`, `hub/test/integration/deliver.test.mjs` | none |
| T3 Rules: suggest, write, revoke, mirror | `hub/server/approvals/rules.mjs`, `hub/test/unit/rules/*` | T1 |
| T4 Drawer answering, Safe batch, Destructive confirm | `hub/web/src/screens/drawer/*` | T2 |
| T5 PromptBar, inline card answers, palette answering | `hub/web/src/components/prompt-bar/*`, `hub/web/src/screens/home/answers/*`, `hub/web/src/screens/palette/answer/*` | T2 |
| T6 Changes diff tab | `hub/server/adapters/git-diff.mjs`, `hub/web/src/screens/focus/changes/*` | none |
| T7 Settings Approval rules | `hub/web/src/screens/settings/rules/*` | T3 |

### 10.5 M4

| Task | Owns | Depends |
|---|---|---|
| T1 scribed client complete and fake scribed | `hub/server/adapters/scribed.mjs`, `hub/test/fakes/fake-scribed.mjs`, `hub/test/contract/scribed.test.mjs` | none |
| T2 Meeting machine, history reader, pins, confidential rules | `hub/server/meetings/*` | T1 |
| T3 Starting scribed (OPS-O1) | `hub/server/meetings/start-scribed.mjs` | T1 |
| T4 Meetings list, detail, search | `hub/web/src/screens/meetings/*` | T2 |
| T5 Meeting live, rec bar, quiet mode wiring | `hub/web/src/screens/meeting-live/*`, `hub/web/src/shell/rec-bar/*` | T2 |
| T6 "Launch as session" from action items (only if MEET-O6 says v1) | `hub/web/src/screens/meetings/actions/*` | T4 |

### 10.6 M5

| Task | Owns | Depends |
|---|---|---|
| V1 (vault-mcp repo) `vault_graph` and `structuredContent`, release 0.4 | vault-mcp `src/server/tools.ts`, `src/graph/*`, tests | none |
| T1 vault-mcp client, parsers, health | `hub/server/adapters/vault-mcp.mjs`, `hub/test/contract/vault-mcp.test.mjs` | V1 |
| T2 Ask engine and misses | `hub/server/ask/*`, `hub/test/fixtures/claude-p/*` | none |
| T3 Memory graph view | `hub/web/src/screens/memory/graph/*` | T1 |
| T4 Browse by MOC, note panel, Captures, Misses | `hub/web/src/screens/memory/browse/*`, `.../note/*`, `.../captures/*`, `.../misses/*` | T1 |
| T5 Ask thread UI, palette `?`, Focus Memory tab | `hub/web/src/screens/memory/ask/*`, `hub/web/src/screens/palette/ask/*`, `hub/web/src/screens/focus/memory/*` | T2 |
| T6 Golden query export command | `hub/bin/fleetmates-deck.mjs` (export subcommand), `hub/server/ask/export-misses.mjs` | T2 |

### 10.7 M6

| Task | Owns | Depends |
|---|---|---|
| V1 (vault-mcp repo) `vault_learn` `preview`, release | vault-mcp `src/write/learn.ts`, `src/server/tools.ts`, `test/learn.test.ts` | none |
| F1 (fleetmates root) research plan template or skill writing the output contract (SM-O15) | `skills/<research skill>/SKILL.md` or `templates/*` (per the SM-O15 decision) | none |
| T1 Research orchestration: launch the team run as a session, read the output files | `hub/server/research/*` | F1 |
| T2 Research form and palette `> research` | `hub/web/src/screens/research/form/*`, `hub/web/src/screens/palette/research/*` | none |
| T3 Review screen: sources, rejected, orphan highlight, preview diff | `hub/web/src/screens/research/review/*` | T1, V1 |
| T4 Save path: preview freshness, save, saved notices | `hub/server/research/save.mjs` | V1, T1 |
| T5 Home research card | `hub/web/src/screens/home/research-card/*` | T1 |

## 11. Later (Decided list; not scheduled)

- Phone push (ntfy, Telegram, Discord bot).
- Remote access with authentication (v1 is localhost only).
- WSL and Windows (dropped from v1 because the vault lives on Omarchy).
- Other agents through adapters (Claude first, adapters later).
- Custom chat view (v1 mirrors the real terminal).
- Mobile.
- "While you were away" digest (partly covered by Calm Home and the Captain's log).
- Hybrid search in vault-mcp, only if the search-miss log shows misses piling up (Decided: measure first); SQLite FTS5 index at about 5,000 notes or 50 MB (vault-mcp's own trigger).

## Open items

| ID | Question | Default until decided | Blocks milestone |
|---|---|---|---|
| MS-O1 | M1 includes "jump to session" (palette, `Alt 1..9`) but Focus is M2. What does a jump open in M1? | The read-only Focus layout already specified for observed sessions in [screens/focus.md](screens/focus.md) (header, activity log, requests with "Answer in your terminal", no terminal), pulled forward into M1. | M1 |
| MS-O2 | How far does "do not start M4 until M1 passes its one-week test" reach: only M4, or every milestone after M3; and does it hold PRs in vault-mcp and TurbidAssist (`vault_graph`, `preview`, fixture exporter)? | Holds all deck work from M4 on; separate-repo PRs may proceed at any time. | M4 |
| MS-O3 | "Show rate-limit state instead of dollars" (D-09, Q16) has no screen and no milestone. | Later; not in any v1 milestone. | none |
