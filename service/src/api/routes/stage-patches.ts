import { redactErrorMessage } from "../../security/redaction.js";
import {
  ProductStagePatchError,
  type PrepareProductStageExecutorPatchInput,
  type PrepareProductStageResourcePatchInput,
  type PreparedStageExecutorPatchDTO,
  type PreparedStageResourcePatchDTO,
  type SubmitProductStageExecutorPatchInput,
  type SubmitProductStageResourcePatchInput
} from "../../stage-patches/index.js";
import { ConfigError, normalizeAddress, type Address } from "../../shared/types.js";
import type { ChainServicesRuntimeEnv } from "../../config/index.js";
import { decodePathParameter, type ApiRequest, type ApiResponse, type ApiRouteContext } from "../route-context.js";
import { resolveParticipantWalletIdentity } from "../participant-identity.js";
import type { RouteModule } from "../route-module.js";

export function createStagePatchRouteModule(options: {
  /** 仅显式 local 允许自报 selector 头/体；缺省/非 local 无会话身份即 401。 */
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
} = {}): RouteModule {
  return {
    async handle(request, context) {
      const prepareExecutorMatch = /^\/product\/tasks\/([^/]+)\/prepare-stage-executor-patch$/.exec(request.pathname);
      if (request.method === "POST" && prepareExecutorMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodePathParameter(prepareExecutorMatch[1] ?? "");
          const input = parsePrepareExecutorBody(request.body);
          const identity = await resolveSelectorWalletIdentity(request, context, options.runtimeEnvironment, input.selectorWallet);
          if (!identity.ok) {
            return identity.response;
          }
          return {
            status: 201,
            body: await context.productStageExecutorPatchService.prepareStageExecutorPatch(
              taskId,
              { ...input, selectorWallet: identity.walletAddress }
            )
          };
        });
      }

      const submitExecutorMatch = /^\/product\/tasks\/([^/]+)\/submit-stage-executor-patch$/.exec(request.pathname);
      if (request.method === "POST" && submitExecutorMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodePathParameter(submitExecutorMatch[1] ?? "");
          const input = parseSubmitExecutorBody(request.body);
          const identity = await resolveSelectorWalletIdentity(request, context, options.runtimeEnvironment, input.selectorWallet);
          if (!identity.ok) {
            return identity.response;
          }
          return {
            status: 200,
            body: await context.productStageExecutorPatchService.submitStageExecutorPatch(
              taskId,
              { ...input, selectorWallet: identity.walletAddress }
            )
          };
        });
      }

      const prepareResourceMatch = /^\/product\/tasks\/([^/]+)\/prepare-stage-resource-patch$/.exec(request.pathname);
      if (request.method === "POST" && prepareResourceMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodePathParameter(prepareResourceMatch[1] ?? "");
          const input = parsePrepareResourceBody(request.body);
          const identity = await resolveSelectorWalletIdentity(request, context, options.runtimeEnvironment, input.selectorWallet);
          if (!identity.ok) {
            return identity.response;
          }
          return {
            status: 201,
            body: await context.productStageResourcePatchService.prepareStageResourcePatch(
              taskId,
              { ...input, selectorWallet: identity.walletAddress }
            )
          };
        });
      }

      const submitResourceMatch = /^\/product\/tasks\/([^/]+)\/submit-stage-resource-patch$/.exec(request.pathname);
      if (request.method === "POST" && submitResourceMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodePathParameter(submitResourceMatch[1] ?? "");
          const input = parseSubmitResourceBody(request.body);
          const identity = await resolveSelectorWalletIdentity(request, context, options.runtimeEnvironment, input.selectorWallet);
          if (!identity.ok) {
            return identity.response;
          }
          return {
            status: 200,
            body: await context.productStageResourcePatchService.submitStageResourcePatch(
              taskId,
              { ...input, selectorWallet: identity.walletAddress }
            )
          };
        });
      }

      return undefined;
    }
  };
}

/**
 * selector 身份收口（对照 submissions 路由的 resolveParticipantWalletIdentity
 * 做法）：会话锚定地址为真源，body 自报 selectorWallet 只做一致性核验——
 * 不一致即 403，否则可用任意（任务,钱包）组合探测授权结果（201/403
 * oracle）。仅显式 local 允许 body 自报 selector 作为身份；非 local 无
 * 锚定即 401 fail-closed。
 */
async function resolveSelectorWalletIdentity(
  request: ApiRequest,
  context: ApiRouteContext,
  runtimeEnvironment: ChainServicesRuntimeEnv | undefined,
  selectorWallet: string
): Promise<{ readonly ok: true; readonly walletAddress: Address } | { readonly ok: false; readonly response: ApiResponse }> {
  let claimed: Address;
  try {
    claimed = normalizeAddress(selectorWallet, "selectorWallet");
  } catch {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "invalid_wallet", message: "selectorWallet must be a valid EVM address" }
      }
    };
  }
  const resolved = await resolveParticipantWalletIdentity(request, context, runtimeEnvironment, { includeBodyWallet: false });
  if (resolved.ok) {
    if (claimed.toLowerCase() !== resolved.identity.walletAddress.toLowerCase()) {
      return {
        ok: false,
        response: {
          status: 403,
          body: {
            error: "wrong_wallet",
            message: "claimed selectorWallet does not match the session-anchored address",
            anchoredAddress: resolved.identity.walletAddress,
            walletAddress: claimed
          }
        }
      };
    }
    return { ok: true, walletAddress: resolved.identity.walletAddress };
  }
  if (runtimeEnvironment === "local") {
    return { ok: true, walletAddress: claimed };
  }
  return { ok: false, response: resolved.response };
}

