import type { Address, Hex } from "../shared/types.js";

export const SUPPLIER_NOTIFICATION_PROFILE_VERSION = "uvp.supplierNotificationProfile.v1" as const;

export type SupplierNotificationTransportType =
  | "webhook"
  | "slack"
  | "email"
  | "mcp"
  | "executor-watch"
  | "xmtp"
  | "push"
  | "walletconnect";

export interface SupplierNotificationTransportBase {
  readonly priority?: number;
  readonly enabled?: boolean;
}

export interface SupplierNotificationWebhookTransport extends SupplierNotificationTransportBase {
  readonly type: "webhook";
  readonly endpointRef: string;
  readonly headersRef?: string;
  readonly signingKeyRef?: string;
  readonly contentType?: "application/json";
}

export interface SupplierNotificationSlackTransport extends SupplierNotificationTransportBase {
  readonly type: "slack";
  readonly channelRef: string;
  readonly appRef?: string;
}

export interface SupplierNotificationEmailTransport extends SupplierNotificationTransportBase {
  readonly type: "email";
  readonly mailboxRef: string;
}

export interface SupplierNotificationMcpTransport extends SupplierNotificationTransportBase {
  readonly type: "mcp";
  readonly serverRef: string;
  readonly toolName: string;
  readonly authRef?: string;
}

export interface SupplierNotificationExecutorWatchTransport extends SupplierNotificationTransportBase {
  readonly type: "executor-watch";
  readonly watchAddress?: Address | string;
  readonly instructionsURI?: string;
}

export interface SupplierNotificationFutureTransport extends SupplierNotificationTransportBase {
  readonly type: "xmtp" | "push" | "walletconnect";
  readonly channelRef: string;
}

export type SupplierNotificationTransport =
  | SupplierNotificationWebhookTransport
  | SupplierNotificationSlackTransport
  | SupplierNotificationEmailTransport
  | SupplierNotificationMcpTransport
  | SupplierNotificationExecutorWatchTransport
  | SupplierNotificationFutureTransport;

export interface SupplierNotificationProfile {
  readonly version: typeof SUPPLIER_NOTIFICATION_PROFILE_VERSION;
  readonly supplierSubjectId?: Hex | string;
  readonly wallet?: Address | string;
  readonly transports: readonly SupplierNotificationTransport[];
  readonly productTaskUrlTemplate?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function parseSupplierNotificationProfile(value: unknown): SupplierNotificationProfile | undefined {
  if (!isRecord(value) || value.version !== SUPPLIER_NOTIFICATION_PROFILE_VERSION) {
    return undefined;
  }
  if (!Array.isArray(value.transports)) {
    return undefined;
  }

  const transports = value.transports
    .map(parseSupplierNotificationTransport)
    .filter((transport): transport is SupplierNotificationTransport => transport !== undefined);
  if (transports.length === 0) {
    return undefined;
  }

  return {
    version: SUPPLIER_NOTIFICATION_PROFILE_VERSION,
    ...(typeof value.supplierSubjectId === "string" && value.supplierSubjectId.length > 0
      ? { supplierSubjectId: value.supplierSubjectId }
      : {}),
    ...(typeof value.wallet === "string" && value.wallet.length > 0 ? { wallet: value.wallet } : {}),
    transports,
    ...(typeof value.productTaskUrlTemplate === "string" && value.productTaskUrlTemplate.length > 0
      ? { productTaskUrlTemplate: value.productTaskUrlTemplate }
      : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {})
  };
}

function parseSupplierNotificationTransport(value: unknown): SupplierNotificationTransport | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  switch (value.type) {
    case "webhook":
      if (typeof value.endpointRef !== "string" || value.endpointRef.length === 0) {
        return undefined;
      }
      return {
        ...parseTransportControls(value),
        type: "webhook",
        endpointRef: value.endpointRef,
        ...(typeof value.headersRef === "string" && value.headersRef.length > 0 ? { headersRef: value.headersRef } : {}),
        ...(typeof value.signingKeyRef === "string" && value.signingKeyRef.length > 0 ? { signingKeyRef: value.signingKeyRef } : {}),
        contentType: "application/json"
      };
    case "slack":
      if (typeof value.channelRef !== "string" || value.channelRef.length === 0) {
        return undefined;
      }
      return {
        ...parseTransportControls(value),
        type: "slack",
        channelRef: value.channelRef,
        ...(typeof value.appRef === "string" && value.appRef.length > 0 ? { appRef: value.appRef } : {})
      };
    case "email":
      if (typeof value.mailboxRef !== "string" || value.mailboxRef.length === 0) {
        return undefined;
      }
      return {
        ...parseTransportControls(value),
        type: "email",
        mailboxRef: value.mailboxRef
      };
    case "mcp":
      if (typeof value.serverRef !== "string" || value.serverRef.length === 0) {
        return undefined;
      }
      if (typeof value.toolName !== "string" || value.toolName.length === 0) {
        return undefined;
      }
      return {
        ...parseTransportControls(value),
        type: "mcp",
        serverRef: value.serverRef,
        toolName: value.toolName,
        ...(typeof value.authRef === "string" && value.authRef.length > 0 ? { authRef: value.authRef } : {})
      };
    case "executor-watch":
      return {
        ...parseTransportControls(value),
        type: "executor-watch",
        ...(typeof value.watchAddress === "string" && value.watchAddress.length > 0 ? { watchAddress: value.watchAddress } : {}),
        ...(typeof value.instructionsURI === "string" && value.instructionsURI.length > 0 ? { instructionsURI: value.instructionsURI } : {})
      };
    case "xmtp":
    case "push":
    case "walletconnect":
      if (typeof value.channelRef !== "string" || value.channelRef.length === 0) {
        return undefined;
      }
      return {
        ...parseTransportControls(value),
        type: value.type,
        channelRef: value.channelRef
      };
    default:
      return undefined;
  }
}

function parseTransportControls(value: Record<string, unknown>): SupplierNotificationTransportBase {
  return {
    ...(typeof value.priority === "number" && Number.isSafeInteger(value.priority) && value.priority >= 0
      ? { priority: value.priority }
      : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
