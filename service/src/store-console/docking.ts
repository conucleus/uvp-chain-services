import { createHash, randomUUID } from "node:crypto";
import {
  lifecycleStatusForZhixu,
  type PlanPublicationStatus,
  type OrderPermissionTableEntryDTO,
  type StoreZhixuLifecycleStatus,
  type ZhixuDetailDTO,
  type ZhixuStageDTO
} from "@uvp-eth/product-dto";
import type { ProductService } from "../product/service.js";

export interface StoreDockingSessionCreateDTO {
  readonly sourceZhixuId: string;
  readonly targetZhixuId: string;
  readonly sourceVersionId?: string;
  readonly targetVersionId?: string;
}

export type StoreDockingSessionStatus = "draft" | "valid" | "invalid";

export interface StoreDockingZhixuRefDTO {
  readonly zhixuId: string;
  readonly title: string;
  readonly versionId?: string;
  readonly versionLabel: string;
  readonly lifecycleStatus: StoreZhixuLifecycleStatus;
  readonly publicationStatus: PlanPublicationStatus;
  readonly planId: string;
  readonly planHash: string;
}

export interface StoreDockingSignalPortDTO {
  readonly signalId: string;
  readonly label: string;
  readonly direction: "output" | "input";
  readonly stageId?: string;
  readonly stageName?: string;
  readonly roleSlotId?: string;
  readonly roleLabel?: string;
  readonly payloadSchemaHash?: string;
  readonly schemaHint?: string;
}

export interface StoreSignalMappingCandidateDTO {
  readonly candidateId: string;
  readonly sourceSignal: StoreDockingSignalPortDTO;
  readonly targetSignal: StoreDockingSignalPortDTO;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

export interface StoreDraftSignalMapEntryDTO {
  readonly entryId?: string;
  readonly sourceSignalId: string;
  readonly targetSignalId: string;
  readonly note?: string;
}

export type StoreDockingValidationErrorCode =
  | "source_output_not_found"
  | "target_input_not_found"
  | "incompatible_payload_hash"
  | "target_role_slot_mismatch"
  | "source_version_not_published"
  | "target_version_not_published"
  | "source_version_revoked"
  | "target_version_revoked"
  | "empty_signal_map";

export interface StoreDockingValidationErrorDTO {
  readonly code: StoreDockingValidationErrorCode;
  readonly message: string;
  readonly sourceSignalId?: string;
  readonly targetSignalId?: string;
}

export interface StoreDockingValidationDTO {
  readonly ok: boolean;
  readonly errors: readonly StoreDockingValidationErrorDTO[];
  readonly checkedAt?: string;
  readonly nonPublishing: true;
}

export interface StoreDockingSessionDTO {
  readonly sessionId: string;
  readonly status: StoreDockingSessionStatus;
  readonly source: StoreDockingZhixuRefDTO;
  readonly target: StoreDockingZhixuRefDTO;
  readonly candidateMappings: readonly StoreSignalMappingCandidateDTO[];
  readonly draftSignalMap: readonly StoreDraftSignalMapEntryDTO[];
  readonly validation: StoreDockingValidationDTO;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoreDockingService {
  createSession(input: StoreDockingSessionCreateDTO): Promise<StoreDockingSessionDTO>;
  getSession(sessionId: string): Promise<StoreDockingSessionDTO | undefined>;
  validateSession(sessionId: string, draftSignalMap: readonly StoreDraftSignalMapEntryDTO[]): Promise<StoreDockingSessionDTO>;
  saveDraftMap(sessionId: string, draftSignalMap: readonly StoreDraftSignalMapEntryDTO[]): Promise<StoreDockingSessionDTO>;
}

export interface StoreDockingSessionStore {
  createSession(session: StoreDockingSessionDTO): Promise<void>;
  getSession(sessionId: string): Promise<StoreDockingSessionDTO | undefined>;
  updateSession(session: StoreDockingSessionDTO): Promise<void>;
}

export class MemoryStoreDockingSessionStore implements StoreDockingSessionStore {
  readonly #sessions = new Map<string, StoreDockingSessionDTO>();

  async createSession(session: StoreDockingSessionDTO): Promise<void> {
    this.#sessions.set(session.sessionId, session);
  }

