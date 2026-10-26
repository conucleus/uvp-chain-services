// stage-patch 键派生单源：prepare 时的 nonce 键与 relay 持久 dedupe 键共用同一
// 组成（kind/chain/stateMachine/order/targetStage/signal/resource/patchNonce），
// 保证同一条 prepared 补丁在重试、重启后落到同一账本行。

import type { Address, Hex } from "../shared/types.js";

export interface StagePatchKeyInput {
  readonly kind: "executor" | "resource";
  readonly chainId: number;
  readonly stateMachineAddress: Address;
  readonly orderId: Hex;
  readonly targetStageId: Hex;
  readonly targetSignalId?: Hex;
  readonly resourceKey?: Hex;
  readonly patchNonce: string;
}

export function stagePatchNonceKey(input: StagePatchKeyInput): string {
  return [
    input.kind,
    input.chainId,
    input.stateMachineAddress,
    input.orderId,
    input.targetStageId,
    input.targetSignalId ?? "",
    input.resourceKey ?? "",
    input.patchNonce
  ].join(":");
}
