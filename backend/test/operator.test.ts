import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress, keccak256, toBytes } from 'viem';
import type { Hex, PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

import { ForbiddenError } from '../src/errors.js';
import type { HoldingScanResult } from '../src/holdings-scan.js';
import {
  OPERATOR_REBALANCE_ENV,
  STATUS_CACHE_TTL_MS,
  createPortfolioStatusReader,
  narrowClaimToPortfolio,
  operatorRebalanceEnabled,
  resolveStatusSessionKey,
  previewOperatorRebalance,
  runOperatorRebalance,
  singlePortfolioClaim,
  listPortfolioActivity,
} from '../src/operator.js';
import { listPriceableAssets } from '../src/assets.js';
import type { OperatorRebalanceResult, PortfolioStatus } from '../src/operator.js';
import { NUMERAIRE_PRICE_SOURCE, TWAP_PRICE_SOURCE } from '../src/positions.js';
import type { PortfolioRunResult, runSchedulerOnce } from '../src/scheduler.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';
import type { PortfolioPlan } from '../src/snapshot.js';

/**
 * `GET /portfolios/:id/status` 與 `POST /portfolios/:id/rebalance` 的測試。
 *
 * 兩支都走真的路由，只把「鏈」與「DB」換成替身：
 *   * status：注入 `planPortfolio`（真的那一份要掃日誌＋讀池子，單元測試不該碰鏈），驗的是
 *     **快取語意**（TTL、連點共用、失敗不快取）與**回應形狀**（漂移/持倉/blocked 的一致）。
 *   * rebalance：注入 `runSchedulerOnce`，驗的是**開關**（預設關閉、403 時一次都沒被叫到）
 *     與**認領範圍的縮減**（只認領這一個 portfolio，SQL 換了形狀就中止）。
 */

const WALLET = privateKeyToAccount(generatePrivateKey());
const OTHER_WALLET = privateKeyToAccount(generatePrivateKey());
const PORTFOLIO_ID = 305;
const ACCOUNT = getAddress('0xb008dcffa89000f8ad7c3af9ddf320bdbb7b1de5');
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function samplePlan(overrides: Partial<PortfolioPlan> = {}): PortfolioPlan {
  return {
    portfolioId: PORTFOLIO_ID,
    strategyId: 447,
    account: ACCOUNT,
    chainId: 56,
    snapshot: {
      portfolioId: PORTFOLIO_ID,
      block: 132_164_357n,
      nativeBalanceWei: 10n ** 16n,
      holdings: [
        // 1 WBNB @ 500 USD、以及 100 USDT：usdValue 分別是 500e8 與 100e8。
        { asset: WBNB, amountWei: 10n ** 18n, decimals: 18, usdPriceE8: 50_000_000_000n, priceSource: TWAP_PRICE_SOURCE },
        { asset: USDT, amountWei: 100n * 10n ** 18n, decimals: 18, usdPriceE8: 100_000_000n, priceSource: NUMERAIRE_PRICE_SOURCE },
      ],
      unpriced: [],
    },
    // status 只讀 snapshot / report / targets / blocked，掃描結果不是它的事（真的那一份要碰鏈）。
    scan: {} as HoldingScanResult,
    report: {
      totalUsdE8: 60_000_000_000n,
      assets: [
        { asset: WBNB, targetBps: 5000, currentBps: 8333, deltaBps: 3333, usdValueE8: 50_000_000_000n },
        { asset: USDT, targetBps: 5000, currentBps: 1667, deltaBps: -3333, usdValueE8: 10_000_000_000n },
      ],
      maxAbsDeltaBps: 3333,
      grossDriftBps: 3333,
      needsRebalance: true,
      thresholdBps: 100,
    },
    blocked: [],
    targets: [
      { asset: WBNB, weightBps: 5000, symbol: 'WBNB' },
      { asset: USDT, weightBps: 5000, symbol: 'USDT' },
    ],
    pinnedVersion: { version: 1, onchainStrategyId: 3, paused: false },
    allocationCheck: { consistent: true, chain: [], mismatches: [] },
    thresholdBps: 100,
    ...overrides,
  };
}

const SYMBOL_ROWS = [
  { address: WBNB, symbol: 'WBNB' },
  { address: USDT, symbol: 'USDT' },
];

/** 一個「DB 只有 priceable_assets 一張表」的 query 替身。 */
function symbolQuery(rows: unknown[] = SYMBOL_ROWS) {
  return async (text: string) => {
    assert.match(text, /priceable_assets/, 'status 只該打 priceable_assets 這一個查詢');
    return { rows };
  };
}

// ---------------------------------------------------------------------------
// 狀態回應的形狀
// ---------------------------------------------------------------------------

test('status 回傳漂移、持倉、目標與 blocked，並且持倉的 usdValueE8 與漂移報告逐位相同', async () => {
  const reader = createPortfolioStatusReader({
    planPortfolio: async () => samplePlan(),
    requireOwnedPortfolio: async () => undefined as never,
    query: symbolQuery(),
  });

  const status = await reader(PORTFOLIO_ID, WALLET.address);

  assert.equal(status.portfolioId, PORTFOLIO_ID);
  assert.equal(status.block, '132164357');
  assert.equal(status.totalUsdE8, '60000000000');
  assert.equal(status.complete, true);
  assert.deepEqual(status.blocked, []);
  assert.equal(status.drift?.grossDriftBps, 3333);
  assert.equal(status.drift?.needsRebalance, true);
  assert.equal(status.drift?.thresholdBps, 100);

  // 大數字一律是字串（bigint 不進 JSON）。
  assert.equal(typeof status.holdings[0]?.amountWei, 'string');
  // 1 WBNB × 500 USD = 500e8；與 report.assets 的 usdValueE8 是同一個數字，不是各算一次。
  assert.equal(status.holdings[0]?.usdValueE8, '50000000000');
  assert.equal(status.holdings[0]?.usdValueE8, status.drift?.assets[0]?.usdValueE8);
  assert.equal(status.holdings[0]?.priceSource, 'pancakeswap-v3');
  // 目標表的 ticker 來自 allocation（`symbol`），不是地址截斷。
  assert.deepEqual(
    status.targets.map((target) => `${target.symbol}:${String(target.weightBps)}`),
    ['WBNB:5000', 'USDT:5000'],
  );
});

test('status 在 blocked 時回報原因、drift 是 null、complete 是 false（不是一個看起來正常的空狀態）', async () => {
  const reader = createPortfolioStatusReader({
    planPortfolio: async () =>
      samplePlan({
        report: null,
        blocked: [{ code: 'UNPRICED_HOLDINGS', detail: 'WBNB 沒有可用價格：pricing_failed:NO_POOL' }],
        snapshot: {
          portfolioId: PORTFOLIO_ID,
          block: 7n,
          nativeBalanceWei: 0n,
          holdings: [
            { asset: WBNB, amountWei: 10n ** 18n, decimals: 18, usdPriceE8: 50_000_000_000n, priceSource: TWAP_PRICE_SOURCE },
          ],
          unpriced: [{ asset: USDT, symbol: 'USDT', amountWei: 5n, decimals: 18, reason: 'no_usdt_pool' }],
        },
      }),
    requireOwnedPortfolio: async () => undefined as never,
    query: symbolQuery(),
  });

  const status = await reader(PORTFOLIO_ID, WALLET.address);
  assert.equal(status.complete, false);
  assert.equal(status.drift, null);
  assert.equal(status.totalUsdE8, null);
  assert.equal(status.blocked[0]?.code, 'UNPRICED_HOLDINGS');
  assert.match(status.blocked[0]?.detail ?? '', /NO_POOL/);
  assert.equal(status.unpriced[0]?.reason, 'no_usdt_pool');
  // 沒有漂移報告時仍然算得出持倉的 USD 值（公式與 drift.ts 相同：乘法後截斷）。
  assert.equal(status.holdings[0]?.usdValueE8, '50000000000');
});

test('status 讀不到 ticker 時整支 503，不回一份沒有 ticker 的表', async () => {
  const reader = createPortfolioStatusReader({
    planPortfolio: async () => samplePlan(),
    requireOwnedPortfolio: async () => undefined as never,
    query: async () => {
      throw new Error('relation "priceable_assets" does not exist');
    },
    log: () => undefined,
  });

  await assert.rejects(reader(PORTFOLIO_ID, WALLET.address), (error: unknown) => {
    const err = error as { status?: number; code?: string; message?: string };
    assert.equal(err.status, 503);
    assert.equal(err.code, 'STATUS_UNAVAILABLE');
    assert.match(err.message ?? '', /priceable_assets/);
    return true;
  });
});

test('planPortfolio 失敗時回 503 並帶上原因（不是 500，也不是空狀態）', async () => {
  const reader = createPortfolioStatusReader({
    planPortfolio: async () => {
      throw new Error('fork 過期：403 Must be authenticated!');
    },
    requireOwnedPortfolio: async () => undefined as never,
    query: symbolQuery(),
    log: () => undefined,
  });

  await assert.rejects(reader(PORTFOLIO_ID, WALLET.address), (error: unknown) => {
    const err = error as { status?: number; code?: string; message?: string };
    assert.equal(err.status, 503);
    assert.equal(err.code, 'STATUS_UNAVAILABLE');
    assert.match(err.message ?? '', /fork 過期/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 快取
// ---------------------------------------------------------------------------

test('TTL 內連點兩次只讀一次鏈，TTL 過了才重讀', async () => {
  let clock = 1_000;
  let calls = 0;
  const reader = createPortfolioStatusReader({
    planPortfolio: async () => {
      calls += 1;
      return samplePlan();
    },
    requireOwnedPortfolio: async () => undefined as never,
    query: symbolQuery(),
    now: () => clock,
  });

  await reader(PORTFOLIO_ID, WALLET.address);
  clock += STATUS_CACHE_TTL_MS - 1;
  await reader(PORTFOLIO_ID, WALLET.address);
  assert.equal(calls, 1, 'TTL 內第二次必須命中快取');

  clock += 2;
  await reader(PORTFOLIO_ID, WALLET.address);
  assert.equal(calls, 2, 'TTL 過了必須重讀');
});

test('同時進來的兩個請求共用同一次讀鏈（連點的真正殺傷力在「算到一半」那一刻）', async () => {
  let calls = 0;
  // 用「先給一個空的 release」而不是 `(() => void) | null`：控制流分析看得到初始值 `null`，
  // 卻看不到 callback 裡的賦值，於是 `release?.()` 會被判成呼叫 `never`（TS2349）。
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = createPortfolioStatusReader({
    planPortfolio: async () => {
      calls += 1;
      await gate;
      return samplePlan();
    },
    requireOwnedPortfolio: async () => undefined as never,
    query: symbolQuery(),
  });

  const first = reader(PORTFOLIO_ID, WALLET.address);
  const second = reader(PORTFOLIO_ID, WALLET.address);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test('失敗不快取：RPC 掛掉時下一個請求會真的重試', async () => {
  let calls = 0;
  const reader = createPortfolioStatusReader({
    planPortfolio: async () => {
      calls += 1;
      if (calls === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:8545');
      return samplePlan();
    },
    requireOwnedPortfolio: async () => undefined as never,
    query: symbolQuery(),
    log: () => undefined,
  });

  await assert.rejects(reader(PORTFOLIO_ID, WALLET.address));
  const status = await reader(PORTFOLIO_ID, WALLET.address);
  assert.equal(calls, 2);
  assert.equal(status.complete, true);
});

test('擁有者檢查在快取之前：命中快取也一定會再驗一次「這是你的嗎」', async () => {
  let owned = 0;
  let planned = 0;
  const reader = createPortfolioStatusReader({
    planPortfolio: async () => {
      planned += 1;
      return samplePlan();
    },
    requireOwnedPortfolio: async () => {
      owned += 1;
      return undefined as never;
    },
    query: symbolQuery(),
  });

  await reader(PORTFOLIO_ID, WALLET.address);
  await reader(PORTFOLIO_ID, WALLET.address);
  assert.equal(planned, 1, '第二次是快取');
  assert.equal(owned, 2, '兩次都必須經過擁有者檢查');
});

// ---------------------------------------------------------------------------
// ENABLE_OPERATOR_REBALANCE
// ---------------------------------------------------------------------------

test('operator rebalance 只認字面值 "true"（fail closed）', () => {
  assert.equal(operatorRebalanceEnabled({ [OPERATOR_REBALANCE_ENV]: 'true' } as NodeJS.ProcessEnv), true);
  for (const value of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    assert.equal(
      operatorRebalanceEnabled({ [OPERATOR_REBALANCE_ENV]: value } as NodeJS.ProcessEnv),
      false,
      `"${value}" 不該被當成開啟`,
    );
  }
  assert.equal(operatorRebalanceEnabled({} as NodeJS.ProcessEnv), false, '沒有這個變數就是關閉');
});

// ---------------------------------------------------------------------------
// 認領範圍：只動這一個 portfolio
// ---------------------------------------------------------------------------

/** 與 `scheduler.ts` 的 `SQL_CLAIM_DUE` 同形狀（含 `for update of p skip locked`）。 */
const CLAIM_SQL = `
  select p.id as portfolio_id,
         p.strategy_id,
         sa.address,
         sa.account_type,
         sv.schedule
    from portfolios p
    join smart_accounts sa
      on sa.portfolio_id = p.id
     and sa.chain_id = $2
    left join strategy_versions sv
      on sv.strategy_id = p.strategy_id
     and sv.version = p.version
   where p.schedule_state = 'active'
     and (p.next_run_at is null or p.next_run_at <= $1)
   order by p.next_run_at asc nulls first, p.id asc
   limit $3
     for update of p skip locked
`;

test('認領查詢被縮成單一 portfolio：WHERE 拿掉「到期」條件、保留 active、加上 p.id = $4', () => {
  const narrowed = narrowClaimToPortfolio(CLAIM_SQL, PORTFOLIO_ID);
  const from = narrowed.indexOf(' where ');
  const to = narrowed.indexOf(' order by ');
  assert.ok(from >= 0 && to > from, '必須還看得到 where / order by 兩段，否則下面切出來的 WHERE 是空的、什麼都驗不到');
  const where = narrowed.slice(from, to);
  // 「到期」條件只能從 WHERE 消失：按鈕的語意是「現在就跑」，不受排程時鐘限制，
  // 否則按了也可能因為「明天才到期」而什麼都不做。
  assert.doesNotMatch(where, /next_run_at/, '「到期」條件必須被拿掉，否則按了也可能什麼都不做');
  assert.match(where, /p\.schedule_state = 'active'/, '暫停的投組仍然要被擋住');
  assert.match(where, /and p\.id = \$4/, '縮成單一 portfolio（portfolio id 當第四個參數）');
  // 其餘結構（排序、limit、鎖）一位都不能動；ORDER BY 的 next_run_at 是**排序**不是篩選，必須留著。
  assert.match(narrowed, /order by p\.next_run_at asc nulls first, p\.id asc/);
  assert.match(narrowed, /limit \$3/);
  assert.match(narrowed, /for update of p skip locked/);
});

test('非認領查詢原樣放行（不能把 operations / last_checked_at 的寫入改掉）', () => {
  const other = 'update operations set state = $2 where idempotency_key = $1';
  assert.equal(narrowClaimToPortfolio(other, PORTFOLIO_ID), other);
});

test('認領 SQL 換了形狀就中止（寧可什麼都不做，也不要認領到別人的投組）', () => {
  const reshaped = CLAIM_SQL.replace("where p.schedule_state = 'active'", "where p.state = 'active'");
  assert.throws(() => narrowClaimToPortfolio(reshaped, PORTFOLIO_ID), /換了形狀/);
});

test('縮減後的認領只綁一個 portfolio id，而且只有認領查詢多一個參數', async () => {
  const seen: { text: string; params: readonly unknown[] }[] = [];
  const transaction = singlePortfolioClaim(PORTFOLIO_ID, async (fn) =>
    fn({
      query: async (text, params) => {
        seen.push({ text, params: params ?? [] });
        return { rows: [] };
      },
    }),
  );

  await transaction(async (client) => {
    await client.query(CLAIM_SQL, [new Date(0), 56, 20]);
    await client.query('select 1 from portfolios where id = $1', [PORTFOLIO_ID]);
  });

  assert.deepEqual(seen[0]?.params, [new Date(0), 56, 20, PORTFOLIO_ID]);
  assert.match(seen[0]?.text ?? '', /p\.id = \$4/);
  assert.deepEqual(seen[1]?.params, [PORTFOLIO_ID], '非認領查詢不能多一個參數');
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function withServer<T>(run: (baseUrl: string) => Promise<T>, deps: Partial<ServerDeps> = {}): Promise<T> {
  const server = createServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postJson(baseUrl: string, path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function getJson(baseUrl: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: 'GET', headers });
}

/** 真的走一次 SIWE：路由要驗的是「有 token 才進得去」，那就簽一張真的 token。 */
async function loginToken(baseUrl: string): Promise<string> {
  const nonceResponse = await fetch(`${baseUrl}/auth/nonce`, { method: 'POST' });
  assert.equal(nonceResponse.status, 200);
  const challenge = (await nonceResponse.json()) as {
    nonce: string;
    domain: string;
    chainId: number;
    uri: string;
    statement: string;
    issuedAt: string;
  };
  const message = createSiweMessage({
    address: WALLET.address,
    chainId: challenge.chainId,
    domain: challenge.domain,
    uri: challenge.uri,
    statement: challenge.statement,
    version: '1',
    nonce: challenge.nonce,
    issuedAt: new Date(challenge.issuedAt),
  });
  const login = await postJson(baseUrl, '/auth/login', {
    message,
    signature: await WALLET.signMessage({ message }),
  });
  assert.equal(login.status, 200);
  return ((await login.json()) as { token: string }).token;
}

const SAMPLE_STATUS: PortfolioStatus = {
  portfolioId: PORTFOLIO_ID,
  executorAddress: '0x9C41696ea7FaA5470eAfb77415D063beEef83f4a',
  block: '1',
  account: ACCOUNT,
  holdings: [],
  unpriced: [],
  totalUsdE8: '0',
  targets: [],
  drift: null,
  blocked: [],
  complete: false,
  sessionKey: { configured: null, usable: null, error: null },
  gas: null,
};

// ---------------------------------------------------------------------------
// session key：DB 記的那把 vs 鏈上真的會用的那把
// ---------------------------------------------------------------------------

const ZERO_SIGNER = '0x0000000000000000000000000000000000000000';
const SOME_SIGNER = `0x${'2'.repeat(40)}` as const;

/** DB 一列（形狀照 `session_keys`：key_ref / permissions / status / expires_at）。 */
function keyRow(keyRef: string, permissionId: string, status = 'active', expiresInMs = 86_400_000) {
  return {
    key_ref: keyRef,
    permissions: { permissionId, sessionKeyAddress: `0x${'1'.repeat(40)}` },
    status,
    expires_at: new Date(Date.now() + expiresInMs),
  };
}

/** `installedPermissionIds` 裡的才算「鏈上裝好了」；其餘回零地址（＝沒安裝）。 */
function statusKeyDeps(rows: unknown[], installedPermissionIds: readonly string[]) {
  return {
    query: async () => ({ rows }),
    publicClient: {
      readContract: async ({ args }: { args: readonly unknown[] }) => {
        const id = String(args[0]).toLowerCase();
        const installed = installedPermissionIds.some((want) => want.toLowerCase() === id);
        return installed ? { signer: SOME_SIGNER, policyData: ['0x', '0x', '0x'] } : { signer: ZERO_SIGNER, policyData: [] };
      },
    } as unknown as PublicClient,
  };
}

test('sessionKey：DB 記的那把沒安裝 → configured 標 installed:false，usable 是實際會用的那一把', async () => {
  // 實測 portfolio 5 的形狀：DB 記 0x7db20115（鏈上沒安裝），排程器退回舊的 0xf67556bf。
  const result = await resolveStatusSessionKey(
    PORTFOLIO_ID,
    ACCOUNT,
    statusKeyDeps(
      [keyRow("m/44'/60'/0'/0/9", '0x7db20115'), keyRow("m/44'/60'/0'/0/5", '0xf67556bf')],
      ['0xf67556bf'],
    ),
  );
  assert.equal(result.error, null);
  assert.equal(result.configured?.permissionId, '0x7db20115');
  assert.equal(result.configured?.keyRef, "m/44'/60'/0'/0/9");
  assert.equal(result.configured?.installed, false);
  // 到期日**一定要有**：那是使用者唯一能行動的資訊（key 過期 → 每輪 blocked 且不會自己好）。
  assert.ok(result.configured?.expiresAt, 'configured 必須帶 expiresAt');
  assert.equal(result.configured?.status, 'active');
  assert.equal(result.usable?.permissionId, '0xf67556bf');
  assert.equal(result.usable?.keyRef, "m/44'/60'/0'/0/5");
  assert.ok(result.usable?.expiresAt, 'usable 也必須帶 expiresAt');
});

test('sessionKey：DB 記的那把有安裝 → installed:true，usable 就是同一把', async () => {
  const result = await resolveStatusSessionKey(
    PORTFOLIO_ID,
    ACCOUNT,
    statusKeyDeps([keyRow("m/44'/60'/0'/0/9", '0x7db20115')], ['0x7db20115']),
  );
  assert.equal(result.error, null);
  assert.equal(result.configured?.installed, true);
  assert.equal(result.usable?.permissionId, '0x7db20115');
  assert.equal(result.usable?.keyRef, "m/44'/60'/0'/0/9");
  assert.ok(result.usable?.expiresAt);
});

test('sessionKey：一把都沒安裝 → usable 是 null（不是「讀不到」）', async () => {
  const result = await resolveStatusSessionKey(
    PORTFOLIO_ID,
    ACCOUNT,
    statusKeyDeps([keyRow("m/44'/60'/0'/0/9", '0x7db20115')], []),
  );
  assert.equal(result.error, null);
  assert.equal(result.configured?.installed, false);
  assert.equal(result.usable, null);
});

test('sessionKey：DB 一列都沒有 → configured/usable 都是 null 且 error 是 null', async () => {
  const result = await resolveStatusSessionKey(PORTFOLIO_ID, ACCOUNT, statusKeyDeps([], []));
  assert.deepEqual(result, { configured: null, usable: null, error: null });
});

test('sessionKey：讀不到 DB → error 有話，且不會被讀成「沒有可用的 key」', async () => {
  const result = await resolveStatusSessionKey(PORTFOLIO_ID, ACCOUNT, {
    query: async () => {
      throw new Error('connection refused');
    },
  });
  assert.equal(result.configured, null);
  assert.equal(result.usable, null);
  assert.match(String(result.error), /connection refused/);
});

test('sessionKey：讀不到鏈上 → usable 停在 null 並帶 error（不往下猜）', async () => {
  const result = await resolveStatusSessionKey(PORTFOLIO_ID, ACCOUNT, {
    query: async () => ({
      rows: [keyRow("m/44'/60'/0'/0/9", '0x7db20115'), keyRow("m/44'/60'/0'/0/5", '0xf67556bf')],
    }),
    publicClient: {
      readContract: async () => {
        throw new Error('rpc unreachable');
      },
    } as unknown as PublicClient,
  });
  assert.equal(result.usable, null);
  assert.match(String(result.error), /rpc unreachable/);
});

const SAMPLE_REBALANCE: OperatorRebalanceResult = {
  portfolioId: PORTFOLIO_ID,
  outcome: 'executed',
  reason: '已上鏈：tx 0xabc（第 1 次嘗試）',
  txHash: '0xabc' as Hex,
  userOpHash: null,
  swapExecuted: 2,
  expectedSwaps: 2,
  gasUsed: '123456',
  steps: [],
};

test('GET /portfolios/:id/status 沒有 token 是 401，有 token 才拿到狀態', async () => {
  await withServer(
    async (baseUrl) => {
      const anonymous = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/status`);
      assert.equal(anonymous.status, 401);

      const token = await loginToken(baseUrl);
      const response = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/status`, token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), SAMPLE_STATUS);
    },
    { portfolioStatus: async () => SAMPLE_STATUS },
  );
});

test('GET /portfolios/:id/status 用 POST 是 405', async () => {
  await withServer(
    async (baseUrl) => {
      const response = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/status`, {}, 'whatever');
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
    },
    { portfolioStatus: async () => SAMPLE_STATUS },
  );
});

test('portfolios 列表不包含狀態端點的欄位（貴的路徑不能被列表拉進來）', async () => {
  const listResponse = { portfolios: [{ id: PORTFOLIO_ID }] };
  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const response = await getJson(baseUrl, '/portfolios', token);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { portfolios: unknown[] };
      // 列表只有清單本身：沒有 holdings / drift / blocked。
      assert.deepEqual(body, listResponse);
    },
    {
      listPortfolios: async () => listResponse.portfolios as never,
      // 這一份一旦被呼叫到就是 regression：列表不該碰 status。
      portfolioStatus: async () => {
        throw new Error('GET /portfolios 不該呼叫 status');
      },
    },
  );
});

test('GET /portfolios/:id/plan 不受 ENABLE_OPERATOR_REBALANCE 限制（唯讀），但沒有 token 仍是 401', async () => {
  const preview = {
    portfolioId: PORTFOLIO_ID,
    outcome: 'noop' as const,
    reason: '規劃器回 noop：預估漂移不會下降，送出去只是付 gas',
    steps: [],
  };
  let called = 0;
  await withServer(
    async (baseUrl) => {
      const anonymous = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/plan`);
      assert.equal(anonymous.status, 401, '唯讀也要認人：它會透漏持倉與規劃結果');

      const token = await loginToken(baseUrl);
      const response = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/plan`, token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), preview);
    },
    {
      // 動錢的開關關著，但診斷照樣要看得到 —— 生產環境正是這個組合。
      operatorRebalanceEnabled: () => false,
      planPreview: async () => {
        called += 1;
        return preview;
      },
    },
  );
  assert.equal(called, 1, '開關關著也要能預覽：它唯讀，而且正是「為什麼投組停住」的答案');
});

test('GET /portfolios/:id/plan 用 POST 是 405', async () => {
  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const response = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/plan`, {}, token);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
    },
    { planPreview: async () => ({ portfolioId: PORTFOLIO_ID, outcome: 'ready' as const, reason: 'x', steps: [] }) },
  );
});

test('POST /portfolios/:id/rebalance 預設關閉：403，而且 rebalance 一次都沒被叫到', async () => {
  let called = 0;
  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const response = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/rebalance`, {}, token);
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'OPERATOR_REBALANCE_DISABLED');
      assert.match(body.error.message, /ENABLE_OPERATOR_REBALANCE=true/);
    },
    {
      // 明確關閉：不依賴執行測試那台機器的 env。
      operatorRebalanceEnabled: () => false,
      operatorRebalance: async () => {
        called += 1;
        return SAMPLE_REBALANCE;
      },
    },
  );
  assert.equal(called, 0, '開關關著時不該碰 DB 或鏈');
});

test('POST /portfolios/:id/rebalance 沒有 token 是 401（即使開關是開的）', async () => {
  await withServer(
    async (baseUrl) => {
      const response = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/rebalance`, {});
      assert.equal(response.status, 401);
    },
    {
      operatorRebalanceEnabled: () => true,
      operatorRebalance: async () => SAMPLE_REBALANCE,
    },
  );
});

test('POST /portfolios/:id/rebalance 開啟時回三層判定的結果（200，不是 201/204）', async () => {
  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const response = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/rebalance`, {}, token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), SAMPLE_REBALANCE);
    },
    {
      operatorRebalanceEnabled: () => true,
      operatorRebalance: async () => SAMPLE_REBALANCE,
    },
  );
});

test('POST /portfolios/:id/rebalance 用 GET 是 405（不會用 GET 動錢，也不會回 404）', async () => {
  await withServer(
    async (baseUrl) => {
      const response = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/rebalance`, 'whatever');
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'POST');
    },
    { operatorRebalanceEnabled: () => true },
  );
});

