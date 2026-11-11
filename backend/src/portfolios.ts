import type { Address, PublicClient } from 'viem';
import {
  deploySmartAccount,
  enrollOnchain,
  getAccountGasBalance,
  getChain,
  getGasPriceWei,
} from './chain.js';
import { getConfig, getGasConfig, requireSessionKeyConfig } from './config.js';
import { query, withTransaction } from './db.js';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.js';
import { describeGasStatus } from './funding.js';
import type { GasStatus } from './funding.js';
import { buildSessionPermissions, deriveSessionKeyFor, sessionValidUntil, sudoValidator } from './permissions.js';

export type Portfolio = {
  id: number;
  userId: string;
  strategyId: number;
  /**
   * `strategies.name`（使用者替基金取的名字）。列表頁要顯示名字，不是 `Strategy 516 · v1` 這種內部 id。
   * `null` = 這一列沒有 join 到策略（例如 enroll 剛寫入時沒有再查一次）—— 前端要退回顯示 id。
   */
  strategyName: string | null;
  version: number;
  scheduleState: string;
  createdAt: string;
  smartAccounts: SmartAccount[];
  /**
   * 帳戶的 gas 狀態（= 要打多少 BNB 到哪個地址、現在能不能動），或 null。
   *
   * null 只代表「查不到」，不代表 enroll 失敗：enroll 的成功與否由鏈上 enroll 與三筆 DB 寫入決定，
   * 這兩個唯讀 RPC 呼叫失敗不會、也不該把它變成一個失敗的請求。呼叫端必須讀 `gas === null` 這個
   * 情況（例如顯示「暫時無法查詢餘額」），而不是把 null 當成「餘額 0」。
   */
  gas: GasStatus | null;
};

export type SmartAccount = {
  chainId: number;
  address: string;
  owner: string;
  accountType: string;
};

type StrategyOnchainRow = { onchain_id: string | null; active_version: number | null };
type PortfolioRow = {
  id: string;
  user_id: string;
  strategy_id: string;
  /** 只有列表查詢會 join 出來；enroll 的回應沒有，所以是 optional。 */
  strategy_name?: string | null;
  version: number;
  schedule_state: string;
  created_at: Date;
};
type SmartAccountRow = {
  chain_id: string;
  address: string;
  owner: string;
  account_type: string;
};
/** A portfolio joined with one of its smart accounts: enough to rebuild a Portfolio in one query. */
type EnrollmentRow = PortfolioRow & SmartAccountRow;

/** uint48 上限（timestamp policy 的欄位寬度）。遠小於 `Number.MAX_SAFE_INTEGER`，所以轉 number 安全。 */
const MAX_VALID_UNTIL = 2 ** 48 - 1;

/**
 * 這次 enrollment 要用的 timestamp policy `validUntil`：先讀，讀不到就寫一個新的。
 *
 * 為什麼必須持久化：smart account 的 counterfactual 地址由 initConfig 決定，而 initConfig 內含
 * timestamp policy 的 `validUntil`。若每次重試都重新取「現在 + 365 天」，重試會算出**另一個**地址
 * —— 鏈上第一次部署的帳戶就變成 DB 不知道、也無法撤銷的孤兒（我們沒有使用者的 sudo key）。
 * 所以值在**任何鏈上動作之前**釘進 DB，重試一律讀回同一個。
 *
 * `on conflict do nothing` + 後續 SELECT（而不是 upsert/returning）：兩個併發的第一次 enroll 都寫，
 * 第二個 no-op，兩邊都讀回同一個贏家的值 —— 地址因此只有一個。
 */
