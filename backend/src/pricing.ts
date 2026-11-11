import type { Address, PublicClient } from 'viem';

/**
 * Off-chain price leg: a PancakeSwap V3 pool's TWAP in USDT, returned as 1e8 fixed point.
 *
 * 這支程式的唯一目的是與鏈上 oracle `cre8-contracts/src/atp/PancakeV3TwapOracle.sol` 算出**同一個數字**：
 * 索引器用這裡的價格算漂移，執行器用 oracle 的報價當地板，兩邊算法一旦不同，同一筆再平衡就會
 * 「用一個價格決定、用另一個價格成交」。所以下面每一項都逐條對齊 Solidity：
 *
 * 1. `_meanSqrtPrice` 是 **mean tick → sqrtPrice**，不是 sqrtPrice 的算術平均。它把
 *    `observe([window, 0])` 的 tickCumulatives 差除以窗長（Solidity 整數除法、向零截斷）得到平均
 *    tick，再過 `TickMathLite.getSqrtPriceAtTick` 換成 Q64.96。這不是「sqrtPrice 的平均」：
 *    sqrtPrice 對 tick 是指數映射，兩者的算術平均在分佈不對稱時差很多，而 oracle 取的是前者。
 * 2. 截斷會留餘數，所以 oracle 在 `delta % window != 0` 時把平均 tick 往「提高 tokenIn 價格」的
 *    一側挪一格：`inIsToken0 && delta > 0` 加一，`!inIsToken0 && delta < 0` 減一。這裡照抄，因為
 *    差一格就是差 1bp（0.01%），正好落在交叉驗證的容許誤差邊界上。
 * 3. `_quote` 走 **raw 單位**：pool 價格本來就是 raw `token1` per raw `token0`，
 *    `10^(decimalsOut - decimalsIn)` 已經在比值裡，**不可以再乘一次**。方向由 `inIsToken0` 決定：
 *    `inIsToken0` 時 out = amountIn × price（ceil），否則 out = amountIn ÷ price（ceil）。
 *    兩個方向都向上取整，所以地板不會是弱的一側。
 * 4. sanity gate：oracle 讀 `slot0` 只用來擋「pool 鎖住 / cardinality < 2 / spot 超出合法 sqrt 範圍」，
 *    讀完就丟掉，報價完全不含 spot。注意 `maxOracleAge` **沒有**出現在 `previewSwap` 裡（它只是
 *    constructor 的配置關係式 `twapWindow <= maxOracleAge`），所以這裡也不必檢查資料新舊：
 *    `observe` 本身在窗長超出 ring buffer 時就會 revert，那就是「TWAP 未成熟」。
 *
 * 與 oracle 的刻意差異：oracle 的 `minimum` 是「TWAP 地板與近 5 分鐘地板取大」，那是給賣出當地板用的；
 * 這裡只要 `quoted`（純 TWAP 報價），所以不實作 recent-mean 那一段。交叉驗證比的是 `quoted`。
 */

/** 一個 tick 的價格倍率是 1.0001，tick 邊界與 Uniswap V3 相同。 */
const MIN_TICK = -887_272n;
const MAX_TICK = 887_272n;
/** Uniswap V3 合法 sqrt price 的上下界（Q64.96）。 */
const MIN_SQRT_RATIO = 4_295_128_739n;
const MAX_SQRT_RATIO = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;
/** Q64.96 的定點位數。 */
export const Q96 = 1n << 96n;
/** `priceE8` 的定點位數：1 顆 token 值多少 USDT，放大 1e8。 */
export const PRICE_SCALE_E8 = 100_000_000n;
/** 預設 TWAP 窗長，與已部署 oracle 的 `twapWindow()` 一致。 */
export const DEFAULT_TWAP_WINDOW_SECONDS = 1800;

/** 錯誤分類：讓「fork 掛了」「pool 沒有 code」「TWAP 未成熟」「算出 0」在 log 裡分得開。 */
export type PricingErrorCode =
  | 'POOL_NO_CODE'
  | 'POOL_TOKEN_READ_FAILED'
  | 'TOKEN_NOT_IN_POOL'
  | 'QUOTE_TOKEN_MISMATCH'
  | 'TWAP_UNAVAILABLE'
  | 'POOL_PRICE_INVALID'
  | 'MEAN_TICK_OUT_OF_RANGE'
  | 'TICK_OUT_OF_RANGE'
  | 'DECIMALS_UNAVAILABLE'
  | 'ZERO_QUOTE';

/** 定價失敗一律帶 `code`，呼叫端不必去 parse 訊息字串。 */
export class PricingError extends Error {
  readonly code: PricingErrorCode;