// ---------------------------------------------------------------------------
// runOperatorRebalance：把排程器的結果翻成 operator 看得懂的三層判定
// ---------------------------------------------------------------------------

const EXECUTOR = getAddress('0x9C41696ea7FaA5470eAfb77415D063beEef83f4a');
const SWAP_TOPIC = keccak256(
  toBytes('SwapExecuted(address,address,address,uint256,uint256,uint256,uint256,uint256)'),
);

/** 一份 receipt 的替身：只給 `countSwapExecuted` 需要的兩個欄位（emitter + topic0）。 */
function receiptClient(count: number) {
  return {
    getTransactionReceipt: async () => ({
      logs: Array.from({ length: count }, () => ({ address: EXECUTOR, topics: [SWAP_TOPIC] })),
    }),
  };
}

function runResult(overrides: Partial<PortfolioRunResult> = {}): PortfolioRunResult {
  return {
    portfolioId: PORTFOLIO_ID,
    strategyId: 447,
    account: ACCOUNT,
    outcome: 'executed',
    reason: '已上鏈：tx 0xabc（第 1 次嘗試）',
    nextRunAt: new Date('2026-11-08T06:00:00.000Z'),
    plan: {
      steps: [
        { tokenIn: WBNB, tokenOut: USDT, amountIn: '1000', amountOutMin: '500' },
        { tokenIn: USDT, tokenOut: WBNB, amountIn: '2000', amountOutMin: '800' },
      ],
      deadline: '1700000000',
      planHash: '0xdead' as Hex,
      idempotencyKey: 'rebalance:305:0xdead',
      rationale: '把 WBNB 賣掉、把 USDT 買回目標',
    },
    execution: { status: 'success', userOpHash: '0xop' as Hex, txHash: '0xabc' as Hex, gasUsed: '21000', error: null },
    partial: null,
    ...overrides,
  };
}

