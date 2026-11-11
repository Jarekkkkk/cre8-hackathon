import { config as loadDotenv } from 'dotenv';
import type { Address, Hex } from 'viem';

/**
 * Settings the auth layer needs to build and check an EIP-4361 (SIWE) challenge. Kept separate
 * from the rest of the config so `src/auth.ts` can resolve it without `DATABASE_URL`: auth is the
 * one subsystem whose tests must run with no database at all.
 */
export type AuthConfig = {
  /** EIP-4361 `domain`: the RFC 3986 authority the wallet is asked to sign for. Default `localhost`. */
  authDomain: string;
  /** EIP-4361 `uri`: the resource the sign-in is for. Defaults to `http://<AUTH_DOMAIN>`. */
  authUri: string;
  /** EIP-155 chain id the signed message must be bound to. Default 56 (BNB Chain mainnet). */
  chainId: number;
};

/**
 * Session key（Kernel permission validator）需要的兩個設定。
 *
 * 與 `AuthConfig` 分開、**不進 `Config`** 的理由有二：`src/permissions.ts` 不該為了算一個派生地址
 * 去要 `DATABASE_URL`；而且這兩個值在「沒有開啟 session key 功能」的行程裡完全用不到，設成必填會讓
 * 啟動與既有測試一起掛掉。取用請走 `requireSessionKeyConfig()`：真的需要時才失敗，訊息帶著缺哪一個。
 */
export type SessionKeyConfig = {
  /** Session key CallPolicy 的 target（rebalance executor）；null = 未設定。 */
  executorAddress: Address | null;
  /** HD 派生的 master seed（32-byte hex）；null = 未設定。私鑰不落 DB，DB 只存派生路徑。 */
  sessionKeyMasterSeed: Hex | null;
};

/**
 * 「這個 smart account 還能不能發 UserOp」的門檻，只有一個值：帳戶至少要有的 BNB 餘額（wei）。
 *
 * 為什麼不進 `Config`：`loadConfig` 的回傳形狀被 `test/strategies.test.ts` 用 `deepEqual` 釘死，
 * 而且沒有開啟 session key 的行程完全不看這個值。取用請走 `getGasConfig()`（同 `AuthConfig` /
 * `SessionKeyConfig` 的模式）。
 *
 * 為什麼是 bigint：預設 0.01 BNB = 10^16 wei 已經超過 `Number.MAX_SAFE_INTEGER`（≈9.007×10^15），
 * 用 `Number`/`parseInt` 解析會安靜地失真，所以整條路徑都是 bigint。
 */
export type GasConfig = {
  /** 帳戶餘額門檻（wei）。與 session key GasPolicy 的 1 BNB 上限是同一個量級，存更多也用不到。 */
  minSessionGasWei: bigint;
};

export type Config = AuthConfig & {
  /** Postgres connection string. Required. */
  databaseUrl: string;
  /** HTTP port, 1-65535. Default 8080. */
  port: number;
  /** Optional JSON-RPC endpoint; null when unset (chain features disabled). */
  rpcUrl: string | null;
  /** Relayer/operator private key that signs on-chain transactions; null = chain disabled. */
  operatorPrivateKey: string | null;
  /** On-chain AtpRegistry address; null = chain disabled. */
  registryAddress: string | null;
};

export const DEFAULT_PORT = 8080;
export const DEFAULT_CHAIN_ID = 56;
export const DEFAULT_AUTH_DOMAIN = 'localhost';
/**
 * 每個 Kernel 帳戶建議持有的最低 gas（0.0005 BNB）。
 *
 * BSC 的 gas 是 0.05 gwei，一筆 sudo UserOp（約 500k gas）成本約 0.000025 BNB ——
 * 0.0005 已經夠跑 ~20 筆。這個值一路從 0.01 → 0.002 → 0.0005：
 * 前面的門檻對「存個 1.5 USDT 測試」來說高到荒謬 —— 使用者得先花 0.0021 BNB 補 gas
 * 才能入金，實測就卡在這裡（錢包 0.00188 BNB，夠 75 筆卻被 0.002 門檻擋住）。
 * 20 筆的餘裕對「再平衡失敗後還剩幾輪可重試」綽綽有餘，又不逼使用者鎖大額。
 */
export const DEFAULT_MIN_SESSION_GAS_WEI = 5n * 10n ** 14n;

