import type { Address, Hex } from "../../shared/types.js";
import type {
  StoreJoinApplicationEventRecord,
  StoreJoinApplicationRecord,
  StoreJoinApplicationStore,
  StoreJoinApplicationStatus
} from "./types.js";
import { StoreJoinOpenApplicationExistsError } from "./types.js";

export class InMemoryStoreJoinApplicationStore implements StoreJoinApplicationStore {
  readonly #applications = new Map<string, StoreJoinApplicationRecord>();
  readonly #events: StoreJoinApplicationEventRecord[] = [];

  async putApplication(record: StoreJoinApplicationRecord): Promise<void> {
    // 与持久驱动在途唯一索引同口径：同 (plan, applicant) 只允许一条
    // applied/under_review——查判与写入之间无 await，单线程事件循环内
    // 原子，兜住服务层"先查后写"窗口的并发双提交。
    if (record.status === "applied" || record.status === "under_review") {
      const duplicateOpen = [...this.#applications.values()].some((existing) =>
        existing.applicationId !== record.applicationId &&
        existing.planId.toLowerCase() === record.planId.toLowerCase() &&
        existing.applicantAddress.toLowerCase() === record.applicantAddress.toLowerCase() &&
        (existing.status === "applied" || existing.status === "under_review")
      );
      if (duplicateOpen) {
        throw new StoreJoinOpenApplicationExistsError();
      }
    }
    this.#applications.set(record.applicationId, record);
  }

  async getApplication(applicationId: string): Promise<StoreJoinApplicationRecord | undefined> {
    return this.#applications.get(applicationId);
  }

  async listApplications(query?: {
    readonly planId?: Hex;
    readonly applicantAddress?: Address;
    readonly status?: StoreJoinApplicationStatus;
  }): Promise<readonly StoreJoinApplicationRecord[]> {
    return [...this.#applications.values()]
      .filter((record) =>
        (!query?.planId || record.planId.toLowerCase() === query.planId.toLowerCase()) &&
        (!query?.applicantAddress || record.applicantAddress.toLowerCase() === query.applicantAddress.toLowerCase()) &&
        (!query?.status || record.status === query.status)
      )
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt) || left.applicationId.localeCompare(right.applicationId));
  }

  async appendEvent(record: StoreJoinApplicationEventRecord): Promise<void> {
    this.#events.push(record);
  }

  async listEvents(applicationId: string): Promise<readonly StoreJoinApplicationEventRecord[]> {
    return this.#events
      .filter((event) => event.applicationId === applicationId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId));
  }
}
