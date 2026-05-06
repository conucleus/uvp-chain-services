import {
  STORE_SUPPLIER_CAPABILITY_TAGS,
  type StoreSupplierDTO,
  type StoreSupplierReviewStatus
} from "@uvp-eth/product-dto";
import type { GovernancePrincipal, GovernanceReviewStatus, GovernanceService } from "../governance/index.js";
import type { SupplierTrustProjection } from "../indexer/trust-projections.js";
import {
  buildSupplierNotificationProfileConfigRequest,
  verifySupplierNotificationWalletProof,
  type SupplierNotificationProfileConfigRequest,
  type SupplierNotificationWalletProof
} from "../notifications/config.js";
import type { ProductService, ProductTaskApiDTO } from "../product/service.js";
import { ConfigError, normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type {
  StoreOperatorPrincipal,
  StoreSupplierAuditAction,
  StoreSupplierAuditRecord,
  StoreSupplierMetadataRecord,
  StoreSupplierMetadataStore
} from "./types.js";

export type {
  StoreOperatorPrincipal,
  StoreSupplierAuditAction,
  StoreSupplierAuditRecord,
  StoreSupplierMetadataRecord,
  StoreSupplierMetadataStore
} from "./types.js";

const STORE_OPERATOR_ROLES = new Set(["admin", "store_admin", "store_operator", "governance_admin", "governance"]);
const CAPABILITY_TAGS = new Set<string>(STORE_SUPPLIER_CAPABILITY_TAGS);

export class StoreSupplierServiceError extends Error {
  override readonly name = "StoreSupplierServiceError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export class InMemoryStoreSupplierMetadataStore implements StoreSupplierMetadataStore {
  readonly #suppliers = new Map<string, StoreSupplierMetadataRecord>();
  readonly #audits: StoreSupplierAuditRecord[] = [];

  async getSupplier(supplierId: string): Promise<StoreSupplierMetadataRecord | undefined> {
    return this.#suppliers.get(supplierId);
  }

  async findSupplierBySubjectId(supplierSubjectId: Hex): Promise<StoreSupplierMetadataRecord | undefined> {
    return [...this.#suppliers.values()].find((supplier) => supplier.supplierSubjectId === supplierSubjectId);
  }

  async listSuppliers(): Promise<readonly StoreSupplierMetadataRecord[]> {
    return [...this.#suppliers.values()].sort(compareMetadataUpdatedDesc);
  }

  async putSupplier(record: StoreSupplierMetadataRecord): Promise<void> {
    this.#suppliers.set(record.supplierId, record);
  }

  async appendAudit(record: StoreSupplierAuditRecord): Promise<void> {
    this.#audits.push(record);
  }

  async listAudits(supplierId?: string): Promise<readonly StoreSupplierAuditRecord[]> {
    return this.#audits
      .filter((audit) => !supplierId || audit.supplierId === supplierId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.auditId.localeCompare(left.auditId));
  }
}

export interface StoreSupplierListQuery {
  readonly query?: string;
  readonly trust?: "active" | "revoked" | "not_found";
  readonly tag?: string;
}

export interface StoreSupplierListDTO {
  readonly sourceOfTruth: "contracts-and-chain-events";
  readonly suppliers: readonly StoreSupplierDTO[];
}

export interface StoreSupplierMutationResult {
  readonly supplier: StoreSupplierDTO;
}

export interface StoreSupplierGovernanceResult extends StoreSupplierMutationResult {
  readonly governance: unknown;
}

export interface StoreSupplierAuditListDTO {
  readonly nonAuthoritative: true;
  readonly trustSourceOfTruth: "SupplierAttested/SupplierRevoked projection";
  readonly records: readonly StoreSupplierAuditRecord[];
}

export interface StoreSupplierNotificationProfilePrepareResult {
  readonly profileConfig: SupplierNotificationProfileConfigRequest;
}

export interface StoreSupplierNotificationProfileResult extends StoreSupplierMutationResult {
  readonly profileConfig: SupplierNotificationProfileConfigRequest;
}

export interface StoreSupplierService {
  listSuppliers(query?: StoreSupplierListQuery): Promise<StoreSupplierListDTO>;
  getSupplier(supplierId: string): Promise<StoreSupplierDTO | undefined>;
  listSupplierAudits(supplierId: string): Promise<StoreSupplierAuditListDTO>;
  createSupplier(input: unknown, principal: StoreOperatorPrincipal): Promise<StoreSupplierMutationResult>;
  reviewSupplier(supplierId: string, input: unknown, principal: StoreOperatorPrincipal): Promise<StoreSupplierGovernanceResult>;
  prepareNotificationProfile(supplierId: string, input: unknown): Promise<StoreSupplierNotificationProfilePrepareResult>;
  saveNotificationProfile(supplierId: string, input: unknown): Promise<StoreSupplierNotificationProfileResult>;
  requestAttestation(supplierId: string, input: unknown, principal: StoreOperatorPrincipal): Promise<StoreSupplierGovernanceResult>;
  requestRevocation(supplierId: string, input: unknown, principal: StoreOperatorPrincipal): Promise<StoreSupplierGovernanceResult>;
}

export interface StoreSupplierServiceOptions {
  readonly store: ProjectionStore;
  readonly productService: ProductService;
  readonly governanceService: GovernanceService;
  readonly metadataStore?: StoreSupplierMetadataStore;
  readonly now?: () => Date;
}

export function createStoreSupplierService(options: StoreSupplierServiceOptions): StoreSupplierService {
  const metadataStore = options.metadataStore ?? new InMemoryStoreSupplierMetadataStore();
  const now = options.now ?? (() => new Date());
  let sequence = 1;

  return {
    async listSuppliers(query = {}) {
      const suppliers = (await buildStoreSupplierRows({
        metadataStore,
        projectionStore: options.store,
        productService: options.productService
      })).filter((supplier) => matchesSupplierQuery(supplier, query));
      return {
        sourceOfTruth: "contracts-and-chain-events",
        suppliers
      };
    },

    async getSupplier(supplierId) {
      const normalized = supplierId.toLowerCase();
      return (await buildStoreSupplierRows({
        metadataStore,
        projectionStore: options.store,
        productService: options.productService
      })).find((supplier) =>
        supplier.supplierId.toLowerCase() === normalized ||
        supplier.supplierSubjectId.toLowerCase() === normalized
      );
    },

    async listSupplierAudits(supplierId) {
      const current = await requireMetadata(metadataStore, supplierId);
      return {
        nonAuthoritative: true,
        trustSourceOfTruth: "SupplierAttested/SupplierRevoked projection",
        records: await metadataStore.listAudits(current.supplierId)
      };
    },

    async createSupplier(input, principal) {
      const record = createMetadataRecord(input, now().toISOString());
      const supplierIdExists = await metadataStore.getSupplier(record.supplierId);
      if (supplierIdExists) {
        throw new StoreSupplierServiceError(409, "supplier_id_exists", "supplierId already exists");
      }
      const subjectExists = await metadataStore.findSupplierBySubjectId(record.supplierSubjectId);
      if (subjectExists) {
        throw new StoreSupplierServiceError(409, "supplier_subject_exists", "supplierSubjectId already has Store metadata", {
          supplierId: subjectExists.supplierId
        });
      }
      await metadataStore.putSupplier(record);
      await metadataStore.appendAudit(auditRecord("audit", sequence++, record, "create", principal, now));
      return {
        supplier: await requireBuiltSupplier(record.supplierId, metadataStore, options.store, options.productService)
      };
    },

    async reviewSupplier(supplierId, input, principal) {
      const current = await requireMetadata(metadataStore, supplierId);
      const record = mergeReviewMetadata(current, input, now().toISOString());
      await metadataStore.putSupplier(record);
      await metadataStore.appendAudit(auditRecord("audit", sequence++, record, "review", principal, now, {
        reviewStatus: record.reviewStatus
      }));
      if (supplierCapabilitiesChanged(current, record)) {
        await metadataStore.appendAudit(auditRecord("audit", sequence++, record, "tags_updated", principal, now, {
          beforeTags: current.capabilityTags,
          afterTags: record.capabilityTags,
          beforeSupportedRoleSlotIds: current.supportedRoleSlotIds,
          afterSupportedRoleSlotIds: record.supportedRoleSlotIds,
          beforeSupportedStageIds: current.supportedStageIds,
          afterSupportedStageIds: record.supportedStageIds
        }));
      }
      const governance = await options.governanceService.reviewSupplier(
        governanceReviewInput(record, input),
        governancePrincipal(principal)
      );
      return {
        supplier: await requireBuiltSupplier(record.supplierId, metadataStore, options.store, options.productService),
        governance
      };
    },

    async requestAttestation(supplierId, input, principal) {
      const current = await requireMetadata(metadataStore, supplierId);
      if (current.reviewStatus !== "approved_for_broadcast") {
        throw new StoreSupplierServiceError(
          409,
          "supplier_not_approved_for_broadcast",
          "supplier must be approved_for_broadcast before attestation request",
          { reviewStatus: current.reviewStatus }
        );
      }
      const record = mergeRequestMetadata(current, input, now().toISOString());
      const wallet = requestWallet(input, record.wallet);
      const governance = await options.governanceService.attestSupplier(
        supplierAttestationInput(record, input, wallet),
        governancePrincipal(principal)
      );
      await metadataStore.putSupplier(record);
      await metadataStore.appendAudit(auditRecord("audit", sequence++, record, "request_attestation", principal, now));
      return {
        supplier: await requireBuiltSupplier(record.supplierId, metadataStore, options.store, options.productService),
        governance
      };
    },

    async prepareNotificationProfile(supplierId, input) {
      const current = await requireMetadata(metadataStore, supplierId);
      return {
        profileConfig: supplierNotificationProfileConfigInput(current, input)
      };
    },

    async saveNotificationProfile(supplierId, input) {
      const current = await requireMetadata(metadataStore, supplierId);
      const profileConfig = supplierNotificationProfileConfigInput(current, input);
      await verifySupplierNotificationWalletProof(profileConfig, requiredWalletProof(input));
      const timestamp = now().toISOString();
      const updated: StoreSupplierMetadataRecord = {
        ...current,
        wallet: profileConfig.wallet,
        notificationProfile: profileConfig.notification,
        notificationProfileHash: profileConfig.notificationHash,
        notificationUpdatedAt: timestamp,
        updatedAt: timestamp
      };
      await metadataStore.putSupplier(updated);
      await metadataStore.appendAudit(auditRecord("audit", sequence++, updated, "notification_profile_updated", {
        operatorId: `wallet:${profileConfig.wallet}`,
        role: "supplier"
      }, now));
      return {
        supplier: await requireBuiltSupplier(updated.supplierId, metadataStore, options.store, options.productService),
        profileConfig
      };
    },

    async requestRevocation(supplierId, input, principal) {
      const current = await requireMetadata(metadataStore, supplierId);
      const updated: StoreSupplierMetadataRecord = {
        ...current,
        reviewStatus: "revoked",
        updatedAt: now().toISOString()
      };
      const governance = await options.governanceService.revokeSupplier(
        supplierRevocationInput(updated, input),
        governancePrincipal(principal)
      );
      await metadataStore.putSupplier(updated);
      await metadataStore.appendAudit(auditRecord("audit", sequence++, updated, "request_revocation", principal, now, {
        reviewStatus: "revoked"
      }));
      return {
        supplier: await requireBuiltSupplier(updated.supplierId, metadataStore, options.store, options.productService),
        governance
      };
    }
  };
}

export function storeOperatorPrincipalFromHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined
): StoreOperatorPrincipal | undefined {
  const storeOperatorId = readHeader(headers, "x-uvp-store-operator-id")?.trim();
  const storeRole = readHeader(headers, "x-uvp-store-operator-role")?.trim().toLowerCase();
  if (storeOperatorId && storeRole && STORE_OPERATOR_ROLES.has(storeRole)) {
    return { operatorId: storeOperatorId, role: storeRole };
  }

  const adminId = readHeader(headers, "x-uvp-admin-id")?.trim();
  const adminRole = readHeader(headers, "x-uvp-admin-role")?.trim().toLowerCase();
  if (adminId && adminRole && STORE_OPERATOR_ROLES.has(adminRole)) {
    return { operatorId: adminId, role: adminRole };
  }
  return undefined;
}

async function buildStoreSupplierRows(input: {
  readonly metadataStore: StoreSupplierMetadataStore;
  readonly projectionStore: ProjectionStore;
  readonly productService: ProductService;
}): Promise<readonly StoreSupplierDTO[]> {
  const [metadataRows, trustSnapshot, tasks] = await Promise.all([
    input.metadataStore.listSuppliers(),
    input.projectionStore.getTrustSnapshot(),
    input.productService.listTasks()
  ]);
  const metadataBySubject = new Map(metadataRows.map((record) => [record.supplierSubjectId, record]));
  const trustBySubject = new Map<string, SupplierTrustProjection[]>();
  for (const trust of Object.values(trustSnapshot.suppliers)) {
    const current = trustBySubject.get(trust.supplierSubjectId) ?? [];
    trustBySubject.set(trust.supplierSubjectId, [...current, trust]);
  }

  const subjectIds = new Set<string>([
    ...metadataRows.map((record) => record.supplierSubjectId),
    ...Object.values(trustSnapshot.suppliers).map((trust) => trust.supplierSubjectId)
  ]);

  return [...subjectIds]
    .map((subjectId) => supplierDtoFromSources({
      metadata: metadataBySubject.get(subjectId as Hex),
      trusts: trustBySubject.get(subjectId) ?? [],
      subjectId: subjectId as Hex,
      tasks
    }))
    .sort(compareSupplierRows);
}

function supplierDtoFromSources(input: {
  readonly metadata: StoreSupplierMetadataRecord | undefined;
  readonly trusts: readonly SupplierTrustProjection[];
  readonly subjectId: Hex;
  readonly tasks: readonly ProductTaskApiDTO[];
}): StoreSupplierDTO {
  const selectedTrust = selectSupplierTrust(input.trusts);
  const wallet = selectedTrust?.wallet ?? input.metadata?.wallet;
  const registryAddresses = uniqueSorted([
    ...(input.metadata?.registryAddresses ?? []),
    ...input.trusts.map((trust) => trust.registryAddress)
  ]);
  const matchingTasks = input.tasks.filter((task) => taskMatchesSupplier(task, input.subjectId, wallet));
  const recentOrderIds = new Set(matchingTasks.map((task) => task.orderId));
  const trustStatus = selectedTrust ? selectedTrust.status : "not_found";
  const reviewStatus = selectedTrust?.revoked
    ? "revoked"
    : input.metadata?.reviewStatus ?? (selectedTrust ? "approved_for_broadcast" : "draft");
  const metadataURI = input.metadata?.metadataURI ?? selectedTrust?.metadataURI;

  return {
    supplierId: input.metadata?.supplierId ?? input.subjectId,
    supplierSubjectId: input.subjectId,
    displayName: input.metadata?.displayName ?? `供应商 ${shortHex(input.subjectId)}`,
    ...(wallet ? { wallet } : {}),
    ...(input.metadata?.notificationProfile ? { notificationProfile: input.metadata.notificationProfile } : {}),
    ...(input.metadata?.notificationProfileHash ? { notificationProfileHash: input.metadata.notificationProfileHash } : {}),
    ...(input.metadata?.notificationUpdatedAt ? { notificationUpdatedAt: input.metadata.notificationUpdatedAt } : {}),
    trustStatus,
    trustLabel: supplierTrustLabel(trustStatus),
    capabilityTags: input.metadata?.capabilityTags ?? [],
    supportedRoleSlotIds: input.metadata?.supportedRoleSlotIds ?? [],
    supportedStageIds: input.metadata?.supportedStageIds ?? [],
    registryAddresses,
    recentOrderCount: recentOrderIds.size,
    openTaskCount: matchingTasks.filter((task) => task.status === "open").length,
    reviewStatus,
    ...(metadataURI ? { metadataURI } : {}),
    proofRows: supplierProofRows(input.subjectId, selectedTrust),
    nextAction: supplierNextAction(trustStatus, reviewStatus),
    updatedAt: input.metadata?.updatedAt ?? (selectedTrust ? `block ${selectedTrust.updatedAt.blockNumber.toString()}` : "")
  };
}

function matchesSupplierQuery(supplier: StoreSupplierDTO, query: StoreSupplierListQuery): boolean {
  const trustStatus = query.trust === "active" ? "attested" : query.trust;
  const tag = query.tag?.trim().toLowerCase();
  const needle = query.query?.trim().toLowerCase();
  return (!trustStatus || supplier.trustStatus === trustStatus) &&
    (!tag || supplier.capabilityTags.includes(tag)) &&
    (!needle ||
      supplier.displayName.toLowerCase().includes(needle) ||
      supplier.supplierId.toLowerCase().includes(needle) ||
      supplier.supplierSubjectId.toLowerCase().includes(needle) ||
      supplier.wallet?.toLowerCase().includes(needle) ||
      supplier.capabilityTags.some((item) => item.includes(needle)) ||
      supplier.registryAddresses.some((registryAddress) => registryAddress.toLowerCase().includes(needle)));
}

async function requireBuiltSupplier(
  supplierId: string,
  metadataStore: StoreSupplierMetadataStore,
  projectionStore: ProjectionStore,
  productService: ProductService
): Promise<StoreSupplierDTO> {
  const supplier = (await buildStoreSupplierRows({ metadataStore, projectionStore, productService }))
    .find((item) => item.supplierId === supplierId);
  if (!supplier) {
    throw new StoreSupplierServiceError(404, "supplier_not_found", "supplier not found");
  }
  return supplier;
}

async function requireMetadata(
  store: StoreSupplierMetadataStore,
  supplierId: string
): Promise<StoreSupplierMetadataRecord> {
  const byId = await store.getSupplier(supplierId);
  if (byId) {
    return byId;
  }
  const bySubject = isBytes32Like(supplierId)
    ? await store.findSupplierBySubjectId(normalizeBytes32(supplierId, "supplierId"))
    : undefined;
  if (bySubject) {
    return bySubject;
  }
  throw new StoreSupplierServiceError(404, "supplier_not_found", "supplier Store metadata not found");
}

async function selectedTrustForSubject(
  store: ProjectionStore,
  supplierSubjectId: Hex
): Promise<SupplierTrustProjection | undefined> {
  return selectSupplierTrust(Object.values((await store.getTrustSnapshot()).suppliers)
    .filter((supplier) => supplier.supplierSubjectId === supplierSubjectId));
}

function createMetadataRecord(input: unknown, timestamp: string): StoreSupplierMetadataRecord {
  const record = requireBodyRecord(input);
  const supplierSubjectId = requiredBytes32(record, "supplierSubjectId");
  const supplierId = optionalString(record, "supplierId") ?? `supplier-${shortHex(supplierSubjectId)}`;
  return {
    supplierId: normalizeSupplierId(supplierId),
    supplierSubjectId,
    displayName: requiredString(record, "displayName"),
    ...optionalWallet(record),
    capabilityTags: normalizeCapabilityTags(optionalStringArray(record, "capabilityTags") ?? []),
    supportedRoleSlotIds: normalizeStringArray(optionalStringArray(record, "supportedRoleSlotIds") ?? []),
    supportedStageIds: normalizeStringArray(optionalStringArray(record, "supportedStageIds") ?? []),
    registryAddresses: normalizeRegistryAddresses(optionalStringArray(record, "registryAddresses")),
    reviewStatus: optionalStoreReviewStatus(record, "reviewStatus") ?? "draft",
    ...optionalMetadataURI(record),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function mergeReviewMetadata(
  current: StoreSupplierMetadataRecord,
  input: unknown,
  timestamp: string
): StoreSupplierMetadataRecord {
  const record = requireBodyRecord(input);
  const displayName = optionalString(record, "displayName");
  const capabilityTags = optionalStringArray(record, "capabilityTags");
  const supportedRoleSlotIds = optionalStringArray(record, "supportedRoleSlotIds");
  const supportedStageIds = optionalStringArray(record, "supportedStageIds");
  const registryAddresses = optionalStringArray(record, "registryAddresses");
  return {
    ...current,
    ...(displayName !== undefined ? { displayName } : {}),
    ...optionalWallet(record, current.wallet),
    ...(capabilityTags !== undefined ? { capabilityTags: normalizeCapabilityTags(capabilityTags) } : {}),
    ...(supportedRoleSlotIds !== undefined ? { supportedRoleSlotIds: normalizeStringArray(supportedRoleSlotIds) } : {}),
    ...(supportedStageIds !== undefined ? { supportedStageIds: normalizeStringArray(supportedStageIds) } : {}),
    ...(registryAddresses !== undefined ? { registryAddresses: normalizeRegistryAddresses(registryAddresses) } : {}),
    reviewStatus: requiredStoreReviewStatus(record, "reviewStatus"),
    ...optionalMetadataURI(record, current.metadataURI),
    updatedAt: timestamp
  };
}

function mergeRequestMetadata(
  current: StoreSupplierMetadataRecord,
  input: unknown,
  timestamp: string
): StoreSupplierMetadataRecord {
  if (input === undefined || input === null) {
    return current;
  }
  const record = requireBodyRecord(input);
  const wallet = optionalWallet(record, current.wallet);
  const metadataURI = optionalMetadataURI(record, current.metadataURI);
  return {
    ...current,
    ...wallet,
    ...metadataURI,
    updatedAt: timestamp
  };
}

function governanceReviewInput(record: StoreSupplierMetadataRecord, input: unknown): Record<string, unknown> {
  const body = requireBodyRecord(input);
  return {
    subjectId: record.supplierSubjectId,
    status: governanceStatus(record.reviewStatus),
    ...(optionalString(body, "riskLevel") ? { riskLevel: optionalString(body, "riskLevel") } : {}),
    ...(optionalStringArray(body, "riskTags") ? { riskTags: optionalStringArray(body, "riskTags") } : {}),
    ...(optionalString(body, "publicSummary") ? { publicSummary: optionalString(body, "publicSummary") } : {}),
    ...(optionalString(body, "internalNotes") ? { internalNotes: optionalString(body, "internalNotes") } : {}),
    ...(record.metadataURI ? { metadataURI: record.metadataURI } : {}),
    metadata: {
      storeSupplierId: record.supplierId,
      displayName: record.displayName,
      wallet: record.wallet ?? null,
      capabilityTags: record.capabilityTags,
      supportedRoleSlotIds: record.supportedRoleSlotIds,
      supportedStageIds: record.supportedStageIds
    }
  };
}

function supplierAttestationInput(
  record: StoreSupplierMetadataRecord,
  input: unknown,
  wallet: Address
): Record<string, unknown> {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return {
    supplierSubjectId: record.supplierSubjectId,
    wallet,
    subjectId: record.supplierSubjectId,
    profile: optionalUnknown(body, "profile") ?? {
      storeSupplierId: record.supplierId,
      displayName: record.displayName,
      wallet
    },
    capability: optionalUnknown(body, "capability") ?? {
      tags: record.capabilityTags,
      supportedRoleSlotIds: record.supportedRoleSlotIds,
      supportedStageIds: record.supportedStageIds
    },
    metadata: optionalUnknown(body, "metadata") ?? {
      storeSupplierId: record.supplierId,
      metadataURI: record.metadataURI ?? null
    },
    ...(optionalUnknown(body, "reputation") !== undefined ? { reputation: body.reputation } : {})
  };
}

function supplierNotificationProfileConfigInput(
  supplier: StoreSupplierMetadataRecord,
  input: unknown
): SupplierNotificationProfileConfigRequest {
  const body = requireBodyRecord(input);
  const wallet = optionalString(body, "wallet") ?? supplier.wallet;
  if (!wallet) {
    throw new StoreSupplierServiceError(400, "wallet_required", "supplier wallet is required before saving notification profile");
  }
  return buildSupplierNotificationProfileConfigRequest({
    ...body,
    supplierSubjectId: supplier.supplierSubjectId,
    wallet,
    profile: optionalUnknown(body, "profile") ?? {
      storeSupplierId: supplier.supplierId,
      displayName: supplier.displayName,
      wallet
    },
    capability: optionalUnknown(body, "capability") ?? {
      tags: supplier.capabilityTags,
      supportedRoleSlotIds: supplier.supportedRoleSlotIds,
      supportedStageIds: supplier.supportedStageIds,
      notificationProfileOwner: "store_supplier"
    },
    metadata: optionalUnknown(body, "metadata") ?? {
      storeSupplierId: supplier.supplierId,
      metadataURI: supplier.metadataURI ?? null
    }
  });
}

function requiredWalletProof(input: unknown): SupplierNotificationWalletProof {
  const body = requireBodyRecord(input);
  const proof = optionalRecord(body, "walletProof");
  if (!proof) {
    throw new StoreSupplierServiceError(400, "wallet_proof_required", "walletProof is required");
  }
  return {
    message: requiredString(proof, "message"),
    signature: requiredString(proof, "signature") as Hex
  };
}

function supplierRevocationInput(
  record: StoreSupplierMetadataRecord,
  input: unknown
): Record<string, unknown> {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return {
    supplierSubjectId: record.supplierSubjectId,
    subjectId: record.supplierSubjectId,
    reason: optionalString(body, "reason") ?? optionalString(body, "publicSummary") ?? "Store supplier revocation requested",
    ...(optionalString(body, "publicSummary") ? { publicSummary: optionalString(body, "publicSummary") } : {}),
    ...(optionalString(body, "internalNotes") ? { internalNotes: optionalString(body, "internalNotes") } : {}),
    metadata: optionalUnknown(body, "metadata") ?? {
      storeSupplierId: record.supplierId
    }
  };
}

function auditRecord(
  prefix: string,
  sequence: number,
  supplier: StoreSupplierMetadataRecord,
  action: StoreSupplierAuditAction,
  principal: StoreOperatorPrincipal,
  now: () => Date,
  extra: Partial<StoreSupplierAuditRecord> = {}
): StoreSupplierAuditRecord {
  return {
    auditId: `${prefix}_${sequence.toString().padStart(6, "0")}`,
    supplierId: supplier.supplierId,
    supplierSubjectId: supplier.supplierSubjectId,
    action,
    actor: principal.operatorId,
    ...extra,
    createdAt: now().toISOString()
  };
}

function governancePrincipal(principal: StoreOperatorPrincipal): GovernancePrincipal {
  return {
    adminId: principal.operatorId,
    role: principal.role
  };
}

function governanceStatus(status: StoreSupplierReviewStatus): GovernanceReviewStatus {
  switch (status) {
    case "draft":
    case "submitted":
    case "approved_for_broadcast":
    case "rejected":
    case "revoked":
      return status;
  }
}

function selectSupplierTrust(trusts: readonly SupplierTrustProjection[]): SupplierTrustProjection | undefined {
  const sorted = [...trusts].sort(compareTrustUpdatedDesc);
  return sorted.find((trust) => !trust.revoked) ?? sorted[0];
}

function taskMatchesSupplier(task: ProductTaskApiDTO, supplierSubjectId: Hex, wallet: Address | undefined): boolean {
  const walletMatch = wallet && task.assigneeWallet?.toLowerCase() === wallet.toLowerCase();
  return task.supplierSubjectId === supplierSubjectId || Boolean(walletMatch);
}

function supplierProofRows(subjectId: Hex, trust: SupplierTrustProjection | undefined): StoreSupplierDTO["proofRows"] {
  if (!trust) {
    return [
      { label: "Supplier Subject", value: subjectId },
      { label: "链上背书", value: "未发现 SupplierAttested 投影" }
    ];
  }
  const provenance = trust.revoked && trust.revokedAt ? trust.revokedAt : trust.updatedAt;
  return [
    { label: "Supplier Subject", value: trust.supplierSubjectId },
    { label: "背书状态", value: supplierTrustLabel(trust.status) },
    { label: "Registry", value: trust.registryAddress },
    { label: "钱包", value: trust.wallet },
    { label: "链上事件", value: trust.revoked ? "SupplierRevoked" : "SupplierAttested" },
    { label: "交易编号", value: shortHex(provenance.transactionHash) },
    { label: "区块高度", value: provenance.blockNumber.toString() },
    ...(trust.revokeReasonURI ? [{ label: "撤销说明", value: trust.revokeReasonURI }] : [])
  ];
}

function supplierTrustLabel(status: StoreSupplierDTO["trustStatus"]): string {
  switch (status) {
    case "attested":
      return "已链上背书";
    case "revoked":
      return "链上背书已撤销";
    case "not_found":
      return "未发现链上背书";
  }
}

function supplierNextAction(
  trustStatus: StoreSupplierDTO["trustStatus"],
  reviewStatus: StoreSupplierReviewStatus
): string {
  if (trustStatus === "revoked" || reviewStatus === "revoked") {
    return "禁止用于新订单授权，保留历史证明";
  }
  if (trustStatus === "attested") {
    return "可进入候选匹配；新订单仍需显式参与授权";
  }
  switch (reviewStatus) {
    case "draft":
      return "补全供应商资料并提交审核";
    case "submitted":
      return "等待 Store 审核";
    case "approved_for_broadcast":
      return "请求治理背书交易";
    case "rejected":
      return "修改资料后重新提交";
  }
}

function requestWallet(input: unknown, fallback: Address | undefined): Address {
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const value = optionalString(record, "wallet") ?? fallback;
  if (!value) {
    throw new StoreSupplierServiceError(400, "wallet_required", "supplier wallet is required for attestation request");
  }
  return normalizeAddress(value, "wallet");
}

function requireBodyRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  throw new StoreSupplierServiceError(400, "invalid_body", "request body must be a JSON object");
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = optionalString(record, field);
  if (!value) {
    throw new StoreSupplierServiceError(400, "invalid_body", `${field} must be a non-empty string`);
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
    throw new StoreSupplierServiceError(400, "invalid_body", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalRecord(record: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  if (!Object.hasOwn(record, field) || record[field] === null) {
    return undefined;
  }
  const value = record[field];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new StoreSupplierServiceError(400, "invalid_body", `${field} must be a JSON object`);
}

function requiredBytes32(record: Record<string, unknown>, field: string): Hex {
  const value = requiredString(record, field);
  return normalizeBytes32(value, field);
}

function optionalStringArray(record: Record<string, unknown>, field: string): readonly string[] | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new StoreSupplierServiceError(400, "invalid_body", `${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function optionalSingleton(record: Record<string, unknown>, field: string): readonly string[] | undefined {
  const value = optionalString(record, field);
  return value ? [value] : undefined;
}

function requiredStoreReviewStatus(record: Record<string, unknown>, field: string): StoreSupplierReviewStatus {
  const value = optionalStoreReviewStatus(record, field);
  if (!value) {
    throw new StoreSupplierServiceError(400, "invalid_body", `${field} is required`);
  }
  return value;
}

function optionalStoreReviewStatus(
  record: Record<string, unknown>,
  field: string
): StoreSupplierReviewStatus | undefined {
  const value = optionalString(record, field);
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "draft" ||
    value === "submitted" ||
    value === "approved_for_broadcast" ||
    value === "rejected" ||
    value === "revoked"
  ) {
    return value;
  }
  throw new StoreSupplierServiceError(400, "invalid_body", `${field} is not a supported supplier review status`);
}

function optionalWallet(
  record: Record<string, unknown>,
  fallback?: Address
): { readonly wallet?: Address } {
  const value = optionalString(record, "wallet");
  if (value === undefined) {
    return fallback ? { wallet: fallback } : {};
  }
  return { wallet: normalizeAddress(value, "wallet") };
}

function optionalMetadataURI(
  record: Record<string, unknown>,
  fallback?: string
): { readonly metadataURI?: string } {
  const value = optionalString(record, "metadataURI");
  if (value === undefined) {
    return fallback ? { metadataURI: fallback } : {};
  }
  return { metadataURI: value };
}

function normalizeCapabilityTags(tags: readonly string[]): readonly string[] {
  const normalized = uniqueSorted(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0));
  const invalid = normalized.find((tag) => !CAPABILITY_TAGS.has(tag));
  if (invalid) {
    throw new StoreSupplierServiceError(400, "invalid_capability_tag", `${invalid} is not a supported capability tag`);
  }
  return normalized;
}

function normalizeStringArray(values: readonly string[]): readonly string[] {
  return uniqueSorted(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function normalizeRegistryAddresses(values: readonly string[] | undefined): readonly Address[] {
  return values ? uniqueSorted(values.map((value) => normalizeAddress(value, "registryAddress"))) as readonly Address[] : [];
}

function normalizeSupplierId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    throw new StoreSupplierServiceError(400, "invalid_supplier_id", "supplierId must be 1-128 URL-safe characters");
  }
  return trimmed;
}

function optionalUnknown(record: Record<string, unknown>, field: string): unknown {
  return Object.hasOwn(record, field) ? record[field] : undefined;
}

function isBytes32Like(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function uniqueSorted<TValue extends string>(values: readonly TValue[]): readonly TValue[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function supplierCapabilitiesChanged(
  left: StoreSupplierMetadataRecord,
  right: StoreSupplierMetadataRecord
): boolean {
  return !sameStringArray(left.capabilityTags, right.capabilityTags) ||
    !sameStringArray(left.supportedRoleSlotIds, right.supportedRoleSlotIds) ||
    !sameStringArray(left.supportedStageIds, right.supportedStageIds);
}

function compareSupplierRows(left: StoreSupplierDTO, right: StoreSupplierDTO): number {
  return trustRank(left.trustStatus) - trustRank(right.trustStatus) ||
    left.displayName.localeCompare(right.displayName) ||
    left.supplierSubjectId.localeCompare(right.supplierSubjectId);
}

function trustRank(status: StoreSupplierDTO["trustStatus"]): number {
  switch (status) {
    case "attested":
      return 0;
    case "not_found":
      return 1;
    case "revoked":
      return 2;
  }
}

function compareTrustUpdatedDesc(left: SupplierTrustProjection, right: SupplierTrustProjection): number {
  if (left.updatedAt.blockNumber !== right.updatedAt.blockNumber) {
    return left.updatedAt.blockNumber > right.updatedAt.blockNumber ? -1 : 1;
  }
  if (left.updatedAt.logIndex !== right.updatedAt.logIndex) {
    return right.updatedAt.logIndex - left.updatedAt.logIndex;
  }
  return left.registryAddress.localeCompare(right.registryAddress);
}

function compareMetadataUpdatedDesc(left: StoreSupplierMetadataRecord, right: StoreSupplierMetadataRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.supplierId.localeCompare(right.supplierId);
}

function shortHex(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-8)}` : value;
}

function readHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export function storeSupplierErrorFromConfigError(error: unknown): StoreSupplierServiceError | undefined {
  if (error instanceof ConfigError) {
    return new StoreSupplierServiceError(400, "invalid_body", error.message);
  }
  return undefined;
}
