// 订单要求包的结构校验单源（服务端权威）：句柄 key 唯一、fileType 闭集、
// locator 必填且与类型匹配、密钥/凭据字段一律拒绝（含不透明 metadata 的
// 字段名），cipher/keyRef 只接受引用。requirementsHash 只对 declaration 的
// canonical JSON 计算，客户端自报的派生字段直接拒绝。

import {
  FILE_RESOURCE_TYPES,
  ORDER_REQUIREMENTS_SCHEMA_VERSION,
  PRODUCT_RESOURCE_VISIBILITIES,
  type FileResourceHandleDTO,
  type FileResourceLocatorDTO,
  type FileResourceType,
  type OrderRequirementDTO,
  type OrderRequirementPresetRefDTO,
  type OrderRequirementsDeclarationDTO,
} from "@uvp-eth/product-dto";
import { canonicalJson, hashCanonicalJson } from "@uvp-eth/canonical-json";
import { normalizeBytes32, type Hex } from "../../shared/types.js";
import { OrderRequirementsError } from "./types.js";

const DECLARATION_FIELDS = new Set([
  "schemaVersion",
  "requirements",
  "presets",
]);
const REQUIREMENT_FIELDS = new Set([
  "key",
  "stageId",
  "label",
  "dueAt",
  "handles",
  "presetRef",
]);
const HANDLE_FIELDS = new Set([
  "key",
  "fileType",
  "locator",
  "contentHash",
  "cipherHash",
  "visibility",
  "policyRef",
  "cipher",
  "metadata",
]);
const PRESET_FIELDS = new Set(["name", "version", "hash", "ref"]);
const CIPHER_FIELDS = new Set(["alg", "keyRef"]);

const LOCATOR_FIELD_BY_TYPE: Readonly<
  Record<FileResourceType, keyof FileResourceLocatorDTO>
> = {
  http: "httpFile",
  txcloud: "txCloudFile",
  local: "localFile",
  plain_text: "plainText",
};

const LOCATOR_REQUIRED_FIELDS: Readonly<
  Record<FileResourceType, readonly string[]>
> = {
  http: ["url"],
  txcloud: ["bucket", "region", "objectKey"],
  local: ["path"],
  plain_text: ["ref"],
};

const HANDLE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#@+=-]{0,255}$/;

const SECRET_FIELD_NAMES = new Set([
  "key",
  "apikey",
  "secret",
  "secretid",
  "secretkey",
  "clientsecret",
  "privatekey",
  "credential",
  "credentials",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "token",
  "accesstoken",
  "sessiontoken",
  "bearertoken",
  "refreshtoken",
  "authtoken",
  "authorization",
  "auth",
  "mnemonic",
  "seed",
  "seedphrase",
  "signingkey",
  "encryptionkey",
  "accesskey",
  "accesskeyid",
  "accesskeysecret",
  "secretaccesskey",
  "tmpsecretid",
  "tmpsecretkey",
  "sessionkey",
  "sharedsecret",
  "jwt",
  "ststoken",
]);

export function requirementsHashOf(
  declaration: OrderRequirementsDeclarationDTO,
): Hex {
  return hashCanonicalJson(declaration);
}

export function parseOrderRequirementsDeclaration(
  body: unknown,
): OrderRequirementsDeclarationDTO {
  if (!isRecord(body)) {
    throw invalidBody("request body must be a JSON object");
  }
  for (const field of [
    "declaredBy",
    "requirementsHash",
    "consents",
    "declaredAt",
    "updatedAt",
  ]) {
    if (Object.hasOwn(body, field)) {
      throw new OrderRequirementsError(
        400,
        "immutable_field",
        `${field} is derived by the server and cannot be set by clients`,
        { field },
      );
    }
  }
  for (const field of Object.keys(body)) {
    if (DECLARATION_FIELDS.has(field)) {
      continue;
    }
    rejectSecretField(field, field) ??
      throwInvalid(
        "declaration_field_unknown",
        `unknown declaration field ${field}`,
        { field },
      );
  }
  if (body.schemaVersion !== ORDER_REQUIREMENTS_SCHEMA_VERSION) {
    throwInvalid(
      "schema_version_unsupported",
      `schemaVersion must be ${ORDER_REQUIREMENTS_SCHEMA_VERSION}`,
      { schemaVersion: body.schemaVersion },
    );
  }
  const rawRequirements = body.requirements;
  if (!Array.isArray(rawRequirements)) {
    throw invalidBody("requirements must be an array");
  }
  if (rawRequirements.length === 0) {
    throwInvalid(
      "requirements_empty",
      "requirements must declare at least one requirement",
    );
  }
  const requirementKeys = new Set<string>();
  const handleKeys = new Set<string>();
  const requirements = rawRequirements.map((entry, index) =>
    parseRequirement(
      entry,
      `requirements[${index}]`,
      requirementKeys,
      handleKeys,
    ),
  );
  const rawPresets = body.presets;
  if (!Array.isArray(rawPresets)) {
    throw invalidBody("presets must be an array (possibly empty)");
  }
  const presetIds = new Set<string>();
  const presets = rawPresets.map((entry, index) => {
    const preset = parsePresetRef(entry, `presets[${index}]`);
    const presetId = `${preset.name}@${preset.version}`;
    if (presetIds.has(presetId)) {
      throwInvalid(
        "requirement_preset_duplicate",
        `preset ${presetId} is declared more than once`,
        { presetId },
      );
    }
    presetIds.add(presetId);
    return preset;
  });
  return {
    schemaVersion: ORDER_REQUIREMENTS_SCHEMA_VERSION,
    requirements,
    presets,
  };
}

