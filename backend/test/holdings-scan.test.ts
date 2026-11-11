import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Address, Hex, PublicClient } from 'viem';
import { closePool, query } from '../src/db.js';
import {
  addressTopic,
  DEFAULT_CHUNK_SIZE,
  findDeploymentBlock,
  formatScanStatus,
  loadCandidates,
  loadCursor,
  saveCandidates,
  saveCursor,
  scanIncomingTransfers,
  scanPortfolioHoldings,
  touchCandidates,
} from '../src/holdings-scan.js';
import type { QueryFn, ScanCursor } from '../src/holdings-scan.js';

/**
 * `src/holdings-scan.ts` 的測試：鏈用 stub、游標用真的 Postgres。
 *
 * 這支檔案要釘住的是 0009 修的那個 bug 的四個面向：
 * 1. **只看轉入。** 帳戶轉出去的東西不是持倉；ERC-721 形狀的 Transfer（4 個 topic）不是 ERC-20。
 * 2. **分塊，而且失敗不前進游標。** 一個洞會讓某筆轉入永遠不被看到。
 * 3. **餘額 0 的候選不算持倉。** 歷史上進來又出去的東西不該進「帳戶現在有什麼」的觀測記錄。
 * 4. **universe_complete 只在游標覆蓋到部署塊時為 true。** 那是「掃描有沒有覆蓋帳戶一生」的唯一訊號，
 *    與漂移可不可信無關（策略外持倉只記錄、不阻擋，見 src/holdings-scan.ts 檔頭）。
 *
 * 為什麼鏈用 stub 而不是 anvil：這幾條規則要驗的是「塊範圍怎麼切、游標什麼時候動、哪些日誌算候選」，
 * 用真鏈反而驗不到邊界（要製造 403、ERC-721、跨塊失敗都得靠運氣）。真鏈的驗證在
 * `snapshot.integration.test.ts` 那一類整合測試與 0009 的實測記錄裡。
 */

const TRANSFER_TOPIC: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ACCOUNT = '0x2b082fadf8f3d620eaa242a9e36817af8640d042' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' as Address;
const NFT = '0x2222222222222222222222222222222222222222' as Address;
const KNOWN = '0x55d398326f99059ff775485246999027b3197955' as Address;

/** 一筆 stub 日誌。topics 由呼叫端給，測試才驗得到「3 個 topic 才算 ERC-20」。 */
type StubLog = { block: bigint; address: Address; topics: Hex[] };

type StubChain = {
  head: bigint;
  /** `${token}:${account}` → balanceOf。缺席 = 0。 */
  balances: Map<string, bigint>;
  /** token → decimals；缺席 = 讀不到（模擬非 ERC-20）。 */
  decimals: Map<string, number>;
  /** address → 第一個有 bytecode 的塊；缺席 = 永遠沒有 code。 */
  codeFrom: Map<string, bigint>;
  /** address → getCode 會拋錯的塊（模擬 403 archive）。 */
  codeFails: Set<string>;
  logs: StubLog[];
  /** 落在這些範圍的 getLogs 會拋錯（模擬 403／逾時）。 */
  failingRanges: { fromBlock: bigint; toBlock: bigint }[];
  /** 實際發出去的 getLogs 範圍，用來驗分塊。 */
  calls: { fromBlock: bigint; toBlock: bigint }[];
  /** 每一次 balanceOf 讀了哪顆代幣——「候選有沒有被重讀」的直接證據。 */
  balanceReads: string[];
};

function stubChain(overrides: Partial<StubChain> = {}): StubChain {
  return {
    head: 10_000n,
    balances: new Map(),
    decimals: new Map(),
    codeFrom: new Map(),
    codeFails: new Set(),
    logs: [],
    failingRanges: [],
    calls: [],
    balanceReads: [],
    ...overrides,
  };
}

