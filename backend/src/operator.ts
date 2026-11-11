/**
 * 操作員的兩支端點實作：`GET /portfolios/:id/status` 與 `POST /portfolios/:id/rebalance`。
 *
 * 兩件事放同一個檔案，因為它們是同一段流程的兩半（先看見狀態 → 再決定要不要動錢），而且都只服務
 * 操作員：一支**很貴**（`planPortfolio` 會掃日誌、讀多個池、定價），一支**會動鏈上的錢**。
 * `server.ts` 只負責路由、認證與 HTTP 形狀。
 */

import { createPublicClient, http } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { activeChain } from './chain-object.js';

import { getConfig, getSessionKeyConfig } from './config.js';
import { query as dbQuery, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { requireOwnedPortfolio } from './portfolios.js';
import { describeGasStatus } from './funding.js';
import { listOpenAlerts } from './alerts.js';
import { readSchedulerStatus } from './scheduler-status.js';
import type { SchedulerStatus } from './scheduler-status.js';
import type { GasStatus } from './funding.js';
import { getAccountGasBalance, getGasPriceWei } from './chain.js';
import { getGasConfig } from './config.js';
import { countSwapExecuted, runSchedulerOnce } from './scheduler.js';
import type { ExecutionOutcome, PortfolioRunResult, WithTransactionFn } from './scheduler.js';
import { planPortfolio } from './snapshot.js';
import { buildStep, minGrossFor } from './rebalance-plan.js';
import type { PlannedStep, RebalancePlan } from './rebalance-plan.js';
import type { RebalancePlanningInput } from './scheduler.js';
import type { PortfolioPlan, QueryFn } from './snapshot.js';

// ---------------------------------------------------------------------------
// GET /portfolios/:id/status
// ---------------------------------------------------------------------------

/**
 * 狀態快取的有效期（毫秒）。
 *
 * 為什麼需要它：`planPortfolio` 是這支 API 最貴的一條路徑（掃 `Transfer` 日誌 + 每個資產讀池子的
 * `slot0`/`observe` + 對金額做 `balanceOf`），實測要幾秒。使用者連點兩下「看狀態」就是兩份完整讀鏈，
 * 而且**第二個請求一定在第一位還沒算完時進來**——所以快取連「算到一半的 promise」都留著，
 * 兩個請求共用同一次讀鏈，而不是各自讀一遍。
 */
export const STATUS_CACHE_TTL_MS = 10_000;

/**
 * 快取最多留幾個 portfolio 的狀態。
 *
 * 沒有上限的 in-memory Map 在長時間跑的服務裡就是一條洩漏：這裡只需要「同一個使用者連點」的保護，
 * 不需要記住整個 fleet。滿了就丟最舊的一筆（Map 的插入順序即 LRU 的近似）。
 */
export const STATUS_CACHE_MAX_ENTRIES = 100;

/** 一個有價持倉。`usdValueE8` 與漂移報告裡的同一個資產**逐位相同**（見 `statusOf`）。 */
export type StatusHolding = {
  asset: string;
  symbol: string;
  amountWei: string;
  decimals: number;
  usdValueE8: string;
  priceSource: string;
};

/** 沒有可用價格的資產：它會讓漂移拒算（`blocked`），所以必須看得到。 */
export type StatusUnpriced = {
  asset: string;
  symbol: string;
  amountWei: string;
  decimals: number;
  reason: string;
};

export type StatusTarget = { asset: string; symbol: string; weightBps: number };

export type StatusDriftAsset = {
  asset: string;
  symbol: string;
  targetBps: number;
  currentBps: number;
  deltaBps: number;
  usdValueE8: string;
};

export type StatusDrift = {
  grossDriftBps: number;
  maxAbsDeltaBps: number;
  needsRebalance: boolean;
  thresholdBps: number;
  assets: StatusDriftAsset[];
};

export type PortfolioStatus = {
  portfolioId: number;
  /**
   * executor 位址 —— app 要靠它組 `approve(spender = executor)`。
   *
   * 為什麼放在 status 而不是另一個端點：approve 是「這個投組能不能動」的一部分，
   * 而 app 已經在讀 status 了；多一支端點只是多一次 round-trip 與一個要同步的欄位。
   *
   * `null` = 這個部署沒有設 `EXECUTOR_ADDRESS`（那就連 session key 都裝不起來）—— app 要顯示
   * 「不知道 spender」而不是自己猜一個位址去 approve。
   */
  executorAddress: string | null;
  /** 這次觀測釘住的塊高（十進位字串：`bigint` 不進 JSON 數字）。 */
  block: string;
  account: string;
  holdings: StatusHolding[];
  unpriced: StatusUnpriced[];
  /** 投組總值（USD，1e8 定點）。沒有漂移報告時為 null（blocked 的那幾種）。 */
  totalUsdE8: string | null;
  targets: StatusTarget[];
  drift: StatusDrift | null;
  blocked: { code: string; detail: string }[];
  /**
   * 這份狀態是否**完整**：有漂移報告且 `blocked` 為空。
   *
   * false 不代表請求失敗（請求本身成功了，只是被觀測的投組現在算不出完整狀態）——真正的失敗
   * （RPC 掛、fork 過期、DB 掛）走 503，不會用一個看起來正常的空狀態冒充。
   */
  complete: boolean;
  /**
   * DB 記的 session key 與**實際會用**的那一把（唯讀顯示用）。
   *
   * 只顯示 DB 那一把會騙人：實測 portfolio 5 的 DB key 在鏈上沒安裝，排程器會退回舊的那把。
   */
  sessionKey: StatusSessionKey;
  /**
   * 這個帳戶的 gas 狀態（原生 BNB）。
   *
   * 為什麼放在 status：**gas 是每個帳戶自己付的**（ERC-4337 的 sender 模型），而一個帳戶 = 一個
   * 「owner + 策略」組合。所以「這檔基金還能不能動」= 「它自己還有沒有 BNB」，跟別的投組無關。
   * `null` = 查不到（RPC 掛），不是「餘額 0」—— 使用者要能分辨這兩件事。
   */
  gas: GasStatus | null;
};

export type StatusDeps = {
  planPortfolio?: (portfolioId: number) => Promise<PortfolioPlan>;
  requireOwnedPortfolio?: typeof requireOwnedPortfolio;
  query?: QueryFn;
  /** 讀 `permissionConfig` 用；省略 = 由 `RPC_URL` 自己建一個。 */
  publicClient?: PublicClient;
  /** 毫秒時鐘；測試注入假時鐘就能驗 TTL。 */
  now?: () => number;
  /** executor 位址（app 組 approve 用）；省略 = `EXECUTOR_ADDRESS`。 */
  executor?: Address;
  /** 讀帳戶的原生幣餘額；省略 = `getAccountGasBalance`。 */
  accountGasBalance?: (address: Address) => Promise<bigint>;
  /** 讀 gas price；省略 = `getGasPriceWei`。 */
  gasPrice?: () => Promise<bigint>;
  /** `gas.ready` 的門檻；省略 = `MIN_SESSION_GAS_WEI`。 */
  minGasWei?: bigint;
  log?: (line: string) => void;
};

export type PortfolioStatusReader = (portfolioId: number, wallet: string) => Promise<PortfolioStatus>;

const SQL_SYMBOLS = 'select address, symbol from priceable_assets where enabled';

/** `0xAbC…` → `0xabc…`：DB 與鏈上的地址大小寫不一致，比對一律用小寫。 */
function assetKey(asset: string): string {
  return asset.toLowerCase();
}

/** 一行、有限長度、保留原文的錯誤訊息（多行 stack 進 JSON body 沒有幫助，反而蓋掉真正的原因）。 */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!.slice(0, 500);
}

/**
 * `priceable_assets` 的地址 → ticker。
 *
 * 這是狀態回應裡唯一的「顯示用」資料，但仍然從 DB 讀而不是從 `planPortfolio` 的內部：`planPortfolio`
 * 不吐 ticker，而猜（截斷地址）在有多個相似資產時會讓人看錯。查詢失敗就讓它變成 503——
 * 一份沒有 ticker 的狀態表比沒有狀態更難讀。
 */
async function loadSymbols(deps: StatusDeps): Promise<Map<string, string>> {
  const query = deps.query ?? dbQuery;
  const result = await query(SQL_SYMBOLS);
  const symbols = new Map<string, string>();
  for (const row of result.rows) {
    const typed = row as { address?: unknown; symbol?: unknown };
    if (typeof typed.address !== 'string' || typeof typed.symbol !== 'string') continue;
    symbols.set(assetKey(typed.address), typed.symbol);
  }
  return symbols;
}

