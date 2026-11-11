import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionResult } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { PricingError } from '../src/pricing.js';
import { MULTICALL3_ADDRESS, NUMERAIRE_PRICE_E8, priceFor, readPositions } from '../src/positions.js';
import type { PriceableAsset, PriceTokenFn } from '../src/positions.js';
import { planPortfolio, writeSnapshot } from '../src/snapshot.js';
import type { QueryFn } from '../src/snapshot.js';

/**
 * `src/positions.ts` 與 `src/snapshot.ts` 的單元測試：不碰鏈、不碰 DB。
 *
 * 鏈用一個只實作四個方法的 stub（getBlockNumber / getBalance / readContract），DB 用一個照 SQL
 * 分派的 fake query。兩者都只回「這個測試要的形狀」，所以每個測試都在驗一條規則，而不是在驗 stub。
 *
 * 這裡刻意驗的是三件「錯了會靜默污染報告」的事：
 * 1. native BNB 不在 holdings 裡（但有單獨回傳）。
 * 2. 沒有池的資產進 unpriced、不被丟掉；0 餘額的不進 holdings 也不去問價格。
 * 3. 目標權重用的是鏈上 `enrollment.version`，不是 active version、也不是 portfolios.version。
 * 4. numeraire（USDT）直接 1e8、**不呼叫**報價函式；只有真的有池的資產才去問 TWAP。
 */

const ACCOUNT = '0x2b082fadf8f3d620eaa242a9e36817af8640d042' as Address;
const AAA = '0x00000000000000000000000000000000000000aa' as Address;
const BBB = '0x00000000000000000000000000000000000000bb' as Address;
const NOPOOL = '0x00000000000000000000000000000000000000cc' as Address;
const POOL_AAA = '0x0000000000000000000000000000000000000f01' as Address;
const POOL_BBB = '0x0000000000000000000000000000000000000f02' as Address;
const ONE_USD = 100_000_000n;
/** 定價幣：portfolio 5 的目標就是這兩個（0007 已把它們放進 priceable_assets）。 */
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' as Address;
/** PancakeSwap V3 WBNB/USDT，fee 500：鏈上 oracle 用的是同一個池。 */
const WBNB_USDT_POOL = '0x36696169c63e42cd08ce11f5deeBbCeBae652050' as Address;

/** 一次 eth_call 的紀錄：`blockNumber` 漏傳 = 那次讀的是 head，快照的塊就不是同一份狀態。 */
type StubCall = { functionName: string; address: string; blockNumber?: bigint };

/** 一次 Multicall3 批次：打去哪個地址、內層呼叫的 target（依序，每顆資產 balanceOf + decimals）。 */
type StubBatch = { target: string; targets: string[]; blockNumber?: bigint };

/** stub 用的 ERC-20 ABI 形狀：編碼出來必須與 positions.ts 解碼的那一份逐位相同。 */
const ERC20_STUB_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;
const BALANCE_OF_SELECTOR = '0x70a08231';
const DECIMALS_SELECTOR = '0x313ce567';

type StubChain = {
  blockNumber: bigint;
  nativeWei: bigint;
  /** 每一次 eth_call（含 getBalance）連同它的 blockNumber。 */
  calls: StubCall[];
  /** 小寫地址 → balanceOf 的 raw 值。 */
  balances: Map<string, bigint>;
  /** 小寫地址 → decimals；缺席時預設 18。 */
  decimals: Map<string, number>;
  /** 這些地址的 balanceOf 會拋錯（模擬「不是 ERC-20」：內層 revert → success = false）。 */
  broken: Set<string>;
  /**
   * 這些地址「沒有合約」：CALL 到空地址**不會** revert，所以 Multicall3 回 `success: true` + `0x`。
   * 這一種在 success 旗標上看不出來，是真鏈上實測到的形狀（見 readTokens 的註解）。
   */
  emptyReturn: Set<string>;
  /** 每一次 Multicall3 批次（內層幾筆、打去哪）。 */
  batches: StubBatch[];
  /** `enrollments(account)` 的回傳（攤平三元組）。 */
  enrollment: readonly [bigint, number, boolean];
  /** `version(id, n)` 的回傳：n → { assets, weightsBps }。 */
  versions: Map<number, { assets: readonly Address[]; weightsBps: readonly number[] }>;
  /** 持有掃描發出去的 `eth_getLogs` 區間（它問的是「哪個塊到哪個塊」，不是 eth_call）。 */
  logCalls: { fromBlock: bigint; toBlock: bigint }[];
};

