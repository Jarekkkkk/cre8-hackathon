-- CRE8 ATP off-chain schema, migration 0009.
--
-- 讀取宇宙的可信度：持倉掃描游標（新表）+ 快照表頭的兩個誠實欄位。
--
-- 要修的問題
--   索引器的讀取宇宙是 `priceable_assets(enabled) ∪ 目標資產`。那是一份「什麼有價格」的清單，
--   **不是**「帳戶擁有什麼」的清單。使用者帳戶持有、但不在這個集合裡的代幣根本不被讀，於是：
--   total_usd_e8 低估 → 每個已知資產的 current_bps 偏高 → 漂移算錯，而 complete 仍然是 true。
--   一份「看起來完全合理」的錯誤報告會送進 keeper。持有但未觀察 ≠ 持有 0。
--
-- 兩個欄位回答兩件不同的事（這是這支 migration 的重點）
--   complete          = 「我們觀察到的資產都有價」            （0008 已定義）
--   universe_complete = 「我們確定觀察到了帳戶擁有的全部資產」  （本檔新增）
--   keeper **必須兩個都 true** 才能相信漂移。單看 complete 就是 0009 要修的那個 bug。
--
-- 為什麼完整性需要一張游標表，而不是每次算得出來
--   唯一能證明「宇宙完整」的東西是：掃描游標**自從（或早於）帳戶部署塊起**，連續且成功地推進到
--   head。那是狀態，不是一次計算的副產品——游標一推進，起點就不見了。所以起點與進度必須落地。
--
-- 為什麼比規格多一欄 start_block（刻意的偏離，理由寫在這裡）
--   規格給的三欄（portfolio_id / last_scanned_block / updated_at）答不出「游標是否覆蓋部署塊」：
--   一個從 head 開始的游標與一個從部署塊開始的游標，在推進之後於資料上長得一模一樣。
--   少了這一欄，universe_complete 只會在那支程式第一次跑的那一瞬間正確，之後就變成猜的——而
--   「猜宇宙是完整的」正是這支 migration 要消滅的東西。所以加它。0001-0008 一個字都沒動。
--
-- 游標的兩個數字是什麼
--   start_block        = 這條游標鏈的源頭：第一次掃描涵蓋的第一個塊。
--   last_scanned_block = 已經**連續且成功**掃過的最後一個塊。start_block - 1 = 一塊都還沒掃。
--   只有掃描成功才前進；RPC 失敗／403 一律不前進（否則那個塊的轉入永遠不會被看到）。
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.

-- ---------------------------------------------------------------------------
-- 1. 掃描游標：每個 portfolio 一列。
-- ---------------------------------------------------------------------------
create table portfolio_scan_cursors (
  portfolio_id       bigint      primary key references portfolios(id) on delete cascade,
  start_block        bigint      not null,
  last_scanned_block bigint      not null,
  updated_at         timestamptz not null default now(),
  constraint portfolio_scan_cursors_start_block_non_negative check (start_block >= 0),
  -- 「一塊都還沒掃」＝ last_scanned_block = start_block - 1（start_block = 0 時就是 -1）。
  -- 反過來（last_scanned_block 跑到 start_block 之前更多）是寫錯，不是合法狀態。
  constraint portfolio_scan_cursors_block_order check (last_scanned_block >= start_block - 1)
);

comment on table portfolio_scan_cursors is
  '持倉掃描游標：每個 portfolio 一列，記錄「轉入日誌已經連續掃到哪個塊」。它是 universe_complete 唯一的證據來源——沒有游標就沒有任何辦法證明看過帳戶收過的每一筆轉入。掃描失敗（RPC 403／逾時）時 last_scanned_block 不前進，寧可下次重掃也不要留一個洞。';
comment on column portfolio_scan_cursors.start_block is
  '游標鏈的源頭：第一次掃描涵蓋的第一個塊。universe_complete 只有在 start_block <= 帳戶部署塊時才可能為 true（比部署塊更早開始掃永遠是安全的）。掃描推進之後這個事實就無從還原，所以必須落地。';
comment on column portfolio_scan_cursors.last_scanned_block is
  '已經連續且成功掃過的最後一個塊。[start_block, last_scanned_block] 是一個沒有洞的區間；start_block - 1 代表一塊都還沒掃。RPC 失敗時不前進：一個洞會讓某筆轉入永遠不被看到，而「沒看到」正是 0009 要修的錯。';
comment on column portfolio_scan_cursors.updated_at is
  '最後一次成功推進的時間。只是給人看的：判斷「游標是不是卡住了」請看它有沒有隨著 head 長大。';

-- ---------------------------------------------------------------------------
-- 2. 表頭的兩個誠實欄位。
--
-- universe_complete 給 default false 是刻意的（規格沒寫 default）：在整合完成之前，寫入端還不會
-- 帶這一欄，而 NOT NULL 沒有 default 會讓既有那條 INSERT 直接失敗。false 也是**安全**的那個值
-- ——「沒有確認過宇宙完整」比「確認過」誠實。
-- ---------------------------------------------------------------------------
alter table portfolio_snapshots
  add column unknown_token_count integer not null default 0,
  add column universe_complete boolean not null default false,
  add constraint portfolio_snapshots_unknown_token_count_non_negative check (unknown_token_count >= 0),
  -- 發現「持有中的未知代幣」就是發現這份數字不可信：它得讓 complete = false 才擋得住漂移。
  -- 反過來講，unknown_token_count > 0 而 complete = true 的列在任何解讀下都是自相矛盾。
  add constraint portfolio_snapshots_unknown_holdings_incomplete
    check (unknown_token_count = 0 or not complete);

comment on column portfolio_snapshots.unknown_token_count is
  '這一輪掃到「有餘額、但不在讀取宇宙（priceable_assets ∪ 目標資產）裡」的代幣個數。0 不代表帳戶沒有別的代幣，只代表「掃過的區間裡沒看到」——那要配 universe_complete 一起讀。> 0 時 complete 一定是 false（由 CHECK 綁住）：那正是「持有但未觀察 ≠ 持有 0」。';
comment on column portfolio_snapshots.universe_complete is
  'true = 我們確定觀察到了這個帳戶擁有的全部代幣（掃描游標自 start_block 起連續成功推進，且 start_block <= 帳戶部署塊）。false = 這件事沒有被確認：可能游標還沒覆蓋到部署塊（不知道，不是知道有問題），或這一輪／過去某一輪的 getLogs 失敗。**它在 false 時不影響 complete 的定義**：所有「看到的」資產仍然有價，漂移照算，但那份漂移建立在一個可能缺項的宇宙上。keeper 必須 complete 與 universe_complete 同時為 true 才能相信漂移。';
comment on column portfolio_snapshots.complete is
  'false = 這一份 drift 不可信：持有無價資產，或持有未知代幣（0009），或 DB 與鏈上的 allocation 不一致，planner 因此拒算。此時 gross_drift_bps/max_abs_delta_bps/needs_rebalance 一律 0/false（由 0008 的 CHECK 綁住），判讀前必須先看這一欄。**只看這一欄不夠**：宇宙完整性在 universe_complete（0009）。';
