import { decodeFunctionResult, encodeFunctionData } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import type { Holding } from './drift.js';
import { PricingError, twapPriceInUsdt } from './pricing.js';

/**
 * 讀真實持倉：鏈上餘額 → 一條一條定價 → 交給 drift.ts 算漂移。
 *
 * 這支檔案只回答「這個 smart account 現在有什麼、值多少」，不讀 DB、不寫 DB、不看時鐘
 * （block 由呼叫端給，沒給才自己讀 head）。漂移的定義在 drift.ts，定價的定義在 pricing.ts，
 * 這裡只負責把兩邊接起來，以及把「接不起來的地方」講清楚。
 *
 * 幾個刻意的決定，錯了會靜默污染整份報告：
 *
 * 1. **native BNB 不是投資部位。** smart account 持有 BNB 只是為了付 gas。若把它算進持倉，
 *    每個帳戶都會看起來「嚴重超配 BNB」，漂移永遠超標、再平衡永遠被觸發。所以 native 餘額
 *    用 `nativeBalanceWei` 單獨回傳，`holdings` 裡沒有它。策略目標若含 WBNB，那是 ERC-20 的
 *    `balanceOf(WBNB)`，跟 native BNB 是兩個不同的資產，照常讀、照常定價。
 *
 * 2. **無價資產不進 `holdings`，進 `unpriced`。** 沒把 usdt_pool 查出來、或報價失敗的資產，
 *    不能當成 0 也不能丟掉：當成 0 會讓它的權重憑空消失（漂移看起來正常但其實算錯），丟掉也一樣。
 *    這裡保留它的 `amountWei` 與 `reason`，由呼叫端決定怎麼處理（snapshot.ts 的規則是「持有的
 *    無價資產 → 整份拒算漂移」，見 `snapshot.ts`）。
 *
 * 0 餘額的處理：不進 `holdings`（`Holding` 需要 `usdPriceE8`，而「沒持有」不需要價格；而且
 * 0 對 total 與 currentBps 的貢獻精確為 0，所以排除它在數值上完全等價），也不為它呼叫定價
 * （一個沒持有的資產付 7 次 RPC 換一個用不到的數字，還多一個失敗模式）。目標有、沒持有的資產
 * 仍然會出現在漂移報告裡——那是由 `targets` 驅動的，不是由 holdings 驅動的。
 * 無池的資產則**一律**列進 `unpriced`（含 0 餘額）：那是查價表上的靜態事實，查都不用查，
 * 寫出來就是「這些標的沒有價格來源」的資料缺口訊號。
 *
 * 3. **三種定價來源收在 `priceFor` 一個地方（numeraire / TWAP / 無價）。** 報價單位本身
 *    （USDT：1 顆永遠 = 1e8）不能去問池子：那條路徑上唯一的「池」是 USDT/WBNB，解出來的是
 *    「1 USDT 值多少 WBNB」，不是 1。分散成幾個 if 的話，遲早有一處漏掉而把 numeraire 丟進
 *    `unpriced`——那會讓「帳戶持有 USDT」變成「拒算漂移」，索引器對這個策略就整個失效。
 *
 * 4. **讀哪些資產由呼叫端決定，這支檔案不自己挑。** 呼叫端傳進來的 `tokens` 就是策略的
 *    `version.assets`（見 `ReadPositionsArgs.tokens` 的說明）；`priceable_assets` 在這裡只是
 *    「這個地址的價格怎麼查」的查價表，不是「要讀哪些資產」的來源。兩者混在一起正是那個
 *    「被空投一顆雜幣就停止再平衡」的錯語意。
 */

/** priceable_assets 的一列裡 readPositions 用得到的欄位。呼叫端只該傳 `enabled = true` 的列。 */
export type PriceableAsset = {
  /** 小寫 0x + 40 hex，直接當成漂移報告的 asset key（drift.ts 的 key 比對大小寫）。 */
  address: Address;
  /** 顯示用 ticker（NVDAB、TSLAB、USDT…），只出現在訊息與 CLI 摘要裡。 */
  symbol: string;
  /** 對 USDT 的 PancakeSwap V3 池；null = 這顆沒有池（numeraire 不需要，其餘無法報價）。 */
  usdtPool: Address | null;
  /** true = 報價單位本身（USDT）：價格是定義，不是報價。這種資產不該有池，見 0007 的約束。 */
  isNumeraire: boolean;
};

