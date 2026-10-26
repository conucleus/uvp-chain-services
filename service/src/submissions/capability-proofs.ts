// 能力表/绑定表 Merkle 造证：链上只存 capabilitiesRoot，词表成员资格由
// 提交方携 proof 自证。叶公式/树形状单源在 @uvp-eth/compiler，本模块只
// 做投影形态与调用形态之间的换装。
import {
  factAttribution as compilerFactAttribution,
  merkleProof as compilerMerkleProof,
  merkleRoot as compilerMerkleRoot,
  selectorBindingProof as compilerSelectorBindingProof,
  signalCapabilityProof as compilerSignalCapabilityProof
} from "@uvp-eth/compiler";
import { keccak256, concatHex, stringToHex } from "viem";
import type { ProjectionStore } from "../storage/projection-store.js";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";

export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export interface BuiltFactAttribution {
  readonly sourceId: Hex;
  readonly signalId: Hex;
  readonly stageId: Hex;
  readonly capabilityProof: readonly Hex[];
}

export interface BuiltSelectorBinding {
  readonly selectorStageId: Hex;
  readonly proof: readonly Hex[];
}

export interface PlanCapabilityTableRow {
  readonly stageId: Hex;
  readonly targetSourceId: Hex;
  readonly signalId: Hex;
  readonly targetOrderRelation: "current" | "triggerOrigin" | "unknown";
}

export interface PlanSelectorBindingRow {
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
}

export interface PlanCapabilityTables {
  readonly selectorBindings: readonly PlanSelectorBindingRow[];
  readonly signalCapabilities: readonly PlanCapabilityTableRow[];
}

interface CompilerCapability {
  readonly stageId: Hex;
  readonly targetSourceId: Hex;
  readonly signalId: Hex;
  readonly targetOrderRelation: 0 | 1;
}

interface CompilerBinding {
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
}

export function compilerTablesFromProjection(
  tables: PlanCapabilityTables
): { readonly selectorBindings: readonly CompilerBinding[]; readonly signalCapabilities: readonly CompilerCapability[] } {
  return {
    selectorBindings: tables.selectorBindings.map((binding) => ({
      selectorStageId: normalizeBytes32(binding.selectorStageId, "selectorBindings.selectorStageId"),
      targetStageId: normalizeBytes32(binding.targetStageId, "selectorBindings.targetStageId")
    })),
    signalCapabilities: tables.signalCapabilities
      .filter((capability) => capability.targetOrderRelation !== "unknown")
      .map((capability) => ({
        stageId: normalizeBytes32(capability.stageId, "signalCapabilities.stageId"),
        targetSourceId: normalizeBytes32(capability.targetSourceId, "signalCapabilities.targetSourceId"),
        signalId: normalizeBytes32(capability.signalId, "signalCapabilities.signalId"),
        targetOrderRelation: capability.targetOrderRelation === "triggerOrigin" ? (1 as const) : (0 as const)
      }))
  };
}

export function zeroFactAttribution(sourceId: Hex, signalId: Hex): BuiltFactAttribution {
  return {
    sourceId: normalizeBytes32(sourceId, "attribution.sourceId"),
    signalId: normalizeBytes32(signalId, "attribution.signalId"),
    stageId: ZERO_BYTES32,
    capabilityProof: []
  };
}

export function zeroSelectorBinding(): BuiltSelectorBinding {
  return { selectorStageId: ZERO_BYTES32, proof: [] };
}

export function factAttributionPayload(
  tables: PlanCapabilityTables,
  sourceId: Hex,
  signalId: Hex
): BuiltFactAttribution {
  const compiler = compilerTablesFromProjection(tables);
  const attribution = compilerFactAttribution(
    compiler.selectorBindings,
    compiler.signalCapabilities,
    normalizeBytes32(sourceId, "sourceId"),
    normalizeBytes32(signalId, "signalId")
  );
  if (!attribution) {
    return zeroFactAttribution(sourceId, signalId);
  }
  return {
    sourceId: normalizeBytes32(sourceId, "attribution.sourceId"),
    signalId: normalizeBytes32(signalId, "attribution.signalId"),
    stageId: attribution.stageId,
    capabilityProof: [...attribution.capabilityProof]
  };
}

