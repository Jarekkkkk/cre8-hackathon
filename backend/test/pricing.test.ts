import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address, Hex, PublicClient } from 'viem';
import {
  PricingError,
  getSqrtPriceAtTick,
  meanTickFromCumulatives,
  priceE8FromSqrtPriceX96,
  quoteRawAtSqrtPrice,
  resolvePoolDirection,
  twapPriceInUsdt,
} from '../src/pricing.js';

/**
 * 純單元：不碰鏈、不碰 DB。全部釘在「已知值」上，因為這支檔案存在的理由是算術要與鏈上 oracle 逐位相同，
 * 而不是「跑得過」。
 *
 * 已知值的來源分三層：
 * 1. 教科書值：tick 0 就是 sqrt(1.0001^0) = 1 = 2^96；tick 邊界就是 Uniswap V3 的 MIN/MAX_SQRT_RATIO。
 * 2. 手算：tick ±1 的期望值由 sqrt(1.0001) × 2^96 與 2^96 ÷ sqrt(1.0001) 獨立得出（下方註解寫出算式）。
 * 3. 鏈上實測：tick 52410 的 sqrtPriceX96 落在 NVDAB/USDT pool 的 slot0 區間內，這一條在
 *    test/pricing.crosscheck.test.ts 對真的 anvil 驗，不在這裡（這裡不連鏈）。
 */

const Q96 = 1n << 96n;
const USDT = '0x55d398326f99059fF775485246999027B3197955' as Address;
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address;
const POOL = '0x36696169C63e42cd08ce11f5deeBbCeBae652050' as Address;
const TOKEN = '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436' as Address;
const NO_CODE = '0x000000000000000000000000000000000000dead' as Address;

/** 100 ppm = 0.01%，價格比對的硬門檻（crosscheck 與單元共用）。 */
function relativePpm(a: bigint, b: bigint): bigint {
  const diff = a > b ? a - b : b - a;
  const base = b === 0n ? 1n : b;
  return (diff * 1_000_000n) / base;
}

// ---------------------------------------------------------------------------
// tick -> sqrtPriceX96
// ---------------------------------------------------------------------------

test('getSqrtPriceAtTick: tick 0 就是 1.0，即 2^96', () => {
  assert.equal(getSqrtPriceAtTick(0n), Q96);
  assert.equal(getSqrtPriceAtTick(0n), 79228162514264337593543950336n);
});

test('getSqrtPriceAtTick: tick 邊界等於 Uniswap V3 的 MIN/MAX_SQRT_RATIO', () => {
  // 這兩個常數是 Uniswap V3 TickMath 的公開測試向量，也正是 oracle 的 MIN_SQRT_RATIO / MAX_SQRT_RATIO。
  assert.equal(getSqrtPriceAtTick(-887272n), 4_295_128_739n);
  assert.equal(getSqrtPriceAtTick(887272n), 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n);
});

test('getSqrtPriceAtTick: tick ±1 對上 sqrt(1.0001)^±1 × 2^96 的手算值', () => {
  // sqrt(1.0001) = 1.0000499987500624...；2^96 = 79228162514264337593543950336
  // tick +1：79228162514264337593543950336 × 1.00004999875… = 79232123823359799118286999567.6… → 向上取整
  assert.equal(getSqrtPriceAtTick(1n), 79232123823359799118286999568n);
  // tick -1：79228162514264337593543950336 ÷ 1.00004999875… = 79224201403219477170569942573.9… → 向上取整
  assert.equal(getSqrtPriceAtTick(-1n), 79224201403219477170569942574n);

  // 兩個方向都向上取整，所以 tick>0 的值必然略大於 2^96、tick<0 的值必然略小。
  assert.ok(getSqrtPriceAtTick(1n) > Q96);
  assert.ok(getSqrtPriceAtTick(-1n) < Q96);
});

test('getSqrtPriceAtTick: tick 越大 sqrtPrice 越大（含跨 0）', () => {
  const ticks = [-887272n, -100000n, -1000n, -1n, 0n, 1n, 1000n, 100000n, 887272n];
  const prices = ticks.map((tick) => getSqrtPriceAtTick(tick));
  for (let i = 1; i < prices.length; i += 1) {
    const previous = prices[i - 1];
    const current = prices[i];
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(current > previous, `tick ${ticks[i]} 的 sqrtPrice 應該大於 tick ${ticks[i - 1]}`);
  }
});

