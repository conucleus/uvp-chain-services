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
import { PostgresNotificationStateStore } from "../notifications/postgres-store.js";
import type {
  NotificationDeliveryStore,
  ParticipantNotificationReadStateStore
} from "../notifications/service.js";
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
import {
  PostgresStoreSupplierMetadataStore,
  type StoreSupplierMetadataStore
} from "../store/suppliers/index.js";
import {
  PostgresStoreEntityRegistrationStore,
  type StoreEntityRegistrationStore
} from "../store/registration/index.js";
import type {
  StoreDockingSessionStore
} from "../store/console/docking.js";
import type {
  StoreAuditStore
} from "../store/console/audit.js";
import {
  PostgresStoreAuditStore,
  PostgresStoreDockingSessionStore,
  PostgresStoreZhixuDraftStore,
  PostgresStoreZhixuVersionMetadataStore
} from "../store/console/postgres-store.js";
import type { StoreZhixuDraftStore } from "../store/console/zhixu-drafts.js";
import type { StoreZhixuVersionMetadataStore } from "../store/console/version.js";
import {
  PostgresStoreWalletSessionStore,
  type StoreWalletSessionStore
} from "../store/sessions/index.js";
import type {
  StoreZhixuDecorationStore,
  StorePublisherDelegationStore
} from "../store/decoration/index.js";
import type {
  StoreIdentityDescriptorSnapshotStore
} from "../governance/descriptors.js";
import {
  PostgresStoreIdentityDescriptorSnapshotStore,
  PostgresStoreJoinApplicationStore,
  PostgresStoreListingStore,
  PostgresStorePublisherDelegationStore,
  PostgresStoreZhixuDecorationStore
} from "../store-access-postgres-stores.js";
import type { StoreListingStore } from "../store/listings/index.js";
import type { StoreJoinApplicationStore } from "../store/join/index.js";
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
  readonly productBffStore: ProductBffStore;
  /** 订单域（配置注册/草稿/阶段/slot/邀请/订单）持久化 store。 */
  readonly orderStore: OrderStore;
  /** V1 订单要求包（声明/合意）持久化 store。 */
  readonly orderRequirementsStore: OrderRequirementsStore;
  /** 证据元数据持久化（链事件重放可重建）。 */
  readonly evidenceMetadataStore: EvidenceMetadataStore;
  readonly submissionStore: ProductSubmissionStore;
  readonly governanceStore: GovernanceStore;
  readonly storeZhixuDraftStore: StoreZhixuDraftStore;
  readonly storeZhixuVersionMetadataStore: StoreZhixuVersionMetadataStore;
  readonly storeSupplierMetadataStore: StoreSupplierMetadataStore;
  /** 参与者实体自助登记（链下档案，未核验）。 */
  readonly storeEntityRegistrationStore: StoreEntityRegistrationStore;
  readonly storeDockingSessionStore: StoreDockingSessionStore;
  readonly storeAuditStore: StoreAuditStore;
  /** 钱包会话 / descriptor 快照 / 装修与委托 / 上架 / 加入申请的持久化 store。 */
  readonly storeWalletSessionStore: StoreWalletSessionStore;
  readonly identityDescriptorSnapshots: StoreIdentityDescriptorSnapshotStore;
  readonly storeDecorationStore: StoreZhixuDecorationStore;
  readonly storePublisherDelegationStore: StorePublisherDelegationStore;
  readonly storeListingStore: StoreListingStore;
  readonly storeJoinApplicationStore: StoreJoinApplicationStore;
  /** postgres 驱动下提供持久化通知状态。 */
  readonly notificationStateStore: NotificationDeliveryStore & ParticipantNotificationReadStateStore;
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
    productBffStore: new PostgresProductBffStore({ database }),
    orderStore: new PostgresOrderStore({ database }),
    orderRequirementsStore: new PostgresOrderRequirementsStore({ database }),
    evidenceMetadataStore: new PostgresEvidenceStore({ database }),
    submissionStore: new PostgresSubmissionStore({ database }),
    governanceStore: new PostgresGovernanceStore({ database }),
    storeZhixuDraftStore: new PostgresStoreZhixuDraftStore({ database }),
    storeZhixuVersionMetadataStore: new PostgresStoreZhixuVersionMetadataStore({ database }),
    storeSupplierMetadataStore: new PostgresStoreSupplierMetadataStore({ database }),
    storeEntityRegistrationStore: new PostgresStoreEntityRegistrationStore({ database }),
    storeDockingSessionStore: new PostgresStoreDockingSessionStore({ database }),
    storeAuditStore: new PostgresStoreAuditStore({ database }),
    storeWalletSessionStore: new PostgresStoreWalletSessionStore({ database }),
    identityDescriptorSnapshots: new PostgresStoreIdentityDescriptorSnapshotStore({ database }),
    storeDecorationStore: new PostgresStoreZhixuDecorationStore({ database }),
    storePublisherDelegationStore: new PostgresStorePublisherDelegationStore({ database }),
    storeListingStore: new PostgresStoreListingStore({ database }),
    storeJoinApplicationStore: new PostgresStoreJoinApplicationStore({ database }),
    notificationStateStore: new PostgresNotificationStateStore({ database }),
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
