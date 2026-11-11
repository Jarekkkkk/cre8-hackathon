/**
 * 漂移 → 可執行的 `SwapStep[]`。**這一層是純決策 + 讀鏈，不送交易。**
 *
 * 上游：`computeDrift`（src/drift.ts）算出「哪個資產超配幾 bps」。下游：`AtpExecutor.executeRebalance`
 * （cre8-contracts/src/atp/AtpExecutor.sol）把 `SwapStep[]` 逐筆換掉。規劃器的責任只有一件事：
 * 把那組 bps 變成合約會**接受**的參數 —— 合約不驗「該不該換」，它驗的是 amountIn / amountOutMin /
 * commands / recipient / deadline，任何一項不合就整筆 revert。
 *
 * ## 三種結果，沒有第四種
 *
 *   * `noop`    —— 現在不需要動（未達門檻／空倉／賣出量算出來是 0）。**絕對不回空的 `steps`**。
 *   * `blocked` —— 現在算不出來（>2 資產、oracle 不認這個 pair、報不出價）。附上原因，不猜。
 *   * `ready`   —— 一個或多個 step + deadline，`steps.length >= 1` 是**由型別結構保證**的（見 R1）。
 *
 * ## 為什麼「空 steps」是致命的（docs/pitfalls.zh-TW.md §8.1）
 *
 * `executeRebalance(account, [], deadline)` 的 `for` 迴圈一次都不跑：`NotAccount` / `DeadlineExpired` /
 * `NotEnrolled` / `Paused` 全部可通過，函式**正常返回、不換任何幣、不 emit 任何 `SwapExecuted`**。
 * 「批次不能是空的」那條檢查只在 per-step 路徑上被呼叫，空陣列根本走不到。所以一個 `ready` 帶著空的
 * `steps` 會在鏈上看起來「成功」，而實際上什麼都沒發生 —— 這是驗收最貴的一種假綠燈。
 * 這份檔案因此**沒有任何一條路徑會產生空陣列**：step 先建成 `PlannedStep | null`，null 一律走 `noop`，
 * 非 null 才包成 `[step]`（單元素字面值，長度恆為 1）。
 *
 * ## 取整方向（全部向下，理由是不可逆轉的那一側）
 *
 *   1. `moveValueE8 = |deltaBps| * totalUsdE8 / 10000` —— 整數除法**向下**。
 *   2. `amountIn    = moveValueE8 * 10^decimals / priceE8` —— 整數除法**向下**。
 *   3. `amountIn    = min(amountIn, holding.amountWei)` —— 夾到實際持倉。
 *
 * 兩次截斷都讓「賣出的量 ≤ 真正該賣的量」，誤差留在帳戶裡（表現為一點點超配的粉塵），下一輪會再收斂。
 * 反方向（向上取整）會多賣：多賣的那一份**不會**被任何檢查擋下來 —— 合約只驗下限（`amountOutMin`），
 * 賣多了是合法的 —— 所以這裡寧可少賣。這也是為什麼 `amountIn === 0n` 必須回 `noop`：合約對
 * `amountIn == 0` 是 `revert ZeroAmount()`，送出去一定失敗，而且失敗得晚（在模擬/上鏈階段才發現）。
 *
 * ## 與合約逐字對齊的三個常數
 *
 *   * `minGross = ceil(oracleFloor * 10000 / (10000 - feeBps))` —— 同 `AtpExecutor._minGross`
 *     （AtpExecutor.sol:296-299，OpenZeppelin `Math.mulDiv(..., Rounding.Ceil)`）。
 *     `oracleFloor` 是 `oracle.previewSwap(...)` 的**第二個**回傳值 `minimum`（滑價折扣後的地板），
 *     不是 `quoted`（TWAP 報價）。`feeBps` 來自 `registry.effectiveFeeBps(strategyId)`，而那個
 *     `strategyId` **必須是鏈上 id**（`enrollment.strategyId`），不是 DB 的 `strategies.id`。
 *   * `commands = 0x00`（`UniversalRouterCommands.V3_SWAP_EXACT_IN`）—— 一個 byte，**不是** bytes[]，
 *     而且是 packed bytes：合約逐 byte 精確比對，帶 flag bit（例如 `0x80` = FLAG_ALLOW_REVERT）會被
 *     `CommandNotAllowed` 拒掉。
 *   * `inputs[0] = abi.encode(address recipient, uint256 amountIn, uint256 amountOutMin, bytes path,
 *     bool payerIsUser)`，`recipient` 必須**等於 executor 自己**（`_checkRecipient` 讀第 0 個 head word
 *     的低 20 bytes，不符就 `BadRecipient`）。`payerIsUser = true`：幣是從 executor 付出去的
 *     （executor 先把 `tokenIn` 從 account 拉過來，再交給 router）。
 *
 * ## deadline 用 `max(塊時間, 牆鐘)`，不是只挑一個
 *
 * `deadline = max(塊時間, 牆鐘) + deadlineSeconds`（預設 1800 秒）。兩個時鐘錯的方向不同，所以取較晚
 * 的那一個：
 *
 *   * **塊時間落後**（稀疏挖礦：anvil 按需出塊，沒交易就不出新塊，「當前塊」停在很久以前，而那筆 op
 *     真的落地時新塊的時間戳是牆鐘）→ 用牆鐘。實測：塊 132179976 的時間戳 09:54:57，那筆 op 落地時
 *     新塊是 10:09:04（跳 14 分鐘），於是 `塊時間 + 300` 的 deadline（09:59:57）在**簽的時候就已經
 *     過期**，鏈上回 `DeadlineExpired()`（`0x1ab7da6b`），白燒一次 gas。
 *   * **塊時間超前**（fork 的頭塊在上游那一刻；本地鏈被時間旅行過）→ 用塊時間。只用牆鐘的話，
 *     deadline 相對於鏈仍然是過期的 —— 這是原本刻意用塊時間的理由，`max` 把它保留住了。
 *
 * 牆鐘超前時拿到的是**寬鬆**的 deadline，而那是安全的方向：價格不是靠 deadline 把關的 ——
 * `oracleFloor`（`previewSwap` 的 minimum，低於它合約就 revert `BelowFloor`）才是；deadline 只是次要保護。
 * **太短比太長危險**：太短 = 必然 revert + 燒 gas。合約把它原樣傳給 Permit2（`uint48(deadline)`），
 * 所以它同時是 Permit2 allowance 的到期時間 —— 上限 30 天（`MAX_DEADLINE_SECONDS`）。
 *
 * ## 兩種 oracle 形狀：hub（N 資產）與 pinned（舊的單一 pair）
 *
 * `AtpExecutor.oracle` 是 immutable。舊堆疊接的是 `PancakeV3TwapOracle`，它在建構子釘死**一個**
 * pool（D-23），所以那個 oracle 只報得出一對代幣的價。新堆疊接的是 `AtpMultiPoolOracle`：它宣告
 * `numeraire`（＝USDT），把每一次 `previewSwap` 轉給該資產自己的 per-pair oracle。所以「能不能換
 * 第三個資產」現在是 **oracle 的形狀**問題，不是 executor 的問題。這裡在**規劃階段**依序問
 * oracle `pool()`/`token0()`/`token1()`（pinned 的介面）再問 `numeraire()`（hub 的介面）來判形狀，
 * 判不出來就 `blocked` —— 不猜，也不讓它變成上鏈後的 revert。
 *
 * hub 模式（`AtpMultiPoolOracle`）對每個**非 numeraire** 的目標資產各算一步，量是
 * `deltaUsd_i = 實際 USD − 目標 USD`（1e8 定點）：
 *
 *   1. `deltaUsd_i > 0` → 賣 `deltaUsd_i` 價值的該資產，換 USDT（`asset → USDT`）。
 *   2. `deltaUsd_i < 0` → 買 `|deltaUsd_i|` 價值的該資產，付 USDT（`USDT → asset`）。
 *   3. **先所有賣、再所有買**：executor 逐 step 用 `safeTransferFrom` 從帳戶拉 `tokenIn`，買的 USDT
 *      只會來自前面那些賣（同一個 tx）。陣列順序顛倒會在拉幣時 revert，而錯誤訊息只會說餘額不足。
 *   4. 買的 USDT 預算 = **目前持倉 + 前面賣出的保證淨額**（`floor − fee`，不是 `quoted`），逐筆遞減；
 *      超過就夾到剩餘預算，剩 0 就跳過。
 *   5. 每一步各自向 router 要 floor（`previewSwap(tokenIn, tokenOut, amountIn).minimum`），
 *      `minGross` 仍由 `minGrossFor` 逐字對齊合約。
 *   6. 某一步算不出（沒有註冊 oracle／沒有池／報不出價／`amountIn == 0`）→ **跳過那一步並記錄在
 *      rationale**，不是整份 `blocked`：一個沒有池的資產不該讓另外兩個資產的再平衡一起停擺。
 *      全部都被跳過 → `noop`（永不回空 steps，見上面 §8.1）。
 *   7. 取整：目標 USD 取**上界**（`ceil`），所以「該賣的量」只會少不會多；`amountInFor` 再向下截斷一次。
 *
 * `targets` 不含 numeraire → `blocked`：執行器只換 `version.assets` 裡的代幣（AtpExecutor.sol:180-182
 * 的 `AssetNotAllowed`），hub 不是策略資產就收不了賣出的 USDT、也付不出買的 USDT。
 */

import { chooseBestPath, routeImpactBps, singleHopPath } from './routing.js';
import { V2_FACTORY_ADDRESS, V3_FACTORY_ADDRESS, WBNB_ADDRESS } from './addresses.js';
import { decodeAbiParameters, encodeAbiParameters, encodePacked, getAddress, isAddressEqual } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import type { AssetDrift, DriftReport, Holding, TargetWeight } from './drift.js';
import { computeDrift } from './drift.js';
import { capAmountInForImpact, estimateImpact, impactStateProblem } from './impact.js';
import type { PoolImpactState } from './impact.js';

export type PlannedStep = {
  tokenIn: Address;
  tokenOut: Address;
  /** tokenIn 的原幣單位（exact-input）。 */
  amountIn: bigint;
  /** = minGross：合約要求 `amountOutMin >= minGross`，而 router 用的也是這個值。 */
  amountOutMin: bigint;
  /** `previewSwap` 的 `minimum`，留作稽核（minGross 是它放大後的結果，看得到原值才對得起來）。 */
  oracleFloor: bigint;
  commands: Hex;
  inputs: Hex[];
};

export type RebalancePlan =
  | { kind: 'noop'; reason: string }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'ready';
      steps: PlannedStep[];
      deadline: bigint;
      rationale: string;
      /**
       * 依這份 `steps` 執行之後，**預估漂移仍高於門檻**（＝還有事要做，下一輪要接著做）。
       * 缺席 = 執行後預估就收斂了（接著跑也只會拿到 noop），`steps` 是完整的一輪。
       *
       * 判準是**結果**（執行後的預估漂移），不是**過程**（有沒有 step 被縮）。舊版用「有 step 被
       * 衝擊上限縮小」，於是「主要缺口整筆被跳過、只剩一個 $31.8 的小 step」會被判成已收斂 → 排程器
       * 退回完整間隔，漂移 1218 → 1213 卻整整一小時不再跑。
       *
       * 這是**給排程器的結構化訊號**，不是錯誤：有缺口是正常結果（池子不夠深／被跳過），
       * 排程器據此把 `next_run_at` 拉近（見 src/scheduler.ts 的 `PARTIAL_FOLLOW_UP_SECONDS`）。
       */
      partial?: PlanPartial | undefined;
    };

/** 一個被價格衝擊上限縮小的 step（`index` 對應 `steps` 的位置）。 */
export type ShrunkStep = {
  index: number;
  /** 依漂移算出來的理想量 —— 這一輪**沒有**賣這麼多。 */
  idealAmountIn: bigint;
  /** 實際送出的量。 */
  amountIn: bigint;
  /** 理想量的估算衝擊（bps，超過 `maxImpactBps` 才會被縮）。 */
  idealImpactBps: number;
  /** 縮小之後的估算衝擊（bps，必定 ≤ `maxImpactBps`）。 */
  impactBps: number;
};

export type PlanPartial = {
  /**
   * 執行後的預估漂移（bps）。
   *
   * `null` = **算不出來**，不是「沒有改善」。最常見的情況是這一輪要買進帳戶現在沒有的資產：
   * 買到的量沒有價格可以估，所以算不出執行後的漂移。此時**不要**拿執行前的漂移假裝成預測值 ——
   * 實際發生過：漂移 6600 → 6 bps 的一輪，卡片卻寫「still 6600 bps」，還把 next_run_at 提前。
   */
  remainingDriftBps: number | null;
  /** 被縮小的 step（可能為空：缺口可能是「被跳過」而不是「被縮小」）。 */
  shrunk: ShrunkStep[];
};



