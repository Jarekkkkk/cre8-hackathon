import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResultRow } from 'pg';
import { getAddress, toHex } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { requireSessionKeyConfig } from '../src/config.js';
import { query } from '../src/db.js';
import { NotFoundError } from '../src/errors.js';
import { describeGasStatus } from '../src/funding.js';
import { sessionKeyIndexFor, sessionValidUntil } from '../src/permissions.js';
import { enrollPortfolio, listPortfolios, requireOwnedPortfolio } from '../src/portfolios.js';
import type { OwnedPortfolio, Portfolio, PortfolioWithSessionKey } from '../src/portfolios.js';
import {
  buildRenewalParams,
  DEFAULT_BUNDLER_URL,
  nextRenewalKeyIndex,
  parseSessionKeyIndex,
  recordRenewalResult,
} from '../src/renewal.js';
import type { RenewalParams, RenewalParamsDeps } from '../src/renewal.js';
import {
  BUNDLER_METHOD_WHITELIST,
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_MAX_AGE_SECONDS,
  DEFAULT_CORS_ALLOWED_ORIGINS,
  allowedCorsOrigin,
  createServer,
  resolveCorsConfig,
} from '../src/server.js';
import type { ServerDeps } from '../src/server.js';

/**
 * `GET /portfolios`、`GET /portfolios/:id/renewal-params`、`POST /portfolios/:id/renewal-result`
 * 與 CORS 的測試。
 *
 * 全部走真的路由與真的領域程式碼，只把「DB」與「鏈」換成假替身：續期要驗的正是「DB 的值有沒有被照抄、
 * 索引有沒有避開既有那把、重複提交會不會多一列」，把領域邏輯換成假的就什麼都沒測到。
 */

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 登入的錢包（= sudo owner = `portfolios.user_id` = `smart_accounts.owner`）。 */
const WALLET = privateKeyToAccount(generatePrivateKey());
const WALLET_LOWER = WALLET.address.toLowerCase();
/** 別人的錢包：用來證明 403。 */
const OTHER_WALLET = privateKeyToAccount(generatePrivateKey());
/**
 * smart account 的地址：**刻意是一個與派生無關的隨機地址**。
 * 續期必須直接用 DB 的這一欄，不能拿 initConfig 重算（重算需要當初的 initConfig，見 pitfalls §4.7）。
 */
const SMART_ACCOUNT = privateKeyToAccount(generatePrivateKey());

const PORTFOLIO_ID = 3;
const STRATEGY_ID = 11;
const CHAIN_ID = 31337;
/** CallPolicy 的 target（rebalance executor）。 */
const EXECUTOR = getAddress('0x60691760815C69d32c1F68146FA11669F62A4b38');
/** 測試用 master seed：32 bytes 的 0x11。 */
const MASTER_SEED: Hex = `0x${'11'.repeat(32)}`;
const SESSION_KEY_CONFIG = { executorAddress: EXECUTOR, masterSeed: MASTER_SEED };

/** enroll 時用的索引（既有那把 key）。 */
const BASE_INDEX = sessionKeyIndexFor(WALLET_LOWER as Address, BigInt(STRATEGY_ID));
const OLD_KEY_REF = `m/44'/60'/0'/0/${BASE_INDEX.toString()}`;
const OLD_VALID_UNTIL = 1_700_000_000;
/** 固定的「現在 + 365 天」：讓兩次呼叫落在同一秒，測試才有意義（見下面的冪等測試）。 */
const FIXED_VALID_UNTIL = sessionValidUntil(1_800_000_000);

/**
 * 只需要 `chain` 的 publicClient：`buildSessionPermissions` 讀 chain id 決定 policy 合約地址，
 * 不打鏈（`toPermissionValidator` 的 eth_chainId 由這裡回答）。若 SDK 真的去問鏈，這裡會炸出 method 名。
 */
const FAKE_PUBLIC_CLIENT = {
  chain: bsc,
  request: async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return toHex(CHAIN_ID);
    throw new Error(`fake publicClient: 不支援的 RPC method ${method}`);
  },
} as unknown as PublicClient;

function ownedPortfolio(overrides: Partial<OwnedPortfolio> = {}): OwnedPortfolio {
  return {
    id: PORTFOLIO_ID,
    userId: WALLET_LOWER,
    strategyId: STRATEGY_ID,
    version: 1,
    scheduleState: 'active',
    createdAt: '2026-11-06T00:00:00.000Z',
    chainId: CHAIN_ID,
    accountAddress: SMART_ACCOUNT.address.toLowerCase(),
    ownerAddress: WALLET_LOWER,
    existingKeyRefs: [OLD_KEY_REF],
    ...overrides,
  };
}

function samplePortfolio(id = PORTFOLIO_ID): Portfolio {
  return {
    id,
    userId: WALLET_LOWER,
    strategyId: STRATEGY_ID,
    strategyName: 'Test fund',
    version: 1,
    scheduleState: 'active',
    createdAt: '2026-11-06T00:00:00.000Z',
    smartAccounts: [
      {
        chainId: CHAIN_ID,
        address: SMART_ACCOUNT.address.toLowerCase(),
        owner: WALLET_LOWER,
        accountType: 'KERNEL',
      },
    ],
    gas: describeGasStatus({
      address: SMART_ACCOUNT.address.toLowerCase() as Address,
      balanceWei: 5n * 10n ** 16n,
      minimumWei: 10n ** 16n,
      gasPriceWei: 1_220_000_000n,
    }),
  };
}

// ---------------------------------------------------------------------------
// fakes: a database that answers like Postgres, not like a script
// ---------------------------------------------------------------------------

type DbCall = { text: string; params: readonly unknown[] };
type FakeRows = { rows: QueryResultRow[]; rowCount?: number };

/** 包成 `typeof query`：記錄每一次查詢，讓測試能斷言 SQL 與參數（不是只斷言結果）。 */
function asQuery(handler: (text: string, params: readonly unknown[]) => FakeRows): {
  query: typeof query;
  calls: DbCall[];
} {
  const calls: DbCall[] = [];
  const fake = (async (text: string, params: readonly unknown[] = []) => {
    calls.push({ text, params });
    const { rows, rowCount } = handler(text, params);
    return { rows, rowCount: rowCount ?? rows.length, command: 'SELECT', oid: 0, fields: [] };
  }) as unknown as typeof query;
  return { query: fake, calls };
}

type SessionKeyDbRow = {
  portfolio_id: string;
  key_ref: string;
  permissions: Record<string, unknown>;
  expires_at: Date;
  status: string;
};

/**
 * 假的 `session_keys` 表：照真表的兩個約束實作。
 *
 * 1. `unique (key_ref)` + `on conflict (key_ref) do nothing` → 已存在的 key_ref 不會多一列，
 *    而且 `returning` 是空的（這就是「重複提交」的訊號）。
 * 2. 沒有任何 UPDATE 的分支：舊的那一列在續期後狀態不變，所以「舊列 status 未變」是這張表的性質，
 *    不是測試自己假設的。
 */
