import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionResult } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { planPortfolio, writeSnapshot } from '../src/snapshot.js';
import type { QueryFn } from '../src/snapshot.js';
import type { PriceTokenFn } from '../src/positions.js';

/**
 * `snapshot.ts` × `holdings-scan.ts` 的接線：鏈與 DB 都是 stub。
 *
 * 這支檔案釘住三件「接錯線就會靜默出錯」的事：
 *
 * ① **掃描的 `head` 與 `readPositions` 的 `block` 是同一個值。** 兩份觀測不同步（餘額 block N、
 *    日誌掃到 N+5）時，一筆在 N+1 進來的代幣會被算成「未知持倉」而餘額讀的是 N；反過來整筆漏掉。
 *    這裡傳一個 `block` 給 `planPortfolio`，然後斷言每一次 `eth_call` 與 `eth_getLogs` 都用了它，
 *    而且兩邊都沒有自己去讀 head。
 *
 * ② **策略外持倉（空投）不阻擋漂移，只被記錄。** 執行器只換得動 `version.assets` 裡的代幣
 *    （`AtpExecutor.sol:180-182`），策略外的代幣賣不掉 → 不可能參與再平衡 → 不在漂移的分母裡。
 *    它仍然被掃描、仍然寫進表頭 `unknown_token_count`（運維訊號），但 `complete` 只看
 *    「策略資產是否都有價」。游標沒覆蓋到部署塊同樣**不 blocked**（「還不知道」不是「知道有問題」）。
 *
 * ③ **策略外持倉不進 `unpriced`，也不進 `holdings`。** 它沒有 decimals、不是策略資產，
 *    寫進明細列只會是語意不明的資料；它走表頭 `unknown_token_count`。
 *
 * ④ **讀取與定價的宇宙 == `version.assets`。** 查價表上其他 enabled 的資產一次都不該被讀
 *    ——那正是「被空投／被多買一顆就停止再平衡」的來源。
 *
 * 為什麼不用真鏈：這幾條要驗的是「兩個觀測用了哪個塊」「哪一種不完整該不該 blocked」，用真鏈驗不到
 * 邊界（要製造 403、要讓部署塊剛好落在游標後面都很難）。真鏈的驗證在 `snapshot.integration.test.ts`。
 */

const TRANSFER_TOPIC: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ACCOUNT = '0x2b082fadf8f3d620eaa242a9e36817af8640d042' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const REGISTRY = '0x27739a1ad35a924f5545c7d04c2b0537069ca76c' as Address;
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' as Address;
/** 查價表與 version.assets 都不含它：轉進來的空投就是這個樣子。 */
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' as Address;

const PORTFOLIO_ID = 5;
const CHAIN_ID = 56;
const ONCHAIN_STRATEGY_ID = 1;
const PINNED_VERSION = 1;
const THRESHOLD_BPS = 100;
/** 這一輪觀測的塊：刻意不是 stub 的 head（見 ①）。 */
const BLOCK = 9_000n;
/** 帳戶的部署塊。游標起點早於它就代表「掃描涵蓋了帳戶的一生」。 */
const DEPLOYMENT = 7_777n;

// ---------------------------------------------------------------------------
// stub 鏈
// ---------------------------------------------------------------------------

type StubLog = { block: bigint; address: Address; topics: Hex[] };

type StubChain = {
  head: bigint;
  /** `getBlockNumber` 被呼叫的次數：`deps.block` 給了就不該有人再讀 head。 */
  headReads: number;
  /** address → 第一個有 bytecode 的塊；缺席 = 永遠沒有 code（EOA／未部署）。 */
  codeFrom: Map<string, bigint>;
  /** `getCode` 被打過的塊（二分搜尋的證據）。 */
  codeProbes: bigint[];
  /** `${token}:${account}` → balanceOf；缺席 = 0。 */
  balances: Map<string, bigint>;
  /** 每一次 Multicall3 批次的 target（依序）與塊高：讀取宇宙的證據。 */
  batches: { targets: string[]; blockNumber?: bigint }[];
  /** `balanceOf` / `decimals` 被問的塊：全部都要等於 BLOCK。 */
  contractBlocks: bigint[];
  logs: StubLog[];
  /** 落在這些範圍的 getLogs 會拋錯（模擬 403 archive／逾時）。 */
  failingRanges: { fromBlock: bigint; toBlock: bigint }[];
  /** 實際發出去的 getLogs 範圍。 */
  logCalls: { fromBlock: bigint; toBlock: bigint }[];
};

