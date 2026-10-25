// V3 可见性类型：唯一 resolver 的输出（scope + allowed fields）与字段级
// 读投影形状。配置/阶段/slot 绑定在服务端解析；响应里不出现 locator/URI。
// 该模块不做状态机，只描述“谁能看到哪些字段”。

import type { ConfigSlotVisibilityV3 } from "@uvp-eth/product-dto";
import type { Address } from "../shared/types.js";
import type { OrderV3VisibilitySnapshot } from "../order/v3/service.js";

export type VisibilityScope = "buyer" | "performer" | "verifier" | "operator";

export type StageRole = "payer" | "payee" | "verifier" | "participant";

export interface VisibilityFields {
  readonly orderTitle: boolean;
  readonly orderStatus: boolean;
  readonly stageList: "all" | "own" | "summary";
  readonly amounts: boolean;
  readonly walletAddresses: boolean;
  readonly contactRefs: boolean;
  readonly evidenceHandles: boolean;
  readonly escrowAmounts: boolean;
  readonly escrowState: boolean;
  readonly instructions: boolean;
}

export interface VisibilityDecision {
  readonly orderId: string;
  readonly wallet: string;
  readonly scope: VisibilityScope;
  readonly allowed: VisibilityFields;
  /** 允许读取的 stageKey；buyer/operator 为全部 stage。 */
  readonly stageKeys: ReadonlySet<string>;
  /** 本单 stageKey → 当前钱包在该 stage 的角色（buyer/operator 为空）。 */
  readonly roleByStage: ReadonlyMap<string, StageRole>;
}

export type ResourceResolution =
  | { readonly kind: "ok"; readonly contentHash?: string }
  | { readonly kind: "empty" }
  | { readonly kind: "not_found" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "resolve_failed"; readonly message?: string }
  | { readonly kind: "unavailable"; readonly message?: string };

export interface ResourceResolverPort {
  resolve(input: {
    readonly orderId: string;
    readonly stageKey: string;
    readonly handleKey: string;
    readonly wallet: string;
  }): Promise<ResourceResolution>;
}

export interface VisibilityResolverOptions {
  readonly loadOrder: (orderId: string) => Promise<OrderV3VisibilitySnapshot | undefined>;
  readonly operatorWallets?: readonly Address[];
}

export interface VisibilityResolver {
  resolveVisibility(orderId: string, stageKey: string | undefined, wallet: Address): Promise<VisibilityDecision>;
}

export interface ConfigSlotVisibilitySource {
  readonly slotKey: string;
  readonly visibility?: ConfigSlotVisibilityV3;
}

export interface StandardViewV3 {
  readonly name: string;
  readonly version?: string;
  readonly hash?: string;
}

export interface SlotViewV3 {
  readonly slotKey: string;
  readonly required: boolean;
  readonly subjectLabel?: string;
  readonly status: string;
  readonly wallet?: string;
  readonly contactRef?: string;
}

export interface HandleViewV3 {
  readonly handleKey: string;
  readonly version?: string;
  readonly hash?: string;
}

export interface EscrowViewV3 {
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly stageKey: string;
  readonly trancheId?: string;
  readonly state?: string;
  readonly amount?: string;
  readonly feeBps?: number;
  readonly payer?: string;
  readonly payee?: string;
  readonly verifier?: string;
  readonly feeRecipient?: string;
  readonly observationDays?: number;
  readonly updatedAt?: string;
  readonly funded?: boolean;
  readonly reason?: string;
}

export interface InstructionViewV3 {
  readonly instructionId: string;
  readonly kind: string;
  readonly status: string;
  readonly trancheId: string;
  readonly instructionRef: string;
  readonly payerAmount?: string;
  readonly payeeAmount?: string;
  readonly requiredSigners?: readonly string[];
  readonly signedRoles?: readonly string[];
  readonly executeEligibleAt?: string;
  readonly blockedByDispute?: boolean;
  readonly txHash?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InstructionListViewV3 {
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly stageKey: string;
  readonly items: readonly InstructionViewV3[];
  readonly reason?: string;
}

export interface ResourceListViewV3 {
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly stageKey: string;
  readonly items: readonly HandleViewV3[];
  readonly reason?: string;
}

export interface StageViewV3 {
  readonly stageKey: string;
  readonly stageId: string;
  readonly index: number;
  readonly status: string;
  readonly amount?: string;
  readonly feeBps?: number;
  readonly acceptanceMode?: string;
  readonly verifierMode?: string;
  readonly finalStandardHash?: string;
  readonly inviteDeadline?: string;
  readonly workDeadline?: string;
  readonly windowValues?: Readonly<Record<string, number>>;
  readonly standard?: StandardViewV3;
  readonly slots?: readonly SlotViewV3[];
  readonly fileResources?: readonly HandleViewV3[];
  readonly escrow?: EscrowViewV3;
}

export interface OrderViewV3 {
  readonly orderId: string;
  readonly planId?: string;
  readonly chainId?: number;
  readonly stateMachine?: string;
  readonly status?: string;
  readonly title?: string;
  readonly currency?: string;
  readonly buyerWallet?: string;
  readonly termsHash?: string;
  readonly txHash?: string;
  readonly draftId?: string;
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly stages: readonly StageViewV3[];
}

export interface BindingViewV3 {
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly stageKey: string;
  readonly stageId: string;
  readonly status: string;
  readonly payerSlot?: string;
  readonly payeeSlot?: string;
  readonly verifierSlot?: string;
  readonly termsHash?: string;
  readonly amount?: string;
  readonly acceptanceMode?: string;
  readonly verifierMode?: string;
  readonly slots?: readonly SlotViewV3[];
}

export interface StageViewResponseV3 {
  readonly order: OrderViewV3;
  readonly stage: StageViewV3;
  readonly dataState: "ok" | "none" | "pending" | "unknown";
}

export interface OperatorStageViewV3 {
  readonly stageKey: string;
  readonly index: number;
  readonly status: string;
}

export interface OperatorOrderViewV3 {
  readonly orderId: string;
  readonly planId?: string;
  readonly status?: string;
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly stages: readonly OperatorStageViewV3[];
  readonly exceptions: readonly {
    readonly code: string;
    readonly stageKey?: string;
    readonly count: number;
    readonly firstSeenAt?: string;
  }[];
}