test('getSqrtPriceAtTick: 相鄰 tick 的比值就是 sqrt(1.0001)，tick 0/±1 的實測比值也吻合', () => {
  // 1.0001 的平方根 = 1.0000499987500624；用 1e12 定點比對，容差 1 個 tick 的取整誤差。
  const ratioScaled = (getSqrtPriceAtTick(1n) * 10n ** 12n) / getSqrtPriceAtTick(0n);
  assert.equal(ratioScaled, 1_000_049_998_750n);
});

test('getSqrtPriceAtTick: 超出 tick 邊界擲 TICK_OUT_OF_RANGE（不夾住）', () => {
  for (const tick of [887273n, -887273n, 10n ** 9n, -(10n ** 9n)]) {
    assert.throws(
      () => getSqrtPriceAtTick(tick),
      (error: unknown) => error instanceof PricingError && error.code === 'TICK_OUT_OF_RANGE',
    );
  }
});

// ---------------------------------------------------------------------------
// sqrtPriceX96 -> price（含 decimals 與方向）
// ---------------------------------------------------------------------------

test('priceE8FromSqrtPriceX96: sqrtPriceX96 = 2^96 且兩邊 decimals 相同時是 1:1', () => {
  const priceE8 = priceE8FromSqrtPriceX96({ sqrtPriceX96: Q96, inIsToken0: true, inDecimals: 18, outDecimals: 18 });
  assert.equal(priceE8, 100_000_000n); // 1e8 = 1.0
  assert.equal(
    priceE8FromSqrtPriceX96({ sqrtPriceX96: Q96, inIsToken0: false, inDecimals: 18, outDecimals: 18 }),
    100_000_000n,
  );
  // 6 vs 6 也一樣是 1:1
  assert.equal(
    priceE8FromSqrtPriceX96({ sqrtPriceX96: Q96, inIsToken0: true, inDecimals: 6, outDecimals: 6 }),
    100_000_000n,
  );
});

test('priceE8FromSqrtPriceX96: raw 1:1 但 decimals 不同時，換算就是 10^(inDecimals-outDecimals)', () => {
  // raw 1:1 表示 1 個最小單位 token0 換 1 個最小單位 token1；換成人類單位要乘 10^(in-out)。
  // 18 in / 6 out：1 顆 18-dec token = 1e12 顆 6-dec token → 1e8 × 1e12
  assert.equal(
    priceE8FromSqrtPriceX96({ sqrtPriceX96: Q96, inIsToken0: true, inDecimals: 18, outDecimals: 6 }),
    100_000_000_000_000_000_000n,
  );
  // 6 in / 18 out：1 顆 6-dec token = 1e-12 顆 18-dec token → 0.000001 e8 單位，截斷成 0。
  // 這不是 bug 而是「精度不足以表示」，twapPriceInUsdt 會把它升級成 ZERO_QUOTE（見下面的錯誤測試）。
  assert.equal(
    priceE8FromSqrtPriceX96({ sqrtPriceX96: Q96, inIsToken0: true, inDecimals: 6, outDecimals: 18 }),
    0n,
  );
});

test('priceE8FromSqrtPriceX96: raw 價格 4（sqrtPriceX96 = 2^97）時是 4 顆，decimals 再乘上去', () => {
  assert.equal(
    priceE8FromSqrtPriceX96({ sqrtPriceX96: 2n * Q96, inIsToken0: true, inDecimals: 18, outDecimals: 18 }),
    400_000_000n,
  );
  assert.equal(
    priceE8FromSqrtPriceX96({ sqrtPriceX96: 2n * Q96, inIsToken0: true, inDecimals: 18, outDecimals: 6 }),
    400_000_000_000_000_000_000n,
  );
});

