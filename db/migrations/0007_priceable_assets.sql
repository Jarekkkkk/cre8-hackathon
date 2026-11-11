-- CRE8 ATP off-chain schema, migration 0007.
--
-- priceable_assets：bstock_tokens 改名，並補上 numeraire（定價幣）。不改 0006 一個字。
--
-- 為什麼要改（兩個死角）
--
-- ① 表名說謊了。這張表原本只放 bStock；現在要放 WBNB 與 USDT——portfolio 5 的目標就是這兩個，
--    而「哪些地址有價格、價格從哪來」這件事對它們與對 bStock 完全是同一個問題。一張叫
--    bstock_tokens 的表裡躺著 WBNB，下一個讀者一定會誤讀成「這不是目標資產」。
--    改名的成本現在最低：表才建立一天，引用它的是 backend/src/snapshot.ts（一句 SQL）與兩支測試。
--
-- ② 沒有 numeraire 這個概念，定價幣只能被當成「無池 → 無價」。USDT 是報價單位本身：
--    1 USDT = 1 USDT 是**定義**，不是猜測，也不該去問池子（問了也只會問出別的東西：這條鏈上
--    USDT/WBNB 那個池解出來的價格是「1 USDT 值多少 WBNB」，不是 1）。可是 USDT 正好是 portfolio 5
--    的目標之一，於是帳戶一持有 USDT，planner 就會因為「持有但無價」拒算漂移——安全，但整個
--    索引器對唯一存在的策略失效。欄位化之後，「numeraire 直接給 1e8」是資料，不是程式裡的 if。
--
-- 命名慣例（沿用 0006，只換表名）
--   * address 與 usdt_pool 一律小寫 0x + 40 hex。
--   * usdt_pool / pool_fee 仍然成對（priceable_assets_pool_paired），但 numeraire 例外：
--     is_numeraire 為 true 時兩者都必須是 NULL（priceable_assets_numeraire_has_no_pool）——
--     numeraire 不需要池，給了池反而會讓人以為它要靠 TWAP 報價。
--   * 約束與索引一併改名（bstock_tokens_* → priceable_assets_*）：約束名會出現在錯誤訊息與
--     `\d` 的輸出裡，留著舊名字等於把改名的效果抵銷掉一半。
--
-- 兩筆種入的資料都是查證過的（兩者都是 18 位小數，鏈上讀得到）：
--   * USDT 0x55d398326f99059ff775485246999027b3197955（Binance-Peg BSC-USD）＝ numeraire，無池。
--   * WBNB 0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c ＝ 用 PancakeSwap V3 WBNB/USDT 池報價，
--     fee tier 500。這正是鏈上 oracle 用的那個池，pricing.ts 的交叉驗證對它算出 0 ppm 一致，
--     所以 WBNB 走現成管線就有價格，不必新增任何定價程式。
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.

-- ---------------------------------------------------------------------------
-- 1. 改名（表 + 所有約束，約束改名會連帶把它的索引一起改）。
-- ---------------------------------------------------------------------------
alter table bstock_tokens rename to priceable_assets;

alter table priceable_assets rename constraint bstock_tokens_pkey to priceable_assets_pkey;
alter table priceable_assets rename constraint bstock_tokens_address_lowercase to priceable_assets_address_lowercase;
alter table priceable_assets rename constraint bstock_tokens_symbol_shape to priceable_assets_symbol_shape;
alter table priceable_assets rename constraint bstock_tokens_symbol_key to priceable_assets_symbol_key;
alter table priceable_assets rename constraint bstock_tokens_decimals_range to priceable_assets_decimals_range;
alter table priceable_assets rename constraint bstock_tokens_usdt_pool_lowercase to priceable_assets_usdt_pool_lowercase;
alter table priceable_assets rename constraint bstock_tokens_pool_fee_allowed to priceable_assets_pool_fee_allowed;
alter table priceable_assets rename constraint bstock_tokens_pool_paired to priceable_assets_pool_paired;

-- ---------------------------------------------------------------------------
-- 2. numeraire。
-- ---------------------------------------------------------------------------
alter table priceable_assets
  add column is_numeraire boolean not null default false,
  add constraint priceable_assets_numeraire_has_no_pool
    check (not is_numeraire or (usdt_pool is null and pool_fee is null));

-- ---------------------------------------------------------------------------
-- 3. COMMENT：這張表現在回答的是「哪些資產有價格、價格從哪裡來」。
--    舊的 COMMENT 只講 bStock，留著會和表名一起誤導人。
-- ---------------------------------------------------------------------------
comment on table priceable_assets is
  '可定價資產白名單：bStock（代幣化美股）加上定價幣（USDT、WBNB）。自建的理由見 0006：發行方沒有官方 token list、鏈上也沒有名錄，所以「哪些 address 有價格、價格從哪來」只能存在這裡。新增標的是一筆 INSERT，不必改程式。drift 與 planner 只認這裡列出的 address。';
comment on column priceable_assets.address is
  '資產合約地址，小寫 0x + 40 hex。planner 與 drift 只認這裡列出的 address；查不到價格的持倉會擋下整份漂移報告。';
comment on column priceable_assets.symbol is
  '顯示用 ticker。bStock 慣例是 <TICKER>B（TSLAB、NVDAB、CRCLB），定價幣用自己的名字（USDT、WBNB）。唯一：一個 symbol 只能對到一個地址。';
comment on column priceable_assets.decimals is
  '代幣小數位（目前全部 18）。仍逐列儲存，因為把 18 寫死在程式裡正是這種白名單要避免的假設。';
comment on column priceable_assets.usdt_pool is
  '對 USDT 的 PancakeSwap V3 池地址，小寫；NULL = 沒有池（尚未查證到，或 numeraire 根本不需要）。與 pool_fee 必須同時有或同時沒有。';
comment on column priceable_assets.pool_fee is
  '該池的 PancakeSwap V3 fee tier（1e-6 單位：100 | 500 | 2500 | 10000），與 usdt_pool 成對。只是說明用：報價讀的是 usdt_pool 的地址，不是這個數字。';
comment on column priceable_assets.is_numeraire is
  'true = 這是報價單位本身（USDT）：1 顆永遠 = 1e8 定點下的 1 USDT，是定義不是報價，所以不需要 usdt_pool/pool_fee（約束禁止兩者同時有）。false 的資產必須有池才能定價。';
comment on column priceable_assets.enabled is
  'false = 停止使用這個資產（下架、地址有問題），但保留歷史列讓舊快照還對得上 symbol。不要用 DELETE 表達下架。';

-- ---------------------------------------------------------------------------
-- 4. 定價幣。地址全部小寫；已鏈上查證兩者都是 18 位小數。
-- ---------------------------------------------------------------------------
insert into priceable_assets (address, symbol, decimals, usdt_pool, pool_fee, is_numeraire) values
  -- 報價單位本身：不需要池，價格是定義（1 USDT = 1e8）。
  ('0x55d398326f99059ff775485246999027b3197955', 'USDT', 18, null, null, true),
  -- WBNB/USDT PancakeSwap V3，fee 500。與鏈上 oracle 用的是同一個池，交叉驗證 0 ppm 一致。
  ('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', 'WBNB', 18,
   '0x36696169c63e42cd08ce11f5deebbcebae652050', 500, false)
on conflict (address) do nothing;
