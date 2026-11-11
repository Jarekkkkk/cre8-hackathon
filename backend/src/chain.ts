import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { activeChain } from './chain-object.js';
import type { PublicClient, WalletClient, Address, Account, Hex } from 'viem';
import { kernelAddressesForChain } from './addresses.js';
import { getConfig } from './config.js';
import { assertKernelInfraDeployed, computeSalt, getKernelAccountParams } from './kernel.js';
import type { KernelAccountOptions } from './kernel.js';
import type { RebalanceSchedule } from './strategies.js';

/**
 * Chain integration: the backend acts as a relayer. One operator key signs every on-chain
 * transaction (v1 trust model; user-signed meta-transactions are a later refinement), and the
 * AtpRegistry is the source of truth for on-chain enrollment state.
 *
 * Every helper fails fast with a clear error when the chain is not configured (no RPC_URL /
 * OPERATOR_PRIVATE_KEY / REGISTRY_ADDRESS), rather than silently skipping the on-chain step.
 */

/** Minimal AtpRegistry ABI: the three write paths this slice drives, plus the events used to read
 *  return values (registerStrategy → id, publishVersion → version) from the receipt. */
const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'registerStrategy',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'isPublic', type: 'bool' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'publishVersion',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'assets', type: 'address[]' },
      { name: 'weightsBps', type: 'uint16[]' },
      { name: 'scheduleHash', type: 'bytes32' },
      { name: 'activeAt', type: 'uint64' },
    ],
    outputs: [{ name: 'versionNumber', type: 'uint16' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'enroll',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'StrategyRegistered',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
      { name: 'name', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VersionPublished',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'version', type: 'uint16', indexed: false },
      { name: 'scheduleHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export type ChainConfig = {
  chainId: number;
  rpcUrl: string;
  registryAddress: Address;
  account: Account;
  wallet: WalletClient;
  publicClient: PublicClient;
  /** Kernel v3.3 canonical addresses for `chainId` (throws while resolving an unsupported chain). */
  kernel: ReturnType<typeof kernelAddressesForChain>;
};

let cached: ChainConfig | null = null;

/** Resolve the chain config or throw. Lazy + cached, like getConfig()/getPool(). */
export function getChain(): ChainConfig {
  if (cached) return cached;

  const config = getConfig();
  if (!config.rpcUrl) {
    throw new Error('chain is not configured: RPC_URL is required for on-chain operations');
  }
  if (!config.operatorPrivateKey) {
    throw new Error('chain is not configured: OPERATOR_PRIVATE_KEY is required for on-chain operations');
  }
  if (!config.registryAddress) {
    throw new Error('chain is not configured: REGISTRY_ADDRESS is required for on-chain operations');
  }

  const account = privateKeyToAccount(ensureHex(config.operatorPrivateKey));
  const publicClient = createPublicClient({ chain: activeChain(), transport: http(config.rpcUrl) });
  const wallet = createWalletClient({ chain: activeChain(), transport: http(config.rpcUrl), account });

  cached = {
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    registryAddress: config.registryAddress as Address,
    account,
    wallet,
    publicClient,
    kernel: kernelAddressesForChain(config.chainId),
  };
  return cached;
}

/** Reset the cached chain config (tests re-point the clients between runs). */
export function resetChain(): void {
  cached = null;
}

/** Whether the chain is configured (all three env vars set). */
export function isChainConfigured(): boolean {
  const config = getConfig();
  return config.rpcUrl !== null && config.operatorPrivateKey !== null && config.registryAddress !== null;
}

/**
 * Register a strategy on the AtpRegistry and return its on-chain id (decoded from the
 * StrategyRegistered event, so it is race-free even if another registration lands first).
 */
export async function registerStrategyOnchain(meta: {
  name: string;
  description: string;
  isPublic: boolean;
}): Promise<number> {
  const { wallet, publicClient, registryAddress, account: operator } = getChain();

  const hash = await wallet.writeContract({
    account: operator,
    chain: activeChain(),
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'registerStrategy',
    args: [meta.name, meta.description, meta.isPublic],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  return decodeReturnedId(receipt.logs, 'StrategyRegistered', 'id');
}

/**
 * Publish an allocation version on the AtpRegistry and return its on-chain version number.
 * `scheduleHash` is a deterministic keccak256 over a canonical schedule encoding; `activeAt` is
 * Unix seconds.
 */
export async function publishVersionOnchain(
  onchainId: number,
  version: {
    assets: Address[];
    weightsBps: number[];
    schedule: RebalanceSchedule;
    activeAt: Date;
  },
): Promise<number> {
  const { wallet, publicClient, registryAddress, account: operator } = getChain();

  const hash = await wallet.writeContract({
    account: operator,
    chain: activeChain(),
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'publishVersion',
    args: [
      BigInt(onchainId),
      version.assets,
      version.weightsBps,
      canonicalScheduleHash(version.schedule),
      BigInt(Math.floor(version.activeAt.getTime() / 1000)),
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  return decodeReturnedId(receipt.logs, 'VersionPublished', 'version');
}

/** Enroll `account` (the user's Kernel smart account) into `onchainId`. */
export async function enrollOnchain(account: Address, onchainId: number): Promise<void> {
  const { wallet, publicClient, registryAddress, account: operator } = getChain();

  const hash = await wallet.writeContract({
    account: operator,
    chain: activeChain(),
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'enroll',
    args: [account, BigInt(onchainId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * `deploySmartAccount` 的選配。
 *
 * 第三個參數從 `ChainConfig` 改成這包物件，是為了讓「帳戶上要裝什麼」擠得進來：`plugins` 決定誰簽，
 * `initConfig` 決定權限有沒有安裝。production 兩者必須一起給（見 src/kernel.ts 的說明）：
 * 只給 `plugins` 會得到「有 validator、但權限沒安裝」的帳戶，而且地址不變、不會有任何錯誤提示。
 */
export type DeploySmartAccountOptions = {
  /** 測試注入用；production 走 `getChain()`。 */
  chain?: ChainConfig;
  /** sudo（owner 的 ECDSA）＋ regular（session key 的 permission validator）。不給 = 只有 owner 的 sudo。 */
  plugins?: KernelAccountOptions['plugins'];
  /** 隨帳戶建立一起安裝的權限 calldata：**唯一**會改變 counterfactual 地址的東西。 */
  initConfig?: Hex[];
};

/**
 * Resolve the caller's Kernel v3.3 counterfactual account, deploying it if the chain has no code
 * there yet. One account per (owner, strategyId): `computeSalt` bakes strategyId into the salt, so
 * the address is a pure function of the pair and a redeploy is impossible.
 *
 * `options.chain` is an injection seam for unit tests; production always uses getChain().
 */
export async function deploySmartAccount(
  owner: Address,
  strategyId: bigint,
  options: DeploySmartAccountOptions = {},
): Promise<{ address: Address; deployed: boolean }> {
  const chain = options.chain ?? getChain();
  const { publicClient, wallet, account: operator } = chain;

  // Fail fast when EntryPoint / MetaFactory are missing: computing the address would revert opaquely.
  await assertKernelInfraDeployed(publicClient);

  // One SDK call yields the address and the deployment bytes, so the address is derived from exactly
  // the calldata that is about to be sent (a second derivation could silently disagree). `initConfig`
  // is part of that derivation: with it the new account also installs the session-key permissions,
  // which is why such an account has a different (and correct) address.
  const salt = computeSalt(owner, strategyId);
  const { address, factory, factoryData } = await getKernelAccountParams(publicClient, owner, salt, {
    plugins: options.plugins,
    initConfig: options.initConfig,
  });

  const code = await publicClient.getCode({ address });
  if (code !== undefined && code !== '0x') return { address, deployed: false };

  // factoryData is the MetaFactory `deployWithFactory(KernelFactory, initData, salt)` calldata, built
  // by the SDK; getKernelAccountParams has already refused anything but the MetaFactory.
  const hash = await wallet.sendTransaction({ account: operator, chain: activeChain(), to: factory, data: factoryData });
  await publicClient.waitForTransactionReceipt({ hash });

  return { address, deployed: true };
}

/**
 * 某個地址的 BNB 餘額（wei）。對 smart account 而言這就是 UserOp 的 gas 預付餘額 —— gas 由
 * `sender` 付，不是簽名的 session key 付（見 docs/pitfalls.zh-TW.md §3.10）。
 *
 * `chain` 是單元測試注入用的接縫：production 一律走 `getChain()`，形狀與
 * `deploySmartAccount` 的 `options.chain` 相同。
 */
export async function getAccountGasBalance(address: Address, chain?: ChainConfig): Promise<bigint> {
  const { publicClient } = chain ?? getChain();
  return publicClient.getBalance({ address });
}

/**
 * 當前有效 gas price（wei），用來估「這筆餘額還能跑幾次 op」。
 *
 * 不在這裡吞錯誤：取不到 gas price 的處理方式取決於呼叫端（enroll 選擇讓整包成功、gas 狀態留白，
 * 腳本選擇直接失敗），所以這裡失敗就拋。
 */
export async function getGasPriceWei(chain?: ChainConfig): Promise<bigint> {
  const { publicClient } = chain ?? getChain();
  return publicClient.getGasPrice();
}

/** Deterministic keccak256 of a canonical schedule string, mirroring what a keeper would read. */
export function canonicalScheduleHash(schedule: RebalanceSchedule): `0x${string}` {
  const canonical =
    schedule.kind === 'interval' ? `interval:${schedule.intervalSeconds}` : `cron:${schedule.cron}`;
  return keccak256(toHex(canonical));
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function ensureHex(key: string): `0x${string}` {
  return key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`);
}

/** Find the first matching event among a receipt's logs and return one numeric arg, or throw. */
function decodeReturnedId(
  logs: readonly { address: `0x${string}`; data: `0x${string}`; topics: readonly `0x${string}`[] }[],
  eventName: string,
  field: string,
): number {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: REGISTRY_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName === eventName) {
        const value = (decoded.args as Record<string, unknown>)[field];
        if (typeof value === 'bigint') return Number(value);
        if (typeof value === 'number') return value;
        throw new Error(`${eventName} event missing numeric field ${field}`);
      }
    } catch {
      // not this event; keep scanning
    }
  }
  throw new Error(`${eventName} event not found in receipt logs`);
}
