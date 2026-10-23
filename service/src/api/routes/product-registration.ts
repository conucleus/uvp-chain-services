import { redactErrorMessage } from "../../security/redaction.js";
import { StorageUnavailableError } from "../../storage/errors.js";
import { StoreEntityRegistrationServiceError } from "../../store/registration/index.js";
import { resolveParticipantWalletIdentity } from "../participant-identity.js";
import type { ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

/**
 * 参与者实体自助登记（链下档案，未核验）。
 *
 * - `POST /product/registration`：会话锚定地址 + 实体名称/注册号/联系人，
 *   单账号单活跃记录（重复提交更新）。失败分类沿用参与者面错误形状。
 * - `GET  /product/registration/me`：读回当前会话地址的最新登记档案；
 *   未登记返回 200 `{ registration: null }`（"没有记录"与"读取失败"分开）。
 *
 * 本模块不写链、不创建供应商、不调用治理 register-identity；账号地址只从
 * 会话锚定地址派生，请求体里的 account/status/verified 一律 400。
 */
export function createProductRegistrationRouteModule(options: {
  readonly runtimeEnvironment?: Parameters<typeof resolveParticipantWalletIdentity>[2];
} = {}): RouteModule {
  return {
    async handle(request, context) {
      if (request.method === "POST" && request.pathname === "/product/registration") {
        return withStorageGuard(async () => {
          const identity = await resolveParticipantWalletIdentity(
            request,
            context,
            options.runtimeEnvironment,
            // 身份只取会话锚定地址；body 自报钱包不是身份来源。
            { includeBodyWallet: false }
          );
          if (!identity.ok) {
            return identity.response;
          }
          try {
            const registration = await context.storeEntityRegistrationService.registerEntity(
              request.body,
              {
                accountAddress: identity.identity.walletAddress,
                ...(identity.identity.accountId !== undefined
                  ? { accountId: identity.identity.accountId }
                  : {})
              }
            );
            return {
              status: 201,
              body: { registration }
            };
          } catch (error) {
            return registrationErrorResponse(error);
          }
        });
      }

      if (request.method === "GET" && request.pathname === "/product/registration/me") {
        return withStorageGuard(async () => {
          const identity = await resolveParticipantWalletIdentity(
            request,
            context,
            options.runtimeEnvironment,
            { includeBodyWallet: false }
          );
          if (!identity.ok) {
            return identity.response;
          }
          try {
            const registration = await context.storeEntityRegistrationService.getMyRegistration(
              identity.identity.walletAddress
            );
            return {
              status: 200,
              body: { registration: registration ?? null }
            };
          } catch (error) {
            return registrationErrorResponse(error);
          }
        });
      }

      return undefined;
    }
  };
}

function registrationErrorResponse(error: unknown): ApiResponse {
  if (error instanceof StoreEntityRegistrationServiceError) {
    return {
      status: error.status,
      body: {
        error: error.code,
        message: redactErrorMessage(error),
        ...(error.details !== undefined ? { details: error.details } : {})
      }
    };
  }
  throw error;
}

async function withStorageGuard(action: () => Promise<ApiResponse>): Promise<ApiResponse> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      return {
        status: 503,
        body: {
          error: "product_storage_unavailable",
          message: error.message,
          retryable: true
        }
      };
    }
    throw error;
  }
}
