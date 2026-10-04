-- M4 meetings (06-storage 4.9): only facts TurbidAssist does not have, the source label seen while
-- polling (MEET-O1), pins (MEET-O2), dismissed action items and a cached manifest state for list
-- rendering. No transcript, title, summary or ask text is stored for any meeting (06-storage 10.1).
CREATE TABLE meetings (
  id            TEXT PRIMARY KEY,                     -- TurbidAssist session_id, '2026-09-08T14-00-12'
  tag           TEXT NOT NULL,
  confidential  INTEGER NOT NULL CHECK (confidential IN (0,1)),  -- store_transcript = false, or tag unknown (fail closed)
  state         TEXT NOT NULL CHECK (state IN ('recording','stopping','recorded','transcribed',
                  'awaiting_names','synthesized')),
  started_at    INTEGER,
  ended_at      INTEGER,
  note_path     TEXT,                                 -- vault-relative, once synthesized; the file name embeds the title, so the meetings store writes null for a confidential row and meetings_became_confidential nulls it when a row turns confidential (a raw INSERT of a confidential row with a note_path is not checked)
  apps          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(apps)),  -- routed_apps labels seen while polling
  session_dir   TEXT,                                 -- absolute <session_dir>/<id>
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE meeting_pins (
  id          TEXT PRIMARY KEY,                       -- ULID
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  t           REAL NOT NULL CHECK (t >= 0),           -- seconds since session start (elapsed_s)
  label       TEXT,                                   -- first 80 chars of the newest line; always null when confidential
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE meeting_item_dismissals (
  meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  item_key      TEXT NOT NULL,                        -- sha1 of the normalized action item text; the text itself is never stored
  dismissed_at  INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, item_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX meetings_started ON meetings(started_at DESC);
CREATE INDEX meeting_pins_meeting ON meeting_pins(meeting_id, t);

-- defence in depth for the confidential rule (04-integrations 4.2)
CREATE TRIGGER meeting_pins_no_label_ins BEFORE INSERT ON meeting_pins
WHEN NEW.label IS NOT NULL
 AND COALESCE((SELECT confidential FROM meetings WHERE id = NEW.meeting_id), 1) <> 0
BEGIN SELECT RAISE(ABORT, 'confidential meeting: pin label not allowed'); END;

CREATE TRIGGER meeting_pins_no_label_upd BEFORE UPDATE OF label ON meeting_pins
WHEN NEW.label IS NOT NULL
 AND COALESCE((SELECT confidential FROM meetings WHERE id = NEW.meeting_id), 1) <> 0
BEGIN SELECT RAISE(ABORT, 'confidential meeting: pin label not allowed'); END;

-- a meeting whose confidential goes from 0 to 1, by any writer, has scrubbed: its pins' labels,
-- its note_path, data.label of its earlier meeting.pin.added events and data.notePath of its
-- earlier meeting.updated events (events written by hub/server/meetings/store.mjs, matched on
-- entity_id or on the meeting id inside data). M5 adds the DELETE of the meeting's ask_threads
-- here, because that table does not exist yet
CREATE TRIGGER meetings_became_confidential AFTER UPDATE OF confidential ON meetings
WHEN NEW.confidential = 1 AND OLD.confidential = 0
BEGIN
  UPDATE meeting_pins SET label = NULL WHERE meeting_id = NEW.id;
  UPDATE meetings SET note_path = NULL WHERE id = NEW.id AND note_path IS NOT NULL;
  UPDATE events SET data = json_set(data, '$.label', NULL)
   WHERE type = 'meeting.pin.added' AND (entity_id = NEW.id OR json_extract(data, '$.meetingId') = NEW.id);
  UPDATE events SET data = json_set(data, '$.notePath', NULL)
   WHERE type = 'meeting.updated' AND (entity_id = NEW.id OR json_extract(data, '$.id') = NEW.id);
END;
