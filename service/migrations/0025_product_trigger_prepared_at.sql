-- 同身份重开（重试=同身份重放，UB-3/UA-2）的时钟列：prepared_at 记录
-- 最近一次 prepare（含同身份重开）的时间，对账超时判定（reconcile
-- timedOut）读此时钟；created_at 在重开时按审计目的继承旧行（首次建档
-- 时间），不得毒化重试后的超时判定。存量行缺省回退 created_at。
ALTER TABLE product_order_trigger ADD COLUMN prepared_at TEXT;
