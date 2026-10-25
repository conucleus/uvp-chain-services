// 配置注册表：发布不可变配置版本（configId+semver）、按版本读取、
// draft→published→deprecated 状态迁移与哈希校验。发布者白名单由装配层
// 注入（凝结核/运营钱包）；空名单 fail-closed。bundle 结构由配置 schema
// 定稿，这里只校验订单域需要的结构不变量并保留原始内容参与哈希。

import type {
  ConfigBundle,
  ConfigStage,
  ConfigVersion,
  OrderConfigStatus,
} from "@uvp-eth/product-dto";
import { planIdForPublisher } from "@uvp-eth/compiler";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../shared/types.js";
import {
  configContentHash,
  requireRecord,
  requireString,
  verifyConfigContentHash,
} from "./canonical.js";
import type { ConfigVersionRecord } from "./types.js";
import { OrderError } from "./types.js";

const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_CONFIG_KEYS = new Set([
  "marketplace",
  "matchmaking",
  "catalog",
  "suppliercatalog",
  "supplier_catalog",
]);

export interface OrderConfigServiceOptions {
  readonly store: Pick<
    import("./types.js").OrderStore,
    "getConfig" | "saveConfig" | "setConfigStatus"
  >;
  readonly publisherWallets: readonly Address[];
  readonly now?: () => Date;
}

export class OrderConfigService {
  readonly #store: OrderConfigServiceOptions["store"];
  readonly #publishers: ReadonlySet<string>;
  readonly #now: () => Date;

  constructor(options: OrderConfigServiceOptions) {
    this.#store = options.store;
    this.#publishers = new Set(options.publisherWallets.map((wallet) => wallet.toLowerCase()));
    this.#now = options.now ?? (() => new Date());
  }

  async publish(actor: Address, body: unknown): Promise<ConfigVersion> {
    const wallet = this.#requirePublisher(actor);
    const input = requireRecord(body, "body");
    const rawBundle = input.config !== undefined ? requireRecord(input.config, "config") : input;
    const bundle = parseConfigBundle(rawBundle);
    const requestedStatus = input.status ?? bundle.status;
    if (requestedStatus !== "draft" && requestedStatus !== "published") {
      throw new OrderError(422, "invalid_request", "config status can only be draft or published on write");
    }
    const planInput = input.plan !== undefined ? requireRecord(input.plan, "plan") : input;
    const plan = parsePublishedPlan(planInput);
    const birth = parseBirthRoute(input.birth ?? planInput.birth);
    const providedHash = input.configHash ?? (rawBundle as Record<string, unknown>).configHash;
    const computed = configContentHash(bundle);
    if (providedHash !== undefined) {
      const normalized = normalizeBytes32Value(providedHash);
      if (normalized !== computed) {
        throw new OrderError(422, "config_hash_mismatch", "configHash does not match canonical config content", {
          configHash: normalized,
          computed,
        });
      }
    }

    const existing = await this.#store.getConfig(bundle.configId, bundle.version);
    if (existing) {
      if (existing.configHash !== computed) {
        throw new OrderError(
          409,
          "config_version_exists",
          `config ${bundle.configId}@${bundle.version} is immutable and already published with different content`,
        );
      }
      return toConfigVersionDto(existing);
    }

    const now = this.#now().toISOString();
    const record: ConfigVersionRecord = {
      configId: bundle.configId,
      version: bundle.version,
      status: requestedStatus,
      configHash: computed,
      ...(plan ? { planId: plan.planId, planHash: plan.planHash } : {}),
      ...(birth ? { birth } : {}),
      bundle: withStatus(bundle, requestedStatus),
      createdBy: wallet,
      createdAt: now,
      ...(requestedStatus === "published" ? { publishedAt: now } : {}),
      updatedAt: now,
    };
    await this.#store.saveConfig(record);
    return toConfigVersionDto(record);
  }

  async publishVersion(actor: Address, configId: string, version: string): Promise<ConfigVersion> {
    this.#requirePublisher(actor);
    const existing = await this.#store.getConfig(requireString(configId, "configId"), requireString(version, "version"));
    if (!existing) {
      throw new OrderError(404, "config_not_found", "config version was not found");
    }
    if (existing.status === "published" || existing.status === "deprecated") {
      if (existing.status === "published") {
        return toConfigVersionDto(existing);
      }
      throw new OrderError(409, "config_already_deprecated", "a deprecated config version cannot be republished");
    }
    const now = this.#now().toISOString();
    const updated = await this.#store.setConfigStatus(existing.configId, existing.version, "published", now, now);
    if (!updated) {
      throw new OrderError(409, "config_version_not_draft", "config version is no longer a draft");
    }
    const published = await this.#store.getConfig(existing.configId, existing.version);
    if (!published) {
      throw new OrderError(503, "config_not_found", "config version disappeared during publish");
    }
    return toConfigVersionDto(published);
  }

