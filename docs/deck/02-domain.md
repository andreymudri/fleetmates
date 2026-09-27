# 02 · Domain model and vocabulary

Status labels used in every deck doc:

- **Decided**: the owner chose it during design. Change only with a new decision entry in [14-decisions.md](14-decisions.md).
- **Proposed**: the handoff author's recommendation, not yet confirmed. Safe to build; flag in review.
- **Open**: needs an owner decision before the milestone that depends on it. Listed in [15-open-questions.md](15-open-questions.md).

## 1. Vocabulary

The UI speaks a light nautical voice. The code does not. Types, tables, API fields and log lines use the plain term. The UI may use the themed term in headlines, subtitles and the three launch buttons the canvas already themes ("Launch a ship", "Send scouts", "Set sail"). It never uses it in status pills, counts, approve/deny/stop buttons, destructive confirmations or error messages ("theme the flavor, never the facts", Decided; the launch-button exception is Open, see [15-open-questions.md](15-open-questions.md)).

| Plain term (code, API, pills) | Themed term (subtitles only) | Meaning |
|---|---|---|
| session | ship | One Claude Code process the deck knows about |
| repo | harbor | A git repository under the scan root (`~/dev`) |
| run | voyage, fleet | A fleetmates run (`.fleetmates/<runId>/`) |
| teammate | crew member | A task worker inside a run, identified by its task id (`T3`) |
| request | (none) | Something a session is waiting on the user for: a permission prompt or a question |
| stale | adrift | A running session with no activity for `staleMinutes` (default 20) |
| done | made port | A session whose last turn ended with changes not yet reviewed |
| research | scouts, send out scouts | A deep-research fleetmates run |
| vault note | chart | A note in the Obsidian vault |
| daily recap | Captain's log | One-line summary of today |
| notification sound | Ship's bell | The chime played for requests |

## 2. Entities

All ids are strings. Timestamps are integer milliseconds since epoch (matches fleetmates `recordedAt`, `startedAt`).

Fields added during handoff are listed in [06-storage.md](06-storage.md) section 12.

### 2.1 Repo

| Field | Type | Notes |
|---|---|---|
| `id` | string | Absolute realpath of the repo root. Stable key. |
| `name` | string | Basename, shown in UI. Collisions get a disambiguating parent segment (`work/api`, `oss/api`). |
| `crewSlot` | int 0..8 | Color slot assigned the first time the deck sees the repo. Never reused while the repo exists, never changes unless the user picks another free slot. See [design/crew.md](design/crew.md). |
| `crewSeed` | string | Defaults to `name`. "Reroll" stores a new seed. |
| `hat` | `none` \| `cap` \| `bandana` | User choice. Team hat is separate and automatic. |
| `firstSeenAt` | ms | |

### 2.2 Session

