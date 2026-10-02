# 14 · Decisions

Status labels as in [02-domain.md](02-domain.md). Section 1 lists the owner's **Decided** choices from the design sessions of 2026-09-26 and 27. Section 2 records the choices the handoff made on its own authority. Those are **Proposed**, and they are logged so they are not reversed silently.

Sources, as tagged in the decision record:

- **explicit**: the owner said it, or picked it in a multiple-choice round.
- **summary**: the only record is the summary of a conversation segment lost to context compaction.
- **canvas**: the value appears on a reviewed canvas board. The question that produced it was lost, but the board is treated as decided design.
- **assistant statement / plan, not contested**: the assistant stated or planned it during design and the owner did not object. Where a row mixes sources, each part is named.

To change a decision, add a new entry that supersedes the old one (never edit an old entry), update the docs listed under "Applied in", and remove any matching row from [15-open-questions.md](15-open-questions.md).

## 1. Owner decisions

### 1.1 Product

| ID | Decision | Source | Rejected alternatives | Applied in |
|---|---|---|---|---|
| D-01 | The product is a **personal agentic hub** named **fleetmates deck**. It is not a generic "agentic OS" and not a memory/RAG layer like claude-os. | explicit | Agentic OS shell; the name "fleetmates hub" | [01-product.md](01-product.md) |
| D-02 | Scope: observe, control and launch parallel Claude Code sessions (including fleetmates team runs); ask the Obsidian vault and run deep research saved back to it; meetings through TurbidAssist. | explicit | Chat-only UI; memory only | [01-product.md](01-product.md) |
| D-03 | The main v1 pain is **losing track of parallel sessions**: which session is doing what, blocked sessions going unnoticed, painful switching. | explicit | "Done work goes unreviewed" and "fast + keyboard-first" were not picked as the main pain | [01-product.md](01-product.md), [screens/home.md](screens/home.md) |
| D-04 | "Enjoyable" means a calm overview, alive and playful, and fitting the desktop. | explicit | n/a | [design/design-system.md](design/design-system.md) |
| D-05 | Users: the owner first, released as open source. Single user, single machine, Linux only (Omarchy/Hyprland). WSL was dropped from v1. No macOS, no mobile in v1. | explicit | Linux + WSL; macOS | [01-product.md](01-product.md) |
| D-06 | Claude Code first, behind an adapter layer so other agents can be added later. | explicit | Multi-agent from day one | [03-architecture.md](03-architecture.md) |
| D-07 | **Public at M1**, so the project can be shown while it is still small. | explicit (pushback accepted) | Public at the end | [12-milestones.md](12-milestones.md), [13-operations.md](13-operations.md) |
| D-08 | M1 is done when the owner uses it as a daily driver for a week: 3+ parallel sessions for a full work week without opening a pane to check status. | explicit | n/a | [12-milestones.md](12-milestones.md), [09-testing.md](09-testing.md) |
| D-09 | No cost tracking in dollars (the subscription is used, with no caps). Show rate-limit state instead. | explicit (no dollars, no caps); assistant plan, not contested (rate-limit state) | Hard cost caps | [15-open-questions.md](15-open-questions.md) Q16 |

### 1.2 Architecture and runtime

