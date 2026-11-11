import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, query as dbQuery, withTransaction } from '../src/db.js';
import {
  DEFAULT_ALERT_THRESHOLDS,
  alertCounts,
  detectAlerts,
  detectLowGas,
  detectPortfolioFailures,
  detectSessionKeyExpiry,
  formatAlert,
  healthStatusFor,
  listOpenAlerts,
  loadAlertThresholds,
  recordAlerts,
  resolveAlerts,
  detectPortfolioStuck,
  ALERT_KINDS,
} from '../src/alerts.js';
import type { AlertFinding, QueryFn } from '../src/alerts.js';
import { OPS_GAS_PER_OPERATION, perOperationCostWei } from '../src/funding.js';
import { announceAlerts, runSchedulerOnce } from '../src/scheduler.js';
import type { SchedulerQueryFn } from '../src/scheduler.js';
import type { Address } from 'viem';

/**
 * 告警的測試。三件事要證明，而且是分開證明的：
 *
 *   ① **偵測規則本身對不對**（含「沒有問題時不產生警示」——只測「會警示」等於在測一個永遠叫的鬧鐘）；
 *   ② **去重**：同一個 (kind, portfolio) 連跑兩次是一列、`occurrences = 2`，不是兩列；
 *   ③ **條件消失 → 自動 resolve**，而且 alarm 的失敗不會讓排程器那一輪失敗。
 *
 * 前 12 組是 stub DB（不碰鏈、不碰真 DB）：gas 那條規則的鏈上讀取用注入的接縫，否則這支測試會
 * 依賴「剛好有一條活著的鏈」。最後一組對**真的 Postgres** 驗 SQL 與約束 —— stub 證明不了
 * `on conflict` 推不推斷得到那個**運算式**的部分唯一索引。真 DB 不可用時它明確 skip（不是靜默 pass）。
 */

// ---------------------------------------------------------------------------
// 固定資料
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-07T12:00:00.000Z');
const DAY_MS = 86_400_000;
const PORTFOLIO_ID = 305;
const OTHER_PORTFOLIO_ID = 5;
const PERMISSION_ID = '0xf67556bf';
const KEY_REF = "m/44'/60'/0'/0/586250657";
const SMART_ACCOUNT = '0xb008dcffa89000f8ad7c3af9ddf320bdbb7b1de5' as Address;
const GAS_PRICE_WEI = 1_220_000_000n; // 1.22 gwei（docs/pitfalls §3.10 的實測值）
const COST_PER_OP = OPS_GAS_PER_OPERATION * GAS_PRICE_WEI;
const LAST_ERROR = 'An error occurred while executing user operation: HTTP request failed';

function finding(overrides: Partial<AlertFinding> = {}): AlertFinding {
  return {
    kind: 'portfolio_repeatedly_failing',
    severity: 'critical',
    portfolioId: PORTFOLIO_ID,
    detail: 'portfolio 305: 3 consecutive operations did not succeed (last one failed: HTTP request failed)',
    ...overrides,
  };
}

type Seen = { sql: string; params: readonly unknown[] };

/** 依 SQL 內容回列；順便把每一條 SQL 記下來（斷言要看 WHERE／ON CONFLICT 的原文）。 */
function stubQuery(
  handler: (sql: string, params: readonly unknown[]) => unknown[],
): { query: QueryFn; seen: Seen[] } {
  const seen: Seen[] = [];
  const query: QueryFn = async (text: string, params: readonly unknown[] = []) => {
    seen.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
    return { rows: handler(text, params) };
  };
  return { query, seen };
}

function findSeen(seen: readonly Seen[], fragment: string): Seen {
  const hit = seen.find((entry) => entry.sql.includes(fragment));
  assert.ok(hit !== undefined, `沒有發出包含「${fragment}」的 SQL（收到 ${seen.length} 條）`);
  return hit;
}

// ---------------------------------------------------------------------------
// 1. 規則 1：連續失敗
// ---------------------------------------------------------------------------

test('detectPortfolioFailures：最近 N 筆全部不是 confirmed → 一筆 critical，detail 帶筆數與最後一次的錯誤', async () => {
  const { query, seen } = stubQuery(() => [
    { portfolio_id: String(PORTFOLIO_ID), failed_count: 3, last_state: 'failed', last_error: LAST_ERROR },
  ]);

  const findings = await detectPortfolioFailures(query, 3);

  assert.equal(findings.length, 1);
  const [only] = findings;
  assert.equal(only?.kind, 'portfolio_repeatedly_failing');
  assert.equal(only?.severity, 'critical');
  assert.equal(only?.portfolioId, PORTFOLIO_ID);
  assert.match(only?.detail ?? '', /^portfolio 305: 3 consecutive operations did not succeed/);
  assert.match(only?.detail ?? '', /last one failed: An error occurred while executing user operation/);

  // SQL 的形狀就是規則本身：「最近 N 筆」＝ row_number by id desc；「全部沒成功」＝ bool_and。
  const sql = findSeen(seen, 'row_number() over').sql;
  assert.match(sql, /partition by o\.portfolio_id order by o\.id desc/, '「最近」是 id desc，不是時鐘');
  assert.match(sql, /having count\(\*\) >= \$1 and bool_and\(state <> 'confirmed'\)/, '門檻與「全部不是 confirmed」都在 SQL 裡');
  assert.deepEqual(findSeen(seen, 'row_number() over').params, [3]);
});

test('detectPortfolioFailures：沒有列（沒有問題／樣本不足）→ 不產生警示', async () => {
  const { query } = stubQuery(() => []);
  assert.deepEqual(await detectPortfolioFailures(query, 3), []);
});

