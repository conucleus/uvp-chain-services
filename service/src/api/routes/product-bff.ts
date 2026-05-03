import {
  ProductBffError,
  type ProductBffService
} from "../../product/bff/service.js";
import type {
  AcceptProductInviteInput,
  CreateProductInviteInput,
  CreateProductOrderDraftInput,
  ProductInviteDTO,
  ProductInvitePreviewResponse,
  ProductInviteResponse,
  RejectProductInviteInput,
  UpdateProductOrderDraftInput
} from "../../product/bff/types.js";
import type { AuditSink } from "../../security/audit.js";
import { redactErrorMessage } from "../../security/redaction.js";
import { ConfigError } from "../../shared/types.js";
import { readApiHeader, type ApiRequest, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

export function createProductBffRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (request.method === "POST" && request.pathname === "/product/order-drafts") {
        const input = parseCreateDraftBody(request.body);
        return handleProductBffRequest(async () => {
          const result = await context.productBffService.createDraft(input);
          return {
            status: 201,
            body: result
          };
        }, {
          audit: context.audit,
          blockedAudit: (error) => error instanceof ProductBffError && error.code === "plan_revoked"
            ? {
                type: "product.order.create.revoked_plan_attempt",
                action: "create_order_draft",
                outcome: "blocked",
                subject: {
                  zhixuId: input.zhixuId,
                  createdBy: input.createdBy ?? "unknown"
                },
                errorCode: error.code,
                retryable: false
              }
            : undefined
        });
      }

      const productOrderDraftSubmitMatch = /^\/product\/order-drafts\/([^/]+)\/submit$/.exec(request.pathname);
      if (request.method === "POST" && productOrderDraftSubmitMatch) {
        return handleProductBffRequest(async () => {
          parseSubmitDraftBody(request.body);
          const draftId = decodeURIComponent(productOrderDraftSubmitMatch[1] ?? "");
          const body = await context.productBffService.submitDraft(draftId);
          context.onTxMined?.();
          return {
            status: 200,
            body
          };
        }, { audit: context.audit });
      }

      const productOrderRegistrationRetryMatch = /^\/product\/order-registrations\/([^/]+)\/retry$/.exec(request.pathname);
      if (request.method === "POST" && productOrderRegistrationRetryMatch) {
        return handleProductBffRequest(async () => {
          parseSubmitDraftBody(request.body);
          const registrationId = decodeURIComponent(productOrderRegistrationRetryMatch[1] ?? "");
          const body = await context.productBffService.retryRegistration(registrationId);
          context.onTxMined?.();
          return {
            status: 200,
            body
          };
        }, { audit: context.audit });
      }

      const productOrderRegistrationStartMatch = /^\/product\/order-registrations\/([^/]+)\/start$/.exec(request.pathname);
      if (request.method === "POST" && productOrderRegistrationStartMatch) {
        return handleProductBffRequest(async () => {
          parseStartOrderBody(request.body);
          const registrationId = decodeURIComponent(productOrderRegistrationStartMatch[1] ?? "");
          const body = await context.productBffService.startRegistration(registrationId);
          context.onTxMined?.();
          return {
            status: 200,
            body
          };
        }, { audit: context.audit });
      }

      const productOrderRegistrationMatch = /^\/product\/order-registrations\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productOrderRegistrationMatch) {
        return handleProductBffRequest(async () => {
          const registrationId = decodeURIComponent(productOrderRegistrationMatch[1] ?? "");
          return {
            status: 200,
            body: { registration: await context.productBffService.getRegistration(registrationId) }
          };
        }, { audit: context.audit });
      }

      const productOrderDraftMatch = /^\/product\/order-drafts\/([^/]+)$/.exec(request.pathname);
      if (productOrderDraftMatch) {
        const draftId = decodeURIComponent(productOrderDraftMatch[1] ?? "");
        if (request.method === "GET") {
          return handleProductBffRequest(async () => ({
            status: 200,
            body: await context.productBffService.getDraft(draftId)
          }), { audit: context.audit });
        }
        if (request.method === "PATCH") {
          return handleProductBffRequest(async () => ({
            status: 200,
            body: { draft: await context.productBffService.updateDraft(draftId, parseUpdateDraftBody(request.body)) }
          }), { audit: context.audit });
        }
      }

      const productOrderInviteMatch = /^\/product\/orders\/([^/]+)\/invites$/.exec(request.pathname);
      if (request.method === "POST" && productOrderInviteMatch) {
        return handleProductBffRequest(async () => {
          const draftId = decodeURIComponent(productOrderInviteMatch[1] ?? "");
          const result = await context.productBffService.createInvite(draftId, parseCreateInviteBody(request.body));
          return {
            status: 201,
            body: publicInviteResponse(result)
          };
        }, { audit: context.audit });
      }

      const productInvitePreviewMatch = /^\/product\/invites\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productInvitePreviewMatch) {
        return handleProductBffRequest(async () => {
          const inviteId = decodeURIComponent(productInvitePreviewMatch[1] ?? "");
          const walletAddress = walletAddressFromRequest(request);
          const result = await context.productBffService.getInvite(inviteId, walletAddress ? { walletAddress } : {});
          return {
            status: 200,
            body: publicInvitePreviewResponse(result)
          };
        }, { audit: context.audit });
      }

      const productInviteAcceptMatch = /^\/product\/invites\/([^/]+)\/accept$/.exec(request.pathname);
      if (request.method === "POST" && productInviteAcceptMatch) {
        return handleProductBffRequest(async () => {
          const inviteId = decodeURIComponent(productInviteAcceptMatch[1] ?? "");
          return {
            status: 200,
            body: publicInviteResponse(await context.productBffService.acceptInvite(inviteId, parseAcceptInviteBody(request)))
          };
        }, { audit: context.audit });
      }

      const productInviteRejectMatch = /^\/product\/invites\/([^/]+)\/reject$/.exec(request.pathname);
      if (request.method === "POST" && productInviteRejectMatch) {
        return handleProductBffRequest(async () => {
          const inviteId = decodeURIComponent(productInviteRejectMatch[1] ?? "");
          return {
            status: 200,
            body: publicInviteResponse(await context.productBffService.rejectInvite(inviteId, parseRejectInviteBody(request.body)))
          };
        }, { audit: context.audit });
      }

      const productOrderParticipantsMatch = /^\/product\/orders\/([^/]+)\/participants$/.exec(request.pathname);
      if (request.method === "GET" && productOrderParticipantsMatch) {
        return handleProductBffRequest(async () => {
          const draftId = decodeURIComponent(productOrderParticipantsMatch[1] ?? "");
          return {
            status: 200,
            body: { participants: await context.productBffService.listParticipants(draftId) }
          };
        }, { audit: context.audit });
      }

      return undefined;
    }
  };
}