let cachedConfig: Config | null = null;
let cachedAuthConfig: AuthConfig | null = null;
let cachedSessionKeyConfig: SessionKeyConfig | null = null;
let cachedGasConfig: GasConfig | null = null;

/**
 * Pure parser: reads the given env object, applies defaults, throws on bad values.
 * Tests use this directly; the process uses getConfig() so dotenv and the cache are applied once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see backend/.env.example)');
  }

  const port = parseInteger(env, 'PORT', DEFAULT_PORT, { min: 1, max: 65_535 });
  const rpcUrl = env.RPC_URL?.trim() ? env.RPC_URL.trim() : null;
  const operatorPrivateKey = env.OPERATOR_PRIVATE_KEY?.trim() ? env.OPERATOR_PRIVATE_KEY.trim() : null;
  const registryAddress = parseOptionalAddress(env, 'REGISTRY_ADDRESS');

  return {
    databaseUrl,
    port,
    ...loadAuthConfig(env),
    rpcUrl,
    operatorPrivateKey,
    registryAddress,
  };
}

/**
 * Pure parser for the SIWE settings alone. Deliberately independent of `DATABASE_URL`, so the auth
 * layer works — and its tests run — with no database configured.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const chainId = parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1 });
  const authDomain = parseAuthDomain(env);
  const authUri = parseAuthUri(env, authDomain);
  return { authDomain, authUri, chainId };
}

/** Process-wide config: loads .env once (without overriding real env vars) and caches the result. */
export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;
  loadDotenv({ override: false });
  cachedConfig = loadConfig(process.env);
  return cachedConfig;
}

/** Cached auth-only config. Same lazy pattern as getConfig(), minus the DATABASE_URL requirement. */
export function getAuthConfig(): AuthConfig {
  if (cachedAuthConfig) return cachedAuthConfig;
  loadDotenv({ override: false });
  cachedAuthConfig = loadAuthConfig(process.env);
  return cachedAuthConfig;
}

/**
 * Pure parser for the session-key settings alone. Independent of `DATABASE_URL`, like `loadAuthConfig`,
 * so `src/permissions.ts` and its unit tests work with no database configured.
 */
export function loadSessionKeyConfig(env: NodeJS.ProcessEnv = process.env): SessionKeyConfig {
  return {
    executorAddress: parseOptionalAddress(env, 'EXECUTOR_ADDRESS'),
    sessionKeyMasterSeed: parseOptionalSeed(env, 'SESSION_KEY_MASTER_SEED'),
  };
}

/** Cached session-key config. Same lazy pattern as getConfig(), minus the DATABASE_URL requirement. */
export function getSessionKeyConfig(): SessionKeyConfig {
  if (cachedSessionKeyConfig) return cachedSessionKeyConfig;
  loadDotenv({ override: false });
  cachedSessionKeyConfig = loadSessionKeyConfig(process.env);
  return cachedSessionKeyConfig;
}

/**
 * Pure parser for the gas-threshold settings alone. Independent of `DATABASE_URL`, like the other
 * small loaders, so a process that only reads balances needs no database.
 */
export function loadGasConfig(env: NodeJS.ProcessEnv = process.env): GasConfig {
  return { minSessionGasWei: parseBigInt(env, 'MIN_SESSION_GAS_WEI', DEFAULT_MIN_SESSION_GAS_WEI) };
}

/** Cached gas config. Same lazy pattern as getConfig(), minus the DATABASE_URL requirement. */
export function getGasConfig(): GasConfig {
  if (cachedGasConfig) return cachedGasConfig;
  loadDotenv({ override: false });
  cachedGasConfig = loadGasConfig(process.env);
  return cachedGasConfig;
}

/**
 * 真正要用 session key 時才呼叫的守門員：兩個設定缺任何一個就拋錯，訊息指出缺哪一個與它的用途。
 *
 * 刻意不在 `loadConfig` 做這件事 —— 那會讓「沒用到 session key」的行程（含既有測試）因為一個
 * 空值而啟動失敗。這裡接受 `env` 參數，讓測試不必動 `process.env`。
 */
