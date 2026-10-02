# Focus (one session, terminal first)

| | |
|---|---|
| Canvas board | `Focus` (Focus · terminal first) |
| Route | `/s/:sessionId` with optional `?tab=changes|facts|memory&file=<path>` |
| Milestone | M1: the read-only layout (4.4) for jump to session, with "Mark reviewed" (MS-O1 default). M2 (session list, live terminal, header, Stop, shared input indicator). M3 adds the PromptBar answers and the Changes tab diff. M5 adds the Memory tab. |
| Status | Decided (layout, terminal first, "Last typed from", same keys), Proposed (states, Facts tab content, observed view) |

## 1. Purpose

Answers **"What is this one session doing, and let me drive it."** The real Claude Code terminal mirrored in the browser (Decided: chat in the UI = xterm.js), with the permission prompt mirrored in a bar so approving never depends on reading the TUI, and the session's changes next to it.

## 2. Route and entry points

| Entry | Result |
|---|---|
| Home card title, "Open", "Open terminal", "Review changes" (tab `changes`), FileRow chip (`file=`) | `/s/:id` |
| `Alt 1` to `Alt 9` anywhere | Nth session in urgency order |
| Palette session row (Enter), Alt Enter (terminal focused) | `/s/:id` |
| Desktop popup "Open" (state-machines 9.4) | `/s/:id` |
| Drawer "Open", "Open terminal" | `/s/:id` |
| New session launched from the form (Proposed) | `/s/:newId` with the terminal focused |

Unknown or ended-and-pruned id: a not-found state (5.4). An `ended` session still opens (history view, read-only).

## 3. Layout

| Region | Component / token | Notes |
|---|---|---|
| Session list | `aside aria-label="Sessions"`, width `--layout-list`, `bg.sidebar` | back link + ListRow per session |
| Header | PageHeader `size="md"` (`--layout-header-md`) | crew, title, mono subtitle, pills, actions |
| Terminal | TerminalView, flex 1 | observed sessions: read-only view (4.4) |
| Prompt bar | PromptBar (Banner `approval`) at the bottom of the terminal column | only while a permission request is open |
| Details | `aside aria-label="Session details"`, width `--layout-panel-sm`, `bg.surface` | Tabs Changes, Facts, Memory |

| Width | Behaviour (design-system 8.3) |
|---|---|
| 1920 | list 264, terminal about 1150px, details 440 |
| 1440 | same widths; terminal about 670px (80 columns at 14px) |
| 1280 | list collapses to `--layout-rail-collapsed-list` (72px: avatars and Alt digits, names in Tooltip and `aria-label`); details becomes an overlay Drawer `width="sm"` toggled with `Alt I` |
| `Alt I` hidden panel at any width | terminal takes the space; the xterm refits (fit addon) after the 200ms transition |

## 4. Content inventory

### 4.1 Session list

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Back link | link + Kbd | | "All ships" + `Alt Esc` | Icon `arrow-left` |
| Row | ListRow `role="link"`: CrewAvatar sm, title, subtitle StatePill `text`, trailing Kbd | `repo.name`; `session.state` with params; urgency index | "rustot" / "Needs approval" / "Alt 2" | selected: `aria-current="page"` |
| Team row | same | lead session of a run; aggregate label | "fleetmates" / "2 of 4 need you" | opens Focus on the lead; header links to Team |
| Research row | same | `role = research` | "research" / "Running · research" | canvas copy kept as a label override |
| Launch link | Button `ghost` at the list bottom (Proposed) | | "Launch a ship" + `Alt N` | |

