import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbi,
  type Abi,
  type Address as ViemAddress,
  type Log,
} from "viem";
import type { ChainServicesConfig } from "../config/index.js";
import { ConfigError, type Address, type Hex } from "../shared/types.js";
import type { ChainEvent, EventArgs } from "./events.js";
import type { ChainEventRange, ChainEventSource } from "./service.js";

const stateMachineAbi = parseAbi([
  "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
  "event StateMachineModuleSet(bytes32 indexed moduleId,address indexed previousModule,address indexed newModule)",
  "event StateMachineModulesFrozen(bytes32 indexed moduleSetHash)",
  "event PlanCommitted(bytes32 indexed planId,bytes32 indexed planHash,address indexed publisher,bytes32 hooksHash,bytes32 metadataHash,uint256 hookCount)",
  "event PlanFinalized(bytes32 indexed planId,bytes32 indexed planHash,bytes32 metadataHash)",
  "event PlanRegistered(bytes32 indexed planId,bytes32 planHash,uint256 hookCount)",
  "event PlanPublisherRecorded(bytes32 indexed planId,address indexed publisher)",
  "event OrderRegistered(bytes32 indexed orderId,bytes32 indexed planId)",
  "event OrderMaterialized(bytes32 indexed orderId,bytes32 indexed planId,bytes32 indexed stageId)",
  "event OrderRelayerRecorded(bytes32 indexed orderId,address indexed relayer,address indexed creator)",
  "event SignalSubmitterAuthorized(bytes32 indexed orderId,bytes32 indexed sourceId,bytes32 indexed signalId,address submitter,bytes32 role,bytes32 metadataHash)",
  "event SignalSubmitted(bytes32 indexed orderId,bytes32 indexed sourceId,bytes32 indexed signalId,bytes32 payloadHash,bytes32 idempotencyKey,address submitter)",
  "event StageMaterialized(bytes32 indexed orderId,bytes32 indexed stageId,bytes32 indexed triggerHookId,bytes32 sourceId,bytes32 signalId)",
  "event SignalCapabilityRegistered(bytes32 indexed planId,bytes32 indexed stageId,bytes32 indexed targetSourceId,bytes32 signalId,uint8 targetOrderRelation)",
  "event OrderTriggered(bytes32 indexed orderId,bytes32 indexed planId,bytes32 indexed triggerStageId,bytes32 sourceId,bytes32 signalId,address submitter)",
  "event OrderLinked(bytes32 indexed triggeredOrderId,bytes32 indexed triggerOriginOrderId,bytes32 indexed triggerStageId,bytes32 originSourceId,bytes32 originSignalId)",
  "event StageSelectorBindingRegistered(bytes32 indexed planId,bytes32 indexed selectorStageId,bytes32 indexed targetStageId)",
  "event StageExecutorPatchApplied(bytes32 indexed orderId,bytes32 indexed selectorStageId,bytes32 indexed targetStageId,address selector,address executor,bytes32 role,bytes32 executorMetadataHash,bytes32 mode,address previousExecutor,bytes32 approvalSourceId,bytes32 approvalSignalId,bytes32 patchHash,uint256 patchNonce,string metadataURI)",
  "event StageResourcePatchApplied(bytes32 indexed orderId,bytes32 indexed selectorStageId,bytes32 indexed targetStageId,address selector,bytes32 resourceKey,bytes32 manifestHash,bytes32 policyHash,bytes32 patchHash,uint256 patchNonce,string manifestURI)",
  "event StageExecutorActivated(bytes32 indexed orderId,bytes32 indexed targetStageId,address indexed executor,bytes32 role,bytes32 metadataHash,uint256 patchNonce,string metadataURI)",
  "event StageExecutorSignalDelegated(bytes32 indexed orderId,bytes32 indexed targetStageId,bytes32 indexed sourceId,bytes32 signalId,address executor,bytes32 role,bytes32 metadataHash,uint256 patchNonce)",
  "event DockedOrderLinked(bytes32 indexed localOrderId,bytes32 indexed linkedOrderId,bytes32 indexed localSourceId,bytes32 selectorStageId,bytes32 linkedPlanId,address selector,bytes32 linkHash,uint256 linkNonce,string metadataURI)",
  "event DockedSignalMapped(bytes32 indexed localOrderId,bytes32 indexed linkedOrderId,bytes32 indexed linkedSourceId,bytes32 linkedSignalId,bytes32 localSourceId,bytes32 localSignalId)",
  "event DockedSignalSubmitted(bytes32 indexed localOrderId,bytes32 indexed linkedOrderId,bytes32 indexed linkedSourceId,bytes32 linkedSignalId,bytes32 localSourceId,bytes32 localSignalId,bytes32 payloadHash,address submitter)",
  "event DerivedSignalSubmitted(bytes32 indexed fromOrderId,bytes32 indexed targetOrderId,bytes32 indexed signalId,bytes32 fromStageId,bytes32 targetSourceId,bytes32 payloadHash,bytes32 idempotencyKey,address submitter)",
  "event HookStatusChanged(bytes32 indexed orderId,bytes32 indexed hookId,uint8 previousStatus,uint8 newStatus,uint64 dueAt)",
  "event HookReady(bytes32 indexed orderId,bytes32 indexed hookId,bytes32 indexed stageId,bytes32 hookName)",
  "event TimerPoked(bytes32 indexed orderId,bytes32 indexed hookId,uint64 dueAt)",
]);

