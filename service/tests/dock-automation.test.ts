import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, type Abi } from "viem";
import { capabilitiesRootOf } from "@uvp-eth/compiler";
import { DOCKING_MODULE_ABI } from "@uvp-eth/protocol-bindings";
import { DockAutomationWorker } from "../src/dock-automation/service.js";
import type { DockRouteRecord } from "../src/dock-automation/types.js";
import { createChainServicesStores, type ChainServicesStores } from "../src/storage/factory.js";
import { projectionScopeContractAddress } from "../src/storage/projection-store.js";
import { createPostgresTestDatabase } from "./postgres.js";

let stores: ChainServicesStores;

beforeAll(async () => {
  stores = createChainServicesStores({
    database: { url: await createPostgresTestDatabase(), migrationsAutoRun: true },
    chainId: 31337
  });
});

beforeEach(async () => {
  // 原先每用例各建一个 Memory projection store：重置为空投影面等价替换。
  await stores.projectionStore.resetFromEvents({ deploymentBlock: 0n, events: [] });
});

afterAll(async () => {
  await stores.close();
});
import type { PlanCapabilityTablesInput } from "../src/indexer/projections/plan.js";
import type { ChainEvent } from "../src/indexer/events.js";
import type { Hex } from "../src/shared/types.js";

const contractAddress = "0x1111111111111111111111111111111111111111" as Hex;
const dockingModuleAddress = "0x6666666666666666666666666666666666666666" as Hex;
const signer = "0x4444444444444444444444444444444444444444" as Hex;
const chainId = 31337;
const planId = bytes32Hex("0101");
const planHash = bytes32Hex("0a0a");
const targetPlanHash = bytes32Hex("0c0c");
const orderId = bytes32Hex("0202");
const hookId = bytes32Hex("0303");
const amendHookId = bytes32Hex("0808");
const linkedOrderId = bytes32Hex("0303");
const targetPlanId = bytes32Hex("0404");
const routeId = bytes32Hex("0505");
const dockInstanceId = bytes32Hex("0900");
const entranceBindingHash = bytes32Hex("0606");
const amendBindingHash = bytes32Hex("0707");
const outputBindingHash = bytes32Hex("0d0d");
const payloadHash = bytes32Hex("0b0b");
const signalId = bytes32Hex("0505");
const sourceId = bytes32Hex("0404");
const interfaceNameId = bytes32Text("production_service");
const zeroBytes32 = ("0x" + "00".repeat(32)) as Hex;

