import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  RpcRequestError,
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  toFunctionSelector,
  toHex,
} from 'viem';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import type { PermissionPlugin } from '@zerodev/permissions';
import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';
import type { SiweChallenge } from '../src/auth.js';
import { canonicalScheduleHash, deploySmartAccount } from '../src/chain.js';
import type { ChainConfig } from '../src/chain.js';
import { requireSessionKeyConfig, DEFAULT_MIN_SESSION_GAS_WEI } from '../src/config.js';
import { closePool, migrate } from '../src/db.js';
import { describeGasStatus } from '../src/funding.js';
import { computeSalt } from '../src/kernel.js';
import { deriveSessionKeyFor, describePolicies, sessionKeyIndexFor, sessionValidUntil } from '../src/permissions.js';
import type { SessionPolicySnapshot } from '../src/permissions.js';
import { enrollPortfolio } from '../src/portfolios.js';
import type { EnrollDeps, Portfolio } from '../src/portfolios.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';

/**
 * DB + chain integration tests only run when everything they need is configured; otherwise they are
 * skipped. The session-key env belongs in the gate: enroll cannot derive a key (nor install its
 * permissions) without it, so running this test without them would only test the error path.
 *
 * 「設定齊全」還不夠：這個測試會真的送鏈上交易（createStrategy 的 mirror、publishVersion、
 * enroll 的 counterfactual deploy）。只要 .env 補齊就自動開跑，而它一輪要十幾秒、遠超過 bun
 * 預設的 5 秒 per-test timeout，逾時後底層的交易還在跑，下一個測試就會撞到同一個 operator nonce。
 * 所以送出交易這件事要另外用 RUN_CHAIN_TESTS=1 明確 opt-in。
 */
const skipIntegration: boolean | string =
  process.env.DATABASE_URL && process.env.RPC_URL && process.env.EXECUTOR_ADDRESS && process.env.SESSION_KEY_MASTER_SEED
    ? process.env.RUN_CHAIN_TESTS === '1'
      ? false
      : 'RUN_CHAIN_TESTS=1 才會執行（這個測試會真的送鏈上交易、共用 operator 帳號的 nonce，所以預設關閉；要跑請用 RUN_CHAIN_TESTS=1 bun test --timeout=120000，不要加 --concurrent（預設 5 秒逾時太短，逾時的測試還在背景送交易，會和下一個測試撞 nonce））'
    : 'DATABASE_URL, RPC_URL, EXECUTOR_ADDRESS and SESSION_KEY_MASTER_SEED are required for the enroll integration test';

/**
 * bun 只印 `(skip) <測試名>`，不印 `skip` 的字串理由 —— 看到 `(skip)` 的人不知道為什麼、也不知道怎麼開。
 * 所以在模組載入時自己印一次（gate 關閉才印）。
 */
if (skipIntegration !== false) {
  console.log(`[skip] 鏈上寫入測試未執行（${String(skipIntegration)}）`);
  console.log(
    '[skip] 要跑請用：RUN_CHAIN_TESTS=1 bun test --timeout=120000（不要加 --concurrent：會真的送交易、共用 operator nonce）',
  );
}

const ROUTE_WALLET = privateKeyToAccount(generatePrivateKey());

// ---------------------------------------------------------------------------
// helpers
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

async function loginToken(baseUrl: string): Promise<string> {
  const nonceResponse = await fetch(`${baseUrl}/auth/nonce`, { method: 'POST' });
  assert.equal(nonceResponse.status, 200);
  const challenge = (await nonceResponse.json()) as SiweChallenge;
  const message = createSiweMessage({
    address: ROUTE_WALLET.address,
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
    signature: await ROUTE_WALLET.signMessage({ message }),
  });
  assert.equal(loginResponse.status, 200);
  const { token } = (await loginResponse.json()) as { token: string };
  return token;
}

function samplePortfolio(id = 1): Portfolio {
  return {
    id,
    userId: ROUTE_WALLET.address.toLowerCase(),
    strategyId: 1,
    strategyName: 'Test fund',
    version: 1,
    scheduleState: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    smartAccounts: [
      { chainId: 56, address: ROUTE_WALLET.address.toLowerCase(), owner: ROUTE_WALLET.address.toLowerCase(), accountType: 'KERNEL' },
    ],
    gas: describeGasStatus({
      address: ROUTE_WALLET.address.toLowerCase() as Address,
      balanceWei: 5n * 10n ** 16n,
      minimumWei: DEFAULT_MIN_SESSION_GAS_WEI,
      gasPriceWei: 1_220_000_000n,
    }),
  };
}

// ---------------------------------------------------------------------------
// route: POST /portfolios (enrollPortfolio injected, no DB)
// ---------------------------------------------------------------------------

test('POST /portfolios requires a bearer token (401)', async () => {
  await withServer(async (baseUrl) => {
    const res = await postJson(baseUrl, '/portfolios', { strategyId: 1 });
    assert.equal(res.status, 401);
  });
});

test('POST /portfolios calls enrollPortfolio(strategyId, session wallet) and returns 201', async () => {
  const calls: Array<{ strategyId: number; wallet: string }> = [];
  const fake: typeof enrollPortfolio = async (strategyId, wallet) => {
    calls.push({ strategyId, wallet });
    return samplePortfolio(1);
  };

  await withServer(async (baseUrl) => {
    const token = await loginToken(baseUrl);
    const res = await postJson(baseUrl, '/portfolios', { strategyId: 42 }, token);
    assert.equal(res.status, 201);
    const body = (await res.json()) as Portfolio;
    assert.equal(body.id, 1);
    assert.equal(res.headers.get('location'), '/portfolios/1');
  }, { enrollPortfolio: fake });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.strategyId, 42);
  assert.equal(calls[0]?.wallet, ROUTE_WALLET.address.toLowerCase());
});

test('POST /portfolios rejects a non-integer strategyId (400)', async () => {
  await withServer(async (baseUrl) => {
    const token = await loginToken(baseUrl);
    const res = await postJson(baseUrl, '/portfolios', { strategyId: 'abc' }, token);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'INVALID_ID');
  });
});

test('POST /portfolios rejects a non-object body (400)', async () => {
  await withServer(async (baseUrl) => {
    const token = await loginToken(baseUrl);
    const res = await fetch(`${baseUrl}/portfolios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'null',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'INVALID_PORTFOLIO');
  });
});

test('an unsupported method on /portfolios is not allowed (405)', async () => {
  // GET 現在是列表（`test/renewal.test.ts` 有專屬測試），所以拿一個兩個 method 都不是的動詞來驗
  // 405；`allow` 必須同時列出兩個，否則前端只會知道「可以 POST」而不知道列表怎麼拿。
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/portfolios`, { method: 'PUT' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, POST');
  });
});

test('POST /portfolios 201 body carries the gas status (where to send BNB, is it ready)', async () => {
  const fake: typeof enrollPortfolio = async () => samplePortfolio(7);

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const res = await postJson(baseUrl, '/portfolios', { strategyId: 7 }, token);
      assert.equal(res.status, 201);

      const body = (await res.json()) as Portfolio;
      assert.ok(body.gas, 'the response must tell the user where to send BNB');
      // 形狀固定：前端可以照這幾個鍵寫，不需要猜。
      assert.deepEqual(Object.keys(body.gas).sort(), [
        'address',
        'balanceWei',
        'estimatedOps',
        'gasPriceKnown',
        'minimumWei',
        'ready',
        'shortfallWei',
      ]);
      assert.equal(body.gas.address, body.smartAccounts[0]?.address);
      assert.equal(body.gas.ready, true);
      assert.equal(body.gas.shortfallWei, '0');
      // wei 一律是十進位字串：JSON 的 number 只到 2^53 - 1，1e16 就已經失真。
      assert.equal(body.gas.balanceWei, (5n * 10n ** 16n).toString());
      assert.equal(body.gas.minimumWei, DEFAULT_MIN_SESSION_GAS_WEI.toString());
      assert.equal(typeof body.gas.estimatedOps, 'number');

      // 既有契約不變：加欄位不加行為。
      assert.equal(body.id, 7);
      assert.equal(res.headers.get('location'), '/portfolios/7');
    },
    { enrollPortfolio: fake },
  );
});

