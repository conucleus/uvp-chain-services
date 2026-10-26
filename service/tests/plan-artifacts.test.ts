// plan_artifacts 投影 seam 的解析面：编译产物落库后按 (chainId, planId, planHash)
// 解析出索引富集词表与语义 oracle plan，缺失/错键必须 fail-closed。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileZhixuOnchainHookPlan,
  parseZhixuDefinition,
  planIdForPublisher,
  toSolidityRegisterPlanArgs
} from "@uvp-eth/compiler";
import {
  createPlanArtifactResolvers,
  PlanArtifactIdentityError,
  PlanArtifactMissingError
} from "../src/projection/plan-artifacts.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { Hex } from "../src/shared/types.js";

const planArtifactZhixuYaml = `
apiVersion: uvp/v0
kind: Zhixu
metadata:
  name: plan-artifact-resolver
  annotations:
    version: "1"
spec:
  platform:
    type: blockchain
    provider: eth
  nucleation:
    id: plan-artifact
  stages:
    - name: gate
      source: slot-a
      receiveSignals:
        START: "slot-a::gate.seed"
      sendSignals: [{ name: "ready" }, { name: "seed" }]
      executor:
        supplierType: organization
        supplierID: selector-ops
    - name: intake
      source: slot-a
      receiveSignals:
        START: "slot-a::gate.ready"
      sendSignals: [{ name: "cmp" }]
      executor:
        supplierType: organization
        supplierID: intake-ops
`;

const publisher = "0x1111111111111111111111111111111111111111" as Hex;
const chainId = 31337;
const artifact = compileZhixuOnchainHookPlan(parseZhixuDefinition(planArtifactZhixuYaml, "plan-artifact.yaml"));
const registerArgs = toSolidityRegisterPlanArgs(artifact);
const planHash = registerArgs.planHash as Hex;
const planId = planIdForPublisher(publisher, planHash) as Hex;

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true },
    chainId
  });
  await stores.planArtifactStore.put({ chainId, planId, planHash, artifact });
});

afterAll(async () => {
  await stores.close();
});

describe("plan artifact projection seam", () => {
  it("resolves the plan vocabulary and the semantic oracle plan from the recorded artifact", async () => {
    const resolvers = createPlanArtifactResolvers({ store: stores.planArtifactStore, chainId });

    const tables = await resolvers.resolvePlanCapabilityTables(planId, planHash);
    expect(tables.planId).toBe(planId);
    expect(tables.planHash).toBe(planHash);
    expect(tables.selectorBindings).toHaveLength(0);
    expect(tables.signalCapabilities).toHaveLength(3);
    expect(tables.signalCapabilities.every((row) => row.targetOrderRelation === 0)).toBe(true);

    const oraclePlan = await resolvers.resolveSemanticOraclePlan(planId, planHash);
    expect(oraclePlan.zhixuId).toBe(artifact.zhixuId);
    expect(oraclePlan.compiledHooks.map((hook) => hook.hookId)).toEqual(
      artifact.compiledHooks.map((hook) => hook.hookId)
    );
  });

  it("fails closed when the plan artifact is missing and refuses to record a foreign plan hash", async () => {
    const resolvers = createPlanArtifactResolvers({ store: stores.planArtifactStore, chainId });
    const unknownPlanHash = `0x${"ee".repeat(32)}` as Hex;

    await expect(resolvers.resolvePlanCapabilityTables(planId, unknownPlanHash))
      .rejects.toBeInstanceOf(PlanArtifactMissingError);
    await expect(resolvers.resolveSemanticOraclePlan(planId, unknownPlanHash))
      .rejects.toBeInstanceOf(PlanArtifactMissingError);
    await expect(stores.planArtifactStore.put({
      chainId,
      planId,
      planHash: unknownPlanHash,
      artifact
    })).rejects.toBeInstanceOf(PlanArtifactIdentityError);
  });
});
