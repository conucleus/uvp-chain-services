import type { StoreProductSchemaDTO } from "@uvp-eth/product-dto";
import {
  CROSS_BORDER_ZHIXU_ID,
  crossBorderPlanIds,
  demoZhixuDetail
} from "@uvp-eth/product-dto/fixtures";
import type { ProductSchemaResolver } from "../src/product/service.js";

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
      return planId === crossBorderPlanIds.planId
        ? crossBorderStoreProductSchema
        : undefined;
    }
  };
}
