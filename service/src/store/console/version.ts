import {
  type PlanPublicationStatus,
  type StoreZhixuVersionStatus,
  type StoreZhixuVersionSummaryDTO,
} from "@uvp-eth/product-dto";
import type { ProductService } from "../../product/application/service.js";
import { normalizeBytes32, type Hex } from "../../shared/types.js";
import { StorageConstraintError } from "../../storage/errors.js";
import type { ProjectionStore } from "../../storage/projection-store.js";

export interface StoreZhixuVersionService {
  listVersions(seriesId: string): Promise<StoreZhixuVersionListDTO>;
  activate(
    seriesId: string,
    versionId: string,
    input?: StoreZhixuVersionMutationInput,
  ): Promise<StoreZhixuVersionMutationDTO>;
  deprecate(
    seriesId: string,
    versionId: string,
    input?: StoreZhixuVersionMutationInput,
  ): Promise<StoreZhixuVersionMutationDTO>;
  resolveActiveVersion(
    zhixuId: string,
  ): Promise<StoreZhixuVersionSummaryDTO | undefined>;
}

export interface StoreZhixuVersionListDTO {
  readonly sourceOfTruth: "contracts-and-chain-events";
  readonly seriesId: string;
  readonly versions: readonly StoreZhixuVersionSummaryDTO[];
}

export interface StoreZhixuVersionMutationDTO extends StoreZhixuVersionListDTO {
  readonly version: StoreZhixuVersionSummaryDTO;
}

export interface StoreZhixuVersionMutationInput {
  readonly zhixuId?: string;
  readonly versionLabel?: string;
  readonly planId?: string;
  readonly planHash?: string;
  readonly artifactHash?: string;
  readonly cutoverReason?: string;
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
  getVersion(
    seriesId: string,
    versionId: string,
  ): Promise<StoreZhixuVersionRecord | undefined>;
  upsertVersion(record: StoreZhixuVersionRecord): Promise<void>;
  withTransaction?<T>(operation: () => Promise<T>): Promise<T>;
}

export class MemoryStoreZhixuVersionMetadataStore
  implements StoreZhixuVersionMetadataStore
{
  readonly #records = new Map<string, StoreZhixuVersionRecord>();

  async listVersions(
    seriesId: string,
  ): Promise<readonly StoreZhixuVersionRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.seriesId === seriesId)
      .sort(compareVersionRecords);
  }

  async getVersion(
    seriesId: string,
    versionId: string,
  ): Promise<StoreZhixuVersionRecord | undefined> {
    return this.#records.get(versionKey(seriesId, versionId));
  }

  async upsertVersion(record: StoreZhixuVersionRecord): Promise<void> {
    if (record.status === "active") {
      for (const [key, item] of this.#records) {
        if (item.seriesId === record.seriesId && item.status === "active" && item.versionId !== record.versionId) {
          this.#records.set(key, {
            ...item,
            status: "deprecated",
            cutoverReason: "Superseded by active Store version.",
          });
        }
      }
    }
    this.#records.set(versionKey(record.seriesId, record.versionId), record);
  }
}

export class StoreZhixuVersionError extends Error {
  override readonly name = "StoreZhixuVersionError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function mapActivationConflict(error: unknown): unknown {
  if (error instanceof StorageConstraintError) {
    return new StoreZhixuVersionError(
      409,
      "version_activation_conflict",
      "another activation won the cutover for this series; re-read the series and retry",
      {},
    );
  }
  return error;
}

