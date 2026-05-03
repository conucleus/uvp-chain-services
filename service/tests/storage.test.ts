import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { StoreProductSchemaDTO, StoreSupplierDTO } from "@uvp-eth/product-dto";
import { CROSS_BORDER_ZHIXU_ID, crossBorderPlanIds } from "@uvp-eth/product-dto/fixtures";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import type { ProjectionSnapshot } from "../src/indexer/projections.js";
import { SqliteEvidenceStore } from "../src/evidence/sqlite-store.js";
import type { EvidenceMetadataRecord } from "../src/evidence/store.js";
import { SqliteGovernanceStore } from "../src/governance/sqlite-store.js";
import type { GovernanceReviewDTO, PlanAttestationLogDTO } from "../src/governance/types.js";
import { SqliteProductBffStore } from "../src/product/bff/sqlite-store.js";
import type {
  DraftParticipantDTO,
  ProductInviteDTO,
  ProductOrderDraftDTO,
  ProductOrderStartDTO,
  ProductOrderRegistrationRecord
} from "../src/product/bff/types.js";
import type { Address, Hex } from "../src/shared/types.js";
import { StorageConstraintError } from "../src/storage/errors.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { listAppliedSqliteMigrations, runSqliteMigrations } from "../src/storage/migrations.js";
import { PostgresDatabase } from "../src/storage/postgres-client.js";
import { listAppliedPostgresMigrations, runPostgresMigrations } from "../src/storage/postgres-migrations.js";
import { PostgresProjectionStore } from "../src/storage/postgres.js";
import { SqliteProjectionStore } from "../src/storage/sqlite-projection-store.js";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/sqlite.js";
import type { StoreDockingSessionDTO } from "../src/store-console/docking.js";
import type { StoreZhixuDraftDTO, StoreZhixuDraftRecord } from "../src/store-console/zhixu-drafts.js";
import type { StoreZhixuVersionRecord } from "../src/store-console/version.js";
import type { StoreSupplierAuditRecord, StoreSupplierMetadataRecord } from "../src/store-suppliers/index.js";
import { SqliteSubmissionStore } from "../src/submissions/sqlite-store.js";
import type { PreparedSubmissionRecord, ProductSubmissionDTO } from "../src/submissions/types.js";

const chainId = 31337;
const contractAddress = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
const seller = "0x3333333333333333333333333333333333333333";
const adminHeaders = {
  "x-uvp-admin-id": "store-admin",
  "x-uvp-admin-role": "admin"
};
const planId = "0x0000000000000000000000000000000000000000000000000000000000000101";
const planHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const artifactHash = "0x7878787878787878787878787878787878787878787878787878787878787878";
const stateMachineOrderId = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const snapshotScopeContract = "0x0000000000000000000000000000000000000000";
const expectedMigrationVersions = [
  "0001_projection_storage",
  "0002_business_storage",
  "0003_product_order_start",
  "0004_submission_attempt_operations",
  "0005_projection_sync_state",
  "0006_store_metadata",
  "0007_store_product_schema",
  "0008_store_audit"
];
const routeSmokeZhixuYaml = `
apiVersion: uvp/v0
kind: Zhixu
metadata:
  name: route-durable
  uid: route-durable-001
  annotations:
    version: "1"
spec:
  platform:
    type: blockchain
    provider: eth
  nucleation:
    id: route-durable
  taskPatterns:
    - name: order
      stages:
        - name: intake
          source: buyer
          trigger: ["TRIGGER"]
          receiveSignals:
            TRIGGER: "::OUTSIDE"
          sendSignals: ["cmp"]
          executor:
            supplierType: organization
            supplierID: intake-ops
`;

