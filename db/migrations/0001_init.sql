-- CRE8 ATP off-chain schema, migration 0001 (plan §7).
--
-- How this file is applied
--   * backend/src/db.ts (migrate()) runs every *.sql in db/migrations in filename order,
--     one transaction per file, and records the filename + sha256 in schema_migrations.
--   * Therefore: do NOT write BEGIN/COMMIT here, and do NOT use CREATE INDEX CONCURRENTLY.
--     The migration itself must be idempotent-free (it runs exactly once).
--
-- Conventions
--   * Money, weights and quantities are numeric, never float: TWR and USD marks are exact decimals.
--   * EVM addresses are stored lowercase (0x + 40 hex); the backend normalises before insert.
--   * swap_fee_bps is bounded by 300 on purpose: AtpRegistry.MAX_SWAP_FEE_BPS is 3% on chain.
--   * bigserial/int8 values come back from node-postgres as strings; the backend casts ids to number
--     (safe: ids are far below 2^53), while numeric columns stay strings end to end.
--
-- §7 tables: strategies / strategy_versions / portfolios / smart_accounts / session_keys /
--            operations / positions_snapshots / performance.

-- ---------------------------------------------------------------------------
-- strategies: a provider's published strategy (metadata + swap fee).
-- ---------------------------------------------------------------------------
create table strategies (
  id           bigserial   primary key,
  provider     text        not null,
  name         text        not null,
  description  text        not null default '',
  is_public    boolean     not null default true,
  swap_fee_bps smallint    not null default 0,
  created_at   timestamptz not null default now(),
  constraint strategies_swap_fee_bps_range check (swap_fee_bps between 0 and 300)
);

comment on table strategies is
  'ATP strategy metadata. Immutable fields live in strategy_versions; a provider changes weights by publishing a new version.';
comment on column strategies.provider is
  'Provider identity (wallet address or registered provider id). No auth layer yet: the API trusts the caller.';
comment on column strategies.is_public is
  'Public strategies are listed by GET /strategies; private ones are still readable by id.';
comment on column strategies.swap_fee_bps is
  'Output-side swap fee in basis points, 0-300 (matches AtpRegistry.MAX_SWAP_FEE_BPS).';

-- ---------------------------------------------------------------------------
-- strategy_versions: append-only history of allocation + schedule.
-- ---------------------------------------------------------------------------
create table strategy_versions (
  strategy_id bigint      not null references strategies (id) on delete cascade,
  version     int         not null,
  allocation  jsonb       not null,
  schedule    jsonb       not null,
  change_log  text,
  active_at   timestamptz,
  created_at  timestamptz not null default now(),
  constraint strategy_versions_pkey primary key (strategy_id, version),
  constraint strategy_versions_version_positive check (version > 0),
  -- Shape mirrors src/strategies.ts: { assets: [{ address, symbol?, weightBps }] } summing to 10000.
  constraint strategy_versions_allocation_shape check (
    jsonb_typeof(allocation) = 'object'
    and jsonb_typeof(allocation -> 'assets') = 'array'
  ),
  -- Off-chain encoding of the rebalance schedule: interval or cron (see src/strategies.ts).
  constraint strategy_versions_schedule_shape check (jsonb_typeof(schedule) = 'object')
);

comment on table strategy_versions is
  'Append-only strategy versions, 1-based. UNIQUE(strategy_id, version) is the primary key; a published version is never edited.';
comment on column strategy_versions.allocation is
  'Asset weights in basis points: {"assets":[{"address":"0x...","symbol":"AAPLB","weightBps":2500}]}; weights sum to 10000.';
comment on column strategy_versions.schedule is
  'Rebalance schedule: {"kind":"interval","intervalSeconds":86400} or {"kind":"cron","cron":"0 0 * * *"}.';
comment on column strategy_versions.active_at is
  'First instant this version may be executed. NULL means "not scheduled yet"; publishVersion() sets now() by default.';

-- ---------------------------------------------------------------------------
-- portfolios: one user's enrollment in one strategy version.
-- ---------------------------------------------------------------------------
create table portfolios (
  id             bigserial   primary key,
  user_id        text        not null,
  strategy_id    bigint      not null references strategies (id) on delete restrict,
  version        int         not null,
  schedule_state text        not null default 'idle',
  created_at     timestamptz not null default now()
);

comment on table portfolios is
  'A user''s portfolio: pins one strategy version. Re-enrolling creates a new row; never mutates the pinned version.';
comment on column portfolios.schedule_state is
  'Keeper-side schedule state, e.g. idle | active | paused. Text on purpose until the state machine is frozen.';

-- Indexes required by plan §7.
create index portfolios_strategy_id_idx on portfolios (strategy_id);

-- NOTE: version is intentionally NOT part of a composite FK to strategy_versions yet.
--       See "TODO" in db/README.md: adding (strategy_id, version) -> strategy_versions would
--       make a typo'd version fail at insert time instead of at the first keeper run.

-- ---------------------------------------------------------------------------
-- smart_accounts: one non-custodial smart account per portfolio per chain.
-- ---------------------------------------------------------------------------
create table smart_accounts (
  portfolio_id bigint not null references portfolios (id) on delete cascade,
  chain_id     bigint not null,
  address      text   not null,
  owner        text   not null,
  account_type text   not null,
  constraint smart_accounts_chain_address_key unique (chain_id, address),
  constraint smart_accounts_chain_id_positive check (chain_id > 0),
  constraint smart_accounts_address_lowercase_hex check (address ~ '^0x[0-9a-f]{40}$')
);

