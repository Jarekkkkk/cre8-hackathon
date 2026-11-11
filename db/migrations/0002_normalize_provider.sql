-- CRE8 ATP off-chain schema, migration 0002.
--
-- Provider identity becomes lowercase everywhere. Two reasons:
--   * EVM addresses are case-insensitive; EIP-55 checksum casing is cosmetic and must not split
--     one wallet into several distinct `provider` values.
--   * The API filter (GET /strategies?provider=…) is case-insensitive, so an exact index match on
--     a lowercase column gives the same answer as `lower(provider) = lower($1)` but stays
--     index-friendly.
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.
--
-- Writes: backend/src/strategies.ts lowercases the provider in validateCreateStrategyInput(), so
-- a mixed-case insert can never reach the constraint below.

-- 1. Normalise rows written before this migration existed.
update strategies
   set provider = lower(provider)
 where provider <> lower(provider);

-- 2. Make lowercase the only storable form, for every future insert and update.
alter table strategies
  add constraint strategies_provider_lowercase check (provider = lower(provider));

comment on column strategies.provider is
  'Provider identity (wallet address or registered provider id), always lowercase. Enforced by strategies_provider_lowercase; the API lowercases session wallets before writing.';
