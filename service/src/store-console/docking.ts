import { createHash, randomUUID } from "node:crypto";
import {
  lifecycleStatusForZhixu,
  type PlanPublicationStatus,
  type StoreZhixuLifecycleStatus,
  type ZhixuDetailDTO,
  type ZhixuStageDTO
} from "@uvp-eth/product-dto";
import type { ProductService } from "../product/service.js";

/** dock 下单模式（{new, existing}）。 */
export type StoreDockOrderMode = "new" | "existing";
/** 草稿映射行方向：input=本地通道→接口输入端口，output=本地信号→接口输出端口。 */
export type StoreDockBindingKind = "input" | "output";

export interface StoreDockingSessionCreateDTO {
  readonly sourceZhixuId: string;
  readonly targetZhixuId: string;
  /** 目标具名接口；缺省取目标首个接口。 */
  readonly targetInterfaceName?: string;
  /** 下单模式；缺省取所选接口的首个开放模式。 */
  readonly orderMode?: StoreDockOrderMode;
}

export type StoreDockingSessionStatus = "draft" | "valid" | "invalid";

export interface StoreDockingZhixuRefDTO {
  readonly zhixuId: string;
  readonly title: string;
  readonly lifecycleStatus: StoreZhixuLifecycleStatus;
  readonly publicationStatus: PlanPublicationStatus;
  readonly planId: string;
  readonly planHash: string;
}

export interface StoreDockingInterfacePortDTO {
  readonly portName: string;
  readonly label: string;
  /** input 端口的目标侧 hook 引用（<task>.<stage>#<channel>）。 */
  readonly hook?: string;
  /** output 端口的目标侧 canonical signal。 */
  readonly signal?: string;
}

/** 目标定义发布的具名 dock 接口（试拼沙箱消费的 v2 接口形状）。 */
export interface StoreDockingInterfaceDTO {
  readonly interfaceName: string;
  readonly orderModes: readonly StoreDockOrderMode[];
  readonly inputs: readonly StoreDockingInterfacePortDTO[];
  readonly outputs: readonly StoreDockingInterfacePortDTO[];
}

export interface StoreDockingSignalPortDTO {
  readonly signalId: string;
  readonly label: string;
  readonly bindingKind: StoreDockBindingKind;
  readonly stageId?: string;
  readonly stageName?: string;
  readonly roleSlotId?: string;
  readonly roleLabel?: string;
  readonly payloadSchemaHash?: string;
  readonly schemaHint?: string;
}

export interface StoreSignalMappingCandidateDTO {
  readonly candidateId: string;
  readonly bindingKind: StoreDockBindingKind;
  readonly sourceSignal: StoreDockingSignalPortDTO;
  readonly targetSignal: StoreDockingSignalPortDTO;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
}

export interface StoreDraftSignalMapEntryDTO {
  readonly entryId?: string;
  readonly bindingKind: StoreDockBindingKind;
  readonly sourceSignalId: string;
  readonly targetSignalId: string;
  readonly note?: string;
}

export type StoreDockingValidationErrorCode =
  | "source_zhixu_not_published"
  | "target_zhixu_not_published"
  | "source_zhixu_revoked"
  | "target_zhixu_revoked"
  | "target_interface_not_found"
  | "order_mode_not_supported"
  | "empty_signal_map"
  | "source_port_not_found"
  | "target_port_not_found"
  | "duplicate_target_port";

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
  /** 目标定义当前发布的具名接口全集（供操作员切换试拼对象）。 */
  readonly interfaces: readonly StoreDockingInterfaceDTO[];
  readonly selectedInterfaceName: string;
  readonly orderMode: StoreDockOrderMode;
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

