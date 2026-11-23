// Bug prevented: the stage file map served by chain read diverging from the
// on-chain file facts when a write is dropped, reordered, or replayed with a
// malformed payload. Invariant: the map is rebuilt in log order only from
// StageFileWritten, one entry per key, and a malformed payload fails closed
// with a named ProjectionError.
import { describe, expect, it } from "vitest";
import { ProjectionError, type Hex } from "@uvp-eth/service-runtime";
import type { ChainEvent } from "../src/indexer/events.js";
import { rebuildOrderProjections } from "../src/indexer/replay.js";
import { stateMachineScopedKey } from "../src/indexer/projections/index.js";

const CHAIN_ID = 31337;
const STATE_MACHINE = "0x1111111111111111111111111111111111111111";
const FILE_MODULE = "0x2222222222222222222222222222222222222222";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PLAN_ID = bytes32("01");
const ORDER_ID = bytes32("02");
const TARGET_STAGE_ID = bytes32("03");
const SUBMITTER = "0x3333333333333333333333333333333333333333";

describe("stage file replay", () => {
  it("replays StageFileWritten into the ordered per-stage file map", () => {
    const snapshot = rebuildOrderProjections([
      moduleSetEvent(),
      fileEvent(2n, 0, "uvp://stage-file/a", "0xaa"),
      fileEvent(3n, 0, "uvp://stage-file/b", "0xbb"),
      fileEvent(4n, 0, "uvp://stage-file/a", "0xcc")
    ]);
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(
      CHAIN_ID,
      STATE_MACHINE,
      PLAN_ID,
      ORDER_ID
    )];
    const stageFile = order?.stageFiles[TARGET_STAGE_ID];

    expect(stageFile).toMatchObject({
      planId: PLAN_ID,
      orderId: ORDER_ID,
      targetStageId: TARGET_STAGE_ID
    });
    expect(stageFile?.files["uvp://stage-file/a"]).toMatchObject({
      key: "uvp://stage-file/a",
      payload: "0xcc",
      updatedAt: expect.objectContaining({ blockNumber: 4n }),
      proof: expect.objectContaining({ eventName: "StageFileWritten" })
    });
    expect(stageFile?.files["uvp://stage-file/b"]).toMatchObject({
      key: "uvp://stage-file/b",
      payload: "0xbb"
    });
    expect(Object.keys(stageFile?.files ?? {}).sort()).toEqual([
      "uvp://stage-file/a",
      "uvp://stage-file/b"
    ]);
  });

  it("keeps hostile keys as own map entries", () => {
    const snapshot = rebuildOrderProjections([
      moduleSetEvent(),
      fileEvent(2n, 0, "__proto__", "0xaa")
    ]);
    const order = snapshot.stateMachineOrders[stateMachineScopedKey(
      CHAIN_ID,
      STATE_MACHINE,
      PLAN_ID,
      ORDER_ID
    )];
    const files = order?.stageFiles[TARGET_STAGE_ID]?.files ?? {};
    expect(Object.prototype.hasOwnProperty.call(files, "__proto__")).toBe(true);
    expect(files["__proto__"]?.payload).toBe("0xaa");
    expect(({} as { payload?: string }).payload).toBeUndefined();
  });

  it("fails closed on a non-hex payload", () => {
    let caught: unknown;
    try {
      rebuildOrderProjections([
        moduleSetEvent(),
        fileEvent(2n, 0, "uvp://stage-file/a", "not-hex")
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectionError);
    expect((caught as Error).message).toContain("is not a hex byte string");
  });
});

function moduleSetEvent(): ChainEvent {
  return chainEvent(1n, 0, "StateMachineModuleSet", {
    moduleId: bytes32("91"),
    previousModule: ZERO_ADDRESS,
    newModule: FILE_MODULE
  }, STATE_MACHINE);
}

function fileEvent(blockNumber: bigint, logIndex: number, key: string, payload: string): ChainEvent {
  return chainEvent(blockNumber, logIndex, "StageFileWritten", {
    planId: PLAN_ID,
    orderId: ORDER_ID,
    targetStageId: TARGET_STAGE_ID,
    key,
    payload,
    submitter: SUBMITTER
  });
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  contractAddress = FILE_MODULE
): ChainEvent {
  return {
    chainId: CHAIN_ID,
    contractAddress: contractAddress as ChainEvent["contractAddress"],
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex,
    eventName,
    args
  };
}

function bytes32(value: string): Hex {
  return `0x${value.repeat(32)}`;
}
