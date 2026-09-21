-- 簇 D/簇 N 修正（审计三轮）：review 哈希材料持久化 + 防重唯一约束。

-- 簇 D：review 哈希材料原文（metadata/policy）随记录持久化，
-- registerIdentity 重建 descriptor 哈希时不再丢材料。
ALTER TABLE governance_review ADD COLUMN IF NOT EXISTS metadata_document_json JSONB;
ALTER TABLE governance_review ADD COLUMN IF NOT EXISTS policy_document_json JSONB;

-- 簇 N：供应商审计 ID 唯一（与 store_operator_audit.audit_id 同口径，
-- 防止重复插入造成的审计噪声）。
CREATE UNIQUE INDEX IF NOT EXISTS store_supplier_audit_audit_id_uidx
  ON store_supplier_audit (audit_id);

-- 簇 D：加入申请防重——同一 (plan_id, applicant_address) 同时至多一条
-- 打开状态（applied/under_review）的申请，与服务层 openDuplicate 检查
-- 同口径，数据库层兜底并发竞态。
CREATE UNIQUE INDEX IF NOT EXISTS store_join_application_open_unique
  ON store_join_application (plan_id, applicant_address)
  WHERE status IN ('applied', 'under_review');