export function requireSessionKeyConfig(env: NodeJS.ProcessEnv = process.env): {
  executorAddress: Address;
  masterSeed: Hex;
} {
  const { executorAddress, sessionKeyMasterSeed } = loadSessionKeyConfig(env);

  const missing: string[] = [];
  if (executorAddress === null) missing.push('EXECUTOR_ADDRESS');
  if (sessionKeyMasterSeed === null) missing.push('SESSION_KEY_MASTER_SEED');
  if (executorAddress === null || sessionKeyMasterSeed === null) {
    throw new Error(
      `Session key 設定不完整：缺少 ${missing.join(' 與 ')}（見 backend/.env.example）。` +
        `EXECUTOR_ADDRESS 是 session key CallPolicy 允許呼叫的 target；` +
        `SESSION_KEY_MASTER_SEED 是派生 session key 的 HD master seed（0x + 64 hex）`,
    );
  }

  return { executorAddress, masterSeed: sessionKeyMasterSeed };
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: { min: number; max?: number },
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  const withinBounds =
    Number.isInteger(value) && value >= bounds.min && (bounds.max === undefined || value <= bounds.max);
  if (!withinBounds) {
    const range = bounds.max === undefined ? `>= ${bounds.min}` : `in ${bounds.min}..${bounds.max}`;
    throw new Error(`${name} must be an integer ${range}, got "${raw}"`);
  }
  return value;
}

/**
 * Wei 等級的整數解析：只收純十進位數字。
 *
 * 不能沿用 `parseInteger`：它的 `Number(raw)` 對 10^16 以上會失真。也不直接丟給 `BigInt`，因為
 * `BigInt('0x10')` 會成功（當成 hex）、`BigInt(' 1 ')` 又會吞掉空白，兩者都讓一個打錯的 wei 值
 * 安靜地變成另一個數字。先擋形狀，再交給 BigInt（它自己不會溢位）。
 */
function parseBigInt(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a decimal integer amount of wei (digits only), got "${raw}"`);
  }
  return BigInt(raw);
}

/**
 * Optional on-chain address (0x + 40 hex), normalised to lowercase. Empty means "not configured".
 * Used for REGISTRY_ADDRESS and EXECUTOR_ADDRESS; callers treat a null value as "not configured".
 */
function parseOptionalAddress(env: NodeJS.ProcessEnv, name: string): Address | null {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${name} must be a 0x-prefixed 20-byte hex address, got "${raw}"`);
  }
  // 上面那條 regex 已保證形狀與長度，這裡只是把驗證過的結果收窄成 viem 的 Address。
  return raw.toLowerCase() as Address;
}

/**
 * Optional 32-byte hex seed (0x + 64 hex), lowercased. Empty means "not configured".
 *
 * 形狀在這裡就驗掉：截斷或打錯的 seed 會派生出一組「看起來正常但對不上鏈上帳戶」的地址，
 * 等到那時才發現要查很久，所以在解析階段就帶著變數名炸掉。
 */
function parseOptionalSeed(env: NodeJS.ProcessEnv, name: string): Hex | null {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex seed (64 hex chars), got "${raw}"`);
  }
  return raw.toLowerCase() as Hex;
}

/**
 * EIP-4361 `domain` is a bare RFC 3986 authority (host, optional port): no scheme, no path.
 * Nothing else is accepted, because the value is compared verbatim against what the wallet signed.
 */
function parseAuthDomain(env: NodeJS.ProcessEnv): string {
  const raw = env.AUTH_DOMAIN?.trim();
  if (raw === undefined || raw === '') return DEFAULT_AUTH_DOMAIN;
  if (/[/?#@\s]/.test(raw) || raw.includes('://')) {
    throw new Error(`AUTH_DOMAIN must be a bare authority such as app.cre8.xyz (no scheme or path), got "${raw}"`);
  }
  return raw;
}

/**
 * EIP-4361 `uri` must be an absolute URI. Default is the auth domain over http, which is right for
 * the localhost default; a deployed instance should set AUTH_URI (e.g. https://app.cre8.xyz).
 */
function parseAuthUri(env: NodeJS.ProcessEnv, authDomain: string): string {
  const raw = env.AUTH_URI?.trim();
  const value = raw === undefined || raw === '' ? `http://${authDomain}` : raw;

  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new Error(`AUTH_URI must be an absolute URI such as https://app.cre8.xyz, got "${value}"`);
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`AUTH_URI must use http or https, got "${value}"`);
  }
  return value;
}
