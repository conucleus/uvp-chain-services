// Bug prevented: dock_artifacts stored the uvp.dock.v1 `zd-…` document id while
// the indexer queried the UVPDockRegistry `bytes32(bytes16(docHash))` id, so a
// recorded artifact never resolved and every DockRegistered aborted the replay;
// the same replay then crashed on nested uint64 tuple bigints.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256Hex } from "@uvp-eth/compiler";
import { toWire } from "@uvp-eth/chain-read-contract";
import {
  PostgresDockArtifactStore,
  canonicalDockIdOf,
  createDockArtifactResolver,
  DockArtifactIdentityError,
  DockArtifactMissingError
} from "../src/projection/dock-artifacts.js";
import { ViemChainEventSource } from "../src/indexer/viem-event-source.js";
import { IndexerService } from "../src/indexer/service.js";
import type { ChainServicesConfig } from "../src/config/index.js";
import { PostgresProjectionStore } from "../src/storage/postgres.js";
import { createPostgresTestDatabase } from "./postgres.js";
import { PostgresDatabase } from "../src/storage/postgres-client.js";
import { runPostgresMigrations } from "../src/storage/postgres-migrations.js";
import { fileURLToPath } from "node:url";
import {
  dockArtifactFor,
  dockFromSourceId,
  DOCK_FROM_SOURCE,
  DOCK_TO_SOURCE,
  dockToSourceId,
  DOCK_TO_STAGE,
  dockToStageId,
  dockRegisteredLog as dockRegisteredLogFixture
} from "./dock-fixtures.js";

const chainId = 31337;
const dockRegistryAddress = "0x5555555555555555555555555555555555555555";
const docHash = keccak256Hex("dock-document-1");
const dockId = `zd-${docHash.slice(2, 34)}`;

let database: PostgresDatabase;
let store: PostgresDockArtifactStore;

beforeAll(async () => {
  const databaseUrl = await createPostgresTestDatabase();
  database = new PostgresDatabase({ databaseUrl });
  await runPostgresMigrations({
    database,
    migrationsDirectory: fileURLToPath(new URL("../migrations/postgres", import.meta.url))
  });
  store = new PostgresDockArtifactStore({ database });
});

afterAll(async () => {
  await database.close();
});