| ID | Decision | Source | Rejected alternatives | Applied in |
|---|---|---|---|---|
| D-10 | Process split: `deckd`, a systemd user service, owns every PTY. A separate web server serves the UI and can restart or crash without killing agents. deckd is not reachable from the browser. | explicit | One process | [03-architecture.md](03-architecture.md) |
| D-11 | Started as a systemd user service and opened in a regular browser tab. | explicit | Hyprland keybind; Chromium `--app` window; TUI; native app | [13-operations.md](13-operations.md) |
| D-12 | Stack: server in plain JavaScript (`.mjs`) with JSDoc, Node 24+ (matching fleetmates); frontend React + Vite; SQLite storage. | explicit, summary | TypeScript end to end; Go backend | [03-architecture.md](03-architecture.md), [06-storage.md](06-storage.md) |
| D-13 | Repo shape: a `hub/` folder in the fleetmates repo, as its own npm package. The plugin at the repo root stays untouched. | explicit | Full monorepo restructure (would change how the plugin installs) | [03-architecture.md](03-architecture.md) section 3 |
| D-14 | Observation: user-level Claude Code hooks, installed once in `~/.claude/settings.json` by an init command and merged with fleetmates' own hooks. Every session in every repo is observed. | explicit | Per-repo hooks; tmux scraping | [04-integrations.md](04-integrations.md) section 2.1 |
| D-15 | **Full control everywhere**: the `fm claude` wrapper runs Claude Code in a PTY owned by deckd, mirrored to the terminal and to the browser (xterm.js). "Chat in the UI" in v1 means this real terminal, not a custom chat view. | explicit (wrapper, full control); assistant statement, not contested (terminal as chat) | Control split by origin; tmux injection; custom chat view in v1 | [03-architecture.md](03-architecture.md), [screens/focus.md](screens/focus.md) |
| D-16 | Two inputs on one PTY: **last keystroke wins**, with an indicator of who typed last. | explicit | Explicit take-over; read-only browser | [interaction/state-machines.md](interaction/state-machines.md) section 3 |
| D-17 | The launch form asks only for a repo (from a scan of `~/dev`) and a task. The deck never creates worktrees; the job that needs one creates it. | explicit | Permission mode, model or auto-worktree in the form | [screens/new-session.md](screens/new-session.md) |
| D-18 | Crowding: the grid shows running and needs-you sessions; idle and done sessions collapse into a quiet row or strip. | explicit, canvas | n/a | [screens/home.md](screens/home.md) |
| D-19 | Retention: one summary row per session kept forever (repo, branch, task, outcome, duration, gate result). The event stream and scrollback are dropped after 30 days; the deck links to Claude Code's own transcript instead of copying it. | explicit | Keep everything | [06-storage.md](06-storage.md) |

### 1.3 Integrations

| ID | Decision | Source | Rejected alternatives | Applied in |
|---|---|---|---|---|
| D-20 | fleetmates: the deck reads `.fleetmates/<run-id>/status.json` and reuses fleetmates' digest and liveness logic (stale after 20 minutes) instead of rebuilding it. | summary | Own run parser | [04-integrations.md](04-integrations.md) section 1 |
| D-21 | The deck reaches the vault **only through vault-mcp**, one source of truth shared with the agents. | explicit | Reading the vault directly; a shared package | [10-memory-and-research.md](10-memory-and-research.md) |
| D-22 | **Measure first**: keep BM25 plus the graph, log every question that finds nothing, turn misses into golden queries, and consider hybrid search only if misses pile up. No embeddings or vector DB now. | explicit (pushback accepted) | Hybrid search now; embeddings with Ollama; sqlite-vec | [10-memory-and-research.md](10-memory-and-research.md) section 3 |
| D-23 | Research drafts are reviewed before saving through a dry run of `vault_learn`: `preview: true` returns the diff without writing, and approving repeats the same call without `preview`. | explicit | A new `vault_research` tool; write then git revert | [10-memory-and-research.md](10-memory-and-research.md) section 7 |
| D-25 | The Ask engine is `claude -p` with vault-mcp, on the subscription, with no API key. | summary | Direct API; local model | [10-memory-and-research.md](10-memory-and-research.md) section 2 |
| D-26 | Deep research runs as a fleetmates team, shown as a session on the board. It starts from the palette or the Memory tab with the same form, and has Quick, Standard and Deep presets (more depth means more teammates and sources). | explicit | A separate research engine | [10-memory-and-research.md](10-memory-and-research.md) section 8, [screens/research.md](screens/research.md) |
| D-27 | Research notes carry frontmatter (tags, date, status, `source: research`), wikilinks to related notes and a Sources section. An existing topic gets a new note linked to the old one. Nothing is written before review. | explicit, summary | A fixed `Research/` folder (placement is left to `vault_learn` plus a target domain) | [10-memory-and-research.md](10-memory-and-research.md) |
| D-28 | TurbidAssist: the deck is a Node client of the `scribed` Unix socket (JSON lines), with contract tests. | explicit | Shelling out to the scribe CLI; adding HTTP to scribed | [11-meetings.md](11-meetings.md) |
| D-29 | Meetings v1: list past meetings with summaries, start and stop recording, live transcript, and Ask Claude during the meeting. | explicit | n/a | [11-meetings.md](11-meetings.md) |
| D-30 | Notifications: desktop popups (notify-send / mako) plus an in-browser badge and sound. The bell rings once per session, never repeats, and re-notifies if ignored. Notify on done. During a TurbidAssist recording, popups still show but there is no sound. Phone push comes later. | explicit | Queue-then-digest quiet mode | [04-integrations.md](04-integrations.md) section 5 |