export async function resolveValidUntil(
  userId: string,
  strategyId: bigint,
  chainId: bigint,
  runQuery: typeof query = query,
): Promise<bigint> {
  const key = [userId, strategyId.toString(), chainId.toString()] as const;
  await runQuery(
    `insert into enrollment_intents (user_id, strategy_id, chain_id, valid_until)
     values ($1, $2, $3, $4)
     on conflict (user_id, strategy_id, chain_id) do nothing`,
    [...key, sessionValidUntil()],
  );
  const stored = await runQuery<{ valid_until: string }>(
    `select valid_until from enrollment_intents
      where user_id = $1 and strategy_id = $2 and chain_id = $3`,
    key,
  );
  const row = stored.rows[0];
  if (row === undefined) {
    throw new Error(
      `enrollment_intents has no row for (${userId}, ${strategyId.toString()}, ${chainId.toString()}) ` +
        'right after inserting it; refusing to derive an account address from a freshly minted validUntil',
    );
  }
  return BigInt(row.valid_until);
}

/** `resolveValidUntil` 的注入形狀（比照其他接縫：不帶 query，讓測試自己決定值從哪來）。 */
export type ResolveValidUntil = (userId: string, strategyId: bigint, chainId: bigint) => Promise<bigint>;

/**
 * The seams enrollPortfolio touches. Every field has a production default, so callers keep calling
 * `enrollPortfolio(strategyId, wallet)`; unit tests inject fakes instead of a chain plus database.
 */
export type EnrollDeps = {
  query: typeof query;
  withTransaction: typeof withTransaction;
  deploySmartAccount: typeof deploySmartAccount;
  enrollOnchain: typeof enrollOnchain;
  chainId: number;
  /**
   * `(owner, strategyId, chainId)` 的 timestamp policy `validUntil`（`enrollment_intents` 的讀寫）。
   * production 不注入，走 `resolveValidUntil` + `deps.query`。
   */
  resolveValidUntil: ResolveValidUntil;
  /** 供 `buildSessionPermissions` 用（要讀 chain id）；production 走 `getChain().publicClient`。 */
  publicClient: PublicClient;
  /** `requireSessionKeyConfig()` 的結果。production 不注入，缺 env 時就會在 enroll 最前面炸掉。 */
  sessionKeyConfig: ReturnType<typeof requireSessionKeyConfig>;
  /** session key 的三層 policy 與 initConfig。 */
  buildSessionPermissions: typeof buildSessionPermissions;
  /** 帳戶的 gas 預付餘額（`chain.getAccountGasBalance`）。 */
  getAccountGasBalance: typeof getAccountGasBalance;
  /** 當前 gas price（`chain.getGasPriceWei`），只用來估算還能跑幾次 op。 */
  getGasPriceWei: typeof getGasPriceWei;
  /** 可執行門檻（`getGasConfig().minSessionGasWei`）。 */
  minSessionGasWei: bigint;
};

/**
 * Existing active KERNEL enrollment of one user in one strategy, joined with its smart account. One
 * account per (person, strategy) is the invariant: the salt binds owner + strategyId.
 *
 * `s.account_type = 'KERNEL'` is part of the filter, not a check on the returned row: a migrated user
 * keeps the legacy 'EOA' portfolio (lower id) next to the new KERNEL one, so an unfiltered
 * `order by p.id limit 1` would always hand back the EOA row and re-run the whole enroll path,
 * ending in a 23505 on smart_accounts(chain_id, address).
 */
const ACTIVE_ENROLLMENT_SQL = `select p.id, p.user_id, p.strategy_id, p.version, p.schedule_state, p.created_at,
          s.chain_id, s.address, s.owner, s.account_type
     from portfolios p
     join smart_accounts s on s.portfolio_id = p.id
    where p.user_id = $1 and p.strategy_id = $2 and p.schedule_state = 'active'
      and s.account_type = 'KERNEL'
    order by p.id
    limit 1`;

