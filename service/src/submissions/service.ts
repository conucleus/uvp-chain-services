import { randomBytes, randomUUID } from "node:crypto";
import { keccak256Hex, onchainSignalId, onchainSourceId } from "@uvp-eth/compiler";
import { buildProductSubmitTypedData, recoverProductSubmitSigner } from "@uvp-eth/protocol-bindings";
import type { ProductTaskDTO } from "@uvp-eth/product-dto";
import { hashCanonicalJson } from "../evidence/index.js";
import type { TxReconcileFields } from "../reconcile/status.js";
import { redactErrorMessage } from "../security/redaction.js";
import { noopAuditSink, type AuditSink } from "../security/audit.js";
import { assertHex, normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import { InMemoryProductSubmissionStore } from "./store.js";
import type {
  PreparedSubmissionDTO,
  PreparedSubmissionEvidenceDTO,
  PreparedSubmissionRecord,
  ProductSubmissionDTO,
  ProductSubmissionAttemptDTO,
  ProductSubmissionAttemptStatus,
  ProductSubmissionRetryState,
  ProductSubmissionEvidenceReader,
  ProductSubmissionStatus,
  ProductSubmissionStore,
  ProductSubmitHumanSummaryDTO,
  ProductSubmitIntent,
  ProductTaskReader,
  SubmissionAuthorizationAdapter,
  SubmissionAuthorizationRequest,
  SubmissionAuthorizationResult,
  SubmissionBroadcastAdapter,
  SubmissionBroadcastAttemptResult,
  SubmissionBroadcastResult,
  SubmitProductTaskInput,
  PrepareProductTaskSubmitInput
} from "./types.js";
import type { EvidencePrincipal, EvidenceRecordDTO } from "../evidence/index.js";
import { ProductOrderLookupError } from "../product/service.js";

const DEFAULT_PREPARE_TTL_SECONDS = 10 * 60;
const PRODUCT_SIGNAL_SOURCE = "product";

export class ProductSubmissionError extends Error {
  override readonly name = "ProductSubmissionError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface ProductSubmissionServiceOptions {
  readonly productTasks: ProductTaskReader;
  readonly evidenceReader: ProductSubmissionEvidenceReader;
  readonly chainId: number;
  readonly verifyingContract: Address;
  readonly authorization?: SubmissionAuthorizationAdapter;
  readonly broadcastAdapter?: SubmissionBroadcastAdapter;
  readonly store?: ProductSubmissionStore;
  /**
   * resolves the order planId for the on-chain order id from the
   * indexer projection (OrderRegistered/OrderMaterialized carry the indexed
   * planId). prepareSubmit refuses to build the plan-scoped signature when the
   * projection cannot supply a non-zero planId.
   */
  readonly resolveOrderPlanId?: (onchainOrderId: Hex) => Promise<Hex | undefined>;
  readonly now?: () => Date;
  readonly prepareTtlSeconds?: number;
  readonly prepareIdFactory?: () => string;
  readonly submissionIdFactory?: () => string;
  readonly nonceFactory?: () => string;
  readonly audit?: AuditSink;
}

export interface ProductSubmissionService {
  prepareSubmit(
    taskId: string,
    input: PrepareProductTaskSubmitInput,
    principal: EvidencePrincipal
  ): Promise<PreparedSubmissionDTO>;
  submit(taskId: string, input: SubmitProductTaskInput): Promise<ProductSubmissionDTO>;
  getSubmission(submissionId: string): Promise<ProductSubmissionDTO | undefined>;
}

export function createProductSubmissionService(options: ProductSubmissionServiceOptions): ProductSubmissionService {
  const store = options.store ?? new InMemoryProductSubmissionStore();
  const now = options.now ?? (() => new Date());
  const ttlSeconds = options.prepareTtlSeconds ?? DEFAULT_PREPARE_TTL_SECONDS;
  const prepareIdFactory = options.prepareIdFactory ?? (() => `prep_${randomUUID()}`);
  const submissionIdFactory = options.submissionIdFactory ?? (() => `sub_${randomUUID()}`);
  const nonceFactory = options.nonceFactory ?? randomNonce;
  const authorization = options.authorization ?? denyByDefaultSubmissionAuthorization();
  const broadcastAdapter = options.broadcastAdapter ?? notSupportedSubmissionBroadcastAdapter();
  const audit = options.audit ?? noopAuditSink;
  if (!Number.isInteger(options.chainId)) {
    throw new Error("chainId is required to create the product submission service");
  }
  if (!options.verifyingContract) {
    throw new Error("verifyingContract is required to create the product submission service");
  }
  const chainId = options.chainId;
  const defaultVerifyingContract = options.verifyingContract;

  return {
    async prepareSubmit(taskId, input, principal) {
      const task = await options.productTasks.getTask(taskId);
      if (!task) {
        throw new ProductSubmissionError(404, "product_task_not_found", "product task not found");
      }
      if (task.status !== "open") {
        throw new ProductSubmissionError(409, "task_not_submittable", "product task is not open for submit", {
          taskStatus: task.status
        });
      }

      const submitter = normalizeAddress(input.walletAddress, "walletAddress");
      ensureActiveStageExecutorSubmitter(task, submitter);
      const verifyingContract = task.stateMachineAddress
        ? normalizeAddress(task.stateMachineAddress, "task.stateMachineAddress")
        : defaultVerifyingContract;
      const signalName = signalNameForIntent(input.intent);
      const chainSignal = chainSignalForTask(task, signalName);
      const evidence = await resolveEvidence({
        evidenceReader: options.evidenceReader,
        evidenceIds: input.evidenceIds,
        principal,
        orderId: task.orderId,
        taskId,
        stageIdentifier: task.stageId
      });
      const payload = payloadForEvidence(evidence);
      const authRequest: SubmissionAuthorizationRequest = {
        task,
        orderId: task.orderId,
        taskId,
        stageIdentifier: task.stageId,
        signalName,
        onchainOrderId: chainSignal.orderId,
        sourceId: chainSignal.sourceId,
        signalId: chainSignal.signalId,
        intent: input.intent,
        submitter
      };
      const authResult = await authorization.authorize(authRequest);
      if (!authResult.authorized) {
        throw new ProductSubmissionError(403, "submitter_not_authorized", authResult.reason ?? "submitter is not authorized", {
          source: authResult.source
        });
      }

      // submitSignal is plan-scoped and the signature commits to
      // (planId, orderId). The planId comes from the indexer projection, never
      // from local fabrication; a missing planId must fail the prepare instead
      // of producing a signature that can only be rejected on chain. An
      // ambiguous bare order id (same orderId reused across plans) is rejected
      // as ambiguous_order_id instead of silently picking one plan.
      let resolvedPlanId: Hex | undefined;
      try {
        resolvedPlanId = options.resolveOrderPlanId
          ? await options.resolveOrderPlanId(chainSignal.orderId)
          : undefined;
      } catch (error) {
        if (error instanceof ProductOrderLookupError) {
          throw new ProductSubmissionError(
            409,
            "ambiguous_order_id",
            error.message,
            { orderId: chainSignal.orderId, details: error.details }
          );
        }
        throw error;
      }
      const planId = normalizeResolvedPlanId(resolvedPlanId);
      if (!planId) {
        throw new ProductSubmissionError(
          409,
          "order_plan_unresolved",
          "state-machine projection has no planId for this order; refusing to prepare a plan-scoped signal signature",
          { orderId: chainSignal.orderId }
        );
      }

      const createdAt = now();
      const deadlineSeconds = Math.floor(createdAt.getTime() / 1000) + ttlSeconds;
      const nonce = normalizeNonce(nonceFactory());
      const idempotencyKey = idempotencyKeyForPrepared({
        orderId: task.orderId,
        onchainOrderId: chainSignal.orderId,
        taskId,
        stageIdentifier: task.stageId,
        signalName,
        submitter,
        nonce
      });
      const typedData = buildProductSubmitTypedData({
        chainId,
        verifyingContract,
        planId,
        orderId: chainSignal.orderId,
        sourceId: chainSignal.sourceId,
        signalId: chainSignal.signalId,
        payloadHash: payload.payloadHash,
        idempotencyKey,
        submitter,
        deadline: deadlineSeconds.toString()
      });
      const prepareId = prepareIdFactory();
      const prepared: PreparedSubmissionRecord = {
        prepareId,
        taskId,
        orderId: task.orderId,
        onchainOrderId: chainSignal.orderId,
        planId,
        stageIdentifier: task.stageId,
        signalName,
        sourceId: chainSignal.sourceId,
        signalId: chainSignal.signalId,
        intent: input.intent,
        payloadHash: payload.payloadHash,
        payloadRef: payload.payloadRef,
        idempotencyKey,
        submitter,
        nonce,
        deadline: deadlineSeconds.toString(),
        expiresAt: new Date(deadlineSeconds * 1000).toISOString(),
        status: "prepared",
        humanSummary: humanSummaryForPrepared({
          taskTitle: task.title,
          orderId: task.orderId,
          stageIdentifier: task.stageName || task.stageId,
          signalName,
          intent: input.intent,
          payloadHash: payload.payloadHash,
          payloadRef: payload.payloadRef,
          submitter,
          expiresAt: new Date(deadlineSeconds * 1000).toISOString(),
          chainId,
          verifyingContract
        }),
        typedData,
        evidence: evidence.map((record) => evidenceSummary(record)),
        authorization: {
          source: authResult.source
        },
        evidenceRecords: evidence
      };
      await store.putPrepared(prepared);
      return dtoFromPreparedRecord(prepared);
    },

    async submit(taskId, input) {
      const prepared = await store.getPrepared(input.prepareId);
      if (!prepared) {
        throw new ProductSubmissionError(404, "prepare_not_found", "prepared submission not found");
      }
      if (prepared.taskId !== taskId) {
        throw new ProductSubmissionError(409, "prepare_task_mismatch", "prepared submission belongs to a different task");
      }
      if (prepared.usedAt || prepared.submissionId) {
        throw new ProductSubmissionError(409, "prepare_already_used", "prepared submission has already been used", {
          submissionId: prepared.submissionId
        });
      }

      const submitter = normalizeAddress(input.walletAddress, "walletAddress");
      if (submitter !== prepared.submitter) {
        throw new ProductSubmissionError(400, "wallet_mismatch", "walletAddress does not match prepared submitter");
      }

      const currentSeconds = BigInt(Math.floor(now().getTime() / 1000));
      if (BigInt(prepared.deadline) < currentSeconds) {
        const expired = withSubmissionReconcileDefaults(
          buildExpiredSubmission(prepared, submissionIdFactory(), now().toISOString())
        );
        await withSubmissionStoreTransaction(store, async () => {
          await store.putSubmission(expired);
          await store.markPreparedUsed(prepared.prepareId, expired.submissionId, expired.updatedAt);
        });
        return expired;
      }

      const signature = normalizeSignature(input.signature);
      const recoveredSubmitter = await recoverSignature(prepared, signature);
      if (recoveredSubmitter !== prepared.submitter) {
        throw new ProductSubmissionError(400, "invalid_signature", "signature recovery did not match prepared submitter", {
          recoveredSubmitter
        });
      }

      // Adapters that cannot broadcast must not consume the prepared
      // submission or its nonce: the signature is received and reported,
      // but no chain transaction was attempted and nothing is marked used.
      if (broadcastAdapter.attemptsBroadcast === false) {
        const submissionId = submissionIdFactory();
        const createdAt = now().toISOString();
        const signatureHash = signatureHashFor(signature);
        const broadcast = await broadcastAdapter.broadcast({
          prepared: dtoFromPreparedRecord(prepared),
          signature,
          recoveredSubmitter,
          evidence: prepared.evidenceRecords
        });
        const submission = withSubmissionReconcileDefaults(submissionFromBroadcast(prepared, {
          submissionId,
          recoveredSubmitter,
          signatureHash,
          createdAt,
          broadcast
        }));
        await store.putSubmission(submission);
        await audit.record({
          type: "relayer.submit.result",
          action: prepared.signalName,
          outcome: "skipped",
          subject: {
            ...submissionAuditSubject(prepared),
            submissionId
          },
          ...(submission.errorCode ? { errorCode: submission.errorCode } : {}),
          retryable: false
        });
        return submission;
      }

      const nonceKey = submissionNonceKey(prepared);
      const reserved = await store.reserveNonce(nonceKey);
      if (!reserved) {
        await audit.record({
          type: "relayer.submit.duplicate_nonce",
          action: prepared.signalName,
          outcome: "blocked",
          subject: submissionAuditSubject(prepared),
          errorCode: "duplicate_submit",
          retryable: false
        });
        throw new ProductSubmissionError(409, "duplicate_submit", "submission nonce has already been used");
      }

      // From here the nonce reservation is held. If the broadcast or durable
      // store write throws before a submission record exists, release it and
      // rethrow. A returned retryable failure without a txHash is likewise a
      // pre-broadcast observation: record the attempt, release the nonce, and
      // leave the prepare reusable. Any result carrying a txHash keeps the
      // reservation because the chain may already own that nonce.
      let submission: ProductSubmissionDTO;
      let broadcastSubmissionId: string | undefined;
      let broadcastTxHash: Hex | undefined;
      try {
        const submissionId = submissionIdFactory();
        const createdAt = now().toISOString();
        const signatureHash = signatureHashFor(signature);
        const broadcast = await broadcastAdapter.broadcast({
          prepared: dtoFromPreparedRecord(prepared),
          signature,
          recoveredSubmitter,
          evidence: prepared.evidenceRecords
        });
        submission = withSubmissionReconcileDefaults(submissionFromBroadcast(prepared, {
          submissionId,
          recoveredSubmitter,
          signatureHash,
          createdAt,
          broadcast
        }));
        broadcastSubmissionId = submissionId;
        broadcastTxHash = submission.txHash;
        await withSubmissionStoreTransaction(store, async () => {
          await store.putSubmission(submission);
          if (broadcast.status === "failed" && broadcast.retryable && !submission.txHash) {
            return;
          }
          await store.markPreparedUsed(prepared.prepareId, submissionId, submission.updatedAt);
        });
        if (broadcast.status === "failed" && broadcast.retryable && !submission.txHash) {
          await store.releaseNonce?.(nonceKey);
        }
      } catch (error) {
        if (broadcastSubmissionId && broadcastTxHash) {
          // 广播已成功（拿到 txHash）但持久化失败：链上交易可能已占用
          // nonce，不得释放。先尽力落一条 failed（persist_failed，带 txHash、
          // 回执未知如实报 not_checked）的提交档案保证台账可追溯，再上抛
          // 原始错误；落档本身失败也不能掩盖原始错误。
          try {
            await store.putSubmission(withSubmissionReconcileDefaults(submissionFromBroadcast(prepared, {
              submissionId: broadcastSubmissionId,
              recoveredSubmitter,
              signatureHash: signatureHashFor(signature),
              createdAt: now().toISOString(),
              broadcast: {
                status: "failed",
                txHash: broadcastTxHash,
                errorCode: "persist_failed",
                message: "broadcast succeeded but persisting the submission failed; the receipt is unknown and the nonce stays consumed",
                retryable: false,
                deadLetter: true
              }
            })));
          } catch {
            // 尽力而为：落档失败时保持原始错误继续上抛。
          }
          throw error;
        }
        // 广播本身抛错（未拿到 txHash）：未上链、未落档，释放 nonce 让同一
        // prepareId 保持可重试（基线 c64f4e8 行为）。
        await store.releaseNonce?.(nonceKey);
        throw error;
      }
      await audit.record({
        type: "relayer.submit.result",
        action: prepared.signalName,
        outcome: submission.status === "failed" ? "failed" : "succeeded",
        subject: {
          ...submissionAuditSubject(prepared),
          submissionId: submission.submissionId
        },
        ...(submission.txHash ? { txHash: submission.txHash } : {}),
        ...(submission.errorCode ? { errorCode: submission.errorCode } : {}),
        retryable: submission.retryable
      });
      if (isEvidenceBindingSubmission(submission)) {
        // CS-A4：链上广播已成功——绑定失败是服务端补账缺口，不得把已成功
        // 的提交以异常报成 500（违反信封契约）。返回成功提交结果，同时落
        // 审计事件供对账；prepare 已被消费，绑定补账走人工/reconcile 路径。
        try {
          await bindSubmittedEvidence(options.evidenceReader, prepared, submission);
        } catch (error) {
          try {
            await audit.record({
              type: "relayer.submit.evidence_bind_failed",
              action: prepared.signalName,
              outcome: "failed",
              subject: {
                ...submissionAuditSubject(prepared),
                submissionId: submission.submissionId,
                ...(submission.txHash ? { txHash: submission.txHash } : {})
              },
              errorCode: "evidence_bind_failed",
              retryable: true,
              metadata: {
                message: error instanceof Error ? redactErrorMessage(error) : "unknown evidence bind error"
              }
            });
          } catch {
            // 审计通道不可用不得改变提交响应语义。
          }
        }
      }
      return submission;
    },

    async getSubmission(submissionId) {
      const submission = await store.getSubmission(submissionId);
      return submission ? withSubmissionReconcileDefaults(submission) : undefined;
    }
  };
}

async function withSubmissionStoreTransaction<T>(
  store: ProductSubmissionStore,
  operation: () => Promise<T>
): Promise<T> {
  return store.withTransaction ? store.withTransaction(operation) : operation();
}

async function bindSubmittedEvidence(
  evidenceReader: ProductSubmissionEvidenceReader,
  prepared: PreparedSubmissionRecord,
  submission: ProductSubmissionDTO
): Promise<void> {
  if (!evidenceReader.bindEvidence || !submission.txHash) {
    return;
  }
  for (const evidence of prepared.evidenceRecords) {
    await evidenceReader.bindEvidence({
      evidenceId: evidence.evidence.evidenceId,
      submissionId: submission.submissionId,
      txHash: submission.txHash,
      orderId: prepared.orderId,
      onchainOrderId: prepared.onchainOrderId,
      sourceId: prepared.sourceId,
      signalId: prepared.signalId,
      boundAt: submission.updatedAt
    });
  }
}

function isEvidenceBindingSubmission(submission: ProductSubmissionDTO): boolean {
  return submission.status === "submitted" || submission.status === "confirmed";
}

export function signalNameForIntent(intent: ProductSubmitIntent): string {
  switch (intent) {
    case "confirm_stage":
      return "confirm_stage";
    case "reject_stage":
      return "reject_stage";
    case "raise_dispute":
      return "raise_dispute";
    case "resolve_dispute":
      return "resolve_dispute";
  }
}

type ProductTaskChainFields = ProductTaskDTO & {
  readonly stageExecutorOverlay?: {
    readonly targetStageId?: string;
    readonly activeExecutorWallet?: string;
  };
  readonly hookId?: string;
  readonly proof?: {
    readonly hookId?: string;
    readonly sourceId?: string;
    readonly signalId?: string;
    readonly stageIdentifier?: string;
    readonly targetStageId?: string;
  };
};

function chainSignalForTask(task: ProductTaskDTO, signalName: string): {
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
} {
  const chainTask = task as ProductTaskChainFields;
  const sourceId = firstBytes32(chainTask.proof?.sourceId) ??
    activeStageExecutorSourceIdForTask(chainTask) ??
    (onchainSourceId(PRODUCT_SIGNAL_SOURCE) as Hex);
  const signalId = firstBytes32(chainTask.proof?.signalId) ?? (onchainSignalId(`${task.stageId}.${signalName}`) as Hex);
  return {
    orderId: normalizeBytes32OrHash(task.orderId, "orderId"),
    sourceId,
    signalId
  };
}

function ensureActiveStageExecutorSubmitter(task: ProductTaskDTO, submitter: Address): void {
  const activeExecutorWallet = activeStageExecutorWalletForTask(task as ProductTaskChainFields);
  if (!activeExecutorWallet) {
    return;
  }
  const activeExecutor = normalizeAddress(activeExecutorWallet, "activeExecutorWallet");
  if (activeExecutor !== submitter) {
    throw new ProductSubmissionError(
      403,
      "submitter_wallet_not_active_executor",
      "wallet is not the active executor for this stage",
      { activeExecutorWallet: activeExecutor, submitter }
    );
  }
}

function activeStageExecutorSourceIdForTask(task: ProductTaskChainFields): Hex | undefined {
  if (!activeStageExecutorWalletForTask(task)) {
    return undefined;
  }
  return firstBytes32(
    task.stageExecutorOverlay?.targetStageId,
    task.executorOverlay?.targetStageId,
    task.proof?.targetStageId,
    task.proof?.stageIdentifier
  );
}

function activeStageExecutorWalletForTask(task: ProductTaskChainFields): string | undefined {
  return task.stageExecutorOverlay?.activeExecutorWallet ?? task.executorOverlay?.activeExecutorWallet;
}

function firstBytes32(...values: readonly (string | undefined)[]): Hex | undefined {
  for (const value of values) {
    if (value && /^0x[0-9a-fA-F]{64}$/.test(value)) {
      return normalizeBytes32(value, "bytes32");
    }
  }
  return undefined;
}

function normalizeBytes32OrHash(value: string, fieldName: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return normalizeBytes32(value, fieldName);
  }
  if (value.trim().length === 0) {
    throw new ProductSubmissionError(400, "invalid_chain_identifier", `${fieldName} is required`);
  }
  return keccak256Hex(value) as Hex;
}

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * the projection must supply a real, non-zero planId. Anything else
 * (undefined, malformed, or the zero placeholder) is treated as "unresolved" so
 * the zero placeholder can never be signed or broadcast.
 */