/** `planPortfolio` 的持倉 → `usdValueE8`。與 `drift.ts` 的公式逐位相同（乘法後截斷，不是四捨五入）。 */
function usdValueE8Of(holding: { amountWei: bigint; usdPriceE8: bigint; decimals: number }): bigint {
  return (holding.amountWei * holding.usdPriceE8) / 10n ** BigInt(holding.decimals);
}

// ---------------------------------------------------------------------------
// session key：DB 記的那把 vs 鏈上真的會用的那把
// ---------------------------------------------------------------------------

/**
 * `permissionConfig(bytes4)` 的回傳（Kernel v3.3 `ValidationManager.PermissionConfig`）。
 *
 * ⚠ 這是 `scheduler.ts` 私有 `KERNEL_PERMISSION_ABI` 的**第二份**：那個常數沒有 export，而
 * `scheduler.ts` 不在這次改動範圍內（見 boundary），所以只能照抄。形狀（單一 tuple 輸出、
 * `policyData` 是 packed 的 `bytes22[]`）與上游逐字相同 —— 改一邊就要改另一邊。
 */
const PERMISSION_CONFIG_ABI = [
  {
    type: 'function',
    name: 'permissionConfig',
    stateMutability: 'view',
    inputs: [{ name: 'pId', type: 'bytes4' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'permissionFlag', type: 'bytes2' },
          { name: 'signer', type: 'address' },
          { name: 'policyData', type: 'bytes22[]' },
        ],
      },
    ],
  },
] as const;

/** 一組「裝好了」的 permission 有三層 policy（與 `scheduler.ts` 的 `EXPECTED_POLICY_COUNT` 相同）。 */
const EXPECTED_STATUS_POLICY_COUNT = 3;

/** 鏈上「沒安裝」＝ `signer` 是零地址。 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * 這個 portfolio 的 session key，**由新到舊**（`key_ref` 最後一段 index 遞減）。
 *
 * 排序與 `scheduler.ts` 的 `SQL_ACTIVE_SESSION_KEYS` 一致：`usable` 必須等於排程器真的會挑的那一把，
 * 否則這個欄位只是另一種騙人的顯示。這裡不 join `smart_accounts`：`session_keys` 沒有 chain_id，
 * 排程器那個 join 只是為了拿 `owner` 做派生比對，顯示用不到。
 */
const SQL_SESSION_KEYS_NEWEST_FIRST = `
  select k.key_ref, k.permissions, k.status, k.expires_at
    from session_keys k
   where k.portfolio_id = $1
   order by (split_part(k.key_ref, '/', 6))::bigint desc
`;

/**
 * 一支 session key 在 DB 裡記的樣子（不含「鏈上裝了沒」）。
 *
 * `expiresAt` 是**唯一有時效性、使用者能行動的資訊**：key 一過期，這個投組每一輪都會 blocked
 * 而且不會自己好（要靠 owner 簽一筆續期）。原本這份型別只有 permissionId 與 keyRef ——
 * 也就是「使用者看不懂的內部 id」有，而「他該注意的到期日」沒有。
 */
export type StatusSessionKeyRef = {
  permissionId: string;
  keyRef: string;
  /** ISO 時間。`null` = DB 那一列沒有可解析的到期日。 */
  expiresAt: string | null;
  /** DB 的 status（`active` / 其他）。 */
  status: string | null;
};

/**
 * 「DB 記的 key」與「實際會用的 key」，加上 configured 那把的鏈上安裝狀態。
 *
 * 為什麼要兩個欄位：實測 portfolio 5 的 `sessionKey.permissionId = 0x7db20115`，而鏈上
 * `permissionConfig(0x7db20115).signer = 0x000…000`（沒有安裝），排程器會自動退回舊的
 * `0xf67556bf`。只顯示 DB 那一把，等於**顯示一把不會被使用的 key**。
 *
 * `error` 非 null 代表這次**讀不到**（DB 或鏈）：那時 `usable: null` 不可以被讀成
 * 「沒有任何可用的 key」，所以它一定要跟著 `error` 一起判讀。
 */
export type StatusSessionKey = {
  configured: (StatusSessionKeyRef & { installed: boolean }) | null;
  usable: StatusSessionKeyRef | null;
  error: string | null;
};

type SessionKeyRow = {
  key_ref?: unknown;
  permissions?: unknown;
  status?: unknown;
  expires_at?: unknown;
};

export type SessionKeyStatusDeps = {
  query?: QueryFn;
  publicClient?: PublicClient;
};

/** DB 一列 → `{permissionId, keyRef}`；形狀不對回 null（缺欄位不編一個看起來合理的值）。 */
function toStatusKeyRef(row: SessionKeyRow): StatusSessionKeyRef | null {
  const permissions = row.permissions as { permissionId?: unknown } | null | undefined;
  const permissionId = permissions?.permissionId;
  if (typeof permissionId !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(permissionId)) return null;
  if (typeof row.key_ref !== 'string' || row.key_ref === '') return null;
  const ms = expiryMs(row);
  return {
    permissionId,
    keyRef: row.key_ref,
    expiresAt: ms === 0 ? null : new Date(ms).toISOString(),
    status: typeof row.status === 'string' ? row.status : null,
  };
}

function expiryMs(row: SessionKeyRow): number {
  const raw = row.expires_at;
  const time = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(time) ? time : 0;
}

/** 這把 key 在鏈上裝好了沒（`signer != 0` 且 policy 層數對）。讀不到就拋，由呼叫端記成 `error`。 */
async function readSessionKeyInstalled(
  client: PublicClient,
  account: Address,
  permissionId: Hex,
): Promise<boolean> {
  const config = await client.readContract({
    address: account,
    abi: PERMISSION_CONFIG_ABI,
    functionName: 'permissionConfig',
    args: [permissionId],
  });
  if (config.signer === ZERO_ADDRESS) return false;
  return config.policyData.length === EXPECTED_STATUS_POLICY_COUNT;
}

/**
 * 「DB 記的 key（configured）＋實際會用的 key（usable）＋安裝狀態」。
 *
 * `configured` 取自與 `GET /portfolios` 相同的那一列（`portfolios.ts` 的
 * `order by (status = 'active') desc, expires_at desc`）：兩邊不一致的話，列表和狀態面板會各說各話。
 * `usable` 走與排程器相同的「由新到舊逐把問鏈上，第一把裝好的才用」。
 *
 * ⚠ 這整段是**唯讀的顯示資訊，不參與任何放行判斷**：真正決定會不會動錢的是排程器自己的前置檢查。
 * 內部的 `resolveSessionKey` 沒有 export、而 `scheduler.ts` 不在這次改動範圍內，所以在這裡只為了
 * 「顯示」重做一次同樣的挑選。它永遠不拋：讀不到就回 `error`，讓面板能講「讀不到」而不是「沒有」。
 */
export async function resolveStatusSessionKey(
  portfolioId: number,
  account: string | null,
  deps: SessionKeyStatusDeps = {},
): Promise<StatusSessionKey> {
  const query = deps.query ?? dbQuery;

  let rows: SessionKeyRow[];
  try {
    rows = (await query(SQL_SESSION_KEYS_NEWEST_FIRST, [portfolioId])).rows as SessionKeyRow[];
  } catch (error) {
    return { configured: null, usable: null, error: `讀不到 session_keys：${oneLine(error)}` };
  }
  if (rows.length === 0) {
    // 一列都沒有 ＝ DB 從來沒記過（不是「記了但沒安裝」）。
    return { configured: null, usable: null, error: null };
  }

  let client: PublicClient | null = deps.publicClient ?? null;
  const clientFor = (): PublicClient => {
    if (client === null) client = defaultPublicClient();
    return client;
  };

  // configured：active 優先、再比到期日新到舊。`rows` 已按 index 遞減，穩定排序保留它當同分次序。
  const configuredRow = rows
    .slice()
    .sort((a, b) => {
      const activeA = a.status === 'active' ? 1 : 0;
      const activeB = b.status === 'active' ? 1 : 0;
      if (activeA !== activeB) return activeB - activeA;
      return expiryMs(b) - expiryMs(a);
    })[0];

  let error: string | null = null;
  let configured: (StatusSessionKeyRef & { installed: boolean }) | null = null;

  const configuredRef = configuredRow === undefined ? null : toStatusKeyRef(configuredRow);
  if (configuredRef !== null && account === null) {
    // 沒有 smart account 就無從問鏈上：安裝狀態未知，明講而不是給一個 false。
    configured = { ...configuredRef, installed: false };
    error = '這個 portfolio 沒有 smart account，無法確認 session key 在鏈上的安裝狀態';
  } else if (configuredRef !== null) {
    try {
      configured = {
        ...configuredRef,
        installed: await readSessionKeyInstalled(clientFor(), account as Address, configuredRef.permissionId as Hex),
      };
    } catch (err) {
      configured = { ...configuredRef, installed: false };
      error = `讀不到 configured key(${configuredRef.permissionId}) 的鏈上安裝狀態：${oneLine(err)}`;
    }
  }

  let usable: StatusSessionKeyRef | null = null;
  const nowMs = Date.now();
  for (const row of rows) {
    if (row.status !== 'active') continue;
    if (expiryMs(row) <= nowMs) continue;
    const ref = toStatusKeyRef(row);
    if (ref === null) continue;
    if (account === null) break;
    try {
      if (await readSessionKeyInstalled(clientFor(), account as Address, ref.permissionId as Hex)) {
        usable = ref;
        break;
      }
    } catch (err) {
      // 讀不到就停：繼續往下猜會讓 `usable` 變成一個沒有依據的答案。
      error ??= `讀不到 ${ref.keyRef}(${ref.permissionId}) 的鏈上安裝狀態：${oneLine(err)}`;
      break;
    }
  }

  return { configured, usable, error };
}

