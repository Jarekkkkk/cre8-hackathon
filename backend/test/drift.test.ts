import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeDrift,
  parseHoldingsJson,
  parseNumeric18,
  parseSnapshotRows,
} from '../src/drift.js';
import type { AssetDrift, DriftReport, Holding, TargetWeight } from '../src/drift.js';

/**
 * `backend/src/drift.ts` 的單元測試：純函式，不碰鏈也不碰 DB。
 *
 * 定點數的慣例：amountWei 是代幣最小單位，usdPriceE8 是每「整顆」代幣的 USDT 價格 ×1e8。
 * 下面的 fixture 一律用「$1.00 的資產 + 整數顆數」開場，好讓手算的 bps 直接看得出來。
 */

const ONE_USD = 100_000_000n;

/** tokens 整顆（以 10^decimals 為單位）→ Holding。 */
function holding(asset: string, tokens: bigint, priceE8 = ONE_USD, decimals = 18): Holding {
  return { asset, amountWei: tokens * 10n ** BigInt(decimals), decimals, usdPriceE8: priceE8 };
}

function target(asset: string, weightBps: number): TargetWeight {
  return { asset, weightBps };
}

/** 取報告裡的某個資產；找不到就讓測試失敗，而不是回 undefined 讓斷言變成無意義的比較。 */
function driftOf(report: DriftReport, asset: string): AssetDrift {
  const found = report.assets.find((entry) => entry.asset === asset);
  assert.ok(found, `asset ${asset} is missing from the report`);
  return found;
}

// ---------------------------------------------------------------------------
// 正常情況與手算值
// ---------------------------------------------------------------------------

test('computeDrift returns zero gross drift when the book matches the target exactly', () => {
  // 50 顆 + 50 顆，各 $1 → 5000bps / 5000bps。
  const report = computeDrift(
    [holding('AAA', 50n), holding('BBB', 50n)],
    [target('AAA', 5000), target('BBB', 5000)],
    100,
  );

  assert.equal(report.totalUsdE8, 10_000_000_000n); // 100 顆 × $1，E8 定點
  assert.equal(report.grossDriftBps, 0);
  assert.equal(report.maxAbsDeltaBps, 0);
  assert.equal(report.needsRebalance, false);
  assert.equal(report.thresholdBps, 100);
  assert.deepEqual(
    report.assets.map((entry) => [entry.asset, entry.currentBps, entry.deltaBps]),
    [
      ['AAA', 5000, 0],
      ['BBB', 5000, 0],
    ],
  );
});

test('computeDrift reports the hand-computed drift of a single deviation (60/40 vs 50/50)', () => {
  // 60 顆 A（$60）+ 40 顆 B（$40）= $100。目標 50/50。
  // currentBps = 6000 / 4000 → delta +1000 / -1000 → Σ|delta| = 2000 → gross = 2000/2 = 1000。
  const report = computeDrift(
    [holding('AAA', 60n), holding('BBB', 40n)],
    [target('AAA', 5000), target('BBB', 5000)],
    100,
  );

  assert.equal(report.totalUsdE8, 10_000_000_000n);
  assert.equal(driftOf(report, 'AAA').usdValueE8, 6_000_000_000n);
  assert.equal(driftOf(report, 'AAA').currentBps, 6000);
  assert.equal(driftOf(report, 'AAA').deltaBps, 1000);
  assert.equal(driftOf(report, 'BBB').currentBps, 4000);
  assert.equal(driftOf(report, 'BBB').deltaBps, -1000);
  assert.equal(report.grossDriftBps, 1000);
  assert.equal(report.maxAbsDeltaBps, 1000);
  assert.equal(report.needsRebalance, true);
});

