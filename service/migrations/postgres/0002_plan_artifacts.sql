--
-- Phase 2A projection seam：计划编译产物表（行级不可变）与 supplier 标签列清理。
-- plan_artifacts 是索引富集/语义回放的唯一 off-chain plan 词表权威，按
-- (chain_id, plan_id, plan_hash) 内容寻址；store_supplier_metadata.capability_tags_json
-- 与 store_supplier_audit.before_tags_json/after_tags_json 归 spec/app 所有，服务不再读写。
--

CREATE TABLE public.plan_artifacts (
    chain_id integer NOT NULL,
    plan_id text NOT NULL,
    plan_hash text NOT NULL,
    artifact_json jsonb NOT NULL,
    recorded_at text NOT NULL
);


ALTER TABLE ONLY public.plan_artifacts
    ADD CONSTRAINT plan_artifacts_pkey PRIMARY KEY (chain_id, plan_id, plan_hash);


CREATE FUNCTION public.plan_artifacts_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'plan_artifacts rows are immutable: % rejected for plan %', TG_OP, OLD.plan_id;
END;
$$;


CREATE TRIGGER plan_artifacts_immutable
    BEFORE UPDATE OR DELETE ON public.plan_artifacts
    FOR EACH ROW EXECUTE FUNCTION public.plan_artifacts_reject_mutation();


ALTER TABLE ONLY public.store_supplier_metadata
    DROP COLUMN capability_tags_json;


ALTER TABLE ONLY public.store_supplier_audit
    DROP COLUMN before_tags_json,
    DROP COLUMN after_tags_json;