/**
 * 算一份完整狀態（**沒有**快取；快取在 `createPortfolioStatusReader`）。
 *
 * 讀鏈/讀 DB 失敗一律變成 503 並帶上原因。這裡刻意不 catch 之後回一個 `holdings: []` 的空狀態：
 * 使用者會把「讀不到」讀成「這個投組是空的」，然後看著一個空的投組按下再平衡。
 */
async function statusOf(portfolioId: number, deps: StatusDeps): Promise<PortfolioStatus> {
  const planFn = deps.planPortfolio ?? ((id: number) => planPortfolio(id));

  let plan: PortfolioPlan;
  try {
    plan = await planFn(portfolioId);
  } catch (error) {
    throw new AppError(
      503,
      'STATUS_UNAVAILABLE',
      `Cannot compute the status of portfolio ${portfolioId}: the planner failed (usually the RPC is down, the ` +
        `anvil fork has expired, or the database is inconsistent). Underlying error: ${oneLine(error)}`,
      { cause: error },
    );
  }

  let symbols: Map<string, string>;
  try {
    symbols = await loadSymbols(deps);
  } catch (error) {
    throw new AppError(
      503,
      'STATUS_UNAVAILABLE',
      `算得出持倉，但讀不到代幣 ticker（priceable_assets 查詢失敗）：${oneLine(error)}`,
      { cause: error },
    );
  }

  const targetSymbols = new Map(plan.targets.map((target) => [assetKey(target.asset), target.symbol]));
  const symbolFor = (asset: string): string =>
    targetSymbols.get(assetKey(asset)) ?? symbols.get(assetKey(asset)) ?? `${asset.slice(0, 6)}…${asset.slice(-4)}`;

  // 漂移報告的 usdValueE8 是**同一份觀測**算出來的；有報告時直接沿用它，讓「持倉表」與「漂移表」
  // 對同一個資產永遠是同一個數字（兩邊各算一次總有一天會分岔）。
  const byAsset = new Map((plan.report?.assets ?? []).map((row) => [assetKey(row.asset), row]));

  const holdings: StatusHolding[] = plan.snapshot.holdings.map((holding) => ({
    asset: holding.asset,
    symbol: symbolFor(holding.asset),
    amountWei: holding.amountWei.toString(),
    decimals: holding.decimals,
    usdValueE8: (byAsset.get(assetKey(holding.asset))?.usdValueE8 ?? usdValueE8Of(holding)).toString(),
    priceSource: holding.priceSource,
  }));

  const unpriced: StatusUnpriced[] = plan.snapshot.unpriced.map((asset) => ({
    asset: asset.asset,
    symbol: symbolFor(asset.asset),
    amountWei: asset.amountWei.toString(),
    decimals: asset.decimals,
    reason: asset.reason,
  }));

  const targets: StatusTarget[] = plan.targets.map((target) => ({
    asset: target.asset,
    symbol: target.symbol,
    weightBps: target.weightBps,
  }));

  const report = plan.report;
  const drift: StatusDrift | null =
    report === null
      ? null
      : {
          grossDriftBps: report.grossDriftBps,
          maxAbsDeltaBps: report.maxAbsDeltaBps,
          needsRebalance: report.needsRebalance,
          thresholdBps: report.thresholdBps,
          assets: report.assets.map((row) => ({
            asset: row.asset,
            symbol: symbolFor(row.asset),
            targetBps: row.targetBps,
            currentBps: row.currentBps,
            deltaBps: row.deltaBps,
            usdValueE8: row.usdValueE8.toString(),
          })),
        };

  // 唯讀的附加資訊：讀不到也只記進 `sessionKey.error`，不讓一份算得出來的狀態變成 503。
  const sessionKey = await resolveStatusSessionKey(plan.portfolioId, plan.account, deps);
  const executor = deps.executor ?? getSessionKeyConfig().executorAddress ?? null;
  // gas 讀不到（RPC 掛）不該讓整份狀態變 503：留 null，前端顯示「未知」。
  const gas = await (async () => {
    try {
      const readBalance = deps.accountGasBalance ?? getAccountGasBalance;
      const readPrice = deps.gasPrice ?? getGasPriceWei;
      const minimumWei = deps.minGasWei ?? getGasConfig().minSessionGasWei;
      const [balanceWei, gasPriceWei] = await Promise.all([readBalance(plan.account), readPrice()]);
      return describeGasStatus({ address: plan.account, balanceWei, minimumWei, gasPriceWei });
    } catch {
      return null;
    }
  })();

  return {
    portfolioId: plan.portfolioId,
    executorAddress: executor,
    block: plan.snapshot.block.toString(),
    account: plan.account,
    holdings,
    unpriced,
    totalUsdE8: report === null ? null : report.totalUsdE8.toString(),
    targets,
    drift,
    blocked: plan.blocked.map((block) => ({ code: block.code, detail: block.detail })),
    complete: report !== null && plan.blocked.length === 0,
    sessionKey,
    gas,
  };
}

/**
 * 建一個帶 TTL 快取的狀態讀取器。`server.ts` 在建 server 時建**一個**，所以快取跨請求存活。
 *
 * 擁有者檢查在快取**之前**：快取以 portfolioId 為 key，先查快取等於讓錢包 B 讀到錢包 A 算好的狀態。
 */
export function createPortfolioStatusReader(deps: StatusDeps = {}): PortfolioStatusReader {
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const cache = new Map<number, { expiresAt: number; value: Promise<PortfolioStatus> }>();

  return async (portfolioId: number, wallet: string): Promise<PortfolioStatus> => {
    await find(portfolioId, wallet);

    const at = now();
    const hit = cache.get(portfolioId);
    if (hit !== undefined && hit.expiresAt > at) return hit.value;

    const entry: { expiresAt: number; value: Promise<PortfolioStatus> } = {
      // 先填「現在 + TTL」只是為了讓同時進來的第二個請求拿到同一個 promise；算完之後會用
      // **算完的時間**重算到期時間（見下面）。TTL 從「開始算」起算的話，一份要 8 秒的狀態在
      // 10 秒 TTL 下幾乎立刻失效，快取就等於不存在。
      expiresAt: at + STATUS_CACHE_TTL_MS,
      value: statusOf(portfolioId, deps),
    };
    cache.set(portfolioId, entry);
    if (cache.size > STATUS_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }

    void entry.value.then(
      () => {
        if (cache.get(portfolioId) === entry) entry.expiresAt = now() + STATUS_CACHE_TTL_MS;
      },
      (error: unknown) => {
        // 失敗**不進快取**：RPC 掛掉的那 10 秒不該被鎖死，使用者按「重試」就該真的重試一次。
        if (cache.get(portfolioId) === entry) cache.delete(portfolioId);
        log(
          JSON.stringify({
            level: 'warn',
            msg: 'portfolio status failed (not cached)',
            portfolioId,
            error: oneLine(error),
          }),
        );
      },
    );

    return entry.value;
  };
}

// ---------------------------------------------------------------------------
// POST /portfolios/:id/rebalance
// ---------------------------------------------------------------------------

/** 開啟 operator rebalance 的環境變數。 */
export const OPERATOR_REBALANCE_ENV = 'ENABLE_OPERATOR_REBALANCE';

/**
 * 這個部署是否允許「用一支 POST 讓伺服器動錢」。
 *
 * 只認字面值 `true`：`1`、`yes`、`TRUE `（尾端空白）一律當成**關閉**。這是一個會動錢的開關，
 * fail closed 比「猜使用者的意思」重要得多。
 */
export function operatorRebalanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OPERATOR_REBALANCE_ENV] === 'true';
}

