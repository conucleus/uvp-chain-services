import { randomBytes, randomUUID } from "node:crypto";
import { buildProductSubmitTypedData, recoverProductSubmitSigner } from "@uvp-eth/protocol-bindings";
import type { ProductTaskDTO } from "@uvp-eth/product-dto";
import { hashCanonicalJson } from "@uvp-eth/canonical-json";
import type { TxReconcileFields } from "../reconcile/status.js";
import { redactErrorMessage } from "../security/redaction.js";
import { noopAuditSink, type AuditSink } from "../security/audit.js";
import { assertHex, normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import { releaseRelayNonce, reserveRelayNonce } from "../relay/nonce.js";
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
import { classifyStateMachineBroadcastError } from "./broadcast-adapter.js";
import {
  factAttributionPayload,
  selectorBindingForTargetStage,
  zeroSelectorBinding,
  type PlanCapabilityTables
} from "./capability-proofs.js";
import type { EvidencePrincipal, EvidenceRecordDTO } from "../evidence/index.js";
import { ProductOrderLookupError } from "../product/application/service.js";

const DEFAULT_PREPARE_TTL_SECONDS = 10 * 60;

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

export type PriorSubmissionChainProbe =
  | { readonly outcome: "confirmed"; readonly txHash: Hex; readonly blockNumber?: string }
  | { readonly outcome: "absent" }
  | { readonly outcome: "unknown" };

export interface ProductSubmissionServiceOptions {
  readonly productTasks: ProductTaskReader;
  readonly evidenceReader: ProductSubmissionEvidenceReader;
  readonly chainId: number;
  readonly verifyingContract: Address;
  readonly authorization?: SubmissionAuthorizationAdapter;
  readonly broadcastAdapter?: SubmissionBroadcastAdapter;
  readonly store: ProductSubmissionStore;
  readonly probePriorSubmissionOnChain?: (
    prepared: PreparedSubmissionRecord
  ) => Promise<PriorSubmissionChainProbe>;
  readonly resolveOrderPlanId?: (onchainOrderId: Hex) => Promise<Hex | undefined>;
  readonly resolvePlanCapabilityTables?: (planId: Hex) => Promise<PlanCapabilityTables | undefined>;
  readonly resolveDraftOrder?: (draftId: string) => Promise<string | undefined>;
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
  getSubmission(
    submissionId: string,
    readerWallet: Address
  ): Promise<ProductSubmissionDTO | undefined>;
}

export function createProductSubmissionService(options: ProductSubmissionServiceOptions): ProductSubmissionService {
  const store = options.store;
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
      const verifyingContract = task.stateMachineAddress
        ? normalizeAddress(task.stateMachineAddress, "task.stateMachineAddress")
        : defaultVerifyingContract;
      const candidates = task.submitSignals ?? [];
      const requestedSignalName = input.signalName?.trim();
      let selectedSignal: { readonly signalName: string; readonly sourceId: Hex; readonly signalId: Hex } | undefined;
      if (requestedSignalName) {
        const matched = candidates.find(
          (candidate) =>
            candidate.signalName.toLowerCase() === requestedSignalName.toLowerCase() ||
            candidate.signalId.toLowerCase() === requestedSignalName.toLowerCase(),
        );
        selectedSignal = matched
          ? {
              signalName: matched.signalName,
              sourceId: normalizeBytes32(matched.sourceId, "submitSignal.sourceId"),
              signalId: normalizeBytes32(matched.signalId, "submitSignal.signalId"),
            }
          : undefined;
        if (!selectedSignal) {
          throw new ProductSubmissionError(
            400,
            "signal_not_available",
            "requested signal is not available on this task",
            { requestedSignalName, candidates: candidates.map((candidate) => candidate.signalName) },
          );
        }
      } else if (candidates.length === 1) {
        selectedSignal = {
          signalName: candidates[0]!.signalName,
          sourceId: normalizeBytes32(candidates[0]!.sourceId, "submitSignal.sourceId"),
          signalId: normalizeBytes32(candidates[0]!.signalId, "submitSignal.signalId"),
        };
      } else if (candidates.length > 1) {
        throw new ProductSubmissionError(
          409,
          "signal_selection_required",
          "this task can submit more than one signal; choose signalName explicitly",
          { candidates: candidates.map((candidate) => candidate.signalName) },
        );
      }
      const signalName = selectedSignal?.signalName ?? signalNameForIntent(input.intent);
      const chainSignal = chainSignalForTask(task, signalName, selectedSignal);
      const requiredSlots = requiredEvidenceSlotsForTask(task);
      const evidence = await resolveEvidence({
        evidenceReader: options.evidenceReader,
        evidenceIds: input.evidenceIds,
        requiredSlots,
        principal,
        orderId: task.orderId,
        taskId,
        stageIdentifier: task.stageId,
        ...(options.resolveDraftOrder ? { resolveDraftOrder: options.resolveDraftOrder } : {})
      });
      validateEvidenceSlots(requiredSlots, evidence);
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
      const { attribution, selectorBinding } = await resolveSubmissionCapabilityProofs(
        options.resolvePlanCapabilityTables,
        planId,
        chainSignal.sourceId,
        chainSignal.signalId
      );
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
        attribution,
        selectorBinding,
        authorization: {
          source: authResult.source
        },
        evidenceRecords: evidence
      };
      await store.deleteExpiredPrepared?.(
        String(Math.floor(createdAt.getTime() / 1000))
      );
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

      const signature = normalizeSignature(input.signature);
      const recoveredSubmitter = await recoverSignature(prepared, signature);
      if (recoveredSubmitter !== prepared.submitter) {
        throw new ProductSubmissionError(400, "invalid_signature", "signature recovery did not match prepared submitter", {
          recoveredSubmitter
        });
      }

      const currentSeconds = BigInt(Math.floor(now().getTime() / 1000));
      if (BigInt(prepared.deadline) < currentSeconds) {
        if (options.probePriorSubmissionOnChain) {
          let probe: PriorSubmissionChainProbe;
          try {
            probe = await options.probePriorSubmissionOnChain(prepared);
          } catch {
            probe = { outcome: "unknown" };
          }
          if (probe.outcome === "confirmed") {
            const submissionId = submissionIdFactory();
            const timestamp = now().toISOString();
            const submission = withSubmissionReconcileDefaults(submissionFromBroadcast(prepared, {
              submissionId,
              recoveredSubmitter,
              signatureHash: signatureHashFor(signature),
              createdAt: timestamp,
              broadcast: {
                status: "confirmed",
                txHash: probe.txHash,
                ...(probe.blockNumber ? { blockNumber: probe.blockNumber } : {})
              }
            }));
            await withSubmissionStoreTransaction(store, async () => {
              await store.putSubmission(submission);
              await store.markPreparedUsed(prepared.prepareId, submissionId, submission.updatedAt);
            });
            await audit.record({
              type: "relayer.submit.result",
              action: prepared.signalName,
              outcome: "succeeded",
              subject: {
                ...submissionAuditSubject(prepared),
                submissionId
              },
              txHash: probe.txHash,
              retryable: false,
              metadata: {
                recoveredBy: "ttl_expiry_chain_probe",
                message: "prepared submission deadline expired, but the chain projection already carries this business submission; the ledger follows the chain"
              }
            });
            return submission;
          }
          if (probe.outcome === "unknown") {
            const submissionId = submissionIdFactory();
            const timestamp = now().toISOString();
            const probeUnknown = withSubmissionReconcileDefaults(submissionFromBroadcast(prepared, {
              submissionId,
              recoveredSubmitter,
              signatureHash: signatureHashFor(signature),
              createdAt: timestamp,
              broadcast: {
                status: "failed",
                errorCode: "transaction_receipt_unknown",
                message: "prepared submission deadline expired and the chain probe could not determine whether the prior attempt landed; retry the same prepareId to probe again",
                retryable: true
              }
            }));
            await store.putSubmission(probeUnknown);
            await audit.record({
              type: "relayer.submit.result",
              action: prepared.signalName,
              outcome: "failed",
              subject: {
                ...submissionAuditSubject(prepared),
                submissionId
              },
              errorCode: "transaction_receipt_unknown",
              retryable: true
            });
            return probeUnknown;
          }
        }
        const expired = withSubmissionReconcileDefaults(
          buildExpiredSubmission(prepared, submissionIdFactory(), now().toISOString(), {
            recoveredSubmitter,
            signatureHash: signatureHashFor(signature)
          })
        );
        await withSubmissionStoreTransaction(store, async () => {
          await store.putSubmission(expired);
          await store.markPreparedUsed(prepared.prepareId, expired.submissionId, expired.updatedAt);
        });
        return expired;
      }

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
      const reserved = await reserveRelayNonce(store, nonceKey, {
        staleBefore: new Date(now().getTime() - ttlSeconds * 1000).toISOString()
      });
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
            await releaseRelayNonce(store, nonceKey);
            return;
          }
          await store.markPreparedUsed(prepared.prepareId, submissionId, submission.updatedAt);
        });
      } catch (error) {
        if (broadcastSubmissionId && broadcastTxHash) {
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
          }
          throw error;
        }
        const classifiedThrow = classifyStateMachineBroadcastError(error);
        await withSubmissionStoreTransaction(store, async () => {
          await store.putSubmission(withSubmissionReconcileDefaults(submissionFromBroadcast(prepared, {
            submissionId: submissionIdFactory(),
            recoveredSubmitter,
            signatureHash: signatureHashFor(signature),
            createdAt: now().toISOString(),
            broadcast: {
              status: "failed",
              errorCode: classifiedThrow.errorCode,
              message: classifiedThrow.message,
              retryable: classifiedThrow.retryable
            }
          })));
          await releaseRelayNonce(store, nonceKey);
        });
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
          }
        }
      }
      return submission;
    },

    async getSubmission(submissionId, readerWallet) {
      const submission = await store.getSubmission(submissionId);
      if (!submission) {
        return undefined;
      }
      if (submission.submitter.toLowerCase() !== readerWallet.toLowerCase()) {
        throw new ProductSubmissionError(
          403,
          "submission_access_forbidden",
          "only the submitter of this submission may read its profile",
          { submissionId }
        );
      }
      return withSubmissionReconcileDefaults(submission);
    }
  };
}

