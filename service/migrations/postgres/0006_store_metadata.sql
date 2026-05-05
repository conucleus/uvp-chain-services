CREATE TABLE IF NOT EXISTS store_zhixu_draft (
  draft_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  zhixu_id TEXT,
  title TEXT NOT NULL,
  maintainer TEXT NOT NULL,
  public_summary TEXT,
  tags_json JSONB NOT NULL,
  compile_preview_json JSONB,
  review_id TEXT,
  governance_tx_log_id TEXT,
  errors_json JSONB NOT NULL,
  review_status TEXT,
  attestation_domain_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS store_zhixu_draft_status_idx
  ON store_zhixu_draft (status, updated_at);

CREATE TABLE IF NOT EXISTS store_zhixu_version_metadata (
  series_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  zhixu_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  artifact_hash TEXT,
  created_at TEXT NOT NULL,
  cutover_at TEXT,
  cutover_reason TEXT,
  PRIMARY KEY (series_id, version_id)
);

CREATE INDEX IF NOT EXISTS store_zhixu_version_status_idx
  ON store_zhixu_version_metadata (series_id, status, created_at);

CREATE TABLE IF NOT EXISTS store_supplier_metadata (
  supplier_id TEXT PRIMARY KEY,
  supplier_subject_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  wallet TEXT,
  capability_tags_json JSONB NOT NULL,
  supported_role_slot_ids_json JSONB NOT NULL,
  supported_stage_ids_json JSONB NOT NULL,
  registry_addresses_json JSONB NOT NULL,
  review_status TEXT NOT NULL,
  metadata_uri TEXT,
  notification_profile_json JSONB,
  notification_profile_hash TEXT,
  notification_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS store_supplier_metadata_updated_idx
  ON store_supplier_metadata (updated_at, supplier_id);

CREATE TABLE IF NOT EXISTS store_supplier_audit (
  row_id BIGSERIAL PRIMARY KEY,
  audit_id TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  supplier_subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  before_tags_json JSONB,
  after_tags_json JSONB,
  review_status TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS store_supplier_audit_supplier_idx
  ON store_supplier_audit (supplier_id, created_at);

CREATE TABLE IF NOT EXISTS store_docking_session (
  session_id TEXT PRIMARY KEY,
  source_zhixu_id TEXT NOT NULL,
  target_zhixu_id TEXT NOT NULL,
  source_version_id TEXT,
  target_version_id TEXT,
  status TEXT NOT NULL,
  draft_signal_map_json JSONB NOT NULL,
  validation_json JSONB NOT NULL,
  session_json JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS store_docking_session_zhixu_idx
  ON store_docking_session (source_zhixu_id, target_zhixu_id, updated_at);
