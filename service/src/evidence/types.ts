import type { Hex } from "../shared/types.js";

export type EvidenceStatus = "uploaded" | "bound" | "superseded" | "withdrawn" | "missing_file" | "mismatch";
export type EvidenceVerificationStatus = "unbound" | "matched" | "mismatch" | "missing_file";
export type EvidencePrincipalRole = "anonymous" | "participant" | "adjudicator" | "admin";

export type EvidenceJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly EvidenceJsonValue[]
  | { readonly [key: string]: EvidenceJsonValue };

export type EvidenceJsonObject = { readonly [key: string]: EvidenceJsonValue };

export interface EvidencePrincipal {
  readonly id?: string;
  readonly role: EvidencePrincipalRole;
}

export interface EvidenceObjectDTO {
  readonly evidenceId: string;
  readonly orderId?: string;
  readonly draftId?: string;
  readonly taskId?: string;
  readonly stageIdentifier: string;
  readonly ownerParticipantId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly storageURI: string;
  readonly contentHash: Hex;
  readonly metadataHash: Hex;
  readonly payloadHash: Hex;
  readonly payloadRef: string;
  readonly status: EvidenceStatus;
  readonly createdAt: string;
  readonly boundSignalTxHash?: Hex;
  readonly boundSubmissionId?: string;
  readonly boundOnchainOrderId?: Hex;
  readonly boundSourceId?: Hex;
  readonly boundSignalId?: Hex;
  readonly boundAt?: string;
}

export interface EvidenceMetadataDTO {
  readonly evidenceId: string;
  readonly businessLabel: string;
  readonly description?: string;
  readonly documentType: string;
  readonly issuer?: string;
  readonly issuedAt?: string;
  readonly fields: EvidenceJsonObject;
  readonly redactionPolicy?: EvidenceJsonValue;
}

export interface EvidenceAccessPolicyDTO {
  readonly evidenceId: string;
  readonly orderId?: string;
  readonly readers: readonly string[];
  readonly writers: readonly string[];
  readonly adminReaders: readonly string[];
  readonly disputeReaders: readonly string[];
}

export interface EvidenceProofDTO {
  readonly evidenceId: string;
  readonly payloadHash: Hex;
  readonly contentHash: Hex;
  readonly metadataHash: Hex;
  readonly payloadRef: string;
  readonly storageURI: string;
  readonly boundSignalTxHash?: Hex;
  readonly boundSubmissionId?: string;
  readonly boundOnchainOrderId?: Hex;
  readonly boundSourceId?: Hex;
  readonly boundSignalId?: Hex;
  readonly boundAt?: string;
  readonly blockNumber?: string;
  readonly submitter?: string;
  readonly verificationStatus: EvidenceVerificationStatus;
}

export type EvidenceContentDTO =
  | {
      readonly encoding: "text" | "base64";
      readonly value: string;
    }
  | {
      readonly encoding: "json";
      readonly value: unknown;
    };

export interface EvidenceMetadataInputDTO {
  readonly businessLabel?: string;
  readonly description?: string;
  readonly documentType?: string;
  readonly issuer?: string;
  readonly issuedAt?: string;
  readonly fields?: unknown;
  readonly redactionPolicy?: unknown;
}

export interface EvidenceAccessPolicyInputDTO {
  readonly readers?: readonly string[];
  readonly writers?: readonly string[];
  readonly adminReaders?: readonly string[];
  readonly disputeReaders?: readonly string[];
}

export interface CreateEvidenceRequestDTO {
  readonly orderId?: string;
  readonly draftId?: string;
  readonly taskId?: string;
  readonly stageIdentifier?: string;
  readonly ownerParticipantId?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly documentType?: string;
  readonly content?: EvidenceContentDTO;
  readonly textPayload?: string;
  readonly base64Payload?: string;
  readonly jsonPayload?: unknown;
  readonly metadata?: EvidenceMetadataInputDTO;
  readonly accessPolicy?: EvidenceAccessPolicyInputDTO;
}

export interface EvidenceRecordDTO {
  readonly evidence: EvidenceObjectDTO;
  readonly metadata: EvidenceMetadataDTO;
  readonly accessPolicy: EvidenceAccessPolicyDTO;
}

export interface EvidenceUploadResponseDTO extends EvidenceRecordDTO {
  readonly payloadHash: Hex;
  readonly payloadRef: string;
}

export interface BindEvidenceRequestDTO {
  readonly evidenceId: string;
  readonly submissionId?: string;
  readonly txHash: Hex;
  readonly orderId: string;
  readonly onchainOrderId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly boundAt?: string;
}