function stubClient(chain: StubChain): PublicClient {
  const client = {
    getBlockNumber: async () => chain.blockNumber,
    getBalance: async (call: { address: Address; blockNumber?: bigint }) => {
      chain.calls.push({ functionName: 'getBalance', address: call.address, blockNumber: call.blockNumber });
      return chain.nativeWei;
    },
    readContract: async (args: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }): Promise<unknown> => {
      const key = args.address.toLowerCase();
      chain.calls.push({ functionName: args.functionName, address: key, blockNumber: args.blockNumber });
      switch (args.functionName) {
        case 'balanceOf': {
          if (chain.broken.has(key)) throw new Error('execution reverted: not an ERC-20');
          return chain.balances.get(key) ?? 0n;
        }
        case 'decimals':
          return chain.decimals.get(key) ?? 18;
        case 'aggregate3': {
          // 模擬 Multicall3：逐項解內層 callData，單項失敗只讓那一項 success = false（allowFailure），
          // 整批不 revert。被 `broken` 標記的地址兩項都失敗（不是 ERC-20 時 balanceOf/decimals 都會 revert）。
          const calls = (args.args?.[0] ?? []) as { target: Address; allowFailure: boolean; callData: Hex }[];
          chain.batches.push({
            target: key,
            targets: calls.map((call) => call.target.toLowerCase()),
            blockNumber: args.blockNumber,
          });
          return calls.map((call) => {
            const target = call.target.toLowerCase();
            if (!call.allowFailure) throw new Error('stub 只支援 allowFailure: true（見 readTokens 的說明）');
            if (chain.broken.has(target)) return { success: false, returnData: '0x' as Hex };
            if (chain.emptyReturn.has(target)) return { success: true, returnData: '0x' as Hex };
            if (call.callData.startsWith(DECIMALS_SELECTOR)) {
              return {
                success: true,
                returnData: encodeFunctionResult({ abi: ERC20_STUB_ABI, functionName: 'decimals', result: chain.decimals.get(target) ?? 18 }),
              };
            }
            if (call.callData.startsWith(BALANCE_OF_SELECTOR)) {
              return {
                success: true,
                returnData: encodeFunctionResult({
                  abi: ERC20_STUB_ABI,
                  functionName: 'balanceOf',
                  result: chain.balances.get(target) ?? 0n,
                }),
              };
            }
            throw new Error(`stub 不認得的內層 callData：${call.callData.slice(0, 10)}`);
          });
        }
        case 'enrollments':
          return chain.enrollment;
        case 'version': {
          const requested = Number(args.args?.[1]);
          const version = chain.versions.get(requested);
          if (version === undefined) throw new Error(`UnknownVersion(${String(args.args?.[0])}, ${requested})`);
          return { assets: version.assets, weightsBps: version.weightsBps, scheduleHash: '0x', activeAt: 0n };
        }
        default:
          throw new Error(`stub 沒有 ${args.functionName}`);
      }
    },
    // 這個 stub 沒有歷史：`getCode` 一律回「沒有 code」，於是部署塊取不到（deployment.block = null）、
    // 二分搜尋不會發生，掃描只從 head 起掃一個塊。掃描的塊是不是對的在 snapshot.scan.test.ts 驗。
    getCode: async () => undefined,
    request: async (call: { method: string; params?: unknown[] }) => {
      if (call.method !== 'eth_getLogs') throw new Error(`stub 沒有 ${call.method}`);
      const filter = (call.params?.[0] ?? {}) as { fromBlock: string; toBlock: string };
      chain.logCalls.push({ fromBlock: BigInt(filter.fromBlock), toBlock: BigInt(filter.toBlock) });
      return [];
    },
  };
  return client as unknown as PublicClient;
}

function baseChain(overrides: Partial<StubChain> = {}): StubChain {
  return {
    blockNumber: 1_000n,
    nativeWei: 995_807_557_000_000_000n,
    calls: [],
    balances: new Map(),
    decimals: new Map(),
    broken: new Set(),
    emptyReturn: new Set(),
    batches: [],
    enrollment: [1n, 1, false],
    versions: new Map([[1, { assets: [AAA, BBB], weightsBps: [6000, 4000] }]]),
    logCalls: [],
    ...overrides,
  };
}

function token(address: Address, symbol: string, usdtPool: Address | null, isNumeraire = false): PriceableAsset {
  return { address, symbol, usdtPool, isNumeraire };
}

/** 每個資產 $1、整顆數量；`priceToken` 預設回這個價。 */
function oneDollarPrice(calls: string[] = []): PriceTokenFn {
  return async (_client, args) => {
    calls.push(args.token.toLowerCase());
    return { priceE8: ONE_USD, decimals: 18 };
  };
}

// ---------------------------------------------------------------------------
// priceFor：三種定價來源收在一處
// ---------------------------------------------------------------------------

test('priceFor：numeraire → 1e8、有池 → TWAP、無池 → unpriced（沒有第四種）', () => {
  assert.equal(NUMERAIRE_PRICE_E8, ONE_USD);
  assert.deepEqual(priceFor(token(USDT, 'USDT', null, true)), { kind: 'numeraire', priceE8: ONE_USD });
  assert.deepEqual(priceFor(token(WBNB, 'WBNB', WBNB_USDT_POOL)), { kind: 'twap', usdtPool: WBNB_USDT_POOL });
  assert.deepEqual(priceFor(token(NOPOOL, 'TSLAB', null)), { kind: 'unpriced', reason: 'no_usdt_pool' });
});

// ---------------------------------------------------------------------------
// readPositions
// ---------------------------------------------------------------------------

test('readPositions 把 native BNB 單獨回傳，holdings 裡沒有它', async () => {
  const chain = baseChain();
  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [],
    priceToken: oneDollarPrice(),
  });

  assert.equal(snapshot.nativeBalanceWei, 995_807_557_000_000_000n);
  assert.deepEqual(snapshot.holdings, []);
  assert.deepEqual(snapshot.unpriced, []);
  assert.equal(snapshot.block, 1_000n);
  assert.equal(snapshot.portfolioId, 5);
});

test('沒有 usdt_pool 的資產進 unpriced 並帶 amountWei 與 reason，不被丟掉', async () => {
  const chain = baseChain();
  chain.balances.set(NOPOOL.toLowerCase(), 7n * 10n ** 18n);
  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(NOPOOL, 'TSLAB', null)],
    priceToken: oneDollarPrice(),
  });

  assert.deepEqual(snapshot.holdings, []);
  assert.equal(snapshot.unpriced.length, 1);
  assert.deepEqual(snapshot.unpriced[0], {
    asset: NOPOOL.toLowerCase(),
    symbol: 'TSLAB',
    amountWei: 7n * 10n ** 18n,
    decimals: 18,
    reason: 'no_usdt_pool',
  });
});

test('0 餘額不進 holdings，也不去問價格（沒持有的資產不需要知道它的價格）', async () => {
  const chain = baseChain();
  const priced: string[] = [];
  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(AAA, 'AAA', POOL_AAA)],
    priceToken: oneDollarPrice(priced),
  });

  assert.deepEqual(snapshot.holdings, []);
  assert.deepEqual(snapshot.unpriced, []);
  assert.deepEqual(priced, []);
});

