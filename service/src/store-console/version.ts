import {
  type PlanPublicationStatus,
  type StoreZhixuVersionStatus,
  type StoreZhixuVersionSummaryDTO,
} from "@uvp-eth/product-dto";
import type { ProductService } from "../product/service.js";
import { normalizeBytes32, type Hex } from "../shared/types.js";
import type { ProjectionStore } from "../storage/projection-store.js";

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
  /**
   * activate 的"旧 active 批量 deprecated + 新
   * active 落库"必须事务化，中途失败不得留下无 active 或双 active 的
   * 中间态。持久后端提供；内存后端顺序执行即可。
   */
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

export function createStoreZhixuVersionService(options: {
  readonly productService: ProductService;
  readonly projectionStore: ProjectionStore;
  readonly metadataStore?: StoreZhixuVersionMetadataStore;
  readonly now?: () => Date;
}): StoreZhixuVersionService {
  const metadataStore: StoreZhixuVersionMetadataStore =
    options.metadataStore ?? new MemoryStoreZhixuVersionMetadataStore();
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
      const summary = await summarizeRecord(
        record,
        options.productService,
        options.projectionStore,
      );
      // 激活确认取服务端记录——publicationStatus 由
      // 链投影（stateMachinePlans）判定，调用方自报的 planId/planHash 不是
      // 激活的依据；记录锚不可改（patchVersionRecord 拒绝）。
      assertActivatable(summary);
      const cutoverAt = now().toISOString();
      const existing = await effectiveVersionRecords({
        seriesId,
        metadataStore,
        productService: options.productService,
        projectionStore: options.projectionStore,
        now,
      });
      // cutover（旧 active 批量 deprecated + 新 active 落库）
      // 事务化；持久后端中途失败整体回滚，不留双 active/无 active 中间态。
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
        ? await metadataStore.withTransaction(applyCutover)
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
            options.productService,
            options.projectionStore,
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
  const [version, versions] = await Promise.all([
    summarizeRecord(record, productService, projectionStore),
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
    version,
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
  // 新建版本记录的锚（planId/planHash）必须在
  // 链投影中真实存在——否则可凭空登记任意 plan 的"版本"再激活。
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
  // 版本记录的链锚不可改——planId/planHash/
  // artifactHash 只能在创建时给定；调用方在其后携带不同锚即 409，
  // 防止"改锚任意 plan"把既有版本偷换到另一个 plan 上。
  for (const [field, rawValue] of [
    ["planId", input.planId],
    ["planHash", input.planHash],
    ["artifactHash", input.artifactHash],
  ] as const) {
    if (rawValue === undefined) {
      continue;
    }
    const normalized = normalizeBytes32(rawValue, field);
    const current = (record as unknown as { readonly [key: string]: string | undefined })[field];
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
  const records = await effectiveVersionRecords(input);
  const summaries = await Promise.all(
    records.map((record) =>
      summarizeRecord(record, input.productService, input.projectionStore),
    ),
  );
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
  // 投影桶在 commitPlan 第一步即建、PlanRegistered 到 finalize 才发：
  // 默认版本只对"已 finalize"的 plan 合成 active，否则待定计划可被
  // 直接激活建单（UVP-02）。
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

async function summarizeRecord(
  record: StoreZhixuVersionRecord,
  productService: ProductService,
  projectionStore: ProjectionStore,
): Promise<StoreZhixuVersionSummaryDTO> {
  const [orderSnapshot, orders] = await Promise.all([
    projectionStore.getOrderSnapshot(),
    productService.listOrders(),
  ]);
  // "published" 要求链上已 finalize（PlanFinalized/PlanRegistered 均在
  // finalize 交易内发出）：投影桶在 commitPlan 即建，仅凭桶存在会把
  // 待定计划当成已发布（UVP-02）。
  const plan = findFinalizedPlan(orderSnapshot, record.planId, record.planHash);
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
    orderCount: orders.filter(
      (order) =>
        order.planId === record.planId &&
        (!order.planHash || order.planHash === record.planHash),
    ).length,
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

/**
 * 已注册（PlanRegistered）的 plan 查找：投影桶在 commitPlan 即建，
 * registeredAt 初始携带 commit 溯源、PlanRegistered 到达后被 finalize
 * 交易溯源覆写——以"registeredAt 晚于 committedAt（或无 commit 溯源）
 * / finalizedAt 已落"作为已注册判据，待定（仅 commit）计划不算。
 */
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
    // 只见过 PlanRegistered（截断流建桶）——注册事实已存在。
    return true;
  }
  const committed = plan.committedAt;
  const registered = plan.registeredAt;
  return (
    registered.transactionHash !== committed.transactionHash ||
    registered.logIndex !== committed.logIndex
  );
}

/** 供 listing 锚核验等域复用的"PlanRegistered 已被索引"判据。 */
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
