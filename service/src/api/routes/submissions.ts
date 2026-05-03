import {
  EvidenceServiceError,
  principalFromHeaders
} from "../../evidence/index.js";
import { redactErrorMessage } from "../../security/redaction.js";
import { ConfigError } from "../../shared/types.js";
import {
  ProductSubmissionError,
  type PrepareProductTaskSubmitInput,
  type ProductSubmitIntent,
  type SubmitProductTaskInput
} from "../../submissions/index.js";
import type { ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

export function createSubmissionsRouteModule(): RouteModule {
  return {
    async handle(request, context) {
      const productTaskPrepareSubmitMatch = /^\/product\/tasks\/([^/]+)\/prepare-submit$/.exec(request.pathname);
      if (request.method === "POST" && productTaskPrepareSubmitMatch) {
        return handleSubmissionRequest(async () => {
          const taskId = decodeURIComponent(productTaskPrepareSubmitMatch[1] ?? "");
          return {
            status: 201,
            body: await context.submissionService.prepareSubmit(
              taskId,
              parsePrepareSubmitBody(request.body),
              principalFromHeaders(request.headers)
            )
          };
        });
      }

      const productTaskSubmitMatch = /^\/product\/tasks\/([^/]+)\/submit$/.exec(request.pathname);
      if (request.method === "POST" && productTaskSubmitMatch) {
        return handleSubmissionRequest(async () => {
          const taskId = decodeURIComponent(productTaskSubmitMatch[1] ?? "");
          const submission = await context.submissionService.submit(taskId, parseSubmitBody(request.body));
          if (submission.txHash) {
            context.onTxMined?.();
          }
          return {
            status: 200,
            body: submission
          };
        });
      }

      const productSubmissionMatch = /^\/product\/submissions\/([^/]+)$/.exec(request.pathname);
      if (request.method === "GET" && productSubmissionMatch) {
        return handleSubmissionRequest(async () => {
          const submissionId = decodeURIComponent(productSubmissionMatch[1] ?? "");
          const submission = await context.submissionService.getSubmission(submissionId);
          if (!submission) {
            return {
              status: 404,
              body: { error: "submission_not_found" }
            };
          }
          return {
            status: 200,
            body: submission
          };
        });
      }

      return undefined;
    }
  };
}

async function handleSubmissionRequest(action: () => Promise<ApiResponse>): Promise<ApiResponse> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ProductSubmissionError) {
      return {
        status: error.status,
        body: {
          error: error.code,
          message: redactErrorMessage(error),
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      };
    }
    if (error instanceof EvidenceServiceError) {
      return {
        status: error.status,
        body: {
          error: error.code,
          message: redactErrorMessage(error)
        }
      };
    }
    if (error instanceof ConfigError) {
      return {
        status: 400,
        body: {
          error: "invalid_body",
          message: redactErrorMessage(error)
        }
      };
    }
    throw error;
  }
}

function parsePrepareSubmitBody(body: unknown): PrepareProductTaskSubmitInput {
  const record = requireSubmissionBodyRecord(body);
  return {
    evidenceIds: requiredSubmissionStringArray(record, "evidenceIds"),
    walletAddress: requiredSubmissionString(record, "walletAddress"),
    intent: requiredSubmitIntent(record, "intent")
  };
}

function parseSubmitBody(body: unknown): SubmitProductTaskInput {
  const record = requireSubmissionBodyRecord(body);
  return {
    prepareId: requiredSubmissionString(record, "prepareId"),
    signature: requiredSubmissionString(record, "signature"),
    walletAddress: requiredSubmissionString(record, "walletAddress")
  };
}

function requireSubmissionBodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new ProductSubmissionError(400, "invalid_body", "request body must be a JSON object");
}

function requiredSubmissionString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductSubmissionError(400, "invalid_body", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredSubmissionStringArray(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new ProductSubmissionError(400, "invalid_body", `${field} must be a non-empty array of strings`);
  }
  return value.map((item) => item.trim());
}

function requiredSubmitIntent(record: Record<string, unknown>, field: string): ProductSubmitIntent {
  const value = requiredSubmissionString(record, field);
  if (value === "confirm_stage" || value === "reject_stage" || value === "raise_dispute" || value === "resolve_dispute") {
    return value;
  }
  throw new ProductSubmissionError(400, "invalid_body", `${field} is not a supported submit intent`);
}
