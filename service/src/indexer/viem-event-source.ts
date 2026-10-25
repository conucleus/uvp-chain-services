import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbi,
  type Abi,
  type AbiEvent,
  type Address as ViemAddress,
  type Log,
} from "viem";
import type { ChainServicesConfig } from "../config/index.js";
import {
  DERIVED_SIGNAL_MODULE_ABI,
  DOCKING_MODULE_ABI,
  ORDER_LINK_MODULE_ABI,
  STAGE_PATCH_MODULE_ABI,
  STATE_MACHINE_ABI
} from "@uvp-eth/protocol-bindings";
import { ConfigError, normalizeAddress, noopLogger, type Address, type Hex, type Logger } from "../shared/types.js";
import type { ChainEvent, EventArgs } from "./events.js";
import type { ChainEventRange, ChainEventSource } from "./service.js";

// 事件面按合约族划分：订单维度事件 plan-scoped，模块事件按 deployment.modules
// 分地址挂 ABI；状态机与模块事件条目均从 @uvp-eth/protocol-bindings 整表 ABI
// 滤出（单源，先放宽为泛型 Abi 再滤以避开 viem 条件类型爆栈）。
const stateMachineAbi: Abi = (STATE_MACHINE_ABI as Abi).filter(
  (entry) => entry.type === "event"
);

const stagePatchModuleAbi: Abi = (STAGE_PATCH_MODULE_ABI as Abi).filter(
  (entry) => entry.type === "event"
);

const derivedSignalModuleAbi: Abi = (DERIVED_SIGNAL_MODULE_ABI as Abi).filter(
  (entry) => entry.type === "event"
);

const orderLinkModuleAbi: Abi = (ORDER_LINK_MODULE_ABI as Abi).filter(
  (entry) => entry.type === "event"
);

const dockingModuleAbi: Abi = (DOCKING_MODULE_ABI as Abi).filter(
  (entry) => entry.type === "event"
);

const identityRegistryAbi = parseAbi([
  "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
  "event IdentityBindingRegistered(bytes32 indexed bindingId,bytes32 indexed subjectId,address indexed account,bytes32 descriptorHash,string descriptorURI,address registrar)",
  "event IdentityBindingRevoked(bytes32 indexed bindingId,bytes32 reasonHash,string reasonURI,address revoker)",
]);

const deploymentRegistryAbi = parseAbi([
  "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
  "event DeploymentRegistered(bytes32 indexed deploymentId,address indexed stateMachine,bytes32 artifactHash,bytes32 abiHash,uint64 deploymentBlock,string metadataURI)",
  "event DeploymentCanaryMarked(bytes32 indexed deploymentId,bytes32 evidenceHash,string evidenceURI)",
  "event DeploymentActivated(bytes32 indexed previousDeploymentId,bytes32 indexed newDeploymentId,bytes32 evidenceHash,string evidenceURI)",
  "event DeploymentDeprecated(bytes32 indexed deploymentId,bytes32 reasonHash,string reasonURI)",
  "event DeploymentRetired(bytes32 indexed deploymentId,bytes32 reasonHash,string reasonURI)",
]);

export const INDEXER_EVENT_ABIS = {
  UVPStateMachine: stateMachineAbi,
  UVPIdentityRegistry: identityRegistryAbi,
  UVPDeploymentRegistry: deploymentRegistryAbi,
  UVPStagePatchModule: stagePatchModuleAbi,
  UVPDerivedSignalModule: derivedSignalModuleAbi,
  UVPOrderLinkModule: orderLinkModuleAbi,
  UVPDockingModule: dockingModuleAbi
} as const;

const maxGetLogsBlockSpan = 9_999n;
const maxConcurrentLogReads = 4;
const logReadAttemptLimit = 3;
const logReadRetryBaseDelayMs = 250;

type IndexedContractName =
  | "UVPStateMachine"
  | "UVPIdentityRegistry"
  | "UVPDeploymentRegistry"
  | "UVPStagePatchModule"
  | "UVPDerivedSignalModule"
  | "UVPOrderLinkModule"
  | "UVPDockingModule";

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
  getBlock?(input:
    | { readonly blockNumber: bigint; readonly blockTag?: undefined }
    | { readonly blockNumber?: undefined; readonly blockTag: "finalized" }): Promise<{
    readonly hash: Hex | null;
    readonly number?: bigint | null;
  }>;
}

export interface ViemChainEventSourceOptions {
  readonly publicClient?: ViemLogReader;
  readonly logger?: Logger;
}

