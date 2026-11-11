# cre8-atp-db

The off-chain database schema for CRE8 (Postgres 15+). A standalone project holding only migrations
and documentation; the code that runs them lives in [`backend/`](../backend).

## Files

| File | Description |
| --- | --- |
| `migrations/0001_init.sql` | Initial schema: strategies/versions, portfolios, smart accounts, session keys, operations, positions, performance |
| `migrations/0002_normalize_provider.sql` | Lowercases existing `strategies.provider` values and adds the `strategies_provider_lowercase` CHECK (only lowercase from then on) |
| `migrations/0004_enrollment_intents.sql` | New table `enrollment_intents`: enrollment pins the timestamp policy's `valid_until` **before any on-chain action**, and a retry reads the same value, so a second account address can never be computed |
| `migrations/0005_positions_snapshot_key.sql` | Adds `UNIQUE (portfolio_id, asset, block)` to `positions_snapshots` (deleting duplicate rows first, keeping the newest) plus price provenance `price_source` / `priced_at` |
| `migrations/0006_bstock_tokens.sql` | New table `bstock_tokens`: an allowlist of bStock underlyings (there is no official token list, so we maintain our own), seeded with four verified tokens |
| `migrations/0007_priceable_assets.sql` | Renames `bstock_tokens` to `priceable_assets` (constraints and indexes renamed too), adds `is_numeraire` (the numeraire must have no pool), and seeds `USDT` (numeraire) and `WBNB` (fee-500 USDT pool) |
| `migrations/0008_snapshot_header.sql` | New table `portfolio_snapshots`: snapshot headers, always one row even for an empty portfolio; when `complete = false` the drift columns are pinned to 0/false by CHECK |
| `migrations/0009_holding_scan_cursor.sql` | New table `portfolio_scan_cursors`: the holding-scan cursor (`start_block` / `last_scanned_block`), plus two honesty columns on `portfolio_snapshots`: `unknown_token_count` / `universe_complete` |
| `migrations/0010_holding_candidates.sql` | New table `portfolio_holding_candidates`: **out-of-universe tokens that have ever been received** (one row per portfolio per address). It exists because one-shot detection only postpones a bug by one round — every round must re-read `balanceOf` for every row |
| `migrations/0012_scheduler.sql` | Adds schedule timestamps to `portfolios` (`next_run_at` / `last_checked_at` / `last_rebalance_at`) plus a `schedule_state` CHECK and a `(schedule_state, next_run_at)` index; adds lifecycle columns to `operations` (`tx_hash` / `user_op_hash` / `attempts` / `last_error`) plus CHECKs on `type` / `state` / `attempts` |
| `migrations/0013_scheduler_alerts.sql` | New table `scheduler_alerts` (kinds `portfolio_repeatedly_failing` / `session_key_expiring` / `gas_low`) plus a partial unique index `(kind, coalesce(portfolio_id, -1)) WHERE resolved_at IS NULL` (one unresolved row per problem) and a `(resolved_at, severity)` index (`/health` asks every round) |
| `migrations/` | All later changes are new files (`0003_xxx.sql`…); never edit an applied file |

## Running migrations

The intended path is the backend's `migrate()`: it runs `migrations/*.sql` **sorted by filename**, each
file inside one transaction, and on success writes the filename and sha256 into `schema_migrations`.
Applied files are skipped; if an applied file changed (checksum mismatch) it errors instead of silently
re-running.

```bash
cd ../backend
cp .env.example .env      # fill in DATABASE_URL
bun install
bun run migrate           # migrations only (no server)
bun run dev               # also migrates on startup
```

Applying manually with psql is only advisable on a fresh database with no `schema_migrations` rows, or
while debugging. If you apply by hand you must record it yourself, or the next backend start re-runs 0001:

```bash
cd db
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_init.sql

# tell the backend this file is applied (the checksum must match the file)
psql "$DATABASE_URL" -c "create table if not exists schema_migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);"
psql "$DATABASE_URL" -c "insert into schema_migrations (filename, checksum)
  values ('0001_init.sql', '$(shasum -a 256 migrations/0001_init.sql | cut -d' ' -f1)');"
```

Notes:

- Do **not** write `BEGIN`/`COMMIT` inside a migration (the runner already wraps it), and do not use
  `CREATE INDEX CONCURRENTLY` (it cannot run inside a transaction).
