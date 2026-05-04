import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbi,
  type Abi,
  type Address as ViemAddress,
  type Log
} from "viem";
import type { ChainServicesConfig } from "../config/index.js";
import { ConfigError, type Address, type Hex } from "../shared/types.js";
import type { ChainEvent, EventArgs } from "./events.js";
import type { ChainEventRange, ChainEventSource } from "./service.js";

const stateMachineAbi = parseAbi([
  "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
  "event PlanPublisherSet(address indexed publisher,bool allowed)",
  "event OrderRegistrarSet(address indexed registrar,bool allowed)",
  "event PlanRegistered(bytes32 indexed planId,bytes32 planHash,uint256 hookCount)",
  "event PlanPublisherRecorded(bytes32 indexed planId,address indexed publisher)",
  "event OrderRegistered(bytes32 indexed orderId,bytes32 indexed planId)",
  "event OrderRegistrarRecorded(bytes32 indexed orderId,address indexed registrar,address indexed creator)",
  "event SignalSubmitterAuthorized(bytes32 indexed orderId,bytes32 indexed sourceId,bytes32 indexed signalId,address submitter,bytes32 role,bytes32 metadataHash)",
  "event SignalSubmitted(bytes32 indexed orderId,bytes32 indexed sourceId,bytes32 indexed signalId,bytes32 payloadHash,bytes32 idempotencyKey,address submitter)",
  "event StageSelectorBindingRegistered(bytes32 indexed planId,bytes32 indexed selectorStageId,bytes32 indexed targetStageId)",
  "event StageExecutorPatchApplied(bytes32 indexed orderId,bytes32 indexed selectorStageId,bytes32 indexed targetStageId,address selector,address executor,bytes32 role,bytes32 executorMetadataHash,bytes32 mode,address previousExecutor,bytes32 approvalSourceId,bytes32 approvalSignalId,bytes32 patchHash,uint256 patchNonce,string metadataURI)",
  "event StageResourcePatchApplied(bytes32 indexed orderId,bytes32 indexed selectorStageId,bytes32 indexed targetStageId,address selector,bytes32 resourceKey,bytes32 manifestHash,bytes32 policyHash,bytes32 patchHash,uint256 patchNonce,string manifestURI)",
  "event StageExecutorActivated(bytes32 indexed orderId,bytes32 indexed targetStageId,address indexed executor,bytes32 role,bytes32 metadataHash,uint256 patchNonce)",
  "event DockedOrderLinked(bytes32 indexed localOrderId,bytes32 indexed linkedOrderId,bytes32 indexed localSourceId,bytes32 selectorStageId,bytes32 linkedPlanId,address selector,bytes32 linkHash,uint256 linkNonce,string metadataURI)",
  "event DockedSignalMapped(bytes32 indexed localOrderId,bytes32 indexed linkedOrderId,bytes32 indexed linkedSourceId,bytes32 linkedSignalId,bytes32 localSourceId,bytes32 localSignalId)",
  "event DockedSignalSubmitted(bytes32 indexed localOrderId,bytes32 indexed linkedOrderId,bytes32 indexed linkedSourceId,bytes32 linkedSignalId,bytes32 localSourceId,bytes32 localSignalId,bytes32 payloadHash,address submitter)",
  "event HookStatusChanged(bytes32 indexed orderId,bytes32 indexed hookId,uint8 previousStatus,uint8 newStatus,uint64 dueAt)",
  "event HookReady(bytes32 indexed orderId,bytes32 indexed hookId,bytes32 indexed stageId,bytes32 hookName)",
  "event TimerPoked(bytes32 indexed orderId,bytes32 indexed hookId,uint64 dueAt)"
]);

const trustRegistryAbi = parseAbi([
  "event DomainRegistered(bytes32 indexed domainId,address indexed owner,bytes32 metadataHash,string metadataURI)",
  "event DomainUpdated(bytes32 indexed domainId,bytes32 metadataHash,string metadataURI)",
  "event DomainOwnerTransferred(bytes32 indexed domainId,address indexed previousOwner,address indexed newOwner)",
  "event PlanAttested(bytes32 indexed domainId,bytes32 indexed planId,bytes32 indexed planHash,bytes32 artifactHash,bytes32 policyHash,bytes32 metadataHash,string metadataURI,address attester)",
  "event PlanRevoked(bytes32 indexed domainId,bytes32 indexed planId,bytes32 reasonHash,string reasonURI,address revoker)",
  "event SupplierAttested(bytes32 indexed domainId,bytes32 indexed supplierSubjectId,address indexed wallet,bytes32 profileHash,bytes32 capabilityHash,bytes32 reputationHash,string metadataURI,address attester)",
  "event SupplierRevoked(bytes32 indexed domainId,bytes32 indexed supplierSubjectId,bytes32 reasonHash,string reasonURI,address revoker)"
]);