test('priceE8FromSqrtPriceX96: token0/token1 方向對調時互為倒數', () => {
  // 用真實的 WBNB/USDT mean sqrtPrice（1 WBNB ≈ 696.71 USDT），兩個方向相乘應該是 1.0（= 1e16 在 e8×e8）。
  const sqrtPriceX96 = 3001599999025678706327659731n;
  const wbnbInUsdt = priceE8FromSqrtPriceX96({ sqrtPriceX96, inIsToken0: false, inDecimals: 18, outDecimals: 18 });
  const usdtInWbnb = priceE8FromSqrtPriceX96({ sqrtPriceX96, inIsToken0: true, inDecimals: 18, outDecimals: 18 });

  assert.equal(wbnbInUsdt, 69_671_239_076n); // 696.71239076 USDT / WBNB
  assert.equal(usdtInWbnb, 143_531n); // 0.00143531 WBNB / USDT
  // 乘積是 1.0 的 e8×e8 表示。兩邊都是「ceil 之後再截斷到 1e-8」，所以乘積只能精確到 1e-8 級；
  // 這裡容許 1e-5 的相對誤差（實測 ~1.7e-6），方向對調錯了會差好幾個數量級，不會誤判。
  const product = wbnbInUsdt * usdtInWbnb;
  assert.ok((product > 10n ** 16n ? product - 10n ** 16n : 10n ** 16n - product) * 100_000n <= 10n ** 16n);
});

// ---------------------------------------------------------------------------
// quoteRawAtSqrtPrice
// ---------------------------------------------------------------------------

test('quoteRawAtSqrtPrice: 兩個方向都向上取整，且乘的方向對 amountIn 線性', () => {
  const sqrtPriceX96 = 3001599999025678706327659731n;
  const one = quoteRawAtSqrtPrice({ amountIn: 10n ** 18n, sqrtPriceX96, inIsToken0: false });
  const two = quoteRawAtSqrtPrice({ amountIn: 2n * 10n ** 18n, sqrtPriceX96, inIsToken0: false });
  assert.equal(one, 696_712_390_769_630_497_444n);
  // ceil 讓 2 倍輸入不會剛好等於 2 倍輸出，但差距只可能在最後一位。
  assert.ok(two === 2n * one || two === 2n * one - 1n);

  // 乘的方向：ceil(amountIn × ratio / 2^192) 必然 >= 真值，且減一之後一定 < 真值。
  const ratioX128 = sqrtPriceX96 * sqrtPriceX96;
  const product = 10n ** 18n * ratioX128;
  const ceilQuote = quoteRawAtSqrtPrice({ amountIn: 10n ** 18n, sqrtPriceX96, inIsToken0: true });
  assert.ok(ceilQuote * (1n << 192n) >= product);
  assert.ok((ceilQuote - 1n) * (1n << 192n) < product);
});

test('quoteRawAtSqrtPrice: sqrtPriceX96 > uint128 時走 Q128.128 分支，結果仍可用', () => {
  // 那條分支只在極端價格出現（sqrtPrice 超過 3.4e38），但少了它就是邊界溢位。
  const huge = (1n << 128n) + 1n;
  const quoted = quoteRawAtSqrtPrice({ amountIn: 10n ** 18n, sqrtPriceX96: huge, inIsToken0: true });
  assert.ok(quoted > 0n);
  const quotedReverse = quoteRawAtSqrtPrice({ amountIn: 10n ** 18n, sqrtPriceX96: huge, inIsToken0: false });
  assert.ok(quotedReverse > 0n && quotedReverse < 10n ** 18n);
});

// ---------------------------------------------------------------------------
// meanTickFromCumulatives
// ---------------------------------------------------------------------------

test('meanTickFromCumulatives: 整除時就是平均值，不挪動', () => {
  assert.equal(
    meanTickFromCumulatives({
      tickCumulativeAgo: 0n,
      tickCumulativeNow: 1800n * 42n,
      windowSeconds: 1800,
      inIsToken0: true,
    }),
    42n,
  );
  assert.equal(
    meanTickFromCumulatives({
      tickCumulativeAgo: 0n,
      tickCumulativeNow: -1800n * 42n,
      windowSeconds: 1800,
      inIsToken0: false,
    }),
    -42n,
  );
  // delta = 0（整段窗長 tick 都在 0）→ mean tick = 0
  assert.equal(
    meanTickFromCumulatives({ tickCumulativeAgo: 7n, tickCumulativeNow: 7n, windowSeconds: 1800, inIsToken0: true }),
    0n,
  );
});