  constructor(code: PricingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PricingError';
    this.code = code;
  }
}

/** 只放這支檔案需要的四個 pool 成員。`observe` 的回傳順序與 Uniswap V3 相同。 */
const V3_POOL_ABI = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
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
      { name: 'feeProtocol', type: 'uint32' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [{ name: 'secondsAgos', type: 'uint32[]' }],
    outputs: [
      { name: 'tickCumulatives', type: 'int56[]' },
      { name: 'secondsPerLiquidityCumulativeX128s', type: 'uint160[]' },
    ],
  },
] as const;

const ERC20_DECIMALS_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

// ---------------------------------------------------------------------------
// tick math（自寫，逐行對齊 TickMathLite / Uniswap V3 TickMath.getSqrtRatioAtTick）
// ---------------------------------------------------------------------------

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator === 0n ? quotient : quotient + 1n;
}

/**
 * sqrt(1.0001^tick) 的 Q64.96 值。
 *
 * 與 Uniswap V3 `TickMath.getSqrtRatioAtTick`、以及 oracle 內嵌的 `TickMathLite` 同一組魔數與同一條
 * 路徑（逐位相乘後右移 128、正 tick 取倒數、Q128.128 → Q64.96 向上取整），所以同一個 tick 在
 * 三處會得到完全相同的 uint160。超出 tick 邊界擲錯而不是夾住。
 */
export function getSqrtPriceAtTick(tick: bigint): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new PricingError('TICK_OUT_OF_RANGE', `tick ${tick} 超出 PancakeSwap V3 的 [${MIN_TICK}, ${MAX_TICK}]`);
  }
  const absTick = tick < 0n ? -tick : tick;

  let ratio =
    (absTick & 0x1n) === 0n ? 0x100000000000000000000000000000000n : 0xfffcb933bd6fad37aa2d162d1a594001n;
  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  // 上面的乘積是 1/sqrt(1.0001)^|tick| 的 Q128.128，正 tick 要取倒數。
  if (tick > 0n) ratio = ((1n << 256n) - 1n) / ratio;

  // Q128.128 → Q64.96，向上取整（與 TickMathLite 一致）。
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** 視窗內的 tick cumulative 差 → 平均 tick（含 oracle 的「往有利一側挪一格」）。 */
export function meanTickFromCumulatives(args: {
  /** `observe([window, 0])` 的 `tickCumulatives[0]`：window 秒前那一點。 */
  tickCumulativeAgo: bigint;
  /** `observe([window, 0])` 的 `tickCumulatives[1]`：現在那一點。 */
  tickCumulativeNow: bigint;
  windowSeconds: number;
  /** 賣出的是不是 token0（決定截斷後要往哪一側挪）。 */
  inIsToken0: boolean;
}): bigint {
  if (args.windowSeconds <= 0) {
    throw new PricingError('TWAP_UNAVAILABLE', `window ${args.windowSeconds} 必須是正整數秒`);
  }
  // cumulative tick 是 int56 並且刻意會 wrap，有界窗長用 wrap 後的差即可（與 oracle 相同）。
  const delta = args.tickCumulativeNow - args.tickCumulativeAgo;
  const window = BigInt(args.windowSeconds);
  // BigInt 的 `/` 與 Solidity 的整數除法一樣向零截斷。
  let meanTick = delta / window;
  if (delta % window !== 0n) {
    // 截斷讓平均 tick 往 0 靠一格；往「提高 tokenIn 價格」的一側補回來。
    if (args.inIsToken0 && delta > 0n) meanTick += 1n;
    else if (!args.inIsToken0 && delta < 0n) meanTick -= 1n;
  }
  if (meanTick < MIN_TICK || meanTick > MAX_TICK) {
    throw new PricingError(
      'MEAN_TICK_OUT_OF_RANGE',
      `平均 tick ${meanTick} 超出 [${MIN_TICK}, ${MAX_TICK}]：pool 的 tickCumulatives 不可信`,
    );
  }
  return meanTick;
}

/**
 * 在 `sqrtPriceX96` 上把 `amountIn` 的 raw `tokenIn` 換成 raw `tokenOut`，向上取整。
 *
 * 與 oracle `_quote` 同一條算式，包含 `sqrtPriceX96 > type(uint128).max` 時改用 Q128.128 的分支
 * （那條分支只有在極端價格才走得到，但少寫它就會在邊界溢位）。
 */