/** 1 顆 numeraire（USDT）的價格，1e8 定點。這是**定義**，不是查出來的數字。 */
export const NUMERAIRE_PRICE_E8 = 100_000_000n;

/** `positions_snapshots.price_source` 的值：一筆 USD 值要能追回它是怎麼來的（見 0005）。 */
export const TWAP_PRICE_SOURCE = 'pancakeswap-v3';
export const NUMERAIRE_PRICE_SOURCE = 'numeraire';
export type PriceSource = typeof TWAP_PRICE_SOURCE | typeof NUMERAIRE_PRICE_SOURCE;

/** 一個資產的價格從哪裡來。三種情況，沒有第四種。 */
export type AssetPrice =
  | { kind: 'numeraire'; priceE8: bigint }
  | { kind: 'twap'; usdtPool: Address }
  | { kind: 'unpriced'; reason: 'no_usdt_pool' };

/**
 * 把「哪來的價格」這件事收成一個純函式，`readPositions` 只消費它的結果。
 *
 * 順序是刻意的：先看 numeraire 再看池。numeraire 就算（錯誤地）帶著池，價格仍然是 1e8——
 * 那是定義；而 0007 的 `priceable_assets_numeraire_has_no_pool` 已經讓那種列進不了 DB。
 */
export function priceFor(asset: PriceableAsset): AssetPrice {
  if (asset.isNumeraire) return { kind: 'numeraire', priceE8: NUMERAIRE_PRICE_E8 };
  const pool = asset.usdtPool;
  if (pool === null) return { kind: 'unpriced', reason: 'no_usdt_pool' };
  return { kind: 'twap', usdtPool: pool };
}

/** 持有的資產但沒有可用價格。`amountWei` 與 `decimals` 一起帶，呼叫端才寫得出快照列。 */
export type UnpricedAsset = {
  /** 小寫地址。 */
  asset: string;
  symbol: string;
  amountWei: bigint;
  decimals: number;
  /** `no_usdt_pool`（查價表沒填池）或 `pricing_failed:<PricingErrorCode>`（有池但報價失敗）。 */
  reason: string;
};

/** 有價持倉 + 它的價格出處（寫進 `positions_snapshots.price_source`）。 */
export type PricedHolding = Holding & { priceSource: PriceSource };

export type PositionSnapshot = {
  portfolioId: number;
  /** 這次讀取的塊高；`holdings`／`nativeBalanceWei` 都是在這個塊上讀的。 */
  block: bigint;
  /** 付 gas 用的 native BNB，**不是**投資部位，刻意不在 holdings 裡。 */
  nativeBalanceWei: bigint;
  /**
   * 有價且餘額非零的持倉。比 drift.ts 的 `Holding` 多帶 `priceSource`：`positions_snapshots`
   * 要記錄每一筆 USD 值的出處（0005），而 numeraire 與 TWAP 是兩種不同的出處。
   */
  holdings: PricedHolding[];
  /** 沒有可用價格的資產（含 0 餘額）。 */
  unpriced: UnpricedAsset[];
};

/** 定價的注入點：預設 `twapPriceInUsdt`，測試可換成 stub（單元測試就不必假造 pool 的 observe）。 */
export type PriceTokenFn = (
  client: PublicClient,
  args: {
    token: Address;
    usdtPool: Address;
    /** 報價的分母：numeraire 的地址。驗證 pool 的另一邊就是它（見 pricing.ts 的 QUOTE_TOKEN_MISMATCH）。 */
    expectedQuoteToken: Address;
    /** 快照的塊高。定價必須與餘額讀同一個塊，否則同一份觀測不成立。 */
    blockNumber: bigint;
  },
) => Promise<{ priceE8: bigint; decimals: number }>;

/**
 * 報價的分母。它**只能有一個**，而且是資料不是猜測：地址來自 `priceable_assets` 的 `is_numeraire`。
 *
 * 沒有 numeraire 就不能報價——猜一個分母（例如「就拿池子的另一邊」）會生出一個數量級正確、幣別錯誤的
 * 價格，漂移於是被靜默算錯；有兩個 numeraire 同樣不行，那時分母取決於列的順序。
 */
