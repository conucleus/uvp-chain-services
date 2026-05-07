import { redactErrorMessage } from "../../security/redaction.js";
import {
  ProductStagePatchError,
  type PrepareProductDockedOrderLinkInput,
  type PrepareProductStageExecutorPatchInput,
  type PrepareProductStageResourcePatchInput,
  type PreparedDockedOrderLinkDTO,
  type PreparedStageExecutorPatchDTO,
  type PreparedStageResourcePatchDTO,
  type SubmitProductDockedOrderLinkInput,
  type SubmitProductStageExecutorPatchInput,
  type SubmitProductStageResourcePatchInput
} from "../../stage-patches/index.js";
import { ConfigError } from "../../shared/types.js";
import type { ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

export function createStagePatchRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      const prepareExecutorMatch = /^\/product\/tasks\/([^/]+)\/prepare-stage-executor-patch$/.exec(request.pathname);
      if (request.method === "POST" && prepareExecutorMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodeURIComponent(prepareExecutorMatch[1] ?? "");
          return {
            status: 201,
            body: await context.productStageExecutorPatchService.prepareStageExecutorPatch(
              taskId,
              parsePrepareExecutorBody(request.body)
            )
          };
        });
      }

      const submitExecutorMatch = /^\/product\/tasks\/([^/]+)\/submit-stage-executor-patch$/.exec(request.pathname);
      if (request.method === "POST" && submitExecutorMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodeURIComponent(submitExecutorMatch[1] ?? "");
          return {
            status: 200,
            body: await context.productStageExecutorPatchService.submitStageExecutorPatch(
              taskId,
              parseSubmitExecutorBody(request.body)
            )
          };
        });
      }

      const prepareResourceMatch = /^\/product\/tasks\/([^/]+)\/prepare-stage-resource-patch$/.exec(request.pathname);
      if (request.method === "POST" && prepareResourceMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodeURIComponent(prepareResourceMatch[1] ?? "");
          return {
            status: 201,
            body: await context.productStageResourcePatchService.prepareStageResourcePatch(
              taskId,
              parsePrepareResourceBody(request.body)
            )
          };
        });
      }

      const submitResourceMatch = /^\/product\/tasks\/([^/]+)\/submit-stage-resource-patch$/.exec(request.pathname);
      if (request.method === "POST" && submitResourceMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodeURIComponent(submitResourceMatch[1] ?? "");
          return {
            status: 200,
            body: await context.productStageResourcePatchService.submitStageResourcePatch(
              taskId,
              parseSubmitResourceBody(request.body)
            )
          };
        });
      }

      const prepareDockedMatch = /^\/product\/tasks\/([^/]+)\/prepare-docked-order-link$/.exec(request.pathname);
      if (request.method === "POST" && prepareDockedMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodeURIComponent(prepareDockedMatch[1] ?? "");
          return {
            status: 201,
            body: await context.productDockedOrderLinkService.prepareDockedOrderLink(
              taskId,
              parsePrepareDockedBody(request.body)
            )
          };
        });
      }

      const submitDockedMatch = /^\/product\/tasks\/([^/]+)\/submit-docked-order-link$/.exec(request.pathname);
      if (request.method === "POST" && submitDockedMatch) {
        return handleStagePatchRequest(async () => {
          const taskId = decodeURIComponent(submitDockedMatch[1] ?? "");
          return {
            status: 200,
            body: await context.productDockedOrderLinkService.submitDockedOrderLink(
              taskId,
              parseSubmitDockedBody(request.body)
            )
          };
        });
      }

      return undefined;
    }
  };
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
  rejectLegacyResourceBundleFields(record);
  const mode = optionalString(record, "mode");
  const previousExecutor = canonicalPreviousExecutor(record);
  const approval = approvalFields(record);
  return {
    selectorWallet: requiredString(record, "selectorWallet"),
    targetStageId: requiredString(record, "targetStageId"),
    executorWallet: requiredString(record, "executorWallet"),
    ...(mode ? { mode } : {}),
    ...(previousExecutor ? { previousExecutorWallet: previousExecutor } : {}),
    ...(approval.approvalSourceId ? { approvalSourceId: approval.approvalSourceId } : {}),
    ...(approval.approvalSignalId ? { approvalSignalId: approval.approvalSignalId } : {}),
    ...("approval" in record ? { approval: record.approval } : {}),
    ...(optionalString(record, "roleHash") ? { roleHash: optionalString(record, "roleHash")! } : {}),
    ...(optionalString(record, "executorMetadataHash") ? { executorMetadataHash: optionalString(record, "executorMetadataHash")! } : {}),
    ...(optionalString(record, "supplierReferenceHash") ? { supplierReferenceHash: optionalString(record, "supplierReferenceHash")! } : {}),
    metadataURI: requiredString(record, "metadataURI")
  };
}

function parsePrepareResourceBody(body: unknown): PrepareProductStageResourcePatchInput {
  const record = requireBodyRecord(body);
  rejectLegacyResourceBundleFields(record);
  rejectResourcePatchPhase2Fields(record);
  return {
    selectorWallet: requiredString(record, "selectorWallet"),
    targetStageId: requiredString(record, "targetStageId"),
    resourceKey: requiredString(record, "resourceKey"),
    manifestHash: requiredString(record, "manifestHash"),
    policyHash: requiredString(record, "policyHash"),
    manifestURI: requiredString(record, "manifestURI")
  };
}

