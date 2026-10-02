# Command palette

| | |
|---|---|
| Canvas board | `Palette` (Command palette, Alt K) over Home |
| Route | none: global overlay on every route (Proposed) |
| Milestone | M1 (Needs you and Sessions groups, jump to session). M2 adds Actions (launch). M3 adds answering from Needs you rows. M5 adds Memory group and `?` ask. M6 adds `> research`. |
| Status | Decided (canvas layout, group order), Proposed (states, behaviour per milestone) |

## 1. Purpose

Answers **"Where is the thing I want, and can I act on it without leaving the keyboard?"**: jump to a session, answer the most urgent request, launch in a repo, open a note, ask the vault, start research. Urgency first: Needs you, Sessions, Actions, Memory (Decided).

## 2. Route and entry points

| Entry | Result |
|---|---|
| `Alt K` anywhere, including inside a terminal (keyboard.md 2) | opens with an empty query |
| Home search trigger "Search, ask or run" | opens with an empty query |
| QuietStrip "+N more" | opens with the Sessions group only (Proposed) |
| `Alt K` while open | moves selection up (keyboard.md 3), never closes |

The palette is not a route: opening it does not change the URL, and Back closes it (Proposed: push a history state on open so browser Back closes the overlay instead of leaving the page).

## 3. Layout

| Region | Component / token | Notes |
|---|---|---|
| Scrim | `--overlay-scrim` | over the current screen |
| Shell | Palette (Dialog shell), width `--layout-dialog`, top 150px, `--radius-2xl`, `--z-palette` | horizontally centred |
| Input row | borderless Field (palette variant), Icon `search`, right hint | hint "? ask · > run" |
| Results | grouped ListRow `role="option"`, max height 60vh, scrolls | group headers Eyebrow in group tone |
| Footer | `type.meta` hints | |

Width behaviour: identical at 1920, 1440 and 1280 (700px fixed, design-system 8.3). At heights under 800 the results max height stays 60vh; the footer never scrolls away.

## 4. Content inventory

| Element | Component | Data binding | Copy (EN) | Notes |
|---|---|---|---|---|
| Input | Field palette variant, `role="combobox"` | `query` | sr-only label "Search, ask or run" | autofocus on open |
| Prefix hint | text `type.meta` | none | "? ask · > run" | changes to "Asking your vault" in `?` mode and "Running a command" in `>` mode (Proposed) |
| Group header "Needs you" | Eyebrow tone `state.needs-approval.fg` | open requests (`request.state = open`) matching query | "Needs you" | first group |
| Needs row | ListRow: CrewAvatar sm (needs), title, subtitle, trailing Kbd | `repo.name`, `request.summary`, `request.tier`, waiting time from `createdAt` | title "rustot · Allow cargo test --release combat::", subtitle "Safe · test · waiting 3m", trailing "Enter" on the highlighted row | only Safe rows on a PTY session start with "Allow" (`palette.needs.allow.title`); Caution rows use `palette.needs.title` ("rustot · npm install commander@14"), because Enter opens them (D-85); question rows: title "discord-audit · Reply: Should logs…", destructive rows: "git push --force… · Review in Needs you" |
| Group header "Sessions" | Eyebrow tone `state.running.fg` | sessions not `ended`, urgency order (home.md 7.3) | "Sessions" | |
| Session row | ListRow: CrewAvatar sm, title, StatePill `text` as subtitle, trailing Kbd | `repo.name · session.branch` or `repo.name · session.task`; `session.state`; index in urgency order | "rustot · combat-tick", "Needs approval", "Alt 2" | Kbd only for positions 1 to 9 |
| Group header "Actions" | Eyebrow tone `text.link` | static list + query-derived | "Actions" | |
| Action rows | ListRow with glyph tile | see 4.1 | "Launch a ship in rustot" / "Recent harbor"; "Research \"rust ECS for combat ticks\"" / "Opens the research form" | |
| Group header "Memory" | Eyebrow tone `state.done.fg` | vault notes (M5) | "Memory" | |
| Note row | ListRow with glyph tile "md" | `vault_search` hits: path, title, domain; link count from `vault_graph` degree when available | "rustot.md" / "03-projects · 6 links" | |
| Ask row | ListRow with glyph tile "?" | query | "Ask your vault: \"rus…\"" / "Starts a thread in Memory" | no Kbd (canvas `Alt ?` removed, keyboard.md has no such chord) |
| Footer | text | none | "Up, Down or Alt J, Alt K move", "Enter run", "Alt Enter open in Focus", "Esc close" | |

### 4.1 Actions list (Proposed)

| Row | Shows when | Result |
|---|---|---|
| Launch a ship in {repo} | query matches a known repo name, or empty query (top 3 recent harbors) | new-session form with repo preselected |
| Launch a ship | always in empty query | new-session form |
| Research "{query}" | query is 3+ characters and not a session or repo exact match (M6) | research form with Topic prefilled |
| Open Memory, Open Meetings, Open Settings | query matches the word | route |
| Mark {repo} · {task} reviewed | a `done` session matches | `U.MarkReviewed` |

