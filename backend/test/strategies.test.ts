import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { SiweChallenge } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { closePool, migrate, query } from '../src/db.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';
import {
  createStrategy,
  getStrategy,
  listStrategies,
  publishVersion,
  validateAllocation,
  validateCreateStrategyInput,
  validateSchedule,
} from '../src/strategies.js';
import type { PublishVersionInput, StrategyVersion } from '../src/strategies.js';

const ASSET_A = '0x00000000000000000000000000000000000000a1';
const ASSET_B = '0x00000000000000000000000000000000000000b2';

/** DB-backed tests only run when DATABASE_URL is present; otherwise node:test reports them as skipped. */
const skipDb: boolean | string = process.env.DATABASE_URL
  ? false
  : 'DATABASE_URL is not set';

/**
 * 會送鏈上交易的測試要另外 opt-in：createStrategy 會 mirror 到 AtpRegistry、publishVersion 會上鏈，
 * 只要 RPC_URL / OPERATOR_PRIVATE_KEY / REGISTRY_ADDRESS 都設好（＝後端設定齊全）就會真的送出去。
 * 「後端有設定」不該等於「測試可以送交易」，所以這裡再要一個明確的 RUN_CHAIN_TESTS=1。
 */
const skipChainWrites: boolean | string =
  skipDb !== false
    ? skipDb
    : process.env.RUN_CHAIN_TESTS === '1'
      ? false
      : 'RUN_CHAIN_TESTS=1 才會執行（這個測試會真的送鏈上交易、共用 operator 帳號的 nonce，所以預設關閉；要跑請用 RUN_CHAIN_TESTS=1 bun test --timeout=120000，不要加 --concurrent（預設 5 秒逾時太短，逾時的測試還在背景送交易，會和下一個測試撞 nonce））';

/**
 * bun 只印 `(skip) <測試名>`，不印 `skip` 的字串理由 —— 看到 `(skip)` 的人不知道為什麼、也不知道怎麼開。
 * 所以在模組載入時自己印一次（gate 關閉才印）。
 */
if (skipChainWrites !== false) {
  console.log(`[skip] 鏈上寫入測試未執行（${String(skipChainWrites)}）`);
  console.log(
    '[skip] 要跑請用：RUN_CHAIN_TESTS=1 bun test --timeout=120000（不要加 --concurrent：會真的送交易、共用 operator nonce）',
  );
}

function expectValidationError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Allocation weights
// ---------------------------------------------------------------------------

test('validateAllocation accepts weights that sum to 10000 and normalises addresses', () => {
  const allocation = validateAllocation({
    assets: [
      { address: `0x${'0'.repeat(36)}ABCD`, symbol: ' AAPLB ', weightBps: 6000 },
      { address: ASSET_B, weightBps: 4000 },
    ],
  });

  assert.equal(allocation.assets.length, 2);
  assert.deepEqual(allocation.assets[0], {
    address: `0x${'0'.repeat(36)}abcd`,
    symbol: 'AAPLB',
    weightBps: 6000,
  });
  assert.equal(allocation.assets[1]?.symbol, undefined);
});

test('validateAllocation rejects weights that do not sum to 10000', () => {
  expectValidationError(
    () =>
      validateAllocation({
        assets: [
          { address: ASSET_A, weightBps: 9999 },
        ],
      }),
    'WEIGHT_SUM',
  );
});

test('validateAllocation rejects an empty asset list', () => {
  expectValidationError(() => validateAllocation({ assets: [] }), 'ALLOCATION_EMPTY');
});

test('validateAllocation rejects weights outside 1..10000 (including zero and fractions)', () => {
  for (const weightBps of [0, 12.5, 10_001, -100]) {
    expectValidationError(
      () => validateAllocation({ assets: [{ address: ASSET_A, weightBps }] }),
      'WEIGHT_OUT_OF_RANGE',
    );
  }
});