export function selectorBindingForTargetStage(
  tables: PlanCapabilityTables,
  targetStageId: Hex
): BuiltSelectorBinding {
  const compiler = compilerTablesFromProjection(tables);
  const normalizedTarget = normalizeBytes32(targetStageId, "targetStageId");
  const binding = compiler.selectorBindings.find(
    (candidate) => candidate.targetStageId === normalizedTarget
  );
  if (!binding) {
    return zeroSelectorBinding();
  }
  const proof = compilerSelectorBindingProof(
    compiler.selectorBindings,
    compiler.signalCapabilities,
    binding.selectorStageId,
    binding.targetStageId
  );
  if (!proof) {
    return zeroSelectorBinding();
  }
  return { selectorStageId: binding.selectorStageId, proof: [...proof] };
}

export function selectorBindingProofForPatch(
  tables: PlanCapabilityTables,
  selectorStageId: Hex,
  targetStageId: Hex
): BuiltSelectorBinding | undefined {
  const compiler = compilerTablesFromProjection(tables);
  const normalizedSelector = normalizeBytes32(selectorStageId, "selectorStageId");
  const normalizedTarget = normalizeBytes32(targetStageId, "targetStageId");
  if (!compiler.selectorBindings.some((binding) =>
    binding.selectorStageId === normalizedSelector && binding.targetStageId === normalizedTarget
  )) {
    return undefined;
  }
  const proof = compilerSelectorBindingProof(
    compiler.selectorBindings,
    compiler.signalCapabilities,
    normalizedSelector,
    normalizedTarget
  );
  if (!proof) {
    return undefined;
  }
  return { selectorStageId: normalizedSelector, proof: [...proof] };
}

export function hasPlanCapabilityTables(tables: PlanCapabilityTables | undefined): boolean {
  return Boolean(tables && (tables.selectorBindings.length > 0 || tables.signalCapabilities.length > 0));
}

export const EXECUTOR_CANDIDATE_LEAF_DOMAIN = "UVP_EXECUTOR_CANDIDATE_V1";

export interface PlanExecutorCandidateRow {
  readonly stageId: Hex;
  readonly executor: Address;
}

export function executorCandidateLeaf(
  stageId: Hex,
  executor: Address,
): Hex {
  return keccak256(
    concatHex([
      keccak256(stringToHex(EXECUTOR_CANDIDATE_LEAF_DOMAIN)),
      normalizeBytes32(stageId, "executorCandidate.stageId"),
      normalizeAddress(executor, "executorCandidate.executor"),
    ]),
  );
}

export function executorCandidatesRootOf(
  candidates: readonly PlanExecutorCandidateRow[],
): Hex {
  return compilerMerkleRoot(
    candidates.map((candidate) =>
      executorCandidateLeaf(candidate.stageId, candidate.executor),
    ),
  );
}

export function executorCandidateProofFor(
  candidates: readonly PlanExecutorCandidateRow[],
  stageId: Hex,
  executor: Address,
): readonly Hex[] | undefined {
  const leaf = executorCandidateLeaf(stageId, executor);
  if (!candidates.some((candidate) =>
    executorCandidateLeaf(candidate.stageId, candidate.executor) === leaf
  )) {
    return undefined;
  }
  const proof = compilerMerkleProof(
    candidates.map((candidate) =>
      executorCandidateLeaf(candidate.stageId, candidate.executor),
    ),
    leaf,
  );
  return proof ? [...proof] : undefined;
}

export function resolvePlanCapabilityTablesFromStore(
  store: ProjectionStore
): (planId: Hex) => Promise<PlanCapabilityTables | undefined> {
  return async (planId) => {
    const snapshot = await store.getOrderSnapshot();
    const plan = Object.values(snapshot.stateMachinePlans).find(
      (candidate) => candidate.planId.toLowerCase() === planId.toLowerCase()
    );
    if (!plan) {
      return undefined;
    }
    if (plan.capabilityEnrichment === "failed") {
      throw new Error(
        "plan capability enrichment failed in the last indexer replay (the plan artifact does not reproduce the on-chain capabilitiesRoot); the plan vocabulary state is unknown"
      );
    }
    if (plan.capabilityEnrichment !== "enriched") {
      return undefined;
    }
    return {
      selectorBindings: plan.selectorBindings,
      signalCapabilities: plan.signalCapabilities
    };
  };
}
