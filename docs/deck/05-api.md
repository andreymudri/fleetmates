# 05 · API

Status labels as in [02-domain.md](02-domain.md). Decided here: the token on every HTTP request and WebSocket with Host and Origin checks, loopback only, hooks over a Unix socket with a spool fallback, deckd reachable only over its Unix socket, answers delivered as keystrokes into the PTY, and the resync by `seq` idea. Everything else in this document (paths, payload shapes, event names, the deckd wire protocol, the envelope fields, error codes, versioning) is **Proposed** unless a line says otherwise. Where a screen spec named an endpoint or event differently, this document wins (SHELL-O1) and section 2.1 lists every rename.

Three contracts live here:

1. Browser (React SPA) to web server: REST under `/api/*` plus one WebSocket at `/api/ws` (sections 1 to 4).
2. Web server to deckd over `deckd.sock` (section 5).
3. deck-hook to web server over `hooks.sock`, with the spool fallback (section 6).

Type names in payloads (`Session`, `Request`, `Run`, ...) are the JSDoc typedefs in section 7. Field names follow [02-domain.md](02-domain.md); fields 02-domain does not have are marked "(Proposed field)" in section 7 and listed in [06-storage.md](06-storage.md) section 12.

## 1. Transport and auth

| Item | Rule | Status |
|---|---|---|
| Bind | `127.0.0.1:47800` by default, env `DECK_PORT` ([03-architecture.md](03-architecture.md) 2.2). IPv4 loopback only; the server refuses to start on any other address. | Loopback Decided, port Proposed |
| Static | Every non-`/api/` path returns the SPA `index.html` (history fallback, [screens/rail-and-shell.md](screens/rail-and-shell.md) 2). Static files need no token. | Proposed |
| Token | Random token in a 0600 file, `~/.local/state/fleetmates/deck/token`. Required on every `/api/*` request and on the WebSocket upgrade. | Decided (random token, 0600 file, required everywhere); path Proposed |
| HTTP token carrier | `Authorization: Bearer <token>` header. Never in a query string (it would land in logs and history). | Proposed (API-O1) |
| WebSocket token carrier | Browsers cannot set headers on a WebSocket. The SPA opens `new WebSocket(url, ['deck.v1', 'deck.auth.' + token])` (the raw token: it is already base64url, so it is a valid subprotocol token as it is); the server checks the second subprotocol, answers with `Sec-WebSocket-Protocol: deck.v1` only, and rejects the upgrade with HTTP 401 when the token is missing or wrong. | Proposed (API-O1) |
| Host check | `Host` must be exactly `127.0.0.1:<port>`. `localhost:<port>` gets 421 `forbidden_host` with `Location: http://127.0.0.1:<port>/`; anything else gets 403 `forbidden_host` (blocks DNS rebinding). Same rule as [08-security.md](08-security.md) 4.1. | Decided (check; allowed values by the owner on 2026-10-01) |
| Origin check | Every `/api/*` request other than `GET` and `HEAD`, every WebSocket upgrade, and any request that carries `Origin` must have `Origin: http://127.0.0.1:<port>`; else 403 `forbidden_origin` (HTTP) or a refused upgrade (WebSocket). An `/api/*` request whose `Sec-Fetch-Site` is present and neither `same-origin` nor `none`, and every `OPTIONS` request to `/api/*`, also gets 403 `forbidden_origin`. An `OPTIONS` request to a non-API path gets 404 `not_found` (only `GET` and `HEAD` are served there), unless it carries a foreign `Origin`, which gets 403 `forbidden_origin` by the rule above. | Decided (check; allowed value by the owner on 2026-10-01) |
| Body type | Requests with a body must send `Content-Type: application/json` (else 415). Together with the Origin check this forces a CORS preflight for any cross-site attempt; the server answers no CORS headers, so preflights fail. | Proposed |
| Body size | 256 KiB max, declared or streamed (413 `payload_too_large`, sent with `Connection: close` so a client still sending its body gets the 413 instead of a reset), as [08-security.md](08-security.md) 4.1 says. Terminal input and pastes travel over the WebSocket (section 3.5), not this path. | Decided (owner, 2026-10-01) |
| POST bodies | Only `POST /api/sessions` and `POST /api/open` read a body. A `POST` with a non-empty JSON object to any other route gets 422 `validation_failed` before it is routed. | Proposed (M2) |
| Caching | Every `/api/*` response carries `Cache-Control: no-store`. | Proposed |

The details (token rotation, what a stale tab sees, CSP, why the WebSocket subprotocol and not a cookie) belong to [08-security.md](08-security.md). The WebSocket close codes the SPA reacts to are fixed by [interaction/state-machines.md](interaction/state-machines.md) 4.1: 4401 token invalid, 4403 origin rejected.

### 1.1 URL conventions

- JSON in, JSON out. Timestamps are integer milliseconds (02-domain 2). Ids are strings.
- `repoKey` is the displayed repo name (`rustot`, `work/api`), URL-encoded as **one path segment** (`work%2Fapi`). The router splits the raw path on `/` first and then decodes each segment, so an encoded slash never splits a segment. The server resolves `repoKey` to `repo.id` (the realpath). Every endpoint that takes `repoKey` also accepts `?repoId=<realpath>` instead, which is stable when a later collision renames the key (API-O2).
- Run ids may nest (`2026/substop`). In API paths the whole run id is one encoded segment (`2026%2Fsubstop`). The SPA route `/runs/:repoKey/*runId` stays unencoded; the SPA encodes when it calls the API.
- Vault paths travel in the query string (`?path=02-wiki/nestjs/bullmq-worker.md`), never in the path.
- Literal segments win over parameters: `/api/meetings/search`, `/api/meetings/start`, `/api/meetings/stop` are matched before `/api/meetings/:id`. TurbidAssist ids look like `2026-09-08T14-00-12` and cannot collide with them.
- Actions that start long work return `202 Accepted` with the current object; progress and the outcome arrive as WebSocket events. The HTTP request never waits on a PTY, scribed `stop`, `claude -p` or vault-mcp write.

## 2. REST endpoints

Columns: request body or query, success response, error codes (section 4), milestone, and the screen or machine that uses it. "WS" in the response column means the final result arrives as the named WebSocket event.

### 2.1 Normalizations applied to the screen specs

| Screen spec named | This API | Why |
|---|---|---|
| `GET /api/repos/:repoKey/sessions?active=1` (new-session) | `GET /api/sessions?repoKey=&active=1` | one sessions query with filters |
| `PUT /api/repos/:repoKey/crew {seed}` / `{slot}` / `{hat}` (crew-sheet) | `PATCH /api/repos/:repoKey/crew` | partial update |
| `PUT /api/prefs {ruleSuggestAfter}`, `PUT /api/prefs` (settings) | `PATCH /api/prefs` | partial update |
| `POST /api/meetings/:id/items/:n/dismiss` (meetings) | `POST /api/meetings/:id/items/:itemKey/dismiss` | an index changes if the note is re-synthesized; `itemKey` is the sha1 of the normalized item text and comes with the detail payload |
| `POST /api/requests/:id/answer {choice:'allow'}` / `{choice:'deny'}` | same path, `choice` extended to `allow`, `allow_always`, `deny`, `option`, `reply` | one endpoint covers `U.Allow`, `U.Deny`, `U.PickOption`, `U.Reply`, `U.TryAgain` |
| `U.Fix` for "Start deckd", "Start scribed" (first-run, settings) | `POST /api/deps/:dep/start` | same endpoint as the Failures board `POST /api/deps/scribed/start` |
| `U.Retry` (degraded card) | `POST /api/deps/:dep/retry` | named here |
| `U.StopRun` (research) | `POST /api/research/:id/stop` | named here |
| `U.StopAsk` (memory) | `POST /api/ask/:messageId/cancel` | named here |
| Team "Stop run…" = `U.Stop` on the lead | `POST /api/sessions/:leadSessionId/stop` | no run-level stop; fleetmates owns runs |
| WS `session.state`, `session.files`, `session.activity` (home, focus) | folded into `session.upserted` | one reducer per entity |
| WS `rule.added`, `rules.changed` (settings) | `rule.upserted`, `rule.removed` | |
| WS `repo.crew` (crew-sheet) | `repo.upserted` | |
| WS `research.preview`, `research.saved` (research) | folded into `research.updated` | the state field says which |
| WS `meeting.pins` (meetings) | `meeting.pin.added`, `meeting.pin.removed` | |
| Runs paths `/runs/:repoKey/*runId` | API `/api/runs/:repoKey/:runId` with the run id as one encoded segment | a nested id plus `/plan` would be ambiguous |
| state-machines 4.3 `snapshot{seq, sessions, requests, runs, meetings, health}` | `snapshot` with more fields (section 3.3) | Home needs counts, order, recap, repos |

