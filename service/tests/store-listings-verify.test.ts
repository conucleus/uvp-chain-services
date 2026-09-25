import { describe, expect, it } from "vitest";
import type { ChainEvent } from "../src/indexer/events.js";
import { MemoryProjectionStore } from "../src/storage/projection-store.js";
import type { Address, Hex } from "../src/shared/types.js";
import type { StoreListingRecord } from "../src/store/listings/types.js";
import { verifyListingAnchors } from "../src/store/listings/verify.js";

/**
 * 锚核验三态：已投影且匹配（consistent）/ 已投影且失配（conflict）/
 * 未投影（pending_indexing——投影滞后窗口等索引器，不是冲突）；
 * 以及同 planId 跨部署多命中的显式冲突（不静默取首个命中）。
 */

const contractAddress = "0x1111111111111111111111111111111111111111" as Address;
const secondDeploymentAddress = "0x2222222222222222222222222222222222222222" as Address;
const planId = "0x0000000000000000000000000000000000000000000000000000000000000201" as Hex;
const otherPlanId = "0x0000000000000000000000000000000000000000000000000000000000000301" as Hex;
const planHash = `0x${"ab".repeat(32)}` as Hex;
const otherPlanHash = `0x${"cd".repeat(32)}` as Hex;

function chainEvent(
  blockNumber: bigint,
  logIndex: number,
  eventName: string,
  args: Record<string, unknown>,
  contract: Address = contractAddress
): ChainEvent {
  return {
    chainId: 31337,
    contractAddress: contract,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(8, "0")}${"e".repeat(56)}`,
    logIndex,
    eventName,
    args
  };
}

async function seededStore(events: readonly ChainEvent[]): Promise<MemoryProjectionStore> {
  const store = new MemoryProjectionStore();
  await store.resetFromEvents({ deploymentBlock: 0n, events });
  return store;
}

function listing(overrides: Partial<StoreListingRecord> = {}): StoreListingRecord {
  return {
    listingId: "listing_test",
    planId,
    status: "imported",
    importedAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    ...overrides
  };
}

const now = (): Date => new Date("2026-09-25T00:00:00Z");

describe("listing anchor verification states", () => {
  it("reports consistent when the projection matches the claimed planHash", async () => {
    const store = await seededStore([
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 2n })
    ]);
    const verification = await verifyListingAnchors({
      listing: listing({ planHashClaimed: planHash }),
      projectionStore: store,
      now
    });
    expect(verification.status).toBe("consistent");
    expect(verification.projection.planProjected).toBe(true);
  });

  it("reports conflict when the plan is projected but the claim mismatches", async () => {
    const store = await seededStore([
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 2n })
    ]);
    const verification = await verifyListingAnchors({
      listing: listing({ planHashClaimed: otherPlanHash }),
      projectionStore: store,
      now
    });
    expect(verification.status).toBe("conflict");
    expect(verification.checks.some((check) => check.id === "plan_hash" && check.outcome === "mismatch")).toBe(true);
  });

  it("reports pending_indexing (not conflict) while the plan is not yet projected", async () => {
    const store = await seededStore([
      chainEvent(1n, 0, "PlanRegistered", { planId: otherPlanId, planHash, hookCount: 2n })
    ]);
    const verification = await verifyListingAnchors({
      listing: listing({ planHashClaimed: planHash }),
      projectionStore: store,
      now
    });
    expect(verification.status).toBe("pending_indexing");
    expect(verification.projection.planProjected).toBe(false);
    // 未投影是等待不是冲突：plan_projected 不得计入 mismatch。
    expect(verification.checks.find((check) => check.id === "plan_projected")?.outcome).toBe("unavailable");
    expect(verification.checks.some((check) => check.outcome === "mismatch")).toBe(false);
  });

  it("fails closed with conflict when the same planId is registered on two deployments", async () => {
    const store = await seededStore([
      chainEvent(1n, 0, "PlanRegistered", { planId, planHash, hookCount: 2n }, contractAddress),
      chainEvent(2n, 0, "PlanRegistered", { planId, planHash: otherPlanHash, hookCount: 2n }, secondDeploymentAddress)
    ]);
    const verification = await verifyListingAnchors({
      listing: listing({ planHashClaimed: planHash }),
      projectionStore: store,
      now
    });
    expect(verification.status).toBe("conflict");
    expect(verification.checks.some((check) => check.id === "plan_projection_ambiguous" && check.outcome === "mismatch")).toBe(true);
    // 锚无法唯一归位时不得取首个命中当投影事实。
    expect(verification.projection.planProjected).toBe(false);
  });
});