/** 把 stub 包成 viem 的 PublicClient：只實作 holdings-scan 真的會用的四個方法。 */
function stubClient(chain: StubChain): PublicClient {
  const client = {
    async getBlockNumber() {
      return chain.head;
    },
    async getCode(args: { address: Address; blockNumber?: bigint }) {
      const key = `${args.address.toLowerCase()}:${args.blockNumber ?? chain.head}`;
      if (chain.codeFails.has(key)) throw new Error(`模擬 403 Archive requests（getCode @ ${args.blockNumber}）`);
      const from = chain.codeFrom.get(args.address.toLowerCase());
      if (from === undefined) return undefined;
      const at = args.blockNumber ?? chain.head;
      return at >= from ? ('0x60006000' as Hex) : undefined;
    },
    async readContract(args: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) {
      const token = args.address.toLowerCase();
      const account = String(args.args?.[0] ?? '').toLowerCase();
      if (args.functionName === 'balanceOf') {
        chain.balanceReads.push(token);
        const value = chain.balances.get(`${token}:${account}`);
        if (value === undefined) throw new Error(`模擬 balanceOf revert（${token}）`);
        return value;
      }
      const decimals = chain.decimals.get(token);
      if (decimals === undefined) throw new Error(`模擬 decimals revert（${token}，不是 ERC-20）`);
      return decimals;
    },
    async request(args: { method: string; params?: unknown[] }) {
      assert.equal(args.method, 'eth_getLogs', 'stub 只預期 eth_getLogs；其他方法要明說');
      const filter = (args.params?.[0] ?? {}) as { topics?: unknown[]; fromBlock: string; toBlock: string };
      const fromBlock = BigInt(filter.fromBlock);
      const toBlock = BigInt(filter.toBlock);
      chain.calls.push({ fromBlock, toBlock });
      // topics 的形狀就是「只看轉入」的證據：第 0 個釘死 Transfer sig，第 2 個釘死帳戶，第 1 個是 null。
      assert.deepEqual(filter.topics?.[0], TRANSFER_TOPIC);
      assert.equal(filter.topics?.[1], null, 'topics[1]（from）必須是 null：誰轉的都要看');
      assert.equal(filter.topics?.[2], addressTopic(ACCOUNT), 'topics[2]（to）必須是帳戶：只看轉入');
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

function transferLog(block: bigint, token: Address, to: Address): StubLog {
  return { block, address: token, topics: [TRANSFER_TOPIC, addressTopic(OTHER), addressTopic(to)] };
}

// ---------------------------------------------------------------------------
// 1. 只看轉入
// ---------------------------------------------------------------------------

test('scanIncomingTransfers：topics[2] 釘死帳戶、topics[1] 是 null，ERC-721 形狀的轉入不算候選', async () => {
  const erc721 = transferLog(102n, NFT, ACCOUNT); // 同一組 topics 也會命中 ERC-721：第 4 個 topic 是 tokenId
  erc721.topics = [...erc721.topics, `0x${'00'.repeat(31)}01` as Hex];
  const chain = stubChain({ logs: [transferLog(101n, CAKE, ACCOUNT), erc721] });

  // 只看轉入不是程式碼自己再篩一次，而是**查詢條件**就是這樣：stub 在收到 getLogs 時驗這三格。
  const result = await scanIncomingTransfers(stubClient(chain), { account: ACCOUNT, fromBlock: 100n, toBlock: 110n });

  assert.equal(result.failure, null);
  assert.deepEqual(result.tokens, [CAKE], `只該收到 ${CAKE}`);
  assert.equal(result.logCount, 1);
  assert.equal(result.ignoredLogCount, 1, '4 個 topic 的轉入要被計數但排除（拿 ERC-20 ABI 解它會拋錯）');
});

// ---------------------------------------------------------------------------
// 2. 分塊 + 失敗不前進
// ---------------------------------------------------------------------------

test('scanIncomingTransfers：區間按 chunkSize 切塊，每塊都發一次 getLogs', async () => {
  const chain = stubChain();
  const result = await scanIncomingTransfers(stubClient(chain), { account: ACCOUNT, fromBlock: 100n, toBlock: 5_100n, chunkSize: 2_000n });
  assert.equal(result.failure, null);
  assert.deepEqual(chain.calls, [
    { fromBlock: 100n, toBlock: 2_099n },
    { fromBlock: 2_100n, toBlock: 4_099n },
    { fromBlock: 4_100n, toBlock: 5_100n },
  ]);
  assert.deepEqual(result.coveredRange, { fromBlock: 100n, toBlock: 5_100n });
});

test('scanIncomingTransfers：中途 403 → 停在那一塊，回報失敗範圍，不假裝後面的塊掃過', async () => {
  const chain = stubChain({
    logs: [transferLog(150n, CAKE, ACCOUNT), transferLog(4_500n, NFT, ACCOUNT)],
    failingRanges: [{ fromBlock: 2_100n, toBlock: 4_099n }],
  });
  const result = await scanIncomingTransfers(stubClient(chain), { account: ACCOUNT, fromBlock: 100n, toBlock: 5_100n, chunkSize: 2_000n });
  assert.notEqual(result.failure, null);
  assert.match(String(result.failure), /2100/);
  assert.deepEqual(result.failedRange, { fromBlock: 2_100n, toBlock: 4_099n });
  assert.deepEqual(result.coveredRange, { fromBlock: 100n, toBlock: 2_099n }, '只有第一塊算數');
  assert.deepEqual(result.tokens, [CAKE], '失敗前看到的候選照樣回傳（它可能是真的持倉）');
  assert.equal(chain.calls.length, 2, '失敗就停，不要繼續往後掃');
});

// ---------------------------------------------------------------------------
// 3. 部署塊
// ---------------------------------------------------------------------------

test('findDeploymentBlock：getCode 由無到有的那一個塊（二分搜尋）', async () => {
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 7_777n]]) });
  const result = await findDeploymentBlock(stubClient(chain), { account: ACCOUNT, head: 10_000n });
  assert.equal(result.reason, 'resolved');
  assert.equal(result.block, 7_777n);
});

