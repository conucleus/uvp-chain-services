import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadConfigFromEnv, runConfigPreflight, type ChainServicesConfig } from "../config/index.js";
import { IndexerService, type ChainEventSource } from "../indexer/service.js";
import { createChainEventSourceForTarget } from "../chain-adapters/events.js";
import { createChainServicesStores } from "../storage/factory.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import { createLoggerAuditSink } from "../security/audit.js";
import { createRedactingLogger, redactErrorMessage, redactSecrets } from "@uvp-eth/service-runtime";
import { isDirectRun } from "../shared/runtime.js";
import { consoleLogger, type Logger } from "@uvp-eth/service-runtime";
import { createApiRouter } from "./routes.js";
import { InvalidPathParameterError, invalidPathParameterResponse, normalizeRequestId } from "./route-context.js";
import { createPlanArtifactResolvers } from "../projection/plan-artifacts.js";

export interface StartApiServerOptions {
  readonly config?: ChainServicesConfig;
  readonly store?: ProjectionStore;
  readonly eventSource?: ChainEventSource | false;
  readonly logger?: Logger;
}

export async function startApiServer(
  configOrOptions: ChainServicesConfig | StartApiServerOptions = {},
  storeOverride?: ProjectionStore,
  eventSourceOverride?: ChainEventSource | false
): Promise<Server> {
  const options = normalizeStartOptions(configOrOptions, storeOverride, eventSourceOverride);
  const config = options.config ?? loadConfigFromEnv();
  const stores = createChainServicesStores({
    database: config.database,
    chainId: config.network.chainId
  });
  const store = options.store ?? stores.projectionStore;
  const planArtifacts = createPlanArtifactResolvers({
    store: stores.planArtifactStore,
    chainId: config.network.chainId
  });
  const logger = createRedactingLogger(options.logger ?? consoleLogger, config.security.logRedactionEnabled);
  const audit = createLoggerAuditSink(logger);
  const configDiagnostics = await runConfigPreflight(config);
  const eventSource = options.eventSource === undefined
    ? createChainEventSourceForTarget(config, { logger })
    : options.eventSource;
  const indexer = eventSource
    ? new IndexerService({
      config,
      eventSource,
      store,
      resolvePlanCapabilityTables: planArtifacts.resolvePlanCapabilityTables,
      resolveSemanticOraclePlan: planArtifacts.resolveSemanticOraclePlan,
      logger
    })
    : undefined;

  const initialProjectionRebuild = indexer
    ? indexer.rebuildFromDeploymentBlock().catch((error: unknown) => {
        logger.error("api server background projection rebuild failed", {
          message: error instanceof Error ? redactErrorMessage(error) : "unknown rebuild error"
        });
      })
    : undefined;

  const opsRecoveryActions = indexer
    ? {
      rebuildProjections: async () => {
        await initialProjectionRebuild;
        const { summary } = await indexer.rebuildFromDeploymentBlockWithSummary();
        return {
          status: "completed" as const,
          summary: {
            eventCount: summary.eventCount,
            activeEventCount: summary.activeEventCount,
            mismatchCount: summary.mismatchCount,
            finalizedBlock: summary.finalizedBlock,
            syncStatus: summary.syncStatus
          }
        };
      },
      sweepPendingPostCommitSteps: async () => {
        const summary = await indexer.sweepPendingPostCommitSteps();
        return { status: "completed" as const, summary };
      },
      listPendingPostCommitSteps: async () => indexer.listPendingPostCommitSteps()
    }
    : {};
  const opsConsoleAdminIds = config.operatorRoles.opsConsoleAdmins ?? [];
  const router = createApiRouter(store, {
    runtimeEnvironment: config.security.environment,
    ...(opsConsoleAdminIds.length > 0 ? { opsConsoleAdminIds } : {}),
    adminAuthPolicy: {
      runtimeEnvironment: config.security.environment,
      allowedAdminIds: opsConsoleAdminIds,
      ...((config.operatorRoles.adminTokenHashes ?? []).length > 0
        ? { adminTokenHashes: config.operatorRoles.adminTokenHashes }
        : {})
    },
    opsRecoveryActions,
    indexerDiagnostics: {
      configured: Boolean(eventSource),
      pollIntervalMs: config.api.indexerPollIntervalMs
    },
    audit,
    configDiagnostics,
    ...(indexer
      ? {
        onTxMined: () => {
          indexer.refreshIfIdle();
        }
      }
      : {})
  });
  const server = createServer((request, response) => {
    const requestId = requestIdFromHeaders(request);
    const runId = runIdFromHeaders(request);
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      setCorsHeaders(response, request);
      response.setHeader("x-request-id", requestId);
      if (runId) {
        response.setHeader("x-uvp-run-id", runId);
      }

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }

      const parsedBody = await readJsonBody(request).catch((error: unknown) => {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json; charset=utf-8");
        const body = withErrorMetadata({
          error: "invalid_json_body",
          message: error instanceof Error ? redactErrorMessage(error) : "request body must be valid JSON"
        }, requestId, runId);
        logger.warn("api request rejected", {
          requestId,
          ...(runId ? { runId } : {}),
          method: request.method,
          pathname: url.pathname,
          status: 400,
          errorCode: "invalid_json_body"
        });
        response.end(JSON.stringify(body));
        return invalidBodySent;
      });
      if (parsedBody === invalidBodySent) {
        return;
      }

      const apiResponse = await router.handle({
        method: request.method ?? "GET",
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: normalizeHeaders(request.headers),
        body: parsedBody,
        clientAddress: clientAddressFromSocket(request)
      });

      response.statusCode = apiResponse.status;
      response.setHeader("content-type", "application/json; charset=utf-8");
      const responseBody = apiResponse.status >= 400
        ? withErrorMetadata(apiResponse.body, requestId, runId)
        : apiResponse.body;
      response.end(JSON.stringify(responseBody, jsonReplacer));
      logger.info("api request completed", {
        requestId,
        ...(runId ? { runId } : {}),
        method: request.method,
        pathname: url.pathname,
        status: apiResponse.status,
        ...extractResponseLogFields(redactSecrets(responseBody))
      });
    })().catch((error: unknown) => {
      if (error instanceof InvalidPathParameterError) {
        const body400 = withErrorMetadata(invalidPathParameterResponse().body, requestId, runId);
        response.statusCode = 400;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify(body400));
        return;
      }
      response.statusCode = 500;
      setCorsHeaders(response);
      response.setHeader("x-request-id", requestId);
      if (runId) {
        response.setHeader("x-uvp-run-id", runId);
      }
      response.setHeader("content-type", "application/json; charset=utf-8");
      const body = withErrorMetadata({
        error: "internal_server_error",
        message: error instanceof Error ? redactErrorMessage(error) : "unknown error"
      }, requestId, runId);
      logger.error("api request failed", {
        requestId,
        ...(runId ? { runId } : {}),
        method: request.method,
        pathname: request.url ?? "/",
        status: 500,
        errorCode: "internal_server_error",
        message: error instanceof Error ? redactErrorMessage(error) : "unknown error"
      });
      response.end(
        JSON.stringify(body)
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(config.api.port, config.api.host, resolve);
  });

  let closed = false;
  void (async () => {
    if (closed) {
      return;
    }
    await initialProjectionRebuild;
    if (closed) {
      return;
    }
    const pollInterval = indexer ? startProjectionRefresh(indexer, config, logger) : undefined;
    if (pollInterval) {
      server.on("close", () => clearInterval(pollInterval));
    }
  })();
  server.on("close", () => {
    closed = true;
    void (async () => {
      await stores.close();
    })();
  });

  logger.info("api server listening", {
    host: config.api.host,
    port: config.api.port,
    indexerPollIntervalMs: config.api.indexerPollIntervalMs
  });

  return server;
}