test('有池但報價失敗的持倉 → unpriced 帶 pricing_failed:<code>，不是 0 也不是丟掉', async () => {
  const chain = baseChain();
  chain.balances.set(AAA.toLowerCase(), 3n * 10n ** 18n);
  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(AAA, 'AAA', POOL_AAA), token(USDT, 'USDT', null, true)],
    priceToken: async () => {
      throw new PricingError('TWAP_UNAVAILABLE', 'observe revert');
    },
  });

  assert.deepEqual(snapshot.holdings, []);
  assert.equal(snapshot.unpriced[0]?.reason, 'pricing_failed:TWAP_UNAVAILABLE');
  assert.equal(snapshot.unpriced[0]?.amountWei, 3n * 10n ** 18n);
});

test('有池且報價成功的持倉進 holdings，asset 是小寫地址', async () => {
  const chain = baseChain();
  chain.balances.set(AAA.toLowerCase(), 3n * 10n ** 18n);
  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(AAA, 'AAA', POOL_AAA), token(USDT, 'USDT', null, true)],
    priceToken: oneDollarPrice(),
  });

  assert.deepEqual(snapshot.holdings, [
    {
      asset: AAA.toLowerCase(),
      amountWei: 3n * 10n ** 18n,
      decimals: 18,
      usdPriceE8: ONE_USD,
      priceSource: 'pancakeswap-v3',
    },
  ]);
  assert.deepEqual(snapshot.unpriced, []);
});

test('報價收到 numeraire 地址與快照的 blockNumber（分母與塊高都不從池子反推）', async () => {
  const chain = baseChain();
  chain.balances.set(AAA.toLowerCase(), 3n * 10n ** 18n);
  const seen: { token: string; expectedQuoteToken: string; blockNumber: bigint }[] = [];
  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(AAA, 'AAA', POOL_AAA), token(USDT, 'USDT', null, true)],
    priceToken: async (_client, args) => {
      seen.push({
        token: args.token.toLowerCase(),
        expectedQuoteToken: args.expectedQuoteToken.toLowerCase(),
        blockNumber: args.blockNumber,
      });
      return { priceE8: ONE_USD, decimals: 18 };
    },
  });

  // 分母必須是 priceable_assets 的 numeraire，而不是「池子的另一邊」。
  assert.deepEqual(seen, [{ token: AAA.toLowerCase(), expectedQuoteToken: USDT.toLowerCase(), blockNumber: 1_000n }]);
  // 價格讀的是快照標記的那個塊，不是 head。
  assert.equal(snapshot.block, 1_000n);
  assert.equal(snapshot.holdings.length, 1);
});

test('要報價卻沒有 numeraire 的列 → 拋錯，不用池子的另一邊猜分母', async () => {
  const chain = baseChain();
  chain.balances.set(AAA.toLowerCase(), 3n * 10n ** 18n);
  await assert.rejects(
    () =>
      readPositions(stubClient(chain), {
        portfolioId: 5,
        account: ACCOUNT,
        tokens: [token(AAA, 'AAA', POOL_AAA)],
        priceToken: oneDollarPrice(),
      }),
    /沒有任何 is_numeraire 的列/,
  );
});

test('兩個 numeraire → 拋錯：分母不能取決於列的順序', async () => {
  const chain = baseChain();
  chain.balances.set(AAA.toLowerCase(), 3n * 10n ** 18n);
  await assert.rejects(
    () =>
      readPositions(stubClient(chain), {
        portfolioId: 5,
        account: ACCOUNT,
        tokens: [token(AAA, 'AAA', POOL_AAA), token(USDT, 'USDT', null, true), token(WBNB, 'WBNB', null, true)],
        priceToken: oneDollarPrice(),
      }),
    /有兩個 numeraire/,
  );
});

test('numeraire（USDT）以 1e8 定價，報價函式一次都沒被呼叫', async () => {
  const chain = baseChain();
  // 1,000 USDT：如果它走「無池 → unpriced」，這一筆就會擋下整份漂移（修 A 要解掉的死角）。
  chain.balances.set(USDT.toLowerCase(), 1_000n * 10n ** 18n);
  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(USDT, 'USDT', null, true)],
    // 這個 stub 一被呼叫就拋：numeraire 的價格是定義，不該有任何一次 RPC 報價。
    priceToken: async () => {
      throw new Error('numeraire 不該呼叫 twapPriceInUsdt');
    },
  });

  assert.deepEqual(snapshot.holdings, [
    {
      asset: USDT.toLowerCase(),
      amountWei: 1_000n * 10n ** 18n,
      decimals: 18,
      usdPriceE8: ONE_USD,
      priceSource: 'numeraire',
    },
  ]);
  assert.deepEqual(snapshot.unpriced, [], '持有 USDT 不該再被列成無價');
});

test('numeraire 與有池資產並存：只有有池的那一顆被報價（呼叫清單逐字比對）', async () => {
  const chain = baseChain();
  chain.balances.set(WBNB.toLowerCase(), 2n * 10n ** 18n);
  chain.balances.set(USDT.toLowerCase(), 5n * 10n ** 18n);
  const priced: string[] = [];
  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(WBNB, 'WBNB', WBNB_USDT_POOL), token(USDT, 'USDT', null, true)],
    priceToken: oneDollarPrice(priced),
  });

  assert.deepEqual(priced, [WBNB.toLowerCase()], '只有 WBNB 該走 TWAP，USDT 一次都不該被呼叫');
  assert.deepEqual(
    snapshot.holdings.map((holding) => [holding.asset, holding.priceSource]),
    [
      [WBNB.toLowerCase(), 'pancakeswap-v3'],
      [USDT.toLowerCase(), 'numeraire'],
    ],
  );
});

