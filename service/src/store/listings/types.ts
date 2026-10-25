import type { Address, Hex } from "../../shared/types.js";

// 秩序上架与锚核验：上架把已注册的链上秩序变成可发现商品；锚核验把
// listing 声称的锚与链上注册事实比对，不一致显式冲突；下架只改 Store
// 可见性，链上事实不受影响。

export type StoreListingStatus = "imported" | "public" | "rejected" | "delisted";

export interface StoreListingRecord {
  readonly listingId: string;
  readonly planId: Hex;
  readonly planHashClaimed?: Hex;
  readonly deploymentIdClaimed?: Hex;
  readonly stateMachineAddressClaimed?: Address;
  readonly status: StoreListingStatus;
  readonly importedByAddress?: Address;
  readonly importedByAccountId?: string;
  readonly importedAt: string;
  readonly reviewedByAddress?: Address;
  readonly reviewedAt?: string;
  readonly reviewNote?: string;
  readonly delistReason?: string;
  readonly updatedAt: string;
}

export interface StoreListingPrecondition {
  readonly status: StoreListingStatus;
}

export interface StoreListingSave {
  readonly applied: boolean;
  readonly record: StoreListingRecord;
}

export interface StoreListingStore {
  putListing(record: StoreListingRecord, expect?: StoreListingPrecondition): Promise<StoreListingSave>;
  getListing(listingId: string): Promise<StoreListingRecord | undefined>;
  findListingByPlanId(planId: Hex): Promise<StoreListingRecord | undefined>;
  listListings(status?: StoreListingStatus): Promise<readonly StoreListingRecord[]>;
}

export type StoreAnchorCheckOutcome = "match" | "mismatch" | "unavailable";

export interface StoreAnchorCheck {
  readonly id: string;
  readonly label: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly outcome: StoreAnchorCheckOutcome;
}

export type StoreAnchorVerificationStatus =
  | "consistent"
  | "conflict"
  | "pending_indexing";

export interface StoreAnchorVerificationDTO {
  readonly listingId: string;
  readonly planId: Hex;
  readonly status: StoreAnchorVerificationStatus;
  readonly checks: readonly StoreAnchorCheck[];
  readonly projection: {
    readonly planProjected: boolean;
    readonly planHash?: Hex;
    readonly publisher?: Address;
    readonly deploymentId?: Hex;
    readonly stateMachineAddress?: Address;
    readonly registeredAtBlock?: number;
  };
  readonly chain?: {
    readonly source: "live_read";
    readonly chainId?: number;
    readonly stateMachineAddress?: Address;
    readonly planFinalized?: boolean;
    readonly planPublisher?: Address;
  };
  readonly chainReadFailed?: boolean;
  readonly verifiedAt: string;
}

export interface ListingAnchorChainView {
  readPlanAnchors(planId: Hex, stateMachineAddress?: Address): Promise<{
    readonly chainId?: number;
    readonly stateMachineAddress?: Address;
    readonly planCommitted?: boolean;
    readonly planFinalized?: boolean;
    readonly planPublisher?: Address;
  }>;
}

export interface StoreListingActor {
  readonly anchoredAddress?: Address;
  readonly accountId?: string;
  readonly accessLevel: string;
  readonly principalId?: string;
}

export class StoreListingServiceError extends Error {
  override readonly name = "StoreListingServiceError";

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