- `schema_migrations` is created by the backend; it does not belong to any migration file.
- Migrations only move forward; there are no down migrations. Recovery means restoring a backup or writing
  a corrective migration.

## Schema overview

```
strategies 1─n strategy_versions      (append-only versions, PK = (strategy_id, version))
strategies 1─n portfolios             (a portfolio pins one version)
portfolios 1─n smart_accounts         (UNIQUE(chain_id, address))
portfolios 1─n session_keys           (stores only a KMS reference, see below)
portfolios 1─n operations             (idempotency_key UNIQUE)
portfolios 1─n positions_snapshots    (one row per asset per block, UNIQUE(portfolio_id, asset, block))
portfolios 1─n portfolio_snapshots    (one header row per block, PK (portfolio_id, block); empty too)
portfolios 1─1 portfolio_scan_cursors (holding-scan cursor: how far the transfer log has been scanned)
portfolios 1─n portfolio_holding_candidates (out-of-universe tokens ever seen: once seen, always watched)
strategies 1─n performance            (portfolio_id nullable = strategy level)
priceable_assets                      (standalone allowlist, no FK: an underlying exists before a holding)
```

| Table | Key columns | Constraints / indexes |
| --- | --- | --- |
| `strategies` | `provider`, `name`, `swap_fee_bps` | `swap_fee_bps` 0–300 (matching on-chain `MAX_SWAP_FEE_BPS`); `portfolios(strategy_id)` |
| `strategy_versions` | `allocation jsonb`, `schedule jsonb`, `active_at` | PK `(strategy_id, version)`, `version > 0`, jsonb shape checks |
| `portfolios` | `user_id`, `strategy_id`, `version`, `schedule_state`, `next_run_at`, `last_checked_at`, `last_rebalance_at` | `portfolios(strategy_id)`; a strategy referenced by a portfolio cannot be deleted (`ON DELETE RESTRICT`); `schedule_state` ∈ {idle, active, paused} (0012); `(schedule_state, next_run_at)` index (0012: the scheduler asks "who is due" every round) |
| `smart_accounts` | `chain_id`, `address`, `owner`, `account_type` | `UNIQUE(chain_id, address)`; the address must be lowercase 0x + 40 hex; `smart_accounts(portfolio_id)` |
| `session_keys` | `key_ref`, `permissions`, `expires_at`, `status` | `key_ref UNIQUE`; when `revoked_at` is set `status` must be `revoked`; `session_keys(portfolio_id)` |
| `operations` | `type`, `state`, `idempotency_key`, `payload_hash`, `tx_hash`, `user_op_hash`, `attempts`, `last_error` | `idempotency_key UNIQUE`; `operations(portfolio_id, state)`; `type` ∈ {rebalance, enroll, revoke_session_key, withdraw}, `state` ∈ {pending, submitted, confirmed, failed, reverted}, `attempts >= 0` (from 0012) |
| `positions_snapshots` | `asset`, `amount`, `usd_value`, `block`, `price_source`, `priced_at` | `numeric(38,18)`; `UNIQUE(portfolio_id, asset, block)` (re-running a block adds no row, so `on conflict` works); `(portfolio_id, block DESC)` for the latest; `usd_value`, `price_source` and `priced_at` are all NULL or all set |
| `performance` | `period`, `twr`, `since` | `numeric(18,8)`; `(strategy_id, period, since DESC)` |
| `enrollment_intents` | `user_id`, `strategy_id`, `chain_id`, `valid_until` | PK `(user_id, strategy_id, chain_id)`; `user_id` must be lowercase, `valid_until > 0`; pinned before any on-chain action, and a retry reads the same value (otherwise an orphaned account appears that cannot be reclaimed) |
| `portfolio_snapshots` | `block`, `native_balance_wei`, `total_usd_e8`, `gross_drift_bps`, `max_abs_delta_bps`, `threshold_bps`, `needs_rebalance`, `complete`, `unpriced_count`, `pinned_version`, `unknown_token_count`, `universe_complete` | PK `(portfolio_id, block)` (re-running a block is an UPDATE, not a second snapshot); all bps 0–10000, counts ≥ 0, `pinned_version` NULL or ≥ 1; when `complete = false`, `gross_drift_bps` / `max_abs_delta_bps` / `needs_rebalance` must be 0 / 0 / false; when `unknown_token_count > 0`, `complete` must be false |
| `priceable_assets` | `address`, `symbol`, `decimals`, `usdt_pool`, `pool_fee`, `is_numeraire`, `enabled` | PK `address` (lowercase 0x + 40 hex), `symbol` UNIQUE, `decimals` 1–36, `pool_fee` ∈ {100,500,2500,10000}, `usdt_pool` and `pool_fee` come in pairs, and when `is_numeraire` is true both must be NULL; no FK |
| `portfolio_scan_cursors` | `start_block`, `last_scanned_block`, `updated_at` | PK `portfolio_id` (FK, `on delete cascade`); `start_block >= 0`, `last_scanned_block >= start_block - 1` (`start_block - 1` = nothing scanned yet) |
| `portfolio_holding_candidates` | `asset`, `first_seen_block`, `last_balance_wei`, `last_checked_at` | PK `(portfolio_id, asset)` (FK, `on delete cascade`); `asset` must be lowercase 0x + 40 hex, `first_seen_block >= 0`, `last_balance_wei >= 0` (`numeric(78,0)`: the full uint256 range) |
| `scheduler_alerts` | `kind`, `severity`, `portfolio_id`, `detail`, `occurrences`, `first_seen_at`, `last_seen_at`, `resolved_at` | `kind` ∈ {portfolio_repeatedly_failing, session_key_expiring, gas_low}, `severity` ∈ {warn, critical}, `occurrences > 0`; a **partial unique index** `(kind, coalesce(portfolio_id, -1)) WHERE resolved_at IS NULL` means one unresolved row per problem (`coalesce` because UNIQUE treats every NULL as distinct); `(resolved_at, severity)` serves `/health` and `--alerts`; `portfolio_id` FK `on delete cascade`; resolved rows are **kept** (they are the only evidence of when a problem cleared) |

