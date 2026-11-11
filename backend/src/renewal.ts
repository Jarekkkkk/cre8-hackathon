import type { Address, Hex, PublicClient } from 'viem';
import { KERNEL_V3_3_ADDRESSES, KERNEL_VERSION_STRING } from './addresses.js';
import { getChain } from './chain.js';
import { getConfig, requireSessionKeyConfig } from './config.js';
import { query } from './db.js';
import { AppError, ValidationError } from './errors.js';
import {
  buildSessionPermissions,
  deriveSessionKey,
  sessionKeyIndexFor,
  sessionValidUntil,
  MAX_SESSION_KEY_INDEX,
} from './permissions.js';
import type { SessionKeyMaterial, SessionPolicySnapshot } from './permissions.js';
import { requireOwnedPortfolio } from './portfolios.js';

/**
 * Session key 續期的後端那一半。
 *
 * 為什麼只有一半：續期要「安裝一組新的 permission 到已部署的 smart account」，那是一筆 UserOp，
 * 需要 **sudo owner 的簽章**。那支私鑰在使用者的錢包裡，不在後端（本專案的後端只有派生 session key 的
 * master seed，沒有 owner 私鑰）。所以分工是：
 *
 * - 後端（這裡）：派生**新的** session key（要 master seed，絕不能進瀏覽器）、算出它的 initConfig /
 *   permissionId / policy 快照，回給前端。
 * - 前端：用錢包以 sudo owner 身分組 UserOp（calls = initConfig 那兩筆 delegatecall 到帳戶自己）、
 *   簽章、送 bundler。
 * - 前端成功後把結果回報給 `POST /portfolios/:id/renewal-result`，後端只**記錄**，不上鏈。
 *
 * 鏈是權威：DB 那筆列只是「這把 key 應該存在」的意圖紀錄，所以 renewal-result 的參數不做深度驗證。
 */

/** dev 便利：前端要知道打哪個 bundler。`BUNDLER_URL` 可覆寫。 */
export const DEFAULT_BUNDLER_URL = 'http://127.0.0.1:3001';

/** 派生路徑的最後一層就是 BIP32 child index；用它把 `key_ref` 反解回索引。 */
const KEY_REF_PATTERN = /^m\/44'\/60'\/0'\/0\/(0|[1-9]\d*)$/;

/**
 * `key_ref` → 派生索引。不是這條路徑就回 null（例如舊資料用了別的前綴）：續期只需要「避開既有的
 * 索引」，讀不懂的字串就是不參與比較，而不是讓整支 endpoint 失敗。
 */
export function parseSessionKeyIndex(keyRef: string): bigint | null {
  const match = KEY_REF_PATTERN.exec(keyRef.trim());
  if (match === null) return null;
  const index = BigInt(match[1] ?? '');
  return index <= BigInt(MAX_SESSION_KEY_INDEX) ? index : null;
}

/**
 * 續期要用的新索引：`max(既有的所有索引, base) + 1`。
 *
 * **這條規則就是冪等性的全部來源。** 它只依賴兩個輸入：`(owner, strategyId)`（純函式）與這個 portfolio
 * 在 `session_keys` 裡既有的 `key_ref` 清單。兩者在同一秒內的兩次呼叫之間不可能改變（`renewal-params`
 * 不寫 DB），所以同一秒重打必然得到同一個索引；再配合 `validUntil` 只到秒的精度，`initConfig` /
 * `permissionId` / `initConfig` 也就一字不差。前端重試因此不會拿到「另一把 key 卻簽了前一個的 op」。
 *
 * 為什麼不是 `base + 1` 固定值：續期過一次之後 DB 最新的一列就是 `base + 1`，再續一次會撞上
 * `session_keys.key_ref` 的 UNIQUE，`renewal-result` 只能回 duplicate，新權限永遠記不進來。
 * 取「既有最大值 + 1」讓每一次續期都真的是一把新 key，同時仍與既有那把不同（§Acceptance 5）。
 *
 * 代價與 `sessionKeyIndexFor` 相同：兩把金鑰共用索引代表同一個 signer，那是**同一個身分**，
 * 不是隱私外洩；真的撞到會由 UNIQUE 大聲擋下。
 */
