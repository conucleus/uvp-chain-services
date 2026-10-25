// 语义 oracle（@uvp-eth/statemachine replayChainEvents）：把索引事件流与
// plan 编译产物合成的 PlanRegistered 一起喂给链上语义回放做对拍。只验证并
// 报告，不覆盖投影；mismatch/error/excluded 计数进 sync state 诊断。
// 事件合成手法镜像 uvp-deploy chaos/reconcile.ts 的 chainEventsFromLogs。
import {
  ChainReplayMismatchError,
  replayChainEvents,
  type ChainModeEvent,
  type ChainOracleHookStatus,
  type ChainOracleInstruction,
  type ChainOraclePlan
} from "@uvp-eth/statemachine";
import { onchainSignalKey } from "@uvp-eth/compiler";
import type { ChainEvent } from "./events.js";
import { buildActiveChainEventReplaySummary } from "./events.js";
import { optionalBytes32Arg, optionalUintArgAsString } from "./projections/proof.js";
import type { Hex } from "../shared/types.js";

const ORACLE_STATUS: Record<number, ChainOracleHookStatus> = {
  0: "init",
  1: "wait",
  2: "ready",
  3: "cxl"
};

const PLAN_FAMILY_EVENT_NAMES: ReadonlySet<string> = new Set([
  "PlanCommitted",
  "PlanFinalized",
  "PlanRegistered"
]);

export interface SemanticOraclePlan {
  readonly planId: Hex;
  readonly zhixuId: string;
  readonly compiledHooks: readonly {
    readonly hookId: Hex;
    readonly stageId?: Hex;
    readonly stageIdentifier?: string;
    readonly hookName?: string;
    readonly orderTriggerKind?: "none" | "mint" | "dock";
    readonly emitReady?: boolean;
    readonly instructions: readonly Record<string, unknown>[];
  }[];
  readonly dependencyIndex: Readonly<Record<string, readonly unknown[]>>;
  readonly admissions?: readonly {
    readonly admissionId?: Hex;
    readonly stageIdentifier?: string;
    readonly signalName?: string;
    readonly instructions?: readonly Record<string, unknown>[];
  }[];
}

export interface SemanticOracleSummary {
  readonly semanticOracleCheckedPlanCount: number;
  readonly semanticOracleMismatchCount: number;
  readonly semanticOracleErrorCount: number;
  readonly semanticOracleExcludedPlanCount: number;
}

export function emptySemanticOracleSummary(): SemanticOracleSummary {
  return {
    semanticOracleCheckedPlanCount: 0,
    semanticOracleMismatchCount: 0,
    semanticOracleErrorCount: 0,
    semanticOracleExcludedPlanCount: 0
  };
}

export function runSemanticOracleReplay(
  events: readonly ChainEvent[],
  plans: readonly SemanticOraclePlan[]
): SemanticOracleSummary {
  const payloads = new Map<string, ChainOraclePlan>();
  let excludedPlanCount = 0;
  for (const plan of plans) {
    const payload = semanticOraclePlanPayload(plan);
    if (!payload) {
      continue;
    }
    if (planCarriesDelay(plan)) {
      excludedPlanCount += 1;
      continue;
    }
    payloads.set(plan.planId.toLowerCase(), payload);
  }
  if (payloads.size === 0) {
    return {
      semanticOracleCheckedPlanCount: 0,
      semanticOracleMismatchCount: 0,
      semanticOracleErrorCount: 0,
      semanticOracleExcludedPlanCount: excludedPlanCount
    };
  }

  const scopes = new Map<string, ChainEvent[]>();
  for (const event of buildActiveChainEventReplaySummary(events).activeEvents) {
    const scope = `${event.chainId}:${event.contractAddress.toLowerCase()}`;
    const bucket = scopes.get(scope);
    if (bucket) {
      bucket.push(event);
    } else {
      scopes.set(scope, [event]);
    }
  }

  const checkedPlanIds = new Set<string>();
  let mismatchCount = 0;
  let errorCount = 0;
  for (const scopeEvents of scopes.values()) {
    const feed = semanticOracleFeedForScope(scopeEvents, payloads, checkedPlanIds);
    if (feed.length === 0) {
      continue;
    }
    try {
      replayChainEvents(feed);
    } catch (error) {
      if (error instanceof ChainReplayMismatchError) {
        mismatchCount += error.mismatches.length;
      } else {
        errorCount += 1;
      }
    }
  }
  return {
    semanticOracleCheckedPlanCount: checkedPlanIds.size,
    semanticOracleMismatchCount: mismatchCount,
    semanticOracleErrorCount: errorCount,
    semanticOracleExcludedPlanCount: excludedPlanCount
  };
}

