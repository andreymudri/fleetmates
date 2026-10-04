# Home (Sessions)

| | |
|---|---|
| Canvas boards | `Home` (busy, comfortable), `HomeCompact` (compact density), `HomeCalm` (calm seas, adaptive) |
| Route | `/` |
| Milestone | M1 (comfortable grid, quiet row, calm state, header counts). M2 adds compact density (needs deckd screen tails) and "Launch a ship". M3 adds inline answers on cards. |
| Status | Decided (canvas, reviewed three times) with Proposed states and rules marked inline |
| Depends on | [02-domain.md](../02-domain.md) sections 2 and 3, [state-machines.md](../interaction/state-machines.md) sections 1, 2, 4, 9, [components.md](../design/components.md) |

Status labels (Decided, Proposed, Open) mean what [02-domain.md](../02-domain.md) says. Component and token names refer to [components.md](../design/components.md) and [tokens.css](../design/tokens.css); this spec never restates their styles.

## 1. Purpose

Home answers one question at a glance: **"Which of my sessions needs me right now, and what are the others doing?"** It is the M1 acceptance screen: 3+ parallel sessions for a full work week without opening a pane to check status (Decided).

Secondary questions: what is waiting for my review ("to review"), what went quiet (stale, idle), and, when nothing is happening, what is left open from today (HomeCalm).

## 2. Route and entry points

| Entry | Result |
|---|---|
| App start after the first run is complete | `/` |
| Rail "Sessions" (`Alt Shift 1`) | `/` |
| `Alt Esc` from anywhere (keyboard.md section 2) | `/` |
| "All ships" back link in Focus and Team | `/` |
| Desktop notification "Open" when no session can be targeted | `/` |

`/` redirects to `/welcome` while `firstRunCompletedAt` is unset (see [first-run.md](first-run.md)). Proposed.

Home has three presentations on one route, chosen by rules, never by URL:

| Presentation | When | Status |
|---|---|---|
| Comfortable grid | default; density preference `comfortable` | Decided |
| Compact grid | density preference `compact` (SegmentedControl) | Decided |
| Calm | no session in `starting`, `running`, `needs_approval`, `asked_you`, `crashed` (see 5.7 for `stale`) | Decided rule, Proposed state list |

## 3. Layout

### 3.1 Regions (comfortable)

| Region | Component / token | Notes |
|---|---|---|
| Shell | AppShell, Rail (`active="sessions"`) | see [rail-and-shell.md](rail-and-shell.md) |
| Header | PageHeader `size="lg"` (`--layout-header-lg`) | title block, count chips, SegmentedControl, search trigger, Launch button |
| Fleet (main grid) | CSS grid per design-system 8.2, gap `--space-20`, padding `--space-20 --space-28 --space-24` | SessionCard `density="comfortable"`, urgency order |
| Quiet row | third grid row, height `--layout-quiet-row` | QuietCard x up to 3, or QuietStrip in crowded mode (5.6) |

### 3.2 Regions (compact)

Header PageHeader `size="sm"` (`--layout-header-sm`), grid 3 x 3 of SessionCard `density="compact"`, gap `--space-10`. Root font size per design-system 13.

### 3.3 Regions (calm)

Main padding is the HomeCalm layout exception (design-system 5: 72 x 120). Three blocks stacked and vertically centred: hero row, three CalmSection cards, "Recent harbors" row.

### 3.4 Width and height behaviour

| Viewport | Comfortable | Compact | Calm |
|---|---|---|---|
| 1920 x 1080 (primary, Decided) | 3 columns, rows `minmax(0,1fr) minmax(0,1fr)` then quiet row: 6 cards + 3 quiet cards without scroll | 3 x 3, no scroll | 3 CalmSections in one row |
| 1440 wide, height 1000 or more | same as 1920 | same as 1920 | same, sections narrower (about 360px each) |
| 1440 wide, height under 1000 | rows `repeat(2, minmax(360px, auto))` then quiet row; the fleet section scrolls, header stays (design-system 8.2, Proposed) | rows `minmax(260px, 1fr)`, scroll | unchanged, page scrolls |
| 1280 to 1439 | 2 columns, rows `minmax(360px, auto)`, scroll; quiet row keeps 3 columns spanning both (design-system 8.2) | 2 columns, rows `minmax(260px, 1fr)`, scroll | padding `--space-48 --space-56`; 2 columns: Captain's log and Charts, Last meeting below spanning both (Proposed) |

Header at 1280: the search trigger drops its label and keeps icon + Kbd; count chips never wrap (they sit in one row; the subtitle truncates first). Proposed.

## 4. Content inventory

### 4.1 Header

| Element | Component | Data binding | Copy (EN) | Notes |
|---|---|---|---|---|
| Title | PageHeader h1 | none | "Sessions" | only h1 on the page |
| Daily recap | PageHeader subtitle, MetaLine | `recap.voyages`, `recap.madePort`, `recap.chartsAdded` (5.8) | "Captain's log: 9 voyages · 3 made port · 1 chart added" | themed, subtitle only (Decided). Chart segment hidden until M5 (vault data). |
| Needs you chip | StatePill `variant="count"` state `needs_approval` | `counts.needYouSessions` | "3 need you" | hidden at 0 (Proposed). Button: opens the Needs-you drawer |
| Running chip | StatePill `count`, state `running` | `counts.running` = sessions in `starting`, `running` (disjoint from need you and to review, 02-domain 3) | "4 running" | fixture value is 2, see changes from canvas |
| To review chip | StatePill `count`, state `done` | `counts.toReview` = sessions in `done` | "1 to review" | hidden at 0 (Proposed) |
| Density | SegmentedControl `label="Density"` | `localStorage` `deck.density` (per browser, Proposed) | "Comfortable", "Compact" | |
| Search trigger | Button `secondary` + Icon `search` + Kbd | none | "Search, ask or run" + `Alt K` | opens Palette |
| Launch | Button `primary` `size="lg"` icon `plus` `kbd="Alt N"` | none | "Launch a ship" | themed launch verb: design-system 15.1 (Open). Kbd added (keyboard.md 4) |

