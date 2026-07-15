import { describe, expect, it, vi } from "vitest";
import type { ProductTaskDTO } from "@uvp-eth/product-dto";
import { onchainSignalId, onchainSourceId } from "@uvp-eth/compiler";
import { STATE_MACHINE_ABI } from "@uvp-eth/protocol-bindings";
import { privateKeyToAccount } from "viem/accounts";
import {
  allowListedSubmissionAuthorization,
  createSecureSubmissionBroadcastAdapter,
  createStateMachineSubmissionBroadcastAdapter,
  createProductSubmissionService,
  permissiveProductProjectionAuthorization,
  type PreparedSubmissionDTO,
  type ProductSubmissionService,
  type StateMachineSubmitSignalForCall,
  type SubmissionBroadcastAdapter,
  type SubmissionBroadcastResult
} from "../src/submissions/index.js";
import {
  createEvidenceService,
  InMemoryEvidenceStorage,
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
const chainId = 31337;
const owner: EvidencePrincipal = { id: "seller", role: "participant" };
const baseNow = new Date("2026-04-28T00:00:00Z");

const task: ProductTaskDTO = {
  taskId: "task-1",
  orderId: "order-1",
  orderTitle: "Order 1",
  zhixuId: "zhixu-1",
  title: "Confirm customs",
  subtitle: "Upload customs evidence",
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

describe("product task submissions", () => {
  it("does not authorize permissively when no authorization adapter is configured", async () => {
    const evidenceService = createEvidenceService({
      storage: new InMemoryEvidenceStorage(),
      now: () => baseNow,
      evidenceIdFactory: () => "ev_no_auth"
    });
    const evidence = await evidenceService.uploadEvidence({
      orderId: task.orderId,
      taskId: task.taskId,
      stageIdentifier: task.stageId,
      documentType: "customs-declaration",
      fileName: "customs.txt",
      textPayload: "customs declaration",
      metadata: {
        businessLabel: "Customs declaration",
        fields: { declarationNo: "CD-NO-AUTH" }
      }
    }, owner);
    const service = createProductSubmissionService({
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
      sourceId: onchainSourceId("product"),
      signalId: onchainSignalId(`${task.stageId}.confirm_stage`),
      payloadHash: fixture.evidence.evidence.payloadHash,
      payloadRef: fixture.evidence.evidence.payloadRef,
      idempotencyKey: prepared.typedData.message.idempotencyKey,
      submitter,
      nonce: "42",
      deadline: deadline.toString(),
      typedData: {
        domain: {
          name: "UVPStateMachine",
          version: "0.8",
          chainId,
          verifyingContract
        },
        primaryType: "UVPStateMachineSignal",
        message: {
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
      "orderId",
      "sourceId",
      "signalId",
      "payloadHash",
      "idempotencyKey",
      "submitter",
      "deadline"
    ]);
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
      signatureStatus: "not_verified",
      broadcastStatus: "not_attempted",
      errorCode: "submission_expired"
    });
    expect(broadcast.broadcast).not.toHaveBeenCalled();
  });

  it("rejects duplicate submit for the same prepared nonce", async () => {
    const fixture = await submissionFixture();
    const prepared = await prepare(fixture);
    const signature = await signPrepared(prepared);

    await fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    });

    await expect(fixture.service.submit(task.taskId, {
      prepareId: prepared.prepareId,
      walletAddress: submitter,
      signature
    })).rejects.toMatchObject({
      code: "prepare_already_used",
      status: 409
    });
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

  it("requires signal submissions to come from the active stage executor", async () => {
    const targetStageId = txHash("515");
    const overlayTask = {
      ...task,
      stageExecutorOverlay: {
        targetStageId,
        activeExecutorWallet: "0x2222222222222222222222222222222222222222"
      },
      proof: {
        stageIdentifier: targetStageId
      }
    } as ProductTaskDTO;
    const fixture = await submissionFixture({ task: overlayTask });

    await expect(fixture.service.prepareSubmit(overlayTask.taskId, {
      evidenceIds: [fixture.evidence.evidence.evidenceId],
      walletAddress: submitter,
      intent: "confirm_stage"
    }, owner)).rejects.toMatchObject({
      code: "submitter_wallet_not_active_executor",
      status: 403
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
  });

  it("rejects missing evidence before preparing a signed payload", async () => {
    const evidenceService = createEvidenceService({
      storage: new InMemoryEvidenceStorage(),
      now: () => baseNow
    });
    const service = createProductSubmissionService({
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
    const storage = new InMemoryEvidenceStorage();
    const evidenceService = createEvidenceService({
      storage,
      now: () => baseNow,
      evidenceIdFactory: () => "ev_mismatch"
    });
    const evidence = await uploadSubmissionEvidence(evidenceService, "customs-declaration", "customs declaration");
    await storage.delete(evidence.evidence.storageURI);
    await storage.put({
      evidenceId: evidence.evidence.evidenceId,
      bytes: new TextEncoder().encode("tampered customs declaration")
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
      storage: new InMemoryEvidenceStorage(),
      now: () => baseNow,
      evidenceIdFactory: sequentialIds(["ev_b", "ev_a"])
    });
    const firstEvidence = await uploadSubmissionEvidence(evidenceService, "manifest", "manifest payload");
    const secondEvidence = await uploadSubmissionEvidence(evidenceService, "customs-declaration", "customs payload");
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
    expect(JSON.stringify(submission.proofRows)).not.toContain("customs declaration");
    expect(JSON.stringify(submission.proofRows)).not.toContain("customs.txt");
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
      prepared.onchainOrderId,
      prepared.sourceId,
      prepared.signalId,
      prepared.payloadHash,
      prepared.idempotencyKey,
      prepared.submitter,
      BigInt(prepared.deadline),
      signature
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
      retryable: false,
      retryState: "dead_letter",
      deadLetter: true,
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
      deadLetter: false
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
      deadLetter: true
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
      errorCode: "broadcast_retry_blocked",
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
});

async function submissionFixture(options: {
  readonly now?: () => Date;
  readonly broadcastAdapter?: SubmissionBroadcastAdapter;
  readonly authorizedSubmitter?: Address;
  readonly authorization?: Parameters<typeof createProductSubmissionService>[0]["authorization"];
  readonly task?: ProductTaskDTO;
} = {}): Promise<{
  readonly service: ProductSubmissionService;
  readonly evidenceService: EvidenceService;
  readonly evidence: EvidenceUploadResponseDTO;
  readonly task: ProductTaskDTO;
}> {
  const now = options.now ?? (() => baseNow);
  const fixtureTask = options.task ?? task;
  const evidenceService = createEvidenceService({
    storage: new InMemoryEvidenceStorage(),
    now,
    evidenceIdFactory: () => "ev_1"
  });
  const evidence = await evidenceService.uploadEvidence({
    orderId: fixtureTask.orderId,
    taskId: fixtureTask.taskId,
    stageIdentifier: fixtureTask.stageId,
    documentType: "customs-declaration",
    fileName: "customs.txt",
    textPayload: "customs declaration",
    metadata: {
      businessLabel: "Customs declaration",
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
    chainId,
    verifyingContract,
    authorization,
    ...(options.broadcastAdapter ? { broadcastAdapter: options.broadcastAdapter } : {}),
    now,
    prepareIdFactory: () => "prep_1",
    submissionIdFactory: () => "sub_1",
    nonceFactory: () => "42"
  });
  return { service, evidenceService, evidence, task: fixtureTask };
}

function submissionServiceForEvidence(evidenceService: EvidenceService): ProductSubmissionService {
  return createProductSubmissionService({
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
