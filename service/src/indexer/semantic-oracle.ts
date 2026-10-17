// 语义 oracle 接入（@uvp-eth/statemachine replayChainEvents）：把索引事件
// 流与 plan 编译产物（compiledHooks/dependencyIndex）合成的 PlanRegistered
// 事件一起喂给链上语义回放——oracle 对 HookStatusChanged/HookReady 观测面
// 的期望与链上实际事件分叉即抛 ChainReplayMismatchError。投影以链为真：
// 校验只验证并报告，不覆盖投影；mismatch 捕获计数进 sync state 诊断
// （semanticOracleMismatchCount），非分叉抛错单独计
// semanticOracleErrorCount，DELAY 排除的 plan 计
// semanticOracleExcludedPlanCount（覆盖面分母诚实），不 crash 索引器。
//
// 事件合成手法镜像 uvp-deploy chaos/reconcile.ts 的 chainEventsFromLogs：
// plan 族事件按产物合成 PlanRegistered，HookStatusChanged 只喂可观测态
// （wait/cxl；ready/init 由 HookReady 观测），zhixuId 是富化键（产物 schema
// 缺省时回退 planId 字符串，同一 plan 内一致即可）。
//
// 覆盖面的诚实边界：oracle 的 DELAY 语义消费链上时钟（submittedAt/
// pokedAt），而索引事件流不携带区块时间戳——无法忠实重建时钟的
// DELAY-carrying plan 不进喂给面（连 TimerPoked 一并跳过），否则时钟错位
// 会制造假 mismatch。semanticOracleCheckedPlanCount 如实反映实际喂给 oracle
// 的 plan 子集，缺产物/产物形状不可用的 plan 同样不可校验。
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

/** 链上 HookStatus 枚举 → oracle 词表（frozen v0.10：init/wait/ready/cxl）。 */
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

/** oracle 喂给面的 plan 产物（防御性读取 store 域 onchainHookPlanArtifact）。 */
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
  /** 非分叉抛错（结构性毒流/native 运行时不可用）的单独计数：
   * oracle 无法为投影作证 ≠ 语义分叉，不与 mismatch 混同。 */
  readonly semanticOracleErrorCount: number;
  /** DELAY 语义排除的 plan 数（伴随 checked 计数暴露，覆盖面分母诚实）。 */
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

/**
 * 语义 oracle 投影校验（纯函数）：事件流 + plan 产物 → 分叉计数。
 * - 产物缺失/形状不可用或携带 DELAY 指令的 plan 不可校验，其事件整体不进
 *   喂给面；
 * - 事件按 (chainId, contractAddress) 作用域分组回放——oracle 的订单注册
 *   键是 planId::orderId，跨部署同键喂给同一场会互相污染；
 * - ChainReplayMismatchError 捕获后按 mismatches.length 计数；其余错误
 *   （结构性毒流/native 运行时不可用）同样不 crash，单独计
 *   semanticOracleErrorCount 并交由调用方日志面携带原因——oracle 无法
 *   为投影作证（error）与语义分叉（mismatch）不同车道，不混同。
 */
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
  // 订单注册表：orderId(lower) → plan（SignalSubmitted/HookStatusChanged/
  // HookReady 的事件载荷不总带 planId，与投影同口径从注册面回填）。
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
          // 非 DELAY plan 的求值不消费提交时钟；固定纪元保持喂给面确定性。
          submittedAt: new Date(0).toISOString()
        });
      }
      continue;
    }
    if (event.eventName === "HookStatusChanged") {
      const newStatus = statusArgOf(event.args["newStatus"]);
      if (newStatus !== 1 && newStatus !== 3) {
        // ready/init 不可观测（ready 经 HookReady 观测），与 chaos 同口径过滤。
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
    // TimerPoked 只服务 DELAY hook 的链上时钟求值，DELAY plan 已整体排除。
  }
  return feed;
}

/**
 * 产物 → oracle plan 载荷的防御性换装（chaos/reconcile.ts 的指令映射同
 * 手法）：任一指令形状不可用即整 plan 不可校验（返回 undefined），不猜值。
 */
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
    // admissionId 缺失/非字的条目整体省略：适格面是注册门的可选投影，
    // 省略只是不校验该门，不改变信号求值语义（链上被拒的信号本就无事件）。
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

/** DELAY 指令消费链上时钟（索引事件流无区块时间戳），携带即不可校验。 */
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