test('detectPortfolioFailures：last_error 太長會截斷（一行 log 要看得完），沒有錯誤訊息也有話說', async () => {
  const longError = 'x'.repeat(400);
  const { query } = stubQuery(() => [
    { portfolio_id: '7', failed_count: '4', last_state: 'reverted', last_error: longError },
    { portfolio_id: '8', failed_count: '3', last_state: 'failed', last_error: null },
  ]);

  const [long, noError] = await detectPortfolioFailures(query, 3);

  assert.ok((long?.detail.length ?? 0) < 250, `detail 應該被截斷，實際 ${long?.detail.length}`);
  assert.match(long?.detail ?? '', /…\)$/, '截斷要有省略號，不能看起來像完整的訊息');
  assert.equal((long?.detail.match(/x/g) ?? []).length, 120, '錯誤訊息最多 120 字（一行 log 要看得完）');
  assert.match(noError?.detail ?? '', /last one failed: \(no error message\)/);
  assert.equal(noError?.portfolioId, 8, 'bigint 字串要轉成數字（pg 對 bigint 回字串）');
});

// ---------------------------------------------------------------------------
// 2. 規則 2：session key 快到期
// ---------------------------------------------------------------------------

test('detectSessionKeyExpiry：30 天內到期 → warn，portfolioId 有填（同一帳戶可能有多把 key）', async () => {
  const expiresAt = new Date(NOW.getTime() + 12 * DAY_MS);
  const { query, seen } = stubQuery(() => [
    { portfolio_id: String(OTHER_PORTFOLIO_ID), key_ref: KEY_REF, permission_id: PERMISSION_ID, expires_at: expiresAt },
  ]);

  const findings = await detectSessionKeyExpiry(query, { now: NOW, expiryDays: DEFAULT_ALERT_THRESHOLDS.keyExpiryDays });

  assert.equal(findings.length, 1);
  const [only] = findings;
  assert.equal(only?.kind, 'session_key_expiring');
  assert.equal(only?.severity, 'warn', '還有 12 天 → warn，不是 critical');
  assert.equal(only?.portfolioId, OTHER_PORTFOLIO_ID, 'portfolioId 一定要有，否則收到的人不知道續哪一把');
  assert.equal(
    formatAlert(only!),
    '[ALERT][warn]     portfolio 5: session key 0xf67556bf expires in 12 day(s)',
    '這一行就是 stdout 的樣子（[ALERT][warn] 補到 critical 的寬度，所以對齊）',
  );

  const sql = findSeen(seen, 'from session_keys k').sql;
  assert.match(sql, /k\.status = 'active'/, '只看 active 的（revoked 不需要續）');
  assert.match(sql, /k\.expires_at <= \$1/, '視窗是「早於 now + N 天」，不是「等於」');
  assert.equal(findSeen(seen, 'from session_keys k').params[0], new Date(NOW.getTime() + 30 * DAY_MS).toISOString());
});

test('detectSessionKeyExpiry：剩不到 7 天 → critical', async () => {
  const expiresAt = new Date(NOW.getTime() + 3 * DAY_MS);
  const { query } = stubQuery(() => [
    { portfolio_id: String(OTHER_PORTFOLIO_ID), key_ref: KEY_REF, permission_id: PERMISSION_ID, expires_at: expiresAt },
  ]);

  const [only] = await detectSessionKeyExpiry(query, { now: NOW, expiryDays: 30 });
  assert.equal(only?.severity, 'critical');
  assert.match(only?.detail ?? '', /expires in 3 day\(s\)/);
});

test('detectSessionKeyExpiry：已經過期的 active key（DB 說活著、其實不能用）→ critical，而且說得出什麼時候過期', async () => {
  const expiresAt = new Date(NOW.getTime() - DAY_MS);
  const { query } = stubQuery(() => [
    { portfolio_id: String(OTHER_PORTFOLIO_ID), key_ref: KEY_REF, permission_id: PERMISSION_ID, expires_at: expiresAt },
  ]);

  const [only] = await detectSessionKeyExpiry(query, { now: NOW, expiryDays: 30 });
  assert.equal(only?.severity, 'critical');
  assert.match(only?.detail ?? '', /has already expired \(expires_at 2026-11-06T12:00:00\.000Z\)/);
});

test('detectSessionKeyExpiry：同一個 portfolio 的多把 key 收斂成一筆，detail 說清楚「幾把、最早哪一把」', async () => {
  // 這是真的踩到過的形狀：portfolio 5 有 4 把 active key。`scheduler_alerts_open_uniq` 的鍵是
  // (kind, portfolio_id)，若偵測端不先分組，upsert 會讓 4 把只剩最後寫入的那 1 把 ——
  // 「還有 3 把也在到期」這件事會在去重的同時被丟掉。
  const { query } = stubQuery(() => [
    { portfolio_id: String(OTHER_PORTFOLIO_ID), key_ref: KEY_REF, permission_id: '0x4ddb1075', expires_at: new Date(NOW.getTime() + 2 * DAY_MS) },
    { portfolio_id: String(OTHER_PORTFOLIO_ID), key_ref: KEY_REF, permission_id: '0xf67556bf', expires_at: new Date(NOW.getTime() + 5 * DAY_MS) },
    { portfolio_id: String(OTHER_PORTFOLIO_ID), key_ref: KEY_REF, permission_id: '0x075d78e3', expires_at: new Date(NOW.getTime() + 20 * DAY_MS) },
  ]);

  const findings = await detectSessionKeyExpiry(query, { now: NOW, expiryDays: 30 });

  assert.equal(findings.length, 1, '一個 portfolio 一筆（否則會被部分唯一索引壓成一列，資訊就無聲地少了）');
  assert.equal(findings[0]?.severity, 'critical', '最早的那把剩 2 天 → critical');
  assert.equal(
    findings[0]?.detail,
    'portfolio 5: all 3 session keys expire within the 30 day threshold (earliest 0x4ddb1075 expires in 2 day(s))',
  );
});