test('validateAllocation rejects a duplicate asset regardless of address casing', () => {
  expectValidationError(
    () =>
      validateAllocation({
        assets: [
          { address: `0x${'0'.repeat(36)}ABCD`, weightBps: 5000 },
          { address: `0x${'0'.repeat(36)}abcd`, weightBps: 5000 },
        ],
      }),
    'DUPLICATE_ASSET',
  );
});

test('validateAllocation enforces the 16-asset ceiling', () => {
  const assets = Array.from({ length: 17 }, (_, index) => ({
    address: `0x${index.toString(16).padStart(40, '0')}`,
    weightBps: 1,
  }));
  expectValidationError(() => validateAllocation({ assets }), 'TOO_MANY_ASSETS');
});

test('validateAllocation rejects malformed addresses and non-object payloads', () => {
  expectValidationError(
    () => validateAllocation({ assets: [{ address: '0x123', weightBps: 10_000 }] }),
    'INVALID_ASSET',
  );
  for (const bad of [null, 'allocation', [], { assets: 'nope' }]) {
    expectValidationError(() => validateAllocation(bad), 'INVALID_ALLOCATION');
  }
});

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

test('validateSchedule accepts interval and cron schedules', () => {
  assert.deepEqual(validateSchedule({ kind: 'interval', intervalSeconds: 86_400 }), {
    kind: 'interval',
    intervalSeconds: 86_400,
  });
  assert.deepEqual(validateSchedule({ kind: 'cron', cron: ' 0 0 * * * ' }), {
    kind: 'cron',
    cron: '0 0 * * *',
  });
});

test('validateSchedule rejects unknown kinds, sub-minute intervals and empty cron', () => {
  for (const bad of [
    { kind: 'daily' },
    { kind: 'interval', intervalSeconds: 30 },
    { kind: 'interval', intervalSeconds: 1.5 },
    { kind: 'cron', cron: '   ' },
    null,
  ]) {
    expectValidationError(() => validateSchedule(bad), 'INVALID_SCHEDULE');
  }
});

// ---------------------------------------------------------------------------
// Strategy metadata
// ---------------------------------------------------------------------------

test('validateCreateStrategyInput applies defaults and trims strings', () => {
  const input = validateCreateStrategyInput({ name: ' Index 500 ' }, ' 0xprovider ');
  assert.deepEqual(input, {
    provider: '0xprovider',
    name: 'Index 500',
    description: '',
    isPublic: true,
    swapFeeBps: 0,
  });
});

test('validateCreateStrategyInput lowercases the provider, matching the 0002 check constraint', () => {
  // EIP-55 casing is cosmetic: one wallet must not become two provider rows.
  assert.equal(validateCreateStrategyInput({ name: 'Index 500' }, '0xAbCdEf0123').provider, '0xabcdef0123');
  assert.equal(validateCreateStrategyInput({ name: 'Index 500' }, ' Mixed-Case ').provider, 'mixed-case');
});

test('validateCreateStrategyInput takes the provider from the session and ignores the body', () => {
  const input = validateCreateStrategyInput(
    { provider: '0xattacker', name: 'Index 500' },
    '0xsession',
  );
  assert.equal(input.provider, '0xsession');
});

