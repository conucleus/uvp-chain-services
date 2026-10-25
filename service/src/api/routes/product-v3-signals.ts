// V3 写/读路径：signal 候选与授权、验收证据校验、V3 store
// 配置发布元数据。均先过唯一 visibility resolver；不读取
// 授权与证据语义由 config senders/slots + stage binding + fileResources 句柄承载。

import type { Hex, Address } from "../../shared/types.js";
import { OrderV3Error } from "../../order/v3/index.js";
import type { PlanCapabilityTables } from "../../submissions/capability-proofs.js";
import { createVisibilityResolver } from "../../visibility/index.js";
import type { ResourceResolverPort } from "../../visibility/types.js";
import { createV3EvidenceService, createV3SignalService, buildV3PublishMetadata } from "../../v3/index.js";
import {
  decodePathParameter,
  InvalidPathParameterError,
  invalidPathParameterResponse,
  type ApiResponse,
  type ApiRequest,
  type ApiRouteContext,
} from "../route-context.js";
import type { RouteModule } from "../route-module.js";

const CANDIDATES_PATH = /^\/product\/v3\/orders\/([^/]+)\/signal-candidates$/;
const STAGE_CANDIDATES_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/signal-candidates$/;
const AUTHORIZE_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/signals\/authorize$/;
const ACCEPTANCE_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/acceptance\/validate$/;
const STORE_PUBLISH_PATH = "/product/v3/store/configs";

export interface ProductV3SignalsRouteOptions {
  readonly operatorWallets?: readonly Address[];
  readonly resourceResolver?: ResourceResolverPort;
  readonly planCapabilities?: (planId: Hex) => Promise<PlanCapabilityTables | undefined>;
}

export function createProductV3SignalsRouteModule(options: ProductV3SignalsRouteOptions = {}): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/product/v3/")) {
        return undefined;
      }
      const storePublish = request.pathname === STORE_PUBLISH_PATH && request.method === "POST";
      const candidateMatch = CANDIDATES_PATH.exec(request.pathname);
      const stageCandidateMatch = STAGE_CANDIDATES_PATH.exec(request.pathname);
      const authorizeMatch = AUTHORIZE_PATH.exec(request.pathname);
      const acceptanceMatch = ACCEPTANCE_PATH.exec(request.pathname);
      if (!storePublish && !candidateMatch && !stageCandidateMatch && !authorizeMatch && !acceptanceMatch) {
        return undefined;
      }
      try {
        const wallet = await requireWallet(request, context);
        const signals = createSignalService(context, options);
        if (storePublish) {
          const body = requireRecord(request.body);
          const config = requireRecord(body.config);
          const planId = requireHex(body.planId, "planId");
          const planHash = requireHex(body.planHash, "planHash");
          const metadata = buildV3PublishMetadata({ config: config as never, planId, planHash });
          const published = await context.orderV3Service.config.publish(wallet, { config, planId, planHash });
          return { status: 201, body: { ...metadata, configHash: published.configHash } };
        }
        if (candidateMatch || stageCandidateMatch) {
          const match = candidateMatch ?? stageCandidateMatch!;
          const orderId = decodePathParameter(match[1] ?? "");
          const stageKey = candidateMatch ? undefined : decodePathParameter(match[2] ?? "");
          const items = await signals.listCandidates(orderId, stageKey, wallet);
          return { status: 200, body: { dataState: items.length > 0 ? "ok" : "none", orderId, ...(stageKey ? { stageKey } : {}), items } };
        }
        if (authorizeMatch) {
          const orderId = decodePathParameter(authorizeMatch[1] ?? "");
          const stageKey = decodePathParameter(authorizeMatch[2] ?? "");
          const body = requireRecord(request.body);
          const candidate = await signals.authorize({
            orderId,
            stageKey,
            wallet,
            signalName: requireString(body.signalName, "signalName"),
          });
          return { status: 200, body: { authorized: true, candidate } };
        }
        if (acceptanceMatch) {
          const orderId = decodePathParameter(acceptanceMatch[1] ?? "");
          const stageKey = decodePathParameter(acceptanceMatch[2] ?? "");
          const body = requireRecord(request.body);
          const evidence = createV3EvidenceService({
            visibility: visibilityFor(context, options),
            signals,
            loadOrder: (id) => context.orderV3Service.loadOrderSnapshotForVisibility(id),
            ...(options.resourceResolver ? { resourceResolver: options.resourceResolver } : {}),
          });
          const handleKeys = Array.isArray(body.handleKeys)
            ? body.handleKeys.map((entry) => requireString(entry, "handleKeys[]"))
            : undefined;
          return {
            status: 200,
            body: await evidence.validateAcceptance({
              orderId,
              stageKey,
              wallet,
              signalName: requireString(body.signalName, "signalName"),
              ...(handleKeys !== undefined ? { handleKeys } : {}),
            }),
          };
        }
        return undefined;
      } catch (error) {
        if (error instanceof OrderV3Error) {
          return { status: error.status, body: { error: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } };
        }
        if (error instanceof InvalidPathParameterError) {
          return invalidPathParameterResponse();
        }
        throw error;
      }
    },
  };
}

function createSignalService(context: ApiRouteContext, options: ProductV3SignalsRouteOptions) {
  return createV3SignalService({
    visibility: visibilityFor(context, options),
    loadOrder: (orderId) => context.orderV3Service.loadOrderSnapshotForVisibility(orderId),
    loadPlanCapabilities: options.planCapabilities ?? (async () => undefined),
  });
}

function visibilityFor(context: ApiRouteContext, options: ProductV3SignalsRouteOptions) {
  return createVisibilityResolver({
    loadOrder: (orderId) => context.orderV3Service.loadOrderSnapshotForVisibility(orderId),
    ...(options.operatorWallets !== undefined ? { operatorWallets: options.operatorWallets } : {}),
  });
}

async function requireWallet(request: ApiRequest, context: ApiRouteContext): Promise<Address> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (!access.anchoredAddress) {
    throw new OrderV3Error(401, "wallet_identity_required", "a wallet session is required for V3 endpoints");
  }
  return access.anchoredAddress;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OrderV3Error(400, "invalid_request", "request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrderV3Error(400, "invalid_request", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireHex(value: unknown, field: string): Hex {
  const text = requireString(value, field);
  if (!/^0x[0-9a-fA-F]{64}$/u.test(text)) {
    throw new OrderV3Error(400, "invalid_request", `${field} must be bytes32 hex`);
  }
  return text.toLowerCase() as Hex;
}
