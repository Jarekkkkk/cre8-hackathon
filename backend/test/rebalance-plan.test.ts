import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, decodeAbiParameters, encodePacked, getAddress, http } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { bsc } from 'viem/chains';
import { computeDrift } from '../src/drift.js';
import type { DriftReport, Holding, TargetWeight } from '../src/drift.js';
import {
  DEFAULT_DEADLINE_SECONDS,
  MAX_DEADLINE_SECONDS,
  V3_SWAP_EXACT_IN,
  amountInFor,
  minGrossFor,
  moveValueE8,
  planRebalance,
  amountOutMinWithBuffer,} from '../src/rebalance-plan.js';
import type { PlanRebalanceArgs, PlannedStep, RebalancePlan } from '../src/rebalance-plan.js';
import { DEFAULT_MAX_IMPACT_BPS, resolveMaxImpactBps } from '../src/rebalance-plan.js';
import { capAmountInForImpact, estimateImpact } from '../src/impact.js';
import type { PoolImpactState } from '../src/impact.js';
import { twapPriceInUsdt } from '../src/pricing.js';

/**
 * 規劃器的測試。三種結果（noop / blocked / ready）各自的**理由**與**數字**都要釘死：
 * 這支程式的輸出直接變成鏈上參數，錯一個欄位就是一次 revert 或（更糟）一次多賣。
 *
 * 不碰鏈的部分用 stub client（`readContract` 依 `functionName` 分派，與 positions/holdings-scan 的
 * stub 同一個模式），所以整組可以在沒有 anvil 的機器上跑完。最後一組是**真 fork 的交叉驗證**：
 * 用真的 `previewSwap` / `effectiveFeeBps` / `pool.fee()` 驗 minGross 與 path，環境不可用時明確 skip。
 */

const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' as Address;
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
/** 6 位小數的穩定幣（BSC 上的 USDT 其實是 18 位；這裡刻意用 6 位證明 decimals 真的進到算式裡）。 */
const TOKEN6 = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' as Address;
/** 第三個代幣，用來製造「不是 oracle pair」的情境。 */
const TOKEN3 = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436' as Address;

const ORACLE = '0x3D79c9BE8c087097Cbb1A8Be0D2714cf8BA95B84' as Address;
const EXECUTOR = '0x60691760815C69d32c1f68146FA11669F62A4b38' as Address;
const REGISTRY = '0x27739a1AD35a924F5545C7d04C2B0537069CA76C' as Address;
const WBNB_USDT_POOL = '0x36696169C63e42cd08ce11f5deeBbCeBae652050' as Address;

// hub 堆疊（AtpMultiPoolOracle + executorMultiPool）。TOKEN3 就是鏈上的 NVDAB。
const ROUTER = '0x132cDfCe34d385f783dAB7F011B2E66E78A2f87f' as Address;
const EXECUTOR_MULTI = '0x9C41696ea7FaA5470eAfb77415D063beEef83f4a' as Address;
const ORACLE_WBNB_USDT = '0x535111F60a9cB7C3b95A17fB8d1dd2D17275DBFE' as Address;
const ORACLE_NVDAB_USDT = '0x12Ce4542B25fe53a3c606dd7783513357b6D838d' as Address;
const NVDAB_USDT_POOL = '0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C' as Address;
/** 測試專用：第 4 個資產的 per-pair oracle／池（stub 的地址，不宣稱鏈上有這兩個合約）。 */
const ORACLE_TOKEN6_USDT = '0x00000000000000000000000000000000000fEED1' as Address;
const TOKEN6_USDT_POOL = '0x00000000000000000000000000000000000fEED2' as Address;

/** 1e8 定點：$1000。 */
const PRICE_1000_USD = 100_000_000_000n;
/** 1e8 定點：$1。 */
const PRICE_1_USD = 100_000_000n;

/** 解 `inputs[0]` 用的 ABI：刻意自己寫一份，不從被測檔案 import（否則編錯會一起錯）。 */
const V3_INPUT_ABI = [
  { name: 'recipient', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'amountOutMin', type: 'uint256' },
  { name: 'path', type: 'bytes' },
  { name: 'payerIsUser', type: 'bool' },
] as const;

type ChainCall = { functionName: string; address: string; args?: readonly unknown[]; blockNumber?: bigint };

/** hub 模式：`asset → per-pair oracle + 它的池`（`AtpMultiPoolOracle.oracleOf` 的內容）。 */
type StubPair = { oracle: Address; pool: Address; fee: number };
/** hub 模式：一筆報價。key 是 `${tokenIn}:${tokenOut}`（方向有意義），缺席 = 沒有池。 */
type StubQuote = { minimum: bigint; quoted?: bigint };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

type StubChain = {
  calls: ChainCall[];
  block: { number: bigint; timestamp: bigint };
  /** 被呼叫的 `getBlock` 次數（deadline 一定要讀塊時間，除非注入）。 */
  blockReads: number;
  oracle: {
    pool: Address;
    token0: Address;
    token1: Address;
    quoted: bigint;
    minimum: bigint;
    revert: string | null;
    /**
     * 設了就是 `AtpMultiPoolOracle` 的形狀：`pool()`/`token0()`/`token1()` 一律 revert（真的 router
     * 沒有那三個函式），報價與 pool fee 走 `pairs` + `quotes`。
     */
    numeraire?: Address;
    pairs?: Record<string, StubPair>;
    quotes?: Record<string, StubQuote>;
  };
  registry: { feeBps: number };
  pool: { fee: number };
  /**
   * 池子的衝擊估算狀態（`slot0`/`liquidity`/`token0`）。**`undefined` = 讀不到**：
   * 走「估不出衝擊 → 放行原量」那一條路，既有測試因此完全不必改。
   */
  poolState?: { sqrtPriceX96: bigint; liquidity: bigint; token0?: Address };
  /**
   * 設了就是「按量計價」的 oracle：`quoted = amountIn × rateE18 / 1e18`、
   * `minimum = ceil(quoted × (10000 − slippageBps) / 10000)`。
   * 衝擊估算要用 `quoted / amountIn` 反推 TWAP 價，固定報價的 stub 會讓那個比值失真。
   */
  rate?: { rateE18: bigint; slippageBps: number };
};

function stubClient(chain: StubChain): PublicClient {
  /** 按量計價（`chain.rate`）。沒設就回 null，走固定報價的既有路徑。 */
  const quoteByRate = (amountIn: bigint): [bigint, bigint] | null => {
    if (chain.rate === undefined) return null;
    const quoted = (amountIn * chain.rate.rateE18) / 10n ** 18n;
    const minimum = (quoted * BigInt(10_000 - chain.rate.slippageBps) + 9_999n) / 10_000n;
    return [quoted, minimum];
  };
  /** 這個地址是不是我們認識的池子（用來決定 `token0`/`slot0`/`liquidity` 打在誰身上）。 */
  const isPoolAddress = (target: string): boolean =>
    target === chain.oracle.pool.toLowerCase() ||
    Object.values(chain.oracle.pairs ?? {}).some((pair) => pair.pool.toLowerCase() === target);

  const client = {
    getBlock: async (args: { blockNumber?: bigint }) => {
      chain.blockReads += 1;
      return { number: chain.block.number, timestamp: chain.block.timestamp, hash: '0x', transactions: [] };
    },
    readContract: async (args: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }): Promise<unknown> => {
      chain.calls.push({
        functionName: args.functionName,
        address: args.address.toLowerCase(),
        args: args.args,
        blockNumber: args.blockNumber,
      });
      const target = args.address.toLowerCase();
      const hub = chain.oracle.numeraire !== undefined;
      const pairs = chain.oracle.pairs ?? {};

      if (hub && (target === ROUTER.toLowerCase() || target === ORACLE.toLowerCase())) {
        switch (args.functionName) {
          case 'numeraire':
            return chain.oracle.numeraire;
          case 'oracleOf': {
            const asset = String(args.args?.[0] ?? '').toLowerCase();
            return pairs[asset]?.oracle ?? ZERO_ADDRESS;
          }
          case 'previewSwap': {
            const amountIn = args.args?.[2] as bigint;
            const byRate = quoteByRate(amountIn);
            if (byRate !== null) return byRate;
            const key = `${String(args.args?.[0]).toLowerCase()}:${String(args.args?.[1]).toLowerCase()}`;
            const quote = chain.oracle.quotes?.[key];
            if (quote === undefined) throw new Error('execution reverted: UnsupportedRoute()');
            return [quote.quoted ?? quote.minimum, quote.minimum];
          }
          default:
            // 真的 AtpMultiPoolOracle 沒有 pool()/token0()/token1()：這幾個呼叫會 revert。
            throw new Error('execution reverted');
        }
      }
      if (hub) {
        const pair = Object.values(pairs).find((entry) => entry.oracle.toLowerCase() === target);
        if (pair !== undefined) {
          switch (args.functionName) {
            case 'pool':
              return pair.pool;
            default:
              throw new Error(`stub 沒有 ${args.functionName}`);
          }
        }
      }
      switch (args.functionName) {
        case 'pool':
          return chain.oracle.pool;
        case 'token0':
          // 池子的 token0（衝擊估算用）優先看 poolState；oracle 的 token0 一律還是 oracle.token0。
          return isPoolAddress(target) && chain.poolState?.token0 !== undefined
            ? chain.poolState.token0
            : chain.oracle.token0;
        case 'token1':
          return chain.oracle.token1;
        case 'slot0': {
          if (chain.poolState === undefined) throw new Error(`stub 沒有 ${args.functionName}`);
          return [chain.poolState.sqrtPriceX96, 0, 0, 10, 10, 0, true];
        }
        case 'liquidity': {
          if (chain.poolState === undefined) throw new Error(`stub 沒有 ${args.functionName}`);
          return chain.poolState.liquidity;
        }
        case 'previewSwap': {
          if (chain.oracle.revert !== null) throw new Error(`execution reverted: ${chain.oracle.revert}()`);
          const byRate = quoteByRate(args.args?.[2] as bigint);
          return byRate ?? [chain.oracle.quoted, chain.oracle.minimum];
        }
        case 'fee': {
          // hub 模式的池子按地址認（每個 pair 一個池、fee 不同）；legacy 模式固定一個。
          const hubPool = Object.values(pairs).find((entry) => entry.pool.toLowerCase() === target);
          return hubPool?.fee ?? chain.pool.fee;
        }
        case 'effectiveFeeBps':
          return chain.registry.feeBps;
        default:
          throw new Error(`stub 沒有 ${args.functionName}`);
      }
    },
  };
  return client as unknown as PublicClient;
}

function baseChain(overrides: Partial<StubChain> = {}): StubChain {
  return {
    calls: [],
    block: { number: 132_141_042n, timestamp: 1_700_000_000n },
    blockReads: 0,
    oracle: {
      pool: WBNB_USDT_POOL,
      token0: USDT,
      token1: WBNB,
      quoted: 700_000_000_000_000_000_000n,
      minimum: 688_023_143_350_803_187_441n,
      revert: null,
    },
    registry: { feeBps: 0 },
    pool: { fee: 500 },
    ...overrides,
  };
}

/**
 * 按量計價的比率（`rateE18` = 每 1e18 個 tokenIn 最小單位換到多少 tokenOut 最小單位）。
 *
 * 為什麼需要：`baseChain()` 的固定 floor（688e18）與量脫鉤 —— 賣 0.1 WBNB 也回 688 USDT。
 * 「執行後預估漂移」用那個比率算出來是垃圾，不改善守衛於是會把正常的計畫判成 noop。
 * 按 $1000/WBNB、$1/TICKER 換算：
 *   1e18 WBNB wei = 1 WBNB = $1000 = 1000 USDT = 1e21 USDT wei          → 1e21
 *   1e18 WBNB wei = 1 WBNB = $1000 = 1000 TOKEN6 = 1e9 TOKEN6 單位     → 1e9
 *   1e18 TOKEN6 單位 = 1e12 TOKEN6 = $1e12 = 1e9 WBNB = 1e27 WBNB wei  → 1e27
 */