test('detectSessionKeyExpiry：detail 裡的數字是「門檻」不是「剩幾天」—— 363 天後才到期，預設 30 天根本偵測不到', async () => {
  // 實測踩過的讀法：一段 `ALERT_KEY_EXPIRY_DAYS=400` 的輸出「400 天內到期」被讀成
  // 「門檻寫 30 卻報 400，門檻沒生效」。篩選的 horizon 與 detail 印的數字是同一個變數，
  // 兩者不可能不一致 —— 所以那不是邏輯 bug，是那個數字沒有標明自己是門檻。
  const perms = ['0x4ddb1075', '0xf67556bf', '0x075d78e3', '0x7db20115'];
  const rows = perms.map((permissionId, index) => ({
    portfolio_id: String(OTHER_PORTFOLIO_ID),
    key_ref: KEY_REF,
    permission_id: permissionId,
    expires_at: new Date(NOW.getTime() + (363 + index) * DAY_MS),
  }));
  // stub 要自己套 horizon（真的 SQL 是 `expires_at <= $1`），否則「30 天內什麼都沒有」證明不了。
  const query = (expiryDays: number): QueryFn => {
    const horizon = new Date(NOW.getTime() + expiryDays * DAY_MS).toISOString();
    return stubQuery(() => rows.filter((row) => row.expires_at.toISOString() <= horizon)).query;
  };

  assert.deepEqual(
    await detectSessionKeyExpiry(query(30), { now: NOW, expiryDays: 30 }),
    [],
    '門檻 30 天時，363 天後才到期的 key 不該被偵測到（不該現在告警）',
  );

  const findings = await detectSessionKeyExpiry(query(400), { now: NOW, expiryDays: 400 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'warn', '還有 363 天 → warn，不是 critical');
  assert.equal(
    findings[0]?.detail,
    'portfolio 5: all 4 session keys expire within the 400 day threshold (earliest 0x4ddb1075 expires in 363 day(s))',
    'the threshold must be named as a threshold, otherwise it reads as "expires in 400 days"',
  );
});

test('detectSessionKeyExpiry：沒有快到的 key → 不產生警示', async () => {
  const { query } = stubQuery(() => []);
  assert.deepEqual(await detectSessionKeyExpiry(query, { now: NOW, expiryDays: 30 }), []);
});

// ---------------------------------------------------------------------------
// 3. 規則 3：gas 不足（重用 funding.ts 的計算；讀鏈失敗不算告警）
// ---------------------------------------------------------------------------

test('detectLowGas：沒有成功紀錄的 portfolio 缺 gas → warn（「還沒開始運作」不是緊急事件）', async () => {
  const { query, seen } = stubQuery(() => [
    { portfolio_id: String(PORTFOLIO_ID), address: SMART_ACCOUNT, confirmed_count: 0, last_confirmed_at: null },
  ]);

  const findings = await detectLowGas(query, {
    chainId: 56,
    minOps: 10,
    readGasPrice: async () => GAS_PRICE_WEI,
    readNativeBalance: async () => COST_PER_OP * 9n, // 剛好 9 次
  });

  assert.equal(findings.length, 1);
  const [only] = findings;
  assert.equal(only?.kind, 'gas_low');
  assert.equal(
    only?.severity,
    'warn',
    '從沒成功執行過 → warn：空的測試 portfolio 不該讓 /health 永遠 degraded（那等於沒有健康檢查）',
  );
  assert.equal(only?.portfolioId, PORTFOLIO_ID);
  assert.equal(
    only?.detail,
    `portfolio 305: smart account ${SMART_ACCOUNT} has gas left for only 9 operation(s)` +
      ` (threshold 10; balance ${COST_PER_OP * 9n} wei, gas price ${GAS_PRICE_WEI} wei)` +
      ' — this portfolio has no successful execution on record; it may not be running yet',
  );
  assert.equal(COST_PER_OP, perOperationCostWei(GAS_PRICE_WEI), '算式必須是同一個（不是複製一份）');

  const sql = findSeen(seen, 'from smart_accounts sa').sql;
  assert.match(sql, /join portfolios p/, '暫停的 portfolio 不該製造 gas 告警');
  assert.match(sql, /p\.schedule_state = 'active'/);
  assert.match(sql, /o\.state = 'confirmed'/, '「有沒有成功過」看的是 operations 的 confirmed');
  assert.match(sql, /max\(o\.created_at\)/, 'critical 要說得出上次成功執行的時間');
  assert.match(sql, /cross join lateral/, '聚合子查詢一定回一列 —— 沒有成功紀錄的 portfolio 不能被 join 掉');
  assert.deepEqual(findSeen(seen, 'from smart_accounts sa').params, [56], '只讀這一條鏈的帳戶');
});

test('detectLowGas：有過 confirmed 卻沒 gas → critical，detail 帶上次成功執行的時間（UTC、到分鐘）', async () => {
  const { query } = stubQuery(() => [
    {
      portfolio_id: String(PORTFOLIO_ID),
      address: SMART_ACCOUNT,
      confirmed_count: 3,
      last_confirmed_at: new Date('2026-11-07T15:33:23.177Z'),
    },
  ]);

  const [only] = await detectLowGas(query, {
    chainId: 56,
    minOps: 10,
    readGasPrice: async () => GAS_PRICE_WEI,
    readNativeBalance: async () => COST_PER_OP * 3n,
  });

  assert.equal(only?.severity, 'critical', '它本來跑得動、現在沒錢了 → 這是回歸，要叫醒人');
  assert.equal(
    only?.detail,
    `portfolio 305: smart account ${SMART_ACCOUNT} has gas left for only 3 operation(s)` +
      ` (threshold 10; balance ${COST_PER_OP * 3n} wei, gas price ${GAS_PRICE_WEI} wei)` +
      ' — last successful execution was 2026-11-07T15:33Z',
    'the last successful execution time is the first thing you want after seeing a critical',
  );
});

test('detectLowGas：剛好等於門檻 → 不警示（邊界不算不足）', async () => {
  const { query } = stubQuery(() => [{ portfolio_id: String(PORTFOLIO_ID), address: SMART_ACCOUNT }]);
  const findings = await detectLowGas(query, {
    chainId: 56,
    minOps: 10,
    readGasPrice: async () => GAS_PRICE_WEI,
    readNativeBalance: async () => COST_PER_OP * 10n,
  });
  assert.deepEqual(findings, []);
});

test('detectLowGas：讀鏈失敗（RPC 掛／gas price 0）→ 一筆都不產生，因為那會是假警報', async () => {
  const rows = () => [{ portfolio_id: String(PORTFOLIO_ID), address: SMART_ACCOUNT }];

  // gas price 拿不到：整條規則跳過。
  const priceDown = await detectLowGas(stubQuery(rows).query, {
    chainId: 56,
    minOps: 10,
    readGasPrice: async () => {
      throw new Error('HTTP request failed: 403 Archive requests');
    },
    readNativeBalance: async () => 0n,
  });
  assert.deepEqual(priceDown, []);

  // gas price 是 0：估不出次數（除以零會拋，猜一個數字會變成假告警）。
  const zeroPrice = await detectLowGas(stubQuery(rows).query, {
    chainId: 56,
    minOps: 10,
    readGasPrice: async () => 0n,
    readNativeBalance: async () => 0n,
  });
  assert.deepEqual(zeroPrice, []);

  // 單一帳戶的餘額讀不到：跳過那一戶，不影響其他戶。
  const balanceDown = await detectLowGas(stubQuery(rows).query, {
    chainId: 56,
    minOps: 10,
    readGasPrice: async () => GAS_PRICE_WEI,
    readNativeBalance: async () => {
      throw new Error('timeout');
    },
  });
  assert.deepEqual(balanceDown, []);
});

// ---------------------------------------------------------------------------
// 4. detectAlerts：三條規則一起跑，閾值全部從 env
// ---------------------------------------------------------------------------

test('detectAlerts：三條規則合成一份 findings，閾值從 env 來（覆寫預設）', async () => {
  const { query, seen } = stubQuery((sql) => {
    if (sql.includes('row_number() over')) {
      return [{ portfolio_id: String(PORTFOLIO_ID), failed_count: 4, last_state: 'failed', last_error: LAST_ERROR }];
    }
    if (sql.includes('from session_keys k')) {
      return [
        {
          portfolio_id: String(OTHER_PORTFOLIO_ID),
          key_ref: KEY_REF,
          permission_id: PERMISSION_ID,
          expires_at: new Date(NOW.getTime() + 2 * DAY_MS),
        },
      ];
    }
    if (sql.includes('from smart_accounts sa')) return [{ portfolio_id: '7', address: SMART_ACCOUNT }];
    return [];
  });

  const findings = await detectAlerts(query, {
    now: NOW,
    env: { ALERT_FAILING_OPS: '4', ALERT_KEY_EXPIRY_DAYS: '14', ALERT_MIN_OPS: '3', CHAIN_ID: '56' },
    readGasPrice: async () => GAS_PRICE_WEI,
    readNativeBalance: async () => COST_PER_OP * 2n, // 2 次 < 3 次
  });

  assert.deepEqual(
    findings.map((entry) => entry.kind),
    ['portfolio_repeatedly_failing', 'session_key_expiring', 'gas_low'],
    '順序固定，stdout 才穩定',
  );
  assert.deepEqual(findSeen(seen, 'row_number() over').params, [4], 'ALERT_FAILING_OPS 覆寫了預設 3');
  assert.equal(
    findSeen(seen, 'from session_keys k').params[0],
    new Date(NOW.getTime() + 14 * DAY_MS).toISOString(),
    'ALERT_KEY_EXPIRY_DAYS 覆寫了預設 30',
  );
  const [gas] = findings.filter((entry) => entry.kind === 'gas_low');
  assert.match(gas?.detail ?? '', /threshold 3/, 'ALERT_MIN_OPS 覆寫了預設 10');
});

test('detectAlerts：env 的閾值格式錯誤 → 拋錯（打錯的門檻不能被靜默忽略）', async () => {
  const { query } = stubQuery(() => []);
  await assert.rejects(
    () => detectAlerts(query, { now: NOW, env: { ALERT_FAILING_OPS: '1O' } }),
    /ALERT_FAILING_OPS 必須是 >= 1 的整數，收到 "1O"/,
  );
  assert.deepEqual(loadAlertThresholds({}), DEFAULT_ALERT_THRESHOLDS, '沒設就是預設（3／30／10）');
});

// ---------------------------------------------------------------------------
// 5. 寫入：upsert 與 resolve
// ---------------------------------------------------------------------------

test('recordAlerts：INSERT … ON CONFLICT 的目標就是那個部分唯一索引，再次偵測到只累加 occurrences', async () => {
  const { query, seen } = stubQuery(() => []);

  await recordAlerts(query, [finding(), finding({ kind: 'gas_low', portfolioId: null, detail: 'x' })], NOW);

  const sql = findSeen(seen, 'insert into scheduler_alerts').sql;
  assert.match(sql, /on conflict \(kind, \(coalesce\(portfolio_id, -1\)\)\) where resolved_at is null/, '運算式與 WHERE 必須逐字相同，否則 Postgres 推斷不到索引');
  assert.match(sql, /occurrences = a\.occurrences \+ 1/, '再去一次是 +1，不是插第二列');
  assert.match(sql, /last_seen_at = excluded\.last_seen_at/);
  assert.match(sql, /first_seen_at/, 'first_seen_at 只寫在 INSERT，DO UPDATE 不動它（否則看不出持續多久）');

  const inserts = seen.filter((entry) => entry.sql.includes('insert into scheduler_alerts'));
  assert.equal(inserts.length, 2, '一個 finding 一條 INSERT');
  assert.equal(inserts[0]?.params[2], PORTFOLIO_ID);
  assert.equal(inserts[1]?.params[2], null, 'portfolio 無關的警示傳 null（不是 -1：-1 只是索引裡的正規化值）');
});

test('recordAlerts：沒有 findings 就一條 SQL 都不發', async () => {
  const { query, seen } = stubQuery(() => []);
  await recordAlerts(query, [], NOW);
  assert.deepEqual(seen, []);
});

test('resolveAlerts：不在這一輪 findings 裡的未解決警示 → resolved_at，回傳解除筆數', async () => {
  const { query, seen } = stubQuery(() => [{ id: '1' }, { id: '9' }]);

  const resolved = await resolveAlerts(
    query,
    [finding(), finding({ kind: 'session_key_expiring', severity: 'warn', portfolioId: OTHER_PORTFOLIO_ID })],
    NOW,
  );

  assert.equal(resolved, 2);
  const sql = findSeen(seen, 'update scheduler_alerts').sql;
  assert.match(sql, /set resolved_at = \$1/);
  assert.match(sql, /where resolved_at is null/, '已解除的不重複寫（時間不會被覆寫成後來的那次）');
  assert.match(sql, /<> all\(\$2::text\[\]\)/, '用 (kind, portfolio) 當鍵，呼叫端不必記 id');
  assert.match(sql, /returning id/);
  assert.deepEqual(findSeen(seen, 'update scheduler_alerts').params[1], [
    'portfolio_repeatedly_failing:305',
    'session_key_expiring:5',
  ]);
});

test('resolveAlerts：這一輪什麼都沒偵測到（空陣列）→ 全部解除', async () => {
  const { query, seen } = stubQuery(() => [{ id: '1' }]);
  assert.equal(await resolveAlerts(query, [], NOW), 1);
  assert.deepEqual(findSeen(seen, 'update scheduler_alerts').params[1], [], '空陣列＝現在沒有問題');
});

test('listOpenAlerts：pg 的字串／Date 會被正規化，critical 先', async () => {
  const { query, seen } = stubQuery(() => [
    {
      kind: 'gas_low',
      severity: 'critical',
      portfolio_id: '305',
      detail: 'gas 不夠',
      occurrences: '2',
      first_seen_at: new Date('2026-11-07T10:00:00.000Z'),
      last_seen_at: new Date('2026-11-07T11:00:00.000Z'),
    },
    { kind: 'session_key_expiring', severity: 'warn', portfolio_id: null, detail: '無 portfolio', occurrences: 1, first_seen_at: '2026-11-07T09:00:00.000Z', last_seen_at: '2026-11-07T09:30:00.000Z' },
  ]);

  // 用 stub 回傳的 pg 形狀（bigint 是字串、時間是 Date 或 ISO 字串）來驗正規化。
  // 不能打真 DB：那會讓斷言依賴「資料庫剛好只有這兩列」——實際上有 7 筆真實的 gas_low 告警，
  // 測試就會紅，而且紅的原因與它要驗的東西無關。真 DB 的 round-trip 由上面那條
  // 「每一種 AlertKind 都能寫進 DB 再讀回來」覆蓋。
  const open = await listOpenAlerts(query);

  assert.equal(open.length, 2);
  assert.deepEqual(
    { kind: open[0]?.kind, severity: open[0]?.severity, portfolioId: open[0]?.portfolioId, occurrences: open[0]?.occurrences },
    { kind: 'gas_low', severity: 'critical', portfolioId: 305, occurrences: 2 },
  );
  assert.equal(open[1]?.portfolioId, null);
  assert.equal(open[1]?.firstSeenAt.toISOString(), '2026-11-07T09:00:00.000Z', '字串形式的時間也要吃得下');
  assert.match(findSeen(seen, 'from scheduler_alerts').sql, /case severity when 'critical' then 0 else 1 end/);
});

// ---------------------------------------------------------------------------
// 6. /health 的形狀與 stdout 的一行
// ---------------------------------------------------------------------------

test('healthStatusFor：critical 未解決 → degraded（HTTP 仍 200）；讀不到警示不影響 status', () => {
  assert.equal(healthStatusFor('ok', { critical: 0, warn: 2, open: 2 }), 'ok');
  assert.equal(healthStatusFor('ok', { critical: 1, warn: 2, open: 3 }), 'degraded');
  assert.equal(healthStatusFor('ok', null), 'ok', '警示表壞掉不該讓 health 變 degraded');
  assert.equal(healthStatusFor('down', null), 'degraded', 'Postgres 掛掉才是 503 的理由');
  assert.deepEqual(alertCounts([{ severity: 'critical' }, { severity: 'warn' }, { severity: 'warn' }]), {
    critical: 1,
    warn: 2,
    open: 3,
  });
});

test('formatAlert：一行看得出來（嚴重度對齊，detail 原樣）', () => {
  assert.equal(
    formatAlert(finding()),
    '[ALERT][critical] portfolio 305: 3 consecutive operations did not succeed (last one failed: HTTP request failed)',
  );
  assert.equal(
    formatAlert(finding({ severity: 'warn', portfolioId: OTHER_PORTFOLIO_ID, detail: 'portfolio 5: session key 0xf67556bf expires in 12 day(s)' })),
    '[ALERT][warn]     portfolio 5: session key 0xf67556bf expires in 12 day(s)',
  );
});

// ---------------------------------------------------------------------------
// 7. 排程器尾端：印出警示，而且偵測失敗不會讓整輪失敗
// ---------------------------------------------------------------------------

/** 尾端會發的三條 SQL 都回答得了的 stub：一筆連續失敗，其餘空。 */
function alertStub(): { query: SchedulerQueryFn; seen: Seen[] } {
  const query = stubQuery((sql) => {
    if (sql.includes('row_number() over')) {
      return [{ portfolio_id: String(PORTFOLIO_ID), failed_count: 3, last_state: 'failed', last_error: 'HTTP request failed' }];
    }
    if (sql.includes('update scheduler_alerts')) return [];
    return [];
  });
  return { query: query.query as SchedulerQueryFn, seen: query.seen };
}

test('announceAlerts：一輪結束會印 [ALERT][severity] 行（acceptance 7）', async () => {
  const { query, seen } = alertStub();
  const lines: string[] = [];

  await announceAlerts({ query, log: (line) => lines.push(line), now: NOW });

  assert.equal(
    lines[0],
    '[ALERT][critical] portfolio 305: 3 consecutive operations did not succeed (last one failed: HTTP request failed)',
  );
  assert.equal(lines.length, 1, '沒有其他警示就只印這一行');
  assert.ok(seen.some((entry) => entry.sql.includes('insert into scheduler_alerts')), '偵測到就要寫進去（不只印出來）');
  assert.ok(seen.some((entry) => entry.sql.includes('update scheduler_alerts')), '同一輪也要 resolve 一次');
});

test('announceAlerts：沒有警示時明說「沒有警示」（不是什麼都不印 —— 沉默與沒跑一模一樣）', async () => {
  const { query } = stubQuery(() => []);
  const lines: string[] = [];

  await announceAlerts({ query: query as SchedulerQueryFn, log: (line) => lines.push(line), now: NOW });

  assert.deepEqual(lines, ['[ALERT] 沒有警示']);
});

test('announceAlerts：偵測失敗只印一行，不拋錯（acceptance 8）', async () => {
  const failing = (async () => {
    throw new Error('relation "scheduler_alerts" does not exist');
  }) as unknown as SchedulerQueryFn;
  const lines: string[] = [];

  await announceAlerts({ query: failing, log: (line) => lines.push(line), now: NOW });

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^\[ALERT\] 偵測失敗：relation "scheduler_alerts" does not exist/);
});

