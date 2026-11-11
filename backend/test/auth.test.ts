import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { SiweMessage } from 'viem/siwe';
import {
  AuthStore,
  NONCE_TTL_MS,
  SESSION_TTL_MS,
  SIWE_CLOCK_SKEW_MS,
  SIWE_STATEMENT,
  authenticate,
  issueNonce,
  login,
  parseLoginBody,
  type SessionRepository,
} from '../src/auth.js';
import type { SiweChallenge, SessionCredentials } from '../src/auth.js';
import type { AuthConfig } from '../src/config.js';
import { closePool, migrate, query } from '../src/db.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';
import { assertProviderOwns, createStrategy } from '../src/strategies.js';
import type { PublishVersionInput, Strategy, StrategyVersion } from '../src/strategies.js';

const ASSET_A = '0x00000000000000000000000000000000000000a1';
const ASSET_B = '0x00000000000000000000000000000000000000b2';

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

/** DB-backed tests only run when DATABASE_URL is present; otherwise they are reported as skipped. */
const skipDb: boolean | string = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

/**
 * 這個 DB 測試走真的 createStrategy / publishVersion：只要 RPC_URL / OPERATOR_PRIVATE_KEY /
 * REGISTRY_ADDRESS 都設好，它就會真的送鏈上交易。所以除了 DATABASE_URL 之外再要 RUN_CHAIN_TESTS=1。
 */
const skipDbChainWrites: boolean | string =
  skipDb !== false
    ? skipDb
    : process.env.RUN_CHAIN_TESTS === '1'
      ? false
      : 'RUN_CHAIN_TESTS=1 才會執行（這個測試會真的送鏈上交易、共用 operator 帳號的 nonce，所以預設關閉；要跑請用 RUN_CHAIN_TESTS=1 bun test --timeout=120000，不要加 --concurrent（預設 5 秒逾時太短，逾時的測試還在背景送交易，會和下一個測試撞 nonce））';

/**
 * bun 只印 `(skip) <測試名>`，不印 `skip` 的字串理由 —— 看到 `(skip)` 的人不知道為什麼、也不知道怎麼開。
 * 所以在模組載入時自己印一次（gate 關閉才印）。
 */
if (skipDbChainWrites !== false) {
  console.log(`[skip] 鏈上寫入測試未執行（${String(skipDbChainWrites)}）`);
  console.log(
    '[skip] 要跑請用：RUN_CHAIN_TESTS=1 bun test --timeout=120000（不要加 --concurrent：會真的送交易、共用 operator nonce）',
  );
}

/**
 * Fixed SIWE bindings for store-level tests, so the assertions do not depend on the shell env
 * (an AUTH_DOMAIN in .env must not change the expected challenge).
 */
const TEST_AUTH: AuthConfig = {
  authDomain: 'atp.test',
  authUri: 'https://atp.test/sign-in',
  chainId: 97,
};

