// 计划编译产物单源：plan_artifacts 按 (chain_id, plan_id, plan_hash) 内容寻址
// 保存编译器产出的 OnchainHookPlanArtifact，索引重建与提交造证只读本表，
// 不再读 Store authoring 草稿；缺失即 PlanArtifactMissingError（fail-closed）。
import {
  capabilityTablesOf,
  toSolidityRegisterPlanArgs,
  type OnchainHookPlanArtifact
} from "@uvp-eth/compiler";
import type { PlanCapabilityTablesInput } from "../indexer/projections/plan.js";
import type { SemanticOraclePlan } from "../indexer/semantic-oracle.js";
import { normalizeBytes32, normalizeAddress, type Hex } from "@uvp-eth/service-runtime";
import type { PostgresDatabase } from "../storage/postgres-client.js";
import { rowObject, stringColumn } from "@uvp-eth/service-runtime";

export interface PlanArtifactRecord {
  readonly chainId: number;
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly artifact: OnchainHookPlanArtifact;
}

export interface PlanArtifactQuery {
  readonly chainId: number;
  readonly planId: Hex;
  readonly planHash: Hex;
}

export interface PlanArtifactStore {
  put(record: PlanArtifactRecord): Promise<void>;
  get(query: PlanArtifactQuery): Promise<PlanArtifactRecord | undefined>;
}

export class PlanArtifactMissingError extends Error {
  override readonly name = "PlanArtifactMissingError";

  constructor(readonly query: PlanArtifactQuery) {
    super(
      `no compiled plan artifact recorded for chain ${query.chainId} plan ${query.planId} hash ${query.planHash}: the plan vocabulary is unverifiable and the operation fails closed`
    );
  }
}

export class PlanArtifactIdentityError extends Error {
  override readonly name = "PlanArtifactIdentityError";

  constructor(
    readonly planHash: Hex,
    readonly artifactPlanHash: Hex
  ) {
    super(
      `plan artifact hash ${artifactPlanHash} does not match the recorded plan hash ${planHash}: the key must be the plan's own compilation identity`
    );
  }
}

export class PostgresPlanArtifactStore implements PlanArtifactStore {
  readonly #database: PostgresDatabase;

  constructor(options: { readonly database: PostgresDatabase }) {
    this.#database = options.database;
  }

  async put(record: PlanArtifactRecord): Promise<void> {
    const planHash = normalizeBytes32(record.planHash, "planArtifact.planHash");
    const artifactPlanHash = toSolidityRegisterPlanArgs(record.artifact).planHash;
    if (artifactPlanHash.toLowerCase() !== planHash.toLowerCase()) {
      throw new PlanArtifactIdentityError(planHash, artifactPlanHash as Hex);
    }
    await this.#database.query(
      `INSERT INTO plan_artifacts (chain_id, plan_id, plan_hash, artifact_json, recorded_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (chain_id, plan_id, plan_hash) DO NOTHING`,
      [
        record.chainId,
        normalizeBytes32(record.planId, "planArtifact.planId"),
        planHash,
        JSON.stringify(record.artifact),
        new Date().toISOString()
      ]
    );
  }

  async get(query: PlanArtifactQuery): Promise<PlanArtifactRecord | undefined> {
    const result = await this.#database.query(
      `SELECT artifact_json::text AS artifact_json
       FROM plan_artifacts
       WHERE chain_id = $1 AND plan_id = $2 AND plan_hash = $3`,
      [
        query.chainId,
        normalizeBytes32(query.planId, "planArtifact.planId"),
        normalizeBytes32(query.planHash, "planArtifact.planHash")
      ]
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      chainId: query.chainId,
      planId: normalizeBytes32(query.planId, "planArtifact.planId"),
      planHash: normalizeBytes32(query.planHash, "planArtifact.planHash"),
      artifact: JSON.parse(stringColumn(rowObject(row, "plan_artifacts query"), "artifact_json")) as OnchainHookPlanArtifact
    };
  }
}

export interface PlanArtifactResolvers {
  readonly resolvePlanCapabilityTables: (planId: Hex, planHash: Hex) => Promise<PlanCapabilityTablesInput>;
  readonly resolveSemanticOraclePlan: (planId: Hex, planHash: Hex) => Promise<SemanticOraclePlan>;
}

export function createPlanArtifactResolvers(options: {
  readonly store: PlanArtifactStore;
  readonly chainId: number;
}): PlanArtifactResolvers {
  const require = async (planId: Hex, planHash: Hex): Promise<PlanArtifactRecord> => {
    const query = { chainId: options.chainId, planId, planHash };
    const record = await options.store.get(query);
    if (!record) {
      throw new PlanArtifactMissingError(query);
    }
    return record;
  };
  return {
    async resolvePlanCapabilityTables(planId, planHash) {
      const record = await require(planId, planHash);
      const candidates = record.artifact.executorCandidates.map((candidate) => ({
        stageId: normalizeBytes32(candidate.stageId, "executorCandidate.stageId"),
        executor: normalizeAddress(candidate.executor, "executorCandidate.executor")
      }));
      return {
        planId: record.planId,
        planHash: record.planHash,
        ...capabilityTablesOf(record.artifact),
        ...(candidates.length > 0 ? { executorCandidates: candidates } : {})
      };
    },
    async resolveSemanticOraclePlan(planId, planHash) {
      const record = await require(planId, planHash);
      return semanticOraclePlanOf(record);
    }
  };
}

function semanticOraclePlanOf(record: PlanArtifactRecord): SemanticOraclePlan {
  const artifact = record.artifact;
  return {
    planId: record.planId,
    zhixuId: artifact.zhixuId,
    compiledHooks: artifact.compiledHooks.map((hook) => ({
      hookId: hook.hookId,
      stageId: hook.stageId,
      stageIdentifier: hook.stageIdentifier,
      hookName: hook.hookName,
      orderTriggerKind: hook.orderTriggerKind,
      emitReady: hook.emitReady,
      instructions: hook.instructions as unknown as readonly Record<string, unknown>[]
    })),
    dependencyIndex: artifact.dependencyIndex,
    admissions: artifact.admissions.map((admission) => ({
      admissionId: admission.admissionId,
      stageIdentifier: admission.stageIdentifier,
      signalName: admission.signalName,
      instructions: admission.instructions as unknown as readonly Record<string, unknown>[]
    }))
  };
}

export interface RecordPlanArtifactInput {
  readonly planId: Hex;
  readonly planHash: Hex;
  readonly artifact: OnchainHookPlanArtifact;
}

export type PlanArtifactRecorder = (input: RecordPlanArtifactInput) => Promise<void>;
