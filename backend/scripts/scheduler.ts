// 排程器的入口。**預設 dry-run，`--live` 是唯一會送鏈上交易的方式。**
//
//   bun run scripts/scheduler.ts --once                # 跑一輪（dry-run：只算、只印，不送交易）
//   bun run scripts/scheduler.ts --once --live         # 跑一輪並真的執行
//   bun run scripts/scheduler.ts --loop --interval 60  # 持續跑（預設仍是 dry-run）
//   bun run scripts/scheduler.ts --alerts               # 只印目前未解決的警示，不跑任何一輪
//
// 為什麼 live 要一個「額外」的旗標，而不是預設 live
//   這支程式動的是錢。任何一個「忘了關」的預設值都會變成一次沒人要求的再平衡；而漏跑一次只是
//   下一輪補上（next_run_at 在認領時就推進，見 src/scheduler.ts 檔頭）。所以不安全的那一側
//   必須是「預設不送出」，而 `--live` 是一個必須**主動打出來**的字。
//
// 輸出：每輪的摘要（認領幾個、各自結果）＋ 逐個 portfolio 的一行結果。全部繁中。
// 離開碼：0 = 這一輪跑完（blocked／noop 都算正常）；1 = 有 portfolio failed 或這一輪拋錯。

import { config as loadDotenv } from 'dotenv';
import type { Address } from 'viem';
import { alertCounts, formatAlert, listOpenAlerts } from '../src/alerts.js';
import { closePool, query } from '../src/db.js';
import { getConfig, getSessionKeyConfig } from '../src/config.js';
import { DEFAULT_ROUND_LIMIT, runSchedulerOnce } from '../src/scheduler.js';
import { writeHeartbeat } from '../src/scheduler-status.js';
import { DEFAULT_THRESHOLD_BPS } from '../src/snapshot.js';
import type { PortfolioOutcome, SchedulerRound } from '../src/scheduler.js';

// `.env` 只補沒設的變數（override: false）：CLI 前面 inline 帶的 env 優先。
loadDotenv({ override: false });

/**
 * `.env` 裡的 `RPC_URL=` 是空字串，而空字串不是「沒設」：`http('')` 會把請求送去某個不是 anvil 的
 * 地方（docs/pitfalls §8.12）。這裡只是為了在啟動時把「實際會打哪一個節點」印出來。
 */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

type Args = {
  /** `--alerts` 是純讀出（印完就結束）：它不是一輪，不會認領、不會送交易、不會寫 `scheduler_alerts`。 */
  mode: 'once' | 'loop' | 'alerts';
  live: boolean;
  intervalSeconds: number;
  limit: number;
  thresholdBps: number;
};

/** `--interval` 的預設與下限：一輪的長度要短於最短排程（60 秒），迴圈間隔不該比它更密。 */
const DEFAULT_LOOP_INTERVAL_SECONDS = 60;
const MIN_LOOP_INTERVAL_SECONDS = 10;

function parseArgs(argv: readonly string[]): Args {
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const integer = (name: string, fallback: number, bounds: { min: number }): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < bounds.min) {
      throw new Error(`--${name} 必須是 >= ${bounds.min} 的整數，收到 "${raw}"`);
    }
    return parsed;
  };

  if (has('once') && has('loop')) throw new Error('--once 與 --loop 只能擇一');
  if (has('alerts') && (has('once') || has('loop') || has('live'))) {
    throw new Error('--alerts 是純讀出（印完就結束），不能與 --once／--loop／--live 併用');
  }

  const known = new Set(['once', 'loop', 'live', 'alerts', 'interval', 'limit', 'threshold-bps']);
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    if (!known.has(arg.slice(2))) throw new Error(`不認得的旗標 ${arg}（可用：${[...known].map((n) => `--${n}`).join(' ')}）`);
  }

  return {
    mode: has('alerts') ? 'alerts' : has('loop') ? 'loop' : 'once',
    live: has('live'),
    intervalSeconds: integer('interval', DEFAULT_LOOP_INTERVAL_SECONDS, { min: MIN_LOOP_INTERVAL_SECONDS }),
    limit: integer('limit', DEFAULT_ROUND_LIMIT, { min: 1 }),
    thresholdBps: integer('threshold-bps', DEFAULT_THRESHOLD_BPS, { min: 1 }),
  };
}

