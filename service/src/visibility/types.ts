// 可见性类型：唯一 resolver 的输出（scope + allowed fields）与字段级
// 读投影形状。配置/阶段/slot 绑定在服务端解析；响应里不出现 locator/URI。
// 该模块不做状态机，只描述“谁能看到哪些字段”。

import type { ConfigSlotVisibility } from "@uvp-eth/product-dto";
import type { Address } from "../shared/types.js";
import type { OrderVisibilitySnapshot } from "../order/service.js";

export type VisibilityScope = "buyer" | "stage-executor" | "operator";

export interface VisibilityFields {
  readonly orderTitle: boolean;
  readonly orderStatus: boolean;
  readonly stageList: "all" | "own" | "summary";
  readonly amounts: boolean;
  readonly walletAddresses: boolean;
  readonly contactRefs: boolean;
  readonly evidenceHandles: boolean;
}

export interface VisibilityDecision {
  readonly orderId: string;
  readonly wallet: string;
  readonly scope: VisibilityScope;
  readonly allowed: VisibilityFields;
  readonly stageKeys: ReadonlySet<string>;
  readonly slotKeysByStage: ReadonlyMap<string, string>;
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
  readonly loadOrder: (orderId: string) => Promise<OrderVisibilitySnapshot | undefined>;
  readonly operatorWallets?: readonly Address[];
}

export interface VisibilityResolver {
  resolveVisibility(orderId: string, stageKey: string | undefined, wallet: Address): Promise<VisibilityDecision>;
}

export interface ConfigSlotVisibilitySource {
  readonly slotKey: string;
  readonly visibility?: ConfigSlotVisibility;
}

export interface StandardView {
  readonly name: string;
  readonly version?: string;
  readonly hash?: string;
}

export interface SlotView {
  readonly slotKey: string;
  readonly required: boolean;
  readonly subjectLabel?: string;
  readonly status: string;
  readonly wallet?: string;
  readonly contactRef?: string;
}

export interface HandleView {
  readonly handleKey: string;
  readonly version?: string;
  readonly hash?: string;
}

export interface ResourceListView {
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly stageKey: string;
  readonly items: readonly HandleView[];
  readonly reason?: string;
}

export interface StageView {
  readonly stageKey: string;
  readonly stageId: string;
  readonly index: number;
  readonly status: string;
  readonly amount?: string;
  readonly finalStandardHash?: string;
  readonly inviteDeadline?: string;
  readonly workDeadline?: string;
  readonly windowValues?: Readonly<Record<string, number>>;
  readonly standard?: StandardView;
  readonly slots?: readonly SlotView[];
  readonly fileResources?: readonly HandleView[];
}

export interface OrderView {
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
  readonly stages: readonly StageView[];
}

export interface StageViewResponse {
  readonly order: OrderView;
  readonly stage: StageView;
  readonly dataState: "ok" | "none" | "pending" | "unknown";
}

export interface OperatorStageView {
  readonly stageKey: string;
  readonly index: number;
  readonly status: string;
}

export interface OperatorOrderView {
  readonly orderId: string;
  readonly planId?: string;
  readonly status?: string;
  readonly dataState: "ok" | "none" | "pending" | "unknown";
  readonly stages: readonly OperatorStageView[];
  readonly exceptions: readonly {
    readonly code: string;
    readonly stageKey?: string;
    readonly count: number;
    readonly firstSeenAt?: string;
  }[];
}