/**
 * 三層判定之後的結果。`outcome` 的語意與排程器一致（見 `scheduler.ts` 的 `PortfolioOutcome`），
 * 唯一差別是把排程器收在一起的 `failed` 拆成兩種：
 *   reverted  上鏈了、gas 花了、三層沒有全過
 *   failed    根本沒送出去（沒有證據說它上鏈了）
 * 對按按鈕的人來說這兩件事的後果完全不同（一個花錢、一個沒有），所以不能合併。
 */
export type OperatorRebalanceOutcome = 'executed' | 'noop' | 'blocked' | 'reverted' | 'failed';

export type OperatorRebalanceResult = {
  portfolioId: number;
  outcome: OperatorRebalanceOutcome;
  /** 排程器寫的那一句話（含哪一層沒過、為什麼 blocked）。原文照回，不改寫成「失敗」。 */
  reason: string;
  txHash: string | null;
  userOpHash: string | null;
  /** 這筆 receipt 裡 executor 發出的 `SwapExecuted` 筆數。null = 有 tx 但讀不到 receipt。 */
  swapExecuted: number | null;
  /** 這一輪規劃了幾個 step（＝應該有幾筆 `SwapExecuted`）。 */
  expectedSwaps: number;
  gasUsed: string | null;
  /** 規劃器的完整 rationale（含「為什麼某一檔沒被買」）。null = 這一輪沒有規劃。 */
  rationale?: string | null;
  /** 真的被規劃出來（且送出）的參數；blocked/noop 時是空的。 */
  steps: { tokenIn: string; tokenOut: string; amountIn: string; amountOutMin: string }[];
};

/** `GET /portfolios/:id/plan` 的回應：這一輪**會做什麼、不會做什麼，以及為什麼**。 */
export type OperatorPlanPreview = {
  portfolioId: number;
  /** dry-run 的結論：`ready` = 現在按下去會送交易；`noop` = 不需要動；`blocked` = 被前置檢查擋下。 */
  outcome: 'ready' | 'noop' | 'blocked';
  /** 排程器寫的那一句話，**原文照回**。這是這支端點存在的全部理由。 */
  reason: string;
  /** 這一輪會送的 step（`ready` 才有）。前端不該自己猜，規劃在後端。 */
  steps: { tokenIn: string; tokenOut: string; amountIn: string; amountOutMin: string }[];
  /**
   * 規劃器的完整 rationale（含「為什麼某一檔沒被買」）。
   *
   * 為什麼一定要回：`reason` 只是一句話的結論（例如「Would execute 4 step(s)」），
   * 而「5 檔目標卻只有 4 步」的原因（被跳過的腿、預算、衝擊上限）全在 rationale 裡。
   * 沒有它，營運端只能猜 —— 實測就是這樣花了很久才發現「USDT 預算被算成 0.004」。
   */
  rationale?: string | null;
};

export type RebalanceDeps = {
  requireOwnedPortfolio?: typeof requireOwnedPortfolio;
  runSchedulerOnce?: typeof runSchedulerOnce;
  /** 排程器認領用的 transaction runner（測試注入記憶體 stub）。 */
  withTransaction?: WithTransactionFn;
  publicClient?: PublicClient;
  /** 讀 `SwapExecuted` 時要認的 emitter；省略 = `EXECUTOR_ADDRESS`。 */
  executor?: Address | null;
  log?: (line: string) => void;
};

/** 排程器的認領查詢裡，三個必須看得到的片段（少一個就代表 SQL 換了形狀 → 直接放棄）。 */
const CLAIM_LOCK_MARKER = 'for update of p skip locked';
const ACTIVE_PREDICATE = "where p.schedule_state = 'active'";
const DUE_PREDICATE = 'and (p.next_run_at is null or p.next_run_at <= $1)';

/**
 * 把排程器的認領查詢從「所有到期的 portfolio」縮成「只有這一個」。
 *
 * 為什麼要改寫：`runSchedulerOnce` 只認領**到期**的（`schedule_state = 'active'` 且
 * `next_run_at <= now`）。操作員按鈕的語意是「現在就跑」，與排程時鐘無關，所以：
 *   * **拿掉** `next_run_at` 的到期條件 —— 不然按了也可能什麼都不做（該投組明天才到期）。
 *   * **留著** `schedule_state = 'active'` —— 暫停的投組不該被手動觸發。
 *   * 加上 `p.id = $4`（portfolio id 當第四個參數）—— 這是「只動這一個」的唯一保證。
 *
 * 為什麼是改寫 SQL 而不是自己重寫一次決策流程：排程器的 live 路徑（前置檢查 a/a2/b/c → operations
 * 閘門 → 送出 → 三層判定 → 落 DB → 推進 next_run_at）是唯一被驗證過的那一份，重寫一份等於多一份
 * 會分岔的實作。這裡只動 SELECT 的 WHERE；認領與推進仍然在**同一個 transaction** 裡由排程器自己完成。
 *
 * 認不出這段 SQL（上游改了形狀）→ **拋錯中止**。最壞的失敗是「安靜地認領了全部到期的投組」，
 * 那會一次動到所有人的錢，所以寧可整輪什麼都不做。
 */
export function narrowClaimToPortfolio(text: string, portfolioId: number): string {
  if (!text.includes(CLAIM_LOCK_MARKER)) return text;
  if (!text.includes(ACTIVE_PREDICATE) || !text.includes(DUE_PREDICATE)) {
    throw new Error(
      'scheduler 的認領 SQL 換了形狀（找不到 schedule_state / next_run_at 條件）：' +
        'operator rebalance 沒辦法安全地把認領範圍縮成單一 portfolio，這一輪已中止，沒有送出任何交易',
    );
  }
  // `$1`（now）在縮減後已經沒有語意，但**不能讓它變成孤兒參數**：pg 的 extended protocol 要從 SQL
  // 推斷每個 $n 的型別，陣列裡有、SQL 裡沒有的參數會直接 `could not determine data type of parameter $1`。
  // `$1::timestamptz is not null` 恆為真（呼叫端一定傳 Date），效果就是「忽略到期時間」。
  return text.replace(DUE_PREDICATE, 'and ($1::timestamptz is not null) and p.id = $4');
}

const defaultTransaction: WithTransactionFn = (fn) =>
  withTransaction((client) =>
    fn({ query: (text, params) => client.query(text, params === undefined ? [] : [...params]) }),
  );

/**
 * 認領用的 transaction runner：只把**認領查詢**換成「這一個 portfolio」，其餘 SQL（推進
 * `next_run_at`、`last_checked_at`、`operations` 的每一次寫入）原樣放行。
 */
export function singlePortfolioClaim(
  portfolioId: number,
  inner?: WithTransactionFn,
): WithTransactionFn {
  const run = inner ?? defaultTransaction;
  return (fn) =>
    run((client) =>
      fn({
        query: (text, params) => {
          const narrowed = narrowClaimToPortfolio(text, portfolioId);
          return client.query(narrowed, narrowed === text ? params : [...(params ?? []), portfolioId]);
        },
      }),
    );
}

function defaultPublicClient(): PublicClient {
  const { rpcUrl } = getConfig();
  if (!rpcUrl) {
    throw new Error('chain 未設定：RPC_URL 是讀 receipt 的必要條件');
  }
  return createPublicClient({ chain: activeChain(), transport: http(rpcUrl) });
}

function operatorOutcome(result: PortfolioRunResult): OperatorRebalanceOutcome {
  switch (result.outcome) {
    case 'executed':
      return 'executed';
    case 'noop':
      return 'noop';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return result.execution?.status === 'reverted' ? 'reverted' : 'failed';
    case 'ready-dry-run':
      // 不可能：呼叫端明確傳 `dryRun: false`。真的出現就是有人改了契約，不要把它講成 noop。
      throw new AppError(
        500,
        'UNEXPECTED_DRY_RUN',
        '排程器回了 ready-dry-run，但 operator rebalance 明確要求 live：拒絕回一個看起來像「算過但沒動」的結果',
      );
  }
}

/**
 * 這筆送出到底換了幾筆。
 *
 * `ExecutionOutcome` 沒有帶 `SwapExecuted` 筆數（它在 `judgeRebalanceOutcome` 裡只用完就丟），所以
 * 有 txHash 時**重讀**一份 receipt 再數一次——只讀，不再送任何東西。數不出來就回 null，
 * 不回 0：0 會被讀成「數過，真的 0 筆」。
 */
async function swapExecutedFor(
  deps: RebalanceDeps,
  execution: ExecutionOutcome | null,
): Promise<number | null> {
  const txHash = execution?.txHash ?? null;
  // 沒有 txHash ＝ 這一輪根本沒有送出（blocked / noop / 送出失敗），換了 0 筆是事實，不是「不知道」。
  if (txHash === null) return 0;

  const executor = deps.executor ?? getSessionKeyConfig().executorAddress ?? null;
  if (executor === null) return null;

  try {
    const client = deps.publicClient ?? defaultPublicClient();
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    return countSwapExecuted(receipt.logs, executor);
  } catch {
    return null;
  }
}