test('findDeploymentBlock：三種取不到都不猜（no_code_at_head / deployed_before_search_from / rpc_cannot_answer）', async () => {
  const noCode = await findDeploymentBlock(stubClient(stubChain({ head: 10_000n })), { account: ACCOUNT, head: 10_000n });
  assert.deepEqual([noCode.block, noCode.reason], [null, 'no_code_at_head']);

  // 在搜尋下界就已經有 code：部署塊在更早、讀不到的地方
  const tooEarly = await findDeploymentBlock(
    stubClient(stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]) })),
    { account: ACCOUNT, head: 10_000n, searchFromBlock: 1_000n },
  );
  assert.deepEqual([tooEarly.block, tooEarly.reason], [null, 'deployed_before_search_from']);

  // 二分中途 403：回 null，不回一個「大概的低界」（把部署塊報高會偽造宇宙完整性）
  const fails = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 7_777n]]) });
  const firstProbe = ((10_000n + 0n) / 2n).toString();
  fails.codeFails.add(`${ACCOUNT.toLowerCase()}:${firstProbe}`);
  const broken = await findDeploymentBlock(stubClient(fails), { account: ACCOUNT, head: 10_000n });
  assert.deepEqual([broken.block, broken.reason], [null, 'rpc_cannot_answer']);
});

// ---------------------------------------------------------------------------
// 4. 一輪掃描（不碰 DB：query 用 fake）
// ---------------------------------------------------------------------------

/**
 * 游標表與候選表（0010）的最小 fake。
 *
 * 兩張表都要有記憶體版本，因為這裡要驗的正是「跨輪次的記憶」：`writes` 只收游標寫入（失敗時必須
 * 一次都沒有），`candidateWrites` 收候選寫入（`insert` / `update` 分開記）。
 */
type FakeCandidate = { firstSeenBlock: bigint; lastBalanceWei: bigint };