test('runSchedulerOnce：告警的 SQL 全部失敗，這一輪仍然正常結束（acceptance 8：告警不是主要流程）', async () => {
  const emptyClaim: SchedulerQueryFn = async () => ({ rows: [] });
  const failing: SchedulerQueryFn = async (text) => {
    throw new Error(`alert SQL 壞了：${text.slice(0, 20)}`);
  };
  const lines: string[] = [];

  const round = await runSchedulerOnce(
    { dryRun: true, now: NOW, limit: 5 },
    {
      // 認領用記憶體 stub（沒有到期的 portfolio），一般查詢一律失敗。
      withTransaction: (async (fn: (client: { query: SchedulerQueryFn }) => Promise<unknown>) =>
        fn({ query: emptyClaim })) as never,
      query: failing,
      chainId: 56,
      log: (line: string) => lines.push(line),
    },
  );

  assert.equal(round.claimed, 0);
  assert.deepEqual(round.results, []);
  assert.ok(
    lines.some((line) => line.startsWith('[ALERT] 偵測失敗：')),
    `這一輪應該印出偵測失敗，實際：${JSON.stringify(lines)}`,
  );
});

// ---------------------------------------------------------------------------
// 8. 真 Postgres：upsert 去重、resolve、規則 1 的 SQL
// ---------------------------------------------------------------------------

