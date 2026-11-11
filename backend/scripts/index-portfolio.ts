// 索引器入口：把「讀真實持倉 → 定價 → 算漂移 → 寫快照」整條路跑一次，並印成人看得懂的繁中摘要。
//
//   bun run scripts/index-portfolio.ts --portfolio 5            只算不寫，印報告
//   bun run scripts/index-portfolio.ts --portfolio 5 --write    算完寫快照（表頭 + 明細）
//
// 參數
//   --portfolio <id>        必填，DB 的 portfolios.id
//   --write                 寫快照（省略就是純唯讀）
//   --threshold-bps <bps>   再平衡門檻，預設 100（1%）
//   --rpc <url>             RPC，預設 RPC_URL → ANVIL_RPC_URL → http://127.0.0.1:8545
//   --registry <addr>       AtpRegistry，預設 REGISTRY_ADDRESS（沒有就失敗，不猜合約地址）
//
// 這支程式只印摘要，不印 calldata／bytecode；地址一律縮成 0x1234…abcd。

import { parseArgs } from 'node:util';
import { createPublicClient, http } from 'viem';
import type { Address } from 'viem';
import { bsc } from 'viem/chains';
import { closePool } from '../src/db.js';
import { formatScanStatus } from '../src/holdings-scan.js';
import { DEFAULT_THRESHOLD_BPS, formatE8, planPortfolio, writeSnapshot } from '../src/snapshot.js';
import type { PortfolioPlan } from '../src/snapshot.js';

const USAGE = `用法：
  bun run scripts/index-portfolio.ts --portfolio <id> [--write] [--threshold-bps <bps>] [--rpc <url>] [--registry <addr>]`;

/** `.env` 裡的空字串（`RPC_URL=`）要當成「沒設」，不能當成一個空 URL 傳給 http()。 */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** 代幣最小單位 → 顆數，固定 6 位小數（人看的，不是給計算用的）。 */
function formatTokens(amountWei: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amountWei / scale;
  const fraction = ((amountWei % scale) * 1_000_000n) / scale;
  return `${whole}.${fraction.toString().padStart(6, '0')}`;
}