### priceable_assets: why the allowlist lives in the DB, not in code

bStock (tokenised US equities) has **no official token list**: the issuer publishes HTML pages, not
machine-readable JSON, and there is no on-chain registry. So "which address is a bStock, what is its
symbol, how many decimals, and where is its USDT pool" has to be maintained by hand. It is a table rather
than a code constant because listing a new ticker should be one `INSERT`, not a code change, a test run and
a redeploy.

The table was called `bstock_tokens` until 0007 renamed it to `priceable_assets`: it now also holds the
**pricing currencies** (USDT, WBNB), because "does this address have a price, and where does that price come
from" is the same question for a bStock and for a pricing currency. A table named after bStock holding WBNB
invites the next reader to misread it as "not a target asset".

- `usdt_pool` + `pool_fee` come in pairs: a pool is what makes quoting and swapping back to USDT possible.
  `NULL` means **the pool has not been verified yet**, not "there is no pool" — never put in an unverified
  address, or quotes will read the wrong pool.
- `is_numeraire = true`: the unit of account itself (USDT), where **one token is always 1e8** by definition
  rather than by quote, so it needs no pool. The constraint
  `priceable_assets_numeraire_has_no_pool` forbids giving it a `usdt_pool`/`pool_fee` (leaving them would
  suggest it is priced by TWAP). Without this column USDT could only be "no pool → no price", and it is one
  of the targets of portfolio 5: as soon as the account holds USDT, the planner would refuse to compute
  drift because a holding is unpriced, and the indexer would fail for the only strategy that exists.
- To delist, set `enabled = false` rather than `DELETE`: old snapshots still map addresses back to symbols
  through this table.
- Six verified tokens are seeded (all 18 decimals): `NVDAB` has a USDT pool (PancakeSwap V3, fee 2500);
  `WBNB` uses the WBNB/USDT pool (fee 500, the same pool as the on-chain oracle, cross-checked to 0 ppm);
  `USDT` is the numeraire (no pool); `TSLAB` / `MUB` / `CRCLB` pools are unverified and `usdt_pool` is
  `NULL`.

### portfolio_snapshots: why a snapshot needs a header row

`positions_snapshots` holds the detail, and for an empty portfolio it writes **no rows at all** (no assets,
no detail — correct in data terms). So "just checked, confirmed empty" and "the indexer died three hours
ago" look identical downstream: both return no rows. A header row per `(portfolio_id, block)` — written even
when empty — makes "ran and found nothing" visible, and it also records `total_usd_e8`, `gross_drift_bps`,
`max_abs_delta_bps`, `threshold_bps`, `needs_rebalance` and `pinned_version`, so "when was portfolio 5 last
checked, what was its drift, should it have moved" needs no recomputation.