test('validateCreateStrategyInput rejects bad fees, names and booleans', () => {
  const base = { name: 'Index 500' };
  for (const swapFeeBps of [-1, 301, 1.5]) {
    expectValidationError(
      () => validateCreateStrategyInput({ ...base, swapFeeBps }, '0xprovider'),
      'INVALID_SWAP_FEE',
    );
  }
  expectValidationError(
    () => validateCreateStrategyInput({ ...base, name: '   ' }, '0xprovider'),
    'INVALID_STRATEGY',
  );
  expectValidationError(
    () => validateCreateStrategyInput({ ...base, isPublic: 'yes' }, '0xprovider'),
    'INVALID_STRATEGY',
  );
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('loadConfig requires DATABASE_URL and defaults to chain 56 / port 8080', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);

  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/cre8' });
  assert.equal(config.chainId, 56);
  assert.equal(config.port, 8080);
  assert.equal(config.authDomain, 'localhost');
  assert.equal(config.authUri, 'http://localhost');
  assert.equal(config.rpcUrl, null);

  // AUTH_DOMAIN/AUTH_URI only affect the SIWE challenge, never the DATABASE_URL requirement.
  const siwe = loadConfig({
    DATABASE_URL: 'postgres://localhost/cre8',
    AUTH_DOMAIN: 'app.cre8.xyz',
    AUTH_URI: ' https://app.cre8.xyz/sign-in ',
  });
  assert.equal(siwe.authDomain, 'app.cre8.xyz');
  assert.equal(siwe.authUri, 'https://app.cre8.xyz/sign-in');
  // AUTH_URI is optional: without it the uri is the domain over http.
  assert.equal(
    loadConfig({ DATABASE_URL: 'postgres://localhost/cre8', AUTH_DOMAIN: 'app.cre8.xyz' }).authUri,
    'http://app.cre8.xyz',
  );

  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://localhost/cre8', AUTH_DOMAIN: 'https://app.cre8.xyz' }),
    /AUTH_DOMAIN/,
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://localhost/cre8', AUTH_URI: 'not a uri' }),
    /AUTH_URI/,
  );

  const custom = loadConfig({
    DATABASE_URL: 'postgres://localhost/cre8',
    PORT: '9090',
    CHAIN_ID: '97',
    RPC_URL: ' https://rpc.example ',
  });
  assert.deepEqual(custom, {
    databaseUrl: 'postgres://localhost/cre8',
    port: 9090,
    authDomain: 'localhost',
    authUri: 'http://localhost',
    chainId: 97,
    rpcUrl: 'https://rpc.example',
    operatorPrivateKey: null,
    registryAddress: null,
  });

  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://localhost/cre8', PORT: 'abc' }), /PORT/);
});

// ---------------------------------------------------------------------------
// HTTP routes (no DB: DB-backed paths inject publishVersion; validation runs first)
// ---------------------------------------------------------------------------

const PUBLISH_BODY = {
  allocation: {
    assets: [
      { address: ASSET_A, symbol: 'AAPLB', weightBps: 6000 },
      { address: ASSET_B, weightBps: 4000 },
    ],
  },
  schedule: { kind: 'interval', intervalSeconds: 86_400 },
  changeLog: 'rebalance',
};

/** Bind a throwaway server on port 0, hand its base URL to `run`, then close it. */
async function withServer<T>(
  run: (baseUrl: string) => Promise<T>,
  deps?: Partial<ServerDeps>,
): Promise<T> {
  const server = createServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port');
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** Route tests are authenticated now: sign a nonce with a throwaway wallet and mint a session. */
const ROUTE_WALLET = privateKeyToAccount(generatePrivateKey());

async function loginToken(baseUrl: string): Promise<string> {
  const nonceResponse = await fetch(`${baseUrl}/auth/nonce`, { method: 'POST' });
  assert.equal(nonceResponse.status, 200);
  const challenge = (await nonceResponse.json()) as SiweChallenge;

  // The client composes the EIP-4361 message from the challenge fields and signs that exact text.
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

test('POST /strategies/:id/versions returns 201 with the created version record', async () => {
  const published: StrategyVersion = {
    strategyId: 1,
    version: 7,
    allocation: { assets: [{ address: ASSET_A, weightBps: 10_000 }] },
    schedule: { kind: 'cron', cron: '0 0 * * *' },
    changeLog: 'rebalance',
    activeAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const calls: Array<{ id: number; input: PublishVersionInput; provider: string }> = [];

  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const response = await postJson(baseUrl, '/strategies/1/versions', PUBLISH_BODY, token);

      assert.equal(response.status, 201);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      assert.deepEqual(await response.json(), published);
      // The route hands the parsed body to publishVersion untouched (id from the path), and the
      // provider is the session wallet, never a body field.
      assert.deepEqual(calls, [
        { id: 1, input: PUBLISH_BODY, provider: ROUTE_WALLET.address.toLowerCase() },
      ]);
    },
    {
      publishVersion: async (strategyId, input, provider) => {
        calls.push({ id: strategyId, input, provider });
        return published;
      },
    },
  );
});

test('POST /strategies/:id/versions returns 404 when publishVersion reports the strategy missing', async () => {
  await withServer(
    async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const response = await postJson(baseUrl, '/strategies/999/versions', PUBLISH_BODY, token);

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        error: { code: 'NOT_FOUND', message: 'strategy 999 not found' },
      });
    },
    {
      publishVersion: async () => {
        throw new NotFoundError('strategy 999 not found');
      },
    },
  );
});

