// V3 订单读路由（可见性裁剪）：order/stage、stage escrow/binding、
// settlement instructions、fileResources 句柄、operator 最小视图。身份只认
// 会话锚定钱包；所有读先过 `src/visibility` 唯一 resolver，路由不做局部放行。

import type { Address } from "../../shared/types.js";
import type { ResourceResolverPort } from "../../visibility/types.js";
import {
  createVisibilityResolver,
  projectBinding,
  projectEscrowBinding,
  projectInstructions,
  projectOperatorOrder,
  projectOrder,
  projectResources,
  projectStage,
} from "../../visibility/index.js";
import type { BindingDataState } from "../../binding/types.js";
import { OrderV3Error } from "../../order/v3/index.js";
import {
  decodePathParameter,
  InvalidPathParameterError,
  invalidPathParameterResponse,
  type ApiResponse,
  type ApiRequest,
  type ApiRouteContext,
} from "../route-context.js";
import type { RouteModule } from "../route-module.js";

const ORDER_PATH = /^\/product\/v3\/orders\/([^/]+)$/;
const STAGE_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)$/;
const STAGE_ESCROW_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/escrow$/;
const STAGE_INSTRUCTIONS_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/instructions$/;
const STAGE_BINDING_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/binding$/;
const STAGE_RESOURCES_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/resources$/;
const STAGE_RESOURCE_PATH = /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/resources\/(.+)$/;
const OPS_ORDER_PATH = /^\/product\/v3\/ops\/orders\/([^/]+)$/;

export interface RuntimeWorkerPort {
  runOnce(): Promise<unknown>;
}

export interface RuntimeSeederPort {
  seed(orderId: string): Promise<number>;
}

export interface ProductReadV3RouteOptions {
  readonly operatorWallets?: readonly Address[];
  readonly resourceResolver?: ResourceResolverPort;
  readonly runtimeWorker?: RuntimeWorkerPort;
  readonly runtimeSeeder?: RuntimeSeederPort;
}

