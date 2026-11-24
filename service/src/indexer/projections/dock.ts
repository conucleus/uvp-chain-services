// Dock 族：静态 Dock 注册投影与 binding/per-output 窗口读面形状
// （uvp.dock.v1 / uvp.dockBinding.v1）；事件族写入见 indexer/replay.ts。
import type { DockArtifact } from "@uvp-eth/compiler";
import type { Hex } from "@uvp-eth/service-runtime";
import { dockArtifactDkidOf } from "../../projection/dock-artifacts.js";
import type { ChainEvent } from "../events.js";
import {
  ZERO_BYTES32,
  proofOf,
  provenanceOf,
  requiredBytes32Arg,
  uintArgAsString,
  type ProjectionProvenance,
  type StateMachineProofProjection
} from "./proof.js";
import type { ProjectionReplayDiagnostics, Writable } from "./snapshot.js";

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

export type DockEnrichmentStatus = "enriched" | "failed";

export interface StateMachineDockProjection {
  readonly dkid: string;
  readonly docHash: Hex;
  readonly fromPlanId?: Hex;
  readonly toPlanId?: Hex;
  readonly enrichment?: DockEnrichmentStatus;
  readonly enrichmentError?: string;
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
  readonly supplierId: Hex;
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
  readonly enrichment?: DockEnrichmentStatus;
  readonly enrichmentError?: string;
  readonly proof?: StateMachineProofProjection;
}

export type DockArtifactOutputAst = DockArtifact["signalMap"][number]["ast"];
export type DockArtifactOutputDependency = DockArtifact["signalMap"][number]["dependencies"][number];

export function applyDockRegistered(
  state: {
    docks: Map<string, StateMachineDockProjection>;
    dockArtifacts: ReadonlyMap<string, DockArtifact>;
    diagnostics?: ProjectionReplayDiagnostics;
  },
  event: ChainEvent
): void {
  const dkid = requiredBytes32Arg(event, "dkid");
  const fromPlanId = requiredBytes32Arg(event, "fromPlanId");
  const toPlanId = requiredBytes32Arg(event, "toPlanId");
  const fromSourceId = requiredBytes32Arg(event, "fromSourceId");
  const toStageId = requiredBytes32Arg(event, "toStageId");
  const toSourceId = requiredBytes32Arg(event, "toSourceId");
  const docHash = requiredBytes32Arg(event, "docHash");
  const expectedDkid = dockArtifactDkidOf(docHash);
  const artifact = state.dockArtifacts.get(docHash.toLowerCase());
  const key = artifact?.dkid ?? expectedDkid;
  if (state.docks.has(key)) {
    return;
  }

  const mismatchReason = validateDockRegisteredAgainstArtifact({
    event,
    dkid,
    docHash,
    expectedDkid,
    fromPlanId,
    toPlanId,
    fromSourceId,
    toStageId,
    toSourceId,
    artifact
  });
  if (mismatchReason !== undefined || !artifact) {
    state.diagnostics && (state.diagnostics.dockEnrichmentMismatchCount += 1);
    state.docks.set(key, {
      dkid: expectedDkid,
      docHash,
      fromPlanId,
      toPlanId,
      enrichment: "failed",
      enrichmentError: mismatchReason ?? `missing dock artifact for ${expectedDkid} (${docHash})`,
      from: {
        zhixu: "",
        source: "",
        sourceId: fromSourceId
      },
      to: {
        zhixu: "",
        stage: "",
        stageId: toStageId,
        source: "",
        sourceId: toSourceId
      },
      signalMap: [],
      registeredAt: provenanceOf(event),
      proof: proofOf(event)
    });
    return;
  }

  state.docks.set(key, {
    dkid: artifact.dkid,
    docHash,
    fromPlanId,
    toPlanId,
    enrichment: "enriched",
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
      targetOrderRelation: "current",
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
        targetOrderRelation: "current"
      }))
    })),
    registeredAt: provenanceOf(event),
    proof: proofOf(event)
  });
}