export function createStoreZhixuVersionService(options: {
  readonly productService: ProductService;
  readonly projectionStore: ProjectionStore;
  readonly metadataStore: StoreZhixuVersionMetadataStore;
  readonly now?: () => Date;
}): StoreZhixuVersionService {
  const metadataStore: StoreZhixuVersionMetadataStore = options.metadataStore;
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
          now,
        }),
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
        now,
      });
      const view = await loadVersionSummaryView(
        options.productService,
        options.projectionStore,
      );
      const summary = summarizeRecord(record, view);
      assertActivatable(summary);
      const cutoverAt = now().toISOString();
      const existing = await effectiveVersionRecords({
        seriesId,
        metadataStore,
        productService: options.productService,
        projectionStore: options.projectionStore,
        now,
      });
      const applyCutover = async (): Promise<StoreZhixuVersionRecord> => {
        for (const item of existing) {
          if (item.versionId === record.versionId) {
            continue;
          }
          if (item.status === "active") {
            await metadataStore.upsertVersion({
              ...item,
              status: "deprecated",
              cutoverAt,
              cutoverReason: "Superseded by active Store version.",
            });
          }
        }
        const active: StoreZhixuVersionRecord = {
          ...record,
          status: "active",
          cutoverAt,
          ...(input.cutoverReason
            ? { cutoverReason: input.cutoverReason }
            : record.cutoverReason
              ? { cutoverReason: record.cutoverReason }
              : {}),
        };
        await metadataStore.upsertVersion(active);
        return active;
      };
      const active = metadataStore.withTransaction
        ? await metadataStore.withTransaction(applyCutover).catch((error: unknown) => {
          throw mapActivationConflict(error);
        })
        : await applyCutover();
      return mutationResult(
        seriesId,
        active,
        metadataStore,
        options.productService,
        options.projectionStore,
        now,
      );
    },

    async deprecate(seriesId, versionId, input = {}) {
      const record = await ensureVersionRecord({
        metadataStore,
        productService: options.productService,
        projectionStore: options.projectionStore,
        seriesId,
        versionId,
        input,
        now,
      });
      const deprecated: StoreZhixuVersionRecord = {
        ...record,
        status: "deprecated",
        cutoverAt: now().toISOString(),
        ...(input.cutoverReason
          ? { cutoverReason: input.cutoverReason }
          : record.cutoverReason
            ? { cutoverReason: record.cutoverReason }
            : {}),
      };
      await metadataStore.upsertVersion(deprecated);
      return mutationResult(
        seriesId,
        deprecated,
        metadataStore,
        options.productService,
        options.projectionStore,
        now,
      );
    },

    async resolveActiveVersion(zhixuId) {
      const records = await effectiveVersionRecords({
        seriesId: zhixuId,
        metadataStore,
        productService: options.productService,
        projectionStore: options.projectionStore,
        now,
      });
      const persistedRecords = await metadataStore.listVersions(zhixuId);
      const activeRecord =
        persistedRecords.length > 0
          ? records.find((record) => record.status === "active")
          : records[0];
      return activeRecord
        ? summarizeRecord(
            activeRecord,
            await loadVersionSummaryView(
              options.productService,
              options.projectionStore,
            ),
          )
        : undefined;
    },
  };
}

