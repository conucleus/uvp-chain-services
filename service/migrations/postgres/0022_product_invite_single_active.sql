-- invite 单活约束：同一 participant 只允许一行 status='active'。
-- INSERT ... SELECT WHERE NOT EXISTS 的子查询读的是语句快照，PG
-- READ COMMITTED 下并发双 createInvite 会双双通过检查、双双落库
-- （表上没有可阻塞的唯一键）——单活裁决必须下沉到存储层索引。
-- 时间性过期不在此索引语义内：过期档由服务层先翻 expired 再发新邀。
CREATE UNIQUE INDEX IF NOT EXISTS product_invite_single_active_uk
  ON product_invite (participant_id)
  WHERE status = 'active';
