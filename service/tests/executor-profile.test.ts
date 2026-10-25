// Generic executor profile regression: profile validation, profile-driven
// calldata/signers/amountRule, fact gate and runtime mapping. The concrete
// StageEscrow profile fixture lives only in this test, never in src.

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { MemoryOrderV3Store } from "../src/order/v3/index.js";
import { OrderConfigService } from "../src/order/v3/config-service.js";
import {
  addExecutorSignature,
  createExecutorInstruction,
  executorInstructionTypedData,
  MemoryExecutorInstructionStore,
} from "../src/executor/instruction.js";
import { createExecutor } from "../src/executor/executor.js";
import {
  buildExecutorCalldata,
  parseExecutorProfile,
  resolveRuntimeActionKey,
  type ExecutorProfileV1,
} from "../src/executor/profile.js";

const profileShape = {
  schema: "uvp.executor-profile/v1",
  profileId: "used-car/stage-escrow-v3",
  target: { kind: "contract", addressEnv: "STAGE_ESCROW_V3_ADDRESS", chainIdEnv: "CHAIN_ID" },
  abi: [
    { type: "function", name: "markStarted", stateMutability: "nonpayable", inputs: [{ name: "trancheId", type: "bytes32" }], outputs: [] },
    { type: "function", name: "verdict", stateMutability: "nonpayable", inputs: [{ name: "trancheId", type: "bytes32" }, { name: "approved", type: "bool" }, { name: "signature", type: "bytes" }], outputs: [] },
    { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ name: "trancheId", type: "bytes32" }, { name: "instructionRef", type: "bytes32" }], outputs: [] },
  ],
  actions: [
    { key: "start", method: "markStarted", args: ["trancheId"], signers: ["payee"], amountRule: "none" },
    { key: "verdict", method: "verdict", args: ["trancheId", "approved", "signature"], signers: ["verifier"], amountRule: "verdict" },
    { key: "execute", method: "execute", args: ["trancheId", "instructionRef"], signers: [], amountRule: "full_pay", factGate: "uvp_fact_source" },
  ],
  runtime: [{ match: "approved", actionKey: "execute" }],
};

const targetAddress = "0x2222222222222222222222222222222222222222" as const;
const orderId = `0x${"11".repeat(32)}` as const;
const stageId = `0x${"22".repeat(32)}` as const;
const trancheId = `0x${"33".repeat(32)}` as const;
const instructionRef = `0x${"44".repeat(32)}` as const;
const sourceFactId = `0x${"55".repeat(32)}` as const;

function profile(): ExecutorProfileV1 {
  return parseExecutorProfile(profileShape);
}

function instruction(overrides: Record<string, unknown> = {}) {
  const signer = privateKeyToAccount(`0x${"07".repeat(32)}`);
  return {
    profile: profile(),
    targetAddress,
    chainId: 31337,
    orderId,
    stageKey: "inspection",
    stageId,
    actionKey: "verdict",
    args: { trancheId, approved: true, signature: `0x${"aa".repeat(65)}` },
    signers: { verifier: signer.address },
    payerAmount: "0",
    payeeAmount: "1000",
    sourceFactId,
    instructionRef,
    nonce: "1",
    deadline: "9999999999",
    ...overrides,
  } as never;
}

