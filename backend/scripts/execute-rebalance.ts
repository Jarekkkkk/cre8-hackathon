// 用 **session key**（Kernel permission validator）真的把投組調回目標，並證明「代幣真的移動了」。
//
// ⚠ DEV / FORK ONLY。它會送鏈上交易、也會用 anvil 內建帳號入金。私鑰只從 process.env 讀，
//   不落任何檔案；這裡的每一把 key 都是公開的 anvil / BIP32 測試向量。
//
// 為什麼要有一支專門的腳本：
//   `AtpExecutor.executeRebalance` 對**空的 steps** 是「正常返回、什麼都不做、不 emit 任何 SwapExecuted」
//   （批次非空的檢查只在 per-step 路徑上，docs/pitfalls.zh-TW.md §8.1）。所以 `tx.status == 1` 不能當成
//   再平衡成功的證據。這支腳本因此把驗收釘在兩件不可偽造的事上：
//     ① `SwapExecuted` 事件的筆數 == steps 的筆數（解碼每個欄位）
//     ② 帳戶 ERC-20 餘額的變化 == `SwapExecuted` 算出的每個代幣的預期淨變化（外加漂移下降）
//
// 為什麼簽章的是 session key 而不是 sudo：
//   產品的力量模型是「keeper 用 session key 執行」，sudo 是使用者本人的權限。用 sudo 送成功只能證明
//   擁有者能跑，**不能**證明 keeper 能跑。所以這裡的 `createKernelAccount` 一律帶
//   `plugins: { sudo: <owner 的空帳號>, regular: <permissionValidator> }`：sudo 只提供地址與 nonce，
//   真正簽 userOp 的是 regular（只有 `executeRebalance` 這個 target+selector 的權限）。
//
// 跑法（預設 RPC 8545、bundler alto 3001）：
//   SESSION_KEY_MASTER_SEED=0x…(64 hex) bun run backend/scripts/execute-rebalance.ts --mode fund --amount 0.5
//   SESSION_KEY_MASTER_SEED=0x… bun run backend/scripts/execute-rebalance.ts --mode plan                    # deadline 預設 1800s
//   SESSION_KEY_MASTER_SEED=0x… bun run backend/scripts/execute-rebalance.ts --mode execute                 # deadline 預設 1800s
//   SESSION_KEY_MASTER_SEED=0x… bun run backend/scripts/execute-rebalance.ts --mode drift
//   SESSION_KEY_MASTER_SEED=0x… bun run backend/scripts/execute-rebalance.ts --mode negative
//   SESSION_KEY_MASTER_SEED=0x… bun run backend/scripts/execute-rebalance.ts --mode execute --refresh-floors no
//
// ⚠ `--refresh-floors no` 是**重現用**的開關（預設 yes）：它還原「拿規劃時凍結的 amountOutMin 去簽名」的
//   舊行為，用來對照「重問地板之後才成功」。正式跑不要用它。
//
// 模式：
//   fund      從 anvil #0 的 BNB `WBNB.deposit()` 換成 WBNB 再 `transfer` 給 smart account（不用上游資金）
//   plan      唯讀：planPortfolio → planRebalance，印出將被送出的參數
//   execute   plan → session key 簽名的 UserOp → 落地 → 解 SwapExecuted → 餘額/漂移前後對照
//   drift     唯讀：只印目前的漂移（執行後再看一次用）
//   negative  負向對照：同一把 session key 送策略外的呼叫（ERC-20 `transfer`），看它被擋在哪一層
//
// 送出的 UserOp 走 alto（它有 simulation，拒絕時**不會**回 userOpHash）；負向對照另外直送一次原始
// JSON-RPC，把 body 原文印出來 —— 判斷有沒有被接受要看 body 裡有沒有 userOpHash，不是看 HTTP 狀態碼。