const RATE_WBNB_USDT = { rateE18: 10n ** 21n, slippageBps: 100 } as const;
const RATE_WBNB_TO_TOKEN6 = { rateE18: 10n ** 9n, slippageBps: 100 } as const;
const RATE_TOKEN6_TO_WBNB = { rateE18: 10n ** 27n, slippageBps: 100 } as const;

/**
 * hub 模式的 stub：`AtpMultiPoolOracle` 的形狀（`numeraire` 有、`pool/token0/token1` 沒有），
 * 每個資產一個 per-pair oracle 與池，報價按 `${tokenIn}:${tokenOut}` 給。
 */
function hubChain(
  options: { quotes?: Record<string, StubQuote>; pairs?: Record<string, StubPair>; feeBps?: number } = {},
): StubChain {
  const chain = baseChain();
  chain.oracle = {
    ...chain.oracle,
    numeraire: USDT,
    pairs: options.pairs ?? {
      [WBNB.toLowerCase()]: { oracle: ORACLE_WBNB_USDT, pool: WBNB_USDT_POOL, fee: 500 },
      [TOKEN3.toLowerCase()]: { oracle: ORACLE_NVDAB_USDT, pool: NVDAB_USDT_POOL, fee: 2_500 },
      [TOKEN6.toLowerCase()]: { oracle: ORACLE_TOKEN6_USDT, pool: TOKEN6_USDT_POOL, fee: 100 },
    },
    quotes: options.quotes ?? {},
  };
  chain.registry = { feeBps: options.feeBps ?? 0 };
  return chain;
}

/** hub 模式的完整輸入（oracle = router、executor = executorMultiPool）。 */
function hubArgs(
  chain: StubChain,
  overrides: Partial<PlanRebalanceArgs> & {
    holdings: readonly Holding[];
    targets: readonly TargetWeight[];
    thresholdBps: number;
  },
): PlanRebalanceArgs {
  return argsOf(chain, { oracle: ROUTER, executor: EXECUTOR_MULTI, ...overrides });
}

/** 3 資產手算案例的輸入：目標 40/30/30、實際 60/20/20、總值 $1000。 */
function threeAssetCase(): { holdings: Holding[]; targets: TargetWeight[] } {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // 0.6 顆 @ $1000 = $600（60%）
    holding(TOKEN3, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // NVDAB 200 顆 @ $1 = $200（20%）
    holding(USDT, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // 200 USDT（20%）
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 4_000 },
    { asset: TOKEN3, weightBps: 3_000 },
    { asset: USDT, weightBps: 3_000 },
  ];
  return { holdings, targets };
}

/** holding 的簡寫：decimals 與價格一起給，避免測試裡的物件散成一團。 */
function holding(asset: Address, amountWei: bigint, decimals: number, priceE8: bigint): Holding {
  return { asset, amountWei, decimals, usdPriceE8: priceE8 };
}

function targetsOf(a: Address, b: Address, weightA = 5_000): TargetWeight[] {
  return [
    { asset: a, weightBps: weightA },
    { asset: b, weightBps: 10_000 - weightA },
  ];
}

/** 規劃器的完整輸入；每一列測試只覆寫它關心的那幾個欄位。 */
function argsOf(
  chain: StubChain,
  overrides: Partial<PlanRebalanceArgs> & { holdings: readonly Holding[]; targets: readonly TargetWeight[]; thresholdBps: number },
): PlanRebalanceArgs {
  // 四個必填欄位先解出來再展開剩下的：`drift` 沒給就用 computeDrift 當場算（通常是這樣）。
  const { holdings, targets, thresholdBps, drift: driftOverride, ...rest } = overrides;
  return {
    publicClient: stubClient(chain),
    account: '0x2b082fadf8f3d620eaa242a9e36817af8640d042' as Address,
    executor: EXECUTOR,
    oracle: ORACLE,
    registry: REGISTRY,
    strategyId: 1n,
    holdings,
    targets,
    drift: driftOverride ?? computeDrift(holdings, targets, thresholdBps),
    thresholdBps,
    blockNumber: chain.block.number,
    ...rest,
  };
}

/** 手寫一份 DriftReport：只有「持倉算出來的漂移到不了那個數字」的邊界案例才用它。 */
function craftedDrift(args: {
  totalUsdE8: bigint;
  rows: { asset: Address; targetBps: number; currentBps: number; usdValueE8: bigint }[];
  thresholdBps?: number;
}): DriftReport {
  const assets = args.rows.map((row) => ({
    asset: row.asset,
    targetBps: row.targetBps,
    currentBps: row.currentBps,
    deltaBps: row.currentBps - row.targetBps,
    usdValueE8: row.usdValueE8,
  }));
  const sumAbs = assets.reduce((sum, row) => sum + Math.abs(row.deltaBps), 0);
  return {
    totalUsdE8: args.totalUsdE8,
    assets,
    maxAbsDeltaBps: assets.reduce((max, row) => Math.max(max, Math.abs(row.deltaBps)), 0),
    grossDriftBps: Math.round(sumAbs / 2),
    needsRebalance: true,
    thresholdBps: args.thresholdBps ?? 100,
  };
}

/** ready 的窄化：不是 ready 就直接讓測試紅在「為什麼不是 ready」上。 */
function expectReady(plan: RebalancePlan): Extract<RebalancePlan, { kind: 'ready' }> {
  if (plan.kind !== 'ready') {
    throw new assert.AssertionError({ message: `預期 ready，得到 ${plan.kind}：${plan.reason}` });
  }
  return plan;
}

/** 解出 V3 payload 的五個欄位，測試裡每一處都靠它驗「合約會收到什麼」。 */
function decodeStepInput(step: PlannedStep): {
  recipient: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  path: Hex;
  payerIsUser: boolean;
} {
  const input = step.inputs[0];
  assert.ok(input !== undefined, 'inputs[0] 必須存在');
  const decoded = decodeAbiParameters(V3_INPUT_ABI, input);
  return {
    recipient: decoded[0],
    amountIn: decoded[1],
    amountOutMin: decoded[2],
    path: decoded[3],
    payerIsUser: decoded[4],
  };
}

/** packed path 中間那 3 bytes 的 fee（0x + 40 hex 地址之後）。 */
function pathFee(path: Hex): number {
  return Number.parseInt(path.slice(42, 48), 16);
}

// ---------------------------------------------------------------- R1：不需要動 → noop（不是空 steps）

test('R1 未達門檻 → noop，而且不回空的 steps、不讀鏈', async () => {
  // 50/50 的目標、實際也剛好 50/50：gross drift 0 bps < 門檻 100。
  const holdings = [
    holding(WBNB, 500_000_000_000_000_000n, 18, PRICE_1000_USD), // $500
    holding(USDT, 500_000_000_000_000_000_000n, 18, PRICE_1_USD), // $500
  ];
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /No rebalance needed/);
  // 關鍵：noop 沒有 steps 這個欄位。空陣列會是「成功但什麼都沒做」（pitfalls §8.1）。
  assert.equal('steps' in plan, false);
  // noop 是純決策：連一次鏈上讀取都不該發生。
  assert.equal(chain.calls.length, 0);
  assert.equal(chain.blockReads, 0);
});

test('R1 空倉（total = 0）→ noop，不是 blocked 也不是空 steps', async () => {
  // portfolio 5 現在就是這個形狀：gross drift 5000 bps（drift.ts 對 total = 0 的定義），但沒有部位可搬。
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings: [], targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /value is 0/);
  assert.equal('steps' in plan, false);
  assert.equal(chain.calls.length, 0);
});

test('R1 門檻與 drift 不一致 → 拋錯（拿另一份門檻算的 drift 規劃是錯的）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain();
  const targets = targetsOf(WBNB, USDT);
  await assert.rejects(
    planRebalance(
      argsOf(chain, {
        holdings,
        targets,
        drift: computeDrift(holdings, targets, 100),
        thresholdBps: 200,
      }),
    ),
    /thresholdBps\(200\) 與 drift\.thresholdBps\(100\) 不一致/,
  );
});

// ---------------------------------------------------------------- R2：只支援 2 資產 / 單一 pair

test('R2 目標 3 個資產 → blocked，理由寫明 D-23', async () => {
  const holdings = [
    holding(WBNB, 400_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 300_000_000_000_000_000_000n, 18, PRICE_1_USD),
    holding(TOKEN3, 300_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 3_400 },
    { asset: USDT, weightBps: 3_300 },
    { asset: TOKEN3, weightBps: 3_300 },
  ];
  const chain = baseChain();
  const plan = await planRebalance(argsOf(chain, { holdings, targets, thresholdBps: 100 }));

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /3 assets/);
  assert.match(plan.reason, /pins a single pool/);
  assert.match(plan.reason, /per-call oracle \(D-23\)/);
  assert.equal('steps' in plan, false);
});

test('R2 oracle 的 pool 不是這兩個代幣 → blocked（不靠 revert，靠 token0/token1）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN3, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  // oracle 綁的是 USDT/WBNB，兩個目標卻是 WBNB/TOKEN3。
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets: targetsOf(WBNB, TOKEN3), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /not .* \/ /);
  assert.match(plan.reason, /per-call oracle \(D-23\)/);
  // pair 不對時不該去打 previewSwap：先擋掉，省一次註定失敗的呼叫。
  assert.equal(chain.calls.some((call) => call.functionName === 'previewSwap'), false);
});

test('R2 oracle 回 UnsupportedPair → blocked（試探路徑）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain();
  chain.oracle.revert = 'UnsupportedPair';
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /UnsupportedPair/);
  assert.match(plan.reason, /D-23/);
});

test('R2 oracle 報不出價（TwapUnavailable）→ blocked，理由與 pair 不符分開', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain();
  chain.oracle.revert = 'TwapUnavailable';
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /cannot quote/);
  assert.match(plan.reason, /NoFloor/);
});

// ---------------------------------------------------------------- R3：賣哪一個、賣多少（手算案例）

test('R3 手算案例：total $1000、目標 50/50、實際 60/40、18 位小數的賣方 → 賣 0.1 WBNB', async () => {
  // 手算（全部是整數）：
  //   WBNB：0.6e18 wei × $1000 → 6e17 × 1e11 / 1e18 = 6e10 = $600
  //   TOKEN6：400e6 wei × $1   → 4e8  × 1e8  / 1e6  = 4e10 = $400
  //   total = 1e11（$1000）；currentBps = 6000 / 4000；target = 5000 / 5000
  //   deltaBps(WBNB) = +1000 → 要搬 1000 × 1e11 / 10000 = 1e10（$100）
  //   amountIn = 1e10 × 10^18 / 1e11 = 1e17 wei = 0.1 WBNB（正好 $100）
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN6, 400_000_000n, 6, PRICE_1_USD),
  ];
  const targets = targetsOf(WBNB, TOKEN6);
  const drift = computeDrift(holdings, targets, 100);
  assert.equal(drift.totalUsdE8, 100_000_000_000n);
  assert.equal(drift.grossDriftBps, 1_000);
  assert.equal(drift.needsRebalance, true);

  const chain = baseChain({ oracle: { ...baseChain().oracle, token0: TOKEN6, token1: WBNB }, rate: RATE_WBNB_TO_TOKEN6 });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.tokenIn, getAddress(WBNB));
  assert.equal(step.tokenOut, getAddress(TOKEN6));
  assert.equal(step.amountIn, 100_000_000_000_000_000n); // 0.1 WBNB，手算值
  // 賣出的量不可能超過持倉（0.6 WBNB）。
  assert.ok(step.amountIn <= 600_000_000_000_000_000n);
  const decoded = decodeStepInput(step);
  assert.equal(decoded.amountIn, 100_000_000_000_000_000n);
  assert.equal(decoded.recipient, getAddress(EXECUTOR));
  assert.equal(decoded.payerIsUser, true);
});

