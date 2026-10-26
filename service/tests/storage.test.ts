import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./postgres.js";
import type { ChainEvent } from "../src/indexer/events.js";
import type {
  DraftParticipantDTO,
  ProductInviteDTO,
  ProductOrderDraftDTO,
  ProductOrderTriggerRecord,
} from "../src/product/query/bff/types.js";
import type { Address, Hex } from "../src/shared/types.js";
import { StorageConstraintError } from "../src/storage/errors.js";
import { createChainServicesStores } from "../src/storage/factory.js";
import { normalizePostgresError } from "../src/storage/postgres-client.js";
import { PostgresProjectionStore } from "../src/storage/postgres.js";
import type { EvidenceMetadataRecord } from "../src/evidence/store.js";
import type {
  GovernanceReviewDTO,
  IdentityTxLogDTO,
} from "../src/governance/types.js";
import type { StoreDockingSessionDTO } from "../src/store/console/docking.js";
import type { StoreZhixuDraftRecord } from "../src/store/console/zhixu-drafts.js";
import type { StoreZhixuVersionRecord } from "../src/store/console/version.js";
import type {
  StoreSupplierAuditRecord,
  StoreSupplierMetadataRecord,
} from "../src/store/suppliers/index.js";
import { submissionStatusLabel } from "../src/submissions/service.js";
import type {
  PreparedSubmissionRecord,
  ProductSubmissionDTO,
} from "../src/submissions/types.js";

const chainId = 31337;
const contractAddress = "0x1111111111111111111111111111111111111111";
const registryAddress = contractAddress as Address;
const slotA = "0x2222222222222222222222222222222222222222";
const slotB = "0x3333333333333333333333333333333333333333";
const planId =
  "0x0000000000000000000000000000000000000000000000000000000000000101";
const planHash =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const artifactHash =
  "0x7878787878787878787878787878787878787878787878787878787878787878";
const stateMachineOrderId =
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const snapshotScopeContract = "0x0000000000000000000000000000000000000000";