export class ViemChainEventSource implements ChainEventSource {
  readonly #publicClient: ViemLogReader | undefined;
  readonly #logger: Logger;
  #unresolvedLogCount = 0;

  constructor(options: ViemChainEventSourceOptions = {}) {
    this.#publicClient = options.publicClient;
    this.#logger = options.logger ?? noopLogger;
  }

  get unresolvedLogCount(): number {
    return this.#unresolvedLogCount;
  }

  consumeUnresolvedLogCount(): number {
    const count = this.#unresolvedLogCount;
    this.#unresolvedLogCount = 0;
    return count;
  }

  async getFinalizedBlock(config: ChainServicesConfig): Promise<bigint> {
    const client = this.#client(config);
    if (config.network.finalityAnchor === "confirmations") {
      const latestBlock = await client.getBlockNumber();
      const confirmations = BigInt(config.network.finalityConfirmations);
      if (latestBlock <= confirmations) {
        return 0n;
      }
      return latestBlock - confirmations;
    }
    const finalizedBlock = await client.getBlock?.({ blockTag: "finalized" });
    if (!finalizedBlock) {
      throw new ConfigError(
        "configured RPC client does not support getBlock; the finalized finality anchor requires it (set UVP_FINALITY_ANCHOR=confirmations for chains without finalized-tag support)"
      );
    }
    if (finalizedBlock.number === null || finalizedBlock.number === undefined) {
      throw new ConfigError("finalized block returned by the RPC node carries no number");
    }
    return finalizedBlock.number;
  }

  async getBlockHash(
    blockNumber: bigint,
    config: ChainServicesConfig,
  ): Promise<Hex> {
    const client = this.#client(config);
    if (!client.getBlock) {
      throw new ConfigError("configured RPC client does not support getBlock; reorg detection is unavailable");
    }
    const block = await client.getBlock({ blockNumber });
    if (block.hash === null || block.hash === undefined) {
      throw new ConfigError(`block ${blockNumber} returned by the RPC node carries no hash`);
    }
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
    const readTasks = contracts.flatMap((contract) =>
      blockRanges(range.fromBlock, range.toBlock, maxGetLogsBlockSpan).map(
        (blockRange) => ({ contract, blockRange })
      )
    );
    const logsByTask = new Array<readonly Log[]>(readTasks.length);
    let nextTaskIndex = 0;
    const workers = Array.from(
      { length: Math.min(maxConcurrentLogReads, readTasks.length) },
      async () => {
        while (nextTaskIndex < readTasks.length) {
          const index = nextTaskIndex;
          nextTaskIndex += 1;
          const task = readTasks[index];
          if (!task) {
            continue;
          }
          const { contract, blockRange } = task;
          logsByTask[index] = await this.#getLogsWithRetry(client, contract, blockRange);
        }
      }
    );
    await Promise.all(workers);

    const decoded: ChainEvent[] = [];
    for (const [index, { contract }] of readTasks.entries()) {
      const taskLogs = logsByTask[index];
      if (!taskLogs) {
        continue;
      }
      for (const log of taskLogs) {
        const event = decodeChainEventLog(log, range.chainId, contract);
        if (event) {
          decoded.push(event);
        } else {
          this.#unresolvedLogCount += 1;
          this.#logger.warn("skipped undecodable chain log; cursor still advances", {
            chainId: range.chainId,
            contract: contract.name,
            address: contract.address,
            blockNumber: log.blockNumber?.toString(),
            transactionHash: log.transactionHash,
            logIndex: log.logIndex?.toString(),
            unresolvedLogCount: this.#unresolvedLogCount,
          });
        }
      }
    }
    return decoded;
  }

  async #getLogsWithRetry(
    client: ViemLogReader,
    contract: IndexedContract,
    blockRange: { readonly fromBlock: bigint; readonly toBlock: bigint },
  ): Promise<readonly Log[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= logReadAttemptLimit; attempt += 1) {
      if (attempt > 1) {
        await delay(logReadRetryBaseDelayMs * 2 ** (attempt - 2));
      }
      try {
        return await client.getLogs({
          address: contract.address as ViemAddress,
          fromBlock: blockRange.fromBlock,
          toBlock: blockRange.toBlock,
        });
      } catch (error) {
        lastError = error;
        this.#logger.warn("getLogs chunk read failed; retrying with backoff", {
          contract: contract.name,
          address: contract.address,
          fromBlock: blockRange.fromBlock.toString(),
          toBlock: blockRange.toBlock.toString(),
          attempt,
          attemptLimit: logReadAttemptLimit,
          message: error instanceof Error ? error.message : "unknown getLogs error"
        });
      }
    }
    throw lastError;
  }

  #client(config: ChainServicesConfig): ViemLogReader {
    return (
      this.#publicClient ??
      createPublicClient({ transport: http(config.network.rpcUrl) })
    );
  }
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
    indexedContract(
      "UVPStagePatchModule",
      config.network.contracts,
      stagePatchModuleAbi,
    ),
    indexedContract(
      "UVPDerivedSignalModule",
      config.network.contracts,
      derivedSignalModuleAbi,
    ),
    indexedContract(
      "UVPOrderLinkModule",
      config.network.contracts,
      orderLinkModuleAbi,
    ),
    indexedContract(
      "UVPDockingModule",
      config.network.contracts,
      dockingModuleAbi,
    ),
    ...stateMachineDeployments.flatMap((deployment) => {
      const modules = deployment.modules ?? {};
      const moduleContracts = [
        modules.stagePatch
          ? moduleContract("UVPStagePatchModule", modules.stagePatch, stagePatchModuleAbi)
          : undefined,
        modules.derivedSignal
          ? moduleContract("UVPDerivedSignalModule", modules.derivedSignal, derivedSignalModuleAbi)
          : undefined,
        modules.orderLink
          ? moduleContract("UVPOrderLinkModule", modules.orderLink, orderLinkModuleAbi)
          : undefined,
        modules.docking
          ? moduleContract("UVPDockingModule", modules.docking, dockingModuleAbi)
          : undefined,
      ].filter((contract): contract is IndexedContract => Boolean(contract));
      return [
        {
          name: "UVPStateMachine" as const,
          address: deployment.stateMachineAddress,
          abi: stateMachineAbi,
        },
        ...moduleContracts,
      ];
    }),
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