  async deprecate(actor: Address, configId: string, version: string): Promise<ConfigVersion> {
    this.#requirePublisher(actor);
    const existing = await this.#store.getConfig(requireString(configId, "configId"), requireString(version, "version"));
    if (!existing) {
      throw new OrderError(404, "config_not_found", "config version was not found");
    }
    if (existing.status === "draft") {
      throw new OrderError(409, "config_version_not_draft", "a draft config version cannot be deprecated");
    }
    if (existing.status === "deprecated") {
      return toConfigVersionDto(existing);
    }
    const now = this.#now().toISOString();
    const updated = await this.#store.setConfigStatus(existing.configId, existing.version, "deprecated", now);
    if (!updated) {
      throw new OrderError(409, "config_already_deprecated", "config version could not be deprecated");
    }
    const deprecated = await this.#store.getConfig(existing.configId, existing.version);
    if (!deprecated) {
      throw new OrderError(503, "config_not_found", "config version disappeared during deprecate");
    }
    return toConfigVersionDto(deprecated);
  }

  async read(actor: Address, configId: string, version: string): Promise<ConfigVersion> {
    const wallet = normalizeAddress(actor, "actor").toLowerCase();
    const record = await this.#store.getConfig(requireString(configId, "configId"), requireString(version, "version"));
    if (!record) {
      throw new OrderError(404, "config_not_found", "config version was not found");
    }
    if (record.status === "draft" && record.createdBy.toLowerCase() !== wallet) {
      throw new OrderError(404, "config_not_found", "config version was not found");
    }
    verifyConfigContentHash({ configHash: record.configHash, bundle: record.bundle });
    return toConfigVersionDto(record);
  }

  async requirePublished(configId: string, version: string): Promise<ConfigVersionRecord> {
    const record = await this.#store.getConfig(requireString(configId, "configId"), requireString(version, "version"));
    if (!record) {
      throw new OrderError(404, "config_not_found", "config version was not found");
    }
    if (record.status !== "published") {
      throw new OrderError(409, "config_not_published", "orders can only bind a published config version");
    }
    verifyConfigContentHash({ configHash: record.configHash, bundle: record.bundle });
    return record;
  }

  #requirePublisher(actor: Address): Address {
    const wallet = normalizeAddress(actor, "actor").toLowerCase() as Address;
    if (this.#publishers.size === 0 || !this.#publishers.has(wallet)) {
      throw new OrderError(403, "config_publish_forbidden", "the session wallet is not allowed to publish config versions");
    }
    return wallet;
  }
}

export function parseConfigBundle(value: unknown): ConfigBundle {
  const record = requireRecord(value, "config");
  if (record.schema !== undefined && record.schema !== "uvp.order-config/v3") {
    throw new OrderError(422, "invalid_request", "schema must be uvp.order-config/v3 when present");
  }
  const configId = requireString(record.configId, "configId");
  if (!CONFIG_ID_PATTERN.test(configId)) {
    throw new OrderError(422, "invalid_request", "configId must be a namespaced identifier");
  }
  const version = requireString(record.version, "version");
  if (!SEMVER_PATTERN.test(version)) {
    throw new OrderError(422, "invalid_request", "version must be an immutable semver string");
  }
  const status = requireRecordStatus(record.status);
  rejectForbiddenConfigKeys(record);

  const slotKeys = parseSlots(record.slots);
  const stageKeys = parseStages(record.stages, slotKeys);
  if (record.stageSubsets !== undefined) {
    parseStageKeyMap(record.stageSubsets, "stageSubsets", stageKeys);
  }
  if (record.stageProfiles !== undefined) {
    parseStageKeyMap(record.stageProfiles, "stageProfiles", stageKeys);
  }
  if (record.defaultProfile !== undefined) {
    requireString(record.defaultProfile, "defaultProfile");
  }
  if (record.windows !== undefined) {
    if (!Array.isArray(record.windows)) {
      throw new OrderError(422, "invalid_request", "windows must be an array");
    }
    for (const [index, window] of record.windows.entries()) {
      const entry = requireRecord(window, `windows[${index}]`);
      const key = requireString(entry.key, `windows[${index}].key`);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key)) {
        throw new OrderError(422, "invalid_request", `window key ${key} is not a valid identifier`);
      }
      requireString(entry.default, `windows[${index}].default`);
    }
  }
  if (record.timeDefaults !== undefined) {
    if (!Array.isArray(record.timeDefaults)) {
      throw new OrderError(422, "invalid_request", "timeDefaults must be an array");
    }
    for (const [index, entry] of record.timeDefaults.entries()) {
      const timeDefault = requireRecord(entry, `timeDefaults[${index}]`);
      requireString(timeDefault.name, `timeDefaults[${index}].name`);
      requireString(timeDefault.expr, `timeDefaults[${index}].expr`);
    }
  }
  return { ...record, configId, version, status } as unknown as ConfigBundle;
}