describe("dock liveness keeper", () => {

  it("stays idle with a loud warning when enabled but no route source/submitter is wired", async () => {
    const warnings: string[] = [];
    const infos: string[] = [];
    const logger = {
      warn: (message: string) => warnings.push(message),
      info: (message: string) => infos.push(message),
      debug: () => undefined,
      error: () => undefined
    };
    const worker = new DockAutomationWorker({
      config: { enabled: true, pollIntervalMs: 5, redeliveryWindowMs: 60_000, maxCandidatesPerRun: 5 },
      projectionStore: stores.projectionStore,
      dockingAddress: "0x6666666666666666666666666666666666666666",
      chainId: 31337,
      logger
    });

    await worker.start();
    expect(warnings.some((message) => message.includes("no route source/submitter"))).toBe(true);
    expect(infos).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(worker.getLastSummary()).toBeUndefined();
  });

  it("fails closed on route records with missing or malformed identity fields", async () => {
    const store = stores.projectionStore;
    await seedProjection(dockEvents());
    const submitted: string[] = [];
    const build = (routes: readonly DockRouteRecord[]) =>
      new DockAutomationWorker({
        config: { enabled: true, pollIntervalMs: 5_000, redeliveryWindowMs: 60_000, maxCandidatesPerRun: 4 },
        projectionStore: store,
        dockingAddress: dockingModuleAddress,
        chainId,
        routeSource: { listRoutes: async () => routes },
        submitter: {
          submit: async (submission) => {
            submitted.push(submission.data);
            return "0x" + "ab".repeat(32) as Hex;
          }
        }
      });

    await expect(build([{ ...dockRoute(), chainId: 31338 }]).runOnce())
      .rejects.toThrow(/routes\[0\]\.chainId .* does not match the keeper chain/);
    await expect(build([{ ...dockRoute(), routeId: "0x" + "00".repeat(32) as Hex }]).runOnce())
      .rejects.toThrow(/routes\[0\]\.routeId must be a non-zero bytes32/);
    const { openCalldata: _omitted, ...missingOpen } = dockRoute();
    void _omitted;
    await expect(build([missingOpen as DockRouteRecord]).runOnce())
      .rejects.toThrow(/routes\[0\]\.openCalldata must be pre-assembled calldata hex for a new-mode route/);
    await expect(build([{ ...dockRoute(), inputs: [] }]).runOnce())
      .rejects.toThrow(/routes\[0\]: new-mode route must carry the entrance input binding/);
    await expect(build([{
      ...dockRoute(),
      inputs: [...dockRoute().inputs.slice(1), { ...dockRoute().inputs[1]!, bindingHash: "0x1234" as Hex }]
    }]).runOnce())
      .rejects.toThrow(/routes\[0\]\.inputs\[1\]\.bindingHash must be a non-zero bytes32/);
    expect(submitted).toEqual([]);
  });

  it("relays the pre-assembled attach calldata once both endpoint orders are born, and stops once attached", async () => {
    const buildWorker = async (events: readonly ChainEvent[]) => {
      const store = stores.projectionStore;
      await resetProjection(events);
      const submitted: string[] = [];
      const worker = new DockAutomationWorker({
        config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
        projectionStore: store,
        dockingAddress: dockingModuleAddress,
        chainId,
        routeSource: { listRoutes: async () => [existingDockRoute()] },
        submitter: {
          submit: async (submission) => {
            submitted.push(submission.data);
            return "0x" + "ab".repeat(32) as Hex;
          }
        }
      });
      return { worker, submitted };
    };

    const withoutTarget = await buildWorker(
      attachedEvents().filter(
        (event) =>
          event.eventName !== "DockAttached" &&
          !(event.eventName === "OrderRegistered" && event.args["orderId"] === linkedOrderId)
      )
    );
    expect(await withoutTarget.worker.runOnce()).toMatchObject({ attachCandidates: 0, submitted: 0 });
    expect(withoutTarget.submitted).toEqual([]);

    const pending = await buildWorker(attachedEvents().filter((event) => event.eventName !== "DockAttached"));
    const summary = await pending.worker.runOnce();
    expect(summary).toMatchObject({ attachCandidates: 1, submitted: 1 });
    expect(pending.submitted).toEqual([existingDockRoute().attachCalldata]);

    const attached = await buildWorker(attachedEvents());
    const attachedSummary = await attached.worker.runOnce();
    expect(attachedSummary).toMatchObject({ attachCandidates: 0, inputCandidates: 1, submitted: 1 });
    expect(attached.submitted).not.toContain(existingDockRoute().attachCalldata);
  });

  it("skips only the attach lane with a skipped trace when a pending existing route carries no attachCalldata", async () => {
    const pendingRouteId = bytes32Hex("2525");
    const pendingOrderId = bytes32Hex("2626");
    const attachedRouteId = bytes32Hex("2727");
    const attachedOrderId = bytes32Hex("2828");
    const withAttachRoute: DockRouteRecord = {
      ...existingDockRoute(),
      routeId: pendingRouteId,
      localOrderId: pendingOrderId,
      attachCalldata: "0xabef9999" as Hex
    };
    const { attachCalldata: _omitted, ...pendingPermissionless } = {
      ...existingDockRoute(),
      routeId: attachedRouteId,
      localOrderId: attachedOrderId
    };
    void _omitted;
    const { attachCalldata: _omittedAttached, ...attachedPermissionless } = existingDockRoute();
    void _omittedAttached;

    const store = stores.projectionStore;
    await resetProjection([
      ...attachedEvents(),
      chainEvent(8n, 0, "OrderRegistered", { orderId: pendingOrderId, planId }),
      chainEvent(9n, 0, "OrderRegistered", { orderId: attachedOrderId, planId })
    ]);
    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [attachedPermissionless as DockRouteRecord, withAttachRoute, pendingPermissionless as DockRouteRecord] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      }
    });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ inputCandidates: 1, attachCandidates: 1, submitted: 2 });
    expect(summary.skipped).toContainEqual(
      expect.stringContaining(`attach:route ${attachedRouteId} carries no pre-assembled attachCalldata`)
    );
    expect(summary.skipped.join("\n")).not.toContain(existingDockRoute().routeId);
    expect(submitted).toContain(withAttachRoute.attachCalldata);
    const decoded = decodeFunctionData({ abi: DOCKING_MODULE_ABI as Abi, data: submitted[0] as Hex });
    expect(decoded.functionName).toBe("submitDockedInput");
  });

  it("does not broadcast submitDockedInput when the target fact slot is already occupied", async () => {
    const store = stores.projectionStore;
    await resetProjection([
      ...attachedEvents(),
      chainEvent(8n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      })
    ]);
    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [existingDockRoute()] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      }
    });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ inputCandidates: 0, submitted: 0 });
    expect(summary.skipped[0]).toMatch(/input:.*already occupied; submitDockedInput would revert DockInputConflict permanently/);
    expect(submitted).toEqual([]);
  });

  it("escalates a persistent DockInputConflict to an error-level alarm after consecutive windows", async () => {
    const store = stores.projectionStore;
    await resetProjection(attachedEvents());
    let nowMs = 1_000_000;
    let fail = true;
    const logger = new RecordingLogger();
    const worker = new DockAutomationWorker({
      config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [existingDockRoute()] },
      submitter: {
        submit: async () => {
          if (fail) {
            throw new Error("reverted: DockInputConflict(dockInstanceId, inputBindingHash)");
          }
          return "0x" + "ab".repeat(32) as Hex;
        }
      },
      logger,
      now: () => new Date(nowMs)
    });

    await worker.runOnce();
    nowMs += 70_000;
    await worker.runOnce();
    expect(logger.errors).toEqual([]);

    nowMs += 70_000;
    const third = await worker.runOnce();
    expect(third.skipped.length).toBe(1);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]!.message).toMatch(/no-convergence revert for 3 consecutive redelivery windows/);
    expect(logger.errors[0]!.context).toMatchObject({
      dockInstanceId,
      bindingHash: amendBindingHash,
      reason: "DockInputConflict",
      windows: 3
    });

    fail = false;
    nowMs += 70_000;
    await worker.runOnce();
    fail = true;
    nowMs += 70_000;
    await worker.runOnce();
    nowMs += 70_000;
    await worker.runOnce();
    expect(logger.errors).toHaveLength(1);
    nowMs += 70_000;
    await worker.runOnce();
    expect(logger.errors).toHaveLength(2);
    expect(logger.errors[1]!.context).toMatchObject({ windows: 3 });
  });

  it("escalates a persistent InvalidSignalCapability on the output lane to an error-level alarm", async () => {
    const store = stores.projectionStore;
    await resetProjection([
      ...attachedEvents(),
      chainEvent(8n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      })
    ]);
    const route: DockRouteRecord = { ...existingDockRoute(), inputs: [], outputs: [{
      bindingHash: outputBindingHash,
      localSourceId: sourceId,
      localSignalId: signalId,
      targetSourceId: sourceId,
      targetSignalId: signalId
    }] };
    let nowMs = 1_000_000;
    const logger = new RecordingLogger();
    const worker = new DockAutomationWorker({
      config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [route] },
      submitter: {
        submit: async () => {
          throw new Error("reverted: InvalidSignalCapability(planId, sourceId, signalId)");
        }
      },
      logger,
      now: () => new Date(nowMs)
    });

    for (let window = 1; window <= 3; window += 1) {
      await worker.runOnce();
      nowMs += 70_000;
    }
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]!.context).toMatchObject({
      dockInstanceId,
      bindingHash: outputBindingHash,
      reason: "InvalidSignalCapability",
      windows: 3
    });
  });

  it("does not re-broadcast the same binding inside the finality window and retries after it", async () => {
    const store = stores.projectionStore;
    await resetProjection(attachedEvents());

    let nowMs = 1_000_000;
    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxCandidatesPerRun: 4,
        redeliveryWindowMs: 60_000
      },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [existingDockRoute()] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      },
      now: () => new Date(nowMs)
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ inputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted.length).toBe(1);
    const decoded = decodeFunctionData({
      abi: DOCKING_MODULE_ABI as Abi,
      data: submitted[0] as Hex
    });
    expect(decoded.functionName).toBe("submitDockedInput");
    const inputArgs = decoded.args as unknown[];
    expect(inputArgs.slice(0, 3)).toEqual([dockInstanceId, amendHookId, amendBindingHash]);
    expect(inputArgs[3]).toMatchObject({
      sourceId: expect.any(String),
      signalId: expect.any(String)
    });

    nowMs += 10_000;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 1 });
    expect(submitted.length).toBe(1);

    nowMs += 60_000;
    const third = await worker.runOnce();
    expect(third).toMatchObject({ inputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted.length).toBe(2);
  });

  it("rate-bounds failed broadcasts with the same finality window", async () => {
    const store = stores.projectionStore;
    await resetProjection(attachedEvents());

    let nowMs = 1_000_000;
    let submitCalls = 0;
    const worker = new DockAutomationWorker({
      config: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxCandidatesPerRun: 4,
        redeliveryWindowMs: 60_000
      },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [existingDockRoute()] },
      submitter: {
        submit: async () => {
          submitCalls += 1;
          throw new Error("reverted: binding hash mismatch");
        }
      },
      now: () => new Date(nowMs)
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 0 });
    expect(first.skipped.length).toBe(1);
    expect(submitCalls).toBe(1);

    nowMs += 10_000;
    const second = await worker.runOnce();
    expect(second).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 1 });
    expect(second.skipped.length).toBe(0);
    expect(submitCalls).toBe(1);

    nowMs += 60_000;
    const third = await worker.runOnce();
    expect(third).toMatchObject({ inputCandidates: 1, submitted: 0, deduplicated: 0 });
    expect(third.skipped.length).toBe(1);
    expect(submitCalls).toBe(2);
  });

  it("stops submitting once the projection reflects the delivery", async () => {
    const events = [
      ...attachedEvents(),
      chainEvent(8n, 0, "DockInputSubmitted", {
        dockInstanceId,
        linkedOrderId,
        inputBindingHash: amendBindingHash,
        localPlanId: planId,
        localOrderId: orderId,
        targetPlanId,
        targetSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress)
    ];
    const store = stores.projectionStore;
    await resetProjection(events);

    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxCandidatesPerRun: 4,
        redeliveryWindowMs: 60_000
      },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [existingDockRoute()] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      }
    });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ inputCandidates: 0, submitted: 0, deduplicated: 0 });
    expect(submitted.length).toBe(0);
  });

  it("has no live input lane for new-mode docks because the entrance is delivered atomically at open", async () => {
    const store = stores.projectionStore;
    await resetProjection(dockEvents());

    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxCandidatesPerRun: 4,
        redeliveryWindowMs: 60_000
      },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [dockRoute()] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      }
    });

    const summary = await worker.runOnce();
    expect(summary).toMatchObject({ inputCandidates: 0, submitted: 0 });
    expect(submitted).toEqual([]);
  });

  it("backfills attached-dock outputs with submitDockedSignal and converges on the delivery event", async () => {
    const baseEvents: readonly ChainEvent[] = [
      ...attachedEvents(),
      chainEvent(8n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      })
    ];
    const route: DockRouteRecord = { ...existingDockRoute(), inputs: [], outputs: [{
      bindingHash: outputBindingHash,
      localSourceId: sourceId,
      localSignalId: signalId,
      targetSourceId: sourceId,
      targetSignalId: signalId
    }] };

    let nowMs = 1_000_000;
    const store = stores.projectionStore;
    await resetProjection(baseEvents);
    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxCandidatesPerRun: 4,
        redeliveryWindowMs: 60_000
      },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [route] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      },
      now: () => new Date(nowMs)
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ outputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted.length).toBe(1);
    const decoded = decodeFunctionData({
      abi: DOCKING_MODULE_ABI as Abi,
      data: submitted[0] as Hex
    });
    expect(decoded.functionName).toBe("submitDockedSignal");
    expect(decoded.args).toEqual([
      dockInstanceId,
      outputBindingHash,
      { sourceId, signalId, stageId: zeroBytes32, capabilityProof: [] }
    ]);

    nowMs += 10_000;
    expect(await worker.runOnce()).toMatchObject({ outputCandidates: 1, submitted: 0, deduplicated: 1 });

    nowMs += 60_000;
    expect(await worker.runOnce()).toMatchObject({ outputCandidates: 1, submitted: 1, deduplicated: 0 });
    expect(submitted.length).toBe(2);

    await resetProjection([
      ...baseEvents,
      chainEvent(9n, 0, "DockOutputSubmitted", {
        dockInstanceId,
        linkedOrderId,
        outputBindingHash,
        localPlanId: planId,
        localOrderId: orderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress)
    ]);
    const converged = await worker.runOnce();
    expect(converged).toMatchObject({ outputCandidates: 0, submitted: 0, deduplicated: 0 });
  });

  it("holds output backfill while the target fact sits in an unfinalized block", async () => {
    const events: readonly ChainEvent[] = [
      ...attachedEvents(),
      chainEvent(8n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      })
    ];
    const route: DockRouteRecord = { ...existingDockRoute(), inputs: [], outputs: [{
      bindingHash: outputBindingHash,
      localSourceId: sourceId,
      localSignalId: signalId,
      targetSourceId: sourceId,
      targetSignalId: signalId
    }] };
    const store = stores.projectionStore;
    await seedProjection(events);
    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [route] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      }
    });

    await store.saveSyncState(dockSyncState(7n));
    const held = await worker.runOnce();
    expect(held).toMatchObject({ outputCandidates: 0, attempted: 0, submitted: 0 });
    expect(submitted).toEqual([]);

    await store.saveSyncState(dockSyncState(8n));
    const released = await worker.runOnce();
    expect(released).toMatchObject({ outputCandidates: 1, attempted: 1, submitted: 1 });
    expect(submitted).toHaveLength(1);
  });

  it("fails the whole round closed while finality is unknown or a rebuild is in progress", async () => {
    const store = stores.projectionStore;
    await seedProjection(attachedEvents());
    const submitted: string[] = [];
    const worker = new DockAutomationWorker({
      config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [existingDockRoute()] },
      submitter: {
        submit: async (submission) => {
          submitted.push(submission.data);
          return "0x" + "ab".repeat(32) as Hex;
        }
      }
    });

    const { finalizedBlock: _unfinal, ...withoutFinality } = dockSyncState(7n);
    void _unfinal;
    await store.saveSyncState(withoutFinality);
    const unfinal = await worker.runOnce();
    expect(unfinal).toMatchObject({ inputCandidates: 0, attempted: 0, submitted: 0 });
    expect(unfinal.skipped[0]).toMatch(/finality: projection sync state carries no finalizedBlock/);

    await store.saveSyncState({ ...dockSyncState(7n), syncStatus: "rebuilding" });
    const rebuilding = await worker.runOnce();
    expect(rebuilding).toMatchObject({ inputCandidates: 0, attempted: 0, submitted: 0 });
    expect(rebuilding.skipped[0]).toMatch(/finality: projection rebuild is in progress/);
    expect(submitted).toEqual([]);
  });

  it("retries a DockOutputNotReady revert only once per finality window", async () => {
    const store = stores.projectionStore;
    await resetProjection([
      ...attachedEvents(),
      chainEvent(8n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      })
    ]);
    const route: DockRouteRecord = { ...existingDockRoute(), inputs: [], outputs: [{
      bindingHash: outputBindingHash,
      localSourceId: sourceId,
      localSignalId: signalId,
      targetSourceId: sourceId,
      targetSignalId: signalId
    }] };

    let nowMs = 1_000_000;
    let submitCalls = 0;
    const worker = new DockAutomationWorker({
      config: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxCandidatesPerRun: 4,
        redeliveryWindowMs: 60_000
      },
      projectionStore: store,
      dockingAddress: dockingModuleAddress,
      chainId,
      routeSource: { listRoutes: async () => [route] },
      submitter: {
        submit: async () => {
          submitCalls += 1;
          throw new Error("reverted: DockOutputNotReady(dockInstanceId, outputBindingHash)");
        }
      },
      now: () => new Date(nowMs)
    });

    const first = await worker.runOnce();
    expect(first).toMatchObject({ outputCandidates: 1, submitted: 0, deduplicated: 0 });
    expect(first.skipped[0]).toMatch(/DockOutputNotReady/);
    expect(submitCalls).toBe(1);

    nowMs += 10_000;
    expect(await worker.runOnce()).toMatchObject({ outputCandidates: 1, submitted: 0, deduplicated: 1 });
    expect(submitCalls).toBe(1);

    nowMs += 60_000;
    expect(await worker.runOnce()).toMatchObject({ outputCandidates: 1, submitted: 0, deduplicated: 0 });
    expect(submitCalls).toBe(2);
  });

  it("mints vocabulary-backed attribution for the mirrored parent fact and skips while enrichment state is unknown", async () => {
    const signalCapabilities = [
      { stageId: hookId, targetSourceId: sourceId, signalId, targetOrderRelation: 0 as const },
      { stageId: hookId, targetSourceId: sourceId, signalId: bytes32Hex("0f0f"), targetOrderRelation: 0 as const }
    ];
    const vocabulary = {
      planId,
      planHash,
      selectorBindings: [],
      signalCapabilities
    };
    const events: readonly ChainEvent[] = [
      ...attachedEvents(),
      chainEvent(8n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      })
    ];
    const route: DockRouteRecord = { ...existingDockRoute(), inputs: [], outputs: [{
      bindingHash: outputBindingHash,
      localSourceId: sourceId,
      localSignalId: signalId,
      targetSourceId: sourceId,
      targetSignalId: signalId
    }] };

    const buildWorker = async (planCapabilityTables: readonly PlanCapabilityTablesInput[]) => {
      const store = stores.projectionStore;
      await seedProjection(
        planPublishEvents(capabilitiesRootOf([], signalCapabilities)).concat(events),
        planCapabilityTables
      );
      await store.saveSyncState(dockSyncState(10n));
      const submitted: string[] = [];
      const worker = new DockAutomationWorker({
        config: { enabled: true, pollIntervalMs: 5_000, maxCandidatesPerRun: 4, redeliveryWindowMs: 60_000 },
        projectionStore: store,
        dockingAddress: dockingModuleAddress,
        chainId,
        routeSource: { listRoutes: async () => [route] },
        submitter: {
          submit: async (submission) => {
            submitted.push(submission.data);
            return "0x" + "ab".repeat(32) as Hex;
          }
        }
      });
      return { worker, submitted };
    };

    const enriched = await buildWorker([vocabulary]);
    const enrichedSummary = await enriched.worker.runOnce();
    expect(enrichedSummary).toMatchObject({ outputCandidates: 1, submitted: 1, skipped: [] });
    const decoded = decodeFunctionData({
      abi: DOCKING_MODULE_ABI as Abi,
      data: enriched.submitted[0] as Hex
    });
    expect(decoded.args).toEqual([
      dockInstanceId,
      outputBindingHash,
      { sourceId, signalId, stageId: hookId, capabilityProof: [expect.any(String)] }
    ]);

    const failed = await buildWorker([{
      planId,
      planHash,
      selectorBindings: [],
      signalCapabilities: [{
        stageId: hookId,
        targetSourceId: sourceId,
        signalId: bytes32Hex("0f0f"),
        targetOrderRelation: 0 as const
      }]
    }]);
    const failedSummary = await failed.worker.runOnce();
    expect(failedSummary).toMatchObject({ outputCandidates: 1, submitted: 0 });
    expect(failedSummary.skipped[0]).toMatch(/enrichment failed/);
    expect(failed.submitted).toEqual([]);
  });

  it("treats a sibling-satisfied output binding as delivered instead of re-broadcasting forever", async () => {
    const doneBindingHash = bytes32Hex("0d0d");
    const progressBindingHash = bytes32Hex("0e0e");
    const outputs = [
      {
        bindingHash: doneBindingHash,
        localSourceId: sourceId,
        localSignalId: signalId,
        targetSourceId: sourceId,
        targetSignalId: signalId
      },
      {
        bindingHash: progressBindingHash,
        localSourceId: sourceId,
        localSignalId: signalId,
        targetSourceId: sourceId,
        targetSignalId: signalId
      }
    ];
    const route: DockRouteRecord = { ...dockRoute(), inputs: [dockRoute().inputs[0]!], outputs };
    const baseEvents: readonly ChainEvent[] = [
      ...dockEvents(),
      chainEvent(6n, 0, "SignalSubmitted", {
        orderId: linkedOrderId,
        sourceId,
        signalId,
        payloadHash,
        idempotencyKey: bytes32Hex("0aaa"),
        submitter: signer
      }),
      chainEvent(7n, 0, "DockOutputSubmitted", {
        dockInstanceId,
        linkedOrderId,
        outputBindingHash: doneBindingHash,
        localPlanId: planId,
        localOrderId: orderId,
        targetPlanId,
        targetSignalId: signalId,
        localSignalId: signalId,
        payloadHash,
        submitter: signer
      }, dockingModuleAddress)
    ];
    const satisfiedEvent: ChainEvent = chainEvent(8n, 0, "DockOutputSatisfied", {
      dockInstanceId,
      linkedOrderId,
      outputBindingHash: progressBindingHash,
      localPlanId: planId,
      localOrderId: orderId,
      targetPlanId,
      targetSignalId: signalId,
      localSignalId: signalId,
      payloadHash,
      submitter: signer
    }, dockingModuleAddress);

    const buildWorker = async (events: readonly ChainEvent[]) => {
      const store = stores.projectionStore;
      await resetProjection(events);
      const submitted: string[] = [];
      const worker = new DockAutomationWorker({
        config: {
          enabled: true,
          pollIntervalMs: 5_000,
          maxCandidatesPerRun: 4,
          redeliveryWindowMs: 60_000
        },
        projectionStore: store,
        dockingAddress: dockingModuleAddress,
        chainId,
        routeSource: { listRoutes: async () => [route] },
        submitter: {
          submit: async (submission) => {
            submitted.push(submission.data);
            return "0x" + "ab".repeat(32) as Hex;
          }
        }
      });
      return { worker, submitted };
    };

    const without = await buildWorker(baseEvents);
    const withoutSummary = await without.worker.runOnce();
    expect(withoutSummary).toMatchObject({ outputCandidates: 1, submitted: 1 });
    expect(without.submitted.length).toBe(1);

    const withSatisfied = await buildWorker([...baseEvents, satisfiedEvent]);
    const summary = await withSatisfied.worker.runOnce();
    expect(summary).toMatchObject({ outputCandidates: 0, submitted: 0, deduplicated: 0 });
    expect(withSatisfied.submitted.length).toBe(0);
  });
});

