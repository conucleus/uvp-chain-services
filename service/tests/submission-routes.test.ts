import { describe, expect, it } from "vitest";
import type { ProductTaskDTO } from "@uvp-eth/product-dto";
import { privateKeyToAccount } from "viem/accounts";
import { createApiRouter } from "../src/api/routes.js";
import {
  allowListedSubmissionAuthorization,
  createProductSubmissionService,
  type SubmissionBroadcastAdapter,
  type SubmissionBroadcastResult,
  type PreparedSubmissionDTO
} from "../src/submissions/index.js";
import { createEvidenceService, InMemoryEvidenceStorage } from "../src/evidence/index.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import { normalizeAddress, type Address, type Hex } from "../src/shared/types.js";

const privateKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const account = privateKeyToAccount(privateKey);
const submitter = normalizeAddress(account.address, "account.address");
const verifyingContract = "0x1111111111111111111111111111111111111111" as Address;

const routeTask: ProductTaskDTO = {
  taskId: "task-route",
  orderId: "order-route",
  orderTitle: "Route order",
  zhixuId: "zhixu-route",
  title: "Route submit",
  subtitle: "Route submit",
  assigneeRole: "customs",
  stageId: "customs-complete",
  stageName: "Customs complete",
  deadline: "2026-05-01",
  fundingImpact: "advance workflow",
  requiredEvidence: ["customs declaration"],
  status: "open",
  responsibilityStatements: [],
  proofRows: []
};

