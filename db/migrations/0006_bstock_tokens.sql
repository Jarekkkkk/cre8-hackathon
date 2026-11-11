-- CRE8 ATP off-chain schema, migration 0006.
--
-- bstock_tokens：bStock（代幣化美股）標的白名單。
--
-- 為什麼需要這張表
--   bStock 沒有官方 token list。發行方只提供 HTML 頁面，沒有可以程式化讀取的 JSON、沒有
--   AtpRegistry 之類的鏈上名錄，也沒有 BscScan 的 verified-token 清單性質的東西。也就是說
--   「哪個 address 是 bStock、symbol 是什麼、小數幾位、對 USDT 的池在哪」這幾件事，鏈上問不到，
--   只能自己維護一份白名單。
--   把它做成資料表而不是程式裡的常數陣列，是因為發行方會持續上新 ticker：新增一個標的應該是
--   一筆 INSERT，而不是改程式、跑測試、重新部署。同時 planner 與 drift 計算只認這張表裡的 address，
--   使用者自己買的其他代幣（或冒充 bStock 的假幣）不會被當成目標資產。
--
-- 命名慣例
--   * symbol 是 <TICKER>B，不是 b<TICKER>：TSLAB、NVDAB、CRCLB。程式不靠 symbol 判斷，
--     但顯示與人工核對用得到。
--   * usdt_pool / pool_fee 是「對 USDT 的 PancakeSwap V3 池」與它的 fee tier。兩者必須同時有或
--     同時沒有（bstock_tokens_pool_paired）：有池才能報價與換回 USDT，沒有池的標的目前無法交易。
--   * address 與 usdt_pool 一律小寫 0x + 40 hex，與 0001 的慣例一致。
--   * 不存價格、不存鏈上即時狀態：這張表只回答「這個 address 是不是我們認得的 bStock」。
--
-- 種入的 4 筆都是實際查證過 address 存在的代幣（全部 18 位小數）。只有 NVDAB 查證過 USDT 池，
-- 其餘三個的池尚未查證，因此 usdt_pool/pool_fee 留 NULL：寧可標成「還沒找到池」，也不要填一個
-- 沒驗證過的地址讓報價讀到錯的池。
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.

create table bstock_tokens (
  address    text        primary key,
  symbol     text        not null,
  decimals   smallint    not null,
  usdt_pool  text,
  pool_fee   integer,
  enabled    boolean     not null default true,
  created_at timestamptz not null default now(),
  constraint bstock_tokens_address_lowercase check (address ~ '^0x[0-9a-f]{40}$'),
  constraint bstock_tokens_symbol_shape check (symbol = btrim(symbol) and length(symbol) between 1 and 32),
  constraint bstock_tokens_symbol_key unique (symbol),
  constraint bstock_tokens_decimals_range check (decimals between 1 and 36),
  constraint bstock_tokens_usdt_pool_lowercase check (usdt_pool is null or usdt_pool ~ '^0x[0-9a-f]{40}$'),
  constraint bstock_tokens_pool_fee_allowed check (pool_fee is null or pool_fee in (100, 500, 2500, 10000)),
  constraint bstock_tokens_pool_paired check ((usdt_pool is null) = (pool_fee is null))
);

comment on table bstock_tokens is
  'bStock 標的白名單，自建：發行方沒有官方 token list（只有 HTML 頁面），鏈上也沒有名錄可查，所以「哪些 address 是目標資產」只能存在這裡。新增標的是一筆 INSERT，不必改程式。';
comment on column bstock_tokens.address is
  'bStock 合約地址，小寫 0x + 40 hex。planner 與 drift 只認這裡列出的 address。';
comment on column bstock_tokens.symbol is
  '顯示用 ticker，慣例是 <TICKER>B（TSLAB、NVDAB、CRCLB），不是 b<TICKER>。唯一：一個 symbol 只能對到一個地址。';
comment on column bstock_tokens.decimals is
  '代幣小數位。目前查證過的 bStock 全部是 18；仍逐列儲存，因為把 18 寫死在程式裡正是這種白名單要避免的假設。';
comment on column bstock_tokens.usdt_pool is
  '對 USDT 的 PancakeSwap V3 池地址，小寫；NULL = 尚未查證到池（目前無法報價／換回 USDT）。與 pool_fee 必須同時有或同時沒有。';
comment on column bstock_tokens.pool_fee is
  '該池的 PancakeSwap V3 fee tier（1e-6 單位：100 | 500 | 2500 | 10000），與 usdt_pool 成對。';
comment on column bstock_tokens.enabled is
  'false = 停止使用這個標的（下架、地址有問題），但保留歷史列讓舊快照還對得上 symbol。不要用 DELETE 表達下架。';

insert into bstock_tokens (address, symbol, decimals, usdt_pool, pool_fee) values
  -- 已查證的池：NVDAB/USDT PancakeSwap V3，fee 2500（0.25%）。
  ('0x02fca66c1d1afb4e2a7884261eb00f63598a7436', 'NVDAB', 18,
   '0x8fb4243b553ac29ba088acf00b9b7da24bd6690c', 2500),
  ('0x5b1910eaad6450e50f816082aa078c41f10c292f', 'TSLAB', 18, null, null),
  ('0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699', 'MUB',   18, null, null),
  ('0x80f3d493ebce97e343c53d29a137942416b4ffc0', 'CRCLB', 18, null, null)
on conflict (address) do nothing;