function normalizeResolvedPlanId(value: Hex | string | undefined): Hex | undefined {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return undefined;
  }
  const normalized = value.toLowerCase() as Hex;
  return normalized === ZERO_BYTES32 ? undefined : normalized;
}

export function notSupportedSubmissionBroadcastAdapter(): SubmissionBroadcastAdapter {
  return {
    attemptsBroadcast: false,
    async broadcast() {
      return {
        status: "not_attempted",
        errorCode: "broadcast_disabled",
        reason: "UVPStateMachine relayer broadcast is not configured; the signature was verified but no chain transaction was sent"
      };
    }
  };
}

export const noopSubmissionBroadcastAdapter = notSupportedSubmissionBroadcastAdapter;

export function denyByDefaultSubmissionAuthorization(): SubmissionAuthorizationAdapter {
  return {
    async authorize(): Promise<SubmissionAuthorizationResult> {
      return {
        authorized: false,
        source: "authorization_not_configured",
        reason: "submission authorization is not configured"
      };
    }
  };
}

export function permissiveProductProjectionAuthorization(): SubmissionAuthorizationAdapter {
  return {
    async authorize(): Promise<SubmissionAuthorizationResult> {
      return {
        authorized: true,
        source: "product_projection_demo"
      };
    }
  };
}

