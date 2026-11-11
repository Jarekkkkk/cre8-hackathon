-- CRE8 ATP off-chain schema, migration 0008.
--
-- portfolio_snapshots：快照的「表頭」。讓「跑過且是空的」與「根本沒跑」變成兩件看得出來的事。
--
-- 為什麼需要這張表
--   positions_snapshots 是明細：每 block 每資產一列。空倉時它**一列都不寫**，因為沒有資產就沒有
--   明細可寫——這在資料上完全正確，在下游卻是黑洞：一個「剛才檢查過、確認帳戶什麼都沒有」的
--   portfolio，與一個「索引器三小時前就死了」的 portfolio，在這張表上長得一模一樣（都查不到列）。
--   於是沒有人能回答「portfolio 5 上次什麼時候檢查過、當時漂移多少、需不需要動」。
--   表頭就是那個「每一輪都有一列」的東西：明細 0 列 + 表頭 1 列 = 跑過且是空的；兩者都沒有 = 沒跑。
--
-- 為什麼是 (portfolio_id, block) 當主鍵而不是流水號
--   同一個 block 重跑一次是**同一份觀測**（鏈上狀態被釘死在 block 上，價格也由 TWAP 決定），
--   不是第二份快照。所以重跑是 UPDATE：數值換新，列數不變，才不會讓「同一個 block 兩個總額」
--   這種矛盾進到資料裡。也因此沒有 snapshot_id 給明細列引用（0005 的註解已經說明這個取捨，
--   現在明細與表頭用 (portfolio_id, block) 這個自然鍵對得起來，不需要代理鍵）。
--
-- complete：這一份 drift 數字可不可信
--   false = 持有無價資產（或 DB 與鏈上的 allocation 不一致），planner 依設計拒算漂移。此時
--   gross_drift_bps / max_abs_delta_bps 一定是 0、needs_rebalance 一定是 false——但那個 0 是
--   「沒算」不是「已對齊」，0/false 的組合看起來卻像「不必動」。所以三者的 0/false 由
--   portfolio_snapshots_incomplete_has_no_drift 這個約束綁死在 complete = false 上：下游要嘛
--   先看 complete，要嘛就不可能把一個沒算過的 0 誤讀成已對齊（它同時拿得到 unpriced_count）。
--   total_usd_e8 在 complete = false 時是「已定價部位的部分總額」，不是投組總值。
--
-- 剩下的數字都是照 drift.ts 的定義寫進來的，這裡不重算：gross_drift_bps = round(Σ|Δbps| / 2)、
-- max_abs_delta_bps = 所有資產裡最大的 |Δbps|、needs_rebalance = gross_drift_bps >= threshold_bps。
-- 刻意**不**把 needs_rebalance 與門檻的關係寫成 CHECK：那等於把 drift.ts 的規則複製到資料庫，
-- 規則一改（例如改成嚴格大於）寫入就開始莫名其妙地失敗。
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.

create table portfolio_snapshots (
  portfolio_id       bigint        not null references portfolios(id) on delete cascade,
  block              bigint        not null,
  native_balance_wei numeric(78,0) not null,
  total_usd_e8       numeric(38,0) not null,
  gross_drift_bps    integer       not null,
  max_abs_delta_bps  integer       not null,
  threshold_bps      integer       not null,
  needs_rebalance    boolean       not null,
  complete           boolean       not null,
  unpriced_count     integer       not null,
  pinned_version     integer,
  created_at         timestamptz   not null default now(),
  constraint portfolio_snapshots_pkey primary key (portfolio_id, block),
  constraint portfolio_snapshots_block_non_negative check (block >= 0),
  constraint portfolio_snapshots_native_balance_non_negative check (native_balance_wei >= 0),
  constraint portfolio_snapshots_total_usd_non_negative check (total_usd_e8 >= 0),
  constraint portfolio_snapshots_gross_drift_range check (gross_drift_bps between 0 and 10000),
  constraint portfolio_snapshots_max_abs_delta_range check (max_abs_delta_bps between 0 and 10000),
  constraint portfolio_snapshots_threshold_range check (threshold_bps between 0 and 10000),
  constraint portfolio_snapshots_unpriced_count_non_negative check (unpriced_count >= 0),
  -- enrollment.version 一定是 >= 1；NULL 只代表「這一輪沒讀到」（例如只有鏈下資料的呼叫端）。
  constraint portfolio_snapshots_pinned_version_positive check (pinned_version is null or pinned_version >= 1),
  -- 沒算過的漂移不能留成一個看起來像「已對齊」的 0（見檔頭）。
  constraint portfolio_snapshots_incomplete_has_no_drift
    check (complete or (gross_drift_bps = 0 and max_abs_delta_bps = 0 and needs_rebalance = false))
);

