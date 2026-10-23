import type { Address } from "../../shared/types.js";

export type StoreEntityRegistrationStatus = "self_declared" | "pending_review";

export interface StoreEntityRegistrationRecord {
  readonly registrationId: string;
  readonly accountAddress: Address;
  readonly accountId?: string;
  readonly legalName: string;
  readonly registrationNumber: string;
  readonly contactName: string;
  readonly status: StoreEntityRegistrationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoreEntityRegistrationStore {
  upsertRegistration(record: StoreEntityRegistrationRecord): Promise<StoreEntityRegistrationRecord>;
  getRegistrationByAccount(accountAddress: Address): Promise<StoreEntityRegistrationRecord | undefined>;
}
