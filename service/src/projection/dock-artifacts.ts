// dock_artifacts 是 uvp.dock.v1 Dock 文档的可重建链下读投影：按 (chain_id,
// dkid, doc_hash) 内容寻址保存 uvp-core analyzeDock 产物；索引 DockRegistered
// 时按链上身份取用，缺失或身份不一致即 fail-closed。链上 UVPDockRegistry 仍是
// Dock 存在性的权威，其 dkid 是 bytes32(bytes16(docHash))：本表以该链上
// bytes32 作为 dkid 键，uvp.dock.v1 的 `zd-<docHash 前 32 hex>` 只作为产物
// 文档身份校验。
import { assertDockArtifact, type DockArtifact } from "@uvp-eth/compiler";
import { normalizeBytes32, rowObject, stringColumn, type Hex } from "@uvp-eth/service-runtime";
import type { PostgresDatabase } from "../storage/postgres-client.js";

export interface DockArtifactRecord {
  readonly chainId: number;
  readonly docHash: Hex;
  readonly artifact: DockArtifact;
}

export interface DockArtifactQuery {
  readonly chainId: number;
  readonly dkid: Hex;
  readonly docHash: Hex;
}

export interface DockArtifactStore {
  put(record: DockArtifactRecord): Promise<boolean>;
  get(query: DockArtifactQuery): Promise<DockArtifactRecord | undefined>;
}

export class DockArtifactValidationError extends Error {
  override readonly name = "DockArtifactValidationError";

  constructor(readonly issues: readonly string[]) {
    super(issues.join("; "));
  }
}

export class DockArtifactMissingError extends Error {
  override readonly name = "DockArtifactMissingError";

  constructor(readonly query: DockArtifactQuery) {
    super(
      `no recorded uvp.dock.v1 artifact for chain ${query.chainId} dock ${query.dkid} docHash ${query.docHash}: the dock projection is unverifiable and the replay fails closed`
    );
  }
}

export class DockArtifactIdentityError extends Error {
  override readonly name = "DockArtifactIdentityError";

  constructor(
    readonly docHash: Hex,
    readonly artifactDocHash: Hex
  ) {
    super(
      `recorded uvp.dock.v1 artifact docHash ${artifactDocHash} does not match the on-chain DockRegistered docHash ${docHash}: the key must be the dock's own content identity`
    );
  }
}

export function assertDockArtifactRecord(artifact: unknown): DockArtifact {
  try {
    assertDockArtifact(artifact);
  } catch (error) {
    if (error instanceof Error && "issues" in error) {
      const issues = (error as { readonly issues?: readonly unknown[] }).issues;
      if (Array.isArray(issues)) {
        throw new DockArtifactValidationError(issues.map((issue) => String(issue)));
      }
    }
    throw error;
  }
  return artifact;
}

export function dockArtifactDkidOf(docHash: Hex): string {
  return `zd-${docHash.slice(2, 34).toLowerCase()}`;
}

export function canonicalDockIdOf(docHash: Hex): Hex {
  return `0x${docHash.slice(2, 34).toLowerCase()}${"0".repeat(32)}` as Hex;
}

export class PostgresDockArtifactStore implements DockArtifactStore {
  readonly #database: PostgresDatabase;

  constructor(options: { readonly database: PostgresDatabase }) {
    this.#database = options.database;
  }

  async put(record: DockArtifactRecord): Promise<boolean> {
    const docHash = normalizeBytes32(record.docHash, "dockArtifact.docHash");
    const artifact = assertDockArtifactRecord(record.artifact);
    if (artifact.docHash.toLowerCase() !== docHash) {
      throw new DockArtifactIdentityError(docHash, artifact.docHash as Hex);
    }
    const result = await this.#database.query(
      `INSERT INTO dock_artifacts (chain_id, dkid, doc_hash, artifact_json, recorded_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (chain_id, dkid, doc_hash) DO NOTHING`,
      [
        record.chainId,
        canonicalDockIdOf(docHash),
        docHash,
        JSON.stringify(artifact),
        new Date().toISOString()
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async get(query: DockArtifactQuery): Promise<DockArtifactRecord | undefined> {
    const dkid = normalizeBytes32(query.dkid, "dockArtifact.dkid");
    const docHash = normalizeBytes32(query.docHash, "dockArtifact.docHash");
    const result = await this.#database.query(
      `SELECT artifact_json::text AS artifact_json
       FROM dock_artifacts
       WHERE chain_id = $1 AND doc_hash = $2 AND (dkid = $3 OR dkid = $4)
       LIMIT 1`,
      [query.chainId, docHash, dkid, canonicalDockIdOf(docHash)]
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const artifact = JSON.parse(
      stringColumn(rowObject(row, "dock_artifacts query"), "artifact_json")
    ) as DockArtifact;
    return {
      chainId: query.chainId,
      docHash,
      artifact
    };
  }
}

export interface DockArtifactResolver {
  readonly resolveDockArtifact: (dkid: Hex, docHash: Hex) => Promise<DockArtifact>;
}

export function createDockArtifactResolver(options: {
  readonly store: DockArtifactStore;
  readonly chainId: number;
}): DockArtifactResolver {
  return {
    async resolveDockArtifact(dkid, docHash) {
      const record = await options.store.get({
        chainId: options.chainId,
        dkid,
        docHash
      });
      if (!record) {
        throw new DockArtifactMissingError({
          chainId: options.chainId,
          dkid,
          docHash
        });
      }
      return record.artifact;
    }
  };
}