export function allowListedSubmissionAuthorization(
  entries: readonly {
    readonly orderId: string;
    readonly stageIdentifier: string;
    readonly signalName: string;
    readonly submitter: Address;
  }[]
): SubmissionAuthorizationAdapter {
  const keys = new Set(entries.map((entry) =>
    authorizationKey(entry.orderId, entry.stageIdentifier, entry.signalName, normalizeAddress(entry.submitter, "submitter"))
  ));
  return {
    async authorize(request) {
      const authorized = keys.has(authorizationKey(
        request.orderId,
        request.stageIdentifier,
        request.signalName,
        request.submitter
      ));
      return {
        authorized,
        source: "allow_list",
        ...(authorized ? {} : { reason: "submitter is not present in the submission allow list" })
      };
    }
  };
}

function dtoFromPreparedRecord(record: PreparedSubmissionRecord): PreparedSubmissionDTO {
  const { evidenceRecords: _evidenceRecords, usedAt: _usedAt, submissionId: _submissionId, ...dto } = record;
  return dto;
}

async function resolveEvidence(input: {
  readonly evidenceReader: ProductSubmissionEvidenceReader;
  readonly evidenceIds: readonly string[];
  readonly principal: EvidencePrincipal;
  readonly orderId: string;
  readonly taskId: string;
  readonly stageIdentifier: string;
}): Promise<readonly EvidenceRecordDTO[]> {
  if (input.evidenceIds.length === 0) {
    throw new ProductSubmissionError(400, "evidence_required", "at least one evidenceId is required");
  }

  const records: EvidenceRecordDTO[] = [];
  for (const evidenceId of uniqueNonEmpty(input.evidenceIds, "evidenceIds")) {
    const record = await input.evidenceReader.getEvidence(evidenceId, input.principal);
    if (!record) {
      throw new ProductSubmissionError(404, "evidence_not_found", `evidence not found: ${evidenceId}`);
    }
    validateEvidenceRecord(record, input);
    const proof = await input.evidenceReader.getProof(evidenceId, input.principal);
    if (!proof) {
      throw new ProductSubmissionError(404, "evidence_not_found", `evidence proof not found: ${evidenceId}`);
    }
    if (proof.verificationStatus !== "unbound" && proof.verificationStatus !== "matched") {
      throw new ProductSubmissionError(409, "evidence_not_usable", "evidence proof is not usable for submit", {
        evidenceId,
        verificationStatus: proof.verificationStatus
      });
    }
    records.push(record);
  }
  return records;
}

