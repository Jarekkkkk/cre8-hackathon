-- CRE8 ATP off-chain schema, migration 0004.
--
-- enrollment_intents: the timestamp policy's `validUntil` an enrollment used, pinned BEFORE any
-- on-chain action.
--
-- Why this table exists
--   The Kernel smart-account address is derived from the account's init code, and the init code
--   carries `initConfig`, which installs the session-key permissions — including the timestamp
--   policy's `validUntil`. The default is `now + 365 days`, so two enrollments of the same
--   (owner, strategyId) one second apart derive two DIFFERENT addresses. If the deploy + enroll tx
--   succeed and the DB write then fails, the retry lands on a second account: the first one stays
--   on chain, fully permissioned and registered in AtpRegistry, invisible to the DB and impossible
--   to reclaim (we hold no sudo key for it).
--
--   So `validUntil` is persisted once, first, and every retry reads it back. That makes the address
--   a pure function of (owner, strategyId, validUntil) — reconstructible from the DB alone, which is
--   what `session_keys.permissions.timestamp.validUntil` must therefore agree with.
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.
--
-- Conventions
--   * user_id holds the owning EOA lowercase, matching portfolios.user_id.
--   * There is deliberately NO foreign key to strategies: the row must be writable before (and
--     independently of) the portfolio it is about, and it is keyed by on-chain identity
--     (strategy_id + chain_id), not by a portfolio row.

create table enrollment_intents (
  user_id     text   not null,
  strategy_id bigint not null,
  chain_id    bigint not null,
  valid_until bigint not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, strategy_id, chain_id),
  constraint enrollment_intents_user_lowercase check (user_id = lower(user_id)),
  constraint enrollment_intents_valid_until_positive check (valid_until > 0)
);

comment on table enrollment_intents is
  'One pinned timestamp-policy validUntil per (owner, strategy, chain), written before the deploy tx so a retry rebuilds the same smart-account address instead of orphaning the first one.';
comment on column enrollment_intents.user_id is
  'Owning EOA, always lowercase (enrollment_intents_user_lowercase); matches portfolios.user_id.';
comment on column enrollment_intents.valid_until is
  'Unix seconds, uint48 on chain. Must equal session_keys.permissions.timestamp.validUntil once the enroll lands: it is the only non-deterministic input to the account address.';
comment on column enrollment_intents.created_at is
  'When the intent was pinned. Never updated: a row here means "this enrollment already chose its address".';
