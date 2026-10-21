-- store_zhixu_listing.status 是上架门/加入门消费的枚举，0015 建列时无
-- CHECK：脏值只能靠读取层抛错兜底。存储层显式 CHECK 后脏写入即被拒绝；
-- 存量脏行会让本迁移响亮失败，由人工裁决而不是静默放行。
-- SQLite 无 ALTER TABLE ADD CONSTRAINT，按建新表-拷贝-改名收口（迁移
-- 整体在事务内执行，CHECK 命中即整体回滚）。
CREATE TABLE store_zhixu_listing_with_status_check (
  listing_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  plan_hash_claimed TEXT,
  deployment_id_claimed TEXT,
  state_machine_address_claimed TEXT,
  status TEXT NOT NULL CHECK (status IN ('imported', 'public', 'rejected', 'delisted')),
  imported_by_address TEXT,
  imported_by_account_id TEXT,
  imported_at TEXT NOT NULL,
  reviewed_by_address TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  delist_reason TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO store_zhixu_listing_with_status_check
  SELECT listing_id, plan_id, plan_hash_claimed, deployment_id_claimed, state_machine_address_claimed,
         status, imported_by_address, imported_by_account_id, imported_at,
         reviewed_by_address, reviewed_at, review_note, delist_reason, updated_at
  FROM store_zhixu_listing;

DROP TABLE store_zhixu_listing;
ALTER TABLE store_zhixu_listing_with_status_check RENAME TO store_zhixu_listing;

CREATE INDEX IF NOT EXISTS store_zhixu_listing_status_idx
  ON store_zhixu_listing (status, updated_at);
