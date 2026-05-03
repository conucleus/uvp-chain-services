import type { PreparedSubmissionRecord, ProductSubmissionDTO, ProductSubmissionStore } from "./types.js";

export class InMemoryProductSubmissionStore implements ProductSubmissionStore {
  readonly #prepared = new Map<string, PreparedSubmissionRecord>();
  readonly #submissions = new Map<string, ProductSubmissionDTO>();
  readonly #reservedNonceKeys = new Set<string>();

  async putPrepared(record: PreparedSubmissionRecord): Promise<void> {
    this.#prepared.set(record.prepareId, record);
  }

  async getPrepared(prepareId: string): Promise<PreparedSubmissionRecord | undefined> {
    return this.#prepared.get(prepareId);
  }

  async markPreparedUsed(prepareId: string, submissionId: string, usedAt: string): Promise<void> {
    const current = this.#prepared.get(prepareId);
    if (!current) {
      return;
    }
    this.#prepared.set(prepareId, {
      ...current,
      usedAt,
      submissionId
    });
  }

  async reserveNonce(key: string): Promise<boolean> {
    if (this.#reservedNonceKeys.has(key)) {
      return false;
    }
    this.#reservedNonceKeys.add(key);
    return true;
  }

  async putSubmission(submission: ProductSubmissionDTO): Promise<void> {
    this.#submissions.set(submission.submissionId, submission);
  }

  async getSubmission(submissionId: string): Promise<ProductSubmissionDTO | undefined> {
    return this.#submissions.get(submissionId);
  }

  async listSubmissions(): Promise<readonly ProductSubmissionDTO[]> {
    return [...this.#submissions.values()].sort(compareSubmissionCreatedAsc);
  }
}

function compareSubmissionCreatedAsc(left: ProductSubmissionDTO, right: ProductSubmissionDTO): number {
  return left.createdAt.localeCompare(right.createdAt) || left.submissionId.localeCompare(right.submissionId);
}
