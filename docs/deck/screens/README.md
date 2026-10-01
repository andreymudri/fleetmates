# Screen specs (developer handoff)

Per-screen handoff for the fleetmates deck UI (React + Vite, JavaScript with JSDoc, Node 24 server, `deckd` owning PTYs). Written for a developer or a Claude Code agent building the screens from the reviewed canvas.

Read first: [02-domain.md](../02-domain.md) (entities, `SessionState`, pill labels, counting rules), [interaction/keyboard.md](../interaction/keyboard.md) (the keyboard map; it overrides the canvas), [interaction/state-machines.md](../interaction/state-machines.md) (what each state shows), [design/components.md](../design/components.md), [design/design-system.md](../design/design-system.md), [design/tokens.css](../design/tokens.css), [design/crew.md](../design/crew.md). Verify the build with [../qa/qa-checklist.md](../qa/qa-checklist.md).

Status labels: **Decided**, **Proposed**, **Open**, as defined in 02-domain.

## 1. Index

| Screen | Spec | Canvas board(s) | Route | Milestone | Status |
|---|---|---|---|---|---|
| Home (comfortable, compact, calm, quiet row and crowding) | [home.md](home.md) | `Home`, `HomeCompact`, `HomeCalm` | `/` | M1 (compact M2, inline answers M3) | Decided canvas; crowding strip Proposed; 9 Open items |
| Command palette | [palette.md](palette.md) | `Palette` | overlay (no route) | M1 (groups grow M2, M3, M5, M6) | Decided canvas; states Proposed |
| Needs-you drawer | [needs-you-drawer.md](needs-you-drawer.md) | `Approvals` | overlay, `?needs=` deep link | M1 read-only, M3 answering | Decided canvas and tier rules |
| Focus | [focus.md](focus.md) | `Focus` | `/s/:sessionId` | M2 (PromptBar and diff M3, Memory tab M5) | Decided canvas; Facts tab Proposed |
| Team run | [team-run.md](team-run.md) | `Team` | `/runs/:repoKey/*runId` | M2 (answering M3) | Decided layout; data mapping Proposed; 8 Open items |
| Failures, loading, empty, error patterns | [failures-and-loading.md](failures-and-loading.md) | `Failures` | none (patterns) | M1 (vault M5, scribed M4) | Decided specimens; catalogue Proposed |
| Memory | [memory.md](memory.md) | `MemoryV1`, `MemoryNote` | `/memory`, `/memory/note/*` | M5 | Decided canvas; UI to be revisited (Open) |
| Research | [research.md](research.md) | `ResearchForm`, `ResearchReview` | `/research/new`, `/research/:id` | M6 | Decided flow; depends on Open contracts |
| Meetings | [meetings.md](meetings.md) | `Meetings`, `MeetingLive` | `/meetings`, `/meetings/:id`, `/meetings/live` | M4 | Decided canvas; 11 Open items vs TurbidAssist data |
| Settings | [settings.md](settings.md) | `Settings` | `/settings/:section` | M1 (Notifications, Connections), M2 (Appearance), M3 (Approval rules) | Approval rules Decided; other sections Proposed |
| First run | [first-run.md](first-run.md) | `FirstRun` | `/welcome` | M1 | Decided |
| New session (launch form) | [new-session.md](new-session.md) | not on the canvas | `/new` | M2 | **Proposed** |
| App shell, Rail, rec bar, toasts | [rail-and-shell.md](rail-and-shell.md) | `Rail`, shell of every board | all | M1 (rec bar M4) | Decided Rail; routing and toasts Proposed |
| Crew sheet | [crew-sheet.md](crew-sheet.md) | `CrewSheet`, `Crew` | `/settings/crew` | M1 avatars, M2 page | Decided rules; swatches Open |

## 2. Route map (hash-free SPA, Proposed)

| Route | Screen |
|---|---|
| `/` | Home |
| `/new` | New session dialog over the previous route |
| `/s/:sessionId` | Focus |
| `/runs/:repoKey/*runId` | Team run (`runId` may nest) |
| `/memory` | Memory (`view`, `thread` query) |
| `/memory/note/*` | Memory with a note (vault-relative path) |
| `/research/new` | Research form over the previous route |
| `/research/:id` | Research review or running view |
| `/meetings` | Meetings list |
| `/meetings/:id` | Meeting detail |
| `/meetings/live` | Live meeting |
| `/settings/:section` | Settings (`appearance`, `rules`, `notifications`, `connections`, `crew`) |
| `/welcome` | First run |