### 4.2 Prefix modes

| Prefix | Mode | Groups shown | Enter does |
|---|---|---|---|
| none | search | Needs you, Sessions, Actions, Memory | runs the highlighted row |
| `?` | ask (M5) | a single row "Ask your vault: \"…\"" plus Memory notes | opens Memory with a new thread and asks (state-machines 8, `U.Ask`) |
| `>` | command | commands matching: `research <topic>` (M6), `launch <repo>` (M2) | runs the command; an unknown command shows "No command named \"x\". Try research or launch." |

## 5. States

| State | What shows |
|---|---|
| Empty query | Needs you (all open requests), Sessions (all, urgency order), Actions (Launch a ship + 3 recent harbors). No Memory group. |
| Typing | groups filter per keystroke (fuzzy match on repo, task, branch, summary; Proposed: substring and word-prefix match, no heavy fuzzy library needed) |
| Loading memory results (M5) | Memory group shows one muted row "Searching notes…"; other groups render immediately; `vault_search` debounced 150ms (Proposed) |
| No results | single muted row "No matches. Press Enter to ask your vault." when `?` asking is available; before M5: "No matches." |
| vault-mcp down | Memory group replaced by one muted row "Memory is unavailable: vault-mcp is not answering." and no ask row (state-machines 5.4) |
| deckd down | Needs rows keep showing; Enter on a Needs row opens the drawer on it instead of answering; subtitle adds "deckd is reconnecting" |
| Server link lost | palette still opens with cached data; answering rows disabled (same rule as Home) |
| Overflow: many requests or sessions | each group shows at most 5 rows, then a row "Show all {n} sessions" that expands the group in place (Proposed). The Needs group never truncates below 5. |
| Long titles | one line, ellipsis; full text in the option's accessible name |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| Type | filters; first row of the first non-empty group is highlighted | client |
| Up / Down, Alt J / Alt K (while open) | move highlight across groups, wrapping | client (keyboard.md 3) |
| Enter on a Safe Needs row (M3) | Enter on a Safe Needs row allows once; the row shows a spinner, then the palette closes and a toast confirms "Allowed cargo test in rustot" (D-85) | `U.Allow` (state-machines 2.7) |
| Enter on a Caution Needs row (M3) | opens the request: the drawer focused on it, or Focus for an observed session; nothing is answered (D-85) | UI |
| Enter on a Needs row before M3, or observed session | opens Focus on that session | route |
| Enter on a Destructive Needs row | opens the drawer on that request (never approves from the palette, state-machines 2.5) | UI |
| Enter on a Question row | opens the drawer with the reply field focused | UI |
| Enter on a Session row | Focus on that session | route `/s/:id` |
| Alt Enter on any session or Needs row | Focus on that session with the terminal focused | route |
| Enter on Launch rows | new-session form | route `/new?repo=` |
| Enter on Research row | research form prefilled | route `/research/new?topic=` |
| Enter on a note row | note panel in Memory | route `/memory/note/<path>` |
| Enter on Ask row | Memory with a new thread, question sent | route `/memory?thread=new` + `U.Ask` |
| Esc, click on scrim, browser Back | close; focus returns to the element that opened it | client |

## 7. Real-time updates

- `request.opened` / `request.closed` update the Needs group while the palette is open. A row that disappears while highlighted moves the highlight to the next row, never to a different group's first row silently: the palette announces "Request answered elsewhere" politely (Proposed).
- `session.state` updates subtitles; rows do not reorder while the palette is open (a stable list while typing), only on the next open (Proposed).
- No animations other than the open (160ms) and close (100ms) transitions (design-system 10.4); selection moves instantly.

## 8. Accessibility

- Combobox pattern (components Palette): input `role="combobox"`, `aria-expanded`, `aria-controls` the listbox, `aria-activedescendant` the highlighted option; groups are `role="group"` with `aria-labelledby` their Eyebrow.
- Result count announced politely after typing settles (300ms): "7 results".
- Kbd hints are `aria-hidden` inside options; the option name carries the meaning ("rustot · combat-tick, Needs approval").
- Focus trap while open; initial focus on the input; on close, focus returns to the trigger.
- Needs rows name the tier in words ("Safe"), never color only.

## 9. Copy deck