export function quoteRawAtSqrtPrice(args: {
  amountIn: bigint;
  sqrtPriceX96: bigint;
  /** true = 用 token0 換 token1（乘），false = 用 token1 換 token0（除）。 */
  inIsToken0: boolean;
}): bigint {
  const { amountIn, sqrtPriceX96, inIsToken0 } = args;
  if (sqrtPriceX96 <= (1n << 128n) - 1n) {
    // price = sqrtPriceX96^2 / 2^192，用 Q128.128 比值精確持有。
    const ratioX128 = sqrtPriceX96 * sqrtPriceX96;
    return inIsToken0
      ? ceilDiv(amountIn * ratioX128, 1n << 192n)
      : ceilDiv(amountIn << 192n, ratioX128);
  }
  // sqrtPriceX96^2 會溢位：只留 128 個小數位。
  if (inIsToken0) {
    const ratioX128 = ceilDiv(sqrtPriceX96 * sqrtPriceX96, 1n << 64n);
    return ceilDiv(amountIn * ratioX128, 1n << 128n);
  }
  const ratioX128 = (sqrtPriceX96 * sqrtPriceX96) / (1n << 64n);
  return ceilDiv(amountIn << 128n, ratioX128);
}

/** `quotedRaw`（1 顆 token 換到的 raw tokenOut）→ 1 顆 token 值多少 tokenOut，放大 1e8。 */
function priceE8FromQuoted(quotedRaw: bigint, outDecimals: number): bigint {
  return (quotedRaw * PRICE_SCALE_E8) / 10n ** BigInt(outDecimals);
}

/**
 * 在 `sqrtPriceX96` 上算 1 顆 token 值多少 tokenOut，放大 1e8。
 *
 * decimals 只能透過 `10^(inDecimals)` 進來：pool 的比值本來就是 raw 對 raw，所以
 * 「1 顆 *人類單位* 的 token 值多少 *人類單位* 的 tokenOut」= quotedRaw × 10^inDecimals / 10^outDecimals。
 * 直接把 amountIn 設成 `10^inDecimals` 就讓 inDecimals 自然約掉，這也是 6 與 18 混用時唯一不會出錯的寫法。
 */
export function priceE8FromSqrtPriceX96(args: {
  sqrtPriceX96: bigint;
  inIsToken0: boolean;
  inDecimals: number;
  outDecimals: number;
}): bigint {
  const quotedRaw = quoteRawAtSqrtPrice({
    amountIn: 10n ** BigInt(args.inDecimals),
    sqrtPriceX96: args.sqrtPriceX96,
    inIsToken0: args.inIsToken0,
  });
  return priceE8FromQuoted(quotedRaw, args.outDecimals);
}

// ---------------------------------------------------------------------------
// 鏈上讀取
// ---------------------------------------------------------------------------

function atIndex<T>(values: readonly T[], index: number, what: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new PricingError(
      'TWAP_UNAVAILABLE',
      `${what} 少了索引 ${index}（長度 ${values.length}）：pool 回傳的 observe 不是 ` +
        `[window, 0] 的兩點，不能拿來算 TWAP`,
    );
  }
  return value;
}

function reasonOf(cause: unknown): string {
  const shortMessage = (cause as { shortMessage?: string } | null)?.shortMessage;
  if (typeof shortMessage === 'string') return shortMessage;
  return cause instanceof Error ? cause.message : String(cause);
}

async function readDecimals(publicClient: PublicClient, token: Address, blockNumber?: bigint): Promise<number> {
  try {
    return await publicClient.readContract({
      address: token,
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
      blockNumber,
    });
  } catch (cause) {
    throw new PricingError(
      'DECIMALS_UNAVAILABLE',
      `讀不到 ${token} 的 decimals：不是 ERC-20 metadata，或節點拒絕 eth_call（${reasonOf(cause)}）`,
      { cause },
    );
  }
}

/** 一次 pool 讀取要釘住的塊高。省略 = 讀 head，那種價格與快照標記的塊對不上。 */
export type PoolReadArgs = {
  pool: Address;
  /** 要報價的 token。 */
  token: Address;
  /** 報價的分母：`priceable_assets where is_numeraire` 的地址。pool 的另一邊必須就是它。 */
  expectedQuoteToken: Address;
  blockNumber?: bigint;
};

/** 一個 pool 的兩個成員，加上「哪一邊是分母」與「token 在哪一邊」。 */
export type PoolDirection = {
  token0: Address;
  token1: Address;
  /** `token` 的另一邊，也就是這個池子對 `token` 報價時的分母；已驗證等於 `expectedQuoteToken`。 */
  quoteToken: Address;
  isToken0: boolean;
};