### 2.2 Setup, health, dependencies, notifications

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| GET | `/api/version` | | `{ apiVersion, deckVersion, build }`: `deckVersion` is the `hub/package.json` version, `build` the milestone (`m2`) | | M1 | shell (version skew, section 8) |
| GET | `/api/setup/checks` | | `{ checks: SetupCheck[] }` with every automatic check in `checking`; each result then arrives as WS `setup.check` | | M1 | First run open and "Check again" (`U.CheckAgain`), Settings Connections |
| POST | `/api/setup/hooks` | | `{ check: SetupCheck, backupPath }` after install and re-check | `settings_io_failed`, `validation_failed` (the file is not JSON; nothing written) | M1 | First run "Install hooks" (`U.Fix`), Settings |
| POST | `/api/setup/complete` | | `{ firstRunCompletedAt }` | `precondition_failed` (hooks check not `ok`; Decided gate) | M1 | First run "Set sail" |
| GET | `/api/health` | | `{ deps: Health[] }` | | M1 | Settings Connections, degraded cards (also in the snapshot) |
| POST | `/api/deps/:dep/start` | `dep` = `deckd` or `scribed` | 202 `{ dep: Health }`, then WS `health.changed` | `not_found` (unknown dep), `dependency_start_failed` (stderr in `details`) | M1 (deckd, and scribed for First run "Start scribed"); M4 for the meetings screens | First run, Settings, Failures (`POST /api/deps/scribed/start`); scribed spawn per FAIL-O1 / SM-O13 |
| POST | `/api/deps/:dep/retry` | `dep` = `deckd`, `vault-mcp`, `scribed`, `notify` | 202 `{ dep: Health }` | `not_found` | M1 | Failures "Retry", connection banners "Retry now" for deckd |
| POST | `/api/notify/test` | | `{ ok: true, via: 'notify-send' }` | `notify_failed` (`details.stderr`, `details.exitCode`) | M1 | First run and Settings "Send test ping" (`U.SendTestPing`) |

`deckd` start runs `systemctl --user start fleetmates-deckd.service` (the unit name is Proposed in 03-architecture 2.1).

### 2.3 Sessions

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| GET | `/api/sessions` | query `state` (comma list), `repoKey`, `active=1` (not `ended`), `limit` (default 100), `before` (ms, on `startedAt`) | `{ sessions: Session[], nextBefore }` | `not_found` (unknown repoKey) | M1 | new-session conflict check, palette, history lists (Home reads the snapshot) |
| GET | `/api/sessions/:id` | | `{ session: Session, requests: Request[], steps: Step[] }` | `not_found` | M1 | Focus deep link, palette |
| GET | `/api/sessions/:id/steps` | query `limit` (default 50, max 200), `taskId` | `{ steps: Step[] }` | `not_found` | M1 | Home tails after a gap, Team crew panels |
| POST | `/api/sessions` | `{ repoKey, task?, mode?: 'plain' \| 'fleetmates' }` (no other keys) | 201 `{ session: Session, warning?: { kind: 'repo_busy', sessionIds: string[] } }` | `not_found` (repo), `validation_failed` (an empty or blank task in `fleetmates` mode only; a task over 10,000 characters or holding NUL; an unknown key or mode), `deckd_unavailable`, `spawn_failed` | M2 | New session "Launch a ship" (`U.Launch`), "Run as a fleetmates job" (`mode: 'fleetmates'`, D-68); flow in 03-architecture 4.1 |
| POST | `/api/sessions/:id/stop` | | 202 `{ session }` | `not_found`, `read_only_session` (observed), `invalid_state` (`ended`, `crashed`), `deckd_unavailable` | M2 | Home, Focus, Failures "Stop…", Team "Stop run…" on the lead, research "Stop run…" (`U.Stop`, state-machines 1.7 row 50) |
| POST | `/api/sessions/:id/nudge` | | 202 `{ session }` | `read_only_session`, `invalid_state` (not `stale` or `idle`), `deckd_unavailable` | M2 | Home quiet row, Failures adrift card (`U.Nudge`) |
| POST | `/api/sessions/:id/mark-reviewed` | | `{ session }` | `invalid_state` (not `done`; state-machines 1.9 says 409) | M1 | Focus "Mark reviewed" (in the read-only Focus of M1, MS-O1), palette (`U.MarkReviewed`) |
| POST | `/api/sessions/:id/relaunch` | | 202 `{ session }` | `invalid_state` (not `crashed`, or observed without `claudeSessionId`), `deckd_unavailable`, `spawn_failed` | M2 | Failures, Focus "Relaunch" (`U.Relaunch`, row 46) |
| POST | `/api/sessions/:id/dismiss` | | `{ session }` | `invalid_state` (not `crashed`) | M1 | Failures, Focus "Dismiss" (`U.Dismiss`, row 47) |
| GET | `/api/sessions/:id/diff` | query `path` (repo-relative) | `{ path, baseline, diff, binary, truncated }` (unified diff text, capped at 512 KiB) | `not_found` (path not in `changedFiles`), `validation_failed` (path escapes the repo) | M3 | Focus Changes tab |
| GET | `/api/sessions/:id/disk` | | `{ cwd, mounts: [{ mount, sizeBytes, usedBytes, availBytes }] }` for the mount of `cwd` and of `$HOME` | `not_found` | M1 | Failures "Show disk usage" |
| GET | `/api/sessions/:id/scrollback` | query `lines` (default 1000, max 5000) | `{ text, source: 'deckd' \| 'stored', truncated }` (ANSI kept; the SPA writes it into a read-only xterm) | `not_found` (no PTY and nothing stored) | M2 | Failures crash tail, "Ship's log" |
| GET | `/api/sessions/:id/memory` | | `{ related: Citation[], read: NoteRef[], learned: NoteRef[] }` | `vault_unavailable` (`related` needs vault-mcp; `read` and `learned` come from the deck DB and still return) | M5 | Focus Memory tab |
| GET | `/api/history` | query `repoKey`, `limit`, `before` | `{ summaries: SessionSummary[], nextBefore }` | | M1 | history views, Calm "Recent harbors" (Proposed endpoint; no screen names it yet) |

### 2.4 Requests (approvals and questions)

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| GET | `/api/requests` | query `state` (default `open`), `sessionId`, `runId` + `repoKey`, `taskId` | `{ requests: Request[] }` | | M1 (read-only) | Needs-you drawer, palette Needs group, Team filter `?needs=run:<runId>` |
| POST | `/api/requests/:id/answer` | `AnswerBody` (below) | 202 `{ request }` with `delivery: 'sending'`; outcome via WS `request.updated` (`verifying`, `did_not_land`) and `request.closed` | `not_found`, `request_closed`, `read_only_session`, `not_on_screen`, `typing_in_terminal`, `confirm_required`, `tier_forbids`, `deckd_unavailable`, `answer_in_flight` | M3 | Home card, drawer, Focus PromptBar, palette, popup `N.Allow` path (server-internal) |
| POST | `/api/requests/answer-batch` | `{ ids: string[], choice: 'allow' }` | 202 `{ results: [{ id, ok, error? }] }` | `batch_not_safe` (any id not Safe or not `permission`: whole batch refused, `details.ids`) | M3 | drawer "Allow both Safe once", `Alt Shift A` (`U.AllowAllSafe`) |
| POST | `/api/requests/:id/followup` | `{ text }` | 202 | `followup_window_closed` (more than 30 s after a deck deny, state-machines 2.5), `read_only_session`, `deckd_unavailable` | M3 | "Tell Claude what to do instead" |

`AnswerBody`:

```
{ choice: 'allow' | 'allow_always' | 'deny' | 'option' | 'reply',
  optionKey?: string,   // for 'option': the key printed on screen or the AskUserQuestion option number
  text?: string,        // for 'reply': free text, sent as a bracketed paste then \r
  confirm?: boolean }   // Destructive: must be true (the ticked checkbox)
```

Server rules, in this order (state-machines 2.5 and 2.6):

1. Observed session: `read_only_session`.
2. `allow_always` (Claude Code option 2) is accepted only for Safe (the Focus bar hides it for Caution and Destructive): else `tier_forbids`.
3. Destructive without `confirm: true`: `confirm_required`. Destructive is never accepted from `answer-batch` or from a popup.
4. Send guards: `screenMatch` must be `on_screen` (`not_on_screen`), no terminal input within 1 s (`typing_in_terminal`, `retryable: true`), deckd connected (`deckd_unavailable`).
5. A second answer while `sending` or `verifying`: `answer_in_flight`. A new answer while `did_not_land` is `U.TryAgain` and is accepted when the guards pass.

The digit sent is the option key parsed from the screen (`request.options`), never a hard-coded number.