test('balanceOf 讀不到時拋錯：不要讓一個填錯的資產列看起來像空倉', async () => {
  const chain = baseChain();
  chain.broken.add(AAA.toLowerCase());
  await assert.rejects(
    () =>
      readPositions(stubClient(chain), {
        portfolioId: 5,
        account: ACCOUNT,
        tokens: [token(AAA, 'AAA', POOL_AAA)],
        priceToken: oneDollarPrice(),
      }),
    /讀不到 AAA（0x00000000000000000000000000000000000000aa）/,
  );
});

test('重複的資產直接拋錯：同一筆錢會被算兩次', async () => {
  const chain = baseChain();
  await assert.rejects(
    () =>
      readPositions(stubClient(chain), {
        portfolioId: 5,
        account: ACCOUNT,
        tokens: [token(AAA, 'AAA', POOL_AAA), token(AAA, 'AAA2', POOL_AAA)],
        priceToken: oneDollarPrice(),
      }),
    /重複的資產/,
  );
});

// ---------------------------------------------------------------------------
// Multicall3：一次 aggregate3 取代 N 次 eth_call
// ---------------------------------------------------------------------------

test('readPositions 用一次 aggregate3 讀完所有資產的 balanceOf 與 decimals（2N 筆內層、1 次 eth_call）', async () => {
  const chain = baseChain();
  chain.balances.set(AAA.toLowerCase(), 3n * 10n ** 18n);
  chain.balances.set(USDT.toLowerCase(), 500n * 10n ** 18n);
  chain.decimals.set(AAA.toLowerCase(), 6);

  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(AAA, 'AAA', POOL_AAA), token(USDT, 'USDT', null, true)],
    priceToken: oneDollarPrice(),
  });

  // 一批、2 顆 × 2 項、打去標準地址、釘在快照的塊上。
  assert.deepEqual(chain.batches, [
    {
      target: MULTICALL3_ADDRESS.toLowerCase(),
      targets: [AAA.toLowerCase(), AAA.toLowerCase(), USDT.toLowerCase(), USDT.toLowerCase()],
      blockNumber: 1_000n,
    },
  ]);
  // 沒有任何「逐顆」的 balanceOf/decimals eth_call：那正是這一步省掉的 2N 次往返。
  assert.deepEqual(
    chain.calls.filter((call) => call.functionName === 'balanceOf' || call.functionName === 'decimals'),
    [],
    '資產餘額不該再走逐顆 eth_call',
  );
  assert.deepEqual(
    snapshot.holdings.map((holding) => [holding.asset, holding.amountWei, holding.decimals]),
    [
      [AAA.toLowerCase(), 3n * 10n ** 18n, 6],
      [USDT.toLowerCase(), 500n * 10n ** 18n, 18],
    ],
    'decimals 也必須從同一批回傳解出來（6 ≠ 預設 18 才驗得到這件事）',
  );

  console.log(
    `[multicall] 批次=${chain.batches.length} 內層=${chain.batches[0]?.targets.length} 筆 ` +
      `target=${chain.batches[0]?.target} block=${chain.batches[0]?.blockNumber} ` +
      `逐顆 eth_call=${chain.calls.filter((call) => call.functionName === 'balanceOf').length}`,
  );
});

test('aggregate3 單項失敗（allowFailure）→ 錯誤指名到那顆代幣，整批沒有被 revert', async () => {
  const chain = baseChain();
  chain.broken.add(BBB.toLowerCase());
  chain.balances.set(AAA.toLowerCase(), 1n * 10n ** 18n);

  const error = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(AAA, 'AAA', POOL_AAA), token(BBB, 'BBB', POOL_BBB), token(USDT, 'USDT', null, true)],
    priceToken: oneDollarPrice(),
  }).then(
    () => null,
    (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
  );

  assert.ok(error !== null, '讀不到就該拋錯，不吞成 0');
  // 指名到地址：不是「有一顆讀不到」這種查不下去的訊息。
  assert.match(error.message, /讀不到 BBB（0x00000000000000000000000000000000000000bb）/);
  assert.match(error.message, /balanceOf\/decimals/);
  // 3 顆 × 2 項全部送進批次：單項失敗沒有讓整批消失（那正是 allowFailure 的用處）。
  assert.equal(chain.batches[0]?.targets.length, 6);

  console.log(`[multicall 失敗] 訊息=${error.message}；批次仍然送了 ${chain.batches[0]?.targets.length} 筆`);
});

test('沒有合約的地址（success: true 但回 0x）→ 仍然指名到地址，不會變成一句 Cannot decode', async () => {
  const chain = baseChain();
  // 真鏈實測：`aggregate3` 對 0x…0001 這種沒有任何 code 的地址回 `success: true` + `returnData: 0x`，
  // 因為 CALL 到空地址本身不會 revert。漏掉這一種，錯誤就只剩 viem 的
  // 「Cannot decode zero data ("0x")」——查不出是哪一顆資產填錯了。
  chain.emptyReturn.add(NOPOOL.toLowerCase());

  const error = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(NOPOOL, 'TSLAB', null)],
    priceToken: oneDollarPrice(),
  }).then(
    () => null,
    (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
  );

  assert.ok(error !== null, '沒有合約的資產必須拋錯，不能當成空倉');
  assert.match(error.message, /讀不到 TSLAB（0x00000000000000000000000000000000000000cc）/);
  assert.doesNotMatch(error.message, /Cannot decode zero data/, '原始解碼錯誤不可以是唯一線索');
});

test('Multicall3 地址可注入（預設標準地址，測試與非標準鏈可以換掉）', async () => {
  const chain = baseChain();
  chain.balances.set(AAA.toLowerCase(), 1n * 10n ** 18n);
  const custom = '0x00000000000000000000000000000000000000dd' as Address;

  await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    tokens: [token(AAA, 'AAA', POOL_AAA), token(USDT, 'USDT', null, true)],
    priceToken: oneDollarPrice(),
    multicall3: custom,
  });

  assert.equal(chain.batches[0]?.target, custom.toLowerCase());
  assert.notEqual(custom.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase());
});