/**
 * 判斷 `token` 是 `pool` 的 token0 還是 token1，驗證另一邊是 numeraire，並回傳兩邊。
 *
 * 先確認 pool 有 code：地址打錯時 eth_call 會回 `0x`，viem 的解碼錯誤指不到「pool 沒部署」這件事，
 * 所以在最前面就分成 POOL_NO_CODE 與 POOL_TOKEN_READ_FAILED 兩種。
 *
 * **分母是被驗證的，不是被假設的。** 只驗「token 在池裡」不夠：`priceable_assets.usdt_pool` 若被填成
 * 另一個也含這顆 token 的池（例如 NVDAB/WBNB），報價會拿 WBNB 當分母，算出來的數字照樣是「一個合理
 * 的數量級」——漂移就靜默算錯。所以這裡要求 pool 的另一邊**就是** numeraire，不符就擲
 * QUOTE_TOKEN_MISMATCH（訊息帶期望的 numeraire 與實際的另一邊兩個地址）。
 *
 * 不採「兩邊都試」：那是把分母交給池子的排列方式決定，而分母只能是 numeraire。
 */
export async function resolvePoolDirection(
  publicClient: PublicClient,
  args: PoolReadArgs,
): Promise<PoolDirection> {
  const { pool, token, expectedQuoteToken, blockNumber } = args;

  const code = await publicClient.getCode({ address: pool, blockNumber });
  if (!code || code === '0x') {
    throw new PricingError('POOL_NO_CODE', `pool ${pool} 沒有 code：地址打錯，或這條鏈上沒有部署`);
  }

  let token0: Address;
  let token1: Address;
  try {
    [token0, token1] = await Promise.all([
      publicClient.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'token0', blockNumber }),
      publicClient.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'token1', blockNumber }),
    ]);
  } catch (cause) {
    throw new PricingError(
      'POOL_TOKEN_READ_FAILED',
      `${pool} 有 code 但讀不到 token0/token1：這不是 PancakeSwap V3 pool（${reasonOf(cause)}）`,
      { cause },
    );
  }

  const want = token.toLowerCase();
  const isToken0 = want === token0.toLowerCase();
  if (!isToken0 && want !== token1.toLowerCase()) {
    throw new PricingError(
      'TOKEN_NOT_IN_POOL',
      `${token} 不是 pool ${pool} 的成員（token0=${token0}, token1=${token1}）：池子選錯，或 fee tier 不對`,
    );
  }

  const quoteToken = isToken0 ? token1 : token0;
  if (quoteToken.toLowerCase() !== expectedQuoteToken.toLowerCase()) {
    throw new PricingError(
      'QUOTE_TOKEN_MISMATCH',
      `pool ${pool} 的另一邊是 ${quoteToken}，但期望的 numeraire 是 ${expectedQuoteToken}：` +
        '報價的分母只能是 numeraire，usdt_pool 填錯了池子或 token',
    );
  }
  return { token0, token1, quoteToken, isToken0 };
}

/**
 * 從 PancakeSwap V3 pool 讀 TWAP，算出 1 顆 `token` 的價格，放大 1e8。
 *
 * `usdtPool` 必須是「`token` 與 numeraire 的 pool」，而 numeraire 由 `expectedQuoteToken` 指定
 * （呼叫端從 DB 的 `priceable_assets where is_numeraire` 取得）。pool 的另一邊不是它就直接擲
 * QUOTE_TOKEN_MISMATCH：分母是定義的一部分，不能從池子的排列反推。
 *
 * `blockNumber` 一律透傳到每一個 eth_call（含 `getCode` 與 `decimals`）：餘額讀 block N、價格讀 head
 * 的話，「同一份觀測」根本不成立，而且同一個 block 重跑會得到不同價格。
 *
 * 失敗一律擲 `PricingError` 並帶 `code`：pool 沒 code、pool 不是 V3、token 不在 pool 裡、
 * 另一邊不是 numeraire、TWAP 未成熟（observe revert 或 cardinality < 2）、spot 超出合法範圍、
 * decimals 讀不到、算出 0。
 */