export function applyStageDockSupplierSelected(
  state: {
    dockSelections: Map<string, StateMachineDockSelectionProjection>;
  },
  event: ChainEvent
): void {
  const planId = requiredBytes32Arg(event, "planId");
  const orderId = requiredBytes32Arg(event, "orderId");
  const targetStageId = requiredBytes32Arg(event, "targetStageId");
  const dockId = requiredBytes32Arg(event, "dockId");
  state.dockSelections.set(dockSelectionKey(planId, orderId, targetStageId), {
    planId,
    orderId,
    targetStageId,
    dockId,
    dkid: dkidOfDockId(dockId),
    supplierId: requiredBytes32Arg(event, "supplierId"),
    patchNonce: uintArgAsString(event, "patchNonce"),
    selectedAt: provenanceOf(event)
  });
}

export function applyDockBindingPoked(
  state: {
    docks?: ReadonlyMap<string, StateMachineDockProjection>;
    dockSelections: Map<string, StateMachineDockSelectionProjection>;
    dockBindings: Map<string, MutableStateMachineDockBindingProjection>;
    dockArtifactsByDkid: ReadonlyMap<string, DockArtifact>;
    diagnostics?: ProjectionReplayDiagnostics;
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
  const registeredDock = state.docks?.get(dkid);
  const artifact = registeredDock?.enrichment === "failed"
    ? undefined
    : state.dockArtifactsByDkid.get(dkid);
  const selection = state.dockSelections.get(dockSelectionKey(planId, orderId, targetStageId));
  const key = bindingId.toLowerCase();
  const existing = state.dockBindings.get(key);
  if (!artifact) {
    if (registeredDock === undefined) {
      state.diagnostics && (state.diagnostics.dockEnrichmentMismatchCount += 1);
    }
    state.dockBindings.set(key, {
      bindingId,
      dkid,
      planId,
      orderId,
      targetStageId,
      fromZhixuId: "",
      fromSource: "",
      fromOrderId,
      toZhixuId: "",
      toStageIdentifier: "",
      ...(selection ? { selectedBy: selection.selectedAt } : {}),
      pokedAt: provenanceOf(event),
      outputs: [],
      enrichment: "failed",
      enrichmentError: registeredDock?.enrichmentError ?? `${event.eventName} references dock ${dkid} with no recorded uvp.dock.v1 artifact`,
      proof: proofOf(event)
    });
    return;
  }
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
    enrichment: "enriched",
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
    return;
  }
  row.outputs = row.outputs.map((output) =>
    output.signalId.toLowerCase() === signalId.toLowerCase()
      ? { ...output, emitted: true, emittedBy: provenanceOf(event), emittedBindingId: bindingId }
      : output
  );
  row.proof = proofOf(event);
}

interface RawDockOutputAtomArg {
  readonly stageId?: unknown;
  readonly signalId?: unknown;
  readonly relation?: unknown;
}

interface RawDockOutputArg {
  readonly signalId?: unknown;
  readonly relation?: unknown;
  readonly atoms?: unknown;
}

