-- CRE8 ATP off-chain schema, migration 0019.
--
-- Elon Universe 的成分資產（含 DOGE）。
--
-- Why this file exists
--   0007 只 seed 了 USDT 與 WBNB。其餘成分資產原本是開發時用 SQL 直接插進本機 DB 的 ——
--   於是**全新環境（主生產）沒有這些列**，create fund 的資產選單是空的、drift 也算不出來。
--   把它們寫成 migration 之後，任何新環境一啟動就是完整的。
--
-- 三個容易錯的地方
--   1. **DOGE 是 8 位小數，其他都是 18。** `src/drift.ts` 用這裡的 decimals 換算 wei → 數量，
--      漏掉這個欄位就會用預設 18 —— 價格會錯 10^10 倍，而畫面上只會看到「價值看起來不對」。
--   2. `usdt_pool` / `pool_fee` 必須是**有流動性**的池子。DOGE 曾綁到 fee=500 的池
--      （0x8D59…），那個池子在主網 liquidity 是 0 → 報價爆掉 → 每次再平衡都
--      `V3TooLittleReceived`。這裡用的是 fee=10000 的池（liquidity 2.44e19），
--      與主網上已註冊的 oracle 綁的是同一個池。
--   3. 池子位址是**主網真實位址**，與 `deployments/mainnet.json` 的 oracle 一致。
--      換鏈時這整份都要換，不能沿用。
--
-- 與鏈上的對應關係
--   每一列都應該有一個 PancakeV3TwapOracle 註冊在 AtpMultiPoolOracle 上
--   （oracle 的 pool 參數＝這裡的 usdt_pool、fee 相同）。只加 DB 而不註冊 oracle，
--   executor 會在 `_checkStep` 的 re-quote 失敗。

BEGIN;

insert into priceable_assets (address, symbol, decimals, usdt_pool, pool_fee, is_numeraire) values
  -- bStock：TSLA / SPCX。兩者對 USDT 的池子都是 fee 2500。
  ('0x5b1910eaad6450e50f816082aa078c41f10c292f', 'TSLAB', 18,
   '0xb0f5e5400e8f0f7c242f2b7740c004f020579c41', 2500, false),
  ('0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1', 'SPCXB', 18,
   '0x977daffc095b33872e2741c19568925015c35b4d', 2500, false),
  -- BTCB / ETH：fee 500 的深池。
  ('0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', 'BTCB', 18,
   '0x46cf1cf8c69595804ba91dfdd8d6b960c9b0a7c4', 500, false),
  ('0x2170ed0880ac9a755fd29b2688956bd959f933f8', 'ETH', 18,
   '0xbe141893e4c6ad9272e8c04bab7e6a10604501a5', 500, false),
  -- ⚠ DOGE：8 位小數；池子用 fee 10000（fee 2500 的池子兩個方向報價差 20 倍，fee 500 是死池）。
  ('0xba2ae424d960c26247dd6c32edc70b295c744c43', 'DOGE', 8,
   '0x89da4102853c6cf3f4e9979cbb1dc4a166f38e84', 10000, false),
  -- NVDAB：目前不在 Elon Universe 的成分裡，但選單需要它（範例基金會用到）。
  ('0x02fca66c1d1afb4e2a7884261eb00f63598a7436', 'NVDAB', 18,
   '0x8fb4243b553ac29ba088acf00b9b7da24bd6690c', 2500, false)
on conflict (address) do update set
  symbol    = excluded.symbol,
  decimals  = excluded.decimals,
  usdt_pool = excluded.usdt_pool,
  pool_fee  = excluded.pool_fee,
  enabled   = true;

COMMENT ON COLUMN priceable_assets.decimals IS
  '代幣小數位。DOGE 是 8，其餘（bStock/BTCB/ETH/USDT）是 18 —— drift 用它換算 wei，錯一位就錯一個數量級。';

COMMIT;
