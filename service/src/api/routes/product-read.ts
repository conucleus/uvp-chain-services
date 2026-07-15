import type { ProductOrderDTO } from "@uvp-eth/product-dto";
import type { ProductParticipantAssignmentDTO } from "../../product/bff/types.js";
import {
  ProductOrderLookupError,
  type ProductParticipantIdentityDTO,
  type ProductParticipantViewQuery
} from "../../product/service.js";
import { buildProductApiStagingReadiness } from "../../product/staging-readiness.js";
import { normalizeAddress } from "../../shared/types.js";
import { StorageUnavailableError } from "../../storage/errors.js";
import { cleanQuery, readApiHeader, type ApiRequest, type ApiResponse, type ApiRouteContext } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

type ParsedParticipantViewQuery =
  | { readonly ok: true; readonly query: ProductParticipantViewQuery }
  | { readonly ok: false; readonly response: ApiResponse };

export function createProductReadRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (request.method === "GET" && request.pathname === "/product/staging/readiness") {
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
          const participantQuery = await parseParticipantViewQuery(request, context);
          if (!participantQuery.ok) {
            return participantQuery.response;
          }
          const taskId = decodeURIComponent(participantTaskMatch[1] ?? "");
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
          const participantQuery = await parseParticipantViewQuery(request, context);
          if (!participantQuery.ok) {
            return participantQuery.response;
          }
          const view = await context.productService.getParticipantView(participantQuery.query);
          return {
            status: 200,
            body: { participant: view.participant, tasks: context.productE2eControls.listTasks(view.tasks) }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/me/orders") {
        return withStorageGuard(async () => {
          const participantQuery = await parseParticipantViewQuery(request, context);
          if (!participantQuery.ok) {
            return participantQuery.response;
          }
          const view = await context.productService.getParticipantView(participantQuery.query);
          return {
            status: 200,
            body: { participant: view.participant, orders: context.productE2eControls.listOrders(view.orders) }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/me") {
        return withStorageGuard(async () => {
          const participantQuery = await parseParticipantViewQuery(request, context);
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
                completedTaskCount: view.tasks.filter((task) => task.status === "done" || task.status === "submitted").length
              }
            }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/zhixus") {
        return withStorageGuard(async () => {
          const demoFallbackRequested = isDemoFallbackRequested(request.query);
          if (demoFallbackRequested && !context.productDemoMode) {
            return {
              status: 403,
              body: { error: "demo_mode_disabled" }
            };
          }
          const zhixus = await context.productService.listZhixu();
          return {
            status: 200,
            body: { zhixus: context.productE2eControls.listZhixu(zhixus) }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/orders") {
        return withStorageGuard(async () => {
          const orders = await context.productService.listOrders();
          return {
            status: 200,
            body: { orders: context.productE2eControls.listOrders(orders) }
          };
        });
      }

      const productZhixuMatch = /^\/product\/zhixu(?:s)?\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productZhixuMatch) {
        return withStorageGuard(async () => {
          const zhixuId = decodeURIComponent(productZhixuMatch[1] ?? "");
          const zhixu = context.productE2eControls.getZhixu(zhixuId) ?? await context.productService.getZhixu(zhixuId);
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
          const orderId = decodeURIComponent(productOrderTimelineMatch[1] ?? "");
          const timeline = await context.productService.listOrderTimeline(orderId);
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
          const orderId = decodeURIComponent(productOrderProofMatch[1] ?? "");
          const proof = await context.productService.listOrderProof(orderId);
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
          const orderId = decodeURIComponent(productOrderMatch[1] ?? "");
          let order: ProductOrderDTO | undefined;
          try {
            order = context.productE2eControls.order(await context.productService.getOrder(orderId));
          } catch (error) {
            if (error instanceof ProductOrderLookupError) {
              return {
                status: 409,
                body: {
                  error: error.code,
                  details: error.details
                }
              };
            }
            throw error;
          }
          if (!order) {
            return {
              status: 404,
              body: { error: "product_order_not_found" }
            };
          }
          return {
            status: 200,
            body: { order }
          };
        });
      }

      if (request.method === "GET" && request.pathname === "/product/tasks") {
        return withStorageGuard(async () => {
          const tasks = await context.productService.listTasks(cleanQuery({
            orderId: request.query?.orderId,
            assignee: request.query?.assignee,
            status: request.query?.status
          }));
          return {
            status: 200,
            body: { tasks: context.productE2eControls.listTasks(tasks) }
          };
        });
      }

      const productTaskMatch = /^\/product\/tasks\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productTaskMatch) {
        return withStorageGuard(async () => {
          const taskId = decodeURIComponent(productTaskMatch[1] ?? "");
          const task = context.productE2eControls.task(await context.productService.getTask(taskId));
          if (!task) {
            return {
              status: 404,
              body: { error: "product_task_not_found" }
            };
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
}

async function parseParticipantViewQuery(
  request: ApiRequest,
  context: ApiRouteContext
): Promise<ParsedParticipantViewQuery> {
  const rawWallet = request.query?.wallet ??
    request.query?.walletAddress ??
    readApiHeader(request.headers, "x-uvp-wallet-address") ??
    readApiHeader(request.headers, "x-uvp-session-wallet-address") ??
    readApiHeader(request.headers, "x-wallet-address");
  if (!rawWallet) {
    return { ok: true, query: {} };
  }
  try {
    const walletAddress = normalizeAddress(rawWallet, "wallet");
    const acceptedParticipants = (await context.productBffService.listParticipantAssignments(walletAddress))
      .map(productParticipantIdentityFromAssignment);
    return {
      ok: true,
      query: {
        walletAddress,
        ...(acceptedParticipants.length > 0 ? { acceptedParticipants } : {})
      }
    };
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

function productParticipantIdentityFromAssignment(assignment: ProductParticipantAssignmentDTO): ProductParticipantIdentityDTO {
  const orderId = assignment.trigger?.orderId ?? assignment.draft.triggeredOrderId;
  return {
    participantId: assignment.participant.participantId,
    displayName: assignment.participant.displayName,
    walletAddress: assignment.participant.walletAddress ?? "",
    roleLabel: assignment.participant.roleLabel,
    roleSlotId: assignment.participant.roleSlotId,
    draftId: assignment.draft.draftId,
    draftTitle: assignment.draft.title,
    ...(orderId ? { orderId } : {})
  };
}

function isDemoFallbackRequested(query: ApiRequest["query"]): boolean {
  return query?.fallback === "demo" || query?.demo === "1" || query?.demo === "true";
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