### 4.2 Header

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Crew | CrewAvatar md | pose from state | | `aria-hidden` |
| Title | h1 `type.panel-title` | `session.task` | "Port the damage formula from TFS" | |
| Subtitle | mono MetaLine | `repo.name`, `branch`, `cwd` with `~` | "rustot · combat-tick · ~/dev/rustot" | |
| State | StatePill `pill` | `state`; while needs: waiting since the oldest open request | "Needs approval · 3m" | label override stays literal |
| Input source | pill-shaped static label, Icon `monitor`, Tooltip | shared input machine (state-machines 3.1): `lastInputFrom`, client name | "Last typed from: terminal (kitty)" / "Typing in terminal (kitty)" / "Typing in browser" / amber chip "Both typing: last keystroke wins" | Tooltip "Both the terminal and the browser can type; last keystroke wins"; hidden for observed |
| Terminal hint | text `type.meta` | shown while the terminal has focus | "Alt Esc to leave the terminal" | design-system 11.6 |
| Run link | Button `ghost sm` | `session.runRef` (lead only) | "Open run" | Team tab removed for single sessions (Decided) |
| Mark reviewed | Button `purple sm` | `state = done` | "Mark reviewed" | state-machines row 32 |
| Hide panel | Button `secondary sm` + Kbd | panel open | "Hide panel" + `Alt I` / "Show panel" + `Alt I` | `aria-pressed` |
| Stop | Button `danger sm` | PTY origin, not `ended`/`crashed` | "Stop…" | confirm Dialog |

### 4.3 Terminal column

| Element | Component | Data binding | Notes |
|---|---|---|---|
| Terminal | TerminalView | `session.ptyId`; screen + last 1,000 scrollback lines on attach (state-machines 4.3) | the banner "✻ Claude Code · ~/dev/rustot · combat-tick" is Claude Code's own output, not deck chrome |
| Prompt bar | PromptBar | open permission request on screen: `request.options` parsed from the PTY, `request.tier` | Safe: options 1, 2, 3; Caution: 1 and 3 (option 2 hidden, state-machines 2.5); Destructive: checkbox + option 1 `danger-confirm`, 3 |
| Question bar | PromptBar variant (Proposed) | open `question` request | question text + Field + "Reply", or AskUserQuestion option buttons with their digits |
| Stale banner | Banner `hint` above the terminal | `state = stale` | "Adrift since 17:40: no activity since then." + "Nudge (send Enter)"; open tool line when known |
| Crash banner | Banner `error` above the terminal | `state = crashed` | pill + diagnosis per [failures-and-loading.md](failures-and-loading.md) 4.1; actions "Relaunch", "Dismiss" |
| Joined late note | Banner `info` (dismissible) | `joinedMidLife` | "Joined mid-voyage: changes before 18:42 are not counted." |

### 4.4 Observed sessions (no PTY)

| Element | Component | Data binding | Copy |
|---|---|---|---|
| Banner | Banner `info` | `origin = observed` | "Observed session: started as plain claude, read-only here." |
| Activity log | TerminalTail `crew` variant (full height) | hook steps of the session, newest at the bottom | |
| Transcript link | Button `ghost sm` Icon `external-link` | `transcriptPath` | "Open transcript file" (Proposed) |
| Request bar | Banner `approval` without buttons | open request | "{summary}" + "Answer in your terminal" |

### 4.5 Details panel

| Tab | Element | Component | Data binding | Copy |
|---|---|---|---|---|
| Changes | Tab label + count | Tabs | `changedFiles.length` | "Changes 3" |
| Changes | File list | FileRow `row` in a listbox "Changed files" | `changedFiles[]` (repo-relative path, adds, dels) | "src/combat/damage.rs +64 −3" |
| Changes | Diff | DiffView `unified` (panel under 720px, Decided) | `GET /api/sessions/:id/diff?path=` (git diff against `reviewBaseline`) | caption "src/combat/damage.rs · unified (panel is narrow)" |
| Changes | Mark reviewed | Button `purple` at the list bottom when `done` | | "Mark reviewed" |
| Facts | Facts list (Proposed, not on canvas) | `dl` | origin, started at, duration, Claude session id (+ aliases count), branch, cwd, tool calls, subagents active, last input from, transcript link, review baseline sha | labels in the copy deck |
| Memory | Related memory | Citation `callout` list | `vault_search` on `task` (top 3) + notes this session read (`vault_get_note` tool_input paths) or wrote (`vault_learn`) (Proposed, M5) | eyebrow "Related memory"; "cargo test needs --release for combat parity" / "rust/cargo-release-tests.md:4" |
| Memory | Tab count | Tabs `countTone="teal"` | number of related notes | "Memory 2" |

