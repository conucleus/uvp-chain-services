import { adminPrincipalFromHeaders } from "../../governance/index.js";
import { operationalReadiness } from "../diagnostics.js";
import type { RouteModule } from "../route-module.js";

export function createDiagnosticsRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (request.method === "GET" && request.pathname === "/healthz") {
        const diagnostics = await context.buildDiagnostics();
        const health = diagnostics.health as { readonly status?: string } | undefined;
        return {
          status: 200,
          body: {
            ok: health?.status !== "degraded",
            status: health?.status ?? "ok",
            sourceOfTruth: "contracts-and-chain-events"
          }
        };
      }

      if (request.method === "GET" && request.pathname === "/readyz") {
        const diagnostics = await context.buildDiagnostics();
        const readiness = operationalReadiness(diagnostics);
        return {
          status: readiness.ready ? 200 : 503,
          body: {
            ok: readiness.ready,
            ready: readiness.ready,
            status: readiness.status,
            sourceOfTruth: "contracts-and-chain-events",
            reasons: readiness.reasons
          }
        };
      }

      if (request.method === "GET" && request.pathname === "/admin/diagnostics") {
        const principal = adminPrincipalFromHeaders(request.headers, context.governanceAdminPolicy);
        if (!principal) {
          return {
            status: 403,
            body: { error: "forbidden" }
          };
        }
        const diagnostics = await context.buildDiagnostics();
        return {
          status: 200,
          body: {
            ok: true,
            sourceOfTruth: "contracts-and-chain-events",
            diagnostics
          }
        };
      }

      return undefined;
    }
  };
}
