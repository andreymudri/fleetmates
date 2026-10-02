# First run (setup checklist)

| | |
|---|---|
| Canvas board | `FirstRun` (First run · setup checklist) |
| Route | `/welcome` |
| Milestone | M1 |
| Status | Decided (six checks, hooks are the only blocker, disabled "Set sail (needs hooks)", re-run from Settings, Connections), Proposed (states and copy for failures) |

## 1. Purpose

Answers **"Is this install able to see my sessions, and what is still missing?"** Six checks; only the observation hooks block, because without them the deck is blind to sessions started in a terminal (Decided).

## 2. Route and entry points

| Entry | Result |
|---|---|
| First open of the deck (`firstRunCompletedAt` unset) | any route redirects to `/welcome` (Proposed) |
| Settings, Connections "Run the setup checklist again" | same checks inline in Settings (no gate, "Done" instead of "Set sail") |
| Direct `/welcome` after completion | allowed; shows the checklist with "Done" |

No Rail on this page (full-bleed, components AppShell).

## 3. Layout

Centred column, width `--layout-readable` (820), gap `--space-24` to `--space-28`, vertically centred. Hero row: three CrewAvatar `lg` (fleetmates needs, rustot running, vault-mcp done, or the first three repos the scan finds) + h1 + subtitle. Six ChecklistRow. Footer: note left, "Check again" and "Set sail" right.

| Width | Behaviour |
|---|---|
| 1920, 1440, 1280 | identical column; at heights under 800 the page scrolls and the footer stays in flow (not sticky) |

## 4. Content inventory

| # | Check | Component | Probe (state-machines 10.2) | ok copy | failed copy | Action | Blocking |
|---|---|---|---|---|---|---|---|
| 1 | Claude Code compatible | ChecklistRow | `claude --version` vs pinned fixtures | "Claude Code {version} compatible" / "Matches the pinned hook payload fixtures for this deck release" | warn: "Claude Code {version} is newer than this deck was tested with" / "Hooks may differ; sessions can show wrong states." | none ("Check again") | no (SM-O18) |
| 2 | Observation hooks | ChecklistRow | deck hook command present for every event in state-machines 1.3, async | "Observation hooks installed" / "Every Claude Code session on this machine reports to the deck." | "Observation hooks not installed" / "Needed to see sessions you start in a terminal. Adds hooks to ~/.claude/settings.json next to fleetmates." | "Install hooks" (`primary md`) | **yes** |
| 3 | deckd running | ChecklistRow | `systemctl --user is-active` + socket ping | "deckd running" / "systemd --user · pid 48213 · up 2 min" | "deckd is not running" / "Sessions can be watched but not launched or answered." | "Start deckd" | no |
| 4 | vault-mcp reachable | ChecklistRow | spawn + MCP `ping` (note count from one `vault_list` call) | "vault-mcp reachable" / "VAULT_PATH=/home/you/vault · 76 notes indexed" | "vault-mcp did not start" / the spawn error text, mono | "Fix in Settings" | no |
| 5 | scribed socket (optional) | ChecklistRow `optional` | socket `status` | "scribed reachable" | warn: "scribed socket not found (optional)" / "Meetings will work once TurbidAssist is running." | "Start scribed" (`secondary`) (FAIL-O1) | no |
| 6 | Notifications | ChecklistRow | todo until "Send test ping"; then `notify-send` exit code | "Test popup sent through mako" | "notify-send failed: {stderr}" | "Send test ping" (`secondary`) | no |

| Element | Component | Data binding | Copy |
|---|---|---|---|
| Hero crew | CrewAvatar `lg` x 3, `aria-hidden` | first three repos seen, poses needs, running, done | |
| Title | h1 `type.welcome` | | "Welcome aboard the deck" |
| Subtitle | text | | "Six checks before the first voyage. Optional ones can wait." |
| Footer note | text muted | | "Re-run anytime from Settings, Connections" |
| Check again | Button `secondary xl` | | "Check again" |
| Set sail | Button `primary xl` | gate: hooks `ok` | enabled "Set sail"; disabled "Set sail (needs hooks)" (reason in the label, Decided) |

Item 1 subtitle on the canvas contained a literal "[version]" placeholder; the port fills the real version.

