# 11 · Meetings

Status labels as in [02-domain.md](02-domain.md). Decided here: meetings are in v1 (M4) with past meetings and summaries, start and stop recording, and live transcript with ask; the deck talks to TurbidAssist through a Node client of the `scribed` Unix socket with contract tests against `protocol.py`; quiet mode during recording is "popups yes, sound no"; meeting content stays PT-BR with chrome in `DECK_LANG`; scribed down degrades only Meetings and past meetings still load. Everything else (client design, storage rules, polling, the TurbidAssist change specs) is **Proposed** unless marked **Open**.

This document covers behaviour, data flow and the changes needed in TurbidAssist. The screens are in [screens/meetings.md](screens/meetings.md); the recorder and post-processing state machines in [interaction/state-machines.md](interaction/state-machines.md) section 6; quiet mode in section 9.5. The wire facts come from [reference/vault-turbid-contract.md](reference/vault-turbid-contract.md) Part 2 and from reading TurbidAssist at commit `d4ffb9d`. Paths below are relative to the TurbidAssist root.

The owner waived the M1 one-week gate for M4 on 2026-10-04 (D-104, superseding that part of D-44): M4 starts after M3, and the M1 week is still pending. The owner's M4 decisions are D-104 to D-111 and the M4 plan's own decisions D-112 to D-124 ([14-decisions.md](14-decisions.md)); this doc states them where they apply.

## 1. Scope

| Feature | Status |
|---|---|
| List past meetings with summaries, decisions, action items | Decided (D-29) |
| Start and stop recording | Decided (D-29) |
| Live transcript and ask Claude during the meeting | Decided (D-29) |
| Transcript search, pin moments, rec bar on every screen | Decided (canvas) |
| Live ask using the vault | **Decided** 2026-10-04 (MEET-O4, D-105): the live ask uses the transcript only, through scribed `ask`, with no citations. TurbidAssist change T3 is not taken and there is no deck-side engine (section 9) |
| Action items: "Launch as session", "Research first", "Dismiss" | Default shipped in 0.4.0, owner may revisit before exit (MEET-O6, Q6): "Launch as session" and "Dismiss" in M4 with deck-only state; "Research first" is not rendered until M6. See section 12 |
| Save answer to meeting note | Default shipped in 0.4.0, owner may revisit before exit (MEET-O8): no button |

## 2. What the deck reads and writes