### 2.5 Rules

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| GET | `/api/rules` | query `repoKey` (optional) | `{ threshold, repos: [{ repoKey, repoId, settingsPath, readError?, rules: RuleView[] }] }` | | M3 | Settings Approval rules |
| POST | `/api/rules` | `{ repoKey, pattern, source: 'suggested' \| 'manual' }` | 201 `{ rule: RuleView }` | `invalid_pattern`, `destructive_rule` (pattern matches a Destructive tier entry), `rule_exists`, `settings_io_failed`, `settings_changed` (the file changed twice during the write; nothing written) | M3 | Home and drawer rule suggestion (`U.AcceptRule`), Settings "Add a rule…" |
| DELETE | `/api/rules/:repoKey/:pattern` | pattern URL-encoded as one segment | `{ removed: true }` or `{ removed: false, reason: 'already_removed' }` | `settings_io_failed` | M3 | Settings "Revoke…" (`U.Revoke`), toast "Undo" after accepting a suggestion |
| POST | `/api/rules/suggestions/dismiss` | `{ repoKey, pattern }` | 204 | `not_found` (no offer) | M3 | `U.DismissRule` (state-machines 2.8) |

Writes follow [04-integrations.md](04-integrations.md) 2.4 (re-read, merge, atomic write, retry once).

### 2.6 Repos and crew

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| GET | `/api/repos` | query `archived=1` to include archived | `{ repos: RepoView[] }` | | M1 (avatars), M2 (form) | New session repo combobox, Crew sheet, Settings |
| POST | `/api/repos/rescan` | | 202 `{ found }`, then WS `repo.upserted` per new repo | `settings_io_failed` (scan root unreadable) | M1 | Settings "Rescan" |
| PATCH | `/api/repos/:repoKey/crew` | `{ seed?, slot?, slotShared?, hat? }` (at least one, no other keys) | `{ repo: RepoView }` | `slot_taken`, `validation_failed` | M2 | Crew sheet Reroll, color, hat, Undo |

A slot change runs in one DB transaction ([design/crew.md](design/crew.md) 4.2). `slotShared` is an optional boolean; any other value is 422 `validation_failed` with `fields: ['slotShared']`. With `slot` and `slotShared: true` the server skips the `slot_taken` check and writes the slot as shared; without it, or with `false`, the slot is written exclusive and a slot another repo holds exclusively is 409 `slot_taken`. The Crew sheet's Undo sends the previous `slot` with its previous `slotShared`, so a repo moved off a shared slot gets it back shared.

### 2.7 Preferences

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| GET | `/api/prefs` | | `{ prefs: Prefs, sources: { [key]: 'env' \| 'config' \| 'db' \| 'default' } }` | | M1 | Settings, first paint |
| PATCH | `/api/prefs` | partial `Prefs` | same as GET | `validation_failed`, `read_only_pref` (the value comes from the environment, SET-O1) | M1 | Settings controls, threshold Select |

Which keys live in `config.json` and which in SQLite is [06-storage.md](06-storage.md) section 8; the API hides the split and reports the source per key.

### 2.8 Runs (fleetmates, read only)

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| GET | `/api/runs` | query `repoKey`, `active=1` | `{ runs: Run[] }` | | M1 | Home team cards (also in the snapshot) |
| GET | `/api/runs/:repoKey/:runId` | | `{ run: Run }` | `not_found`, `run_unreadable` (`details.file`, retrying) | M2 | Team run |
| GET | `/api/runs/:repoKey/:runId/plan` | | `{ path, markdown, truncated }` (256 KiB cap) | `not_found` | M2 | Team "Open plan" (TEAM-O5 default: read-only drawer) |
| POST | `/api/open` | `OpenRequest` `{ kind, ref }` | 202 | `validation_failed` (unknown `kind` or malformed `ref`), `path_not_allowed`, `not_found`, `open_failed` (the opener could not be started) | M2 | Team "Open plan" in an external app (`runPlan`); later "Open in Obsidian" (`vaultNote`, `meetingNote`) and "Open log" (`postmeetLog`) (Proposed) |

`/api/open` accepts only the named kinds in [08-security.md](08-security.md) section 4.9, never a raw path or URL: Decided by D-57 (Proposed). The server resolves `ref` to a target, runs the checks listed there, and opens it with `xdg-open` or an `obsidian://` URL.

The deck never writes under `.fleetmates/` (04-integrations 1.2), so there are no run mutations.

### 2.9 Vault and ask (M5)

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| GET | `/api/vault/graph` | query `tags` (comma), `status`, `folder`, `maxNodes` | `VaultGraph` (vault-mcp `vault_graph` structured output, [reference/vault-turbid-contract.md](reference/vault-turbid-contract.md) 1.11) | `vault_unavailable`, `vault_tool_missing` (MEM-O1) | M5 | Memory graph, filter popover |
| GET | `/api/vault/note` | query `path` | `{ note: NoteView, backlinks: NoteRef[], linksOut: NoteRef[], usage: NoteUsage }` | `vault_unavailable`, `vault_error` (`note not found` text verbatim in `details.text`) | M5 | Memory note panel |
| GET | `/api/vault/search` | query `q`, `limit` (default 5) | `{ hits: [{ path, title, line, snippet }] }` | `vault_unavailable` | M5 (palette), M6 (research existing notes) | Research form topic check, palette note rows |
| GET | `/api/vault/list` | query `folder`, `tags`, `tipo` | `{ notes: NoteRef[] }` | `vault_unavailable` | M5 | Browse by MOC, research domain list |
| GET | `/api/vault/captures` | query `day` (`YYYY-MM-DD`, default today) | `{ captures: Capture[] }` | | M5 | Memory Captures tab, Calm "Charts added", recap |
| GET | `/api/misses` | query `resolved` (`0` default, `1`) | `{ misses: Miss[] }` | | M5 | Memory Misses tab, Calm "Unanswered questions" |
| POST | `/api/ask` | `{ threadId?: string, text, scope?: 'vault' \| 'meeting:<id>' }` (no `threadId`: new thread) | 202 `{ thread: AskThread, userMessage: AskMessage, assistantMessageId }`; stream via WS `ask.delta`, `ask.done`, `ask.error` | `validation_failed`, `vault_unavailable` (vault scope), `scribed_unavailable` or `not_recording` (meeting scope), `ask_in_progress` (one ask per thread) | M5 (vault), M4 (meeting scope) | Memory composer, palette `?` (`U.Ask`), live meeting composer |
| POST | `/api/ask/:messageId/cancel` | | 202 | `not_found`, `invalid_state` (already finished) | M5 | "Stop" (`U.StopAsk`) |
| GET | `/api/ask/threads` | query `scope` (default `vault`), `limit` | `{ threads: AskThread[] }` | | M5 | Memory "History" |
| GET | `/api/ask/threads/:id` | | `{ thread: AskThread, messages: AskMessage[] }` | `not_found` | M5 | Memory thread restore |

A `meeting:<id>` ask uses the scribed `ask` engine by default (MEET-O4) and is never stored for a confidential tag ([06-storage.md](06-storage.md) section 10). For the scribed engine the thread and message objects in the response are transient (`persisted: false`).

### 2.10 Research (M6)

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| POST | `/api/research` | `{ topic, preset, domain, newDomain?: boolean, sourceTypes, focusNotes, missId? }` | 201 `{ research: Research }` | `validation_failed` (topic under 3 chars, no source type, empty new domain name), `vault_unavailable`, `deckd_unavailable`, `spawn_failed` | M6 | Research form "Send scouts" (`U.SendScouts`) |
| GET | `/api/research/:id` | | `{ research: Research }` | `not_found` | M6 | Research review and running view |
| POST | `/api/research/:id/preview` | `{ draft?: { body, keptSources: number[] }, confirmNewDomain?: boolean }` | 202 `{ previewId }`; result in WS `research.updated` (`preview` or `previewError`) | `invalid_state` (not `drafted`), `vault_unavailable`, `vault_tool_missing` (no `preview`, RES-O3) | M6 | `T.RePreview`, `U.ConfirmNewDomain` |
| POST | `/api/research/:id/save` | `{ previewId }` | 202; WS `research.updated` with `state: 'saved'` (and `savedPath`, which may differ from the preview, row 20) | `preview_stale` (draft changed after `previewId`, or not the latest preview), `orphan_citations` (row 18, `details.sources`), `vault_unavailable`, `vault_error` | M6 | "Save to vault" (`U.Save`) |
| POST | `/api/research/:id/discard` | | `{ research }` | `invalid_state` | M6 | "Discard" (`U.Discard`) |
| POST | `/api/research/:id/stop` | | 202 `{ research }` | `invalid_state` (not `running`) | M6 | "Stop run…" (`U.StopRun`) |

Save uses exactly the parameters of the preview named by `previewId` without `preview` (Decided: no save without preview).

### 2.11 Meetings (M4)