const deploymentRegistryAbi = parseAbi([
  "event DeploymentRegistered(bytes32 indexed deploymentId,address indexed stateMachine,address indexed trustRegistry,bytes32 officialDomainId,bytes32 artifactHash,bytes32 abiHash,uint64 deploymentBlock,string metadataURI)",
  "event DeploymentCanaryMarked(bytes32 indexed deploymentId,bytes32 evidenceHash,string evidenceURI)",
  "event DeploymentActivated(bytes32 indexed previousDeploymentId,bytes32 indexed newDeploymentId,bytes32 evidenceHash,string evidenceURI)",
  "event DeploymentDeprecated(bytes32 indexed deploymentId,bytes32 reasonHash,string reasonURI)",
  "event DeploymentRetired(bytes32 indexed deploymentId,bytes32 reasonHash,string reasonURI)"
]);

const maxGetLogsBlockSpan = 9_999n;

const supportedContractAliases = {
  UVPStateMachine: ["UVPStateMachine", "StateMachine", "stateMachine", "uvpStateMachine"],
  ZhixuTrustRegistry: ["ZhixuTrustRegistry", "TrustRegistry", "trustRegistry", "zhixuTrustRegistry"],
  UVPDeploymentRegistry: ["UVPDeploymentRegistry", "DeploymentRegistry", "deploymentRegistry", "uvpDeploymentRegistry"]
} as const;

interface IndexedContract {
  readonly name: keyof typeof supportedContractAliases;
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
    const confirmations = BigInt(config.network.finalityConfirmations);
    if (latestBlock <= confirmations) {
      return 0n;
    }
    return latestBlock - confirmations;
  }

  async readEvents(range: ChainEventRange, config: ChainServicesConfig): Promise<readonly ChainEvent[]> {
    const contracts = indexedContracts(config);
    if (contracts.length === 0 || range.toBlock < range.fromBlock) {
      return [];
    }

    const client = this.#client(config);
    const batches = await Promise.all(
      contracts.map(async (contract) => {
        const logs = (await Promise.all(
          blockRanges(range.fromBlock, range.toBlock, maxGetLogsBlockSpan).map((blockRange) =>
            client.getLogs({
              address: contract.address as ViemAddress,
              fromBlock: blockRange.fromBlock,
              toBlock: blockRange.toBlock
            })
          )
        )).flat();
        return logs.flatMap((log) => decodeChainEventLog(log, range.chainId, contract));
      })
    );

    return batches.flat();
  }

  #client(config: ChainServicesConfig): ViemLogReader {
    return this.#publicClient ?? createPublicClient({ transport: http(config.network.rpcUrl) });
  }
}

export function createDefaultEventSource(config: ChainServicesConfig): ChainEventSource | undefined {
  return hasConfiguredEvmIndexerContracts(config) ? new ViemChainEventSource() : undefined;
}

export function hasConfiguredEvmIndexerContracts(config: ChainServicesConfig): boolean {
  return indexedContracts(config).length > 0;
}

function indexedContracts(config: ChainServicesConfig): readonly IndexedContract[] {
  const stateMachineDeployments = config.network.stateMachineDeployments ?? [];
  const contracts = [
    indexedContract("UVPStateMachine", config.network.contracts, stateMachineAbi),
    indexedContract("ZhixuTrustRegistry", config.network.contracts, trustRegistryAbi),
    indexedContract("UVPDeploymentRegistry", config.network.contracts, deploymentRegistryAbi),
    ...stateMachineDeployments.map((deployment) => ({
      name: "UVPStateMachine" as const,
      address: deployment.stateMachineAddress,
      abi: stateMachineAbi
    })),
    ...stateMachineDeployments.flatMap((deployment) => deployment.trustRegistryAddress
      ? [{
          name: "ZhixuTrustRegistry" as const,
          address: deployment.trustRegistryAddress,
          abi: trustRegistryAbi
        }]
      : [])
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
  name: keyof typeof supportedContractAliases,
  contracts: Readonly<Record<string, Address>>,
  abi: Abi
): IndexedContract | undefined {
  for (const alias of supportedContractAliases[name]) {
    const address = contracts[alias];
    if (address && !isZeroAddress(address)) {
      return { name, address, abi };
    }
  }
  return undefined;
}

function blockRanges(
  fromBlock: bigint,
  toBlock: bigint,
  maxSpan: bigint
): readonly { readonly fromBlock: bigint; readonly toBlock: bigint }[] {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = fromBlock; start <= toBlock; start = start + maxSpan + 1n) {
    const end = start + maxSpan < toBlock ? start + maxSpan : toBlock;
    ranges.push({ fromBlock: start, toBlock: end });
  }
  return ranges;
}

function decodeChainEventLog(log: Log, chainId: number, contract: IndexedContract): ChainEvent[] {
  if (log.blockNumber == null || !log.transactionHash || log.logIndex == null || !log.address) {
    return [];
  }

  try {
    const decoded = decodeEventLog({
      abi: contract.abi,
      data: log.data,
      topics: log.topics
    });

    const eventName = decoded.eventName;
    if (!eventName) {
      return [];
    }

    return [
      {
        chainId,
        contractAddress: normalizeLogAddress(log.address),
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash.toLowerCase() as Hex,
        logIndex: Number(log.logIndex),
        ...(log.blockHash ? { blockHash: log.blockHash.toLowerCase() as Hex } : {}),
        eventName,
        args: normalizeEventArgs(decoded.args)
      }
    ];
  } catch {
    return [];
  }
}

function normalizeEventArgs(args: unknown): EventArgs {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([key, value]) => [key, normalizeEventArg(value)])
  );
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