test('meanTickFromCumulatives: 有餘數時往「提高 tokenIn 價格」的一側挪一格（四種組合）', () => {
  const half = 900n; // 半個窗長的餘數：真值 -10.5 或 +10.5
  // delta > 0 且賣 token0：+10.5 → 截斷成 10 → 挪成 11（tick 越高，token0 換到的 token1 越多）
  assert.equal(
    meanTickFromCumulatives({
      tickCumulativeAgo: 0n,
      tickCumulativeNow: 1800n * 10n + half,
      windowSeconds: 1800,
      inIsToken0: true,
    }),
    11n,
  );
  // delta > 0 但賣 token1：token1 的價格是 1/tick 方向，挪高會讓賣方更虧，所以不挪 → 10
  assert.equal(
    meanTickFromCumulatives({
      tickCumulativeAgo: 0n,
      tickCumulativeNow: 1800n * 10n + half,
      windowSeconds: 1800,
      inIsToken0: false,
    }),
    10n,
  );
  // delta < 0 且賣 token1：-10.5 → 截斷成 -10 → 挪成 -11（tick 越低，token1 換到的 token0 越多）
  assert.equal(
    meanTickFromCumulatives({
      tickCumulativeAgo: 0n,
      tickCumulativeNow: -1800n * 10n - half,
      windowSeconds: 1800,
      inIsToken0: false,
    }),
    -11n,
  );
  // delta < 0 但賣 token0：不挪 → -10
  assert.equal(
    meanTickFromCumulatives({
      tickCumulativeAgo: 0n,
      tickCumulativeNow: -1800n * 10n - half,
      windowSeconds: 1800,
      inIsToken0: true,
    }),
    -10n,
  );
});

test('meanTickFromCumulatives: 用 WBNB/USDT pool 的實測 cumulative 得到 -65467（spot tick -65475）', () => {
  // 2025 anvil fork 的 observe([1800, 0]) 實測值；token=WBNB=token1，所以 inIsToken0=false。
  // delta = -117840455，/1800 截斷成 -65466，賣 token1 且 delta<0 → 挪成 -65467。
  assert.equal(
    meanTickFromCumulatives({
      tickCumulativeAgo: -7_124_437_874_756n,
      tickCumulativeNow: -7_124_555_715_211n,
      windowSeconds: 1800,
      inIsToken0: false,
    }),
    -65467n,
  );
});

test('meanTickFromCumulatives: 窗長非正數擲 TWAP_UNAVAILABLE', () => {
  for (const windowSeconds of [0, -1]) {
    assert.throws(
      () =>
        meanTickFromCumulatives({
          tickCumulativeAgo: 0n,
          tickCumulativeNow: 0n,
          windowSeconds,
          inIsToken0: true,
        }),
      (error: unknown) => error instanceof PricingError && error.code === 'TWAP_UNAVAILABLE',
    );
  }
});

test('meanTickFromCumulatives: 平均 tick 超出邊界擲 MEAN_TICK_OUT_OF_RANGE', () => {
  assert.throws(
    () =>
      meanTickFromCumulatives({
        tickCumulativeAgo: 0n,
        tickCumulativeNow: 1800n * 887_273n,
        windowSeconds: 1800,
        inIsToken0: true,
      }),
    (error: unknown) => error instanceof PricingError && error.code === 'MEAN_TICK_OUT_OF_RANGE',
  );
});

// ---------------------------------------------------------------------------
// 錯誤路徑（用 stub publicClient，不連鏈）
// ---------------------------------------------------------------------------

type StubValue = unknown | { throws: string };

const REVERT = { throws: 'execution reverted' };

/** 一次 eth_call 的紀錄：`functionName` 用來逐項檢查「這一支到底有沒有帶 blockNumber」。 */
type StubCall = { functionName: string; address: string; blockNumber?: bigint };

/**
 * 只回答 `getCode` / `readContract` 的 publicClient。每個成員可以是一個值，或 `{ throws }` 表示 revert，
 * 這樣「pool 沒 code」「observe revert」「decimals 讀不到」「算出 0」都能在不連鏈的情況下被逼出來。
 *
 * `calls` 會記下每一次呼叫連同它的 blockNumber：`blockNumber` 漏傳是一個「跑得過但數字每次都不一樣」
 * 的 bug，只有記下來才驗得到。
 */
