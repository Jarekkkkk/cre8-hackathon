-- CRE8 ATP off-chain schema, migration 0015.
--
-- positions_snapshots: 明細也要能分辨同一塊的 before / after。
--
-- Why this file exists
--   0014 把 phase 加進 `portfolio_snapshots` 的 PK，但**明細**的 UNIQUE 還是
--   (portfolio_id, asset, block)。同一塊寫 before 與 after 時，明細會被後寫的那一份覆蓋 ——
--   於是表頭有兩張（before/after），明細只有一張，差額算出來是 0 或負數，而**沒有任何東西會報錯**。
--   那正是這個專案一直在對抗的形狀：資料錯但看起來正常。
--
-- 做法
--   * 加 phase（預設 'manual'，與表頭同一個語意）。
--   * UNIQUE 換成 (portfolio_id, asset, block, phase)：一張快照裡「一個資產一列」仍然是保證，
--     但不同 phase 不再互相覆蓋。
--   * 舊的索引改名沿用（portfolio_id, block desc 那條不變）。
--
-- 注意
--   這是純 schema 變更，不動任何既有列的值：既有列全部落在 phase = 'manual'（預設值），
--   而它們過去也只可能是「一次觀測寫一張」，所以不會出現語意衝突。

alter table positions_snapshots
  add column phase text not null default 'manual';

alter table positions_snapshots
  add constraint positions_snapshots_phase_valid
    check (phase in ('manual', 'before', 'after'));

alter table positions_snapshots
  drop constraint positions_snapshots_portfolio_asset_block_key;

alter table positions_snapshots
  add constraint positions_snapshots_portfolio_asset_block_phase_key
    unique (portfolio_id, asset, block, phase);

comment on column positions_snapshots.phase is
  'manual = CLI 手動 index；before = 送出前；after = 落地後。與 portfolio_snapshots.phase 同一個值';