function fakeQuery(
  rows: { start_block: string; last_scanned_block: string }[] = [],
  seed: Map<string, FakeCandidate> = new Map(),
): {
  query: QueryFn;
  writes: unknown[][];
  candidateWrites: { kind: 'insert' | 'update'; assets: string[]; values: bigint[] }[];
  candidates: Map<string, FakeCandidate>;
} {
  const writes: unknown[][] = [];
  const candidateWrites: { kind: 'insert' | 'update'; assets: string[]; values: bigint[] }[] = [];
  const candidates = seed;
  const state = [...rows];
  const q: QueryFn = async (text, params = []) => {
    if (text.includes('insert into portfolio_holding_candidates')) {
      const assets = (params[1] as string[]).map((asset) => asset.toLowerCase());
      const blocks = (params[2] as string[]).map((block) => BigInt(block));
      candidateWrites.push({ kind: 'insert', assets, values: blocks });
      assets.forEach((asset, index) => {
        // on conflict do nothing：first_seen_block 只記第一次
        if (!candidates.has(asset)) candidates.set(asset, { firstSeenBlock: blocks[index]!, lastBalanceWei: 0n });
      });
      return { rows: [] };
    }
    if (text.includes('update portfolio_holding_candidates')) {
      const assets = (params[1] as string[]).map((asset) => asset.toLowerCase());
      const balances = (params[2] as string[]).map((balance) => BigInt(balance));
      candidateWrites.push({ kind: 'update', assets, values: balances });
      assets.forEach((asset, index) => {
        const row = candidates.get(asset);
        if (row !== undefined) row.lastBalanceWei = balances[index]!;
      });
      return { rows: [] };
    }
    if (text.includes('from portfolio_holding_candidates')) {
      return {
        rows: [...candidates.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([asset, row]) => ({
            asset,
            // pg 對 bigint / numeric 一律回字串，stub 照抄那個形狀。
            first_seen_block: row.firstSeenBlock.toString(),
            last_balance_wei: row.lastBalanceWei.toString(),
          })),
      };
    }
    if (text.includes('from portfolio_scan_cursors')) {
      return { rows: state.length === 0 ? [] : [{ portfolio_id: 5, ...state[0] }] };
    }
    if (text.includes('insert into portfolio_scan_cursors')) {
      writes.push([...params]);
      if (state.length === 0) state.push({ start_block: String(params[1]), last_scanned_block: String(params[2]) });
      else state[0] = { start_block: state[0]!.start_block, last_scanned_block: String(params[2]) };
      return { rows: [] };
    }
    throw new Error(`fakeQuery 沒預期這條 SQL：${text.slice(0, 60)}`);
  };
  return { query: q, writes, candidateWrites, candidates };
}

test('scanPortfolioHoldings：策略外代幣有餘額 → 進 unknownHoldings（只記錄，不產生任何 blocker）', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
    decimals: new Map([[CAKE, 18]]),
  });
  const { query: q, writes } = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN], head: 10_000n });

  assert.deepEqual(result.unknownHoldings, [{ asset: CAKE, amountWei: 10n ** 18n, decimals: 18 }]);
  assert.deepEqual(result.scannedRange, { fromBlock: 9_401n, toBlock: 10_000n });
  assert.equal(result.universeComplete, true, '游標 100 <= 部署塊 100，而且這一輪掃完沒失敗');
  // 策略外持倉只是觀測：它出現在給人看的摘要裡（表頭 unknown_token_count 的值就是它的個數），
  // 而不是變成 blocker。執行器換不掉它（AtpExecutor.sol:180-182），擋漂移只會讓投組停止再平衡。
  assert.match(formatScanStatus(result).join('\n'), /宇宙外的持倉：0x0e09fabb/);
  assert.equal(result.unknownHoldings.length, 1, '表頭 unknown_token_count 的來源');
  assert.equal(writes.length, 1, '掃描成功才寫游標');
  assert.equal(writes[0]?.[2], '10000', '游標推進到 head');
});

test('scanPortfolioHoldings：餘額 0 的候選不算持倉（歷史進來又出去），不進 unknown_token_count', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 0n]]),
  });
  const { query: q } = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN], head: 10_000n });
  assert.deepEqual(result.unknownHoldings, []);
  assert.equal(result.zeroBalanceCount, 1);
  assert.doesNotMatch(formatScanStatus(result).join('\n'), /宇宙外的持倉/);
});

