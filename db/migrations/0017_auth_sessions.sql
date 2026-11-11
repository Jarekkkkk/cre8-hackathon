-- CRE8 ATP off-chain schema, migration 0017.
--
-- auth_sessions: 把登入 session 從進程記憶體搬到 Postgres。
--
-- Why this file exists
--   `src/auth.ts` 原本把 token 放在 `#sessions = new Map(...)`。兩個實際後果：
--     1. **backend 一重啟，所有人被登出。** 開發時每改一次程式就要重新登入；
--        生產部署（rolling restart）等於每次上線清空所有 session。
--     2. **多實例完全不能用。** A 發的 token，B 不認識 —— 部署超過一個實例就隨機 401。
--
-- 設計
--   * 存的是 **sha256(token)**，不是 token 本身。資料庫備份或一次 SELECT 洩漏，都不等於拿到
--     可用的 session（token 只在發出的那一次出現在 HTTP 回應裡）。
--   * `expires_at` 由應用程式算好寫入（與 SESSION_TTL_MS 同一個來源），查詢時用 `now()` 比較。
--   * 過期列由應用程式在寫入路徑順手清（`prune`）；另外建索引讓那個 DELETE 不必全表掃。
--   * nonce **不搬**：它 5 分鐘就過期、只在同一次登入流程內有效，放進 DB 只增加寫入量而沒有好處。

create table auth_sessions (
  token_hash text        primary key,
  wallet     text        not null,
  issued_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint auth_sessions_wallet_shape check (wallet = lower(wallet) and length(wallet) = 42)
);

create index auth_sessions_expiry_idx on auth_sessions (expires_at);

comment on table auth_sessions is
  'SIWE session tokens, stored as sha256(token). Replaces the in-memory map so restarts and multiple instances keep sessions.';