interface DockingSessionContext {
  readonly sourceDetail: ZhixuDetailDTO;
  readonly targetDetail: ZhixuDetailDTO;
  readonly source: StoreDockingZhixuRefDTO;
  readonly target: StoreDockingZhixuRefDTO;
  readonly interfaces: readonly StoreDockingInterfaceDTO[];
  readonly selectedInterface: StoreDockingInterfaceDTO;
  readonly orderMode: StoreDockOrderMode;
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
      // STORE-03：self-docking 无业务意义且会绕过信号映射校验的 source/target
      // 前提；服务层为权威校验，路由层另做同规则快速拦截。
      if (input.sourceZhixuId.trim() === input.targetZhixuId.trim()) {
        throw new StoreDockingServiceError(
          422,
          "self_docking_forbidden",
          "sourceZhixuId and targetZhixuId must be different zhixu definitions",
          { sourceZhixuId: input.sourceZhixuId, targetZhixuId: input.targetZhixuId }
        );
      }
      const sourceDetail = await requireZhixu(options.productService, input.sourceZhixuId, "sourceZhixuId");
      const targetDetail = await requireZhixu(options.productService, input.targetZhixuId, "targetZhixuId");
      const interfaces = interfacesFromDetail(targetDetail);
      if (interfaces.length === 0) {
        throw new StoreDockingServiceError(
          422,
          "target_has_no_dock_interface",
          "target zhixu does not publish any named dock interface",
          { targetZhixuId: input.targetZhixuId }
        );
      }
      const requested = input.targetInterfaceName
        ? interfaces.find((entry) => entry.interfaceName === input.targetInterfaceName)
        : undefined;
      if (input.targetInterfaceName && !requested) {
        throw new StoreDockingServiceError(
          422,
          "target_interface_not_found",
          `target zhixu does not publish interface ${input.targetInterfaceName}`,
          { targetZhixuId: input.targetZhixuId, targetInterfaceName: input.targetInterfaceName }
        );
      }
      const selectedInterface = requested ?? interfaces[0]!;
      const orderMode = input.orderMode ?? selectedInterface.orderModes[0];
      if (!orderMode || !selectedInterface.orderModes.includes(orderMode)) {
        throw new StoreDockingServiceError(
          422,
          "order_mode_not_supported",
          `interface ${selectedInterface.interfaceName} does not support order mode ${input.orderMode ?? ""}`.trim(),
          {
            targetInterfaceName: selectedInterface.interfaceName,
            orderModes: [...selectedInterface.orderModes]
          }
        );
      }
      const createdAt = now().toISOString();
      const context: DockingSessionContext = {
        sourceDetail,
        targetDetail,
        source: zhixuRef(sourceDetail),
        target: zhixuRef(targetDetail),
        interfaces,
        selectedInterface,
        orderMode
      };
      const candidateMappings = buildCandidateMappings(context);
      const validation = validateSignalMap({
        context,
        draftSignalMap: [],
        checkedAt: createdAt,
        requireNonEmpty: false
      });
      const session: StoreDockingSessionDTO = {
        sessionId: `dock_${randomUUID()}`,
        status: "draft",
        source: context.source,
        target: context.target,
        interfaces,
        selectedInterfaceName: selectedInterface.interfaceName,
        orderMode,
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
      const current = await currentSessionContext(options.productService, session);
      const checkedAt = now().toISOString();
      const validation = validateSignalMap({
        context: current,
        draftSignalMap: draftSignalMap.map(sanitizeDraftEntry),
        checkedAt,
        requireNonEmpty: true
      });
      const updated: StoreDockingSessionDTO = {
        ...session,
        source: current.source,
        target: current.target,
        interfaces: current.interfaces,
        status: validation.ok ? "valid" : "invalid",
        validation,
        updatedAt: checkedAt
      };
      await sessionStore.updateSession(updated);
      return updated;
    },