function parseSlots(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OrderError(422, "invalid_request", "slots must be a non-empty array");
  }
  const keys = new Set<string>();
  for (const [index, slotValue] of value.entries()) {
    const slot = requireRecord(slotValue, `slots[${index}]`);
    const key = requireString(slot.key, `slots[${index}].key`);
    if (keys.has(key)) {
      throw new OrderError(422, "invalid_request", `duplicate slot ${key}`);
    }
    keys.add(key);
    const kind = slot.kind ?? "participant";
    if (kind !== "participant" && kind !== "contract" && kind !== "oracle") {
      throw new OrderError(422, "invalid_request", `slot ${key} has unsupported kind`);
    }
  }
  return keys;
}

function parseStages(value: unknown, slotKeys: ReadonlySet<string>): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OrderError(422, "invalid_request", "stages must be a non-empty array");
  }
  const stageKeys = new Set<string>();
  for (const [index, stageValue] of value.entries()) {
    const stage = requireRecord(stageValue, `stages[${index}]`);
    const key = requireString(stage.key, `stages[${index}].key`);
    if (stageKeys.has(key)) {
      throw new OrderError(422, "invalid_request", `duplicate stage ${key}`);
    }
    stageKeys.add(key);
    rejectForbiddenConfigKeys(stage);
    const stageSlots = stage.slots !== undefined ? requireRecord(stage.slots, `stages[${index}].slots`) : undefined;
    if (stageSlots) {
      for (const [role, slotKey] of Object.entries(stageSlots)) {
        assertDeclaredSlot(slotKey, slotKeys, `stage ${key} slot ${role}`);
      }
    }
    if (stage.senders !== undefined) {
      if (!Array.isArray(stage.senders)) {
        throw new OrderError(422, "invalid_request", `stages[${index}].senders must be an array`);
      }
      for (const [senderIndex, sender] of stage.senders.entries()) {
        const slotKey = typeof sender === "string"
          ? requireString(sender, `stages[${index}].senders[${senderIndex}]`)
          : requireString(requireRecord(sender, `stages[${index}].senders[${senderIndex}]`).slot, `stages[${index}].senders[${senderIndex}].slot`);
        assertDeclaredSlot(slotKey, slotKeys, `stage ${key} sender`);
      }
    }
    for (const field of ["time", "hooks"] as const) {
      const entries = stage[field];
      if (entries === undefined) {
        continue;
      }
      if (!Array.isArray(entries)) {
        throw new OrderError(422, "invalid_request", `stages[${index}].${field} must be an array`);
      }
      for (const [entryIndex, entryValue] of entries.entries()) {
        const entry = requireRecord(entryValue, `stages[${index}].${field}[${entryIndex}]`);
        requireString(entry.name, `stages[${index}].${field}[${entryIndex}].name`);
        if (entry.expr !== undefined && typeof entry.expr !== "string") {
          throw new OrderError(422, "invalid_request", `stages[${index}].${field}[${entryIndex}].expr must be a string`);
        }
      }
    }
    const fileResources = stage.fileResources;
    if (fileResources !== undefined) {
      if (!Array.isArray(fileResources)) {
        throw new OrderError(422, "invalid_request", `stages[${index}].fileResources must be an array`);
      }
      for (const [entryIndex, entry] of fileResources.entries()) {
        if (typeof entry === "string") {
          requireString(entry, `stages[${index}].fileResources[${entryIndex}]`);
        } else {
          requireString(
            requireRecord(entry, `stages[${index}].fileResources[${entryIndex}]`).ref,
            `stages[${index}].fileResources[${entryIndex}].ref`,
          );
        }
      }
    }
  }
  return stageKeys;
}