function dockRoute(): DockRouteRecord {
  return {
    chainId,
    localPlanId: planId,
    localOrderId: orderId,
    targetPlanId,
    linkedOrderId,
    routeId,
    routeHash: planHash,
    interfaceName: "production_service",
    orderMode: "new",
    openCalldata: "0xabcd1234" as Hex,
    inputs: [
      {
        bindingHash: entranceBindingHash,
        localHookId: hookId,
        targetSourceId: sourceId,
        targetSignalId: signalId
      },
      {
        bindingHash: amendBindingHash,
        localHookId: amendHookId,
        targetSourceId: sourceId,
        targetSignalId: signalId
      }
    ],
    outputs: []
  };
}

function existingDockRoute(): DockRouteRecord {
  return {
    chainId,
    localPlanId: planId,
    localOrderId: orderId,
    targetPlanId,
    linkedOrderId,
    routeId,
    routeHash: planHash,
    interfaceName: "production_service",
    orderMode: "existing",
    attachCalldata: "0xabef5678" as Hex,
    inputs: [
      {
        bindingHash: amendBindingHash,
        localHookId: amendHookId,
        targetSourceId: sourceId,
        targetSignalId: signalId
      }
    ],
    outputs: []
  };
}

function dockEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, 0, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n
    }),
    chainEvent(2n, 0, "OrderRegistered", {
      orderId,
      planId
    }),
    chainEvent(3n, 0, "StateMachineModuleSet", {
      moduleId: bytes32Text("uvp.module.docking.v1"),
      previousModule: "0x0000000000000000000000000000000000000000",
      newModule: dockingModuleAddress
    }),
    chainEvent(4n, 0, "HookStatusChanged", {
      orderId,
      planId,
      hookId: amendHookId,
      previousStatus: 0,
      newStatus: 2,
      dueAt: 0n
    }),
    chainEvent(5n, 0, "DockOpened", {
      dockInstanceId,
      localOrderId: orderId,
      linkedOrderId,
      interfaceNameId,
      localPlanId: planId,
      targetPlanId,
      routeId,
      routeHash: planHash,
      depth: 1n,
      opener: signer
    }, dockingModuleAddress)
  ];
}