test('R3 手算案例：6 位小數的賣方 → 賣 100 個最小單位 × 1e6', async () => {
  // 反過來：WBNB $400（0.4 顆）、TOKEN6 $600（600e6 wei）→ deltaBps(TOKEN6) = +1000
  //   要搬 1e10（$100）→ amountIn = 1e10 × 10^6 / 1e8 = 1e8 wei = 100 顆 TOKEN6
  const holdings = [
    holding(WBNB, 400_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN6, 600_000_000n, 6, PRICE_1_USD),
  ];
  const targets = targetsOf(WBNB, TOKEN6);
  const chain = baseChain({ oracle: { ...baseChain().oracle, token0: TOKEN6, token1: WBNB }, rate: RATE_TOKEN6_TO_WBNB });
  const plan = expectReady(await planRebalance(argsOf(chain, { holdings, targets, thresholdBps: 100 })));

  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.tokenIn, getAddress(TOKEN6));
  assert.equal(step.tokenOut, getAddress(WBNB));
  assert.equal(step.amountIn, 100_000_000n); // 100 顆（6 位小數）
  assert.ok(step.amountIn <= 600_000_000n);
  // rationale 要看得出「賣幾顆」而不只是 wei。
  assert.match(plan.rationale, /賣 100\.000000 顆/);
});

test('R3 賣出量超過持倉 → 夾到持倉，並在 rationale 說明', async () => {
  // 刻意不一致的 drift（total 記成 $2000，而帳戶只有 1 顆 $1000 的 WBNB）：夾取是唯一防線，
  // 因為「多賣」在合約層完全合法（合約只驗 amountOutMin 下限）。
  const holdings = [holding(WBNB, 1_000_000_000_000_000_000n, 18, PRICE_1000_USD)];
  const targets = targetsOf(WBNB, TOKEN6);
  const drift = craftedDrift({
    totalUsdE8: 200_000_000_000n, // $2000
    rows: [
      { asset: WBNB, targetBps: 5_000, currentBps: 15_000, usdValueE8: 200_000_000_000n },
      { asset: TOKEN6, targetBps: 5_000, currentBps: -5_000, usdValueE8: 0n },
    ],
  });
  const chain = baseChain({ oracle: { ...baseChain().oracle, token0: TOKEN6, token1: WBNB } });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  const step = plan.steps[0];
  assert.ok(step !== undefined);
  // 漂移算出來是 2 顆（2 × $1000），持倉只有 1 顆 → 夾到 1e18。
  assert.equal(step.amountIn, 1_000_000_000_000_000_000n);
  assert.match(plan.rationale, /夾到實際持倉/);
  assert.match(plan.rationale, /依漂移算出 2000000000000000000/);
});

test('R3 amountIn 算出來是 0 → noop（合約對 amountIn == 0 會 revert ZeroAmount）', async () => {
  // 0 位小數的代幣、價格 $1、要搬 $0.1：0.1 個最小單位 → 向下截斷成 0。
  const holdings = [holding(TOKEN6, 1_000_000n, 0, PRICE_1_USD)];
  const targets = targetsOf(TOKEN6, WBNB);
  const drift = craftedDrift({
    totalUsdE8: 100_000_000_000n, // $1000
    rows: [
      { asset: TOKEN6, targetBps: 5_000, currentBps: 5_001, usdValueE8: 1_000n },
      { asset: WBNB, targetBps: 5_000, currentBps: 4_999, usdValueE8: 0n },
    ],
  });
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets, drift, thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /sell amount is 0/);
  assert.match(plan.reason, /ZeroAmount/);
  assert.equal('steps' in plan, false);
  // 一次鏈上讀取都不該發生：算不出量就不必問 oracle。
  assert.equal(chain.calls.length, 0);
});

test('R3 取整方向：amountInFor / moveValueE8 一律向下截斷，且回推不超過原值', () => {
  // $1（1e8）× 10^18 / ($3 = 3e8) = 3.333…e17 wei → 向下截斷
  assert.equal(amountInFor(PRICE_1_USD, 3n * PRICE_1_USD, 18), 333_333_333_333_333_333n);
  assert.equal(
    amountInFor(PRICE_1_USD, 3n * PRICE_1_USD, 18),
    10n ** 26n / (3n * PRICE_1_USD),
  );
  // 乘回價格換成 E8 必須 ≤ 原本的價值：這就是「不會多賣」的算術根據。
  assert.ok(
    (333_333_333_333_333_333n * 3n * PRICE_1_USD) / 10n ** 18n <= PRICE_1_USD,
  );
  // |deltaBps| × total / 10000 也是向下：3 × 1e4 / 1e4 = 3；1 × 1 / 1e4 = 0。
  assert.equal(moveValueE8(3, 10_000n), 3n);
  assert.equal(moveValueE8(1, 9_999n), 0n);
});

// ---------------------------------------------------------------- R4：minGross 逐字對齊合約

test('R4 minGross 進位案例：floor 12345 / fee 25 → 12376（手算）', () => {
  // 12345 × 10000 = 123450000；denom = 10000 - 25 = 9975
  // 9975 × 12375 = 123440625（差 9375）→ 進位 → 12376
  // AtpExecutor._minGross 用的是 Math.mulDiv(..., Rounding.Ceil)，所以必須是 12376，不是 12375。
  assert.equal(minGrossFor(12_345n, 25), 12_376n);
  assert.equal(12_376n * 9_975n >= 123_450_000n, true);
  assert.equal(12_375n * 9_975n < 123_450_000n, true);
});

test('R4 minGross 整除時不進位：floor 10000 / fee 5000 → 20000', () => {
  assert.equal(minGrossFor(10_000n, 5_000), 20_000n);
  // fee 0 是恆等：minGross = floor。
  assert.equal(minGrossFor(688_023_143_350_803_187_441n, 0), 688_023_143_350_803_187_441n);
  // 最小的進位：floor 1 / fee 1 → ceil(10000/9999) = 2。
  assert.equal(minGrossFor(1n, 1), 2n);
});

test('R4 minGross 永遠 ≥ oracleFloor，且等於 floor + ceil(floor×fee/(10000-fee))（獨立算式）', () => {
  // 獨立推導：ceil(x·10000/(10000-f)) 在 x 是整數時等於 x + ceil(x·f/(10000-f))。
  // 這條式子不經過「先乘 10000 再除」的同一條路徑，所以兩邊相符才是真的相符。
  const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
  const cases: [bigint, number][] = [
    [1n, 1],
    [1_000_000n, 25],
    [688_023_143_350_803_187_441n, 25],
    [688_023_143_350_803_187_441n, 100],
    [123_456_789_000_000_000_000n, 300],
    [10n ** 30n, 999],
    [7n, 9_999],
  ];
  for (const [floor, feeBps] of cases) {
    const minGross = minGrossFor(floor, feeBps);
    const denominator = BigInt(10_000 - feeBps);
    assert.ok(minGross >= floor, `fee ${feeBps}: minGross ${minGross} < floor ${floor}`);
    assert.equal(minGross, floor + ceilDiv(floor * BigInt(feeBps), denominator));
  }
});

test('R4 feeBps 從 registry.effectiveFeeBps(鏈上 strategyId) 讀，原樣傳進去', async () => {
  // 這一條測的是 feeBps 的**管線**（fee 從 registry 讀、`oracleFloor` 取自 `minimum` 不是 `quoted`、
  // `amountOutMin = minGross(floor, fee)`），不是金額運算 —— 所以刻意**不**用按量計價的 stub：
  // 它要釘住的就是 stub 回的固定 floor 原值。持倉放大 10 倍是為了讓那個固定 floor（$688）對
  // 「賣 $1000 的 WBNB」是合理的成交，否則不改善守衛（正確地）會把這一輪判成 noop。
  const holdings = [
    holding(WBNB, 6_000_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 4_000_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ registry: { feeBps: 25 } });
  const plan = expectReady(
    await planRebalance(
      argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100, strategyId: 7n }),
    ),
  );

  const feeCall = chain.calls.find((call) => call.functionName === 'effectiveFeeBps');
  assert.ok(feeCall !== undefined);
  assert.equal(feeCall.address, REGISTRY.toLowerCase());
  assert.deepEqual(feeCall.args, [7n]); // DB 的 id 與鏈上 id 是兩個東西，這裡必須是呼叫端給的那個
  const step = plan.steps[0];
  assert.ok(step !== undefined);
  // floor 688023143350803187441 + ceil(floor×25/9975) = minGross；amountOutMin 必須等於它。
  assert.equal(step.oracleFloor, 688_023_143_350_803_187_441n);
  // stub 的 quoted 是 7e20：取到 quoted 這條就會紅。合約要的是 minimum。
  assert.notEqual(step.oracleFloor, 700_000_000_000_000_000_000n);
  assert.equal(step.amountOutMin, amountOutMinWithBuffer(minGrossFor(step.oracleFloor, 25)));
  assert.equal(decodeStepInput(step).amountOutMin, step.amountOutMin);
});

test('R4 feeBps >= 10000 → 拋錯（合約會 revert FeeTooHigh，這裡先擋）', () => {
  assert.throws(() => minGrossFor(1n, 10_000), /feeBps must be an integer in 0\.\.9999/);
  assert.throws(() => minGrossFor(-1n, 0), /oracleFloor must not be negative/);
});

// ---------------------------------------------------------------- R5：deadline = max(塊時間, 牆鐘) + deadlineSeconds

/** 牆鐘（unix 秒）。deadline 的基準要跟它比，所以測試自己讀一次（牆鐘會走 → 比區間，不比等號）。 */
function wallClockSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}

test('R5 塊時間超前牆鐘 → 用塊時間（max 的「鏈贏」那一邊）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // fork 的頭塊停在上游那一刻、或本地鏈被時間旅行過：塊時間在牆鐘之後一小時。
  chain.block.timestamp = wallClockSeconds() + 3_600n;
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );

  assert.equal(plan.deadline, chain.block.timestamp + BigInt(DEFAULT_DEADLINE_SECONDS));
  assert.ok(plan.deadline > chain.block.timestamp, 'deadline 必須晚於塊時間，不然鏈上就是已過期');
  assert.match(plan.rationale, /取塊時間/);
  assert.equal(chain.blockReads, 1);
});

test('R5 塊時間落後牆鐘 14 分鐘（稀疏挖礦）→ deadline 仍然在未來，不是已過期', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // 實測那筆：塊 132179976 的時間戳 09:54:57，而那筆 op 落地時新塊是 10:09:04 —— 塊時間比牆鐘舊
  // 14 分鐘。只用塊時間的話 deadline 就是「14 分鐘前 + deadlineSeconds」，簽下去就過期。
  const before = wallClockSeconds();
  chain.block.timestamp = before - 840n;
  const after = wallClockSeconds();
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );

  assert.ok(plan.deadline > after, `deadline ${plan.deadline} 必須晚於牆鐘 ${after}：不然一送就 DeadlineExpired`);
  // 基準是牆鐘（牆鐘會走，所以是 before..after 的區間），不是那個已經過期的塊時間。
  const base = plan.deadline - BigInt(DEFAULT_DEADLINE_SECONDS);
  assert.ok(
    base >= before && base <= after,
    `deadline 基準 ${base} 必須是牆鐘（${before}..${after}），不是塊時間 ${chain.block.timestamp}`,
  );
  assert.notEqual(
    plan.deadline,
    chain.block.timestamp + BigInt(DEFAULT_DEADLINE_SECONDS),
    '不能是「塊時間 + 預設」：那正是那筆 DeadlineExpired 的算式',
  );
  assert.match(plan.rationale, /取牆鐘/);
  console.log(
    `[R5] 塊時間 ${chain.block.timestamp}（落後牆鐘 840s）、牆鐘 ${before}、` +
      `deadline ${plan.deadline}（基準 ${base}，相對塊時間 +${plan.deadline - chain.block.timestamp}s）`,
  );
});

