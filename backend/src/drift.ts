/**
 * 持倉 → 漂移（drift）。純函式：不讀鏈、不讀 DB、不看時鐘，所有輸入都是參數。
 *
 * 定點數慣例（整份檔案只有這兩種單位，全部是 bigint）
 *   * amountWei：代幣最小單位（10^decimals）。positions_snapshots.amount 是 numeric(38,18)，
 *     會超過 Number.MAX_SAFE_INTEGER，所以整條路徑不經過 Number。
 *   * usdPriceE8 / usdValueE8：USDT 金額放大 1e8。1 顆 $250.00 的 bStock = 25_000_000_000n。
 *
 * 誤差與捨入（對帳時要看這段）
 *   * usdValueE8 = amountWei * usdPriceE8 / 10^decimals 是 bigint 整數除法：會**截斷**，不是四捨五入。
 *     每個資產的 USD 價值因此最多少 1 個 1e-8 USDT。刻意如此：先截斷再相加，總和不會比真實值大，
 *     權重不會因取整而虛胖。要對帳到「分」請在呼叫端用更大的 scale，不要改這裡。
 *   * currentBps 是四捨五入（half-up），所以各資產 currentBps 相加可能不等於 10000（差幾個 bps）。
 *     這是正常的取整誤差、不是資料錯誤，computeDrift 不會因此拋錯。
 *   * 因此 Σ|deltaBps| 可能是奇數，grossDriftBps = round(Σ|deltaBps| / 2)，同樣 half-up。
 *
 * 為什麼 grossDriftBps 要除以 2
 *   一次再平衡是「賣掉一個、買進另一個」：A 超配 +1000bps 與 B 低配 -1000bps 是同一筆搬動造成的兩個
 *   影子，Σ|delta| = 2000 但真正要搬的只有投組價值的 1000bps。除以 2 才是「要搬多少」。
 */

/** 一個持倉。amountWei 是代幣最小單位，usdPriceE8 是每 1 顆（整顆，不是 wei）的 USDT 價格 ×1e8。 */
export type Holding = {
  asset: string;
  amountWei: bigint;
  decimals: number;
  usdPriceE8: bigint;
};

/** 目標權重的一列，對應 strategy_versions.allocation.assets[]。 */
export type TargetWeight = { asset: string; weightBps: number };

export type AssetDrift = {
  asset: string;
  /** 目標權重（bps）。持倉有、目標沒有的資產為 0。 */
  targetBps: number;
  /** 實際權重（bps，四捨五入）。 */
  currentBps: number;
  /** currentBps - targetBps，可負。 */
  deltaBps: number;
  /** 該資產的 USD 價值（1e8 定點，已截斷，見檔頭）。 */
  usdValueE8: bigint;
};

export type DriftReport = {
  totalUsdE8: bigint;
  assets: AssetDrift[];
  /** 所有資產裡最大的 |deltaBps|。 */
  maxAbsDeltaBps: number;
  /** Σ|deltaBps| / 2（四捨五入）：真正要換手的投組價值比例（bps）。 */
  grossDriftBps: number;
  /** grossDriftBps >= thresholdBps（等於門檻就該動，不是超過）。 */
  needsRebalance: boolean;
  thresholdBps: number;
};

const BPS_DENOMINATOR = 10_000;
const BPS_BIG = BigInt(BPS_DENOMINATOR);
/** numeric(38,18) 的 18 位小數，用 bigint 表示要乘上 1e18。 */
const E18 = 10n ** 18n;
/** usd_value（E18）轉成 E8 要除以 1e10。 */
const E18_TO_E8 = 10n ** 10n;

/** 整數除法四捨五入（half-up）。只用於正數，除數必須 > 0。 */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return (numerator % denominator) * 2n >= denominator ? quotient + 1n : quotient;
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

function assertDecimals(decimals: number, asset: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`holding ${asset}: decimals must be an integer in 0..36, got ${decimals}`);
  }
}

function assertThreshold(thresholdBps: number): void {
  if (!Number.isInteger(thresholdBps) || thresholdBps < 0 || thresholdBps > BPS_DENOMINATOR) {
    throw new RangeError(
      `thresholdBps must be an integer in 0..${BPS_DENOMINATOR}, got ${thresholdBps}`,
    );
  }
}

/** 建索引，順便擋掉重複與不可能的數值：重複的持倉會讓同一筆錢被算兩次。 */
function indexHoldings(holdings: readonly Holding[]): Map<string, Holding> {
  const byAsset = new Map<string, Holding>();
  for (const holding of holdings) {
    const { asset, amountWei, usdPriceE8 } = holding;
    if (typeof asset !== 'string' || asset.trim() === '') {
      throw new RangeError('holding.asset must be a non-empty string');
    }
    if (byAsset.has(asset)) throw new RangeError(`duplicate holding asset: ${asset}`);
    if (amountWei < 0n) throw new RangeError(`holding ${asset}: amountWei must not be negative`);
    if (usdPriceE8 < 0n) throw new RangeError(`holding ${asset}: usdPriceE8 must not be negative`);
    assertDecimals(holding.decimals, asset);
    byAsset.set(asset, holding);
  }
  return byAsset;
}