## 5. States

| State | What shows |
|---|---|
| Opening | all automatic checks run in parallel with ChecklistRow `checking` (spinner glyph + sr "Checking"); each has a 10s timeout |
| Check `ok` | green check circle, ok copy |
| Check `failed` (blocking or not) | red x circle, failed copy, fix action |
| Optional failed | amber "!" circle (canvas warn), "(optional)" suffix |
| Notifications `pending` | "?" circle (canvas todo) |
| Timeout | failed copy "{check} did not answer in 10 s." |
| Fix running | the action button `loading`; the row goes `checking` after the fix |
| Fix failed | stays failed; the error text replaces the subtitle (mono for command output) |
| Summary | after "Check again": polite announcement "5 of 6 checks passed" |
| Set sail disabled | label "Set sail (needs hooks)", `aria-disabled`, focusable so the reason is readable |
| Hook payload drift | check 1 shows warn with "3 hook payloads did not match the pinned fixtures" (state-machines 1.11 item 13) |
| Overflow | long error text wraps (max 4 lines, then "Show full error" disclosure) |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| Page open | run all automatic checks | `GET /api/setup/checks` (server runs probes) = `U.CheckAgain` on open |
| "Install hooks" | back up `~/.claude/settings.json`, merge the deck hooks next to fleetmates' hooks, re-check | `POST /api/setup/hooks` = `U.Fix` |
| "Start deckd" | `systemctl --user start` for the deckd unit, re-check | `U.Fix` |
| "Start scribed" | FAIL-O1 default: `systemd-run --user` running a login shell (`$SHELL -l -c 'exec scribed'`), so scribed is outside the deck's cgroup and gets `HF_TOKEN`; the canvas copy shows `systemctl --user start scribed`, which needs TurbidAssist change T4 (a `scribed.service` unit). Then re-check | `U.Fix` |
| "Fix in Settings" | `/settings/connections#vault` | route |
| "Send test ping" | one popup with the bell through mako | `U.SendTestPing` |
| "Check again" | re-run every check | `U.CheckAgain` |
| "Set sail" | store `firstRunCompletedAt`, go Home | `POST /api/setup/complete` → route `/` |
| "Done" (re-run mode) | back to Settings | route |

## 7. Real-time updates

Each check result arrives as `setup.check` events so rows resolve independently (no waiting for the slowest). No animation beyond the spinner glyph; the status circle swaps instantly.

## 8. Accessibility

- h1 title; the checklist is a `ul` of `li` (ChecklistRow), status glyphs carry sr words ("Passed", "Failed", "Warning", "Not checked", "Checking").
- Initial focus: the first failed blocking check's action ("Install hooks"); if none, "Set sail".
- The disabled Set sail keeps its reason in its visible label.
- Result summary announced politely after each full run.

## 9. Copy deck

