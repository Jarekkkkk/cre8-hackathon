/**
 * 價格衝擊估算 —— **近似公式，不是模擬**。純函式：不讀鏈、不送交易。
 *
 * ## 量的是哪一個量（這一節決定整個模組是否可用）
 *
 * `AtpExecutor` 驗的是「實際到手 `gross` ≥ `minGross`」，而
 * `minGross = ceil(oracleFloor * 10000 / (10000 - feeBps))`、`oracleFloor` 是
 * `previewSwap(...).minimum` ＝ **TWAP 報價 × (1 − maxSlippageBps)**。把兩邊同除 TWAP 報價，
 * 檢查就變成：
 *
 * ```
 * (quoted − gross) / quoted  ≤  maxSlippageBps（1%）
 * ```
 *
 * 所以本模組的 `impactBps` 定義成 **`(quoted − estimatedOut) / quoted`** —— 與合約那個不等式
 * **同一個空間**的量，可以直接和 `maxSlippageBps` 比。它包含三個成分：
 *
 *   1. 池子手續費（`feeUnits`，例如 2500 = 0.25%）：**與量無關**，切多小都在。
 *   2. 現貨價相對 TWAP 的既有偏差：**與量無關**（TWAP 是過去 30 分鐘的均值，現貨早就跑掉了）。
 *   3. 這一筆自己造成的衝擊：**唯一隨量變化的那一項**，也是縮小唯一救得回來的那一項。
 *
 * 1+2 合起來就是 `baselineBps`（`amountIn → 0` 時 `impactBps` 的極限）。它的用途很具體：
 * `baselineBps > maxImpactBps` 表示**不管切多小都會撞牆**（多半是現貨已經在 TWAP 的另一側），
 * 呼叫端此時該回 `noop` 並說明「不是量的問題」，而不是硬送一筆註定 `BelowFloor` 的交易。
 *
 * ## 近似假設（**全部**都可能讓估算失準）
 *
 *   1. **不跨 tick**：用 `pool.liquidity()` 這一個值代表整筆 swap 的深度。真實 swap 會跨 tick，
 *      而跨出去之後流動性通常**變薄** → 真實衝擊**比估算大** → 本模組**低估**。
 *      （反例：流動性集中在現價外側、跨出去反而更厚 → 高估。Pancake V3 的常態不是這一種，但不保證。）
 *   2. **只有 fee tier 這一種成本**：忽略 transfer tax／rebasing／router 的其他抽水。這類代幣上
 *      `estimatedOut` 偏高 → 低估衝擊。
 *   3. **`liquidity()` 是「現在」的**：估算與實際成交若隔了幾個塊，區間可能已經被別人搬走。
 *   4. **TWAP 價是從報價反推的**：`quoted / amountIn`（含 oracle 的 `ceil` 取整）。量很小時這個
 *      比值會被取整吃掉幾個 bps，所以 dust（< 1 bp of ideal）另外擋掉，不靠這個數。
 *   5. **完全不讀 TWAP**：只信 `previewSwap` 回給我們的 `quoted`。oracle 換了實作（例如把 fee
 *      也算進 quoted）本模組的分解會跟著歪，但總量 `(quoted − estimatedOut)/quoted` 仍然是
 *      **對的定義**，因為它定義在 quoted 上。
 *
 * ## `impactBps` 與 `priceMoveBps` 差在哪（別把它們混用）
 *
 * `priceMoveBps` 是「換完之後的現貨價 vs TWAP 價」的**價格空間**差，也就是最直覺的那條公式
 * （`Δ√P = amountIn*2^96/L` → 新價 = (√P ± Δ√P)²）。但實際到手量用的是**幾何平均價**
 * `√(P₀P₁)`：價格移動 x 時，到手價只差 ≈ x/2。所以兩者在小衝擊時相差約 **2 倍**。
 * 要跟合約地板比、要跟真實 `gross` 比，一律用 `impactBps`；`priceMoveBps` 只給人看
 * 「價格被推了多遠」。
 *
 * ## V3 的兩條精確式（單一 tick 區間內，不是泰勒展開）
 *
 * `√P` 一律用 Q64.96 的整數 `S`，`L` 是 `pool.liquidity()`，`x` 是扣掉 fee 之後的進池量：
 *
 *   * `token0` 進（價格下跌，拿到 token1）：`x1 = L(√P₀ − √P₁)` 幾何上等價於
 *     `S₁ = S·L·Q96 / (L·Q96 + x·S)`、`out = L(S − S₁)/Q96`。
 *   * `token1` 進（價格上漲，拿到 token0）：`x1 = x` 且 `S₁ = S + x·Q96/L`、
 *     `out = L·Q96(S₁ − S)/(S·S₁)`。
 *
 * 注意 `Δ√P = amountIn·2^96/L` 只在 **token1 進** 那一側是線性的；token0 進那一側是
 * `1/√P` 的線性。直接用線性式套在 token0 進會低估衝擊，所以這裡兩側都寫精確解。
 */

