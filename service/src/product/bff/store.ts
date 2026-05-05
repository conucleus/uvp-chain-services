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
  createInvite(invite: ProductInviteDTO): Promise<void>;
  getInvite(inviteId: string): Promise<ProductInviteDTO | undefined>;
  updateInvite(invite: ProductInviteDTO): Promise<void>;
  listInvitesByDraft(draftId: string): Promise<readonly ProductInviteDTO[]>;
  createRegistration(registration: ProductOrderTriggerRecord): Promise<void>;
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

  async createInvite(invite: ProductInviteDTO): Promise<void> {
    this.#invites.set(invite.inviteId, invite);
  }

  async getInvite(inviteId: string): Promise<ProductInviteDTO | undefined> {
    return this.#invites.get(inviteId);
  }

  async updateInvite(invite: ProductInviteDTO): Promise<void> {
    this.#invites.set(invite.inviteId, invite);
  }

  async listInvitesByDraft(draftId: string): Promise<readonly ProductInviteDTO[]> {
    return [...this.#invites.values()].filter((invite) => invite.draftId === draftId);
  }

  async createRegistration(registration: ProductOrderTriggerRecord): Promise<void> {
    this.#registrations.set(registration.triggerId, registration);
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