describe("durable storage", () => {
  const tempDirs: string[] = [];
  const stores: Array<{ close(): Promise<void> }> = [];
  const databases: SqliteDatabase[] = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) {
      await store.close();
    }
    for (const database of databases.splice(0)) {
      database.close();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records SQLite migration version, checksum, and applied timestamp", () => {
    const database = openSqliteDatabase(sqliteUrl(tempDirs));
    databases.push(database);

    const dryRun = runSqliteMigrations({
      database,
      migrationsDirectory: migrationsDirectory(),
      dryRun: true
    });
    expect(dryRun.pending.map((migration) => migration.version)).toContain("0001_projection_storage");
    expect(listAppliedSqliteMigrations(database)).toHaveLength(0);

    const result = runSqliteMigrations({
      database,
      migrationsDirectory: migrationsDirectory()
    });

    expect(result.applied.map((migration) => migration.version)).toEqual(expectedMigrationVersions);
    expect(result.applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.applied[0]?.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listAppliedSqliteMigrations(database).map((record) => record.version)).toEqual(expectedMigrationVersions);
    expect(runSqliteMigrations({ database, migrationsDirectory: migrationsDirectory() }).applied).toHaveLength(0);
  });

  it("enforces projection event unique constraints", async () => {
    const store = openStore(tempDirs);
    stores.push(store);
    const event = chainEvent(10n, 0, "OrderCreated", {
      orderId: "order-unique",
      buyer,
      seller
    });

    await store.appendEvent(event);

    await expect(store.appendEvent(event)).rejects.toBeInstanceOf(StorageConstraintError);
    await expect(store.listEvents({ chainId, contractAddress })).resolves.toHaveLength(1);
  });

  it("rolls back writes when a transaction fails", async () => {
    const store = openStore(tempDirs);
    stores.push(store);

    await expect(store.withTransaction(async () => {
      await store.appendEvent(chainEvent(1n, 0, "OrderCreated", {
        orderId: "order-rollback",
        buyer,
        seller
      }));
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");

    await expect(store.listEvents({ chainId })).resolves.toHaveLength(0);
  });

  it("upserts and reloads the chain index cursor", async () => {
    const store = openStore(tempDirs);
    stores.push(store);

    await store.saveCursor({
      chainId,
      contractAddress,
      deploymentBlock: 5n,
      nextBlock: 6n,
      finalizedBlock: 5n
    });
    await store.saveCursor({
      chainId,
      contractAddress,
      deploymentBlock: 5n,
      nextBlock: 12n,
      finalizedBlock: 11n
    });

    await expect(store.getCursor({ chainId, contractAddress })).resolves.toMatchObject({
      chainId,
      contractAddress,
      deploymentBlock: 5n,
      nextBlock: 12n,
      finalizedBlock: 11n
    });
  });

  it("serializes and deserializes projection snapshots and event args", async () => {
    const databaseUrl = sqliteUrl(tempDirs);
    const store = new SqliteProjectionStore({
      databaseUrl,
      chainId,
      migrations: { autoRun: true, directory: migrationsDirectory() }
    });
    stores.push(store);

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(1n, 0, "PlanRegistered", {
          planId,
          planHash,
          hookCount: 1n
        }),
        chainEvent(2n, 0, "OrderRegistered", {
          orderId: stateMachineOrderId,
          planId
        })
      ]
    });
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new SqliteProjectionStore({
      databaseUrl,
      chainId,
      migrations: { autoRun: true, directory: migrationsDirectory() }
    });
    stores.push(reopened);

    const stored = await reopened.getSnapshot<ProjectionSnapshot>(
      { chainId, contractAddress: snapshotScopeContract },
      "order"
    );
    const events = await reopened.listEvents({ chainId });

    expect(stored?.snapshot.lastEvent?.blockNumber).toBe(2n);
    expect((await reopened.getStateMachineOrder(stateMachineOrderId))?.planId).toBe(planId);
    expect(events.find((event) => event.eventName === "PlanRegistered")?.args.hookCount).toBe(1n);
  });

  it("rebuilds SQLite projections after derived snapshot rows are deleted", async () => {
    const databaseUrl = sqliteUrl(tempDirs);
    const store = new SqliteProjectionStore({
      databaseUrl,
      chainId,
      migrations: { autoRun: true, directory: migrationsDirectory() }
    });
    stores.push(store);
    const event = chainEvent(3n, 0, "OrderRegistered", {
      orderId: stateMachineOrderId,
      planId
    });

    await store.resetFromEvents({ deploymentBlock: 0n, events: [event] });
    await expect(store.getStateMachineOrder(stateMachineOrderId)).resolves.toMatchObject({
      orderId: stateMachineOrderId
    });

    const database = openSqliteDatabase(databaseUrl);
    databases.push(database);
    database.prepare("DELETE FROM chain_projection_snapshot").run();

    await expect(store.getStateMachineOrder(stateMachineOrderId)).resolves.toBeUndefined();
    const retainedEvents = await store.listEvents({ chainId, contractAddress });
    expect(retainedEvents).toHaveLength(1);

    await store.resetFromEvents({ deploymentBlock: 0n, events: retainedEvents });
    await expect(store.getStateMachineOrder(stateMachineOrderId)).resolves.toMatchObject({
      orderId: stateMachineOrderId,
      planId
    });
  });

  it("persists projection sync state and marks removed events for rebuild", async () => {
    const store = openStore(tempDirs);
    stores.push(store);
    const event = chainEvent(1n, 0, "OrderCreated", {
      orderId: "order-removed",
      buyer,
      seller
    });

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [event, { ...event, removed: true }],
      syncState: {
        chainId,
        contractAddress: snapshotScopeContract,
        syncStatus: "indexed",
        latestIndexedBlock: 1n,
        finalizedBlock: 3n,
        confirmationDepth: 2,
        lastEventName: "OrderCreated",
        eventCount: 0,
        rebuild: {
          status: "completed",
          fromBlock: 0n,
          toBlock: 3n,
          eventCount: 0,
          mismatchCount: 0
        }
      }
    });

    const events = await store.listEvents({ chainId, contractAddress });
    const syncState = await store.getSyncState({ chainId, contractAddress: snapshotScopeContract });

    expect(await store.getOrder("order-removed")).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventName: "OrderCreated", removed: true });
    expect(syncState).toMatchObject({
      syncStatus: "indexed",
      latestIndexedBlock: 1n,
      finalizedBlock: 3n,
      confirmationDepth: 2,
      eventCount: 0,
      rebuild: expect.objectContaining({ status: "completed" })
    });
  });

  it("persists product drafts, participants, invites, and registrations across SQLite store restarts", async () => {
    const databaseUrl = sqliteUrl(tempDirs);
    const store = openProductStore(databaseUrl);
    stores.push(store);
    const draft = productDraft();
    const participant = productParticipant(draft.draftId);
    const invite = productInvite(draft.draftId, participant.participantId);
    const registration = productRegistration(draft.draftId);
    const start = productOrderStart(registration);

    await store.createDraft(draft, [participant]);
    await store.createInvite(invite);
    await store.createRegistration(registration);
    await store.createOrderStart(start);
    await expect(store.createOrderStart({ ...start, startId: `${start.startId}_duplicate` }))
      .rejects.toBeInstanceOf(StorageConstraintError);
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openProductStore(databaseUrl);
    stores.push(reopened);

    await expect(reopened.getDraft(draft.draftId)).resolves.toMatchObject({ draftId: draft.draftId });
    await expect(reopened.listParticipants(draft.draftId)).resolves.toMatchObject([participant]);
    await expect(reopened.getInvite(invite.inviteId)).resolves.toMatchObject(invite);
    await expect(reopened.getRegistration(registration.registrationId)).resolves.toMatchObject(registration);
    await expect(reopened.listRegistrations()).resolves.toHaveLength(1);
    await expect(reopened.getOrderStartByRegistrationId(registration.registrationId)).resolves.toMatchObject(start);
    await expect(reopened.listOrderStartsForReconcile({ statuses: ["submitted"] })).resolves.toMatchObject([start]);
  });

  it("rolls back SQLite product business writes in a transaction", async () => {
    const store = openProductStore(sqliteUrl(tempDirs));
    stores.push(store);
    const draft = productDraft("draft_rollback");

    await expect(store.withTransaction(async () => {
      await store.createDraft(draft, [productParticipant(draft.draftId)]);
      throw new Error("force product rollback");
    })).rejects.toThrow("force product rollback");

    await expect(store.getDraft(draft.draftId)).resolves.toBeUndefined();
  });

  it("persists evidence metadata, access policy, and admin read audit", async () => {
    const databaseUrl = sqliteUrl(tempDirs);
    const store = openEvidenceStore(databaseUrl);
    stores.push(store);
    const record = evidenceRecord();

    await store.put(record);
    await store.recordAdminRead({
      evidenceId: record.evidence.evidenceId,
      principalId: "admin-1",
      accessedAt: "2026-04-28T00:00:01.000Z",
      route: "proof"
    });
    await expect(store.put({ ...record, evidence: { ...record.evidence, evidenceId: "ev_duplicate" } }))
      .rejects.toBeInstanceOf(StorageConstraintError);
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openEvidenceStore(databaseUrl);
    stores.push(reopened);

    await expect(reopened.get(record.evidence.evidenceId)).resolves.toMatchObject({
      evidence: { evidenceId: record.evidence.evidenceId },
      accessPolicy: { readers: ["seller", "buyer"] }
    });
    await expect(reopened.listAdminReads()).resolves.toHaveLength(1);
  });

  it("persists prepared submissions, nonce reservations, submissions, and attempts", async () => {
    const databaseUrl = sqliteUrl(tempDirs);
    const store = openSubmissionStore(databaseUrl);
    stores.push(store);
    const prepared = preparedSubmission();
    const submission = productSubmission(prepared);

    await store.putPrepared(prepared);
    await expect(store.reserveNonce("nonce-key")).resolves.toBe(true);
    await expect(store.reserveNonce("nonce-key")).resolves.toBe(false);
    await store.putSubmission(submission);
    await store.markPreparedUsed(prepared.prepareId, submission.submissionId, submission.updatedAt);
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openSubmissionStore(databaseUrl);
    stores.push(reopened);

    await expect(reopened.getPrepared(prepared.prepareId)).resolves.toMatchObject({
      prepareId: prepared.prepareId,
      submissionId: submission.submissionId,
      usedAt: submission.updatedAt
    });
    await expect(reopened.getSubmission(submission.submissionId)).resolves.toMatchObject({
      submissionId: submission.submissionId,
      attemptCount: 1,
      attempts: [{ txHash: submission.attempts[0]?.txHash }]
    });
    await expect(reopened.listSubmissions()).resolves.toHaveLength(1);
  });

  it("persists governance reviews and tx logs across SQLite store restarts", async () => {
    const databaseUrl = sqliteUrl(tempDirs);
    const store = openGovernanceStore(databaseUrl);
    stores.push(store);
    const review = governanceReview();
    const log = planAttestationLog();

    await store.putReview(review);
    await store.appendPlanAttestationLog(log);
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openGovernanceStore(databaseUrl);
    stores.push(reopened);

    await expect(reopened.findLatestReview(review.subjectType, review.subjectId)).resolves.toMatchObject(review);
    await expect(reopened.getTxLog(log.txLogId)).resolves.toMatchObject(log);

    const updated = { ...log, status: "confirmed" as const, broadcastStatus: "confirmed" as const };
    await reopened.updateTxLog(updated);
    await expect(reopened.listPlanAttestationLogs()).resolves.toMatchObject([updated]);
  });

  it("wires all chain-services stores to durable SQLite across service restarts", async () => {
    const databaseUrl = sqliteUrl(tempDirs);
    const database = {
      driver: "sqlite" as const,
      url: databaseUrl,
      migrationsAutoRun: true
    };
    const first = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
    stores.push(first);
    const draft = productDraft("draft_runtime");
    const participant = productParticipant(draft.draftId);
    const evidence = evidenceRecord();
    const prepared = preparedSubmission();
    const review = governanceReview();

    await first.projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(4n, 0, "OrderRegistered", {
        orderId: stateMachineOrderId,
        planId
      })]
    });
    await first.productBffStore.createDraft(draft, [participant]);
    await first.evidenceMetadataStore.put(evidence);
    await first.submissionStore.putPrepared(prepared);
    await first.governanceStore.putReview(review);
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
    stores.push(reopened);

    await expect(reopened.projectionStore.getStateMachineOrder(stateMachineOrderId)).resolves.toMatchObject({
      orderId: stateMachineOrderId,
      planId
    });
    await expect(reopened.productBffStore.getDraft(draft.draftId)).resolves.toMatchObject({
      draftId: draft.draftId
    });
    await expect(reopened.evidenceMetadataStore.get(evidence.evidence.evidenceId)).resolves.toMatchObject({
      evidence: { evidenceId: evidence.evidence.evidenceId }
    });
    await expect(reopened.submissionStore.getPrepared(prepared.prepareId)).resolves.toMatchObject({
      prepareId: prepared.prepareId
    });
    await expect(reopened.governanceStore.findLatestReview(review.subjectType, review.subjectId)).resolves.toMatchObject({
      reviewId: review.reviewId
    });
  });

  it("persists Store metadata stores across SQLite service restarts", async () => {
    const databaseUrl = sqliteUrl(tempDirs);
    const database = {
      driver: "sqlite" as const,
      url: databaseUrl,
      migrationsAutoRun: true
    };
    const first = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
    stores.push(first);
    const draft = storeZhixuDraftRecord();
    const deprecatedVersion = storeZhixuVersionRecord("v1", "deprecated", {
      cutoverAt: "2026-04-28T00:00:02.000Z",
      cutoverReason: "Superseded during Store cutover."
    });
    const activeVersion = storeZhixuVersionRecord("v2", "active", {
      planId: "0x0000000000000000000000000000000000000000000000000000000000000202" as Hex,
      planHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
      cutoverAt: "2026-04-28T00:00:03.000Z",
      cutoverReason: "Operator activated v2."
    });
    const supplier = storeSupplierMetadataRecord();
    const audit = storeSupplierAuditRecord(supplier);
    const docking = storeDockingSession();

    await first.storeZhixuDraftStore.createDraft(draft);
    await first.storeZhixuVersionMetadataStore.upsertVersion(deprecatedVersion);
    await first.storeZhixuVersionMetadataStore.upsertVersion(activeVersion);
    await first.storeSupplierMetadataStore.putSupplier(supplier);
    await first.storeSupplierMetadataStore.appendAudit(audit);
    await first.storeDockingSessionStore.createSession(docking);
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
    stores.push(reopened);

    await expect(reopened.storeZhixuDraftStore.getDraft(draft.draftId)).resolves.toMatchObject({
      draftId: draft.draftId,
      status: "compiled",
      compilePreview: { planId },
      productSchema: {
        planId,
        planHash,
        artifactHash,
        validation: { ok: true }
      }
    });
    await expect(reopened.storeZhixuDraftStore.findProductSchemaByPlan(planId, planHash)).resolves.toMatchObject({
      planId,
      planHash,
      schemaHash: "0xstoreproductschema"
    });
    await expect(reopened.storeZhixuVersionMetadataStore.listVersions(draft.zhixuId!)).resolves.toMatchObject([
      { versionId: "v1", status: "deprecated", cutoverReason: "Superseded during Store cutover." },
      { versionId: "v2", status: "active", cutoverReason: "Operator activated v2." }
    ]);
    await expect(reopened.storeSupplierMetadataStore.getSupplier(supplier.supplierId)).resolves.toMatchObject({
      supplierId: supplier.supplierId,
      supplierSubjectId: supplier.supplierSubjectId,
      capabilityTags: ["customs", "logistics"]
    });
    await expect(reopened.storeSupplierMetadataStore.listAudits(supplier.supplierId)).resolves.toMatchObject([
      { auditId: audit.auditId, action: "tags_updated", beforeTags: ["logistics"], afterTags: ["customs", "logistics"] }
    ]);
    await expect(reopened.storeDockingSessionStore.getSession(docking.sessionId)).resolves.toMatchObject({
      sessionId: docking.sessionId,
      draftSignalMap: [{ sourceSignalId: "source.done", targetSignalId: "target.start" }]
    });
  });

  it("reloads Store metadata through API routes after SQLite service restart", async () => {
    const databaseUrl = sqliteUrl(tempDirs);
    const database = {
      driver: "sqlite" as const,
      url: databaseUrl,
      migrationsAutoRun: true
    };
    const first = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
    stores.push(first);
    await first.projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(6n, 0, "PlanAttested", {
        domainId: crossBorderPlanIds.domainId,
        planId: crossBorderPlanIds.planId,
        planHash: crossBorderPlanIds.planHash,
        artifactHash: crossBorderPlanIds.artifactHash,
        policyHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
        metadataHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
        metadataURI: "https://store.example/zhixu/route-smoke",
        attester: seller
      })]
    });
    const firstRouter = createStoreMetadataRouter(first);

    const draftResponse = await firstRouter.handle({
      method: "POST",
      pathname: "/store/zhixu-drafts/import",
      headers: adminHeaders,
      body: {
        sourceKind: "zhixu_yaml",
        content: "apiVersion: uvp/v0\nkind: Zhixu\nmetadata:\n  name: route-durable\n",
        title: "Route durable draft",
        maintainer: "Store team",
        tags: ["route-smoke"]
      }
    });
    expect(draftResponse.status).toBe(201);
    const draftId = (draftResponse.body as { draft: { draftId: string } }).draft.draftId;

    const versionResponse = await firstRouter.handle({
      method: "POST",
      pathname: `/store/zhixu-series/${CROSS_BORDER_ZHIXU_ID}/versions/v-route/deprecate`,
      headers: adminHeaders,
      body: {
        zhixuId: CROSS_BORDER_ZHIXU_ID,
        versionLabel: "Route smoke v1",
        planId: crossBorderPlanIds.planId,
        planHash: crossBorderPlanIds.planHash,
        artifactHash: crossBorderPlanIds.artifactHash,
        cutoverReason: "Route restart smoke.",
        confirmation: {
          versionId: "v-route",
          planId: crossBorderPlanIds.planId,
          planHash: crossBorderPlanIds.planHash
        }
      }
    });
    expect(versionResponse.status).toBe(200);

    const supplierResponse = await firstRouter.handle({
      method: "POST",
      pathname: "/store/suppliers",
      headers: adminHeaders,
      body: {
        supplierId: "supplier-route-durable",
        supplierSubjectId: "0x0000000000000000000000000000000000000000000000000000000000003311",
        displayName: "Route Durable Supplier",
        wallet: seller,
        capabilityTags: ["logistics"],
        supportedRoleSlotIds: ["customs"],
        supportedStageIds: ["export.customs"],
        domains: [crossBorderPlanIds.domainId],
        metadataURI: "https://store.example/suppliers/route-durable"
      }
    });
    expect(supplierResponse.status).toBe(201);

    const dockingResponse = await firstRouter.handle({
      method: "POST",
      pathname: "/store/docking-sessions",
      headers: adminHeaders,
      body: {
        sourceZhixuId: CROSS_BORDER_ZHIXU_ID,
        targetZhixuId: CROSS_BORDER_ZHIXU_ID
      }
    });
    expect(dockingResponse.status).toBe(201);
    const dockingSessionId = (dockingResponse.body as { session: { sessionId: string } }).session.sessionId;

    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
    stores.push(reopened);
    const reopenedRouter = createStoreMetadataRouter(reopened);

    await expect(reopenedRouter.handle({ method: "GET", pathname: `/store/zhixu-drafts/${draftId}` }))
      .resolves.toMatchObject({
        status: 200,
        body: { draft: { draftId, title: "Route durable draft", status: "imported" } }
      });
    await expect(reopenedRouter.handle({ method: "GET", pathname: `/store/zhixu-series/${CROSS_BORDER_ZHIXU_ID}/versions` }))
      .resolves.toMatchObject({
        status: 200,
        body: {
          versions: expect.arrayContaining([
            expect.objectContaining({
              versionId: "v-route",
              status: "deprecated",
              cutoverReason: "Route restart smoke."
            })
          ])
        }
      });
    await expect(reopenedRouter.handle({ method: "GET", pathname: "/store/suppliers/supplier-route-durable" }))
      .resolves.toMatchObject({
        status: 200,
        body: {
          supplier: {
            supplierId: "supplier-route-durable",
            displayName: "Route Durable Supplier",
            capabilityTags: ["logistics"]
          }
        }
      });
    await expect(reopenedRouter.handle({ method: "GET", pathname: `/store/docking-sessions/${dockingSessionId}` }))
      .resolves.toMatchObject({
        status: 200,
        body: { session: { sessionId: dockingSessionId, status: "draft" } }
      });
  });
});

