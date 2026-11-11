// D-23 收尾：把「3 資產再平衡真的上鏈」的**前置**步驟（建立策略 / enroll / 入金 / 唯讀對帳）自動化。
//
// ⚠ DEV / FORK ONLY。會送鏈上交易、會用 anvil 的 impersonate + setBalance 從 pool 搬測試資金。
//   私鑰只從 process.env（或本檔的公開 anvil 測試向量）讀，不落任何檔案。
//
// 為什麼要有這支：
//   `execute-rebalance.ts` 已經能做「session key 送 executeRebalance」，但它假設帳戶與策略都存在。
//   3 資產要的東西它一概不管：DB 的策略列、鏈上的 registerStrategy/publishVersion、新的 portfolio、
//   以及「讓帳戶真的持有三個代幣」。這些都在這裡，一次做完並印出可貼的證據。
//
// 為什麼不手寫 SQL 建策略：
//   `createStrategy`/`publishVersion`（src/strategies.ts）在鏈上有設定時會**先送 registerStrategy /
//   publishVersion 再寫 DB**，並把 on-chain id 記回 `strategies.onchain_id`。手寫 INSERT 會得到一個
//   onchain_id 為 null 的策略，enroll 會直接失敗。走函式路徑＝走同一份驗證與同一份副作用。
//
// 模式：
//   create   建立策略 + 發佈 version 1（3 資產，3334/3333/3333 bps），鏈上註冊與發佈都在裡面
//   enroll   enrollPortfolio(new strategy, owner) → 新 smart account（salt 含 strategyId，地址必然是新的）
//   fund     入金：anvil#0 打 BNB（gas）+ deposit WBNB；USDT/NVDAB 由 NVDAB/USDT pool 以 impersonate 搬
//   state    唯讀對帳：DB 列、鏈上 version.assets/weightsBps、enrollment、三個 allowance、
//            permissionConfig、三個餘額、oracle 報價、目前漂移
//
// 跑法（全部 inline 帶 env；backend/.env 缺 RPC_URL/EXECUTOR_ADDRESS/SESSION_KEY_MASTER_SEED）：
//   RPC_URL=http://127.0.0.1:8545 OPERATOR_PRIVATE_KEY=0x… REGISTRY_ADDRESS=0x2773… \
//   EXECUTOR_ADDRESS=0x9C41… SESSION_KEY_MASTER_SEED=0x… bun run scripts/three-asset-e2e.ts --mode create

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { KernelV3_3AccountAbi, addressToEmptyAccount } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { isAddressEqual } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { createPublicClient, createWalletClient, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';
import { closePool, query } from '../src/db.js';
import { buildSessionPermissions, deriveSessionKeyFor } from '../src/permissions.js';
import { enrollPortfolio } from '../src/portfolios.js';
import { DEFAULT_THRESHOLD_BPS, planPortfolio } from '../src/snapshot.js';
import { createStrategy, publishVersion } from '../src/strategies.js';

const ENTRY_POINT = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;

/** `.env` 的 `RPC_URL=` 是空字串，空字串不是「沒設」（http('') 會送去別的地方），一律當沒設。 */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

const RPC_URL = firstNonEmpty(process.env.RPC_URL, process.env.ANVIL_RPC_URL) ?? 'http://127.0.0.1:8545';

/** fork 的三個資產。第三個（NVDAB）是 v1 executor 換不動的那一個，也是這張工單的主角。 */
const WBNB: Address = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT: Address = '0x55d398326f99059fF775485246999027B3197955';
const NVDAB: Address = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';

/** 目標權重：總和必須剛好 10000，所以第一檔吃掉餘數。 */
const TARGET_BPS = [3334, 3333, 3333] as const;

const ASSETS: { symbol: string; address: Address }[] = [
  { symbol: 'WBNB', address: WBNB },
  { symbol: 'NVDAB', address: NVDAB },
  { symbol: 'USDT', address: USDT },
];

/** anvil #0：唯一的資金來源。那 9995 BNB 是 anvil 自己灌的，不是上游真錢。 */
const ANVIL0: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL0_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/** anvil #3：sudo owner（本工單給的固定測試向量）。 */
const SUDO_OWNER: Address = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const SUDO_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

/** NVDAB/USDT 的 PancakeV3 pool：兩邊都有存貨，用它當 USDT/NVDAB 的來源（不用上游真錢）。 */
const NVDAB_USDT_POOL: Address = '0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C';

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

const WBNB_ABI = [
  ...ERC20_ABI,
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'enrollments',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'strategyId', type: 'uint256' },
      { name: 'version', type: 'uint16' },
      { name: 'paused', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'version',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'versionNumber', type: 'uint16' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'assets', type: 'address[]' },
          { name: 'weightsBps', type: 'uint16[]' },
          { name: 'scheduleHash', type: 'bytes32' },
          { name: 'activeAt', type: 'uint64' },
        ],
      },
    ],
  },
] as const;

