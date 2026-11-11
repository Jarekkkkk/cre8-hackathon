import type { Address } from 'viem';
import { getAccountGasBalance, getGasPriceWei } from './chain.js';
import { DEFAULT_CHAIN_ID } from './config.js';
import { perOperationCostWei } from './funding.js';

/**
 * 排程器的告警。**三個種類、全部從 DB 可推導**（不靠 process 記憶體）。
 *
 * 為什麼要做這件事（真實證據，詳見 `db/migrations/0013_scheduler_alerts.sql`）
 *   三次長跑（各約 2.5 小時）的實際結果：34 輪只有 1 輪成功、17 輪只有 1 輪成功、1 輪 —— **20+ 輪
 *   失敗，沒有任何東西通知任何人**，是靠人手動翻 log 才發現的。一個沒有告警的排程器不該進生產：
 *   它壞掉的方式不是當掉（當掉會被看見），而是「每一輪都失敗、每一輪都印一行、然後繼續跑」。
 *
 * 本模組刻意分成三個職責，每一層都能單獨測：
 *   * `detectAlerts`  —— 純讀取（SELECT 而已），算出「現在有哪些問題」。不寫 DB。
 *   * `recordAlerts`  —— upsert：同一個 (kind, portfolio) 的未解決警示只有一列，再次偵測到只累加
 *                        `occurrences` 與 `last_seen_at`。不這樣做的話每 60 秒一列，那不是告警是噪音。
 *   * `resolveAlerts` —— 這一輪**沒偵測到**的未解決警示 → 填 `resolved_at`（不刪列：已解決的列是
 *                        「曾經發生過、什麼時候好的」的唯一證據）。
 *
 * ⚠ 呼叫端（排程器）必須把整個流程包在 try/catch 裡：告警是輔助，不是主要流程。偵測失敗只該印一行，
 * 不該讓那一輪的再平衡結果被丟掉。
 */

