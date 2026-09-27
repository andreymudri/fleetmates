# 04 · Integrations

Every boundary the deck crosses, with what exists today, what the deck needs, and the gap. Full code-level contracts, with `file:line` references, are in [reference/fleetmates-contract.md](reference/fleetmates-contract.md) and [reference/vault-turbid-contract.md](reference/vault-turbid-contract.md). This page is the summary a builder needs; the reference files win on detail.

| Boundary | Direction | Transport | Owner of the other side | Contract test |
|---|---|---|---|---|
| Claude Code hooks | CC to deck | async command hook, JSON on stdin | Anthropic (changes outside our control) | Hook payload fixtures pinned per CC version (Decided) |
| Claude Code PTY | deck to CC | keystrokes, screen parsing | Anthropic | Fake `claude` binary (Decided) + screen fixtures per CC version |
| Claude Code settings | deck to CC | JSON files | Anthropic | Round-trip tests on fixture settings files |
| fleetmates runs | read only | files under `.fleetmates/` | this repo | Import the modules; fixture run dirs |
| vault-mcp | deck to vault-mcp | MCP over stdio | owner (separate repo) | Tool schema snapshot tests |
| `claude -p` Ask engine | deck to CC | child process, stream-json | Anthropic | Fake `claude` binary |
| TurbidAssist `scribed` | deck to scribed | Unix socket, JSON lines | owner (separate repo) | Contract tests replaying fixtures from `protocol.py` (Decided) |
| Desktop notifications | deck to mako | `notify-send` | Omarchy | Manual check in First run |

## 1. fleetmates

### 1.1 What the deck reads

- Run discovery: for each repo under the scan root, look in `<repo>/.fleetmates/`. A directory is a run if it holds `plan.json` or `status.json`. Skip `index/`. Run ids may nest (`2026/substop`).
- `plan.json`: `runId`, `totalPhases`, `tasks[] { id, title, files, deps, phase, tier }`, `planPath`, `runBranch?`.
- `status.json`: `runId`, `phase` (stale, never trust), `totalPhases`, `maxParallel`, `tasks[] { id, title, state, startedAt?, blockedBy? }`, `gates?`, `fixRounds?`.
- Task states in the wild: `pending`, `running`, `done`, `blocked`, `failed`, `orphaned`, plus anything an orchestrator writes by hand. Unknown values render as the literal value with a neutral pill.
- `gates["<phase>"]`: `{ verdict: 'PASS'|'FAIL', failed[], optionalFailed[], skipped[], pending[], phase, phaseName, recordedAt, ... }`. Label them "recorded", never "verified".

### 1.2 How

- Import, do not scrape: `readState` (`scripts/state.mjs`), `livenessRows`, `DEFAULT_STALE_MINUTES` (`scripts/liveness.mjs`), `NAMES` (`scripts/names.mjs`), `createGit` (`scripts/git.mjs`). Same repo, so relative imports from `hub/server/adapters/fleetmates.mjs`.
- Watch with `fs.watch` on each run dir, debounce 250 ms, re-read on change. Writes are atomic renames, so a read sees a whole file; still retry once on JSON parse errors (session and claim files are not atomic).
- Open files with `O_RDONLY | O_NONBLOCK` and check `isFile()` (a FIFO would hang a plain open).
- Derive the real phase and liveness on a slow timer (60 s per active run): both shell out to git and walk worktrees.
- Never write any file under `.fleetmates/` (several writers already race there with no lock).
- Escape everything: titles, `blockedBy`, gate fields are agent-written. fleetmates' `printable()` is terminal escaping, not HTML escaping, and passes bidi controls. The UI renders them as text nodes only.

### 1.3 Mapping runs to deck sessions (Proposed)

fleetmates records no Claude Code session ids, no lead, and no teammate names (tasks are `T1`, `T2`...). The deck infers:

- **Teammate**: a hook event whose `cwd` is a task worktree resolves through `.fleetmates/index/<sha256(worktree path)>.json` to `{ runId, taskId }`. Teammates are usually subagents of the lead session (same Claude process), so their events arrive on the lead's session; the deck attributes them to the task by `cwd` and never moves the session's repo because of it.
- **Lead**: the session whose `cwd` is the run's main worktree and that invoked fleetmates CLI commands for that run (a `PreToolUse` Bash command containing `scripts/cli.mjs` and `--run <runId>`). Once seen, stored as `run.leadSessionId`.
- **Research runs** are started by the deck, so the deck records their run id and lead session at launch.

Open (TEAM-O1): fleetmates has phase numbers, not names. The canvas labels "Plan, Build, Verify, Integrate" are illustrative; v1 shows "Phase 1..N" unless plan headings provide names.

### 1.4 Stale

`DEFAULT_STALE_MINUTES = 20` in fleetmates liveness (tip age or worktree touch age). The deck uses the same 20 minutes for plain sessions, measured on `lastActivityAt` ([02-domain.md](02-domain.md)).

## 2. Claude Code

### 2.1 Hooks installed by `fleetmates-deck init` (Decided: user level, once)

Events the deck subscribes to, all as `"type": "command"`, `"async": true`, `"timeout": 5`:

| Event | Used for |
|---|---|
| `SessionStart` | create or alias a session (`source`: startup, resume, clear, compact, fork) |
| `SessionEnd` | end (`reason`) |
| `UserPromptSubmit` | running; task title from the first prompt; closes `asked_you` |
| `PreToolUse` | running; activity line; `AskUserQuestion` opens a question request; lead detection |
| `PostToolUse`, `PostToolUseFailure` | step list; changed files refresh; closes permission requests answered in the terminal |
| `PermissionRequest` | opens a permission request (observe only, never answers) |
| `PermissionDenied` | closes a request as denied |
| `Notification` | `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`, `agent_completed` |
| `Stop` | turn ended: `done` or `idle`; question heuristic |
| `SubagentStart`, `SubagentStop` | activity (`subagents:n`); teammate attribution |
| `CwdChanged` | branch and repo refresh |
| `PreCompact`, `PostCompact` | activity `compacting`; not stale while compacting |
| `WorktreeCreate`, `WorktreeRemove` | logged; refresh the run join ([02-domain.md](02-domain.md) 2.5 Run) |