comment on table portfolio_snapshots is
  '快照表頭，每 (portfolio_id, block) 一列：空倉也一定有一列，否則下游分不出「跑過且是空的」與「根本沒跑」。明細在 positions_snapshots，兩者用 (portfolio_id, block) 對齊；同一個 block 重跑是 UPDATE（同一份觀測，不是第二份快照），created_at 保留第一次寫入的時間。';
comment on column portfolio_snapshots.block is
  '這一輪讀鏈的塊高。所有餘額、價格與漂移都釘在這個塊上；同一個 block 重複寫入不會多一列。';
comment on column portfolio_snapshots.native_balance_wei is
  'native BNB 餘額（wei），只付 gas，**不進漂移**：算進持倉會讓每個帳戶看起來都嚴重超配 BNB。記錄它只是為了回答「這個帳戶還能不能發交易」。';
comment on column portfolio_snapshots.total_usd_e8 is
  '投組總值，1e8 定點（1 USDT = 1e8）。complete = false 時它是「已定價部位的部分總額」，不是總值。';
comment on column portfolio_snapshots.gross_drift_bps is
  'Σ|Δbps| / 2（四捨五入），「要搬多少投組價值」的比例。complete = false 時固定 0 且代表沒算，不代表已對齊。';
comment on column portfolio_snapshots.max_abs_delta_bps is
  '所有資產裡最大的 |Δbps|：gross 是總量，這個是單一資產最偏離的那一筆。complete = false 時固定 0。';
comment on column portfolio_snapshots.threshold_bps is
  '這一輪用的再平衡門檻（bps）。存下來是因為門檻會調：只留下 needs_rebalance 而不留門檻，事後就無法還原「當初為什麼判定要動」。';
comment on column portfolio_snapshots.needs_rebalance is
  'gross_drift_bps >= threshold_bps（等於門檻就該動）。complete = false 時固定 false——那是「不能判斷」，不是「不必動」，判讀前先看 complete。';
comment on column portfolio_snapshots.complete is
  'false = 這一份 drift 不可信：持有無價資產，或 DB 與鏈上的 allocation 不一致，planner 因此拒算。此時 gross_drift_bps/max_abs_delta_bps/needs_rebalance 一律 0/false（由 CHECK 綁住），判讀前必須先看這一欄。';
comment on column portfolio_snapshots.unpriced_count is
  '這一輪「持有但沒有價格」的資產個數（不含 0 餘額的無價標的）：它是 complete = false 最常見的原因，也是「該補哪個池」的訊號。';
comment on column portfolio_snapshots.pinned_version is
  '鏈上 enrollment.version（該帳戶被釘住的策略版本）。NULL 只代表這一輪沒讀到。刻意不用 DB 的 portfolios.version：發新版本後跟著舊版的帳戶若照新版算，漂移會完全錯。';
comment on column portfolio_snapshots.created_at is
  '這一列的第一次寫入時間。同一個 block 重跑（UPDATE）不刷新它，因為那是同一份觀測；要問「上次檢查」請取最大的 block 那一列。';