async function mutationResult(
  seriesId: string,
  record: StoreZhixuVersionRecord,
  metadataStore: StoreZhixuVersionMetadataStore,
  productService: ProductService,
  projectionStore: ProjectionStore,
  now: () => Date,
): Promise<StoreZhixuVersionMutationDTO> {
  const [view, versions] = await Promise.all([
    loadVersionSummaryView(productService, projectionStore),
    summarizeSeries({
      seriesId,
      metadataStore,
      productService,
      projectionStore,
      now,
    }),
  ]);
  return {
    sourceOfTruth: "contracts-and-chain-events",
    seriesId,
    version: summarizeRecord(record, view),
    versions,
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
  const existing = await input.metadataStore.getVersion(
    input.seriesId,
    input.versionId,
  );
  if (existing) {
    return patchVersionRecord(existing, input.input);
  }
  const effective = await effectiveVersionRecords({
    seriesId: input.seriesId,
    metadataStore: input.metadataStore,
    productService: input.productService,
    projectionStore: input.projectionStore,
    now: input.now,
  });
  const synthesized = effective.find(
    (record) => record.versionId === input.versionId,
  );
  if (synthesized) {
    return patchVersionRecord(synthesized, input.input);
  }
  if (!input.input.planId || !input.input.planHash) {
    throw new StoreZhixuVersionError(
      404,
      "version_not_found",
      "Store zhixu version not found",
      {
        seriesId: input.seriesId,
        versionId: input.versionId,
      },
    );
  }
  const planId = normalizeBytes32(input.input.planId, "planId");
  const planHash = normalizeBytes32(input.input.planHash, "planHash");
  const snapshot = await input.projectionStore.getOrderSnapshot();
  const plan = findFinalizedPlan(snapshot, planId, planHash);
  if (!plan) {
    throw new StoreZhixuVersionError(
      409,
      "plan_not_projected",
      "a new Store zhixu version record must anchor to a plan that is finalized (PlanRegistered) in the chain projection",
      { seriesId: input.seriesId, versionId: input.versionId, planId }
    );
  }
  return {
    versionId: input.versionId,
    zhixuId: input.input.zhixuId ?? input.seriesId,
    seriesId: input.seriesId,
    versionLabel: input.input.versionLabel ?? input.versionId,
    status: "candidate",
    planId,
    planHash,
    ...(input.input.artifactHash
      ? {
          artifactHash: normalizeBytes32(
            input.input.artifactHash,
            "artifactHash",
          ),
        }
      : {}),
    createdAt: input.now().toISOString(),
    ...(input.input.cutoverReason
      ? { cutoverReason: input.input.cutoverReason }
      : {}),
  };
}

function patchVersionRecord(
  record: StoreZhixuVersionRecord,
  input: StoreZhixuVersionMutationInput,
): StoreZhixuVersionRecord {
  for (const [field, rawValue] of [
    ["planId", input.planId],
    ["planHash", input.planHash],
    ["artifactHash", input.artifactHash],
  ] as const) {
    if (rawValue === undefined) {
      continue;
    }
    const normalized = normalizeBytes32(rawValue, field);
    const currentValue = record[field];
    const current = typeof currentValue === "string" ? currentValue : undefined;
    if (current && current.toLowerCase() !== normalized.toLowerCase()) {
      throw new StoreZhixuVersionError(
        409,
        "version_anchor_immutable",
        `version ${field} is immutable once the version record exists`,
        { versionId: record.versionId, field },
      );
    }
  }
  return {
    ...record,
    ...(input.zhixuId ? { zhixuId: input.zhixuId } : {}),
    ...(input.versionLabel ? { versionLabel: input.versionLabel } : {}),
    ...(input.planId
      ? { planId: normalizeBytes32(input.planId, "planId") }
      : {}),
    ...(input.planHash
      ? { planHash: normalizeBytes32(input.planHash, "planHash") }
      : {}),
    ...(input.artifactHash
      ? { artifactHash: normalizeBytes32(input.artifactHash, "artifactHash") }
      : {}),
    ...(input.cutoverReason ? { cutoverReason: input.cutoverReason } : {}),
  };
}

async function summarizeSeries(input: {
  readonly seriesId: string;
  readonly metadataStore: StoreZhixuVersionMetadataStore;
  readonly productService: ProductService;
  readonly projectionStore: ProjectionStore;
  readonly now: () => Date;
}): Promise<readonly StoreZhixuVersionSummaryDTO[]> {
  const [records, view] = await Promise.all([
    effectiveVersionRecords(input),
    loadVersionSummaryView(input.productService, input.projectionStore),
  ]);
  return records
    .map((record) => summarizeRecord(record, view))
    .sort(compareVersionSummaries);
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
  const synthesized = await synthesizeDefaultVersion(
    input.seriesId,
    input.productService,
    input.projectionStore,
    input.now,
  );
  return synthesized ? [synthesized] : [];
}

async function synthesizeDefaultVersion(
  seriesId: string,
  productService: ProductService,
  projectionStore: ProjectionStore,
  now: () => Date,
): Promise<StoreZhixuVersionRecord | undefined> {
  const zhixu = await productService.getZhixu(seriesId);
  if (!zhixu) {
    return undefined;
  }
  const snapshot = await projectionStore.getOrderSnapshot();
  const planId = normalizeBytes32(zhixu.planPublication.planId, "planId");
  const planHash = normalizeBytes32(zhixu.planPublication.planHash, "planHash");
  if (!findFinalizedPlan(snapshot, planId, planHash)) {
    return undefined;
  }
  return {
    versionId: defaultVersionId(seriesId, zhixu.planPublication.planId),
    zhixuId: zhixu.zhixuId,
    seriesId,
    versionLabel: "当前版本",
    status: "active",
    planId: normalizeBytes32(zhixu.planPublication.planId, "planId"),
    planHash: normalizeBytes32(zhixu.planPublication.planHash, "planHash"),
    ...(zhixu.planPublication.artifactHash
      ? {
          artifactHash: normalizeBytes32(
            zhixu.planPublication.artifactHash,
            "artifactHash",
          ),
        }
      : {}),
    createdAt: zhixu.updatedAt || now().toISOString(),
  };
}

interface VersionSummaryView {
  readonly snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>;
  readonly orderCountByPlanAndHash: ReadonlyMap<string, number>;
  readonly orderCountByPlanWithoutHash: ReadonlyMap<string, number>;
}

async function loadVersionSummaryView(
  productService: ProductService,
  projectionStore: ProjectionStore,
): Promise<VersionSummaryView> {
  const [snapshot, orders] = await Promise.all([
    projectionStore.getOrderSnapshot(),
    productService.listOrders(),
  ]);
  const orderCountByPlanAndHash = new Map<string, number>();
  const orderCountByPlanWithoutHash = new Map<string, number>();
  for (const order of orders) {
    if (!order.planId) {
      continue;
    }
    if (!order.planHash) {
      orderCountByPlanWithoutHash.set(order.planId, (orderCountByPlanWithoutHash.get(order.planId) ?? 0) + 1);
      continue;
    }
    const key = versionOrderKey(order.planId, order.planHash);
    orderCountByPlanAndHash.set(key, (orderCountByPlanAndHash.get(key) ?? 0) + 1);
  }
  return { snapshot, orderCountByPlanAndHash, orderCountByPlanWithoutHash };
}

function versionOrderKey(planId: string, planHash: string): string {
  return `${planId}\u0000${planHash}`;
}

function orderCountForVersion(view: VersionSummaryView, planId: Hex, planHash: Hex): number {
  return (view.orderCountByPlanAndHash.get(versionOrderKey(planId, planHash)) ?? 0) +
    (view.orderCountByPlanWithoutHash.get(planId) ?? 0);
}

function summarizeRecord(
  record: StoreZhixuVersionRecord,
  view: VersionSummaryView,
): StoreZhixuVersionSummaryDTO {
  const plan = findFinalizedPlan(view.snapshot, record.planId, record.planHash);
  const publicationStatus: PlanPublicationStatus = plan ? "published" : "not_found";
  const artifactHash = record.artifactHash;
  return {
    versionId: record.versionId,
    zhixuId: record.zhixuId,
    seriesId: record.seriesId,
    versionLabel: record.versionLabel,
    status: record.status,
    planId: record.planId,
    planHash: record.planHash,
    ...(artifactHash ? { artifactHash } : {}),
    publicationStatus,
    orderCount: orderCountForVersion(view, record.planId, record.planHash),
    createdAt: record.createdAt,
    ...(record.cutoverAt ? { cutoverAt: record.cutoverAt } : {}),
    ...(record.cutoverReason ? { cutoverReason: record.cutoverReason } : {}),
  };
}

function assertActivatable(version: StoreZhixuVersionSummaryDTO): void {
  if (version.publicationStatus !== "published") {
    throw new StoreZhixuVersionError(
      409,
      "plan_not_published",
      "Store zhixu version must be finalized and registered on the state machine before activation",
      {
        versionId: version.versionId,
        planId: version.planId,
      },
    );
  }
}

function findFinalizedPlan(
  snapshot: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>,
  planId: Hex,
  planHash: Hex,
) {
  return Object.values(snapshot.stateMachinePlans).find(
    (candidate) =>
      candidate.planId.toLowerCase() === planId.toLowerCase() &&
      candidate.planHash.toLowerCase() === planHash.toLowerCase() &&
      isPlanRegistered(candidate),
  );
}

function isPlanRegistered(
  plan: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>["stateMachinePlans"][string],
): boolean {
  if (plan.finalizedAt !== undefined) {
    return true;
  }
  if (plan.committedAt === undefined) {
    return true;
  }
  const committed = plan.committedAt;
  const registered = plan.registeredAt;
  return (
    registered.transactionHash !== committed.transactionHash ||
    registered.logIndex !== committed.logIndex
  );
}

export function isPlanRegisteredProjection(
  plan: Awaited<ReturnType<ProjectionStore["getOrderSnapshot"]>>["stateMachinePlans"][string],
): boolean {
  return isPlanRegistered(plan);
}

function defaultVersionId(seriesId: string, planId: string): string {
  return `${seriesId}@${shortId(planId)}`;
}

function versionKey(seriesId: string, versionId: string): string {
  return `${seriesId}:${versionId}`;
}

function compareVersionRecords(
  left: StoreZhixuVersionRecord,
  right: StoreZhixuVersionRecord,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.versionId.localeCompare(right.versionId)
  );
}

function compareVersionSummaries(
  left: StoreZhixuVersionSummaryDTO,
  right: StoreZhixuVersionSummaryDTO,
): number {
  return (
    statusRank(left.status) - statusRank(right.status) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.versionId.localeCompare(right.versionId)
  );
}

function statusRank(status: StoreZhixuVersionStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "candidate":
      return 1;
    case "deprecated":
      return 2;
    case "rejected":
      return 3;
  }
}

function shortId(value: string): string {
  return value.length > 16
    ? `${value.slice(0, 8)}...${value.slice(-6)}`
    : value;
}