test('策略資產裡沒有 numeraire → 報價分母仍從查價表（quoteTable）來，不從策略資產清單猜', async () => {
  const chain = baseChain();
  chain.balances.set(AAA.toLowerCase(), 3n * 10n ** 18n);
  const quotients: string[] = [];

  const snapshot = await readPositions(stubClient(chain), {
    portfolioId: 5,
    account: ACCOUNT,
    // 這個策略只有 AAA：沒有 USDT，但報價的分母仍然是 USDT。
    tokens: [token(AAA, 'AAA', POOL_AAA)],
    quoteTable: [token(AAA, 'AAA', POOL_AAA), token(USDT, 'USDT', null, true)],
    priceToken: async (_client, args) => {
      quotients.push(args.expectedQuoteToken.toLowerCase());
      return { priceE8: ONE_USD, decimals: 18 };
    },
  });

  assert.deepEqual(quotients, [USDT.toLowerCase()]);
  assert.equal(snapshot.holdings.length, 1);
});

// ---------------------------------------------------------------------------
// planPortfolio：DB + 鏈的 stub
// ---------------------------------------------------------------------------

type FakeDb = {
  /** 小寫策略 id（字串）→ { version → allocation }。 */
  versions: Map<string, Map<number, unknown>>;
  portfolio: { portfolio_id: string; strategy_id: string; onchain_id: string | null; address: string } | null;
  tokens: { address: string; symbol: string; usdt_pool: string | null; is_numeraire: boolean }[];
  calls: { text: string; params?: readonly unknown[] }[];
};

function fakeQuery(db: FakeDb): QueryFn {
  return async (text, params) => {
    db.calls.push({ text, params });
    if (text.includes('from portfolios')) {
      return { rows: db.portfolio === null ? [] : [db.portfolio] };
    }
    if (text.includes('from strategy_versions')) {
      const [strategyId, version] = params ?? [];
      const allocation = db.versions.get(String(strategyId))?.get(Number(version));
      return { rows: allocation === undefined ? [] : [{ allocation }] };
    }
    if (text.includes('from priceable_assets')) {
      return { rows: db.tokens };
    }
    // 持有掃描的游標：沒有既有的列（第一輪），寫入就照 `on conflict` 收下。
    if (text.includes('from portfolio_scan_cursors')) return { rows: [] };
    if (text.includes('insert into portfolio_scan_cursors')) return { rows: [] };
    throw new Error(`fake query 不認得這段 SQL：${text.slice(0, 40)}`);
  };
}

function baseDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    portfolio: { portfolio_id: '5', strategy_id: '11', onchain_id: '1', address: ACCOUNT },
    versions: new Map([
      [
        '11',
        new Map<number, unknown>([
          [
            1,
            {
              assets: [
                { address: AAA, symbol: 'AAA', weightBps: 6000 },
                { address: BBB, symbol: 'BBB', weightBps: 4000 },
              ],
            },
          ],
          [
            2,
            {
              assets: [
                { address: AAA, symbol: 'AAA', weightBps: 1000 },
                { address: BBB, symbol: 'BBB', weightBps: 9000 },
              ],
            },
          ],
        ]),
      ],
    ]),
    tokens: [
      { address: AAA.toLowerCase(), symbol: 'AAA', usdt_pool: POOL_AAA.toLowerCase(), is_numeraire: false },
      { address: BBB.toLowerCase(), symbol: 'BBB', usdt_pool: POOL_BBB.toLowerCase(), is_numeraire: false },
    ],
    calls: [],
    ...overrides,
  };
}

function planDeps(chain: StubChain, db: FakeDb, priceToken = oneDollarPrice()) {
  return {
    publicClient: stubClient(chain),
    registryAddress: '0x00000000000000000000000000000000000000ff' as Address,
    chainId: 56,
    query: fakeQuery(db),
    priceToken,
  };
}

test('目標權重用鏈上 enrollment.version，不是 active version', async () => {
  // 鏈上：enrollment 釘在 v1，但 v2 已經發佈（active = 2）。DB 兩版都有。
  // 用錯版本的話 targets 會是 v2 的 1000/9000——那個報告看起來仍然「合理」。
  const chain = baseChain({
    enrollment: [1n, 1, false],
    versions: new Map([
      [1, { assets: [AAA, BBB], weightsBps: [6000, 4000] }],
      [2, { assets: [AAA, BBB], weightsBps: [1000, 9000] }],
    ]),
  });
  const db = baseDb();
  const plan = await planPortfolio(5, planDeps(chain, db));

  assert.equal(plan.pinnedVersion.version, 1);
  assert.deepEqual(
    plan.targets.map((target) => [target.asset, target.weightBps]),
    [
      [AAA.toLowerCase(), 6000],
      [BBB.toLowerCase(), 4000],
    ],
  );
  // 查 DB 用的版本號也必須是 1：這兩件事任一錯了，漂移就整個歪掉。
  const allocationCall = db.calls.find((call) => call.text.includes('from strategy_versions'));
  assert.deepEqual(allocationCall?.params, [11, 1]);
  assert.equal(plan.allocationCheck.consistent, true);
  assert.ok(plan.report !== null);
  assert.equal(plan.report.totalUsdE8, 0n);
  // 空倉的定義值：不是「已對齊」，而是「完全不在目標上」。
  assert.equal(plan.report.grossDriftBps, 5000);
  assert.equal(plan.report.needsRebalance, true);
});

test('enrollment.version 是 0 就拋錯：version(0) 會解析成 active version，那是同一個錯誤的另一個入口', async () => {
  const chain = baseChain({ enrollment: [1n, 0, false] });
  await assert.rejects(() => planPortfolio(5, planDeps(chain, baseDb())), /enrollment\.version 是 0/);
});

