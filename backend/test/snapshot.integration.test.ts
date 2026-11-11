import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createPublicClient, encodeFunctionData, hexToBigInt, http, parseAbi, toHex } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { bsc } from 'viem/chains';
import { closePool, query } from '../src/db.js';
import { parseSnapshotRows } from '../src/drift.js';
import { twapPriceInUsdt } from '../src/pricing.js';
import { planPortfolio, writeSnapshot } from '../src/snapshot.js';

/**
 * 整合測試：真的 anvil fork（chainId 56 的 BSC fork）+ 真的 Postgres。
 *
 * 這支檔案存在的理由只有一個：單元測試證明得了「規則寫對了」，證明不了「鏈上那顆 bStock 真的讀得
 * 到、池子真的報得出價、快照真的寫得進去而且第二次是 UPDATE」。所以這裡每一項都對真的環境做。
 *
 * 每個測試要的餘額狀態**由這條測試自己造**（`withChainState`）：`anvil_snapshot` → 把系統認識的
 * 代幣清零／寫成這個測試要的值 → 斷言 → `anvil_revert`。revert 在 `finally` 之後一定執行，所以
 * 測試失敗也不會把鏈留在改過的樣子；帳戶原本的餘額（上一輪真實再平衡的證據）也原封不動。
 *
 * 為什麼非這樣不可：在這之前這些測試斷言「帳戶是空倉」，而那是**絕對的環境假設**。有人真的用過一次
 * 系統（pitfalls §8.13 那次再平衡）之後六條全紅，程式一行都沒錯——一個「只要有人真的用過系統就會紅」
 * 的整合測試等於沒有測試，而且它訓練所有人忽略紅燈。狀態是測試的前提，就該由測試建立。
 *
 * 餘額怎麼寫進去：`anvil_dealERC20` 在這顆 bStock 上找得到 token 卻找不到 balance slot（實測
 * "Unable to set ERC20 balance, no slot found"），所以走 `debug_traceCall` + `anvil_setStorageAt`：
 * 先 trace `balanceOf(account)` 拿到它 SLOAD 了哪些 storage key，再逐一「寫進去 → 重讀 balanceOf →
 * 變了就是它，沒變就寫回去試下一個」。不是猜 slot 編號，是用行為驗證。這些都是 cheat code，不送交易。
 *
 * fork 掛掉（403 Archive requests）、DB 連不上、或 anvil 沒開 debug API 時整組 skip 並印原因：
 * 環境不在不是這支程式的錯，但靜默 pass 是。
 */

const RPC_URL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const EXPECTED_CHAIN_ID = 56;
const REGISTRY_ADDRESS = (process.env.REGISTRY_ADDRESS ?? '0x27739a1AD35a924F5545C7d04C2B0537069CA76C') as Address;
const PORTFOLIO_ID = 5;
const THRESHOLD_BPS = 100;

const NVDAB = '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436' as Address;
/** PancakeSwap V3 NVDAB/USDT，fee 2500。 */
const NVDAB_USDT_POOL = '0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C' as Address;
/** 沒有 usdt_pool 的 bStock：拿它來驗「持有無價資產 → 拒算漂移」。 */
const TSLAB = '0x5b1910eaad6450e50f816082aa078c41f10c292f' as Address;
/** portfolio 5 的目標就是這兩個（0007 讓它們有了價格來源：USDT 是 numeraire、WBNB 有 fee 500 的池）。 */
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' as Address;
/** PancakeSwap V3 WBNB/USDT，fee 500：鏈上 oracle 用的就是這一個池。 */
const WBNB_USDT_POOL = '0x36696169C63e42cd08ce11f5deeBbCeBae652050' as Address;

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'enrollments',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'strategyId', type: 'uint256' },
      { name: 'version', type: 'uint16' },
      { name: 'paused', type: 'bool' },
    ],
  },
] as const;

const publicClient = createPublicClient({ chain: bsc, transport: http(RPC_URL, { timeout: 20_000, retryCount: 1 }) });

/** anvil 的 cheat code 不在 viem 的 method 清單裡，只借它的 transport 發 raw request。 */
type RawRpc = { request(args: { method: string; params?: readonly unknown[] }): Promise<unknown> };

function raw(client: PublicClient): RawRpc {
  return client as unknown as RawRpc;
}

async function readBalance(token: Address, account: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] });
}

async function readSlot(token: Address, slot: Hex): Promise<bigint> {
  const value = await publicClient.getStorageAt({ address: token, slot });
  return value === undefined ? 0n : hexToBigInt(value);
}

async function writeSlot(token: Address, slot: Hex, value: bigint): Promise<void> {
  await raw(publicClient).request({ method: 'anvil_setStorageAt', params: [token, slot, toHex(value, { size: 32 })] });
}

/** `balanceOf(account)` 這一趟 SLOAD 過的 storage key 候選。 */
async function balanceStorageCandidates(token: Address, account: Address): Promise<Hex[]> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [account] });
  const trace = (await raw(publicClient).request({
    method: 'debug_traceCall',
    params: [{ to: token, data }, 'latest', { disableMemory: true, disableStorage: true }],
  })) as { structLogs?: { op: string; stack?: string[] }[] };

  const slots = new Set<Hex>();
  for (const entry of trace.structLogs ?? []) {
    if (entry.op !== 'SLOAD') continue;
    const top = entry.stack?.at(-1);
    if (top === undefined) continue;
    slots.add(`0x${BigInt(top).toString(16).padStart(64, '0')}` as Hex);
  }
  return [...slots];
}

