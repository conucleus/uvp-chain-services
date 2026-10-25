// Minimal fileResources resolver. Handles come from the published config;
// authorization is re-checked here. The result never contains a locator: only
// ok/empty/not_found/forbidden/resolve_failed/unavailable.

import { createHash } from "node:crypto";
import type { ConfigFileResourceRef, ConfigStage } from "@uvp-eth/product-dto";
import type { Address } from "../shared/types.js";
import type { OrderVisibilitySnapshot } from "../order/service.js";
import { createVisibilityResolver } from "../visibility/resolver.js";
import type { ResourceResolution, ResourceResolverPort } from "../visibility/types.js";

export interface ResourceStoragePort {
  read(input: { readonly ref: string }): Promise<Uint8Array | undefined>;
}

export interface ResourceResolverOptions {
  readonly loadOrder: (orderId: string) => Promise<OrderVisibilitySnapshot | undefined>;
  readonly operatorWallets?: readonly Address[];
  readonly storage?: ResourceStoragePort;
}

export function createResourceResolver(options: ResourceResolverOptions): ResourceResolverPort {
  const visibility = createVisibilityResolver({
    loadOrder: options.loadOrder,
    ...(options.operatorWallets !== undefined ? { operatorWallets: options.operatorWallets } : {}),
  });

  return {
    async resolve(input): Promise<ResourceResolution> {
      const decision = await visibility.resolveVisibility(
        input.orderId,
        input.stageKey,
        input.wallet.toLowerCase() as Address,
      );
      if (decision.scope === "operator" || !decision.allowed.evidenceHandles) {
        return { kind: "forbidden" };
      }
      const snapshot = await options.loadOrder(input.orderId);
      if (!snapshot) {
        return { kind: "not_found" };
      }
      const stage = snapshot.config.stages.find((candidate) => candidate.key === input.stageKey);
      if (!stage) {
        return { kind: "not_found" };
      }
      const handle = findHandle(stage, input.handleKey);
      if (!handle) {
        return { kind: "not_found" };
      }
      if (!options.storage) {
        return { kind: "unavailable", message: "external_storage_unavailable" };
      }
      let bytes: Uint8Array | undefined;
      try {
        bytes = await options.storage.read({ ref: handle.ref });
      } catch (error) {
        return {
          kind: "unavailable",
          message: error instanceof Error ? error.message : "storage_read_failed",
        };
      }
      if (bytes === undefined) {
        return { kind: "not_found" };
      }
      if (bytes.byteLength === 0) {
        return { kind: "empty" };
      }
      const computedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (handle.hash !== undefined && !hashMatches(handle.hash, computedHash)) {
        return { kind: "resolve_failed", message: "content_hash_mismatch" };
      }
      return { kind: "ok", contentHash: handle.hash ?? computedHash };
    },
  };
}

export function findHandle(
  stage: ConfigStage,
  handleKey: string,
): ConfigFileResourceRef | undefined {
  const entry = (stage.fileResources ?? []).find((candidate) => {
    const value = typeof candidate === "string" ? candidate : (candidate.name ?? candidate.ref);
    return value === handleKey;
  });
  if (entry === undefined) {
    return undefined;
  }
  return typeof entry === "string" ? { ref: entry } : entry;
}

function hashMatches(expected: string, computed: string): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  const normalizedComputed = computed.toLowerCase();
  if (normalizedExpected === normalizedComputed) {
    return true;
  }
  const expectedHex = normalizedExpected.startsWith("sha256:")
    ? normalizedExpected.slice("sha256:".length)
    : normalizedExpected.replace(/^0x/u, "");
  const computedHex = normalizedComputed.startsWith("sha256:")
    ? normalizedComputed.slice("sha256:".length)
    : normalizedComputed.replace(/^0x/u, "");
  return expectedHex === computedHex;
}
