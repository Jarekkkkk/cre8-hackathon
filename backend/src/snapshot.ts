import { createPublicClient, http } from 'viem';
import type { Address, PublicClient } from 'viem';
import { activeChain } from './chain-object.js';
import { getConfig } from './config.js';
import { query as dbQuery } from './db.js';
import { computeDrift } from './drift.js';
import type { DriftReport, Holding, TargetWeight } from './drift.js';
import { scanPortfolioHoldings } from './holdings-scan.js';
import type { HoldingScanResult } from './holdings-scan.js';
import type { PriceableAsset, PositionSnapshot, PriceTokenFn } from './positions.js';
import { readPositions } from './positions.js';

/**
 * 排程器的一步：DB → 鏈上 → 漂移 → 快照。
 *
 * `planPortfolio` 只讀不寫（讀 DB、讀鏈），回傳「這次算出來的東西」；`writeSnapshot` 才碰 DB。
 * 分開的理由是排程器要能在寫入前決定要不要動（`needsRebalance`），而重算一次比「先寫再改」便宜。
 *
 * 幾個會靜默污染的設計決定：
 *
 * ① **native BNB 不進漂移。** `readPositions` 把 gas 用的 BNB 單獨回傳，`holdings` 只有投資部位。
 *    詳見 positions.ts 的檔頭。
 *
 * ② **目標權重釘在鏈上的 `enrollment.version`，不是 DB 的 `portfolios.version`。**
 *    排程器要對齊的是「該帳戶被釘住的版本」：策略發了新版本之後，跟著舊版的帳戶若照新版的權重
 *    算，漂移會完全錯（而且看起來很合理）。`registry.version(id, 0)` 會被解析成 active version，
 *    那是同一種錯誤的另一個入口，所以 `version === 0` 在這裡是硬錯誤。
 *
 * ③ **無價資產 → 整份拒算漂移（設計 (a)）。** `drift.ts` 的 `Holding` 需要 `usdPriceE8`；把無價
 *    資產當成 0 會讓其他資產的權重集體偏高，算出來的 `grossDriftBps` 看起來仍然合理，於是一個
 *    「算錯但看起來正常」的報告會被送進 keeper。所以只要帳戶**真的持有**（amountWei > 0）任何
 *    無價資產，`report` 就是 null 並帶著原因；快照列照寫，`usd_value` 留 NULL——`positions_snapshots`
 *    的 `positions_snapshots_price_provenance` 約束（三者 all-or-nothing）加上 `drift.ts` 的
 *    `parseSnapshotRows`（沒有 usd_value 就拋錯）讓「不完整」變成**資料層自己會拒絕**的狀態，
 *    而不是靠下游記得檢查。
 *
 * ④ **每一輪都寫一列表頭（`portfolio_snapshots`），空倉也寫。** 明細（`positions_snapshots`）在
 *    空倉時一列都沒有，於是「跑過、確認帳戶什麼都沒有」與「索引器根本沒跑」在下游長得一模一樣。
 *    表頭是那個永遠存在的東西，並且帶著 `complete`：false = 這一輪的漂移數字不可信（拒算的原因見
 *    ③ 與 `allocationCheck`），判讀前必須先看它。
 *
 * ⑤ **讀取與定價的宇宙 == 策略的 `version.assets`，不是 `priceable_assets` 全表。**
 *    執行器只允許換 `version.assets` 裡的代幣（`AtpExecutor.sol:180-182` 的 `isAssetAllowed`），
 *    所以策略外的代幣（空投、使用者亂轉）**賣不掉** → 不可能參與再平衡 → 不該進漂移的分母。
 *    `priceable_assets` 降級成查價表（「這個地址的價格怎麼查」），只回答定價，不回答「要讀哪些資產」。
 *    策略資產在查價表裡找不到、或沒有池／沒有價 → **仍然 blocked**（`UNPRICED_HOLDINGS`）：
 *    我們不知道策略成分值多少，就算不出權重，那是真正的問題。
 *
 * ⑥ **策略外持倉：不阻擋，只記錄。** 它不進 `blocked`，也不進 `unpriced`（沒有 `decimals`，掃描
 *    只從日誌拿到地址），而是走表頭的 `unknown_token_count`（`holdings-scan.ts` 的掃描結果）。
 *    `complete` 只回答「策略資產是否都有價」，`universe_complete` 是「掃描有沒有覆蓋帳戶的歷史」。
 *    兩者都是**觀測訊號**：空投不會讓漂移停擺，但運維看得到它。
 *
 *    反過來（舊語意）會把「無法執行的東西」當成「必須處理的東西」：一顆被空投的雜幣就讓一個
 *    完全在目標上的投組停止再平衡。方向是錯的，0009 的 CHECK 也是那個錯語意的一部分，由 0011 移除。
 */

/** 再平衡門檻：`grossDriftBps >= thresholdBps` 就該動。1% 是 Mag7 這種大權重組合的常見容忍度。 */
export const DEFAULT_THRESHOLD_BPS = 100;

const E8 = 100_000_000n;
const E18 = 10n ** 18n;
/** usd_value 是 numeric(38,18)；drift 的 E8 定點換過去要乘 1e10。 */
const E8_TO_E18 = 10n ** 10n;

