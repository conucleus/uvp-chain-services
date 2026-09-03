import { canonicalStringify } from "@uvp-eth/compiler";
import type { PostgresDatabase } from "./storage/postgres-client.js";
import type { StoreIdentityDescriptorSnapshotRecord, StoreIdentityDescriptorSnapshotStore } from "./governance/descriptors.js";
import type { Address, Hex } from "./shared/types.js";
import type {
  StorePublisherDelegationRecord,
  StorePublisherDelegationStore,
  StoreZhixuDecorationData,
  StoreZhixuDecorationStore,
  StoreZhixuDecorationVersionRecord
} from "./store-decoration/types.js";
import type {
  StoreJoinApplicationEventRecord,
  StoreJoinApplicationRecord,
  StoreJoinApplicationStore,
  StoreJoinApplicationStatus,
  StoreJoinTxEvidence
} from "./store-join/types.js";
import type {
  StoreListingRecord,
  StoreListingStore,
  StoreListingStatus
} from "./store-listings/types.js";

/**
 * PRD89-92 新增 Store 域的 postgres 持久化。
 * 集中一个模块以共享 row 装配助手；schema 见 migrations/postgres/0014、0015。
 */

type Row = Record<string, unknown>;

export class PostgresStoreIdentityDescriptorSnapshotStore implements StoreIdentityDescriptorSnapshotStore {
  readonly #database: PostgresDatabase;

  constructor(options: { readonly database: PostgresDatabase }) {
    this.#database = options.database;
  }

  async appendSnapshot(record: StoreIdentityDescriptorSnapshotRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_identity_descriptor_snapshot
         (snapshot_id, subject_id, descriptor_hash, descriptor_json, source, created_by, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (subject_id, descriptor_hash) DO NOTHING`,
      [
        record.snapshotId,
        record.subjectId.toLowerCase(),
        record.descriptorHash.toLowerCase(),
        canonicalStringify(record.descriptorDocument),
        record.source,
        record.createdBy,
        record.createdAt
      ]
    );
  }

  async findSnapshot(subjectId: Hex, descriptorHash: Hex): Promise<StoreIdentityDescriptorSnapshotRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM store_identity_descriptor_snapshot WHERE subject_id = $1 AND descriptor_hash = $2`,
      [subjectId.toLowerCase(), descriptorHash.toLowerCase()]
    );
    return result.rows[0] ? descriptorRow(result.rows[0]) : undefined;
  }

  async listSnapshots(subjectId: Hex): Promise<readonly StoreIdentityDescriptorSnapshotRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM store_identity_descriptor_snapshot WHERE subject_id = $1 ORDER BY created_at ASC, snapshot_id ASC`,
      [subjectId.toLowerCase()]
    );
    return result.rows.map((row) => descriptorRow(row));
  }
}

function descriptorRow(row: Row): StoreIdentityDescriptorSnapshotRecord {
  return {
    snapshotId: String(row.snapshot_id),
    subjectId: String(row.subject_id) as Hex,
    descriptorHash: String(row.descriptor_hash) as Hex,
    descriptorDocument: typeof row.descriptor_json === "string" ? JSON.parse(row.descriptor_json) : row.descriptor_json,
    source: String(row.source),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at)
  };
}

export class PostgresStoreZhixuDecorationStore implements StoreZhixuDecorationStore {
  readonly #database: PostgresDatabase;

  constructor(options: { readonly database: PostgresDatabase }) {
    this.#database = options.database;
  }

  async appendVersion(record: StoreZhixuDecorationVersionRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_zhixu_decoration
         (decoration_id, plan_id, version, data_json, author_address, author_account_id, note, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        record.decorationId,
        record.planId.toLowerCase(),
        record.version,
        JSON.stringify(record.data),
        record.authorAddress.toLowerCase(),
        record.authorAccountId ?? null,
        record.note ?? null,
        record.createdAt
      ]
    );
  }

  async listVersions(planId: Hex): Promise<readonly StoreZhixuDecorationVersionRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM store_zhixu_decoration WHERE plan_id = $1 ORDER BY version ASC`,
      [planId.toLowerCase()]
    );
    return result.rows.map((row) => decorationRow(row));
  }
}

function decorationRow(row: Row): StoreZhixuDecorationVersionRecord {
  return {
    decorationId: String(row.decoration_id),
    planId: String(row.plan_id) as Hex,
    version: Number(row.version),
    data: (typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json) as StoreZhixuDecorationData,
    authorAddress: String(row.author_address) as Address,
    ...(row.author_account_id ? { authorAccountId: String(row.author_account_id) } : {}),
    ...(row.note ? { note: String(row.note) } : {}),
    createdAt: String(row.created_at)
  };
}