### 1.4 Approvals and security

| ID | Decision | Source | Rejected alternatives | Applied in |
|---|---|---|---|---|
| D-31 | Three risk tiers:<br>• **Safe**: can be batched, approved from a popup and turned into a rule.<br>• **Caution**: one at a time; a rule only if added by hand.<br>• **Destructive**: never batched, never a rule, never from a popup, always behind a confirm checkbox.<br>Unknown commands are Caution. Patterns live in `~/.config/fleetmates/deck/tiers.json`. | summary, canvas | n/a | [07-approvals.md](07-approvals.md) |
| D-32 | A rule is suggested after 5 Safe approvals of the same command. Rules are written to the repo's `.claude/settings.local.json`, so they also apply to plain `claude`. | summary, canvas | Deck-only rules | [07-approvals.md](07-approvals.md) |
| D-33 | Answers reach Claude Code as keystrokes into the PTY. The Focus prompt bar mirrors the terminal's own numbered options. | summary, canvas | See D-24 | [07-approvals.md](07-approvals.md), [screens/focus.md](screens/focus.md) |
| D-34 | Localhost only. A random token in a 0600 file is required on every HTTP request and WebSocket, and requests are rejected when Host or Origin do not match. | explicit (pushback accepted) | No auth on localhost | [08-security.md](08-security.md) |
| D-35 | Agent, transcript and task text is never rendered as HTML. | summary | n/a | [08-security.md](08-security.md) |

### 1.5 Design

| ID | Decision | Source | Rejected alternatives | Applied in |
|---|---|---|---|---|
| D-36 | Layout: Home is the grid (layout A); clicking a card opens list + focus (layout B). A 64 px left rail holds Sessions, Memory, Meetings and Settings. | explicit, canvas | Kanban (C); tiling (D) | [screens/README.md](screens/README.md) |
| D-37 | Own fixed dark theme, sea teal accent `#3cc8c8`, Geist and Geist Mono at a 14 px base. No light mode, no live Omarchy theme. | explicit, canvas | Following Omarchy; light mode | [design/design-system.md](design/design-system.md), [design/tokens.css](design/tokens.css) |
| D-38 | Voice: playful nautical fleet voice with the rule **theme the flavor, never the facts**. Status pills are literal; themed text appears only in headlines and subtitles. | summary (pushback accepted) | Themed status labels | [design/design-system.md](design/design-system.md) |
| D-39 | Pixel crew: 9×9 avatars. Shape comes from a hash of the repo name. Color comes from a slot that is saved once and never repeats. Each state has a pose, and a team shares a hat. The pose is a backup signal only; every card also has a state pill. | canvas | n/a | [design/crew.md](design/crew.md) |
| D-40 | English chrome with a `DECK_LANG` setting (`en`, `pt`), like vault-mcp's `VAULT_LANG`. Meeting content stays in PT-BR. | explicit, summary | n/a | [03-architecture.md](03-architecture.md) section 5 |
| D-41 | The Memory tab is a "second brain" graph showing the connections, and it must be user friendly. The owner will revisit the UI later (see Q5). | explicit | A plain list | [screens/memory.md](screens/memory.md) |
| D-42 | Design on the canvas first, then code. Critique passes ended after pass 3, with every finding fixed, including the low ones. Before coding, the handoff adds state maps, tokens, component specs and per-screen specs. | explicit | More critique passes | this handoff |