  async getSession(sessionId: string): Promise<StoreDockingSessionDTO | undefined> {
    return this.#sessions.get(sessionId);
  }

  async updateSession(session: StoreDockingSessionDTO): Promise<void> {
    this.#sessions.set(session.sessionId, session);
  }
}

export class StoreDockingServiceError extends Error {
  override readonly name = "StoreDockingServiceError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export function createStoreDockingService(options: {
  readonly productService: ProductService;
  readonly sessionStore?: StoreDockingSessionStore;
  readonly now?: () => Date;
}): StoreDockingService {
  const sessionStore = options.sessionStore ?? new MemoryStoreDockingSessionStore();
  const now = options.now ?? (() => new Date());

  return {
    async createSession(input) {
      const sourceDetail = await requireZhixu(options.productService, input.sourceZhixuId, "sourceZhixuId");
      const targetDetail = await requireZhixu(options.productService, input.targetZhixuId, "targetZhixuId");
      const createdAt = now().toISOString();
      const source = zhixuRef(sourceDetail, input.sourceVersionId);
      const target = zhixuRef(targetDetail, input.targetVersionId);
      const candidateMappings = buildCandidateMappings(sourceDetail, targetDetail);
      const validation = validateSignalMap({
        source,
        target,
        sourcePorts: sourceOutputPorts(sourceDetail),
        targetPorts: targetInputPorts(targetDetail),
        draftSignalMap: [],
        checkedAt: createdAt,
        requireNonEmpty: false
      });
      const session: StoreDockingSessionDTO = {
        sessionId: `dock_${randomUUID()}`,
        status: "draft",
        source,
        target,
        candidateMappings,
        draftSignalMap: [],
        validation,
        createdAt,
        updatedAt: createdAt
      };
      await sessionStore.createSession(session);
      return session;
    },

    async getSession(sessionId) {
      return sessionStore.getSession(sessionId);
    },

    async validateSession(sessionId, draftSignalMap) {
      const session = await requireSession(sessionStore, sessionId);
      const current = await currentSessionDetails(options.productService, session);
      const checkedAt = now().toISOString();
      const validation = validateStoredSession(current, draftSignalMap, checkedAt, true);
      const updated: StoreDockingSessionDTO = {
        ...session,
        source: current.source,
        target: current.target,
        status: validation.ok ? "valid" : "invalid",
        validation,
        updatedAt: checkedAt
      };
      await sessionStore.updateSession(updated);
      return updated;
    },

    async saveDraftMap(sessionId, draftSignalMap) {
      const session = await requireSession(sessionStore, sessionId);
      const current = await currentSessionDetails(options.productService, session);
      const checkedAt = now().toISOString();
      const sanitized = draftSignalMap.map(sanitizeDraftEntry);
      const validation = validateStoredSession(current, sanitized, checkedAt, true);
      const updated: StoreDockingSessionDTO = {
        ...session,
        source: current.source,
        target: current.target,
        status: validation.ok ? "valid" : "invalid",
        draftSignalMap: sanitized,
        validation,
        updatedAt: checkedAt
      };
      await sessionStore.updateSession(updated);
      return updated;
    }
  };
}

async function requireZhixu(
  productService: ProductService,
  zhixuId: string,
  field: string
): Promise<ZhixuDetailDTO> {
  const normalized = zhixuId.trim();
  if (!normalized) {
    throw new StoreDockingServiceError(400, "invalid_body", `${field} is required`);
  }
  const zhixu = await productService.getZhixu(normalized);
  if (!zhixu) {
    throw new StoreDockingServiceError(404, "store_zhixu_not_found", `${field} was not found`, { [field]: normalized });
  }
  return zhixu;
}

async function requireSession(
  store: StoreDockingSessionStore,
  sessionId: string
): Promise<StoreDockingSessionDTO> {
  const session = await store.getSession(sessionId);
  if (!session) {
    throw new StoreDockingServiceError(404, "docking_session_not_found", "docking session was not found", { sessionId });
  }
  return session;
}

async function currentSessionDetails(
  productService: ProductService,
  session: StoreDockingSessionDTO
): Promise<{
  readonly sourceDetail: ZhixuDetailDTO;
  readonly targetDetail: ZhixuDetailDTO;
  readonly source: StoreDockingZhixuRefDTO;
  readonly target: StoreDockingZhixuRefDTO;
}> {
  const sourceDetail = await requireZhixu(productService, session.source.zhixuId, "sourceZhixuId");
  const targetDetail = await requireZhixu(productService, session.target.zhixuId, "targetZhixuId");
  return {
    sourceDetail,
    targetDetail,
    source: zhixuRef(sourceDetail, session.source.versionId),
    target: zhixuRef(targetDetail, session.target.versionId)
  };
}

function validateStoredSession(
  current: {
    readonly sourceDetail: ZhixuDetailDTO;
    readonly targetDetail: ZhixuDetailDTO;
    readonly source: StoreDockingZhixuRefDTO;
    readonly target: StoreDockingZhixuRefDTO;
  },
  draftSignalMap: readonly StoreDraftSignalMapEntryDTO[],
  checkedAt: string,
  requireNonEmpty: boolean
): StoreDockingValidationDTO {
  return validateSignalMap({
    source: current.source,
    target: current.target,
    sourcePorts: sourceOutputPorts(current.sourceDetail),
    targetPorts: targetInputPorts(current.targetDetail),
    draftSignalMap,
    checkedAt,
    requireNonEmpty
  });
}

function validateSignalMap(input: {
  readonly source: StoreDockingZhixuRefDTO;
  readonly target: StoreDockingZhixuRefDTO;
  readonly sourcePorts: readonly StoreDockingSignalPortDTO[];
  readonly targetPorts: readonly StoreDockingSignalPortDTO[];
  readonly draftSignalMap: readonly StoreDraftSignalMapEntryDTO[];
  readonly checkedAt: string;
  readonly requireNonEmpty: boolean;
}): StoreDockingValidationDTO {
  const errors: StoreDockingValidationErrorDTO[] = [
    ...versionErrors(input.source, "source"),
    ...versionErrors(input.target, "target")
  ];
  if (input.requireNonEmpty && input.draftSignalMap.length === 0) {
    errors.push(validationError("empty_signal_map", "signalMap 草稿至少需要一行"));
  }

  const sourceById = new Map(input.sourcePorts.map((port) => [port.signalId, port]));
  const targetById = new Map(input.targetPorts.map((port) => [port.signalId, port]));
  for (const entry of input.draftSignalMap) {
    const source = sourceById.get(entry.sourceSignalId);
    const target = targetById.get(entry.targetSignalId);
    if (!source) {
      errors.push(validationError(
        "source_output_not_found",
        `源输出不存在：${entry.sourceSignalId}`,
        { sourceSignalId: entry.sourceSignalId, targetSignalId: entry.targetSignalId }
      ));
      continue;
    }
    if (!target) {
      errors.push(validationError(
        "target_input_not_found",
        `目标输入不存在：${entry.targetSignalId}`,
        { sourceSignalId: entry.sourceSignalId, targetSignalId: entry.targetSignalId }
      ));
      continue;
    }
    if (source.payloadSchemaHash && target.payloadSchemaHash && source.payloadSchemaHash !== target.payloadSchemaHash) {
      errors.push(validationError(
        "incompatible_payload_hash",
        "源输出和目标输入的 payload schema hint 不兼容",
        { sourceSignalId: entry.sourceSignalId, targetSignalId: entry.targetSignalId }
      ));
    }
    if (source.roleSlotId && target.roleSlotId && source.roleSlotId !== target.roleSlotId) {
      errors.push(validationError(
        "target_role_slot_mismatch",
        "目标输入要求的角色槽与源输出角色槽不同",
        { sourceSignalId: entry.sourceSignalId, targetSignalId: entry.targetSignalId }
      ));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    checkedAt: input.checkedAt,
    nonPublishing: true
  };
}

function versionErrors(
  ref: StoreDockingZhixuRefDTO,
  side: "source" | "target"
): readonly StoreDockingValidationErrorDTO[] {
  void ref;
  void side;
  return [];
}

function validationError(
  code: StoreDockingValidationErrorCode,
  message: string,
  refs: { readonly sourceSignalId?: string; readonly targetSignalId?: string } = {}
): StoreDockingValidationErrorDTO {
  return {
    code,
    message,
    ...(refs.sourceSignalId ? { sourceSignalId: refs.sourceSignalId } : {}),
    ...(refs.targetSignalId ? { targetSignalId: refs.targetSignalId } : {})
  };
}

function zhixuRef(zhixu: ZhixuDetailDTO, versionId: string | undefined): StoreDockingZhixuRefDTO {
  const resolvedVersionId = versionId ?? zhixu.planPublication.planHash;
  return {
    zhixuId: zhixu.zhixuId,
    title: zhixu.title,
    ...(resolvedVersionId ? { versionId: resolvedVersionId } : {}),
    versionLabel: "Plan 版本",
    lifecycleStatus: lifecycleStatusForZhixu(zhixu),
    publicationStatus: zhixu.planPublication.status,
    planId: zhixu.planPublication.planId,
    planHash: zhixu.planPublication.planHash
  };
}

function buildCandidateMappings(
  source: ZhixuDetailDTO,
  target: ZhixuDetailDTO
): readonly StoreSignalMappingCandidateDTO[] {
  const sourcePorts = sourceOutputPorts(source);
  const targetPorts = targetInputPorts(target);
  const candidates: StoreSignalMappingCandidateDTO[] = [];
  for (const sourcePort of sourcePorts) {
    for (const targetPort of targetPorts) {
      const confidence = candidateConfidence(sourcePort, targetPort);
      if (!confidence) {
        continue;
      }
      candidates.push({
        candidateId: candidateId(source.zhixuId, target.zhixuId, sourcePort.signalId, targetPort.signalId),
        sourceSignal: sourcePort,
        targetSignal: targetPort,
        confidence,
        reason: candidateReason(sourcePort, targetPort, confidence)
      });
    }
  }
  return candidates
    .sort(compareCandidates)
    .slice(0, 12);
}

function sourceOutputPorts(zhixu: ZhixuDetailDTO): readonly StoreDockingSignalPortDTO[] {
  return zhixu.stages.map((stage) => {
    const roleSlotId = roleSlotIdForStage(zhixu, stage);
    const roleLabel = roleLabelForSlot(zhixu, roleSlotId) ?? stage.ownerRole;
    return signalPort({
      signalId: `${stage.stageId}.completed`,
      label: `${stage.name}已完成`,
      direction: "output",
      stageId: stage.stageId,
      stageName: stage.name,
      roleSlotId,
      roleLabel,
      evidence: stage.evidence
    });
  });
}

function targetInputPorts(zhixu: ZhixuDetailDTO): readonly StoreDockingSignalPortDTO[] {
  return zhixu.orderPermissionTable
    .map((entry) => inputPortFromPermission(zhixu, entry));
}

function inputPortFromPermission(
  zhixu: ZhixuDetailDTO,
  entry: OrderPermissionTableEntryDTO
): StoreDockingSignalPortDTO {
  const stage = zhixu.stages.find((item) => item.stageId === entry.stageId);
  const evidence = entry.requiredEvidence.length > 0 ? entry.requiredEvidence : stage?.evidence ?? [];
  const stageName = stage?.name;
  return signalPort({
    signalId: entry.signalName,
    label: stageName ? `${stageName} / ${signalLabel(entry.signalName)}` : signalLabel(entry.signalName),
    direction: "input",
    stageId: entry.stageId,
    ...(stageName ? { stageName } : {}),
    roleSlotId: entry.roleSlotId,
    roleLabel: roleLabelForSlot(zhixu, entry.roleSlotId) ?? entry.roleSlotId,
    evidence
  });
}

function signalPort(input: {
  readonly signalId: string;
  readonly label: string;
  readonly direction: "output" | "input";
  readonly stageId?: string;
  readonly stageName?: string;
  readonly roleSlotId?: string;
  readonly roleLabel?: string;
  readonly evidence: readonly string[];
}): StoreDockingSignalPortDTO {
  const schemaHint = input.evidence.length > 0 ? input.evidence.join("、") : "无 payload 约束";
  return {
    signalId: input.signalId,
    label: input.label,
    direction: input.direction,
    ...(input.stageId ? { stageId: input.stageId } : {}),
    ...(input.stageName ? { stageName: input.stageName } : {}),
    ...(input.roleSlotId ? { roleSlotId: input.roleSlotId } : {}),
    ...(input.roleLabel ? { roleLabel: input.roleLabel } : {}),
    payloadSchemaHash: schemaHash(input.evidence),
    schemaHint
  };
}

function roleSlotIdForStage(zhixu: ZhixuDetailDTO, stage: ZhixuStageDTO): string {
  return zhixu.orderPermissionTable.find((entry) => entry.stageId === stage.stageId)?.roleSlotId ??
    stage.ownerRole;
}

function roleLabelForSlot(zhixu: ZhixuDetailDTO, roleSlotId: string | undefined): string | undefined {
  if (!roleSlotId) {
    return undefined;
  }
  return zhixu.roleSlots.find((slot) => slot.slotId === roleSlotId)?.title;
}

function candidateConfidence(
  source: StoreDockingSignalPortDTO,
  target: StoreDockingSignalPortDTO
): StoreSignalMappingCandidateDTO["confidence"] | undefined {
  if (source.stageId && target.stageId && source.stageId === target.stageId && source.payloadSchemaHash === target.payloadSchemaHash) {
    return source.roleSlotId === target.roleSlotId ? "high" : "medium";
  }
  if (source.payloadSchemaHash && source.payloadSchemaHash === target.payloadSchemaHash) {
    return source.roleSlotId === target.roleSlotId ? "medium" : "low";
  }
  if (sharedBusinessToken(source.label, target.label)) {
    return "low";
  }
  return undefined;
}

function candidateReason(
  source: StoreDockingSignalPortDTO,
  target: StoreDockingSignalPortDTO,
  confidence: StoreSignalMappingCandidateDTO["confidence"]
): string {
  if (confidence === "high") {
    return "阶段、payload hint 和角色槽一致";
  }
  if (source.payloadSchemaHash === target.payloadSchemaHash) {
    return "payload hint 一致，需人工确认业务语义";
  }
  return "业务标签相近，需人工确认";
}

function compareCandidates(left: StoreSignalMappingCandidateDTO, right: StoreSignalMappingCandidateDTO): number {
  return confidenceRank(left.confidence) - confidenceRank(right.confidence) ||
    left.sourceSignal.label.localeCompare(right.sourceSignal.label) ||
    left.targetSignal.label.localeCompare(right.targetSignal.label);
}

function confidenceRank(value: StoreSignalMappingCandidateDTO["confidence"]): number {
  switch (value) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
  }
}

function candidateId(sourceZhixuId: string, targetZhixuId: string, sourceSignalId: string, targetSignalId: string): string {
  return `cand_${digest([sourceZhixuId, targetZhixuId, sourceSignalId, targetSignalId].join("|")).slice(0, 20)}`;
}

function schemaHash(evidence: readonly string[]): string {
  return `sha256:${digest([...evidence].map((item) => item.trim().toLowerCase()).sort().join("|")).slice(0, 32)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sharedBusinessToken(left: string, right: string): boolean {
  const leftTokens = businessTokens(left);
  return [...businessTokens(right)].some((token) => leftTokens.has(token));
}

function businessTokens(value: string): Set<string> {
  return new Set(value
    .toLowerCase()
    .split(/[\s/._:-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2));
}

function signalLabel(signalName: string): string {
  const tail = signalName.split(".").at(-1) ?? signalName;
  switch (tail) {
    case "cmp":
      return "确认完成";
    case "pass":
      return "校验通过";
    case "fail":
      return "校验不通过";
    case "confirm_stage":
      return "确认阶段";
    case "reject_stage":
      return "拒绝阶段";
    case "str":
      return "开始处理";
    default:
      return tail;
  }
}

function sanitizeDraftEntry(entry: StoreDraftSignalMapEntryDTO): StoreDraftSignalMapEntryDTO {
  const note = entry.note?.trim();
  return {
    ...(entry.entryId?.trim() ? { entryId: entry.entryId.trim() } : {}),
    sourceSignalId: entry.sourceSignalId.trim(),
    targetSignalId: entry.targetSignalId.trim(),
    ...(note ? { note } : {})
  };
}