function fakeSessionKeys(seed: SessionKeyDbRow[] = []): {
  query: typeof query;
  rows: SessionKeyDbRow[];
  calls: DbCall[];
} {
  const rows = [...seed];
  const { query: fake, calls } = asQuery((text, params) => {
    if (/insert into session_keys/i.test(text)) {
      const keyRef = String(params[1]);
      if (rows.some((row) => row.key_ref === keyRef)) return { rows: [], rowCount: 0 };
      rows.push({
        portfolio_id: String(params[0]),
        key_ref: keyRef,
        permissions: JSON.parse(String(params[2])) as Record<string, unknown>,
        expires_at: new Date(Number(params[3]) * 1000),
        status: 'active',
      });
      return { rows: [{ key_ref: keyRef }], rowCount: 1 };
    }
    if (/select portfolio_id from session_keys where key_ref = \$1/i.test(text)) {
      const row = rows.find((candidate) => candidate.key_ref === String(params[0]));
      return { rows: row === undefined ? [] : [{ portfolio_id: row.portfolio_id }] };
    }
    throw new Error(`fake session_keys: unexpected query ${text}`);
  });
  return { query: fake, rows, calls };
}

/** 一個已經有 404／403 語意的擁有者查詢（真實的 `requireOwnedPortfolio` 另外有專門的測試）。 */
function fixedOwnerQuery(portfolio: OwnedPortfolio | null): {
  requireOwnedPortfolio: typeof requireOwnedPortfolio;
  calls: Array<{ portfolioId: number; wallet: string }>;
} {
  const calls: Array<{ portfolioId: number; wallet: string }> = [];
  const fake = (async (portfolioId: number, wallet: string) => {
    calls.push({ portfolioId, wallet });
    if (portfolio === null) throw new NotFoundError(`portfolio ${portfolioId} not found`);
    return portfolio;
  }) as unknown as typeof requireOwnedPortfolio;
  return { requireOwnedPortfolio: fake, calls };
}

/** 真的 `buildRenewalParams`，只換掉 DB／env／clock 這幾個接縫。 */
function realRenewalParams(
  portfolio: OwnedPortfolio | null,
  overrides: Partial<RenewalParamsDeps> = {},
): { buildRenewalParams: typeof buildRenewalParams; ownerCalls: Array<{ portfolioId: number; wallet: string }> } {
  const owner = fixedOwnerQuery(portfolio);
  const build = (portfolioId: number, wallet: string) =>
    buildRenewalParams(portfolioId, wallet, {
      requireOwnedPortfolio: owner.requireOwnedPortfolio,
      sessionKeyConfig: () => SESSION_KEY_CONFIG,
      publicClient: FAKE_PUBLIC_CLIENT,
      chainId: CHAIN_ID,
      bundlerUrl: DEFAULT_BUNDLER_URL,
      validUntil: () => FIXED_VALID_UNTIL,
      ...overrides,
    });
  return { buildRenewalParams: build, ownerCalls: owner.calls };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function withServer<T>(run: (baseUrl: string) => Promise<T>, deps?: Partial<ServerDeps>): Promise<T> {
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

function postJson(baseUrl: string, path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function getJson(baseUrl: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: 'GET', headers });
}

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
  const loginResponse = await postJson(baseUrl, '/auth/login', {
    message,
    signature: await WALLET.signMessage({ message }),
  });
  assert.equal(loginResponse.status, 200);
  const { token } = (await loginResponse.json()) as { token: string };
  return token;
}

// ---------------------------------------------------------------------------
// GET /portfolios
// ---------------------------------------------------------------------------

test('listPortfolios only returns rows whose user_id is the token wallet (case-insensitive)', async () => {
  const now = new Date('2026-11-06T00:00:00.000Z');
  const rows: QueryResultRow[] = [
    {
      id: '3',
      user_id: WALLET.address, // 大寫：DB 是自由文字，比對必須不分大小寫
      strategy_id: '11',
      version: 1,
      schedule_state: 'active',
      created_at: now,
      chain_id: String(CHAIN_ID),
      address: SMART_ACCOUNT.address.toLowerCase(),
      owner: WALLET_LOWER,
      account_type: 'KERNEL',
    },
    {
      id: '4',
      user_id: OTHER_WALLET.address.toLowerCase(),
      strategy_id: '11',
      version: 1,
      schedule_state: 'active',
      created_at: now,
      chain_id: String(CHAIN_ID),
      address: OTHER_WALLET.address.toLowerCase(),
      owner: OTHER_WALLET.address.toLowerCase(),
      account_type: 'KERNEL',
    },
  ];

  // 假 DB 執行 SQL 的謂詞，而不是照單全收：`where lower(p.user_id) = $1` 少寫就整批回來。
  const { query: fake, calls } = asQuery((text, params) => {
    if (/from portfolios p/.test(text)) {
      assert.match(text, /lower\(p\.user_id\) = \$1/, 'the wallet predicate must be in the SQL');
      const wallet = String(params[0]);
      return { rows: rows.filter((row) => String(row.user_id).toLowerCase() === wallet) };
    }
    if (/from session_keys/.test(text)) return { rows: [] };
    throw new Error(`fake db: unexpected query ${text}`);
  });

  const portfolios = await listPortfolios(WALLET.address, {
    query: fake,
    getAccountGasBalance: async () => 5n * 10n ** 16n,
    getGasPriceWei: async () => 1_220_000_000n,
    minSessionGasWei: 10n ** 16n,
  });

  assert.equal(portfolios.length, 1, 'another wallet’s portfolio must not leak into the list');
  assert.equal(portfolios[0]?.id, PORTFOLIO_ID);
  assert.equal(calls[0]?.params[0], WALLET_LOWER, 'the query param is the authenticated wallet, lowercased');
});

test('listPortfolios answers gas: null and sessionKey: null instead of failing', async () => {
  const { query: fake } = asQuery((text) => {
    if (/from portfolios p/.test(text)) {
      return {
        rows: [
          {
            id: String(PORTFOLIO_ID),
            user_id: WALLET_LOWER,
            strategy_id: String(STRATEGY_ID),
            version: 1,
            schedule_state: 'active',
            created_at: new Date('2026-11-06T00:00:00.000Z'),
            chain_id: String(CHAIN_ID),
            address: SMART_ACCOUNT.address.toLowerCase(),
            owner: WALLET_LOWER,
            account_type: 'KERNEL',
          },
        ],
      };
    }
    if (/from session_keys/.test(text)) return { rows: [] };
    throw new Error(`fake db: unexpected query ${text}`);
  });

  const portfolios = await listPortfolios(WALLET.address, {
    query: fake,
    // 兩個唯讀 RPC 都掛掉：這是「暫時查不到」，不是這個錢包沒有 portfolio。
    getAccountGasBalance: async () => {
      throw new Error('rpc is down');
    },
    getGasPriceWei: async () => 1_220_000_000n,
    minSessionGasWei: 10n ** 16n,
  });

  assert.equal(portfolios.length, 1);
  assert.equal(portfolios[0]?.gas, null, 'a failing RPC must not fail the whole list');
  assert.equal(portfolios[0]?.sessionKey, null, 'no session_keys row means null, not a crash');
  assert.deepEqual(portfolios[0]?.smartAccounts, [
    { chainId: CHAIN_ID, address: SMART_ACCOUNT.address.toLowerCase(), owner: WALLET_LOWER, accountType: 'KERNEL' },
  ]);
});