The canvas placed "Related memory" under the Changes tab; it moves to the Memory tab and a single compact callout stays under the diff when there is one strong match (Proposed, see 12).

## 5. States

### 5.1 Loading

| Case | What shows |
|---|---|
| Route opened, session known from the snapshot | header and list render immediately; TerminalView shows skeleton lines until the first PTY frame (components TerminalView) |
| Diff loading | DiffView skeleton lines |
| Memory tab loading | three Citation skeletons + "Searching your vault…" |

### 5.2 Empty

| Case | What shows |
|---|---|
| No changed files | "No changes yet." in the Changes tab; count hidden |
| No related memory | "Nothing in your vault matches this task yet." |
| No request | PromptBar absent; terminal takes the full column |

### 5.3 Partial and degraded

| Dependency | Effect |
|---|---|
| deckd down | terminal frozen with Banner `connection` above it ("Radio silence from deckd…"), input disabled; PromptBar buttons disabled with "deckd is reconnecting"; Stop disabled; pills keep updating from hooks |
| Screen parse failed (options changed or unreadable) | PromptBar shows "Answer in the terminal" and no buttons (components PromptBar: never guess) |
| deckd `degraded` for this PTY | "Terminal view unavailable" in the terminal area with "Retry" (state-machines 4.2) |
| vault-mcp down | Memory tab disabled with reason text in the panel "Memory is unavailable: vault-mcp is not answering." |
| Git diff failed | DiffView error: "Could not read the diff: {message}" + "Retry" |

### 5.4 Error

| Case | What shows |
|---|---|
| Unknown session id | page body: "This session is not on the deck." + "All ships" (Proposed) |
| Answer did not land | inline Banner `error` in the PromptBar: "Your answer did not reach rustot. The prompt is still open in its terminal." + "Try again" |
| Send guard: typing in terminal | PromptBar line "You are typing in the terminal. Answer there, or try again in a second." |
| Stop failed | toast `error` "Could not stop rustot: {message}" |
| Large paste | confirm Dialog "Paste 12 KB into rustot?" (state-machines 3.5) |

### 5.5 Overflow

| Case | Rule |
|---|---|
| 10+ sessions in the list | list scrolls; only the first 9 carry `Alt N`; the selected row is scrolled into view on open |
| Long title | h1 ellipsis with `title`; subtitle path middle-truncated, keeping the last segment |
| Many changed files | file list scrolls inside a max height of 40% of the panel; diff takes the rest |
| Huge or binary diff | "Binary file, 2.1 MB. Open in editor." (components DiffView) |
| Long PromptBar option labels | shortened keeping verb and scope ("2 Yes, don't ask again for cargo test here"); full text in `title` |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| Click in the terminal | terminal gets focus; keys go to the PTY except the global set (keyboard.md 2) | `I.BrowserBytes` |
| `Alt Esc` | back to Home (and leaves the terminal) | route `/` |
| `Alt 1` to `Alt 9` | switch session; the new terminal attaches, the old one detaches | route |
| `Alt I`, "Hide panel" | toggle the details panel (drawer at 1280) | client, persisted per browser (Proposed) |
| `1`, `2`, `3` with no terminal focus | same option in the PromptBar | `U.PickOption` / `U.Allow` / `U.Deny` (state-machines 2.7) |
| Destructive: checkbox (click or Space), then option 1 click | allow once | `U.ConfirmDestructive`, `U.Allow` |
| Reply in question bar | sends text | `U.Reply` |
| "Nudge (send Enter)" | writes `\r` | `U.Nudge` |
| "Stop…" | confirm Dialog, Cancel focused first; on confirm SIGTERM then SIGKILL after 5 s | `U.Stop` (state-machines row 50) |
| "Mark reviewed" | state `reviewed`, toast "Marked reviewed" | `U.MarkReviewed` |
| "Relaunch" (crashed) | `claude --resume` in the same deck session | `U.Relaunch` |
| "Dismiss" (crashed) | leaves Failures | `U.Dismiss` |
| Tab key in the terminal | goes to Claude Code (no trap: `Alt Esc` and `Alt K` always leave) | |
| FileRow row / arrow keys in the listbox | selects the diff | client |
| Citation | opens the note | route `/memory/note/<path>` |
| "Open run" | Team view | route `/runs/:repoKey/:runId` |

