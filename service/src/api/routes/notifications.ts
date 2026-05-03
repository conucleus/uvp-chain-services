import { adminPrincipalFromHeaders } from "../../governance/index.js";
import {
  SupplierNotificationConfigError,
  type NotificationDeliveryStatus
} from "../../notifications/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import { ConfigError, normalizeAddress, normalizeBytes32, type Address } from "../../shared/types.js";
import { cleanQuery, readApiHeader, type ApiRequest, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

type ParsedNotificationDeliveryQuery =
  | { readonly query: Record<string, string> & { readonly status?: NotificationDeliveryStatus } }
  | { readonly response: ApiResponse };

export function createNotificationsRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      const participantNotificationResponse = await handleParticipantNotificationRequest(request, context);
      if (participantNotificationResponse) {
        return participantNotificationResponse;
      }
      const supplierConfigResponse = await handleSupplierNotificationConfigRequest(request, context);
      if (supplierConfigResponse) {
        return supplierConfigResponse;
      }
      return handleNotificationRequest(request, context);
    }
  };
}

async function handleParticipantNotificationRequest(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1]
): Promise<ApiResponse | undefined> {
  if (!request.pathname.startsWith("/product/me/notifications")) {
    return undefined;
  }

  const wallet = parseParticipantWallet(request);
  if (!wallet.ok) {
    return wallet.response;
  }

  if (request.method === "GET" && request.pathname === "/product/me/notifications") {
    const notifications = await context.notificationService.listParticipantNotifications({
      ...(wallet.walletAddress ? { walletAddress: wallet.walletAddress } : {})
    });
    return {
      status: 200,
      body: {
        participant: {
          ...(wallet.walletAddress ? { walletAddress: wallet.walletAddress } : {})
        },
        ...notifications
      }
    };
  }

  const readMatch = /^\/product\/me\/notifications\/([^/]+)\/read$/.exec(request.pathname);
  if (request.method === "POST" && readMatch) {
    const notificationId = parseDeliveryId(readMatch[1] ?? "");
    if (!notificationId.ok) {
      return {
        status: 400,
        body: { error: "invalid_notification_id", message: "notificationId must be a bytes32 hex value" }
      };
    }
    const notification = await context.notificationService.markParticipantNotificationRead({
      ...(wallet.walletAddress ? { walletAddress: wallet.walletAddress } : {}),
      notificationId: notificationId.deliveryId
    });
    if (!notification) {
      return {
        status: 404,
        body: { error: "participant_notification_not_found" }
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

async function handleSupplierNotificationConfigRequest(
  request: ApiRequest,
  context: Parameters<RouteModule["handle"]>[1]
): Promise<ApiResponse | undefined> {
  if (!request.pathname.startsWith("/supplier/notifications/profile")) {
    return undefined;
  }

  try {
    if (request.method === "POST" && request.pathname === "/supplier/notifications/profile/prepare") {
      return {
        status: 200,
        body: { profileConfig: context.supplierNotificationConfigService.prepare(request.body) }
      };
    }

    if (request.method === "POST" && request.pathname === "/supplier/notifications/profile") {
      return {
        status: 201,
        body: { profileConfig: await context.supplierNotificationConfigService.save(request.body) }
      };
    }

    if (request.method === "GET" && request.pathname === "/supplier/notifications/profile") {
      const query = cleanQuery({
        wallet: request.query?.wallet,
        supplierSubjectId: request.query?.supplierSubjectId
      });
      return {
        status: 200,
        body: {
          profileConfigs: await context.supplierNotificationConfigService.list(query)
        }
      };
    }
  } catch (error) {
    if (error instanceof SupplierNotificationConfigError) {
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

  return {
    status: 404,
    body: { error: "not_found" }
  };
}

function parseParticipantWallet(request: ApiRequest):
  | { readonly ok: true; readonly walletAddress?: Address }
  | { readonly ok: false; readonly response: ApiResponse } {
  const rawWallet = request.query?.wallet ??
    request.query?.walletAddress ??
    walletAddressFromBody(request.body) ??
    readApiHeader(request.headers, "x-uvp-wallet-address") ??
    readApiHeader(request.headers, "x-uvp-session-wallet-address") ??
    readApiHeader(request.headers, "x-wallet-address");
  if (!rawWallet) {
    return { ok: true };
  }
  try {
    return { ok: true, walletAddress: normalizeAddress(rawWallet, "wallet") };
  } catch (error) {
    return {
      ok: false,
      response: {
        status: 400,
        body: {
          error: "invalid_wallet",
          message: error instanceof Error ? error.message : "wallet must be a valid EVM address"
        }
      }
    };
  }
}

function walletAddressFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const walletAddress = (body as Record<string, unknown>).walletAddress;
  return typeof walletAddress === "string" ? walletAddress : undefined;
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

  if (request.method === "POST" && request.pathname === "/admin/notifications/run-once") {
    return {
      status: 200,
      body: { summary: await context.notificationService.runOnce() }
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
