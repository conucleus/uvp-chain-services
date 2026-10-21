-- store_zhixu_listing.status 是上架门/加入门消费的枚举，0015 建列时无
-- CHECK：脏值只能靠读取层抛错兜底。存储层显式 CHECK 后脏写入即被拒绝；
-- 存量脏行会让 ADD CONSTRAINT 响亮失败，由人工裁决而不是静默放行。
ALTER TABLE store_zhixu_listing
  ADD CONSTRAINT store_zhixu_listing_status_check
  CHECK (status IN ('imported', 'public', 'rejected', 'delisted'));
