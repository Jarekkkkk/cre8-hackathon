import { isChainConfigured, publishVersionOnchain, registerStrategyOnchain } from './chain.js';
import { isForeignKeyViolation, isUniqueViolation, query } from './db.js';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.js';

/** Basis-point denominator. On-chain AtpRegistry uses the same TOTAL_WEIGHT_BPS. */
export const BPS_DENOMINATOR = 10_000;
/** Max assets per version, mirrors AtpRegistry.MAX_VERSION_ASSETS. */
export const MAX_VERSION_ASSETS = 16;
/** Max output-side swap fee, mirrors AtpRegistry.MAX_SWAP_FEE_BPS (3%). */
export const MAX_SWAP_FEE_BPS = 300;
/** Minimum rebalance interval accepted by validation: anything faster is a keeper/gas footgun. */
export const MIN_INTERVAL_SECONDS = 60;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const MAX_PROVIDER_LENGTH = 200;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;

export type AllocationAsset = {
  /** Lowercase EVM address (0x + 40 hex). Normalised by validateAllocation. */
  address: string;
  /** Optional display ticker, e.g. AAPLB. */
  symbol?: string;
  /** Weight in basis points, 1-10000; every version's weights sum to exactly 10000. */
  weightBps: number;
};

export type Allocation = { assets: AllocationAsset[] };

/** Off-chain encoding of the rebalance schedule; hashed on chain as scheduleHash. */
export type RebalanceSchedule =
  | { kind: 'interval'; intervalSeconds: number }
  | { kind: 'cron'; cron: string };

export type Strategy = {
  id: number;
  provider: string;
  name: string;
  description: string;
  isPublic: boolean;
  swapFeeBps: number;
  /** On-chain AtpRegistry id; null until registerStrategyOnchain() succeeds. */
  onchainId: number | null;
  createdAt: string;
};

export type StrategyVersion = {
  strategyId: number;
  version: number;
  allocation: Allocation;
  schedule: RebalanceSchedule;
  changeLog: string | null;
  activeAt: string | null;
  createdAt: string;
};

export type StrategyDetail = Strategy & { versions: StrategyVersion[] };

export type CreateStrategyInput = {
  provider: string;
  name: string;
  description?: string;
  isPublic?: boolean;
  swapFeeBps?: number;
};

export type PublishVersionInput = {
  allocation: unknown;
  schedule: unknown;
  changeLog?: string | null;
  /** First instant the version may execute; defaults to now. Accepts ISO-8601 or Date. */
  activeAt?: string | Date | null;
};

export type ListStrategiesParams = {
  limit?: number;
  offset?: number;
  provider?: string;
  isPublic?: boolean;
};

export type StrategyPage = {
  items: Strategy[];
  total: number;
  limit: number;
  offset: number;
};

const STRATEGY_COLUMNS = 'id, provider, name, description, is_public, swap_fee_bps, onchain_id, created_at';
const VERSION_COLUMNS =
  'strategy_id, version, allocation, schedule, change_log, active_at, created_at';

type StrategyRow = {
  id: string;
  provider: string;
  name: string;
  description: string;
  is_public: boolean;
  swap_fee_bps: number;
  onchain_id: string | null;
  created_at: Date;
  total_count?: string;
};

