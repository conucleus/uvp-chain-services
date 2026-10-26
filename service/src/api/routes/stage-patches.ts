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
import { decodePathParameter, type ApiRequest, type ApiResponse } from "../route-context.js";
import { resolveChainWalletClaim } from "../wallet-claim.js";
import type { RouteModule } from "../route-module.js";

export function createStagePatchRouteModule(options: {
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
} = {}): RouteModule {
  return {
    async handle(request, context) {
      const prepareExecutorMatch = /^\/product\/tasks\/([^/]+)\/prepare-stage-executor-patch$/.exec(request.pathname);
      if (request.method === "POST" && prepareExecutorMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodePathParameter(prepareExecutorMatch[1] ?? "");
          const input = parsePrepareExecutorBody(request.body);
          const identity = resolveSelectorWalletIdentity(request, options.runtimeEnvironment, input.selectorWallet);
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
          const identity = resolveSelectorWalletIdentity(request, options.runtimeEnvironment, input.selectorWallet);
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
          const identity = resolveSelectorWalletIdentity(request, options.runtimeEnvironment, input.selectorWallet);
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
          const identity = resolveSelectorWalletIdentity(request, options.runtimeEnvironment, input.selectorWallet);
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

function resolveSelectorWalletIdentity(
  request: ApiRequest,
  runtimeEnvironment: ChainServicesRuntimeEnv | undefined,
  selectorWallet: string
): { readonly ok: true; readonly walletAddress: Address } | { readonly ok: false; readonly response: ApiResponse } {
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
  const resolved = resolveChainWalletClaim(request, runtimeEnvironment, { includeBodyWallet: false });
  if (!resolved.ok) {
    if (runtimeEnvironment === "local") {
      return { ok: true, walletAddress: claimed };
    }
    return resolved;
  }
  if (claimed.toLowerCase() !== resolved.identity.walletAddress.toLowerCase()) {
    return {
      ok: false,
      response: {
        status: 403,
        body: {
          error: "wrong_wallet",
          message: "claimed selectorWallet does not match the anchored wallet",
          anchoredAddress: resolved.identity.walletAddress,
          walletAddress: claimed
        }
      }
    };
  }
  return { ok: true, walletAddress: resolved.identity.walletAddress };
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
