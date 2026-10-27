// Bug prevented: the plan admissions read losing the artifact's frozen
// stage/signal identity mapping, leaking the whole plan artifact, answering a
// missing artifact as an empty 200, or accepting a non-bytes32 plan key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileZhixuOnchainHookPlan,
  parseZhixuDefinition,
  planIdForPublisher,
  toSolidityRegisterPlanArgs
} from "@uvp-eth/compiler";
import { parsePlanAdmissionsResponse } from "@uvp-eth/chain-read-contract";
import { createApiRouter, type ApiRouter } from "../src/api/routes.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
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