export function nextRenewalKeyIndex(
  owner: Address,
  strategyId: bigint | number,
  existingKeyRefs: readonly string[],
): bigint {
  const base = sessionKeyIndexFor(owner, strategyId);
  let highest = base;
  for (const keyRef of existingKeyRefs) {
    const index = parseSessionKeyIndex(keyRef);
    if (index !== null && index > highest) highest = index;
  }

  const next = highest + 1n;
  if (next > BigInt(MAX_SESSION_KEY_INDEX)) {
    throw new Error(
      `Session key 續期失敗：索引已達 BIP32 非 hardened 上界 ${MAX_SESSION_KEY_INDEX}（下一個是 ${next.toString()}）`,
    );
  }
  return next;
}

/** 一把算好的新 session key：前端組 UserOp 所需的全部材料，不含任何私鑰。 */
export type RenewalKey = {
  index: bigint;
  sessionKeyAddress: Address;
  keyRef: string;
  /** Unix 秒（uint48），與 `expiresAt` 是同一個瞬間。 */
  validUntil: number;
  /** ISO 字串，供 DB `session_keys.expires_at` 與前端顯示。 */
  expiresAt: string;
  permissionId: Hex;
  /** 完整三層 policy 快照；前端原樣回傳給 `renewal-result`。 */
  policySnapshot: SessionPolicySnapshot;
  /** 兩筆 calldata（installValidations + grantExecute 的 delegatecall），要當 UserOp 的 calls 送出。 */
  initConfig: Hex[];
};

export type BuildRenewalKeyArgs = {
  /** sudo owner（使用者的 EOA）。索引由 `(owner, strategyId)` 決定。 */
  owner: Address;
  strategyId: number;
  /** 這個 portfolio 既有的 `session_keys.key_ref`；用來保證新索引與它們都不同。 */
  existingKeyRefs: readonly string[];
  /** session key 的派生材料（master seed）。私鑰永遠不離開本行程。 */
  material: SessionKeyMaterial;
  /** CallPolicy 的 target（rebalance executor）。 */
  executorAddress: Address;
  publicClient: PublicClient;
  /** Unix 秒；未給 = `sessionValidUntil()`（now + 365 天）。 */
  validUntil?: number;
};

/**
 * 派生新 session key 並算出它的 initConfig / permissionId / policy 快照。
 *
 * `buildSessionPermissions` 是既有的那支（enroll 用的同一支），所以續期裝上去的權限與 enroll 時
 * 完全同形狀：三層 policy、同一個 flag、同一組 CallPolicy target。差別只有 signer 與時間區間。
 */
export async function buildRenewalKey(args: BuildRenewalKeyArgs): Promise<RenewalKey> {
  const index = nextRenewalKeyIndex(args.owner, args.strategyId, args.existingKeyRefs);
  const derived = deriveSessionKey(index, args.material);
  const validUntil = args.validUntil ?? sessionValidUntil();

  const session = await buildSessionPermissions({
    publicClient: args.publicClient,
    sessionKeyAddress: derived.address,
    executorAddress: args.executorAddress,
    validUntil,
  });

  return {
    index,
    // 一律用小寫（= policy 快照裡的那一份）：同一份回應出現兩種拼法，會讓人以為是兩個地址。
    sessionKeyAddress: session.policySnapshot.sessionKeyAddress,
    keyRef: derived.keyRef,
    validUntil,
    expiresAt: session.expiresAt.toISOString(),
    permissionId: session.permissionId,
    policySnapshot: session.policySnapshot,
    initConfig: session.initConfig,
  };
}

// ---------------------------------------------------------------------------
// GET /portfolios/:id/renewal-params
// ---------------------------------------------------------------------------

/** `GET /portfolios/:id/renewal-params` 的回應，欄位與前端契約一一對應。 */
export type RenewalParams = {
  portfolioId: number;
  strategyId: number;
  chainId: number;
  /** sudo owner（= 使用者的 EOA = `smart_accounts.owner`），不是 session key。 */
  ownerAddress: string;
  /** 要續期的 smart account：DB 的權威值，**不重新推導**（推導需要當初的 initConfig）。 */
  accountAddress: string;
  /** CallPolicy 的 target。 */
  executorAddress: Address;
  entryPoint: Address;
  kernelVersion: string;
  sessionKeyAddress: Address;
  keyRef: string;
  validUntil: number;
  expiresAt: string;
  permissionId: Hex;
  policySnapshot: SessionPolicySnapshot;
  initConfig: Hex[];
  /** 前端要打哪個 bundler。 */
  bundlerUrl: string;
};

