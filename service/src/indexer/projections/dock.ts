// Dock 族：静态 Dock 注册投影与 binding/per-output 窗口读面形状
// （uvp.dock.v1 / uvp.dockBinding.v1）；事件族写入见 indexer/replay.ts。
import type { DockArtifact } from "@uvp-eth/compiler";
import { ProjectionError, type Address, type Hex } from "@uvp-eth/service-runtime";
import { DockArtifactMissingError } from "../../projection/dock-artifacts.js";
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
import type { Writable } from "./snapshot.js";

export interface StateMachineDockAtomProjection {
  readonly source: string;
  readonly sourceId: Hex;
  readonly stage: string;
  readonly stageId: Hex;
  readonly signal: string;
  readonly signalId: Hex;
  readonly targetOrderRelation: "current";
}

export interface StateMachineDockOutputProjection {
  readonly signal: string;
  readonly signalId: Hex;
  readonly sourceId: Hex;
  readonly stageId: Hex;
  readonly targetOrderRelation: "current";
  readonly rawExpression: string;
  readonly ast: DockArtifactOutputAst;
  readonly dependencies: readonly DockArtifactOutputDependency[];
  readonly atoms: readonly StateMachineDockAtomProjection[];
}

export interface StateMachineDockProjection {
  readonly dkid: string;
  readonly docHash: Hex;
  readonly from: {
    readonly zhixu: string;
    readonly source: string;
    readonly sourceId: Hex;
  };
  readonly to: {
    readonly zhixu: string;
    readonly stage: string;
    readonly stageId: Hex;
    readonly source: string;
    readonly sourceId: Hex;
  };
  readonly signalMap: readonly StateMachineDockOutputProjection[];
  readonly registeredAt: ProjectionProvenance;
  readonly proof: StateMachineProofProjection;
}

export interface StateMachineDockSelectionProjection {
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly targetStageId: Hex;
  readonly dockId: Hex;
  readonly dkid: string;
  readonly fromPlanId: Hex;
  readonly supplierId: Hex;
  readonly selector: Address;
  readonly patchNonce: string;
  readonly selectedAt: ProjectionProvenance;
}

export interface StateMachineDockBindingOutputProjection {
  readonly signal: string;
  readonly signalId: Hex;
  readonly outputIndex: number;
  readonly emitted: boolean;
  readonly emittedBy?: ProjectionProvenance;
  readonly emittedBindingId?: Hex;
}

export interface StateMachineDockBindingProjection {
  readonly bindingId: Hex;
  readonly dkid: string;
  readonly planId: Hex;
  readonly orderId: Hex;
  readonly targetStageId: Hex;
  readonly fromZhixuId: string;
  readonly fromSource: string;
  readonly fromOrderId: Hex;
  readonly toZhixuId: string;
  readonly toStageIdentifier: string;
  readonly selectedBy?: ProjectionProvenance;
  readonly pokedAt: ProjectionProvenance;
  readonly outputs: readonly StateMachineDockBindingOutputProjection[];
  readonly proof?: StateMachineProofProjection;
}

export type DockArtifactOutputAst = DockArtifact["signalMap"][number]["ast"];
export type DockArtifactOutputDependency = DockArtifact["signalMap"][number]["dependencies"][number];

export function applyDockRegistered(
  state: {
    docks: Map<string, StateMachineDockProjection>;
    dockArtifacts: ReadonlyMap<string, DockArtifact>;
  },
  event: ChainEvent
): void {
  const dkid = requiredBytes32Arg(event, "dkid");
  const docHash = requiredBytes32Arg(event, "docHash");
  const artifact = state.dockArtifacts.get(docHash.toLowerCase());
  if (!artifact) {
    throw new DockArtifactMissingError({ chainId: event.chainId, dkid, docHash });
  }
  const expectedDkid = `zd-${docHash.slice(2, 34).toLowerCase()}`;
  if (artifact.dkid !== expectedDkid || dkid.slice(2, 34).toLowerCase() !== docHash.slice(2, 34).toLowerCase()) {
    throw new ProjectionError(
      `${event.eventName} dkid ${dkid} does not match recorded artifact ${artifact.dkid} for docHash ${docHash}`
    );
  }
  const key = artifact.dkid;
  if (state.docks.has(key)) {
    return;
  }
  state.docks.set(key, {
    dkid: artifact.dkid,
    docHash,
    from: {
      zhixu: artifact.from.zhixu,
      source: artifact.from.source,
      sourceId: artifact.from.sourceId
    },
    to: {
      zhixu: artifact.to.zhixu,
      stage: artifact.to.stage,
      stageId: artifact.to.stageId,
      source: artifact.to.source,
      sourceId: artifact.to.sourceId
    },
    signalMap: artifact.signalMap.map((output) => ({
      signal: output.signal,
      signalId: output.signalId,
      sourceId: output.sourceId,
      stageId: output.stageId,
      targetOrderRelation: output.targetOrderRelation === 0 ? "current" : "current",
      rawExpression: output.rawExpression,
      ast: output.ast,
      dependencies: output.dependencies.map((dependency) => ({ ...dependency })),
      atoms: output.atoms.map((atom) => ({
        source: atom.source,
        sourceId: atom.sourceId,
        stage: atom.stage,
        stageId: atom.stageId,
        signal: atom.signal,
        signalId: atom.signalId,
        targetOrderRelation: atom.targetOrderRelation === 0 ? "current" : "current"
      }))
    })),
    registeredAt: provenanceOf(event),
    proof: proofOf(event)
  });
}

