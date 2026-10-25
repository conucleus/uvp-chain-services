import type { ProductParticipantAssignmentDTO } from "../../product/query/bff/types.js";
import { adminPrincipalFromHeaders } from "../../governance/index.js";
import type { ProductOrderApiDTO } from "../../product/application/service.js";
import {
  ProductOrderLookupError,
  type ProductParticipantIdentityDTO,
  type ProductParticipantViewQuery
} from "../../product/application/service.js";
import {
  acceptedParticipantOrderKeys,
  orderTaskVisibilityKey,
  orderVisibleToParticipant,
  resolveOrderVisibility
} from "../product-order-visibility.js";
import { buildProductApiStagingReadiness } from "../../product/query/staging-readiness.js";
import { redactErrorMessage } from "../../security/redaction.js";
import type { ProjectionSyncState } from "../../storage/projection-store.js";
import { StorageUnavailableError } from "../../storage/errors.js";
import { cleanQuery, decodePathParameter, InvalidPathParameterError, invalidPathParameterResponse, type ApiRequest, type ApiResponse, type ApiRouteContext } from "../route-context.js";
import { resolveParticipantWalletIdentity } from "../participant-identity.js";
import type { RouteModule } from "../route-module.js";

type ParsedParticipantViewQuery =
  | { readonly ok: true; readonly query: ProductParticipantViewQuery }
  | { readonly ok: false; readonly response: ApiResponse };

