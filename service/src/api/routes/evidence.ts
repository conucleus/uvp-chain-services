import type { ChainServicesRuntimeEnv } from "../../config/index.js";
import {
  EvidenceServiceError,
  type CreateEvidenceRequestDTO
} from "../../evidence/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import { resolveEvidencePrincipal } from "../participant-identity.js";
import type { RouteModule } from "../route-module.js";

export function createEvidenceRouteModule(options: {
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
} = {}): RouteModule {
  return {
    async handle(request, context) {
      try {
        if (request.pathname === "/product/evidence") {
          if (request.method !== "POST") {
            return {
              status: 405,
              body: { error: "method_not_allowed" }
            };
          }
          // evidence 身份不取自 x-uvp-principal-* 自报头——
          // 治理白名单 admin 或钱包会话锚定地址；非 local 无身份即 401。
          const principal = await resolveEvidencePrincipal(request, context, options.runtimeEnvironment);
          const result = await context.evidenceService.uploadEvidence(
            requireEvidenceBodyRecord(request.body) as CreateEvidenceRequestDTO,
            principal
          );
          return {
            status: 201,
            body: result
          };
        }

        const backupVerifyMatch = /^\/product\/evidence\/([^/]+)\/backup-verify$/.exec(request.pathname);
        if (request.method === "POST" && backupVerifyMatch) {
          const evidenceId = decodeURIComponent(backupVerifyMatch[1] ?? "");
          const principal = await resolveEvidencePrincipal(request, context, options.runtimeEnvironment);
          const status = await context.evidenceService.verifyEvidenceBackup(evidenceId, principal);
          if (!status) {
            return {
              status: 404,
              body: { error: "evidence_not_found" }
            };
          }
          return {
            status: 200,
            body: { backup: status }
          };
        }

        const backupRestoreMatch = /^\/product\/evidence\/([^/]+)\/backup-restore$/.exec(request.pathname);
        if (request.method === "POST" && backupRestoreMatch) {
          const evidenceId = decodeURIComponent(backupRestoreMatch[1] ?? "");
          const principal = await resolveEvidencePrincipal(request, context, options.runtimeEnvironment);
          const status = await context.evidenceService.restoreEvidenceBackup(evidenceId, principal);
          if (!status) {
            return {
              status: 404,
              body: { error: "evidence_not_found" }
            };
          }
          return {
            status: 200,
            body: { backup: status }
          };
        }

        const proofMatch = /^\/product\/evidence\/([^/]+)\/proof$/.exec(request.pathname);
        if (proofMatch) {
          if (request.method !== "GET") {
            return {
              status: 405,
              body: { error: "method_not_allowed" }
            };
          }
          const evidenceId = decodeURIComponent(proofMatch[1] ?? "");
          const principal = await resolveEvidencePrincipal(request, context, options.runtimeEnvironment);
          const proof = await context.evidenceService.getProof(evidenceId, principal);
          if (!proof) {
            return {
              status: 404,
              body: { error: "evidence_not_found" }
            };
          }
          return {
            status: 200,
            body: { proof }
          };
        }

        const evidenceMatch = /^\/product\/evidence\/([^/]+)$/.exec(request.pathname);
        if (evidenceMatch) {
          if (request.method !== "GET") {
            return {
              status: 405,
              body: { error: "method_not_allowed" }
            };
          }
          const evidenceId = decodeURIComponent(evidenceMatch[1] ?? "");
          const principal = await resolveEvidencePrincipal(request, context, options.runtimeEnvironment);
          const evidence = await context.evidenceService.getEvidence(evidenceId, principal);
          if (!evidence) {
            return {
              status: 404,
              body: { error: "evidence_not_found" }
            };
          }
          return {
            status: 200,
            body: evidence
          };
        }
      } catch (error) {
        if (error instanceof EvidenceServiceError) {
          return {
            status: error.status,
            body: {
              error: error.code,
              message: redactErrorMessage(error)
            }
          };
        }
        throw error;
      }

      return undefined;
    }
  };
}

function requireEvidenceBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new EvidenceServiceError("invalid_request", "request body must be a JSON object", 400);
}
