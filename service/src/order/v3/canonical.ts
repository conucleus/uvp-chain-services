// V3 订单域 canonical 规则单源：stageId/configHash/stage terms 哈希、窗口
// 表达式解析与默认窗口、必填 slot 推导、邀请接受的 EIP-712 构造。
// 所有派生字段只在这里计算，客户端自报的派生值不参与。

import {
  buildUVPStageInviteAcceptTypedData,
  type UVPStageInviteAcceptTypedData,
} from "@uvp-eth/protocol-bindings";
import { onchainStageId } from "@uvp-eth/compiler";
import type {
  ConfigBundleV3,
  ConfigStageV3,
  StageStandardRefV3,
  StageTermsV3,
  StageWindowValuesV3,
} from "@uvp-eth/product-dto";
import { canonicalJson, hashCanonicalJson } from "../../shared/canonical-json.js";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../../shared/types.js";
import { OrderV3Error } from "./types.js";

/** DSL 时间表达式上限：30d（2592000s）；超出由编译期拒绝，这里前置 422。 */
export const MAX_WINDOW_SECONDS = 2_592_000;
export const MIN_WINDOW_SECONDS = 1;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const WINDOW_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const WINDOW_EXPR_AMOUNT = /(?:\+|\b)(\d+)\s*([smhd])\b/;
const WINDOW_EXPR_UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
};

export function canonicalStageId(stageKey: string): Hex {
  if (typeof stageKey !== "string" || stageKey.trim().length === 0) {
    throw new OrderV3Error(422, "invalid_stage_subset", "stageKey must be a non-empty string");
  }
  return normalizeBytes32(onchainStageId(stageKey), "stageId");
}

/** 配置哈希对除 status 外的全部内容取 canonical JSON；发布后内容不可变。 */
export function configContentHash(bundle: ConfigBundleV3): Hex {
  const { status: _status, ...content } = bundle;
  return hashCanonicalJson(content, "configHash");
}

export function verifyConfigContentHash(input: {
  readonly configHash: string;
  readonly bundle: ConfigBundleV3;
}): void {
  const recomputed = configContentHash(input.bundle);
  if (recomputed !== normalizeBytes32(input.configHash, "configHash")) {
    throw new OrderV3Error(
      503,
      "config_hash_mismatch",
      "stored config content does not match its immutable configHash",
      { configHash: input.configHash, recomputed },
    );
  }
}

export interface StageTermsSource {
  readonly orderDraftId: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly configHash: Hex;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly slots: Readonly<Record<string, Address>>;
  readonly amount: string;
  readonly profileRef?: string;
  readonly standard?: StageStandardRefV3;
  readonly finalStandardHash: Hex;
  readonly inviteDeadline: string;
  readonly workDeadline: string;
}

/** 冻结条款的 canonical 形状：字段顺序由 canonicalJson 归一化。 */
export function canonicalStageTerms(source: StageTermsSource): StageTermsV3 {
  return {
    orderDraftId: source.orderDraftId,
    configId: source.configId,
    configVersion: source.configVersion,
    configHash: source.configHash,
    stageKey: source.stageKey,
    stageId: source.stageId,
    slots: source.slots,
    amount: source.amount,
    ...(source.profileRef !== undefined ? { profileRef: source.profileRef } : {}),
    ...(source.standard ? { standard: canonicalStandardRef(source.standard) } : {}),
    finalStandardHash: source.finalStandardHash,
    inviteDeadline: source.inviteDeadline,
    workDeadline: source.workDeadline,
  };
}

export function stageTermsHash(terms: StageTermsV3): Hex {
  return hashCanonicalJson(canonicalStageTerms(terms as StageTermsSource), "termsHash");
}

export function orderTermsHash(input: {
  readonly orderDraftId: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly configHash: Hex;
  readonly stages: readonly StageTermsV3[];
}): Hex {
  return hashCanonicalJson(
    {
      orderDraftId: input.orderDraftId,
      configId: input.configId,
      configVersion: input.configVersion,
      configHash: input.configHash,
      stages: input.stages.map((terms) => canonicalStageTerms(terms as StageTermsSource)),
    },
    "termsHash",
  );
}

