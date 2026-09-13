import { validateTaskEvidenceSpec } from "@uvp-eth/product-dto";
import type {
  StoreZhixuDecorationData,
  StoreZhixuTaskDeclaration
} from "./types.js";
import { StoreDecorationServiceError } from "./types.js";

/**
 * 装修数据结构校验（章程 §4：只做结构校验，永不编码业务预期）。
 *
 * - theme 字段是白名单纯展示字段（字符串/字符串数组 + 长度上限），
 *   拒绝任何可执行内容。
 * - taskDeclarations.evidenceSpec 复用冻结的 validateTaskEvidenceSpec
 *   结构校验（与 Product Workbench 的渲染口径同源）。
 */

const MAX_THEME_STRING_LENGTH = 2000;
const MAX_TAGS = 24;
const MAX_TAG_LENGTH = 64;
const MAX_HIGHLIGHTS = 16;
const MAX_TASK_DECLARATIONS = 64;
const ALLOWED_THEME_FIELDS = new Set(["displayName", "description", "tags", "highlights", "heroImageURI"]);
const ALLOWED_TASK_DECLARATION_FIELDS = new Set(["stageId", "taskId", "evidenceSpec"]);
const ALLOWED_EVIDENCE_SPEC_FIELDS = new Set(["key", "label", "inputKind", "accept", "required", "description"]);

export function validateStoreDecorationData(input: unknown): StoreZhixuDecorationData {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StoreDecorationServiceError(400, "invalid_decoration", "decoration must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== "store-zhixu-decoration.v1") {
    throw new StoreDecorationServiceError(400, "invalid_decoration_schema_version", "schemaVersion must be store-zhixu-decoration.v1");
  }
  const unknownTopFields = Object.keys(record).filter((key) => key !== "schemaVersion" && key !== "theme" && key !== "taskDeclarations");
  if (unknownTopFields.length > 0) {
    throw new StoreDecorationServiceError(400, "invalid_decoration_field", `unknown decoration field: ${unknownTopFields[0]}`);
  }
  const theme = Object.hasOwn(record, "theme") && record.theme !== undefined
    ? validateTheme(record.theme)
    : undefined;
  const taskDeclarations = Object.hasOwn(record, "taskDeclarations") && record.taskDeclarations !== undefined
    ? validateTaskDeclarations(record.taskDeclarations)
    : undefined;
  return {
    schemaVersion: "store-zhixu-decoration.v1",
    ...(theme ? { theme } : {}),
    ...(taskDeclarations ? { taskDeclarations } : {})
  };
}

function validateTheme(input: unknown): NonNullable<StoreZhixuDecorationData["theme"]> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StoreDecorationServiceError(400, "invalid_decoration_theme", "theme must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_THEME_FIELDS.has(key)) {
      throw new StoreDecorationServiceError(400, "invalid_decoration_field", `unknown theme field: ${key}`);
    }
  }
  const displayName = record.displayName !== undefined
    ? boundedString(record.displayName, "theme.displayName", MAX_THEME_STRING_LENGTH)
    : undefined;
  const description = record.description !== undefined
    ? boundedString(record.description, "theme.description", MAX_THEME_STRING_LENGTH)
    : undefined;
  const heroImageURI = record.heroImageURI !== undefined
    ? boundedString(record.heroImageURI, "theme.heroImageURI", 512)
    : undefined;
  if (heroImageURI && !/^(https|ipfs|data:image\/[a-z0-9.+-]+):/i.test(heroImageURI)) {
    throw new StoreDecorationServiceError(400, "invalid_decoration_field", "theme.heroImageURI must be an https/ipfs/data-image URI");
  }
  const tags = record.tags !== undefined
    ? boundedStringArray(record.tags, "theme.tags", MAX_TAGS, MAX_TAG_LENGTH)
    : undefined;
  const highlights = record.highlights !== undefined
    ? boundedStringArray(record.highlights, "theme.highlights", MAX_HIGHLIGHTS, MAX_THEME_STRING_LENGTH)
    : undefined;
  return {
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(heroImageURI ? { heroImageURI } : {}),
    ...(tags ? { tags } : {}),
    ...(highlights ? { highlights } : {})
  };
}

function validateTaskDeclarations(input: unknown): readonly StoreZhixuTaskDeclaration[] {
  if (!Array.isArray(input)) {
    throw new StoreDecorationServiceError(400, "invalid_decoration", "taskDeclarations must be an array");
  }
  if (input.length > MAX_TASK_DECLARATIONS) {
    throw new StoreDecorationServiceError(400, "invalid_decoration", `taskDeclarations supports at most ${MAX_TASK_DECLARATIONS} entries`);
  }
  return input.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new StoreDecorationServiceError(400, "invalid_decoration", `taskDeclarations[${index}] must be a JSON object`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ALLOWED_TASK_DECLARATION_FIELDS.has(key)) {
        throw new StoreDecorationServiceError(400, "invalid_decoration_field", `unknown taskDeclarations[${index}] field: ${key}`);
      }
    }
    const stageId = record.stageId !== undefined
      ? boundedString(record.stageId, `taskDeclarations[${index}].stageId`, 256)
      : undefined;
    const taskId = record.taskId !== undefined
      ? boundedString(record.taskId, `taskDeclarations[${index}].taskId`, 256)
      : undefined;
    const evidenceSpec = record.evidenceSpec !== undefined
      ? validateEvidenceSpecArray(record.evidenceSpec, index)
      : undefined;
    return {
      ...(stageId ? { stageId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(evidenceSpec ? { evidenceSpec } : {})
    };
  });
}

function validateEvidenceSpecArray(input: unknown, declarationIndex: number): readonly unknown[] {
  if (input === null) {
    throw new StoreDecorationServiceError(400, "invalid_decoration", `taskDeclarations[${declarationIndex}].evidenceSpec must be an array when present`);
  }
  if (!Array.isArray(input)) {
    throw new StoreDecorationServiceError(400, "invalid_decoration", `taskDeclarations[${declarationIndex}].evidenceSpec must be an array when present`);
  }
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new StoreDecorationServiceError(400, "invalid_decoration", `taskDeclarations[${declarationIndex}].evidenceSpec entries must be JSON objects`);
    }
    for (const key of Object.keys(entry as Record<string, unknown>)) {
      if (!ALLOWED_EVIDENCE_SPEC_FIELDS.has(key)) {
        throw new StoreDecorationServiceError(400, "invalid_decoration_field", `unknown evidenceSpec field: ${key}`);
      }
    }
  }
  // 结构校验复用冻结 DTO 的 validateTaskEvidenceSpec（输入已是数组形态）。
  const issues = validateTaskEvidenceSpec(input as never);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new StoreDecorationServiceError(
      400,
      `invalid_evidence_spec:${first.code}`,
      `taskDeclarations[${declarationIndex}].evidenceSpec: ${first.message}`
    );
  }
  return input;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new StoreDecorationServiceError(400, "invalid_decoration_field", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new StoreDecorationServiceError(400, "invalid_decoration_field", `${field} must not be empty`);
  }
  if (trimmed.length > maxLength) {
    throw new StoreDecorationServiceError(400, "invalid_decoration_field", `${field} exceeds ${maxLength} characters`);
  }
  return trimmed;
}

function boundedStringArray(value: unknown, field: string, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value)) {
    throw new StoreDecorationServiceError(400, "invalid_decoration_field", `${field} must be an array of strings`);
  }
  if (value.length > maxItems) {
    throw new StoreDecorationServiceError(400, "invalid_decoration_field", `${field} supports at most ${maxItems} entries`);
  }
  return value.map((item) => boundedString(item, field, maxLength));
}