/**
 * Enroll `wallet` (the authenticated session wallet, an EOA) into a strategy.
 *
 * The enrolled account is the owner's Kernel v3.3 smart account — one per (owner, strategyId), its
 * address derived counterfactually from `computeSalt` — while `portfolios.user_id` and
 * `smart_accounts.owner` stay the EOA that controls it. The account is created with the session-key
 * permissions already installed, and the session key itself is only referenced in `session_keys`
 * (`key_ref` = derivation path, `permissions` = policy snapshot): no private key ever reaches the DB.
 *
 * Order matters on five counts:
 * 1. re-enrolling an already-KERNEL enrollment returns that portfolio untouched: no chain call, no
 *    new row, so a retried POST /portfolios is idempotent;
 * 2. the timestamp policy's `validUntil` is pinned in `enrollment_intents` BEFORE anything touches
 *    the chain. It is the only non-deterministic input to `initConfig`, hence to the account
 *    address: minting it per attempt means a retry after a failed DB write derives a second address
 *    and strands the first account permanently (deployed, permissioned, registry-enrolled, and the
 *    DB has no idea it exists);
 * 3. the session key is derived from (owner, strategyId) — never from a DB-generated id — so it
 *    needs no `portfolios.id` before the INSERT;
 * 4. the smart account is deployed (with `initConfig`, i.e. permissions installed), then the
 *    on-chain enroll happens, both before any DB write, so a revert leaves no row claiming an
 *    enrollment that never happened;
 * 5. the reverse — chain state without a DB row — is harmless: the session key is a deterministic
 *    function of (owner, strategyId) and the account address of (owner, strategyId, validUntil),
 *    with `validUntil` read back from `enrollment_intents`. The retry therefore recomputes the same
 *    pair, finds the code deployed and skips the deploy tx.
 *
 * Gas 狀態是最後一步、且**絕不影響成敗**：它是兩個唯讀 RPC 呼叫，用來回答「使用者要打多少 BNB 到
 * 哪個地址、現在能不能動」。把它們排在 DB 寫入之後，是因為到那個時間點 enroll 已經完成；讓一次
 * 逾時的 RPC 呼叫把已經完成（且會走 idempotent 分支回同一列）的 enroll 變成 500，只會製造一個
 * 「看起來失敗、其實成功」的請求。查不到就回 `gas: null`。
 */