function attachedEvents(): readonly ChainEvent[] {
  return [
    chainEvent(1n, 0, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n
    }),
    chainEvent(2n, 0, "PlanRegistered", {
      planId: targetPlanId,
      planHash: targetPlanHash,
      hookCount: 1n
    }),
    chainEvent(3n, 0, "OrderRegistered", {
      orderId,
      planId
    }),
    chainEvent(4n, 0, "OrderRegistered", {
      orderId: linkedOrderId,
      planId: targetPlanId
    }),
    chainEvent(5n, 0, "StateMachineModuleSet", {
      moduleId: bytes32Text("uvp.module.docking.v1"),
      previousModule: "0x0000000000000000000000000000000000000000",
      newModule: dockingModuleAddress
    }),
    chainEvent(6n, 0, "HookStatusChanged", {
      orderId,
      planId,
      hookId: amendHookId,
      previousStatus: 0,
      newStatus: 2,
      dueAt: 0n
    }),
    chainEvent(7n, 0, "DockAttached", {
      dockInstanceId,
      localOrderId: orderId,
      linkedOrderId,
      interfaceNameId,
      localPlanId: planId,
      targetPlanId,
      routeId,
      routeHash: planHash,
      depth: 1n,
      attacher: signer
    }, dockingModuleAddress)
  ];
}

