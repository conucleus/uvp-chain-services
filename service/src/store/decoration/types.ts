import type { Address, Hex } from "../../shared/types.js";



export interface StoreZhixuDecorationTheme {
  readonly displayName?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly highlights?: readonly string[];
  readonly heroImageURI?: string;
}

export interface StoreZhixuTaskDeclaration {
  readonly stageId?: string;
  readonly taskId?: string;
}

export interface StoreZhixuDecorationData {
  readonly schemaVersion: "store-zhixu-decoration.v1";
  readonly theme?: StoreZhixuDecorationTheme;
  readonly taskDeclarations?: readonly StoreZhixuTaskDeclaration[];
}

export interface StoreZhixuDecorationVersionRecord {
  readonly decorationId: string;
  readonly planId: Hex;
  readonly version: number;
  readonly data: StoreZhixuDecorationData;
  readonly authorAddress: Address;
  readonly authorAccountId?: string;
  readonly note?: string;
  readonly createdAt: string;
}

export interface StorePublisherDelegationRecord {
  readonly delegationId: string;
  readonly publisherAddress: Address;
  readonly memberAddress: Address;
  readonly grantedByAddress: Address;
  readonly grantedByAccountId?: string;
  readonly grantedAt: string;
  readonly revokedAt?: string;
  readonly revokedByAddress?: Address;
  readonly reason?: string;
}

export interface StoreZhixuDecorationStore {
  appendVersion(record: StoreZhixuDecorationVersionRecord): Promise<void>;
  listVersions(planId: Hex): Promise<readonly StoreZhixuDecorationVersionRecord[]>;
}

export interface StorePublisherDelegationStore {
  appendDelegation(record: StorePublisherDelegationRecord): Promise<void>;
  updateDelegation(record: StorePublisherDelegationRecord): Promise<void>;
  findActiveDelegation(publisherAddress: Address, memberAddress: Address): Promise<StorePublisherDelegationRecord | undefined>;
  listDelegations(publisherAddress: Address): Promise<readonly StorePublisherDelegationRecord[]>;
  listDelegationsForMember(memberAddress: Address): Promise<readonly StorePublisherDelegationRecord[]>;
}

export interface StoreDecorationActor {
  readonly anchoredAddress: Address;
  readonly accountId?: string;
  readonly authMode: string;
}

export class StoreDecorationServiceError extends Error {
  override readonly name = "StoreDecorationServiceError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export type { Address, Hex };
