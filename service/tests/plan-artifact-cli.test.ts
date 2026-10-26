// plan_artifacts 写入前置校验：CLI 必须以链上 planId（planIdForPublisher）为键，
// 并拒绝与 publisher 推导不一致的显式 planId；本测试不连 Postgres。
import { describe, expect, it } from "vitest";
import {
  compileZhixuOnchainHookPlan,
  parseZhixuDefinition,
  planIdForPublisher,
  toSolidityRegisterPlanArgs
} from "@uvp-eth/compiler";
import {
  buildPlanArtifactRecord,
  PlanArtifactPlanIdMismatchError
} from "../src/cli/record-plan-artifact.js";
import type { Hex } from "../src/shared/types.js";

const zhixuYaml = `
apiVersion: uvp/v0
kind: Zhixu
metadata:
  name: plan-artifact-cli
  annotations:
    version: "1"
spec:
  platform:
    type: blockchain
    provider: eth
  nucleation:
    id: plan-artifact-cli
  stages:
    - name: gate
      source: slot-a
      receiveSignals:
        START: "slot-a::gate.seed"
      sendSignals: [{ name: "ready" }, { name: "seed" }]
      executor:
        supplierType: organization
        supplierID: selector-ops
`;

const publisher = "0x1111111111111111111111111111111111111111" as const;
const artifact = compileZhixuOnchainHookPlan(parseZhixuDefinition(zhixuYaml, "plan-artifact-cli.yaml"));
const registerArgs = toSolidityRegisterPlanArgs(artifact);
const planHash = registerArgs.planHash as Hex;
const onchainPlanId = planIdForPublisher(publisher, planHash) as Hex;

describe("record plan artifact identity", () => {
  it("keys the record by the on-chain plan id, not the compiler plan id", () => {
    const record = buildPlanArtifactRecord(JSON.parse(JSON.stringify(artifact)) as unknown, {
      chainId: 31337,
      publisher
    });

    expect(record.planId).toBe(onchainPlanId);
    expect(record.planHash).toBe(planHash);
    expect(artifact.planId).not.toBe(onchainPlanId);
  });

  it("rejects an explicit plan id that disagrees with the publisher-derived on-chain id", () => {
    const wrongPlanId = `0x${"22".repeat(32)}` as Hex;

    expect(() => buildPlanArtifactRecord(artifact, {
      chainId: 31337,
      publisher,
      planId: wrongPlanId
    })).toThrow(PlanArtifactPlanIdMismatchError);
  });
});