describe("submission API routes", () => {
  it("prepares, accepts a wallet signature, and serves submission status", async () => {
    const evidenceService = createEvidenceService({
      storage: new InMemoryEvidenceStorage(),
      now: () => new Date("2026-04-28T00:00:00Z"),
      evidenceIdFactory: () => "ev_route"
    });
    const submissionService = createProductSubmissionService({
      productTasks: { getTask: async (taskId) => taskId === routeTask.taskId ? routeTask : undefined },
      evidenceReader: evidenceService,
      chainId: 31337,
      verifyingContract,
      authorization: allowListedSubmissionAuthorization([{
        orderId: routeTask.orderId,
        stageIdentifier: routeTask.stageId,
        signalName: "confirm_stage",
        submitter
      }]),
      now: () => new Date("2026-04-28T00:00:00Z"),
      prepareIdFactory: () => "prep_route",
      submissionIdFactory: () => "sub_route",
      nonceFactory: () => "7"
    });
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", evidenceService, submissionService });

    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        orderId: routeTask.orderId,
        taskId: routeTask.taskId,
        stageIdentifier: routeTask.stageId,
        documentType: "customs-declaration",
        textPayload: "customs declaration",
        metadata: { fields: { declarationNo: "CD-1" } }
      }
    });
    expect(uploadResponse.status).toBe(201);
    const evidenceId = (uploadResponse.body as { evidence: { evidenceId: string } }).evidence.evidenceId;

    const prepareResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${routeTask.taskId}/prepare-submit`,
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        evidenceIds: [evidenceId],
        walletAddress: submitter,
        intent: "confirm_stage"
      }
    });
    expect(prepareResponse.status).toBe(201);
    const prepared = prepareResponse.body as PreparedSubmissionDTO;
    const signature = await account.signTypedData(
      prepared.typedData as unknown as Parameters<typeof account.signTypedData>[0]
    );

    const submitResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${routeTask.taskId}/submit`,
      body: {
        prepareId: prepared.prepareId,
        walletAddress: submitter,
        signature
      }
    });
    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body).toMatchObject({
      submissionId: "sub_route",
      status: "signature_received",
      broadcastStatus: "not_attempted",
      errorCode: "broadcast_disabled",
      retryState: "not_applicable",
      deadLetter: false
    });
    expect(JSON.stringify(submitResponse.body)).not.toContain(signature.slice(2));

    await expect(router.handle({
      method: "GET",
      pathname: "/product/submissions/sub_route"
    })).resolves.toMatchObject({
      status: 200,
      body: {
        submissionId: "sub_route",
        recoveredSubmitter: submitter
      }
    });
  });

  it("returns txHash when the injected submission broadcaster submits on-chain", async () => {
    const evidenceService = createEvidenceService({
      storage: new InMemoryEvidenceStorage(),
      now: () => new Date("2026-04-28T00:00:00Z"),
      evidenceIdFactory: () => "ev_broadcast"
    });
    const broadcast: SubmissionBroadcastAdapter = {
      broadcast: async (): Promise<SubmissionBroadcastResult> => ({
        status: "submitted",
        txHash: txHash("44"),
        blockNumber: "321",
        attempt: {
          status: "submitted",
          txHash: txHash("44"),
          gasPayer: "0x9999999999999999999999999999999999999999"
        }
      })
    };
    const submissionService = createProductSubmissionService({
      productTasks: { getTask: async (taskId) => taskId === routeTask.taskId ? routeTask : undefined },
      evidenceReader: evidenceService,
      chainId: 31337,
      verifyingContract,
      authorization: allowListedSubmissionAuthorization([{
        orderId: routeTask.orderId,
        stageIdentifier: routeTask.stageId,
        signalName: "confirm_stage",
        submitter
      }]),
      broadcastAdapter: broadcast,
      now: () => new Date("2026-04-28T00:00:00Z"),
      prepareIdFactory: () => "prep_broadcast",
      submissionIdFactory: () => "sub_broadcast",
      nonceFactory: () => "8"
    });
    const router = createApiRouter(new MemoryProjectionStore(), { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111", evidenceService, submissionService });

    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        orderId: routeTask.orderId,
        taskId: routeTask.taskId,
        stageIdentifier: routeTask.stageId,
        documentType: "customs-declaration",
        textPayload: "customs declaration",
        metadata: { fields: { declarationNo: "CD-2" } }
      }
    });
    const evidenceId = (uploadResponse.body as { evidence: { evidenceId: string } }).evidence.evidenceId;
    const prepareResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${routeTask.taskId}/prepare-submit`,
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        evidenceIds: [evidenceId],
        walletAddress: submitter,
        intent: "confirm_stage"
      }
    });
    const prepared = prepareResponse.body as PreparedSubmissionDTO;
    const signature = await account.signTypedData(
      prepared.typedData as unknown as Parameters<typeof account.signTypedData>[0]
    );

    await expect(router.handle({
      method: "POST",
      pathname: `/product/tasks/${routeTask.taskId}/submit`,
      body: {
        prepareId: prepared.prepareId,
        walletAddress: submitter,
        signature
      }
    })).resolves.toMatchObject({
      status: 200,
      body: {
        submissionId: "sub_broadcast",
        status: "submitted",
        broadcastStatus: "submitted",
        txHash: txHash("44"),
        blockNumber: "321",
        retryState: "not_applicable",
        deadLetter: false,
        attempts: [expect.objectContaining({
          orderId: prepared.onchainOrderId,
          sourceId: prepared.sourceId,
          signalId: prepared.signalId,
          submitter,
          gasPayer: "0x9999999999999999999999999999999999999999",
          retryable: false,
          retryState: "not_applicable",
          deadLetter: false
        })]
      }
    });
  });

  it("refreshes projections after tx-backed submission so order proof includes the submit signal tx", async () => {
    const orderId = bytes32("44");
    const planId = bytes32("45");
    const planHash = bytes32("46");
    const projectedTask: ProductTaskDTO = {
      ...routeTask,
      taskId: "task-projected-submit",
      orderId,
      stateMachineAddress: verifyingContract
    } as ProductTaskDTO;
    const evidenceService = createEvidenceService({
      storage: new InMemoryEvidenceStorage(),
      now: () => new Date("2026-04-28T00:00:00Z"),
      evidenceIdFactory: () => "ev_projected_submit"
    });
    const submitTxHash = txHash("55");
    const broadcast: SubmissionBroadcastAdapter = {
      broadcast: async (): Promise<SubmissionBroadcastResult> => ({
        status: "submitted",
        txHash: submitTxHash,
        blockNumber: "55",
        attempt: {
          status: "submitted",
          txHash: submitTxHash,
          blockNumber: "55",
          gasPayer: "0x9999999999999999999999999999999999999999"
        }
      })
    };
    const submissionService = createProductSubmissionService({
      productTasks: { getTask: async (taskId) => taskId === projectedTask.taskId ? projectedTask : undefined },
      evidenceReader: evidenceService,
      chainId: 31337,
      verifyingContract,
      authorization: allowListedSubmissionAuthorization([{
        orderId: projectedTask.orderId,
        stageIdentifier: projectedTask.stageId,
        signalName: "confirm_stage",
        submitter
      }]),
      broadcastAdapter: broadcast,
      now: () => new Date("2026-04-28T00:00:00Z"),
      prepareIdFactory: () => "prep_projected_submit",
      submissionIdFactory: () => "sub_projected_submit",
      nonceFactory: () => "9"
    });
    const projectionStore = new MemoryProjectionStore();
    const baseEvents = [
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 1n }),
      chainEvent(2n, 0, "OrderRegistered", { orderId, planId })
    ];
    await projectionStore.resetFromEvents({ deploymentBlock: 0n, events: baseEvents });
    let preparedForRefresh: PreparedSubmissionDTO | undefined;
    let refresh: Promise<unknown> | undefined;
    const router = createApiRouter(projectionStore, { submissionChainId: 84532, submissionVerifyingContract: "0x1111111111111111111111111111111111111111",
      evidenceService,
      submissionService,
      onTxMined: () => {
        if (!preparedForRefresh) {
          throw new Error("prepared submission missing before projection refresh");
        }
        refresh = projectionStore.resetFromEvents({
          deploymentBlock: 0n,
          events: [
            ...baseEvents,
            chainEvent(55n, 0, "SignalSubmitted", {
              orderId,
              sourceId: preparedForRefresh.sourceId,
              signalId: preparedForRefresh.signalId,
              payloadHash: preparedForRefresh.payloadHash,
              idempotencyKey: preparedForRefresh.idempotencyKey,
              submitter
            }, submitTxHash)
          ]
        });
      }
    });

    const uploadResponse = await router.handle({
      method: "POST",
      pathname: "/product/evidence",
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        orderId: projectedTask.orderId,
        taskId: projectedTask.taskId,
        stageIdentifier: projectedTask.stageId,
        documentType: "customs-declaration",
        textPayload: "customs declaration",
        metadata: { fields: { declarationNo: "CD-3" } }
      }
    });
    const evidenceId = (uploadResponse.body as { evidence: { evidenceId: string } }).evidence.evidenceId;
    const prepareResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${projectedTask.taskId}/prepare-submit`,
      headers: { "x-uvp-principal-id": "seller" },
      body: {
        evidenceIds: [evidenceId],
        walletAddress: submitter,
        intent: "confirm_stage"
      }
    });
    preparedForRefresh = prepareResponse.body as PreparedSubmissionDTO;
    const signature = await account.signTypedData(
      preparedForRefresh.typedData as unknown as Parameters<typeof account.signTypedData>[0]
    );

    const submitResponse = await router.handle({
      method: "POST",
      pathname: `/product/tasks/${projectedTask.taskId}/submit`,
      body: {
        prepareId: preparedForRefresh.prepareId,
        walletAddress: submitter,
        signature
      }
    });
    expect(submitResponse.status).toBe(200);
    expect(refresh).toBeDefined();
    await refresh;

    const proofResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}/proof`
    });

    expect(proofResponse.status).toBe(200);
    expect((proofResponse.body as { proof: Array<{ eventName: string; transactionHash: string }> }).proof)
      .toContainEqual(expect.objectContaining({
        eventName: "SignalSubmitted",
        transactionHash: submitTxHash
      }));
  });
});

function txHash(value: string): Hex {
  return `0x${value.padStart(64, "0")}`;
}

function bytes32(value: string): Hex {
  return `0x${value.padStart(64, "0")}`;
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  transactionHash: Hex = txHash(blockNumber.toString(16))
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: verifyingContract,
    blockNumber,
    transactionHash,
    logIndex,
    eventName,
    args
  };
}