const OWNED = async () => undefined as never;

function schedulerStub(result: PortfolioRunResult | null, seen: { dryRun?: boolean | undefined; limit?: number | undefined } = {}) {
  return (async (args: { dryRun?: boolean; limit?: number }) => {
    seen.dryRun = args.dryRun;
    seen.limit = args.limit;
    return {
      claimed: result === null ? 0 : 1,
      dryRun: args.dryRun ?? true,
      results: result === null ? [] : [result],
    };
  }) as unknown as typeof runSchedulerOnce;
}

test('executed 一律以 live 送出（dryRun 明確是 false），並回 SwapExecuted 筆數與 gasUsed', async () => {
  const seen: { dryRun?: boolean | undefined; limit?: number | undefined } = {};
  const outcome = await runOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
    requireOwnedPortfolio: OWNED,
    runSchedulerOnce: schedulerStub(runResult(), seen),
    publicClient: receiptClient(2) as never,
    executor: EXECUTOR,
  });

  assert.equal(seen.dryRun, false, 'operator rebalance 是 live：dryRun 必須明確傳 false');
  assert.equal(seen.limit, 1);
  assert.equal(outcome.outcome, 'executed');
  assert.equal(outcome.txHash, '0xabc');
  assert.equal(outcome.gasUsed, '21000');
  assert.equal(outcome.swapExecuted, 2);
  assert.equal(outcome.expectedSwaps, 2);
  assert.equal(outcome.steps.length, 2);
});

