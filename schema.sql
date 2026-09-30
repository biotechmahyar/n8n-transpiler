-- n8n-transpiler audit log
-- Tracks transpilation requests for observability and debugging.
-- Optional: bind a D1 database if you want persistent audit logging.

CREATE TABLE IF NOT EXISTS transpile_audit (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workflow_name TEXT NOT NULL,
  node_count    INTEGER NOT NULL,
  supported     INTEGER NOT NULL,
  unsupported   INTEGER NOT NULL,
  output_files  INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  warnings      TEXT,            -- JSON array of warning strings
  -- NOTE: caller_ip is PII. Handle per your privacy policy (retention limits, anonymization, or removal).
  caller_ip     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transpile_audit_created
  ON transpile_audit(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transpile_audit_workflow
  ON transpile_audit(workflow_name);
