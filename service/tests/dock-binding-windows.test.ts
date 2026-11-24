// Bug prevented: a snapshot read fanned out one RPC call per dock output with
// no bound (40 bindings x 5 outputs = 200 concurrent eth_calls), and the window
// reader's 503 body echoed the full RPC endpoint URL including provider path
// credentials. The limiter must also release its slot when a read rejects.
import { describe, expect, it } from "vitest";
import {
  DockBindingWindowUnavailableError,
  wireDockBindings,
  type DockBindingWindowReader
} from "../src/api/dock-binding-windows.js";
import type { ProjectionSnapshot } from "../src/indexer/projections/index.js";
import { redactEndpointErrorMessage } from "../src/shared/redaction.js";

const CHAIN_ID = 31_337;
const STATE_MACHINE = "0x1111111111111111111111111111111111111111" as const;

describe("dock binding window fanout", () => {
  it("bounds concurrent RPC reads below the configured limit while still reading in parallel", async () => {
    let active = 0;
    let peak = 0;
    const reader = countingReader(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    });

    const bindings = await wireDockBindings(snapshotWithBindings(4, 3), reader, { concurrency: 3 });

    expect(Object.keys(bindings)).toHaveLength(4);
    expect(Object.values(bindings).every((binding) => binding.outputs.length === 3)).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("applies the default bound to larger fanouts instead of issuing one call per output", async () => {
    let active = 0;
    let peak = 0;
    const reader = countingReader(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    });

    const bindings = await wireDockBindings(snapshotWithBindings(10, 4), reader);

    expect(Object.keys(bindings)).toHaveLength(10);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("releases the read slot when a window read rejects and keeps later reads working", async () => {
    let calls = 0;
    const flaky: DockBindingWindowReader = {
      async readWindow() {
        calls += 1;
        if (calls === 1) {
          throw new DockBindingWindowUnavailableError(
            "dock binding window view failed: HTTP request failed. URL: https://rpc.example/v2/secret-key"
          );
        }
        return { current: true, aSatisfied: true, aDueInSeconds: 0, bSatisfied: true, emitted: false };
      }
    };

    await expect(
      wireDockBindings(snapshotWithBindings(2, 1), flaky, { concurrency: 1 })
    ).rejects.toBeInstanceOf(DockBindingWindowUnavailableError);

    const recovered = await wireDockBindings(snapshotWithBindings(2, 1), flaky, { concurrency: 1 });
    expect(Object.keys(recovered)).toHaveLength(2);
    expect(calls).toBeGreaterThan(1);
  });

  it("redacts RPC endpoint URLs, userinfo, provider path keys, and labeled secrets", () => {
    const message = redactEndpointErrorMessage(
      new Error(
        "HTTP request failed. URL: https://base-mainnet.g.alchemy.com/v2/alchemy-path-key " +
          "and https://user:password@rpc.example/v3/infura-key?api_key=query-key token=labeled-secret"
      )
    );

    expect(message).toContain("[redacted:url]");
    expect(message).not.toContain("alchemy-path-key");
    expect(message).not.toContain("infura-key");
    expect(message).not.toContain("user:password");
    expect(message).not.toContain("query-key");
    expect(message).not.toContain("labeled-secret");
    expect(redactEndpointErrorMessage(new Error("execution reverted: UnknownHook")))
      .toBe("execution reverted: UnknownHook");
  });
});

function countingReader(onRead: () => Promise<void>): DockBindingWindowReader {
  return {
    async readWindow() {
      await onRead();
      return { current: true, aSatisfied: true, aDueInSeconds: 0, bSatisfied: true, emitted: false };
    }
  };
}

function snapshotWithBindings(bindingCount: number, outputsPerBinding: number): ProjectionSnapshot {
  const provenance = (blockNumber: bigint) => ({
    chainId: CHAIN_ID,
    contractAddress: STATE_MACHINE,
    blockNumber,
    transactionIndex: 0,
    transactionHash: `0x${"a".repeat(64)}` as const,
    logIndex: 0
  });
  const bindings: Record<string, unknown> = {};
  const orders: Record<string, unknown> = {};
  for (let index = 0; index < bindingCount; index += 1) {
    const bindingId = `0x${index.toString(16).padStart(64, "0")}` as const;
    const orderId = `0x${(index + 1000).toString(16).padStart(64, "0")}` as const;
    const planId = `0x${"b".repeat(64)}` as const;
    const stageId = `0x${(index + 2000).toString(16).padStart(64, "0")}` as const;
    bindings[bindingId] = {
      bindingId,
      dkid: `zd-${"c".repeat(32)}`,
      planId,
      orderId,
      targetStageId: stageId,
      fromZhixuId: `zx-${"d".repeat(32)}`,
      fromSource: "buyer",
      fromOrderId: `0x${"e".repeat(64)}`,
      toZhixuId: `zx-${"f".repeat(32)}`,
      toStageIdentifier: "intake",
      pokedAt: provenance(20n),
      outputs: Array.from({ length: outputsPerBinding }, (_, outputIndex) => ({
        signal: `signal-${outputIndex}`,
        signalId: `0x${(outputIndex + 3000).toString(16).padStart(64, "0")}`,
        outputIndex,
        emitted: false
      })),
      proof: {
        ...provenance(20n),
        eventId: `event-${index}`,
        eventName: "DockBindingPoked",
        args: {}
      }
    };
    orders[orderId] = {
      orderId,
      planId,
      stageFiles: {
        [stageId]: {
          planId,
          orderId,
          targetStageId: stageId,
          files: {
            dock_link: {
              key: "dock_link",
              payload: `0x${"9".repeat(64)}`,
              updatedAt: provenance(19n),
              proof: { ...provenance(19n), eventId: `file-${index}`, eventName: "StageFileWritten", args: {} }
            }
          },
          updatedAt: provenance(19n),
          proof: { ...provenance(19n), eventId: `file-${index}`, eventName: "StageFileWritten", args: {} }
        }
      }
    };
  }
  return {
    rebuildable: true,
    eventCount: 0,
    stateMachineDeployments: {},
    stateMachineModules: {},
    contractGovernance: {},
    stateMachinePlans: {},
    stateMachineOrders: orders,
    stateMachineDocks: {},
    stateMachineDockBindings: bindings,
    stateMachineTasks: {},
    stateMachineSuppliers: {}
  } as unknown as ProjectionSnapshot;
}
