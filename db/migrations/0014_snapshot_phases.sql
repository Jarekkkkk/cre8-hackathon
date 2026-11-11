-- CRE8 ATP off-chain schema, migration 0014.
--
-- portfolio_snapshots: 記「這一輪之前 / 之後」各一張快照，並連回 operations。
--
-- Why this file exists
--   排程器只算、只送交易，**不留持倉的稽核軌跡**。實際後果：2026-11-08 要回答「#305 上一輪到底換了
--   多少、總值掉了多少」時，DB 裡查不到任何一筆 #305 的快照（portfolio_snapshots 0 列），而 fork 的
--   歷史在 `refresh-anvil.sh` 的 loadState 之後就沒了 —— 那個問題最後驗不掉。
--
--   真鏈上也一樣：使用者問「為什麼我的錢少了」，答案不能是「自己去區塊瀏覽器查」。
--   每次 op 前後各寫一張快照，就能回答：漂移從 X 變成 Y、總值差多少、哪些資產變了。
--
-- 快照的真相是**鏈上餘額**（`readPositions` → `balanceOf`），不是事件累加
--   事件累加要求「一個 Transfer 都沒漏」：掃描中斷一小時，餘額就安靜地錯下去，而且不會報錯。
--   fee-on-transfer / rebasing / delegatecall 改 storage 的 token 也跟不上事件模型。
--   所以 `holdings-scan.ts` 保持它原本的角色（未知持倉偵測），不升級成餘額的真相。
--   快照記的是「那一刻 balanceOf 是多少」，可以拿去跟事件累加對帳 —— 不一致就是有人漏了。
--
-- Why the primary key changes
--   原本 PK 是 (portfolio_id, block)：一個塊一張。但同一輪的 before/after 可能是同一塊
--   （送出後下一個塊才落地時是不同塊，但重送或同塊多筆時會撞），撞了就是靜默覆蓋 ——
--   而「覆蓋掉 before」正好是稽核最不能弄丟的那一張。
--   phase 進 PK 之後，(portfolio, block, phase) 才是「一張快照」的真正身分。
--
-- Conventions
--   * phase: 'manual'（CLI 手動 index）| 'before'（送出前）| 'after'（落地後）。
--     預設 'manual' 讓既有寫入路徑不必改就能繼續運作。
--   * operation_id 可為 NULL：手動 index 沒有對應的 operation。指向的列被刪時 SET NULL
--     （快照是觀測事實，不該因為 operation 被清掉而消失）。
--   * before/after 是同一個 idempotency_key 的兩張快照，所以「這一輪做了什麼」＝ 兩張的差。

alter table portfolio_snapshots
  add column phase        text   not null default 'manual',
  add column operation_id bigint references operations (id) on delete set null;

alter table portfolio_snapshots
  add constraint portfolio_snapshots_phase_valid
    check (phase in ('manual', 'before', 'after'));

-- 同一個 (portfolio, block) 原本只能一張；現在一個塊最多三張（manual/before/after）。
alter table portfolio_snapshots drop constraint portfolio_snapshots_pkey;
alter table portfolio_snapshots
  add constraint portfolio_snapshots_pkey primary key (portfolio_id, block, phase);

-- 「這個投組最近的快照」是最常問的問題（稽核與前端歷史），沒有索引會全表掃。
create index portfolio_snapshots_history_idx
  on portfolio_snapshots (portfolio_id, created_at desc);

comment on column portfolio_snapshots.phase is
  'manual = CLI 手動 index；before = 這一輪送出前；after = 這一輪落地後（同 operation_id 的兩張互為前後）';
comment on column portfolio_snapshots.operation_id is
  '對應的 operations 列；manual index 為 NULL。before/after 共用同一個 operation_id';