/**
 * 這一組存在的理由：stub 證明不了「Postgres 推斷得到那個**運算式**的部分唯一索引」
 * （`on conflict (kind, (coalesce(portfolio_id, -1))) where resolved_at is null`）—— 推斷不到時
 * 不是「去重失效」而是直接報錯，而 stub 永遠不會報這個錯。
 *
 * 整個流程跑在**一個會被 rollback 的 transaction** 裡：真的 Postgres 語意、零殘留。外鍵需要的
 * portfolio 也在同一個 transaction 裡造，所以不會碰到任何真實資料。
 */
async function dbReason(): Promise<string | null> {
  try {
    await dbQuery('select 1 from scheduler_alerts limit 0');
    await dbQuery('select 1 from portfolios limit 0');
    return null;
  } catch (cause) {
    return `Postgres 或 0013 不可用（${cause instanceof Error ? cause.message : String(cause)}）`;
  }
}

const dbSkip = await dbReason();
if (dbSkip !== null) console.warn(`[alerts] 真 DB 的測試 skip：${dbSkip}`);
const dbGate = dbSkip === null ? {} : { skip: dbSkip };

after(async () => {
  await closePool().catch(() => {
    // DB 不可用時整組本來就 skip 了；這裡的失敗不該蓋掉測試結果。
  });
});


