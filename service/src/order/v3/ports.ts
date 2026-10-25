// V3 订单域与外部能力之间的类型化端口。zhixu/plan 由凝结核按配置版本发布
// 一次，所有订单复用同一 published plan；订单侧只查询/校验/绑定，不生成。
// 默认 registry provider 读配置版本上的 planId/planHash，缺失即 409。

import type { StageBindingV3 } from "@uvp-eth/product-dto";
import type { Address, Hex } from "../../shared/types.js";
import { OrderV3Error } from "./types.js";

export interface PublishedPlanInput {
  readonly configId: string;
  readonly configVersion: string;
  readonly configHash: Hex;
  readonly chainId: number;
}

export interface PublishedPlan {
  readonly planId: Hex;
  readonly planHash: Hex;
}

export interface PublishedPlanProvider {
  resolvePublishedPlan(input: PublishedPlanInput): Promise<PublishedPlan>;
}

export interface OrderTriggerInput {
  readonly draftId: string;
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly chainId: number;
  readonly buyerWallet: Address;
  readonly stateMachine: Address;
  readonly termsHash: Hex;
  readonly stageBindings: readonly StageBindingV3[];
  readonly idempotencyKey: string;
}

export interface OrderTriggerResult {
  readonly orderId: string;
  readonly stateMachine?: Address;
  readonly txHash?: Hex;
}

/** outside-trigger 出生入口（来自已发布 plan 注册产物）。 */
export interface OrderBirthRoute {
  readonly triggerHookId: Hex;
  readonly triggerStageId: Hex;
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly birthAuthorizer: Address;
  readonly attribution: {
    readonly sourceId: Hex;
    readonly signalId: Hex;
    readonly stageId: Hex;
    readonly capabilityProof: readonly Hex[];
  };
  readonly authorizations?: readonly {
    readonly sourceId: Hex;
    readonly signalId: Hex;
    readonly submitter: Address;
    readonly role: Hex;
    readonly metadataHash: Hex;
  }[];
}

export interface OrderBirthInput {
  readonly draftId: string;
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly chainId: number;
  readonly stateMachine: Address;
  readonly buyerWallet: Address;
  readonly creator: Address;
  readonly termsHash: Hex;
  /** 本单参数 canonical hash，进 outside-trigger 的 payloadHash。 */
  readonly payloadHash: Hex;
  readonly idempotencyKey: string;
  readonly deadline: string;
  readonly stageBindings: readonly StageBindingV3[];
  readonly fundedStageKeys: readonly string[];
  readonly skippedStageKeys: readonly string[];
  readonly birth: OrderBirthRoute;
}

export interface OrderBirthResult {
  readonly orderId: Hex;
  readonly stateMachine?: Address;
  readonly status: "confirmed" | "submitted" | "unknown";
  readonly txHash?: Hex;
}

export interface OrderBirthPort {
  birthOrder(input: OrderBirthInput): Promise<OrderBirthResult>;
}

export interface OrderTriggerPort {
  triggerOrder(input: OrderTriggerInput): Promise<OrderTriggerResult>;
}

/** 未接线/未注册的外部 plan 查询源：fail-closed，不伪造 planId。 */
export class UnconfiguredPublishedPlanProvider implements PublishedPlanProvider {
  async resolvePublishedPlan(_input: PublishedPlanInput): Promise<PublishedPlan> {
    // TODO(plan-publication): inject the curator-side published-plan registry
    // bridge when it lands; until then refuse rather than fabricate a plan id.
    throw new OrderV3Error(
      503,
      "published_plan_unavailable",
      "published-plan provider is not configured; the curator config version must publish a plan",
    );
  }
}

/** 未接线出生通道：fail-closed，不伪造 orderId。 */
export class UnconfiguredOrderBirthPort implements OrderBirthPort {
  async birthOrder(_input: OrderBirthInput): Promise<OrderBirthResult> {
    throw new OrderV3Error(
      503,
      "birth_transport_unavailable",
      "V3 order birth port is not configured; the outside-trigger broadcaster must be wired",
    );
  }
}

export class UnconfiguredOrderTriggerPort implements OrderTriggerPort {
  async triggerOrder(_input: OrderTriggerInput): Promise<OrderTriggerResult> {
    throw new OrderV3Error(
      503,
      "trigger_transport_unavailable",
      "V3 order trigger port is not configured; wire the existing trigger/relay transport",
    );
  }
}