test('鏈上 enroll 的策略與 DB 的 onchain_id 不同 → 拋錯，不猜哪一邊才對', async () => {
  const chain = baseChain({ enrollment: [7n, 1, false] });
  await assert.rejects(() => planPortfolio(5, planDeps(chain, baseDb())), /鏈上 enroll 的是 strategy 7/);
});

test('DB 的 allocation 與鏈上 registry.version() 不同 → 拒算漂移（ALLOCATION_MISMATCH）', async () => {
  const chain = baseChain({
    versions: new Map([[1, { assets: [AAA, BBB], weightsBps: [5000, 5000] }]]),
  });
  const plan = await planPortfolio(5, planDeps(chain, baseDb()));

  assert.equal(plan.allocationCheck.consistent, false);
  assert.equal(plan.report, null);
  assert.deepEqual(
    plan.blocked.map((blocked) => blocked.code),
    ['ALLOCATION_MISMATCH'],
  );
  assert.match(plan.blocked[0]?.detail ?? '', /第 0 筆不同/);
});

test('策略資產無價（查價表有它、但沒有池）→ 拒算漂移（設計 (a)），並講清楚是哪一個資產、為什麼', async () => {
  // 這條是**不能放寬**的那一條：策略成分之一沒有價格來源 → 我們算不出權重。
  // 它與「策略外代幣沒有價」是兩件事：後者賣不掉、不進分母，不該擋（見下一條與 snapshot.scan.test.ts）。
  const chain = baseChain({
    versions: new Map([[1, { assets: [AAA, NOPOOL], weightsBps: [5_000, 5_000] }]]),
  });
  chain.balances.set(NOPOOL.toLowerCase(), 2n * 10n ** 18n);
  const db = baseDb({
    versions: new Map<string, Map<number, unknown>>([
      [
        '11',
        new Map<number, unknown>([
          [
            1,
            {
              assets: [
                { address: AAA, symbol: 'AAA', weightBps: 5_000 },
                { address: NOPOOL, symbol: 'NOPOOL', weightBps: 5_000 },
              ],
            },
          ],
        ]),
      ],
    ]),
    tokens: [...baseDb().tokens, { address: NOPOOL.toLowerCase(), symbol: 'NOPOOL', usdt_pool: null, is_numeraire: false }],
  });
  const plan = await planPortfolio(5, planDeps(chain, db));

  assert.equal(plan.report, null, '策略資產無價 → 沒有漂移可算');
  assert.deepEqual(
    plan.blocked.map((blocked) => blocked.code),
    ['UNPRICED_HOLDINGS'],
  );
  assert.match(plan.blocked[0]?.detail ?? '', /NOPOOL no_usdt_pool/);
  // 目標權重照樣算出來（那是 DB + 鏈的事，跟持倉無關），只是漂移不出數字。
  assert.equal(plan.targets.length, 2);
  console.log(`[策略資產無價] blocked=${JSON.stringify(plan.blocked.map((b) => [b.code, b.detail]))}`);
});

test('策略資產不在查價表裡（例如剛上架還沒 INSERT）→ 照讀餘額，持有時擋下漂移', async () => {
  const chain = baseChain();
  chain.balances.set(BBB.toLowerCase(), 4n * 10n ** 18n);
  const db = baseDb({
    tokens: [{ address: AAA.toLowerCase(), symbol: 'AAA', usdt_pool: POOL_AAA.toLowerCase(), is_numeraire: false }],
  });
  const plan = await planPortfolio(5, planDeps(chain, db));

  // BBB 只在 version.assets 裡出現，查價表沒有它；它持有 4 顆、沒有池 → 必須被看見並擋下漂移。
  const asset = plan.snapshot.unpriced.find((entry) => entry.asset === BBB.toLowerCase());
  assert.ok(asset, 'BBB 不在 unpriced：目標資產的餘額被漏讀了');
  assert.equal(asset.amountWei, 4n * 10n ** 18n);
  assert.equal(asset.symbol, 'BBB');
  assert.equal(plan.report, null);
});

test('portfolio 5 的形狀：USDT 是 numeraire、WBNB 有池 → 持有時漂移算得出來，不再被 UNPRICED_HOLDINGS 擋', async () => {
  // 目標就是 WBNB 5000 / USDT 5000，帳戶各持有一些。修 A 之前這兩個都是「目標但無價」：
  // 一持有就整份拒算，索引器對唯一存在的策略完全失效。
  const chain = baseChain({
    enrollment: [1n, 1, false],
    versions: new Map([[1, { assets: [WBNB, USDT], weightsBps: [5000, 5000] }]]),
  });
  chain.balances.set(WBNB.toLowerCase(), 1n * 10n ** 18n);
  chain.balances.set(USDT.toLowerCase(), 500n * 10n ** 18n);
  const db = baseDb({
    versions: new Map<string, Map<number, unknown>>([
      [
        '11',
        new Map<number, unknown>([
          [
            1,
            {
              assets: [
                { address: WBNB, symbol: 'WBNB', weightBps: 5000 },
                { address: USDT, symbol: 'USDT', weightBps: 5000 },
              ],
            },
          ],
        ]),
      ],
    ]),
    tokens: [
      { address: USDT.toLowerCase(), symbol: 'USDT', usdt_pool: null, is_numeraire: true },
      { address: WBNB.toLowerCase(), symbol: 'WBNB', usdt_pool: WBNB_USDT_POOL.toLowerCase(), is_numeraire: false },
    ],
  });
  const priced: string[] = [];
  const plan = await planPortfolio(5, planDeps(chain, db, oneDollarPrice(priced)));

  assert.deepEqual(plan.blocked, [], '持有 WBNB/USDT 不該再拒算漂移');
  assert.ok(plan.report !== null);
  assert.deepEqual(priced, [WBNB.toLowerCase()], 'USDT 是 numeraire，不該被報價');
  const usdt = plan.snapshot.holdings.find((holding) => holding.asset === USDT.toLowerCase());
  assert.equal(usdt?.usdPriceE8, ONE_USD);
  assert.equal(usdt?.priceSource, 'numeraire');
  // 1 顆 WBNB（$1）+ 500 顆 USDT（$500）＝ 501 USDT；USDT 幾乎占滿 → 大幅超配。
  assert.equal(plan.report.totalUsdE8, 501n * ONE_USD);
  assert.equal(plan.report.grossDriftBps, 4980);
  assert.equal(plan.report.maxAbsDeltaBps, 4980);
  assert.equal(plan.report.needsRebalance, true);
});

