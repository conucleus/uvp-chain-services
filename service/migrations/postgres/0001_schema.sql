--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET search_path = public;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: plan_artifacts_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plan_artifacts_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'plan_artifacts rows are immutable: % rejected for plan %', TG_OP, OLD.plan_id;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: chain_event_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chain_event_log (
    chain_id integer NOT NULL,
    contract_address text NOT NULL,
    block_number numeric NOT NULL,
    transaction_hash text NOT NULL,
    log_index integer NOT NULL,
    event_id text NOT NULL,
    event_name text NOT NULL,
    args_json jsonb NOT NULL,
    removed boolean DEFAULT false NOT NULL,
    block_hash text,
    created_at text NOT NULL,
    transaction_index integer
);


--
-- Name: chain_index_cursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chain_index_cursor (
    chain_id integer NOT NULL,
    contract_address text NOT NULL,
    deployment_block numeric NOT NULL,
    next_block numeric NOT NULL,
    finalized_block numeric,
    updated_at text NOT NULL,
    block_hash text
);


--
-- Name: chain_projection_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chain_projection_snapshot (
    chain_id integer NOT NULL,
    contract_address text NOT NULL,
    snapshot_kind text NOT NULL,
    snapshot_version integer NOT NULL,
    snapshot_json jsonb NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: chain_projection_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chain_projection_sync_state (
    chain_id integer NOT NULL,
    contract_address text NOT NULL,
    sync_status text NOT NULL,
    latest_indexed_block numeric,
    finalized_block numeric,
    confirmation_depth integer DEFAULT 0 NOT NULL,
    last_event_name text,
    event_count integer DEFAULT 0 NOT NULL,
    rebuild_json jsonb,
    degraded_reason text,
    updated_at text NOT NULL,
    projection_diagnostics_json jsonb
);



--
-- Name: indexer_pending_post_commit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.indexer_pending_post_commit (
    step_id text NOT NULL,
    chain_id integer NOT NULL,
    kind text NOT NULL,
    events_json jsonb,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: plan_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_artifacts (
    chain_id integer NOT NULL,
    plan_id text NOT NULL,
    plan_hash text NOT NULL,
    artifact_json jsonb NOT NULL,
    recorded_at text NOT NULL
);


--
-- Name: chain_event_log chain_event_log_chain_id_contract_address_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chain_event_log
    ADD CONSTRAINT chain_event_log_chain_id_contract_address_event_id_key UNIQUE (chain_id, contract_address, event_id);


--
-- Name: chain_event_log chain_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chain_event_log
    ADD CONSTRAINT chain_event_log_pkey PRIMARY KEY (chain_id, contract_address, block_number, transaction_hash, log_index);


--
-- Name: chain_index_cursor chain_index_cursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chain_index_cursor
    ADD CONSTRAINT chain_index_cursor_pkey PRIMARY KEY (chain_id, contract_address);


--
-- Name: chain_projection_snapshot chain_projection_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chain_projection_snapshot
    ADD CONSTRAINT chain_projection_snapshot_pkey PRIMARY KEY (chain_id, contract_address, snapshot_kind);


--
-- Name: chain_projection_sync_state chain_projection_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chain_projection_sync_state
    ADD CONSTRAINT chain_projection_sync_state_pkey PRIMARY KEY (chain_id, contract_address);



--
-- Name: indexer_pending_post_commit indexer_pending_post_commit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexer_pending_post_commit
    ADD CONSTRAINT indexer_pending_post_commit_pkey PRIMARY KEY (step_id);


--
-- Name: plan_artifacts plan_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_artifacts
    ADD CONSTRAINT plan_artifacts_pkey PRIMARY KEY (chain_id, plan_id, plan_hash);


--
-- Name: chain_event_log_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chain_event_log_order_idx ON public.chain_event_log USING btree (chain_id, block_number, transaction_index, log_index);


--
-- Name: indexer_pending_post_commit_chain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexer_pending_post_commit_chain_idx ON public.indexer_pending_post_commit USING btree (chain_id, kind, updated_at);


--
-- Name: plan_artifacts plan_artifacts_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER plan_artifacts_immutable BEFORE DELETE OR UPDATE ON public.plan_artifacts FOR EACH ROW EXECUTE FUNCTION public.plan_artifacts_reject_mutation();