/**
 * 對**單一** portfolio 跑一次 live 再平衡。
 *
 * 一定會先做擁有者檢查（與 `renewal-params` 同一條 `requireOwnedPortfolio`）：這支會動錢，
 * 所以「這是你的投組嗎」不能靠呼叫端自律。
 *
 * `ENABLE_OPERATOR_REBALANCE` 的檢查**不在這裡**，在 `server.ts` 的路由上：它是部署層的開關，
 * 與「這個 portfolio 是誰的」無關，應該在碰 DB 之前就擋掉（見 server.ts 的
 * `operatorRebalanceRoute`）。
 */
export async function runOperatorRebalance(
  portfolioId: number,
  wallet: string,
  deps: RebalanceDeps = {},
): Promise<OperatorRebalanceResult> {
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  await find(portfolioId, wallet);

  // 使用者主動要求跑一輪 = 「請幫我管理這個投組」→ 若之前因為清倉被暫停，這裡接回來。
  // 排程器只認領 `schedule_state = 'active'`，不接回來的話「入金後再也不會自動再平衡」。
  // 只在使用者端（owner）做：營運端的 Run round 不該改變使用者設定的排程狀態。
  await dbQuery(`update portfolios set schedule_state = 'active' where id = $1 and schedule_state = 'paused'`, [
    portfolioId,
  ]);

  const run = deps.runSchedulerOnce ?? runSchedulerOnce;
  const round = await run(
    // `dryRun: false` 是這支端點存在的理由，所以逐字寫出來（排程器的預設是 dry-run）。
    { dryRun: false, limit: 1 },
    {
      withTransaction: singlePortfolioClaim(portfolioId, deps.withTransaction),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    },
  );

  const result = round.results[0];
  if (result === undefined || result.portfolioId !== portfolioId) {
    // 認領查詢回了 0 列：`schedule_state` 不是 active，或這個 chain 上沒有 smart account。
    // 這一輪一個 portfolio 都沒動（不是「跑過了失敗」），所以要說清楚是被什麼擋在門外。
    return {
      portfolioId,
      outcome: 'blocked',
      reason:
        `排程器沒有認領 portfolio ${portfolioId}：schedule_state 不是 'active'，或這個 chain 上沒有它的 smart account。` +
        '這一輪沒有送出任何東西',
      txHash: null,
      userOpHash: null,
      swapExecuted: 0,
      expectedSwaps: 0,
      gasUsed: null,
      rationale: null,
      steps: [],
    };
  }

  const outcome = operatorOutcome(result);
  const execution = result.execution;
  return {
    portfolioId,
    outcome,
    reason: result.reason,
    txHash: execution?.txHash ?? null,
    userOpHash: execution?.userOpHash ?? null,
    swapExecuted: await swapExecutedFor(deps, execution),
    expectedSwaps: result.plan?.steps.length ?? 0,
    gasUsed: execution?.gasUsed ?? null,
    steps: (result.plan?.steps ?? []).map((step) => ({
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amountIn: step.amountIn,
      amountOutMin: step.amountOutMin,
    })),
    rationale: result.plan?.rationale ?? null,
  };
}

/**
 * `GET /portfolios/:id/plan` —— 跑一次 **dry-run**，回報這一輪會做什麼、不會做什麼、以及為什麼。
 *
 * 為什麼需要它：使用者按「執行」之前，唯一能看到「這一輪不會動」的地方是**按下之後**的結果卡。
 * 實測的形狀是「漂移 595 bps、但預估漂移不會下降 → 不送」，那不是錯誤，卻要按一次才知道 ——
 * 而按下去本身有成本（一輪規劃要讀鏈、估價、算 impact）。
 *
 * 為什麼**不**被 `ENABLE_OPERATOR_REBALANCE` 擋：它唯讀（dry-run 不寫 operations、不推進
 * `next_run_at`、不送交易），而且生產環境正是「開關關著、排程器自己在跑」——
 * 那時使用者最需要知道的就是「為什麼我的投組停住了」。把唯讀診斷綁在動錢的開關上會讓它失去用途。
 *
 * 走的是**排程器同一條路**（`runSchedulerOnce({ dryRun: true })` 且只認領這一個 portfolio），
 * 不是另寫一份規劃。兩份實作會在第一次改動時分岔，而分岔的後果是「預覽說會動、真的按下去不動」。
 */
export async function previewOperatorRebalance(
  portfolioId: number,
  wallet: string,
  deps: RebalanceDeps = {},
): Promise<OperatorPlanPreview> {
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  await find(portfolioId, wallet);

  const run = deps.runSchedulerOnce ?? runSchedulerOnce;
  const round = await run(
    // `dryRun: true` 逐字寫出來：這支端點**不會**動錢，而排程器的預設也是 dry-run（不靠預設值表達意圖）。
    { dryRun: true, limit: 1 },
    {
      withTransaction: singlePortfolioClaim(portfolioId, deps.withTransaction),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    },
  );

  const result = round.results[0];
  if (result === undefined || result.portfolioId !== portfolioId) {
    return {
      portfolioId,
      outcome: 'blocked',
      reason:
        `排程器沒有認領 portfolio ${portfolioId}：schedule_state 不是 'active'，或這個 chain 上沒有它的 smart account。`,
      steps: [],
      rationale: null,
    };
  }

  if (result.outcome === 'executed' || result.outcome === 'failed') {
    // dry-run 不可能執行；真的出現就是契約被改動了。不要把它講成 noop —— 那會讓「預覽說沒事、實際送了交易」
    // 變成一個安靜的謊。
    throw new AppError(
      500,
      'PLAN_PREVIEW_CONTRACT',
      `dry-run 回報 ${result.outcome}：排程器的契約被改動了（dry-run 不該執行任何交易）`,
    );
  }

  return {
    portfolioId,
    outcome: result.outcome === 'ready-dry-run' ? 'ready' : result.outcome,
    reason: result.reason,
    steps: (result.plan?.steps ?? []).map((step) => ({
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amountIn: step.amountIn,
      amountOutMin: step.amountOutMin,
    })),
    rationale: result.plan?.rationale ?? null,
  };
}

// ---------------------------------------------------------------------------
// 投組的活動紀錄（原站 portfolio 頁的 Activity 區塊）
// ---------------------------------------------------------------------------

export type PortfolioActivity = {
  id: number;
  state: string;
  txHash: string | null;
  userOpHash: string | null;
  attempts: number;
  createdAt: string;
  /** 那一輪前後的漂移（bps）。`null` = 沒有對應的快照（noop / blocked 不會寫）。 */
  driftBeforeBps: number | null;
  driftAfterBps: number | null;
  /** 前後總值（USD，1e8 定點）。差額就是這一輪的成本。 */
  usdBeforeE8: string | null;
  usdAfterE8: string | null;
};

export type ActivityDeps = {
  requireOwnedPortfolio?: typeof requireOwnedPortfolio;
  query?: typeof dbQuery;
};

type ActivityRow = {
  id: unknown;
  state: unknown;
  tx_hash: unknown;
  user_op_hash: unknown;
  attempts: unknown;
  created_at: unknown;
  drift_before: unknown;
  drift_after: unknown;
  usd_before: unknown;
  usd_after: unknown;
};

/**
 * 這個投組最近的執行紀錄，新到舊。
 *
 * 為什麼把前後快照 join 進來：`operations` 只說「送出去了、成功或失敗」，而那張前後快照表
 * （`phase = before / after`，用 `operation_id` 綁定）才是「這一輪到底做了什麼」。
 * 前端不該為了拼這件事再打三個端點。
 */
export async function listPortfolioActivity(
  portfolioId: number,
  wallet: string,
  deps: ActivityDeps = {},
  limit = 20,
): Promise<PortfolioActivity[]> {
  const owned = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  const find = deps.query ?? dbQuery;
  await owned(portfolioId, wallet, undefined);

  const { rows } = await find<ActivityRow>(
    `select o.id, o.state, o.tx_hash, o.user_op_hash, o.attempts, o.created_at,
            b.gross_drift_bps as drift_before, a.gross_drift_bps as drift_after,
            b.total_usd_e8 as usd_before, a.total_usd_e8 as usd_after
       from operations o
       left join portfolio_snapshots b
              on b.portfolio_id = o.portfolio_id and b.operation_id = o.id and b.phase = 'before'
       left join portfolio_snapshots a
              on a.portfolio_id = o.portfolio_id and a.operation_id = o.id and a.phase = 'after'
      where o.portfolio_id = $1
      order by o.id desc
      limit $2`,
    [portfolioId, limit],
  );

  return rows.map((row) => {
    const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    return {
      id: Number(row.id),
      state: String(row.state),
      txHash: text(row.tx_hash),
      userOpHash: text(row.user_op_hash),
      attempts: Number(row.attempts),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
      driftBeforeBps: num(row.drift_before),
      driftAfterBps: num(row.drift_after),
      usdBeforeE8: text(row.usd_before),
      usdAfterE8: text(row.usd_after),
    };
  });
}