test('planPortfolio: registry 與持倉的每一次 eth_call 都釘在同一個 block，定價也拿到同一個塊', async () => {
  const chain = baseChain();
  chain.balances.set(AAA.toLowerCase(), 3n * 10n ** 18n);
  const db = baseDb({
    tokens: [
      ...baseDb().tokens,
      { address: USDT.toLowerCase(), symbol: 'USDT', usdt_pool: null, is_numeraire: true },
    ],
  });
  const pricedBlocks: bigint[] = [];
  const plan = await planPortfolio(
    5,
    planDeps(chain, db, async (_client, args) => {
      pricedBlocks.push(args.blockNumber);
      return { priceE8: ONE_USD, decimals: 18 };
    }),
  );

  // enrollments / version / getBalance / balanceOf / decimals 全部都要帶塊號：
  // 少一支，那一支讀到的就是 head，而快照標記的是另一個塊。
  // Multicall3 把 N 顆 × 2 收成 1 次 eth_call，所以次數比「逐顆讀」少：現在是
  // getBalance + aggregate3 + enrollments + version 這幾種。重點不是次數而是每一種都釘在同一個塊。
  assert.ok(chain.calls.length >= 4, `eth_call 只有 ${chain.calls.length} 次：這個測試沒驗到東西`);
  for (const call of chain.calls) {
    assert.equal(call.blockNumber, chain.blockNumber, `${call.functionName}(${call.address}) 沒帶塊號或帶錯塊號`);
  }
  assert.deepEqual(pricedBlocks, [chain.blockNumber], '定價沒有釘在快照的塊上');
  assert.equal(plan.snapshot.block, chain.blockNumber);
  // 持有掃描是同一份觀測的另一半：它的 head 就是這個塊，getLogs 的上界也是這個塊。
  // 兩邊不同塊的話，一筆在 N+1 進來的代幣會被算成「未知持倉」而餘額讀的是 N（或整筆漏掉）。
  assert.equal(plan.scan.block, plan.snapshot.block, '掃描的 head 與持倉的 block 必須是同一個值');
  assert.deepEqual(
    chain.logCalls.map((call) => call.toBlock),
    [chain.blockNumber],
    'getLogs 掃到的上界必須是快照的塊',
  );
});

// ---------------------------------------------------------------------------
// writeSnapshot
// ---------------------------------------------------------------------------

type Captured = { text: string; params: readonly unknown[] };

type Summary = { headerInserted?: boolean; inserted?: number; updated?: number };

/**
 * writeSnapshot 的假 DB。
 *
 * 它現在是「一個 statement 同時寫表頭與明細」（表頭是 data-modifying CTE，明細插進去），所以 stub
 * 依 SQL 形狀回答：有 `with header as` 是表頭 + 明細那一句；只有 `insert into portfolio_snapshots`
 * 是空倉的純表頭那一句。其他形狀一律拋錯，免得寫入多發了一句沒人檢查的 SQL。
 */
function captureQuery(captured: Captured[], summary: Summary = {}): QueryFn {
  return async (text, params) => {
    captured.push({ text, params: params ?? [] });
    if (text.includes('with header as')) {
      return {
        rows: [
          {
            header_inserted: summary.headerInserted ?? true,
            inserted: summary.inserted ?? 0,
            updated: summary.updated ?? 0,
          },
        ],
      };
    }
    if (text.includes('insert into portfolio_snapshots')) {
      return { rows: [{ inserted: summary.headerInserted ?? true }] };
    }
    throw new Error(`writeSnapshot 發出了未預期的 SQL：${text.slice(0, 80)}`);
  };
}