const identityRegistryAbi = parseAbi([
  "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
  "event IdentityBindingRegistered(bytes32 indexed bindingId,bytes32 indexed subjectId,address indexed account,bytes32 descriptorHash,string descriptorURI,address registrar)",
  "event IdentityBindingRevoked(bytes32 indexed bindingId,bytes32 reasonHash,string reasonURI,address revoker)",
]);

const deploymentRegistryAbi = parseAbi([
  "event DeploymentRegistered(bytes32 indexed deploymentId,address indexed stateMachine,bytes32 artifactHash,bytes32 abiHash,uint64 deploymentBlock,string metadataURI)",
  "event DeploymentCanaryMarked(bytes32 indexed deploymentId,bytes32 evidenceHash,string evidenceURI)",
  "event DeploymentActivated(bytes32 indexed previousDeploymentId,bytes32 indexed newDeploymentId,bytes32 evidenceHash,string evidenceURI)",
  "event DeploymentDeprecated(bytes32 indexed deploymentId,bytes32 reasonHash,string reasonURI)",
  "event DeploymentRetired(bytes32 indexed deploymentId,bytes32 reasonHash,string reasonURI)",
]);

const maxGetLogsBlockSpan = 9_999n;

type IndexedContractName =
  | "UVPStateMachine"
  | "UVPIdentityRegistry"
  | "UVPDeploymentRegistry";

interface IndexedContract {
  readonly name: IndexedContractName;
  readonly address: Address;
  readonly abi: Abi;
}

interface ViemLogReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(input: {
    readonly address: ViemAddress;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly Log[]>;
  getBlock?(input: { readonly blockNumber: bigint }): Promise<{ readonly hash: Hex }>;
}

export interface ViemChainEventSourceOptions {
  readonly publicClient?: ViemLogReader;
}

export class ViemChainEventSource implements ChainEventSource {
  readonly #publicClient: ViemLogReader | undefined;

  constructor(options: ViemChainEventSourceOptions = {}) {
    this.#publicClient = options.publicClient;
  }

  async getFinalizedBlock(config: ChainServicesConfig): Promise<bigint> {
    const latestBlock = await this.#client(config).getBlockNumber();
    // Audit #15 + ETH-02：reorg 安全 = finalityConfirmations 缓冲 + 追加前的
    // 哈希连续性校验（indexer/service.ts）。finalityConfirmations 之上的
    // 深度 reorg 仍无法自动回滚，需要 full rebuild；`removed` log 改写投影
    // 依旧不是本服务的职责。
    const confirmations = BigInt(config.network.finalityConfirmations);
    if (latestBlock <= confirmations) {
      return 0n;
    }
    return latestBlock - confirmations;
  }

  /**
   * ETH-02：返回当前 canonical 链上指定高度的区块哈希，供 indexer 在
   * 追加事件前校验 cursor 连续性、reorg 时定位共同祖先。
   */
  async getBlockHash(
    blockNumber: bigint,
    config: ChainServicesConfig,
  ): Promise<Hex> {
    const client = this.#client(config);
    if (!client.getBlock) {
      throw new ConfigError("configured RPC client does not support getBlock; reorg detection is unavailable");
    }
    const block = await client.getBlock({ blockNumber });
    return block.hash.toLowerCase() as Hex;
  }

  async readEvents(
    range: ChainEventRange,
    config: ChainServicesConfig,
  ): Promise<readonly ChainEvent[]> {
    const contracts = indexedContracts(config);
    if (contracts.length === 0 || range.toBlock < range.fromBlock) {
      return [];
    }

    const client = this.#client(config);
    const batches = await Promise.all(
      contracts.map(async (contract) => {
        const logs = (
          await Promise.all(
            blockRanges(
              range.fromBlock,
              range.toBlock,
              maxGetLogsBlockSpan,
            ).map((blockRange) =>
              client.getLogs({
                address: contract.address as ViemAddress,
                fromBlock: blockRange.fromBlock,
                toBlock: blockRange.toBlock,
              }),
            ),
          )
        ).flat();
        return logs.map((log) =>
          decodeChainEventLog(log, range.chainId, contract),
        );
      }),
    );

    return batches.flat();
  }

  #client(config: ChainServicesConfig): ViemLogReader {
    return (
      this.#publicClient ??
      createPublicClient({ transport: http(config.network.rpcUrl) })
    );
  }
}

