// Execute authorization (A only): escrow holds an immutable `factSource`
// contract and calls `hasSettlementFact(orderId, stageId, instructionRef)` (or
// the deployment's equivalent). Once UVP records the fact, ANY relayer may call
// escrow.execute(trancheId, instructionRef); until then it must not be sent.
// There is no privileged EOA path and no path that bypasses the fact source.

import type { SettlementInstructionRecord } from "./types.js";

export interface SettlementFactSource {
  hasSettlementFact(input: {
    readonly planId: string;
    readonly orderId: string;
    readonly stageId: string;
    readonly instructionRef: string;
    readonly kind: string;
  }): Promise<boolean>;
}

export interface ExecuteTrigger {
  confirmFact(input: { readonly instruction: SettlementInstructionRecord }): Promise<boolean>;
}

export function createSettlementFactSourceTrigger(facts: SettlementFactSource): ExecuteTrigger {
  return {
    async confirmFact({ instruction }) {
      return facts.hasSettlementFact({
        planId: instruction.planId,
        orderId: instruction.orderId,
        stageId: instruction.stageId,
        instructionRef: instruction.instructionRef,
        kind: instruction.kind
      });
    }
  };
}
