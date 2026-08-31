import {
  projectionStatusLabel,
  storeConsoleSummary,
  toStoreZhixuConsoleDTO,
  toStoreZhixuDetailDTO,
  type PlanPublicationStatus,
  type ReviewStatus,
  type StoreConsoleSummaryDTO,
  type StoreOrderCandidateDTO,
  type StoreOrderCandidatesResponseDTO,
  type StoreProjectionStatusDTO,
  type StoreProjectionSyncStatus,
  type StoreSearchResponseDTO,
  type StoreSearchResultDTO,
  type StoreSearchSourceOfTruth,
  type StoreSearchType,
  type StoreZhixuConsoleDTO,
  type StoreZhixuDetailDTO,
  type StoreZhixuLifecycleStatus,
  type ZhixuDetailDTO,
  type ZhixuSummaryDTO
} from "@uvp-eth/product-dto";
import type { StateMachineOrderProjection } from "../indexer/projections.js";
import type { ProductOrderApiDTO, ProductService, ProductTaskApiDTO } from "../product/service.js";
import type { ProjectionStore, ProjectionSyncState } from "../storage/projection-store.js";
import type { StoreSupplierMetadataRecord, StoreSupplierMetadataStore } from "../store-suppliers/types.js";

export interface StoreConsoleListQuery {
  readonly query?: string;
  readonly lifecycle?: StoreZhixuLifecycleStatus | "all";
  readonly review?: ReviewStatus | "all";
  readonly publication?: PlanPublicationStatus | "all";
}

export interface StoreSearchQuery {
  readonly query?: string;
  readonly type?: StoreSearchType;
  readonly limit?: number;
}

export interface StoreConsoleListDTO {
  readonly sourceOfTruth: "contracts-and-chain-events";
  readonly summary: StoreConsoleSummaryDTO;
  readonly zhixus: readonly StoreZhixuConsoleDTO[];
  readonly projectionStatus?: StoreProjectionStatusDTO;
}

export interface StoreConsoleService {
  listZhixus(query?: StoreConsoleListQuery): Promise<StoreConsoleListDTO>;
  getZhixu(zhixuId: string): Promise<StoreZhixuDetailDTO | undefined>;
  search(query: StoreSearchQuery): Promise<StoreSearchResponseDTO>;
  listOrderCandidates(orderId: string): Promise<StoreOrderCandidatesResponseDTO>;
}

export function createStoreConsoleService(options: {
  readonly productService: ProductService;
  readonly store: ProjectionStore;
  readonly supplierMetadataStore: StoreSupplierMetadataStore;
}): StoreConsoleService {
  return {
    async listZhixus(query = {}) {
      const [zhixus, syncState] = await Promise.all([
        buildStoreConsoleZhixus(options),
        options.store.getSyncState()
      ]);
      const filtered = filterStoreZhixus(zhixus, query);
      const projectionStatus = projectionStatusFromSyncState(syncState);
      return {
        sourceOfTruth: "contracts-and-chain-events",
        summary: storeConsoleSummary(filtered),
        zhixus: filtered,
        ...(projectionStatus ? { projectionStatus } : {})
      };
    },

    async getZhixu(zhixuId) {
      const normalized = normalizeSearchText(zhixuId);
      const row = (await buildStoreConsoleZhixus(options)).find((candidate) =>
        normalizeSearchText(candidate.zhixuId) === normalized
      );
      if (!row) {
        return undefined;
      }
      const zhixu = await options.productService.getZhixu(row.zhixuId);
      return zhixu ? toStoreZhixuDetailDTO(row, zhixu) : toStoreZhixuDetailDTO(row, detailFallbackFromRow(row));
    },

    async search(query) {
      return searchStore(options, query);
    },

    async listOrderCandidates(orderId) {
      return listOrderCandidates(options, orderId);
    }
  };
}

