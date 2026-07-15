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

export interface GovernanceStore {
  listReviews(query?: GovernanceReviewQuery): Promise<readonly GovernanceReviewDTO[]>;
  getReview(reviewId: string): Promise<GovernanceReviewDTO | undefined>;
  putReview(review: GovernanceReviewDTO): Promise<void>;
  findLatestReview(subjectType: GovernanceSubjectType, subjectId: string): Promise<GovernanceReviewDTO | undefined>;
  listIdentityTxLogs(): Promise<readonly IdentityTxLogDTO[]>;
  appendIdentityTxLog(log: IdentityTxLogDTO): Promise<void>;
  getTxLog(txLogId: string): Promise<GovernanceTxLogDTO | undefined>;
  updateTxLog(log: GovernanceTxLogDTO): Promise<void>;
}

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

  async findLatestReview(
    subjectType: GovernanceSubjectType,
    subjectId: string
  ): Promise<GovernanceReviewDTO | undefined> {
    return (await this.listReviews({ subjectType, subjectId }))[0];
  }

  async listIdentityTxLogs(): Promise<readonly IdentityTxLogDTO[]> {
    return [...this.identityLogs].sort(compareCreatedDesc);
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