export function canonicalStandardRef(input: StageStandardRefV3): StageStandardRefV3 {
  return {
    name: requireString(input.name, "standard.name"),
    ...(input.version !== undefined ? { version: requireString(input.version, "standard.version") } : {}),
    hash: normalizeFinalStandardHash({ finalStandardHash: input.hash, standard: input }),
    ...(input.ref !== undefined ? { ref: requireString(input.ref, "standard.ref") } : {}),
  };
}

export function sortWindowValues(
  values: Readonly<Record<string, number>>,
): StageWindowValuesV3 {
  return Object.fromEntries(
    Object.keys(values)
      .sort()
      .map((key) => [key, values[key]!] as const),
  );
}

/** 窗口值：数字秒或 `N s/m/h/d` 字面量；范围 1s..30d。 */
export function parseWindowSeconds(value: unknown, windowName: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < MIN_WINDOW_SECONDS || value > MAX_WINDOW_SECONDS) {
      throw new OrderV3Error(
        422,
        "invalid_window_value",
        `window ${windowName} must be an integer between ${MIN_WINDOW_SECONDS} and ${MAX_WINDOW_SECONDS} seconds`,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^(0|[1-9][0-9]*)$/.test(trimmed)) {
      return parseWindowSeconds(Number(trimmed), windowName);
    }
    const match = /^(\d+)\s*([smhd])$/.exec(trimmed);
    if (match) {
      const amount = Number(match[1]);
      const seconds = amount * (WINDOW_EXPR_UNIT_SECONDS[match[2]!] ?? 0);
      if (Number.isSafeInteger(seconds) && seconds >= MIN_WINDOW_SECONDS && seconds <= MAX_WINDOW_SECONDS) {
        return seconds;
      }
    }
  }
  throw new OrderV3Error(
    422,
    "invalid_window_value",
    `window ${windowName} must be seconds or a positive N s/m/h/d literal within 30 days`,
  );
}

/** 配置表达式里的窗口值（首个 `+N s/m/h/d`）；无可解析窗口返回 undefined。 */
export function parseWindowExpression(expr: string): number | undefined {
  const match = WINDOW_EXPR_AMOUNT.exec(expr);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const seconds = amount * (WINDOW_EXPR_UNIT_SECONDS[match[2]!] ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_WINDOW_SECONDS || seconds > MAX_WINDOW_SECONDS) {
    return undefined;
  }
  return seconds;
}

