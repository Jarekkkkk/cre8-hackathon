import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress } from 'viem';
import { DEFAULT_MIN_SESSION_GAS_WEI, loadConfig, loadGasConfig } from '../src/config.js';
import { OPS_GAS_PER_OPERATION, describeGasStatus, perOperationCostWei } from '../src/funding.js';

/**
 * 這支測試只碰純函式與純解析器：不連 DB、不連鏈。
 *
 * 一次 op 的實測數字：gasUsed ≈ 900,000（含 calldata 與兩筆 swap 的 rebalance）、gas price ≈ 1.22 gwei，
 * 所以一次 op ≈ 0.0003 BNB。下面的固定值都繞著這組數字，讓「這條算式算錯了」與「市場變了」分得開。
 */

const ACCOUNT = getAddress('0x1234567890abcdef1234567890abcdef12345678');
const MINIMUM_WEI = 10n ** 16n; // 0.01 BNB
const GAS_PRICE_WEI = 1_220_000_000n; // 1.22 gwei
// 獨立寫死（不 import 常數），否則常數本身錯了測試還是綠。
// 900k 的來源：三次真實 rebalance 的 actualGasUsed 是 870,901 / 938,431 / 935k 左右。
// 舊值 250k 只算了 handleOps 的骨架（不含 calldata 與 swap），會讓 estimatedOps 高估 3.5 倍。
const OP_GAS = 900_000n;

test('describeGasStatus: 餘額低於門檻時 ready=false，shortfall 是還缺多少 wei', () => {
  const balanceWei = 4n * 10n ** 15n; // 0.004 BNB

  const status = describeGasStatus({ address: ACCOUNT, balanceWei, minimumWei: MINIMUM_WEI, gasPriceWei: GAS_PRICE_WEI });

  assert.equal(status.address, ACCOUNT);
  assert.equal(status.ready, false);
  assert.equal(status.balanceWei, '4000000000000000');
  assert.equal(status.minimumWei, '10000000000000000');
  assert.equal(status.shortfallWei, '6000000000000000'); // 0.006 BNB
  assert.equal(BigInt(status.balanceWei) + BigInt(status.shortfallWei), BigInt(status.minimumWei));
});

test('describeGasStatus: 餘額剛好等於門檻就算 ready，shortfall 是 "0"', () => {
  const atMinimum = describeGasStatus({
    address: ACCOUNT,
    balanceWei: MINIMUM_WEI,
    minimumWei: MINIMUM_WEI,
    gasPriceWei: GAS_PRICE_WEI,
  });
  assert.equal(atMinimum.ready, true);
  assert.equal(atMinimum.shortfallWei, '0');

  const above = describeGasStatus({
    address: ACCOUNT,
    balanceWei: 5n * 10n ** 17n, // 0.5 BNB
    minimumWei: MINIMUM_WEI,
    gasPriceWei: GAS_PRICE_WEI,
  });
  assert.equal(above.ready, true);
  assert.equal(above.shortfallWei, '0');
  assert.equal(above.balanceWei, '500000000000000000');
});

test('describeGasStatus: estimatedOps = balance / (900k gas * gasPrice)，向下取整', () => {
  const costPerOp = OP_GAS * GAS_PRICE_WEI; // 1,098,000,000,000,000 wei ≈ 0.0011 BNB

  const exactlySeven = describeGasStatus({
    address: ACCOUNT,
    balanceWei: costPerOp * 7n,
    minimumWei: MINIMUM_WEI,
    gasPriceWei: GAS_PRICE_WEI,
  });
  assert.equal(exactlySeven.estimatedOps, 7);

  const sevenAndABit = describeGasStatus({
    address: ACCOUNT,
    balanceWei: costPerOp * 7n + costPerOp - 1n, // 差 1 wei 才滿第 8 次
    minimumWei: MINIMUM_WEI,
    gasPriceWei: GAS_PRICE_WEI,
  });
  assert.equal(sevenAndABit.estimatedOps, 7);

  // 錨點：1 BNB（GasPolicy 的 1 BNB 預算上限）在這裡大約是 910 次 op。
  // 舊的估算（250k gas/op）會說 3278 —— 那是高估 3.5 倍，而這個數字會顯示給使用者。
  const oneBnb = describeGasStatus({
    address: ACCOUNT,
    balanceWei: 10n ** 18n,
    minimumWei: MINIMUM_WEI,
    gasPriceWei: GAS_PRICE_WEI,
  });
  assert.equal(oneBnb.estimatedOps, 910);
});