test('listPortfolios reports the active session key (permissionId + address from the policy snapshot)', async () => {
  const activeExpiry = new Date((OLD_VALID_UNTIL + 3600) * 1000);
  const { query: fake, calls } = asQuery((text) => {
    if (/from portfolios p/.test(text)) {
      return {
        rows: [
          {
            id: String(PORTFOLIO_ID),
            user_id: WALLET_LOWER,
            strategy_id: String(STRATEGY_ID),
            version: 1,
            schedule_state: 'active',
            created_at: new Date('2026-11-06T00:00:00.000Z'),
            chain_id: String(CHAIN_ID),
            address: SMART_ACCOUNT.address.toLowerCase(),
            owner: WALLET_LOWER,
            account_type: 'KERNEL',
          },
        ],
      };
    }
    if (/from session_keys/.test(text)) {
      // 照 SQL 的 ORDER BY 回：active 優先，其次到期日新到舊。
      return {
        rows: [
          {
            portfolio_id: String(PORTFOLIO_ID),
            key_ref: OLD_KEY_REF,
            permissions: { permissionId: '0xc0449df6', sessionKeyAddress: SMART_ACCOUNT.address.toLowerCase() },
            expires_at: activeExpiry,
            status: 'active',
          },
          {
            portfolio_id: String(PORTFOLIO_ID),
            key_ref: `m/44'/60'/0'/0/1`,
            permissions: { permissionId: '0xdeadbeef' },
            expires_at: new Date((OLD_VALID_UNTIL + 7200) * 1000),
            status: 'revoked',
          },
        ],
      };
    }
    throw new Error(`fake db: unexpected query ${text}`);
  });

  const portfolios = await listPortfolios(WALLET.address, {
    query: fake,
    getAccountGasBalance: async () => 5n * 10n ** 16n,
    getGasPriceWei: async () => 1_220_000_000n,
    minSessionGasWei: 10n ** 16n,
  });

  assert.match(
    String(calls[1]?.text),
    /\(status = 'active'\) desc/,
    'the "current" key is the active one, so the ORDER BY has to say so',
  );
  assert.deepEqual(portfolios[0]?.sessionKey, {
    permissionId: '0xc0449df6',
    sessionKeyAddress: SMART_ACCOUNT.address.toLowerCase(),
    keyRef: OLD_KEY_REF,
    expiresAt: activeExpiry.toISOString(),
    status: 'active',
  });
});

test('GET /portfolios requires a bearer token and returns the { portfolios: [...] } envelope', async () => {
  const listed: PortfolioWithSessionKey[] = [{ ...samplePortfolio(), sessionKey: null }];
  const listFn = (async (wallet: string) => {
    assert.equal(wallet, WALLET_LOWER, 'the route must hand the session wallet to the list query');
    return listed;
  }) as unknown as typeof listPortfolios;

  await withServer(
    async (baseUrl) => {
      const unauthorized = await getJson(baseUrl, '/portfolios');
      assert.equal(unauthorized.status, 401);
      const unauthorizedBody = (await unauthorized.json()) as { error: { code: string } };
      assert.equal(unauthorizedBody.error.code, 'UNAUTHORIZED');

      const token = await loginToken(baseUrl);
      const res = await getJson(baseUrl, '/portfolios', token);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { portfolios: PortfolioWithSessionKey[] };
      assert.equal(body.portfolios.length, 1);
      // 形狀固定（前端照這個寫）：`sessionKey: null` 與 `gas: null` 都是合法值。
      assert.deepEqual(Object.keys(body.portfolios[0] ?? {}).sort(), [
        'createdAt',
        'gas',
        'id',
        'scheduleState',
        'sessionKey',
        'smartAccounts',
        'strategyId',
        'strategyName',
        'userId',
        'version',
      ]);
    },
    { listPortfolios: listFn },
  );
});

// ---------------------------------------------------------------------------
// GET /portfolios/:id/renewal-params
// ---------------------------------------------------------------------------

test('GET /portfolios/:id/renewal-params returns everything the front end needs to build the UserOp', async () => {
  const { buildRenewalParams: build } = realRenewalParams(ownedPortfolio());

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
      assert.equal(res.status, 200);
      const body = (await res.json()) as RenewalParams;

      // 完整形狀：前端會照這 16 個鍵寫，多一個少一個都是契約變更。
      assert.deepEqual(Object.keys(body).sort(), [
        'accountAddress',
        'bundlerUrl',
        'chainId',
        'entryPoint',
        'executorAddress',
        'expiresAt',
        'initConfig',
        'kernelVersion',
        'keyRef',
        'ownerAddress',
        'permissionId',
        'policySnapshot',
        'portfolioId',
        'sessionKeyAddress',
        'strategyId',
        'validUntil',
      ]);

      assert.equal(body.portfolioId, PORTFOLIO_ID);
      assert.equal(body.strategyId, STRATEGY_ID);
      assert.equal(body.chainId, CHAIN_ID);
      assert.equal(body.ownerAddress, WALLET_LOWER, 'ownerAddress is the sudo owner, not the session key');
      assert.equal(body.executorAddress, EXECUTOR);
      assert.equal(body.entryPoint, '0x0000000071727De22E5E9d8BAf0edAc6f37da032');
      assert.equal(body.kernelVersion, '0.3.3');
      assert.equal(body.validUntil, FIXED_VALID_UNTIL);
      assert.equal(body.expiresAt, new Date(FIXED_VALID_UNTIL * 1000).toISOString(), 'same instant as validUntil');
      assert.equal(body.bundlerUrl, DEFAULT_BUNDLER_URL);

      // Uint48 與 4-byte permissionId：前端要拿它們組 calldata，形狀錯了會在上鏈前才發現。
      assert.ok(Number.isSafeInteger(body.validUntil) && body.validUntil < 2 ** 48);
      assert.match(body.permissionId, /^0x[0-9a-fA-F]{8}$/);
      assert.match(body.sessionKeyAddress, /^0x[0-9a-fA-F]{40}$/);
      assert.match(body.keyRef, /^m\/44'\/60'\/0'\/0\/\d+$/);

      // initConfig = 兩筆 calldata（installValidations + grantExecute 的 delegatecall）。
      assert.equal(body.initConfig.length, 2);
      for (const data of body.initConfig) assert.match(data, /^0x[0-9a-fA-F]+$/);

      // policy 快照：三層完整，前端不需要解它但原樣回傳給 renewal-result。
      assert.deepEqual(Object.keys(body.policySnapshot).sort(), [
        'call',
        'entryPoint',
        'expiresAt',
        'flag',
        'gas',
        'kernelVersion',
        'permissionId',
        'sessionKeyAddress',
        'timestamp',
        'version',
      ]);
      assert.equal(body.policySnapshot.permissionId, body.permissionId);
      assert.equal(body.policySnapshot.sessionKeyAddress, body.sessionKeyAddress);
      assert.equal(body.policySnapshot.timestamp.validUntil, body.validUntil);
      assert.equal(
        body.policySnapshot.call.permissions[0]?.target,
        EXECUTOR.toLowerCase(),
        'CallPolicy target = executor（快照一律小寫）',
      );
    },
    { buildRenewalParams: build },
  );
});