### 1.6 Process and handoff

| ID | Decision | Source | Rejected alternatives | Applied in |
|---|---|---|---|---|
| D-43 | Tests the owner asked for: a fake `claude` binary, Playwright UI tests, hook payload fixtures pinned per Claude Code version, and scribed contract tests. | explicit (pushback accepted) | n/a | [09-testing.md](09-testing.md) |
| D-44 | Milestone order: M0 spike, M1 observe (public), M2 control, M3 unblock, M4 meetings, M5 memory ask, M6 deep research. M4 does not start until M1 passes its one-week test (proposed during design and not contested). | explicit, summary | Monorepo restructure in M0 | [12-milestones.md](12-milestones.md) |
| D-45 | The handoff is English markdown in `docs/deck/` in the fleetmates repo, delivered as a PR, plus one overview document for sharing. | explicit | EN + PT-BR docs; docs outside the repo | this handoff |

### 1.7 More owner decisions

| ID | Decision | Source | Rejected alternatives | Applied in |
|---|---|---|---|---|
| D-59 | Ask the vault from both the Memory tab and the command palette. | explicit | One entry point only | [screens/memory.md](screens/memory.md), [screens/palette.md](screens/palette.md), [10-memory-and-research.md](10-memory-and-research.md) section 2.7 |
| D-60 | The Memory tab has four parts besides the graph: Ask (chat with citations), Browse notes by MOC (read-only, "Open in Obsidian"), Recent captures (what `vault_learn` wrote lately, with revert) and the Misses log (questions search could not answer). The revert mechanism is Open (MEM-O4). | explicit | n/a | [screens/memory.md](screens/memory.md), [10-memory-and-research.md](10-memory-and-research.md) |
| D-61 | The vault lives locally on the Omarchy machine. This is why WSL was dropped from v1 (D-05): the Windows side would have had no local vault. | explicit | Vault on Windows read from WSL; synced to both | [01-product.md](01-product.md), [10-memory-and-research.md](10-memory-and-research.md) |
| D-62 | Keyboard: Alt-based shortcuts (Alt K palette, Alt N new session, Alt 1 to 7 jump, drawer Alt A / Alt D / Alt Shift A), and the palette orders results by urgency: Needs you, Sessions, Actions, Memory. The final map is in keyboard.md (Q15 covers the clashes). | canvas | Ctrl K palette (earlier plan) | [interaction/keyboard.md](interaction/keyboard.md), [screens/palette.md](screens/palette.md) |
| D-63 | First run has six checks: Claude Code version, observation hooks, deckd, vault-mcp, scribed and a notification test. Only the hooks check blocks "Set sail". | canvas | n/a | [screens/first-run.md](screens/first-run.md), [13-operations.md](13-operations.md) section 2.3 |
| D-64 | The alert sound is the "Ship's bell", and an ignored request re-notifies after 10 minutes (whether once or repeatedly is Q12). | canvas | n/a | [interaction/state-machines.md](interaction/state-machines.md) section 9, [screens/settings.md](screens/settings.md) |
| D-65 | The owner asked for the command names `fleetmates ui` (open the deck) and `fleetmates deck init` (install the hooks). D-46 (Proposed) proposes different literal names (`fleetmates-deck open`, `fleetmates-deck init`) because the root package has no `bin`; which names ship is Q1. | explicit | n/a | [03-architecture.md](03-architecture.md) section 6, [13-operations.md](13-operations.md) |
| D-66 | Capacity: 10+ hours a week. The "3 to 4 months for six milestones" figure was an assistant guess, not a commitment. | explicit (capacity); assistant guess (estimate) | n/a | [12-milestones.md](12-milestones.md) section 1.1 |
| D-67 | Sessions started with plain `claude` outside `fm claude` are observed and read-only. When deckd is not running, `fm claude` prints one line and runs plain `claude`, observed only, so the user is never blocked (Q18, 2026-10-01). | explicit | `fm claude` refusing or waiting for deckd; prompting to rewrap unwrapped sessions | [03-architecture.md](03-architecture.md) section 2.4, [01-product.md](01-product.md) |
| D-68 | A second plain session in a repo that already has an active one gets a warning and is never blocked. The warning offers "Run as a fleetmates job", which launches the session with an initial prompt asking Claude to handle the task as a fleetmates run, so per-task worktrees keep the changes apart (Q3, SM-O5, NEW-O1, 2026-10-01). | explicit | Offer a fresh git worktree instead; warn with no action; block the second session | [screens/new-session.md](screens/new-session.md), [interaction/state-machines.md](interaction/state-machines.md), [05-api.md](05-api.md) |
| D-69 | Teammates have no terminal of their own, so opening one (Team run task rows, crew panels) opens the lead session's Focus with the Needs-you drawer filtered to that task's requests (FOC-O1, 2026-10-01). | explicit | A read-only teammate detail panel; the lead's Focus unfiltered | [screens/focus.md](screens/focus.md), [screens/team-run.md](screens/team-run.md) |
| D-70 | The 200 ms deck-hook budget covers the hook's own run, from module load to exit, and not Node's interpreter boot before it (2026-10-02). Reason: the boot comes before any hook code runs and grows with machine load, which the hook cannot control; the script's own 200 ms exit timer bounds the part it does control. No test pins that timer at 200 ms yet ([m2-exit.md](m2-exit.md) section 11.2); `hub/test/contract/hooks.test.mjs` measures the 200 ms span only for a hook that finishes quickly. | explicit | A budget that includes Node's interpreter boot | [05-api.md](05-api.md) section 6.2 item 3, [03-architecture.md](03-architecture.md) section 2.3 |
| D-71 | Caution requests are never approved from a desktop popup; the popup offers "Open" only (SM-O9, DRW-O4, 2026-10-02). Reason: the Decided Caution tier copy is "one at a time", so a Caution request is answered where its full command is on screen. | explicit | "Allow once" for Caution from the popup | [interaction/state-machines.md](interaction/state-machines.md) sections 2.5 and 9, [screens/needs-you-drawer.md](screens/needs-you-drawer.md), [07-approvals.md](07-approvals.md) |
| D-72 | Destructive tiers.json entries carry a confirm label template; when the deck cannot fill the count, the label reads "I checked what this command will change" (DRW-O1, 2026-10-02). Reason: no source computes a per-command consequence such as the commit count for `git push --force`, and a fixed fallback never shows a wrong number. | explicit | n/a | [07-approvals.md](07-approvals.md) section 8, [screens/needs-you-drawer.md](screens/needs-you-drawer.md) |
| D-73 | Approvals given in the terminal, observed through `PostToolUse`, count toward "Make it a rule?" (SM-O10, 2026-10-02). Reason: observed sessions are answered only in the terminal (Decided in 07-approvals), so without this their approvals would never reach the threshold. | explicit | Count only approvals given from the deck | [interaction/state-machines.md](interaction/state-machines.md) sections 2.7 and 2.8, [07-approvals.md](07-approvals.md) section 6 |
| D-74 | A Safe request that matches no tiers.json pattern gets no rule suggestion (SM-O11, 2026-10-02). Reason: a suggested rule's pattern is derived from the matched tiers.json entry, so an unmatched request has no reviewed pattern to offer. | explicit | Derive a pattern from the unmatched command | [interaction/state-machines.md](interaction/state-machines.md) section 2.8, [07-approvals.md](07-approvals.md) section 6 |