// ---------------------------------------------------------------------------
// chain: canonical schedule hash
// ---------------------------------------------------------------------------

test('canonicalScheduleHash is deterministic and distinct per schedule', () => {
  const a = canonicalScheduleHash({ kind: 'interval', intervalSeconds: 86_400 });
  const b = canonicalScheduleHash({ kind: 'interval', intervalSeconds: 86_400 });
  const c = canonicalScheduleHash({ kind: 'interval', intervalSeconds: 3_600 });
  const d = canonicalScheduleHash({ kind: 'cron', cron: '0 0 * * *' });

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

// ---------------------------------------------------------------------------
// enrollPortfolio: idempotency + DB parameters (injected fakes, no DB, no chain)
// ---------------------------------------------------------------------------

const OWNER = ROUTE_WALLET.address.toLowerCase();
const KERNEL_ACCOUNT = privateKeyToAccount(generatePrivateKey());
/** Checksummed on purpose: smart_accounts only accepts lowercase, so the code must lowercase it. */
const KERNEL_CHECKSUMMED = KERNEL_ACCOUNT.address;
const KERNEL_LOWERCASE = KERNEL_ACCOUNT.address.toLowerCase();
const STRATEGY_ON_CHAIN = { onchain_id: '7', active_version: 1 };
/** 帳戶的假餘額：0.05 BNB（高於 0.01 BNB 門檻），gas price 1.22 gwei 是鏈上實測值。 */
const FAKE_GAS_BALANCE_WEI = 5n * 10n ** 16n;
const FAKE_GAS_PRICE_WEI = 1_220_000_000n;

type FakeDbCall = { text: string; params: readonly unknown[] };

/** One active (portfolio, smart account) join row, as the idempotency query returns it. */
function enrollmentRow(id: string, accountType: string) {
  return {
    id,
    user_id: OWNER,
    strategy_id: '3',
    version: 1,
    schedule_state: 'active',
    created_at: new Date('2026-01-02T03:04:05.000Z'),
    chain_id: '31337',
    address: accountType === 'KERNEL' ? KERNEL_LOWERCASE : OWNER,
    owner: OWNER,
    account_type: accountType,
  };
}

/**
 * Answers the idempotency select the way Postgres would: applies the `account_type` predicate the SQL
 * actually states, then `order by p.id limit 1`. A query that stops filtering on account_type
 * therefore answers with the legacy 'EOA' row whenever that row has the lower id — which is exactly
 * the bug the coexistence test below exists to catch.
 */
function dbWouldReturn(rows: unknown[], sql: string): unknown[] {
  const onlyKernel = /s\.account_type\s*=\s*'KERNEL'/i.test(sql);
  const kept = onlyKernel
    ? rows.filter((row) => (row as { account_type?: string }).account_type === 'KERNEL')
    : [...rows];
  return kept.sort((a, b) => Number((a as { id: string }).id) - Number((b as { id: string }).id)).slice(0, 1);
}

/** CallPolicy 的 target（rebalance executor）：測試釘死一個地址，不讀 env。 */
const EXECUTOR = getAddress('0x60691760815C69d32c1F68146FA11669F62A4b38');
/** 測試用 master seed：32 bytes 的 0x11 重複。 */
const MASTER_SEED: Hex = `0x${'11'.repeat(32)}`;
/** 與 production 同一條路徑、同一個入口的產出形狀，只是值由測試釘死（不讀 process.env）。 */
const SESSION_KEY_CONFIG: ReturnType<typeof requireSessionKeyConfig> = {
  executorAddress: EXECUTOR,
  masterSeed: MASTER_SEED,
};

/** 假的 permission validator：enrollPortfolio 只把它原樣放進 plugins.regular，不會呼叫它。 */
const PERMISSION_VALIDATOR = {
  address: getAddress('0x00000000000000000000000000000000000000aa'),
} as unknown as PermissionPlugin;
/** initConfig 的形狀：兩筆 calldata（installValidations + delegatecall grantAccess），同真品。 */
const FAKE_INIT_CONFIG: Hex[] = ['0x9198bdf5deadbeef', '0xe9ae5c53deadbeef'];
const FAKE_PERMISSION_ID: Hex = '0x12345678';
const SESSION_VALID_UNTIL = 1_800_000_000;

/**
 * 只需要 `chain` 的 publicClient：sudo validator 的位址由 Kernel 版本表決定，不打鏈。
 * 若 SDK 真的去問鏈，這裡會炸出 method 名稱（而不是讓測試靜默通過）。
 */
const FAKE_PUBLIC_CLIENT = {
  chain: bsc,
  request: async ({ method }: { method: string }) => {
    // signerToEcdsaValidator 會問 chain id（viem 的 getChainId 一律走 RPC，不吃 client.chain）。
    if (method === 'eth_chainId') return toHex(31337);
    throw new Error(`fake publicClient: 不支援的 RPC method ${method}`);
  },
} as unknown as PublicClient;

/**
 * 假的 `enrollment_intents`：照真表的語意實作 —— 第一次 mint 一個值，之後**一律讀回同一列**
 * （`on conflict do nothing` + SELECT）。所以「重試會不會拿到同一個 validUntil」在測試裡是可觀察的
 * 行為，而不是一個硬寫死的常數。
 *
 * 每次真的 mint 都往後推 3600 秒，模擬「時間一直在走」：實作若改回自己取當前時間，得到的就是另一個
 * 值（進而是另一個 initConfig、另一個帳戶地址），測試才會紅。
 */
type IntentStore = {
  resolve: EnrollDeps['resolveValidUntil'];
  /** 每一次 resolve 的參數，用來證明 enrollPortfolio 真的走了這個接縫。 */
  calls: Array<{ userId: string; strategyId: bigint; chainId: bigint }>;
  /** 目前存在那一列的值（沒有就是 undefined）。 */
  peek: (userId: string, strategyId: bigint, chainId: bigint) => bigint | undefined;
};

function intentKeyOf(userId: string, strategyId: bigint, chainId: bigint): string {
  return `${userId}:${strategyId.toString()}:${chainId.toString()}`;
}

function createIntentStore(seed: Record<string, bigint> = {}): IntentStore {
  const rows = new Map<string, bigint>(Object.entries(seed));
  const calls: IntentStore['calls'] = [];
  // 同一個 store 的第一次 mint 就是 production 的預設（now + 365 天），後續 mint 各前進一小時。
  let mints = 0;

  return {
    calls,
    peek: (userId, strategyId, chainId) => rows.get(intentKeyOf(userId, strategyId, chainId)),
    resolve: async (userId, strategyId, chainId) => {
      calls.push({ userId, strategyId, chainId });
      const key = intentKeyOf(userId, strategyId, chainId);
      const existing = rows.get(key);
      if (existing !== undefined) return existing;
      const minted = BigInt(SESSION_VALID_UNTIL) + BigInt(mints) * 3_600n;
      mints += 1;
      rows.set(key, minted);
      return minted;
    },
  };
}

/** Fakes every seam enrollPortfolio touches and records every call for assertions. */
function fakeEnrollDeps(existingRows: unknown[] = [], insertedPortfolioId = '11', intents: IntentStore = createIntentStore()) {
  const calls = {
    reads: [] as FakeDbCall[],
    writes: [] as FakeDbCall[],
    deploy: [] as Array<{ owner: string; strategyId: bigint; options: Parameters<typeof deploySmartAccount>[2] }>,
    enroll: [] as Array<{ account: string; onchainId: number }>,
    permissions: [] as Array<{ sessionKeyAddress: string; executorAddress: string; validUntil: number | undefined }>,
    gas: [] as Array<{ address: string }>,
  };

  const fakeQuery = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> => {
    calls.reads.push({ text, params });
    if (text.includes('from strategies')) return { rows: [STRATEGY_ON_CHAIN] } as unknown as QueryResult<T>;
    if (text.includes('from portfolios p')) {
      return { rows: dbWouldReturn(existingRows, text) } as unknown as QueryResult<T>;
    }
    throw new Error(`fake db: unexpected select ${text}`);
  };

  const inserted: Array<{ chain_id: string; address: string; owner: string; account_type: string }> = [];
  const fakeClient = {
    query: async (text: string, params: readonly unknown[] = []) => {
      calls.writes.push({ text, params });
      if (text.includes('insert into portfolios')) {
        return {
          rows: [
            {
              id: insertedPortfolioId,
              user_id: OWNER,
              strategy_id: '3',
              version: 1,
              schedule_state: 'active',
              created_at: new Date('2026-02-03T04:05:06.000Z'),
            },
          ],
        };
      }
      if (text.includes('insert into smart_accounts')) {
        // Echo what the insert described, so the select below answers like a real table would.
        inserted.push({
          chain_id: String(params[1]),
          address: String(params[2]),
          owner: String(params[3]),
          account_type: text.includes("'KERNEL'") ? 'KERNEL' : 'EOA',
        });
        return { rows: [] };
      }
      if (text.includes('insert into session_keys')) return { rows: [] };
      if (text.includes('from smart_accounts')) return { rows: inserted };
      throw new Error(`fake db: unexpected write ${text}`);
    },
  } as unknown as PoolClient;

  const fakeTransaction = async <T,>(fn: (client: PoolClient) => Promise<T>): Promise<T> => fn(fakeClient);

  /**
   * 真的 `describePolicies` 負責三層 policy 的內容（純函式、不打鏈），假的只補上「這組權限是誰的」。
   * 這樣 DB 那筆 jsonb 的內容仍然來自 production 的同一份定義，不是測試自己捏的形狀。
   */
  const fakeBuildPermissions: EnrollDeps['buildSessionPermissions'] = async (args) => {
    // 這一條是「validUntil 只能來自 enrollment_intents」的守門員：production 的
    // buildSessionPermissions 在收不到 validUntil 時會自己用 sessionValidUntil() 現算一個，
    // 而那個現算值就是孤兒帳戶的根因。少傳一次，這裡就紅。
    assert.notEqual(
      args.validUntil,
      undefined,
      'enrollPortfolio must pass validUntil from enrollment_intents, never let the default mint one',
    );
    calls.permissions.push({
      sessionKeyAddress: args.sessionKeyAddress,
      executorAddress: args.executorAddress,
      validUntil: args.validUntil,
    });
    const validUntil = args.validUntil ?? SESSION_VALID_UNTIL;
    const expiresAt = new Date(validUntil * 1000);
    const policySnapshot: SessionPolicySnapshot = {
      ...describePolicies({ executorAddress: args.executorAddress, validUntil }),
      permissionId: FAKE_PERMISSION_ID,
      sessionKeyAddress: args.sessionKeyAddress,
      expiresAt: expiresAt.toISOString(),
    };
    return {
      permissionValidator: PERMISSION_VALIDATOR,
      initConfig: FAKE_INIT_CONFIG,
      permissionId: FAKE_PERMISSION_ID,
      policySnapshot,
      expiresAt,
    };
  };

  const fakeDeploy: EnrollDeps['deploySmartAccount'] = async (owner, strategyId, options) => {
    calls.deploy.push({ owner, strategyId, options });
    return { address: KERNEL_CHECKSUMMED, deployed: true };
  };

  const fakeEnroll: EnrollDeps['enrollOnchain'] = async (account, onchainId) => {
    calls.enroll.push({ account, onchainId });
  };

  // 0.05 BNB @ 1.22 gwei：遠高於 0.01 BNB 門檻，所以預設情況下 gas 狀態是 ready。
  const fakeGasBalance: EnrollDeps['getAccountGasBalance'] = async (address) => {
    calls.gas.push({ address });
    return FAKE_GAS_BALANCE_WEI;
  };
  const fakeGasPrice: EnrollDeps['getGasPriceWei'] = async () => FAKE_GAS_PRICE_WEI;

  const deps: Partial<EnrollDeps> = {
    query: fakeQuery,
    withTransaction: fakeTransaction,
    deploySmartAccount: fakeDeploy,
    enrollOnchain: fakeEnroll,
    chainId: 31337,
    publicClient: FAKE_PUBLIC_CLIENT,
    sessionKeyConfig: SESSION_KEY_CONFIG,
    buildSessionPermissions: fakeBuildPermissions,
    resolveValidUntil: intents.resolve,
    getAccountGasBalance: fakeGasBalance,
    getGasPriceWei: fakeGasPrice,
    minSessionGasWei: DEFAULT_MIN_SESSION_GAS_WEI,
  };

  return { deps, calls, intents };
}

test('enrollPortfolio returns the existing KERNEL portfolio without deploying or enrolling', async () => {
  const { deps, calls } = fakeEnrollDeps([enrollmentRow('11', 'KERNEL')]);

  const portfolio = await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.equal(portfolio.id, 11);
  assert.equal(portfolio.strategyId, 3);
  assert.equal(portfolio.version, 1);
  assert.equal(portfolio.userId, OWNER);
  assert.deepEqual(portfolio.smartAccounts, [
    { chainId: 31337, address: KERNEL_LOWERCASE, owner: OWNER, accountType: 'KERNEL' },
  ]);
  assert.equal(calls.deploy.length, 0, 'an idempotent re-enroll must not deploy');
  assert.equal(calls.enroll.length, 0, 'an idempotent re-enroll must not send an enroll tx');
  assert.equal(calls.writes.length, 0, 'an idempotent re-enroll must not write a DB row');
});

test('enrollPortfolio returns the KERNEL row when a lower-id legacy EOA row sits beside it', async () => {
  // The migrated-user shape: legacy EOA portfolio (id=1) kept next to the new KERNEL one (id=3).
  const { deps, calls } = fakeEnrollDeps([enrollmentRow('1', 'EOA'), enrollmentRow('3', 'KERNEL')]);

  const portfolio = await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.equal(portfolio.id, 3, 'must return the KERNEL portfolio, not the lower-id legacy EOA one');
  assert.deepEqual(portfolio.smartAccounts, [
    { chainId: 31337, address: KERNEL_LOWERCASE, owner: OWNER, accountType: 'KERNEL' },
  ]);
  assert.equal(calls.deploy.length, 0, 'a migrated user re-enrolling must not deploy again');
  assert.equal(calls.enroll.length, 0, 'a migrated user re-enrolling must not send another enroll tx');
  assert.equal(calls.writes.length, 0, 'a migrated user re-enrolling must not insert a duplicate smart_accounts row');

  const enrollmentSelect = calls.reads.find((call) => call.text.includes('from portfolios p'));
  assert.ok(enrollmentSelect, 'expected the idempotency select to run');
  assert.match(
    enrollmentSelect.text,
    /account_type = 'KERNEL'/,
    'the idempotency query itself must filter on account_type, not rely on the row it happens to get back',
  );
});

test('enrollPortfolio re-enrolls when the active portfolio is a legacy EOA account', async () => {
  const { deps, calls } = fakeEnrollDeps([enrollmentRow('9', 'EOA')]);

  const portfolio = await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.equal(calls.deploy.length, 1, 'a legacy EOA enrollment must not short-circuit the deploy');
  assert.equal(calls.enroll.length, 1);
  assert.equal(portfolio.id, 11, 'a new portfolio row, not the legacy EOA row');
  assert.deepEqual(portfolio.smartAccounts, [
    { chainId: 31337, address: KERNEL_LOWERCASE, owner: OWNER, accountType: 'KERNEL' },
  ]);
  assert.ok(calls.writes.some((call) => call.text.includes('insert into portfolios')));
});

test('enrollPortfolio enrolls the smart account address on-chain, not the EOA', async () => {
  const { deps, calls } = fakeEnrollDeps();

  await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.equal(calls.deploy.length, 1);
  assert.equal(calls.deploy[0]?.owner, OWNER);
  assert.equal(calls.deploy[0]?.strategyId, 3n);
  assert.equal(calls.enroll.length, 1);
  assert.equal(calls.enroll[0]?.account, KERNEL_CHECKSUMMED);
  assert.equal(calls.enroll[0]?.onchainId, 7);
  assert.notEqual(calls.enroll[0]?.account.toLowerCase(), OWNER);
});

test('enrollPortfolio writes the KERNEL smart account lowercase with the EOA as owner', async () => {
  assert.notEqual(KERNEL_CHECKSUMMED, KERNEL_LOWERCASE, 'fixture must differ in case to prove the lowering');
  const { deps, calls } = fakeEnrollDeps();

  await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  const insert = calls.writes.find((call) => call.text.includes('insert into smart_accounts'));
  assert.ok(insert, 'expected an insert into smart_accounts');
  assert.match(insert.text, /'KERNEL'/);
  assert.deepEqual(insert.params, [11, 31337, KERNEL_LOWERCASE, OWNER]);
});


// ---------------------------------------------------------------------------
// enrollPortfolio: the session key that enroll installs (injected fakes, no DB, no chain)
// ---------------------------------------------------------------------------

/** `(owner, strategyId)` 的 session key：production 走同一個純函式，所以這裡可以自己算期待值。 */
const EXPECTED_SESSION_KEY = deriveSessionKeyFor(OWNER as Address, 3n, { masterSeed: MASTER_SEED });

/** The one session_keys insert this enroll performed. */
function sessionKeyInsert(calls: { writes: FakeDbCall[] }): FakeDbCall {
  const insert = calls.writes.find((call) => call.text.includes('insert into session_keys'));
  assert.ok(insert, 'expected an insert into session_keys');
  return insert;
}

test('enrollPortfolio writes exactly one session_keys row: active, path-shaped key_ref, future expiry', async () => {
  const { deps, calls } = fakeEnrollDeps();

  await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  // Only the transaction client records into calls.writes, so being here means "inside the same
  // transaction as portfolios + smart_accounts", not "somewhere in the process".
  const portfolioInsert = calls.writes.find((call) => call.text.includes('insert into portfolios'));
  const accountInsert = calls.writes.find((call) => call.text.includes('insert into smart_accounts'));
  assert.ok(portfolioInsert && accountInsert, 'session_keys must be written next to the other two');
  assert.deepEqual(
    calls.writes
      .map((call) => call.text.match(/insert into (\w+)/)?.[1])
      .filter((table): table is string => table !== undefined),
    ['portfolios', 'smart_accounts', 'session_keys'],
    'one transaction, three inserts, in this order',
  );

  const insert = sessionKeyInsert(calls);
  assert.match(insert.text, /insert into session_keys \(portfolio_id, key_ref, permissions, expires_at, status\)/);
  assert.match(insert.text, /'active'/, 'a freshly installed key is active');
  assert.equal(insert.params.length, 4, 'key_ref / permissions / expires_at are bound; status is a literal');

  const [portfolioId, keyRef, permissions, expiresAt] = insert.params;
  assert.equal(portfolioId, 11, 'the row hangs off the portfolio id returned by the insert');
  assert.equal(keyRef, EXPECTED_SESSION_KEY.keyRef, 'deriveSessionKeyFor(owner, strategyId) is the one source');
  assert.match(String(keyRef), /^m\/44'\/60'\/0'\/0\/\d+$/, 'key_ref is a derivation path, not key material');
  assert.equal(/0x[0-9a-fA-F]{64}/.test(String(keyRef)), false, 'key_ref must not look like a private key');

  // jsonb 只接受字串/物件，不接受 bigint：這一條同時證明「沒有漏掉的 bigint」（有的話
  // JSON.stringify 會直接拋 TypeError，而不是等到 pg 那一層才失敗）。
  assert.equal(typeof permissions, 'string');
  const snapshot = JSON.parse(String(permissions)) as SessionPolicySnapshot;
  assert.deepEqual(Object.keys(snapshot).sort(), [
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
  assert.equal(snapshot.sessionKeyAddress, EXPECTED_SESSION_KEY.address, 'the row names the key it was built for');
  assert.equal(snapshot.permissionId, FAKE_PERMISSION_ID);
  assert.equal(snapshot.call.permissions.length, 1, 'call layer: one target + selector');
  assert.equal(snapshot.call.permissions[0]?.selector, '0x1b977850');
  assert.equal(BigInt(snapshot.gas.allowed), 10n ** 18n, 'gas layer: the one-shot 1e18 wei budget');
  assert.equal(snapshot.timestamp.validAfter, 0);

  // expires_at 就是 timestamp policy 的 validUntil：鏈上停止接受的瞬間與 DB 記的是同一個。
  // 這個值現在來自 enrollment_intents（這個 store 的第一次 mint = production 預設 now + 365 天）。
  assert.ok(expiresAt instanceof Date);
  assert.equal((expiresAt as Date).getTime(), SESSION_VALID_UNTIL * 1000);
  assert.equal(snapshot.timestamp.validUntil, Math.floor((expiresAt as Date).getTime() / 1000));
  assert.equal(snapshot.expiresAt, (expiresAt as Date).toISOString());
});

test('enrollPortfolio deploys with BOTH plugins and initConfig, so the account installs the permission', async () => {
  const { deps, calls } = fakeEnrollDeps();

  await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.equal(calls.permissions.length, 1, 'the permissions are built once, before the deploy');
  assert.equal(calls.permissions[0]?.executorAddress, EXECUTOR, 'the CallPolicy target comes from the config');
  assert.equal(
    calls.permissions[0]?.sessionKeyAddress,
    EXPECTED_SESSION_KEY.address,
    'the permissions are built for the derived key, not for some other address',
  );

  const options = calls.deploy[0]?.options;
  assert.ok(options, 'the deploy must receive plugins + initConfig');
  assert.deepEqual(options.initConfig, FAKE_INIT_CONFIG, 'initConfig is what actually installs the permission');

  // SDK 的 plugins 型別是「屬性包 | 現成的 KernelPluginManager 實例」，這裡傳的是屬性包；
  // 收窄成屬性包形狀才讀得到 sudo / regular。
  const plugins = options.plugins as unknown as
    | { sudo?: { address?: string }; regular?: unknown }
    | undefined;
  assert.equal(plugins?.regular, PERMISSION_VALIDATOR, 'regular = the session key permission validator');

  // sudo 必須是 owner 的 ECDSA validator（rootValidator），不能是 permission validator：
  // 給錯的話 rootValidator 就不會是 0x01 ++ ecdsaValidatorV31，owner 也簽不動自己的帳戶。
  const sudo = plugins?.sudo;
  assert.ok(sudo, 'a plugins object without sudo cannot build an account');
  assert.equal(String(sudo.address).toLowerCase(), KERNEL_V3_3_ADDRESSES.ecdsaValidatorV31.toLowerCase());
  assert.notEqual(String(sudo.address).toLowerCase(), EXPECTED_SESSION_KEY.address.toLowerCase());
});

test('enrollPortfolio derives the same session key and account on a retry (no DB id involved)', async () => {
  // 同一個 DB（共用 intent store），兩次完整 enroll：重試時 intent 已存在，讀回同一列。
  const intents = createIntentStore();
  const first = fakeEnrollDeps([], '11', intents);
  const second = fakeEnrollDeps([], '99', intents);

  await enrollPortfolio(3, ROUTE_WALLET.address, first.deps);
  await enrollPortfolio(3, ROUTE_WALLET.address, second.deps);

  const keyRefOf = (calls: { writes: FakeDbCall[] }): unknown => sessionKeyInsert(calls).params[1];
  assert.equal(keyRefOf(first.calls), keyRefOf(second.calls), 'the same (owner, strategyId) must reuse the key');
  assert.equal(
    keyRefOf(first.calls),
    `m/44'/60'/0'/0/${sessionKeyIndexFor(OWNER as Address, 3n).toString()}`,
    'the index is a pure function of (owner, strategyId) — a different portfolio id cannot move it',
  );
  assert.equal(
    second.calls.permissions[0]?.sessionKeyAddress,
    first.calls.permissions[0]?.sessionKeyAddress,
    'a retry must sign for the same key, otherwise initConfig changes and so does the account address',
  );
  assert.equal(
    second.calls.permissions[0]?.validUntil,
    first.calls.permissions[0]?.validUntil,
    'the retry must reuse the sealed validUntil, otherwise initConfig changes and so does the address',
  );
});

// ---------------------------------------------------------------------------
// enrollment_intents: validUntil 必須在鏈上動作之前釘死，重試讀回同一個
// ---------------------------------------------------------------------------

/** 假的 counterfactual 地址：由 (owner, strategyId, initConfig) 決定，與真鏈同一個因果關係。 */
function addressFromInitConfig(owner: string, strategyId: bigint, initConfig: Hex[] | undefined): Address {
  const salt = computeSalt(owner as Address, strategyId);
  return getAddress(`0x${keccak256(concatHex([salt, ...(initConfig ?? [])])).slice(-40)}`);
}

/** initConfig 帶著 timestamp policy 的 validUntil（uint48 = 6 bytes），所以它會改變帳戶地址。 */
function initConfigFor(validUntil: number): Hex[] {
  return [`0x9198bdf5${toHex(validUntil, { size: 6 }).slice(2)}`, FAKE_INIT_CONFIG[1] as Hex];
}

/** 把 buildSessionPermissions + deploySmartAccount 換成「地址真的由 initConfig 決定」的那組假替身。 */
function withValidUntilAddress(run: ReturnType<typeof fakeEnrollDeps>): void {
  run.deps.buildSessionPermissions = async (args) => {
    const validUntil = args.validUntil;
    if (validUntil === undefined) {
      throw new Error('buildSessionPermissions 沒收到 validUntil（應該來自 enrollment_intents）');
    }
    run.calls.permissions.push({
      sessionKeyAddress: args.sessionKeyAddress,
      executorAddress: args.executorAddress,
      validUntil,
    });
    const expiresAt = new Date(validUntil * 1000);
    const policySnapshot: SessionPolicySnapshot = {
      ...describePolicies({ executorAddress: args.executorAddress, validUntil }),
      permissionId: FAKE_PERMISSION_ID,
      sessionKeyAddress: args.sessionKeyAddress,
      expiresAt: expiresAt.toISOString(),
    };
    return {
      permissionValidator: PERMISSION_VALIDATOR,
      initConfig: initConfigFor(validUntil),
      permissionId: FAKE_PERMISSION_ID,
      policySnapshot,
      expiresAt,
    };
  };
  run.deps.deploySmartAccount = async (owner, strategyId, options) => {
    // 順序證明：部署那一刻，intent 已經寫進 DB 了。反過來（先部署、後寫 intent）就是孤兒帳戶：
    // 部署用的 validUntil 沒有落地，重試只能現算一個新的。
    assert.notEqual(
      run.intents.peek(owner.toLowerCase(), strategyId, 31337n),
      undefined,
      'the intent must already be stored when the account is deployed',
    );
    run.calls.deploy.push({ owner, strategyId, options });
    return { address: addressFromInitConfig(owner, strategyId, options?.initConfig), deployed: true };
  };
}

test('enrollPortfolio takes validUntil from enrollment_intents, not from the clock', async () => {
  // 一個「只可能來自 DB」的值：與 sessionValidUntil() 現算的差了一大截，所以下面的等值斷言
  // 不可能被「兩邊剛好都是現在時間」蒙混過關（下一條斷言就是那個鑑別力證明）。
  const PINNED = 1_600_000_001n;
  const intents = createIntentStore({ [intentKeyOf(OWNER, 3n, 31337n)]: PINNED });
  const { deps, calls } = fakeEnrollDeps([], '11', intents);

  await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.notEqual(Number(PINNED), sessionValidUntil(), 'the sealed value must be distinguishable from the default');
  assert.deepEqual(
    intents.calls,
    [{ userId: OWNER, strategyId: 3n, chainId: 31337n }],
    'enrollPortfolio must resolve the intent for exactly (owner, strategyId, chainId)',
  );
  assert.equal(calls.permissions.length, 1);
  assert.equal(calls.permissions[0]?.validUntil, Number(PINNED), 'the policy must be built with the sealed value');

  // 同一個值要落到 DB：session_keys.permissions.timestamp.validUntil（鏈上實際生效的那個數字）。
  const snapshot = JSON.parse(String(sessionKeyInsert(calls).params[2])) as SessionPolicySnapshot;
  assert.equal(snapshot.timestamp.validUntil, Number(PINNED));
  assert.equal((sessionKeyInsert(calls).params[3] as Date).getTime(), Number(PINNED) * 1000);
});

test('a retry after "chain succeeded, DB write died" lands on the SAME account address', async () => {
  // 這一條就是孤兒帳戶那個 bug 的重現：第一次部署+enroll 成功、DB 寫入被殺，之後重試。
  // intent store 是共用的（= 同一個 DB），而它的 mint 每次都會往前推一小時，所以只要實作自己現算
  // 時間，兩次就會得到不同的 validUntil、不同的 initConfig、不同的地址。
  const intents = createIntentStore();
  const first = fakeEnrollDeps([], '11', intents);
  const second = fakeEnrollDeps([], '99', intents);
  withValidUntilAddress(first);
  withValidUntilAddress(second);

  const firstPortfolio = await enrollPortfolio(3, ROUTE_WALLET.address, first.deps);
  const secondPortfolio = await enrollPortfolio(3, ROUTE_WALLET.address, second.deps);

  const firstAddress = firstPortfolio.smartAccounts[0]?.address;
  const secondAddress = secondPortfolio.smartAccounts[0]?.address;
  assert.equal(secondAddress, firstAddress, 'the retry must rebuild the address the first attempt deployed');
  assert.equal(second.calls.enroll[0]?.account, first.calls.enroll[0]?.account, 'and enroll that same account');

  // 兩次都用同一個 sealed 值，而且那個值就是 DB 裡那一列。
  const sealed = first.calls.permissions[0]?.validUntil;
  assert.equal(second.calls.permissions[0]?.validUntil, sealed);
  assert.equal(BigInt(sealed ?? -1), intents.peek(OWNER, 3n, 31337n) ?? -1n, 'the value used is the one stored');
  assert.equal(intents.calls.length, 2, 'both attempts read the intent; only the first could mint it');

  // 反向對照：validUntil 差一小時就必須是另一個地址 —— 否則上面那條等值斷言沒有鑑別力。
  const otherAddress = addressFromInitConfig(OWNER, 3n, initConfigFor(Number(sealed) + 3600));
  assert.notEqual(otherAddress, firstAddress, 'a different validUntil must yield a different account');
});

test('enrollPortfolio never mints its own validUntil (the clock is not an input)', async () => {
  // resolveValidUntil 回什麼，buildSessionPermissions 就必須收到什麼；一個「現算」的實作會兩邊不等。
  const intents = createIntentStore();
  const { deps, calls, intents: store } = fakeEnrollDeps([], '11', intents);

  await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  const handedToPolicy = calls.permissions[0]?.validUntil;
  assert.ok(handedToPolicy !== undefined, 'validUntil must be explicit: the default would mint now + 365d');
  assert.equal(BigInt(handedToPolicy), store.peek(OWNER, 3n, 31337n) ?? -1n, 'it comes from the intent row');
  assert.equal(store.calls.length, 1, 'exactly one intent resolution per enrollment');

  // 真正的防回歸：把「自己取現在時間」寫回去，上面兩條都會紅。這裡再把那個值算出來，證明它不同。
  assert.notEqual(handedToPolicy, sessionValidUntil(), 'a clock-derived value would break the account address');
});

test('enrollPortfolio fails with a diagnostic error before any chain call when the session key env is missing', async () => {
  const cases: Array<{ name: string; env: Record<string, string | undefined>; expected: RegExp }> = [
    { name: 'both missing', env: {}, expected: /EXECUTOR_ADDRESS[\s\S]*SESSION_KEY_MASTER_SEED/ },
    { name: 'seed missing', env: { EXECUTOR_ADDRESS: EXECUTOR }, expected: /SESSION_KEY_MASTER_SEED/ },
    { name: 'executor missing', env: { SESSION_KEY_MASTER_SEED: MASTER_SEED }, expected: /EXECUTOR_ADDRESS/ },
  ];
  const saved = { executor: process.env.EXECUTOR_ADDRESS, seed: process.env.SESSION_KEY_MASTER_SEED };

  try {
    for (const testCase of cases) {
      // 不注入 sessionKeyConfig：enrollPortfolio 必須走真的 requireSessionKeyConfig()，讀 process.env。
      const { deps, calls } = fakeEnrollDeps();
      delete deps.sessionKeyConfig;

      setEnv('EXECUTOR_ADDRESS', testCase.env.EXECUTOR_ADDRESS);
      setEnv('SESSION_KEY_MASTER_SEED', testCase.env.SESSION_KEY_MASTER_SEED);

      await assert.rejects(
        () => enrollPortfolio(3, ROUTE_WALLET.address, deps),
        testCase.expected,
        `missing config (${testCase.name}) must name the variable`,
      );
      assert.equal(calls.deploy.length, 0, `${testCase.name}: no account may be deployed without a session key`);
      assert.equal(calls.enroll.length, 0, `${testCase.name}: no enroll tx may be sent`);
      assert.equal(calls.writes.length, 0, `${testCase.name}: no row may be written`);
    }
  } finally {
    setEnv('EXECUTOR_ADDRESS', saved.executor);
    setEnv('SESSION_KEY_MASTER_SEED', saved.seed);
  }
});

test('enrollPortfolio re-enroll (idempotent path) needs no session key env at all', async () => {
  // 冪等 SELECT 必須跑在 requireSessionKeyConfig() 之前：已經 enroll 過的 portfolio 就算 env 被拿掉，
  // 重打一次 POST /portfolios 也只該回原本那一列，不該因為一個用不到的設定而失敗。
  const { deps, calls, intents } = fakeEnrollDeps([enrollmentRow('11', 'KERNEL')]);
  delete deps.sessionKeyConfig;
  const saved = { executor: process.env.EXECUTOR_ADDRESS, seed: process.env.SESSION_KEY_MASTER_SEED };

  setEnv('EXECUTOR_ADDRESS', undefined);
  setEnv('SESSION_KEY_MASTER_SEED', undefined);
  try {
    const portfolio = await enrollPortfolio(3, ROUTE_WALLET.address, deps);
    assert.equal(portfolio.id, 11);
    assert.equal(calls.deploy.length, 0, 'an existing enrollment must not deploy');
    assert.equal(calls.permissions.length, 0, 'an existing enrollment must not even derive a new key');
    assert.equal(calls.writes.length, 0, 'an existing enrollment must not write');
    // 已經 enroll 過就不該再釘一次 intent：那一列屬於「這次要算新地址」的情境，不是重複回傳。
    assert.equal(intents.calls.length, 0, 'the idempotent path must not touch enrollment_intents');
  } finally {
    setEnv('EXECUTOR_ADDRESS', saved.executor);
    setEnv('SESSION_KEY_MASTER_SEED', saved.seed);
  }
});

/** `process.env` 上的三態設定：有值就設、undefined 就刪。 */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ---------------------------------------------------------------------------
// enrollPortfolio: gas 狀態（使用者要打多少 BNB 到哪個地址、現在能不能動）
// ---------------------------------------------------------------------------

test('enrollPortfolio reports gas status for the deployed smart account after the DB write', async () => {
  const { deps, calls } = fakeEnrollDeps();

  const portfolio = await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.ok(portfolio.gas, 'a successful enrol must carry a gas status');
  // 要打錢的地址是 smart account，不是使用者的 EOA，也不是 session key；小寫與 smartAccounts 一致。
  assert.equal(portfolio.gas.address, KERNEL_LOWERCASE);
  assert.deepEqual(calls.gas, [{ address: KERNEL_LOWERCASE }]);
  assert.equal(portfolio.gas.balanceWei, FAKE_GAS_BALANCE_WEI.toString());
  assert.equal(portfolio.gas.minimumWei, DEFAULT_MIN_SESSION_GAS_WEI.toString());
  assert.equal(portfolio.gas.ready, true);
  assert.equal(portfolio.gas.shortfallWei, '0');
  // 0.05 BNB @ 1.22 gwei / (900k gas) = 45 次 op（向下取整）。
  // 900k 是實測：三次真實 rebalance 的 actualGasUsed 是 870,901 / 938,431 / 935k。
  assert.equal(portfolio.gas.estimatedOps, 45);
  assert.equal(portfolio.gas.gasPriceKnown, true);
  // DB 已經寫完才去查：三筆寫入都在，而且查餘額不改變任何寫入。
  assert.ok(calls.writes.some((w) => w.text.includes('insert into portfolios')));
  assert.ok(calls.writes.some((w) => w.text.includes('insert into smart_accounts')));
});

test('enrollPortfolio still succeeds when the gas query throws (gas: null, DB written)', async () => {
  const { deps, calls } = fakeEnrollDeps();
  deps.getAccountGasBalance = async () => {
    throw new Error('rpc is down');
  };

  // 關鍵：一個唯讀 RPC 呼叫失敗，不可以把一個已經完成（鏈上 enroll + DB 三筆寫入）的 enroll 變成錯誤。
  const portfolio = await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.equal(portfolio.id, 11);
  assert.equal(portfolio.gas, null);
  assert.equal(portfolio.smartAccounts.length, 1);
  assert.equal(portfolio.smartAccounts[0]?.address, KERNEL_LOWERCASE);
  assert.ok(calls.writes.some((w) => w.text.includes('insert into portfolios')));
  assert.ok(calls.writes.some((w) => w.text.includes('insert into smart_accounts')));
  assert.ok(calls.writes.some((w) => w.text.includes('insert into session_keys')));
});

test('enrollPortfolio still succeeds when only the gas price query throws', async () => {
  const { deps } = fakeEnrollDeps();
  deps.getGasPriceWei = async () => {
    throw new Error('eth_gasPrice timeout');
  };

  const portfolio = await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.equal(portfolio.id, 11);
  assert.equal(portfolio.gas, null);
});

test('enrollPortfolio reports gas on the idempotent path without writing or enrolling again', async () => {
  const { deps, calls } = fakeEnrollDeps([enrollmentRow('11', 'KERNEL')]);

  const portfolio = await enrollPortfolio(3, ROUTE_WALLET.address, deps);

  assert.ok(portfolio.gas, 'a re-enrol must still tell the caller where to send BNB');
  assert.equal(portfolio.gas.address.toLowerCase(), KERNEL_LOWERCASE);
  assert.equal(calls.gas.length, 1);
  assert.equal(calls.deploy.length, 0);
  assert.equal(calls.writes.length, 0);
});

// ---------------------------------------------------------------------------
// deploySmartAccount: counterfactual deploy guard (fake chain, no RPC)
// ---------------------------------------------------------------------------

const KERNEL_OWNER = privateKeyToAccount(generatePrivateKey()).address;

/** MetaFactory.deployWithFactory(address factory, bytes createData, bytes32 salt)：部署 tx 的外層 calldata。 */
const META_FACTORY_ABI = [
  {
    type: 'function',
    name: 'deployWithFactory',
    inputs: [
      { name: 'factory', type: 'address' },
      { name: 'createData', type: 'bytes' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'payable',
  },
] as const;
const META_FACTORY_DEPLOY_SELECTOR = toFunctionSelector('deployWithFactory(address,bytes,bytes32)');
const GET_SENDER_ADDRESS_SELECTOR = toFunctionSelector('getSenderAddress(bytes)');
/** getAddress: EntryPoint hands the sender back ABI-decoded, i.e. EIP-55 checksummed. */
const COUNTERFACTUAL: Address = getAddress('0x0000000000000000000000000000000000000bad');
const SENDER_ADDRESS_RESULT = concatHex([
  toFunctionSelector('SenderAddressResult(address)'),
  encodeAbiParameters([{ type: 'address' }], [COUNTERFACTUAL]),
]);

/** EntryPoint and MetaFactory answer with code; the counterfactual account answers `accountCode`. */
function fakeChain(
  accountCode: `0x${string}` | undefined,
  onCall?: (args: { to?: Address; data?: Hex }) => void,
) {
  const writeCalls: Array<Record<string, unknown>> = [];
  const publicClient = {
    chain: bsc,
    // EntryPoint 的地址查詢是 revert-based；viem 走 eth_call，所以 stub 在這一層回答。
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return toHex(31337);
      if (method === 'eth_call') {
        onCall?.((params as [{ to?: Address; data?: Hex }])[0]);
        throw new RpcRequestError({
          body: {},
          url: 'stub',
          error: { code: 3, message: 'execution reverted', data: SENDER_ADDRESS_RESULT },
        });
      }
      throw new Error(`fakeChain: 不支援的 RPC method ${method}`);
    },
    getBlockNumber: async () => 100n,
    getCode: async ({ address }: { address: Address }) =>
      address === COUNTERFACTUAL ? accountCode : '0x6080604052',
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: 'success', transactionHash: hash }),
  } as unknown as PublicClient;
  const wallet = {
    writeContract: async (args: Record<string, unknown>) => {
      writeCalls.push(args);
      return '0xfeedface';
    },
    sendTransaction: async (args: Record<string, unknown>) => {
      writeCalls.push(args);
      return '0xfeedface';
    },
  } as unknown as WalletClient;
  const chain = {
    chainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    registryAddress: KERNEL_V3_3_ADDRESSES.kernelMetaFactory,
    account: ROUTE_WALLET,
    wallet,
    publicClient,
    kernel: KERNEL_V3_3_ADDRESSES,
  } as unknown as ChainConfig;
  return { chain, writeCalls };
}

test('deploySmartAccount skips the deploy tx when the counterfactual address already has code', async () => {
  const { chain, writeCalls } = fakeChain('0x60806040');

  const result = await deploySmartAccount(KERNEL_OWNER, 5n, { chain });

  assert.deepEqual(result, { address: COUNTERFACTUAL, deployed: false });
  assert.equal(writeCalls.length, 0, 'an already-deployed account must not be deployed again');
});

test('deploySmartAccount deploys through the Kernel MetaFactory when the address is empty', async () => {
  const { chain, writeCalls } = fakeChain('0x');

  const result = await deploySmartAccount(KERNEL_OWNER, 5n, { chain });

  assert.deepEqual(result, { address: COUNTERFACTUAL, deployed: true });
  assert.equal(writeCalls.length, 1);
  const call = writeCalls[0];
  assert.equal(call?.to, KERNEL_V3_3_ADDRESSES.kernelMetaFactory);
  assert.equal(
    String(call?.data).slice(0, 10),
    String(META_FACTORY_DEPLOY_SELECTOR),
    'the deploy tx must call MetaFactory.deployWithFactory, not KernelFactory.createAccount',
  );
  const [kernelFactory, createData, salt] = decodeFunctionData({
    abi: META_FACTORY_ABI,
    data: String(call?.data) as Hex,
  }).args;
  assert.equal(kernelFactory.toLowerCase(), KERNEL_V3_3_ADDRESSES.kernelFactoryV33.toLowerCase());
  assert.equal(salt.toLowerCase(), computeSalt(KERNEL_OWNER, 5n).toLowerCase());
  assert.ok(
    createData.toLowerCase().includes(KERNEL_OWNER.slice(2).toLowerCase()),
    'the ECDSA validator data (the owner) must be inside the initialize calldata',
  );
});

test('deploySmartAccount asks EntryPoint for the address of the exact (owner, strategyId) init code', async () => {
  // The fake always answers the same address, so nothing above would notice a wrong init code: assert
  // the calldata itself, i.e. the owner, salt and factory the address was actually derived from.
  const seen: Array<{ to?: Address; data?: Hex }> = [];
  const { chain, writeCalls } = fakeChain('0x', (args) => seen.push(args));

  await deploySmartAccount(KERNEL_OWNER, 5n, { chain });

  assert.equal(seen.length, 1, 'the counterfactual address is derived from exactly one getSenderAddress call');
  const salt = computeSalt(KERNEL_OWNER, 5n);
  const query = seen[0];
  assert.equal(
    query?.to?.toLowerCase(),
    KERNEL_V3_3_ADDRESSES.entryPointV07.toLowerCase(),
    'getSenderAddress must be asked of the EntryPoint, not some other contract',
  );
  assert.equal(String(query?.data).slice(0, 10), String(GET_SENDER_ADDRESS_SELECTOR));
  const [initCode] = decodeFunctionData({ abi: entryPoint07Abi, data: String(query?.data) as Hex })
    .args as unknown as [Hex];
  // initCode = MetaFactory 地址(20 bytes) ++ deployWithFactory(address factory, bytes createData, bytes32 salt)
  const askedFactory = `0x${initCode.slice(2, 42)}` as Address;
  assert.equal(
    askedFactory.toLowerCase(),
    KERNEL_V3_3_ADDRESSES.kernelMetaFactory.toLowerCase(),
    'the address must be derived through the MetaFactory; the KernelFactory path yields a different account',
  );
  assert.notEqual(
    askedFactory.toLowerCase(),
    KERNEL_V3_3_ADDRESSES.kernelFactoryV33.toLowerCase(),
    'a KernelFactory-derived address would be a different account',
  );
  assert.ok(
    initCode.toLowerCase().includes(salt.slice(2).toLowerCase()),
    'a wrong salt here means the counterfactual address is computed for the wrong account',
  );
  assert.ok(
    initCode.toLowerCase().includes(KERNEL_OWNER.slice(2).toLowerCase()),
    'a wrong owner here means the counterfactual address is computed for the wrong account',
  );
  assert.equal(writeCalls.length, 1, 'the fresh account is then deployed with that same salt');

  // 部署用的 initialize calldata 必須就是推導地址時問 EntryPoint 的那一段。
  const [, derivedCreateData] = decodeFunctionData({
    abi: META_FACTORY_ABI,
    data: `0x${initCode.slice(42)}` as Hex,
  }).args;
  const [, deployedCreateData] = decodeFunctionData({
    abi: META_FACTORY_ABI,
    data: String(writeCalls[0]?.data) as Hex,
  }).args;
  assert.equal(
    deployedCreateData.toLowerCase(),
    derivedCreateData.toLowerCase(),
    'the account must be deployed with the exact calldata its address was derived from',
  );
});


test('deploySmartAccount bakes initConfig into the init code (that is what installs the permissions)', async () => {
  // 這條不驗地址（假的 EntryPoint 固定回同一個地址；「initConfig 改變地址」由 permissions.test.ts
  // 的 keccak(initCode) stub 釘住），驗的是 initConfig 真的進到 initialize(...) 裡 —— 少了這段，
  // 帳戶上就沒有安裝權限，而且地址不變、不會有任何錯誤提示。
  const INIT_CONFIG: Hex[] = ['0x9198bdf5deadbeefdeadbeef', '0xe9ae5c53cafebabecafebabe'];

  const plain = fakeChain('0x');
  await deploySmartAccount(KERNEL_OWNER, 5n, { chain: plain.chain });
  const plainData = String(plain.writeCalls[0]?.data).toLowerCase();
  for (const entry of INIT_CONFIG) {
    assert.equal(plainData.includes(entry.slice(2).toLowerCase()), false, 'an account without initConfig must not carry it');
  }

  const withConfig = fakeChain('0x');
  await deploySmartAccount(KERNEL_OWNER, 5n, { chain: withConfig.chain, initConfig: INIT_CONFIG });
  const configData = String(withConfig.writeCalls[0]?.data).toLowerCase();
  const [, createData] = decodeFunctionData({
    abi: META_FACTORY_ABI,
    data: configData as Hex,
  }).args;
  for (const entry of INIT_CONFIG) {
    assert.ok(
      String(createData).toLowerCase().includes(entry.slice(2).toLowerCase()),
      `initConfig 的 ${entry} 必須逐 byte 出現在 initialize(...) 的 initConfig 參數裡`,
    );
  }
  assert.notEqual(configData, plainData, 'the deploy calldata must differ once the permissions are installed');
  assert.equal(String(plainData.slice(0, 8)), String(configData.slice(0, 8)), 'both still go through MetaFactory');
});

// ---------------------------------------------------------------------------
// integration: full enroll against the configured chain + DB (gated)
// ---------------------------------------------------------------------------

test('enrollPortfolio mirrors to chain and writes portfolio + smart account', { skip: skipIntegration }, async () => {
  await migrate();

  // Requires a running chain with a deployed AtpRegistry and a strategy already registered +
  // published on-chain (its DB row has onchain_id set). Create the DB strategy + mirror first via
  // the real domain path, then enroll a fresh wallet.
  const { createStrategy, publishVersion } = await import('../src/strategies.js');
  const provider = ROUTE_WALLET.address.toLowerCase();

  const strategy = await createStrategy(
    { provider, name: 'Integration Index', description: 'integration', isPublic: true, swapFeeBps: 0 },
    provider,
  );
  assert.ok(strategy.onchainId !== null, 'expected createStrategy to mirror to chain (RPC_URL set)');

  await publishVersion(
    strategy.id,
    {
      allocation: {
        assets: [
          { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', weightBps: 5000 },
          { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', weightBps: 5000 },
        ],
      },
      schedule: { kind: 'interval', intervalSeconds: 86_400 },
      changeLog: 'integration',
    },
    provider,
  );

  const wallet = privateKeyToAccount(generatePrivateKey());
  const portfolio = await enrollPortfolio(strategy.id, wallet.address);
  assert.equal(portfolio.strategyId, strategy.id);
  assert.equal(portfolio.userId, wallet.address.toLowerCase());
  assert.equal(portfolio.smartAccounts.length, 1);
  assert.equal(portfolio.smartAccounts[0]?.accountType, 'KERNEL');
});

after(async () => {
  await closePool();
});