function stubClient(options: {
  code?: Hex;
  token0?: StubValue;
  token1?: StubValue;
  decimals?: Record<string, StubValue>;
  slot0?: StubValue;
  observe?: StubValue;
  observeCalls?: number[][];
  calls?: StubCall[];
}): PublicClient {
  const unwrap = (value: StubValue): unknown => {
    if (value !== null && typeof value === 'object' && 'throws' in (value as Record<string, unknown>)) {
      throw new Error((value as { throws: string }).throws);
    }
    return value;
  };

  return {
    getCode: async (call: { address: Address; blockNumber?: bigint }) => {
      options.calls?.push({ functionName: 'getCode', address: call.address, blockNumber: call.blockNumber });
      return options.code ?? '0x6080604052';
    },
    readContract: async (call: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }): Promise<unknown> => {
      options.calls?.push({ functionName: call.functionName, address: call.address, blockNumber: call.blockNumber });
      switch (call.functionName) {
        case 'token0':
          return unwrap(options.token0 ?? POOL_TOKEN0);
        case 'token1':
          return unwrap(options.token1 ?? POOL_TOKEN1);
        case 'decimals': {
          const configured = options.decimals?.[call.address.toLowerCase()];
          return unwrap(configured ?? 18);
        }
        case 'slot0':
          return unwrap(options.slot0 ?? DEFAULT_SLOT0);
        case 'observe': {
          const secondsAgos = call.args?.[0];
          if (Array.isArray(secondsAgos)) options.observeCalls?.push(secondsAgos as number[]);
          return unwrap(options.observe ?? DEFAULT_OBSERVE);
        }
        default:
          throw new Error(`stub: 不支援的 functionName ${call.functionName}`);
      }
    },
  } as unknown as PublicClient;
}

const POOL_TOKEN0 = USDT;
const POOL_TOKEN1 = WBNB;
/** cardinality = 2100、unlocked = true、spot sqrtPrice 合法（抄 WBNB/USDT pool 的實測值）。 */
const DEFAULT_SLOT0: [bigint, number, number, number, number, number, boolean] = [
  3_000_453_949_349_995_917_541_991_178n,
  -65_475,
  820,
  2100,
  2100,
  222_825_800,
  true,
];
/** observe([1800,0]) 的實測值。 */
const DEFAULT_OBSERVE: [readonly bigint[], readonly bigint[]] = [
  [-7_124_437_874_756n, -7_124_555_715_211n],
  [1_876_838_725_314_259_811_201_452n, 1_876_838_896_209_607_858_823_123n],
];

test('resolvePoolDirection: token 是 token1 時 isToken0 = false，並回傳兩邊', async () => {
  const direction = await resolvePoolDirection(stubClient({}), { pool: POOL, token: WBNB, expectedQuoteToken: USDT });
  assert.equal(direction.isToken0, false);
  assert.equal(direction.token0, USDT);
  assert.equal(direction.token1, WBNB);
});

test('resolvePoolDirection: 大小寫不同的地址仍然認得出來（不會因為 checksum 而誤判）', async () => {
  const lower = WBNB.toLowerCase() as Address;
  const direction = await resolvePoolDirection(stubClient({}), { pool: POOL, token: lower, expectedQuoteToken: USDT });
  assert.equal(direction.isToken0, false);
});

test('resolvePoolDirection: pool 沒有 code 擲 POOL_NO_CODE（不會變成 viem 的解碼錯誤）', async () => {
  await assert.rejects(
    resolvePoolDirection(stubClient({ code: '0x' }), { pool: NO_CODE, token: WBNB, expectedQuoteToken: USDT }),
    (error: unknown) => error instanceof PricingError && error.code === 'POOL_NO_CODE',
  );
});

test('resolvePoolDirection: 有 code 但讀不到 token0/token1 擲 POOL_TOKEN_READ_FAILED', async () => {
  await assert.rejects(
    resolvePoolDirection(stubClient({ token0: REVERT }), { pool: USDT, token: WBNB, expectedQuoteToken: USDT }),
    (error: unknown) =>
      error instanceof PricingError &&
      error.code === 'POOL_TOKEN_READ_FAILED' &&
      error.message.includes('execution reverted'),
  );
});

test('resolvePoolDirection: token 不在 pool 裡擲 TOKEN_NOT_IN_POOL（池子選錯 / fee tier 不對）', async () => {
  await assert.rejects(
    resolvePoolDirection(stubClient({}), { pool: POOL, token: TOKEN, expectedQuoteToken: USDT }),
    (error: unknown) => error instanceof PricingError && error.code === 'TOKEN_NOT_IN_POOL',
  );
});

