import { loadConfigFromEnv } from "../config/index.js";
import { isDirectRun } from "../shared/runtime.js";
import {
  ConfigError,
  assertHex,
  normalizeAddress,
  normalizeBytes32,
  consoleLogger,
  noopLogger,
  type Address,
  type LifecycleService,
  type Logger
} from "../shared/types.js";
import type {
  BusinessSignatureVerifier,
  RelayNonceStore,
  RelayRequest,
  RelaySubmission,
  RelaySubmissionStore,
  SignatureVerificationResult,
  TransactionSubmitter
} from "./types.js";

export class RelayRejection extends Error {
  override readonly name = "RelayRejection";
}

export interface RelayerServiceOptions {
  readonly verifier: BusinessSignatureVerifier;
  readonly submitter: TransactionSubmitter;
  readonly nonceStore?: RelayNonceStore;
  readonly submissionStore?: RelaySubmissionStore;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

export class RelayerService implements LifecycleService {
  readonly name = "relayer";

  #running = false;
  readonly #verifier: BusinessSignatureVerifier;
  readonly #submitter: TransactionSubmitter;
  readonly #nonceStore: RelayNonceStore | undefined;
  readonly #submissionStore: RelaySubmissionStore | undefined;
  readonly #now: () => Date;
  readonly #logger: Logger;

  constructor(options: RelayerServiceOptions) {
    this.#verifier = options.verifier;
    this.#submitter = options.submitter;
    this.#nonceStore = options.nonceStore;
    this.#submissionStore = options.submissionStore;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? noopLogger;
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
    validateRelayRequest(request, this.#now());

    const verification = await this.#verifier.verify(freezeRelayRequest(request));
    ensureVerifiedSigner(request, verification);

    const reserved = await this.reserveNonce(request);
    if (!reserved) {
      throw new RelayRejection("duplicate signer nonce");
    }

    try {
      const transaction = await this.#submitter.submit(freezeRelayRequest(request));
      const submission: RelaySubmission = {
        id: submissionId(request),
        action: request.business.action,
        chainId: request.business.chainId,
        verifyingContract: request.business.verifyingContract,
        orderId: request.business.orderId,
        ...(request.business.stageId ? { stageId: request.business.stageId } : {}),
        signer: request.business.signer,
        nonce: request.business.nonce,
        status: "submitted",
        txHash: transaction.txHash
      };
      await this.record(submission);
      return submission;
    } catch (error) {
      await this.releaseNonce(request);

      const submission: RelaySubmission = {
        id: submissionId(request),
        action: request.business.action,
        chainId: request.business.chainId,
        verifyingContract: request.business.verifyingContract,
        orderId: request.business.orderId,
        ...(request.business.stageId ? { stageId: request.business.stageId } : {}),
        signer: request.business.signer,
        nonce: request.business.nonce,
        status: "failed",
        error: error instanceof Error ? error.message : "unknown submission error"
      };
      await this.record(submission);
      return submission;
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
    throw new RelayRejection("orderId is required");
  }
  if (!request.business.nonce) {
    throw new RelayRejection("nonce is required");
  }
  if (request.business.deadline < BigInt(Math.floor(now.getTime() / 1000))) {
    throw new RelayRejection("payload deadline has expired");
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
    throw new RelayRejection(result.reason ?? "invalid business signature");
  }
  if (!result.signer) {
    throw new RelayRejection("signature verifier did not return signer");
  }

  const expected = normalizeAddress(request.business.signer, "business.signer");
  const actual = normalizeAddress(result.signer, "verified signer");
  if (actual !== expected) {
    throw new RelayRejection("verified signer does not match payload signer");
  }
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