const postgresTestUrl = process.env.CHAIN_SERVICES_POSTGRES_TEST_URL;
const describePostgres = postgresTestUrl ? describe : describe.skip;

describePostgres(
  `postgres durable storage${postgresTestUrl ? "" : " (skipped: set CHAIN_SERVICES_POSTGRES_TEST_URL)"}`,
  () => {
    const stores: Array<{ close(): Promise<void> }> = [];
    const databases: PostgresDatabase[] = [];
    const schemas: string[] = [];

    afterEach(async () => {
      for (const store of stores.splice(0)) {
        await store.close();
      }
      for (const database of databases.splice(0)) {
        await database.close();
      }
      for (const schema of schemas.splice(0)) {
        await dropPostgresTestSchema(postgresTestUrl!, schema);
      }
    });

    it("runs Postgres migrations explicitly and records checksums", async () => {
      const databaseUrl = await postgresSchemaUrl(schemas);
      const database = new PostgresDatabase({ databaseUrl });
      databases.push(database);

      const dryRun = await runPostgresMigrations({
        database,
        migrationsDirectory: postgresMigrationsDirectory(),
        dryRun: true
      });
      expect(dryRun.pending.map((migration) => migration.version)).toContain("0001_projection_storage");
      expect(await listAppliedPostgresMigrations(database)).toHaveLength(0);

      const result = await runPostgresMigrations({
        database,
        migrationsDirectory: postgresMigrationsDirectory()
      });

      expect(result.applied.map((migration) => migration.version)).toEqual(expectedMigrationVersions);
      expect(result.applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect((await listAppliedPostgresMigrations(database)).map((record) => record.version)).toEqual(expectedMigrationVersions);
    });

    it("rolls back Postgres projection transactions and persists rebuild snapshots", async () => {
      const databaseUrl = await postgresSchemaUrl(schemas);
      const store = new PostgresProjectionStore({
        databaseUrl,
        chainId,
        migrations: { autoRun: true, directory: postgresMigrationsDirectory() }
      });
      stores.push(store);

      await expect(store.withTransaction(async () => {
        await store.appendEvent(chainEvent(1n, 0, "OrderCreated", {
          orderId: "order-postgres-rollback",
          buyer,
          seller
        }));
        throw new Error("force postgres rollback");
      })).rejects.toThrow("force postgres rollback");
      await expect(store.listEvents({ chainId })).resolves.toHaveLength(0);

      await store.resetFromEvents({
        deploymentBlock: 0n,
        events: [
          chainEvent(2n, 0, "PlanRegistered", {
            planId,
            planHash,
            hookCount: 1n
          }),
          chainEvent(3n, 0, "OrderRegistered", {
            orderId: stateMachineOrderId,
            planId
          })
        ],
        syncState: {
          chainId,
          contractAddress: snapshotScopeContract,
          syncStatus: "indexed",
          latestIndexedBlock: 3n,
          finalizedBlock: 3n,
          confirmationDepth: 1,
          lastEventName: "PlanRegistered",
          eventCount: 2
        }
      });
      await store.close();
      stores.splice(stores.indexOf(store), 1);

      const reopened = new PostgresProjectionStore({
        databaseUrl,
        chainId,
        migrations: { autoRun: true, directory: postgresMigrationsDirectory() }
      });
      stores.push(reopened);

      await expect(reopened.getStateMachineOrder(stateMachineOrderId)).resolves.toMatchObject({
        orderId: stateMachineOrderId,
        planId
      });
      await expect(reopened.listEvents({ chainId, contractAddress })).resolves.toHaveLength(2);
      await expect(reopened.getSyncState({ chainId, contractAddress: snapshotScopeContract })).resolves.toMatchObject({
        syncStatus: "indexed",
        latestIndexedBlock: 3n,
        finalizedBlock: 3n
      });
    });

    it("wires all chain-services stores to durable Postgres across service restarts", async () => {
      const databaseUrl = await postgresSchemaUrl(schemas);
      const database = {
        driver: "postgres" as const,
        url: databaseUrl,
        migrationsAutoRun: true
      };
      const first = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
      stores.push(first);
      const draft = productDraft("draft_postgres");
      const participant = productParticipant(draft.draftId);
      const registration = {
        ...productRegistration(draft.draftId),
        stateMachineAddress: contractAddress as Address,
        deploymentId: planId as Hex
      };
      const start = productOrderStart(registration);
      const evidence = evidenceRecord();
      const prepared = preparedSubmission();
      const submission = productSubmission(prepared);
      const review = governanceReview();
      const log = planAttestationLog();
      const storeDraft = storeZhixuDraftRecord();
      const storeVersion = storeZhixuVersionRecord("v-postgres", "active", {
        cutoverAt: "2026-04-28T00:00:07.000Z",
        cutoverReason: "Postgres durable Store metadata test."
      });
      const storeSupplier = storeSupplierMetadataRecord();
      const storeAudit = storeSupplierAuditRecord(storeSupplier);
      const storeDocking = storeDockingSession();

      await first.projectionStore.resetFromEvents({
        deploymentBlock: 0n,
        events: [chainEvent(4n, 0, "OrderRegistered", {
          orderId: stateMachineOrderId,
          planId
        })]
      });
      await first.productBffStore.createDraft(draft, [participant]);
      await first.productBffStore.createInvite(productInvite(draft.draftId, participant.participantId));
      await first.productBffStore.createRegistration(registration);
      await first.productBffStore.createOrderStart(start);
      await first.evidenceMetadataStore.put(evidence);
      await first.evidenceMetadataStore.markBound?.({
        evidenceId: evidence.evidence.evidenceId,
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        submissionId: "sub_postgres",
        orderId: evidence.evidence.orderId ?? "order-1",
        onchainOrderId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sourceId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        signalId: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        boundAt: "2026-04-28T00:00:02.000Z"
      });
      await first.evidenceMetadataStore.recordAdminRead({
        evidenceId: evidence.evidence.evidenceId,
        principalId: "admin-1",
        accessedAt: "2026-04-28T00:00:03.000Z",
        route: "evidence"
      });
      await first.submissionStore.putPrepared(prepared);
      await expect(first.submissionStore.reserveNonce("nonce-key-postgres")).resolves.toBe(true);
      await first.submissionStore.putSubmission(submission);
      await first.submissionStore.markPreparedUsed(prepared.prepareId, submission.submissionId, submission.updatedAt);
      await first.governanceStore.putReview(review);
      await first.governanceStore.appendPlanAttestationLog(log);
      await first.storeZhixuDraftStore.createDraft(storeDraft);
      await first.storeZhixuVersionMetadataStore.upsertVersion(storeVersion);
      await first.storeSupplierMetadataStore.putSupplier(storeSupplier);
      await first.storeSupplierMetadataStore.appendAudit(storeAudit);
      await first.storeDockingSessionStore.createSession(storeDocking);
      await first.close();
      stores.splice(stores.indexOf(first), 1);

      const reopened = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
      stores.push(reopened);

      await expect(reopened.projectionStore.getStateMachineOrder(stateMachineOrderId)).resolves.toMatchObject({
        orderId: stateMachineOrderId,
        planId
      });
      await expect(reopened.productBffStore.getRegistration(registration.registrationId)).resolves.toMatchObject({
        registrationId: registration.registrationId,
        stateMachineAddress: contractAddress,
        deploymentId: planId
      });
      await expect(reopened.productBffStore.getOrderStartByRegistrationId(registration.registrationId)).resolves.toMatchObject({
        startId: start.startId,
        stateMachineAddress: contractAddress,
        deploymentId: planId
      });
      await expect(reopened.evidenceMetadataStore.get(evidence.evidence.evidenceId)).resolves.toMatchObject({
        evidence: {
          evidenceId: evidence.evidence.evidenceId,
          status: "bound",
          boundSubmissionId: "sub_postgres"
        }
      });
      await expect(reopened.evidenceMetadataStore.listAdminReads?.()).resolves.toHaveLength(1);
      await expect(reopened.submissionStore.reserveNonce("nonce-key-postgres")).resolves.toBe(false);
      await expect(reopened.submissionStore.getPrepared(prepared.prepareId)).resolves.toMatchObject({
        prepareId: prepared.prepareId,
        submissionId: submission.submissionId,
        usedAt: submission.updatedAt
      });
      await expect(reopened.submissionStore.getSubmission(submission.submissionId)).resolves.toMatchObject({
        submissionId: submission.submissionId,
        attemptCount: 1,
        attempts: [{ txHash: submission.attempts[0]?.txHash }]
      });
      await expect(reopened.governanceStore.findLatestReview(review.subjectType, review.subjectId)).resolves.toMatchObject({
        reviewId: review.reviewId
      });
      await expect(reopened.governanceStore.getTxLog(log.txLogId)).resolves.toMatchObject(log);
      await expect(reopened.storeZhixuDraftStore.getDraft(storeDraft.draftId)).resolves.toMatchObject({
        draftId: storeDraft.draftId,
        status: "compiled"
      });
      await expect(reopened.storeZhixuVersionMetadataStore.getVersion(storeVersion.seriesId, storeVersion.versionId))
        .resolves.toMatchObject({
          versionId: storeVersion.versionId,
          status: "active",
          cutoverReason: "Postgres durable Store metadata test."
        });
      await expect(reopened.storeSupplierMetadataStore.findSupplierBySubjectId(storeSupplier.supplierSubjectId))
        .resolves.toMatchObject({
          supplierId: storeSupplier.supplierId,
          capabilityTags: ["customs", "logistics"]
        });
      await expect(reopened.storeSupplierMetadataStore.listAudits(storeSupplier.supplierId)).resolves.toMatchObject([
        { auditId: storeAudit.auditId, action: "tags_updated" }
      ]);
      await expect(reopened.storeDockingSessionStore.getSession(storeDocking.sessionId)).resolves.toMatchObject({
        sessionId: storeDocking.sessionId,
        status: "valid"
      });
    });

    it("reloads Store metadata through API routes after Postgres service restart", async () => {
      const databaseUrl = await postgresSchemaUrl(schemas);
      const database = {
        driver: "postgres" as const,
        url: databaseUrl,
        migrationsAutoRun: true
      };
      const first = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
      stores.push(first);
      await first.projectionStore.resetFromEvents({
        deploymentBlock: 0n,
        events: [chainEvent(6n, 0, "PlanAttested", {
          domainId: crossBorderPlanIds.domainId,
          planId: crossBorderPlanIds.planId,
          planHash: crossBorderPlanIds.planHash,
          artifactHash: crossBorderPlanIds.artifactHash,
          policyHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
          metadataHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
          metadataURI: "https://store.example/zhixu/postgres-route-smoke",
          attester: seller
        })]
      });
      const firstRouter = createStoreMetadataRouter(first);

      const imported = await importRouteSmokeDraft(firstRouter);
      const compiled = await compileRouteSmokeDraft(firstRouter, imported.draftId);
      const savedSchema = await saveExplicitRouteSmokeSchema(firstRouter, compiled.draftId);
      const versionResponse = await firstRouter.handle({
        method: "POST",
        pathname: `/store/zhixu-series/${CROSS_BORDER_ZHIXU_ID}/versions/v-postgres-route/deprecate`,
        headers: adminHeaders,
        body: {
          zhixuId: CROSS_BORDER_ZHIXU_ID,
          versionLabel: "Postgres route smoke v1",
          planId: crossBorderPlanIds.planId,
          planHash: crossBorderPlanIds.planHash,
          artifactHash: crossBorderPlanIds.artifactHash,
          cutoverReason: "Postgres route restart smoke.",
          confirmation: {
            versionId: "v-postgres-route",
            planId: crossBorderPlanIds.planId,
            planHash: crossBorderPlanIds.planHash
          }
        }
      });
      expect(versionResponse.status).toBe(200);

      const supplierResponse = await firstRouter.handle({
        method: "POST",
        pathname: "/store/suppliers",
        headers: adminHeaders,
        body: {
          supplierId: "supplier-postgres-route-durable",
          supplierSubjectId: "0x0000000000000000000000000000000000000000000000000000000000004411",
          displayName: "Postgres Route Durable Supplier",
          wallet: seller,
          capabilityTags: ["logistics"],
          supportedRoleSlotIds: ["customs"],
          supportedStageIds: ["export.customs"],
          domains: [crossBorderPlanIds.domainId],
          metadataURI: "https://store.example/suppliers/postgres-route-durable"
        }
      });
      expect(supplierResponse.status).toBe(201);
      const reviewedSupplier = await firstRouter.handle({
        method: "POST",
        pathname: "/store/suppliers/supplier-postgres-route-durable/review",
        headers: adminHeaders,
        body: {
          reviewStatus: "approved_for_broadcast",
          capabilityTags: ["inspection", "logistics"],
          publicSummary: "Approved for Postgres route durable smoke.",
          confirmation: {
            supplierId: "supplier-postgres-route-durable"
          }
        }
      });
      expect(reviewedSupplier.status).toBe(200);
      expect((reviewedSupplier.body as { supplier: StoreSupplierDTO }).supplier.capabilityTags).toEqual(["inspection", "logistics"]);

      const dockingResponse = await firstRouter.handle({
        method: "POST",
        pathname: "/store/docking-sessions",
        headers: adminHeaders,
        body: {
          sourceZhixuId: CROSS_BORDER_ZHIXU_ID,
          targetZhixuId: CROSS_BORDER_ZHIXU_ID
        }
      });
      expect(dockingResponse.status).toBe(201);
      const dockingSessionId = (dockingResponse.body as { session: { sessionId: string } }).session.sessionId;

      await first.close();
      stores.splice(stores.indexOf(first), 1);

      const reopened = createChainServicesStores({ database, chainId, migrationsDirectory: migrationsDirectory() });
      stores.push(reopened);
      const reopenedRouter = createStoreMetadataRouter(reopened);

      await expect(reopenedRouter.handle({ method: "GET", pathname: `/store/zhixu-drafts/${imported.draftId}` }))
        .resolves.toMatchObject({
          status: 200,
          body: {
            draft: {
              draftId: imported.draftId,
              title: "Route durable draft",
              productSchema: {
                schemaHash: savedSchema.schemaHash,
                validation: { ok: true, status: "explicit" }
              }
            }
          }
        });
      await expect(reopenedRouter.handle({ method: "GET", pathname: `/store/zhixu-drafts/${imported.draftId}/product-schema` }))
        .resolves.toMatchObject({
          status: 200,
          body: { productSchema: { schemaHash: savedSchema.schemaHash, validation: { ok: true } } }
        });
      await expect(reopenedRouter.handle({
        method: "GET",
        pathname: `/store/product-schemas/${encodeURIComponent(savedSchema.planId)}/${encodeURIComponent(savedSchema.planHash)}`,
        query: { artifactHash: savedSchema.artifactHash }
      })).resolves.toMatchObject({
        status: 200,
        body: { productSchema: { schemaHash: savedSchema.schemaHash } }
      });
      await expect(reopenedRouter.handle({ method: "GET", pathname: `/store/zhixu-series/${CROSS_BORDER_ZHIXU_ID}/versions` }))
        .resolves.toMatchObject({
          status: 200,
          body: {
            versions: expect.arrayContaining([
              expect.objectContaining({
                versionId: "v-postgres-route",
                status: "deprecated",
                cutoverReason: "Postgres route restart smoke."
              })
            ])
          }
        });
      await expect(reopenedRouter.handle({ method: "GET", pathname: "/store/suppliers/supplier-postgres-route-durable" }))
        .resolves.toMatchObject({
          status: 200,
          body: {
            supplier: {
              supplierId: "supplier-postgres-route-durable",
              displayName: "Postgres Route Durable Supplier",
              capabilityTags: ["inspection", "logistics"]
            }
          }
        });
      await expect(reopened.storeSupplierMetadataStore.listAudits("supplier-postgres-route-durable"))
        .resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({
            action: "tags_updated",
            beforeTags: ["logistics"],
            afterTags: ["inspection", "logistics"]
          })
        ]));
      await expect(reopenedRouter.handle({ method: "GET", pathname: `/store/docking-sessions/${dockingSessionId}` }))
        .resolves.toMatchObject({
          status: 200,
          body: { session: { sessionId: dockingSessionId, status: "draft" } }
        });
    });
  }
);

