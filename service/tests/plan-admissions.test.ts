// Bug prevented: the plan admissions/trigger reads losing the artifact's frozen
// stage/signal identity mapping, dropping or reordering the trigger enumeration,
// leaking the whole plan artifact, answering a missing artifact as an empty 200,
// or accepting a non-bytes32 plan key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileZhixuOnchainHookPlan,
  parseZhixuDefinition,
  planIdForPublisher,
  toSolidityRegisterPlanArgs
} from "@uvp-eth/compiler";
import {
  parsePlanAdmissionsResponse,
  parsePlanTriggersResponse
} from "@uvp-eth/chain-read-contract";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import type {
  PlanArtifactRecord,
  PlanArtifactStore
} from "../src/projection/plan-artifacts.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import type { ProjectionStore } from "../src/storage/projection-store.js";
import { createPostgresTestDatabase } from "./postgres.js";
import type { Hex } from "@uvp-eth/service-runtime";

const planAdmissionsZhixuYaml = `
apiVersion: uvp/v0
kind: Zhixu
metadata:
  name: plan-admissions
  annotations:
    version: "1"
spec:
  platform:
    type: blockchain
    provider: eth
  nucleation:
    id: plan-admissions
  stages:
    - name: gate
      source: slot-a
      receiveSignals:
        START: "slot-a::gate.seed"
      sendSignals: [{ name: "seed" }, { name: "ready" }]
      executor:
        supplierType: organization
        supplierID: sales-ops
    - name: intake
      source: slot-a
      receiveSignals:
        START: "slot-a::gate.ready"
      sendSignals:
        - name: cmp
          validWhen: ["slot-a::gate.seed & ~(intake.cmp_err +14d)"]
        - name: cmp_err
      executor:
        supplierType: organization
        supplierID: intake-ops
`;

const chainId = 31337;
const publisher = "0x1111111111111111111111111111111111111111" as Hex;
const artifact = compileZhixuOnchainHookPlan(
  parseZhixuDefinition(planAdmissionsZhixuYaml, "plan-admissions.yaml")
);
const planHash = toSolidityRegisterPlanArgs(artifact).planHash as Hex;
const planId = planIdForPublisher(publisher, planHash) as Hex;

const planTriggersZhixuYaml = `
apiVersion: uvp/v0
kind: Zhixu
metadata:
  name: plan-triggers
  annotations:
    version: "1"
spec:
  platform:
    type: blockchain
    provider: eth
  nucleation:
    id: plan-triggers
  stages:
    - name: intake
      source: brand
      trigger: [orderPlaced]
      sendSignals: [{ name: "orderPlaced" }]
      executor:
        supplierType: organization
        supplierID: intake-ops
    - name: cutting
      source: atelier
      trigger: [cutDone]
      sendSignals: [{ name: "cutDone" }]
      executor:
        supplierType: organization
        supplierID: cutting-ops
`;

const triggersArtifact = compileZhixuOnchainHookPlan(
  parseZhixuDefinition(planTriggersZhixuYaml, "plan-triggers.yaml")
);
const triggersPlanHash = toSolidityRegisterPlanArgs(triggersArtifact).planHash as Hex;
const triggersPlanId = planIdForPublisher(publisher, triggersPlanHash) as Hex;
const triggersRecord: PlanArtifactRecord = {
  chainId,
  planId: triggersPlanId,
  planHash: triggersPlanHash,
  artifact: triggersArtifact
};

function readOnlyPlanArtifactStore(record: PlanArtifactRecord): PlanArtifactStore {
  return {
    async put() {
      throw new Error("plan trigger read test store is read-only");
    },
    async get(query) {
      return query.chainId === record.chainId &&
        query.planId === record.planId &&
        query.planHash === record.planHash
        ? record
        : undefined;
    }
  };
}

function triggersRouter(): ApiRouter {
  return createApiRouter({} as unknown as ProjectionStore, {
    runtimeEnvironment: "local",
    planArtifacts: {
      chainId,
      store: readOnlyPlanArtifactStore(triggersRecord)
    }
  });
}

let stores: ChainServicesStores;
let router: ApiRouter;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true },
    chainId
  });
  await stores.planArtifactStore.put({ chainId, planId, planHash, artifact });
  router = createApiRouter(stores.projectionStore, {
    runtimeEnvironment: "local",
    planArtifacts: { chainId, store: stores.planArtifactStore }
  });
});