export async function twapPriceInUsdt(
  publicClient: PublicClient,
  args: {
    token: Address;
    usdtPool: Address;
    /** 報價的分母：`priceable_assets where is_numeraire` 的地址。 */
    expectedQuoteToken: Address;
    twapWindowSeconds?: number;
    /** 要釘住的塊高。省略 = 讀 head（價格與餘額就可能來自不同塊）。 */
    blockNumber?: bigint;
  },
): Promise<{ priceE8: bigint; quotedRaw: bigint; decimals: number }> {
  const window = args.twapWindowSeconds ?? DEFAULT_TWAP_WINDOW_SECONDS;
  const { quoteToken: outToken, isToken0 } = await resolvePoolDirection(publicClient, {
    pool: args.usdtPool,
    token: args.token,
    expectedQuoteToken: args.expectedQuoteToken,
    blockNumber: args.blockNumber,
  });

  const [decimals, outDecimals] = await Promise.all([
    readDecimals(publicClient, args.token, args.blockNumber),
    readDecimals(publicClient, outToken, args.blockNumber),
  ]);

  // sanity gate 與 oracle 相同：讀 slot0 只為了擋「pool 鎖住 / 觀測點不足 / spot 超出合法 sqrt 範圍」，
  // 讀完就丟掉——報價完全不含 spot。oracle 的 maxOracleAge 不在 previewSwap 路徑上，這裡也不檢查。
  const slot0 = await publicClient.readContract({
    address: args.usdtPool,
    abi: V3_POOL_ABI,
    functionName: 'slot0',
    blockNumber: args.blockNumber,
  });
  const [, , , observationCardinality, , , unlocked] = slot0;
  const spotSqrtPriceX96 = slot0[0];
  if (!unlocked) {
    throw new PricingError('TWAP_UNAVAILABLE', `pool ${args.usdtPool} 目前鎖住（slot0.unlocked = false）`);
  }
  if (observationCardinality < 2) {
    throw new PricingError(
      'TWAP_UNAVAILABLE',
      `pool ${args.usdtPool} 的 observationCardinality = ${observationCardinality} < 2：ring buffer 只有一個點，任何窗長都算不出 TWAP`,
    );
  }
  if (spotSqrtPriceX96 < MIN_SQRT_RATIO || spotSqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new PricingError(
      'POOL_PRICE_INVALID',
      `pool ${args.usdtPool} 的 spot sqrtPriceX96 = ${spotSqrtPriceX96} 超出 [${MIN_SQRT_RATIO}, ${MAX_SQRT_RATIO})`,
    );
  }

  let tickCumulatives: readonly bigint[];
  try {
    const observed = await publicClient.readContract({
      address: args.usdtPool,
      abi: V3_POOL_ABI,
      functionName: 'observe',
      args: [[window, 0]],
      blockNumber: args.blockNumber,
    });
    tickCumulatives = observed[0];
  } catch (cause) {
    throw new PricingError(
      'TWAP_UNAVAILABLE',
      `pool ${args.usdtPool} 的 observe([${window}, 0]) revert：TWAP 未成熟（cardinality = ` +
        `${observationCardinality}，或最舊觀測點不足 ${window} 秒）或節點拒絕查詢（${reasonOf(cause)}）`,
      { cause },
    );
  }
  if (tickCumulatives.length !== 2) {
    throw new PricingError(
      'TWAP_UNAVAILABLE',
      `observe([${window}, 0]) 回傳 ${tickCumulatives.length} 個 tickCumulatives，預期 2 個`,
    );
  }

  const meanTick = meanTickFromCumulatives({
    tickCumulativeAgo: atIndex(tickCumulatives, 0, 'tickCumulatives'),
    tickCumulativeNow: atIndex(tickCumulatives, 1, 'tickCumulatives'),
    windowSeconds: window,
    inIsToken0: isToken0,
  });
  const sqrtPriceX96 = getSqrtPriceAtTick(meanTick);
  const quotedRaw = quoteRawAtSqrtPrice({ amountIn: 10n ** BigInt(decimals), sqrtPriceX96, inIsToken0: isToken0 });
  // `_quote` 兩個方向都向上取整，所以 amountIn > 0 時 quoted 不可能真的是 0；留這個判斷是為了對齊 oracle
  // 的 `if (quoted == 0) revert ZeroQuote()`，讓「真的算出 0」不會靜靜地流到下游當價格。
  if (quotedRaw === 0n) {
    throw new PricingError(
      'ZERO_QUOTE',
      `1 顆 ${args.token}（${decimals} decimals）在 mean tick ${meanTick} 上換到 0 個 raw ${outToken}`,
    );
  }

  const priceE8 = priceE8FromQuoted(quotedRaw, outDecimals);
  // 這才是實務上會踩到的「算出 0」：in/out 的 decimals 差太大時，1e8 定點把小幣價格截斷成 0。
  if (priceE8 === 0n) {
    throw new PricingError(
      'ZERO_QUOTE',
      `1 顆 ${args.token} 的價格在 1e8 定點下截斷成 0（quotedRaw = ${quotedRaw}, ` +
        `${outToken} decimals = ${outDecimals}）：精度不足以表示，不能當價格用`,
    );
  }

  return { priceE8, quotedRaw, decimals };
}
