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
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: broadcast_dedupe_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.broadcast_dedupe_state (
    idempotency_key text NOT NULL,
    attempts integer NOT NULL,
    last_result_json text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: broadcast_dedupe_tx_owner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.broadcast_dedupe_tx_owner (
    tx_hash text NOT NULL,
    idempotency_key text NOT NULL,
    updated_at text NOT NULL
);


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
-- Name: evidence_access_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evidence_access_policy (
    evidence_id text NOT NULL,
    order_id text,
    readers_json jsonb NOT NULL,
    writers_json jsonb NOT NULL,
    admin_readers_json jsonb NOT NULL,
    adjudicator_readers_json jsonb NOT NULL
);


--
-- Name: evidence_admin_read_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evidence_admin_read_audit (
    audit_id bigint NOT NULL,
    evidence_id text NOT NULL,
    principal_id text NOT NULL,
    accessed_at text NOT NULL,
    route text NOT NULL
);


--
-- Name: evidence_admin_read_audit_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.evidence_admin_read_audit_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: evidence_admin_read_audit_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.evidence_admin_read_audit_audit_id_seq OWNED BY public.evidence_admin_read_audit.audit_id;


--
-- Name: evidence_object; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evidence_object (
    evidence_id text NOT NULL,
    order_id text,
    draft_id text,
    task_id text,
    stage_identifier text NOT NULL,
    owner_participant_id text NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    size integer NOT NULL,
    storage_uri text NOT NULL,
    content_hash text NOT NULL,
    metadata_hash text NOT NULL,
    payload_hash text NOT NULL,
    payload_ref text NOT NULL,
    status text NOT NULL,
    created_at text NOT NULL,
    bound_signal_tx_hash text,
    bound_submission_id text,
    bound_onchain_order_id text,
    bound_source_id text,
    bound_signal_id text,
    bound_at text,
    metadata_json jsonb NOT NULL,
    canonical_metadata_json jsonb NOT NULL
);


--
-- Name: governance_review; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.governance_review (
    review_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    status text NOT NULL,
    risk_level text NOT NULL,
    risk_tags_json jsonb NOT NULL,
    public_summary text NOT NULL,
    internal_notes text NOT NULL,
    policy_hash text NOT NULL,
    metadata_hash text NOT NULL,
    metadata_uri text NOT NULL,
    reviewer text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    metadata_document_json jsonb,
    policy_document_json jsonb
);


--
-- Name: governance_tx_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.governance_tx_log (
    log_id text NOT NULL,
    tx_log_id text NOT NULL,
    action text NOT NULL,
    subject_id text NOT NULL,
    account text,
    descriptor_hash text,
    descriptor_uri text,
    binding_id text,
    reason_hash text,
    reason_uri text,
    tx_hash text,
    block_number text,
    signer text,
    requester text NOT NULL,
    status text NOT NULL,
    broadcast_status text NOT NULL,
    error_code text,
    error_message text,
    retryable boolean NOT NULL,
    request_json jsonb NOT NULL,
    log_json jsonb NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
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
-- Name: notification_delivery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_delivery (
    delivery_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    task_id text,
    order_id text NOT NULL,
    receiver_hook_id text,
    receiver_stage_id text,
    source_id text,
    signal_id text,
    payload_hash text,
    idempotency_key text,
    chain_id integer NOT NULL,
    state_machine_address text NOT NULL,
    submitter text,
    supplier_subject_id text,
    supplier_wallet text,
    transport_type text,
    activation_status text,
    external_receipt_ref text,
    reason text,
    payload_json text NOT NULL,
    attempts integer NOT NULL,
    last_error text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: notification_read_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_read_state (
    participant_key text NOT NULL,
    notification_id text NOT NULL,
    read_at text NOT NULL
);


--
-- Name: order_config_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_config_v3 (
    config_id text NOT NULL,
    version text NOT NULL,
    status text NOT NULL,
    config_hash text NOT NULL,
    plan_id text,
    plan_hash text,
    birth_json text,
    bundle_json text NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL,
    published_at text,
    updated_at text NOT NULL
);


--
-- Name: order_draft_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_draft_v3 (
    draft_id text NOT NULL,
    config_id text NOT NULL,
    config_version text NOT NULL,
    config_hash text NOT NULL,
    buyer_wallet text NOT NULL,
    chain_id integer NOT NULL,
    state_machine text NOT NULL,
    title text NOT NULL,
    currency text NOT NULL,
    stage_subset_json text NOT NULL,
    status text NOT NULL,
    terms_hash text,
    finalize_nonce text,
    finalize_deadline text,
    order_id text,
    plan_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    frozen_at text
);


--
-- Name: order_idempotency_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_idempotency_v3 (
    principal_wallet text NOT NULL,
    operation text NOT NULL,
    idem_key text NOT NULL,
    request_hash text NOT NULL,
    resource_id text,
    response_json text NOT NULL,
    status text NOT NULL,
    created_at text NOT NULL,
    expires_at text NOT NULL
);


--
-- Name: order_invite_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_invite_v3 (
    invite_id text NOT NULL,
    draft_id text NOT NULL,
    stage_key text NOT NULL,
    stage_id text NOT NULL,
    slot_key text NOT NULL,
    subject_label text NOT NULL,
    contact_ref text,
    wallet text,
    token_hash text NOT NULL,
    nonce text NOT NULL,
    status text NOT NULL,
    expires_at text NOT NULL,
    created_by text NOT NULL,
    accepted_by text,
    accepted_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: order_requirement_bundle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_requirement_bundle (
    draft_id text NOT NULL,
    schema_version text NOT NULL,
    declaration_json text NOT NULL,
    requirements_hash text NOT NULL,
    declared_by text NOT NULL,
    declared_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: order_requirement_consent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_requirement_consent (
    consent_id text NOT NULL,
    draft_id text NOT NULL,
    wallet_address text NOT NULL,
    requirements_hash text NOT NULL,
    signature text NOT NULL,
    signed_at text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: order_stage_slot_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_stage_slot_v3 (
    draft_id text NOT NULL,
    stage_key text NOT NULL,
    slot_key text NOT NULL,
    required integer NOT NULL,
    subject_label text,
    contact_ref text,
    wallet text,
    status text NOT NULL,
    invite_id text,
    accepted_terms_hash text,
    accepted_at text,
    signature text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: order_stage_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_stage_v3 (
    draft_id text NOT NULL,
    stage_key text NOT NULL,
    stage_id text NOT NULL,
    stage_index integer NOT NULL,
    amount text NOT NULL,
    slots_json text NOT NULL,
    profile_ref text,
    standard_json text,
    final_standard_hash text NOT NULL,
    invite_deadline text NOT NULL,
    work_deadline text NOT NULL,
    terms_hash text NOT NULL,
    status text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: order_v3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_v3 (
    order_id text NOT NULL,
    draft_id text NOT NULL,
    plan_id text NOT NULL,
    state_machine text NOT NULL,
    chain_id integer NOT NULL,
    buyer_wallet text NOT NULL,
    terms_hash text NOT NULL,
    status text NOT NULL,
    tx_hash text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: product_invite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_invite (
    invite_id text NOT NULL,
    draft_id text NOT NULL,
    participant_id text NOT NULL,
    role_slot_id text NOT NULL,
    token_hash text NOT NULL,
    status text NOT NULL,
    expires_at text NOT NULL,
    created_at text NOT NULL,
    accepted_wallet_address text
);


--
-- Name: product_order_draft; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_order_draft (
    draft_id text NOT NULL,
    zhixu_id text NOT NULL,
    plan_id text NOT NULL,
    plan_hash text NOT NULL,
    title text NOT NULL,
    business_type text NOT NULL,
    goods_json jsonb NOT NULL,
    total_amount text NOT NULL,
    currency text NOT NULL,
    export_region text,
    destination_region text,
    expected_completion_date text,
    notes text,
    status text NOT NULL,
    created_by text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    triggered_order_id text,
    trigger_tx_hash text
);


--
-- Name: product_order_trigger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_order_trigger (
    trigger_id text NOT NULL,
    draft_id text NOT NULL,
    order_id text NOT NULL,
    state_machine_address text,
    deployment_id text,
    plan_id text NOT NULL,
    plan_hash text NOT NULL,
    status text NOT NULL,
    tx_hash text,
    block_number text,
    error_code text,
    error_message text,
    retryable boolean NOT NULL,
    reconcile_status text,
    last_checked_at text,
    receipt_status text,
    projection_status text,
    creator text NOT NULL,
    authorizations_json jsonb NOT NULL,
    permissions_json jsonb NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    prepare_id text,
    source_id text,
    signal_id text,
    trigger_hook_id text,
    trigger_stage_id text,
    submitter text,
    payload_hash text,
    idempotency_key text,
    deadline text,
    typed_data_json jsonb,
    signature text,
    prepared_at text
);


--
-- Name: product_participant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_participant (
    participant_id text NOT NULL,
    draft_id text NOT NULL,
    role_slot_id text NOT NULL,
    role_label text NOT NULL,
    display_name text NOT NULL,
    wallet_address text,
    contact text NOT NULL,
    status text NOT NULL,
    required boolean NOT NULL,
    accepted_at text,
    rejected_at text
);


--
-- Name: stage_patch_nonce; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stage_patch_nonce (
    nonce_key text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: stage_patch_prepared; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stage_patch_prepared (
    prepare_id text NOT NULL,
    patch_kind text NOT NULL,
    record_json text NOT NULL,
    deadline_seconds bigint NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: stage_patch_submission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stage_patch_submission (
    submission_id text NOT NULL,
    patch_kind text NOT NULL,
    record_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: store_account_address; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_account_address (
    address text NOT NULL,
    account_id text NOT NULL,
    status text NOT NULL,
    anchored_at text NOT NULL,
    anchor_session_id text,
    revoked_at text,
    revoked_by_session_id text
);


--
-- Name: store_auth_challenge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_auth_challenge (
    nonce text NOT NULL,
    address text NOT NULL,
    intent text NOT NULL,
    account_id text,
    message text NOT NULL,
    issued_at text NOT NULL,
    expires_at text NOT NULL,
    consumed_at text,
    requester_key text DEFAULT ''::text NOT NULL
);


--
-- Name: store_docking_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_docking_session (
    session_id text NOT NULL,
    source_zhixu_id text NOT NULL,
    target_zhixu_id text NOT NULL,
    selected_interface_name text NOT NULL,
    order_mode text NOT NULL,
    status text NOT NULL,
    draft_signal_map_json jsonb NOT NULL,
    validation_json jsonb NOT NULL,
    session_json jsonb NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: store_entity_registration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_entity_registration (
    registration_id text NOT NULL,
    account_address text NOT NULL,
    account_id text,
    legal_name text NOT NULL,
    registration_number text NOT NULL,
    contact_name text NOT NULL,
    status text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    CONSTRAINT store_entity_registration_status_check CHECK ((status = ANY (ARRAY['self_declared'::text, 'pending_review'::text])))
);


--
-- Name: store_identity_descriptor_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_identity_descriptor_snapshot (
    snapshot_id text NOT NULL,
    subject_id text NOT NULL,
    descriptor_hash text NOT NULL,
    descriptor_json jsonb NOT NULL,
    source text NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: store_join_application; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_join_application (
    application_id text NOT NULL,
    plan_id text NOT NULL,
    zhixu_id text,
    role_slot_id text NOT NULL,
    authorization_kind text NOT NULL,
    stage_id text,
    applicant_address text NOT NULL,
    applicant_account_id text,
    applicant_subject_id text NOT NULL,
    applicant_display_name text,
    statement text,
    status text NOT NULL,
    supplier_id text,
    tx_evidence_json jsonb NOT NULL,
    rejection_reason text,
    revocation_reason text,
    decided_by_address text,
    decided_at text,
    submitted_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: store_join_application_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_join_application_event (
    event_id text NOT NULL,
    application_id text NOT NULL,
    type text NOT NULL,
    actor_address text,
    actor_account_id text,
    actor_auth_mode text,
    reason text,
    tx_hash text,
    created_at text NOT NULL
);


--
-- Name: store_operator_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_operator_audit (
    row_id bigint NOT NULL,
    audit_id text NOT NULL,
    created_at text NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    outcome text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    parent_id text,
    access_level text NOT NULL,
    auth_mode text NOT NULL,
    roles_json jsonb NOT NULL,
    error_code text,
    request_id text,
    metadata_json jsonb
);


--
-- Name: store_operator_audit_row_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.store_operator_audit_row_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: store_operator_audit_row_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.store_operator_audit_row_id_seq OWNED BY public.store_operator_audit.row_id;


--
-- Name: store_publisher_delegation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_publisher_delegation (
    delegation_id text NOT NULL,
    publisher_address text NOT NULL,
    member_address text NOT NULL,
    granted_by_address text NOT NULL,
    granted_by_account_id text,
    granted_at text NOT NULL,
    revoked_at text,
    revoked_by_address text,
    reason text
);


--
-- Name: store_supplier_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_supplier_audit (
    row_id bigint NOT NULL,
    audit_id text NOT NULL,
    supplier_id text NOT NULL,
    supplier_subject_id text NOT NULL,
    action text NOT NULL,
    actor text NOT NULL,
    before_tags_json jsonb,
    after_tags_json jsonb,
    review_status text,
    created_at text NOT NULL,
    before_supported_role_slot_ids_json jsonb,
    after_supported_role_slot_ids_json jsonb,
    before_supported_stage_ids_json jsonb,
    after_supported_stage_ids_json jsonb
);


--
-- Name: store_supplier_audit_row_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.store_supplier_audit_row_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: store_supplier_audit_row_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.store_supplier_audit_row_id_seq OWNED BY public.store_supplier_audit.row_id;


--
-- Name: store_supplier_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_supplier_metadata (
    supplier_id text NOT NULL,
    supplier_subject_id text NOT NULL,
    display_name text NOT NULL,
    wallet text,
    capability_tags_json jsonb NOT NULL,
    supported_role_slot_ids_json jsonb NOT NULL,
    supported_stage_ids_json jsonb NOT NULL,
    registry_addresses_json jsonb NOT NULL,
    review_status text NOT NULL,
    metadata_uri text,
    notification_profile_json jsonb,
    notification_profile_hash text,
    notification_updated_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: store_wallet_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_wallet_session (
    session_id text NOT NULL,
    token_hash text NOT NULL,
    account_id text NOT NULL,
    anchored_address text NOT NULL,
    created_at text NOT NULL,
    expires_at text NOT NULL,
    last_seen_at text,
    revoked_at text,
    revoked_reason text
);


--
-- Name: store_zhixu_decoration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_zhixu_decoration (
    decoration_id text NOT NULL,
    plan_id text NOT NULL,
    version bigint NOT NULL,
    data_json jsonb NOT NULL,
    author_address text NOT NULL,
    author_account_id text,
    note text,
    created_at text NOT NULL
);


--
-- Name: store_zhixu_draft; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_zhixu_draft (
    draft_id text NOT NULL,
    source_kind text NOT NULL,
    content text NOT NULL,
    status text NOT NULL,
    zhixu_id text,
    title text NOT NULL,
    maintainer text NOT NULL,
    public_summary text,
    tags_json jsonb NOT NULL,
    compile_preview_json jsonb,
    review_id text,
    errors_json jsonb NOT NULL,
    review_status text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    product_schema_json jsonb,
    publisher_address text DEFAULT '0x0000000000000000000000000000000000000000'::text NOT NULL
);


--
-- Name: store_zhixu_listing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_zhixu_listing (
    listing_id text NOT NULL,
    plan_id text NOT NULL,
    plan_hash_claimed text,
    deployment_id_claimed text,
    state_machine_address_claimed text,
    status text NOT NULL,
    imported_by_address text,
    imported_by_account_id text,
    imported_at text NOT NULL,
    reviewed_by_address text,
    reviewed_at text,
    review_note text,
    delist_reason text,
    updated_at text NOT NULL,
    CONSTRAINT store_zhixu_listing_status_check CHECK ((status = ANY (ARRAY['imported'::text, 'public'::text, 'rejected'::text, 'delisted'::text])))
);


--
-- Name: store_zhixu_version_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_zhixu_version_metadata (
    series_id text NOT NULL,
    version_id text NOT NULL,
    zhixu_id text NOT NULL,
    version_label text NOT NULL,
    status text NOT NULL,
    plan_id text NOT NULL,
    plan_hash text NOT NULL,
    artifact_hash text,
    created_at text NOT NULL,
    cutover_at text,
    cutover_reason text
);


--
-- Name: submission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission (
    submission_id text NOT NULL,
    prepare_id text NOT NULL,
    task_id text NOT NULL,
    order_id text NOT NULL,
    onchain_order_id text NOT NULL,
    plan_id text NOT NULL,
    stage_identifier text NOT NULL,
    signal_name text NOT NULL,
    source_id text NOT NULL,
    signal_id text NOT NULL,
    intent text NOT NULL,
    payload_hash text NOT NULL,
    payload_ref text NOT NULL,
    idempotency_key text NOT NULL,
    submitter text NOT NULL,
    nonce text NOT NULL,
    deadline text NOT NULL,
    status text NOT NULL,
    submission_json jsonb,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: submission_attempt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_attempt (
    attempt_id text NOT NULL,
    submission_id text NOT NULL,
    tx_hash text,
    status text NOT NULL,
    error_code text,
    error_message text,
    revert_reason text,
    gas_payer text,
    attempt_number integer NOT NULL,
    attempt_json jsonb NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    order_id text,
    source_id text,
    signal_id text,
    submitter text,
    block_number text,
    retryable boolean,
    retry_state text,
    dead_letter boolean,
    next_retry_at text
);


--
-- Name: submission_nonce; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_nonce (
    nonce_key text NOT NULL,
    reserved_at text NOT NULL
);


--
-- Name: submission_prepare; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_prepare (
    prepare_id text NOT NULL,
    task_id text NOT NULL,
    order_id text NOT NULL,
    onchain_order_id text NOT NULL,
    plan_id text NOT NULL,
    stage_identifier text NOT NULL,
    signal_name text NOT NULL,
    source_id text NOT NULL,
    signal_id text NOT NULL,
    intent text NOT NULL,
    payload_hash text NOT NULL,
    payload_ref text NOT NULL,
    idempotency_key text NOT NULL,
    submitter text NOT NULL,
    nonce text NOT NULL,
    deadline text NOT NULL,
    prepared_json jsonb NOT NULL,
    submission_id text,
    used_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: evidence_admin_read_audit audit_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evidence_admin_read_audit ALTER COLUMN audit_id SET DEFAULT nextval('public.evidence_admin_read_audit_audit_id_seq'::regclass);


--
-- Name: store_operator_audit row_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_operator_audit ALTER COLUMN row_id SET DEFAULT nextval('public.store_operator_audit_row_id_seq'::regclass);


--
-- Name: store_supplier_audit row_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_supplier_audit ALTER COLUMN row_id SET DEFAULT nextval('public.store_supplier_audit_row_id_seq'::regclass);


--
-- Name: broadcast_dedupe_state broadcast_dedupe_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broadcast_dedupe_state
    ADD CONSTRAINT broadcast_dedupe_state_pkey PRIMARY KEY (idempotency_key);


--
-- Name: broadcast_dedupe_tx_owner broadcast_dedupe_tx_owner_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broadcast_dedupe_tx_owner
    ADD CONSTRAINT broadcast_dedupe_tx_owner_pkey PRIMARY KEY (tx_hash);


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
-- Name: evidence_access_policy evidence_access_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evidence_access_policy
    ADD CONSTRAINT evidence_access_policy_pkey PRIMARY KEY (evidence_id);


--
-- Name: evidence_admin_read_audit evidence_admin_read_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evidence_admin_read_audit
    ADD CONSTRAINT evidence_admin_read_audit_pkey PRIMARY KEY (audit_id);


--
-- Name: evidence_object evidence_object_owner_participant_id_payload_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evidence_object
    ADD CONSTRAINT evidence_object_owner_participant_id_payload_hash_key UNIQUE (owner_participant_id, payload_hash);


--
-- Name: evidence_object evidence_object_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evidence_object
    ADD CONSTRAINT evidence_object_pkey PRIMARY KEY (evidence_id);


--
-- Name: governance_review governance_review_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.governance_review
    ADD CONSTRAINT governance_review_pkey PRIMARY KEY (review_id);


--
-- Name: governance_tx_log governance_tx_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.governance_tx_log
    ADD CONSTRAINT governance_tx_log_pkey PRIMARY KEY (log_id);


--
-- Name: governance_tx_log governance_tx_log_tx_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.governance_tx_log
    ADD CONSTRAINT governance_tx_log_tx_hash_key UNIQUE (tx_hash);


--
-- Name: governance_tx_log governance_tx_log_tx_log_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.governance_tx_log
    ADD CONSTRAINT governance_tx_log_tx_log_id_key UNIQUE (tx_log_id);


--
-- Name: indexer_pending_post_commit indexer_pending_post_commit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexer_pending_post_commit
    ADD CONSTRAINT indexer_pending_post_commit_pkey PRIMARY KEY (step_id);


--
-- Name: notification_delivery notification_delivery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_delivery
    ADD CONSTRAINT notification_delivery_pkey PRIMARY KEY (delivery_id);


--
-- Name: notification_read_state notification_read_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_read_state
    ADD CONSTRAINT notification_read_state_pkey PRIMARY KEY (participant_key, notification_id);


--
-- Name: order_config_v3 order_config_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_config_v3
    ADD CONSTRAINT order_config_v3_pkey PRIMARY KEY (config_id, version);


--
-- Name: order_draft_v3 order_draft_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_draft_v3
    ADD CONSTRAINT order_draft_v3_pkey PRIMARY KEY (draft_id);


--
-- Name: order_idempotency_v3 order_idempotency_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_idempotency_v3
    ADD CONSTRAINT order_idempotency_v3_pkey PRIMARY KEY (principal_wallet, operation, idem_key);


--
-- Name: order_invite_v3 order_invite_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_invite_v3
    ADD CONSTRAINT order_invite_v3_pkey PRIMARY KEY (invite_id);


--
-- Name: order_requirement_bundle order_requirement_bundle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_requirement_bundle
    ADD CONSTRAINT order_requirement_bundle_pkey PRIMARY KEY (draft_id);


--
-- Name: order_requirement_consent order_requirement_consent_draft_id_wallet_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_requirement_consent
    ADD CONSTRAINT order_requirement_consent_draft_id_wallet_address_key UNIQUE (draft_id, wallet_address);


--
-- Name: order_requirement_consent order_requirement_consent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_requirement_consent
    ADD CONSTRAINT order_requirement_consent_pkey PRIMARY KEY (consent_id);


--
-- Name: order_stage_slot_v3 order_stage_slot_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_stage_slot_v3
    ADD CONSTRAINT order_stage_slot_v3_pkey PRIMARY KEY (draft_id, stage_key, slot_key);


--
-- Name: order_stage_v3 order_stage_v3_draft_id_stage_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_stage_v3
    ADD CONSTRAINT order_stage_v3_draft_id_stage_id_key UNIQUE (draft_id, stage_id);


--
-- Name: order_stage_v3 order_stage_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_stage_v3
    ADD CONSTRAINT order_stage_v3_pkey PRIMARY KEY (draft_id, stage_key);


--
-- Name: order_v3 order_v3_draft_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_v3
    ADD CONSTRAINT order_v3_draft_id_key UNIQUE (draft_id);


--
-- Name: order_v3 order_v3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_v3
    ADD CONSTRAINT order_v3_pkey PRIMARY KEY (order_id);


--
-- Name: product_invite product_invite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_invite
    ADD CONSTRAINT product_invite_pkey PRIMARY KEY (invite_id);


--
-- Name: product_invite product_invite_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_invite
    ADD CONSTRAINT product_invite_token_hash_key UNIQUE (token_hash);


--
-- Name: product_order_draft product_order_draft_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_order_draft
    ADD CONSTRAINT product_order_draft_pkey PRIMARY KEY (draft_id);


--
-- Name: product_order_draft product_order_draft_triggered_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_order_draft
    ADD CONSTRAINT product_order_draft_triggered_order_id_key UNIQUE (triggered_order_id);


--
-- Name: product_order_trigger product_order_trigger_draft_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_order_trigger
    ADD CONSTRAINT product_order_trigger_draft_id_key UNIQUE (draft_id);


--
-- Name: product_order_trigger product_order_trigger_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_order_trigger
    ADD CONSTRAINT product_order_trigger_order_id_key UNIQUE (order_id);


--
-- Name: product_order_trigger product_order_trigger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_order_trigger
    ADD CONSTRAINT product_order_trigger_pkey PRIMARY KEY (trigger_id);


--
-- Name: product_order_trigger product_order_trigger_tx_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_order_trigger
    ADD CONSTRAINT product_order_trigger_tx_hash_key UNIQUE (tx_hash);


--
-- Name: product_participant product_participant_draft_id_role_slot_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_participant
    ADD CONSTRAINT product_participant_draft_id_role_slot_id_key UNIQUE (draft_id, role_slot_id);


--
-- Name: product_participant product_participant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_participant
    ADD CONSTRAINT product_participant_pkey PRIMARY KEY (participant_id);


--
-- Name: stage_patch_nonce stage_patch_nonce_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_patch_nonce
    ADD CONSTRAINT stage_patch_nonce_pkey PRIMARY KEY (nonce_key);


--
-- Name: stage_patch_prepared stage_patch_prepared_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_patch_prepared
    ADD CONSTRAINT stage_patch_prepared_pkey PRIMARY KEY (prepare_id);


--
-- Name: stage_patch_submission stage_patch_submission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_patch_submission
    ADD CONSTRAINT stage_patch_submission_pkey PRIMARY KEY (submission_id);


--
-- Name: store_account_address store_account_address_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_account_address
    ADD CONSTRAINT store_account_address_pkey PRIMARY KEY (address);


--
-- Name: store_auth_challenge store_auth_challenge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_auth_challenge
    ADD CONSTRAINT store_auth_challenge_pkey PRIMARY KEY (nonce);


--
-- Name: store_docking_session store_docking_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_docking_session
    ADD CONSTRAINT store_docking_session_pkey PRIMARY KEY (session_id);


--
-- Name: store_entity_registration store_entity_registration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_entity_registration
    ADD CONSTRAINT store_entity_registration_pkey PRIMARY KEY (registration_id);


--
-- Name: store_identity_descriptor_snapshot store_identity_descriptor_snapsh_subject_id_descriptor_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_identity_descriptor_snapshot
    ADD CONSTRAINT store_identity_descriptor_snapsh_subject_id_descriptor_hash_key UNIQUE (subject_id, descriptor_hash);


--
-- Name: store_identity_descriptor_snapshot store_identity_descriptor_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_identity_descriptor_snapshot
    ADD CONSTRAINT store_identity_descriptor_snapshot_pkey PRIMARY KEY (snapshot_id);


--
-- Name: store_join_application_event store_join_application_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_join_application_event
    ADD CONSTRAINT store_join_application_event_pkey PRIMARY KEY (event_id);


--
-- Name: store_join_application store_join_application_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_join_application
    ADD CONSTRAINT store_join_application_pkey PRIMARY KEY (application_id);


--
-- Name: store_operator_audit store_operator_audit_audit_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_operator_audit
    ADD CONSTRAINT store_operator_audit_audit_id_key UNIQUE (audit_id);


--
-- Name: store_operator_audit store_operator_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_operator_audit
    ADD CONSTRAINT store_operator_audit_pkey PRIMARY KEY (row_id);


--
-- Name: store_publisher_delegation store_publisher_delegation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_publisher_delegation
    ADD CONSTRAINT store_publisher_delegation_pkey PRIMARY KEY (delegation_id);


--
-- Name: store_supplier_audit store_supplier_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_supplier_audit
    ADD CONSTRAINT store_supplier_audit_pkey PRIMARY KEY (row_id);


--
-- Name: store_supplier_metadata store_supplier_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_supplier_metadata
    ADD CONSTRAINT store_supplier_metadata_pkey PRIMARY KEY (supplier_id);


--
-- Name: store_supplier_metadata store_supplier_metadata_supplier_subject_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_supplier_metadata
    ADD CONSTRAINT store_supplier_metadata_supplier_subject_id_key UNIQUE (supplier_subject_id);


--
-- Name: store_wallet_session store_wallet_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_wallet_session
    ADD CONSTRAINT store_wallet_session_pkey PRIMARY KEY (session_id);


--
-- Name: store_wallet_session store_wallet_session_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_wallet_session
    ADD CONSTRAINT store_wallet_session_token_hash_key UNIQUE (token_hash);


--
-- Name: store_zhixu_decoration store_zhixu_decoration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_zhixu_decoration
    ADD CONSTRAINT store_zhixu_decoration_pkey PRIMARY KEY (decoration_id);


--
-- Name: store_zhixu_decoration store_zhixu_decoration_plan_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_zhixu_decoration
    ADD CONSTRAINT store_zhixu_decoration_plan_id_version_key UNIQUE (plan_id, version);


--
-- Name: store_zhixu_draft store_zhixu_draft_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_zhixu_draft
    ADD CONSTRAINT store_zhixu_draft_pkey PRIMARY KEY (draft_id);


--
-- Name: store_zhixu_listing store_zhixu_listing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_zhixu_listing
    ADD CONSTRAINT store_zhixu_listing_pkey PRIMARY KEY (listing_id);


--
-- Name: store_zhixu_listing store_zhixu_listing_plan_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_zhixu_listing
    ADD CONSTRAINT store_zhixu_listing_plan_id_key UNIQUE (plan_id);


--
-- Name: store_zhixu_version_metadata store_zhixu_version_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_zhixu_version_metadata
    ADD CONSTRAINT store_zhixu_version_metadata_pkey PRIMARY KEY (series_id, version_id);


--
-- Name: submission_attempt submission_attempt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_attempt
    ADD CONSTRAINT submission_attempt_pkey PRIMARY KEY (attempt_id);


--
-- Name: submission_attempt submission_attempt_tx_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_attempt
    ADD CONSTRAINT submission_attempt_tx_hash_key UNIQUE (tx_hash);


--
-- Name: submission_nonce submission_nonce_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_nonce
    ADD CONSTRAINT submission_nonce_pkey PRIMARY KEY (nonce_key);


--
-- Name: submission submission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission
    ADD CONSTRAINT submission_pkey PRIMARY KEY (submission_id);


--
-- Name: submission_prepare submission_prepare_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_prepare
    ADD CONSTRAINT submission_prepare_pkey PRIMARY KEY (prepare_id);


--
-- Name: chain_event_log_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chain_event_log_order_idx ON public.chain_event_log USING btree (chain_id, block_number, transaction_index, log_index);


--
-- Name: evidence_admin_read_evidence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX evidence_admin_read_evidence_idx ON public.evidence_admin_read_audit USING btree (evidence_id, accessed_at);


--
-- Name: evidence_object_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX evidence_object_order_idx ON public.evidence_object USING btree (order_id, task_id, stage_identifier);


--
-- Name: governance_review_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX governance_review_subject_idx ON public.governance_review USING btree (subject_type, subject_id, updated_at);


--
-- Name: governance_tx_log_subject_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX governance_tx_log_subject_created_idx ON public.governance_tx_log USING btree (subject_id, created_at);


--
-- Name: idx_stage_patch_prepared_deadline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stage_patch_prepared_deadline ON public.stage_patch_prepared USING btree (deadline_seconds);


--
-- Name: indexer_pending_post_commit_chain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexer_pending_post_commit_chain_idx ON public.indexer_pending_post_commit USING btree (chain_id, kind, updated_at);


--
-- Name: notification_delivery_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_delivery_order_idx ON public.notification_delivery USING btree (order_id, created_at);


--
-- Name: notification_delivery_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_delivery_status_idx ON public.notification_delivery USING btree (status, updated_at);


--
-- Name: order_config_v3_config_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_config_v3_config_idx ON public.order_config_v3 USING btree (config_id, status);


--
-- Name: order_draft_v3_buyer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_draft_v3_buyer_idx ON public.order_draft_v3 USING btree (buyer_wallet, created_at);


--
-- Name: order_invite_v3_single_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX order_invite_v3_single_active ON public.order_invite_v3 USING btree (draft_id, stage_key, slot_key) WHERE (status = 'active'::text);


--
-- Name: order_requirement_consent_draft_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_requirement_consent_draft_idx ON public.order_requirement_consent USING btree (draft_id, created_at);


--
-- Name: order_stage_slot_v3_wallet_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_stage_slot_v3_wallet_idx ON public.order_stage_slot_v3 USING btree (draft_id, wallet);


--
-- Name: product_invite_draft_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_invite_draft_idx ON public.product_invite USING btree (draft_id, created_at);


--
-- Name: product_invite_single_active_uk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_invite_single_active_uk ON public.product_invite USING btree (participant_id) WHERE (status = 'active'::text);


--
-- Name: product_participant_accepted_wallet_per_draft_uk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_participant_accepted_wallet_per_draft_uk ON public.product_participant USING btree (draft_id, lower(wallet_address)) WHERE ((status = 'accepted'::text) AND (wallet_address IS NOT NULL));


--
-- Name: product_participant_draft_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_participant_draft_idx ON public.product_participant USING btree (draft_id);


--
-- Name: store_account_address_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_account_address_account_idx ON public.store_account_address USING btree (account_id, status);


--
-- Name: store_auth_challenge_address_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_auth_challenge_address_idx ON public.store_auth_challenge USING btree (address, issued_at);


--
-- Name: store_auth_challenge_requester_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_auth_challenge_requester_idx ON public.store_auth_challenge USING btree (requester_key, issued_at);


--
-- Name: store_docking_session_zhixu_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_docking_session_zhixu_idx ON public.store_docking_session USING btree (source_zhixu_id, target_zhixu_id, updated_at);


--
-- Name: store_entity_registration_account_uk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX store_entity_registration_account_uk ON public.store_entity_registration USING btree (account_address);


--
-- Name: store_join_application_applicant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_join_application_applicant_idx ON public.store_join_application USING btree (applicant_address, submitted_at);


--
-- Name: store_join_application_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_join_application_event_idx ON public.store_join_application_event USING btree (application_id, created_at);


--
-- Name: store_join_application_open_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX store_join_application_open_unique ON public.store_join_application USING btree (plan_id, applicant_address) WHERE (status = ANY (ARRAY['applied'::text, 'under_review'::text]));


--
-- Name: store_join_application_plan_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_join_application_plan_idx ON public.store_join_application USING btree (plan_id, submitted_at);


--
-- Name: store_operator_audit_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_operator_audit_action_idx ON public.store_operator_audit USING btree (action, outcome, created_at);


--
-- Name: store_operator_audit_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_operator_audit_actor_idx ON public.store_operator_audit USING btree (actor, created_at);


--
-- Name: store_operator_audit_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_operator_audit_resource_idx ON public.store_operator_audit USING btree (resource_type, resource_id, created_at);


--
-- Name: store_publisher_delegation_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_publisher_delegation_member_idx ON public.store_publisher_delegation USING btree (member_address, granted_at);


--
-- Name: store_publisher_delegation_publisher_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_publisher_delegation_publisher_idx ON public.store_publisher_delegation USING btree (publisher_address, granted_at);


--
-- Name: store_supplier_audit_audit_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX store_supplier_audit_audit_id_uidx ON public.store_supplier_audit USING btree (audit_id);


--
-- Name: store_supplier_audit_supplier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_supplier_audit_supplier_idx ON public.store_supplier_audit USING btree (supplier_id, created_at);


--
-- Name: store_supplier_metadata_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_supplier_metadata_updated_idx ON public.store_supplier_metadata USING btree (updated_at, supplier_id);


--
-- Name: store_wallet_session_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_wallet_session_account_idx ON public.store_wallet_session USING btree (account_id, expires_at);


--
-- Name: store_zhixu_decoration_plan_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_zhixu_decoration_plan_idx ON public.store_zhixu_decoration USING btree (plan_id, version);


--
-- Name: store_zhixu_draft_product_schema_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_zhixu_draft_product_schema_idx ON public.store_zhixu_draft USING btree (updated_at, draft_id) WHERE (product_schema_json IS NOT NULL);


--
-- Name: store_zhixu_draft_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_zhixu_draft_status_idx ON public.store_zhixu_draft USING btree (status, updated_at);


--
-- Name: store_zhixu_listing_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_zhixu_listing_status_idx ON public.store_zhixu_listing USING btree (status, updated_at);


--
-- Name: store_zhixu_version_metadata_single_active_uk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX store_zhixu_version_metadata_single_active_uk ON public.store_zhixu_version_metadata USING btree (series_id) WHERE (status = 'active'::text);


--
-- Name: store_zhixu_version_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_zhixu_version_status_idx ON public.store_zhixu_version_metadata USING btree (series_id, status, created_at);


--
-- Name: submission_attempt_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_attempt_order_idx ON public.submission_attempt USING btree (order_id, source_id, signal_id, submitter, attempt_number);


--
-- Name: submission_attempt_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_attempt_retry_idx ON public.submission_attempt USING btree (retry_state, dead_letter, updated_at);


--
-- Name: submission_attempt_submission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_attempt_submission_idx ON public.submission_attempt USING btree (submission_id, attempt_number);


--
-- Name: submission_business_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX submission_business_key_idx ON public.submission_prepare USING btree (plan_id, order_id, task_id, submitter, signal_name, nonce);


--
-- Name: submission_prepare_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_prepare_id_idx ON public.submission USING btree (prepare_id);


--
-- Name: submission_prepare_plan_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_prepare_plan_order_idx ON public.submission_prepare USING btree (plan_id, onchain_order_id);


--
-- Name: evidence_access_policy evidence_access_policy_evidence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evidence_access_policy
    ADD CONSTRAINT evidence_access_policy_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES public.evidence_object(evidence_id) ON DELETE CASCADE;


--
-- Name: order_invite_v3 order_invite_v3_draft_id_stage_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_invite_v3
    ADD CONSTRAINT order_invite_v3_draft_id_stage_key_fkey FOREIGN KEY (draft_id, stage_key) REFERENCES public.order_stage_v3(draft_id, stage_key) ON DELETE CASCADE;


--
-- Name: order_requirement_bundle order_requirement_bundle_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_requirement_bundle
    ADD CONSTRAINT order_requirement_bundle_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.product_order_draft(draft_id) ON DELETE CASCADE;


--
-- Name: order_requirement_consent order_requirement_consent_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_requirement_consent
    ADD CONSTRAINT order_requirement_consent_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.order_requirement_bundle(draft_id) ON DELETE CASCADE;


--
-- Name: order_stage_slot_v3 order_stage_slot_v3_draft_id_stage_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_stage_slot_v3
    ADD CONSTRAINT order_stage_slot_v3_draft_id_stage_key_fkey FOREIGN KEY (draft_id, stage_key) REFERENCES public.order_stage_v3(draft_id, stage_key) ON DELETE CASCADE;


--
-- Name: order_stage_v3 order_stage_v3_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_stage_v3
    ADD CONSTRAINT order_stage_v3_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.order_draft_v3(draft_id) ON DELETE CASCADE;


--
-- Name: order_v3 order_v3_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_v3
    ADD CONSTRAINT order_v3_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.order_draft_v3(draft_id);


--
-- Name: product_invite product_invite_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_invite
    ADD CONSTRAINT product_invite_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.product_order_draft(draft_id) ON DELETE CASCADE;


--
-- Name: product_invite product_invite_participant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_invite
    ADD CONSTRAINT product_invite_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES public.product_participant(participant_id) ON DELETE CASCADE;


--
-- Name: product_order_trigger product_order_trigger_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_order_trigger
    ADD CONSTRAINT product_order_trigger_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.product_order_draft(draft_id) ON DELETE CASCADE;


--
-- Name: product_participant product_participant_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_participant
    ADD CONSTRAINT product_participant_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.product_order_draft(draft_id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


