-- Session archive (docs/deck/06-storage.md section 4.3). Archived: sessions.archived_at is not null.
-- archived_by is 'owner' (Archive, Archive all finished) or 'auto' (the auto-archive sweep); unarchive clears both.
ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
ALTER TABLE sessions ADD COLUMN archived_by TEXT CHECK (archived_by IS NULL OR archived_by IN ('owner','auto'));
CREATE INDEX sessions_archived ON sessions(archived_at) WHERE archived_at IS NOT NULL;
