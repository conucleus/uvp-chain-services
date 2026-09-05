import { createPublicClient, defineChain, http } from "viem";
import type { GovernanceStore } from "../governance/store.js";
import type { GovernanceBroadcastStatus, GovernanceTxLogDTO, GovernanceTxLogStatus } from "../governance/types.js";
import type { ProductBffStore } from "../product/bff/store.js";
import type {
  ProductOrderDraftDTO,
  ProductOrderTriggerRecord,
  ProductOrderTriggerStatus
} from "../product/bff/types.js";
import type { Logger, Hex, LifecycleService } from "../shared/types.js";
import { noopLogger } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type { ProductSubmissionDTO, ProductSubmissionStore } from "../submissions/types.js";
import { redactErrorMessage } from "../security/redaction.js";
import type { ReconcileRunSummary, ReconcileWorkerDiagnostics, TxReconcileFields } from "./status.js";

export interface ReconcileWorkerConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly txTimeoutMs: number;
}

export interface ReconcileReceipt {
  readonly status?: "success" | "reverted" | "failed" | string;
  readonly blockNumber?: bigint | number | string;
}

export interface ReconcileReceiptClient {
  getTransactionReceipt(txHash: Hex): Promise<ReconcileReceipt | undefined>;
}

export interface ViemReconcileReceiptClientOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
}

export interface TxReconcileWorkerOptions {
  readonly config: ReconcileWorkerConfig;
  readonly receiptClient: ReconcileReceiptClient;
  readonly projectionStore: ProjectionStore;
  readonly productStore?: ProductBffStore;
  readonly submissionStore?: ProductSubmissionStore;
  readonly governanceStore?: GovernanceStore;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

type ReconcileableTxRecord = {
  readonly txHash?: Hex;
  readonly createdAt: string;
  readonly status: string;
};

export class TxReconcileWorker implements LifecycleService {
  readonly name = "tx-indexer-reconcile";

  readonly #config: ReconcileWorkerConfig;
  readonly #receiptClient: ReconcileReceiptClient;
  readonly #projectionStore: ProjectionStore;
  readonly #productStore: ProductBffStore | undefined;
  readonly #submissionStore: ProductSubmissionStore | undefined;
  readonly #governanceStore: GovernanceStore | undefined;
  readonly #logger: Logger;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #checking = false;
  #lastRunAt: string | undefined;
  #lastSummary: ReconcileRunSummary | undefined;
  #lastError: string | undefined;

  constructor(options: TxReconcileWorkerOptions) {
    this.#config = options.config;
    this.#receiptClient = options.receiptClient;
    this.#projectionStore = options.projectionStore;
    this.#productStore = options.productStore;
    this.#submissionStore = options.submissionStore;
    this.#governanceStore = options.governanceStore;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());
  }

  get running(): boolean {
    return this.#running;
  }

  getDiagnostics(): ReconcileWorkerDiagnostics {
    return {
      enabled: this.#config.enabled,
      running: this.#running,
      checking: this.#checking,
      pollIntervalMs: this.#config.pollIntervalMs,
      txTimeoutMs: this.#config.txTimeoutMs,
      ...(this.#lastRunAt ? { lastRunAt: this.#lastRunAt } : {}),
      ...(this.#lastSummary ? { lastSummary: this.#lastSummary } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {})
    };
  }

  async start(): Promise<void> {
    if (!this.#config.enabled) {
      this.#logger.info("reconcile worker disabled");
      return;
    }
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#logger.info("reconcile worker started", {
      pollIntervalMs: this.#config.pollIntervalMs,
      txTimeoutMs: this.#config.txTimeoutMs
    });

    void this.#runOnceSafely();
    if (this.#config.pollIntervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.#runOnceSafely();
      }, this.#config.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#logger.info("reconcile worker stopped");
  }