function parseRequirement(
  value: unknown,
  path: string,
  requirementKeys: Set<string>,
  handleKeys: Set<string>,
): OrderRequirementDTO {
  if (!isRecord(value)) {
    throw invalidBody(`${path} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (REQUIREMENT_FIELDS.has(field)) {
      continue;
    }
    rejectSecretField(field, `${path}.${field}`);
    throwInvalid(
      "requirement_field_unknown",
      `${path}.${field} is not a requirement field`,
      { path, field },
    );
  }
  const key = requireName(
    value.key,
    `${path}.key`,
    "requirement_key_invalid",
  );
  if (!HANDLE_KEY_PATTERN.test(key)) {
    throwInvalid(
      "requirement_key_invalid",
      `${path}.key must be a short name (letters, digits, ".", "_", "-")`,
      { path },
    );
  }
  if (requirementKeys.has(key)) {
    throwInvalid(
      "requirement_key_duplicate",
      `requirement key ${key} is declared more than once`,
      { key },
    );
  }
  requirementKeys.add(key);
  const stageId = optionalName(value.stageId, `${path}.stageId`);
  const label = optionalName(value.label, `${path}.label`);
  const dueAt = optionalDueAt(value.dueAt, `${path}.dueAt`);
  const rawHandles = value.handles;
  if (!Array.isArray(rawHandles)) {
    throwInvalid(
      "handle_list_invalid",
      `${path}.handles must be an array`,
      { path },
    );
  }
  const handles = rawHandles.map((handle, index) =>
    parseHandle(handle, `${path}.handles[${index}]`, handleKeys),
  );
  const presetRef = Object.hasOwn(value, "presetRef")
    ? parsePresetRef(value.presetRef, `${path}.presetRef`)
    : undefined;
  return {
    key,
    ...(stageId !== undefined ? { stageId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    handles,
    ...(presetRef !== undefined ? { presetRef } : {}),
  };
}

function parseHandle(
  value: unknown,
  path: string,
  handleKeys: Set<string>,
): FileResourceHandleDTO {
  if (!isRecord(value)) {
    throw invalidBody(`${path} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (HANDLE_FIELDS.has(field)) {
      continue;
    }
    rejectSecretField(field, `${path}.${field}`);
    throwInvalid(
      "handle_field_unknown",
      `${path}.${field} is not a file handle field`,
      { path, field },
    );
  }
  const key = requireName(value.key, `${path}.key`, "handle_key_invalid");
  if (!HANDLE_KEY_PATTERN.test(key)) {
    throwInvalid(
      "handle_key_invalid",
      `${path}.key must be a short name (letters, digits, ".", "_", "-")`,
      { path },
    );
  }
  if (handleKeys.has(key)) {
    throwInvalid(
      "handle_key_duplicate",
      `handle key ${key} is declared more than once`,
      { key },
    );
  }
  handleKeys.add(key);

  const fileType = value.fileType;
  if (
    typeof fileType !== "string" ||
    !FILE_RESOURCE_TYPES.includes(fileType as FileResourceType)
  ) {
    throwInvalid(
      "handle_file_type_unsupported",
      `${path}.fileType must be one of ${FILE_RESOURCE_TYPES.join("|")}`,
      { path, fileType },
    );
  }
  const typedFileType = fileType as FileResourceType;
  const locatorValue = value.locator;
  if (!isRecord(locatorValue)) {
    throwInvalid(
      "handle_locator_invalid",
      `${path}.locator is required and must be an object`,
      { path, fileType: typedFileType },
    );
  }
  rejectSecretFieldsIn(locatorValue, "locator", `${path}.locator`);
  const locatorField = LOCATOR_FIELD_BY_TYPE[typedFileType];
  if (
    Object.keys(locatorValue).length !== 1 ||
    !Object.hasOwn(locatorValue, locatorField)
  ) {
    throwInvalid(
      "handle_locator_invalid",
      `${path}.locator must carry exactly ${locatorField} for fileType ${typedFileType}`,
      { path, fileType: typedFileType, locatorField },
    );
  }
  const locator = parseLocator(
    typedFileType,
    locatorValue[locatorField],
    `${path}.locator.${locatorField}`,
  );

  const contentHash = optionalHash(
    value,
    "contentHash",
    `${path}.contentHash`,
  );
  const cipherHash = optionalHash(value, "cipherHash", `${path}.cipherHash`);

  let visibility: FileResourceHandleDTO["visibility"] | undefined;
  if (Object.hasOwn(value, "visibility")) {
    const raw = value.visibility;
    if (
      typeof raw !== "string" ||
      !PRODUCT_RESOURCE_VISIBILITIES.includes(
        raw as (typeof PRODUCT_RESOURCE_VISIBILITIES)[number],
      )
    ) {
      throwInvalid(
        "handle_visibility_invalid",
        `${path}.visibility must be one of ${PRODUCT_RESOURCE_VISIBILITIES.join("|")}`,
        { path, visibility: raw },
      );
    }
    visibility = raw as FileResourceHandleDTO["visibility"];
  }

  let policyRef: string | undefined;
  if (Object.hasOwn(value, "policyRef")) {
    policyRef = assertReference(
      value.policyRef,
      `${path}.policyRef`,
      "handle_policy_ref_invalid",
      "policyRef",
    );
  }

  let cipher: FileResourceHandleDTO["cipher"] | undefined;
  if (Object.hasOwn(value, "cipher")) {
    const cipherValue = value.cipher;
    if (!isRecord(cipherValue)) {
      throwInvalid(
        "handle_cipher_invalid",
        `${path}.cipher must be an object with alg and keyRef`,
        { path },
      );
    }
    rejectSecretFieldsIn(cipherValue, "cipher", `${path}.cipher`);
    for (const field of Object.keys(cipherValue)) {
      if (!CIPHER_FIELDS.has(field)) {
        throwInvalid(
          "handle_cipher_invalid",
          `${path}.cipher.${field} is not a cipher field (only alg and keyRef are allowed)`,
          { path, field },
        );
      }
    }
    const alg = requireName(
      cipherValue.alg,
      `${path}.cipher.alg`,
      "handle_cipher_invalid",
    );
    const keyRef = assertReference(
      cipherValue.keyRef,
      `${path}.cipher.keyRef`,
      "handle_cipher_invalid",
      "keyRef",
    );
    cipher = { alg, keyRef };
  }

  let metadata: unknown;
  if (Object.hasOwn(value, "metadata")) {
    metadata = value.metadata;
    if (metadata !== undefined) {
      rejectSecretFieldsIn(metadata, "metadata", `${path}.metadata`);
      try {
        canonicalJson(metadata);
      } catch {
        throwInvalid(
          "handle_metadata_invalid",
          `${path}.metadata must be canonical JSON (integers only, no undefined)`,
          { path },
        );
      }
    }
  }

  return {
    key,
    fileType: typedFileType,
    locator,
    ...(contentHash !== undefined ? { contentHash } : {}),
    ...(cipherHash !== undefined ? { cipherHash } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(policyRef !== undefined ? { policyRef } : {}),
    ...(cipher !== undefined ? { cipher } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function parseLocator(
  fileType: FileResourceType,
  value: unknown,
  path: string,
): FileResourceLocatorDTO {
  if (!isRecord(value)) {
    throwInvalid(
      "handle_locator_invalid",
      `${path} must be an object`,
      { fileType },
    );
  }
  const requiredFields = LOCATOR_REQUIRED_FIELDS[fileType];
  for (const field of Object.keys(value)) {
    if (!requiredFields.includes(field)) {
      throwInvalid(
        "handle_locator_invalid",
        `${path}.${field} is not part of a ${fileType} locator`,
        { fileType, field },
      );
    }
  }
  const readField = (field: string): string => {
    const raw = value[field];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throwInvalid(
        "handle_locator_invalid",
        `${path}.${field} is required for fileType ${fileType}`,
        { fileType, field },
      );
    }
    return raw.trim();
  };
  switch (fileType) {
    case "http": {
      const url = readField("url");
      if (!/^https?:\/\/[^\s]+$/i.test(url)) {
        throwInvalid(
          "handle_locator_invalid",
          `${path}.url must be an absolute http(s) URL`,
          { fileType, field: "url" },
        );
      }
      return { httpFile: { url } };
    }
    case "txcloud":
      return {
        txCloudFile: {
          bucket: readField("bucket"),
          region: readField("region"),
          objectKey: readField("objectKey"),
        },
      };
    case "local":
      return { localFile: { path: readField("path") } };
    case "plain_text": {
      const ref = readField("ref");
      assertReference(ref, path, "handle_locator_invalid", "ref");
      return { plainText: { ref } };
    }
  }
}

function parsePresetRef(
  value: unknown,
  path: string,
): OrderRequirementPresetRefDTO {
  if (!isRecord(value)) {
    throwInvalid("preset_ref_invalid", `${path} must be an object`, { path });
  }
  for (const field of Object.keys(value)) {
    if (PRESET_FIELDS.has(field)) {
      continue;
    }
    rejectSecretField(field, `${path}.${field}`);
    throwInvalid(
      "preset_ref_invalid",
      `${path}.${field} is not a preset reference field`,
      { path, field },
    );
  }
  const name = requireName(
    value.name,
    `${path}.name`,
    "preset_ref_invalid",
  );
  const version = requireName(
    value.version,
    `${path}.version`,
    "preset_ref_invalid",
  );
  if (typeof value.hash !== "string") {
    throwInvalid(
      "preset_ref_invalid",
      `${path}.hash must be a 0x-prefixed 32-byte hex digest`,
      { path },
    );
  }
  let hash: Hex;
  try {
    hash = normalizeBytes32(value.hash, `${path}.hash`);
  } catch {
    throwInvalid(
      "preset_ref_invalid",
      `${path}.hash must be a 0x-prefixed 32-byte hex digest`,
      { path },
    );
  }
  const ref =
    Object.hasOwn(value, "ref")
      ? assertReference(value.ref, `${path}.ref`, "preset_ref_invalid", "ref")
      : undefined;
  return {
    name,
    version,
    hash,
    ...(ref !== undefined ? { ref } : {}),
  };
}

function optionalHash(
  record: Record<string, unknown>,
  field: string,
  path: string,
): Hex | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const raw = record[field];
  if (typeof raw !== "string") {
    throwInvalid(
      "handle_hash_invalid",
      `${path} must be a 0x-prefixed 32-byte hex digest`,
      { path },
    );
  }
  try {
    return normalizeBytes32(raw, path);
  } catch {
    throwInvalid(
      "handle_hash_invalid",
      `${path} must be a 0x-prefixed 32-byte hex digest`,
      { path },
    );
  }
}

function optionalName(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireName(value, path, "requirement_field_invalid");
}

function optionalDueAt(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throwInvalid(
      "requirement_due_at_invalid",
      `${path} must be an ISO 8601 timestamp`,
      { path },
    );
  }
  return value.trim();
}

function requireName(value: unknown, path: string, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throwInvalid(code, `${path} must be a non-empty string`, { path });
  }
  return value.trim();
}

function assertReference(
  value: unknown,
  path: string,
  code: string,
  field: string,
): string {
  if (typeof value !== "string") {
    throwInvalid(code, `${path} must be a reference string`, { path, field });
  }
  const reference = value.trim();
  if (
    !REFERENCE_PATTERN.test(reference) ||
    looksLikeKeyMaterial(reference)
  ) {
    throwInvalid(
      code,
      `${path} must be a reference (name/URI), raw key material is not allowed in handles`,
      { path, field },
    );
  }
  return reference;
}

function looksLikeKeyMaterial(value: string): boolean {
  return (
    /^0x[0-9a-fA-F]{64,}$/.test(value) ||
    /^[0-9a-fA-F]{64,}$/.test(value) ||
    /^[A-Za-z0-9+/]{64,}={0,2}$/.test(value)
  );
}

function rejectSecretFieldsIn(
  value: unknown,
  label: string,
  path: string,
): void {
  const hit = findSecretField(value, path);
  if (hit) {
    throwInvalid(
      "contains_secret_field",
      `${hit.path} is a key/credential field; file handles only carry references (${label})`,
      { path: hit.path, field: hit.field },
    );
  }
}

function rejectSecretField(field: string, path: string): void {
  if (isSecretFieldName(field)) {
    throwInvalid(
      "contains_secret_field",
      `${path} is a key/credential field; file handles only carry references`,
      { path, field },
    );
  }
}

interface SecretFieldHit {
  readonly path: string;
  readonly field: string;
}

function findSecretField(
  value: unknown,
  path: string,
  depth = 0,
): SecretFieldHit | undefined {
  if (depth > 8 || value === null || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findSecretField(value[index], `${path}[${index}]`, depth + 1);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }
  for (const [field, child] of Object.entries(value)) {
    if (isSecretFieldName(field)) {
      return { path: `${path}.${field}`, field };
    }
    const hit = findSecretField(child, `${path}.${field}`, depth + 1);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function isSecretFieldName(field: string): boolean {
  return SECRET_FIELD_NAMES.has(field.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidBody(message: string): OrderRequirementsError {
  return new OrderRequirementsError(400, "invalid_body", message);
}

function throwInvalid(
  code: string,
  message: string,
  details?: unknown,
): never {
  throw new OrderRequirementsError(400, code, message, details);
}