export type PlanRebalanceArgs = {
  publicClient: PublicClient;
  /** 被再平衡的 smart account（合約要求 `msg.sender == account`）。 */
  account: Address;
  /** AtpExecutor：V3 payload 的 recipient 要釘在這裡，錯了會被 `BadRecipient` 拒掉。 */
  executor: Address;
  /** 報價地板來源（`previewSwap`），同時決定「哪一個 pool、哪一個 pair」。 */
  oracle: Address;
  /** AtpRegistry：`effectiveFeeBps` 的來源。 */
  registry: Address;
  /** **鏈上** strategy id（`enrollment.strategyId`），不是 DB 的 `strategies.id`。 */
  strategyId: bigint;
  /** 索引器的實際持倉（不含策略外、不含 native gas BNB）。amountIn 的上限就是這裡的 amountWei。 */
  holdings: readonly Holding[];
  /** `version.assets` 的目標權重。 */
  targets: readonly TargetWeight[];
  /** `computeDrift` 的結果。 */
  drift: DriftReport;
  thresholdBps: number;
  /** 觀測的塊高：所有鏈上讀取都釘在這一塊（否則 amountIn 與報價會來自不同時間點）。 */
  blockNumber: bigint;
  /**
   * deadline = `max(塊時間, 牆鐘)` + 這個秒數。預設 1800；上限 30 天（Permit2）。
   */
  deadlineSeconds?: number;
  /**
   * hub 模式的 numeraire（USDT）。省略就問 oracle 的 `numeraire()` —— 鏈上是唯一權威。
   * 給了就跳過那次判定呼叫；對**舊的**單池 oracle（沒有這個函式）給這個參數是設定錯誤，
   * 該 oracle 會在 `UnsupportedRoute`/`pool()` 上失敗，這裡不會替它假裝。
   */
  numeraire?: Address;
  /**
   * 每一步的價格衝擊上限（bps，量法是 `(TWAP 報價 − 估算到手)/TWAP 報價`，
   * 與合約 `maxSlippageBps` 同一個空間）。預設 `DEFAULT_MAX_IMPACT_BPS` = 80。
   *
   * 為什麼是 80 而不是 50：50 在「現貨偏離 TWAP 60–80 bps」這種很常見的盤況下會讓**每一輪都做不了事**
   * （baseline 就吃掉全部預算），投組於是長期停在漂移裡（D-25 說「等市場」，但沒有終點保證）。
   * 80 仍然**嚴格小於** per-pair oracle 的 `maxSlippageBps`（100），所以合約的 `BelowFloor` 仍然是最後
   * 一道、且**永遠比我們寬鬆** —— 我們不會送出一個必定 revert 的計畫。
   *
   * ⚠ 這個值不是「越大越能動」：真正的上限是 oracle 的 100，而 baseline 是市場決定的。
   *   實測某輪 baseline 92 bps 時，即使把這裡調到 80 也一樣做不了事 —— 那種情況要動的是 oracle 的
   *   `maxSlippageBps`（換 per-pair oracle），不是這裡。
   *
   *   * `undefined` → 用預設值 50（**預設就是開的**）。
   *   * `null`      → 關掉：不讀池子狀態、一步都不縮（既有行為的完全等價開關）。
   *   * 超標的 step 會被**縮小**而不是丟掉，剩餘由下一輪處理（跨輪次，不是同一批切小 ——
   *     切在同一批裡沒有用，floor 來自 TWAP，不會因為這一筆而移動）。
   */
  maxImpactBps?: number | null;
};


export type PlanRebalanceDeps = {
  /**
   * 注入「塊時間」（unix 秒）。省略就讀 `publicClient` 上 `blockNumber` 那一塊的 timestamp。
   * 存在的理由是測試要能證明 deadline 跟著塊時間走：換一個塊時間（而且它在牆鐘之後），deadline 必須
   * 跟著換。它只取代**塊時間那一邊**，牆鐘那一邊仍然是 `Date.now()`（見 `deadlineBase`）—— 所以注入
   * 一個過期的塊時間**不會**讓 deadline 過期，那正是稀疏挖礦那個缺陷的修法。
   */
  blockTimestampSeconds?: bigint;
};

const BPS_DENOMINATOR = 10_000;
const BPS_BIG = 10_000n;
/** Permit2 的 allowance 是 uint160；合約對超過它的 amountIn 是 revert AmountTooLarge（不是截斷）。 */
const UINT160_MAX = 2n ** 160n - 1n;
/** Permit2 的 allowance 到期時間上限：30 天。超過就不是「這一筆的期限」而是一個長期授權。 */
export const MAX_DEADLINE_SECONDS = 30 * 24 * 60 * 60;
/**
 * deadline 的預設長度：**1800 秒（30 分鐘）**。
 *
 * 300 秒在稀疏挖礦的鏈上不夠：塊時間可以落後牆鐘十幾分鐘，而 op 從規劃到落地本身還有幾十秒到幾分鐘
 * 的延遲（session key → Kernel → bundler → 上鏈）。太短的 deadline 換不到任何保護（價格由
 * `oracleFloor` 把關），只換來必然的 `DeadlineExpired` revert + 白燒 gas。
 *
 * 為什麼不是更長：deadline 同時是 Permit2 allowance 的到期時間，1800 秒已經足夠覆蓋「規劃 → 上鏈」
 * 的延遲，又仍遠低於 30 天上限（`MAX_DEADLINE_SECONDS`）—— 不是變成一張長期授權。
 */
export const DEFAULT_DEADLINE_SECONDS = 1800;
/** `UniversalRouterCommands.V3_SWAP_EXACT_IN`：一個 byte，packed。不是 bytes[]。 */
export const V3_SWAP_EXACT_IN: Hex = '0x00';
/**
 * 每一步的預設價格衝擊上限：**半個滑價預算**。
 *
 * `PancakeV3TwapOracle` 給的地板是 TWAP 報價打折 1%（`maxSlippageBps = 100`）。那 1% 要同時裝下
 * 池子手續費（2500 → 25 bps）、現貨相對 TWAP 的既有偏差、以及這一筆自己的衝擊。留一半給衝擊，
 * 剩下的才是給 fee 與雜訊的 —— 50 bps 的衝擊在 2500 的池子上剛好留 25 bps 的餘裕。
 */
export const DEFAULT_MAX_IMPACT_BPS = 80;
/**
 * 縮小之後如果連理想量的 **1 bp**（萬分之一）都不到，就當成 dust 跳過。
 * 理由：那種量對漂移的貢獻等於 0，卻要付一次完整的 swap gas 與一次 `BelowFloor` 的風險。
 */
export const MIN_STEP_BPS_OF_IDEAL = 1;


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
  { type: 'function', name: 'pool', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  /**
   * `AtpMultiPoolOracle` 才有：hub 模式的 numeraire（USDT）。舊的單池 oracle 沒有這個函式，
   * 呼叫會 revert —— 形狀判定就是靠這件事（見 detectOracleShape）。
   */
  { type: 'function', name: 'numeraire', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  /** `AtpMultiPoolOracle` 才有：asset → 該資產的 per-pair oracle（未註冊時是零地址）。 */
  {
    type: 'function',
    name: 'oracleOf',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'effectiveFeeBps',
    stateMutability: 'view',
    inputs: [{ name: 'strategyId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint16' }],
  },
] as const;

const V3_POOL_ABI = [
  {
    type: 'function',
    name: 'fee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint24' }],
  },
  /** 衝擊估算要用：現貨價（Q64.96）、當前區間的流動性、以及哪一邊是 token0。 */
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;


/** `0x00` 的 input payload：`(recipient, amountIn, amountOutMin, path, payerIsUser)`。 */
/** Universal Router 的 `V2_SWAP_EXACT_IN`（executor allowlist 已包含）。 */
export const V2_SWAP_EXACT_IN: Hex = '0x08';

const V2_SWAP_EXACT_IN_INPUT = [
  { name: 'recipient', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'amountOutMin', type: 'uint256' },
  { name: 'path', type: 'address[]' },
  { name: 'payerIsUser', type: 'bool' },
] as const;

const V3_SWAP_EXACT_IN_INPUT = [
  { name: 'recipient', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'amountOutMin', type: 'uint256' },
  { name: 'path', type: 'bytes' },
  { name: 'payerIsUser', type: 'bool' },
] as const;

/** 整數除法向上取整。除數必須 > 0。 */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * `minGross = ceil(oracleFloor * 10000 / (10000 - feeBps))`。
 * 與 `AtpExecutor._minGross`（AtpExecutor.sol:296-299）逐字相同：分子分母都不做任何化簡，
 * 因為化簡會改變取整點 —— 這是唯一需要「逐字」而不是「等價」的地方。
 */
export function minGrossFor(oracleFloor: bigint, feeBps: number): bigint {
  if (oracleFloor < 0n) throw new RangeError(`oracleFloor must not be negative, got ${oracleFloor}`);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= BPS_DENOMINATOR) {
    throw new RangeError(`feeBps must be an integer in 0..9999, got ${feeBps}`);
  }
  return ceilDiv(oracleFloor * BPS_BIG, BPS_BIG - BigInt(feeBps));
}

/**
 * 「該搬多少價值」：`|deltaBps| * totalUsdE8 / 10000`，單位是 E8 定點 USD，向下截斷。
 * `deltaBps` 是整數 bps（Number），`totalUsdE8` 是 1e8 定點（bigint）；乘除都在 bigint 上做。
 */
export function moveValueE8(absDeltaBps: number, totalUsdE8: bigint): bigint {
  if (!Number.isInteger(absDeltaBps) || absDeltaBps < 0) {
    throw new RangeError(`absDeltaBps must be a non-negative integer, got ${absDeltaBps}`);
  }
  if (totalUsdE8 < 0n) throw new RangeError(`totalUsdE8 must not be negative, got ${totalUsdE8}`);
  return (BigInt(absDeltaBps) * totalUsdE8) / BPS_BIG;
}

/**
 * 「這筆價值換成幾個原幣單位」：`moveValueE8 * 10^decimals / priceE8`，向下截斷。
 * `priceE8` 是「1 整顆的 USDT 價格 × 1e8」，所以換算只差一個 10^decimals。
 * 先乘後除，避免先除把精度吃掉（6 位小數的代幣這一步差很多）。
 */
