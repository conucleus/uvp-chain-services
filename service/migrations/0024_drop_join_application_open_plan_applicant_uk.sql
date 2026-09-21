-- store_join_application 的打开态唯一裁决（同 plan + 同申请人至多一条
-- applied/under_review）由 0018 的部分唯一索引 store_join_application_open_unique
-- 执行；0015 中的 store_join_application_open_plan_applicant_uk 对同一约束
-- 重复建索引——约束被双份执行，写路径白付一份维护成本。已应用文件不可
-- 原地删除，重复索引以本迁移收口，唯一裁决保留在 0018。
DROP INDEX IF EXISTS store_join_application_open_plan_applicant_uk;