## 7. Real-time updates

| Event | Effect |
|---|---|
| PTY output (WebSocket binary channel per attached PTY, Proposed) | xterm writes; nothing else re-renders |
| `request.opened` / `request.closed` for this session | PromptBar appears or collapses (200ms height transition; reduced motion: instant); "Answered in the terminal" announced politely when it closes without a deck answer |
| `request.updated` (options, screenMatch) | PromptBar re-renders its options |
| `input.source` (shared input machine) | header indicator; collision chip for 3s |
| `session.state` | pill, banners, available actions |
| `session.files` | Changes list; the selected file stays selected if still present |
| `session.state` of other sessions | list subtitles; list order updates only when this page is not hovered (same deferral rule as Home) |

## 8. Accessibility

- Landmarks: `nav` Rail, `aside "Sessions"`, `main` (header + terminal section `aria-label="Terminal, rustot · combat-tick"`), `aside "Session details"`.
- Focus order: back link, session list, header actions, terminal, PromptBar, details tabs.
- Opening Focus moves focus to the terminal (design-system 11.2); the header shows "Alt Esc to leave the terminal" while it has focus; no keyboard trap (WCAG 2.1.2).
- PromptBar is `role="group"` named after the command; its buttons name the option ("1 Yes"); Destructive option 1 stays disabled until the checkbox.
- xterm `screenReaderMode` follows Settings, Appearance (off by default, design-system 11.6).
- The input-source indicator is not live; the collision chip is announced once politely.
- Tabs follow the WAI-ARIA tabs pattern with counts in the name ("Changes, 3").

## 9. Copy deck