function validateDockRegisteredAgainstArtifact(input: {
  readonly event: ChainEvent;
  readonly dkid: Hex;
  readonly docHash: Hex;
  readonly expectedDkid: string;
  readonly fromPlanId: Hex;
  readonly toPlanId: Hex;
  readonly fromSourceId: Hex;
  readonly toStageId: Hex;
  readonly toSourceId: Hex;
  readonly artifact: DockArtifact | undefined;
}): string | undefined {
  if (!input.artifact) {
    return `${input.event.eventName} references dock ${input.expectedDkid} (${input.docHash}) with no recorded uvp.dock.v1 artifact`;
  }
  if (
    input.artifact.dkid !== input.expectedDkid ||
    input.dkid.slice(2, 34).toLowerCase() !== input.docHash.slice(2, 34).toLowerCase()
  ) {
    return `${input.event.eventName} dkid ${input.dkid} does not match recorded artifact ${input.artifact.dkid} for docHash ${input.docHash}`;
  }
  if (input.fromPlanId === ZERO_BYTES32 || input.toPlanId === ZERO_BYTES32) {
    return `${input.event.eventName} has zero fromPlanId or toPlanId`;
  }
  if (input.artifact.from.sourceId.toLowerCase() !== input.fromSourceId.toLowerCase()) {
    return `${input.event.eventName} fromSourceId ${input.fromSourceId} does not match recorded artifact ${input.artifact.from.sourceId}`;
  }
  if (input.artifact.to.stageId.toLowerCase() !== input.toStageId.toLowerCase()) {
    return `${input.event.eventName} toStageId ${input.toStageId} does not match recorded artifact ${input.artifact.to.stageId}`;
  }
  if (input.artifact.to.sourceId.toLowerCase() !== input.toSourceId.toLowerCase()) {
    return `${input.event.eventName} toSourceId ${input.toSourceId} does not match recorded artifact ${input.artifact.to.sourceId}`;
  }

  const rawOutputs = input.event.args.outputs;
  if (!Array.isArray(rawOutputs)) {
    return `${input.event.eventName} outputs is missing or not an array`;
  }
  if (rawOutputs.length !== input.artifact.signalMap.length) {
    return `${input.event.eventName} outputs length ${rawOutputs.length} does not match recorded artifact signalMap length ${input.artifact.signalMap.length}`;
  }
  for (let index = 0; index < rawOutputs.length; index += 1) {
    const chainOutput = rawOutputs[index] as RawDockOutputArg | undefined;
    const artifactOutput = input.artifact.signalMap[index]!;
    if (
      typeof chainOutput?.signalId !== "string" ||
      chainOutput.signalId.toLowerCase() !== artifactOutput.signalId.toLowerCase()
    ) {
      return `${input.event.eventName} output[${index}].signalId does not match recorded artifact ${artifactOutput.signalId}`;
    }
    if (Number(chainOutput.relation) !== artifactOutput.targetOrderRelation) {
      return `${input.event.eventName} output[${index}].relation does not match recorded artifact`;
    }
    if (
      artifactOutput.sourceId.toLowerCase() !== input.toSourceId.toLowerCase() ||
      artifactOutput.stageId.toLowerCase() !== input.toStageId.toLowerCase()
    ) {
      return `${input.event.eventName} output[${index}] source/stage does not match on-chain target ${input.toSourceId}/${input.toStageId}`;
    }
    if (!Array.isArray(chainOutput.atoms) || chainOutput.atoms.length !== artifactOutput.atoms.length) {
      return `${input.event.eventName} output[${index}].atoms length does not match recorded artifact`;
    }
    for (let atomIndex = 0; atomIndex < chainOutput.atoms.length; atomIndex += 1) {
      const chainAtom = chainOutput.atoms[atomIndex] as RawDockOutputAtomArg | undefined;
      const artifactAtom = artifactOutput.atoms[atomIndex]!;
      if (
        typeof chainAtom?.stageId !== "string" ||
        chainAtom.stageId.toLowerCase() !== artifactAtom.stageId.toLowerCase() ||
        typeof chainAtom.signalId !== "string" ||
        chainAtom.signalId.toLowerCase() !== artifactAtom.signalId.toLowerCase() ||
        Number(chainAtom.relation) !== artifactAtom.targetOrderRelation
      ) {
        return `${input.event.eventName} output[${index}].atoms[${atomIndex}] does not match recorded artifact`;
      }
    }
  }
  return undefined;
}

export type MutableStateMachineDockBindingProjection = Writable<StateMachineDockBindingProjection>;

export function dockSelectionKey(planId: Hex, orderId: Hex, targetStageId: Hex): string {
  return `${planId.toLowerCase()}:${orderId.toLowerCase()}:${targetStageId.toLowerCase()}`;
}

function dkidOfDockId(dockId: Hex): string {
  return `zd-${dockId.slice(2, 34).toLowerCase()}`;
}
