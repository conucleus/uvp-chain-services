import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  CROSS_BORDER_ZHIXU_ID,
  crossBorderPlanIds,
  demoZhixuDetail
} from "@uvp-eth/product-dto/fixtures";
import type { ProductSchemaResolver } from "../src/product/application/service.js";

/**
 * Test-side explicit Store schema for the frozen cross-border fixture plan.
 * The runtime no longer carries any built-in catalog fallback, so tests that
 * exercise schema-backed behavior must register this schema themselves and
 * pass it via createApiRouter's productSchemaResolver option.
 */
export const crossBorderStoreProductSchema: StoreProductSchemaDTO = {
  schemaVersion: "store-product-schema.v1",
  version: 1,
  zhixuId: CROSS_BORDER_ZHIXU_ID,
  title: demoZhixuDetail.title,
  maintainer: demoZhixuDetail.maintainer,
  planId: crossBorderPlanIds.planId,
  planHash: crossBorderPlanIds.planHash,
  artifactHash: crossBorderPlanIds.artifactHash,
  ...(demoZhixuDetail.createOrderTrigger
    ? { createOrderTrigger: demoZhixuDetail.createOrderTrigger }
    : {}),
  roleSlots: demoZhixuDetail.roleSlots,
  orderPermissionTable: demoZhixuDetail.orderPermissionTable,
  capabilityPlugins: demoZhixuDetail.roleSlots.flatMap(
    (slot) => slot.capabilityPlugins ?? []
  ),
  businessPersonaLabels: demoZhixuDetail.applicableBusiness,
  stages: demoZhixuDetail.stages,
  selectorBindings: [],
  schemaHash:
    "0x9c3d6cda824a197ddea166e33c955cfa27a67bb693aad840daf14a24512be7af",
  validation: { ok: true, status: "explicit", issues: [] },
  createdAt: "2026-04-28T00:00:00.000Z",
  updatedAt: "2026-04-28T00:00:00.000Z"
};

export function crossBorderSchemaResolver(): ProductSchemaResolver {
  return {
    async getProductSchemaByPlan(planId) {
      if (planId === crossBorderPlanIds.planId) {
        return crossBorderStoreProductSchema;
      }
      if (planId === dockTargetPlanIds.planId) {
        return dockTargetStoreProductSchema;
      }
      return undefined;
    }
  };
}

/**
 * docking 禁止 self-docking：docking 测试需要一个与 cross-border
 * 不同的第二个 zhixu 作为 target，形状与 cross-border schema 一致以便
 * 产生候选信号映射。
 */
export const DOCK_TARGET_ZHIXU_ID = "zx-e0ea55b33cc412d7c6b82d68df182c1a";

export const dockTargetPlanIds = {
  planId: "0x0000000000000000000000000000000000000000000000000000000000000102",
  planHash: "0x0000000000000000000000000000000000000000000000000000000000000202",
  artifactHash: "0x0000000000000000000000000000000000000000000000000000000000000302"
} as const;

/**
 * 试拼沙箱以目标发布的具名接口为前提（dock v2）：dock target 的 schema
 * 携带 v2 制品的 dockInterface 承诺，产品详情据此镜像 dockableModules。
 */
const dockTargetOnchainHookPlanArtifact = {
  schemaVersion: "uvp.onchainHookPlan.v2",
  planId: dockTargetPlanIds.planId,
  zhixuId: DOCK_TARGET_ZHIXU_ID,
  zhixuName: "dock_target_staged_payment",
  platform: { type: "blockchain", provider: "eth" },
  sourcePlanHash: dockTargetPlanIds.planHash,
  compiledHooks: [],
  executorRoutes: [],
  selectorBindings: [],
  signalCapabilities: [],
  dockInterface: {
    schemaVersion: "uvp.dockInterfaceArtifact.v2",
    definition: {
      uid: DOCK_TARGET_ZHIXU_ID,
      definitionRefHash: "0x0000000000000000000000000000000000000000000000000000000000000402"
    },
    interfaceRoot: "0x0000000000000000000000000000000000000000000000000000000000000502",
    interfaces: [
      {
        name: "fulfillment_service",
        orderModes: ["new"],
        inputs: [
          {
            port: "execute",
            stageIdentifier: "fulfillment.intake",
            hookName: "EXECUTE",
            hookId: "fulfillment.intake#EXECUTE",
            canonicalInputSignal: "seller::fulfillment.intake.execute",
            canonicalInputSignalHash: "0x0000000000000000000000000000000000000000000000000000000000000602",
            source: "seller",
            sourceId: "0x0000000000000000000000000000000000000000000000000000000000000702",
            signalId: "0x0000000000000000000000000000000000000000000000000000000000000802",
            leafHash: "0x0000000000000000000000000000000000000000000000000000000000000902"
          }
        ],
        outputs: [
          {
            port: "completed",
            canonicalOutputSignal: "seller::fulfillment.delivery.cmp",
            canonicalOutputSignalHash: "0x0000000000000000000000000000000000000000000000000000000000000a02",
            source: "seller",
            sourceId: "0x0000000000000000000000000000000000000000000000000000000000000702",
            signalId: "0x0000000000000000000000000000000000000000000000000000000000000b02",
            leafHash: "0x0000000000000000000000000000000000000000000000000000000000000c02"
          }
        ],
        inputsRoot: "0x0000000000000000000000000000000000000000000000000000000000000d02",
        outputsRoot: "0x0000000000000000000000000000000000000000000000000000000000000e02",
        interfaceRoot: "0x0000000000000000000000000000000000000000000000000000000000000f02"
      }
    ]
  },
  dockRoutes: [],
  dockRoutesRoot: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  dockInterfaceRoot: "0x0000000000000000000000000000000000000000000000000000000000000502",
  planHash: dockTargetPlanIds.planHash
} as const;

export const dockTargetStoreProductSchema: StoreProductSchemaDTO = {
  ...crossBorderStoreProductSchema,
  zhixuId: DOCK_TARGET_ZHIXU_ID,
  title: "Dock target staged payment",
  planId: dockTargetPlanIds.planId,
  planHash: dockTargetPlanIds.planHash,
  artifactHash: dockTargetPlanIds.artifactHash,
  onchainHookPlanArtifact: dockTargetOnchainHookPlanArtifact,
  schemaHash:
    "0x8c2d6cda824a197ddea166e33c955cfa27a67bb693aad840daf14a24512be7ae"
};
