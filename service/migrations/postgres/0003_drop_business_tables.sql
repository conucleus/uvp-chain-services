--
-- Phase 5 收口：业务表所有权移交 uvp-app-backend。
--
-- 0001 在 `public` 建的 36 张业务表分两类：
--   1) 22 张已由 app-backend 迁移 0002_app_business_schema.sql 建在 `app` schema
--      （列/约束/索引名字与语义不变，仅 schema 限定符不同）；
--   2) 14 张无代码引用的退役 store/notification 业务表（BOUNDARY-MAP §3.3），只 drop 不迁移。
-- 链事件/投影/relay 操作态（chain_*、submission*、stage_patch_*、broadcast_dedupe_*、
-- indexer_pending_post_commit）与 plan_artifacts 不动。
--
-- 依赖只在这些业务表之间（同一条 DROP 里一并删除，无需 CASCADE）。系统未上线，
-- 没有存量数据迁移；本地开发库删掉重建即可。
--

DROP TABLE IF EXISTS
    public.evidence_admin_read_audit,
    public.evidence_access_policy,
    public.evidence_object,
    public.order_requirement_consent,
    public.order_requirement_bundle,
    public.order_invite_v3,
    public.order_stage_slot_v3,
    public.order_v3,
    public.order_stage_v3,
    public.order_draft_v3,
    public.order_config_v3,
    public.order_idempotency_v3,
    public.product_invite,
    public.product_order_trigger,
    public.product_participant,
    public.product_order_draft,
    public.governance_review,
    public.governance_tx_log,
    public.store_identity_descriptor_snapshot,
    public.store_auth_challenge,
    public.store_wallet_session,
    public.store_account_address,
    public.notification_delivery,
    public.notification_read_state,
    public.store_operator_audit,
    public.store_docking_session,
    public.store_entity_registration,
    public.store_join_application_event,
    public.store_join_application,
    public.store_publisher_delegation,
    public.store_supplier_audit,
    public.store_supplier_metadata,
    public.store_zhixu_decoration,
    public.store_zhixu_draft,
    public.store_zhixu_listing,
    public.store_zhixu_version_metadata;