test('POST /strategies/:id/versions is 400 for bad allocations without touching the DB', async () => {
  // Default deps: the real publishVersion validates before it queries, so no DATABASE_URL is needed.
  await withServer(async (baseUrl) => {
    const token = await loginToken(baseUrl);
    const cases: Array<{ body: unknown; code: string }> = [
      {
        body: { ...PUBLISH_BODY, allocation: { assets: [{ address: ASSET_A, weightBps: 9999 }] } },
        code: 'WEIGHT_SUM',
      },
      {
        body: {
          ...PUBLISH_BODY,
          allocation: {
            assets: [
              { address: ASSET_A, weightBps: 5000 },
              { address: ASSET_A, weightBps: 5000 },
            ],
          },
        },
        code: 'DUPLICATE_ASSET',
      },
      {
        body: { ...PUBLISH_BODY, allocation: 'not-an-object' },
        code: 'INVALID_ALLOCATION',
      },
    ];

    for (const testCase of cases) {
      const response = await postJson(baseUrl, '/strategies/1/versions', testCase.body, token);
      assert.equal(response.status, 400);
      const payload = (await response.json()) as { error: { code: string } };
      assert.equal(payload.error.code, testCase.code);
    }
  });
});

test('POST /strategies/:id/versions is 400 for a non-object JSON body', async () => {
  await withServer(async (baseUrl) => {
    const token = await loginToken(baseUrl);
    const response = await postJson(baseUrl, '/strategies/1/versions', null, token);

    assert.equal(response.status, 400);
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, 'INVALID_VERSION');
  });
});