/** 只用到報價：`previewSwap` 的第二個回傳值就是折扣後地板。 */
const ORACLE_ABI = [
  {
    type: 'function',
    name: 'previewSwap',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'quoted', type: 'uint256' },
      { name: 'minimum', type: 'uint256' },
    ],
  },
] as const;

const EXECUTOR_ABI = [
  { type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

const log = (section: string, message: string): void => {
  console.log(`[${section}] ${message}`);
};

const json = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

/** 十進位字串 → 18 位最小單位。大數字一律 bigint，不經過 Number。 */
function toWei(raw: string, decimals = 18): bigint {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(raw.trim());
  if (match === null) throw new Error(`金額必須是正的小數（18 位以內），收到 "${raw}"`);
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(18, '0'));
}

function fmt(amount: bigint, decimals = 18): string {
  return formatUnits(amount, decimals);
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** 權威部署記錄；`executorMultiPool` 是這張工單要用的執行器。 */
type ForkDeployment = { registry: Address; executorMultiPool: Address; multiPoolOracle: Address };

function readDeployment(): ForkDeployment {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '../../cre8-contracts/deployments/fork.json');
  return JSON.parse(readFileSync(file, 'utf8')) as ForkDeployment;
}

/** 可覆寫的執行器：`--executor` → `EXECUTOR_ADDRESS` → fork.json 的 executorMultiPool。 */
function resolveExecutor(argv: readonly string[], deployment: ForkDeployment): Address {
  const raw = firstNonEmpty(arg(argv, 'executor'), process.env.EXECUTOR_ADDRESS, deployment.executorMultiPool);
  if (raw === undefined) throw new Error('找不到 AtpExecutor 地址');
  return raw.toLowerCase() as Address;
}

function resolveRegistry(argv: readonly string[], deployment: ForkDeployment): Address {
  const raw = firstNonEmpty(arg(argv, 'registry'), process.env.REGISTRY_ADDRESS, deployment.registry);
  if (raw === undefined) throw new Error('找不到 AtpRegistry 地址');
  return raw.toLowerCase() as Address;
}

type AccountRow = { portfolioId: number; account: Address; owner: Address; strategyId: number; version: number };

/** 從 DB 讀 portfolio 的 smart account（權威值，不用 initConfig 重算）。 */
async function loadAccount(portfolioId: number): Promise<AccountRow> {
  const row = (
    await query<{ id: string; strategy_id: string; version: number; address: string; owner: string }>(
      `select p.id, p.strategy_id, p.version, s.address, s.owner
         from portfolios p join smart_accounts s on s.portfolio_id = p.id
        where p.id = $1`,
      [portfolioId],
    )
  ).rows[0];
  if (row === undefined) throw new Error(`portfolio ${portfolioId} 或它的 smart_account 不存在`);
  return {
    portfolioId: Number(row.id),
    account: row.address.toLowerCase() as Address,
    owner: row.owner.toLowerCase() as Address,
    strategyId: Number(row.strategy_id),
    version: row.version,
  };
}

// ---------------------------------------------------------------------------
// 模式：create（步驟 1）
// ---------------------------------------------------------------------------

async function modeCreate(argv: readonly string[]): Promise<void> {
  const name = arg(argv, 'name') ?? `D-23 three-asset ${new Date().toISOString()}`;
  log('create', `provider（owner）= ${SUDO_OWNER}；資產 ${ASSETS.length} 個，權重 ${TARGET_BPS.join('/')} bps`);

  const strategy = await createStrategy(
    {
      name,
      description: 'D-23 收尾驗證：WBNB + NVDAB + USDT 的 3 資產指數，USDT 為 hub。',
      isPublic: true,
      swapFeeBps: 0,
    },
    SUDO_OWNER,
  );
  log('create', `DB strategies.id=${strategy.id} onchain_id=${String(strategy.onchainId)} provider=${strategy.provider}`);
  if (strategy.onchainId === null) {
    throw new Error('onchain_id 是 null：鏈上沒設定（RPC_URL / OPERATOR_PRIVATE_KEY / REGISTRY_ADDRESS），enroll 之後一定失敗');
  }

  const version = await publishVersion(
    strategy.id,
    {
      allocation: { assets: ASSETS.map((a, i) => ({ address: a.address, symbol: a.symbol, weightBps: TARGET_BPS[i]! })) },
      schedule: { kind: 'interval', intervalSeconds: 3600 },
      changeLog: 'v1: 3 資產（WBNB/NVDAB/USDT）等權，USDT hub',
      activeAt: new Date(),
    },
    SUDO_OWNER,
  );
  log('create', `DB strategy_versions: strategy_id=${version.strategyId} version=${version.version}`);

  console.log(json({ strategyId: strategy.id, onchainId: strategy.onchainId, version: version.version, name }));
}

// ---------------------------------------------------------------------------
// 模式：enroll（步驟 2）
// ---------------------------------------------------------------------------

async function modeEnroll(argv: readonly string[]): Promise<void> {
  const strategyId = Number(arg(argv, 'strategy'));
  if (!Number.isInteger(strategyId)) throw new Error('缺少 --strategy <DB strategies.id>');

  // 這裡就是 CallPolicy target 的來源：enrollPortfolio → requireSessionKeyConfig() → EXECUTOR_ADDRESS。
  const fromEnv = firstNonEmpty(process.env.EXECUTOR_ADDRESS);
  if (fromEnv === undefined) {
    throw new Error(
      'EXECUTOR_ADDRESS 沒設：enrollPortfolio 的 CallPolicy target 就是從這個 env 讀的（src/portfolios.ts:282），' +
        '沒設它 = initConfig 煮出來的權限指向別的地方或直接拋錯',
    );
  }
  log('enroll', `EXECUTOR_ADDRESS=${fromEnv}（CallPolicy 的 target 來源：src/config.ts:129 → portfolios.ts:282）`);

  const portfolio = await enrollPortfolio(strategyId, SUDO_OWNER);
  const account = portfolio.smartAccounts[0];
  if (account === undefined) throw new Error('enroll 回應沒有 smart account');
  log('enroll', `portfolio ${portfolio.id} strategy ${portfolio.strategyId} version ${portfolio.version}`);
  log('enroll', `smart account ${account.address} owner ${account.owner}`);

  console.log(json({ portfolioId: portfolio.id, strategyId: portfolio.strategyId, account: account.address }));
}

// ---------------------------------------------------------------------------
// 模式：fund（步驟 5）
// ---------------------------------------------------------------------------

type FundArgs = { bnb: bigint; wbnb: bigint; usdt: bigint; nvdab: bigint };

function parseFundArgs(argv: readonly string[]): FundArgs {
  return {
    bnb: toWei(arg(argv, 'bnb') ?? '0.05'),
    wbnb: toWei(arg(argv, 'wbnb') ?? '0'),
    usdt: toWei(arg(argv, 'usdt') ?? '0'),
    nvdab: toWei(arg(argv, 'nvdab') ?? '0'),
  };
}

/**
 * 從 pool 搬代幣：`anvil_impersonateAccount` + 補 gas + 由 pool 自己發 `transfer`。
 *
 * 為什麼不是 `anvil_setStorageAt`：改 storage slot 要猜 mapping 的位置，猜錯會靜默汙染 fork 狀態；
 * impersonate 走的是代幣自己的 `transfer`（真的扣 pool 的餘額、真的 emit Transfer），是代幣邏輯認可的路徑。
 */
async function transferFromPool(
  publicClient: PublicClient,
  walletForImpersonation: ReturnType<typeof createWalletClient>,
  token: Address,
  to: Address,
  amountWei: bigint,
): Promise<Hex> {
  await publicClient.request({
    method: 'anvil_impersonateAccount',
    params: [NVDAB_USDT_POOL],
  } as never);
  // pool 是合約，沒有 BNB 付 gas；給它一筆就好（送完不會再用）。
  await publicClient.request({
    method: 'anvil_setBalance',
    params: [NVDAB_USDT_POOL, '0x56BC75E2D63100000'], // 100 BNB
  } as never);

  const hash = await walletForImpersonation.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, amountWei],
    account: NVDAB_USDT_POOL,
    chain: bsc,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`pool → ${to} 的 transfer(${amountWei}) revert（tx ${hash}）`);
  return hash;
}