function openStore(tempDirs: string[]): SqliteProjectionStore {
  return new SqliteProjectionStore({
    databaseUrl: sqliteUrl(tempDirs),
    chainId,
    migrations: { autoRun: true, directory: migrationsDirectory() }
  });
}

function openProductStore(databaseUrl: string): SqliteProductBffStore {
  return new SqliteProductBffStore({
    databaseUrl,
    migrations: { autoRun: true, directory: migrationsDirectory() }
  });
}

function openEvidenceStore(databaseUrl: string): SqliteEvidenceStore {
  return new SqliteEvidenceStore({
    databaseUrl,
    migrations: { autoRun: true, directory: migrationsDirectory() }
  });
}

function openSubmissionStore(databaseUrl: string): SqliteSubmissionStore {
  return new SqliteSubmissionStore({
    databaseUrl,
    migrations: { autoRun: true, directory: migrationsDirectory() }
  });
}

function openGovernanceStore(databaseUrl: string): SqliteGovernanceStore {
  return new SqliteGovernanceStore({
    databaseUrl,
    migrations: { autoRun: true, directory: migrationsDirectory() }
  });
}

function createStoreMetadataRouter(stores: ChainServicesStores): ApiRouter {
  return createApiRouter(stores.projectionStore, {
    productBffStore: stores.productBffStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    submissionStore: stores.submissionStore,
    governanceStore: stores.governanceStore,
    storeZhixuDraftStore: stores.storeZhixuDraftStore,
    storeZhixuVersionMetadataStore: stores.storeZhixuVersionMetadataStore,
    storeSupplierMetadataStore: stores.storeSupplierMetadataStore,
    storeDockingSessionStore: stores.storeDockingSessionStore,
    storeAuditStore: stores.storeAuditStore,
    now: () => new Date("2026-04-30T00:00:00.000Z")
  });
}

