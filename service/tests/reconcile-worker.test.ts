import { describe, expect, it } from "vitest";
import {
  ORDER_INITIAL_TRIGGER_PERMISSION_ID,
  ORDER_INITIAL_TRIGGER_SIGNAL_NAME,
  ORDER_INITIAL_TRIGGER_SOURCE,
  ORDER_REGISTRAR_ROLE_SLOT_ID,
  ORDER_SYSTEM_STAGE_ID
} from "@uvp-eth/product-dto";
import { InMemoryGovernanceStore, type PlanAttestationLogDTO } from "../src/governance/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import {
  PRODUCT_INITIAL_TRIGGER_SIGNAL_ID,
  PRODUCT_INITIAL_TRIGGER_SOURCE_ID
} from "../src/product/bff/registration.js";
import { MemoryProductBffStore } from "../src/product/bff/store.js";
import type {
  ProductOrderDraftDTO,
  ProductOrderRegistrationRecord,
  ProductOrderStartDTO
} from "../src/product/bff/types.js";
import { TxReconcileWorker, type ReconcileReceipt, type ReconcileReceiptClient } from "../src/reconcile/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { InMemoryProductSubmissionStore, type ProductSubmissionDTO } from "../src/submissions/index.js";
import type { Address, Hex } from "../src/shared/types.js";

const baseNow = new Date("2026-04-28T00:00:00Z");
const contractAddress = address("1111");
const creator = address("2222");
const submitter = address("3333");
const attester = address("4444");
const gasPayer = address("9999");
const orderId = bytes32("1001");
const planId = bytes32("2001");
const planHash = bytes32("2002");
const artifactHash = bytes32("2003");
const policyHash = bytes32("2004");
const metadataHash = bytes32("2005");
const sourceId = bytes32("3001");
const signalId = bytes32("3002");
const payloadHash = bytes32("3003");
const idempotencyKey = bytes32("3004");
const domainId = bytes32("4001");

