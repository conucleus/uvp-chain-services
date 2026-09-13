// Docking 族：DockOpened/DockInputSubmitted/DockOutputSubmitted/
// DockOutputSatisfied 与 uvp.dock.v2 具名接口委托投影。
import type { ChainEvent } from "../events.js";
import type { Address, Hex } from "../../shared/types.js";
import {
  proofOf,
  provenanceOf,
  requiredAddressArg,
  requiredBytes32Arg,
  timelineOf,
  type ProjectionProvenance,
  type StateMachineProofProjection
} from "./proof.js";
import {
  appendOrderProof,
  appendOrderTimeline,
  ensureStateMachineOrder,
  stateMachineAddressForOrderEvent,
  stateMachineScopedKey,
  type MutableStateMachineOrderProjection,
  type StateMachineModuleIndex
} from "./order.js";
import type { MutableStateMachinePlanProjection } from "./plan.js";
import type { ProjectionReplayDiagnostics, Writable } from "./snapshot.js";

/**
 * uvp.dock.v2 具名接口委托协议投影。dock 实例身份由
 * dockInstanceId 唯一确定（哈希 preimage 覆盖双方 plan/order/route +
 * 接口/mode），投影键为 (chainId, stateMachineAddress, dockInstanceId)；
 * binding 细节（portKey/localHookId）来自 DockingModule 事件可见字段，
 * 事件不携带的补全由 keeper 通过 lens 视图按需读取。终态不由链上事件
 * 驱动：投影只记录开启与投递事实。
 */