test('R5 塊時間落後超過 deadline 長度 → 只有 max 救得回來（換什麼預設值都不夠）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // 按需挖礦閒置兩小時：塊時間落在牆鐘之前 7200s，比 1800s 的預設還久。
  const before = wallClockSeconds();
  chain.block.timestamp = before - 7_200n;
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );

  assert.ok(
    plan.deadline > before,
    `deadline ${plan.deadline} 必須在未來；舊算式會是 ${chain.block.timestamp + BigInt(DEFAULT_DEADLINE_SECONDS)}（已過期）`,
  );
});

test('R5 DEFAULT_DEADLINE_SECONDS = 1800（30 分鐘），仍遠低於 Permit2 的 30 天上限', () => {
  assert.equal(DEFAULT_DEADLINE_SECONDS, 1_800);
  assert.equal(MAX_DEADLINE_SECONDS, 2_592_000);
  assert.ok(DEFAULT_DEADLINE_SECONDS < MAX_DEADLINE_SECONDS);
});

test('R5 換一個塊時間，deadline 跟著換（可注入時鐘）；deadlineSeconds 可調', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // 塊時間放在牆鐘之後，牆鐘才不會把注入值蓋掉 —— 這一條驗的是「塊時間那一邊會傳進算式」。
  chain.block.timestamp = wallClockSeconds() + 7_200n;
  const args = argsOf(chain, {
    holdings,
    targets: targetsOf(WBNB, USDT),
    thresholdBps: 100,
    deadlineSeconds: 600,
  });

  const injectedTs = chain.block.timestamp + 1_000n;
  const injected = expectReady(await planRebalance(args, { blockTimestampSeconds: injectedTs }));
  assert.equal(injected.deadline, injectedTs + 600n);
  // 注入就完全不讀 getBlock。
  assert.equal(chain.blockReads, 0);

  const fromChain = expectReady(await planRebalance(args));
  assert.equal(fromChain.deadline, chain.block.timestamp + 600n);
  assert.notEqual(injected.deadline, fromChain.deadline);
});

test('R5 deadlineSeconds 邊界：0 或超過 30 天（Permit2）→ 拋錯；30 天整可以', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // 塊時間超前 → 基準就是塊時間，等式才驗得準（牆鐘贏的話 deadline 只會是「現在 + 30 天」）。
  chain.block.timestamp = wallClockSeconds() + 3_600n;
  const base = { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 };

  await assert.rejects(
    planRebalance(argsOf(chain, { ...base, deadlineSeconds: 0 })),
    /deadlineSeconds must be an integer in 1\.\.2592000/,
  );
  await assert.rejects(
    planRebalance(argsOf(chain, { ...base, deadlineSeconds: MAX_DEADLINE_SECONDS + 1 })),
    /deadlineSeconds must be an integer in 1\.\.2592000/,
  );
  const plan = expectReady(
    await planRebalance(argsOf(chain, { ...base, deadlineSeconds: MAX_DEADLINE_SECONDS })),
  );
  assert.equal(plan.deadline, chain.block.timestamp + BigInt(MAX_DEADLINE_SECONDS));
});

test('R5 getBlock 回傳另一塊 → 拋錯（時間與餘額不能來自不同時間點）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain();
  chain.block.number = 132_141_043n; // getBlock 回的是這一塊……
  await assert.rejects(
    planRebalance(
      argsOf(chain, {
        holdings,
        targets: targetsOf(WBNB, USDT),
        thresholdBps: 100,
        blockNumber: 132_141_042n, // ……但規劃釘的是這一塊
      }),
    ),
    /回傳了第 132141043 塊/,
  );
});

// ---------------------------------------------------------------- R6：commands / inputs / path

test('R6 commands 是單一 byte 0x00、inputs 只有一筆、recipient 是 executor', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );

  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.commands, V3_SWAP_EXACT_IN);
  assert.equal(step.commands, '0x00');
  // packed bytes：0x + 2 個 hex 字元 = 一個 byte。帶 flag bit（例如 0x80）會被 CommandNotAllowed。
  assert.equal(step.commands.length, 4);
  assert.equal(step.inputs.length, 1);
  const decoded = decodeStepInput(step);
  // _checkRecipient 讀第 0 個 head word 的低 20 bytes，必須等於 executor。
  assert.equal(decoded.recipient, getAddress(EXECUTOR));
  assert.equal(decoded.amountIn, step.amountIn);
  assert.equal(decoded.amountOutMin, step.amountOutMin);
  assert.equal(decoded.payerIsUser, true);
});

test('R6 path 的 fee 來自池子（IPancakeV3Pool.fee()），不是寫死 500', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  for (const fee of [500, 2_500, 100]) {
    const chain = baseChain({ pool: { fee }, rate: RATE_WBNB_USDT });
    const plan = expectReady(
      await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
    );
    const step = plan.steps[0];
    assert.ok(step !== undefined);
    const decoded = decodeStepInput(step);
    // abi.encodePacked(tokenIn, uint24 fee, tokenOut)
    assert.equal(
      decoded.path,
      encodePacked(['address', 'uint24', 'address'], [getAddress(WBNB), fee, getAddress(USDT)]),
    );
    assert.equal(pathFee(decoded.path), fee);
    // 池子地址是從 oracle.pool() 讀的，fee() 是對那個池子問的。
    const poolCall = chain.calls.find((call) => call.functionName === 'fee');
    assert.ok(poolCall !== undefined);
    assert.equal(poolCall.address, WBNB_USDT_POOL.toLowerCase());
  }
});

test('R6 所有鏈上讀取都釘在同一個 blockNumber 上', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );

  assert.ok(plan.steps.length > 0);
  assert.ok(chain.calls.length >= 5);
  for (const call of chain.calls) {
    assert.equal(call.blockNumber, chain.block.number, `${call.functionName} 沒有釘塊`);
  }
});

test('R3 amountIn 超過 uint160 上限 → blocked（合約會 revert AmountTooLarge）', async () => {
  // 合成的持倉：2^161 個最小單位（> uint160 上限）。真實代幣不會這樣，但「不可能」不該靠印象。
  const holdings = [holding(WBNB, 2n ** 161n, 18, PRICE_1000_USD)];
  const targets = targetsOf(WBNB, USDT);
  const drift = craftedDrift({
    totalUsdE8: 10n ** 46n,
    rows: [
      { asset: WBNB, targetBps: 5_000, currentBps: 15_000, usdValueE8: 10n ** 46n },
      { asset: USDT, targetBps: 5_000, currentBps: -5_000, usdValueE8: 0n },
    ],
  });
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets, drift, thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /uint160/);
  assert.match(plan.reason, /AmountTooLarge/);
  // 擋在鏈上讀取之前：這種輸入不值得再問 oracle。
  assert.equal(chain.calls.length, 0);
});

// ---------------------------------------------------------------- 大數字不溢位

test('大數字：金額走 bigint，超過 Number.MAX_SAFE_INTEGER 也不失真', async () => {
  // 天文數字投組：total $1e22、超配 1000 bps → 要搬 $1e21 → 1e21×1e18/1e11 = 1e28 wei。
  const holdings = [holding(WBNB, 10n ** 38n, 18, PRICE_1000_USD)];
  const targets = targetsOf(WBNB, USDT);
  const drift = craftedDrift({
    totalUsdE8: 10n ** 30n,
    rows: [
      { asset: WBNB, targetBps: 5_500, currentBps: 6_500, usdValueE8: 10n ** 30n },
      { asset: USDT, targetBps: 4_500, currentBps: 3_500, usdValueE8: 0n },
    ],
  });
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.amountIn, 10n ** 29n * 10n ** 18n / 10n ** 11n);
  assert.equal(step.amountIn, 10n ** 36n);
  assert.ok(step.amountIn > BigInt(Number.MAX_SAFE_INTEGER));
  // minGross 也不失真：floor × 10000 不會被截斷成 double。
  assert.equal(step.amountOutMin, amountOutMinWithBuffer(minGrossFor(step.oracleFloor, 0)));
});

test('大數字：minGross 在 1e30 這個量級仍然精確（用 bigint 比較，不經 Number）', () => {
  const floor = 10n ** 30n;
  const minGross = minGrossFor(floor, 25);
  assert.equal(minGross, 10n ** 30n + (10n ** 30n * 25n + 9_974n) / 9_975n);
  assert.ok(minGross > BigInt(Number.MAX_SAFE_INTEGER));
  assert.ok(minGross >= floor);
});

// ---------------------------------------------------------------- 「永不回空 steps」的整體掃描

test('永不回空 steps：noop / blocked 都沒有 steps 欄位，ready 一定 >= 1 步', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const targets = targetsOf(WBNB, USDT);

  const plans: RebalancePlan[] = [
    // noop：未達門檻
    await planRebalance(
      argsOf(baseChain(), {
        holdings: [
          holding(WBNB, 500_000_000_000_000_000n, 18, PRICE_1000_USD),
          holding(USDT, 500_000_000_000_000_000_000n, 18, PRICE_1_USD),
        ],
        targets,
        thresholdBps: 100,
      }),
    ),
    // noop：空倉
    await planRebalance(argsOf(baseChain(), { holdings: [], targets, thresholdBps: 100 })),
    // blocked：3 個資產
    await planRebalance(
      argsOf(baseChain(), {
        holdings,
        targets: [
          { asset: WBNB, weightBps: 3_400 },
          { asset: USDT, weightBps: 3_300 },
          { asset: TOKEN3, weightBps: 3_300 },
        ],
        thresholdBps: 100,
      }),
    ),
    // blocked：pair 不對
    await planRebalance(argsOf(baseChain(), { holdings, targets: targetsOf(WBNB, TOKEN3), thresholdBps: 100 })),
    // ready
    await planRebalance(argsOf(baseChain({ rate: RATE_WBNB_USDT }), { holdings, targets, thresholdBps: 100 })),
  ];

  assert.deepEqual(
    plans.map((plan) => plan.kind),
    ['noop', 'noop', 'blocked', 'blocked', 'ready'],
  );
  for (const plan of plans) {
    if (plan.kind === 'ready') {
      assert.ok(plan.steps.length >= 1, 'ready 必須至少一步');
    } else {
      assert.equal('steps' in plan, false, `${plan.kind} 不該帶 steps`);
    }
  }
});

// ---------------------------------------------------------------- hub 模式：N 資產、USDT 為中央