function parsePrepareDockedBody(body: unknown): PrepareProductDockedOrderLinkInput {
  const record = requireBodyRecord(body);
  const rawBindings = record.signalBindings;
  if (!Array.isArray(rawBindings)) {
    throw new ProductStagePatchError(400, "invalid_body", "signalBindings must be an array");
  }
  return {
    selectorWallet: requiredString(record, "selectorWallet"),
    localSourceId: requiredString(record, "localSourceId"),
    linkedOrderId: requiredString(record, "linkedOrderId"),
    linkedPlanId: requiredString(record, "linkedPlanId"),
    signalBindings: rawBindings.map((binding, index) => {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        throw new ProductStagePatchError(400, "invalid_body", `signalBindings.${index} must be an object`);
      }
      const bindingRecord = binding as Record<string, unknown>;
      return {
        localSourceId: requiredString(bindingRecord, "localSourceId"),
        localSignalId: requiredString(bindingRecord, "localSignalId"),
        linkedSourceId: requiredString(bindingRecord, "linkedSourceId"),
        linkedSignalId: requiredString(bindingRecord, "linkedSignalId")
      };
    }),
    metadataURI: requiredString(record, "metadataURI")
  };
}

function parseSubmitExecutorBody(body: unknown): SubmitProductStageExecutorPatchInput {
  const record = requireBodyRecord(body);
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
  rejectResourcePatchPhase2Fields(record);
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

function parseSubmitDockedBody(body: unknown): SubmitProductDockedOrderLinkInput {
  const record = requireBodyRecord(body);
  const prepareId = optionalString(record, "prepareId");
  const link = optionalPatch<PreparedDockedOrderLinkDTO>(record, "link");
  return {
    ...(prepareId ? { prepareId } : {}),
    selectorWallet: requiredString(record, "selectorWallet"),
    ...("typedData" in record ? { typedData: record.typedData } : {}),
    signature: requiredString(record, "signature"),
    ...(link ? { link } : {})
  };
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new ProductStagePatchError(400, "invalid_body", "request body must be a JSON object");
}

function rejectLegacyResourceBundleFields(record: Record<string, unknown>): void {
  if ("fileResourcesBundle" in record || "fileResourcesHash" in record) {
    throw new ProductStagePatchError(
      400,
      "legacy_resource_bundle_rejected",
      "stage patches no longer accept legacy file resource bundles; publish a stage resource patch manifest instead"
    );
  }
}

function rejectResourcePatchPhase2Fields(record: Record<string, unknown>): void {
  if ("writerWallet" in record) {
    throw new ProductStagePatchError(
      400,
      "writer_wallet_not_allowed",
      "stage resource patches use selectorWallet as the chain controller field"
    );
  }
  if ("visibility" in record) {
    throw new ProductStagePatchError(
      400,
      "visibility_not_allowed",
      "resource visibility belongs in the off-chain resource manifest, not the chain prepare payload"
    );
  }
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductStagePatchError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredStringAlias(record: Record<string, unknown>, field: string, legacyField: string): string {
  const value = optionalString(record, field);
  const legacyValue = optionalString(record, legacyField);
  if (value && legacyValue && value.toLowerCase() !== legacyValue.toLowerCase()) {
    throw new ProductStagePatchError(400, "invalid_body", `${field} must match ${legacyField} when both are provided`);
  }
  if (value ?? legacyValue) {
    return value ?? legacyValue!;
  }
  throw new ProductStagePatchError(400, "invalid_body", `${field} must be a non-empty string`);
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

function canonicalPreviousExecutor(record: Record<string, unknown>): string | undefined {
  const previousExecutorWallet = optionalString(record, "previousExecutorWallet");
  const legacyPreviousExecutor = optionalString(record, "previousExecutor");
  if (previousExecutorWallet && legacyPreviousExecutor && previousExecutorWallet.toLowerCase() !== legacyPreviousExecutor.toLowerCase()) {
    throw new ProductStagePatchError(
      400,
      "previous_executor_mismatch",
      "previousExecutorWallet must match previousExecutor when both are provided"
    );
  }
  return previousExecutorWallet ?? legacyPreviousExecutor;
}

function approvalFields(record: Record<string, unknown>): {
  readonly approvalSourceId?: string;
  readonly approvalSignalId?: string;
} {
  const topLevelSourceId = optionalString(record, "approvalSourceId");
  const topLevelSignalId = optionalString(record, "approvalSignalId");
  if (!("approval" in record) || record.approval === undefined || record.approval === null) {
    return {
      ...(topLevelSourceId ? { approvalSourceId: topLevelSourceId } : {}),
      ...(topLevelSignalId ? { approvalSignalId: topLevelSignalId } : {})
    };
  }
  if (typeof record.approval !== "object" || Array.isArray(record.approval)) {
    throw new ProductStagePatchError(400, "invalid_body", "approval must be an object when provided");
  }
  const approvalRecord = record.approval as Record<string, unknown>;
  const objectSourceId = optionalString(approvalRecord, "sourceId") ?? optionalString(approvalRecord, "approvalSourceId");
  const objectSignalId = optionalString(approvalRecord, "signalId") ?? optionalString(approvalRecord, "approvalSignalId");
  if (topLevelSourceId && objectSourceId && topLevelSourceId.toLowerCase() !== objectSourceId.toLowerCase()) {
    throw new ProductStagePatchError(400, "approval_mismatch", "approvalSourceId must match approval.sourceId");
  }
  if (topLevelSignalId && objectSignalId && topLevelSignalId.toLowerCase() !== objectSignalId.toLowerCase()) {
    throw new ProductStagePatchError(400, "approval_mismatch", "approvalSignalId must match approval.signalId");
  }
  const approvalSourceId = objectSourceId ?? topLevelSourceId;
  const approvalSignalId = objectSignalId ?? topLevelSignalId;
  return {
    ...(approvalSourceId ? { approvalSourceId } : {}),
    ...(approvalSignalId ? { approvalSignalId } : {})
  };
}