describe("tx/indexer reconcile worker", () => {
  it("keeps receipt-missing registrations pending, then confirms after OrderRegistered projection appears", async () => {
    const projectionStore = new MemoryProjectionStore();
    const productStore = new MemoryProductBffStore();
    const receipts = new Map<Hex, ReconcileReceipt | undefined>();
    const txHash = bytes32("aaaa");
    await productStore.createDraft(draftFixture(), []);
    await productStore.createRegistration(registrationFixture({ txHash }));
    const worker = workerFixture({ projectionStore, productStore, receipts });

    await worker.runOnce();
    await expect(productStore.getRegistration("registration_1")).resolves.toMatchObject({
      status: "pending",
      reconcileStatus: "submitted",
      receiptStatus: "missing",
      projectionStatus: "not_checked"
    });

    receipts.set(txHash, { status: "success", blockNumber: 10n });
    await worker.runOnce();
    await expect(productStore.getRegistration("registration_1")).resolves.toMatchObject({
      status: "indexing",
      blockNumber: "10",
      reconcileStatus: "indexing",
      receiptStatus: "success",
      projectionStatus: "missing"
    });

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(10n, txHash, 0, "OrderRegistered", { orderId, planId })]
    });
    await worker.runOnce();

    await expect(productStore.getRegistration("registration_1")).resolves.toMatchObject({
      status: "confirmed",
      reconcileStatus: "confirmed",
      receiptStatus: "success",
      projectionStatus: "present"
    });
    await expect(productStore.getDraft("draft_1")).resolves.toMatchObject({
      status: "registered",
      registeredOrderId: orderId,
      registrationTxHash: txHash
    });
  });

  it("confirms tx-backed registrations from matching OrderRegistered projection even when receipt lookup is missing", async () => {
    const projectionStore = new MemoryProjectionStore();
    const productStore = new MemoryProductBffStore();
    const txHash = bytes32("a111");
    const mismatchedTxHash = bytes32("a222");
    await productStore.createDraft(draftFixture(), []);
    await productStore.createRegistration(registrationFixture({ txHash }));
    await productStore.createRegistration(registrationFixture({
      registrationId: "registration_mismatch",
      txHash: mismatchedTxHash
    }));
    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(11n, txHash, 0, "OrderRegistered", { orderId, planId })]
    });
    const worker = workerFixture({ projectionStore, productStore, receipts: new Map() });

    const summary = await worker.runOnce();

    expect(summary.registrationsChecked).toBe(2);
    await expect(productStore.getRegistration("registration_1")).resolves.toMatchObject({
      status: "confirmed",
      blockNumber: "11",
      reconcileStatus: "confirmed",
      receiptStatus: "success",
      projectionStatus: "present"
    });
    await expect(productStore.getRegistration("registration_mismatch")).resolves.toMatchObject({
      status: "pending",
      reconcileStatus: "submitted",
      receiptStatus: "missing",
      projectionStatus: "not_checked"
    });
  });

  it("moves submissions through indexing, confirmed, and failed receipt states", async () => {
    const projectionStore = new MemoryProjectionStore();
    const submissionStore = new InMemoryProductSubmissionStore();
    const successTx = bytes32("bbbb");
    const failedTx = bytes32("cccc");
    const receipts = new Map<Hex, ReconcileReceipt | undefined>([
      [successTx, { status: "success", blockNumber: 20n }],
      [failedTx, { status: "reverted", blockNumber: 21n }]
    ]);
    await submissionStore.putSubmission(submissionFixture({ submissionId: "sub_success", txHash: successTx }));
    await submissionStore.putSubmission(submissionFixture({ submissionId: "sub_failed", txHash: failedTx }));
    const worker = workerFixture({ projectionStore, submissionStore, receipts });

    await worker.runOnce();
    await expect(submissionStore.getSubmission("sub_success")).resolves.toMatchObject({
      status: "indexing",
      blockNumber: "20",
      reconcileStatus: "indexing",
      receiptStatus: "success",
      projectionStatus: "missing"
    });
    await expect(submissionStore.getSubmission("sub_failed")).resolves.toMatchObject({
      status: "failed",
      blockNumber: "21",
      errorCode: "transaction_reverted",
      receiptStatus: "failed"
    });

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(20n, successTx, 0, "SignalSubmitted", {
        orderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter
      })]
    });
    await worker.runOnce();

    await expect(submissionStore.getSubmission("sub_success")).resolves.toMatchObject({
      status: "confirmed",
      broadcastStatus: "confirmed",
      reconcileStatus: "confirmed",
      projectionStatus: "present",
      attempts: [expect.objectContaining({ status: "confirmed", txHash: successTx })]
    });
  });

  it("confirms product order starts after OUTSIDE SignalSubmitted projection appears", async () => {
    const projectionStore = new MemoryProjectionStore();
    const productStore = new MemoryProductBffStore();
    const txHash = bytes32("b0b0");
    const receipts = new Map<Hex, ReconcileReceipt | undefined>([
      [txHash, { status: "success", blockNumber: 40n }]
    ]);
    await productStore.createRegistration(registrationFixture({
      authorizations: [initialTriggerAuthorization()]
    }));
    await productStore.createOrderStart(orderStartFixture({ txHash }));
    const worker = workerFixture({ projectionStore, productStore, receipts });

    await worker.runOnce();
    await expect(productStore.getOrderStartByRegistrationId("registration_1")).resolves.toMatchObject({
      status: "indexing",
      blockNumber: "40",
      reconcileStatus: "indexing",
      receiptStatus: "success",
      projectionStatus: "missing"
    });

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(40n, txHash, 0, "SignalSubmitted", {
        orderId,
        sourceId: PRODUCT_INITIAL_TRIGGER_SOURCE_ID,
        signalId: PRODUCT_INITIAL_TRIGGER_SIGNAL_ID,
        payloadHash,
        idempotencyKey,
        submitter
      })]
    });
    const summary = await worker.runOnce();

    expect(summary.startsChecked).toBe(1);
    await expect(productStore.getOrderStartByRegistrationId("registration_1")).resolves.toMatchObject({
      status: "confirmed",
      reconcileStatus: "confirmed",
      receiptStatus: "success",
      projectionStatus: "present",
      blockNumber: "40"
    });
  });

  it("confirms governance tx logs only after the trust projection contains the expected event", async () => {
    const projectionStore = new MemoryProjectionStore();
    const governanceStore = new InMemoryGovernanceStore();
    const txHash = bytes32("dddd");
    const receipts = new Map<Hex, ReconcileReceipt | undefined>([
      [txHash, { status: "success", blockNumber: 30n }]
    ]);
    await governanceStore.appendPlanAttestationLog(planLogFixture({ txHash }));
    const worker = workerFixture({ projectionStore, governanceStore, receipts });

    await worker.runOnce();
    await expect(governanceStore.getTxLog("plan_log_1")).resolves.toMatchObject({
      status: "indexing",
      receiptStatus: "success",
      projectionStatus: "missing"
    });

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(30n, txHash, 0, "PlanAttested", {
        domainId,
        planId,
        planHash,
        artifactHash,
        policyHash,
        metadataHash,
        metadataURI: "uvp://metadata/plan",
        attester
      })]
    });
    await worker.runOnce();

    await expect(governanceStore.getTxLog("plan_log_1")).resolves.toMatchObject({
      status: "confirmed",
      broadcastStatus: "confirmed",
      reconcileStatus: "confirmed",
      receiptStatus: "success",
      projectionStatus: "present",
      blockNumber: "30"
    });
  });

  it("marks stale pending txs failed without deleting unknown records", async () => {
    const productStore = new MemoryProductBffStore();
    const projectionStore = new MemoryProjectionStore();
    await productStore.createRegistration(registrationFixture({
      registrationId: "registration_stale",
      txHash: bytes32("eeee"),
      createdAt: "2026-04-27T23:00:00Z"
    }));
    const worker = new TxReconcileWorker({
      config: { enabled: true, pollIntervalMs: 0, txTimeoutMs: 1_000 },
      receiptClient: receiptClient(new Map()),
      projectionStore,
      productStore,
      now: () => baseNow
    });

    await worker.runOnce();

    await expect(productStore.getRegistration("registration_stale")).resolves.toMatchObject({
      status: "failed",
      reconcileStatus: "stale_pending",
      receiptStatus: "timeout",
      errorCode: "tx_reconcile_timeout"
    });
  });
});

