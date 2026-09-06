import { filterActiveChainEvents, type ChainEvent } from "./events.js";
import {
  ProjectionError,
  normalizeAddress,
  normalizeBytes32,
  type Address,
  type ChainPointer,
  type Hex,
} from "../shared/types.js";

export interface IdentityProjectionProvenance {
  readonly chainId: number;
  readonly contractAddress: Address;
  readonly blockNumber: bigint;
  readonly transactionIndex?: number;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface IdentityBindingProjection {
  readonly registryAddress: Address;
  readonly bindingId: Hex;
  readonly subjectId: Hex;
  readonly account: Address;
  readonly descriptorHash: Hex;
  readonly descriptorURI: string;
  readonly registrar: Address;
  readonly status: "active" | "revoked";
  readonly registeredAt: IdentityProjectionProvenance;
  readonly updatedAt: IdentityProjectionProvenance;
  readonly revokeReasonHash?: Hex;
  readonly revokeReasonURI?: string;
  readonly revokedAt?: IdentityProjectionProvenance;
}

export interface IdentityProjectionSnapshot {
  readonly rebuildable: true;
  readonly eventCount: number;
  readonly bindings: Readonly<Record<string, IdentityBindingProjection>>;
  readonly lastEvent?: IdentityProjectionProvenance;
}

export interface IdentityBindingQuery {
  readonly registryAddress?: string;
  readonly bindingId?: string;
  readonly subjectId?: string;
  readonly account?: string;
  readonly activeOnly?: boolean;
}

type Mutable<TValue> = {
  -readonly [TKey in keyof TValue]: TValue[TKey];
};

export function createEmptyIdentityProjectionSnapshot(): IdentityProjectionSnapshot {
  return {
    rebuildable: true,
    eventCount: 0,
    bindings: {},
  };
}

export function rebuildIdentityProjections(
  events: readonly ChainEvent[],
): IdentityProjectionSnapshot {
  const bindings = new Map<string, Mutable<IdentityBindingProjection>>();
  let eventCount = 0;
  let lastEvent: IdentityProjectionProvenance | undefined;

  for (const event of filterActiveChainEvents(events)) {
    if (event.eventName === "IdentityBindingRegistered") {
      applyIdentityBindingRegistered(bindings, event);
    } else if (event.eventName === "IdentityBindingRevoked") {
      applyIdentityBindingRevoked(bindings, event);
    } else {
      continue;
    }
    eventCount += 1;
    lastEvent = provenanceOf(event);
  }

  return {
    rebuildable: true,
    eventCount,
    bindings: Object.fromEntries(bindings),
    ...(lastEvent ? { lastEvent } : {}),
  };
}

export function filterIdentityBindings(
  snapshot: IdentityProjectionSnapshot,
  query: IdentityBindingQuery,
): readonly IdentityBindingProjection[] {
  const registryAddress = query.registryAddress
    ? normalizeAddress(query.registryAddress, "registryAddress")
    : undefined;
  const bindingId = query.bindingId
    ? normalizeBytes32(query.bindingId, "bindingId")
    : undefined;
  const subjectId = query.subjectId
    ? normalizeBytes32(query.subjectId, "subjectId")
    : undefined;
  const account = query.account
    ? normalizeAddress(query.account, "account")
    : undefined;

  return Object.values(snapshot.bindings).filter(
    (binding) =>
      (!registryAddress || binding.registryAddress === registryAddress) &&
      (!bindingId || binding.bindingId === bindingId) &&
      (!subjectId || binding.subjectId === subjectId) &&
      (!account || binding.account === account) &&
      (!query.activeOnly || binding.status === "active"),
  );
}

function applyIdentityBindingRegistered(
  bindings: Map<string, Mutable<IdentityBindingProjection>>,
  event: ChainEvent,
): void {
  const registryAddress = normalizeAddress(
    event.contractAddress,
    "IdentityBindingRegistered.contractAddress",
  );
  const bindingId = requiredBytes32Arg(event, "bindingId");
  const provenance = provenanceOf(event);
  bindings.set(identityKey(event.chainId, registryAddress, bindingId), {
    registryAddress,
    bindingId,
    subjectId: requiredBytes32Arg(event, "subjectId"),
    account: requiredAddressArg(event, "account"),
    descriptorHash: requiredBytes32Arg(event, "descriptorHash"),
    descriptorURI: optionalStringArg(event, "descriptorURI") ?? "",
    registrar: requiredAddressArg(event, "registrar"),
    status: "active",
    registeredAt: provenance,
    updatedAt: provenance,
  });
}

function applyIdentityBindingRevoked(
  bindings: Map<string, Mutable<IdentityBindingProjection>>,
  event: ChainEvent,
): void {
  const registryAddress = normalizeAddress(
    event.contractAddress,
    "IdentityBindingRevoked.contractAddress",
  );
  const bindingId = requiredBytes32Arg(event, "bindingId");
  const binding = bindings.get(
    identityKey(event.chainId, registryAddress, bindingId),
  );
  if (!binding) return;

  const provenance = provenanceOf(event);
  binding.status = "revoked";
  binding.revokeReasonHash = requiredBytes32Arg(event, "reasonHash");
  binding.revokeReasonURI = optionalStringArg(event, "reasonURI") ?? "";
  binding.revokedAt = provenance;
  binding.updatedAt = provenance;
}

function identityKey(
  chainId: number,
  registryAddress: Address,
  bindingId: Hex,
): string {
  return `${chainId}:${registryAddress.toLowerCase()}:${bindingId}`;
}

function provenanceOf(pointer: ChainPointer): IdentityProjectionProvenance {
  return {
    chainId: pointer.chainId,
    contractAddress: pointer.contractAddress,
    blockNumber: pointer.blockNumber,
    ...(pointer.transactionIndex !== undefined
      ? { transactionIndex: pointer.transactionIndex }
      : {}),
    transactionHash: pointer.transactionHash,
    logIndex: pointer.logIndex,
  };
}

function requiredStringArg(event: ChainEvent, name: string): string {
  const value = event.args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectionError(
      `${event.eventName}.${name} must be a non-empty string`,
    );
  }
  return value;
}

function optionalStringArg(event: ChainEvent, name: string): string | undefined {
  const value = event.args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredBytes32Arg(event: ChainEvent, name: string): Hex {
  return normalizeBytes32(
    requiredStringArg(event, name),
    `${event.eventName}.${name}`,
  );
}

function requiredAddressArg(event: ChainEvent, name: string): Address {
  return normalizeAddress(
    requiredStringArg(event, name),
    `${event.eventName}.${name}`,
  );
}