describe("postgres durable storage", () => {
  const stores: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) {
      await store.close();
    }
  });

  it("maps only the unique-violation SQLSTATE to StorageConstraintError", () => {
    const pgError = (code: string) =>
      Object.assign(new Error(`pg failure (${code})`), { code });
    expect(normalizePostgresError(pgError("23505"))).toBeInstanceOf(
      StorageConstraintError,
    );
    for (const code of ["23502", "23503", "23514", "23000", "23"]) {
      const normalized = normalizePostgresError(pgError(code));
      expect(normalized).not.toBeInstanceOf(StorageConstraintError);
      expect(normalized).toBeInstanceOf(Error);
    }
  });

  it("rolls back Postgres projection transactions and persists rebuild snapshots", async () => {
    const databaseUrl = await createPostgresTestDatabase();
    const store = new PostgresProjectionStore({
      databaseUrl,
      chainId,
      migrations: { autoRun: true, directory: postgresMigrationsDirectory() },
    });
    stores.push(store);

    await expect(
      store.withTransaction(async () => {
        await store.appendEvent(
          chainEvent(1n, 0, "OrderCreated", {
            orderId: "order-postgres-rollback",
            slotA,
            slotB,
          }),
        );
        throw new Error("force postgres rollback");
      }),
    ).rejects.toThrow("force postgres rollback");
    await expect(store.listEvents({ chainId })).resolves.toHaveLength(0);

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(2n, 0, "PlanRegistered", {
          planId,
          planHash,
          hookCount: 1n,
        }),
        chainEvent(3n, 0, "OrderRegistered", {
          orderId: stateMachineOrderId,
          planId,
        }),
      ],
      syncState: {
        chainId,
        contractAddress: snapshotScopeContract,
        syncStatus: "indexed",
        latestIndexedBlock: 3n,
        finalizedBlock: 3n,
        confirmationDepth: 1,
        lastEventName: "PlanRegistered",
        eventCount: 2,
      },
    });
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new PostgresProjectionStore({
      databaseUrl,
      chainId,
      migrations: { autoRun: true, directory: postgresMigrationsDirectory() },
    });
    stores.push(reopened);

    await expect(
      reopened.getStateMachineOrder(stateMachineOrderId),
    ).resolves.toMatchObject({
      orderId: stateMachineOrderId,
      planId,
    });
    await expect(
      reopened.listEvents({ chainId, contractAddress }),
    ).resolves.toHaveLength(2);
    await expect(
      reopened.getSyncState({
        chainId,
        contractAddress: snapshotScopeContract,
      }),
    ).resolves.toMatchObject({
      syncStatus: "indexed",
      latestIndexedBlock: 3n,
      finalizedBlock: 3n,
    });
  });

  it("deduplicates the same Postgres event but retains same-position logs from different transactions", async () => {
    const databaseUrl = await createPostgresTestDatabase();
    const store = new PostgresProjectionStore({
      databaseUrl,
      chainId,
      migrations: { autoRun: true, directory: postgresMigrationsDirectory() },
    });
    stores.push(store);

    const event = chainEvent(10n, 0, "OrderCreated", {
      orderId: "order-postgres-unique",
      slotA,
      slotB,
    });
    await store.appendEvent(event);
    await expect(store.appendEvent(event)).resolves.toBeUndefined();

    await expect(
      store.listEvents({ chainId, contractAddress }),
    ).resolves.toHaveLength(1);

    const sameLogIndexDifferentTx = {
      ...event,
      transactionHash:
        "0x9999999999999999999999999999999999999999999999999999999999999999" as const,
    };
    await expect(
      store.appendEvent(sameLogIndexDifferentTx),
    ).resolves.toBeUndefined();

    await expect(
      store.listEvents({ chainId, contractAddress }),
    ).resolves.toHaveLength(2);
  });

  it("assembles and persists notification state and broadcast dedupe stores in the Postgres factory wiring", async () => {
    const databaseUrl = await createPostgresTestDatabase();
    const factoryStores = createChainServicesStores({
      database: {
        url: databaseUrl,
        migrationsAutoRun: true,
      },
      chainId,
      migrationsDirectory: migrationsDirectory(),
    });
    stores.push(factoryStores);

    expect(factoryStores.notificationStateStore).toBeDefined();
    expect(factoryStores.broadcastDedupeStore).toBeDefined();

    const notificationState = factoryStores.notificationStateStore!;
    const marked = await notificationState.markRead({
      participantKey: "supplier:postgres-1",
      notificationId: planId as Hex,
      readAt: "2026-04-28T00:00:00.000Z",
    });
    expect(marked.readAt).toBe("2026-04-28T00:00:00.000Z");
    await expect(
      notificationState.getReadState("supplier:postgres-1", planId as Hex),
    ).resolves.toMatchObject({
      participantKey: "supplier:postgres-1",
      notificationId: planId,
      readAt: "2026-04-28T00:00:00.000Z",
    });

    const dedupe = factoryStores.broadcastDedupeStore!;
    const dedupeTxHash =
      "0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b" as Hex;
    await dedupe.save("idem-postgres-1", {
      attempts: 1,
      lastResult: { status: "submitted", txHash: dedupeTxHash },
    });
    await expect(dedupe.load("idem-postgres-1")).resolves.toMatchObject({
      attempts: 1,
      lastResult: { status: "submitted", txHash: dedupeTxHash },
    });
    await expect(dedupe.claimTxHash(dedupeTxHash, "idem-postgres-1")).resolves.toBeUndefined();
    await expect(dedupe.claimTxHash(dedupeTxHash, "idem-postgres-2")).resolves.toBe(
      "idem-postgres-1",
    );
  });

  it("wires all chain-services stores to durable Postgres across service restarts", async () => {
    const databaseUrl = await createPostgresTestDatabase();
    const database = {
      url: databaseUrl,
      migrationsAutoRun: true,
    };
    const first = createChainServicesStores({
      database,
      chainId,
      migrationsDirectory: migrationsDirectory(),
    });
    stores.push(first);
    const draft = productDraft("draft_postgres");
    const participant = productParticipant(draft.draftId);
    const registration = {
      ...productRegistration(draft.draftId),
      stateMachineAddress: contractAddress as Address,
      deploymentId: planId as Hex,
    };
    const evidence = evidenceRecord();
    const prepared = preparedSubmission();
    const submission = productSubmission(prepared);
    const review = governanceReview();
    const log = identityTxLog();
    const storeDraft = storeZhixuDraftRecord();
    const storeVersion = storeZhixuVersionRecord("v-postgres", "active", {
      cutoverAt: "2026-04-28T00:00:07.000Z",
      cutoverReason: "Postgres durable Store metadata test.",
    });
    const storeSupplier = storeSupplierMetadataRecord();
    const storeAudit = storeSupplierAuditRecord(storeSupplier);
    const storeDocking = storeDockingSession();

    await first.projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(4n, 0, "OrderRegistered", {
          orderId: stateMachineOrderId,
          planId,
        }),
      ],
    });
    await first.productBffStore.createDraft(draft, [participant]);
    await first.productBffStore.createInviteIfNoneActive(
      productInvite(draft.draftId, participant.participantId),
      "2026-01-01T00:00:00.000Z",
    );
    await first.productBffStore.createRegistrationIfNoneForDraft(registration);
    await first.evidenceMetadataStore.put(evidence);
    await first.evidenceMetadataStore.markBound?.({
      evidenceId: evidence.evidence.evidenceId,
      txHash:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      submissionId: "sub_postgres",
      orderId: evidence.evidence.orderId ?? "order-1",
      onchainOrderId:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sourceId:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      signalId:
        "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      boundAt: "2026-04-28T00:00:02.000Z",
    });
    await first.evidenceMetadataStore.recordAdminRead({
      evidenceId: evidence.evidence.evidenceId,
      principalId: "admin-1",
      accessedAt: "2026-04-28T00:00:03.000Z",
      route: "evidence",
    });
    await first.submissionStore.putPrepared(prepared);
    await expect(
      first.submissionStore.reserveNonce("nonce-key-postgres"),
    ).resolves.toBe(true);
    await first.submissionStore.putSubmission(submission);
    await first.submissionStore.markPreparedUsed(
      prepared.prepareId,
      submission.submissionId,
      submission.updatedAt,
    );
    await first.governanceStore.putReview(review);
    await first.governanceStore.appendIdentityTxLog(log);
    await first.storeZhixuDraftStore.createDraft(storeDraft);
    await first.storeZhixuVersionMetadataStore.upsertVersion(storeVersion);
    await first.storeSupplierMetadataStore.putSupplier(storeSupplier);
    await first.storeSupplierMetadataStore.appendAudit(storeAudit);
    await first.storeDockingSessionStore.createSession(storeDocking);
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = createChainServicesStores({
      database,
      chainId,
      migrationsDirectory: migrationsDirectory(),
    });
    stores.push(reopened);

    await expect(
      reopened.projectionStore.getStateMachineOrder(stateMachineOrderId),
    ).resolves.toMatchObject({
      orderId: stateMachineOrderId,
      planId,
    });
    await expect(
      reopened.productBffStore.getRegistration(registration.triggerId),
    ).resolves.toMatchObject({
      triggerId: registration.triggerId,
      stateMachineAddress: contractAddress,
      deploymentId: planId,
    });
    await expect(
      reopened.evidenceMetadataStore.get(evidence.evidence.evidenceId),
    ).resolves.toMatchObject({
      evidence: {
        evidenceId: evidence.evidence.evidenceId,
        status: "bound",
        boundSubmissionId: "sub_postgres",
      },
    });
    await expect(
      reopened.evidenceMetadataStore.listAdminReads?.(),
    ).resolves.toHaveLength(1);
    await expect(
      reopened.submissionStore.reserveNonce("nonce-key-postgres"),
    ).resolves.toBe(false);
    await expect(
      reopened.submissionStore.reserveNonce("nonce-key-postgres", {
        staleBefore: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toBe(true);
    await expect(
      reopened.submissionStore.getPrepared(prepared.prepareId),
    ).resolves.toMatchObject({
      prepareId: prepared.prepareId,
      submissionId: submission.submissionId,
      usedAt: submission.updatedAt,
    });
    await expect(
      reopened.submissionStore.getSubmission(submission.submissionId),
    ).resolves.toMatchObject({
      submissionId: submission.submissionId,
      attemptCount: 1,
      attempts: [{ txHash: submission.attempts[0]?.txHash }],
    });
    await expect(
      reopened.governanceStore.findLatestReview(
        review.subjectType,
        review.subjectId,
      ),
    ).resolves.toMatchObject({
      reviewId: review.reviewId,
    });
    await expect(
      reopened.governanceStore.getTxLog(log.txLogId),
    ).resolves.toMatchObject(log);
    await expect(
      reopened.storeZhixuDraftStore.getDraft(storeDraft.draftId),
    ).resolves.toMatchObject({
      draftId: storeDraft.draftId,
      status: "compiled",
    });
    await expect(
      reopened.storeZhixuVersionMetadataStore.getVersion(
        storeVersion.seriesId,
        storeVersion.versionId,
      ),
    ).resolves.toMatchObject({
      versionId: storeVersion.versionId,
      status: "active",
      cutoverReason: "Postgres durable Store metadata test.",
    });
    await expect(
      reopened.storeSupplierMetadataStore.findSupplierBySubjectId(
        storeSupplier.supplierSubjectId,
      ),
    ).resolves.toMatchObject({
      supplierId: storeSupplier.supplierId,
      supportedRoleSlotIds: ["slot-b", "slot-c"],
    });
    await expect(
      reopened.storeSupplierMetadataStore.listAudits(
        storeSupplier.supplierId,
      ),
    ).resolves.toMatchObject([
      { auditId: storeAudit.auditId, action: "supported_slots_updated" },
    ]);
    await expect(
      reopened.storeDockingSessionStore.getSession(storeDocking.sessionId),
    ).resolves.toMatchObject({
      sessionId: storeDocking.sessionId,
      status: "valid",
    });
  });
});

