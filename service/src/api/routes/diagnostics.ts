import { adminPrincipalFromHeaders } from "../../security/admin-auth.js";
import { operationalReadiness } from "../diagnostics.js";
import type { RouteModule } from "../route-module.js";

interface HealthReport {
  readonly status: string;
  readonly degradedReasons: readonly string[];
}

function readHealth(diagnostics: Record<string, unknown>): HealthReport {
  const health = diagnostics.health;
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    return { status: "degraded", degradedReasons: [] };
  }
  const record = health as Record<string, unknown>;
  return {
    status: typeof record.status === "string" ? record.status : "degraded",
    degradedReasons: Array.isArray(record.degradedReasons)
      ? record.degradedReasons.map((reason) => String(reason))
      : []
  };
}

export function createDiagnosticsRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      if (request.method === "GET" && request.pathname === "/healthz") {
        const diagnostics = await context.buildDiagnostics();
        const health = readHealth(diagnostics);
        const ok = health.status !== "degraded";
        return {
          status: ok ? 200 : 503,
          body: {
            ok,
            status: health.status,
            sourceOfTruth: "contracts-and-chain-events",
            reasons: health.degradedReasons
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
        const principal = adminPrincipalFromHeaders(request.headers, context.adminAuthPolicy);
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
            ok: readHealth(diagnostics).status !== "degraded",
            sourceOfTruth: "contracts-and-chain-events",
            diagnostics
          }
        };
      }

      return undefined;
    }
  };
}