test('describeGasStatus: gasPrice 是 0 時 estimatedOps 回 0，不除以零也不拋', () => {
  const status = describeGasStatus({
    address: ACCOUNT,
    balanceWei: 10n ** 18n,
    minimumWei: MINIMUM_WEI,
    gasPriceWei: 0n,
  });

  assert.equal(status.estimatedOps, 0);
  assert.equal(status.gasPriceKnown, false);
  // ready 只看餘額：gas price 取不到純粹是「估不出次數」，不是「跑不動」。
  assert.equal(status.ready, true);
  assert.equal(status.balanceWei, '1000000000000000000');

  assert.equal(perOperationCostWei(0n), 0n);
});

test('describeGasStatus: 極大餘額不溢位，estimatedOps 被 clamp 在安全整數上限', () => {
  const hugeBalance = OP_GAS * (BigInt(Number.MAX_SAFE_INTEGER) + 1000n); // 遠超過 Number.MAX_SAFE_INTEGER 次
  const status = describeGasStatus({
    address: ACCOUNT,
    balanceWei: hugeBalance,
    minimumWei: MINIMUM_WEI,
    gasPriceWei: 1n,
  });

  assert.equal(status.estimatedOps, Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isSafeInteger(status.estimatedOps));
  // 原值是 bigint，字串化不失真（JSON 精度問題就是這樣避開的）。
  assert.equal(status.balanceWei, hugeBalance.toString());
  assert.equal(status.ready, true);
});

test('describeGasStatus: estimatedOps 的 per-op 成本與 OPS_GAS_PER_OPERATION 一致', () => {
  assert.equal(OPS_GAS_PER_OPERATION, OP_GAS);
  assert.equal(perOperationCostWei(GAS_PRICE_WEI), OP_GAS * GAS_PRICE_WEI);
  // gas price 未知時成本回 0（呼叫端必須先看 gasPriceKnown），不是負數也不是 NaN。
  assert.equal(perOperationCostWei(-1n), 0n);
});

test('MIN_SESSION_GAS_WEI: bigint 解析，預設 0.0005 BNB', () => {
  // 預設值一路 0.01 → 0.002 → 0.0005：一筆 sudo UserOp 約 0.000025 BNB，
  // 0.0005 = 20 筆餘裕。前面的門檻對小額測試高到荒謬（見 config.ts 的說明）。
  assert.equal(DEFAULT_MIN_SESSION_GAS_WEI, 5n * 10n ** 14n);
  assert.equal(loadGasConfig({}).minSessionGasWei, 500000000000000n);

  // 精確到 wei：這些值用 Number 早就失真了（10^16 > Number.MAX_SAFE_INTEGER）。
  assert.equal(loadGasConfig({ MIN_SESSION_GAS_WEI: '25000000000000000' }).minSessionGasWei, 25n * 10n ** 15n);
  assert.equal(
    loadGasConfig({ MIN_SESSION_GAS_WEI: ' 1000000000000000000 ' }).minSessionGasWei,
    10n ** 18n,
  );
  // 超過 Number.MAX_SAFE_INTEGER 的值仍然逐位正確。
  assert.equal(
    loadGasConfig({ MIN_SESSION_GAS_WEI: '9007199254740993' }).minSessionGasWei,
    9007199254740993n,
  );

  assert.throws(() => loadGasConfig({ MIN_SESSION_GAS_WEI: '1e16' }), /MIN_SESSION_GAS_WEI/);
  assert.throws(() => loadGasConfig({ MIN_SESSION_GAS_WEI: '-1' }), /MIN_SESSION_GAS_WEI/);
  assert.throws(() => loadGasConfig({ MIN_SESSION_GAS_WEI: '0.01' }), /MIN_SESSION_GAS_WEI/);
  assert.throws(() => loadGasConfig({ MIN_SESSION_GAS_WEI: '0x10' }), /MIN_SESSION_GAS_WEI/);
});

test('MIN_SESSION_GAS_WEI: 不在 loadConfig 的回傳形狀裡（策略測試的 deepEqual 不受影響）', () => {
  // 形狀與 test/strategies.test.ts 的 deepEqual 一致：多一個鍵就會讓那支測試紅掉。
  assert.deepEqual(loadConfig({ DATABASE_URL: 'postgres://localhost/cre8', MIN_SESSION_GAS_WEI: '1' }), {
    databaseUrl: 'postgres://localhost/cre8',
    port: 8080,
    authDomain: 'localhost',
    authUri: 'http://localhost',
    chainId: 56,
    rpcUrl: null,
    operatorPrivateKey: null,
    registryAddress: null,
  });
});