async function handleProductBffRequest(
  action: () => Promise<ApiResponse>,
  options: {
    readonly audit: AuditSink;
    readonly blockedAudit?: (error: unknown) => Parameters<AuditSink["record"]>[0] | undefined;
  }
): Promise<ApiResponse> {
  try {
    return await action();
  } catch (error) {
    const auditEvent = options.blockedAudit?.(error);
    if (auditEvent) {
      await options.audit.record(auditEvent);
    }
    if (error instanceof ProductBffError) {
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

type PublicProductInviteDTO = Omit<ProductInviteDTO, "tokenHash">;

function publicInvite(invite: ProductInviteDTO): PublicProductInviteDTO {
  const { tokenHash: _tokenHash, ...publicInvite } = invite;
  return publicInvite;
}

function publicInviteResponse(response: ProductInviteResponse) {
  return {
    ...response,
    invite: publicInvite(response.invite)
  };
}

function publicInvitePreviewResponse(response: ProductInvitePreviewResponse) {
  return {
    ...response,
    invite: publicInvite(response.invite)
  };
}

function walletAddressFromRequest(request: ApiRequest): string | undefined {
  return request.query?.wallet ??
    request.query?.walletAddress ??
    readApiHeader(request.headers, "x-uvp-wallet-address") ??
    readApiHeader(request.headers, "x-uvp-session-wallet-address") ??
    readApiHeader(request.headers, "x-wallet-address");
}

function parseCreateDraftBody(body: unknown): CreateProductOrderDraftInput {
  const record = requireBodyRecord(body);
  const goods = optionalStringArray(record, "goods");
  const exportRegion = optionalString(record, "exportRegion");
  const destinationRegion = optionalString(record, "destinationRegion");
  const expectedCompletionDate = optionalString(record, "expectedCompletionDate");
  const notes = optionalString(record, "notes");
  const createdBy = optionalString(record, "createdBy");
  const allowDemoPlanFallback = optionalBoolean(record, "allowDemoPlanFallback");

  return {
    zhixuId: requiredString(record, "zhixuId"),
    title: requiredString(record, "title"),
    businessType: requiredString(record, "businessType"),
    totalAmount: requiredString(record, "totalAmount"),
    currency: requiredString(record, "currency"),
    ...(goods !== undefined ? { goods } : {}),
    ...(exportRegion !== undefined ? { exportRegion } : {}),
    ...(destinationRegion !== undefined ? { destinationRegion } : {}),
    ...(expectedCompletionDate !== undefined ? { expectedCompletionDate } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(createdBy !== undefined ? { createdBy } : {}),
    ...(allowDemoPlanFallback !== undefined ? { allowDemoPlanFallback } : {})
  };
}

function parseUpdateDraftBody(body: unknown): UpdateProductOrderDraftInput {
  const record = requireBodyRecord(body);
  for (const field of ["draftId", "zhixuId", "planId", "planHash", "createdBy", "createdAt", "registeredOrderId", "registrationTxHash"]) {
    if (Object.hasOwn(record, field)) {
      throw new ProductBffError(400, "immutable_field", `${field} cannot be updated by clients`);
    }
  }

  const title = optionalString(record, "title");
  const businessType = optionalString(record, "businessType");
  const goods = optionalStringArray(record, "goods");
  const totalAmount = optionalString(record, "totalAmount");
  const currency = optionalString(record, "currency");
  const exportRegion = optionalString(record, "exportRegion");
  const destinationRegion = optionalString(record, "destinationRegion");
  const expectedCompletionDate = optionalString(record, "expectedCompletionDate");
  const notes = optionalString(record, "notes");

  return {
    ...(title !== undefined ? { title } : {}),
    ...(businessType !== undefined ? { businessType } : {}),
    ...(goods !== undefined ? { goods } : {}),
    ...(totalAmount !== undefined ? { totalAmount } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(exportRegion !== undefined ? { exportRegion } : {}),
    ...(destinationRegion !== undefined ? { destinationRegion } : {}),
    ...(expectedCompletionDate !== undefined ? { expectedCompletionDate } : {}),
    ...(notes !== undefined ? { notes } : {})
  };
}

function parseCreateInviteBody(body: unknown): CreateProductInviteInput {
  const record = requireBodyRecord(body);
  const displayName = optionalString(record, "displayName");
  const expiresAt = optionalString(record, "expiresAt");
  return {
    roleSlotId: requiredString(record, "roleSlotId"),
    contact: requiredString(record, "contact"),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {})
  };
}

function parseAcceptInviteBody(request: ApiRequest): AcceptProductInviteInput {
  const record = requireBodyRecord(request.body);
  const sessionWalletAddress = walletAddressFromRequest(request);
  return {
    displayName: requiredString(record, "displayName"),
    walletAddress: requiredString(record, "walletAddress"),
    contact: requiredString(record, "contact"),
    ...(sessionWalletAddress ? { sessionWalletAddress } : {})
  };
}

function parseSubmitDraftBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  const record = requireBodyRecord(body);
  for (const field of ["authorizations", "authorization", "permissions", "signalAuthorizations"]) {
    if (Object.hasOwn(record, field)) {
      throw new ProductBffError(400, "client_authorizations_not_allowed", "SignalAuthorization[] is generated by the server");
    }
  }
}

function parseStartOrderBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  const record = requireBodyRecord(body);
  if (Object.keys(record).length > 0) {
    throw new ProductBffError(400, "invalid_body", "order start request body must be an empty JSON object");
  }
}

function parseRejectInviteBody(body: unknown): RejectProductInviteInput {
  const record = requireBodyRecord(body);
  const displayName = optionalString(record, "displayName");
  const contact = optionalString(record, "contact");
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(contact !== undefined ? { contact } : {})
  };
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new ProductBffError(400, "invalid_body", "request body must be a JSON object");
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductBffError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProductBffError(400, "invalid_body", `${field} must be a string`);
  }
  return value.trim();
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new ProductBffError(400, "invalid_body", `${field} must be a boolean`);
  }
  return value;
}

function optionalStringArray(record: Record<string, unknown>, field: string): readonly string[] | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ProductBffError(400, "invalid_body", `${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}