test('H1 3 資產手算：40/30/30 vs 實際 60/20/20 → 賣 0.2 WBNB、買 100 USDT 的 NVDAB', async () => {
  // 手算（全部整數，1e8 定點 USD）：
  //   WBNB 0.6e18 @ $1000 → 6e17×1e11/1e18 = 6e10（$600）；NVDAB 200e18 @ $1 → 2e10；USDT 200e18 → 2e10
  //   total 1e11（$1000）；currentBps 6000/2000/2000、targetBps 4000/3000/3000 → Δ +2000/−1000/−1000
  //   WBNB：targetUsd = ceil(4000×1e11/1e4) = 4e10 → deltaUsd +2e10 → amountIn = 2e10×1e18/1e11 = 2e17
  //   NVDAB：targetUsd = 3e10 → deltaUsd −1e10 → 付 1e10×1e18/1e8 = 1e20 USDT（100 顆）
  //   順序：賣（WBNB）在前、買（NVDAB）在後；USDT 是 hub，自己不產生 step。
  const { holdings, targets } = threeAssetCase();
  const drift = computeDrift(holdings, targets, 100);
  assert.equal(drift.totalUsdE8, 100_000_000_000n);
  assert.deepEqual(
    drift.assets.map((row) => row.deltaBps),
    [2_000, -1_000, -1_000],
  );

  const chain = hubChain({
    feeBps: 25,
    quotes: {
      [`${WBNB}:${USDT}`]: { minimum: 137_000_000_000_000_000_000n }, // 賣 0.2 WBNB 的地板 = 137 USDT
      [`${USDT}:${TOKEN3}`]: { minimum: 99_000_000_000_000_000_000n }, // 付 100 USDT 的地板 = 99 NVDAB
    },
  });
  // 塊時間超前牆鐘 → 基準是塊時間，deadline 的等式才驗得準（hub 與 pinned 共用同一條 max 規則）。
  chain.block.timestamp = wallClockSeconds() + 3_600n;
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );

  assert.equal(plan.steps.length, 2);
  const [sell, buy] = plan.steps;
  assert.ok(sell !== undefined && buy !== undefined);

  // step 0：賣 WBNB 換 USDT
  assert.equal(sell.tokenIn, getAddress(WBNB));
  assert.equal(sell.tokenOut, getAddress(USDT));
  assert.equal(sell.amountIn, 200_000_000_000_000_000n); // 0.2 WBNB，手算值
  assert.equal(sell.oracleFloor, 137_000_000_000_000_000_000n);
  assert.equal(sell.amountOutMin, amountOutMinWithBuffer(minGrossFor(137_000_000_000_000_000_000n, 25)));
  // 獨立算式：minGross = floor + ceil(floor×fee/(10000−fee))
  assert.equal(sell.amountOutMin, amountOutMinWithBuffer(137_000_000_000_000_000_000n + (137_000_000_000_000_000_000n * 25n + 9_974n) / 9_975n));
  assert.equal(decodeStepInput(sell).amountOutMin, sell.amountOutMin);
  assert.equal(pathFee(decodeStepInput(sell).path), 500); // WBNB/USDT 池的 fee

  // step 1：買 NVDAB，付 USDT
  assert.equal(buy.tokenIn, getAddress(USDT));
  assert.equal(buy.tokenOut, getAddress(TOKEN3));
  assert.equal(buy.amountIn, 100_000_000_000_000_000_000n); // 100 USDT（18 位小數）
  assert.equal(buy.oracleFloor, 99_000_000_000_000_000_000n);
  assert.equal(buy.amountOutMin, amountOutMinWithBuffer(minGrossFor(99_000_000_000_000_000_000n, 25)));
  assert.equal(pathFee(decodeStepInput(buy).path), 2_500); // NVDAB/USDT 池的 fee（逐池讀，不是寫死）

  // 每一步的 recipient 都是 executorMultiPool，payerIsUser = true（幣從 executor 付出去）。
  for (const step of plan.steps) {
    const decoded = decodeStepInput(step);
    assert.equal(decoded.recipient, getAddress(EXECUTOR_MULTI));
    assert.equal(decoded.payerIsUser, true);
    assert.equal(decoded.amountIn, step.amountIn);
    assert.equal(step.commands, V3_SWAP_EXACT_IN);
  }
  assert.equal(plan.deadline, chain.block.timestamp + BigInt(DEFAULT_DEADLINE_SECONDS));

  // USDT 預算：賣出保證淨額 = floor − floor×fee/10000，逐筆加總。
  const sellNet = 137_000_000_000_000_000_000n - (137_000_000_000_000_000_000n * 25n) / 10_000n;
  assert.match(plan.rationale, /hub 模式/);
  assert.match(plan.rationale, new RegExp(`賣出保證淨額 ${sellNet}`));
  assert.match(plan.rationale, /實際付出 100000000000000000000/);
  assert.match(plan.rationale, /沒有任何步驟被跳過/);
  // 只問了兩筆報價：賣 WBNB、買 NVDAB（USDT 是 hub，不對自己報價）。
  assert.equal(chain.calls.filter((call) => call.functionName === 'previewSwap').length, 2);
});

test('H2 先賣後買：所有賣的 index 都小於所有買的 index（4 資產 2 賣 1 買）', async () => {
  // 手算：WBNB 0.4@$1000=$400（4000）、TOKEN6 350 顆@$1=$350（3500）、NVDAB 100（1000）、USDT 150（1500）
  //   total $1000；targetBps 3000/3000/2000/2000 → Δ +1000/+500/−1000/−500
  //   賣 WBNB：deltaUsd = 4e10 − 3e10 = 1e10 → 1e17 wei；賣 TOKEN6：3.5e10 − 3e10 = 5e9 → 5e7（50 顆，6 位）
  //   買 NVDAB：1e10 − 2e10 = −1e10 → 付 1e20 USDT
  const holdings = [
    holding(WBNB, 400_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN6, 350_000_000n, 6, PRICE_1_USD),
    holding(TOKEN3, 100_000_000_000_000_000_000n, 18, PRICE_1_USD),
    holding(USDT, 150_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 3_000 },
    { asset: TOKEN6, weightBps: 3_000 },
    { asset: TOKEN3, weightBps: 2_000 },
    { asset: USDT, weightBps: 2_000 },
  ];
  const drift = computeDrift(holdings, targets, 100);
  assert.deepEqual(
    drift.assets.map((row) => row.deltaBps),
    [1_000, 500, -1_000, -500],
  );

  const chain = hubChain({
    quotes: {
      [`${WBNB}:${USDT}`]: { minimum: 69_000_000_000_000_000_000n },
      [`${TOKEN6}:${USDT}`]: { minimum: 49_000_000_000_000_000_000n },
      [`${USDT}:${TOKEN3}`]: { minimum: 99_000_000_000_000_000_000n },
    },
  });
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );

  assert.equal(plan.steps.length, 3);
  const sellIndexes = plan.steps
    .map((step, index) => (step.tokenIn.toLowerCase() === USDT.toLowerCase() ? -1 : index))
    .filter((index) => index >= 0);
  const buyIndexes = plan.steps
    .map((step, index) => (step.tokenIn.toLowerCase() === USDT.toLowerCase() ? index : -1))
    .filter((index) => index >= 0);
  // 賣必須全部排在買之前：executor 逐 step 從帳戶拉 tokenIn，買的 USDT 只來自前面的賣。
  assert.deepEqual(sellIndexes, [0, 1]);
  assert.deepEqual(buyIndexes, [2]);
  assert.ok(Math.max(...sellIndexes) < Math.min(...buyIndexes));
  assert.equal(plan.steps[0]?.amountIn, 100_000_000_000_000_000n); // 0.1 WBNB
  assert.equal(plan.steps[1]?.amountIn, 50_000_000n); // 50 顆 TOKEN6（6 位小數）
  assert.equal(plan.steps[2]?.amountIn, 100_000_000_000_000_000_000n); // 100 USDT
});

test('H3 targets 不含 numeraire → blocked（執行器只換 version.assets 裡的代幣）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN3, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  // 兩個目標資產都沒有 USDT：賣 WBNB 換來的 USDT 沒有落點，買 NVDAB 也付不出 USDT。
  const targets = targetsOf(WBNB, TOKEN3);
  const chain = hubChain({
    quotes: { [`${WBNB}:${USDT}`]: { minimum: 69_000_000_000_000_000_000n } },
  });
  const plan = await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 }));

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /numeraire/);
  assert.match(plan.reason, /version\.assets/);
  assert.match(plan.reason, /AssetNotAllowed/);
  assert.equal('steps' in plan, false);
  // 連報價都不該問：hub 不在策略資產裡是結構問題，不是市場問題。
  assert.equal(chain.calls.some((call) => call.functionName === 'previewSwap'), false);
});

test('H4 某個資產沒有註冊 oracle → 跳過那一步並記在 rationale，其他 step 照走', async () => {
  const { holdings, targets } = threeAssetCase();
  // 只註冊 WBNB：NVDAB 的 `oracleOf` 回零地址（真的 router 會 revert OracleNotSet）。
  const chain = hubChain({
    pairs: { [WBNB.toLowerCase()]: { oracle: ORACLE_WBNB_USDT, pool: WBNB_USDT_POOL, fee: 500 } },
    quotes: { [`${WBNB}:${USDT}`]: { minimum: 137_000_000_000_000_000_000n } },
  });
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.tokenIn, getAddress(WBNB));
  assert.match(plan.rationale, /被跳過 1 筆/);
  assert.match(plan.rationale, /OracleNotSet/);
  assert.match(plan.rationale, /跳過/);
  // 跳過的那一步不會貢獻 USDT 預算：沒有買的 step，因為 NVDAB 根本報不出價。
  assert.equal(plan.steps.some((step) => step.tokenIn.toLowerCase() === USDT.toLowerCase()), false);
});

test('H5 全部步驟都被跳過 → noop（永不回空的 steps）', async () => {
  const { holdings, targets } = threeAssetCase();
  const chain = hubChain({ pairs: {}, quotes: {} });
  const plan = await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 }));

  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /produced no executable step/);
  assert.match(plan.reason, /OracleNotSet/);
  assert.equal('steps' in plan, false);
});

test('H6 買的 USDT 預算 ≤ 現有持倉 + 前面賣出的保證淨額（不夠就夾到）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // $600
    holding(TOKEN3, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // $200
    holding(USDT, 0n, 18, PRICE_1_USD), // 手上 0 USDT：買的錢只能來自賣
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 1_000 },
    { asset: TOKEN3, weightBps: 5_000 },
    { asset: USDT, weightBps: 4_000 },
  ];
  const drift = craftedDrift({
    totalUsdE8: 100_000_000_000n,
    rows: [
      { asset: WBNB, targetBps: 1_000, currentBps: 6_000, usdValueE8: 60_000_000_000n },
      { asset: TOKEN3, targetBps: 5_000, currentBps: 2_000, usdValueE8: 20_000_000_000n },
      { asset: USDT, targetBps: 4_000, currentBps: 2_000, usdValueE8: 20_000_000_000n },
    ],
  });
  const chain = hubChain({
    quotes: {
      [`${WBNB}:${USDT}`]: { minimum: 137_000_000_000_000_000_000n },
      [`${USDT}:${TOKEN3}`]: { minimum: 135_000_000_000_000_000_000n },
    },
  });
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  // 賣 WBNB：deltaUsd = 6e10 − ceil(1000×1e11/1e4) = 5e10 → 5e10×1e18/1e11 = 5e17 wei = 0.5 顆
  assert.equal(plan.steps[0]?.tokenIn, getAddress(WBNB));
  assert.equal(plan.steps[0]?.amountIn, 500_000_000_000_000_000n);
  // 買 NVDAB：想付 3e10 → 3e20 USDT，但預算只有 0（持倉）+ 1.37e20（賣出的 floor）→ 夾到 1.37e20
  const buy = plan.steps[1];
  assert.ok(buy !== undefined);
  assert.equal(buy.tokenIn, getAddress(USDT));
  assert.equal(buy.amountIn, 137_000_000_000_000_000_000n);
  assert.ok(buy.amountIn <= (plan.steps[0]?.oracleFloor ?? 0n)); // 預算上界就是賣出的保證量（fee 0）
  assert.match(plan.rationale, /USDT 預算/);
  assert.match(plan.rationale, /夾取：依漂移算出 300000000000000000000/);
});

test('H7 hub 模式：賣的量超過持倉 → 夾到持倉，並在 rationale 說明', async () => {
  // 刻意不一致的 drift（total $2000，帳戶只有 1 顆 $1000 的 WBNB）：夾取是唯一防線，
  // 因為「多賣」在合約層完全合法（合約只驗 amountOutMin 下限）。
  const holdings = [
    holding(WBNB, 1_000_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN3, 0n, 18, PRICE_1_USD),
    holding(USDT, 0n, 18, PRICE_1_USD),
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 1_000 },
    { asset: TOKEN3, weightBps: 5_000 },
    { asset: USDT, weightBps: 4_000 },
  ];
  const drift = craftedDrift({
    totalUsdE8: 200_000_000_000n, // $2000
    rows: [
      { asset: WBNB, targetBps: 1_000, currentBps: 15_000, usdValueE8: 200_000_000_000n },
      { asset: TOKEN3, targetBps: 5_000, currentBps: -5_000, usdValueE8: 0n },
      { asset: USDT, targetBps: 4_000, currentBps: -10_000, usdValueE8: 0n },
    ],
  });
  const chain = hubChain({
    quotes: {
      [`${WBNB}:${USDT}`]: { minimum: 688_000_000_000_000_000_000n },
      [`${USDT}:${TOKEN3}`]: { minimum: 1_000_000_000_000_000_000n },
    },
  });
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  // deltaUsd = 2e11 − ceil(1000×2e11/1e4) = 1.8e11 → 1.8e18 wei，持倉只有 1e18 → 夾到 1e18。
  assert.equal(plan.steps[0]?.amountIn, 1_000_000_000_000_000_000n);
  assert.match(plan.rationale, /夾取：依漂移算出 1800000000000000000/);
});

