# 06 · Storage

Status labels as in [02-domain.md](02-domain.md). Decided here: SQLite as the store, a summary row per session kept forever, the event stream and scrollback dropped after 30 days with a link to Claude Code's own transcript instead of a copy, rules living in each repo's `.claude/settings.local.json`, tier patterns in `~/.config/fleetmates/deck/tiers.json`, the token in a 0600 file, the vault reached only through vault-mcp, and no transcript text stored for confidential meeting tags. The engine pick (`node:sqlite`), every table and column, indexes, the retention job, migrations, backup and reset are **Proposed**.

This document is the schema for the deck web server's database. The browser holds no durable state ([03-architecture.md](03-architecture.md) 2.5) and deckd holds only memory (2.1), so this is the only database in the system.

## 1. Engine

| Item | Choice | Status |
|---|---|---|
| Library | Node 24's built-in `node:sqlite` (`DatabaseSync`), synchronous API. Fallback `better-sqlite3` behind the same small wrapper (`hub/server/db/db.mjs`: `open`, `run`, `get`, `all`, `tx`). Pin the Node minor in CI; some 24.x builds print an experimental warning ([03-architecture.md](03-architecture.md) 3). | Proposed |
| File | `~/.local/state/fleetmates/deck/deck.db` plus `-wal` and `-shm`, all 0600 (the server sets `umask 077` before opening). | Proposed (03-architecture 5) |
| Writers | Exactly one: the web server process. deckd, deck-hook and `fm` never open the database. CLI commands (`fleetmates-deck doctor`, backup) open it read-only or through `VACUUM INTO`. | Proposed |
| Transactions | `BEGIN IMMEDIATE` for every write batch. One ingest batch (the events of one reorder-buffer flush) is one transaction, including its outbound `events` rows (03-architecture 4.2 step 4). WebSocket broadcast happens after `COMMIT`. | Proposed |
| Tables | `STRICT` tables (SQLite 3.37+, bundled with Node 24). Booleans are `INTEGER` with `CHECK (x IN (0,1))`. JSON columns are `TEXT` with `CHECK (json_valid(x))`. | Proposed |

Pragmas, run on every open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;        -- WAL makes this durable across process crashes; power loss can drop the last commits
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;         -- CLI readers during a checkpoint
PRAGMA secure_delete = ON;          -- deleted rows are zeroed, not left in free pages (section 10)
PRAGMA temp_store = MEMORY;
```

Set once, before the first table is created: `PRAGMA auto_vacuum = INCREMENTAL;`. The retention job runs `PRAGMA incremental_vacuum;` after deleting.

## 2. Where each kind of data lives

| Data | Store | Owner | Notes |
|---|---|---|---|
| Repos, crew slot, seed, hat | SQLite `repos` | deck | Decided: slot saved once, never changes on its own |
| Sessions, requests, steps | SQLite | deck | 30 days after end (section 6) |
| Session summaries | SQLite `session_summaries` | deck | forever (Decided) |
| Hook ingest log, outbound event log | SQLite `hook_events`, `events` | deck | 30 days (Decided: event stream) |
| Final scrollback of a PTY | SQLite `session_scrollback` | deck | 30 days (Decided); live scrollback stays in deckd memory |
| Claude Code transcript | `transcript_path` column only | Claude Code | linked, never copied (Decided) |
| Rules | `<repo>/.claude/settings.local.json` `permissions.allow` | Claude Code file | Decided source of truth; SQLite keeps a mirror and audit (4.5) |
| Rule suggestion counters | SQLite `rule_counters` | deck | not dropped by retention |
| Tier patterns | `~/.config/fleetmates/deck/tiers.json` | user | Decided path; section 8 |
| Config and prefs | `config.json` plus SQLite `prefs` | deck | split in section 8 (SET-O2) |
| Token | `~/.local/state/fleetmates/deck/token` | deck | Decided 0600 file |
| fleetmates runs | `<repo>/.fleetmates/<runId>/` | fleetmates | read only; SQLite keeps only deck tags (4.8) |
| Vault notes | the vault, through vault-mcp | vault-mcp | Decided; SQLite keeps paths only (captures, reads, misses) |
| Meetings | TurbidAssist `session_dir` and the vault note | TurbidAssist | read only; SQLite keeps deck-only facts (pins, dismissals, source label) |
| Ask threads, misses, research drafts | SQLite | deck | MEM-O2 default: misses in the deck DB |
| Hook spool | `~/.local/state/fleetmates/deck/spool/` | deck-hook | drained on start and every 60 s ([05-api.md](05-api.md) 6.3) |
| Browser conveniences | `sessionStorage` (token, unsent form drafts), `localStorage` (density, Focus panel) | browser | never authoritative |

## 3. Conventions

- Column names are the snake_case form of the 02-domain field (`crewSlot` is `crew_slot`, `stateSince` is `state_since`). The API maps back to camelCase ([05-api.md](05-api.md) 7).
- Timestamps: `INTEGER` milliseconds since epoch (02-domain 2). Local-day keys (captures) are `TEXT` `YYYY-MM-DD` in the machine's time zone at write time.
- Ids: ULIDs as `TEXT`, except where 02-domain fixes another id (repo realpath, TurbidAssist `session_id`, fleetmates run id).
- Enums are `TEXT` with a `CHECK` listing the values from 02-domain. Adding a value is a migration (section 7).
- Arrays and objects that are never queried by field are JSON `TEXT`.
- A foreign key to `sessions` either cascades (detail that dies with the session) or sets null (facts that outlive it). Summaries and audit rows have no foreign keys on purpose, so retention never touches them.

## 4. Schema

The complete `0001_init.sql`. Comments name the source of each rule. The subsections group statements by entity for reading; in the file, every `CREATE TABLE` comes first, then indexes, then every `CREATE TRIGGER` (a trigger in 4.9 touches `ask_threads` from 4.10).

### 4.1 Meta

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- rows: 'epoch' (ULID, new when the database is created, restored or reset; state-machines 4.3),
--       'created_at', 'last_retention_at', 'deck_version_last_run'
```

The schema version is `PRAGMA user_version`, not a row (section 7).

### 4.2 Repos

```sql
CREATE TABLE repos (
  id                TEXT PRIMARY KEY,                 -- realpath of the repo root (02-domain 2.1)
  name              TEXT NOT NULL,                    -- display name, disambiguated ('work/api'); the API's repoKey
  crew_slot         INTEGER NOT NULL CHECK (crew_slot BETWEEN 0 AND 8),
  crew_slot_shared  INTEGER NOT NULL DEFAULT 0 CHECK (crew_slot_shared IN (0,1)),  -- design/crew.md 4.3
  crew_seed         TEXT NOT NULL,                    -- defaults to name; Reroll stores 'name#2'...
  hat               TEXT NOT NULL DEFAULT 'none' CHECK (hat IN ('none','cap','bandana')),
  first_seen_at     INTEGER NOT NULL,
  missing_since     INTEGER,                          -- directory not found on the last scan
  archived_at       INTEGER                           -- slot released (crew.md 4.2; 30-day figure is CREW-O2)
) STRICT;

CREATE UNIQUE INDEX repos_name_live ON repos(name) WHERE archived_at IS NULL;
-- "never repeats" (Decided): two live repos cannot hold the same exclusive slot
CREATE UNIQUE INDEX repos_slot_live ON repos(crew_slot)
  WHERE archived_at IS NULL AND crew_slot_shared = 0;
```