export function amountInFor(moveValue: bigint, priceE8: bigint, decimals: number): bigint {
  if (moveValue < 0n) throw new RangeError(`moveValue must not be negative, got ${moveValue}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`decimals must be an integer in 0..36, got ${decimals}`);
  }
  if (priceE8 <= 0n) throw new RangeError(`priceE8 must be positive, got ${priceE8}`);
  return (moveValue * 10n ** BigInt(decimals)) / priceE8;
}

/** 0x1234…abcd：理由字串是給人看的，完整地址在 step 裡。 */
function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/** 代幣最小單位 → 顆數（固定 6 位），只給理由字串用。 */
function formatUnits(amountWei: bigint, decimals: number): string {
  const scale = pow10(decimals);
  return `${amountWei / scale}.${((amountWei % scale) * 1_000_000n / scale).toString().padStart(6, '0')}`;
}

/**
 * revert 的名字。viem 把它放在 `cause` 鏈上的 `data.errorName`，但 stub（測試）與某些節點只留訊息，
 * 所以兩條路都走。認不出來回 null —— 呼叫端要把它當「未知錯誤」而不是當成成功。
 */
function revertNameOf(error: unknown): string | null {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor !== null && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const record = cursor as { data?: { errorName?: unknown }; cause?: unknown };
    if (typeof record.data?.errorName === 'string') return record.data.errorName;
    cursor = record.cause;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match =
    /(UnsupportedPair|UnsupportedRoute|OracleNotSet|SameToken|ZeroQuote|ZeroAmount|TwapUnavailable|InvalidPoolPrice|DeadlineExpired)/.exec(
      message,
    );
  return match?.[1] ?? null;
}

/** 0x + 40 hex 的地址字串（鏈上回傳值的形狀檢查，不猜）。 */
function isAddressLike(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && /[1-9a-fA-F]/.test(value.slice(2));
}

/** 塊時間：注入值優先，否則讀 `blockNumber` 那一塊。不回傳 null，讀不到就拋（沒有可信的時鐘不能規劃）。 */
async function readBlockTimestamp(
  client: PublicClient,
  blockNumber: bigint,
  injected: bigint | undefined,
): Promise<bigint> {
  if (injected !== undefined) {
    if (injected < 0n) throw new RangeError(`injected block timestamp must not be negative, got ${injected}`);
    return injected;
  }
  const block = await client.getBlock({ blockNumber });
  // 塊高對不上就是讀到了另一塊：時間與餘額會來自不同時間點，規劃不能這樣做。
  if (block.number !== null && block.number !== blockNumber) {
    throw new Error(`getBlock(${blockNumber}) 回傳了第 ${block.number} 塊`);
  }
  return block.timestamp;
}

/**
 * deadline 的基準：`max(塊時間, 牆鐘)`。兩個時鐘錯的方向不同，取較晚的那一個（完整理由在檔頭
 * 「deadline 用 max(塊時間, 牆鐘)」）：塊時間落後時靠牆鐘把 deadline 拉回未來，塊時間超前時靠塊時間
 * 讓 deadline 相對於鏈仍然有效。
 *
 * 回傳 `source` 是為了理由字串：實際用了哪一邊要看得見，不然「deadline 為什麼在未來」只能靠猜。
 */
function deadlineBase(blockTimestamp: bigint): { base: bigint; source: 'chain' | 'wall' } {
  const wallClockSeconds = BigInt(Math.floor(Date.now() / 1_000));
  return blockTimestamp > wallClockSeconds
    ? { base: blockTimestamp, source: 'chain' }
    : { base: wallClockSeconds, source: 'wall' };
}

type Head = { feeBps: number; blockTimestamp: bigint };

/** `effectiveFeeBps` 與塊時間：兩者都是「一次規劃一份」的值，讀一次、全程共用。 */
async function readHead(
  client: PublicClient,
  registry: Address,
  strategyId: bigint,
  blockNumber: bigint,
  injectedTimestamp: bigint | undefined,
): Promise<Head | { blocked: string }> {
  const [feeBpsRaw, blockTimestamp] = await Promise.all([
    client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'effectiveFeeBps',
      args: [strategyId],
      blockNumber,
    }),
    readBlockTimestamp(client, blockNumber, injectedTimestamp),
  ]);
  const feeBps = Number(feeBpsRaw);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= BPS_DENOMINATOR) {
    return {
      blocked: `registry.effectiveFeeBps(${strategyId}) 回 ${String(feeBpsRaw)}，不是 0..9999 的整數：合約會 revert FeeTooHigh`,
    };
  }
  return { feeBps, blockTimestamp };
}

/**
 * `amountOutMin` 相對地板的緩衝（bps）。
 *
 * 為什麼需要：合約的 pre-check 是
 *   `step.amountOutMin >= minGross（執行時重算的 oracle 地板）`
 * 而我們的 `amountOutMin` 是**規劃時**算的。TWAP 只要在「規劃 → 上鏈」這幾秒內往上動一點，
 * pre-check 就破線 —— 實測只差 **100 ppm（0.01%）** 就 revert `BelowFloor(step.min, minGross)`，
 * 而真正的成交其實遠高於地板（池子手續費 0.25%、oracle 地板有 3% 折扣）。
 *
 * 10 bps 遠大於實測漂移（1 bp），又遠小於「地板 → 成交價」之間約 275 bps 的裕度，
 * 所以不會把 router 的 min 逼到成交價之上（那會變成 `V3TooLittleReceived`）。
 */
export const AMOUNT_OUT_MIN_BUFFER_BPS = 10n;

/** 把地板加上緩衝，得到實際帶給合約/路由的 `amountOutMin`（見上面的說明）。 */
export function amountOutMinWithBuffer(minGross: bigint): bigint {
  return minGross + ceilDiv(minGross * AMOUNT_OUT_MIN_BUFFER_BPS, BPS_BIG);
}

/** 一個 step 的 commands / inputs：`recipient` 必須是 executor（`_checkRecipient`），`payerIsUser = true`。 */
export function buildStep(params: {
  executor: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  oracleFloor: bigint;
  minGross: bigint;
  poolFee: number;
  /**
   * 實際成交用的 V3 path（可多跳）。省略 = 用 `poolFee` 組單跳（既有行為）。
   *
   * 為什麼要能覆寫：地板價綁在 oracle 那個池子上（保守下界），但**成交**可以走更好的路徑。
   * `AtpExecutor._checkCommands` 只驗指令類型、不驗 path 內容，所以換路徑不需要改合約。
   */
  path?: Hex;
  /** 有值 = 走 V2 路線（command 0x08、path 是 address[]）；否則用 V3。 */
  v2Tokens?: Address[] | null;
}): PlannedStep {
  const path =
    params.path ?? encodePacked(['address', 'uint24', 'address'], [params.tokenIn, params.poolFee, params.tokenOut]);
  // ⚠ 這個值必須**同時**放進 struct 欄位與 calldata：合約的 pre-check 讀 `step.amountOutMin`，
  // 真正約束成交的是 router 從 `inputs` 解出來的 `amountOutMin`。兩者分岔就是「合約以為有地板、
  // router 卻用另一個值」—— 曾經只加在欄位上，於是 router 仍用未緩衝值（實測差 100 ppm 就 revert）。
  const amountOutMin = amountOutMinWithBuffer(params.minGross);
  if (params.v2Tokens !== undefined && params.v2Tokens !== null) {
    return {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      amountOutMin,
      oracleFloor: params.oracleFloor,
      commands: V2_SWAP_EXACT_IN,
      inputs: [
        encodeAbiParameters(V2_SWAP_EXACT_IN_INPUT, [
          getAddress(params.executor),
          params.amountIn,
          amountOutMin,
          params.v2Tokens.map((token) => getAddress(token)),
          true,
        ]),
      ],
    };
  }
  return {
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    amountOutMin,
    oracleFloor: params.oracleFloor,
    commands: V3_SWAP_EXACT_IN,
    inputs: [
      encodeAbiParameters(V3_SWAP_EXACT_IN_INPUT, [
        getAddress(params.executor),
        params.amountIn,
        amountOutMin,
        path,
        true,
      ]),
    ],
  };
}

// ---------------------------------------------------------------------------
// 送出前重問地板（plan → execute 之間池價會動）
// ---------------------------------------------------------------------------

/**
 * ⚠ `oracleFloor` 的兩種身分，**不要混用**：
 *
 *   * `PlannedStep.oracleFloor` / `amountOutMin`（下面叫 `planned*`）是**規劃當時**的地板：
 *     `planRebalance` 在 `blockNumber` 那一塊問到的值。它的用途是 impact 計算、rationale、dry-run 顯示
 *     —— 也就是「這一輪打算怎麼做」的估算。**它不是送出時的授權值。**
 *   * `refreshFloors` 回傳的 `fresh*` 是**簽名前**重新問到的地板：那才是合約在執行那一塊會自己再問一次
 *     的同一個值（`AtpExecutor._checkStep` 每步都 `oracle.previewSwap(...)` 重算 `minGross`，然後
 *     `require(step.amountOutMin >= minGross)`）。
 *
 * 兩者之間隔著 plan → sign 的幾十秒，而 `PancakeV3TwapOracle.previewSwap` 的 `minimum` 是
 * `max(TWAP 視窗, 近 5 分鐘均值) × (1 − slippage)` —— 近 5 分鐘均值會追著池價跑。所以規劃值只對
 * 「規劃那一刻」有效；拿凍結的它去簽名，就是用一個過期的下限去過一個當下的檢查（`BelowFloor`）。
 */
export type FloorRefresh = {
  index: number;
  tokenIn: Address;
  tokenOut: Address;
  /** 規劃當時的地板（`PlannedStep.oracleFloor`）。 */
  plannedFloor: bigint;
  /** 送出前重新問到的地板（`previewSwap` 的 `minimum`）。 */
  freshFloor: bigint;
  plannedAmountOutMin: bigint;
  freshAmountOutMin: bigint;
  /** `(fresh − planned) / planned`，整數 bps、向零截斷：正 = 地板變好，負 = 地板變差。 */
  deltaBps: number;
};

export type RefreshFloorsResult =
  | { ok: true; steps: PlannedStep[]; refreshes: FloorRefresh[]; note: string }
  | {
      ok: false;
      /** `quote-failed` = 問不到地板（RPC／UnsupportedPair／NoFloor）；`floor-collapsed` = 問到了但太差。 */
      kind: 'quote-failed' | 'floor-collapsed';
      reason: string;
    };

/**
 * 新鮮地板比規劃值差超過這個 bps 就**放棄這一輪**。
 *
 * 100 = `PancakeV3TwapOracle` 整個滑價預算（`maxSlippageBps = 100`）。地板在 plan → sign 之間掉掉
 * 超過一整個滑價預算，代表池價已經不是規劃時看到的那一個：`amountIn` 是拿舊價算的、impact 上限是舊
 * 池子狀態下算的、`partial` 的剩餘量也是舊的 —— 繼續送就是拿一個已經不成立的價格前提去動錢。
 * 放棄這一輪不是失敗：下一輪用新價格重新規劃（新 `amountIn`、新地板），比硬送一筆「價格前提已變」的
 * 交易好。門檻刻意放在「一整個滑價預算」而不是幾個 bp：小幅變差是正常的，放棄也要有代價意識
 * （認領已經推進 `next_run_at`，放棄等於這一輪不做了）。
 */
export const MAX_FLOOR_WORSENING_BPS = 100;

/** `(to − from) / from` 的整數 bps（向零截斷）。`from` 必須 > 0：地板是 0 就是 `NoFloor`，不是「地板很低」。 */
function floorDeltaBps(from: bigint, to: bigint): number {
  if (from <= 0n) throw new RangeError(`地板的基準值必須 > 0（合約對 0 是 NoFloor），got ${from}`);
  return Number(((to - from) * BPS_BIG) / from);
}

/** `refreshFloors` 的 `note`：一行講完「規劃值 → 新鮮值（±N bps）」，給 log 與 CLI 摘要用。 */
function describeRefreshes(refreshes: readonly FloorRefresh[]): string {
  return refreshes
    .map(
      (entry) =>
        `step#${entry.index} ${short(entry.tokenIn)}→${short(entry.tokenOut)} 地板 ${entry.plannedFloor} → ${entry.freshFloor}` +
        `（${entry.deltaBps >= 0 ? '+' : ''}${entry.deltaBps} bps）；amountOutMin ${entry.plannedAmountOutMin} → ${entry.freshAmountOutMin}`,
    )
    .join('｜');
}

/**
 * 從既有的 step 解回「重建時**不能**變的兩件事」：`recipient`（→ executor）與 `path` 裡的 fee tier。
 *
 * 解不開就回 `problem`（呼叫端記成 `quote-failed`）：連自己要送什麼都讀不出來時，覆寫它比不覆寫危險。
 * 順帶驗 `path` 的兩端與 `inputs` 的 `amountIn` 與 step 一致 —— 這是「只換地板、不動別的」的機械保證。
 */
function decodeStepIdentity(
  step: PlannedStep,
):
  | { recipient: Address; poolFee: number; path: Hex; v2Tokens: null }
  | { recipient: Address; poolFee: number; path: null; v2Tokens: Address[] }
  | { problem: string } {
  const payload = step.inputs[0];
  if (payload === undefined) return { problem: '沒有 inputs[0]，解不出 recipient 與 path' };
  // V2 路線也要能重建（路由搜尋會選到它）。兩種 command 的 input 只有 path 型別不同。
  if (step.commands === V2_SWAP_EXACT_IN) {
    let v2decoded: readonly [Address, bigint, bigint, readonly Address[], boolean];
    try {
      v2decoded = decodeAbiParameters(V2_SWAP_EXACT_IN_INPUT, payload);
    } catch (error) {
      return { problem: `V2 inputs[0] 解不開（${revertNameOf(error) ?? (error instanceof Error ? error.message : String(error))}）` };
    }
    const [v2recipient, v2amountIn, , v2tokens] = v2decoded;
    if (v2tokens.length < 2) return { problem: `V2 path 只有 ${v2tokens.length} 個代幣` };
    if (!isAddressEqual(v2tokens[0]!, step.tokenIn) || !isAddressEqual(v2tokens[v2tokens.length - 1]!, step.tokenOut)) {
      return { problem: 'V2 path 的頭尾與 step 的 tokenIn/tokenOut 不同' };
    }
    if (v2amountIn !== step.amountIn) return { problem: `V2 inputs 的 amountIn ${v2amountIn} 與 step 的不同` };
    return { recipient: getAddress(v2recipient), poolFee: 0, path: null, v2Tokens: v2tokens.map((token) => getAddress(token)) };
  }
  if (step.commands !== V3_SWAP_EXACT_IN) {
    return { problem: `commands 是 ${step.commands}，這裡只重建得出 V3/V2 的 swap` };
  }
  let decoded: readonly [Address, bigint, bigint, Hex, boolean];
  try {
    decoded = decodeAbiParameters(V3_SWAP_EXACT_IN_INPUT, payload);
  } catch (error) {
    return { problem: `inputs[0] 解不開（${revertNameOf(error) ?? (error instanceof Error ? error.message : String(error))}）` };
  }
  const [recipient, amountIn, , path] = decoded;
  // path 是 packed(tokenIn, fee1, [mid, fee2, …], tokenOut)：**可以多跳**（路由選擇會產生兩跳）。
  // 只驗「第一個 token 是 step.tokenIn、最後一個是 step.tokenOut」與最小長度，
  // 中間的 hop 一律原樣保留 —— refreshFloors 重建 step 時必須用同一條路徑，
  // 否則會把「選好的兩跳成交」悄悄換回「單跳的差價」。
  const pathBytes = (path.length - 2) / 2;
  if (pathBytes < 43 || (pathBytes - 20) % 23 !== 0) {
    return { problem: `path 是 ${pathBytes} bytes，不是 packed(address,uint24,…) 的合法長度` };
  }
  const pathTokenIn = getAddress(`0x${path.slice(2, 42)}` as Hex);
  const poolFee = Number(BigInt(`0x${path.slice(42, 48)}` as Hex));
  const pathTokenOut = getAddress(`0x${path.slice(path.length - 40)}` as Hex);
  if (!isAddressEqual(pathTokenIn, step.tokenIn) || !isAddressEqual(pathTokenOut, step.tokenOut)) {
    return {
      problem:
        `path 是 ${short(pathTokenIn)}→${short(pathTokenOut)}，與 step 的 ` +
        `${short(step.tokenIn)}→${short(step.tokenOut)} 不同`,
    };
  }
  if (amountIn !== step.amountIn) return { problem: `inputs 的 amountIn ${amountIn} 與 step 的 ${step.amountIn} 不同` };
  return { recipient: getAddress(recipient), poolFee, path, v2Tokens: null };
}

