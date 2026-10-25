// V3 聚焦回归：signal 候选/授权（config senders + slot binding +
// plan signalCapabilities）、证据句柄/显式验收、V3 store 发布元数据。

import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { ConfigBundleV3, ConfigStageV3 } from "@uvp-eth/product-dto";
import { onchainSignalId } from "@uvp-eth/compiler";
import { createVisibilityResolver } from "../src/visibility/index.js";
import {
  buildV3PublishMetadata,
  createV3EvidenceService,
  createV3SignalService,
} from "../src/v3/index.js";
import type { PlanCapabilityTables } from "../src/submissions/capability-proofs.js";
import type { OrderV3VisibilitySnapshot } from "../src/order/v3/service.js";
import type { OrderDraftRecord, OrderRecord, OrderStageRecord, OrderStageSlotRecord } from "../src/order/v3/types.js";
import type { Address, Hex } from "../src/shared/types.js";

const buyer = privateKeyToAccount(`0x${"02".repeat(32)}`);
const performer = privateKeyToAccount(`0x${"03".repeat(32)}`);
const verifier = privateKeyToAccount(`0x${"04".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"05".repeat(32)}`);
const stageKey = "alpha";
const stageId = keccak256(stringToHex(stageKey));
const planId = `0x${"11".repeat(32)}` as Hex;
const sourceId = `0x${"22".repeat(32)}` as Hex;
const orderId = `0x${"33".repeat(32)}` as Hex;

const stageConfig: ConfigStageV3 = {
  key: stageKey,
  name: "Alpha",
  index: 1,
  funded: true,
  slots: { payer: "buyer", payee: "performer", verifier: "verifier" },
  senders: ["performer", "verifier"],
  signals: [
    { name: "str", by: "performer" },
    { name: "submitted", by: "performer" },
    { name: "approved", by: "verifier" },
    { name: "rejected", by: "verifier" },
  ],
  acceptance: { mode: "third_party" },
  fileResources: [{ name: "std/alpha", version: "1", hash: `sha256:${"ab".repeat(32)}`, ref: "harness/alpha.md" }],
};

const config: ConfigBundleV3 = {
  configId: "test/v3",
  version: "1.0.0",
  status: "published",
  slots: [
    { key: "buyer", kind: "participant" },
    { key: "performer", kind: "participant" },
    { key: "verifier", kind: "participant" },
  ],
  stages: [stageConfig],
};

const order: OrderRecord = {
  orderId,
  draftId: "draft-1",
  planId,
  stateMachine: "0x9999999999999999999999999999999999999999" as Address,
  chainId: 31337,
  buyerWallet: buyer.address.toLowerCase() as Address,
  termsHash: `0x${"44".repeat(32)}` as Hex,
  status: "triggered",
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
};

const draft: OrderDraftRecord = {
  draftId: "draft-1",
  configId: "test/v3",
  configVersion: "1.0.0",
  configHash: `0x${"55".repeat(32)}` as Hex,
  buyerWallet: buyer.address.toLowerCase() as Address,
  chainId: 31337,
  stateMachine: "0x9999999999999999999999999999999999999999" as Address,
  title: "Order",
  currency: "USDT",
  stageSubset: [stageKey],
  status: "triggered",
  termsHash: `0x${"44".repeat(32)}` as Hex,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
};

const stage: OrderStageRecord = {
  draftId: "draft-1",
  stageKey,
  stageId,
  stageIndex: 1,
  amount: "1000000",
  slots: {},
  finalStandardHash: `0x${"66".repeat(32)}` as Hex,
  inviteDeadline: "2026-11-01T00:00:00.000Z",
  workDeadline: "2026-11-20T00:00:00.000Z",
  termsHash: `0x${"44".repeat(32)}` as Hex,
  status: "draft",
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
};

function slot(slotKey: string, wallet: string): OrderStageSlotRecord {
  return {
    draftId: "draft-1",
    stageKey,
    slotKey,
    required: true,
    wallet: wallet.toLowerCase() as Address,
    status: "accepted",
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  };
}

const snapshot: OrderV3VisibilitySnapshot = {
  order,
  draft,
  config,
  stages: [stage],
  slots: [
    slot("buyer", buyer.address),
    slot("performer", performer.address),
    slot("verifier", verifier.address),
  ],
};

const planTables: PlanCapabilityTables = {
  selectorBindings: [],
  signalCapabilities: ["str", "submitted", "approved", "rejected"].map((name) => ({
    stageId,
    targetSourceId: sourceId,
    signalId: onchainSignalId(name),
    targetOrderRelation: "current" as const,
  })),
};

function services(plan: PlanCapabilityTables | null = planTables) {
  const visibility = createVisibilityResolver({ loadOrder: async () => snapshot });
  const signals = createV3SignalService({
    visibility,
    loadOrder: async () => snapshot,
    loadPlanCapabilities: async () => plan ?? undefined,
  });
  return { visibility, signals };
}