Slot assignment is one transaction: select the lowest free slot, insert or update the repo (crew.md 4.2). The partial unique index turns a race into a constraint error the server retries, never into two repos with one color.

### 4.3 Sessions

```sql
CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,               -- ULID
  claude_session_id   TEXT,                           -- current Claude Code session_id
  origin              TEXT NOT NULL CHECK (origin IN ('wrapped','launched','observed')),
  pty_id              TEXT,
  process_key         TEXT,                           -- ptyId, or claude pid for observed sessions
  repo_id             TEXT NOT NULL REFERENCES repos(id),
  cwd                 TEXT NOT NULL,
  branch              TEXT,
  task                TEXT NOT NULL DEFAULT 'Untitled',
  run_repo_id         TEXT,                           -- runRef.repoId
  run_id              TEXT,                           -- runRef.runId
  run_task_id         TEXT,                           -- runRef.taskId
  role                TEXT NOT NULL DEFAULT 'solo' CHECK (role IN ('solo','lead','teammate','research')),
  state               TEXT NOT NULL CHECK (state IN ('starting','running','needs_approval','asked_you',
                        'done','stale','idle','reviewed','crashed','ended')),
  state_since         INTEGER NOT NULL,
  since_ts            INTEGER NOT NULL,               -- hookTs of the event that caused the state (late-event rule)
  last_activity_at    INTEGER NOT NULL,
  alive               INTEGER NOT NULL CHECK (alive IN (0,1)),
  activity            TEXT,                           -- 'compacting' | 'tool:<name>' | 'subagents:<n>'
  subagents_active    INTEGER NOT NULL DEFAULT 0 CHECK (subagents_active >= 0),
  main_turn_ended     INTEGER NOT NULL DEFAULT 0 CHECK (main_turn_ended IN (0,1)),   -- row 25
  user_stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (user_stop_requested IN (0,1)),
  end_announced       INTEGER NOT NULL DEFAULT 0 CHECK (end_announced IN (0,1)),
  end_reason          TEXT,                           -- SessionEnd.reason when known
  review_baseline     TEXT,                           -- JSON {head, files, contents}: baseline commit sha, per-file fingerprints
                                                      -- and base64 file contents; null outside git. Only `head` leaves the
                                                      -- server, as the session view's `reviewBaseline` (05-api section 7)
  joined_mid_life     INTEGER NOT NULL DEFAULT 0 CHECK (joined_mid_life IN (0,1)),
  crash_kind          TEXT CHECK (crash_kind IN ('exit','signal','lost')),
  exit_signal         TEXT,
  exit_code           INTEGER,
  last_input_from     TEXT CHECK (last_input_from IN ('terminal','browser')),
  last_input_name     TEXT,                           -- 'kitty'
  transcript_path     TEXT,
  changed_files       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_files)),  -- [{path, adds, dels}]
  reviewed_at         INTEGER,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  launch_task         TEXT,                           -- migration 0002-launch (M2): the first prompt still to type into a
                                                      -- launched session once its idle input box shows; NULL once typed,
                                                      -- and for every row the launch flow did not create
  archived_at         INTEGER,                        -- migration 0003-archive: when the session was archived (ms); NULL when
                                                      -- not archived. Hidden from Home, the Focus ship list, the palette and
                                                      -- the counts; cleared automatically when the session needs the owner
  archived_by         TEXT CHECK (archived_by IS NULL OR archived_by IN ('owner','auto')),  -- migration 0003-archive:
                                                      -- 'owner' (Archive, Archive all finished) or 'auto' (the sweep)
  CHECK (state <> 'starting' OR origin <> 'observed'),            -- state-machines 1.6 impossible states
  CHECK ((run_id IS NULL) = (run_repo_id IS NULL))
) STRICT;

CREATE INDEX sessions_state        ON sessions(state) WHERE state <> 'ended';
CREATE INDEX sessions_repo         ON sessions(repo_id, started_at DESC);
CREATE INDEX sessions_claude_id    ON sessions(claude_session_id);
CREATE UNIQUE INDEX sessions_process_live ON sessions(process_key)
  WHERE process_key IS NOT NULL AND alive = 1;                     -- "two deck sessions for one process key" is impossible
CREATE INDEX sessions_run          ON sessions(run_repo_id, run_id) WHERE run_id IS NOT NULL;
CREATE INDEX sessions_ended        ON sessions(ended_at) WHERE state = 'ended';
CREATE INDEX sessions_archived     ON sessions(archived_at) WHERE archived_at IS NOT NULL;  -- migration 0003-archive

-- earlier Claude session ids of a deck session (02-domain `session_aliases`, state-machines 1.2)
CREATE TABLE session_aliases (
  claude_session_id TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  replaced_at       INTEGER NOT NULL,
  source            TEXT CHECK (source IN ('clear','resume','fork','compact','heuristic'))
) STRICT;
CREATE INDEX session_aliases_session ON session_aliases(session_id);

-- tool step ring for card tails and team crew panels (home.md `session.steps`)
CREATE TABLE session_steps (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,                       -- per session, increasing
  at          INTEGER NOT NULL,
  tool_name   TEXT NOT NULL,
  line        TEXT NOT NULL,                          -- one display line, escaped at render
  adds        INTEGER,
  dels        INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','failed')),
  match_key   TEXT,                                   -- pairs PreToolUse with PostToolUse
  task_id     TEXT,                                   -- teammate attribution by cwd
  PRIMARY KEY (session_id, seq)
) STRICT, WITHOUT ROWID;
-- the server trims to the newest 200 steps per session after each insert (Proposed cap)

-- final output of a PTY session, captured from deckd on P.Exit (crash card, "Ship's log")
CREATE TABLE session_scrollback (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL,
  text        TEXT NOT NULL,                          -- serialized history or raw tail as UTF-8, ANSI kept, capped at 2 MiB
  truncated   INTEGER NOT NULL CHECK (truncated IN (0,1))
) STRICT;
-- `text` holds deckd's serialized history (`history.data` of the exit record, 05-api.md 5.2) when the exit
-- the projector applies carries one, cut by whole leading lines; otherwise the raw `tail` bytes, cut keeping
-- their end. A history row starts with a size header, `ESC [ 8 ; rows ; cols t` (the XTWINOPS resize
-- sequence), naming `history.rows` and `history.cols` clamped to 5..200 rows and 20..500 columns; the 2 MiB
-- cap counts the header. A row without the header is a raw tail or was written before sizes were stored.
-- `GET /api/sessions/:id/scrollback` serves every stored row rendered through a headless terminal of the
-- size its header names, or 120x40 when it names none. Serialized history comes out as the same screen; a
-- raw row comes out as rows drawn at 120x40 (best effort, since its original size is unknown). The headless
-- terminal runs in one worker thread (node:worker_threads), started on the first render and given one render
-- at a time, so a costly render never blocks the server's event loop. The main thread only reads the size
-- header and cuts the input, each in one hand-written pass over the text. One render writes only the newest
-- 256 KiB of the row, cut at a line start; when no line start is in reach the cut moves past any escape
-- sequence it would split. In the worker the first parameter of each sequence whose cost grows with it is
-- clamped (line insert, delete and scroll counts to the screen height; character insert, delete and erase
-- and tab counts to the width; repeat counts to a screenful), whatever parameters, controls or C1
-- introducer the sequence carries, and a repeat that would print more than 16 x width x height code units
-- is dropped. The scrollback is sized from the input (at most 5000 rows), and the serialized output keeps
-- its newest whole lines within 4 MiB. A render that takes over 2 seconds, and a worker that does not start,
-- fails or exits, ends that worker (a fresh one serves the next render) and answers a fallback: the input
-- with every escape sequence and every control character but CR and LF removed, the newest 5000 lines. The
-- worker has a 512 MiB heap limit and an empty environment. The response says truncated when the stored row
-- was cut, when the render left input or output out (the 256 KiB input cut, a repeat count clamped to a
-- screenful, a full scrollback, the 4 MiB output cap, or the fallback), or when `lines` cut it. The server keeps the 64 most recently read renders in
-- memory, fallbacks included, keyed by session, capture time and text length, so a repeat read does not
-- render again.

-- the forever row (Decided D-19: repo, branch, task, outcome, duration, gate result)
CREATE TABLE session_summaries (
  session_id          TEXT PRIMARY KEY,               -- no FK: outlives the sessions row
  repo_id             TEXT NOT NULL,
  repo_name           TEXT NOT NULL,                  -- copied: the repo may be archived later
  branch              TEXT,
  task                TEXT NOT NULL,
  origin              TEXT NOT NULL,
  role                TEXT NOT NULL,
  outcome             TEXT NOT NULL CHECK (outcome IN ('ended','stopped','crashed','lost')),
  exit_code           INTEGER,
  exit_signal         TEXT,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  reviewed_at         INTEGER,
  run_id              TEXT,
  run_task_id         TEXT,
  gate_result         TEXT CHECK (gate_result IN ('PASS','FAIL')),  -- latest recorded gate of the run at end
  files_changed       INTEGER NOT NULL DEFAULT 0,
  adds                INTEGER NOT NULL DEFAULT 0,
  dels                INTEGER NOT NULL DEFAULT 0,
  claude_session_ids  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(claude_session_ids)),
  transcript_path     TEXT                            -- link to Claude Code's transcript, never a copy
) STRICT;
CREATE INDEX session_summaries_repo ON session_summaries(repo_id, ended_at DESC);
CREATE INDEX session_summaries_time ON session_summaries(ended_at DESC);
```

When the summary is written: in the same transaction that moves a session to `ended` (state-machines 1.6 `ended` entry action) and when it enters `crashed` (outcome `crashed` or `lost`). It is an upsert: a crashed session later dismissed, or an ended session reopened by `claude --resume` (row 49) and ended again, overwrites its own row. `outcome`: `ended` for a normal end, `stopped` when `user_stop_requested` was set, `crashed` for an exit code or signal, `lost` for `crash_kind = 'lost'`.

### 4.4 Requests

```sql
CREATE TABLE requests (
  id              TEXT PRIMARY KEY,                   -- ULID
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('permission','question')),
  tier            TEXT CHECK (tier IN ('safe','caution','destructive')),   -- tier at open time, from tiers.json
  tool_name       TEXT,                               -- null for a notification-only request
  summary         TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),   -- tool_input, truncated per 05-api 6.1
  why             TEXT,
  options         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options)),  -- [{key, label}] parsed from the screen
  state           TEXT NOT NULL CHECK (state IN ('open','answered','expired')),
  expired_reason  TEXT CHECK (expired_reason IN ('process_ended','session_replaced','interrupted','superseded')),
  answer          TEXT CHECK (answer IS NULL OR json_valid(answer)),       -- {via, choice, text?}
  source          TEXT NOT NULL CHECK (source IN ('permission_request','notification','ask_user_question',
                    'elicitation','stop_question')),
  match_key       TEXT NOT NULL,
  delivery        TEXT NOT NULL DEFAULT 'idle' CHECK (delivery IN ('idle','sending','verifying','did_not_land')),
  screen_match    TEXT NOT NULL DEFAULT 'unknown' CHECK (screen_match IN ('on_screen','queued','unknown')),
  task_id         TEXT,                               -- teammate attribution (state-machines 11)
  rule_pattern    TEXT,                               -- Claude Code pattern of the matched tiers.json entry (SM-O11)
  created_at      INTEGER NOT NULL,
  answered_at     INTEGER,
  notified_at     INTEGER,
  renotified_at   INTEGER,
  CHECK (kind = 'question' OR tier IS NOT NULL),
  CHECK ((state = 'expired') = (expired_reason IS NOT NULL)),
  CHECK (state <> 'answered' OR answer IS NOT NULL)
) STRICT;

CREATE INDEX requests_open    ON requests(session_id, created_at) WHERE state = 'open';
CREATE INDEX requests_match   ON requests(session_id, match_key, created_at) WHERE state = 'open';
CREATE INDEX requests_created ON requests(created_at);
```

A text, reply or free-text answer stored in `answer.text` is what the user typed into the deck; it is kept with the request for the 30-day window.

### 4.5 Rules: mirror, counters, audit

The settings file is the source of truth (02-domain 2.4). The mirror exists so Settings can show the source and date; the server re-reads each file on Settings open and after its own writes, inserting rows it did not write as `manual` with `created_at` null.

```sql
CREATE TABLE rules (
  repo_id           TEXT NOT NULL REFERENCES repos(id),
  pattern           TEXT NOT NULL,                    -- Claude Code permission syntax
  source            TEXT NOT NULL CHECK (source IN ('suggested','manual')),
  approvals_before  INTEGER,
  created_at        INTEGER,                          -- null: found in the file, date unknown (SET-O5)
  seen_at           INTEGER NOT NULL,                 -- last read that found it
  PRIMARY KEY (repo_id, pattern)
) STRICT, WITHOUT ROWID;

-- one rule machine per (repo, pattern) (state-machines 2.8). Not touched by retention.
CREATE TABLE rule_counters (
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  pattern       TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  state         TEXT NOT NULL CHECK (state IN ('counting','offered','accepted')),
  offered_at    INTEGER,
  dismissed_at  INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (repo_id, pattern)
) STRICT, WITHOUT ROWID;
CREATE INDEX rule_counters_offered ON rule_counters(repo_id) WHERE state = 'offered';

-- append-only history of rule changes, kept forever (small)
CREATE TABLE rule_audit (
  id               INTEGER PRIMARY KEY,
  at               INTEGER NOT NULL,
  repo_id          TEXT NOT NULL,                     -- no FK: survives archiving
  pattern          TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('added','revoked','undo','found','vanished')),
  actor            TEXT NOT NULL CHECK (actor IN ('suggestion','manual','external')),
  approvals_before INTEGER,
  request_id       TEXT                               -- the approval that crossed the threshold, when suggested
) STRICT;
CREATE INDEX rule_audit_repo ON rule_audit(repo_id, at DESC);
```

Counter rules: a request `answered` with an allow choice, tier `safe`, and a non-null `rule_pattern` increments its `(repo_id, rule_pattern)` counter in the same transaction (terminal approvals included, SM-O10 default). Reaching `prefs.ruleSuggestAfter` moves it to `offered` (5 by default, Decided). Dismiss sets `count = 0, state = 'counting'`; Never freezes counting; accept and revoke move `accepted` and back to `counting` at 0. Destructive and Caution never touch counters (Decided). Requests that match no tiers.json entry have `rule_pattern` null and are never counted (SM-O11 default).

### 4.6 Outbound event log (`seq`)

The durable WebSocket events of [05-api.md](05-api.md) 3.4, persisted for replay (state-machines 4.3).

```sql
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,       -- AUTOINCREMENT: never reused after deletes, so seq stays monotonic
  at         INTEGER NOT NULL,
  type       TEXT NOT NULL,                           -- 'session.upserted', 'request.opened', 'counts', ...
  entity_id  TEXT,
  data       TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX events_at ON events(at);
```

- The writer refuses ephemeral types (`meeting.transcript`, `ask.delta`, `screen.tail`, `input.source`, `setup.check`, `ui.navigate`, `hb`) with an assertion. A unit test enumerates the ephemeral list from 05-api and checks it.
- Replay reads `WHERE seq > :lastSeq ORDER BY seq LIMIT 5001`; more than 5,000 rows, or a first row older than 10 minutes, means snapshot instead (state-machines 0.3 `replayWindow`).
- `seq` is also `headSeq` in the snapshot. The `epoch` in `meta` distinguishes databases, so a restored or reset file never replays against an old `lastSeq`.

### 4.7 Hook ingest log and rejected envelopes

```sql
CREATE TABLE hook_events (
  id                 INTEGER PRIMARY KEY,
  dedupe_key         TEXT NOT NULL UNIQUE,            -- sha1(session_id, event, hookTs, sha1(canonical payload)) (state-machines 1.4 rule 3)
  session_id         TEXT REFERENCES sessions(id) ON DELETE CASCADE,  -- resolved deck session, null if none was created
  claude_session_id  TEXT NOT NULL,
  event              TEXT NOT NULL,                   -- hook_event_name
  hook_ts            INTEGER NOT NULL,
  received_at        INTEGER NOT NULL,
  via                TEXT NOT NULL CHECK (via IN ('socket','spool')),
  pty_id             TEXT,
  claude_pid         INTEGER,
  applied            INTEGER NOT NULL CHECK (applied IN (0,1)),       -- 0: late event, logged only (rule 2)
  payload            TEXT NOT NULL CHECK (json_valid(payload))        -- allowlisted fields only (section 10)
) STRICT;
CREATE INDEX hook_events_session  ON hook_events(session_id, hook_ts);
CREATE INDEX hook_events_received ON hook_events(received_at);

-- envelopes that failed validation (state-machines 1.11 item 13); counted on the First run Claude Code check
CREATE TABLE rejected_events (
  id           INTEGER PRIMARY KEY,
  received_at  INTEGER NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('socket','spool')),
  reason       TEXT NOT NULL,                         -- 'invalid_json' | 'missing_field:<name>' | 'unknown_event' | ...
  cc_version   TEXT,                                  -- claude --version at the time, when known
  raw          TEXT NOT NULL                          -- first 16 KiB of the line
) STRICT;
CREATE INDEX rejected_events_received ON rejected_events(received_at);
```

`hook_events.payload` keeps only the fields the deck relies on (04-integrations 2.1: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `source`, `reason`, `tool_name`, `tool_input`, `notification_type`, `stop_hook_active`, plus `message` for `Notification`). Everything else in the payload, notably tool responses, is dropped before the insert.

### 4.8 Runs (deck tags over fleetmates files)

`plan.json` and `status.json` are never copied (04-integrations 1.2). The deck stores what fleetmates does not record.

```sql
CREATE TABLE runs (
  repo_id          TEXT NOT NULL REFERENCES repos(id),
  run_id           TEXT NOT NULL,                     -- may contain '/'
  kind             TEXT NOT NULL DEFAULT 'build' CHECK (kind IN ('build','research')),
  lead_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,  -- 04-integrations 1.3
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  derived_phase    INTEGER,                           -- last git derive result (status.phase is never trusted)
  derived_at       INTEGER,
  last_gate        TEXT CHECK (last_gate IS NULL OR json_valid(last_gate)),  -- {phase, verdict, recordedAt}, for summaries
  PRIMARY KEY (repo_id, run_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX runs_lead ON runs(lead_session_id) WHERE lead_session_id IS NOT NULL;
```

Rows are kept while the run directory exists and dropped 30 days after it disappears (fleetmates never deletes runs, so in practice they stay; they are tiny).

### 4.9 Meetings, pins, dismissals

The deck keeps only facts TurbidAssist does not have: the source label seen while polling (MEET-O1), pins (MEET-O2), dismissed action items, and a cached manifest state for list rendering. No transcript, title, summary or ask text is stored for any meeting (section 10).

```sql
CREATE TABLE meetings (
  id            TEXT PRIMARY KEY,                     -- TurbidAssist session_id, '2026-09-08T14-00-12'
  tag           TEXT NOT NULL,
  confidential  INTEGER NOT NULL CHECK (confidential IN (0,1)),  -- store_transcript = false, or tag unknown (fail closed)
  state         TEXT NOT NULL CHECK (state IN ('recording','stopping','recorded','transcribed',
                  'awaiting_names','synthesized')),
  started_at    INTEGER,
  ended_at      INTEGER,
  note_path     TEXT,                                 -- vault-relative, once synthesized
  apps          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(apps)),  -- routed_apps labels seen while polling
  session_dir   TEXT,                                 -- absolute <session_dir>/<id>
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX meetings_started ON meetings(started_at DESC);

CREATE TABLE meeting_pins (
  id          TEXT PRIMARY KEY,                       -- ULID
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  t           REAL NOT NULL CHECK (t >= 0),           -- seconds since session start (elapsed_s)
  label       TEXT,                                   -- first 80 chars of the newest line; always null when confidential
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX meeting_pins_meeting ON meeting_pins(meeting_id, t);

CREATE TABLE meeting_item_dismissals (
  meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  item_key      TEXT NOT NULL,                        -- sha1 of the normalized action item text; the text itself is never stored
  dismissed_at  INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, item_key)
) STRICT, WITHOUT ROWID;

-- defence in depth for the confidential rule (04-integrations 4.2)
CREATE TRIGGER meeting_pins_no_label_ins BEFORE INSERT ON meeting_pins
WHEN NEW.label IS NOT NULL
 AND COALESCE((SELECT confidential FROM meetings WHERE id = NEW.meeting_id), 1) <> 0
BEGIN SELECT RAISE(ABORT, 'confidential meeting: pin label not allowed'); END;

CREATE TRIGGER meeting_pins_no_label_upd BEFORE UPDATE OF label ON meeting_pins
WHEN NEW.label IS NOT NULL
 AND COALESCE((SELECT confidential FROM meetings WHERE id = NEW.meeting_id), 1) <> 0
BEGIN SELECT RAISE(ABORT, 'confidential meeting: pin label not allowed'); END;

-- a tag policy that becomes confidential later scrubs what was stored before
CREATE TRIGGER meetings_became_confidential AFTER UPDATE OF confidential ON meetings
WHEN NEW.confidential = 1 AND OLD.confidential = 0
BEGIN
  UPDATE meeting_pins SET label = NULL WHERE meeting_id = NEW.id;
  DELETE FROM ask_threads WHERE scope = 'meeting:' || NEW.id;
END;
```

A meeting row is created when the deck first sees the session (its own `start`, a poll showing a recording by another client, or a `session.json` found on disk). Rows stay as long as the TurbidAssist session directory exists; when it disappears the row, pins and dismissals are deleted (TurbidAssist retention removes audio, not directories, so this is rare).

### 4.10 Ask threads, answers, misses, captures, note reads

```sql
CREATE TABLE ask_threads (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,                          -- first question
  scope       TEXT NOT NULL CHECK (scope = 'vault' OR scope LIKE 'meeting:%'),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX ask_threads_recent ON ask_threads(scope, updated_at DESC);

-- a meeting-scoped thread is refused for a confidential or unknown meeting ('meeting:' is 8 chars)
CREATE TRIGGER ask_threads_no_confidential BEFORE INSERT ON ask_threads
WHEN NEW.scope LIKE 'meeting:%'
 AND COALESCE((SELECT confidential FROM meetings WHERE id = substr(NEW.scope, 9)), 1) <> 0
BEGIN SELECT RAISE(ABORT, 'confidential meeting: ask not stored'); END;

CREATE TABLE ask_messages (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text               TEXT NOT NULL,                   -- answer with the final JSON block stripped (state-machines 8.3)
  citations          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations)),   -- [{path, line, viaGraph}]
  general_knowledge  TEXT,
  is_miss            INTEGER NOT NULL DEFAULT 0 CHECK (is_miss IN (0,1)),
  status             TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','cancelled','error')),
  error              TEXT,
  dropped_citations  INTEGER NOT NULL DEFAULT 0,      -- citations to paths not in the vault (state-machines 8.3)
  created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX ask_messages_thread ON ask_messages(thread_id, created_at);

CREATE TABLE misses (
  id              TEXT PRIMARY KEY,
  question        TEXT NOT NULL,
  thread_id       TEXT REFERENCES ask_threads(id) ON DELETE SET NULL,
  searched_terms  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(searched_terms)),
  created_at      INTEGER NOT NULL,
  resolved_by     TEXT CHECK (resolved_by IS NULL OR resolved_by LIKE 'research:%' OR resolved_by LIKE 'note:%')
) STRICT;
CREATE INDEX misses_unresolved ON misses(created_at DESC) WHERE resolved_by IS NULL;

-- notes captured (MEM-O3 default: an observed vault_learn call, a research save, or criado = today)
CREATE TABLE captures (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL,                         -- vault-relative
  day          TEXT NOT NULL,                         -- local YYYY-MM-DD
  captured_at  INTEGER NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('vault_learn','research','frontmatter')),
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  repo_id      TEXT,                                  -- copied so "from {repo}" survives session retention
  research_id  TEXT,
  opened_at    INTEGER,                               -- first open in the deck; "new" = captured today and opened_at null
  UNIQUE (path, day)
) STRICT;
CREATE INDEX captures_day ON captures(day, captured_at DESC);

-- vault_get_note calls seen in hooks (memory.md "Recently used", focus.md Memory tab; MEM-O6)
CREATE TABLE note_reads (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  tool        TEXT NOT NULL,                          -- 'vault_get_note'
  at          INTEGER NOT NULL
) STRICT;
CREATE INDEX note_reads_path    ON note_reads(path, at DESC);
CREATE INDEX note_reads_session ON note_reads(session_id, at DESC);
```

"Cited today in the thread ..." is computed from `ask_messages.citations` with `json_each`, not stored twice. "charts added" in the Captain's log is `SELECT count(*) FROM captures WHERE day = :today` (home.md 5.8).

### 4.11 Research jobs

```sql
CREATE TABLE research (
  id                  TEXT PRIMARY KEY,               -- fleetmates run id 'research-<slug>-<yyyymmdd>'
  repo_id             TEXT REFERENCES repos(id),      -- the repo the run lives in (RES-O6, SM-O15)
  lead_session_id     TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  topic               TEXT NOT NULL,
  preset              TEXT NOT NULL CHECK (preset IN ('quick','standard','deep')),
  domain              TEXT NOT NULL,
  domain_is_new       INTEGER NOT NULL DEFAULT 0 CHECK (domain_is_new IN (0,1)),
  source_types        TEXT NOT NULL CHECK (json_valid(source_types)),
  focus_notes         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(focus_notes)),
  existing_notes      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(existing_notes)),
  miss_id             TEXT REFERENCES misses(id) ON DELETE SET NULL,
  state               TEXT NOT NULL CHECK (state IN ('running','drafted','saved','discarded','failed')),
  failure             TEXT,
  draft               TEXT CHECK (draft IS NULL OR json_valid(draft)),       -- {body, frontmatter, sources[], rejected[]}
  preview             TEXT CHECK (preview IS NULL OR json_valid(preview)),   -- last LearnPreview
  preview_id          TEXT,
  preview_input_hash  TEXT,                           -- sha1 of the vault_learn params the preview used
  saved_path          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  finished_at         INTEGER
) STRICT;
CREATE INDEX research_active ON research(state) WHERE state IN ('running','drafted');
```

Save checks `preview_id` and `preview_input_hash` against the request ([05-api.md](05-api.md) 2.10, `preview_stale`), then calls `vault_learn` with the stored params minus `preview`, and in the same transaction sets `saved`, `saved_path`, inserts a `captures` row and resolves the linked miss (`resolved_by = 'research:<id>'`).

### 4.12 Preferences

```sql
CREATE TABLE prefs (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_at  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
```

Keys in section 8. Unknown keys are ignored on read, so a downgrade never breaks.

## 5. Queries that must agree

The counts contract (02-domain 3: one query for every surface) as the server runs it after each ingest transaction:

```sql
WITH unit AS (                                         -- a run counts once (02-domain 3)
  SELECT CASE WHEN s.role IN ('lead','teammate') AND s.run_id IS NOT NULL
              THEN 'run:' || s.run_repo_id || ':' || s.run_id
              ELSE 'session:' || s.id END AS unit_key,
         CASE s.state WHEN 'needs_approval' THEN 1 WHEN 'asked_you' THEN 2 WHEN 'crashed' THEN 3
                      WHEN 'stale' THEN 4 WHEN 'starting' THEN 5 WHEN 'running' THEN 5
                      WHEN 'done' THEN 6 WHEN 'idle' THEN 7 WHEN 'reviewed' THEN 8 END AS rnk
  FROM sessions s WHERE s.state <> 'ended'
), agg AS (
  SELECT unit_key, MIN(rnk) AS rnk FROM unit GROUP BY unit_key
)
SELECT
  (SELECT count(*) FROM agg WHERE rnk IN (1,2))                  AS need_you_sessions,
  (SELECT count(*) FROM agg WHERE rnk = 5)                       AS running,
  (SELECT count(*) FROM agg WHERE rnk = 6)                       AS to_review,
  (SELECT count(*) FROM requests WHERE state = 'open')           AS open_requests,
  (SELECT count(DISTINCT session_id) FROM requests WHERE state = 'open') AS request_sessions,
  (SELECT min(created_at) FROM requests WHERE state = 'open')    AS oldest_request_at;
```

With the `busy` fixture ([screens/README.md](screens/README.md) 4) this yields 3, 2, 1, 4, 3, which is what Home, the Rail badge and the drawer must show. The urgency order (home.md 7.3) uses the same `rnk` plus the tie rules and is computed in the same transaction.

## 6. Retention

Decided: summary row per session forever; event stream and scrollback dropped after 30 days; Claude Code's transcript is linked, not copied. Everything below is the Proposed mechanics.

The job runs at server start and daily at 04:10 local, in one transaction, with `cutoff = now - 30 days`:

```sql
-- detail of sessions that ended more than 30 days ago (summary already written; cascades to
-- requests, session_aliases, session_steps, session_scrollback, hook_events, note_reads)
DELETE FROM sessions WHERE state = 'ended' AND ended_at < :cutoff;
-- event stream
DELETE FROM hook_events     WHERE received_at < :cutoff;
DELETE FROM events          WHERE at < :cutoff;
DELETE FROM rejected_events WHERE received_at < :cutoff;
-- scrollback
DELETE FROM session_scrollback WHERE captured_at < :cutoff;
-- closed requests of long-lived sessions
DELETE FROM requests  WHERE state <> 'open' AND created_at < :cutoff;
DELETE FROM note_reads WHERE at < :cutoff;
-- research drafts after the job is finished (the saved note is in the vault)
UPDATE research SET draft = NULL, preview = NULL
  WHERE state IN ('saved','discarded','failed') AND finished_at < :cutoff;
```

Then `PRAGMA incremental_vacuum;`, `PRAGMA wal_checkpoint(TRUNCATE);`, `meta.last_retention_at = now`, and one `session.removed` event per deleted session so open tabs drop them.

| Data | Kept | Status |
|---|---|---|
| `session_summaries`, `rule_audit`, `rule_counters`, `rules`, `repos` (live) | forever | Decided (summaries), Proposed (others) |
| `sessions` in `done` with `alive = 0`, or `crashed` not dismissed | until reviewed or dismissed; retention never deletes unreviewed work (02-domain 3) | Proposed |
| `sessions` in `ended` and their detail | 30 days after `ended_at` (DB-O1) | Decided figure |
| archived `sessions` | same as any session: archiving changes no retention rule, so an archived ended session is deleted 30 days after `ended_at` and an archived session with unreviewed work is kept | Decided (owner, 2026-10-02) |
| `hook_events`, `events`, `rejected_events`, `session_scrollback`, closed `requests`, `note_reads` | 30 days | Decided figure |
| `session_steps` | newest 200 per session, then with the session | Proposed |
| `ask_threads`, `ask_messages`, `misses`, `captures` | forever (small, user content the owner asked for: misses log, captures) | Proposed (DB-O3) |
| `research` row | forever; `draft` and `preview` 30 days after finishing | Proposed |
| `meetings`, pins, dismissals | while the TurbidAssist session directory exists | Proposed |
| `runs` | 30 days after the run directory disappears | Proposed |
| archived `repos` | forever (the row keeps `first_seen_at`; the slot is released) | Proposed |

## 7. Migrations

- Files `hub/server/db/migrations/NNNN_<name>.sql`, applied in order. `0001_init.sql` is section 4 verbatim. The version is `PRAGMA user_version`.
- On start, with the database opened and before anything else touches it: if `user_version` is behind, first `VACUUM INTO 'deck.db.pre-<NNNN>.bak'` (keep the newest 3), then apply each pending file in its own `BEGIN IMMEDIATE` transaction that ends with `PRAGMA user_version = N`. A failed migration rolls back and the server exits with the file name and SQLite error; the backup is untouched.
- Forward only. If `user_version` is **ahead** of the newest file (a downgrade), the server refuses to start: "deck.db was written by a newer deck (schema N). Upgrade, or restore deck.db.pre-*.bak." Never auto-downgrade.
- SQLite cannot alter a `CHECK` or drop most constraints in place, so enum additions and column changes use the 12-step table rebuild (create new, copy, drop, rename, recreate indexes and triggers) inside the migration transaction with `PRAGMA foreign_keys = OFF` around it and `PRAGMA foreign_key_check` before commit.
- A data-only fix (for example re-deriving `rule_pattern`) is a migration file too, never startup code.
- Applied so far: `0001-init.sql` (section 4), `0002-launch.sql` (`sessions.launch_task`), `0003-archive.sql` (`sessions.archived_at`, `sessions.archived_by` and the partial index `sessions_archived`, section 4.3).
- Tests ([09-testing.md](09-testing.md)): apply all migrations to an empty database and compare `sqlite_schema` with a checked-in snapshot; apply the newest migration to a fixture database of each earlier version; the downgrade refusal.

## 8. What lives outside SQLite

| File or place | Content | Read by | Written by | Status |
|---|---|---|---|---|
| `~/.config/fleetmates/deck/config.json` (0600) | settings needed before the database opens or by CLI commands: `port`, `scanRoot` (`~/dev`), `lang` (fallback when `DECK_LANG` is unset), `staleMinutes` (20, read-only in v1), `claudeCommand`, `vaultPath` (when `VAULT_PATH` is unset), `vaultCommand`, `obsidianVaultName` (MEM-O5), `turbidassistConfig` (MEET-O11), `scribedCommand`, `researchWorkspace` (D-54, M6); full table with defaults in [13-operations.md](13-operations.md) section 7.1 | server, `fleetmates-deck open`/`doctor` | Settings Connections through `PATCH /api/prefs` (the server writes the file and hot-reloads the value, no restart; `port` needs a restart), or by hand (restart needed) | Proposed (SET-O2) |
| SQLite `prefs` | UI behaviour changed from Settings: `ruleSuggestAfter`, `textSize`, `motion`, `terminalScreenReader`, `bell`, `renotifyAfter`, `notifyDone`, `quietInMeetings`, `notifyCrash`, `firstRunCompletedAt` | server | `PATCH /api/prefs`, `POST /api/setup/complete` | Proposed (SET-O2) |
| Environment | `DECK_PORT`, `DECK_LANG`, `VAULT_PATH`, `DECK_DEBUG`; wins over both files | server | user | Decided for `DECK_LANG` (03-architecture 5) |
| `~/.config/fleetmates/deck/tiers.json` (0600) | Safe, Caution, Destructive pattern lists; unknown commands Caution | server, watched with `fs.watch` | user | Decided path. A request stores its tier at open time; an edit re-tiers open requests upward only, never down ([07-approvals.md](07-approvals.md) section 3.2, rule 6) |
| `~/.local/state/fleetmates/deck/token` (0600) | browser token | server, `fleetmates-deck open` | `fleetmates-deck init` | Decided (0600 file), path Proposed |
| `<repo>/.claude/settings.local.json` | rules in `permissions.allow` | Claude Code, server | server (merge, atomic write), Claude Code option 2, the user | Decided; SQLite holds only the mirror (4.5) |
| `~/.claude/settings.json` | deck hooks next to fleetmates' | Claude Code | `fleetmates-deck init` (backup `settings.json.deck-backup-<ts>`) | Decided (user level) |
| The vault | notes | vault-mcp; the deck only through vault-mcp (Decided). Exception by design: meeting notes written by `postmeet` are read from disk when vault-mcp is down ([screens/meetings.md](screens/meetings.md) 4.2.1) | vault-mcp (`vault_learn` from research save), `postmeet` | Decided |
| TurbidAssist | `config.yaml`, `<session_dir>/<id>/{session.json, transcript.jsonl, transcript.json, transcript.md, asks.jsonl, postmeet.log}` | server (read only, on demand) | scribed, postmeet | Decided (deck never writes them) |
| fleetmates | `.fleetmates/<runId>/{plan.json, status.json}`, `.fleetmates/index/` | server (read only) | fleetmates | Decided |
| Claude Code transcripts | `transcript_path` | server (tail for `why` and the first prompt) | Claude Code | Decided: linked, never copied |
| deckd memory | per PTY scrollback ring (5,000 lines or 2 MiB), screen model, exit records (24 h) | deckd | deckd | Proposed; lost when deckd restarts |
| Hook spool | `~/.local/state/fleetmates/deck/spool/hooks-<yyyymmdd>.jsonl` | server (drain) | deck-hook | Proposed |
| Logs | journald; `~/.local/state/fleetmates/deck/logs/` with `DECK_DEBUG=1` | user | server, deckd | Proposed |

Precedence for any setting: environment, then `config.json`, then `prefs`, then the built-in default. `GET /api/prefs` reports which one won per key ([05-api.md](05-api.md) 2.7), so Settings can show "set by DECK_LANG" (SET-O1).

Home density and the Focus panel toggle stay in the browser's `localStorage` (per browser, as [screens/home.md](screens/home.md) and [screens/focus.md](screens/focus.md) specify), not in `prefs`.

## 9. Backup and reset

| Operation | How | Status |
|---|---|---|
| Backup | `fleetmates-deck backup <dir>` runs `VACUUM INTO` (a consistent copy while the server runs, file mode 0600). Without `<dir>` the default target is `~/.local/state/fleetmates/deck/backups/deck-<ts>.db`. Rules and tiers are not in it: they live in the repos and in `tiers.json`. | Proposed (DB-O4) |
| Automatic copies | the pre-migration backups of section 7 | Proposed |
| Restore | `fleetmates-deck restore <file>`: stops `fleetmates-deck.service`, moves the current file aside to `deck.db.before-restore-<ts>`, copies the backup in, writes a **new `epoch`**, starts the service. deckd keeps its PTYs; reconciliation (03-architecture 4.4) re-attaches live sessions, and tabs get a snapshot because the epoch changed. | Proposed |
| Reset | `fleetmates-deck reset [--keep-crew]`: stops the service, renames `deck.db*` to `deck.db.reset-<ts>*`, starts on an empty database with a new epoch. | Proposed |

What a reset loses and how it comes back:

| Lost | Comes back as |
|---|---|
| sessions, requests, steps | live PTY sessions from deckd `list` (origin from deckd); others from their next hook as `joinedMidLife` sessions (state-machines 1.4 rule 4) |
| crew slots, seeds, hats | reassigned lowest-free-slot in first-sighting order: colors can change (warn in the command's output). `--keep-crew` copies the `repos` table into the new file |
| rules mirror | rebuilt from the settings files on the next Settings open; every rule shows as "added by hand" |
| rule counters, summaries, misses, ask threads, captures, pins, dismissals, research rows | not recoverable (the vault and TurbidAssist files are untouched) |
| `firstRunCompletedAt` | the next open goes through First run again (hooks are already installed, so Set sail is one click) |

## 10. Privacy rules

### 10.1 Confidential meeting tags (Decided rule, Proposed enforcement)

A meeting is confidential when its tag's `synthesis.tag_policies.<tag>.store_transcript` is `false` in TurbidAssist's `config.yaml` (02-domain 2.6). The deck must not persist transcript text, asks or pin text for those meetings in SQLite, logs or search indexes (04-integrations 4.2).

Enforcement, in layers:

1. **Nothing transcript-shaped is stored for any meeting.** The schema has no column for transcript lines, tail text, meeting titles, summaries, decisions or action item text. Live lines travel only as the ephemeral `meeting.transcript` WebSocket event, and the `events` writer refuses that type (4.6). Transcript search reads files on demand and keeps no index (MEET-O7 default). Full transcripts are read from disk per request and never cached. This goes beyond the Decided rule for non-confidential tags too; it costs nothing because TurbidAssist already keeps the files.
2. **Fail closed.** A tag not found in `config.yaml`, or an unreadable `config.yaml`, makes the meeting confidential (`confidential = 1`, DB-O2).
3. **Triggers.** A pin label on a confidential meeting and a meeting-scoped ask thread for a confidential or unknown meeting abort the transaction (4.9, 4.10). A policy change to confidential nulls stored labels and deletes meeting-scoped threads.
4. **Dismissals** store a sha1 of the action item text, never the text.
5. **Logs.** Server and deckd logs record event types, ids and sizes, never scribed text, ask questions or answers, for any tag, including under `DECK_DEBUG=1`.
6. **Hygiene.** `secure_delete = ON` zeroes deleted content; the retention job checkpoints the WAL.
7. **Test** (meetings.md acceptance 9): record the `recording` fixture (tag `client-a`), pin twice, ask once, stop; then scan the bytes of `deck.db`, `deck.db-wal` and the debug log for every fixture transcript line and ask text. Zero hits required. The same test runs with a non-confidential tag to prove the scan finds nothing there either, except pin labels.

### 10.2 Hook payloads

- Only the allowlisted fields are stored (4.7). Tool responses are never stored, so file contents an agent read (a transcript, a secret) do not land in the deck database through `PostToolUse`.
- `tool_input` is stored truncated at 64 KiB per string ([05-api.md](05-api.md) 6.1). It can still hold secrets typed into commands; it is covered by the 0600 file mode, the 30-day retention and `secure_delete`.
- `rejected_events.raw` keeps the first 16 KiB of an envelope that failed validation, for fixture updates; same retention.

### 10.3 General

- Every file in the state directory is 0600 in a 0700 directory ([03-architecture.md](03-architecture.md) 5).
- The deck never uploads anything; there is no telemetry.
- `fleetmates-deck reset` is the documented way to erase everything the deck stored; it tells the user that rules, the vault and TurbidAssist files are elsewhere and untouched.

## 11. Write paths in one place

| Trigger | One transaction writes |
|---|---|
| Hook batch flushed from the reorder buffer | `hook_events` rows, `sessions` changes, `session_aliases`, `session_steps`, `requests` changes, `rule_counters`, `note_reads`, `captures` (observed `vault_learn`), `session_summaries` (on end or crash), `runs.lead_session_id`, `events` rows (`session.upserted`, `request.*`, `rule.offered`, `counts`, `order.changed`) |
| deckd event (`exit`, screen signal) | same set, driven by `P.*` and `S.*`; on exit also `session_scrollback` |
| REST action | the entity rows plus their `events` rows (for example a revoke: `rules`, `rule_audit`, `rule_counters`, `events`) |
| Timer (`T.Stale`, `T.Midnight`, 2 s scribed poll) | `sessions` or `meetings` plus `events` |

A settings-file write (rules) happens before the transaction that mirrors it; if the transaction then fails, the next re-read finds the rule and mirrors it as `manual`, which is the safe direction.

## 12. Fields added to the 02-domain contract (Proposed)

Everything below is used by this schema or by [05-api.md](05-api.md) and is not in [02-domain.md](02-domain.md) today.

| Entity | Field or entity | Why |
|---|---|---|
| Repo | `crewSlotShared` | design/crew.md 4.3 (more than nine repos) |
| Repo | `missingSince`, `archivedAt` | slot release after the repo disappears (crew.md 4.2) |
| Session | `sinceTs`, `subagentsActive`, `mainTurnEnded`, `userStopRequested`, `endAnnounced` | state-machines 1.5 and 12.6 context, persisted so a server restart resumes the machine |
| Session | `endReason` | `SessionEnd.reason` recorded as the outcome for observed sessions (row 40) |
| Session | `lastInputName` | 02-domain folds the terminal name into `lastInputFrom`; split so the enum stays an enum |
| Session | `sessionAliases` as a table | 02-domain names `session_aliases` without a shape |
| Session | `steps` (entity `Step`) | home.md `session.steps` ring buffer |
| Session | `toolCalls` (derived) | home.md footer "31 tool calls" |
| Session | `launch_task` (server-only column, migration `0002-launch`, M2) | the launch flow types the task only after the idle input box appears (03-architecture 4.1), so the text waits in the row until then; it is not part of the session view |
| Session | `archivedAt`, `archivedBy` (columns `archived_at`, `archived_by`, migration `0003-archive`) | the owner hides sessions from Home without deleting them; any session can be archived, one that needs the owner is unarchived automatically, and finished sessions without unreviewed changes can be archived in bulk or by the auto-archive sweep |
| Request | `screenMatch` | state-machines 12.5; now also in 02-domain 2.3 |
| Request | `taskId` | teammate attribution (state-machines 11) |
| Request | `rulePattern` | the Claude Code pattern of the matched tiers.json entry, key of the rule counter |
| Request | `toolName` nullable | notification-only requests have no tool (state-machines 2.2) |
| Rule | `createdAt` nullable, `seenAt` | rules found in the file have no date (SET-O5) |
| RuleCounter, RuleAudit | new entities | 5-approval suggestion (Decided) and a history of rule changes |
| Run | `firstSeenAt`, `lastSeenAt`, `lastGate` | retention and the summary's gate result |
| Meeting | `sessionDir`, `updatedAt` | locate files; cache freshness |
| Meeting pin | `id`, `createdAt`, `label` nullable | unpin; confidential pins have no label |
| MeetingItemDismissal | new entity | meetings.md "Dismiss", stored in the deck DB |
| AskMessage | `status`, `error`, `droppedCitations` | cancelled and failed asks (state-machines 8.2), dropped citations (8.3) |
| Miss | `searchedTerms` as `string[]` | 02-domain gives no type |
| Capture, NoteRead | new entities | memory.md Captures and "Recently used" (MEM-O3, MEM-O6) |
| Research | `repoId`, `leadSessionId`, `missId`, `domainIsNew`, `failure`, `previewId`, `previewInputHash`, `savedPath`, `createdAt`, `updatedAt`, `finishedAt` | run location (RES-O6), save-matches-preview check, miss resolution |
| SessionSummary | new entity | the Decided forever row |
| Prefs | key list of section 8 | Settings bindings |

## Open items

Existing items referenced, not repeated: SET-O2 (prefs storage split), SET-O5, CREW-O2 (30-day slot release), MEM-O2 (misses in the deck DB), MEM-O3, MEM-O6, MEET-O1, MEET-O2, MEET-O7, MEET-O11, RES-O6, SM-O10, SM-O11, Q1 in [15-open-questions.md](15-open-questions.md) (CLI naming, which also covers the `backup`, `restore` and `reset` commands).

| ID | Question | Default until decided | Blocks milestone |
|---|---|---|---|
| DB-O1 | Is the 30-day window for session detail counted from `ended_at` (this doc) or from `started_at`? A session running for weeks would lose early events under the second reading. | From `ended_at`; hook and outbound events from their own timestamps | M1 |
| DB-O2 | A meeting whose tag is not in `config.yaml` (renamed or removed tag, unreadable config): treat as confidential? | Yes, fail closed | M4 |
| DB-O3 | Ask threads, misses and captures have no retention: keep forever, or 30 days like the event stream? | Forever | M5 |
| DB-O4 | Backup, restore and reset commands (`fleetmates-deck backup`, `restore`, `reset`, named as in [13-operations.md](13-operations.md) section 4.2): ship them, or document manual steps only? | Ship them under the hub bin; 03-architecture section 6 points to the full list in 13-operations | M1 |