import { HDKey } from '@scure/bip32';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toECDSASigner, toEmptyECDSASigner } from '@zerodev/permissions/signers';
import {
  KernelV3_3AccountAbi,
  addressToEmptyAccount,
  createKernelAccount,
  createKernelAccountClient,
} from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import type { GetKernelVersion } from '@zerodev/sdk/types';
import { isAddressEqual } from 'viem';
import type { Address, Chain, Hex, PublicClient } from 'viem';
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, formatUnits, hexToBytes, http, keccak256, toBytes } from 'viem';
import type { TransactionReceipt } from 'viem';
import { entryPoint07Abi, toPackedUserOperation } from 'viem/account-abstraction';
import type { UserOperation } from 'viem/account-abstraction';
import { hdKeyToAccount, privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';
import { getConfig } from '../src/config.js';
import { closePool, query } from '../src/db.js';
import { buildSessionPermissions, deriveSessionKey } from '../src/permissions.js';
import { DEFAULT_DEADLINE_SECONDS, planRebalance, refreshFloors } from '../src/rebalance-plan.js';
import type { PlannedStep } from '../src/rebalance-plan.js';
import { REBALANCE_CALL_GAS_FLOOR, rebalanceCallGasLimit } from '../src/scheduler.js';
import { DEFAULT_THRESHOLD_BPS, planPortfolio } from '../src/snapshot.js';

/** EntryPoint v0.7：`toPermissionValidator` 只接受 0.7。 */
const ENTRY_POINT = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;

/**
 * `.env` 裡的 `RPC_URL=` 是空字串，而空字串不是「沒設」：`http('')` 會把請求送去某個不是 anvil 的地方
 * （實測：讀到 BNB 0、送出時回 insufficient funds）。所以空字串一律當成沒設。
 */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

const RPC_URL = firstNonEmpty(process.env.RPC_URL, process.env.ANVIL_RPC_URL) ?? 'http://127.0.0.1:8545';
const BUNDLER_URL = firstNonEmpty(process.env.BUNDLER_URL) ?? 'http://127.0.0.1:3001';
const CHAIN_ID = 56;

/**
 * fork 的三個資產（`version.assets`）。前兩個是 v1 的單池堆疊用的，NVDAB 只有在多池 oracle
 * （`numeraire` = USDT 的 hub 模式）下換得動 —— 它也是「3 資產」與「2 資產」的差別所在。
 */
const WBNB: Address = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT: Address = '0x55d398326f99059fF775485246999027B3197955';
const NVDAB: Address = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';

/** anvil #0：唯一的資金來源。那 9995 BNB 是 anvil 自己灌的，不是上游真錢。 */
const ANVIL0: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL0_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/** CallPolicy 白名單裡唯一的 selector：`executeRebalance(address,(...)[],uint256)`。 */
const EXECUTE_REBALANCE_SELECTOR: Hex = '0x1b977850';

/**
 * `SwapStep` 的欄位名照合約寫（AtpExecutor.sol:46-59）。名字不影響 ABI 編碼，但解碼/稽核時要對得上。
 */
const REBALANCE_ABI = [
  {
    type: 'function',
    name: 'executeRebalance',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      {
        name: 'steps',
        type: 'tuple[]',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'commands', type: 'bytes' },
          { name: 'inputs', type: 'bytes[]' },
        ],
      },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** 唯一能證明「幣真的換了」的事件（AtpExecutor.sol:62-71）。 */
const SWAP_EXECUTED_ABI = [
  {
    type: 'event',
    name: 'SwapExecuted',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: false },
      { name: 'tokenOut', type: 'address', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'gross', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'net', type: 'uint256', indexed: false },
      { name: 'oracleFloor', type: 'uint256', indexed: false },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'address' },
      { name: '', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** WBNB 的 `deposit()`：把 BNB 換成 WBNB，入金就不用碰上游資金。 */
const WBNB_ABI = [
  ...ERC20_ABI,
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;

const EXECUTOR_ABI = [
  { type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'effectiveFeeBps',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint16' }],
  },
] as const;

/**
 * 直送 EntryPoint 用的固定上限（負向對照只需要一個「送得出去」的 op）。
 * 上限只在 prefund 檢查與退款計算裡當最大值用，實際消耗照真實用量結算。
 */
const DIRECT_GAS = { verificationGasLimit: 600_000n, callGasLimit: 400_000n, preVerificationGas: 150_000n } as const;

type Mode = 'fund' | 'plan' | 'execute' | 'drift' | 'negative' | 'probe';

type Args = {
  mode: Mode;
  portfolioId: number;
  executor: Address;
  registry: Address;
  thresholdBps: number;
  deadlineSeconds: number;
  amountWei: bigint;
  masterSeed: Hex;
  /** 指定用哪一把 key（DB 的 key_ref）。null = 用索引最大的那一把。 */
  keyRefOverride: `m/44'/60'/${string}` | null;
  /**
   * 簽名前要不要重問地板（預設 true = 與排程器 live 路徑同一條）。
   *
   * `--refresh-floors no` 是**重現用**的開關：它把行為還原成「拿規劃時凍結的 amountOutMin 去簽名」，
   * 也就是 plan → execute 之間地板漂移會 `BelowFloor` 的那條路。A/B 對照靠它。
   */
  refreshFloors: boolean;
  /**
   * 送出的 gas 防護（預設 true = 與排程器 live 路徑同一條）。
   *
   * `--gas-guard off` 是**重現用**的開關（與 `--refresh-floors no` 同一個用途）：它把行為還原成
   * 「不覆寫 `callGasLimit`、也不做送出前的 `eth_call` 模擬」，也就是 alto 估 367,885 就簽 367,885
   * 的那條路。A/B 對照靠它：同一組參數在 off 之下會拿到 `tx.status = 1` + `success = false` +
   * `SwapExecuted 0 筆`，在 on 之下才會真的換到幣（docs/pitfalls §8.16）。
   */
  gasGuard: boolean;
};

const log = (section: string, message: string): void => {
  console.log(`[${section}] ${message}`);
};

const json = (value: unknown): string => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

/** 代幣最小單位 → 顆數（固定 6 位），只給人看。 */
function formatTokens(amountWei: bigint, decimals = 18): string {
  const scale = 10n ** BigInt(decimals);
  return `${amountWei / scale}.${(((amountWei % scale) * 1_000_000n) / scale).toString().padStart(6, '0')}`;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!.slice(0, 400);
}

function kernelVersion33(): GetKernelVersion<'0.7'> {
  return KERNEL_V3_3;
}

function parseArgs(argv: readonly string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, fallback: number): number => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new Error(`--${name} 必須是整數，收到 "${raw}"`);
    return value;
  };

  const mode = (flag('mode') ?? 'plan') as Mode;
  if (!['fund', 'plan', 'execute', 'drift', 'negative', 'probe'].includes(mode)) {
    throw new Error(`--mode 只接受 fund|plan|execute|drift|negative|probe，收到 "${mode}"`);
  }

  const executor = firstNonEmpty(flag('executor'), process.env.EXECUTOR_ADDRESS);
  const registry = firstNonEmpty(flag('registry'), process.env.REGISTRY_ADDRESS);
  if (executor === undefined || !/^0x[0-9a-fA-F]{40}$/.test(executor)) {
    throw new Error('缺少 AtpExecutor 地址：--executor 或 EXECUTOR_ADDRESS');
  }
  if (registry === undefined || !/^0x[0-9a-fA-F]{40}$/.test(registry)) {
    throw new Error('缺少 AtpRegistry 地址：--registry 或 REGISTRY_ADDRESS');
  }

  // 入金金額用 decimal 字串解析成 wei：大數字一律 bigint，不經過 Number。
  const amountRaw = flag('amount') ?? '0.5';
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(amountRaw);
  if (match === null) throw new Error(`--amount 必須是正的小數（18 位以內），收到 "${amountRaw}"`);
  const amountWei = BigInt(match[1]!) * 10n ** 18n + BigInt((match[2] ?? '').padEnd(18, '0'));

  const masterSeed = firstNonEmpty(process.env.SESSION_KEY_MASTER_SEED);
  if (masterSeed === undefined || !/^0x[0-9a-fA-F]{64}$/.test(masterSeed)) {
    throw new Error('SESSION_KEY_MASTER_SEED 未設定或格式不對：派生 session key 需要 0x + 64 hex');
  }

  const refreshRaw = firstNonEmpty(flag('refresh-floors'));
  if (refreshRaw !== undefined && !['yes', 'no'].includes(refreshRaw)) {
    throw new Error(`--refresh-floors 只接受 yes|no，收到 "${refreshRaw}"`);
  }

  const keyRefRaw = firstNonEmpty(flag('key-ref'));
  if (keyRefRaw !== undefined && !/^m\/44'\/60'\/0'\/0\/\d+$/.test(keyRefRaw)) {
    throw new Error(`--key-ref 格式必須是 m/44'/60'/0'/0/<index>，收到 "${keyRefRaw}"`);
  }

  const gasGuardRaw = firstNonEmpty(flag('gas-guard'));
  if (gasGuardRaw !== undefined && !['on', 'off'].includes(gasGuardRaw)) {
    throw new Error(`--gas-guard 只接受 on|off，收到 "${gasGuardRaw}"`);
  }

  return {
    mode,
    portfolioId: num('portfolio', 5),
    executor: executor.toLowerCase() as Address,
    registry: registry.toLowerCase() as Address,
    thresholdBps: num('threshold-bps', DEFAULT_THRESHOLD_BPS),
    // 只有一個來源：rebalance-plan.ts 的 DEFAULT_DEADLINE_SECONDS（1800）。寫死第二個數字就是
    // 讓腳本與規劃器的預設默默分岔（這裡原本是 86_400，與 1800 差 48 倍）。
    deadlineSeconds: num('deadline-seconds', DEFAULT_DEADLINE_SECONDS),
    amountWei,
    masterSeed: masterSeed as Hex,
    keyRefOverride: (keyRefRaw ?? null) as `m/44'/60'/${string}` | null,
    refreshFloors: refreshRaw !== 'no',
    gasGuard: gasGuardRaw !== 'off',
  };
}

// ---------------------------------------------------------------------------
// 上下文：DB 的 portfolio / smart account / 最新一把 session key
// ---------------------------------------------------------------------------

type Context = {
  portfolioId: number;
  dbStrategyId: string;
  version: number;
  account: Address;
  owner: Address;
  keyRef: `m/44'/60'/${string}`;
  keyIndex: bigint;
  validUntil: number;
  permissionId: Hex;
  sessionKeyAddress: Address;
};

async function loadContext(
  portfolioId: number,
  keyRefOverride: `m/44'/60'/${string}` | null = null,
): Promise<Context> {
  const portfolio = (
    await query<{ id: string; strategy_id: string; version: number; account: string; owner: string }>(
      `select p.id, p.strategy_id, p.version, s.address as account, s.owner
         from portfolios p join smart_accounts s on s.portfolio_id = p.id
        where p.id = $1`,
      [portfolioId],
    )
  ).rows[0];
  if (portfolio === undefined) throw new Error(`portfolio ${portfolioId} 或它的 smart_account 不存在`);

  // 「最新一把」＝ key_ref 最後一層的索引最大者。刻意用數值排序：字串排序對不同位數會排錯。
  // `--key-ref` 可以指定別的一把（DB 有列但鏈上沒安裝的 key 送不出 op，這時要換成已安裝的那把）。
  const key =
    keyRefOverride === null
      ? (
          await query<{ key_ref: string; permissions: PermissionSnapshot }>(
            `select key_ref, permissions
               from session_keys
              where portfolio_id = $1 and status = 'active'
              order by (split_part(key_ref, '/', 6))::bigint desc
              limit 1`,
            [portfolioId],
          )
        ).rows[0]
      : (
          await query<{ key_ref: string; permissions: PermissionSnapshot }>(
            `select key_ref, permissions from session_keys where portfolio_id = $1 and key_ref = $2`,
            [portfolioId, keyRefOverride],
          )
        ).rows[0];
  if (key === undefined) {
    throw new Error(`portfolio ${portfolioId} 沒有 ${keyRefOverride ?? 'active'} 的 session key`);
  }

  const keyRef = key.key_ref as `m/44'/60'/${string}`;
  const lastSegment = keyRef.split('/').at(-1);
  if (lastSegment === undefined) throw new Error(`key_ref 格式不對：${keyRef}`);
  const validUntil = Number(key.permissions.timestamp.validUntil);
  if (!Number.isInteger(validUntil)) throw new Error(`session_keys.permissions.timestamp.validUntil 不是整數`);

  return {
    portfolioId,
    dbStrategyId: portfolio.strategy_id,
    version: portfolio.version,
    account: portfolio.account.toLowerCase() as Address,
    owner: portfolio.owner.toLowerCase() as Address,
    keyRef,
    keyIndex: BigInt(lastSegment),
    validUntil,
    permissionId: key.permissions.permissionId,
    sessionKeyAddress: key.permissions.sessionKeyAddress.toLowerCase() as Address,
  };
}

type PermissionSnapshot = {
  permissionId: Hex;
  sessionKeyAddress: string;
  timestamp: { validUntil: number };
};

// ---------------------------------------------------------------------------
// session key：派生 → 與 DB / src/permissions.ts 三方對帳 → 鏈上 permissionConfig
// ---------------------------------------------------------------------------

type SessionSigner = {
  address: Address;
  permissionId: Hex;
  permissionValidator: Awaited<ReturnType<typeof buildSessionPermissions>>['permissionValidator'];
};

/**
 * 從 master seed 沿著 DB 的 `key_ref` 派生私鑰，然後用**三個來源**互相比對才拿去簽章：
 *   ① `hdKeyToAccount(seed, key_ref)` 的地址（真正簽章的那把）
 *   ② `src/permissions.ts` 的 `deriveSessionKey(index)`（production 派生器）
 *   ③ DB `session_keys.permissions.sessionKeyAddress`
 * 三者不一致就停 —— 簽章要用的是「DB 認為存在的那把」，不是「剛好算出來的那把」。
 */
async function buildSessionSigner(
  publicClient: PublicClient,
  ctx: Context,
  masterSeed: Hex,
  executor: Address,
): Promise<SessionSigner> {
  const keyAccount = hdKeyToAccount(HDKey.fromMasterSeed(hexToBytes(masterSeed)), { path: ctx.keyRef });
  const derived = deriveSessionKey(ctx.keyIndex, { masterSeed });
  if (!isAddressEqual(derived.address, keyAccount.address)) {
    throw new Error(`派生不一致：src/permissions.ts=${derived.address} script=${keyAccount.address}`);
  }
  if (!isAddressEqual(keyAccount.address, ctx.sessionKeyAddress)) {
    throw new Error(`派生出的 ${keyAccount.address} 不是 DB 記的 session key ${ctx.sessionKeyAddress}`);
  }
  log('sk', `session key ${keyAccount.address}（${ctx.keyRef}，index ${ctx.keyIndex}）：seed → 地址 與 DB 一致`);

  const perms = await buildSessionPermissions({
    publicClient,
    sessionKeyAddress: keyAccount.address,
    executorAddress: executor,
    validUntil: ctx.validUntil,
    // 真 signer：這把 key 要簽 executeRebalance。少了它 plugin 簽不出東西。
    signer: await toECDSASigner({ signer: keyAccount }),
  });
  if (perms.permissionId.toLowerCase() !== ctx.permissionId.toLowerCase()) {
    throw new Error(`permissionId 不符：重建 ${perms.permissionId} != DB ${ctx.permissionId}（validUntil 或 policy 參數變了）`);
  }
  log('sk', `permissionId ${perms.permissionId}（與 DB 相同，validUntil ${ctx.validUntil}）`);

  // 鏈上事實：這組權限真的裝在帳戶上嗎？（沒裝的話帳戶地址不變、也沒有任何錯誤提示，只能這樣查）
  //
  // ⚠ 這裡比的是 **signer contract**，不是 session key 的 EOA：Kernel 把 `signer` 存成 validator 合約
  // 位址（ECDSA validator 對每個 key 都是同一個），真正的 key 在 enableData 裡。所以這個檢查能證明的
  // 只有「這組 policy 已安裝」，不能證明「綁的就是這把 key」—— 後者只有真的送一筆 op 才會知道。
  const installed = await publicClient.readContract({
    address: ctx.account,
    abi: KernelV3_3AccountAbi,
    functionName: 'permissionConfig',
    args: [perms.permissionId],
  });
  const signerContract = toEmptyECDSASigner(keyAccount.address).signerContractAddress;
  log(
    'sk',
    `鏈上 permissionConfig(${perms.permissionId}) signer=${installed.signer}（validator 合約應為 ${signerContract}）policies=${installed.policyData.length} flag=${installed.permissionFlag}`,
  );
  if (!isAddressEqual(installed.signer, signerContract) || installed.policyData.length !== 3) {
    throw new Error(
      `這組權限沒安裝在 ${ctx.account} 上（signer=${installed.signer}、policies=${installed.policyData.length}）：` +
        `${ctx.keyRef} 只有 DB 的列，鏈上沒有對應的 permission。安裝要 owner 的簽章，不是這支腳本的事 —— 換一把已安裝的 key（--key-ref）或被擋在這裡`,
    );
  }
  log('sk', '權限已安裝（三層 policy 齊全）；「綁的是這把 key」由接下來這筆 op 的 validation 證明');

  return { address: keyAccount.address, permissionId: perms.permissionId, permissionValidator: perms.permissionValidator };
}

/**
 * 建立「session key 簽章」的 Kernel 帳戶。
 *
 * `sudo` 只給 owner 的**空帳號**（本行程有它的地址、沒有它的私鑰）：推導地址與填 nonce 需要它，
 * 但簽章用的是 `regular`。這一行的 plugins 就是「不是 sudo 簽」的全部證據。
 */
async function sessionKeyAccount(publicClient: PublicClient, ctx: Context, session: SessionSigner) {
  const account = await createKernelAccount(publicClient, {
    address: ctx.account,
    plugins: {
      sudo: await signerToEcdsaValidator(publicClient, {
        signer: addressToEmptyAccount(ctx.owner),
        entryPoint: ENTRY_POINT,
        kernelVersion: kernelVersion33(),
      }),
      regular: session.permissionValidator,
    },
    entryPoint: ENTRY_POINT,
    kernelVersion: kernelVersion33(),
    useMetaFactory: true,
  });
  if (!isAddressEqual(account.address, ctx.account)) {
    throw new Error(`帳戶地址不符：算出 ${account.address} != 已部署 ${ctx.account}`);
  }
  // 這一行就是「簽章的是 session key 不是 sudo」的證據：sudo 只有 owner 的地址（本行程沒有它的私鑰），
  // regular 才是簽 userOp 的那一個。
  log(
    'exec',
    `createKernelAccount(${ctx.account}) plugins: { sudo: signerToEcdsaValidator(addressToEmptyAccount(${ctx.owner})), ` +
      `regular: permissionValidator(permissionId ${session.permissionId}) } → userOp 由 regular 簽`,
  );
  return account;
}

function sessionClient(account: Awaited<ReturnType<typeof sessionKeyAccount>>, publicClient: PublicClient, chain: Chain) {
  return createKernelAccountClient({
    account,
    chain,
    client: publicClient,
    bundlerTransport: http(BUNDLER_URL),
    // alto 不提供 ZeroDev 的 zd_getUserOperationGasPrice，用節點 gas price。
    userOperation: {
      estimateFeesPerGas: async () => {
        const gasPrice = await publicClient.getGasPrice();
        return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 讀數：餘額 / 漂移 / 規劃
// ---------------------------------------------------------------------------

type Balances = { wbnb: bigint; usdt: bigint; nvdab: bigint; bnb: bigint };

async function readBalances(publicClient: PublicClient, account: Address): Promise<Balances> {
  const [wbnb, usdt, nvdab, bnb] = await Promise.all([
    publicClient.readContract({ address: WBNB, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    publicClient.readContract({ address: USDT, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    publicClient.readContract({ address: NVDAB, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    publicClient.getBalance({ address: account }),
  ]);
  return { wbnb, usdt, nvdab, bnb };
}

/** 代幣地址 → 餘額，給「每一步的 tokenIn 減少 / tokenOut 增加」這種與資產數無關的斷言用。 */
function balanceOf(balances: Balances, token: Address): bigint {
  if (isAddressEqual(token, WBNB)) return balances.wbnb;
  if (isAddressEqual(token, USDT)) return balances.usdt;
  if (isAddressEqual(token, NVDAB)) return balances.nvdab;
  throw new Error(`${token} 不在這支腳本認得的資產裡（Balances 只有 WBNB/USDT/NVDAB）`);
}

function printBalances(label: string, balances: Balances): void {
  log(
    'bal',
    `${label} WBNB ${balances.wbnb} (${formatTokens(balances.wbnb)}) | USDT ${balances.usdt} (${formatTokens(balances.usdt)}) | ` +
      `NVDAB ${balances.nvdab} (${formatTokens(balances.nvdab)}) | BNB(gas) ${formatTokens(balances.bnb)}`,
  );
}

type Drift = Awaited<ReturnType<typeof planPortfolio>>;

function printDrift(label: string, plan: Drift): void {
  log('drift', `${label} block ${plan.snapshot.block} 總價值 ${plan.report?.totalUsdE8 ?? '?'} E8`);
  if (plan.report === null) {
    for (const blocked of plan.blocked) log('drift', `  ✗ [${blocked.code}] ${blocked.detail}`);
    return;
  }
  log(
    'drift',
    `  grossDriftBps ${plan.report.grossDriftBps}、maxAbsDeltaBps ${plan.report.maxAbsDeltaBps}、門檻 ${plan.report.thresholdBps} → ${plan.report.needsRebalance ? '需要再平衡' : '不需要再平衡'}`,
  );
  for (const row of plan.report.assets) {
    log('drift', `  ${row.asset} target ${row.targetBps} / current ${row.currentBps} / delta ${row.deltaBps > 0 ? '+' : ''}${row.deltaBps} bps`);
  }
  for (const holding of plan.snapshot.holdings) {
    log('drift', `  holding ${holding.asset} ${holding.amountWei}（${formatTokens(holding.amountWei, holding.decimals)} 顆）`);
  }
}

async function readPlan(args: Args, publicClient: PublicClient) {
  const plan = await planPortfolio(args.portfolioId, {
    publicClient,
    registryAddress: args.registry,
    thresholdBps: args.thresholdBps,
  });
  if (plan.report === null) {
    throw new Error(`漂移拒算：${plan.blocked.map((b) => `[${b.code}] ${b.detail}`).join('；')}`);
  }
  const block = await publicClient.getBlock({ blockNumber: plan.snapshot.block });
  const oracle = await publicClient.readContract({ address: args.executor, abi: EXECUTOR_ABI, functionName: 'oracle' });
  const rebalance = await planRebalance({
    publicClient,
    account: plan.account,
    executor: args.executor,
    oracle,
    registry: args.registry,
    strategyId: BigInt(plan.pinnedVersion.onchainStrategyId),
    holdings: plan.snapshot.holdings,
    targets: plan.targets,
    drift: plan.report,
    thresholdBps: plan.thresholdBps,
    blockNumber: plan.snapshot.block,
    deadlineSeconds: args.deadlineSeconds,
  });
  // `oracle` 一起回傳：送出前重問地板要用**同一個**報價來源（不然問到的不是合約會問的那個）。
  return { plan, block, rebalance, oracle };
}

// ---------------------------------------------------------------------------
// 模式：fund
// ---------------------------------------------------------------------------

async function modeFund(args: Args, publicClient: PublicClient, chain: Chain): Promise<void> {
  const ctx = await loadContext(args.portfolioId, args.keyRefOverride);
  const before = await readBalances(publicClient, ctx.account);
  printBalances('入金前', before);

  const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL0_KEY), chain, transport: http(RPC_URL) });
  const depositTx = await wallet.writeContract({
    address: WBNB,
    abi: WBNB_ABI,
    functionName: 'deposit',
    args: [],
    value: args.amountWei,
  });
  const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
  log('fund', `WBNB.deposit() ${args.amountWei} wei by anvil#0 ${ANVIL0}：tx ${depositTx} status=${depositReceipt.status}`);

  const transferTx = await wallet.writeContract({
    address: WBNB,
    abi: WBNB_ABI,
    functionName: 'transfer',
    args: [ctx.account, args.amountWei],
  });
  const transferReceipt = await publicClient.waitForTransactionReceipt({ hash: transferTx });
  log('fund', `WBNB.transfer(${ctx.account}, ${args.amountWei})：tx ${transferTx} status=${transferReceipt.status} block=${transferReceipt.blockNumber}`);
  if (transferReceipt.status !== 'success') throw new Error('入金交易 revert');

  const after = await readBalances(publicClient, ctx.account);
  printBalances('入金後', after);
  if (after.wbnb - before.wbnb !== args.amountWei) {
    throw new Error(`入金後 WBNB 只增加 ${after.wbnb - before.wbnb}，預期 ${args.amountWei}`);
  }
  console.log(json({ deposit: depositTx, transfer: transferTx, before, after }));
}

// ---------------------------------------------------------------------------
// 模式：plan / drift
// ---------------------------------------------------------------------------

async function modePlan(args: Args, publicClient: PublicClient): Promise<void> {
  const { plan, block, rebalance } = await readPlan(args, publicClient);
  printDrift('目前漂移', plan);
  log('plan', `塊時間 ${block.timestamp}`);
  if (rebalance.kind !== 'ready') {
    log('plan', `規劃結果 ${rebalance.kind}：${rebalance.reason}`);
    return;
  }
  log('plan', `規劃結果 ready：${rebalance.steps.length} 個 step，deadline ${rebalance.deadline}`);
  for (const [index, step] of rebalance.steps.entries()) {
    log('plan', `step ${index} tokenIn ${step.tokenIn} → tokenOut ${step.tokenOut}`);
    log('plan', `  amountIn ${step.amountIn}`);
    log('plan', `  amountOutMin ${step.amountOutMin}（= minGross）oracleFloor ${step.oracleFloor}`);
    log('plan', `  commands ${step.commands} inputs ${step.inputs.length}`);
  }
}

async function modeDrift(args: Args, publicClient: PublicClient): Promise<void> {
  const plan = await planPortfolio(args.portfolioId, {
    publicClient,
    registryAddress: args.registry,
    thresholdBps: args.thresholdBps,
  });
  printDrift('漂移', plan);
}

// ---------------------------------------------------------------------------
// 模式：execute（本工單的主驗收）
// ---------------------------------------------------------------------------

async function modeExecute(args: Args, publicClient: PublicClient, chain: Chain): Promise<void> {
  const ctx = await loadContext(args.portfolioId, args.keyRefOverride);
  const balancesBefore = await readBalances(publicClient, ctx.account);
  printBalances('交易前', balancesBefore);

  const allowances = await Promise.all(
    [WBNB, NVDAB, USDT].map((asset) =>
      publicClient.readContract({
        address: asset,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [ctx.account, args.executor],
      }),
    ),
  );
  log(
    'exec',
    `allowance(account → executor) WBNB ${allowances[0]} / NVDAB ${allowances[1]} / USDT ${allowances[2]}（uint160.max = ${(1n << 160n) - 1n}）`,
  );
  if (allowances.some((a) => a === 0n)) throw new Error('帳戶對 executor 的 allowance 有 0：執行器的 safeTransferFrom 一定失敗');

  const { plan, block, rebalance, oracle } = await readPlan(args, publicClient);
  printDrift('交易前漂移', plan);
  if (rebalance.kind !== 'ready') throw new Error(`規劃不是 ready（${rebalance.kind}）：${rebalance.reason}`);
  log('exec', `塊時間 ${block.timestamp}；規劃 ${rebalance.steps.length} 個 step；deadline ${rebalance.deadline}`);
  log('exec', `rationale：${rebalance.rationale}`);
  for (const [index, step] of rebalance.steps.entries()) {
    log('exec', `  規劃 step#${index} amountOutMin ${step.amountOutMin}（floor ${step.oracleFloor}，規劃塊 ${plan.snapshot.block}）`);
  }

  // session key 的簽章身分（派生三方對帳 + 鏈上 permissionConfig）
  const session = await buildSessionSigner(publicClient, ctx, args.masterSeed, args.executor);
  const account = await sessionKeyAccount(publicClient, ctx, session);

  // ---- 簽名前重問地板（與排程器 live 路徑同一條）---------------------------------------------
  // 上面的 `rebalance.steps` 是**規劃當時**（`plan.snapshot.block`）問到的地板。這一段到 `sendUserOperation`
  // 之間隔著建 session key、重建 permission、算 nonce —— 幾十秒。而 `previewSwap` 的 `minimum` 含近 5 分鐘
  // 均值，會追著池價跑，所以凍結值可能在執行那一塊就低於地板（合約 `_checkStep` 會自己再問一次）→
  // `BelowFloor`。`refreshFloors` 對每個 step 重問並用**新鮮值**覆寫（不是 max，理由見它的檔頭）。
  //
  // `--refresh-floors no` 保留舊行為（凍結值），那是 A/B 對照用的重現開關。
  let steps: readonly PlannedStep[] = rebalance.steps;
  if (args.refreshFloors) {
    const feeBpsRaw = await publicClient.readContract({
      address: args.registry,
      abi: REGISTRY_ABI,
      functionName: 'effectiveFeeBps',
      args: [BigInt(plan.pinnedVersion.onchainStrategyId)],
    });
    const refresh = await refreshFloors({ publicClient, oracle, steps: rebalance.steps, feeBps: Number(feeBpsRaw) });
    if (!refresh.ok) {
      // 放棄這一輪：問不到地板（或地板崩掉）就不簽名、不送 —— 用舊值硬送等於賭一個過期的下限。
      throw new Error(`送出前重問地板失敗（${refresh.kind}）：${refresh.reason}｜這一輪不送`);
    }
    for (const entry of refresh.refreshes) {
      log(
        'floor',
        `step#${entry.index} ${entry.tokenIn} → ${entry.tokenOut}：規劃 ${entry.plannedFloor} → 新鮮 ${entry.freshFloor}` +
          `（${entry.deltaBps >= 0 ? '+' : ''}${entry.deltaBps} bps）；amountOutMin ${entry.plannedAmountOutMin} → ${entry.freshAmountOutMin}`,
      );
    }
    log('floor', `feeBps ${feeBpsRaw}（registry.effectiveFeeBps）｜重問後 ${refresh.note}`);
    steps = refresh.steps;
  } else {
    log(
      'floor',
      '⚠ --refresh-floors no：用**規劃時凍結**的 amountOutMin 簽名（重現舊行為；plan → execute 之間地板漂移就 revert 在這條路上）',
    );
  }

  const data = encodeFunctionData({
    abi: REBALANCE_ABI,
    functionName: 'executeRebalance',
    args: [
      ctx.account,
      steps.map((step) => ({
        tokenIn: step.tokenIn,
        tokenOut: step.tokenOut,
        amountIn: step.amountIn,
        amountOutMin: step.amountOutMin,
        commands: step.commands,
        inputs: step.inputs,
      })),
      rebalance.deadline,
    ],
  });
  if (data.slice(0, 10) !== EXECUTE_REBALANCE_SELECTOR) {
    throw new Error(`selector 不符：${data.slice(0, 10)} != ${EXECUTE_REBALANCE_SELECTOR}（CallPolicy 會擋下）`);
  }
  log('exec', `calldata selector ${data.slice(0, 10)}（= CallPolicy 白名單的那一個），長度 ${data.length / 2 - 1} bytes`);

  const client = sessionClient(account, publicClient, chain);
  const calls = [{ to: args.executor, data, value: 0n }] as const;

  let userOpOverrides: { callGasLimit?: bigint } = {};
  if (args.gasGuard) {
    // ---- 送前 ①：`callGasLimit` 明確覆寫（不讓 alto 的估算單獨決定）-------------------------------
    // alto 對「一筆 op 跑完整條 DeFi 路徑」低估 20~35%（實測 367,885 vs 需要 450–500k），而 gas 不足的
    // 後果不是 revert —— EntryPoint 會 emit `UserOperationEvent(success = false)` 就繼續，`tx.status`
    // 還是 1（docs/pitfalls §8.16）。規則與排程器共用同一個函式，免得兩條路徑各有一套數字。
    const estimate = await client.estimateUserOperationGas({ calls });
    const callGasLimit = rebalanceCallGasLimit(estimate.callGasLimit);
    log(
      'exec',
      `callGasLimit：alto 估算 ${estimate.callGasLimit} → 簽名用 ${callGasLimit}` +
        `（規則 max(估算 × 1.5, ${REBALANCE_CALL_GAS_FLOOR})）`,
    );

    // ---- 送前 ②：以帳戶身分、`gas = callGasLimit` 模擬整格執行 ------------------------------------
    // `executeRebalance` 檢查 `msg.sender == account`，所以 `from = 帳戶` 的 eth_call 就是真正的那條路。
    // 通過 = 這個 gas 額度走得完；不通過就不送，不會有「簽了名才發現 gas 不夠」的帳單。
    try {
      await publicClient.call({ account: ctx.account, to: args.executor, data, gas: callGasLimit });
      log('exec', `送前 eth_call 通過：executeRebalance 在 ${callGasLimit} gas 內走得完`);
    } catch (error) {
      throw new Error(`送前 eth_call 模擬失敗（gas ${callGasLimit}），這一輪不送：${firstLine(error)}`);
    }
    userOpOverrides = { callGasLimit };
  } else {
    log(
      'exec',
      '⚠ --gas-guard off：不覆寫 callGasLimit、也不做送出前的 eth_call 模擬（**重現修前行為**；' +
        'gas 不夠時會拿到 tx.status = 1 + UserOperationEvent.success = false，錢照扣、幣沒換，§8.16）',
    );
  }

  const userOpHash = await client.sendUserOperation({ calls, ...userOpOverrides });
  log('exec', `userOpHash ${userOpHash}（session key ${session.address} 簽）`);
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash, timeout: 180_000 });
  log(
    'exec',
    `txHash ${receipt.receipt.transactionHash} status=${receipt.receipt.status} UserOperationEvent.success=${receipt.success} block=${receipt.receipt.blockNumber} gasUsed ${receipt.actualGasUsed ?? receipt.receipt.gasUsed}`,
  );

  // ---- 驗收 ①：SwapExecuted 的筆數必須等於 step 數 --------------------------------------------
  const swaps = decodeSwapExecuted(receipt.receipt, args.executor);
  log('swap', `SwapExecuted 事件 ${swaps.length} 筆（預期 ${steps.length}）`);
  for (const [index, swap] of swaps.entries()) {
    log(
      'swap',
      `  #${index} account ${swap.account} tokenIn ${swap.tokenIn} → tokenOut ${swap.tokenOut} amountIn ${swap.amountIn} gross ${swap.gross} fee ${swap.fee} net ${swap.net} oracleFloor ${swap.oracleFloor}`,
    );
  }

  // ---- 驗收 ②：餘額方向 ------------------------------------------------------------------------
  const balancesAfter = await readBalances(publicClient, ctx.account);
  printBalances('交易後', balancesAfter);
  const wbnbDelta = balancesAfter.wbnb - balancesBefore.wbnb;
  const usdtDelta = balancesAfter.usdt - balancesBefore.usdt;
  const nvdabDelta = balancesAfter.nvdab - balancesBefore.nvdab;
  log('bal', `ΔWBNB ${wbnbDelta}，ΔNVDAB ${nvdabDelta}，ΔUSDT ${usdtDelta}`);

  // ---- 驗收 ④：nonce key 證明簽章身分是 permission validator，不是 sudo -------------------------
  // UserOp 的 nonce = (key << 64) | seq。Kernel 把 validationType 放在 key 的第一個 byte：
  // 0x01 = sudo（owner 的 ECDSA），0x02 = 後續安裝的 validator（這裡就是 session key 的 permission
  // validator），其後接 permissionId。所以「高 192 bits 是 0x02…」是「不是 sudo 簽的」的鏈上證據 ——
  // 比 plugins 的設定更硬，因為它由 EntryPoint 在 validation 時寫進 op。
  const nonceInfo = decodeUserOpNonce(receipt.receipt, receipt.nonce ?? null);
  log(
    'nonce',
    `UserOperationEvent.nonce ${nonceInfo.nonce}；key（高 192 bits）${nonceInfo.keyHex}；seq ${nonceInfo.sequence}；` +
      `validationType ${nonceInfo.validationType}（0x01=sudo、0x02=permission validator）；permissionId ${nonceInfo.permissionId}`,
  );

  // ---- 驗收 ③：漂移下降 ------------------------------------------------------------------------
  const after = await planPortfolio(args.portfolioId, {
    publicClient,
    registryAddress: args.registry,
    thresholdBps: args.thresholdBps,
  });
  printDrift('交易後漂移', after);

  const failures: string[] = [];
  if (receipt.receipt.status !== 'success') failures.push(`tx status ${receipt.receipt.status}`);
  // 第 2 層：EntryPoint 對「驗證通過、執行失敗」不會讓交易 revert，只 emit `success = false`（§8.16）。
  // 少了這一條，SwapExecuted 的訊息會是「0 筆」而不是「op 失敗」——維運上要看到的是後者。
  if (receipt.success !== true) failures.push(`UserOperationEvent.success = false（EntryPoint 吞掉了執行失敗，§8.16）`);
  if (swaps.length !== steps.length) failures.push(`SwapExecuted ${swaps.length} 筆 != steps ${steps.length}`);
  // 舊版這裡還有一條寫死的「3 資產至少要有 2 筆」。hub 模式（numeraire = USDT）的規劃常常只有 1 個
  // step（買的那一步被衝擊上限縮成 dust 就跳過），那條會把「op 完全成功、換了 1 筆」報成失敗 ——
  // 而**筆數的權威是 `steps.length`**（上面那一行），不是資產數。

  // 餘額方向：用 `SwapExecuted` 事件算出**每個代幣的預期淨變化**，再與實際餘額變化比對。
  //
  // 為什麼不是「逐步」判定：hub 模式下 USDT 同時是 step0 的 tokenOut 與 step1 的 tokenIn。逐步看，
  // step0 會要求「USDT 增加」，但整批跑完它其實是**減少**的（買入那一步花掉更多）——三層全過卻 exit 1。
  // 逐代幣加總才是這批交易對帳戶餘額的真實影響：
  //   tokenOut 收到 net（= gross − fee，見 `AtpExecutor._splitFee`）→ +
  //   tokenIn  付出 amountIn（router 沒吃完的 residual 會退回帳戶，正常路徑為 0）→ −
  // 這個算法與模式無關：straight（A→B）與 hub（A→U、U→B）走同一個迴圈。
  const expectedDelta = new Map<string, bigint>();
  for (const swap of swaps) {
    const tokenOut = swap.tokenOut.toLowerCase();
    const tokenIn = swap.tokenIn.toLowerCase();
    expectedDelta.set(tokenOut, (expectedDelta.get(tokenOut) ?? 0n) + swap.net);
    expectedDelta.set(tokenIn, (expectedDelta.get(tokenIn) ?? 0n) - swap.amountIn);
  }
  for (const [token, expected] of expectedDelta) {
    const actual =
      balanceOf(balancesAfter, token as Address) - balanceOf(balancesBefore, token as Address);
    log('bal', `${token}：預期淨變化 ${expected}（SwapExecuted）、實際 ${actual}`);
    if (actual !== expected) {
      failures.push(`${token} 的餘額淨變化不符預期（SwapExecuted 算出 ${expected}、實際 ${actual}）`);
    }
  }

  // 身份：nonce key 必須是 permission validator（0x02），不是 sudo（0x01）。
  if (nonceInfo.validationType !== '0x0002') {
    failures.push(`UserOp 的 validationType 是 ${nonceInfo.validationType}，不是 permission validator 的 0x0002`);
  }

  const driftBefore = plan.report!.grossDriftBps;
  const driftAfter = after.report?.grossDriftBps ?? null;
  if (driftAfter === null || driftAfter >= driftBefore) {
    failures.push(`grossDriftBps 沒有下降（${driftBefore} → ${String(driftAfter)}）`);
  }

  console.log(
    json({
      account: ctx.account,
      sessionKey: session.address,
      permissionId: session.permissionId,
      keyRef: ctx.keyRef,
      refreshFloors: args.refreshFloors,
      steps: steps.length,
      amountIn: steps[0]?.amountIn,
      amountOutMin: steps[0]?.amountOutMin,
      oracleFloor: steps[0]?.oracleFloor,
      deadline: rebalance.deadline,
      userOpHash,
      txHash: receipt.receipt.transactionHash,
      blockNumber: receipt.receipt.blockNumber,
      status: receipt.receipt.status,
      userOpSuccess: receipt.success,
      callGasLimit: userOpOverrides.callGasLimit?.toString() ?? null,
      gasUsed: (receipt.actualGasUsed ?? receipt.receipt.gasUsed).toString(),
      nonce: nonceInfo.nonce.toString(),
      nonceKey: nonceInfo.keyHex,
      validationType: nonceInfo.validationType,
      noncePermissionId: nonceInfo.permissionId,
      nonceSequence: nonceInfo.sequence.toString(),
      swapExecuted: swaps.map((s) => ({
        account: s.account,
        tokenIn: s.tokenIn,
        tokenOut: s.tokenOut,
        amountIn: s.amountIn.toString(),
        gross: s.gross.toString(),
        fee: s.fee.toString(),
        net: s.net.toString(),
        oracleFloor: s.oracleFloor.toString(),
      })),
      balancesBefore,
      balancesAfter,
      driftBefore: {
        block: plan.snapshot.block.toString(),
        grossDriftBps: driftBefore,
        assets: plan.report!.assets.map((r) => ({ asset: r.asset, targetBps: r.targetBps, currentBps: r.currentBps, deltaBps: r.deltaBps })),
      },
      driftAfter: after.report === null
        ? null
        : {
            block: after.snapshot.block.toString(),
            grossDriftBps: after.report.grossDriftBps,
            assets: after.report.assets.map((r) => ({ asset: r.asset, targetBps: r.targetBps, currentBps: r.currentBps, deltaBps: r.deltaBps })),
          },
      failures,
    }),
  );

  if (failures.length > 0) throw new Error(`驗收未通過：${failures.join('；')}`);
  log(
    'exec',
    '✅ 驗收通過：SwapExecuted 筆數 = steps、每個代幣的餘額淨變化 = SwapExecuted 算出的預期值、grossDriftBps 下降',
  );
}

/** `UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)` 的 topic0。 */
const USER_OPERATION_EVENT_TOPIC = keccak256(
  toBytes('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'),
);

type NonceInfo = {
  nonce: bigint;
  /** 高 192 bits。第一個 byte 是 validationType，其後是 permissionId。 */
  keyHex: Hex;
  sequence: bigint;
  validationType: string;
  permissionId: Hex;
};

/**
 * 從 `UserOperationEvent` 解出 nonce 並拆成 (key, seq)。
 *
 * `nonce = (key << 64) | seq`，而 key 的高 8 bits 是 Kernel 的 validationType：
 * `0x01` = sudo（owner 的 ECDSA validator）、`0x02` = 帳戶上另外安裝的 validator（這裡是 session key
 * 的 permission validator）。這比讀 `plugins` 設定更硬：這個值由 EntryPoint 在 validation 期間寫入。
 */
function decodeUserOpNonce(receipt: TransactionReceipt, fallback: bigint | null): NonceInfo {
  let nonce: bigint | null = null;
  for (const entry of receipt.logs) {
    if (!isAddressEqual(entry.address, ENTRY_POINT.address)) continue;
    if (entry.topics[0] !== USER_OPERATION_EVENT_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: entryPoint07Abi,
        data: entry.data,
        topics: entry.topics as unknown as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'UserOperationEvent') continue;
      nonce = (decoded.args as unknown as { nonce: bigint }).nonce;
      break;
    } catch {
      // 不是這個事件就換下一個 log
    }
  }
  const value = nonce ?? fallback;
  if (value === null) throw new Error('找不到 UserOperationEvent.nonce，也沒有可用的 fallback');

  const key = value >> 64n;
  const keyHex = `0x${key.toString(16).padStart(48, '0')}` as Hex;
  // Kernel 的 nonce key 佈局（實測，非文件）：192 bits 裡的最高 2 bytes = validationType，其後 4 bytes
  // = permissionId，其餘 18 bytes 補 0。所以 sudo 是 0x0001…、permission validator 是 0x0002…。
  // 實測值長這樣：0x0002e95382df000… = type 0x0002 ++ permissionId 0xe95382df（後者等於 DB 的
  // permissionId，兩者對上才算真的證明「簽章身分是這組權限」）。
  const validationTypeValue = key >> 176n;
  const validationType = `0x${validationTypeValue.toString(16).padStart(4, '0')}`;
  const permissionId = `0x${((key >> 144n) & 0xffffffffn).toString(16).padStart(8, '0')}` as Hex;

  return { nonce: value, keyHex, sequence: value & ((1n << 64n) - 1n), validationType, permissionId };
}

type DecodedSwap = {
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  gross: bigint;
  fee: bigint;
  net: bigint;
  oracleFloor: bigint;
};

/** 只認 executor 自己 emit 的 `SwapExecuted`：別的合約的 log 不算「幣換了」。 */
function decodeSwapExecuted(receipt: TransactionReceipt, executor: Address): DecodedSwap[] {
  const decoded: DecodedSwap[] = [];
  for (const entry of receipt.logs) {
    if (!isAddressEqual(entry.address, executor)) continue;
    try {
      const event = decodeEventLog({
        abi: SWAP_EXECUTED_ABI,
        data: entry.data,
        topics: entry.topics as unknown as [Hex, ...Hex[]],
      });
      if (event.eventName !== 'SwapExecuted') continue;
      const args = event.args as unknown as DecodedSwap;
      decoded.push(args);
    } catch {
      // 同一個合約的其他事件（這裡沒有，但不要讓未來新增的事件讓驗收爆掉）
    }
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// 模式：probe（只建出簽章身分，不送任何東西）
// ---------------------------------------------------------------------------

/** 唯讀：派生 → 對帳 → 鏈上 permissionConfig → 建出 Kernel 帳戶（印出 plugins），**不送 op**。 */
async function modeProbe(args: Args, publicClient: PublicClient): Promise<void> {
  const ctx = await loadContext(args.portfolioId, args.keyRefOverride);
  const session = await buildSessionSigner(publicClient, ctx, args.masterSeed, args.executor);
  const account = await sessionKeyAccount(publicClient, ctx, session);
  printBalances('目前餘額', await readBalances(publicClient, ctx.account));
  console.log(
    json({ account: account.address, sessionKey: session.address, permissionId: session.permissionId, keyRef: ctx.keyRef, sent: false }),
  );
}

// ---------------------------------------------------------------------------
// 模式：negative（策略外呼叫被擋在哪一層）
// ---------------------------------------------------------------------------

async function modeNegative(args: Args, publicClient: PublicClient, chain: Chain): Promise<void> {
  const ctx = await loadContext(args.portfolioId, args.keyRefOverride);
  const session = await buildSessionSigner(publicClient, ctx, args.masterSeed, args.executor);
  const account = await sessionKeyAccount(publicClient, ctx, session);
  log('neg', `同一把 session key ${session.address}（permissionId ${session.permissionId}）`);

  // 策略外：ERC-20 transfer 給別人。CallPolicy 只白名單 executor + executeRebalance，
  // 這個 target 與 selector 都不在裡面。
  const recipient: Address = '0x000000000000000000000000000000000000dEaD';
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [recipient, 1n] });
  const call = { to: WBNB, data, value: 0n };
  log('neg', `策略外呼叫：WBNB.transfer(${recipient}, 1) selector ${data.slice(0, 10)} target ${WBNB}`);

  // ---- 途徑 A：交給 alto（正常的 keeper 路徑）---------------------------------------------------
  const client = sessionClient(account, publicClient, chain);
  let altoError: string | null = null;
  try {
    const hash = await client.sendUserOperation({ calls: [call] });
    log('neg', `⚠ alto 接受了這筆 op：userOpHash ${hash}`);
    const receipt = await client.waitForUserOperationReceipt({ hash, timeout: 180_000 });
    log('neg', `⚠ 上鏈結果 success=${receipt.success} tx ${receipt.receipt.transactionHash} status=${receipt.receipt.status}`);
  } catch (error) {
    altoError = firstLine(error);
    log('neg', `alto 拒絕：${altoError}`);
  }

  // ---- 途徑 B：原始 JSON-RPC，看 body 裡有沒有 userOpHash ---------------------------------------
  const callData = await account.encodeCalls([call]);
  const nonce = await account.getNonce();
  const gasPrice = await publicClient.getGasPrice();
  const op: UserOperation<'0.7'> = {
    sender: account.address,
    nonce,
    callData,
    ...DIRECT_GAS,
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice,
    signature: '0x',
  };
  const signature = await account.signUserOperation(op);
  const signed: UserOperation<'0.7'> = { ...op, signature };
  const packed = toPackedUserOperation(signed);
  const userOpHash = await publicClient.readContract({
    address: ENTRY_POINT.address,
    abi: entryPoint07Abi,
    functionName: 'getUserOpHash',
    args: [packed],
  });
  log('neg', `已用 session key 簽好：userOpHash ${userOpHash}（若 alto 不接，這個 hash 不會上鏈）`);

  // 原始 JSON-RPC 的 body 要自己組：alto 吃的是 v0.7 的 **unpacked** 欄位名（factory/factoryData…），
  // 不是 `toPackedUserOperation` 之後的 initCode/paymasterAndData；數值一律 hex、bigint 不能直接
  // JSON.stringify。少了任何一個必填欄位，alto 會回 schema 錯誤而不是 validation 的結論 —— 那種回覆
  // 證明不了「權限擋下它」。
  const hex = (value: bigint): Hex => `0x${value.toString(16)}`;
  const rpcOp = {
    sender: signed.sender,
    nonce: hex(signed.nonce),
    callData: signed.callData,
    callGasLimit: hex(signed.callGasLimit),
    verificationGasLimit: hex(signed.verificationGasLimit),
    preVerificationGas: hex(signed.preVerificationGas),
    maxFeePerGas: hex(signed.maxFeePerGas),
    maxPriorityFeePerGas: hex(signed.maxPriorityFeePerGas),
    signature: signed.signature,
  };
  const response = await fetch(BUNDLER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendUserOperation',
      params: [rpcOp, ENTRY_POINT.address],
    }),
  });
  const text = await response.text();
  log('neg', `eth_sendUserOperation HTTP ${response.status}；body：${text.slice(0, 1200)}`);
  const bodyHasUserOpHash = text.includes('userOpHash');
  log('neg', `body 裡有沒有 userOpHash：${bodyHasUserOpHash ? '有（alto 接受了）' : '沒有（送不出去）'}`);

  // ---- 途徑 C：鏈上真相。handleOps 的 eth_call 會跑完整 validation，revert 就是 validation 擋的 --
  let handleOpsSimulation: { ok: boolean; detail: string } = { ok: false, detail: 'not run' };
  try {
    await publicClient.call({
      to: ENTRY_POINT.address,
      data: encodeFunctionData({
        abi: entryPoint07Abi,
        functionName: 'handleOps',
        args: [[packed], ANVIL0],
      }),
    });
    handleOpsSimulation = { ok: true, detail: 'handleOps 模擬成功：這是「成功但什麼都沒做」的形狀，要對照餘額' };
  } catch (error) {
    const details = error instanceof Error ? `${error.message}` : String(error);
    handleOpsSimulation = { ok: false, detail: details.split('\n').slice(0, 6).join(' | ').slice(0, 600) };
  }
  log('neg', `handleOps eth_call：${handleOpsSimulation.ok ? '✅ 通過' : `✗ revert：${handleOpsSimulation.detail}`}`);

  console.log(
    json({
      sessionKey: session.address,
      permissionId: session.permissionId,
      call: { target: WBNB, selector: data.slice(0, 10), data },
      alto: { rejected: altoError !== null, error: altoError, bodyHasUserOpHash },
      rawSendBody: text.slice(0, 2000),
      userOpHash,
      handleOpsSimulation,
    }),
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // getConfig() 會載入 .env（DATABASE_URL）；RPC 與地址來源獨立於它。
  getConfig();
  const publicClient = createPublicClient({ chain: bsc, transport: http(RPC_URL) });
  const chain = bsc;

  log('env', `RPC ${RPC_URL}｜bundler ${BUNDLER_URL}｜chain ${CHAIN_ID}｜mode ${args.mode}｜portfolio ${args.portfolioId}`);

  switch (args.mode) {
    case 'fund':
      await modeFund(args, publicClient, chain);
      break;
    case 'plan':
      await modePlan(args, publicClient);
      break;
    case 'drift':
      await modeDrift(args, publicClient);
      break;
    case 'execute':
      await modeExecute(args, publicClient, chain);
      break;
    case 'negative':
      await modeNegative(args, publicClient, chain);
      break;
    case 'probe':
      await modeProbe(args, publicClient);
      break;
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`\n失敗：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => undefined);
}