    async saveDraftMap(sessionId, draftSignalMap) {
      const session = await requireSession(sessionStore, sessionId);
      const current = await currentSessionContext(options.productService, session);
      const checkedAt = now().toISOString();
      const sanitized = draftSignalMap.map(sanitizeDraftEntry);
      const validation = validateSignalMap({
        context: current,
        draftSignalMap: sanitized,
        checkedAt,
        requireNonEmpty: true
      });
      const updated: StoreDockingSessionDTO = {
        ...session,
        source: current.source,
        target: current.target,
        interfaces: current.interfaces,
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

async function currentSessionContext(
  productService: ProductService,
  session: StoreDockingSessionDTO
): Promise<DockingSessionContext> {
  const sourceDetail = await requireZhixu(productService, session.source.zhixuId, "sourceZhixuId");
  const targetDetail = await requireZhixu(productService, session.target.zhixuId, "targetZhixuId");
  const interfaces = interfacesFromDetail(targetDetail);
  const selectedInterface = interfaces.find((entry) => entry.interfaceName === session.selectedInterfaceName);
  return {
    sourceDetail,
    targetDetail,
    source: zhixuRef(sourceDetail),
    target: zhixuRef(targetDetail),
    interfaces,
    // 会话锚定的接口在当前目标定义上已消失时保留接口名并让校验层以
    // target_interface_not_found 阻断（会话是草稿，不静默改选接口）。
    selectedInterface: selectedInterface ?? {
      interfaceName: session.selectedInterfaceName,
      orderModes: [],
      inputs: [],
      outputs: []
    },
    orderMode: session.orderMode
  };
}

function validateSignalMap(input: {
  readonly context: DockingSessionContext;
  readonly draftSignalMap: readonly StoreDraftSignalMapEntryDTO[];
  readonly checkedAt: string;
  readonly requireNonEmpty: boolean;
}): StoreDockingValidationDTO {
  const { context, draftSignalMap } = input;
  const errors: StoreDockingValidationErrorDTO[] = [
    ...publicationErrors(context.source, "source"),
    ...publicationErrors(context.target, "target")
  ];
  if (context.selectedInterface.orderModes.length === 0) {
    errors.push(validationError(
      "target_interface_not_found",
      `目标接口 ${context.selectedInterface.interfaceName} 已不存在于当前目标定义`,
      {}
    ));
  } else if (!context.selectedInterface.orderModes.includes(context.orderMode)) {
    errors.push(validationError(
      "order_mode_not_supported",
      `接口 ${context.selectedInterface.interfaceName} 不支持下单模式 ${context.orderMode}（开放：${context.selectedInterface.orderModes.join("、")}）`,
      {}
    ));
  }
  if (input.requireNonEmpty && draftSignalMap.length === 0) {
    errors.push(validationError("empty_signal_map", "映射草稿至少需要一行（输入或输出）"));
  }

  const sourcePorts = sourcePortsForKind(context.sourceDetail);
  const targetPorts = targetPortsForKind(context.selectedInterface);
  const boundTargetPorts = new Set<string>();
  for (const entry of draftSignalMap) {
    const source = sourcePorts.get(entry.bindingKind)?.get(entry.sourceSignalId);
    const target = targetPorts.get(entry.bindingKind)?.get(entry.targetSignalId);
    if (!source) {
      errors.push(validationError(
        "source_port_not_found",
        bindingKindLabel(entry.bindingKind, "源端口不存在") + `：${entry.sourceSignalId}`,
        { sourceSignalId: entry.sourceSignalId, targetSignalId: entry.targetSignalId }
      ));
      continue;
    }
    if (!target) {
      errors.push(validationError(
        "target_port_not_found",
        bindingKindLabel(entry.bindingKind, "目标端口不在所选接口内") + `：${entry.targetSignalId}`,
        { sourceSignalId: entry.sourceSignalId, targetSignalId: entry.targetSignalId }
      ));
      continue;
    }
    // 同一目标端口在一条 route 内至多绑定一次。
    const targetPortKey = `${entry.bindingKind}:${entry.targetSignalId}`;
    if (boundTargetPorts.has(targetPortKey)) {
      errors.push(validationError(
        "duplicate_target_port",
        `目标端口被重复绑定：${entry.targetSignalId}`,
        { sourceSignalId: entry.sourceSignalId, targetSignalId: entry.targetSignalId }
      ));
    }
    boundTargetPorts.add(targetPortKey);
  }

  return {
    ok: errors.length === 0,
    errors,
    checkedAt: input.checkedAt,
    nonPublishing: true
  };
}

function publicationErrors(
  ref: StoreDockingZhixuRefDTO,
  side: "source" | "target"
): readonly StoreDockingValidationErrorDTO[] {
  const errors: StoreDockingValidationErrorDTO[] = [];
  const prefix = side === "source" ? "source" : "target";

  // A docking session is review material only, but it must never claim that
  // an unpublished or revoked plan can participate in a valid composition.
  // Keep both checks explicit: a revoked definition is terminal even if a
  // stale projection still reports its old publication marker.
  if (ref.publicationStatus !== "published") {
    errors.push(validationError(
      `${prefix}_zhixu_not_published` as const,
      `${prefix} zhixu ${ref.zhixuId} is not published on the state machine`
    ));
  }
  if (ref.lifecycleStatus === "revoked") {
    errors.push(validationError(
      `${prefix}_zhixu_revoked` as const,
      `${prefix} zhixu ${ref.zhixuId} has been revoked`
    ));
  }
  return errors;
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

function bindingKindLabel(kind: StoreDockBindingKind, text: string): string {
  return kind === "input" ? `输入绑定——${text}` : `输出绑定——${text}`;
}

function zhixuRef(zhixu: ZhixuDetailDTO): StoreDockingZhixuRefDTO {
  return {
    zhixuId: zhixu.zhixuId,
    title: zhixu.title,
    lifecycleStatus: lifecycleStatusForZhixu(zhixu),
    publicationStatus: zhixu.planPublication.status,
    planId: zhixu.planPublication.planId,
    planHash: zhixu.planPublication.planHash
  };
}

function interfacesFromDetail(zhixu: ZhixuDetailDTO): readonly StoreDockingInterfaceDTO[] {
  return zhixu.dockableModules.map((module) => ({
    interfaceName: module.interfaceName,
    orderModes: [...module.orderModes],
    inputs: module.inputs.map((port) => ({
      portName: port.portName,
      label: port.label,
      ...(port.hook ? { hook: port.hook } : {})
    })),
    outputs: module.outputs.map((port) => ({
      portName: port.portName,
      label: port.label,
      ...(port.signal ? { signal: port.signal } : {})
    }))
  }));
}

/** 源侧端口按绑定方向分组：input 行用本地通道（receiveSignals 词表），output 行用本地完成信号。 */
function sourcePortsForKind(
  zhixu: ZhixuDetailDTO
): ReadonlyMap<StoreDockBindingKind, ReadonlyMap<string, StoreDockingSignalPortDTO>> {
  const channels = new Map<string, StoreDockingSignalPortDTO>();
  for (const entry of zhixu.orderPermissionTable) {
    const stage = zhixu.stages.find((item) => item.stageId === entry.stageId);
    const evidence = entry.requiredEvidence.length > 0 ? entry.requiredEvidence : stage?.evidence ?? [];
    channels.set(entry.signalName, signalPort({
      signalId: entry.signalName,
      label: stage ? `${stage.name} / ${signalLabel(entry.signalName)}` : signalLabel(entry.signalName),
      bindingKind: "input",
      stageId: entry.stageId,
      ...(stage ? { stageName: stage.name } : {}),
      roleSlotId: entry.roleSlotId,
      roleLabel: roleLabelForSlot(zhixu, entry.roleSlotId) ?? entry.roleSlotId,
      evidence
    }));
  }
  const signals = new Map<string, StoreDockingSignalPortDTO>();
  for (const stage of zhixu.stages) {
    const roleSlotId = roleSlotIdForStage(zhixu, stage);
    const signalId = `${stage.stageId}.completed`;
    signals.set(signalId, signalPort({
      signalId,
      label: `${stage.name}已完成`,
      bindingKind: "output",
      stageId: stage.stageId,
      stageName: stage.name,
      ...(roleSlotId ? { roleSlotId } : {}),
      roleLabel: roleLabelForSlot(zhixu, roleSlotId) ?? stage.ownerRole,
      evidence: stage.evidence
    }));
  }
  return new Map([
    ["input", channels],
    ["output", signals]
  ]);
}

/** 目标侧端口按绑定方向分组：接口输入端口 / 接口输出端口。 */
function targetPortsForKind(
  selectedInterface: StoreDockingInterfaceDTO
): ReadonlyMap<StoreDockBindingKind, ReadonlyMap<string, StoreDockingSignalPortDTO>> {
  const inputs = new Map<string, StoreDockingSignalPortDTO>();
  for (const port of selectedInterface.inputs) {
    inputs.set(port.portName, signalPort({
      signalId: port.portName,
      label: port.label,
      bindingKind: "input",
      evidence: port.hook ? [port.hook] : []
    }));
  }
  const outputs = new Map<string, StoreDockingSignalPortDTO>();
  for (const port of selectedInterface.outputs) {
    outputs.set(port.portName, signalPort({
      signalId: port.portName,
      label: port.label,
      bindingKind: "output",
      evidence: port.signal ? [port.signal] : []
    }));
  }
  return new Map([
    ["input", inputs],
    ["output", outputs]
  ]);
}

function buildCandidateMappings(
  context: DockingSessionContext
): readonly StoreSignalMappingCandidateDTO[] {
  const sourcePorts = sourcePortsForKind(context.sourceDetail);
  const targetPorts = targetPortsForKind(context.selectedInterface);
  const candidates: StoreSignalMappingCandidateDTO[] = [];
  for (const kind of ["input", "output"] as const) {
    for (const sourcePort of sourcePorts.get(kind)?.values() ?? []) {
      for (const targetPort of targetPorts.get(kind)?.values() ?? []) {
        const confidence = candidateConfidence(sourcePort, targetPort);
        candidates.push({
          candidateId: candidateId(context.source.zhixuId, context.target.zhixuId, kind, sourcePort.signalId, targetPort.signalId),
          bindingKind: kind,
          sourceSignal: sourcePort,
          targetSignal: targetPort,
          confidence,
          reason: candidateReason(sourcePort, targetPort, confidence)
        });
      }
    }
  }
  return candidates
    .sort(compareCandidates)
    .slice(0, 12);
}

function roleSlotIdForStage(zhixu: ZhixuDetailDTO, stage: ZhixuStageDTO): string | undefined {
  return zhixu.orderPermissionTable.find((entry) => entry.stageId === stage.stageId)?.roleSlotId ??
    stage.ownerRole;
}

function roleLabelForSlot(zhixu: ZhixuDetailDTO, roleSlotId: string | undefined): string | undefined {
  if (!roleSlotId) {
    return undefined;
  }
  return zhixu.roleSlots.find((slot) => slot.slotId === roleSlotId)?.title;
}

function signalPort(input: {
  readonly signalId: string;
  readonly label: string;
  readonly bindingKind: StoreDockBindingKind;
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
    bindingKind: input.bindingKind,
    ...(input.stageId ? { stageId: input.stageId } : {}),
    ...(input.stageName ? { stageName: input.stageName } : {}),
    ...(input.roleSlotId ? { roleSlotId: input.roleSlotId } : {}),
    ...(input.roleLabel ? { roleLabel: input.roleLabel } : {}),
    payloadSchemaHash: schemaHash(input.evidence),
    schemaHint
  };
}

/**
 * 候选只做方向对齐与启发式排序，不做兼容性裁决：接口端口的 payload
 * hint 是协议引用（hook/signal 原文），与源侧证据清单不可比，兼容性
 * 由操作员在草稿中确认。
 */
function candidateConfidence(
  source: StoreDockingSignalPortDTO,
  target: StoreDockingSignalPortDTO
): StoreSignalMappingCandidateDTO["confidence"] {
  if (source.stageId && target.stageId && source.stageId === target.stageId) {
    return "high";
  }
  if (source.payloadSchemaHash && source.payloadSchemaHash === target.payloadSchemaHash) {
    return "medium";
  }
  return "low";
}

function candidateReason(
  source: StoreDockingSignalPortDTO,
  target: StoreDockingSignalPortDTO,
  confidence: StoreSignalMappingCandidateDTO["confidence"]
): string {
  if (confidence === "high") {
    return "阶段一致";
  }
  if (source.payloadSchemaHash === target.payloadSchemaHash) {
    return "payload hint 一致，需人工确认业务语义";
  }
  return "方向一致，需人工确认业务语义";
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

function candidateId(
  sourceZhixuId: string,
  targetZhixuId: string,
  bindingKind: StoreDockBindingKind,
  sourceSignalId: string,
  targetSignalId: string
): string {
  return `cand_${digest([sourceZhixuId, targetZhixuId, bindingKind, sourceSignalId, targetSignalId].join("|")).slice(0, 20)}`;
}

function schemaHash(evidence: readonly string[]): string {
  return `sha256:${digest([...evidence].map((item) => item.trim().toLowerCase()).sort().join("|")).slice(0, 32)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
    bindingKind: entry.bindingKind,
    sourceSignalId: entry.sourceSignalId.trim(),
    targetSignalId: entry.targetSignalId.trim(),
    ...(note ? { note } : {})
  };
}
