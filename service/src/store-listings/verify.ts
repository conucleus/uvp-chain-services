import { createPublicClient, http, type PublicClient } from "viem";
import type { Address, Hex } from "../shared/types.js";
import type {
  ListingAnchorChainView,
  StoreAnchorCheck,
  StoreAnchorVerificationDTO,
  StoreListingRecord
} from "./types.js";
import type { ProjectionStore } from "../storage/projection-store.js";

/**
 * 锚核验红线：listing 声称的锚 vs 投影 vs（可选）链上直读。
 *
 * - 投影是 indexer 从链事件重建的事实；链直读是独立的第二证据源。
 * - 没有配置 RPC/状态机地址时链直读标记 unavailable（不伪造），
 *   核验退化为投影比对（projection-only），状态相应保守。
 * - 任何 mismatch 都必须显式 conflict，由上层抑制加入入口。
 */

const LISTING_ANCHOR_ABI = [
  { inputs: [{ name: "planId", type: "bytes32" }], name: "planCommitted", outputs: [{ type: "bool" }], stateMutability: "view" },
  { inputs: [{ name: "planId", type: "bytes32" }], name: "planFinalized", outputs: [{ type: "bool" }], stateMutability: "view" },
  { inputs: [{ name: "planId", type: "bytes32" }], name: "planPublisher", outputs: [{ type: "address" }], stateMutability: "view" }
] as const;

export function createListingAnchorChainView(options: {
  readonly rpcUrl: string;
  readonly stateMachineAddress: Address;
}): ListingAnchorChainView {
  let client: PublicClient | undefined;
  const getClient = (): PublicClient => {
    client ??= createPublicClient({ transport: http(options.rpcUrl) });
    return client;
  };
  return {
    async readPlanAnchors(planId: Hex, stateMachineAddress?: Address) {
      const target = stateMachineAddress ?? options.stateMachineAddress;
      const [planCommitted, planFinalized, planPublisher] = await Promise.all([
        getClient().readContract({
          address: target,
          abi: LISTING_ANCHOR_ABI,
          functionName: "planCommitted",
          args: [planId]
        }),
        getClient().readContract({
          address: target,
          abi: LISTING_ANCHOR_ABI,
          functionName: "planFinalized",
          args: [planId]
        }),
        getClient().readContract({
          address: target,
          abi: LISTING_ANCHOR_ABI,
          functionName: "planPublisher",
          args: [planId]
        })
      ]);
      return {
        stateMachineAddress: target,
        planCommitted: Boolean(planCommitted),
        planFinalized: Boolean(planFinalized),
        planPublisher: planPublisher as Address
      };
    }
  };
}

