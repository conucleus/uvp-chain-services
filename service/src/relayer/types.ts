import type { Address, Hex } from "../shared/types.js";

export type RelayAction = "approveStage" | "requestRelease" | "openDispute" | "resolveDispute";
export type RelaySubmissionStatus = "submitted" | "confirmed" | "failed";
export type RelayFailureCategory = "retryable" | "permanent" | "duplicate" | "authorization" | "broadcaster";
export type RelayRetryState = "not_applicable" | "retryable" | "not_retryable" | "dead_letter";

export interface RelayBusinessFields {
  readonly action: RelayAction;
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

export interface TransactionSubmitter {
  submit(request: Readonly<RelayRequest>): Promise<RelayTransaction>;
}

export interface RelayNonceStore {
  reserve(signer: Address, nonce: string): Promise<boolean>;
  release?(signer: Address, nonce: string): Promise<void>;
}

export interface RelaySubmissionStore {
  record(submission: RelaySubmission): Promise<void>;
}

export interface RelaySubmission {
  readonly id: string;
  readonly action: RelayAction;
  readonly chainId: number;
  readonly verifyingContract: Address;
  readonly orderId: string;
  readonly stageId?: string;
  readonly signer: Address;
  readonly nonce: string;
  readonly status: RelaySubmissionStatus;
  readonly txHash?: Hex;
  readonly errorCode?: string;
  readonly errorLabel?: string;
  readonly error?: string;
  readonly failureCategory?: RelayFailureCategory;
  readonly retryable?: boolean;
  readonly retryState?: RelayRetryState;
  readonly deadLetter?: boolean;
  readonly nextRetryAt?: string;
}
