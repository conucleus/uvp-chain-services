-- stage-patch prepared/submission/nonce 状态持久化：prepared 签名载荷与
-- nonce 预留不再依赖进程内存——重启后已签名的 prepare 仍可提交，多实例
-- 共享库时 nonce 预留由唯一键承担（跨实例防双播）。
CREATE TABLE IF NOT EXISTS stage_patch_prepared (
  prepare_id TEXT PRIMARY KEY,
  patch_kind TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_patch_submission (
  submission_id TEXT PRIMARY KEY,
  patch_kind TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_patch_nonce (
  nonce_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
