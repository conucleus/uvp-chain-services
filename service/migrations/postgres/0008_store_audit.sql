CREATE TABLE IF NOT EXISTS store_operator_audit (
  row_id BIGSERIAL PRIMARY KEY,
  audit_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  parent_id TEXT,
  access_level TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  roles_json JSONB NOT NULL,
  error_code TEXT,
  request_id TEXT,
  metadata_json JSONB
);

CREATE INDEX IF NOT EXISTS store_operator_audit_resource_idx
  ON store_operator_audit (resource_type, resource_id, created_at);

CREATE INDEX IF NOT EXISTS store_operator_audit_actor_idx
  ON store_operator_audit (actor, created_at);

CREATE INDEX IF NOT EXISTS store_operator_audit_action_idx
  ON store_operator_audit (action, outcome, created_at);