async function modeFund(argv: readonly string[]): Promise<void> {
  const portfolioId = Number(arg(argv, 'portfolio'));
  if (!Number.isInteger(portfolioId)) throw new Error('缺少 --portfolio <DB portfolios.id>');
  const amounts = parseFundArgs(argv);
  const { account } = await loadAccount(portfolioId);
  log('fund', `帳戶 ${account}`);
  log('fund', `目標入金 BNB ${fmt(amounts.bnb)} / WBNB ${fmt(amounts.wbnb)} / USDT ${fmt(amounts.usdt)} / NVDAB ${fmt(amounts.nvdab)}`);

  const before = await readBalances(publicClient(), account);
  printBalances('入金前', before);

  const anvil0 = createWalletClient({ account: privateKeyToAccount(ANVIL0_KEY), chain: bsc, transport: http(RPC_URL) });
  const poolWallet = createWalletClient({ transport: http(RPC_URL) });
  const sent: Record<string, string> = {};

  // ---- BNB（UserOp 的 gas 預付由 sender 出，所以帳戶自己要有 BNB）--------------------------------
  if (amounts.bnb > 0n) {
    sent.bnb = await anvil0.sendTransaction({ to: account, value: amounts.bnb, chain: bsc });
    await publicClient().waitForTransactionReceipt({ hash: sent.bnb as Hex });
    log('fund', `BNB ${fmt(amounts.bnb)}：tx ${sent.bnb}`);
  }

  // ---- WBNB：anvil#0 用 deposit() 把 BNB 換成 WBNB 再轉（不碰上游資金）---------------------------
  if (amounts.wbnb > 0n) {
    const deposit = await anvil0.writeContract({ address: WBNB, abi: WBNB_ABI, functionName: 'deposit', args: [], value: amounts.wbnb, chain: bsc });
    await publicClient().waitForTransactionReceipt({ hash: deposit });
    log('fund', `WBNB.deposit(${fmt(amounts.wbnb)})：tx ${deposit}`);
    sent.wbnb = await anvil0.writeContract({
      address: WBNB,
      abi: WBNB_ABI,
      functionName: 'transfer',
      args: [account, amounts.wbnb],
      chain: bsc,
    });
    await publicClient().waitForTransactionReceipt({ hash: sent.wbnb as Hex });
    log('fund', `WBNB.transfer(帳戶, ${fmt(amounts.wbnb)})：tx ${sent.wbnb}`);
  }

  // ---- USDT / NVDAB：pool impersonate ------------------------------------------------------------
  if (amounts.usdt > 0n) {
    sent.usdt = await transferFromPool(publicClient(), poolWallet, USDT, account, amounts.usdt);
    log('fund', `USDT.transfer(帳戶, ${fmt(amounts.usdt)}) by pool：tx ${sent.usdt}`);
  }
  if (amounts.nvdab > 0n) {
    sent.nvdab = await transferFromPool(publicClient(), poolWallet, NVDAB, account, amounts.nvdab);
    log('fund', `NVDAB.transfer(帳戶, ${fmt(amounts.nvdab)}) by pool：tx ${sent.nvdab}`);
  }

  const after = await readBalances(publicClient(), account);
  printBalances('入金後', after);
  for (const asset of ASSETS) {
    const key = asset.symbol.toLowerCase() as 'wbnb' | 'usdt' | 'nvdab';
    const delta = after[key] - before[key];
    if (delta !== amounts[key]) throw new Error(`${asset.symbol} 只增加 ${delta}，預期 ${amounts[key]}`);
  }
  console.log(json({ account, sent, before, after }));
}