function productDraft(draftId = "draft_durable"): ProductOrderDraftDTO {
  return {
    draftId,
    zhixuId: "zhixu-1",
    planId: planId as Hex,
    planHash: planHash as Hex,
    title: "Durable draft",
    businessType: "export",
    goods: ["widgets"],
    totalAmount: "100",
    currency: "tok-1",
    status: "draft",
    createdBy: slotA,
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  };
}

function productParticipant(draftId: string): DraftParticipantDTO {
  return {
    participantId: `${draftId}_participant`,
    draftId,
    roleSlotId: "funds",
    roleLabel: "Funds",
    displayName: "Slot-a finance",
    walletAddress: slotA as Address,
    contact: "slot-a@example.com",
    status: "accepted",
    required: true,
    acceptedAt: "2026-04-28T00:00:01.000Z",
  };
}

function productInvite(
  draftId: string,
  participantId: string,
): ProductInviteDTO {
  return {
    inviteId: `${draftId}_invite`,
    draftId,
    participantId,
    roleSlotId: "funds",
    tokenHash:
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    status: "accepted",
    expiresAt: "2026-05-05T00:00:00.000Z",
    createdAt: "2026-04-28T00:00:00.000Z",
    acceptedWalletAddress: slotA as Address,
  };
}

function productRegistration(draftId: string): ProductOrderTriggerRecord {
  return {
    triggerId: `${draftId}_registration`,
    prepareId: `${draftId}_prepare`,
    draftId,
    orderId: stateMachineOrderId,
    stateMachineAddress: contractAddress as Address,
    deploymentId: planId as Hex,
    planId: planId as Hex,
    planHash: planHash as Hex,
    status: "submitted",
    txHash:
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    sourceId:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    signalId:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    triggerHookId:
      "0x5555555555555555555555555555555555555555555555555555555555555555",
    triggerStageId:
      "0x6666666666666666666666666666666666666666666666666666666666666666",
    submitter: slotA as Address,
    payloadHash:
      "0x7777777777777777777777777777777777777777777777777777777777777777",
    idempotencyKey:
      "0x8888888888888888888888888888888888888888888888888888888888888888",
    deadline: "1770000000",
    typedData: {},
    retryable: false,
    reconcileStatus: "submitted",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked",
    creator: slotA as Address,
    authorizations: [
      {
        sourceId:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        signalId:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        submitter: slotA as Address,
        role: "0x3333333333333333333333333333333333333333333333333333333333333333",
        metadataHash:
          "0x4444444444444444444444444444444444444444444444444444444444444444",
      },
    ],
    permissions: [
      {
        permissionId: "stage.stage-1.confirm_stage",
        orderId: stateMachineOrderId,
        draftId,
        participantId: `${draftId}_participant`,
        roleSlotId: "funds",
        stageIdentifier: "stage-1",
        source: "product",
        signalName: "confirm_stage",
        submitterAddress: slotA,
        payloadPolicy: "required",
      },
    ],
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  };
}

