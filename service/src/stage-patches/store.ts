import type { PreparedPatchRecordBase, ProductStagePatchStore, StagePatchSubmissionBase } from "./types.js";

export class InMemoryProductStagePatchStore<
  TPrepared extends PreparedPatchRecordBase,
  TSubmission extends StagePatchSubmissionBase
> implements ProductStagePatchStore<TPrepared, TSubmission> {
  readonly #prepared = new Map<string, TPrepared>();
  readonly #submissions = new Map<string, TSubmission>();
  readonly #reservedNonceKeys = new Set<string>();

  async putPrepared(record: TPrepared): Promise<void> {
    this.#prepared.set(record.prepareId, record);
  }

  async getPrepared(prepareId: string): Promise<TPrepared | undefined> {
    return this.#prepared.get(prepareId);
  }

  async markPreparedUsed(prepareId: string, submissionId: string, usedAt: string): Promise<void> {
    const current = this.#prepared.get(prepareId);
    if (!current) {
      return;
    }
    this.#prepared.set(prepareId, {
      ...current,
      submissionId,
      usedAt
    });
  }

  async reserveNonce(key: string): Promise<boolean> {
    if (this.#reservedNonceKeys.has(key)) {
      return false;
    }
    this.#reservedNonceKeys.add(key);
    return true;
  }

  async releaseNonce(key: string): Promise<void> {
    this.#reservedNonceKeys.delete(key);
  }

  async putSubmission(submission: TSubmission): Promise<void> {
    this.#submissions.set(submission.submissionId, submission);
  }

  async getSubmission(submissionId: string): Promise<TSubmission | undefined> {
    return this.#submissions.get(submissionId);
  }
}
