import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { createStrategy, enrollPortfolio, getAssets, postLogin, postNonce, publishVersion } from './src/lib/api.ts';
const SUDO = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const c = await postNonce();
const m = createSiweMessage({ address: SUDO.address, chainId: c.chainId, domain: c.domain, nonce: c.nonce, uri: c.uri, statement: c.statement, version: '1', issuedAt: new Date(c.issuedAt), expirationTime: new Date(c.expiresAt) });
const token = (await postLogin(m, await SUDO.signMessage({ message: m }))).token;
const assets = await getAssets(token);
const pick = (s: string) => assets.find((x) => x.symbol === s)!.address;
const WEIGHTS: [string, number][] = [['USDT', 500], ['TSLAB', 3325], ['SPCXB', 3325], ['BTCB', 1425], ['DOGE', 950], ['ETH', 475]];
const st = await createStrategy(token, { name: 'Elon Universe', description: 'Tesla and SpaceX, alongside Bitcoin, Dogecoin and Ethereum. 5% USDT cash leg so the executor can move value.' });
await publishVersion(token, st.id, {
  allocation: { assets: WEIGHTS.map(([s, bps]) => ({ address: pick(s), weightBps: bps })) },
  schedule: { kind: 'interval', intervalSeconds: 86400 },
  changeLog: 'initial mandate from the reference fund + 5% USDT cash leg',
});
const p = await enrollPortfolio(token, st.id);
console.log(`  ✓ strategy ${st.id} · portfolio ${p.id} · account ${p.smartAccounts[0]?.address ?? '?'}`);
console.log(`  PORTFOLIO=${p.id}`);