test('上鏈但三層沒過（execution.status = reverted）→ reverted＋txHash＋gasUsed 都留著', async () => {
  const outcome = await runOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
    requireOwnedPortfolio: OWNED,
    runSchedulerOnce: schedulerStub(
      runResult({
        outcome: 'failed',
        reason: '上鏈但沒有成功：tx 0xabc（第 1 次嘗試）｜SwapExecuted 0/2 筆',
        execution: {
          status: 'reverted',
          userOpHash: '0xop' as Hex,
          txHash: '0xabc' as Hex,
          gasUsed: '21000',
          error: 'SwapExecuted 0/2 筆（沒有全部換成），gas 21000 已經花掉',
        },
      }),
    ),
    publicClient: receiptClient(0) as never,
    executor: EXECUTOR,
  });

  assert.equal(outcome.outcome, 'reverted');
  assert.equal(outcome.txHash, '0xabc');
  assert.equal(outcome.gasUsed, '21000');
  assert.equal(outcome.swapExecuted, 0);
  assert.equal(outcome.expectedSwaps, 2);
  assert.match(outcome.reason, /SwapExecuted 0\/2/);
});

test('根本沒送出去（execution.status = error）→ failed，沒有 txHash', async () => {
  const outcome = await runOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
    requireOwnedPortfolio: OWNED,
    runSchedulerOnce: schedulerStub(
      runResult({
        outcome: 'failed',
        reason: '送出失敗（沒有上鏈）：bundler rejected',
        execution: { status: 'error', userOpHash: null, txHash: null, gasUsed: null, error: 'bundler rejected' },
      }),
    ),
    publicClient: receiptClient(0) as never,
    executor: EXECUTOR,
  });

  assert.equal(outcome.outcome, 'failed');
  assert.equal(outcome.txHash, null);
  assert.equal(outcome.swapExecuted, 0, '沒有 txHash ＝ 確定換了 0 筆（不是「不知道」）');
});