// ---------------------------------------------------------------------------
// Operator 總覽（rebalance dashboard）
// ---------------------------------------------------------------------------

/**
 * 一排 = 一個投組。刻意**不**逐個呼叫 `portfolioStatus`：那條路徑會掃 Transfer 日誌 + 定價，
 * 實測 2–3 秒／投組，八個投組就是 20 秒以上 —— 儀表板要的是「快速看一眼現在怎麼樣」。
 *
 * 所以這裡讀**已經落地的資料**：最新的 before/after 快照（排程器每輪都寫）、最後一筆 operation、
 * session key 的到期日、next_run_at。只有 gas 是即時讀的（一次 `eth_getBalance`，很便宜）。
 * 代價是「觀測時間」可能是幾分鐘前 —— 所以每一列都帶 `observedAt`，使用者自己看得到新鮮度。
 */
export type OperatorPortfolioRow = {
  id: number;
  strategyId: number;
  strategyName: string | null;
  version: number;
  scheduleState: string;
  account: string | null;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  /** 最新快照的觀測點。`null` = 從來沒跑過。 */
  observedAt: string | null;
  driftBps: number | null;
  /**
   * 帳戶價值是 0（資金已全部提出，或從來沒入金）。
   *
   * 為什麼要獨立一欄：`drift.ts` 對空倉回 5000 bps 是**公式的結果**（空帳戶「完全不在目標上」），
   * 但把它顯示成「9999 bps / rebalance due」會讓人以為壞了 —— 實際上它只是空。
   * 呼叫端（operator 頁面）應該顯示「Empty」而不是「rebalance due」。
   */
  isEmpty: boolean;
  totalUsdE8: string | null;
  needsRebalance: boolean | null;
  blockedCount: number | null;
  /** 帳戶的原生幣餘額（即時）。`null` = 讀不到。 */
  gasWei: string | null;
  sessionKeyExpiresAt: string | null;
  lastOperation: { id: number; state: string; txHash: string | null; createdAt: string } | null;
};

export type OperatorOverview = {
  generatedAt: string;
  /**
   * 排程器心跳。`null` = 從來沒寫過（沒跑過），不是「死了」。
   *
   * 為什麼不從 `portfolios.last_checked_at` 推算：所有投組都還沒到期時那個時間是舊的，
   * 看起來就像排程器死了 —— 而「死掉」與「沒事做」是兩種完全不同的處置。
   */
  scheduler: SchedulerStatus | null;
  alerts: { critical: number; warn: number; open: number } | null;
  /** 最近一次有投組被檢查的時間 —— 排程器有心跳的最直接證據。 */
  lastCheckedAt: string | null;
  portfolios: OperatorPortfolioRow[];
};

export type OperatorOverviewDeps = {
  query?: QueryFn;
  /** 讀帳戶原生幣餘額；省略 = `getAccountGasBalance`。 */
  accountGasBalance?: (address: Address) => Promise<bigint>;
};

const SQL_OPERATOR_ROWS = `
  select p.id, p.user_id as wallet, p.strategy_id, s.name as strategy_name, p.version, p.schedule_state,
         p.next_run_at, p.last_checked_at,
         sa.address as account,
         snap.created_at as observed_at, snap.gross_drift_bps, snap.total_usd_e8, snap.needs_rebalance,
         (select count(*)::int from portfolio_snapshots b
           where b.portfolio_id = p.id and b.phase = 'before' and b.operation_id = snap.operation_id) as blocked_count,
         key.expires_at as key_expires_at,
         op.id as op_id, op.state as op_state, op.tx_hash as op_tx, op.created_at as op_created_at
    from portfolios p
    left join strategies s on s.id = p.strategy_id
    left join smart_accounts sa on sa.portfolio_id = p.id
    left join lateral (
      select created_at, gross_drift_bps, total_usd_e8, needs_rebalance, operation_id
        from portfolio_snapshots
       where portfolio_id = p.id
       -- 同一輪的 before/after 可能落在同一個 created_at（同一個交易），
       -- 沒有 tiebreaker 時 Postgres 可以回任一張 —— 實測就看到「價值是清倉前的、
       -- 漂移是清倉後」的組合。phase 決勝讓它永遠取 after（＝這一輪之後的真相）。
       order by created_at desc, block desc, (phase = 'after') desc
       limit 1
    ) snap on true
    left join lateral (
      select expires_at from session_keys
       where portfolio_id = p.id and status = 'active'
       order by expires_at desc
       limit 1
    ) key on true
    left join lateral (
      select id, state, tx_hash, created_at from operations
       where portfolio_id = p.id
       order by id desc
       limit 1
    ) op on true
   order by p.id
`;

export async function readOperatorOverview(deps: OperatorOverviewDeps = {}): Promise<OperatorOverview> {
  const find = deps.query ?? dbQuery;
  const readBalance = deps.accountGasBalance ?? getAccountGasBalance;

  const [{ rows }, scheduler, alerts] = await Promise.all([
    find(SQL_OPERATOR_ROWS),
    readSchedulerStatus().catch(() => null),
    listOpenAlerts(find).then((open) => {
      let critical = 0;
      let warn = 0;
      for (const alert of open) {
        if (alert.severity === 'critical') critical += 1;
        else warn += 1;
      }
      return { critical, warn, open: critical + warn };
    }).catch(() => null),
  ]);

  const iso = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  };
  const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

  const portfolios: OperatorPortfolioRow[] = await Promise.all(
    (rows as Record<string, unknown>[]).map(async (row) => {
      const account = typeof row.account === 'string' ? row.account : null;
      // gas 讀不到（RPC 掛、fork 過期）→ null。儀表板不該因為一個 RPC 失敗就整頁掛掉。
      const gasWei =
        account === null
          ? null
          : await readBalance(account as Address)
              .then((wei) => wei.toString())
              .catch(() => null);

      const opId = num(row.op_id);
      return {
        id: Number(row.id),
        wallet: String(row.wallet ?? ''),
        strategyId: Number(row.strategy_id),
        strategyName: typeof row.strategy_name === 'string' ? row.strategy_name : null,
        version: Number(row.version),
        scheduleState: String(row.schedule_state),
        account,
        nextRunAt: iso(row.next_run_at),
        lastCheckedAt: iso(row.last_checked_at),
        observedAt: iso(row.observed_at),
        driftBps: num(row.gross_drift_bps),
        isEmpty: String(row.total_usd_e8 ?? '0') === '0',
        totalUsdE8: row.total_usd_e8 === null || row.total_usd_e8 === undefined ? null : String(row.total_usd_e8),
        // 空倉一律 needsRebalance = false：沒有部位就沒有東西可搬，標成「該再平衡」只會製造噪音
        // （實測：清倉後兩檔都掛著「rebalance due」+ 9999 bps，看起來像壞掉）。
        needsRebalance:
          String(row.total_usd_e8 ?? '0') === '0'
            ? false
            : row.needs_rebalance === null || row.needs_rebalance === undefined
              ? null
              : row.needs_rebalance === true,
        blockedCount: num(row.blocked_count),
        gasWei,
        sessionKeyExpiresAt: iso(row.key_expires_at),
        lastOperation:
          opId === null
            ? null
            : {
                id: opId,
                state: String(row.op_state),
                txHash: typeof row.op_tx === 'string' ? row.op_tx : null,
                createdAt: iso(row.op_created_at) ?? '',
              },
      };
    }),
  );

  const lastCheckedAt = portfolios
    .map((row) => row.lastCheckedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;

  return { generatedAt: new Date().toISOString(), scheduler, alerts, lastCheckedAt, portfolios };
}

// ---------------------------------------------------------------------------
// Redeem：把部位賣成 numeraire（提領成 USDT 的前半段）
// ---------------------------------------------------------------------------

