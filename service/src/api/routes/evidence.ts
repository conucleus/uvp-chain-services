import {
  EvidenceServiceError,
  principalFromHeaders,
  type CreateEvidenceRequestDTO
} from "../../evidence/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import type { RouteModule } from "../route-module.js";

export function createEvidenceRouteModule(): RouteModule {
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
          const result = await context.evidenceService.uploadEvidence(
            requireEvidenceBodyRecord(request.body) as CreateEvidenceRequestDTO,
            principalFromHeaders(request.headers)
          );
          return {
            status: 201,
            body: result
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
          const proof = await context.evidenceService.getProof(evidenceId, principalFromHeaders(request.headers));
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
          const evidence = await context.evidenceService.getEvidence(evidenceId, principalFromHeaders(request.headers));
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