/** Q64.96。√P 的定點分母。 */
const Q96 = 2n ** 96n;
/** 2^192 = Q96²，把 `sqrtPriceX96²` 還原成 raw token1-per-token0 的比值。 */
const Q192 = Q96 * Q96;
/** fee tier 的分母：V3 的 fee 是「百分之一個 bip」，1_000_000 = 100%。 */
const FEE_UNITS = 1_000_000n;
const BPS = 10_000n;

/** 整數除法向上取整。除數必須 > 0。 */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** 一個池子的狀態：估算衝擊所需的**全部**輸入（其餘一律不讀）。 */
export type PoolImpactState = {
  /** `pool.slot0().sqrtPriceX96`（現貨價，Q64.96，raw token1 per raw token0）。 */
  sqrtPriceX96: bigint;
  /** `pool.liquidity()`：**當前 tick 區間內**的流動性。 */
  liquidity: bigint;
  /** 賣出的是不是 token0：決定價格往哪邊走，也決定用哪一條公式。 */
  tokenInIsToken0: boolean;
  /** 池子的 fee tier（`pool.fee()`，1e6 = 100%，2500 = 0.25%）。 */
  feeUnits: number;
};

export type ImpactEstimate = {
  /** 估算的到手量（tokenOut 最小單位），已扣掉池子手續費。 */
  estimatedOut: bigint;
  /** `(quoted − estimatedOut)/quoted`，bps。**與合約 floor 同一個空間**，可以直接比。 */
  impactBps: number;
  /** `amountIn → 0` 時 `impactBps` 的極限 = fee + 現貨相對 TWAP 的既有偏差，bps。 */
  baselineBps: number;
  /** 換完之後的現貨價 vs TWAP 價，bps（價格空間的那條公式，約等於 2× 上面那一項）。 */
  priceMoveBps: number;
  /** 換完之後的 √P（Q64.96）；呼叫端要追蹤「跨不跨 tick」時用得到。 */
  sqrtPriceAfterX96: bigint;
};

/** 狀態本身是否可估算。回 `null` = 可以，回字串 = 為什麼不行。 */
export function impactStateProblem(state: PoolImpactState): string | null {
  if (state.sqrtPriceX96 <= 0n) return `sqrtPriceX96 是 ${state.sqrtPriceX96}（現貨價不可用）`;
  if (state.liquidity <= 0n) return 'liquidity 是 0（當前 tick 區間沒有流動性，任何量都估不出來）';
  if (
    !Number.isInteger(state.feeUnits) ||
    state.feeUnits < 0 ||
    BigInt(state.feeUnits) >= FEE_UNITS
  ) {
    return `feeUnits 只能是 0..999999 的整數（收到 ${state.feeUnits}）`;
  }
  return null;
}

/**
 * 扣掉 fee 之後真正進池的量。**向上取整**：多算一點 → 衝擊估高一點 → 少切一點，
 * 偏「不會 revert」那一側（反方向的代價是一次 `BelowFloor`）。
 */