- Re-running the same block is an **UPDATE** (`on conflict (portfolio_id, block)`): one observation should
  not produce two totals, and `created_at` keeps the first write's timestamp. To ask "when was it last
  checked", take the row with the largest `block`.
- `complete = false` means this round's drift is untrustworthy (an unpriced holding, or the DB allocation
  disagrees with the chain). Then `gross_drift_bps`/`max_abs_delta_bps` are 0 and `needs_rebalance` is
  false, enforced by `portfolio_snapshots_incomplete_has_no_drift` — because 0/false alone reads as "nothing
  to do" when it actually means "cannot tell". **Downstream must check `complete` first.**
- When `complete = false`, `total_usd_e8` is the partial total of priced positions, not the portfolio value.
- `native_balance_wei` is gas money only and never enters drift (see the header of
  `backend/src/positions.ts`).
- `created_at` is not in the `do update` clause: the same block is the same observation, and refreshing it
  would erase when that observation began.

### complete vs universe_complete: two different questions (0009)

`priceable_assets` defines **what has a price**, not **what an account owns**. Before 0009 the indexer's
read universe was "allowlist ∪ target assets", so when an account received an ERC-20 outside the allowlist
(an airdrop, a mistaken transfer, a newly listed token) that token was **not read at all**: `total_usd_e8`
came out low → every known asset's `current_bps` came out high → drift was wrong, while `complete` stayed
true. A "completely plausible" wrong report went to the keeper.
**Held but not observed ≠ held 0.**

So the header carries two booleans answering different questions, and the keeper must have **both** true
before trusting drift:

| Column | Question | Meaning of false |
| --- | --- | --- |
| `complete` | "Do all the assets we **saw** have a price?" | A known problem: unpriced or unknown holdings, or the DB allocation disagreeing with the chain → drift is refused |
| `universe_complete` | "Are we **sure** we saw every asset the account owns?" | Not confirmed yet: the cursor has not covered the deployment block, or an `eth_getLogs` call failed → drift is still computed, but on a universe that may be missing entries |

- `universe_complete = false` is **not** a block. "We do not know yet" and "we know something is wrong" are
  different: the former is flagged on the header (and printed by the CLI), the latter
  (`unknown_token_count > 0`) blocks drift. A row where both are false is a normal state.
- The only evidence is the **cursor**: `start_block <= deployment block`, and every `eth_getLogs` from
  `start_block` to head succeeded. On a failed scan `last_scanned_block` does not advance — a hole means
  some transfer is never seen.
- The deployment block is found by binary-searching `eth_getCode` (on-chain state is authoritative;
  `smart_accounts.created_at` is an off-chain timestamp, and converting it to a block number needs a
  time→block index, which is exactly what is least available). Not finding it means not finding it:
  `universe_complete` stays false rather than guessing.
- On a local anvil fork old blocks are unreadable (the 403 archive in `docs/pitfalls §2.1`), so the cursor
  can only start at a visible block and `universe_complete` is always false locally. That is not a bug, it
  is a fact about that environment — and it is precisely why this column exists.

### portfolio_holding_candidates: why detection itself must be persisted (0010)

0009 added the cursor and `universe_complete`, but detection was still **one-shot**: each round read
`balanceOf` only for candidates seen in that round's logs, then advanced the cursor. Once the cursor moves,
the old window is gone:

| Round | Log window | `unknown_token_count` | `universe_complete` | Keeper |
| --- | --- | --- | --- | --- |
| N | CAKE transferred in at block B | 1, `complete=false` | true | distrusts it ✅ |
| N+1 | no new logs | 0 | true | **starts trusting a universe missing CAKE again** ❌ |

0009 only postponed the bug **by one round**. The fix is to persist "candidates ever seen" so detection no
longer depends solely on this round's window:

- A log shows a new out-of-universe token → `insert ... on conflict do nothing` (`first_seen_block` records
  only the first time).
- **Every round** re-reads `balanceOf` for **every row** in `portfolio_holding_candidates`, whether or not
  this round had new logs.
- Balance > 0 → into `unknownHoldings` → `blocked` plus `complete = false` (header
  `unknown_token_count > 0`).
- Balance = 0 → **do not delete the row** (it may hold again later, and not necessarily with a log); simply
  do not count it as a holding.
- `balanceOf` unreadable → keep the previous `last_balance_wei`, never write 0: "unreadable" and "0" are not
  the same thing.
