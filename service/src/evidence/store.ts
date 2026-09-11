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
  /**
   * 条件插入（上传路径）：owner 已有同 payloadHash 记录时拒绝并返回
   * 该既有记录，插入成功返回 undefined。重复上传幂等的 check-then-insert
   * 竞态由单语句 NOT EXISTS 收口（内存实现靠同步临界区），败者按既有
   * 记录幂等返回，不再撞 UNIQUE (owner_participant_id, payload_hash)
   * 以存储错误 500 泄露。
   */
  insertIfPayloadHashAbsent(record: EvidenceMetadataRecord): Promise<EvidenceMetadataRecord | undefined>;
  get(evidenceId: string): Promise<EvidenceMetadataRecord | undefined>;
  markBound?(input: BindEvidenceRequestDTO): Promise<EvidenceMetadataRecord | undefined>;
  recordAdminRead(entry: EvidenceAdminReadAuditDTO): Promise<void>;
  listAdminReads?(): Promise<readonly EvidenceAdminReadAuditDTO[]>;
  /**
   * 证据重复上传幂等——同一 owner 再次上传相同
   * payload（content+metadata+order+stage 全等，即 payloadHash 相同）时
   * 返回既有记录，而不是落一条内容完全相同的副本。
   */
  findOwnedByPayloadHash?(payloadHash: string, ownerParticipantId: string): Promise<EvidenceMetadataRecord | undefined>;
}

export class InMemoryEvidenceMetadataStore implements EvidenceMetadataStore {
  readonly #records = new Map<string, EvidenceMetadataRecord>();
  readonly #adminReads: EvidenceAdminReadAuditDTO[] = [];

  async put(record: EvidenceMetadataRecord): Promise<void> {
    this.#records.set(record.evidence.evidenceId, record);
  }

  async insertIfPayloadHashAbsent(record: EvidenceMetadataRecord): Promise<EvidenceMetadataRecord | undefined> {
    // 检查与写入必须同一同步段：中途 await 会让并发上传在微任务边界
    // 各自通过检查，双双插入（内存实现的原子性就靠这段同步代码）。
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