D-70 is applied in the docs it lists. D-71 to D-74 are recorded here and in [15-open-questions.md](15-open-questions.md); the owning docs listed under "Applied in" for them still read Proposed or Open, because updating them was outside the file set of run deck-m2c Task 34. Run deck-m2c Task 35 reviewed the tier defaults with these four decisions applied as settled ([reviews/2026-10-02-tier-oversight.md](reviews/2026-10-02-tier-oversight.md)).

D-24 is in section 2, where the Focus and approvals docs refer to it.

## 2. Handoff-time choices (Proposed)

The handoff made these choices where the design left a gap. Change any of them freely, but record the change here.

| ID | Choice | Why | Where |
|---|---|---|---|
| D-24 | Answer permission prompts with PTY keystrokes, not with Claude Code's `PermissionRequest` hook returning `allow`. | The hook can only allow, not deny. It would make a hook block on a human. And the owner chose keystrokes (D-33). Revisit when designing M3. | [03-architecture.md](03-architecture.md) section 4.3 |
| D-46 | Hub bins are `fleetmates-deck` and `fm`, with plugin-side forwarding, instead of a root `fleetmates` binary. | The root package has zero dependencies and no `bin` by rule. | Q1 in [15-open-questions.md](15-open-questions.md) |
| D-47 | Browser token: delivered in the URL fragment `#token=`, kept in `sessionStorage`, sent as `Authorization: Bearer` and as a WebSocket subprotocol. No cookie. | SameSite does not separate ports on the same host. | [08-security.md](08-security.md) |
| D-48 | Hooks send no token. The hooks socket is protected by its file mode (0600 in a 0700 directory). Send budget 200 ms, with a daily spool file as fallback. | A hook must never block Claude Code. | [03-architecture.md](03-architecture.md) section 2.3 |
| D-49 | Screen parsing runs in the web server; deckd sends plain screen rows. | Parsers change with every Claude Code release, and restarting deckd would kill sessions. | [05-api.md](05-api.md) section 5 |
| D-50 | SQLite through the built-in `node:sqlite` in WAL mode, with `better-sqlite3` as the fallback. | Avoids a second native dependency. | [06-storage.md](06-storage.md) |
| D-51 | The deck stores no meeting transcript text for any tag, not only confidential ones. Confidential tags also get time-only pins. | The transcript already lives in TurbidAssist, so a copy adds risk and no value. | [06-storage.md](06-storage.md), [11-meetings.md](11-meetings.md) |
| D-52 | `config.json` holds boot and connection settings only. UI preferences go in the SQLite `prefs` table, and Home density is kept per browser in `localStorage`. | Settings edits must not need a restart. | [13-operations.md](13-operations.md) section 7.1 |
| D-53 | The deck starts scribed with `systemd-run --user` in a login shell, not as a detached child. | A child would die with the deck's cgroup mid-meeting, and the service environment lacks `HF_TOKEN`. | [11-meetings.md](11-meetings.md) section 3.5 |
| D-54 | Research runs live in a deck-owned git workspace under `~/.local/share/fleetmates-deck/research/`. | A research run needs a repo for fleetmates, and none of the owner's repos fits. | [10-memory-and-research.md](10-memory-and-research.md) section 8.2 |
| D-55 | Ask runs with `--restricted`, only the vault read tools allowed, vault write tools denied, and the environment marker `FLEETMATES_DECK_ROLE=ask`. | Without `--restricted`, the deck's own hooks would fire and every Ask would show up as a session. | [10-memory-and-research.md](10-memory-and-research.md) section 2.2 |
| D-56 | Destructive floors: anything touching the deck's own files, Claude Code settings or `.git/` is Destructive, and `tiers.json` cannot lower it. `rm` is always Destructive. | An agent must not be able to widen its own permissions. | [07-approvals.md](07-approvals.md) |
| D-57 | `POST /api/open` accepts only named kinds, never raw paths or URLs. | `xdg-open` on attacker-chosen input is code execution. | [08-security.md](08-security.md), [05-api.md](05-api.md) |
| D-58 | Canonical names across docs: env var `FLEETMATES_DECK_PTY`; `vault_learn` parameter `preview`; "N running" counts `starting` + `running` only. | Reconciles differences between drafts. | [02-domain.md](02-domain.md), [04-integrations.md](04-integrations.md) |

## Open items

None here. Open questions live in [15-open-questions.md](15-open-questions.md).