export class PostgresStorePublisherDelegationStore implements StorePublisherDelegationStore {
  readonly #database: PostgresDatabase;

  constructor(options: { readonly database: PostgresDatabase }) {
    this.#database = options.database;
  }

  async appendDelegation(record: StorePublisherDelegationRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_publisher_delegation
         (delegation_id, publisher_address, member_address, granted_by_address, granted_by_account_id, granted_at, revoked_at, revoked_by_address, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (delegation_id) DO UPDATE SET
         revoked_at = EXCLUDED.revoked_at,
         revoked_by_address = EXCLUDED.revoked_by_address,
         reason = EXCLUDED.reason`,
      delegationValues(record)
    );
  }

  async updateDelegation(record: StorePublisherDelegationRecord): Promise<void> {
    await this.appendDelegation(record);
  }

  async findActiveDelegation(publisherAddress: Address, memberAddress: Address): Promise<StorePublisherDelegationRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM store_publisher_delegation
       WHERE publisher_address = $1 AND member_address = $2 AND revoked_at IS NULL
       ORDER BY granted_at DESC LIMIT 1`,
      [publisherAddress.toLowerCase(), memberAddress.toLowerCase()]
    );
    return result.rows[0] ? delegationRow(result.rows[0]) : undefined;
  }

  async listDelegations(publisherAddress: Address): Promise<readonly StorePublisherDelegationRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM store_publisher_delegation WHERE publisher_address = $1 ORDER BY granted_at ASC, delegation_id ASC`,
      [publisherAddress.toLowerCase()]
    );
    return result.rows.map((row) => delegationRow(row));
  }

  async listDelegationsForMember(memberAddress: Address): Promise<readonly StorePublisherDelegationRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM store_publisher_delegation WHERE member_address = $1 ORDER BY granted_at ASC, delegation_id ASC`,
      [memberAddress.toLowerCase()]
    );
    return result.rows.map((row) => delegationRow(row));
  }
}

function delegationValues(record: StorePublisherDelegationRecord): readonly unknown[] {
  return [
    record.delegationId,
    record.publisherAddress.toLowerCase(),
    record.memberAddress.toLowerCase(),
    record.grantedByAddress.toLowerCase(),
    record.grantedByAccountId ?? null,
    record.grantedAt,
    record.revokedAt ?? null,
    record.revokedByAddress ? record.revokedByAddress.toLowerCase() : null,
    record.reason ?? null
  ];
}

function delegationRow(row: Row): StorePublisherDelegationRecord {
  return {
    delegationId: String(row.delegation_id),
    publisherAddress: String(row.publisher_address) as Address,
    memberAddress: String(row.member_address) as Address,
    grantedByAddress: String(row.granted_by_address) as Address,
    ...(row.granted_by_account_id ? { grantedByAccountId: String(row.granted_by_account_id) } : {}),
    grantedAt: String(row.granted_at),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
    ...(row.revoked_by_address ? { revokedByAddress: String(row.revoked_by_address) as Address } : {}),
    ...(row.reason ? { reason: String(row.reason) } : {})
  };
}

export class PostgresStoreListingStore implements StoreListingStore {
  readonly #database: PostgresDatabase;

  constructor(options: { readonly database: PostgresDatabase }) {
    this.#database = options.database;
  }

