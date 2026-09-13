import type {
  PreparedSubmissionRecord,
  ProductSubmissionDTO,
  ProductSubmissionScanCursor,
  ProductSubmissionStore
} from "./types.js";

/** 台账扫描的"未闭环"状态集（与 reconcile worker 的行级口径同源）。 */
const OPEN_SUBMISSION_STATUSES = new Set(["broadcasting", "submitted", "indexing", "failed"]);

export class InMemoryProductSubmissionStore implements ProductSubmissionStore {
  readonly #prepared = new Map<string, PreparedSubmissionRecord>();
  readonly #submissions = new Map<string, ProductSubmissionDTO>();
  readonly #reservedNonceKeys = new Map<string, string>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    // 预留年龄判定要求写入时间与调用方时钟同源（持久 store 用系统时钟，
    // 内存 store 在服务时钟可注入的语境下必须可对齐），否则陈旧预留
    // 接管在注入时钟下永不触发。
    this.#now = options.now ?? (() => new Date());
  }

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

  async reserveNonce(key: string, options?: { readonly staleBefore?: string }): Promise<boolean> {
    const reservedAt = this.#now().toISOString();
    const existing = this.#reservedNonceKeys.get(key);
    if (existing !== undefined) {
      // 与持久实现同判据：只接管早于 staleBefore 的陈旧预留，未过期的
      // 预留可能属于存活中的提交，仍按重复拒绝。
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

  async putSubmission(submission: ProductSubmissionDTO): Promise<void> {
    this.#submissions.set(submission.submissionId, submission);
  }

  async getSubmission(submissionId: string): Promise<ProductSubmissionDTO | undefined> {
    return this.#submissions.get(submissionId);
  }

  async listSubmissions(): Promise<readonly ProductSubmissionDTO[]> {
    return [...this.#submissions.values()].sort(compareSubmissionCreatedAsc);
  }

  async listOpenSubmissionsPage(
    after: ProductSubmissionScanCursor | undefined,
    limit: number
  ): Promise<readonly ProductSubmissionDTO[]> {
    return (await this.listSubmissions())
      .filter((submission) => OPEN_SUBMISSION_STATUSES.has(submission.status))
      .filter((submission) => !after
        || submission.createdAt > after.createdAt
        || (submission.createdAt === after.createdAt && submission.submissionId > after.submissionId))
      .slice(0, Math.max(limit, 0));
  }
}

function compareSubmissionCreatedAsc(left: ProductSubmissionDTO, right: ProductSubmissionDTO): number {
  return left.createdAt.localeCompare(right.createdAt) || left.submissionId.localeCompare(right.submissionId);
}
