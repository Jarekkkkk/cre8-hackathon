-- CRE8 ATP off-chain schema, migration 0012.
--
-- 讓 `portfolios` 回得了「誰現在該跑」，並把 `operations` 補成一個**完整的執行生命週期**紀錄。
--
-- 為什麼需要這個 migration
--   在此之前 `portfolios.schedule_state` 只被 enroll 寫成 `active`，而且**沒有任何時間戳**：
--   排程器沒有任何欄位可以回答「這一個 portfolio 上次什麼時候檢查過、下一次什麼時候該跑」。
--   一個只有 `active` 的布林式狀態會讓每一輪都把**全部** active 的 portfolio 當成到期 ——
--   那等於沒有排程，只剩一個會把 RPC 打爆的迴圈。
--
-- 為什麼 next_run_at 要在「執行之前」就推進（本 migration 最重要的一欄）
--   認領與推進必須是同一個 transaction（`backend/src/scheduler.ts` 的 claimDuePortfolios 用
--   `SELECT … FOR UPDATE SKIP LOCKED` 選出到期列，並在離開 transaction 之前把 next_run_at 寫成
--   `now + intervalSeconds`）。若等「執行完」才推進，一次 crash、逾時或行程被砍就讓同一個 portfolio
--   在下一輪仍然「到期」→ 被重複認領 → **重複送一筆再平衡 = 重複動錢**。
--   寧可漏跑一次（下一輪會補），也不要重複跑：漏跑只是延後，重複跑是不可逆的。
--   next_run_at 為 NULL 的 active portfolio 視為「立刻到期」（`next_run_at is null or next_run_at <= now()`），
--   所以新建立的 portfolio 不需要任何額外寫入就會被排程器撿到，不會被漏掉。
--
-- 為什麼 operations 需要 tx_hash / user_op_hash / attempts / last_error
--   `state='submitted'` 而不記 tx_hash，事後無法回答「那筆到底上鏈了沒」；`attempts` 是
--   「同一個 idempotency_key 被嘗試幾次」的唯一證據（沒有它，重試過的 op 與沒重試過的長得一樣）；
--   `last_error` 是失敗原因唯一會留下來的地方（log 會被輪替，DB 不會）。
--
-- 為什麼是「新增檔案」而不是改 0001
--   `schema_migrations` 記了 0001-0011 每一個檔案的 sha256；改一個字都會被 migrate.ts 擋下
--   （"add a new migration instead"）。
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.

-- ---------------------------------------------------------------------------
-- portfolios：排程狀態（三個時間戳 + 一條 CHECK）
-- ---------------------------------------------------------------------------
alter table portfolios
  add column next_run_at       timestamptz,
  add column last_checked_at   timestamptz,
  add column last_rebalance_at timestamptz;

-- 原本 `schedule_state` 是 text 且沒有 CHECK（0001：'Text on purpose until the state machine is frozen.'）。
-- 排程器現在要對它做 `= 'active'` 的判定，狀態機就是凍結的時刻：寫錯的值會讓一個 portfolio
-- **永遠不被認領**，而它看起來完全正常。既有資料只有 idle/active，加約束不會失敗。
alter table portfolios
  add constraint portfolios_schedule_state_valid
  check (schedule_state in ('idle', 'active', 'paused'));

-- 排程器每一輪都是「誰到期了」，這個索引就是那個查詢的形状：先用 schedule_state 收斂到 active，
-- 再按 next_run_at 排序取前 N 筆（NULL 排最前面，見下面 next_run_at 的 COMMENT）。
create index portfolios_schedule_state_next_run_at_idx on portfolios (schedule_state, next_run_at);

comment on column portfolios.schedule_state is
  '排程狀態：idle（從未被排程器撿起）| active（每一輪都會被檢查是否到期）| paused（一律跳過，即使 next_run_at 已過）。由 0012 的 portfolios_schedule_state_valid 綁住這三個值——寫錯的值會讓一個 portfolio 永遠不被認領，而它看起來完全正常。';
comment on column portfolios.next_run_at is
  '下一次「該被檢查」的時間（不是「下一次該成交」）。NULL = 立刻到期：claimDuePortfolios 的條件是 `next_run_at is null or next_run_at <= now()`，所以新建的 portfolio 不必任何額外寫入就會被排程器撿到、不會被漏掉。**認領時就推進（now + intervalSeconds），不是執行完才推進**：等執行完才推進的話，一次 crash／逾時會讓同一個 portfolio 在下一輪被重複認領，而重複認領等於重複送再平衡＝重複動錢。寧可漏跑一次（下一輪會補），也不要重複跑。';
