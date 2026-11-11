// 本地開發／維運工具：把 BNB 打到一個 smart account，讓它的 session key 有 gas 可以發 UserOp。
//
// ⚠ 這支腳本只給**本地 Anvil fork 與測試網**用。生產環境的注資必須由**使用者自己**發起 ——
// 由持 OPERATOR_PRIVATE_KEY 的 operator 替使用者轉帳，等於我們代墊營運成本，也讓「使用者自己的
// 帳戶」這件事名不副實。原因見 docs/pitfalls.zh-TW.md §3.10：ERC-4337 的 UserOp gas 由 `sender`
// （smart account 自己）預付，session key 只是有權限指揮帳戶、本身不持有資產。
//
// 用法:
//   bun run scripts/fund-account.ts <smartAccountAddress> <bnbAmount>
// 例:
//   bun run scripts/fund-account.ts 0x1234567890abcdef1234567890abcdef12345678 0.01
// 環境變數（讀 backend/.env）:
//   RPC_URL              必填，鏈的 JSON-RPC
//   OPERATOR_PRIVATE_KEY 必填，發這筆普通轉帳的 key
//
// 參數故意寫得很囉唆：這是一支會把真錢打出去的腳本，錯一個字比多印三行難查得多。

import { config as loadDotenv } from 'dotenv';
import { createPublicClient, createWalletClient, formatEther, http, isAddress, parseEther } from 'viem';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { getGasConfig } from '../src/config.js';
import { describeGasStatus, perOperationCostWei } from '../src/funding.js';

const USAGE = `用法: bun run scripts/fund-account.ts <smartAccountAddress> <bnbAmount>

  smartAccountAddress  收款方：使用者的 smart account 地址（POST /portfolios 回應的
                       smartAccounts[0].address）。注意不是簽名的 session key 地址。
  bnbAmount            要打多少 BNB，十進位可含小數（例: 0.01）。

環境變數: RPC_URL、OPERATOR_PRIVATE_KEY（見 backend/.env.example）。
⚠ 僅供本地 fork／測試網使用；生產環境請由使用者自己把 BNB 轉到自己的帳戶。`;

function fail(message: string): never {
  console.error(`\n${message}\n\n${USAGE}\n`);
  process.exit(1);
}

function ensureHexKey(key: string): `0x${string}` {
  return key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`);
}

async function main(): Promise<void> {
  loadDotenv({ override: false });

  const [rawAddress, rawAmount] = process.argv.slice(2);
  if (rawAddress === undefined || rawAmount === undefined) fail('缺少參數。');

  if (!isAddress(rawAddress)) fail(`不是合法的 EVM 地址: "${rawAddress}"`);
  const target = rawAddress as Address;

  let amountWei: bigint;
  try {
    // parseEther 接受 "0.01" 這種十進位字串；"0.01 BNB"、負數或空字串都會拋。
    amountWei = parseEther(rawAmount.trim());
  } catch {
    fail(`不是合法的 BNB 數量: "${rawAmount}"（例: 0.01）`);
  }
  if (amountWei <= 0n) fail(`數量必須大於 0，收到 "${rawAmount}"`);

  const rpcUrl = process.env.RPC_URL?.trim();
  const operatorKey = process.env.OPERATOR_PRIVATE_KEY?.trim();
  const missing: string[] = [];
  if (!rpcUrl) missing.push('RPC_URL');
  if (!operatorKey) missing.push('OPERATOR_PRIVATE_KEY');
  if (!rpcUrl || !operatorKey) fail(`缺少環境變數 ${missing.join(' 與 ')}（見 backend/.env.example）。`);

  const account = privateKeyToAccount(ensureHexKey(operatorKey));
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain: bsc, transport: http(rpcUrl), account });

  const minimumWei = getGasConfig().minSessionGasWei;
  const gasPriceWei = await publicClient.getGasPrice();

  console.log(`目標 smart account: ${target}`);
  console.log(`operator（發交易、付這筆轉帳的 gas）: ${account.address}`);
  console.log(`本次轉入: ${formatEther(amountWei)} BNB`);
  console.log(`可執行門檻 (MIN_SESSION_GAS_WEI): ${formatEther(minimumWei)} BNB`);
  console.log(`當前 gas price: ${gasPriceWei} wei，換算一次 op ≈ ${formatEther(perOperationCostWei(gasPriceWei))} BNB`);

  const before = await publicClient.getBalance({ address: target });
  reportStatus('轉帳前', target, before, minimumWei, gasPriceWei);

  const hash = await wallet.sendTransaction({ account, chain: bsc, to: target, value: amountWei });
  console.log(`\n已送出 tx: ${hash}（等待上鏈…）`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`tx 狀態: ${receipt.status}，區塊 ${receipt.blockNumber}`);

  const after = await publicClient.getBalance({ address: target });
  reportStatus('轉帳後', target, after, minimumWei, gasPriceWei);

  if (after < minimumWei) {
    console.log(
      `\n⚠ 餘額仍未達門檻，這個帳戶還發不出 UserOp。再打 ${formatEther(minimumWei - after)} BNB 就夠。`,
    );
    process.exitCode = 1;
  } else {
    console.log('\n✅ 餘額已達門檻，這個 smart account 的 session key 可以發 UserOp 了。');
  }
}

function reportStatus(
  label: string,
  address: Address,
  balanceWei: bigint,
  minimumWei: bigint,
  gasPriceWei: bigint,
): void {
  const status = describeGasStatus({ address, balanceWei, minimumWei, gasPriceWei });
  const shortfall = status.ready ? '' : `（還缺 ${formatEther(BigInt(status.shortfallWei))} BNB）`;
  console.log(
    `\n[${label}] 餘額 ${formatEther(balanceWei)} BNB，可執行: ${status.ready ? 'yes' : 'no'}${shortfall}`,
  );
  console.log(
    status.gasPriceKnown
      ? `[${label}] estimatedOps ≈ ${status.estimatedOps} 次 op`
      : `[${label}] estimatedOps 未知（gas price 取不到）`,
  );
}

main().catch((err: unknown) => {
  console.error(`\n注資失敗: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
