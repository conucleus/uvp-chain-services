import type { ConfigDiagnostics, ChainServicesRuntimeEnv } from "../config/index.js";
import type { AdminAuthPolicy } from "../security/admin-auth.js";
import type { AuditSink } from "../security/audit.js";
import type { ProjectionStore } from "../storage/projection-store.js";
import type { IndexerRuntimeDiagnostics } from "./diagnostics.js";

export interface ApiRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly clientAddress?: string | undefined;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ApiRouter {
  handle(request: ApiRequest): Promise<ApiResponse>;
}

export interface CreateApiRouterOptions {
  readonly runtimeEnvironment?: ChainServicesRuntimeEnv;
  readonly audit?: AuditSink;
  readonly configDiagnostics?: ConfigDiagnostics;
  readonly indexerDiagnostics?: IndexerRuntimeDiagnostics;
  readonly opsRecoveryActions?: AdminOpsRecoveryActions;
  readonly opsConsoleAdminIds?: readonly string[];
  readonly adminAuthPolicy?: AdminAuthPolicy;
  readonly onTxMined?: () => void;
  readonly now?: () => Date;
}

export interface AdminOpsActionEffect {
  readonly status?: "accepted" | "queued" | "running" | "completed";
  readonly nextCheckAt?: string;
  readonly summary?: unknown;
}

export interface AdminOpsRecoveryActions {
  rebuildProjections?(): Promise<AdminOpsActionEffect | void>;
  sweepPendingPostCommitSteps?(): Promise<AdminOpsActionEffect | void>;
  listPendingPostCommitSteps?(): Promise<unknown>;
}

export interface ApiRouteContext {
  readonly store: ProjectionStore;
  readonly opsRecoveryActions?: AdminOpsRecoveryActions;
  readonly opsConsoleAdminIds?: readonly string[];
  readonly adminAuthPolicy: AdminAuthPolicy;
  readonly audit: AuditSink;
  readonly buildDiagnostics: () => Promise<Record<string, unknown>>;
  readonly onTxMined?: () => void;
  readonly now: () => Date;
}

export function cleanQuery<TQuery extends Readonly<Record<string, string | undefined>>>(query: TQuery): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
  );
}

export class InvalidPathParameterError extends Error {
  override readonly name = "InvalidPathParameterError";
  readonly status = 400;

  constructor(readonly rawValue: string) {
    super("path parameter is not a valid percent-encoded value");
  }
}

export function decodePathParameter(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) {
      throw new InvalidPathParameterError(value);
    }
    throw error;
  }
}

export function invalidPathParameterResponse(): ApiResponse {
  return {
    status: 400,
    body: { error: "invalid_path_parameter", message: "path parameter is not a valid percent-encoded value" }
  };
}

export function readApiHeader(headers: ApiRequest["headers"], name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export function normalizeRequestId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}
