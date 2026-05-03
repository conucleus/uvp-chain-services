import type {
  GovernanceReviewDTO,
  GovernanceSubjectType,
  GovernanceTxLogDTO,
  PlanAttestationLogDTO,
  SupplierAttestationLogDTO
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
  listPlanAttestationLogs(): Promise<readonly PlanAttestationLogDTO[]>;
  appendPlanAttestationLog(log: PlanAttestationLogDTO): Promise<void>;
  listSupplierAttestationLogs(): Promise<readonly SupplierAttestationLogDTO[]>;
  appendSupplierAttestationLog(log: SupplierAttestationLogDTO): Promise<void>;
  getTxLog(txLogId: string): Promise<GovernanceTxLogDTO | undefined>;
  updateTxLog(log: GovernanceTxLogDTO): Promise<void>;
}

export class InMemoryGovernanceStore implements GovernanceStore {
  private readonly reviews = new Map<string, GovernanceReviewDTO>();
  private readonly planLogs: PlanAttestationLogDTO[] = [];
  private readonly supplierLogs: SupplierAttestationLogDTO[] = [];

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

  async listPlanAttestationLogs(): Promise<readonly PlanAttestationLogDTO[]> {
    return [...this.planLogs].sort(compareCreatedDesc);
  }

  async appendPlanAttestationLog(log: PlanAttestationLogDTO): Promise<void> {
    this.planLogs.push(log);
  }

  async listSupplierAttestationLogs(): Promise<readonly SupplierAttestationLogDTO[]> {
    return [...this.supplierLogs].sort(compareCreatedDesc);
  }

  async appendSupplierAttestationLog(log: SupplierAttestationLogDTO): Promise<void> {
    this.supplierLogs.push(log);
  }

  async getTxLog(txLogId: string): Promise<GovernanceTxLogDTO | undefined> {
    return this.planLogs.find((log) => log.txLogId === txLogId || log.logId === txLogId) ??
      this.supplierLogs.find((log) => log.txLogId === txLogId || log.logId === txLogId);
  }

  async updateTxLog(log: GovernanceTxLogDTO): Promise<void> {
    if (log.action === "attest_plan" || log.action === "revoke_plan") {
      const planLog = log as PlanAttestationLogDTO;
      const index = this.planLogs.findIndex((item) => item.txLogId === log.txLogId || item.logId === log.logId);
      if (index >= 0) {
        this.planLogs[index] = planLog;
      }
      return;
    }

    const supplierLog = log as SupplierAttestationLogDTO;
    const index = this.supplierLogs.findIndex((item) => item.txLogId === log.txLogId || item.logId === log.logId);
    if (index >= 0) {
      this.supplierLogs[index] = supplierLog;
    }
  }
}

function compareUpdatedDesc(left: GovernanceReviewDTO, right: GovernanceReviewDTO): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.reviewId.localeCompare(left.reviewId);
}

function compareCreatedDesc(
  left: PlanAttestationLogDTO | SupplierAttestationLogDTO,
  right: PlanAttestationLogDTO | SupplierAttestationLogDTO
): number {
  return right.createdAt.localeCompare(left.createdAt) || right.logId.localeCompare(left.logId);
}