/**
 * 送出前對**每一個** step 重問一次地板，並用新鮮的 `minimum` 重算 `amountOutMin`（= `minGross`）。
 *
 * ## 為什麼是「新鮮值」，不是 `max(規劃值, 新鮮值)`
 *
 * 合約在執行那一塊**自己**重算地板（`_checkStep`：先 `previewSwap`，再
 * `require(step.amountOutMin >= minGross)`），所以 `amountOutMin` 的身份是「下限的下限」：
 *
 *   * `max` 只在「地板變差」時才不等於新鮮值，而那一邊 `max` 剛好是**錯的**方向：它把一個已經不成立
 *     的高值塞進 router 的滑價檢查（`inputs` 裡的 `amountOutMin`），成交價已經下來了，router 就
 *     revert `Too little received`。用過期的約束擋一個已經移動的市場，換來的是另一種 revert，不是安全。
 *   * 新鮮值才是「我不接受比**現在**這個地板更差的成交」—— 地板語意本來就是當下的事實。
 *
 * 「新鮮地板明顯變差還要不要送」是**政策**問題、不是覆寫方向問題，所以另外用
 * `MAX_FLOOR_WORSENING_BPS` 擋（`kind: 'floor-collapsed'`）。
 *
 * ## 為什麼一定要重建 `inputs`
 *
 * `amountOutMin` 在 calldata 裡出現**兩次**：`step.amountOutMin`（合約驗的）與 `inputs[0]` 裡
 * `(recipient, amountIn, amountOutMin, path, payerIsUser)` 的第三個欄位（router 驗的）。只改前者，
 * router 仍然拿舊地板去擋成交（`AtpExecutor` 的 TODO 也說它今天不會替我們覆寫那個值）。所以這裡用
 * 與規劃時**同一個** `buildStep` 重建 commands/inputs，recipient 與 path（含 fee tier）從原本的
 * `inputs[0]` 解回來 —— 除了地板，這一步不該改任何東西。
 */