test('blocked 與 noop 原樣轉述排程器的理由，不動任何錢', async () => {
  const blocked = await runOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
    requireOwnedPortfolio: OWNED,
    runSchedulerOnce: schedulerStub(
      runResult({
        outcome: 'blocked',
        reason: '前置檢查未通過（不送一筆注定失敗的交易）：[ALLOWANCE_TOO_LOW] WBNB allowance 不足',
        plan: null,
        execution: null,
      }),
    ),
    publicClient: receiptClient(0) as never,
    executor: EXECUTOR,
  });
  assert.equal(blocked.outcome, 'blocked');
  assert.match(blocked.reason, /ALLOWANCE_TOO_LOW/);
  assert.equal(blocked.expectedSwaps, 0);

  const noop = await runOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
    requireOwnedPortfolio: OWNED,
    runSchedulerOnce: schedulerStub(
      runResult({ outcome: 'noop', reason: '漂移 12bps 未達門檻 100bps，不需要再平衡', plan: null, execution: null }),
    ),
    publicClient: receiptClient(0) as never,
    executor: EXECUTOR,
  });
  assert.equal(noop.outcome, 'noop');
  assert.equal(noop.swapExecuted, 0);
});

test('認領不到（schedule_state 不是 active）→ blocked，並說清楚是被什麼擋住', async () => {
  const outcome = await runOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
    requireOwnedPortfolio: OWNED,
    runSchedulerOnce: schedulerStub(null),
    publicClient: receiptClient(0) as never,
    executor: EXECUTOR,
  });
  assert.equal(outcome.outcome, 'blocked');
  assert.match(outcome.reason, /schedule_state/);
  assert.equal(outcome.txHash, null);
});