/** 終端機寬度：中日韓字元佔兩格，用 text.length 排會歪掉。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const fill = Math.max(0, width - displayWidth(text));
  return align === 'left' ? text + ' '.repeat(fill) : ' '.repeat(fill) + text;
}

function printPlan(plan: PortfolioPlan, rpcUrl: string): void {
  const { snapshot, report, pinnedVersion, allocationCheck } = plan;
  const labels = new Map(plan.targets.map((target) => [target.asset, target.symbol]));
  for (const asset of snapshot.unpriced) labels.set(asset.asset, asset.symbol);
  const label = (asset: string): string => labels.get(asset) ?? shortAddress(asset);

  console.log(`\n=== portfolio ${plan.portfolioId} 持倉與漂移（chain ${plan.chainId}, block ${snapshot.block}）===`);
  console.log(`RPC          ${rpcUrl}`);
  console.log(`smart account ${plan.account}`);
  console.log(
    `釘住的版本    DB strategy ${plan.strategyId} / 鏈上 strategy #${pinnedVersion.onchainStrategyId} ` +
      `v${pinnedVersion.version}${pinnedVersion.paused ? '（paused）' : ''}`,
  );
  console.log(
    `native 餘額   ${formatTokens(snapshot.nativeBalanceWei, 18)} BNB —— 只付 gas，不算投資部位`,
  );

  if (snapshot.holdings.length === 0) {
    console.log('投資部位      無（這個策略 version.assets 的每個資產餘額都是 0）');
  } else {
    console.log('投資部位');
    for (const holding of snapshot.holdings) {
      const valueE8 = (holding.amountWei * holding.usdPriceE8) / 10n ** BigInt(holding.decimals);
      // 價格出處要寫出來：numeraire 是定義（1 USDT = 1e8），TWAP 是池子的觀察值，混淆了會查不下去。
      const source = holding.priceSource === 'numeraire' ? '（numeraire）' : '';
      console.log(
        `  ${pad(label(holding.asset), 8)} ${pad(formatTokens(holding.amountWei, holding.decimals), 18, 'right')} 顆` +
          `  @ ${pad(formatE8(holding.usdPriceE8), 14, 'right')} USDT${source}` +
          `  = ${pad(formatE8(valueE8), 14, 'right')} USD`,
      );
    }
  }

  const heldUnpriced = snapshot.unpriced.filter((asset) => asset.amountWei > 0n);
  const idleUnpriced = snapshot.unpriced.filter((asset) => asset.amountWei === 0n);
  if (heldUnpriced.length > 0) {
    console.log('⚠ 持有但沒有價格（不進漂移）');
    for (const asset of heldUnpriced) {
      console.log(`  ${pad(asset.symbol, 8)} ${pad(formatTokens(asset.amountWei, asset.decimals), 18, 'right')} 顆  ${asset.reason}`);
    }
  }
  if (idleUnpriced.length > 0) {
    console.log(`無價標的（未持有，不影響）：${idleUnpriced.map((asset) => `${asset.symbol}(${asset.reason})`).join('、')}`);
  }

  // 策略外持倉與宇宙完整性：那**不是**這份明細的一部分（沒有 decimals、也不是策略資產），
  // 它是觀測訊號（表頭 unknown_token_count / universe_complete），不擋漂移，所以印在明細之外。
  for (const line of formatScanStatus(plan.scan)) console.log(line);

  console.log(
    `\n目標 vs 現況（門檻 ${plan.thresholdBps} bps）`,
  );
  console.log(`  ${pad('資產', 8)}${pad('目標bps', 9, 'right')}${pad('現況bps', 9, 'right')}${pad('差額bps', 9, 'right')}${pad('USD', 16, 'right')}`);
  const current = new Map((report?.assets ?? []).map((asset) => [asset.asset, asset]));
  for (const target of plan.targets) {
    const row = current.get(target.asset);
    console.log(
      `  ${pad(target.symbol, 8)}${pad(String(target.weightBps), 9, 'right')}` +
        `${pad(row === undefined ? '—' : String(row.currentBps), 9, 'right')}` +
        `${pad(row === undefined ? '—' : `${row.deltaBps > 0 ? '+' : ''}${row.deltaBps}`, 9, 'right')}` +
        `${pad(row === undefined ? '—' : formatE8(row.usdValueE8), 16, 'right')}`,
    );
  }
  const extra = (report?.assets ?? []).filter((asset) => !plan.targets.some((target) => target.asset === asset.asset));
  for (const row of extra) {
    console.log(
      `  ${pad(label(row.asset), 8)}${pad('0', 9, 'right')}${pad(String(row.currentBps), 9, 'right')}` +
        `${pad(`${row.deltaBps > 0 ? '+' : ''}${row.deltaBps}`, 9, 'right')}${pad(formatE8(row.usdValueE8), 16, 'right')}`,
    );
  }

  console.log(`\nDB 與鏈上 allocation：${allocationCheck.consistent ? '一致' : '不一致'}`);
  for (const mismatch of allocationCheck.mismatches) console.log(`  ⚠ ${mismatch}`);

  if (report === null) {
    console.log('\n漂移：拒算（設計 (a)：寧可沒有數字，也不要一個看起來合理的錯數字）');
    for (const blocked of plan.blocked) console.log(`  ✗ [${blocked.code}] ${blocked.detail}`);
    return;
  }

  console.log(`\n總價值 ${formatE8(report.totalUsdE8)} USDT（1e8 定點，逐資產整數除法截斷）`);
  console.log(
    `gross drift ${report.grossDriftBps} bps（Σ|Δ| / 2）、max |Δ| ${report.maxAbsDeltaBps} bps、門檻 ${report.thresholdBps} bps`,
  );
  console.log(`判定：${report.needsRebalance ? '需要再平衡' : '不需要再平衡'}`);
  if (report.totalUsdE8 === 0n) {
    console.log('（空倉：drift.ts 對 total = 0 的定義就是 grossDrift = 5000 bps，不是「已對齊」）');
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      portfolio: { type: 'string' },
      write: { type: 'boolean', default: false },
      'threshold-bps': { type: 'string' },
      rpc: { type: 'string' },
      registry: { type: 'string' },
    },
  });

  const portfolioArg = values.portfolio;
  if (portfolioArg === undefined) {
    console.error(USAGE);
    return 1;
  }
  const portfolioId = Number(portfolioArg);
  if (!Number.isSafeInteger(portfolioId) || portfolioId <= 0) {
    console.error(`--portfolio 必須是正整數（收到 ${portfolioArg}）`);
    return 1;
  }

  const thresholdRaw = values['threshold-bps'];
  const thresholdBps = thresholdRaw === undefined ? DEFAULT_THRESHOLD_BPS : Number(thresholdRaw);
  if (!Number.isInteger(thresholdBps) || thresholdBps < 0 || thresholdBps > 10_000) {
    console.error(`--threshold-bps 必須是 0..10000 的整數（收到 ${String(thresholdRaw)}）`);
    return 1;
  }

  const rpcUrl =
    firstNonEmpty(values.rpc, process.env.RPC_URL, process.env.ANVIL_RPC_URL) ?? 'http://127.0.0.1:8545';
  const registry = firstNonEmpty(values.registry, process.env.REGISTRY_ADDRESS);
  if (registry === undefined) {
    console.error('缺少 AtpRegistry 地址：用 --registry 或設 REGISTRY_ADDRESS（刻意不寫死合約地址）');
    return 1;
  }

  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const plan = await planPortfolio(portfolioId, {
    publicClient,
    registryAddress: registry as Address,
    thresholdBps,
  });
  printPlan(plan, rpcUrl);

  if (values.write === true) {
    const result = await writeSnapshot(plan.snapshot, plan.report, {
      thresholdBps: plan.thresholdBps,
      pinnedVersion: plan.pinnedVersion.version,
      scan: plan.scan,
    });
    console.log(
      `\n已寫入 portfolio_snapshots 表頭（portfolio ${portfolioId}, block ${plan.snapshot.block}）：` +
        `${result.headerInserted ? '新增' : '更新（同一個 block 重跑，是同一份觀測）'}；` +
        `complete = ${plan.report !== null}`,
    );
    // 觀測欄位：complete（策略資產是否都有價）才是「這份漂移可不可以信」。
    // unknown_token_count / universe_complete 是「帳戶還收到過什麼、我們看全了沒有」，
    // 策略外持倉賣不掉、不在漂移的分母裡，所以它們不擋漂移。
    console.log(
      `  表頭觀測欄位：unknown_token_count = ${plan.scan.unknownHoldings.length}、` +
        `universe_complete = ${plan.scan.universeComplete}` +
        (plan.scan.universeComplete ? '' : '（⚠ 掃描沒覆蓋帳戶完整歷史：漂移照算，但可能還有沒看過的代幣）'),
    );
    console.log(
      `已寫入 positions_snapshots 明細：新增 ${result.inserted} 列、更新 ${result.updated} 列` +
        (result.inserted + result.updated === 0 ? '（空倉：沒有明細可寫，表頭就是「跑過且是空的」的證據）' : ''),
    );
    if (plan.report === null) {
      console.log('（漂移被拒算：表頭 complete = false，漂移欄位一律 0 且不代表已對齊；無價資產的 usd_value 是 NULL，之後拿去算漂移會被 parseSnapshotRows 擋下）');
    }
  } else {
    console.log('\n（唯讀：沒有寫入。要寫快照請加 --write）');
  }

  return plan.blocked.length === 0 ? 0 : 2;
}

try {
  process.exitCode = await main();
} catch (cause) {
  console.error(`\n失敗：${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
