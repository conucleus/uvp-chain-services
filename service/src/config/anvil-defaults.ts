import type { Address } from "../shared/types.js";

type Hex = `0x${string}`;

/**
 * Anvil/Hardhat 默认开发账户（mnemonic "test test ... junk"，路径
 * m/44'/60'/0'/0/i）的权威单一来源。私钥与地址成对维护：黑名单校验
 * （production/staging/testnet 禁用开发密钥）从同一张表派生两个集合，
 * 杜绝"键表缺一条、地址表多一条"的漂移——曾出现派生地址不属于任何
 * Anvil 账户的误报键，以及地址表含 #10 而键表缺 #10 的漏报。
 */
export interface AnvilDefaultAccount {
  readonly privateKey: Hex;
  readonly address: Address;
}

export const ANVIL_DEFAULT_ACCOUNTS: readonly AnvilDefaultAccount[] = [
  {
    privateKey:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  },
  {
    privateKey:
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  },
  {
    privateKey:
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    address: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  },
  {
    privateKey:
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    address: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  },
  {
    privateKey:
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    address: "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  },
  {
    privateKey:
      "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    address: "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  },
  {
    privateKey:
      "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    address: "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  },
  {
    privateKey:
      "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    address: "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  },
  {
    privateKey:
      "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    address: "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  },
  {
    privateKey:
      "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    address: "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
  },
  {
    privateKey:
      "0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897",
    address: "0xbcd4042de499d14e55001ccbb24a551f3b954096",
  },
] as const;

export const ANVIL_DEFAULT_PRIVATE_KEYS: ReadonlySet<string> = new Set(
  ANVIL_DEFAULT_ACCOUNTS.map((account) => account.privateKey),
);

export const ANVIL_DEFAULT_ADDRESSES: ReadonlySet<Address> = new Set(
  ANVIL_DEFAULT_ACCOUNTS.map((account) => account.address),
);