function workerFixture(input: {
  readonly projectionStore: MemoryProjectionStore;
  readonly receipts: Map<Hex, ReconcileReceipt | undefined>;
  readonly productStore?: MemoryProductBffStore;
  readonly submissionStore?: InMemoryProductSubmissionStore;
  readonly governanceStore?: InMemoryGovernanceStore;
}): TxReconcileWorker {
  return new TxReconcileWorker({
    config: { enabled: true, pollIntervalMs: 0, txTimeoutMs: 60_000 },
    receiptClient: receiptClient(input.receipts),
    projectionStore: input.projectionStore,
    ...(input.productStore ? { productStore: input.productStore } : {}),
    ...(input.submissionStore ? { submissionStore: input.submissionStore } : {}),
    ...(input.governanceStore ? { governanceStore: input.governanceStore } : {}),
    now: () => baseNow
  });
}

function receiptClient(receipts: Map<Hex, ReconcileReceipt | undefined>): ReconcileReceiptClient {
  return {
    async getTransactionReceipt(txHash) {
      return receipts.get(txHash);
    }
  };
}

function draftFixture(): ProductOrderDraftDTO {
  return {
    draftId: "draft_1",
    zhixuId: "zhixu_1",
    planId,
    planHash,
    title: "Draft",
    businessType: "trade",
    goods: [],
    totalAmount: "1",
    currency: "USDC",
    status: "registering",
    createdBy: creator,
    createdAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString()
  };
}

function registrationFixture(input: {
  readonly registrationId?: string;
  readonly txHash?: Hex;
  readonly createdAt?: string;
  readonly authorizations?: ProductOrderRegistrationRecord["authorizations"];
  readonly permissions?: ProductOrderRegistrationRecord["permissions"];
} = {}): ProductOrderRegistrationRecord {
  const createdAt = input.createdAt ?? baseNow.toISOString();
  const authorizations = input.authorizations ?? [];
  const permissions = input.permissions ?? (
    authorizations.some((authorization) =>
      authorization.sourceId === PRODUCT_INITIAL_TRIGGER_SOURCE_ID &&
      authorization.signalId === PRODUCT_INITIAL_TRIGGER_SIGNAL_ID
    )
      ? [initialTriggerPermission()]
      : []
  );
  return {
    registrationId: input.registrationId ?? "registration_1",
    draftId: "draft_1",
    orderId,
    planId,
    planHash,
    status: "pending",
    ...(input.txHash ? { txHash: input.txHash } : {}),
    retryable: false,
    createdAt,
    updatedAt: createdAt,
    creator,
    authorizations,
    permissions
  };
}

