ALTER TABLE research ADD COLUMN review TEXT CHECK(review IS NULL OR json_valid(review));
ALTER TABLE research ADD COLUMN preview TEXT CHECK(preview IS NULL OR json_valid(preview));
ALTER TABLE research ADD COLUMN saved TEXT CHECK(saved IS NULL OR json_valid(saved));
ALTER TABLE research ADD COLUMN save_state TEXT NOT NULL DEFAULT 'unsaved'
  CHECK(save_state IN ('unsaved','saving','saved','unknown'));

-- Preserve existing captures while admitting attribution to an approved research save.
ALTER TABLE captures RENAME TO captures_m5;
CREATE TABLE captures (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  day TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  via TEXT NOT NULL CHECK(via IN ('vault_learn','frontmatter','research')),
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  repo_id TEXT,
  opened_at INTEGER,
  research_id TEXT REFERENCES research(id) ON DELETE RESTRICT,
  CHECK(via <> 'research' OR research_id IS NOT NULL),
  UNIQUE(path,day)
) STRICT;
INSERT INTO captures(id,path,day,captured_at,via,session_id,repo_id,opened_at)
  SELECT id,path,day,captured_at,via,session_id,repo_id,opened_at FROM captures_m5;
DROP TABLE captures_m5;
CREATE INDEX captures_day ON captures(day,captured_at DESC);
