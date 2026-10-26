import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { createPostgresTestDatabase } from "./postgres.js";
import {
  decodeBytes32Text,
  displayBytes32,
  shortBytes32
} from "../src/shared/display.js";
import type { Address, Hex } from "../src/shared/types.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true }
  });
});

afterAll(async () => {
  await stores.close();
});

function requiredRouterStores() {
  return {
    storeWalletSessionStore: stores.storeWalletSessionStore,
    identityDescriptorSnapshots: stores.identityDescriptorSnapshots,
    productBffStore: stores.productBffStore,
    orderStore: stores.orderStore,
    orderRequirementsStore: stores.orderRequirementsStore,
    evidenceMetadataStore: stores.evidenceMetadataStore,
    submissionStore: stores.submissionStore,
    governanceStore: stores.governanceStore,
    stageExecutorPatchStore: stores.stageExecutorPatchStore,
    stageResourcePatchStore: stores.stageResourcePatchStore,
  };
}

const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const participantWallet = "0x4444444444444444444444444444444444444444" as Address;
const planId = "0x0000000000000000000000000000000000000000000000000000000000000aaa" as Hex;
const planHash = "0x0000000000000000000000000000000000000000000000000000000000000bbb" as Hex;
const orderId = "0x0000000000000000000000000000000000000000000000000000000000000202" as Hex;
const hookId = "0x0000000000000000000000000000000000000000000000000000000000000303" as Hex;
const metadataHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Hex;
const zeroBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

describe("bytes32 展示解码单源（shared/display）", () => {
  it("中文标识按 Unicode 字符集显示文本", () => {
    expect(decodeBytes32Text(bytes32Text("示例阶段"))).toBe("示例阶段");
    expect(displayBytes32(bytes32Text("示例阶段"), "阶段")).toBe("示例阶段");
    expect(displayBytes32(bytes32Text("示例阶段"))).toBe("示例阶段");
  });

  it("可打印 ASCII 标识显示文本", () => {
    expect(decodeBytes32Text(bytes32Text("stage-a"))).toBe("stage-a");
    expect(displayBytes32(bytes32Text("example-review"), "阶段")).toBe("example-review");
    expect(displayBytes32(bytes32Text("stage-a"))).toBe("stage-a");
  });

  it("ASCII 符号类（$=^|~）按并集语义显示文本", () => {
    expect(displayBytes32(bytes32Text("v2=beta$ok"), "阶段")).toBe("v2=beta$ok");
    expect(displayBytes32(bytes32Text("v2=beta$ok"))).toBe("v2=beta$ok");
  });

  it("混合控制字符不可展示：带标签回落 `${fallback} ${短哈希}`，无标签回落裸短哈希", () => {
    const mixedControl = bytes32FromBytes(0x61, 0x62, 0x01, 0x63, 0x64);
    expect(decodeBytes32Text(mixedControl)).toBeUndefined();
    expect(displayBytes32(mixedControl, "阶段")).toBe(`阶段 ${shortBytes32(mixedControl)}`);
    expect(displayBytes32(mixedControl)).toBe(shortBytes32(mixedControl));
    expect(shortBytes32(mixedControl)).toMatch(/^0x[0-9a-f]{6}\.\.\.[0-9a-f]{8}$/);
  });

  it("全零 bytes32 不可展示，回落短哈希", () => {
    expect(decodeBytes32Text(zeroBytes32)).toBeUndefined();
    expect(displayBytes32(zeroBytes32, "当前阶段")).toBe(`当前阶段 ${shortBytes32(zeroBytes32)}`);
    expect(displayBytes32(zeroBytes32)).toBe(shortBytes32(zeroBytes32));
  });

  it("非 bytes32 输入原样透传，空值回落 fallback", () => {
    expect(displayBytes32("stage-a", "阶段")).toBe("stage-a");
    expect(displayBytes32("已解码的普通标识", "阶段")).toBe("已解码的普通标识");
    expect(displayBytes32(undefined, "阶段")).toBe("阶段");
    expect(displayBytes32("", "阶段")).toBe("阶段");
    expect(displayBytes32(undefined)).toBe("");
  });

  it("按首个 NUL 截断并去首尾空白（Solidity 字符串填充惯例）", () => {
    expect(decodeBytes32Text(bytes32FromBytes(0x61, 0x62, 0x00, 0x63, 0x64))).toBe("ab");
    expect(decodeBytes32Text(bytes32Text("ab "))).toBe("ab");
    expect(decodeBytes32Text(bytes32FromBytes(0xff, 0xfe, 0xfd, 0xfc))).toBeUndefined();
  });
});

describe("bytes32 展示跨视图一致（活动流 vs 阶段视图）", () => {
  it("同一中文标识在订单阶段视图与参与方活动流显示同一文本", async () => {
    const zhStageId = bytes32Text("示例阶段");
    const zhHookName = bytes32Text("示例复核");
    const store = stores.projectionStore;
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(1n, "PlanRegistered", { planId, planHash, hookCount: 1n }),
        chainEvent(2n, "OrderRegistered", { orderId, planId }),
        chainEvent(3n, "SignalSubmitterAuthorized", {
          orderId,
          sourceId: hookId,
          signalId: hookId,
          submitter: participantWallet,
          role: bytes32Text("executor"),
          metadataHash
        }),
        chainEvent(4n, "HookReady", {
          orderId,
          hookId,
          stageId: zhStageId,
          hookName: zhHookName
        })
      ]
    });

    const router = createApiRouter(store, {
      ...requiredRouterStores(),
      submissionChainId: 84532,
      submissionVerifyingContract: contractAddress,
      productRuntimeEnvironment: "local" as const
    });
    const orderResponse = await router.handle({
      method: "GET",
      pathname: `/product/orders/${orderId}`,
      headers: { "x-uvp-wallet-address": participantWallet }
    });
    expect(orderResponse.status).toBe(200);
    const order = (orderResponse.body as {
      readonly order: {
        readonly currentStageId: string;
        readonly currentStageName: string;
        readonly stages: ReadonlyArray<{ readonly stageId: string; readonly name: string }>;
        readonly tasks: ReadonlyArray<{ readonly hookName: string; readonly stageIdentifier: string }>;
      };
    }).order;
    expect(order.currentStageId).toBe("示例阶段");
    expect(order.currentStageName).toBe("示例阶段");
    expect(order.stages).toContainEqual(
      expect.objectContaining({ stageId: "示例阶段", name: "示例阶段" })
    );
    expect(order.tasks[0]).toMatchObject({
      hookName: "示例复核",
      stageIdentifier: "示例阶段"
    });

  });
});

function chainEvent(
  blockNumber: bigint,
  eventName: string,
  args: Record<string, unknown>
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex,
    logIndex: 0,
    eventName,
    args
  };
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}

function bytes32FromBytes(...bytes: readonly number[]): Hex {
  return `0x${Buffer.from(bytes).toString("hex").padEnd(64, "0")}` as Hex;
}
