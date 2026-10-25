// V3 配置发布元数据：只产出 configId/version/configHash/planId/planHash。

import type { Hex } from "../shared/types.js";

export interface V3PublishMetadata {
  readonly schema: "uvp.order-config-publish/v3";
  readonly configId: string;
  readonly version: string;
  readonly planId: Hex;
  readonly planHash: Hex;
}

export function buildV3PublishMetadata(input: {
  readonly config: { readonly configId: string; readonly version: string };
  readonly planId: Hex;
  readonly planHash: Hex;
}): V3PublishMetadata {
  return {
    schema: "uvp.order-config-publish/v3",
    configId: input.config.configId,
    version: input.config.version,
    planId: input.planId,
    planHash: input.planHash,
  };
}