async function importRouteSmokeDraft(router: ApiRouter): Promise<StoreZhixuDraftDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: "/store/zhixu-drafts/import",
    headers: adminHeaders,
    body: {
      sourceKind: "zhixu_yaml",
      content: routeSmokeZhixuYaml,
      title: "Route durable draft",
      maintainer: "Store team",
      tags: ["route-smoke"]
    }
  });
  expect(response.status).toBe(201);
  return (response.body as { draft: StoreZhixuDraftDTO }).draft;
}

async function compileRouteSmokeDraft(router: ApiRouter, draftId: string): Promise<StoreZhixuDraftDTO> {
  const response = await router.handle({
    method: "POST",
    pathname: `/store/zhixu-drafts/${draftId}/compile-preview`,
    headers: adminHeaders
  });
  expect(response.status).toBe(200);
  return (response.body as { draft: StoreZhixuDraftDTO }).draft;
}

async function saveExplicitRouteSmokeSchema(router: ApiRouter, draftId: string): Promise<StoreProductSchemaDTO> {
  const schemaResponse = await router.handle({
    method: "GET",
    pathname: `/store/zhixu-drafts/${draftId}/product-schema`
  });
  expect(schemaResponse.status).toBe(200);
  const schema = (schemaResponse.body as { productSchema: StoreProductSchemaDTO }).productSchema;
  const roleSlots = schema.roleSlots.map((slot) => ({
    ...slot,
    capabilityPlugins: (slot.capabilityPlugins ?? []).map((plugin) => ({
      ...plugin,
      source: "explicit" as const
    }))
  }));
  const explicitSchema = {
    ...schema,
    roleSlots,
    capabilityPlugins: roleSlots.flatMap((slot) => slot.capabilityPlugins ?? [])
  };
  const updateResponse = await router.handle({
    method: "PUT",
    pathname: `/store/zhixu-drafts/${draftId}/product-schema`,
    headers: adminHeaders,
    body: { productSchema: explicitSchema }
  });
  expect(updateResponse.status).toBe(200);
  return (updateResponse.body as { productSchema: StoreProductSchemaDTO }).productSchema;
}