/** 造一個只屬於這支測試的 portfolio（scheduler_alerts 有 FK）。沒有 strategy 就自己建一個。 */
async function seedAlertPortfolio(): Promise<number> {
  const strategy =
    (await dbQuery<{ id: string }>('select id from strategies order by id limit 1')).rows[0] ??
    (
      await dbQuery<{ id: string }>(
        `insert into strategies (provider, name) values ($1, $2) returning id`,
        ['0xalerts-test', 'alerts test fixture'],
      )
    ).rows[0];
  if (strategy === undefined) throw new Error('造不出測試用的 strategy');
  const row = (
    await dbQuery<{ id: string }>(
      `insert into portfolios (user_id, strategy_id, version, schedule_state)
       values ('0xalerts-kind-test', $1, 1, 'idle') returning id`,
      [strategy.id],
    )
  ).rows[0];
  if (row === undefined) throw new Error('造不出測試用的 portfolio');
  return Number(row.id);
}

// 回歸（實測踩到）：`AlertKind` 型別有 `portfolio_stuck`，但 `asKind` 的執行期白名單忘了加。
// 後果不是「少一則告警」——是一有 stuck 告警，`--alerts` 直接拋錯、`/health` 的 alerts 變 null，
// 也就是**監控在真的有東西要看的那一刻瞎掉**。所以型別與執行期白名單現在同一個來源（ALERT_KINDS）。
test('每一種 AlertKind 都能寫進 DB 再讀回來（型別與執行期白名單不得分岔）', dbGate, async () => {
  const portfolioId = await seedAlertPortfolio();
  try {
    for (const kind of ALERT_KINDS) {
      await dbQuery('delete from scheduler_alerts where portfolio_id = $1', [portfolioId]);
      // `portfolio_repeatedly_failing` 的 key 是 (kind, portfolio)；其餘也用同一個 portfolio，
      // 所以一輪一輪清掉再寫，避免 key 衝突蓋掉前一筆。
      await recordAlerts(dbQuery, [{ kind, severity: 'warn', portfolioId, detail: `${kind} probe` }], NOW);
      const open = await listOpenAlerts(dbQuery);
      const found = open.filter((alert) => alert.portfolioId === portfolioId && alert.kind === kind);
      assert.equal(found.length, 1, `kind ${kind} 應該寫得進去也讀得回來（讀回來失敗＝白名單漏了它）`);
    }
  } finally {
    await dbQuery('delete from scheduler_alerts where portfolio_id = $1', [portfolioId]);
  }
});