function effectiveIn(amountIn: bigint, feeUnits: number): bigint {
  return ceilDiv(amountIn * (FEE_UNITS - BigInt(feeUnits)), FEE_UNITS);
}

/** 換完之後的 √P（Q64.96）。單一 tick 區間內的精確解（不跨 tick 的前提見檔頭）。 */
export function sqrtPriceAfter(state: PoolImpactState, amountIn: bigint): bigint {
  if (amountIn < 0n) throw new RangeError(`amountIn must not be negative, got ${amountIn}`);
  const { sqrtPriceX96: S, liquidity: L, tokenInIsToken0 } = state;
  const problem = impactStateProblem(state);
  if (problem !== null) throw new RangeError(problem);
  const effectiveInAmount = effectiveIn(amountIn, state.feeUnits);
  if (effectiveInAmount === 0n) return S;
  return tokenInIsToken0
    ? (S * L * Q96) / (L * Q96 + effectiveInAmount * S)
    : S + ceilDiv(effectiveInAmount * Q96, L);
}

/** 已知換完之後的 `√P` 時，到手量是多少（最小單位）。兩側公式見檔頭。 */
function amountOutFrom(state: PoolImpactState, sqrtPriceAfterX96: bigint): bigint {
  const { sqrtPriceX96: S, liquidity: L, tokenInIsToken0 } = state;
  if (tokenInIsToken0) return sqrtPriceAfterX96 >= S ? 0n : (L * (S - sqrtPriceAfterX96)) / Q96;
  return sqrtPriceAfterX96 <= S ? 0n : (L * Q96 * (sqrtPriceAfterX96 - S)) / (S * sqrtPriceAfterX96);
}

/** 這一筆換到手的 tokenOut 量（最小單位，已扣 fee）。 */
export function amountOutFor(state: PoolImpactState, amountIn: bigint): bigint {
  return amountOutFrom(state, sqrtPriceAfter(state, amountIn));
}

/** 大 bigint → 小 bps 數值。分子先除掉分母，`Number()` 只在最後一步。 */
function toBps(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  return Number((numerator * BPS) / denominator);
}

/**
 * `1 − estimatedOut/quoted`，bps —— **精確有理式，中間不做除法**。
 *
 * 為什麼不能「先算 `estimatedOut` 再除」：`estimatedOut` 是整數，量很小的時候會被截斷成 0，
 * 而 `(quoted − 0)/quoted` 就變成 10000 bps。那會讓每一個小量都看起來像一場災難 ——
 * 二分搜尋的第一步（`amountIn = 1`）就會誤判「連最小量都超預算」，整條 leg 被丟掉。
 * 這裡把分子分母都留成 bigint 乘積，只在最後一次除，dust 量也得到正確的比率。
 *
 * 到手量與報價的比例（`effIn` = 扣 fee 之後的進池量）：
 *
 *   * `token0` 進：`out = L·S²·effIn / (Q96·(L·Q96 + effIn·S))`
 *   * `token1` 進：`out = effIn·Q96² / (S·S₁)`，`S₁ = S + effIn·Q96/L`
 *                 → 兩邊同乘 `L`：`S·(S·L + effIn·Q96)`
 */
function impactRatioBps(state: PoolImpactState, amountIn: bigint, quoted: bigint): number {
  const { sqrtPriceX96: S, liquidity: L, tokenInIsToken0 } = state;
  const effIn = effectiveIn(amountIn, state.feeUnits);
  if (effIn === 0n) return 0;
  const numerator = tokenInIsToken0 ? L * S * S * effIn : effIn * Q96 * Q96 * L;
  const denominator = tokenInIsToken0 ? Q96 * (L * Q96 + effIn * S) * quoted : S * (S * L + effIn * Q96) * quoted;
  return numerator >= denominator ? 0 : toBps(denominator - numerator, denominator);
}