async function buildStoreConsoleZhixus(options: {
  readonly productService: ProductService;
  readonly store: ProjectionStore;
  readonly supplierMetadataStore: StoreSupplierMetadataStore;
}): Promise<readonly StoreZhixuConsoleDTO[]> {
  const [listedZhixus, orders, tasks, suppliers] = await Promise.all([
    options.productService.listZhixu(),
    options.productService.listOrders(),
    options.productService.listTasks(),
    options.supplierMetadataStore.listSuppliers()
  ]);
  const activeSupplierCount = suppliers.filter(
    (supplier) => supplier.reviewStatus !== "rejected" && supplier.reviewStatus !== "revoked"
  ).length;
  const rows = listedZhixus
    .map((zhixu) => consoleRowFromSummary(zhixu, {
      activeSupplierCount,
      openTaskCount: tasks.filter((task) => task.zhixuId === zhixu.zhixuId && task.status === "open").length,
      orderCount: orders.filter((order) => order.zhixuId === zhixu.zhixuId).length
    }));

  return rows.sort((left, right) =>
    lifecycleRank(left.lifecycleStatus) - lifecycleRank(right.lifecycleStatus) ||
    left.title.localeCompare(right.title)
  );
}

function consoleRowFromSummary(
  zhixu: ZhixuSummaryDTO,
  metrics: {
    readonly orderCount: number;
    readonly openTaskCount: number;
    readonly activeSupplierCount: number;
  }
): StoreZhixuConsoleDTO {
  return toStoreZhixuConsoleDTO(zhixu, {
    orderCount: metrics.orderCount,
    openTaskCount: metrics.openTaskCount,
    supplierCount: metrics.activeSupplierCount,
    versionLabel: zhixu.planPublication.status === "published" ? "链上当前版本" : "本地候选版本"
  });
}