test('真 Postgres：同一個 (kind, portfolio) 連跑兩次 = 一列 occurrences 2；條件消失 → resolve', dbGate, async () => {
  await assert.rejects(
    () =>
      withTransaction(async (client) => {
        const q: QueryFn = (text: string, params: readonly unknown[] = []) => client.query(text, [...params]);
        const ROLLBACK = new Error('rollback：這一組不留任何列');

        // 需要的 portfolio（外鍵）也造在同一個 transaction 裡。
        const seeded = await q(
          `insert into portfolios (user_id, strategy_id, version, schedule_state)
           select '0xalerts-test', s.id, 1, 'active' from strategies s order by s.id limit 1
           returning id`,
        );
        const portfolioId = Number((seeded.rows[0] as { id?: unknown } | undefined)?.id);
        assert.ok(Number.isInteger(portfolioId), 'DB 裡沒有任何 strategy，造不出測試用的 portfolio');

        // ---- 規則 1 對真的 Postgres：三筆 operation 都不是 confirmed ----
        for (const [index, state] of ['failed', 'reverted', 'failed'].entries()) {
          await q(
            `insert into operations (portfolio_id, type, state, idempotency_key, last_error)
             values ($1, 'rebalance', $2, $3, $4)`,
            [portfolioId, state, `alerts-test-${portfolioId}-${index}`, 'HTTP request failed'],
          );
        }
        const detected = await detectPortfolioFailures(q, 3);
        const mine = detected.find((entry) => entry.portfolioId === portfolioId);
        assert.ok(mine !== undefined, '最近 3 筆都不是 confirmed → 必須被偵測到（window function 在真的 PG 上跑一次）');
        assert.match(mine.detail, /3 consecutive operations did not succeed \(last one failed: HTTP request failed\)/);

        // ---- 規則 3 對真的 Postgres：confirmed 的歷史靠 lateral 聚合接得起來 ----
        // stub 證明不了 `cross join lateral` 的語意（尤其是「0 筆 confirmed 也回一列」），
        // 而那正是 warn／critical 的分界 —— 用真的 PG 跑一次。
        await q(
          `insert into smart_accounts (portfolio_id, chain_id, address, owner, account_type)
           values ($1, 56, $2, '0xalerts-test-owner', 'kernel')`,
          [portfolioId, `0x${String(portfolioId).padStart(40, '0')}`],
        );
        const gasSeams = {
          chainId: 56,
          minOps: 10,
          readGasPrice: async () => GAS_PRICE_WEI,
          readNativeBalance: async () => 0n, // 所有帳戶都 0 wei（只讀，不寫）
        };
        const noHistory = (await detectLowGas(q, gasSeams)).find((entry) => entry.portfolioId === portfolioId);
        assert.ok(noHistory !== undefined, '餘額 0 → 一定要被偵測到（lateral 沒有把 0 筆 confirmed 的列 join 掉）');
        assert.equal(noHistory.severity, 'warn', '三筆都是 failed/reverted、沒有任何 confirmed → warn');
        assert.match(noHistory.detail, /no successful execution on record; it may not be running yet/);

        await q(
          `insert into operations (portfolio_id, type, state, idempotency_key)
           values ($1, 'rebalance', 'confirmed', $2)`,
          [portfolioId, `alerts-test-confirmed-${portfolioId}`],
        );
        const withHistory = (await detectLowGas(q, gasSeams)).find((entry) => entry.portfolioId === portfolioId);
        assert.equal(withHistory?.severity, 'critical', '有了 confirmed → 同一個 portfolio 從 warn 升級成回歸 critical');
        assert.match(withHistory?.detail ?? '', /last successful execution was \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/);

        // ---- upsert 去重 ----
        const gasFinding: AlertFinding = {
          kind: 'gas_low',
          severity: 'critical',
          portfolioId,
          detail: 'first seen: gas left for 4 operations',
        };
        await recordAlerts(q, [gasFinding], NOW);
        const first = await q('select id, occurrences, detail from scheduler_alerts where kind = $1 and portfolio_id = $2', ['gas_low', portfolioId]);
        assert.equal(first.rows.length, 1);
        assert.equal(Number((first.rows[0] as { occurrences: unknown }).occurrences), 1);

        await recordAlerts(q, [{ ...gasFinding, detail: '第二次：只剩 3 次操作的 gas' }], NOW);
        const second = await q('select id, occurrences, detail from scheduler_alerts where kind = $1 and portfolio_id = $2', ['gas_low', portfolioId]);
        assert.equal(second.rows.length, 1, '兩次偵測只能有一列（部分唯一索引生效）');
        assert.equal(Number((second.rows[0] as { id: unknown }).id), Number((first.rows[0] as { id: unknown }).id), '是同一列被更新');
        assert.equal(Number((second.rows[0] as { occurrences: unknown }).occurrences), 2);
        assert.equal((second.rows[0] as { detail: string }).detail, '第二次：只剩 3 次操作的 gas', 'detail 更新成最新的一次');
        console.log(`[alerts] 真 Postgres upsert：第 1 次 occurrences=${Number((first.rows[0] as { occurrences: unknown }).occurrences)} → 第 2 次 occurrences=${Number((second.rows[0] as { occurrences: unknown }).occurrences)}（同一個 id=${Number((second.rows[0] as { id: unknown }).id)}）`);

        // ---- portfolio 無關的警示（portfolio_id IS NULL）同樣只收斂成一列 ----
        const orphan: AlertFinding = { kind: 'gas_low', severity: 'warn', portfolioId: null, detail: '沒有 portfolio 的告警' };
        await recordAlerts(q, [orphan], NOW);
        await recordAlerts(q, [orphan], NOW);
        const orphans = await q('select occurrences from scheduler_alerts where kind = $1 and portfolio_id is null', ['gas_low']);
        assert.equal(orphans.rows.length, 1, 'coalesce(portfolio_id,-1) 讓 NULL 也只收斂成一列');
        assert.equal(Number((orphans.rows[0] as { occurrences: unknown }).occurrences), 2);

        // ---- 條件消失 → resolve（保留列，不刪）----
        // 共用 DB 上可能還有別的未解決列，所以每一步都只看**這一組造的**兩列。
        const mineOpen = (await listOpenAlerts(q)).filter(
          (entry) => entry.kind === 'gas_low' && (entry.portfolioId === portfolioId || entry.portfolioId === null),
        );
        assert.equal(mineOpen.length, 2, 'gas_low 的兩列（有 portfolio／沒有 portfolio）都還沒解決');

        const resolved = await resolveAlerts(q, [], NOW);
        assert.ok(resolved >= 2, `這一輪什麼都沒偵測到 → 至少那兩列要被解除（實際 ${resolved}）`);
        assert.deepEqual(
          (await listOpenAlerts(q)).filter(
            (entry) => entry.kind === 'gas_low' && (entry.portfolioId === portfolioId || entry.portfolioId === null),
          ),
          [],
          '解除之後就不在未解決清單裡',
        );

        const kept = await q(
          'select count(*)::int as n from scheduler_alerts where kind = $1 and resolved_at is not null',
          ['gas_low'],
        );
        assert.ok((kept.rows[0] as { n: number }).n >= 2, '已解決的列要留著（那是「什麼時候好的」的唯一證據）');

        throw ROLLBACK;
      }),
    /rollback：這一組不留任何列/,
  );
});