/**
 * 為什麼需要「先賣再提」而不是直接提領資產。
 *
 * 使用者要的是「存 USDT、提 USDT」。但錢在部位裡（TSLAB/SPCXB/…），要變成 USDT 只能在鏈上賣掉。
 * 賣這一步是 executor 的工作、由 **session key** 簽（owner 的 CallPolicy 不允許，反過來也一樣），
 * 所以它是「一輪再平衡」而不是「一筆轉帳」。
 *
 * 關鍵是**按比例賣**：每一檔非 numeraire 的部位都賣掉 `A / T` 的比例（A=要提領的美元、T=總價值）。
 * 這樣賣完之後每個資產的**權重不變**，因此：
 *   * 合規上仍然貼著 mandate（不會變成 100% 現金）
 *   * 排程器不會立刻把它買回來（漂移沒有變大）
 *   * 使用者拿到的是「按比例縮小後的基金 + 一筆 USDT」
 *
 * 走的是排程器同一條路（`runSchedulerOnce` 只認領這一個 portfolio），只是把
 * `planRebalance` 換成「按比例賣出」—— 送出、地板重問、operations 記錄、快照全部沿用，
 * 不另寫一份執行路徑（兩份實作一定會分岔）。
 */
export type RedeemResult = {
  portfolioId: number;
  outcome: OperatorRebalanceOutcome;
  reason: string;
  txHash: string | null;
  /** 賣出的步驟（每一檔一筆）。 */
  steps: { tokenIn: string; tokenOut: string; amountIn: string; amountOutMin: string }[];
  /** 這一輪賣出的估算美元（= 使用者要提領的金額）。 */
  redeemedUsdE8: string;
};

export async function runOperatorRedeem(
  portfolioId: number,
  wallet: string,
  usdE8: bigint,
  deps: RebalanceDeps = {},
): Promise<RedeemResult> {
  if (usdE8 <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'redeem amount must be greater than zero');
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  await find(portfolioId, wallet);

  const run = deps.runSchedulerOnce ?? runSchedulerOnce;
  const round = await run(
    { dryRun: false, limit: 1 },
    {
      withTransaction: singlePortfolioClaim(portfolioId, deps.withTransaction),
      planRebalance: (input) => buildRedeemPlan(input, usdE8),
      // 按比例賣不會讓漂移變大，所以「不需要再平衡」不代表「不用做」——不 force 就永遠 noop。
      forcePlan: true,
      ...(deps.log === undefined ? {} : { log: deps.log }),
    },
  );

  const result = round.results[0];
  if (result === undefined || result.portfolioId !== portfolioId) {
    return {
      portfolioId,
      outcome: 'blocked',
      reason: `排程器沒有認領 portfolio ${portfolioId}（schedule_state 不是 active，或鏈上沒有它的 smart account）`,
      txHash: null,
      steps: [],
      redeemedUsdE8: usdE8.toString(),
    };
  }

  return {
    portfolioId,
    outcome: operatorOutcome(result),
    reason: result.reason,
    txHash: result.execution?.txHash ?? null,
    steps: (result.plan?.steps ?? []).map((step) => ({
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amountIn: step.amountIn,
      amountOutMin: step.amountOutMin,
    })),
    redeemedUsdE8: usdE8.toString(),
  };
}


