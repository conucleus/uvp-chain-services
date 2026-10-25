// 配置发布元数据：只产出 configId/version/configHash/planId/planHash。

import type { Hex } from "../shared/types.js";

export interface PublishMetadata {
  readonly schema: "uvp.order-config-publish/v3";
  readonly configId: string;
  readonly version: string;
  readonly planId: Hex;
  readonly planHash: Hex;
}

export function buildPublishMetadata(input: {
  readonly config: { readonly configId: string; readonly version: string };
  readonly planId: Hex;
  readonly planHash: Hex;
}): PublishMetadata {
  return {
    schema: "uvp.order-config-publish/v3",
    configId: input.config.configId,
    version: input.config.version,
    planId: input.planId,
    planHash: input.planHash,
  };
}