export interface StateMachineDockInputDeliveryProjection {
  readonly inputBindingHash: Hex;
  readonly localPlanId: Hex;
  readonly localOrderId: Hex;
  readonly targetPlanId: Hex;
  readonly linkedOrderId: Hex;
  readonly targetSignalId: Hex;
  readonly payloadHash: Hex;
  readonly submitter: Address;
  readonly deliveredAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineDockOutputDeliveryProjection {
  readonly outputBindingHash: Hex;
  readonly localPlanId: Hex;
  readonly localOrderId: Hex;
  readonly targetPlanId: Hex;
  readonly linkedOrderId: Hex;
  readonly targetSignalId: Hex;
  readonly localSignalId: Hex;
  readonly payloadHash: Hex;
  readonly submitter: Address;
  readonly deliveredAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineDockProjection {
  readonly dockInstanceId: Hex;
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly localPlanId: Hex;
  readonly localOrderId: Hex;
  readonly routeId: Hex;
  readonly routeHash: Hex;
  /** keccak(interfaceName)：具名接口的链上 word 形态。 */
  readonly interfaceNameId: Hex;
  readonly targetPlanId: Hex;
  readonly linkedOrderId: Hex;
  readonly depth: number;
  readonly opener: Address;
  readonly inputDeliveries: Readonly<Record<string, StateMachineDockInputDeliveryProjection>>;
  readonly outputDeliveries: Readonly<Record<string, StateMachineDockOutputDeliveryProjection>>;
  readonly openedAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export type MutableStateMachineDockProjection = Writable<
  Omit<
    StateMachineDockProjection,
    "inputDeliveries" | "outputDeliveries"
  >
> & {
  inputDeliveries: Record<string, StateMachineDockInputDeliveryProjection>;
  outputDeliveries: Record<string, StateMachineDockOutputDeliveryProjection>;
};

export function applyDockOpened(
  state: {
    modules: StateMachineModuleIndex;
    plans: Map<string, MutableStateMachinePlanProjection>;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent
): void {
  const dockInstanceId = requiredBytes32Arg(event, "dockInstanceId");
  // DockOpened 由 UVPDockingModule 发出：先归一化到所属状态机地址。
  const stateMachineAddress = stateMachineAddressForOrderEvent(state, event);
  const localPlanId = requiredBytes32Arg(event, "localPlanId");
  const localOrderId = requiredBytes32Arg(event, "localOrderId");
  const linkedOrderId = requiredBytes32Arg(event, "linkedOrderId");
  const targetPlanId = requiredBytes32Arg(event, "targetPlanId");
  const opener = requiredAddressArg(event, "opener");
  const depth = Number(event.args["depth"] ?? 0);
  const proof = proofOf(event, {
    orderId: localOrderId,
    planId: localPlanId,
    submitter: opener
  });

  // 跨部署子订单归桶诊断：linkedOrderId 的子订单按 local 状态机地址建桶
  //（现状行为），但 targetPlan 无法在 local 状态机下定位已登记 plan 时，
  // 归属未经证实（跨部署 dock / plan 未登记 / 回放顺序缺口）——显式计数，
  // 不允许静默（对照 unresolvedModuleOrderEventCount 纪律）。
  if (!state.plans.has(stateMachineScopedKey(event.chainId, stateMachineAddress, targetPlanId))) {
    state.diagnostics.unresolvedDockTargetDeploymentCount += 1;
  }

  // 父订单与子订单各自补事件轨迹（订单本体由 OrderRegistered 等建桶）。
  const localOrder = ensureStateMachineOrder(state.orders, event, localOrderId, localPlanId, undefined, stateMachineAddress);
  localOrder.updatedAt = provenanceOf(event);
  appendOrderProof(localOrder, proof);
  appendOrderTimeline(localOrder, timelineOf(event, "委托 dock 已开启", proof, {
    orderId: localOrderId,
    planId: localPlanId,
    linkedOrderId
  }));
  const linkedOrder = ensureStateMachineOrder(
    state.orders,
    event,
    linkedOrderId,
    targetPlanId,
    undefined,
    stateMachineAddress
  );
  linkedOrder.updatedAt = provenanceOf(event);
  appendOrderProof(linkedOrder, proof);
  appendOrderTimeline(linkedOrder, timelineOf(event, "独立子订单已由 dock 创建", proof, {
    orderId: linkedOrderId,
    planId: targetPlanId
  }));

  const dock: MutableStateMachineDockProjection = {
    dockInstanceId,
    chainId: event.chainId,
    stateMachineAddress,
    localPlanId,
    localOrderId,
    routeId: requiredBytes32Arg(event, "routeId"),
    routeHash: requiredBytes32Arg(event, "routeHash"),
    interfaceNameId: requiredBytes32Arg(event, "interfaceNameId"),
    targetPlanId,
    linkedOrderId,
    depth,
    opener,
    inputDeliveries: {},
    outputDeliveries: {},
    openedAt: provenanceOf(event),
    updatedAt: provenanceOf(event),
    proof
  };
  state.docks.set(dockProjectionKey(event.chainId, stateMachineAddress, dockInstanceId), dock);
}

export function applyDockInputSubmitted(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent
): void {
  const dockInstanceId = requiredBytes32Arg(event, "dockInstanceId");
  const dock = findDockForEvent(state, event, dockInstanceId);
  if (!dock) {
    // dock 未开启（或模块归属无法解析）：显式计数，不允许静默丢弃。
    state.diagnostics.unresolvedDockEventCount += 1;
    return;
  }
  const inputBindingHash = requiredBytes32Arg(event, "inputBindingHash");
  const submitter = requiredAddressArg(event, "submitter");
  const proof = proofOf(event, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId,
    submitter
  });
  dock.inputDeliveries[inputBindingHash.toLowerCase()] = {
    inputBindingHash,
    localPlanId: requiredBytes32Arg(event, "localPlanId"),
    localOrderId: requiredBytes32Arg(event, "localOrderId"),
    targetPlanId: requiredBytes32Arg(event, "targetPlanId"),
    linkedOrderId: requiredBytes32Arg(event, "linkedOrderId"),
    targetSignalId: requiredBytes32Arg(event, "targetSignalId"),
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    submitter,
    deliveredAt: provenanceOf(event),
    proof
  };
  dock.updatedAt = provenanceOf(event);

  // 跨订单事件：父侧记录投递轨迹，子订单侧记录输入事实写入。
  const localOrder = ensureStateMachineOrder(
    state.orders,
    event,
    dock.localOrderId,
    dock.localPlanId,
    undefined,
    dock.stateMachineAddress
  );
  localOrder.updatedAt = provenanceOf(event);
  appendOrderProof(localOrder, proof);
  appendOrderTimeline(localOrder, timelineOf(event, "dock 输入已投递", proof, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId
  }));
  const linkedOrder = ensureStateMachineOrder(
    state.orders,
    event,
    dock.linkedOrderId,
    dock.targetPlanId,
    undefined,
    dock.stateMachineAddress
  );
  linkedOrder.updatedAt = provenanceOf(event);
  appendOrderProof(linkedOrder, proof);
  appendOrderTimeline(linkedOrder, timelineOf(event, "dock 输入事实已投递到子订单", proof, {
    orderId: dock.linkedOrderId,
    planId: dock.targetPlanId
  }));
}

export function applyDockOutputSubmitted(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent
): void {
  const dockInstanceId = requiredBytes32Arg(event, "dockInstanceId");
  const dock = findDockForEvent(state, event, dockInstanceId);
  if (!dock) {
    // dock 未开启（或模块归属无法解析）：显式计数，不允许静默丢弃。
    state.diagnostics.unresolvedDockEventCount += 1;
    return;
  }
  const outputBindingHash = requiredBytes32Arg(event, "outputBindingHash");
  const submitter = requiredAddressArg(event, "submitter");
  const proof = proofOf(event, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId,
    submitter
  });
  dock.outputDeliveries[outputBindingHash.toLowerCase()] = {
    outputBindingHash,
    localPlanId: requiredBytes32Arg(event, "localPlanId"),
    localOrderId: requiredBytes32Arg(event, "localOrderId"),
    targetPlanId: requiredBytes32Arg(event, "targetPlanId"),
    linkedOrderId: requiredBytes32Arg(event, "linkedOrderId"),
    targetSignalId: requiredBytes32Arg(event, "targetSignalId"),
    localSignalId: requiredBytes32Arg(event, "localSignalId"),
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    submitter,
    deliveredAt: provenanceOf(event),
    proof
  };
  dock.updatedAt = provenanceOf(event);

  // 跨订单事件：子侧记录输出已回写，父侧记录映射事实落账。
  const linkedOrder = ensureStateMachineOrder(
    state.orders,
    event,
    dock.linkedOrderId,
    dock.targetPlanId,
    undefined,
    dock.stateMachineAddress
  );
  linkedOrder.updatedAt = provenanceOf(event);
  appendOrderProof(linkedOrder, proof);
  appendOrderTimeline(linkedOrder, timelineOf(event, "子订单事实已由 dock 回写", proof, {
    orderId: dock.linkedOrderId,
    planId: dock.targetPlanId
  }));
  const localOrder = ensureStateMachineOrder(
    state.orders,
    event,
    dock.localOrderId,
    dock.localPlanId,
    undefined,
    dock.stateMachineAddress
  );
  localOrder.updatedAt = provenanceOf(event);
  appendOrderProof(localOrder, proof);
  appendOrderTimeline(localOrder, timelineOf(event, "子订单事实已映射回父订单", proof, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId
  }));
}