function evidenceRecord(): EvidenceMetadataRecord {
  return {
    evidence: {
      evidenceId: "ev_durable",
      orderId: "order-1",
      taskId: "task-1",
      stageIdentifier: "stage-1",
      ownerParticipantId: "slot-b",
      fileName: "doc-1.txt",
      mimeType: "text/plain",
      size: 7,
      storageURI: "local://evidence/ev_durable",
      contentHash:
        "0x5555555555555555555555555555555555555555555555555555555555555555",
      metadataHash:
        "0x6666666666666666666666666666666666666666666666666666666666666666",
      payloadHash:
        "0x7777777777777777777777777777777777777777777777777777777777777777",
      payloadRef: "uvp-evidence://product/ev_durable",
      status: "uploaded",
      createdAt: "2026-04-28T00:00:00.000Z",
    },
    metadata: {
      evidenceId: "ev_durable",
      businessLabel: "Doc-1",
      documentType: "doc-1",
      fields: { "doc-1": "DOC-1" },
    },
    accessPolicy: {
      evidenceId: "ev_durable",
      orderId: "order-1",
      readers: ["slot-b", "slot-a"],
      writers: ["slot-b"],
      adminReaders: ["ops"],
      adjudicatorReaders: [],
    },
    canonicalMetadata: {
      businessLabel: "Doc-1",
      documentType: "doc-1",
      fields: { "doc-1": "DOC-1" },
    },
  };
}