test('不是我的投組：擁有者檢查先炸，排程器一次都不會被叫到', async () => {
  let ran = 0;
  await assert.rejects(
    runOperatorRebalance(PORTFOLIO_ID, OTHER_WALLET.address, {
      requireOwnedPortfolio: async () => {
        throw new ForbiddenError('portfolio 305 belongs to another wallet');
      },
      runSchedulerOnce: (async () => {
        ran += 1;
        return { claimed: 0, dryRun: false, results: [] };
      }) as unknown as typeof runSchedulerOnce,
    }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 403);
      return true;
    },
  );
  assert.equal(ran, 0, '動錢之前一定要先確認這是誰的投組');
});

test('plan 預覽：dryRun 明確是 true，ready-dry-run 對外叫 ready，而且不會帶 execution', async () => {
  const seen: { dryRun?: boolean | undefined; limit?: number | undefined } = {};
  const preview = await previewOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
    requireOwnedPortfolio: OWNED,
    runSchedulerOnce: schedulerStub(
      runResult({ outcome: 'ready-dry-run', execution: null, reason: '將要執行 2 個 step（dry-run）' }),
      seen,
    ),
  });

  assert.equal(seen.dryRun, true, '預覽是唯讀：dryRun 必須明確傳 true（不是靠排程器的預設值）');
  assert.equal(seen.limit, 1);
  assert.equal(preview.outcome, 'ready');
  assert.equal(preview.steps.length, 2);
  assert.match(preview.reason, /dry-run/);
});

