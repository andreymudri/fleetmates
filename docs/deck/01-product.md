# 01 · Product

Status labels as in [02-domain.md](02-domain.md). Everything in this document is **Decided** ([14-decisions.md](14-decisions.md) D-01 to D-09) unless it is marked otherwise.

## 1. One line

fleetmates deck is a local web UI for someone who runs several Claude Code sessions at once. It shows which sessions need you, and it lets you answer, steer and launch them from one place. It also connects that work to your Obsidian vault and your meetings.

## 2. Why it exists

The pain it solves first is **losing track of parallel sessions** (D-03):

- which session is doing what;
- blocked sessions nobody notices: a permission prompt waits 40 minutes in a tmux pane you are not looking at;
- switching is painful: finding the right terminal, remembering its context.

Two neighbouring needs come from the same owner's tools:

- **Knowledge.** The vault (Obsidian, served by [vault-mcp](reference/vault-turbid-contract.md)) holds what past sessions learned. Asking it, and adding researched notes to it, belongs next to the sessions that use it.
- **Meetings.** TurbidAssist records and transcribes meetings. Its action items often become sessions.

## 3. Who it is for

- The owner first: a senior full-stack developer on Omarchy (Hyprland) Linux with a 1920×1080 main monitor. He runs 3 or more Claude Code sessions in parallel, often as fleetmates team runs (D-05).
- Released as open source, and public from M1 (D-07). It needs to be installable by another Linux developer who uses Claude Code, and its code and docs should be easy to read for someone new to the project.
- Single user and single machine only. There is no multi-user, remote or mobile use in v1.

## 4. What it does

| Area | What the user can do | Milestone |
|---|---|---|
| Observe | See every Claude Code session on the machine, whatever terminal it was started in, with a literal state (Running, Needs approval, Asked you, No activity 22m, Done, Crashed). Get a popup and a bell when a session needs you. | M1 |
| Control | Launch a session from the UI (repo + task). Open any `fm claude` session's live terminal in the browser and type into it. Follow fleetmates team runs phase by phase. | M2 |
| Unblock | Approve or deny permission prompts from the Needs-you drawer, the card or the Focus prompt bar, with risk tiers (Safe, Caution, Destructive) and per-repo rules. Review diffs. | M3 |
| Meetings | Record, follow the live transcript, ask about it, pin moments, browse past meetings and their action items. | M4 |
| Memory | Ask the vault with cited answers (`path:line`). Browse the note graph. See misses, captures and notes read by sessions. | M5 |
| Research | Send a research team ("scouts") on a topic, review the draft note and its sources, then save it to the vault. | M6 |

Screens per area: [screens/README.md](screens/README.md). Delivery plan: [12-milestones.md](12-milestones.md).

## 5. Experience goals

"Enjoyable" is a stated requirement (D-04), not decoration:

1. **Calm overview.** One look says what needs you. When nothing runs, Home says so ("Calm seas") and shows open loops instead of an empty grid.
2. **Alive and playful.** A pixel crew per repo, gentle pulses for running and waiting sessions, a nautical voice in headlines ("ran aground", "made port").
3. **Fits the desktop.** A dark, fixed theme in the family of the owner's Tokyo Night setup, Geist type, Alt shortcuts that do not fight Hyprland or the terminal.

The guardrail for playfulness: **theme the flavor, never the facts** (D-38). A status pill always says the literal state. Only subtitles and headlines are themed.

## 6. Principles

| Principle | Consequence |
|---|---|
| The real terminal is the interface | The browser mirrors Claude Code's own TUI through xterm.js. There is no custom chat view in v1 (D-15). Approvals are keystrokes into that terminal (D-33). |
| Never lose an agent | PTYs belong to `deckd`, not the web server. The UI can crash, restart or upgrade while sessions keep running (D-10). |
| Observe everything, control what you own | Hooks see every session (D-14). Only sessions started with `fm claude` or from the UI can be typed into. Others show "Answer in your terminal". |
| One source of truth per domain | fleetmates owns run state (D-20). vault-mcp owns the vault (D-21). TurbidAssist owns recordings (D-28). The deck reads through them and does not duplicate their logic. |
| Risky actions get friction in proportion | Safe can be batched. Caution goes one at a time. Destructive is never batched, never a rule, never approved from a popup, and always sits behind a checkbox (D-31). |
| Nothing is written to the vault without review | Research drafts go through a `vault_learn` preview before saving (D-23). |
| Local and private | Localhost only, a token on every request (D-34). Confidential meeting tags leave no text in the deck (D-51, Proposed). |
| Measure before adding machinery | No embeddings until logged misses show the need (D-22). |

## 7. Non-goals for v1

- A general "agentic OS" or a shell replacement (D-01).
- Embeddings, a vector DB or a local model (D-22).
- Cost tracking in dollars, or hard caps (D-09). Rate-limit state is wanted but has no screen yet (Q16 in [15-open-questions.md](15-open-questions.md)).
- WSL, macOS, mobile, remote access, phone push, other agents than Claude Code (Later, [12-milestones.md](12-milestones.md) section 11).
- A light theme or following the Omarchy theme live (D-37).
- Creating git worktrees (D-17), or committing to session repos.

## 8. Success measures

| Measure | Target | Status |
|---|---|---|
| M1 dogfood week | 3+ parallel sessions for a full work week without opening a pane to check status | Decided (D-08); protocol in [09-testing.md](09-testing.md) |
| Time a blocked session waits unnoticed | Measured during the dogfood week; the popup and bell should bring it to minutes | Proposed metric |
| Vault misses | Logged and triaged; hybrid search is reconsidered only if retrieval failures pile up | Decided direction (D-22); threshold Open (KB-O2) |
| Public release | Published at M1 with a README and screenshots, installable by someone else from npm | Decided (D-07) |

## 9. How the pieces fit

```
you ── browser tab (fleetmates deck UI)
          │  HTTP + WebSocket on 127.0.0.1, token
          ▼
      deck web server ──── SQLite (sessions, requests, prefs, history)
       │  ├── vault-mcp (stdio) ── Obsidian vault
       │  ├── scribed socket ── TurbidAssist
       │  ├── .fleetmates/<run>/status.json ── fleetmates runs
       │  └── hooks.sock ◄── deck-hook ◄── Claude Code hooks (every session)
       ▼
     deckd ── PTYs ── claude (fm claude or launched from the UI)
```

Details: [03-architecture.md](03-architecture.md). Every external boundary: [04-integrations.md](04-integrations.md).

## Open items

None owned here. The product-level questions are Q1 to Q19 in [15-open-questions.md](15-open-questions.md). Read-only for sessions started outside `fm claude` is **Decided** (D-67 in [14-decisions.md](14-decisions.md), principle "Observe everything, control what you own").