/** 兄弟 output 绑定的等价交付满足：没有发生新的镜像写入，只把该绑定收敛为
 * 已交付——不落子侧"已回写"与父侧"映射事实落账"时间线（那两条属于真正
 * 执行过写入的 Submitted 事件），父侧只留一条说明性时间线供审计解释该绑定
 * 为何没有 Submitted 事件。 */
export function applyDockOutputSatisfied(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    orders: Map<string, MutableStateMachineOrderProjection>;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent
): void {
  const dockInstanceId = requiredBytes32Arg(event, "dockInstanceId");
  const dock = findDockForEvent(state, event, dockInstanceId);
  if (!dock) {
    state.diagnostics.unresolvedDockEventCount += 1;
    return;
  }
  const outputBindingHash = requiredBytes32Arg(event, "outputBindingHash");
  const submitter = requiredAddressArg(event, "submitter");
  const proof = proofOf(event, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId,
    submitter
  });
  dock.outputDeliveries[outputBindingHash.toLowerCase()] = {
    outputBindingHash,
    localPlanId: requiredBytes32Arg(event, "localPlanId"),
    localOrderId: requiredBytes32Arg(event, "localOrderId"),
    targetPlanId: requiredBytes32Arg(event, "targetPlanId"),
    linkedOrderId: requiredBytes32Arg(event, "linkedOrderId"),
    targetSignalId: requiredBytes32Arg(event, "targetSignalId"),
    localSignalId: requiredBytes32Arg(event, "localSignalId"),
    payloadHash: requiredBytes32Arg(event, "payloadHash"),
    submitter,
    deliveredAt: provenanceOf(event),
    proof
  };
  dock.updatedAt = provenanceOf(event);

  const localOrder = ensureStateMachineOrder(
    state.orders,
    event,
    dock.localOrderId,
    dock.localPlanId,
    undefined,
    dock.stateMachineAddress
  );
  localOrder.updatedAt = provenanceOf(event);
  appendOrderProof(localOrder, proof);
  appendOrderTimeline(localOrder, timelineOf(event, "绑定已由等价交付满足（本地事实已由兄弟绑定送达）", proof, {
    orderId: dock.localOrderId,
    planId: dock.localPlanId
  }));
}

/** dock 事件桶定位：模块地址归一化 + dockInstanceId 键；未开启的 dock 事件忽略。 */
function findDockForEvent(
  state: {
    modules: StateMachineModuleIndex;
    diagnostics: ProjectionReplayDiagnostics;
    docks: Map<string, MutableStateMachineDockProjection>;
  },
  event: ChainEvent,
  dockInstanceId: Hex
): MutableStateMachineDockProjection | undefined {
  const stateMachineAddress = stateMachineAddressForOrderEvent(state, event);
  return state.docks.get(dockProjectionKey(event.chainId, stateMachineAddress, dockInstanceId));
}

function dockProjectionKey(chainId: number, stateMachineAddress: Address, dockInstanceId: Hex): string {
  return stateMachineScopedKey(chainId, stateMachineAddress, dockInstanceId);
}