// ---------------------------------------------------------------------------
// 讀數
// ---------------------------------------------------------------------------

type Balances = { wbnb: bigint; usdt: bigint; nvdab: bigint; bnb: bigint };

function publicClient(): PublicClient {
  return createPublicClient({ chain: bsc, transport: http(RPC_URL) }) as PublicClient;
}

async function readBalances(client: PublicClient, account: Address): Promise<Balances> {
  const [wbnb, usdt, nvdab, bnb] = await Promise.all([
    client.readContract({ address: WBNB, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: USDT, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: NVDAB, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    client.getBalance({ address: account }),
  ]);
  return { wbnb, usdt, nvdab, bnb };
}

function printBalances(label: string, b: Balances): void {
  log(
    'bal',
    `${label} WBNB ${fmt(b.wbnb)} | USDT ${fmt(b.usdt)} | NVDAB ${fmt(b.nvdab)} | BNB(gas) ${fmt(b.bnb)}`,
  );
}

// ---------------------------------------------------------------------------
// 模式：state（唯讀對帳：步驟 1-4 的證據）
// ---------------------------------------------------------------------------

async function modeState(argv: readonly string[]): Promise<void> {
  const deployment = readDeployment();
  const executor = resolveExecutor(argv, deployment);
  const registry = resolveRegistry(argv, deployment);
  const portfolioId = Number(arg(argv, 'portfolio'));
  if (!Number.isInteger(portfolioId)) throw new Error('缺少 --portfolio <DB portfolios.id>');
  const client = publicClient();
  const row = await loadAccount(portfolioId);

  // ---- DB ---------------------------------------------------------------------------------------
  const strategyRow = (
    await query<{ id: string; onchain_id: string | null; provider: string; name: string }>(
      'select id, onchain_id, provider, name from strategies where id = $1',
      [row.strategyId],
    )
  ).rows[0];
  const versionRows = (
    await query<{ version: number; allocation: unknown; schedule: unknown }>(
      'select version, allocation, schedule from strategy_versions where strategy_id = $1 order by version',
      [row.strategyId],
    )
  ).rows;
  log('db', `strategies.id=${strategyRow?.id} onchain_id=${String(strategyRow?.onchain_id)} provider=${strategyRow?.provider}`);
  for (const v of versionRows) {
    log('db', `strategy_versions v${v.version} allocation=${JSON.stringify(v.allocation)} schedule=${JSON.stringify(v.schedule)}`);
  }
  log('db', `portfolios.id=${row.portfolioId} strategy_id=${row.strategyId} version=${row.version} → account ${row.account}`);

  // ---- 鏈上帳戶有 code ---------------------------------------------------------------------------
  const code = await client.getCode({ address: row.account });
  log('chain', `getCode(${row.account}) = ${code === undefined || code === '0x' ? '0x（沒有 code！）' : `${code.length} hex chars`}`);
  if (code === undefined || code === '0x') throw new Error(`${row.account} 沒有 code：帳戶沒部署`);

  // ---- 鏈上 enrollment 與 version（權威）----------------------------------------------------------
  const onchainId = strategyRow?.onchain_id === null || strategyRow?.onchain_id === undefined ? null : BigInt(strategyRow.onchain_id);
  const enrollment = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'enrollments',
    args: [row.account],
  });
  log(
    'chain',
    `registry.enrollments(${row.account}) = strategyId ${enrollment[0]} version ${enrollment[1]} paused ${enrollment[2]}`,
  );
  if (onchainId !== null && enrollment[0] !== onchainId) {
    throw new Error(`enrollments.strategyId ${enrollment[0]} != DB onchain_id ${onchainId}`);
  }
  if (enrollment[1] === 0) throw new Error('enrollment.version 是 0：0 會被 version(id,0) 解析成 active version，拒絕猜');

  const version = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'version',
    args: [enrollment[0], enrollment[1]],
  });
  log('chain', `registry.version(${enrollment[0]}, ${enrollment[1]}).assets = [${version.assets.join(', ')}]`);
  log('chain', `registry.version(...).weightsBps = [${version.weightsBps.join(', ')}]（總和 ${version.weightsBps.reduce((a, b) => a + Number(b), 0)}）`);
  log('chain', `registry.version(...).activeAt = ${version.activeAt}`);
  if (version.assets.length !== 3) throw new Error(`version.assets 有 ${version.assets.length} 個，預期 3`);
  const expected = new Map(ASSETS.map((a, i) => [a.address.toLowerCase(), TARGET_BPS[i]!]));
  for (const asset of version.assets) {
    const want = expected.get(asset.toLowerCase());
    if (want === undefined) throw new Error(`version.assets 出現不在分配裡的 ${asset}`);
    const got = version.weightsBps[version.assets.indexOf(asset)];
    if (Number(got) !== want) throw new Error(`${asset} 的權重 ${String(got)} != ${want}`);
  }

  // ---- 三個 allowance（對新 executor）-----------------------------------------------------------
  const allowances: { asset: Address; allowance: bigint }[] = [];
  for (const asset of version.assets) {
    allowances.push({
      asset,
      allowance: await client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'allowance', args: [row.account, executor] }),
    });
  }
  for (const a of allowances) log('allow', `allowance(${row.account}, ${executor}) @ ${a.asset} = ${a.allowance}`);
  const zero = allowances.filter((a) => a.allowance === 0n);
  if (zero.length > 0) log('allow', `⚠ ${zero.length} 個 allowance 是 0：${zero.map((z) => z.asset).join(', ')}`);

  // ---- permissionConfig：這組 policy 有沒有裝在帳戶上 --------------------------------------------
  // 用 DB 的 session key 快照重建 initConfig 的部分欄位（permissionId）需要 validUntil，所以直接讀 DB。
  const key = (
    await query<{ key_ref: string; permissions: { permissionId: Hex; sessionKeyAddress: string; timestamp: { validUntil: number } } }>(
      `select key_ref, permissions from session_keys where portfolio_id = $1 and status = 'active'
        order by (split_part(key_ref, '/', 6))::bigint desc limit 1`,
      [portfolioId],
    )
  ).rows[0];
  if (key === undefined) throw new Error(`portfolio ${portfolioId} 沒有 active 的 session key`);

  const derived = deriveSessionKeyFor(row.owner, BigInt(row.strategyId), {
    masterSeed: (process.env.SESSION_KEY_MASTER_SEED ?? '') as Hex,
  });
  log('sk', `DB key_ref ${key.key_ref}；deriveSessionKeyFor(owner, ${row.strategyId}) → ${derived.address}`);
  if (!isAddressEqual(derived.address, key.permissions.sessionKeyAddress as Address)) {
    throw new Error(`派生 ${derived.address} != DB 記的 session key ${key.permissions.sessionKeyAddress}`);
  }

  const perms = await buildSessionPermissions({
    publicClient: client,
    sessionKeyAddress: derived.address,
    executorAddress: executor,
    validUntil: Number(key.permissions.timestamp.validUntil),
  });
  log('sk', `permissionId ${perms.permissionId}（DB ${key.permissions.permissionId}）`);
  if (perms.permissionId.toLowerCase() !== key.permissions.permissionId.toLowerCase()) {
    throw new Error(
      `permissionId 不符：用 executor=${executor} 重建得到 ${perms.permissionId}，DB 記的是 ${key.permissions.permissionId} —— ` +
        'enroll 當時的 CallPolicy target 不是這個 executor',
    );
  }
  // CallPolicy 的 target 從 DB 快照印出來：這就是「target 是新 executor」的直接證據（行為面由真的送一筆證明）。
  const snapshotCall = perms.policySnapshot.call as { permissions: { target: string; selector: string }[] };
  for (const permission of snapshotCall.permissions) {
    log('sk', `CallPolicy target ${permission.target} selector ${permission.selector}`);
    if (permission.target.toLowerCase() !== executor) {
      throw new Error(`CallPolicy target ${permission.target} != executor ${executor}`);
    }
  }

  const installed = await client.readContract({
    address: row.account,
    abi: KernelV3_3AccountAbi,
    functionName: 'permissionConfig',
    args: [perms.permissionId],
  });
  log('sk', `鏈上 permissionConfig(${perms.permissionId}) signer=${installed.signer} policies=${installed.policyData.length} flag=${installed.permissionFlag}`);
  if (installed.policyData.length !== 3) throw new Error(`permissionConfig 只有 ${installed.policyData.length} 個 policy，預期 3`);

  // ---- 餘額 / 報價 / 漂移 ------------------------------------------------------------------------
  const balances = await readBalances(client, row.account);
  printBalances('目前餘額', balances);

  const oracle = await client.readContract({ address: executor, abi: EXECUTOR_ABI, functionName: 'oracle' });
  const priceOne = async (token: Address): Promise<bigint> => {
    const [quoted] = await client.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: 'previewSwap',
      args: [token, USDT, 10n ** 18n],
    });
    return quoted;
  };
  const wbnbPrice = await priceOne(WBNB);
  const nvdabPrice = await priceOne(NVDAB);
  log('price', `oracle ${oracle}：1 WBNB = ${fmt(wbnbPrice)} USDT；1 NVDAB = ${fmt(nvdabPrice)} USDT`);

  const plan = await planPortfolio(portfolioId, {
    publicClient: client,
    registryAddress: registry,
    thresholdBps: Number(arg(argv, 'threshold-bps') ?? DEFAULT_THRESHOLD_BPS),
  });
  log('drift', `block ${plan.snapshot.block}`);
  if (plan.report === null) {
    for (const blocked of plan.blocked) log('drift', `✗ [${blocked.code}] ${blocked.detail}`);
  } else {
    log('drift', `grossDriftBps ${plan.report.grossDriftBps}、maxAbsDeltaBps ${plan.report.maxAbsDeltaBps}、門檻 ${plan.report.thresholdBps} → ${plan.report.needsRebalance ? '需要再平衡' : '不需要'}`);
    for (const r of plan.report.assets) log('drift', `  ${r.asset} target ${r.targetBps} / current ${r.currentBps} / delta ${r.deltaBps}`);
  }

  console.log(
    json({
      portfolioId,
      strategyIdDb: row.strategyId,
      onchainId: onchainId === null ? null : onchainId.toString(),
      account: row.account,
      enrollment: { strategyId: enrollment[0].toString(), version: enrollment[1], paused: enrollment[2] },
      onchainVersion: {
        assets: version.assets,
        weightsBps: version.weightsBps.map((w) => Number(w)),
        sum: version.weightsBps.reduce((a, b) => a + Number(b), 0),
      },
      executor,
      allowances: allowances.map((a) => ({ asset: a.asset, allowance: a.allowance.toString() })),
      sessionKey: { address: derived.address, keyRef: key.key_ref, permissionId: perms.permissionId, policies: installed.policyData.length },
      callPolicy: snapshotCall.permissions,
      balances,
      prices: { wbnbUsdt: wbnbPrice.toString(), nvdabUsdt: nvdabPrice.toString() },
      drift: plan.report === null ? null : {
        grossDriftBps: plan.report.grossDriftBps,
        maxAbsDeltaBps: plan.report.maxAbsDeltaBps,
        assets: plan.report.assets.map((r) => ({ asset: r.asset, targetBps: r.targetBps, currentBps: r.currentBps, deltaBps: r.deltaBps })),
      },
    }),
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const mode = arg(argv, 'mode') ?? 'state';
  if (!['create', 'enroll', 'fund', 'state'].includes(mode)) {
    throw new Error(`--mode 只接受 create|enroll|fund|state，收到 "${mode}"`);
  }
  log('env', `RPC ${RPC_URL}｜mode ${mode}`);

  switch (mode) {
    case 'create':
      await modeCreate(argv);
      break;
    case 'enroll':
      await modeEnroll(argv);
      break;
    case 'fund':
      await modeFund(argv);
      break;
    case 'state':
      await modeState(argv);
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
