// 再平衡規劃器的 CLI：讀 portfolio → 跑索引器 → 跑規劃器 → 印人看得懂的繁中摘要。
//
//   bun run scripts/plan-rebalance.ts --portfolio 5
//
// **唯讀：不送任何交易。** 這支程式只做 `eth_call` 等級的讀取（`planPortfolio` 內部也一樣），
// 把「合約會收到什麼參數」印出來給人看。真的送出去是另一件事（session key → Kernel → executor）。
//
// 參數
//   --portfolio <id>        必填，DB 的 portfolios.id
//   --executor <addr>       AtpExecutor，預設 EXECUTOR_ADDRESS → spike/anvil/baseline.json 的部署記錄
//                           （優先 `AtpExecutorMultiPool`，沒有那一筆才退回 v1 的 `AtpExecutor`）
//   --oracle <addr>         oracle，預設向 executor 問 `oracle()`（那是唯一權威，不寫死）
//   --registry <addr>       AtpRegistry，預設 REGISTRY_ADDRESS
//   --threshold-bps <bps>   再平衡門檻，預設 100（1%）
//   --deadline-seconds <s>  deadline = 塊時間 + 這個秒數，預設 300
//   --max-impact-bps <bps>  每一步的價格衝擊上限（預設 50 = 半個滑價預算）；`off` = 關掉（舊行為）
//   --rpc <url>             RPC，預設 RPC_URL → ANVIL_RPC_URL → http://127.0.0.1:8545
//
// 兩個容易搞錯的 id：
//   * `effectiveFeeBps` 吃的是**鏈上** strategy id（`enrollment.strategyId`），不是 DB 的
//     `strategies.id`。這支程式一律用 `pinnedVersion.onchainStrategyId`。
//   * 能不能換第三個資產是 **oracle** 的事，不是 executor 的事：executorMultiPool 的 oracle 是
//     `AtpMultiPoolOracle`（宣告 numeraire、每次 previewSwap 轉給該資產自己的 per-pair oracle），
//     規劃器會在 hub 模式下對每個非 numeraire 的資產各產生一步。v1 的 oracle 只釘一個 pool。這支程式
//     不需要知道是哪一種 —— 它問 `executor.oracle()` 拿到哪個就用哪個，形狀由規劃器判。

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createPublicClient, decodeAbiParameters, http } from 'viem';
import type { Address } from 'viem';
import { bsc } from 'viem/chains';
import { getConfig } from '../src/config.js';
import { closePool } from '../src/db.js';
import { planRebalance, DEFAULT_DEADLINE_SECONDS } from '../src/rebalance-plan.js';
import type { RebalancePlan } from '../src/rebalance-plan.js';
import { DEFAULT_THRESHOLD_BPS, formatE8, planPortfolio } from '../src/snapshot.js';

const USAGE = `用法：
  bun run scripts/plan-rebalance.ts --portfolio <id> [--executor <addr>] [--oracle <addr>]
                                   [--registry <addr>] [--threshold-bps <bps>]
                                   [--deadline-seconds <s>] [--max-impact-bps <bps>|off]
                                   [--rpc <url>]`;

/**
 * `inputs[0]` 的 ABI：`(recipient, amountIn, amountOutMin, path, payerIsUser)`。
 * CLI 自己解一次（而不是相信 step 的其他欄位）是刻意的：印出來的就是路由器真的會收到的東西。
 */
const V3_SWAP_INPUT_ABI = [
  { name: 'recipient', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'amountOutMin', type: 'uint256' },
  { name: 'path', type: 'bytes' },
  { name: 'payerIsUser', type: 'bool' },
] as const;