function planPublishEvents(capabilitiesRoot: Hex): readonly ChainEvent[] {
  return [
    chainEvent(0n, 0, "PlanCommitted", {
      planId,
      planHash,
      publisher: signer,
      hooksHash: bytes32Hex("0e01"),
      capabilitiesRoot,
      hookCount: 1n,
      dockRoutesRoot: bytes32Hex("0e03"),
      dockInterfaceRoot: bytes32Hex("0e04")
    }),
    chainEvent(0n, 1, "PlanPublisherRecorded", {
      planId,
      publisher: signer
    }),
    chainEvent(0n, 2, "PlanFinalized", {
      planId,
      planHash,
      capabilitiesRoot
    }),
    chainEvent(0n, 3, "PlanRegistered", {
      planId,
      planHash,
      hookCount: 1n
    })
  ];
}

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  eventContractAddress: Hex = contractAddress
): ChainEvent {
  return {
    chainId,
    contractAddress: eventContractAddress,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex,
    logIndex,
    eventName,
    args
  };
}

function dockSyncState(finalizedBlock: bigint) {
  return {
    chainId,
    // PG 投影 sync_state 按 (chainId, contractAddress) 作用域：worker 经
    // defaultProjectionScope 读 0x0000…0000，夹具写入必须用同一 scope 键。
    contractAddress: projectionScopeContractAddress,
    syncStatus: "indexed" as const,
    latestIndexedBlock: finalizedBlock,
    finalizedBlock,
    confirmationDepth: 1,
    eventCount: 7,
    rebuild: { status: "completed" as const }
  };
}