function startProjectionRefresh(indexer: IndexerService, config: ChainServicesConfig, logger: Logger): NodeJS.Timeout | undefined {
  const pollIntervalMs = config.api.indexerPollIntervalMs;
  if (pollIntervalMs <= 0) {
    logger.warn(
      "INDEXER POLLING IS DISABLED (UVP_INDEXER_POLL_INTERVAL_MS=0): chain events from external participants will never enter the projection and recovery requires a manual projection rebuild"
    );
    return undefined;
  }

  return setInterval(() => {
    indexer.refreshIfIdle();
  }, pollIntervalMs);
}

function normalizeStartOptions(
  configOrOptions: ChainServicesConfig | StartApiServerOptions,
  storeOverride?: ProjectionStore,
  eventSourceOverride?: ChainEventSource | false
): StartApiServerOptions {
  if ("network" in configOrOptions) {
    return {
      config: configOrOptions,
      ...(storeOverride ? { store: storeOverride } : {}),
      ...(eventSourceOverride !== undefined ? { eventSource: eventSourceOverride } : {})
    };
  }
  return configOrOptions;
}

const CORS_ALLOWED_ORIGINS = new Set(
  (process.env.UVP_API_CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

function setCorsHeaders(response: ServerResponse, request?: IncomingMessage): void {
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "content-type, x-request-id, x-uvp-request-id, x-uvp-run-id, x-uvp-admin-id, x-uvp-admin-role, x-uvp-admin-token, x-uvp-wallet-address"
  );
  response.setHeader("access-control-max-age", "86400");
  const origin = request?.headers.origin?.trim() ?? "";
  if (origin !== "" && CORS_ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
}


function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(",") : value
    ])
  );
}

function requestIdFromHeaders(request: IncomingMessage): string {
  const header = request.headers["x-request-id"] ?? request.headers["x-uvp-request-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return normalizeRequestId(value) ?? randomUUID();
}

function runIdFromHeaders(request: IncomingMessage): string | undefined {
  const header = request.headers["x-uvp-run-id"] ?? request.headers["x-run-id"];
  const value = Array.isArray(header) ? header[0] : header;
  const runId = value && value.trim().length > 0 ? value.trim() : process.env.UVP_RUN_ID?.trim();
  return runId && runId.length > 0 ? runId : undefined;
}

function clientAddressFromSocket(request: IncomingMessage): string | undefined {
  const remote = request.socket.remoteAddress;
  if (!remote) {
    return undefined;
  }
  return remote.replace(/^::ffff:/, "");
}

function withErrorMetadata(body: unknown, requestId: string, runId: string | undefined): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      error: "request_failed",
      message: redactErrorMessage(body),
      requestId,
      ...(runId ? { runId } : {})
    };
  }
  return {
    ...(body as Record<string, unknown>),
    requestId,
    ...(runId ? { runId } : {})
  };
}

function extractResponseLogFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    return {};
  }
  const record = body as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of ["error", "errorCode", "txHash", "orderId", "requestId", "runId"]) {
    const value = findFirstString(record, key);
    if (value) {
      fields[key === "error" ? "errorCode" : key] = value;
    }
  }
  return fields;
}

function findFirstString(value: unknown, key: string, seen: WeakSet<object> = new WeakSet()): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    const found = findFirstString(entry, key, seen);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown | undefined> {
  const method = request.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > 16_000_000) {
      throw new Error("request body exceeds 16MB limit");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

const invalidBodySent = Symbol("invalidBodySent");

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

if (isDirectRun(import.meta.url)) {
  void startApiServer();
}
