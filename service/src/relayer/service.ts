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
  RelayRetryState,
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
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
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
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #inFlightByOrder = new Map<string, number>();
  readonly #failedAttemptsBySubmission = new Map<string, number>();

  constructor(options: RelayerServiceOptions) {
    this.#verifier = options.verifier;
    this.#submitter = options.submitter;
    this.#nonceStore = options.nonceStore;
    this.#submissionStore = options.submissionStore;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? noopLogger;
    this.#maxInFlightPerOrder = options.maxInFlightPerOrder ?? DEFAULT_MAX_IN_FLIGHT_PER_ORDER;
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
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

    const reserved = await this.reserveNonce(request);
    if (!reserved) {
      const classification = relayFailure({
        errorCode: "duplicate_signer_nonce",
        message: "duplicate signer nonce",
        failureCategory: "duplicate",
        retryable: false,
        deadLetter: true
      });
      const submission = failedSubmission(request, classification);
      await this.record(submission);
      return submission;
    }

    const submissionKey = submissionId(request);
    const priorFailedAttempts = this.#failedAttemptsBySubmission.get(submissionKey) ?? 0;

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
      const submission = failedSubmission(request, classification);
      await this.record(submission);
      return submission;
    }

    try {
      const transaction = await this.#submitter.submit(freezeRelayRequest(request));
      const submission = submittedSubmission(request, transaction.txHash);
      this.#failedAttemptsBySubmission.delete(submissionKey);
      await this.record(submission);
      return submission;
    } catch (error) {
      const classification = classifyRelaySubmitterError(error, this.retrySchedule(priorFailedAttempts));
      if (classification.retryable) {
        await this.releaseNonce(request);
        this.#failedAttemptsBySubmission.set(submissionKey, priorFailedAttempts + 1);
      }

      const submission = failedSubmission(request, classification);
      await this.record(submission);
      return submission;
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

export function createRelayerService(options: RelayerServiceOptions): RelayerService {
  return new RelayerService(options);
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
  if (/insufficient funds/i.test(haystack)) {
    return relayFailure({
      errorCode: "relayer_insufficient_funds",
      message: "relayer gas payer has insufficient funds",
      failureCategory: "broadcaster",
      retryable: false,
      deadLetter: true
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

function submittedSubmission(request: RelayRequest, txHash: Hex): RelaySubmission {
  return {
    ...submissionBase(request),
    status: "submitted",
    txHash,
    retryable: false,
    retryState: "not_applicable",
    deadLetter: false
  };
}

function failedSubmission(request: RelayRequest, classification: RelayFailureClassification): RelaySubmission {
  return {
    ...submissionBase(request),
    status: "failed",
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
  | "failureCategory"
  | "retryable"
  | "retryState"
  | "deadLetter"
  | "nextRetryAt"
> {
  return {
    id: submissionId(request),
    action: request.business.action,
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
    case "relayer_insufficient_funds":
      return "Relayer gas payer needs funds";
    case "rpc_unavailable":
      return "RPC or broadcaster unavailable";
    case "signal_already_exists":
      return "Signal was already submitted";
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
    request.business.nonce,
    request.business.action
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