async function withSubmissionStoreTransaction<T>(
  store: ProductSubmissionStore,
  operation: () => Promise<T>
): Promise<T> {
  return store.withTransaction ? store.withTransaction(operation) : operation();
}

async function resolveSubmissionCapabilityProofs(
  resolvePlanCapabilityTables:
    | ((planId: Hex) => Promise<PlanCapabilityTables | undefined>)
    | undefined,
  planId: Hex,
  sourceId: Hex,
  signalId: Hex
): Promise<{
  readonly attribution: ReturnType<typeof factAttributionPayload>;
  readonly selectorBinding: ReturnType<typeof selectorBindingForTargetStage>;
}> {
  let tables: PlanCapabilityTables | undefined;
  try {
    tables = resolvePlanCapabilityTables
      ? await resolvePlanCapabilityTables(planId)
      : undefined;
  } catch (error) {
    throw new ProductSubmissionError(
      503,
      "capability_tables_unavailable",
      "plan capability tables could not be read from the plan artifact; refusing to prepare a plan-scoped submission without a verified vocabulary",
      { planId, sourceId, signalId, cause: redactErrorMessage(error) }
    );
  }
  if (!tables) {
    throw new ProductSubmissionError(
      503,
      "capability_tables_unavailable",
      "no verified plan artifact is projected for this plan; refusing to mint zero-value capability proofs for a plan-scoped submission",
      { planId, sourceId, signalId }
    );
  }
  const attribution = factAttributionPayload(tables, sourceId, signalId);
  if (attribution.stageId === ZERO_BYTES32) {
    return { attribution, selectorBinding: zeroSelectorBinding() };
  }
  return {
    attribution,
    selectorBinding: selectorBindingForTargetStage(tables, attribution.stageId)
  };
}

