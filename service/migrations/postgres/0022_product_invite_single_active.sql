-- invite 单活约束：同一 participant 只允许一行 status='active'。
-- INSERT ... SELECT WHERE NOT EXISTS 的子查询读的是语句快照，PG
-- READ COMMITTED 下并发双 createInvite 会双双通过检查、双双落库
-- （表上没有可阻塞的唯一键）——单活裁决必须下沉到存储层索引。
-- 时间性过期不在此索引语义内：过期档由服务层先翻 expired 再发新邀。
--
-- 存量双 active 正是该索引要防的历史竞态产物：直接建索引会在重复组上
-- 失败、阻断升级。先确定性收敛再上索引——每组保留最新行（created_at，
-- 平局以 invite_id 决胜），旧行翻 revoked：撤销语义与 expired 的
-- 时间口径不同（旧行未必过期），读取侧对 revoked 已有终态处理
-- （410 invite_revoked）。
UPDATE product_invite AS older
SET status = 'revoked'
WHERE older.status = 'active'
  AND EXISTS (
    SELECT 1
    FROM product_invite AS newer
    WHERE newer.participant_id = older.participant_id
      AND newer.status = 'active'
      AND (newer.created_at > older.created_at
        OR (newer.created_at = older.created_at
          AND newer.invite_id > older.invite_id))
  );

CREATE UNIQUE INDEX IF NOT EXISTS product_invite_single_active_uk
  ON product_invite (participant_id)
  WHERE status = 'active';