| Key | EN |
|---|---|
| `firstRun.title` | Welcome aboard the deck |
| `firstRun.subtitle` | Six checks before the first voyage. Optional ones can wait. |
| `firstRun.cc.ok` | Claude Code {version} compatible |
| `firstRun.cc.ok.sub` | Matches the pinned hook payload fixtures for this deck release |
| `firstRun.cc.warn` | Claude Code {version} is newer than this deck was tested with |
| `firstRun.cc.warn.sub` | Hooks may differ; sessions can show wrong states. |
| `firstRun.cc.drift` | {n, plural, one {# hook payload did not match the pinned fixtures} other {# hook payloads did not match the pinned fixtures}} |
| `firstRun.hooks.ok` | Observation hooks installed |
| `firstRun.hooks.ok.sub` | Every Claude Code session on this machine reports to the deck. |
| `firstRun.hooks.bad` | Observation hooks not installed |
| `firstRun.hooks.bad.sub` | Needed to see sessions you start in a terminal. Adds hooks to ~/.claude/settings.json next to fleetmates. |
| `firstRun.hooks.fix` | Install hooks |
| `firstRun.deckd.ok` | deckd running |
| `firstRun.deckd.ok.sub` | systemd --user · pid {pid} · up {duration} |
| `firstRun.deckd.bad` | deckd is not running |
| `firstRun.deckd.bad.sub` | Sessions can be watched but not launched or answered. |
| `firstRun.deckd.fix` | Start deckd |
| `firstRun.vault.ok` | vault-mcp reachable |
| `firstRun.vault.ok.sub` | VAULT_PATH={path} · {n} notes indexed |
| `firstRun.vault.bad` | vault-mcp did not start |
| `firstRun.vault.fix` | Fix in Settings |
| `firstRun.scribed.ok` | scribed reachable |
| `firstRun.scribed.warn` | scribed socket not found (optional) |
| `firstRun.scribed.warn.sub` | Meetings will work once TurbidAssist is running. |
| `firstRun.scribed.fix` | Start scribed |
| `firstRun.notify.todo` | Notifications |
| `firstRun.notify.todo.sub` | Sends one test popup with the ship's bell through mako. |
| `firstRun.notify.ok` | Test popup sent through mako |
| `firstRun.notify.bad` | notify-send failed: {stderr} |
| `firstRun.notify.fix` | Send test ping |
| `firstRun.optional` | (optional) |
| `firstRun.timeout` | {check} did not answer in 10 s. |
| `firstRun.showError` | Show full error |
| `firstRun.status.ok` | Passed |
| `firstRun.status.bad` | Failed |
| `firstRun.status.warn` | Warning |
| `firstRun.status.todo` | Not checked |
| `firstRun.status.checking` | Checking |
| `firstRun.summary` | {ok} of {n} checks passed |
| `firstRun.footer` | Re-run anytime from Settings, Connections |
| `firstRun.checkAgain` | Check again |
| `firstRun.setSail` | Set sail |
| `firstRun.setSail.blocked` | Set sail (needs hooks) |
| `firstRun.done` | Done |
| `firstRun.cc.missing` | Claude Code was not found |
| `firstRun.setSail.error` | Could not set sail: {error} |
| `firstRun.name.claude` | Claude Code |
| `firstRun.name.hooks` | Observation hooks |
| `firstRun.name.deckd` | deckd |
| `firstRun.name.vault` | vault-mcp |
| `firstRun.name.scribed` | scribed |
| `firstRun.name.notify` | Notifications |

## 10. Acceptance criteria

1. **Given** fixture `firstRunHooksMissing`, **when** opening `/`, **then** the route becomes `/welcome`, "Set sail (needs hooks)" is disabled and focus is on "Install hooks".
2. **Given** "Install hooks" succeeds, **then** row 2 turns ok, "Set sail" becomes enabled and its label drops "(needs hooks)".
3. **Given** scribed and notifications not ok but hooks ok, **then** "Set sail" is enabled.
4. **Given** a probe that never answers, **then** after 10s its row shows "{check} did not answer in 10 s."
5. **Given** "Check again", **then** the announcement "5 of 6 checks passed" (fixture) is present in the live region.
6. **Given** "Set sail", **then** `POST /api/setup/complete` is sent, the route becomes `/`, and reloading `/` no longer redirects.
7. **Given** Claude Code newer than the fixtures, **then** row 1 shows the warning and Set sail stays enabled (SM-O18 default).
8. **Given** 1280 x 720, **then** the page scrolls vertically and nothing overflows horizontally.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| FR-O1 | Should an incompatible Claude Code version block Set sail (SM-O18)? | Open (tracked as SM-O18). Default: warn only. |
| FR-O2 | "Start scribed" mechanism (SM-O13, FAIL-O1). | Open. |
| FR-O3 | Hook installer must keep fleetmates' own hooks (SessionStart, SubagentStop) intact; merge rules and backup file name are not specified. | Proposed: back up to `~/.claude/settings.json.deck-backup-<timestamp>`, append deck hooks per event, never reorder existing entries. |
| FR-O4 | Themed "Set sail" button (design-system 15.1). | Open. |

## 12. Changes from the canvas

1. "Claude Code [version] compatible" shows the real version.
2. Hooks ok copy "Every Claude Code session on this machine reports to the deck." is new (the canvas drew only the failed state).
3. Crew hero 54px becomes 45px (`crew.size.lg`).
4. Checking, timeout, fix-failed and drift states are new.
5. Button heights collapse to `size.control` tokens (44 kept as `xl`).