/** DB 的最小介面：只要 `{ rows }`。`db.query` 與 `scheduler.ts` 的 `SchedulerQueryFn` 都接得上。 */
export type QueryFn = (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

/**
 * 告警種類的**唯一來源**：型別從這個陣列推導，執行期的白名單也用它。
 *
 * 兩者分開寫過一次，代價是：新增 `portfolio_stuck` 時只加了型別與 DB 的 CHECK，忘了改
 * `asKind` 的執行期判斷 → 一有 stuck 告警，`--alerts` 就拋錯、`/health` 的 alerts 變 null。
 * 也就是說**監控會在「真的有東西要看」的那一刻瞎掉**。用 `typeof ALERT_KINDS[number]` 讓它不可能再分岔。
 */
export const ALERT_KINDS = [
  'portfolio_repeatedly_failing',
  'session_key_expiring',
  'gas_low',
  'portfolio_stuck',
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertSeverity = 'warn' | 'critical';

export type AlertFinding = {
  kind: AlertKind;
  severity: AlertSeverity;
  /** `null` = 與 portfolio 無關的告警（目前三個種類都帶 portfolio，這欄保留給未來）。 */
  portfolioId: number | null;
  /** 人類可讀的一句話（繁中）。排程器的 stdout 與 `--alerts` 都**原樣**印它。 */
  detail: string;
};

/** 未解決警示的一列（`GET /health` 的計數與 `--alerts` 的清單都來自它）。 */
export type OpenAlert = {
  kind: AlertKind;
  severity: AlertSeverity;
  portfolioId: number | null;
  detail: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

/** `/health` 的回應要的計數。`open = critical + warn`（非 critical 一律是 warn，CHECK 綁死兩個值）。 */
export type AlertCounts = { critical: number; warn: number; open: number };

/** 三個閾值，全部從 env 讀（見 `loadAlertThresholds`）。 */
export type AlertThresholds = {
  /** 最近幾筆 operation 全部不是 `confirmed` 才算「連續失敗」。 */
  failingOps: number;
  /** 剩幾天內到期的 active session key 要告警。 */
  keyExpiryDays: number;
  /** smart account 的 BNB 只剩不到幾次操作的 gas 就告警。 */
  minOps: number;
  /** 最新快照仍 `needs_rebalance` 而且已經超過幾小時沒有成功執行就告警（D-25 的「等」沒有終點）。 */
  stuckHours: number;
};

/** 與 `ALERT_*` 沒設時的行為逐字對應（測試釘住它們，改預設值要有意識）。 */
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = { failingOps: 3, keyExpiryDays: 30, minOps: 10, stuckHours: 6 };

/**
 * session key 剩不到這麼多天 → `critical`（否則 `warn`）。
 *
 * 7 天不是憑感覺：續期要走一筆鏈上交易（`scripts/renew-session-key.ts`），需要有人簽、有人盯，
 * 一天內跑不完；而 key 一過期，這個 portfolio 的每一輪都會 blocked，且**不會自己好**。
 */
export const KEY_CRITICAL_DAYS = 7;

const DAY_MS = 86_400_000;

/** `detail` 裡錯誤訊息的長度上限：一行 log 要看得完，完整的訊息在 `operations.last_error`。 */
const MAX_ERROR_CHARS = 120;

// ---------------------------------------------------------------------------
// 閾值（env）
// ---------------------------------------------------------------------------

/**
 * `ALERT_FAILING_OPS` / `ALERT_KEY_EXPIRY_DAYS` / `ALERT_MIN_OPS`。
 *
 * 格式錯誤時**拋錯**而不是悄悄用預設值：一個打錯的 `ALERT_MIN_OPS=1O` 若被當成 10，告警會用一個
 * 沒人指定的門檻運作，而且看起來一切正常。排程器把偵測包在 try/catch 裡（印 `[ALERT] 偵測失敗`），
 * 所以這裡拋錯不會讓那一輪的再平衡結果消失。
 */
export function loadAlertThresholds(env: NodeJS.ProcessEnv = process.env): AlertThresholds {
  return {
    failingOps: positiveInteger(env, 'ALERT_FAILING_OPS', DEFAULT_ALERT_THRESHOLDS.failingOps),
    keyExpiryDays: positiveInteger(env, 'ALERT_KEY_EXPIRY_DAYS', DEFAULT_ALERT_THRESHOLDS.keyExpiryDays),
    minOps: positiveInteger(env, 'ALERT_MIN_OPS', DEFAULT_ALERT_THRESHOLDS.minOps),
    stuckHours: positiveInteger(env, 'ALERT_STUCK_HOURS', DEFAULT_ALERT_THRESHOLDS.stuckHours),
  };
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必須是 >= 1 的整數，收到 "${raw}"`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 偵測（純讀取，不寫 DB）
// ---------------------------------------------------------------------------

/**
 * 全部規則跑一遍。順序固定（連續失敗 → key 到期 → gas 不足），讓 stdout 與 `--alerts` 的輸出穩定。
 *
 * `readNativeBalance` / `readGasPrice` 是**測試用的接縫**：省略就是讀鏈（`chain.ts`）。生產路徑不需要
 * 傳它們；`gas_low` 的測試若沒有這兩個接縫，就只能靠「剛好有一條真的鏈」——那種測試遲早會紅。
 */
export async function detectAlerts(
  query: QueryFn,
  args: {
    now?: Date;
    env?: NodeJS.ProcessEnv;
    readNativeBalance?: (address: Address) => Promise<bigint>;
    readGasPrice?: () => Promise<bigint>;
  } = {},
): Promise<AlertFinding[]> {
  const now = args.now ?? new Date();
  const env = args.env ?? process.env;
  const thresholds = loadAlertThresholds(env);

  return [
    ...(await detectPortfolioFailures(query, thresholds.failingOps)),
    ...(await detectSessionKeyExpiry(query, { now, expiryDays: thresholds.keyExpiryDays })),
    ...(await detectLowGas(query, {
      chainId: chainIdFromEnv(env),
      minOps: thresholds.minOps,
      readNativeBalance: args.readNativeBalance ?? getAccountGasBalance,
      readGasPrice: args.readGasPrice ?? getGasPriceWei,
    })),
    // 卡住：最新快照仍 needs_rebalance 而太久沒有成功執行。放最後是因為它與前三個都不同源
    // （前三個看 operations / session_keys / 鏈上餘額，這個看快照）。
    ...(await detectPortfolioStuck(query, thresholds.stuckHours)),
  ];
}

/**
 * 規則 1：某個 portfolio 的**最近 N 筆** operation 全部不是 `confirmed`。
 *
 * 為什麼看「最近 N 筆」而不是「過去 N 小時內有幾筆失敗」：排程器自己就是那個寫入者，它的節奏是
 * 間隔驅動的（一天一輪、或跟進的 30 分鐘一輪）。用時間窗會讓「一天一輪的 portfolio 連續失敗 3 天」
 * 與「一分鐘一輪的 portfolio 連續失敗 3 次」長得一樣。用**筆數**才是「它試了 N 次、N 次都沒成」。
 *
 * `N >= 筆數` 是條件的一部分：只有 2 筆 operation 的 portfolio 不會因為「2 筆都失敗」就被報成
 * critical（太少樣本）。查詢用 `having count(*) >= $1` 表達這件事。
 */
export async function detectPortfolioFailures(query: QueryFn, failingOps: number): Promise<AlertFinding[]> {
  const { rows } = await query(SQL_FAILING_TAIL, [failingOps]);

  return rows.map((row) => {
    const fields = row as Record<string, unknown>;
    const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
    const failedCount = toInteger(fields.failed_count, 'failed_count');
    const state = typeof fields.last_state === 'string' ? fields.last_state : '(unknown)';
    const error = typeof fields.last_error === 'string' ? truncate(fields.last_error, MAX_ERROR_CHARS) : '(no error message)';
    return {
      kind: 'portfolio_repeatedly_failing',
      severity: 'critical',
      portfolioId,
      detail: `portfolio ${portfolioId}: ${failedCount} consecutive operations did not succeed (last one ${state}: ${error})`,
    } satisfies AlertFinding;
  });
}

/**
 * 規則 4：**卡住**。最新一張快照仍 `needs_rebalance`，而且已經超過 N 小時沒有成功執行。
 *
 * 為什麼用快照而不是計數器：成功的執行會寫一張 `after` 快照，所以「最新快照仍需要再平衡而且很舊」
 * 就等於「這段時間內一次都沒成功動過，而上一次觀測說它還需要動」。不需要新的欄位，也不會因為
 * 重啟／`kill -9` 而歸零（記憶體裡的計數器就有那個問題）。
 *
 * 這個告警蓋到兩種對人來說一樣的狀況：**排程器一直 noop**（例如現貨偏離 TWAP 讓 impact 預算
 * 做不了事）與**排程器根本沒在跑**。
 */
export async function detectPortfolioStuck(query: QueryFn, stuckHours: number): Promise<AlertFinding[]> {
  const { rows } = await query(SQL_STUCK, [stuckHours]);

  return rows.map((row) => {
    const fields = row as Record<string, unknown>;
    const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
    const hours = Number(fields.hours_since);
    const drift = toInteger(fields.gross_drift_bps, 'gross_drift_bps');
    // 一天沒進展不是「今天運氣不好」：24 小時是「需要有人去看」的門檻。
    const severity: AlertSeverity = Number.isFinite(hours) && hours >= 24 ? 'critical' : 'warn';
    return {
      kind: 'portfolio_stuck',
      severity,
      portfolioId,
      detail:
        `portfolio ${portfolioId}: last observation showed ${drift} bps drift (still above the threshold) ` +
        `${Number.isFinite(hours) ? hours.toFixed(1) : '?'} hours ago, with no successful execution since — ` +
        'the market may be making the impact budget unusable (see `GET /portfolios/:id/plan`), or the scheduler is not running',
    } satisfies AlertFinding;
  });
}

const SQL_STUCK = `
  with latest as (
    select distinct on (portfolio_id) portfolio_id, created_at, needs_rebalance, gross_drift_bps
      from portfolio_snapshots
     order by portfolio_id, created_at desc
  )
  select l.portfolio_id,
         l.gross_drift_bps,
         extract(epoch from (now() - l.created_at)) / 3600.0 as hours_since
    from latest l
    join portfolios p on p.id = l.portfolio_id
   where p.schedule_state = 'active'
     and l.needs_rebalance
     and l.created_at < now() - make_interval(hours => $1::int)
   order by l.created_at asc
`;

/**
 * 規則 2：`status='active'` 且 `expires_at` 在 N 天內的 session key。剩不到 7 天 → `critical`。
 *
 * `portfolioId` **一定要填**：同一帳戶可以有多把 key（本專案的 portfolio 5 就有四把），不帶 portfolio
 * 的警示會讓收到的人不知道該續哪一把。但也因為「一個 portfolio、一把 key」的鍵是 (kind, portfolio)，
 * **同一個 portfolio 的多把 key 會被收斂成一列**（`scheduler_alerts_open_uniq` 的定義）。所以這裡在
 * 偵測端就先依 portfolio 分組、把「幾把、最早哪一把」寫進同一句 detail —— 否則後面的 upsert 會讓
 * 4 把只剩最後寫入的那 1 把，而「還有 3 把也在到期」這件事就在去重的同時被丟掉了。
 *
 * 已經過期的 active key（`expires_at < now`）也算在內並給 `critical`：那代表「DB 說它還活著、其實
 * 已經不能用了」，比快到期更該被看見（排程器會 blocked，而且不會自己好）。
 *
 * ⚠ 視窗（`expiryDays`，來自 `ALERT_KEY_EXPIRY_DAYS`，預設 30）在 detail 裡一定要標成**「門檻」**：
 * 它是設定值，不是「還剩幾天」。一個沒有標記的數字會被讀成「這把 key 400 天內就要到期了」，接著與
 * 預設的 30 天對不上、看起來像 bug（實測踩過：`ALERT_KEY_EXPIRY_DAYS=400` 的一次偵測，輸出被讀成
 * 「門檻 30 卻報 400」）。篩選用的 horizon 與 detail 印的數字是**同一個變數**，兩者不可能不一致；
 * 真的對不上只有一種原因 —— 環境變數覆寫了門檻。
 */
export async function detectSessionKeyExpiry(
  query: QueryFn,
  args: { now: Date; expiryDays: number },
): Promise<AlertFinding[]> {
  const horizon = new Date(args.now.getTime() + args.expiryDays * DAY_MS);
  const { rows } = await query(SQL_EXPIRING_KEYS, [horizon.toISOString()]);

  // 依 portfolio 分組（SQL 已按 expires_at 排序，所以每一組的第一筆就是最早到期的那把）。
  const byPortfolio = new Map<number, { label: string; remainingMs: number; expiresAt: Date }[]>();
  for (const row of rows) {
    const fields = row as Record<string, unknown>;
    const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
    const permissionId = typeof fields.permission_id === 'string' && fields.permission_id !== '' ? fields.permission_id : null;
    const keyRef = typeof fields.key_ref === 'string' ? fields.key_ref : '';
    const expiresAt = toDate(fields.expires_at, 'expires_at');
    const entry = {
      label: permissionId ?? (keyRef === '' ? '(未知 session key)' : keyRef),
      remainingMs: expiresAt.getTime() - args.now.getTime(),
      expiresAt,
    };
    const group = byPortfolio.get(portfolioId);
    if (group === undefined) byPortfolio.set(portfolioId, [entry]);
    else group.push(entry);
  }

  return [...byPortfolio].map(([portfolioId, keys]) => {
    // 最早到期的那一把決定嚴重度與措辭：其餘的都在它之後，不會有更急的。
    const [earliest] = keys;
    const remainingMs = earliest?.remainingMs ?? 0;
    const severity: AlertSeverity = remainingMs < KEY_CRITICAL_DAYS * DAY_MS ? 'critical' : 'warn';

    const when =
      remainingMs <= 0
        ? `has already expired (expires_at ${earliest?.expiresAt.toISOString()})`
        : Math.floor(remainingMs / DAY_MS) < 1
          ? 'expires in less than a day'
          : `expires in ${Math.floor(remainingMs / DAY_MS)} day(s)`;

    const detail =
      keys.length === 1
        ? `portfolio ${portfolioId}: session key ${earliest?.label} ${when}`
        : `portfolio ${portfolioId}: all ${keys.length} session keys expire within the ${args.expiryDays} day threshold (earliest ${earliest?.label} ${when})`;

    return { kind: 'session_key_expiring', severity, portfolioId, detail } satisfies AlertFinding;
  });
}

/**
 * 規則 3：smart account 的 BNB 不夠再跑 N 次 op。
 *
 * **嚴重度看「這個 portfolio 有沒有成功執行過」**，不是只看餘額：
 *   * 有過至少一筆 `confirmed` operation → `critical`：這是**回歸**。它本來跑得動、現在沒錢了，
 *     而且不會自己好（下一輪會 blocked）。detail 一定帶「上次成功執行是 …」—— 那是人看到之後
 *     最想知道的第一件事。
 *   * 沒有任何 `confirmed` → `warn`：「還沒開始運作」與「突然缺 gas」都缺 gas，但只有後者是事件。
 *     全部報成 critical 的實際後果是 6 個從沒持倉的空測試 portfolio 讓 `GET /health` **永遠**
 *     degraded —— 而一個永遠 degraded 的健康檢查等於沒有健康檢查（所有人學會忽略它）。
 *
 * 重用 `funding.ts` 的計算（`perOperationCostWei` = `OPS_GAS_PER_OPERATION × gasPrice`），**沒有改它**：
 * 那個模組已經回答了「一次 op 多少 wei」與「餘額還能跑幾次」，告警只是把同一個答案套上門檻。
 *
 * ⚠ 讀鏈失敗（RPC 掛、逾時）**不產生告警**：那會是假警報 —— 「查不到餘額」與「餘額不夠」在
 * 告警面板上看起來一模一樣，而假 critical 會讓人開始忽略真的 critical。gas price 拿不到就整個
 * 規則跳過，單一帳戶讀失敗就跳過那一戶（其餘照報）。被跳過的戶數由呼叫端從 console 看得出來
 * （偵測本身回空陣列，不可區分「沒有問題」與「讀不到」，所以這裡在 `detail` 之外不另做狀態）。
 */
export async function detectLowGas(
  query: QueryFn,
  args: {
    chainId: number;
    minOps: number;
    readNativeBalance: (address: Address) => Promise<bigint>;
    readGasPrice: () => Promise<bigint>;
  },
): Promise<AlertFinding[]> {
  const { rows } = await query(SQL_SMART_ACCOUNTS, [args.chainId]);
  if (rows.length === 0) return [];

  let gasPriceWei: bigint;
  try {
    gasPriceWei = await args.readGasPrice();
  } catch {
    return [];
  }

  const costPerOp = perOperationCostWei(gasPriceWei);
  // gas price 0（查詢失敗／鏈沒設）→ 估不出次數。除以零會拋，猜一個數字會變成假告警，所以跳過。
  if (costPerOp === 0n) return [];

  const findings: AlertFinding[] = [];
  for (const row of rows) {
    const fields = row as Record<string, unknown>;
    const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
    const address = asAddress(fields.address, 'smart_accounts.address');

    let balanceWei: bigint;
    try {
      balanceWei = await args.readNativeBalance(address);
    } catch {
      continue;
    }

    const estimatedOps = balanceWei / costPerOp;
    if (estimatedOps >= BigInt(args.minOps)) continue;

    // 「有過成功紀錄」是 severity 的分界（見上方函式註解）。沒帶這兩欄的呼叫端（stub）視為沒有紀錄，
    // 也就是 warn —— 缺資料時選比較不吵的那一邊。
    const confirmedCount = fields.confirmed_count === undefined ? 0 : toInteger(fields.confirmed_count, 'confirmed_count');
    const lastConfirmedAt =
      fields.last_confirmed_at === null || fields.last_confirmed_at === undefined
        ? null
        : toDate(fields.last_confirmed_at, 'last_confirmed_at');
    // 一個變數同時決定 severity 與 detail：兩者不可能說出互相矛盾的話。
    const lastSuccessfulRun = confirmedCount > 0 && lastConfirmedAt !== null ? lastConfirmedAt : null;

    findings.push({
      kind: 'gas_low',
      severity: lastSuccessfulRun === null ? 'warn' : 'critical',
      portfolioId,
      detail:
        `portfolio ${portfolioId}: smart account ${address} has gas left for only ${estimatedOps} operation(s)` +
        ` (threshold ${args.minOps}; balance ${balanceWei} wei, gas price ${gasPriceWei} wei)` +
        (lastSuccessfulRun === null
          ? ' — this portfolio has no successful execution on record; it may not be running yet'
          : ` — last successful execution was ${alertClock(lastSuccessfulRun)}`),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 寫入：upsert / resolve
// ---------------------------------------------------------------------------

/**
 * 寫入這一輪的 findings：已存在未解決的 → `occurrences + 1`、更新 `detail` 與 `last_seen_at`；
 * 否則新增一列。
 *
 * 去重靠 `0013` 的部分唯一索引 `(kind, coalesce(portfolio_id, -1)) where resolved_at is null`，
 * 所以 ON CONFLICT **必須把那個運算式與 WHERE 逐字寫出來**（Postgres 用它來推斷索引，寫錯就變成
 * 「找不到能推斷的索引」而不是「去重失效」）。
 *
 * 一筆一條 INSERT 是刻意的：findings 的數量是「有幾個 portfolio 出問題」，正常情況是個位數，
 * 而可讀性換得的是「哪一條失敗了」一眼看得出來。
 */
export async function recordAlerts(
  query: QueryFn,
  findings: readonly AlertFinding[],
  now: Date = new Date(),
): Promise<void> {
  const seenAt = now.toISOString();
  for (const finding of findings) {
    await query(SQL_RECORD_ALERT, [finding.kind, finding.severity, finding.portfolioId, finding.detail, seenAt]);
  }
}

/**
 * 把**這一輪沒偵測到**的未解決警示標成 resolved，回傳解除了幾筆。
 *
 * 「沒偵測到」= 不在 `present` 裡。所以呼叫端要傳**這一輪的完整 findings**（不是差集）；傳空陣列
 * 等於「現在什麼問題都沒有」，所有未解決的都會被解除 —— 那正是 `--alerts` 之後看到空清單的條件。
 * 用 (kind, portfolio) 當鍵而不是 id：警示的 id 是 DB 給的，呼叫端不該需要先記住它。
 */
export async function resolveAlerts(
  query: QueryFn,
  present: readonly AlertFinding[],
  now: Date = new Date(),
): Promise<number> {
  const keys = present.map((finding) => alertKey(finding.kind, finding.portfolioId));
  // `returning id` 只是為了數「解除了幾筆」；QueryFn 的形狀（只要 rows）不因此變複雜。
  const { rows } = await query(SQL_RESOLVE_ALERTS, [now.toISOString(), keys]);
  return rows.length;
}

/** 目前未解決的警示，critical 先、再按最後看到的時間新到舊。給 `/health` 與 `--alerts` 用。 */
export async function listOpenAlerts(query: QueryFn): Promise<OpenAlert[]> {
  const { rows } = await query(SQL_OPEN_ALERTS, []);

  return rows.map((row) => {
    const fields = row as Record<string, unknown>;
    return {
      kind: asKind(fields.kind),
      severity: asSeverity(fields.severity),
      portfolioId: fields.portfolio_id === null || fields.portfolio_id === undefined ? null : toInteger(fields.portfolio_id, 'portfolio_id'),
      detail: typeof fields.detail === 'string' ? fields.detail : '',
      occurrences: toInteger(fields.occurrences, 'occurrences'),
      firstSeenAt: toDate(fields.first_seen_at, 'first_seen_at'),
      lastSeenAt: toDate(fields.last_seen_at, 'last_seen_at'),
    } satisfies OpenAlert;
  });
}

// ---------------------------------------------------------------------------
// 輸出：/health 的計數與 stdout 的一行
// ---------------------------------------------------------------------------

/** 未解決警示 → `{ critical, warn, open }`。純函式，`/health` 與測試共用同一份定義。 */
export function alertCounts(alerts: readonly { severity: AlertSeverity }[]): AlertCounts {
  let critical = 0;
  let warn = 0;
  for (const alert of alerts) {
    if (alert.severity === 'critical') critical += 1;
    else warn += 1;
  }
  return { critical, warn, open: critical + warn };
}

/**
 * `/health` 的 `status`。
 *
 * * Postgres 掛掉 → `degraded`（呼叫端此時回 503）。
 * * 有 critical 未解決 → `degraded`，**HTTP 仍是 200**：服務還活著，只是需要人看。把 503 也用在這
 *   裡會讓負載平衡器把一個能服務的實例下線 —— 那會讓一個「該看一下」變成一次「服務中斷」。
 * * 警示讀不到（`null`）→ 不影響 status：health 不該因為告警表壞掉而掛，那只會讓真正的問題更難查。
 */
export function healthStatusFor(db: 'ok' | 'down', alerts: AlertCounts | null): 'ok' | 'degraded' {
  if (db !== 'ok') return 'degraded';
  if (alerts !== null && alerts.critical > 0) return 'degraded';
  return 'ok';
}

/**
 * 一行 stdout：`[ALERT][critical] portfolio 305 連續 3 筆操作沒有成功（…）`。
 *
 * 前綴寬度固定（`[ALERT][warn]` 補到 critical 的寬度），所以連續幾行看下去是對齊的 —— 一眼看得出
 * 嚴重程度，不必逐字讀。`detail` 原樣接在後面，讓 stdout 與 `--alerts`、DB 裡的 `detail` 逐字相同。
 */
export function formatAlert(finding: AlertFinding): string {
  return `${`[ALERT][${finding.severity}]`.padEnd(ALERT_PREFIX_WIDTH, ' ')} ${finding.detail}`;
}

/** `formatAlert` 補齊用的寬度：`[ALERT][critical]` 的長度。 */
const ALERT_PREFIX_WIDTH = '[ALERT][critical]'.length;

/**
 * detail 裡的時間：UTC、到分鐘（`2026-11-07T15:33Z`）。
 *
 * 秒與毫秒對「上次成功是什麼時候」沒有資訊，卻讓一行 log 多 8 個字；而 `Z` 留著是刻意的 ——
 * 沒有時區的時間在跨機器對帳時會被讀錯。
 */
function alertClock(at: Date): string {
  return `${at.toISOString().slice(0, 16)}Z`;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * 每個 portfolio 最近 `$1` 筆 operation，全部不是 confirmed → 一列。
 *
 * `row_number() over (partition by portfolio_id order by id desc)`：`id` 是 bigserial，所以「最近」就是
 * `id desc`（不受時鐘偏移影響；`created_at` 是 transaction 時間，同一個 transaction 裡的多列會相同）。
 * `array_agg(... order by rn)[1]` 取最近那一筆的 state 與 last_error 給 detail 用。
 */
const SQL_FAILING_TAIL = `
  with ranked as (
    select o.portfolio_id as portfolio_id,
           o.state        as state,
           o.last_error   as last_error,
           row_number() over (partition by o.portfolio_id order by o.id desc) as rn
      from operations o
  )
  select portfolio_id,
         count(*)::int                       as failed_count,
         (array_agg(state      order by rn))[1] as last_state,
         (array_agg(last_error order by rn))[1] as last_error
    from ranked
   where rn <= $1
   group by portfolio_id
  having count(*) >= $1 and bool_and(state <> 'confirmed')
   order by portfolio_id
`;

/**
 * 到期時間早於 `$1`（= now + N 天）的 active session key。
 *
 * 刻意**沒有下界**：已經過期的 active key 是最該被看見的一種（DB 說它活著、其實不能用），
 * 由呼叫端依 `expires_at` 給 critical。
 */
const SQL_EXPIRING_KEYS = `
  select k.portfolio_id                    as portfolio_id,
         k.key_ref                         as key_ref,
         k.permissions ->> 'permissionId'    as permission_id,
         k.expires_at                      as expires_at
    from session_keys k
   where k.status = 'active'
     and k.expires_at <= $1
   order by k.expires_at asc, k.portfolio_id
`;

/**
 * 這一條鏈上、屬於 active portfolio 的 smart account（暫停的 portfolio 不該製造 gas 告警），
 * 附上「它有沒有成功執行過」：`confirmed` 的筆數與**最後一次的時間**。
 *
 * `cross join lateral` 的聚合子查詢在沒有 group by 時**一定回一列**（0 筆 confirmed 就是 `0` / `null`），
 * 所以沒有成功紀錄的 portfolio 不會被 join 掉 —— 那正是要用 warn 報出來的那一群。
 * `operations_portfolio_state_idx (portfolio_id, state)` 讓這一戶一查是索引查找，不是全表掃描。
 */
const SQL_SMART_ACCOUNTS = `
  select sa.portfolio_id      as portfolio_id,
         sa.address           as address,
         h.confirmed_count     as confirmed_count,
         h.last_confirmed_at   as last_confirmed_at
    from smart_accounts sa
    join portfolios p on p.id = sa.portfolio_id
    cross join lateral (
      select count(*)::int     as confirmed_count,
             max(o.created_at) as last_confirmed_at
        from operations o
       where o.portfolio_id = sa.portfolio_id
         and o.state = 'confirmed'
    ) h
   where sa.chain_id = $1
     and p.schedule_state = 'active'
   order by sa.portfolio_id
`;

/** upsert。`on conflict` 的目標運算式與 WHERE 必須與 `scheduler_alerts_open_uniq` 逐字相同。 */
const SQL_RECORD_ALERT = `
  insert into scheduler_alerts as a
         (kind, severity, portfolio_id, detail, occurrences, first_seen_at, last_seen_at)
  values ($1, $2, $3, $4, 1, $5, $5)
  on conflict (kind, (coalesce(portfolio_id, -1))) where resolved_at is null
  do update set severity     = excluded.severity,
                detail       = excluded.detail,
                occurrences  = a.occurrences + 1,
                last_seen_at = excluded.last_seen_at
`;

/** 「不在這一輪的 findings 裡」→ resolved。`empty` 陣列 = 全部解除（`<> all('{}')` 恆真）。 */
const SQL_RESOLVE_ALERTS = `
  update scheduler_alerts
     set resolved_at = $1
   where resolved_at is null
     and (kind || ':' || coalesce(portfolio_id, -1)::text) <> all($2::text[])
  returning id
`;

/** critical 先、再按最後看到的時間新到舊：`/health` 的計數與 `--alerts` 的清單都用這個順序。 */
const SQL_OPEN_ALERTS = `
  select kind, severity, portfolio_id, detail, occurrences, first_seen_at, last_seen_at
    from scheduler_alerts
   where resolved_at is null
   order by case severity when 'critical' then 0 else 1 end, last_seen_at desc, id desc
`;

// ---------------------------------------------------------------------------
// 內部小工具（pg 的 bigint 是字串、timestamptz 是 Date）
// ---------------------------------------------------------------------------

/** `scheduler_alerts` 的 (kind, portfolio) 鍵：與 SQL 裡的 `kind || ':' || coalesce(portfolio_id,-1)` 相同。 */
function alertKey(kind: AlertKind, portfolioId: number | null): string {
  return `${kind}:${portfolioId ?? -1}`;
}

/** pg 對 `bigint`／`count(*)::bigint` 回字串；數字也接受（stub DB 直接回 number）。 */
function toInteger(value: unknown, what: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed)) throw new Error(`${what} 不是整數（收到 ${JSON.stringify(value)}）`);
  return parsed;
}

function toDate(value: unknown, what: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error(`${what} 不是時間（收到 ${JSON.stringify(value)}）`);
}

function asAddress(value: unknown, what: string): Address {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) return value as Address;
  throw new Error(`${what} 不是地址（收到 ${JSON.stringify(value)}）`);
}

function asSeverity(value: unknown): AlertSeverity {
  if (value === 'warn' || value === 'critical') return value;
  throw new Error(`scheduler_alerts.severity 不是 warn/critical（收到 ${JSON.stringify(value)}）`);
}

function asKind(value: unknown): AlertKind {
  if (typeof value === 'string' && (ALERT_KINDS as readonly string[]).includes(value)) return value as AlertKind;
  throw new Error(
    `scheduler_alerts.kind 不是已知種類（收到 ${JSON.stringify(value)}；已知：${ALERT_KINDS.join(', ')}）`,
  );
}

/** 鏈 id：與 config.ts 同一個預設（56），但不必為了讀 env 而要求 DATABASE_URL。 */
function chainIdFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.CHAIN_ID?.trim();
  if (raw === undefined || raw === '') return DEFAULT_CHAIN_ID;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`CHAIN_ID 必須是 >= 1 的整數，收到 "${raw}"`);
  }
  return value;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