export async function refreshFloors(params: {
  publicClient: PublicClient;
  /** 報價來源：`AtpExecutor.oracle()`（hub 模式是 router，它自己再轉給 per-pair oracle）。 */
  oracle: Address;
  steps: readonly PlannedStep[];
  /** `registry.effectiveFeeBps(strategyId)`：`minGross` 的放大倍率，合約用的也是**當下**這個值。 */
  feeBps: number;
  /**
   * 省略 = 不釘塊（讀最新）。**不要**傳規劃時的 `blockNumber`：那正是要被取代的時間點，釘住舊塊
   * 等於沒有重問。
   */
  blockNumber?: bigint;
  /** 地板惡化上限（bps）。預設 `MAX_FLOOR_WORSENING_BPS`。 */
  maxWorseningBps?: number;
}): Promise<RefreshFloorsResult> {
  const { publicClient, oracle, steps, feeBps } = params;
  const maxWorseningBps = params.maxWorseningBps ?? MAX_FLOOR_WORSENING_BPS;
  const refreshes: FloorRefresh[] = [];
  const rebuilt: PlannedStep[] = [];

  for (const [index, step] of steps.entries()) {
    const identity = decodeStepIdentity(step);
    if ('problem' in identity) {
      return { ok: false, kind: 'quote-failed', reason: `送出前重問地板失敗：step#${index} ${identity.problem}` };
    }

    const quote = await publicClient
      .readContract({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: 'previewSwap',
        args: [step.tokenIn, step.tokenOut, step.amountIn],
        blockNumber: params.blockNumber,
      })
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    if (!quote.ok) {
      // 用舊值硬送才是錯的：問不到地板就不知道「現在的下限」是什麼，合約會在 `_checkStep` 裡 revert
      // （oracle 的 revert 或 `NoFloor`）—— 那是把「這一輪不做」變成一次花 gas 的失敗。
      const name = revertNameOf(quote.error);
      return {
        ok: false,
        kind: 'quote-failed',
        reason:
          `送出前重問地板失敗：step#${index} previewSwap(${short(step.tokenIn)} → ${short(step.tokenOut)}, ${step.amountIn})` +
          `（${name ?? (quote.error instanceof Error ? quote.error.message : String(quote.error))}）` +
          '——沒有新鮮的地板就不送（舊值等於一個已經過期的下限）',
      };
    }
    const [, minimum] = quote.result;
    // 合約對 `minimum === 0` 是 revert NoFloor：不是「地板是 0」，是「沒有地板」。
    if (minimum === 0n) {
      return {
        ok: false,
        kind: 'quote-failed',
        reason: `送出前重問地板失敗：step#${index} 的 minimum 是 0（合約會 revert NoFloor）`,
      };
    }

    const freshAmountOutMin = minGrossFor(minimum, feeBps);
    const deltaBps = floorDeltaBps(step.oracleFloor, minimum);
    refreshes.push({
      index,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      plannedFloor: step.oracleFloor,
      freshFloor: minimum,
      plannedAmountOutMin: step.amountOutMin,
      freshAmountOutMin,
      deltaBps,
    });
    rebuilt.push(
      buildStep({
        executor: identity.recipient,
        tokenIn: step.tokenIn,
        tokenOut: step.tokenOut,
        amountIn: step.amountIn,
        oracleFloor: minimum,
        minGross: freshAmountOutMin,
        poolFee: identity.poolFee,
        // 逐字保留原本的路徑（V3 可能多跳；V2 是 address[]）。
        ...(identity.v2Tokens === null ? { path: identity.path } : { v2Tokens: identity.v2Tokens }),
      }),
    );
  }

  const collapsed = refreshes.filter((entry) => entry.deltaBps <= -maxWorseningBps);
  if (collapsed.length > 0) {
    return {
      ok: false,
      kind: 'floor-collapsed',
      reason:
        `送出前重問地板：${collapsed
          .map((entry) => `step#${entry.index} ${short(entry.tokenIn)}→${short(entry.tokenOut)} 差 ${entry.deltaBps} bps`)
          .join('；')}` +
        ` 已超過惡化上限 ${maxWorseningBps} bps → 放棄這一輪（價格前提已不成立，下一輪重新規劃）`,
    };
  }

  return { ok: true, steps: rebuilt, refreshes, note: describeRefreshes(refreshes) };
}

/** 「部分執行」在理由字串裡的那一段。被縮小**不是錯誤**，所以用「⚠ 部分執行」而不是「失敗」。 */
function partialNoteOf(
  leg: { amountIn: bigint; shrunk: { idealAmountIn: bigint; idealImpactBps: number; impactBps: number } | null },
  maxImpactBps: number | null,
): string {
  const shrunk = leg.shrunk;
  if (shrunk === null) return '';
  return (
    `(⚠ partial execution: the ideal ${shrunk.idealAmountIn} would have an estimated impact of ${shrunk.idealImpactBps} bps, ` +
    `which exceeds the ${maxImpactBps} bps budget; sending ${leg.amountIn} instead (${shrunk.impactBps} bps), the rest goes to the next round)`
  );
}

/** 把逐 leg 的縮小證據收成 `ShrunkStep[]`（**只是證據**，不是 partial 的判準；沒有任何一步被縮就是空的）。 */
function shrunkStepsOf(
  legs: readonly {
    amountIn: bigint;
    shrunk: { idealAmountIn: bigint; idealImpactBps: number; impactBps: number } | null;
  }[],
): ShrunkStep[] {
  const shrunk: ShrunkStep[] = [];
  legs.forEach((leg, index) => {
    if (leg.shrunk === null) return;
    shrunk.push({
      index,
      idealAmountIn: leg.shrunk.idealAmountIn,
      amountIn: leg.amountIn,
      idealImpactBps: leg.shrunk.idealImpactBps,
      impactBps: leg.shrunk.impactBps,
    });
  });
  return shrunk;
}

/**
 * 依 `steps` 執行之後的**預估持倉 → 預估漂移**。這是 `partial` 的唯一判準，也是「這份計畫值不值得送」
 * 的守衛：判的是**結果**（還差多少），不是**過程**（有沒有被縮）。
 *
 * 用 `amountIn` 與 `amountOutMin` 推估 —— `amountOutMin` 是合約保證的地板（不是報價），拿它當到手量
 * 是**悲觀**方向：低估改善 → 傾向判定「還有缺口」→ 較短的跟進間隔，不會漏掉還沒做完的工作。
 *
 * **算不出來就回 `null`，不要回一個錯的答案。** step 的 `tokenOut` 不在持倉裡（＝這一輪要**買進一個
 * 現在沒有的資產**）時，那個買到的量沒有地方可加 —— 只把賣掉的一邊扣掉，等於宣稱「賣掉的憑空消失」，
 * 漂移會算成 5000 bps（單一資產佔滿）。那不是悲觀，那是**錯的**：它會讓「不改善就不送」的守衛
 * 把每一個正常的新建倉都判成 noop。
 *
 * 呼叫端拿到 `null` 的語意是「不知道」：**不套用不改善守衛**（fail-open），理由寫在 rationale 裡。
 * 誤擋一個正常的新建倉，比多付一次 gas 貴得多。
 */
function driftAfterSteps(
  holdings: readonly Holding[],
  targets: readonly TargetWeight[],
  steps: readonly PlannedStep[],
  thresholdBps: number,
): DriftReport | null {
  const known = new Set(holdings.map((holding) => holding.asset.toLowerCase()));
  for (const step of steps) {
    if (!known.has(step.tokenIn.toLowerCase()) || !known.has(step.tokenOut.toLowerCase())) return null;
  }
  const post = holdings.map((holding) => {
    let amountWei = holding.amountWei;
    for (const step of steps) {
      if (sameAsset(step.tokenIn, holding.asset)) amountWei -= step.amountIn;
      if (sameAsset(step.tokenOut, holding.asset)) amountWei += step.amountOutMin;
    }
    return { ...holding, amountWei };
  });
  return computeDrift(post, targets, thresholdBps);
}

/** 地址比對一律不分大小寫（holdings 的 asset 來自 DB，大小寫不保證與鏈上讀值一致）。 */
function sameAsset(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 「這份計畫不會改善漂移，所以不送」的理由。用 `>=` 而不是 `>`：估計值可能剛好相等（整數截斷、
 * 同一筆錢在兩邊互相抵銷），而「不嚴格改善」就沒有付 gas 的價值。
 */
function noImprovementReason(pre: DriftReport, post: DriftReport, stepCount: number, tail: string): string {
  return (
    `Not sending: this plan (${stepCount} step(s)) would leave estimated drift at ${post.grossDriftBps} bps, ` +
    `which is not below the current ${pre.grossDriftBps} bps — sending it would only cost gas${tail}`
  );
}

/** 理由裡「執行後預估漂移」那一段：收斂與「還有缺口」要用不同的字樣，否則人看不出為什麼下一輪那麼近。 */
function describePostDrift(pre: DriftReport, post: DriftReport | null, partial: PlanPartial | null): string {
  if (post === null) {
    return (
      `執行後漂移算不出來（現在 ${pre.grossDriftBps} bps、門檻 ${pre.thresholdBps} bps）：` +
      '這一輪要買進現在沒有持倉的資產，那筆到手量沒有價格可估 → 不套用「不改善就不送」的守衛'
    );
  }
  const head = `Estimated drift after this round ${post.grossDriftBps} bps (now ${pre.grossDriftBps}, threshold ${post.thresholdBps} bps)`;
  if (partial === null) return `${head} → converged; this round is the whole job`;
  const shrunkNote =
    partial.shrunk.length === 0
      ? 'the gap was skipped rather than shrunk'
      : `${partial.shrunk.length} step(s) were shrunk by the impact budget`;
  return `${head} → still above the threshold; work remains (${shrunkNote}), the rest goes to the next round`;
}

/**
 * `maxImpactBps` 的三態解析：`undefined` → 預設 50（**預設是開的**）、`null` → 關掉、整數 → 用它。
 * 放在 `planRebalance` 的最前面驗一次，兩條路徑（hub / pinned）共用同一個值。
 */
export function resolveMaxImpactBps(value: number | null | undefined): number | null {
  if (value === null) return null;
  if (value === undefined) return DEFAULT_MAX_IMPACT_BPS;
  if (!Number.isInteger(value) || value < 1 || value >= BPS_DENOMINATOR) {
    throw new RangeError(`maxImpactBps must be an integer in 1..9999（或 null = 關掉）, got ${String(value)}`);
  }
  return value;
}

/**
 * oracle 是哪一種形狀。**先問 pinned 的介面，再問 hub 的介面**，理由是可觀測性：
 * 舊堆疊（測試與 `refresh-anvil.sh` 釘住的那條路）因此一次多餘的呼叫都不花，
 * 而新堆疊只多花三次註定 revert 的呼叫（`AtpMultiPoolOracle` 沒有 `pool()`）。
 */
type OracleShape =
  | { kind: 'pinned'; pool: Address; token0: Address; token1: Address }
  | { kind: 'hub'; numeraire: Address }
  | { kind: 'unknown'; detail: string };

async function detectOracleShape(
  client: PublicClient,
  oracle: Address,
  blockNumber: bigint,
): Promise<OracleShape> {
  const [pool, token0, token1] = await Promise.allSettled([
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'pool', blockNumber }),
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'token0', blockNumber }),
    client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'token1', blockNumber }),
  ]);
  if (pool.status === 'fulfilled' && token0.status === 'fulfilled' && token1.status === 'fulfilled') {
    return { kind: 'pinned', pool: pool.value, token0: token0.value, token1: token1.value };
  }
  const numeraire = await client
    .readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'numeraire', blockNumber })
    .catch(() => null);
  if (isAddressLike(numeraire)) return { kind: 'hub', numeraire: getAddress(numeraire) };

  const detail =
    pool.status === 'rejected'
      ? pool.reason instanceof Error
        ? pool.reason.message.split('\n')[0]
        : String(pool.reason)
      : 'pool() 有回，但 token0/token1 沒有';
  return {
    kind: 'unknown',
    detail:
      `oracle ${short(oracle)} 既沒有單池介面（pool/token0/token1）也沒有 numeraire()：` +
      `cannot tell which pairs it can quote (${detail})`,
  };
}

/** 一個已定價的 leg：floor 與 path 的池子 fee 都到手了，只差 minGross（需要 feeBps）。 */
type PricedLeg = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** 依漂移算出來的量（夾取前），只給理由字串用。 */
  requested: bigint;
  clamped: boolean;
  /** 這一輪真正會拿去向 oracle 要地板的量（＝ impact 上限縮小之後的量）。 */
  oracleQuoted: bigint;
  oracleFloor: bigint;
  poolFee: number;
  /** 實際成交的 V3 path（可能多跳，見 routing.ts）。 */
  path: Hex;
  /** 有值 = 走 V2 路線；null = 走 `path` 的 V3 路線。 */
  v2Tokens: Address[] | null;
  /** 被價格衝擊上限縮小的證據（null = 沒被縮）。 */
  shrunk: { idealAmountIn: bigint; idealImpactBps: number; impactBps: number } | null;
  /** 估不出衝擊（放行原量）的說明。 */
  impactNote: string | null;
};

/** hub 模式一個 leg 的池子三件套：per-pair oracle（報價用）、池子（fee 與衝擊估算用）、fee tier。 */
type HubPair = { pairOracle: Address; pool: Address; poolFee: number };

/**
 * 為一個 hub leg 找 per-pair oracle、池子與 fee tier。**任何一項要不到就回 `skip`**（呼叫端記進
 * rationale 並跳過那一步），不是 throw 也不是整份 blocked：沒有池的資產是市場狀態，不是程式錯誤。
 *
 * 拆成「找池子」與「報價」兩步（見 `quoteHub`）是為了讓衝擊上限可以在**同一個池子**上換量重問，
 * 不必把 oracleOf/pool/fee 再問一次。
 */
async function resolveHubPair(
  client: PublicClient,
  params: { router: Address; asset: Address; blockNumber: bigint },
): Promise<HubPair | { skip: string }> {
  const { router, asset, blockNumber } = params;
  const pairOracle = await client
    .readContract({
      address: router,
      abi: ORACLE_ABI,
      functionName: 'oracleOf',
      args: [asset],
      blockNumber,
    })
    .catch(() => null);
  if (!isAddressLike(pairOracle)) {
    return { skip: `router 沒有為 ${short(asset)} 註冊 oracle（合約會 revert OracleNotSet）` };
  }
  const pool = await client
    .readContract({ address: getAddress(pairOracle), abi: ORACLE_ABI, functionName: 'pool', blockNumber })
    .catch(() => null);
  if (!isAddressLike(pool)) return { skip: `${short(asset)} 的 per-pair oracle 沒有 pool()，算不出 path 的 fee` };
  const poolFee = await client
    .readContract({ address: getAddress(pool), abi: V3_POOL_ABI, functionName: 'fee', blockNumber })
    .catch(() => null);
  if (poolFee === null) return { skip: `${short(pool)} 的 fee() 讀不到，path 的 fee 只能用猜的` };
  return { pairOracle: getAddress(pairOracle), pool: getAddress(pool), poolFee: Number(poolFee) };
}

/** 向 router 要一個量的 TWAP 報價與地板。報不出價／地板是 0 都回 `skip`（呼叫端跳過那一步）。 */
async function quoteHub(
  client: PublicClient,
  params: { router: Address; tokenIn: Address; tokenOut: Address; amountIn: bigint; blockNumber: bigint },
): Promise<{ quoted: bigint; floor: bigint } | { skip: string }> {
  const { router, tokenIn, tokenOut, amountIn, blockNumber } = params;
  const quote = await client
    .readContract({
      address: router,
      abi: ORACLE_ABI,
      functionName: 'previewSwap',
      args: [tokenIn, tokenOut, amountIn],
      blockNumber,
    })
    .then((result) => ({ ok: true as const, result }))
    .catch((error: unknown) => ({ ok: false as const, error }));
  if (!quote.ok) {
    const name = revertNameOf(quote.error);
    return {
      skip:
        `previewSwap(${short(tokenIn)} → ${short(tokenOut)}, ${amountIn}) cannot quote right now` +
        `（${name ?? (quote.error instanceof Error ? quote.error.message : String(quote.error))}）`,
    };
  }
  const [quoted, minimum] = quote.result;
  // 合約對 minimum === 0 是 revert NoFloor：不是「地板是 0」，是「沒有地板」。
  if (minimum === 0n) return { skip: 'previewSwap 的 minimum 是 0（合約會 revert NoFloor）' };
  return { quoted, floor: minimum };
}



/**
 * TWAP 與現價偏離的容忍上限（bps）。
 *
 * 為什麼需要：`previewSwap` 只看 TWAP。池子的觀察歷史若壞掉（ring buffer 沒填、fork 上時間軸
 * 不一致），`observe` 會回一個極端 tick，TWAP 就被夾到 MAX/MIN_TICK，報價變成天文數字。
 * 那不是「價格不好」，是**報價壞了**，而合約只會在下限檢查時 revert 整批 —— 一個壞掉的 leg
 * 會把其他四個好的 leg 一起拖下水（實測：DOGE 池在 fork 塊上 TWAP = MAX_TICK，報價 1.6e57）。
 *
 * 30 分鐘均價偏離現價 50% 已經不是「走勢」，是資料問題；跳過該 leg 讓排程器下一輪再試，
 * 比送一筆必然 revert 的交易好。
 */
const MAX_TWAP_SPOT_DEVIATION_BPS = 5000n;

/**
 * 用池子的 `slot0` 算現價報價（raw 單位，含小數），再跟 TWAP 報價比。
 * 讀不到 `slot0` 就回 `null`（放行：沒有證據說它壞）。
 */
async function twapSpotDeviationBps(params: {
  client: PublicClient;
  pool: Address;
  tokenIn: Address;
  amountIn: bigint;
  quoted: bigint;
  blockNumber: bigint;
}): Promise<number | null> {
  const [token0, slot0] = await Promise.allSettled([
    params.client.readContract({ address: params.pool, abi: V3_POOL_ABI, functionName: 'token0', blockNumber: params.blockNumber }),
    params.client.readContract({ address: params.pool, abi: V3_POOL_ABI, functionName: 'slot0', blockNumber: params.blockNumber }),
  ]);
  if (token0.status !== 'fulfilled' || slot0.status !== 'fulfilled') return null;

  const sqrtPriceX96 = BigInt(slot0.value[0]);
  if (sqrtPriceX96 === 0n) return null;
  const ratioX128 = (sqrtPriceX96 * sqrtPriceX96) >> 64n;
  if (ratioX128 === 0n) return null;

  const inIsToken0 = String(token0.value).toLowerCase() === params.tokenIn.toLowerCase();
  const spot = inIsToken0 ? (params.amountIn * ratioX128) >> 128n : (params.amountIn << 128n) / ratioX128;
  if (spot === 0n) return null;

  const diff = params.quoted > spot ? params.quoted - spot : spot - params.quoted;
  return Number((diff * 10_000n) / spot);
}

/**
 * 讀估算衝擊所需的池子狀態：`slot0()`（現貨 √P）、`liquidity()`（當前 tick 區間）、`token0()`
 * （決定這筆是 token0 進還是 token1 進）。三個都是唯讀，全部釘在同一個 `blockNumber`。
 *
 * **讀不到就回 `null`，不拋**：衝擊上限是「讓大額再平衡不要必然 revert」的軟性護欄，不是安全不變量
 * （真正的安全不變量是 oracle 地板，它在鏈上驗）。所以讀不到時**放行原量**並在 rationale 記錄，
 * 而不是把一筆本來能過的再平衡擋掉。
 */
async function readPoolImpactState(
  client: PublicClient,
  pool: Address,
  tokenIn: Address,
  blockNumber: bigint,
): Promise<PoolImpactState | null> {
  const [token0, slot0, liquidity] = await Promise.allSettled([
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'token0', blockNumber }),
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'slot0', blockNumber }),
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'liquidity', blockNumber }),
  ]);
  if (token0.status !== 'fulfilled' || slot0.status !== 'fulfilled' || liquidity.status !== 'fulfilled') {
    return null;
  }
  // 池子的 token0 與這筆的 tokenIn 都對不上 → 這不是那個池子的交易，估算沒有意義。
  const inIsToken0 = String(token0.value).toLowerCase() === tokenIn.toLowerCase();
  return {
    sqrtPriceX96: slot0.value[0],
    liquidity: liquidity.value,
    tokenInIsToken0: inIsToken0,
    feeUnits: 0,
  };
}

/** 一個 leg 經過衝擊上限處理之後的樣子。 */
type ImpactCappedLeg = {
  amountIn: bigint;
  quoted: bigint;
  floor: bigint;
  /** 被縮小的證據；`null` = 理想量本來就在預算內（**行為與沒有這個功能時完全相同**）。 */
  shrunk: { idealAmountIn: bigint; idealImpactBps: number; impactBps: number } | null;
  /** 估算不出來（放行原量）的說明，會進 rationale。 */
  note: string | null;
};

/**
 * 把一個 leg 的量夾到「估算衝擊 ≤ `maxImpactBps`」的最大值。
 *
 * 縮小之後**必須重問一次 floor**：`previewSwap` 的 `minimum` 是那個量的 TWAP 報價打折，
 * 換一個量就是另一個地板。`requote` 由呼叫端提供（hub 模式問 per-pair oracle、pinned 模式問
 * oracle 本身），這樣這一段不必知道路由長什麼樣。
 *
 * 三種失敗都回 `{ skip }`（呼叫端記進 rationale 並跳過那一步，不是整份 blocked）：
 *   * 連 1 個最小單位都超預算 → 是 baseline（fee + 現貨 vs TWAP）的問題，切多小都沒用；
 *   * 縮到 0 或 dust（< `MIN_STEP_BPS_OF_IDEAL` bp of 理想量）；
 *   * 縮小之後重問 floor 失敗（同一個 leg 原本可能可以，只是現在報不出價）。
 */
async function capLegByImpact(params: {
  client: PublicClient;
  blockNumber: bigint;
  /** `null` = 關掉上限（不讀池子狀態）。 */
  maxImpactBps: number | null;
  label: string;
  pool: Address;
  tokenIn: Address;
  amountIn: bigint;
  quoted: bigint;
  floor: bigint;
  poolFeeUnits: number;
  requote: (amountIn: bigint) => Promise<{ quoted: bigint; floor: bigint } | { skip: string }>;
}): Promise<ImpactCappedLeg | { skip: string }> {
  const { client, blockNumber, maxImpactBps, label, pool, tokenIn, amountIn, quoted, floor } = params;
  const unchanged: ImpactCappedLeg = { amountIn, quoted, floor, shrunk: null, note: null };
  if (maxImpactBps === null) return unchanged;

  const read = await readPoolImpactState(client, pool, tokenIn, blockNumber);
  if (read === null) {
    return {
      ...unchanged,
      note: `${label}：${short(pool)} 的 slot0/liquidity/token0 讀不到，估不出衝擊，照原量送出（上限未套用）`,
    };
  }
  const state: PoolImpactState = { ...read, feeUnits: params.poolFeeUnits };
  const problem = impactStateProblem(state);
  if (problem !== null) {
    return { ...unchanged, note: `${label}：${short(pool)} 估不出衝擊（${problem}），照原量送出（上限未套用）` };
  }

  const cap = capAmountInForImpact({ state, idealAmountIn: amountIn, idealQuoted: quoted, maxImpactBps });
  if (!cap.shrunk) return unchanged;

  if (cap.amountIn === 0n || cap.amountIn * BPS_BIG < amountIn * BigInt(MIN_STEP_BPS_OF_IDEAL)) {
    return {
      skip:
        `${label}: estimated impact ${cap.idealEstimate.impactBps} bps exceeds the ${maxImpactBps} bps budget; ` +
        `shrinking leaves ${cap.amountIn} (ideal ${amountIn}), ` +
        (cap.noSizeFits
          ? `even one minimal unit is over budget: the existing spot-vs-TWAP gap plus pool fee is already ${cap.idealEstimate.baselineBps} bps, ` +
            'no size fixes that (it is not a size problem), so this round sends nothing'
          : `below ${MIN_STEP_BPS_OF_IDEAL} bp of the ideal amount (dust); sending it would only cost gas`),
    };
  }

  const requoted = await params.requote(cap.amountIn);
  if ('skip' in requoted) {
    return { skip: `${label}: re-quoting a floor after shrinking to ${cap.amountIn} failed (${requoted.skip})` };
  }
  // 用**重問回來的** quoted 再算一次：那才是真正要拿去跟地板比的那個量。
  const finalEstimate = estimateImpact(state, cap.amountIn, requoted.quoted);
  return {
    amountIn: cap.amountIn,
    quoted: requoted.quoted,
    floor: requoted.floor,
    shrunk: {
      idealAmountIn: amountIn,
      idealImpactBps: cap.idealEstimate.impactBps,
      impactBps: finalEstimate.impactBps,
    },
    note: null,
  };
}

/**
 * hub 模式：N 資產、以 numeraire 為中央。步驟順序是 **先所有賣、再所有買**，因為買的 USDT 只會來自
 * 前面那些賣（executor 逐 step 從帳戶拉 `tokenIn`，同一個 tx、同一個帳戶餘額）。
 */
async function planHub(
  args: PlanRebalanceArgs,
  hub: Address,
  deps: PlanRebalanceDeps,
  deadlineSeconds: number,
  maxImpactBps: number | null,
): Promise<RebalancePlan> {
  const { publicClient, executor, oracle, registry, strategyId, holdings, targets, drift, blockNumber } = args;
  const hubKey = hub.toLowerCase();

  // 約束 ①：執行器只換 version.assets 裡的代幣（AtpExecutor.sol:180-182）。hub 不在裡面 →
  // 賣出的 USDT 沒有落點、買的 USDT 也付不出來，這不是「沒事可做」而是「這條路走不通」。
  if (!targets.some((target) => target.asset.toLowerCase() === hubKey)) {
    return {
      kind: 'blocked',
      reason:
        `目標權重裡沒有 numeraire ${short(hub)}（targets: ${targets.map((target) => short(target.asset)).join('、')}）：` +
        'executor 只換 version.assets 裡的代幣（AtpExecutor.sol:180-182 AssetNotAllowed），' +
        'hub 不是策略資產就收不了賣出的 USDT、也付不出買的 USDT。把 USDT 加進 version.assets 才能走 hub 路徑。',
    };
  }

  const holdingsByAsset = new Map<string, Holding>();
  for (const holding of holdings) holdingsByAsset.set(holding.asset.toLowerCase(), holding);
  const driftByAsset = new Map<string, (typeof drift.assets)[number]>();
  for (const row of drift.assets) driftByAsset.set(row.asset.toLowerCase(), row);
  const hubHolding = holdingsByAsset.get(hubKey);

  // 約束 ③：deltaUsd_i = 實際 USD − 目標 USD，目標值取上界（ceil）→「該賣的量」只會少不會多。
  const legs: { asset: Address; row: (typeof drift.assets)[number]; deltaUsdE8: bigint }[] = [];
  for (const target of targets) {
    const key = target.asset.toLowerCase();
    if (key === hubKey) continue;
    const row = driftByAsset.get(key);
    if (row === undefined) {
      return {
        kind: 'blocked',
        reason: `drift.assets 少了目標資產 ${target.asset}：drift 與 targets 來自不同的宇宙，不能規劃`,
      };
    }
    const targetUsdE8 = ceilDiv(BigInt(row.targetBps) * drift.totalUsdE8, BPS_BIG);
    legs.push({ asset: getAddress(target.asset), row, deltaUsdE8: row.usdValueE8 - targetUsdE8 });
  }

  const notes: string[] = [];
  const priced: PricedLeg[] = [];
  let head: Head | null = null;
  const ensureHead = async (): Promise<{ blocked: string } | Head> => {
    if (head === null) {
      const result = await readHead(publicClient, registry, strategyId, blockNumber, deps.blockTimestampSeconds);
      if ('blocked' in result) return result;
      head = result;
    }
    return head;
  };

  /**
   * 一個 leg 的完整定價路徑：找池子 → 要 floor → 套價格衝擊上限（可能換量重問一次 floor）。
   * 賣與買共用這一段，因為「衝擊上限」與方向無關；差別只在 tokenIn/tokenOut。
   */
  const priceAndCap = async (params: {
    label: string;
    /** 非 numeraire 的那一邊：決定用哪個 per-pair oracle。 */
    asset: Address;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
  }): Promise<(ImpactCappedLeg & { poolFee: number; path: Hex; v2Tokens: Address[] | null }) | { skip: string }> => {
    const pair = await resolveHubPair(publicClient, { router: oracle, asset: params.asset, blockNumber });
    if ('skip' in pair) return pair;
    const first = await quoteHub(publicClient, {
      router: oracle,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      blockNumber,
    });
    if ('skip' in first) return first;
    // TWAP 壞掉時報價會是天文數字；先跟現價比一下再決定要不要用這一步。
    const deviationBps = await twapSpotDeviationBps({
      client: publicClient,
      pool: pair.pool,
      tokenIn: params.tokenIn,
      amountIn: params.amountIn,
      quoted: first.quoted,
      blockNumber,
    });
    if (deviationBps !== null && deviationBps > Number(MAX_TWAP_SPOT_DEVIATION_BPS)) {
      return {
        skip:
          `${params.label} 的 TWAP 報價與池子現價偏離 ${deviationBps} bps（上限 ${MAX_TWAP_SPOT_DEVIATION_BPS}）：` +
          '池子的觀察歷史可能壞了，這一輪跳過（合約會用 TWAP 地板，送出去必然 revert 整批）',
      };
    }
    // 先選路徑，再用**那條路徑**估衝擊。
    //
    // 順序很重要：`capLegByImpact` 讀的是 oracle 釘住那個池子的 slot0/liquidity。
    // 對 DOGE 來說那是 fee=10000（1%）的池子 —— 衝擊永遠 99 bps，不管我們實際走哪條路，
    // 於是這一檔永遠被 80 bps 的預算擋下。改用「實際路徑的邊際價 vs 大額價」才量得準。
    const route = await chooseBestPath(publicClient, {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      via: WBNB_ADDRESS,
      factory: V3_FACTORY_ADDRESS,
      // ⚠ V2 預設**關閉**。
      //
      // 實測（主網，2026-11）：`Cmd.V2_SWAP_EXACT_IN`（0x08）在 Pancake 的 Universal Router 上
      // 送出後，UserOp 模擬直接 revert 成裸 `0x`（無 reason）—— 那是「路由器不認這個 command」
      // 的典型形狀。我們的 executor allowlist 有它，但**從來沒有在主網真的跑過**。
      //
      // 所以預設關閉、只走 V3；等用 `cast call` 對 Universal Router 驗證過 V2 指令真的可用，
      // 再設 `ROUTE_V2_ENABLED=1` 打開。安全性優先：寧可走差一點的路，也不要送出一筆必 revert 的交易。
      v2Factory: process.env.ROUTE_V2_ENABLED === '1' ? V2_FACTORY_ADDRESS : null,
      pinnedFee: pair.poolFee,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    const routePath = route?.kind === 'v3' ? route.path : null;
    const routeTokens = route?.kind === 'v2' ? route.tokens : null;
    const path = routePath ?? singleHopPath(params.tokenIn, pair.poolFee, params.tokenOut);

    // 衝擊只能用 V3 的 quoter 量（V2 沒有等價的邊際報價端點）。V2 路線時回 null →
    // 下一段會退回池子數學（保守），而不是把 V2 路線當成 0 衝擊放行。
    const routeImpact =
      routePath === null
        ? null
        : await routeImpactBps(publicClient, {
            path: routePath,
            amountIn: params.amountIn,
            ...(blockNumber === undefined ? {} : { blockNumber }),
          });

    if (routeImpact !== null) {
      // 有了準確的路徑衝擊，直接用；不再退回池子數學（那會量到別人的手續費）。
      if (maxImpactBps !== null && routeImpact > maxImpactBps) {
        return {
          skip:
            `${params.label}: route impact ${routeImpact} bps exceeds the ${maxImpactBps} bps budget ` +
            `(path ${route?.hops ?? 1} hop(s)) — the pool cannot absorb this size without moving the price`,
        };
      }
      return {
        amountIn: params.amountIn,
        quoted: first.quoted,
        floor: first.floor,
        shrunk: null,
        note:
          route === null || route.hops === 1
            ? null
            : `routed via ${route.kind === 'v2' ? 'V2' : 'V3'} ${route.hops} hops, impact ${routeImpact} bps`,
        poolFee: pair.poolFee,
        path,
        v2Tokens: routeTokens,
      };
    }

    // 拿不到路徑報價（quoter 全 revert）→ 退回原本的池子數學，維持既有行為。
    const capped = await capLegByImpact({
      client: publicClient,
      blockNumber,
      maxImpactBps,
      label: params.label,
      pool: pair.pool,
      tokenIn: params.tokenIn,
      amountIn: params.amountIn,
      quoted: first.quoted,
      floor: first.floor,
      poolFeeUnits: pair.poolFee,
      requote: async (amountIn: bigint) => {
        const again = await quoteHub(publicClient, {
          router: oracle,
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn,
          blockNumber,
        });
        return 'skip' in again ? again : { quoted: again.quoted, floor: again.floor };
      },
    });
    if ('skip' in capped) return capped;
    return { ...capped, poolFee: pair.poolFee, path, v2Tokens: null };
  };

  // ---- ① 先所有賣 ----
  for (const leg of legs) {
    if (leg.deltaUsdE8 <= 0n) continue;
    const holding = holdingsByAsset.get(leg.asset.toLowerCase());
    if (holding === undefined) {
      notes.push(`${short(leg.asset)} 超配 ${leg.deltaUsdE8} E8 USD，但 holdings 裡沒有它（沒有 decimals／價格），跳過這一步`);
      continue;
    }
    if (holding.usdPriceE8 <= 0n) {
      notes.push(`${short(leg.asset)} 的 usdPriceE8 是 ${holding.usdPriceE8}，算不出賣出量，跳過這一步`);
      continue;
    }
    const requested = amountInFor(leg.deltaUsdE8, holding.usdPriceE8, holding.decimals);
    const amountIn = requested > holding.amountWei ? holding.amountWei : requested;
    if (amountIn === 0n) {
      notes.push(
        `${short(leg.asset)} 該賣 ${leg.deltaUsdE8} E8 USD，換算成最小單位是 0（合約對 amountIn == 0 revert ZeroAmount），跳過這一步`,
      );
      continue;
    }
    if (amountIn > UINT160_MAX) {
      return {
        kind: 'blocked',
        reason:
          `賣 ${short(leg.asset)} 的 amountIn ${amountIn} 超過 uint160 上限 ${UINT160_MAX}：` +
          '合約會 revert AmountTooLarge（Permit2 的 allowance 是 uint160）',
      };
    }
    const capped = await priceAndCap({
      label: `sell ${short(leg.asset)} for USDT`,
      asset: leg.asset,
      tokenIn: leg.asset,
      tokenOut: hub,
      amountIn,
    });
    if ('skip' in capped) {
      notes.push(`賣 ${short(leg.asset)} 換 USDT 被跳過：${capped.skip}`);
      continue;
    }
    priced.push({
      tokenIn: leg.asset,
      tokenOut: hub,
      amountIn: capped.amountIn,
      requested,
      clamped: amountIn < requested,
      oracleQuoted: capped.quoted,
      oracleFloor: capped.floor,
      poolFee: capped.poolFee,
      path: capped.path,
      v2Tokens: capped.v2Tokens,
      shrunk: capped.shrunk,
      impactNote: capped.note,
    });
  }
  const sellCount = priced.length;

  // ---- ② 再所有買：USDT 預算 = 現有持倉 + 前面賣出的**保證淨額** ----
  // 用 `floor − fee` 而不是 `quoted`：quoted 是報價，floor 才是合約保證收得到的量，而 fee 會從 gross
  // 分走（`_splitFee`），所以帳戶實收至少 `floor − floor×feeBps/10000`。
  let sellFeeBps = 0;
  if (sellCount > 0) {
    const headResult = await ensureHead();
    if ('blocked' in headResult) return { kind: 'blocked', reason: headResult.blocked };
    sellFeeBps = headResult.feeBps;
  }
  const sellProceeds = priced
    .slice(0, sellCount)
    .reduce((sum, leg) => sum + leg.oracleFloor - (leg.oracleFloor * BigInt(sellFeeBps)) / BPS_BIG, 0n);
  const spendable = (hubHolding?.amountWei ?? 0n) + sellProceeds;
  let spent = 0n;

  for (const leg of legs) {
    if (leg.deltaUsdE8 >= 0n) continue;
    if (hubHolding === undefined) {
      notes.push(`holdings 裡沒有 numeraire ${short(hub)}（沒有 decimals／價格），算不出要付多少 USDT，跳過買 ${short(leg.asset)}`);
      continue;
    }
    if (hubHolding.usdPriceE8 <= 0n) {
      notes.push(`numeraire 的 usdPriceE8 是 ${hubHolding.usdPriceE8}，算不出要付多少 USDT，跳過買 ${short(leg.asset)}`);
      continue;
    }
    const requested = amountInFor(-leg.deltaUsdE8, hubHolding.usdPriceE8, hubHolding.decimals);
    const remaining = spendable - spent;
    if (remaining <= 0n) {
      notes.push(
        `USDT 預算用盡（現有 ${hubHolding.amountWei} + 賣出保證 ${sellProceeds} = ${spendable}，已付 ${spent}），跳過買 ${short(leg.asset)}`,
      );
      continue;
    }
    const amountIn = requested > remaining ? remaining : requested;
    if (amountIn === 0n) {
      notes.push(`買 ${short(leg.asset)} 要付 ${requested} 但只剩 ${remaining} USDT 最小單位，夾到 0，跳過這一步`);
      continue;
    }
    const capped = await priceAndCap({
      label: `buy ${short(leg.asset)} (paying USDT)`,
      asset: leg.asset,
      tokenIn: hub,
      tokenOut: leg.asset,
      amountIn,
    });
    if ('skip' in capped) {
      notes.push(`買 ${short(leg.asset)}（付 ${amountIn} USDT）被跳過：${capped.skip}`);
      continue;
    }
    priced.push({
      tokenIn: hub,
      tokenOut: leg.asset,
      amountIn: capped.amountIn,
      requested,
      clamped: amountIn < requested,
      oracleQuoted: capped.quoted,
      oracleFloor: capped.floor,
      poolFee: capped.poolFee,
      path: capped.path,
      v2Tokens: capped.v2Tokens,
      shrunk: capped.shrunk,
      impactNote: capped.note,
    });
    // 用的是**實際**付出去的量（可能已被衝擊上限縮小），不是夾取前的理想量。
    spent += capped.amountIn;
  }

  // 全部都被跳過 → noop（絕對不回空的 steps：pitfalls §8.1）。
  if (priced.length === 0) {
    return {
      kind: 'noop',
      reason:
        `Hub mode (numeraire ${short(hub)}) produced no executable step: ` +
        `${notes.length === 0 ? 'no non-numeraire target assets, or every deltaUsd is 0' : notes.join('; ')}. Not sending empty steps.`,
    };
  }

  const headResult = await ensureHead();
  if ('blocked' in headResult) return { kind: 'blocked', reason: headResult.blocked };
  const { feeBps: fee, blockTimestamp } = headResult;
  const { base: deadlineBaseSeconds, source: deadlineSource } = deadlineBase(blockTimestamp);
  const deadline = deadlineBaseSeconds + BigInt(deadlineSeconds);

  const steps = priced.map((leg) => {
    const minGross = minGrossFor(leg.oracleFloor, fee);
    return buildStep({
      executor,
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      amountIn: leg.amountIn,
      oracleFloor: leg.oracleFloor,
      minGross,
      poolFee: leg.poolFee,
      path: leg.path,
      v2Tokens: leg.v2Tokens,
    });
  });

  const legNotes = priced.map((leg, index) => {
    const row = driftByAsset.get(
      (leg.tokenIn.toLowerCase() === hubKey ? leg.tokenOut : leg.tokenIn).toLowerCase(),
    );
    const isSell = leg.tokenIn.toLowerCase() !== hubKey;
    return (
      `step ${index} ${isSell ? '賣' : '買'} ${short(isSell ? leg.tokenIn : leg.tokenOut)}` +
      `（現況 ${row?.currentBps ?? '?'} / 目標 ${row?.targetBps ?? '?'} bps）` +
      ` amountIn ${leg.amountIn}${leg.clamped ? `（夾取：依漂移算出 ${leg.requested}）` : ''}` +
      `${partialNoteOf(leg, maxImpactBps)}` +
      `、oracleFloor ${leg.oracleFloor}、minGross ${minGrossFor(leg.oracleFloor, fee)}`
    );
  });

  // 判準是**執行後的預估漂移**：不改善就不送（付 gas 換一個不動的數字），仍高於門檻才算 partial。
  const postDrift = driftAfterSteps(holdings, targets, steps, args.thresholdBps);
  // `null` = 算不出來（要買進現在沒有持倉的資產）→ **不套用**不改善守衛。誤擋一個正常的新建倉
  // 比多付一次 gas 貴得多；rationale 會說出來，所以這個放行是可觀測的。
  if (postDrift !== null && postDrift.grossDriftBps >= drift.grossDriftBps) {
    return {
      kind: 'noop',
      reason: noImprovementReason(
        drift,
        postDrift,
        steps.length,
        notes.length === 0 ? '' : `; ${notes.length} skipped: ${notes.join('; ')}`,
      ),
    };
  }
  // 算不出來時用**現在的**漂移當剩餘量的上界：不宣稱收斂，也不謊報一個算不出來的數字。
  const partial: PlanPartial | null =
    postDrift === null
      ? // 算不出來就說算不出來：`null` 而不是拿 pre 的數字濫竽充數。
        { remainingDriftBps: null, shrunk: shrunkStepsOf(priced) }
      : postDrift.needsRebalance
        ? { remainingDriftBps: postDrift.grossDriftBps, shrunk: shrunkStepsOf(priced) }
        : null;
  const impactNotes = priced
    .map((leg) => leg.impactNote)
    .filter((note): note is string => note !== null);

  const rationale = [
    `hub 模式：numeraire ${short(hub)}（${targets.length - 1} 個非 hub 資產、${steps.length} 個 step，` +
      `${priced.slice(0, sellCount).length} 賣 / ${priced.length - sellCount} 買，賣全排在買前面）`,
    ...legNotes,
    `USDT 預算：現有 ${hubHolding?.amountWei ?? 0n} + 賣出保證淨額 ${sellProceeds} = ${spendable}，實際付出 ${spent}`,
    `fee ${fee} bps（registry.effectiveFeeBps(${strategyId})）；block ${blockNumber} 時間 ${blockTimestamp}；` +
      `deadline 基準 max(塊時間, 牆鐘) = ${deadlineBaseSeconds}（取${deadlineSource === 'chain' ? '塊時間' : '牆鐘'}）` +
      ` + ${deadlineSeconds}s = deadline ${deadline}`,
    ...(notes.length === 0 ? ['沒有任何步驟被跳過'] : [`被跳過 ${notes.length} 筆：${notes.join('；')}`]),
    ...(impactNotes.length === 0 ? [] : [`衝擊上限 ${maxImpactBps} bps 未套用在 ${impactNotes.length} 步：${impactNotes.join('；')}`]),
    describePostDrift(drift, postDrift, partial),
  ].join('；');

  return { kind: 'ready', steps, deadline, rationale, ...(partial === null ? {} : { partial }) };
}

/** pinned 路徑裡「已算好、只差問鏈」的那一筆：全部是純算術的結果，不含任何鏈上讀取。 */
type PinnedLeg = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  requested: bigint;
  clamped: boolean;
  valueToMoveE8: bigint;
  sellerDecimals: number;
  sellerHoldingWei: bigint;
  sellerRow: AssetDrift;
  buyerRow: AssetDrift;
};

/**
 * pinned（舊的單一 pair）路徑的「先算再看鏈」部分：目標剛好兩個資產時，賣方、賣出量、夾取全都是
 * 純算術。回 `reply` 就是這份規劃已經有答案（noop/blocked，而且一次鏈上讀取都不必），
 * 回 `leg` 才是「要問鏈才有答案」。
 *
 * 這裡刻意保留 `moveValueE8`（bps × 總值）而不是 hub 模式的「實際 USD − 目標 USD」：這是**既有 2 資產
 * 行為**的算式，換掉它等於在沒有任何需求的情況下改動一個已經上線的數字來源。
 */
function preflightPinned(input: {
  holdings: readonly Holding[];
  targets: readonly TargetWeight[];
  drift: DriftReport;
}): { kind: 'reply'; plan: RebalancePlan } | { kind: 'leg'; leg: PinnedLeg } {
  const { holdings, targets, drift } = input;
  const targetA = targets[0];
  const targetB = targets[1];
  if (targetA === undefined || targetB === undefined) {
    throw new Error('unreachable: targets.length === 2 但取不到兩個元素');
  }
  if (targetA.asset.toLowerCase() === targetB.asset.toLowerCase()) {
    return {
      kind: 'reply',
      plan: { kind: 'blocked', reason: `兩個目標資產是同一個地址（${targetA.asset}），沒有 pair 可換` },
    };
  }

  const driftByAsset = new Map<string, AssetDrift>();
  for (const row of drift.assets) driftByAsset.set(row.asset.toLowerCase(), row);
  const rowA = driftByAsset.get(targetA.asset.toLowerCase());
  const rowB = driftByAsset.get(targetB.asset.toLowerCase());
  if (rowA === undefined || rowB === undefined) {
    return {
      kind: 'reply',
      plan: {
        kind: 'blocked',
        reason:
          'drift.assets 少了目標資產的列（' +
          [rowA === undefined ? targetA.asset : null, rowB === undefined ? targetB.asset : null]
            .filter((asset): asset is string => asset !== null)
            .join('、') +
          '）：drift 與 targets 來自不同的宇宙，不能規劃',
      },
    };
  }

  // 超配的那個是 tokenIn，另一個是 tokenOut。
  const overA = rowA.deltaBps > 0;
  const overB = rowB.deltaBps > 0;
  if (overA && overB) {
    return {
      kind: 'reply',
      plan: {
        kind: 'blocked',
        reason:
          `兩個目標資產都超配（+${rowA.deltaBps} / +${rowB.deltaBps} bps）：單一 pair 一次只能搬一個方向，` +
          '這種輸入代表 drift 與 targets 對不起來',
      },
    };
  }
  if (!overA && !overB) {
    // 兩個目標資產都沒有超配時，超配的是策略外持倉（賣不掉，D-24）或根本沒有超配。
    return {
      kind: 'reply',
      plan: {
        kind: 'noop',
        reason:
          `兩個目標資產都沒有超配（${rowA.deltaBps} / ${rowB.deltaBps} bps）：` +
          '超配的可能是策略外持倉（executor 不允許換 version.assets 以外的代幣，D-24），賣它換不到東西。',
      },
    };
  }
  const seller = overA ? targetA : targetB;
  const sellerRow = overA ? rowA : rowB;
  const buyerRow = overA ? rowB : rowA;

  const holdingsByAsset = new Map<string, Holding>();
  for (const holding of holdings) holdingsByAsset.set(holding.asset.toLowerCase(), holding);
  const sellerHolding = holdingsByAsset.get(seller.asset.toLowerCase());
  if (sellerHolding === undefined) {
    return {
      kind: 'reply',
      plan: {
        kind: 'blocked',
        reason:
          `${seller.asset} 的 deltaBps 是 +${sellerRow.deltaBps}（超配），但 holdings 裡沒有這個資產：` +
          '沒有持倉就沒有 decimals 與價格，算不出賣出量',
      },
    };
  }
  if (sellerHolding.usdPriceE8 <= 0n) {
    return {
      kind: 'reply',
      plan: {
        kind: 'blocked',
        reason: `${seller.asset} 的 usdPriceE8 是 ${sellerHolding.usdPriceE8}：沒有價格就算不出賣出量`,
      },
    };
  }

  // 取整全部向下（見檔頭）：算出來的量不可能大於「真正該賣的量」。
  const valueToMoveE8 = moveValueE8(Math.abs(sellerRow.deltaBps), drift.totalUsdE8);
  const requested = amountInFor(valueToMoveE8, sellerHolding.usdPriceE8, sellerHolding.decimals);
  const amountIn = requested > sellerHolding.amountWei ? sellerHolding.amountWei : requested;

  // amountIn === 0 不能再往下走 —— 合約對 amountIn == 0 會 revert ZeroAmount。
  if (amountIn === 0n) {
    return {
      kind: 'reply',
      plan: {
        kind: 'noop',
        reason:
          `The computed sell amount is 0 (need to move ${valueToMoveE8} E8 USD; ${seller.asset} price ${sellerHolding.usdPriceE8} E8, ` +
          `holding ${sellerHolding.amountWei} minimal units): the contract reverts ZeroAmount for amountIn == 0, so nothing is sent.`,
      },
    };
  }

  // 合約的 Permit2 腿是 uint160（`if (step.amountIn > type(uint160).max) revert AmountTooLarge()`）。
  // 真實代幣的持倉遠低於這個上限，所以正常永遠走不到；但「不可能」不該靠印象，能先擋就先擋。
  if (amountIn > UINT160_MAX) {
    return {
      kind: 'reply',
      plan: {
        kind: 'blocked',
        reason:
          `amountIn ${amountIn} 超過 uint160 上限 ${UINT160_MAX}：合約會 revert AmountTooLarge` +
          '（Permit2 的 allowance 是 uint160，超過的部分會被截斷）',
      },
    };
  }

  return {
    kind: 'leg',
    leg: {
      tokenIn: getAddress(seller.asset),
      tokenOut: getAddress((overA ? targetB : targetA).asset),
      amountIn,
      requested,
      clamped: amountIn < requested,
      valueToMoveE8,
      sellerDecimals: sellerHolding.decimals,
      sellerHoldingWei: sellerHolding.amountWei,
      sellerRow,
      buyerRow,
    },
  };
}

export async function planRebalance(
  args: PlanRebalanceArgs,
  deps: PlanRebalanceDeps = {},
): Promise<RebalancePlan> {
  const { publicClient, executor, oracle, registry, strategyId, holdings, targets, drift, blockNumber } = args;
  const thresholdBps = args.thresholdBps;
  const deadlineSeconds = args.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;

  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > MAX_DEADLINE_SECONDS) {
    throw new RangeError(
      `deadlineSeconds must be an integer in 1..${MAX_DEADLINE_SECONDS}（Permit2 的 30 天上限）, got ${deadlineSeconds}`,
    );
  }
  if (blockNumber < 0n) throw new RangeError(`blockNumber must not be negative, got ${blockNumber}`);
  if (strategyId < 0n) throw new RangeError(`strategyId must not be negative, got ${strategyId}`);
  // 價格衝擊上限：先驗一次（壞掉的設定不該在讀了半小時鏈之後才炸），再往下傳。
  const maxImpactBps = resolveMaxImpactBps(args.maxImpactBps);

  // ---- R1：不需要動就不動。這裡**先於任何鏈上讀取**返回，所以 noop 是一個純決策而不是「讀失敗後的猜測」。
  if (!drift.needsRebalance) {
    return {
      kind: 'noop',
      reason:
        `No rebalance needed: gross drift ${drift.grossDriftBps} bps < threshold ${drift.thresholdBps} bps` +
        ` (max |Δ| ${drift.maxAbsDeltaBps} bps). Not sending empty steps.`,
    };
  }
  if (thresholdBps !== drift.thresholdBps) {
    throw new RangeError(
      `thresholdBps(${thresholdBps}) 與 drift.thresholdBps(${drift.thresholdBps}) 不一致：` +
        '這份 drift 是用另一個門檻算的，不能拿來規劃',
    );
  }
  // 空倉（或全部無價）：總價值 0 → 沒有任何價值可以搬。這是 noop，不是 blocked：
  // 沒有「算不出來」的東西，只是沒有東西可搬。兩種 oracle 形狀共用這一條，所以放在形狀判定之前。
  if (drift.totalUsdE8 === 0n) {
    return {
      kind: 'noop',
      reason:
        `Portfolio value is 0 (empty, or everything unpriced): gross drift ${drift.grossDriftBps} bps is what ` +
        'drift.ts defines for total = 0 — not "aligned" — but there are no positions to move. Not sending empty steps.',
    };
  }

  // ---- 兩資產的單池前置：賣方與賣出量都是純算術。**先算完才問鏈**：算不出來的輸入
  // （量是 0、超過 uint160、沒有超配）不該花任何一次鏈上讀取，這在舊 oracle 上是既有行為。
  const preflight = targets.length === 2 ? preflightPinned({ holdings, targets, drift }) : null;
  if (preflight !== null && preflight.kind === 'reply') return preflight.plan;

  // ---- 形狀判定：hub（AtpMultiPoolOracle，N 資產、以 numeraire 為中央）還是 pinned（舊的單一 pair）？
  const shape = await detectOracleShape(publicClient, oracle, blockNumber);
  if (shape.kind === 'unknown') return { kind: 'blocked', reason: shape.detail };
  if (shape.kind === 'hub') return planHub(args, shape.numeraire, deps, deadlineSeconds, maxImpactBps);

  // pinned：oracle 真的只釘一個 pool（D-23）。結構上做不到的事先講清楚，不要用「沒事可做」蓋過去：
  // 一個 3 資產的策略在這種 oracle 上**永遠**不能動，operator 需要知道的是這件事。
  if (preflight === null) {
    return {
      kind: 'blocked',
      reason:
        `The target weights have ${targets.length} assets, but the executor's oracle pins a single pool (D-23): ` +
        'only the two assets of that oracle pair can be rebalanced today; more than two needs the per-call oracle (D-23) ' +
        '— that oracle is AtpMultiPoolOracle, and wiring it in makes this path use hub mode automatically.',
    };
  }
  const leg = preflight.leg;
  const { tokenIn, tokenOut, amountIn, requested, clamped } = leg;

  // pair 必須正好是 oracle 釘住的那一對（順序不拘，方向由 tokenIn/tokenOut 決定）。
  const poolTokens = new Set([shape.token0.toLowerCase(), shape.token1.toLowerCase()]);
  if (!poolTokens.has(tokenIn.toLowerCase()) || !poolTokens.has(tokenOut.toLowerCase())) {
    return {
      kind: 'blocked',
      reason:
        `oracle ${short(oracle)} 綁的 pool 是 ${short(shape.token0)} / ${short(shape.token1)}，` +
        `not ${short(tokenIn)} / ${short(tokenOut)}: the oracle currently pins a single pool, ` +
        'and more than two assets needs the per-call oracle (D-23)',
    };
  }

  const oraclePool = shape.pool;
  const head = await readHead(publicClient, registry, strategyId, blockNumber, deps.blockTimestampSeconds);
  if ('blocked' in head) return { kind: 'blocked', reason: head.blocked };
  const { feeBps, blockTimestamp } = head;

  const [poolFee, quote] = await Promise.all([
    publicClient.readContract({ address: oraclePool, abi: V3_POOL_ABI, functionName: 'fee', blockNumber }),
    publicClient
      .readContract({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: 'previewSwap',
        args: [tokenIn, tokenOut, amountIn],
        blockNumber,
      })
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error })),
  ]);
  if (!quote.ok) {
    const name = revertNameOf(quote.error);
    if (name === 'UnsupportedPair' || name === null) {
      return {
        kind: 'blocked',
        reason:
          `oracle.previewSwap(${short(tokenIn)} → ${short(tokenOut)}, ${amountIn}) 失敗` +
          `（${name ?? (quote.error instanceof Error ? quote.error.message : String(quote.error))}）：` +
          '這個 pair 不在 oracle 綁定的那個 pool 上，>2 資產要等 per-call oracle（D-23）',
      };
    }
    return {
      kind: 'blocked',
      reason: `oracle.previewSwap cannot quote right now (${name}): without a floor nothing can be sent — the contract reverts NoFloor`,
    };
  }

  const [oracleQuoted, minimum] = quote.result;
  // 合約對 minimum === 0 是 revert NoFloor：不是「地板是 0」，是「沒有地板」。
  if (minimum === 0n) {
    return {
      kind: 'blocked',
      reason: `oracle.previewSwap 的 minimum 是 0：合約會 revert NoFloor（沒有地板不等於地板是 0）`,
    };
  }

  // ---- 價格衝擊上限：把「一大筆必然 BelowFloor」換成「一次做一小塊，其餘留給下一輪」。
  const capped = await capLegByImpact({
    client: publicClient,
    blockNumber,
    maxImpactBps,
    label: `sell ${short(tokenIn)} for ${short(tokenOut)}`,
    pool: oraclePool,
    tokenIn,
    amountIn,
    quoted: oracleQuoted,
    floor: minimum,
    poolFeeUnits: Number(poolFee),
    requote: async (shrunkAmountIn: bigint) => {
      const again = await publicClient
        .readContract({
          address: oracle,
          abi: ORACLE_ABI,
          functionName: 'previewSwap',
          args: [tokenIn, tokenOut, shrunkAmountIn],
          blockNumber,
        })
        .catch((error: unknown) => error);
      if (again instanceof Error || !Array.isArray(again)) {
        return {
          skip:
            '重問 previewSwap 失敗' +
            `（${revertNameOf(again) ?? (again instanceof Error ? again.message : String(again))}）`,
        };
      }
      const [reQuoted, reMinimum] = again as unknown as readonly [bigint, bigint];
      if (reMinimum === 0n) return { skip: 'previewSwap 的 minimum 是 0（合約會 revert NoFloor）' };
      return { quoted: reQuoted, floor: reMinimum };
    },
  });
  if ('skip' in capped) {
    // 縮小救不回來 → 這一輪不送。**不是 blocked**：市場狀態，下一輪 TWAP 吸收衝擊後可能就好了。
    return { kind: 'noop', reason: `${capped.skip}. Not sending empty steps.` };
  }

  const finalAmountIn = capped.amountIn;
  const finalFloor = capped.floor;
  const minGross = minGrossFor(finalFloor, feeBps);
  const { base: deadlineBaseSeconds, source: deadlineSource } = deadlineBase(blockTimestamp);
  const deadline = deadlineBaseSeconds + BigInt(deadlineSeconds);
  if (deadline > deadlineBaseSeconds + BigInt(MAX_DEADLINE_SECONDS)) {
    // 上面的 deadlineSeconds 驗證已經擋掉，這行只是讓「Permit2 的 30 天」在這裡留下執行期證據。
    // 上限量的是**基準**（max(塊時間, 牆鐘)）而不是只量塊時間：塊時間落後牆鐘時，只量塊時間會讓
    // 一個完全正常的 deadline 在這裡炸掉。
    throw new RangeError(
      `deadline 超過基準 30 天：${deadline} > ${deadlineBaseSeconds + BigInt(MAX_DEADLINE_SECONDS)}`,
    );
  }

  const step = buildStep({
    executor,
    tokenIn,
    tokenOut,
    amountIn: finalAmountIn,
    oracleFloor: finalFloor,
    minGross,
    poolFee: Number(poolFee),
  });

  // 判準是**執行後的預估漂移**（與 hub 路徑同一個定義：缺口還在就 partial）。
  const postDrift = driftAfterSteps(holdings, targets, [step], thresholdBps);
  // 「不改善就不送」與 hub 是同一條守衛（原本只有 hub 有）。pinned 的單一 leg 沒有「另一個缺口被跳過」
  // 那種病，但它有一個更直接的同型病：到手量不是模型假設的那個數。`amountIn` 由 DB 價格算出，到手量
  // 卻來自池子報價（`minGross` 由 `oracleFloor` 來），兩者不一致時賣出去的量換不回預期的價值，執行後
  // 的漂移可以比現在**更大**——那不是「做得少」，是花 gas 讓投組更偏。`post` 用的就是 `amountOutMin`
  // （真正會到手的最小值），所以這條判準在 pinned 上量到的正是那件事。
  if (postDrift !== null && postDrift.grossDriftBps >= drift.grossDriftBps) {
    return {
      kind: 'noop',
      reason: noImprovementReason(
        drift,
        postDrift,
        1,
        capped.note === null ? '' : `；${capped.note}`,
      ),
    };
  }

  const partial: PlanPartial | null =
    postDrift === null
      ? {
          // 同上：算不出來就 `null`，不要用 pre 的數字冒充預測。
          remainingDriftBps: null,
          shrunk: shrunkStepsOf([{ amountIn: finalAmountIn, shrunk: capped.shrunk }]),
        }
      : postDrift.needsRebalance
        ? {
            remainingDriftBps: postDrift.grossDriftBps,
            shrunk: shrunkStepsOf([{ amountIn: finalAmountIn, shrunk: capped.shrunk }]),
          }
        : null;

  // R1 的結構保證：`steps` 的唯一來源是這個單元素陣列，所以 `ready` 不可能帶著空陣列
  // （空陣列 = «成功但什麼都沒做»，docs/pitfalls.zh-TW.md §8.1）。
  const rationale = [
    `${short(tokenIn)} 超配 +${leg.sellerRow.deltaBps} bps（現況 ${leg.sellerRow.currentBps} / 目標 ${leg.sellerRow.targetBps}）` +
      `，賣 ${formatUnits(finalAmountIn, leg.sellerDecimals)} 顆（${finalAmountIn} 個最小單位）換 ${short(tokenOut)}` +
      `，約 ${leg.valueToMoveE8} E8 USD`,
    clamped
      ? `⚠ 夾到實際持倉：依漂移算出 ${requested}，持倉只有 ${leg.sellerHoldingWei}，已夾到持倉（多賣不會被合約擋，所以只能少賣）`
      : `未夾取：算出的 ${requested} ≤ 持倉 ${leg.sellerHoldingWei}`,
    ...(capped.shrunk === null && capped.note === null
      ? []
      : [partialNoteOf({ amountIn: finalAmountIn, shrunk: capped.shrunk }, maxImpactBps) || capped.note || '']),
    `oracle floor ${finalFloor}（previewSwap 的 minimum，不是 quoted）+ fee ${feeBps} bps → minGross ${minGross}`,
    `pool ${short(oraclePool)} fee ${poolFee}；block ${blockNumber} 時間 ${blockTimestamp}；` +
      `deadline 基準 max(塊時間, 牆鐘) = ${deadlineBaseSeconds}（取${deadlineSource === 'chain' ? '塊時間' : '牆鐘'}）` +
      ` + ${deadlineSeconds}s = deadline ${deadline}`,
    `目標的另一邊 ${short(tokenOut)} 低配 ${leg.buyerRow.deltaBps} bps`,
    describePostDrift(drift, postDrift, partial),
  ]
    .filter((segment) => segment !== '')
    .join('；');

  return { kind: 'ready', steps: [step], deadline, rationale, ...(partial === null ? {} : { partial }) };
}