function stubChain(overrides: Partial<StubChain> = {}): StubChain {
  return {
    head: 10_000n,
    headReads: 0,
    codeFrom: new Map(),
    codeProbes: [],
    balances: new Map(),
    batches: [],
    contractBlocks: [],
    logs: [],
    failingRanges: [],
    logCalls: [],
    ...overrides,
  };
}

const ERC20_STUB_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;
const DECIMALS_SELECTOR = '0x313ce567';

function addressTopic(address: Address): Hex {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` as Hex;
}

function transferLog(block: bigint, token: Address, to: Address): StubLog {
  return { block, address: token, topics: [TRANSFER_TOPIC, addressTopic(OTHER), addressTopic(to)] };
}

const ENROLLMENTS_ABI_SHAPE = {
  assets: [USDT, WBNB],
  weightsBps: [5_000, 5_000],
  scheduleHash: `0x${'00'.repeat(32)}` as Hex,
  activeAt: 0n,
};

/** 把 stub 包成 viem 的 `PublicClient`：只實作 planPortfolio 這一條路真的會用到的方法。 */
function stubClient(chain: StubChain): PublicClient {
  const client = {
    async getBlockNumber() {
      chain.headReads += 1;
      return chain.head;
    },
    async getCode(args: { address: Address; blockNumber?: bigint }) {
      const at = args.blockNumber ?? chain.head;
      chain.codeProbes.push(at);
      const from = chain.codeFrom.get(args.address.toLowerCase());
      if (from === undefined) return undefined;
      return at >= from ? ('0x60006000' as Hex) : undefined;
    },
    async getBalance() {
      return 10n ** 18n;
    },
    async readContract(args: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) {
      const block = args.blockNumber ?? chain.head;
      chain.contractBlocks.push(block);
      if (args.functionName === 'enrollments') return [BigInt(ONCHAIN_STRATEGY_ID), PINNED_VERSION, false];
      if (args.functionName === 'version') {
        return {
          assets: ENROLLMENTS_ABI_SHAPE.assets,
          weightsBps: ENROLLMENTS_ABI_SHAPE.weightsBps,
          scheduleHash: ENROLLMENTS_ABI_SHAPE.scheduleHash,
          activeAt: ENROLLMENTS_ABI_SHAPE.activeAt,
        };
      }
      const token = args.address.toLowerCase();
      if (args.functionName === 'balanceOf') {
        const account = String(args.args?.[0] ?? '').toLowerCase();
        return chain.balances.get(`${token}:${account}`) ?? 0n;
      }
      if (args.functionName === 'decimals') return 18;
      if (args.functionName === 'aggregate3') {
        // 模擬 Multicall3：逐項解內層 callData，全部成功（這支檔案不驗失敗路徑，那在 positions.test.ts）。
        const calls = (args.args?.[0] ?? []) as { target: Address; allowFailure: boolean; callData: Hex }[];
        chain.batches.push({ targets: calls.map((call) => call.target.toLowerCase()), blockNumber: args.blockNumber });
        return calls.map((call) => {
          if (call.callData.startsWith(DECIMALS_SELECTOR)) {
            return { success: true, returnData: encodeFunctionResult({ abi: ERC20_STUB_ABI, functionName: 'decimals', result: 18 }) };
          }
          // balanceOf(address)：calldata 尾部 20 bytes 就是 owner。
          const account = `0x${call.callData.slice(-40)}`.toLowerCase();
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: ERC20_STUB_ABI,
              functionName: 'balanceOf',
              result: chain.balances.get(`${call.target.toLowerCase()}:${account}`) ?? 0n,
            }),
          };
        });
      }
      throw new Error(`stub 沒預期 readContract(${args.functionName})`);
    },
    async request(args: { method: string; params?: unknown[] }) {
      assert.equal(args.method, 'eth_getLogs', 'stub 只預期 eth_getLogs；其他方法要明說');
      const filter = (args.params?.[0] ?? {}) as { topics?: unknown[]; fromBlock: string; toBlock: string };
      const fromBlock = BigInt(filter.fromBlock);
      const toBlock = BigInt(filter.toBlock);
      chain.logCalls.push({ fromBlock, toBlock });
      // 查詢條件本身就是「只看轉入、不帶 address」的證據（見 holdings-scan 檔頭 ①）。
      assert.deepEqual(filter.topics?.[0], TRANSFER_TOPIC);
      assert.equal(filter.topics?.[1], null, 'topics[1]（from）必須是 null');
      assert.equal(filter.topics?.[2], addressTopic(ACCOUNT), 'topics[2]（to）必須是帳戶');
      for (const range of chain.failingRanges) {
        if (fromBlock <= range.toBlock && toBlock >= range.fromBlock) {
          throw new Error(`模擬 403 Archive requests（getLogs [${fromBlock}, ${toBlock}]）`);
        }
      }
      return chain.logs
        .filter((log) => log.block >= fromBlock && log.block <= toBlock)
        .map((log) => ({ address: log.address, topics: log.topics, blockNumber: `0x${log.block.toString(16)}` }));
    },
  };
  return client as unknown as PublicClient;
}

// ---------------------------------------------------------------------------
// stub DB
// ---------------------------------------------------------------------------

type StubCursor = { startBlock: bigint; lastScannedBlock: bigint };

/** 候選表（0010）的一列。`seed` 進來的列 = 過去某一輪已經發現的宇宙外代幣。 */
type StubCandidate = { firstSeenBlock: bigint; lastBalanceWei: bigint };

type StudioAssetRow = { address: string; symbol: string; usdt_pool: string | null; is_numeraire: boolean };

type StubDb = {
  cursor: StubCursor | null;
  /** 每一次游標寫入（失敗時必須一次都沒有）。 */
  saves: StubCursor[];
  candidates: Map<string, StubCandidate>;
  /** 每一輪被重讀餘額的候選地址（跨輪次的證據）。 */
  candidateReads: string[];
  /**
   * `priceable_assets`（查價表）的內容。**它不再是讀取宇宙**：宇宙是 `version.assets`，
   * 這張表只回答「這個地址的價格怎麼查」。預設刻意**不**含 WBNB 的池（持有時會變無價），
   * 需要 WBNB 有價的測試自己覆寫。
   */
  priceTable: StudioAssetRow[];
};

function stubDb(overrides: Partial<StubDb> = {}): StubDb {
  return {
    cursor: null,
    saves: [],
    candidates: new Map(),
    candidateReads: [],
    priceTable: [
      { address: USDT, symbol: 'USDT', usdt_pool: null, is_numeraire: true },
      { address: WBNB, symbol: 'WBNB', usdt_pool: null, is_numeraire: false },
    ],
    ...overrides,
  };
}

function stubQuery(db: StubDb): QueryFn {
  return async (text: string, params: readonly unknown[] = []) => {
    if (text.includes('insert into portfolio_holding_candidates')) {
      const assets = (params[1] as string[]).map((asset) => asset.toLowerCase());
      const blocks = (params[2] as string[]).map((block) => BigInt(block));
      assets.forEach((asset, index) => {
        if (!db.candidates.has(asset)) db.candidates.set(asset, { firstSeenBlock: blocks[index]!, lastBalanceWei: 0n });
      });
      return { rows: [] };
    }
    if (text.includes('update portfolio_holding_candidates')) {
      const assets = (params[1] as string[]).map((asset) => asset.toLowerCase());
      const balances = (params[2] as string[]).map((balance) => BigInt(balance));
      assets.forEach((asset, index) => {
        const row = db.candidates.get(asset);
        if (row !== undefined) row.lastBalanceWei = balances[index]!;
      });
      return { rows: [] };
    }
    if (text.includes('from portfolio_holding_candidates')) {
      db.candidateReads.push(...[...db.candidates.keys()].sort());
      return {
        rows: [...db.candidates.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([asset, row]) => ({
            asset,
            first_seen_block: row.firstSeenBlock.toString(),
            last_balance_wei: row.lastBalanceWei.toString(),
          })),
      };
    }
    if (text.includes('from portfolios p')) {
      return { rows: [{ portfolio_id: PORTFOLIO_ID, strategy_id: 7, onchain_id: ONCHAIN_STRATEGY_ID, address: ACCOUNT }] };
    }
    if (text.includes('from strategy_versions')) {
      return {
        rows: [
          {
            allocation: {
              assets: [
                { address: USDT, symbol: 'USDT', weightBps: 5_000 },
                { address: WBNB, symbol: 'WBNB', weightBps: 5_000 },
              ],
            },
          },
        ],
      };
    }
    if (text.includes('from priceable_assets')) {
      return { rows: db.priceTable };
    }
    if (text.includes('from portfolio_scan_cursors')) {
      if (db.cursor === null) return { rows: [] };
      return {
        rows: [
          {
            portfolio_id: PORTFOLIO_ID,
            // pg 對 bigint 回字串，stub 照抄那個形狀。
            start_block: db.cursor.startBlock.toString(),
            last_scanned_block: db.cursor.lastScannedBlock.toString(),
          },
        ],
      };
    }
    if (text.includes('insert into portfolio_scan_cursors')) {
      throw new Error('stub 的游標寫入要走 stubQueryWithCursorWrites，不該走到唯讀的這一條');
    }
    throw new Error(`stub DB 沒預期這條 SQL：${text.slice(0, 60)}`);
  };
}

/**
 * 在唯讀的那一層外面攔 `saveCursor`：記下每一次寫入，並照 pg 的 `on conflict` 語意（只前進不後退）
 * 更新記憶體裡的游標。失敗時「一次都沒寫」才驗得到。
 */
function stubQueryWithCursorWrites(db: StubDb): QueryFn {
  const readOnly = stubQuery(db);
  return async (text: string, params?: readonly unknown[]) => {
    if (!text.includes('insert into portfolio_scan_cursors')) return readOnly(text, params);
    const startBlock = BigInt(String(params?.[1]));
    const lastScannedBlock = BigInt(String(params?.[2]));
    db.saves.push({ startBlock, lastScannedBlock });
    db.cursor =
      db.cursor === null
        ? { startBlock, lastScannedBlock }
        : {
            startBlock: db.cursor.startBlock,
            lastScannedBlock: db.cursor.lastScannedBlock > lastScannedBlock ? db.cursor.lastScannedBlock : lastScannedBlock,
          };
    return { rows: [] };
  };
}

function plan(deps: { chain: StubChain; db: StubDb; block?: bigint; priceToken?: PriceTokenFn }) {
  return planPortfolio(PORTFOLIO_ID, {
    publicClient: stubClient(deps.chain),
    query: stubQueryWithCursorWrites(deps.db),
    registryAddress: REGISTRY,
    chainId: CHAIN_ID,
    thresholdBps: THRESHOLD_BPS,
    block: deps.block ?? BLOCK,
    // 有池資產的報價一律走這一個 stub：真 TWAP 在 snapshot.integration.test.ts 驗。
    priceToken: deps.priceToken ?? (async () => ({ priceE8: 100_000_000n, decimals: 18 })),
  });
}

// ---------------------------------------------------------------------------
// ① head 與 block 是同一個塊
// ---------------------------------------------------------------------------

test('掃描的 head 與 readPositions 的 block 是同一個值：兩邊都用呼叫端給的 block，沒有誰自己去讀 head', async () => {
  // 部署塊取得到，所以游標第一次就是 [DEPLOYMENT, HEAD]；stub 的 head 是 10_000（比 BLOCK 大），
  // 任何一邊偷讀 head 都會在下面的斷言裡露出來。
  const chain = stubChain({ codeFrom: new Map([[ACCOUNT.toLowerCase(), DEPLOYMENT]]), logs: [transferLog(8_500n, CAKE, ACCOUNT)] });
  const db = stubDb();
  const result = await plan({ chain, db });

  assert.equal(result.snapshot.block, BLOCK, 'readPositions 必須釘在呼叫端給的塊上');
  assert.equal(result.scan.block, BLOCK, '掃描的 head 必須是同一個塊');
  assert.equal(result.scan.block, result.snapshot.block);

  // 更強的證據：每一次 eth_call（balanceOf/decimals/enrollments/version）與每一次 getLogs 的
  // 上界都是 BLOCK。只比對兩個欄位相等的話，「兩邊都各自讀了 head 剛好相等」也會通過。
  assert.deepEqual([...new Set(chain.contractBlocks)], [BLOCK], '有 eth_call 用了別的塊');
  assert.deepEqual(chain.logCalls, [{ fromBlock: DEPLOYMENT, toBlock: BLOCK }], 'getLogs 的上界必須是 BLOCK');
  assert.equal(chain.headReads, 0, 'deps.block 已經給了，兩邊都不該再讀一次 head');

  console.log(
    `[scan 1] block=${result.snapshot.block} scan.block=${result.scan.block} ` +
      `eth_call 用到的塊=${[...new Set(chain.contractBlocks)].join(',')} ` +
      `getLogs=${chain.logCalls.map((call) => `[${call.fromBlock}, ${call.toBlock}]`).join(' ')}`,
  );
});

// ---------------------------------------------------------------------------
// ② 策略外持倉：記錄，但不阻擋（宇宙本身是完整的）
// ---------------------------------------------------------------------------

test('策略外持倉（空投）→ 不 blocked、drift 照算；unknown_token_count 仍被記錄，complete 不受影響', async () => {
  const chain = stubChain({
    codeFrom: new Map([[ACCOUNT.toLowerCase(), DEPLOYMENT]]),
    logs: [transferLog(8_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE.toLowerCase()}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
  });
  const db = stubDb();
  const result = await plan({ chain, db });

  assert.equal(result.scan.unknownHoldings.length, 1);
  assert.deepEqual(
    result.scan.unknownHoldings.map((holding) => [holding.asset, holding.amountWei, holding.decimals]),
    [[CAKE.toLowerCase(), 10n ** 18n, 18]],
  );

  // 它不是 blocker：執行器換不掉它（AtpExecutor.sol:180-182），所以它不可能參與再平衡，
  // 也就不在漂移的分母裡。把它當成 blocker 會讓一顆空投讓整個投組停止再平衡。
  assert.deepEqual(result.blocked, [], '策略外持倉不該產生任何 blocked');
  assert.ok(result.report !== null, '漂移照算');

  // 宇宙完整性與「策略資產有沒有價」是兩個問題，兩者在這裡都是 true（正是因為看過才發現它）。
  assert.equal(result.scan.universeComplete, true, '掃描涵蓋部署塊而且成功了 → 宇宙是完整的');

  // ③ 策略外持倉不進明細：它不在 holdings，也不在 unpriced（沒有 decimals、不是策略資產）。
  assert.deepEqual(result.snapshot.holdings, []);
  assert.equal(
    result.snapshot.unpriced.some((asset) => asset.asset === CAKE.toLowerCase()),
    false,
    '策略外持倉不可以塞進 unpriced',
  );
  // ④ 讀取宇宙只有 version.assets 的兩顆：批次裡不會出現 CAKE。
  assert.deepEqual(
    [...new Set(chain.batches[0]?.targets ?? [])].sort(),
    [USDT.toLowerCase(), WBNB.toLowerCase()].sort(),
    '讀取宇宙必須等於 version.assets',
  );

  // 表頭：觀測訊號仍然要落地（真的 DB 寫入在 snapshot.integration.test.ts 與實跑）。
  const header = await captureHeaderParams(result, db);
  assert.equal(header.params.length, 15, '表頭參數個數（$1..$15，含 phase 與 operation_id）');
  assert.equal(header.params[8], true, 'complete = true：策略資產都有價');
  assert.equal(header.params[11], 1, 'unknown_token_count = 1：空投仍然被記錄');
  assert.equal(header.params[12], true, 'universe_complete = true');
  assert.match(header.sql, /unknown_token_count/);
  assert.match(header.sql, /universe_complete/);

  console.log(
    `[scan 2] unknown=${result.scan.unknownHoldings.length}（${CAKE}）blocked=${result.blocked.length} ` +
      `gross=${result.report?.grossDriftBps} complete=${header.params[8]} unknown_token_count=${header.params[11]} universe_complete=${header.params[12]}`,
  );
});

// ---------------------------------------------------------------------------
// ④ 游標沒覆蓋到部署塊：universe_complete = false，但**不 blocked**
// ---------------------------------------------------------------------------

test('游標起點晚於部署塊 → universe_complete=false，但不 blocked、漂移照算（「還不知道」不是「知道有問題」）', async () => {
  const chain = stubChain({ codeFrom: new Map([[ACCOUNT.toLowerCase(), DEPLOYMENT]]) });
  // 游標是別人寫的（例如從 head 起掃的那一次）：起點在部署塊之後，那之前的轉入沒被看過。
  const db = stubDb({ cursor: { startBlock: 8_000n, lastScannedBlock: 8_000n } });
  const result = await plan({ chain, db });

  assert.equal(result.scan.deployment.block, DEPLOYMENT, '部署塊本身取得到，缺的是覆蓋範圍');
  assert.equal(result.scan.universeComplete, false);
  assert.match(result.scan.incompleteReasons.join('；'), /晚於部署塊/);

  assert.deepEqual(result.blocked, [], '游標沒覆蓋不是「知道有問題」，不該擋下漂移');
  assert.ok(result.report !== null, '漂移照算，只是建立在一份可能缺項的宇宙上');
  assert.equal(result.scan.unknownHoldings.length, 0);

  const header = await captureHeaderParams(result, db);
  assert.equal(header.params[8], true, 'complete = true：看到的資產都有價');
  assert.equal(header.params[11], 0, 'unknown_token_count = 0');
  assert.equal(header.params[12], false, 'universe_complete = false：這一欄才是「宇宙可能有缺項」');

  // 掃描從游標之後開始，不回填已經掃過的區間。
  assert.deepEqual(chain.logCalls, [{ fromBlock: 8_001n, toBlock: BLOCK }]);

  console.log(
    `[scan 3] cursor=[8000, 8000] deployment=${result.scan.deployment.block} universeComplete=${result.scan.universeComplete} ` +
      `blocked=${result.blocked.length} complete=${header.params[8]} universe_complete=${header.params[12]} ` +
      `原因=${result.scan.incompleteReasons.join('；')}`,
  );
});

// ---------------------------------------------------------------------------
// ⑤ 掃描失敗：universe_complete = false、游標不動、不 blocked
// ---------------------------------------------------------------------------

test('getLogs 失敗 → universe_complete=false、游標一格都不動、不 blocked；漂移照算', async () => {
  const chain = stubChain({
    codeFrom: new Map([[ACCOUNT.toLowerCase(), DEPLOYMENT]]),
    failingRanges: [{ fromBlock: DEPLOYMENT, toBlock: BLOCK }],
  });
  const db = stubDb();
  const result = await plan({ chain, db });

  assert.match(result.scan.incompleteReasons.join('；'), /getLogs/);
  assert.equal(result.scan.universeComplete, false);
  assert.equal(result.scan.scannedRange, null, '一塊都沒掃成功');
  // 游標不前進（連失敗前成功的塊都不算）：下一次多掃一次，總比留一個永遠看不到的洞好。
  assert.equal(result.scan.cursor.lastScannedBlock, DEPLOYMENT - 1n);
  assert.deepEqual(db.saves, [], '失敗時完全不可以寫游標');

  assert.deepEqual(result.blocked, [], '掃描失敗不是「知道有問題」，不該擋下漂移');
  assert.ok(result.report !== null);

  const header = await captureHeaderParams(result, db);
  assert.equal(header.params[8], true, 'complete = true');
  assert.equal(header.params[12], false, 'universe_complete = false');

  console.log(
    `[scan 4] failure=${result.scan.incompleteReasons[0]?.slice(0, 40)}… cursor=${result.scan.cursor.lastScannedBlock} ` +
      `saves=${db.saves.length} blocked=${result.blocked.length} complete=${header.params[8]} universe_complete=${header.params[12]}`,
  );
});

test('已存下來的候選（0010）＋ getLogs 失敗 → 仍然被記錄（不 blocked）：候選重讀與日誌掃描解耦', async () => {
  const chain = stubChain({
    codeFrom: new Map([[ACCOUNT.toLowerCase(), DEPLOYMENT]]),
    failingRanges: [{ fromBlock: DEPLOYMENT, toBlock: BLOCK }],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
  });
  // 過去某一輪已經把 CAKE 記進候選表。這一輪的日誌完全看不到它（而且掃描還失敗）——
  // 若重讀依賴日誌，CAKE 就會在這裡消失，keeper 又開始相信一份漏掉它的宇宙。
  const db = stubDb({ candidates: new Map([[CAKE, { firstSeenBlock: 8_500n, lastBalanceWei: 10n ** 18n }]]) });
  const result = await plan({ chain, db });

  assert.match(result.scan.incompleteReasons.join('；'), /getLogs/);
  assert.equal(result.scan.universeComplete, false, '掃描失敗 → 宇宙完整性未確認');
  assert.deepEqual(db.candidateReads, [CAKE], '候選表被讀了，與掃描成敗無關');
  assert.deepEqual(result.scan.unknownHoldings.map((holding) => holding.asset), [CAKE]);
  assert.deepEqual(result.blocked, [], '策略外持倉不 blocked，即使這一輪的日誌掃描失敗');
  assert.ok(result.report !== null, ' drift 照算');

  const header = await captureHeaderParams(result, db);
  assert.equal(header.params[8], true, 'complete = true：策略資產都有價');
  assert.equal(header.params[11], 1, 'unknown_token_count = 1：重讀的觀測仍然落地');
  assert.equal(header.params[12], false, 'universe_complete = false：掃描失敗');

  console.log(
    `[scan 4b] 候選重讀=${JSON.stringify(db.candidateReads)} 掃描失敗=${result.scan.incompleteReasons.length > 0} ` +
      `blocked=${result.blocked.length} gross=${result.report?.grossDriftBps} ` +
      `complete=${header.params[8]} unknown_token_count=${header.params[11]} universe_complete=${header.params[12]}`,
  );
});

test('部署塊取不到（本機 fork 的常態）→ 游標從 head 起、universe_complete=false、不 blocked', async () => {
  // codeFrom 缺席 = 帳戶在 head 沒有 bytecode 之外一律讀不到 code：findDeploymentBlock 回 block: null。
  const chain = stubChain();
  const db = stubDb();
  const result = await plan({ chain, db });

  assert.equal(result.scan.deployment.block, null);
  assert.match(result.scan.incompleteReasons.join('；'), /部署塊取不到/);
  assert.equal(result.scan.universeComplete, false);
  // 不知道部署塊就從 head 開始掃：假裝掃過創世以來才是真正的錯。
  assert.equal(result.scan.cursor.startBlock, BLOCK);
  assert.deepEqual(result.blocked, []);
  assert.ok(result.report !== null);

  const header = await captureHeaderParams(result, db);
  assert.equal(header.params[12], false);
  console.log(
    `[scan 5] deployment=null cursor=[${result.scan.cursor.startBlock}, ${result.scan.cursor.lastScannedBlock}] ` +
      `universeComplete=${result.scan.universeComplete} blocked=${result.blocked.length}`,
  );
});

// ---------------------------------------------------------------------------
// ⑤ 空投不影響漂移：同樣的策略持倉 ± 一顆雜幣，算出來的數字必須逐位相同
//
// 這是這次語意修正的核心斷言。舊語意下，多一顆空投 → blocked → report = null；
// 新語意下，它連分母都算不上（執行器換不掉它），所以每一個 bps 都不該動。
// ---------------------------------------------------------------------------

const ONE_USD = 100_000_000n;

/** 有價的 WBNB（給它一個 USDT 池）：這個測試要驗的是「空投有沒有改變數字」，所以策略資產要真的有價。 */
const PRICE_TABLE_WITH_POOL = [
  { address: USDT, symbol: 'USDT', usdt_pool: null, is_numeraire: true },
  { address: WBNB, symbol: 'WBNB', usdt_pool: '0x0000000000000000000000000000000000000f01', is_numeraire: false },
];

function strategyHoldingsChain(extra: { logs?: { block: bigint; address: Address; topics: Hex[] }[]; balances?: Map<string, bigint> } = {}) {
  const balances = new Map<string, bigint>([
    // 策略持倉：1 顆 WBNB（$1）＋ 500 顆 USDT（$500）。
    [`${WBNB.toLowerCase()}:${ACCOUNT.toLowerCase()}`, 10n ** 18n],
    [`${USDT.toLowerCase()}:${ACCOUNT.toLowerCase()}`, 500n * 10n ** 18n],
    ...(extra.balances ?? new Map<string, bigint>()),
  ]);
  return stubChain({
    codeFrom: new Map([[ACCOUNT.toLowerCase(), DEPLOYMENT]]),
    balances,
    logs: extra.logs ?? [],
  });
}

test('同樣的策略持倉 + 額外空投 → grossDriftBps / currentBps / total 完全相同（空投不在分母裡）', async () => {
  const priceToken: PriceTokenFn = async () => ({ priceE8: ONE_USD, decimals: 18 });

  // ① 沒有空投
  const clean = await plan({ chain: strategyHoldingsChain(), db: stubDb({ priceTable: PRICE_TABLE_WITH_POOL }), priceToken });
  // ② 同一組策略持倉，額外被空投 1 顆 CAKE
  const airdropped = await plan({
    chain: strategyHoldingsChain({
      logs: [transferLog(8_500n, CAKE, ACCOUNT)],
      balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
    }),
    db: stubDb({ priceTable: PRICE_TABLE_WITH_POOL }),
    priceToken,
  });

  assert.ok(clean.report !== null && airdropped.report !== null, '兩邊都要算得出漂移');
  assert.equal(airdropped.scan.unknownHoldings.length, 1, '空投確實被掃到（否則這個測試沒驗到東西）');

  // 逐項對照：這是驗收條件本身。
  assert.equal(airdropped.report.grossDriftBps, clean.report.grossDriftBps, 'grossDriftBps 不可以被空投改變');
  assert.equal(airdropped.report.maxAbsDeltaBps, clean.report.maxAbsDeltaBps);
  assert.equal(airdropped.report.totalUsdE8, clean.report.totalUsdE8, '空投沒有價格，也不該進總額的分母');
  assert.deepEqual(
    airdropped.report.assets.map((asset) => [asset.asset, asset.currentBps, asset.deltaBps]),
    clean.report.assets.map((asset) => [asset.asset, asset.currentBps, asset.deltaBps]),
    '每個資產的 currentBps / deltaBps 必須逐項相同',
  );
  assert.equal(
    airdropped.report.assets.some((asset) => asset.asset === CAKE.toLowerCase()),
    false,
    '空投不是策略資產，不該出現在漂移報告裡',
  );
  assert.deepEqual(airdropped.blocked, [], '空投不 blocking');

  // 表頭的 complete 也一樣：只看策略資產有沒有價。
  const cleanHeader = await captureHeaderParams(clean, stubDb({ priceTable: PRICE_TABLE_WITH_POOL }));
  const airdropHeader = await captureHeaderParams(airdropped, stubDb({ priceTable: PRICE_TABLE_WITH_POOL }));
  assert.equal(airdropHeader.params[8], cleanHeader.params[8]);
  assert.equal(airdropHeader.params[8], true);

  console.log(
    `[空投對照] 無空投 gross=${clean.report.grossDriftBps} total=${clean.report.totalUsdE8} ` +
      `current=[${clean.report.assets.map((a) => `${a.asset.slice(0, 6)}:${a.currentBps}`).join(' ')}]；` +
      `有 1 顆空投 gross=${airdropped.report.grossDriftBps} total=${airdropped.report.totalUsdE8} ` +
      `current=[${airdropped.report.assets.map((a) => `${a.asset.slice(0, 6)}:${a.currentBps}`).join(' ')}]；` +
      `unknown_token_count=${airdropHeader.params[11]} complete=${airdropHeader.params[8]}`,
  );
});

test('讀取宇宙 == version.assets：查價表上其他 enabled 的資產，餘額一次都不讀', async () => {
  // 查價表（含一顆 enabled、有池、但不在 version.assets 的 TSLAB）刻意比策略資產大。
  const TSLAB = '0x00000000000000000000000000000000000000cc' as Address;
  const chain = strategyHoldingsChain({
    logs: [transferLog(8_500n, TSLAB, ACCOUNT)],
    balances: new Map([[`${TSLAB.toLowerCase()}:${ACCOUNT.toLowerCase()}`, 7n * 10n ** 18n]]),
  });
  const db = stubDb({
    priceTable: [
      ...PRICE_TABLE_WITH_POOL,
      { address: TSLAB, symbol: 'TSLAB', usdt_pool: '0x0000000000000000000000000000000000000f02', is_numeraire: false },
    ],
  });
  const result = await plan({ chain, db, priceToken: async () => ({ priceE8: ONE_USD, decimals: 18 }) });

  // ① 定價/讀取的批次只有 version.assets 的兩顆（每家 balanceOf + decimals 各一筆）。
  assert.deepEqual(
    chain.batches[0]?.targets,
    [USDT.toLowerCase(), USDT.toLowerCase(), WBNB.toLowerCase(), WBNB.toLowerCase()],
    'Multicall3 的內層呼叫必須只涵蓋 version.assets',
  );
  // ② TSLAB 不在獨立的 balanceOf 讀取裡（那條路徑只給「宇宙外候選」用）。
  assert.equal(
    result.snapshot.holdings.some((holding) => holding.asset === TSLAB.toLowerCase()),
    false,
    'TSLAB 不是策略資產，不該進 holdings',
  );
  // ③ 它仍然被掃到 → 記錄（unknown_token_count），但不 blocked、不算進漂移。
  assert.deepEqual(result.scan.unknownHoldings.map((holding) => holding.asset), [TSLAB.toLowerCase()]);
  assert.deepEqual(result.blocked, []);
  assert.ok(result.report !== null);
  assert.equal(
    result.report.assets.some((asset) => asset.asset === TSLAB.toLowerCase()),
    false,
    '策略外資產不進漂移報告',
  );

  console.log(
    `[宇宙=version.assets] 批次 target=${[...new Set(chain.batches[0]?.targets ?? [])].join(',')}；` +
      `TSLAB 在 unknownHoldings=${JSON.stringify(result.scan.unknownHoldings.map((h) => h.asset))}、` +
      `blocked=${result.blocked.length}、report=${result.report?.grossDriftBps}bps`,
  );
});

// ---------------------------------------------------------------------------
// 表頭參數的取樣器：不碰 DB，只截下表頭那條 statement 的 SQL 與參數
// ---------------------------------------------------------------------------

async function captureHeaderParams(
  result: Awaited<ReturnType<typeof plan>>,
  db: StubDb,
): Promise<{ sql: string; params: readonly unknown[] }> {
  const captured: { sql: string; params: readonly unknown[] }[] = [];
  const captureQuery: QueryFn = async (text, params) => {
    if (!text.includes('insert into portfolio_snapshots')) return stubQueryWithCursorWrites(db)(text, params);
    captured.push({ sql: text, params: params ?? [] });
    // 有明細的那一句是「表頭 CTE + 明細」，回傳的是三欄摘要；空倉那句只回 inserted。
    if (text.includes('with header as')) return { rows: [{ header_inserted: true, inserted: 1, updated: 0 }] };
    return { rows: [{ inserted: true }] };
  };
  await writeSnapshot(result.snapshot, result.report, {
    query: captureQuery,
    pinnedVersion: result.pinnedVersion.version,
    scan: result.scan,
  });
  const first = captured[0];
  assert.ok(first !== undefined, 'writeSnapshot 沒有發出表頭的 statement');
  return first;
}