// 与 timer-keeper.test.ts 的 freshStore 同型：resetFromEvents 只持久化派生
// 同步态（不含 finalizedBlock），这里显式补写已定稿高度，keeper 才会放行候选。
async function resetProjection(events: readonly ChainEvent[], finalizedBlock = 10n): Promise<void> {
  await seedProjection(events);
  await stores.projectionStore.saveSyncState(dockSyncState(finalizedBlock));
}

// 链上注册一个 plan 必然先有 commit/finalize：夹具只写 PlanRegistered 时补上
// 空词表的发布锚（同块高位 logIndex，避开夹具既有事件），让 plan 投影可被
// plan artifact 词表 enrich；显式词表优先，其余 plan 用空词表。
async function seedProjection(
  events: readonly ChainEvent[],
  planCapabilityTables: readonly PlanCapabilityTablesInput[] = []
): Promise<void> {
  const seeded = withPublishedPlanAnchors(events);
  const explicitPlanIds = new Set(planCapabilityTables.map((tables) => tables.planId.toLowerCase()));
  await stores.projectionStore.resetFromEvents({
    deploymentBlock: 0n,
    events: seeded,
    planCapabilityTables: [
      ...planCapabilityTables,
      ...seeded
        .filter((event) => event.eventName === "PlanCommitted")
        .map((event) => ({
          planId: String(event.args.planId) as Hex,
          planHash: String(event.args.planHash) as Hex,
          selectorBindings: [],
          signalCapabilities: []
        }))
        .filter((tables) => !explicitPlanIds.has(tables.planId.toLowerCase()))
    ]
  });
}