test('writeSnapshot：表頭與明細同一句寫入；numeraire 記 numeraire、TWAP 記 pancakeswap-v3、無價列三者全 NULL、0 餘額不寫', async () => {
  const captured: Captured[] = [];
  const snapshot = {
    portfolioId: 5,
    block: 1_000n,
    nativeBalanceWei: 995_807_557_000_000_000n,
    holdings: [
      {
        asset: AAA.toLowerCase(),
        amountWei: 2n * 10n ** 18n,
        decimals: 18,
        usdPriceE8: ONE_USD,
        priceSource: 'pancakeswap-v3' as const,
      },
      {
        asset: USDT.toLowerCase(),
        amountWei: 750n * 10n ** 18n,
        decimals: 18,
        usdPriceE8: ONE_USD,
        priceSource: 'numeraire' as const,
      },
    ],
    unpriced: [
      { asset: NOPOOL.toLowerCase(), symbol: 'TSLAB', amountWei: 5n * 10n ** 18n, decimals: 18, reason: 'no_usdt_pool' },
      { asset: BBB.toLowerCase(), symbol: 'BBB', amountWei: 0n, decimals: 18, reason: 'no_usdt_pool' },
    ],
  };
  const pricedAt = new Date('2026-01-02T03:04:05.000Z');
  const result = await writeSnapshot(snapshot, null, {
    query: captureQuery(captured, { headerInserted: true, inserted: 3, updated: 0 }),
    pricedAt,
    thresholdBps: 150,
    pinnedVersion: 3,
  });

  assert.deepEqual(result, { headerInserted: true, inserted: 3, updated: 0 });
  assert.equal(captured.length, 1, '表頭與明細必須是同一個 statement（同一個交易）');
  const insert = captured[0];
  assert.ok(insert);
  assert.match(insert.text, /with header as/);
  assert.match(insert.text, /on conflict \(portfolio_id, block, phase\) do update/);
  assert.match(insert.text, /on conflict \(portfolio_id, asset, block, phase\) do update/);

  // $1..$13 是表頭。拒算（report = null）→ complete = false，漂移欄位一律 0（0008 的 CHECK 綁住）。
  assert.deepEqual(insert.params.slice(0, 13), [
    '5',
    '1000',
    '995807557000000000',
    // 2 + 750 = 752 USDT，E8 定點。
    '75200000000',
    0,
    0,
    150,
    false,
    false,
    // 只有「持有但無價」的 TSLAB 算 blocker；BBB 是 0 餘額，不算。
    1,
    3,
    // 沒帶 scan（這個呼叫端沒有掃描）：不宣稱看過任何宇宙外代幣，也不宣稱宇宙完整。
    0,
    false,
  ]);

  // 明細：3 列 × 5 欄，接在表頭後面（$1 的 portfolio_id 與 $14 的 phase 由表頭共用）。
  assert.equal(insert.params.length, 15 + 3 * 5);  // 表頭 15（含 phase/operation_id）＋ 3 列 × 5 欄
  assert.deepEqual(insert.params.slice(15, 20), [
    AAA.toLowerCase(),
    '2.000000000000000000',
    '2.000000000000000000',
    'pancakeswap-v3',
    pricedAt,
  ]);
  assert.deepEqual(insert.params.slice(20, 25), [
    USDT.toLowerCase(),
    '750.000000000000000000',
    '750.000000000000000000',
    'numeraire',
    pricedAt,
  ]);
  // 每列 5 欄（block 與 phase 由表頭共用），所以第三列從索引 25 開始。
  assert.deepEqual(insert.params.slice(25), [NOPOOL.toLowerCase(), '5.000000000000000000', null, null, null]);
});

test('writeSnapshot：空倉 → 寫 1 列表頭、0 列明細（這就是「跑過且是空的」的證據）', async () => {
  const captured: Captured[] = [];
  const report = {
    totalUsdE8: 0n,
    assets: [],
    maxAbsDeltaBps: 5_000,
    grossDriftBps: 5_000,
    needsRebalance: true,
    thresholdBps: 100,
  };
  const result = await writeSnapshot(
    { portfolioId: 5, block: 1_000n, nativeBalanceWei: 1_000_000_000_000_000_000n, holdings: [], unpriced: [] },
    report,
    { query: captureQuery(captured), pinnedVersion: 1 },
  );

  assert.deepEqual(result, { headerInserted: true, inserted: 0, updated: 0 });
  assert.equal(captured.length, 1);
  const insert = captured[0];
  assert.ok(insert);
  assert.doesNotMatch(insert.text, /positions_snapshots/, '空倉不該寫任何明細列');
  assert.match(insert.text, /on conflict \(portfolio_id, block, phase\) do update/);
  assert.deepEqual(insert.params, [
    '5',
    '1000',
    '1000000000000000000',
    '0',
    5000,
    5000,
    100,
    true,
    true,
    0,
    1,
    // 沒帶 scan：unknown_token_count = 0、universe_complete = false（沒掃描不宣稱宇宙完整）。
    0,
    false,
    // 沒帶 phase / operationId：預設 manual（CLI 手動 index）、沒有對應的 operation。
    'manual',
    null,
  ]);
});

test('writeSnapshot：快照能重算的總額與報告的 totalUsdE8 不同就拒絕寫入', async () => {
  const captured: Captured[] = [];
  const snapshot = {
    portfolioId: 5,
    block: 1_000n,
    nativeBalanceWei: 1n,
    holdings: [
      {
        asset: AAA.toLowerCase(),
        amountWei: 2n * 10n ** 18n,
        decimals: 18,
        usdPriceE8: ONE_USD,
        priceSource: 'pancakeswap-v3' as const,
      },
    ],
    unpriced: [],
  };
  const report = {
    totalUsdE8: 999n,
    assets: [],
    maxAbsDeltaBps: 0,
    grossDriftBps: 0,
    needsRebalance: false,
    thresholdBps: 100,
  };
  await assert.rejects(() => writeSnapshot(snapshot, report, { query: captureQuery(captured) }), /拒絕寫入掩蓋它/);
  assert.equal(captured.length, 0, '驗不過就不該發出任何 SQL');
});

test('writeSnapshot：同一個 block 第二次寫是 UPDATE（表頭與明細都是），不新增列', async () => {
  const captured: Captured[] = [];
  const snapshot = {
    portfolioId: 5,
    block: 1_000n,
    nativeBalanceWei: 1n,
    holdings: [
      {
        asset: AAA.toLowerCase(),
        amountWei: 2n * 10n ** 18n,
        decimals: 18,
        usdPriceE8: ONE_USD,
        priceSource: 'pancakeswap-v3' as const,
      },
    ],
    unpriced: [],
  };
  const first = await writeSnapshot(snapshot, null, {
    query: captureQuery(captured, { headerInserted: true, inserted: 1, updated: 0 }),
  });
  const second = await writeSnapshot(snapshot, null, {
    query: captureQuery(captured, { headerInserted: false, inserted: 0, updated: 1 }),
  });

  assert.deepEqual(first, { headerInserted: true, inserted: 1, updated: 0 });
  assert.deepEqual(second, { headerInserted: false, inserted: 0, updated: 1 });
  assert.match(captured[1]?.text ?? '', /on conflict \(portfolio_id, block, phase\) do update/);
});