/**
 * `buildRenewalParams` 的接縫。每個欄位都有 production 預設值，所以呼叫端照常
 * `buildRenewalParams(id, wallet)`；測試注入假的 query／publicClient 就不需要 DB 與鏈。
 */
export type RenewalParamsDeps = {
  /** `portfolios` + `smart_accounts` + `session_keys` 的擁有者查詢（含 404／403）。 */
  requireOwnedPortfolio: typeof requireOwnedPortfolio;
  /** env 接縫：預設就是真的 `requireSessionKeyConfig()`；空 env 會帶著變數名失敗。 */
  sessionKeyConfig: () => { executorAddress: Address; masterSeed: Hex };
  /** `buildSessionPermissions` 要讀 chain id，所以需要一個 publicClient。 */
  publicClient: PublicClient;
  /** 鏈 id：決定要續期哪一個 chain 的 smart account。 */
  chainId: number;
  /** 時鐘接縫：`validUntil = sessionValidUntil(now)`。 */
  validUntil: () => number;
  buildRenewalKey: typeof buildRenewalKey;
  bundlerUrl: string;
};

/**
 * 回傳前端組「續期 UserOp」所需的一切：**派生新 key、算權限、不簽章、不上鏈、不寫 DB**。
 *
 * 不寫 DB 是刻意的：`renewal-result` 才是寫入點。中間失敗（使用者取消簽章、bundler 掛掉）不該在
 * `session_keys` 留下一列永遠不會上鏈的 key。
 */
export async function buildRenewalParams(
  portfolioId: number,
  wallet: string,
  deps: Partial<RenewalParamsDeps> = {},
): Promise<RenewalParams> {
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  const portfolio = await find(portfolioId, wallet);

  // 缺 env 的訊息本身就是診斷（指出缺哪一個、那一個在做什麼），所以整段搬進 500 的 body：
  // 讓它變成 `INTERNAL: internal server error` 等於把唯一有用的資訊丟掉。
  const sessionKeyConfig = resolveSessionKeyConfigOrFail(deps.sessionKeyConfig);
  const publicClient = deps.publicClient ?? getChain().publicClient;
  const validUntil = (deps.validUntil ?? sessionValidUntil)();

  const key = await (deps.buildRenewalKey ?? buildRenewalKey)({
    owner: portfolio.ownerAddress as Address,
    strategyId: portfolio.strategyId,
    existingKeyRefs: portfolio.existingKeyRefs,
    material: { masterSeed: sessionKeyConfig.masterSeed },
    executorAddress: sessionKeyConfig.executorAddress,
    publicClient,
    validUntil,
  });

  const chainId = deps.chainId ?? getConfig().chainId;
  if (portfolio.chainId !== chainId) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'renewal targets a different chain than the configured CHAIN_ID',
        portfolioId,
        portfolioChainId: portfolio.chainId,
        configuredChainId: chainId,
      }),
    );
  }

  return {
    portfolioId: portfolio.id,
    strategyId: portfolio.strategyId,
    chainId: portfolio.chainId,
    ownerAddress: portfolio.ownerAddress,
    accountAddress: portfolio.accountAddress,
    executorAddress: sessionKeyConfig.executorAddress,
    entryPoint: KERNEL_V3_3_ADDRESSES.entryPointV07,
    kernelVersion: KERNEL_VERSION_STRING,
    sessionKeyAddress: key.sessionKeyAddress,
    keyRef: key.keyRef,
    validUntil: key.validUntil,
    expiresAt: key.expiresAt,
    permissionId: key.permissionId,
    policySnapshot: key.policySnapshot,
    initConfig: key.initConfig,
    bundlerUrl: deps.bundlerUrl ?? resolveBundlerUrl(),
  };
}

/** `BUNDLER_URL`（空 = `DEFAULT_BUNDLER_URL`）。不是機密，只是前端要知道打哪裡。 */
export function resolveBundlerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BUNDLER_URL?.trim();
  return raw === undefined || raw === '' ? DEFAULT_BUNDLER_URL : raw;
}

/**
 * 缺 session key env 的錯誤要帶上原文（它指出缺哪一個變數），不然前端只會看到一個沒有資訊的 500。
 */