  async runOnce(): Promise<ReconcileRunSummary> {
    const summary = {
      registrationsChecked: 0,
      submissionsChecked: 0,
      governanceLogsChecked: 0,
      updated: 0,
      failed: 0
    };

    // 每条记录独立 try/catch：单条坏记录（缺字段/投影查询异常）只计失败
    // 并继续，不再把整轮（以及 /admin/ops/reconcile/run、retrySubmission）
    // 一起拖成 500。
    if (this.#productStore) {
      for (const registration of (await this.#productStore.listRegistrations()).filter(isReconcileableRegistration)) {
        summary.registrationsChecked += 1;
        try {
          const updated = await this.#reconcileRegistration(registration);
          if (updated) {
            summary.updated += 1;
            if (updated.status === "failed") {
              summary.failed += 1;
            }
          }
        } catch (error) {
          summary.failed += 1;
          this.#logger.warn("reconcile worker skipped a broken registration record", {
            triggerId: registration.triggerId,
            orderId: registration.orderId,
            message: redactErrorMessage(error)
          });
        }
      }
    }

    if (this.#submissionStore) {
      for (const submission of (await this.#submissionStore.listSubmissions()).filter(isReconcileableSubmission)) {
        summary.submissionsChecked += 1;
        try {
          const updated = await this.#reconcileSubmission(submission);
          if (updated) {
            summary.updated += 1;
            if (updated.status === "failed") {
              summary.failed += 1;
            }
          }
        } catch (error) {
          summary.failed += 1;
          this.#logger.warn("reconcile worker skipped a broken submission record", {
            submissionId: submission.submissionId,
            orderId: submission.orderId,
            message: redactErrorMessage(error)
          });
        }
      }
    }