function productDraft(draftId = "draft_sqlite"): ProductOrderDraftDTO {
  return {
    draftId,
    zhixuId: "zhixu-1",
    planId: planId as Hex,
    planHash: planHash as Hex,
    title: "Durable draft",
    businessType: "export",
    goods: ["widgets"],
    totalAmount: "100",
    currency: "USDC",
    status: "draft",
    createdBy: buyer,
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z"
  };
}

function productParticipant(draftId: string): DraftParticipantDTO {
  return {
    participantId: `${draftId}_participant`,
    draftId,
    roleSlotId: "funds",
    roleLabel: "Funds",
    displayName: "Buyer finance",
    walletAddress: buyer as Address,
    contact: "buyer@example.com",
    status: "accepted",
    required: true,
    acceptedAt: "2026-04-28T00:00:01.000Z"
  };
}

function productInvite(draftId: string, participantId: string): ProductInviteDTO {
  return {
    inviteId: `${draftId}_invite`,
    draftId,
    participantId,
    roleSlotId: "funds",
    tokenHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    status: "accepted",
    expiresAt: "2026-05-05T00:00:00.000Z",
    createdAt: "2026-04-28T00:00:00.000Z",
    acceptedWalletAddress: buyer as Address
  };
}

function productRegistration(draftId: string): ProductOrderRegistrationRecord {
  return {
    registrationId: `${draftId}_registration`,
    draftId,
    orderId: stateMachineOrderId,
    planId: planId as Hex,
    planHash: planHash as Hex,
    status: "pending",
    txHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    retryable: false,
    reconcileStatus: "submitted",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked",
    creator: buyer as Address,
    authorizations: [{
      sourceId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      signalId: "0x2222222222222222222222222222222222222222222222222222222222222222",
      submitter: buyer as Address,
      role: "0x3333333333333333333333333333333333333333333333333333333333333333",
      metadataHash: "0x4444444444444444444444444444444444444444444444444444444444444444"
    }],
    permissions: [{
      permissionId: "stage.stage-1.confirm_stage",
      orderId: stateMachineOrderId,
      draftId,
      participantId: `${draftId}_participant`,
      roleSlotId: "funds",
      stageIdentifier: "stage-1",
      source: "product",
      signalName: "confirm_stage",
      submitterAddress: buyer,
      payloadPolicy: "required",
      requiredEvidence: []
    }],
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z"
  };
}

