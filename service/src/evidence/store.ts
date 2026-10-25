import type {
  BindEvidenceRequestDTO,
  EvidenceAccessPolicyDTO,
  EvidenceJsonObject,
  EvidenceObjectDTO,
  EvidenceMetadataDTO
} from "./types.js";

export interface EvidenceAdminReadAuditDTO {
  readonly evidenceId: string;
  readonly principalId: string;
  readonly accessedAt: string;
  readonly route: "evidence" | "proof";
}

export interface EvidenceMetadataRecord {
  readonly evidence: EvidenceObjectDTO;
  readonly metadata: EvidenceMetadataDTO;
  readonly accessPolicy: EvidenceAccessPolicyDTO;
  readonly canonicalMetadata: EvidenceJsonObject;
}

export interface EvidenceMetadataStore {
  put(record: EvidenceMetadataRecord): Promise<void>;
  insertIfPayloadHashAbsent(record: EvidenceMetadataRecord): Promise<EvidenceMetadataRecord | undefined>;
  get(evidenceId: string): Promise<EvidenceMetadataRecord | undefined>;
  markBound?(input: BindEvidenceRequestDTO): Promise<EvidenceMetadataRecord | undefined>;
  recordAdminRead(entry: EvidenceAdminReadAuditDTO): Promise<void>;
  listAdminReads?(): Promise<readonly EvidenceAdminReadAuditDTO[]>;
  findOwnedByPayloadHash?(payloadHash: string, ownerParticipantId: string): Promise<EvidenceMetadataRecord | undefined>;
}

export class InMemoryEvidenceMetadataStore implements EvidenceMetadataStore {
  readonly #records = new Map<string, EvidenceMetadataRecord>();
  readonly #adminReads: EvidenceAdminReadAuditDTO[] = [];

  async put(record: EvidenceMetadataRecord): Promise<void> {
    this.#records.set(record.evidence.evidenceId, record);
  }

  async insertIfPayloadHashAbsent(record: EvidenceMetadataRecord): Promise<EvidenceMetadataRecord | undefined> {
    const existing = [...this.#records.values()]
      .find((candidate) =>
        candidate.evidence.payloadHash.toLowerCase() === record.evidence.payloadHash.toLowerCase() &&
        candidate.evidence.ownerParticipantId.toLowerCase() === record.evidence.ownerParticipantId.toLowerCase());
    if (existing) {
      return existing;
    }
    this.#records.set(record.evidence.evidenceId, record);
    return undefined;
  }

  async get(evidenceId: string): Promise<EvidenceMetadataRecord | undefined> {
    return this.#records.get(evidenceId);
  }

  async findOwnedByPayloadHash(payloadHash: string, ownerParticipantId: string): Promise<EvidenceMetadataRecord | undefined> {
    const matches = [...this.#records.values()]
      .filter((record) =>
        record.evidence.payloadHash.toLowerCase() === payloadHash.toLowerCase() &&
        record.evidence.ownerParticipantId.toLowerCase() === ownerParticipantId.toLowerCase())
      .sort((left, right) =>
        left.evidence.createdAt.localeCompare(right.evidence.createdAt) ||
        left.evidence.evidenceId.localeCompare(right.evidence.evidenceId));
    return matches[0];
  }

  async markBound(input: BindEvidenceRequestDTO): Promise<EvidenceMetadataRecord | undefined> {
    const current = this.#records.get(input.evidenceId);
    if (!current) {
      return undefined;
    }
    if (current.evidence.status !== "uploaded") {
      return current;
    }
    const updated: EvidenceMetadataRecord = {
      ...current,
      evidence: {
        ...current.evidence,
        status: "bound",
        boundSignalTxHash: input.txHash,
        ...(input.submissionId ? { boundSubmissionId: input.submissionId } : {}),
        boundOnchainOrderId: input.onchainOrderId,
        boundSourceId: input.sourceId,
        boundSignalId: input.signalId,
        ...(input.boundAt ? { boundAt: input.boundAt } : {})
      }
    };
    this.#records.set(input.evidenceId, updated);
    return updated;
  }

  async recordAdminRead(entry: EvidenceAdminReadAuditDTO): Promise<void> {
    this.#adminReads.push(entry);
  }

  async listAdminReads(): Promise<readonly EvidenceAdminReadAuditDTO[]> {
    return [...this.#adminReads];
  }
}