export function applyStageDockExecutorSelected(
  state: {
    dockSelections: Map<string, StateMachineDockSelectionProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const orderId = requiredBytes32Arg(event, "orderId");
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const dockId = requiredBytes32Arg(event, "dockId");
  const fromPlanId = requiredBytes32Arg(event, "fromPlanId");
  state.dockSelections.set(dockSelectionKey(planId, orderId, targetStageId), {
    planId,
    orderId,
    targetStageId,
    dockId,
    dkid: dkidOfDockId(dockId),
    fromPlanId,
    supplierId: requiredBytes32Arg(event, "supplierId"),
    selector: requiredAddressArg(event, "selector"),
    patchNonce: uintArgAsString(event, "patchNonce"),
    selectedAt: provenanceOf(event)
  });
}

export function applyDockBindingPoked(
  state: {
    dockSelections: Map<string, StateMachineDockSelectionProjection>;
    dockBindings: Map<string, MutableStateMachineDockBindingProjection>;
    dockArtifactsByDkid: ReadonlyMap<string, DockArtifact>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const orderId = requiredBytes32Arg(event, "orderId");
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const dockId = requiredBytes32Arg(event, "dockId");
  const bindingId = requiredBytes32Arg(event, "bindingId");
  const fromOrderId = requiredBytes32Arg(event, "fromOrderId");
  const dkid = dkidOfDockId(dockId);
  const artifact = state.dockArtifactsByDkid.get(dkid);
  if (!artifact) {
    throw new ProjectionError(
      `${event.eventName} references dock ${dkid} with no recorded uvp.dock.v1 artifact`
    );
  }
  const selection = state.dockSelections.get(dockSelectionKey(planId, orderId, targetStageId));
  const key = bindingId.toLowerCase();
  const existing = state.dockBindings.get(key);
  state.dockBindings.set(key, {
    bindingId,
    dkid,
    planId,
    orderId,
    targetStageId,
    fromZhixuId: artifact.from.zhixu,
    fromSource: artifact.from.source,
    fromOrderId,
    toZhixuId: artifact.to.zhixu,
    toStageIdentifier: artifact.to.stage,
    ...(selection ? { selectedBy: selection.selectedAt } : {}),
    pokedAt: provenanceOf(event),
    outputs: existing
      ? existing.outputs
      : artifact.signalMap.map((output, outputIndex) => ({
        signal: output.signal,
        signalId: output.signalId,
        outputIndex,
        emitted: false
      })),
    proof: proofOf(event)
  });
}

export function applyDockOutputSubmitted(
  state: {
    dockBindings: Map<string, MutableStateMachineDockBindingProjection>;
  },
  event: ChainEvent
): void {
  const bindingId = requiredBytes32Arg(event, "bindingId");
  const signalId = requiredBytes32Arg(event, "signalId");
  const row = state.dockBindings.get(bindingId.toLowerCase());
  if (!row) {
    throw new ProjectionError(
      `${event.eventName} references unknown dock binding ${bindingId}`
    );
  }
  row.outputs = row.outputs.map((output) =>
    output.signalId.toLowerCase() === signalId.toLowerCase()
      ? { ...output, emitted: true, emittedBy: provenanceOf(event), emittedBindingId: bindingId }
      : output
  );
  row.proof = proofOf(event);
}

export type MutableStateMachineDockBindingProjection = Writable<StateMachineDockBindingProjection>;

export function dockSelectionKey(planId: Hex, orderId: Hex, targetStageId: Hex): string {
  return `${planId.toLowerCase()}:${orderId.toLowerCase()}:${targetStageId.toLowerCase()}`;
}

function dkidOfDockId(dockId: Hex): string {
  return `zd-${dockId.slice(2, 34).toLowerCase()}`;
}
