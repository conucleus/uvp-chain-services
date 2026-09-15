import { describe, expect, it } from "vitest";
import { createApiRouter } from "../src/api/routes.js";
import type { ChainEvent } from "../src/indexer/events.js";
import { createNotificationService } from "../src/notifications/service.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import {
  decodeBytes32Text,
  displayBytes32,
  shortBytes32
} from "../src/shared/display.js";
import type { Address, Hex } from "../src/shared/types.js";

// bytes32 展示解码单源（shared/display.ts，审计 §1.1 "bytes32 展示解码
// ×2" / §3 P1-4）的钉子：并集语义 = 可打印 ASCII 或 Unicode
// Letter/Number/Punctuation/Separator → 显示文本，否则短哈希回落。
// 旧阶段视图仅收可打印 ASCII（中文回落短哈希）、旧活动流仅收 Unicode
// 字符类（"$=|~" 类 ASCII 符号回落）——本文件钉住统一后同一标识在
// 两个视图同一显示。
const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const participantWallet = "0x4444444444444444444444444444444444444444" as Address;
const planId = "0x0000000000000000000000000000000000000000000000000000000000000aaa" as Hex;
const planHash = "0x0000000000000000000000000000000000000000000000000000000000000bbb" as Hex;
const orderId = "0x0000000000000000000000000000000000000000000000000000000000000202" as Hex;
const hookId = "0x0000000000000000000000000000000000000000000000000000000000000303" as Hex;
const metadataHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Hex;
const zeroBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

describe("bytes32 展示解码单源（shared/display）", () => {
  it("中文标识按 Unicode 字符集显示文本——旧阶段视图回落短哈希的分歧已修", () => {
    expect(decodeBytes32Text(bytes32Text("预交付"))).toBe("预交付");
    expect(displayBytes32(bytes32Text("预交付"), "阶段")).toBe("预交付");
    expect(displayBytes32(bytes32Text("预交付"))).toBe("预交付");
  });

  it("可打印 ASCII 标识显示文本（阶段视图既有行为不回归）", () => {
    expect(decodeBytes32Text(bytes32Text("export.customs"))).toBe("export.customs");
    expect(displayBytes32(bytes32Text("customs-review"), "阶段")).toBe("customs-review");
    expect(displayBytes32(bytes32Text("export.customs"))).toBe("export.customs");
  });

  it("ASCII 符号类（$=^|~）按并集语义显示——旧活动流拒收侧不再回落", () => {
    // "$ + = < > ^ ` | ~" 是 ASCII 可打印符号，但不在 Unicode
    // Letter/Number/Punctuation/Separator 内：两份旧实现一边接受一边
    // 拒绝，并集后必须统一显示文本。
    expect(displayBytes32(bytes32Text("v2=beta$ok"), "阶段")).toBe("v2=beta$ok");
    expect(displayBytes32(bytes32Text("v2=beta$ok"))).toBe("v2=beta$ok");
  });

  it("混合控制字符不可展示：带标签回落 `${fallback} ${短哈希}`，无标签回落裸短哈希", () => {
    // "ab\x01cd"：\x01 两边字符集都不收 → 判不可展示。
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

  it("非 bytes32 输入原样透传，空值回落 fallback（通知流既有行为不回归）", () => {
    expect(displayBytes32("export.customs", "阶段")).toBe("export.customs");
    expect(displayBytes32("已解码的普通标识", "阶段")).toBe("已解码的普通标识");
    expect(displayBytes32(undefined, "阶段")).toBe("阶段");
    expect(displayBytes32("", "阶段")).toBe("阶段");
    expect(displayBytes32(undefined)).toBe("");
  });

  it("按首个 NUL 截断并去首尾空白（Solidity 字符串填充惯例）", () => {
    expect(decodeBytes32Text(bytes32FromBytes(0x61, 0x62, 0x00, 0x63, 0x64))).toBe("ab");
    expect(decodeBytes32Text(bytes32Text("ab "))).toBe("ab");
    // 乱码字节序列（非法 utf8 / 控制字节）整体判不可展示。
    expect(decodeBytes32Text(bytes32FromBytes(0xff, 0xfe, 0xfd, 0xfc))).toBeUndefined();
  });
});

describe("bytes32 展示跨视图一致（活动流 vs 阶段视图）", () => {
  it("同一中文标识在订单阶段视图与参与方活动流显示同一文本", async () => {
    const zhStageId = bytes32Text("预交付");
    const zhHookName = bytes32Text("报关复核");
    const store = new MemoryProjectionStore();
    await store.resetFromEvents({
      deploymentBlock: 0n,
      events: [
        chainEvent(1n, "PlanRegistered", { planId, planHash, hookCount: 1n }),
        chainEvent(2n, "OrderRegistered", { orderId, planId }),
        // 授权提交方 = 参与钱包（sourceId/signalId 即 hookId 的链上事实
        // 绑定键）：HookReady 生成的任务指派给该钱包，两侧视图同可见。
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

    // 阶段视图（product 读面：订单详情的阶段/任务展示）。
    const router = createApiRouter(store, {
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
    expect(order.currentStageId).toBe("预交付");
    expect(order.currentStageName).toBe("预交付");
    expect(order.stages).toContainEqual(
      expect.objectContaining({ stageId: "预交付", name: "预交付" })
    );
    expect(order.tasks[0]).toMatchObject({
      hookName: "报关复核",
      stageIdentifier: "预交付"
    });

    // 活动流（notifications 参与方面：task_ready 通知的阶段展示）。
    const feed = await createNotificationService({ store })
      .listParticipantNotifications({ walletAddress: participantWallet });
    const taskNotification = feed.notifications.find(
      (notification) => notification.kind === "task_ready"
    );
    expect(taskNotification).toBeDefined();
    // 核心钉子：同一 bytes32 标识，两个视图同一显示。
    expect(taskNotification?.stageLabel).toBe(order.currentStageId);
    expect(taskNotification?.stageId).toBe(order.currentStageId);
    expect(taskNotification?.taskTitle).toBe("处理报关复核");
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