test('scanPortfolioHoldings：候選在已知宇宙裡 → 不進 unknownHoldings', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, KNOWN, ACCOUNT)],
    balances: new Map([[`${KNOWN}:${ACCOUNT.toLowerCase()}`, 5n]]),
  });
  const { query: q } = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN], head: 10_000n });
  assert.deepEqual(result.unknownHoldings, []);
  assert.equal(result.candidateCount, 0);
});

test('scanPortfolioHoldings：游標起點晚於部署塊 → universeComplete false，但不算「知道有問題」', async () => {
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]) });
  const { query: q } = fakeQuery([{ start_block: '101', last_scanned_block: '10000' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.equal(result.deployment.block, 100n);
  assert.equal(result.universeComplete, false);
  assert.match(result.incompleteReasons.join(' '), /晚於部署塊/);
  assert.deepEqual(result.unknownHoldings, [], '完整性未確認 ≠ 觀察到策略外持倉');
});

test('scanPortfolioHoldings：部署塊取不到 → universeComplete false', async () => {
  const chain = stubChain({ head: 10_000n });
  const { query: q } = fakeQuery([{ start_block: '100', last_scanned_block: '10000' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.equal(result.deployment.block, null);
  assert.equal(result.universeComplete, false);
  assert.equal(result.scannedRange, null, '游標已在 head，沒有新區塊可掃');
});

test('scanPortfolioHoldings：這一輪 getLogs 失敗 → universeComplete false 且游標一格都不動', async () => {
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]), failingRanges: [{ fromBlock: 9_401n, toBlock: 9_500n }] });
  const { query: q, writes } = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.equal(result.universeComplete, false);
  assert.equal(writes.length, 0, '失敗時不寫游標（連失敗前已成功的塊也不寫）');
  assert.equal(result.cursor.lastScannedBlock, 9_400n);
  assert.match(formatScanStatus(result).join('\n'), /宇宙完整性\s+⚠ 未確認/);
});

test('scanPortfolioHoldings：新游標從部署塊開始（知道部署塊才有機會讓 universeComplete 為 true）', async () => {
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 9_900n]]) });
  const { query: q, writes } = fakeQuery([]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.deepEqual(result.cursor, { portfolioId: 5, startBlock: 9_900n, lastScannedBlock: 10_000n });
  assert.equal(result.universeComplete, true);
  assert.deepEqual(chain.calls, [{ fromBlock: 9_900n, toBlock: 10_000n }], '只掃部署塊之後');
  assert.deepEqual(writes[0]?.slice(1), ['9900', '10000']);
});

test('DEFAULT_CHUNK_SIZE：小的失敗重做量，但不是荒謬的小', () => {
  assert.equal(DEFAULT_CHUNK_SIZE, 2_000n);
});

// ---------------------------------------------------------------------------
// 4b. 候選表（0010）：看過就永遠繼續看
//
// 這一段釘住 0009 留下來的那個缺口：偵測原本只對「這一輪日誌看到的候選」讀 balanceOf，
// 游標一推進，第 N 輪發現的策略外持倉就在第 N+1 輪憑空消失（表頭 unknown_token_count 變回 0）。
// ---------------------------------------------------------------------------

