import { verifyMessage } from "viem";
import {
  hashGovernanceCanonicalJson,
  hashSupplierCapability,
  hashSupplierMetadata,
  hashSupplierProfile,
  hashSupplierReputation
} from "../governance/hashing.js";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import {
  parseSupplierNotificationProfile,
  type SupplierNotificationProfile
} from "./profile.js";

export class SupplierNotificationConfigError extends Error {
  override readonly name = "SupplierNotificationConfigError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface SupplierNotificationWalletProof {
  readonly message: string;
  readonly signature: Hex;
}

export interface SupplierNotificationProfileConfigRequest {
  readonly domainId: Hex;
  readonly supplierSubjectId: Hex;
  readonly wallet: Address;
  readonly notification: SupplierNotificationProfile;
  readonly profile?: unknown;
  readonly capability: unknown;
  readonly metadata: unknown;
  readonly reputation?: unknown;
  readonly notificationHash: Hex;
  readonly metadataHash: Hex;
  readonly profileHash: Hex;
  readonly capabilityHash: Hex;
  readonly reputationHash: Hex;
  readonly expectedMessage: string;
  readonly attestSupplierInput: SupplierNotificationAttestSupplierInput;
}

export interface SupplierNotificationAttestSupplierInput {
  readonly domainId: Hex;
  readonly supplierSubjectId: Hex;
  readonly wallet: Address;
  readonly metadata: unknown;
  readonly capability: unknown;
  readonly profile?: unknown;
  readonly reputation?: unknown;
}

export interface SupplierNotificationProfileConfigRecord extends SupplierNotificationProfileConfigRequest {
  readonly configId: string;
  readonly walletProofMessage: string;
  readonly walletProofSignatureHash: Hex;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupplierNotificationProfileConfigStore {
  get(configId: string): Promise<SupplierNotificationProfileConfigRecord | undefined>;
  put(record: SupplierNotificationProfileConfigRecord): Promise<SupplierNotificationProfileConfigRecord>;
  list(): Promise<readonly SupplierNotificationProfileConfigRecord[]>;
}

export interface SupplierNotificationProfileConfigService {
  prepare(input: unknown): SupplierNotificationProfileConfigRequest;
  save(input: unknown): Promise<SupplierNotificationProfileConfigRecord>;
  list(query?: SupplierNotificationProfileConfigQuery): Promise<readonly SupplierNotificationProfileConfigRecord[]>;
}

export interface SupplierNotificationProfileConfigQuery {
  readonly wallet?: string;
  readonly supplierSubjectId?: string;
}

export interface SupplierNotificationProfileConfigServiceOptions {
  readonly store?: SupplierNotificationProfileConfigStore;
  readonly now?: () => Date;
}

export class MemorySupplierNotificationProfileConfigStore implements SupplierNotificationProfileConfigStore {
  #records = new Map<string, SupplierNotificationProfileConfigRecord>();

  async get(configId: string): Promise<SupplierNotificationProfileConfigRecord | undefined> {
    return this.#records.get(configId);
  }

  async put(record: SupplierNotificationProfileConfigRecord): Promise<SupplierNotificationProfileConfigRecord> {
    this.#records.set(record.configId, record);
    return record;
  }

