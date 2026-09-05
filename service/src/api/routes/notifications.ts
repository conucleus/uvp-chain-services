import { adminPrincipalFromHeaders } from "../../governance/index.js";
import type { NotificationDeliveryStatus, NotificationRedactedEvidenceQuery } from "../../notifications/index.js";
import { ConfigError, normalizeAddress, normalizeBytes32, type Address } from "../../shared/types.js";
import { cleanQuery, readApiHeader, type ApiRequest, type ApiResponse } from "../route-context.js";
import { resolveParticipantWalletIdentity } from "../participant-identity.js";
import type { RouteModule } from "../route-module.js";

type ParsedNotificationDeliveryQuery =
  | { readonly query: Record<string, string> & { readonly status?: NotificationDeliveryStatus } }
  | { readonly response: ApiResponse };

export function createNotificationsRouteModule(options: {
  readonly runtimeEnvironment?: Parameters<typeof resolveParticipantWalletIdentity>[2];
} = {}): RouteModule {
  return {
    async handle(request, context) {
      const participantNotificationResponse = await handleParticipantNotificationRequest(request, context, options.runtimeEnvironment);
      if (participantNotificationResponse) {
        return participantNotificationResponse;
      }
      return handleNotificationRequest(request, context);
    }
  };
}

async function handleParticipantNotificationRequest(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1],
  runtimeEnvironment?: Parameters<typeof resolveParticipantWalletIdentity>[2]
): Promise<ApiResponse | undefined> {
  if (!request.pathname.startsWith("/product/me/activity-feed")) {
    return undefined;
  }

  // 簇 C 修正（审计三轮）：activity-feed 的身份 = 会话锚定地址（钱包会话
  // 的签名证明，或 local 显式开启的 dev 锚定头）。query/body/header 自报
  // 钱包只用于与锚定地址一致性核验，不再作为唯一身份——此前 ?wallet= 即
  // 可读任意人活动流、代标已读。local 之外无会话即 401。
  const wallet = await resolveParticipantWalletIdentity(request, context, runtimeEnvironment);
  if (!wallet.ok) {
    return wallet.response;
  }
  const walletAddress = wallet.identity.walletAddress;

  if (request.method === "GET" && request.pathname === "/product/me/activity-feed") {
    const notifications = await context.notificationService.listParticipantNotifications({
      walletAddress
    });
    return {
      status: 200,
      body: {
        participant: {
          walletAddress
        },
        ...notifications
      }
    };
  }

  const readMatch = /^\/product\/me\/activity-feed\/([^/]+)\/read$/.exec(request.pathname);
  if (request.method === "POST" && readMatch) {
    const notificationId = parseDeliveryId(readMatch[1] ?? "");
    if (!notificationId.ok) {
      return {
        status: 400,
        body: { error: "invalid_notification_id", message: "notificationId must be a bytes32 hex value" }
      };
    }
    const notification = await context.notificationService.markParticipantNotificationRead({
      walletAddress,
      notificationId: notificationId.deliveryId
    });
    if (!notification) {
      return {
        status: 404,
        body: { error: "activity_feed_item_not_found" }
      };
    }
    return {
      status: 200,
      body: { notification }
    };
  }

  return {
    status: 404,
    body: { error: "not_found" }
  };
}

