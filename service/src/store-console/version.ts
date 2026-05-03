import {
  DEFAULT_OFFICIAL_DOMAIN_ID,
  type ChainAttestationStatus,
  type StoreZhixuVersionStatus,
  type StoreZhixuVersionSummaryDTO
} from "@uvp-eth/product-dto";
import type { GovernancePlanRevocationResultDTO, GovernancePrincipal, GovernanceService } from "../governance/index.js";
import type { PlanTrustProjection, TrustProjectionSnapshot } from "../indexer/trust-projections.js";
import type { ProductService } from "../product/service.js";
import { normalizeBytes32, type Hex } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";

export interface StoreZhixuVersionService {
  listVersions(seriesId: string): Promise<StoreZhixuVersionListDTO>;
  activate(
    seriesId: string,
    versionId: string,
    input?: StoreZhixuVersionMutationInput
  ): Promise<StoreZhixuVersionMutationDTO>;
  deprecate(
    seriesId: string,
    versionId: string,
    input?: StoreZhixuVersionMutationInput
  ): Promise<StoreZhixuVersionMutationDTO>;
  requestRevocation(
    seriesId: string,
    versionId: string,
    input: StoreZhixuVersionRevocationInput,
    principal: GovernancePrincipal
  ): Promise<StoreZhixuVersionRevocationDTO>;
  resolveActiveVersion(zhixuId: string): Promise<StoreZhixuVersionSummaryDTO | undefined>;
}

export interface StoreZhixuVersionListDTO {
  readonly sourceOfTruth: "contracts-and-chain-events";
  readonly seriesId: string;
  readonly versions: readonly StoreZhixuVersionSummaryDTO[];
}

export interface StoreZhixuVersionMutationDTO extends StoreZhixuVersionListDTO {
  readonly version: StoreZhixuVersionSummaryDTO;
}

export interface StoreZhixuVersionRevocationDTO {
  readonly sourceOfTruth: "contracts-and-chain-events";
  readonly version: StoreZhixuVersionSummaryDTO;
  readonly revocation: GovernancePlanRevocationResultDTO;
}

export interface StoreZhixuVersionMutationInput {
  readonly zhixuId?: string;
  readonly versionLabel?: string;
  readonly planId?: string;
  readonly planHash?: string;
  readonly artifactHash?: string;
  readonly cutoverReason?: string;
}

export interface StoreZhixuVersionRevocationInput extends StoreZhixuVersionMutationInput {
  readonly domainId?: string;
  readonly reason?: string;
  readonly publicSummary?: string;
  readonly metadata?: unknown;
}

export interface StoreZhixuVersionRecord {
  readonly versionId: string;
  readonly zhixuId: string;
  readonly seriesId: string;
  readonly versionLabel: string;
  readonly status: StoreZhixuVersionStatus;
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly artifactHash?: Hex;
  readonly createdAt: string;
  readonly cutoverAt?: string;
  readonly cutoverReason?: string;
}

export interface StoreZhixuVersionMetadataStore {
  listVersions(seriesId: string): Promise<readonly StoreZhixuVersionRecord[]>;
  getVersion(seriesId: string, versionId: string): Promise<StoreZhixuVersionRecord | undefined>;
  upsertVersion(record: StoreZhixuVersionRecord): Promise<void>;
}

export class MemoryStoreZhixuVersionMetadataStore implements StoreZhixuVersionMetadataStore {
  readonly #records = new Map<string, StoreZhixuVersionRecord>();

  async listVersions(seriesId: string): Promise<readonly StoreZhixuVersionRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.seriesId === seriesId)
      .sort(compareVersionRecords);
  }

  async getVersion(seriesId: string, versionId: string): Promise<StoreZhixuVersionRecord | undefined> {
    return this.#records.get(versionKey(seriesId, versionId));
  }

  async upsertVersion(record: StoreZhixuVersionRecord): Promise<void> {
    this.#records.set(versionKey(record.seriesId, record.versionId), record);
  }
}

