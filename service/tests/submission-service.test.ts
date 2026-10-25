import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProductTaskDTO } from "@uvp-eth/product-dto";
import { STATE_MACHINE_ABI } from "@uvp-eth/protocol-bindings";
import { capabilitiesRootOf } from "@uvp-eth/compiler";
import { privateKeyToAccount } from "viem/accounts";
import { resolvePlanCapabilityTablesFromStore } from "../src/submissions/capability-proofs.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";

let stores: ChainServicesStores;
let submissionDatabaseUrl: string;

beforeAll(async () => {
  submissionDatabaseUrl = await createPostgresTestDatabase();
  stores = createChainServicesStores({
    database: { url: submissionDatabaseUrl, migrationsAutoRun: true },
    chainId: 31337
  });
});

afterAll(async () => {
  await stores.close();
});

function evidenceStorageFixture(): LocalEvidenceStorage {
  return new LocalEvidenceStorage({ rootDir: mkdtempSync(join(tmpdir(), "uvp-submission-evidence-")) });
}
import type { ChainEvent } from "../src/indexer/events.js";
import {
  allowListedSubmissionAuthorization,
  createSecureSubmissionBroadcastAdapter,
  createStateMachineSubmissionBroadcastAdapter,
  createProductSubmissionService,
  InMemoryProductSubmissionStore,
  permissiveProductProjectionAuthorization,
  PostgresBroadcastDedupeStore,
  type PreparedSubmissionDTO,
  type ProductSubmissionService,
  type ProductSubmissionStore,
  type StateMachineSubmitSignalForCall,
  type SubmissionBroadcastAdapter,
  type SubmissionBroadcastRequest,
  type SubmissionBroadcastResult
} from "../src/submissions/index.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-store.js";
import {
  createEvidenceService,
  InMemoryEvidenceMetadataStore,
  LocalEvidenceStorage,
  type EvidencePrincipal,
  type EvidenceService,
  type EvidenceUploadResponseDTO
} from "../src/evidence/index.js";
import { InMemoryAuditSink } from "../src/security/index.js";
import { normalizeAddress, type Address, type Hex } from "../src/shared/types.js";

const privateKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const account = privateKeyToAccount(privateKey);
const submitter = normalizeAddress(account.address, "account.address");
const verifyingContract = "0x1111111111111111111111111111111111111111" as Address;
const planId = "0x7777777777777777777777777777777777777777777777777777777777777777" as Hex;
const zeroPlanId = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const chainId = 31337;
const owner: EvidencePrincipal = { id: submitter.toLowerCase(), role: "participant" };
const baseNow = new Date("2026-04-28T00:00:00Z");

const fixtureOnchainOrderId = "0x0000000000000000000000000000000000000000000000000000000000000301" as Hex;
const fixtureSourceId = "0x0000000000000000000000000000000000000000000000000000000000000401" as Hex;
const fixtureSignalId = "0x0000000000000000000000000000000000000000000000000000000000000501" as Hex;

const task = {
  taskId: "task-1",
  orderId: fixtureOnchainOrderId,
  orderTitle: "Order 1",
  zhixuId: "zhixu-1",
  title: "Confirm example",
  subtitle: "Upload example evidence",
  assigneeRole: "example",
  stageId: "example-complete",
  stageName: "Example complete",
  deadline: "2026-05-01",
  fundingImpact: "advance workflow",
  status: "open",
  responsibilityStatements: [],
  proofRows: [],
  proof: {
    eventId: `${verifyingContract}:10:0`,
    chainId,
    contractAddress: verifyingContract,
    blockNumber: "10",
    transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000021",
    logIndex: 0,
    eventName: "HookReady",
    proofKind: "chain",
    args: {},
    sourceId: fixtureSourceId,
    signalId: fixtureSignalId,
    stageIdentifier: "example-complete"
  }
} as unknown as ProductTaskDTO;