  async list(): Promise<readonly SupplierNotificationProfileConfigRecord[]> {
    return [...this.#records.values()].sort((left, right) => left.configId.localeCompare(right.configId));
  }
}

export function createSupplierNotificationProfileConfigService(
  options: SupplierNotificationProfileConfigServiceOptions = {}
): SupplierNotificationProfileConfigService {
  const store = options.store ?? new MemorySupplierNotificationProfileConfigStore();
  const now = options.now ?? (() => new Date());

  return {
    prepare(input) {
      return buildSupplierNotificationProfileConfigRequest(input);
    },

    async save(input) {
      const request = buildSupplierNotificationProfileConfigRequest(input);
      const proof = requiredWalletProof(requireRecord(input));
      await verifySupplierWalletProof(request, proof);
      const existing = await store.get(configIdFor(request));
      const timestamp = now().toISOString();
      return store.put({
        ...request,
        configId: configIdFor(request),
        walletProofMessage: proof.message,
        walletProofSignatureHash: hashGovernanceCanonicalJson({ signature: proof.signature }, "walletProofSignatureHash"),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
    },

    async list(query = {}) {
      const wallet = query.wallet ? normalizeAddress(query.wallet, "wallet") : undefined;
      const supplierSubjectId = query.supplierSubjectId
        ? normalizeBytes32(query.supplierSubjectId, "supplierSubjectId")
        : undefined;
      return (await store.list()).filter((record) =>
        (!wallet || record.wallet === wallet) &&
        (!supplierSubjectId || record.supplierSubjectId === supplierSubjectId)
      );
    }
  };
}

export function buildSupplierNotificationProfileConfigRequest(input: unknown): SupplierNotificationProfileConfigRequest {
  const record = requireRecord(input);
  const domainId = normalizeBytes32(requiredString(record, "domainId"), "domainId");
  const supplierSubjectId = normalizeBytes32(requiredString(record, "supplierSubjectId"), "supplierSubjectId");
  const wallet = normalizeAddress(requiredString(record, "wallet"), "wallet");
  const notification = parseSupplierNotificationProfile(requiredUnknown(record, "notification"));
  if (!notification) {
    throw new SupplierNotificationConfigError(400, "invalid_notification_profile", "notification must be a SupplierNotificationProfile v1 document");
  }

  const metadataInput = optionalRecord(record, "metadata") ?? {};
  const capabilityInput = optionalRecord(record, "capability") ?? optionalRecord(metadataInput, "capability") ?? {};
  const capability = {
    ...capabilityInput,
    notification
  };
  const metadata = {
    ...metadataInput,
    capability
  };
  const profile = optionalUnknown(record, "profile");
  const reputation = optionalUnknown(record, "reputation");
  const hashInput = {
    domainId,
    supplierSubjectId,
    wallet,
    metadata,
    capability,
    ...(profile !== undefined ? { profile } : {}),
    ...(reputation !== undefined ? { reputation } : {})
  };
  const notificationHash = hashGovernanceCanonicalJson(notification, "notificationHash");
  const metadataHash = hashSupplierMetadata(hashInput);
  const profileHash = hashSupplierProfile(hashInput);
  const capabilityHash = hashSupplierCapability(hashInput);
  const reputationHash = hashSupplierReputation(hashInput);
  const attestSupplierInput = {
    domainId,
    supplierSubjectId,
    wallet,
    metadata,
    capability,
    ...(profile !== undefined ? { profile } : {}),
    ...(reputation !== undefined ? { reputation } : {})
  };

  return {
    domainId,
    supplierSubjectId,
    wallet,
    notification,
    ...(profile !== undefined ? { profile } : {}),
    capability,
    metadata,
    ...(reputation !== undefined ? { reputation } : {}),
    notificationHash,
    metadataHash,
    profileHash,
    capabilityHash,
    reputationHash,
    expectedMessage: supplierNotificationProfileConfigMessage({
      domainId,
      supplierSubjectId,
      wallet,
      notificationHash
    }),
    attestSupplierInput
  };
}

export function supplierNotificationProfileConfigMessage(input: {
  readonly domainId: Hex;
  readonly supplierSubjectId: Hex;
  readonly wallet: Address;
  readonly notificationHash: Hex;
}): string {
  return [
    "uvp:supplier-notification-profile:v1",
    `domainId=${input.domainId}`,
    `supplierSubjectId=${input.supplierSubjectId}`,
    `wallet=${input.wallet}`,
    `notificationHash=${input.notificationHash}`
  ].join("\n");
}

async function verifySupplierWalletProof(
  request: SupplierNotificationProfileConfigRequest,
  proof: SupplierNotificationWalletProof
): Promise<void> {
  if (proof.message !== request.expectedMessage) {
    throw new SupplierNotificationConfigError(400, "wallet_proof_message_mismatch", "wallet proof message does not match the normalized notification profile");
  }

  let ok = false;
  try {
    ok = await verifyMessage({
      address: request.wallet,
      message: proof.message,
      signature: proof.signature
    });
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new SupplierNotificationConfigError(403, "wallet_proof_invalid", "wallet proof signature does not recover the supplier wallet");
  }
}

function configIdFor(request: SupplierNotificationProfileConfigRequest): string {
  return `${request.domainId}:${request.supplierSubjectId}:${request.wallet}`;
}

function requiredWalletProof(record: Record<string, unknown>): SupplierNotificationWalletProof {
  const proof = optionalRecord(record, "walletProof");
  if (!proof) {
    throw new SupplierNotificationConfigError(400, "wallet_proof_required", "walletProof is required");
  }
  return {
    message: requiredString(proof, "message"),
    signature: normalizeHex(requiredString(proof, "signature"), "walletProof.signature")
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new SupplierNotificationConfigError(400, "invalid_body", "request body must be a JSON object");
}

function optionalRecord(record: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = optionalUnknown(record, field);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new SupplierNotificationConfigError(400, "invalid_body", `${field} must be a JSON object`);
}

function requiredUnknown(record: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(record, field)) {
    throw new SupplierNotificationConfigError(400, "invalid_body", `${field} is required`);
  }
  return record[field];
}

function optionalUnknown(record: Record<string, unknown>, field: string): unknown | undefined {
  return Object.hasOwn(record, field) ? record[field] : undefined;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SupplierNotificationConfigError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeHex(value: string, field: string): Hex {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new SupplierNotificationConfigError(400, "invalid_body", `${field} must be a 0x-prefixed hex string`);
  }
  return value.toLowerCase() as Hex;
}
