import { basename, join } from "node:path";
import type { DatabaseConfig } from "../config/index.js";
import { InMemoryEvidenceMetadataStore, type EvidenceMetadataStore } from "../evidence/store.js";
import { PostgresEvidenceStore } from "../evidence/postgres-store.js";
import { InMemoryGovernanceStore, type GovernanceStore } from "../governance/store.js";
import { PostgresGovernanceStore } from "../governance/postgres-store.js";
import { SqliteGovernanceStore } from "../governance/sqlite-store.js";
import { PostgresProductBffStore } from "../product/bff/postgres-store.js";
import { SqliteProductBffStore } from "../product/bff/sqlite-store.js";
import { MemoryProductBffStore, type ProductBffStore } from "../product/bff/store.js";
import type { Address } from "../shared/types.js";
import { InMemoryProductSubmissionStore } from "../submissions/store.js";
import { PostgresSubmissionStore } from "../submissions/postgres-store.js";
import { SqliteSubmissionStore } from "../submissions/sqlite-store.js";
import { SqliteBroadcastDedupeStore, type BroadcastDedupeStore } from "../submissions/broadcast-dedupe-sqlite-store.js";
import { PostgresBroadcastDedupeStore } from "../submissions/broadcast-dedupe-postgres-store.js";
import type { ProductSubmissionStore } from "../submissions/types.js";
import { SqliteNotificationStateStore } from "../notifications/sqlite-store.js";
import { PostgresNotificationStateStore } from "../notifications/postgres-store.js";
import type {
  NotificationDeliveryStore,
  ParticipantNotificationReadStateStore
} from "../notifications/service.js";
import {
  InMemoryStoreSupplierMetadataStore,
  PostgresStoreSupplierMetadataStore,
  SqliteStoreSupplierMetadataStore,
  type StoreSupplierMetadataStore
} from "../store-suppliers/index.js";
import {
  MemoryStoreDockingSessionStore,
  type StoreDockingSessionStore
} from "../store-console/docking.js";
import {
  MemoryStoreAuditStore,
  type StoreAuditStore
} from "../store-console/audit.js";
import {
  PostgresStoreAuditStore,
  PostgresStoreDockingSessionStore,
  PostgresStoreZhixuDraftStore,
  PostgresStoreZhixuVersionMetadataStore
} from "../store-console/postgres-store.js";
import {
  SqliteStoreAuditStore,
  SqliteStoreDockingSessionStore,
  SqliteStoreZhixuDraftStore,
  SqliteStoreZhixuVersionMetadataStore
} from "../store-console/sqlite-store.js";
import { MemoryStoreZhixuDraftStore, type StoreZhixuDraftStore } from "../store-console/zhixu-drafts.js";
import { MemoryStoreZhixuVersionMetadataStore, type StoreZhixuVersionMetadataStore } from "../store-console/version.js";
import { SqliteEvidenceStore } from "../evidence/sqlite-store.js";
import { PostgresDatabase } from "./postgres-client.js";
import { PostgresProjectionStore } from "./postgres.js";
import { MemoryProjectionStore, type ProjectionStore } from "./projection-store.js";
import { SqliteProjectionStore } from "./sqlite-projection-store.js";
import type { StorageAdapterLifecycle } from "./types.js";

export interface CreateProjectionStoreOptions {
  readonly database: DatabaseConfig;
  readonly chainId?: number;
  readonly projectionScopeContractAddress?: Address;
  readonly migrationsDirectory?: string;
}

export interface ChainServicesStores {
  readonly projectionStore: ProjectionStore;
  readonly productBffStore: ProductBffStore;
  readonly evidenceMetadataStore: EvidenceMetadataStore;
  readonly submissionStore: ProductSubmissionStore;
  readonly governanceStore: GovernanceStore;
  readonly storeZhixuDraftStore: StoreZhixuDraftStore;
  readonly storeZhixuVersionMetadataStore: StoreZhixuVersionMetadataStore;
  readonly storeSupplierMetadataStore: StoreSupplierMetadataStore;
  readonly storeDockingSessionStore: StoreDockingSessionStore;
  readonly storeAuditStore: StoreAuditStore;
  /** ETH-04(b)：sqlite/postgres 驱动下提供持久化通知状态；其余驱动为 undefined（内存）。 */
  readonly notificationStateStore?: NotificationDeliveryStore & ParticipantNotificationReadStateStore;
  /** ETH-07：sqlite/postgres 驱动下提供持久化 broadcast 去重状态；其余驱动为 undefined。 */
  readonly broadcastDedupeStore?: BroadcastDedupeStore;
  close(): Promise<void>;
}