function preparedSubmission(): PreparedSubmissionRecord {
  const evidence = evidenceRecord();
  return {
    prepareId: "prep_durable",
    taskId: "task-1",
    orderId: "order-1",
    onchainOrderId:
      "0x8888888888888888888888888888888888888888888888888888888888888888",
    planId: "0x6666666666666666666666666666666666666666666666666666666666666",
    stageIdentifier: "stage-1",
    signalName: "confirm_stage",
    sourceId:
      "0x9999999999999999999999999999999999999999999999999999999999999999",
    signalId:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    intent: "confirm_stage",
    payloadHash: evidence.evidence.payloadHash,
    payloadRef: evidence.evidence.payloadRef,
    idempotencyKey:
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    submitter: slotA as Address,
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
      submitter: slotA as Address,
      validUntil: "2026-05-28T00:00:00.000Z",
      chainId,
      verifyingContract: contractAddress as Address,
    },
    typedData: {
      domain: {
        name: "UVPStateMachine",
        version: "0.15",
        chainId,
        verifyingContract: contractAddress as Address,
      },
      types: {
        UVPStateMachineSignal: [
          { name: "planId", type: "bytes32" },
          { name: "orderId", type: "bytes32" },
          { name: "sourceId", type: "bytes32" },
          { name: "signalId", type: "bytes32" },
          { name: "payloadHash", type: "bytes32" },
          { name: "idempotencyKey", type: "bytes32" },
          { name: "submitter", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "UVPStateMachineSignal",
      message: {
        planId:
          "0x6666666666666666666666666666666666666666666666666666666666666",
        orderId:
          "0x8888888888888888888888888888888888888888888888888888888888888888",
        sourceId:
          "0x9999999999999999999999999999999999999999999999999999999999999999",
        signalId:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        payloadHash: evidence.evidence.payloadHash,
        idempotencyKey:
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        submitter: slotA as Address,
        deadline: "1777334400",
      },
    },
    evidence: [
      {
        evidenceId: evidence.evidence.evidenceId,
        payloadHash: evidence.evidence.payloadHash,
        payloadRef: evidence.evidence.payloadRef,
        verificationStatus: "unbound",
      },
    ],
    attribution: {
      sourceId:
        "0x9999999999999999999999999999999999999999999999999999999999999999",
      signalId:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      stageId:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      capabilityProof: [],
    },
    authorization: { source: "test" },
    evidenceRecords: [
      {
        evidence: evidence.evidence,
        metadata: evidence.metadata,
        accessPolicy: evidence.accessPolicy,
      },
    ],
  };
}

function productSubmission(
  prepared: PreparedSubmissionRecord,
): ProductSubmissionDTO {
  return {
    submissionId: "sub_durable",
    prepareId: prepared.prepareId,
    taskId: prepared.taskId,
    orderId: prepared.orderId,
    onchainOrderId: prepared.onchainOrderId,
    planId: prepared.planId,
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
    statusLabel: submissionStatusLabel("submitted"),
    signatureStatus: "signature_verified",
    signatureHash:
      "0x1212121212121212121212121212121212121212121212121212121212121212",
    recoveredSubmitter: prepared.submitter,
    broadcastStatus: "submitted",
    txHash:
      "0x3434343434343434343434343434343434343434343434343434343434343434",
    retryable: false,
    retryState: "not_applicable",
    deadLetter: false,
    reconcileStatus: "submitted",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked",
    attempts: [
      {
        attemptId: "sub_durable:1",
        submissionId: "sub_durable",
        orderId: prepared.onchainOrderId,
        sourceId: prepared.sourceId,
        signalId: prepared.signalId,
        submitter: prepared.submitter,
        txHash:
          "0x3434343434343434343434343434343434343434343434343434343434343434",
        status: "submitted",
        gasPayer: slotB as Address,
        attemptNumber: 1,
        retryable: false,
        retryState: "not_applicable",
        deadLetter: false,
        createdAt: "2026-04-28T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
      },
    ],
    attemptCount: 1,
    proofRows: [{ label: "Submission status", value: "submitted" }],
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  };
}

function governanceReview(): GovernanceReviewDTO {
  return {
    reviewId: "review_durable",
    subjectType: "zhixu",
    subjectId: "zhixu-1",
    status: "approved",
    riskLevel: "low",
    riskTags: ["kyb"],
    publicSummary: "Approved",
    internalNotes: "Internal",
    policyHash:
      "0x4545454545454545454545454545454545454545454545454545454545454545",
    metadataHash:
      "0x5656565656565656565656565656565656565656565656565656565656565656",
    metadataURI: "uvp-governance://metadata/review_durable",
    reviewer: "admin-1",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  };
}

function identityTxLog(): IdentityTxLogDTO {
  return {
    logId: "identity_log_durable",
    txLogId: "identity_log_durable",
    action: "register_identity",
    subjectId: planId as Hex,
    account: slotA as Address,
    descriptorHash:
      "0x9090909090909090909090909090909090909090909090909090909090909090",
    descriptorURI: "uvp-store://identities/acme",
    txHash:
      "0xabababababababababababababababababababababababababababababababab",
    signer: slotA as Address,
    requester: "admin-1",
    status: "pending",
    broadcastStatus: "submitted",
    retryable: false,
    reconcileStatus: "submitted",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked",
    request: {
      kind: "registerIdentity",
      subjectId: planId as Hex,
      account: slotA as Address,
      descriptorHash:
        "0x9090909090909090909090909090909090909090909090909090909090909090",
      descriptorURI: "uvp-store://identities/acme",
    },
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  };
}

function storeZhixuDraftRecord(): StoreZhixuDraftRecord {
  return {
    draftId: "store_draft_durable",
    sourceKind: "zhixu_yaml",
    content:
      "apiVersion: uvp/v0\nkind: Zhixu\nmetadata:\n  name: durable-store\n",
    publisherAddress: "0x1234567890123456789012345678901234567890",
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
          slotId: "intake",
          title: "Intake executor",
          label: "Intake executor",
          duty: "Submit intake evidence.",
          evidence: ["Intake evidence"],
          status: "required",
          tone: "info",
          required: true,
          performanceSlotLabel: "Intake executor",
          businessPersonaLabels: ["Slot-a ops"],
        },
      ],
      businessPersonaLabels: ["Slot-a ops"],
      stages: [
        {
          stageId: "intake",
          index: 0,
          name: "Intake",
          evidence: ["Intake evidence"],
          ownerRole: "intake",
          status: "pending",
        },
      ],
      schemaHash: "0xstoreproductschema",
      validation: {
        ok: true,
        status: "explicit",
        issues: [],
      },
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:01.000Z",
    },
    reviewId: "review_store_draft",
    errors: [],
    reviewStatus: "approved_for_broadcast",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:01.000Z",
  };
}