const OUTCOME_LABEL: Record<PortfolioOutcome, string> = {
  noop: 'noop（不需要動）',
  blocked: 'blocked（被擋下，沒送交易）',
  'ready-dry-run': 'ready（dry-run，未送出；前置檢查全過＝--live 時不會被擋）',
  executed: 'executed（已上鏈）',
  failed: 'failed（上鏈失敗）',
};

/** 一輪的繁中摘要：認領幾個、各自結果。 */
function summarize(round: SchedulerRound): void {
  const counts: Record<PortfolioOutcome, number> = { noop: 0, blocked: 0, 'ready-dry-run': 0, executed: 0, failed: 0 };
  for (const result of round.results) counts[result.outcome] += 1;

  console.log(
    `\n=== 這一輪：認領 ${round.claimed} 個 portfolio（${round.dryRun ? 'dry-run：沒有送出任何交易' : 'LIVE：真的送出交易'}）===`,
  );
  for (const outcome of ['noop', 'blocked', 'ready-dry-run', 'executed', 'failed'] as PortfolioOutcome[]) {
    if (counts[outcome] === 0) continue;
    console.log(`  ${OUTCOME_LABEL[outcome]}：${counts[outcome]}`);
  }
  if (round.claimed === 0) {
    console.log('  沒有到期的 portfolio（schedule_state=active 且 next_run_at 已到期的那些才是候選）');
  }
  console.log('');
}

function describeEnvironment(args: Args): void {
  const rpc = firstNonEmpty(process.env.RPC_URL, process.env.ANVIL_RPC_URL);
  const registry = firstNonEmpty(process.env.REGISTRY_ADDRESS);
  const executor = getSessionKeyConfig().executorAddress;
  const bundler = firstNonEmpty(process.env.BUNDLER_URL);

  console.log('[scheduler] 設定');
  console.log(`  RPC            ${rpc ?? '(未設定 → 讀鏈會失敗，見 docs/pitfalls §8.12)'}`);
  console.log(`  REGISTRY       ${registry ?? '(未設定)'}`);
  console.log(`  EXECUTOR       ${String(executor as Address | null)}`);
  console.log(`  BUNDLER        ${bundler ?? '(未設定 → 預設 http://127.0.0.1:3001，只有 live 會用到)'}`);
  console.log(`  模式           ${args.mode === 'once' ? '--once（跑一輪）' : `--loop（每 ${args.intervalSeconds} 秒一輪）`}`);
  console.log(`  送出交易       ${args.live ? '是（--live）' : '否（沒有 --live：dry-run）'}`);
  console.log(`  limit          ${args.limit}`);
  console.log(`  thresholdBps   ${args.thresholdBps}`);
  if (args.live) {
    console.log('\n⚠ LIVE：這一輪會真的用 session key 送出 executeRebalance，會動到鏈上的錢。\n');
  } else {
    console.log('\n（dry-run：只讀鏈與 DB——不推進 next_run_at、不寫 operations、不送任何交易）\n');
  }
}

/** 可被 SIGINT 提前叫醒的等待：不在這裡輪詢，只是把 timer 的 resolve 存起來。 */
function makeSleeper(): { sleep: (ms: number) => Promise<void>; wake: () => void } {
  let wakeUp: (() => void) | null = null;
  return {
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeUp = null;
          resolve();
        }, ms);
        wakeUp = () => {
          clearTimeout(timer);
          wakeUp = null;
          resolve();
        };
      }),
    wake: () => wakeUp?.(),
  };
}

/**
 * `--alerts`：只印目前未解決的警示，然後結束。
 *
 * 為什麼要有這個出口：排程器的失敗必須**查得到**。`GET /health` 給機器（負載平衡器／監控），
 * 這裡給人 —— 「現在到底有什麼沒解決」一句指令就有答案，不必去翻 400 行的輪次 log，也不必等
 * 下一輪跑完（`--once` 預設是 dry-run，仍會寫警示，但那是另一件事）。
 *
 * 純讀出：不認領、不送交易、不寫 `scheduler_alerts`。
 */