export async function enrollPortfolio(
  strategyId: number,
  wallet: string,
  deps: Partial<EnrollDeps> = {},
): Promise<Portfolio> {
  const find = deps.query ?? query;
  const runInTransaction = deps.withTransaction ?? withTransaction;
  const deployAccount = deps.deploySmartAccount ?? deploySmartAccount;
  const enroll = deps.enrollOnchain ?? enrollOnchain;

  /**
   * 查一次 gas 狀態。所有接縫在這裡才解析預設值，所以「查詢失敗」也只影響這一個值：
   * 任何錯誤都被收成 `null`，並留一行 log 給 ops（不是靜靜吞掉）。
   */
  const readGas = async (account: Address): Promise<GasStatus | null> => {
    try {
      const balanceOf = deps.getAccountGasBalance ?? getAccountGasBalance;
      const gasPriceOf = deps.getGasPriceWei ?? getGasPriceWei;
      const minimumWei = deps.minSessionGasWei ?? getGasConfig().minSessionGasWei;
      const [balanceWei, gasPriceWei] = await Promise.all([balanceOf(account), gasPriceOf()]);
      return describeGasStatus({ address: account, balanceWei, minimumWei, gasPriceWei });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          msg: 'gas status unavailable (enroll is unaffected)',
          address: account,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return null;
    }
  };

  const strategy = await find<StrategyOnchainRow>(
    `select s.onchain_id, coalesce(max(v.version), 0) as active_version
       from strategies s
       left join strategy_versions v on v.strategy_id = s.id
      where s.id = $1
      group by s.id`,
    [strategyId],
  );
  const row = strategy.rows[0];
  if (row === undefined) throw new NotFoundError(`strategy ${strategyId} not found`);

  if (row.onchain_id === null) {
    throw new ValidationError('STRATEGY_NOT_ON_CHAIN', `strategy ${strategyId} is not yet mirrored to chain`);
  }
  const version = row.active_version ?? 0;
  if (version < 1) {
    throw new ValidationError('STRATEGY_NO_VERSION', `strategy ${strategyId} has no published version`);
  }

  const onchainId = Number(row.onchain_id);
  const account = wallet.toLowerCase();

  // Idempotency, before any on-chain action. A legacy 'EOA' enrollment is deliberately not
  // returned: the query above filters it out, so it keeps its row and this call creates the KERNEL
  // one alongside it. The account_type test is kept as a second line of defence for injected deps.
  const existing = await find<EnrollmentRow>(ACTIVE_ENROLLMENT_SQL, [account, strategyId]);
  const existingRow = existing.rows[0];
  if (existingRow !== undefined && existingRow.account_type === 'KERNEL') {
    // 已經 enroll 過也回 gas：這是「查我的帳戶現在能不能動」最自然的一次來回，而它同樣是唯讀查詢。
    const gas = await readGas(existingRow.address as Address);
    return toPortfolio(existingRow, [existingRow], gas);
  }

  // Session key: the config first, so a missing env fails with a message naming the variable
  // instead of blowing up somewhere deep inside the SDK. Both values are required to derive the key
  // and to know which contract the CallPolicy allows.
  const sessionKeyConfig = deps.sessionKeyConfig ?? requireSessionKeyConfig();
  const publicClient = deps.publicClient ?? getChain().publicClient;
  const chainId = deps.chainId ?? getConfig().chainId;

  // 先讀既有 intent；沒有就寫入一個新的 validUntil，之後一律用同一個值。位置是刻意的：它必須在
  // deriveSessionKeyFor / buildSessionPermissions / deploy / enroll 全部之前，因為 validUntil 會
  // 經 initConfig 決定帳戶地址 —— 一旦部署完成才改，重試就會落到另一個地址，留下無法回收的孤兒。
  const resolveIntent = deps.resolveValidUntil ?? ((user, sid, cid) => resolveValidUntil(user, sid, cid, find));
  const validUntil = await resolveIntent(account, BigInt(strategyId), BigInt(chainId));
  // uint48 上限 2.8e14 遠小於 MAX_SAFE_INTEGER(9e15)，但 intent 來自 DB，仍要自己擋一次：
  // 一個超出範圍的值會讓 buildSessionPermissions 煮出一個沒人期待的 policy（或在 SDK 深處才炸）。
  const validUntilSeconds = Number(validUntil);
  if (!Number.isSafeInteger(validUntilSeconds) || validUntilSeconds < 1 || validUntilSeconds > MAX_VALID_UNTIL) {
    throw new Error(
      `enrollment_intents.valid_until for (${account}, ${strategyId}, ${chainId}) is outside the uint48 range: ` +
        validUntil.toString(),
    );
  }

  // The derivation index comes from (owner, strategyId), never from `portfolios.id`: this runs before
  // the INSERT, and a value that changes on a retry would change the session key and — through
  // initConfig — the account address too.
  const sessionKey = deriveSessionKeyFor(account as Address, BigInt(strategyId), {
    masterSeed: sessionKeyConfig.masterSeed,
  });
  const buildPermissions = deps.buildSessionPermissions ?? buildSessionPermissions;
  const session = await buildPermissions({
    publicClient,
    sessionKeyAddress: sessionKey.address,
    executorAddress: sessionKeyConfig.executorAddress,
    validUntil: validUntilSeconds,
  });

  // Both halves of the account have to be given together: `plugins.regular` installs the session key
  // as a signer, `initConfig` installs the permissions. Only initConfig changes the address, so
  // dropping it would silently yield an account whose session key can sign nothing.
  const smartAccount = await deployAccount(account as Address, BigInt(strategyId), {
    plugins: { sudo: await sudoValidator(publicClient, account as Address), regular: session.permissionValidator },
    initConfig: session.initConfig,
  });

  // On-chain first: enroll the smart account (not the EOA), and fail here on a revert before any
  // DB row exists.
  await enroll(smartAccount.address, onchainId);

  const written = await runInTransaction(async (client) => {
    const inserted = await client.query<PortfolioRow>(
      `insert into portfolios (user_id, strategy_id, version, schedule_state)
       values ($1, $2, $3, 'active')
       returning id, user_id, strategy_id, version, schedule_state, created_at`,
      [account, strategyId, version],
    );
    const portfolioRow = inserted.rows[0];
    if (!portfolioRow) throw new Error('insert into portfolios returned no row');
    const portfolioId = Number(portfolioRow.id);

    // address is lowercased for the smart_accounts_address_lowercase_hex check; owner stays the EOA.
    await client.query(
      `insert into smart_accounts (portfolio_id, chain_id, address, owner, account_type)
       values ($1, $2, $3, $4, 'KERNEL')`,
      [portfolioId, chainId, smartAccount.address.toLowerCase(), account],
    );

    // Session key metadata only: `key_ref` is the derivation path, the private key never leaves the
    // master seed. `permissions` is the policy snapshot (already JSON-safe), `expires_at` is the
    // timestamp policy's `validUntil` — the same instant the on-chain policy stops accepting it.
    await client.query(
      `insert into session_keys (portfolio_id, key_ref, permissions, expires_at, status)
       values ($1, $2, $3::jsonb, $4, 'active')`,
      [portfolioId, sessionKey.keyRef, JSON.stringify(session.policySnapshot), session.expiresAt],
    );

    const accounts = await client.query<SmartAccountRow>(
      `select chain_id, address, owner, account_type
         from smart_accounts
        where portfolio_id = $1`,
      [portfolioId],
    );

    return { portfolioRow, accounts: accounts.rows };
  });

  // Gas 狀態擺在 DB 寫入之後，且失敗只會讓這個欄位變 null（見上面的說明）。地址用小寫，與
  // `smartAccounts[].address` 同一個寫法 —— 同一份回應裡出現兩種拼法只會讓人以為是兩個地址。
  const gasAccount = smartAccount.address.toLowerCase() as Address;
  return toPortfolio(written.portfolioRow, written.accounts, await readGas(gasAccount));
}