function storeZhixuVersionRecord(
  versionId: string,
  status: StoreZhixuVersionRecord["status"],
  overrides: Partial<StoreZhixuVersionRecord> = {},
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
    createdAt:
      versionId === "v1"
        ? "2026-04-28T00:00:00.000Z"
        : "2026-04-28T00:00:01.000Z",
    ...overrides,
  };
}

function storeSupplierMetadataRecord(): StoreSupplierMetadataRecord {
  return {
    supplierId: "supplier-store-durable",
    supplierSubjectId:
      "0x0000000000000000000000000000000000000000000000000000000000003301",
    displayName: "Store Durable Supplier",
    wallet: slotB as Address,
    supportedRoleSlotIds: ["slot-b", "slot-c"],
    supportedStageIds: ["shipment", "example"],
    registryAddresses: [registryAddress],
    reviewStatus: "approved_for_broadcast",
    metadataURI: "https://store.example/suppliers/durable",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:04.000Z",
  };
}

function storeSupplierAuditRecord(
  supplier: StoreSupplierMetadataRecord,
): StoreSupplierAuditRecord {
  return {
    auditId: "audit_000001",
    supplierId: supplier.supplierId,
    supplierSubjectId: supplier.supplierSubjectId,
    action: "supported_slots_updated",
    actor: "operator-1",
    beforeSupportedRoleSlotIds: ["slot-c"],
    afterSupportedRoleSlotIds: ["slot-c", "slot-b"],
    beforeSupportedStageIds: ["shipment"],
    afterSupportedStageIds: ["example", "shipment"],
    reviewStatus: "approved_for_broadcast",
    createdAt: "2026-04-28T00:00:05.000Z",
  };
}