comment on column portfolios.last_checked_at is
  '最後一次「排程器真的檢查過它」的時間。檢查沒過（blocked／noop）也會更新：它記錄的是「這一輪看過了」，不是「這一輪動了」。與 portfolio_snapshots 的 block 不同，這是排程器的視角，不是觀測的視角。';
comment on column portfolios.last_rebalance_at is
  '最後一次**成功**上鏈再平衡的時間（state=confirmed）。失敗／reverted 不會更新：一筆 revert 的交易不是一次再平衡，把它記成「剛調過」會讓後續判讀以為投組已經收斂過。只給人看與稽核用，排程判斷一律看 next_run_at。';

-- ---------------------------------------------------------------------------
-- operations：補齊執行生命週期（tx_hash / user_op_hash / attempts / last_error）
-- ---------------------------------------------------------------------------
alter table operations
  add column tx_hash      text,
  add column user_op_hash text,
  add column attempts     integer not null default 0,
  add column last_error   text;

-- 0001 的註解寫「No CHECK yet: the state machine is not frozen」。排程器現在會**依 state 決定要不要**
-- 再送一筆（confirmed = 不再送；failed/reverted = 允許重試；pending/submitted = 視為在途），
-- 所以打錯一個字不再是「顯示錯誤」而是「重複動錢」的入口。值域到此凍結。
alter table operations
  add constraint operations_type_valid
    check (type in ('rebalance', 'enroll', 'revoke_session_key', 'withdraw')),
  add constraint operations_state_valid
    check (state in ('pending', 'submitted', 'confirmed', 'failed', 'reverted')),
  add constraint operations_attempts_valid
    check (attempts >= 0);

comment on column operations.type is
  '操作種類，由 operations_type_valid 綁死四個值：rebalance | enroll | revoke_session_key | withdraw。排程器只寫 rebalance；被 CHECK 擋下的新種類必須走一顆新的 migration 加入值域，不能靠打錯字硬塞。';
comment on column operations.state is
  '生命週期，由 operations_state_valid 綁死五個值。**排程器用這一欄決定要不要再送一筆**：confirmed 永不再送；pending／submitted 視為在途（不重送，因為結果未知時重送的代價是重複動錢）；failed／reverted 允許同一個 idempotency_key 重試並把 attempts +1。';
comment on column operations.tx_hash is
  'landed 的鏈上交易 hash（送出者從 receipt 取回）。state=submitted 時可能是 NULL（userOp 已交給 bundler、還沒打包）；confirmed／reverted 之後必須有值，否則「那筆到底上鏈了沒」事後答不出來。';
comment on column operations.user_op_hash is
  'ERC-4337 userOp hash（alto 在**模擬通過之後**才回傳；被拒的 op 沒有這個值，那就是它被擋下的證據）。它與 tx_hash 是兩件事：一筆 tx 理論上可打包多筆 userOp。';
comment on column operations.attempts is
  '同一個 idempotency_key 被嘗試過幾次（每一次進入執行流程 +1，不是每一個 step）。0 = 只建立了列、還沒嘗試送；失敗後重試會累加到 2、3…，所以「這個 op 重試過幾次」不必讀 log。';
comment on column operations.last_error is
  '最後一次失敗的原因（send／receipt 的錯誤訊息，已截斷）。失敗後重試成功時清成 NULL：留著會讓下一次判讀把「上次失敗」當成「這次失敗」。';

-- ---------------------------------------------------------------------------
-- 給下一個讀者的兩個查詢
-- ---------------------------------------------------------------------------
-- 「誰現在到期」（與 claimDuePortfolios 的 select 逐字相同，方便對照執行計畫）：
--   select id from portfolios
--    where schedule_state = 'active' and (next_run_at is null or next_run_at <= now())
--    order by next_run_at asc nulls first, id asc
--      for update skip locked;
-- 「這個 portfolio 最近的執行紀錄」：
--   select id, state, attempts, tx_hash, user_op_hash, last_error, updated_at
--     from operations where portfolio_id = $1 order by id desc limit 20;