test('renewal-params takes accountAddress from the DB row, not from a fresh derivation', async () => {
  // DB 說帳戶在 A，派生會算出 B（這裡刻意讓兩者不同）。回應必須是 A。
  const dbAccount = SMART_ACCOUNT.address;
  assert.notEqual(dbAccount.toLowerCase(), WALLET_LOWER);
  const { buildRenewalParams: build } = realRenewalParams(ownedPortfolio({ accountAddress: dbAccount }));

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
      assert.equal(res.status, 200);
      const body = (await res.json()) as RenewalParams;
      assert.equal(body.accountAddress, dbAccount, 'smart_accounts.address is the authority; never recompute it');
      assert.notEqual(
        body.accountAddress.toLowerCase(),
        body.sessionKeyAddress.toLowerCase(),
        'the account being renewed and the new session key are different addresses',
      );
    },
    { buildRenewalParams: build },
  );
});

test('renewal-params derives a NEW key index: the old keyRef is never reused', async () => {
  const { buildRenewalParams: build } = realRenewalParams(ownedPortfolio());

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
      const body = (await res.json()) as RenewalParams;
      assert.equal(body.keyRef, `m/44'/60'/0'/0/${(BASE_INDEX + 1n).toString()}`);
      assert.notEqual(body.keyRef, OLD_KEY_REF, 'UNIQUE(key_ref) would reject a reused path');
    },
    { buildRenewalParams: build },
  );
});

test('renewal-params is idempotent inside the same second (retry gets the exact same key)', async () => {
  // `validUntil` 只到秒，兩次呼叫共用同一個「現在」= 同一秒。前端逾時重試就是這個情境：
  // 拿到另一把 key 卻簽了前一個 op 的 initConfig，會產生一個鏈上裝不起來的權限。
  const { buildRenewalParams: build } = realRenewalParams(ownedPortfolio());

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const first = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
      const second = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      const a = (await first.json()) as RenewalParams;
      const b = (await second.json()) as RenewalParams;
      assert.deepEqual(a, b, 'two calls in the same second must be byte-identical');
      assert.equal(a.permissionId, b.permissionId, 'the permissionId is what the front end signs for');
    },
    { buildRenewalParams: build },
  );
});

test('renewal-params defaults validUntil to sessionValidUntil() and keeps expiresAt on the same instant', async () => {
  // 不注入時鐘：證明預設就是 `sessionValidUntil()`（now + 365 天），而不是別的算法。
  const { buildRenewalParams: build } = realRenewalParams(ownedPortfolio(), { validUntil: undefined });
  const before = sessionValidUntil();

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
      const body = (await res.json()) as RenewalParams;
      const after = sessionValidUntil();
      assert.ok(
        body.validUntil >= before && body.validUntil <= after + 1,
        `validUntil ${body.validUntil} must come from sessionValidUntil() (${before}..${after})`,
      );
      assert.equal(body.expiresAt, new Date(body.validUntil * 1000).toISOString());
    },
    { buildRenewalParams: build },
  );
});

test('nextRenewalKeyIndex is a pure function of (owner, strategyId, existing keyRefs)', () => {
  const owner = WALLET_LOWER as Address;
  const base = sessionKeyIndexFor(owner, BigInt(STRATEGY_ID));

  assert.equal(nextRenewalKeyIndex(owner, STRATEGY_ID, []), base + 1n, 'a fresh portfolio renews to base+1');
  assert.equal(
    nextRenewalKeyIndex(owner, STRATEGY_ID, [OLD_KEY_REF]),
    base + 1n,
    'the enroll key occupies base, so the renewal takes base+1',
  );
  assert.equal(
    nextRenewalKeyIndex(owner, STRATEGY_ID, [OLD_KEY_REF, `m/44'/60'/0'/0/${(base + 1n).toString()}`]),
    base + 2n,
    'a second renewal must not collide with the first one',
  );
  // 同一組輸入必然同一個索引 —— 這就是「同一秒內冪等」的來源。
  assert.equal(
    nextRenewalKeyIndex(owner, STRATEGY_ID, [OLD_KEY_REF]),
    nextRenewalKeyIndex(owner, STRATEGY_ID, [OLD_KEY_REF]),
  );
  // 讀不懂的 key_ref（舊格式）不參與比較，也不會讓續期失敗。
  assert.equal(parseSessionKeyIndex('kms://alias/session-1'), null);
  assert.equal(nextRenewalKeyIndex(owner, STRATEGY_ID, ['kms://alias/session-1']), base + 1n);
});

// ---------------------------------------------------------------------------
// renewal-params: 403 / 404 / 缺 env
// ---------------------------------------------------------------------------