Example entry written to `~/.claude/settings.json` (merged with any existing `hooks`, including fleetmates' plugin hooks, which live in the plugin's own `hooks.json` and are unaffected):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "node ~/.local/share/fleetmates-deck/hook/deck-hook.mjs", "async": true, "timeout": 5 } ] }
    ]
  }
}
```

Install rules: back up the file first (`settings.json.deck-backup-<ts>`), merge by adding entries tagged with a marker the uninstaller can find (the command path), never reorder or remove other entries, write atomically, and verify by re-reading. The First run screen blocks "Set sail" until this check passes (Decided).

Payload fields the deck relies on: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, and per event `source`, `reason`, `tool_name`, `tool_input`, `notification_type`, `stop_hook_active`. Nothing else. Field names differ across docs and versions (for example the post-tool payload); the fixtures decide, not this page.

### 2.2 Version pinning (Decided: fixtures; Proposed: policy)

- `hub/test/fixtures/hooks/<cc-version>/<event>.json`: one real payload per event, captured by a script that runs a scripted session with a capture hook.
- CI runs the ingest against every fixture set. A Claude Code update that changes a payload fails CI.
- First run check 1 compares `claude --version` with the newest fixture set: equal is OK; newer shows a warning "not yet tested with the deck" (not blocking, state-machines SM-O18).
- The same capture script records PTY screen fixtures (permission prompt, idle input box, spinner) for the screen parser.

### 2.3 Screen parsing (PTY sessions)

deckd's headless terminal model gives the web server the visible screen. Parsers (versioned with the fixtures):

- Permission prompt: the box with the question and numbered options. Extract each option's number and label verbatim; the PromptBar and the drawer mirror them exactly (Decided: same options, same numbers as the terminal).
- Idle input box: the empty prompt, used to know when a launched session is ready for its first prompt, and to detect "turn ended" when hooks are late.
- Status/spinner region: excluded from activity so a hung spinner does not look alive.

### 2.4 Permission rules (Decided: per repo, `.claude/settings.local.json`)

- Write to `<repo>/.claude/settings.local.json` under `permissions.allow`. Create the file and the `.claude/` dir if missing. Preserve all other keys and order. Atomic write.
- Pattern syntax: Claude Code permission rules, for example `Bash(cargo test *)`, `WebFetch(domain:docs.nestjs.com)`. The canvas showed the older `Bash(cargo test:*)` form; generate whichever form the pinned version documents, and read both.
- Rules apply to plain `claude` in a terminal too, which is why they live in the repo and not in the deck (Decided).
- Revoke removes only the exact entry. If the file changed on disk since the deck read it, re-read and retry once; if the entry is gone, report "already removed".

### 2.5 `claude -p` (Ask engine, Decided: `claude -p` with vault-mcp)

Proposed invocation, summarised; the full argv, flag reasons and process details are in [10-memory-and-research.md](10-memory-and-research.md) section 2.2 (verify every flag against `claude --help` on the pinned version):

- `claude -p` with `--output-format stream-json`, prompt on stdin, `--no-session-persistence`.
- `--restricted` (no code-running built-ins, user and project settings ignored, so the deck's own hooks do not fire), `--strict-mcp-config` with a deck-generated `--mcp-config` holding only vault-mcp, `--permission-prompts none`.
- `--tools ""` (no built-in tools); `--allowedTools` the four vault read tools; `--disallowedTools` the editing and web tools plus every vault write tool by name.
- Env marker `FLEETMATES_DECK_ROLE=ask`; deck-hook drops any event carrying it.
- Runs on the owner's subscription, no API key (Decided).
- Read-only vault tools only. The Ask never writes the vault; writing is research's job, behind review.
- TurbidAssist already uses a close variant (`--restricted --safe-mode --strict-mcp-config --permission-prompts none`, `ask.py:168-225`), which is evidence these flags exist in the owner's installed version.
- Output contract: see [10-memory-and-research.md](10-memory-and-research.md) section 2.3.

### 2.6 Transcript tail (Proposed)

Claude Code writes a JSONL transcript for every session at `transcript_path`, a field of every hook payload (2.1). The deck tails it read-only, in the web server, for four things:

| Use | What is read |
|---|---|
| The card's "why" line | the latest assistant text |
| The "now" line | the latest assistant text while `running` |
| `endsWithQuestion` ([interaction/state-machines.md](interaction/state-machines.md) 1.5, SM-O3) | the last assistant text block, trimmed |
| Task title fallback | the first user message, when no `UserPromptSubmit` gave a task yet |

Rules (every format detail below: verify against captured fixtures in M0):

- Record types read: assistant message records whose content has text blocks. Everything else is skipped. Unknown record types are ignored, never an error.
- Parse defensively: one JSON object per line; a line that does not parse (a partial last line while Claude Code is writing, or a changed format) is skipped and counted, never fatal. Read from a remembered byte offset, and start again from a bounded tail (for example the last 256 KiB) when the file shrank or was replaced.
- Open with `O_NONBLOCK` and check `isFile()` before reading. The path comes from a hook payload; the deck reads it only when it sits under the Claude Code config directory (`~/.claude/projects/` or `$CLAUDE_CONFIG_DIR`).
- The format is pinned per Claude Code version like the hook payloads (2.2): the capture script stores transcript fixtures next to the hook fixtures ([09-testing.md](09-testing.md) sections 4 and 5.2), and CI runs the tail reader against every set.
- Never copy the transcript into SQLite (D-19). The deck keeps only `transcript_path` and the derived one-line fields the cards show.

## 3. vault-mcp (Decided: the deck reaches the vault only through vault-mcp)

### 3.1 Today (v0.3.0)

- Stdio MCP server, nine tools, **plain text answers only** (no `structuredContent`), errors as `isError` text. Env: `VAULT_PATH` (required), `VAULT_LANG`, `VAULT_AUTO_PUSH`.
- Index: in memory per process, BM25 (k1 1.2, b 0.75) plus one wiki-link hop (damping 0.4), revalidated by mtime on every call. Cold scan at 76 notes is about 50 ms.
- Embeddings rejected by its own spec at this scale; the only numeric trigger (about 5,000 notes or 50 MB) moves the index to SQLite FTS5, not to embeddings (Decided: measure first).

### 3.2 How the deck uses it (Proposed)

- One long-lived child process owned by the web server, via `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`, env `VAULT_PATH`, `VAULT_LANG=<DECK_LANG>`. Restart with backoff when it exits; health feeds the Memory tab.
- Direct tool calls only for data the UI renders: `vault_graph`, `vault_get_note`, `vault_list`, `vault_backlinks`, `vault_learn` with `preview`. Text answers are parsed by small, tested parsers until structured output lands.
- The Ask goes through `claude -p` with its own vault-mcp child (section 2.5), not through the deck's child.
- Writes from the deck and from Claude sessions go through different vault-mcp processes; vault-mcp serializes writes per process only. Research save is the only deck write; it is rare and user-triggered.

### 3.3 Required changes in vault-mcp (Decided need; Proposed design)

Both are specified in detail, with schemas and code locations, in [reference/vault-turbid-contract.md](reference/vault-turbid-contract.md) sections 1.10 and 1.11.

1. `vault_learn` gains `preview: boolean`. Same decision code, no write, no commit, no push; returns the would-be path, action (`created` | `appended`), reason, per-file diffs (note, MOC, index, daily), commit message and warnings, as text **and** `structuredContent`. The parameter name `preview: true` is the owner's accepted wording.
2. New `vault_graph` tool: nodes (path, title, tipo, status, tags, domain, degrees, mtime) and directed edges, filters shared with `vault_list`, `max_nodes`, `truncated` flag, as `structuredContent`.
3. Optional, same PR: `structuredContent` for `vault_get_note` and `vault_list`, which removes the deck's text parsers.

Ship these in vault-mcp before M5 (graph) and M6 (dry run). Until then the Memory graph tab shows "Graph needs vault-mcp 0.4" and research cannot save (no save without preview).

### 3.4 Research note conventions

`vault_learn` today writes `tipo: wiki`, `tags`, `criado`, and places the note in `02-wiki/<dominio>/`, updates the domain MOC and the daily note, and commits once. The canvas draft also showed `status: draft` and `source: research`, which `vault_learn` cannot set today (RES-O2, Open). Decided content rules still apply: frontmatter, `[[links]]` to existing notes, a Sources section; a topic the vault already covers gets a new note linked to the old one.

## 4. TurbidAssist (Decided: Node client of the `scribed` socket)

### 4.1 Protocol summary

- Socket `$XDG_RUNTIME_DIR/turbidassist.sock` (0600, no peer auth). One UTF-8 JSON object per line.
- Commands: `start {tag}`, `stop`, `status`, `tail {minutes}`, `ask {question}`, `subscribe`, `history`. Events: `ok`, `error`, `status`, `tail`, `transcript`, `ask_delta`, `ask_done`, `history`.
- Errors: `{type:'error', cmd, message}` with Portuguese free text. Display verbatim; do not parse.
- One connection per request, plus one long-lived `subscribe` connection. `subscribe` sends one `status` and then only `transcript` events; it never pushes start or stop.

### 4.2 Deck client rules (Proposed)

- Poll `status` every 2 s, always, while the deck runs (TurbidAssist's own TUI polls at 2 s). Quiet mode depends on it, so the poll does not slow down when Meetings is not visible.
- `stop` can take tens of seconds (thread joins up to 30 s each); no short timeout; the UI shows "Stopping and summarizing" until `status.recording` is false and the manifest appears.
- `stopping` is not visible in `status`; the deck tracks it from its own `stop` call.
- History: read `<session_dir>/*/session.json` (manifest `state`: `recorded`, `transcribed`, `awaiting_names`, `synthesized`) and the synthesized note in the vault (`<meetings_folder>/<date> <tag> <title>.md`, sections Resumo, Decisões, Action items in Portuguese). `session_dir` and `vault.meetings_folder` come from TurbidAssist's `config.yaml` (MEET-O11: location Open).
- Tags: `start` requires a tag from `synthesis.tag_policies` in `config.yaml`. The Record button therefore needs a tag choice (default `synthesis.default_tag`). Not on the canvas; added in [screens/meetings.md](screens/meetings.md).
- Confidential tags (`store_transcript: false`, for example `client-a`, `client-b`): the deck must not store transcript text, asks or pins text for those meetings in SQLite, logs or search indexes. It may show them live in memory only ([08-security.md](08-security.md)).

### 4.3 Gaps between the canvas and TurbidAssist today (Open)

| Canvas shows | Reality | Default until decided |
|---|---|---|
| "Start scribed" runs `systemctl --user start scribed` | No systemd unit for scribed exists; clients spawn it detached (`ScribeClient.ensure_daemon()`) | The canvas copy shows `systemctl --user start scribed`; the real command is `systemd-run --user` running a login shell (`$SHELL -l -c 'exec scribed'`), so scribed is not in the deck's cgroup and gets `HF_TOKEN` ([11-meetings.md](11-meetings.md) section 3.5, OPS-O1). TurbidAssist change T4 (a `scribed.service` unit) is the later clean fix |
| Pin moment (Alt P), pinned moments list | No pin command, event or file | Deck stores pins `{meetingId, t, label}` in SQLite (not for confidential tags: time only, no label); optional later: a `pin` command in scribed so `postmeet` can include pins |
| Live Ask "uses the transcript and your vault" | scribed `ask` runs `claude -p` with **no tools and no MCP** | Live Ask uses scribed `ask` (transcript only) and the copy says "uses the transcript"; vault access is a TurbidAssist change (add vault-mcp to the ask backend's `--mcp-config`) |
| Decisions / action items during and right after the meeting | Only in the post-meeting note written by `postmeet` | Show "Summary arrives after the meeting is processed" until the note exists |
| Source label (Teams, Meet, Discord) | Not persisted; `status.routed_apps` shows it live | Deck records `routed_apps` while polling and stores the label |
| "Save answer to meeting note" | Asks are already stored by scribed (`asks.jsonl`) and appear in the note's "Perguntas ao vivo" when `store_transcript` is true | No extra button in v1 |

## 5. Desktop notifications (Decided: notify-send / mako, in-browser badge and sound)

- `notify-send --app-name="fleetmates deck" --urgency=normal --action=open=Open "<title>" "<body>"`; the chosen action comes back on stdout and opens the session in the browser tab (via the server telling the tab to navigate; the deck does not steal focus otherwise). When no deck tab is connected, "Open" runs the same flow as `fleetmates-deck open`: the server calls `xdg-open` with the fragment URL plus a route hint, `http://127.0.0.1:<port>/#token=<token>&to=/s/<sessionId>` (Proposed; [08-security.md](08-security.md) section 4.1).
- No approve action on popups for Caution or Destructive (Decided for Destructive: never from a popup; Caution: Open SM-O9, default no).
- Sound (Ship's bell): played by the browser tab when visible, else by the server with `pw-play` (PipeWire, Omarchy default). Once per session per request burst, never repeated for the same request (Decided).
- Quiet mode while TurbidAssist records: popups still show, no sound (Decided).
- Re-notify after 10 minutes if still open (Decided value from the canvas; once, SM-O17).

## 6. git (read only)

- Branch: `git rev-parse --abbrev-ref HEAD` in the session `cwd`.
- Changed files: `git diff --numstat <reviewBaseline>` plus untracked files, refreshed after edit tools, debounced 2 s.
- Diff view: `git diff <reviewBaseline> -- <path>`. In session repos the deck never commits, pushes, checks out or stashes. The one exception is the deck-owned research workspace `~/.local/share/fleetmates-deck/research/` ([10-memory-and-research.md](10-memory-and-research.md) section 8.2), which `fleetmates-deck init` creates with `git init` and one initial commit.