/**
 * `session_keys` 的一列，攤成前端需要的四個欄位。
 *
 * `permissionId` / `sessionKeyAddress` 都在 `permissions` 那包 jsonb 裡（它們是 policy 快照的一部分），
 * 所以不需要額外的欄位 —— 但讀不到時要回 null，不能讓整個列表變成 500。
 */
export type SessionKeySummary = {
  permissionId: string;
  sessionKeyAddress: string;
  keyRef: string;
  expiresAt: string;
  status: string;
};

/** `GET /portfolios` 的一列：`Portfolio` 再加一個「這組權限現在是哪一把 key」。 */
export type PortfolioWithSessionKey = Portfolio & {
  /** null = 這個 portfolio 沒有任何 session key 紀錄（不是 0，也不是錯誤）。 */
  sessionKey: SessionKeySummary | null;
};

type PortfolioListRow = PortfolioRow & {
  chain_id: string | null;
  address: string | null;
  owner: string | null;
  account_type: string | null;
};

type SessionKeyRow = {
  portfolio_id: string;
  key_ref: string;
  permissions: Record<string, unknown> | null;
  expires_at: Date;
  status: string;
};

/** `GET /portfolios` 的接縫：查詢與兩個唯讀 gas 呼叫都可注入，路由測試不需要 DB 與鏈。 */
export type ListPortfoliosDeps = {
  query: typeof query;
  getAccountGasBalance: typeof getAccountGasBalance;
  getGasPriceWei: typeof getGasPriceWei;
  minSessionGasWei: bigint;
};

/**
 * 目前登入錢包的所有 portfolio（含 smart account、gas 狀態、以及最新一把 session key）。
 *
 * 兩件事決定這支的形狀：
 * 1. **只回這個錢包的列。** `lower(p.user_id) = $1`：`user_id` 在 DB 是自由文字，比對一律不分大小寫，
 *    否則大寫寫入的歷史資料會整批消失（那是「查不到」而不是「不是你的」，兩者都回空陣列分不出來）。
 * 2. **`gas` 與 `sessionKey` 拿不到就是 null，不是失敗。** 兩者都是唯讀的周邊查詢（RPC／另一張表），
 *    讓一次逾時的 RPC 把整個列表變成 500，等於讓使用者連「我有幾個 portfolio」都看不到。
 */
