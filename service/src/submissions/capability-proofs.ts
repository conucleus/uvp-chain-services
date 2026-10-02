// 能力表/绑定表 Merkle 造证单源：链上只存 capabilitiesRoot，
// 词表成员资格由提交方按"字段重算叶 + 携 proof"自证。
//
// 消费方：submissions（submitSignalFor 的 attribution/selectorBinding）、
// stage-patches（applyStage*PatchFor 的 bindingProof/candidateProof/授权集
// 推导）、product BFF trigger（triggerOrderFromOutsideFor 的
// birthFactAttribution）。stageFacts 携证面已随合约 UB-2/UB-36 批从
// applyStage*PatchFor 尾参删除（时序闸改读合约原生 per-stage 计数）。
// 叶公式/树形状不在本仓重实现——全部委托 @uvp-eth/compiler 的
// factAttribution/selectorBindingProof/signalCapabilityProof（与合约
// UVPPlanMetadataModule 的 leaf 例程逐字节一致），本模块只做投影形态
// （relation 字符串）与调用形态（protocol-bindings payload）之间的换装。
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

/** 造证后的窄类型（protocol-bindings payload 的 Hex 收窄形态）。 */
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

/** 投影侧词表行（StateMachinePlanProjection 两表的最小结构形状）。 */
export interface PlanCapabilityTableRow {
  readonly stageId: Hex;
  readonly targetSourceId: Hex;
  readonly signalId: Hex;
  /** 投影关系词表；"unknown" 无法映射到链上 0/1 叶，造证时剔除。 */
  readonly targetOrderRelation: "current" | "triggerOrigin" | "unknown";
}

export interface PlanSelectorBindingRow {
  readonly selectorStageId: Hex;
  readonly targetStageId: Hex;
}

/** 造证入口的通用两表形状（plan 投影富集结果）。 */
export interface PlanCapabilityTables {
  readonly selectorBindings: readonly PlanSelectorBindingRow[];
  readonly signalCapabilities: readonly PlanCapabilityTableRow[];
}

/** compiler 叶序形态（relation 0/1）。 */
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
    // "unknown" 关系无法构成链上叶（0/1 之外的值重算叶必错）：剔除而不是
    // 猜一个——猜错会把无效证明发上链（InvalidFactAttribution）。
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

/** 全零 attribution：词表外事实不声明属主（合约按 source==stage 回退解析）。 */
export function zeroFactAttribution(sourceId: Hex, signalId: Hex): BuiltFactAttribution {
  return {
    sourceId: normalizeBytes32(sourceId, "attribution.sourceId"),
    signalId: normalizeBytes32(signalId, "attribution.signalId"),
    stageId: ZERO_BYTES32,
    capabilityProof: []
  };
}

/** 全零 selectorBinding：不携绑定证明（合约侧"未声明即放行"口径）。 */
export function zeroSelectorBinding(): BuiltSelectorBinding {
  return { selectorStageId: ZERO_BYTES32, proof: [] };
}

/**
 * 事实属主自证（relation=0 能力叶 proof）。词表内命中 → 属主阶段 + 成员
 * 资格证明；词表外/投影表空（外部发布 plan）→ 全零结构，链上按词表闸
 * 自行裁决（词表内事实会被 InvalidSignalCapability 拒绝——服务端无法
 * 为没有词表的 plan 造出证明，这是已知取舍而非静默放行）。
 */
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

/**
 * submitSignal 族 selectorBinding：按事实属主阶段（或已知目标阶段）找
 * 一条 selector→target 绑定叶 proof。找不到（该阶段未被 selector 绑定 /
 * 投影表空）→ 全零（合约按"未声明"放行，不阻断词表内合法提交）。
 */
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

/**
 * stage patch 的 bindingProof：证明 patch 声明的 (selector→target) 绑定叶
 * 在词表内。与 submitSignal 族不同，patch 合约入口强制验证该证明
 * （StageSelectorBindingNotFound）——绑定不在表内时返回 undefined 由
 * 调用方 fail-closed，绝不发全零（全零必被链上拒绝，只是晚一步）。
 */
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

