// V3 binding read/deposit-intent routes. Registration is intentionally NOT in
// api/routes.ts (shared file, owned by B1); the exact registration patch is in
// the task report. Visibility always comes from BindingScopeResolver + the
// binding read service: buyer full, own-stage payee/verifier scoped, operator
// minimal, stranger 404, projection not ready -> dataState:"pending".

import type { ChainServicesRuntimeEnv } from "../../config/index.js";
import type { SettlementInstructionRecord, SettlementInstructionView } from "../../settlement/types.js";
import type { SettlementLedger } from "../../settlement/service.js";
import type { SettlementStore } from "../../settlement/store.js";
import type { SettlementRelayer } from "../../settlement/executor.js";
import { BindingError, type BindingScopeResolver } from "../../binding/types.js";
import type { DepositIntentService } from "../../binding/deposit-intent.js";
import type { BindingReadService } from "../../binding/service.js";
import { resolveParticipantWalletIdentity } from "../participant-identity.js";
import {
  decodePathParameter,
  InvalidPathParameterError,
  invalidPathParameterResponse,
  type ApiResponse,
  type ApiRouteContext
} from "../route-context.js";
import type { RouteModule } from "../route-module.js";

const DEPOSIT_INTENT_PATH = /^\/product\/orders\/([^/]+)\/stages\/([^/]+)\/deposit-intent$/;
const STAGE_BINDING_PATH = /^\/product\/orders\/([^/]+)\/stages\/([^/]+)\/binding$/;
const ORDER_BINDINGS_PATH = /^\/product\/orders\/([^/]+)\/bindings$/;
const ORDER_INSTRUCTIONS_PATH = /^\/product\/orders\/([^/]+)\/settlement-instructions$/;
const EXECUTE_READY_PATH = /^\/product\/v3\/execution\/execute-ready$/;
const EXECUTE_INSTRUCTION_PATH =
  /^\/product\/v3\/orders\/([^/]+)\/stages\/([^/]+)\/instructions\/([^/]+)\/execute$/;
const INSTRUCTION_SIGNATURE_PATH =
  /^\/product\/orders\/([^/]+)\/settlement-instructions\/([^/]+)\/signatures$/;

export interface SettlementInstructionsReader {
  listForOrder(orderId: string, limit?: number): Promise<readonly SettlementInstructionView[]>;
}

export interface ProductBindingRouteOptions {
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
  readonly deposits: DepositIntentService;
  readonly bindings: BindingReadService;
  readonly scopeResolver: BindingScopeResolver;
  readonly instructions?: SettlementInstructionsReader;
  readonly settlements?: SettlementLedger;
  readonly settlementStore?: SettlementStore;
  readonly executeRelayer?: SettlementRelayer;
}