| Method | Path | Request | Response | Errors | Milestone | Used by |
|---|---|---|---|---|---|---|
| GET | `/api/meetings` | query `before`, `limit` (default 50) | `{ meetings: MeetingListItem[], recorder: Recorder, tags: MeetingTag[], configError? }` | | M4 | Meetings list, Calm "Last meeting" |
| GET | `/api/meetings/:id` | | `{ meeting: Meeting, note: MeetingNote \| null, pins: Pin[] }` | `not_found` | M4 | Meeting detail |
| GET | `/api/meetings/:id/transcript` | | `{ source: 'batch' \| 'live', lines: TranscriptLine[] }`, read from disk on every call, never cached (MEET-O7) | `not_found` | M4 | "Full transcript" drawer |
| GET | `/api/meetings/:id/log` | query `lines` (default 200) | `{ text }` (tail of `postmeet.log`) | `not_found` | M4 | "Open log" |
| GET | `/api/meetings/search` | query `q` (min 2 chars) | `{ hits: [{ meetingId, t0, speaker, snippet }], meetingCount }`, on-demand file scan, no index (MEET-O7) | `validation_failed` | M4 | Meetings search field |
| POST | `/api/meetings/start` | `{ tag }` | 202 `{ recorder }` (`starting`); WS `meeting.status` | `unknown_tag`, `scribed_refused` (scribed message verbatim in `message`), `scribed_unavailable` | M4 | Tag menu (`U.StartWithTag`) |
| POST | `/api/meetings/stop` | | 202 `{ recorder }` (`stopping`); the server does not hold the request for scribed's long `stop` | `not_recording`, `scribed_refused`, `scribed_unavailable` | M4 | "Stop and summarize" (`U.StopAndSummarize`) |
| POST | `/api/meetings/:id/pins` | `{ t?: number }` (default: current `elapsed_s`) | 201 `{ pin: Pin }` or 200 with the existing pin when within 2 s of another | `not_recording`, `not_found` | M4 | "Pin moment", `Alt P`, transcript line click (`U.Pin`) |
| DELETE | `/api/meetings/:id/pins/:pinId` | | 204 | `not_found` | M4 | transcript line click on a pinned line |
| POST | `/api/meetings/:id/items/:itemKey/dismiss` | | 204 | `not_found` | M4 | action item "Dismiss" |
| DELETE | `/api/meetings/:id/items/:itemKey/dismiss` | | 204 | | M4 | toast "Undo" |

The pin label is computed by the server (newest transcript line, first 80 characters) and is `null` for a confidential tag (04-integrations 4.2).

## 3. WebSocket

### 3.1 Connect and hello

URL `ws://127.0.0.1:47800/api/ws`, subprotocols as in section 1. One socket per tab. Message framing:

- **Text frames**: one JSON object each, discriminated by `t`.
- **Binary frames**: terminal data only (section 3.5).

Sequence:

```
browser                                   server
  | -- upgrade (token, Origin) ---------->  |  401 / 403 on failure (state-machines 4.1: token_invalid, origin_rejected)
  | -- { t:'hello', lastSeq, epoch,        |
  |      apiVersion, build } ------------>  |
  |  <------ { t:'welcome', apiVersion,    |
  |            epoch, serverTime, headSeq } |
  |  <------ replay: { t:'replay.begin', from, to }, events (from, to], { t:'replay.end', seq }
  |      or  snapshot: { t:'snapshot', seq, epoch, ... }
  |  <------ live events (seq > seq above), heartbeats
```

- The browser sends `hello` within 5 s of open; otherwise the server closes with 4400.
- `apiVersion` mismatch: close 4410 `client_outdated`; the SPA shows "The deck was updated. Reload" (section 8).
- Replay happens when `epoch` equals the server epoch and `lastSeq` is inside `replayWindow` (last 5,000 events or 10 minutes, state-machines 0.3). Otherwise a snapshot. First load sends `lastSeq: 0, epoch: null` and always gets a snapshot.
- Events produced while the replay is being sent are queued and sent after `replay.end` (state-machines 4.3).
- Heartbeat: the server sends `{ t:'hb', seq: headSeq, at }` every 15 s. The browser treats 30 s of silence as dead (state-machines 4.1) and reconnects with backoff.

Close codes: 4400 bad or missing hello, 4401 token invalid, 4403 origin rejected, 4410 client outdated, 1001 server shutting down (reconnect normally).

### 3.2 Envelope

```
{ t: '<type>', seq?: number, at: number, data: {...} }
```

- **Durable** events carry `seq` (monotonic, persisted in the `events` table, [06-storage.md](06-storage.md) section 4.6) and are replayed. They describe state.
- **Ephemeral** events carry no `seq`, are never stored and never replayed: streams (`ask.delta`, `meeting.transcript`, `screen.tail`), indicators (`input.source`), progress (`setup.check`), UI commands (`ui.navigate`). After a reconnect the snapshot or a REST call recovers what matters.

### 3.3 Snapshot

```
{ t: 'snapshot', seq, epoch, data: {
    sessions: Session[],            // every session not 'ended', plus 'ended' of the last 24 h
    requests: Request[],            // open requests
    runs: Run[],                    // runs with a live lead or active tasks
    repos: RepoView[],
    counts: Counts,
    order: string[],                // urgency order of session ids (home.md 7.3), computed server-side
    recap: Recap,
    ruleOffers: RuleOffer[],
    research: Research[],           // not saved/discarded
    recorder: Recorder,             // meetings recorder state (M4)
    health: Health[],
    prefs: Prefs,
    setup: { firstRunCompletedAt: number | null } } }
```

The browser swaps its store atomically when the snapshot is applied (state-machines 4.3). Nothing the grid shows needs a REST call after the snapshot.

### 3.4 Server events

Durable (carry `seq`):

