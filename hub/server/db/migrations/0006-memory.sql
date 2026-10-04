-- M5 memory (06-storage 4.10): ask threads and answers, the misses log (D-130), captures (D-137),
-- note reads seen in hooks (D-138) and observed vault_learn calls (D-137). Question, answer and
-- note text never reach the events table (06-storage 10.3). M5 stores only scope 'vault' threads;
-- the scope check and the confidential trigger are kept for meeting threads (D-144).
CREATE TABLE ask_threads (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,                          -- first question, cut to 120 characters
  scope       TEXT NOT NULL CHECK (scope = 'vault' OR scope LIKE 'meeting:%'),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE ask_messages (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text               TEXT NOT NULL,                   -- answer with the final deck-answer block stripped (state-machines 8.3)
  citations          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations)),   -- [{path, line, viaGraph}]
  general_knowledge  TEXT,
  is_miss            INTEGER NOT NULL DEFAULT 0 CHECK (is_miss IN (0,1)),
  status             TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','cancelled','error')),
  error              TEXT,
  dropped_citations  INTEGER NOT NULL DEFAULT 0,      -- citations that failed validation (D-141)
  searches           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(searches)),     -- [{query, resultCount}] from the stream
  unverified         INTEGER NOT NULL DEFAULT 0 CHECK (unverified IN (0,1)),      -- 1 when the answer had no valid deck-answer block (D-131)
  duration_ms        INTEGER,
  created_at         INTEGER NOT NULL
) STRICT;

CREATE TABLE misses (
  id              TEXT PRIMARY KEY,
  question        TEXT NOT NULL,
  thread_id       TEXT REFERENCES ask_threads(id) ON DELETE SET NULL,
  searched_terms  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(searched_terms)),
  created_at      INTEGER NOT NULL,
  resolved_by     TEXT CHECK (resolved_by IS NULL OR resolved_by LIKE 'research:%' OR resolved_by LIKE 'note:%'
                    OR resolved_by = 'dismissed')     -- D-140
) STRICT;

-- notes captured (MEM-O3 as decided, D-137): an observed vault_learn call or criado = today.
-- research_id and the 'research' via arrive with M6.
CREATE TABLE captures (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL,                         -- vault-relative
  day          TEXT NOT NULL,                         -- local YYYY-MM-DD
  captured_at  INTEGER NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('vault_learn','frontmatter')),
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  repo_id      TEXT,                                  -- copied so "from {repo}" survives session retention
  opened_at    INTEGER,                               -- first open in the deck; "new" = captured today and opened_at null
  UNIQUE (path, day)
) STRICT;

-- vault_get_note calls seen in hooks (memory.md "Recently used", focus.md Memory tab; MEM-O6, D-138)
CREATE TABLE note_reads (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  tool        TEXT NOT NULL,                          -- 'vault_get_note'
  at          INTEGER NOT NULL
) STRICT;

-- vault_learn calls seen in hooks, matched later to the daily note's Capturas lines (D-137)
CREATE TABLE vault_learn_calls (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  repo_id     TEXT,
  slug        TEXT NOT NULL,                          -- slug of the call's titulo
  at          INTEGER NOT NULL
) STRICT;

CREATE INDEX ask_threads_recent ON ask_threads(scope, updated_at DESC);
CREATE INDEX ask_messages_thread ON ask_messages(thread_id, created_at);
CREATE INDEX misses_unresolved ON misses(created_at DESC) WHERE resolved_by IS NULL;
CREATE INDEX captures_day ON captures(day, captured_at DESC);
CREATE INDEX note_reads_path    ON note_reads(path, at DESC);
CREATE INDEX note_reads_session ON note_reads(session_id, at DESC);
CREATE INDEX vault_learn_calls_at ON vault_learn_calls(at DESC);

-- a meeting-scoped thread is refused for a confidential or unknown meeting ('meeting:' is 8 chars)
CREATE TRIGGER ask_threads_no_confidential BEFORE INSERT ON ask_threads
WHEN NEW.scope LIKE 'meeting:%'
 AND COALESCE((SELECT confidential FROM meetings WHERE id = substr(NEW.scope, 9)), 1) <> 0
BEGIN SELECT RAISE(ABORT, 'confidential meeting: ask not stored'); END;

-- the M4 trigger of 0005-meetings.sql with its four statements unchanged, plus the DELETE of the
-- meeting's ask threads (06-storage 4.9, D-144); their messages go with them by cascade
DROP TRIGGER meetings_became_confidential;
CREATE TRIGGER meetings_became_confidential AFTER UPDATE OF confidential ON meetings
WHEN NEW.confidential = 1 AND OLD.confidential = 0
BEGIN
  UPDATE meeting_pins SET label = NULL WHERE meeting_id = NEW.id;
  UPDATE meetings SET note_path = NULL WHERE id = NEW.id AND note_path IS NOT NULL;
  UPDATE events SET data = json_set(data, '$.label', NULL)
   WHERE type = 'meeting.pin.added' AND (entity_id = NEW.id OR json_extract(data, '$.meetingId') = NEW.id);
  UPDATE events SET data = json_set(data, '$.notePath', NULL)
   WHERE type = 'meeting.updated' AND (entity_id = NEW.id OR json_extract(data, '$.id') = NEW.id);
  DELETE FROM ask_threads WHERE scope = 'meeting:' || NEW.id;
END;