export async function listPortfolios(
  wallet: string,
  deps: Partial<ListPortfoliosDeps> = {},
): Promise<PortfolioWithSessionKey[]> {
  const find = deps.query ?? query;

  const portfolios = await find<PortfolioListRow>(
    `select p.id, p.user_id, p.strategy_id, p.version, p.schedule_state, p.created_at,
            st.name as strategy_name,
            sa.chain_id, sa.address, sa.owner, sa.account_type
       from portfolios p
       left join strategies st on st.id = p.strategy_id
       left join smart_accounts sa on sa.portfolio_id = p.id
      where lower(p.user_id) = $1
      order by p.id, sa.chain_id`,
    [wallet.toLowerCase()],
  );
  if (portfolios.rows.length === 0) return [];

  // 一次補齊所有 portfolio 的 key，而不是每列一個查詢：列表的列數沒有上界。
  const ids = [...new Set(portfolios.rows.map((row) => Number(row.id)))];
  const byPortfolio = new Map<number, SessionKeySummary>();
  try {
    const keys = await find<SessionKeyRow>(
      `select portfolio_id, key_ref, permissions, expires_at, status
         from session_keys
        where portfolio_id = any($1::bigint[])
        order by portfolio_id, (status = 'active') desc, expires_at desc`,
      [ids],
    );
    for (const key of keys.rows) {
      const portfolioId = Number(key.portfolio_id);
      // 排序已把「active 優先、到期日新到舊」排好，所以每列的第一筆就是現行那把。
      if (byPortfolio.has(portfolioId)) continue;
      byPortfolio.set(portfolioId, toSessionKeySummary(key));
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        msg: 'session key status unavailable (portfolio list is unaffected)',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const grouped = new Map<number, { row: PortfolioRow; accounts: SmartAccountRow[] }>();
  for (const row of portfolios.rows) {
    const id = Number(row.id);
    const entry = grouped.get(id);
    const account: SmartAccountRow | null =
      row.address === null
        ? null
        : {
            chain_id: row.chain_id ?? '',
            address: row.address,
            owner: row.owner ?? '',
            account_type: row.account_type ?? '',
          };
    if (entry === undefined) {
      grouped.set(id, { row, accounts: account === null ? [] : [account] });
    } else if (account !== null) {
      entry.accounts.push(account);
    }
  }

  const listed: PortfolioWithSessionKey[] = [];
  for (const [id, { row, accounts }] of grouped) {
    const gas = accounts[0] === undefined ? null : await readGasStatus(accounts[0].address as Address, deps);
    listed.push({ ...toPortfolio(row, accounts, gas), sessionKey: byPortfolio.get(id) ?? null });
  }
  return listed;
}

/** jsonb → 四個欄位。缺欄位時給空字串而不是 undefined：回應的形狀不該隨資料漂移。 */
function toSessionKeySummary(row: SessionKeyRow): SessionKeySummary {
  const permissions = row.permissions ?? {};
  return {
    permissionId: typeof permissions.permissionId === 'string' ? permissions.permissionId : '',
    sessionKeyAddress: typeof permissions.sessionKeyAddress === 'string' ? permissions.sessionKeyAddress : '',
    keyRef: row.key_ref,
    expiresAt: row.expires_at.toISOString(),
    status: row.status,
  };
}

/** 單一帳戶的 gas 狀態；查詢失敗一律收成 null（與 `enrollPortfolio` 的取捨相同）。 */
async function readGasStatus(account: Address, deps: Partial<ListPortfoliosDeps>): Promise<GasStatus | null> {
  try {
    const balanceOf = deps.getAccountGasBalance ?? getAccountGasBalance;
    const gasPriceOf = deps.getGasPriceWei ?? getGasPriceWei;
    const minimumWei = deps.minSessionGasWei ?? getGasConfig().minSessionGasWei;
    const [balanceWei, gasPriceWei] = await Promise.all([balanceOf(account), gasPriceOf()]);
    return describeGasStatus({ address: account, balanceWei, minimumWei, gasPriceWei });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        msg: 'gas status unavailable (portfolio list is unaffected)',
        address: account,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * 續期要用的權威資料：誰的 portfolio、哪一個 chain、要續期的帳戶地址（**DB 的值，不重新推導**），
 * 以及既有 session key 的 `key_ref` 清單（新索引必須跟它們都不同）。
 */
export type OwnedPortfolio = {
  id: number;
  userId: string;
  strategyId: number;
  version: number;
  scheduleState: string;
  createdAt: string;
  chainId: number;
  /** `smart_accounts.address`：已部署帳戶的權威值，直接用，不要用 initConfig 重算。 */
  accountAddress: string;
  /** sudo owner（= `smart_accounts.owner` = 使用者的 EOA）。 */
  ownerAddress: string;
  existingKeyRefs: string[];
};

export type OwnedPortfolioDeps = {
  query: typeof query;
  /** 有多個 chain 的帳戶時優先挑這一個（production = `getConfig().chainId`）。 */
  chainId: number;
};

/**
 * 讀出一個 portfolio 並確認呼叫端是它的擁有者。
 *
 * 404 與 403 分開是刻意的：404 = 這個 id 不存在，403 = 存在但不是你的。合併成 404 會讓「我的 portfolio
 * 不見了」與「有人拿我的 id 亂打」看起來一樣，使用者與 ops 都查不下去。
 */
export async function requireOwnedPortfolio(
  portfolioId: number,
  wallet: string,
  deps: Partial<OwnedPortfolioDeps> = {},
): Promise<OwnedPortfolio> {
  const find = deps.query ?? query;

  const portfolios = await find<PortfolioRow>(
    `select id, user_id, strategy_id, version, schedule_state, created_at
       from portfolios
      where id = $1`,
    [portfolioId],
  );
  const row = portfolios.rows[0];
  if (row === undefined) throw new NotFoundError(`portfolio ${portfolioId} not found`);
  if (row.user_id.toLowerCase() !== wallet.toLowerCase()) {
    throw new ForbiddenError(`portfolio ${portfolioId} belongs to another wallet`);
  }

  const accounts = await find<SmartAccountRow>(
    `select chain_id, address, owner, account_type
       from smart_accounts
      where portfolio_id = $1
      order by chain_id`,
    [portfolioId],
  );
  if (accounts.rows.length === 0) {
    // 沒有帳戶就沒有東西可以續期。回 404 而不是 500：這是資料狀態，不是伺服器壞掉。
    throw new NotFoundError(`portfolio ${portfolioId} has no smart account to renew`);
  }
  const chainId = deps.chainId ?? getConfig().chainId;
  const account = accounts.rows.find((candidate) => Number(candidate.chain_id) === chainId) ?? accounts.rows[0];
  if (account === undefined) throw new NotFoundError(`portfolio ${portfolioId} has no smart account to renew`);

  const keys = await find<{ key_ref: string }>(
    'select key_ref from session_keys where portfolio_id = $1 order by key_ref',
    [portfolioId],
  );

  return {
    id: Number(row.id),
    userId: row.user_id,
    strategyId: Number(row.strategy_id),
    version: row.version,
    scheduleState: row.schedule_state,
    createdAt: row.created_at.toISOString(),
    chainId: Number(account.chain_id),
    accountAddress: account.address,
    ownerAddress: account.owner,
    existingKeyRefs: keys.rows.map((key) => key.key_ref),
  };
}

/** Row shape → API shape. Shared by the idempotent return and the freshly written portfolio. */
function toPortfolio(row: PortfolioRow, accounts: SmartAccountRow[], gas: GasStatus | null): Portfolio {
  return {
    id: Number(row.id),
    userId: row.user_id,
    strategyId: Number(row.strategy_id),
    strategyName: typeof row.strategy_name === 'string' ? row.strategy_name : null,
    version: row.version,
    scheduleState: row.schedule_state,
    createdAt: row.created_at.toISOString(),
    smartAccounts: accounts.map((a) => ({
      chainId: Number(a.chain_id),
      address: a.address,
      owner: a.owner,
      accountType: a.account_type,
    })),
    gas,
  };
}