test('renewal-params answers 404 for an unknown portfolio and 403 for someone else’s', async () => {
  const now = new Date('2026-11-06T00:00:00.000Z');
  const rowFor = (userId: string): QueryResultRow => ({
    id: String(PORTFOLIO_ID),
    user_id: userId,
    strategy_id: String(STRATEGY_ID),
    version: 1,
    schedule_state: 'active',
    created_at: now,
  });

  // 404：DB 沒有這一列。
  {
    const { query: missing } = asQuery((text) => {
      if (/from portfolios/.test(text)) return { rows: [] };
      throw new Error(`fake db: unexpected query ${text}`);
    });
    const owner = (portfolioId: number, wallet: string) =>
      requireOwnedPortfolio(portfolioId, wallet, { query: missing, chainId: CHAIN_ID });
    const build = (portfolioId: number, wallet: string) =>
      buildRenewalParams(portfolioId, wallet, {
        requireOwnedPortfolio: owner,
        sessionKeyConfig: () => SESSION_KEY_CONFIG,
        publicClient: FAKE_PUBLIC_CLIENT,
        chainId: CHAIN_ID,
        validUntil: () => FIXED_VALID_UNTIL,
      });

    await withServer(
      async (baseUrl) => {
        const token = await loginToken(baseUrl);
        const res = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
        assert.equal(res.status, 404);
        const body = (await res.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'NOT_FOUND');
      },
      { buildRenewalParams: build },
    );
  }

  // 403：列存在但 user_id 是別人。
  {
    const { query: foreign } = asQuery((text) => {
      if (/from portfolios/.test(text)) return { rows: [rowFor(OTHER_WALLET.address.toLowerCase())] };
      if (/from smart_accounts/.test(text)) {
        return {
          rows: [
            {
              chain_id: String(CHAIN_ID),
              address: SMART_ACCOUNT.address.toLowerCase(),
              owner: OTHER_WALLET.address.toLowerCase(),
              account_type: 'KERNEL',
            },
          ],
        };
      }
      if (/from session_keys/.test(text)) return { rows: [] };
      throw new Error(`fake db: unexpected query ${text}`);
    });
    const owner = (portfolioId: number, wallet: string) =>
      requireOwnedPortfolio(portfolioId, wallet, { query: foreign, chainId: CHAIN_ID });
    const build = (portfolioId: number, wallet: string) =>
      buildRenewalParams(portfolioId, wallet, {
        requireOwnedPortfolio: owner,
        sessionKeyConfig: () => SESSION_KEY_CONFIG,
        publicClient: FAKE_PUBLIC_CLIENT,
        chainId: CHAIN_ID,
        validUntil: () => FIXED_VALID_UNTIL,
      });

    await withServer(
      async (baseUrl) => {
        const token = await loginToken(baseUrl);
        const res = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
        assert.equal(res.status, 403);
        const body = (await res.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'FORBIDDEN');
      },
      { buildRenewalParams: build },
    );
  }
});

test('renewal-params answers 500 naming the missing session key env vars', async () => {
  // 真的 requireSessionKeyConfig()，只是餵它一個空 env：錯誤訊息因此是 production 那一份。
  const { buildRenewalParams: build } = realRenewalParams(ownedPortfolio(), {
    sessionKeyConfig: () => requireSessionKeyConfig({}),
  });
  const onlyExecutor = realRenewalParams(ownedPortfolio(), {
    sessionKeyConfig: () => requireSessionKeyConfig({ EXECUTOR_ADDRESS: EXECUTOR }),
  });

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const missingBoth = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
      assert.equal(missingBoth.status, 500);
      const bothBody = (await missingBoth.json()) as { error: { code: string; message: string } };
      assert.equal(bothBody.error.code, 'SESSION_KEY_CONFIG');
      assert.match(bothBody.error.message, /EXECUTOR_ADDRESS/);
      assert.match(bothBody.error.message, /SESSION_KEY_MASTER_SEED/, 'the message must name what is missing');
    },
    { buildRenewalParams: build },
  );

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const onlyOne = await getJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, token);
      assert.equal(onlyOne.status, 500);
      const oneBody = (await onlyOne.json()) as { error: { code: string; message: string } };
      assert.equal(oneBody.error.code, 'SESSION_KEY_CONFIG');
      assert.match(oneBody.error.message, /SESSION_KEY_MASTER_SEED/);
      assert.doesNotMatch(oneBody.error.message, /EXECUTOR_ADDRESS 與/, 'only the missing one is reported');
    },
    { buildRenewalParams: onlyExecutor.buildRenewalParams },
  );
});

// ---------------------------------------------------------------------------
// POST /portfolios/:id/renewal-result
// ---------------------------------------------------------------------------

/** renewal-params 的真實產出，當成前端回傳的 body（使用者就是把它原樣送回來）。 */
async function renewalBodyFor(portfolio: OwnedPortfolio): Promise<Record<string, unknown>> {
  const { buildRenewalParams: build } = realRenewalParams(portfolio);
  const params = await build(PORTFOLIO_ID, WALLET_LOWER);
  return {
    txHash: '0xabc123',
    userOpHash: '0xdef456',
    permissionId: params.permissionId,
    sessionKeyAddress: params.sessionKeyAddress,
    keyRef: params.keyRef,
    validUntil: params.validUntil,
    policySnapshot: params.policySnapshot,
  };
}

function renewalResultServer(
  table: ReturnType<typeof fakeSessionKeys>,
  portfolio: OwnedPortfolio | null = ownedPortfolio(),
): { deps: Partial<ServerDeps>; record: typeof recordRenewalResult } {
  const owner = fixedOwnerQuery(portfolio);
  const record = (portfolioId: number, wallet: string, body: Record<string, unknown>) =>
    recordRenewalResult(portfolioId, wallet, body, {
      requireOwnedPortfolio: owner.requireOwnedPortfolio,
      query: table.query,
    });
  return { deps: { recordRenewalResult: record }, record };
}

