// End-to-end on a local Anvil fork of BSC mainnet (chain 56).
// Exercises the first chain-touching user interaction:
//   SIWE login -> create strategy (mirrored to AtpRegistry) -> publish version (mirrored) -> enroll.
// Run with: bun run scripts/integration-fork.ts
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.BACKEND_URL ?? 'http://127.0.0.1:8081';
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
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const health = await j('GET', '/health');
console.log('[1] health', health.status, JSON.stringify(health.body));

const nonceRes = await j('POST', '/auth/nonce');
const c = nonceRes.body as any;
const message = createSiweMessage({
  address: account.address,
  chainId: c.chainId,
  domain: c.domain,
  uri: c.uri,
  statement: c.statement,
  nonce: c.nonce,
  version: c.version,
  issuedAt: new Date(c.issuedAt),
});
const signature = await account.signMessage({ message });
const login = await j('POST', '/auth/login', { message, signature });
const token = (login.body as any).token;
console.log('[2] login', login.status, 'wallet=', account.address);

const created = await j('POST', '/strategies', {
  provider: account.address,
  name: 'Fork Mag7 Index',
  description: 'integration test',
  isPublic: true,
  swapFeeBps: 25,
}, token);
const sid = (created.body as any).id;
console.log('[3] create strategy', created.status, JSON.stringify(created.body));

const pub = await j('POST', `/strategies/${sid}/versions`, {
  allocation: {
    assets: [
      { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', weightBps: 5000 },
      { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', weightBps: 5000 },
    ],
  },
  schedule: { kind: 'interval', intervalSeconds: 86400 },
  changeLog: 'integration version',
}, token);
console.log('[4] publish version', pub.status, JSON.stringify(pub.body));

const enroll = await j('POST', '/portfolios', { strategyId: sid }, token);
console.log('[5] enroll', enroll.status, JSON.stringify(enroll.body));

const readBack = await j('GET', `/strategies/${sid}`);
console.log('[6] read back', readBack.status, 'versions=', (readBack.body as any)?.versions?.length);

console.log('WALLET=' + account.address);
console.log('STRATEGY_ID=' + sid);
