import type {
  DraftParticipantDTO,
  ProductInviteDTO,
  ProductOrderDraftDTO,
  ProductOrderTriggerRecord
} from "./types.js";
import { StorageConstraintError } from "../../../storage/errors.js";

export interface ProductBffStore {
  withTransaction?<T>(operation: () => Promise<T>): Promise<T>;
  createDraft(draft: ProductOrderDraftDTO, participants: readonly DraftParticipantDTO[]): Promise<void>;
  getDraft(draftId: string): Promise<ProductOrderDraftDTO | undefined>;
  updateDraft(draft: ProductOrderDraftDTO): Promise<void>;
  /**
   * 条件状态迁移（CAS）：仅当现行 status 仍是 expected 时整行落档
   * （UPDATE ... WHERE draft_id=? AND status=?）。返回 false 表示并发方
   * 已先改状态——派生状态重算（refreshDraftStatus）与编辑器不得把读到
   * 旧快照的整行覆盖回去（如把已 triggering 的稿盖回 awaiting）。
   */
  updateDraftIfStatus(draft: ProductOrderDraftDTO, expected: ProductOrderDraftDTO["status"]): Promise<boolean>;
  listParticipants(draftId: string): Promise<readonly DraftParticipantDTO[]>;
  listAcceptedParticipantsByWallet(walletAddress: string): Promise<readonly DraftParticipantDTO[]>;
  getParticipant(participantId: string): Promise<DraftParticipantDTO | undefined>;
  /**
   * 更新参与者行（整行 upsert）。一钱包一角色不变量由存储层承担：
   * 持久驱动靠 (draft_id, LOWER(wallet_address)) WHERE status='accepted'
   * 部分唯一索引，内存实现靠写入时的同步查重——写入 status=accepted 且
   * 带钱包、同 draft 已有其他已接受行占用该钱包时抛
   * StorageConstraintError，服务层捕获后按 409 wallet_already_bound 收敛。
   */
  updateParticipant(participant: DraftParticipantDTO): Promise<void>;
  /**
   * 条件插入：participant 已有 active 且未过期的 invite 时拒绝
   * （返回 false）。常规路径由单语句 NOT EXISTS 判定；持久驱动的
   * (participant_id) WHERE status='active' 部分唯一索引是单活不变量的
   * 最终裁决者——语句快照读不到并发方的未提交行，败者在索引上撞车，
   * 约束命中同样按 false 返回（不外泄存储错误）。
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

  async updateDraftIfStatus(draft: ProductOrderDraftDTO, expected: ProductOrderDraftDTO["status"]): Promise<boolean> {
    // 判定与写入同处一个同步临界区：并发迁移只有一个赢家。
    const current = this.#drafts.get(draft.draftId);
    if (!current || current.status !== expected) {
      return false;
    }
    this.#drafts.set(draft.draftId, draft);
    return true;
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
    // 一钱包一角色的内存侧执行（对齐 0023 迁移的部分唯一索引）：
    // 判定与写入同处同步临界区，并发 accept 的败者在此抛约束错误，
    // 由服务层按 409 收敛。
    if (participant.status === "accepted" && participant.walletAddress) {
      const wallet = participant.walletAddress.toLowerCase();
      const taken = [...this.#participants.values()].some((other) =>
        other.participantId !== participant.participantId &&
        other.draftId === participant.draftId &&
        other.status === "accepted" &&
        other.walletAddress?.toLowerCase() === wallet
      );
      if (taken) {
        throw new StorageConstraintError(
          `wallet ${participant.walletAddress} is already bound to another accepted participant in draft ${participant.draftId}`
        );
      }
    }
    this.#participants.set(participant.participantId, participant);
  }

  async createInviteIfNoneActive(invite: ProductInviteDTO, nowIso: string): Promise<boolean> {
    void nowIso;
    // 对齐部分唯一索引的语义：单活判定只认 status，不看时间性过期——
    // 过期未翻档的 active 行同样占用索引，重邀由服务层先翻 expired 再插入。
    const hasActive = [...this.#invites.values()].some((existing) =>
      existing.participantId === invite.participantId &&
      existing.status === "active"
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