test('POST /portfolios/:id/renewal-result inserts ONE new active row and leaves the old one alone', async () => {
  const oldRow: SessionKeyDbRow = {
    portfolio_id: String(PORTFOLIO_ID),
    key_ref: OLD_KEY_REF,
    permissions: { permissionId: '0xc0449df6' },
    expires_at: new Date(OLD_VALID_UNTIL * 1000),
    status: 'active',
  };
  const table = fakeSessionKeys([oldRow]);
  const { deps } = renewalResultServer(table);
  const body = await renewalBodyFor(ownedPortfolio());

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-result`, body, token);
      assert.equal(res.status, 200);
      const answered = (await res.json()) as {
        ok: boolean;
        recorded: { keyRef: string; permissionId: string };
        duplicate?: true;
      };
      assert.equal(answered.ok, true);
      assert.deepEqual(answered.recorded, { keyRef: body.keyRef, permissionId: body.permissionId });
      assert.equal(answered.duplicate, undefined, 'the first submission is not a duplicate');
    },
    deps,
  );

  assert.equal(table.rows.length, 2, 'exactly one new row');

  // 舊的那一列：狀態、到期日、permissions 全部原封不動（鏈上它還有效到自己的 expires_at）。
  assert.deepEqual(table.rows[0], oldRow);

  const inserted = table.rows[1];
  assert.equal(inserted?.portfolio_id, String(PORTFOLIO_ID));
  assert.equal(inserted?.key_ref, body.keyRef);
  assert.equal(inserted?.status, 'active');
  assert.deepEqual(inserted?.permissions, body.policySnapshot, 'permissions = the policy snapshot the front end sent');
  assert.equal(inserted?.expires_at.toISOString(), new Date(FIXED_VALID_UNTIL * 1000).toISOString());

  // INSERT 的原文與「重複提交」的處理：on conflict do nothing，沒有任何 UPDATE。
  const insert = table.calls.find((call) => /insert into session_keys/i.test(call.text));
  assert.ok(insert, 'the renewal result must be an INSERT into session_keys');
  assert.match(insert.text, /on conflict \(key_ref\) do nothing/);
  assert.equal(
    table.calls.some((call) => /update\s+session_keys/i.test(call.text)),
    false,
    'the old key must never be touched: it is still valid on chain',
  );
});

test('POST /portfolios/:id/renewal-result is idempotent: a retry answers duplicate: true and adds no row', async () => {
  const table = fakeSessionKeys();
  const { deps } = renewalResultServer(table);
  const body = await renewalBodyFor(ownedPortfolio());

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const first = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-result`, body, token);
      assert.equal(first.status, 200);

      const retry = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-result`, body, token);
      assert.equal(retry.status, 200, 'a duplicate submission is not an error');
      const answered = (await retry.json()) as {
        ok: boolean;
        recorded: { keyRef: string; permissionId: string };
        duplicate?: true;
      };
      assert.equal(answered.ok, true);
      assert.equal(answered.duplicate, true);
      assert.deepEqual(answered.recorded, { keyRef: body.keyRef, permissionId: body.permissionId });
    },
    deps,
  );

  assert.equal(table.rows.length, 1, 'the retry must not add a second row');
});

test('renewal-result answers 404/403/400 before it writes anything', async () => {
  const body = await renewalBodyFor(ownedPortfolio());

  // 404：portfolio 不存在。
  {
    const table = fakeSessionKeys();
    const { deps } = renewalResultServer(table, null);
    await withServer(
      async (baseUrl) => {
        const token = await loginToken(baseUrl);
        const res = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-result`, body, token);
        assert.equal(res.status, 404);
      },
      deps,
    );
    assert.equal(table.rows.length, 0, 'nothing may be written for a portfolio that does not exist');
  }

  // 400：body 形狀不對（缺 keyRef）。
  {
    const table = fakeSessionKeys();
    const { deps } = renewalResultServer(table);
    await withServer(
      async (baseUrl) => {
        const token = await loginToken(baseUrl);
        const res = await postJson(
          baseUrl,
          `/portfolios/${PORTFOLIO_ID}/renewal-result`,
          { ...body, keyRef: '' },
          token,
        );
        assert.equal(res.status, 400);
        const answered = (await res.json()) as { error: { code: string } };
        assert.equal(answered.error.code, 'INVALID_RENEWAL');
      },
      deps,
    );
    assert.equal(table.rows.length, 0);
  }

  // 400：validUntil 超出 uint48。
  {
    const table = fakeSessionKeys();
    const { deps } = renewalResultServer(table);
    await withServer(
      async (baseUrl) => {
        const token = await loginToken(baseUrl);
        const res = await postJson(
          baseUrl,
          `/portfolios/${PORTFOLIO_ID}/renewal-result`,
          { ...body, validUntil: 2 ** 48 },
          token,
        );
        assert.equal(res.status, 400);
      },
      deps,
    );
    assert.equal(table.rows.length, 0);
  }

  // 403：不是自己的 portfolio（真的 requireOwnedPortfolio）。
  {
    const table = fakeSessionKeys();
    const now = new Date('2026-11-06T00:00:00.000Z');
    const { query: foreign } = asQuery((text) => {
      if (/from portfolios/.test(text)) {
        return {
          rows: [
            {
              id: String(PORTFOLIO_ID),
              user_id: OTHER_WALLET.address.toLowerCase(),
              strategy_id: String(STRATEGY_ID),
              version: 1,
              schedule_state: 'active',
              created_at: now,
            },
          ],
        };
      }
      if (/from smart_accounts/.test(text)) return { rows: [] };
      throw new Error(`fake db: unexpected query ${text}`);
    });
    const record = (portfolioId: number, wallet: string, input: Record<string, unknown>) =>
      recordRenewalResult(portfolioId, wallet, input, {
        requireOwnedPortfolio: (id, owner) =>
          requireOwnedPortfolio(id, owner, { query: foreign, chainId: CHAIN_ID }),
        query: table.query,
      });

    await withServer(
      async (baseUrl) => {
        const token = await loginToken(baseUrl);
        const res = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-result`, body, token);
        assert.equal(res.status, 403);
      },
      { recordRenewalResult: record },
    );
    assert.equal(table.rows.length, 0);
  }
});

test('renewal-result refuses a keyRef that already belongs to another portfolio', async () => {
  const table = fakeSessionKeys([
    {
      portfolio_id: '99',
      key_ref: OLD_KEY_REF,
      permissions: {},
      expires_at: new Date(OLD_VALID_UNTIL * 1000),
      status: 'active',
    },
  ]);
  const { deps } = renewalResultServer(table);

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await postJson(
        baseUrl,
        `/portfolios/${PORTFOLIO_ID}/renewal-result`,
        {
          permissionId: '0xc0449df6',
          keyRef: OLD_KEY_REF,
          validUntil: FIXED_VALID_UNTIL,
          policySnapshot: { version: 1 },
        },
        token,
      );
      assert.equal(res.status, 409, 'silently answering duplicate would claim a key that is not ours');
      const answered = (await res.json()) as { error: { code: string } };
      assert.equal(answered.error.code, 'KEY_REF_CONFLICT');
    },
    deps,
  );
});

// ---------------------------------------------------------------------------
// routing: GET /portfolios vs POST /portfolios vs the two sub-routes
// ---------------------------------------------------------------------------

test('GET /portfolios and POST /portfolios dispatch to different handlers', async () => {
  const calls: string[] = [];
  const listFn = (async (wallet: string) => {
    calls.push(`list:${wallet}`);
    return [];
  }) as unknown as typeof listPortfolios;
  const enrollFn = (async (strategyId: number, wallet: string) => {
    calls.push(`enroll:${strategyId}:${wallet}`);
    return samplePortfolio(strategyId);
  }) as unknown as typeof enrollPortfolio;

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const listed = await getJson(baseUrl, '/portfolios', token);
      assert.equal(listed.status, 200);
      const enrolled = await postJson(baseUrl, '/portfolios', { strategyId: 9 }, token);
      assert.equal(enrolled.status, 201);
    },
    { listPortfolios: listFn, enrollPortfolio: enrollFn },
  );

  assert.deepEqual(calls, [`list:${WALLET_LOWER}`, `enroll:9:${WALLET_LOWER}`]);
});

test('POST /portfolios/:id/renewal-result is not swallowed by POST /portfolios', async () => {
  let enrollCalls = 0;
  let resultCalls = 0;
  const enrollFn = (async () => {
    enrollCalls += 1;
    return samplePortfolio();
  }) as unknown as typeof enrollPortfolio;
  const resultFn = (async () => {
    resultCalls += 1;
    return { ok: true as const, recorded: { keyRef: OLD_KEY_REF, permissionId: '0xc0449df6' } };
  }) as unknown as typeof recordRenewalResult;

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await postJson(
        baseUrl,
        `/portfolios/${PORTFOLIO_ID}/renewal-result`,
        { permissionId: '0xc0449df6', keyRef: OLD_KEY_REF, validUntil: FIXED_VALID_UNTIL, policySnapshot: {} },
        token,
      );
      assert.equal(res.status, 200);
      const answered = (await res.json()) as { ok: boolean };
      assert.equal(answered.ok, true);
    },
    { enrollPortfolio: enrollFn, recordRenewalResult: resultFn },
  );

  assert.equal(enrollCalls, 0, 'the enroll route must not see this path (different segment count)');
  assert.equal(resultCalls, 1);
});

test('each portfolio route rejects the wrong method with its own Allow header', async () => {
  const serverDeps: Partial<ServerDeps> = {
    listPortfolios: (async () => []) as unknown as typeof listPortfolios,
    enrollPortfolio: (async () => samplePortfolio()) as unknown as typeof enrollPortfolio,
    recordRenewalResult: (async () => ({
      ok: true as const,
      recorded: { keyRef: 'x', permissionId: 'y' },
    })) as unknown as typeof recordRenewalResult,
    buildRenewalParams: (async () => {
      throw new Error('not used');
    }) as unknown as typeof buildRenewalParams,
  };

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const headers = { authorization: `Bearer ${token}` };

      const putRoot = await fetch(`${baseUrl}/portfolios`, { method: 'PUT', headers });
      assert.equal(putRoot.status, 405);
      assert.equal(putRoot.headers.get('allow'), 'GET, POST', 'both methods are routed on /portfolios');

      const postParams = await postJson(baseUrl, `/portfolios/${PORTFOLIO_ID}/renewal-params`, {}, token);
      assert.equal(postParams.status, 405);
      assert.equal(postParams.headers.get('allow'), 'GET');

      const getResult = await fetch(`${baseUrl}/portfolios/${PORTFOLIO_ID}/renewal-result`, { headers });
      assert.equal(getResult.status, 405);
      assert.equal(getResult.headers.get('allow'), 'POST');

      const badId = await fetch(`${baseUrl}/portfolios/abc/renewal-params`, { headers });
      assert.equal(badId.status, 400);
      const badIdBody = (await badId.json()) as { error: { code: string } };
      assert.equal(badIdBody.error.code, 'INVALID_ID');
    },
    serverDeps,
  );
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

test('resolveCorsConfig defaults to the vite dev origins and parses CORS_ALLOWED_ORIGINS', () => {
  assert.deepEqual(
    resolveCorsConfig({}).allowedOrigins,
    DEFAULT_CORS_ALLOWED_ORIGINS.map((origin) => origin.toLowerCase()),
  );
  assert.deepEqual(
    resolveCorsConfig({ CORS_ALLOWED_ORIGINS: ' https://app.cre8.xyz , http://localhost:4000 ' }).allowedOrigins,
    ['https://app.cre8.xyz', 'http://localhost:4000'],
  );
  assert.deepEqual(resolveCorsConfig({ CORS_ALLOWED_ORIGINS: '' }).allowedOrigins, [
    ...DEFAULT_CORS_ALLOWED_ORIGINS,
  ]);
  // `*` 刻意沒有被展開成萬用字元：請求帶 Authorization，`*` 不能與 credentials 併用。
  assert.equal(allowedCorsOrigin('http://evil.example', resolveCorsConfig({ CORS_ALLOWED_ORIGINS: '*' })), null);
  assert.equal(allowedCorsOrigin('http://LOCALHOST:5173', resolveCorsConfig({})), 'http://LOCALHOST:5173');
  assert.equal(allowedCorsOrigin(undefined, resolveCorsConfig({})), null);
});

test('OPTIONS preflight from an allowed origin answers 204 with the CORS grant', async () => {
  await withServer(
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/portfolios`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.equal(res.headers.get('access-control-allow-methods'), CORS_ALLOWED_METHODS);
      assert.equal(res.headers.get('access-control-allow-headers'), CORS_ALLOWED_HEADERS);
      assert.equal(res.headers.get('access-control-max-age'), String(CORS_MAX_AGE_SECONDS));
      assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
      assert.match(res.headers.get('vary') ?? '', /Origin/);

      // preflight 不該被路由的 404／405 擋掉：瀏覽器在拿到回應之前不知道路徑存不存在。
      const unknown = await fetch(`${baseUrl}/portfolios/9/whatever`, {
        method: 'OPTIONS',
        headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'GET' },
      });
      assert.equal(unknown.status, 204);
      assert.equal(unknown.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
    },
    { cors: resolveCorsConfig({}) },
  );
});