test('H8 2 資產（WBNB/USDT 60-40）在 hub 模式與 pinned 模式算出同一個 amountIn', async () => {
  // 既有 2 資產行為不變：同一個投組、同一個塊，兩種 oracle 形狀都要得到 0.1 WBNB。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const targets = targetsOf(WBNB, USDT);

  const pinned = expectReady(
    await planRebalance(argsOf(baseChain({ rate: RATE_WBNB_USDT }), { holdings, targets, thresholdBps: 100 })),
  );
  const hub = expectReady(
    await planRebalance(
      hubArgs(hubChain({ quotes: { [`${WBNB}:${USDT}`]: { minimum: 69_000_000_000_000_000_000n } } }), {
        holdings,
        targets,
        thresholdBps: 100,
      }),
    ),
  );

  assert.equal(pinned.steps.length, 1);
  assert.equal(hub.steps.length, 1); // USDT 是 hub：只有 WBNB 那一邊產生 step
  assert.equal(hub.steps[0]?.tokenIn, pinned.steps[0]?.tokenIn);
  assert.equal(hub.steps[0]?.tokenOut, pinned.steps[0]?.tokenOut);
  assert.equal(hub.steps[0]?.amountIn, pinned.steps[0]?.amountIn);
  assert.equal(hub.steps[0]?.amountIn, 100_000_000_000_000_000n);
});

test('H9 hub 模式：判不出 oracle 形狀 → blocked（不猜、不送）', async () => {
  const { holdings, targets } = threeAssetCase();
  const chain = baseChain();
  // 一個「pool() 會 revert、也沒有 numeraire()」的 oracle：兩個形狀都不像。
  chain.oracle = { ...chain.oracle };
  const broken = {
    ...chain,
    calls: [] as ChainCall[],
    blockReads: 0,
  };
  const client = {
    getBlock: async () => ({ number: broken.block.number, timestamp: broken.block.timestamp, hash: '0x', transactions: [] }),
    readContract: async (args: { functionName: string }) => {
      broken.calls.push({ functionName: args.functionName, address: '0x0' });
      throw new Error('execution reverted');
    },
  };
  const plan = await planRebalance({
    ...hubArgs(chain, { holdings, targets, thresholdBps: 100 }),
    publicClient: client as unknown as PublicClient,
  });

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /cannot tell which pairs/);
  assert.equal('steps' in plan, false);
});

// ---------------------------------------------------------------- 價格衝擊上限（拆單）

/** Q64.96：√P = 1 的那個定點值。 */
const SQRT_PRICE_ONE = 2n ** 96n;
/**
 * 池子（token0 = USDT、token1 = WBNB）在 **1 WBNB = 1000 USDT** 時的 `sqrtPriceX96`。
 * raw 價格是 token1/token0 = 1e-3（兩個都是 18 位小數），所以 `√P × 2^96 = 2^96 / √1000`。
 * 整數截斷的相對誤差 ~1e-10 ⇒ 0 bps，估價容得下。
 *
 * 為什麼需要它：DB 價格（`usdPriceE8`）與池子報價必須是同一個價，否則「執行後預估漂移」量到的是
 * 「價格表 vs 池子」的差，不是這次再平衡的效果。
 */
const SQRT_PRICE_WBNB_1000 = (SQRT_PRICE_ONE * 10n ** 9n) / 31_622_776_601n;

/** 一個「價格 = 1、流動性 = liquidity、沒有 fee」的池子狀態。兩邊都是 18 位小數，所以 raw 比值就是價格。 */
function unitPool(liquidity: bigint, tokenInIsToken0 = true): PoolImpactState {
  return { sqrtPriceX96: SQRT_PRICE_ONE, liquidity, tokenInIsToken0, feeUnits: 0 };
}

test('impact 手算：L=1e18、√P=1、賣 1e15 → 到手 999000999000999、impact 9 bps、priceMove 約 2 倍', () => {
  const state = unitPool(10n ** 18n);
  const amountIn = 10n ** 15n;
  const estimate = estimateImpact(state, amountIn, amountIn); // TWAP 價 = 現貨價 = 1 → quoted = amountIn

  // 手算：S₁ = S·L·Q/(L·Q + x·S) = Q/1.001；out = L(S−S₁)/Q = 1e18·(1 − 1/1.001) = 999000999000999.000…
  assert.equal(estimate.estimatedOut, 999_000_999_000_999n);
  // impact = (1e15 − 999000999000999) / 1e15 = 9.99e-4 → 9 bps（向下截斷，偏保守那一側）
  assert.equal(estimate.impactBps, 9);
  // 現貨＝TWAP 且 fee = 0 → baseline 是 0（與量無關的那一項不存在）
  assert.equal(estimate.baselineBps, 0);
  // 價格空間那條公式 ≈ 到手量空間的 2 倍：到手價是幾何平均 √(P₀P₁)，價格移動的一半。
  assert.equal(estimate.priceMoveBps, 19);
});

test('impact 手算：token1 進的方向對稱（同一組數字），priceMove 仍約 2×', () => {
  const estimate = estimateImpact(unitPool(10n ** 18n, false), 10n ** 15n, 10n ** 15n);
  assert.equal(estimate.estimatedOut, 999_000_999_000_999n);
  assert.equal(estimate.impactBps, 9);
  assert.equal(estimate.priceMoveBps, 20);
});

test('impact baseline 與量無關：現貨比 TWAP 低 199 bps 時，量從 1e15 到 1e18 都是 199 bps', () => {
  const liquidity = 10n ** 18n;
  const state: PoolImpactState = {
    sqrtPriceX96: (SQRT_PRICE_ONE * 99n) / 100n, // P = 0.9801 → 比 TWAP 低 199 bps
    liquidity,
    tokenInIsToken0: true,
    feeUnits: 0,
  };
  assert.equal(estimateImpact(state, 10n ** 15n, 10n ** 15n).baselineBps, 199);
  assert.equal(estimateImpact(state, 10n ** 18n, 10n ** 18n).baselineBps, 199);

  // 方向很重要：賣 token1 換 token0 時到手量 ∝ 1/P，所以同一個「現貨比 TWAP 低」對它是**有利**的
  // （baseline 0），而「現貨比 TWAP 高 2.01%」才是不利的那一側（197 bps）。
  const favored: PoolImpactState = { ...state, tokenInIsToken0: false };
  assert.equal(estimateImpact(favored, 10n ** 15n, 10n ** 15n).baselineBps, 0);
  const penalized: PoolImpactState = { ...favored, sqrtPriceX96: (SQRT_PRICE_ONE * 101n) / 100n };
  assert.equal(estimateImpact(penalized, 10n ** 15n, 10n ** 15n).baselineBps, 197);
});

test('capAmountInForImpact：超標 → 縮到剛好 ≤ 預算；再加 1 個最小單位就超標（是最大可行量）', () => {
  const state = unitPool(10n ** 18n);
  const ideal = 10n ** 18n;
  const cap = capAmountInForImpact({ state, idealAmountIn: ideal, idealQuoted: ideal, maxImpactBps: 50 });

  assert.equal(cap.shrunk, true);
  assert.equal(cap.noSizeFits, false);
  assert.ok(cap.idealEstimate.impactBps > 50, `理想量的衝擊要超過預算（實際 ${cap.idealEstimate.impactBps}）`);
  assert.ok(cap.estimate.impactBps <= 50, `縮小之後的衝擊必須 ≤ 預算（實際 ${cap.estimate.impactBps}）`);
  assert.ok(
    estimateImpact(state, cap.amountIn + 1n, cap.amountIn + 1n).impactBps > 50,
    '再多 1 個最小單位就要超標 —— 證明這是最大可行量，不是隨便取一個小一點的數',
  );
  // 手算：impact = a/(a+L) = 50 bps → a = 5L/995 ≈ 5.025e15（截斷到 50 bps 會多放寬 ~2%）。
  assert.ok(cap.amountIn > 5n * 10n ** 15n, `要接近手算的 5.025e15（實際 ${cap.amountIn}）`);
  assert.ok(cap.amountIn < 52n * 10n ** 14n, `不該超過手算值太多（實際 ${cap.amountIn}）`);
});

test('capAmountInForImpact：未超預算時一個位都不動（回歸的核心）', () => {
  const state = unitPool(10n ** 30n); // 深池子：1e17 的衝擊接近 0
  const ideal = 10n ** 17n;
  const cap = capAmountInForImpact({ state, idealAmountIn: ideal, idealQuoted: ideal, maxImpactBps: 50 });
  assert.equal(cap.shrunk, false);
  assert.equal(cap.amountIn, ideal);
  assert.equal(cap.estimate.impactBps, cap.idealEstimate.impactBps);
});

test('capAmountInForImpact：dust 量不會被整數截斷誤判成 10000 bps（真鏈上踩到的 bug）', () => {
  // fee 25 bps、現貨 == TWAP → baseline 只有手續費，任何小的量都應該在 50 bps 預算內。
  // 修正前：`estimatedOut` 在 1 個最小單位上被截斷成 0 → 比率算成 10000 bps → 誤判 noSizeFits，
  // 整條 leg 被丟掉（真鏈上就是這樣把一筆 $166k 的買單整個跳過的）。
  const state: PoolImpactState = {
    sqrtPriceX96: SQRT_PRICE_ONE,
    liquidity: 10n ** 18n,
    tokenInIsToken0: false,
    feeUnits: 2_500,
  };
  const ideal = 10n ** 23n;
  const cap = capAmountInForImpact({ state, idealAmountIn: ideal, idealQuoted: ideal, maxImpactBps: 50 });
  assert.equal(cap.idealEstimate.baselineBps, 25, 'baseline 就是池子 fee');
  assert.equal(cap.noSizeFits, false, '25 bps 的 baseline 一定有可行的量');
  assert.ok(cap.amountIn > 0n);
  assert.ok(cap.estimate.impactBps <= 50);
  // 手算：impact(a) = 1 − (1−fee)/(1 + a/L) → 50 bps ⇔ 1 + a/L = 0.9975/0.995 ⇔ a ≈ 2.51e15
  assert.ok(cap.amountIn > 2n * 10n ** 15n && cap.amountIn < 3n * 10n ** 15n, `實際 ${cap.amountIn}`);
});

test('capAmountInForImpact：連 1 個最小單位都超預算 → noSizeFits（是 baseline 的問題，不是量的問題）', () => {
  const state: PoolImpactState = {
    sqrtPriceX96: (SQRT_PRICE_ONE * 99n) / 100n,
    liquidity: 10n ** 18n,
    tokenInIsToken0: true,
    feeUnits: 0,
  };
  const cap = capAmountInForImpact({ state, idealAmountIn: 10n ** 17n, idealQuoted: 10n ** 17n, maxImpactBps: 50 });
  assert.equal(cap.noSizeFits, true);
  assert.equal(cap.amountIn, 0n);
  assert.equal(cap.idealEstimate.baselineBps, 199);
});

/** 2 資產的 pinned 情境 + 一個可以指定流動性／現貨價的池子（預設按量計價、滑價 1%）。 */
function impactChain(options: {
  liquidity: bigint;
  sqrtPriceX96?: bigint;
  feeUnits?: number;
  slippageBps?: number;
  /**
   * 「1 個 tokenIn 的 wei 換幾個 tokenOut 的 wei」。預設 1:1，與 `SQRT_PRICE_ONE` 的現貨價一致；
   * 要讓「執行後的預估漂移」有意義就得跟 DB 價格一致（估價用的是 holdings 的 usdPriceE8）。
   */
  rateE18?: bigint;
}): StubChain {
  const chain = baseChain({ pool: { fee: options.feeUnits ?? 0 } });
  chain.poolState = {
    sqrtPriceX96: options.sqrtPriceX96 ?? SQRT_PRICE_ONE,
    liquidity: options.liquidity,
    token0: USDT,
  };
  chain.rate = { rateE18: options.rateE18 ?? 10n ** 18n, slippageBps: options.slippageBps ?? 100 };
  return chain;
}

