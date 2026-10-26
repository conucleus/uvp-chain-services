import { basename, join } from "node:path";
import type { DatabaseConfig } from "../config/index.js";
import type { Address } from "../shared/types.js";
import { PostgresSubmissionStore } from "../submissions/postgres-store.js";
import {
  PostgresBroadcastDedupeStore,
  type BroadcastDedupeStore
} from "../submissions/broadcast-dedupe-postgres-store.js";
import type { ProductSubmissionStore } from "../submissions/types.js";
import {
  PostgresProductStagePatchStore
} from "../stage-patches/postgres-store.js";
import type {
  PreparedStageExecutorPatchRecord,
  PreparedStageResourcePatchRecord,
  ProductStageExecutorPatchStore,
  ProductStageResourcePatchStore,
  StageExecutorPatchSubmissionDTO,
  StageResourcePatchSubmissionDTO
} from "../stage-patches/types.js";
import { PostgresPlanArtifactStore, type PlanArtifactStore } from "../projection/plan-artifacts.js";
import { PostgresDatabase } from "./postgres-client.js";
import { PostgresProjectionStore } from "./postgres.js";
import type { ProjectionStore } from "./projection-store.js";

export interface CreateProjectionStoreOptions {
  readonly database: DatabaseConfig;
  readonly chainId?: number;
  readonly projectionScopeContractAddress?: Address;
  readonly migrationsDirectory?: string;
}

export interface ChainServicesStores {
  readonly projectionStore: ProjectionStore;
  /** 计划编译产物（索引重建/提交造证的唯一 off-chain 权威）。 */
  readonly planArtifactStore: PlanArtifactStore;
  readonly submissionStore: ProductSubmissionStore;
  /** postgres 驱动下提供持久化 broadcast 去重状态。 */
  readonly broadcastDedupeStore: BroadcastDedupeStore;
  /** postgres 驱动下提供持久化 stage-patch 状态。 */
  readonly stageExecutorPatchStore: ProductStageExecutorPatchStore;
  readonly stageResourcePatchStore: ProductStageResourcePatchStore;
  close(): Promise<void>;
}

export function createProjectionStore(options: CreateProjectionStoreOptions): ProjectionStore {
  const postgresDirectory = postgresMigrationsDirectory(options.migrationsDirectory);
  return new PostgresProjectionStore({
    databaseUrl: options.database.url,
    ...(options.chainId !== undefined ? { chainId: options.chainId } : {}),
    ...(options.projectionScopeContractAddress
      ? { projectionScopeContractAddress: options.projectionScopeContractAddress }
      : {}),
    migrations: {
      autoRun: options.database.migrationsAutoRun,
      ...(postgresDirectory ? { directory: postgresDirectory } : {})
    }
  });
}

export function createChainServicesStores(options: CreateProjectionStoreOptions): ChainServicesStores {
  const postgresDirectory = postgresMigrationsDirectory(options.migrationsDirectory);
  const migrations = {
    autoRun: options.database.migrationsAutoRun,
    ...(postgresDirectory ? { directory: postgresDirectory } : {})
  };
  const database = new PostgresDatabase({
    databaseUrl: options.database.url,
    migrations
  });
  const stores = {
    projectionStore: new PostgresProjectionStore({
      database,
      ...(options.chainId !== undefined ? { chainId: options.chainId } : {}),
      ...(options.projectionScopeContractAddress
        ? { projectionScopeContractAddress: options.projectionScopeContractAddress }
        : {})
    }),
    planArtifactStore: new PostgresPlanArtifactStore({ database }),
    submissionStore: new PostgresSubmissionStore({ database }),
    broadcastDedupeStore: new PostgresBroadcastDedupeStore({ database }),
    stageExecutorPatchStore: new PostgresProductStagePatchStore<
      PreparedStageExecutorPatchRecord,
      StageExecutorPatchSubmissionDTO
    >({ database, patchKind: "executor" }),
    stageResourcePatchStore: new PostgresProductStagePatchStore<
      PreparedStageResourcePatchRecord,
      StageResourcePatchSubmissionDTO
    >({ database, patchKind: "resource" })
  };
  return {
    ...stores,
    async close() {
      await database.close();
    }
  };
}

function postgresMigrationsDirectory(directory: string | undefined): string | undefined {
  if (!directory) {
    return undefined;
  }
  return basename(directory) === "postgres" ? directory : join(directory, "postgres");
}