/**
 * 同一個比率，但拿**連續的 TWAP 比率**（`idealQuoted / idealAmountIn`）當分母，交叉相乘所以不需要
 * 先把候選量的報價算出來。
 *
 * 為什麼要另寫一個：`previewSwap` 的 `quoted` 是**整數且向上取整**。候選量小的時候
 * `ceil(a·q/A)` 會停在 1（或 0），那個「1 wei 的報價」對比「實際到手 0」就是 10000 bps ——
 * 一個純粹由取整造成的假衝擊。用它做二分的下界探測，會讓**整條 leg** 被誤判成
 * 「連最小量都超預算」而丟掉（真鏈上就是這樣把一筆 $166k 的買單整個跳過的）。
 * 交叉相乘之後，這個函式在任何量級都給出同一個（單調的）連續比率。
 */
function impactAgainstRateBps(
  state: PoolImpactState,
  amountIn: bigint,
  idealAmountIn: bigint,
  idealQuoted: bigint,
): number {
  const { sqrtPriceX96: S, liquidity: L, tokenInIsToken0 } = state;
  const effIn = effectiveIn(amountIn, state.feeUnits);
  if (effIn === 0n) return 0;
  const outNumerator = tokenInIsToken0 ? L * S * S * effIn : effIn * Q96 * Q96 * L;
  const outDenominator = tokenInIsToken0 ? Q96 * (L * Q96 + effIn * S) : S * (S * L + effIn * Q96);
  // out / (amountIn × quoted/idealAmountIn)
  const numerator = outNumerator * idealAmountIn;
  const denominator = outDenominator * amountIn * idealQuoted;
  return numerator >= denominator ? 0 : toBps(denominator - numerator, denominator);
}


/**
 * 估算一筆 swap 的衝擊。
 *
 * @param state     池子狀態（見 `PoolImpactState`）
 * @param amountIn  賣出的量（tokenIn 最小單位）
 * @param quoted    `previewSwap(tokenIn, tokenOut, amountIn).quoted` —— TWAP 報價，**同一個量**
 *                  （不同量的 quoted 由呼叫端按比例換算，見 `capAmountInForImpact`）
 */
export function estimateImpact(
  state: PoolImpactState,
  amountIn: bigint,
  quoted: bigint,
): ImpactEstimate {
  if (amountIn <= 0n) throw new RangeError(`amountIn must be positive, got ${amountIn}`);
  if (quoted <= 0n) throw new RangeError(`quoted must be positive, got ${quoted}`);
  const problem = impactStateProblem(state);
  if (problem !== null) throw new RangeError(problem);

  const { sqrtPriceX96: S } = state;
  const after = sqrtPriceAfter(state, amountIn);
  const estimatedOut = amountOutFrom(state, after);

  // ① 到手量空間：就是合約那個不等式。到手比報價多（現貨比 TWAP 好）時夾到 0。
  //    用精確有理式（見 `impactRatioBps`），不用被截斷過的 estimatedOut —— 後者在 dust 量會誤判。
  const impactBps = impactRatioBps(state, amountIn, quoted);

  // ② baseline：amountIn → 0 時的極限 = 1 − (到手比例/報價比例)·(1 − fee)。
  //    **方向很重要**：買進 token0 時到手量 ∝ P（= S²/Q²）；賣出 token1 收 token0 時到手量 ∝ 1/P。
  //    兩邊都是 raw 比值，所以不必知道 decimals。
  const { tokenInIsToken0: inIsToken0 } = state;
  const spotNumerator = inIsToken0 ? S * S : Q192;
  const spotDenominator = inIsToken0 ? Q192 : S * S;
  const feeNum = FEE_UNITS - BigInt(state.feeUnits);
  const netNumerator = spotNumerator * amountIn * feeNum;
  const netDenominator = spotDenominator * quoted * FEE_UNITS;
  const baselineBps = netNumerator >= netDenominator ? 0 : toBps(netDenominator - netNumerator, netDenominator);

  // ③ 價格空間：換完之後的現貨價 vs TWAP 價（|差| / TWAP）。約等於 ②+③ 的兩倍，見檔頭。
  const afterNumerator = after * after * amountIn;
  const twapDenominator = Q192 * quoted;
  const priceMoveBps =
    afterNumerator >= twapDenominator
      ? toBps(afterNumerator - twapDenominator, twapDenominator)
      : toBps(twapDenominator - afterNumerator, twapDenominator);

  return { estimatedOut, impactBps, baselineBps, priceMoveBps, sqrtPriceAfterX96: after };
}