const ORACLE_ABI = [
  {
    type: 'function',
    name: 'previewSwap',
    stateMutability: 'view',
    inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' }],
    outputs: [{ name: 'quoted', type: 'uint256' }, { name: 'minimum', type: 'uint256' }],
  },
  { type: 'function', name: 'oracleOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }] },
] as const;

const POOL_FEE_ABI = [
  { type: 'function', name: 'pool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const;

/**
 * executor 抽成的 bps（＝`minGross` 的放大倍率）。
 *
 * 從 registry 讀 `effectiveFeeBps`，而不是從 DB 的 `strategies.swap_fee_bps`：後者是我們**送出去**
 * 的值，前者是**鏈上實際生效**的值（中間可能有下限或治理調整）。用錯的那個會讓 `minGross` 偏低，
 * 合約以 `BelowFloor` revert，而錯誤訊息完全看不出是這個原因。
 */
async function readExecutorFeeBps(strategyOnchainId: bigint): Promise<number> {
  const registry = getConfig().registryAddress;
  if (registry === null) throw new Error('沒有設定 REGISTRY_ADDRESS，讀不到 effectiveFeeBps');
  const value = await defaultPublicClient().readContract({
    address: registry as Address,
    abi: [{ type: 'function', name: 'effectiveFeeBps', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ type: 'uint16' }] }] as const,
    functionName: 'effectiveFeeBps',
    args: [strategyOnchainId],
  });
  return Number(value);
}

/** path 的 fee 層：從該資產的 per-pair oracle 反查它綁的池子。 */
async function readPoolFee(router: Address, asset: Address): Promise<number> {
  const client = defaultPublicClient();
  const pairOracle = (await client.readContract({
    address: router,
    abi: ORACLE_ABI,
    functionName: 'oracleOf',
    args: [asset],
  })) as Address;
  const pool = (await client.readContract({ address: pairOracle, abi: POOL_FEE_ABI, functionName: 'pool' })) as Address;
  const fee = (await client.readContract({ address: pool, abi: POOL_FEE_ABI, functionName: 'fee' })) as number;
  return Number(fee);
}

async function readStrategyOnchainId(portfolioId: number): Promise<bigint> {
  const { rows } = await dbQuery<{ onchain_id: string | number }>(
    `select s.onchain_id from portfolios p join strategies s on s.id = p.strategy_id where p.id = $1`,
    [portfolioId],
  );
  const value = rows[0]?.onchain_id;
  if (value === undefined || value === null) throw new Error(`portfolio ${portfolioId} 的 strategy 沒有 onchain_id`);
  return BigInt(value);
}

/** `priceable_assets.is_numeraire` 的那一個地址（會計資產）。 */
async function readNumeraireAddress(): Promise<Address> {
  const { rows } = await dbQuery<{ address: string }>(
    'select address from priceable_assets where is_numeraire order by symbol limit 1',
  );
  const address = rows[0]?.address;
  if (typeof address !== 'string') throw new Error('priceable_assets 沒有 is_numeraire 的列，redeem 不知道要換成什麼');
  return address as Address;
}

/** viem 錯誤裡的 revert 名稱（`UnsupportedPair` / `ZeroQuote` …），拿不到就回 null。 */
function revertNameOfForLog(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /reverted with the following reason:\s*([A-Za-z0-9_]+)/.exec(message);
  if (match?.[1] !== undefined) return match[1];
  const custom = /reverted with custom error '([A-Za-z0-9_]+)/.exec(message);
  return custom?.[1] ?? null;
}

/** 把 `wantUsdE8` 換成「每一檔按同一個比例賣」的 steps。 */
async function buildRedeemPlan(
  input: RebalancePlanningInput,
  wantUsdE8: bigint,
): Promise<RebalancePlan> {
  const { account, snapshot, report, portfolioId } = input.plan;
  const totalE8 = report?.totalUsdE8 ?? 0n;
  if (totalE8 === 0n) return { kind: 'noop', reason: '投組價值是 0，沒有東西可以賣' };
  if (wantUsdE8 > totalE8) {
    return {
      kind: 'blocked',
      reason: `要提領 ${Number(wantUsdE8) / 1e8} 美元，但投組只有 ${Number(totalE8) / 1e8} 美元`,
    };
  }

  const client = defaultPublicClient();
  const executor = getSessionKeyConfig().executorAddress;
  if (executor === null) return { kind: 'blocked', reason: '這個部署沒有設定 EXECUTOR_ADDRESS' };
  const router = (await client.readContract({
    address: executor,
    abi: [{ type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const,
    functionName: 'oracle',
  })) as Address;
  const numeraire = await readNumeraireAddress();

  const strategyOnchainId = await readStrategyOnchainId(portfolioId);
  const block = await client.getBlockNumber();
  const steps: PlannedStep[] = [];
  const notes: string[] = [];

  for (const holding of snapshot.holdings) {
    if (holding.asset.toLowerCase() === numeraire.toLowerCase()) continue;
    // 按比例：amountIn = balance × want / total（向下取整，絕不多賣）
    const amountIn = (holding.amountWei * wantUsdE8) / totalE8;
    if (amountIn <= 0n) continue;

    const quoted = await client
      .readContract({
        address: router,
        abi: ORACLE_ABI,
        functionName: 'previewSwap',
        args: [holding.asset as Address, numeraire, amountIn],
      })
      .catch((error: unknown) => {
        notes.push(`${holding.asset} 報不出價（${revertNameOfForLog(error) ?? 'unknown'}）`);
        return null;
      });
    if (quoted === null) continue;
    const [quotedOut, floor] = quoted as readonly [bigint, bigint];
    if (quotedOut === 0n || floor === 0n) {
      notes.push(`${holding.asset} 的報價是 0`);
      continue;
    }
    const feeBps = await readExecutorFeeBps(strategyOnchainId);
    steps.push(
      buildStep({
        executor,
        tokenIn: holding.asset as Address,
        tokenOut: numeraire,
        amountIn,
        oracleFloor: floor,
        minGross: minGrossFor(floor, feeBps),
        poolFee: await readPoolFee(router, holding.asset as Address),
      }),
    );
  }

  if (steps.length === 0) {
    return { kind: 'noop', reason: `沒有可賣的部位${notes.length === 0 ? '' : `：${notes.join('; ')}`}` };
  }

  const { timestamp } = await client.getBlock({ blockNumber: block });
  return {
    kind: 'ready',
    steps,
    deadline: timestamp + 1200n,
    rationale:
      `按比例賣出 ${steps.length} 檔以換成 numeraire（每檔賣掉 ${(Number(wantUsdE8) / Number(totalE8) * 100).toFixed(2)}%），` +
      `權重不變所以排程器不會把它買回來` +
      (notes.length === 0 ? '' : `；略過：${notes.join('; ')}`),
  };
}

/**
 * `POST /portfolios/:id/close` —— 清倉：把**全部**部位賣成 numeraire。
 *
 * 與 redeem 的差別只在比例：redeem 賣 `A / T`（保留投組形狀），close 賣 **100%**。
 * 所以它直接沿用同一條管線（`runOperatorRedeem` + `forcePlan`），只是把「要提領的美元」
 * 換成「目前的總價值」——`amountIn = balance × T / T = balance`，也就是整筆。
 *
 * 為什麼不是另寫一份「全部賣出」：賣出涉及 oracle 地板、impact 上限、地板重問、operations 記錄，
 * 那些全都已經在 redeem/planRebalance 裡；另寫一份一定會分岔（這個 repo 已經吃過兩次同樣的虧）。
 *
 * 賣不掉的部分（流動性不足、報不出價）**留在帳戶裡**並回報，由前端接著把它們直接轉回錢包 ——
 * 清倉的語意是「錢包裡什麼都不剩」，不是「帳戶裡什麼都不剩」。
 */
export async function runOperatorClose(
  portfolioId: number,
  wallet: string,
  deps: RebalanceDeps = {},
): Promise<RedeemResult> {
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  await find(portfolioId, wallet);

  // 先讀一次現值：清倉要賣的就是「全部」，而金額必須先知道才能交給同一條管線。
  const status = await statusOf(portfolioId, {});
  const totalE8 = status.totalUsdE8 === null ? 0n : BigInt(status.totalUsdE8);
  if (totalE8 <= 0n) {
    // 已經是空的：仍然要「歸位」（pause），否則一個已清空但仍 active 的投組會永遠留在
    // operator 的預設清單裡，掛著 drift 9999 bps 與 gas low。這也是 Close 的冪等語意。
    await dbQuery(`update portfolios set schedule_state = 'paused' where id = $1`, [portfolioId]);
    return {
      portfolioId,
      outcome: 'noop',
      reason: '投組價值是 0，沒有東西可以清倉（排程已暫停）',
      txHash: null,
      steps: [],
      redeemedUsdE8: '0',
    };
  }
  const result = await runOperatorRedeem(portfolioId, wallet, totalE8, deps);

  // 清倉成功了就把排程暫停：帳戶被搬到空，繼續讓排程器每 24 小時「再平衡一個 $0 的投組」
  // 只會製造噪音（operator 頁面上會掛著 drift 9999 bps 與 gas low）。
  //
  // 這裡**不刪**投組：它是使用者的部位紀錄，而且 counterfactual 地址由 (owner, strategy) 決定，
  // 下次入金會回到**同一個**帳戶 —— 刪掉反而會讓「重新入金」看起來像換了一個帳戶。
  //
  // 判準用「**現在**價值是不是 0」，而不是 outcome：已經空了的投組再按一次 Close 會回 noop，
  // 那也該被歸位（否則舊的、已清空但仍 active 的投組永遠留在 operator 的預設清單裡）。
  const after = await statusOf(portfolioId, {}).catch(() => null);
  // `executed` 也算：清倉的後半段（把錢掃回錢包）是前端另一筆 owner UserOp，
  // 可能在這一輪結束**之後**才上鏈。那時 `statusOf` 還看得到現金，但使用者按的是 Close ——
  // 意圖明確，就該歸位。若真的只清了一半，下次入金/rebalance 會把 active 接回來。
  const nowEmpty = result.outcome === 'executed' || after === null || String(after.totalUsdE8 ?? '0') === '0';
  if (nowEmpty) {
    await dbQuery(`update portfolios set schedule_state = 'paused' where id = $1`, [portfolioId]);
    // 一併關掉這個投組的未解決警示。
    //
    // 為什麼：`resolveAlerts` 是「這一輪沒偵測到的警示 → 標成已解決」，而排程器只認領 active
    // 的投組。所以一個被暫停的投組，它的 gas-low / 其它警示會**永遠**停在 open
    // （實測：清倉並暫停後，operator 仍顯示 2 critical）。
    await dbQuery(
      `update scheduler_alerts set resolved_at = now() where portfolio_id = $1 and resolved_at is null`,
      [portfolioId],
    ).catch(() => undefined);
  }
  return result;
}

/**
 * 營運端的全域活動流：**誰**（owner 錢包）在**哪個策略**上被再平衡了。
 *
 * 為什麼需要：`operations` 只有 `portfolio_id`，要回答「這輪排程器動了誰」得自己 join
 * portfolios → strategies。`/operator` 的表格是「現況」（誰現在 drift 多少），
 * 這裡是「歷史」（誰在什麼時候被處理、成功還是失敗）。
 *
 * 刻意**不**做 owner 驗證：營運端要能看全部。這也是為什麼它放在 `/operator` 底下
 * 而不是 `/portfolios/:id/activity`。
 */
export type OperatorActivityRow = {
  id: number;
  portfolioId: number;
  /** owner 錢包。 */
  wallet: string;
  strategyId: number;
  strategyName: string | null;
  /** `rebalance` / `approve` / … */
  type: string;
  state: string;
  txHash: string | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  /** 這一輪前後的漂移（bps）。`null` = noop/blocked 不寫快照。 */
  driftBeforeBps: number | null;
  driftAfterBps: number | null;
  usdBeforeE8: string | null;
  usdAfterE8: string | null;
};

type OperatorActivityDbRow = {
  id: unknown;
  portfolio_id: unknown;
  wallet: unknown;
  strategy_id: unknown;
  strategy_name: unknown;
  type: unknown;
  state: unknown;
  tx_hash: unknown;
  attempts: unknown;
  last_error: unknown;
  created_at: unknown;
  drift_before: unknown;
  drift_after: unknown;
  usd_before: unknown;
  usd_after: unknown;
};

/**
 * 最近 N 筆操作（跨所有投組）。
 *
 * `limit` 有上限：這是給人看的列表，不是匯出工具 —— 一次拉一萬筆只會讓瀏覽器卡住。
 */
export async function readOperatorActivity(
  limit = 50,
  deps: OperatorOverviewDeps = {},
): Promise<OperatorActivityRow[]> {
  const find = deps.query ?? dbQuery;
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 200);

  // `QueryFn` 沒有泛型（回傳 `rows: unknown[]`），所以這裡自己轉型。
  const { rows } = await find(
    `select o.id, o.portfolio_id, p.user_id as wallet, p.strategy_id,
            st.name as strategy_name,
            o.type, o.state, o.tx_hash, o.attempts, o.last_error, o.created_at,
            b.gross_drift_bps as drift_before, a.gross_drift_bps as drift_after,
            b.total_usd_e8 as usd_before, a.total_usd_e8 as usd_after
       from operations o
       join portfolios p on p.id = o.portfolio_id
       left join strategies st on st.id = p.strategy_id
       left join portfolio_snapshots b
              on b.portfolio_id = o.portfolio_id and b.operation_id = o.id and b.phase = 'before'
       left join portfolio_snapshots a
              on a.portfolio_id = o.portfolio_id and a.operation_id = o.id and a.phase = 'after'
      order by o.id desc
      limit $1`,
    [capped],
  );
  const data = rows as OperatorActivityDbRow[];

  const num = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const str = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  const iso = (value: unknown): string => {
    if (value === null || value === undefined) return new Date(0).toISOString();
    return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  };

  return data.map((row) => ({
    id: Number(row.id),
    portfolioId: Number(row.portfolio_id),
    wallet: String(row.wallet ?? ''),
    strategyId: Number(row.strategy_id),
    strategyName: str(row.strategy_name),
    type: String(row.type),
    state: String(row.state),
    txHash: str(row.tx_hash),
    attempts: Number(row.attempts ?? 0),
    error: str(row.last_error),
    createdAt: iso(row.created_at),
    driftBeforeBps: num(row.drift_before),
    driftAfterBps: num(row.drift_after),
    usdBeforeE8: str(row.usd_before),
    usdAfterE8: str(row.usd_after),
  }));
}
