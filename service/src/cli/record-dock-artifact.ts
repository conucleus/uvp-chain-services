// dock_artifacts production write path: validate one uvp-core analyzeDock
// uvp.dock.v1 artifact and record it under its own content identity
// (chain_id, dkid, doc_hash) without running migrations.
import { readFile } from "node:fs/promises";
import { redactErrorMessage, normalizeBytes32, type Hex } from "@uvp-eth/service-runtime";
import {
  PostgresDockArtifactStore,
  assertDockArtifactRecord,
  type DockArtifactRecord
} from "../projection/dock-artifacts.js";
import { PostgresDatabase } from "../storage/postgres-client.js";
import { isDirectRun } from "../shared/runtime.js";

const RECORD_DOCK_ARTIFACT_USAGE =
  "usage: record-dock-artifact.ts --file <artifact.json> --chain-id <positive int> [--dry-run] [--verbose]";

export class RecordDockArtifactError extends Error {
  override readonly name: string = "RecordDockArtifactError";
}

export interface RecordDockArtifactArgs {
  readonly file: string;
  readonly chainId: number;
  readonly dryRun: boolean;
  readonly verbose: boolean;
}

export function parseRecordDockArtifactArgs(argv: readonly string[]): RecordDockArtifactArgs {
  let file: string | undefined;
  let chainIdRaw: string | undefined;
  let dryRun = false;
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (raw === "--") {
      continue;
    }
    const equals = raw.indexOf("=");
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : raw.slice(equals + 1);
    const value = (): string => {
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) {
          throw new RecordDockArtifactError(`${flag} requires a non-empty value`);
        }
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new RecordDockArtifactError(`${flag} requires a value`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--file":
        if (file !== undefined) {
          throw new RecordDockArtifactError("--file was provided more than once");
        }
        file = value();
        break;
      case "--chain-id":
        if (chainIdRaw !== undefined) {
          throw new RecordDockArtifactError("--chain-id was provided more than once");
        }
        chainIdRaw = value();
        break;
      case "--dry-run":
        rejectInlineValue(flag, inlineValue);
        dryRun = true;
        break;
      case "--verbose":
        rejectInlineValue(flag, inlineValue);
        verbose = true;
        break;
      default:
        throw new RecordDockArtifactError(`unknown argument ${flag}; ${RECORD_DOCK_ARTIFACT_USAGE}`);
    }
  }

  if (file === undefined) {
    throw new RecordDockArtifactError(`--file is required; ${RECORD_DOCK_ARTIFACT_USAGE}`);
  }
  if (chainIdRaw === undefined) {
    throw new RecordDockArtifactError(`--chain-id is required; ${RECORD_DOCK_ARTIFACT_USAGE}`);
  }
  return {
    file,
    chainId: parseChainId(chainIdRaw),
    dryRun,
    verbose
  };
}

export function buildDockArtifactRecord(
  artifact: unknown,
  options: { readonly chainId: number }
): DockArtifactRecord {
  const chainId = requireChainId(options.chainId);
  const validated = assertDockArtifactRecord(artifact);
  return {
    chainId,
    dkid: validated.dkid,
    docHash: requireBytes32(validated.docHash, "docHash"),
    artifact: validated
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verboseRequested = argv.includes("--verbose");
  let databaseUrl: string | undefined;
  try {
    const args = parseRecordDockArtifactArgs(argv);
    const record = buildDockArtifactRecord(
      parseArtifactJson(await readArtifactFile(args.file), args.file),
      args
    );
    if (args.dryRun) {
      process.stdout.write(successLine(record, false));
      return;
    }

    databaseUrl = requireDatabaseUrl(process.env);
    const database = new PostgresDatabase({ databaseUrl });
    try {
      await new PostgresDockArtifactStore({ database }).put(record);
    } finally {
      await database.close();
    }
    process.stdout.write(successLine(record, true));
  } catch (error) {
    process.stderr.write(
      `record-dock-artifact failed: ${describeFailure(error, databaseUrl)}\n`
    );
    if (verboseRequested && error instanceof Error && error.stack) {
      process.stderr.write(`${redactText(error.stack, databaseUrl)}\n`);
    }
    process.exitCode = 1;
  }
}

function successLine(record: DockArtifactRecord, recorded: boolean): string {
  return `${JSON.stringify({
    chainId: record.chainId,
    dkid: record.dkid,
    docHash: record.docHash,
    recorded
  })}\n`;
}

async function readArtifactFile(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new RecordDockArtifactError(`cannot read artifact file ${file}: ${errorMessage(error)}`);
  }
}

function parseArtifactJson(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new RecordDockArtifactError(
      `artifact file ${file} is not valid JSON: ${errorMessage(error)}`
    );
  }
}

function requireDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const databaseUrl = env.CHAIN_SERVICES_DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new RecordDockArtifactError(
      "CHAIN_SERVICES_DATABASE_URL is required to record a dock artifact: export the Postgres DSN " +
        "for the database that holds dock_artifacts"
    );
  }
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new RecordDockArtifactError(
      "CHAIN_SERVICES_DATABASE_URL must be a postgres:// or postgresql:// DSN"
    );
  }
  return databaseUrl;
}

function describeFailure(error: unknown, databaseUrl: string | undefined): string {
  const message = redactText(errorMessage(error), databaseUrl).replace(/\s+/g, " ").trim();
  const detail = message.length > 0 ? message : "unknown error";
  return isMissingDockArtifactsTable(error)
    ? `${detail} (run service migrations first; this CLI never creates or migrates schema)`
    : detail;
}

function redactText(value: string, databaseUrl: string | undefined): string {
  const withoutDsn =
    databaseUrl !== undefined && value.includes(databaseUrl)
      ? value.split(databaseUrl).join("[redacted:database-url]")
      : value;
  return redactErrorMessage(withoutDsn);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function isMissingDockArtifactsTable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { readonly code?: unknown }).code;
  return code === "42P01" || /relation "dock_artifacts" does not exist/i.test(error.message);
}

function parseChainId(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new RecordDockArtifactError("--chain-id must be a positive integer");
  }
  return requireChainId(Number(raw));
}

function requireChainId(chainId: number): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new RecordDockArtifactError("chainId must be a positive safe integer");
  }
  return chainId;
}

function requireBytes32(value: string, field: string): Hex {
  try {
    return normalizeBytes32(value, field);
  } catch (error) {
    throw new RecordDockArtifactError(errorMessage(error));
  }
}

function rejectInlineValue(flag: string, inlineValue: string | undefined): void {
  if (inlineValue !== undefined) {
    throw new RecordDockArtifactError(`${flag} does not take a value`);
  }
}

if (isDirectRun(import.meta.url)) {
  void main();
}
