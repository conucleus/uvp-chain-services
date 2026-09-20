import type {
  GovernanceReviewDTO,
  GovernanceSubjectType,
  GovernanceTxLogDTO,
  IdentityTxLogDTO,
} from "./types.js";

export interface GovernanceReviewQuery {
  readonly subjectType?: GovernanceSubjectType;
  readonly subjectId?: string;
  readonly status?: string;
}

/** 台账键序扫描游标：(createdAt, logId) 双键，created_at 不可变保证轮中更新不影响游标稳定性。 */
export interface GovernanceTxLogScanCursor {
  readonly createdAt: string;
  readonly logId: string;
}

export interface GovernanceStore {
  listReviews(query?: GovernanceReviewQuery): Promise<readonly GovernanceReviewDTO[]>;
  getReview(reviewId: string): Promise<GovernanceReviewDTO | undefined>;
  putReview(review: GovernanceReviewDTO): Promise<void>;
  /**
   * 条件状态迁移（CAS）：行不存在时按新档插入；存在时仅当现行 status
   * 仍是 expected 才整行落档（UPDATE ... WHERE status=?）。返回 false
   * 表示并发方已先改状态——review 的状态机校验（canTransition）是
   * check-then-act，败者不得以过期校验结果覆盖赢家的迁移（如把已
   * revoked 的档盖回 approved）。
   */
  putReviewIfStatus(review: GovernanceReviewDTO, expected: GovernanceReviewDTO["status"]): Promise<boolean>;
  findLatestReview(subjectType: GovernanceSubjectType, subjectId: string): Promise<GovernanceReviewDTO | undefined>;
  listIdentityTxLogs(): Promise<readonly IdentityTxLogDTO[]>;
  /**
   * 对账车道的有界扫描（可选能力）：按 (createdAt, logId) 键序返回
   * "未闭环"的一页——status ∈ {pending, broadcasting, indexing, failed}。
   * 终态（confirmed 等）随历史单调增长且每轮重扫是 O(全历史) 的根因，
   * 服务端剪除不返回。failed 是否可复核（需带 txHash）由调用方行级
   * 过滤；simulated 档也由调用方跳过。after 为上一页末尾游标；实现
   * 缺失时调用方回退 listIdentityTxLogs() 全量。
   */
  listOpenIdentityTxLogsPage?(
    after: GovernanceTxLogScanCursor | undefined,
    limit: number
  ): Promise<readonly IdentityTxLogDTO[]>;
  appendIdentityTxLog(log: IdentityTxLogDTO): Promise<void>;
  getTxLog(txLogId: string): Promise<GovernanceTxLogDTO | undefined>;
  updateTxLog(log: GovernanceTxLogDTO): Promise<void>;
}

/** 台账扫描的"未闭环"状态集（与 reconcile worker 的行级口径同源）。 */
const OPEN_TX_LOG_STATUSES = new Set(["pending", "broadcasting", "indexing", "failed"]);

export class InMemoryGovernanceStore implements GovernanceStore {
  private readonly reviews = new Map<string, GovernanceReviewDTO>();
  private readonly identityLogs: IdentityTxLogDTO[] = [];

  async listReviews(query: GovernanceReviewQuery = {}): Promise<readonly GovernanceReviewDTO[]> {
    return [...this.reviews.values()]
      .filter((review) =>
        (!query.subjectType || review.subjectType === query.subjectType) &&
        (!query.subjectId || review.subjectId === query.subjectId) &&
        (!query.status || review.status === query.status)
      )
      .sort(compareUpdatedDesc);
  }

  async getReview(reviewId: string): Promise<GovernanceReviewDTO | undefined> {
    return this.reviews.get(reviewId);
  }

  async putReview(review: GovernanceReviewDTO): Promise<void> {
    this.reviews.set(review.reviewId, review);
  }

  async putReviewIfStatus(review: GovernanceReviewDTO, expected: GovernanceReviewDTO["status"]): Promise<boolean> {
    // 判定与写入同处一个同步临界区：并发迁移只有一个赢家。
    const current = this.reviews.get(review.reviewId);
    if (current && current.status !== expected) {
      return false;
    }
    this.reviews.set(review.reviewId, review);
    return true;
  }

  async findLatestReview(
    subjectType: GovernanceSubjectType,
    subjectId: string
  ): Promise<GovernanceReviewDTO | undefined> {
    return (await this.listReviews({ subjectType, subjectId }))[0];
  }

  async listIdentityTxLogs(): Promise<readonly IdentityTxLogDTO[]> {
    return [...this.identityLogs].sort(compareCreatedDesc);
  }

  async listOpenIdentityTxLogsPage(
    after: GovernanceTxLogScanCursor | undefined,
    limit: number
  ): Promise<readonly IdentityTxLogDTO[]> {
    return this.identityLogs
      .filter((log) => OPEN_TX_LOG_STATUSES.has(log.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.logId.localeCompare(right.logId))
      .filter((log) => !after
        || log.createdAt > after.createdAt
        || (log.createdAt === after.createdAt && log.logId > after.logId))
      .slice(0, Math.max(limit, 0));
  }

  async appendIdentityTxLog(log: IdentityTxLogDTO): Promise<void> {
    this.identityLogs.push(log);
  }

  async getTxLog(txLogId: string): Promise<GovernanceTxLogDTO | undefined> {
    return this.identityLogs.find(
      (log) => log.txLogId === txLogId || log.logId === txLogId,
    );
  }

  async updateTxLog(log: GovernanceTxLogDTO): Promise<void> {
    const index = this.identityLogs.findIndex(
      (item) => item.txLogId === log.txLogId || item.logId === log.logId,
    );
    if (index >= 0) this.identityLogs[index] = log;
  }
}

function compareUpdatedDesc(left: GovernanceReviewDTO, right: GovernanceReviewDTO): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.reviewId.localeCompare(left.reviewId);
}

function compareCreatedDesc(left: IdentityTxLogDTO, right: IdentityTxLogDTO): number {
  return right.createdAt.localeCompare(left.createdAt) || right.logId.localeCompare(left.logId);
}