function productOrderStart(registration: ProductOrderRegistrationRecord): ProductOrderStartDTO {
  return {
    startId: `${registration.draftId}_start`,
    registrationId: registration.registrationId,
    draftId: registration.draftId,
    orderId: registration.orderId,
    ...(registration.stateMachineAddress ? { stateMachineAddress: registration.stateMachineAddress } : {}),
    ...(registration.deploymentId ? { deploymentId: registration.deploymentId } : {}),
    status: "submitted",
    txHash: "0xabababababababababababababababababababababababababababababababab",
    retryable: false,
    reconcileStatus: "submitted",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z"
  };
}

function evidenceRecord(): EvidenceMetadataRecord {
  return {
    evidence: {
      evidenceId: "ev_sqlite",
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      ownerParticipantId: "seller",
      fileName: "invoice.txt",
      mimeType: "text/plain",
      size: 7,
      storageURI: "local://evidence/ev_sqlite",
      contentHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
      metadataHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
      payloadHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
      payloadRef: "uvp-evidence://product/ev_sqlite",
      status: "uploaded",
      createdAt: "2026-04-28T00:00:00.000Z"
    },
    metadata: {
      evidenceId: "ev_sqlite",
      businessLabel: "Invoice",
      documentType: "invoice",
      fields: { invoice: "INV-1" }
    },
    accessPolicy: {
      evidenceId: "ev_sqlite",
      orderId: "order-1",
      readers: ["seller", "buyer"],
      writers: ["seller"],
      adminReaders: ["ops"],
      disputeReaders: []
    },
    canonicalMetadata: {
      businessLabel: "Invoice",
      documentType: "invoice",
      fields: { invoice: "INV-1" }
    }
  };
}

function preparedSubmission(): PreparedSubmissionRecord {
  const evidence = evidenceRecord();
  return {
    prepareId: "prep_sqlite",
    taskId: "task-1",
    orderId: "order-1",
    onchainOrderId: "0x8888888888888888888888888888888888888888888888888888888888888888",
    stageIdentifier: "stage-1",
    signalName: "confirm_stage",
    sourceId: "0x9999999999999999999999999999999999999999999999999999999999999999",
    signalId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    intent: "confirm_stage",
    payloadHash: evidence.evidence.payloadHash,
    payloadRef: evidence.evidence.payloadRef,
    idempotencyKey: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    submitter: buyer as Address,
    nonce: "1",
    deadline: "1777334400",
    expiresAt: "2026-05-28T00:00:00.000Z",
    status: "prepared",
    humanSummary: {
      purpose: "UVP product task submission",
      orderId: "order-1",
      taskTitle: "Task 1",
      stage: "stage-1",
      action: "confirm stage",
      payloadHash: evidence.evidence.payloadHash,
      payloadRef: evidence.evidence.payloadRef,
      submitter: buyer as Address,
      validUntil: "2026-05-28T00:00:00.000Z",
      chainId,
      verifyingContract: contractAddress as Address
    },
    typedData: {
      domain: {
        name: "UVPStateMachine",
        version: "0.2",
        chainId,
        verifyingContract: contractAddress as Address
      },
      types: {
        UVPStateMachineSignal: [
          { name: "orderId", type: "bytes32" },
          { name: "sourceId", type: "bytes32" },
          { name: "signalId", type: "bytes32" },
          { name: "payloadHash", type: "bytes32" },
          { name: "idempotencyKey", type: "bytes32" },
          { name: "submitter", type: "address" },
          { name: "deadline", type: "uint256" }
        ]
      },
      primaryType: "UVPStateMachineSignal",
      message: {
        orderId: "0x8888888888888888888888888888888888888888888888888888888888888888",
        sourceId: "0x9999999999999999999999999999999999999999999999999999999999999999",
        signalId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        payloadHash: evidence.evidence.payloadHash,
        idempotencyKey: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        submitter: buyer as Address,
        deadline: "1777334400"
      }
    },
    evidence: [{
      evidenceId: evidence.evidence.evidenceId,
      payloadHash: evidence.evidence.payloadHash,
      payloadRef: evidence.evidence.payloadRef,
      verificationStatus: "unbound"
    }],
    authorization: { source: "test" },
    evidenceRecords: [{
      evidence: evidence.evidence,
      metadata: evidence.metadata,
      accessPolicy: evidence.accessPolicy
    }]
  };
}

function productSubmission(prepared: PreparedSubmissionRecord): ProductSubmissionDTO {
  return {
    submissionId: "sub_sqlite",
    prepareId: prepared.prepareId,
    taskId: prepared.taskId,
    orderId: prepared.orderId,
    onchainOrderId: prepared.onchainOrderId,
    stageIdentifier: prepared.stageIdentifier,
    signalName: prepared.signalName,
    sourceId: prepared.sourceId,
    signalId: prepared.signalId,
    intent: prepared.intent,
    payloadHash: prepared.payloadHash,
    payloadRef: prepared.payloadRef,
    idempotencyKey: prepared.idempotencyKey,
    submitter: prepared.submitter,
    nonce: prepared.nonce,
    deadline: prepared.deadline,
    status: "submitted",
    signatureStatus: "signature_verified",
    signatureHash: "0x1212121212121212121212121212121212121212121212121212121212121212",
    recoveredSubmitter: prepared.submitter,
    broadcastStatus: "submitted",
    txHash: "0x3434343434343434343434343434343434343434343434343434343434343434",
    retryable: false,
    retryState: "not_applicable",
    deadLetter: false,
    reconcileStatus: "submitted",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked",
    attempts: [{
      attemptId: "sub_sqlite:1",
      submissionId: "sub_sqlite",
      orderId: prepared.onchainOrderId,
      sourceId: prepared.sourceId,
      signalId: prepared.signalId,
      submitter: prepared.submitter,
      txHash: "0x3434343434343434343434343434343434343434343434343434343434343434",
      status: "submitted",
      gasPayer: seller as Address,
      attemptNumber: 1,
      retryable: false,
      retryState: "not_applicable",
      deadLetter: false,
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z"
    }],
    attemptCount: 1,
    proofRows: [{ label: "Submission status", value: "submitted" }],
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z"
  };
}

function governanceReview(): GovernanceReviewDTO {
  return {
    reviewId: "review_sqlite",
    subjectType: "zhixu",
    subjectId: "zhixu-1",
    status: "approved",
    riskLevel: "low",
    riskTags: ["kyb"],
    publicSummary: "Approved",
    internalNotes: "Internal",
    policyHash: "0x4545454545454545454545454545454545454545454545454545454545454545",
    metadataHash: "0x5656565656565656565656565656565656565656565656565656565656565656",
    metadataURI: "uvp-governance://metadata/review_sqlite",
    reviewer: "admin-1",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z"
  };
}

function planAttestationLog(): PlanAttestationLogDTO {
  return {
    logId: "plan_log_sqlite",
    txLogId: "plan_log_sqlite",
    action: "attest_plan",
    domainId: "0x6767676767676767676767676767676767676767676767676767676767676767",
    subjectId: planId as Hex,
    planId: planId as Hex,
    planHash: planHash as Hex,
    artifactHash: "0x7878787878787878787878787878787878787878787878787878787878787878",
    policyHash: "0x8989898989898989898989898989898989898989898989898989898989898989",
    metadataHash: "0x9090909090909090909090909090909090909090909090909090909090909090",
    metadataURI: "uvp-governance://metadata/plan",
    txHash: "0xabababababababababababababababababababababababababababababababab",
    signer: buyer as Address,
    requester: "admin-1",
    status: "pending",
    broadcastStatus: "submitted",
    retryable: false,
    reconcileStatus: "submitted",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked",
    request: {
      kind: "attestPlan",
      domainId: "0x6767676767676767676767676767676767676767676767676767676767676767",
      planId: planId as Hex,
      planHash: planHash as Hex,
      artifactHash: "0x7878787878787878787878787878787878787878787878787878787878787878",
      policyHash: "0x8989898989898989898989898989898989898989898989898989898989898989",
      metadataHash: "0x9090909090909090909090909090909090909090909090909090909090909090",
      metadataURI: "uvp-governance://metadata/plan"
    },
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z"
  };
}