test('第 N 輪發現的候選，第 N+1 輪即使沒有新日誌仍被重讀（0010 的核心）', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
    decimals: new Map([[CAKE, 18]]),
  });
  const fake = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const deps = { client: stubClient(chain), query: fake.query, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN] };

  // 第 N 輪：CAKE 在 9500 轉入 → 游標掃到它 → 記錄為策略外持倉。
  const round1 = await scanPortfolioHoldings({ ...deps, head: 10_000n });
  assert.deepEqual(round1.unknownHoldings.map((holding) => holding.asset), [CAKE]);
  assert.equal(round1.cursor.lastScannedBlock, 10_000n, '第一輪成功，游標推進到 head');
  assert.equal(fake.candidates.has(CAKE), true, '發現的候選要落地');

  // 第 N+1 輪：視窗 [10001, 10000] 是空的——這一輪**沒有新日誌**。0009 的實作在這裡會回
  // unknown_token_count = 0，於是那顆空投在觀測記錄裡憑空消失。
  const logCallsBefore = chain.calls.length;
  const balanceReadsBefore = chain.balanceReads.length;
  const round2 = await scanPortfolioHoldings({ ...deps, head: 10_000n });
  assert.deepEqual(round2.scannedRange, null, '這一輪沒有新區塊可掃');
  assert.equal(chain.calls.length, logCallsBefore, '真的沒有發 getLogs');
  assert.deepEqual(
    chain.balanceReads.slice(balanceReadsBefore),
    [CAKE],
    '候選表的全部列仍被重讀 balanceOf（不是靠這一輪的日誌）',
  );

  assert.equal(round2.candidateCount, 1, '候選個數來自候選表，不是這一輪日誌');
  assert.deepEqual(round2.unknownHoldings.map((holding) => holding.asset), [CAKE], '第 N+1 輪仍然看到它');
  assert.match(
    formatScanStatus(round2).join('\n'),
    /宇宙外的持倉：0x0e09fabb/,
    '觀測記錄必須持續到餘額真的歸零，不能因為「這輪沒新日誌」而消失',
  );
  assert.equal(fake.candidates.get(CAKE)?.lastBalanceWei, 10n ** 18n, '每輪重讀的餘額要寫回候選表');

  console.log(
    `[0010 核心] 第 N 輪 unknownHoldings=${JSON.stringify(round1.unknownHoldings.map((h) => h.asset))}；` +
      `第 N+1 輪 scannedRange=${JSON.stringify(round2.scannedRange)} ` +
      `candidateCount=${round2.candidateCount} unknownHoldings=${JSON.stringify(round2.unknownHoldings.map((h) => h.asset))} ` +
      `universeComplete=${round2.universeComplete}`,
  );
});

test('候選餘額歸零 → 列留著（可能再度有餘額），但不算 unknownHoldings', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
    decimals: new Map([[CAKE, 18]]),
  });
  const fake = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const deps = { client: stubClient(chain), query: fake.query, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN] };
  const round1 = await scanPortfolioHoldings({ ...deps, head: 10_000n });
  assert.equal(round1.unknownHoldings.length, 1);

  // 賣掉了：餘額歸零。
  chain.balances.set(`${CAKE}:${ACCOUNT.toLowerCase()}`, 0n);
  const round2 = await scanPortfolioHoldings({ ...deps, head: 10_000n });
  assert.deepEqual(round2.unknownHoldings, [], '餘額 0 不算持倉：不該進 unknown_token_count');
  assert.doesNotMatch(formatScanStatus(round2).join('\n'), /宇宙外的持倉/);
  assert.equal(round2.zeroBalanceCount, 1);
  assert.equal(fake.candidates.has(CAKE), true, '餘額歸零的候選**不可以刪**（它可能再度有餘額，屆時未必有日誌）');
  assert.equal(fake.candidates.get(CAKE)?.lastBalanceWei, 0n, '餘額 0 要如實寫回');
  assert.equal(fake.candidates.get(CAKE)?.firstSeenBlock, 9_500n, 'first_seen_block 只記第一次，不被重讀改寫');

  console.log(
    `[0010 歸零] candidates=${JSON.stringify([...fake.candidates.keys()])} ` +
      `last_balance_wei=${fake.candidates.get(CAKE)?.lastBalanceWei} first_seen_block=${fake.candidates.get(CAKE)?.firstSeenBlock} ` +
      `unknownHoldings=${round2.unknownHoldings.length}`,
  );
});

