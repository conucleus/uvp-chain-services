// 订单域与外部能力之间的类型化端口。zhixu/plan 由凝结核按配置版本发布
// 一次，所有订单复用同一 published plan；订单侧只查询/校验/绑定，不生成。
// 默认 registry provider 读配置版本上的 planId/planHash，缺失即 409。

import type { StageBinding } from "@uvp-eth/product-dto";
import type { Address, Hex } from "../shared/types.js";
import { OrderError } from "./types.js";

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
  readonly stageBindings: readonly StageBinding[];
  readonly idempotencyKey: string;
}

export interface OrderTriggerResult {
  readonly orderId: string;
  readonly stateMachine?: Address;
  readonly txHash?: Hex;
}

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
  readonly payloadHash: Hex;
  readonly idempotencyKey: string;
  readonly deadline: string;
  readonly stageBindings: readonly StageBinding[];
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

export class UnconfiguredPublishedPlanProvider implements PublishedPlanProvider {
  async resolvePublishedPlan(_input: PublishedPlanInput): Promise<PublishedPlan> {
    throw new OrderError(
      503,
      "published_plan_unavailable",
      "published-plan provider is not configured; the curator config version must publish a plan",
    );
  }
}

export class UnconfiguredOrderBirthPort implements OrderBirthPort {
  async birthOrder(_input: OrderBirthInput): Promise<OrderBirthResult> {
    throw new OrderError(
      503,
      "birth_transport_unavailable",
      "order birth port is not configured; the outside-trigger broadcaster must be wired",
    );
  }
}

export class UnconfiguredOrderTriggerPort implements OrderTriggerPort {
  async triggerOrder(_input: OrderTriggerInput): Promise<OrderTriggerResult> {
    throw new OrderError(
      503,
      "trigger_transport_unavailable",
      "order trigger port is not configured; wire the existing trigger/relay transport",
    );
  }
}