async function handleStagePatchRequest(action: () => Promise<ApiResponse>): Promise<ApiResponse> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ProductStagePatchError) {
      return {
        status: error.status,
        body: {
          error: error.code,
          message: redactErrorMessage(error),
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      };
    }
    if (error instanceof ConfigError) {
      return {
        status: 400,
        body: {
          error: "invalid_body",
          message: redactErrorMessage(error)
        }
      };
    }
    throw error;
  }
}

function parsePrepareExecutorBody(body: unknown): PrepareProductStageExecutorPatchInput {
  const record = requireBodyRecord(body);
  assertKnownFields(record, PREPARE_EXECUTOR_FIELDS, "prepare executor patch body");
  // mode 显式提供但类型非法/空白 = 词表外取值：类型化拒绝，不走
  // "非字符串静默丢弃 → 缺省 assign"的宽松归一（调用方无从感知归一）。
  if (
    record.mode !== undefined &&
    (typeof record.mode !== "string" || record.mode.trim().length === 0)
  ) {
    throw new ProductStagePatchError(400, "invalid_executor_patch_mode", "mode must be assign or handoff");
  }
  const mode = optionalString(record, "mode");
  const previousExecutor = optionalString(record, "previousExecutorWallet");
  return {
    selectorWallet: requiredString(record, "selectorWallet"),
    targetStageId: requiredString(record, "targetStageId"),
    executorWallet: requiredString(record, "executorWallet"),
    ...(mode ? { mode } : {}),
    ...(previousExecutor ? { previousExecutorWallet: previousExecutor } : {}),
    ...(optionalString(record, "roleHash") ? { roleHash: optionalString(record, "roleHash")! } : {}),
    ...(optionalString(record, "executorMetadataHash") ? { executorMetadataHash: optionalString(record, "executorMetadataHash")! } : {}),
    ...(optionalString(record, "supplierReferenceHash") ? { supplierReferenceHash: optionalString(record, "supplierReferenceHash")! } : {}),
    metadataURI: requiredString(record, "metadataURI")
  };
}

function parsePrepareResourceBody(body: unknown): PrepareProductStageResourcePatchInput {
  const record = requireBodyRecord(body);
  assertKnownFields(record, PREPARE_RESOURCE_FIELDS, "prepare resource patch body");
  return {
    selectorWallet: requiredString(record, "selectorWallet"),
    targetStageId: requiredString(record, "targetStageId"),
    resourceKey: requiredString(record, "resourceKey"),
    manifestHash: requiredString(record, "manifestHash"),
    policyHash: requiredString(record, "policyHash"),
    manifestURI: requiredString(record, "manifestURI")
  };
}


function parseSubmitExecutorBody(body: unknown): SubmitProductStageExecutorPatchInput {
  const record = requireBodyRecord(body);
  assertKnownFields(record, SUBMIT_EXECUTOR_FIELDS, "submit executor patch body");
  const previousExecutorSignature = optionalString(record, "previousExecutorSignature");
  const prepareId = optionalString(record, "prepareId");
  const patch = optionalPatch<PreparedStageExecutorPatchDTO>(record, "patch");
  return {
    ...(prepareId ? { prepareId } : {}),
    selectorWallet: requiredString(record, "selectorWallet"),
    ...("typedData" in record ? { typedData: record.typedData } : {}),
    signature: requiredString(record, "signature"),
    ...(patch ? { patch } : {}),
    ...(previousExecutorSignature ? { previousExecutorSignature } : {})
  };
}

function parseSubmitResourceBody(body: unknown): SubmitProductStageResourcePatchInput {
  const record = requireBodyRecord(body);
  assertKnownFields(record, SUBMIT_RESOURCE_FIELDS, "submit resource patch body");
  const prepareId = optionalString(record, "prepareId");
  const patch = optionalPatch<PreparedStageResourcePatchDTO>(record, "patch");
  return {
    ...(prepareId ? { prepareId } : {}),
    selectorWallet: requiredString(record, "selectorWallet"),
    ...("typedData" in record ? { typedData: record.typedData } : {}),
    ...(patch ? { patch } : {}),
    signature: requiredString(record, "signature")
  };
}


// 请求体封闭字段集：未知字段一律 400 而非静默忽略——静默忽略会把
// "调用方以为表达了别的语义"变成一次普通补丁（误导性接受面），digest
// 不含杂音不等于语义没有杂音。
const PREPARE_EXECUTOR_FIELDS: readonly string[] = [
  "selectorWallet",
  "targetStageId",
  "executorWallet",
  "mode",
  "previousExecutorWallet",
  "roleHash",
  "executorMetadataHash",
  "supplierReferenceHash",
  "metadataURI"
];
const PREPARE_RESOURCE_FIELDS: readonly string[] = [
  "selectorWallet",
  "targetStageId",
  "resourceKey",
  "manifestHash",
  "policyHash",
  "manifestURI"
];
const SUBMIT_EXECUTOR_FIELDS: readonly string[] = [
  "prepareId",
  "selectorWallet",
  "typedData",
  "signature",
  "patch",
  "previousExecutorSignature"
];
const SUBMIT_RESOURCE_FIELDS: readonly string[] = [
  "prepareId",
  "selectorWallet",
  "typedData",
  "patch",
  "signature"
];

function assertKnownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ProductStagePatchError(
      400,
      "invalid_body",
      `${label} has unknown fields: ${unknown.sort().join(", ")}`
    );
  }
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new ProductStagePatchError(400, "invalid_body", "request body must be a JSON object");
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductStagePatchError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalPatch<TPatch>(record: Record<string, unknown>, field: string): TPatch | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as TPatch;
  }
  throw new ProductStagePatchError(400, "invalid_body", `${field} must be a prepared patch object`);
}