### 4.2 SessionCard (main grid), by variant

Variant selection (Proposed, one card per row of this table, first match wins):

| Condition | Variant |
|---|---|
| `session.role = lead` and `session.runRef` set | `team` (one card per run; the run's teammates never get their own cards) |
| `session.role = research` | `research` |
| `state = needs_approval` | `approval` |
| `state = asked_you` | `question` |
| `state = crashed` | `crashed` |
| `state = done` | `done` |
| `state` in `starting`, `running` | `solo-running` |

Shared header on every variant:

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Crew | CrewAvatar `md`, `aria-hidden` | `repo.crewSeed`, `repo.crewSlot`, pose from `session.state` (crew.md 6), `repo.hat` or team hat | none | |
| Title (link to Focus or Team) | card title link | `session.task` ("Untitled" fallback, 02-domain 2.2) | "Port the damage formula from TFS" | one line, ellipsis, `title` attr |
| Repo and branch | mono MetaLine | `repo.name`, `session.branch` | "rustot · combat-tick" | branch omitted when null |
| State | StatePill `pill` | `session.state`, params `{ n }`, `{ duration }`, `{ code }` | literal label from 02-domain 3 | team: label override "2 of 4 need you" |

Variant bodies:

| Variant | Element | Component | Data binding | Copy (canvas, corrected where noted) |
|---|---|---|---|---|
| all but team, research | Last steps | TerminalTail `steps` | last 3 entries of `session.steps` (server ring buffer of tool steps built from `H.PreToolUse`/`H.PostToolUse`, Proposed) | "● Read legacy/tfs/src/combat.cpp", "● Update src/combat/damage.rs  +64 −3" |
| all but team, research | Now line | text `type.body`, 2 lines | `session.activity` when set ("Compacting context…", "3 subagents working"), else last assistant sentence from the transcript tail (Proposed) | "Ported the melee and distance formulas. Wants to check parity with the Lua tests." |
| approval | Request box | Banner-like box per SessionCard spec, TierBadge `sm` + detail | oldest open request: `request.tier`, `request.toolName`, `request.summary` | "SAFE · TEST", "Wants to run", "cargo test --release combat::" |
| approval | Rule suggestion | inline link | rule machine `offered` for `(repoId, pattern)` (state-machines 2.8) | "Allowed 5 times. Always allow in rustot?" |
| approval | Actions | Button `amber-outline` Deny, `amber` Allow once | `request.id` | "Deny", "Allow once". Destructive: replaced by "Review in Needs you" (Destructive answers only in drawer and Focus, state-machines 2.5). Observed: replaced by text "Answer in your terminal" + ghost "Open" |
| approval, question | More requests | link | `openRequests(session).length - 1` | "+1 more request" (Proposed); opens the drawer on this session |
| question | Question box | text `type.body`, 3 lines then "Open to read all" | `request.summary` (question text) | "The logs endpoint returns 180k rows. Should logs older than 30 days be paginated or truncated?" |
| question | Reply | Field TextInput (sr-only label) + Button `amber` | `request.id`; AskUserQuestion options render as `amber-outline xs` option buttons instead (state-machines 2.5) | label "Reply to discord-audit", button "Reply" |
| solo-running, done | Changed files | Eyebrow + FileRow `chip` (max 2 rows then "+N more") | `session.changedFiles` | "Changed files", "Hero.tsx +38 −4" |
| solo-running | Footer meta | MetaLine | `now - startedAt`, count of tool steps | "14m · 31 tool calls" |
| solo-running | Learned chip | NoteChip "learned" variant | count of `vault_learn` tool calls by this session today (Proposed) | "learned 1 thing" |
| done | Footer | MetaLine + Button `purple` | `stateSince` relative | "Finished 6 min ago", "Review changes" |
| team | Crew tiles | CrewTile x (lead + teammates, max 5 then "+N") | `run.teammates[]`: `taskId`, `state`; lead from `run.leadSessionId` | "lead · T6", "T3 · done", "T4 · needs you" (canvas "task 4" corrected to task ids) |
| team | Request box | TierBadge `sm outline` + mono line per open request attributed to a task, Button `amber` | open requests of the lead session grouped by task (state-machines 11) | "CAUTION task T4 · npm install commander@14", "Review 2" |
| team | Phases | PhaseBar `card` | `run.derivedPhase`, `plan.totalPhases`, task counts per phase | phase labels "Phase 1"... (see 11, HOME-O2) |
| team | Next line | text | template, Proposed (5.9) | "Next: Gate 2 checks tasks 3 to 7 once both requests are answered and the integrator merges them." |
| team | Footer | MetaLine | tasks done / total; latest recorded gate; run elapsed | "Tasks 5/9 · Gate 1 passed · 1h 12m" |
| research | Intro + linked notes | text + NoteChip `chip` | `research.topic`, `research.existingNotes[]` | "Comparing lock semantics, failure modes and latency. Will link to" |
| research | Stats | StatTile x 3 | run output (SM-O15, Open) | "9 sources kept", "14 claims checked", "2 linked notes" |
| research | Latest claim | well + mono source | run output (SM-O15, Open) | "Latest claim checked" |
| research | Progress | ProgressBar | run output; `indeterminate` until the contract gives a percentage | "Scouting · drafting the note", "3 scouts · Standard" |
| crashed | Error tail, hint, actions | see [failures-and-loading.md](failures-and-loading.md) 4.1 | | |
| starting | Body | SkeletonCard lines in place of steps; after `startTimeout` a hint | state-machines 1.6 | "No signal from hooks yet. Did you run fleetmates-deck init?" + "Open terminal" |
| any | Joined late note | `type.meta` line | `session.joinedMidLife`, discovery time | "Joined mid-voyage: changes before 18:42 are not counted." |

### 4.3 Quiet row

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Card | QuietCard | sessions in `stale`, `idle`, `reviewed` (reviewed hidden after local midnight, state-machines row 34) | | order: stale, idle, reviewed; within a state newest `stateSince` first |
| State | StatePill `text` | `state`, `{ n }` minutes since `lastActivityAt` for stale, `{ duration }` since `stateSince` for idle | "No activity 22m", "Idle 1h", "Reviewed" | |
| Line (stale) | text | `stateSince` as clock time; open tool if any | "Adrift since 17:40: no activity since then." + "Still inside Bash: cargo test --release" when a tool is open | corrected copy, see 12 |
| Line (idle) | text | `stateSince` | "Last turn ended at 16:02. Waiting for the next order." | |
| Line (reviewed) | text | `reviewedAt` | "Reviewed at 15:20. Leaves the grid at midnight." | corrected copy, see 12 |
| Actions (stale) | Button `ghost xs` | | "Open terminal", "Nudge (send Enter)" | Nudge hidden for observed sessions |
| Actions (idle) | Button `ghost xs` | | "Open", "Stop…" | Stop hidden for observed sessions |
| Actions (reviewed) | Button `ghost xs` | | "Open" | |

### 4.4 Compact card (HomeCompact)

| Element | Component | Data binding | Copy |
|---|---|---|---|
| Header strip | CrewAvatar sm, repo, mono branch, StatePill `dot` | as 4.2 | "rustot", "combat-tick", "Needs approval" |
| Tail | TerminalTail `tail`, `pinHead` | PTY screen lines from the deckd screen model (M2); observed sessions: hook steps with a muted first line "Observed · from hooks" (Proposed) | |
| Action strip | Banner `strip`: TierBadge sm, one-line ask, two Buttons `xs` | as 4.2 by variant | team "Open" / "Review 2"; approval "Deny" / "Allow once"; question "Open" / "Reply"; destructive "Open" / "Review" |

Compact "Reply" opens the drawer with the reply field focused (compact has no input, canvas 3.2). Team strip ask: "task T4 npm install · task T5 npm test".

### 4.5 Calm (HomeCalm)

| Element | Component | Data binding | Copy | Status |
|---|---|---|---|---|
| Hero crew | CrewAvatar `xl` x 3, pose idle | 3 most recently active repos | none | Decided |
| Headline | h1 `type.display` | none | "Calm seas. No ships out." | Decided |
| Subtitle | text | local weekday and part of day | "Saturday evening · nothing running, nothing adrift · the crew is resting" | Decided copy, Proposed day-part rule (5.10) |
| Launch | Button `primary` `size="hero"` `kbd="Alt N"` | | "Launch a ship" | Decided |
| Captain's log card | CalmSection | `recap` | "Captain's log · today", "9 voyages · 3 made port · 1 chart added" | Decided |
| Open loops | CalmSection link rows | sessions in `done` (row "{repo} waits in port for review" + "Review") | "Open loops before tomorrow" | done rows Proposed binding; git rows Open (HOME-O3) |
| Charts added | CalmSection capture links | notes captured today (M5, see memory.md MEM-O3) | "Charts added to your vault", "Open Memory" | Decided layout |
| Last meeting | CalmSection + ActionItemCard `row` | newest synthesized meeting today (M4) | "Last meeting", "Launch as session" | Decided layout; Launch as session is the MEET-O6 default shipped in 0.4.0, still the owner's to revisit |
| Unanswered questions | row + Button `teal-outline xs` | unresolved `Miss` rows (M5) | "Unanswered questions", "Research this" | Decided |
| Recent harbors | Button `secondary` chips with CrewAvatar sm pose none | 5 repos by latest session | "Recent harbors" | Decided |

## 5. States

### 5.1 Loading

| Case | What shows |
|---|---|
| First load, no cached snapshot (WebSocket `connecting` or `resyncing`) | Header renders with chips as SkeletonCard `row` blocks; fleet region `aria-busy="true"` with 6 SkeletonCard `session` in the grid cells and 3 in the quiet row; `.sr-only` "Loading sessions" (state-machines 4.1) |
| Snapshot cached, reconnecting | last state stays visible, dimmed, "as of 18:42" in the connection banner; action buttons disabled (state-machines 4.1) |
| Compact tails waiting for the first deckd frame | TerminalTail shows 3 skeleton lines |

Skeleton fades to content in 160ms (`--motion-duration-normal`); no layout shift because skeletons occupy the same grid cells.

### 5.2 Empty

No sessions at all, or none that block calm: the Calm presentation (4.5). Each CalmSection has its own empty line (components CalmSection): "No open loops.", "Nothing new in your vault today.", "No meetings today." A fresh install with zero repos seen: hero subtitle "No ships yet. Launch one, or start claude in a terminal and it shows up here." (Proposed).

### 5.3 Partial and degraded

| Dependency down | Effect on Home |
|---|---|
| deckd (state-machines 4.2) | connection Banner under the header: "Radio silence from deckd. Ships still sailing, re-establishing contact… (attempt 3, next in 4s)" + "Retry now". Pills and requests keep updating from hooks. Compact tails show skeleton lines. Disabled with visible reason "deckd is reconnecting": Allow once, Deny, Reply, Nudge, Stop…, Launch a ship. |
| Web server link (browser side) | Banner "Lost the deck server. Your ships are unaffected, reconnecting… (attempt 3, next in 4s)" + "Retry now" (Proposed copy, state-machines 4.1). Whole UI dimmed, actions disabled. |
| One run's `status.json` unreadable | that team card body shows "status.json unreadable, retrying" in place of phases and tiles; pill still from the lead session hooks (state-machines 5.4) |
| vault-mcp down | "learned 1 thing" chip still renders (it counts tool calls). Calm "Charts added" section shows "Your vault is not reachable right now." with "Retry" (Proposed). Recap drops the chart segment. |
| scribed down | Calm "Last meeting" still loads from session files and notes (Decided: past meetings load from disk) |
| Transcript unreadable | now line falls back to the last step text; no error shown (Proposed) |

### 5.4 Error

| Case | What shows |
|---|---|
| Token invalid or origin rejected | full-page message owned by the shell ([rail-and-shell.md](rail-and-shell.md) 4.6) |
| Answer did not land (request `did_not_land`) | inline Banner `error` inside the request box: "Your answer did not reach rustot. The prompt is still open in its terminal." + "Try again" (only when `on_screen`) + "Open terminal" (state-machines 2.4) |
| Answer guard failed | inline muted line in the request box: "The terminal is showing a different prompt. Open terminal." or "You are typing in the terminal. Answer there, or try again in a second." |
| Request already answered | buttons disable, line "Answered in the terminal" for 4s, then the box leaves (components SessionCard) |
| Session data failed to load (one card) | DegradedCard content inside the card shell with "Retry" (components SessionCard, Proposed) |

### 5.5 Overflow

| Case | Rule |
|---|---|
| Long task title | one line, ellipsis, full text in `title` and accessible name |
| Long repo or branch | mono line ellipsis; repo name wins over branch (branch truncates first, Proposed) |
| Long command in request box | `code` element scrolls horizontally; never ellipsis (components RequestRow: hiding part of an approved command is unsafe) |
| Long question | 3 lines then "Open to read all" link to Focus |
| Many changed files | FileRow chips wrap to 2 rows then "+N more" (opens Focus Changes tab) |
| More than 5 teammates | 4 tiles + a "+N" tile linking to Team |
| More than 2 requests on a team card | 2 lines + "+N more"; button label "Review N" |
| More than 6 main-grid cards (comfortable) | extra rows `minmax(360px, 1fr)`, fleet section scrolls; most urgent first (design-system 8.2) |
| 10 or more sessions on Home | crowded mode, 5.6 |
| Counts over 99 | chip shows the number; the Rail badge caps at "99+" (Proposed) |

### 5.6 Crowding rule (quiet row and QuietStrip)

Decided (D-18): with 10+ sessions, idle and done collapse into a strip instead of taking grid cells.

| Mode | Trigger (Proposed thresholds) | Main grid holds | Quiet area holds |
|---|---|---|---|
| Normal | Home sessions <= 9 and quiet sessions <= 3 | needs_approval, asked_you, crashed, starting, running, done, team, research | QuietCard row: stale, idle, reviewed (max 3) |
| Crowded | Home sessions >= 10, or quiet sessions > 3 | needs_approval, asked_you, crashed, starting, running, team, research | QuietStrip: chips for stale, done, idle, reviewed in that order |

"Home sessions" = every session except `ended`. The grid never hides a session that needs you or crashed.

QuietStrip (new component, Proposed; add to components.md): one row inside the 176px quiet area, top-aligned, wraps to at most 2 rows, then a "+N more" Button `ghost xs` that opens the Palette with the Sessions group. Each chip is a link (ListRow-like): CrewAvatar sm, "repo · task" (`type.label`, ellipsis at 200px), StatePill `text`. Done chips keep the `done` pill ("Done") and still count in "to review"; activating a done chip opens Focus on the Changes tab. Stale chips come first because adrift is worth noticing (design-system 3.4).

Hysteresis (Proposed): leave crowded mode only when the count drops to 8 or fewer, so one session starting and ending does not flip the layout.

### 5.7 Calm eligibility

Calm shows when no session is in `starting`, `running`, `needs_approval`, `asked_you`, `crashed` (Decided "nothing running", Proposed state list; `done`, `idle`, `reviewed` do not block calm, the canvas shows a done session as an open loop).

Stale sessions: the two sources disagree (HOME-O1). Default until decided: a stale session keeps calm off; Home shows the grid with the stale session in the quiet row. The Decided copy fix still applies wherever a calm-style headline would show: never "Calm seas" while something is adrift.

Switching between grid and calm crossfades 160ms; never while focus is inside a card (deferred up to 5s, then applied).

### 5.8 Captain's log definitions (Proposed)

| Value | Definition |
|---|---|
| voyages | deck sessions with `startedAt` today (local), any origin |
| made port | sessions that entered `done` today (counted once per session) |
| charts added | notes created today by `vault_learn` (M5; see MEM-O3). Segment hidden before M5 or when 0 |

### 5.9 Team "Next" line (Proposed)

Built from data, never free text: if requests are open, "Next: Gate {n} checks tasks {from} to {to} once {requests, plural, one {the request is answered} other {# requests are answered}} and the integrator merges them."; if none are open and tasks are running, "Next: Gate {n} runs when tasks {from} to {to} are merged."; if the run is fully integrated, the line is hidden. `{n}` is `derivedPhase`, the range comes from `plan.json` task phases.

### 5.10 Calm subtitle day part (Proposed)

Weekday from `Intl.DateTimeFormat` (`weekday: 'long'`), part of day by local hour: 5 to 11 "morning", 12 to 17 "afternoon", 18 to 22 "evening", otherwise "night". Keys in the copy deck.

## 6. Interactions

API paths are Proposed; the state-machine event is the contract.

| Trigger (mouse / keyboard) | Result | API or event |
|---|---|---|
| Card title click / Enter on the title link | Focus on that session; team card opens Team; research card opens `/research/:id` | route `/s/:id`, `/runs/:repoKey/:runId`, `/research/:id` |
| `Alt 1` to `Alt 9` | Focus on the Nth session in urgency order (7.3) | route |
| "Needs you" chip / `Alt U` | opens the Needs-you drawer | UI only |
| "Running" chip | scrolls to and focuses the first running card (Proposed) | UI only |
| "To review" chip | Focus on the oldest `done` session, Changes tab (Proposed) | route `/s/:id?tab=changes` |
| Density segment / Arrow keys in the radiogroup | switch comfortable or compact; persisted | localStorage `deck.density` |
| Search trigger / `Alt K` | opens the Palette | UI only |
| "Launch a ship" / `Alt N` | opens the new-session form | route `/new` |
| "Allow once" (Safe, Caution) | answer option 1 | `POST /api/requests/:id/answer {choice:'allow'}` = `U.Allow` (state-machines 2.7 row 9) |
| "Deny" | answer option 3, then 30s "Tell Claude what to do instead" input in the box | `U.Deny` |
| "Review in Needs you" (Destructive) | opens the drawer on that request | UI only |
| Rule suggestion link | accepts the rule; toast "Rule added to rustot: Bash(cargo test:*)" with "Undo" | `POST /api/rules` = `U.AcceptRule` (state-machines 2.8) |
| "Reply" / Enter in the reply field | sends the text | `U.Reply(text)` |
| AskUserQuestion option button | sends the option number | `U.PickOption(n)` |
| "Review 2" (team) | drawer filtered to the run, focus on its first request | UI only (components Drawer) |
| "Review changes" | Focus on the session, Changes tab | route |
| FileRow chip | Focus, Changes tab with that file selected | route `/s/:id?tab=changes&file=<path>` |
| NoteChip, "learned 1 thing" | opens the note in Memory | route `/memory/note/<path>` |
| "Open terminal" (quiet stale) | Focus with the terminal focused | route |
| "Nudge (send Enter)" | writes `\r` to the PTY; does not reset stale by itself | `POST /api/sessions/:id/nudge` = `U.Nudge` |
| "Stop…" | confirm Dialog "Stop turbidassist · Tune the VAD threshold?" | `U.Stop` on confirm |
| "Open" (quiet idle, reviewed) | Focus | route |
| "+N more" in QuietStrip | Palette with Sessions group | UI only |
| Calm "Review" open-loop row | Focus Changes tab | route |
| Calm capture link / "Open Memory" | note in Memory / `/memory` | route |
| Calm "Launch as session" | new-session form prefilled with the action item text | route `/new?task=` (MEET-O6) |
| Calm "Research this" | research form prefilled with the question | route `/research/new?topic=` |
| Recent harbor chip | new-session form with that repo selected | route `/new?repo=<repoKey>` |

## 7. Real-time updates

### 7.1 Events (names Proposed)

| Server event | Updates |
|---|---|
| `session.upserted`, `session.state` | card variant, pill, crew pose, border; grid placement (main, quiet, strip, calm); urgency order |
| `session.steps` | TerminalTail `steps` (last 3), footer tool count |
| `session.files` | FileRow chips |
| `session.activity` | now line |
| `request.opened`, `request.updated` (delivery, screenMatch), `request.closed` | request box, buttons, inline guard messages |
| `counts` | all three header chips, Rail badge, document title prefix. One server query produces `counts` for every consumer (02-domain 3); the browser never counts on its own |
| `run.updated` | team card tiles, phases, footer |
| `research.updated` | research card stats and progress |
| `screen.tail` (M2) | compact tails |
| `health.changed` | banners and degraded parts (5.3) |
| `recap` | header subtitle, calm Captain's log |

### 7.2 Animation rules

- New card: fade in 200ms (`--motion-duration-moderate`, enter easing). Leaving card: fade out 160ms.
- Reorder: FLIP translate 200ms (design-system 10.4). **Deferred while the pointer is over the grid or focus is inside a card**, for at most 5s, so a button never moves under the pointer between aim and click (Proposed, safety rule for Allow once).
- State change on a card: border and pill colors 200ms; the card never changes size mid-state; body swaps without animation.
- Needs-you cards use `.motion-pulse`; running pills `.motion-breathe`; nothing else loops. Reduced motion is handled globally by tokens.css.
- Ticking values (stale minutes, idle duration, "Finished 6 min ago", "waiting 3m") update once per minute from timestamps on the client; they jump, never animate.
- Calm to grid switch: crossfade 160ms.

### 7.3 Urgency order (Proposed; shared with Focus list, Palette, `Alt 1..9`)

`needs_approval`, `asked_you`, `crashed`, `starting` and `running` (team and research cards included by their aggregate state), `done`, `stale`, `idle`, `reviewed`. Ties: oldest open request first for the two needs states, else newest `stateSince` first. The order is computed server-side once and sent with the snapshot so every surface agrees.

## 8. Accessibility

- Landmarks: Rail `nav`, `main` with the page `header`; the fleet grid is a `section` with an `.sr-only` h2 "Active sessions"; the quiet row a `section` with `.sr-only` h2 "Quiet sessions"; Calm uses visible h2s (CalmSection).
- Cards are `article aria-labelledby` their title. Tab order inside a card: title link, request actions (Deny, Allow once or Reply), then other actions. DOM order equals visual order (row-major).
- Count chips are buttons with full names: "3 sessions need you. Open Needs you", "2 running", "1 to review". The Kbd inside the search trigger is not repeated in its accessible name.
- New requests and crashes are announced by the AppShell live region only (batched, one per 2s); cards and pills are never live regions.
- Destructive requests never show Allow on a card, so no keyboard path approves them from Home.
- Density control is a `radiogroup` with arrow keys.
- Disabled buttons during deckd outage keep a visible reason text ("deckd is reconnecting").
- QuietStrip chips: accessible name "turbidassist · Tune the VAD threshold, Idle 1h".
- Calm headline is the page h1 in calm mode ("Sessions" h1 is not rendered then); the document title stays "Sessions · fleetmates deck".

## 9. Copy deck

| Key | EN | Notes |
|---|---|---|
| `home.header.title` | Sessions | |
| `home.header.log.prefix` | Captain's log: | MetaLine first item |
| `home.header.log.voyages` | {n, plural, one {# voyage} other {# voyages}} | |
| `home.header.log.madePort` | {n} made port | |
| `home.header.log.charts` | {n, plural, one {# chart added} other {# charts added}} | |
| `home.header.needYou` | {n, plural, one {# needs you} other {# need you}} | |
| `home.header.needYou.a11y` | {n, plural, one {# session needs you} other {# sessions need you}}. Open Needs you | |
| `home.header.running` | {n} running | |
| `home.header.toReview` | {n} to review | |
| `home.header.density.label` | Density | |
| `home.header.density.comfortable` | Comfortable | |
| `home.header.density.compact` | Compact | |
| `home.header.search` | Search, ask or run | |
| `home.header.launch` | Launch a ship | design-system 15.1 |
| `home.card.steps.waiting` | Waiting for your answer · {duration} | step line |
| `home.card.activity.compacting` | Compacting context… | |
| `home.card.activity.subagents` | {n, plural, one {# subagent working} other {# subagents working}} | |
| `home.card.activity.leadWaiting` | Lead is waiting; {n, plural, one {# subagent working} other {# subagents working}} | |
| `home.card.request.wantsToRun` | Wants to run | |
| `home.card.request.deny` | Deny | |
| `home.card.request.allowOnce` | Allow once | |
| `home.card.request.reviewInDrawer` | Review in Needs you | Destructive |
| `home.card.request.answerInTerminal` | Answer in your terminal | observed |
| `home.card.request.open` | Open | |
| `home.card.request.more` | {n, plural, one {+# more request} other {+# more requests}} | |
| `home.card.request.tellInstead` | Tell Claude what to do instead | 30s after Deny |
| `home.card.request.answeredInTerminal` | Answered in the terminal | |
| `home.card.request.didNotLand` | Your answer did not reach {repo}. The prompt is still open in its terminal. | |
| `home.card.request.tryAgain` | Try again | |
| `home.card.request.openTerminal` | Open terminal | |
| `home.card.request.guardScreen` | The terminal is showing a different prompt. Open terminal. | |
| `home.card.request.guardTyping` | You are typing in the terminal. Answer there, or try again in a second. | |
| `home.card.request.deckdDown` | deckd is reconnecting. Answer in your terminal for now. | |
| `home.card.rule.short` | Allowed {n} times. Always allow in {repo}? | |
| `home.card.rule.anyFlags` | Any flags. | after `home.card.rule.short` when the matched tiers.json entry has `ruleNote: 'anyFlags'` (D-78) |
| `home.card.rule.added` | Rule added to {repo}: {pattern} | toast |
| `home.card.rule.undo` | Undo | |
| `home.card.question.reply.label` | Reply to {repo} | sr-only label and placeholder |
| `home.card.question.reply` | Reply | |
| `home.card.question.readAll` | Open to read all | |
| `home.card.files.eyebrow` | Changed files | |
| `home.card.files.more` | +{n} more | |
| `home.card.meta.toolCalls` | {n, plural, one {# tool call} other {# tool calls}} | MetaLine item after duration |
| `home.card.learned` | {n, plural, one {learned # thing} other {learned # things}} | |
| `home.card.done.finished` | Finished {relative} | `Intl.RelativeTimeFormat`, "6 min ago" |
| `home.card.done.review` | Review changes | |
| `home.card.team.pill` | {needs} of {total} need you | pill label override |
| `home.card.team.tile.lead` | lead · {taskId} | |
| `home.card.team.tile.needs` | {taskId} · needs you | |
| `home.card.team.tile.done` | {taskId} · done | |
| `home.card.team.tile.running` | {taskId} · running | |
| `home.card.team.review` | Review {n} | |
| `home.card.team.moreTiles` | +{n} | |
| `home.card.team.phase` | Phase {n} | HOME-O2 |
| `home.card.team.next.requests` | Next: Gate {gate} checks tasks {from} to {to} once {n, plural, one {the request is answered} other {# requests are answered}} and the integrator merges them. | |
| `home.card.team.next.merge` | Next: Gate {gate} runs when tasks {from} to {to} are merged. | |
| `home.card.team.tasks` | Tasks {done}/{total} | |
| `home.card.team.gatePassed` | Gate {n} passed | recorded verdict, see team-run.md |
| `home.card.team.gateFailed` | Gate {n} failed | |
| `home.card.team.statusUnreadable` | status.json unreadable, retrying | |
| `home.card.research.intro` | Comparing {topic}. Will link to | Proposed; canvas text was free prose |
| `home.card.research.sourcesKept` | sources kept | StatTile label |
| `home.card.research.claimsChecked` | claims checked | |
| `home.card.research.linkedNotes` | linked notes | |
| `home.card.research.latestClaim` | Latest claim checked | |
| `home.card.research.progress` | Scouting · drafting the note | |
| `home.card.research.meta` | {n, plural, one {# scout} other {# scouts}} · {preset} | |
| `home.card.starting.noSignal` | No signal from hooks yet. Did you run fleetmates-deck init? | |
| `home.card.joinedLate` | Joined mid-voyage: changes before {time} are not counted. | |
| `home.card.loadError` | This session could not be loaded. | + Retry |
| `home.quiet.stale.line` | Adrift since {time}: no activity since then. | |
| `home.quiet.stale.openTool` | Still inside {tool}: {summary} | |
| `home.quiet.idle.line` | Last turn ended at {time}. Waiting for the next order. | |
| `home.quiet.reviewed.line` | Reviewed at {time}. Leaves the grid at midnight. | |
| `home.quiet.openTerminal` | Open terminal | |
| `home.quiet.nudge` | Nudge (send Enter) | |
| `home.quiet.open` | Open | |
| `home.quiet.stop` | Stop… | |
| `home.quiet.strip.more` | +{n} more | |
| `home.quiet.strip.label` | Quiet sessions | sr-only h2 |
| `home.grid.label` | Active sessions | sr-only h2 |
| `home.grid.loading` | Loading sessions | sr-only |
| `home.stop.title` | Stop {repo} · {task}? | Dialog |
| `home.stop.body` | The process gets SIGTERM, then SIGKILL after 5 s. Uncommitted changes stay in the working tree. | |
| `home.stop.confirm` | Stop session | |
| `home.stop.cancel` | Cancel | |
| `home.compact.observed` | Observed · from hooks | |
| `home.compact.team.ask` | task {taskId} {summary} | joined by MetaLine |
| `home.compact.reply` | Reply | |
| `home.compact.review` | Review | destructive strip |
| `home.calm.headline` | Calm seas. No ships out. | |
| `home.calm.subtitle.day` | {weekday} {dayPart} | MetaLine item 1 |
| `home.calm.subtitle.state` | nothing running, nothing adrift | item 2 |
| `home.calm.subtitle.rest` | the crew is resting | item 3 |
| `home.calm.dayPart.morning` | morning | |
| `home.calm.dayPart.afternoon` | afternoon | |
| `home.calm.dayPart.evening` | evening | |
| `home.calm.dayPart.night` | night | |
| `home.calm.firstUse` | No ships yet. Launch one, or start claude in a terminal and it shows up here. | |
| `home.calm.log.title` | Captain's log · today | |
| `home.calm.log.openLoops` | Open loops before tomorrow | |
| `home.calm.log.waitsForReview` | {repo} waits in port for review | |
| `home.calm.log.review` | Review | |
| `home.calm.log.empty` | No open loops. | |
| `home.calm.charts.title` | Charts added to your vault | |
| `home.calm.charts.meta` | from {repo} · {domain} · {time} | MetaLine |
| `home.calm.charts.open` | Open Memory | |
| `home.calm.charts.empty` | Nothing new in your vault today. | |
| `home.calm.charts.down` | Your vault is not reachable right now. | + Retry |
| `home.calm.meeting.title` | Last meeting | |
| `home.calm.meeting.meta` | {day} {time} · {duration} · {n, plural, one {# action item} other {# action items}} | |
| `home.calm.meeting.launch` | Launch as session | |
| `home.calm.meeting.empty` | No meetings today. | |
| `home.calm.questions.title` | Unanswered questions | |
| `home.calm.questions.research` | Research this | |
| `home.calm.harbors` | Recent harbors | |
| `home.calm.launch` | Launch a ship | |
| `home.calm.adrift.headline` | {n, plural, one {One ship adrift} other {# ships adrift}} | only if HOME-O1 picks the adrift variant |
| `home.header.counts.label` | Session counts |  |
| `empty.home.title` | Calm seas. No ships out. |  |
| `empty.home.body` | No ships yet. Launch one, or start claude in a terminal and it shows up here. |  |
| `home.card.untitled` | Untitled |  |
| `home.card.crashed.title` | {repo} ran aground |  |
| `home.card.crashed.exit` | The session exited with code {code}. |  |
| `home.card.crashed.killed` | The process ran out of memory or was killed by the system. |  |
| `home.card.crashed.signal` | The session was stopped by signal {signal}. |  |
| `home.card.crashed.lost` | The deck lost track of this process. It may have been closed outside the deck. |  |
| `home.card.activity.tool` | Using {tool} |  |
| `home.quiet.deckdDown` | deckd is reconnecting |  |
| `tier.safe` | Safe |  |
| `tier.caution` | Caution |  |
| `tier.destructive` | Destructive |  |
| `tier.question` | Question |  |
| `home.stop.failed` | Could not stop {repo}: {message} |  |
| `home.quiet.strip.name` | {repo} · {task}, {state} |  |
| `home.card.team.ask` | task {taskId} · {summary} |  |
| `home.card.team.moreRequests` | +{n} more |  |

As built in 0.4.0 (`hub/web/src/screens/home/Home.jsx`, M4 Task 15): the four `home.calm.meeting.*` strings of `HOME_COPY` are in the table above verbatim (checked for 0.4.0 with a script that reads `HOME_COPY` and looks for each string in this deck). "Last meeting" is the newest `synthesized` meeting that started on the local day, read from `GET /api/meetings` (from disk, so it loads with scribed down), with its first action item that is not dismissed; "Launch as session" opens `/new?task=` with the raw item text. The title and the item text render through `titleText` inside `<bdi>` with `lang="pt-BR"` (M4-T17-F2, fixed by M4 Task 19). Without a synthesized meeting today the section says "No meetings today.".

As built in M3: every M3 string of `HOME_COPY`, `CARD_COPY` and `COMPACT_COPY` is in the table above; the session archive strings (`home.archive.*`, `home.archived.*`, `archive.toast.*`, `home.card.archive`) belong to the session archive ([archive.md](../archive.md)), which quotes some of them and is outside this copy deck. The rule-added toast's Undo revokes with `?undo=1`, so the server records it as an undo. After a Deny, a Home card does not offer the 30 s "Tell Claude what to do instead" field; the drawer does (the M3 plan did not ask for it on cards).

## 10. Acceptance criteria

Fixtures are defined in [README.md](README.md) section 4.

1. **Given** fixture `busy` at 1920 x 1080, **when** Home loads, **then** the main grid shows 6 `article` cards in this order: fleetmates team, rustot, discord-audit, research, andreymudri.com, vault-mcp; and the quiet row shows rustot-client, turbidassist, axios-like; and nothing scrolls.
2. **Given** `busy`, **then** the header chips read "3 need you", "2 running", "1 to review", **and** the Rail Sessions badge reads "3", **and** after opening the drawer its subtitle starts with "4 requests from 3 ships".
3. **Given** `busy`, **when** a new permission request is pushed for andreymudri.com, **then** within 1s its card becomes the `approval` variant, moves ahead of the research card after the pointer leaves the grid, the "need you" chip reads "4 need you" and the Rail badge "4" in the same animation frame.
4. **Given** `busy` with the pointer over the rustot card, **when** a reorder-causing event arrives, **then** no card moves until the pointer leaves the grid or 5s pass.
5. **Given** the rustot card, **when** the user clicks "Allow once", **then** `POST /api/requests/:id/answer` is sent with `choice: 'allow'`, the button shows a spinner and keeps its label, the other button is disabled, and on `request.closed` the request box leaves and the pill becomes "Running".
6. **Given** the answer times out (`did_not_land`), **then** the box shows "Your answer did not reach rustot. The prompt is still open in its terminal." and a "Try again" button.
7. **Given** a Destructive request on a card, **then** the card has no "Allow once" button, only "Review in Needs you".
8. **Given** an observed session with an open request, **then** its card shows "Answer in your terminal" and no Allow, Deny, Nudge or Stop buttons.
9. **Given** fixture `calm`, **when** Home loads, **then** the h1 reads "Calm seas. No ships out.", the "Launch a ship" button shows `Alt N`, and no session card is rendered.
10. **Given** `calm`, **when** a session enters `running`, **then** Home switches to the grid and the h1 reads "Sessions".
11. **Given** fixture `crowded12` (12 sessions: 5 needs or running, 2 done, 3 idle, 1 reviewed, 1 stale), **then** the quiet area renders a QuietStrip with 7 chips in the order stale, done, done, idle, idle, idle, reviewed, and the main grid has 5 cards.
12. **Given** `crowded12`, **when** sessions end until 9 remain, **then** the layout stays crowded; at 8 it returns to normal mode.
13. **Given** the density is switched to Compact, **when** the page reloads, **then** Compact is still selected and the grid is 3 x 3.
14. **Given** `busy` at 1280 x 800, **then** the grid has 2 columns, the fleet section scrolls vertically, the header does not, and no horizontal scrollbar exists on the page.
15. **Given** fixture `deckdDown`, **then** the connection banner shows "(attempt 3, next in 4s)" counting down each second, every Allow once, Deny, Reply, Nudge and Stop button is disabled with visible text "deckd is reconnecting", and pills keep updating when hook events arrive.
16. **Given** `busy`, **when** pressing `Alt 2`, **then** the route becomes `/s/<rustot session id>`.
17. **Given** any card text containing `<img src=x onerror=alert(1)>`, **then** it renders as literal text and no `img` element exists in the card.
18. **Given** `busy` with reduced motion, **then** no element has a running CSS animation and needs-you cards show the static inset ring.
19. **Given** the team card, **then** tiles read "lead · T6", "T3 · done", "T4 · needs you", "T5 · needs you" and "Review 2" opens the drawer with focus on the T4 request.

## 11. Known gaps vs data reality

| Id | Gap | Status and default |
|---|---|---|
| HOME-O1 | Calm with a stale session: components.md says calm only when nothing is adrift; decisions and design-system 12.3 describe a calm-style headline "One ship adrift". | **Open**. Default: stale keeps calm off (grid shows). |
| HOME-O2 | Phase names "Plan, Build, Verify, Integrate" do not exist in fleetmates; phases are numbers from `assignPhases` and gates are keyed by phase number (fleetmates contract 2, 3, 5). | **Open**. Default: "Phase 1", "Phase 2"... with the task range as the sub label. |
| HOME-O3 | Calm open loops "axios-like merged, not pushed" and "run merged, PR not opened" need git and forge data the domain does not have. | **Open**. Default: only `done` sessions appear as open loops. |
| HOME-O4 | Research card stats, latest claim and progress percent depend on the research run output contract (SM-O15). | **Open**. Default: stats hidden, ProgressBar `indeterminate` with "Scouting". |
| HOME-O5 | Team card title: fleetmates has no run title; the canvas title is the plan's heading. | **Open**. Default: the lead session's `task`; else the plan file's first H1; else the run id. |
| HOME-O6 | Done card summary lines on the canvas ("18 tests added, 1,240 passing") are not derivable from hooks or git. | Proposed: done cards show the same last 3 steps as other cards plus "{n} files changed · +a −d" from `changedFiles`. |
| HOME-O7 | Crowding thresholds (10 sessions, more than 3 quiet, hysteresis at 8) are not owner decisions; only "10+" is (D-18). | Proposed. |
| HOME-O8 | "Launch as session" from a meeting action item (Q6). | **Open** (shared with MEET-O6). |
| HOME-O9 | Themed launch button "Launch a ship" (design-system 15.1). | **Open**. |

## 12. Changes from the canvas

1. "4 running" becomes "2 running" for the same data. The chips are disjoint session counts (02-domain section 3): the team card counts once under "need you", so only the research session and andreymudri.com are running. The canvas "4" did not match its own cards.
2. Team tiles use fleetmates task ids ("T4 · needs you"), not "task 4"; teammate names `fm-t1..t3` were illustrative (02-domain 4).
3. Phase labels become "Phase N" until HOME-O2 is decided.
4. Quiet stale line: "Adrift since 17:40: no commits and no file changes in its worktree." claims facts the deck does not measure for plain sessions; it becomes "Adrift since 17:40: no activity since then." plus the open tool when known.
5. Quiet reviewed line: "Merged into main. Leaves the grid at end of day." claims a merge the deck does not know; it becomes "Reviewed at 15:20. Leaves the grid at midnight."
6. Quiet "Nudge" becomes "Nudge (send Enter)"; quiet "Stop" becomes "Stop…" (a confirm follows).
7. "Launch a ship" shows `Alt N` on Home too (keyboard.md 4).
8. Compact "Done · to review" pill becomes "Done" (literal pill); "to review" is carried by the header chip. Compact "ASK" badge becomes the `question` TierBadge ("Question").
9. Destructive requests on cards never show Allow; "Review in Needs you" replaces it (state-machines 2.5).
10. Calm capture dots use the vault domain color map (design-system 3.6).
11. Running pill background and every raw value follow tokens (design-system 14).
12. Crowded mode (QuietStrip) is new; the canvas only drew the 9-session case.
13. Research card intro sentence becomes a template with the topic; stats hidden until SM-O15.