/**
 * 建目標索引。權重總和必須剛好 10000：那是 strategy_versions.allocation 的校驗結果，這裡算下去
 * 只會把資料錯誤變成一個「看起來很合理」的報告，所以直接拋錯。weightBps 0 合法（等於不是目標）。
 */
function indexTargets(targets: readonly TargetWeight[]): Map<string, number> {
  const byAsset = new Map<string, number>();
  let sum = 0;
  for (const target of targets) {
    const { asset, weightBps } = target;
    if (typeof asset !== 'string' || asset.trim() === '') {
      throw new RangeError('target.asset must be a non-empty string');
    }
    if (!Number.isInteger(weightBps) || weightBps < 0 || weightBps > BPS_DENOMINATOR) {
      throw new RangeError(`target ${asset}: weightBps must be an integer in 0..10000, got ${weightBps}`);
    }
    if (byAsset.has(asset)) throw new RangeError(`duplicate target asset: ${asset}`);
    byAsset.set(asset, weightBps);
    sum += weightBps;
  }
  if (sum !== BPS_DENOMINATOR) {
    throw new RangeError(`target weights must sum to ${BPS_DENOMINATOR} bps, got ${sum}`);
  }
  return byAsset;
}

/**
 * 計算漂移。邊界情況與其定義：
 *
 *   * 空倉（totalUsdE8 === 0）：每個資產 currentBps = 0、deltaBps = -targetBps，公式原樣套用後
 *     grossDriftBps = 10000 / 2 = 5000。**不回 0**：空帳戶不是「已經在目標上」，而是「完全不在
 *     目標上」；回 0 會讓一個還沒入金的投組看起來永遠平衡（keeper 永遠不動、也不會被通知）。
 *     這 5000 是公式的結果，不是特例常數；呼叫端若想區分「空倉」與「真的偏離」，看 totalUsdE8 === 0n。
 *   * 持倉有、目標沒有的資產（使用者自己買的幣）：計入 totalUsdE8，否則其他人的權重會失真；
 *     targetBps = 0，因此它一定會推高 grossDrift。
 *   * 目標有、使用者沒持有的資產：仍出現在 assets 裡，usdValueE8 = 0、deltaBps = -targetBps。
 *   * 重複 asset（持倉或目標）：拋錯。重複的持倉等於把同一筆錢算兩次。
 *   * currentBps 相加不必剛好 10000（取整誤差），不拋錯，見檔頭。
 *
 * 報告順序：先照 targets 的順序（對齊 allocation，人看得懂），再把「多買的」資產照 holdings 的
 * 順序接在後面。
 */
export function computeDrift(
  holdings: readonly Holding[],
  targets: readonly TargetWeight[],
  thresholdBps: number,
): DriftReport {
  assertThreshold(thresholdBps);
  const heldByAsset = indexHoldings(holdings);
  const targetByAsset = indexTargets(targets);
  const extra = [...heldByAsset.keys()].filter((asset) => !targetByAsset.has(asset));
  const order = [...targetByAsset.keys(), ...extra];
  const values = new Map<string, bigint>();
  let totalUsdE8 = 0n;
  for (const [asset, holding] of heldByAsset) {
    const usdValueE8 = (holding.amountWei * holding.usdPriceE8) / pow10(holding.decimals);
    values.set(asset, usdValueE8);
    totalUsdE8 += usdValueE8;
  }
  const assets: AssetDrift[] = [];
  let sumAbsDeltaBps = 0;
  let maxAbsDeltaBps = 0;
  for (const asset of order) {
    const targetBps = targetByAsset.get(asset) ?? 0;
    const usdValueE8 = values.get(asset) ?? 0n;
    const currentBps = totalUsdE8 === 0n ? 0 : Number(divRound(usdValueE8 * BPS_BIG, totalUsdE8));
    const deltaBps = currentBps - targetBps;
    const absDeltaBps = Math.abs(deltaBps);
    sumAbsDeltaBps += absDeltaBps;
    maxAbsDeltaBps = Math.max(maxAbsDeltaBps, absDeltaBps);
    assets.push({ asset, targetBps, currentBps, deltaBps, usdValueE8 });
  }

  const grossDriftBps = Math.round(sumAbsDeltaBps / 2);
  const needsRebalance = grossDriftBps >= thresholdBps;
  return { totalUsdE8, assets, maxAbsDeltaBps, grossDriftBps, needsRebalance, thresholdBps };
}

