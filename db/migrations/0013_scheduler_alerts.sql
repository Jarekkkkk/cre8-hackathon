-- CRE8 ATP off-chain schema, migration 0013.
--
-- 排程器的**告警**：把「有人該看這件事」變成 DB 裡的一列，而不是一行會被輪替掉的 log。
--
-- 為什麼需要這張表（這是本 migration 存在的唯一理由）
--   2026-11 的三次長跑（各約 2.5 小時）實際結果：第一次 34 輪只有 1 輪成功、第二次 17 輪只有
--   1 輪成功、第三次 1 輪 —— **20+ 輪連續失敗，沒有任何東西通知任何人**，是靠人手動翻 log 才發現的。
--   排程器的價值建立在「無人值守」上，而無人值守的前提是「壞掉時有人會知道」。log 只寫 stdout，
--   行程重啟就沒了、輪替了就沒了，而且沒有人會去讀一個沒人叫你看的檔案。
--
--   所以失敗必須是一個**查詢得到的狀態**：`GET /health` 讀它（critical → degraded），排程器每一輪
--   把偵測結果寫進來，CLI `--alerts` 直接列出來。這三個出口都只讀這張表。
--
-- 為什麼是「upsert 一列持續累加」而不是「每次偵測插一列」
--   同一個問題每 60 秒被偵測一次，一天就是 1440 列 —— 那不是告警，是一份噪音 log。未解決的警示
--   依 (kind, portfolio_id) 只有**一列**：再次偵測到 → `occurrences + 1`、更新 `last_seen_at`；
--   條件消失 → `resolved_at` 寫入（`resolveAlerts`）。所以「這個問題持續了多久、被看到幾次」
--   看 `first_seen_at` / `occurrences` 就有答案，不必掃歷史。
--
-- 為什麼部分唯一索引要 `coalesce(portfolio_id, -1)`
--   Postgres 的 UNIQUE 對 NULL 是「每個 NULL 都不同」，所以 `(kind, portfolio_id)` 對
--   portfolio 無關的警示（未來若出現）會允許無限多列。`coalesce(portfolio_id, -1)` 讓 NULL 收斂成
--   同一個值，`(kind, portfolio_id)` 才真的「同時只能有一個未解決的」。也因為它是運算式索引，
--   `recordAlerts` 的 ON CONFLICT 推斷必須把運算式原樣寫出來（見 backend/src/alerts.ts）。
--
-- 為什麼 resolved_at 進索引條件而不是刪列
--   已解決的列是「這件事曾經發生過、什麼時候好的」的唯一證據。刪掉就再也答不出「上週那個
--   連續失敗是幾點解除的」。所以只更新 resolved_at，不刪。
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.

-- ---------------------------------------------------------------------------
-- scheduler_alerts：一個 (kind, portfolio) 同時只有一列未解決
-- ---------------------------------------------------------------------------
create table scheduler_alerts (
  id            bigserial   primary key,
  kind          text        not null,
  severity      text        not null,
  portfolio_id  bigint      references portfolios (id) on delete cascade,
  detail        text        not null,
  occurrences   integer     not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  constraint scheduler_alerts_kind_valid
    check (kind in ('portfolio_repeatedly_failing', 'session_key_expiring', 'gas_low')),
  constraint scheduler_alerts_severity_valid
    check (severity in ('warn', 'critical')),
  constraint scheduler_alerts_occurrences_positive
    check (occurrences > 0)
);

-- 同一個 (kind, portfolio_id) 同時只能有一個未解決的。
-- `coalesce(portfolio_id, -1)`：UNIQUE 對 NULL 是「每個都不同」，不這樣寫的話 portfolio 無關的
-- 警示會重複插入。ON CONFLICT 推斷要逐字寫出同一個運算式與同一個 WHERE（alerts.ts）。
create unique index scheduler_alerts_open_uniq
  on scheduler_alerts (kind, coalesce(portfolio_id, -1)) where resolved_at is null;

-- 「現在有什麼沒解決、哪一個最嚴重」是 /health 每一輪都問的問題（也含 severity 排序）。
create index scheduler_alerts_open_idx on scheduler_alerts (resolved_at, severity);

comment on table scheduler_alerts is
  '排程器告警：偵測到「有人該看這件事」時寫入，條件消失時把 resolved_at 填起來（不刪列）。存在的理由是一次實測：三次長跑共 20+ 輪連續失敗，因為只寫 stdout log，沒有任何人知道。未解決的警示由 (kind, coalesce(portfolio_id,-1)) 上的部分唯一索引綁成**一列**，再次偵測到只累加 occurrences —— 否則每 60 秒一列的結果不是告警而是噪音。讀它的三個出口：GET /health（critical → degraded）、排程器每輪的 stdout、CLI 的 --alerts。';
comment on column scheduler_alerts.kind is
  '告警種類，由 scheduler_alerts_kind_valid 綁死三個值：portfolio_repeatedly_failing（連續 N 筆 operation 都沒有 confirmed）| session_key_expiring（active 的 session key 快到期）| gas_low（smart account 的 BNB 不夠再跑幾次 op）。新增種類要走一顆新的 migration 改 CHECK，不能靠打錯字硬塞。';
comment on column scheduler_alerts.severity is
  'warn | critical。只有 critical 會讓 GET /health 變 degraded（HTTP 仍是 200：服務還活著，只是需要人看；503 留給 Postgres 掛掉）。';
comment on column scheduler_alerts.portfolio_id is
  '是哪一個 portfolio 的問題；NULL = 與 portfolio 無關的告警。ON DELETE CASCADE：portfolio 被刪掉，它的告警跟著走。';
comment on column scheduler_alerts.detail is
  '人類可讀的一句話（繁中，含數字與最後一次的狀態／錯誤，已截斷）。排程器的 stdout 直接印這一行，所以它必須自己說得清楚，不能只寫「有問題」。每次再次偵測到會被覆寫成最新的一次。';
comment on column scheduler_alerts.occurrences is
  '這個問題被偵測到幾次（不是「幾輪」的近似值：每一輪偵測到一次就 +1）。1 = 第一次看到。與 first_seen_at 一起回答「這個問題持續多久、被看到幾次」。';
comment on column scheduler_alerts.first_seen_at is
  '第一次偵測到的時間。upsert 不會改它 —— 改了就看不出「持續多久」。';
comment on column scheduler_alerts.last_seen_at is
  '最後一次偵測到的時間。排程器每一輪都會更新它，所以「這個警示是不是還在」看它就知道（不必等 resolved_at）。';
comment on column scheduler_alerts.resolved_at is
  '條件消失的時間（resolveAlerts 寫入）。NULL = 還沒解決。**不刪列**：已解決的列是「曾經發生過、什麼時候好的」的唯一證據。';

-- ---------------------------------------------------------------------------
-- 給下一個讀者的兩個查詢
-- ---------------------------------------------------------------------------
-- 「現在有什麼沒解決、誰最嚴重」（= listOpenAlerts，/health 與 --alerts 都走這條）：
--   select kind, severity, portfolio_id, detail, occurrences, first_seen_at, last_seen_at
--     from scheduler_alerts where resolved_at is null
--    order by case severity when 'critical' then 0 else 1 end, last_seen_at desc;
-- 「這個 portfolio 最近發生過什麼」（除錯用，含已解決的）：
--   select id, kind, severity, occurrences, first_seen_at, last_seen_at, resolved_at
--     from scheduler_alerts where portfolio_id = $1 order by id desc limit 20;
