// Demo: exercise the CRE8 ATP backend end-to-end (health -> SIWE auth -> create strategy -> publish version -> read back).
// Run with: bun run scripts/demo-flow.ts
// Requires the backend running at BACKEND_URL (default http://localhost:8080) with a Postgres DATABASE_URL.

import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.BACKEND_URL ?? 'http://localhost:8080';

// A throwaway demo key. Never use a real key here.
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

async function j(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

// 1. health
const health = await j('GET', '/health');
console.log('[1] GET /health', health.status, JSON.stringify(health.body));

// 2. nonce challenge
const nonceRes = await j('POST', '/auth/nonce');
const challenge = nonceRes.body as {
  nonce: string; domain: string; chainId: number; uri: string; statement: string; version: string; issuedAt: string;
};
console.log('[2] POST /auth/nonce', nonceRes.status, 'nonce=', challenge.nonce.slice(0, 12) + '...');

// 3. build + sign SIWE message
const message = createSiweMessage({
  address: account.address,
  chainId: challenge.chainId,
  domain: challenge.domain,
  uri: challenge.uri,
  statement: challenge.statement,
  nonce: challenge.nonce,
  version: challenge.version,
  issuedAt: new Date(challenge.issuedAt),
});
const signature = await account.signMessage({ message });
console.log('[3] signed SIWE message for', account.address);

// 4. login
const loginRes = await j('POST', '/auth/login', { message, signature });
const token = (loginRes.body as { token: string }).token;
console.log('[4] POST /auth/login', loginRes.status, 'token=', token.slice(0, 12) + '...');

// 5. create strategy (provider comes from the session wallet)
const createRes = await j(
  'POST', '/strategies',
  { provider: account.address, name: 'Demo Mag7 Index', description: 'curl/bun demo', isPublic: true, swapFeeBps: 25 },
  token,
);
const strategy = createRes.body as { id: number };
console.log('[5] POST /strategies', createRes.status, 'id=', strategy.id);

// 6. publish version
const publishRes = await j(
  'POST', '/strategies/' + strategy.id + '/versions',
  {
    allocation: {
      assets: [
        { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', weightBps: 5000 },
        { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', weightBps: 5000 },
      ],
    },
    schedule: { kind: 'interval', intervalSeconds: 86400 },
    changeLog: 'initial demo version',
  },
  token,
);
console.log('[6] POST /strategies/' + strategy.id + '/versions', publishRes.status);

// 7. read back
const readRes = await j('GET', '/strategies/' + strategy.id);
console.log('[7] GET /strategies/' + strategy.id, readRes.status, 'versions=', ((readRes.body as { versions?: unknown[] }).versions ?? []).length);

// 8. negative: unauthenticated write should 401
const noAuth = await j('POST', '/strategies', { provider: account.address, name: 'nope' });
console.log('[8] POST /strategies without token', noAuth.status, '(expect 401)');
