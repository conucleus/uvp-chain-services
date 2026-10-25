// V3 证据/验收：只认 config fileResources 句柄 + 显式验收 signal；不要求
// 句柄解析在授权后发生，失败态与空分开；不在响应中
// 下发 locator/URI。

import type { ConfigFileResourceRefV3 } from "@uvp-eth/product-dto";
import type { Address } from "../shared/types.js";
import { OrderV3Error } from "../order/v3/types.js";
import type { OrderV3VisibilitySnapshot } from "../order/v3/service.js";
import type { ResourceResolution, ResourceResolverPort, VisibilityResolver } from "../visibility/types.js";
import type { V3SignalCandidate, V3SignalService } from "./signal-service.js";

export interface V3AcceptanceHandle {
  readonly handleKey: string;
  readonly state: "ok" | "empty";
}

export interface V3AcceptanceValidation {
  readonly validated: true;
  readonly stageKey: string;
  readonly signal: V3SignalCandidate;
  readonly dataState: "ok" | "none";
  readonly handles: readonly V3AcceptanceHandle[];
}

export interface V3EvidenceServiceOptions {
  readonly visibility: VisibilityResolver;
  readonly signals: V3SignalService;
  readonly loadOrder: (orderId: string) => Promise<OrderV3VisibilitySnapshot | undefined>;
  readonly resourceResolver?: ResourceResolverPort;
}

export interface V3EvidenceService {
  validateAcceptance(input: {
    readonly orderId: string;
    readonly stageKey: string;
    readonly wallet: Address;
    readonly signalName: string;
    readonly handleKeys?: readonly string[];
  }): Promise<V3AcceptanceValidation>;
}

export function createV3EvidenceService(options: V3EvidenceServiceOptions): V3EvidenceService {
  return {
    async validateAcceptance(input) {
      // 先授权 signal（含 stage scope），再检查/解析句柄。
      const signal = await options.signals.authorize({
        orderId: input.orderId,
        stageKey: input.stageKey,
        wallet: input.wallet,
        signalName: input.signalName,
      });
      const snapshot = await options.loadOrder(input.orderId);
      if (!snapshot) {
        throw new OrderV3Error(404, "order_not_found", "order was not found");
      }
      const stageConfig = snapshot.config.stages.find((stage) => stage.key === input.stageKey);
      const declared = new Map((stageConfig?.fileResources ?? []).map((resource) => [handleKeyOf(resource), resource]));
      const requested = input.handleKeys ?? [];
      for (const handleKey of requested) {
        if (!declared.has(handleKey)) {
          throw new OrderV3Error(404, "handle_not_found", "file handle was not found on this stage", { handleKey });
        }
      }
      if (requested.length === 0) {
        return { validated: true, stageKey: input.stageKey, signal, dataState: "none", handles: [] };
      }
      if (!options.resourceResolver) {
        throw new OrderV3Error(503, "resolver_unavailable", "file resource resolver is not configured", {
          retryable: false,
        });
      }
      const handles: V3AcceptanceHandle[] = [];
      for (const handleKey of requested) {
        let resolution: ResourceResolution;
        try {
          resolution = await options.resourceResolver.resolve({
            orderId: input.orderId,
            stageKey: input.stageKey,
            handleKey,
            wallet: input.wallet,
          });
        } catch (error) {
          throw new OrderV3Error(503, "resource_unavailable", `file resource resolver failed: ${messageOf(error)}`, {
            retryable: true,
          });
        }
        switch (resolution.kind) {
          case "ok":
            handles.push({ handleKey, state: "ok" });
            break;
          case "empty":
            handles.push({ handleKey, state: "empty" });
            break;
          case "not_found":
            throw new OrderV3Error(404, "handle_not_found", "file handle was not found");
          case "forbidden":
            throw new OrderV3Error(403, "resource_forbidden", "the current scope cannot resolve this file handle");
          case "resolve_failed":
            throw new OrderV3Error(502, "resource_parse_failed", "file handle could not be parsed");
          case "unavailable":
            throw new OrderV3Error(503, "resource_unavailable", "file resource resolver is unavailable", {
              retryable: true,
            });
        }
      }
      return {
        validated: true,
        stageKey: input.stageKey,
        signal,
        dataState: handles.some((handle) => handle.state === "ok") ? "ok" : "none",
        handles,
      };
    },
  };
}

function handleKeyOf(resource: ConfigFileResourceRefV3 | string): string {
  return typeof resource === "string" ? resource : (resource.name ?? resource.ref);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
