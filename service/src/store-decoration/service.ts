import { randomUUID } from "node:crypto";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import {
  InMemoryStorePublisherDelegationStore,
  InMemoryStoreZhixuDecorationStore
} from "./memory-store.js";
import type {
  StoreDecorationActor,
  StorePublisherDelegationRecord,
  StorePublisherDelegationStore,
  StoreZhixuDecorationData,
  StoreZhixuDecorationStore,
  StoreZhixuDecorationVersionRecord
} from "./types.js";
import { StoreDecorationServiceError } from "./types.js";
import { validateStoreDecorationData } from "./validate.js";

export interface StoreDecorationServiceOptions {
  readonly projectionStore: ProjectionStore;
  readonly decorationStore?: StoreZhixuDecorationStore;
  readonly delegationStore?: StorePublisherDelegationStore;
  readonly now?: () => Date;
  readonly audit?: (event: StoreDecorationAuditEvent) => Promise<void> | void;
}

export interface StoreDecorationAuditEvent {
  readonly action: "decoration.saved" | "decoration.restored" | "delegation.granted" | "delegation.revoked";
  readonly planId?: Hex;
  readonly publisherAddress?: Address;
  readonly memberAddress?: Address;
  readonly actorAddress: Address;
  readonly outcome: "succeeded" | "blocked";
  readonly version?: number;
  readonly errorCode?: string;
  readonly createdAt: string;
}

export interface StoreDecorationView {
  readonly planId: Hex;
  readonly current?: StoreZhixuDecorationVersionRecord;
  readonly versions: readonly StoreZhixuDecorationVersionRecord[];
}

export interface StoreDecorationPermissionView {
  readonly planId: Hex;
  readonly publisher?: Address;
  readonly viewerIsPublisher: boolean;
  readonly viewerActiveDelegations: readonly StorePublisherDelegationRecord[];
}

export interface StoreDecorationService {
  getDecoration(planIdRaw: string): Promise<StoreDecorationView>;
  saveDecoration(planIdRaw: string, input: unknown, actor: StoreDecorationActor, note?: string): Promise<StoreDecorationView>;
  restoreVersion(planIdRaw: string, version: number, actor: StoreDecorationActor, note?: string): Promise<StoreDecorationView>;
  getPermissionView(planIdRaw: string, viewerAddress?: Address): Promise<StoreDecorationPermissionView>;
  listDelegations(publisherAddressRaw: string, actor: StoreDecorationActor): Promise<readonly StorePublisherDelegationRecord[]>;
  grantDelegation(input: unknown, actor: StoreDecorationActor): Promise<readonly StorePublisherDelegationRecord[]>;
  revokeDelegation(delegationId: string, input: unknown, actor: StoreDecorationActor): Promise<readonly StorePublisherDelegationRecord[]>;
  /** 供加入域复用：地址对该 plan 是否有装修/审核权（publisher 或受托）。 */
  hasPublisherWriteAccess(planId: Hex, address: Address): Promise<boolean>;
  resolvePlanPublisher(planIdRaw: string): Promise<{ readonly planId: Hex; readonly publisher?: Address }>;
}

