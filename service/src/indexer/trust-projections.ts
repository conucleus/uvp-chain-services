import { filterActiveChainEvents, type ChainEvent } from "./events.js";
import {
  ProjectionError,
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type ChainPointer,
  type Hex
} from "../shared/types.js";

export interface TrustProjectionProvenance {
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface TrustDomainProjection {
  readonly domainId: Hex;
  readonly owner: Address;
  readonly metadataHash: Hex;
  readonly metadataURI: string;
  readonly registeredAt: TrustProjectionProvenance;
  readonly updatedAt: TrustProjectionProvenance;
}

export interface PlanTrustProjection {
  readonly domainId: Hex;
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly artifactHash: Hex;
  readonly policyHash: Hex;
  readonly metadataHash: Hex;
  readonly metadataURI: string;
  readonly attester: Address;
  readonly status: "attested" | "revoked";
  readonly revoked: boolean;
  readonly attestedAt: TrustProjectionProvenance;
  readonly updatedAt: TrustProjectionProvenance;
  readonly revokeReasonHash?: Hex;
  readonly revokeReasonURI?: string;
  readonly revokedAt?: TrustProjectionProvenance;
}

export interface SupplierTrustProjection {
  readonly domainId: Hex;
  readonly supplierSubjectId: Hex;
  readonly wallet: Address;
  readonly profileHash: Hex;
  readonly capabilityHash: Hex;
  readonly reputationHash: Hex;
  readonly metadataURI: string;
  readonly attester: Address;
  readonly status: "attested" | "revoked";
  readonly revoked: boolean;
  readonly attestedAt: TrustProjectionProvenance;
  readonly updatedAt: TrustProjectionProvenance;
  readonly revokeReasonHash?: Hex;
  readonly revokeReasonURI?: string;
  readonly revokedAt?: TrustProjectionProvenance;
}

export interface TrustProjectionSnapshot {
  readonly rebuildable: true;
  readonly eventCount: number;
  readonly domains: Readonly<Record<string, TrustDomainProjection>>;
  readonly plans: Readonly<Record<string, PlanTrustProjection>>;
  readonly suppliers: Readonly<Record<string, SupplierTrustProjection>>;
  readonly lastEvent?: TrustProjectionProvenance;
}

export interface PlanTrustQuery {
  readonly domainId?: string;
  readonly planId?: string;
  readonly planHash?: string;
}

export interface SupplierTrustQuery {
  readonly domainId?: string;
  readonly supplierSubjectId?: string;
  readonly wallet?: string;
}

type Mutable<TValue> = {
  -readonly [TKey in keyof TValue]: TValue[TKey];
};

export function createEmptyTrustProjectionSnapshot(): TrustProjectionSnapshot {
  return {
    rebuildable: true,
    eventCount: 0,
    domains: {},
    plans: {},
    suppliers: {}
  };
}

export function rebuildTrustProjections(events: readonly ChainEvent[]): TrustProjectionSnapshot {
  const domains = new Map<string, Mutable<TrustDomainProjection>>();
  const plans = new Map<string, Mutable<PlanTrustProjection>>();
  const suppliers = new Map<string, Mutable<SupplierTrustProjection>>();
  let eventCount = 0;
  let lastEvent: TrustProjectionProvenance | undefined;

  for (const event of filterActiveChainEvents(events)) {
    const applied = applyTrustEvent({ domains, plans, suppliers }, event);
    if (applied) {
      eventCount += 1;
      lastEvent = provenanceOf(event);
    }
  }

  return {
    rebuildable: true,
    eventCount,
    domains: Object.fromEntries(domains),
    plans: Object.fromEntries(plans),
    suppliers: Object.fromEntries(suppliers),
    ...(lastEvent ? { lastEvent } : {})
  };
}

export function filterPlanTrust(
  snapshot: TrustProjectionSnapshot,
  query: PlanTrustQuery
): readonly PlanTrustProjection[] {
  const domainId = query.domainId ? normalizeBytes32(query.domainId, "domainId") : undefined;
  const planId = query.planId ? normalizeBytes32(query.planId, "planId") : undefined;
  const planHash = query.planHash ? normalizeBytes32(query.planHash, "planHash") : undefined;

  return Object.values(snapshot.plans).filter((item) =>
    (!domainId || item.domainId === domainId) &&
    (!planId || item.planId === planId) &&
    (!planHash || item.planHash === planHash)
  );
}

export function filterSupplierTrust(
  snapshot: TrustProjectionSnapshot,
  query: SupplierTrustQuery
): readonly SupplierTrustProjection[] {
  const domainId = query.domainId ? normalizeBytes32(query.domainId, "domainId") : undefined;
  const supplierSubjectId = query.supplierSubjectId
    ? normalizeBytes32(query.supplierSubjectId, "supplierSubjectId")
    : undefined;
  const wallet = query.wallet ? normalizeAddress(query.wallet, "wallet") : undefined;

  return Object.values(snapshot.suppliers).filter((item) =>
    (!domainId || item.domainId === domainId) &&
    (!supplierSubjectId || item.supplierSubjectId === supplierSubjectId) &&
    (!wallet || item.wallet === wallet)
  );
}

function applyTrustEvent(
  state: {
    domains: Map<string, Mutable<TrustDomainProjection>>;
    plans: Map<string, Mutable<PlanTrustProjection>>;
    suppliers: Map<string, Mutable<SupplierTrustProjection>>;
  },
  event: ChainEvent
): boolean {
  switch (event.eventName) {
    case "DomainRegistered":
      applyDomainRegistered(state.domains, event);
      return true;
    case "DomainUpdated":
      applyDomainUpdated(state.domains, event);
      return true;
    case "DomainOwnerTransferred":
      applyDomainOwnerTransferred(state.domains, event);
      return true;
    case "PlanAttested":
      applyPlanAttested(state.plans, event);
      return true;
    case "PlanRevoked":
      applyPlanRevoked(state.plans, event);
      return true;
    case "SupplierAttested":
      applySupplierAttested(state.suppliers, event);
      return true;
    case "SupplierRevoked":
      applySupplierRevoked(state.suppliers, event);
      return true;
    default:
      return false;
  }
}

function applyDomainRegistered(domains: Map<string, Mutable<TrustDomainProjection>>, event: ChainEvent): void {
  const domainId = requiredBytes32Arg(event, "domainId");
  domains.set(domainId, {
    domainId,
    owner: requiredAddressArg(event, "owner"),
    metadataHash: requiredBytes32Arg(event, "metadataHash"),
    metadataURI: optionalStringArg(event, "metadataURI") ?? "",
    registeredAt: provenanceOf(event),
    updatedAt: provenanceOf(event)
  });
}

function applyDomainUpdated(domains: Map<string, Mutable<TrustDomainProjection>>, event: ChainEvent): void {
  const domainId = requiredBytes32Arg(event, "domainId");
  const domain = domains.get(domainId);
  if (!domain) {
    return;
  }
  domain.metadataHash = requiredBytes32Arg(event, "metadataHash");
  domain.metadataURI = optionalStringArg(event, "metadataURI") ?? "";
  domain.updatedAt = provenanceOf(event);
}

function applyDomainOwnerTransferred(domains: Map<string, Mutable<TrustDomainProjection>>, event: ChainEvent): void {
  const domainId = requiredBytes32Arg(event, "domainId");
  const domain = domains.get(domainId);
  if (!domain) {
    return;
  }
  domain.owner = requiredAddressArg(event, "newOwner");
  domain.updatedAt = provenanceOf(event);
}

function applyPlanAttested(plans: Map<string, Mutable<PlanTrustProjection>>, event: ChainEvent): void {
  const domainId = requiredBytes32Arg(event, "domainId");
  const planId = requiredBytes32Arg(event, "planId");
  const key = trustKey(domainId, planId);
  plans.set(key, {
    domainId,
    planId,
    planHash: requiredBytes32Arg(event, "planHash"),
    artifactHash: requiredBytes32Arg(event, "artifactHash"),
    policyHash: requiredBytes32Arg(event, "policyHash"),
    metadataHash: requiredBytes32Arg(event, "metadataHash"),
    metadataURI: optionalStringArg(event, "metadataURI") ?? "",
    attester: requiredAddressArg(event, "attester"),
    status: "attested",
    revoked: false,
    attestedAt: provenanceOf(event),
    updatedAt: provenanceOf(event)
  });
}

function applyPlanRevoked(plans: Map<string, Mutable<PlanTrustProjection>>, event: ChainEvent): void {
  const domainId = requiredBytes32Arg(event, "domainId");
  const planId = requiredBytes32Arg(event, "planId");
  const plan = plans.get(trustKey(domainId, planId));
  if (!plan) {
    return;
  }
  plan.status = "revoked";
  plan.revoked = true;
  plan.revokeReasonHash = requiredBytes32Arg(event, "reasonHash");
  plan.revokeReasonURI = optionalStringArg(event, "reasonURI") ?? "";
  plan.revokedAt = provenanceOf(event);
  plan.updatedAt = provenanceOf(event);
}

function applySupplierAttested(suppliers: Map<string, Mutable<SupplierTrustProjection>>, event: ChainEvent): void {
  const domainId = requiredBytes32Arg(event, "domainId");
  const supplierSubjectId = requiredBytes32Arg(event, "supplierSubjectId");
  suppliers.set(trustKey(domainId, supplierSubjectId), {
    domainId,
    supplierSubjectId,
    wallet: requiredAddressArg(event, "wallet"),
    profileHash: requiredBytes32Arg(event, "profileHash"),
    capabilityHash: requiredBytes32Arg(event, "capabilityHash"),
    reputationHash: requiredBytes32Arg(event, "reputationHash"),
    metadataURI: optionalStringArg(event, "metadataURI") ?? "",
    attester: requiredAddressArg(event, "attester"),
    status: "attested",
    revoked: false,
    attestedAt: provenanceOf(event),
    updatedAt: provenanceOf(event)
  });
}

function applySupplierRevoked(suppliers: Map<string, Mutable<SupplierTrustProjection>>, event: ChainEvent): void {
  const domainId = requiredBytes32Arg(event, "domainId");
  const supplierSubjectId = requiredBytes32Arg(event, "supplierSubjectId");
  const supplier = suppliers.get(trustKey(domainId, supplierSubjectId));
  if (!supplier) {
    return;
  }
  supplier.status = "revoked";
  supplier.revoked = true;
  supplier.revokeReasonHash = requiredBytes32Arg(event, "reasonHash");
  supplier.revokeReasonURI = optionalStringArg(event, "reasonURI") ?? "";
  supplier.revokedAt = provenanceOf(event);
  supplier.updatedAt = provenanceOf(event);
}

function trustKey(domainId: Hex, subjectId: Hex): string {
  return `${domainId}:${subjectId}`;
}

function provenanceOf(pointer: ChainPointer): TrustProjectionProvenance {
  return {
    chainId: pointer.chainId,
    contractAddress: pointer.contractAddress,
    blockNumber: pointer.blockNumber,
    transactionHash: pointer.transactionHash,
    logIndex: pointer.logIndex
  };
}

function requiredStringArg(event: ChainEvent, name: string): string {
  const value = event.args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectionError(`${event.eventName}.${name} must be a non-empty string`);
  }
  return value;
}

function optionalStringArg(event: ChainEvent, name: string): string | undefined {
  const value = event.args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredBytes32Arg(event: ChainEvent, name: string): Hex {
  return normalizeBytes32(requiredStringArg(event, name), `${event.eventName}.${name}`);
}

function requiredAddressArg(event: ChainEvent, name: string): Address {
  return normalizeAddress(requiredStringArg(event, name), `${event.eventName}.${name}`);
}
