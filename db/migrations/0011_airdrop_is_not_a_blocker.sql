-- CRE8 ATP off-chain schema, migration 0011.
--
-- 策略外持倉（空投、使用者自己轉進來的代幣）不再讓一份漂移「不可信」。
--
-- 為什麼前一版（0009）是錯的
--   0009 假設「發現未知持倉 = 這份數字不可信」，於是加了
--     check (unknown_token_count = 0 or not complete)
--   這條約束在當時的語意下是自洽的：讀取宇宙是 `priceable_assets ∪ 目標資產`，而策略外的代幣
--   沒有價格，把它當 0 會讓其他資產的權重集體偏高。
--
--   但那個語意本身是錯的，錯在**宇宙的定義**：
--     * 執行器只允許換 `version.assets` 裡的代幣
--       （`cre8-contracts/src/atp/AtpExecutor.sol:180-182` 的 `isAssetAllowed`）；
--     * 所以策略外的代幣**賣不掉** ⇒ 它不可能參與再平衡；
--     * 所以它不該進漂移的分母。
--   舊語意把「無法執行的東西」當成「必須處理的東西」：一個被空投 1 顆雜幣的投組會因此停止
--   再平衡，即使它其實完全在目標上。方向是反的。
--
-- 新的語意
--   * 讀取與定價的宇宙 == `version.assets`（不是 `priceable_assets` 全表）；
--   * `complete` 只回答「**策略資產**是不是都有價」（無價的策略成分仍然是硬性 blocker：算不出權重）；
--   * 策略外持倉**不阻擋**，但仍是觀測訊號：`unknown_token_count` 照樣記錄，運維要看得到。
--
--   於是 `(unknown_token_count > 0, complete = true)` 從「自相矛盾」變成**正常狀態**，
--   0009 的那條 CHECK 必須移除——留著的話，空投一進來 `writeSnapshot` 就會撞約束而整筆失敗，
--   索引器直接掛掉，比修正前更糟。
--
-- 為什麼不是改 0009
--   `schema_migrations` 記錄了 0001-0010 每一個檔案的 sha256；改一個字都會被 migrate.ts 擋下
--   （"add a new migration instead"）。所以修正只能長成一個新的 migration。

alter table portfolio_snapshots
  drop constraint portfolio_snapshots_unknown_holdings_incomplete;

comment on column portfolio_snapshots.unknown_token_count is
  '這一輪掃到「有餘額、但不在策略資產（version.assets）裡」的代幣個數——策略外持倉，例如空投。**觀測訊號，不影響 complete**：執行器換不掉這些代幣（AtpExecutor.sol:180-182），它們不在漂移的分母裡，所以漂移照算。0 不代表帳戶沒有別的代幣，只代表「掃過的區間裡沒看到」——那要配 universe_complete 一起讀。';

comment on column portfolio_snapshots.universe_complete is
  'true = 我們確定觀察到了這個帳戶擁有的全部代幣（掃描游標自 start_block 起連續成功推進，且 start_block <= 帳戶部署塊）。false = 這件事沒有被確認：可能游標還沒覆蓋到部署塊（不知道，不是知道有問題），或這一輪／過去某一輪的 getLogs 失敗。**它是觀測訊號，不影響 complete 的定義**：策略資產照樣都有價、漂移照算，只是「帳戶還收到過什麼」沒被看全。';

comment on column portfolio_snapshots.complete is
  'false = 這一份 drift 不可信：持有無價的**策略資產**，或 DB 與鏈上的 allocation 不一致，planner 因此拒算。此時 gross_drift_bps/max_abs_delta_bps/needs_rebalance 一律 0/false（由 0008 的 CHECK 綁住），判讀前必須先看這一欄。**策略外持倉（空投）不會讓它變 false**（0011）：那些代幣賣不掉、不在漂移的分母裡，只是被記在 unknown_token_count。';