/**
 * 把 `account` 的 `balanceOf` 設成 `amountWei`，回傳實際重讀回來的值。
 *
 * 候選槽來自 trace，但**不假設**順序或語意：用一個「一定不等於前後值」的探針逐一寫入候選槽、重讀
 * balanceOf，只有真的改變了餘額的那個 key 才算命中；沒命中的立刻寫回原值。合約改版換了 storage
 * layout 時，這裡也不會寫壞別的欄位。
 *
 * 探針刻意是 `before + amountWei + 1`，不是 `amountWei` 本身：目標值剛好等於現值時（上一輪真的
 * 再平衡過一次之後就是這樣），拿目標值當探針會「寫進去也沒變」，於是每一個候選都判定失敗。
 * 寫進去的東西由呼叫端的 snapshot 負責還原，這裡不留痕。
 */
async function setBalance(token: Address, account: Address, amountWei: bigint): Promise<bigint> {
  const before = await readBalance(token, account);
  if (before === amountWei) return before;

  const probe = before + amountWei + 1n;
  for (const slot of await balanceStorageCandidates(token, account)) {
    const previous = await readSlot(token, slot);
    await writeSlot(token, slot, probe);
    const after = await readBalance(token, account);
    await writeSlot(token, slot, previous);
    if (after !== probe) continue;
    await writeSlot(token, slot, amountWei);
    const applied = await readBalance(token, account);
    if (applied !== amountWei) {
      throw new Error(`槽 ${slot} 命中了，但寫 ${amountWei} 之後 balanceOf 是 ${applied}：這個槽不是唯一的餘額欄位`);
    }
    return applied;
  }
  throw new Error(
    `無法把 ${token} 的 balanceOf 設成 ${amountWei}：trace balanceOf(${account}) 的候選槽，` +
      '沒有一個寫進去會改變 balanceOf（試過 anvil_setStorageAt 全部候選）',
  );
}

/** `anvil_snapshot` 回傳的是 snapshot id（例如 "0x0"），不是 boolean。 */
async function takeSnapshot(): Promise<string> {
  const id = await raw(publicClient).request({ method: 'anvil_snapshot', params: [] });
  if (typeof id !== 'string') throw new Error(`anvil_snapshot 回了 ${JSON.stringify(id)}，不是 snapshot id`);
  return id;
}

/** 還原到 snapshotId。**失敗必須炸**：靜默吞掉會讓下一個測試從被改過的鏈開始，而且沒有人知道。 */
async function revertSnapshot(id: string): Promise<void> {
  let reverted: unknown;
  try {
    reverted = await raw(publicClient).request({ method: 'anvil_revert', params: [id] });
  } catch (cause) {
    throw new Error(
      `anvil_revert(${id}) 失敗（${cause instanceof Error ? cause.message : String(cause)}）：` +
        '鏈停在這個測試改過的樣子，後面的測試看到的不是原本的鏈',
    );
  }
  if (reverted !== true) throw new Error(`anvil_revert(${id}) 回了 ${String(reverted)} 而不是 true：快照沒有真的還原`);
}

/**
 * 「把這個帳戶弄成空的」要清掉哪些代幣：查價表上啟用的全部 ∪ 這個 portfolio 的策略（所有版本）的
 * assets ∪ 掃描發現過的候選（`portfolio_holding_candidates`，那是「這個帳戶曾經收到過什麼」的紀錄）。
 * 三張表答的是不同問題（怎麼定價／策略持什麼／歷史上收到過什麼），只用其中一張都會漏；
 * 多清一顆不影響斷言，少清一顆就會讓「空倉」只是看起來空。
 */
let resetTokenCache: Promise<readonly Address[]> | null = null;

function resetTokens(): Promise<readonly Address[]> {
  resetTokenCache ??= (async () => {
    const priced = await query<{ address: string }>('select address from priceable_assets where enabled');
    const allocated = await query<{ address: string }>(
      `select distinct (asset ->> 'address') as address
         from strategy_versions sv
              cross join lateral jsonb_array_elements(sv.allocation -> 'assets') as asset
        where sv.strategy_id = (select strategy_id from portfolios where id = $1)`,
      [PORTFOLIO_ID],
    );
    const seen = await query<{ address: string }>(
      'select asset as address from portfolio_holding_candidates where portfolio_id = $1',
      [PORTFOLIO_ID],
    );
    const addresses = new Set<string>();
    for (const row of [...priced.rows, ...allocated.rows, ...seen.rows]) {
      if (typeof row.address === 'string' && row.address.length > 0) addresses.add(row.address.toLowerCase());
    }
    if (addresses.size === 0) {
      throw new Error(`不知道 portfolio ${PORTFOLIO_ID} 的帳戶該清哪些代幣：查價表與策略資產都是空的`);
    }
    return [...addresses] as Address[];
  })();
  return resetTokenCache;
}

/**
 * 在 anvil snapshot 內建立這條測試要的餘額，跑完**一定** revert（測試失敗也還原）。
 *
 * `balances` 是完整意圖：沒列進來的代幣一律是 0。所以「空倉」「只有 WBNB」是這條測試自己造的狀態，
 * 不是「跑測試之前環境剛好長這樣」的假設——上一輪真的用 session key 換了一次幣（pitfalls §8.13），
 * portfolio 5 從此帶著 WBNB 250000000003597623 / USDT 173627601129317533692，那六條測試於是全紅，
 * 而程式一行都沒錯。只要有人真的用過系統就紅的整合測試等於沒有測試：它訓練所有人忽略紅燈。
 *
 * 帳戶原本的餘額因此**不會被清掉**：revert 之後鏈回到原樣，那是上一輪真實再平衡的證據。
 */
