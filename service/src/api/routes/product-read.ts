import type { ProductParticipantAssignmentDTO } from "../../product/bff/types.js";
import { adminPrincipalFromHeaders } from "../../governance/index.js";
import type { ProductOrderApiDTO } from "../../product/service.js";
import {
  ProductOrderLookupError,
  type ProductParticipantIdentityDTO,
  type ProductParticipantViewQuery
} from "../../product/service.js";
import { buildProductApiStagingReadiness } from "../../product/staging-readiness.js";
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
        // 部署就绪探针倾倒运营细节（部署清单、角色输入姿态、样本任务
        // 的 assigneeWallet）——与 /admin/diagnostics 同门：治理 admin
        // 凭据才可读；公共聚合健康位走 /healthz、/readyz。
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
                // ORDER-FE 口径:submitted 是链上确认中,不算已完成;仅 done 计入。
                completedTaskCount: view.tasks.filter((task) => task.status === "done").length
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
          // 订单 DTO 内嵌全部任务（assigneeWallet/proofRows 等参与者数据），
          // 匿名不可枚举——与任务读同口径身份门：身份取会话锚定钱包；
          // 已有指派参与者的订单只有参与者本人可见，无指派（纯链上
          // 事实）订单对已认证参与者开放。
          const wallet = await resolveParticipantWalletIdentity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const walletAddress = wallet.identity.walletAddress.toLowerCase();
          const acceptedOrderIds = await acceptedParticipantOrderIds(context, wallet.identity.walletAddress);
          const orders = (await context.productService.listOrders())
            .filter((order) => orderVisibleToParticipant(order, walletAddress, acceptedOrderIds));
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
          // 时间线与订单详情同口径参与者门：事件载荷携带信号提交者等
          // 参与者数据，匿名/非参与者不可读；不可见与"不存在"同响应
          //（404），不泄露存在性。
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
          // 证明行与订单详情同口径参与者门：proof 披露每步链上事件的
          // 参与者钱包与签名细节，匿名/非参与者不可读（404 不泄露存在性）。
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
          // 订单详情与列表同口径：内嵌任务携带 assigneeWallet/proofRows，
          // 已指派给他人的订单对非参与者不得区分"不存在"（404）。
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
          // 任务 DTO 携带 assigneeWallet/proofRows 等参与者数据，匿名不可
          // 枚举：身份取会话锚定钱包；已指派任务只有受理人本人可见，
          // 未指派任务随其订单走参与者判定（与订单读同口径），无关钱包
          // 不可见。
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
          const acceptedOrderIds = await acceptedParticipantOrderIds(context, wallet.identity.walletAddress);
          const orders = await context.productService.listOrders();
          const visibleOrderIds = new Set(
            orders
              .filter((order) => orderVisibleToParticipant(order, walletAddress.toLowerCase(), acceptedOrderIds))
              .map((order) => order.orderId?.toLowerCase())
              .filter((orderId): orderId is string => Boolean(orderId))
          );
          const tasks = (await context.productService.listTasks(cleanQuery({
            orderId: request.query?.orderId,
            status: request.query?.status
          }))).filter((task) =>
            task.assigneeWallet
              ? task.assigneeWallet.toLowerCase() === walletAddress.toLowerCase()
              : visibleOrderIds.has(task.orderId.toLowerCase())
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
          // 任务详情（assigneeWallet/proofRows）要求已认证参与者：已指派
          // 任务仅受理人本人可读；未指派任务随订单走参与者判定，不可见
          // 与"不存在"同响应（404），不泄露存在性。
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
              // 订单身份无法唯一定位时参与者判定无从建立，按不可见收口。
              return taskNotFound();
            }
            throw error;
          }
          if (!order || !orderVisibleToParticipant(
            order,
            walletAddress,
            await acceptedParticipantOrderIds(context, wallet.identity.walletAddress)
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

/**
 * Product reads are projections of chain events. When the indexer marked the
 * projection degraded (background refresh failed), every successful read
 * response carries a meta.projectionSync marker so callers can see the
 * projection may lag or be incomplete instead of silently trusting it.
 */
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
  // /product/me* 的身份 = 会话锚定地址（钱包会话
  // 签名证明或 local dev 锚定头）。自报 query/header 钱包只做一致性核验
  //（不一致即 403），不是身份来源——否则 ?wallet= 可读任意人任务与
  // 订单视图。local 之外无会话即 401。
  const wallet = await resolveParticipantWalletIdentity(request, context, runtimeEnvironment);
  if (!wallet.ok) {
    return { ok: false, response: wallet.response };
  }
  const walletAddress = wallet.identity.walletAddress;
  try {
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

/**
 * 已接受参与（草稿 accept 带来的订单归属）——/product/me/orders 与
 * /product/orders(:id) 共用同一判据：受邀并 accept 的钱包在链上指派
 * 落定前就该看到订单，列表与详情不得一边可见一边 404。
 */
async function acceptedParticipantOrderIds(
  context: Parameters<RouteModule["handle"]>[1],
  walletAddress: string
): Promise<Set<string>> {
  const assignments = await context.productBffService.listParticipantAssignments(walletAddress);
  return new Set(assignments.flatMap((assignment) => {
    const orderId = assignment.trigger?.orderId ?? assignment.draft.triggeredOrderId;
    return orderId ? [orderId.toLowerCase()] : [];
  }));
}

/**
 * 订单读取的参与者门（订单详情与 timeline/proof 共用）：订单身份无法
 * 唯一定位时透传 409（歧义是调用方可修正的请求错误）；不可见与
 * "不存在"同响应（404），不泄露存在性。
 */
async function resolveOrderVisibility(
  context: Parameters<RouteModule["handle"]>[1],
  orderId: string,
  walletAddress: string
): Promise<
  | { readonly order: ProductOrderApiDTO }
  | { readonly response: ApiResponse }
> {
  let order: ProductOrderApiDTO | undefined;
  try {
    order = await context.productService.getOrder(orderId);
  } catch (error) {
    if (error instanceof ProductOrderLookupError) {
      return {
        response: {
          status: 409,
          body: { error: error.code, details: error.details }
        }
      };
    }
    throw error;
  }
  if (!order || !orderVisibleToParticipant(
    order,
    walletAddress.toLowerCase(),
    await acceptedParticipantOrderIds(context, walletAddress)
  )) {
    return {
      response: {
        status: 404,
        body: { error: "product_order_not_found" }
      }
    };
  }
  return { order };
}

/**
 * 订单读可见性（与任务读同口径）：订单 DTO 内嵌全部任务，任务的
 * assigneeWallet/执行者 overlay 是参与者数据。无任何指派钱包的订单
 * 是纯链上事实（同"未指派任务"），对已认证参与者开放；有指派钱包
 * 的订单只有参与者本人（链上指派、订单创建者或已接受参与的订单归属）
 * 可见——创建者无任务指派时同样是订单参与者，读不到自己建的单与
 * 上述口径相悖。
 */
function orderVisibleToParticipant(
  order: ProductOrderApiDTO,
  walletAddress: string,
  acceptedOrderIds: ReadonlySet<string>
): boolean {
  const participants = new Set<string>();
  for (const task of order.tasks ?? []) {
    if (task.assigneeWallet) {
      participants.add(task.assigneeWallet.toLowerCase());
    }
    const overlayWallet = task.stageExecutorOverlay?.activeExecutorWallet;
    if (overlayWallet) {
      participants.add(overlayWallet.toLowerCase());
    }
  }
  for (const overlay of Object.values(order.stageExecutorOverlays ?? {})) {
    participants.add(overlay.activeExecutorWallet.toLowerCase());
  }
  for (const overlay of Object.values(order.executorOverlays ?? {})) {
    if (overlay.activeExecutorWallet) {
      participants.add(overlay.activeExecutorWallet.toLowerCase());
    }
  }
  if (order.creatorWallet) {
    participants.add(order.creatorWallet.toLowerCase());
  }
  return participants.size === 0 ||
    participants.has(walletAddress) ||
    (order.orderId ? acceptedOrderIds.has(order.orderId.toLowerCase()) : false);
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