describe("product task submissions", () => {
  it("refuses to prepare when the projection supplies no chain signal identity instead of fabricating one", async () => {
    const strippedTask = { ...task, proof: undefined, orderId: "business-order-1" } as unknown as ProductTaskDTO;
    const fixture = await submissionFixture({ task: strippedTask });

    await expect(fixture.service.prepareSubmit(strippedTask.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "order_plan_unresolved",
      status: 409
    });

    const overlayOnlyTask = {
      ...task,
      proof: { stageIdentifier: txHash("516") }
    } as unknown as ProductTaskDTO;
    const overlayFixture = await submissionFixture({ task: overlayOnlyTask });
    await expect(overlayFixture.service.prepareSubmit(overlayOnlyTask.taskId, {
      evidenceIds: [overlayFixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "order_plan_unresolved",
      status: 409
    });
  });

  it("does not authorize permissively when no authorization adapter is configured", async () => {
    const evidenceService = createEvidenceService({
    runtimeEnvironment: "local",
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage: evidenceStorageFixture(),
      now: () => baseNow,
      evidenceIdFactory: () => "ev_no_auth"
    });
    const evidence = await evidenceService.uploadEvidence({
      orderId: task.orderId,
      taskId: task.taskId,
      stageIdentifier: task.stageId,
      documentType: "example-declaration",
      fileName: "example.txt",
      textPayload: "example declaration",
      metadata: {
        businessLabel: "Example declaration",
        fields: { declarationNo: "CD-NO-AUTH" }
      }
    }, owner);
    const service = createProductSubmissionService({
      store: new InMemoryProductSubmissionStore(),
      productTasks: {
        getTask: async (taskId) => taskId === task.taskId ? task : undefined
      },
      evidenceReader: evidenceService,
      chainId,
      verifyingContract,
      now: () => baseNow
    });

    await expect(service.prepareSubmit(task.taskId, {
      evidenceIds: [evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "submitter_not_authorized",
      status: 403,
      details: {
        source: "authorization_not_configured"
      }
    });
  });

  it("allows permissive authorization only when explicitly injected", async () => {
    const fixture = await submissionFixture({
      authorization: permissiveProductProjectionAuthorization()
    });

    await expect(fixture.service.prepareSubmit(task.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).resolves.toMatchObject({
      authorization: {
        source: "product_projection_demo"
      }
    });
  });

  it("builds stable EIP-712 typed data for prepared wallet submit", async () => {
    const fixture = await submissionFixture();
    const prepared = await fixture.service.prepareSubmit(task.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner);

    const deadline = Math.floor(baseNow.getTime() / 1000) + 600;
    expect(prepared).toMatchObject({
      prepareId: "prep_1",
      status: "prepared",
      taskId: task.taskId,
      orderId: task.orderId,
      onchainOrderId: prepared.typedData.message.orderId,
      stageIdentifier: task.stageId,
      signalName: "confirm_stage",
      sourceId: fixtureSourceId,
      signalId: fixtureSignalId,
      payloadHash: fixture.evidence.evidence.payloadHash,
      payloadRef: fixture.evidence.evidence.payloadRef,
      idempotencyKey: prepared.typedData.message.idempotencyKey,
      submitter,
      nonce: "42",
      deadline: deadline.toString(),
      typedData: {
        domain: {
          name: "UVPStateMachine",
          version: "0.15",
          chainId,
          verifyingContract
        },
        primaryType: "UVPStateMachineSignal",
        message: {
          planId,
          orderId: prepared.onchainOrderId,
          sourceId: prepared.sourceId,
          signalId: prepared.signalId,
          payloadHash: fixture.evidence.evidence.payloadHash,
          idempotencyKey: prepared.idempotencyKey,
          submitter,
          deadline: deadline.toString()
        }
      }
    });
    expect(prepared.typedData.types.UVPStateMachineSignal.map((field) => field.name)).toEqual([
      "planId",
      "orderId",
      "sourceId",
      "signalId",
      "payloadHash",
      "idempotencyKey",
      "submitter",
      "deadline"
    ]);
    expect(prepared.planId).toBe(planId);
  });

  it("refuses to prepare when the projection cannot supply the order planId", async () => {
    const fixture = await submissionFixture({
      authorization: permissiveProductProjectionAuthorization()
    });
    const service = createProductSubmissionService({
      store: new InMemoryProductSubmissionStore(),
      productTasks: {
        getTask: async (taskId) => taskId === task.taskId ? task : undefined
      },
      evidenceReader: fixture.evidenceService,
      chainId,
      verifyingContract,
      resolveOrderPlanId: async () => undefined,
      authorization: permissiveProductProjectionAuthorization(),
      now: () => baseNow
    });

    await expect(service.prepareSubmit(task.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "order_plan_unresolved",
      status: 409
    });

    const zeroService = createProductSubmissionService({
      store: new InMemoryProductSubmissionStore(),
      productTasks: {
        getTask: async (taskId) => taskId === task.taskId ? task : undefined
      },
      evidenceReader: fixture.evidenceService,
      chainId,
      verifyingContract,
      resolveOrderPlanId: async () => zeroPlanId,
      authorization: permissiveProductProjectionAuthorization(),
      now: () => baseNow
    });
    await expect(zeroService.prepareSubmit(task.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "order_plan_unresolved",
      status: 409
    });
  });

  it("fails prepare loudly when the plan capability-table resolver throws instead of minting zero proofs", async () => {
    const base = await submissionFixture({
      authorization: permissiveProductProjectionAuthorization()
    });
    const resolverFailure = new Error("projection snapshot unreadable");
    const failing = createProductSubmissionService({
      store: new InMemoryProductSubmissionStore(),
      productTasks: {
        getTask: async (taskId) => taskId === task.taskId ? task : undefined
      },
      evidenceReader: base.evidenceService,
      chainId,
      verifyingContract,
      resolveOrderPlanId: async () => planId,
      resolvePlanCapabilityTables: async () => {
        throw resolverFailure;
      },
      authorization: permissiveProductProjectionAuthorization(),
      now: () => baseNow
    });

    await expect(failing.prepareSubmit(task.taskId, {
      evidenceIds: [base.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "capability_tables_unavailable",
      status: 409
    });

    const externalPlan = createProductSubmissionService({
      store: new InMemoryProductSubmissionStore(),
      productTasks: {
        getTask: async (taskId) => taskId === task.taskId ? task : undefined
      },
      evidenceReader: base.evidenceService,
      chainId,
      verifyingContract,
      resolveOrderPlanId: async () => planId,
      resolvePlanCapabilityTables: async () => undefined,
      authorization: permissiveProductProjectionAuthorization(),
      now: () => baseNow
    });
    await expect(externalPlan.prepareSubmit(task.taskId, {
      evidenceIds: [base.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).resolves.toMatchObject({ status: "prepared" });
  });

  it("refuses zero-proof minting when the persisted plan snapshot carries the failed enrichment marker", async () => {
    const fixture = await submissionFixture({
      authorization: permissiveProductProjectionAuthorization()
    });
    const planHash = "0x8888888888888888888888888888888888888888888888888888888888888888" as Hex;
    const selectorBindings = [{ selectorStageId: fixtureSourceId, targetStageId: fixtureSourceId }];
    const signalCapabilities = [{
      stageId: fixtureSourceId,
      targetSourceId: fixtureSourceId,
      signalId: fixtureSignalId,
      targetOrderRelation: 0 as const
    }];
    const capabilitiesRoot = capabilitiesRootOf(selectorBindings, signalCapabilities);
    const planEvents: readonly ChainEvent[] = [
      chainPlanEvent(1n, 0, "PlanCommitted", {
        planId, planHash, publisher: submitter,
        hooksHash: zeroBytes32(), capabilitiesRoot, hookCount: 1n,
        dockRoutesRoot: zeroBytes32(), dockInterfaceRoot: zeroBytes32()
      }),
      chainPlanEvent(2n, 0, "PlanFinalized", { planId, planHash, capabilitiesRoot }),
      chainPlanEvent(2n, 1, "PlanRegistered", { planId, planHash, hookCount: 1n })
    ];
    const store = stores.projectionStore;
    const serviceForStore = () => createProductSubmissionService({
      store: new InMemoryProductSubmissionStore(),
      productTasks: {
        getTask: async (taskId) => taskId === task.taskId ? task : undefined
      },
      evidenceReader: fixture.evidenceService,
      chainId,
      verifyingContract,
      resolveOrderPlanId: async () => planId,
      resolvePlanCapabilityTables: resolvePlanCapabilityTablesFromStore(store),
      authorization: permissiveProductProjectionAuthorization(),
      now: () => baseNow
    });

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: planEvents,
      planCapabilityResolutionFailures: [planId]
    });
    await expect(serviceForStore().prepareSubmit(task.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "capability_tables_unavailable",
      status: 409
    });

    await store.resetFromEvents({ deploymentBlock: 0n, events: planEvents });
    await expect(serviceForStore().prepareSubmit(task.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).resolves.toMatchObject({ status: "prepared" });

    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: planEvents,
      planCapabilityTables: [{ planId, planHash, selectorBindings, signalCapabilities }]
    });
    await expect(serviceForStore().prepareSubmit(task.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).resolves.toMatchObject({ status: "prepared" });
  });

  it("recovers and verifies the submitter signature without broadcasting by default", async () => {
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(submission).toMatchObject({
      submissionId: "sub_1",
      status: "signature_received",
      signatureStatus: "signature_verified",
      recoveredSubmitter: submitter,
      broadcastStatus: "not_attempted",
      errorCode: "broadcast_disabled",
      retryable: false,
      retryState: "not_applicable",
      deadLetter: false,
      attempts: [],
      attemptCount: 0
    });
    expect(submission.signatureHash).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(fixture.evidenceService.getEvidence(fixture.evidence.evidence.evidenceId, owner))
      .resolves.toMatchObject({
        evidence: {
          status: "uploaded"
        }
      });
  });

  it("rejects a signature from the wrong signer", async () => {
    const wrongAccount = privateKeyToAccount("0x2222222222222222222222222222222222222222222222222222222222222222");
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await wrongAccount.signTypedData(
      prepared.typedData as unknown as Parameters<typeof wrongAccount.signTypedData>[0]
    );

    await expect(fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).rejects.toMatchObject({
      code: "invalid_signature",
      status: 400
    });
  });

  it("marks an expired prepared submission and does not call broadcast", async () => {
    let current = new Date("2026-04-28T00:00:00Z");
    const broadcast: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({ status: "submitted" as const, txHash: txHash("1") }))
    };
    const fixture = await submissionFixture({
      now: () => current,
      broadcastAdapter: broadcast
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    current = new Date("2026-04-28T00:11:00Z");

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(submission).toMatchObject({
      status: "expired",
      signatureStatus: "signature_verified",
      recoveredSubmitter: submitter,
      broadcastStatus: "not_attempted",
      errorCode: "submission_expired"
    });
    expect(submission.signatureHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(broadcast.broadcast).not.toHaveBeenCalled();
  });

  it("probes the chain before expiring a TTL-dead retry and recovers the on-chain submission", async () => {
    let current = new Date("2026-04-28T00:00:00Z");
    const broadcast: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({ status: "submitted" as const, txHash: txHash("1") }))
    };
    const fixture = await submissionFixture({
      now: () => current,
      broadcastAdapter: broadcast,
      probePriorSubmissionOnChain: async () => ({
        outcome: "confirmed",
        txHash: txHash("7"),
        blockNumber: "31"
      })
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    current = new Date("2026-04-28T00:11:00Z");

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(submission).toMatchObject({
      status: "confirmed",
      broadcastStatus: "confirmed",
      txHash: txHash("7"),
      blockNumber: "31",
      signatureStatus: "signature_verified"
    });
    expect(broadcast.broadcast).not.toHaveBeenCalled();
    await expect(fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).rejects.toMatchObject({ code: "prepare_already_used", status: 409 });
  });

  it("keeps expiring a TTL-dead retry when the chain probe finds no business submission", async () => {
    let current = new Date("2026-04-28T00:00:00Z");
    const broadcast: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({ status: "submitted" as const, txHash: txHash("1") }))
    };
    const fixture = await submissionFixture({
      now: () => current,
      broadcastAdapter: broadcast,
      probePriorSubmissionOnChain: async () => ({ outcome: "absent" })
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    current = new Date("2026-04-28T00:11:00Z");

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(submission).toMatchObject({
      status: "expired",
      errorCode: "submission_expired",
      broadcastStatus: "not_attempted"
    });
    expect(broadcast.broadcast).not.toHaveBeenCalled();
  });

  it("treats a failing chain probe on a TTL-dead retry as retryable instead of expiring", async () => {
    let current = new Date("2026-04-28T00:00:00Z");
    const broadcast: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({ status: "submitted" as const, txHash: txHash("1") }))
    };
    const probeResults: Array<{ outcome: "unknown" } | { outcome: "confirmed"; txHash: Hex; blockNumber?: string }> = [
      { outcome: "unknown" },
      { outcome: "unknown" },
      { outcome: "confirmed", txHash: txHash("8"), blockNumber: "32" }
    ];
    const fixture = await submissionFixture({
      now: () => current,
      broadcastAdapter: broadcast,
      probePriorSubmissionOnChain: async () => {
        const next = probeResults.shift();
        if (!next) {
          throw new Error("no scripted probe outcome");
        }
        if (next.outcome === "unknown") {
          throw new Error("projection store transport down");
        }
        return next;
      }
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    current = new Date("2026-04-28T00:11:00Z");

    const first = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });
    expect(first).toMatchObject({
      status: "failed",
      errorCode: "transaction_receipt_unknown",
      retryable: true,
      retryState: "retryable",
      deadLetter: false,
      broadcastStatus: "failed"
    });

    const recovered = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });
    expect(recovered).toMatchObject({
      status: "failed",
      errorCode: "transaction_receipt_unknown"
    });
    const healed = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });
    expect(healed).toMatchObject({
      status: "confirmed",
      txHash: txHash("8"),
      blockNumber: "32"
    });
    expect(broadcast.broadcast).not.toHaveBeenCalled();
  });

  it("keeps the prepared signal reusable when broadcasting is disabled and rejects duplicates when it is not", async () => {
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const first = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });
    expect(first).toMatchObject({
      status: "signature_received",
      broadcastStatus: "not_attempted"
    });

    await expect(fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).resolves.toMatchObject({
      status: "signature_received",
      broadcastStatus: "not_attempted"
    });

    const broadcastingFixture = await submissionFixture({
      broadcastAdapter: {
        async broadcast() {
          return { status: "submitted" as const, txHash: txHash("9"), blockNumber: "1" };
        }
      }
    });
    const broadcastingPrepared = await prepare(broadcastingFixture);
    const broadcastingSignature = await signPrepared(broadcastingPrepared);
    await broadcastingFixture.service.submit(task.taskId, {
      prepareId: broadcastingPrepared.prepareId,
      walletAddress: submitter,
      signature: broadcastingSignature
    });
    await expect(broadcastingFixture.service.submit(task.taskId, {
      prepareId: broadcastingPrepared.prepareId,
      walletAddress: submitter,
      signature: broadcastingSignature
    })).rejects.toMatchObject({
      code: "prepare_already_used",
      status: 409
    });
  });

  it("keeps the prepared signal reusable on the durable postgres store when broadcasting is disabled", async () => {
    const store = new PostgresSubmissionStore({
      databaseUrl: submissionDatabaseUrl
    });
    try {
      const fixture = await submissionFixture({ store });
      const prepared = await prepare(fixture);
      const signature = await signPrepared(prepared);

      const first = await fixture.service.submit(task.taskId, {
        prepareId: prepared.prepareId,
        walletAddress: submitter,
        signature
      });
      expect(first).toMatchObject({
        status: "signature_received",
        broadcastStatus: "not_attempted"
      });

      await expect(fixture.service.submit(task.taskId, {
        prepareId: prepared.prepareId,
        walletAddress: submitter,
        signature
      })).resolves.toMatchObject({
        status: "signature_received",
        broadcastStatus: "not_attempted"
      });

      const broadcastingFixture = await submissionFixture({
        store,
        broadcastAdapter: {
          async broadcast() {
            return { status: "submitted" as const, txHash: txHash("10"), blockNumber: "1" };
          }
        }
      });
      const broadcastingPrepared = await prepare(broadcastingFixture);
      const broadcastingSignature = await signPrepared(broadcastingPrepared);
      await broadcastingFixture.service.submit(task.taskId, {
        prepareId: broadcastingPrepared.prepareId,
        walletAddress: submitter,
        signature: broadcastingSignature
      });
      await expect(broadcastingFixture.service.submit(task.taskId, {
        prepareId: broadcastingPrepared.prepareId,
        walletAddress: submitter,
        signature: broadcastingSignature
      })).rejects.toMatchObject({
        code: "prepare_already_used",
        status: 409
      });
    } finally {
      await store.close();
    }
  });

  it("rejects a submitter that is not authorized for the task signal", async () => {
    const fixture = await submissionFixture({
      authorizedSubmitter: "0x2222222222222222222222222222222222222222"
    });

    await expect(fixture.service.prepareSubmit(task.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "submitter_not_authorized",
      status: 403
    });
  });

  it("lets an explicitly authorized submitter pass even when an overlay names another active executor", async () => {
    const targetStageId = txHash("515");
    const overlayTask = {
      ...task,
      stageExecutorOverlay: {
        targetStageId,
        activeExecutorWallet: "0x2222222222222222222222222222222222222222"
      },
      proof: {
        stageIdentifier: targetStageId,
        signalId: fixtureSignalId
      }
    } as ProductTaskDTO;
    const fixture = await submissionFixture({ task: overlayTask });

    await expect(fixture.service.prepareSubmit(overlayTask.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).resolves.toMatchObject({
      submitter,
      sourceId: targetStageId
    });

    const activeExecutor = "0x2222222222222222222222222222222222222222" as Address;
    const activeFixture = await submissionFixture({
      task: overlayTask,
      authorizedSubmitter: activeExecutor
    });
    await expect(activeFixture.service.prepareSubmit(overlayTask.taskId, {
      evidenceIds: [activeFixture.evidence.evidence.evidenceId],
      walletAddress: activeExecutor,
      intent: "confirm_stage"
    }, owner)).resolves.toMatchObject({
      submitter: activeExecutor,
      sourceId: targetStageId
    });

    const unauthorized = "0x3333333333333333333333333333333333333333" as Address;
    const unauthorizedFixture = await submissionFixture({
      task: overlayTask,
      authorizedSubmitter: activeExecutor
    });
    await expect(unauthorizedFixture.service.prepareSubmit(overlayTask.taskId, {
      evidenceIds: [unauthorizedFixture.evidence.evidence.evidenceId],
      walletAddress: unauthorized,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "submitter_not_authorized",
      status: 403
    });
  });

  it("rejects missing evidence before preparing a signed payload", async () => {
    const evidenceService = createEvidenceService({
    runtimeEnvironment: "local",
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage: evidenceStorageFixture(),
      now: () => baseNow
    });
    const service = createProductSubmissionService({
      store: new InMemoryProductSubmissionStore(),
      productTasks: {
        getTask: async (taskId) => taskId === task.taskId ? task : undefined
      },
      evidenceReader: evidenceService,
      chainId,
      verifyingContract,
      authorization: allowListedSubmissionAuthorization([{
        orderId: task.orderId,
        stageIdentifier: task.stageId,
        signalName: "confirm_stage",
        submitter
      }]),
      now: () => baseNow
    });

    await expect(service.prepareSubmit(task.taskId, {
      evidenceIds: ["ev_missing"],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "evidence_not_found",
      status: 404
    });
  });

  it("rejects hash-mismatched evidence before preparing a signed payload", async () => {
    const storage = evidenceStorageFixture();
    const evidenceService = createEvidenceService({
    runtimeEnvironment: "local",
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage,
      now: () => baseNow,
      evidenceIdFactory: () => "ev_mismatch"
    });
    const evidence = await uploadSubmissionEvidence(evidenceService, "example-declaration", "example declaration");
    await storage.delete(evidence.evidence.storageURI);
    await storage.put({
      evidenceId: evidence.evidence.evidenceId,
      bytes: new TextEncoder().encode("tampered example declaration")
    });
    const service = submissionServiceForEvidence(evidenceService);

    await expect(service.prepareSubmit(task.taskId, {
      evidenceIds: [evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "evidence_not_usable",
      status: 409,
      details: {
        evidenceId: evidence.evidence.evidenceId,
        verificationStatus: "mismatch"
      }
    });
  });

  it("builds deterministic payload bundle hashes regardless of evidence id order", async () => {
    const evidenceService = createEvidenceService({
    runtimeEnvironment: "local",
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage: evidenceStorageFixture(),
      now: () => baseNow,
      evidenceIdFactory: sequentialIds(["ev_b", "ev_a"])
    });
    const firstEvidence = await uploadSubmissionEvidence(evidenceService, "manifest", "manifest payload");
    const secondEvidence = await uploadSubmissionEvidence(evidenceService, "example-declaration", "example payload");
    const firstService = submissionServiceForEvidence(evidenceService);
    const secondService = submissionServiceForEvidence(evidenceService);

    const firstPrepared = await firstService.prepareSubmit(task.taskId, {
      evidenceIds: [firstEvidence.evidence.evidenceId, secondEvidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner);
    const secondPrepared = await secondService.prepareSubmit(task.taskId, {
      evidenceIds: [secondEvidence.evidence.evidenceId, firstEvidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner);

    expect(firstPrepared.payloadHash).toBe(secondPrepared.payloadHash);
    expect(firstPrepared.payloadRef).toBe(secondPrepared.payloadRef);
    expect(firstPrepared.payloadHash).not.toBe(firstEvidence.evidence.payloadHash);
    expect(firstPrepared.payloadHash).not.toBe(secondEvidence.evidence.payloadHash);
  });

  it("uses the broadcast adapter seam when an adapter supports submission", async () => {
    const broadcast: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (request): Promise<SubmissionBroadcastResult> => {
        expect(request.recoveredSubmitter).toBe(submitter);
        expect(request.prepared.typedData.message.submitter).toBe(submitter);
        expect(request.signature).toMatch(/^0x[0-9a-f]+$/);
        return { status: "submitted" as const, txHash: txHash("2"), blockNumber: "123" };
      })
    };
    const fixture = await submissionFixture({ broadcastAdapter: broadcast });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(submission).toMatchObject({
      status: "submitted",
      broadcastStatus: "submitted",
      txHash: txHash("2"),
      blockNumber: "123",
      attemptCount: 1
    });
    expect(submission.attempts[0]).toMatchObject({
      attemptId: "sub_1:1",
      status: "submitted",
      txHash: txHash("2")
    });
    expect(broadcast.broadcast).toHaveBeenCalledOnce();
  });

  it("marks evidence bound after successful Product submit and keeps plaintext out of submission proof rows", async () => {
    const broadcast: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({
        status: "submitted",
        txHash: txHash("21"),
        blockNumber: "456"
      }))
    };
    const fixture = await submissionFixture({ broadcastAdapter: broadcast });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });
    const evidence = await fixture.evidenceService.getEvidence(fixture.evidence.evidence.evidenceId, owner);
    const proof = await fixture.evidenceService.getProof(fixture.evidence.evidence.evidenceId, owner);

    expect(submission).toMatchObject({
      status: "submitted",
      txHash: txHash("21")
    });
    expect(submission.evidenceIds).toEqual([fixture.evidence.evidence.evidenceId]);
    await expect(fixture.service.getSubmission("sub_1", submitter)).resolves.toMatchObject({
      evidenceIds: [fixture.evidence.evidence.evidenceId]
    });
    expect(evidence).toMatchObject({
      evidence: {
        status: "bound",
        boundSignalTxHash: txHash("21"),
        boundSubmissionId: "sub_1",
        boundOnchainOrderId: prepared.onchainOrderId,
        boundSourceId: prepared.sourceId,
        boundSignalId: prepared.signalId
      }
    });
    expect(proof).toMatchObject({
      verificationStatus: "matched",
      boundSignalTxHash: txHash("21"),
      boundSourceId: prepared.sourceId,
      boundSignalId: prepared.signalId
    });
    expect(JSON.stringify(submission.proofRows)).not.toContain("example declaration");
    expect(JSON.stringify(submission.proofRows)).not.toContain("example.txt");
  });

  it("does not mark evidence bound when Product submit broadcast fails", async () => {
    const broadcast: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({
        status: "failed",
        errorCode: "rpc_timeout",
        message: "RPC request timed out while broadcasting the signal",
        retryable: true,
        attempt: {
          status: "failed",
          errorCode: "rpc_timeout",
          errorMessage: "RPC request timed out while broadcasting the signal"
        }
      }))
    };
    const fixture = await submissionFixture({ broadcastAdapter: broadcast });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });
    const evidence = await fixture.evidenceService.getEvidence(fixture.evidence.evidence.evidenceId, owner);
    const proof = await fixture.evidenceService.getProof(fixture.evidence.evidence.evidenceId, owner);

    expect(submission).toMatchObject({
      status: "failed",
      errorCode: "rpc_timeout"
    });
    expect(evidence).toMatchObject({
      evidence: {
        status: "uploaded"
      }
    });
    expect(evidence?.evidence.boundSignalTxHash).toBeUndefined();
    expect(proof).toMatchObject({
      verificationStatus: "unbound"
    });
  });

  it("reopens the same prepare after a retryable broadcast result without txHash", async () => {
    let broadcastCalls = 0;
    const broadcast: SubmissionBroadcastAdapter = {
      attemptsBroadcast: true,
      async broadcast(): Promise<SubmissionBroadcastResult> {
        broadcastCalls += 1;
        return broadcastCalls === 1
          ? {
              status: "failed",
              errorCode: "rpc_timeout",
              message: "RPC request timed out while broadcasting the signal",
              retryable: true,
            }
          : { status: "submitted", txHash: txHash("23") };
      },
    };
    const fixture = await submissionFixture({ broadcastAdapter: broadcast });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    const input = {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature,
    };

    await expect(fixture.service.submit(task.taskId, input)).resolves.toMatchObject({
      status: "failed",
      retryable: true,
    });
    await expect(fixture.service.submit(task.taskId, input)).resolves.toMatchObject({
      status: "submitted",
      txHash: txHash("23"),
    });
    expect(broadcastCalls).toBe(2);
  });

  it("releases the reserved nonce when broadcast throws so the same prepareId stays retryable", async () => {
    let broadcastCalls = 0;
    const broadcast: SubmissionBroadcastAdapter = {
      attemptsBroadcast: true,
      async broadcast(): Promise<SubmissionBroadcastResult> {
        broadcastCalls += 1;
        if (broadcastCalls === 1) {
          throw new Error("rpc connection reset before writeContract");
        }
        return { status: "submitted" as const, txHash: txHash("30"), blockNumber: "7" };
      }
    };
    const fixture = await submissionFixture({ broadcastAdapter: broadcast });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    await expect(fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).rejects.toThrow("rpc connection reset before writeContract");

    const failedAttempt = await fixture.service.getSubmission("sub_1", submitter);
    expect(failedAttempt).toMatchObject({
      status: "failed",
      retryable: true
    });
    expect(typeof failedAttempt?.errorCode).toBe("string");

    const retried = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(retried).toMatchObject({
      submissionId: "sub_1",
      status: "submitted",
      txHash: txHash("30")
    });
    expect(broadcastCalls).toBe(2);
    await expect(fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).rejects.toMatchObject({
      code: "prepare_already_used",
      status: 409
    });
  });

  it("records persist_failed with txHash and keeps the nonce when the store write fails after a successful broadcast", async () => {
    const inner = new InMemoryProductSubmissionStore();
    const releasedKeys: string[] = [];
    let putSubmissionCalls = 0;
    const flakyStore: ProductSubmissionStore = {
      withTransaction: (operation) => (inner as ProductSubmissionStore).withTransaction?.(operation) ?? operation(),
      putPrepared: (record) => inner.putPrepared(record),
      getPrepared: (prepareId) => inner.getPrepared(prepareId),
      markPreparedUsed: (prepareId, submissionId, usedAt) => inner.markPreparedUsed(prepareId, submissionId, usedAt),
      reserveNonce: (key) => inner.reserveNonce(key),
      releaseNonce: (key) => {
        releasedKeys.push(key);
        return inner.releaseNonce(key);
      },
      putSubmission: async (submission) => {
        putSubmissionCalls += 1;
        if (putSubmissionCalls === 1) {
          throw new Error("simulated durable store outage");
        }
        return inner.putSubmission(submission);
      },
      getSubmission: (submissionId) => inner.getSubmission(submissionId),
      listSubmissions: () => inner.listSubmissions()
    };
    const broadcast: SubmissionBroadcastAdapter = {
      attemptsBroadcast: true,
      async broadcast(): Promise<SubmissionBroadcastResult> {
        return { status: "submitted" as const, txHash: txHash("31") };
      }
    };
    const fixture = await submissionFixture({ broadcastAdapter: broadcast });
    const service = createProductSubmissionService({
      productTasks: { getTask: async (taskId) => taskId === task.taskId ? task : undefined },
      evidenceReader: fixture.evidenceService,
      chainId,
      verifyingContract,
      resolveOrderPlanId: async () => planId,
      authorization: allowListedSubmissionAuthorization([{
        orderId: task.orderId,
        stageIdentifier: task.stageId,
        signalName: "confirm_stage",
        submitter
      }]),
      broadcastAdapter: broadcast,
      store: flakyStore,
      now: () => baseNow,
      prepareIdFactory: () => "prep_1",
      submissionIdFactory: () => "sub_1",
      nonceFactory: () => "42"
    });
    const prepared = await prepare({ service, evidence: fixture.evidence, task });
    const signature = await signPrepared(prepared);

    await expect(service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).rejects.toThrow("simulated durable store outage");

    expect(putSubmissionCalls).toBe(2);
    await expect(inner.getSubmission("sub_1")).resolves.toMatchObject({
      status: "failed",
      errorCode: "persist_failed",
      txHash: txHash("31"),
      deadLetter: true,
      receiptStatus: "not_checked"
    });
    expect(releasedKeys).toHaveLength(0);

    await expect(service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).rejects.toMatchObject({
      code: "duplicate_submit",
      status: 409
    });
  });

  it("takes over a stale nonce reservation after a hard crash and still 409s an unexpired one", async () => {
    let clock = baseNow.getTime();
    const now = () => new Date(clock);
    const fixture = await submissionFixture({ now });
    const inner = new InMemoryProductSubmissionStore({ now });
    let prepareCounter = 0;
    let submissionCounter = 0;
    let broadcastCalls = 0;
    let putSubmissionCalls = 0;
    const broadcast: SubmissionBroadcastAdapter = {
      attemptsBroadcast: true,
      async broadcast(): Promise<SubmissionBroadcastResult> {
        broadcastCalls += 1;
        if (broadcastCalls === 1) {
          throw new Error("rpc connection reset before writeContract");
        }
        return { status: "submitted" as const, txHash: txHash("41"), blockNumber: "7" };
      }
    };
    const crashedStore: ProductSubmissionStore = {
      putPrepared: (record) => inner.putPrepared(record),
      getPrepared: (prepareId) => inner.getPrepared(prepareId),
      markPreparedUsed: (prepareId, submissionId, usedAt) => inner.markPreparedUsed(prepareId, submissionId, usedAt),
      reserveNonce: (key, options) => inner.reserveNonce(key, options),
      releaseNonce: (key) => inner.releaseNonce(key),
      putSubmission: async (submission) => {
        putSubmissionCalls += 1;
        if (putSubmissionCalls === 1) {
          throw new Error("process died before the submission was persisted");
        }
        return inner.putSubmission(submission);
      },
      getSubmission: (submissionId) => inner.getSubmission(submissionId),
      listSubmissions: () => inner.listSubmissions()
    };
    const service = createProductSubmissionService({
      productTasks: { getTask: async (taskId) => taskId === task.taskId ? task : undefined },
      evidenceReader: fixture.evidenceService,
      chainId,
      verifyingContract,
      resolveOrderPlanId: async () => planId,
      authorization: allowListedSubmissionAuthorization([{
        orderId: task.orderId,
        stageIdentifier: task.stageId,
        signalName: "confirm_stage",
        submitter
      }]),
      broadcastAdapter: broadcast,
      store: crashedStore,
      now,
      prepareIdFactory: () => `prep_${++prepareCounter}`,
      submissionIdFactory: () => `sub_${++submissionCounter}`,
      nonceFactory: () => "42"
    });
    const prepared = await prepare({ service, evidence: fixture.evidence, task });
    const signature = await signPrepared(prepared);

    await expect(service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).rejects.toThrow("process died before the submission was persisted");
    expect(broadcastCalls).toBe(1);

    clock = baseNow.getTime() + 5 * 60_000;
    await expect(service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).rejects.toMatchObject({ code: "duplicate_submit", status: 409 });

    clock = baseNow.getTime() + 11 * 60_000;
    const reprepared = await prepare({ service, evidence: fixture.evidence, task });
    const resigned = await signPrepared(reprepared);
    const recovered = await service.submit(task.taskId, {
      prepareId: reprepared.prepareId,
      walletAddress: submitter,
      signature: resigned
    });
    expect(recovered).toMatchObject({
      status: "submitted",
      txHash: txHash("41")
    });
    expect(broadcastCalls).toBe(2);
  });

  it("classifies getChainId RPC failures as failed broadcast results instead of throwing", async () => {
    const walletClient = {
      account: { address: "0x9999999999999999999999999999999999999999" },
      writeContract: vi.fn(async () => txHash("32"))
    };
    const adapter = createStateMachineSubmissionBroadcastAdapter({
      stateMachineAddress: verifyingContract,
      chainId,
      publicClient: {
        getChainId: async () => {
          throw new Error("RPC read timed out");
        }
      },
      walletClient,
      waitForReceipt: false,
      now: () => baseNow
    });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    await expect(adapter.broadcast({
      prepared,
      signature,
      recoveredSubmitter: submitter,
      evidence: []
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "rpc_timeout",
      retryable: true,
      retryState: "retryable",
      deadLetter: false
    });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("broadcasts submitSignalFor with the state-machine ABI arguments", async () => {
    const taskStateMachine = "0x8888888888888888888888888888888888888888" as Address;
    const chainTask = {
      ...task,
      taskId: "task-chain",
      orderId: txHash("10"),
      stateMachineAddress: taskStateMachine,
      hookId: txHash("20")
    } satisfies ProductTaskDTO & { readonly hookId: Hex };
    const gasPayer = "0x9999999999999999999999999999999999999999" as Address;
    const calls: StateMachineSubmitSignalForCall[] = [];
    const walletClient = {
      account: { address: gasPayer },
      writeContract: vi.fn(async (call: StateMachineSubmitSignalForCall) => {
        calls.push(call);
        return txHash("3");
      })
    };
    const publicClient = {
      getChainId: vi.fn(async () => chainId),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const, blockNumber: 123n }))
    };
    const fixture = await submissionFixture({
      task: chainTask,
      broadcastAdapter: createStateMachineSubmissionBroadcastAdapter({
        stateMachineAddress: verifyingContract,
        chainId,
        publicClient,
        walletClient,
        waitForReceipt: true,
        now: () => baseNow
      })
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(chainTask.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      address: taskStateMachine,
      abi: STATE_MACHINE_ABI,
      functionName: "submitSignalFor"
    });
    expect((calls[0] as StateMachineSubmitSignalForCall & { readonly data?: string }).data).toMatch(/^0x[0-9a-f]+$/);
    expect(calls[0]!.args).toEqual([
      prepared.planId,
      prepared.onchainOrderId,
      prepared.sourceId,
      prepared.signalId,
      prepared.payloadHash,
      prepared.idempotencyKey,
      prepared.submitter,
      BigInt(prepared.deadline),
      signature,
      prepared.attribution ?? {
        sourceId: prepared.sourceId,
        signalId: prepared.signalId,
        stageId: "0x0000000000000000000000000000000000000000000000000000000000000000",
        capabilityProof: []
      }
    ]);
    expect(submission).toMatchObject({
      status: "submitted",
      broadcastStatus: "submitted",
      txHash: txHash("3"),
      blockNumber: "123",
      attemptCount: 1
    });
    expect(submission.attempts[0]).toMatchObject({
      status: "submitted",
      gasPayer,
      txHash: txHash("3"),
      blockNumber: "123",
      orderId: prepared.onchainOrderId,
      sourceId: prepared.sourceId,
      signalId: prepared.signalId,
      submitter: prepared.submitter,
      retryable: false,
      retryState: "not_applicable",
      deadLetter: false
    });
  });

  it("refuses to broadcast a prepared submission whose planId is missing or zero", async () => {
    const walletClient = {
      account: { address: "0x9999999999999999999999999999999999999999" as Address },
      writeContract: vi.fn(async () => txHash("79"))
    };
    const adapter = createStateMachineSubmissionBroadcastAdapter({
      stateMachineAddress: verifyingContract,
      chainId,
      publicClient: { getChainId: async () => chainId },
      walletClient,
      waitForReceipt: false,
      now: () => baseNow
    });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    const zeroPrepared: PreparedSubmissionDTO = {
      ...prepared,
      planId: zeroPlanId,
      typedData: {
        ...prepared.typedData,
        message: {
          ...prepared.typedData.message,
          planId: zeroPlanId
        }
      }
    };

    await expect(adapter.broadcast({
      prepared: zeroPrepared,
      signature,
      recoveredSubmitter: submitter,
      evidence: []
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "order_plan_unresolved",
      retryable: false,
      deadLetter: true
    });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("refuses recovered submitter mismatches before submitSignalFor", async () => {
    const gasPayer = "0x9999999999999999999999999999999999999999" as Address;
    const walletClient = {
      account: { address: gasPayer },
      writeContract: vi.fn(async () => txHash("77"))
    };
    const adapter = createStateMachineSubmissionBroadcastAdapter({
      stateMachineAddress: verifyingContract,
      chainId,
      publicClient: { getChainId: async () => chainId },
      walletClient,
      waitForReceipt: false,
      now: () => baseNow
    });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    await expect(adapter.broadcast({
      prepared,
      signature,
      recoveredSubmitter: "0x2222222222222222222222222222222222222222" as Address,
      evidence: []
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "invalid_signal_signature",
      retryable: false,
      deadLetter: true,
      attempt: {
        status: "failed",
        gasPayer,
        revertReason: "RecoveredSubmitterMismatch"
      }
    });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("rejects relayer gas payer reuse as the participant business signer when key-boundary enforcement is enabled", async () => {
    const walletClient = {
      account: { address: submitter },
      writeContract: vi.fn(async () => txHash("78"))
    };
    const adapter = createStateMachineSubmissionBroadcastAdapter({
      stateMachineAddress: verifyingContract,
      chainId,
      publicClient: { getChainId: async () => chainId },
      walletClient,
      waitForReceipt: false,
      rejectGasPayerAsSubmitter: true,
      now: () => baseNow
    });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    await expect(adapter.broadcast({
      prepared,
      signature,
      recoveredSubmitter: submitter,
      evidence: []
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "relayer_business_signer_reuse",
      retryable: false,
      deadLetter: true,
      attempt: {
        status: "failed",
        gasPayer: submitter,
        revertReason: "RelayerBusinessSignerReuse"
      }
    });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("maps state-machine authorization reverts to failed submissions", async () => {
    const walletClient = {
      account: { address: "0x9999999999999999999999999999999999999999" },
      writeContract: vi.fn(async () => {
        throw Object.assign(new Error("execution reverted: UnauthorizedSignalSubmitter"), {
          errorName: "UnauthorizedSignalSubmitter"
        });
      })
    };
    const fixture = await submissionFixture({
      broadcastAdapter: createStateMachineSubmissionBroadcastAdapter({
        stateMachineAddress: verifyingContract,
        chainId,
        publicClient: { getChainId: async () => chainId },
        walletClient,
        waitForReceipt: false,
        now: () => baseNow
      })
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(submission).toMatchObject({
      status: "failed",
      broadcastStatus: "failed",
      errorCode: "unauthorized_signal_submitter",
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true,
      attemptCount: 1
    });
    expect(submission.attempts[0]).toMatchObject({
      status: "failed",
      errorCode: "unauthorized_signal_submitter",
      errorLabel: "Submitter is not authorized",
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true,
      revertReason: "UnauthorizedSignalSubmitter"
    });
  });

  it("classifies chain id mismatches without broadcasting", async () => {
    const walletClient = {
      account: { address: "0x9999999999999999999999999999999999999999" },
      writeContract: vi.fn(async () => txHash("20"))
    };
    const fixture = await submissionFixture({
      broadcastAdapter: createStateMachineSubmissionBroadcastAdapter({
        stateMachineAddress: verifyingContract,
        chainId,
        publicClient: { getChainId: async () => 84532 },
        walletClient,
        waitForReceipt: false,
        now: () => baseNow
      })
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(submission).toMatchObject({
      status: "failed",
      errorCode: "chain_id_mismatch",
      errorLabel: "RPC chain does not match configuration",
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true
    });
    expect(submission.attempts[0]).toMatchObject({
      gasPayer: "0x9999999999999999999999999999999999999999",
      retryable: false,
      deadLetter: true
    });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("classifies relayer insufficient funds as operator action", async () => {
    const walletClient = {
      account: { address: "0x9999999999999999999999999999999999999999" },
      writeContract: vi.fn(async () => {
        throw new Error("insufficient funds for gas * price + value");
      })
    };
    const fixture = await submissionFixture({
      broadcastAdapter: createStateMachineSubmissionBroadcastAdapter({
        stateMachineAddress: verifyingContract,
        chainId,
        publicClient: { getChainId: async () => chainId },
        walletClient,
        waitForReceipt: false,
        now: () => baseNow
      })
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(submission).toMatchObject({
      status: "failed",
      errorCode: "relayer_insufficient_funds",
      errorLabel: "Relayer gas payer needs funds",
      retryable: true,
      retryState: "retryable",
      deadLetter: false,
      attemptCount: 1
    });
  });

  it("records receipt timeouts as retryable failed attempts with txHash", async () => {
    const walletClient = {
      account: { address: "0x9999999999999999999999999999999999999999" },
      writeContract: vi.fn(async () => txHash("21"))
    };
    const publicClient = {
      getChainId: vi.fn(async () => chainId),
      waitForTransactionReceipt: vi.fn(async () => {
        throw new Error("RPC request timed out");
      })
    };
    const fixture = await submissionFixture({
      broadcastAdapter: createStateMachineSubmissionBroadcastAdapter({
        stateMachineAddress: verifyingContract,
        chainId,
        publicClient,
        walletClient,
        waitForReceipt: true,
        receiptTimeoutMs: 12_000,
        now: () => baseNow
      })
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: txHash("21"),
      timeout: 12_000
    });
    expect(submission).toMatchObject({
      status: "failed",
      errorCode: "rpc_timeout",
      txHash: txHash("21"),
      retryable: true,
      retryState: "retryable",
      deadLetter: false,
      receiptStatus: "not_checked"
    });
    expect(submission.attempts[0]).toMatchObject({
      status: "failed",
      txHash: txHash("21"),
      retryable: true,
      retryState: "retryable",
      deadLetter: false
    });
  });

  it("records reverted receipts with txHash, blockNumber, and revert reason", async () => {
    const walletClient = {
      account: { address: "0x9999999999999999999999999999999999999999" },
      writeContract: vi.fn(async () => txHash("22"))
    };
    const fixture = await submissionFixture({
      broadcastAdapter: createStateMachineSubmissionBroadcastAdapter({
        stateMachineAddress: verifyingContract,
        chainId,
        publicClient: {
          getChainId: async () => chainId,
          waitForTransactionReceipt: async () => ({ status: "reverted" as const, blockNumber: 456n })
        },
        walletClient,
        waitForReceipt: true,
        now: () => baseNow
      })
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    expect(submission).toMatchObject({
      status: "failed",
      errorCode: "transaction_reverted",
      txHash: txHash("22"),
      blockNumber: "456",
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true,
      receiptStatus: "failed"
    });
    expect(submission.attempts[0]).toMatchObject({
      txHash: txHash("22"),
      blockNumber: "456",
      revertReason: "transaction_reverted"
    });
  });

  it("redacts secret-shaped broadcast errors from submission DTOs", async () => {
    const leakedSignature = `0x${"aa".repeat(65)}`;
    const walletClient = {
      account: { address: "0x9999999999999999999999999999999999999999" },
      writeContract: vi.fn(async () => {
        throw new Error(`privateKey ${privateKey} signature ${leakedSignature}`);
      })
    };
    const fixture = await submissionFixture({
      broadcastAdapter: createStateMachineSubmissionBroadcastAdapter({
        stateMachineAddress: verifyingContract,
        chainId,
        publicClient: { getChainId: async () => chainId },
        walletClient,
        waitForReceipt: false,
        now: () => baseNow
      })
    });
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    const submission = await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    const serialized = JSON.stringify(submission);
    expect(submission).toMatchObject({
      status: "failed",
      errorCode: "state_machine_broadcast_failed",
      errorMessage: "state-machine signal broadcast failed"
    });
    expect(serialized).not.toContain(privateKey.slice(2));
    expect(serialized).not.toContain(leakedSignature.slice(2));
  });

  it("blocks duplicate secure broadcasts without calling the inner adapter twice", async () => {
    const audit = new InMemoryAuditSink();
    const inner: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({
        status: "submitted",
        txHash: txHash("9"),
        attempt: {
          status: "submitted",
          txHash: txHash("9")
        }
      }))
    };
    const secure = createSecureSubmissionBroadcastAdapter({ adapter: inner, audit });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    const request = {
      prepared,
      signature,
      recoveredSubmitter: submitter,
      evidence: []
    };

    await expect(secure.broadcast(request)).resolves.toMatchObject({
      status: "submitted",
      txHash: txHash("9")
    });
    await expect(secure.broadcast(request)).resolves.toMatchObject({
      status: "submitted",
      txHash: txHash("9")
    });

    expect(inner.broadcast).toHaveBeenCalledOnce();
    expect(audit.list().map((event) => event.type)).toContain("relayer.broadcast.duplicate");
  });

  it("returns the txHash-bearing broadcast result when the dedupe ledger write fails after a real broadcast", async () => {
    const audit = new InMemoryAuditSink();
    const inner: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({
        status: "submitted",
        txHash: txHash("34"),
        attempt: { status: "submitted", txHash: txHash("34") }
      }))
    };
    const dedupe = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {
        throw new Error("dedupe ledger unavailable");
      }),
      claimTxHash: vi.fn(async () => undefined)
    };
    const secure = createSecureSubmissionBroadcastAdapter({ adapter: inner, audit, dedupeStore: dedupe });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    const request = {
      prepared,
      signature,
      recoveredSubmitter: submitter,
      evidence: []
    };

    await expect(secure.broadcast(request)).resolves.toMatchObject({
      status: "submitted",
      txHash: txHash("34")
    });
    expect(audit.list().map((event) => event.type)).toContain("relayer.broadcast.dedupe_persist_failed");
  });

  it("blocks retry after a non-retryable secure broadcast failure", async () => {
    const inner: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({
        status: "failed",
        errorCode: "invalid_signal_signature",
        message: "wallet signature does not match the submitter payload",
        retryable: false,
        attempt: {
          status: "failed",
          errorCode: "invalid_signal_signature",
          errorMessage: "wallet signature does not match the submitter payload"
        }
      }))
    };
    const secure = createSecureSubmissionBroadcastAdapter({ adapter: inner });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    const request = {
      prepared,
      signature,
      recoveredSubmitter: submitter,
      evidence: []
    };

    await secure.broadcast(request);
    await expect(secure.broadcast(request)).resolves.toMatchObject({
      status: "failed",
      errorCode: "invalid_signal_signature",
      message: "wallet signature does not match the submitter payload",
      retryable: false
    });
    expect(inner.broadcast).toHaveBeenCalledOnce();
  });

  it("blocks reused txHash across different secure broadcast idempotency keys", async () => {
    const inner: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({
        status: "submitted",
        txHash: txHash("12"),
        attempt: {
          status: "submitted",
          txHash: txHash("12")
        }
      }))
    };
    const secure = createSecureSubmissionBroadcastAdapter({ adapter: inner });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    const firstRequest = {
      prepared,
      signature,
      recoveredSubmitter: submitter,
      evidence: []
    };
    const secondRequest = {
      ...firstRequest,
      prepared: {
        ...prepared,
        prepareId: "prep_2",
        idempotencyKey: txHash("55"),
        nonce: "55"
      }
    };

    await expect(secure.broadcast(firstRequest)).resolves.toMatchObject({
      status: "submitted",
      txHash: txHash("12")
    });
    await expect(secure.broadcast(secondRequest)).resolves.toMatchObject({
      status: "failed",
      errorCode: "duplicate_tx_hash",
      retryable: false
    });
    expect(inner.broadcast).toHaveBeenCalledTimes(2);
  });

  it("allows retryable secure broadcast failures to create a new attempt up to the retry limit", async () => {
    const inner: SubmissionBroadcastAdapter = {
      broadcast: vi.fn(async (): Promise<SubmissionBroadcastResult> => ({
        status: "failed",
        errorCode: "rpc_timeout",
        message: "RPC request timed out while broadcasting the signal",
        retryable: true,
        attempt: {
          status: "failed",
          errorCode: "rpc_timeout",
          errorMessage: "RPC request timed out while broadcasting the signal"
        }
      }))
    };
    const secure = createSecureSubmissionBroadcastAdapter({ adapter: inner, maxRetry: 1 });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);
    const request = {
      prepared,
      signature,
      recoveredSubmitter: submitter,
      evidence: []
    };

    await expect(secure.broadcast(request)).resolves.toMatchObject({
      status: "failed",
      attempt: { attemptNumber: 1 }
    });
    await expect(secure.broadcast(request)).resolves.toMatchObject({
      status: "failed",
      attempt: { attemptNumber: 2 }
    });
    await expect(secure.broadcast(request)).resolves.toMatchObject({
      status: "failed",
      errorCode: "broadcast_retry_exhausted"
    });
    expect(inner.broadcast).toHaveBeenCalledTimes(2);
  });

  it("rejects draft-origin evidence replayed into a submission it is not bound to (U4)", async () => {
    const evidenceService = createEvidenceService({
      runtimeEnvironment: "local",
      metadataStore: new InMemoryEvidenceMetadataStore(),
      storage: evidenceStorageFixture(),
      now: () => baseNow,
      evidenceIdFactory: () => "ev_draft_replay"
    });
    const uploaded = await evidenceService.uploadEvidence({
      draftId: "draft-1",
      stageIdentifier: task.stageId,
      documentType: "example-declaration",
      fileName: "example.txt",
      textPayload: "draft-period example declaration",
      metadata: {
        businessLabel: "Example declaration",
        fields: { declarationNo: "CD-DRAFT" }
      }
    }, owner);
    const serviceFor = (resolveDraftOrder?: (draftId: string) => Promise<string | undefined>) =>
      createProductSubmissionService({
        store: new InMemoryProductSubmissionStore(),
        productTasks: {
          getTask: async (taskId) => taskId === task.taskId ? task : undefined
        },
        evidenceReader: evidenceService,
        chainId,
        verifyingContract,
        resolveOrderPlanId: async () => planId,
        authorization: permissiveProductProjectionAuthorization(),
        ...(resolveDraftOrder ? { resolveDraftOrder } : {}),
        now: () => baseNow
      });
    const prepareDraftSubmit = (service: ReturnType<typeof createProductSubmissionService>) =>
      service.prepareSubmit(task.taskId, {
        evidenceIds: [uploaded.evidence.evidenceId],
        walletAddress: submitter,
        intent: "confirm_stage"
      }, owner);

    await expect(prepareDraftSubmit(serviceFor(async () => "0x0000000000000000000000000000000000000000000000000000000000009999")))
      .rejects.toMatchObject({ code: "evidence_order_mismatch", status: 409 });
    await expect(prepareDraftSubmit(serviceFor(async () => undefined)))
      .rejects.toMatchObject({ code: "evidence_order_mismatch", status: 409 });
    await expect(prepareDraftSubmit(serviceFor()))
      .rejects.toMatchObject({ code: "evidence_order_mismatch", status: 409 });
    await expect(prepareDraftSubmit(serviceFor(async (draftId) =>
      draftId === "draft-1" ? task.orderId : undefined)))
      .resolves.toMatchObject({ orderId: task.orderId });
  });


});

async function submissionFixture(options: {
  readonly now?: () => Date;
  readonly broadcastAdapter?: SubmissionBroadcastAdapter;
  readonly authorizedSubmitter?: Address;
  readonly authorization?: Parameters<typeof createProductSubmissionService>[0]["authorization"];
  readonly task?: ProductTaskDTO;
  readonly store?: ProductSubmissionStore;
  readonly probePriorSubmissionOnChain?: Parameters<typeof createProductSubmissionService>[0]["probePriorSubmissionOnChain"];
} = {}): Promise<{
  readonly service: ProductSubmissionService;
  readonly evidenceService: EvidenceService;
  readonly evidence: EvidenceUploadResponseDTO;
  readonly task: ProductTaskDTO;
}> {
  const now = options.now ?? (() => baseNow);
  const fixtureTask = options.task ?? task;
  const evidenceService = createEvidenceService({
    runtimeEnvironment: "local",
    metadataStore: new InMemoryEvidenceMetadataStore(),
    storage: evidenceStorageFixture(),
    now,
    evidenceIdFactory: () => "ev_1"
  });
  const evidence = await evidenceService.uploadEvidence({
    orderId: fixtureTask.orderId,
    taskId: fixtureTask.taskId,
    stageIdentifier: fixtureTask.stageId,
    documentType: "example-declaration",
    fileName: "example.txt",
    textPayload: "example declaration",
    metadata: {
      businessLabel: "Example declaration",
      fields: { declarationNo: "CD-1" }
    }
  }, owner);
  const allowedSubmitter = options.authorizedSubmitter ?? submitter;
  const authorization = options.authorization ?? allowListedSubmissionAuthorization([{
    orderId: fixtureTask.orderId,
    stageIdentifier: fixtureTask.stageId,
    signalName: "confirm_stage",
    submitter: allowedSubmitter
  }]);
  const service = createProductSubmissionService({
    productTasks: {
      getTask: async (taskId) => taskId === fixtureTask.taskId ? fixtureTask : undefined
    },
    evidenceReader: evidenceService,
    store: options.store ?? new InMemoryProductSubmissionStore(),
    chainId,
    verifyingContract,
    resolveOrderPlanId: async () => planId,
    authorization,
    ...(options.broadcastAdapter ? { broadcastAdapter: options.broadcastAdapter } : {}),
    ...(options.probePriorSubmissionOnChain
      ? { probePriorSubmissionOnChain: options.probePriorSubmissionOnChain }
      : {}),
    now,
    prepareIdFactory: () => "prep_1",
    submissionIdFactory: () => "sub_1",
    nonceFactory: () => "42"
  });
  return { service, evidenceService, evidence, task: fixtureTask };
}

function submissionServiceForEvidence(evidenceService: EvidenceService): ProductSubmissionService {
  return createProductSubmissionService({
    store: new InMemoryProductSubmissionStore(),
    productTasks: {
      getTask: async (taskId) => taskId === task.taskId ? task : undefined
    },
    evidenceReader: evidenceService,
    chainId,
    verifyingContract,
    resolveOrderPlanId: async () => planId,
    authorization: allowListedSubmissionAuthorization([{
      orderId: task.orderId,
      stageIdentifier: task.stageId,
      signalName: "confirm_stage",
      submitter
    }]),
    now: () => baseNow,
    prepareIdFactory: () => "prep_bundle",
    submissionIdFactory: () => "sub_bundle",
    nonceFactory: () => "42"
  });
}

async function uploadSubmissionEvidence(
  evidenceService: EvidenceService,
  documentType: string,
  textPayload: string
): Promise<EvidenceUploadResponseDTO> {
  return evidenceService.uploadEvidence({
    orderId: task.orderId,
    taskId: task.taskId,
    stageIdentifier: task.stageId,
    documentType,
    fileName: `${documentType}.txt`,
    textPayload,
    metadata: {
      businessLabel: documentType,
      fields: { documentType }
    }
  }, owner);
}

function sequentialIds(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `ev_${index}`;
}

async function prepare(fixture: {
  readonly service: ProductSubmissionService;
  readonly evidence: EvidenceUploadResponseDTO;
  readonly task: ProductTaskDTO;
}) {
  return fixture.service.prepareSubmit(fixture.task.taskId, {
    evidenceIds: [fixture.evidence.evidence.evidenceId],
    walletAddress: submitter,
    intent: "confirm_stage"
  }, owner);
}

async function signPrepared(prepared: PreparedSubmissionDTO): Promise<Hex> {
  return account.signTypedData(
    prepared.typedData as unknown as Parameters<typeof account.signTypedData>[0]
  );
}

function txHash(value: string): Hex {
  return `0x${value.padStart(64, "0")}`;
}

function zeroBytes32(): Hex {
  return `0x${"0".repeat(64)}` as Hex;
}

function chainPlanEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>
): ChainEvent {
  return {
    chainId,
    contractAddress: verifyingContract,
    blockNumber,
    transactionHash: txHash(`${blockNumber}`),
    logIndex,
    eventName,
    args
  };
}

const signatureHex = ("0x" + "cd".repeat(65)) as Hex;
const onchainOrderId = txHash("order-dedupe") as Address;

function idempotencyKeyHex(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padStart(64, "0")}` as Hex;
}

describe("secure broadcast durable dedupe", () => {
  it("dedupes the same submission through a rebuilt adapter backed by the durable store", async () => {
    const databaseUrl = submissionDatabaseUrl;
    const dedupeStores: PostgresBroadcastDedupeStore[] = [];
    const openDedupeStore = () => {
      const store = new PostgresBroadcastDedupeStore({ databaseUrl });
      dedupeStores.push(store);
      return store;
    };
    try {
      let broadcastCalls = 0;
      const inner: SubmissionBroadcastAdapter = {
        attemptsBroadcast: true,
        async broadcast(): Promise<SubmissionBroadcastResult> {
          broadcastCalls += 1;
          return {
            status: "submitted",
            txHash: txHash("31"),
            attempt: { status: "submitted", txHash: txHash("31") }
          };
        }
      };
      const request: SubmissionBroadcastRequest = {
        prepared: {
          prepareId: "prep_dedupe",
          taskId: "task-dedupe",
          orderId: "order-dedupe",
          onchainOrderId: onchainOrderId,
          signalName: "confirm_stage",
          idempotencyKey: idempotencyKeyHex("dedupe-1"),
          submitter
        } as unknown as PreparedSubmissionDTO,
        signature: signatureHex,
        recoveredSubmitter: submitter,
        evidence: []
      };

      const first = createSecureSubmissionBroadcastAdapter({
        adapter: inner,
        dedupeStore: openDedupeStore()
      });
      await expect(first.broadcast(request)).resolves.toMatchObject({ status: "submitted" });
      expect(broadcastCalls).toBe(1);

      const second = createSecureSubmissionBroadcastAdapter({
        adapter: inner,
        dedupeStore: openDedupeStore()
      });
      await expect(second.broadcast(request)).resolves.toMatchObject({
        status: "submitted",
        txHash: txHash("31")
      });
      expect(broadcastCalls).toBe(1);

      const third = createSecureSubmissionBroadcastAdapter({
        adapter: inner,
        dedupeStore: openDedupeStore()
      });
      await expect(third.broadcast({
        ...request,
        prepared: {
          ...request.prepared,
          prepareId: "prep_dedupe_2",
          idempotencyKey: idempotencyKeyHex("dedupe-2")
        } as unknown as PreparedSubmissionDTO
      })).resolves.toMatchObject({
        status: "failed",
        errorCode: "duplicate_tx_hash"
      });
      expect(broadcastCalls).toBe(2);
    } finally {
      for (const store of dedupeStores.splice(0)) {
        await store.close();
      }
    }
  });
});

describe("state-machine broadcast duplicate-transaction lanes", () => {
  const duplicateTx = txHash("aa");

  function duplicateLaneFixture(receipts: Map<string, { status?: "success" | "reverted" | string; blockNumber?: bigint }>) {
    const writeContract = vi.fn(async () => {
      const error = new Error("already known") as Error & { txHash?: string };
      error.txHash = duplicateTx;
      throw error;
    });
    const adapter = createStateMachineSubmissionBroadcastAdapter({
      stateMachineAddress: verifyingContract,
      chainId,
      publicClient: {
        getChainId: async () => chainId,
        getTransactionReceipt: async ({ hash }: { hash: Hex }) => receipts.get(hash)
      },
      walletClient: {
        account: { address: "0x9999999999999999999999999999999999999999" },
        writeContract
      },
      waitForReceipt: true,
      now: () => baseNow
    });
    return { adapter, writeContract };
  }

  it("resolves an already-mined duplicate to submitted with the probed receipt", async () => {
    const { adapter } = duplicateLaneFixture(new Map([[duplicateTx, { status: "success", blockNumber: 55n }]]));
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    await expect(adapter.broadcast({
      prepared,
      signature: await signPrepared(prepared),
      recoveredSubmitter: submitter,
      evidence: []
    })).resolves.toMatchObject({
      status: "submitted",
      txHash: duplicateTx,
      blockNumber: "55",
      attempt: { status: "submitted", gasPayer: "0x9999999999999999999999999999999999999999", retryable: false }
    });
  });

  it("dead-letters only when the probed receipt proves a revert", async () => {
    const { adapter } = duplicateLaneFixture(new Map([[duplicateTx, { status: "reverted", blockNumber: 56n }]]));
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    await expect(adapter.broadcast({
      prepared,
      signature: await signPrepared(prepared),
      recoveredSubmitter: submitter,
      evidence: []
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "transaction_reverted",
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true,
      txHash: duplicateTx,
      blockNumber: "56"
    });
  });

  it("keeps a pool-pending duplicate retryable with the candidate hash (receipt unknown)", async () => {
    const { adapter } = duplicateLaneFixture(new Map());
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    await expect(adapter.broadcast({
      prepared,
      signature: await signPrepared(prepared),
      recoveredSubmitter: submitter,
      evidence: []
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "transaction_receipt_unknown",
      retryable: true,
      retryState: "retryable",
      deadLetter: false,
      txHash: duplicateTx
    });
  });

  it("treats a nonce race without an attributable hash as a retryable re-assembly", async () => {
    const writeContract = vi.fn(async () => {
      throw new Error("nonce too low");
    });
    const adapter = createStateMachineSubmissionBroadcastAdapter({
      stateMachineAddress: verifyingContract,
      chainId,
      publicClient: {
        getChainId: async () => chainId,
        getTransactionReceipt: async () => undefined
      },
      walletClient: {
        account: { address: "0x9999999999999999999999999999999999999999" },
        writeContract
      },
      waitForReceipt: true,
      now: () => baseNow
    });
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    await expect(adapter.broadcast({
      prepared,
      signature: await signPrepared(prepared),
      recoveredSubmitter: submitter,
      evidence: []
    })).resolves.toMatchObject({
      status: "failed",
      errorCode: "duplicate_transaction",
      retryable: true,
      retryState: "retryable",
      deadLetter: false
    });
  });
});
