import {
  ProductBffError,
  type ProductBffService
} from "../../product/query/bff/service.js";
import type {
  AcceptProductInviteInput,
  CreateProductInviteInput,
  CreateProductOrderDraftInput,
  PrepareProductOrderTriggerInput,
  ProductInviteDTO,
  ProductInvitePreviewResponse,
  ProductInviteResponse,
  RejectProductInviteInput,
  TriggerProductOrderInput,
  UpdateProductOrderDraftInput
} from "../../product/query/bff/types.js";
import type { AuditSink } from "../../security/audit.js";
import { redactErrorMessage } from "../../security/redaction.js";
import { ConfigError } from "../../shared/types.js";
import { decodePathParameter, InvalidPathParameterError, invalidPathParameterResponse, type ApiRequest, type ApiResponse, type ApiRouteContext } from "../route-context.js";
import { resolveParticipantWalletIdentity } from "../participant-identity.js";
import type { RouteModule } from "../route-module.js";

export function createProductBffRouteModule(options: {
  readonly runtimeEnvironment?: Parameters<typeof resolveParticipantWalletIdentity>[2];
} = {}): RouteModule {
  return {
    async handle(request, context) {
      if (request.method === "POST" && request.pathname === "/product/order-drafts") {
        const input = parseCreateDraftBody(request.body);
        return handleProductBffRequest(async () => {
          // createdBy 不取自 body 自报（可冒充他人建单）——有会话锚定
          // 钱包时记录锚定地址，无身份时保留匿名建单兼容路径；但匿名
          // 草稿的修改/邀请/参与者读取全部 fail-closed（见下）。
          const wallet = await resolveParticipantWalletIdentity(
            request,
            context,
            options.runtimeEnvironment,
            { includeBodyWallet: false }
          );
          const result = await context.productBffService.createDraft({
            ...input,
            ...(wallet.ok ? { createdBy: wallet.identity.walletAddress } : {})
          });
          return {
            status: 201,
            body: result
          };
        }, { audit: context.audit });
      }

      const productOrderDraftPrepareTriggerMatch = /^\/product\/order-drafts\/([^/]+)\/prepare-trigger$/.exec(request.pathname);
      if (request.method === "POST" && productOrderDraftPrepareTriggerMatch) {
        return handleProductBffRequest(async () => {
          const draftId = decodePathParameter(productOrderDraftPrepareTriggerMatch[1] ?? "");
          // prepare-trigger 返回完整草稿/参与者联系方式，且 submitter 是
          // 后续签名的身份根——不取 body 自报钱包：会话锚定地址为身份，
          // body 自报值仅作一致性核验（不一致即 403）。
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const body = await context.productBffService.prepareOrderTrigger(draftId, {
            ...parsePrepareTriggerBody(request.body),
            walletAddress: wallet.identity.walletAddress
          });
          return {
            status: 200,
            body
          };
        }, { audit: context.audit });
      }

      const productOrderDraftTriggerMatch = /^\/product\/order-drafts\/([^/]+)\/trigger$/.exec(request.pathname);
      if (request.method === "POST" && productOrderDraftTriggerMatch) {
        return handleProductBffRequest(async () => {
          const draftId = decodePathParameter(productOrderDraftTriggerMatch[1] ?? "");
          const body = await context.productBffService.triggerOrder(draftId, parseTriggerBody(request.body));
          context.onTxMined?.();
          return {
            status: 200,
            body
          };
        }, { audit: context.audit });
      }

      const productOrderRegistrationMatch = /^\/product\/order-triggers\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productOrderRegistrationMatch) {
        return handleProductBffRequest(async () => {
          // trigger 档案携带草稿、签名者与授权明细，匿名不可按 id 枚举——
          // 会话身份门之外还须与档案归属（trigger 创建者/签名者或草稿
          // 归属方）比对，与 GET /product/order-drafts/:id 同口径双门。
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const triggerId = decodePathParameter(productOrderRegistrationMatch[1] ?? "");
          return {
            status: 200,
            body: { trigger: await context.productBffService.getRegistration(triggerId, wallet.identity.walletAddress) }
          };
        }, { audit: context.audit });
      }

      const productOrderDraftMatch = /^\/product\/order-drafts\/([^/]+)$/.exec(request.pathname);
      if (productOrderDraftMatch) {
        const draftId = decodePathParameter(productOrderDraftMatch[1] ?? "");
        if (request.method === "GET") {
          return handleProductBffRequest(async () => {
            // 草稿读取返回完整参与者名单（含联系方式），与 listParticipants
            // 同门槛：会话锚定钱包（创建者/已接受参与者由服务端核验）。
            const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
            if (!wallet.ok) {
              return wallet.response;
            }
            return {
              status: 200,
              body: await context.productBffService.getDraft(draftId, wallet.identity.walletAddress)
            };
          }, { audit: context.audit });
        }
        if (request.method === "PATCH") {
          return handleProductBffRequest(async () => {
            // 修改限创建者：会话锚定钱包必须等于建单时记录的 createdBy。
            const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
            if (!wallet.ok) {
              return wallet.response;
            }
            return {
              status: 200,
              body: { draft: await context.productBffService.updateDraft(draftId, parseUpdateDraftBody(request.body), wallet.identity.walletAddress) }
            };
          }, { audit: context.audit });
        }
      }

      const productOrderInviteMatch = /^\/product\/orders\/([^/]+)\/invites$/.exec(request.pathname);
      if (request.method === "POST" && productOrderInviteMatch) {
        return handleProductBffRequest(async () => {
          const draftId = decodePathParameter(productOrderInviteMatch[1] ?? "");
          // 邀请由创建者签发（token 只回到创建响应），任何会话钱包
          // 不得替他人草稿发邀请。
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const result = await context.productBffService.createInvite(draftId, parseCreateInviteBody(request.body), wallet.identity.walletAddress);
          return {
            status: 201,
            body: publicInviteResponse(result)
          };
        }, { audit: context.audit });
      }

      const productInvitePreviewMatch = /^\/product\/invites\/([^/]+)$/.exec(request.pathname);
      if (request.method === "POST" && productInvitePreviewMatch) {
        return handleProductBffRequest(async () => {
          const inviteId = decodePathParameter(productInvitePreviewMatch[1] ?? "");
          // 预览同样强制 invite token（哈希比对）：inviteId 是弱凭据，
          // 仅凭 id 即可读受邀人联系方式与草稿金额等于邀请面全员可枚举。
          // token 与 accept/reject 同走 body——同权凭据不得落 URL query
          //（URL/Referer/代理日志留痕等于一次性凭据泄漏）。会话钱包仍
          // 可选（用于金额可见范围判定）。
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          const walletAddress = wallet.ok ? wallet.identity.walletAddress : undefined;
          const result = await context.productBffService.getInvite(inviteId, {
            ...parseInvitePreviewBody(request.body),
            ...(walletAddress ? { walletAddress } : {})
          });
          return {
            status: 200,
            body: publicInvitePreviewResponse(result)
          };
        }, { audit: context.audit });
      }

      const productInviteAcceptMatch = /^\/product\/invites\/([^/]+)\/accept$/.exec(request.pathname);
      if (request.method === "POST" && productInviteAcceptMatch) {
        return handleProductBffRequest(async () => {
          const inviteId = decodePathParameter(productInviteAcceptMatch[1] ?? "");
          // accept 必须是已证明钱包控制的会话（钱包会话签名
          // 或 local dev 锚定头），自报钱包头不算数；且必须携带 invite
          // token（哈希比对）——inviteId 是弱凭据，不足以占角色槽。钱包声明
          // 不读 body（body.walletAddress 是被核验对象，不是证明）。
          const wallet = await resolveParticipantWalletIdentity(
            request,
            context,
            options.runtimeEnvironment,
            { includeBodyWallet: false }
          );
          if (!wallet.ok) {
            return wallet.response;
          }
          return {
            status: 200,
            body: publicInviteResponse(await context.productBffService.acceptInvite(
              inviteId,
              parseAcceptInviteBody(request, wallet.identity.walletAddress)
            ))
          };
        }, { audit: context.audit });
      }

      const productInviteRejectMatch = /^\/product\/invites\/([^/]+)\/reject$/.exec(request.pathname);
      if (request.method === "POST" && productInviteRejectMatch) {
        return handleProductBffRequest(async () => {
          const inviteId = decodePathParameter(productInviteRejectMatch[1] ?? "");
          return {
            status: 200,
            body: publicInviteResponse(await context.productBffService.rejectInvite(inviteId, parseRejectInviteBody(request.body)))
          };
        }, { audit: context.audit });
      }

      const productOrderParticipantsMatch = /^\/product\/orders\/([^/]+)\/participants$/.exec(request.pathname);
      if (request.method === "GET" && productOrderParticipantsMatch) {
        return handleProductBffRequest(async () => {
          const draftId = decodePathParameter(productOrderParticipantsMatch[1] ?? "");
          // 参与者名单含联系方式，读门槛与 accept 同级证明（会话锚定
          // 钱包），且仅限创建者或该草稿的已接受参与者（服务端核验）。
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          return {
            status: 200,
            body: { participants: await context.productBffService.listParticipants(draftId, wallet.identity.walletAddress) }
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
    if (error instanceof InvalidPathParameterError) {
      return invalidPathParameterResponse();
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

function parseCreateDraftBody(body: unknown): CreateProductOrderDraftInput {
  const record = requireBodyRecord(body);
  const goods = optionalStringArray(record, "goods");
  const exportRegion = optionalString(record, "exportRegion");
  const destinationRegion = optionalString(record, "destinationRegion");
  const expectedCompletionDate = optionalString(record, "expectedCompletionDate");
  const notes = optionalString(record, "notes");
  // createdBy 由服务端从会话锚定地址派生，不读 body 自报值。
  for (const field of ["createdBy"]) {
    if (Object.hasOwn(record, field)) {
      throw new ProductBffError(400, "immutable_field", `${field} cannot be set by clients`);
    }
  }

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
    ...(notes !== undefined ? { notes } : {})
  };
}

function parseUpdateDraftBody(body: unknown): UpdateProductOrderDraftInput {
  const record = requireBodyRecord(body);
  for (const field of ["draftId", "zhixuId", "planId", "planHash", "createdBy", "createdAt", "triggeredOrderId", "triggerTxHash"]) {
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

function parseAcceptInviteBody(
  request: ApiRequest,
  sessionWalletAddress: string
): AcceptProductInviteInput {
  const record = requireBodyRecord(request.body);
  return {
    displayName: requiredString(record, "displayName"),
    walletAddress: requiredString(record, "walletAddress"),
    contact: requiredString(record, "contact"),
    // accept/reject 强制携带 invite token（服务端哈希比对）。
    token: requiredString(record, "token"),
    sessionWalletAddress
  };
}

function parsePrepareTriggerBody(body: unknown): PrepareProductOrderTriggerInput {
  const record = requireBodyRecord(body);
  for (const field of ["authorizations", "authorization", "permissions", "signalAuthorizations"]) {
    if (Object.hasOwn(record, field)) {
      throw new ProductBffError(400, "client_authorizations_not_allowed", "SignalAuthorization[] is generated by the server");
    }
  }
  return {
    walletAddress: requiredString(record, "walletAddress")
  };
}

function parseTriggerBody(body: unknown): TriggerProductOrderInput {
  const record = requireBodyRecord(body);
  for (const field of ["authorizations", "authorization", "permissions", "signalAuthorizations"]) {
    if (Object.hasOwn(record, field)) {
      throw new ProductBffError(400, "client_authorizations_not_allowed", "SignalAuthorization[] is generated by the server");
    }
  }
  return {
    prepareId: requiredString(record, "prepareId"),
    signature: requiredString(record, "signature"),
    walletAddress: requiredString(record, "walletAddress")
  };
}

function parseInvitePreviewBody(body: unknown): { readonly token: string } {
  const record = requireBodyRecord(body);
  return {
    token: requiredString(record, "token")
  };
}

function parseRejectInviteBody(body: unknown): RejectProductInviteInput {
  const record = requireBodyRecord(body);
  const displayName = optionalString(record, "displayName");
  const contact = optionalString(record, "contact");
  return {
    token: requiredString(record, "token"),
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