  async putListing(record: StoreListingRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_zhixu_listing
         (listing_id, plan_id, plan_hash_claimed, deployment_id_claimed, state_machine_address_claimed,
          status, imported_by_address, imported_by_account_id, imported_at,
          reviewed_by_address, reviewed_at, review_note, delist_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (listing_id) DO UPDATE SET
         status = EXCLUDED.status,
         reviewed_by_address = EXCLUDED.reviewed_by_address,
         reviewed_at = EXCLUDED.reviewed_at,
         review_note = EXCLUDED.review_note,
         delist_reason = EXCLUDED.delist_reason,
         updated_at = EXCLUDED.updated_at`,
      listingValues(record)
    );
  }

  async getListing(listingId: string): Promise<StoreListingRecord | undefined> {
    const result = await this.#database.query(`SELECT * FROM store_zhixu_listing WHERE listing_id = $1`, [listingId]);
    return result.rows[0] ? listingRow(result.rows[0]) : undefined;
  }

  async findListingByPlanId(planId: Hex): Promise<StoreListingRecord | undefined> {
    const result = await this.#database.query(
      `SELECT * FROM store_zhixu_listing WHERE plan_id = $1 ORDER BY imported_at ASC`,
      [planId.toLowerCase()]
    );
    return result.rows[0] ? listingRow(result.rows[0]) : undefined;
  }

  async listListings(status?: StoreListingStatus): Promise<readonly StoreListingRecord[]> {
    const result = status
      ? await this.#database.query(`SELECT * FROM store_zhixu_listing WHERE status = $1 ORDER BY updated_at DESC, listing_id ASC`, [status])
      : await this.#database.query(`SELECT * FROM store_zhixu_listing ORDER BY updated_at DESC, listing_id ASC`);
    return result.rows.map((row) => listingRow(row));
  }
}

function listingValues(record: StoreListingRecord): readonly unknown[] {
  return [
    record.listingId,
    record.planId.toLowerCase(),
    record.planHashClaimed?.toLowerCase() ?? null,
    record.deploymentIdClaimed?.toLowerCase() ?? null,
    record.stateMachineAddressClaimed?.toLowerCase() ?? null,
    record.status,
    record.importedByAddress?.toLowerCase() ?? null,
    record.importedByAccountId ?? null,
    record.importedAt,
    record.reviewedByAddress?.toLowerCase() ?? null,
    record.reviewedAt ?? null,
    record.reviewNote ?? null,
    record.delistReason ?? null,
    record.updatedAt
  ];
}

function listingRow(row: Row): StoreListingRecord {
  const status = String(row.status);
  if (status !== "imported" && status !== "public" && status !== "rejected" && status !== "delisted") {
    throw new Error(`store_zhixu_listing.status holds unsupported value ${status}`);
  }
  return {
    listingId: String(row.listing_id),
    planId: String(row.plan_id) as Hex,
    ...(row.plan_hash_claimed ? { planHashClaimed: String(row.plan_hash_claimed) as Hex } : {}),
    ...(row.deployment_id_claimed ? { deploymentIdClaimed: String(row.deployment_id_claimed) as Hex } : {}),
    ...(row.state_machine_address_claimed ? { stateMachineAddressClaimed: String(row.state_machine_address_claimed) as Address } : {}),
    status,
    ...(row.imported_by_address ? { importedByAddress: String(row.imported_by_address) as Address } : {}),
    ...(row.imported_by_account_id ? { importedByAccountId: String(row.imported_by_account_id) } : {}),
    importedAt: String(row.imported_at),
    ...(row.reviewed_by_address ? { reviewedByAddress: String(row.reviewed_by_address) as Address } : {}),
    ...(row.reviewed_at ? { reviewedAt: String(row.reviewed_at) } : {}),
    ...(row.review_note ? { reviewNote: String(row.review_note) } : {}),
    ...(row.delist_reason ? { delistReason: String(row.delist_reason) } : {}),
    updatedAt: String(row.updated_at)
  };
}

export class PostgresStoreJoinApplicationStore implements StoreJoinApplicationStore {
  readonly #database: PostgresDatabase;

  constructor(options: { readonly database: PostgresDatabase }) {
    this.#database = options.database;
  }

  async putApplication(record: StoreJoinApplicationRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_join_application
         (application_id, plan_id, zhixu_id, role_slot_id, authorization_kind, stage_id,
          applicant_address, applicant_account_id, applicant_subject_id, applicant_display_name,
          statement, status, supplier_id, tx_evidence_json, rejection_reason, revocation_reason,
          decided_by_address, decided_at, submitted_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (application_id) DO UPDATE SET
         status = EXCLUDED.status,
         supplier_id = EXCLUDED.supplier_id,
         tx_evidence_json = EXCLUDED.tx_evidence_json,
         rejection_reason = EXCLUDED.rejection_reason,
         revocation_reason = EXCLUDED.revocation_reason,
         decided_by_address = EXCLUDED.decided_by_address,
         decided_at = EXCLUDED.decided_at,
         updated_at = EXCLUDED.updated_at`,
      applicationValues(record)
    );
  }

  async getApplication(applicationId: string): Promise<StoreJoinApplicationRecord | undefined> {
    const result = await this.#database.query(`SELECT * FROM store_join_application WHERE application_id = $1`, [applicationId]);
    return result.rows[0] ? applicationRow(result.rows[0]) : undefined;
  }

