import { randomUUID } from "node:crypto";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type { StateMachinePlanProjection } from "../indexer/projections.js";
import { InMemoryStoreListingStore } from "./memory-store.js";
import type {
  ListingAnchorChainView,
  StoreAnchorVerificationDTO,
  StoreListingActor,
  StoreListingRecord,
  StoreListingStore,
  StoreListingStatus
} from "./types.js";
import { StoreListingServiceError } from "./types.js";
import { anchorVerificationAllowsPublish, verifyListingAnchors } from "./verify.js";

export interface StoreListingServiceOptions {
  readonly projectionStore: ProjectionStore;
  readonly listingStore?: StoreListingStore;
  readonly chainView?: ListingAnchorChainView;
  readonly now?: () => Date;
  readonly audit?: (event: StoreListingAuditEvent) => Promise<void> | void;
}

export interface StoreListingAuditEvent {
  readonly action: "listing.imported" | "listing.reviewed" | "listing.delisted" | "listing.relisted";
  readonly listingId: string;
  readonly planId: Hex;
  readonly actorAddress?: Address;
  readonly outcome: "succeeded" | "blocked";
  readonly errorCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface StoreListingDetailDTO {
  readonly listing: StoreListingRecord;
  readonly anchorVerification: StoreAnchorVerificationDTO;
}

export interface StoreListingService {
  importListing(input: unknown, actor: StoreListingActor): Promise<StoreListingDetailDTO>;
  getListing(listingId: string): Promise<StoreListingDetailDTO>;
  findListingByPlanId(planIdRaw: string): Promise<StoreListingDetailDTO | undefined>;
  listListings(status?: StoreListingStatus): Promise<readonly StoreListingRecord[]>;
  verifyListing(listingId: string): Promise<StoreAnchorVerificationDTO>;
  reviewListing(listingId: string, input: unknown, actor: StoreListingActor): Promise<StoreListingDetailDTO>;
  delistListing(listingId: string, input: unknown, actor: StoreListingActor): Promise<StoreListingDetailDTO>;
  relistListing(listingId: string, actor: StoreListingActor): Promise<StoreListingDetailDTO>;
}

const OPERATOR_LEVELS = new Set(["store_operator", "store_admin"]);

export function createStoreListingService(options: StoreListingServiceOptions): StoreListingService {
  const projectionStore = options.projectionStore;
  const listingStore = options.listingStore ?? new InMemoryStoreListingStore();
  const now = options.now ?? (() => new Date());

  return {
    async importListing(input, actor) {
      const record = requireBodyRecord(input);
      const planId = normalizePlanIdField(record);
      const planHashClaimed = optionalBytes32(record, "planHash");
      const deploymentIdClaimed = optionalBytes32(record, "deploymentId");
      const stateMachineAddressClaimed = optionalAddress(record, "stateMachineAddress");
      const plan = await findPlanByPlanId(planId);
      if (!plan && !planHashClaimed) {
        throw new StoreListingServiceError(
          409,
          "plan_not_projected",
          "planId is not present in the chain projection; planHash must be claimed explicitly so the listing can be verified once indexed",
          { planId }
        );
      }

      const existing = await listingStore.findListingByPlanId(planId);
      if (existing) {
        throw new StoreListingServiceError(409, "listing_exists", "a listing already exists for this planId", {
          listingId: existing.listingId,
          status: existing.status
        });
      }

      const actorIsOperator = OPERATOR_LEVELS.has(actor.accessLevel);
      if (!actorIsOperator) {
        // 非运营方导入：只允许该 plan 的 publisher 自导入（导入自己的秩序）。
        const publisher = plan?.publisher;
        if (!actor.anchoredAddress || !publisher || actor.anchoredAddress.toLowerCase() !== publisher.toLowerCase()) {
          throw new StoreListingServiceError(
            403,
            "listing_import_not_allowed",
            "only store operators or the plan publisher can import a listing"
          );
        }
      }

      const timestamp = now().toISOString();
      const listing: StoreListingRecord = {
        listingId: `listing_${randomUUID()}`,
        planId,
        ...(planHashClaimed ? { planHashClaimed } : plan ? { planHashClaimed: plan.planHash } : {}),
        ...(deploymentIdClaimed ? { deploymentIdClaimed } : {}),
        ...(stateMachineAddressClaimed ? { stateMachineAddressClaimed } : {}),
        status: "imported",
        ...(actor.anchoredAddress ? { importedByAddress: actor.anchoredAddress } : {}),
        ...(actor.accountId ? { importedByAccountId: actor.accountId } : {}),
        importedAt: timestamp,
        updatedAt: timestamp
      };
      await listingStore.putListing(listing);
      await emitAudit({
        action: "listing.imported",
        listingId: listing.listingId,
        planId,
        ...(actor.anchoredAddress ? { actorAddress: actor.anchoredAddress } : {}),
        outcome: "succeeded",
        createdAt: timestamp
      });
      return this.getListing(listing.listingId);
    },

    async getListing(listingId) {
      const listing = await requireListing(listingId);
      return {
        listing,
        anchorVerification: await verifyListingAnchors({
          listing,
          projectionStore,
          ...(options.chainView ? { chainView: options.chainView } : {}),
          now
        })
      };
    },

    async findListingByPlanId(planIdRaw) {
      const planId = normalizePlanIdValue(planIdRaw);
      const listing = await listingStore.findListingByPlanId(planId);
      if (!listing) {
        return undefined;
      }
      return this.getListing(listing.listingId);
    },

    async listListings(status) {
      return listingStore.listListings(status);
    },

    async verifyListing(listingId) {
      const listing = await requireListing(listingId);
      return verifyListingAnchors({
        listing,
        projectionStore,
        ...(options.chainView ? { chainView: options.chainView } : {}),
        now
      });
    },

    async reviewListing(listingId, input, actor) {
      const listing = await requireListing(listingId);
      assertOperator(actor, "store.listing.manage");
      const record = requireBodyRecord(input);
      const decision = requiredString(record, "decision");
      const note = optionalString(record, "note");
      if (decision !== "approve" && decision !== "reject") {
        throw new StoreListingServiceError(400, "invalid_body", "decision must be approve or reject");
      }
      if (listing.status !== "imported" && listing.status !== "rejected") {
        throw new StoreListingServiceError(409, "invalid_listing_transition", `${listing.status} listing cannot be reviewed`);
      }
      if (decision === "approve") {
        // 上架审核（章程 §3 目标 D）：版本、锚核验通过才可公开。
        const verification = await verifyListingAnchors({
          listing,
          projectionStore,
          ...(options.chainView ? { chainView: options.chainView } : {}),
          now
        });
        if (!anchorVerificationAllowsPublish(verification)) {
          await emitAudit({
            action: "listing.reviewed",
            listingId,
            planId: listing.planId,
            ...(actor.anchoredAddress ? { actorAddress: actor.anchoredAddress } : {}),
            outcome: "blocked",
            errorCode: "anchor_verification_failed",
            metadata: { status: verification.status },
            createdAt: now().toISOString()
          });
          throw new StoreListingServiceError(
            409,
            "anchor_verification_failed",
            "anchor verification must be consistent before a listing can go public",
            { verificationStatus: verification.status, checks: verification.checks }
          );
        }
        const updated: StoreListingRecord = {
          ...listing,
          status: "public",
          ...(actor.anchoredAddress ? { reviewedByAddress: actor.anchoredAddress } : {}),
          reviewedAt: now().toISOString(),
          ...(note ? { reviewNote: note } : {}),
          updatedAt: now().toISOString()
        };
        await listingStore.putListing(updated);
        await emitAudit({
          action: "listing.reviewed",
          listingId,
          planId: listing.planId,
          ...(actor.anchoredAddress ? { actorAddress: actor.anchoredAddress } : {}),
          outcome: "succeeded",
          metadata: { decision },
          createdAt: now().toISOString()
        });
      } else {
        const updated: StoreListingRecord = {
          ...listing,
          status: "rejected",
          ...(actor.anchoredAddress ? { reviewedByAddress: actor.anchoredAddress } : {}),
          reviewedAt: now().toISOString(),
          ...(note ? { reviewNote: note } : {}),
          updatedAt: now().toISOString()
        };
        await listingStore.putListing(updated);
        await emitAudit({
          action: "listing.reviewed",
          listingId,
          planId: listing.planId,
          ...(actor.anchoredAddress ? { actorAddress: actor.anchoredAddress } : {}),
          outcome: "succeeded",
          metadata: { decision },
          createdAt: now().toISOString()
        });
      }
      return this.getListing(listingId);
    },

    async delistListing(listingId, input, actor) {
      const listing = await requireListing(listingId);
      assertOperator(actor, "store.listing.manage");
      const record = requireBodyRecord(input);
      const reason = optionalString(record, "reason");
      if (listing.status !== "public") {
        throw new StoreListingServiceError(409, "invalid_listing_transition", `${listing.status} listing cannot be delisted`);
      }
      const updated: StoreListingRecord = {
        ...listing,
        status: "delisted",
        ...(reason ? { delistReason: reason } : {}),
        updatedAt: now().toISOString()
      };
      await listingStore.putListing(updated);
      await emitAudit({
        action: "listing.delisted",
        listingId,
        planId: listing.planId,
        ...(actor.anchoredAddress ? { actorAddress: actor.anchoredAddress } : {}),
        outcome: "succeeded",
        createdAt: now().toISOString()
      });
      return this.getListing(listingId);
    },

    async relistListing(listingId, actor) {
      const listing = await requireListing(listingId);
      assertOperator(actor, "store.listing.manage");
      if (listing.status !== "delisted") {
        throw new StoreListingServiceError(409, "invalid_listing_transition", `${listing.status} listing cannot be relisted`);
      }
      const verification = await verifyListingAnchors({
        listing,
        projectionStore,
        ...(options.chainView ? { chainView: options.chainView } : {}),
        now
      });
      if (!anchorVerificationAllowsPublish(verification)) {
        throw new StoreListingServiceError(
          409,
          "anchor_verification_failed",
          "anchor verification must be consistent before relisting",
          { verificationStatus: verification.status }
        );
      }
      const { delistReason: _clearedReason, ...listingWithoutReason } = listing;
      const updated: StoreListingRecord = {
        ...listingWithoutReason,
        status: "public",
        updatedAt: now().toISOString()
      };
      await listingStore.putListing(updated);
      await emitAudit({
        action: "listing.relisted",
        listingId,
        planId: listing.planId,
        ...(actor.anchoredAddress ? { actorAddress: actor.anchoredAddress } : {}),
        outcome: "succeeded",
        createdAt: now().toISOString()
      });
      return this.getListing(listingId);
    }
  };

  async function findPlanByPlanId(planId: Hex): Promise<StateMachinePlanProjection | undefined> {
    // 投影以 chainId:contract:planId 为键；按 planId 值匹配（大小写不敏感）。
    const snapshot = await projectionStore.getOrderSnapshot();
    return Object.values(snapshot.stateMachinePlans)
      .find((candidate) => candidate.planId.toLowerCase() === planId.toLowerCase());
  }

  async function requireListing(listingId: string): Promise<StoreListingRecord> {
    const listing = await listingStore.getListing(listingId);
    if (!listing) {
      throw new StoreListingServiceError(404, "listing_not_found", "listing not found");
    }
    return listing;
  }

  function assertOperator(actor: StoreListingActor, capability: string): void {
    if (!OPERATOR_LEVELS.has(actor.accessLevel)) {
      throw new StoreListingServiceError(
        403,
        "forbidden",
        "store operator access is required",
        { requiredCapability: capability }
      );
    }
  }

  async function emitAudit(event: StoreListingAuditEvent): Promise<void> {
    if (options.audit) {
      await options.audit(event);
    }
  }
}

export function normalizePlanIdValue(planIdRaw: string): Hex {
  try {
    return normalizeBytes32(planIdRaw.trim(), "planId");
  } catch {
    throw new StoreListingServiceError(400, "invalid_plan_id", "planId must be a bytes32 hex value");
  }
}

function normalizePlanIdField(record: Record<string, unknown>): Hex {
  const value = optionalString(record, "planId");
  if (!value) {
    throw new StoreListingServiceError(400, "invalid_body", "planId must be a non-empty string");
  }
  return normalizePlanIdValue(value);
}

function optionalBytes32(record: Record<string, unknown>, field: string): Hex | undefined {
  const value = optionalString(record, field);
  if (!value) {
    return undefined;
  }
  try {
    return normalizeBytes32(value, field);
  } catch {
    throw new StoreListingServiceError(400, "invalid_body", `${field} must be a bytes32 hex value`);
  }
}

function optionalAddress(record: Record<string, unknown>, field: string): Address | undefined {
  const value = optionalString(record, field);
  if (!value) {
    return undefined;
  }
  try {
    return normalizeAddress(value, field);
  } catch {
    throw new StoreListingServiceError(400, "invalid_body", `${field} must be an EVM address`);
  }
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new StoreListingServiceError(400, "invalid_body", "request body must be a JSON object");
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = optionalString(record, field);
  if (!value) {
    throw new StoreListingServiceError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new StoreListingServiceError(400, "invalid_body", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