export function createProductReadV3RouteModule(
  options: ProductReadV3RouteOptions = {},
): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/product/v3/")) {
        return undefined;
      }
      if (request.method === "POST") {
        const seeded = /^\/product\/v3\/ops\/runtime\/seed\/([^/]+)$/.exec(request.pathname);
        if (seeded) {
          const wallet = await requireWallet(request, context);
          void wallet;
          if (!options.runtimeSeeder) {
            return { status: 503, body: { error: "runtime_seeder_unavailable", retryable: false } };
          }
          const orderId = decodePathParameter(seeded[1] ?? "");
          return { status: 200, body: { seeded: await options.runtimeSeeder.seed(orderId) } };
        }
        if (request.pathname === "/product/v3/ops/runtime/tick") {
          const wallet = await requireWallet(request, context);
          void wallet;
          if (!options.runtimeWorker) {
            return { status: 503, body: { error: "runtime_worker_unavailable", retryable: false } };
          }
          return { status: 200, body: await options.runtimeWorker.runOnce() };
        }
        return undefined;
      }
      if (request.method !== "GET") {
        return undefined;
      }
      try {
        return await handleRead(request, context, options);
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

async function handleRead(
  request: ApiRequest,
  context: ApiRouteContext,
  options: ProductReadV3RouteOptions,
): Promise<ApiResponse | undefined> {
  const ops = OPS_ORDER_PATH.exec(request.pathname);
  if (ops) {
    const wallet = await requireWallet(request, context);
    const orderId = decodePathParameter(ops[1] ?? "");
    const resolver = resolverFor(context, options);
    const decision = await resolver.resolveVisibility(orderId, undefined, wallet);
    if (decision.scope !== "operator") {
      throw new OrderV3Error(404, "order_not_found", "order was not found");
    }
    const snapshot = await loadSnapshot(context, orderId);
    return { status: 200, body: projectOperatorOrder(decision, snapshot) };
  }

  const escrow = STAGE_ESCROW_PATH.exec(request.pathname);
  if (escrow) {
    const wallet = await requireWallet(request, context);
    const orderId = decodePathParameter(escrow[1] ?? "");
    const stageKey = decodePathParameter(escrow[2] ?? "");
    const decision = await resolverFor(context, options).resolveVisibility(orderId, stageKey, wallet);
    const snapshot = await loadSnapshot(context, orderId);
    const stage = stageOf(snapshot, stageKey);
    const projection = await loadBindingProjection(context, orderId, stage.stageId);
    return {
      status: 200,
      body: projectEscrowBinding(
        decision,
        stageKey,
        projection.binding,
        projection.dataState,
        ...(projection.reason !== undefined ? [projection.reason] : []),
      ),
    };
  }

  const binding = STAGE_BINDING_PATH.exec(request.pathname);
  if (binding) {
    const wallet = await requireWallet(request, context);
    const orderId = decodePathParameter(binding[1] ?? "");
    const stageKey = decodePathParameter(binding[2] ?? "");
    const decision = await resolverFor(context, options).resolveVisibility(orderId, stageKey, wallet);
    const snapshot = await loadSnapshot(context, orderId);
    return { status: 200, body: projectBinding(decision, snapshot, stageOf(snapshot, stageKey)) };
  }

  const instructions = STAGE_INSTRUCTIONS_PATH.exec(request.pathname);
  if (instructions) {
    const wallet = await requireWallet(request, context);
    const orderId = decodePathParameter(instructions[1] ?? "");
    const stageKey = decodePathParameter(instructions[2] ?? "");
    const decision = await resolverFor(context, options).resolveVisibility(orderId, stageKey, wallet);
    if (!context.settlementStore) {
      return {
        status: 200,
        body: projectInstructions(decision, stageKey, [], "unknown", "settlement_store_unavailable"),
      };
    }
    const snapshot = await loadSnapshot(context, orderId);
    const stage = stageOf(snapshot, stageKey);
    const projection = await loadBindingProjection(context, orderId, stage.stageId);
    const rows = (await context.settlementStore.listByOrder(orderId, 200))
      .filter((row) => row.stageKey === stageKey || row.stageId === stage.stageId);
    const dataState = rows.length > 0
      ? "ok"
      : projection.dataState === "pending"
        ? "pending"
        : projection.dataState === "unknown"
          ? "unknown"
          : "none";
    return {
      status: 200,
      body: projectInstructions(
        decision,
        stageKey,
        rows,
        dataState,
        ...(dataState === "unknown" && projection.reason !== undefined ? [projection.reason] : []),
      ),
    };
  }

  const resource = STAGE_RESOURCE_PATH.exec(request.pathname);
  if (resource) {
    const wallet = await requireWallet(request, context);
    const orderId = decodePathParameter(resource[1] ?? "");
    const stageKey = decodePathParameter(resource[2] ?? "");
    const handleKey = decodePathParameter(resource[3] ?? "");
    const decision = await resolverFor(context, options).resolveVisibility(orderId, stageKey, wallet);
    if (decision.scope === "operator" || !decision.allowed.evidenceHandles) {
      throw new OrderV3Error(403, "visibility_denied", "the current scope cannot read stage file handles", {
        resource: "file_resources",
        stageKey,
      });
    }
    const snapshot = await loadSnapshot(context, orderId);
    const stageConfig = snapshot.config.stages.find((stage) => stage.key === stageKey);
    const declared = (stageConfig?.fileResources ?? []).some((entry) =>
      typeof entry === "string" ? entry === handleKey : (entry.name ?? entry.ref) === handleKey,
    );
    if (!declared) {
      throw new OrderV3Error(404, "handle_not_found", "file handle was not found on this stage");
    }
    if (!options.resourceResolver) {
      throw new OrderV3Error(503, "resolver_unavailable", "file resource resolver is not configured", {
        retryable: false,
      });
    }
    let resolution;
    try {
      resolution = await options.resourceResolver.resolve({ orderId, stageKey, handleKey, wallet });
    } catch (error) {
      throw new OrderV3Error(503, "resource_unavailable", `file resource resolver failed: ${messageOf(error)}`, {
        retryable: true,
      });
    }
    switch (resolution.kind) {
      case "ok":
        return { status: 200, body: { dataState: "ok", stageKey, handleKey, ...(resolution.contentHash !== undefined ? { contentHash: resolution.contentHash } : {}) } };
      case "empty":
        return { status: 200, body: { dataState: "none", stageKey, handleKey } };
      case "not_found":
        throw new OrderV3Error(404, "handle_not_found", "file handle was not found");
      case "forbidden":
        throw new OrderV3Error(403, "resource_forbidden", "the current scope cannot resolve this file handle");
      case "resolve_failed":
        throw new OrderV3Error(502, "resource_parse_failed", "file handle could not be parsed", {
          ...(resolution.message !== undefined ? { detail: resolution.message } : {}),
        });
      case "unavailable":
        throw new OrderV3Error(503, "resource_unavailable", "file resource resolver is unavailable", {
          retryable: true,
          ...(resolution.message !== undefined ? { detail: resolution.message } : {}),
        });
    }
  }

  const resources = STAGE_RESOURCES_PATH.exec(request.pathname);
  if (resources) {
    const wallet = await requireWallet(request, context);
    const orderId = decodePathParameter(resources[1] ?? "");
    const stageKey = decodePathParameter(resources[2] ?? "");
    const decision = await resolverFor(context, options).resolveVisibility(orderId, stageKey, wallet);
    const snapshot = await loadSnapshot(context, orderId);
    const stageConfig = snapshot.config.stages.find((stage) => stage.key === stageKey);
    return { status: 200, body: projectResources(decision, stageKey, stageConfig) };
  }

  const stageMatch = STAGE_PATH.exec(request.pathname);
  if (stageMatch) {
    const wallet = await requireWallet(request, context);
    const orderId = decodePathParameter(stageMatch[1] ?? "");
    const stageKey = decodePathParameter(stageMatch[2] ?? "");
    const decision = await resolverFor(context, options).resolveVisibility(orderId, stageKey, wallet);
    const snapshot = await loadSnapshot(context, orderId);
    return { status: 200, body: projectStage(decision, snapshot, stageOf(snapshot, stageKey)) };
  }

  const orderMatch = ORDER_PATH.exec(request.pathname);
  if (orderMatch) {
    const wallet = await requireWallet(request, context);
    const orderId = decodePathParameter(orderMatch[1] ?? "");
    const decision = await resolverFor(context, options).resolveVisibility(orderId, undefined, wallet);
    const snapshot = await loadSnapshot(context, orderId);
    return { status: 200, body: projectOrder(decision, snapshot) };
  }
  return undefined;
}

async function loadBindingProjection(
  context: ApiRouteContext,
  orderId: string,
  stageId: string,
): Promise<{
  readonly dataState: BindingDataState;
  readonly binding?: Awaited<ReturnType<NonNullable<ApiRouteContext["bindingStore"]>["findCanonicalBindingByStage"]>>;
  readonly reason?: string;
}> {
  const store = context.bindingStore;
  if (!store) {
    throw new OrderV3Error(503, "escrow_unavailable", "V3 binding store is not configured", {
      retryable: false,
    });
  }
  const instances = (await store.listEscrowInstances()).filter(
    (instance) => instance.status === "active" && instance.contractVersion === "v3",
  );
  if (instances.length === 0) {
    return { dataState: "unknown", reason: "escrow_instance_unregistered" };
  }
  let pending = false;
  for (const instance of instances) {
    const cursor = await store.getCursor(instance.chainId, instance.escrowAddress);
    if (!cursor) {
      pending = true;
      continue;
    }
    const binding = await store.findCanonicalBindingByStage(
      instance.chainId,
      instance.escrowAddress,
      orderId,
      stageId,
    );
    if (binding) {
      return { dataState: "ok", binding };
    }
  }
  return pending
    ? { dataState: "pending", reason: "projection_not_ready" }
    : { dataState: "none" };
}

function resolverFor(context: ApiRouteContext, options: ProductReadV3RouteOptions) {
  return createVisibilityResolver({
    loadOrder: (orderId) => context.orderV3Service.loadOrderSnapshotForVisibility(orderId),
    ...(options.operatorWallets !== undefined ? { operatorWallets: options.operatorWallets } : {}),
  });
}

async function loadSnapshot(context: ApiRouteContext, orderId: string) {
  return context.orderV3Service.loadOrderSnapshotForVisibility(orderId);
}

function stageOf(snapshot: Awaited<ReturnType<typeof loadSnapshot>>, stageKey: string) {
  const stage = snapshot.stages.find((candidate) => candidate.stageKey === stageKey);
  if (!stage) {
    throw new OrderV3Error(404, "stage_not_found", "stage was not found on this order");
  }
  return stage;
}

async function requireWallet(request: ApiRequest, context: ApiRouteContext): Promise<Address> {
  const access = await context.storeIdentityProvider.resolve(request.headers);
  if (!access.anchoredAddress) {
    throw new OrderV3Error(401, "wallet_identity_required", "a wallet session is required for V3 order endpoints");
  }
  return access.anchoredAddress;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