comment on table smart_accounts is
  'Deployed smart accounts. UNIQUE(chain_id, address) keeps one account from serving two portfolios on the same chain.';
comment on column smart_accounts.owner is
  'Controlling owner (EOA or deployer). Stored lowercase; left unconstrained because owner may be a contract.';
comment on column smart_accounts.account_type is
  'Account implementation family, e.g. erc4337 | safe | kernel.';

create index smart_accounts_portfolio_id_idx on smart_accounts (portfolio_id);

-- ---------------------------------------------------------------------------
-- session_keys: only a reference to the signer key. The key itself NEVER enters the DB.
-- ---------------------------------------------------------------------------
create table session_keys (
  portfolio_id bigint      not null references portfolios (id) on delete cascade,
  key_ref      text        not null,
  permissions  jsonb       not null default '{}'::jsonb,
  expires_at   timestamptz not null,
  status       text        not null default 'active',
  revoked_at   timestamptz,
  constraint session_keys_key_ref_key unique (key_ref),
  constraint session_keys_status_valid check (status in ('active', 'revoked', 'expired')),
  constraint session_keys_revocation_consistent check (revoked_at is null or status = 'revoked')
);

comment on table session_keys is
  'Session key metadata only. key_ref is an opaque KMS reference; private key material lives in KMS and 金鑰在 KMS，絕不進 DB. Never add a private key, seed or encrypted-key column here.';
comment on column session_keys.key_ref is
  'Opaque KMS key id/handle (e.g. aws-kms://...). Unique so one signer cannot be attached twice.';
comment on column session_keys.permissions is
  'Signed scope, e.g. {"targets":["0x..."],"selectors":["0x..."],"maxValueWei":"..."}; shape owned by the signer.';
comment on column session_keys.revoked_at is
  'Set when the key is revoked; must be non-NULL iff status = revoked.';

create index session_keys_portfolio_id_idx on session_keys (portfolio_id);

-- ---------------------------------------------------------------------------
-- operations: idempotency + audit trail for every state-changing action.
-- ---------------------------------------------------------------------------
create table operations (
  id              bigserial   primary key,
  portfolio_id    bigint      not null references portfolios (id) on delete cascade,
  type            text        not null,
  state           text        not null default 'pending',
  idempotency_key text        not null,
  correlation_id  text,
  payload_hash    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint operations_idempotency_key_key unique (idempotency_key)
);

comment on table operations is
  'Durable operation log. idempotency_key is what makes POST retries safe; state is the keeper/executor lifecycle.';
comment on column operations.type is
  'Operation kind, e.g. rebalance | enroll | revoke_session_key | withdraw.';
comment on column operations.state is
  'Lifecycle state, e.g. pending | submitted | confirmed | failed | reverted. No CHECK yet: the state machine is not frozen.';
comment on column operations.payload_hash is
  'Hash of the canonical request/transaction payload (hex), so the audit trail can be re-verified without storing the payload.';
comment on column operations.updated_at is
  'Maintained by the application (no trigger yet). Use it as the optimistic-concurrency token once a writer flips state.';

-- Index required by plan §7.
create index operations_portfolio_state_idx on operations (portfolio_id, state);

-- ---------------------------------------------------------------------------
-- positions_snapshots: point-in-time marks, one row per asset per block.
-- ---------------------------------------------------------------------------
create table positions_snapshots (
  portfolio_id bigint         not null references portfolios (id) on delete cascade,
  asset        text           not null,
  amount       numeric(38, 18) not null,
  usd_value    numeric(38, 18),
  block        bigint         not null,
  ts           timestamptz    not null default now()
);

comment on table positions_snapshots is
  'Per-block position marks. amount is token units (18 decimals); usd_value may be NULL when no reliable price exists.';
comment on column positions_snapshots.block is
  'BNB Chain block number (chain 56 by default) the snapshot was taken at.';

-- Not required by §7, but every read is "latest marks for a portfolio".
create index positions_snapshots_portfolio_block_idx on positions_snapshots (portfolio_id, block desc);

-- ---------------------------------------------------------------------------
-- performance: TWR series, per strategy or per portfolio.
-- ---------------------------------------------------------------------------
create table performance (
  strategy_id  bigint         not null references strategies (id) on delete cascade,
  portfolio_id bigint         references portfolios (id) on delete cascade,
  period       text           not null,
  twr          numeric(18, 8) not null,
  since        timestamptz    not null
);

comment on table performance is
  'Time-weighted return series. portfolio_id NULL means "strategy-wide"; a row with portfolio_id is that portfolio''s own series.';
comment on column performance.period is
  'Window label (1d/7d/30d/90d/all). Named period because WINDOW is a PostgreSQL reserved word.';
comment on column performance.twr is
  'Time-weighted return as a decimal ratio (0.0123 = +1.23%), not a percentage.';
comment on column performance.since is
  'Start instant of the window the row was computed for.';

-- Not required by §7; supports "series for strategy X in window W, newest first".
create index performance_strategy_period_idx on performance (strategy_id, period, since desc);
