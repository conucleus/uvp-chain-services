// Dock 控制器事件族：只读重放 UVPDockController 的一等事件
// （DockRegistered / DockLinkBound / DockOutputSubmitted），不推导窗口语义、
// 不拼装 stage_files payload；可从链事件完全重建。
import {
  ProjectionError,
  compareChainPointers,
  normalizeBytes32,
  type Address,
  type Hex
} from "@uvp-eth/service-runtime";
import type { ChainEvent } from "../events.js";
import {
  proofOf,
  provenanceOf,
  requiredAddressArg,
  requiredBytes32Arg,
  uintArgAsString,
  type ProjectionProvenance,
  type StateMachineProofProjection
} from "./proof.js";
import type { MutableStateMachineOrderProjection } from "./order.js";

export interface DockSpecOutputProjection {
  readonly outputIndex: number;
  readonly signalId: Hex;
  readonly relation: number;
}

export interface DockSpecProjection {
  readonly dkid: Hex;
  readonly fromPlanId: Hex;
  readonly fromSourceId: Hex;
  readonly toPlanId: Hex;
  readonly toStageId: Hex;
  readonly toSourceId: Hex;
  readonly docHash: Hex;
  readonly publisher: Address;
  readonly outputs: readonly DockSpecOutputProjection[];
  readonly registeredAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface DockLinkWindowProjection {
  readonly outputIndex: number;
  readonly signalId?: Hex;
  readonly active: boolean;
  readonly srcSatisfied: boolean;
  readonly srcDueAt: string;
  readonly dstAdmissionReady: boolean;
  readonly emitted: boolean;
}

export interface OrderDockLinkProjection {
  readonly linkId: Hex;
  readonly dkid: Hex;
  readonly fromPlanId: Hex;
  readonly fromOrderId: Hex;
  readonly toPlanId: Hex;
  readonly toOrderId: Hex;
  readonly toStageId: Hex;
  readonly toConsentStageId?: Hex;
  readonly toConsent: Address;
  readonly boundAt?: string;
  readonly windows?: readonly DockLinkWindowProjection[];
  readonly linkedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface OrderDockLinksProjection {
  readonly incoming: readonly OrderDockLinkProjection[];
  readonly outgoing: readonly OrderDockLinkProjection[];
}

export interface DockLinkSubmittedOutputProjection {
  readonly linkId: Hex;
  readonly outputIndex: number;
  readonly toPlanId: Hex;
  readonly toOrderId: Hex;
  readonly toSourceId: Hex;
  readonly signalId: Hex;
  readonly payloadHash: Hex;
  readonly idempotencyKey: Hex;
  readonly submittedAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface DockLinkProjection extends OrderDockLinkProjection {
  readonly submittedOutputs: readonly DockLinkSubmittedOutputProjection[];
}

export interface MutableDockControllerReplayState {
  readonly specs: Map<string, DockSpecProjection>;
  readonly links: Map<string, OrderDockLinkProjection>;
  readonly submittedOutputsByLink: Map<string, Map<number, DockLinkSubmittedOutputProjection>>;
}

export function createMutableDockControllerReplayState(): MutableDockControllerReplayState {
  return {
    specs: new Map(),
    links: new Map(),
    submittedOutputsByLink: new Map()
  };
}

export function applyDockControllerEvent(
  state: MutableDockControllerReplayState,
  event: ChainEvent
): boolean {
  switch (event.eventName) {
    case "DockRegistered":
      applyDockRegistered(state.specs, event);
      return true;
    case "DockLinkBound":
      applyDockLinkBound(state.links, event);
      return true;
    case "DockOutputSubmitted":
      applyDockOutputSubmitted(state.submittedOutputsByLink, event);
      return true;
    case "DockLinkReconciled":
    case "DockOutputDeferred":
      return true;
    default:
      return false;
  }
}

export function finalizeDockControllerProjections(
  state: MutableDockControllerReplayState,
  orders: Map<string, MutableStateMachineOrderProjection>
): {
  readonly dockSpecs: Record<string, DockSpecProjection>;
  readonly dockLinks: Record<string, DockLinkProjection>;
} {
  const dockSpecs: Record<string, DockSpecProjection> = {};
  for (const [key, spec] of state.specs) {
    dockSpecs[key] = spec;
  }

  const dockLinks: Record<string, DockLinkProjection> = {};
  const incomingByOrder = new Map<string, OrderDockLinkProjection[]>();
  const outgoingByOrder = new Map<string, OrderDockLinkProjection[]>();

  for (const [linkKey, link] of state.links) {
    const submittedMap = state.submittedOutputsByLink.get(linkKey);
    const submittedOutputs = submittedMap
      ? [...submittedMap.values()].sort((left, right) => left.outputIndex - right.outputIndex)
      : [];
    dockLinks[linkKey] = {
      ...link,
      submittedOutputs
    };

    const fromKey = orderTupleKey(link.linkedAt.chainId, link.fromPlanId, link.fromOrderId);
    const toKey = orderTupleKey(link.linkedAt.chainId, link.toPlanId, link.toOrderId);
    pushLink(outgoingByOrder, fromKey, link);
    pushLink(incomingByOrder, toKey, link);
  }

  for (const order of orders.values()) {
    const key = orderTupleKey(order.chainId, order.planId, order.orderId);
    const incoming = incomingByOrder.get(key);
    const outgoing = outgoingByOrder.get(key);
    if (!incoming && !outgoing) {
      continue;
    }
    order.dockLinks = {
      incoming: incoming ? [...incoming].sort(compareDockLinks) : [],
      outgoing: outgoing ? [...outgoing].sort(compareDockLinks) : []
    };
  }

  return { dockSpecs, dockLinks };
}

function applyDockRegistered(
  specs: Map<string, DockSpecProjection>,
  event: ChainEvent
): void {
  const dkid = requiredBytes32Arg(event, "dkid");
  const fromPlanId = requiredBytes32Arg(event, "fromPlanId");
  const toPlanId = requiredBytes32Arg(event, "toPlanId");
  const fromSourceId = requiredBytes32Arg(event, "fromSourceId");
  const toStageId = requiredBytes32Arg(event, "toStageId");
  const toSourceId = requiredBytes32Arg(event, "toSourceId");
  const docHash = requiredBytes32Arg(event, "docHash");
  const publisher = requiredAddressArg(event, "publisher");
  const outputs = parseDockOutputs(event);
  const key = dkid.toLowerCase();
  if (specs.has(key)) {
    return;
  }
  specs.set(key, {
    dkid,
    fromPlanId,
    fromSourceId,
    toPlanId,
    toStageId,
    toSourceId,
    docHash,
    publisher,
    outputs,
    registeredAt: provenanceOf(event),
    proof: proofOf(event, { submitter: publisher })
  });
}

function applyDockLinkBound(
  links: Map<string, OrderDockLinkProjection>,
  event: ChainEvent
): void {
  const linkId = requiredBytes32Arg(event, "linkId");
  const dkid = requiredBytes32Arg(event, "dkid");
  const fromPlanId = requiredBytes32Arg(event, "fromPlanId");
  const fromOrderId = requiredBytes32Arg(event, "fromOrderId");
  const toPlanId = requiredBytes32Arg(event, "toPlanId");
  const toOrderId = requiredBytes32Arg(event, "toOrderId");
  const toStageId = requiredBytes32Arg(event, "toStageId");
  const toConsentStageId = requiredBytes32Arg(event, "toConsentStageId");
  const toConsent = requiredAddressArg(event, "toConsent");
  const key = linkId.toLowerCase();
  if (links.has(key)) {
    return;
  }
  links.set(key, {
    linkId,
    dkid,
    fromPlanId,
    fromOrderId,
    toPlanId,
    toOrderId,
    toStageId,
    toConsentStageId,
    toConsent,
    linkedAt: provenanceOf(event),
    proof: proofOf(event, { orderId: toOrderId, planId: toPlanId, submitter: toConsent })
  });
}

function applyDockOutputSubmitted(
  submittedOutputsByLink: Map<string, Map<number, DockLinkSubmittedOutputProjection>>,
  event: ChainEvent
): void {
  const linkId = requiredBytes32Arg(event, "linkId");
  const outputIndex = parseOutputIndex(event);
  const toOrderId = requiredBytes32Arg(event, "toOrderId");
  const toPlanId = requiredBytes32Arg(event, "toPlanId");
  const toSourceId = requiredBytes32Arg(event, "toSourceId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const payloadHash = requiredBytes32Arg(event, "payloadHash");
  const idempotencyKey = requiredBytes32Arg(event, "idempotencyKey");
  const key = linkId.toLowerCase();
  let outputs = submittedOutputsByLink.get(key);
  if (!outputs) {
    outputs = new Map();
    submittedOutputsByLink.set(key, outputs);
  }
  if (outputs.has(outputIndex)) {
    return;
  }
  outputs.set(outputIndex, {
    linkId,
    outputIndex,
    toPlanId,
    toOrderId,
    toSourceId,
    signalId,
    payloadHash,
    idempotencyKey,
    submittedAt: provenanceOf(event),
    proof: proofOf(event, { orderId: toOrderId, planId: toPlanId })
  });
}

function parseDockOutputs(event: ChainEvent): readonly DockSpecOutputProjection[] {
  const raw = event.args["outputs"];
  if (!Array.isArray(raw)) {
    throw new ProjectionError("DockRegistered.outputs must be an array");
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ProjectionError(`DockRegistered.outputs[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const rawSignalId = record["signalId"];
    if (typeof rawSignalId !== "string" || rawSignalId.length === 0) {
      throw new ProjectionError(`DockRegistered.outputs[${index}].signalId must be a bytes32 hex string`);
    }
    const signalId = normalizeBytes32(rawSignalId, `DockRegistered.outputs[${index}].signalId`);
    const rawRelation = record["relation"];
    const relation = typeof rawRelation === "bigint"
      ? Number(rawRelation)
      : typeof rawRelation === "number"
        ? rawRelation
        : typeof rawRelation === "string" && /^\d+$/.test(rawRelation)
          ? Number(rawRelation)
          : 0;
    return {
      outputIndex: index,
      signalId,
      relation
    };
  });
}

function parseOutputIndex(event: ChainEvent): number {
  const raw = uintArgAsString(event, "outputIndex");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProjectionError("DockOutputSubmitted.outputIndex must be a non-negative safe integer");
  }
  return parsed;
}

function orderTupleKey(chainId: number, planId: Hex, orderId: Hex): string {
  return `${chainId}:${planId.toLowerCase()}:${orderId.toLowerCase()}`;
}

function pushLink(
  bucket: Map<string, OrderDockLinkProjection[]>,
  key: string,
  link: OrderDockLinkProjection
): void {
  const existing = bucket.get(key);
  if (existing) {
    existing.push(link);
    return;
  }
  bucket.set(key, [link]);
}

function compareDockLinks(
  left: OrderDockLinkProjection,
  right: OrderDockLinkProjection
): number {
  const position = compareChainPointers(left.linkedAt, right.linkedAt);
  if (position !== 0) {
    return position;
  }
  return left.linkId.localeCompare(right.linkId);
}