type VersionRow = {
  strategy_id: string;
  version: number;
  allocation: unknown;
  schedule: unknown;
  change_log: string | null;
  active_at: Date | null;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// Pure validation (no DB) — also the contract the HTTP layer relies on.
// ---------------------------------------------------------------------------

/**
 * Validate and normalise an allocation:
 *   - exactly the shape { assets: [{ address, symbol?, weightBps }] }
 *   - 1..16 assets, addresses unique (case-insensitive), stored lowercase
 *   - integer weights in 1..10000 summing to exactly 10000
 */
export function validateAllocation(input: unknown): Allocation {
  if (!isRecord(input)) {
    throw new ValidationError('INVALID_ALLOCATION', 'allocation must be an object: { assets: [...] }');
  }

  const { assets } = input;
  if (!Array.isArray(assets)) {
    throw new ValidationError('INVALID_ALLOCATION', 'allocation.assets must be an array');
  }
  if (assets.length === 0) {
    throw new ValidationError('ALLOCATION_EMPTY', 'allocation.assets must contain at least one asset');
  }
  if (assets.length > MAX_VERSION_ASSETS) {
    throw new ValidationError(
      'TOO_MANY_ASSETS',
      `allocation.assets must contain at most ${MAX_VERSION_ASSETS} assets, got ${assets.length}`,
    );
  }

  const seen = new Set<string>();
  const normalised: AllocationAsset[] = [];
  let sum = 0;

  assets.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      throw new ValidationError('INVALID_ASSET', `allocation.assets[${index}] must be an object`);
    }

    const rawAddress = entry.address;
    if (typeof rawAddress !== 'string' || !ADDRESS_PATTERN.test(rawAddress.trim())) {
      throw new ValidationError(
        'INVALID_ASSET',
        `allocation.assets[${index}].address must be a 0x-prefixed 20-byte hex address`,
      );
    }
    const address = rawAddress.trim().toLowerCase();
    if (seen.has(address)) {
      throw new ValidationError('DUPLICATE_ASSET', `allocation.assets[${index}] duplicates asset ${address}`);
    }
    seen.add(address);

    const weightBps = entry.weightBps;
    if (
      typeof weightBps !== 'number' ||
      !Number.isInteger(weightBps) ||
      weightBps < 1 ||
      weightBps > BPS_DENOMINATOR
    ) {
      throw new ValidationError(
        'WEIGHT_OUT_OF_RANGE',
        `allocation.assets[${index}].weightBps must be an integer in 1..${BPS_DENOMINATOR}`,
      );
    }
    sum += weightBps;

    const asset: AllocationAsset = { address, weightBps };
    if (entry.symbol !== undefined) {
      if (
        typeof entry.symbol !== 'string' ||
        entry.symbol.trim() === '' ||
        entry.symbol.trim().length > 32
      ) {
        throw new ValidationError(
          'INVALID_ASSET',
          `allocation.assets[${index}].symbol must be a non-empty string of at most 32 characters`,
        );
      }
      asset.symbol = entry.symbol.trim();
    }
    normalised.push(asset);
  });

  if (sum !== BPS_DENOMINATOR) {
    throw new ValidationError(
      'WEIGHT_SUM',
      `allocation weights must sum to ${BPS_DENOMINATOR} bps, got ${sum}`,
    );
  }

  return { assets: normalised };
}

/** Validate a rebalance schedule: { kind: "interval", intervalSeconds >= 60 } or { kind: "cron", cron }. */
export function validateSchedule(input: unknown): RebalanceSchedule {
  if (!isRecord(input)) {
    throw new ValidationError(
      'INVALID_SCHEDULE',
      'schedule must be an object: { kind: "interval" | "cron", ... }',
    );
  }

  if (input.kind === 'interval') {
    const intervalSeconds = input.intervalSeconds;
    if (
      typeof intervalSeconds !== 'number' ||
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds < MIN_INTERVAL_SECONDS
    ) {
      throw new ValidationError(
        'INVALID_SCHEDULE',
        `schedule.intervalSeconds must be an integer >= ${MIN_INTERVAL_SECONDS}`,
      );
    }
    return { kind: 'interval', intervalSeconds };
  }

  if (input.kind === 'cron') {
    const cron = input.cron;
    if (typeof cron !== 'string' || cron.trim() === '' || cron.trim().length > 120) {
      throw new ValidationError(
        'INVALID_SCHEDULE',
        'schedule.cron must be a non-empty string of at most 120 characters',
      );
    }
    return { kind: 'cron', cron: cron.trim() };
  }

  throw new ValidationError('INVALID_SCHEDULE', 'schedule.kind must be "interval" or "cron"');
}

/**
 * Validate POST /strategies input and apply defaults (public, 0 bps, empty description).
 *
 * `provider` comes from the authenticated session, never from the body: any `provider` field in
 * the payload is ignored, so a client cannot create a strategy under another wallet's address.
 * It is lowercased here — migration 0002 makes lowercase the only storable form
 * (`check (provider = lower(provider))`), so this is the single normalisation point for writes.
 */