function storeDockingSession(): StoreDockingSessionDTO {
  return {
    sessionId: "dock_durable",
    status: "valid",
    createdBy: "0x1234567890123456789012345678901234567890",
    source: {
      zhixuId: "source-zhixu",
      title: "Source Zhixu",
      lifecycleStatus: "active",
      publicationStatus: "published",
      planId,
      planHash,
    },
    target: {
      zhixuId: "target-zhixu",
      title: "Target Zhixu",
      lifecycleStatus: "active",
      publicationStatus: "published",
      planId:
        "0x0000000000000000000000000000000000000000000000000000000000000202",
      planHash:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    interfaces: [
      {
        interfaceName: "fulfillment_service",
        orderModes: ["new"],
        inputs: [{ portName: "execute", label: "执行入口", hook: "intake#EXECUTE" }],
        outputs: [{ portName: "completed", label: "完成", signal: "target::intake.cmp" }],
      },
    ],
    selectedInterfaceName: "fulfillment_service",
    orderMode: "new",
    candidateMappings: [],
    draftSignalMap: [
      {
        entryId: "map_1",
        bindingKind: "input",
        sourceSignalId: "source.done",
        targetSignalId: "target.start",
        note: "Durable draft map",
      },
    ],
    validation: {
      ok: true,
      errors: [],
      checkedAt: "2026-04-28T00:00:06.000Z",
      nonPublishing: true,
    },
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:06.000Z",
  };
}

function migrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

function postgresMigrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations/postgres", import.meta.url));
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
): ChainEvent {
  return {
    chainId,
    contractAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args,
  };
}