test('computeDrift treats drift exactly at the threshold as "rebalance" (>=, not >)', () => {
  const holdings = [holding('AAA', 60n), holding('BBB', 40n)];
  const targets = [target('AAA', 5000), target('BBB', 5000)];

  const atThreshold = computeDrift(holdings, targets, 1000);
  assert.equal(atThreshold.grossDriftBps, 1000);
  assert.equal(atThreshold.needsRebalance, true);

  const justAbove = computeDrift(holdings, targets, 1001);
  assert.equal(justAbove.grossDriftBps, 1000);
  assert.equal(justAbove.needsRebalance, false);

  // 門檻 0 永遠成立（0 >= 0）。
  assert.equal(computeDrift(holdings, targets, 0).needsRebalance, true);
});

// ---------------------------------------------------------------------------
// 邊界情況
// ---------------------------------------------------------------------------

test('computeDrift on an empty book reports every asset at 0bps and gross drift 5000', () => {
  // 空倉：沒有東西可以搬，但「不在目標上」是事實 → Σ|0-5000| × 2 = 10000，gross = 5000。
  const report = computeDrift([], [target('AAA', 5000), target('BBB', 5000)], 100);

  assert.equal(report.totalUsdE8, 0n);
  assert.equal(report.assets.length, 2);
  for (const entry of report.assets) {
    assert.equal(entry.currentBps, 0);
    assert.equal(entry.usdValueE8, 0n);
    assert.equal(entry.deltaBps, -entry.targetBps);
  }
  assert.equal(report.grossDriftBps, 5000);
  assert.equal(report.maxAbsDeltaBps, 5000);
  // 空倉會觸發再平衡：呼叫端要靠 totalUsdE8 === 0n 自己區分「沒錢可搬」與「真的偏離」。
  assert.equal(report.needsRebalance, true);
});

test('computeDrift counts a holding that is not a target in the total, with targetBps 0', () => {
  // 目標只有 AAA；使用者自己買了 50 顆 XXX。總值仍是 $100，AAA 只佔 5000bps。
  const report = computeDrift(
    [holding('AAA', 50n), holding('XXX', 50n)],
    [target('AAA', 10000)],
    100,
  );

  assert.equal(report.totalUsdE8, 10_000_000_000n); // XXX 的 $50 有計入
  assert.equal(driftOf(report, 'AAA').currentBps, 5000);
  assert.equal(driftOf(report, 'AAA').deltaBps, -5000);
  assert.equal(driftOf(report, 'XXX').targetBps, 0);
  assert.equal(driftOf(report, 'XXX').currentBps, 5000);
  assert.equal(driftOf(report, 'XXX').deltaBps, 5000);
  assert.equal(report.grossDriftBps, 5000);
  // 報告順序：目標先，多買的接在後面。
  assert.deepEqual(
    report.assets.map((entry) => entry.asset),
    ['AAA', 'XXX'],
  );
});

test('computeDrift keeps an unheld target in the report with deltaBps = -targetBps', () => {
  // 目標 70/30，實際只有 AAA $100 → AAA 10000bps、BBB 0bps。
  const report = computeDrift([holding('AAA', 100n)], [target('AAA', 7000), target('BBB', 3000)], 100);

  const held = driftOf(report, 'AAA');
  assert.equal(held.currentBps, 10000);
  assert.equal(held.deltaBps, 3000);

  const missing = driftOf(report, 'BBB');
  assert.equal(missing.usdValueE8, 0n);
  assert.equal(missing.currentBps, 0);
  assert.equal(missing.targetBps, 3000);
  assert.equal(missing.deltaBps, -3000);

  assert.equal(report.grossDriftBps, 3000);
  assert.equal(report.maxAbsDeltaBps, 3000);
});

// ---------------------------------------------------------------------------
// 資料錯誤：必須拋錯，不能靜默算下去
// ---------------------------------------------------------------------------

test('computeDrift throws when target weights do not sum to 10000 bps', () => {
  assert.throws(
    () => computeDrift([holding('AAA', 100n)], [target('AAA', 6000), target('BBB', 3000)], 100),
    /must sum to 10000 bps, got 9000/,
  );
});

test('computeDrift throws on a weight outside 0..10000 even when the sum looks right', () => {
  assert.throws(
    () => computeDrift([holding('AAA', 100n)], [target('AAA', 15000), target('BBB', -5000)], 100),
    /weightBps must be an integer in 0\.\.10000/,
  );
});