export function validateCreateStrategyInput(
  input: unknown,
  provider: string,
): Required<CreateStrategyInput> {
  if (!isRecord(input)) {
    throw new ValidationError('INVALID_STRATEGY', 'request body must be a JSON object');
  }

  const owner = requireString(provider, 'provider', MAX_PROVIDER_LENGTH).toLowerCase();
  const name = requireString(input.name, 'name', MAX_NAME_LENGTH);

  let description = '';
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') {
      throw new ValidationError('INVALID_STRATEGY', 'description must be a string');
    }
    if (input.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new ValidationError(
        'INVALID_STRATEGY',
        `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }
    description = input.description;
  }

  let isPublic = true;
  if (input.isPublic !== undefined) {
    if (typeof input.isPublic !== 'boolean') {
      throw new ValidationError('INVALID_STRATEGY', 'isPublic must be a boolean');
    }
    isPublic = input.isPublic;
  }

  let swapFeeBps = 0;
  if (input.swapFeeBps !== undefined && input.swapFeeBps !== null) {
    if (
      typeof input.swapFeeBps !== 'number' ||
      !Number.isInteger(input.swapFeeBps) ||
      input.swapFeeBps < 0 ||
      input.swapFeeBps > MAX_SWAP_FEE_BPS
    ) {
      throw new ValidationError(
        'INVALID_SWAP_FEE',
        `swapFeeBps must be an integer in 0..${MAX_SWAP_FEE_BPS}`,
      );
    }
    swapFeeBps = input.swapFeeBps;
  }

  return { provider: owner, name, description, isPublic, swapFeeBps };
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/**
 * Ownership gate shared by every provider-scoped write: the session wallet must be the strategy's
 * provider. Addresses are compared case-insensitively because EIP-55 casing is cosmetic.
 */
export function assertProviderOwns(strategyProvider: string, provider: string): void {
  if (strategyProvider.trim().toLowerCase() !== provider.trim().toLowerCase()) {
    throw new ForbiddenError('strategy belongs to another provider');
  }
}

/**
 * Create a strategy owned by `provider` (the authenticated session wallet). The body is validated
 * for everything else; a `provider` field inside it is ignored.
 *
 * When the chain is configured (RPC_URL / OPERATOR_PRIVATE_KEY / REGISTRY_ADDRESS), the strategy is
 * also registered on the on-chain AtpRegistry first, and its on-chain id is stored on the row. When
 * the chain is not configured the row is created with `onchainId: null` (offline mode); enrollment
 * of such a strategy fails until it is mirrored.
 */
export async function createStrategy(rawInput: unknown, provider: string): Promise<Strategy> {
  const input = validateCreateStrategyInput(rawInput, provider);

  let onchainId: number | null = null;
  if (isChainConfigured()) {
    onchainId = await registerStrategyOnchain({
      name: input.name,
      description: input.description,
      isPublic: input.isPublic,
    });
  }

  const { rows } = await query<StrategyRow>(
    `insert into strategies (provider, name, description, is_public, swap_fee_bps, onchain_id)
     values ($1, $2, $3, $4, $5, $6)
     returning ${STRATEGY_COLUMNS}`,
    [input.provider, input.name, input.description, input.isPublic, input.swapFeeBps, onchainId],
  );

  const row = rows[0];
  if (!row) throw new Error('insert into strategies returned no row');
  return mapStrategy(row);
}

/**
 * Paginated list. `total` is the row count matching the filter, not the page size.
 *
 * The `provider` filter is case-insensitive: the parameter is lowercased and matched exactly,
 * which stays index-friendly and agrees with the lowercase-only storage enforced by migration 0002.
 */
export async function listStrategies(params: ListStrategiesParams = {}): Promise<StrategyPage> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('INVALID_PAGINATION', 'limit must be an integer in 1..100');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError('INVALID_PAGINATION', 'offset must be an integer >= 0');
  }

  const provider = params.provider === undefined ? null : params.provider.trim().toLowerCase();

  const { rows } = await query<StrategyRow>(
    `select ${STRATEGY_COLUMNS}, count(*) over() as total_count
       from strategies
      where ($1::text is null or provider = $1)
        and ($2::boolean is null or is_public = $2)
      order by created_at desc, id desc
      limit $3 offset $4`,
    [provider, params.isPublic ?? null, limit, offset],
  );

  const first = rows[0];
  return {
    items: rows.map(mapStrategy),
    total: first?.total_count === undefined ? 0 : Number(first.total_count),
    limit,
    offset,
  };
}

/** One strategy plus its version history, newest version first. */
export async function getStrategy(id: number): Promise<StrategyDetail> {
  const { rows } = await query<StrategyRow>(`select ${STRATEGY_COLUMNS} from strategies where id = $1`, [
    id,
  ]);
  const row = rows[0];
  if (!row) throw new NotFoundError(`strategy ${id} not found`);

  const versions = await query<VersionRow>(
    `select ${VERSION_COLUMNS}
       from strategy_versions
      where strategy_id = $1
      order by version desc`,
    [id],
  );

  return { ...mapStrategy(row), versions: versions.rows.map(mapVersion) };
}

/**
 * Append a new version. Version numbers are assigned here (max + 1) and protected by the
 * (strategy_id, version) primary key: on a concurrent publish the unique violation is retried.
 *
 * The strategy row stays untouched; existing portfolios keep the version they pinned.
 *
 * `provider` is the authenticated session wallet: publishing requires ownership, so a caller can
 * only append versions to its own strategies (403 FORBIDDEN otherwise).
 */
export async function publishVersion(
  strategyId: number,
  input: PublishVersionInput,
  provider: string,
): Promise<StrategyVersion> {
  const allocation = validateAllocation(input.allocation);
  const schedule = validateSchedule(input.schedule);
  const changeLog = validateChangeLog(input.changeLog);
  const activeAt = validateActiveAt(input.activeAt);

  const owner = await query<{ provider: string; onchain_id: string | null }>(
    'select provider, onchain_id from strategies where id = $1',
    [strategyId],
  );
  const ownerRow = owner.rows[0];
  if (ownerRow === undefined) throw new NotFoundError(`strategy ${strategyId} not found`);
  assertProviderOwns(ownerRow.provider, provider);
  const onchainId = ownerRow.onchain_id === null ? null : Number(ownerRow.onchain_id);

  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const version = await nextVersion(strategyId);
    try {
      const { rows } = await query<VersionRow>(
        `insert into strategy_versions (strategy_id, version, allocation, schedule, change_log, active_at)
         values ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         returning ${VERSION_COLUMNS}`,
        [
          strategyId,
          version,
          JSON.stringify(allocation),
          JSON.stringify(schedule),
          changeLog,
          activeAt,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('insert into strategy_versions returned no row');
      const mapped = mapVersion(row);

      // Mirror to chain when the strategy is already registered on-chain (onchain_id set).
      if (onchainId !== null && isChainConfigured()) {
        await publishVersionOnchain(onchainId, {
          assets: allocation.assets.map((a) => a.address as `0x${string}`),
          weightsBps: allocation.assets.map((a) => a.weightBps),
          schedule,
          activeAt,
        });
      }

      return mapped;
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      if (isForeignKeyViolation(err)) throw new NotFoundError(`strategy ${strategyId} not found`);
      throw err;
    }
  }

  throw new Error(`could not allocate a version for strategy ${strategyId} after ${attempts} attempts`);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapStrategy(row: StrategyRow): Strategy {
  return {
    id: Number(row.id),
    provider: row.provider,
    name: row.name,
    description: row.description,
    isPublic: row.is_public,
    swapFeeBps: row.swap_fee_bps,
    onchainId: row.onchain_id === null ? null : Number(row.onchain_id),
    createdAt: row.created_at.toISOString(),
  };
}

function mapVersion(row: VersionRow): StrategyVersion {
  return {
    strategyId: Number(row.strategy_id),
    version: row.version,
    // jsonb comes back already parsed; the DB shape check and validateAllocation guard the contents.
    allocation: row.allocation as Allocation,
    schedule: row.schedule as RebalanceSchedule,
    changeLog: row.change_log,
    activeAt: row.active_at ? row.active_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

async function nextVersion(strategyId: number): Promise<number> {
  const { rows } = await query<{ next_version: number }>(
    'select coalesce(max(version), 0) + 1 as next_version from strategy_versions where strategy_id = $1',
    [strategyId],
  );
  const next = rows[0]?.next_version;
  if (next === undefined) throw new Error(`could not compute next version for strategy ${strategyId}`);
  return Number(next);
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

function validateChangeLog(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError('INVALID_CHANGE_LOG', 'changeLog must be a string');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      'INVALID_CHANGE_LOG',
      `changeLog must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }
  return trimmed;
}

function validateActiveAt(value: string | Date | null | undefined): Date {
  if (value === undefined || value === null) return new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError('INVALID_ACTIVE_AT', 'activeAt must be a valid ISO-8601 timestamp');
  }
  return parsed;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('INVALID_STRATEGY', `${field} is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError('INVALID_STRATEGY', `${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
