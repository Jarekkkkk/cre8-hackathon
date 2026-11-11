-- CRE8 ATP off-chain schema, migration 0010.
--
-- portfolio_holding_candidates：把「曾經轉入過的宇宙外代幣」落地，讓未知持倉偵測不再是**一次性**的。
--
-- 要修的問題（0009 只把它延後一輪，沒有消滅）
--   0009 的偵測只看「這一輪日誌裡出現的候選」：`getLogs` 掃到某顆代幣 → 讀 `balanceOf` → 有餘額就
--   blocked。但 detection 的輸入是**這一輪的日誌視窗**，而視窗會前進：
--     第 N 輪    CAKE 在 B 塊轉入 → 游標掃到它 → unknown_token_count = 1、complete = false ✅
--     第 N+1 輪  視窗 [cursor, head] 沒有新日誌 → 候選集空 → unknown_token_count = 0、
--                universe_complete = true → **keeper 又開始相信一份漏掉 CAKE 的宇宙** ❌
--   一份「看起來完全合理」的錯誤報告又送進 keeper。這就是這張表存在的唯一理由：
--   **候選一旦被看過，就必須在之後的每一輪被重讀**，不能因為「這一輪沒新日誌」而忘記。
--
-- 為什麼是「候選」而不是「持倉」
--   這張表記的不是「持有中」，是「值得每一輪再問一次 `balanceOf` 的地址」。日誌只能證明某個代幣
--   **曾經**轉進來；現在還有沒有，只有 `balanceOf` 知道。所以表的生命週期要比餘額長：
--   餘額歸零的列**不刪**（它可能再度有餘額，而且那時不會有新日誌保證被我們看到），只是不算入
--   `unknown_token_count`。刪掉它等於把「我們曾經不知道過」這件事一起刪掉。
--
-- 為什麼 first_seen_block 只記第一次
--   它是「這顆代幣是什麼時候進入視野」的證據，不是進度。`on conflict do nothing` 讓重複發現不會
--   把時間軸改寫成最近一次，否則「它到底潛伏了多久」這個問題就永遠答不出來。
--
-- 為什麼 last_balance_wei 是 numeric(78,0)
--   鏈上 uint256 的完整範圍。bigint（PG）放不下 2^256，而截斷一個餘額等於製造一個新的假答案。
--   應用層照 0009 的慣例以字串收送（pg 對 numeric 回字串）。
--
-- 為什麼 last_balance_wei 在更新時要「跳過讀不到的那些」
--   `balanceOf` 讀不到 ≠ 餘額 0。把讀不到寫成 0，下一次看這張表的人會以為它已經沒事了——那正是
--   這支 migration 要消滅的那種「看起來合理」的錯。所以只有讀成功的那些列會被更新。
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.

create table portfolio_holding_candidates (
  portfolio_id     bigint        not null references portfolios(id) on delete cascade,
  -- 小寫 0x + 40 hex，與 priceable_assets.address 同一套慣例。
  asset            text          not null,
  first_seen_block bigint        not null,
  last_balance_wei numeric(78,0) not null default 0,
  last_checked_at  timestamptz   not null default now(),
  primary key (portfolio_id, asset),
  constraint portfolio_holding_candidates_asset_lowercase
    check (asset ~ '^0x[0-9a-f]{40}$'),
  constraint portfolio_holding_candidates_first_seen_block_non_negative
    check (first_seen_block >= 0),
  constraint portfolio_holding_candidates_last_balance_non_negative
    check (last_balance_wei >= 0)
);

comment on table portfolio_holding_candidates is
  '曾轉入過的「宇宙外」代幣：每個 portfolio 每個地址一列，一旦寫入就不再忘記。存在的理由是一次性偵測會讓 bug 延後一輪：第 N 輪看到 CAKE 而 blocked，第 N+1 輪沒有新日誌、候選集變空，keeper 就又開始相信一份漏掉 CAKE 的宇宙。所以每一輪都要對這張表的**全部列**重讀 balanceOf，不論這一輪的 getLogs 有沒有新日誌、甚至不論它成不成功。';
comment on column portfolio_holding_candidates.asset is
  '候選代幣合約地址，小寫 0x + 40 hex。由轉入日誌（topics[2] = 帳戶）發現，扣掉讀取宇宙（priceable_assets ∪ 目標資產）之後才寫進來。';
comment on column portfolio_holding_candidates.first_seen_block is
  '這顆代幣第一次進入視野的塊（發現它的那筆轉入所在的塊）。只記第一次：重複發現不改寫，否則「它潛伏了多久」就答不出來。';
comment on column portfolio_holding_candidates.last_balance_wei is
  '上一次成功讀到的 balanceOf（wei，uint256 全範圍）。餘額 0 的列**保留**（它可能再度有餘額，而屆時未必有日誌）；更新時跳過讀不到的列——「讀不到」與「0」不是同一件事。';
comment on column portfolio_holding_candidates.last_checked_at is
  '上一次嘗試重讀 balanceOf 的時間。只是給人看的：候選列不會因為久沒變動而被清掉，清理只能由人決定。';
