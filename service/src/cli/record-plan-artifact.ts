// plan_artifacts production write path: validate one compiler-produced
// OnchainHookPlanArtifact and record it under the registered on-chain
// (chain_id, plan_id, plan_hash) identity without running migrations.
import { readFile } from "node:fs/promises";
import {
  assertOnchainHookPlanArtifact,
  OnchainHookPlanArtifactValidationError,
  planIdForPublisher,
  toSolidityRegisterPlanArgs,
  type SolidityRegisterPlanArgs
} from "@uvp-eth/compiler";
import {
  PostgresPlanArtifactStore,
  type PlanArtifactRecord
} from "../projection/plan-artifacts.js";
import { redactErrorMessage } from "@uvp-eth/service-runtime";
import { isDirectRun } from "../shared/runtime.js";
import { normalizeAddress, normalizeBytes32, type Hex } from "@uvp-eth/service-runtime";
import { PostgresDatabase } from "../storage/postgres-client.js";

const RECORD_PLAN_ARTIFACT_USAGE =
  "usage: record-plan-artifact.ts --file <artifact.json> --chain-id <positive int> " +
  "(--publisher <address> | --plan-id <bytes32>) [--dry-run] [--verbose]";

export class RecordPlanArtifactError extends Error {
  override readonly name: string = "RecordPlanArtifactError";
}

export class PlanArtifactPlanIdMismatchError extends RecordPlanArtifactError {
  override readonly name = "PlanArtifactPlanIdMismatchError";
}

export interface RecordPlanArtifactArgs {
  readonly file: string;
  readonly chainId: number;
  readonly publisher?: string;
  readonly planId?: string;
  readonly dryRun: boolean;
  readonly verbose: boolean;
}

export interface BuildPlanArtifactRecordOptions {
  readonly chainId: number;
  readonly publisher?: string;
  readonly planId?: string;
}

export function parseRecordPlanArtifactArgs(argv: readonly string[]): RecordPlanArtifactArgs {
  let file: string | undefined;
  let chainIdRaw: string | undefined;
  let publisher: string | undefined;
  let planId: string | undefined;
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
          throw new RecordPlanArtifactError(`${flag} requires a non-empty value`);
        }
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new RecordPlanArtifactError(`${flag} requires a value`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--file":
        file = takeOnce(file, value, flag);
        break;
      case "--chain-id":
        chainIdRaw = takeOnce(chainIdRaw, value, flag);
        break;
      case "--publisher":
        publisher = takeOnce(publisher, value, flag);
        break;
      case "--plan-id":
        planId = takeOnce(planId, value, flag);
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
        throw new RecordPlanArtifactError(`unknown argument ${flag}; ${RECORD_PLAN_ARTIFACT_USAGE}`);
    }
  }

  if (file === undefined) {
    throw new RecordPlanArtifactError(`--file is required; ${RECORD_PLAN_ARTIFACT_USAGE}`);
  }
  if (chainIdRaw === undefined) {
    throw new RecordPlanArtifactError(`--chain-id is required; ${RECORD_PLAN_ARTIFACT_USAGE}`);
  }
  if (publisher === undefined && planId === undefined) {
    throw new RecordPlanArtifactError(
      "one of --publisher <address> or --plan-id <bytes32> is required: plan_artifacts rows are keyed " +
        "by the registered on-chain planId, which artifact.planId does not identify; --publisher derives it " +
        "from planIdForPublisher(publisher, planHash)"
    );
  }
  return {
    file,
    chainId: parseChainId(chainIdRaw),
    dryRun,
    verbose,
    ...(publisher === undefined ? {} : { publisher }),
    ...(planId === undefined ? {} : { planId })
  };
}

