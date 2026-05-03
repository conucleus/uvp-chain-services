import type {
  DraftParticipantDTO,
  ProductInviteDTO,
  ProductOrderDraftDTO,
  ProductOrderStartDTO,
  ProductOrderStartStatus,
  ProductOrderRegistrationRecord
} from "./types.js";

export interface ProductOrderStartListOptions {
  readonly statuses?: readonly ProductOrderStartStatus[];
}

export interface ProductOrderStartPatch {
  readonly status?: ProductOrderStartStatus;
  readonly txHash?: ProductOrderStartDTO["txHash"] | null;
  readonly blockNumber?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly retryable?: boolean;
  readonly reconcileStatus?: ProductOrderStartDTO["reconcileStatus"] | null;
  readonly lastCheckedAt?: string | null;
  readonly receiptStatus?: ProductOrderStartDTO["receiptStatus"] | null;
  readonly projectionStatus?: ProductOrderStartDTO["projectionStatus"] | null;
  readonly updatedAt?: string;
}

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
  createRegistration(registration: ProductOrderRegistrationRecord): Promise<void>;
  getRegistration(registrationId: string): Promise<ProductOrderRegistrationRecord | undefined>;
  getRegistrationByDraft(draftId: string): Promise<ProductOrderRegistrationRecord | undefined>;
  listRegistrations(): Promise<readonly ProductOrderRegistrationRecord[]>;
  updateRegistration(registration: ProductOrderRegistrationRecord): Promise<void>;
  createOrderStart(record: ProductOrderStartDTO): Promise<void>;
  getOrderStartByRegistrationId(registrationId: string): Promise<ProductOrderStartDTO | undefined>;
  updateOrderStart(startId: string, patch: ProductOrderStartPatch): Promise<ProductOrderStartDTO | undefined>;
  listOrderStartsForReconcile(options?: ProductOrderStartListOptions): Promise<readonly ProductOrderStartDTO[]>;
}

export class MemoryProductBffStore implements ProductBffStore {
  readonly #drafts = new Map<string, ProductOrderDraftDTO>();
  readonly #participants = new Map<string, DraftParticipantDTO>();
  readonly #invites = new Map<string, ProductInviteDTO>();
  readonly #registrations = new Map<string, ProductOrderRegistrationRecord>();
  readonly #starts = new Map<string, ProductOrderStartDTO>();

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

  async createRegistration(registration: ProductOrderRegistrationRecord): Promise<void> {
    this.#registrations.set(registration.registrationId, registration);
  }

  async getRegistration(registrationId: string): Promise<ProductOrderRegistrationRecord | undefined> {
    return this.#registrations.get(registrationId);
  }

  async getRegistrationByDraft(draftId: string): Promise<ProductOrderRegistrationRecord | undefined> {
    return [...this.#registrations.values()].find((registration) => registration.draftId === draftId);
  }

  async listRegistrations(): Promise<readonly ProductOrderRegistrationRecord[]> {
    return [...this.#registrations.values()].sort(compareRegistrationCreatedAsc);
  }

  async updateRegistration(registration: ProductOrderRegistrationRecord): Promise<void> {
    this.#registrations.set(registration.registrationId, registration);
  }

  async createOrderStart(record: ProductOrderStartDTO): Promise<void> {
    if ([...this.#starts.values()].some((start) => start.registrationId === record.registrationId)) {
      throw new Error(`order start already exists for registration ${record.registrationId}`);
    }
    this.#starts.set(record.startId, record);
  }

  async getOrderStartByRegistrationId(registrationId: string): Promise<ProductOrderStartDTO | undefined> {
    return [...this.#starts.values()].find((start) => start.registrationId === registrationId);
  }

  async updateOrderStart(startId: string, patch: ProductOrderStartPatch): Promise<ProductOrderStartDTO | undefined> {
    const current = this.#starts.get(startId);
    if (!current) {
      return undefined;
    }
    const updated = applyOrderStartPatch(current, patch);
    this.#starts.set(startId, updated);
    return updated;
  }

  async listOrderStartsForReconcile(options: ProductOrderStartListOptions = {}): Promise<readonly ProductOrderStartDTO[]> {
    const statuses = options.statuses ? new Set(options.statuses) : undefined;
    return [...this.#starts.values()]
      .filter((start) => !statuses || statuses.has(start.status))
      .sort(compareOrderStartCreatedAsc);
  }
}

function compareRegistrationCreatedAsc(
  left: ProductOrderRegistrationRecord,
  right: ProductOrderRegistrationRecord
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.registrationId.localeCompare(right.registrationId);
}

function compareParticipantAcceptedAsc(left: DraftParticipantDTO, right: DraftParticipantDTO): number {
  return (left.acceptedAt ?? "").localeCompare(right.acceptedAt ?? "") || left.participantId.localeCompare(right.participantId);
}

function compareOrderStartCreatedAsc(left: ProductOrderStartDTO, right: ProductOrderStartDTO): number {
  return left.createdAt.localeCompare(right.createdAt) || left.startId.localeCompare(right.startId);
}

export function applyOrderStartPatch(
  current: ProductOrderStartDTO,
  patch: ProductOrderStartPatch
): ProductOrderStartDTO {
  const txHash = patchedOptional(current.txHash, patch, "txHash");
  const blockNumber = patchedOptional(current.blockNumber, patch, "blockNumber");
  const errorCode = patchedOptional(current.errorCode, patch, "errorCode");
  const errorMessage = patchedOptional(current.errorMessage, patch, "errorMessage");
  const reconcileStatus = patchedOptional(current.reconcileStatus, patch, "reconcileStatus");
  const lastCheckedAt = patchedOptional(current.lastCheckedAt, patch, "lastCheckedAt");
  const receiptStatus = patchedOptional(current.receiptStatus, patch, "receiptStatus");
  const projectionStatus = patchedOptional(current.projectionStatus, patch, "projectionStatus");

  return {
    startId: current.startId,
    registrationId: current.registrationId,
    draftId: current.draftId,
    orderId: current.orderId,
    ...(current.stateMachineAddress ? { stateMachineAddress: current.stateMachineAddress } : {}),
    ...(current.deploymentId ? { deploymentId: current.deploymentId } : {}),
    status: patch.status ?? current.status,
    ...(txHash !== undefined ? { txHash } : {}),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    retryable: patch.retryable ?? current.retryable,
    createdAt: current.createdAt,
    updatedAt: patch.updatedAt ?? current.updatedAt,
    ...(reconcileStatus !== undefined ? { reconcileStatus } : {}),
    ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
    ...(receiptStatus !== undefined ? { receiptStatus } : {}),
    ...(projectionStatus !== undefined ? { projectionStatus } : {})
  };
}

function patchedOptional<TValue, TKey extends keyof ProductOrderStartPatch>(
  current: TValue | undefined,
  patch: ProductOrderStartPatch,
  key: TKey
): TValue | undefined {
  if (!Object.hasOwn(patch, key)) {
    return current;
  }
  const value = patch[key];
  return value === null ? undefined : value as TValue | undefined;
}