function withPublishedPlanAnchors(events: readonly ChainEvent[]): readonly ChainEvent[] {
  const emptyRoot = capabilitiesRootOf([], []);
  const committed = new Set(
    events
      .filter((event) => event.eventName === "PlanCommitted")
      .map((event) => String(event.args.planId).toLowerCase())
  );
  const anchors: ChainEvent[] = [];
  let logIndex = 900;
  for (const event of events) {
    if (event.eventName !== "PlanRegistered") continue;
    const anchorPlanId = String(event.args.planId);
    if (committed.has(anchorPlanId.toLowerCase())) continue;
    committed.add(anchorPlanId.toLowerCase());
    const anchorPlanHash = String(event.args.planHash);
    anchors.push(
      chainEvent(0n, logIndex++, "PlanCommitted", {
        planId: anchorPlanId,
        planHash: anchorPlanHash,
        publisher: signer,
        hooksHash: bytes32Hex("0e01"),
        capabilitiesRoot: emptyRoot,
        hookCount: 1n,
        dockRoutesRoot: bytes32Hex("0e03"),
        dockInterfaceRoot: bytes32Hex("0e04")
      }),
      chainEvent(0n, logIndex++, "PlanFinalized", {
        planId: anchorPlanId,
        planHash: anchorPlanHash,
        capabilitiesRoot: emptyRoot
      })
    );
  }
  return [...anchors, ...events];
}

function bytes32Hex(value: string): Hex {
  return `0x${value.padStart(64, "0")}` as Hex;
}

class RecordingLogger {
  readonly errors: Array<{ readonly message: string; readonly context?: Record<string, unknown> }> = [];

  error(message: string, context?: Record<string, unknown>): void {
    this.errors.push({ message, ...(context ? { context } : {}) });
  }

  warn(): void {
  }

  info(): void {
  }

  debug(): void {
  }
}

function bytes32Text(value: string): Hex {
  return `0x${Buffer.from(value, "utf8").toString("hex").padEnd(64, "0")}` as Hex;
}
