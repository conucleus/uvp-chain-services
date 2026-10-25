// V3 订单域路由（配置注册/草稿/slot 邀请/EIP-712 接受/finalize/订单读）。
// 身份只认会话锚定钱包（x-uvp-store-session 或 local dev 锚定头），不接受
// 任何自报钱包；失败按因给 400/401/403/404/409/410/422/503。

import { OrderV3Error, type OrderV3ErrorCode } from "../../order/v3/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import type { Address } from "../../shared/types.js";
import {
  decodePathParameter,
  invalidPathParameterResponse,
  InvalidPathParameterError,
  readApiHeader,
  type ApiResponse,
  type ApiRequest,
  type ApiRouteContext,
} from "../route-context.js";
import type { RouteModule } from "../route-module.js";

const CONFIG_VERSIONS_PATH = /^\/product\/v3\/configs\/(.+)\/versions\/([^/]+)$/;
const CONFIG_ACTION_PATH = /^\/product\/v3\/configs\/(.+)\/([^/]+)\/(publish|deprecate)$/;
const CONFIG_VERSION_READ_PATH = /^\/product\/v3\/configs\/(.+)\/([^/]+)$/;
const DRAFT_PATH = /^\/product\/v3\/order-drafts\/([^/]+)$/;
const DRAFT_INVITES_PATH = /^\/product\/v3\/order-drafts\/([^/]+)\/invites$/;
const DRAFT_FINALIZE_PATH = /^\/product\/v3\/order-drafts\/([^/]+)\/finalize$/;
const DRAFT_FINALIZE_PREPARE_PATH = /^\/product\/v3\/order-drafts\/([^/]+)\/finalize\/prepare$/;
const INVITE_PATH = /^\/product\/v3\/invites\/([^/]+)\/(preview|accept|reject|revoke)$/;
const ORDER_PATH = /^\/product\/v3\/orders\/([^/]+)$/;
const ORDER_STAGE_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)$/;

export function createProductOrderV3RouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/product/v3/")) {
        return undefined;
      }
      try {
        return await handleV3Request(request, context);
      } catch (error) {
        if (isOrderV3Error(error)) {
          return {
            status: error.status,
            body: {
              error: error.code,
              message: redactErrorMessage(error),
              ...(error.details !== undefined ? { details: error.details } : {}),
            },
          };
        }
        if (error instanceof InvalidPathParameterError) {
          return invalidPathParameterResponse();
        }
        throw error;
      }
    },
  };
}