export class StoreZhixuVersionError extends Error {
  override readonly name = "StoreZhixuVersionError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export function createStoreZhixuVersionService(options: {
  readonly productService: ProductService;
  readonly projectionStore: ProjectionStore;
  readonly metadataStore?: StoreZhixuVersionMetadataStore;
  readonly governanceService?: GovernanceService;
  readonly now?: () => Date;
}): StoreZhixuVersionService {
  const metadataStore = options.metadataStore ?? new MemoryStoreZhixuVersionMetadataStore();
  const now = options.now ?? (() => new Date());

  return {
    async listVersions(seriesId) {
      return {
        sourceOfTruth: "contracts-and-chain-events",
        seriesId,
        versions: await summarizeSeries({
          seriesId,
          metadataStore,
          productService: options.productService,
          projectionStore: options.projectionStore,
          now
        })
      };
    },

    async activate(seriesId, versionId, input = {}) {
      const record = await ensureVersionRecord({
        metadataStore,
        productService: options.productService,
        projectionStore: options.projectionStore,
        seriesId,
        versionId,
        input,
        now
      });
      const summary = await summarizeRecord(record, options.productService, options.projectionStore);
      assertActivatable(summary);
      const cutoverAt = now().toISOString();
      const existing = await effectiveVersionRecords({
        seriesId,
        metadataStore,
        productService: options.productService,
        projectionStore: options.projectionStore,
        now
      });
      for (const item of existing) {
        if (item.versionId === record.versionId) {
          continue;
        }
        if (item.status === "active") {
          await metadataStore.upsertVersion({
            ...item,
            status: "deprecated",
            cutoverAt,
            cutoverReason: "Superseded by active Store version."
          });
        }
      }
      const active: StoreZhixuVersionRecord = {
        ...record,
        status: "active",
        cutoverAt,
        ...(input.cutoverReason ? { cutoverReason: input.cutoverReason } : record.cutoverReason ? { cutoverReason: record.cutoverReason } : {})
      };
      await metadataStore.upsertVersion(active);
      return mutationResult(seriesId, active, metadataStore, options.productService, options.projectionStore, now);
    },

    async deprecate(seriesId, versionId, input = {}) {
      const record = await ensureVersionRecord({
        metadataStore,
        productService: options.productService,
        projectionStore: options.projectionStore,
        seriesId,
        versionId,
        input,
        now
      });
      const deprecated: StoreZhixuVersionRecord = {
        ...record,
        status: "deprecated",
        cutoverAt: now().toISOString(),
        ...(input.cutoverReason ? { cutoverReason: input.cutoverReason } : record.cutoverReason ? { cutoverReason: record.cutoverReason } : {})
      };
      await metadataStore.upsertVersion(deprecated);
      return mutationResult(seriesId, deprecated, metadataStore, options.productService, options.projectionStore, now);
    },

    async requestRevocation(seriesId, versionId, input, principal) {
      if (!options.governanceService) {
        throw new StoreZhixuVersionError(503, "governance_service_unavailable", "governance service is unavailable");
      }
      const record = await ensureVersionRecord({
        metadataStore,
        productService: options.productService,
        projectionStore: options.projectionStore,
        seriesId,
        versionId,
        input,
        now
      });
      const domainId = normalizeBytes32(input.domainId ?? DEFAULT_OFFICIAL_DOMAIN_ID, "domainId");
      const revocation = await options.governanceService.revokeZhixu({
        domainId,
        planId: record.planId,
        subjectId: record.zhixuId,
        reason: input.reason ?? input.publicSummary ?? "Store operator requested plan revocation.",
        ...(input.publicSummary ? { publicSummary: input.publicSummary } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
      }, principal);
      return {
        sourceOfTruth: "contracts-and-chain-events",
        version: await summarizeRecord(record, options.productService, options.projectionStore),
        revocation
      };
    },

    async resolveActiveVersion(zhixuId) {
      const records = await effectiveVersionRecords({
        seriesId: zhixuId,
        metadataStore,
        productService: options.productService,
        projectionStore: options.projectionStore,
        now
      });
      const persistedRecords = await metadataStore.listVersions(zhixuId);
      const activeRecord = persistedRecords.length > 0
        ? records.find((record) => record.status === "active")
        : records[0];
      return activeRecord
        ? summarizeRecord(activeRecord, options.productService, options.projectionStore)
        : undefined;
    }
  };
}

async function mutationResult(
  seriesId: string,
  record: StoreZhixuVersionRecord,
  metadataStore: StoreZhixuVersionMetadataStore,
  productService: ProductService,
  projectionStore: ProjectionStore,
  now: () => Date
): Promise<StoreZhixuVersionMutationDTO> {
  const [version, versions] = await Promise.all([
    summarizeRecord(record, productService, projectionStore),
    summarizeSeries({ seriesId, metadataStore, productService, projectionStore, now })
  ]);
  return {
    sourceOfTruth: "contracts-and-chain-events",
    seriesId,
    version,
    versions
  };
}

async function ensureVersionRecord(input: {
  readonly metadataStore: StoreZhixuVersionMetadataStore;
  readonly productService: ProductService;
  readonly projectionStore: ProjectionStore;
  readonly seriesId: string;
  readonly versionId: string;
  readonly input: StoreZhixuVersionMutationInput;
  readonly now: () => Date;
}): Promise<StoreZhixuVersionRecord> {
  const existing = await input.metadataStore.getVersion(input.seriesId, input.versionId);
  if (existing) {
    return patchVersionRecord(existing, input.input);
  }
  const effective = await effectiveVersionRecords({
    seriesId: input.seriesId,
    metadataStore: input.metadataStore,
    productService: input.productService,
    projectionStore: input.projectionStore,
    now: input.now
  });
  const synthesized = effective.find((record) => record.versionId === input.versionId);
  if (synthesized) {
    return patchVersionRecord(synthesized, input.input);
  }
  if (!input.input.planId || !input.input.planHash) {
    throw new StoreZhixuVersionError(404, "version_not_found", "Store zhixu version not found", {
      seriesId: input.seriesId,
      versionId: input.versionId
    });
  }
  return {
    versionId: input.versionId,
    zhixuId: input.input.zhixuId ?? input.seriesId,
    seriesId: input.seriesId,
    versionLabel: input.input.versionLabel ?? input.versionId,
    status: "candidate",
    planId: normalizeBytes32(input.input.planId, "planId"),
    planHash: normalizeBytes32(input.input.planHash, "planHash"),
    ...(input.input.artifactHash ? { artifactHash: normalizeBytes32(input.input.artifactHash, "artifactHash") } : {}),
    createdAt: input.now().toISOString(),
    ...(input.input.cutoverReason ? { cutoverReason: input.input.cutoverReason } : {})
  };
}

function patchVersionRecord(
  record: StoreZhixuVersionRecord,
  input: StoreZhixuVersionMutationInput
): StoreZhixuVersionRecord {
  return {
    ...record,
    ...(input.zhixuId ? { zhixuId: input.zhixuId } : {}),
    ...(input.versionLabel ? { versionLabel: input.versionLabel } : {}),
    ...(input.planId ? { planId: normalizeBytes32(input.planId, "planId") } : {}),
    ...(input.planHash ? { planHash: normalizeBytes32(input.planHash, "planHash") } : {}),
    ...(input.artifactHash ? { artifactHash: normalizeBytes32(input.artifactHash, "artifactHash") } : {}),
    ...(input.cutoverReason ? { cutoverReason: input.cutoverReason } : {})
  };
}

async function summarizeSeries(input: {
  readonly seriesId: string;
  readonly metadataStore: StoreZhixuVersionMetadataStore;
  readonly productService: ProductService;
  readonly projectionStore: ProjectionStore;
  readonly now: () => Date;
}): Promise<readonly StoreZhixuVersionSummaryDTO[]> {
  const records = await effectiveVersionRecords(input);
  const summaries = await Promise.all(records.map((record) =>
    summarizeRecord(record, input.productService, input.projectionStore)
  ));
  return summaries.sort(compareVersionSummaries);
}

async function effectiveVersionRecords(input: {
  readonly seriesId: string;
  readonly metadataStore: StoreZhixuVersionMetadataStore;
  readonly productService: ProductService;
  readonly projectionStore: ProjectionStore;
  readonly now: () => Date;
}): Promise<readonly StoreZhixuVersionRecord[]> {
  const records = await input.metadataStore.listVersions(input.seriesId);
  if (records.length > 0) {
    return records;
  }
  const synthesized = await synthesizeDefaultVersion(input.seriesId, input.productService, input.now);
  return synthesized ? [synthesized] : [];
}

async function synthesizeDefaultVersion(
  seriesId: string,
  productService: ProductService,
  now: () => Date
): Promise<StoreZhixuVersionRecord | undefined> {
  const zhixu = await productService.getZhixu(seriesId, { includeUnattested: true });
  if (!zhixu) {
    return undefined;
  }
  return {
    versionId: defaultVersionId(seriesId, zhixu.chainAttestation.planId),
    zhixuId: zhixu.zhixuId,
    seriesId,
    versionLabel: "当前版本",
    status: zhixu.chainAttestation.status === "attested" ? "active" : "candidate",
    planId: normalizeBytes32(zhixu.chainAttestation.planId, "planId"),
    planHash: normalizeBytes32(zhixu.chainAttestation.planHash, "planHash"),
    ...(zhixu.chainAttestation.artifactHash
      ? { artifactHash: normalizeBytes32(zhixu.chainAttestation.artifactHash, "artifactHash") }
      : {}),
    createdAt: zhixu.updatedAt || now().toISOString()
  };
}

async function summarizeRecord(
  record: StoreZhixuVersionRecord,
  productService: ProductService,
  projectionStore: ProjectionStore
): Promise<StoreZhixuVersionSummaryDTO> {
  const [trustSnapshot, orders] = await Promise.all([
    projectionStore.getTrustSnapshot(),
    productService.listOrders()
  ]);
  const trust = planTrustForRecord(trustSnapshot, record);
  const attestationStatus = attestationStatusForTrust(trust);
  const artifactHash = record.artifactHash ?? trust?.artifactHash;
  return {
    versionId: record.versionId,
    zhixuId: record.zhixuId,
    seriesId: record.seriesId,
    versionLabel: record.versionLabel,
    status: trust?.revoked ? "revoked" : record.status,
    planId: record.planId,
    planHash: record.planHash,
    ...(artifactHash ? { artifactHash } : {}),
    attestationStatus,
    orderCount: orders.filter((order) =>
      order.planId === record.planId && (!order.planHash || order.planHash === record.planHash)
    ).length,
    createdAt: record.createdAt,
    ...(record.cutoverAt ? { cutoverAt: record.cutoverAt } : {}),
    ...(record.cutoverReason ? { cutoverReason: record.cutoverReason } : {})
  };
}

function assertActivatable(version: StoreZhixuVersionSummaryDTO): void {
  if (version.attestationStatus === "revoked" || version.status === "revoked") {
    throw new StoreZhixuVersionError(409, "plan_revoked", "revoked Store zhixu version cannot be activated", {
      versionId: version.versionId,
      planId: version.planId
    });
  }
  if (version.attestationStatus !== "attested") {
    throw new StoreZhixuVersionError(403, "plan_not_attested", "Store zhixu version must be attested before activation", {
      versionId: version.versionId,
      planId: version.planId
    });
  }
}

function planTrustForRecord(
  snapshot: TrustProjectionSnapshot,
  record: StoreZhixuVersionRecord
): PlanTrustProjection | undefined {
  return Object.values(snapshot.plans).find((plan) =>
    plan.domainId === DEFAULT_OFFICIAL_DOMAIN_ID &&
    plan.planId === record.planId &&
    plan.planHash === record.planHash
  );
}

function attestationStatusForTrust(trust: PlanTrustProjection | undefined): ChainAttestationStatus {
  if (!trust) {
    return "not_found";
  }
  return trust.revoked ? "revoked" : "attested";
}

function defaultVersionId(seriesId: string, planId: string): string {
  return `${seriesId}@${shortId(planId)}`;
}

function versionKey(seriesId: string, versionId: string): string {
  return `${seriesId}:${versionId}`;
}

function compareVersionRecords(left: StoreZhixuVersionRecord, right: StoreZhixuVersionRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.versionId.localeCompare(right.versionId);
}

function compareVersionSummaries(
  left: StoreZhixuVersionSummaryDTO,
  right: StoreZhixuVersionSummaryDTO
): number {
  return statusRank(left.status) - statusRank(right.status) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.versionId.localeCompare(right.versionId);
}

function statusRank(status: StoreZhixuVersionStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "candidate":
      return 1;
    case "deprecated":
      return 2;
    case "revoked":
      return 3;
    case "rejected":
      return 4;
  }
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}