function singleNumeraireOf(tokens: readonly PriceableAsset[]): Address {
  const numeraires = tokens.filter((token) => token.isNumeraire);
  const first = numeraires[0];
  if (first === undefined) {
    throw new Error(
      'priceable_assets 沒有任何 is_numeraire 的列：報價沒有分母，拒絕用池子的另一邊猜（那會讓漂移看起來合理但其實算錯）',
    );
  }
  const extra = numeraires.find((token) => token.address.toLowerCase() !== first.address.toLowerCase());
  if (extra !== undefined) {
    throw new Error(
      `priceable_assets 有兩個 numeraire（${first.symbol} ${first.address}、${extra.symbol} ${extra.address}）：` +
        '報價的分母只能有一個，否則價格取決於列的順序',
    );
  }
  return first.address;
}

export type ReadPositionsArgs = {
  portfolioId: number;
  account: Address;
  /**
   * 要讀、要定價的資產全集：**呼叫端決定**，而且只該是這個策略的 `version.assets`
   * （權威是鏈上 `registry.version(id, n).assets`）。
   *
   * 這裡刻意不接受「全站白名單」：`AtpExecutor.sol:180-182` 只允許換 `version.assets` 裡的代幣，
   * 策略外的代幣（空投、使用者亂轉）**賣不掉**，於是它不可能參與再平衡，也就不該進漂移的分母。
   * 把它讀進來只會讓「一顆雜幣」把一份完全在目標上的投組變成永遠偏離目標。
   *
   * 每一列的 `usdtPool` / `isNumeraire` 由呼叫端從 `priceable_assets`（查價表）補上；
   * 查價表沒有這一顆時，呼叫端要傳一列「沒有定價來源」的（`usdtPool: null`）——那會變成
   * `unpriced`，持有時擋下漂移。
   */
  tokens: readonly PriceableAsset[];
  /**
   * 報價分母（numeraire）的來源，通常是**整張** `priceable_assets`(enabled) 查價表。
   *
   * 分母是**定價的事實**，不是策略的成分：一個 {WBNB, NVDAB} 的策略裡沒有 USDT，但報價仍然要
   * 除以 USDT。省略 = 從 `tokens` 裡找（宇宙剛好含 numeraire 的呼叫端可以不管這一欄）。
   */
  quoteTable?: readonly PriceableAsset[];
  /**
   * 省略時讀 head。給了就**所有** eth_call 都釘在這個塊上（餘額、decimals，以及透傳給 `priceToken`
   * 的 getCode / token0 / token1 / slot0 / observe / decimals），讀到的狀態與快照標記的塊一致。
   */
  block?: bigint;
  priceToken?: PriceTokenFn;
  /** Multicall3 地址。預設 `MULTICALL3_ADDRESS`；測試與非標準鏈可以換掉。 */
  multicall3?: Address;
};

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

/**
 * Multicall3 的標準部署地址：同一組 deterministic deployment 遍布 BSC 與其他 EVM 鏈。
 *
 * 只放**預設值**：地址是 deps（`ReadPositionsArgs.multicall3`），因為「這條鏈上有沒有它」是環境事實，
 * 不是常數。實測（2026-11-07）：BSC mainnet 與 anvil fork（block 132141039）都有 code，
 * `cast code 0xcA11...` 回 7618 個 hex 字元。
 */
export const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * 只用到 `aggregate3`：它逐項帶 `allowFailure`，所以一顆代幣 revert 不會炸掉整批，
 * 而且回傳的 `success` 旗標讓呼叫端指得出**是哪一顆**失敗（`aggregate` 做不到這件事）。
 */
const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 把 PricingError 的分類收成一個穩定的字串；非 PricingError 也要留下痕跡，不能變成空字串。 */
function pricingFailureReason(cause: unknown): string {
  const code = cause instanceof PricingError ? cause.code : 'UNEXPECTED';
  return `pricing_failed:${code}`;
}

type TokenBalance = {
  token: PriceableAsset;
  amountWei: bigint;
  decimals: number;
};

/** Multicall3 的一項回傳。`success: false` 的 `returnData` 是 `0x`，解碼前必須先看旗標。 */
type Multicall3Result = { success: boolean; returnData: Hex };

/**
 * 一次 `aggregate3` 讀完所有代幣的 `balanceOf` 與 `decimals`（N 顆 = 2N 筆內層呼叫、1 次 eth_call）。
 *
 * 為什麼是 `allowFailure: true`：這是「一顆壞掉不該炸整批」與「哪一顆壞掉」兩件事的唯一交集。
 * 用 `aggregate` 的話任何一項 revert 就整批 revert，連失敗的是誰都問不出來；用 2N 次獨立 eth_call
 * 又回到 N 次往返。`allowFailure` 讓 Multicall3 逐項回 `success:false`，呼叫端就能把錯誤指名到地址。
 *
 * 讀不到就拋錯、不吞成 0：「這個地址不是 ERC-20」與「這個地址餘額是 0」是兩件事，混在一起會讓
 * 一個填錯的資產列看起來像一個空倉。錯誤訊息一定帶 symbol 與地址（是哪一顆），並說明是哪一個
 * 內層呼叫（balanceOf 或 decimals）失敗。
 */
