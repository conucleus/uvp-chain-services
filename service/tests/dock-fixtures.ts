// Dock 测试夹具：uvp.dock.v1 artifact 与真实 UVPDockRegistry.DockRegistered
// 日志都从契约层 ABI / compiler 哈希规则派生，测试不手写第二份 ABI 或身份规则。
import {
  encodeAbiParameters,
  encodeEventTopics,
  type AbiEvent,
  type AbiParameter,
  type Hex,
  type Log
} from "viem";
import { DOCK_REGISTRY_ABI } from "@uvp-eth/protocol-bindings";
import { assertDockArtifact, keccak256Hex, type DockArtifact } from "@uvp-eth/compiler";

export const DOCK_FROM_SOURCE = "buyer";
export const DOCK_TO_SOURCE = "carrier";
export const DOCK_TO_STAGE = "intake";
export const DOCK_FROM_STAGE = "origin";
export const DOCK_FROM_SIGNAL = "approved";
export const DOCK_TO_SIGNAL = "picked";

export const dockFromSourceId = keccak256Hex(DOCK_FROM_SOURCE);
export const dockToSourceId = keccak256Hex(DOCK_TO_SOURCE);
export const dockToStageId = keccak256Hex(DOCK_TO_STAGE);
export const dockFromStageId = keccak256Hex(DOCK_FROM_STAGE);
export const dockFromSignalId = keccak256Hex(`${DOCK_FROM_STAGE}.${DOCK_FROM_SIGNAL}`);
export const dockToSignalId = keccak256Hex(`${DOCK_TO_STAGE}.${DOCK_TO_SIGNAL}`);

export const dockFromPlanId = `0x${"1".repeat(64)}` as Hex;
export const dockToPlanId = `0x${"2".repeat(64)}` as Hex;

export function dockArtifactFor(docHash: Hex): DockArtifact {
  const artifact = {
    schemaVersion: "uvp.dock.v1",
    dkid: `zd-${docHash.slice(2, 34)}`,
    docHash,
    from: {
      zhixu: `zx-${"a".repeat(32)}`,
      source: DOCK_FROM_SOURCE,
      sourceId: dockFromSourceId
    },
    to: {
      zhixu: `zx-${"b".repeat(32)}`,
      stage: DOCK_TO_STAGE,
      stageId: dockToStageId,
      source: DOCK_TO_SOURCE,
      sourceId: dockToSourceId
    },
    signalMap: [
      {
        signal: DOCK_TO_SIGNAL,
        signalId: dockToSignalId,
        sourceId: dockToSourceId,
        stageId: dockToStageId,
        targetOrderRelation: 0 as const,
        rawExpression: `${DOCK_FROM_SOURCE}.${DOCK_FROM_SIGNAL}`,
        ast: {
          raw: `${DOCK_FROM_SOURCE}.${DOCK_FROM_SIGNAL}`,
          source: `${DOCK_FROM_SOURCE}.${DOCK_FROM_SIGNAL}`,
          condition: {
            kind: "signal" as const,
            signalName: `${DOCK_FROM_SOURCE}.${DOCK_FROM_SIGNAL}`
          }
        },
        dependencies: [
          { kind: "positive" as const, source: DOCK_FROM_SOURCE, signalName: DOCK_FROM_SIGNAL }
        ],
        atoms: [
          {
            source: DOCK_FROM_SOURCE,
            sourceId: dockFromSourceId,
            stage: DOCK_FROM_STAGE,
            stageId: dockFromStageId,
            signal: DOCK_FROM_SIGNAL,
            signalId: dockFromSignalId,
            targetOrderRelation: 0 as const
          }
        ]
      }
    ]
  };
  assertDockArtifact(artifact);
  return artifact;
}

export function dockRegisteredLog(input: {
  readonly address: string;
  readonly docHash: Hex;
  readonly blockNumber?: bigint;
  readonly blockHash?: Hex;
  readonly transactionHash?: Hex;
  readonly logIndex?: number;
  readonly delaySeconds?: bigint;
  readonly removed?: boolean;
}): Log {
  const event = dockRegisteredEvent();
  const nonIndexedInputs = event.inputs.filter((entry) => !entry.indexed) as readonly AbiParameter[];
  return {
    address: input.address,
    blockNumber: input.blockNumber ?? 100n,
    blockHash: input.blockHash ?? `0x${"c".repeat(64)}`,
    transactionHash: input.transactionHash ?? `0x${"d".repeat(64)}`,
    transactionIndex: 0,
    logIndex: input.logIndex ?? 0,
    data: encodeAbiParameters(nonIndexedInputs, [
      dockFromSourceId,
      dockToStageId,
      dockToSourceId,
      input.docHash,
      "0x6666666666666666666666666666666666666666",
      [
        {
          signalId: dockToSignalId,
          relation: 0,
          atoms: [{ stageId: dockFromStageId, signalId: dockFromSignalId, relation: 0 }],
          window: [
            {
              op: 0,
              sourceId: dockFromSourceId,
              signalId: dockFromSignalId,
              arity: 0,
              delaySeconds: input.delaySeconds ?? 15n
            }
          ]
        }
      ]
    ]),
    topics: encodeEventTopics({
      abi: [event],
      eventName: "DockRegistered",
      args: {
        dkid: `0x${input.docHash.slice(2, 34)}${"0".repeat(32)}`,
        fromPlanId: dockFromPlanId,
        toPlanId: dockToPlanId
      }
    }) as readonly Hex[],
    removed: input.removed === true
  } as unknown as Log;
}

function dockRegisteredEvent(): AbiEvent {
  const event = DOCK_REGISTRY_ABI.find(
    (entry) => entry.type === "event" && entry.name === "DockRegistered"
  );
  if (!event || event.type !== "event") {
    throw new Error("UVPDockRegistry ABI is missing the DockRegistered event");
  }
  return event as AbiEvent;
}