test('plan 預覽：noop 的重現原文照回（使用者要知道「為什麼這一輪不動」）', async () => {
  const reason = '規劃器回 noop：不送：這個計畫執行後預估漂移 595 bps，不比現在的 595 bps 低';
  const preview = await previewOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
    requireOwnedPortfolio: OWNED,
    // noop 時排程器不帶 plan（沒有要送的東西），所以預覽的 steps 一定是空的 —— fixture 要照這個事實。
    runSchedulerOnce: schedulerStub(runResult({ outcome: 'noop', execution: null, plan: null, reason }), {}),
  });
  assert.equal(preview.outcome, 'noop');
  assert.equal(preview.reason, reason);
  assert.deepEqual(preview.steps, []);
});

test('plan 預覽：沒被認領（不是 active／沒有 smart account）→ blocked 並說出原因', async () => {
  const preview = await previewOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
    requireOwnedPortfolio: OWNED,
    runSchedulerOnce: schedulerStub(null, {}),
  });
  assert.equal(preview.outcome, 'blocked');
  assert.match(preview.reason, /沒有認領/);
});

test('plan 預覽：dry-run 竟然回報 executed → 拋錯，不把它講成 noop', async () => {
  await assert.rejects(
    previewOperatorRebalance(PORTFOLIO_ID, WALLET.address, {
      requireOwnedPortfolio: OWNED,
      runSchedulerOnce: schedulerStub(runResult({ outcome: 'executed' }), {}),
    }),
    /PLAN_PREVIEW_CONTRACT|dry-run/,
  );
});

test('GET /assets：要認證；回 priceable_assets 的清單（create fund 的選單來源）', async () => {
  const assets = [
    { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18, isNumeraire: true, tradable: true },
    { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18, isNumeraire: false, tradable: true },
  ];
  await withServer(
    async (baseUrl) => {
      const anonymous = await getJson(baseUrl, '/assets');
      assert.equal(anonymous.status, 401, '資產清單在登入後才看得到');

      const token = await loginToken(baseUrl);
      const response = await getJson(baseUrl, '/assets', token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { assets });
    },
    { listAssets: async () => assets },
  );
});