async function readTokens(
  client: PublicClient,
  args: { account: Address; tokens: readonly PriceableAsset[]; block: bigint; multicall3: Address },
): Promise<TokenBalance[]> {
  if (args.tokens.length === 0) return [];

  const calls = args.tokens.flatMap((token) => [
    {
      target: token.address,
      allowFailure: true,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [args.account] }),
    },
    {
      target: token.address,
      allowFailure: true,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'decimals' }),
    },
  ]);

  let results: readonly Multicall3Result[];
  try {
    results = await client.readContract({
      address: args.multicall3,
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [calls],
      blockNumber: args.block,
    });
  } catch (cause) {
    // 這一層失敗是「整批都沒讀到」（鏈上沒有 Multicall3、節點拒絕 eth_call），
    // 與下面「某一顆的某一項失敗」是兩件事，訊息要分得出來。
    throw new Error(
      `Multicall3（${args.multicall3}）在塊 ${args.block} 的 aggregate3 失敗：` +
        `這條鏈可能沒有部署 Multicall3，或節點拒絕 eth_call（${reasonOf(cause)}）`,
      { cause },
    );
  }

  return args.tokens.map((token, index) => {
    const balance = results[index * 2];
    const decimals = results[index * 2 + 1];
    if (balance === undefined || decimals === undefined) {
      throw new Error(
        `Multicall3 只回傳 ${results.length} 筆，少於 ${args.tokens.length} 顆 × 2：` +
          `無法判斷哪一筆屬於 ${token.symbol}（${token.address}）`,
      );
    }
    // 兩種「沒讀到」都要指名到地址：
    //   ① `success: false`——內層呼叫 revert（allowFailure 把它接住了，沒有炸整批）；
    //   ② `success: true` 但 `returnData` 是 `0x`——地址上根本沒有合約。CALL 到空地址**不會** revert，
    //      所以這一種在 `success` 旗標上看不出來；漏掉它，錯誤會變成一句
    //      「Cannot decode zero data」而查不出是哪一顆（實測：Multicall3 對 0x…0001 就是這樣回）。
    const failed: string[] = [];
    if (!balance.success || balance.returnData === '0x') failed.push('balanceOf');
    if (!decimals.success || decimals.returnData === '0x') failed.push('decimals');
    if (failed.length > 0) {
      throw new Error(
        `讀不到 ${token.symbol}（${token.address}）在塊 ${args.block} 的 ${failed.join('/')}：` +
          `這個地址不是 ERC-20（沒有合約或呼叫 revert），或節點拒絕 eth_call` +
          `（aggregate3 success = ${balance.success}/${decimals.success}）`,
      );
    }
    try {
      return {
        token,
        amountWei: decodeFunctionResult({ abi: ERC20_ABI, functionName: 'balanceOf', data: balance.returnData }),
        decimals: decodeFunctionResult({ abi: ERC20_ABI, functionName: 'decimals', data: decimals.returnData }),
      };
    } catch (cause) {
      throw new Error(
        `解不出 ${token.symbol}（${token.address}）在塊 ${args.block} 的 balanceOf/decimals 回傳值：` +
          `這個地址不是 ERC-20（${reasonOf(cause)}）`,
        { cause },
      );
    }
  });
}

/**
 * 讀持倉並定價。回傳的 `holdings` 不含 native BNB、也不含 0 餘額與無價資產。
 *
 * `holdings` 的順序與 `tokens` 一致，`unpriced` 也一樣，方便人對照策略資產清單看。
 *
 * 定價來源全部由 `priceFor` 決定：numeraire（USDT）直接 1e8、不呼叫 `priceToken`；有池的走
 * `priceToken`（預設 `twapPriceInUsdt`）；無池的進 `unpriced`。
 */
