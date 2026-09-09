import type {
  DraftParticipantDTO,
  ProductInviteDTO,
  ProductOrderDraftDTO,
  ProductOrderTriggerRecord
} from "./types.js";

export interface ProductBffStore {
  withTransaction?<T>(operation: () => Promise<T>): Promise<T>;
  createDraft(draft: ProductOrderDraftDTO, participants: readonly DraftParticipantDTO[]): Promise<void>;
  getDraft(draftId: string): Promise<ProductOrderDraftDTO | undefined>;
  updateDraft(draft: ProductOrderDraftDTO): Promise<void>;
  listParticipants(draftId: string): Promise<readonly DraftParticipantDTO[]>;
  listAcceptedParticipantsByWallet(walletAddress: string): Promise<readonly DraftParticipantDTO[]>;
  getParticipant(participantId: string): Promise<DraftParticipantDTO | undefined>;
  updateParticipant(participant: DraftParticipantDTO): Promise<void>;
  /**
   * 条件插入：participant 已有 active 且未过期的 invite 时拒绝
   * （返回 false），单语句原子判定防并发双 active（跨进程由数据库承担
   * check-then-act 的原子性，内存实现由单线程临界区承担）。
   */
  createInviteIfNoneActive(invite: ProductInviteDTO, nowIso: string): Promise<boolean>;
  getInvite(inviteId: string): Promise<ProductInviteDTO | undefined>;
  updateInvite(invite: ProductInviteDTO): Promise<void>;
  /**
   * 条件状态迁移：仅当现行状态仍是 active 时落档（UPDATE ... WHERE
   * status='active'）。返回 false 表示并发方已先完成 accept/reject——
   * accept/reject 的 check-then-act 竞态以条件更新收口。
   */
  updateInviteIfActive(invite: ProductInviteDTO): Promise<boolean>;
  listInvitesByDraft(draftId: string): Promise<readonly ProductInviteDTO[]>;
  /**
   * 条件插入：draft 已有 trigger 记录（一事一单，draft_id UNIQUE）时
   * 拒绝（返回 false）。并发 prepare-trigger 双双通过前置检查时，跨
   * 进程原子性由单语句 NOT EXISTS 承担（内存实现由同步临界区承担），
   * 败者回读既有记录按幂等/409 收口，不再以存储错误 500 泄露。
   */
  createRegistrationIfNoneForDraft(registration: ProductOrderTriggerRecord): Promise<boolean>;
  getRegistration(triggerId: string): Promise<ProductOrderTriggerRecord | undefined>;
  getRegistrationByDraft(draftId: string): Promise<ProductOrderTriggerRecord | undefined>;
  listRegistrations(): Promise<readonly ProductOrderTriggerRecord[]>;
  updateRegistration(registration: ProductOrderTriggerRecord): Promise<void>;
}

export class MemoryProductBffStore implements ProductBffStore {
  readonly #drafts = new Map<string, ProductOrderDraftDTO>();
  readonly #participants = new Map<string, DraftParticipantDTO>();
  readonly #invites = new Map<string, ProductInviteDTO>();
  readonly #registrations = new Map<string, ProductOrderTriggerRecord>();

  async createDraft(draft: ProductOrderDraftDTO, participants: readonly DraftParticipantDTO[]): Promise<void> {
    this.#drafts.set(draft.draftId, draft);
    for (const participant of participants) {
      this.#participants.set(participant.participantId, participant);
    }
  }

  async getDraft(draftId: string): Promise<ProductOrderDraftDTO | undefined> {
    return this.#drafts.get(draftId);
  }

  async updateDraft(draft: ProductOrderDraftDTO): Promise<void> {
    this.#drafts.set(draft.draftId, draft);
  }

  async listParticipants(draftId: string): Promise<readonly DraftParticipantDTO[]> {
    return [...this.#participants.values()].filter((participant) => participant.draftId === draftId);
  }

  async listAcceptedParticipantsByWallet(walletAddress: string): Promise<readonly DraftParticipantDTO[]> {
    const normalizedWallet = walletAddress.toLowerCase();
    return [...this.#participants.values()]
      .filter((participant) =>
        participant.status === "accepted" &&
        participant.walletAddress?.toLowerCase() === normalizedWallet
      )
      .sort(compareParticipantAcceptedAsc);
  }

  async getParticipant(participantId: string): Promise<DraftParticipantDTO | undefined> {
    return this.#participants.get(participantId);
  }

  async updateParticipant(participant: DraftParticipantDTO): Promise<void> {
    this.#participants.set(participant.participantId, participant);
  }

  async createInviteIfNoneActive(invite: ProductInviteDTO, nowIso: string): Promise<boolean> {
    const hasActive = [...this.#invites.values()].some((existing) =>
      existing.participantId === invite.participantId &&
      existing.status === "active" &&
      Date.parse(existing.expiresAt) > Date.parse(nowIso)
    );
    if (hasActive) {
      return false;
    }
    this.#invites.set(invite.inviteId, invite);
    return true;
  }

  async getInvite(inviteId: string): Promise<ProductInviteDTO | undefined> {
    return this.#invites.get(inviteId);
  }

  async updateInvite(invite: ProductInviteDTO): Promise<void> {
    this.#invites.set(invite.inviteId, invite);
  }

  async updateInviteIfActive(invite: ProductInviteDTO): Promise<boolean> {
    const existing = this.#invites.get(invite.inviteId);
    if (!existing || existing.status !== "active") {
      return false;
    }
    this.#invites.set(invite.inviteId, invite);
    return true;
  }

  async listInvitesByDraft(draftId: string): Promise<readonly ProductInviteDTO[]> {
    return [...this.#invites.values()].filter((invite) => invite.draftId === draftId);
  }

  async createRegistrationIfNoneForDraft(registration: ProductOrderTriggerRecord): Promise<boolean> {
    // 检查与写入必须同一同步段完成：中途 await 会让并发调用在微任务
    // 边界各自通过检查，双双插入（内存实现的"临界区"就靠这段同步代码）。
    const existing = [...this.#registrations.values()]
      .some((candidate) => candidate.draftId === registration.draftId);
    if (existing) {
      return false;
    }
    this.#registrations.set(registration.triggerId, registration);
    return true;
  }

  async getRegistration(triggerId: string): Promise<ProductOrderTriggerRecord | undefined> {
    return this.#registrations.get(triggerId);
  }

  async getRegistrationByDraft(draftId: string): Promise<ProductOrderTriggerRecord | undefined> {
    return [...this.#registrations.values()].find((registration) => registration.draftId === draftId);
  }

  async listRegistrations(): Promise<readonly ProductOrderTriggerRecord[]> {
    return [...this.#registrations.values()].sort(compareRegistrationCreatedAsc);
  }

  async updateRegistration(registration: ProductOrderTriggerRecord): Promise<void> {
    this.#registrations.set(registration.triggerId, registration);
  }
}

function compareRegistrationCreatedAsc(
  left: ProductOrderTriggerRecord,
  right: ProductOrderTriggerRecord
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.triggerId.localeCompare(right.triggerId);
}

function compareParticipantAcceptedAsc(left: DraftParticipantDTO, right: DraftParticipantDTO): number {
  return (left.acceptedAt ?? "").localeCompare(right.acceptedAt ?? "") || left.participantId.localeCompare(right.participantId);
}