    if (this.#governanceStore) {
      const logs = (await this.#governanceStore.listIdentityTxLogs())
        .filter(isReconcileableGovernanceLog);
      const actionable = logs.filter((log) => !isSimulatedGovernanceLog(log));
      const skippedSimulatedCount = logs.length - actionable.length;
      if (skippedSimulatedCount > 0) {
        this.#logger.warn("reconcile worker skipped simulated governance ledger entries; they never hit chain and cannot be reconciled", {
          skippedSimulatedCount
        });
      }
      for (const log of actionable) {
        summary.governanceLogsChecked += 1;
        try {
          const updated = await this.#reconcileGovernanceLog(log);
          if (updated) {
            summary.updated += 1;
            if (updated.status === "failed") {
              summary.failed += 1;
            }
          }
        } catch (error) {
          summary.failed += 1;
          this.#logger.warn("reconcile worker skipped a broken governance ledger record", {
            logId: log.logId,
            message: redactErrorMessage(error)
          });
        }
      }
    }

    this.#lastRunAt = this.#now().toISOString();
    this.#lastSummary = summary;
    this.#lastError = undefined;
    return summary;
  }

  async #runOnceSafely(): Promise<void> {
    if (this.#checking) {
      return;
    }
    this.#checking = true;
    try {
      const summary = await this.runOnce();
      this.#logger.info("reconcile worker run completed", { ...summary });
    } catch (error) {
      this.#lastRunAt = this.#now().toISOString();
      this.#lastError = redactErrorMessage(error);
      this.#logger.warn("reconcile worker run failed", {
        message: this.#lastError
      });
    } finally {
      this.#checking = false;
    }
  }

  async #reconcileRegistration(
    registration: ProductOrderTriggerRecord
  ): Promise<ProductOrderTriggerRecord | undefined> {
    const outcome = await this.#resolveOutcome(registration, () => registrationProjectionConfirmation(
      this.#projectionStore,
      registration
    ));
    if (!outcome) {
      return undefined;
    }

    const updated: ProductOrderTriggerRecord = {
      ...registration,
      status: outcome.registrationStatus,
      ...outcome.fields,
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: outcome.retryable,
      updatedAt: outcome.checkedAt
    };
    await this.#productStore?.updateRegistration(updated);

    const draft = await this.#productStore?.getDraft(registration.draftId);
    if (draft) {
      await this.#productStore?.updateDraft(draftFromReconciledRegistration(draft, updated, outcome.checkedAt));
    }

    return updated;
  }

  async #reconcileSubmission(submission: ProductSubmissionDTO): Promise<ProductSubmissionDTO | undefined> {
    const outcome = await this.#resolveOutcome(submission, () => submissionProjectionConfirmation(
      this.#projectionStore,
      submission
    ));
    if (!outcome) {
      return undefined;
    }

    const submissionStatus = submissionStatusFromOutcome(outcome, submission);
    const deadLetter = submissionDeadLetterFromOutcome(outcome, submissionStatus);
    const updated: ProductSubmissionDTO = {
      ...submission,
      status: submissionStatus,
      broadcastStatus: submissionStatus === "confirmed"
        ? "confirmed"
        : submissionStatus === "failed"
          ? "failed"
          : submission.broadcastStatus,
      ...outcome.fields,
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: outcome.retryable,
      retryState: submissionRetryStateFromOutcome(outcome, submissionStatus, deadLetter),
      deadLetter,
      attempts: updateSubmissionAttempts(submission, outcome),
      updatedAt: outcome.checkedAt
    };
    await this.#submissionStore?.putSubmission(updated);
    return updated;
  }

  async #reconcileGovernanceLog(log: GovernanceTxLogDTO): Promise<GovernanceTxLogDTO | undefined> {
    const outcome = await this.#resolveOutcome(log, () => governanceProjectionConfirmation(
      this.#projectionStore,
      log
    ));
    if (!outcome) {
      return undefined;
    }

    const status = governanceStatusFromOutcome(outcome);
    const updated: GovernanceTxLogDTO = {
      ...log,
      status,
      broadcastStatus: governanceBroadcastStatusFromOutcome(log.broadcastStatus, outcome),
      ...outcome.fields,
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: outcome.retryable,
      updatedAt: outcome.checkedAt
    };
    await this.#governanceStore?.updateTxLog(updated);
    return updated;
  }

  async #resolveOutcome(
    record: ReconcileableTxRecord,
    projectionConfirmation: () => Promise<ProjectionConfirmation | undefined>
  ): Promise<ResolvedReconcileOutcome | undefined> {
    const checkedAt = this.#now().toISOString();
    if (!record.txHash) {
      if (!timedOut(record, this.#config.txTimeoutMs, this.#now())) {
        return {
          kind: "pending",
          registrationStatus: record.status as ProductOrderTriggerStatus,
          checkedAt,
          fields: {
            reconcileStatus: "broadcasting",
            lastCheckedAt: checkedAt,
            receiptStatus: "not_checked",
            projectionStatus: "not_checked"
          },
          // No transaction hash means no chain fact has been observed yet;
          // this is a pending/reconcile condition regardless of the adapter's
          // original retry flag. It must not be dead-lettered as a permanent
          // broadcast failure.
          retryable: true
        };
      }
      return staleOutcome(checkedAt);
    }

    const projectedBeforeReceipt = await projectionConfirmation();
    if (projectedBeforeReceipt) {
      return confirmedOutcome(checkedAt, projectedBeforeReceipt.blockNumber);
    }

    const receipt = await this.#receiptClient.getTransactionReceipt(record.txHash);
    if (!receipt) {
      if (timedOut(record, this.#config.txTimeoutMs, this.#now())) {
        return staleOutcome(checkedAt);
      }
      return {
        kind: "pending",
        registrationStatus: record.status as ProductOrderTriggerStatus,
        checkedAt,
        fields: {
          reconcileStatus: "submitted",
          lastCheckedAt: checkedAt,
          receiptStatus: "missing",
          projectionStatus: "not_checked"
        },
        // A missing receipt is a temporary observation gap, not a reverted
        // transaction. Keep probing until the timeout lane takes over.
        retryable: true
      };
    }

    const blockNumber = normalizeBlockNumber(receipt.blockNumber);
    if (receipt.status === "reverted" || receipt.status === "failed") {
      return {
        kind: "failed",
        registrationStatus: "failed",
        checkedAt,
        fields: {
          reconcileStatus: "failed",
          lastCheckedAt: checkedAt,
          receiptStatus: "failed",
          projectionStatus: "not_checked"
        },
        ...(blockNumber ? { blockNumber } : {}),
        errorCode: "transaction_reverted",
        errorMessage: `transaction receipt status ${receipt.status ?? "failed"}`,
        retryable: false
      };
    }
    if (receipt.status !== "success") {
      // Receipt status is an open input at the RPC boundary. Unknown,
      // pending, or omitted values must remain pending/retryable; treating
      // them as a revert can isolate a transaction which is actually still
      // mining (or already successful on the canonical chain).
      return {
        kind: "pending",
        registrationStatus: record.status as ProductOrderTriggerStatus,
        checkedAt,
        fields: {
          reconcileStatus: "submitted",
          lastCheckedAt: checkedAt,
          receiptStatus: "unknown",
          projectionStatus: "not_checked"
        },
        ...(blockNumber ? { blockNumber } : {}),
        retryable: true
      };
    }

    const projected = await projectionConfirmation();
    if (!projected) {
      return {
        kind: "indexing",
        registrationStatus: "indexing",
        checkedAt,
        fields: {
          reconcileStatus: "indexing",
          lastCheckedAt: checkedAt,
          receiptStatus: "success",
          projectionStatus: "missing"
        },
        ...(blockNumber ? { blockNumber } : {}),
        retryable: false
      };
    }

    return confirmedOutcome(checkedAt, projected.blockNumber ?? blockNumber);
  }
}

function confirmedOutcome(checkedAt: string, blockNumber?: string): ResolvedReconcileOutcome {
  return {
    kind: "confirmed",
    registrationStatus: "confirmed",
    checkedAt,
    fields: {
      reconcileStatus: "confirmed",
      lastCheckedAt: checkedAt,
      receiptStatus: "success",
      projectionStatus: "present"
    },
    ...(blockNumber ? { blockNumber } : {}),
    retryable: false
  };
}

interface ProjectionConfirmation {
  readonly transactionHash: Hex;
  readonly blockNumber: string;
}

interface ProjectionProvenanceLike {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
}

function projectionConfirmationFromProvenance(
  provenance: ProjectionProvenanceLike | undefined,
  expectedTxHash: Hex | undefined
): ProjectionConfirmation | undefined {
  if (!provenance) {
    return undefined;
  }
  if (expectedTxHash && provenance.transactionHash.toLowerCase() !== expectedTxHash.toLowerCase()) {
    return undefined;
  }
  return {
    transactionHash: provenance.transactionHash,
    blockNumber: provenance.blockNumber.toString()
  };
}

export function createViemReconcileReceiptClient(
  options: ViemReconcileReceiptClientOptions
): ReconcileReceiptClient {
  const chain = defineChain({
    id: options.chainId,
    name: `uvp-${options.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } }
  });
  const client = createPublicClient({
    chain,
    transport: http(options.rpcUrl)
  });

  return {
    async getTransactionReceipt(txHash) {
      try {
        return await client.getTransactionReceipt({ hash: txHash });
      } catch (error) {
        if (isReceiptMissingError(error)) {
          return undefined;
        }
        throw error;
      }
    }
  };
}

interface ResolvedReconcileOutcome {
  readonly kind: "pending" | "indexing" | "confirmed" | "failed" | "stale_pending";
  readonly registrationStatus: ProductOrderTriggerStatus;
  readonly checkedAt: string;
  readonly fields: Required<Pick<TxReconcileFields, "reconcileStatus" | "lastCheckedAt" | "receiptStatus" | "projectionStatus">>;
  readonly blockNumber?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable: boolean;
}

function staleOutcome(checkedAt: string): ResolvedReconcileOutcome {
  return {
    kind: "stale_pending",
    registrationStatus: "failed",
    checkedAt,
    fields: {
      reconcileStatus: "stale_pending",
      lastCheckedAt: checkedAt,
      receiptStatus: "timeout",
      projectionStatus: "not_checked"
    },
    errorCode: "tx_reconcile_timeout",
    errorMessage: "transaction did not produce a receipt before the reconcile timeout",
    retryable: true
  };
}

function isReconcileableRegistration(registration: ProductOrderTriggerRecord): boolean {
  return registration.status === "submitted" || registration.status === "indexing";
}

function isReconcileableSubmission(submission: ProductSubmissionDTO): boolean {
  // 带 txHash 的 failed 必须复核回执：链上真相可能推翻本地失败标记
  // （回执成功且投影已呈现 → 自愈为 confirmed）。无 txHash 的 failed
  // 从未上链，没有回执可查。
  if (submission.status === "failed") {
    return Boolean(submission.txHash);
  }
  return submission.status === "broadcasting" || submission.status === "submitted" || submission.status === "indexing";
}

function isReconcileableGovernanceLog(log: GovernanceTxLogDTO): boolean {
  return log.status === "pending" || log.status === "broadcasting" || log.status === "indexing";
}

function isSimulatedGovernanceLog(log: GovernanceTxLogDTO): boolean {
  return log.executionMode === "simulated" || log.broadcastStatus === "simulated_tx";
}

async function registrationProjectionConfirmation(
  projectionStore: ProjectionStore,
  registration: ProductOrderTriggerRecord
): Promise<ProjectionConfirmation | undefined> {
  // 订单身份是 (planId, orderId)：registration.planId 必填（schema NOT NULL，
  // 无 legacy 空值路径），必须走复合键查询——裸 orderId 在同号订单跨 plan
  // 复用时永远查不中，registration 会永卡 indexing。
  const order = await projectionStore.getStateMachineOrder(
    registration.orderId,
    registration.planId
  );
  if (!order?.registeredAt) {
    return undefined;
  }
  if (
    registration.stateMachineAddress &&
    order.contractAddress.toLowerCase() !== registration.stateMachineAddress.toLowerCase()
  ) {
    return undefined;
  }
  return projectionConfirmationFromProvenance(order.registeredAt, registration.txHash);
}

async function submissionProjectionConfirmation(
  projectionStore: ProjectionStore,
  submission: ProductSubmissionDTO
): Promise<ProjectionConfirmation | undefined> {
  // The state-machine identity is (planId, orderId), not bare orderId. The
  // composite lookup never returns another plan's projection for this signed
  // submission.
  const order = await projectionStore.getStateMachineOrder(submission.onchainOrderId, submission.planId);
  if (!order) {
    return undefined;
  }
  const signal = order?.signals[`${submission.sourceId}:${submission.signalId}`];
  const matches = Boolean(
    signal &&
    signal.orderId === submission.onchainOrderId &&
    signal.sourceId === submission.sourceId &&
    signal.signalId === submission.signalId &&
    signal.submitter === submission.submitter &&
    signal.payloadHash === submission.payloadHash &&
    signal.idempotencyKey === submission.idempotencyKey
  );
  return matches ? projectionConfirmationFromProvenance(signal?.submittedAt, submission.txHash) : undefined;
}

async function governanceProjectionConfirmation(
  projectionStore: ProjectionStore,
  log: GovernanceTxLogDTO
): Promise<ProjectionConfirmation | undefined> {
  const identities = await projectionStore.listIdentityBindings({
    ...(log.bindingId ? { bindingId: log.bindingId } : {}),
    subjectId: log.subjectId
  });
  if (log.action === "register_identity") {
    const identity = identities.find((item) =>
      item.subjectId === log.subjectId &&
      (!log.account || item.account === log.account) &&
      (!log.txHash || item.registeredAt.transactionHash === log.txHash)
    );
    return projectionConfirmationFromProvenance(identity?.registeredAt, log.txHash);
  }
  const identity = identities.find((item) =>
    item.bindingId === log.bindingId &&
    item.status === "revoked" &&
    (!log.txHash || item.revokedAt?.transactionHash === log.txHash)
  );
  return projectionConfirmationFromProvenance(identity?.revokedAt, log.txHash);
}

function draftFromReconciledRegistration(
  draft: ProductOrderDraftDTO,
  registration: ProductOrderTriggerRecord,
  updatedAt: string
): ProductOrderDraftDTO {
  if (registration.status === "confirmed") {
    return {
      ...draft,
      status: "triggered",
      triggeredOrderId: registration.orderId,
      ...(registration.txHash ? { triggerTxHash: registration.txHash } : {}),
      updatedAt
    };
  }
  if (registration.status === "failed") {
    return {
      ...draft,
      status: "failed",
      updatedAt
    };
  }
  return {
    ...draft,
    status: "triggering",
    updatedAt
  };
}

function submissionStatusFromOutcome(
  outcome: ResolvedReconcileOutcome,
  submission: ProductSubmissionDTO
): ProductSubmissionDTO["status"] {
  switch (outcome.kind) {
    case "confirmed":
      return "confirmed";
    case "failed":
    case "stale_pending":
      return "failed";
    case "indexing":
      return "indexing";
    case "pending":
      // pending + 无 txHash = 仍在广播、回执未知：不得虚标 submitted
      // （投影不得替链说话），保持原状态（broadcasting）。有 txHash 的
      // pending 表示已广播、回执未落地，标 submitted 是如实的。
      return submission.txHash ? "submitted" : submission.status;
  }
}

function governanceStatusFromOutcome(outcome: ResolvedReconcileOutcome): GovernanceTxLogStatus {
  switch (outcome.kind) {
    case "confirmed":
      return "confirmed";
    case "failed":
    case "stale_pending":
      return "failed";
    case "indexing":
      return "indexing";
    case "pending":
      return "pending";
  }
}

function governanceBroadcastStatusFromOutcome(
  current: GovernanceBroadcastStatus,
  outcome: ResolvedReconcileOutcome
): GovernanceBroadcastStatus {
  switch (outcome.kind) {
    case "confirmed":
      return "confirmed";
    case "failed":
    case "stale_pending":
      return "failed";
    case "pending":
    case "indexing":
      return current === "broadcasting" ? "submitted" : current;
  }
}

function updateSubmissionAttempts(
  submission: ProductSubmissionDTO,
  outcome: ResolvedReconcileOutcome
): ProductSubmissionDTO["attempts"] {
  if (!submission.txHash) {
    return submission.attempts;
  }
  const attemptStatus = outcome.kind === "confirmed"
    ? "confirmed"
    : outcome.kind === "failed" || outcome.kind === "stale_pending"
      ? "failed"
      : "submitted";
  return submission.attempts.map((attempt) => {
    if (attempt.txHash !== submission.txHash) {
      return attempt;
    }
    const deadLetter = attemptStatus === "failed" && !outcome.retryable;
    return {
      ...attempt,
      status: attemptStatus,
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: outcome.retryable,
      retryState: attemptRetryStateFromOutcome(attemptStatus, outcome.retryable, deadLetter),
      deadLetter,
      updatedAt: outcome.checkedAt
    };
  });
}

function submissionDeadLetterFromOutcome(
  outcome: ResolvedReconcileOutcome,
  status: ProductSubmissionDTO["status"]
): boolean {
  return status === "failed" && !outcome.retryable;
}

function submissionRetryStateFromOutcome(
  outcome: ResolvedReconcileOutcome,
  status: ProductSubmissionDTO["status"],
  deadLetter: boolean
): ProductSubmissionDTO["retryState"] {
  if (deadLetter) {
    return "dead_letter";
  }
  if (outcome.retryable) {
    return "retryable";
  }
  if (status === "failed" || status === "expired") {
    return "not_retryable";
  }
  return "not_applicable";
}

function attemptRetryStateFromOutcome(
  status: ProductSubmissionDTO["attempts"][number]["status"],
  retryable: boolean,
  deadLetter: boolean
): ProductSubmissionDTO["attempts"][number]["retryState"] {
  if (deadLetter) {
    return "dead_letter";
  }
  if (retryable) {
    return "retryable";
  }
  if (status === "failed") {
    return "not_retryable";
  }
  return "not_applicable";
}

function retryableOf(record: ReconcileableTxRecord): boolean {
  return "retryable" in record && typeof record.retryable === "boolean" ? record.retryable : false;
}

function timedOut(record: ReconcileableTxRecord, timeoutMs: number, now: Date): boolean {
  if (timeoutMs <= 0) {
    return false;
  }
  const createdAtMs = Date.parse(record.createdAt);
  return Number.isFinite(createdAtMs) && now.getTime() - createdAtMs >= timeoutMs;
}

function normalizeBlockNumber(blockNumber: ReconcileReceipt["blockNumber"]): string | undefined {
  if (blockNumber === undefined) {
    return undefined;
  }
  return typeof blockNumber === "bigint" ? blockNumber.toString() : String(blockNumber);
}

function isReceiptMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  return /ReceiptNotFound|TransactionReceiptNotFound|not found/i.test(`${name} ${error.message}`);
}