/** 投影两表是否可用（外部发布 plan 富集不到产物 → 两表为空）。 */
export function hasPlanCapabilityTables(tables: PlanCapabilityTables | undefined): boolean {
  return Boolean(tables && (tables.selectorBindings.length > 0 || tables.signalCapabilities.length > 0));
}

// ---------------------------------------------------------------------------
// 执行者候选集（UB-36②③）造证：叶 = keccak256(abi.encodePacked(
// keccak256("UVP_EXECUTOR_CANDIDATE_V1"), stageId, executor))——注意是
// encodePacked 紧凑形态（address 20 字节右贴，84 字节 preimage），与能力叶
// 的 abi.encode 形态不同；树形状仍是 DockMerkle 排序配对树（compiler
// merkleRoot/merkleProof 单源）。叶域常量与合约
// UVPStagePatchModule.EXECUTOR_CANDIDATE_LEAF_DOMAIN /
// UVPPlanRegistration._executorCandidatesRoot 同源——protocol-bindings/
// compiler 尚未导出候选集工具，本模块是该叶公式在链下侧的唯一实现点，
// 由 stage-patches 测试对合约建树口径（同模块 merkleRoot）对拍钉住。
// ---------------------------------------------------------------------------

/** 候选集叶域字（与合约 _EXECUTOR_CANDIDATE_LEAF_DOMAIN 同源）。 */
export const EXECUTOR_CANDIDATE_LEAF_DOMAIN = "UVP_EXECUTOR_CANDIDATE_V1";

/** 候选集清单行的最小形状（plan 投影 executorCandidates / 产物清单共用）。 */
export interface PlanExecutorCandidateRow {
  readonly stageId: Hex;
  readonly executor: Address;
}

export function executorCandidateLeaf(
  stageId: Hex,
  executor: Address,
): Hex {
  // encodePacked(bytes32, bytes32, address)：address 紧凑 20 字节，
  // preimage 84 字节——与合约逐字节一致；多补零会产出另一棵树，
  // 证明在链上必拒（StageExecutorNotCandidate）。
  return keccak256(
    concatHex([
      keccak256(stringToHex(EXECUTOR_CANDIDATE_LEAF_DOMAIN)),
      normalizeBytes32(stageId, "executorCandidate.stageId"),
      normalizeAddress(executor, "executorCandidate.executor"),
    ]),
  );
}

/** 候选集全部叶子的树根；空集返回 EMPTY_MERKLE_ROOT（= DockMerkle.EMPTY_ROOT）。 */
export function executorCandidatesRootOf(
  candidates: readonly PlanExecutorCandidateRow[],
): Hex {
  return compilerMerkleRoot(
    candidates.map((candidate) =>
      executorCandidateLeaf(candidate.stageId, candidate.executor),
    ),
  );
}

/**
 * (stageId, executor) ∈ 候选集 的成员证明（applyStageExecutorPatch 族
 * candidateProof 参数）。清单空/叶不在集内 → undefined：候选集外没有
 * 任何人可以成为逐单执行者（合约恒拒 StageExecutorNotCandidate），
 * 调用方 fail-closed，不得发必 revert 的交易。
 */
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

/**
 * plan 投影词表两表解析（词表 Merkle 化的造证源）：按 planId 从投影
 * 快照读 selectorBindings/signalCapabilities（applyPlanFinalized 时产物
 * 富集 + capabilitiesRoot 断言的成果）。plan 不在投影/两表为空且富集态
 * 非 failed（外部发布 plan）→ undefined，消费方按全零结构降级（链上词表
 * 闸兜底）。富集态 failed（resolver 故障轮 / 产物 root 断言不过）→ 抛
 * 错：词表状态未知，全零造证会把必拒的 InvalidSignalCapability 留到链上
 * revert 才暴露（白烧代付 gas）——提交车道（submissions/product BFF
 * 的造证读取）catch 后归一为 409 capability_tables_unavailable；触发
 * 车道落 failed+retryable 档案，HTTP 面以 502 透传该 errorCode。
 */
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
        "plan capability enrichment failed in the last indexer replay; the plan vocabulary state is unknown"
      );
    }
    return {
      selectorBindings: plan.selectorBindings,
      signalCapabilities: plan.signalCapabilities
    };
  };
}