/** pinned 情境的持倉：WBNB 超配，賣方是 WBNB（pool 的 token1）。 */
function pinnedHoldings(): Holding[] {
  return [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // $600
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD), // $400
  ];
}

test('pinned：理想量超過預算 → step 被縮小、impact ≤ 預算、partial 有記錄、rationale 標「部分執行」', async () => {
  const chain = impactChain({ liquidity: 10n ** 18n });
  const plan = expectReady(
    await planRebalance(argsOf(chain, {
      maxImpactBps: 50, holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );
  const step = plan.steps[0];
  assert.ok(step !== undefined);
  const ideal = 100_000_000_000_000_000n; // 0.1 顆 WBNB（$600 超配 5000 bps 的一半）
  assert.ok(step.amountIn < ideal, `要被縮小（實際 ${step.amountIn}）`);
  assert.ok(step.amountIn > 0n);

  // partial 是**結構化**訊號，排程器靠它決定提早再跑。
  assert.ok(plan.partial !== undefined, 'ready 要帶 partial');
  // 判準是**執行後的預估漂移**（不是「有沒有被縮」）：只賣了一小塊，當然還在門檻之上。
  assert.ok(
    (plan.partial?.remainingDriftBps ?? 0) >= 100,
    `執行後預估漂移 ${plan.partial?.remainingDriftBps} 必須仍 ≥ 門檻 100`,
  );
  const shrunk = plan.partial?.shrunk[0];
  assert.ok(shrunk !== undefined);
  assert.equal(shrunk.index, 0);
  assert.equal(shrunk.idealAmountIn, ideal);
  assert.equal(shrunk.amountIn, step.amountIn);
  assert.ok(shrunk.idealImpactBps > DEFAULT_MAX_IMPACT_BPS);
  assert.ok(shrunk.impactBps <= DEFAULT_MAX_IMPACT_BPS, `縮小後 impact ${shrunk.impactBps} 必須 ≤ 預算`);

  // 地板是**縮小後的量**重問回來的（同一批裡換一個量就是另一個地板）。
  assert.equal(step.oracleFloor, (step.amountIn * 9_900n + 9_999n) / 10_000n);
  assert.equal(step.amountOutMin, amountOutMinWithBuffer(minGrossFor(step.oracleFloor, 0)));
  // 兩次報價：理想量一次、縮小後再一次。
  assert.equal(chain.calls.filter((call) => call.functionName === 'previewSwap').length, 2);

  assert.match(plan.rationale, /⚠ partial execution/);
  assert.match(plan.rationale, /rest goes to the next round/);
  // 這一條測的是「預算怎麼作用」，所以預算要**明確給**，不要依賴預設值（預設改了不該讓它變義意）。
  assert.match(plan.rationale, /exceeds the 50 bps budget/);
});

test('pinned：沒超過預算 → 與關掉上限（maxImpactBps: null）的結果完全相同（回歸）', async () => {
  // 報價與 DB 價格一致（1 WBNB = $1000）：執行後的預估漂移才有意義（賣對了就收斂）。
  const deep = () =>
    impactChain({ liquidity: 10n ** 30n, sqrtPriceX96: SQRT_PRICE_WBNB_1000, rateE18: 1_000n * 10n ** 18n });
  const on = expectReady(
    await planRebalance(argsOf(deep(), { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );
  const off = expectReady(
    await planRebalance(
      argsOf(deep(), { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 , maxImpactBps: null }),
    ),
  );
  assert.deepEqual(on.steps, off.steps, '未超預算時 steps 要逐位相同');
  assert.equal(on.deadline, off.deadline);
  // 判準是結果：賣對了就收斂，所以沒有 partial（不是「沒被縮小」，那是舊定義）。
  assert.equal(on.partial, undefined, '執行後收斂就不該帶 partial');
  assert.match(on.rationale, /converged/);
  assert.doesNotMatch(on.rationale, /partial execution/);
  // 而且真的沒有縮：量就是理想量。
  assert.equal(on.steps[0]?.amountIn, 100_000_000_000_000_000n);
});

test('pinned：maxImpactBps: null → 池子狀態一次都不讀（完全回到舊行為）', async () => {
  const chain = impactChain({ liquidity: 10n ** 18n, rateE18: 1_000n * 10n ** 18n });
  const plan = expectReady(
    await planRebalance(
      argsOf(chain, { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100, maxImpactBps: null }),
    ),
  );
  const poolReads = chain.calls.filter(
    (call) => call.functionName === 'slot0' || call.functionName === 'liquidity',
  );
  assert.deepEqual(poolReads, []);
  assert.equal(plan.partial, undefined, '執行後收斂就不該帶 partial');
  assert.equal(plan.steps[0]?.amountIn, 100_000_000_000_000_000n);
});

test('pinned：縮小後只剩 dust（< 理想量的 1 bp）→ 跳過那一步，全部跳過 → noop', async () => {
  // 賣 100 顆 WBNB（$100）進 L=1e18 的池子：最大可行量 ≈ 0.005 顆，只有理想量的 0.005% < 1 bp。
  const holdings = [
    holding(WBNB, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // 200 顆 @ $1 = $200
    holding(USDT, 0n, 18, PRICE_1_USD),
  ];
  const chain = impactChain({ liquidity: 10n ** 18n });
  const plan = await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 }));

  assert.equal(plan.kind, 'noop', `全部縮到 dust 要回 noop（實際 ${plan.kind}）`);
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /dust/);
  assert.match(plan.reason, /Not sending empty steps/);
  assert.equal('steps' in plan, false, '絕不回空 steps');
});

test('pinned：baseline（fee + 現貨 vs TWAP）本身就超預算 → noop 並說明「切多小都沒用」，不是 blocked', async () => {
  // 賣的是 WBNB（pool 的 token1）→ 到手量 ∝ 1/P，所以「現貨比 TWAP 貴 2.01%」才是不利的那一側。
  const chain = impactChain({ liquidity: 10n ** 18n, sqrtPriceX96: (SQRT_PRICE_ONE * 101n) / 100n });
  const plan = await planRebalance(
    argsOf(chain, { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );
  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /not a size problem/);
  assert.match(plan.reason, /no size fixes that/);
  assert.match(plan.reason, /197 bps/); // 現貨 P = 1.0201 → 邊際到手 98.02% → baseline 197 bps
});

test('pinned：池子狀態讀不到（slot0/liquidity 沒有）→ 放行原量並在 rationale 記錄，不是擋下來', async () => {
  const chain = baseChain(); // 沒有 poolState：stub 對 slot0/liquidity 一律拋
  // 與 DB 價格一致（1 WBNB = $1000），否則「執行後預估漂移」只是報價與價格表不一致的假象。
  chain.rate = { rateE18: 1_000n * 10n ** 18n, slippageBps: 100 };
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );
  assert.equal(plan.steps[0]?.amountIn, 100_000_000_000_000_000n, '估不出來時送原量（軟性護欄，不是安全不變量）');
  assert.equal(plan.partial, undefined, '原量賣完就收斂（上限沒套用不影響判準）');
  assert.match(plan.rationale, /估不出衝擊/);
  assert.match(plan.rationale, /上限未套用/);
});

test('maxImpactBps 的解析：省略 = 80、null = 關掉、非法值 → RangeError', () => {
  assert.equal(resolveMaxImpactBps(undefined), DEFAULT_MAX_IMPACT_BPS);
  // 80 嚴格小於 per-pair oracle 的 maxSlippageBps（100）：合約的 BelowFloor 永遠比我們寬鬆。
  assert.equal(DEFAULT_MAX_IMPACT_BPS, 80);
  assert.equal(resolveMaxImpactBps(null), null);
  assert.equal(resolveMaxImpactBps(25), 25);
  for (const bad of [0, -1, 10_000, 1.5, Number.NaN]) {
    assert.throws(() => resolveMaxImpactBps(bad), RangeError, `${bad} 不是合法上限`);
  }
});

test('hub：賣的 leg 被縮小 → 買的 USDT 預算跟著縮（不能拿理想賣出量的錢去買）', async () => {
  // WBNB $600 / NVDAB $200 / USDT $0，目標 40/30/30 → 賣 $280 的 WBNB、買 $40 的 NVDAB。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN3, 200_000_000_000_000_000_000n, 18, PRICE_1_USD),
    holding(USDT, 0n, 18, PRICE_1_USD),
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 4_000 },
    { asset: TOKEN3, weightBps: 3_000 },
    { asset: USDT, weightBps: 3_000 },
  ];
  const chain = hubChain();
  chain.poolState = { sqrtPriceX96: SQRT_PRICE_ONE, liquidity: 10n ** 18n, token0: USDT };
  chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 };

  const plan = expectReady(await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })));
  const sellStep = plan.steps[0];
  const buyStep = plan.steps[1];
  assert.ok(sellStep !== undefined && buyStep !== undefined);

  assert.ok(sellStep.amountIn < 280_000_000_000_000_000n, '賣的量要被縮小');
  assert.ok(plan.partial !== undefined, 'hub 模式也要帶 partial');
  assert.equal(plan.partial?.shrunk[0]?.index, 0);
  // USDT 持倉是 0 → 能拿來買的只有這一輪**真的賣到**的保證淨額（fee 0 = floor 本身）。
  assert.ok(
    buyStep.amountIn <= sellStep.oracleFloor,
    `買的 USDT 不能超過這一輪賣到的保證淨額：買 ${buyStep.amountIn} > 賣 ${sellStep.oracleFloor}`,
  );
  assert.match(plan.rationale, /partial execution/);
});

// ---------------------------------------------------- partial 的判準是「結果」，不是「過程」