- Candidate re-reads are **decoupled** from the log scan: if this round's `eth_getLogs` fails (cursor frozen,
  `universe_complete = false`), the stored candidates must **still** be re-read, otherwise "scan failed →
  forget the known unknown holdings" becomes another version of the same bug.

The result: once CAKE is discovered, **the block lasts until the balance reaches zero**, and does not
disappear merely because this round had no new logs.

### The three portfolio timestamps: how the scheduler answers "who should run now" (0012)

Before `schema_migrations` existed for this, `portfolios` had only a `schedule_state` (with no CHECK) and no
timestamps at all — the scheduler had no column to answer "when was this portfolio last checked, and when
is it next due". The three columns answer three different questions, and their **semantics must not be
conflated**:

| Column | Question | Written by |
| --- | --- | --- |
| `next_run_at` | when it should next be **checked** (not "next traded") | the scheduler **when claiming** (`now + intervalSeconds`), not after executing |
| `last_checked_at` | when it was last actually looked at (blocked and noop count) | the scheduler after finishing that portfolio |
| `last_rebalance_at` | when a rebalance last **landed on-chain** | only when `state = confirmed` |

**Why `next_run_at` advances before execution** (`claimDuePortfolios` in `backend/src/scheduler.ts`): the
same transaction that selects due rows with `SELECT … FOR UPDATE SKIP LOCKED` writes
`next_run_at = now + intervalSeconds`. If it advanced only after execution, one crash, timeout or
`kill -9` would leave the portfolio still "due" next round → claimed again → **a second rebalance sent =
money moved twice**. Better to miss one round (the next one catches up) than to run twice: missing only
delays, running twice is irreversible. So this column means "already scheduled for the next round", **not**
"when it last finished" — the latter is `last_checked_at`.

An active portfolio with `next_run_at is null` is treated as **immediately due**
(`next_run_at is null or next_run_at <= now()`), so a newly created portfolio is picked up without any extra
write and cannot be missed. Conversely, non-interval schedules (`{kind:'cron'}`, a missing schedule, a
malformed one) are still claimed and recorded as `blocked` (never silently skipped), but with a one-hour
back-off: leaving them NULL would keep them at the front every round (`nulls first`), consuming the `limit`
and starving the portfolios that can actually run.

`idle` / `paused` are never selected, even when `next_run_at` has passed.

### operations: lifecycle columns and idempotency_key (0012)

`operations` has had `idempotency_key UNIQUE` since 0001, but nothing recorded whether the transaction
landed, how many attempts there were, or why it failed. 0012 adds `tx_hash` / `user_op_hash` / `attempts` /
`last_error`, and freezes the `type` / `state` domains into CHECKs — because the scheduler now **decides
whether to send again from `state`**:

| `state` | Scheduler's reading |
| --- | --- |
| `confirmed` | the same parameters already landed → **never send again** |
| `pending` / `submitted` | in flight or outcome unknown → **do not resend** (resending on an unknown outcome risks moving money twice) |
| `failed` / `reverted` | the last attempt did not settle → retry with the same `idempotency_key`, `attempts + 1` |

`idempotency_key` is `rebalance:{portfolioId}:{planHash}`, where
`planHash = keccak256(abi.encode(tokenIn/tokenOut/amountIn/amountOutMin of every step, deadline))`: the same
parameters always give the same key, and a different amount or deadline gives a different one. A typo in
this column is no longer "a display bug" but an entry point to **moving money twice**, which is why the
domain is frozen here.

⚠ **Dry-run does not write `operations`**: a `pending` row would block the real execution with its own
rehearsal (the same plan necessarily has the same key), which is far worse than missing one audit row.
Dry-run only prints the `planHash` / `idempotency_key`.

### scheduler_alerts: why alerts must be persisted (0013)

Three long runs in 2026-11 (about 2.5 hours each) produced: 34 rounds with 1 success, 17 rounds with 1
success, and 1 round — **20+ consecutive failures with nothing notifying anyone**, discovered only because
a human read the logs. A scheduler's value rests on being unattended, and being unattended requires that
someone finds out when it breaks. Logs written only to stdout cannot carry that: they vanish on restart,
they vanish on rotation, and nobody reads a file nobody told them to read.

So "there is a problem" is a **queryable state**, not a printed line. All three exits read only this table:

| Exit | Who reads it | Behaviour |
| --- | --- | --- |
| `GET /health` | monitoring / load balancers | an unresolved critical → `status: "degraded"`, **still HTTP 200** (503 is reserved for Postgres being down) |
| the scheduler's per-round stdout | whoever is watching logs | one `[ALERT][critical] …` line per alert; it prints a line even with no alerts (silence and not-running look identical) |
| `scripts/scheduler.ts --alerts` | whoever was called in to fix it | lists the currently unresolved alerts without running a round |

**Why upsert one row instead of inserting per detection**: a problem detected every 60 seconds becomes 1440
rows a day — that is not an alert, it is a noise log. While unresolved there is exactly one row per
`(kind, portfolio_id)`: detected again → `occurrences + 1` and update `last_seen_at` / `detail`; the
condition disappears → `resolveAlerts` writes `resolved_at`. So "how long has this been going on, how many
times was it seen" is answered by `first_seen_at` / `occurrences`.

**Why `coalesce(portfolio_id, -1)`**: Postgres treats every NULL as distinct in a UNIQUE index, so
`(kind, portfolio_id)` would let portfolio-independent alerts be inserted repeatedly. The
`ON CONFLICT (kind, (coalesce(portfolio_id, -1))) WHERE resolved_at IS NULL` in `recordAlerts` **must match
the index character for character** — when Postgres cannot infer an index it errors rather than silently
failing to deduplicate.

**Why resolved rows are kept**: they are the only evidence that something happened and when it cleared.
Deleting them makes "when did last week's consecutive failure end" unanswerable forever.

The three kinds and their thresholds (`ALERT_FAILING_OPS` / `ALERT_KEY_EXPIRY_DAYS` / `ALERT_MIN_OPS`) live
in `backend/src/alerts.ts`. ⚠ A failed chain read (RPC down) does **not** produce `gas_low`: a false critical
teaches people to ignore the real ones.

### allocation / schedule JSON shapes

```jsonc
// strategy_versions.allocation: weights are in bps and must sum to exactly 10000
{ "assets": [ { "address": "0x…", "symbol": "AAPLB", "weightBps": 2500 } ] }

// strategy_versions.schedule: one of the two
{ "kind": "interval", "intervalSeconds": 86400 }
{ "kind": "cron", "cron": "0 0 * * *" }
```

The semantics are validated by `backend/src/strategies.ts` (weights sum, no duplicate assets, at most 16
assets); the DB only does a light shape check. The on-chain `AtpRegistry` records the schedule as a
`bytes32 scheduleHash`, and this JSON is its source.

## Security boundary

- **`session_keys` stores only `key_ref` (a KMS key reference). Private keys, mnemonics and encrypted private
  keys never enter the DB.** Tables and columns carry `COMMENT`s saying so; before adding a column, ask "is
  this key material?".
- There is no database-level auth: `user_id` and `provider` are claims, and the API layer is responsible for
  verifying them.
- `payload_hash` stores the hash of the canonical payload so an audit can be re-verified without keeping
  the plaintext.

## Known gaps (for the next round)

- `portfolios.version` has no composite FK to `strategy_versions(strategy_id, version)`; a wrong version
  number only fails when the keeper runs. A composite FK would move the error to insert time, at the cost of
  enforcing "a portfolio may only pin a published version".
- The `UNIQUE (portfolio_id, asset, block)` added in 0005 **silently deletes** duplicate rows before creating
  the constraint (keeping the newest `ts`). Both the local and production databases had 0 rows at the time,
  so nothing was actually deleted; but an environment that already had duplicates would not see those rows in
  the migration output (the runner reports only the filename).
- `priceable_assets` has only six verified assets; further listings depend on operations. Without a
  "source credibility" column, the allowlist's authority rests entirely on manual review.
- `portfolio_snapshots` and `positions_snapshots` are not tied by a FK, only by the natural key
  `(portfolio_id, block)`: the database does not enforce "detail always has a header row". The writer
  (`writeSnapshot`) writes both in one statement, but writing `positions_snapshots` directly bypasses that
  guarantee.
- `operations.updated_at` is maintained by the application, with no trigger (every scheduler UPDATE writes
  `now()` itself).
- `operations` has no cap on how many times the same parameters may be retried: `failed` / `reverted` rows
  are always retryable. It does not run away today because `planHash` includes a deadline derived from block
  time, so every round produces a new key; but a broken planner would keep producing new rows.
- `strategies.name` is not unique (the same provider may have two strategies with one name).
- No retention or partitioning strategy yet; `positions_snapshots` and `operations` grow without bound.