| Field | Type | Notes |
|---|---|---|
| `id` | string | Deck id (ULID). Created on the first hook event or on launch. |
| `claudeSessionId` | string \| null | `session_id` from Claude Code hook payloads. One deck session may see several Claude session ids over its life (`/clear`, resume, fork); the latest is current, earlier ones are kept in `session_aliases`. |
| `origin` | `wrapped` \| `launched` \| `observed` | `wrapped`: started with `fm claude` in a terminal. `launched`: started from the deck UI. `observed`: started as plain `claude`, hooks only, no PTY. |
| `ptyId` | string \| null | Set when deckd owns the PTY (`wrapped`, `launched`). `observed` sessions have none and are read-only in the UI. |
| `repoId` | string | Resolved from `cwd` (walk up to the git root; worktrees resolve to their main repo). |
| `cwd` | string | Last `cwd` from hooks. |
| `branch` | string \| null | Read with `git rev-parse --abbrev-ref HEAD` at start and on `CwdChanged`. |
| `task` | string | Launch form task, else the first user prompt (first line, 120 chars), else "Untitled". |
| `runRef` | `{ repoId, runId, taskId }` \| null | Set when `cwd` is a fleetmates task worktree (resolved through `.fleetmates/index/`) or when the session is the run's orchestrator (see [04-integrations.md](04-integrations.md) section 1.4). |
| `role` | `solo` \| `lead` \| `teammate` \| `research` | Derived. `lead` is the orchestrator session of a run. |
| `state` | SessionState | Section 3. |
| `stateSince` | ms | |
| `lastActivityAt` | ms | Any applied hook event, or a PTY screen change outside Claude Code's status/spinner region. Spinner redraws do not count, otherwise a hung session never goes stale. |
| `alive` | boolean | Process still running. A session can be `done` with `alive=false` (finished, exited, changes unreviewed). |
| `processKey` | string \| null | `ptyId`, or the `claude` pid for observed sessions when it can be found (see state-machines SM-O1). |
| `activity` | string \| null | `compacting`, `tool:<name>`, `subagents:<n>`; shown as the card's one-line "now doing". |
| `reviewBaseline` | string | Commit sha the "changed files" diff is measured against. Set at start; reset by "Mark reviewed". |
| `joinedMidLife` | boolean | First seen through a hook after the deck (re)started, not at `SessionStart`. The card says "joined late, history partial". |
| `crashKind`, `exitSignal` | `exit` \| `signal` \| `lost`, string \| null | For the crash pill variants. |
| `lastInputFrom` | `terminal` \| `browser` \| null | For the "Last typed from" indicator. Includes terminal name when known (`kitty`). |
| `exitCode` | int \| null | PTY exit code (`wrapped`, `launched` only). |
| `transcriptPath` | string \| null | From hooks. Linked, never copied (Decided: link to Claude Code's transcript). |
| `changedFiles` | `{ path, adds, dels }[]` | From `git diff --numstat` against the session's start commit, refreshed on `PostToolUse` of edit tools. |
| `reviewedAt` | ms \| null | Set by "Mark reviewed". |
| `startedAt`, `endedAt` | ms | |

### 2.3 Request

Anything the user must answer. A session can have several open at once (rare; usually one).

| Field | Type | Notes |
|---|---|---|
| `id` | string | ULID |
| `sessionId` | string | |
| `kind` | `permission` \| `question` | `permission`: a Claude Code permission prompt. `question`: the agent asked the user something (AskUserQuestion tool, elicitation, or an idle prompt the deck classifies as a question). |
| `tier` | `safe` \| `caution` \| `destructive` \| null | Only for `permission`. See [07-approvals.md](07-approvals.md). |
| `toolName` | string | `Bash`, `Edit`, `WebFetch`, `mcp__x__y`, ... |
| `summary` | string | One line: the command, file or URL. Escaped for display. |
| `detail` | object | Raw `tool_input` (kept for the drawer's detail view). |
| `why` | string \| null | Last assistant sentence before the request, when available from the transcript tail. |
| `options` | `{ key, label }[]` | For `permission` in a PTY session: the exact options Claude Code printed ("1 Yes", "2 Yes, don't ask again for ...", "3 No, tell Claude what to do"), parsed from the PTY screen. |
| `state` | `open` \| `answered` \| `expired` | `answered` includes answers typed in the terminal when the outcome is observed (matching `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `UserPromptSubmit`). `expired` only when the request closed with no known outcome. |
| `expiredReason` | `process_ended` \| `session_replaced` \| `interrupted` \| `superseded` \| null | |
| `answer` | object \| null | `{ via: 'browser'|'terminal', choice, text? }` |
| `source` | `permission_request` \| `notification` \| `ask_user_question` \| `elicitation` \| `stop_question` | Which signal opened it. |
| `matchKey` | string | Tool name + normalized input, used to match the closing hook and to count approvals for rule suggestions. |
| `delivery` | `idle` \| `sending` \| `verifying` \| `did_not_land` | Browser answer delivery into the PTY (state-machines section 2). |
| `screenMatch` | `on_screen` \| `queued` \| `unknown` | PTY sessions: whether this request's prompt is the one on screen (state-machines 2.3 and 12.5). Proposed. |
| `createdAt`, `answeredAt` | ms | |
| `notifiedAt`, `renotifiedAt` | ms \| null | Notification bookkeeping. |

### 2.4 Rule

| Field | Type | Notes |
|---|---|---|
| `repoId` | string | Rules are per repo. |
| `pattern` | string | Claude Code permission syntax, e.g. `Bash(cargo test *)`. Written to `<repo>/.claude/settings.local.json` `permissions.allow`. |
| `source` | `suggested` \| `manual` | `suggested`: accepted from the "Make it a rule?" prompt. |
| `approvalsBefore` | int \| null | Count that triggered the suggestion. |
| `createdAt` | ms | |

The deck keeps a mirror row so Settings can show the source and date. The settings file is the source of truth; the deck re-reads it on open and marks rules it did not write as `manual`.

### 2.5 Run (fleetmates)

Read-only view over `.fleetmates/<runId>/plan.json` and `status.json`. Fields follow the fleetmates contract ([reference/fleetmates-contract.md](reference/fleetmates-contract.md) section 3). The deck adds:

| Field | Notes |
|---|---|
| `repoId` | |
| `kind` | `build` \| `research` (research runs are started by the deck and tagged in the deck DB) |
| `leadSessionId` | Deck session that is the orchestrator, when known |
| `derivedPhase` | From git (fleetmates `derive`), polled slowly. `status.phase` is never trusted. |
| `teammates` | `{ taskId, sessionId?, state, liveness }[]` joined from status.json tasks, worktree mapping and liveness rows |

### 2.6 Meeting

Read from TurbidAssist: live state from `scribed`, history from `<session_dir>/<session_id>/session.json` and the meeting note in the vault.

| Field | Notes |
|---|---|
| `id` | TurbidAssist `session_id` (`2026-09-08T14-00-12`) |
| `tag` | One of `synthesis.tag_policies` keys (`pessoal`, `client-a`, ...) |
| `confidential` | `true` when the tag's `store_transcript` is `false`. The deck must not persist transcript text for these (see [08-security.md](08-security.md)). |
| `state` | `recording` \| `stopping` \| `recorded` \| `transcribed` \| `awaiting_names` \| `synthesized` |
| `startedAt`, `endedAt` | |
| `notePath` | Vault path of the meeting note once synthesized |
| `apps` | `routed_apps` seen during recording (source label: Teams, Meet, Discord) |
| `pins` | `{ t, label }[]`, see [11-meetings.md](11-meetings.md) (pins are not in TurbidAssist today) |

### 2.7 Ask thread, answer, miss

| Entity | Fields |
|---|---|
| `AskThread` | `id`, `title` (first question), `scope` (`vault` \| `meeting:<id>`), `createdAt` |
| `AskMessage` | `id`, `threadId`, `role` (`user` \| `assistant`), `text`, `citations: { path, line, viaGraph }[]`, `generalKnowledge: string \| null`, `isMiss: boolean`, `createdAt` |
| `Miss` | `id`, `question`, `threadId`, `searchedTerms`, `createdAt`, `resolvedBy` (`research:<runId>` \| `note:<path>` \| null) |

### 2.8 Research

| Field | Notes |
|---|---|
| `id` | fleetmates run id, `research-<slug>-<yyyymmdd>` |
| `topic`, `preset` (`quick` \| `standard` \| `deep`), `domain`, `sourceTypes[]`, `focusNotes[]` | From the form |
| `existingNotes[]` | Notes found on the topic when the form opened |
| `state` | `running` \| `drafted` \| `saved` \| `discarded` \| `failed` |
| `draft` | Note body, frontmatter, sources `{ n, url, title, why, backs[], kept }[]`, rejected sources `{ url, reason }[]` |
| `preview` | Last `vault_learn` dry-run result (structured) |

## 3. Session state

One enum drives the pill, the card, the crew pose, grouping and notifications. The full transition table is in [interaction/state-machines.md](interaction/state-machines.md); this is the contract.

| State | Pill label (literal) | Crew pose | Grid | Counts as "needs you" |
|---|---|---|---|---|
| `starting` | Starting | running | main grid | no |
| `running` | Running | running | main grid | no |
| `needs_approval` | Needs approval | needs | main grid, first | yes |
| `asked_you` | Asked you | needs | main grid, first | yes |
| `done` | Done | done | main grid | no (counts as "to review") |
| `stale` | No activity {n}m | idle | quiet row | no |
| `idle` | Idle {duration} | idle | quiet row | no |
| `reviewed` | Reviewed | done | quiet row | no |
| `crashed` | Crashed · exit {code}, Crashed · signal {NAME}, Crashed · lost | crashed | main grid | no (listed in Failures) |
| `ended` | Ended | none | history only | no |

`starting` exists only for PTY origins. Observed sessions start in whatever state their first hook implies.

Rules:

- A session that finishes with unreviewed changes and then exits stays `done` (`alive=false`) until "Mark reviewed" moves it to `ended`. Quitting `claude` must never drop unreviewed work off the grid.

- A team card (run) takes the most urgent state of its teammates, in this order: `needs_approval`, `asked_you`, `crashed`, `stale`, `running`, `done`, `idle`, `reviewed`.
- "N need you" in the header counts **sessions** with at least one open request. The drawer title counts **requests** and **sessions**: "4 requests from 3 ships". These numbers must come from the same query so they never disagree (a pass-1 review finding).
- "N running" counts `starting` + `running` only. The three header chips ("need you", "running", "to review") are disjoint, so a session is counted once. This matches the canvas Home ("3 need you · 4 running · 1 to review"). A team counts once, under its most urgent state.
- "N to review" counts `done`.
- `stale` threshold: 20 minutes without activity (`lastActivityAt`) while the state is `running` (matches fleetmates `DEFAULT_STALE_MINUTES = 20`). Configurable in Settings later; not in v1 UI.

## 4. Identifiers on screen

| Thing | Format | Example |
|---|---|---|
| Session title | `repo · task` | `rustot · combat-tick` |
| Teammate | `task id · title` | `T5 · redis lock` (fleetmates has no `t1` names; the canvas labels `fm-t1..t3` are illustrative) |
| Branch | as git prints it | `fleetmates/gate-cli/T5` |
| Path | `~` for `$HOME` | `~/dev/rustot` |
| Durations | `12m`, `1h 12m`, `3d` | |
| Clock times | 24 h local | `18:42` |
| Meeting offsets | `MM:SS` counting total minutes (TurbidAssist format) | `62:05` |