test('OPTIONS preflight from an unlisted origin gets no CORS grant (and no 500)', async () => {
  await withServer(
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/portfolios`, {
        method: 'OPTIONS',
        headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
      });
      assert.equal(res.status, 204, 'the request completes; the browser is what blocks it');
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.equal(res.headers.get('access-control-allow-methods'), null);
      assert.equal(res.headers.get('access-control-allow-credentials'), null);
      assert.match(res.headers.get('vary') ?? '', /Origin/);
    },
    { cors: resolveCorsConfig({}) },
  );
});

test('a normal request from an allowed origin carries Access-Control-Allow-Origin and Vary: Origin', async () => {
  const listFn = (async () => []) as unknown as typeof listPortfolios;
  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);

      const allowed = await fetch(`${baseUrl}/portfolios`, {
        headers: { authorization: `Bearer ${token}`, origin: 'http://localhost:5173' },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
      assert.match(allowed.headers.get('vary') ?? '', /Origin/);
      assert.match(allowed.headers.get('content-type') ?? '', /application\/json/);

      // 未列入清單的 origin：沒有任何 CORS 標頭，但請求本身照常處理（CORS 不是認證）。
      const plain = await fetch(`${baseUrl}/portfolios`, { headers: { origin: 'http://evil.example' } });
      assert.equal(plain.status, 401, 'no token → 401 regardless of Origin');
      assert.equal(plain.headers.get('access-control-allow-origin'), null);
    },
    { listPortfolios: listFn, cors: resolveCorsConfig({}) },
  );
});

// ---------------------------------------------------------------------------
// POST /bundler — relay
// ---------------------------------------------------------------------------

/**
 * alto v1.2.5 沒有 CORS 支援，瀏覽器**永遠**無法直連 bundler（dev 與 production 都一樣），
 * 所以 `/bundler` 是唯一的路徑。這組測試釘住三件不能被改壞的事：白名單外不轉發、
 * 上游的 JSON-RPC `error` 原樣透傳、上游掛掉是 502 且訊息能指出是哪個 bundler。
 */

const UPSTREAM_BUNDLER = 'http://127.0.0.1:3001';

/** 假的上游 bundler：記下每一次 body，回傳固定的 bytes／status（或直接 throw）。 */
function fakeUpstream(reply: { status?: number; body: string; contentType?: string } | Error): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fake = (async (_input: unknown, init?: RequestInit) => {
    if (reply instanceof Error) throw reply;
    calls.push(String(init?.body ?? ''));
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.contentType ?? 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fake, calls };
}

function postBundler(baseUrl: string, body: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/bundler`, { method: 'POST', headers, body });
}

test('POST /bundler forwards a whitelisted method as-is and returns the upstream error object unchanged', async () => {
  // 請求刻意帶不規則空白：能原樣出現在上游就證明 relay 轉發的是「收到的 bytes」，不是重新序列化的物件。
  const requestBody = '{"jsonrpc":"2.0","id":7, "method":"eth_getUserOperationReceipt","params":["0xdead"]}';
  const upstreamBody =
    '{"jsonrpc":"2.0","id":7,"error":{"code":-32500,"message":"AA25 invalid account nonce","data":{"reason":"nonce too low","sender":"0xabc"}}}';
  const upstream = fakeUpstream({ body: upstreamBody });

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await postBundler(baseUrl, requestBody, token);

      assert.equal(res.status, 200);
      // 一字不差：error 物件沒有被改寫，也沒有被後端的 {error:{code,message}} 形狀蓋掉。
      assert.equal(await res.text(), upstreamBody);
      assert.equal(upstream.calls.length, 1);
      assert.equal(upstream.calls[0], requestBody, 'body 原樣轉發');
    },
    { bundlerUrl: UPSTREAM_BUNDLER, bundlerFetch: upstream.fetch },
  );
});

