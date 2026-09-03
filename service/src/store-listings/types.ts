import type { Address, Hex } from "../shared/types.js";

/**
 * PRD92 — 秩序上架与锚核验。
 *
 * - 上架 = 把已注册的链上秩序变成可发现、可核验的商品：导入编译产物锚
 *   （planId / planHash / deploymentId），配装修（PRD91），最小审核后公开。
 * - 锚核验：listing 声称的锚与链上注册事实（投影 + 可选的直读链）比对；
 *   不一致必须显式冲突并抑制加入入口，不得静默展示旧数据。
 * - 下架/隐藏只改 Store 可见性，链上事实不受影响。
 */

export type StoreListingStatus = "imported" | "public" | "rejected" | "delisted";

export interface StoreListingRecord {
  readonly listingId: string;
  readonly planId: Hex;
  /** 导入时声称的 planHash（可选；缺省时以投影 planHash 为基准记录）。 */
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

export interface StoreListingStore {
  putListing(record: StoreListingRecord): Promise<void>;
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
  /** 配置了链直读但读取失败（fail-closed：公开被阻断直至恢复）。 */
  readonly chainReadFailed?: boolean;
  readonly verifiedAt: string;
}

export interface ListingAnchorChainView {
  /** stateMachineAddress 缺省时用装配地址；多部署投影下按 plan 自己的地址直读。 */
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