/** hub 的報價 key：`${tokenIn}:${tokenOut}`（方向有意義）。 */
function quoteKey(tokenIn: Address, tokenOut: Address): string {
  return `${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;
}

test('收斂：完整一輪把兩個缺口都補掉 → 執行後預估漂移降到門檻下 → **不是** partial', async () => {
  // WBNB $600 / NVDAB $200 / USDT $200，目標 40/30/30 → 賣 $200 WBNB、買 $100 NVDAB，兩個缺口都做。
  // 報價與 DB 價格一致：賣 0.2 WBNB 到手 198 USDT、買 99 NVDAB。
  // → WBNB 40.12% / NVDAB 29.99% / USDT 29.89%：gross drift ≈ 12 bps，遠低於門檻 100。
  const { holdings, targets } = threeAssetCase();
  const chain = hubChain({
    quotes: {
      [quoteKey(WBNB, USDT)]: { quoted: 200n * 10n ** 18n, minimum: 198n * 10n ** 18n },
      [quoteKey(USDT, TOKEN3)]: { quoted: 100n * 10n ** 18n, minimum: 99n * 10n ** 18n },
    },
  });

  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );
  assert.equal(plan.steps.length, 2, '賣 + 買各一個 step');
  assert.equal(plan.partial, undefined, '執行後就收斂 → 不該帶 partial（排程器用完整間隔）');
  assert.match(plan.rationale, /Estimated drift after this round \d+ bps/);
  assert.match(plan.rationale, /converged/);
  assert.doesNotMatch(plan.rationale, /still above the threshold/);
});

test('縮小但收斂：step 真的被衝擊上限縮小，執行後仍收斂 → **不是** partial（舊定義會誤判）', async () => {
  // 舊定義是「有 step 被縮小 ⇒ partial」。這裡 100 顆的賣單被縮到 ~75 顆（真的縮了），但縮完之後
  // 60/40 → 52.5/47.5，gross drift 約 254 bps，已經在門檻 600 之下 ⇒ 沒有事了，不該叫下一輪。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000_000n, 18, PRICE_1_USD), // 600 顆 @ $1 = $600（60%）
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD), // $400（40%）
  ];
  const chain = impactChain({ liquidity: 15n * 10n ** 21n }); // 現貨 1:1 與 rate 一致

  const plan = expectReady(
    await planRebalance(
      argsOf(chain, {
      maxImpactBps: 50, holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 600 }),
    ),
  );
  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.ok(step.amountIn < 100n * 10n ** 18n, `要被縮小（實際 ${step.amountIn} < 理想 1e20）`);
  assert.ok(step.amountIn > 0n);
  assert.equal(plan.partial, undefined, '縮小不是判準：執行後收斂就沒有 partial');
  assert.match(plan.rationale, /⚠ partial execution/, '縮小的證據仍然留在理由裡');
  assert.match(plan.rationale, /converged/);
});

test('主要缺口被跳過（不是被縮小）→ partial 存在，且 remainingDriftBps 說得出還差多少', async () => {
  // 這一輪真正該做的是「買 $200 的 NVDAB」，但 router 沒為它註冊 oracle → 整筆被跳過；
  // 只剩賣 0.3 WBNB 換 297 USDT，而 USDT 本來就低配 → 漂移 3000 → 約 1994，還差得遠。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // $600（60%）
    holding(TOKEN3, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // $200（20%）
    holding(USDT, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // $200（20%）
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 3_000 },
    { asset: TOKEN3, weightBps: 4_000 },
    { asset: USDT, weightBps: 3_000 },
  ];
  const chain = hubChain({
    // 只註冊 WBNB：NVDAB 的買入那一步會被跳過（不是被縮小）。
    pairs: { [WBNB.toLowerCase()]: { oracle: ORACLE_WBNB_USDT, pool: WBNB_USDT_POOL, fee: 500 } },
    quotes: { [quoteKey(WBNB, USDT)]: { quoted: 297n * 10n ** 18n, minimum: 297n * 10n ** 18n } },
  });

  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );
  assert.equal(plan.steps.length, 1, '只有賣 WBNB 這一步');
  assert.ok(plan.partial !== undefined, '缺口還在 → 必須是 partial（這一條就是那個一小時退避的 bug）');
  assert.equal(plan.partial?.shrunk.length, 0, '沒有 step 被縮小，缺口是被**跳過**');
  const remaining = plan.partial?.remainingDriftBps ?? 0;
  assert.ok(remaining > 100, `執行後預估漂移 ${remaining} 必須仍高於門檻 100`);
  assert.ok(remaining > 1_500, `賣掉 297 USDT 之後還差得遠（實際 ${remaining}）`);
  assert.match(plan.rationale, /still above the threshold/);
  assert.match(plan.rationale, /skipped rather than shrunk/);
  assert.match(plan.rationale, /被跳過 1 筆/);
});

// 回歸（實測踩到）：投組只持有 numeraire，這一輪要**買進兩個沒持有的資產**。
//
// 買到的量沒有價格可以估 → 執行後的漂移算不出來。錯的做法是拿「執行前的漂移」當預測值講出來：
// 使用者看到「still 6600 bps after this round」，而實際那一輪把 6600 收斂到 6。
test('買進沒持有的資產 → partial.remainingDriftBps 是 null（算不出來），不是執行前的數字', async () => {
  const holdings = [holding(USDT, 5_000_000_000_000_000_000_000n, 18, PRICE_1_USD)];
  const targets: TargetWeight[] = [
    { asset: USDT, weightBps: 3_400 },
    { asset: WBNB, weightBps: 3_300 },
    { asset: TOKEN3, weightBps: 3_300 },
  ];
  // hub 模式（numeraire = USDT），報價要給：兩個買入腿都要有 minimum 才走得下去。
  const chain = hubChain({
    quotes: {
      // 買入腿的方向是 USDT → 資產，key 用 (tokenIn:tokenOut)。
      [`${USDT}:${WBNB}`]: { minimum: 1_600_000_000_000_000_000n },
      [`${USDT}:${TOKEN3}`]: { minimum: 3_000_000_000_000_000_000_000n },
    },
  });
  const plan = expectReady(await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })));
  assert.equal(plan.steps.length, 2);
  assert.notEqual(plan.partial, undefined, '要帶 partial（還有事沒做完）');
  assert.equal(
    plan.partial?.remainingDriftBps,
    null,
    '算不出來就是 null —— 拿執行前的漂移冒充預測值是錯的（實際上是 6600 → 6 bps 收斂的一輪）',
  );
});

test('計畫不改善漂移（賣超配的錢去補另一個也超配的資產）→ noop，不送出去付 gas', async () => {
  // WBNB +500 / NVDAB -1000 / USDT +500。這一輪只賣 $50 的 WBNB 換 USDT（買 NVDAB 那一步被跳過）：
  // WBNB 的偏差減少、USDT 的偏差等量增加 ⇒ Σ|delta| 完全不動，gross drift 1000 → 1000。
  // 送出去只是付 gas，所以不送。等於（不是小於）也算不改善。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // $600（60%）
    holding(TOKEN3, 300_000_000_000_000_000_000n, 18, PRICE_1_USD), // $300（30%）
    holding(USDT, 100_000_000_000_000_000_000n, 18, PRICE_1_USD), // $100（10%）
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 5_500 },
    { asset: TOKEN3, weightBps: 4_000 },
    { asset: USDT, weightBps: 500 },
  ];
  const chain = hubChain({
    pairs: { [WBNB.toLowerCase()]: { oracle: ORACLE_WBNB_USDT, pool: WBNB_USDT_POOL, fee: 500 } },
    // 賣 0.05 WBNB（$50）到手 50 USDT：平價、沒有滑價 → 漂移只是平移。
    quotes: { [quoteKey(WBNB, USDT)]: { quoted: 50n * 10n ** 18n, minimum: 50n * 10n ** 18n } },
  });

  const plan = await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 }));
  assert.equal(plan.kind, 'noop', `不改善就不送（實際 ${plan.kind}）`);
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /would leave estimated drift at 1000 bps/);
  assert.match(plan.reason, /not below the current 1000 bps/);
  assert.match(plan.reason, /only cost gas/);
  assert.equal('steps' in plan, false, '絕不回空 steps');
});

// ---------------------------------------------------------------- 真 fork 交叉驗證（環境不在就 skip）

const RPC_URL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const publicClient = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL, { timeout: 20_000, retryCount: 1 }),
});

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

/**
 * fork 能不能用：oracle 在 head 有沒有 code。讀不到（403 archive / 沒開 anvil）與「沒有 code」在這裡
 * 是同一個結論：這台機器上跑不了交叉驗證，明確 skip 並說出原因，不讓 suite 變紅也不靜默 pass。
 */
async function probeFork(): Promise<string | null> {
  try {
    const head = await publicClient.getBlockNumber();
    const code = await publicClient.getCode({ address: ORACLE, blockNumber: head });
    if (code === undefined || code.length <= 2) {
      return `oracle ${ORACLE} 在 head(${head}) 沒有 code（fresh fork 或 state 沒載入）`;
    }
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return `RPC ${RPC_URL} 讀不到：${reason}`;
  }
}

const skipReason = await probeFork();
const onChain = skipReason === null ? {} : { skip: skipReason };
if (skipReason !== null) console.warn(`[rebalance-plan] 交叉驗證 skip：${skipReason}`);

test('交叉驗證：真 fork 上跑一次規劃器，minGross ≥ previewSwap 的 minimum、path fee 來自真池子', onChain, async () => {
  const blockNumber = await publicClient.getBlockNumber();
  const block = await publicClient.getBlock({ blockNumber });

  // 真價格：WBNB 走 TWAP，USDT 是 numeraire（1e8 定義）。
  const wbnbPrice = await twapPriceInUsdt(publicClient, {
    token: WBNB,
    usdtPool: WBNB_USDT_POOL,
    expectedQuoteToken: USDT,
    blockNumber,
  });
  assert.equal(wbnbPrice.decimals, 18);

  // 造一個「WBNB 超配 1000 bps」的持倉（$600 / $400），實際帳戶是空倉 —— 這裡只讀鏈，不動狀態。
  const holdings: Holding[] = [
    { asset: WBNB, amountWei: 600_000_000_000_000_000n, decimals: 18, usdPriceE8: wbnbPrice.priceE8 },
    { asset: USDT, amountWei: 400_000_000_000_000_000_000n, decimals: 18, usdPriceE8: PRICE_1_USD },
  ];
  const targets = targetsOf(WBNB, USDT);
  const wallBefore = wallClockSeconds();
  const plan = await planRebalance({
    publicClient,
    account: '0x2b082fadf8f3d620eaa242a9e36817af8640d042' as Address,
    executor: EXECUTOR,
    oracle: ORACLE,
    registry: REGISTRY,
    strategyId: 1n, // 鏈上 id（DB 的 strategies.id 11 對應到鏈上 1）
    holdings,
    targets,
    drift: computeDrift(holdings, targets, 100),
    thresholdBps: 100,
    blockNumber,
  });
  const wallAfter = wallClockSeconds();

  const ready = expectReady(plan);
  const step = ready.steps[0];
  assert.ok(step !== undefined);

  // 1. oracleFloor 必須逐位等於同一個塊上直接呼叫 previewSwap 的第二個回傳值（minimum，不是 quoted）。
  const [quoted, minimum] = await publicClient.readContract({
    address: ORACLE,
    abi: ORACLE_ABI,
    functionName: 'previewSwap',
    args: [step.tokenIn, step.tokenOut, step.amountIn],
    blockNumber,
  });
  assert.equal(step.oracleFloor, minimum);
  // 「取的是 minimum 不是 quoted」由單元測試（stub 的 quoted ≠ minimum）釘死；這裡 quoted 只當對照印出來。
  assert.ok(quoted > 0n && minimum > 0n);

  // 2. minGross 逐字對齊合約公式，且 ≥ oracleFloor。
  const feeBps = Number(
    await publicClient.readContract({
      address: REGISTRY,
      abi: REGISTRY_ABI,
      functionName: 'effectiveFeeBps',
      args: [1n],
      blockNumber,
    }),
  );
  assert.equal(step.amountOutMin, amountOutMinWithBuffer(minGrossFor(minimum, feeBps)));
  assert.ok(step.amountOutMin >= step.oracleFloor);
  if (feeBps === 0) assert.equal(step.amountOutMin, amountOutMinWithBuffer(step.oracleFloor));

  // 3. path 的 fee 來自真池子（WBNB/USDT V3 fee 500），deadline 來自 max(塊時間, 牆鐘)。
  const decoded = decodeStepInput(step);
  assert.equal(pathFee(decoded.path), 500);
  assert.equal(decoded.recipient, getAddress(EXECUTOR));
  const deadlineBaseOnChain = ready.deadline - BigInt(DEFAULT_DEADLINE_SECONDS);
  if (block.timestamp > wallAfter) {
    assert.equal(deadlineBaseOnChain, block.timestamp, '塊時間超前 → 基準就是塊時間');
  } else {
    assert.ok(
      deadlineBaseOnChain >= wallBefore && deadlineBaseOnChain <= wallAfter,
      `塊時間 ${block.timestamp} 落後牆鐘 → 基準必須是牆鐘（${wallBefore}..${wallAfter}），不是 ${deadlineBaseOnChain}`,
    );
  }
  assert.ok(ready.deadline > block.timestamp, 'deadline 必須晚於塊時間（不然鏈上就是已過期）');
  console.log(
    `[交叉驗證] 塊時間 ${block.timestamp}、牆鐘 ${wallBefore}、deadline ${ready.deadline}` +
      `（相對塊時間 +${ready.deadline - block.timestamp}s，設定 ${DEFAULT_DEADLINE_SECONDS}s）`,
  );
  assert.equal(step.commands, '0x00');
  assert.equal(step.inputs.length, 1);
});
