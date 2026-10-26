// Docking 族：DockOpened/DockAttached/DockInputSubmitted/
// DockOutputSubmitted/DockOutputSatisfied 与 uvp.dock.v2 具名接口委托投影。
import type { ChainEvent } from "../events.js";
import type { Address, Hex } from "@uvp-eth/service-runtime";
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
  readonly mode: StateMachineDockMode;
  readonly localPlanId: Hex;
  readonly localOrderId: Hex;
  readonly routeId: Hex;
  readonly routeHash: Hex;
  readonly interfaceNameId: Hex;
  readonly targetPlanId: Hex;
  readonly linkedOrderId: Hex;
  readonly depth: number;
  readonly opener?: Address;
  readonly attacher?: Address;
  readonly inputDeliveries: Readonly<Record<string, StateMachineDockInputDeliveryProjection>>;
  readonly outputDeliveries: Readonly<Record<string, StateMachineDockOutputDeliveryProjection>>;
  readonly openedAt: ProjectionProvenance;
  readonly updatedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export type StateMachineDockMode = "new" | "existing";

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

  if (!state.plans.has(stateMachineScopedKey(event.chainId, stateMachineAddress, targetPlanId))) {
    state.diagnostics.unresolvedDockTargetDeploymentCount += 1;
  }

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
    mode: "new",
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

export function applyDockAttached(
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
  const stateMachineAddress = stateMachineAddressForOrderEvent(state, event);
  const localPlanId = requiredBytes32Arg(event, "localPlanId");
  const localOrderId = requiredBytes32Arg(event, "localOrderId");
  const linkedOrderId = requiredBytes32Arg(event, "linkedOrderId");
  const targetPlanId = requiredBytes32Arg(event, "targetPlanId");
  const attacher = requiredAddressArg(event, "attacher");
  const depth = Number(event.args["depth"] ?? 0);
  const proof = proofOf(event, {
    orderId: localOrderId,
    planId: localPlanId,
    submitter: attacher
  });

  if (!state.plans.has(stateMachineScopedKey(event.chainId, stateMachineAddress, targetPlanId))) {
    state.diagnostics.unresolvedDockTargetDeploymentCount += 1;
  }

  const localOrder = ensureStateMachineOrder(state.orders, event, localOrderId, localPlanId, undefined, stateMachineAddress);
  localOrder.updatedAt = provenanceOf(event);
  appendOrderProof(localOrder, proof);
  appendOrderTimeline(localOrder, timelineOf(event, "委托 dock 已挂接既有目标单", proof, {
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
  appendOrderTimeline(linkedOrder, timelineOf(event, "本订单已被父单 dock 挂接", proof, {
    orderId: linkedOrderId,
    planId: targetPlanId
  }));

  const dock: MutableStateMachineDockProjection = {
    dockInstanceId,
    chainId: event.chainId,
    stateMachineAddress,
    mode: "existing",
    localPlanId,
    localOrderId,
    routeId: requiredBytes32Arg(event, "routeId"),
    routeHash: requiredBytes32Arg(event, "routeHash"),
    interfaceNameId: requiredBytes32Arg(event, "interfaceNameId"),
    targetPlanId,
    linkedOrderId,
    depth,
    attacher,
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
