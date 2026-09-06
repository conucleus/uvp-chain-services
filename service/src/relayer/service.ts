import { loadConfigFromEnv } from "../config/index.js";
import { redactErrorMessage } from "../security/redaction.js";
import { isDirectRun } from "../shared/runtime.js";
import {
  ConfigError,
  assertHex,
  normalizeAddress,
  normalizeBytes32,
  consoleLogger,
  noopLogger,
  type Address,
  type Hex,
  type LifecycleService,
  type Logger
} from "../shared/types.js";
import type {
  BusinessSignatureVerifier,
  RelayFailureCategory,
  RelayNonceStore,
  RelayRequest,
  RelayRetryBudgetSnapshot,
  RelayRetryBudgetStore,
  RelayRetryState,
  RelayTransaction,
  RelaySubmission,
  RelaySubmissionStore,
  SignatureVerificationResult,
  TransactionSubmitter
} from "./types.js";

export class RelayRejection extends Error {
  override readonly name = "RelayRejection";

  readonly errorCode: string;
  readonly errorLabel: string;
  readonly failureCategory: RelayFailureCategory;
  readonly retryable: boolean;
  readonly retryState: RelayRetryState;
  readonly deadLetter: boolean;

  constructor(classification: RelayFailureClassification) {
    super(classification.message);
    this.errorCode = classification.errorCode;
    this.errorLabel = classification.errorLabel;
    this.failureCategory = classification.failureCategory;
    this.retryable = classification.retryable;
    this.retryState = classification.retryState;
    this.deadLetter = classification.deadLetter;
  }
}

export interface RelayerServiceOptions {
  readonly verifier: BusinessSignatureVerifier;
  readonly submitter: TransactionSubmitter;
  readonly nonceStore?: RelayNonceStore;
  readonly submissionStore?: RelaySubmissionStore;
  readonly now?: () => Date;
  readonly logger?: Logger;
  readonly maxInFlightPerOrder?: number;
  /** Maximum retries after the initial broadcast attempt. */
  readonly maxRetryAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  /** Optional durable retry projection, hydrated on every relay call. */
  readonly retryBudgetStore?: RelayRetryBudgetStore;
}

export interface RelayFailureClassification {
  readonly errorCode: string;
  readonly errorLabel: string;
  readonly message: string;
  readonly failureCategory: RelayFailureCategory;
  readonly retryable: boolean;
  readonly retryState: RelayRetryState;
  readonly deadLetter: boolean;
  readonly nextRetryAt?: string;
}

const DEFAULT_MAX_IN_FLIGHT_PER_ORDER = 1;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5_000;

export class RelayerService implements LifecycleService {
  readonly name = "relayer";

  #running = false;
  readonly #verifier: BusinessSignatureVerifier;
  readonly #submitter: TransactionSubmitter;
  readonly #nonceStore: RelayNonceStore | undefined;
  readonly #submissionStore: RelaySubmissionStore | undefined;
  readonly #now: () => Date;
  readonly #logger: Logger;
  readonly #maxInFlightPerOrder: number;
  readonly #maxRetryAttempts: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #retryBudgetStore: RelayRetryBudgetStore | undefined;
  readonly #inFlightByOrder = new Map<string, number>();
  readonly #failedAttemptsBySubmission = new Map<string, number>();
  readonly #lastSubmissionById = new Map<string, RelaySubmission>();
  readonly #terminalSubmissionIds = new Set<string>();

  constructor(options: RelayerServiceOptions) {
    this.#verifier = options.verifier;
    this.#submitter = options.submitter;
    this.#nonceStore = options.nonceStore;
    this.#submissionStore = options.submissionStore;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? noopLogger;
    this.#maxInFlightPerOrder = options.maxInFlightPerOrder ?? DEFAULT_MAX_IN_FLIGHT_PER_ORDER;
    this.#maxRetryAttempts = normalizeMaxRetryAttempts(options.maxRetryAttempts);
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.#retryBudgetStore = options.retryBudgetStore;
  }

  async start(): Promise<void> {
    this.#running = true;
    this.#logger.info("relayer started");
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#logger.info("relayer stopped");
  }