/** Fresh random wallet per test: no key material is ever written to the repository. */
function newAccount(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

/**
 * 記憶體版本的 session repository。
 *
 * 單元測試不該為了「登入」而需要 Postgres：`AuthStore` 吃的是一個 `SessionRepository` 介面，
 * 這裡給它一個 Map 就夠了。真正打 DB 的那一份由 `auth_sessions` 的整合測試與 HTTP 測試覆蓋。
 */
function memorySessions(): SessionRepository & { readonly rows: Map<string, { wallet: string; expiresAt: Date }> } {
  const rows = new Map<string, { wallet: string; expiresAt: Date }>();
  return {
    rows,
    save: async (tokenHash, wallet, expiresAt) => {
      rows.set(tokenHash, { wallet, expiresAt });
    },
    find: async (tokenHash) => rows.get(tokenHash) ?? null,
    remove: async (tokenHash) => {
      rows.delete(tokenHash);
    },
    prune: async (now) => {
      for (const [hash, row] of rows) if (row.expiresAt <= now) rows.delete(hash);
    },
  };
}

function newStore(options: { now?: () => number } = {}): AuthStore {
  return new AuthStore({ ...options, auth: { ...TEST_AUTH }, sessions: memorySessions() });
}

type SiweOverrides = Partial<Omit<SiweMessage, 'address'>>;

/**
 * Build the exact EIP-4361 message a client would sign: every field from the challenge, the
 * client's own address, and `issuedAt` taken from the server so a skewed local clock is moot.
 */
function buildMessage(
  challenge: SiweChallenge,
  address: `0x${string}`,
  overrides: SiweOverrides = {},
): string {
  return createSiweMessage({
    address,
    chainId: challenge.chainId,
    domain: challenge.domain,
    uri: challenge.uri,
    statement: challenge.statement,
    version: '1',
    nonce: challenge.nonce,
    issuedAt: new Date(challenge.issuedAt),
    ...overrides,
  });
}

async function signChallenge(
  account: PrivateKeyAccount,
  challenge: SiweChallenge,
  overrides: SiweOverrides = {},
): Promise<{ message: string; signature: string }> {
  const message = buildMessage(challenge, account.address, overrides);
  return { message, signature: await account.signMessage({ message }) };
}

/**
 * Sign the challenge for `account` and try to redeem it: resolves with the session, or rejects
 * with the store's AppError. Keeps the negative tests to one line each.
 */
function attemptLogin(
  store: AuthStore,
  account: PrivateKeyAccount,
  challenge: SiweChallenge,
  overrides: SiweOverrides = {},
): Promise<SessionCredentials> {
  return (async () => {
    const { message, signature } = await signChallenge(account, challenge, overrides);
    return store.login(message, signature);
  })();
}

function isAppError(err: unknown, status: number, code: string): boolean {
  assert.ok(err instanceof Error, `expected an AppError, got ${String(err)}`);
  const { status: actualStatus, code: actualCode } = err as { status?: unknown; code?: unknown };
  assert.equal(actualStatus, status);
  assert.equal(actualCode, code);
  return true;
}

// ---------------------------------------------------------------------------
// Nonce challenge
// ---------------------------------------------------------------------------

test('issueNonce returns 64 hex chars with a 5 minute TTL, unique per call, plus the SIWE fields', () => {
  const store = newStore();
  const before = Date.now();
  const challenge = store.issueNonce();

  assert.match(challenge.nonce, /^[0-9a-f]{64}$/);
  const ttl = Date.parse(challenge.expiresAt) - before;
  assert.ok(ttl > NONCE_TTL_MS - 2_000, `TTL too short: ${ttl}`);
  assert.ok(ttl <= NONCE_TTL_MS + 2_000, `TTL too long: ${ttl}`);

  // The client rebuilds the message from these fields; they must describe this deployment.
  assert.equal(challenge.domain, TEST_AUTH.authDomain);
  assert.equal(challenge.uri, TEST_AUTH.authUri);
  assert.equal(challenge.chainId, TEST_AUTH.chainId);
  assert.equal(challenge.statement, SIWE_STATEMENT);
  assert.equal(challenge.version, '1');
  assert.ok(!Number.isNaN(Date.parse(challenge.issuedAt)), 'issuedAt must be an ISO-8601 instant');

  assert.notEqual(store.issueNonce().nonce, challenge.nonce);
});

test('the challenge composes into an EIP-4361 message that a wallet can display', () => {
  const store = newStore();
  const account = newAccount();
  const message = buildMessage(store.issueNonce(), account.address);

  assert.equal(
    message.startsWith(`${TEST_AUTH.authDomain} wants you to sign in with your Ethereum account:\n`),
    true,
    `unexpected SIWE prefix: ${message.split('\n')[0]}`,
  );
  assert.ok(message.includes(`\n\n${SIWE_STATEMENT}\n\nURI: `), message);
  assert.ok(message.includes(`\nVersion: 1\nChain ID: ${TEST_AUTH.chainId}\n`), message);
  assert.ok(message.includes('\nIssued At: '), message);
});

// ---------------------------------------------------------------------------
// login / authenticate (store level)
// ---------------------------------------------------------------------------

test('login recovers the wallet from a SIWE signature and mints a 24h session', async () => {
  const store = newStore();
  const account = newAccount();
  const challenge = store.issueNonce();

  const session = await attemptLogin(store, account, challenge);

  assert.match(session.token, /^[0-9a-f]{64}$/);
  const ttl = Date.parse(session.expiresAt) - Date.now();
  assert.ok(ttl > SESSION_TTL_MS - 2_000, `TTL too short: ${ttl}`);
  assert.ok(ttl <= SESSION_TTL_MS + 2_000, `TTL too long: ${ttl}`);

  // The trusted identity is the lowercased address from the message.
  assert.equal(await store.authenticate(`Bearer ${session.token}`), account.address.toLowerCase());
  assert.equal(await store.authenticate(`Bearer   ${session.token}`), account.address.toLowerCase());
});

test('the session wallet is the address from the message, lowercased', async () => {
  const store = newStore();
  const account = newAccount();
  const challenge = store.issueNonce();

  // The message carries the wallet; there is no separate `wallet` field to disagree with it.
  const session = await store.login(
    buildMessage(challenge, account.address),
    await account.signMessage({ message: buildMessage(challenge, account.address) }),
  );

  assert.equal(await store.authenticate(`Bearer ${session.token}`), account.address.toLowerCase());
});

test('login rejects a signature from another wallet with 401 INVALID_SIGNATURE', async () => {
  const store = newStore();
  const alice = newAccount();
  const mallory = newAccount();
  const challenge = store.issueNonce();
  const message = buildMessage(challenge, alice.address);

  await assert.rejects(
    store.login(message, await mallory.signMessage({ message })),
    (err: unknown) => isAppError(err, 401, 'INVALID_SIGNATURE'),
  );
});

test('login rejects a malformed signature with 401 INVALID_SIGNATURE', async () => {
  const store = newStore();
  const account = newAccount();
  const challenge = store.issueNonce();

  await assert.rejects(
    store.login(buildMessage(challenge, account.address), '0xdeadbeef'),
    (err: unknown) => isAppError(err, 401, 'INVALID_SIGNATURE'),
  );
});

test('login rejects an unparseable message with 400 INVALID_SIWE_MESSAGE', async () => {
  const store = newStore();

  for (const message of ['', '   ', 'hello', `${TEST_AUTH.authDomain} wants you to sign in`]) {
    await assert.rejects(
      store.login(message, '0xdeadbeef'),
      (err: unknown) => isAppError(err, 400, 'INVALID_SIWE_MESSAGE'),
      `expected INVALID_SIWE_MESSAGE for ${JSON.stringify(message)}`,
    );
  }
});

test('login rejects a message bound to another domain with 400 INVALID_SIWE_MESSAGE', async () => {
  const store = newStore();
  const account = newAccount();
  const challenge = store.issueNonce();

  await assert.rejects(
    attemptLogin(store, account, challenge, { domain: 'evil.example' }),
    (err: unknown) => isAppError(err, 400, 'INVALID_SIWE_MESSAGE'),
  );
});

test('login rejects a message bound to another uri with 400 INVALID_SIWE_MESSAGE', async () => {
  const store = newStore();
  const account = newAccount();
  const challenge = store.issueNonce();

  await assert.rejects(
    attemptLogin(store, account, challenge, { uri: 'https://evil.example/sign-in' }),
    (err: unknown) => isAppError(err, 400, 'INVALID_SIWE_MESSAGE'),
  );
});

test('login rejects a message bound to another chainId with 400 INVALID_SIWE_MESSAGE', async () => {
  const store = newStore();
  const account = newAccount();
  const challenge = store.issueNonce();

  await assert.rejects(
    attemptLogin(store, account, challenge, { chainId: TEST_AUTH.chainId + 1 }),
    (err: unknown) => isAppError(err, 400, 'INVALID_SIWE_MESSAGE'),
  );
});

test('login rejects a message with a different statement with 400 INVALID_SIWE_MESSAGE', async () => {
  const store = newStore();
  const account = newAccount();
  const challenge = store.issueNonce();

  await assert.rejects(
    attemptLogin(store, account, challenge, { statement: 'Approve unlimited transfer' }),
    (err: unknown) => isAppError(err, 400, 'INVALID_SIWE_MESSAGE'),
  );
});

test('a rejected envelope does not consume the nonce', async () => {
  const store = newStore();
  const account = newAccount();
  const challenge = store.issueNonce();

  await assert.rejects(
    attemptLogin(store, account, challenge, { domain: 'evil.example' }),
    (err: unknown) => isAppError(err, 400, 'INVALID_SIWE_MESSAGE'),
  );

  // The challenge is still redeemable with the correct domain: a phishing attempt cannot burn it.
  const session = await attemptLogin(store, account, challenge);
  assert.equal(await store.authenticate(`Bearer ${session.token}`), account.address.toLowerCase());
});

test('login rejects a nonce that was never issued with 400 INVALID_NONCE', async () => {
  const store = newStore();
  const account = newAccount();
  const other = newStore();
  // A well-formed nonce issued by a different store (or another process): unknown here.
  const foreign = other.issueNonce();

  await assert.rejects(
    attemptLogin(store, account, foreign),
    (err: unknown) => isAppError(err, 400, 'INVALID_NONCE'),
  );
});

test('a nonce is single use: replaying it after login is 400 INVALID_NONCE', async () => {
  const store = newStore();
  const account = newAccount();
  const challenge = store.issueNonce();
  const signed = await signChallenge(account, challenge);

  await store.login(signed.message, signed.signature);

  await assert.rejects(
    store.login(signed.message, signed.signature),
    (err: unknown) => isAppError(err, 400, 'INVALID_NONCE'),
  );
});

test('an expired nonce is 400 NONCE_EXPIRED', async () => {
  let now = 1_700_000_000_000;
  const store = newStore({ now: () => now });
  const account = newAccount();
  const challenge = store.issueNonce();
  const signed = await signChallenge(account, challenge);

  now += NONCE_TTL_MS + 1;

  await assert.rejects(
    store.login(signed.message, signed.signature),
    (err: unknown) => isAppError(err, 400, 'NONCE_EXPIRED'),
  );
});

test('a stale issuedAt is 400 SIWE_EXPIRED even when the nonce is still fresh', async () => {
  const now = 1_700_000_000_000;
  const store = newStore({ now: () => now });
  const account = newAccount();
  const challenge = store.issueNonce();

  const stale = now - NONCE_TTL_MS - SIWE_CLOCK_SKEW_MS - 1;
  const signed = await signChallenge(account, challenge, { issuedAt: new Date(stale) });

  await assert.rejects(
    store.login(signed.message, signed.signature),
    (err: unknown) => isAppError(err, 400, 'SIWE_EXPIRED'),
  );
});

test('an issuedAt slightly ahead of the server is tolerated, a far-future one is not', async () => {
  const now = 1_700_000_000_000;
  const store = newStore({ now: () => now });
  const account = newAccount();

  const withinSkew = await signChallenge(account, store.issueNonce(), {
    issuedAt: new Date(now + SIWE_CLOCK_SKEW_MS - 1_000),
  });
  await assert.doesNotReject(store.login(withinSkew.message, withinSkew.signature));

  const farFuture = await signChallenge(account, store.issueNonce(), {
    issuedAt: new Date(now + SIWE_CLOCK_SKEW_MS + 60_000),
  });
  await assert.rejects(
    store.login(farFuture.message, farFuture.signature),
    (err: unknown) => isAppError(err, 400, 'INVALID_SIWE_MESSAGE'),
  );
});

test('an expirationTime in the past is 400 SIWE_EXPIRED', async () => {
  const now = 1_700_000_000_000;
  const store = newStore({ now: () => now });
  const account = newAccount();
  const challenge = store.issueNonce();

  const signed = await signChallenge(account, challenge, {
    issuedAt: new Date(now),
    expirationTime: new Date(now - 1_000),
  });

  await assert.rejects(
    store.login(signed.message, signed.signature),
    (err: unknown) => isAppError(err, 400, 'SIWE_EXPIRED'),
  );
});

test('an expired session is 401 UNAUTHORIZED', async () => {
  let now = 1_700_000_000_000;
  const store = newStore({ now: () => now });
  const account = newAccount();
  const challenge = store.issueNonce();

  const session = await attemptLogin(store, account, challenge);

  now += SESSION_TTL_MS + 1;

  await assert.rejects(
    () => store.authenticate(`Bearer ${session.token}`),
    (err: unknown) => isAppError(err, 401, 'UNAUTHORIZED'),
  );
});

test('authenticate rejects missing, malformed and unknown bearer tokens with 401 UNAUTHORIZED', async () => {
  const store = newStore();

  for (const header of [null, undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'deadbeef', 'Bearer deadbeef']) {
    await assert.rejects(
      () => store.authenticate(header),
      (err: unknown) => isAppError(err, 401, 'UNAUTHORIZED'),
      `expected 401 for header ${String(header)}`,
    );
  }
});

test('the module-level store shares sessions between issueNonce, login and authenticate', async () => {
  const account = newAccount();
  const challenge = issueNonce();
  const signed = await signChallenge(account, challenge);
  const session = await login(signed.message, signed.signature);

  assert.equal(await authenticate(`Bearer ${session.token}`), account.address.toLowerCase());
  await assert.rejects(
    () => authenticate('Bearer not-a-session'),
    (err: unknown) => err instanceof UnauthorizedError && err.code === 'UNAUTHORIZED',
  );
});

test('parseLoginBody requires message and signature strings, reporting 400 INVALID_AUTH', () => {
  assert.deepEqual(parseLoginBody({ message: ' siwe ', signature: '0xsig' }), {
    message: 'siwe',
    signature: '0xsig',
  });

  for (const body of [
    null,
    [],
    'x',
    {},
    { message: 'siwe' },
    { signature: '0xsig' },
    { message: 1, signature: '0xsig' },
    { message: 'siwe', signature: '  ' },
  ]) {
    assert.throws(
      () => parseLoginBody(body),
      (err: unknown) => err instanceof ValidationError && err.code === 'INVALID_AUTH',
    );
  }
});

// ---------------------------------------------------------------------------
// Provider ownership (pure gate, no DB)
// ---------------------------------------------------------------------------

test('assertProviderOwns accepts the owner (any casing) and rejects another wallet', () => {
  const owner = newAccount();

  assert.doesNotThrow(() => assertProviderOwns(owner.address, owner.address.toLowerCase()));
  assert.throws(
    () => assertProviderOwns(owner.address, newAccount().address),
    (err: unknown) => err instanceof ForbiddenError && err.status === 403 && err.code === 'FORBIDDEN',
  );
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

type TestDeps = Partial<ServerDeps>;

async function withServer<T>(run: (baseUrl: string) => Promise<T>, deps: TestDeps = {}): Promise<T> {
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
  body?: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function requestNonce(baseUrl: string): Promise<SiweChallenge> {
  const response = await postJson(baseUrl, '/auth/nonce');
  assert.equal(response.status, 200);
  return (await response.json()) as SiweChallenge;
}

async function loginOverHttp(
  baseUrl: string,
  account: PrivateKeyAccount,
): Promise<SessionCredentials> {
  const challenge = await requestNonce(baseUrl);
  const signed = await signChallenge(account, challenge);
  const response = await postJson(baseUrl, '/auth/login', signed);
  assert.equal(response.status, 200);
  return (await response.json()) as SessionCredentials;
}

test('HTTP: nonce → login → POST /strategies creates a strategy owned by the wallet', async () => {
  const account = newAccount();
  const calls: Array<{ provider: string; body: unknown }> = [];

  const fakeCreate: typeof createStrategy = async (body, provider) => {
    calls.push({ provider, body });
    return {
      id: 42,
      provider,
      name: 'Index 500',
      description: '',
      isPublic: true,
      swapFeeBps: 0,
      onchainId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  };

  await withServer(
    async (baseUrl) => {
      const challenge = await requestNonce(baseUrl);
      assert.match(challenge.nonce, /^[0-9a-f]{64}$/);

      const session = await loginOverHttp(baseUrl, account);
      assert.equal(session.token.length, 64);
      assert.ok(Date.parse(session.expiresAt) > Date.now());

      const response = await postJson(
        baseUrl,
        '/strategies',
        // The body claims another provider; the session wallet must win.
        { provider: '0x000000000000000000000000000000000000dEaD', name: 'Index 500' },
        session.token,
      );

      assert.equal(response.status, 201);
      assert.equal(response.headers.get('location'), '/strategies/42');
      const strategy = (await response.json()) as Strategy;
      assert.equal(strategy.provider, account.address.toLowerCase());
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.provider, account.address.toLowerCase());
    },
    { createStrategy: fakeCreate },
  );
});

test('HTTP: POST /strategies without a token is 401 and never reaches the domain layer', async () => {
  let called = false;

  await withServer(
    async (baseUrl) => {
      for (const token of [undefined, 'wrong-token']) {
        const response = await postJson(baseUrl, '/strategies', { name: 'Index 500' }, token);
        assert.equal(response.status, 401);
        assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'UNAUTHORIZED');
      }
      assert.equal(called, false);
    },
    {
      createStrategy: async () => {
        called = true;
        throw new Error('createStrategy must not run for an unauthenticated request');
      },
    },
  );
});

test('HTTP: POST /strategies/:id/versions without a token is 401, with a token it is 201', async () => {
  const published: StrategyVersion = {
    strategyId: 1,
    version: 1,
    allocation: { assets: [{ address: ASSET_A, weightBps: 10_000 }] },
    schedule: { kind: 'interval', intervalSeconds: 86_400 },
    changeLog: 'rebalance',
    activeAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const providers: string[] = [];

  await withServer(
    async (baseUrl) => {
      const unauthorized = await postJson(baseUrl, '/strategies/1/versions', PUBLISH_BODY);
      assert.equal(unauthorized.status, 401);

      const account = newAccount();
      const session = await loginOverHttp(baseUrl, account);
      const authorized = await postJson(baseUrl, '/strategies/1/versions', PUBLISH_BODY, session.token);
      assert.equal(authorized.status, 201);
      assert.deepEqual(await authorized.json(), published);
      assert.deepEqual(providers, [account.address.toLowerCase()]);
    },
    {
      publishVersion: async (_id: number, _input: PublishVersionInput, provider: string) => {
        providers.push(provider);
        return published;
      },
    },
  );
});

test('HTTP: login with a bad signature is 401 INVALID_SIGNATURE', async () => {
  await withServer(async (baseUrl) => {
    const alice = newAccount();
    const mallory = newAccount();
    const challenge = await requestNonce(baseUrl);
    const message = buildMessage(challenge, alice.address);

    const response = await postJson(baseUrl, '/auth/login', {
      message,
      signature: await mallory.signMessage({ message }),
    });

    assert.equal(response.status, 401);
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, 'INVALID_SIGNATURE');
  });
});

test('HTTP: a SIWE message for another domain is 400 INVALID_SIWE_MESSAGE', async () => {
  await withServer(async (baseUrl) => {
    const account = newAccount();
    const challenge = await requestNonce(baseUrl);

    const response = await postJson(
      baseUrl,
      '/auth/login',
      await signChallenge(account, challenge, { domain: 'phishing.example' }),
    );

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'INVALID_SIWE_MESSAGE');
  });
});

test('HTTP: replaying a used nonce is 400 INVALID_NONCE', async () => {
  await withServer(async (baseUrl) => {
    const account = newAccount();
    const challenge = await requestNonce(baseUrl);
    const body = await signChallenge(account, challenge);

    const first = await postJson(baseUrl, '/auth/login', body);
    assert.equal(first.status, 200);

    const replay = await postJson(baseUrl, '/auth/login', body);
    assert.equal(replay.status, 400);
    const payload = (await replay.json()) as { error: { code: string } };
    assert.equal(payload.error.code, 'INVALID_NONCE');
  });
});

test('HTTP: an authenticated non-owner publishing a version is 403 FORBIDDEN', async () => {
  const ownerAddress = '0x1111111111111111111111111111111111111111';

  await withServer(
    async (baseUrl) => {
      const stranger = newAccount();
      const session = await loginOverHttp(baseUrl, stranger);

      const response = await postJson(baseUrl, '/strategies/7/versions', PUBLISH_BODY, session.token);

      assert.equal(response.status, 403);
      const payload = (await response.json()) as { error: { code: string } };
      assert.equal(payload.error.code, 'FORBIDDEN');
    },
    {
      // Mirrors what the real publishVersion does after loading the strategy row.
      publishVersion: async (_id: number, _input: PublishVersionInput, provider: string) => {
        assertProviderOwns(ownerAddress, provider);
        throw new Error('ownership gate must throw before the insert');
      },
    },
  );
});

test('HTTP: POST /auth/login requires a JSON object body with message and signature', async () => {
  await withServer(async (baseUrl) => {
    const noBody = await postJson(baseUrl, '/auth/login');
    assert.equal(noBody.status, 400);
    assert.equal(((await noBody.json()) as { error: { code: string } }).error.code, 'INVALID_JSON');

    // The pre-SIWE body shape is gone: { wallet, nonce, signature } is no longer accepted.
    const legacy = await postJson(baseUrl, '/auth/login', { wallet: '0xabc', nonce: 'n', signature: '0xsig' });
    assert.equal(legacy.status, 400);
    assert.equal(((await legacy.json()) as { error: { code: string } }).error.code, 'INVALID_AUTH');
  });
});

// ---------------------------------------------------------------------------
// DB integration (gated on DATABASE_URL)
// ---------------------------------------------------------------------------

after(async () => {
  await closePool();
});

test('DB: provider ownership is enforced end to end over HTTP', { skip: skipDbChainWrites }, async () => {
  await migrate();
  const owner = newAccount();
  const stranger = newAccount();
  const strategy = await createStrategy(
    { name: `it-auth-${randomUUID()}`, isPublic: false },
    owner.address.toLowerCase(),
  );

  try {
    await withServer(async (baseUrl) => {
      const ownerSession = await loginOverHttp(baseUrl, owner);
      const created = await postJson(
        baseUrl,
        `/strategies/${strategy.id}/versions`,
        PUBLISH_BODY,
        ownerSession.token,
      );
      assert.equal(created.status, 201);
      assert.equal(((await created.json()) as StrategyVersion).version, 1);

      const strangerSession = await loginOverHttp(baseUrl, stranger);
      const denied = await postJson(
        baseUrl,
        `/strategies/${strategy.id}/versions`,
        PUBLISH_BODY,
        strangerSession.token,
      );
      assert.equal(denied.status, 403);
      assert.equal(((await denied.json()) as { error: { code: string } }).error.code, 'FORBIDDEN');
    });
  } finally {
    await query('delete from strategies where id = $1', [strategy.id]);
  }
});