export type ImpactCap = {
  /** 縮小之後（或原樣）的 amountIn。`0n` = 沒有任何量能在預算內。 */
  amountIn: bigint;
  /** 在 `amountIn` 上的估算；`amountIn === 0n` 時是**理想量**上的估算（方便寫理由）。 */
  estimate: ImpactEstimate;
  /** 在理想量上的估算。 */
  idealEstimate: ImpactEstimate;
  /** 理想量的衝擊超標、因此被縮小。 */
  shrunk: boolean;
  /** `true` = 連 1 個最小單位都超標：縮小救不回來（是 baseline 的問題，不是量的問題）。 */
  noSizeFits: boolean;
};

/**
 * 找出「衝擊 ≤ `maxImpactBps` 的最大量」。
 *
 * `quoted` 對 `amountIn` 是**嚴格線性**的（`PancakeV3TwapOracle._quote` 是
 * `mulDiv(amountIn, ratio, …)`），所以其他量上的報價用比例推得出來（`ceil`，與 oracle 同向），
 * 不必為每一個候選量再問一次鏈。真正的量最後由呼叫端重問一次 `previewSwap` 取得權威地板。
 *
 * 單調：`impact` 對 `amountIn` 遞增（到手價 = 幾何平均價，愈推愈差），所以二分搜尋合法。
 */
export function capAmountInForImpact(params: {
  state: PoolImpactState;
  idealAmountIn: bigint;
  idealQuoted: bigint;
  maxImpactBps: number;
}): ImpactCap {
  const { state, idealAmountIn, idealQuoted, maxImpactBps } = params;
  if (!Number.isInteger(maxImpactBps) || maxImpactBps < 1 || maxImpactBps >= 10_000) {
    throw new RangeError(`maxImpactBps must be an integer in 1..9999, got ${maxImpactBps}`);
  }
  if (idealAmountIn <= 0n) throw new RangeError(`idealAmountIn must be positive, got ${idealAmountIn}`);

  const idealEstimate = estimateImpact(state, idealAmountIn, idealQuoted);
  if (idealEstimate.impactBps <= maxImpactBps) {
    return {
      amountIn: idealAmountIn,
      estimate: idealEstimate,
      idealEstimate,
      shrunk: false,
      noSizeFits: false,
    };
  }

  /** 候選量上的報價：與 oracle 的 ceil 同向（只用來回報，**不用來判斷**，理由見 impactAgainstRateBps）。 */
  const quotedAt = (amountIn: bigint): bigint => ceilDiv(amountIn * idealQuoted, idealAmountIn);
  /** 可行性一律用連續比率判斷：任何量級都不會因為報價取整而失真。 */
  const fits = (amountIn: bigint): boolean =>
    impactAgainstRateBps(state, amountIn, idealAmountIn, idealQuoted) <= maxImpactBps;

  if (!fits(1n)) {
    // 連一個最小單位都超標：這是 baseline（fee + 現貨 vs TWAP）超過預算，切多小都沒用。
    return { amountIn: 0n, estimate: idealEstimate, idealEstimate, shrunk: true, noSizeFits: true };
  }

  // 不變量：lo 可行、hi 不可行。收斂到「可行的最大量」。
  let lo = 1n;
  let hi = idealAmountIn;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const reported = quotedAt(lo);
  return {
    amountIn: lo,
    // `impactBps` 用同一條連續比率回報（與決策同一個數），`estimatedOut` 仍是整數到手量。
    estimate: {
      ...estimateImpact(state, lo, reported === 0n ? idealQuoted : reported),
      impactBps: impactAgainstRateBps(state, lo, idealAmountIn, idealQuoted),
    },
    idealEstimate,
    shrunk: true,
    noSizeFits: false,
  };
}
