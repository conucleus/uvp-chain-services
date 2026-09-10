import type { PreparedPatchRecordBase, ProductStagePatchStore, StagePatchSubmissionBase } from "./types.js";

/** memory 驱动 prepare 表的硬上限（未配额入口的最后防线，见 putPrepared）。 */
export const MEMORY_PREPARED_PATCH_HARD_LIMIT = 5_000;

export class InMemoryProductStagePatchStore<
  TPrepared extends PreparedPatchRecordBase,
  TSubmission extends StagePatchSubmissionBase
> implements ProductStagePatchStore<TPrepared, TSubmission> {
  readonly #prepared = new Map<string, TPrepared & { readonly deadline?: string }>();
  readonly #submissions = new Map<string, TSubmission>();
  readonly #reservedNonceKeys = new Set<string>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async putPrepared(record: TPrepared): Promise<void> {
    // prepare 入口无配额：内存表必须有独立上界，否则换任务循环 prepare
    // 会无界增长（OOM）。到上限先清过期行，仍满按最早 deadline 淘汰——
    // 服务层写入时也会顺带清扫，这里是最后防线而非常规路径。
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
    // 过期 prepare（deadline 为 unix 秒字符串）无论是否已消费都不再
    // 参与判定：提交侧对过期记录只有拒绝路径。
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
