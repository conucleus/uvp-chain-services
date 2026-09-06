import type { Address, Hex } from "../shared/types.js";

export type RelaySubmissionStatus = "submitted" | "confirmed" | "failed";
export type RelayFailureCategory = "retryable" | "permanent" | "duplicate" | "authorization" | "broadcaster";
export type RelayRetryState = "not_applicable" | "retryable" | "not_retryable" | "dead_letter";

export interface RelayBusinessFields {
  readonly chainId: number;
  readonly verifyingContract: Address;
  readonly orderId: string;
  readonly signer: Address;
  readonly nonce: string;
  readonly deadline: bigint;
  readonly stageId?: string;
  readonly signal?: string;
  readonly evidenceHash?: Hex;
  readonly metadataHash?: Hex;
}

export interface Eip712Payload {
  readonly domain: Readonly<Record<string, unknown>>;
  readonly types: Readonly<Record<string, readonly Readonly<Record<string, string>>[]>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
  readonly signature: Hex;
}

export interface RelayRequest {
  readonly business: RelayBusinessFields;
  readonly typedData: Eip712Payload;
  readonly receivedAt?: Date;
}

export interface SignatureVerificationResult {
  readonly valid: boolean;
  readonly signer?: Address;
  readonly reason?: string;
}

export interface BusinessSignatureVerifier {
  verify(request: Readonly<RelayRequest>): Promise<SignatureVerificationResult>;
}

export interface RelayTransaction {
  readonly txHash: Hex;
}

/** 回执探针的最小事实面：状态与块高即可裁决 duplicate 死信。 */
export interface RelayTransactionReceiptProbe {
  readonly status?: "success" | "reverted" | string;
  readonly blockNumber?: bigint | number | string;
}

export interface TransactionSubmitter {
  submit(request: Readonly<RelayRequest>): Promise<RelayTransaction>;
  /**
   * 可选回执探针：broadcaster 报 "already known"/"nonce too low" 时交易
   * 可能已经上链。先按 txHash 查回执，确认成功则记 submitted+txHash，
   * 查不到才允许死信，避免把已上链交易永久标记 failed 误导参与方重签。
   */
  getTransactionReceipt?(txHash: Hex): Promise<RelayTransactionReceiptProbe | undefined>;
}

export interface RelayNonceStore {
  reserve(signer: Address, nonce: string): Promise<boolean>;
  release?(signer: Address, nonce: string): Promise<void>;
}

export interface RelaySubmissionStore {
  record(submission: RelaySubmission): Promise<void>;
  /**
   * Optional read path used to recover the latest retry state after a relayer
   * restart. Existing stores only implementing `record` remain valid.
   */
  load?(submissionId: string): Promise<RelaySubmission | undefined>;
  /** Alias for stores that expose reads as `get` rather than `load`. */
  get?(submissionId: string): Promise<RelaySubmission | undefined>;
  /** Optional collection read for append-only stores. */
  list?(): Promise<readonly RelaySubmission[]>;
}

/**
 * Optional durable retry-state adapter. The relayer still records the full
 * submission through `RelaySubmissionStore`; this small state projection lets
 * deployments persist the retry budget independently when their ledger store
 * is append-only. Keeping it optional preserves the original relayer API.
 */
export interface RelayRetryBudgetSnapshot {
  readonly failedAttempts: number;
  readonly lastSubmission?: RelaySubmission;
}

export interface RelayRetryBudgetStore {
  load(submissionId: string): Promise<RelayRetryBudgetSnapshot | undefined>;
  save(submissionId: string, snapshot: RelayRetryBudgetSnapshot): Promise<void>;
}

export interface RelaySubmission {
  readonly id: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
  readonly orderId: string;
  readonly stageId?: string;
  readonly signer: Address;
  readonly nonce: string;
  readonly status: RelaySubmissionStatus;
  readonly txHash?: Hex;
  /** One-based number of broadcast attempts for this submission. */
  readonly attemptNumber?: number;
  /** Additive alias for consumers that use the submission DTO vocabulary. */
  readonly attemptCount?: number;
  /** Number of retries still available after this outcome, when bounded. */
  readonly retryBudgetRemaining?: number;
  readonly errorCode?: string;
  readonly errorLabel?: string;
  readonly error?: string;
  readonly failureCategory?: RelayFailureCategory;
  readonly retryable?: boolean;
  readonly retryState?: RelayRetryState;
  readonly deadLetter?: boolean;
  readonly nextRetryAt?: string;
}