async function handleNotificationRequest(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1]
): Promise<ApiResponse | undefined> {
  if (!request.pathname.startsWith("/admin/notifications")) {
    return undefined;
  }

  const principal = adminPrincipalFromHeaders(request.headers);
  if (!principal) {
    return {
      status: 403,
      body: { error: "forbidden" }
    };
  }

  if (request.method === "GET" && request.pathname === "/admin/notifications/profiles") {
    return {
      status: 200,
      body: { profiles: await context.notificationService.listProfiles() }
    };
  }

  if (request.method === "GET" && request.pathname === "/admin/notifications/deliveries") {
    const query = parseNotificationDeliveryQuery(request.query);
    if ("response" in query) {
      return query.response;
    }
    return {
      status: 200,
      body: { deliveries: await context.notificationService.listDeliveries(query.query) }
    };
  }

  if (request.method === "GET" && request.pathname === "/admin/notifications/redacted-evidence") {
    const query = parseNotificationEvidenceQuery(request.query);
    if ("response" in query) {
      return query.response;
    }
    return {
      status: 200,
      body: { notificationEvidence: await context.notificationService.buildRedactedEvidence(query.query) }
    };
  }

  const retryMatch = /^\/admin\/notifications\/deliveries\/([^/]+)\/retry$/.exec(request.pathname);
  if (request.method === "POST" && retryMatch) {
    const deliveryId = parseDeliveryId(retryMatch[1] ?? "");
    if (!deliveryId.ok) {
      return deliveryId.response;
    }
    const delivery = await context.notificationService.retryDelivery(deliveryId.deliveryId);
    if (!delivery) {
      return {
        status: 404,
        body: { error: "notification_delivery_not_found" }
      };
    }
    return {
      status: 200,
      body: { delivery }
    };
  }

  const deadLetterMatch = /^\/admin\/notifications\/deliveries\/([^/]+)\/dead-letter$/.exec(request.pathname);
  if (request.method === "POST" && deadLetterMatch) {
    const deliveryId = parseDeliveryId(deadLetterMatch[1] ?? "");
    if (!deliveryId.ok) {
      return deliveryId.response;
    }
    const delivery = await context.notificationService.deadLetterDelivery(deliveryId.deliveryId, optionalReason(request.body));
    if (!delivery) {
      return {
        status: 404,
        body: { error: "notification_delivery_not_found" }
      };
    }
    return {
      status: 200,
      body: { delivery }
    };
  }

  return {
    status: 404,
    body: { error: "not_found" }
  };
}

function parseNotificationEvidenceQuery(query: ApiRequest["query"]):
  | { readonly query: NotificationRedactedEvidenceQuery }
  | { readonly response: ApiResponse } {
  const parsed: NotificationRedactedEvidenceQuery = {
    ...(query?.orderId ? { orderId: query.orderId } : {}),
    ...(query?.taskId ? { taskId: query.taskId } : {})
  };
  const rawWallet = query?.walletAddress ?? query?.wallet;
  if (!rawWallet) {
    return { query: parsed };
  }
  try {
    return {
      query: {
        ...parsed,
        walletAddress: normalizeAddress(rawWallet, "walletAddress")
      }
    };
  } catch (error) {
    return {
      response: {
        status: 400,
        body: {
          error: "invalid_wallet",
          message: error instanceof Error ? error.message : "walletAddress must be a valid EVM address"
        }
      }
    };
  }
}

function parseNotificationDeliveryQuery(query: ApiRequest["query"]): ParsedNotificationDeliveryQuery {
  const cleaned = cleanQuery({
    orderId: query?.orderId,
    taskId: query?.taskId,
    supplier: query?.supplier,
    status: query?.status
  });
  if (cleaned.status && !isNotificationDeliveryStatus(cleaned.status)) {
    return {
      response: {
        status: 400,
        body: { error: "invalid_query", message: "status must be pending, sent, failed, skipped, or dead_letter" }
      }
    };
  }
  return { query: cleaned as Record<string, string> & { readonly status?: NotificationDeliveryStatus } };
}

function parseDeliveryId(value: string): { readonly ok: true; readonly deliveryId: `0x${string}` } | { readonly ok: false; readonly response: ApiResponse } {
  try {
    return { ok: true, deliveryId: normalizeBytes32(decodeURIComponent(value), "deliveryId") };
  } catch (error) {
    if (error instanceof ConfigError) {
      return {
        ok: false,
        response: {
          status: 400,
          body: { error: "invalid_delivery_id", message: error.message }
        }
      };
    }
    throw error;
  }
}

function optionalReason(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const reason = (body as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : undefined;
}

function isNotificationDeliveryStatus(value: string): value is NotificationDeliveryStatus {
  return value === "pending" || value === "sent" || value === "failed" || value === "skipped" || value === "dead_letter";
}