| Key | EN |
|---|---|
| `focus.list.back` | All ships |
| `focus.list.label` | Sessions |
| `focus.list.research` | Running · research |
| `focus.list.launch` | Launch a ship |
| `focus.header.waiting` | {state} · {duration} |
| `focus.header.lastTyped.terminal` | Last typed from: terminal ({client}) |
| `focus.header.lastTyped.browser` | Last typed from: browser |
| `focus.header.typing.terminal` | Typing in terminal ({client}) |
| `focus.header.typing.browser` | Typing in browser |
| `focus.header.collision` | Both typing: last keystroke wins |
| `focus.header.inputTooltip` | Both the terminal and the browser can type; last keystroke wins |
| `focus.header.detached` | terminal detached |
| `focus.header.leaveHint` | Alt Esc to leave the terminal |
| `focus.header.openRun` | Open run |
| `focus.header.markReviewed` | Mark reviewed |
| `focus.header.hidePanel` | Hide panel |
| `focus.header.showPanel` | Show panel |
| `focus.header.stop` | Stop… |
| `focus.stop.title` | Stop {repo} · {task}? |
| `focus.stop.body` | The process gets SIGTERM, then SIGKILL after 5 s. Uncommitted changes stay in the working tree. |
| `focus.stop.confirm` | Stop session |
| `focus.stop.cancel` | Cancel |
| `focus.terminal.label` | Terminal, {repo} · {task} |
| `focus.terminal.unavailable` | Terminal view unavailable |
| `focus.terminal.retry` | Retry |
| `focus.observed.banner` | Observed session: started as plain claude, read-only here. |
| `focus.observed.transcript` | Open transcript file |
| `focus.prompt.note` | Same prompt as the terminal, same keys |
| `focus.prompt.opt1` | Yes |
| `focus.prompt.opt2` | Yes, don't ask again for {scope} |
| `focus.prompt.opt3` | No, tell Claude what to do |
| `focus.prompt.answerInTerminal` | Answer in the terminal |
| `focus.prompt.answeredTerminal` | Answered in the terminal |
| `focus.prompt.didNotLand` | Your answer did not reach {repo}. The prompt is still open in its terminal. |
| `focus.prompt.tryAgain` | Try again |
| `focus.prompt.guardTyping` | You are typing in the terminal. Answer there, or try again in a second. |
| `focus.prompt.deckdDown` | deckd is reconnecting |
| `focus.question.reply` | Reply |
| `focus.stale.line` | Adrift since {time}: no activity since then. |
| `focus.stale.nudge` | Nudge (send Enter) |
| `focus.joinedLate` | Joined mid-voyage: changes before {time} are not counted. |
| `focus.tabs.label` | Details |
| `focus.tabs.changes` | Changes |
| `focus.tabs.facts` | Facts |
| `focus.tabs.memory` | Memory |
| `focus.changes.label` | Changed files |
| `focus.changes.empty` | No changes yet. |
| `focus.changes.diffCaption` | {path} · unified (panel is narrow) |
| `focus.changes.diffError` | Could not read the diff: {message} |
| `focus.facts.origin` | Started from |
| `focus.facts.origin.wrapped` | fm claude in a terminal |
| `focus.facts.origin.launched` | the deck |
| `focus.facts.origin.observed` | plain claude (observed) |
| `focus.facts.started` | Started |
| `focus.facts.duration` | Running for |
| `focus.facts.claudeSession` | Claude session |
| `focus.facts.aliases` | {n, plural, one {# earlier conversation} other {# earlier conversations}} |
| `focus.facts.branch` | Branch |
| `focus.facts.cwd` | Working directory |
| `focus.facts.toolCalls` | Tool calls |
| `focus.facts.subagents` | Subagents working |
| `focus.facts.transcript` | Transcript |
| `focus.facts.baseline` | Changes measured since |
| `focus.memory.eyebrow` | Related memory |
| `focus.memory.empty` | Nothing in your vault matches this task yet. |
| `focus.memory.searching` | Searching your vault… |
| `focus.memory.down` | Memory is unavailable: vault-mcp is not answering. |
| `focus.notFound.title` | This session is not on the deck. |
| `focus.paste.title` | Paste {size} into {repo}? |
| `focus.reviewed.toast` | Marked reviewed |
| `empty.focusChanges.title` | No changes yet. |
| `empty.focusMemory.title` | Nothing in your vault matches this task yet. |
| `terminal.label` | Terminal, {label} |
| `terminal.link.confirm` | Open this link from the terminal? (line break) {url} |
| `focus.list.team` | {needs} of {total} need you |
| `focus.header.reviewFailed` | Could not mark this session reviewed. |
| `focus.stop.failed` | Could not stop {repo}: {message} |
| `focus.crash.relaunch` | Relaunch |
| `focus.crash.dismiss` | Dismiss |
| `focus.crash.lost` | The deck lost track of this process. It may have been closed outside the deck. |
| `focus.crash.exit` | The session exited with code {code}. |
| `focus.starting.hint` | No signal from hooks yet. Is fleetmates deck init done? |
| `focus.paste.body` | The text goes to the terminal as one paste. |
| `focus.paste.confirm` | Paste |
| `focus.link.title` | Open this link from the terminal? |
| `focus.link.confirm` | Open link |
| `focus.log.label` | Activity |
| `focus.log.empty` | No activity recorded yet. |
| `focus.log.loading` | Loading activity |
| `focus.changes.caption` | Diffs arrive with approvals. |
| `focus.facts.lastInput` | Last input from |

## 10. Acceptance criteria

1. **Given** fixture `busy`, **when** opening `/s/<rustot>`, **then** the list shows 7 rows with rustot selected (`aria-current="page"`), the header pill reads "Needs approval · 3m", and the terminal section has focus.
2. **Given** the terminal focused, **when** typing `ls` and Enter, **then** deckd receives those bytes and the header indicator switches to "Typing in browser".
3. **Given** the terminal focused, **when** pressing `Alt K`, **then** the palette opens and the PTY receives no bytes; **when** pressing `Alt P`, **then** the PTY receives the Alt P sequence (not intercepted).
4. **Given** the Safe request on screen and focus outside the terminal, **when** pressing `1`, **then** `U.Allow` is sent for the request id and the bar collapses on `request.closed`.
5. **Given** a Caution request, **then** the PromptBar shows options 1 and 3 only.
6. **Given** a Destructive request, **when** pressing `1`, **then** nothing is sent; **when** ticking the checkbox and clicking option 1, **then** it is sent.
7. **Given** 1280 x 800, **then** the list is 72px wide with avatars and Alt digits only, the details panel is hidden, and `Alt I` opens it as an overlay drawer.
8. **Given** an observed session, **then** no TerminalView input exists, the banner reads "Observed session: started as plain claude, read-only here.", and neither Stop nor Nudge is rendered.
9. **Given** fixture `deckdDown`, **then** the terminal shows the connection banner, PromptBar buttons are disabled with "deckd is reconnecting", and the pill still changes when a hook event arrives.
10. **Given** "Stop…", **when** the dialog opens, **then** "Cancel" has focus; **when** confirming, **then** `POST /api/sessions/:id/stop` is sent.
11. **Given** a done session, **when** clicking "Mark reviewed", **then** the pill becomes "Reviewed" and the Home "to review" chip decrements in the same frame.
12. **Given** the Changes tab, **when** pressing Down in the file listbox, **then** the next file's diff renders and its row has `aria-selected="true"`.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| FOC-O1 | Opening Focus "for a teammate" (Team task rows, crew terminals): fleetmates teammates are subagents of the lead with no PTY of their own (fleetmates contract 5). | **Decided** (D-69): teammate links open the lead's Focus with the drawer filtered to that task's requests; no per-teammate terminal. |
| FOC-O2 | PTY size when the terminal client and the browser differ (SM-O12). | Open (tracked as SM-O12). |
| FOC-O3 | Facts tab content was never designed. | Proposed (4.5). |
| FOC-O4 | "Notes read by this session" in the Memory tab: hooks give `tool_input` paths for `vault_get_note` but not the hits of `vault_search` (tool responses are not relied on, state-machines 0.2). | Proposed: list `vault_get_note` paths only. |

## 12. Changes from the canvas

1. "Hide panel" chord `Alt B` becomes `Alt I` (keyboard.md 2: Alt B is word-left in Claude Code).
2. "Related memory" moves from under the Changes tab into the Memory tab (one strong match may stay as a callout).
3. Focus list row "Done · to review" becomes "Done" (literal pill).
4. "Mark reviewed" and "Open run" header actions are new (state-machines row 32; Team tab removed for single sessions).
5. The canvas terminal replica and blinking caret are replaced by the live xterm (`cursorBlink` off under reduced motion).
6. PromptBar hides option 2 for Caution and shows a checkbox for Destructive (state-machines 2.5); the canvas drew only the Safe case.
7. Stop confirm copy uses SIGTERM then SIGKILL after 5 s (state-machines row 50), not SIGINT (components Dialog example).
8. Terminal dim color `#737aa2` collapses into `text.muted` (design-system 14).
