-- Initial deck schema. See docs/deck/06-storage.md section 4.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- rows: 'epoch' (ULID, new when the database is created, restored or reset; state-machines 4.3),
--       'created_at', 'last_retention_at', 'deck_version_last_run'

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
  review_baseline     TEXT,                           -- commit or tree sha; null outside git
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
  text        TEXT NOT NULL,                          -- raw bytes as UTF-8, ANSI kept, capped at 2 MiB
  truncated   INTEGER NOT NULL CHECK (truncated IN (0,1))
) STRICT;

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

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,       -- AUTOINCREMENT: never reused after deletes, so seq stays monotonic
  at         INTEGER NOT NULL,
  type       TEXT NOT NULL,                           -- 'session.upserted', 'request.opened', 'counts', ...
  entity_id  TEXT,
  data       TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
CREATE INDEX events_at ON events(at);

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

CREATE TABLE prefs (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_at  INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- One record per delivered notification, including done/crash events without a request.
CREATE TABLE notification_history (
  id          INTEGER PRIMARY KEY,
  dedupe_key  TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('request','renotify','done','crash')),
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  request_id  TEXT REFERENCES requests(id) ON DELETE SET NULL,
  delivered_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notification_history_delivered ON notification_history(delivered_at);
