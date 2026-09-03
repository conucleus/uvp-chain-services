-- PRD89/90/91/92: descriptor 快照、装修与委托、上架、加入申请
CREATE TABLE IF NOT EXISTS store_identity_descriptor_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  descriptor_hash TEXT NOT NULL,
  descriptor_json JSONB NOT NULL,
  source TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (subject_id, descriptor_hash)
);

CREATE TABLE IF NOT EXISTS store_zhixu_decoration (
  decoration_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  version BIGINT NOT NULL,
  data_json JSONB NOT NULL,
  author_address TEXT NOT NULL,
  author_account_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, version)
);

CREATE INDEX IF NOT EXISTS store_zhixu_decoration_plan_idx
  ON store_zhixu_decoration (plan_id, version);

CREATE TABLE IF NOT EXISTS store_publisher_delegation (
  delegation_id TEXT PRIMARY KEY,
  publisher_address TEXT NOT NULL,
  member_address TEXT NOT NULL,
  granted_by_address TEXT NOT NULL,
  granted_by_account_id TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_address TEXT,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS store_publisher_delegation_publisher_idx
  ON store_publisher_delegation (publisher_address, granted_at);

CREATE INDEX IF NOT EXISTS store_publisher_delegation_member_idx
  ON store_publisher_delegation (member_address, granted_at);

CREATE TABLE IF NOT EXISTS store_zhixu_listing (
  listing_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  plan_hash_claimed TEXT,
  deployment_id_claimed TEXT,
  state_machine_address_claimed TEXT,
  status TEXT NOT NULL,
  imported_by_address TEXT,
  imported_by_account_id TEXT,
  imported_at TEXT NOT NULL,
  reviewed_by_address TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  delist_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS store_zhixu_listing_status_idx
  ON store_zhixu_listing (status, updated_at);

CREATE TABLE IF NOT EXISTS store_join_application (
  application_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  zhixu_id TEXT,
  role_slot_id TEXT NOT NULL,
  authorization_kind TEXT NOT NULL,
  stage_id TEXT,
  applicant_address TEXT NOT NULL,
  applicant_account_id TEXT,
  applicant_subject_id TEXT NOT NULL,
  applicant_display_name TEXT,
  statement TEXT,
  status TEXT NOT NULL,
  supplier_id TEXT,
  tx_evidence_json JSONB NOT NULL,
  rejection_reason TEXT,
  revocation_reason TEXT,
  decided_by_address TEXT,
  decided_at TEXT,
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS store_join_application_plan_idx
  ON store_join_application (plan_id, submitted_at);

CREATE INDEX IF NOT EXISTS store_join_application_applicant_idx
  ON store_join_application (applicant_address, submitted_at);

CREATE TABLE IF NOT EXISTS store_join_application_event (
  event_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_address TEXT,
  actor_account_id TEXT,
  actor_auth_mode TEXT,
  reason TEXT,
  tx_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS store_join_application_event_idx
  ON store_join_application_event (application_id, created_at);