/** 某 stage 声明的窗口：默认值 + 允许区间，全部来自配置数据。 */
export interface WindowDeclaration {
  readonly defaultSeconds: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

export function windowDeclarations(
  config: ConfigBundleV3,
  stage: ConfigStageV3,
): Readonly<Record<string, WindowDeclaration>> {
  const declarations: Record<string, WindowDeclaration> = {};
  const globalExpressions = config.defaults?.timeExpressions ?? {};
  const timeDefaults = new Map((config.timeDefaults ?? []).map((entry) => [entry.name, entry.expr]));
  const windows = new Map((config.windows ?? []).map((entry) => [entry.key, entry]));
  const entries = [
    ...(stage.time ?? []).map((entry) => ({ name: entry.name, expr: entry.expr })),
    ...(stage.hooks ?? []).map((entry) => ({ name: entry.name, expr: entry.expr })),
  ];
  for (const entry of entries) {
    if (!WINDOW_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    const expr = entry.expr ?? timeDefaults.get(entry.name) ?? globalExpressions[entry.name];
    const placeholderKey = expr ? windowKeyFromExpression(expr) : undefined;
    const declared = windows.get(entry.name) ?? (placeholderKey ? windows.get(placeholderKey) : undefined);
    if (declared) {
      declarations[entry.name] = {
        defaultSeconds: parseWindowSeconds(declared.default, entry.name),
        minSeconds: declared.min !== undefined ? parseWindowSeconds(declared.min, `${entry.name}.min`) : MIN_WINDOW_SECONDS,
        maxSeconds: declared.max !== undefined ? parseWindowSeconds(declared.max, `${entry.name}.max`) : MAX_WINDOW_SECONDS,
      };
      continue;
    }
    const literal = expr ? parseWindowExpression(expr) : undefined;
    if (literal !== undefined) {
      declarations[entry.name] = {
        defaultSeconds: literal,
        minSeconds: MIN_WINDOW_SECONDS,
        maxSeconds: MAX_WINDOW_SECONDS,
      };
    }
  }
  return declarations;
}

export function stageWindowDefaults(
  config: ConfigBundleV3,
  stage: ConfigStageV3,
): Readonly<Record<string, number>> {
  const declarations = windowDeclarations(config, stage);
  return sortWindowValues(
    Object.fromEntries(Object.entries(declarations).map(([name, declaration]) => [name, declaration.defaultSeconds])),
  );
}

/**
 * 配置版本解析出的窗口值快照（窗口名 → 秒）。窗口只来自配置版本，
 * 不接受订单覆写；plan-generation 直接消费该快照/表达式。
 */
export function configWindowValues(
  config: ConfigBundleV3,
  stage: ConfigStageV3,
): StageWindowValuesV3 {
  return stageWindowDefaults(config, stage);
}

/**
 * 窗口属于凝结核配置：订单请求任何层级携带 windowValues/windows 等覆写
 * 字段都必须 422，不静默忽略。
 */
export function assertNoWindowOverride(value: unknown, fieldName = "body"): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.windowValues !== undefined) {
    throw new OrderV3Error(
      422,
      "window_override_forbidden",
      "time windows belong to the curator's config version; orders must not supply window overrides",
      { field: `${fieldName}.windowValues` },
    );
  }
}

export function windowKeyFromExpression(expr: string): string | undefined {
  const match = /\{\{\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\s*\}\}/.exec(expr);
  return match?.[1];
}

/** 有效验收方式：订单覆写 > stage 配置 > 默认配置 > self。 */

function stageSenderSlots(stage: ConfigStageV3): readonly string[] {
  return (stage.senders ?? []).map((sender) => (typeof sender === "string" ? sender : sender.slot));
}

/** 本 stage 必须接受的 slot：配置声明的 slot 键 ∪ senders 引用的 slot 键。 */
export function requiredSlotKeys(input: {
  readonly config: ConfigBundleV3;
  readonly stage: ConfigStageV3;
}): readonly string[] {
  const keys = new Set<string>(Object.keys(input.stage.slots ?? {}));
  for (const slot of stageSenderSlots(input.stage)) {
    keys.add(slot);
  }
  return [...keys].sort();
}

export function resolveStageStandard(
  config: ConfigBundleV3,
  stage: ConfigStageV3,
): StageStandardRefV3 | undefined {
  const first = stage.fileResources?.[0];
  const refName = typeof first === "string" ? first : first?.ref;
  if (!refName) {
    return undefined;
  }
  const declared = (config.fileResources ?? []).find(
    (resource) => resource.name === refName || resource.ref === refName,
  );
  const hashes = config.hashes?.fileResources as Readonly<Record<string, string>> | undefined;
  const hash = hashes?.[refName] ?? declared?.hash;
  if (!hash) {
    return undefined;
  }
  let normalizedHash: Hex;
  try {
    normalizedHash = normalizeFinalStandardHash({ finalStandardHash: hash });
  } catch {
    return undefined;
  }
  return {
    name: refName,
    ...(declared?.version !== undefined ? { version: declared.version } : {}),
    hash: normalizedHash,
    ...(declared?.ref !== undefined ? { ref: declared.ref } : {}),
  };
}