| Type | `data` | Emitted when | Consumers |
|---|---|---|---|
| `session.upserted` | `Session` (whole object) | any session field change: state, activity, files, branch, `lastInputFrom`, alive | Home, Focus, palette, Team, Rail |
| `session.removed` | `{ id }` | a session row is deleted by retention (never for live sessions) | all lists |
| `session.steps` | `{ sessionId, steps: Step[] }` (appended steps only) | tool step recorded | Home tails, Focus, Team crew panels |
| `request.opened` | `Request` | request created | card, drawer, palette, toasts, bell |
| `request.updated` | `Request` | `delivery`, `screenMatch`, `options`, `tier`, `why` changed | drawer rows, PromptBar |
| `request.closed` | `{ id, sessionId, state: 'answered' \| 'expired', answer, expiredReason }` | request final | all |
| `counts` | `Counts` | after any transaction that changes a count | header chips, Rail badge, drawer subtitle, document title, Team pill |
| `order.changed` | `{ order: string[] }` | urgency order changed | Home grid, Focus list, palette, `Alt 1..9` |
| `run.updated` | `Run` | `status.json` / `plan.json` re-read, teammate join changed. The server watches every run directory a run list has found and re-reads after a change (debounced, about 250 ms), with a 60 s poll as the fallback; it publishes only runs whose data changed. When it starts listening the server primes: it lists the runs, which arms the watchers, and records each run's data as the baseline without publishing; later reads publish only changed runs. If the priming list fails, the next successful read publishes every run once | team card, Team |
| `run.derived` | `{ repoId, runId, derivedPhase, phases }` | slow git derive finished | Team phases |
| `repo.upserted` | `RepoView` | new repo, crew change, archive | every avatar |
| `rule.upserted` | `RuleView` | rule written or found in a settings file | Settings |
| `rule.removed` | `{ repoId, pattern }` | revoke or external removal | Settings |
| `rule.offered` | `RuleOffer` | a rule machine enters `offered` | card suggestion line, drawer |
| `rule.withdrawn` | `{ repoId, pattern }` | offer accepted, dismissed or threshold set to Never | same |
| `research.updated` | `Research` | state, stats, draft, `preview`, `previewError`, `savedPath` | research card, review |
| `meeting.status` | `Recorder` | recorder state change (from the 2 s poll or the deck's own start/stop) | rec bar, Rail dot, quiet mode, Meetings |
| `meeting.updated` | `MeetingListItem` | manifest `state`, `notePath`, `stuck`, `apps` changed | Meetings list and detail |
| `meeting.pin.added` | `Pin & { meetingId }` | pin stored | live view, detail |
| `meeting.pin.removed` | `{ meetingId, id }` | unpin | same |
| `health.changed` | `Health` | dependency machine transition (state-machines 5) | banners, degraded cards, Settings |
| `recap` | `Recap` | recap values change | Home subtitle, Calm |
| `misses.changed` | `{ unresolved }` | miss inserted or resolved | Memory tab count |
| `captures.changed` | `{ day, count }` | capture recorded | Memory tab count, recap |
| `vault.changed` | `{ reason: 'deck_write' \| 'poll' }` | after a deck vault write or a changed graph on the 60 s poll | Memory refetches `/api/vault/graph` |
| `prefs.changed` | `{ prefs, sources }` | prefs saved (other tabs update) | Settings, appearance |
| `notify.failed` | `{ stderr, exitCode }` | first failure per server run | toast |

Ephemeral (no `seq`):

| Type | `data` | Notes |
|---|---|---|
| `setup.check` | `SetupCheck` | one per check result, first run and Settings |
| `ask.delta` | `{ threadId, messageId, text }` | appended text |
| `ask.done` | `{ threadId, message: AskMessage }` | final message with citations, `isMiss`, `generalKnowledge` |
| `ask.error` | `{ threadId, messageId, error: ApiError }` | |
| `meeting.transcript` | `{ meetingId, line: TranscriptLine }` | live lines from scribed `subscribe`; never persisted, for any tag |
| `screen.tail` | `{ sessionId, lines: string[] }` | compact card tails (M2), ANSI stripped, at most 1 per second per session, only while a Home compact view is subscribed (`sub.tails`, 3.6) |
| `input.source` | `{ sessionId, state: 'quiet' \| 'terminal_active' \| 'browser_active' \| 'collision', from: 'terminal' \| 'browser' \| null, name: string \| null, detached: boolean }` | shared input machine (state-machines 3); drives "Last typed from: terminal (kitty)" and the collision chip. `detached` is true once the last `fm` terminal client of the PTY has detached (M2) |
| `ui.navigate` | `{ path }` | notification "Open" action (04-integrations 5); only the most recently focused tab obeys |
| `hb` | `{ seq, at }` | heartbeat |
| `error` | `ApiError` | a client message was invalid (unknown type, bad attach) |

`Counts` is produced by one query (02-domain 3):

```
{ needYouSessions, running, toReview, openRequests, requestSessions, oldestRequestAt,
  perRun: [{ repoId, runId, needYou, total }] }
```

`openRequests` and `requestSessions` feed "4 requests from 3 ships"; `needYouSessions` feeds "3 need you". A team counts once in the three chips, under its most urgent state (02-domain 3).

### 3.5 Terminal channel (M2)

One WebSocket carries every terminal the tab has open. Control is JSON; bytes are binary frames.

Client to server (JSON):

| Type | Fields | Effect |
|---|---|---|
| `term.attach` | `{ sessionId, cols, rows }` | server asks deckd for a screen snapshot plus the last 1,000 scrollback lines, sends them as one `snapshot` binary frame, then streams output. Error `no_pty` for observed sessions, `deckd_unavailable` when deckd is down |
| `term.detach` | `{ sessionId }` | stop streaming |
| `term.resize` | `{ sessionId, cols, rows }` | forwarded to deckd with `source: browser`; deckd applies the resize rule (SM-O12: follow the most recent input source, at most once per second) |
| `sub.tails` | `{ sessionIds: string[] }` | subscribe compact tails (replaces the previous set) |

Server to client (JSON): `term.attached { sessionId, ptyId, cols, rows }`, `term.exit { sessionId, code, signal }`, `term.error { sessionId, error }`. `term.error` codes: `validation_failed`, `not_found`, `no_pty`, `deckd_unavailable`, `output_dropped`, and since M2 `not_attached` (an input frame or `term.resize` for a session this socket has not attached) and `payload_too_large` (an input frame over 64 KiB). A deckd rejection of an attach, input or resize maps as follows: deckd `not_found` becomes `no_pty`, a link that is down, closed or timed out becomes `deckd_unavailable`, and any other deckd error code becomes `internal` (`retryable: false`, no `details`).

Binary frame layout (both directions):

```
byte 0      kind: 1 = output (server to browser), 2 = input (browser to server), 3 = snapshot (server to browser)
byte 1      n = length of the session id in bytes (ULID: 26)
bytes 2..   session id (ASCII), then the payload (raw PTY bytes, UTF-8 as the PTY produced it)
```

- An input frame's payload is at most 64 KiB; a larger frame gets `term.error` `payload_too_large` and nothing is written. The server checks, in this order: the frame kind is input, the size, that this socket attached the session, that the session still has that PTY, and that deckd is connected.
- Input frames are sent only while the xterm has focus (state-machines 3.4). The server forwards them to deckd `write` with `source: { kind: 'browser' }`. The resulting `input.source` event and the session's `lastInputFrom` update give the Focus header "Last typed from: browser" and, when the `fm claude` terminal typed last, "Last typed from: terminal (kitty)" (Decided indicator).
- Paste over 4 KB is confirmed in the SPA before sending (state-machines 3.5); the server does not re-check.
- The server never interprets input bytes; the approval guards apply only to deck-originated keystrokes (answers, Nudge, follow-ups, the launch task), which travel through REST.
- Output is not replayed from the event log; reconnect means a fresh `term.attach` (state-machines 4.3).
- Backpressure: if the socket's `bufferedAmount` for a tab passes 4 MiB, the server drops output for that tab and sends `term.error { error: { code: 'output_dropped' } }`; the SPA re-attaches, which resends the screen.

### 3.6 Other client messages

| Type | Fields | Notes |
|---|---|---|
| `hello` | 3.1 | |
| `ui.focus` | `{ visible, focused, route }` | lets the server skip a desktop popup when the tab shows that session (state-machines 9.3) and pick the tab for `ui.navigate` |
| `bell.played` | `{ sessionId }` | the tab played the Ship's bell; the server then does not play it with `pw-play` (04-integrations 5) |

Every other action is a REST call. The WebSocket never mutates domain state except by terminal input bytes.

## 4. Error model

One JSON shape for every non-2xx response and for `error`, `ask.error`, `term.error`:

```
{ "error": { "code": "not_on_screen", "message": "The terminal is showing a different prompt. Open terminal.",
             "retryable": false, "details": { } } }
```

- `code` is stable and machine-read; the SPA maps it to copy in its i18n catalog. `message` is an English fallback for logs and for codes the SPA does not know.
- Messages from scribed and vault-mcp are passed through verbatim in `details.text` (Portuguese for scribed; 04-integrations 4.1) and shown as the screens specify ("scribed refused: <message>").
- `retryable: true` means the same request may succeed unchanged later.

| Code | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | token missing or wrong |
| `forbidden_host` | 403, 421 | Host header not `127.0.0.1:<port>`; 421 with a `Location` to `127.0.0.1` when it is `localhost:<port>` |
| `forbidden_origin` | 403 | Origin not the deck's own |
| `not_found` | 404 | entity or route unknown (`details.entity`) |
| `payload_too_large` | 413 | body over 256 KiB; on the WebSocket, an input frame over 64 KiB |
| `unsupported_media_type` | 415 | body without `application/json` |
| `validation_failed` | 422 | body or query invalid (`details.fields`) |
| `invalid_state` | 409 | action not allowed in the entity's current state (`details.state`) |
| `precondition_failed` | 409 | a required setup step is missing (hooks for Set sail) |
| `read_only_session` | 409 | observed session: no PTY, answer in the terminal |
| `request_closed` | 409 | request already answered or expired |
| `answer_in_flight` | 409 | an answer is being sent or verified |
| `not_on_screen` | 409 | screen shows another prompt or cannot be read |
| `typing_in_terminal` | 409 | terminal input within the typing guard (retryable) |
| `confirm_required` | 422 | Destructive answer without `confirm: true` |
| `tier_forbids` | 403 | the tier does not allow this path (option 2 outside Safe) |
| `batch_not_safe` | 422 | batch contains a non-Safe or non-permission request |
| `followup_window_closed` | 409 | follow-up more than 30 s after the deny |
| `invalid_pattern` | 422 | not Claude Code permission syntax |
| `destructive_rule` | 422 | Destructive commands can never become rules (Decided) |
| `rule_exists` | 409 | pattern already in the file |
| `settings_changed` | 409 | settings file changed during the write twice; nothing written (retryable) |
| `settings_io_failed` | 500 | read or write of a settings file failed (`details.path`, `details.errno`) |
| `slot_taken` | 409 | crew slot not free |
| `read_only_pref` | 409 | preference set by the environment |
| `path_not_allowed` | 403 | `/api/open` target resolves outside its root or fails the file checks of 08-security 4.9 |
| `run_unreadable` | 502 | fleetmates files could not be parsed after retries (retryable) |
| `deckd_unavailable` | 503 | deckd not connected (retryable) |
| `vault_unavailable` | 503 | vault-mcp down (retryable) |
| `scribed_unavailable` | 503 | no scribed socket (retryable) |
| `vault_tool_missing` | 501 | vault-mcp lacks `vault_graph` or `preview` (`details.tool`) |
| `vault_error` | 502 | vault-mcp returned `isError` (`details.tool`, `details.text` verbatim) |
| `scribed_refused` | 409 | scribed answered `error` (`details.text` verbatim) |
| `unknown_tag` | 422 | tag not in `synthesis.tag_policies` |
| `not_recording` | 409 | meeting action needs an active recording |
| `spawn_failed` | 502 | deckd could not spawn `claude` (`details.stderr`) |
| `dependency_start_failed` | 502 | starting deckd or scribed failed |
| `notify_failed` | 502 | `notify-send` missing or non-zero |
| `open_failed` | 502 | `/api/open` could not start the opener (`xdg-open` missing or not executable) (M2) |
| `preview_stale` | 409 | save with a preview that no longer matches the draft |
| `orphan_citations` | 422 | a sentence cites an unchecked source |
| `ask_in_progress` | 409 | the thread already has an ask running |
| `no_pty` | 409 | terminal attach on an observed session (WebSocket only) |
| `output_dropped` | n/a | terminal output dropped for backpressure (WebSocket only) |
| `not_attached` | n/a | terminal input or resize for a session the socket has not attached (WebSocket only, M2) |
| `internal` | 500 | bug; logged with a request id in `details.requestId`. Also a `term.error` code (section 3.5) for a deckd rejection the bridge does not map to `no_pty` or `deckd_unavailable` |

## 5. Web server to deckd protocol (Proposed)

deckd listens on `$XDG_RUNTIME_DIR/fleetmates-deck/deckd.sock` (dir 0700, socket 0600, [03-architecture.md](03-architecture.md) 2.1 and 5). Clients: the web server (one long-lived connection) and `fm` terminal clients. The file modes are the authentication: the 0700 directory and the 0600 socket are the control, and deckd refuses to start in a runtime directory with group or world permission bits. deckd does not check the peer's uid, because Node cannot read peer credentials (`SO_PEERCRED`) without a native addon (owner decision, 2026-10-01).

### 5.1 Framing

- One UTF-8 JSON object per line (`\n`), like scribed.
- Requests carry `id` (client-chosen integer) and `op`; responses echo `id` with `ok: true` plus fields, or `ok: false, error: { code, message }`. Events carry `ev` and no `id`.
- Byte payloads (output, input, scrollback) are base64 in `data`. On loopback the 33% overhead is well inside the 50 ms echo budget (03-architecture 7); API-O4 tracks a binary framing if measurement says otherwise.
- deckd never blocks on a slow client: per-client output queue capped at 8 MiB, then it drops output for that client and sends `ev: 'dropped'`; the client re-requests a `screen`.

### 5.2 Operations

| op | Request | Response | Notes |
|---|---|---|---|
| `hello` | `{ proto: 2, client: { kind: 'server' \| 'terminal', name?, pid } }` | `{ proto, deckdVersion, bootId }`, plus `loginEnvNames: string[]` at proto 2 | first message; deckd answers the lower of the asked `proto` and its own (2 since M2); a `proto` that is not an integer of at least 1 gets `unsupported_proto`. `bootId` changes when deckd restarts (all PTYs lost). `loginEnvNames` lists, sorted and at most 200, the names (never the values) of variables in the login environment that `launched` sessions start from which are new or differ from deckd's own service environment; `fleetmates-deck doctor` prints them |
| `spawn` | `{ cwd, argv, env, cols, rows, origin: 'wrapped' \| 'launched' }` | `{ ptyId, pid, startedAt }` | deckd adds `FLEETMATES_DECK_PTY=<ptyId>` to `env`. `argv` is `['claude', ...]`; deckd refuses any other executable name (`spawn_refused`) |
| `list` | | `{ ptys: [{ ptyId, pid, origin, cwd, argv, cols, rows, startedAt, clients: [{ kind, name }], lastInputFrom, lastInputAt }] }` | reconciliation (state-machines 1.4 rule 5) |
| `exits` | `{ since }` | `{ exits: [{ ptyId, code, signal, at, tail }] }` | PTYs that exited while the server was away; kept 24 h in memory. `tail` (proto 2 only) is the base64 of the PTY's last 1,000 output lines, cut to at most 256 KiB at a line start; the server stores it in `session_scrollback` ([06-storage.md](06-storage.md)) for the ended session |
| `attach` | `{ ptyId, stream: boolean }` | `{ cols, rows }` | subscribe to `output` for this PTY. The server attaches once per PTY and fans out to browsers |
| `detach` | `{ ptyId }` | `{}` | |
| `screen` | `{ ptyId, scrollback: number }` | `{ rev, cols, rows, cursor: { x, y }, lines: string[], scrollback: string }` | `lines`: visible screen as plain text rows (for parsing); `scrollback`: raw bytes (base64) for xterm replay |
| `watchScreen` | `{ ptyId, on: boolean }` | `{}` | turn on `screen` events for parsing (section 5.4) |
| `write` | `{ ptyId, data, source: { kind: 'browser' \| 'deck' \| 'terminal', name? } }` | `{ at }` | `deck` = keystrokes the server generated (answers, Nudge, launch task); counted as browser in the shared input machine (state-machines 3.2 `I.DeckKeys`) |
| `resize` | `{ ptyId, cols, rows, source }` | `{ cols, rows }` | deckd applies SM-O12 |
| `kill` | `{ ptyId, signal: 'SIGTERM', graceMs: 5000 }` | `{}` | SIGTERM to the process group, SIGKILL after `graceMs` (row 50) |
| `ping` | | `{ at }` | heartbeat every 5 s; 3 missed = link down (state-machines 4.2) |

### 5.3 Events

| ev | Fields | Maps to |
|---|---|---|
| `spawned` | `{ ptyId, pid, origin, cwd, argv, startedAt }` | `P.Spawned` (for `fm claude`, which spawns through deckd directly) |
| `output` | `{ ptyId, data }` | terminal stream to browsers; not activity by itself |
| `exit` | `{ ptyId, code, signal, at }` | `P.Exit` |
| `screen` | `{ ptyId, rev, lines: string[], cursor, changedRows: number[] }` | input to the server's screen parsers (5.4) |
| `input` | `{ ptyId, source: { kind, name }, at, bytes }` | `I.TerminalBytes`, `I.BrowserBytes`, `I.DeckKeys` (byte count only, never content) |
| `client` | `{ ptyId, change: 'attached' \| 'detached', client: { kind, name } }` | `I.ClientAttached`, `I.ClientDetached` |
| `dropped` | `{ ptyId, bytes }` | the client must re-request `screen` |

### 5.4 Where screen parsing happens

deckd keeps the headless terminal model (03-architecture 2.1) and sends `screen` events: the visible rows as plain text, throttled to at most 4 per second per PTY, only for PTYs with `watchScreen` on and only when rows changed. The **web server** runs the parsers (permission prompt with its numbered options, idle input box, status and spinner region; 04-integrations 2.3) and turns the results into `S.PromptVisible(options)`, `S.PromptGone`, `S.ScreenIdle` and counted `P.Output` activity (a change in `changedRows` outside the status region, state-machines 1.10).

Reason: the parsers are versioned with the Claude Code fixtures and change with every Claude Code release. deckd restarts kill every session (03-architecture 2.1), so deckd must not carry code that changes often. This refines state-machines 0.2, which lists `S.*` as "deckd to web server"; the signals still originate from deckd's screen model. API-O5 tracks confirming it in M0.

### 5.5 Compatibility

deckd is restarted rarely (it kills sessions), so a newer web server must speak the protocol of the deckd that is already running: the server supports `proto` N and N-1 and shows "deckd is older than the deck; restart it when no session is running" in Settings, Connections when they differ. `fm` clients use the same `hello` negotiation.

As built in M2 (`proto` 2): the deckd `Health` row is `ok` with reason `deckd_outdated` when the agreed `proto` is lower than the server's (the link works, without exit tails), and `down` with reason `deckd_incompatible` when deckd answers `hello` with an error; a deckd that cannot be reached is `down` with `deckd_unavailable`. While connected the row also carries `deckdVersion`, the version deckd reported in `hello`.

## 6. deck-hook envelope and spool

Source: [03-architecture.md](03-architecture.md) 2.3 and 4.2, [04-integrations.md](04-integrations.md) 2.1, [interaction/state-machines.md](interaction/state-machines.md) 1.3 and 1.4.

### 6.1 Envelope (one JSON line)

```
{ "v": 1,
  "deckHookVersion": "0.1.0",
  "hookTs": 1790000000123,              // ms, taken when the script starts
  "ptyId": "01J...",                     // $FLEETMATES_DECK_PTY, or null
  "claudePid": 48213,                    // first `claude` process in the parent chain, or null (SM-O1)
  "pidChain": [48220, 48213, 3120],      // hook pid up to the first non-claude ancestor, max 8
  "truncated": false,                    // true when a string field was cut (below)
  "hook": { ...payload exactly as received on stdin... } }
```

- The payload is not reshaped. The server validates only the fields listed in 04-integrations 2.1 (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, and per event `source`, `reason`, `tool_name`, `tool_input`, `notification_type`, `stop_hook_active`); an envelope that fails goes to `rejected_events` ([06-storage.md](06-storage.md) 4.7) and is never applied (state-machines 1.11 item 13).
- Any string in `hook.tool_input` longer than 64 KiB is cut to 64 KiB with a `…[truncated N bytes]` suffix and `truncated: true` (a `Write` of a large file otherwise produces multi-megabyte lines). `matchKey` hashing on the server uses the truncated input on both sides, so matching still works.
- The whole line is capped at 1 MiB after truncation; beyond that the hook drops `tool_input` entirely and sets `truncated: true`.
- Dedupe key on the server: `(hook.session_id, hook.hook_event_name, hookTs, sha1(canonical hook))` (state-machines 1.4 rule 3).

### 6.2 Delivery

1. Connect to `$XDG_RUNTIME_DIR/fleetmates-deck/hooks.sock` with a 100 ms timeout, write the line, half-close, exit 0. No response is read.
2. On any error (no socket, refused, timeout, `XDG_RUNTIME_DIR` unset) append the line to `~/.local/state/fleetmates/deck/spool/hooks-<yyyymmdd>.jsonl` (file 0600, dir 0700) with a single `write` on an `O_APPEND` descriptor, exit 0.
3. Total budget 200 ms (03-architecture 2.3). The budget covers the hook's own run, from the moment its module starts loading to process exit, not Node's interpreter boot before it (owner decision 2026-10-02, D-70). `hub/test/contract/hooks.test.mjs` measures that span with an `--import` preload that writes a clock line before the hook module loads and another at exit, for a hook that finishes quickly. The script's own 200 ms exit timer bounds a hook that stalls; no test pins that timer at 200 ms yet (m2-exit section 11.2). Never print to stdout or stderr; always exit 0.

No token: the socket and the spool are 0600 in 0700 directories, owned by the user; the browser never reaches them (03-architecture 2.2).

### 6.3 Spool drain (server)

- On start, before accepting browsers (03-architecture 4.4), and then every 60 s: for each spool file, rename it to `<name>.draining`, read every line, feed them to ingest sorted by `hookTs`, then delete the `.draining` file. A partial or unparseable line goes to `rejected_events`.
- Renaming first means a hook that appends during the drain writes to a fresh file, which the next drain picks up.
- Spooled events pass the same reorder buffer and late-event rule as live ones; the dedupe key makes a double delivery harmless.

## 7. JSDoc typedefs

For `hub/server/api/types.mjs`, imported by the server and (through a shared module) by the SPA. Field names follow 02-domain; `(Proposed field)` marks additions listed in [06-storage.md](06-storage.md) section 12.

```js
/** @typedef {'starting'|'running'|'needs_approval'|'asked_you'|'done'|'stale'|'idle'|'reviewed'|'crashed'|'ended'} SessionState */
/** @typedef {'safe'|'caution'|'destructive'} Tier */

/**
 * @typedef {object} RepoView
 * @property {string} id            realpath of the repo root
 * @property {string} repoId        same as id
 * @property {string} name          display name, disambiguated (`work/api`); used as repoKey
 * @property {string} repoKey       same as name
 * @property {{slot: number, slotShared: boolean, seed: string, hat: 'none'|'cap'|'bandana'}} crew   slot 0..8; slotShared (Proposed field, design/crew.md 4.3)
 * @property {number} firstSeenAt
 * @property {number|null} missingSince  (Proposed field)
 * @property {number|null} archivedAt  (Proposed field)
 * @property {number|null} lastSessionAt  derived: newest session start in this repo (M2)
 * @property {string|null} branch   current branch of the repo root, null when detached or unreadable (M2)
 */

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string|null} claudeSessionId
 * @property {string[]} sessionAliases   earlier Claude session ids (02-domain `session_aliases`)
 * @property {'wrapped'|'launched'|'observed'} origin
 * @property {string|null} ptyId
 * @property {string} repoId
 * @property {string} cwd
 * @property {string|null} branch
 * @property {string} task
 * @property {{repoId: string, runId: string, taskId: string}|null} runRef
 * @property {'solo'|'lead'|'teammate'|'research'} role
 * @property {SessionState} state
 * @property {number} stateSince
 * @property {number} lastActivityAt
 * @property {boolean} alive
 * @property {string|null} processKey
 * @property {string|null} activity        `compacting`, `tool:<name>`, `subagents:<n>`
 * @property {number} subagentsActive      (Proposed field, state-machines 12.6)
 * @property {string|null} reviewBaseline   the baseline commit sha (40 to 64 lowercase hex) of the review, null outside git or before one is taken; the stored `sessions.review_baseline` also holds file contents, which never leave the server (M2)
 * @property {boolean} joinedMidLife
 * @property {'exit'|'signal'|'lost'|null} crashKind
 * @property {string|null} exitSignal
 * @property {number|null} exitCode
 * @property {'terminal'|'browser'|null} lastInputFrom
 * @property {string|null} lastInputName   terminal name, `kitty` (Proposed field: 02-domain folds it into lastInputFrom)
 * @property {string|null} transcriptPath
 * @property {{path: string, adds: number, dels: number}[]} changedFiles
 * @property {number|null} reviewedAt
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {number} toolCalls            derived count of steps (home.md "31 tool calls")
 */

/**
 * @typedef {object} Step                   (Proposed entity: home.md `session.steps`)
 * @property {number} seq
 * @property {number} at
 * @property {string} toolName
 * @property {string} line                  one display line, `Update src/combat/damage.rs`
 * @property {number|null} adds
 * @property {number|null} dels
 * @property {'running'|'ok'|'failed'} status
 * @property {string|null} taskId           teammate attribution by cwd
 */

/**
 * @typedef {object} Request
 * @property {string} id
 * @property {string} sessionId
 * @property {'permission'|'question'} kind
 * @property {Tier|null} tier
 * @property {string|null} toolName         null for a notification-only request (Proposed: 02-domain says string)
 * @property {string} summary
 * @property {object} detail                raw tool_input (possibly truncated, 6.1)
 * @property {string|null} why
 * @property {{key: string, label: string}[]} options
 * @property {'open'|'answered'|'expired'} state
 * @property {'process_ended'|'session_replaced'|'interrupted'|'superseded'|null} expiredReason
 * @property {{via: 'browser'|'terminal', choice: string, text?: string}|null} answer
 * @property {'permission_request'|'notification'|'ask_user_question'|'elicitation'|'stop_question'} source
 * @property {string} matchKey
 * @property {'idle'|'sending'|'verifying'|'did_not_land'} delivery
 * @property {'on_screen'|'queued'|'unknown'} screenMatch   (Proposed field: state-machines 12.5, missing in 02-domain)
 * @property {string|null} taskId           (Proposed field: teammate attribution, state-machines 11)
 * @property {number} createdAt
 * @property {number|null} answeredAt
 * @property {number|null} notifiedAt
 * @property {number|null} renotifiedAt
 */

/**
 * @typedef {object} RuleView
 * @property {string} repoId
 * @property {string} pattern
 * @property {'suggested'|'manual'} source
 * @property {number|null} approvalsBefore
 * @property {number|null} createdAt       null when found in the file and not written by the deck (SET-O5)
 * @property {Tier|null} tier              from the matching tiers.json entry
 */

/** @typedef {{repoId: string, pattern: string, count: number, threshold: number}} RuleOffer */

/**
 * @typedef {object} Run
 * @property {string} repoId
 * @property {string} runId
 * @property {'build'|'research'} kind
 * @property {string|null} leadSessionId
 * @property {number|null} derivedPhase
 * @property {number} totalPhases
 * @property {number|null} maxParallel
 * @property {string|null} planPath
 * @property {string|null} runBranch
 * @property {{id: string, title: string, state: string, phase: number|null, files: string[], deps: string[], tier: string|null, startedAt: number|null, blockedBy: string|null}[]} tasks
 * @property {Record<string, {verdict: 'PASS'|'FAIL', failed: string[], optionalFailed: string[], skipped: string[], pending: string[], phase: number, phaseName: string|null, recordedAt: number}>} gates
 * @property {{taskId: string, sessionId: string|null, state: string, liveness: string|null}[]} teammates
 * @property {{file: string, message: string}|null} readError
 */

/**
 * @typedef {object} Meeting
 * @property {string} id                    TurbidAssist session_id
 * @property {string} tag
 * @property {boolean} confidential
 * @property {'recording'|'stopping'|'recorded'|'transcribed'|'awaiting_names'|'synthesized'} state
 * @property {number|null} startedAt
 * @property {number|null} endedAt
 * @property {string|null} notePath
 * @property {string[]} apps
 * @property {boolean} stuck                deck-derived (state-machines 6.4)
 */
/** @typedef {Meeting & {title: string, actionItemCount: number|null}} MeetingListItem */
/** @typedef {{summary: string, decisions: string[], actionItems: {key: string, text: string, owner: string|null, dismissed: boolean}[]}} MeetingNote */
/** @typedef {{id: string, t: number, label: string|null, createdAt: number}} Pin */
/** @typedef {{t0: number, t1: number, speaker: string, text: string}} TranscriptLine */
/** @typedef {{tag: string, confidential: boolean, isDefault: boolean}} MeetingTag */
/** @typedef {{state: 'unavailable'|'idle'|'starting'|'recording'|'stopping'|'error', meetingId: string|null, tag: string|null, elapsedS: number, apps: string[], quiet: boolean}} Recorder */

/** @typedef {{id: string, title: string, scope: string, createdAt: number, persisted?: boolean}} AskThread */
/** @typedef {{path: string, line: number, viaGraph: boolean}} Citation */
/**
 * @typedef {object} AskMessage
 * @property {string} id
 * @property {string} threadId
 * @property {'user'|'assistant'} role
 * @property {string} text
 * @property {Citation[]} citations
 * @property {string|null} generalKnowledge
 * @property {boolean} isMiss
 * @property {'complete'|'cancelled'|'error'} status   (Proposed field)
 * @property {number} createdAt
 */
/** @typedef {{id: string, question: string, threadId: string|null, searchedTerms: string[], createdAt: number, resolvedBy: string|null}} Miss */
/** @typedef {{path: string, title: string, capturedAt: number, sessionId: string|null, repoId: string|null, via: 'vault_learn'|'research'|'frontmatter'}} Capture */
/** @typedef {{path: string, title: string, tipo?: string|null, domain?: string|null, atualizado?: string|null}} NoteRef */
/** @typedef {{path: string, title: string, frontmatter: object, body: string}} NoteView */
/** @typedef {{citedIn: {threadId: string, title: string, at: number}[], readBy: {sessionId: string, repoId: string, at: number, tool: string}[]}} NoteUsage */

/**
 * @typedef {object} Research
 * @property {string} id                    fleetmates run id `research-<slug>-<yyyymmdd>`
 * @property {string} topic
 * @property {'quick'|'standard'|'deep'} preset
 * @property {string} domain
 * @property {string[]} sourceTypes
 * @property {string[]} focusNotes
 * @property {string[]} existingNotes
 * @property {'running'|'drafted'|'saved'|'discarded'|'failed'} state
 * @property {{body: string, frontmatter: object, sources: {n: number, url: string, title: string, why: string, backs: string[], kept: boolean}[], rejected: {url: string, reason: string}[]}|null} draft
 * @property {object|null} preview          last vault_learn dry-run result (vault-turbid-contract 1.10 LearnPreview)
 * @property {string|null} previewId        (Proposed field)
 * @property {ApiError|null} previewError   (Proposed field)
 * @property {string|null} repoId           (Proposed field, RES-O6)
 * @property {string|null} leadSessionId    (Proposed field)
 * @property {string|null} savedPath        (Proposed field)
 * @property {string|null} failure          (Proposed field)
 * @property {number} createdAt
 */

/** @typedef {{voyages: number, madePort: number, chartsAdded: number|null}} Recap */
/** @typedef {{kind: 'vaultNote', ref: string}|{kind: 'meetingNote', ref: string}|{kind: 'runPlan', ref: {repoId: string, runId: string}}|{kind: 'postmeetLog', ref: string}} OpenRequest   (vaultNote: vault-relative path; meetingNote and postmeetLog: meeting id) */
/** @typedef {{needYouSessions: number, running: number, toReview: number, openRequests: number, requestSessions: number, oldestRequestAt: number|null, perRun: {repoId: string, runId: string, needYou: number, total: number}[]}} Counts */
/** @typedef {{dep: 'deckd'|'hooks'|'vault-mcp'|'scribed'|'notify'|'fleetmates', state: 'unknown'|'checking'|'ok'|'warn'|'degraded'|'down', reason: string|null, since: number, nextProbeAt: number|null, attempt: number, deckdVersion?: string}} Health */
/** @typedef {{id: 'claude'|'hooks'|'deckd'|'vault'|'scribed'|'notify', state: 'pending'|'checking'|'ok'|'warn'|'failed'|'optional_skipped', blocking: boolean, detail: string|null, error: string|null}} SetupCheck */   (warn: Claude Code newer than the tested version, state-machines 10.2)

/**
 * @typedef {object} Prefs
 * @property {5|3|null} ruleSuggestAfter    null = Never
 * @property {13|14|15|16} textSize
 * @property {'system'|'reduce'} motion
 * @property {boolean} terminalScreenReader
 * @property {boolean} bell
 * @property {5|10|20|null} renotifyAfter   minutes; null = Never
 * @property {boolean} notifyDone
 * @property {boolean} quietInMeetings
 * @property {boolean} notifyCrash
 * @property {string} scanRoot
 * @property {string|null} obsidianVaultName
 * @property {string|null} turbidassistConfig
 * @property {'en'|'pt'} lang               read-only when DECK_LANG is set
 * @property {number} staleMinutes          read-only in v1
 */

/** @typedef {{code: string, message: string, retryable: boolean, details?: object}} ApiError */
/**
 * @typedef {object} SessionSummary        (Proposed entity: the forever row, 06-storage.md 4.3)
 * @property {string} sessionId
 * @property {string} repoId
 * @property {string} repoName
 * @property {string|null} branch
 * @property {string} task
 * @property {'wrapped'|'launched'|'observed'} origin
 * @property {'solo'|'lead'|'teammate'|'research'} role
 * @property {'ended'|'stopped'|'crashed'|'lost'} outcome
 * @property {number|null} exitCode
 * @property {string|null} exitSignal
 * @property {number} startedAt
 * @property {number} endedAt
 * @property {number} durationMs
 * @property {number|null} reviewedAt
 * @property {string|null} runId
 * @property {string|null} gateResult       latest recorded gate verdict of the run at end, `PASS` or `FAIL`
 * @property {number} filesChanged
 * @property {number} adds
 * @property {number} dels
 * @property {string[]} claudeSessionIds
 * @property {string|null} transcriptPath   link to Claude Code's own transcript (Decided: link, never copy)
 */
```

`Health` reasons added in M2: for `deckd`, `deckd_outdated` (state `ok`), `deckd_incompatible` and `deckd_unavailable` (state `down`), with `deckdVersion` while connected (section 5.5); for `hooks`, `hooks_missing` (`~/.claude/settings.json` does not list the deck's hook command for every observed event, or cannot be read) and `hook_script_missing` (the hook script is not a readable regular file), both with state `down`. The server computes the `hooks` row at start and again after every repo rescan, and the New session form reads it. Also on `hooks`, `hooks_outdated` with state `warn` (M2): an accepted hook envelope whose `deckHookVersion` is older than the server's package version, or missing or not a semver string, sets it, published once as `health.changed`; the event itself is still accepted. It clears after 3 consecutive envelopes at the current version or newer, or after a successful `POST /api/setup/hooks`. `hooks_missing` and `hook_script_missing` take priority over it. `deck-hook.mjs` reads the version it stamps from the `package.json` one directory above it (`null` when that file cannot be read), and `fleetmates-deck init` writes a `package.json` holding only the hub version next to the installed hook's directory for that reason. Settings, Connections shows a hint for `hooks_outdated`.

## 8. Versioning (Proposed)

- The SPA and the web server ship in one package and one build, so the REST and WebSocket API is **unversioned in the path** (`/api/...`). `apiVersion` is an integer served by `/api/version` and in `welcome`. It changes only on a breaking change to a shape the SPA reads.
- A tab left open across an upgrade sends its build's `apiVersion` in `hello`; on mismatch the server closes with 4410 and the SPA shows a full-page "The deck was updated. Reload" with a Reload button. A REST call from such a tab carries `X-Deck-Api: <n>`; on mismatch the server answers 409 `invalid_state` with `details.reason: 'client_outdated'`.
- Additive changes (new fields, new event types, new endpoints) do not bump `apiVersion`. Clients ignore unknown fields and unknown event types.
- The hook envelope has its own `v` (section 6.1). The server accepts `v` N and N-1 because `deck-hook.mjs` is installed separately (by `fleetmates-deck init`) and can lag after an upgrade; `fleetmates-deck doctor` reports an old hook.
- The deckd protocol has its own `proto` (section 5.5), with N and N-1 support in the server.
- The API is local and private to the deck. If the "remote access with auth" or phone-push items (Later; phone push is D-30) ever expose it, that change introduces a `/api/v2` prefix instead of reusing these rules.

## Open items

Existing items referenced, not repeated: SHELL-O1, SM-O1, SM-O9, SM-O12, SM-O13, SM-O15, SM-O16, TEAM-O5, MEM-O1, MEET-O4, MEET-O7, RES-O3, RES-O6, SET-O1, SET-O2, FAIL-O1.

Closed: the former open item on which targets `POST /api/open` may open. Decided by D-57 (Proposed); see section 2.8.

| ID | Question | Default until decided | Blocks milestone |
|---|---|---|---|
| API-O1 | How does the browser carry the token: `Authorization` header plus a WebSocket subprotocol (this doc), or a cookie? Owned by [08-security.md](08-security.md); 03-architecture now agrees with this doc. | Header for HTTP, `deck.auth.<token>` subprotocol for the WebSocket; no cookie | M1 |
| API-O2 | `repoKey` (display name) in API paths changes when a later repo with the same basename appears (`api` becomes `work/api`). Keep it, or use a stable short repo id in URLs? | `repoKey` in paths, `?repoId=` accepted everywhere, the SPA redirects an unknown `repoKey` through `/api/repos` | M2 |
| API-O4 | deckd wire format: JSON lines with base64 bytes, or a binary framing for output and input? | JSON lines + base64; switch only if the M0 spike misses the 50 ms echo budget | M0 |
| API-O5 | Screen parsing in the web server (deckd sends rows) or in deckd (deckd sends `S.*` signals as state-machines 0.2 reads)? | Web server parses (section 5.4) | M0 |
