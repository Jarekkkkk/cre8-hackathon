import { query } from './db.js';
import type { PortfolioOutcome, SchedulerRound } from './scheduler.js';

/**
 * 排程器心跳（`scheduler_status` 單列）。
 *
 * 為什麼需要：排程器是**獨立的長駐進程**，它的狀態原本只存在於自己的 stdout。於是
 *
 *   1. operator dashboard 只能從 `portfolios.last_checked_at` 推算心跳 —— 所有投組都還沒到期時
 *      那個時間是舊的，看起來像排程器死了；
 *   2. 「進程死掉」與「沒有事要做」在畫面上長得一樣（這個 repo 在別的欄位踩過同一個坑）；
 *   3. 部署後無法確認線上跑的是 dry-run 還是 live、limit 多少。
 *
 * 這支模組只做兩件事：寫心跳（排程器每輪呼叫一次）與讀心跳（`/operator/overview`）。
 * 「還活著嗎」由**讀取端**用時間差換算，不存進 DB —— 存了就需要一個負責標記死亡的人，
 * 而那個人正是死掉的那個進程。
 */

/** 心跳落後超過這個秒數就算「可能死了」。 */
export const HEARTBEAT_STALE_SECONDS = 180;

export type SchedulerStatus = {
  startedAt: string;
  lastRoundAt: string | null;
  lastFinishedAt: string | null;
  rounds: number;
  dryRun: boolean;
  roundLimit: number;
  thresholdBps: number;
  intervalSeconds: number;
  lastSummary: Record<string, number>;
  lastError: string | null;
  pid: number | null;
  /** 距離上一輪結束幾秒（`null` = 從來沒跑完過）。 */
  staleSeconds: number | null;
  /** `staleSeconds` 超過 `HEARTBEAT_STALE_SECONDS` 或從未跑完 → false。 */
  alive: boolean;
};

/** 一個 round 的計數彙總。形狀固定成這幾個 key，前端不必猜。 */
export function summarizeRound(round: SchedulerRound): Record<string, number> {
  // 用固定的 key 集合：前端不必猜有哪些欄位。`PortfolioOutcome` 只有五種
  //（noop / blocked / ready-dry-run / executed / failed），沒有 `reverted` ——
  // 「上鏈但沒成功」在 `PortfolioRunResult` 裡仍記為 failed，差別在 `execution.status`。
  const counts: Record<PortfolioOutcome, number> = {
    executed: 0,
    noop: 0,
    blocked: 0,
    failed: 0,
    'ready-dry-run': 0,
  };
  for (const result of round.results) counts[result.outcome] += 1;

  return {
    claimed: round.claimed,
    executed: counts.executed,
    noop: counts.noop,
    blocked: counts.blocked,
    failed: counts.failed,
    readyDryRun: counts['ready-dry-run'],
  };
}

export type HeartbeatInput = {
  startedAt: Date;
  dryRun: boolean;
  limit: number;
  thresholdBps: number;
  intervalSeconds: number;
  round: SchedulerRound | null;
  rounds: number;
  error?: string | null;
};

/** 排程器每輪呼叫一次（`round === null` 代表這一輪拋錯，只更新錯誤）。 */
export async function writeHeartbeat(input: HeartbeatInput): Promise<void> {
  const finishedAt = input.round === null ? null : new Date();
  const summary = input.round === null ? null : summarizeRound(input.round);
  const results = input.round?.results ?? [];
  const finished = results.length > 0 || input.round !== null;

  await query(
    `insert into scheduler_status
       (id, started_at, last_round_at, last_finished_at, rounds, dry_run, round_limit,
        threshold_bps, interval_seconds, last_summary, last_error, pid, updated_at)
     values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, now())
     on conflict (id) do update set
       started_at       = excluded.started_at,
       last_round_at    = excluded.last_round_at,
       last_finished_at = case when $12::boolean then excluded.last_finished_at else scheduler_status.last_finished_at end,
       rounds           = excluded.rounds,
       dry_run          = excluded.dry_run,
       round_limit      = excluded.round_limit,
       threshold_bps    = excluded.threshold_bps,
       interval_seconds = excluded.interval_seconds,
       last_summary     = coalesce(excluded.last_summary, scheduler_status.last_summary),
       last_error       = excluded.last_error,
       pid              = excluded.pid,
       updated_at       = now()`,
    [
      input.startedAt,
      input.round === null ? null : new Date(),
      finishedAt,
      input.rounds,
      input.dryRun,
      input.limit,
      input.thresholdBps,
      input.intervalSeconds,
      summary === null ? null : JSON.stringify(summary),
      input.error ?? null,
      typeof process.pid === 'number' ? process.pid : null,
      finished,
    ],
  );
}

/**
 * 讀心跳。沒有任何一列 → `null`（排程器從來沒跑過，不是「死了」）。
 *
 * `now` 可注入，讓測試不必等真的時間過去。
 */
export async function readSchedulerStatus(now: Date = new Date()): Promise<SchedulerStatus | null> {
  const { rows } = await query<{
    started_at: Date;
    last_round_at: Date | null;
    last_finished_at: Date | null;
    rounds: string | number;
    dry_run: boolean;
    round_limit: number;
    threshold_bps: number;
    interval_seconds: number;
    last_summary: Record<string, number> | null;
    last_error: string | null;
    pid: number | null;
  }>(
    `select started_at, last_round_at, last_finished_at, rounds, dry_run, round_limit,
            threshold_bps, interval_seconds, last_summary, last_error, pid
       from scheduler_status where id = 1`,
  );
  const row = rows[0];
  if (row === undefined) return null;

  const iso = (value: Date | null): string | null => (value === null ? null : new Date(value).toISOString());
  const staleSeconds =
    row.last_finished_at === null
      ? null
      : Math.max(0, Math.round((now.getTime() - new Date(row.last_finished_at).getTime()) / 1000));

  return {
    startedAt: new Date(row.started_at).toISOString(),
    lastRoundAt: iso(row.last_round_at),
    lastFinishedAt: iso(row.last_finished_at),
    rounds: Number(row.rounds),
    dryRun: row.dry_run,
    roundLimit: Number(row.round_limit),
    thresholdBps: Number(row.threshold_bps),
    intervalSeconds: Number(row.interval_seconds),
    lastSummary: row.last_summary ?? {},
    lastError: row.last_error,
    pid: row.pid === null ? null : Number(row.pid),
    staleSeconds,
    alive: staleSeconds !== null && staleSeconds <= HEARTBEAT_STALE_SECONDS,
  };
}
