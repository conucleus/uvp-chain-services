import { describe, expect, it } from "vitest";
import { InMemoryGovernanceStore, type IdentityTxLogDTO } from "../src/governance/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProductBffStore } from "../src/product/bff/store.js";
import type {
  ProductOrderDraftDTO,
  ProductOrderTriggerRecord
} from "../src/product/bff/types.js";
import { TxReconcileWorker, type ReconcileReceipt, type ReconcileReceiptClient } from "../src/reconcile/index.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { InMemoryProductSubmissionStore, type ProductSubmissionDTO } from "../src/submissions/index.js";
import type { Address, Hex } from "../src/shared/types.js";

const baseNow = new Date("2026-04-28T00:00:00Z");
const contractAddress = address("1111");
const creator = address("2222");
const submitter = address("3333");
const gasPayer = address("9999");
const orderId = bytes32("1001");
const planId = bytes32("2001");
const planHash = bytes32("2002");
const metadataHash = bytes32("2005");
const sourceId = bytes32("3001");
const signalId = bytes32("3002");
const payloadHash = bytes32("3003");
const idempotencyKey = bytes32("3004");

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
      status: "submitted",
      reconcileStatus: "submitted",
      receiptStatus: "missing",
      projectionStatus: "not_checked",
      retryable: true
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
      status: "triggered"
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
      triggerId: "registration_mismatch",
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
      status: "submitted",
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
    const unknownTx = bytes32("dddd");
    const receipts = new Map<Hex, ReconcileReceipt | undefined>([
      [successTx, { status: "success", blockNumber: 20n }],
      [failedTx, { status: "reverted", blockNumber: 21n }],
      [unknownTx, { status: "pending", blockNumber: 22n }]
    ]);
    await submissionStore.putSubmission(submissionFixture({ submissionId: "sub_success", txHash: successTx }));
    await submissionStore.putSubmission(submissionFixture({ submissionId: "sub_failed", txHash: failedTx }));
    await submissionStore.putSubmission(submissionFixture({ submissionId: "sub_unknown", txHash: unknownTx }));
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
    await expect(submissionStore.getSubmission("sub_unknown")).resolves.toMatchObject({
      status: "submitted",
      blockNumber: "22",
      receiptStatus: "unknown",
      reconcileStatus: "submitted",
      retryable: true,
      deadLetter: false
    });

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(20n, successTx, 0, "SignalSubmitted", {
        planId,
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

  it("confirms identity registration after its event is projected", async () => {
    const projectionStore = new MemoryProjectionStore();
    const governanceStore = new InMemoryGovernanceStore();
    const txHash = bytes32("dddd");
    const receipts = new Map<Hex, ReconcileReceipt | undefined>([
      [txHash, { status: "success", blockNumber: 30n }]
    ]);
    await governanceStore.appendIdentityTxLog(identityLogFixture({ txHash }));
    const worker = workerFixture({ projectionStore, governanceStore, receipts });

    await worker.runOnce();
    await expect(governanceStore.getTxLog("identity_log_1")).resolves.toMatchObject({
      status: "indexing",
      receiptStatus: "success",
      projectionStatus: "missing"
    });

    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(30n, txHash, 0, "IdentityBindingRegistered", {
        bindingId: bytes32("2006"),
        subjectId: planId,
        account: submitter,
        descriptorHash: metadataHash,
        descriptorURI: "uvp-store://identities/acme",
        registrar: creator
      })]
    });
    await worker.runOnce();

    await expect(governanceStore.getTxLog("identity_log_1")).resolves.toMatchObject({
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
      triggerId: "registration_stale",
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

  it("keeps tx-less pending submissions in broadcasting instead of relabeling them submitted", async () => {
    // pending（无 txHash）= 仍在广播、回执未知：不得硬编码改标 submitted。
    const projectionStore = new MemoryProjectionStore();
    const submissionStore = new InMemoryProductSubmissionStore();
    await submissionStore.putSubmission(submissionFixture({
      submissionId: "sub_broadcasting",
      status: "broadcasting",
      broadcastStatus: "broadcasting"
    }));
    const worker = workerFixture({ projectionStore, submissionStore, receipts: new Map() });

    const summary = await worker.runOnce();

    expect(summary.submissionsChecked).toBe(1);
    await expect(submissionStore.getSubmission("sub_broadcasting")).resolves.toMatchObject({
      status: "broadcasting",
      broadcastStatus: "broadcasting",
      reconcileStatus: "broadcasting",
      receiptStatus: "not_checked"
    });
  });

  it("re-checks failed submissions that carry a txHash and self-heals on a successful receipt plus projection", async () => {
    // 带 txHash 的 failed 必须复核回执：链上真相（回执成功 + 投影呈现）
    // 推翻本地失败标记 → confirmed；无 txHash 的 failed 不进复扫。
    const projectionStore = new MemoryProjectionStore();
    const submissionStore = new InMemoryProductSubmissionStore();
    const healedTx = bytes32("bbbb");
    await submissionStore.putSubmission(submissionFixture({
      submissionId: "sub_failed_with_tx",
      txHash: healedTx,
      status: "failed",
      broadcastStatus: "failed"
    }));
    await submissionStore.putSubmission(submissionFixture({
      submissionId: "sub_failed_without_tx",
      status: "failed",
      broadcastStatus: "failed"
    }));
    const receipts = new Map<Hex, ReconcileReceipt | undefined>([
      [healedTx, { status: "success", blockNumber: 20n }]
    ]);
    const worker = workerFixture({ projectionStore, submissionStore, receipts });

    const summary = await worker.runOnce();
    // 只有带 txHash 的 failed 进复扫。
    expect(summary.submissionsChecked).toBe(1);

    // 回执未落地（map 命中前）时保持 failed，不虚报 submitted —— 这里直接
    // 推进到投影确认后断言自愈结果。
    await projectionStore.resetFromEvents({
      deploymentBlock: 0n,
      events: [chainEvent(20n, healedTx, 0, "SignalSubmitted", {
        planId,
        orderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey,
        submitter
      })]
    });
    await worker.runOnce();

    await expect(submissionStore.getSubmission("sub_failed_with_tx")).resolves.toMatchObject({
      status: "confirmed",
      broadcastStatus: "confirmed",
      reconcileStatus: "confirmed",
      receiptStatus: "success",
      projectionStatus: "present"
    });
    await expect(submissionStore.getSubmission("sub_failed_without_tx")).resolves.toMatchObject({
      status: "failed"
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
    status: "triggering",
    createdBy: creator,
    createdAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString()
  };
}

function registrationFixture(input: {
  readonly triggerId?: string;
  readonly txHash?: Hex;
  readonly createdAt?: string;
  readonly authorizations?: ProductOrderTriggerRecord["authorizations"];
  readonly permissions?: ProductOrderTriggerRecord["permissions"];
} = {}): ProductOrderTriggerRecord {
  const createdAt = input.createdAt ?? baseNow.toISOString();
  const authorizations = input.authorizations ?? [];
  const permissions = input.permissions ?? [];
  return {
    triggerId: input.triggerId ?? "registration_1",
    prepareId: "prepare_1",
    draftId: "draft_1",
    orderId,
    planId,
    planHash,
    status: "submitted",
    ...(input.txHash ? { txHash: input.txHash } : {}),
    submitter,
    sourceId,
    signalId,
    triggerHookId: bytes32("4001"),
    triggerStageId: bytes32("4002"),
    payloadHash,
    idempotencyKey,
    deadline: "1770000000",
    typedData: {},
    retryable: false,
    createdAt,
    updatedAt: createdAt,
    creator,
    authorizations,
    permissions
  };
}

function submissionFixture(input: {
  readonly submissionId: string;
  readonly txHash?: Hex;
  readonly status?: ProductSubmissionDTO["status"];
  readonly broadcastStatus?: ProductSubmissionDTO["broadcastStatus"];
}): ProductSubmissionDTO {
  const status = input.status ?? "submitted";
  return {
    submissionId: input.submissionId,
    prepareId: `${input.submissionId}_prepare`,
    taskId: `${orderId}:${sourceId}`,
    orderId,
    onchainOrderId: orderId,
    planId,
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
    status,
    signatureStatus: "signature_verified",
    signatureHash: bytes32("5001"),
    recoveredSubmitter: submitter,
    broadcastStatus: input.broadcastStatus ?? (input.txHash ? "submitted" : "broadcasting"),
    ...(input.txHash ? { txHash: input.txHash } : {}),
    retryable: false,
    retryState: "not_applicable",
    deadLetter: false,
    ...(input.txHash
      ? {
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
          attemptCount: 1
        }
      : { attempts: [], attemptCount: 0 }),
    proofRows: [],
    createdAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString()
  };
}

function identityLogFixture(input: { readonly txHash: Hex }): IdentityTxLogDTO {
  return {
    logId: "identity_log_1",
    txLogId: "identity_log_1",
    action: "register_identity",
    subjectId: planId,
    account: submitter,
    descriptorHash: metadataHash,
    descriptorURI: "uvp-store://identities/acme",
    txHash: input.txHash,
    signer: creator,
    requester: "admin_1",
    status: "pending",
    broadcastStatus: "submitted",
    retryable: false,
    request: {
      kind: "registerIdentity",
      subjectId: planId,
      account: submitter,
      descriptorHash: metadataHash,
      descriptorURI: "uvp-store://identities/acme"
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