const EXECUTOR_ABI = [
  { type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

/** `.env` 裡的空字串（`RPC_URL=`）要當成「沒設」，不能當成一個空 URL 傳給 http()。 */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** 代幣最小單位 → 顆數，固定 6 位小數（人看的，不是給計算用的）。 */
function formatTokens(amountWei: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  return `${amountWei / scale}.${(((amountWei % scale) * 1_000_000n) / scale).toString().padStart(6, '0')}`;
}

/**
 * 「這台 fork 上 AtpExecutor / AtpRegistry 是哪一個」不是 env 一定有的事（`.env` 的兩個變數可能是空的）。
 * `spike/anvil/baseline.json` 就是這台 fork 的部署記錄 —— `refresh-anvil.sh` 在沒有 REGISTRY_ADDRESS
 * 時也是這樣取（它拿去做 owner() 驗證）。所以這裡把它當**退路**：只在旗標／env 都沒給時使用，
 * 而且一定會把「我是從哪裡拿到這個地址的」印出來 —— 猜合約地址不該是靜默行為。
 *
 * 傳進來的 key 依序嘗試，第一個有地址的就用：executor 是 `['AtpExecutorMultiPool', 'AtpExecutor']`，
 * 也就是**預設接多池堆疊**（oracle = AtpMultiPoolOracle）。退回 v1 時呼叫端會印警告：v1 的 oracle
 * 只釘一個 pool，>2 資產在它上面永遠是 blocked。
 */
function addressFromBaseline(
  contracts: readonly ('AtpExecutorMultiPool' | 'AtpExecutor' | 'AtpRegistry')[],
): { address: Address; source: string; key: string } | null {
  const baselinePath = new URL('../../spike/anvil/baseline.json', import.meta.url);
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      contracts?: Record<string, { address?: unknown } | undefined>;
    };
    for (const contract of contracts) {
      const address = parsed.contracts?.[contract]?.address;
      if (typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address)) {
        return { address: address as Address, source: `spike/anvil/baseline.json（${contract}）`, key: contract };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function printPlan(
  plan: RebalancePlan,
  blockTimestamp: bigint,
  deadlineSeconds: number,
  executor: string,
): void {
  if (plan.kind === 'noop') {
    console.log(`\n規劃結果：noop（不需要動）`);
    console.log(`  ${plan.reason}`);
    console.log('  → 不送任何東西。空 steps 的 executeRebalance 會「成功但什麼都沒做」（pitfalls §8.1），所以這裡不送。');
    return;
  }
  if (plan.kind === 'blocked') {
    console.log(`\n規劃結果：blocked（算不出來，不猜）`);
    console.log(`  ${plan.reason}`);
    return;
  }

  console.log(`\n規劃結果：ready（${plan.steps.length} 個 step）`);
  const blockTime = blockTimestamp;
  const delta = plan.deadline - blockTime;
  console.log(
    `  deadline   ${plan.deadline}（= 塊時間 ${blockTime} + ${delta}s，設定 ${deadlineSeconds}s；` +
      `${delta <= 2_592_000n ? '< 30 天，符合 Permit2 上限' : '⚠ 超過 Permit2 的 30 天上限'}）`,
  );
  for (const [index, step] of plan.steps.entries()) {
    console.log(`  step ${index}`);
    console.log(`    tokenIn   ${step.tokenIn}`);
    console.log(`    tokenOut  ${step.tokenOut}`);
    console.log(`    amountIn  ${step.amountIn}（tokenIn 最小單位）`);
    console.log(`    amountOutMin ${step.amountOutMin}（= minGross）`);
    console.log(`    oracleFloor  ${step.oracleFloor}（previewSwap 的 minimum，不是 quoted）`);
    console.log(`    commands  ${step.commands}（V3_SWAP_EXACT_IN，一個 byte，packed）`);
    console.log(`    inputs    ${step.inputs.length} 筆`);
    const input = step.inputs[0];
    if (input === undefined) {
      console.log('    ⚠ inputs 是空的：合約的 _checkCommands 會 revert BadCommands');
      continue;
    }
    const decoded = decodeAbiParameters(V3_SWAP_INPUT_ABI, input);
    // path = abi.encodePacked(tokenIn, uint24 fee, tokenOut)：0x+40 hex 之後那 3 bytes 就是池子的 fee。
    const path = decoded[3];
    const fee = Number.parseInt(path.slice(42, 48), 16);
    console.log(`    recipient ${decoded[0]}（必須等於 executor：${decoded[0].toLowerCase() === executor.toLowerCase() ? 'OK' : '✗ BadRecipient'}）`);
    console.log(`    path      ${short(step.tokenIn)} + fee ${fee} + ${short(step.tokenOut)}（fee 讀自池子，不是寫死）`);
    console.log(`    payload   amountIn ${decoded[1]}、amountOutMin ${decoded[2]}、payerIsUser ${decoded[4]}`);
  }
  console.log(`  rationale`);
  for (const part of plan.rationale.split('；')) console.log(`    ${part}`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      portfolio: { type: 'string' },
      executor: { type: 'string' },
      oracle: { type: 'string' },
      registry: { type: 'string' },
      'threshold-bps': { type: 'string' },
      'deadline-seconds': { type: 'string' },
      'max-impact-bps': { type: 'string' },
      rpc: { type: 'string' },
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

  // `off` = 關掉衝擊上限（完全回到舊行為）；省略 = 規劃器的預設值（50 bps）。
  const maxImpactRaw = values['max-impact-bps'];
  let maxImpactBps: number | null | undefined;
  if (maxImpactRaw === undefined) maxImpactBps = undefined;
  else if (maxImpactRaw === 'off' || maxImpactRaw === 'null') maxImpactBps = null;
  else {
    const parsed = Number(maxImpactRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed >= 10_000) {
      console.error(`--max-impact-bps 必須是 1..9999 的整數或 off（收到 "${maxImpactRaw}"）`);
      return 1;
    }
    maxImpactBps = parsed;
  }

  const deadlineRaw = values['deadline-seconds'];
  const deadlineSeconds = deadlineRaw === undefined ? undefined : Number(deadlineRaw);
  if (deadlineSeconds !== undefined && (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 1)) {
    console.error(`--deadline-seconds 必須是正整數（收到 ${String(deadlineRaw)}）`);
    return 1;
  }

  // getConfig() 會載入 .env（不覆蓋既有 env）並驗證 DATABASE_URL；RPC 與 registry 都從這裡取。
  const config = getConfig();
  const rpcUrl =
    firstNonEmpty(values.rpc, process.env.ANVIL_RPC_URL, config.rpcUrl ?? undefined) ??
    'http://127.0.0.1:8545';
  let registry = firstNonEmpty(values.registry, config.registryAddress ?? undefined);
  let registrySource = '旗標／環境變數';
  if (registry === undefined) {
    const fromBaseline = addressFromBaseline(['AtpRegistry']);
    if (fromBaseline === null) {
      console.error(
        '缺少 AtpRegistry 地址：用 --registry 或設 REGISTRY_ADDRESS（也讀不到 spike/anvil/baseline.json 的部署記錄）',
      );
      return 1;
    }
    registry = fromBaseline.address;
    registrySource = fromBaseline.source;
  }

  let executor = firstNonEmpty(values.executor, process.env.EXECUTOR_ADDRESS);
  let executorSource = '旗標／環境變數';
  if (executor === undefined) {
    const fromBaseline = addressFromBaseline(['AtpExecutorMultiPool', 'AtpExecutor']);
    if (fromBaseline === null) {
      console.error(
        '缺少 AtpExecutor 地址：用 --executor 或設 EXECUTOR_ADDRESS（也讀不到 spike/anvil/baseline.json 的部署記錄）',
      );
      return 1;
    }
    executor = fromBaseline.address;
    executorSource = fromBaseline.source;
    if (fromBaseline.key === 'AtpExecutor') {
      console.warn(
        '⚠ spike/anvil/baseline.json 沒有 AtpExecutorMultiPool，退回 v1 的 AtpExecutor：' +
          '它的 oracle 只釘一個 pool，>2 資產的投組在它上面永遠是 blocked',
      );
    }
  }

  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });

  // oracle 向 executor 問：那是 immutable 且唯一權威，寫死在 CLI 裡只會有一天跟鏈上不一致。
  const [wiredOracle, wiredRegistry] = await Promise.all([
    publicClient.readContract({ address: executor as Address, abi: EXECUTOR_ABI, functionName: 'oracle' }),
    publicClient.readContract({ address: executor as Address, abi: EXECUTOR_ABI, functionName: 'registry' }),
  ]);
  const oracle = (firstNonEmpty(values.oracle) ?? wiredOracle) as Address;
  if (oracle.toLowerCase() !== wiredOracle.toLowerCase()) {
    console.error(
      `--oracle ${oracle} 與 executor.oracle() ${wiredOracle} 不同：合約的地板不會是你要的那一個，停下來`,
    );
    return 1;
  }
  if (wiredRegistry.toLowerCase() !== registry.toLowerCase()) {
    console.error(
      `registry 不一致：executor 讀的是 ${wiredRegistry}，這支程式會用 ${registry} 算 feeBps —— 停下來`,
    );
    return 1;
  }

  const plan = await planPortfolio(portfolioId, {
    publicClient,
    registryAddress: registry as Address,
    thresholdBps,
  });

  console.log(
    `\n=== portfolio ${portfolioId} 再平衡規劃（chain ${plan.chainId}, block ${plan.snapshot.block}）===`,
  );
  console.log(`RPC            ${rpcUrl}`);
  console.log(`smart account  ${plan.account}`);
  console.log(`executor       ${executor}（來源：${executorSource}）`);
  console.log(`oracle         ${oracle}（executor.oracle()）`);
  console.log(`registry       ${registry}（來源：${registrySource}）`);
  console.log(
    `釘住的版本      DB strategy ${plan.strategyId} / 鏈上 strategy #${plan.pinnedVersion.onchainStrategyId} ` +
      `v${plan.pinnedVersion.version}${plan.pinnedVersion.paused ? '（paused，executor 會 revert Paused）' : ''}`,
  );
  console.log(
    `effectiveFeeBps 讀的是鏈上 id ${plan.pinnedVersion.onchainStrategyId}（不是 DB 的 ${plan.strategyId}）`,
  );

  if (plan.snapshot.holdings.length === 0) {
    console.log('投資部位        無（version.assets 的每個資產餘額都是 0）');
  } else {
    console.log('投資部位');
    for (const holding of plan.snapshot.holdings) {
      const valueE8 = (holding.amountWei * holding.usdPriceE8) / 10n ** BigInt(holding.decimals);
      console.log(
        `  ${short(holding.asset)} ${formatTokens(holding.amountWei, holding.decimals)} 顆` +
          `  @ ${formatE8(holding.usdPriceE8)} USDT = ${formatE8(valueE8)} USD`,
      );
    }
  }

  if (plan.report === null) {
    console.log('\n漂移：拒算（索引器沒有給出可信的漂移，規劃器沒有輸入）');
    for (const blocked of plan.blocked) console.log(`  ✗ [${blocked.code}] ${blocked.detail}`);
    console.log('\n（唯讀：沒有送出任何交易）');
    return 2;
  }

  const report = plan.report;
  console.log(
    `\n總價值 ${formatE8(report.totalUsdE8)} USDT；gross drift ${report.grossDriftBps} bps、` +
      `max |Δ| ${report.maxAbsDeltaBps} bps、門檻 ${report.thresholdBps} bps → ` +
      `${report.needsRebalance ? '需要再平衡' : '不需要再平衡'}`,
  );
  const symbols = new Map(plan.targets.map((target) => [target.asset.toLowerCase(), target.symbol]));
  console.log(`  ${'資產'.padEnd(8)}${'目標bps'.padStart(9)}${'現況bps'.padStart(9)}${'差額bps'.padStart(9)}`);
  for (const row of report.assets) {
    const label = symbols.get(row.asset.toLowerCase()) ?? short(row.asset);
    console.log(
      `  ${label.padEnd(8)}${String(row.targetBps).padStart(9)}${String(row.currentBps).padStart(9)}` +
        `${`${row.deltaBps > 0 ? '+' : ''}${row.deltaBps}`.padStart(9)}`,
    );
  }

  const block = await publicClient.getBlock({ blockNumber: plan.snapshot.block });
  const planningArgs = {
    publicClient,
    account: plan.account,
    executor: executor as Address,
    oracle,
    registry: registry as Address,
    strategyId: BigInt(plan.pinnedVersion.onchainStrategyId),
    holdings: plan.snapshot.holdings,
    targets: plan.targets,
    drift: report,
    thresholdBps: plan.thresholdBps,
    blockNumber: plan.snapshot.block,
    ...(deadlineSeconds === undefined ? {} : { deadlineSeconds }),
    ...(maxImpactBps === undefined ? {} : { maxImpactBps }),
  };
  const result = await planRebalance(planningArgs);
  printPlan(result, block.timestamp, deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS, executor);

  console.log('\n（唯讀：沒有送出任何交易。真的要送是 session key → Kernel → executeRebalance）');
  return result.kind === 'blocked' ? 2 : 0;
}

try {
  process.exitCode = await main();
} catch (cause) {
  console.error(`\n失敗：${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