afterAll(async () => {
  await stores.close();
});

describe("plan admissions read", () => {
  it("serves the recorded artifact's frozen admissions and nothing else", async () => {
    const response = await router.handle({
      method: "GET",
      pathname: `/chain/plans/${planId}/${planHash}/admissions`
    });

    expect(response.status).toBe(200);
    expect(artifact.admissions.length).toBeGreaterThan(0);
    expect(response.body).toEqual({
      chainId,
      planId,
      planHash,
      admissions: artifact.admissions.map((admission) => ({
        admissionId: admission.admissionId,
        stageId: admission.stageId,
        stageIdentifier: admission.stageIdentifier,
        signalName: admission.signalName,
        signalId: admission.signalId,
        sourceId: admission.sourceId
      }))
    });
    const parsed = parsePlanAdmissionsResponse(response.body);
    expect(parsed.admissions.map((admission) => admission.signalId)).toEqual(
      artifact.admissions.map((admission) => admission.signalId)
    );
  });

  it("404s with plan_artifact_missing when no artifact is recorded for the plan hash", async () => {
    const unknownPlanHash = `0x${"ee".repeat(32)}`;

    await expect(
      router.handle({
        method: "GET",
        pathname: `/chain/plans/${planId}/${unknownPlanHash}/admissions`
      })
    ).resolves.toEqual({ status: 404, body: { error: "plan_artifact_missing" } });
  });

  it("400s with a named error when planId or planHash is not bytes32", async () => {
    await expect(
      router.handle({
        method: "GET",
        pathname: `/chain/plans/0x1234/${planHash}/admissions`
      })
    ).resolves.toMatchObject({ status: 400, body: { error: "invalid_plan_id" } });

    await expect(
      router.handle({
        method: "GET",
        pathname: `/chain/plans/${planId}/not-a-bytes32/admissions`
      })
    ).resolves.toMatchObject({ status: 400, body: { error: "invalid_plan_hash" } });
  });
});

describe("plan triggers read", () => {
  it("serves the recorded artifact's trigger enumeration in canonical order and nothing else", async () => {
    expect(triggersArtifact.triggers).toHaveLength(2);

    const response = await triggersRouter().handle({
      method: "GET",
      pathname: `/chain/plans/${triggersPlanId}/${triggersPlanHash}/triggers`
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      chainId,
      planId: triggersPlanId,
      planHash: triggersPlanHash,
      triggers: triggersArtifact.triggers.map((trigger) => ({
        hookId: trigger.hookId,
        stageIdentifier: trigger.stageIdentifier,
        stageId: trigger.stageId,
        hookName: trigger.hookName,
        orderTriggerKind: trigger.orderTriggerKind,
        source: trigger.source,
        signalName: trigger.signalName,
        sourceId: trigger.sourceId,
        signalId: trigger.signalId
      }))
    });
    const parsed = parsePlanTriggersResponse(response.body);
    expect(parsed.triggers.map((trigger) => trigger.hookId)).toEqual(
      triggersArtifact.triggers.map((trigger) => trigger.hookId)
    );
    expect(parsed.triggers.map((trigger) => trigger.signalName)).toEqual(
      triggersArtifact.triggers.map((trigger) => trigger.signalName)
    );
  });

  it("404s with plan_artifact_missing when no artifact is recorded for the plan hash", async () => {
    const unknownPlanHash = `0x${"ee".repeat(32)}`;

    await expect(
      triggersRouter().handle({
        method: "GET",
        pathname: `/chain/plans/${triggersPlanId}/${unknownPlanHash}/triggers`
      })
    ).resolves.toEqual({ status: 404, body: { error: "plan_artifact_missing" } });
  });

  it("400s with a named error when planId or planHash is not bytes32", async () => {
    await expect(
      triggersRouter().handle({
        method: "GET",
        pathname: `/chain/plans/0x1234/${triggersPlanHash}/triggers`
      })
    ).resolves.toMatchObject({ status: 400, body: { error: "invalid_plan_id" } });

    await expect(
      triggersRouter().handle({
        method: "GET",
        pathname: `/chain/plans/${triggersPlanId}/not-a-bytes32/triggers`
      })
    ).resolves.toMatchObject({ status: 400, body: { error: "invalid_plan_hash" } });
  });
});