| Key | EN |
|---|---|
| `palette.input.label` | Search, ask or run |
| `palette.hint.default` | ? ask · > run |
| `palette.hint.ask` | Asking your vault |
| `palette.hint.command` | Running a command |
| `palette.group.needs` | Needs you |
| `palette.group.sessions` | Sessions |
| `palette.group.actions` | Actions |
| `palette.group.memory` | Memory |
| `palette.needs.allow.title` | {repo} · Allow {summary} |
| `palette.needs.question.title` | {repo} · Reply: {summary} |
| `palette.needs.destructive.title` | {repo} · {summary} · Review in Needs you |
| `palette.needs.subtitle` | {tier} · {toolLabel} · waiting {duration} |
| `palette.action.launchIn` | Launch a ship in {repo} |
| `palette.action.launchIn.sub` | Recent harbor |
| `palette.action.launch` | Launch a ship |
| `palette.action.research` | Research "{query}" |
| `palette.action.research.sub` | Opens the research form |
| `palette.action.markReviewed` | Mark {repo} · {task} reviewed |
| `palette.action.open` | Open {section} |
| `palette.memory.note.sub` | {folder} · {n, plural, one {# link} other {# links}} |
| `palette.memory.ask` | Ask your vault: "{query}" |
| `palette.memory.ask.sub` | Starts a thread in Memory |
| `palette.memory.searching` | Searching notes… |
| `palette.memory.down` | Memory is unavailable: vault-mcp is not answering. |
| `palette.empty.ask` | No matches. Press Enter to ask your vault. |
| `palette.empty` | No matches. |
| `palette.command.unknown` | No command named "{name}". Try research or launch. |
| `palette.group.showAll` | Show all {n} {group} |
| `palette.results` | {n, plural, one {# result} other {# results}} |
| `palette.answeredElsewhere` | Request answered elsewhere |
| `palette.allowed.toast` | Allowed {summary} in {repo} |
| `palette.footer.move` | Up, Down or Alt J, Alt K move |
| `palette.footer.run` | Enter run |
| `palette.footer.focus` | Alt Enter open in Focus |
| `palette.footer.close` | Esc close |
| `palette.needs.title` | {repo} · {summary} |
| `palette.needs.waiting` | waiting {duration} |
| `palette.needs.answerInTerminal` | Answer in your terminal |
| `palette.session.title` | {repo} · {detail} |
| `palette.group.showAll.needs` | requests |
| `palette.group.showAll.sessions` | sessions |
| `palette.group.showAll.actions` | actions |
| `empty.palette.title` | No matches. |

The three `palette.group.showAll.*` words fill the `{group}` of `palette.group.showAll`.
`empty.palette.title` lives in `EMPTY_COPY` (`hub/web/src/components/EmptyState.jsx`), shown when
the palette has no row and no message.

## 10. Acceptance criteria

1. **Given** fixture `busy` on Home, **when** pressing `Alt K`, **then** a `role="dialog"` with a focused combobox appears within 160ms and the first option is the rustot request.
2. **Given** the palette open with query "rus", **then** groups appear in the order Needs you, Sessions, Actions, Memory and the Sessions rows read "rustot · combat-tick" with "Alt 2" and "rustot-client · ui/inventory" with its urgency position.
3. **Given** focus inside a Focus terminal, **when** pressing `Alt K`, **then** the palette opens and the terminal receives no bytes.
4. **Given** the palette open, **when** pressing `Alt K` again, **then** the highlight moves up one row and the palette stays open.
5. **Given** a Safe Needs row highlighted (M3), **when** pressing Enter, **then** Enter on a Safe Needs row allows once: `U.Allow` is sent for that request id and the palette closes after `request.closed`. **Given** a Caution Needs row highlighted, **when** pressing Enter, **then** no answer is sent and the request opens (the drawer focused on it, or Focus for an observed session) (D-85).
6. **Given** a Destructive Needs row highlighted, **when** pressing Enter, **then** no answer is sent and the drawer opens focused on that request.
7. **Given** the query "?how do retries work", **then** only the Ask row and Memory notes are shown and Enter navigates to `/memory` with a thread whose first user message is "how do retries work".
8. **Given** fixture `vaultDown`, **when** typing, **then** the Memory group shows "Memory is unavailable: vault-mcp is not answering." and no Ask row.
9. **Given** the palette open, **when** pressing Esc, **then** it closes and focus returns to the search trigger.
10. **Given** 15 sessions, **then** the Sessions group shows 5 rows and "Show all 15 sessions"; only the first 9 in urgency order carry an `Alt N` Kbd.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| PAL-O1 | Note rows' "6 links" needs `vault_graph` degree, which is a proposal not yet in vault-mcp v0.3.0. | **Open**. Default: show the folder only until `vault_graph` exists. |
| PAL-O2 | Fuzzy matching algorithm not specified by the canvas. | Proposed: substring plus word-prefix, case and accent insensitive. |
| PAL-O3 | Whether Enter on a Safe Needs row should approve (fast) or open (safe). Tier rules allow the palette as a surface for Safe and Caution. | **Decided** 2026-10-02 (D-85). Enter approves Safe only, and only Safe row titles start with the verb "Allow"; on a Caution row Enter opens the request (the drawer, or Focus for an observed session); Destructive is never answered from the palette. |

## 12. Changes from the canvas

1. The Memory "Ask your vault" row loses its `Alt ?` Kbd (no such chord in keyboard.md; `?` prefix is the way).
2. Footer "Alt J/K move" becomes "Up, Down or Alt J, Alt K move" (chords with spaces, keyboard.md 4).
3. "Alt Enter open in focus" becomes "Alt Enter open in Focus" (screen name capitalised).
4. Selected row background uses `bg.selected` (design-system 14: `#2b2f45` to the shared selected color).
5. Empty, loading, no-results, degraded and overflow states are new.