export function buildPlanArtifactRecord(
  artifact: unknown,
  options: BuildPlanArtifactRecordOptions
): PlanArtifactRecord {
  const chainId = requireChainId(options.chainId);
  try {
    assertOnchainHookPlanArtifact(artifact);
  } catch (error) {
    throw asRecordPlanArtifactError("artifact", error);
  }

  let registerArgs: SolidityRegisterPlanArgs;
  try {
    registerArgs = toSolidityRegisterPlanArgs(artifact);
  } catch (error) {
    throw asRecordPlanArtifactError("artifact", error);
  }
  const planHash = requireBytes32(registerArgs.planHash, "planHash");
  const explicitPlanId =
    options.planId === undefined ? undefined : requireBytes32(options.planId, "--plan-id");
  const derivedPlanId =
    options.publisher === undefined
      ? undefined
      : requireBytes32(
          planIdForPublisher(requireAddress(options.publisher, "--publisher"), planHash),
          "planId"
        );

  if (derivedPlanId !== undefined && explicitPlanId !== undefined && derivedPlanId !== explicitPlanId) {
    throw new PlanArtifactPlanIdMismatchError(
      `--plan-id ${explicitPlanId} does not match planIdForPublisher(--publisher, planHash) ${derivedPlanId}`
    );
  }
  const planId = derivedPlanId ?? explicitPlanId;
  if (planId === undefined) {
    throw new RecordPlanArtifactError(
      "one of --publisher <address> or --plan-id <bytes32> is required to identify the registered plan"
    );
  }
  return { chainId, planId, planHash, artifact };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verboseRequested = argv.includes("--verbose");
  let databaseUrl: string | undefined;
  try {
    const args = parseRecordPlanArtifactArgs(argv);
    const record = buildPlanArtifactRecord(
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
      await new PostgresPlanArtifactStore({ database }).put(record);
    } finally {
      await database.close();
    }
    process.stdout.write(successLine(record, true));
  } catch (error) {
    process.stderr.write(
      `record-plan-artifact failed: ${describeFailure(error, databaseUrl)}\n`
    );
    if (verboseRequested && error instanceof Error && error.stack) {
      process.stderr.write(`${redactText(error.stack, databaseUrl)}\n`);
    }
    process.exitCode = 1;
  }
}

function successLine(record: PlanArtifactRecord, recorded: boolean): string {
  return `${JSON.stringify({
    chainId: record.chainId,
    planId: record.planId,
    planHash: record.planHash,
    recorded
  })}\n`;
}

async function readArtifactFile(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new RecordPlanArtifactError(`cannot read artifact file ${file}: ${errorMessage(error)}`);
  }
}

function parseArtifactJson(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new RecordPlanArtifactError(
      `artifact file ${file} is not valid JSON: ${errorMessage(error)}`
    );
  }
}

function requireDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const databaseUrl = env.CHAIN_SERVICES_DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new RecordPlanArtifactError(
      "CHAIN_SERVICES_DATABASE_URL is required to record a plan artifact: export the Postgres DSN " +
        "for the database that holds plan_artifacts"
    );
  }
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new RecordPlanArtifactError(
      "CHAIN_SERVICES_DATABASE_URL must be a postgres:// or postgresql:// DSN"
    );
  }
  return databaseUrl;
}

function describeFailure(error: unknown, databaseUrl: string | undefined): string {
  const message = redactText(errorMessage(error), databaseUrl).replace(/\s+/g, " ").trim();
  const detail = message.length > 0 ? message : "unknown error";
  return isMissingPlanArtifactsTable(error)
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

function isMissingPlanArtifactsTable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { readonly code?: unknown }).code;
  return code === "42P01" || /relation "plan_artifacts" does not exist/i.test(error.message);
}

function parseChainId(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new RecordPlanArtifactError("--chain-id must be a positive integer");
  }
  return requireChainId(Number(raw));
}

function requireChainId(chainId: number): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new RecordPlanArtifactError("chainId must be a positive safe integer");
  }
  return chainId;
}

function requireBytes32(value: string, field: string): Hex {
  try {
    return normalizeBytes32(value, field);
  } catch (error) {
    throw new RecordPlanArtifactError(errorMessage(error));
  }
}

function requireAddress(value: string, field: string): Hex {
  try {
    return normalizeAddress(value, field);
  } catch (error) {
    throw new RecordPlanArtifactError(errorMessage(error));
  }
}

function asRecordPlanArtifactError(subject: string, error: unknown): Error {
  if (error instanceof OnchainHookPlanArtifactValidationError) {
    return new RecordPlanArtifactError(`${subject} rejected: ${error.message}`);
  }
  return error instanceof Error ? error : new RecordPlanArtifactError(`invalid ${subject}`);
}

function takeOnce<T>(current: T | undefined, next: () => T, flag: string): T {
  if (current !== undefined) {
    throw new RecordPlanArtifactError(`${flag} was provided more than once`);
  }
  return next();
}

function rejectInlineValue(flag: string, inlineValue: string | undefined): void {
  if (inlineValue !== undefined) {
    throw new RecordPlanArtifactError(`${flag} does not take a value`);
  }
}

if (isDirectRun(import.meta.url)) {
  void main();
}
