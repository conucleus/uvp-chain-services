-- stage-patch prepared/submission/nonce 状态持久化：prepared 签名载荷与
-- nonce 预留不再依赖进程内存——重启后已签名的 prepare 仍可提交，多实例
-- 共享库时 nonce 预留由唯一键承担（跨实例防双播）。
-- deadline_seconds：prepare 的授权截止（unix 秒），deleteExpiredPrepared
-- 按此列清扫——prepare 入口无配额，只插不删会让每行数 KB（含完整
-- typedData）的表无界堆叠；契约由服务层在写入时顺带清扫（见
-- stage-patches/types.ts 的 deleteExpiredPrepared 注释）。
CREATE TABLE IF NOT EXISTS stage_patch_prepared (
  prepare_id TEXT PRIMARY KEY,
  patch_kind TEXT NOT NULL,
  record_json TEXT NOT NULL,
  deadline_seconds BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stage_patch_prepared_deadline
  ON stage_patch_prepared (deadline_seconds);

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