test('日誌掃描失敗 → universeComplete=false、游標不動，但候選仍被重讀（重讀與掃描解耦）', async () => {
  const chain = stubChain({
    head: 9_500n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
    decimals: new Map([[CAKE, 18]]),
  });
  const fake = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const deps = { client: stubClient(chain), query: fake.query, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN] };
  await scanPortfolioHoldings({ ...deps, head: 9_500n });
  assert.equal(fake.candidates.has(CAKE), true);

  // 下一輪：head 前進，但 getLogs 一律 403（publicnode 對無 address 的多塊查詢就是這樣拒的）。
  chain.head = 10_000n;
  chain.failingRanges = [{ fromBlock: 9_501n, toBlock: 10_000n }];
  const logCallsBefore = chain.calls.length;
  const balanceReadsBefore = chain.balanceReads.length;
  const round2 = await scanPortfolioHoldings({ ...deps, head: 10_000n });

  assert.equal(round2.scannedRange, null, '第一塊就失敗：一塊都沒掃成功');
  assert.match(round2.incompleteReasons.join('；'), /getLogs/, '掃描失敗要被誠實記下來');
  assert.equal(round2.universeComplete, false, '掃描失敗 → 宇宙完整性未確認');
  assert.equal(round2.cursor.lastScannedBlock, 9_500n, '游標一格都不動');
  assert.equal(fake.writes.length, 1, '只有第一輪寫過游標');

  assert.equal(chain.calls.length, logCallsBefore + 1, '這一輪只發了一次會失敗的 getLogs');
  assert.deepEqual(chain.balanceReads.slice(balanceReadsBefore), [CAKE], '掃描失敗，但已存下來的候選仍被重讀');
  assert.deepEqual(
    round2.unknownHoldings.map((holding) => holding.asset),
    [CAKE],
    '掃描失敗不是忘記已知策略外持倉的理由——觀測記錄必須持續',
  );

  console.log(
    `[0010 解耦] 掃描失敗：universeComplete=${round2.universeComplete} cursor=${round2.cursor.lastScannedBlock} ` +
      `重讀=${JSON.stringify(chain.balanceReads.slice(balanceReadsBefore))} ` +
      `unknownHoldings=${JSON.stringify(round2.unknownHoldings.map((h) => h.asset))} 原因=${round2.incompleteReasons[0]?.slice(0, 30)}…`,
  );
});

// ---------------------------------------------------------------------------
// 5. 游標（真的 Postgres）
// ---------------------------------------------------------------------------

async function dbReason(): Promise<string | null> {
  try {
    await query('select 1 from portfolio_scan_cursors limit 0');
    await query('select 1 from portfolio_holding_candidates limit 0');
    return null;
  } catch (cause) {
    return `Postgres 或 0009/0010 不可用（${cause instanceof Error ? cause.message : String(cause)}）`;
  }
}

const dbSkip = await dbReason();
const hasDb = dbSkip === null;
if (dbSkip !== null) console.warn(`[holdings-scan] 游標測試 skip：${dbSkip}`);
const gate = dbSkip === null ? {} : { skip: dbSkip };
/**
 * 測試用的 portfolio id。
 *
 * 原本寫死 `5` —— 那只有在「dev 資料庫剛好有 portfolio 5」時才會過（這兩個表都有 FK）。
 * 在乾淨的資料庫上會直接撞 FK，測試看起來像壞掉，其實是它一直在借別人的資料。
 * 所以改成當場造一列（策略 + portfolio），並在 `after` 清掉。
 */
async function seedTestPortfolio(): Promise<number> {
  const strategy =
    (await query<{ id: string }>('select id from strategies order by id limit 1')).rows[0] ??
    (
      await query<{ id: string }>(
        `insert into strategies (provider, name) values ($1, $2) returning id`,
        ['0xholdings-scan-test', 'holdings-scan fixture'],
      )
    ).rows[0];
  if (strategy === undefined) throw new Error('造不出測試用的 strategy');
  const row = (
    await query<{ id: string }>(
      `insert into portfolios (user_id, strategy_id, version, schedule_state)
       values ('0xholdings-scan-test', $1, 1, 'idle') returning id`,
      [strategy.id],
    )
  ).rows[0];
  if (row === undefined) throw new Error('造不出測試用的 portfolio');
  return Number(row.id);
}

const TEST_PORTFOLIO = hasDb ? await seedTestPortfolio() : 0;

after(async () => {
  await closePool().catch(() => {
    // DB 不在時 closePool 失敗不該蓋掉測試結果
  });
});