  async listApplications(query?: {
    readonly planId?: Hex;
    readonly applicantAddress?: Address;
    readonly status?: StoreJoinApplicationStatus;
  }): Promise<readonly StoreJoinApplicationRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query?.planId) {
      values.push(query.planId.toLowerCase());
      clauses.push(`plan_id = $${values.length}`);
    }
    if (query?.applicantAddress) {
      values.push(query.applicantAddress.toLowerCase());
      clauses.push(`applicant_address = $${values.length}`);
    }
    if (query?.status) {
      values.push(query.status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.#database.query(
      `SELECT * FROM store_join_application ${where} ORDER BY submitted_at DESC, application_id ASC`,
      values
    );
    return result.rows.map((row) => applicationRow(row));
  }

  async appendEvent(record: StoreJoinApplicationEventRecord): Promise<void> {
    await this.#database.query(
      `INSERT INTO store_join_application_event
         (event_id, application_id, type, actor_address, actor_account_id, actor_auth_mode, reason, tx_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.eventId,
        record.applicationId,
        record.type,
        record.actorAddress?.toLowerCase() ?? null,
        record.actorAccountId ?? null,
        record.actorAuthMode ?? null,
        record.reason ?? null,
        record.txHash?.toLowerCase() ?? null,
        record.createdAt
      ]
    );
  }

  async listEvents(applicationId: string): Promise<readonly StoreJoinApplicationEventRecord[]> {
    const result = await this.#database.query(
      `SELECT * FROM store_join_application_event WHERE application_id = $1 ORDER BY created_at ASC, event_id ASC`,
      [applicationId]
    );
    return result.rows.map((row) => eventRow(row));
  }
}

function applicationValues(record: StoreJoinApplicationRecord): readonly unknown[] {
  return [
    record.applicationId,
    record.planId.toLowerCase(),
    record.zhixuId ?? null,
    record.roleSlotId,
    record.authorizationKind,
    record.stageId ?? null,
    record.applicantAddress.toLowerCase(),
    record.applicantAccountId ?? null,
    record.applicantSubjectId.toLowerCase(),
    record.applicantDisplayName ?? null,
    record.statement ?? null,
    record.status,
    record.supplierId ?? null,
    JSON.stringify(record.txEvidence),
    record.rejectionReason ?? null,
    record.revocationReason ?? null,
    record.decidedByAddress?.toLowerCase() ?? null,
    record.decidedAt ?? null,
    record.submittedAt,
    record.updatedAt
  ];
}

function applicationRow(row: Row): StoreJoinApplicationRecord {
  const status = String(row.status);
  if (!isJoinStatus(status)) {
    throw new Error(`store_join_application.status holds unsupported value ${status}`);
  }
  const authorizationKind = String(row.authorization_kind);
  if (authorizationKind !== "signal_submitter" && authorizationKind !== "stage_executor") {
    throw new Error(`store_join_application.authorization_kind holds unsupported value ${authorizationKind}`);
  }
  return {
    applicationId: String(row.application_id),
    planId: String(row.plan_id) as Hex,
    ...(row.zhixu_id ? { zhixuId: String(row.zhixu_id) } : {}),
    roleSlotId: String(row.role_slot_id),
    authorizationKind,
    ...(row.stage_id ? { stageId: String(row.stage_id) } : {}),
    applicantAddress: String(row.applicant_address) as Address,
    ...(row.applicant_account_id ? { applicantAccountId: String(row.applicant_account_id) } : {}),
    applicantSubjectId: String(row.applicant_subject_id) as Hex,
    ...(row.applicant_display_name ? { applicantDisplayName: String(row.applicant_display_name) } : {}),
    ...(row.statement ? { statement: String(row.statement) } : {}),
    status,
    ...(row.supplier_id ? { supplierId: String(row.supplier_id) } : {}),
    txEvidence: (typeof row.tx_evidence_json === "string" ? JSON.parse(row.tx_evidence_json) : row.tx_evidence_json) as readonly StoreJoinTxEvidence[],
    ...(row.rejection_reason ? { rejectionReason: String(row.rejection_reason) } : {}),
    ...(row.revocation_reason ? { revocationReason: String(row.revocation_reason) } : {}),
    ...(row.decided_by_address ? { decidedByAddress: String(row.decided_by_address) as Address } : {}),
    ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    submittedAt: String(row.submitted_at),
    updatedAt: String(row.updated_at)
  };
}

function eventRow(row: Row): StoreJoinApplicationEventRecord {
  return {
    eventId: String(row.event_id),
    applicationId: String(row.application_id),
    type: String(row.type) as StoreJoinApplicationEventRecord["type"],
    ...(row.actor_address ? { actorAddress: String(row.actor_address) as Address } : {}),
    ...(row.actor_account_id ? { actorAccountId: String(row.actor_account_id) } : {}),
    ...(row.actor_auth_mode ? { actorAuthMode: String(row.actor_auth_mode) } : {}),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    ...(row.tx_hash ? { txHash: String(row.tx_hash) as Hex } : {}),
    createdAt: String(row.created_at)
  };
}

function isJoinStatus(value: string): value is StoreJoinApplicationStatus {
  return value === "applied" || value === "under_review" || value === "authorized" || value === "active" || value === "rejected" || value === "revoked";
}