test('GET /strategies/:id/versions is 405 with Allow: POST', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/strategies/1/versions`);

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, 'METHOD_NOT_ALLOWED');
  });
});

// ---------------------------------------------------------------------------
// DB integration (gated on DATABASE_URL)
// ---------------------------------------------------------------------------

after(async () => {
  await closePool();
});

test('DB: migrate records 0001_init.sql', { skip: skipDb }, async () => {
  await migrate();
  const { rows } = await query<{ filename: string }>(
    "select filename from schema_migrations where filename = '0001_init.sql'",
  );
  assert.equal(rows.length, 1);
});

test('DB: strategy and version round trip', { skip: skipChainWrites }, async () => {
  const name = `it-strategy-${randomUUID()}`;
  const strategy = await createStrategy(
    {
      name,
      description: 'integration test',
      isPublic: false,
      swapFeeBps: 25,
    },
    'it-provider',
  );

  try {
    assert.equal(strategy.name, name);
    assert.equal(strategy.swapFeeBps, 25);

    const empty = await getStrategy(strategy.id);
    assert.deepEqual(empty.versions, []);

    const first = await publishVersion(
      strategy.id,
      {
        allocation: {
          assets: [
            { address: ASSET_A, symbol: 'AAPLB', weightBps: 7000 },
            { address: ASSET_B, weightBps: 3000 },
          ],
        },
        schedule: { kind: 'interval', intervalSeconds: 86_400 },
        changeLog: 'initial weights',
      },
      'it-provider',
    );
    assert.equal(first.version, 1);
    assert.equal(first.activeAt !== null, true);

    const second = await publishVersion(
      strategy.id,
      {
        allocation: { assets: [{ address: ASSET_A, weightBps: 10_000 }] },
        schedule: { kind: 'cron', cron: '0 0 * * *' },
      },
      'it-provider',
    );
    assert.equal(second.version, 2);

    const detail = await getStrategy(strategy.id);
    assert.equal(detail.versions.length, 2);
    assert.equal(detail.versions[0]?.version, 2);

    const page = await listStrategies({ provider: 'it-provider', isPublic: false, limit: 100 });
    assert.ok(page.items.some((item) => item.id === strategy.id));

    // The provider filter is case-insensitive: the API lowercases it and matches exactly.
    const upperCase = await listStrategies({ provider: 'IT-Provider', isPublic: false, limit: 100 });
    assert.ok(upperCase.items.some((item) => item.id === strategy.id));
    assert.equal(upperCase.total, page.total);

    // Another wallet cannot publish, even with a perfectly valid payload.
    await assert.rejects(
      publishVersion(
        strategy.id,
        {
          allocation: { assets: [{ address: ASSET_A, weightBps: 10_000 }] },
          schedule: { kind: 'interval', intervalSeconds: 3_600 },
        },
        '0xsomeone-else',
      ),
      (err: unknown) => err instanceof ForbiddenError && err.code === 'FORBIDDEN',
    );

    await assert.rejects(
      publishVersion(
        strategy.id,
        {
          allocation: { assets: [{ address: ASSET_A, weightBps: 9_999 }] },
          schedule: { kind: 'interval', intervalSeconds: 3_600 },
        },
        'it-provider',
      ),
      (err: unknown) => err instanceof ValidationError && err.code === 'WEIGHT_SUM',
    );

    await assert.rejects(
      publishVersion(
        strategy.id + 1_000_000,
        {
          allocation: { assets: [{ address: ASSET_A, weightBps: 10_000 }] },
          schedule: { kind: 'interval', intervalSeconds: 3_600 },
        },
        'it-provider',
      ),
      (err: unknown) => err instanceof NotFoundError,
    );
  } finally {
    await query('delete from strategies where id = $1', [strategy.id]);
  }
});

test('DB: POST /strategies/:id/versions publishes a version over HTTP', { skip: skipChainWrites }, async () => {
  await migrate();
  const strategy = await createStrategy(
    { name: `it-http-${randomUUID()}`, isPublic: false },
    ROUTE_WALLET.address.toLowerCase(),
  );

  try {
    await withServer(async (baseUrl) => {
      const token = await loginToken(baseUrl);
      const created = await postJson(
        baseUrl,
        `/strategies/${strategy.id}/versions`,
        PUBLISH_BODY,
        token,
      );
      assert.equal(created.status, 201);

      const version = (await created.json()) as StrategyVersion;
      assert.equal(version.strategyId, strategy.id);
      assert.equal(version.version, 1);
      assert.equal(version.changeLog, 'rebalance');
      assert.deepEqual(
        version.allocation.assets.map((asset) => [asset.address, asset.weightBps]),
        [
          [ASSET_A, 6000],
          [ASSET_B, 4000],
        ],
      );

      // The version is visible through the strategy detail route as well.
      const detail = await fetch(`${baseUrl}/strategies/${strategy.id}`);
      assert.equal(detail.status, 200);
      const payload = (await detail.json()) as { versions: Array<{ version: number }> };
      assert.deepEqual(payload.versions.map((entry) => entry.version), [1]);

      // A missing strategy surfaces as 404 through the domain error, not a 500.
      const missing = await postJson(
        baseUrl,
        `/strategies/${strategy.id + 1_000_000}/versions`,
        PUBLISH_BODY,
        token,
      );
      assert.equal(missing.status, 404);
      const missingPayload = (await missing.json()) as { error: { code: string } };
      assert.equal(missingPayload.error.code, 'NOT_FOUND');
    });
  } finally {
    await query('delete from strategies where id = $1', [strategy.id]);
  }
});
