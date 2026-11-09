// Bug prevented: the stage file map served by chain read diverging from the
// on-chain file facts when a patch loses an op, doubles an op, or a later patch
// does not continue the filesHash chain. Invariant: the map is rebuilt in log
// order only from StageFilePatchApplied/StageFileOpApplied, one patch window
// consumes exactly opCount op events, and a broken baseHash chain fails closed
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
const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;
const PLAN_ID = bytes32("01");
const ORDER_ID = bytes32("02");
const TARGET_STAGE_ID = bytes32("03");
const OTHER_STAGE_ID = bytes32("04");
const PATCH_HASH = bytes32("11");
const OTHER_PATCH_HASH = bytes32("12");
const KEY_A = bytes32("21");
const KEY_B = bytes32("22");
const KEY_C = bytes32("23");
const CONTENT_HASH_A = bytes32("31");
const CONTENT_HASH_B = bytes32("32");
const CONTENT_HASH_C = bytes32("33");
const CONTENT_HASH_D = bytes32("34");

describe("stage file patch replay", () => {
  it("replays StageFilePatchApplied/StageFileOpApplied into the ordered per-stage file map", () => {
    const events: readonly ChainEvent[] = [
      moduleSetEvent(),
      patchEvent(2n, 0, PATCH_HASH, ZERO_BYTES32, 5n),
      opEvent(2n, 1, 0, KEY_A, CONTENT_HASH_A, "ipfs://stage-file/a-1"),
      opEvent(2n, 2, 0, KEY_B, CONTENT_HASH_B, "ipfs://stage-file/b-1"),
      opEvent(2n, 3, 1, KEY_A, CONTENT_HASH_C, "ipfs://stage-file/a-2"),
      opEvent(2n, 4, 2, KEY_B, ZERO_BYTES32, ""),
      opEvent(2n, 5, 0, KEY_C, CONTENT_HASH_D, "ipfs://stage-file/c-1")
    ];

    const snapshot = rebuildOrderProjections(events);
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
    expect(stageFile?.files[KEY_A]).toMatchObject({
      key: KEY_A,
      contentHash: CONTENT_HASH_C,
      handle: "ipfs://stage-file/a-2",
      patchHash: PATCH_HASH,
      updatedAt: expect.objectContaining({ blockNumber: 2n }),
      proof: expect.objectContaining({ eventName: "StageFileOpApplied" })
    });
    expect(stageFile?.files[KEY_C]).toMatchObject({
      key: KEY_C,
      contentHash: CONTENT_HASH_D,
      handle: "ipfs://stage-file/c-1",
      patchHash: PATCH_HASH
    });
    expect(stageFile?.files[KEY_B]).toBeUndefined();
    expect(Object.keys(stageFile?.files ?? {}).sort()).toEqual([KEY_A, KEY_C].sort());
    expect(stageFile?.filesHash).not.toBe(ZERO_BYTES32);
    expect(order?.proof.filter((proof) => proof.eventName === "StageFilePatchApplied")).toHaveLength(1);
    expect(order?.timeline.map((event) => event.eventName)).toContain("StageFilePatchApplied");

    const otherStageSnapshot = rebuildOrderProjections([
      ...events,
      patchEvent(4n, 0, OTHER_PATCH_HASH, ZERO_BYTES32, 1n, OTHER_STAGE_ID),
      opEvent(4n, 1, 0, KEY_A, CONTENT_HASH_A, "ipfs://stage-file/a-other", OTHER_STAGE_ID)
    ]);
    expect(otherStageSnapshot.stateMachineOrders[stateMachineScopedKey(
      CHAIN_ID,
      STATE_MACHINE,
      PLAN_ID,
      ORDER_ID
    )]?.stageFiles[OTHER_STAGE_ID]?.filesHash).not.toBe(stageFile?.filesHash);
  });

  it("rejects a next patch whose baseHash does not match the replayed stage files hash", () => {
    const prefix: readonly ChainEvent[] = [
      moduleSetEvent(),
      patchEvent(2n, 0, PATCH_HASH, ZERO_BYTES32, 1n),
      opEvent(2n, 1, 0, KEY_A, CONTENT_HASH_A, "ipfs://stage-file/a-1")
    ];
    const replayed = rebuildOrderProjections(prefix);
    expect(
      replayed.stateMachineOrders[stateMachineScopedKey(
        CHAIN_ID,
        STATE_MACHINE,
        PLAN_ID,
        ORDER_ID
      )]?.stageFiles[TARGET_STAGE_ID]?.filesHash
    ).not.toBe(ZERO_BYTES32);

    const mismatchedBaseHash = bytes32("ff");
    let caught: unknown;
    try {
      rebuildOrderProjections([
        ...prefix,
        patchEvent(3n, 0, OTHER_PATCH_HASH, mismatchedBaseHash, 1n)
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectionError);
    expect((caught as Error).message).toContain(mismatchedBaseHash);
    expect((caught as Error).message).toContain("does not match the replayed stage files hash");
  });
});

function moduleSetEvent(): ChainEvent {
  return chainEvent(1n, 0, "StateMachineModuleSet", {
    moduleId: bytes32("91"),
    previousModule: ZERO_ADDRESS,
    newModule: FILE_MODULE
  }, STATE_MACHINE);
}

function patchEvent(
  blockNumber: bigint,
  logIndex: number,
  patchHash: string,
  baseHash: string,
  opCount: bigint,
  targetStageId = TARGET_STAGE_ID
): ChainEvent {
  return chainEvent(blockNumber, logIndex, "StageFilePatchApplied", {
    planId: PLAN_ID,
    orderId: ORDER_ID,
    targetStageId,
    patchHash,
    baseHash,
    submitter: "0x3333333333333333333333333333333333333333",
    writerStageId: ZERO_BYTES32,
    opCount
  });
}

function opEvent(
  blockNumber: bigint,
  logIndex: number,
  kind: number,
  key: string,
  contentHash: string,
  handle: string,
  targetStageId = TARGET_STAGE_ID
): ChainEvent {
  return chainEvent(blockNumber, logIndex, "StageFileOpApplied", {
    planId: PLAN_ID,
    orderId: ORDER_ID,
    targetStageId,
    kind,
    key,
    contentHash,
    handle
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
