import type {
  PreparedPatchRecordBase,
  ProductStagePatchStore,
  StagePatchSubmissionBase,
  StagePatchSubmissionScanCursor
} from "./types.js";

function isOpenStagePatchSubmission(
  submission: StagePatchSubmissionBase & { readonly status?: string; readonly txHash?: string }
): boolean {
  if (submission.status === "broadcasting" || submission.status === "submitted") {
    return true;
  }
  return submission.status === "failed" && typeof submission.txHash === "string";
}

export const MEMORY_PREPARED_PATCH_HARD_LIMIT = 5_000;

export class InMemoryProductStagePatchStore<
  TPrepared extends PreparedPatchRecordBase,
  TSubmission extends StagePatchSubmissionBase
> implements ProductStagePatchStore<TPrepared, TSubmission> {
  readonly #prepared = new Map<string, TPrepared & { readonly deadline?: string }>();
  readonly #submissions = new Map<string, TSubmission>();
  readonly #reservedNonceKeys = new Map<string, string>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async putPrepared(record: TPrepared): Promise<void> {
    if (this.#prepared.size >= MEMORY_PREPARED_PATCH_HARD_LIMIT) {
      await this.deleteExpiredPrepared(String(Math.floor(this.#now().getTime() / 1000)));
      while (this.#prepared.size >= MEMORY_PREPARED_PATCH_HARD_LIMIT) {
        const oldest = [...this.#prepared.values()]
          .sort((left, right) => Number(left.deadline ?? 0) - Number(right.deadline ?? 0))[0];
        if (!oldest) {
          break;
        }
        this.#prepared.delete(oldest.prepareId);
      }
    }
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

  async deleteExpiredPrepared(deadlineBeforeSeconds: string): Promise<number> {
    const boundary = Number(deadlineBeforeSeconds);
    let deleted = 0;
    for (const [prepareId, record] of this.#prepared) {
      if (record.deadline !== undefined && Number(record.deadline) < boundary) {
        this.#prepared.delete(prepareId);
        deleted += 1;
      }
    }
    return deleted;
  }

  async reserveNonce(key: string, options?: { readonly staleBefore?: string }): Promise<boolean> {
    const reservedAt = this.#now().toISOString();
    const existing = this.#reservedNonceKeys.get(key);
    if (existing !== undefined) {
      if (!options?.staleBefore || existing >= options.staleBefore) {
        return false;
      }
      this.#reservedNonceKeys.set(key, reservedAt);
      return true;
    }
    this.#reservedNonceKeys.set(key, reservedAt);
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

  async listOpenSubmissionsPage(
    after: StagePatchSubmissionScanCursor | undefined,
    limit: number
  ): Promise<readonly TSubmission[]> {
    type Scannable = TSubmission & { readonly createdAt: string; readonly status: string; readonly txHash?: string };
    const open = (submission: TSubmission): submission is Scannable =>
      isOpenStagePatchSubmission(submission as Scannable);
    return ([...this.#submissions.values()] as TSubmission[])
      .filter(open)
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.submissionId.localeCompare(right.submissionId))
      .filter((submission) => !after
        || submission.createdAt > after.createdAt
        || (submission.createdAt === after.createdAt && submission.submissionId > after.submissionId))
      .slice(0, Math.max(limit, 0));
  }
}
