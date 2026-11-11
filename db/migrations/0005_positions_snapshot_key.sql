-- CRE8 ATP off-chain schema, migration 0005.
--
-- positions_snapshots: give the per-block mark the key it was missing, and record where its USD
-- value came from.
--
-- Why this file exists
--   (a) The table had no key at all. A row means "one asset at one block", but nothing enforced
--       that: re-running a snapshot write for the same block appends a second row, drift is then
--       computed over the same holding twice, and a weight comes out wrong with nothing failing.
--       db/README.md listed this gap; this file closes it with UNIQUE (portfolio_id, asset, block),
--       which is also the target of the writer's `on conflict (portfolio_id, asset, block)`.
--   (b) usd_value is nullable, but nothing recorded its provenance: a mark taken from a pool quote
--       and a mark taken from a spreadsheet look identical afterwards, so a bad price cannot be
--       traced back to its source and cannot be re-derived. Two columns fix that: price_source
--       (free text, so another venue or quoting method needs no migration) and priced_at.
--
-- Conventions
--   * This table is derived data (marks recomputed from chain), so a duplicate row is a re-run
--     artefact rather than evidence; the dedupe below keeps one row per group and drops the rest.
--     It is a no-op on a clean database and on the local development database (checked: 0 rows).
--   * When duplicates disagree, the newest row wins: greatest ts, tie-broken by ctid (the physical
--     row id, unique per row, so exactly one survivor remains per group even at equal ts). Rows of
--     the same (portfolio_id, asset, block) are the same mark written twice; the last write is the
--     one the writer meant to keep.
--   * price_source is lowercase free text, e.g. 'pancakeswap-v3' | 'legacy-unknown'. usd_value and
--     its provenance are all-or-nothing (positions_snapshots_price_provenance): an unpriced row has
--     all three NULL, a priced row has all three set.
--   * Rows priced before this migration get price_source = 'legacy-unknown' and priced_at = ts, i.e.
--     "we know when the snapshot was taken, we do not know what the price was derived from".
--   * There is deliberately NO snapshot_id column: the group of rows that form one snapshot is
--     already identified by (portfolio_id, block). A surrogate id would only make sense together
--     with a snapshot header table (provider, block hash, how it was read); adding the id alone
--     would be a sequence number nothing references.
--
-- Same rules as 0001: no BEGIN/COMMIT (the runner wraps each file in one transaction), no
-- CREATE INDEX CONCURRENTLY, and the file runs exactly once.

-- 1. Dedupe before adding the key. Safe to run against an empty table; on a populated one it keeps
--    the newest row of every (portfolio_id, asset, block) group.
delete from positions_snapshots ps
using positions_snapshots dup
where ps.portfolio_id = dup.portfolio_id
  and ps.asset = dup.asset
  and ps.block = dup.block
  and (ps.ts, ps.ctid) < (dup.ts, dup.ctid);

-- 2. Price provenance.
alter table positions_snapshots
  add column price_source text,
  add column priced_at    timestamptz;

-- 3. Backfill existing priced rows so the CHECK below can be added: their source is genuinely
--    unknown, their observation time is the snapshot time.
update positions_snapshots
   set price_source = 'legacy-unknown',
       priced_at    = ts
 where usd_value is not null
   and price_source is null;

-- 4. Key + invariants.
alter table positions_snapshots
  add constraint positions_snapshots_price_source_shape
    check (price_source is null or (price_source = lower(price_source) and length(price_source) between 1 and 64)),
  add constraint positions_snapshots_price_provenance
    check (
      (usd_value is null and price_source is null and priced_at is null)
      or (usd_value is not null and price_source is not null and priced_at is not null)
    ),
  add constraint positions_snapshots_portfolio_asset_block_key
    unique (portfolio_id, asset, block);

comment on column positions_snapshots.price_source is
  'Where usd_value came from (lowercase free text, e.g. pancakeswap-v3 | legacy-unknown). NULL exactly when usd_value is NULL: a priced mark must stay traceable.';
comment on column positions_snapshots.priced_at is
  'When the price behind usd_value was observed (the quote instant, not the insert instant). NULL exactly when usd_value is NULL.';
