-- Research launch metadata is authoritative in the private deck DB, never agent output.
-- Preview and save state will be added when the upstream preview contract is available.
CREATE TABLE research (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  lead_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  request TEXT NOT NULL CHECK (json_valid(request) AND json_type(request) = 'object'),
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX research_created ON research(created_at DESC);