/** 只用到兩個 view，但兩者的回傳形狀不同（struct vs 攤平），照合約定義寫清楚。 */
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

const SQL_PORTFOLIO = `
  select p.id as portfolio_id, p.strategy_id, s.onchain_id, sa.address
    from portfolios p
    join strategies s on s.id = p.strategy_id
    join smart_accounts sa on sa.portfolio_id = p.id
   where p.id = $1 and sa.chain_id = $2
`;

const SQL_ALLOCATION = 'select allocation from strategy_versions where strategy_id = $1 and version = $2';

const SQL_TOKENS =
  'select address, symbol, usdt_pool, is_numeraire from priceable_assets where enabled order by symbol';

/** DB 的最小介面：只要求 `{ rows }`，`db.query` 與測試 stub 都直接接得上。 */
export type QueryFn = (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

/** 鏈上 enrollment 釘住的版本。`version` 一定是 >= 1：0 會解析成 active version，這裡不接受。 */
export type PinnedVersion = {
  version: number;
  onchainStrategyId: number;
  paused: boolean;
};

/** DB 的 allocation 與鏈上 `registry.version()` 的對照結果。不一致就是資料不一致，不是可以忽略的警告。 */
export type AllocationCheck = {
  consistent: boolean;
  chain: TargetWeight[];
  mismatches: string[];
};

/** 拒算漂移的原因。空的 `blocked` = 有報告。 */
export type PlanBlock = {
  code: 'UNPRICED_HOLDINGS' | 'ALLOCATION_MISMATCH';
  detail: string;
};

/** 目標權重加上顯示用的 ticker（多帶一個欄位仍然滿足 drift.ts 的 TargetWeight）。 */
export type PlanTarget = TargetWeight & { symbol: string };

export type PortfolioPlan = {
  portfolioId: number;
  /** DB 的 strategies.id（`portfolios.strategy_id`）；與鏈上 id 的對應是 `strategies.onchain_id`。 */
  strategyId: number;
  account: Address;
  chainId: number;
  /** `readPositions` 的結果：block、native BNB、持倉、無價資產。 */
  snapshot: PositionSnapshot;
  /**
   * `scanPortfolioHoldings` 的結果：轉入日誌掃到哪、宇宙外有餘額的代幣、宇宙完整性。
   * `scan.block` 與 `snapshot.block` **一定相等**（兩者都吃 `planPortfolio` 開頭決定的那個塊）。
   */
  scan: HoldingScanResult;
  /** null = 拒算（見 `blocked`）。 */
  report: DriftReport | null;
  blocked: PlanBlock[];
  targets: PlanTarget[];
  pinnedVersion: PinnedVersion;
  allocationCheck: AllocationCheck;
  thresholdBps: number;
};

export type PlanDeps = {
  publicClient?: PublicClient;
  registryAddress?: Address;
  chainId?: number;
  query?: QueryFn;
  priceToken?: PriceTokenFn;
  thresholdBps?: number;
  /**
   * 要觀測的塊高。省略 = 這次呼叫自己讀 head。
   * 給了就可以對同一個塊重跑並要求逐位相同的結果（`snapshot.block` 就是它）。
   */
  block?: bigint;
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** pg 對 bigint 一律回字串，這裡接受兩種形狀並擋掉「不是整數」的資料。 */
function toInteger(value: unknown, what: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`${what} 不是整數（收到 ${JSON.stringify(value)}）`);
  return parsed;
}

function asAddress(value: unknown, what: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${what} 不是 0x + 40 hex 的地址（收到 ${JSON.stringify(value)}）`);
  }
  return value.toLowerCase() as Address;
}

/**
 * strategy_versions.allocation → 目標權重。形狀不對就拋錯，不猜、不補 0。
 *
 * ## symbol 從哪來（踩過的坑）
 * allocation 只**必須**有 `address` 與 `weightBps`；`symbol` 是選填的顯示資料。早期手動建立的策略
 * 把它寫進去了，而 API 建立的（`validateAllocation` 只讀 address/weightBps）沒有 —— 於是同一個
 * 狀態頁，舊策略顯示 `WBNB`、新策略顯示 `0xbb4C…095c`。
 *
 * 修正的方向是**不要讓顯示資料住在策略裡**：`priceable_assets` 才是 symbol 的權威
 * （同一顆代幣在每個策略裡都該叫同一個名字）。所以順序是：
 *   ① `symbolByAddress`（priceable_assets，權威）
 *   ② allocation 裡若有 `symbol`（舊資料，退而求其次）
 *   ③ 短地址（真的一個都沒有時）
 */
function parseAllocation(
  raw: unknown,
  strategyId: number,
  version: number,
  symbolByAddress: ReadonlyMap<string, string> = new Map(),
): PlanTarget[] {
  const assets = (raw as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error(`strategy_versions(${strategyId}, ${version}).allocation 沒有 assets 陣列`);
  }
  return assets.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`strategy_versions(${strategyId}, ${version}).allocation.assets[${index}] 不是物件`);
    }
    const { address, symbol, weightBps } = entry as { address?: unknown; symbol?: unknown; weightBps?: unknown };
    if (typeof weightBps !== 'number' || !Number.isInteger(weightBps)) {
      throw new Error(`allocation.assets[${index}].weightBps 不是整數（收到 ${JSON.stringify(weightBps)}）`);
    }
    const asset = asAddress(address, `allocation.assets[${index}].address`);
    const stored = typeof symbol === 'string' && symbol.trim() !== '' ? symbol : null;
    return {
      asset,
      weightBps,
      symbol: symbolByAddress.get(asset.toLowerCase()) ?? stored ?? shortAddress(asset),
    };
  });
}

async function loadPortfolioContext(
  query: QueryFn,
  portfolioId: number,
  chainId: number,
): Promise<{ strategyId: number; onchainStrategyId: number | null; account: Address }> {
  const result = await query(SQL_PORTFOLIO, [portfolioId, chainId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`portfolio ${portfolioId} 在 chain ${chainId} 上沒有 smart account，索引器無從讀取持倉`);
  }
  const typed = row as { strategy_id?: unknown; onchain_id?: unknown; address?: unknown };
  return {
    strategyId: toInteger(typed.strategy_id, 'portfolios.strategy_id'),
    onchainStrategyId: typed.onchain_id === null || typed.onchain_id === undefined ? null : toInteger(typed.onchain_id, 'strategies.onchain_id'),
    account: asAddress(typed.address, 'smart_accounts.address'),
  };
}

/**
 * `priceable_assets` → **查價表**：這個地址的價格怎麼查（有沒有池、是不是 numeraire、ticker 叫什麼）。
 *
 * 它**不再是**「要讀哪些資產」的來源。讀哪些資產由策略的 `version.assets` 決定，見 `planPortfolio`：
 * 執行器只允許換 `version.assets` 裡的代幣（`AtpExecutor.sol:180-182`），策略外的代幣賣不掉，
 * 所以它不可能參與再平衡，也就不該進漂移的分母。
 *
 * `is_numeraire` 一定是 boolean 才算數：這一欄決定「要不要去問池子」，猜錯或預設成 false 會讓 USDT
 * 退回「無價」，於是持有 USDT 的帳戶又開始拒算漂移——一個看起來很安全、實際上讓索引器失效的狀態。
 */
async function loadPriceTable(query: QueryFn): Promise<Map<string, PriceableAsset>> {
  const result = await query(SQL_TOKENS);
  const table = new Map<string, PriceableAsset>();
  result.rows.forEach((row, index) => {
    const typed = row as { address?: unknown; symbol?: unknown; usdt_pool?: unknown; is_numeraire?: unknown };
    if (typeof typed.symbol !== 'string' || typed.symbol === '') {
      throw new Error(`priceable_assets 第 ${index} 列沒有 symbol`);
    }
    if (typeof typed.is_numeraire !== 'boolean') {
      throw new Error(
        `priceable_assets 第 ${index} 列（${typed.symbol}）的 is_numeraire 不是 boolean：` +
          `收到 ${JSON.stringify(typed.is_numeraire)}，這一欄決定要不要去問池子，不能猜`,
      );
    }
    const asset: PriceableAsset = {
      address: asAddress(typed.address, 'priceable_assets.address'),
      symbol: typed.symbol,
      usdtPool:
        typed.usdt_pool === null || typed.usdt_pool === undefined
          ? null
          : asAddress(typed.usdt_pool, 'priceable_assets.usdt_pool'),
      isNumeraire: typed.is_numeraire,
    };
    if (table.has(asset.address)) {
      throw new Error(`priceable_assets 有兩列同一個地址 ${asset.address}：同一個資產不能有兩種定價來源`);
    }
    table.set(asset.address, asset);
  });
  return table;
}

function defaultPublicClient(): PublicClient {
  const { rpcUrl } = getConfig();
  if (!rpcUrl) throw new Error('chain 未設定：RPC_URL 是讀持倉與 enrollment 的必要條件');
  return createPublicClient({ chain: activeChain(), transport: http(rpcUrl) });
}

/**
 * 算出一個 portfolio 的持倉、目標與漂移，不寫快照。
 *
 * 唯一的例外是 `holdings-scan.ts` 的掃描游標（`portfolio_scan_cursors`）：那是**觀測證據**，不是
 * 排程決策——看過就是看過了，與這一輪要不要寫快照無關，所以它跟著觀測一起落地（`--write` 與純唯讀
 * 兩條路都會推進它）。`portfolio_snapshots`／`positions_snapshots` 仍然只有 `writeSnapshot` 會寫。
 *
 * 順序刻意是「先讀 DB 的 portfolio → 再讀鏈上的 enrollment → 用 enrollment.version 查 DB 的
 * allocation」：版本號只有鏈上那一份是權威的，DB 的 `portfolios.version` 是入學當下的鏡像，
 * 兩者分岔時以鏈上為準（而且分岔正好會被 `allocationCheck` 抓到）。
 */
export async function planPortfolio(portfolioId: number, deps: PlanDeps = {}): Promise<PortfolioPlan> {
  const query = deps.query ?? dbQuery;
  const client = deps.publicClient ?? defaultPublicClient();
  // 逐項 `??` 而不是先呼叫 getConfig()：全注入的單元測試就完全不必有 DATABASE_URL。
  const chainId = deps.chainId ?? getConfig().chainId;
  const registryAddress = deps.registryAddress ?? (getConfig().registryAddress as Address | null);
  if (!registryAddress) throw new Error('chain 未設定：REGISTRY_ADDRESS 是讀 enrollment 的必要條件');
  const thresholdBps = deps.thresholdBps ?? DEFAULT_THRESHOLD_BPS;
  // 一次觀測 = 一個塊。塊高在這裡先定下來，之後 registry 的 enrollment/version、持倉餘額、池子的
  // slot0/observe 全部釘在這個塊上。少釘任何一個，「同一份觀測」就不成立：餘額是 block N、價格是
  // head，同一塊重跑得到不同價格——一個看起來正常、其實每次都不一樣的漂移數字。
  const block = deps.block ?? (await client.getBlockNumber());

  const { strategyId, onchainStrategyId, account } = await loadPortfolioContext(query, portfolioId, chainId);
  if (onchainStrategyId === null) {
    throw new Error(`strategy ${strategyId} 沒有 onchain_id：它還沒鏡像到鏈上，索引器沒有目標權重可對齊`);
  }

  const enrollment = await client.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'enrollments',
    args: [account],
    blockNumber: block,
  });
  const enrolledStrategyId = toInteger(enrollment[0].toString(), 'enrollment.strategyId');
  const pinned = toInteger(enrollment[1], 'enrollment.version');
  if (enrolledStrategyId === 0) {
    throw new Error(`${account} 在 registry 上沒有 enroll 紀錄（enrollments 全為 0）`);
  }
  if (pinned === 0) {
    // 0 會讓 version(id, 0) 解析成 active version：那正是「用錯版本」的入口，不能放行。
    throw new Error(`${account} 的 enrollment.version 是 0：這個帳戶沒有釘住任何版本，拒絕用 active version 猜`);
  }
  if (enrolledStrategyId !== onchainStrategyId) {
    throw new Error(
      `帳戶 ${account} 鏈上 enroll 的是 strategy ${enrolledStrategyId}，但 DB 的 strategy ${strategyId} ` +
        `對應到 onchain_id ${onchainStrategyId}：兩邊不是同一個策略，目標權重無從判斷`,
    );
  }

  const allocationRow = (await query(SQL_ALLOCATION, [strategyId, pinned])).rows[0];
  if (allocationRow === undefined) {
    throw new Error(`DB 沒有 strategy_versions(${strategyId}, ${pinned})：鏈上釘住的版本還沒鏡像到 off-chain`);
  }
  // 先讀 priceable_assets：targets 的 symbol 以它為權威（見 `parseAllocation` 的註解）。
  // 這一次查詢本來就會發生（後面定價要用），提前到這裡只是把同一個結果用在兩處。
  const priceTableForSymbols = await loadPriceTable(query);
  const symbolByAddress = new Map(
    [...priceTableForSymbols.entries()].map(([address, asset]) => [address.toLowerCase(), asset.symbol]),
  );
  const targets = parseAllocation(
    (allocationRow as { allocation?: unknown }).allocation,
    strategyId,
    pinned,
    symbolByAddress,
  );

  const onchainVersion = await client.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'version',
    args: [BigInt(enrolledStrategyId), pinned],
    blockNumber: block,
  });
  const chainTargets: TargetWeight[] = onchainVersion.assets.map((asset, index) => ({
    asset: asset.toLowerCase(),
    weightBps: toInteger(onchainVersion.weightsBps[index], `registry.version().weightsBps[${index}]`),
  }));
  const mismatches: string[] = [];
  if (chainTargets.length !== targets.length) {
    mismatches.push(`資產個數不同：DB ${targets.length} 個、鏈上 ${chainTargets.length} 個`);
  }
  for (let index = 0; index < Math.max(targets.length, chainTargets.length); index += 1) {
    const fromDb = targets[index];
    const fromChain = chainTargets[index];
    if (fromDb === undefined || fromChain === undefined) {
      mismatches.push(`第 ${index} 筆只有一邊有：DB ${fromDb?.asset ?? '—'}、鏈上 ${fromChain?.asset ?? '—'}`);
      continue;
    }
    if (fromDb.asset !== fromChain.asset || fromDb.weightBps !== fromChain.weightBps) {
      mismatches.push(
        `第 ${index} 筆不同：DB ${fromDb.asset} ${fromDb.weightBps}bps、鏈上 ${fromChain.asset} ${fromChain.weightBps}bps`,
      );
    }
  }
  const allocationCheck: AllocationCheck = { consistent: mismatches.length === 0, chain: chainTargets, mismatches };

  // 讀取與定價的宇宙 == 這個策略的 `version.assets`（鏈上 `registry.version()`；DB 的 allocation
  // 靠 `allocationCheck` 對照）。**不是** `priceable_assets` 全表：
  //
  //   ① 執行器只允許換 `version.assets` 裡的代幣（AtpExecutor.sol:180-182 的 isAssetAllowed），
  //      所以策略外的代幣（空投、使用者亂轉）**賣不掉**；
  //   ② 賣不掉的東西不可能參與再平衡 ⇒ 它不該進漂移的分母；
  //   ③ 把它讀進來、再因為「沒有價格」擋下漂移，就是把「無法執行的東西」當成「必須處理的東西」，
  //      於是一個完全在目標上的投組會被一顆空投搞到停止再平衡。
  //
  // 查價表只用來回答「這個地址的價格怎麼查」。策略資產不在查價表裡 = 沒有定價來源，仍然照讀餘額，
  // 但一持有就擋下漂移（`UNPRICED_HOLDINGS`）：我們不知道策略成分值多少，就算不出權重——那是真問題。
  const priceTable = await loadPriceTable(query);
  const symbolsByAsset = new Map(targets.map((target) => [target.asset, target.symbol]));
  const universe: PriceableAsset[] = chainTargets.map((target) => {
    const known = priceTable.get(target.asset);
    if (known !== undefined) return known;
    return {
      address: target.asset as Address,
      symbol: symbolsByAsset.get(target.asset) ?? shortAddress(target.asset),
      usdtPool: null,
      isNumeraire: false,
    };
  });

  // numeraire **一律**納入讀取範圍，即使它不在配置裡。
  //
  // 為什麼：`universe` 原本只由策略成分組成，於是「沒有現金腿」的配置（例如
  // TSLA 35 / SPCX 35 / BTC 15 / DOGE 10 / ETH 5 = 100%）完全看不到 USDT 餘額。
  // 後果是一個死結：使用者剛存進來的 USDT 不被算進總值 → 規劃器認為「投組價值 0，沒東西可搬」
  // → 一輪都不跑 → 那筆錢永遠停在現金。實測（主網首次存款 5 USDT）就是這樣。
  //
  // numeraire 是**出資貨幣**：任何一輪的第一筆動作都是「用 USDT 買標的」，
  // 所以它的餘額永遠是規劃的輸入，不管權重表裡有沒有它。
  const numeraire = [...priceTable.values()].find((asset) => asset.isNumeraire);
  if (
    numeraire !== undefined &&
    !universe.some((asset) => asset.address.toLowerCase() === numeraire.address.toLowerCase())
  ) {
    universe.push(numeraire);
  }

  // 這裡是整個檔案唯一「決定塊高」的兩份觀測，而且兩份都吃上面那個 `block`：
  //   ① `readPositions`：宇宙內的餘額與價格；
  //   ② `scanPortfolioHoldings`：宇宙**外**的轉入日誌（`head: block` ⇒ 它的 getLogs 到塊與候選
  //      `balanceOf` 的塊都是 `block`）。
  // 兩者同塊不是風格問題：掃描到 N+5 而餘額讀 N，一筆在 N+1 進來的代幣會被算成「未知持倉」、
  // 餘額卻是 0；反過來（掃描停在 N、餘額讀 N+5）整筆轉入永遠不會被發現。任何一邊自己讀 head，
  // 「同一份觀測」就不成立。
  // 兩者互不相依，所以並行；`scanPortfolioHoldings` 成功時會自己推進游標（那是觀測證據，不是排程
  // 決策），漂移與快照仍然只有 `writeSnapshot` 會寫——那是本函式「不寫任何東西」的唯一例外。
  const [snapshot, scan] = await Promise.all([
    readPositions(client, {
      portfolioId,
      account,
      tokens: universe,
      // 分母來自**查價表**而不是 `universe`：策略資產裡沒有 USDT 時（例如純 {WBNB, NVDAB}），
      // 報價仍然要除以 USDT。少了這一欄，那種策略一持有有池資產就會拋錯。
      quoteTable: [...priceTable.values()],
      block,
      priceToken: deps.priceToken,
    }),
    scanPortfolioHoldings({
      client,
      query,
      portfolioId,
      account,
      // 掃描要扣掉的「已知宇宙」就是策略資產：其餘有餘額的代幣都是策略外持倉（觀測訊號，不擋漂移）。
      knownTokens: universe.map((token) => token.address),
      head: block,
    }),
  ]);

  const blocked: PlanBlock[] = [];
  const heldUnpriced = snapshot.unpriced.filter((asset) => asset.amountWei > 0n);
  if (heldUnpriced.length > 0) {
    blocked.push({
      code: 'UNPRICED_HOLDINGS',
      detail:
        '持有但沒有價格，拒絕算漂移（把無價資產當 0 會讓其他資產權重集體偏高）：' +
        heldUnpriced.map((asset) => `${asset.symbol} ${asset.reason}`).join('、'),
    });
  }
  if (!allocationCheck.consistent) {
    blocked.push({
      code: 'ALLOCATION_MISMATCH',
      detail: `DB 的 allocation 與鏈上 registry.version() 不一致：${mismatches.join('；')}`,
    });
  }
  // 策略外持倉（空投、使用者自己轉進來的代幣）**刻意不在這裡**：
  // 執行器換不掉它（AtpExecutor.sol:180-182），它不可能被再平衡，也就不在漂移的分母裡。
  // 它仍然被掃描、仍然寫進表頭的 `unknown_token_count` / `universe_complete`（運維要看），
  // 但漂移照算、`complete` 只回答「策略資產是否都有價」。

  return {
    portfolioId,
    strategyId,
    account,
    chainId,
    snapshot,
    scan,
    report: blocked.length === 0 ? computeDrift(snapshot.holdings, targets, thresholdBps) : null,
    blocked,
    targets,
    pinnedVersion: { version: pinned, onchainStrategyId: enrolledStrategyId, paused: enrollment[2] },
    allocationCheck,
    thresholdBps,
  };
}

// ---------------------------------------------------------------------------
// 寫入
// ---------------------------------------------------------------------------

/** numeric(38,18) 的字串形式；pg 的 numeric 參數一律用字串傳，避免經過 Number。 */
function formatNumeric18(scaled: bigint): string {
  if (scaled < 0n) throw new RangeError('numeric(38,18) 欄位不接受負值');
  const whole = scaled / E18;
  const fraction = (scaled % E18).toString().padStart(18, '0');
  return `${whole}.${fraction}`;
}

/**
 * 代幣最小單位 → 顆數（numeric(38,18)）。
 * decimals <= 18 時是精確的；> 18 才截斷，但欄位本身只存得到 1e-18 顆，截斷是欄位的極限不是這裡的選擇。
 */
function tokenAmountTo18(amountWei: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError(`decimals 必須是非負整數（收到 ${decimals}）`);
  return decimals >= 18 ? amountWei * 10n ** BigInt(decimals - 18) : amountWei / 10n ** BigInt(18 - decimals);
}

/** 與 drift.ts 的算式逐位相同（整數除法、截斷）：快照寫進去的值必須重算出同一個 total。 */
function usdValueE8(holding: Holding): bigint {
  return (holding.amountWei * holding.usdPriceE8) / 10n ** BigInt(holding.decimals);
}

type SnapshotRow = {
  asset: string;
  amount: string;
  usdValue: string | null;
  priceSource: string | null;
  pricedAt: Date | null;
};

export type WriteSnapshotDeps = {
  query?: QueryFn;
  /** 報價的觀測時間；一次寫入共用一個時間戳，測試可以釘死。 */
  pricedAt?: Date;
  /**
   * 這一輪用的再平衡門檻。`report` 有值時以 `report.thresholdBps` 為準；拒算（report = null）時
   * 才用這個值——表頭的 `threshold_bps` 是 NOT NULL，而「這一輪用什麼門檻判定」本身就是事後要還原的資訊。
   */
  thresholdBps?: number;
  /** 鏈上 `enrollment.version`。表頭允許 NULL，但排程器一律會給（那是漂移的對齊依據）。 */
  pinnedVersion?: number | null;
  /**
   * 這張快照是哪一個時點：`manual`（CLI 手動 index）| `before`（送出前）| `after`（落地後）。
   * 預設 `manual` —— 既有呼叫端不必改就能繼續運作。
   */
  phase?: 'manual' | 'before' | 'after';
  /**
   * 對應的 `operations.id`。`before` / `after` 共用同一個值，所以「這一輪做了什麼」＝ 兩張的差。
   * 手動 index 沒有 operation，留 null。
   */
  operationId?: number | bigint | null;
  /**
   * 這一輪的持有掃描（`planPortfolio` 的 `scan`）。表頭的 `unknown_token_count` 與
   * `universe_complete` 從這裡來：兩者都是**觀測訊號**，都不影響 `complete`
   * （`complete` 只回答「策略資產是否都有價」）。
   *
   * 省略 = 這一輪沒有掃描：`unknown_token_count` 寫 0、`universe_complete` 寫 **false**。
   * false 是刻意選的那一邊——「沒確認過宇宙完整」是誠實的，而 0 也不宣稱看過任何代幣。
   */
  scan?: HoldingScanResult;
};

export type WriteSnapshotResult = {
  /** 表頭是這次新增（true）還是同一個 block 的 UPDATE（false）。 */
  headerInserted: boolean;
  /** 明細列的新增／更新列數。空倉時兩者都是 0，但**表頭仍然有一列**。 */
  inserted: number;
  updated: number;
};

/**
 * 表頭的 insert ... on conflict：同一個 block 重跑是 UPDATE（它是同一份觀測，不是第二份快照），
 * 所以列數不會長大，也不會出現「同一個 block 兩個總額」。`created_at` 刻意不在 do update 裡：
 * 它記的是這一份觀測第一次寫進來的時間。
 */
const SQL_HEADER_UPSERT = `
  insert into portfolio_snapshots (
    portfolio_id, block, native_balance_wei, total_usd_e8, gross_drift_bps, max_abs_delta_bps,
    threshold_bps, needs_rebalance, complete, unpriced_count, pinned_version,
    unknown_token_count, universe_complete, phase, operation_id
  )
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  on conflict (portfolio_id, block, phase) do update
    set native_balance_wei = excluded.native_balance_wei,
        total_usd_e8       = excluded.total_usd_e8,
        gross_drift_bps    = excluded.gross_drift_bps,
        max_abs_delta_bps  = excluded.max_abs_delta_bps,
        threshold_bps      = excluded.threshold_bps,
        needs_rebalance    = excluded.needs_rebalance,
        complete           = excluded.complete,
        unpriced_count     = excluded.unpriced_count,
        pinned_version     = excluded.pinned_version,
        unknown_token_count = excluded.unknown_token_count,
        universe_complete   = excluded.universe_complete,
        operation_id        = coalesce(excluded.operation_id, portfolio_snapshots.operation_id)`;

/** 表頭吃掉 $1..$15（含 phase 與 operation_id），明細列從 $16 開始。 */
const HEADER_PARAM_COUNT = 15;

/** pg 對 `count(*)::int` 回 number、對 bigint 回字串；一律收成非負整數，收不到就拋錯而不是回 0。 */
function toCount(value: unknown, what: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`寫入結果的 ${what} 不是非負整數（收到 ${JSON.stringify(value)}）`);
  }
  return parsed;
}

/** 表頭那一列是 INSERT 還是 UPDATE。`xmax = 0` 是 PG 的既有語意，不是額外查詢猜出來的。 */
function headerInsertedOf(rows: readonly unknown[]): boolean {
  const inserted = (rows[0] as { inserted?: unknown } | undefined)?.inserted;
  if (typeof inserted !== 'boolean') {
    throw new Error(`portfolio_snapshots 的寫入沒有回傳 inserted（收到 ${JSON.stringify(inserted)}）`);
  }
  return inserted;
}

/**
 * 寫入一份快照：**表頭 + 明細**，`insert ... on conflict do update`。
 *
 * ① 表頭（`portfolio_snapshots`）每一輪都寫，空倉也寫。明細在空倉時一列都沒有，於是「跑過、確認
 *    帳戶是空的」與「索引器沒跑」在下游長得一模一樣；表頭就是那個永遠存在的東西。`complete`
 *    記下這一輪的漂移可不可信（false = 拒算），判讀前必須先看它。`universe_complete` 與
 *    `unknown_token_count`（來自 `deps.scan`）是**觀測訊號**，不改變 `complete` 的定義：
 *    掃描有沒有覆蓋帳戶歷史，與「策略資產是否都有價」是兩個問題。
 *
 * ② 表頭與明細**同一個 statement**（表頭是 data-modifying CTE，明細讀它）。這就是「同一個交易」：
 *    單一 statement 本來就在一個隱式交易裡，任一處失敗整筆回滾。刻意**不**用 `BEGIN`／`COMMIT`
 *    包兩次查詢——`QueryFn` 是連線池層級的查詢，兩次查詢可能落在不同連線上，那比沒有交易更糟。
 *
 * ③ 明細列從 `snapshot` 來（金額），有價列的 `usd_value` 由 `holdings[].amountWei × usdPriceE8`
 *    算出來，並**對照 `report.totalUsdE8` 驗一次**：寫進 DB 的列必須能重算出報告用的那個總額，
 *    否則快照與報告就是兩份不同的世界。`price_source` 逐列來自 `holding.priceSource`
 *    （`numeraire` 或 `pancakeswap-v3`）：把 numeraire 寫成 pool 報價就是記錯出處。
 *
 * ④ 無價資產（`amountWei > 0`）寫成 `usd_value/price_source/priced_at` 全 NULL 的列——那不是漏寫，
 *    是 `positions_snapshots_price_provenance` 要求的「未定價」狀態，也是設計 (a) 在資料層的標記：
 *    之後任何人拿這批列去 `parseSnapshotRows` 都會撞到「有 amount 沒有價格就拋錯」。
 *    0 餘額的無價資產**不寫**：它對價值的貢獻精確為 0，寫一列 NULL 只會讓一份其實完整的快照
 *    看起來不完整（見 positions.ts 對 0 餘額的處理）。
 *
 * `report` 用在 ③ 的一致性檢查與表頭的漂移欄位，所以拒算（report = null）時照樣寫得出來，
 * 只是表頭 `complete = false` 且漂移欄位一律 0（0008 的 CHECK 綁住這一點）。
 */
export async function writeSnapshot(
  snapshot: PositionSnapshot,
  report: DriftReport | null,
  deps: WriteSnapshotDeps = {},
): Promise<WriteSnapshotResult> {
  const query = deps.query ?? dbQuery;
  const pricedAt = deps.pricedAt ?? new Date();
  const pinnedVersion = deps.pinnedVersion ?? null;
  const phase = deps.phase ?? 'manual';
  if (phase !== 'manual' && phase !== 'before' && phase !== 'after') {
    throw new RangeError(`phase 必須是 manual / before / after（收到 ${String(phase)}）`);
  }
  if (pinnedVersion !== null && (!Number.isInteger(pinnedVersion) || pinnedVersion < 1)) {
    throw new RangeError(`pinnedVersion 必須是 >= 1 的整數或 null（收到 ${String(pinnedVersion)}）`);
  }

  const rows: SnapshotRow[] = [];
  const seen = new Set<string>();
  let pricedTotal = 0n;
  for (const holding of snapshot.holdings) {
    if (holding.amountWei === 0n) continue;
    const valueE8 = usdValueE8(holding);
    pricedTotal += valueE8;
    rows.push({
      asset: holding.asset,
      amount: formatNumeric18(tokenAmountTo18(holding.amountWei, holding.decimals)),
      usdValue: formatNumeric18(valueE8 * E8_TO_E18),
      priceSource: holding.priceSource,
      pricedAt,
    });
    seen.add(holding.asset);
  }
  for (const asset of snapshot.unpriced) {
    if (asset.amountWei === 0n) continue;
    if (seen.has(asset.asset)) {
      throw new Error(`快照同時把 ${asset.asset} 標成有價與無價：這是呼叫端的 bug，不是資料問題`);
    }
    seen.add(asset.asset);
    rows.push({
      asset: asset.asset,
      amount: formatNumeric18(tokenAmountTo18(asset.amountWei, asset.decimals)),
      usdValue: null,
      priceSource: null,
      pricedAt: null,
    });
  }

  if (report !== null && pricedTotal !== report.totalUsdE8) {
    throw new Error(
      `快照能重算的總額 ${pricedTotal}（E8）與報告的 totalUsdE8 ${report.totalUsdE8} 不同：` +
        '這份快照不是報告的那一份，拒絕寫入掩蓋它',
    );
  }

  const complete = report !== null;
  const thresholdBps = report?.thresholdBps ?? deps.thresholdBps ?? DEFAULT_THRESHOLD_BPS;
  if (!Number.isInteger(thresholdBps) || thresholdBps < 0 || thresholdBps > 10_000) {
    throw new RangeError(`thresholdBps 必須是 0..10000 的整數（收到 ${String(thresholdBps)}）`);
  }
  const headerParams: unknown[] = [
    String(snapshot.portfolioId),
    snapshot.block.toString(),
    snapshot.nativeBalanceWei.toString(),
    // 拒算時這是「已定價部位的部分總額」，不是投組總值；完整的說明在 0008 的 COMMENT。
    (report?.totalUsdE8 ?? pricedTotal).toString(),
    report?.grossDriftBps ?? 0,
    report?.maxAbsDeltaBps ?? 0,
    thresholdBps,
    report?.needsRebalance ?? false,
    complete,
    // 只有「持有但無價」會擋下漂移，所以 0 餘額的無價標的不計入：那是資料缺口，不是這一輪的 blocker。
    snapshot.unpriced.filter((asset) => asset.amountWei > 0n).length,
    pinnedVersion,
    // 策略外持倉的顆數：**觀測訊號**，不影響 `complete`。它賣不掉（AtpExecutor.sol:180-182），
    // 所以不在漂移的分母裡；運維仍然要看得到「這帳戶收到過什麼」。
    deps.scan?.unknownHoldings.length ?? 0,
    deps.scan?.universeComplete ?? false,
    phase,
    deps.operationId === undefined || deps.operationId === null ? null : String(deps.operationId),
  ];

  if (rows.length === 0) {
    // 空倉：只有表頭。這一列本身就是「跑過而且帳戶是空的」的證據（明細 0 列）。
    const headerOnly = await query(`${SQL_HEADER_UPSERT}
      returning (xmax = 0) as inserted`, headerParams);
    return { headerInserted: headerInsertedOf(headerOnly.rows), inserted: 0, updated: 0 };
  }

  const params: unknown[] = [...headerParams];
  const tuples = rows.map((row, index) => {
    const base = HEADER_PARAM_COUNT + index * 5;
    params.push(row.asset, row.amount, row.usdValue, row.priceSource, row.pricedAt);
    // $1 = portfolio_id、$14 = phase（表頭與明細共用這兩個參數），其餘逐列。
    // phase 共用是刻意的：明細的 phase 與它所屬的表頭不一致時，兩張快照的差額會算錯而沒人發現。
    return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $2, $14)`;
  });

  const result = await query(
    `with header as (
       ${SQL_HEADER_UPSERT}
       returning (xmax = 0) as inserted
     ),
     detail as (
       insert into positions_snapshots (portfolio_id, asset, amount, usd_value, price_source, priced_at, block, phase)
       values ${tuples.join(', ')}
       on conflict (portfolio_id, asset, block, phase) do update
         set amount = excluded.amount,
             usd_value = excluded.usd_value,
             price_source = excluded.price_source,
             priced_at = excluded.priced_at,
             ts = now()
       returning (xmax = 0) as inserted
     )
     select coalesce((select bool_or(inserted) from header), false) as header_inserted,
            (select count(*)::int from detail where inserted)     as inserted,
            (select count(*)::int from detail where not inserted) as updated`,
    params,
  );

  const summary = (result.rows[0] ?? {}) as { header_inserted?: unknown; inserted?: unknown; updated?: unknown };
  return {
    headerInserted: summary.header_inserted === true,
    inserted: toCount(summary.inserted, 'inserted'),
    updated: toCount(summary.updated, 'updated'),
  };
}

/** 1e8 定點 → 人看得懂的字串（價格與 USD 金額共用），給 CLI 用。 */
export function formatE8(valueE8: bigint): string {
  const whole = valueE8 / E8;
  const fraction = (valueE8 % E8).toString().padStart(8, '0');
  return `${whole}.${fraction}`;
}
