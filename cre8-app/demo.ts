// Elon Universe 端到端示範：v2（含 5% USDT 現金腿）→ enroll → 入金 → approve → plan → rebalance
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { approveCalldata, readAllowance, sendSudoCalls } from './src/lib/kernel.ts';
import {
  createStrategy, enrollPortfolio, getAssets, getPortfolioStatus, getRebalancePlan,
  postLogin, postNonce, postRebalance, publishVersion,
} from './src/lib/api.ts';

const SUDO = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const wallet = { kind: 'dev' as const, address: SUDO.address as `0x${string}`, account: SUDO };

const c = await postNonce();
const m = createSiweMessage({ address: SUDO.address, chainId: c.chainId, domain: c.domain, nonce: c.nonce, uri: c.uri, statement: c.statement, version: '1', issuedAt: new Date(c.issuedAt), expirationTime: new Date(c.expiresAt) });
const token = (await postLogin(m, await SUDO.signMessage({ message: m }))).token;
const assets = await getAssets(token);
const pick = (s: string) => assets.find((x) => x.symbol === s)!.address;

// 5% 現金腿，其餘等比縮（35→33.25 等），總和 10000 bps
const WEIGHTS: [string, number][] = [['USDT', 500], ['TSLAB', 3325], ['SPCXB', 3325], ['BTCB', 1425], ['DOGE', 950], ['ETH', 475]];

const strategyId = Number(process.argv[2] ?? 527);
const step = process.argv[3] ?? 'all';

if (step === 'publish') {
  await publishVersion(token, strategyId, {
    allocation: { assets: WEIGHTS.map(([s, bps]) => ({ address: pick(s), weightBps: bps })) },
    schedule: { kind: 'interval', intervalSeconds: 86400 },
    changeLog: 'v2: add a 5% USDT cash leg so the executor can move value (hub mode requires the numeraire in version.assets)',
  });
  console.log('  ✓ version 2 published（USDT 500 + 其餘等比縮）');
}

if (step === 'enroll') {
  const p = await enrollPortfolio(token, strategyId);
  console.log(`  ✓ portfolio ${p.id} (version ${p.version}) account ${p.smartAccounts[0]?.address ?? '?'}`);
  console.log(`  PORTFOLIO=${p.id}`);
}

if (step === 'any') {
  const id = Number(process.argv[4]);
  const s = await getPortfolioStatus(token, id);
  const ex = s.executorAddress as `0x${string}`;
  const owner = s.account as `0x${string}`;
  const rows = await Promise.all(s.targets.map(async (t) => ({ sym: t.symbol, token: t.asset as `0x${string}`, a: await readAllowance({ wallet, token: t.asset as `0x${string}`, owner, spender: ex }) })));
  console.log('  allowance 前:', rows.map((r) => `${r.sym}=${r.a > 0n ? 'ok' : '0'}`).join(' '));
  if (rows.some((r) => r.a === 0n)) {
    const r = await sendSudoCalls({ wallet, token, accountAddress: owner, calls: s.targets.map((t) => ({ to: t.asset as `0x${string}`, data: approveCalldata(ex), value: 0n })) });
    console.log('  ✓ approve 一筆 UserOp success=', r.success, r.txHash.slice(0, 12));
  }
  const plan = await getRebalancePlan(token, id);
  console.log(`  plan: ${plan.outcome} (${plan.steps.length} step) ${plan.outcome === 'ready' ? '' : plan.reason.slice(0, 120)}`);
  if (plan.outcome === 'ready' && process.argv[5] === 'run') {
    const r = await postRebalance(token, id);
    console.log(`  rebalance: ${r.outcome} tx=${(r.txHash ?? '').slice(0, 14)} ${r.outcome === 'executed' ? '' : r.reason.slice(0, 120)}`);
  }
}
