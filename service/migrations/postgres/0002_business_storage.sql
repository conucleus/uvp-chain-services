CREATE TABLE IF NOT EXISTS product_order_draft (
  draft_id TEXT PRIMARY KEY,
  zhixu_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  business_type TEXT NOT NULL,
  goods_json JSONB NOT NULL,
  total_amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  export_region TEXT,
  destination_region TEXT,
  expected_completion_date TEXT,
  notes TEXT,
  status TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  triggered_order_id TEXT UNIQUE,
  trigger_tx_hash TEXT
);

CREATE TABLE IF NOT EXISTS product_participant (
  participant_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  role_slot_id TEXT NOT NULL,
  role_label TEXT NOT NULL,
  display_name TEXT NOT NULL,
  wallet_address TEXT,
  contact TEXT NOT NULL,
  status TEXT NOT NULL,
  required BOOLEAN NOT NULL,
  accepted_at TEXT,
  rejected_at TEXT,
  FOREIGN KEY (draft_id) REFERENCES product_order_draft (draft_id) ON DELETE CASCADE,
  UNIQUE (draft_id, role_slot_id)
);

CREATE INDEX IF NOT EXISTS product_participant_draft_idx
  ON product_participant (draft_id);

CREATE TABLE IF NOT EXISTS product_invite (
  invite_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  role_slot_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_wallet_address TEXT,
  FOREIGN KEY (draft_id) REFERENCES product_order_draft (draft_id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES product_participant (participant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS product_invite_draft_idx
  ON product_invite (draft_id, created_at);

CREATE TABLE IF NOT EXISTS product_order_trigger (
  trigger_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL UNIQUE,
  state_machine_address TEXT,
  deployment_id TEXT,
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT UNIQUE,
  block_number TEXT,
  error_code TEXT,
  error_message TEXT,
  retryable BOOLEAN NOT NULL,
  reconcile_status TEXT,
  last_checked_at TEXT,
  receipt_status TEXT,
  projection_status TEXT,
  creator TEXT NOT NULL,
  authorizations_json JSONB NOT NULL,
  permissions_json JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (draft_id) REFERENCES product_order_draft (draft_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evidence_object (
  evidence_id TEXT PRIMARY KEY,
  order_id TEXT,
  draft_id TEXT,
  task_id TEXT,
  stage_identifier TEXT NOT NULL,
  owner_participant_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_uri TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  -- G-07/L-3：去重按 owner 维度——同凭证不同参与者各自落档，第二参与者
  -- 上传同 payload_hash 不再撞全局唯一约束变成不可重试的 500。
  payload_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  bound_signal_tx_hash TEXT,
  bound_submission_id TEXT,
  bound_onchain_order_id TEXT,
  bound_source_id TEXT,
  bound_signal_id TEXT,
  bound_at TEXT,
  metadata_json JSONB NOT NULL,
  canonical_metadata_json JSONB NOT NULL,
  UNIQUE (owner_participant_id, payload_hash)
);

CREATE INDEX IF NOT EXISTS evidence_object_order_idx
  ON evidence_object (order_id, task_id, stage_identifier);

CREATE TABLE IF NOT EXISTS evidence_access_policy (
  evidence_id TEXT PRIMARY KEY,
  order_id TEXT,
  readers_json JSONB NOT NULL,
  writers_json JSONB NOT NULL,
  admin_readers_json JSONB NOT NULL,
  dispute_readers_json JSONB NOT NULL,
  FOREIGN KEY (evidence_id) REFERENCES evidence_object (evidence_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evidence_admin_read_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  evidence_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  route TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_admin_read_evidence_idx
  ON evidence_admin_read_audit (evidence_id, accessed_at);

-- CS-P5：prepare 与 submission 拆表。submission 以 submission_id 为主键
-- 追加保留历史（同一 prepare 的可重试失败重提不得覆盖先前提交档案，
-- 与内存 store 语义一致）；business key 唯一性收敛到 prepare 一侧。
CREATE TABLE IF NOT EXISTS submission_prepare (
  prepare_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  onchain_order_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  stage_identifier TEXT NOT NULL,
  signal_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  submitter TEXT NOT NULL,
  nonce TEXT NOT NULL,
  deadline TEXT NOT NULL,
  prepared_json JSONB NOT NULL,
  submission_id TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS submission_business_key_idx
  ON submission_prepare (plan_id, order_id, task_id, submitter, signal_name, nonce);

CREATE INDEX IF NOT EXISTS submission_prepare_plan_order_idx
  ON submission_prepare (plan_id, onchain_order_id);

CREATE TABLE IF NOT EXISTS submission (
  submission_id TEXT PRIMARY KEY,
  prepare_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  onchain_order_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  stage_identifier TEXT NOT NULL,
  signal_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  submitter TEXT NOT NULL,
  nonce TEXT NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL,
  submission_json JSONB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS submission_prepare_id_idx
  ON submission (prepare_id);

CREATE TABLE IF NOT EXISTS submission_attempt (
  attempt_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  tx_hash TEXT UNIQUE,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  revert_reason TEXT,
  gas_payer TEXT,
  attempt_number INTEGER NOT NULL,
  attempt_json JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS submission_attempt_submission_idx
  ON submission_attempt (submission_id, attempt_number);

CREATE TABLE IF NOT EXISTS submission_nonce (
  nonce_key TEXT PRIMARY KEY,
  reserved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS governance_review (
  review_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  risk_tags_json JSONB NOT NULL,
  public_summary TEXT NOT NULL,
  internal_notes TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  metadata_uri TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS governance_review_subject_idx
  ON governance_review (subject_type, subject_id, updated_at);

CREATE TABLE IF NOT EXISTS governance_tx_log (
  log_id TEXT PRIMARY KEY,
  tx_log_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  account TEXT,
  descriptor_hash TEXT,
  descriptor_uri TEXT,
  binding_id TEXT,
  reason_hash TEXT,
  reason_uri TEXT,
  tx_hash TEXT UNIQUE,
  block_number TEXT,
  signer TEXT,
  requester TEXT NOT NULL,
  status TEXT NOT NULL,
  broadcast_status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  retryable BOOLEAN NOT NULL,
  request_json JSONB NOT NULL,
  log_json JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS governance_tx_log_subject_created_idx
  ON governance_tx_log (subject_id, created_at);