test('computeDrift throws on a duplicated target asset', () => {
  assert.throws(
    () => computeDrift([holding('AAA', 100n)], [target('AAA', 5000), target('AAA', 5000)], 100),
    /duplicate target asset: AAA/,
  );
});

test('computeDrift throws on a duplicated holding asset', () => {
  assert.throws(
    () =>
      computeDrift(
        [holding('AAA', 60n), holding('AAA', 40n)],
        [target('AAA', 5000), target('BBB', 5000)],
        100,
      ),
    /duplicate holding asset: AAA/,
  );
});

test('computeDrift rejects a negative amount or price and a bad threshold', () => {
  const targets = [target('AAA', 10000)];
  assert.throws(
    () => computeDrift([{ asset: 'AAA', amountWei: -1n, decimals: 18, usdPriceE8: ONE_USD }], targets, 100),
    /amountWei must not be negative/,
  );
  assert.throws(
    () => computeDrift([{ asset: 'AAA', amountWei: 1n, decimals: 18, usdPriceE8: -1n }], targets, 100),
    /usdPriceE8 must not be negative/,
  );
  assert.throws(() => computeDrift([], targets, -1), /thresholdBps must be an integer in 0\.\.10000/);
  assert.throws(() => computeDrift([], targets, 10_001), /thresholdBps must be an integer in 0\.\.10000/);
  assert.throws(() => computeDrift([], targets, 1.5), /thresholdBps must be an integer in 0\.\.10000/);
});

// ---------------------------------------------------------------------------
// 大數字與取整
// ---------------------------------------------------------------------------

test('computeDrift holds values far beyond 2^53 without losing precision', () => {
  // amountWei = 1e38，價格 $1e30（E8 定點）→ 每個資產 1e50（E8），遠超 Number.MAX_SAFE_INTEGER。
  const report = computeDrift(
    [holding('AAA', 10n ** 20n, 10n ** 30n), holding('BBB', 10n ** 20n, 10n ** 30n)],
    [target('AAA', 5000), target('BBB', 5000)],
    100,
  );

  assert.equal(driftOf(report, 'AAA').usdValueE8, 10n ** 50n);
  assert.equal(report.totalUsdE8, 2n * 10n ** 50n);
  assert.deepEqual(
    report.assets.map((entry) => entry.currentBps),
    [5000, 5000],
  );
  assert.equal(report.grossDriftBps, 0);
});

test('computeDrift truncates each usdValueE8 (integer division) instead of rounding', () => {
  // 3 個最小單位、2 位小數（= 0.03 顆）、價格 1e-8 USDT → 3 × 1 ÷ 100 = 0.03，截斷成 0。
  const report = computeDrift(
    [{ asset: 'AAA', amountWei: 3n, decimals: 2, usdPriceE8: 1n }],
    [target('AAA', 10000)],
    100,
  );

  assert.equal(driftOf(report, 'AAA').usdValueE8, 0n);
  assert.equal(report.totalUsdE8, 0n);
});

test('computeDrift rounds currentBps half-up and tolerates a sum that is not exactly 10000', () => {
  // decimals 0、價格 1（E8 最小單位）→ amountWei 本身就是 E8 的 USD 值：1 對 19999。
  // currentBps: 1×10000/20000 = 0.5 → 1（half-up）、19999×10000/20000 = 9999.5 → 10000。
  // 相加 10001 ≠ 10000：取整誤差，不是資料錯誤，所以不拋錯。
  const report = computeDrift(
    [holding('AAA', 1n, 1n, 0), holding('BBB', 19999n, 1n, 0)],
    [target('AAA', 1), target('BBB', 9999)],
    100,
  );

  assert.equal(driftOf(report, 'AAA').currentBps, 1);
  assert.equal(driftOf(report, 'BBB').currentBps, 10000);
  const sum = report.assets.reduce((acc, entry) => acc + entry.currentBps, 0);
  assert.equal(sum, 10001);
  // Σ|delta| = |1-1| + |10000-9999| = 1 → gross = round(0.5) = 1。
  assert.equal(report.grossDriftBps, 1);
});