// `GET /portfolios/:id/activity`：把 operations 與 before/after 快照 join 起來。
// 沒有這條的話，「這一輪到底做了什麼」只能靠手動 SQL —— 而那是 UI 的主要內容之一。
// status 的 gas 一列：讀不到就是 null（不是 0），而且不讓整份狀態變 503。
// gas 是**每個帳戶自己付**的（ERC-4337 sender 模型），所以這是「這檔基金還能不能動」的答案。
test('portfolioStatus：gas 算得出來就帶上，讀不到是 null 而不是 0 或 503', async () => {
  const makeReader = (balance: (() => Promise<bigint>) | null) =>
    createPortfolioStatusReader({
      planPortfolio: async () => samplePlan(),
      requireOwnedPortfolio: async () => undefined as never,
      query: symbolQuery(),
      // session key 的讀取會打鏈；這條測試只關心 gas，所以讓它失敗（status 會記在 sessionKey.error）。
      publicClient: {
        readContract: async () => {
          throw new Error('not needed for this test');
        },
      } as never,
      executor: EXECUTOR,
      minGasWei: 10n ** 16n,
      gasPrice: async () => 1_000_000_000n,
      ...(balance === null ? {} : { accountGasBalance: balance }),
    });

  const ok = await makeReader(async () => 5n * 10n ** 16n)(PORTFOLIO_ID, WALLET.address);
  assert.equal(ok.gas?.ready, true);
  assert.equal(ok.gas?.balanceWei, (5n * 10n ** 16n).toString());
  assert.equal(ok.gas?.shortfallWei, '0');

  const low = await makeReader(async () => 1n * 10n ** 15n)(PORTFOLIO_ID, WALLET.address);
  assert.equal(low.gas?.ready, false);
  assert.equal(low.gas?.shortfallWei, (9n * 10n ** 15n).toString(), '不足時要說出還差多少');

  const broken = await makeReader(async () => {
    throw new Error('rpc is down');
  })(PORTFOLIO_ID, WALLET.address);
  assert.equal(broken.gas, null, '讀不到是 null —— 不是 0（那會被讀成「沒錢」），也不是 503');
});

test('listPortfolioActivity：join 前後快照、新到舊、沒有快照的輪次留 null', async () => {
  const seen: { sql: string; params: readonly unknown[] }[] = [];
  const fakeQuery = async (sql: string, params: readonly unknown[] = []) => {
    seen.push({ sql, params });
    return {
      rows: [
        {
          id: '12',
          state: 'confirmed',
          tx_hash: '0xabc',
          user_op_hash: '0xdef',
          attempts: 1,
          created_at: '2026-11-08T12:58:49.000Z',
          drift_before: 6600,
          drift_after: 6,
          usd_before: '500000000000',
          usd_after: '499469000000',
        },
        {
          id: '11',
          state: 'noop',
          tx_hash: null,
          user_op_hash: null,
          attempts: 0,
          created_at: '2026-11-08T11:00:00.000Z',
          drift_before: null,
          drift_after: null,
          usd_before: null,
          usd_after: null,
        },
      ],
      rowCount: 2,
    };
  };

  const activity = await listPortfolioActivity(
    1682,
    '0xowner',
    { query: fakeQuery as never, requireOwnedPortfolio: (async () => undefined) as never },
    20,
  );

  assert.equal(activity.length, 2);
  assert.deepEqual(
    { id: activity[0]?.id, state: activity[0]?.state, drift: [activity[0]?.driftBeforeBps, activity[0]?.driftAfterBps] },
    { id: 12, state: 'confirmed', drift: [6600, 6] },
  );
  // 沒有快照的輪次（noop / blocked 不寫快照）要留 null —— 不是 0。
  assert.equal(activity[1]?.driftBeforeBps, null);
  assert.equal(activity[1]?.usdAfterE8, null);
  assert.match(seen[0]?.sql ?? '', /left join portfolio_snapshots b/);
  assert.match(seen[0]?.sql ?? '', /order by o\.id desc/);
  assert.deepEqual(seen[0]?.params, [1682, 20]);
});

// 回歸（實測踩到）：`GET /assets` 回 500，因為 probe 的**每一次** `oracleOf` 都是鏈上讀取，
// 而失敗原因與「這個部署有沒有 executor」無關 —— fork 的 archive 窗口過了（publicnode 回 403）、
// RPC 抖一下，都會讓它拋。那個端點要回答的是「有哪些資產可以選」，不是「鏈現在好不好」。
test('listPriceableAssets：probe.oracleOf 拋錯 → tradable 是 null（未知），不是整個請求失敗', async () => {
  const rows = [
    { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18, is_numeraire: true },
    { address: '0xbb4cdb9cbd39b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18, is_numeraire: false },
    { address: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', symbol: 'NVDAB', decimals: 18, is_numeraire: false },
  ];
  const query = async () => ({ rows, rowCount: rows.length });
  const probe = {
    router: '0x132cDfCe34d385f783dAB7F011B2E66E78A2f87f',
    oracleOf: async (asset: string) => {
      // 模擬 archive 403：USDT 是 numeraire 不會被問到，其他兩個都炸。
      if (asset !== rows[0]?.address) throw new Error('HTTP error 403 — Archive requests require a personal token');
      return '0x0000000000000000000000000000000000000000';
    },
  };

  const assets = await listPriceableAssets(query as never, probe as never);
  assert.equal(assets.length, 3);
  assert.equal(assets[0]?.tradable, true, 'numeraire 不需要 oracle，永遠可交易');
  assert.equal(assets[1]?.tradable, null, '查不到就是未知 —— 不是 false（那會讓它變成不可選）');
  assert.equal(assets[2]?.tradable, null);
});