async function listAlerts(): Promise<void> {
  const open = await listOpenAlerts(query);
  const counts = alertCounts(open);
  if (open.length === 0) {
    console.log('[ALERT] No unresolved alerts.');
    return;
  }

  console.log(`[ALERT] Unresolved alerts: ${counts.open} (critical ${counts.critical}, warn ${counts.warn})`);
  for (const alert of open) {
    console.log(formatAlert(alert));
    console.log(
      `        first ${alert.firstSeenAt.toISOString()}, last ${alert.lastSeenAt.toISOString()}, seen ${alert.occurrences} time(s)`
      + ` (${alert.kind}${alert.portfolioId === null ? '' : `, portfolio ${alert.portfolioId}`})`,
    );
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // 先載入 .env（DATABASE_URL 等），讓設定錯誤在跑迴圈之前就炸出來。
  getConfig();

  // --alerts：只讀 DB 印出未解決的警示，不跑任何一輪。
  if (args.mode === 'alerts') {
    await listAlerts();
    return 0;
  }

  describeEnvironment(args);

  const startedAt = new Date();
  const runRound = (): Promise<SchedulerRound> =>
    runSchedulerOnce({
      dryRun: !args.live,
      limit: args.limit,
      thresholdBps: args.thresholdBps,
    });

  /**
   * 跑一輪並寫心跳。
   *
   * 心跳**失敗不能讓這一輪失敗**：排程器的工作是再平衡，寫狀態是觀測。反過來（因為寫不了心跳
   * 就不跑）會變成「DB 一時讀寫慢 → 所有使用者的部位都不再平衡」。
   */
  const runRoundWithHeartbeat = async (rounds: number): Promise<SchedulerRound> => {
    let round: SchedulerRound | null = null;
    let error: string | null = null;
    try {
      round = await runRound();
      return round;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      await writeHeartbeat({
        startedAt,
        dryRun: !args.live,
        limit: args.limit,
        thresholdBps: args.thresholdBps,
        intervalSeconds: args.intervalSeconds,
        round,
        rounds,
        error,
      }).catch((cause: unknown) => {
        console.error(`[scheduler] 心跳寫入失敗（不影響這一輪）：${cause instanceof Error ? cause.message : String(cause)}`);
      });
    }
  };

  if (args.mode === 'once') {
    const round = await runRoundWithHeartbeat(1);
    summarize(round);
    return round.results.some((result) => result.outcome === 'failed') ? 1 : 0;
  }

  // --loop：graceful shutdown。第一次 SIGINT 只是「跑完這一輪再停」，第二次才硬停。
  let stopping = false;
  const sleeper = makeSleeper();
  const onSignal = (signal: string): void => {
    if (stopping) {
      console.log(`\n[scheduler] 第二次收到 ${signal}：立刻結束（可能打斷一輪進行中的執行）`);
      process.exit(130);
    }
    stopping = true;
    console.log(`\n[scheduler] 收到 ${signal}：**跑完當前這一輪就停**（再按一次會立刻結束）`);
    sleeper.wake();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  let roundIndex = 0;
  let lastExit = 0;
  while (!stopping) {
    roundIndex += 1;
    console.log(`[scheduler] 第 ${roundIndex} 輪（${new Date().toISOString()}）`);
    try {
      const round = await runRoundWithHeartbeat(roundIndex);
      summarize(round);
      lastExit = round.results.some((result) => result.outcome === 'failed') ? 1 : 0;
    } catch (error) {
      // 一輪拋錯（DB 斷線、migration 沒跑）不該讓迴圈死掉：記下來、下一輪再試。
      console.error(`[scheduler] 第 ${roundIndex} 輪失敗：${error instanceof Error ? error.message : String(error)}`);
      lastExit = 1;
    }
    if (stopping) break;
    await sleeper.sleep(args.intervalSeconds * 1_000);
  }

  console.log(`[scheduler] 已停止（跑了 ${roundIndex} 輪）`);
  return lastExit;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  console.error(`\n失敗：${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await closePool().catch(() => undefined);
}
process.exitCode = exitCode;
