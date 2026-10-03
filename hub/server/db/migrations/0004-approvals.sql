-- M3 approvals (07-approvals 3.1, 8 and 11): the classifier's reasons and the Destructive confirm
-- label on each request, and the append-only approvals audit. Rule events keep going to rule_audit
-- (06-storage).
ALTER TABLE requests ADD COLUMN reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons));
ALTER TABLE requests ADD COLUMN confirm_label TEXT;

CREATE TABLE approval_audit (
  id            INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('answered','refused','did_not_land','expired','rule_added','rule_revoked',
                  'rule_found','tiers_loaded','tiers_rejected')),
  request_id    TEXT,                                 -- no FK: the audit outlives request retention
  session_id    TEXT,
  repo_id       TEXT,
  tier          TEXT CHECK (tier IS NULL OR tier IN ('safe','caution','destructive')),
  reasons       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons)),   -- matched entry ids
  via           TEXT CHECK (via IS NULL OR via IN ('browser','terminal','popup','batch','settings')),
  choice        TEXT,
  option_label  TEXT,
  confirm_label TEXT,                                 -- the exact checkbox text shown for a Destructive allow
  summary       TEXT,                                 -- redacted with the log redaction rules (08-security 4.10)
  tiers_sha256  TEXT
) STRICT;
CREATE INDEX approval_audit_at ON approval_audit(at);
