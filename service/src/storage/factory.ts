import { basename, join } from "node:path";
import type { DatabaseConfig } from "../config/index.js";
import type { EvidenceMetadataStore } from "../evidence/store.js";
import { PostgresEvidenceStore } from "../evidence/postgres-store.js";
import type { GovernanceStore } from "../governance/store.js";
import { PostgresGovernanceStore } from "../governance/postgres-store.js";
import {
  PostgresOrderStore,
  type OrderStore
} from "../order/index.js";
import { PostgresProductBffStore } from "../product/query/bff/postgres-store.js";
import type { ProductBffStore } from "../product/query/bff/store.js";
import {
  PostgresOrderRequirementsStore,
  type OrderRequirementsStore
} from "../product/requirements/index.js";
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
import {
  PostgresStoreWalletSessionStore,
  type StoreWalletSessionStore
} from "../store/sessions/index.js";
import type {
  StoreIdentityDescriptorSnapshotStore
} from "../governance/descriptors.js";
import { PostgresStoreIdentityDescriptorSnapshotStore } from "../governance/descriptors-postgres-store.js";
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
  readonly productBffStore: ProductBffStore;
  /** 订单域（配置注册/草稿/阶段/slot/邀请/订单）持久化 store。 */
  readonly orderStore: OrderStore;
  /** V1 订单要求包（声明/合意）持久化 store。 */
  readonly orderRequirementsStore: OrderRequirementsStore;
  /** 证据元数据持久化（链事件重放可重建）。 */
  readonly evidenceMetadataStore: EvidenceMetadataStore;
  readonly submissionStore: ProductSubmissionStore;
  readonly governanceStore: GovernanceStore;
  /** 钱包会话 / descriptor 快照的持久化 store。 */
  readonly storeWalletSessionStore: StoreWalletSessionStore;
  readonly identityDescriptorSnapshots: StoreIdentityDescriptorSnapshotStore;
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
    productBffStore: new PostgresProductBffStore({ database }),
    orderStore: new PostgresOrderStore({ database }),
    orderRequirementsStore: new PostgresOrderRequirementsStore({ database }),
    evidenceMetadataStore: new PostgresEvidenceStore({ database }),
    submissionStore: new PostgresSubmissionStore({ database }),
    governanceStore: new PostgresGovernanceStore({ database }),
    storeWalletSessionStore: new PostgresStoreWalletSessionStore({ database }),
    identityDescriptorSnapshots: new PostgresStoreIdentityDescriptorSnapshotStore({ database }),
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