async function withChainState(
  balances: readonly { token: Address; amountWei: bigint }[],
  run: (actual: ReadonlyMap<string, bigint>) => Promise<void>,
): Promise<void> {
  const snapshotId = await takeSnapshot();
  let failure: unknown;
  try {
    const wanted = new Map(balances.map((entry) => [entry.token.toLowerCase(), entry.amountWei] as const));
    const actual = new Map<string, bigint>();
    // 先把「系統認識的代幣」全部歸零，再把這條測試要的餘額寫上去。
    for (const token of await resetTokens()) {
      const key = token.toLowerCase();
      actual.set(key, await setBalance(token, ACCOUNT, wanted.get(key) ?? 0n));
      wanted.delete(key);
    }
    // 剩下的（系統完全不認識的代幣）不在上面那三張表裡，直接指定。
    for (const [key, amountWei] of wanted) actual.set(key, await setBalance(key as Address, ACCOUNT, amountWei));
    await run(actual);
  } catch (cause) {
    failure = cause;
  }
  try {
    await revertSnapshot(snapshotId);
  } catch (revertFailure) {
    if (failure === undefined) throw revertFailure;
    throw new AggregateError([failure, revertFailure], '測試失敗，而且 anvil_revert 也失敗：鏈沒有回到乾淨狀態');
  }
  if (failure !== undefined) throw failure;
}