export function createProductBindingRouteModule(
  options: ProductBindingRouteOptions
): RouteModule {
  return {
    async handle(request, context) {
      try {
        if (request.method === "GET" && EXECUTE_READY_PATH.test(request.pathname)) {
          const wallet = await identity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          if (!options.settlementStore) {
            return { status: 503, body: { error: "settlement_reader_unavailable", retryable: false } };
          }
          const rows = await options.settlementStore.listByStatus("execute_ready", 50);
          return {
            status: 200,
            body: {
              dataState: rows.length === 0 ? "none" : "ok",
              instructions: rows.map(executeQueueView),
            },
          };
        }

        if (request.method === "POST") {
          const executeMatch = EXECUTE_INSTRUCTION_PATH.exec(request.pathname);
          if (executeMatch) {
            const wallet = await identity(request, context, options.runtimeEnvironment);
            if (!wallet.ok) {
              return wallet.response;
            }
            if (!options.executeRelayer || !options.settlementStore) {
              return { status: 503, body: { error: "execute_relayer_unavailable", retryable: false } };
            }
            const orderId = decodePathParameter(executeMatch[1] ?? "");
            const stageKey = decodePathParameter(executeMatch[2] ?? "");
            const instructionId = decodePathParameter(executeMatch[3] ?? "");
            const instruction = await options.settlementStore.getInstruction(instructionId);
            if (!instruction || instruction.orderId !== orderId.toLowerCase() || instruction.stageKey !== stageKey) {
              return { status: 404, body: { error: "instruction_not_found" } };
            }
            const result = await options.executeRelayer.process(instructionId);
            return {
              status: result.status === "failed" ? 409 : 202,
              body: {
                instructionId: result.instructionId,
                status: result.status,
                outcome: result.outcome,
                ...(result.errorCode !== undefined ? { error: result.errorCode } : {}),
              },
            };
          }

          const signatureMatch = INSTRUCTION_SIGNATURE_PATH.exec(request.pathname);
          if (signatureMatch) {
            if (!options.settlements) {
              return {
                status: 503,
                body: { error: "settlement_ledger_unavailable", message: "settlement signing is not wired" }
              };
            }
            const wallet = await identity(request, context, options.runtimeEnvironment);
            if (!wallet.ok) {
              return wallet.response;
            }
            const instructionId = decodePathParameter(signatureMatch[2] ?? "");
            const signature = typeof (request.body as { signature?: unknown })?.signature === "string"
              ? (request.body as { signature: string }).signature
              : undefined;
            if (!signature) {
              return { status: 400, body: { error: "invalid_body", message: "signature is required" } };
            }
            const result = await options.settlements.addSignature({
              instructionId,
              signer: wallet.identity.walletAddress,
              signature
            });
            return { status: 200, body: { instruction: result.instruction, replayed: result.replayed } };
          }

          const match = DEPOSIT_INTENT_PATH.exec(request.pathname);
          if (!match) {
            return undefined;
          }
          const wallet = await identity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const orderId = decodePathParameter(match[1] ?? "");
          const stageKey = decodePathParameter(match[2] ?? "");
          const idempotencyKey = readIdempotencyKey(request.headers);
          const result = await options.deposits.createIntent({
            orderId,
            stageKey,
            walletAddress: wallet.identity.walletAddress,
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {})
          });
          return {
            status: result.replayed ? 200 : 201,
            body: result
          };
        }

        if (request.method !== "GET") {
          return undefined;
        }

        const orderBindings = ORDER_BINDINGS_PATH.exec(request.pathname);
        if (orderBindings) {
          const wallet = await identity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const orderId = decodePathParameter(orderBindings[1] ?? "");
          return {
            status: 200,
            body: await options.bindings.listOrderBindings(orderId, wallet.identity.walletAddress)
          };
        }

        const stageBinding = STAGE_BINDING_PATH.exec(request.pathname);
        if (stageBinding) {
          const wallet = await identity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const orderId = decodePathParameter(stageBinding[1] ?? "");
          const stageKey = decodePathParameter(stageBinding[2] ?? "");
          return {
            status: 200,
            body: await options.bindings.getStageBinding(orderId, stageKey, wallet.identity.walletAddress)
          };
        }

        const orderInstructions = ORDER_INSTRUCTIONS_PATH.exec(request.pathname);
        if (orderInstructions) {
          if (!options.instructions) {
            return {
              status: 503,
              body: { error: "settlement_reader_unavailable", message: "settlement instruction reads are not wired" }
            };
          }
          const wallet = await identity(request, context, options.runtimeEnvironment);
          if (!wallet.ok) {
            return wallet.response;
          }
          const orderId = decodePathParameter(orderInstructions[1] ?? "");
          const scope = await options.scopeResolver.resolveBindingScope(
            orderId,
            wallet.identity.walletAddress
          );
          if (scope.kind === "stranger") {
            return { status: 404, body: { error: "order_not_found" } };
          }
          if (scope.kind === "operator") {
            return {
              status: 403,
              body: { error: "visibility_denied", message: "operator scope cannot read settlement amounts" }
            };
          }
          const bindings = await options.bindings.listOrderBindings(orderId, wallet.identity.walletAddress);
          const instructions = (await options.instructions.listForOrder(orderId)).filter(
            (instruction) => scope.kind === "buyer" || scope.stages.has(instruction.stageKey)
          );
          return {
            status: 200,
            body: {
              orderId: bindings.orderId,
              dataState: bindings.dataState,
              instructions
            }
          };
        }

        return undefined;
      } catch (error) {
        return errorResponse(error);
      }
    }
  };
}

async function identity(
  request: Parameters<RouteModule["handle"]>[0],
  context: ApiRouteContext,
  runtimeEnvironment: ChainServicesRuntimeEnv | undefined
) {
  return resolveParticipantWalletIdentity(request, context, runtimeEnvironment);
}

function executeQueueView(instruction: SettlementInstructionRecord) {
  return {
    instructionId: instruction.instructionId,
    planId: instruction.planId,
    orderId: instruction.orderId,
    stageKey: instruction.stageKey,
    trancheId: instruction.trancheId,
    instructionRef: instruction.instructionRef,
    kind: instruction.kind,
    payerAmount: instruction.payerAmount,
    payeeAmount: instruction.payeeAmount,
    status: instruction.status,
    executeEligibleAt: instruction.executeEligibleAt ?? null,
    deadline: instruction.deadline,
    ...(instruction.blockedByDispute === true ? { blockedByDispute: true } : {}),
  };
}

function readIdempotencyKey(headers: Parameters<RouteModule["handle"]>[0]["headers"]): string | undefined {
  if (!headers) {
    return undefined;
  }
  const raw = headers["idempotency-key"] ?? headers["Idempotency-Key"] ??
    Object.entries(headers).find(([key]) => key.toLowerCase() === "idempotency-key")?.[1];
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 128) {
    throw new BindingError(400, "invalid_idempotency_key", "Idempotency-Key must be at most 128 characters");
  }
  return trimmed;
}

function errorResponse(error: unknown): ApiResponse {
  if (error instanceof BindingError) {
    return {
      status: error.status,
      body: {
        error: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {})
      }
    };
  }
  if (error instanceof InvalidPathParameterError) {
    return invalidPathParameterResponse();
  }
  const settlementError = error as { readonly name?: string; readonly status?: unknown; readonly code?: unknown; readonly message?: unknown; readonly details?: unknown };
  if (
    settlementError?.name === "SettlementError" ||
    settlementError?.name === "RuntimeError"
  ) {
    return {
      status: typeof settlementError.status === "number" ? settlementError.status : 400,
      body: {
        error: typeof settlementError.code === "string" ? settlementError.code : "invalid_settlement_request",
        message: typeof settlementError.message === "string" ? settlementError.message : "invalid request",
        ...(settlementError.details !== undefined ? { details: settlementError.details } : {})
      }
    };
  }
  throw error;
}
