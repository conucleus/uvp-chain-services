import { createHash, randomUUID } from "node:crypto";
import { adminPrincipalFromHeaders } from "../../governance/index.js";
import { redactErrorMessage, redactSecrets } from "../../security/redaction.js";
import type { ProductSubmissionDTO } from "../../submissions/index.js";
import {
  buildOperatorOpsStatus,
  buildOperatorOpsSummary
} from "../diagnostics.js";
import type { AdminOpsActionEffect, ApiRequest, ApiResponse } from "../route-context.js";
import { readApiHeader } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

type AdminOpsActionName = "reconcile.run" | "projections.rebuild" | "submissions.retry";

interface AdminOpsRequestContext {
  readonly buildDiagnostics: () => Promise<Record<string, unknown>>;
  /** ETH-03：OPS_CONSOLE_ADMIN_IDS 白名单；非空时只放行集合内 admin id。 */
  readonly opsConsoleAdminIds?: readonly string[];
  readonly actions?: {
    runReconcile?(): Promise<AdminOpsActionEffect | void>;
    rebuildProjections?(): Promise<AdminOpsActionEffect | void>;
    retrySubmission?(input: {
      readonly submissionId: string;
      readonly submission?: ProductSubmissionDTO;
    }): Promise<AdminOpsActionEffect | void>;
  };
  readonly submissionStore?: {
    getSubmission(submissionId: string): Promise<ProductSubmissionDTO | undefined>;
  };
  readonly now: () => Date;
}

export function createAdminOpsRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      return handleAdminOpsRequest(request, {
        buildDiagnostics: context.buildDiagnostics,
        ...(context.opsConsoleAdminIds ? { opsConsoleAdminIds: context.opsConsoleAdminIds } : {}),
        ...(context.opsRecoveryActions ? { actions: context.opsRecoveryActions } : {}),
        ...(context.submissionStore ? { submissionStore: context.submissionStore } : {}),
        now: context.now
      });
    }
  };
}

async function handleAdminOpsRequest(
  request: ApiRequest,
  context: AdminOpsRequestContext
): Promise<ApiResponse | undefined> {
  if (!request.pathname.startsWith("/admin/ops")) {
    return undefined;
  }

  const principal = adminPrincipalFromHeaders(request.headers);
  if (!principal) {
    return {
      status: 403,
      body: { error: "forbidden" }
    };
  }
  // ETH-03：OPS_CONSOLE_ADMIN_IDS 只在配置了白名单时生效——配置为非空
  // 集合后，governance reviewer 即使通过通用 admin 鉴权也不在 ops 白名单
  // 内，必须 403；未配置（本地开发）回退既有 governance admin 检查。
  if (context.opsConsoleAdminIds && context.opsConsoleAdminIds.length > 0) {
    const allowList = new Set(context.opsConsoleAdminIds.map((id) => id.trim()).filter(Boolean));
    if (!allowList.has(principal.adminId)) {
      return {
        status: 403,
        body: { error: "forbidden", reason: "ops_console_admin_allowlist" }
      };
    }
  }

  if (request.method === "GET" && request.pathname === "/admin/ops/status") {
    const diagnostics = await context.buildDiagnostics();
    return {
      status: 200,
      body: {
        ok: true,
        ...buildOperatorOpsStatus(diagnostics)
      }
    };
  }

  if (request.method === "GET" && request.pathname === "/admin/ops/summary") {
    const diagnostics = await context.buildDiagnostics();
    const summary = buildOperatorOpsSummary(diagnostics);
    return {
      status: 200,
      body: {
        ok: true,
        filename: `uvp-ops-diagnostics-${summaryTimestamp(context.now())}.json`,
        mimeType: "application/json",
        summary
      }
    };
  }

  if (request.method === "POST" && request.pathname === "/admin/ops/reconcile/run") {
    return runAdminOpsAction(request, context, {
      action: "reconcile.run",
      run: context.actions?.runReconcile
    });
  }

  if (request.method === "POST" && request.pathname === "/admin/ops/projections/rebuild") {
    return runAdminOpsAction(request, context, {
      action: "projections.rebuild",
      run: context.actions?.rebuildProjections
    });
  }

  const retrySubmissionMatch = /^\/admin\/ops\/submissions\/([^/]+)\/retry$/.exec(request.pathname);
  if (request.method === "POST" && retrySubmissionMatch) {
    const submissionId = decodeURIComponent(retrySubmissionMatch[1] ?? "").trim();
    if (!submissionId) {
      return {
        status: 400,
        body: { error: "invalid_submission_id" }
      };
    }

    let submission: ProductSubmissionDTO | undefined;
    if (context.submissionStore) {
      submission = await context.submissionStore.getSubmission(submissionId);
      if (!submission) {
        return {
          status: 404,
          body: { error: "submission_not_found" }
        };
      }
      if (!submission.retryable) {
        return {
          status: 409,
          body: {
            error: "submission_not_retryable",
            submissionId,
            retryState: submission.retryState
          }
        };
      }
    }

    return runAdminOpsAction(request, context, {
      action: "submissions.retry",
      targetId: submissionId,
      run: context.actions?.retrySubmission
        ? () => context.actions!.retrySubmission!({
            submissionId,
            ...(submission ? { submission } : {})
          })
        : undefined
    });
  }

  return {
    status: 404,
    body: { error: "not_found" }
  };
}