export function createDefaultEventSource(
  config: ChainServicesConfig,
): ChainEventSource | undefined {
  return hasConfiguredEvmIndexerContracts(config)
    ? new ViemChainEventSource()
    : undefined;
}

export function hasConfiguredEvmIndexerContracts(
  config: ChainServicesConfig,
): boolean {
  return indexedContracts(config).length > 0;
}

function indexedContracts(
  config: ChainServicesConfig,
): readonly IndexedContract[] {
  const stateMachineDeployments = config.network.stateMachineDeployments ?? [];
  const contracts = [
    indexedContract(
      "UVPStateMachine",
      config.network.contracts,
      stateMachineAbi,
    ),
    indexedContract(
      "UVPIdentityRegistry",
      config.network.contracts,
      identityRegistryAbi,
    ),
    indexedContract(
      "UVPDeploymentRegistry",
      config.network.contracts,
      deploymentRegistryAbi,
    ),
    ...stateMachineDeployments.flatMap((deployment) => [
      {
        name: "UVPStateMachine" as const,
        address: deployment.stateMachineAddress,
        abi: stateMachineAbi,
      },
      ...Object.values(deployment.modules ?? {})
        .filter((address): address is Address => Boolean(address))
        .map((address) => ({
          name: "UVPStateMachine" as const,
          address,
          abi: stateMachineAbi,
        })),
    ]),
  ].filter((contract): contract is IndexedContract => Boolean(contract));
  const seen = new Set<string>();
  return contracts.filter((contract) => {
    const key = `${contract.name}:${contract.address.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function indexedContract(
  name: IndexedContractName,
  contracts: Readonly<Record<string, Address>>,
  abi: Abi,
): IndexedContract | undefined {
  const address = contracts[name];
  if (address && !isZeroAddress(address)) {
    return { name, address, abi };
  }
  return undefined;
}

function blockRanges(
  fromBlock: bigint,
  toBlock: bigint,
  maxSpan: bigint,
): readonly { readonly fromBlock: bigint; readonly toBlock: bigint }[] {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = fromBlock; start <= toBlock; start = start + maxSpan + 1n) {
    const end = start + maxSpan < toBlock ? start + maxSpan : toBlock;
    ranges.push({ fromBlock: start, toBlock: end });
  }
  return ranges;
}

function decodeChainEventLog(
  log: Log,
  chainId: number,
  contract: IndexedContract,
): ChainEvent {
  if (
    log.blockNumber == null ||
    !log.transactionHash ||
    log.logIndex == null ||
    !log.address
  ) {
    throw new Error(
      `incomplete ${contract.name} log metadata from ${contract.address}`,
    );
  }

  try {
    const decoded = decodeEventLog({
      abi: contract.abi,
      data: log.data,
      topics: log.topics,
    });

    const eventName = decoded.eventName;
    if (!eventName) {
      throw new Error("decoded event has no name");
    }

    return {
      chainId,
      contractAddress: normalizeLogAddress(log.address),
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash.toLowerCase() as Hex,
      logIndex: Number(log.logIndex),
      ...(log.blockHash
        ? { blockHash: log.blockHash.toLowerCase() as Hex }
        : {}),
      ...(log.transactionIndex != null
        ? { transactionIndex: Number(log.transactionIndex) }
        : {}),
      ...(logRemoved(log) ? { removed: true } : {}),
      eventName,
      args: normalizeEventArgs(decoded.args),
    };
  } catch (error) {
    throw new Error(
      `failed to decode ${contract.name} event at block ${log.blockNumber.toString()}, tx ${log.transactionHash}, log ${log.logIndex.toString()}`,
      { cause: error },
    );
  }
}

function normalizeEventArgs(args: unknown): EventArgs {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([key, value]) => [
      key,
      normalizeEventArg(value),
    ]),
  );
}

function logRemoved(log: Log): boolean {
  return (log as { readonly removed?: boolean }).removed === true;
}

function normalizeEventArg(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("0x")) {
    return value.toLowerCase();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeEventArg);
  }
  return value;
}

function normalizeLogAddress(address: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new ConfigError("log address must be a 20-byte EVM address");
  }
  return address.toLowerCase() as Address;
}

function isZeroAddress(address: Address): boolean {
  return address === "0x0000000000000000000000000000000000000000";
}