describe("dock artifact projection seam", () => {
  it("resolves a recorded artifact by the chain-native bytes32 dock id", async () => {
    const artifact = dockArtifact();
    const canonicalDockId = canonicalDockIdOf(docHash);

    expect(canonicalDockId).toBe(`0x${docHash.slice(2, 34)}${"0".repeat(32)}`);
    await expect(store.put({ chainId, docHash, artifact })).resolves.toBe(true);
    await expect(store.put({ chainId, docHash, artifact })).resolves.toBe(false);

    const record = await store.get({ chainId, dkid: canonicalDockId, docHash });
    expect(record?.artifact).toEqual(artifact);
    const scopedDockId = `0x${"f".repeat(64)}` as const;
    const scopedRecord = await store.get({ chainId, dkid: scopedDockId, docHash });
    expect(scopedRecord?.artifact).toEqual(artifact);

    const otherDocHash = keccak256Hex("dock-document-missing");
    await expect(
      store.get({ chainId, dkid: canonicalDockId, docHash: otherDocHash })
    ).resolves.toBeUndefined();

    const resolver = createDockArtifactResolver({ store, chainId });
    await expect(resolver.resolveDockArtifact(scopedDockId, docHash)).resolves.toEqual(artifact);
    await expect(
      resolver.resolveDockArtifact(`0x${"e".repeat(64)}`, otherDocHash)
    ).rejects.toBeInstanceOf(DockArtifactMissingError);
  });

  it("refuses to store an artifact under a docHash it does not carry", async () => {
    const artifact = dockArtifact();
    const otherDocHash = keccak256Hex("dock-document-other");

    const attempt = store.put({ chainId, docHash: otherDocHash, artifact });

    await expect(attempt).rejects.toBeInstanceOf(DockArtifactIdentityError);
    await expect(attempt).rejects.toThrow(otherDocHash);
  });

  it("rebuilds a dock projection from a real DockRegistered tuple log after the artifact is recorded", async () => {
    const artifact = dockArtifact();
    const resolver = createDockArtifactResolver({ store, chainId });
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs() {
          return [dockRegisteredLog()];
        },
        async getBlock() {
          return { hash: `0x${"c".repeat(64)}`, number: 5n };
        }
      }
    });
    const projectionStore = new PostgresProjectionStore({ database, chainId });
    const indexer = new IndexerService({
      config: indexerConfig(),
      eventSource,
      store: projectionStore,
      resolveDockArtifact: resolver.resolveDockArtifact
    });

    const { snapshot, summary } = await indexer.rebuildFromDeploymentBlockWithSummary();

    expect(summary.syncStatus).toBe("indexed");
    expect(snapshot.unknownEventCount).toBe(0);
    expect(snapshot.stateMachineDocks[dockId]).toMatchObject({
      dkid: dockId,
      docHash,
      from: { zhixu: artifact.from.zhixu, source: DOCK_FROM_SOURCE, sourceId: dockFromSourceId },
      to: {
        zhixu: artifact.to.zhixu,
        stage: DOCK_TO_STAGE,
        stageId: dockToStageId,
        source: DOCK_TO_SOURCE,
        sourceId: dockToSourceId
      }
    });
    const dockProof = snapshot.stateMachineDocks[dockId]!.proof;
    expect(dockProof.args.outputs).toContain('"delaySeconds":"15"');
    const outputs = JSON.parse(dockProof.args.outputs as string) as readonly {
      readonly window: readonly { readonly delaySeconds: string }[];
    }[];
    expect(outputs[0]?.window[0]?.delaySeconds).toBe("15");
    expect(() => JSON.stringify(toWire(dockProof))).not.toThrow();
  });

  it("degrades missing or mismatched DockRegistered artifacts per dock without aborting valid docks", async () => {
    const missingDocHash = keccak256Hex("dock-document-missing");
    const missingDockId = `zd-${missingDocHash.slice(2, 34)}`;
    const mismatchedDocHash = keccak256Hex("dock-document-mismatch");
    const mismatchedDockId = `zd-${mismatchedDocHash.slice(2, 34)}`;
    const baseMismatched = dockArtifactFor(mismatchedDocHash);
    const mismatchedArtifact = {
      ...baseMismatched,
      from: {
        ...baseMismatched.from,
        source: "other-source",
        sourceId: keccak256Hex("other-source")
      }
    };
    await store.put({ chainId, docHash: mismatchedDocHash, artifact: mismatchedArtifact });

    const resolver = createDockArtifactResolver({ store, chainId });
    const eventSource = new ViemChainEventSource({
      publicClient: {
        async getBlockNumber() {
          return 0n;
        },
        async getLogs() {
          return [
            dockRegisteredLog(),
            dockRegisteredLogFixture({
              address: dockRegistryAddress,
              docHash: missingDocHash,
              blockNumber: 6n,
              blockHash: `0x${"e".repeat(64)}`,
              transactionHash: `0x${"f".repeat(64)}`,
              logIndex: 0
            }),
            dockRegisteredLogFixture({
              address: dockRegistryAddress,
              docHash: mismatchedDocHash,
              blockNumber: 7n,
              blockHash: `0x${"a".repeat(64)}`,
              transactionHash: `0x${"b".repeat(64)}`,
              logIndex: 0
            })
          ];
        },
        async getBlock() {
          return { hash: `0x${"c".repeat(64)}`, number: 7n };
        }
      }
    });
    const projectionStore = new PostgresProjectionStore({ database, chainId });
    const indexer = new IndexerService({
      config: indexerConfig(),
      eventSource,
      store: projectionStore,
      resolveDockArtifact: resolver.resolveDockArtifact
    });

    const { snapshot, summary } = await indexer.rebuildFromDeploymentBlockWithSummary();

    expect(summary.syncStatus).toBe("indexed");
    expect(snapshot.dockEnrichmentMismatchCount).toBe(2);
    expect(snapshot.stateMachineDocks[dockId]?.enrichment).toBe("enriched");
    expect(snapshot.stateMachineDocks[missingDockId]).toMatchObject({
      dkid: missingDockId,
      enrichment: "failed",
      signalMap: []
    });
    expect(snapshot.stateMachineDocks[mismatchedDockId]).toMatchObject({
      dkid: mismatchedDockId,
      enrichment: "failed",
      signalMap: []
    });
    await expect(projectionStore.getSyncState()).resolves.toMatchObject({
      syncStatus: "indexed",
      projectionDiagnostics: { dockEnrichmentMismatchCount: 2 }
    });
  });
});

function dockArtifact() {
  return dockArtifactFor(docHash);
}

function dockRegisteredLog() {
  return dockRegisteredLogFixture({
    address: dockRegistryAddress,
    docHash,
    blockNumber: 5n,
    blockHash: `0x${"c".repeat(64)}`,
    transactionHash: `0x${"d".repeat(64)}`
  });
}

function indexerConfig(): ChainServicesConfig {
  return {
    network: {
      chainId,
      rpcUrl: "http://127.0.0.1:8545",
      deploymentBlock: 0n,
      finalityAnchor: "confirmations",
      finalityConfirmations: 2,
      contracts: { UVPDockRegistry: dockRegistryAddress }
    },
    database: { url: "postgres://unused", migrationsAutoRun: false },
    api: { host: "127.0.0.1", port: 0, indexerPollIntervalMs: 0 },
    operatorRoles: {},
    security: {
      environment: "local",
      preflightStrict: false,
      logRedactionEnabled: true
    }
  };
}