test('portfolio_stuck：最新快照仍 needs_rebalance 且已超過 N 小時 → 告警（<24h 是 warn）', async () => {
  const { query, seen } = stubQuery(() => [{ portfolio_id: '305', gross_drift_bps: 595, hours_since: '7.4' }]);
  const findings = await detectPortfolioStuck(query, 6);
  // 判定條件本身要看得到：needs_rebalance、schedule_state、以及「超過 N 小時」都在 SQL 裡。
  const sql = findSeen(seen, 'portfolio_snapshots').sql;
  assert.match(sql, /needs_rebalance/);
  assert.match(sql, /schedule_state = 'active'/);
  assert.match(sql, /make_interval\(hours => \$1::int\)/);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'portfolio_stuck');
  assert.equal(findings[0]?.severity, 'warn');
  assert.equal(findings[0]?.portfolioId, 305);
  assert.match(String(findings[0]?.detail), /595 bps/);
  assert.match(String(findings[0]?.detail), /7\.4 hours/);
});

test('portfolio_stuck：一整天沒有進展 → critical（不是「今天運氣不好」）', async () => {
  const { query } = stubQuery(() => [{ portfolio_id: '305', gross_drift_bps: 595, hours_since: '26.0' }]);
  const findings = await detectPortfolioStuck(query, 6);
  assert.equal(findings[0]?.severity, 'critical');
});

test('portfolio_stuck：一切正常時不產生告警', async () => {
  const { query } = stubQuery(() => []);
  const findings = await detectPortfolioStuck(query, 6);
  assert.deepEqual(findings, []);
});

test('ALERT_STUCK_HOURS 可覆寫；格式錯誤要拋錯（不要靜默用預設值）', () => {
  assert.equal(loadAlertThresholds({}).stuckHours, 6);
  assert.equal(loadAlertThresholds({ ALERT_STUCK_HOURS: '12' }).stuckHours, 12);
  assert.throws(() => loadAlertThresholds({ ALERT_STUCK_HOURS: '12h' }), /ALERT_STUCK_HOURS/);
});