function semanticOracleFeedForScope(
  events: readonly ChainEvent[],
  plans: ReadonlyMap<string, ChainOraclePlan>,
  checkedPlanIds: Set<string>
): ChainModeEvent[] {
  const orderPlans = new Map<string, ChainOraclePlan>();
  const feed: ChainModeEvent[] = [];
  const baseOf = (event: ChainEvent) => ({
    blockNumber: Number(event.blockNumber),
    logIndex: event.logIndex,
    transactionHash: event.transactionHash,
    contractAddress: event.contractAddress as `0x${string}`
  });
  const planForOrder = (event: ChainEvent, orderId: Hex | undefined): ChainOraclePlan | undefined => {
    if (!orderId) {
      return undefined;
    }
    return orderPlans.get(orderId.toLowerCase()) ??
      plans.get(optionalBytes32Arg(event, "planId")?.toLowerCase() ?? "");
  };

  for (const event of events) {
    if (PLAN_FAMILY_EVENT_NAMES.has(event.eventName)) {
      const planId = optionalBytes32Arg(event, "planId");
      const plan = planId ? plans.get(planId.toLowerCase()) : undefined;
      if (plan) {
        checkedPlanIds.add(plan.planId.toLowerCase());
        feed.push({
          ...baseOf(event),
          eventName: "PlanRegistered",
          plan
        });
      }
      continue;
    }
    if (event.eventName === "OrderRegistered") {
      const orderId = optionalBytes32Arg(event, "orderId");
      const planId = optionalBytes32Arg(event, "planId");
      const plan = planId ? plans.get(planId.toLowerCase()) : undefined;
      if (plan && orderId) {
        orderPlans.set(orderId.toLowerCase(), plan);
        checkedPlanIds.add(plan.planId.toLowerCase());
        feed.push({
          ...baseOf(event),
          eventName: "OrderRegistered",
          planId: plan.planId,
          zhixuId: plan.zhixuId,
          orderId: String(orderId),
          registeredAt: new Date(0).toISOString()
        });
      }
      continue;
    }
    if (event.eventName === "SignalSubmitted") {
      const orderId = optionalBytes32Arg(event, "orderId");
      const plan = planForOrder(event, orderId);
      const sourceId = optionalBytes32Arg(event, "sourceId");
      const signalId = optionalBytes32Arg(event, "signalId");
      if (plan && orderId && sourceId && signalId) {
        feed.push({
          ...baseOf(event),
          eventName: "SignalSubmitted",
          planId: plan.planId,
          zhixuId: plan.zhixuId,
          orderId: String(orderId),
          sourceId,
          signalId,
          signalKey: onchainSignalKey(sourceId, signalId),
          senderId: String(event.args["submitter"] ?? ""),
          submittedAt: new Date(0).toISOString()
        });
      }
      continue;
    }
    if (event.eventName === "HookStatusChanged") {
      const newStatus = statusArgOf(event.args["newStatus"]);
      if (newStatus !== 1 && newStatus !== 3) {
        continue;
      }
      const orderId = optionalBytes32Arg(event, "orderId");
      const plan = planForOrder(event, orderId);
      const hookId = optionalBytes32Arg(event, "hookId");
      if (plan && orderId && hookId) {
        const dueAtSeconds = optionalUintArgAsString(event, "dueAt");
        feed.push({
          ...baseOf(event),
          eventName: "HookStatusChanged",
          planId: plan.planId,
          zhixuId: plan.zhixuId,
          orderId: String(orderId),
          hookId: String(hookId),
          previousStatus: ORACLE_STATUS[statusArgOf(event.args["previousStatus"]) ?? 0] ?? "init",
          newStatus: ORACLE_STATUS[newStatus]!,
          ...(dueAtSeconds && dueAtSeconds !== "0"
            ? { dueAt: new Date(Number(dueAtSeconds) * 1000).toISOString() }
            : {})
        });
      }
      continue;
    }
    if (event.eventName === "HookReady") {
      const orderId = optionalBytes32Arg(event, "orderId");
      const plan = planForOrder(event, orderId);
      const hookId = optionalBytes32Arg(event, "hookId");
      if (plan && orderId && hookId) {
        const hook = plan.compiledHooks.find(
          (candidate) => candidate.hookId.toLowerCase() === hookId.toLowerCase()
        );
        feed.push({
          ...baseOf(event),
          eventName: "HookReady",
          planId: plan.planId,
          zhixuId: plan.zhixuId,
          orderId: String(orderId),
          hookId: String(hookId),
          stageIdentifier: hook?.stageIdentifier ?? String(optionalBytes32Arg(event, "stageId") ?? "unknown"),
          hookName: hook?.hookName ?? String(optionalBytes32Arg(event, "hookName") ?? "unknown")
        });
      }
      continue;
    }
  }
  return feed;
}