function parseStageKeyMap(value: unknown, fieldName: string, stageKeys: ReadonlySet<string>): void {
  const map = requireRecord(value, fieldName);
  for (const [name, list] of Object.entries(map)) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new OrderError(422, "invalid_request", `${fieldName}.${name} must be a non-empty array`);
    }
    for (const [index, key] of list.entries()) {
      const stageKey = requireString(key, `${fieldName}.${name}[${index}]`);
      if (!stageKeys.has(stageKey)) {
        throw new OrderError(422, "invalid_request", `${fieldName}.${name} references unknown stage ${stageKey}`);
      }
    }
  }
}

function assertDeclaredSlot(
  value: unknown,
  slotKeys: ReadonlySet<string>,
  fieldName: string,
): void {
  const slotKey = requireString(value, fieldName);
  if (!slotKeys.has(slotKey)) {
    throw new OrderError(422, "invalid_request", `${fieldName} references unknown slot ${slotKey}`);
  }
}


function requireRecordStatus(value: unknown): OrderConfigStatus {
  if (value === "draft" || value === "published" || value === "deprecated") {
    return value;
  }
  throw new OrderError(422, "invalid_request", "status must be draft, published, or deprecated");
}

function rejectForbiddenConfigKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_CONFIG_KEYS.has(key.toLowerCase())) {
      throw new OrderError(422, "invalid_request", "config bundles must not declare marketplace/matchmaking/catalog fields");
    }
  }
}

function parsePublishedPlan(input: Record<string, unknown>): { readonly planId: Hex; readonly planHash: Hex } | undefined {
  const planInput = input.plan !== undefined && typeof input.plan === "object" && input.plan !== null
    ? (input.plan as Record<string, unknown>)
    : input;
  const registrationPlanId =
    input.registrationPlanId ?? planInput.registrationPlanId ?? planInput.planId;
  const registrationPlanHash =
    input.registrationPlanHash ?? planInput.registrationPlanHash ?? planInput.planHash;
  const contentPlanId = input.contentPlanId ?? planInput.contentPlanId;
  const publisher = input.publisher ?? planInput.publisher;
  const runtimePlanHash = input.runtimePlanHash ?? planInput.runtimePlanHash;
  if (registrationPlanId === undefined && registrationPlanHash === undefined) {
    if (contentPlanId !== undefined) {
      throw new OrderError(
        422,
        "registration_plan_required",
        "contentPlanId (manifest.plan.planId) is not an order planId; publish the registration planId/planHash from publishPlan",
      );
    }
    return undefined;
  }
  if (registrationPlanId === undefined || registrationPlanHash === undefined) {
    throw new OrderError(422, "invalid_request", "registrationPlanId and registrationPlanHash must be provided together");
  }
  const planId = normalizeBytes32Value(registrationPlanId);
  const planHash = normalizeBytes32Value(registrationPlanHash);
  if (contentPlanId !== undefined && normalizeBytes32Value(contentPlanId) === planId) {
    throw new OrderError(
      422,
      "registration_plan_required",
      "manifest.plan.planId is a content planId; orders must bind the registration planId derived from publisher+planRuntimeHash",
    );
  }
  if (publisher !== undefined || runtimePlanHash !== undefined) {
    if (publisher === undefined || runtimePlanHash === undefined) {
      throw new OrderError(422, "invalid_request", "publisher and runtimePlanHash must be provided together to verify the registration planId");
    }
    const publisherAddress = normalizeAddress(requireString(publisher, "publisher"), "publisher");
    const runtimeHash = normalizeBytes32Value(runtimePlanHash);
    const derived = normalizeBytes32(planIdForPublisher(publisherAddress, runtimeHash), "planId");
    if (derived !== planId) {
      throw new OrderError(
        422,
        "registration_plan_mismatch",
        "registrationPlanId is not planIdForPublisher(publisher, runtimePlanHash)",
        { derived, provided: planId },
      );
    }
  }
  return { planId, planHash };
}