async function handleV3Request(
  request: ApiRequest,
  context: ApiRouteContext,
): Promise<ApiResponse | undefined> {
  const service = context.orderV3Service;

  if (request.pathname === "/product/v3/configs" && request.method === "POST") {
    const wallet = await requireWallet(request, context);
    return { status: 201, body: await service.publishConfig(wallet, request.body) };
  }

  const configVersionsMatch = CONFIG_VERSIONS_PATH.exec(request.pathname);
  if (configVersionsMatch && request.method === "GET") {
    const wallet = await requireWallet(request, context);
    return {
      status: 200,
      body: await service.getConfig(
        wallet,
        decodePathParameter(configVersionsMatch[1] ?? ""),
        decodePathParameter(configVersionsMatch[2] ?? ""),
      ),
    };
  }

  const configActionMatch = CONFIG_ACTION_PATH.exec(request.pathname);
  if (configActionMatch && request.method === "POST") {
    const wallet = await requireWallet(request, context);
    const configId = decodePathParameter(configActionMatch[1] ?? "");
    const version = decodePathParameter(configActionMatch[2] ?? "");
    if (configActionMatch[3] === "publish") {
      return { status: 200, body: await service.publishConfigVersion(wallet, configId, version) };
    }
    return { status: 200, body: await service.deprecateConfig(wallet, configId, version) };
  }

  const configReadMatch = CONFIG_VERSION_READ_PATH.exec(request.pathname);
  if (configReadMatch && request.method === "GET") {
    const wallet = await requireWallet(request, context);
    return {
      status: 200,
      body: await service.getConfig(
        wallet,
        decodePathParameter(configReadMatch[1] ?? ""),
        decodePathParameter(configReadMatch[2] ?? ""),
      ),
    };
  }

  if (request.pathname === "/product/v3/order-drafts" && request.method === "POST") {
    const wallet = await requireWallet(request, context);
    return {
      status: 201,
      body: await service.createDraft(wallet, request.body, idempotencyKeyOf(request)),
    };
  }

  const draftMatch = DRAFT_PATH.exec(request.pathname);
  if (draftMatch) {
    const draftId = decodePathParameter(draftMatch[1] ?? "");
    if (request.method === "GET") {
      const wallet = await requireWallet(request, context);
      return { status: 200, body: await service.getDraft(wallet, draftId) };
    }
    if (request.method === "PATCH") {
      const wallet = await requireWallet(request, context);
      return {
        status: 200,
        body: await service.updateDraft(wallet, draftId, request.body, idempotencyKeyOf(request)),
      };
    }
    return undefined;
  }

  const invitesMatch = DRAFT_INVITES_PATH.exec(request.pathname);
  if (invitesMatch && request.method === "POST") {
    const wallet = await requireWallet(request, context);
    return {
      status: 201,
      body: await service.createInvite(wallet, decodePathParameter(invitesMatch[1] ?? ""), request.body),
    };
  }

  const finalizePrepareMatch = DRAFT_FINALIZE_PREPARE_PATH.exec(request.pathname);
  if (finalizePrepareMatch && request.method === "POST") {
    const wallet = await requireWallet(request, context);
    return {
      status: 200,
      body: await service.prepareFinalize(wallet, decodePathParameter(finalizePrepareMatch[1] ?? "")),
    };
  }

  const finalizeMatch = DRAFT_FINALIZE_PATH.exec(request.pathname);
  if (finalizeMatch && request.method === "POST") {
    const wallet = await requireWallet(request, context);
    return {
      status: 200,
      body: await service.finalizeDraft(
        wallet,
        decodePathParameter(finalizeMatch[1] ?? ""),
        idempotencyKeyOf(request),
        request.body,
      ),
    };
  }

  const inviteMatch = INVITE_PATH.exec(request.pathname);
  if (inviteMatch && request.method === "POST") {
    const inviteId = decodePathParameter(inviteMatch[1] ?? "");
    const action = inviteMatch[2];
    const wallet = await requireWallet(request, context);
    if (action === "preview") {
      return { status: 200, body: await service.previewInvite(wallet, inviteId, request.body) };
    }
    if (action === "accept") {
      return {
        status: 200,
        body: await service.acceptInvite(wallet, inviteId, request.body, idempotencyKeyOf(request)),
      };
    }
    if (action === "reject") {
      return {
        status: 200,
        body: await service.rejectInvite(wallet, inviteId, request.body, idempotencyKeyOf(request)),
      };
    }
    if (action === "revoke") {
      return { status: 200, body: await service.revokeInvite(wallet, inviteId) };
    }
    return undefined;
  }

  const orderStageMatch = ORDER_STAGE_PATH.exec(request.pathname);
  if (orderStageMatch && request.method === "GET") {
    const wallet = await requireWallet(request, context);
    return {
      status: 200,
      body: await service.getStage(
        wallet,
        decodePathParameter(orderStageMatch[1] ?? ""),
        decodePathParameter(orderStageMatch[2] ?? ""),
      ),
    };
  }

  const orderMatch = ORDER_PATH.exec(request.pathname);
  if (orderMatch && request.method === "GET") {
    const wallet = await requireWallet(request, context);
    return { status: 200, body: await service.getOrder(wallet, decodePathParameter(orderMatch[1] ?? "")) };
  }

  return undefined;
}

async function requireWallet(request: ApiRequest, context: ApiRouteContext): Promise<Address> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (!access.anchoredAddress) {
    throw orderV3Error(401, "wallet_identity_required", "a wallet session is required for V3 order endpoints");
  }
  return access.anchoredAddress;
}

function idempotencyKeyOf(request: ApiRequest): string | undefined {
  const header = readApiHeader(request.headers, "idempotency-key");
  if (header !== undefined && header.trim().length > 0) {
    return header.trim();
  }
  const body = request.body;
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const candidate = (body as Record<string, unknown>).idempotencyKey;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function isOrderV3Error(value: unknown): value is OrderV3Error {
  return value instanceof Error && value.name === "OrderV3Error" && "status" in value && "code" in value;
}

function orderV3Error(status: number, code: OrderV3ErrorCode, message: string): OrderV3Error {
  return new OrderV3Error(status, code, message);
}