/**
 * numeric(38,18) 的字串（node-postgres 對 numeric 一律回字串）轉成放大 1e18 的 bigint。
 * 不用 Number：numeric(38,18) 的最大值遠超 2^53，先過 Number 就靜默失真了。
 * 超過 18 位小數視為資料錯誤（欄位本身存不進去），直接拋錯而不是截斷。
 */
export function parseNumeric18(value: string | bigint): bigint {
  if (typeof value === 'bigint') return value * E18;
  if (typeof value !== 'string') {
    throw new RangeError('numeric values must be passed as a string or bigint, never a number');
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  const whole = match?.[2];
  if (match === null || whole === undefined) {
    throw new RangeError(`not a numeric(38,18) value: ${JSON.stringify(value)}`);
  }
  const fraction = match[3] ?? '';
  if (fraction.length > 18) {
    throw new RangeError(`numeric(38,18) cannot carry more than 18 decimal places: ${value}`);
  }
  const scaled = BigInt(whole + fraction.padEnd(18, '0'));
  return match[1] === '-' ? -scaled : scaled;
}

/**
 * 從 usd_value 反推每顆代幣的價格：
 *   priceE8 = usdValue × 10^decimals ÷ amountWei，再從 E18 換到 E8，也就是
 *   priceE8 = usdValueE18 × 10^decimals ÷ (amountWei × 1e10)。
 * 反推的價格經過一次四捨五入，之後 computeDrift 重算回來的 usdValueE8 可能差 1 個 1e-8；
 * 要精確對帳就別反推，直接把已知價格放進 rows[].usdPriceE8。
 */
function priceE8FromUsdValue(
  asset: string,
  usdValue18: bigint,
  amountWei: bigint,
  decimals: number,
): bigint {
  if (usdValue18 < 0n) throw new RangeError(`holding ${asset}: usd_value must not be negative`);
  if (amountWei < 0n) throw new RangeError(`holding ${asset}: amount must not be negative`);
  if (amountWei === 0n) {
    if (usdValue18 !== 0n) {
      throw new RangeError(`holding ${asset}: usd_value is non-zero but amount is zero`);
    }
    return 0n;
  }
  return divRound(usdValue18 * pow10(decimals), amountWei * E18_TO_E8);
}

/**
 * numeric(38,18) 的「代幣顆數」轉成代幣最小單位：欄位固定 18 位小數，代幣本身不一定 18 位，
 * 所以 decimals < 18 時要除掉多出來的位數、無條件捨去（欄位本來就只存得到 1e-18 顆）。
 * 目前查證過的 bStock 都是 18 位，這只是不要讓「欄位 scale」與「代幣 decimals」混為一談。
 */
function toTokenUnits(amount18: bigint, decimals: number): bigint {
  return decimals >= 18 ? amount18 * pow10(decimals - 18) : amount18 / pow10(18 - decimals);
}

/** positions_snapshots 的一列。numeric 欄位是 pg 回的字串，bigint 欄位也可能是字串。 */
export type SnapshotRow = {
  asset: string;
  /** positions_snapshots.amount，numeric(38,18)。 */
  amount: string | bigint;
  /** positions_snapshots.usd_value，nullable。 */
  usd_value?: string | bigint | null;
  /** priceable_assets.decimals；目前查證過的代幣全部 18，省略時預設 18。 */
  decimals?: number;
  /** 已知價格時直接給，優先於 usd_value 反推。 */
  usdPriceE8?: bigint;
};

/**
 * 把 positions_snapshots 的資料列轉成 Holding[]。
 * 一列沒有 usd_value 也沒有 usdPriceE8 時拋錯，不當成 0：把未知價格算成 0 會讓權重悄悄失真。
 * 重複的 asset 由 computeDrift 擋（這裡不重複驗，維持單一職責）。
 */
export function parseSnapshotRows(rows: readonly SnapshotRow[]): Holding[] {
  const holdings: Holding[] = [];
  for (const row of rows) {
    const decimals = row.decimals ?? 18;
    assertDecimals(decimals, row.asset);
    const amount18 = parseNumeric18(row.amount);
    if (amount18 < 0n) throw new RangeError(`holding ${row.asset}: amount must not be negative`);
    const amountWei = toTokenUnits(amount18, decimals);
    let usdPriceE8: bigint;
    if (row.usdPriceE8 !== undefined) {
      usdPriceE8 = row.usdPriceE8;
    } else if (row.usd_value !== undefined && row.usd_value !== null) {
      usdPriceE8 = priceE8FromUsdValue(
        row.asset,
        parseNumeric18(row.usd_value),
        amountWei,
        decimals,
      );
    } else {
      throw new RangeError(
        `holding ${row.asset} has no usd_value and no usdPriceE8: price it before computing drift`,
      );
    }
    holdings.push({ asset: row.asset, amountWei, decimals, usdPriceE8 });
  }
  return holdings;
}

/** 工單裡的名字；與 parseSnapshotRows 是同一個函式。 */
export const parseHoldingsJson = parseSnapshotRows;