describe("V3 signal authorization", () => {
  it("derives candidates from config senders + accepted slots and plan capabilities", async () => {
    const { signals } = services();
    const performerCandidates = await signals.listCandidates(orderId, undefined, performer.address as Address);
    expect(performerCandidates.map((candidate) => candidate.signalName).sort()).toEqual(["str", "submitted"]);
    expect(performerCandidates.every((candidate) => candidate.planVerified && candidate.sourceId === sourceId)).toBe(true);
    expect(performerCandidates.find((candidate) => candidate.signalName === "str")?.taskKind).toBe("perform_stage");

    const verifierCandidates = await signals.listCandidates(orderId, stageKey, verifier.address as Address);
    expect(verifierCandidates.map((candidate) => candidate.signalName).sort()).toEqual(["approved", "rejected"]);
    expect(verifierCandidates.find((candidate) => candidate.signalName === "approved")?.taskKind).toBe("verify_stage");

    await expect(signals.listCandidates(orderId, undefined, stranger.address as Address)).rejects.toMatchObject({ status: 404 });
  });

  it("authorizes allowed signals and rejects config/plan mismatches", async () => {
    const { signals } = services();
    await expect(signals.authorize({ orderId, stageKey, wallet: performer.address as Address, signalName: "str" })).resolves.toMatchObject({
      signalName: "str",
      slotKey: "performer",
      sourceId,
      planVerified: true,
    });
    await expect(signals.authorize({ orderId, stageKey, wallet: performer.address as Address, signalName: "approved" })).rejects.toMatchObject({
      status: 403,
      code: "signal_not_allowed",
    });

    const withoutPlan = services(null);
    await expect(withoutPlan.signals.authorize({ orderId, stageKey, wallet: performer.address as Address, signalName: "str" })).rejects.toMatchObject({
      status: 503,
      code: "plan_capability_unavailable",
    });

    const emptyPlan = services({ selectorBindings: [], signalCapabilities: [] });
    await expect(emptyPlan.signals.authorize({ orderId, stageKey, wallet: performer.address as Address, signalName: "str" })).rejects.toMatchObject({
      status: 403,
      code: "signal_capability_missing",
    });
  });
});

describe("V3 evidence/acceptance", () => {
  function evidence(resolution: "ok" | "empty" | "forbidden" | "resolve_failed" | "not_found") {
    const { signals } = services();
    return createV3EvidenceService({
      visibility: createVisibilityResolver({ loadOrder: async () => snapshot }),
      signals,
      loadOrder: async () => snapshot,
      resourceResolver: {
        async resolve() {
          if (resolution === "ok") return { kind: "ok", contentHash: "sha256:ok" };
          if (resolution === "empty") return { kind: "empty" };
          if (resolution === "forbidden") return { kind: "forbidden" };
          if (resolution === "resolve_failed") return { kind: "resolve_failed", message: "bad bytes" };
          return { kind: "not_found" };
        },
      },
    });
  }

  it("validates an explicit acceptance signal with declared handles and no evidenceSpec requirement", async () => {
    const service = evidence("ok");
    await expect(service.validateAcceptance({
      orderId,
      stageKey,
      wallet: verifier.address as Address,
      signalName: "approved",
      handleKeys: ["std/alpha"],
    })).resolves.toMatchObject({ validated: true, dataState: "ok", handles: [{ handleKey: "std/alpha", state: "ok" }] });

    await expect(service.validateAcceptance({
      orderId,
      stageKey,
      wallet: verifier.address as Address,
      signalName: "approved",
    })).resolves.toMatchObject({ validated: true, dataState: "none", handles: [] });

    await expect(service.validateAcceptance({
      orderId,
      stageKey,
      wallet: verifier.address as Address,
      signalName: "approved",
      handleKeys: ["std/unknown"],
    })).rejects.toMatchObject({ status: 404, code: "handle_not_found" });
  });

  it("keeps forbidden/parse-failed/empty distinct", async () => {
    await expect(evidence("forbidden").validateAcceptance({
      orderId, stageKey, wallet: verifier.address as Address, signalName: "approved", handleKeys: ["std/alpha"],
    })).rejects.toMatchObject({ status: 403, code: "resource_forbidden" });
    await expect(evidence("resolve_failed").validateAcceptance({
      orderId, stageKey, wallet: verifier.address as Address, signalName: "approved", handleKeys: ["std/alpha"],
    })).rejects.toMatchObject({ status: 502, code: "resource_parse_failed" });
    await expect(evidence("empty").validateAcceptance({
      orderId, stageKey, wallet: verifier.address as Address, signalName: "approved", handleKeys: ["std/alpha"],
    })).resolves.toMatchObject({ validated: true, dataState: "none", handles: [{ handleKey: "std/alpha", state: "empty" }] });
    await expect(evidence("not_found").validateAcceptance({
      orderId, stageKey, wallet: verifier.address as Address, signalName: "approved", handleKeys: ["std/alpha"],
    })).rejects.toMatchObject({ status: 404, code: "handle_not_found" });
  });
});

describe("V3 store publishing metadata", () => {
  it("emits config/plan metadata", () => {
    expect(buildV3PublishMetadata({ config, planId, planHash: `0x${"77".repeat(32)}` as Hex })).toMatchObject({
      schema: "uvp.order-config-publish/v3",
      configId: "test/v3",
      version: "1.0.0",
      planId,
    });
  });
});