export function stageByKey(config: ConfigBundleV3, stageKey: string): ConfigStageV3 {
  const stage = config.stages.find((candidate) => candidate.key === stageKey);
  if (!stage) {
    throw new OrderV3Error(404, "stage_not_found", `stage ${stageKey} is not declared by the config`);
  }
  return stage;
}

export function isoToUnixSeconds(value: string, fieldName: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new OrderV3Error(422, "invalid_deadline", `${fieldName} must be an ISO-8601 timestamp`);
  }
  return String(Math.floor(millis / 1000));
}

/** 统一保存 ISO-8601（UTC, ms）形态，避免同一时刻多种写法影响签名/比较。 */
export function normalizeIsoDeadline(value: string, fieldName: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new OrderV3Error(422, "invalid_deadline", `${fieldName} must be an ISO-8601 timestamp`);
  }
  return new Date(millis).toISOString();
}

export function normalizeAmount(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new OrderV3Error(422, "invalid_amount", "amount must be a base-10 non-negative integer string");
  }
  if (value.length > 78) {
    throw new OrderV3Error(422, "invalid_amount", "amount is out of uint256 range");
  }
  return value;
}


export function optionalAddress(value: unknown, fieldName: string): Address | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requiredAddress(value, fieldName);
}

export function requiredAddress(value: unknown, fieldName: string): Address {
  const raw = requireString(value, fieldName);
  try {
    return normalizeAddress(raw, fieldName);
  } catch {
    throw new OrderV3Error(400, "invalid_address", `${fieldName} must be a valid EVM address`);
  }
}

export function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrderV3Error(400, "invalid_request", `${fieldName} must be a non-empty string`);
  }
  return value;
}

export function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OrderV3Error(400, "invalid_request", `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function normalizeFinalStandardHash(input: {
  readonly finalStandardHash?: unknown;
  readonly standard?: StageStandardRefV3;
}): Hex {
  const candidate = input.finalStandardHash ?? input.standard?.hash;
  if (typeof candidate !== "string") {
    throw new OrderV3Error(422, "invalid_final_standard_hash", "finalStandardHash is required");
  }
  const sha256 = /^sha256:([0-9a-fA-F]{64})$/.exec(candidate);
  const bytes32 = sha256 ? `0x${sha256[1]!.toLowerCase()}` : candidate;
  try {
    return normalizeBytes32(bytes32, "finalStandardHash");
  } catch {
    throw new OrderV3Error(
      422,
      "invalid_final_standard_hash",
      "finalStandardHash must be a 32-byte hex value or a sha256:<64 hex> digest",
    );
  }
}

export interface InviteTypedDataInput {
  readonly draftId: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly configHash: Hex;
  readonly chainId: number;
  readonly stateMachine: Address;
  readonly stageKey: string;
  readonly stageId: Hex;
  readonly slotKey: string;
  readonly inviteId: string;
  readonly invitee: Address;
  readonly amount: string;
  readonly finalStandardHash: Hex;
  readonly workDeadline: string;
  readonly termsHash: Hex;
  readonly nonce: string;
  readonly deadline: string;
}

export function buildInviteAcceptTypedData(
  input: InviteTypedDataInput,
): UVPStageInviteAcceptTypedData {
  return buildUVPStageInviteAcceptTypedData({
    chainId: input.chainId,
    verifyingContract: input.stateMachine,
    draftId: input.draftId,
    inviteId: input.inviteId,
    stageKey: input.stageKey,
    stageId: input.stageId,
    slotKey: input.slotKey,
    invitee: input.invitee,
    amount: input.amount,
    finalStandardHash: input.finalStandardHash,
    workDeadline: isoToUnixSeconds(input.workDeadline, "workDeadline"),
    termsHash: input.termsHash,
    nonce: input.nonce,
    deadline: isoToUnixSeconds(input.deadline, "deadline"),
  });
}

export { ZERO_ADDRESS, WINDOW_NAME_PATTERN, canonicalJson };