test('resolvePoolDirection: 池的另一邊不是 numeraire 擲 QUOTE_TOKEN_MISMATCH，訊息含兩個地址', async () => {
  // 這正是 priceable_assets.usdt_pool 被填成 NVDAB/WBNB（那池真的存在）的形狀：token 在池裡，
  // 但分母是 WBNB。沒有這條驗證，報價會用 WBNB 當分母算出一個「數量級合理、幣別錯誤」的價格。
  await assert.rejects(
    resolvePoolDirection(stubClient({ token0: TOKEN, token1: WBNB }), {
      pool: POOL,
      token: TOKEN,
      expectedQuoteToken: USDT,
    }),
    (error: unknown) =>
      error instanceof PricingError &&
      error.code === 'QUOTE_TOKEN_MISMATCH' &&
      error.message.includes(WBNB) &&
      error.message.includes(USDT) &&
      error.message.includes('numeraire'),
  );
});

test('twapPriceInUsdt: 拿 WBNB 當分母的池子報價 → QUOTE_TOKEN_MISMATCH（不「兩邊都試」）', async () => {
  // 同一條錯誤從對外入口也打得到：呼叫端不可能「忘了傳分母」就繞過驗證。
  await assert.rejects(
    twapPriceInUsdt(stubClient({ token0: TOKEN, token1: WBNB }), {
      token: TOKEN,
      usdtPool: POOL,
      expectedQuoteToken: USDT,
    }),
    (error: unknown) => error instanceof PricingError && error.code === 'QUOTE_TOKEN_MISMATCH',
  );
});

test('twapPriceInUsdt: 預設窗長 1800 秒，observe 收到的是 [1800, 0]', async () => {
  const observeCalls: number[][] = [];
  const client = stubClient({ observeCalls });
  const price = await twapPriceInUsdt(client, { token: WBNB, usdtPool: POOL, expectedQuoteToken: USDT });

  assert.deepEqual(observeCalls, [[1800, 0]]);
  assert.equal(price.decimals, 18);
  assert.equal(price.quotedRaw, 696_712_390_769_630_497_444n);
  assert.equal(price.priceE8, 69_671_239_076n); // 696.71239076 USDT / WBNB
});

test('twapPriceInUsdt: twapWindowSeconds 會傳進 observe', async () => {
  const observeCalls: number[][] = [];
  // 窗長換了，cumulative 就要跟著換比例：60 秒窗、tick 固定 -65475 → delta = -65475 × 60。
  const observe = [[-3_928_500n, 0n], [0n, 0n]];
  const price = await twapPriceInUsdt(stubClient({ observeCalls, observe }), {
    token: WBNB,
    usdtPool: POOL,
    expectedQuoteToken: USDT,
    twapWindowSeconds: 60,
  });
  assert.deepEqual(observeCalls, [[60, 0]]);
  // 短窗直接反映低 tick：1 WBNB 只剩 ~697 USDT 之外的差別不存在，這裡只驗證窗長真的傳下去了。
  assert.ok(price.quotedRaw > 0n);
});

test('twapPriceInUsdt: cardinality < 2 擲 TWAP_UNAVAILABLE 並說明原因', async () => {
  const slot0 = [...DEFAULT_SLOT0];
  slot0[3] = 1; // observationCardinality
  await assert.rejects(
    twapPriceInUsdt(stubClient({ slot0 }), { token: WBNB, usdtPool: POOL, expectedQuoteToken: USDT }),
    (error: unknown) =>
      error instanceof PricingError &&
      error.code === 'TWAP_UNAVAILABLE' &&
      error.message.includes('observationCardinality = 1'),
  );
});

test('twapPriceInUsdt: pool 鎖住時擲 TWAP_UNAVAILABLE', async () => {
  const slot0 = [...DEFAULT_SLOT0];
  slot0[6] = false; // unlocked
  await assert.rejects(
    twapPriceInUsdt(stubClient({ slot0 }), { token: WBNB, usdtPool: POOL, expectedQuoteToken: USDT }),
    (error: unknown) =>
      error instanceof PricingError && error.code === 'TWAP_UNAVAILABLE' && error.message.includes('鎖住'),
  );
});

test('twapPriceInUsdt: spot 超出合法 sqrt 範圍擲 POOL_PRICE_INVALID', async () => {
  const slot0 = [...DEFAULT_SLOT0];
  slot0[0] = 4_295_128_738n; // 比 MIN_SQRT_RATIO 少 1
  await assert.rejects(
    twapPriceInUsdt(stubClient({ slot0 }), { token: WBNB, usdtPool: POOL, expectedQuoteToken: USDT }),
    (error: unknown) => error instanceof PricingError && error.code === 'POOL_PRICE_INVALID',
  );
});