describe("executor profile", () => {
  it("validates schema/actions/ABI and rejects drift", () => {
    const parsed = profile();
    expect(parsed.actions.map((action) => action.key)).toEqual(["start", "verdict", "execute"]);
    expect(resolveRuntimeActionKey(parsed, "approved")).toBe("execute");
    expect(() => parseExecutorProfile({ ...profileShape, schema: "other" })).toThrow(/schema/);
    expect(() =>
      parseExecutorProfile({ ...profileShape, actions: [profileShape.actions[0]!, profileShape.actions[0]!] }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseExecutorProfile({
        ...profileShape,
        actions: [{ ...profileShape.actions[0]!, amountRule: "unknown" }],
      }),
    ).toThrow(/amountRule/);
    expect(() =>
      parseExecutorProfile({
        ...profileShape,
        actions: [{ ...profileShape.actions[0]!, method: "missingMethod" }],
      }),
    ).toThrow(/not a function/);
  });

  it("builds profile-driven calldata from typed args", () => {
    const call = buildExecutorCalldata({
      profile: profile(),
      actionKey: "execute",
      args: { trancheId, instructionRef },
      targetAddress,
    });
    expect(call.to).toBe(targetAddress);
    expect(call.data.startsWith("0x")).toBe(true);
    expect(() =>
      buildExecutorCalldata({ profile: profile(), actionKey: "execute", args: { trancheId }, targetAddress }),
    ).toThrow(/required/);
  });

  it("derives signer roles and amountRule from the profile, not business names", async () => {
    const signer = privateKeyToAccount(`0x${"07".repeat(32)}`);
    const record = createExecutorInstruction(instruction());
    expect(record.requiredSigners).toEqual(["verifier"]);
    expect(record.amountRule).toBe("verdict");
    expect(record.status).toBe("unsigned");

    const signature = await signer.signTypedData(executorInstructionTypedData(record) as never);
    const signed = await addExecutorSignature(record, { role: "verifier", signature });
    expect(signed.status).toBe("ready");

    await expect(addExecutorSignature(record, { role: "payer", signature })).rejects.toThrow(/not required/);
  });

  it("runs generic calldata after a generic UVP fact gate", async () => {
    const store = new MemoryExecutorInstructionStore();
    const record = createExecutorInstruction(
      instruction({
        actionKey: "execute",
        args: { trancheId, instructionRef },
        signers: {},
        amountRule: "full_pay",
      }),
    );
    await store.save(record);
    const sent: { to: string; data: string }[] = [];
    const executor = createExecutor({
      profiles: [profile()],
      store,
      factReader: {
        async expectedInstructionRef() {
          return instructionRef;
        },
      },
      adapter: {
        async send(input) {
          sent.push({ to: input.to, data: input.data });
          return { txHash: `0x${"66".repeat(32)}`, status: "success" };
        },
      },
    });
    const result = await executor.run(record.instructionId);
    expect(result.status).toBe("submitted");
    expect(sent).toHaveLength(1);
    expect((await store.get(record.instructionId))?.txHash).toBe(`0x${"66".repeat(32)}`);

    const blocked = createExecutorInstruction(
      instruction({
        actionKey: "execute",
        args: { trancheId, instructionRef },
        signers: {},
        amountRule: "full_pay",
      }),
    );
    await store.save(blocked);
    const mismatch = createExecutor({
      profiles: [profile()],
      store,
      factReader: {
        async expectedInstructionRef() {
          return `0x${"77".repeat(32)}`;
        },
      },
      adapter: { async send() { throw new Error("must not send"); } },
    });
    expect((await mismatch.run(blocked.instructionId)).errorCode).toBe("executor_fact_gate_rejected");
  });

  it("stores a published executor profile on the config version", async () => {
    const store = new MemoryOrderV3Store();
    const service = new OrderConfigService({
      store,
      publisherWallets: [privateKeyToAccount(`0x${"08".repeat(32)}`).address],
    });
    const publisher = privateKeyToAccount(`0x${"08".repeat(32)}`);
    const published = await service.publish(publisher.address, {
      config: minimalConfig(),
      planId: `0x${"01".repeat(32)}`,
      planHash: `0x${"02".repeat(32)}`,
      birth: {
        triggerHookId: `0x${"03".repeat(32)}`,
        triggerStageId: `0x${"04".repeat(32)}`,
        sourceId: `0x${"05".repeat(32)}`,
        signalId: `0x${"06".repeat(32)}`,
        birthAuthorizer: publisher.address,
        attribution: {
          sourceId: `0x${"05".repeat(32)}`,
          signalId: `0x${"06".repeat(32)}`,
          stageId: `0x${"07".repeat(32)}`,
          capabilityProof: [],
        },
      },
      executorProfile: profileShape,
    });
    expect(published.configId).toBe("executor/test");
    expect((await service.getExecutorProfile("executor/test", "1.0.0")).profileId).toBe("used-car/stage-escrow-v3");
  });
});

function minimalConfig() {
  return {
    configId: "executor/test",
    version: "1.0.0",
    status: "published",
    slots: [{ key: "buyer", kind: "participant" }],
    stages: [{ key: "alpha", funded: false, senders: ["buyer"], acceptance: { mode: "none" } }],
  };
}