Details (history fallback, token fragment, overlays and Back) are in [rail-and-shell.md](rail-and-shell.md) section 2. `repoKey` is the displayed repo name, URL-encoded; the server resolves it to `repo.id`.

## 3. Conventions used by every spec

- **Section layout** of each spec: purpose, route and entry points, layout (1920, 1440, 1280), content inventory, states (loading, empty, degraded, error, overflow, populated), interactions, real-time updates, accessibility, copy deck, acceptance criteria, known gaps (Open), changes from the canvas.
- **Components and tokens** are named, never restyled. A spec never states a hex value, a pixel size that a token covers, or a font; if a value is missing from tokens, the spec says "new token needed".
- **Counts** (needs you, running, to review, requests) come from one server `counts` object produced by one query; the Rail badge, Home chips, drawer subtitle, Team pill numerators and document title all read it (02-domain 3).
- **Urgency order** (Home grid, Focus list, Palette, `Alt 1..9`) is computed once server-side ([home.md](home.md) 7.3).
- **Untrusted text** (agent output, task, command, path, note, transcript, URL) renders as text nodes only; markdown goes through the sanitising renderer (design-system 11.13).
- **Pills are literal** (02-domain 3); themed words only in headlines and subtitles.
- **Server events and REST paths** named in the specs are Proposed (SHELL-O1). The state-machine event (`U.Allow`, `SC.status`, ...) in each interactions table is the behavioural contract.
- **New components** introduced by these specs, to add to components.md: `QuietStrip` / quiet chip ([home.md](home.md) 5.6), PromptBar question variant ([focus.md](focus.md) 4.3), TaskRow extra states ([team-run.md](team-run.md) 4.3.2).

## 4. Test fixtures (Proposed)

Playwright runs against the web server started with a fixture adapter (fake hook events, fake deckd, stub vault-mcp, stub scribed, fixture filesystem). Every acceptance criterion names one of these.

| Fixture | Content |
|---|---|
| `busy` | The canvas Home data: fleetmates run (lead needs approval with T4 Caution and T5 Safe requests), rustot needs approval (Safe `cargo test --release combat::`, rule suggestion offered), discord-audit asked you, research running, andreymudri.com running, vault-mcp done, rustot-client stale 22m, turbidassist idle 1h, axios-like reviewed. Counts: 3 need you, 2 running, 1 to review, 4 requests (disjoint session counts). |
| `calm` | Only vault-mcp done, turbidassist idle, axios-like reviewed; recap 9 / 3 / 1; one synthesized meeting today with 3 action items; one unresolved miss. |
| `crowded12` | 12 sessions: 5 in needs or running states, 2 done, 3 idle, 1 reviewed, 1 stale. |
| `destructive` | One Destructive request (`git push --force origin ui/inventory`). |
| `team` | The canvas run: 9 tasks, 4 phases, gate 1 PASS recorded 13:02, derived phase 2. |
| `deckdDown` | `busy` with deckd unreachable at attempt 3. |
| `vaultDown` | vault-mcp spawn exits 1 with `VAULT_PATH is not a directory`. |
| `scribedDown` | no socket at `$XDG_RUNTIME_DIR/turbidassist.sock`; five past sessions on disk. |
| `vault22` | The canvas 22 notes and 34 links, served by a stub `vault_graph`. |
| `researchDrafted` | The canvas draft with 5 sources and 1 rejected, preview with 3 files. |
| `meetings5` | The canvas five meetings, synthesized notes, `config.yaml` with tags `pessoal` (default), `client-a`, `client-b` (last two confidential). |
| `recording` | `meetings5` plus a live recording (tag `client-a`) with the canvas transcript lines. |
| `rules5` | The canvas 5 rules in 3 repos, as real `.claude/settings.local.json` files. |
| `firstRunHooksMissing` | First run with hooks missing, scribed missing, notifications untested, other checks ok. |

## 5. Open items raised by these specs

Existing ids from other docs (SM-O*, design-system 15.*, crew.md 12) are referenced, not repeated.