export async function verifyListingAnchors(options: {
  readonly listing: StoreListingRecord;
  readonly projectionStore: ProjectionStore;
  readonly chainView?: ListingAnchorChainView;
  readonly now: () => Date;
}): Promise<StoreAnchorVerificationDTO> {
  const { listing } = options;
  const snapshot = await options.projectionStore.getOrderSnapshot();
  // 投影以 chainId:contract:planId 为键；按 planId 值匹配（大小写不敏感）。
  const plan = Object.values(snapshot.stateMachinePlans)
    .find((candidate) => candidate.planId.toLowerCase() === listing.planId.toLowerCase());
  const checks: StoreAnchorCheck[] = [];

  checks.push({
    id: "plan_projected",
    label: "秩序已在链上注册并被索引（PlanRegistered 投影）",
    expected: "projected",
    actual: plan ? "projected" : "missing",
    outcome: plan ? "match" : "mismatch"
  });

  let planHashReference: string | undefined = plan?.planHash;
  if (plan && listing.planHashClaimed) {
    const match = listing.planHashClaimed.toLowerCase() === plan.planHash.toLowerCase();
    checks.push({
      id: "plan_hash",
      label: "listing 声称的 planHash 与链上注册一致",
      expected: listing.planHashClaimed,
      actual: plan.planHash,
      outcome: match ? "match" : "mismatch"
    });
    if (!match) {
      planHashReference = listing.planHashClaimed;
    }
  }

  if (plan && listing.deploymentIdClaimed) {
    // 关联性核验：deploymentId 必须属于该 plan（plan 自带 deploymentId 时直接比对）。
    const planDeployment = plan.deploymentId ?? Object.values(snapshot.stateMachinePlans)
      .find((candidate) =>
        candidate.deploymentId?.toLowerCase() === listing.deploymentIdClaimed!.toLowerCase() &&
        candidate.planId.toLowerCase() === plan.planId.toLowerCase())
      ?.deploymentId;
    const match = planDeployment
      ? planDeployment.toLowerCase() === listing.deploymentIdClaimed.toLowerCase()
      : false;
    checks.push({
      id: "deployment_id",
      label: "listing 声称的 deploymentId 与该 plan 的投影一致",
      expected: listing.deploymentIdClaimed,
      actual: planDeployment ?? "missing",
      outcome: match ? "match" : "mismatch"
    });
  }

  if (plan && listing.stateMachineAddressClaimed) {
    const match = listing.stateMachineAddressClaimed.toLowerCase() === plan.stateMachineAddress.toLowerCase();
    checks.push({
      id: "state_machine_address",
      label: "listing 声称的状态机地址与投影一致",
      expected: listing.stateMachineAddressClaimed,
      actual: plan.stateMachineAddress,
      outcome: match ? "match" : "mismatch"
    });
  }

  let chainViewBlock: StoreAnchorVerificationDTO["chain"];
  let chainReadFailed = false;
  if (options.chainView) {
    try {
      const anchors = await options.chainView.readPlanAnchors(
        listing.planId,
        plan?.stateMachineAddress
      );
      chainViewBlock = {
        source: "live_read",
        ...(anchors.stateMachineAddress ? { stateMachineAddress: anchors.stateMachineAddress } : {}),
        ...(anchors.planFinalized !== undefined ? { planFinalized: anchors.planFinalized } : {}),
        ...(anchors.planPublisher ? { planPublisher: anchors.planPublisher } : {})
      };
      checks.push({
        id: "chain_plan_finalized",
        label: "链上直读 planFinalized",
        expected: "true",
        actual: String(anchors.planFinalized ?? false),
        outcome: anchors.planFinalized ? "match" : "mismatch"
      });
      if (anchors.planPublisher && plan?.publisher) {
        const match = anchors.planPublisher.toLowerCase() === plan.publisher.toLowerCase();
        checks.push({
          id: "chain_publisher",
          label: "链上直读 planPublisher 与投影一致",
          expected: plan.publisher,
          actual: anchors.planPublisher,
          outcome: match ? "match" : "mismatch"
        });
      }
      if (anchors.planPublisher && !plan?.publisher) {
        checks.push({
          id: "chain_publisher",
          label: "链上直读 planPublisher（投影缺 publisher）",
          actual: anchors.planPublisher,
          outcome: "unavailable"
        });
      }
    } catch {
      chainReadFailed = true;
      checks.push({
        id: "chain_read",
        label: "链上直读（已配置但读取失败；公开被阻断直至恢复）",
        outcome: "unavailable"
      });
    }
  } else {
    checks.push({
      id: "chain_read",
      label: "链上直读（未配置 UVP_RPC_URL/状态机地址时不可用，核验退化为投影比对）",
      outcome: "unavailable"
    });
  }

  const hasMismatch = checks.some((check) => check.outcome === "mismatch");
  const status = hasMismatch ? "conflict" : plan ? "consistent" : "pending_indexing";

  return {
    listingId: listing.listingId,
    planId: listing.planId,
    status,
    checks,
    projection: {
      planProjected: Boolean(plan),
      ...(planHashReference ? { planHash: planHashReference as Hex } : {}),
      ...(plan?.publisher ? { publisher: plan.publisher } : {}),
      ...(plan?.deploymentId ? { deploymentId: plan.deploymentId } : {}),
      ...(plan ? { stateMachineAddress: plan.stateMachineAddress } : {}),
      ...(plan && plan.registeredAt.blockNumber !== undefined && Number(plan.registeredAt.blockNumber) > 0
        ? { registeredAtBlock: Number(plan.registeredAt.blockNumber) }
        : {})
    },
    ...(chainViewBlock ? { chain: chainViewBlock } : {}),
    ...(chainReadFailed ? { chainReadFailed: true } : {}),
    verifiedAt: options.now().toISOString()
  };
}

export function anchorVerificationAllowsPublish(verification: StoreAnchorVerificationDTO): boolean {
  // 链直读是第二证据源：配置了但读失败时不得公开（fail-closed）。
  return verification.status === "consistent" && verification.chainReadFailed !== true;
}