// ---------------------------------------------------------------------------
// numeric(38,18) → bigint
// ---------------------------------------------------------------------------

test('parseNumeric18 parses a numeric(38,18) string exactly, without going through Number', () => {
  assert.equal(parseNumeric18('123.456789000000000000'), 123_456_789_000_000_000_000n);
  assert.equal(parseNumeric18('0.000000000000000001'), 1n);
  assert.equal(parseNumeric18('0.000000000000000000'), 0n);
  assert.equal(parseNumeric18('1000'), 1_000n * 10n ** 18n);
  assert.equal(parseNumeric18('1000.000000000000000000'), 1_000n * 10n ** 18n);
  assert.equal(parseNumeric18('0.1'), 10n ** 17n);
  assert.equal(parseNumeric18(7n), 7n * 10n ** 18n);
  // 19 位小數在 numeric(38,18) 存不進去；截斷會靜默失真，所以拋錯。
  assert.throws(() => parseNumeric18('1.0000000000000000001'), /more than 18 decimal places/);
  assert.throws(() => parseNumeric18('abc'), /not a numeric/);
  // 走 Number 會失真：明確拒絕，避免呼叫端把 number 傳進來。
  assert.throws(
    () => parseNumeric18(123.456 as unknown as string),
    /never a number/,
  );
});

test('parseSnapshotRows derives usdPriceE8 from amount and usd_value', () => {
  // 10 顆、usd_value $25 → 每顆 $2.50 = 250000000（E8）。
  const holdings = parseSnapshotRows([
    { asset: 'NVDAB', amount: '10.000000000000000000', usd_value: '25.000000000000000000' },
  ]);

  assert.deepEqual(holdings, [
    { asset: 'NVDAB', amountWei: 10n * 10n ** 18n, decimals: 18, usdPriceE8: 250_000_000n },
  ]);

  // 反推回來算出的價值要對得上 usd_value（$25 = 25e8）。
  const report = computeDrift(holdings, [target('NVDAB', 10000)], 100);
  assert.equal(report.totalUsdE8, 2_500_000_000n);
});

test('parseSnapshotRows prefers an explicit price, defaults decimals to 18 and honours it', () => {
  const holdings = parseSnapshotRows([
    { asset: 'AAA', amount: '2.500000000000000000', usd_value: '1.000000000000000000', usdPriceE8: ONE_USD },
    { asset: 'BBB', amount: '12', decimals: 6, usd_value: '6.000000000000000000' },
  ]);

  assert.equal(holdings[0]?.usdPriceE8, ONE_USD); // 用給定的價格，不由 $1/2.5 反推
  assert.equal(holdings[1]?.amountWei, 12n * 10n ** 6n);
  // 12 顆、$6 → 每顆 $0.50 = 50000000（E8）。
  assert.equal(holdings[1]?.usdPriceE8, 50_000_000n);
});

test('parseSnapshotRows refuses an unpriced row and a zero amount with a non-zero value', () => {
  assert.throws(
    () => parseSnapshotRows([{ asset: 'AAA', amount: '1.000000000000000000' }]),
    /no usd_value and no usdPriceE8/,
  );
  assert.throws(
    () =>
      parseSnapshotRows([
        { asset: 'AAA', amount: '0.000000000000000000', usd_value: '5.000000000000000000' },
      ]),
    /usd_value is non-zero but amount is zero/,
  );
  // 0 顆 0 元是合法的空持倉（價格無從得知，記 0；價值本來就是 0）。
  assert.deepEqual(
    parseSnapshotRows([{ asset: 'AAA', amount: '0.000000000000000000', usd_value: '0.000000000000000000' }]),
    [{ asset: 'AAA', amountWei: 0n, decimals: 18, usdPriceE8: 0n }],
  );
});

test('parseHoldingsJson is the same function as parseSnapshotRows', () => {
  assert.equal(parseHoldingsJson, parseSnapshotRows);
});