async function searchStore(
  options: {
    readonly productService: ProductService;
    readonly store: ProjectionStore;
    readonly supplierMetadataStore: StoreSupplierMetadataStore;
  },
  query: StoreSearchQuery
): Promise<StoreSearchResponseDTO> {
  const rawQuery = query.query ?? "";
  const normalizedQuery = normalizeSearchText(rawQuery);
  const type = query.type ?? "all";
  const limit = clampLimit(query.limit);
  const [zhixuList, orders, suppliers, syncState] = await Promise.all([
    buildStoreConsoleZhixus(options),
    options.productService.listOrders(),
    options.supplierMetadataStore.listSuppliers(),
    options.store.getSyncState()
  ]);
  const detailsById = await buildZhixuDetailsById(options.productService, zhixuList);
  const projectionStatus = projectionStatusFromSyncState(syncState);
  const results: StoreSearchResultDTO[] = [];
  const seen = new Set<string>();
  let ambiguousExactOrderId = false;

  const pushResult = (result: StoreSearchResultDTO): void => {
    const key = `${result.resultType}:${result.id}:${result.primaryHref}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(result);
    }
  };

  if (normalizedQuery.length > 0 && searchIncludes(type, "order")) {
    const candidates = await listOrderCandidates(options, rawQuery);
    if (candidates.candidateCount > 1) {
      ambiguousExactOrderId = true;
      pushResult(ambiguousOrderSearchResult(candidates));
    } else if (candidates.candidateCount === 1) {
      pushResult(orderCandidateSearchResult(candidates.candidates[0]!, ["orderId"]));
    }
  }

  if (normalizedQuery.length > 0 && searchIncludes(type, "zhixu")) {
    const exactZhixu = zhixuList.find((zhixu) => normalizeSearchText(zhixu.zhixuId) === normalizedQuery);
    if (exactZhixu) {
      pushResult(zhixuSearchResult(exactZhixu, ["zhixuId"]));
    }
  }

  if (normalizedQuery.length > 0 && searchIncludes(type, "supplier")) {
    for (const supplier of suppliers) {
      const matchedFields = exactSupplierMatchedFields(supplier, normalizedQuery);
      if (matchedFields.length > 0) {
        pushResult(supplierSearchResult(supplier, matchedFields));
      }
    }
  }

  if (normalizedQuery.length === 0) {
    if (searchIncludes(type, "zhixu")) {
      for (const zhixu of zhixuList.filter((item) => item.lifecycleStatus === "active")) {
        pushResult(zhixuSearchResult(zhixu, ["recent-active"]));
      }
    }
  } else {
    if (searchIncludes(type, "zhixu")) {
      for (const zhixu of zhixuList) {
        const matchedFields = zhixuMatchedFields(zhixu, detailsById.get(zhixu.zhixuId), normalizedQuery);
        if (matchedFields.length > 0) {
          pushResult(zhixuSearchResult(zhixu, matchedFields));
        }
      }
    }

    if (searchIncludes(type, "order")) {
      for (const order of orders) {
        if (ambiguousExactOrderId && normalizeSearchText(order.orderId) === normalizedQuery) {
          continue;
        }
        const matchedFields = orderMatchedFields(order, normalizedQuery);
        if (matchedFields.length > 0) {
          pushResult(orderSearchResult(order, matchedFields));
        }
      }
    }

    if (searchIncludes(type, "supplier")) {
      for (const supplier of suppliers) {
        const matchedFields = supplierMatchedFields(supplier, normalizedQuery);
        if (matchedFields.length > 0) {
          pushResult(supplierSearchResult(supplier, matchedFields));
        }
      }
    }
  }

  const limited = results.slice(0, limit);
  return {
    sourceOfTruth: "contracts-and-chain-events",
    query: rawQuery,
    normalizedQuery,
    resultCount: limited.length,
    results: limited,
    ...(projectionStatus ? { projectionStatus } : {})
  };
}

async function listOrderCandidates(
  options: {
    readonly productService: ProductService;
    readonly store: ProjectionStore;
    readonly supplierMetadataStore: StoreSupplierMetadataStore;
  },
  orderId: string
): Promise<StoreOrderCandidatesResponseDTO> {
  const normalizedOrderId = normalizeSearchText(orderId);
  const [stateMachineOrders, syncState] = await Promise.all([
    options.store.findStateMachineOrdersByOrderId(orderId),
    options.store.getSyncState()
  ]);
  const candidates = [
    ...await Promise.all(stateMachineOrders.map((order) => orderCandidateZhixuId(options, order).then((zhixuId) => orderCandidateFromStateMachine(order, zhixuId))))
  ].sort((left, right) =>
    (left.chainId ?? 0) - (right.chainId ?? 0) ||
    (left.stateMachineAddress ?? "").localeCompare(right.stateMachineAddress ?? "") ||
    left.orderId.localeCompare(right.orderId)
  );
  const projectionStatus = projectionStatusFromSyncState(syncState);

  return {
    sourceOfTruth: "contracts-and-chain-events",
    orderId,
    normalizedOrderId,
    candidateCount: candidates.length,
    candidates,
    ...(projectionStatus ? { projectionStatus } : {})
  };
}

function filterStoreZhixus(
  zhixus: readonly StoreZhixuConsoleDTO[],
  query: StoreConsoleListQuery
): readonly StoreZhixuConsoleDTO[] {
  const normalizedQuery = normalizeSearchText(query.query ?? "");
  return zhixus.filter((zhixu) =>
    (!query.lifecycle || query.lifecycle === "all" || zhixu.lifecycleStatus === query.lifecycle) &&
    (!query.review || query.review === "all" || zhixu.reviewStatus === query.review) &&
    (!query.publication || query.publication === "all" || zhixu.planPublication.status === query.publication) &&
    (normalizedQuery.length === 0 || zhixuListQueryFields(zhixu).some((field) => field.includes(normalizedQuery)))
  );
}

function zhixuListQueryFields(zhixu: StoreZhixuConsoleDTO): readonly string[] {
  return [
    zhixu.zhixuId,
    zhixu.title,
    zhixu.subtitle,
    zhixu.maintainer,
    zhixu.lifecycleLabel,
    zhixu.reviewLabel,
    zhixu.riskLevel,
    zhixu.planId,
    zhixu.planHash
  ].map(normalizeSearchText);
}

async function buildZhixuDetailsById(
  productService: ProductService,
  zhixus: readonly StoreZhixuConsoleDTO[]
): Promise<ReadonlyMap<string, ZhixuDetailDTO>> {
  const entries = await Promise.all(zhixus.map(async (zhixu) => {
    const detail = await productService.getZhixu(zhixu.zhixuId);
    return detail ? [zhixu.zhixuId, detail] as const : undefined;
  }));
  return new Map(entries.filter((entry): entry is readonly [string, ZhixuDetailDTO] => entry !== undefined));
}

function zhixuMatchedFields(
  row: StoreZhixuConsoleDTO,
  detail: ZhixuDetailDTO | undefined,
  normalizedQuery: string
): readonly string[] {
  const fields: string[] = [];
  addMatch(fields, "zhixuId", row.zhixuId, normalizedQuery);
  addMatch(fields, "title", row.title, normalizedQuery);
  addMatch(fields, "subtitle", row.subtitle, normalizedQuery);
  addMatch(fields, "maintainer", row.maintainer, normalizedQuery);
  addMatch(fields, "lifecycle", row.lifecycleLabel, normalizedQuery);
  addMatch(fields, "review", row.reviewLabel, normalizedQuery);
  if (detail) {
    if (detail.applicableBusiness.some((tag) => normalizeSearchText(tag).includes(normalizedQuery)) ||
      detail.excludedBusiness.some((tag) => normalizeSearchText(tag).includes(normalizedQuery)) ||
      detail.supportedPaymentMethods.some((tag) => normalizeSearchText(tag).includes(normalizedQuery))) {
      fields.push("tags");
    }
    if (detail.stages.some((stage) =>
      [stage.name, stage.ownerRole, ...stage.evidence].some((field) => normalizeSearchText(field).includes(normalizedQuery))
    )) {
      fields.push("stages");
    }
    if (detail.roleSlots.some((slot) =>
      [slot.title, slot.label, slot.duty, ...slot.evidence].some((field) => normalizeSearchText(field).includes(normalizedQuery))
    )) {
      fields.push("roleSlots");
    }
  }
  return [...new Set(fields)];
}

function orderMatchedFields(order: ProductOrderApiDTO, normalizedQuery: string): readonly string[] {
  const fields: string[] = [];
  addMatch(fields, "orderId", order.orderId, normalizedQuery);
  addMatch(fields, "title", order.title, normalizedQuery);
  addMatch(fields, "zhixuId", order.zhixuId, normalizedQuery);
  addMatch(fields, "currentStage", order.currentStageName, normalizedQuery);
  addMatch(fields, "status", order.statusLabel, normalizedQuery);
  if (order.tasks?.some((task) => taskMatched(task, normalizedQuery))) {
    fields.push("tasks");
  }
  return [...new Set(fields)];
}

function taskMatched(task: ProductTaskApiDTO, normalizedQuery: string): boolean {
  return [
    task.taskId,
    task.title,
    task.subtitle,
    task.assigneeRole,
    task.assigneeWallet,
    task.stageName,
    ...task.requiredEvidence
  ].some((field) => typeof field === "string" && normalizeSearchText(field).includes(normalizedQuery));
}

function exactSupplierMatchedFields(
  supplier: StoreSupplierMetadataRecord,
  normalizedQuery: string
): readonly string[] {
  const fields: string[] = [];
  if (normalizeSearchText(supplier.supplierSubjectId) === normalizedQuery) {
    fields.push("supplierSubjectId");
  }
  if (supplier.wallet && normalizeSearchText(supplier.wallet) === normalizedQuery) {
    fields.push("wallet");
  }
  return fields;
}

function supplierMatchedFields(
  supplier: StoreSupplierMetadataRecord,
  normalizedQuery: string
): readonly string[] {
  const fields = [...exactSupplierMatchedFields(supplier, normalizedQuery)];
  addMatch(fields, "displayName", supplier.displayName, normalizedQuery);
  addMatch(fields, "metadataURI", supplier.metadataURI, normalizedQuery);
  if (supplier.capabilityTags.some((tag) => normalizeSearchText(tag).includes(normalizedQuery))) {
    fields.push("capabilityTags");
  }
  if (supplier.supportedRoleSlotIds.some((id) => normalizeSearchText(id).includes(normalizedQuery))) {
    fields.push("supportedRoleSlotIds");
  }
  if (supplier.supportedStageIds.some((id) => normalizeSearchText(id).includes(normalizedQuery))) {
    fields.push("supportedStageIds");
  }
  return [...new Set(fields)];
}

function addMatch(fields: string[], fieldName: string, value: string | undefined, normalizedQuery: string): void {
  if (value && normalizeSearchText(value).includes(normalizedQuery)) {
    fields.push(fieldName);
  }
}

function zhixuSearchResult(
  zhixu: StoreZhixuConsoleDTO,
  matchedFields: readonly string[]
): StoreSearchResultDTO {
  return {
    resultType: "zhixu",
    id: zhixu.zhixuId,
    title: zhixu.title,
    subtitle: zhixu.subtitle,
    badgeLabel: zhixu.lifecycleLabel,
    statusLabel: zhixu.planPublication.label,
    matchedFields,
    primaryHref: `/store/zhixus/${encodeURIComponent(zhixu.zhixuId)}`,
    sourceOfTruth: zhixuSourceOfTruth(zhixu),
    proofHint: shortHash(zhixu.planHash),
    updatedAt: zhixu.updatedAt
  };
}

function orderSearchResult(
  order: ProductOrderApiDTO,
  matchedFields: readonly string[]
): StoreSearchResultDTO {
  const updatedAt = order.projection?.updatedAtBlock ? `block ${order.projection.updatedAtBlock}` : undefined;
  return {
    resultType: "order",
    id: order.orderId,
    title: order.title,
    subtitle: `${order.zhixuId} / ${order.currentStageName}`,
    badgeLabel: "订单",
    statusLabel: order.statusLabel,
    matchedFields,
    primaryHref: `/product/orders/${encodeURIComponent(order.orderId)}`,
    sourceOfTruth: "chain",
    ...(updatedAt ? { proofHint: updatedAt, updatedAt } : {})
  };
}

function orderCandidateSearchResult(
  candidate: StoreOrderCandidateDTO,
  matchedFields: readonly string[]
): StoreSearchResultDTO {
  return {
    resultType: "order",
    id: candidate.orderId,
    title: candidate.title,
    subtitle: `${candidate.zhixuId}${candidate.stateMachineAddress ? ` / ${shortHash(candidate.stateMachineAddress)}` : ""}`,
    badgeLabel: "订单",
    statusLabel: candidate.statusLabel,
    matchedFields,
    primaryHref: candidate.primaryHref,
    sourceOfTruth: "chain",
    ...(candidate.proofHint ? { proofHint: candidate.proofHint } : {}),
    ...(candidate.updatedAt ? { updatedAt: candidate.updatedAt } : {})
  };
}

function ambiguousOrderSearchResult(candidates: StoreOrderCandidatesResponseDTO): StoreSearchResultDTO {
  return {
    resultType: "order",
    id: candidates.orderId,
    title: `订单 ${shortHash(candidates.orderId)}`,
    subtitle: `发现 ${candidates.candidateCount} 个链上候选，需要选择部署上下文。`,
    badgeLabel: "多个候选",
    statusLabel: "需要选择候选",
    matchedFields: ["orderId"],
    primaryHref: `/store/orders/${encodeURIComponent(candidates.orderId)}/candidates`,
    sourceOfTruth: "chain",
    proofHint: "同一订单编号存在多个可见链上上下文"
  };
}

function supplierSearchResult(
  supplier: StoreSupplierMetadataRecord,
  matchedFields: readonly string[]
): StoreSearchResultDTO {
  return {
    resultType: "supplier",
    id: supplier.supplierSubjectId,
    title: supplierDisplayName(supplier),
    subtitle: supplier.wallet ?? supplier.supplierSubjectId,
    badgeLabel: supplier.reviewStatus === "approved_for_broadcast" ? "已审核" : "Store 资料",
    statusLabel: supplierReviewLabel(supplier.reviewStatus),
    matchedFields,
    primaryHref: `/store/suppliers/${encodeURIComponent(supplier.supplierSubjectId)}`,
    sourceOfTruth: "store-metadata",
    ...(supplier.metadataURI ? { proofHint: supplier.metadataURI } : {}),
    updatedAt: supplier.updatedAt
  };
}

function orderCandidateFromStateMachine(
  order: StateMachineOrderProjection,
  zhixuId: string
): StoreOrderCandidateDTO {
  return {
    orderId: order.orderId,
    title: `链上订单 ${shortHash(order.orderId)}`,
    statusLabel: stateMachineOrderStatusLabel(order.status),
    zhixuId,
    primaryHref: `/product/orders/${encodeURIComponent(order.orderId)}`,
    sourceOfTruth: "chain",
    chainId: order.chainId,
    stateMachineAddress: order.contractAddress,
    ...(order.deploymentId ? { deploymentId: order.deploymentId } : {}),
    proofHint: `${shortHash(order.updatedAt.transactionHash)} @ block ${order.updatedAt.blockNumber.toString()}`,
    updatedAt: `block ${order.updatedAt.blockNumber.toString()}`
  };
}

/**
 * Order candidates reuse the Product API's zhixu id for the same order so the
 * Store Console never derives a second, divergent id for one plan. The Product
 * API itself resolves schema-registered ids and falls back to the plan-derived
 * id; ambiguity across deployments falls back to that derived id as well.
 */
async function orderCandidateZhixuId(options: {
  readonly productService: ProductService;
}, order: StateMachineOrderProjection): Promise<string> {
  try {
    const dto = await options.productService.getOrder(order.orderId);
    if (dto && dto.stateMachineAddress === order.contractAddress) {
      return dto.zhixuId;
    }
  } catch {
    // Ambiguous or missing projection: keep going, fall back below.
  }
  return zhixuIdForPlan(order.planId);
}

function projectionStatusFromSyncState(syncState: ProjectionSyncState | undefined): StoreProjectionStatusDTO | undefined {
  if (!syncState) {
    return undefined;
  }
  const syncStatus = storeProjectionSyncStatus(syncState);
  return {
    syncStatus,
    label: projectionStatusLabel(syncStatus),
    isCatchingUp: syncStatus !== "indexed" || syncState.rebuild?.status === "running",
    updatedAt: syncState.updatedAt,
    ...(syncState.latestIndexedBlock !== undefined ? { latestIndexedBlock: syncState.latestIndexedBlock.toString() } : {}),
    ...(syncState.finalizedBlock !== undefined ? { finalizedBlock: syncState.finalizedBlock.toString() } : {}),
    confirmationDepth: syncState.confirmationDepth,
    eventCount: syncState.eventCount,
    ...(syncState.rebuild?.status ? { rebuildStatus: syncState.rebuild.status } : {}),
    ...(syncState.degradedReason ? { degradedReason: syncState.degradedReason } : {})
  };
}

function storeProjectionSyncStatus(syncState: ProjectionSyncState): StoreProjectionSyncStatus {
  if (syncState.rebuild?.status === "running") {
    return "rebuilding";
  }
  switch (syncState.syncStatus) {
    case "indexed":
    case "syncing":
    case "stale":
    case "rebuilding":
    case "degraded":
      return syncState.syncStatus;
  }
}

function detailFallbackFromRow(row: StoreZhixuConsoleDTO): ZhixuDetailDTO {
  return {
    zhixuId: row.zhixuId,
    title: row.title,
    subtitle: row.subtitle,
    reviewStatus: row.reviewStatus,
    reviewLabel: row.reviewLabel,
    riskLevel: row.riskLevel,
    applicableBusiness: [],
    excludedBusiness: [],
    stageCount: row.stageCount,
    roleSlotCount: row.roleSlotCount,
    supportedPaymentMethods: [],
    maintainer: row.maintainer,
    updatedAt: row.updatedAt,
    planPublication: row.planPublication,
    roleSlots: [],
    dockableModules: [],
    stages: [],
    orderPermissionTable: [],
    proofRows: row.proofRows,
    createOrderHint: row.lifecycleStatus === "active"
      ? "创建订单前需要补齐 Product UI schema。"
      : "该秩序当前不应创建新订单。"
  };
}

function zhixuSourceOfTruth(zhixu: StoreZhixuConsoleDTO): StoreSearchSourceOfTruth {
  return zhixu.planPublication.status === "not_found" ? "store-metadata" : "chain-and-store-metadata";
}

function searchIncludes(type: StoreSearchType, resultType: Exclude<StoreSearchType, "all">): boolean {
  return type === "all" || type === resultType;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 20;
  }
  return Math.max(1, Math.min(50, Math.trunc(limit)));
}

function shortHash(value: string): string {
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function supplierDisplayName(supplier: StoreSupplierMetadataRecord): string {
  return supplier.displayName || `供应商 ${shortHash(supplier.supplierSubjectId)}`;
}

function supplierReviewLabel(status: StoreSupplierMetadataRecord["reviewStatus"]): string {
  switch (status) {
    case "draft":
      return "资料草稿";
    case "submitted":
      return "待 Store 审核";
    case "approved_for_broadcast":
      return "Store 审核通过";
    case "rejected":
      return "Store 审核拒绝";
    case "revoked":
      return "Store 已撤销";
  }
}

function zhixuIdForPlan(planId: string): string {
  return `plan-${shortHash(planId)}`;
}

function stateMachineOrderStatusLabel(status: StateMachineOrderProjection["status"]): string {
  switch (status) {
    case "registered":
      return "已注册";
    case "unknown":
      return "同步中";
  }
}

function lifecycleRank(status: StoreZhixuConsoleDTO["lifecycleStatus"]): number {
  switch (status) {
    case "active":
      return 0;
    case "approved_for_broadcast":
      return 1;
    case "submitted_for_review":
      return 2;
    case "compiled":
      return 3;
    case "draft":
      return 4;
    case "deprecated":
      return 5;
    case "rejected":
      return 6;
    case "revoked":
      return 7;
  }
}