export async function readPositions(
  client: PublicClient,
  args: ReadPositionsArgs,
): Promise<PositionSnapshot> {
  const seen = new Set<string>();
  for (const token of args.tokens) {
    const key = token.address.toLowerCase();
    if (seen.has(key)) throw new Error(`readPositions 收到重複的資產 ${key}：同一筆錢會被算兩次`);
    seen.add(key);
  }

  const block = args.block ?? (await client.getBlockNumber());
  const priceToken = args.priceToken ?? twapPriceInUsdt;

  const [nativeBalanceWei, balances] = await Promise.all([
    client.getBalance({ address: args.account, blockNumber: block }),
    // 1 次 eth_call（aggregate3，2N 筆內層呼叫）取代原本的 2N 次往返；失敗仍然指名到地址。
    readTokens(client, {
      account: args.account,
      tokens: args.tokens,
      block,
      multicall3: args.multicall3 ?? MULTICALL3_ADDRESS,
    }),
  ]);

  // 定價來源每個資產只有一種，先一次決定完：後面「要不要去問價格」與「價格是多少」讀的是同一份，
  // 不會出現一處當它是 numeraire、另一處當它是無價這種自相矛盾。
  const prices = new Map<string, AssetPrice>();
  for (const balance of balances) prices.set(balance.token.address.toLowerCase(), priceFor(balance.token));

  // 只有「走 TWAP」且「真的持有」的資產才值得去問價格；定價是這條路徑上最貴、也最容易失敗的一步。
  // numeraire 永遠不進來：它的價格是定義，去問池子只會問出別的東西（見檔頭 ③）。
  const quotable: { balance: TokenBalance; usdtPool: Address }[] = [];
  for (const balance of balances) {
    const price = prices.get(balance.token.address.toLowerCase());
    if (price?.kind === 'twap' && balance.amountWei > 0n) quotable.push({ balance, usdtPool: price.usdtPool });
  }
  // 有東西要報價，就先確定分母是誰；`null` 只在「這次沒有任何報價」時出現。
  // 分母從**查價表**來（策略資產清單裡沒有 numeraire 也一樣），見 `quoteTable` 的說明。
  const expectedQuoteToken = quotable.length === 0 ? null : singleNumeraireOf(args.quoteTable ?? args.tokens);
  // `blockNumber` 與餘額讀的是同一個塊：餘額 block N、價格 head 的話，同一份觀測根本不成立。
  const quotes =
    expectedQuoteToken === null
      ? []
      : await Promise.allSettled(
          quotable.map(({ balance, usdtPool }) =>
            priceToken(client, {
              token: balance.token.address,
              usdtPool,
              expectedQuoteToken,
              blockNumber: block,
            }),
          ),
        );
  const quoteByAsset = new Map<string, PromiseSettledResult<{ priceE8: bigint }>>();
  quotable.forEach(({ balance }, index) => {
    const settled = quotes[index];
    if (settled !== undefined) quoteByAsset.set(balance.token.address.toLowerCase(), settled);
  });

  const holdings: PricedHolding[] = [];
  const unpriced: UnpricedAsset[] = [];
  for (const balance of balances) {
    const { token, amountWei, decimals } = balance;
    const asset = token.address.toLowerCase() as Address;
    const price = prices.get(asset);
    if (price === undefined) {
      // 同一份 balances 建出來的 map 一定含這個 asset；缺了是這裡的 bug，不能當成無價靜默放過。
      throw new Error(`內部錯誤：${token.symbol} 沒有定價來源`);
    }
    if (price.kind === 'unpriced') {
      unpriced.push({ asset, symbol: token.symbol, amountWei, decimals, reason: price.reason });
      continue;
    }
    if (amountWei === 0n) continue;
    if (price.kind === 'numeraire') {
      // 沒有池、沒有 RPC：1 顆 USDT 就是 1e8。這一條是「持有 USDT 不再擋下漂移」的唯一入口。
      holdings.push({ asset, amountWei, decimals, usdPriceE8: price.priceE8, priceSource: NUMERAIRE_PRICE_SOURCE });
      continue;
    }
    const quote = quoteByAsset.get(asset);
    if (quote === undefined) {
      // 不會發生（quotable 與 quoteByAsset 是同一個集合），但別讓它變成「靜默沒有價格」。
      throw new Error(`內部錯誤：${token.symbol} 有餘額卻沒有對應的報價結果`);
    }
    if (quote.status === 'rejected') {
      unpriced.push({ asset, symbol: token.symbol, amountWei, decimals, reason: pricingFailureReason(quote.reason) });
      continue;
    }
    holdings.push({ asset, amountWei, decimals, usdPriceE8: quote.value.priceE8, priceSource: TWAP_PRICE_SOURCE });
  }

  return { portfolioId: args.portfolioId, block, nativeBalanceWei, holdings, unpriced };
}
