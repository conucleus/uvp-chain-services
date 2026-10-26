import type { ProjectionStore } from "../storage/projection-store.js";
import { noopAuditSink } from "../security/audit.js";
import type { AdminAuthPolicy } from "../security/admin-auth.js";
import { buildOperationalDiagnostics } from "./diagnostics.js";
import type { ApiRouteContext, ApiRouter, CreateApiRouterOptions } from "./route-context.js";
import type { RouteModule } from "./route-module.js";
import { createDiagnosticsRouteModule } from "./routes/diagnostics.js";
import { createChainReadRouteModule } from "./routes/chain-read.js";
import { createAdminOpsRouteModule } from "./routes/admin-ops.js";
import { createV1OrderGoneRouteModule } from "./routes/v1-gone.js";
import { createIdentityBindingsRouteModule } from "./routes/identity-bindings.js";

export type {
  AdminOpsActionEffect,
  AdminOpsRecoveryActions,
  ApiRequest,
  ApiResponse,
  ApiRouter,
  CreateApiRouterOptions
} from "./route-context.js";

export function createApiRouter(store: ProjectionStore, options: CreateApiRouterOptions): ApiRouter {
  const audit = options.audit ?? noopAuditSink;
  const runtimeEnvironment = options.runtimeEnvironment;
  if (!runtimeEnvironment) {
    throw new Error("runtimeEnvironment is required to create the API router");
  }
  const buildDiagnostics = () => buildOperationalDiagnostics({
    store,
    ...(options.configDiagnostics ? { configDiagnostics: options.configDiagnostics } : {}),
    runtimeEnvironment: runtimeEnvironment,
    ...(options.indexerDiagnostics ? { indexer: options.indexerDiagnostics } : {})
  });
  const now = options.now ?? (() => new Date());
  const adminAuthPolicy: AdminAuthPolicy = options.adminAuthPolicy ?? {
    runtimeEnvironment: runtimeEnvironment,
    allowedAdminIds: options.opsConsoleAdminIds ?? []
  };
  const context: ApiRouteContext = {
    store,
    ...(options.opsRecoveryActions ? { opsRecoveryActions: options.opsRecoveryActions } : {}),
    ...(options.opsConsoleAdminIds ? { opsConsoleAdminIds: options.opsConsoleAdminIds } : {}),
    adminAuthPolicy,
    audit,
    buildDiagnostics,
    ...(options.onTxMined ? { onTxMined: options.onTxMined } : {}),
    now
  };
  const modules: readonly RouteModule[] = [
    createDiagnosticsRouteModule(),
    createChainReadRouteModule(),
    createAdminOpsRouteModule(),
    createV1OrderGoneRouteModule(),
    createIdentityBindingsRouteModule()
  ];

  return {
    async handle(request) {
      for (const module of modules) {
        const response = await module.handle(request, context);
        if (response) {
          return response;
        }
      }
      return {
        status: 404,
        body: { error: "not_found" }
      };
    }
  };
}
