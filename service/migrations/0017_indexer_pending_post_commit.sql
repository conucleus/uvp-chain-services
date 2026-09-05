-- Post-commit steps (signal notifications / projection automation) that
-- exhausted their in-process retries after the projection and cursor were
-- already durable. The background sweep re-delivers them until they succeed
-- or an operator intervenes; without this table the advanced cursor means the
-- batch would never be processed again.
CREATE TABLE IF NOT EXISTS indexer_pending_post_commit (
  step_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  events_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS indexer_pending_post_commit_chain_idx
  ON indexer_pending_post_commit (chain_id, kind, updated_at);