export function parseBirthRoute(value: unknown): import("./types.js").ConfigBirthRecord | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, "birth");
  const sourceId = normalizeBytes32Value(requireString(record.sourceId, "birth.sourceId"));
  const signalId = normalizeBytes32Value(requireString(record.signalId, "birth.signalId"));
  const birthAuthorizer = normalizeAddress(
    requireString(record.birthAuthorizer, "birth.birthAuthorizer"),
    "birthAuthorizer",
  );
  if (record.attribution === undefined) {
    throw new OrderError(
      422,
      "birth_attribution_missing",
      "capability plan birth requires birth.attribution (stageId + capabilityProof); zero attribution would revert InvalidSignalCapability",
    );
  }
  return {
    triggerHookId: normalizeBytes32Value(requireString(record.triggerHookId, "birth.triggerHookId")),
    triggerStageId: normalizeBytes32Value(requireString(record.triggerStageId, "birth.triggerStageId")),
    sourceId,
    signalId,
    birthAuthorizer,
    attribution: parseBirthAttribution(record.attribution, sourceId, signalId),
    ...(record.authorizations !== undefined
      ? { authorizations: parseBirthAuthorizations(record.authorizations, birthAuthorizer) }
      : {}),
  };
}

function parseBirthAttribution(value: unknown, sourceId: Hex, signalId: Hex): import("./types.js").ConfigBirthProof {
  const record = requireRecord(value, "birth.attribution");
  const attributionSource = normalizeBytes32Value(requireString(record.sourceId, "birth.attribution.sourceId"));
  const attributionSignal = normalizeBytes32Value(requireString(record.signalId, "birth.attribution.signalId"));
  if (attributionSource !== sourceId || attributionSignal !== signalId) {
    throw new OrderError(422, "birth_attribution_mismatch", "birth factAttribution must cover the birth sourceId/signalId");
  }
  if (!Array.isArray(record.capabilityProof)) {
    throw new OrderError(422, "invalid_request", "birth.attribution.capabilityProof must be an array");
  }
  return {
    sourceId: attributionSource,
    signalId: attributionSignal,
    stageId: normalizeBytes32Value(requireString(record.stageId, "birth.attribution.stageId")),
    capabilityProof: record.capabilityProof.map((proof, index) =>
      normalizeBytes32Value(requireString(proof, `birth.attribution.capabilityProof[${index}]`))),
  };
}

function parseBirthAuthorizations(
  value: unknown,
  birthAuthorizer: Address,
): readonly import("./types.js").ConfigBirthAuthorization[] {
  if (!Array.isArray(value)) {
    throw new OrderError(422, "invalid_request", "birth.authorizations must be an array");
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, `birth.authorizations[${index}]`);
    const submitter = normalizeAddress(requireString(record.submitter, `birth.authorizations[${index}].submitter`), "submitter");
    if (submitter !== birthAuthorizer) {
      throw new OrderError(422, "birth_attribution_mismatch", "birth authorizations must be signed by the plan birthAuthorizer");
    }
    return {
      sourceId: normalizeBytes32Value(requireString(record.sourceId, `birth.authorizations[${index}].sourceId`)),
      signalId: normalizeBytes32Value(requireString(record.signalId, `birth.authorizations[${index}].signalId`)),
      submitter,
      role: normalizeBytes32Value(requireString(record.role, `birth.authorizations[${index}].role`)),
      metadataHash: normalizeBytes32Value(requireString(record.metadataHash, `birth.authorizations[${index}].metadataHash`)),
    };
  });
}

function normalizeBytes32Value(value: unknown): Hex {
  if (typeof value !== "string") {
    throw new OrderError(422, "config_hash_mismatch", "configHash must be a 32-byte hex value");
  }
  try {
    return normalizeBytes32(value, "configHash");
  } catch {
    throw new OrderError(422, "config_hash_mismatch", "configHash must be a 32-byte hex value");
  }
}

function withStatus(bundle: ConfigBundle, status: OrderConfigStatus): ConfigBundle {
  return { ...bundle, status };
}

export function toConfigVersionDto(record: ConfigVersionRecord): ConfigVersion {
  return {
    configId: record.configId,
    version: record.version,
    status: record.status,
    configHash: record.configHash,
    createdBy: record.createdBy,
    ...(record.bundle.title !== undefined ? { title: record.bundle.title } : {}),
    ...(record.bundle.currency !== undefined ? { currency: record.bundle.currency } : {}),
    ...(record.planId !== undefined ? { planId: record.planId } : {}),
    ...(record.planHash !== undefined ? { planHash: record.planHash } : {}),
    ...(record.birth !== undefined ? { birth: record.birth } : {}),
    createdAt: record.createdAt,
    ...(record.publishedAt !== undefined ? { publishedAt: record.publishedAt } : {}),
    bundle: withStatus(record.bundle, record.status),
  };
}

export type { ConfigStage };