async function runAdminOpsAction(
  request: ApiRequest,
  context: AdminOpsRequestContext,
  input: {
    readonly action: AdminOpsActionName;
    readonly targetId?: string;
    readonly run: (() => Promise<AdminOpsActionEffect | void>) | undefined;
  }
): Promise<ApiResponse> {
  const requestId = requestIdFromApiHeaders(request.headers);
  const actionId = actionIdFor(input.action, requestId, input.targetId);
  const diagnostics = await context.buildDiagnostics();

  if (preflightStatus(diagnostics) === "failed") {
    return {
      status: 503,
      body: rejectedOpsActionBody({
        requestId,
        actionId,
        action: input.action,
        targetId: input.targetId,
        error: "preflight_failed"
      })
    };
  }

  if (!input.run) {
    return {
      status: 503,
      body: rejectedOpsActionBody({
        requestId,
        actionId,
        action: input.action,
        targetId: input.targetId,
        error: "ops_dependency_unavailable"
      })
    };
  }

  try {
    const effect = await input.run();
    return {
      status: 202,
      body: redactSecrets({
        ok: true,
        requestId,
        actionId,
        action: input.action,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        status: effect?.status ?? "accepted",
        nextCheckAt: effect?.nextCheckAt ?? nextCheckAt(context.now()),
        sourceOfTruth: "contracts-and-chain-events",
        recoveryBoundary: {
          nonAuthoritative: true,
          businessSignaturesCreated: false,
          chainStateForged: false
        },
        ...(effect?.summary !== undefined ? { summary: effect.summary } : {})
      })
    };
  } catch (error) {
    return {
      status: 500,
      body: redactSecrets({
        ok: false,
        requestId,
        actionId,
        action: input.action,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        status: "failed",
        error: "ops_action_failed",
        message: redactErrorMessage(error),
        sourceOfTruth: "contracts-and-chain-events"
      })
    };
  }
}

function rejectedOpsActionBody(input: {
  readonly requestId: string;
  readonly actionId: string;
  readonly action: AdminOpsActionName;
  readonly targetId: string | undefined;
  readonly error: "preflight_failed" | "ops_dependency_unavailable";
}): Record<string, unknown> {
  return redactSecrets({
    ok: false,
    requestId: input.requestId,
    actionId: input.actionId,
    action: input.action,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    status: "rejected",
    error: input.error,
    sourceOfTruth: "contracts-and-chain-events",
    recoveryBoundary: {
      nonAuthoritative: true,
      businessSignaturesCreated: false,
      chainStateForged: false
    }
  });
}

function requestIdFromApiHeaders(headers: ApiRequest["headers"]): string {
  const explicit = normalizeRequestId(readApiHeader(headers, "x-request-id")) ??
    normalizeRequestId(readApiHeader(headers, "x-uvp-request-id"));
  return explicit ?? `req_${randomUUID()}`;
}

function normalizeRequestId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function actionIdFor(action: AdminOpsActionName, requestId: string, targetId: string | undefined): string {
  const digest = createHash("sha256")
    .update([action, requestId, targetId ?? ""].join("|"))
    .digest("hex")
    .slice(0, 20);
  return `ops_${digest}`;
}

function preflightStatus(diagnostics: Record<string, unknown>): string | undefined {
  const preflight = diagnostics.preflight;
  if (!preflight || typeof preflight !== "object" || Array.isArray(preflight)) {
    return undefined;
  }
  const status = (preflight as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function nextCheckAt(now: Date): string {
  return new Date(now.getTime() + 15_000).toISOString();
}

function summaryTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}