function moduleContract(
  name: IndexedContractName,
  address: Address,
  abi: Abi,
): IndexedContract | undefined {
  if (!address || isZeroAddress(address)) {
    return undefined;
  }
  return { name, address, abi };
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
  for (let start = fromBlock; start <= toBlock; start = start + maxSpan) {
    const end = start + maxSpan - 1n < toBlock ? start + maxSpan - 1n : toBlock;
    ranges.push({ fromBlock: start, toBlock: end });
  }
  return ranges;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeChainEventLog(
  log: Log,
  chainId: number,
  contract: IndexedContract,
): ChainEvent | undefined {
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
  const normalizedAddress = normalizeLogAddress(log.address);

  let event: ChainEvent | undefined;
  try {
    const decoded = decodeEventLog({
      abi: contract.abi,
      data: log.data,
      topics: log.topics,
    });
    const eventName = decoded.eventName;
    event = eventName
      ? {
        chainId,
        contractAddress: normalizedAddress,
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
        args: normalizeEventArgs(decoded.args, eventInputTypes(contract.abi, eventName)),
      }
      : undefined;
  } catch {
    return undefined;
  }
  return event;
}

function normalizeEventArgs(args: unknown, inputTypes: ReadonlyMap<string, string>): EventArgs {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([key, value]) => [
      key,
      normalizeEventArg(value, inputTypes.get(key)),
    ]),
  );
}

function logRemoved(log: Log): boolean {
  return (log as { readonly removed?: boolean }).removed === true;
}

function normalizeEventArg(value: unknown, abiType: string | undefined): unknown {
  if (abiType === "string") {
    return value;
  }
  if (typeof value === "string" && value.startsWith("0x")) {
    return value.toLowerCase();
  }
  if (Array.isArray(value)) {
    const itemType = arrayItemType(abiType);
    return value.map((item) => normalizeEventArg(item, itemType));
  }
  return value;
}

function arrayItemType(abiType: string | undefined): string | undefined {
  if (!abiType || !abiType.endsWith("[]")) {
    return undefined;
  }
  return abiType.slice(0, -2);
}

function eventInputTypes(abi: Abi, eventName: string): ReadonlyMap<string, string> {
  const types = new Map<string, string>();
  for (const entry of abi) {
    if (entry.type !== "event" || entry.name !== eventName) {
      continue;
    }
    for (const input of (entry as AbiEvent).inputs) {
      if (input.name) {
        types.set(input.name, input.type);
      }
    }
  }
  return types;
}

function normalizeLogAddress(address: string): Address {
  try {
    return normalizeAddress(address, "log address");
  } catch {
    throw new ConfigError("log address must be a 20-byte EVM address");
  }
}

function isZeroAddress(address: Address): boolean {
  return address === "0x0000000000000000000000000000000000000000";
}
