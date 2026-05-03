import { createPublicClient, defineChain, http } from "viem";
import { ORDER_INITIAL_TRIGGER_PERMISSION_ID } from "@uvp-eth/product-dto";
import type { GovernanceStore } from "../governance/store.js";
import type { GovernanceBroadcastStatus, GovernanceTxLogDTO, GovernanceTxLogStatus } from "../governance/types.js";
import {
  productSignalId,
  productSignalSourceId
} from "../product/bff/registration.js";
import type { ProductBffStore } from "../product/bff/store.js";
import type {
  ProductOrderDraftDTO,
  ProductOrderRegistrationRecord,
  ProductOrderRegistrationStatus,
  ProductOrderStartDTO,
  ProductOrderStartStatus
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
      startsChecked: 0,
      submissionsChecked: 0,
      governanceLogsChecked: 0,
      updated: 0,
      failed: 0
    };

    if (this.#productStore) {
      for (const registration of (await this.#productStore.listRegistrations()).filter(isReconcileableRegistration)) {
        summary.registrationsChecked += 1;
        const updated = await this.#reconcileRegistration(registration);
        if (updated) {
          summary.updated += 1;
          if (updated.status === "failed") {
            summary.failed += 1;
          }
        }
      }

      for (const start of (await this.#productStore.listOrderStartsForReconcile({
        statuses: ["pending", "submitted", "indexing"]
      })).filter(isReconcileableOrderStart)) {
        summary.startsChecked += 1;
        const updated = await this.#reconcileOrderStart(start);
        if (updated) {
          summary.updated += 1;
          if (updated.status === "failed") {
            summary.failed += 1;
          }
        }
      }
    }

    if (this.#submissionStore) {
      for (const submission of (await this.#submissionStore.listSubmissions()).filter(isReconcileableSubmission)) {
        summary.submissionsChecked += 1;
        const updated = await this.#reconcileSubmission(submission);
        if (updated) {
          summary.updated += 1;
          if (updated.status === "failed") {
            summary.failed += 1;
          }
        }
      }
    }

    if (this.#governanceStore) {
      const logs = [
        ...(await this.#governanceStore.listPlanAttestationLogs()),
        ...(await this.#governanceStore.listSupplierAttestationLogs())
      ].filter(isReconcileableGovernanceLog);
      for (const log of logs) {
        summary.governanceLogsChecked += 1;
        const updated = await this.#reconcileGovernanceLog(log);
        if (updated) {
          summary.updated += 1;
          if (updated.status === "failed") {
            summary.failed += 1;
          }
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
    registration: ProductOrderRegistrationRecord
  ): Promise<ProductOrderRegistrationRecord | undefined> {
    const outcome = await this.#resolveOutcome(registration, () => registrationProjectionConfirmation(
      this.#projectionStore,
      registration
    ));
    if (!outcome) {
      return undefined;
    }

    const updated: ProductOrderRegistrationRecord = {
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

  async #reconcileOrderStart(start: ProductOrderStartDTO): Promise<ProductOrderStartDTO | undefined> {
    if (!this.#productStore) {
      return undefined;
    }
    const outcome = await this.#resolveOutcome(start, () => orderStartProjectionConfirmation(
      this.#projectionStore,
      this.#productStore!,
      start
    ));
    if (!outcome) {
      return undefined;
    }

    return this.#productStore.updateOrderStart(start.startId, {
      status: startStatusFromOutcome(outcome, start.status),
      ...outcome.fields,
      ...(outcome.blockNumber ? { blockNumber: outcome.blockNumber } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      retryable: startRetryableFromOutcome(outcome),
      updatedAt: outcome.checkedAt
    });
  }

  async #reconcileSubmission(submission: ProductSubmissionDTO): Promise<ProductSubmissionDTO | undefined> {
    const outcome = await this.#resolveOutcome(submission, () => submissionProjectionConfirmation(
      this.#projectionStore,
      submission
    ));
    if (!outcome) {
      return undefined;
    }

    const submissionStatus = submissionStatusFromOutcome(outcome);
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
          registrationStatus: record.status as ProductOrderRegistrationStatus,
          checkedAt,
          fields: {
            reconcileStatus: "broadcasting",
            lastCheckedAt: checkedAt,
            receiptStatus: "not_checked",
            projectionStatus: "not_checked"
          },
          retryable: retryableOf(record)
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
        registrationStatus: record.status as ProductOrderRegistrationStatus,
        checkedAt,
        fields: {
          reconcileStatus: "submitted",
          lastCheckedAt: checkedAt,
          receiptStatus: "missing",
          projectionStatus: "not_checked"
        },
        retryable: retryableOf(record)
      };
    }

    const blockNumber = normalizeBlockNumber(receipt.blockNumber);
    if (receipt.status !== "success") {
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
  readonly registrationStatus: ProductOrderRegistrationStatus;
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

function isReconcileableRegistration(registration: ProductOrderRegistrationRecord): boolean {
  return registration.status === "pending" || registration.status === "indexing";
}

function isReconcileableOrderStart(start: ProductOrderStartDTO): boolean {
  return start.status === "pending" || start.status === "submitted" || start.status === "indexing";
}

function isReconcileableSubmission(submission: ProductSubmissionDTO): boolean {
  return submission.status === "broadcasting" || submission.status === "submitted" || submission.status === "indexing";
}

function isReconcileableGovernanceLog(log: GovernanceTxLogDTO): boolean {
  return log.status === "pending" || log.status === "broadcasting" || log.status === "indexing";
}

async function registrationProjectionConfirmation(
  projectionStore: ProjectionStore,
  registration: ProductOrderRegistrationRecord
): Promise<ProjectionConfirmation | undefined> {
  const order = await projectionStore.getStateMachineOrder(registration.orderId);
  if (!order?.registeredAt || order.planId.toLowerCase() !== registration.planId.toLowerCase()) {
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
  const order = await projectionStore.getStateMachineOrder(submission.onchainOrderId);
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

async function orderStartProjectionConfirmation(
  projectionStore: ProjectionStore,
  productStore: ProductBffStore,
  start: ProductOrderStartDTO
): Promise<ProjectionConfirmation | undefined> {
  const registration = await productStore.getRegistration(start.registrationId);
  const expected = registration ? initialTriggerProjectionTarget(registration) : undefined;
  if (!expected) {
    return undefined;
  }

  const order = await projectionStore.getStateMachineOrder(start.orderId);
  if (
    start.stateMachineAddress &&
    order?.contractAddress.toLowerCase() !== start.stateMachineAddress.toLowerCase()
  ) {
    return undefined;
  }
  const signal = order?.signals[`${expected.sourceId}:${expected.signalId}`];
  const matches = Boolean(
    signal &&
    signal.orderId === start.orderId &&
    signal.sourceId === expected.sourceId &&
    signal.signalId === expected.signalId &&
    signal.submitter === expected.submitter
  );
  return matches ? projectionConfirmationFromProvenance(signal?.submittedAt, start.txHash) : undefined;
}

function initialTriggerProjectionTarget(
  registration: ProductOrderRegistrationRecord
): { readonly sourceId: Hex; readonly signalId: Hex; readonly submitter: string } | undefined {
  const permission = registration.permissions.find((item) => item.permissionId === ORDER_INITIAL_TRIGGER_PERMISSION_ID);
  if (!permission) {
    return undefined;
  }
  const sourceId = productSignalSourceId(permission.source);
  const signalId = productSignalId(permission.signalName);
  const submitter = registration.authorizations.find((authorization) =>
    authorization.sourceId === sourceId &&
    authorization.signalId === signalId
  )?.submitter;
  return submitter ? { sourceId, signalId, submitter } : undefined;
}

async function governanceProjectionConfirmation(
  projectionStore: ProjectionStore,
  log: GovernanceTxLogDTO
): Promise<ProjectionConfirmation | undefined> {
  if (log.action === "attest_plan" || log.action === "revoke_plan") {
    const plans = await projectionStore.listPlanTrust({
      domainId: log.domainId,
      planId: log.planId
    });
    if (log.action === "attest_plan") {
      const plan = plans.find((plan) =>
        plan.planId === log.planId &&
        plan.domainId === log.domainId &&
        plan.planHash === log.planHash &&
        (!log.txHash || plan.attestedAt.transactionHash === log.txHash)
      );
      return projectionConfirmationFromProvenance(plan?.attestedAt, log.txHash);
    }
    const plan = plans.find((plan) =>
      plan.planId === log.planId &&
      plan.domainId === log.domainId &&
      plan.revoked &&
      (!log.txHash || plan.revokedAt?.transactionHash === log.txHash)
    );
    return projectionConfirmationFromProvenance(plan?.revokedAt, log.txHash);
  }

  const supplierLog = log as Extract<GovernanceTxLogDTO, { readonly action: "attest_supplier" | "revoke_supplier" }>;
  const suppliers = await projectionStore.listSupplierTrust({
    domainId: supplierLog.domainId,
    supplierSubjectId: supplierLog.supplierSubjectId
  });
  if (supplierLog.action === "attest_supplier") {
    const supplier = suppliers.find((supplier) =>
      supplier.domainId === supplierLog.domainId &&
      supplier.supplierSubjectId === supplierLog.supplierSubjectId &&
      (!supplierLog.wallet || supplier.wallet === supplierLog.wallet) &&
      (!supplierLog.txHash || supplier.attestedAt.transactionHash === supplierLog.txHash)
    );
    return projectionConfirmationFromProvenance(supplier?.attestedAt, supplierLog.txHash);
  }
  const supplier = suppliers.find((supplier) =>
    supplier.domainId === supplierLog.domainId &&
    supplier.supplierSubjectId === supplierLog.supplierSubjectId &&
    supplier.revoked &&
    (!supplierLog.txHash || supplier.revokedAt?.transactionHash === supplierLog.txHash)
  );
  return projectionConfirmationFromProvenance(supplier?.revokedAt, supplierLog.txHash);
}

function draftFromReconciledRegistration(
  draft: ProductOrderDraftDTO,
  registration: ProductOrderRegistrationRecord,
  updatedAt: string
): ProductOrderDraftDTO {
  if (registration.status === "confirmed") {
    return {
      ...draft,
      status: "registered",
      registeredOrderId: registration.orderId,
      ...(registration.txHash ? { registrationTxHash: registration.txHash } : {}),
      updatedAt
    };
  }
  if (registration.status === "failed" && registration.retryable) {
    return {
      ...draft,
      status: "ready_to_register",
      updatedAt
    };
  }
  return {
    ...draft,
    status: "registering",
    updatedAt
  };
}

function submissionStatusFromOutcome(outcome: ResolvedReconcileOutcome): ProductSubmissionDTO["status"] {
  switch (outcome.kind) {
    case "confirmed":
      return "confirmed";
    case "failed":
    case "stale_pending":
      return "failed";
    case "indexing":
      return "indexing";
    case "pending":
      return "submitted";
  }
}

function startStatusFromOutcome(
  outcome: ResolvedReconcileOutcome,
  current: ProductOrderStartStatus
): ProductOrderStartStatus {
  switch (outcome.kind) {
    case "confirmed":
      return "confirmed";
    case "failed":
    case "stale_pending":
      return "failed";
    case "indexing":
      return "indexing";
    case "pending":
      return current === "pending" || current === "indexing" ? current : "submitted";
  }
}

function startRetryableFromOutcome(outcome: ResolvedReconcileOutcome): boolean {
  return outcome.kind === "failed" || outcome.retryable;
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