async function bindSubmittedEvidence(
  evidenceReader: ProductSubmissionEvidenceReader,
  prepared: PreparedSubmissionRecord,
  submission: ProductSubmissionDTO
): Promise<void> {
  if (!evidenceReader.bindEvidence || !submission.txHash) {
    return;
  }
  const binderPrincipal: EvidencePrincipal = {
    id: prepared.submitter.toLowerCase(),
    role: "participant"
  };
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
    }, binderPrincipal);
  }
}

function isEvidenceBindingSubmission(submission: ProductSubmissionDTO): boolean {
  return submission.status === "submitted" || submission.status === "confirmed";
}

export function signalNameForIntent(intent: ProductSubmitIntent): string {
  return intent;
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

function chainSignalForTask(
  task: ProductTaskDTO,
  signalName: string,
  selected?: { readonly sourceId: Hex; readonly signalId: Hex },
): {
  readonly orderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
} {
  if (selected) {
    return {
      orderId: normalizeBytes32(task.orderId, "orderId"),
      sourceId: selected.sourceId,
      signalId: selected.signalId,
    };
  }
  const chainTask = task as ProductTaskChainFields;
  const sourceId = firstBytes32(chainTask.proof?.sourceId) ??
    activeStageExecutorSourceIdForTask(chainTask);
  if (!sourceId) {
    throw new ProductSubmissionError(
      409,
      "order_plan_unresolved",
      "state-machine projection has no chain sourceId for this task's submit signal; refusing to fabricate one for a plan-scoped signal signature",
      { taskId: task.taskId }
    );
  }
  const signalId = firstBytes32(chainTask.proof?.signalId);
  if (!signalId) {
    throw new ProductSubmissionError(
      409,
      "order_plan_unresolved",
      `state-machine projection has no chain signalId for this task's ${signalName} signal; refusing to fabricate one for a plan-scoped signal signature`,
      { taskId: task.taskId }
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(task.orderId)) {
    throw new ProductSubmissionError(
      409,
      "order_plan_unresolved",
      "task does not carry an on-chain (bytes32) order id; refusing to sign a locally-derived order identity",
      { taskId: task.taskId, orderId: task.orderId }
    );
  }
  return {
    orderId: normalizeBytes32(task.orderId, "orderId"),
    sourceId,
    signalId
  };
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

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

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
  readonly requiredSlots: readonly RequiredEvidenceSlot[];
  readonly principal: EvidencePrincipal;
  readonly orderId: string;
  readonly taskId: string;
  readonly stageIdentifier: string;
  readonly resolveDraftOrder?: (draftId: string) => Promise<string | undefined>;
}): Promise<readonly EvidenceRecordDTO[]> {
  if (input.evidenceIds.length === 0) {
    if (input.requiredSlots.length === 0) {
      return [];
    }
    throw new ProductSubmissionError(400, "evidence_required", "at least one evidenceId is required");
  }

  const records: EvidenceRecordDTO[] = [];
  for (const evidenceId of uniqueNonEmpty(input.evidenceIds, "evidenceIds")) {
    const record = await input.evidenceReader.getEvidence(evidenceId, input.principal);
    if (!record) {
      throw new ProductSubmissionError(404, "evidence_not_found", `evidence not found: ${evidenceId}`);
    }
    await validateEvidenceRecord(record, input);
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

async function validateEvidenceRecord(
  record: EvidenceRecordDTO,
  expected: {
    readonly orderId: string;
    readonly taskId: string;
    readonly stageIdentifier: string;
    readonly resolveDraftOrder?: (draftId: string) => Promise<string | undefined>;
  }
): Promise<void> {
  const evidence = record.evidence;
  if (evidence.status !== "uploaded" && evidence.status !== "bound") {
    throw new ProductSubmissionError(409, "evidence_not_usable", "evidence status is not usable for submit", {
      evidenceId: evidence.evidenceId,
      status: evidence.status
    });
  }
  if (evidence.orderId) {
    if (evidence.orderId !== expected.orderId) {
      throw new ProductSubmissionError(409, "evidence_order_mismatch", "evidence belongs to a different order", {
        evidenceId: evidence.evidenceId
      });
    }
  } else {
    const draftOrder = evidence.draftId && expected.resolveDraftOrder
      ? await expected.resolveDraftOrder(evidence.draftId)
      : undefined;
    if (!draftOrder || draftOrder.toLowerCase() !== expected.orderId.toLowerCase()) {
      throw new ProductSubmissionError(409, "evidence_order_mismatch", "evidence is not bound to this order", {
        evidenceId: evidence.evidenceId,
        ...(evidence.draftId ? { draftId: evidence.draftId } : {})
      });
    }
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

interface RequiredEvidenceSlot {
  readonly documentType: string;
  readonly label: string;
}

function requiredEvidenceSlotsForTask(task: ProductTaskDTO): readonly RequiredEvidenceSlot[] {
  const slots: RequiredEvidenceSlot[] = [];
  const documentTypes = new Set<string>();
  for (const resource of task.resourceRequirements ?? []) {
    if (resource.required === false || resource.resourceType === "metadata") {
      continue;
    }
    const documentType = resource.resourceType ?? resource.resourceId;
    if (!documentType || documentTypes.has(documentType)) {
      continue;
    }
    documentTypes.add(documentType);
    slots.push({ documentType, label: resource.label ?? documentType });
  }
  return slots;
}

function validateEvidenceSlots(
  slots: readonly RequiredEvidenceSlot[],
  records: readonly EvidenceRecordDTO[]
): void {
  if (slots.length === 0) {
    return;
  }
  const documentTypes = new Set(records.map((record) => record.metadata.documentType));
  const missing = slots.filter((slot) => !documentTypes.has(slot.documentType));
  if (missing.length > 0) {
    throw new ProductSubmissionError(409, "evidence_slot_required", "required evidence slots are not satisfied", {
      missingSlots: missing.map((slot) => ({ documentType: slot.documentType, label: slot.label }))
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
  });
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
  return signalName;
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

function buildExpiredSubmission(
  prepared: PreparedSubmissionRecord,
  submissionId: string,
  timestamp: string,
  signature: {
    readonly recoveredSubmitter?: Address;
    readonly signatureHash?: Hex;
  }
): ProductSubmissionDTO {
  return {
    ...submissionCommon(prepared, { submissionId, createdAt: timestamp, ...signature }),
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

export function submissionStatusLabel(status: ProductSubmissionStatus): string {
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
    evidenceIds: prepared.evidence.map((record) => record.evidenceId),
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
  });
}

function signatureHashFor(signature: Hex): Hex {
  return hashCanonicalJson({
    kind: "uvp.product.submission.signature.v1",
    signature
  });
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