export function createProjectionStore(options: CreateProjectionStoreOptions): ProjectionStore {
  switch (options.database.driver) {
    case "memory":
      return new MemoryProjectionStore();
    case "sqlite":
      return new SqliteProjectionStore({
        databaseUrl: options.database.url,
        ...(options.chainId !== undefined ? { chainId: options.chainId } : {}),
        ...(options.projectionScopeContractAddress
          ? { projectionScopeContractAddress: options.projectionScopeContractAddress }
          : {}),
        migrations: {
          autoRun: options.database.migrationsAutoRun,
          ...(options.migrationsDirectory ? { directory: options.migrationsDirectory } : {})
        }
      });
    case "postgres": {
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
  }
}

export function createChainServicesStores(options: CreateProjectionStoreOptions): ChainServicesStores {
  switch (options.database.driver) {
    case "memory": {
      return {
        projectionStore: new MemoryProjectionStore(),
        productBffStore: new MemoryProductBffStore(),
        evidenceMetadataStore: new InMemoryEvidenceMetadataStore(),
        submissionStore: new InMemoryProductSubmissionStore(),
        governanceStore: new InMemoryGovernanceStore(),
        storeZhixuDraftStore: new MemoryStoreZhixuDraftStore(),
        storeZhixuVersionMetadataStore: new MemoryStoreZhixuVersionMetadataStore(),
        storeSupplierMetadataStore: new InMemoryStoreSupplierMetadataStore(),
        storeDockingSessionStore: new MemoryStoreDockingSessionStore(),
        storeAuditStore: new MemoryStoreAuditStore(),
        async close() {
          return undefined;
        }
      };
    }
    case "sqlite": {
      const migrations = {
        autoRun: options.database.migrationsAutoRun,
        ...(options.migrationsDirectory ? { directory: options.migrationsDirectory } : {})
      };
      const stores = {
        projectionStore: new SqliteProjectionStore({
          databaseUrl: options.database.url,
          ...(options.chainId !== undefined ? { chainId: options.chainId } : {}),
          ...(options.projectionScopeContractAddress
            ? { projectionScopeContractAddress: options.projectionScopeContractAddress }
            : {}),
          migrations
        }),
        productBffStore: new SqliteProductBffStore({
          databaseUrl: options.database.url,
          migrations
        }),
        evidenceMetadataStore: new SqliteEvidenceStore({
          databaseUrl: options.database.url,
          migrations
        }),
        submissionStore: new SqliteSubmissionStore({
          databaseUrl: options.database.url,
          migrations
        }),
        governanceStore: new SqliteGovernanceStore({
          databaseUrl: options.database.url,
          migrations
        }),
        storeZhixuDraftStore: new SqliteStoreZhixuDraftStore({
          databaseUrl: options.database.url,
          migrations
        }),
        storeZhixuVersionMetadataStore: new SqliteStoreZhixuVersionMetadataStore({
          databaseUrl: options.database.url,
          migrations
        }),
        storeSupplierMetadataStore: new SqliteStoreSupplierMetadataStore({
          databaseUrl: options.database.url,
          migrations
        }),
        storeDockingSessionStore: new SqliteStoreDockingSessionStore({
          databaseUrl: options.database.url,
          migrations
        }),
        storeAuditStore: new SqliteStoreAuditStore({
          databaseUrl: options.database.url,
          migrations
        }),
        // ETH-04(b)/ETH-07：通知状态与 broadcast 去重状态落 sqlite。
        notificationStateStore: new SqliteNotificationStateStore({
          databaseUrl: options.database.url,
          migrations
        }),
        broadcastDedupeStore: new SqliteBroadcastDedupeStore({
          databaseUrl: options.database.url,
          migrations
        })
      };
      return {
        ...stores,
        async close() {
          await closeStores([
            stores.projectionStore,
            stores.productBffStore,
            stores.evidenceMetadataStore,
            stores.submissionStore,
            stores.governanceStore,
            stores.storeZhixuDraftStore,
            stores.storeZhixuVersionMetadataStore,
            stores.storeSupplierMetadataStore,
            stores.storeDockingSessionStore,
            stores.storeAuditStore,
            stores.notificationStateStore,
            stores.broadcastDedupeStore
          ]);
        }
      };
    }
    case "postgres": {
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
        evidenceMetadataStore: new PostgresEvidenceStore({ database }),
        submissionStore: new PostgresSubmissionStore({ database }),
        governanceStore: new PostgresGovernanceStore({ database }),
        storeZhixuDraftStore: new PostgresStoreZhixuDraftStore({ database }),
        storeZhixuVersionMetadataStore: new PostgresStoreZhixuVersionMetadataStore({ database }),
        storeSupplierMetadataStore: new PostgresStoreSupplierMetadataStore({ database }),
        storeDockingSessionStore: new PostgresStoreDockingSessionStore({ database }),
        storeAuditStore: new PostgresStoreAuditStore({ database }),
        // ETH-04(b)/ETH-07：通知状态与 broadcast 去重状态在生产拓扑（postgres）
        // 同样持久化；表迁移见 migrations/postgres/0013。共享 database 连接，
        // close 由 database.close() 统一负责。
        notificationStateStore: new PostgresNotificationStateStore({ database }),
        broadcastDedupeStore: new PostgresBroadcastDedupeStore({ database })
      };
      return {
        ...stores,
        async close() {
          await database.close();
        }
      };
    }
  }
}

async function closeStores(stores: readonly unknown[]): Promise<void> {
  for (const store of stores) {
    if (isClosableStore(store)) {
      await store.close();
    }
  }
}

function isClosableStore(store: unknown): store is StorageAdapterLifecycle {
  if (!store || typeof store !== "object") {
    return false;
  }
  return "close" in store && typeof (store as { readonly close?: unknown }).close === "function";
}

function postgresMigrationsDirectory(directory: string | undefined): string | undefined {
  if (!directory) {
    return undefined;
  }
  return basename(directory) === "postgres" ? directory : join(directory, "postgres");
}
