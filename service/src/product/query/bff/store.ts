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
  updateDraftIfStatus(draft: ProductOrderDraftDTO, expected: ProductOrderDraftDTO["status"]): Promise<boolean>;
  listParticipants(draftId: string): Promise<readonly DraftParticipantDTO[]>;
  listAcceptedParticipantsByWallet(walletAddress: string): Promise<readonly DraftParticipantDTO[]>;
  getParticipant(participantId: string): Promise<DraftParticipantDTO | undefined>;
  updateParticipant(participant: DraftParticipantDTO): Promise<void>;
  createInviteIfNoneActive(invite: ProductInviteDTO, nowIso: string): Promise<boolean>;
  getInvite(inviteId: string): Promise<ProductInviteDTO | undefined>;
  updateInvite(invite: ProductInviteDTO): Promise<void>;
  updateInviteIfActive(invite: ProductInviteDTO): Promise<boolean>;
  listInvitesByDraft(draftId: string): Promise<readonly ProductInviteDTO[]>;
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