function semanticOraclePlanPayload(plan: SemanticOraclePlan): ChainOraclePlan | undefined {
  if (!Array.isArray(plan.compiledHooks) || plan.compiledHooks.length === 0) {
    return undefined;
  }
  const compiledHooks: ChainOraclePlan["compiledHooks"][number][] = [];
  for (const hook of plan.compiledHooks) {
    if (!hook || typeof hook !== "object" || typeof hook.hookId !== "string") {
      return undefined;
    }
    const instructions: ChainOracleInstruction[] = [];
    for (const instruction of hook.instructions ?? []) {
      const mapped = oracleInstructionOf(instruction);
      if (!mapped) {
        return undefined;
      }
      instructions.push(mapped);
    }
    compiledHooks.push({
      hookId: hook.hookId as `0x${string}`,
      stageId: (hook.stageId ?? hook.hookId) as `0x${string}`,
      stageIdentifier: hook.stageIdentifier ?? "unknown",
      hookName: hook.hookName ?? "unknown",
      orderTriggerKind: hook.orderTriggerKind ?? "none",
      emitReady: hook.emitReady ?? true,
      instructions
    });
  }
  const dependencyIndex: Record<string, readonly `0x${string}`[]> = {};
  for (const [key, targets] of Object.entries(plan.dependencyIndex ?? {})) {
    if (!Array.isArray(targets)) {
      return undefined;
    }
    dependencyIndex[key] = targets.map((target) => String(target) as `0x${string}`);
  }
  const admissions: NonNullable<ChainOraclePlan["admissions"]>[number][] = [];
  for (const admission of plan.admissions ?? []) {
    if (!admission || typeof admission !== "object") {
      return undefined;
    }
    const admissionId = hexWordOf(admission.admissionId);
    if (!admissionId) {
      continue;
    }
    const instructions: ChainOracleInstruction[] = [];
    for (const instruction of admission.instructions ?? []) {
      const mapped = oracleInstructionOf(instruction);
      if (!mapped) {
        return undefined;
      }
      instructions.push(mapped);
    }
    admissions.push({
      admissionId,
      stageIdentifier: admission.stageIdentifier ?? "unknown",
      signalName: admission.signalName ?? "unknown",
      instructions
    });
  }
  return {
    planId: plan.planId as `0x${string}`,
    zhixuId: plan.zhixuId,
    compiledHooks,
    dependencyIndex,
    ...(admissions.length > 0 ? { admissions } : {})
  };
}

function oracleInstructionOf(
  instruction: Record<string, unknown> | undefined
): ChainOracleInstruction | undefined {
  if (!instruction || typeof instruction !== "object") {
    return undefined;
  }
  switch (instruction.op) {
    case "SIGNAL": {
      const sourceId = hexWordOf(instruction.sourceId);
      const signalId = hexWordOf(instruction.signalId);
      const signalKey = hexWordOf(instruction.signalKey);
      return sourceId && signalId && signalKey
        ? { op: "SIGNAL", sourceId, signalId, signalKey }
        : undefined;
    }
    case "NOT":
      return { op: "NOT" };
    case "DELAY": {
      const delaySeconds = Number(instruction.delaySeconds);
      return Number.isFinite(delaySeconds)
        ? { op: "DELAY", delaySeconds }
        : undefined;
    }
    case "AND":
    case "OR": {
      const arity = Number(instruction.arity);
      return Number.isFinite(arity)
        ? { op: instruction.op, arity }
        : undefined;
    }
    default:
      return undefined;
  }
}

function hexWordOf(value: unknown): `0x${string}` | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? (value.toLowerCase() as `0x${string}`)
    : undefined;
}

function planCarriesDelay(plan: SemanticOraclePlan): boolean {
  const instructions = [
    ...plan.compiledHooks.flatMap((hook) => hook.instructions ?? []),
    ...(plan.admissions ?? []).flatMap((admission) => admission.instructions ?? [])
  ];
  return instructions.some((instruction) => instruction?.op === "DELAY");
}

function statusArgOf(value: unknown): number | undefined {
  const status = typeof value === "bigint"
    ? Number(value)
    : typeof value === "number" && Number.isInteger(value)
      ? value
      : undefined;
  return status !== undefined && status >= 0 && status <= 3 ? status : undefined;
}
