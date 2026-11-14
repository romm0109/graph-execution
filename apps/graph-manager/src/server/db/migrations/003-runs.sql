-- The run archive (docs/prd/hosted-sessions.md): one row per run of a user, kept after its workspace or session is gone.
-- `state` is state.json as JSON text, `summary` the RunSummary as JSON text, `blob_key` the run folder's .tar.gz blob.
CREATE TABLE IF NOT EXISTS runs (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  pr_url TEXT,
  state TEXT,
  summary TEXT NOT NULL,
  blob_key TEXT,
  PRIMARY KEY (user_id, workspace_id, run_id)
);
CREATE INDEX IF NOT EXISTS runs_user_started ON runs (user_id, started_at);