function orderStartFixture(input: { readonly txHash: Hex }): ProductOrderStartDTO {
  return {
    startId: "start_1",
    registrationId: "registration_1",
    draftId: "draft_1",
    orderId,
    status: "submitted",
    txHash: input.txHash,
    retryable: false,
    createdAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString()
  };
}

function initialTriggerAuthorization(): ProductOrderRegistrationRecord["authorizations"][number] {
  return {
    sourceId: PRODUCT_INITIAL_TRIGGER_SOURCE_ID,
    signalId: PRODUCT_INITIAL_TRIGGER_SIGNAL_ID,
    submitter,
    role: bytes32("6001"),
    metadataHash: metadataHash
  };
}

function initialTriggerPermission(): ProductOrderRegistrationRecord["permissions"][number] {
  return {
    permissionId: ORDER_INITIAL_TRIGGER_PERMISSION_ID,
    draftId: "draft_1",
    participantId: ORDER_REGISTRAR_ROLE_SLOT_ID,
    roleSlotId: ORDER_REGISTRAR_ROLE_SLOT_ID,
    stageIdentifier: ORDER_SYSTEM_STAGE_ID,
    source: ORDER_INITIAL_TRIGGER_SOURCE,
    signalName: ORDER_INITIAL_TRIGGER_SIGNAL_NAME,
    submitterAddress: submitter,
    payloadPolicy: "optional",
    requiredEvidence: []
  };
}

function submissionFixture(input: {
  readonly submissionId: string;
  readonly txHash: Hex;
}): ProductSubmissionDTO {
  return {
    submissionId: input.submissionId,
    prepareId: `${input.submissionId}_prepare`,
    taskId: `${orderId}:${sourceId}`,
    orderId,
    onchainOrderId: orderId,
    stageIdentifier: "stage",
    signalName: "confirm_stage",
    sourceId,
    signalId,
    intent: "confirm_stage",
    payloadHash,
    payloadRef: "uvp://payload",
    idempotencyKey,
    submitter,
    nonce: "1",
    deadline: "1770000000",
    status: "submitted",
    signatureStatus: "signature_verified",
    signatureHash: bytes32("5001"),
    recoveredSubmitter: submitter,
    broadcastStatus: "submitted",
    txHash: input.txHash,
    retryable: false,
    retryState: "not_applicable",
    deadLetter: false,
    attempts: [{
      attemptId: `${input.submissionId}:1`,
      submissionId: input.submissionId,
      orderId,
      sourceId,
      signalId,
      submitter,
      txHash: input.txHash,
      status: "submitted",
      gasPayer,
      attemptNumber: 1,
      retryable: false,
      retryState: "not_applicable",
      deadLetter: false,
      createdAt: baseNow.toISOString(),
      updatedAt: baseNow.toISOString()
    }],
    attemptCount: 1,
    proofRows: [],
    createdAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString()
  };
}

function planLogFixture(input: { readonly txHash: Hex }): PlanAttestationLogDTO {
  return {
    logId: "plan_log_1",
    txLogId: "plan_log_1",
    action: "attest_plan",
    domainId,
    subjectId: planId,
    planId,
    planHash,
    artifactHash,
    policyHash,
    metadataHash,
    metadataURI: "uvp://metadata/plan",
    txHash: input.txHash,
    signer: attester,
    requester: "admin_1",
    status: "pending",
    broadcastStatus: "submitted",
    retryable: false,
    request: {
      kind: "attestPlan",
      domainId,
      planId,
      planHash,
      artifactHash,
      policyHash,
      metadataHash,
      metadataURI: "uvp://metadata/plan"
    },
    createdAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString()
  };
}

function chainEvent(
  blockNumber: bigint,
  transactionHash: Hex,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress,
    blockNumber,
    transactionHash,
    logIndex,
    eventName,
    args
  };
}

function bytes32(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}

function address(value: string): Address {
  return `0x${value.padStart(40, "0")}` as Address;
}