function resolveSessionKeyConfigOrFail(
  fromDeps: RenewalParamsDeps['sessionKeyConfig'] | undefined,
): { executorAddress: Address; masterSeed: Hex } {
  try {
    return (fromDeps ?? requireSessionKeyConfig)();
  } catch (err) {
    throw new AppError(
      500,
      'SESSION_KEY_CONFIG',
      `續期需要 session key 設定：${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /portfolios/:id/renewal-result
// ---------------------------------------------------------------------------

/** 前端回報的續期結果（UserOp 已上鏈）。全部當成不可信輸入，形狀對就收。 */
export type RenewalResultInput = {
  txHash?: unknown;
  userOpHash?: unknown;
  permissionId?: unknown;
  sessionKeyAddress?: unknown;
  keyRef?: unknown;
  validUntil?: unknown;
  policySnapshot?: unknown;
};

export type RenewalResultRecorded = {
  ok: true;
  recorded: { keyRef: string; permissionId: string };
  /** true = 這一列本來就在（重複提交）。不是錯誤，鏈才是權威。 */
  duplicate?: true;
};

export type RenewalResultDeps = {
  requireOwnedPortfolio: typeof requireOwnedPortfolio;
  query: typeof query;
};

/** uint48 上限：`expires_at` 是 timestamp，超出範圍的值只會變成一個看不懂的錯誤。 */
const MAX_VALID_UNTIL = 2 ** 48 - 1;

/**
 * 把前端的續期結果記進 `session_keys`：一列**新的** active key。
 *
 * 三個關鍵決定：
 * 1. **舊的那列一個字都不動。** 舊權限在鏈上仍然有效到它自己的 `expires_at`，把它標成 expired/revoked
 *    會讓 DB 說一件鏈上不成立的事（也讓「這把 key 還能用嗎」的答案變成錯的）。
 * 2. `on conflict (key_ref) do nothing`：前端逾時重試是同一個 key_ref，重送不該是錯誤。回
 *    `duplicate: true` 讓前端知道「已經記過了」，而不是得到一個看起來失敗的 200/500。
 * 3. 碰撞列屬於**別的** portfolio 時不當成重複：那是兩個 portfolio 搶同一把 key，回 409。靜靜回
 *    duplicate 會讓後端說「記好了」而實際上這把 key 不屬於這個 portfolio。
 */
export async function recordRenewalResult(
  portfolioId: number,
  wallet: string,
  body: RenewalResultInput,
  deps: Partial<RenewalResultDeps> = {},
): Promise<RenewalResultRecorded> {
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  const runQuery = deps.query ?? query;

  // 擁有者與存在性先驗：後面所有的寫入都以「這是你的 portfolio」為前提。
  await find(portfolioId, wallet);

  const keyRef = requireString(body.keyRef, 'keyRef');
  const permissionId = requireString(body.permissionId, 'permissionId');
  const validUntil = requireValidUntil(body.validUntil);
  const policySnapshot = requireObject(body.policySnapshot, 'policySnapshot');

  const inserted = await runQuery<{ key_ref: string }>(
    `insert into session_keys (portfolio_id, key_ref, permissions, expires_at, status)
     values ($1, $2, $3::jsonb, to_timestamp($4::double precision), 'active')
     on conflict (key_ref) do nothing
     returning key_ref`,
    [portfolioId, keyRef, JSON.stringify(policySnapshot), validUntil],
  );

  if ((inserted.rowCount ?? inserted.rows.length) === 0) {
    const existing = await runQuery<{ portfolio_id: string }>(
      'select portfolio_id from session_keys where key_ref = $1',
      [keyRef],
    );
    const owner = existing.rows[0];
    if (owner !== undefined && Number(owner.portfolio_id) !== portfolioId) {
      throw new AppError(
        409,
        'KEY_REF_CONFLICT',
        `keyRef ${keyRef} 已屬於 portfolio ${owner.portfolio_id}，不能記到 portfolio ${portfolioId}`,
      );
    }
    return { ok: true, recorded: { keyRef, permissionId }, duplicate: true };
  }

  return { ok: true, recorded: { keyRef, permissionId } };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('INVALID_RENEWAL', `${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireValidUntil(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_VALID_UNTIL) {
    throw new ValidationError(
      'INVALID_RENEWAL',
      `validUntil must be an integer Unix timestamp inside the uint48 range, got ${String(value)}`,
    );
  }
  return value;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('INVALID_RENEWAL', `${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}
