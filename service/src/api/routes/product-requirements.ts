// V1 订单要求包路由：会话锚定的 PUT 声明 / GET 读取 / POST 相对方合意。
// 失败态按因给码：未登录由身份门 401，无权限 403，草稿不可编辑 409，
// hash 不匹配 409，句柄非法 400（精确 issue code）。

import type { ChainServicesRuntimeEnv } from "../../config/index.js";
import {
  OrderRequirementsError,
  type OrderRequirementsConsentInput
} from "../../product/requirements/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import type { Hex } from "../../shared/types.js";
import { resolveParticipantWalletIdentity } from "../participant-identity.js";
import {
  decodePathParameter,
  InvalidPathParameterError,
  invalidPathParameterResponse,
  type ApiResponse,
  type ApiRouteContext
} from "../route-context.js";
import type { RouteModule } from "../route-module.js";

const REQUIREMENTS_PATH = /^\/product\/order-drafts\/([^/]+)\/requirements(?:\/(consents))?$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{2,}$/;

export function createProductRequirementsRouteModule(options: {
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
} = {}): RouteModule {
  return {
    async handle(request, context) {
      const match = REQUIREMENTS_PATH.exec(request.pathname);
      if (!match) {
        return undefined;
      }
      return handleRequirementsRequest(async () => {
        const draftId = decodePathParameter(match[1] ?? "");
        const consentPath = match[2] === "consents";
        if (consentPath) {
          if (request.method !== "POST") {
            return undefined;
          }
          // 合意的身份是签名者：会话锚定钱包即被核验对象，body 自报钱包
          // 只作一致性校验（不一致即 403）。
          const wallet = await resolveParticipantWalletIdentity(
            request,
            context,
            options.runtimeEnvironment
          );
          if (!wallet.ok) {
            return wallet.response;
          }
          return {
            status: 200,
            body: await context.orderRequirementsService.consent(
              draftId,
              wallet.identity.walletAddress,
              parseConsentBody(request.body)
            )
          };
        }
        if (request.method === "GET") {
          const wallet = await resolveParticipantWalletIdentity(
            request,
            context,
            options.runtimeEnvironment
          );
          if (!wallet.ok) {
            return wallet.response;
          }
          return {
            status: 200,
            body: await context.orderRequirementsService.get(
              draftId,
              wallet.identity.walletAddress
            )
          };
        }
        if (request.method === "PUT") {
          // 声明人由会话锚定：body 自报钱包不构成身份（服务端另核创建者）。
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
            body: await context.orderRequirementsService.declare(
              draftId,
              wallet.identity.walletAddress,
              request.body
            )
          };
        }
        return undefined;
      });
    }
  };
}

async function handleRequirementsRequest(
  action: () => Promise<ApiResponse | undefined>
): Promise<ApiResponse | undefined> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof OrderRequirementsError) {
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
    throw error;
  }
}

function parseConsentBody(body: unknown): OrderRequirementsConsentInput {
  const record = requireBodyRecord(body);
  for (const field of ["consentId", "signedAt", "createdAt"]) {
    if (Object.hasOwn(record, field)) {
      throw new OrderRequirementsError(
        400,
        "immutable_field",
        `${field} is derived by the server and cannot be set by clients`,
        { field }
      );
    }
  }
  const requirementsHash = requiredString(record, "requirementsHash");
  if (!/^0x[0-9a-fA-F]{64}$/.test(requirementsHash)) {
    throw new OrderRequirementsError(
      400,
      "invalid_body",
      "requirementsHash must be a 0x-prefixed 32-byte hex digest"
    );
  }
  const signature = requiredString(record, "signature");
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new OrderRequirementsError(
      400,
      "invalid_body",
      "signature must be a 0x-prefixed hex string"
    );
  }
  return {
    requirementsHash: requirementsHash as Hex,
    signature: signature as Hex
  };
}

function requireBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new OrderRequirementsError(
    400,
    "invalid_body",
    "request body must be a JSON object"
  );
}

function requiredString(
  record: Record<string, unknown>,
  field: string
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrderRequirementsError(
      400,
      "invalid_body",
      `${field} must be a non-empty string`
    );
  }
  return value.trim();
}
