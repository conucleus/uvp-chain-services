import { describe, expect, it } from "vitest";
import {
  decodeBytes32Text,
  displayBytes32,
  shortBytes32
} from "../src/shared/display.js";
import type { Hex } from "../src/shared/types.js";

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

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}

function bytes32FromBytes(...bytes: readonly number[]): Hex {
  return `0x${Buffer.from(bytes).toString("hex").padEnd(64, "0")}` as Hex;
}