export function createStoreDecorationService(options: StoreDecorationServiceOptions): StoreDecorationService {
  const projectionStore = options.projectionStore;
  const decorationStore = options.decorationStore ?? new InMemoryStoreZhixuDecorationStore();
  const delegationStore = options.delegationStore ?? new InMemoryStorePublisherDelegationStore();
  const now = options.now ?? (() => new Date());

  return {
    async getDecoration(planIdRaw) {
      const planId = normalizePlanId(planIdRaw);
      return decorationView(planId, await decorationStore.listVersions(planId));
    },

    async saveDecoration(planIdRaw, input, actor, note) {
      const planId = normalizePlanId(planIdRaw);
      await assertCanWriteDecoration(planId, actor, "decoration.saved");
      const data = validateStoreDecorationData(input);
      const versions = await decorationStore.listVersions(planId);
      const record: StoreZhixuDecorationVersionRecord = {
        decorationId: `decor_${randomUUID()}`,
        planId,
        version: versions.length + 1,
        data,
        authorAddress: actor.anchoredAddress,
        ...(actor.accountId ? { authorAccountId: actor.accountId } : {}),
        ...(note?.trim() ? { note: note.trim() } : {}),
        createdAt: now().toISOString()
      };
      try {
        await decorationStore.appendVersion(record);
      } catch {
        // UNIQUE(plan_id, version) 冲突（并发保存）映射为可读的 409。
        throw new StoreDecorationServiceError(409, "decoration_version_conflict", "concurrent decoration save detected; retry");
      }
      await emitAudit({
        action: "decoration.saved",
        planId,
        actorAddress: actor.anchoredAddress,
        outcome: "succeeded",
        version: record.version,
        createdAt: now().toISOString()
      });
      return decorationView(planId, await decorationStore.listVersions(planId));
    },

    async restoreVersion(planIdRaw, version, actor, note) {
      const planId = normalizePlanId(planIdRaw);
      await assertCanWriteDecoration(planId, actor, "decoration.restored");
      const versions = await decorationStore.listVersions(planId);
      const source = versions.find((record) => record.version === version);
      if (!source) {
        throw new StoreDecorationServiceError(404, "decoration_version_not_found", `decoration version ${version} not found`);
      }
      const record: StoreZhixuDecorationVersionRecord = {
        decorationId: `decor_${randomUUID()}`,
        planId,
        version: versions.length + 1,
        data: source.data,
        authorAddress: actor.anchoredAddress,
        ...(actor.accountId ? { authorAccountId: actor.accountId } : {}),
        note: note?.trim() ? note.trim() : `restored from version ${version}`,
        createdAt: now().toISOString()
      };
      await decorationStore.appendVersion(record);
      await emitAudit({
        action: "decoration.restored",
        planId,
        actorAddress: actor.anchoredAddress,
        outcome: "succeeded",
        version: record.version,
        createdAt: now().toISOString()
      });
      return decorationView(planId, await decorationStore.listVersions(planId));
    },

    async getPermissionView(planIdRaw, viewerAddress) {
      const planId = normalizePlanId(planIdRaw);
      const { publisher } = await resolvePlanPublisher(planId);
      const delegations = viewerAddress
        ? (await delegationStore.listDelegationsForMember(viewerAddress)).filter((record) => !record.revokedAt && publisher && record.publisherAddress.toLowerCase() === publisher.toLowerCase())
        : [];
      return {
        planId,
        ...(publisher ? { publisher } : {}),
        viewerIsPublisher: Boolean(
          viewerAddress && publisher && viewerAddress.toLowerCase() === publisher.toLowerCase()
        ),
        viewerActiveDelegations: delegations
      };
    },

    async listDelegations(publisherAddressRaw, actor) {
      const publisherAddress = normalizeAddress(publisherAddressRaw, "publisherAddress");
      assertPublisherSelf(actor, publisherAddress);
      return delegationStore.listDelegations(publisherAddress);
    },

    async grantDelegation(input, actor) {
      const record = requireBodyRecord(input);
      const publisherAddress = normalizeAddress(requiredString(record, "publisherAddress"), "publisherAddress");
      const memberAddress = normalizeAddress(requiredString(record, "memberAddress"), "memberAddress");
      assertPublisherSelf(actor, publisherAddress);
      if (memberAddress.toLowerCase() === publisherAddress.toLowerCase()) {
        throw new StoreDecorationServiceError(400, "invalid_delegation", "publisher cannot delegate to themselves");
      }
      const existing = await delegationStore.findActiveDelegation(publisherAddress, memberAddress);
      if (existing) {
        throw new StoreDecorationServiceError(409, "delegation_exists", "an active delegation already exists for this member");
      }
      const delegation: StorePublisherDelegationRecord = {
        delegationId: `deleg_${randomUUID()}`,
        publisherAddress,
        memberAddress,
        grantedByAddress: actor.anchoredAddress,
        ...(actor.accountId ? { grantedByAccountId: actor.accountId } : {}),
        grantedAt: now().toISOString()
      };
      await delegationStore.appendDelegation(delegation);
      await emitAudit({
        action: "delegation.granted",
        publisherAddress,
        memberAddress,
        actorAddress: actor.anchoredAddress,
        outcome: "succeeded",
        createdAt: now().toISOString()
      });
      return delegationStore.listDelegations(publisherAddress);
    },

    async revokeDelegation(delegationId, input, actor) {
      const record = requireBodyRecord(input);
      const reason = optionalString(record, "reason");
      const delegations = [...await delegationStore.listDelegations(actor.anchoredAddress)];
      const target = delegations.find((entry) => entry.delegationId === delegationId && !entry.revokedAt);
      if (!target) {
        throw new StoreDecorationServiceError(404, "delegation_not_found", "active delegation not found for this publisher");
      }
      const revoked: StorePublisherDelegationRecord = {
        ...target,
        revokedAt: now().toISOString(),
        revokedByAddress: actor.anchoredAddress,
        ...(reason ? { reason } : {})
      };
      await delegationStore.updateDelegation(revoked);
      await emitAudit({
        action: "delegation.revoked",
        publisherAddress: target.publisherAddress,
        memberAddress: target.memberAddress,
        actorAddress: actor.anchoredAddress,
        outcome: "succeeded",
        createdAt: now().toISOString()
      });
      return delegationStore.listDelegations(target.publisherAddress);
    },

    async hasPublisherWriteAccess(planId, address) {
      const { publisher } = await resolvePlanPublisher(planId);
      if (!publisher) {
        return false;
      }
      if (publisher.toLowerCase() === address.toLowerCase()) {
        return true;
      }
      return Boolean(await delegationStore.findActiveDelegation(publisher, address));
    },

    async resolvePlanPublisher(planIdRaw) {
      const planId = normalizePlanId(planIdRaw);
      return resolvePlanPublisher(planId);
    }
  };

  async function resolvePlanPublisher(planId: Hex): Promise<{ readonly planId: Hex; readonly publisher?: Address }> {
    const plan = await findPlanByPlanId(planId);
    if (!plan) {
      throw new StoreDecorationServiceError(404, "plan_not_found", "plan is not present in the chain projection");
    }
    return { planId, ...(plan.publisher ? { publisher: plan.publisher } : {}) };
  }

  async function findPlanByPlanId(planId: Hex): Promise<{ readonly planId: Hex; readonly publisher?: Address } | undefined> {
    // 投影以 chainId:contract:planId 为键；按 planId 值匹配（大小写不敏感）。
    const snapshot = await projectionStore.getOrderSnapshot();
    return Object.values(snapshot.stateMachinePlans)
      .find((plan) => plan.planId.toLowerCase() === planId.toLowerCase());
  }

  async function assertCanWriteDecoration(
    planId: Hex,
    actor: StoreDecorationActor,
    action: StoreDecorationAuditEvent["action"]
  ): Promise<void> {
    const allowed = await (async () => {
      const { publisher } = await resolvePlanPublisher(planId);
      if (!publisher) {
        return false;
      }
      if (publisher.toLowerCase() === actor.anchoredAddress.toLowerCase()) {
        return true;
      }
      return Boolean(await delegationStore.findActiveDelegation(publisher, actor.anchoredAddress));
    })();
    if (!allowed) {
      await emitAudit({
        action,
        planId,
        actorAddress: actor.anchoredAddress,
        outcome: "blocked",
        errorCode: "not_plan_publisher",
        createdAt: now().toISOString()
      });
      throw new StoreDecorationServiceError(
        403,
        "not_plan_publisher",
        "only the plan publisher (or an active delegate) can modify decoration data",
        { planId }
      );
    }
  }

  function assertPublisherSelf(actor: StoreDecorationActor, publisherAddress: Address): void {
    if (actor.anchoredAddress.toLowerCase() !== publisherAddress.toLowerCase()) {
      throw new StoreDecorationServiceError(
        403,
        "not_plan_publisher",
        "delegations are managed by the publisher address itself",
        { publisherAddress }
      );
    }
  }

  async function emitAudit(event: StoreDecorationAuditEvent): Promise<void> {
    if (options.audit) {
      await options.audit(event);
    }
  }
}

function decorationView(planId: Hex, versions: readonly StoreZhixuDecorationVersionRecord[]): StoreDecorationView {
  const current = versions.length > 0 ? versions[versions.length - 1] : undefined;
  return {
    planId,
    ...(current ? { current } : {}),
    versions
  };
}

export function normalizePlanId(planIdRaw: string): Hex {
  try {
    return normalizeBytes32(planIdRaw.trim(), "planId");
  } catch (error) {
    throw new StoreDecorationServiceError(400, "invalid_plan_id", "planId must be a bytes32 hex value");
  }
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new StoreDecorationServiceError(400, "invalid_body", "request body must be a JSON object");
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = optionalString(record, field);
  if (!value) {
    throw new StoreDecorationServiceError(400, "invalid_body", `${field} must be a non-empty string`);
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
    throw new StoreDecorationServiceError(400, "invalid_body", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