| Id | Question | Default until decided | Spec |
|---|---|---|---|
| HOME-O1 | Calm with a stale session: calm layout with an "One ship adrift" headline, or grid? | Grid | home |
| HOME-O2 / TEAM-O1 | Phase names do not exist in fleetmates | "Phase N" | home, team-run |
| HOME-O3 | Calm open loops needing git and forge data (not pushed, PR not opened) | Only `done` sessions | home |
| HOME-O4 / RES-O1 | Research run output contract (stats, progress, draft location), SM-O15 | Indeterminate progress, no stats | home, research |
| HOME-O5 | Team card and Team page title source | Lead task, else plan H1, else run id | home, team-run |
| HOME-O8 / MEET-O6 | "Launch as session" from meeting action items | Opens new-session form prefilled | home, meetings |
| HOME-O9, NEW-O3, RES-O7, FR-O4 | Themed launch buttons (design-system 15.1) | Keep canvas labels | several |
| PAL-O1 | Note link counts need `vault_graph` | Folder only | palette |
| DRW-O1 | Destructive confirm label with a computed consequence | Generic "I checked what this command will change" | needs-you-drawer |
| TEAM-O2 | Gate check sentence not stored in `status.gates` | Verdict and time only | team-run |
| TEAM-O3 | Run elapsed time source | Lead `startedAt`, else earliest task | team-run |
| TEAM-O4 | Gate "checking" not observable | Never shown | team-run |
| TEAM-O5 | "Open plan" target | Read-only markdown drawer | team-run |
| TEAM-O6 | Teammate terminals: only tool steps are attributable | Tool steps + note | team-run |
| FAIL-O1 / MEET-O10 / FR-O2 | "Start scribed" (no systemd unit), SM-O13 | `systemd-run --user` running a login shell (`$SHELL -l -c 'exec scribed'`) (OPS-O1) | failures, meetings, first-run |
| FAIL-O2 | Connection banner wording (design-system 15.4) | Canvas copy | failures |
| MEM-O1 | `vault_graph` not in vault-mcp v0.3.0 | Browse by MOC works; graph tab explains | memory |
| MEM-O2 | Misses log storage | Deck SQLite | memory |
| MEM-O3 | Definition of captures and "new" notes | `criado` today or observed `vault_learn` | memory, home |
| MEM-O4 | Revert for captures | Not in v1 | memory |
| MEM-O5 | Obsidian vault name | Basename of `VAULT_PATH`, overridable | memory, settings |
| MEM-O8 | Memory UI to be revisited with the owner | Canvas as specified | memory |
| RES-O2 | Draft frontmatter (`status: draft`, `source: research`) not writable by `vault_learn` | Preview shows what will be written | research |
| RES-O3 | `vault_learn` `preview` not in vault-mcp yet | No save without preview | research |
| RES-O4 | Preset sizes | Canvas numbers | research |
| RES-O5 | New linked note (Decided) vs `vault_learn` append decision | Show the preview decision | research |
| RES-O6 | Which repo a research run lives in | To define with M6 | research |
| MEET-O1 | Meeting source label (Teams, Meet, Discord) not persisted | Deck records `routed_apps` while polling | meetings |
| MEET-O2 | Pins not in TurbidAssist | Deck-stored, deck-only | meetings |
| MEET-O3 | Live meeting title | Tag + start time | meetings |
| MEET-O4 | Live ask with vault access (scribed ask has no tools) | scribed ask, transcript only | meetings |
| MEET-O5 | Partial transcript lines | "Listening…" | meetings |
| MEET-O7 | Transcript search for confidential tags without persisting text | On-demand file search, no index | meetings |
| MEET-O8 | "Save answer to meeting note" | No button; asks already recorded by scribed | meetings |
| MEET-O11 | Location of TurbidAssist `config.yaml` and `session_dir` | Settings, Connections path | meetings, settings |
| SET-O1 | Language is an environment variable, not a setting | Read-only row | settings |
| SET-O2 | Storage of deck preferences | Deck SQLite; env wins | settings |
| NEW-O2 | Repo scan depth under `~/dev` | Direct children + repos known from hooks | new-session |
| SHELL-O2 | Below 1280px and zoom (design-system 15.3) | Horizontal scroll | rail-and-shell |
| CREW-O1..O3 | Slot 8, more than nine repos, teammate shades (crew.md 12) | crew.md defaults | crew-sheet |