/** 這個 portfolio 的 smart account：從 DB 拿，不寫死（寫死就等於假設 DB 不會變）。 */
async function smartAccountOf(portfolioId: number, chainId: number): Promise<Address> {
  const result = await query<{ address: string }>(
    'select sa.address from smart_accounts sa where sa.portfolio_id = $1 and sa.chain_id = $2',
    [portfolioId, chainId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`portfolio ${portfolioId} 在 chain ${chainId} 上沒有 smart account`);
  return row.address as Address;
}

async function countRows(portfolioId: number, block: bigint): Promise<number> {
  const result = await query<{ count: string }>(
    'select count(*)::text as count from positions_snapshots where portfolio_id = $1 and block = $2',
    [portfolioId, block.toString()],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function countHeaders(portfolioId: number, block: bigint): Promise<number> {
  const result = await query<{ count: string }>(
    'select count(*)::text as count from portfolio_snapshots where portfolio_id = $1 and block = $2',
    [portfolioId, block.toString()],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** 表頭一列。numeric 欄位一律 ::text，斷言才不會在 bigint/string 之間漂。 */
type HeaderRow = {
  portfolio_id: string;
  block: string;
  native_balance_wei: string;
  total_usd_e8: string;
  gross_drift_bps: number;
  max_abs_delta_bps: number;
  threshold_bps: number;
  needs_rebalance: boolean;
  complete: boolean;
  unpriced_count: number;
  pinned_version: number | null;
  unknown_token_count: number;
  universe_complete: boolean;
};

async function readHeader(portfolioId: number, block: bigint): Promise<HeaderRow | undefined> {
  const result = await query<HeaderRow>(
    `select portfolio_id::text, block::text, native_balance_wei::text, total_usd_e8::text,
            gross_drift_bps, max_abs_delta_bps, threshold_bps, needs_rebalance, complete,
            unpriced_count, pinned_version, unknown_token_count, universe_complete
       from portfolio_snapshots
      where portfolio_id = $1 and block = $2`,
    [portfolioId, block.toString()],
  );
  return result.rows[0];
}

/** 把這個 portfolio 在指定 block 的兩種列都清掉，讓每個寫入測試都從乾淨的狀態開始。 */
async function clearSnapshots(portfolioId: number, block: bigint): Promise<void> {
  await query('delete from positions_snapshots where portfolio_id = $1 and block = $2', [
    portfolioId,
    block.toString(),
  ]);
  await query('delete from portfolio_snapshots where portfolio_id = $1 and block = $2', [
    portfolioId,
    block.toString(),
  ]);
}

// ACCOUNT 必須在 probe 之前就有值（probeDeal 與 withChainState 都用到），所以先讀一次；讀不到就讓整組 skip。
async function probeFork(): Promise<string | null> {
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== EXPECTED_CHAIN_ID) {
      return `anvil fork ${RPC_URL} 的 chainId 是 ${chainId}，不是 ${EXPECTED_CHAIN_ID}：這不是 BSC fork`;
    }
    const blockNumber = await publicClient.getBlockNumber();
    if (blockNumber === 0n) return `anvil fork ${RPC_URL} 的塊高是 0：fork 沒有真的接上上游`;
    // **必須做一次「永遠冷」的讀取。**
    //
    // 暖查詢（池子 slot0、已快取的帳戶）在上游 archive 視窗過期之後**仍會成功** —— anvil 直接回快取，
    // 所以只做暖查詢的探針會回報「健康」，然後測試在真正冷讀時一起變紅。
    //
    // ⚠ 這裡踩過一次：原本用固定 sentinel（0x…DeaDBeef），但**探針自己把那個位址查暖了**
    //   —— 第一次有效，之後每次都誤報健康。所以位址必須每次不同：隨機位址永遠不在快取裡，
    //   要回答它就得回上游，而那正是 403 發生的地方。
    const coldProbeAddress = `0x${Array.from({ length: 40 }, () =>
      '0123456789abcdef'[Math.floor(Math.random() * 16)],
    ).join('')}` as Address;
    await publicClient.getBalance({ address: coldProbeAddress });
    // 這條路徑的價格一律走 NVDAB 的池；池子讀不到就整組 skip，不要讓 suite 紅。
    const quote = await twapPriceInUsdt(publicClient, { token: NVDAB, usdtPool: NVDAB_USDT_POOL, expectedQuoteToken: USDT });
    return quote.priceE8 > 0n ? null : `NVDAB 的 TWAP 報價是 0：池子狀態不對`;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return (
      `anvil fork ${RPC_URL} 不可用（${message}）：403 Archive requests 就是上游 archive 視窗過期，` +
      `跑 \`bash backend/scripts/refresh-anvil.sh\` 刷新（會重啟 anvil 並載回 deployments 的狀態）`
    );
  }
}

async function probeDb(): Promise<string | null> {
  try {
    await query('select 1');
    return null;
  } catch (cause) {
    return `Postgres 不可用（${cause instanceof Error ? cause.message : String(cause)}）`;
  }
}

/**
 * cheat code + debug API + snapshot/revert 都可用嗎？任何一個不行，就讓「需要造狀態」的測試 skip，
 * 而不是紅——環境不在不是這支程式的錯，但把「造不出狀態」寫成通過才是。
 */
async function probeDeal(): Promise<string | null> {
  try {
    const candidates = await balanceStorageCandidates(NVDAB, ACCOUNT);
    if (candidates.length === 0) return 'debug_traceCall 沒有回傳任何 SLOAD：這顆 anvil 沒開 debug API';
    const slot = candidates[0];
    if (slot === undefined) return 'debug_traceCall 沒有回傳任何 SLOAD';
    // 隔離機制本身也要能用：snapshot → 寫一格（寫回同一個值）→ revert，三步都成功才算數。
    const snapshotId = await takeSnapshot();
    try {
      await writeSlot(NVDAB, slot, await readSlot(NVDAB, slot));
    } finally {
      await revertSnapshot(snapshotId);
    }
    return null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return `anvil 的 debug_traceCall / anvil_setStorageAt / snapshot-revert 不可用（${message}）`;
  }
}

/**
 * 這組測試綁在 **dev fixture**（portfolio 5 的鏈上策略與 smart account）。
 *
 * 那不是自足的：在乾淨的資料庫上 portfolio 5 不存在，`smartAccountOf` 會在檔案層級拋錯 ——
 * 表現出來是「1 error」而且**沒有測試名**，比紅燈更難查。
 * 所以在整理 skip 原因時就把「fixture 不在」當成一種 skip，並說清楚缺什麼。
 * TODO：改成自己 enroll 一個 portfolio（成本較高，見 D-35）。
 */
const FIXTURE = `dev fixture 不在：portfolio ${PORTFOLIO_ID} 在 chain ${EXPECTED_CHAIN_ID} 上沒有 smart account（這組測試綁在 dev seed 的資料上）`;

async function probeFixture(): Promise<string | null> {
  try {
    await smartAccountOf(PORTFOLIO_ID, EXPECTED_CHAIN_ID);
    return null;
  } catch {
    return FIXTURE;
  }
}

const skipReason = (await probeFork()) ?? (await probeDb()) ?? (await probeFixture());
if (skipReason !== null) {
  console.warn(`[snapshot.integration] 整組 skip：${skipReason}`);
}
const gate = skipReason === null ? {} : { skip: skipReason };

// ACCOUNT 要在 probeDeal 之前定好（probeDeal 要 trace 這個帳戶的 balanceOf）。
const ACCOUNT =
  skipReason === null
    ? await smartAccountOf(PORTFOLIO_ID, EXPECTED_CHAIN_ID)
    : ('0x0000000000000000000000000000000000000000' as Address);

const dealSkipReason = skipReason === null ? await probeDeal() : null;
if (dealSkipReason !== null) {
  console.warn(`[snapshot.integration] 「發餘額」的測試 skip：${dealSkipReason}`);
}
const dealGate = skipReason === null && dealSkipReason === null ? {} : { skip: dealSkipReason ?? skipReason ?? 'unknown' };

async function plan(thresholdBps = THRESHOLD_BPS, block?: bigint) {
  return planPortfolio(PORTFOLIO_ID, {
    publicClient,
    registryAddress: REGISTRY_ADDRESS,
    chainId: EXPECTED_CHAIN_ID,
    thresholdBps,
    block,
  });
}

after(async () => {
  // 掃描游標是這支測試自己跑的副作用（planPortfolio 會推進它），收工要清掉：
  // 留一列會讓下一次跑測試從別人的歷史接著掃。holdings-scan.test.ts 對同一個 portfolio 做一樣的事。
  await query('delete from portfolio_scan_cursors where portfolio_id = $1', [PORTFOLIO_ID]).catch(() => {
    // DB 不可用時整組本來就 skip 了，這裡不該蓋掉測試結果。
  });
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. 現況：帳戶只有 gas 用的 BNB
// ---------------------------------------------------------------------------

test('planPortfolio(5)：帳戶只有 native BNB、所有 bStock 餘額為 0 → 空倉漂移 5000 bps', dealGate, async () => {
  // 這個測試要求空倉——空倉由這一行自己造（snapshot 內把策略資產全部清零），跑完一定 revert。
  await withChainState([], async () => {
    const result = await plan();

    assert.ok(result.snapshot.nativeBalanceWei > 0n, 'native BNB 應該 > 0（這個帳戶是拿來付 gas 的）');
    assert.deepEqual(result.snapshot.holdings, [], '不該有任何投資部位');
    assert.ok(result.snapshot.block > 0n);
    // 讀取與定價的宇宙 == version.assets（這個策略是 WBNB + USDT），兩者都有價格來源。
    // 查價表上那幾顆沒池的 bStock（CRCLB/MUB/TSLAB）**不再被讀**：它們不是策略資產，
    // 執行器換不掉它們（AtpExecutor.sol:180-182），所以它們不在分母裡，也不該出現在 unpriced。
    assert.deepEqual(result.snapshot.unpriced, [], '沒有無價的「策略資產」');

    // 目標版本來自鏈上 enrollment，不是 DB 的 portfolios.version。
    const enrollment = await publicClient.readContract({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: 'enrollments',
      args: [ACCOUNT],
    });
    assert.equal(result.pinnedVersion.onchainStrategyId, Number(enrollment[0]));
    assert.equal(result.pinnedVersion.version, Number(enrollment[1]));
    assert.ok(result.pinnedVersion.version >= 1, 'enrollment.version 必須 >= 1（0 會解析成 active version）');

    assert.ok(result.report !== null, '沒有無價持倉、allocation 一致 → 應該算得出漂移');
    assert.equal(result.report.totalUsdE8, 0n);
    assert.equal(result.report.grossDriftBps, 5000);
    assert.equal(result.report.needsRebalance, true);
    assert.equal(result.report.thresholdBps, THRESHOLD_BPS);
    assert.equal(
      result.targets.reduce((sum, target) => sum + target.weightBps, 0),
      10_000,
    );

    // 掃描與持倉是同一份觀測（真鏈上的那一份）：兩邊的塊必須逐位相同，而掃描本身跑得起來
    // （成功或明確失敗，不會拋錯——掃描失敗只會讓 universe_complete 變 false）。
    assert.equal(result.scan.block, result.snapshot.block, '掃描的 head 與 readPositions 的 block 必須是同一個塊');
    assert.equal(result.scan.portfolioId, PORTFOLIO_ID);
    assert.equal(result.scan.unknownHoldings.length, 0, `這個空倉帳戶不該有宇宙外持倉：${JSON.stringify(result.scan.unknownHoldings.map((holding) => holding.asset))}`);
    // fork 讀不到部署塊（403 archive）時這一欄一定是 false；它是「未確認」而不是 blocker，
    // 所以 report 仍然有值（上面的斷言）。這一條把「兩個問題是分開的」釘在真環境上。
    assert.equal(
      result.scan.universeComplete,
      result.scan.incompleteReasons.length === 0,
      'universe_complete 必須等價於「沒有任何不完整的原因」',
    );
    assert.deepEqual(
      result.blocked.map((blocked) => blocked.code),
      [],
      'universe_complete = false 不是 blocked 的理由（那是「還不知道」，不是「知道有問題」）',
    );

    console.log(
      `[1] portfolio ${PORTFOLIO_ID} block=${result.snapshot.block} native=${result.snapshot.nativeBalanceWei} wei ` +
        `holdings=${result.snapshot.holdings.length} total=${result.report.totalUsdE8} gross=${result.report.grossDriftBps}bps ` +
        `pinned v${result.pinnedVersion.version}（鏈上 strategy #${result.pinnedVersion.onchainStrategyId}）` +
        `、scan.block=${result.scan.block} 游標=[${result.scan.cursor.startBlock}, ${result.scan.cursor.lastScannedBlock}] ` +
        `universeComplete=${result.scan.universeComplete}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. DB 的 allocation 與鏈上 registry.version() 一致
// ---------------------------------------------------------------------------

test('DB 的 {address, weightBps} 與鏈上 registry.version(enrollment) 完全一致', gate, async () => {
  const result = await plan();
  assert.equal(result.allocationCheck.consistent, true, result.allocationCheck.mismatches.join('；'));

  // 直接從 DB 再讀一次同一個版本，跟鏈上 registry.version(strategyId, enrollment.version) 逐筆比。
  const rows = await query<{ allocation: { assets: { address: string; weightBps: number }[] } }>(
    'select allocation from strategy_versions where strategy_id = $1 and version = $2',
    [result.strategyId, result.pinnedVersion.version],
  );
  const allocation = rows.rows[0]?.allocation;
  assert.ok(allocation, `DB 沒有 strategy_versions(${result.strategyId}, ${result.pinnedVersion.version})`);
  const fromDb = allocation.assets.map((asset) => [asset.address.toLowerCase(), asset.weightBps] as const);
  const fromChain = result.allocationCheck.chain.map((target) => [target.asset, target.weightBps] as const);

  assert.deepEqual(fromDb, fromChain);
  console.log(
    `[2] DB strategy_versions(${result.strategyId}, v${result.pinnedVersion.version}) = ` +
      `${fromDb.map(([asset, bps]) => `${asset} ${bps}bps`).join('、')}；與鏈上逐位相同`,
  );
});

// ---------------------------------------------------------------------------
// 3. 端到端：真的非零持倉 → 漂移
// ---------------------------------------------------------------------------

test('端到端：發一筆非零 NVDAB（策略外持倉）→ 不讀、不計價、不影響漂移', dealGate, async () => {
  const wanted = 100n * 10n ** 18n;
  await withChainState([{ token: NVDAB, amountWei: wanted }], async (actual) => {
    const granted = actual.get(NVDAB.toLowerCase());
    assert.ok(granted !== undefined && granted > 0n, '餘額沒有真的變成非零（否則這個測試沒驗到東西）');

    const result = await plan();
    // 鏈上真的持有 100 顆 NVDAB，但 NVDAB 不在 version.assets 裡：
    // 執行器換不掉它（AtpExecutor.sol:180-182）→ 它不可能參與再平衡 → 它不在漂移的分母裡。
    assert.equal(
      result.snapshot.holdings.some((entry) => entry.asset === NVDAB.toLowerCase()),
      false,
      '策略外持倉不該進 holdings',
    );
    assert.equal(
      result.snapshot.unpriced.some((entry) => entry.asset === NVDAB.toLowerCase()),
      false,
      '也不該被當成「無價的策略資產」而擋下漂移',
    );
    assert.deepEqual(result.blocked, [], `空投不該產生任何 blocker：${result.blocked.map((b) => b.detail).join('；')}`);
    assert.ok(result.report !== null, '漂移照算');
    // 舊語意會把這 100 顆算進總額、把漂移從「空倉 5000」變成別的數字（或直接 blocked）。
    assert.equal(result.report.totalUsdE8, 0n, '策略外持倉不進總額（分母）');
    assert.equal(result.report.grossDriftBps, 5_000, '仍然是空倉的定義值：空投沒有改變任何東西');
    assert.equal(
      result.report.assets.some((asset) => asset.asset === NVDAB.toLowerCase()),
      false,
      '策略外持倉不該出現在漂移報告裡',
    );

    console.log(
      `[3] 帳戶真的持有 ${granted / 10n ** 18n} 顆 NVDAB（策略外）→ holdings=${result.snapshot.holdings.length}、` +
        `unpriced=${result.snapshot.unpriced.length}、blocked=${result.blocked.length}、` +
        `total=${result.report.totalUsdE8} gross=${result.report.grossDriftBps}bps（空倉定義值，空投不影響）`,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 同一個 block 寫兩次 → UPDATE，列數不變；無價持倉的列是 NULL
// ---------------------------------------------------------------------------

test('同一個 block 寫兩次 → 表頭與明細都是 UPDATE（列數不變）；無價策略資產寫成 NULL，complete = false', dealGate, async () => {
  const wanted = 2n * 10n ** 18n;
  await withChainState([{ token: WBNB, amountWei: wanted }], async (actual) => {
    const granted = actual.get(WBNB.toLowerCase());
    assert.ok(granted !== undefined && granted > 0n, '餘額沒有真的變成非零（否則這個測試沒驗到東西）');

    const planned = await plan();
    assert.deepEqual(planned.blocked, [], `持有策略資產不該 blocked：${planned.blocked.map((b) => b.detail).join('；')}`);
    assert.ok(planned.report !== null);
    const wbnbHolding = planned.snapshot.holdings.find((holding) => holding.asset === WBNB.toLowerCase());
    assert.ok(wbnbHolding, 'WBNB 餘額非零卻不在 holdings 裡');
    assert.equal(wbnbHolding.priceSource, 'pancakeswap-v3');

    // 這條測的是**寫入路徑**（表頭 + 明細 + 0008 的 CHECK），不是鏈。
    // 這個部署的 version.assets（WBNB/USDT）都有價格來源，鏈上造不出「無價的策略資產」，
    // 所以那一列用注入的：`writeSnapshot` 的契約是 snapshot 物件，不是鏈。
    // （「策略資產無價 → blocked」這條規則在 positions.test.ts 用 stub 驗，那裡才造得出無池的策略資產。）
    const snapshot = {
      ...planned.snapshot,
      unpriced: [
        ...planned.snapshot.unpriced,
        { asset: TSLAB.toLowerCase(), symbol: 'TSLAB', amountWei: 3n * 10n ** 18n, decimals: 18, reason: 'no_usdt_pool' },
      ],
    };
    const block = planned.snapshot.block;
    await clearSnapshots(PORTFOLIO_ID, block);

    try {
      const deps = { pinnedVersion: planned.pinnedVersion.version, scan: planned.scan };
      // report = null：這一份快照「算不出漂移」（含一列無價資產），表頭因此 complete = false。
      const first = await writeSnapshot(snapshot, null, deps);
      const afterFirst = await countRows(PORTFOLIO_ID, block);
      const second = await writeSnapshot(snapshot, null, deps);
      const afterSecond = await countRows(PORTFOLIO_ID, block);

      assert.deepEqual(first, { headerInserted: true, inserted: 2, updated: 0 }, '第一次應該是兩列全新（1 有價 + 1 無價）');
      assert.deepEqual(
        second,
        { headerInserted: false, inserted: 0, updated: 2 },
        '第二次必須是 UPDATE（表頭與明細都是），不是新增',
      );
      assert.equal(afterFirst, 2);
      assert.equal(afterSecond, afterFirst, '同一個 block 的明細列數不該變');
      assert.equal(await countHeaders(PORTFOLIO_ID, block), 1, '同一個 block 只能有一列表頭');

      const rows = await query<{ asset: string; amount: string; usd_value: string | null; price_source: string | null; priced_at: Date | null }>(
        `select asset, amount, usd_value, price_source, priced_at
           from positions_snapshots
          where portfolio_id = $1 and block = $2
          order by asset`,
        [PORTFOLIO_ID, block.toString()],
      );
      const priced = rows.rows.find((row) => row.asset === WBNB.toLowerCase());
      const unpriced = rows.rows.find((row) => row.asset === TSLAB.toLowerCase());
      assert.ok(priced && unpriced);
      assert.equal(priced.price_source, 'pancakeswap-v3');
      assert.ok(priced.priced_at instanceof Date);
      assert.ok(priced.usd_value !== null);
      assert.equal(unpriced.usd_value, null);
      assert.equal(unpriced.price_source, null);
      assert.equal(unpriced.priced_at, null);

      // 設計 (a) 在資料層的證據：這批列拿去算漂移會直接被擋，不會算出一份看起來合理的爛數字。
      assert.throws(
        () => parseSnapshotRows(rows.rows.map((row) => ({ asset: row.asset, amount: row.amount, usd_value: row.usd_value }))),
        /price it before computing drift/,
      );

      // 表頭：拒算 → complete = false，而「不可信」被 0008 的 CHECK 綁成 0/false 的組合。
      const header = await readHeader(PORTFOLIO_ID, block);
      assert.ok(header, '有明細就必須有表頭');
      assert.equal(header.complete, false, '持有無價的策略資產 → 這一輪的 drift 不可信');
      assert.equal(header.gross_drift_bps, 0, '沒算就是 0，不是「已對齊」');
      assert.equal(header.max_abs_delta_bps, 0);
      assert.equal(header.needs_rebalance, false, 'false 是「不能判斷」，判讀前必須先看 complete');
      assert.equal(header.unpriced_count, 1, '只有 TSLAB 是持有的無價策略資產');
      assert.equal(header.threshold_bps, planned.thresholdBps);
      assert.equal(header.pinned_version, planned.pinnedVersion.version);
      // 觀測欄位：表頭的值必須等於這一輪掃描看到幾個策略外持倉（不假設是 0——真的 fork 上可能有）。
      assert.equal(
        header.unknown_token_count,
        planned.scan.unknownHoldings.length,
        'unknown_token_count 必須等於這一輪掃到的策略外持倉個數',
      );
      assert.equal(header.universe_complete, planned.scan.universeComplete);
      // complete = false 時 total 是「已定價部位的部分總額」（這裡只有 WBNB）。
      assert.equal(
        header.total_usd_e8,
        ((wbnbHolding.amountWei * wbnbHolding.usdPriceE8) / 10n ** 18n).toString(),
      );

      // 資料層自己會拒絕那個最容易誤讀的組合：沒算過卻帶著一份看起來可信的漂移。
      await assert.rejects(
        () =>
          query(
            `insert into portfolio_snapshots (portfolio_id, block, native_balance_wei, total_usd_e8,
               gross_drift_bps, max_abs_delta_bps, threshold_bps, needs_rebalance, complete, unpriced_count)
             values ($1, $2, '0', '0', 5000, 5000, 100, true, false, 1)`,
            [PORTFOLIO_ID, (block + 1_000_000n).toString()],
          ),
        /portfolio_snapshots_incomplete_has_no_drift/,
      );

      // 0011：策略外持倉（空投）**不再**讓 complete 變 false，所以這個組合現在必須寫得進去。
      // 反過來（0009 的約束還在）空投一進來 writeSnapshot 就撞約束，索引器直接掛掉——比修正前更糟。
      const airdropBlock = block + 1_000_002n;
      await query(
        `insert into portfolio_snapshots (portfolio_id, block, native_balance_wei, total_usd_e8,
           gross_drift_bps, max_abs_delta_bps, threshold_bps, needs_rebalance, complete, unpriced_count,
           unknown_token_count, universe_complete)
         values ($1, $2, '0', '0', 5000, 5000, 100, true, true, 0, 1, true)`,
        [PORTFOLIO_ID, airdropBlock.toString()],
      );
      const airdropRow = await query(
        'select unknown_token_count, complete from portfolio_snapshots where portfolio_id = $1 and block = $2',
        [PORTFOLIO_ID, airdropBlock.toString()],
      );
      assert.deepEqual(
        airdropRow.rows[0],
        { unknown_token_count: 1, complete: true },
        '(unknown_token_count > 0, complete = true) 在 0011 之後是正常狀態：空投被記錄，但漂移仍然可信',
      );
      await clearSnapshots(PORTFOLIO_ID, airdropBlock);

      console.log(
        `[4] block=${block} 第一次 header=${first.headerInserted ? '新增' : '更新'}/明細 inserted=${first.inserted}/updated=${first.updated}、` +
          `第二次 header=${second.headerInserted ? '新增' : '更新'}/明細 inserted=${second.inserted}/updated=${second.updated}、` +
          `明細列數 ${afterFirst} → ${afterSecond}、表頭 complete=${header.complete} gross=${header.gross_drift_bps}bps ` +
          `needs=${header.needs_rebalance} unpriced=${header.unpriced_count} total=${header.total_usd_e8}；` +
          `WBNB usd_value=${priced.usd_value} price_source=${priced.price_source}、TSLAB usd_value=NULL；` +
          `0011 驗證：unknown_token_count=1 且 complete=true 的列寫得進去`,
      );
    } finally {
      await clearSnapshots(PORTFOLIO_ID, block);
    }
  });
});

// ---------------------------------------------------------------------------
// 4b. 端到端：非零 WBNB（目標資產、fee 500 的 USDT 池）
// ---------------------------------------------------------------------------

test('端到端：發一筆非零 WBNB → 走 fee 500 的 USDT 池定價，漂移逐位對得上', dealGate, async () => {
  const wanted = 3n * 10n ** 18n;
  await withChainState([{ token: WBNB, amountWei: wanted }], async (actual) => {
    const granted = actual.get(WBNB.toLowerCase());
    assert.ok(granted !== undefined && granted > 0n, '餘額沒有真的變成非零');

    const result = await plan();
    const holding = result.snapshot.holdings.find((entry) => entry.asset === WBNB.toLowerCase());
    assert.ok(holding, 'WBNB 餘額非零卻不在 holdings 裡（修 A 之前它是 unpriced/no_usdt_pool，整份漂移被拒算）');
    assert.equal(holding.priceSource, 'pancakeswap-v3', 'WBNB 走 TWAP，不是 numeraire');
    assert.equal(holding.amountWei, granted);
    assert.equal(
      result.snapshot.unpriced.some((asset) => asset.asset === WBNB.toLowerCase()),
      false,
      'WBNB 不該再被列成無價',
    );

    // 獨立報價一次，釘在**同一個 block**：價格是同一份 observe 算出來的，所以逐位相同（不留容差）。
    const independent = await twapPriceInUsdt(publicClient, {
      token: WBNB,
      usdtPool: WBNB_USDT_POOL,
      expectedQuoteToken: USDT,
      blockNumber: result.snapshot.block,
    });
    assert.equal(
      holding.usdPriceE8,
      independent.priceE8,
      `WBNB 價格 ${holding.usdPriceE8} 與同一個 block（${result.snapshot.block}）的獨立報價 ${independent.priceE8} 不同：價格沒有釘在塊上`,
    );

    assert.ok(result.report !== null, `漂移被拒算了：${result.blocked.map((blocked) => blocked.detail).join('；')}`);
    const expectedTotal = (granted * holding.usdPriceE8) / 10n ** 18n;
    assert.equal(result.report.totalUsdE8, expectedTotal);

    // 只有 WBNB 有餘額：current 10000bps；目標是 WBNB/USDT 各 5000（portfolio 5 的 v1）。
    const wbnbRow = result.report.assets.find((entry) => entry.asset === WBNB.toLowerCase());
    const usdtRow = result.report.assets.find((entry) => entry.asset === USDT.toLowerCase());
    assert.ok(wbnbRow && usdtRow);
    assert.deepEqual(
      [wbnbRow.targetBps, wbnbRow.currentBps, wbnbRow.deltaBps],
      [5_000, 10_000, 5_000],
    );
    assert.deepEqual([usdtRow.targetBps, usdtRow.currentBps, usdtRow.deltaBps], [5_000, 0, -5_000]);
    assert.equal(result.report.maxAbsDeltaBps, 5_000);
    assert.equal(result.report.grossDriftBps, 5_000);
    assert.equal(result.report.needsRebalance, true);

    // 同一個 block 重跑整條路徑：持倉與總額都必須逐位相同。價格若讀 head 而不是這個塊，
    // 這裡遲早會漂（TWAP 每 3 秒動一次），漂多少不重要——「同一份觀測」本身就不成立。
    const again = await plan(THRESHOLD_BPS, result.snapshot.block);
    assert.equal(again.snapshot.block, result.snapshot.block);
    assert.deepEqual(again.snapshot.holdings, result.snapshot.holdings, '同一個 block 重跑，holdings 不同');
    assert.equal(again.report?.totalUsdE8, result.report.totalUsdE8, '同一個 block 重跑，總額不同');

    console.log(
      `[4b] WBNB balance=${granted} wei（${granted / 10n ** 18n} 顆）price=${holding.usdPriceE8}（$1e8，同 block 獨立報價 ${independent.priceE8}）` +
        `；同 block 重跑 total=${again.report?.totalUsdE8}（一致）` +
        `total=${result.report.totalUsdE8}（$1e8）WBNB target=${wbnbRow.targetBps} current=${wbnbRow.currentBps} delta=+${wbnbRow.deltaBps}bps、` +
        `USDT target=${usdtRow.targetBps} current=${usdtRow.currentBps} delta=${usdtRow.deltaBps}bps、` +
        `maxAbs=${result.report.maxAbsDeltaBps}bps gross=${result.report.grossDriftBps}bps needsRebalance=${result.report.needsRebalance}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 策略外的無池資產（TSLAB）→ 只記錄，不擋漂移（舊語意會擋）
//    「策略資產無價 → 仍然 blocked」是另一條規則，驗在 positions.test.ts
//    （這個部署的 version.assets 是 WBNB/USDT，兩者都有價，鏈上造不出無價的策略資產）。
// ---------------------------------------------------------------------------

test('只持有策略外無池資產（TSLAB）→ 不 blocked、漂移照算（空投不是 blocker）', dealGate, async () => {
  await withChainState([{ token: TSLAB, amountWei: 7n * 10n ** 18n }], async () => {
    const result = await plan();

    assert.deepEqual(
      result.blocked,
      [],
      `策略外持倉不該 blocked：${result.blocked.map((blocked) => blocked.detail).join('；')}`,
    );
    assert.ok(result.report !== null, '漂移照算');
    assert.equal(result.report.totalUsdE8, 0n, 'TSLAB 不在分母裡');
    assert.equal(result.report.grossDriftBps, 5_000, '仍是空倉的定義值');
    assert.equal(
      result.snapshot.unpriced.some((asset) => asset.asset === TSLAB.toLowerCase()),
      false,
      '策略外持倉不該被列成「無價的策略資產」',
    );
    // 目標權重照樣讀得到（那是 DB + 鏈的事）。
    assert.equal(
      result.targets.reduce((sum, target) => sum + target.weightBps, 0),
      10_000,
    );
    console.log(
      `[5] 策略外 TSLAB 7 顆 → blocked=${result.blocked.length} report.gross=${result.report.grossDriftBps}bps ` +
        `total=${result.report.totalUsdE8}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. 表頭：空倉也要有一列（「跑過且是空的」與「根本沒跑」的差別）
// ---------------------------------------------------------------------------

test('空倉 → 表頭 1 列、明細 0 列；complete = true 且漂移是空倉的定義值', dealGate, async () => {
  // 這個測試要求空倉——空倉由這一行自己造（snapshot 內把策略資產全部清零），跑完一定 revert。
  await withChainState([], async () => {
    const result = await plan();
    assert.deepEqual(result.snapshot.holdings, [], '這個測試要求空倉：帳戶不該有任何投資部位');
    assert.deepEqual(result.snapshot.unpriced.filter((asset) => asset.amountWei > 0n), [], '空倉不該有持有的無價資產');
    assert.ok(result.report !== null);

    const block = result.snapshot.block;
    await clearSnapshots(PORTFOLIO_ID, block);
    try {
      const written = await writeSnapshot(result.snapshot, result.report, {
        thresholdBps: result.thresholdBps,
        pinnedVersion: result.pinnedVersion.version,
        scan: result.scan,
      });
      assert.deepEqual(written, { headerInserted: true, inserted: 0, updated: 0 }, '空倉也要寫入，只是只有表頭');

      assert.equal(await countRows(PORTFOLIO_ID, block), 0, '空倉不該有明細列');
      assert.equal(await countHeaders(PORTFOLIO_ID, block), 1, '空倉必須有 1 列表頭，否則下游分不出「沒跑」');

      const header = await readHeader(PORTFOLIO_ID, block);
      assert.ok(header);
      assert.equal(header.complete, true, '空倉的漂移是算得出來的（定義值是 5000），不是拒算');
      assert.equal(header.total_usd_e8, '0');
      assert.equal(header.gross_drift_bps, 5_000, 'drift.ts 對空倉的定義就是 5000，不是 0');
      assert.equal(header.needs_rebalance, true, '空帳戶完全不在目標上，keeper 該知道');
      assert.equal(header.unpriced_count, 0);
      assert.equal(header.threshold_bps, result.thresholdBps);
      assert.equal(header.pinned_version, result.pinnedVersion.version);
      assert.equal(header.native_balance_wei, result.snapshot.nativeBalanceWei.toString());
      // 0009：這兩個欄位是真的寫進 portfolio_snapshots（不是只存在記憶體裡的 plan）。
      assert.equal(header.unknown_token_count, 0, '空倉 → 這一輪沒有任何宇宙外持倉');
      assert.equal(header.universe_complete, result.scan.universeComplete);

      console.log(
        `[6] 空倉 header: complete=${header.complete} total_usd_e8=${header.total_usd_e8} gross=${header.gross_drift_bps}bps ` +
          `needs=${header.needs_rebalance} unpriced=${header.unpriced_count} pinned=v${header.pinned_version} ` +
          `unknown_token_count=${header.unknown_token_count} universe_complete=${header.universe_complete} ` +
          `native=${header.native_balance_wei} wei；明細 ${await countRows(PORTFOLIO_ID, block)} 列`,
      );
    } finally {
      await clearSnapshots(PORTFOLIO_ID, block);
    }
  });
});