test('POST /bundler passes the upstream HTTP status through (a 500 JSON-RPC error stays a 500)', async () => {
  const upstreamBody = '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"precheck failed"}}';
  const upstream = fakeUpstream({ status: 500, body: upstreamBody });

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await postBundler(
        baseUrl,
        '{"jsonrpc":"2.0","id":1,"method":"eth_sendUserOperation","params":[{}, "0x0000000071727De22E5E9d8BAf0edAc6f37da032"]}',
        token,
      );

      assert.equal(res.status, 500, '上游 status 透傳，不改寫成 200');
      assert.equal(await res.text(), upstreamBody);
    },
    { bundlerUrl: UPSTREAM_BUNDLER, bundlerFetch: upstream.fetch },
  );
});

test('POST /bundler rejects a non-whitelisted method with 403 and never calls the upstream', async () => {
  const upstream = fakeUpstream({ body: '{"jsonrpc":"2.0","id":1,"result":"0x1"}' });

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await postBundler(
        baseUrl,
        '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0xdead"]}',
        token,
      );

      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'BUNDLER_METHOD_NOT_ALLOWED');
      assert.match(body.error.message, /eth_sendRawTransaction/);
      // 「不轉發」唯一能證明的方式：上游一次都沒被呼叫。
      assert.equal(upstream.calls.length, 0, 'upstream fetch 呼叫次數必須是 0');
    },
    { bundlerUrl: UPSTREAM_BUNDLER, bundlerFetch: upstream.fetch },
  );
});

test('POST /bundler without a bearer token is 401 and never calls the upstream', async () => {
  const upstream = fakeUpstream({ body: '{"jsonrpc":"2.0","id":1,"result":"0x1"}' });

  await withServer(
    async (baseUrl) => {
      const res = await postBundler(baseUrl, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'UNAUTHORIZED');
      assert.equal(upstream.calls.length, 0);
    },
    { bundlerUrl: UPSTREAM_BUNDLER, bundlerFetch: upstream.fetch },
  );
});

test('POST /bundler reports an unreachable upstream as 502 with the bundler URL in the message', async () => {
  const upstream = fakeUpstream(new TypeError('fetch failed: ECONNREFUSED'));

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await postBundler(baseUrl, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', token);

      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'BUNDLER_UNAVAILABLE');
      assert.match(body.error.message, /http:\/\/127\.0\.0\.1:3001/, '訊息要指出是哪個 bundler');
      assert.match(body.error.message, /ECONNREFUSED/, '上游的原因也要留著');
      // 不洩漏私鑰：這支 relay 沒有任何金鑰，回應裡也不該出現 0x + 64 hex 這種東西。
      assert.doesNotMatch(body.error.message, /0x[0-9a-fA-F]{64}/);
    },
    { bundlerUrl: UPSTREAM_BUNDLER, bundlerFetch: upstream.fetch },
  );
});

test('POST /bundler accepts every whitelisted method and nothing else', async () => {
  for (const method of BUNDLER_METHOD_WHITELIST) {
    const upstream = fakeUpstream({ body: `{"jsonrpc":"2.0","id":1,"result":"${method}-ok"}` });
    await withServer(
      async (baseUrl) => {
        const token = await loginToken(baseUrl);
        const res = await postBundler(baseUrl, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }), token);
        assert.equal(res.status, 200, `${method} 必須被放行`);
        assert.equal(upstream.calls.length, 1, `${method} 必須被轉發`);
      },
      { bundlerUrl: UPSTREAM_BUNDLER, bundlerFetch: upstream.fetch },
    );
  }

  // 形狀不對的 body（沒有 method）也回 403，不是 500、更不是轉發一個殘缺請求。
  const upstream = fakeUpstream({ body: '{"jsonrpc":"2.0","id":1,"result":"0x1"}' });
  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await postBundler(baseUrl, '{"jsonrpc":"2.0","id":1,"params":[]}', token);
      assert.equal(res.status, 403);
      assert.equal(upstream.calls.length, 0);
    },
    { bundlerUrl: UPSTREAM_BUNDLER, bundlerFetch: upstream.fetch },
  );
});

test('POST /bundler from an allowed origin carries Access-Control-Allow-Origin', async () => {
  const upstream = fakeUpstream({ body: '{"jsonrpc":"2.0","id":1,"result":"0x1"}' });

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);

      const allowed = await fetch(`${baseUrl}/bundler`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          origin: 'http://localhost:5173',
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      });
      assert.equal(allowed.status, 200);
      // 這就是「瀏覽器不必直連 bundler」的全部理由：這一個標頭 alto v1.2.5 永遠不會給。
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
      assert.match(allowed.headers.get('vary') ?? '', /Origin/);

      // 403 這種錯誤回應也帶著 CORS 標頭，否則前端看不到真正的錯誤碼。
      const denied = await fetch(`${baseUrl}/bundler`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          origin: 'http://localhost:5173',
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_sign","params":[]}',
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    },
    { bundlerUrl: UPSTREAM_BUNDLER, bundlerFetch: upstream.fetch, cors: resolveCorsConfig({}) },
  );
});