test('游標：沒有列時回 null、存檔後可讀回、start_block 不被後來的存檔覆寫、last 只前進', gate, async () => {
  await query('delete from portfolio_scan_cursors where portfolio_id = $1', [TEST_PORTFOLIO]);
  try {
    assert.equal(await loadCursor(query, TEST_PORTFOLIO), null);

    const fresh: ScanCursor = { portfolioId: TEST_PORTFOLIO, startBlock: 1_000n, lastScannedBlock: 999n };
    await saveCursor(query, fresh);
    assert.deepEqual(await loadCursor(query, TEST_PORTFOLIO), fresh);

    await saveCursor(query, { ...fresh, lastScannedBlock: 2_000n });
    assert.deepEqual(await loadCursor(query, TEST_PORTFOLIO), { ...fresh, lastScannedBlock: 2_000n });

    // 一個更小的 start_block 會憑空宣稱掃過沒掃過的歷史 → 不能被寫進去
    await saveCursor(query, { portfolioId: TEST_PORTFOLIO, startBlock: 10n, lastScannedBlock: 2_000n });
    assert.deepEqual(await loadCursor(query, TEST_PORTFOLIO), { ...fresh, lastScannedBlock: 2_000n });

    // last_scanned_block 只前進（比資料庫裡小的值不會把它拉回去）
    await saveCursor(query, { ...fresh, lastScannedBlock: 1_500n });
    assert.equal((await loadCursor(query, TEST_PORTFOLIO))?.lastScannedBlock, 2_000n);
  } finally {
    await query('delete from portfolio_scan_cursors where portfolio_id = $1', [TEST_PORTFOLIO]);
  }
});

test('候選表（真的 Postgres）：insert 只記第一次、重讀寫回餘額、餘額 0 的列不刪', gate, async () => {
  const MAX_UINT256 = 2n ** 256n - 1n;
  await query('delete from portfolio_holding_candidates where portfolio_id = $1', [TEST_PORTFOLIO]);
  try {
    await saveCandidates(query, { portfolioId: TEST_PORTFOLIO, candidates: [{ asset: CAKE, firstSeenBlock: 9_500n }] });
    assert.deepEqual(await loadCandidates(query, TEST_PORTFOLIO), [
      { asset: CAKE, firstSeenBlock: 9_500n, lastBalanceWei: 0n },
    ]);

    // first_seen_block 只記第一次：重複發現不改寫
    await saveCandidates(query, { portfolioId: TEST_PORTFOLIO, candidates: [{ asset: CAKE, firstSeenBlock: 9_999n }] });
    assert.equal((await loadCandidates(query, TEST_PORTFOLIO))[0]?.firstSeenBlock, 9_500n);

    // 重讀成功 → 餘額寫回（uint256 的完整範圍，numeric(78,0) 放得下）
    await touchCandidates(query, { portfolioId: TEST_PORTFOLIO, balances: [{ asset: CAKE, amountWei: MAX_UINT256 }] });
    assert.equal((await loadCandidates(query, TEST_PORTFOLIO))[0]?.lastBalanceWei, MAX_UINT256);

    // 餘額歸零 → 列**留著**、餘額如實寫回 0（它可能再度有餘額，屆時未必有日誌）
    await touchCandidates(query, { portfolioId: TEST_PORTFOLIO, balances: [{ asset: CAKE, amountWei: 0n }] });
    const after = await loadCandidates(query, TEST_PORTFOLIO);
    assert.equal(after.length, 1, '餘額 0 的候選不可以被刪除');
    assert.equal(after[0]?.lastBalanceWei, 0n);

    // 讀不到 balanceOf 的候選不會被 touch：舊值（這裡是 0）不被偽造成新值
    await touchCandidates(query, { portfolioId: TEST_PORTFOLIO, balances: [] });
    assert.equal((await loadCandidates(query, TEST_PORTFOLIO))[0]?.lastBalanceWei, 0n);
  } finally {
    await query('delete from portfolio_holding_candidates where portfolio_id = $1', [TEST_PORTFOLIO]);
  }
});