test('twapPriceInUsdt: observe revert（TWAP 未成熟）擲 TWAP_UNAVAILABLE，並保留原始 cause', async () => {
  await assert.rejects(
    twapPriceInUsdt(stubClient({ observe: REVERT }), { token: WBNB, usdtPool: POOL, expectedQuoteToken: USDT }),
    (error: unknown) =>
      error instanceof PricingError &&
      error.code === 'TWAP_UNAVAILABLE' &&
      error.message.includes('TWAP 未成熟') &&
      error.cause instanceof Error,
  );
});

test('twapPriceInUsdt: observe 回傳形狀不是兩點時擲 TWAP_UNAVAILABLE', async () => {
  const observe = [[-7_124_437_874_756n], [1n]];
  await assert.rejects(
    twapPriceInUsdt(stubClient({ observe }), { token: WBNB, usdtPool: POOL, expectedQuoteToken: USDT }),
    (error: unknown) =>
      error instanceof PricingError &&
      error.code === 'TWAP_UNAVAILABLE' &&
      error.message.includes('預期 2 個'),
  );
});

test('twapPriceInUsdt: decimals 讀不到擲 DECIMALS_UNAVAILABLE（指名是哪顆 token）', async () => {
  await assert.rejects(
    twapPriceInUsdt(stubClient({ decimals: { [WBNB.toLowerCase()]: REVERT } }), { token: WBNB, usdtPool: POOL, expectedQuoteToken: USDT }),
    (error: unknown) =>
      error instanceof PricingError &&
      error.code === 'DECIMALS_UNAVAILABLE' &&
      error.message.includes(WBNB),
  );
});

test('twapPriceInUsdt: 1e8 定點算出 0 擲 ZERO_QUOTE（不是靜默回 0）', async () => {
  // 被定價的 token 只有 6 decimals、報價的 USDT 是 18 decimals：raw 價格 0.0014353 下
  // 1 顆 6-dec token 只值 ~0.0697 USDT，放進 1e8 定點後截斷成 0 → 必須炸，不能讓 0 流到漂移計算裡。
  await assert.rejects(
    twapPriceInUsdt(stubClient({ decimals: { [WBNB.toLowerCase()]: 6 } }), { token: WBNB, usdtPool: POOL, expectedQuoteToken: USDT }),
    (error: unknown) =>
      error instanceof PricingError &&
      error.code === 'ZERO_QUOTE' &&
      error.message.includes('截斷成 0'),
  );
});

test('twapPriceInUsdt: 同一個 block 重跑兩次，quotedRaw 與 priceE8 逐位相同', async () => {
  const BLOCK = 132_044_086n;
  const args = { token: WBNB, usdtPool: POOL, expectedQuoteToken: USDT, blockNumber: BLOCK } as const;
  const first = await twapPriceInUsdt(stubClient({}), args);
  const second = await twapPriceInUsdt(stubClient({}), args);
  assert.equal(first.quotedRaw, second.quotedRaw, '同一個 block 的 quotedRaw 必須完全相同（一個 wei 都不差）');
  assert.equal(first.priceE8, second.priceE8);
  assert.equal(relativePpm(first.priceE8, second.priceE8), 0n);
});

test('twapPriceInUsdt: blockNumber 透傳到每一個 eth_call（7 支全部釘住，一支都不能漏）', async () => {
  const calls: StubCall[] = [];
  const BLOCK = 132_044_086n;
  await twapPriceInUsdt(stubClient({ calls }), {
    token: WBNB,
    usdtPool: POOL,
    expectedQuoteToken: USDT,
    blockNumber: BLOCK,
  });

  // 一次報價剛好 7 支呼叫：getCode、token0、token1、兩次 decimals、slot0、observe。
  // 漏掉任何一支，那一支就是讀 head：餘額 block N、價格 head，「同一份觀測」不成立。
  assert.deepEqual(
    calls.map((call) => call.functionName).sort(),
    ['decimals', 'decimals', 'getCode', 'observe', 'slot0', 'token0', 'token1'],
  );
  for (const call of calls) {
    assert.equal(
      call.blockNumber,
      BLOCK,
      `${call.functionName}(${call.address}) 沒有釘在 block ${BLOCK} 上：收到 ${call.blockNumber}`,
    );
  }
});
