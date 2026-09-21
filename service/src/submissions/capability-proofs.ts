// 能力表/绑定表 Merkle 造证单源：链上只存 capabilitiesRoot，
// 词表成员资格由提交方按"字段重算叶 + 携 proof"自证。
//
// 消费方：submissions（submitSignalFor 的 attribution/selectorBinding）、
// stage-patches（applyStage*PatchFor 的 bindingProof/stageFacts）、
// product BFF trigger（triggerOrderFromOutsideFor 的 birthFactAttribution）。
// 叶公式/树形状不在本仓重实现——全部委托 @uvp-eth/compiler 的
// factAttribution/selectorBindingProof/signalCapabilityProof（与合约
// UVPPlanMetadataModule 的 leaf 例程逐字节一致），本模块只做投影形态
// （relation 字符串）与调用形态（protocol-bindings payload）之间的换装。
import {
  factAttribution as compilerFactAttribution,
  selectorBindingProof as compilerSelectorBindingProof,
  signalCapabilityProof as compilerSignalCapabilityProof
} from "@uvp-eth/compiler";
import type { StageFactPayload } from "@uvp-eth/protocol-bindings";
import { normalizeBytes32, type Hex } from "../shared/types.js";

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

/**
 * stage patch 的 stageFacts：目标阶段 relation=0（current）能力全表携证
 * ——驱动链上委任与时序闸，漏项 = 漏委任（fail-closed 方向）。任何一条
 * 证明缺失（表内不一致，理论不可达——富集时已断言 root 一致）返回
 * undefined 由调用方 fail-closed。
 */
export function stageFactsForTargetStage(
  tables: PlanCapabilityTables,
  targetStageId: Hex
): readonly StageFactPayload[] | undefined {
  const compiler = compilerTablesFromProjection(tables);
  const normalizedTarget = normalizeBytes32(targetStageId, "targetStageId");
  const facts: StageFactPayload[] = [];
  for (const capability of compiler.signalCapabilities) {
    if (capability.targetOrderRelation !== 0 || capability.stageId !== normalizedTarget) {
      continue;
    }
    const proof = compilerSignalCapabilityProof(
      compiler.selectorBindings,
      compiler.signalCapabilities,
      capability.stageId,
      capability.targetSourceId,
      capability.signalId,
      0
    );
    if (!proof) {
      return undefined;
    }
    facts.push({
      sourceId: capability.targetSourceId,
      signalId: capability.signalId,
      capabilityProof: [...proof]
    });
  }
  return facts;
}

/** 投影两表是否可用（外部发布 plan 富集不到产物 → 两表为空）。 */
export function hasPlanCapabilityTables(tables: PlanCapabilityTables | undefined): boolean {
  return Boolean(tables && (tables.selectorBindings.length > 0 || tables.signalCapabilities.length > 0));
}