| Source | Access | Owner | Deck writes? |
|---|---|---|---|
| `$XDG_RUNTIME_DIR/turbidassist.sock` | Unix socket, JSON lines | scribed | commands only |
| TurbidAssist `config.yaml` | read (the deck's YAML subset reader) for `session_dir`, `synthesis.tag_policies`, `synthesis.default_tag`, `vault.meetings_folder`, `batch.model`, `ask.*` | owner | never |
| `<session_dir>/<id>/session.json`, `transcript.jsonl`, `transcript.md`, `transcript.json`, `asks.jsonl`, `postmeet.log`, `postmeet.lock` | read | scribed and postmeet | never |
| Meeting note in the vault (`<vault.meetings_folder>/<date> <tag> <U+2014> <title>.md`) | read from disk only in M4, read only (MTG-O1, D-114); vault-mcp is M5 | postmeet | never |
| `Tasks/Inbox.md` (`vault.tasks_note`) | not read in v1 | postmeet | never |
| Deck SQLite: Meeting rows, pins, action-item dismissals | read and write | deck | yes, see section 6 for what is never stored |

The deck never writes the manifest, never runs `postmeet`, and never edits the meeting note (Proposed; state-machines 6.4).

Config location (Decided 2026-10-04, MEET-O11, D-107): the Settings > Connections field "TurbidAssist config" (a path), whose default is `~/dev/turbidassist/config.yaml` when that file exists; `session_dir` is read from that file. A checkout elsewhere is set in the field. The deck reads `config.yaml` with its own subset reader for the keys above and adds no YAML dependency (D-112, replacing the earlier proposal of the `yaml` package). The deck re-reads the file on change (fs.watch, 1 s debounce) and on "Re-run checklist".

## 3. The scribed Node client

### 3.1 Module and surface (Proposed)

`hub/server/adapters/scribed.mjs`, plain ESM with JSDoc, no dependencies beyond `node:net` and `node:string_decoder`. The client has no `pin` (TurbidAssist change T1 is not taken; pins are deck-stored, section 10) and no `ensureDaemon`: starting scribed lives in `hub/server/meetings/start-scribed.mjs` (section 3.5).

```js
/** @typedef {{ type: 'status', recording: boolean, session_id: string|null, tag: string|null, elapsed_s: number, routed_apps: string[], stopping?: boolean, protocol?: number }} ScribedStatus */
/** @typedef {{ t0: number, t1: number, source: 'mic'|'room', text: string, lang: string, asr_model: string, session_id: string }} TranscriptEvent */

export function createScribedClient({ socketPath, log }) {
  return {
    status,      // () => Promise<ScribedStatus>                         5 s timeout
    start,       // (tag) => Promise<{ session_id }>                     20 s timeout
    stop,        // () => Promise<{ session_id }>                        180 s ceiling
    tail,        // (minutes) => Promise<string>                         5 s timeout
    history,     // () => Promise<{ asks: AskRecord[] }>                 5 s timeout
    ask,         // (question, { onDelta, signal }) => Promise<void>     130 s ceiling
    subscribe    // ({ onStatus, onTranscript, onClose }) => { close }
  }
}
```

Every method rejects with `ScribedUnavailable` (connect `ENOENT`, `ECONNREFUSED`, EOF without an answer, `XDG_RUNTIME_DIR` unset), `ScribedTimeout`, or `ScribedError { cmd, message }` for an `error` event. `message` is Portuguese free text and is shown verbatim, never parsed (contract 2.5).

### 3.2 Framing (Proposed)

| Rule | Why |
|---|---|
| Write `JSON.stringify(cmd) + '\n'` as UTF-8 | protocol: one JSON object per line (`realtime/scribe/protocol.py` 1 to 15) |
| Decode with a `StringDecoder('utf8')` across chunks, split on `\n`, trim each line, skip empty ones | scribed sends raw UTF-8 (`ensure_ascii=False`), a multi-byte character can straddle two chunks |
| Reject a line over 1 MiB, or over 16 MiB for the answer to a `tail` request, and close the connection (D-110) | a `tail` over a long meeting is large but bounded; any other line is small, and anything bigger is a bug |
| `JSON.parse`; a line that is not an object, or has no string `type`, is a protocol error: log it and close that connection (request connections) or reconnect (subscribe) | the reference client raises on bad lines |
| Dispatch on `type` in the closed list `ok, error, status, tail, transcript, ask_delta, ask_done, history`; an event of any other type is ignored and counted, not a protocol error (D-110) | forward compatible: a later TurbidAssist can add an event type without breaking the deck |
| Read only the keys the deck needs; ignore unknown keys | matches scribed's parsers, which lets TurbidAssist add fields without breaking the deck |
| Numbers: accept int or float, reject booleans | `protocol.py` `_get` rule |

### 3.3 Connection model (Proposed; contract 2.2 and 2.14)

- One connection per request, closed after the answer, as the Python reference client does (`realtime/scribe/client.py` `request`). Commands on one connection are processed one at a time; the deck never pipelines.
- One long-lived `subscribe` connection while scribed is reachable, whether or not a meeting is recording: an idle subscription starts receiving `transcript` events when any client starts a session (contract 2.4).
- `ask` gets its own connection per question and reads until `ask_done` or `error`. There is no request id, so never two asks on one connection, and the deck allows one ask in flight per meeting.

| Command | Read timeout | Notes |
|---|---|---|
| `status`, `tail`, `history` | 5 s (reference client default) | |
| `start` | 20 s (`scribedStartTimeout`) | on timeout the next poll decides (state-machines 6.3 row 7) |
| `stop` | no short timeout; 180 s ceiling | scribed joins up to 4 threads at 30 s each (`JOIN_TIMEOUT_S`, `realtime/scribe/daemon.py` 122) before writing the manifest; after the ceiling the call is abandoned and polling decides |
| `ask` | 130 s | scribed kills `claude` after 120 s (`ask.py` `TIMEOUT_S`) and then sends `error` |
| `subscribe` | none | EOF means reconnect |

### 3.4 Reconnect (Proposed)

- Subscribe EOF or error: reconnect after 2 s (the Textual UI's `RECONNECT_S = 2.0`, `realtime/scribe/ui.py` 46), then 2, 4, 8 … 30 s while connects fail. The first message of a new subscription is a `status` snapshot; it is applied like a poll result.
- Gap fill after reconnect while recording: read `<session_dir>/<id>/transcript.jsonl` from disk and append the events with `t1` newer than the last one the deck forwarded (exact events, same schema as the socket). Fallback when the file cannot be read: `tail` with `minutes` = gap rounded up, rendered as plain lines. This refines state-machines 6.3 row 16, which names `tail` only.
- Request connections do not retry on their own except `status` (the poll simply runs again). `start`, `stop` and `ask` are never retried automatically: they are not idempotent from the user's point of view.

### 3.5 Starting scribed ("Start scribed"; Decided 2026-10-04, D-106: SM-O13, FAIL-O1, MEET-O10, OPS-O1)

TurbidAssist ships no systemd unit for `scribed`; its clients spawn it detached when the socket does not answer (`ScribeClient.ensure_daemon()`, `realtime/scribe/client.py` 219 to 247). The deck starts it itself, in `hub/server/meetings/start-scribed.mjs` (not in the socket client), with two Linux details the Python client does not face:

1. **Environment.** The deck web server is a systemd user service, whose environment lacks the owner's shell profile. scribed needs `HF_TOKEN` (or the variable named by `batch.hf_token_env`) when diarization is on, and refuses `start` without it (`daemon.py` 428 to 436). Decided: spawn through the owner's login shell, `$SHELL -l -c 'exec scribed'`, which is the environment the owner gets when running `scribe` by hand.
2. **cgroup.** A child spawned by `fleetmates-deck.service`, even with `setsid`, stays in that service's cgroup, and systemd kills the whole cgroup when the service stops or restarts, which would end a recording in the middle of a meeting. Decided: spawn with `systemd-run --user --collect --unit=turbidassist-scribed --property=KillMode=process $SHELL -l -c 'exec scribed'`, giving scribed its own transient unit; the fixed unit name makes a second start fail fast instead of launching a second daemon. `KillMode=process` also keeps the `postmeet run` that scribed spawns at `stop` alive if that unit is stopped.

The command is started as an argv array with a timeout and without the deck token in its environment (08-security 4.8). It runs exactly as above when the `scribedCommand` setting is the default `scribed`; a custom `scribedCommand` is passed as one argument, `$SHELL -l -c 'exec "$0"' <command>`, so no setting text reaches a shell parser (D-122). Then poll `status` every 100 ms for up to 10 s (the reference client's timeout). TurbidAssist change T4 (a `scribed.service` unit) is not taken (2026-10-04), so there is no `systemctl` branch.

### 3.6 Status polling (Proposed; direction Decided)

`subscribe` sends one `status` and then only `transcript` events; start, stop and `routed_apps` changes are never pushed (`daemon.py` `_fanout` is called only from `_broadcast_transcript`, 850 to 870). So the deck polls `status`.

| Rate | When |
|---|---|
| every 2 s | always while scribed health is `ok` |
| health probe backoff (2 to 60 s) | while scribed is `down` |

The poll runs in the web server, not in the browser, so its rate does not depend on which screen is visible. 2 s everywhere keeps quiet mode timely: a recording started from the Hyprland bind silences the bell within 2 s. [04-integrations.md](04-integrations.md) 4.2 says the same. A status call is one local socket round trip; the cost is negligible.

TurbidAssist change T2 is not taken (2026-10-04), so M4 polls (MTG-O2 default). If T2 lands later (status push, detected by `status.protocol >= 2`), the deck can subscribe with `events: ["transcript", "status", "pin"]` and drops the poll to every 30 s as a safety net.

## 4. Commands used per feature

| Feature | scribed commands | Other sources |
|---|---|---|
| Rec bar, recorder state, quiet mode, "recording started by another client" | `status` poll (or pushed `status` after T2) | |
| Record | `start {tag}` | tags from `config.yaml` |
| Stop and summarize | `stop` | |
| Live transcript | `subscribe` (`transcript` events) | `transcript.jsonl` for gap fill and reload |
| Live ask | `ask {question}` (`ask_delta`, `ask_done`, `error`), `history` when the live view opens | |
| Pin moment | none (deck-stored; TurbidAssist change T1 is not taken) | |
| Timer | `status.elapsed_s` + local ticking | |
| Source label (Teams, Meet, Discord) | `status.routed_apps` while recording (MEET-O1) | |
| Past meetings list | none | `session.json` files, meeting notes |
| Post-processing states | none | `session.json` `state`, `postmeet.log`, `postmeet.lock` |
| Full transcript, search | none | `transcript.md` (batch) or `transcript.jsonl` (live) |
| Start scribed | none (section 3.5) | `systemd-run --user` (D-106) |

`tail` is used only as the gap-fill fallback. The deck never sends `subscribe` on a connection that is also used for other commands (scribed stops reading commands after `subscribe`, `daemon.py` `_dispatch`).

## 5. Tags and `tag_policies`

- `start` requires a tag that is a key of `synthesis.tag_policies`; an unknown tag is refused before any audio is touched (`daemon.py` 416 to 426). There is no protocol command that lists tags, so the deck reads them from `config.yaml` (contract 2.11).
- The Record tag menu lists the keys in file order with `synthesis.default_tag` preselected (screens/meetings.md 4.1). A tag whose policy has `store_transcript: false` is confidential and says "transcript not stored" in the menu.
- If `config.yaml` cannot be read, Record is disabled with "TurbidAssist is not configured for the deck" (screens/meetings.md 5.1). The deck does not guess tags.
- A meeting started by another client carries its tag in `status.tag`; the deck looks up its policy the same way. A tag missing from the current config is treated as confidential, matching postmeet's fail-closed rule (`batch/postmeet/vault.py` `store_transcript`, 138 to 148).

## 6. Confidential tags and what the deck stores

Decided: for a tag with `store_transcript: false` the deck must not persist transcript text (02-domain 2.6, 04-integrations 4.2). Proposed: the deck stores no transcript text for **any** tag, because everything it needs can be read from TurbidAssist's files on demand. One rule is simpler to test than two.

| Data | Non-confidential tag | Confidential tag |
|---|---|---|
| Meeting row: id, tag, state, start, end, duration, apps seen, note path | stored | stored |
| Live transcript lines | memory only (server ring for the current meeting, browser memory) | same |
| Transcript text in SQLite, logs, search index, browser storage | never | never |
| Live ask questions and answers | never stored by the deck; shown from scribed `history` during the meeting and from `asks.jsonl` afterwards | never stored; `asks.jsonl` is read only while the meeting is live |
| Pins | `{ t, label }` (label is at most 80 characters of a transcript line) | `{ t }` only, no label |
| Action-item dismissals | stored with a hash of the item text, not the text (section 12) | same |
| Misses from meeting asks | not created | not created |

Additional rules (Proposed):

- Server logs (the server's stdout and stderr) never include transcript, ask or pin text; they record event types, ids, lengths and error codes only. M4 builds no `DECK_DEBUG` debug log (D-121).
- WebSocket frames carry text, but the browser keeps it in memory only (no `sessionStorage`, no service worker cache).
- "Full transcript" for a confidential meeting is read from disk on each open, never cached (MEET-O7).
- The deck's own hooks never see TurbidAssist's `claude -p` calls: both the live ask and the synthesis run with `--safe-mode` and `--restricted`, which disable hooks and ignore settings files (`batch/postmeet/synthesize.py`, `build_command` docstring). If TurbidAssist change T3 has to drop `--safe-mode`, `--restricted` still keeps user-level hooks out. The deck adds a second guard: ingest ignores hook events whose `cwd` is under `session_dir`.

## 7. Recording flow

The recorder states and transitions are in state-machines 6.2 and 6.3; this is the data flow.

```mermaid
sequenceDiagram
  participant B as Browser
  participant W as deck web server
  participant S as scribed
  participant P as postmeet (spawned by scribed)
  B->>W: POST /api/meetings/start {tag}
  W->>S: {"cmd":"start","tag":"client-a"} (own connection)
  S-->>W: {"type":"ok","cmd":"start","session_id":"2026-09-27T14-00-12"}
  W->>W: Meeting row state=recording; quiet mode on
  W-->>B: ws meeting.status
  S-->>W: transcript events on the subscribe connection
  W-->>B: ws meeting.transcript (memory only)
  B->>W: POST /api/meetings/stop
  W->>S: {"cmd":"stop"} (own connection, up to 180 s)
  S->>S: join threads, write session.json state=recorded
  S->>P: postmeet run <session> (detached)
  S-->>W: {"type":"ok","cmd":"stop","session_id":"..."}
  W->>W: Meeting state=recorded; watch session.json
  P->>P: transcribe, diarize, synthesize, write note
  W-->>B: ws meeting.updated (recorded, transcribed, synthesized)
```

Meetings started or stopped by another client (the `scribe` CLI, the Textual TUI, the `CTRL ALT, SPACE` Hyprland bind in `hyprland/turbidassist.conf`) are picked up by the poll (state-machines 6.3 rows 11, 12, 14). A `session_id` change between two polls closes the previous meeting and joins the new one.

## 8. Live transcript

- Source: `transcript` events on the subscribe connection, one per ASR segment: `{ t0, t1, source, text, lang, asr_model, session_id }` (contract 2.4). Events whose `session_id` is not the current meeting are dropped.
- Server: keeps the current meeting's events in a ring (Proposed cap 10,000 events, about 3 hours of speech) for tabs that open the live view mid-meeting; forwards each event as `meeting.transcript` over the WebSocket. On web server restart the ring is rebuilt from `transcript.jsonl`.
- Rendering: `t0` as `MM:SS` counting total minutes (02-domain 4), `mic` → "Você", `room` → "Sala" (labels as TurbidAssist writes them), text as a text node with `lang="pt-BR"`.
- Meta line: `asr_model` (`medium-int8` shown "medium · int8"), `lang` as configured (not detected, contract 2.10), lag = now − (meeting start + newest `t1`). Meeting start = the wall-clock time of `ok(start)`, or `now − elapsed_s` from the first poll that saw the meeting.
- No partial lines: scribed emits whole segments only; the UI shows "Listening…" after 5 s without a new line (MEET-O5).

## 9. Live ask

### 9.1 Transcript only (Decided 2026-10-04, MEET-O4, D-105)

scribed's `ask` sends `## Transcript recente` (the last `realtime.context_minutes`) plus the question to `claude -p` with **no tools and no MCP servers** (`realtime/scribe/ask.py` `build_command`: `--mcp-config '{"mcpServers": {}}'`, `--tools ""`). It cannot read the vault. The deck therefore:

- sends `{"cmd":"ask","question":...}` on its own connection and streams `ask_delta` to the browser as `ask.delta` with scope `meeting:<id>`, then `ask.done` on `ask_done` or `ask.error` with the Portuguese message verbatim;
- calls `history` when the live view opens, so asks made from the TUI or CLI in the same meeting show up too;
- labels the panel "Ask · uses the transcript" and renders no citations (screens/meetings.md 4.3);
- "Stop" only stops displaying: scribed has no cancel, the `claude` child keeps running until it answers or hits its 120 s watchdog, and scribed records the answer in `asks.jsonl` if it completes. The UI says "Stopped here; the answer may still be saved to the meeting". As built in 0.4.0 the composer stays busy until scribed ends the stopped answer (its `ask.done` or `ask.error`), and `POST /api/ask/:messageId/cancel` stays M5;
- stores nothing (section 6).

### 9.2 With the vault (TurbidAssist change T3, not taken)

The owner did not take T3 on 2026-10-04 (D-105), so M4 builds none of this paragraph; it records what T3 would enable. Once scribed's ask can call vault-mcp (section 16, T3), the deck detects it from `config.yaml` (`ask.vault_mcp` present), switches the eyebrow to "Ask · uses the transcript and your vault", and renders citations: tokens `path:line` in the answer that match a path from the deck's last `vault_list` become Citation chips; anything else stays text.

Alternative considered: a deck-side engine that takes the transcript with `tail` and runs the deck's own Ask engine ([10-memory-and-research.md](10-memory-and-research.md) section 2) with the transcript in the prompt. It works without touching TurbidAssist, but the question and answer would not reach `asks.jsonl`, so they would be missing from the meeting note's "Perguntas ao vivo", and asks from the TUI and the deck would behave differently. Rejected by D-105 (2026-10-04): the live ask is scribed's, transcript only.

## 10. Pins

### 10.1 v1: deck-stored (MEET-O2 default, applied in M4)

- `POST /api/meetings/:id/pins` with `{ t? }` ([05-api.md](05-api.md) 2.11): the button and `Alt P` with no terminal focused send no `t`, and a click on a line sends that line's `t0` as `t` (D-119). The server sets `t = elapsed_s` at the moment of the request when absent, and `label` = the newest line's text, first 80 characters (non-confidential only). As built in 0.4.0 the label is taken from the ring line whose `t0` equals the sent `t` when there is one, else from the newest line. Pins within 2 s merge (state-machines 6.3 row 17).
- Stored in SQLite `meeting_pins { meetingId, t, label | null, createdAt }` ([06-storage.md](06-storage.md)). Shown in the live Pins list and in the detail's "Pinned moments" with the transcript line found at that offset in `transcript.md` or `transcript.jsonl`.
- Limit: postmeet does not know about them, so pins never reach the vault note, and pins made from the TUI do not exist.

### 10.2 After TurbidAssist change T1 (not taken)

The owner did not take T1 on 2026-10-04; M4 builds none of this. When `status.protocol >= 2` and the capability list includes `pin`, the deck sends `{"cmd":"pin","t":..,"label":..}` to scribed instead of storing its own row, reads pins back from `history` (`pins` key) and from `<session>/pins.jsonl` after the meeting, and receives `pin` events on subscribe. Existing deck-stored pins of past meetings stay in SQLite and are shown merged by time. For confidential tags the deck still sends no label (scribed stores its own session files in the 0700 session dir; postmeet decides what reaches the note, section 16 T1).

## 11. Post-meeting processing and reading notes

### 11.1 States (state-machines 6.4)

The deck watches `<session_dir>/<id>/session.json` (fs.watch plus a 10 s poll) from `stop` until `synthesized`. It reads `state` only: `recorded`, `transcribed`, `awaiting_names`, `synthesized`; `stopping` is deck-derived. The `stuck` flag: `postmeet.log` has not grown for 10 minutes, no `postmeet.lock` is held, and the state is not `synthesized` (a failed synthesis leaves the manifest unchanged, contract 2.7). `postmeet.lock` counts as held when its `dev:inode` appears in `/proc/locks`; where `/proc/locks` does not exist (macOS), when the lock file changed within the last 10 minutes (D-115). Sessions that never got a manifest (scribed killed hard) show "Recording interrupted" when their directory has a `transcript.jsonl` but no `session.json`, nothing in it changed for more than 1 hour, and scribed is not recording them (as built in 0.4.0: `interrupted` on `MeetingListItem`, [05-api.md](05-api.md) section 7).

The list is built at start and on change by reading every `session.json` under `session_dir` (one directory per session, `YYYY-MM-DDTHH-MM-SS[-N]`). Rows without a manifest older than 1 hour and not recording are listed as interrupted, not hidden.

### 11.2 Finding and reading the synthesized note

postmeet writes the note directly into the vault, not through vault-mcp: `<vault.path>/<vault.meetings_folder>/<YYYY-MM-DD> <tag> <U+2014> <title>.md`, with ` (<disambiguator>)` before `.md` on a name clash, and frontmatter `tags: [meeting, <tag>]`, `date`, `session_id` (`batch/postmeet/vault.py` 175 to 262).

In M4 the deck reads notes from disk only, read only and limited to `vault.meetings_folder` (MTG-O1, D-114); the vault-mcp client is M5, which may then read through vault-mcp first.

| Step | How (M4) |
|---|---|
| Candidates | list `<vault.path>/<vault.meetings_folder>` on disk, keep files whose name starts with `<date> <tag> ` (date from the session id) |
| Match | read each candidate (its realpath inside the folder's realpath, `O_NOFOLLOW`, a regular file, a size cap); its frontmatter `session_id` must equal the meeting id |
| Cache | `note_path` stored on the Meeting row for a non-confidential meeting only, because the file name embeds the synthesized title (D-116); re-validated when the file is missing. A confidential meeting's note is located again on each read |
| vault-mcp | not used in M4 (M5) |
| Parse | H1 `# <title>`; sections `## Resumo`, `## Decisões`, `## Action items` (the template in `prompts/meeting_summary.md`); placeholders "Nenhuma decisão registrada." and "Nenhum action item registrado." render as the empty lines; `## Transcript` and `## Perguntas ao vivo` callouts are skipped (the deck has its own transcript view) |
| Action items | lines `- [ ] ` under `## Action items`; `owner` = text before the first `:` when that prefix is at most 40 characters and has no sentence punctuation, else none (screens/meetings.md 4.2) |

Everything read from the note is agent-written text and renders as text or sanitised markdown without raw HTML (08-security).

## 12. Action items: Launch as session, Research first, Dismiss

**Scope flag.** The owner did not select "Tasks from meetings" in the scope question, but the canvas (Meetings detail, Home calm) designs "Launch as session", "Research first" and "Dismiss" on action items. M4 applies the default (MEET-O6, HOME-O8, Q6; the owner may revisit before exit): action items are in M4 as designed, with deck-only state.

| Action | Behaviour (M4) | Stored |
|---|---|---|
| Launch as session | opens the new-session form (`/new?task=`) with the item text as the task and the repo picker focused (an action item has no repo); nothing starts until the form is submitted | nothing |
| Research first | not rendered in M4: the research form is M6 ([10-memory-and-research.md](10-memory-and-research.md) 8) | nothing |
| Dismiss | hides the item, "Undo" for 6 s | a dismissal row |

Item state is dismissals only (D-113): `meeting_item_dismissals` ([06-storage.md](06-storage.md) 4.9), keyed by a hash of the normalised item text (not its index) so a re-synthesized note keeps the dismissals of unchanged items. There is no `meeting_item_state` table and no `launched` or `researched` state in M4. The deck never edits the note or `Tasks/Inbox.md` (MTG-O4).

## 13. Quiet mode

Decided: while TurbidAssist is recording, notifications still pop up and no sound plays. Mechanics are in state-machines 9.5: entered when the recorder enters `recording` from any client (via the poll or, after T2, the pushed status), left when it leaves `recording`; no delayed chimes; Settings "quiet in meetings" turns the automatic behaviour off. Two consequences of the data:

- The deck cannot detect a recording while scribed is `down`, so quiet mode is off then (state-machines 6.3 row 2).
- With the 2 s poll the worst case is one bell up to 2 s after a recording starts from another client (section 3.6).

## 14. Search

`GET /api/meetings/search?q=` (debounced 300 ms in the browser). Decided 2026-10-04 (MEET-O7, D-109): confidential meetings are included in search, read from the session files on demand and never indexed, cached or persisted. Implementation: no index, an on-demand scan of each session's batch transcript (as built in 0.4.0: `transcript.json` segments first, else `transcript.md`) or the live `transcript.jsonl`, newest meetings first, case- and accent-insensitive, capped at 2 s of work per query and 200 hits. Confidential meetings are included in results but nothing is cached. As built in 0.4.0 the answer is one JSON body, `{ hits, meetingCount, partial }`, with `partial: true` when the time or hit cap stopped the scan; each hit is `{ meetingId, t0, speaker, snippet, ranges }`, a snippet of at most 160 characters around the match with the `[start, end]` offsets of every match inside it, so the UI marks ranges with `mark` elements without injecting HTML ([05-api.md](05-api.md) 2.11).

## 15. Contract tests (Decided: against `protocol.py` fixtures)

`realtime/scribe/protocol.py` is the single definition of the wire format (its module docstring), but TurbidAssist has no wire fixture files today: `tests/realtime/test_protocol.py` round-trips the dataclasses in Python. The deck needs fixture lines produced by that code.

| Piece | Where | Status |
|---|---|---|
| Fixture exporter | TurbidAssist change T0 (section 16): `scripts/export_protocol_fixtures.py` in TurbidAssist writes `{commands,events,invalid}.jsonl` from the dataclasses' `encode()` | Decided (TEST-O3, D-108); none exists yet (TurbidAssist at d4ffb9d has no exporter) |
| Vendored copy | the exporter's output committed to `hub/test/fixtures/scribed/<turbidassist-sha>/` with a file naming the commit. Until an exporter exists, the contract tests run on the hand-copied `d4ffb9d` set (`MANIFEST.json` `"exporter": null`), with the tag placeholder `acme` (D-111) | Decided (D-108) |
| Drift check | none: CI does not check out TurbidAssist (TEST-O3) | Decided (D-108) |
| Fake scribed | `hub/test/fakes/fake-scribed.mjs`: a Unix socket server that replays fixture lines and scripted scenarios, run inside the test process | M4 |

Test cases (Proposed, all with `node:test`):

1. The client decodes every event fixture, including accents split across chunk boundaries and a line exactly at the size cap.
2. Every command the client can send is JSON that parses equal to the matching command fixture, with raw UTF-8 (not byte-identical, because Python's separators differ; D-120).
3. Invalid lines from `invalid.jsonl` are rejected by the deck parser the same way (not an object, missing `type`, unknown `type`, wrong number type).
4. `error` messages are surfaced verbatim, including the known ones: "sessão já ativa; pare a atual antes", "não há sessão ativa", "tag desconhecida: …", "a sessão anterior ainda está encerrando …".
5. `subscribe`: first `status` then `transcript`; EOF triggers reconnect and gap fill from a fixture `transcript.jsonl`.
6. Recording started and stopped by another client between polls; `session_id` change between two polls.
7. `stop` taking 45 s: no timeout, recorder stays `stopping`, polls reporting `recording:false` are ignored.
8. `ask` stream with deltas, with a single fallback delta, with `error` after deltas.
9. Confidential tag end to end: after a recorded meeting, SQLite, logs and the search cache contain none of the fixture transcript strings.
10. Capability detection: a `status` without `protocol` behaves as today. T1 and T2 are not taken (2026-10-04), so the client has no `pin` and no `events` subscription; an event type outside the closed list is ignored and counted (D-110).

## 16. Proposed TurbidAssist changes

Each is a small, independent PR in the owner's TurbidAssist repo. None is required for M4 to ship; each removes a deck workaround. Order of value: T0, T2, T1, T4, T3. Status (2026-10-04, Q7): T0 is wanted (D-108) but not written, since TurbidAssist at d4ffb9d has no exporter; T1, T2, T3 and T4 are not taken, and the deck keeps its fallbacks (deck-stored pins, the 2 s `status` poll, the transcript-only ask of D-105, `systemd-run` of D-106). The fleet never edits TurbidAssist; any of these is the owner's.

### T0 · Protocol fixtures for other clients (wanted, not written)

| | |
|---|---|
| Why | Decided contract tests need fixture lines produced by `protocol.py`, which is the single source of the wire format |
| Status | Decided 2026-10-04 (TEST-O3, MTG-O3, D-108); none exists yet. Until it does, M4's contract tests run on the hand-copied `d4ffb9d` fixtures and M4 exit criterion 1 is owner-pending |
| Files | new `scripts/export_protocol_fixtures.py` in TurbidAssist; its output (`commands.jsonl`, `events.jsonl`, `invalid.jsonl`) is committed to the deck's `hub/test/fixtures/scribed/<sha>/`; new `tests/realtime/test_protocol_fixtures.py` |
| Change | the script builds one instance of every `Command` and `Event` class in `COMMANDS` and `EVENTS` (with accented text and float and int numbers), writes `encode()` output line by line, and writes invalid lines with the expected `ProtocolError` message prefix. The TurbidAssist test runs the exporter in memory and checks its output against the dataclasses, so a wire change shows up in TurbidAssist's own suite; CI on the deck side does not check out TurbidAssist |
| Compatibility | no runtime change |

### T1 · `pin` command (not taken, 2026-10-04)

| | |
|---|---|
| Why | pins exist only in the deck today (MEET-O2): pins from the TUI or a keybind are impossible and pins never reach the note |
| `realtime/scribe/protocol.py` | `PinCmd` (`CMD = "pin"`, fields `t: float \| None`, `label: str \| None`), added to `COMMANDS` and `__all__`; `PinEvent` (`TYPE = "pin"`, `t`, `label`, `session_id`) added to `EVENTS`; `HistoryResult` gains `pins: list[PinRecord]` (older clients ignore the key: parsers read only their own keys) |
| `realtime/scribe/daemon.py` | `pin(t, label)`: no session → `Error(cmd="pin", message="não há sessão ativa; dê \`start\` antes de marcar")`; `t` defaults to `elapsed_s()`; `label` folded to one line, max 200 characters; append one line to `<session>/pins.jsonl` with the same `O_APPEND`/`O_NOFOLLOW`/0600 pattern as `_record_ask`; fan out `PinEvent` to subscribers that asked for it (T2); `_dispatch` branch; `Session.manifest()` adds `"pins_jsonl": "pins.jsonl"`; `history()` includes pins |
| `realtime/scribe/client.py`, `cli.py` | `ScribeClient.pin()`; `scribe pin [label]` so a Hyprland bind can pin without the TUI |
| `batch/postmeet/vault.py` | when `store_transcript` is true, render `## Momentos marcados` (offset `MM:SS`, label, the transcript line at that offset); when false, render offsets only and run the existing verbatim-leak check (`refuse_verbatim_leak`) over the section |
| Tests | `tests/realtime/test_protocol.py` (round trip, rejection of wrong types), `tests/realtime/test_daemon_manifest.py` (pin while idle, file mode, manifest key), `tests/batch/test_vault_policy.py` (section present or offsets-only by policy) |

### T2 · Status push on `subscribe` (opt-in; not taken, 2026-10-04)

| | |
|---|---|
| Why | subscribers are never told about start, stop or `routed_apps` changes (`_fanout` is called only from `_broadcast_transcript`, `daemon.py` 850 to 870); every client polls every 2 s, and `stopping` is invisible (`status` reports `recording:false` during teardown) |
| `realtime/scribe/protocol.py` | `SubscribeCmd` gains optional `events: list[str] \| None` (subset of `transcript`, `status`, `pin`; default `None` = transcript only, today's behaviour, so the Textual UI is unaffected); `Status` gains `stopping: bool = False` and `protocol: int` (2 after this change; absent means 1) |
| `realtime/scribe/daemon.py` | `status()` reports `stopping` from `self._stopping`; subscribers are stored with their wanted set and `_fanout` filters by event type; a `_push_status()` helper schedules `self.status()` on the loop with `call_soon_threadsafe` and is called after `start` returns `Ok`, when `stop` sets `_stopping`, in `stop`'s `finally`, and from `_route_loop` when `routed_apps()` differs from the last pushed value |
| `realtime/scribe/ui.py` (optional) | subscribe with `events: ["transcript", "status"]` and keep the 2 s poll only as a fallback |
| Tests | `tests/realtime/test_protocol.py` (new fields optional both ways), `tests/realtime/test_daemon_manifest.py` or a new `test_subscribe.py` (a subscriber with `status` sees start, stopping, stop; one without sees only transcript) |
| Compatibility | an old daemon ignores `events` (unknown keys are ignored) and never sends `protocol`; the deck keeps polling in that case |

### T3 · vault-mcp in the live ask (MEET-O4; not taken, D-105)

| | |
|---|---|
| Why | the canvas says the live ask "uses the transcript and your vault"; today the ask has no tools and no MCP |
| `realtime/scribe/config.py` | `AskCfg` gains optional `vault_mcp: { command: str, args: list[str], vault_path: Path }` parsed in `_parse_ask`; absent keeps today's behaviour; `config.example.yaml` documents it commented out |
| `realtime/scribe/ask.py` | `build_command` takes the MCP config: with `vault_mcp`, `--mcp-config` is `{"mcpServers":{"vault":{"type":"stdio","command":…,"args":…,"env":{"VAULT_PATH":…}}}}` and `--allowedTools mcp__vault__vault_search,mcp__vault__vault_get_note,mcp__vault__vault_list,mcp__vault__vault_backlinks` is added; `--tools ""` stays; `DISALLOWED_TOOLS` gains the five vault write tools. `--safe-mode` stays only if the pinned Claude Code still loads `--mcp-config` servers under it (its help lists "MCP servers" among what it disables; same question as KB-O1 in 10-memory-and-research); otherwise the vault variant drops it and keeps `--restricted` |
| `prompts/live_ask_system.md` | cite vault facts as `path:line` from tool results only, keep transcript facts and vault facts apart, search only when the question needs the vault (latency during a call) |
| Timeout | `TIMEOUT_S = 120.0` is kept; the prompt tells the model to make at most two searches |
| Tests | `tests/realtime/test_ask_prompt.py`: argv with and without `vault_mcp`, the variadic-order test still passing, write tools present in the deny list |
| Confidentiality | unchanged: the transcript already goes to `claude` today; vault tools are read-only; `--no-session-persistence` stays |

### T4 · Optional systemd user unit for scribed (SM-O13; not taken, D-106)

| | |
|---|---|
| Why | the canvas "Start scribed" runs `systemctl --user start scribed`; no unit exists (`systemd/` holds only `turbidassist-gc.service` and `.timer`) |
| File | new `systemd/scribed.service`, install notes in its header like `turbidassist-gc.service` |

```ini
[Unit]
Description=TurbidAssist scribed (meeting capture daemon)
After=pipewire.service pipewire-pulse.service
Wants=pipewire.service

[Service]
Type=simple
ExecStart=%h/.local/bin/scribed
EnvironmentFile=-%h/.config/turbidassist/env
Restart=on-abnormal
TimeoutStopSec=180
KillMode=process

[Install]
WantedBy=default.target
```

| Choice | Why |
|---|---|
| `EnvironmentFile` (0600) | a user unit does not get the shell profile; `HF_TOKEN` must be there when diarization is on (`daemon.py` 268 to 297) |
| `Restart=on-abnormal` | restarts after a crash by signal, not after exit 1 (a second instance exits 1 when the socket is live, `daemon.py` 1175 to 1181) or exit 2 (config error) |
| `TimeoutStopSec=180` | SIGTERM during a recording runs a full `stop` first (`serve_forever`, `daemon.py` 1125 to 1150): up to 4 thread joins of 30 s plus the manifest |
| `KillMode=process` | `stop` spawns `postmeet run` detached (`_spawn_batch`), which stays in the unit's cgroup; the default `control-group` would kill the summary job when the unit stops |
| No sandboxing | unlike the gc unit: scribed needs PipeWire, network for `claude -p`, and the vault path for the batch |

T4 is not taken (2026-10-04): "Start scribed" uses the `systemd-run` command of section 3.5 (D-106), and the deck has no `systemctl` branch for a unit.

## 17. Open items

| ID | Question | Default until decided | Blocks milestone |
|---|---|---|---|
| MTG-O1 | Past meeting notes are read from disk when vault-mcp is down, an exception to "the deck reaches the vault only through vault-mcp". Accept? | Default shipped in 0.4.0, still the owner's to revisit before exit: yes, read-only, limited to `vault.meetings_folder`, matched by frontmatter `session_id`; M4 reads notes from disk only (D-114) | M4 before exit |
| MTG-O2 | Take TurbidAssist change T2 (status push, `stopping` visible, `protocol` field)? | Default shipped in 0.4.0: T2 is not taken (2026-10-04), so poll `status` every 2 s | none |
| MTG-O3 | Take TurbidAssist change T0 (fixture exporter), or generate fixtures from the deck's test harness by importing `protocol.py` with Python in CI? | **Decided** 2026-10-04 with TEST-O3 (D-108): T0 in TurbidAssist (`scripts/export_protocol_fixtures.py`, output in `hub/test/fixtures/scribed/<sha>/`); none exists yet, so the contract tests run on the hand-copied `d4ffb9d` fixtures | M4 (decided) |
| MTG-O4 | Should action-item states (dismissed, launched) stay deck-only, or also update `Tasks/Inbox.md`? | Default shipped in 0.4.0, still the owner's to revisit before exit: deck-only; the vault is untouched | none |
| MEET-O1 | Source label not persisted | Default shipped in 0.4.0 (see [screens/meetings.md](screens/meetings.md) 11) | M4 before exit |
| MEET-O2 | Pins not in TurbidAssist | Default shipped in 0.4.0: deck-stored pins; T1 not taken | M4 before exit |
| MEET-O3 | Live meeting title | Default shipped in 0.4.0 (see screens/meetings.md 11) | M4 before exit |
| MEET-O4 | Live ask with vault access | **Decided** 2026-10-04 (D-105): transcript only; T3 not taken | M4 (decided) |
| MEET-O5 | Partial transcript lines | Default shipped in 0.4.0 (see screens/meetings.md 11) | M4 before exit |
| MEET-O6 | "Launch as session" and the other action-item buttons (scope, Q6) | Default shipped in 0.4.0 (see screens/meetings.md 11 and section 12) | M4 before exit |
| MEET-O7 | Transcript search without persisting text | **Decided** 2026-10-04 (D-109): confidential meetings included, read on demand, never indexed, cached or persisted (section 14) | M4 (decided) |
| MEET-O8 | "Save answer to meeting note" | Default shipped in 0.4.0: no button (see screens/meetings.md 11) | M4 before exit |
| MEET-O11 | Location of TurbidAssist `config.yaml` | **Decided** 2026-10-04 (D-107): the Settings field, section 2 | M4 (decided) |
| SM-O13 | "Start scribed": unit or detached spawn | **Decided** 2026-10-04 (D-106): `systemd-run`, section 3.5; T4 not taken | M4 (decided) |
| SM-O14 | In-deck speaker naming for `awaiting_names` | Default shipped in 0.4.0: hint only (see state-machines 13) | M4 before exit |