export function createProductReadRouteModule(options: {
  readonly runtimeEnvironment?: Parameters<typeof resolveParticipantWalletIdentity>[2];
} = {}): RouteModule {
  const routeModule: RouteModule = {
    async handle(request, context) {
      if (request.method === "GET" && request.pathname === "/product/staging/readiness") {
        const principal = adminPrincipalFromHeaders(request.headers, context.governanceAdminPolicy);
        if (!principal) {
          return {
            status: 403,
            body: { error: "forbidden" }
          };
        }
        return withStorageGuard(async () => {
          const diagnostics = await context.buildDiagnostics();
          const summary = await buildProductApiStagingReadiness({
            productService: context.productService,
            store: context.store,
            diagnostics,
            now: context.now
          });
          return {
            status: summary.ready ? 200 : 503,
            body: {
              ok: summary.ready,
              ...summary
            }
          };
        });
      }

      const participantTaskMatch = /^\/product\/me\/tasks\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && participantTaskMatch) {
        return withStorageGuard(async () => {
          const participantQuery = await parseParticipantViewQuery(request, context, options.runtimeEnvironment);
          if (!participantQuery.ok) {
            return participantQuery.response;
          }
          const taskId = decodePathParameter(participantTaskMatch[1] ?? "");
          const view = await context.productService.getParticipantView(participantQuery.query);
          const task = view.tasks.find((item) => item.taskId === taskId);
          if (!task) {
            return {
              status: 404,
              body: { error: "participant_task_not_found" }
            };
          }
          return {
            status: 200,
            body: { participant: view.participant, task }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/me/tasks") {
        return withStorageGuard(async () => {
          const participantQuery = await parseParticipantViewQuery(request, context, options.runtimeEnvironment);
          if (!participantQuery.ok) {
            return participantQuery.response;
          }
          const view = await context.productService.getParticipantView(participantQuery.query);
          return {
            status: 200,
            body: { participant: view.participant, tasks: view.tasks }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/me/orders") {
        return withStorageGuard(async () => {
          const participantQuery = await parseParticipantViewQuery(request, context, options.runtimeEnvironment);
          if (!participantQuery.ok) {
            return participantQuery.response;
          }
          const view = await context.productService.getParticipantView(participantQuery.query);
          return {
            status: 200,
            body: { participant: view.participant, orders: view.orders }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/me") {
        return withStorageGuard(async () => {
          const participantQuery = await parseParticipantViewQuery(request, context, options.runtimeEnvironment);
          if (!participantQuery.ok) {
            return participantQuery.response;
          }
          const view = await context.productService.getParticipantView(participantQuery.query);
          return {
            status: 200,
            body: {
              participant: view.participant,
              summary: {
                orderCount: view.orders.length,
                openTaskCount: view.tasks.filter((task) => task.status === "open").length,
                blockedTaskCount: view.tasks.filter((task) => task.status === "blocked").length,
                completedTaskCount: view.tasks.filter((task) => task.status === "submitted").length
              }
            }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/zhixus") {
        return withStorageGuard(async () => {
          const zhixus = await context.productService.listZhixu();
          return {
            status: 200,
            body: { zhixus }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/orders") {
        return withStorageGuard(async () => {
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const walletAddress = wallet.identity.walletAddress.toLowerCase();
          const acceptedOrderKeys = await acceptedParticipantOrderKeys(context, wallet.identity.walletAddress);
          const orders = (await context.productService.listOrders())
            .filter((order) => orderVisibleToParticipant(order, walletAddress, acceptedOrderKeys));
          return {
            status: 200,
            body: { orders }
          };
        });
      }

      const productZhixuMatch = /^\/product\/zhixu(?:s)?\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productZhixuMatch) {
        return withStorageGuard(async () => {
          const zhixuId = decodePathParameter(productZhixuMatch[1] ?? "");
          const zhixu = await context.productService.getZhixu(zhixuId);
          if (!zhixu) {
            return {
              status: 404,
              body: { error: "zhixu_not_found" }
            };
          }
          return {
            status: 200,
            body: { zhixu }
          };
        });
      }

      const productOrderTimelineMatch = /^\/product\/orders\/([^/]+)\/timeline$/.exec(request.pathname);
      if (request.method === "GET" && productOrderTimelineMatch) {
        return withStorageGuard(async () => {
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const orderId = decodePathParameter(productOrderTimelineMatch[1] ?? "");
          const visibility = await resolveOrderVisibility(context, orderId, wallet.identity.walletAddress);
          if ("response" in visibility) {
            return visibility.response;
          }
          let timeline;
          try {
            timeline = await context.productService.listOrderTimeline(orderId);
          } catch (error) {
            if (error instanceof ProductOrderLookupError) {
              return {
                status: 409,
                body: { error: error.code, details: error.details }
              };
            }
            throw error;
          }
          if (!timeline) {
            return {
              status: 404,
              body: { error: "product_order_not_found" }
            };
          }
          return {
            status: 200,
            body: { timeline }
          };
        });
      }

      const productOrderProofMatch = /^\/product\/orders\/([^/]+)\/proof$/.exec(request.pathname);
      if (request.method === "GET" && productOrderProofMatch) {
        return withStorageGuard(async () => {
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const orderId = decodePathParameter(productOrderProofMatch[1] ?? "");
          const visibility = await resolveOrderVisibility(context, orderId, wallet.identity.walletAddress);
          if ("response" in visibility) {
            return visibility.response;
          }
          let proof;
          try {
            proof = await context.productService.listOrderProof(orderId);
          } catch (error) {
            if (error instanceof ProductOrderLookupError) {
              return {
                status: 409,
                body: { error: error.code, details: error.details }
              };
            }
            throw error;
          }
          if (!proof) {
            return {
              status: 404,
              body: { error: "product_order_not_found" }
            };
          }
          return {
            status: 200,
            body: { proof }
          };
        });
      }

      const productOrderMatch = /^\/product\/orders\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productOrderMatch) {
        return withStorageGuard(async () => {
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const orderId = decodePathParameter(productOrderMatch[1] ?? "");
          const visibility = await resolveOrderVisibility(context, orderId, wallet.identity.walletAddress);
          if ("response" in visibility) {
            return visibility.response;
          }
          return {
            status: 200,
            body: { order: visibility.order }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/tasks") {
        return withStorageGuard(async () => {
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const walletAddress = wallet.identity.walletAddress;
          if (request.query?.assignee && request.query.assignee.toLowerCase() !== walletAddress.toLowerCase()) {
            return {
              status: 403,
              body: { error: "forbidden", message: "assignee filter must match the session-anchored wallet" }
            };
          }
          const acceptedOrderKeys = await acceptedParticipantOrderKeys(context, wallet.identity.walletAddress);
          const orders = await context.productService.listOrders();
          const visibleOrderKeys = new Set(
            orders
              .filter((order) => orderVisibleToParticipant(order, walletAddress.toLowerCase(), acceptedOrderKeys))
              .map((order) => orderTaskVisibilityKey(order.planId, order.orderId))
              .filter((key): key is string => Boolean(key))
          );
          const tasks = (await context.productService.listTasks(cleanQuery({
            orderId: request.query?.orderId,
            status: request.query?.status
          }))).filter((task) =>
            task.assigneeWallet
              ? task.assigneeWallet.toLowerCase() === walletAddress.toLowerCase()
              : visibleOrderKeys.has(orderTaskVisibilityKey(task.planId, task.orderId) ?? "")
          );
          return {
            status: 200,
            body: { tasks }
          };
        });
      }

      const productTaskMatch = /^\/product\/tasks\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productTaskMatch) {
        return withStorageGuard(async () => {
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const taskId = decodePathParameter(productTaskMatch[1] ?? "");
          const task = await context.productService.getTask(taskId);
          if (!task) {
            return taskNotFound();
          }
          const walletAddress = wallet.identity.walletAddress.toLowerCase();
          if (task.assigneeWallet) {
            if (task.assigneeWallet.toLowerCase() !== walletAddress) {
              return taskNotFound();
            }
            return {
              status: 200,
              body: { task }
            };
          }
          let order: ProductOrderApiDTO | undefined;
          try {
            order = await context.productService.getOrder(task.orderId);
          } catch (error) {
            if (error instanceof ProductOrderLookupError) {
              return taskNotFound();
            }
            throw error;
          }
          if (!order || !orderVisibleToParticipant(
            order,
            walletAddress,
            await acceptedParticipantOrderKeys(context, wallet.identity.walletAddress)
          )) {
            return taskNotFound();
          }
          return {
            status: 200,
            body: { task }
          };
        });
      }

      return undefined;
    }
  };
  return withProjectionDegradationMeta(routeModule);
}

function withProjectionDegradationMeta(module: RouteModule): RouteModule {
  return {
    async handle(request, context) {
      const response = await module.handle(request, context);
      if (!response || response.status !== 200 || !isJsonRecord(response.body)) {
        return response;
      }
      let syncState: ProjectionSyncState | undefined;
      try {
        syncState = await context.store.getSyncState();
      } catch {
        return response;
      }
      if (syncState?.syncStatus !== "degraded") {
        return response;
      }
      return {
        ...response,
        body: {
          ...response.body,
          meta: {
            projectionSync: {
              status: "degraded",
              ...(syncState.degradedReason ? { reason: redactErrorMessage(syncState.degradedReason) } : {})
            }
          }
        }
      };
    }
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseParticipantViewQuery(
  request: ApiRequest,
  context: ApiRouteContext,
  runtimeEnvironment?: Parameters<typeof resolveParticipantWalletIdentity>[2]
): Promise<ParsedParticipantViewQuery> {
  const wallet = await resolveParticipantWalletIdentity(request, context, runtimeEnvironment);
  if (!wallet.ok) {
    return { ok: false, response: wallet.response };
  }
  const walletAddress = wallet.identity.walletAddress;
  const acceptedParticipants = (await context.productBffService.listParticipantAssignments(walletAddress))
    .map(productParticipantIdentityFromAssignment);
  return {
    ok: true,
    query: {
      walletAddress,
      ...(acceptedParticipants.length > 0 ? { acceptedParticipants } : {})
    }
  };
}

function productParticipantIdentityFromAssignment(assignment: ProductParticipantAssignmentDTO): ProductParticipantIdentityDTO {
  const orderId = assignment.trigger?.orderId ?? assignment.draft.triggeredOrderId;
  const planId = assignment.trigger?.planId ?? assignment.draft.planId;
  return {
    participantId: assignment.participant.participantId,
    displayName: assignment.participant.displayName,
    walletAddress: assignment.participant.walletAddress ?? "",
    roleLabel: assignment.participant.roleLabel,
    roleSlotId: assignment.participant.roleSlotId,
    draftId: assignment.draft.draftId,
    draftTitle: assignment.draft.title,
    ...(orderId ? { orderId } : {}),
    ...(planId ? { planId } : {})
  };
}

function taskNotFound(): ApiResponse {
  return {
    status: 404,
    body: { error: "product_task_not_found" }
  };
}

async function withStorageGuard(action: () => Promise<ApiResponse>): Promise<ApiResponse> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof InvalidPathParameterError) {
      return invalidPathParameterResponse();
    }
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