  async relay(request: RelayRequest): Promise<RelaySubmission> {
    try {
      validateRelayRequest(request, this.#now());
    } catch (error) {
      if (error instanceof RelayRejection) {
        throw error;
      }
      throw relayRejection({
        errorCode: "malformed_relay_payload",
        message: redactErrorMessage(error),
        failureCategory: "permanent",
        retryable: false,
        deadLetter: true
      });
    }

    const verification = await this.#verifier.verify(freezeRelayRequest(request));
    ensureVerifiedSigner(request, verification);

    const submissionKey = submissionId(request);
    const prior = await this.loadRetryState(submissionKey);
    const priorFailedAttempts = prior.failedAttempts;
    if (prior.lastSubmission && isTerminalSubmission(prior.lastSubmission)) {
      // A persisted final outcome is authoritative for this submission id. In
      // particular, do not turn a durable DLQ into duplicate_signer_nonce or
      // broadcast it again after a process restart.
      this.#terminalSubmissionIds.add(submissionKey);
      return prior.lastSubmission;
    }
    if (this.retryBudgetExhausted(priorFailedAttempts)) {
      const submission = failedSubmission(
        request,
        retryBudgetExhaustedFailure(),
        undefined,
        priorFailedAttempts,
        this.retryBudgetRemaining(priorFailedAttempts)
      );
      await this.persistOutcome(submissionKey, submission, priorFailedAttempts);
      this.#terminalSubmissionIds.add(submissionKey);
      return submission;
    }

    const reserved = await this.reserveNonce(request);
    if (!reserved) {
      const classification = relayFailure({
        errorCode: "duplicate_signer_nonce",
        message: "duplicate signer nonce",
        failureCategory: "duplicate",
        retryable: false,
        deadLetter: true
      });
      const submission = failedSubmission(request, classification, undefined, priorFailedAttempts, this.retryBudgetRemaining(priorFailedAttempts));
      await this.persistOutcome(submissionKey, submission, priorFailedAttempts);
      this.#terminalSubmissionIds.add(submissionKey);
      return submission;
    }

    if (!this.acquireOrder(request)) {
      await this.releaseNonce(request);
      const classification = relayFailure({
        errorCode: "order_relay_in_flight",
        message: "another relay submission is already in flight for this order",
        failureCategory: "retryable",
        retryable: true,
        deadLetter: false,
        ...this.retrySchedule(priorFailedAttempts)
      });
      const submission = failedSubmission(request, classification, undefined, priorFailedAttempts, this.retryBudgetRemaining(priorFailedAttempts));
      await this.persistOutcome(submissionKey, submission, priorFailedAttempts);
      return submission;
    }

    try {
      let transaction: RelayTransaction;
      try {
        transaction = await this.#submitter.submit(freezeRelayRequest(request));
      } catch (error) {
        const classification = this.applyRetryBudget(
          classifyRelaySubmitterError(error, this.retrySchedule(priorFailedAttempts)),
          priorFailedAttempts
        );
        if (classification.retryable) {
          // A submitter rejection carries no txHash, so the nonce is safe to
          // retry. This includes operator-recoverable insufficient-funds
          // failures; a funded relayer can retry the same signed payload.
          await this.releaseNonce(request);
        }

        const attemptNumber = priorFailedAttempts + 1;

        // "already known"/"nonce too low" 不等于失败：交易可能已经上链。
        // 先按候选 txHash 探回执，确认成功则按 submitted+txHash 记账
        //（nonce 视为已消费）；查不到才允许死信，并把探过的 txHash 留在
        // 台账供人工复核，避免把已上链交易永久标记 failed 误导参与方重签。
        if (classification.errorCode === "duplicate_transaction") {
          const resolved = await this.#resolveDuplicateTransaction(
            submissionKey,
            request,
            error,
            prior.lastSubmission?.txHash,
            attemptNumber
          );
          if (resolved) {
            return resolved;
          }
        }

        const unconfirmedTxHash = classification.errorCode === "duplicate_transaction"
          ? duplicateTransactionTxHashCandidates(error, prior.lastSubmission?.txHash)[0]
          : undefined;
        const submission = failedSubmission(
          request,
          classification,
          unconfirmedTxHash,
          attemptNumber,
          this.retryBudgetRemaining(attemptNumber)
        );
        await this.persistOutcome(
          submissionKey,
          submission,
          classification.retryable || classification.errorCode === "broadcast_retry_exhausted"
            ? attemptNumber
            : priorFailedAttempts
        );
        if (submission.deadLetter) {
          this.#terminalSubmissionIds.add(submissionKey);
        }
        return submission;
      }

      const attemptNumber = priorFailedAttempts + 1;
      const submission = submittedSubmission(
        request,
        transaction.txHash,
        attemptNumber
      );
      try {
        await this.record(submission);
        await this.saveRetryState(submissionKey, {
          failedAttempts: 0,
          lastSubmission: submission
        });
        this.#failedAttemptsBySubmission.delete(submissionKey);
        this.#lastSubmissionById.set(submissionKey, submission);
        this.#terminalSubmissionIds.delete(submissionKey);
        return submission;
      } catch (error) {
        // `submit` returned a txHash: the chain may already have consumed the
        // nonce. A ledger failure is therefore irreversible from this service's
        // point of view. Record a terminal, txHash-bearing fallback and keep
        // the nonce reserved before rethrowing the original persistence error.
        const persistFailure = failedSubmission(
          request,
          relayFailure({
            errorCode: "persist_failed",
            message: "relay broadcast succeeded but persisting the submission failed; the receipt is unknown and the nonce stays consumed",
            failureCategory: "broadcaster",
            retryable: false,
            deadLetter: true
          }),
          transaction.txHash,
          attemptNumber,
          this.retryBudgetRemaining(0)
        );
        this.#lastSubmissionById.set(submissionKey, persistFailure);
        this.#terminalSubmissionIds.add(submissionKey);
        this.#failedAttemptsBySubmission.delete(submissionKey);
        await this.bestEffortPersistAfterBroadcast(submissionKey, persistFailure, attemptNumber, error);
        throw error;
      }
    } finally {
      this.releaseOrder(request);
    }
  }