function validateEvidenceRecord(
  record: EvidenceRecordDTO,
  expected: {
    readonly orderId: string;
    readonly taskId: string;
    readonly stageIdentifier: string;
  }
): void {
  const evidence = record.evidence;
  if (evidence.status !== "uploaded" && evidence.status !== "bound") {
    throw new ProductSubmissionError(409, "evidence_not_usable", "evidence status is not usable for submit", {
      evidenceId: evidence.evidenceId,
      status: evidence.status
    });
  }
  if (evidence.orderId && evidence.orderId !== expected.orderId) {
    throw new ProductSubmissionError(409, "evidence_order_mismatch", "evidence belongs to a different order", {
      evidenceId: evidence.evidenceId
    });
  }
  if (evidence.taskId && evidence.taskId !== expected.taskId) {
    throw new ProductSubmissionError(409, "evidence_task_mismatch", "evidence belongs to a different task", {
      evidenceId: evidence.evidenceId
    });
  }
  if (evidence.stageIdentifier !== expected.stageIdentifier) {
    throw new ProductSubmissionError(409, "evidence_stage_mismatch", "evidence belongs to a different stage", {
      evidenceId: evidence.evidenceId
    });
  }
}

function payloadForEvidence(records: readonly EvidenceRecordDTO[]): { readonly payloadHash: Hex; readonly payloadRef: string } {
  if (records.length === 1) {
    return {
      payloadHash: records[0]!.evidence.payloadHash,
      payloadRef: records[0]!.evidence.payloadRef
    };
  }

  const documents = records
    .map((record) => ({
      evidenceId: record.evidence.evidenceId,
      payloadHash: record.evidence.payloadHash,
      payloadRef: record.evidence.payloadRef
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const payloadHash = hashCanonicalJson({
    kind: "uvp.product.submission.evidenceBundle.v1",
    evidence: documents
  }, "submission.payloadHash");
  return {
    payloadHash,
    payloadRef: `uvp-evidence-bundle://product/${payloadHash.slice(2)}`
  };
}

function evidenceSummary(record: EvidenceRecordDTO): PreparedSubmissionEvidenceDTO {
  return {
    evidenceId: record.evidence.evidenceId,
    payloadHash: record.evidence.payloadHash,
    payloadRef: record.evidence.payloadRef,
    verificationStatus: record.evidence.status === "bound" ? "matched" : "unbound"
  };
}

function humanSummaryForPrepared(input: {
  readonly taskTitle: string;
  readonly orderId: string;
  readonly stageIdentifier: string;
  readonly signalName: string;
  readonly intent: ProductSubmitIntent;
  readonly payloadHash: Hex;
  readonly payloadRef: string;
  readonly submitter: Address;
  readonly expiresAt: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}): ProductSubmitHumanSummaryDTO {
  return {
    purpose: "UVP product task submission",
    orderId: input.orderId,
    taskTitle: input.taskTitle,
    stage: input.stageIdentifier,
    action: actionLabel(input.intent, input.signalName),
    payloadHash: input.payloadHash,
    payloadRef: input.payloadRef,
    submitter: input.submitter,
    validUntil: input.expiresAt,
    chainId: input.chainId,
    verifyingContract: input.verifyingContract
  };
}

function actionLabel(intent: ProductSubmitIntent, signalName: string): string {
  switch (intent) {
    case "confirm_stage":
      return "confirm stage";
    case "reject_stage":
      return "reject stage";
    case "raise_dispute":
      return "raise dispute";
    case "resolve_dispute":
      return "resolve dispute";
    default:
      return signalName;
  }
}

async function recoverSignature(prepared: PreparedSubmissionRecord, signature: Hex): Promise<Address> {
  try {
    return await recoverProductSubmitSigner(prepared.typedData, signature);
  } catch (error) {
    throw new ProductSubmissionError(400, "invalid_signature", error instanceof Error ? error.message : "invalid signature");
  }
}

function submissionFromBroadcast(
  prepared: PreparedSubmissionRecord,
  input: {
    readonly submissionId: string;
    readonly recoveredSubmitter: Address;
    readonly signatureHash: Hex;
    readonly createdAt: string;
    readonly broadcast: SubmissionBroadcastResult;
  }
): ProductSubmissionDTO {
  const common = submissionCommon(prepared, {
    submissionId: input.submissionId,
    recoveredSubmitter: input.recoveredSubmitter,
    signatureHash: input.signatureHash,
    createdAt: input.createdAt
  });

  if (input.broadcast.status === "broadcasting") {
    const attempts = attemptsFromBroadcast(prepared, input.submissionId, input.createdAt, input.broadcast.attempt, {
      retryable: false,
      deadLetter: false
    });
    return {
      ...common,
      status: "broadcasting",
      statusLabel: submissionStatusLabel("broadcasting"),
      broadcastStatus: "broadcasting",
      ...(input.broadcast.txHash ? { txHash: input.broadcast.txHash } : {}),
      retryable: false,
      retryState: "not_applicable",
      deadLetter: false,
      attempts,
      attemptCount: attempts.length,
      proofRows: proofRows({
        status: "broadcasting",
        submitter: common.submitter,
        payloadHash: common.payloadHash,
        ...(input.broadcast.txHash ? { txHash: input.broadcast.txHash } : {})
      })
    };
  }

  if (input.broadcast.status === "submitted" || input.broadcast.status === "confirmed") {
    const attempts = attemptsFromBroadcast(prepared, input.submissionId, input.createdAt, input.broadcast.attempt ?? {
      status: input.broadcast.status,
      ...(input.broadcast.txHash ? { txHash: input.broadcast.txHash } : {}),
      ...(input.broadcast.blockNumber ? { blockNumber: input.broadcast.blockNumber } : {})
    }, {
      retryable: false,
      deadLetter: false
    });
    return {
      ...common,
      status: input.broadcast.status,
      statusLabel: submissionStatusLabel(input.broadcast.status),
      broadcastStatus: input.broadcast.status,
      txHash: input.broadcast.txHash,
      ...(input.broadcast.blockNumber ? { blockNumber: input.broadcast.blockNumber } : {}),
      retryable: false,
      retryState: "not_applicable",
      deadLetter: false,
      attempts,
      attemptCount: attempts.length,
      proofRows: proofRows({
        status: input.broadcast.status,
        submitter: common.submitter,
        payloadHash: common.payloadHash,
        txHash: input.broadcast.txHash
      })
    };
  }

  if (input.broadcast.status === "failed") {
    const retryable = input.broadcast.retryable;
    const deadLetter = input.broadcast.deadLetter ?? !retryable;
    const retryState = input.broadcast.retryState ?? retryStateFor({
      status: "failed",
      retryable,
      deadLetter
    });
    const txHash = input.broadcast.txHash ?? input.broadcast.attempt?.txHash;
    const blockNumber = input.broadcast.blockNumber ?? input.broadcast.attempt?.blockNumber;
    const errorLabel = input.broadcast.errorLabel ?? errorLabelFor(input.broadcast.errorCode);
    const attempts = attemptsFromBroadcast(prepared, input.submissionId, input.createdAt, input.broadcast.attempt ?? {
      status: "failed",
      ...(txHash ? { txHash } : {}),
      ...(blockNumber ? { blockNumber } : {}),
      errorCode: input.broadcast.errorCode,
      errorLabel,
      errorMessage: input.broadcast.message,
      retryable,
      retryState,
      deadLetter,
      ...(input.broadcast.nextRetryAt ? { nextRetryAt: input.broadcast.nextRetryAt } : {})
    }, {
      retryable,
      deadLetter
    });
    return {
      ...common,
      status: "failed",
      statusLabel: submissionStatusLabel("failed"),
      broadcastStatus: "failed",
      ...(txHash ? { txHash } : {}),
      ...(blockNumber ? { blockNumber } : {}),
      errorCode: input.broadcast.errorCode,
      errorLabel,
      errorMessage: input.broadcast.message,
      retryable,
      retryState,
      deadLetter,
      ...(input.broadcast.nextRetryAt ? { nextRetryAt: input.broadcast.nextRetryAt } : {}),
      attempts,
      attemptCount: attempts.length,
      proofRows: proofRows({
        status: "failed",
        submitter: common.submitter,
        payloadHash: common.payloadHash,
        ...(txHash ? { txHash } : {}),
        errorCode: input.broadcast.errorCode
      })
    };
  }

  return {
    ...common,
    status: "signature_received",
    statusLabel: submissionStatusLabel("signature_received"),
    broadcastStatus: "not_attempted",
    errorCode: input.broadcast.errorCode,
    errorMessage: input.broadcast.reason,
    retryable: false,
    retryState: "not_applicable",
    deadLetter: false,
    attempts: [],
    attemptCount: 0,
    proofRows: proofRows({
      status: "signature_received",
      submitter: common.submitter,
      payloadHash: common.payloadHash,
      errorCode: input.broadcast.errorCode
    })
  };
}

function buildExpiredSubmission(prepared: PreparedSubmissionRecord, submissionId: string, timestamp: string): ProductSubmissionDTO {
  return {
    ...submissionCommon(prepared, { submissionId, createdAt: timestamp }),
    status: "expired",
    statusLabel: submissionStatusLabel("expired"),
    broadcastStatus: "not_attempted",
    errorCode: "submission_expired",
    errorLabel: errorLabelFor("expired_signal_signature"),
    errorMessage: "prepared submission deadline has expired",
    retryable: false,
    retryState: "not_retryable",
    deadLetter: false,
    attempts: [],
    attemptCount: 0,
    proofRows: proofRows({
      status: "expired",
      submitter: prepared.submitter,
      payloadHash: prepared.payloadHash,
      errorCode: "submission_expired"
    })
  };
}

function submissionStatusLabel(status: ProductSubmissionStatus): string {
  switch (status) {
    case "prepared":
      return "已准备";
    case "signature_received":
      return "签名已接收";
    case "broadcasting":
      return "广播中";
    case "submitted":
      return "已提交";
    case "indexing":
      return "同步中";
    case "confirmed":
      return "已确认";
    case "failed":
      return "提交失败";
    case "expired":
      return "已过期";
    case "replaced":
      return "已替换";
  }
}

function withSubmissionReconcileDefaults(submission: ProductSubmissionDTO): ProductSubmissionDTO {
  const stored = submission as ProductSubmissionDTO & {
    readonly statusLabel?: string;
    readonly retryState?: ProductSubmissionRetryState;
    readonly deadLetter?: boolean;
    readonly retryable?: boolean;
  };
  const deadLetter = typeof stored.deadLetter === "boolean" ? stored.deadLetter : false;
  const retryable = typeof stored.retryable === "boolean" ? stored.retryable : false;
  return {
    ...defaultSubmissionReconcileFields(submission),
    ...submission,
    statusLabel: stored.statusLabel ?? submissionStatusLabel(submission.status),
    retryState: stored.retryState ?? retryStateFor({
      status: submission.status,
      retryable,
      deadLetter
    }),
    deadLetter
  };
}

function defaultSubmissionReconcileFields(submission: ProductSubmissionDTO): TxReconcileFields {
  if (submission.status === "confirmed") {
    return {
      reconcileStatus: "confirmed",
      receiptStatus: submission.txHash ? "success" : "not_checked",
      projectionStatus: "present"
    };
  }
  if (submission.status === "failed") {
    // failed + txHash ≠ 回执失败：只有广播适配器确认回执 reverted
    // （errorCode = transaction_reverted）才如实报 failed；其余带 txHash 的
    // 失败（回执未复核/回执等待抛错）回执未知，如实报 not_checked，
    // 交给 reconcile worker 复核。
    const receiptVerifiedFailed = submission.txHash !== undefined
      && submission.errorCode === "transaction_reverted";
    return {
      reconcileStatus: "failed",
      receiptStatus: receiptVerifiedFailed
        ? "failed"
        : submission.txHash && submission.errorCode === "transaction_receipt_unknown"
          ? "unknown"
          : "not_checked",
      projectionStatus: "not_checked"
    };
  }
  if (submission.status === "expired") {
    return {
      reconcileStatus: "failed",
      receiptStatus: "timeout",
      projectionStatus: "not_checked"
    };
  }
  if (submission.status === "indexing") {
    return {
      reconcileStatus: "indexing",
      receiptStatus: "success",
      projectionStatus: "missing"
    };
  }
  return {
    reconcileStatus: submission.txHash ? "submitted" : "broadcasting",
    receiptStatus: "not_checked",
    projectionStatus: "not_checked"
  };
}

function submissionCommon(
  prepared: PreparedSubmissionRecord,
  input: {
    readonly submissionId: string;
    readonly recoveredSubmitter?: Address;
    readonly signatureHash?: Hex;
    readonly createdAt: string;
  }
): Omit<
  ProductSubmissionDTO,
  "status" | "statusLabel" | "broadcastStatus" | "retryable" | "retryState" | "deadLetter" | "attempts" | "attemptCount" | "proofRows"
> {
  return {
    submissionId: input.submissionId,
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
    signatureStatus: input.recoveredSubmitter ? "signature_verified" : "not_verified",
    ...(input.signatureHash ? { signatureHash: input.signatureHash } : {}),
    ...(input.recoveredSubmitter ? { recoveredSubmitter: input.recoveredSubmitter } : {}),
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

function attemptsFromBroadcast(
  prepared: PreparedSubmissionRecord,
  submissionId: string,
  timestamp: string,
  attempt: SubmissionBroadcastAttemptResult | undefined,
  fallback: {
    readonly retryable: boolean;
    readonly deadLetter: boolean;
  }
): readonly ProductSubmissionAttemptDTO[] {
  if (!attempt) {
    return [];
  }
  const attemptNumber = attempt.attemptNumber ?? 1;
  const retryable = attempt.retryable ?? fallback.retryable;
  const deadLetter = attempt.deadLetter ?? fallback.deadLetter;
  const retryState = attempt.retryState ?? retryStateFor({
    status: attempt.status,
    retryable,
    deadLetter
  });
  const errorLabel = attempt.errorLabel ?? (attempt.errorCode ? errorLabelFor(attempt.errorCode) : undefined);
  return [{
    attemptId: `${submissionId}:${attemptNumber}`,
    submissionId,
    orderId: prepared.onchainOrderId,
    sourceId: prepared.sourceId,
    signalId: prepared.signalId,
    submitter: prepared.submitter,
    status: attempt.status,
    ...(attempt.txHash ? { txHash: attempt.txHash } : {}),
    ...(attempt.blockNumber ? { blockNumber: attempt.blockNumber } : {}),
    ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
    ...(errorLabel ? { errorLabel } : {}),
    ...(attempt.errorMessage ? { errorMessage: attempt.errorMessage } : {}),
    ...(attempt.revertReason ? { revertReason: attempt.revertReason } : {}),
    ...(attempt.gasPayer ? { gasPayer: attempt.gasPayer } : {}),
    attemptNumber,
    retryable,
    retryState,
    deadLetter,
    ...(attempt.nextRetryAt ? { nextRetryAt: attempt.nextRetryAt } : {}),
    createdAt: timestamp,
    updatedAt: timestamp
  }];
}

function retryStateFor(input: {
  readonly status: ProductSubmissionStatus | ProductSubmissionAttemptStatus;
  readonly retryable: boolean;
  readonly deadLetter: boolean;
}): ProductSubmissionRetryState {
  if (input.deadLetter) {
    return "dead_letter";
  }
  if (input.retryable) {
    return "retryable";
  }
  if (input.status === "failed" || input.status === "expired") {
    return "not_retryable";
  }
  return "not_applicable";
}

function errorLabelFor(errorCode: string): string {
  switch (errorCode) {
    case "unauthorized_signal_submitter":
      return "Submitter is not authorized";
    case "signal_already_exists":
      return "Signal was already submitted";
    case "unknown_order":
      return "Order is not registered yet";
    case "expired_signal_signature":
      return "Wallet signature expired";
    case "invalid_signal_signature":
      return "Wallet signature is invalid";
    case "chain_id_mismatch":
      return "RPC chain does not match configuration";
    case "relayer_insufficient_funds":
      return "Relayer gas payer needs funds";
    case "rpc_timeout":
      return "RPC request timed out";
    case "transaction_reverted":
      return "Transaction reverted";
    case "state_machine_broadcast_failed":
      return "Broadcast failed";
    case "broadcast_disabled":
      return "Broadcast disabled";
    case "broadcast_rate_limited":
      return "Broadcast is rate limited";
    case "broadcast_retry_blocked":
      return "Retry is blocked";
    case "broadcast_retry_exhausted":
      return "Retry limit reached";
    case "duplicate_tx_hash":
      return "Duplicate transaction hash";
    default:
      return errorCode;
  }
}

function proofRows(input: {
  readonly status: ProductSubmissionStatus;
  readonly submitter: Address;
  readonly payloadHash: Hex;
  readonly txHash?: Hex;
  readonly errorCode?: string;
}) {
  return [
    { label: "Submission status", value: input.status },
    { label: "Signature submitter", value: input.submitter },
    { label: "Payload hash", value: input.payloadHash },
    ...(input.txHash ? [{ label: "Transaction", value: input.txHash }] : []),
    ...(input.errorCode ? [{ label: "Relayer", value: input.errorCode }] : [])
  ];
}

function normalizeSignature(value: string): Hex {
  assertHex(value, "signature");
  return value.toLowerCase() as Hex;
}

function normalizeNonce(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ProductSubmissionError(500, "invalid_nonce_factory", "nonce factory must return a base-10 uint string");
  }
  return BigInt(value).toString(10);
}

function idempotencyKeyForPrepared(input: {
  readonly orderId: string;
  readonly onchainOrderId: Hex;
  readonly taskId: string;
  readonly stageIdentifier: string;
  readonly signalName: string;
  readonly submitter: Address;
  readonly nonce: string;
}): Hex {
  return hashCanonicalJson({
    kind: "uvp.product.submission.idempotency.v1",
    orderId: input.orderId,
    onchainOrderId: input.onchainOrderId,
    taskId: input.taskId,
    stageIdentifier: input.stageIdentifier,
    signalName: input.signalName,
    submitter: input.submitter,
    nonce: input.nonce
  }, "submission.idempotencyKey");
}

function signatureHashFor(signature: Hex): Hex {
  return hashCanonicalJson({
    kind: "uvp.product.submission.signature.v1",
    signature
  }, "submission.signatureHash");
}

function submissionAuditSubject(prepared: PreparedSubmissionRecord): Record<string, unknown> {
  return {
    prepareId: prepared.prepareId,
    taskId: prepared.taskId,
    orderId: prepared.orderId,
    onchainOrderId: prepared.onchainOrderId,
    stageIdentifier: prepared.stageIdentifier,
    signalName: prepared.signalName,
    idempotencyKey: prepared.idempotencyKey,
    submitter: prepared.submitter
  };
}

function randomNonce(): string {
  return BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10);
}

function uniqueNonEmpty(values: readonly string[], fieldName: string): readonly string[] {
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (normalized.length !== values.length) {
    throw new ProductSubmissionError(400, "invalid_body", `${fieldName} must not contain empty strings`);
  }
  return [...new Set(normalized)];
}

function submissionNonceKey(prepared: PreparedSubmissionRecord): string {
  return [
    prepared.submitter,
    prepared.orderId,
    prepared.stageIdentifier,
    prepared.signalName,
    prepared.nonce
  ].join(":").toLowerCase();
}

function authorizationKey(orderId: string, stageIdentifier: string, signalName: string, submitter: Address): string {
  return [orderId, stageIdentifier, signalName, submitter].join(":").toLowerCase();
}