function storeZhixuDraftRecord(): StoreZhixuDraftRecord {
  return {
    draftId: "store_draft_sqlite",
    sourceKind: "zhixu_yaml",
    content: "apiVersion: uvp/v0\nkind: Zhixu\nmetadata:\n  name: durable-store\n",
    status: "compiled",
    zhixuId: "zhixu-store-durable",
    title: "Durable Store Zhixu",
    maintainer: "Store team",
    publicSummary: "Durable metadata test draft.",
    tags: ["durable", "store"],
    compilePreview: {
      planId,
      planHash,
      artifactHash,
      stageCount: 2,
      roleSlotCount: 2,
      sourceCount: 1,
      signalCount: 2,
      canonicalArtifactHash: artifactHash
    },
    productSchema: {
      schemaVersion: "store-product-schema.v1",
      version: 1,
      zhixuId: "zhixu-store-durable",
      title: "Durable Store Zhixu",
      maintainer: "Store team",
      planId,
      planHash,
      artifactHash,
      roleSlots: [
        {
          slotId: "order.intake",
          title: "Intake executor",
          label: "Intake executor",
          duty: "Submit intake evidence.",
          evidence: ["Intake evidence"],
          status: "required",
          tone: "info",
          required: true,
          performanceSlotLabel: "Intake executor",
          businessPersonaLabels: ["Buyer ops"],
          capabilityPlugins: [
            {
              pluginKind: "evidence_submission",
              source: "explicit",
              stageIds: ["order.intake"],
              title: "Intake evidence",
              summary: "Submit intake evidence.",
              requiredEvidence: ["Intake evidence"]
            }
          ]
        }
      ],
      orderPermissionTable: [
        {
          permissionId: "order.intake#TRIGGER",
          roleSlotId: "order.intake",
          stageId: "order.intake",
          source: "buyer",
          signalName: "TRIGGER",
          payloadPolicy: "required",
          requiredEvidence: ["Intake evidence"]
        }
      ],
      capabilityPlugins: [
        {
          pluginKind: "evidence_submission",
          source: "explicit",
          stageIds: ["order.intake"],
          title: "Intake evidence",
          summary: "Submit intake evidence.",
          requiredEvidence: ["Intake evidence"]
        }
      ],
      businessPersonaLabels: ["Buyer ops"],
      stages: [
        {
          stageId: "order.intake",
          index: 0,
          name: "Intake",
          evidence: ["Intake evidence"],
          ownerRole: "order.intake",
          status: "pending"
        }
      ],
      schemaHash: "0xstoreproductschema",
      validation: {
        ok: true,
        status: "explicit",
        issues: []
      },
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:01.000Z"
    },
    reviewId: "review_store_draft",
    governanceTxLogId: "txlog_store_draft",
    errors: [],
    reviewStatus: "approved_for_broadcast",
    attestationDomainId: "0x0000000000000000000000000000000000000000000000000000000000007777",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:01.000Z"
  };
}

function storeZhixuVersionRecord(
  versionId: string,
  status: StoreZhixuVersionRecord["status"],
  overrides: Partial<StoreZhixuVersionRecord> = {}
): StoreZhixuVersionRecord {
  return {
    versionId,
    zhixuId: "zhixu-store-durable",
    seriesId: "zhixu-store-durable",
    versionLabel: versionId,
    status,
    planId: planId as Hex,
    planHash: planHash as Hex,
    artifactHash: artifactHash as Hex,
    createdAt: versionId === "v1" ? "2026-04-28T00:00:00.000Z" : "2026-04-28T00:00:01.000Z",
    ...overrides
  };
}

function storeSupplierMetadataRecord(): StoreSupplierMetadataRecord {
  return {
    supplierId: "supplier-store-durable",
    supplierSubjectId: "0x0000000000000000000000000000000000000000000000000000000000003301",
    displayName: "Store Durable Supplier",
    wallet: seller as Address,
    capabilityTags: ["customs", "logistics"],
    supportedRoleSlotIds: ["seller", "logistics"],
    supportedStageIds: ["shipment", "customs"],
    domains: ["0x0000000000000000000000000000000000000000000000000000000000007777"],
    reviewStatus: "approved_for_broadcast",
    metadataURI: "https://store.example/suppliers/durable",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:04.000Z"
  };
}

function storeSupplierAuditRecord(supplier: StoreSupplierMetadataRecord): StoreSupplierAuditRecord {
  return {
    auditId: "audit_000001",
    supplierId: supplier.supplierId,
    supplierSubjectId: supplier.supplierSubjectId,
    action: "tags_updated",
    actor: "operator-1",
    beforeTags: ["logistics"],
    afterTags: ["customs", "logistics"],
    reviewStatus: "approved_for_broadcast",
    createdAt: "2026-04-28T00:00:05.000Z"
  };
}

function storeDockingSession(): StoreDockingSessionDTO {
  return {
    sessionId: "dock_sqlite",
    status: "valid",
    source: {
      zhixuId: "source-zhixu",
      title: "Source Zhixu",
      versionId: "source-v1",
      versionLabel: "Source v1",
      lifecycleStatus: "active",
      attestationStatus: "attested",
      planId,
      planHash
    },
    target: {
      zhixuId: "target-zhixu",
      title: "Target Zhixu",
      versionId: "target-v1",
      versionLabel: "Target v1",
      lifecycleStatus: "active",
      attestationStatus: "attested",
      planId: "0x0000000000000000000000000000000000000000000000000000000000000202",
      planHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    candidateMappings: [],
    draftSignalMap: [{
      entryId: "map_1",
      sourceSignalId: "source.done",
      targetSignalId: "target.start",
      note: "Durable draft map"
    }],
    validation: {
      ok: true,
      errors: [],
      checkedAt: "2026-04-28T00:00:06.000Z",
      nonPublishing: true
    },
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:06.000Z"
  };
}

function sqliteUrl(tempDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "uvp-chain-services-storage-"));
  tempDirs.push(dir);
  return `sqlite://${join(dir, "storage.sqlite")}`;
}

function migrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

function postgresMigrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations/postgres", import.meta.url));
}

async function postgresSchemaUrl(schemas: string[]): Promise<string> {
  const schema = postgresTestSchemaName();
  await createPostgresTestSchema(postgresTestUrl!, schema);
  schemas.push(schema);
  return postgresUrlWithSearchPath(postgresTestUrl!, schema);
}

async function createPostgresTestSchema(databaseUrl: string, schema: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`CREATE SCHEMA ${postgresIdentifier(schema)}`);
  } finally {
    await pool.end();
  }
}

async function dropPostgresTestSchema(databaseUrl: string, schema: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${postgresIdentifier(schema)} CASCADE`);
  } finally {
    await pool.end();
  }
}

function postgresUrlWithSearchPath(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  const existingOptions = url.searchParams.get("options");
  const searchPathOption = `-c search_path=${postgresIdentifier(schema)}`;
  url.searchParams.set("options", existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption);
  return url.toString();
}

function postgresTestSchemaName(): string {
  return `uvp_storage_${randomUUID().replaceAll("-", "_")}`;
}

function postgresIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid Postgres test identifier: ${identifier}`);
  }
  return identifier;
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>
): ChainEvent {
  return {
    chainId,
    contractAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args
  };
}