  get running(): boolean {
    return this.#running;
  }

  private async reserveNonce(request: RelayRequest): Promise<boolean> {
    if (!this.#nonceStore) {
      return true;
    }
    return this.#nonceStore.reserve(request.business.signer, request.business.nonce);
  }

  private async releaseNonce(request: RelayRequest): Promise<void> {
    await this.#nonceStore?.release?.(request.business.signer, request.business.nonce);
  }

  private async record(submission: RelaySubmission): Promise<void> {
    await this.#submissionStore?.record(submission);
  }

  /**
   * duplicate_transaction（already known / nonce too low）的回执裁决：
   * 交易可能已在链上。按候选 txHash（错误对象携带的哈希 + 该提交此前
   * 记录的 txHash）探回执；确认 success 则按 submitted 记账并返回，
   * 否则返回 undefined 走死信路径（复核通道：unconfirmed txHash 保留在
   * 台账上）。探针不可用（submitter 未实现）时同样走死信。
   */
  async #resolveDuplicateTransaction(
    submissionKey: string,
    request: RelayRequest,
    error: unknown,
    priorTxHash: Hex | undefined,
    attemptNumber: number
  ): Promise<RelaySubmission | undefined> {
    const getReceipt = this.#submitter.getTransactionReceipt;
    if (!getReceipt) {
      return undefined;
    }
    const candidates = duplicateTransactionTxHashCandidates(error, priorTxHash);
    for (const txHash of candidates) {
      let receipt: Awaited<ReturnType<NonNullable<TransactionSubmitter["getTransactionReceipt"]>>>;
      try {
        receipt = await getReceipt.call(this.#submitter, txHash);
      } catch (probeError) {
        this.#logger.warn("relayer duplicate-transaction receipt probe failed", {
          submissionId: submissionKey,
          txHash,
          message: probeError instanceof Error ? redactErrorMessage(probeError) : "unknown probe error"
        });
        continue;
      }
      if (receipt?.status === "success") {
        const submission = submittedSubmission(request, txHash, attemptNumber);
        try {
          await this.record(submission);
          await this.saveRetryState(submissionKey, {
            failedAttempts: 0,
            lastSubmission: submission
          });
          this.#failedAttemptsBySubmission.delete(submissionKey);
          this.#lastSubmissionById.set(submissionKey, submission);
          this.#terminalSubmissionIds.delete(submissionKey);
        } catch (persistError) {
          this.#logger.warn("relayer resolved duplicate transaction but persisting the outcome failed; the nonce stays consumed", {
            submissionId: submissionKey,
            txHash,
            message: persistError instanceof Error ? redactErrorMessage(persistError) : "unknown persist error"
          });
          throw persistError;
        }
        this.#logger.info("relayer resolved duplicate transaction via on-chain receipt", {
          submissionId: submissionKey,
          txHash
        });
        return submission;
      }
    }
    return undefined;
  }

  private async loadRetryState(submissionKey: string): Promise<RelayRetryBudgetSnapshot> {
    const localSubmission = this.#lastSubmissionById.get(submissionKey);
    const localTerminalSubmission = this.#terminalSubmissionIds.has(submissionKey)
      ? localSubmission
      : undefined;
    const localAttempts = this.#failedAttemptsBySubmission.get(submissionKey) ?? 0;
    const persistedBudget = this.#retryBudgetStore
      ? await this.#retryBudgetStore.load(submissionKey)
      : undefined;
    const persistedSubmission = await this.loadSubmission(submissionKey);
    const lastSubmission = persistedBudget?.lastSubmission
      ?? persistedSubmission
      ?? localTerminalSubmission
      ?? localSubmission;
    const persistedAttempts = persistedBudget?.failedAttempts ?? failedAttemptsFromSubmission(persistedSubmission);
    const failedAttempts = Math.max(localAttempts, persistedAttempts, failedAttemptsFromSubmission(lastSubmission));
    return {
      failedAttempts,
      ...(lastSubmission ? { lastSubmission } : {})
    };
  }

  private async loadSubmission(submissionKey: string): Promise<RelaySubmission | undefined> {
    if (!this.#submissionStore) {
      return undefined;
    }
    if (this.#submissionStore.load) {
      return this.#submissionStore.load(submissionKey);
    }
    if (this.#submissionStore.get) {
      return this.#submissionStore.get(submissionKey);
    }
    if (this.#submissionStore.list) {
      const submissions = await this.#submissionStore.list();
      return submissions.find((submission) => submission.id === submissionKey);
    }
    return undefined;
  }

  private async persistOutcome(
    submissionKey: string,
    submission: RelaySubmission,
    failedAttempts: number
  ): Promise<void> {
    this.#lastSubmissionById.set(submissionKey, submission);
    if (failedAttempts > 0) {
      this.#failedAttemptsBySubmission.set(submissionKey, failedAttempts);
    } else {
      this.#failedAttemptsBySubmission.delete(submissionKey);
    }
    await this.record(submission);
    await this.saveRetryState(submissionKey, { failedAttempts, lastSubmission: submission });
  }

  private async saveRetryState(submissionKey: string, snapshot: RelayRetryBudgetSnapshot): Promise<void> {
    await this.#retryBudgetStore?.save(submissionKey, snapshot);
  }

  private async bestEffortPersistAfterBroadcast(
    submissionKey: string,
    submission: RelaySubmission,
    failedAttempts: number,
    persistenceError: unknown
  ): Promise<void> {
    try {
      await this.record(submission);
      await this.saveRetryState(submissionKey, { failedAttempts, lastSubmission: submission });
    } catch (fallbackError) {
      this.#logger.error("relayer broadcast succeeded but durable failure record could not be written", {
        submissionId: submissionKey,
        error: redactErrorMessage(fallbackError),
        originalError: redactErrorMessage(persistenceError)
      });
    }
  }

  private retryBudgetExhausted(failedAttempts: number): boolean {
    // `maxRetryAttempts` is the number of retries after the initial
    // broadcast. Thus max=1 permits attempt 1 plus attempt 2; once two
    // failed attempts are persisted, the next call is exhausted.
    return Number.isFinite(this.#maxRetryAttempts) && failedAttempts > this.#maxRetryAttempts;
  }

  private retryBudgetRemaining(failedAttempts: number): number | undefined {
    if (!Number.isFinite(this.#maxRetryAttempts)) {
      return undefined;
    }
    const retriesConsumed = Math.max(failedAttempts - 1, 0);
    return Math.max(this.#maxRetryAttempts - retriesConsumed, 0);
  }

  private applyRetryBudget(
    classification: RelayFailureClassification,
    priorFailedAttempts: number
  ): RelayFailureClassification {
    // Only already-persisted failures count against the budget. The attempt
    // that just failed is attempt `priorFailedAttempts + 1`, which stays
    // within the initial + `maxRetryAttempts` allowance, so pre-counting it
    // would condemn the last permitted retry before its outcome is recorded.
    if (!classification.retryable || !this.retryBudgetExhausted(priorFailedAttempts)) {
      return classification;
    }
    return retryBudgetExhaustedFailure();
  }

  private acquireOrder(request: RelayRequest): boolean {
    if (this.#maxInFlightPerOrder <= 0) {
      return true;
    }
    const key = orderKey(request);
    const inFlight = this.#inFlightByOrder.get(key) ?? 0;
    if (inFlight >= this.#maxInFlightPerOrder) {
      return false;
    }
    this.#inFlightByOrder.set(key, inFlight + 1);
    return true;
  }

  private releaseOrder(request: RelayRequest): void {
    if (this.#maxInFlightPerOrder <= 0) {
      return;
    }
    const key = orderKey(request);
    const next = (this.#inFlightByOrder.get(key) ?? 1) - 1;
    if (next <= 0) {
      this.#inFlightByOrder.delete(key);
      return;
    }
    this.#inFlightByOrder.set(key, next);
  }

  private retrySchedule(failedAttempts: number): { readonly nextRetryAt?: string } {
    if (this.#retryBaseMs <= 0 || this.#retryMaxMs <= 0) {
      return {};
    }
    const delayMs = cappedExponentialBackoffMs(this.#retryBaseMs, this.#retryMaxMs, failedAttempts);
    return {
      nextRetryAt: new Date(this.#now().getTime() + delayMs).toISOString()
    };
  }
}

export class MemoryRelayNonceStore implements RelayNonceStore {
  readonly #reserved = new Set<string>();

  async reserve(signer: Address, nonce: string): Promise<boolean> {
    const key = nonceKey(signer, nonce);
    if (this.#reserved.has(key)) {
      return false;
    }
    this.#reserved.add(key);
    return true;
  }

  async release(signer: Address, nonce: string): Promise<void> {
    this.#reserved.delete(nonceKey(signer, nonce));
  }
}

/**
 * Small deterministic store for local runs and tests. Production deployments
 * should provide a durable RelaySubmissionStore implementation; the optional
 * `load` method is what lets RelayerService recover a final DLQ or retry count
 * after a restart.
 */
export class MemoryRelaySubmissionStore implements RelaySubmissionStore {
  readonly #submissions = new Map<string, RelaySubmission>();

  async record(submission: RelaySubmission): Promise<void> {
    this.#submissions.set(submission.id, submission);
  }

  async load(submissionId: string): Promise<RelaySubmission | undefined> {
    return this.#submissions.get(submissionId);
  }

  async get(submissionId: string): Promise<RelaySubmission | undefined> {
    return this.load(submissionId);
  }

  async list(): Promise<readonly RelaySubmission[]> {
    return [...this.#submissions.values()];
  }
}

export class MemoryRelayRetryBudgetStore implements RelayRetryBudgetStore {
  readonly #snapshots = new Map<string, RelayRetryBudgetSnapshot>();

  async load(submissionId: string): Promise<RelayRetryBudgetSnapshot | undefined> {
    return this.#snapshots.get(submissionId);
  }

  async save(submissionId: string, snapshot: RelayRetryBudgetSnapshot): Promise<void> {
    this.#snapshots.set(submissionId, snapshot);
  }
}

export function createRelayerService(options: RelayerServiceOptions): RelayerService {
  return new RelayerService(options);
}

const TX_HASH_LIKE = /^0x[0-9a-fA-F]{64}$/;

/**
 * duplicate_transaction 的候选 txHash（去重保序）：错误对象上携带的
 * txHash/transactionHash 字段（viem/节点错误常见），加上该提交此前记录
 * 的 txHash——"already known" 通常是同一签名载荷先前已广播。
 */
function duplicateTransactionTxHashCandidates(
  error: unknown,
  priorTxHash: Hex | undefined
): readonly Hex[] {
  const candidates: Hex[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && TX_HASH_LIKE.test(value)) {
      const normalized = value.toLowerCase() as Hex;
      if (!candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    }
  };
  collectTxHashLikeFields(error, push, 0);
  push(priorTxHash);
  return candidates;
}

function collectTxHashLikeFields(
  value: unknown,
  visit: (value: unknown) => void,
  depth: number
): void {
  if (depth > 4 || value == null) {
    return;
  }
  if (typeof value === "string") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTxHashLikeFields(item, visit, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["txHash", "transactionHash", "hash"]) {
    if (key in record) {
      visit(record[key]);
    }
  }
  for (const key of ["transaction", "cause", "error", "details"]) {
    if (key in record) {
      collectTxHashLikeFields(record[key], visit, depth + 1);
    }
  }
}

function validateRelayRequest(request: RelayRequest, now: Date): void {
  if (!request.business.orderId) {
    throw relayRejection({
      errorCode: "missing_order_id",
      message: "orderId is required",
      failureCategory: "permanent",
      retryable: false,
      deadLetter: true
    });
  }
  if (!request.business.nonce) {
    throw relayRejection({
      errorCode: "missing_nonce",
      message: "nonce is required",
      failureCategory: "permanent",
      retryable: false,
      deadLetter: true
    });
  }
  if (request.business.deadline < BigInt(Math.floor(now.getTime() / 1000))) {
    throw relayRejection({
      errorCode: "expired_payload_deadline",
      message: "payload deadline has expired",
      failureCategory: "permanent",
      retryable: false,
      deadLetter: true
    });
  }

  normalizeAddress(request.business.signer, "business.signer");
  normalizeAddress(request.business.verifyingContract, "business.verifyingContract");
  assertHex(request.typedData.signature, "typedData.signature");

  if (request.business.evidenceHash) {
    normalizeBytes32(request.business.evidenceHash, "business.evidenceHash");
  }
  if (request.business.metadataHash) {
    normalizeBytes32(request.business.metadataHash, "business.metadataHash");
  }
}

function ensureVerifiedSigner(request: RelayRequest, result: SignatureVerificationResult): void {
  if (!result.valid) {
    throw relayRejection({
      errorCode: "invalid_business_signature",
      message: result.reason ?? "invalid business signature",
      failureCategory: "authorization",
      retryable: false,
      deadLetter: true
    });
  }
  if (!result.signer) {
    throw relayRejection({
      errorCode: "missing_verified_signer",
      message: "signature verifier did not return signer",
      failureCategory: "authorization",
      retryable: false,
      deadLetter: true
    });
  }

  const expected = normalizeAddress(request.business.signer, "business.signer");
  const actual = normalizeAddress(result.signer, "verified signer");
  if (actual !== expected) {
    throw relayRejection({
      errorCode: "verified_signer_mismatch",
      message: "verified signer does not match payload signer",
      failureCategory: "authorization",
      retryable: false,
      deadLetter: true
    });
  }
}

export function classifyRelaySubmitterError(
  error: unknown,
  schedule: { readonly nextRetryAt?: string } = {}
): RelayFailureClassification {
  const name = findErrorName(error);
  const text = errorText(error);
  const haystack = `${name ?? ""} ${text}`;

  if (/UnauthorizedSignalSubmitter/i.test(haystack)) {
    return relayFailure({
      errorCode: "unauthorized_signal_submitter",
      message: "submitter is not authorized to relay this signal",
      failureCategory: "authorization",
      retryable: false,
      deadLetter: true
    });
  }
  if (/InvalidSignalSignature/i.test(haystack)) {
    return relayFailure({
      errorCode: "invalid_business_signature",
      message: "participant signature does not match the relayed payload",
      failureCategory: "authorization",
      retryable: false,
      deadLetter: true
    });
  }
  if (/ExpiredSignalSignature|deadline has expired/i.test(haystack)) {
    return relayFailure({
      errorCode: "expired_payload_deadline",
      message: "payload deadline has expired",
      failureCategory: "permanent",
      retryable: false,
      deadLetter: true
    });
  }
  if (/SignalAlreadyExists/i.test(haystack)) {
    return relayFailure({
      errorCode: "signal_already_exists",
      message: "signal has already been submitted for this order",
      failureCategory: "duplicate",
      retryable: false,
      deadLetter: true
    });
  }
  if (/nonce too low|replacement transaction underpriced|already known/i.test(haystack)) {
    return relayFailure({
      errorCode: "duplicate_transaction",
      message: "broadcaster reported a duplicate or already-used transaction nonce",
      failureCategory: "duplicate",
      retryable: false,
      deadLetter: true
    });
  }
  if (/insufficient[ _-]?funds/i.test(haystack)) {
    return relayFailure({
      errorCode: "relayer_insufficient_funds",
      message: "relayer gas payer has insufficient funds",
      failureCategory: "broadcaster",
      // Funding the gas payer is an operator-recoverable condition. The
      // submitter did not return a txHash, so the caller may retry the same
      // signed payload after the balance is restored.
      retryable: true,
      deadLetter: false,
      ...schedule
    });
  }
  if (/chain.?id mismatch|wrong chain/i.test(haystack)) {
    return relayFailure({
      errorCode: "chain_id_mismatch",
      message: "configured chain does not match the broadcaster RPC",
      failureCategory: "broadcaster",
      retryable: false,
      deadLetter: true
    });
  }
  // UnknownOrder 必须先于泛 reverted 判定：viem 的合约执行错误文本同时含
  // "reverted." 与 "Error: UnknownOrder()"，泛规则在前会把"订单尚未注册"
  // 的典型瞬态永久死信（与 submissions 的 broadcast-adapter 分类口径一致）。
  if (/UnknownOrder/i.test(haystack)) {
    return relayFailure({
      errorCode: "unknown_order",
      message: "order is not registered on the state machine yet",
      failureCategory: "retryable",
      retryable: true,
      deadLetter: false,
      ...schedule
    });
  }
  // 其余 revert（真实执行失败）仍按永久失败处理；顺序保证复合文本
  // （"reverted." + "Error: UnknownOrder()"）先命中瞬态 UnknownOrder。
  if (/execution reverted|transaction reverted|reverted/i.test(haystack)) {
    return relayFailure({
      errorCode: "transaction_reverted",
      message: "relay transaction reverted before submission could be accepted",
      failureCategory: "permanent",
      retryable: false,
      deadLetter: true
    });
  }
  if (/timeout|timed out|ETIMEDOUT|AbortError|ECONNRESET|ECONNREFUSED|rate.?limit|429|rpc unavailable|network/i.test(haystack)) {
    return relayFailure({
      errorCode: "rpc_unavailable",
      message: "RPC or broadcaster request failed before the relay transaction was accepted",
      failureCategory: "retryable",
      retryable: true,
      deadLetter: false,
      ...schedule
    });
  }

  return relayFailure({
    errorCode: "relay_broadcast_failed",
    message: text || "relay broadcast failed",
    failureCategory: "retryable",
    retryable: true,
    deadLetter: false,
    ...schedule
  });
}

function submittedSubmission(
  request: RelayRequest,
  txHash: Hex,
  attemptNumber?: number,
  retryBudgetRemaining?: number
): RelaySubmission {
  return {
    ...submissionBase(request),
    status: "submitted",
    txHash,
    ...(attemptNumber !== undefined ? { attemptNumber } : {}),
    ...(attemptNumber !== undefined ? { attemptCount: attemptNumber } : {}),
    ...(retryBudgetRemaining !== undefined ? { retryBudgetRemaining } : {}),
    retryable: false,
    retryState: "not_applicable",
    deadLetter: false
  };
}

function failedSubmission(
  request: RelayRequest,
  classification: RelayFailureClassification,
  txHash?: Hex,
  attemptNumber?: number,
  retryBudgetRemaining?: number
): RelaySubmission {
  return {
    ...submissionBase(request),
    status: "failed",
    ...(txHash ? { txHash } : {}),
    ...(attemptNumber !== undefined ? { attemptNumber } : {}),
    ...(attemptNumber !== undefined ? { attemptCount: attemptNumber } : {}),
    ...(retryBudgetRemaining !== undefined ? { retryBudgetRemaining } : {}),
    errorCode: classification.errorCode,
    errorLabel: classification.errorLabel,
    error: classification.message,
    failureCategory: classification.failureCategory,
    retryable: classification.retryable,
    retryState: classification.retryState,
    deadLetter: classification.deadLetter,
    ...(classification.nextRetryAt ? { nextRetryAt: classification.nextRetryAt } : {})
  };
}

function submissionBase(request: RelayRequest): Omit<
  RelaySubmission,
  | "status"
  | "txHash"
  | "errorCode"
  | "errorLabel"
  | "error"
  | "attemptNumber"
  | "attemptCount"
  | "retryBudgetRemaining"
  | "failureCategory"
  | "retryable"
  | "retryState"
  | "deadLetter"
  | "nextRetryAt"
> {
  return {
    id: submissionId(request),
    chainId: request.business.chainId,
    verifyingContract: request.business.verifyingContract,
    orderId: request.business.orderId,
    ...(request.business.stageId ? { stageId: request.business.stageId } : {}),
    signer: request.business.signer,
    nonce: request.business.nonce
  };
}

function relayRejection(input: {
  readonly errorCode: string;
  readonly message: string;
  readonly failureCategory: RelayFailureCategory;
  readonly retryable: boolean;
  readonly deadLetter: boolean;
}): RelayRejection {
  return new RelayRejection(relayFailure(input));
}

function relayFailure(input: {
  readonly errorCode: string;
  readonly message: string;
  readonly failureCategory: RelayFailureCategory;
  readonly retryable: boolean;
  readonly deadLetter?: boolean;
  readonly nextRetryAt?: string;
}): RelayFailureClassification {
  const deadLetter = input.deadLetter ?? !input.retryable;
  return {
    errorCode: input.errorCode,
    errorLabel: errorLabelForRelayError(input.errorCode),
    message: redactErrorMessage(input.message),
    failureCategory: input.failureCategory,
    retryable: input.retryable,
    retryState: retryStateFor(input.retryable, deadLetter),
    deadLetter,
    ...(input.nextRetryAt ? { nextRetryAt: input.nextRetryAt } : {})
  };
}

function retryStateFor(retryable: boolean, deadLetter: boolean): RelayRetryState {
  if (deadLetter) {
    return "dead_letter";
  }
  return retryable ? "retryable" : "not_retryable";
}

function retryBudgetExhaustedFailure(): RelayFailureClassification {
  return relayFailure({
    errorCode: "broadcast_retry_exhausted",
    message: "relay retry budget has been exhausted",
    failureCategory: "broadcaster",
    retryable: false,
    deadLetter: true
  });
}

function normalizeMaxRetryAttempts(value: number | undefined): number {
  // Keep the service bounded by default, matching the chain-services
  // BROADCAST_MAX_RETRY_ATTEMPTS default. An explicit Infinity is a deliberate
  // opt-out for test/dry-run callers.
  if (value === undefined) {
    return DEFAULT_MAX_RETRY_ATTEMPTS;
  }
  if (!Number.isFinite(value)) {
    return value === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : DEFAULT_MAX_RETRY_ATTEMPTS;
  }
  return Math.max(Math.floor(value), 0);
}

function isTerminalSubmission(submission: RelaySubmission): boolean {
  // A successful broadcast is final for this submission id: the nonce is
  // consumed on chain. A same-payload replay must idempotently return the
  // recorded outcome instead of failing nonce reservation and overwriting
  // the ledger with a duplicate_signer_nonce dead letter.
  if (submission.status === "submitted") {
    return true;
  }
  return submission.status === "failed" && (
    submission.deadLetter === true ||
    submission.retryable === false ||
    (submission.deadLetter === undefined && submission.retryable === undefined)
  );
}

function failedAttemptsFromSubmission(submission: RelaySubmission | undefined): number {
  if (!submission || submission.status !== "failed" ||
      (submission.retryable !== true && submission.retryState !== "retryable")) {
    return 0;
  }
  return Math.max(submission.attemptNumber ?? submission.attemptCount ?? 0, 0);
}

function cappedExponentialBackoffMs(baseMs: number, maxMs: number, attempts: number): number {
  const safeAttempts = Number.isFinite(attempts) ? Math.max(Math.floor(attempts), 0) : 0;
  let delayMs = baseMs;
  let remaining = safeAttempts;
  while (remaining > 0 && delayMs < maxMs) {
    delayMs *= 2;
    remaining -= 1;
  }
  return Math.min(delayMs, maxMs);
}

function errorLabelForRelayError(errorCode: string): string {
  switch (errorCode) {
    case "chain_id_mismatch":
      return "RPC chain does not match configuration";
    case "duplicate_signer_nonce":
      return "Duplicate signer nonce";
    case "duplicate_transaction":
      return "Duplicate transaction";
    case "expired_payload_deadline":
      return "Payload deadline expired";
    case "invalid_business_signature":
      return "Business signature is invalid";
    case "malformed_relay_payload":
      return "Relay payload is malformed";
    case "missing_nonce":
      return "Nonce is required";
    case "missing_order_id":
      return "Order id is required";
    case "missing_verified_signer":
      return "Verified signer is missing";
    case "order_relay_in_flight":
      return "Order relay is already in flight";
    case "relay_broadcast_failed":
      return "Relay broadcast failed";
    case "persist_failed":
      return "Relay broadcast succeeded but durable recording failed";
    case "relayer_insufficient_funds":
      return "Relayer gas payer needs funds";
    case "rpc_unavailable":
      return "RPC or broadcaster unavailable";
    case "signal_already_exists":
      return "Signal was already submitted";
    case "broadcast_retry_exhausted":
      return "Relay retry limit reached";
    case "transaction_reverted":
      return "Transaction reverted";
    case "unauthorized_signal_submitter":
      return "Submitter is not authorized";
    case "unknown_order":
      return "Order is not registered yet";
    case "verified_signer_mismatch":
      return "Verified signer mismatch";
    default:
      return errorCode;
  }
}

function findErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (typeof record.errorName === "string") {
    return record.errorName;
  }
  if (typeof record.name === "string") {
    return record.name;
  }
  if (record.cause) {
    return findErrorName(record.cause);
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const causeText = "cause" in error ? errorText((error as { readonly cause?: unknown }).cause) : "";
    return redactErrorMessage([error.message, causeText].filter(Boolean).join(" "));
  }
  if (typeof error === "string") {
    return redactErrorMessage(error);
  }
  if (error && typeof error === "object") {
    const text = Object.entries(error as Record<string, unknown>)
      .filter(([key]) => key !== "stack")
      .map(([_key, value]) => typeof value === "string" ? value : "")
      .filter(Boolean)
      .join(" ");
    return redactErrorMessage(text);
  }
  return "";
}

function freezeRelayRequest(request: RelayRequest): Readonly<RelayRequest> {
  return Object.freeze({
    ...request,
    business: Object.freeze({ ...request.business }),
    typedData: Object.freeze({ ...request.typedData })
  });
}

function submissionId(request: RelayRequest): string {
  return [
    request.business.chainId,
    request.business.verifyingContract.toLowerCase(),
    request.business.signer.toLowerCase(),
    request.business.nonce
  ].join(":");
}

function orderKey(request: RelayRequest): string {
  return [
    request.business.chainId,
    request.business.verifyingContract.toLowerCase(),
    request.business.orderId
  ].join(":");
}

function nonceKey(signer: Address, nonce: string): string {
  return `${signer.toLowerCase()}:${nonce}`;
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  if (config.relayer.businessSigning !== "forbidden") {
    throw new ConfigError("relayer business signing must remain forbidden");
  }

  consoleLogger.info("relayer framework ready", {
    gasSignerRef: config.relayer.gasSignerRef ?? "unset",
    businessSigning: config.relayer.businessSigning
  });
}

if (isDirectRun(import.meta.url)) {
  void main();
}
